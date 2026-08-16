import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { durableWriteFile } from './artifacts.js'
import { canonicalJson, sha256 } from './integrity.js'
import { inspectLaneWorktree } from './worktree.js'

const execFileAsync = promisify(execFile)
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const READ_REGULAR_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

interface CandidateCaptureBody {
  readonly version: 1
  readonly labId: string
  readonly sourceRevision: number
  readonly manifestHash: string
  readonly runtimeRevision: number
  readonly laneId: string
  readonly candidateId: string
  readonly coderRoleId: string
  readonly coderSessionId: string
  readonly assignmentId: string
  readonly assignmentHash: string
  readonly worktreeReceiptHash: string
  readonly worktreePath: string
  readonly baseSha: string
  readonly sourceHeadSha: string
  readonly treeSha: string
  readonly capturedAt: number
  readonly sourceReport?: CandidateSnapshotReference
}

export interface CandidateCaptureIntent extends CandidateCaptureBody {
  readonly captureHash: string
}

interface CandidateSnapshotReceiptBody extends CandidateCaptureBody {
  readonly captureHash: string
  readonly gitRef: string
  readonly candidateSha: string
}

export interface CandidateSnapshotReceipt extends CandidateSnapshotReceiptBody {
  readonly receiptHash: string
}

export interface CandidateSnapshotReference {
  readonly path: string
  readonly hash: string
}

export interface FreezeLaneCandidateInput {
  readonly labId: string
  readonly sourceRevision: number
  readonly manifestHash: string
  readonly runtimeRevision: number
  readonly laneId: string
  readonly candidateId: string
  readonly coderRoleId: string
  readonly coderSessionId: string
  readonly assignmentId: string
  readonly assignmentHash: string
  readonly labDirectory: string
  readonly expectedWorktreePath: string
  readonly expectedWorktreeReceiptHash: string
  readonly expectedBaseSha: string
  readonly sourceReport?: CandidateSnapshotReference
  readonly now?: number
}

export class CandidateSnapshotError extends Error {
  readonly name = 'CandidateSnapshotError'

  constructor(
    message: string,
    readonly code:
      | 'INVALID_INPUT'
      | 'WORKTREE_MISMATCH'
      | 'CAPTURE_CONFLICT'
      | 'GIT_FAILED'
      | 'RECEIPT_CORRUPT'
      | 'IO_FAILED',
  ) {
    super(message)
  }
}

/**
 * Freeze the current Lane bytes as a synthetic Git commit without changing the
 * worktree or its real index. Runtime records only Git and Assignment identity;
 * it does not inspect the scientific meaning of the diff or report.
 */
export async function freezeLaneCandidate(
  input: FreezeLaneCandidateInput,
): Promise<CandidateSnapshotReceipt> {
  validateInput(input)
  const root = candidateArtifactRoot(input.labDirectory, input.assignmentId)
  const receiptPath = join(root, 'candidate.json')
  const existing = await readReceipt(receiptPath)
  if (existing !== undefined) {
    assertReceiptInput(existing, input)
    await verifyCandidateObjects(existing)
    return existing
  }

  const lane = await inspectLaneWorktree(input.labDirectory, input.laneId)
  if (lane.receipt.labId !== input.labId
    || lane.receipt.worktreePath !== input.expectedWorktreePath
    || lane.receipt.receiptHash !== input.expectedWorktreeReceiptHash
    || lane.receipt.baseSha !== input.expectedBaseSha) {
    throw new CandidateSnapshotError(
      'Lane worktree does not match the candidate capture identity',
      'WORKTREE_MISMATCH',
    )
  }
  if (input.sourceReport !== undefined) await assertSmallReference(input.sourceReport)

  const intentPath = join(root, 'capture-intent.json')
  let intent = await readIntent(intentPath)
  if (intent === undefined) {
    const treeSha = await snapshotTree(lane.receipt.worktreePath, lane.currentHeadSha)
    const body: CandidateCaptureBody = {
      version: 1,
      labId: input.labId,
      sourceRevision: input.sourceRevision,
      manifestHash: input.manifestHash,
      runtimeRevision: input.runtimeRevision,
      laneId: input.laneId,
      candidateId: input.candidateId,
      coderRoleId: input.coderRoleId,
      coderSessionId: input.coderSessionId,
      assignmentId: input.assignmentId,
      assignmentHash: input.assignmentHash,
      worktreeReceiptHash: input.expectedWorktreeReceiptHash,
      worktreePath: input.expectedWorktreePath,
      baseSha: input.expectedBaseSha,
      sourceHeadSha: lane.currentHeadSha,
      treeSha,
      capturedAt: input.now ?? Date.now(),
      ...(input.sourceReport === undefined ? {} : { sourceReport: input.sourceReport }),
    }
    intent = { ...body, captureHash: hashCapture(body) }
    await freezeCanonical(intentPath, intent)
  } else {
    assertIntentInput(intent, input)
  }

  const candidateSha = await createCandidateCommit(intent)
  const gitRef = candidateRef(intent)
  await createOrVerifyRef(intent.worktreePath, gitRef, candidateSha)

  const body: CandidateSnapshotReceiptBody = {
    ...withoutReceipt(intent),
    gitRef,
    candidateSha,
  }
  const receipt: CandidateSnapshotReceipt = {
    ...body,
    receiptHash: hashReceipt(body),
  }
  await freezeCanonical(receiptPath, receipt)
  return receipt
}

export function candidateReceiptPath(labDirectory: string, assignmentId: string): string {
  return join(candidateArtifactRoot(labDirectory, assignmentId), 'candidate.json')
}

/** Controller-owned immutable copy of the small Coder report. */
export function candidateFrozenReportPath(labDirectory: string, assignmentId: string): string {
  return join(candidateArtifactRoot(labDirectory, assignmentId), 'coder-report.json')
}

export async function readCandidateSnapshotReceipt(
  reference: CandidateSnapshotReference,
): Promise<CandidateSnapshotReceipt> {
  validateReference(reference)
  const value = await readCanonical(reference.path)
  const receipt = parseReceipt(value)
  if (sha256(canonicalJson(receipt)) !== reference.hash) {
    throw new CandidateSnapshotError('candidate receipt reference hash mismatch', 'RECEIPT_CORRUPT')
  }
  await verifyCandidateObjects(receipt)
  return receipt
}

/** On-demand utility for a Session; Runtime never turns this into a Gate. */
export async function readCandidateChangedPaths(
  receipt: CandidateSnapshotReceipt,
): Promise<readonly string[]> {
  const output = await git(receipt.worktreePath, [
    'diff',
    '--name-only',
    '-z',
    '--no-renames',
    receipt.baseSha,
    receipt.candidateSha,
    '--',
  ])
  if (output.length === 0) return Object.freeze([])
  if (output.at(-1) !== 0) {
    throw new CandidateSnapshotError('git changed-path output is not NUL terminated', 'GIT_FAILED')
  }
  return Object.freeze(
    output.subarray(0, -1).toString('utf8').split('\0').filter(Boolean),
  )
}

function validateInput(input: FreezeLaneCandidateInput): void {
  if (input.labId.length === 0
    || input.laneId.length === 0
    || input.candidateId.length === 0
    || input.coderRoleId.length === 0
    || input.coderSessionId.length === 0
    || input.assignmentId.length === 0
    || !SHA256_PATTERN.test(input.manifestHash)
    || !SHA256_PATTERN.test(input.assignmentHash)
    || !SHA256_PATTERN.test(input.expectedWorktreeReceiptHash)
    || !SHA_PATTERN.test(input.expectedBaseSha)
    || !isExactAbsolute(input.labDirectory)
    || !isExactAbsolute(input.expectedWorktreePath)
    || !Number.isSafeInteger(input.sourceRevision)
    || input.sourceRevision <= 0
    || !Number.isSafeInteger(input.runtimeRevision)
    || input.runtimeRevision < 0
    || (input.now !== undefined && (!Number.isSafeInteger(input.now) || input.now < 0))) {
    throw new CandidateSnapshotError('invalid candidate capture input', 'INVALID_INPUT')
  }
  if (input.sourceReport !== undefined) validateReference(input.sourceReport)
}

function validateReference(reference: CandidateSnapshotReference): void {
  if (!isExactAbsolute(reference.path) || !SHA256_PATTERN.test(reference.hash)) {
    throw new CandidateSnapshotError('invalid candidate artifact reference', 'INVALID_INPUT')
  }
}

function isExactAbsolute(value: string): boolean {
  return isAbsolute(value) && resolve(value) === value
}

function candidateArtifactRoot(labDirectory: string, assignmentId: string): string {
  if (!isExactAbsolute(labDirectory) || assignmentId.length === 0) {
    throw new CandidateSnapshotError('invalid candidate artifact identity', 'INVALID_INPUT')
  }
  return join(labDirectory, 'artifacts', 'candidates', sha256(assignmentId))
}

async function snapshotTree(worktreePath: string, headSha: string): Promise<string> {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-autolab-index-'))
  const indexPath = join(temporary, 'index')
  try {
    const env = { ...process.env, GIT_INDEX_FILE: indexPath, GIT_OPTIONAL_LOCKS: '0' }
    await git(worktreePath, ['read-tree', headSha], env)
    await git(worktreePath, ['add', '-A', '--', '.'], env)
    const treeSha = (await git(worktreePath, ['write-tree'], env)).toString('utf8').trim()
    if (!SHA_PATTERN.test(treeSha)) failGit('git write-tree returned an invalid object ID')
    return treeSha
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function createCandidateCommit(intent: CandidateCaptureIntent): Promise<string> {
  const date = new Date(intent.capturedAt).toISOString()
  const output = await git(intent.worktreePath, [
    'commit-tree',
    intent.treeSha,
    '-p',
    intent.baseSha,
    '-m',
    `AutoLab candidate snapshot\n\n${intent.captureHash}\n`,
  ], {
    ...process.env,
    GIT_AUTHOR_NAME: 'AutoLab Runtime',
    GIT_AUTHOR_EMAIL: 'autolab@localhost',
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: 'AutoLab Runtime',
    GIT_COMMITTER_EMAIL: 'autolab@localhost',
    GIT_COMMITTER_DATE: date,
    GIT_OPTIONAL_LOCKS: '0',
  })
  const candidateSha = output.toString('utf8').trim()
  if (!SHA_PATTERN.test(candidateSha)) failGit('git commit-tree returned an invalid object ID')
  return candidateSha
}

async function createOrVerifyRef(
  worktreePath: string,
  ref: string,
  candidateSha: string,
): Promise<void> {
  const current = await gitOptional(worktreePath, ['rev-parse', '--verify', ref])
  if (current !== undefined) {
    if (current.toString('utf8').trim() !== candidateSha) {
      throw new CandidateSnapshotError(`candidate ref ${ref} already points elsewhere`, 'CAPTURE_CONFLICT')
    }
    return
  }
  try {
    await git(worktreePath, ['update-ref', ref, candidateSha, '0'.repeat(candidateSha.length)])
  } catch (error) {
    const raced = await gitOptional(worktreePath, ['rev-parse', '--verify', ref])
    if (raced?.toString('utf8').trim() === candidateSha) return
    throw error
  }
}

function candidateRef(intent: CandidateCaptureIntent): string {
  return `refs/autolab/${sha256(intent.labId).slice(0, 16)}/${sha256(intent.assignmentId).slice(0, 24)}`
}

async function verifyCandidateObjects(receipt: CandidateSnapshotReceipt): Promise<void> {
  if (await revParse(receipt.worktreePath, receipt.gitRef) !== receipt.candidateSha
    || await revParse(receipt.worktreePath, `${receipt.candidateSha}^{tree}`) !== receipt.treeSha) {
    throw new CandidateSnapshotError('candidate Git identity no longer matches its receipt', 'RECEIPT_CORRUPT')
  }
  if (receipt.sourceReport !== undefined) await assertSmallReference(receipt.sourceReport)
}

async function assertSmallReference(reference: CandidateSnapshotReference): Promise<void> {
  const bytes = (await readRegular(reference.path))!
  if (sha256(bytes) !== reference.hash) {
    throw new CandidateSnapshotError('small candidate source receipt hash mismatch', 'RECEIPT_CORRUPT')
  }
}

function assertIntentInput(intent: CandidateCaptureIntent, input: FreezeLaneCandidateInput): void {
  const expected = {
    labId: input.labId,
    sourceRevision: input.sourceRevision,
    manifestHash: input.manifestHash,
    runtimeRevision: input.runtimeRevision,
    laneId: input.laneId,
    candidateId: input.candidateId,
    coderRoleId: input.coderRoleId,
    coderSessionId: input.coderSessionId,
    assignmentId: input.assignmentId,
    assignmentHash: input.assignmentHash,
    worktreeReceiptHash: input.expectedWorktreeReceiptHash,
    worktreePath: input.expectedWorktreePath,
    baseSha: input.expectedBaseSha,
    sourceReport: input.sourceReport,
  }
  for (const [key, value] of Object.entries(expected)) {
    if (canonicalJson((intent as unknown as Record<string, unknown>)[key] ?? null)
      !== canonicalJson(value ?? null)) {
      throw new CandidateSnapshotError(`candidate capture intent changed at ${key}`, 'CAPTURE_CONFLICT')
    }
  }
  if (intent.captureHash !== hashCapture(withoutCapture(intent))) {
    throw new CandidateSnapshotError('candidate capture intent hash is invalid', 'RECEIPT_CORRUPT')
  }
}

function assertReceiptInput(receipt: CandidateSnapshotReceipt, input: FreezeLaneCandidateInput): void {
  const {
    gitRef: _gitRef,
    candidateSha: _candidateSha,
    receiptHash: _receiptHash,
    ...intent
  } = receipt
  assertIntentInput(intent, input)
  if (receipt.receiptHash !== hashReceipt(withoutReceiptHash(receipt))) {
    throw new CandidateSnapshotError('candidate receipt hash is invalid', 'RECEIPT_CORRUPT')
  }
}

function withoutCapture(value: CandidateCaptureIntent): CandidateCaptureBody {
  const { captureHash: _captureHash, ...body } = value
  return body
}

function withoutReceipt(intent: CandidateCaptureIntent): CandidateSnapshotReceiptBody {
  return { ...intent, gitRef: candidateRef(intent), candidateSha: '' }
}

function withoutReceiptHash(receipt: CandidateSnapshotReceipt): CandidateSnapshotReceiptBody {
  const { receiptHash: _receiptHash, ...body } = receipt
  return body
}

function hashCapture(body: CandidateCaptureBody): string {
  return sha256(`autolab-candidate-capture-v2\0${canonicalJson(body)}`)
}

function hashReceipt(body: CandidateSnapshotReceiptBody): string {
  return sha256(`autolab-candidate-receipt-v2\0${canonicalJson(body)}`)
}

async function readIntent(path: string): Promise<CandidateCaptureIntent | undefined> {
  const value = await readCanonicalIfPresent(path)
  if (value === undefined) return undefined
  const intent = parseIntent(value)
  if (intent.captureHash !== hashCapture(withoutCapture(intent))) {
    throw new CandidateSnapshotError('candidate capture intent hash is invalid', 'RECEIPT_CORRUPT')
  }
  return intent
}

async function readReceipt(path: string): Promise<CandidateSnapshotReceipt | undefined> {
  const value = await readCanonicalIfPresent(path)
  if (value === undefined) return undefined
  return parseReceipt(value)
}

function parseIntent(value: unknown): CandidateCaptureIntent {
  const record = exactRecord(value)
  const intent = record as unknown as CandidateCaptureIntent
  validateBody(intent)
  if (!SHA256_PATTERN.test(intent.captureHash)) corrupt('candidate capture hash is invalid')
  return intent
}

function parseReceipt(value: unknown): CandidateSnapshotReceipt {
  const record = exactRecord(value)
  const receipt = record as unknown as CandidateSnapshotReceipt
  validateBody(receipt)
  if (!SHA256_PATTERN.test(receipt.captureHash)
    || !SHA_PATTERN.test(receipt.candidateSha)
    || typeof receipt.gitRef !== 'string'
    || !receipt.gitRef.startsWith('refs/autolab/')
    || !SHA256_PATTERN.test(receipt.receiptHash)
    || receipt.receiptHash !== hashReceipt(withoutReceiptHash(receipt))) {
    corrupt('candidate receipt schema or hash is invalid')
  }
  return receipt
}

function validateBody(value: CandidateCaptureBody): void {
  if (value.version !== 1
    || typeof value.labId !== 'string' || value.labId.length === 0
    || !Number.isSafeInteger(value.sourceRevision) || value.sourceRevision <= 0
    || !SHA256_PATTERN.test(value.manifestHash)
    || !Number.isSafeInteger(value.runtimeRevision) || value.runtimeRevision < 0
    || typeof value.laneId !== 'string' || value.laneId.length === 0
    || typeof value.candidateId !== 'string' || value.candidateId.length === 0
    || typeof value.coderRoleId !== 'string' || value.coderRoleId.length === 0
    || typeof value.coderSessionId !== 'string' || value.coderSessionId.length === 0
    || typeof value.assignmentId !== 'string' || value.assignmentId.length === 0
    || !SHA256_PATTERN.test(value.assignmentHash)
    || !SHA256_PATTERN.test(value.worktreeReceiptHash)
    || !isExactAbsolute(value.worktreePath)
    || !SHA_PATTERN.test(value.baseSha)
    || !SHA_PATTERN.test(value.sourceHeadSha)
    || !SHA_PATTERN.test(value.treeSha)
    || !Number.isSafeInteger(value.capturedAt) || value.capturedAt < 0) {
    corrupt('candidate capture schema is invalid')
  }
  if (value.sourceReport !== undefined) validateReference(value.sourceReport)
}

function exactRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    corrupt('candidate record is not an object')
  }
  return value as Record<string, unknown>
}

async function freezeCanonical(path: string, value: unknown): Promise<void> {
  const text = canonicalJson(value)
  try {
    await durableWriteFile(path, text, false)
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') throw error
  }
  if (await readRegular(path).then(bytes => bytes!.toString('utf8')) !== text) {
    throw new CandidateSnapshotError(`candidate artifact conflicts at ${path}`, 'CAPTURE_CONFLICT')
  }
}

async function readCanonicalIfPresent(path: string): Promise<unknown | undefined> {
  const bytes = await readRegular(path, true)
  if (bytes === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    corrupt(`candidate artifact is not JSON at ${path}`)
  }
  if (canonicalJson(value) !== bytes.toString('utf8')) corrupt('candidate artifact is not canonical JSON')
  return value
}

async function readCanonical(path: string): Promise<unknown> {
  const value = await readCanonicalIfPresent(path)
  if (value === undefined) corrupt(`candidate artifact is missing at ${path}`)
  return value
}

async function readRegular(path: string, optional = false): Promise<Buffer | undefined> {
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(path, READ_REGULAR_FLAGS)
    if (!(await file.stat()).isFile()) corrupt(`candidate artifact is not a regular file at ${path}`)
    return await file.readFile()
  } catch (error) {
    if (optional && isNodeError(error) && error.code === 'ENOENT') return undefined
    if (error instanceof CandidateSnapshotError) throw error
    throw new CandidateSnapshotError(`cannot read candidate artifact ${path}`, 'IO_FAILED')
  } finally {
    await file?.close().catch(() => undefined)
  }
}

async function revParse(worktreePath: string, ref: string): Promise<string> {
  return (await git(worktreePath, ['rev-parse', '--verify', ref])).toString('utf8').trim()
}

async function gitOptional(worktreePath: string, args: readonly string[]): Promise<Buffer | undefined> {
  try {
    return await git(worktreePath, args)
  } catch {
    return undefined
  }
}

async function git(
  worktreePath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<Buffer> {
  try {
    const result = await execFileAsync('git', ['-C', worktreePath, ...args], {
      encoding: 'buffer',
      env,
      maxBuffer: 16 * 1024 * 1024,
    })
    return result.stdout
  } catch (error) {
    throw new CandidateSnapshotError(
      `git ${args[0] ?? '<unknown>'} failed: ${error instanceof Error ? error.message : String(error)}`,
      'GIT_FAILED',
    )
  }
}

function failGit(message: string): never {
  throw new CandidateSnapshotError(message, 'GIT_FAILED')
}

function corrupt(message: string): never {
  throw new CandidateSnapshotError(message, 'RECEIPT_CORRUPT')
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}
