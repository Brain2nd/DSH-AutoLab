import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { durableWriteFile, type FrozenRevision } from './artifacts.js'
import { readRoleBinding, type StoredRoleBinding } from './binding.js'
import { currentFactAnchor } from './fact-registry.js'
import { canonicalJson, sha256 } from './integrity.js'
import {
  compileRolePacket,
  parseRolePacket,
  type CompiledRolePacket,
  type RolePacket,
} from './packet.js'
import { resolveRootRoleSessionSpec, rolePromptFor } from './roles.js'

const SHA256_PATTERN = /^[0-9a-f]{64}$/u

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export interface FrozenArtifactReference {
  readonly path: string
  readonly sha256: string
}

export interface FreezePreflightReviewArtifactsInput {
  /** The revision read through CURRENT and already verified by ArtifactStore. */
  readonly frozen: FrozenRevision
  readonly judgeSessionId: string
  readonly judgeBinding: StoredRoleBinding
  readonly sourceMethodAssignment: FrozenArtifactReference
  readonly sourceMethodPacket: FrozenArtifactReference
  readonly designTicket: FrozenArtifactReference
  readonly reviewId: string
  readonly runtimeRevision: number
  readonly issuedAt: number
}

export interface PreflightReviewArtifacts {
  readonly reviewId: string
  readonly assignmentId: string
  readonly reviewInputHash: string
  readonly assignmentPath: string
  readonly assignmentHash: string
  readonly assignmentText: string
  readonly verdictPath: string
  readonly packetPath: string
  readonly packet: CompiledRolePacket
}

export class PreflightReviewArtifactError extends Error {
  readonly name = 'PreflightReviewArtifactError'

  constructor(
    message: string,
    readonly code:
      | 'INVALID_INPUT'
      | 'CURRENT_MISMATCH'
      | 'JUDGE_BINDING_MISMATCH'
      | 'SOURCE_PACKET_MISMATCH'
      | 'INPUT_HASH_MISMATCH'
      | 'ARTIFACT_CONFLICT',
  ) {
    super(message)
  }
}

/**
 * Freeze one exact Preflight Judge Assignment and Role Packet. All scientific
 * text is copied byte-for-byte from CURRENT, built-ins, or immutable inputs;
 * no model summary or additional admission rule is introduced here.
 */
export async function freezePreflightReviewArtifacts(
  input: FreezePreflightReviewArtifactsInput,
): Promise<PreflightReviewArtifacts> {
  validateScalarInput(input)
  assertFrozenRevision(input.frozen)

  const manifest = input.frozen.manifest
  await assertExactInput(
    { path: manifest.authority_paths.lab_spec, sha256: input.frozen.ref.specHash },
    'CURRENT LAB_SPEC',
    input.frozen.spec,
  )
  await assertExactInput(
    { path: manifest.authority_paths.resolved_manifest, sha256: input.frozen.ref.manifestHash },
    'CURRENT ResolvedManifest',
    canonicalJson(manifest),
  )

  const judge = await resolveJudge(input)
  const sourcePacket = await readSourceMethodPacket(input.sourceMethodPacket)
  assertSourceMethodPacket(
    sourcePacket,
    input.sourceMethodAssignment,
    input.frozen,
    judge.laneId,
    judge.methodRoleId,
  )
  await assertExactInput(input.sourceMethodAssignment, 'source Method Assignment')
  await assertExactInput(input.designTicket, 'Design Ticket')

  const prompt = rolePromptFor('preflight_judge')
  const promptPath = join(manifest.authority_paths.lab_dir, 'artifacts', 'builtins', `${prompt.sha256}.txt`)
  await freezeExact(promptPath, prompt.text)

  const laneText = canonicalJson(judge.charter.content)
  if (sha256(laneText) !== judge.charter.charter_sha256) {
    throw new PreflightReviewArtifactError(
      'LaneCharter bytes do not match CURRENT ResolvedManifest',
      'CURRENT_MISMATCH',
    )
  }
  const lanePath = join(
    manifest.authority_paths.lab_dir,
    'artifacts',
    'lanes',
    `${sha256(judge.laneId)}.charter.json`,
  )
  await freezeExact(lanePath, laneText)

  const assignmentId = `preflight:${input.reviewId}`
  const assignmentPath = join(
    manifest.authority_paths.assignment_root,
    'reviews',
    `${sha256(input.reviewId)}.preflight.json`,
  )
  const verdictPath = join(
    manifest.authority_paths.assignment_root,
    'outputs',
    `${sha256(assignmentId)}.json`,
  )
  const reviewInputHash = sha256(`autolab-preflight-review-input-v1\0${canonicalJson({
    review_id: input.reviewId,
    lab_id: manifest.lab_id,
    source_revision: input.frozen.ref.revision,
    resolved_manifest_sha256: input.frozen.ref.manifestHash,
    runtime_revision: input.runtimeRevision,
    issued_at: input.issuedAt,
    judge: {
      role_id: judge.roleId,
      session_id: input.judgeSessionId,
      binding_path: input.judgeBinding.path,
      binding_sha256: input.judgeBinding.hash,
    },
    source_method_assignment: input.sourceMethodAssignment,
    source_method_packet: input.sourceMethodPacket,
    design_ticket: input.designTicket,
  })}`)
  const outputContract = {
    schema: preflightVerdictSchema({
      reviewId: input.reviewId,
      assignmentId,
      reviewInputHash,
    }),
    receipt_path: verdictPath,
    expected_hash_binding: reviewInputHash,
  }
  const assignmentText = canonicalJson({
    version: 1,
    assignment_type: 'preflight_review',
    review_id: input.reviewId,
    assignment_id: assignmentId,
    runtime_revision: input.runtimeRevision,
    issued_at: input.issuedAt,
    review_input_sha256: reviewInputHash,
    judge: {
      role_id: judge.roleId,
      session_id: input.judgeSessionId,
      binding_path: input.judgeBinding.path,
      binding_sha256: input.judgeBinding.hash,
    },
    source_method: {
      role_id: sourcePacket.header.role_id,
      session_id: sourcePacket.header.session_id,
      assignment: artifactRef('source-method-assignment', input.sourceMethodAssignment),
      packet: artifactRef('source-method-packet', input.sourceMethodPacket),
    },
    design_ticket: artifactRef('design-ticket', input.designTicket),
    instruction: 'Review the exact submitted method under this Lab\'s anchored original contract. Do not add unrelated gates. Return the declared output contract.',
    output_contract: outputContract,
  })
  const assignmentHash = await freezeExact(assignmentPath, assignmentText)
  const factAnchor = await currentFactAnchor(manifest.authority_paths.fact_set)

  const packet = compileRolePacket({
    manifest,
    role_id: judge.roleId,
    session_id: input.judgeSessionId,
    assignment_id: assignmentId,
    issued_at: input.issuedAt,
    role_binding_receipt_sha256: input.judgeBinding.hash,
    runtime_revision: input.runtimeRevision,
    fact_set_sha256: factAnchor.factSetSha256,
    evidence_index_sha256: sourcePacket.anchors.evidence_index_sha256,
    assignment_contract_sha256: assignmentHash,
    reveal_state: sourcePacket.runtime_snapshot.reveal_state,
    verbatim_blocks: {
      universal: [{
        block_id: 'lab-spec',
        source_path: manifest.authority_paths.lab_spec,
        exact_text: input.frozen.spec,
        text_sha256: input.frozen.ref.specHash,
      }],
      role: [{
        block_id: 'role-prompt',
        source_path: promptPath,
        exact_text: prompt.text,
        text_sha256: prompt.sha256,
      }],
      lane: [{
        block_id: 'lane-charter',
        source_path: lanePath,
        exact_text: laneText,
        text_sha256: judge.charter.charter_sha256,
      }],
      stage: [],
      assignment: [{
        block_id: 'preflight-review-assignment',
        source_path: assignmentPath,
        exact_text: assignmentText,
        text_sha256: assignmentHash,
      }],
    },
    ...(sourcePacket.runtime_snapshot.incumbent === undefined
      ? {}
      : { incumbent: sourcePacket.runtime_snapshot.incumbent }),
    relevant_fact_refs: [
      ...sourcePacket.runtime_snapshot.relevant_fact_refs.filter(ref => ref.id !== 'fact-set'),
      ...factAnchor.relevantFactRefs,
    ],
    evidence_refs: sourcePacket.runtime_snapshot.evidence_refs,
    open_obligation_refs: sourcePacket.runtime_snapshot.open_obligation_refs,
    input_artifact_refs: [
      artifactRef('design-ticket', input.designTicket),
      artifactRef('source-method-assignment', input.sourceMethodAssignment),
      artifactRef('source-method-packet', input.sourceMethodPacket),
    ],
    output_contract: outputContract,
  })
  const packetPath = join(
    manifest.authority_paths.lab_dir,
    'packets',
    sha256(assignmentId),
    `${sha256(judge.roleId)}.json`,
  )
  const packetHash = await freezeExact(packetPath, packet.canonicalJson)
  if (packetHash !== packet.packetHash) {
    throw new PreflightReviewArtifactError(
      'Preflight Role Packet file hash changed while committing',
      'ARTIFACT_CONFLICT',
    )
  }

  return {
    reviewId: input.reviewId,
    assignmentId,
    reviewInputHash,
    assignmentPath,
    assignmentHash,
    assignmentText,
    verdictPath,
    packetPath,
    packet,
  }
}

function validateScalarInput(input: FreezePreflightReviewArtifactsInput): void {
  if (input.reviewId.trim().length === 0 || input.judgeSessionId.trim().length === 0) {
    throw new PreflightReviewArtifactError('reviewId and Judge SessionId must be non-empty', 'INVALID_INPUT')
  }
  if (!Number.isSafeInteger(input.runtimeRevision) || input.runtimeRevision < 0
    || !Number.isSafeInteger(input.issuedAt) || input.issuedAt < 0) {
    throw new PreflightReviewArtifactError(
      'runtimeRevision and issuedAt must be non-negative safe integers',
      'INVALID_INPUT',
    )
  }
  validateRef(input.sourceMethodAssignment, 'source Method Assignment')
  validateRef(input.sourceMethodPacket, 'source Method Packet')
  validateRef(input.designTicket, 'Design Ticket')
}

function validateRef(reference: FrozenArtifactReference, label: string): void {
  if (!isAbsolute(reference.path) || !SHA256_PATTERN.test(reference.sha256)) {
    throw new PreflightReviewArtifactError(
      `${label} requires an absolute path and SHA-256`,
      'INVALID_INPUT',
    )
  }
}

function assertFrozenRevision(frozen: FrozenRevision): void {
  const manifestHash = sha256(canonicalJson(frozen.manifest))
  if (sha256(frozen.spec) !== frozen.ref.specHash
    || sha256(frozen.config) !== frozen.ref.configHash
    || manifestHash !== frozen.ref.manifestHash
    || frozen.validation.specHash !== frozen.ref.specHash
    || frozen.validation.configHash !== frozen.ref.configHash
    || frozen.validation.manifestHash !== frozen.ref.manifestHash
    || frozen.validation.dialogueHeadHash !== frozen.ref.dialogueHeadHash
    || frozen.manifest.source_revision !== frozen.ref.revision
    || frozen.manifest.anchors.dialogue_head_sha256 !== frozen.ref.dialogueHeadHash
    || frozen.manifest.anchors.lab_spec_sha256 !== frozen.ref.specHash
    || frozen.manifest.anchors.lab_yaml_sha256 !== frozen.ref.configHash) {
    throw new PreflightReviewArtifactError(
      'FrozenRevision does not match its CURRENT hashes',
      'CURRENT_MISMATCH',
    )
  }
}

async function resolveJudge(input: FreezePreflightReviewArtifactsInput): Promise<{
  roleId: string
  laneId: string
  methodRoleId: string
  charter: FrozenRevision['manifest']['search']['lane_charters'][number]
}> {
  const receipt = input.judgeBinding.receipt
  const stored = await readRoleBinding(input.frozen.manifest.authority_paths.lab_dir, receipt.roleId)
  if (stored === undefined
    || stored.path !== input.judgeBinding.path
    || stored.hash !== input.judgeBinding.hash
    || canonicalJson(stored.receipt) !== canonicalJson(receipt)
    || receipt.receiptHash !== input.judgeBinding.hash
    || receipt.labId !== input.frozen.manifest.lab_id
    || receipt.manifestHash !== input.frozen.ref.manifestHash
    || receipt.roleKind !== 'preflight_judge'
    || receipt.sessionId !== input.judgeSessionId) {
    throw new PreflightReviewArtifactError(
      'Judge Session does not match its frozen RoleBindingReceipt and CURRENT',
      'JUDGE_BINDING_MISMATCH',
    )
  }

  const role = input.frozen.manifest.roles.find(candidate => candidate.role_id === receipt.roleId)
  if (role?.role_kind !== 'preflight_judge') {
    throw new PreflightReviewArtifactError('Judge role is not a Preflight Judge', 'JUDGE_BINDING_MISMATCH')
  }
  const sessionSpec = resolveRootRoleSessionSpec(input.frozen.manifest, role.role_id)
  if (receipt.permissionPresetId !== role.dsh_preset
    || receipt.provider !== role.model_route.provider
    || receipt.model !== role.model_route.model
    || receipt.cwd !== sessionSpec.cwd) {
    throw new PreflightReviewArtifactError(
      'Judge RoleBindingReceipt does not match CURRENT role capabilities',
      'JUDGE_BINDING_MISMATCH',
    )
  }
  const lane = input.frozen.manifest.lanes.find(candidate => (
    candidate.lane_id === role.lane_id
    && candidate.preflight_judge_role_id === role.role_id
  ))
  const charter = input.frozen.manifest.search.lane_charters.find(candidate => (
    candidate.lane_id === role.lane_id
  ))
  if (lane === undefined || charter === undefined) {
    throw new PreflightReviewArtifactError(
      'Preflight Judge does not resolve to one CURRENT Lane',
      'JUDGE_BINDING_MISMATCH',
    )
  }
  return {
    roleId: role.role_id,
    laneId: role.lane_id,
    methodRoleId: lane.method_role_id,
    charter,
  }
}

async function readSourceMethodPacket(reference: FrozenArtifactReference): Promise<RolePacket> {
  const bytes = await readExactBytes(reference, 'source Method Packet')
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new PreflightReviewArtifactError('source Method Packet is not JSON', 'SOURCE_PACKET_MISMATCH')
  }
  let packet: RolePacket
  try {
    packet = parseRolePacket(value)
  } catch {
    throw new PreflightReviewArtifactError(
      'source Method Packet does not satisfy Role Packet v1',
      'SOURCE_PACKET_MISMATCH',
    )
  }
  if (sha256(canonicalJson(packet)) !== reference.sha256) {
    throw new PreflightReviewArtifactError(
      'source Method Packet is not the exact canonical frozen packet',
      'SOURCE_PACKET_MISMATCH',
    )
  }
  return packet
}

function assertSourceMethodPacket(
  packet: RolePacket,
  sourceAssignment: FrozenArtifactReference,
  frozen: FrozenRevision,
  laneId: string,
  methodRoleId: string,
): void {
  if (packet.header.lab_id !== frozen.manifest.lab_id
    || packet.header.lane_id !== laneId
    || packet.header.role_id !== methodRoleId
    || packet.header.role_kind !== 'method'
    || packet.anchors.source_revision !== frozen.ref.revision
    || packet.anchors.dialogue_head_sha256 !== frozen.ref.dialogueHeadHash
    || packet.anchors.lab_spec_sha256 !== frozen.ref.specHash
    || packet.anchors.lab_yaml_sha256 !== frozen.ref.configHash
    || packet.anchors.resolved_manifest_sha256 !== frozen.ref.manifestHash
    || packet.anchors.assignment_contract_sha256 !== sourceAssignment.sha256) {
    throw new PreflightReviewArtifactError(
      'source Method Packet does not bind this CURRENT Lane and Assignment',
      'SOURCE_PACKET_MISMATCH',
    )
  }
}

function artifactRef(artifactId: string, reference: FrozenArtifactReference): {
  artifact_id: string
  path: string
  sha256: string
} {
  return { artifact_id: artifactId, path: reference.path, sha256: reference.sha256 }
}

function preflightVerdictSchema(input: {
  reviewId: string
  assignmentId: string
  reviewInputHash: string
}): JsonValue {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'version',
      'review_id',
      'assignment_id',
      'review_input_sha256',
      'top_level_verdict',
      'blocking_findings',
      'reasons',
      'warnings',
    ],
    properties: {
      version: { const: 1 },
      review_id: { const: input.reviewId },
      assignment_id: { const: input.assignmentId },
      review_input_sha256: { const: input.reviewInputHash },
      top_level_verdict: {
        enum: ['APPROVED', 'REVISION_REQUIRED', 'REJECTED', 'REVIEW_ERROR'],
      },
      blocking_findings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['rule_or_frozen_field', 'blocked_transition', 'conflict_or_missing_evidence'],
          properties: {
            rule_or_frozen_field: { type: 'string', minLength: 1 },
            blocked_transition: { type: 'string', minLength: 1 },
            conflict_or_missing_evidence: { type: 'string', minLength: 1 },
          },
        },
      },
      reasons: { type: 'array', items: { type: 'string', minLength: 1 } },
      warnings: { type: 'array', items: { type: 'string', minLength: 1 } },
    },
  }
}

async function assertExactInput(
  reference: FrozenArtifactReference,
  label: string,
  expectedText?: string,
): Promise<void> {
  const bytes = await readExactBytes(reference, label)
  if (expectedText !== undefined && !bytes.equals(Buffer.from(expectedText, 'utf8'))) {
    throw new PreflightReviewArtifactError(
      `${label} bytes differ from the supplied frozen authority`,
      'INPUT_HASH_MISMATCH',
    )
  }
}

async function readExactBytes(reference: FrozenArtifactReference, label: string): Promise<Buffer> {
  let bytes: Buffer
  try {
    bytes = await readFile(reference.path)
  } catch {
    throw new PreflightReviewArtifactError(`${label} cannot be read`, 'INPUT_HASH_MISMATCH')
  }
  if (sha256(bytes) !== reference.sha256) {
    throw new PreflightReviewArtifactError(`${label} SHA-256 mismatch`, 'INPUT_HASH_MISMATCH')
  }
  return bytes
}

async function freezeExact(path: string, bytes: string): Promise<string> {
  const existing = await readFile(path, 'utf8').catch(error => {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined
    throw error
  })
  if (existing === undefined) {
    try {
      await durableWriteFile(path, bytes, false)
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') throw error
    }
  }
  const committed = await readFile(path, 'utf8')
  if (committed !== bytes) {
    throw new PreflightReviewArtifactError(
      `Immutable Preflight review artifact conflicts at ${path}`,
      'ARTIFACT_CONFLICT',
    )
  }
  return sha256(committed)
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}
