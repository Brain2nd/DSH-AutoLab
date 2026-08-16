import { randomUUID } from 'node:crypto'
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import { hostname } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

export interface ControllerOwner {
  readonly version: 1
  readonly token: string
  readonly pid: number
  readonly processStartId: string
  readonly hostname: string
  readonly acquiredAt: number
}

export interface RuntimeLock {
  readonly path: string
  readonly owner: ControllerOwner
  release(): Promise<void>
}

export class RuntimeLockError extends Error {
  readonly name = 'RuntimeLockError'

  constructor(
    message: string,
    readonly code: 'OWNER_ACTIVE' | 'OWNER_UNKNOWN' | 'LOCK_CORRUPT' | 'LOCK_LOST',
  ) {
    super(message)
  }
}

export async function acquireRuntimeLock(root: string): Promise<RuntimeLock> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const lockPath = join(root, 'controller.lock')

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const owner = currentOwner()
    const candidate = join(root, `.controller.lock.candidate-${owner.token}`)
    await mkdir(candidate, { mode: 0o700 })
    try {
      await writeOwner(candidate, owner)
      try {
        await rename(candidate, lockPath)
        await syncDirectory(root)
        return ownedLock(lockPath, owner)
      } catch (error) {
        if (!isLockCollision(error)) throw error
      }
    } finally {
      await rm(candidate, { recursive: true, force: true })
    }

    const existing = await tryReadOwner(lockPath)
    if (existing === undefined) continue
    const liveness = probeOwner(existing)
    if (liveness === 'alive') {
      throw new RuntimeLockError(
        `AutoLab controller is already owned by pid ${existing.pid} on ${existing.hostname}`,
        'OWNER_ACTIVE',
      )
    }
    if (liveness === 'unknown') {
      throw new RuntimeLockError(
        `cannot prove whether AutoLab controller owner pid ${existing.pid} is dead`,
        'OWNER_UNKNOWN',
      )
    }

    const tombstone = join(root, `controller.lock.stale-${existing.token}-${randomUUID()}`)
    let moved = false
    try {
      await rename(lockPath, tombstone)
      moved = true
      await syncDirectory(root)
    } catch (error) {
      if (!isLockCollision(error) && !isMissing(error)) throw error
    } finally {
      if (moved) {
        await rm(tombstone, { recursive: true, force: true })
        await syncDirectory(root)
      }
    }
  }

  throw new RuntimeLockError('controller ownership changed repeatedly during acquisition', 'OWNER_UNKNOWN')
}

export function processStartId(pid: number): string | undefined {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 2_000,
  })
  if (result.status !== 0) return undefined
  const value = result.stdout.trim().replace(/\s+/g, ' ')
  return value.length === 0 ? undefined : value
}

function currentOwner(): ControllerOwner {
  const startId = processStartId(process.pid)
  if (startId === undefined) {
    throw new RuntimeLockError('cannot resolve current process start identity', 'OWNER_UNKNOWN')
  }
  return {
    version: 1,
    token: randomUUID(),
    pid: process.pid,
    processStartId: startId,
    hostname: hostname(),
    acquiredAt: Date.now(),
  }
}

function probeOwner(owner: ControllerOwner): 'alive' | 'dead' | 'unknown' {
  if (owner.hostname !== hostname()) return 'unknown'
  try {
    process.kill(owner.pid, 0)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ESRCH') return 'dead'
    return 'unknown'
  }
  const actualStart = processStartId(owner.pid)
  if (actualStart === undefined) return 'unknown'
  return actualStart === owner.processStartId ? 'alive' : 'dead'
}

function ownedLock(lockPath: string, owner: ControllerOwner): RuntimeLock {
  let released = false
  return {
    path: lockPath,
    owner,
    async release() {
      if (released) return
      const current = await tryReadOwner(lockPath)
      if (current?.token !== owner.token) {
        throw new RuntimeLockError('controller lock token changed before release', 'LOCK_LOST')
      }
      const releasedPath = join(
        dirname(lockPath),
        `${basename(lockPath)}.released-${owner.token}`,
      )
      await rename(lockPath, releasedPath)
      await syncDirectory(dirname(lockPath))
      released = true
      await rm(releasedPath, { recursive: true, force: true })
      await syncDirectory(dirname(lockPath))
    },
  }
}

async function writeOwner(directory: string, owner: ControllerOwner): Promise<void> {
  const path = join(directory, 'owner.json')
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await syncDirectory(directory)
}

async function tryReadOwner(lockPath: string): Promise<ControllerOwner | undefined> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8'))
  } catch (error) {
    if (isMissing(error)) {
      const lockStat = await stat(lockPath).catch(statError => {
        if (isMissing(statError)) return undefined
        throw statError
      })
      if (lockStat === undefined) return undefined
      throw new RuntimeLockError(
        `controller lock at ${lockPath} exists without an owner record`,
        'LOCK_CORRUPT',
      )
    }
    throw new RuntimeLockError(
      `cannot read controller owner at ${lockPath}: ${error instanceof Error ? error.message : String(error)}`,
      'LOCK_CORRUPT',
    )
  }
  if (!isOwner(value)) {
    throw new RuntimeLockError(`controller owner at ${lockPath} is malformed`, 'LOCK_CORRUPT')
  }
  return value
}

function isOwner(value: unknown): value is ControllerOwner {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return candidate.version === 1
    && typeof candidate.token === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(candidate.token)
    && Number.isSafeInteger(candidate.pid)
    && (candidate.pid as number) > 0
    && typeof candidate.processStartId === 'string'
    && candidate.processStartId.length > 0
    && typeof candidate.hostname === 'string'
    && candidate.hostname.length > 0
    && Number.isSafeInteger(candidate.acquiredAt)
    && (candidate.acquiredAt as number) >= 0
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}

function isMissing(value: unknown): boolean {
  return isNodeError(value) && value.code === 'ENOENT'
}

function isLockCollision(value: unknown): boolean {
  return isNodeError(value)
    && (value.code === 'EEXIST' || value.code === 'ENOTEMPTY')
}
