import { readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

import {
  restoreCurrentRoleArtifacts,
  type InitialRoleArtifacts,
} from './activation-artifacts.js'
import { durableWriteFile, type FrozenRevision } from './artifacts.js'
import type { StoredRoleBinding } from './binding.js'
import {
  candidateFrozenReportPath,
  candidateReceiptPath,
  freezeLaneCandidate,
  type CandidateSnapshotReceipt,
} from './candidate.js'
import {
  coderImplementationReportOutputSchema,
  freezeCompiledCoderImplementationReceipt,
  readCoderImplementationReport,
  type FrozenCoderImplementationReceipt,
  type ReadCoderImplementationReport,
} from './coder-receipt.js'
import { canonicalJson, sha256 } from './integrity.js'
import type { RootRoleBinding } from './roles.js'
import { inspectLaneWorktree } from './worktree.js'

const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export interface CoderSubmissionArtifactReference {
  readonly path: string
  readonly hash: string
}

export interface FreezeApprovedCoderSubmissionInput {
  readonly frozen: FrozenRevision
  readonly coderRole: RootRoleBinding
  readonly coderSessionId: string
  readonly coderBinding: StoredRoleBinding
  readonly coderPacket: CoderSubmissionArtifactReference
  readonly expectedAssignmentId: string
  readonly reviewId: string
  readonly sourceMethodPacket: CoderSubmissionArtifactReference
  readonly designTicket: CoderSubmissionArtifactReference
  readonly preflightVerdict: CoderSubmissionArtifactReference
  readonly runtimeRevision: number
}

/** A frozen submission is identity-only; later Sessions decide what it means. */
export interface FrozenApprovedCoderSubmission {
  readonly laneId: string
  readonly candidateId: string
  readonly reviewId: string
  readonly assignment: InitialRoleArtifacts
  readonly reportPath: string
  readonly reportHash: string
  readonly candidatePath: string
  readonly candidateHash: string
  readonly candidate: CandidateSnapshotReceipt
  readonly implementation: FrozenCoderImplementationReceipt
}

export class CoderSubmissionError extends Error {
  readonly name = 'CoderSubmissionError'

  constructor(
    message: string,
    readonly code:
      | 'INVALID_INPUT'
      | 'ASSIGNMENT_MISMATCH'
      | 'REVIEW_MISMATCH'
      | 'WORKTREE_MISMATCH'
      | 'ARTIFACT_MISMATCH',
  ) {
    super(message)
  }
}

/**
 * Freeze the exact current Coder report and Lane candidate, then bind their
 * mechanical identities. Runtime validates the report envelope but never
 * interprets `content` or follows any path inside it.
 */
export async function freezeApprovedCoderSubmission(
  input: FreezeApprovedCoderSubmissionInput,
): Promise<FrozenApprovedCoderSubmission> {
  validateInput(input)
  const manifest = input.frozen.manifest
  const role = manifest.roles.find(value => value.role_id === input.coderRole.role_id)
  if (role?.role_kind !== 'coder'
    || input.coderRole.role_kind !== 'coder'
    || canonicalJson(role) !== canonicalJson(input.coderRole)) {
    throw new CoderSubmissionError('Coder does not match one CURRENT Lane', 'INVALID_INPUT')
  }
  const lane = manifest.lanes.find(value => (
    value.lane_id === role.lane_id && value.coder_role_id === role.role_id
  ))
  if (lane === undefined) {
    throw new CoderSubmissionError('Coder does not match one CURRENT Lane', 'INVALID_INPUT')
  }

  const assignment = await restoreCurrentRoleArtifacts({
    frozen: input.frozen,
    role: input.coderRole,
    sessionId: input.coderSessionId,
    binding: input.coderBinding,
    runtimeRevision: input.runtimeRevision,
    packetRef: input.coderPacket,
  })
  if (assignment.assignmentId !== input.expectedAssignmentId
    || (input.expectedAssignmentId !== `coder:${input.reviewId}`
      && !input.expectedAssignmentId.startsWith(`coder:${input.reviewId}:fix:`))) {
    throw new CoderSubmissionError(
      'current Coder Packet does not match the authorized review Assignment',
      'ASSIGNMENT_MISMATCH',
    )
  }

  const packet = assignment.packet.packet
  const expectedReportPath = join(
    manifest.authority_paths.assignment_root,
    'outputs',
    `${sha256(assignment.assignmentId)}.json`,
  )
  if (packet.output_contract.receipt_path !== expectedReportPath
    || packet.output_contract.expected_hash_binding !== assignment.assignmentId
    || canonicalJson(packet.output_contract.schema)
      !== canonicalJson(coderImplementationReportOutputSchema())) {
    throw new CoderSubmissionError(
      'Coder Role Packet does not declare the opaque report contract',
      'ASSIGNMENT_MISMATCH',
    )
  }

  const assignmentValue = await readCanonicalRecord(
    assignment.assignmentPath,
    assignment.assignmentHash,
    'Coder Assignment',
  )
  const candidateId = assertAssignmentChain(input, assignment, assignmentValue)
  if (!hasExactStageReference(packet, 'approved-method-design-ticket', input.designTicket)
    || !hasExactStageReference(packet, 'preflight-approved-verdict', input.preflightVerdict)) {
    throw new CoderSubmissionError(
      'Coder Packet does not bind the exact Ticket and Preflight receipt',
      'REVIEW_MISMATCH',
    )
  }

  const worktree = await inspectLaneWorktree(manifest.authority_paths.lab_dir, lane.lane_id)
  const manifestWorktreePath = await realpath(lane.worktree_path).catch(() => lane.worktree_path)
  const worktreeMismatches = [
    worktree.receipt.worktreePath === manifestWorktreePath ? undefined : 'worktree_path',
    worktree.receipt.baseSha === lane.base_sha ? undefined : 'base_sha',
    worktree.receipt.labId === manifest.lab_id ? undefined : 'lab_id',
    worktree.receipt.laneId === lane.lane_id ? undefined : 'lane_id',
  ].filter((value): value is string => value !== undefined)
  if (worktreeMismatches.length > 0) {
    throw new CoderSubmissionError(
      `Lane worktree receipt does not match CURRENT: ${worktreeMismatches.join(', ')}`,
      'WORKTREE_MISMATCH',
    )
  }

  // This immutable cut is the only model-authored input. Replay adopts it and
  // never consults mutable output again.
  const report = await freezeCandidateReport(
    expectedReportPath,
    candidateFrozenReportPath(
      manifest.authority_paths.lab_dir,
      assignment.assignmentId,
    ),
  )

  const candidate = await freezeLaneCandidate({
    labId: manifest.lab_id,
    sourceRevision: input.frozen.ref.revision,
    manifestHash: input.frozen.ref.manifestHash,
    runtimeRevision: packet.anchors.runtime_revision,
    laneId: lane.lane_id,
    candidateId,
    coderRoleId: role.role_id,
    coderSessionId: input.coderSessionId,
    assignmentId: assignment.assignmentId,
    assignmentHash: assignment.assignmentHash,
    labDirectory: manifest.authority_paths.lab_dir,
    expectedWorktreePath: worktree.receipt.worktreePath,
    expectedWorktreeReceiptHash: worktree.receipt.receiptHash,
    expectedBaseSha: worktree.receipt.baseSha,
    sourceReport: { path: report.path, hash: report.sha256 },
    now: packet.header.issued_at,
  })

  const candidatePath = candidateReceiptPath(
    manifest.authority_paths.lab_dir,
    assignment.assignmentId,
  )
  const worktreeReceiptPath = join(
    manifest.authority_paths.lab_dir,
    'receipts',
    'worktrees',
    `${lane.lane_id}.json`,
  )
  const [candidateBytes, worktreeReceiptBytes] = await Promise.all([
    readControlFile(candidatePath, 'candidate receipt'),
    readControlFile(worktreeReceiptPath, 'worktree receipt'),
  ])
  const implementation = await freezeCompiledCoderImplementationReceipt({
    sourceReportPath: report.path,
    sourceReportSha256: report.sha256,
    artifactPath: join(dirname(candidatePath), 'coder-implementation.json'),
    expected: {
      labId: manifest.lab_id,
      sourceRevision: input.frozen.ref.revision,
      laneId: lane.lane_id,
      coderRoleId: role.role_id,
      coderSessionId: input.coderSessionId,
      assignmentId: assignment.assignmentId,
      assignmentContractSha256: assignment.assignmentHash,
      rolePacket: { path: assignment.packetPath, sha256: assignment.packet.packetHash },
      designTicket: {
        path: input.designTicket.path,
        sha256: input.designTicket.hash,
        candidateId,
      },
      preflightVerdict: {
        path: input.preflightVerdict.path,
        sha256: input.preflightVerdict.hash,
        reviewId: input.reviewId,
      },
      sourceWorktree: {
        path: worktree.receipt.worktreePath,
        receiptPath: worktreeReceiptPath,
        receiptSha256: sha256(worktreeReceiptBytes),
      },
      candidateSha: candidate.candidateSha,
    },
  })

  return {
    laneId: lane.lane_id,
    candidateId,
    reviewId: input.reviewId,
    assignment,
    reportPath: report.path,
    reportHash: report.sha256,
    candidatePath,
    candidateHash: sha256(candidateBytes),
    candidate,
    implementation,
  }
}

async function freezeCandidateReport(
  mutablePath: string,
  artifactPath: string,
): Promise<ReadCoderImplementationReport> {
  const existing = await readFile(artifactPath).catch(error => {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined
    throw error
  })
  if (existing !== undefined) return readCoderImplementationReport(artifactPath)

  const source = await readCoderImplementationReport(mutablePath)
  try {
    await durableWriteFile(artifactPath, source.bytes, false)
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') throw error
  }
  return readCoderImplementationReport(artifactPath)
}

function validateInput(input: FreezeApprovedCoderSubmissionInput): void {
  if (input.coderSessionId.trim().length === 0
    || input.expectedAssignmentId.trim().length === 0
    || input.reviewId.trim().length === 0
    || !Number.isSafeInteger(input.runtimeRevision)
    || input.runtimeRevision < 0) {
    throw new CoderSubmissionError('invalid Coder submission identity', 'INVALID_INPUT')
  }
  for (const reference of [
    input.coderPacket,
    input.sourceMethodPacket,
    input.designTicket,
    input.preflightVerdict,
  ]) {
    if (!isAbsolute(reference.path) || !SHA256_PATTERN.test(reference.hash)) {
      throw new CoderSubmissionError('Coder submission artifact reference is invalid', 'INVALID_INPUT')
    }
  }
}

/** Return the candidate ID already bound by the immutable Assignment. */
function assertAssignmentChain(
  input: FreezeApprovedCoderSubmissionInput,
  assignment: InitialRoleArtifacts,
  value: Record<string, unknown>,
): string {
  const coder = record(value.coder)
  const source = record(value.source_method)
  const ticket = record(value.design_ticket)
  const approval = record(value.preflight_approval)
  const isFix = value.assignment_type === 'controller_coder_fix_assignment'
  const isApproved = value.assignment_type === 'approved_coder_implementation'
  if (value.version !== 1
    || (!isFix && !isApproved)
    || value.assignment_id !== assignment.assignmentId
    || value.review_id !== input.reviewId
    || value.runtime_revision !== assignment.packet.packet.anchors.runtime_revision
    || value.issued_at !== assignment.packet.packet.header.issued_at
    || coder?.role_id !== input.coderRole.role_id
    || coder.session_id !== input.coderSessionId
    || coder.binding_path !== input.coderBinding.path
    || coder.binding_sha256 !== input.coderBinding.hash
    || !sameReference(source?.packet, input.sourceMethodPacket)
    || ticket === undefined
    || !sameReference(ticket, input.designTicket)
    || !sameReference(approval, input.preflightVerdict)
    || approval?.top_level_verdict !== 'APPROVED'
    || (isFix ? record(value.fix_mandate) === undefined : record(value.fix_mandate) !== undefined)
    || canonicalJson(value.output_contract)
      !== canonicalJson(assignment.packet.packet.output_contract)) {
    throw new CoderSubmissionError(
      'Coder Assignment does not bind the expected role and review chain',
      'ASSIGNMENT_MISMATCH',
    )
  }
  const candidateId = isFix
    ? typeof value.candidate_id === 'string' && value.candidate_id.trim().length > 0
      ? value.candidate_id
      : undefined
    : typeof ticket.candidate_id === 'string' && ticket.candidate_id.trim().length > 0
      ? ticket.candidate_id
      : undefined
  if (candidateId === undefined) {
    throw new CoderSubmissionError(
      'Coder Assignment does not bind one candidate identity',
      'ASSIGNMENT_MISMATCH',
    )
  }
  return candidateId
}

function sameReference(value: unknown, expected: CoderSubmissionArtifactReference): boolean {
  const item = record(value)
  return item?.path === expected.path && item.sha256 === expected.hash
}

function hasExactStageReference(
  packet: InitialRoleArtifacts['packet']['packet'],
  blockId: string,
  reference: CoderSubmissionArtifactReference,
): boolean {
  const matches = packet.verbatim_blocks.stage.filter(block => block.block_id === blockId)
  return matches.length === 1
    && matches[0]!.byte_range === undefined
    && matches[0]!.source_path === reference.path
    && matches[0]!.text_sha256 === reference.hash
    && sha256(Buffer.from(matches[0]!.exact_text, 'utf8')) === reference.hash
}

async function readControlFile(path: string, label: string): Promise<Buffer> {
  try {
    return await readFile(path)
  } catch {
    throw new CoderSubmissionError(`${label} cannot be read`, 'ARTIFACT_MISMATCH')
  }
}

async function readExact(
  reference: CoderSubmissionArtifactReference,
  label: string,
): Promise<Buffer> {
  const bytes = await readControlFile(reference.path, label)
  if (sha256(bytes) !== reference.hash) {
    throw new CoderSubmissionError(`${label} SHA-256 mismatch`, 'ARTIFACT_MISMATCH')
  }
  return bytes
}

async function readCanonicalRecord(
  path: string,
  expectedHash: string,
  label: string,
): Promise<Record<string, unknown>> {
  const bytes = await readExact({ path, hash: expectedHash }, label)
  let text: string
  let value: unknown
  try {
    text = UTF8.decode(bytes)
    value = JSON.parse(text) as unknown
  } catch {
    throw new CoderSubmissionError(`${label} is not UTF-8 JSON`, 'ARTIFACT_MISMATCH')
  }
  const parsed = record(value)
  if (parsed === undefined || canonicalJson(parsed) !== text) {
    throw new CoderSubmissionError(`${label} is not canonical JSON`, 'ARTIFACT_MISMATCH')
  }
  return parsed
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}
