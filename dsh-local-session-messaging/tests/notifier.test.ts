import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { MessagingError } from '../src/domain.js'
import { createPokeServer, sendPoke, validatePokeEndpoint } from '../src/notifier.js'

const roots: string[] = []
const closeCallbacks: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.allSettled(closeCallbacks.splice(0).map(close => close()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function secureRoot(prefix = 'dsh-messaging-poke-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  chmodSync(root, 0o700)
  roots.push(root)
  return root
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

function expectCode(operation: () => unknown, code: MessagingError['code']): void {
  try {
    operation()
    throw new Error(`expected ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(MessagingError)
    expect((error as MessagingError).code).toBe(code)
  }
}

describe('Unix-domain poke notifier', () => {
  it('creates owner-only endpoints and delivers a one-byte poke', async () => {
    const root = secureRoot()
    const received = deferred<void>()
    let count = 0
    const server = await createPokeServer({
      socketDir: root,
      socketName: 'receiver.sock',
      onPoke: () => {
        count += 1
        received.resolve()
      },
    })
    closeCallbacks.push(() => server.close())

    expect(validatePokeEndpoint(server.endpoint)).toEqual(server.endpoint)
    expect(statSync(root).mode & 0o777).toBe(0o700)
    expect(statSync(server.endpoint.socketPath).mode & 0o777).toBe(0o600)
    expect(await sendPoke(server.endpoint)).toBe(true)
    await received.promise
    expect(count).toBe(1)
  })

  it('coalesces a burst and never treats malformed bytes as a poke', async () => {
    const root = secureRoot()
    let count = 0
    const server = await createPokeServer({
      socketDir: root,
      socketName: 'receiver.sock',
      onPoke: () => {
        count += 1
      },
    })
    closeCallbacks.push(() => server.close())

    await new Promise<void>(resolve => {
      const socket = createConnection({ path: server.endpoint.socketPath })
      socket.once('connect', () => socket.end(Buffer.from([0x02])))
      socket.once('close', () => resolve())
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(count).toBe(0)

    await Promise.all([
      sendPoke(server.endpoint),
      sendPoke(server.endpoint),
      sendPoke(server.endpoint),
    ])
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(count).toBeGreaterThanOrEqual(1)
    expect(count).toBeLessThanOrEqual(3)
  })

  it('returns false for an unavailable endpoint because polling is authoritative', async () => {
    const root = secureRoot()
    expect(await sendPoke({ socketPath: join(root, 'missing.sock') })).toBe(false)
  })

  it('removes only its own socket on idempotent close', async () => {
    const root = secureRoot()
    const server = await createPokeServer({
      socketDir: root,
      socketName: 'receiver.sock',
      onPoke: () => {},
    })
    expect(existsSync(server.endpoint.socketPath)).toBe(true)
    await server.close()
    await server.close()
    expect(existsSync(server.endpoint.socketPath)).toBe(false)
  })

  it('never unlinks an endpoint already owned by another server', async () => {
    const root = secureRoot()
    const first = await createPokeServer({
      socketDir: root,
      socketName: 'receiver.sock',
      onPoke: () => {},
    })
    closeCallbacks.push(() => first.close())
    await expect(createPokeServer({
      socketDir: root,
      socketName: 'receiver.sock',
      onPoke: () => {},
    })).rejects.toMatchObject({ code: 'ENDPOINT_IN_USE' })
    expect(existsSync(first.endpoint.socketPath)).toBe(true)
    expect(await sendPoke(first.endpoint)).toBe(true)
  })

  it('rejects traversal, overlong paths, and non-owner-only directories', async () => {
    const root = secureRoot()
    await expect(createPokeServer({
      socketDir: root,
      socketName: '../escape.sock',
      onPoke: () => {},
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })

    const longRoot = secureRoot(`dsh-${'x'.repeat(90)}-`)
    await expect(createPokeServer({
      socketDir: longRoot,
      socketName: 'receiver.sock',
      onPoke: () => {},
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })

    const insecure = secureRoot('dsh-messaging-insecure-poke-')
    chmodSync(insecure, 0o755)
    await expect(createPokeServer({
      socketDir: insecure,
      socketName: 'receiver.sock',
      onPoke: () => {},
    })).rejects.toMatchObject({ code: 'INSECURE_PATH' })
  })

  it('rejects a non-socket path even inside a secure directory', () => {
    const root = secureRoot()
    expectCode(
      () => validatePokeEndpoint({ socketPath: join(root, 'missing.sock') }),
      'ENDPOINT_IN_USE',
    )
  })
})
