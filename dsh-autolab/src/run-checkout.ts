import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

import { z } from 'zod'

import { durableWriteFile } from './artifacts.js'
import { canonicalJson, sha256 } from './integrity.js'

const execFileAsync = promisify(execFile)
const GIT_COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const ATTEMPT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const READ_REGULAR_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

const normalizedAbsolutePath = z.string().min(1).refine(
  value => isAbsolute(value) && resolve(value) === value,
  'path must be normalized and absolute',
)

export const runCheckoutReceiptSchema = z.object({
  version: z.literal(1),
  kind: z.literal('AUTOLAB_DETACHED_RUN_CHECKOUT'),
  attemptId: z.string().regex(ATTEMPT_PATTERN),
  candidateSha: z.string().regex(GIT_COMMIT_PATTERN),
  repositoryPath: normalizedAbsolutePath,
  gitCommonDirectory: normalizedAbsolutePath,
  repositoryIdentitySha256: z.string().regex(SHA256_PATTERN),
  checkoutPath: normalizedAbsolutePath,
  receiptPath: normalizedAbsolutePath,
  createdAt: z.number().int().nonnegative(),
  receiptHash: z.string().regex(SHA256_PATTERN),
}).strict()

export type RunCheckoutReceipt = z.infer<typeof runCheckoutReceiptSchema>

export interface ProvisionDetachedRunCheckoutInput {
  readonly repositoryPath: string
  readonly checkoutPath: string
  readonly candidateSha: string
  readonly attemptId: string
  /** Defaults to a sibling file, never a file inside the clean checkout. */
  readonly receiptPath?: string
  readonly now?: number
}

export interface DetachedRunCheckout {
  readonly checkoutPath: string
  readonly headSha: string
  readonly receiptPath: string
  readonly receiptSha256: string
  readonly receipt: RunCheckoutReceipt
}

export interface InspectDetachedRunCheckoutInput {
  readonly repositoryPath: string
  readonly checkoutPath: string
  readonly candidateSha: string
  readonly attemptId: string
  /** Exact frozen receipt path returned by provisioning. */
  readonly receiptPath: string
  /** External hash returned by provisioning; the receipt cannot authorize itself. */
  readonly receiptSha256: string
}

export class RunCheckoutError extends Error {
  readonly name = 'RunCheckoutError'

  constructor(
    message: string,
    readonly code: 'INVALID_INPUT' | 'GIT_FAILED' | 'IO_FAILED' | 'IDENTITY_DRIFT',
  ) {
    super(message)
  }
}

const inFlight = new Map<string, Promise<DetachedRunCheckout>>()

/** Deterministic receipt location when the caller does not supply one. */
export function runCheckoutReceiptPath(checkoutPath: string): string {
  return join(dirname(checkoutPath), `${basename(checkoutPath)}.checkout.json`)
}

/**
 * Create one Attempt-owned detached checkout, or adopt only its exact durable
 * identity on replay. This helper never resets, cleans, removes, or overwrites.
 */
export async function provisionDetachedRunCheckout(
  input: ProvisionDetachedRunCheckoutInput,
): Promise<DetachedRunCheckout> {
  const receiptPath = input.receiptPath ?? runCheckoutReceiptPath(input.checkoutPath)
  const key = canonicalJson({
    version: 1,
    attemptId: input.attemptId,
    candidateSha: input.candidateSha,
    repositoryPath: input.repositoryPath,
    checkoutPath: input.checkoutPath,
    receiptPath,
  })
  const current = inFlight.get(key)
  if (current !== undefined) return await current

  const operation = provision({ ...input, receiptPath })
  inFlight.set(key, operation)
  try {
    return await operation
  } finally {
    if (inFlight.get(key) === operation) inFlight.delete(key)
  }
}

/**
 * Inspect a launched Attempt's frozen checkout identity without requiring a
 * clean worktree. The experiment may legitimately create or edit files after
 * launch; repository, common-dir, exact HEAD, detached state, and receipt
 * identity remain invariant. This function is read-only.
 */
export async function inspectDetachedRunCheckout(
  input: InspectDetachedRunCheckoutInput,
): Promise<DetachedRunCheckout> {
  validateInspectionInput(input)
  const repositoryPath = await canonicalExistingDirectory(
    input.repositoryPath,
    'repository',
    'IDENTITY_DRIFT',
  )
  const checkoutPath = await canonicalLeafPath(input.checkoutPath, 'checkout')
  const receiptPath = await canonicalLeafPath(input.receiptPath, 'receipt')
  if (repositoryPath !== input.repositoryPath
    || checkoutPath !== input.checkoutPath
    || receiptPath !== input.receiptPath) {
    fail('frozen checkout paths are no longer canonical', 'IDENTITY_DRIFT')
  }

  let repositoryTop: string
  try {
    repositoryTop = await git(repositoryPath, ['rev-parse', '--show-toplevel'])
  } catch (error) {
    if (error instanceof RunCheckoutError && error.code === 'GIT_FAILED') {
      fail(`frozen repository is no longer inspectable: ${error.message}`, 'IDENTITY_DRIFT')
    }
    throw error
  }
  const canonicalTop = await canonicalExistingDirectory(
    repositoryTop,
    'repository root',
    'IDENTITY_DRIFT',
  )
  if (canonicalTop !== repositoryPath) {
    fail('repositoryPath no longer names the exact Git worktree root', 'IDENTITY_DRIFT')
  }
  const gitCommonDirectory = await canonicalGitCommonDirectory(repositoryPath, 'IDENTITY_DRIFT')
  let candidateSha: string
  try {
    candidateSha = await git(
      repositoryPath,
      ['rev-parse', '--verify', `${input.candidateSha}^{commit}`],
    )
  } catch (error) {
    if (error instanceof RunCheckoutError && error.code === 'GIT_FAILED') {
      fail(`frozen candidate is no longer present: ${error.message}`, 'IDENTITY_DRIFT')
    }
    throw error
  }
  if (candidateSha !== input.candidateSha) {
    fail('frozen candidate commit identity drifted', 'IDENTITY_DRIFT')
  }
  const expectedIdentity = {
    attemptId: input.attemptId,
    candidateSha,
    repositoryPath,
    gitCommonDirectory,
    repositoryIdentitySha256: hashRepositoryIdentity(repositoryPath, gitCommonDirectory),
    checkoutPath,
    receiptPath,
  }
  const receipt = await readReceipt(receiptPath, false)
  if (receipt === undefined) fail('frozen checkout receipt is missing', 'IDENTITY_DRIFT')
  assertReceiptIdentity(receipt, expectedIdentity)
  const receiptBytes = Buffer.from(canonicalJson(receipt), 'utf8')
  if (sha256(receiptBytes) !== input.receiptSha256) {
    fail('frozen checkout receipt SHA-256 drifted', 'IDENTITY_DRIFT')
  }
  await inspectCheckout(checkoutPath, candidateSha, gitCommonDirectory, false)
  return result(receipt, receiptBytes)
}

async function provision(
  input: ProvisionDetachedRunCheckoutInput & { readonly receiptPath: string },
): Promise<DetachedRunCheckout> {
  validateInput(input)
  const repositoryPath = await canonicalExistingDirectory(input.repositoryPath, 'repository')
  // Canonicalize ancestors but deliberately preserve the final component:
  // existing leaf symlinks/FIFOs must reach the type checks below.
  const checkoutPath = await canonicalLeafPath(input.checkoutPath, 'checkout')
  const receiptPath = await canonicalLeafPath(input.receiptPath, 'receipt')
  if (repositoryPath !== input.repositoryPath
    || checkoutPath !== input.checkoutPath
    || receiptPath !== input.receiptPath) {
    fail('repository, checkout, and receipt paths must be canonical', 'INVALID_INPUT')
  }
  if (repositoryPath === checkoutPath
    || isInside(checkoutPath, receiptPath)) {
    fail('checkout must be independent and its receipt must remain outside it', 'INVALID_INPUT')
  }

  const repositoryTop = await git(repositoryPath, ['rev-parse', '--show-toplevel'])
  const canonicalTop = await canonicalExistingDirectory(repositoryTop, 'repository root')
  if (canonicalTop !== repositoryPath) {
    fail('repositoryPath must be the exact Git worktree root', 'INVALID_INPUT')
  }
  const gitCommonDirectory = await canonicalGitCommonDirectory(repositoryPath, 'GIT_FAILED')
  const candidateSha = await git(
    repositoryPath,
    ['rev-parse', '--verify', `${input.candidateSha}^{commit}`],
  )
  if (candidateSha !== input.candidateSha) {
    fail('candidateSha is not the exact commit resolved by the repository', 'GIT_FAILED')
  }
  const repositoryIdentitySha256 = hashRepositoryIdentity(repositoryPath, gitCommonDirectory)
  const expectedIdentity = {
    attemptId: input.attemptId,
    candidateSha,
    repositoryPath,
    gitCommonDirectory,
    repositoryIdentitySha256,
    checkoutPath,
    receiptPath,
  }

  const existingReceipt = await readReceipt(receiptPath, true)
  if (existingReceipt !== undefined) {
    assertReceiptIdentity(existingReceipt, expectedIdentity)
    await inspectCheckout(checkoutPath, candidateSha, gitCommonDirectory, true)
    return result(existingReceipt, Buffer.from(canonicalJson(existingReceipt), 'utf8'))
  }

  const existingCheckout = await lstat(checkoutPath).catch(error => {
    if (isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return undefined
    fail(`cannot inspect checkout path: ${errorMessage(error)}`, 'IO_FAILED')
  })
  if (existingCheckout === undefined) {
    await mkdir(dirname(checkoutPath), { recursive: true, mode: 0o700 }).catch(error => {
      fail(`cannot create checkout parent: ${errorMessage(error)}`, 'IO_FAILED')
    })
    try {
      await git(repositoryPath, ['worktree', 'add', '--detach', checkoutPath, candidateSha])
    } catch (error) {
      // A concurrent identical creator may have won. Adopt only if its exact
      // checkout is already complete; otherwise preserve the original error.
      const appeared = await lstat(checkoutPath).catch(() => undefined)
      if (appeared === undefined) throw error
      await inspectCheckout(checkoutPath, candidateSha, gitCommonDirectory, true)
    }
  } else {
    if (!existingCheckout.isDirectory() || existingCheckout.isSymbolicLink()) {
      fail('existing checkout path is not a real directory', 'IDENTITY_DRIFT')
    }
    await inspectCheckout(checkoutPath, candidateSha, gitCommonDirectory, true)
  }

  await inspectCheckout(checkoutPath, candidateSha, gitCommonDirectory, true)
  const withoutHash = {
    version: 1 as const,
    kind: 'AUTOLAB_DETACHED_RUN_CHECKOUT' as const,
    ...expectedIdentity,
    createdAt: input.now ?? Date.now(),
  }
  const receipt = runCheckoutReceiptSchema.parse({
    ...withoutHash,
    receiptHash: hashReceipt(withoutHash),
  })
  const bytes = Buffer.from(canonicalJson(receipt), 'utf8')
  try {
    await durableWriteFile(receiptPath, bytes, false)
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') {
      fail(`cannot freeze checkout receipt: ${errorMessage(error)}`, 'IO_FAILED')
    }
    const collision = await lstat(receiptPath).catch(() => undefined)
    if (collision?.isFile() !== true || collision.isSymbolicLink()) {
      fail(`cannot freeze checkout receipt: ${errorMessage(error)}`, 'IO_FAILED')
    }
  }

  const frozen = await readReceipt(receiptPath, false)
  if (frozen === undefined) fail('checkout receipt disappeared after creation', 'IDENTITY_DRIFT')
  assertReceiptIdentity(frozen, expectedIdentity)
  const frozenBytes = Buffer.from(canonicalJson(frozen), 'utf8')
  await inspectCheckout(checkoutPath, candidateSha, gitCommonDirectory, true)
  return result(frozen, frozenBytes)
}

async function inspectCheckout(
  checkoutPath: string,
  candidateSha: string,
  expectedCommonDirectory: string,
  requireClean: boolean,
): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(checkoutPath)
  } catch (error) {
    fail(`detached checkout is missing: ${errorMessage(error)}`, 'IDENTITY_DRIFT')
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail('detached checkout is not a real directory', 'IDENTITY_DRIFT')
  }
  let canonicalCheckout: string
  try {
    canonicalCheckout = await realpath(checkoutPath)
  } catch (error) {
    fail(`cannot canonicalize detached checkout: ${errorMessage(error)}`, 'IDENTITY_DRIFT')
  }
  if (canonicalCheckout !== checkoutPath) {
    fail('detached checkout path is no longer canonical', 'IDENTITY_DRIFT')
  }

  let top: string
  let commonDirectory: string
  let headSha: string
  let symbolicHead: string
  let status: string
  try {
    [top, commonDirectory, headSha, symbolicHead, status] = await Promise.all([
      git(checkoutPath, ['rev-parse', '--show-toplevel']),
      canonicalGitCommonDirectory(checkoutPath, 'IDENTITY_DRIFT'),
      git(checkoutPath, ['rev-parse', '--verify', 'HEAD^{commit}']),
      git(checkoutPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
      requireClean
        ? git(checkoutPath, ['status', '--porcelain=v1', '--untracked-files=normal'])
        : Promise.resolve(''),
    ])
  } catch (error) {
    if (error instanceof RunCheckoutError && error.code === 'GIT_FAILED') {
      fail(`existing checkout is not inspectable as the expected worktree: ${error.message}`, 'IDENTITY_DRIFT')
    }
    throw error
  }
  const canonicalTop = await canonicalExistingDirectory(top, 'checkout root', 'IDENTITY_DRIFT')
  if (canonicalTop !== checkoutPath
    || commonDirectory !== expectedCommonDirectory
    || headSha !== candidateSha
    || symbolicHead !== 'HEAD'
    || (requireClean && status.length !== 0)) {
    fail('detached checkout identity, HEAD, or cleanliness drifted', 'IDENTITY_DRIFT')
  }
}

async function readReceipt(
  path: string,
  allowMissing: boolean,
): Promise<RunCheckoutReceipt | undefined> {
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(path, READ_REGULAR_FLAGS)
    if (!(await file.stat()).isFile()) {
      fail('checkout receipt is not a regular file', 'IDENTITY_DRIFT')
    }
    const bytes = await file.readFile()
    let text: string
    try {
      text = UTF8.decode(bytes)
    } catch {
      fail('checkout receipt is not valid UTF-8', 'IDENTITY_DRIFT')
    }
    let value: unknown
    try {
      value = JSON.parse(text) as unknown
    } catch {
      fail('checkout receipt is not valid JSON', 'IDENTITY_DRIFT')
    }
    const parsed = runCheckoutReceiptSchema.safeParse(value)
    if (!parsed.success || canonicalJson(parsed.data) !== text) {
      fail('checkout receipt schema or canonical bytes drifted', 'IDENTITY_DRIFT')
    }
    const { receiptHash, ...withoutHash } = parsed.data
    if (receiptHash !== hashReceipt(withoutHash)) {
      fail('checkout receipt hash drifted', 'IDENTITY_DRIFT')
    }
    return parsed.data
  } catch (error) {
    if (error instanceof RunCheckoutError) throw error
    if (isNodeError(error)
      && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      if (allowMissing) return undefined
      fail('checkout receipt is missing', 'IDENTITY_DRIFT')
    }
    if (isNodeError(error) && error.code === 'ELOOP') {
      fail('checkout receipt is not a regular file', 'IDENTITY_DRIFT')
    }
    fail(`cannot read checkout receipt: ${errorMessage(error)}`, 'IO_FAILED')
  } finally {
    await file?.close().catch(() => undefined)
  }
}

function assertReceiptIdentity(
  receipt: RunCheckoutReceipt,
  expected: Omit<RunCheckoutReceipt, 'version' | 'kind' | 'createdAt' | 'receiptHash'>,
): void {
  if (receipt.attemptId !== expected.attemptId
    || receipt.candidateSha !== expected.candidateSha
    || receipt.repositoryPath !== expected.repositoryPath
    || receipt.gitCommonDirectory !== expected.gitCommonDirectory
    || receipt.repositoryIdentitySha256 !== expected.repositoryIdentitySha256
    || receipt.checkoutPath !== expected.checkoutPath
    || receipt.receiptPath !== expected.receiptPath) {
    fail('checkout receipt does not match the requested Attempt identity', 'IDENTITY_DRIFT')
  }
}

function result(receipt: RunCheckoutReceipt, receiptBytes: Buffer): DetachedRunCheckout {
  return Object.freeze({
    checkoutPath: receipt.checkoutPath,
    headSha: receipt.candidateSha,
    receiptPath: receipt.receiptPath,
    receiptSha256: sha256(receiptBytes),
    receipt: Object.freeze(receipt),
  })
}

async function canonicalGitCommonDirectory(
  worktreePath: string,
  code: 'GIT_FAILED' | 'IDENTITY_DRIFT',
): Promise<string> {
  let output: string
  try {
    output = await git(worktreePath, ['rev-parse', '--git-common-dir'])
  } catch (error) {
    if (code === 'IDENTITY_DRIFT') {
      fail(`cannot resolve checkout Git identity: ${errorMessage(error)}`, code)
    }
    throw error
  }
  return await canonicalExistingDirectory(
    isAbsolute(output) ? output : resolve(worktreePath, output),
    'Git common directory',
    code,
  )
}

async function canonicalExistingDirectory(
  path: string,
  label: string,
  code: 'INVALID_INPUT' | 'GIT_FAILED' | 'IDENTITY_DRIFT' = 'INVALID_INPUT',
): Promise<string> {
  if (!isAbsolute(path)) fail(`${label} path must be absolute`, code)
  try {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) fail(`${label} is not a real directory`, code)
    return await realpath(path)
  } catch (error) {
    if (error instanceof RunCheckoutError) throw error
    fail(`cannot inspect ${label}: ${errorMessage(error)}`, code)
  }
}

async function canonicalLeafPath(path: string, label: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path) {
    fail(`${label} path must be normalized and absolute`, 'INVALID_INPUT')
  }
  return join(
    await canonicalPotentialPath(dirname(path), `${label} parent`),
    basename(path),
  )
}

/** Resolve links in the longest existing prefix while preserving a missing suffix. */
async function canonicalPotentialPath(path: string, label: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path) {
    fail(`${label} path must be normalized and absolute`, 'INVALID_INPUT')
  }
  let cursor = path
  const suffix: string[] = []
  for (;;) {
    let info: Awaited<ReturnType<typeof lstat>> | undefined
    try {
      info = await lstat(cursor)
    } catch (error) {
      if (!isNodeError(error) || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) {
        fail(`cannot inspect ${label} path: ${errorMessage(error)}`, 'IO_FAILED')
      }
    }
    if (info !== undefined) break
    const parent = dirname(cursor)
    if (parent === cursor) fail(`${label} has no existing ancestor`, 'INVALID_INPUT')
    suffix.unshift(basename(cursor))
    cursor = parent
  }
  try {
    return join(await realpath(cursor), ...suffix)
  } catch (error) {
    fail(`cannot canonicalize ${label} path: ${errorMessage(error)}`, 'IO_FAILED')
  }
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
    fail(`git ${args.join(' ')} failed: ${renderExecError(error)}`, 'GIT_FAILED')
  }
}

function hashRepositoryIdentity(repositoryPath: string, gitCommonDirectory: string): string {
  return sha256(`autolab-repository-identity-v1\0${canonicalJson({
    repositoryPath,
    gitCommonDirectory,
  })}`)
}

function hashReceipt(value: unknown): string {
  return sha256(`autolab-run-checkout-receipt-v1\0${canonicalJson(value)}`)
}

function validateInput(input: ProvisionDetachedRunCheckoutInput & { readonly receiptPath: string }): void {
  if (!ATTEMPT_PATTERN.test(input.attemptId)
    || !GIT_COMMIT_PATTERN.test(input.candidateSha)
    || !isAbsolute(input.repositoryPath)
    || resolve(input.repositoryPath) !== input.repositoryPath
    || !isAbsolute(input.checkoutPath)
    || resolve(input.checkoutPath) !== input.checkoutPath
    || !isAbsolute(input.receiptPath)
    || resolve(input.receiptPath) !== input.receiptPath
    || (input.now !== undefined && (!Number.isSafeInteger(input.now) || input.now < 0))) {
    fail('invalid detached run checkout input', 'INVALID_INPUT')
  }
}

function validateInspectionInput(input: InspectDetachedRunCheckoutInput): void {
  if (!ATTEMPT_PATTERN.test(input.attemptId)
    || !GIT_COMMIT_PATTERN.test(input.candidateSha)
    || !SHA256_PATTERN.test(input.receiptSha256)
    || !isAbsolute(input.repositoryPath)
    || resolve(input.repositoryPath) !== input.repositoryPath
    || !isAbsolute(input.checkoutPath)
    || resolve(input.checkoutPath) !== input.checkoutPath
    || !isAbsolute(input.receiptPath)
    || resolve(input.receiptPath) !== input.receiptPath) {
    fail('invalid detached run checkout inspection input', 'INVALID_INPUT')
  }
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
}

function fail(message: string, code: RunCheckoutError['code']): never {
  throw new RunCheckoutError(message, code)
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function renderExecError(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'stderr' in value) {
    const stderr = String(value.stderr).trim()
    if (stderr.length > 0) return stderr
  }
  return errorMessage(value)
}
