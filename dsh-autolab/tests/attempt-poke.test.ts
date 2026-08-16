import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sendPoke } from 'dsh-local-session-messaging/core'
import { afterEach, describe, expect, it } from 'vitest'

import { openAttemptPokeEndpoint } from '../src/attempt-poke.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Attempt runtime poke endpoint', () => {
  it('atomically republishes a restartable pointer and coalesces lossy wakeups', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autolab-attempt-poke-'))
    roots.push(root)
    await chmod(root, 0o700)
    let pokes = 0
    let resolvePoke!: () => void
    const received = new Promise<void>(resolve => { resolvePoke = resolve })
    const first = await openAttemptPokeEndpoint({
      root,
      onPoke: () => {
        pokes += 1
        resolvePoke()
      },
    })
    try {
      expect(JSON.parse(await readFile(first.pointerPath, 'utf8'))).toEqual({
        version: 1,
        socketPath: first.socketPath,
      })
      await expect(sendPoke({ socketPath: first.socketPath })).resolves.toBe(true)
      await received
      expect(pokes).toBe(1)
    } finally {
      await first.close()
    }

    const second = await openAttemptPokeEndpoint({ root, onPoke: () => undefined })
    try {
      expect(second.pointerPath).toBe(first.pointerPath)
      expect(second.socketPath).not.toBe(first.socketPath)
      expect(JSON.parse(await readFile(second.pointerPath, 'utf8'))).toEqual({
        version: 1,
        socketPath: second.socketPath,
      })
    } finally {
      await second.close()
    }
  })
})
