import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

import { z } from 'zod'

import { durableWriteFile } from './artifacts.js'
import { canonicalJson, sha256 } from './integrity.js'

const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const GIT_COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const READ_REGULAR_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

const nonBlank = z.string().min(1).refine(value => value.trim().length > 0, 'must not be blank')
const identifier = nonBlank
const hash = z.string().regex(SHA256_PATTERN)
const gitCommit = z.string().regex(GIT_COMMIT_PATTERN)
const absolutePath = z.string().min(1).refine(isAbsolute, 'path must be absolute')

const artifactReferenceSchema = z.object({
  path: absolutePath,
  sha256: hash,
}).strict()

const expectedCoderImplementationAnchorsSchema = z.object({
  labId: identifier,
  sourceRevision: z.number().int().positive(),
  laneId: identifier,
  coderRoleId: identifier,
  coderSessionId: identifier,
  assignmentId: identifier,
  assignmentContractSha256: hash,
  rolePacket: artifactReferenceSchema,
  designTicket: artifactReferenceSchema.extend({ candidateId: identifier }).strict(),
  preflightVerdict: artifactReferenceSchema.extend({ reviewId: identifier }).strict(),
  sourceWorktree: z.object({
    path: absolutePath,
    receiptPath: absolutePath,
    receiptSha256: hash,
  }).strict(),
  candidateSha: gitCommit,
}).strict()

/** The complete model-facing contract. `content` is opaque JSON to Runtime. */
export const coderImplementationReportSchema = z.object({
  schema_version: z.literal(1),
  content: z.json(),
}).strict()

/** Runtime-authored receipt containing only mechanical identity bindings. */
export const coderImplementationReceiptSchema = z.object({
  schema_version: z.literal(1),
  lab_id: identifier,
  source_revision: z.number().int().positive(),
  lane_id: identifier,
  coder: z.object({
    role_id: identifier,
    session_id: identifier,
  }).strict(),
  assignment: z.object({
    assignment_id: identifier,
    assignment_contract_sha256: hash,
  }).strict(),
  role_packet: artifactReferenceSchema,
  design_ticket: artifactReferenceSchema.extend({
    candidate_id: identifier,
  }).strict(),
  preflight_verdict: artifactReferenceSchema.extend({
    review_id: identifier,
  }).strict(),
  source_worktree: z.object({
    path: absolutePath,
    receipt_path: absolutePath,
    receipt_sha256: hash,
  }).strict(),
  candidate_sha: gitCommit,
  source_report: artifactReferenceSchema,
}).strict()

export type CoderImplementationReceipt = z.infer<typeof coderImplementationReceiptSchema>
export type CoderImplementationReport = z.infer<typeof coderImplementationReportSchema>

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** JSON Schema for the Runtime-authored immutable receipt. */
export function coderImplementationReceiptOutputSchema(): JsonValue {
  return z.toJSONSchema(coderImplementationReceiptSchema) as JsonValue
}

/** JSON Schema installed as the Coder's model-facing output contract. */
export function coderImplementationReportOutputSchema(): JsonValue {
  return z.toJSONSchema(coderImplementationReportSchema) as JsonValue
}

export interface CoderReceiptArtifactReference {
  readonly path: string
  readonly sha256: string
}

export interface ExpectedCoderImplementationAnchors {
  readonly labId: string
  readonly sourceRevision: number
  readonly laneId: string
  readonly coderRoleId: string
  readonly coderSessionId: string
  readonly assignmentId: string
  readonly assignmentContractSha256: string
  readonly rolePacket: CoderReceiptArtifactReference
  readonly designTicket: CoderReceiptArtifactReference & { readonly candidateId: string }
  readonly preflightVerdict: CoderReceiptArtifactReference & { readonly reviewId: string }
  readonly sourceWorktree: {
    readonly path: string
    readonly receiptPath: string
    readonly receiptSha256: string
  }
  readonly candidateSha: string
}

export interface FreezeCoderImplementationReceiptInput {
  /** A small, already-compiled Runtime receipt. */
  readonly sourceReceiptPath: string
  /** Controller-owned immutable destination. */
  readonly artifactPath: string
  readonly expected: ExpectedCoderImplementationAnchors
  /** Trusted reference to the opaque model report bound by the receipt. */
  readonly sourceReport: CoderReceiptArtifactReference
}

export interface FreezeCompiledCoderImplementationReceiptInput {
  /** Small model-authored report selected by the current Role Packet. */
  readonly sourceReportPath: string
  /** Hash observed at candidate capture; closes report/candidate TOCTOU. */
  readonly sourceReportSha256: string
  /** Controller-owned immutable final receipt destination. */
  readonly artifactPath: string
  readonly expected: ExpectedCoderImplementationAnchors
}

export interface FrozenCoderImplementationReceipt {
  readonly sourceReceiptPath: string
  readonly artifactPath: string
  readonly artifactHash: string
  readonly receiptBytes: Buffer
  readonly receipt: CoderImplementationReceipt
}

export interface ReadCoderImplementationReport {
  readonly path: string
  readonly sha256: string
  readonly bytes: Buffer
  readonly report: CoderImplementationReport
}

export class CoderReceiptError extends Error {
  readonly name = 'CoderReceiptError'

  constructor(
    message: string,
    readonly code:
      | 'INVALID_INPUT'
      | 'RECEIPT_READ_FAILED'
      | 'INVALID_RECEIPT'
      | 'ANCHOR_MISMATCH'
      | 'ARTIFACT_WRITE_FAILED'
      | 'ARTIFACT_CONFLICT'
      | 'HASH_MISMATCH'
      | 'IO_FAILED',
    readonly issues: readonly z.core.$ZodIssue[] = [],
  ) {
    super(message)
  }
}

export function parseCoderImplementationReceipt(value: unknown): CoderImplementationReceipt {
  const parsed = coderImplementationReceiptSchema.safeParse(value)
  if (!parsed.success) {
    throw new CoderReceiptError(
      `Coder implementation receipt is invalid: ${formatIssues(parsed.error.issues)}`,
      'INVALID_RECEIPT',
      parsed.error.issues,
    )
  }
  return parsed.data
}

export function parseCoderImplementationReport(value: unknown): CoderImplementationReport {
  const parsed = coderImplementationReportSchema.safeParse(value)
  if (!parsed.success) {
    throw new CoderReceiptError(
      `Coder implementation report is invalid: ${formatIssues(parsed.error.issues)}`,
      'INVALID_RECEIPT',
      parsed.error.issues,
    )
  }
  return parsed.data
}

export async function readCoderImplementationReport(
  path: string,
): Promise<ReadCoderImplementationReport> {
  const absolute = validateAbsolutePath(path, 'Coder implementation report path')
  const bytes = await readBytes(absolute, 'Coder implementation report', 'RECEIPT_READ_FAILED')
  let value: unknown
  try {
    value = JSON.parse(UTF8.decode(bytes))
  } catch (error) {
    throw new CoderReceiptError(
      `Coder implementation report is not valid UTF-8 JSON: ${errorMessage(error)}`,
      'INVALID_RECEIPT',
    )
  }
  return {
    path: absolute,
    sha256: sha256(bytes),
    bytes,
    report: parseCoderImplementationReport(value),
  }
}

/** Combine trusted anchors with only the opaque report's exact path/hash. */
export function compileCoderImplementationReceipt(input: {
  readonly expected: ExpectedCoderImplementationAnchors
  readonly sourceReport: CoderReceiptArtifactReference
}): CoderImplementationReceipt {
  const expected = parseExpectedAnchors(input.expected)
  const sourceReport = parseArtifactReference(input.sourceReport, 'source report')
  return parseCoderImplementationReceipt({
    schema_version: 1,
    lab_id: expected.labId,
    source_revision: expected.sourceRevision,
    lane_id: expected.laneId,
    coder: {
      role_id: expected.coderRoleId,
      session_id: expected.coderSessionId,
    },
    assignment: {
      assignment_id: expected.assignmentId,
      assignment_contract_sha256: expected.assignmentContractSha256,
    },
    role_packet: expected.rolePacket,
    design_ticket: {
      path: expected.designTicket.path,
      sha256: expected.designTicket.sha256,
      candidate_id: expected.designTicket.candidateId,
    },
    preflight_verdict: {
      path: expected.preflightVerdict.path,
      sha256: expected.preflightVerdict.sha256,
      review_id: expected.preflightVerdict.reviewId,
    },
    source_worktree: {
      path: expected.sourceWorktree.path,
      receipt_path: expected.sourceWorktree.receiptPath,
      receipt_sha256: expected.sourceWorktree.receiptSha256,
    },
    candidate_sha: expected.candidateSha,
    source_report: sourceReport,
  })
}

/**
 * Preserve exact valid Runtime-receipt bytes at one immutable destination.
 * Exact replay adopts the existing file; different bytes never overwrite it.
 * No referenced report or experiment file is opened by this path.
 */
export async function freezeCoderImplementationReceipt(
  input: FreezeCoderImplementationReceiptInput,
): Promise<FrozenCoderImplementationReceipt> {
  const sourceReceiptPath = validateAbsolutePath(input.sourceReceiptPath, 'source receipt path')
  const artifactPath = validateAbsolutePath(input.artifactPath, 'artifact path')
  if (sourceReceiptPath === artifactPath) {
    throw new CoderReceiptError(
      'immutable artifact must be distinct from the mutable Runtime receipt',
      'INVALID_INPUT',
    )
  }

  const receiptBytes = await readBytes(sourceReceiptPath, 'Coder receipt', 'RECEIPT_READ_FAILED')
  const receipt = parseReceiptBytes(receiptBytes)
  assertExpectedAnchors(receipt, input.expected, input.sourceReport)
  const committed = await freezeReceiptBytes(artifactPath, receiptBytes)
  return {
    sourceReceiptPath,
    artifactPath,
    artifactHash: sha256(committed),
    receiptBytes: committed,
    receipt,
  }
}

/**
 * Preferred Runtime path: validate only the report's two-field envelope, bind
 * its exact path/hash to trusted identities, and publish a canonical receipt.
 * `report.content` is never interpreted and no path inside it is accessed.
 */
export async function freezeCompiledCoderImplementationReceipt(
  input: FreezeCompiledCoderImplementationReceiptInput,
): Promise<FrozenCoderImplementationReceipt> {
  const report = await readCoderImplementationReport(input.sourceReportPath)
  validateHash(input.sourceReportSha256, 'Coder implementation report SHA-256')
  if (report.sha256 !== input.sourceReportSha256) {
    throw new CoderReceiptError(
      'Coder implementation report changed while freezing the candidate',
      'HASH_MISMATCH',
    )
  }
  const artifactPath = validateAbsolutePath(input.artifactPath, 'artifact path')
  if (report.path === artifactPath) {
    throw new CoderReceiptError(
      'immutable artifact must be distinct from the mutable Coder report',
      'INVALID_INPUT',
    )
  }
  const receipt = compileCoderImplementationReceipt({
    expected: input.expected,
    sourceReport: { path: report.path, sha256: report.sha256 },
  })
  const receiptBytes = Buffer.from(canonicalJson(receipt), 'utf8')
  const committed = await freezeReceiptBytes(artifactPath, receiptBytes)
  return {
    sourceReceiptPath: report.path,
    artifactPath,
    artifactHash: sha256(committed),
    receiptBytes: committed,
    receipt,
  }
}

/** Read one exact immutable receipt through its path and SHA-256 reference. */
export async function readCoderImplementationReceipt(
  reference: CoderReceiptArtifactReference,
): Promise<FrozenCoderImplementationReceipt> {
  const parsedReference = parseArtifactReference(reference, 'immutable Coder receipt')
  const receiptBytes = await readBytes(
    parsedReference.path,
    'immutable Coder receipt',
    'ARTIFACT_CONFLICT',
  )
  const artifactHash = sha256(receiptBytes)
  if (artifactHash !== parsedReference.sha256) {
    throw new CoderReceiptError(
      `Immutable Coder receipt SHA-256 mismatch at ${parsedReference.path}`,
      'HASH_MISMATCH',
    )
  }
  return {
    sourceReceiptPath: parsedReference.path,
    artifactPath: parsedReference.path,
    artifactHash,
    receiptBytes,
    receipt: parseReceiptBytes(receiptBytes),
  }
}

function parseReceiptBytes(bytes: Buffer): CoderImplementationReceipt {
  let value: unknown
  try {
    value = JSON.parse(UTF8.decode(bytes))
  } catch (error) {
    throw new CoderReceiptError(
      `Coder receipt is not valid UTF-8 JSON: ${errorMessage(error)}`,
      'INVALID_RECEIPT',
    )
  }
  return parseCoderImplementationReceipt(value)
}

function parseExpectedAnchors(
  expected: ExpectedCoderImplementationAnchors,
): ExpectedCoderImplementationAnchors {
  const parsed = expectedCoderImplementationAnchorsSchema.safeParse(expected)
  if (!parsed.success) {
    throw new CoderReceiptError(
      `Expected Coder receipt anchors are invalid: ${formatIssues(parsed.error.issues)}`,
      'INVALID_INPUT',
      parsed.error.issues,
    )
  }
  return parsed.data
}

function parseArtifactReference(
  reference: CoderReceiptArtifactReference,
  label: string,
): CoderReceiptArtifactReference {
  const parsed = artifactReferenceSchema.safeParse(reference)
  if (!parsed.success) {
    throw new CoderReceiptError(
      `${label} reference is invalid: ${formatIssues(parsed.error.issues)}`,
      'INVALID_INPUT',
      parsed.error.issues,
    )
  }
  return { path: resolve(parsed.data.path), sha256: parsed.data.sha256 }
}

function assertExpectedAnchors(
  receipt: CoderImplementationReceipt,
  expected: ExpectedCoderImplementationAnchors,
  sourceReport: CoderReceiptArtifactReference,
): void {
  const expectedReceipt = compileCoderImplementationReceipt({ expected, sourceReport })
  if (canonicalJson(receipt) !== canonicalJson(expectedReceipt)) {
    throw new CoderReceiptError(
      'Coder implementation receipt does not match the expected mechanical identities',
      'ANCHOR_MISMATCH',
    )
  }
}

async function freezeReceiptBytes(path: string, receiptBytes: Buffer): Promise<Buffer> {
  try {
    await durableWriteFile(path, receiptBytes, false)
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') {
      throw new CoderReceiptError(
        `Cannot write immutable Coder receipt at ${path}: ${errorMessage(error)}`,
        'ARTIFACT_WRITE_FAILED',
      )
    }
  }
  const committed = await readBytes(path, 'immutable Coder receipt', 'ARTIFACT_CONFLICT')
  if (!committed.equals(receiptBytes)) {
    throw new CoderReceiptError(
      `Immutable Coder receipt conflicts at ${path}`,
      'ARTIFACT_CONFLICT',
    )
  }
  return committed
}

async function readBytes(
  path: string,
  label: string,
  code: 'RECEIPT_READ_FAILED' | 'ARTIFACT_CONFLICT',
): Promise<Buffer> {
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(path, READ_REGULAR_FLAGS)
    if (!(await file.stat()).isFile()) {
      throw new CoderReceiptError(`${label} is not a regular file at ${path}`, code)
    }
    return await file.readFile()
  } catch (error) {
    if (error instanceof CoderReceiptError) throw error
    if (isNodeError(error)
      && (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'ELOOP')) {
      throw new CoderReceiptError(
        `${label} is missing or not a regular file at ${path}`,
        code,
      )
    }
    throw new CoderReceiptError(
      `${label} I/O failed at ${path}: ${errorMessage(error)}`,
      'IO_FAILED',
    )
  } finally {
    await file?.close().catch(() => undefined)
  }
}

function validateAbsolutePath(value: string, label: string): string {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new CoderReceiptError(`${label} must be absolute`, 'INVALID_INPUT')
  }
  return resolve(value)
}

function validateHash(value: string, label: string): void {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new CoderReceiptError(`${label} must be a SHA-256 hash`, 'INVALID_INPUT')
  }
}

function formatIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues.map(issue => {
    const path = issue.path.length === 0 ? '<root>' : issue.path.join('.')
    return `${path}: ${issue.message}`
  }).join('; ')
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
