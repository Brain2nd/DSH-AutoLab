import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

import { durableWriteFile, isCommittedManifestHash, readRevisionAtPath, type FrozenRevision } from './artifacts.js'
import type { StoredRoleBinding } from './binding.js'
import { canonicalJson, sha256 } from './integrity.js'
import {
  METHOD_TICKET_HASH_BINDING,
  methodDesignTicketOutputSchema,
} from './method-ticket.js'
import {
  compileRolePacket,
  parseRolePacket,
  type CompiledRolePacket,
  type RolePacket,
} from './packet.js'
import {
  resolveRootRoleSessionSpec,
  rolePromptFor,
  type RootRoleBinding,
} from './roles.js'

const EMPTY_FACT_SET = canonicalJson({ version: 1, facts: [] })
const EMPTY_EVIDENCE_INDEX = canonicalJson({ version: 1, evidence: [] })
const SHA256_PATTERN = /^[0-9a-f]{64}$/u

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export interface InitialRoleArtifacts {
  readonly assignmentId: string
  readonly assignmentPath: string
  readonly assignmentHash: string
  readonly objectiveBody: string
  readonly packetPath: string
  readonly packet: CompiledRolePacket
}

export interface FrozenPacketReference {
  readonly path: string
  readonly hash: string
}

export interface RestoreCurrentRoleArtifactsInput {
  readonly frozen: FrozenRevision
  readonly role: RootRoleBinding
  readonly sessionId: string
  readonly binding: StoredRoleBinding
  /** The RuntimeState revision observing this Packet; Packet revision may be older. */
  readonly runtimeRevision: number
  readonly packetRef: FrozenPacketReference
}

export class ActivationArtifactError extends Error {
  readonly name = 'ActivationArtifactError'

  constructor(
    message: string,
    readonly code: 'ROLE_NOT_FOUND' | 'ARTIFACT_CONFLICT' | 'LANE_NOT_FOUND',
  ) {
    super(message)
  }
}

/**
 * Compile immutable bootstrap packets directly from CURRENT and built-in exact
 * texts. No model summarizes or rewrites any input on this path.
 */
export async function freezeInitialRoleArtifacts(input: {
  frozen: FrozenRevision
  role: RootRoleBinding
  sessionId: string
  binding: StoredRoleBinding
  runtimeRevision: number
  issuedAt: number
}): Promise<InitialRoleArtifacts> {
  const manifest = input.frozen.manifest
  const labDirectory = manifest.authority_paths.lab_dir
  const prompt = rolePromptFor(input.role.role_kind)
  const promptPath = join(labDirectory, 'artifacts', 'builtins', `${prompt.sha256}.txt`)
  await freezeExact(promptPath, prompt.text)

  const factSetHash = await freezeExact(manifest.authority_paths.fact_set, EMPTY_FACT_SET)
  const evidenceIndexHash = await freezeExact(
    manifest.authority_paths.evidence_index,
    EMPTY_EVIDENCE_INDEX,
  )

  const laneId = 'lane_id' in input.role ? input.role.lane_id : undefined
  const lane = laneId === undefined
    ? undefined
    : manifest.search.lane_charters.find(candidate => candidate.lane_id === laneId)
  if ('lane_id' in input.role && lane === undefined) {
    throw new ActivationArtifactError(
      `Role ${input.role.role_id} references a missing LaneCharter`,
      'LANE_NOT_FOUND',
    )
  }
  const laneText = lane === undefined
    ? undefined
    : canonicalJson(lane.content)
  if (lane !== undefined && sha256(laneText!) !== lane.charter_sha256) {
    throw new ActivationArtifactError('LaneCharter bytes do not match the manifest', 'ARTIFACT_CONFLICT')
  }
  const lanePath = lane === undefined
    ? undefined
    : join(labDirectory, 'artifacts', 'lanes', `${sha256(lane.lane_id)}.charter.json`)
  if (lanePath !== undefined) await freezeExact(lanePath, laneText!)

  const assignmentId = input.role.role_kind === 'method'
    ? `${input.role.lane_id}:method:initial`
    : `${input.role.role_id}:bootstrap`
  const objectiveBody = initialObjective(input.frozen, input.role, lane)
  const assignmentPath = join(
    manifest.authority_paths.assignment_root,
    `${sha256(assignmentId)}.json`,
  )
  const outputPath = join(
    manifest.authority_paths.assignment_root,
    'outputs',
    `${sha256(assignmentId)}.json`,
  )
  const outputContract = {
    schema: input.role.role_kind === 'method'
      ? methodDesignTicketOutputSchema()
      : idleOutputSchema(),
    receipt_path: outputPath,
    expected_hash_binding: input.role.role_kind === 'method'
      ? METHOD_TICKET_HASH_BINDING
      : assignmentId,
  }
  const assignmentText = canonicalJson({
    version: 1,
    assignment_id: assignmentId,
    role_id: input.role.role_id,
    role_kind: input.role.role_kind,
    objective: objectiveBody,
    output_contract: outputContract,
  })
  const assignmentHash = await freezeExact(assignmentPath, assignmentText)

  const packet = compileRolePacket({
    manifest,
    role_id: input.role.role_id,
    session_id: input.sessionId,
    assignment_id: assignmentId,
    issued_at: input.issuedAt,
    role_binding_receipt_sha256: input.binding.hash,
    runtime_revision: input.runtimeRevision,
    fact_set_sha256: factSetHash,
    evidence_index_sha256: evidenceIndexHash,
    assignment_contract_sha256: assignmentHash,
    reveal_state: manifest.communication.reveal_policy.initial_state,
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
      lane: lane === undefined ? [] : [{
        block_id: 'lane-charter',
        source_path: lanePath!,
        exact_text: laneText!,
        text_sha256: lane.charter_sha256,
      }],
      stage: [],
      assignment: [{
        block_id: 'assignment-contract',
        source_path: assignmentPath,
        exact_text: assignmentText,
        text_sha256: assignmentHash,
      }],
    },
    relevant_fact_refs: [],
    evidence_refs: [],
    open_obligation_refs: [],
    input_artifact_refs: [],
    output_contract: outputContract,
  })
  const packetPath = join(
    labDirectory,
    'packets',
    sha256(assignmentId),
    `${sha256(input.role.role_id)}.json`,
  )
  const packetHash = await freezeExact(packetPath, packet.canonicalJson)
  if (packetHash !== packet.packetHash) {
    throw new ActivationArtifactError('Role Packet file hash changed while committing', 'ARTIFACT_CONFLICT')
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

/**
 * Read the role's already-persisted Packet and Assignment without compiling a
 * bootstrap replacement or touching the live Fact/Evidence ledgers.
 *
 * Recompilation here is validation only: dynamic Packet fields are retained,
 * while every manifest-derived field is regenerated from CURRENT and must
 * reproduce the exact frozen Packet bytes.
 */
export async function restoreCurrentRoleArtifacts(
  input: RestoreCurrentRoleArtifactsInput,
): Promise<InitialRoleArtifacts> {
  await validateRestoreInput(input)
  const manifest = input.frozen.manifest
  const packetText = await readRequiredText(input.packetRef.path, 'Role Packet')
  if (sha256(packetText) !== input.packetRef.hash) {
    conflict('Role Packet bytes do not match RuntimeState')
  }

  let packet: RolePacket
  try {
    packet = parseRolePacket(JSON.parse(packetText) as unknown)
  } catch {
    conflict('Role Packet is not strict Role Packet v1 JSON')
  }
  const canonicalPacket = canonicalJson(packet)
  if (canonicalPacket !== packetText || sha256(canonicalPacket) !== input.packetRef.hash) {
    conflict('Role Packet is not the exact canonical frozen packet')
  }

  await assertPacketIdentity(input, packet)
  const expectedPacketPath = join(
    manifest.authority_paths.lab_dir,
    'packets',
    sha256(packet.header.assignment_id),
    `${sha256(input.role.role_id)}.json`,
  )
  if (input.packetRef.path !== expectedPacketPath) {
    conflict('Role Packet path does not match its immutable identity')
  }

  const packetRevision = await readRevisionAtPath(
    manifest.authority_paths.lab_dir,
    packet.anchors.source_revision,
    input.frozen,
  )
  let recompiled: CompiledRolePacket
  try {
    recompiled = compileRolePacket({
      manifest: packetRevision.manifest,
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
    conflict('Role Packet cannot be reproduced from CURRENT')
  }
  if (recompiled.canonicalJson !== packetText || recompiled.packetHash !== input.packetRef.hash) {
    conflict('Role Packet manifest-derived fields drifted from CURRENT')
  }

  const universal = packet.verbatim_blocks.universal.find(block => (
    block.source_path === packetRevision.manifest.authority_paths.lab_spec
    && block.text_sha256 === packet.anchors.lab_spec_sha256
    && sha256(block.exact_text) === packet.anchors.lab_spec_sha256
  ))
  if (universal === undefined) {
    // Narrow migration tolerance: a Packet compiled by an earlier plugin build
    // (before the current-revision-block fix) may carry an internally
    // consistent universal block that references an EARLIER committed
    // revision's LAB_SPEC while its anchors declare its own revision. Such a
    // Packet is only ever superseded by the next Assignment; activation
    // tolerates it so that the superseding dispatch can proceed.
    const tolerated = await isStaleUniversalBlockTolerable(
      packet,
      packetRevision,
      manifest.authority_paths.lab_dir,
    )
    if (!tolerated) conflict('Role Packet does not carry its own exact LAB_SPEC block')
  }

  if (packet.verbatim_blocks.assignment.length !== 1) {
    conflict('Role Packet must bind exactly one Assignment block')
  }
  const assignmentBlock = packet.verbatim_blocks.assignment[0]!
  if (assignmentBlock.byte_range !== undefined
    || !isWithin(manifest.authority_paths.assignment_root, assignmentBlock.source_path)
    || assignmentBlock.text_sha256 !== packet.anchors.assignment_contract_sha256) {
    conflict('Role Packet Assignment source does not match its authority anchor')
  }
  const assignmentText = await readRequiredText(
    assignmentBlock.source_path,
    'Assignment contract',
  )
  if (assignmentText !== assignmentBlock.exact_text
    || sha256(assignmentText) !== assignmentBlock.text_sha256) {
    conflict('Assignment source bytes do not match the Role Packet block')
  }
  const assignment = parseCanonicalAssignment(assignmentText)
  if (assignment.assignment_id !== packet.header.assignment_id) {
    conflict('Assignment identity does not match the Role Packet')
  }
  if (assignment.role_id !== undefined && assignment.role_id !== packet.header.role_id) {
    conflict('Assignment role does not match the Role Packet')
  }
  if (assignment.role_kind !== undefined && assignment.role_kind !== packet.header.role_kind) {
    conflict('Assignment role kind does not match the Role Packet')
  }
  if (assignment.runtime_revision !== undefined
    && assignment.runtime_revision !== packet.anchors.runtime_revision) {
    conflict('Assignment Controller revision does not match the Role Packet')
  }
  if (canonicalJson(assignment.output_contract) !== canonicalJson(packet.output_contract)) {
    conflict('Assignment output contract does not match the Role Packet')
  }
  if (assignment.judge !== undefined
    && (assignment.judge.role_id !== packet.header.role_id
      || assignment.judge.session_id !== packet.header.session_id)) {
    conflict('Assignment Judge identity does not match the Role Packet')
  }

  return {
    assignmentId: packet.header.assignment_id,
    assignmentPath: assignmentBlock.source_path,
    assignmentHash: assignmentBlock.text_sha256,
    objectiveBody: assignment.objective ?? assignment.instruction!,
    packetPath: input.packetRef.path,
    packet: recompiled,
  }
}

interface CanonicalAssignment {
  readonly assignment_id: string
  readonly role_id?: string
  readonly role_kind?: string
  readonly runtime_revision?: number
  readonly objective?: string
  readonly instruction?: string
  readonly judge?: {
    readonly role_id: string
    readonly session_id: string
  }
  readonly output_contract: JsonValue
  readonly [key: string]: unknown
}

/**
 * True when the packet's universal block is the exact known-buggy pattern: a
 * single, internally consistent block whose bytes are an EARLIER committed
 * revision's exact LAB_SPEC (path + hash + text all match), while the
 * packet's anchors declare its own revision, and the packet carries no review
 * lineage. Such packets were frozen by an earlier plugin build and are only
 * superseded by the next Assignment; activation tolerates them so the
 * superseding dispatch can proceed.
 */
async function isStaleUniversalBlockTolerable(
  packet: RolePacket,
  packetRevision: FrozenRevision,
  labDirectory: string,
): Promise<boolean> {
  if (packet.runtime_snapshot.incumbent !== undefined) return false
  const blocks = packet.verbatim_blocks.universal
  if (blocks.length !== 1) return false
  const block = blocks[0]!
  if (sha256(block.exact_text) !== block.text_sha256) return false
  for (let revision = 1; revision < packetRevision.ref.revision; revision += 1) {
    const earlier = await readRevisionAtPath(labDirectory, revision, packetRevision)
    if (block.source_path !== earlier.manifest.authority_paths.lab_spec) continue
    if (block.text_sha256 !== earlier.ref.specHash) continue
    if (block.exact_text !== earlier.spec) continue
    return true
  }
  return false
}

async function validateRestoreInput(input: RestoreCurrentRoleArtifactsInput): Promise<void> {
  const manifest = input.frozen.manifest
  const currentRole = manifest.roles.find(candidate => candidate.role_id === input.role.role_id)
  if (currentRole === undefined
    || currentRole.role_kind === 'controller'
    || canonicalJson(currentRole) !== canonicalJson(input.role)) {
    conflict('Role does not match CURRENT ResolvedManifest')
  }
  if (!isAbsolute(input.packetRef.path) || !SHA256_PATTERN.test(input.packetRef.hash)) {
    conflict('RuntimeState Packet reference is invalid')
  }
  if (!Number.isSafeInteger(input.runtimeRevision) || input.runtimeRevision < 0) {
    conflict('Controller revision is invalid')
  }
  const manifestHash = sha256(canonicalJson(manifest))
  if (sha256(input.frozen.spec) !== input.frozen.ref.specHash
    || sha256(input.frozen.config) !== input.frozen.ref.configHash
    || manifestHash !== input.frozen.ref.manifestHash
    || input.frozen.validation.specHash !== input.frozen.ref.specHash
    || input.frozen.validation.configHash !== input.frozen.ref.configHash
    || input.frozen.validation.manifestHash !== input.frozen.ref.manifestHash
    || input.frozen.validation.dialogueHeadHash !== input.frozen.ref.dialogueHeadHash
    || manifest.source_revision !== input.frozen.ref.revision
    || manifest.anchors.dialogue_head_sha256 !== input.frozen.ref.dialogueHeadHash
    || manifest.anchors.lab_spec_sha256 !== input.frozen.ref.specHash
    || manifest.anchors.lab_yaml_sha256 !== input.frozen.ref.configHash) {
    conflict('FrozenRevision does not match its CURRENT hashes')
  }

  const receipt = input.binding.receipt
  const manifestHashCommitted = await isCommittedManifestHash(
    manifest.authority_paths.lab_dir,
    receipt.manifestHash,
  )
  const sessionSpec = resolveRootRoleSessionSpec(manifest, input.role.role_id)
  const expectedBindingPath = join(
    manifest.authority_paths.lab_dir,
    'receipts',
    'roles',
    `${sha256(input.role.role_id)}.json`,
  )
  if (input.binding.path !== expectedBindingPath
    || input.binding.hash !== receipt.receiptHash
    || receipt.labId !== manifest.lab_id
    || !manifestHashCommitted
    || receipt.roleId !== input.role.role_id
    || receipt.roleKind !== input.role.role_kind
    || receipt.sessionId !== input.sessionId
    || receipt.permissionPresetId !== input.role.dsh_preset
    || receipt.provider !== input.role.model_route.provider
    || receipt.model !== input.role.model_route.model
    || receipt.cwd !== sessionSpec.cwd) {
    conflict('RoleBindingReceipt does not match CURRENT role identity')
  }
}

async function assertPacketIdentity(
  input: RestoreCurrentRoleArtifactsInput,
  packet: RolePacket,
): Promise<void> {
  const manifest = input.frozen.manifest
  const laneId = 'lane_id' in input.role ? input.role.lane_id : null
  const anchor = packet.anchors
  const packetRevision = await readRevisionAtPath(
    manifest.authority_paths.lab_dir,
    anchor.source_revision,
    input.frozen,
  )
  if (packet.header.lab_id !== manifest.lab_id
    || packet.header.lane_id !== laneId
    || packet.header.role_id !== input.role.role_id
    || packet.header.role_kind !== input.role.role_kind
    || packet.header.session_id !== input.sessionId
    || packet.header.issued_at < input.binding.receipt.issuedAt
    || anchor.source_revision > input.frozen.ref.revision
    || anchor.dialogue_head_sha256 !== packetRevision.ref.dialogueHeadHash
    || anchor.lab_spec_sha256 !== packetRevision.ref.specHash
    || anchor.lab_yaml_sha256 !== packetRevision.ref.configHash
    || anchor.resolved_manifest_sha256 !== packetRevision.ref.manifestHash
    || anchor.campaign_contract_sha256 !== packetRevision.manifest.campaign_contract_sha256
    || anchor.role_binding_receipt_sha256 !== input.binding.hash
    || anchor.runtime_revision < input.binding.receipt.runtimeRevision
    || anchor.runtime_revision > input.runtimeRevision) {
    conflict('Role Packet identity or immutable anchors do not match RuntimeState')
  }
}

function parseCanonicalAssignment(text: string): CanonicalAssignment {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    conflict('Assignment contract is not JSON')
  }
  if (!isRecord(value) || canonicalJson(value) !== text
    || value.version !== 1
    || typeof value.assignment_id !== 'string'
    || value.assignment_id.length === 0
    || (value.role_id !== undefined && (typeof value.role_id !== 'string' || value.role_id.length === 0))
    || (value.role_kind !== undefined && (typeof value.role_kind !== 'string' || value.role_kind.length === 0))
    || (value.runtime_revision !== undefined
      && (!Number.isSafeInteger(value.runtime_revision) || (value.runtime_revision as number) < 0))
    || (value.objective !== undefined
      && (typeof value.objective !== 'string' || value.objective.length === 0))
    || (value.instruction !== undefined
      && (typeof value.instruction !== 'string' || value.instruction.length === 0))
    || (value.objective === undefined && value.instruction === undefined)
    || !isJsonValue(value.output_contract)) {
    conflict('Assignment contract does not satisfy the canonical Assignment envelope')
  }
  if (value.judge !== undefined
    && (!isRecord(value.judge)
      || typeof value.judge.role_id !== 'string'
      || value.judge.role_id.length === 0
      || typeof value.judge.session_id !== 'string'
      || value.judge.session_id.length === 0)) {
    conflict('Assignment Judge identity is invalid')
  }
  return value as unknown as CanonicalAssignment
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isRecord(value) && Object.values(value).every(isJsonValue)
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

async function readRequiredText(path: string, label: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    conflict(`${label} is missing or unreadable at ${path}`)
  }
}

function conflict(message: string): never {
  throw new ActivationArtifactError(message, 'ARTIFACT_CONFLICT')
}

function initialObjective(
  frozen: FrozenRevision,
  role: RootRoleBinding,
  lane: FrozenRevision['manifest']['search']['lane_charters'][number] | undefined,
): string {
  if (role.role_kind !== 'method' || lane === undefined) {
    return 'Remain idle. Act only when the AutoLab Controller dispatches an authorized, hash-bound Assignment Packet.'
  }
  return [
    'Read the exact LAB_SPEC and LaneCharter carried by the current Role Packet.',
    'Develop the first method proposal for this Lane and submit it to the bound Preflight Judge. Do not edit code.',
    'Respect every applicable constraint and preserved fact, distinguish method, feature or lens, implementation, measurement, and environment, and propose only work that can change the research decision.',
  ].join('\n')
}

function idleOutputSchema(): JsonValue {
  return { type: 'object', additionalProperties: true }
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
    throw new ActivationArtifactError(`Immutable activation artifact conflicts at ${path}`, 'ARTIFACT_CONFLICT')
  }
  return sha256(committed)
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}
