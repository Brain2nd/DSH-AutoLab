import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

import { z } from 'zod'

import { durableWriteFile } from './artifacts.js'
import { canonicalJson, sha256 } from './integrity.js'
import { parseRolePacket, type RolePacket } from './packet.js'

const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const PREFLIGHT_VERDICTS = [
  'APPROVED',
  'REVISION_REQUIRED',
  'REJECTED',
  'REVIEW_ERROR',
] as const

const blockingFindingSchema = z.object({
  rule_or_frozen_field: z.string().min(1),
  blocked_transition: z.string().min(1),
  conflict_or_missing_evidence: z.string().min(1),
}).strict()

const preflightVerdictSchema = z.object({
  version: z.literal(1),
  review_id: z.string().min(1),
  assignment_id: z.string().min(1),
  review_input_sha256: z.string().regex(SHA256_PATTERN),
  top_level_verdict: z.enum(PREFLIGHT_VERDICTS),
  blocking_findings: z.array(blockingFindingSchema),
  reasons: z.array(z.string().min(1)),
  warnings: z.array(z.string().min(1)),
}).strict()

export type PreflightTopLevelVerdict = z.infer<typeof preflightVerdictSchema>['top_level_verdict']
export type PreflightBlockingFinding = z.infer<typeof blockingFindingSchema>
export type PreflightVerdict = z.infer<typeof preflightVerdictSchema>

export interface FreezePreflightVerdictInput {
  /** Absolute path of the CURRENT Preflight Judge Role Packet. */
  readonly rolePacketPath: string
  /** Hash recorded by Controller for the exact Role Packet bytes. */
  readonly rolePacketHash: string
  /** Controller-owned immutable destination for the raw Judge receipt. */
  readonly artifactPath: string
}

export interface FrozenPreflightVerdict {
  readonly rolePacketPath: string
  readonly rolePacketHash: string
  /** The receipt path declared by the Role Packet output contract. */
  readonly receiptPath: string
  readonly artifactPath: string
  readonly receiptHash: string
  /** Exact bytes copied to the immutable artifact, without JSON re-encoding. */
  readonly receiptBytes: Buffer
  readonly packet: RolePacket
  readonly verdict: PreflightVerdict
}

export class PreflightVerdictError extends Error {
  readonly name = 'PreflightVerdictError'

  constructor(
    message: string,
    readonly code:
      | 'INVALID_INPUT'
      | 'PACKET_READ_FAILED'
      | 'PACKET_HASH_MISMATCH'
      | 'INVALID_PACKET'
      | 'ROLE_MISMATCH'
      | 'OUTPUT_CONTRACT_MISMATCH'
      | 'RECEIPT_READ_FAILED'
      | 'INVALID_RECEIPT'
      | 'REVIEW_BINDING_MISMATCH'
      | 'ARTIFACT_WRITE_FAILED'
      | 'ARTIFACT_CONFLICT',
    readonly issues: readonly z.core.$ZodIssue[] = [],
  ) {
    super(message)
  }
}

/** Parse one strict, model-produced Preflight receipt without adding policy gates. */
export function parsePreflightVerdict(value: unknown): PreflightVerdict {
  const parsed = preflightVerdictSchema.safeParse(value)
  if (!parsed.success) {
    throw new PreflightVerdictError(
      `Preflight verdict is invalid: ${formatIssues(parsed.error.issues)}`,
      'INVALID_RECEIPT',
      parsed.error.issues,
    )
  }
  return parsed.data
}

/**
 * Read the receipt path declared by the exact Judge Role Packet, validate its
 * identity and output contract, then freeze the original receipt bytes into the
 * Controller-owned destination. The destination is append/no-clobber only:
 * identical retries succeed, different bytes fail.
 */
export async function freezePreflightVerdict(
  input: FreezePreflightVerdictInput,
): Promise<FrozenPreflightVerdict> {
  const packetPath = validatePath(input.rolePacketPath, 'Role Packet path')
  const artifactPath = validatePath(input.artifactPath, 'artifact path')
  validateHash(input.rolePacketHash, 'Role Packet hash')
  if (packetPath === artifactPath) {
    throw new PreflightVerdictError(
      'Controller artifact path must differ from the Judge receipt path',
      'INVALID_INPUT',
    )
  }

  const packetBytes = await readBytes(packetPath, 'Role Packet')
  const observedPacketHash = sha256(packetBytes)
  if (observedPacketHash !== input.rolePacketHash) {
    throw new PreflightVerdictError(
      'Role Packet bytes do not match the supplied hash',
      'PACKET_HASH_MISMATCH',
    )
  }
  const packet = parsePacketBytes(packetBytes)
  if (packet.header.role_kind !== 'preflight_judge') {
    throw new PreflightVerdictError(
      `Role Packet role_kind is ${JSON.stringify(packet.header.role_kind)}, not "preflight_judge"`,
      'ROLE_MISMATCH',
    )
  }

  const binding = validateOutputContract(packet)
  const receiptBytes = await readBytes(binding.receiptPath, 'Preflight receipt')
  const receipt = parseReceiptBytes(receiptBytes)
  if (receipt.review_id !== binding.reviewId
    || receipt.assignment_id !== binding.assignmentId
    || receipt.review_input_sha256 !== binding.reviewInputHash) {
    throw new PreflightVerdictError(
      'Preflight receipt identity does not match the Role Packet output contract',
      'REVIEW_BINDING_MISMATCH',
    )
  }

  await freezeNoClobber(artifactPath, receiptBytes)
  return {
    rolePacketPath: packetPath,
    rolePacketHash: observedPacketHash,
    receiptPath: binding.receiptPath,
    artifactPath,
    receiptHash: sha256(receiptBytes),
    receiptBytes,
    packet,
    verdict: receipt,
  }
}

/** Explicit artifact-named alias for callers that use the storage vocabulary. */
export const freezePreflightVerdictArtifact = freezePreflightVerdict
export const parsePreflightVerdictArtifact = parsePreflightVerdict

interface ContractBinding {
  readonly receiptPath: string
  readonly reviewId: string
  readonly assignmentId: string
  readonly reviewInputHash: string
}

function validateOutputContract(packet: RolePacket): ContractBinding {
  const contract = packet.output_contract
  const receiptPath = validatePath(contract.receipt_path, 'Role Packet receipt path')
  if (!SHA256_PATTERN.test(contract.expected_hash_binding)) {
    throw new PreflightVerdictError(
      'Role Packet output_contract.expected_hash_binding is not a SHA-256 hash',
      'OUTPUT_CONTRACT_MISMATCH',
    )
  }

  const schema = asRecord(contract.schema)
  if (schema === undefined
    || schema.type !== 'object'
    || schema.additionalProperties !== false) {
    throw new PreflightVerdictError(
      'Role Packet does not carry a strict Preflight verdict object schema',
      'OUTPUT_CONTRACT_MISMATCH',
    )
  }
  const required = asStringArray(schema.required)
  const requiredFields = [
    'version',
    'review_id',
    'assignment_id',
    'review_input_sha256',
    'top_level_verdict',
    'blocking_findings',
    'reasons',
    'warnings',
  ]
  if (required === undefined || !requiredFields.every(field => required.includes(field))) {
    throw new PreflightVerdictError(
      'Role Packet Preflight schema does not require the complete verdict identity',
      'OUTPUT_CONTRACT_MISMATCH',
    )
  }
  const properties = asRecord(schema.properties)
  if (properties === undefined) {
    throw new PreflightVerdictError(
      'Role Packet Preflight schema has no properties object',
      'OUTPUT_CONTRACT_MISMATCH',
    )
  }

  const version = asRecord(properties.version)
  const reviewId = constString(properties.review_id)
  const assignmentId = constString(properties.assignment_id)
  const reviewInputHash = constString(properties.review_input_sha256)
  const verdict = asRecord(properties.top_level_verdict)
  if (version?.const !== 1
    || reviewId === undefined
    || assignmentId === undefined
    || reviewInputHash === undefined
    || !SHA256_PATTERN.test(reviewInputHash)
    || verdict === undefined
    || !sameStringSet(verdict.enum, PREFLIGHT_VERDICTS)) {
    throw new PreflightVerdictError(
      'Role Packet Preflight schema does not bind the required verdict identity',
      'OUTPUT_CONTRACT_MISMATCH',
    )
  }

  if (packet.header.assignment_id !== assignmentId
    || contract.expected_hash_binding !== reviewInputHash) {
    throw new PreflightVerdictError(
      'Role Packet assignment or review-input hash is internally inconsistent',
      'OUTPUT_CONTRACT_MISMATCH',
    )
  }
  for (const field of ['blocking_findings', 'reasons', 'warnings']) {
    const descriptor = asRecord(properties[field])
    if (descriptor?.type !== 'array') {
      throw new PreflightVerdictError(
        `Role Packet Preflight schema has no array field ${JSON.stringify(field)}`,
        'OUTPUT_CONTRACT_MISMATCH',
      )
    }
  }
  return { receiptPath, reviewId, assignmentId, reviewInputHash }
}

function parsePacketBytes(bytes: Buffer): RolePacket {
  let value: unknown
  let text: string
  try {
    text = bytes.toString('utf8')
    value = JSON.parse(text)
  } catch (error) {
    throw new PreflightVerdictError(
      `Role Packet is not valid JSON: ${errorMessage(error)}`,
      'INVALID_PACKET',
    )
  }
  let packet: RolePacket
  try {
    packet = parseRolePacket(value)
  } catch (error) {
    throw new PreflightVerdictError(
      `Role Packet schema is invalid: ${errorMessage(error)}`,
      'INVALID_PACKET',
    )
  }
  if (canonicalJson(packet) !== text) {
    throw new PreflightVerdictError(
      'Role Packet bytes are not its canonical immutable form',
      'INVALID_PACKET',
    )
  }
  return packet
}

function parseReceiptBytes(bytes: Buffer): PreflightVerdict {
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new PreflightVerdictError(
      `Preflight receipt is not valid JSON: ${errorMessage(error)}`,
      'INVALID_RECEIPT',
    )
  }
  return parsePreflightVerdict(value)
}

async function freezeNoClobber(path: string, bytes: Buffer): Promise<void> {
  try {
    await durableWriteFile(path, bytes, false)
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') {
      throw new PreflightVerdictError(
        `Cannot write immutable Preflight artifact at ${path}: ${errorMessage(error)}`,
        'ARTIFACT_WRITE_FAILED',
      )
    }
  }
  let committed: Buffer
  try {
    committed = await readFile(path)
  } catch (error) {
    throw new PreflightVerdictError(
      `Immutable Preflight artifact cannot be read at ${path}: ${errorMessage(error)}`,
      'ARTIFACT_CONFLICT',
    )
  }
  if (!committed.equals(bytes)) {
    throw new PreflightVerdictError(
      `Immutable Preflight artifact conflicts at ${path}`,
      'ARTIFACT_CONFLICT',
    )
  }
}

async function readBytes(path: string, label: string): Promise<Buffer> {
  try {
    return await readFile(path)
  } catch (error) {
    throw new PreflightVerdictError(
      `${label} cannot be read at ${path}: ${errorMessage(error)}`,
      label === 'Role Packet' ? 'PACKET_READ_FAILED' : 'RECEIPT_READ_FAILED',
    )
  }
}

function validatePath(value: string, label: string): string {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new PreflightVerdictError(`${label} must be absolute`, 'INVALID_INPUT')
  }
  return resolve(value)
}

function validateHash(value: string, label: string): void {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new PreflightVerdictError(`${label} must be a SHA-256 hash`, 'INVALID_INPUT')
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) return undefined
  return value
}

function constString(value: unknown): string | undefined {
  const record = asRecord(value)
  return typeof record?.const === 'string' ? record.const : undefined
}

function sameStringSet(value: unknown, expected: readonly string[]): boolean {
  const actual = asStringArray(value)
  return actual !== undefined
    && actual.length === expected.length
    && new Set(actual).size === actual.length
    && expected.every(item => actual.includes(item))
}

function formatIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('; ')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}
