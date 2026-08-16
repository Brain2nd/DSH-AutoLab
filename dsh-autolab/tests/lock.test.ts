import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import {
  acquireRuntimeLock,
  type ControllerOwner,
} from '../src/lock.js'

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'lock-worker.mjs')
const roots: string[] = []
const children = new Set<ChildProcessWithoutNullStreams>()

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-autolab-lock-'))
  roots.push(root)
  return root
}

async function startWorker(
  root: string,
  mode: 'hold' | 'crash',
): Promise<{ child: ChildProcessWithoutNullStreams; owner: ControllerOwner }> {
  const child = spawn(process.execPath, [
    '--no-warnings',
    '--experimental-transform-types',
    fixture,
    root,
    mode,
  ], { stdio: ['pipe', 'pipe', 'pipe'] })
  children.add(child)
  const owner = await new Promise<ControllerOwner>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += chunk })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
      const newline = stdout.indexOf('\n')
      if (newline < 0) return
      try {
        resolve(JSON.parse(stdout.slice(0, newline)) as ControllerOwner)
      } catch (error) {
        reject(error)
      }
    })
    child.once('error', reject)
    child.once('exit', code => {
      if (stdout.includes('\n')) return
      reject(new Error(`lock worker exited ${String(code)} before acquire: ${stderr}`))
    })
  })
  return { child, owner }
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode)
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolve(code))
  })
}

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGKILL')
    await waitForExit(child).catch(() => undefined)
  }
  children.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Controller owner lock', () => {
  it('rejects a second owner in the same process', async () => {
    const root = await temporaryRoot()
    const first = await acquireRuntimeLock(root)
    await expect(acquireRuntimeLock(root)).rejects.toMatchObject({
      name: 'RuntimeLockError',
      code: 'OWNER_ACTIVE',
    })
    await first.release()

    const next = await acquireRuntimeLock(root)
    expect(next.owner.token).not.toBe(first.owner.token)
    await next.release()
  })

  it('rejects a live owner in another process', async () => {
    const root = await temporaryRoot()
    const { child, owner } = await startWorker(root, 'hold')

    await expect(acquireRuntimeLock(root)).rejects.toMatchObject({
      name: 'RuntimeLockError',
      code: 'OWNER_ACTIVE',
    })
    expect(owner.pid).toBe(child.pid)

    child.stdin.end()
    await expect(waitForExit(child)).resolves.toBe(0)
    const next = await acquireRuntimeLock(root)
    await next.release()
  })

  it('recovers only after the prior process is mechanically proven dead', async () => {
    const root = await temporaryRoot()
    const { child, owner } = await startWorker(root, 'crash')
    await expect(waitForExit(child)).resolves.toBe(0)

    const recovered = await acquireRuntimeLock(root)
    expect(recovered.owner.token).not.toBe(owner.token)
    expect(await readdir(root)).toEqual(['controller.lock'])
    await recovered.release()
  })

  it('never releases a lock whose token fence has changed', async () => {
    const root = await temporaryRoot()
    const lock = await acquireRuntimeLock(root)
    const ownerPath = join(root, 'controller.lock', 'owner.json')
    const successor = {
      ...JSON.parse(await readFile(ownerPath, 'utf8')) as ControllerOwner,
      token: randomUUID(),
    }
    await writeFile(ownerPath, `${JSON.stringify(successor)}\n`, 'utf8')

    await expect(lock.release()).rejects.toMatchObject({
      code: 'LOCK_LOST',
    })
    expect(JSON.parse(await readFile(ownerPath, 'utf8'))).toMatchObject({ token: successor.token })
  })
})
