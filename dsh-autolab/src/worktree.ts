import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { durableWriteFile } from './artifacts.js'
import { canonicalJson, sha256 } from './integrity.js'

const execFileAsync = promisify(execFile)
const SHA_PATTERN = /^[0-9a-f]{40,64}$/u
const LANE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u

export interface WorktreeReceipt {
  readonly version: 1
  readonly labId: string
  readonly laneId: string
  readonly repositoryPath: string
  readonly worktreePath: string
  readonly gitCommonDirectory: string
  readonly baseRef: string
  readonly baseSha: string
  readonly initialHeadSha: string
  readonly createdAt: number
  readonly receiptHash: string
}

export interface LaneWorktree {
  readonly receipt: WorktreeReceipt
  readonly currentHeadSha: string
  readonly dirty: boolean
}

export interface ResolvedRepositoryRefs {
  readonly repositoryPath: string
  readonly commits: Readonly<Record<string, string>>
}

export class WorktreeError extends Error {
  readonly name = 'WorktreeError'

  constructor(
    message: string,
    readonly code:
      | 'INVALID_INPUT'
      | 'REPOSITORY_INVALID'
      | 'WORKTREE_CONFLICT'
      | 'WORKTREE_MISSING'
      | 'RECEIPT_CORRUPT'
      | 'GIT_FAILED',
  ) {
    super(message)
  }
}

/**
 * Resolve a set of refs against one exact Git worktree root. Commit uses this
 * read-only discovery before freezing the manifest; start later verifies the
 * same identities while provisioning each Lane worktree.
 */
export async function resolveRepositoryRefs(
  repositoryPath: string,
  refs: readonly string[],
): Promise<ResolvedRepositoryRefs> {
  if (!isAbsolute(repositoryPath) || refs.length === 0 || refs.some(ref => ref.length === 0)) {
    throw new WorktreeError('repository path and refs must be non-empty', 'INVALID_INPUT')
  }
  const canonicalRepositoryPath = await canonicalDirectory(repositoryPath, 'REPOSITORY_INVALID')
  const repositoryTop = await canonicalDirectory(
    await git(canonicalRepositoryPath, ['rev-parse', '--show-toplevel']),
    'REPOSITORY_INVALID',
  )
  if (repositoryTop !== canonicalRepositoryPath) {
    throw new WorktreeError('repositoryPath must be the exact Git worktree root', 'REPOSITORY_INVALID')
  }

  const uniqueRefs = [...new Set(refs)]
  const entries = await Promise.all(uniqueRefs.map(async ref => [
    ref,
    await resolveCommit(canonicalRepositoryPath, ref),
  ] as const))
  return {
    repositoryPath: canonicalRepositoryPath,
    commits: Object.freeze(Object.fromEntries(entries)),
  }
}

/**
 * Create or recover one long-lived Lane checkout using Git's own worktree
 * identity. It neither schedules GPUs nor starts an Agent.
 */
export async function provisionLaneWorktree(input: {
  labId: string
  laneId: string
  labDirectory: string
  repositoryPath: string
  worktreePath: string
  baseRef: string
  /** Frozen commit identity; when present, baseRef is provenance, not a moving lookup. */
  baseSha?: string
  now?: number
}): Promise<LaneWorktree> {
  validateInput(input)
  const labDirectory = await canonicalDirectory(input.labDirectory, 'WORKTREE_MISSING')
  const repositoryPath = await canonicalDirectory(input.repositoryPath, 'REPOSITORY_INVALID')
  const worktreePath = await canonicalPotentialPath(input.worktreePath)
  if (isInside(repositoryPath, worktreePath) || isInside(labDirectory, worktreePath)) {
    throw new WorktreeError(
      'Lane worktree must be outside both the repository root and the Lab artifact directory',
      'INVALID_INPUT',
    )
  }

  const repositoryTop = await git(repositoryPath, ['rev-parse', '--show-toplevel'])
  const canonicalRepositoryTop = await realpath(repositoryTop)
  if (canonicalRepositoryTop !== repositoryPath) {
    throw new WorktreeError('repositoryPath must be the exact Git worktree root', 'REPOSITORY_INVALID')
  }
  const commonDirectory = await canonicalGitCommonDirectory(repositoryPath)
  const baseSha = input.baseSha === undefined
    ? await resolveCommit(repositoryPath, input.baseRef)
    : await resolveCommit(repositoryPath, input.baseSha)
  if (input.baseSha !== undefined && baseSha !== input.baseSha) {
    throw new WorktreeError('frozen baseSha did not resolve to itself', 'GIT_FAILED')
  }
  const receiptPath = worktreeReceiptPath(labDirectory, input.laneId)
  const existingReceipt = await readReceipt(receiptPath)

  if (existingReceipt !== undefined) {
    if (existingReceipt.labId !== input.labId
      || existingReceipt.laneId !== input.laneId
      || existingReceipt.repositoryPath !== repositoryPath
      || existingReceipt.worktreePath !== worktreePath
      || existingReceipt.gitCommonDirectory !== commonDirectory
      || existingReceipt.baseRef !== input.baseRef
      || existingReceipt.baseSha !== baseSha) {
      throw new WorktreeError('worktree receipt does not match the requested Lane identity', 'WORKTREE_CONFLICT')
    }
    return await inspectReceipt(existingReceipt)
  }

  const existing = await lstat(worktreePath).catch(() => undefined)
  if (existing === undefined) {
    await mkdir(dirname(worktreePath), { recursive: true, mode: 0o700 })
    await git(repositoryPath, ['worktree', 'add', '--detach', worktreePath, baseSha])
  } else {
    // Crash recovery window: `git worktree add` completed but the receipt did
    // not. Adopt only the exact clean checkout still at the requested base.
    if (!existing.isDirectory()) {
      throw new WorktreeError('configured worktree path is not a directory', 'WORKTREE_CONFLICT')
    }
    const observed = await inspectUnboundWorktree(worktreePath)
    if (observed.commonDirectory !== commonDirectory
      || observed.headSha !== baseSha
      || observed.dirty) {
      throw new WorktreeError(
        'existing path is not the exact clean crash-recovery worktree at baseSha',
        'WORKTREE_CONFLICT',
      )
    }
  }

  const observed = await inspectUnboundWorktree(worktreePath)
  if (observed.commonDirectory !== commonDirectory || observed.headSha !== baseSha) {
    throw new WorktreeError('Git created a worktree with unexpected identity', 'WORKTREE_CONFLICT')
  }
  const withoutHash = {
    version: 1 as const,
    labId: input.labId,
    laneId: input.laneId,
    repositoryPath,
    worktreePath: observed.worktreePath,
    gitCommonDirectory: commonDirectory,
    baseRef: input.baseRef,
    baseSha,
    initialHeadSha: observed.headSha,
    createdAt: input.now ?? Date.now(),
  }
  const receipt: WorktreeReceipt = {
    ...withoutHash,
    receiptHash: sha256(`autolab-worktree-receipt-v1\0${canonicalJson(withoutHash)}`),
  }
  await durableWriteFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, false)
  return {
    receipt,
    currentHeadSha: observed.headSha,
    dirty: observed.dirty,
  }
}

export async function inspectLaneWorktree(
  labDirectory: string,
  laneId: string,
): Promise<LaneWorktree> {
  if (!LANE_PATTERN.test(laneId)) {
    throw new WorktreeError('invalid laneId', 'INVALID_INPUT')
  }
  const receipt = await readReceipt(worktreeReceiptPath(resolve(labDirectory), laneId))
  if (receipt === undefined) {
    throw new WorktreeError(`worktree receipt for ${laneId} is missing`, 'WORKTREE_MISSING')
  }
  return await inspectReceipt(receipt)
}

function worktreeReceiptPath(labDirectory: string, laneId: string): string {
  return join(labDirectory, 'receipts', 'worktrees', `${laneId}.json`)
}

async function inspectReceipt(receipt: WorktreeReceipt): Promise<LaneWorktree> {
  const observed = await inspectUnboundWorktree(receipt.worktreePath).catch(error => {
    if (error instanceof WorktreeError) throw error
    throw new WorktreeError(
      `cannot inspect Lane worktree: ${error instanceof Error ? error.message : String(error)}`,
      'WORKTREE_MISSING',
    )
  })
  if (observed.worktreePath !== receipt.worktreePath
    || observed.commonDirectory !== receipt.gitCommonDirectory) {
    throw new WorktreeError('Lane worktree no longer matches its receipt', 'WORKTREE_CONFLICT')
  }
  return { receipt, currentHeadSha: observed.headSha, dirty: observed.dirty }
}

async function inspectUnboundWorktree(path: string): Promise<{
  worktreePath: string
  commonDirectory: string
  headSha: string
  dirty: boolean
}> {
  const worktreePath = await canonicalDirectory(path, 'WORKTREE_MISSING')
  const top = await canonicalDirectory(await git(worktreePath, ['rev-parse', '--show-toplevel']), 'WORKTREE_MISSING')
  if (top !== worktreePath) {
    throw new WorktreeError('configured path is not the exact worktree root', 'WORKTREE_CONFLICT')
  }
  const [commonDirectory, headSha, status] = await Promise.all([
    canonicalGitCommonDirectory(worktreePath),
    git(worktreePath, ['rev-parse', 'HEAD']),
    git(worktreePath, ['status', '--porcelain=v1', '--untracked-files=normal']),
  ])
  if (!SHA_PATTERN.test(headSha)) {
    throw new WorktreeError('worktree HEAD is not a commit hash', 'GIT_FAILED')
  }
  return { worktreePath, commonDirectory, headSha, dirty: status.length > 0 }
}

async function readReceipt(path: string): Promise<WorktreeReceipt | undefined> {
  const text = await readFile(path, 'utf8').catch(() => undefined)
  if (text === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new WorktreeError('worktree receipt is malformed JSON', 'RECEIPT_CORRUPT')
  }
  if (!isReceipt(value)) {
    throw new WorktreeError('worktree receipt schema is invalid', 'RECEIPT_CORRUPT')
  }
  const { receiptHash, ...withoutHash } = value
  const expected = sha256(`autolab-worktree-receipt-v1\0${canonicalJson(withoutHash)}`)
  if (expected !== receiptHash) {
    throw new WorktreeError('worktree receipt hash is invalid', 'RECEIPT_CORRUPT')
  }
  return value
}

function isReceipt(value: unknown): value is WorktreeReceipt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.version === 1
    && typeof record.labId === 'string'
    && typeof record.laneId === 'string'
    && LANE_PATTERN.test(record.laneId)
    && typeof record.repositoryPath === 'string'
    && isAbsolute(record.repositoryPath)
    && typeof record.worktreePath === 'string'
    && isAbsolute(record.worktreePath)
    && typeof record.gitCommonDirectory === 'string'
    && isAbsolute(record.gitCommonDirectory)
    && typeof record.baseRef === 'string'
    && record.baseRef.length > 0
    && typeof record.baseSha === 'string'
    && SHA_PATTERN.test(record.baseSha)
    && typeof record.initialHeadSha === 'string'
    && SHA_PATTERN.test(record.initialHeadSha)
    && Number.isSafeInteger(record.createdAt)
    && (record.createdAt as number) >= 0
    && typeof record.receiptHash === 'string'
    && /^[0-9a-f]{64}$/u.test(record.receiptHash)
}

async function resolveCommit(repositoryPath: string, ref: string): Promise<string> {
  const sha = await git(repositoryPath, ['rev-parse', '--verify', `${ref}^{commit}`])
  if (!SHA_PATTERN.test(sha)) {
    throw new WorktreeError(`baseRef ${JSON.stringify(ref)} did not resolve to a commit`, 'GIT_FAILED')
  }
  return sha
}

async function canonicalGitCommonDirectory(worktreePath: string): Promise<string> {
  const output = await git(worktreePath, ['rev-parse', '--git-common-dir'])
  return await canonicalDirectory(
    isAbsolute(output) ? output : resolve(worktreePath, output),
    'REPOSITORY_INVALID',
  )
}

async function canonicalDirectory(
  path: string,
  code: 'REPOSITORY_INVALID' | 'WORKTREE_MISSING',
): Promise<string> {
  if (!isAbsolute(path)) {
    throw new WorktreeError('path must be absolute', 'INVALID_INPUT')
  }
  try {
    return await realpath(path)
  } catch (error) {
    throw new WorktreeError(
      `directory does not exist: ${path} (${error instanceof Error ? error.message : String(error)})`,
      code,
    )
  }
}

/** Resolve symlinks in the longest existing prefix without requiring target existence. */
async function canonicalPotentialPath(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new WorktreeError('path must be absolute', 'INVALID_INPUT')
  let cursor = resolve(path)
  const suffix: string[] = []
  while (await lstat(cursor).catch(() => undefined) === undefined) {
    const parent = dirname(cursor)
    if (parent === cursor) {
      throw new WorktreeError(`no existing ancestor for path ${path}`, 'INVALID_INPUT')
    }
    suffix.unshift(basename(cursor))
    cursor = parent
  }
  return join(await realpath(cursor), ...suffix)
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const result = await execFileAsync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    })
    return result.stdout.trim()
  } catch (error) {
    throw new WorktreeError(
      `git ${args.join(' ')} failed: ${renderExecError(error)}`,
      'GIT_FAILED',
    )
  }
}

function validateInput(input: {
  labId: string
  laneId: string
  labDirectory: string
  repositoryPath: string
  worktreePath: string
  baseRef: string
}): void {
  if (!LANE_PATTERN.test(input.laneId)
    || input.labId.length === 0
    || input.baseRef.length === 0
    || !isAbsolute(input.labDirectory)
    || !isAbsolute(input.repositoryPath)
    || !isAbsolute(input.worktreePath)) {
    throw new WorktreeError('invalid worktree provisioning input', 'INVALID_INPUT')
  }
}

function isInside(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child))
  return path === '' || (path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
}

function renderExecError(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'stderr' in value) {
    const stderr = String(value.stderr).trim()
    if (stderr.length > 0) return stderr
  }
  return value instanceof Error ? value.message : String(value)
}
