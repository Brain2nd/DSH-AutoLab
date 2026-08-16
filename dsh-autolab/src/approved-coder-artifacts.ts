import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

import { durableWriteFile, type FrozenRevision } from './artifacts.js'
import { readRoleBinding, type StoredRoleBinding } from './binding.js'
import { coderImplementationReportOutputSchema } from './coder-receipt.js'
import { currentFactAnchor } from './fact-registry.js'
import { canonicalJson, sha256 } from './integrity.js'
import {
  METHOD_TICKET_HASH_BINDING,
  methodDesignTicketOutputSchema,
  parseMethodDesignTicket,
  type MethodDesignTicket,
} from './method-ticket.js'
import {
  compileRolePacket,
  parseRolePacket,
  type CompiledRolePacket,
  type RolePacket,
} from './packet.js'
import { parsePreflightVerdict, type PreflightVerdict } from './preflight-verdict.js'
import {
  resolveRootRoleSessionSpec,
  rolePromptFor,
  type RootRoleBinding,
} from './roles.js'
import type { InitialRoleArtifacts } from './activation-artifacts.js'

const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export interface ApprovedCoderArtifactReference {
  readonly path: string
  readonly sha256: string
}

export interface FreezeApprovedCoderArtifactsInput {
  /** The exact revision already read and verified through CURRENT. */
  readonly frozen: FrozenRevision
  readonly coderRole: RootRoleBinding
  readonly coderSessionId: string
  readonly coderBinding: StoredRoleBinding
  readonly sourceMethodPacket: ApprovedCoderArtifactReference
  readonly designTicket: ApprovedCoderArtifactReference
  readonly preflightVerdict: ApprovedCoderArtifactReference
  readonly reviewId: string
  readonly runtimeRevision: number
  readonly issuedAt: number
}

export class ApprovedCoderArtifactError extends Error {
  readonly name = 'ApprovedCoderArtifactError'

  constructor(
    message: string,
    readonly code:
      | 'INVALID_INPUT'
      | 'CURRENT_MISMATCH'
      | 'CODER_BINDING_MISMATCH'
      | 'SOURCE_PACKET_MISMATCH'
      | 'DESIGN_TICKET_MISMATCH'
      | 'PREFLIGHT_VERDICT_MISMATCH'
      | 'ARTIFACT_CONFLICT',
  ) {
    super(message)
  }
}

/**
 * Compile the exact APPROVED Preflight transition into one immutable Coder
 * Assignment and Role Packet. This is a byte/hash compiler only: it never asks
 * a model to summarize the Ticket or introduces another admission decision.
 */
export async function freezeApprovedCoderArtifacts(
  input: FreezeApprovedCoderArtifactsInput,
): Promise<InitialRoleArtifacts> {
  validateScalarInput(input)
  await assertFrozenRevision(input.frozen)

  const manifest = input.frozen.manifest
  const target = await resolveCoder(input)
  const sourcePacket = await readSourceMethodPacket(input.sourceMethodPacket)
  const sourceAssignment = await assertSourceMethodPacket(
    input,
    sourcePacket,
    target.laneId,
    target.methodRoleId,
  )
  const ticket = await readDesignTicket(input, sourcePacket)
  const verdict = await readApprovedVerdict(input)
  await assertApprovedReviewChain(
    input,
    sourcePacket,
    sourceAssignment,
    verdict,
    target.preflightJudgeRoleId,
  )
  const [ticketText, verdictText] = await Promise.all([
    readExactText(input.designTicket, 'Design Ticket', 'DESIGN_TICKET_MISMATCH'),
    readExactText(input.preflightVerdict, 'Preflight verdict', 'PREFLIGHT_VERDICT_MISMATCH'),
  ])

  const prompt = rolePromptFor('coder')
  const promptPath = join(
    manifest.authority_paths.lab_dir,
    'artifacts',
    'builtins',
    `${prompt.sha256}.txt`,
  )
  await freezeExact(promptPath, prompt.text)

  const laneText = canonicalJson(target.charter.content)
  if (sha256(laneText) !== target.charter.charter_sha256) {
    throw new ApprovedCoderArtifactError(
      'LaneCharter bytes do not match CURRENT ResolvedManifest',
      'CURRENT_MISMATCH',
    )
  }
  const lanePath = join(
    manifest.authority_paths.lab_dir,
    'artifacts',
    'lanes',
    `${sha256(target.laneId)}.charter.json`,
  )
  await freezeExact(lanePath, laneText)

  const assignmentId = `coder:${input.reviewId}`
  const objectiveBody = [
    'Implement only the exact APPROVED Design Ticket bound by this Assignment in the Lane worktree.',
    'Do not change, reinterpret, or replace the approved method during implementation, including with an unapproved substitute that appears easier to code.',
    'If implementation requires a method change outside the approved variation space, stop and return it to Method Maker and Preflight; do not improvise the change in this Session.',
    'Write only the narrow implementation report declared by the output contract, then call SubmitCoderImplementation with no arguments; AutoLab derives and freezes all code and Controller identities mechanically.',
  ].join('\n')
  const assignmentPath = join(
    manifest.authority_paths.assignment_root,
    'coder',
    `${sha256(assignmentId)}.json`,
  )
  const receiptPath = join(
    manifest.authority_paths.assignment_root,
    'outputs',
    `${sha256(assignmentId)}.json`,
  )
  const outputContract = {
    schema: coderImplementationReportOutputSchema(),
    receipt_path: receiptPath,
    expected_hash_binding: assignmentId,
  }
  const assignmentText = canonicalJson({
    version: 1,
    assignment_type: 'approved_coder_implementation',
    assignment_id: assignmentId,
    review_id: input.reviewId,
    runtime_revision: input.runtimeRevision,
    issued_at: input.issuedAt,
    coder: {
      role_id: target.roleId,
      session_id: input.coderSessionId,
      binding_path: input.coderBinding.path,
      binding_sha256: input.coderBinding.hash,
    },
    source_method: {
      role_id: sourcePacket.header.role_id,
      session_id: sourcePacket.header.session_id,
      packet: artifactRef('source-method-packet', input.sourceMethodPacket),
    },
    design_ticket: {
      ...artifactRef('design-ticket', input.designTicket),
      candidate_id: ticket.candidate_id,
    },
    preflight_approval: {
      ...artifactRef('preflight-verdict', input.preflightVerdict),
      judge_assignment_id: verdict.assignment_id,
      review_input_sha256: verdict.review_input_sha256,
      top_level_verdict: verdict.top_level_verdict,
    },
    objective: objectiveBody,
    output_contract: outputContract,
  })
  const assignmentHash = await freezeExact(assignmentPath, assignmentText)
  const factAnchor = await currentFactAnchor(manifest.authority_paths.fact_set)

  const packet = compileRolePacket({
    manifest,
    role_id: target.roleId,
    session_id: input.coderSessionId,
    assignment_id: assignmentId,
    issued_at: input.issuedAt,
    role_binding_receipt_sha256: input.coderBinding.hash,
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
        text_sha256: target.charter.charter_sha256,
      }],
      stage: [{
        block_id: 'approved-method-design-ticket',
        source_path: input.designTicket.path,
        exact_text: ticketText,
        text_sha256: input.designTicket.sha256,
      }, {
        block_id: 'preflight-approved-verdict',
        source_path: input.preflightVerdict.path,
        exact_text: verdictText,
        text_sha256: input.preflightVerdict.sha256,
      }],
      assignment: [{
        block_id: 'approved-coder-assignment',
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
      artifactRef('source-method-packet', input.sourceMethodPacket),
      artifactRef('design-ticket', input.designTicket),
      artifactRef('preflight-verdict', input.preflightVerdict),
    ],
    output_contract: outputContract,
  })
  const packetPath = join(
    manifest.authority_paths.lab_dir,
    'packets',
    sha256(assignmentId),
    `${sha256(target.roleId)}.json`,
  )
  const packetHash = await freezeExact(packetPath, packet.canonicalJson)
  if (packetHash !== packet.packetHash) {
    throw new ApprovedCoderArtifactError(
      'Coder Role Packet file hash changed while committing',
      'ARTIFACT_CONFLICT',
    )
  }

  return {
    assignmentId,
    assignmentPath,
    assignmentHash,
    objectiveBody,
    packetPath,
    packet,
  }
}

function validateScalarInput(input: FreezeApprovedCoderArtifactsInput): void {
  if (input.reviewId.trim().length === 0
    || input.coderSessionId.trim().length === 0
    || input.reviewId === '.'
    || input.reviewId === '..'
    || input.reviewId.includes('/')
    || input.reviewId.includes('\\')
    || input.reviewId.includes('\0')) {
    throw new ApprovedCoderArtifactError(
      'reviewId must be one non-empty path-safe identity and Coder SessionId must be non-empty',
      'INVALID_INPUT',
    )
  }
  if (!Number.isSafeInteger(input.runtimeRevision) || input.runtimeRevision < 0
    || !Number.isSafeInteger(input.issuedAt) || input.issuedAt < 0) {
    throw new ApprovedCoderArtifactError(
      'runtimeRevision and issuedAt must be non-negative safe integers',
      'INVALID_INPUT',
    )
  }
  validateReference(input.sourceMethodPacket, 'source Method Packet')
  validateReference(input.designTicket, 'Design Ticket')
  validateReference(input.preflightVerdict, 'Preflight verdict')
}

function validateReference(reference: ApprovedCoderArtifactReference, label: string): void {
  if (!isAbsolute(reference.path) || !SHA256_PATTERN.test(reference.sha256)) {
    throw new ApprovedCoderArtifactError(
      `${label} requires an absolute path and SHA-256`,
      'INVALID_INPUT',
    )
  }
}

async function assertFrozenRevision(frozen: FrozenRevision): Promise<void> {
  const manifest = frozen.manifest
  const manifestText = canonicalJson(manifest)
  if (sha256(frozen.spec) !== frozen.ref.specHash
    || sha256(frozen.config) !== frozen.ref.configHash
    || sha256(manifestText) !== frozen.ref.manifestHash
    || frozen.validation.specHash !== frozen.ref.specHash
    || frozen.validation.configHash !== frozen.ref.configHash
    || frozen.validation.manifestHash !== frozen.ref.manifestHash
    || frozen.validation.dialogueHeadHash !== frozen.ref.dialogueHeadHash
    || manifest.source_revision !== frozen.ref.revision
    || manifest.anchors.dialogue_head_sha256 !== frozen.ref.dialogueHeadHash
    || manifest.anchors.lab_spec_sha256 !== frozen.ref.specHash
    || manifest.anchors.lab_yaml_sha256 !== frozen.ref.configHash) {
    throw new ApprovedCoderArtifactError(
      'FrozenRevision does not match its CURRENT hashes',
      'CURRENT_MISMATCH',
    )
  }
  await assertExactAuthority(
    manifest.authority_paths.lab_spec,
    frozen.spec,
    'CURRENT LAB_SPEC',
  )
  await assertExactAuthority(
    manifest.authority_paths.lab_yaml,
    frozen.config,
    'CURRENT lab.yaml',
  )
  await assertExactAuthority(
    manifest.authority_paths.resolved_manifest,
    manifestText,
    'CURRENT ResolvedManifest',
  )
}

async function resolveCoder(input: FreezeApprovedCoderArtifactsInput): Promise<{
  readonly roleId: string
  readonly laneId: string
  readonly methodRoleId: string
  readonly preflightJudgeRoleId: string
  readonly charter: FrozenRevision['manifest']['search']['lane_charters'][number]
}> {
  const manifest = input.frozen.manifest
  const currentRole = manifest.roles.find(candidate => candidate.role_id === input.coderRole.role_id)
  if (currentRole?.role_kind !== 'coder'
    || input.coderRole.role_kind !== 'coder'
    || canonicalJson(currentRole) !== canonicalJson(input.coderRole)) {
    throw new ApprovedCoderArtifactError(
      'target role is not the exact CURRENT Coder role',
      'CODER_BINDING_MISMATCH',
    )
  }
  const lane = manifest.lanes.find(candidate => (
    candidate.lane_id === currentRole.lane_id
    && candidate.coder_role_id === currentRole.role_id
  ))
  const charter = manifest.search.lane_charters.find(candidate => (
    candidate.lane_id === currentRole.lane_id
  ))
  if (lane === undefined || charter === undefined) {
    throw new ApprovedCoderArtifactError(
      'target Coder does not resolve to one CURRENT Lane',
      'CODER_BINDING_MISMATCH',
    )
  }

  const stored = await readRoleBinding(manifest.authority_paths.lab_dir, currentRole.role_id)
  const receipt = input.coderBinding.receipt
  const sessionSpec = resolveRootRoleSessionSpec(manifest, currentRole.role_id)
  if (stored === undefined
    || stored.path !== input.coderBinding.path
    || stored.hash !== input.coderBinding.hash
    || canonicalJson(stored.receipt) !== canonicalJson(receipt)
    || receipt.receiptHash !== input.coderBinding.hash
    || receipt.labId !== manifest.lab_id
    || receipt.manifestHash !== input.frozen.ref.manifestHash
    || receipt.roleId !== currentRole.role_id
    || receipt.roleKind !== 'coder'
    || receipt.sessionId !== input.coderSessionId
    || receipt.permissionPresetId !== currentRole.dsh_preset
    || receipt.provider !== currentRole.model_route.provider
    || receipt.model !== currentRole.model_route.model
    || receipt.cwd !== sessionSpec.cwd
    || receipt.runtimeRevision > input.runtimeRevision) {
    throw new ApprovedCoderArtifactError(
      'Coder Session does not match its frozen RoleBindingReceipt and CURRENT',
      'CODER_BINDING_MISMATCH',
    )
  }
  return {
    roleId: currentRole.role_id,
    laneId: currentRole.lane_id,
    methodRoleId: lane.method_role_id,
    preflightJudgeRoleId: lane.preflight_judge_role_id,
    charter,
  }
}

async function readSourceMethodPacket(
  reference: ApprovedCoderArtifactReference,
): Promise<RolePacket> {
  const bytes = await readExactBytes(reference, 'source Method Packet', 'SOURCE_PACKET_MISMATCH')
  let text: string
  let value: unknown
  try {
    text = UTF8.decode(bytes)
    value = JSON.parse(text)
  } catch {
    throw new ApprovedCoderArtifactError(
      'source Method Packet is not valid UTF-8 JSON',
      'SOURCE_PACKET_MISMATCH',
    )
  }
  let packet: RolePacket
  try {
    packet = parseRolePacket(value)
  } catch {
    throw new ApprovedCoderArtifactError(
      'source Method Packet does not satisfy Role Packet v1',
      'SOURCE_PACKET_MISMATCH',
    )
  }
  if (canonicalJson(packet) !== text) {
    throw new ApprovedCoderArtifactError(
      'source Method Packet is not the exact canonical frozen packet',
      'SOURCE_PACKET_MISMATCH',
    )
  }
  return packet
}

async function assertSourceMethodPacket(
  input: FreezeApprovedCoderArtifactsInput,
  packet: RolePacket,
  laneId: string,
  methodRoleId: string,
): Promise<ApprovedCoderArtifactReference> {
  const manifest = input.frozen.manifest
  const expectedPath = join(
    manifest.authority_paths.lab_dir,
    'packets',
    sha256(packet.header.assignment_id),
    `${sha256(methodRoleId)}.json`,
  )
  if (input.sourceMethodPacket.path !== expectedPath
    || packet.header.lab_id !== manifest.lab_id
    || packet.header.lane_id !== laneId
    || packet.header.role_id !== methodRoleId
    || packet.header.role_kind !== 'method'
    || packet.anchors.source_revision !== input.frozen.ref.revision
    || packet.anchors.dialogue_head_sha256 !== input.frozen.ref.dialogueHeadHash
    || packet.anchors.lab_spec_sha256 !== input.frozen.ref.specHash
    || packet.anchors.lab_yaml_sha256 !== input.frozen.ref.configHash
    || packet.anchors.resolved_manifest_sha256 !== input.frozen.ref.manifestHash
    || packet.anchors.campaign_contract_sha256 !== manifest.campaign_contract_sha256
    || packet.output_contract.expected_hash_binding !== METHOD_TICKET_HASH_BINDING
    || canonicalJson(packet.output_contract.schema)
      !== canonicalJson(methodDesignTicketOutputSchema())) {
    throw new ApprovedCoderArtifactError(
      'source Method Packet does not bind this CURRENT Lane, path, and output contract',
      'SOURCE_PACKET_MISMATCH',
    )
  }

  let recompiled: CompiledRolePacket
  try {
    recompiled = compileRolePacket({
      manifest,
      role_id: packet.header.role_id,
      session_id: packet.header.session_id,
      assignment_id: packet.header.assignment_id,
      issued_at: packet.header.issued_at,
      role_binding_receipt_sha256: packet.anchors.role_binding_receipt_sha256,
      runtime_revision: packet.anchors.runtime_revision,
      fact_set_sha256: packet.anchors.fact_set_sha256,
      evidence_index_sha256: packet.anchors.evidence_index_sha256,
      assignment_contract_sha256: packet.anchors.assignment_contract_sha256,
      reveal_state: packet.runtime_snapshot.reveal_state,
      verbatim_blocks: packet.verbatim_blocks,
      ...(packet.runtime_snapshot.incumbent === undefined
        ? {}
        : { incumbent: packet.runtime_snapshot.incumbent }),
      relevant_fact_refs: packet.runtime_snapshot.relevant_fact_refs,
      evidence_refs: packet.runtime_snapshot.evidence_refs,
      open_obligation_refs: packet.runtime_snapshot.open_obligation_refs,
      input_artifact_refs: packet.runtime_snapshot.input_artifact_refs,
      output_contract: packet.output_contract,
    })
  } catch {
    throw new ApprovedCoderArtifactError(
      'source Method Packet cannot be reproduced from CURRENT',
      'SOURCE_PACKET_MISMATCH',
    )
  }
  if (recompiled.canonicalJson !== canonicalJson(packet)
    || recompiled.packetHash !== input.sourceMethodPacket.sha256) {
    throw new ApprovedCoderArtifactError(
      'source Method Packet manifest-derived fields drifted from CURRENT',
      'SOURCE_PACKET_MISMATCH',
    )
  }

  const universal = packet.verbatim_blocks.universal.filter(block => (
    block.source_path === manifest.authority_paths.lab_spec
    && block.exact_text === input.frozen.spec
    && block.text_sha256 === input.frozen.ref.specHash
  ))
  const assignment = packet.verbatim_blocks.assignment.filter(block => (
    block.text_sha256 === packet.anchors.assignment_contract_sha256
    && isWithin(manifest.authority_paths.assignment_root, block.source_path)
  ))
  if (universal.length !== 1 || assignment.length !== 1) {
    throw new ApprovedCoderArtifactError(
      'source Method Packet does not bind one exact CURRENT LAB_SPEC and Assignment',
      'SOURCE_PACKET_MISMATCH',
    )
  }
  await assertExactAuthority(
    assignment[0]!.source_path,
    assignment[0]!.exact_text,
    'source Method Assignment',
    'SOURCE_PACKET_MISMATCH',
  )
  return {
    path: assignment[0]!.source_path,
    sha256: assignment[0]!.text_sha256,
  }
}

async function readDesignTicket(
  input: FreezeApprovedCoderArtifactsInput,
  packet: RolePacket,
): Promise<MethodDesignTicket> {
  const expectedPath = join(
    input.frozen.manifest.authority_paths.lab_dir,
    'artifacts',
    'reviews',
    input.reviewId,
    'method-ticket.json',
  )
  if (input.designTicket.path !== expectedPath) {
    throw new ApprovedCoderArtifactError(
      'Design Ticket path does not match the frozen review identity',
      'DESIGN_TICKET_MISMATCH',
    )
  }
  const bytes = await readExactBytes(
    input.designTicket,
    'Design Ticket',
    'DESIGN_TICKET_MISMATCH',
  )
  let ticket: MethodDesignTicket
  try {
    ticket = parseMethodDesignTicket(JSON.parse(UTF8.decode(bytes)) as unknown)
  } catch {
    throw new ApprovedCoderArtifactError(
      'Design Ticket does not satisfy the strict Method Design Ticket schema',
      'DESIGN_TICKET_MISMATCH',
    )
  }
  if (ticket.assignment_id !== packet.header.assignment_id
    || ticket.assignment_contract_sha256 !== packet.anchors.assignment_contract_sha256
    || ticket.role_packet_sha256 !== input.sourceMethodPacket.sha256) {
    throw new ApprovedCoderArtifactError(
      'Design Ticket hash bindings do not match the source Method Packet',
      'DESIGN_TICKET_MISMATCH',
    )
  }

  return ticket
}

async function readApprovedVerdict(
  input: FreezeApprovedCoderArtifactsInput,
): Promise<PreflightVerdict> {
  const expectedPath = join(
    input.frozen.manifest.authority_paths.lab_dir,
    'artifacts',
    'reviews',
    input.reviewId,
    'preflight-verdict.json',
  )
  if (input.preflightVerdict.path !== expectedPath) {
    throw new ApprovedCoderArtifactError(
      'Preflight verdict path does not match the frozen review identity',
      'PREFLIGHT_VERDICT_MISMATCH',
    )
  }
  const bytes = await readExactBytes(
    input.preflightVerdict,
    'Preflight verdict',
    'PREFLIGHT_VERDICT_MISMATCH',
  )
  let verdict: PreflightVerdict
  try {
    verdict = parsePreflightVerdict(JSON.parse(UTF8.decode(bytes)) as unknown)
  } catch {
    throw new ApprovedCoderArtifactError(
      'Preflight verdict does not satisfy the strict receipt schema',
      'PREFLIGHT_VERDICT_MISMATCH',
    )
  }
  if (verdict.review_id !== input.reviewId
    || verdict.assignment_id !== `preflight:${input.reviewId}`
    || verdict.top_level_verdict !== 'APPROVED') {
    throw new ApprovedCoderArtifactError(
      'Preflight verdict is not the APPROVED receipt for this review',
      'PREFLIGHT_VERDICT_MISMATCH',
    )
  }
  return verdict
}

async function assertApprovedReviewChain(
  input: FreezeApprovedCoderArtifactsInput,
  sourcePacket: RolePacket,
  sourceAssignment: ApprovedCoderArtifactReference,
  verdict: PreflightVerdict,
  preflightJudgeRoleId: string,
): Promise<void> {
  const manifest = input.frozen.manifest
  const assignmentPath = join(
    manifest.authority_paths.assignment_root,
    'reviews',
    `${sha256(input.reviewId)}.preflight.json`,
  )
  let bytes: Buffer
  try {
    bytes = await readFile(assignmentPath)
  } catch {
    throw new ApprovedCoderArtifactError(
      'frozen Preflight Assignment cannot be read',
      'PREFLIGHT_VERDICT_MISMATCH',
    )
  }
  let text: string
  let value: unknown
  try {
    text = UTF8.decode(bytes)
    value = JSON.parse(text)
  } catch {
    throw new ApprovedCoderArtifactError(
      'frozen Preflight Assignment is not valid UTF-8 JSON',
      'PREFLIGHT_VERDICT_MISMATCH',
    )
  }
  if (!isRecord(value)
    || canonicalJson(value) !== text
    || value.version !== 1
    || value.assignment_type !== 'preflight_review'
    || value.review_id !== input.reviewId
    || value.assignment_id !== verdict.assignment_id
    || value.review_input_sha256 !== verdict.review_input_sha256
    || !isNonNegativeSafeInteger(value.runtime_revision)
    || value.runtime_revision > input.runtimeRevision
    || !isNonNegativeSafeInteger(value.issued_at)) {
    throw new ApprovedCoderArtifactError(
      'frozen Preflight Assignment identity does not match the APPROVED verdict',
      'PREFLIGHT_VERDICT_MISMATCH',
    )
  }

  const judge = asRecord(value.judge)
  const sourceMethod = asRecord(value.source_method)
  const judgeRole = manifest.roles.find(candidate => candidate.role_id === preflightJudgeRoleId)
  if (judge === undefined
    || sourceMethod === undefined
    || judgeRole?.role_kind !== 'preflight_judge'
    || judge.role_id !== preflightJudgeRoleId
    || typeof judge.session_id !== 'string'
    || judge.session_id.length === 0
    || typeof judge.binding_path !== 'string'
    || !isAbsolute(judge.binding_path)
    || typeof judge.binding_sha256 !== 'string'
    || !SHA256_PATTERN.test(judge.binding_sha256)
    || sourceMethod.role_id !== sourcePacket.header.role_id
    || sourceMethod.session_id !== sourcePacket.header.session_id
    || !sameArtifactRef(sourceMethod.assignment, 'source-method-assignment', sourceAssignment)
    || !sameArtifactRef(
      sourceMethod.packet,
      'source-method-packet',
      input.sourceMethodPacket,
    )
    || !sameArtifactRef(value.design_ticket, 'design-ticket', input.designTicket)) {
    throw new ApprovedCoderArtifactError(
      'frozen Preflight Assignment does not bind the exact Method Packet and Design Ticket',
      'PREFLIGHT_VERDICT_MISMATCH',
    )
  }

  const judgeBinding = await readRoleBinding(manifest.authority_paths.lab_dir, preflightJudgeRoleId)
  const judgeSession = resolveRootRoleSessionSpec(manifest, preflightJudgeRoleId)
  if (judgeBinding === undefined
    || judgeBinding.path !== judge.binding_path
    || judgeBinding.hash !== judge.binding_sha256
    || judgeBinding.receipt.labId !== manifest.lab_id
    || judgeBinding.receipt.manifestHash !== input.frozen.ref.manifestHash
    || judgeBinding.receipt.roleId !== preflightJudgeRoleId
    || judgeBinding.receipt.roleKind !== 'preflight_judge'
    || judgeBinding.receipt.sessionId !== judge.session_id
    || judgeBinding.receipt.permissionPresetId !== judgeRole.dsh_preset
    || judgeBinding.receipt.provider !== judgeRole.model_route.provider
    || judgeBinding.receipt.model !== judgeRole.model_route.model
    || judgeBinding.receipt.cwd !== judgeSession.cwd) {
    throw new ApprovedCoderArtifactError(
      'frozen Preflight Assignment Judge binding drifted from CURRENT',
      'PREFLIGHT_VERDICT_MISMATCH',
    )
  }

  const reviewInputHash = sha256(`autolab-preflight-review-input-v1\0${canonicalJson({
    review_id: input.reviewId,
    lab_id: manifest.lab_id,
    source_revision: input.frozen.ref.revision,
    resolved_manifest_sha256: input.frozen.ref.manifestHash,
    runtime_revision: value.runtime_revision,
    issued_at: value.issued_at,
    judge: {
      role_id: judge.role_id,
      session_id: judge.session_id,
      binding_path: judge.binding_path,
      binding_sha256: judge.binding_sha256,
    },
    source_method_assignment: sourceAssignment,
    source_method_packet: input.sourceMethodPacket,
    design_ticket: input.designTicket,
  })}`)
  if (reviewInputHash !== verdict.review_input_sha256) {
    throw new ApprovedCoderArtifactError(
      'APPROVED verdict review-input hash does not bind the supplied frozen inputs',
      'PREFLIGHT_VERDICT_MISMATCH',
    )
  }
}

function artifactRef(
  artifactId: string,
  reference: ApprovedCoderArtifactReference,
): { readonly artifact_id: string; readonly path: string; readonly sha256: string } {
  return { artifact_id: artifactId, path: reference.path, sha256: reference.sha256 }
}

function sameTextMultiset(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false
  const counts = new Map<string, number>()
  for (const value of expected) counts.set(value, (counts.get(value) ?? 0) + 1)
  for (const value of actual) {
    const count = counts.get(value)
    if (count === undefined) return false
    if (count === 1) counts.delete(value)
    else counts.set(value, count - 1)
  }
  return counts.size === 0
}

function sameArtifactRef(
  value: unknown,
  artifactId: string,
  expected: ApprovedCoderArtifactReference,
): boolean {
  const record = asRecord(value)
  return record !== undefined
    && record.artifact_id === artifactId
    && record.path === expected.path
    && record.sha256 === expected.sha256
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isWithin(root: string, path: string): boolean {
  const child = relative(root, path)
  return child.length > 0
    && child !== '..'
    && !child.startsWith(`..${sep}`)
    && !isAbsolute(child)
}

async function readExactBytes(
  reference: ApprovedCoderArtifactReference,
  label: string,
  code: ApprovedCoderArtifactError['code'],
): Promise<Buffer> {
  let bytes: Buffer
  try {
    bytes = await readFile(reference.path)
  } catch {
    throw new ApprovedCoderArtifactError(`${label} cannot be read`, code)
  }
  if (sha256(bytes) !== reference.sha256) {
    throw new ApprovedCoderArtifactError(`${label} SHA-256 mismatch`, code)
  }
  return bytes
}

async function readExactText(
  reference: ApprovedCoderArtifactReference,
  label: string,
  code: 'DESIGN_TICKET_MISMATCH' | 'PREFLIGHT_VERDICT_MISMATCH',
): Promise<string> {
  const bytes = await readExactBytes(reference, label, code)
  try {
    return UTF8.decode(bytes)
  } catch {
    throw new ApprovedCoderArtifactError(`${label} is not valid UTF-8`, code)
  }
}

async function assertExactAuthority(
  path: string,
  expected: string,
  label: string,
  code: ApprovedCoderArtifactError['code'] = 'CURRENT_MISMATCH',
): Promise<void> {
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch {
    throw new ApprovedCoderArtifactError(`${label} cannot be read`, code)
  }
  if (!bytes.equals(Buffer.from(expected, 'utf8'))) {
    throw new ApprovedCoderArtifactError(`${label} bytes do not match their frozen anchor`, code)
  }
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
    throw new ApprovedCoderArtifactError(
      `Immutable Coder artifact conflicts at ${path}`,
      'ARTIFACT_CONFLICT',
    )
  }
  return sha256(committed)
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}
