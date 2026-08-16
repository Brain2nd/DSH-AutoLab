import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import {
  restoreCurrentRoleArtifacts,
  type FrozenPacketReference,
  type InitialRoleArtifacts,
} from './activation-artifacts.js'
import { durableWriteFile, type FrozenRevision } from './artifacts.js'
import { readRoleBinding, type StoredRoleBinding } from './binding.js'
import { currentFactAnchor } from './fact-registry.js'
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
import type { RootRoleBinding } from './roles.js'

const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export type RoleAssignmentJson =
  | null
  | boolean
  | number
  | string
  | RoleAssignmentJson[]
  | { [key: string]: RoleAssignmentJson }

export interface RoleAssignmentArtifactReference {
  readonly artifact_id: string
  readonly path: string
  readonly sha256: string
}

export interface MethodSourceReviewVerdictReference {
  readonly path: string
  readonly sha256: string
}

export const METHOD_SOURCE_PREFLIGHT_VERDICT_ARTIFACT_ID = 'source-preflight-verdict'

export interface FreezeRoleAssignmentInput {
  /** Exact CURRENT revision already read through ArtifactStore. */
  readonly frozen: FrozenRevision
  /** Controller-selected Ops or Coordinator role. */
  readonly role: RootRoleBinding
  readonly sessionId: string
  readonly binding: StoredRoleBinding
  /** Current durable Packet whose original anchors and runtime snapshot continue. */
  readonly currentPacket: FrozenPacketReference
  /** Current RuntimeState reveal projection; legacy callers may inherit the Packet value. */
  readonly currentRevealState?: 'sealed' | 'revealed'
  readonly assignmentId: string
  readonly objective: string
  /** Lab-defined Assignment content; Runtime stores it without interpretation. */
  readonly content: RoleAssignmentJson
  /** Lab-defined output schema; Runtime does not evaluate a receipt against it. */
  readonly outputSchema: RoleAssignmentJson
  /** Controller-selected small references; their target files are not read here. */
  readonly inputArtifactRefs: readonly RoleAssignmentArtifactReference[]
  readonly runtimeRevision: number
  readonly issuedAt: number
}

export interface FrozenRoleAssignment extends InitialRoleArtifacts {
  readonly assignmentText: string
  readonly receiptPath: string
  readonly outputContract: {
    readonly schema: RoleAssignmentJson
    readonly receipt_path: string
    readonly expected_hash_binding: string
  }
}

export interface FreezeMethodAssignmentInput
  extends Omit<FreezeRoleAssignmentInput, 'role' | 'outputSchema'> {
  readonly role: Extract<RootRoleBinding, { readonly role_kind: 'method' }>
  /** Present only when this Assignment resolves a non-APPROVED Preflight review. */
  readonly sourceReviewId?: string
  /** Durable verdict identity resolved mechanically from sourceReviewId. */
  readonly sourceReviewVerdict?: MethodSourceReviewVerdictReference
}

export type FrozenMethodAssignment = FrozenRoleAssignment

export interface FreezeRoleAssignmentReceiptInput {
  /** Exact Packet currently projected for the dispatched role. */
  readonly rolePacketPath: string
  readonly rolePacketHash: string
  /** Controller-owned immutable destination for the original receipt bytes. */
  readonly artifactPath: string
}

export interface FrozenRoleAssignmentReceipt {
  readonly assignmentId: string
  readonly roleId: string
  readonly sessionId: string
  readonly rolePacketPath: string
  readonly rolePacketHash: string
  readonly receiptPath: string
  readonly artifactPath: string
  readonly receiptHash: string
  readonly expectedHashBinding: string
  readonly packet: RolePacket
}

export interface RoleAssignmentInstallProjection {
  readonly assignmentId: string
  readonly status: 'pending' | 'activating' | 'applied'
}

export class RoleAssignmentError extends Error {
  readonly name = 'RoleAssignmentError'

  constructor(
    message: string,
    readonly code:
      | 'INVALID_INPUT'
      | 'UNSUPPORTED_ROLE'
      | 'BINDING_MISMATCH'
      | 'ARTIFACT_CONFLICT'
      | 'PACKET_READ_FAILED'
      | 'PACKET_HASH_MISMATCH'
      | 'INVALID_PACKET'
      | 'RECEIPT_READ_FAILED'
      | 'RECEIPT_WRITE_FAILED'
      | 'RECEIPT_CONFLICT',
  ) {
    super(message)
  }
}

/**
 * Freeze one Controller-selected Assignment and Role Packet. This is only an
 * artifact compiler: role, objective, opaque content, schema, and references
 * are all explicit inputs, and no downstream route is selected here.
 */
export async function freezeRoleAssignment(
  input: FreezeRoleAssignmentInput,
): Promise<FrozenRoleAssignment> {
  validateAssignmentInput(input)
  return await freezeControllerAssignment(input, {
    assignmentType: 'controller_role_assignment',
    blockId: 'controller-role-assignment',
    outputSchema: input.outputSchema,
    expectedHashBinding: input.assignmentId,
  })
}

/** Freeze one Controller-authored Method Assignment with the native ticket contract. */
export async function freezeMethodAssignment(
  input: FreezeMethodAssignmentInput,
): Promise<FrozenMethodAssignment> {
  validateMethodAssignmentInput(input)
  const inputArtifactRefs = methodAssignmentInputArtifactRefs(input)
  return await freezeControllerAssignment({ ...input, inputArtifactRefs }, {
    assignmentType: 'controller_method_assignment',
    blockId: 'controller-method-assignment',
    outputSchema: methodDesignTicketOutputSchema() as RoleAssignmentJson,
    expectedHashBinding: METHOD_TICKET_HASH_BINDING,
    ...(input.sourceReviewId === undefined ? {} : { sourceReviewId: input.sourceReviewId }),
  })
}

interface ControllerAssignmentFlavor {
  readonly assignmentType: 'controller_role_assignment' | 'controller_method_assignment'
  readonly blockId: string
  readonly outputSchema: RoleAssignmentJson
  readonly expectedHashBinding: string
  readonly sourceReviewId?: string
}

type ControllerAssignmentInput = Omit<FreezeRoleAssignmentInput, 'outputSchema'>

async function freezeControllerAssignment(
  input: ControllerAssignmentInput,
  flavor: ControllerAssignmentFlavor,
): Promise<FrozenRoleAssignment> {
  await assertStoredBinding(input)
  const current = await restoreCurrentRoleArtifacts({
    frozen: input.frozen,
    role: input.role,
    sessionId: input.sessionId,
    binding: input.binding,
    runtimeRevision: input.runtimeRevision,
    packetRef: input.currentPacket,
  })
  if (input.runtimeRevision < current.packet.packet.anchors.runtime_revision) {
    throw new RoleAssignmentError(
      'new Assignment runtime revision precedes the current Role Packet',
      'INVALID_INPUT',
    )
  }

  const manifest = input.frozen.manifest
  const roleKey = sha256(input.role.role_id)
  const assignmentKey = sha256(input.assignmentId)
  const assignmentPath = join(
    manifest.authority_paths.assignment_root,
    'roles',
    roleKey,
    `${assignmentKey}.json`,
  )
  const receiptPath = join(
    manifest.authority_paths.assignment_root,
    'outputs',
    roleKey,
    `${assignmentKey}.json`,
  )
  const outputContract = {
    schema: flavor.outputSchema,
    receipt_path: receiptPath,
    expected_hash_binding: flavor.expectedHashBinding,
  }
  let assignmentText: string
  try {
    assignmentText = canonicalJson(controllerAssignmentDocument(
      input,
      flavor,
      input.runtimeRevision,
      input.issuedAt,
      receiptPath,
    ))
  } catch (error) {
    throw new RoleAssignmentError(
      `Assignment content and output contract must be JSON values: ${errorMessage(error)}`,
      'INVALID_INPUT',
    )
  }
  const assignmentHash = await freezeText(assignmentPath, assignmentText)
  const factAnchor = await currentFactAnchor(manifest.authority_paths.fact_set)

  let packet: CompiledRolePacket
  try {
    packet = compileRolePacket({
      manifest,
      role_id: input.role.role_id,
      session_id: input.sessionId,
      assignment_id: input.assignmentId,
      issued_at: input.issuedAt,
      role_binding_receipt_sha256: input.binding.hash,
      runtime_revision: input.runtimeRevision,
      fact_set_sha256: factAnchor.factSetSha256,
      evidence_index_sha256: current.packet.packet.anchors.evidence_index_sha256,
      assignment_contract_sha256: assignmentHash,
      reveal_state: input.currentRevealState
        ?? current.packet.packet.runtime_snapshot.reveal_state,
      verbatim_blocks: {
        universal: current.packet.packet.verbatim_blocks.universal,
        role: current.packet.packet.verbatim_blocks.role,
        lane: current.packet.packet.verbatim_blocks.lane,
        stage: current.packet.packet.verbatim_blocks.stage,
        assignment: [{
          block_id: flavor.blockId,
          source_path: assignmentPath,
          exact_text: assignmentText,
          text_sha256: assignmentHash,
        }],
      },
      ...(current.packet.packet.runtime_snapshot.incumbent === undefined
        ? {}
        : { incumbent: current.packet.packet.runtime_snapshot.incumbent }),
      relevant_fact_refs: [
        ...current.packet.packet.runtime_snapshot.relevant_fact_refs.filter(ref => ref.id !== 'fact-set'),
        ...factAnchor.relevantFactRefs,
      ],
      evidence_refs: current.packet.packet.runtime_snapshot.evidence_refs,
      open_obligation_refs: current.packet.packet.runtime_snapshot.open_obligation_refs,
      input_artifact_refs: input.inputArtifactRefs.map(reference => ({ ...reference })),
      output_contract: outputContract,
    })
  } catch (error) {
    throw new RoleAssignmentError(
      `cannot compile Controller-selected Role Packet: ${errorMessage(error)}`,
      'INVALID_INPUT',
    )
  }
  const packetPath = join(
    manifest.authority_paths.lab_dir,
    'packets',
    assignmentKey,
    `${roleKey}.json`,
  )
  const packetHash = await freezeText(packetPath, packet.canonicalJson)
  if (packetHash !== packet.packetHash) {
    throw new RoleAssignmentError(
      'Role Packet file hash changed while committing',
      'ARTIFACT_CONFLICT',
    )
  }
  return {
    assignmentId: input.assignmentId,
    assignmentPath,
    assignmentHash,
    assignmentText,
    objectiveBody: input.objective,
    receiptPath,
    outputContract,
    packetPath,
    packet,
  }
}

/**
 * Prove that an idempotent dispatch is the exact same Controller request. The
 * comparison is purely mechanical: opaque content and schema are compared as
 * canonical JSON and referenced targets are never opened.
 */
export function assertRoleAssignmentReplay(
  packet: RolePacket,
  input: Pick<FreezeRoleAssignmentInput,
    | 'role'
    | 'sessionId'
    | 'assignmentId'
    | 'objective'
    | 'content'
    | 'outputSchema'
    | 'inputArtifactRefs'>,
): void {
  assertDispatchableRole(input.role.role_kind)
  assertControllerAssignmentReplay(packet, input, {
    assignmentType: 'controller_role_assignment',
    blockId: 'controller-role-assignment',
    outputSchema: input.outputSchema,
    expectedHashBinding: input.assignmentId,
  })
}

/** Exact replay binding for the dedicated Method Assignment path. */
export function assertMethodAssignmentReplay(
  packet: RolePacket,
  input: Pick<FreezeMethodAssignmentInput,
    | 'role'
    | 'sessionId'
    | 'assignmentId'
    | 'objective'
    | 'content'
    | 'inputArtifactRefs'
    | 'sourceReviewId'
    | 'sourceReviewVerdict'>,
): void {
  assertMethodRole(input.role)
  validateMethodSourceReview(input)
  const inputArtifactRefs = methodAssignmentInputArtifactRefs(input)
  assertControllerAssignmentReplay(packet, { ...input, inputArtifactRefs }, {
    assignmentType: 'controller_method_assignment',
    blockId: 'controller-method-assignment',
    outputSchema: methodDesignTicketOutputSchema() as RoleAssignmentJson,
    expectedHashBinding: METHOD_TICKET_HASH_BINDING,
    ...(input.sourceReviewId === undefined ? {} : { sourceReviewId: input.sourceReviewId }),
  })
}

function assertControllerAssignmentReplay(
  packet: RolePacket,
  input: Pick<ControllerAssignmentInput,
    | 'role'
    | 'sessionId'
    | 'assignmentId'
    | 'objective'
    | 'content'
    | 'inputArtifactRefs'>,
  flavor: ControllerAssignmentFlavor,
): void {
  const outputContract = {
    schema: flavor.outputSchema,
    receipt_path: packet.output_contract.receipt_path,
    expected_hash_binding: flavor.expectedHashBinding,
  }
  const expectedAssignment = canonicalJson(controllerAssignmentDocument(
    input,
    flavor,
    packet.anchors.runtime_revision,
    packet.header.issued_at,
    packet.output_contract.receipt_path,
  ))
  const assignmentBlocks = packet.verbatim_blocks.assignment
  if (packet.header.assignment_id !== input.assignmentId
    || packet.header.role_id !== input.role.role_id
    || packet.header.role_kind !== input.role.role_kind
    || packet.header.session_id !== input.sessionId
    || assignmentBlocks.length !== 1
    || assignmentBlocks[0]!.exact_text !== expectedAssignment
    || assignmentBlocks[0]!.text_sha256 !== sha256(expectedAssignment)
    || canonicalJson(packet.output_contract) !== canonicalJson(outputContract)
    || canonicalJson(packet.runtime_snapshot.input_artifact_refs)
      !== canonicalJson(input.inputArtifactRefs)) {
    throw new RoleAssignmentError(
      `Assignment ${JSON.stringify(input.assignmentId)} conflicts with its immutable Controller request`,
      'ARTIFACT_CONFLICT',
    )
  }
}

function controllerAssignmentDocument(
  input: Pick<ControllerAssignmentInput,
    | 'role'
    | 'sessionId'
    | 'assignmentId'
    | 'objective'
    | 'content'
    | 'inputArtifactRefs'>,
  flavor: ControllerAssignmentFlavor,
  runtimeRevision: number,
  issuedAt: number,
  receiptPath: string,
): RoleAssignmentJson {
  return {
    version: 1,
    assignment_type: flavor.assignmentType,
    assignment_id: input.assignmentId,
    runtime_revision: runtimeRevision,
    issued_at: issuedAt,
    role_id: input.role.role_id,
    role_kind: input.role.role_kind,
    session_id: input.sessionId,
    objective: input.objective,
    content: input.content,
    input_artifact_refs: input.inputArtifactRefs.map(reference => ({ ...reference })),
    ...(flavor.sourceReviewId === undefined
      ? {}
      : { source_review_id: flavor.sourceReviewId }),
    output_contract: {
      schema: flavor.outputSchema,
      receipt_path: receiptPath,
      expected_hash_binding: flavor.expectedHashBinding,
    },
  }
}

/** Do not let a newer request erase an install whose Goal effect may exist. */
export function assertRoleAssignmentMayDispatch(
  current: RoleAssignmentInstallProjection | undefined,
  requestedAssignmentId: string,
): void {
  if (current?.status === 'activating'
    && current.assignmentId !== requestedAssignmentId) {
    throw new RoleAssignmentError(
      `Assignment ${JSON.stringify(current.assignmentId)} is still activating and must be reconciled before ${JSON.stringify(requestedAssignmentId)}`,
      'ARTIFACT_CONFLICT',
    )
  }
}

/**
 * Freeze the exact receipt path named by a dispatched Role Packet. Receipt
 * bytes are copied verbatim: no JSON parse, schema evaluation, scientific
 * classification, or referenced artifact read occurs on this path.
 */
export async function freezeRoleAssignmentReceipt(
  input: FreezeRoleAssignmentReceiptInput,
): Promise<FrozenRoleAssignmentReceipt> {
  const packetPath = absolutePath(input.rolePacketPath, 'Role Packet path')
  const artifactPath = absolutePath(input.artifactPath, 'receipt artifact path')
  if (!SHA256_PATTERN.test(input.rolePacketHash)) {
    throw new RoleAssignmentError('Role Packet hash must be SHA-256', 'INVALID_INPUT')
  }
  if (packetPath === artifactPath) {
    throw new RoleAssignmentError(
      'receipt artifact path must differ from the Role Packet path',
      'INVALID_INPUT',
    )
  }

  const packetBytes = await readPacket(packetPath)
  const observedHash = sha256(packetBytes)
  if (observedHash !== input.rolePacketHash) {
    throw new RoleAssignmentError(
      'Role Packet bytes do not match the projected hash',
      'PACKET_HASH_MISMATCH',
    )
  }
  const packet = parseCanonicalPacket(packetBytes)
  assertDispatchableRole(packet.header.role_kind)
  const receiptPath = absolutePath(packet.output_contract.receipt_path, 'output receipt path')
  if (receiptPath === artifactPath) {
    throw new RoleAssignmentError(
      'immutable artifact path must differ from the mutable output receipt path',
      'INVALID_INPUT',
    )
  }
  let receiptBytes: Buffer
  try {
    receiptBytes = await readFile(receiptPath)
  } catch (error) {
    throw new RoleAssignmentError(
      `output receipt cannot be read at ${receiptPath}: ${errorMessage(error)}`,
      'RECEIPT_READ_FAILED',
    )
  }
  await freezeBytes(artifactPath, receiptBytes)
  return {
    assignmentId: packet.header.assignment_id,
    roleId: packet.header.role_id,
    sessionId: packet.header.session_id,
    rolePacketPath: packetPath,
    rolePacketHash: observedHash,
    receiptPath,
    artifactPath,
    receiptHash: sha256(receiptBytes),
    expectedHashBinding: packet.output_contract.expected_hash_binding,
    packet,
  }
}

function validateAssignmentInput(input: FreezeRoleAssignmentInput): void {
  assertDispatchableRole(input.role.role_kind)
  validateCommonAssignmentInput(input)
}

function validateMethodAssignmentInput(input: FreezeMethodAssignmentInput): void {
  assertMethodRole(input.role)
  validateMethodSourceReview(input)
  validateCommonAssignmentInput(input)
}

function validateMethodSourceReview(input: {
  readonly sourceReviewId?: string
  readonly sourceReviewVerdict?: MethodSourceReviewVerdictReference
}): void {
  if ((input.sourceReviewId === undefined) !== (input.sourceReviewVerdict === undefined)) {
    throw new RoleAssignmentError(
      'sourceReviewId and sourceReviewVerdict must be present together',
      'INVALID_INPUT',
    )
  }
  if (input.sourceReviewId === undefined || input.sourceReviewVerdict === undefined) return
  if (input.sourceReviewId.trim().length === 0) {
    throw new RoleAssignmentError('sourceReviewId must not be blank', 'INVALID_INPUT')
  }
  if (!isAbsolute(input.sourceReviewVerdict.path)
    || !SHA256_PATTERN.test(input.sourceReviewVerdict.sha256)) {
    throw new RoleAssignmentError(
      'sourceReviewVerdict requires an absolute path and SHA-256',
      'INVALID_INPUT',
    )
  }
}

/**
 * Bind a revision Assignment to the exact frozen verdict selected by the
 * Controller. The referenced bytes remain opaque and are never opened here.
 */
function methodAssignmentInputArtifactRefs(input: {
  readonly inputArtifactRefs: readonly RoleAssignmentArtifactReference[]
  readonly sourceReviewId?: string
  readonly sourceReviewVerdict?: MethodSourceReviewVerdictReference
}): readonly RoleAssignmentArtifactReference[] {
  if (input.sourceReviewId === undefined || input.sourceReviewVerdict === undefined) {
    return input.inputArtifactRefs
  }
  const required = {
    artifact_id: METHOD_SOURCE_PREFLIGHT_VERDICT_ARTIFACT_ID,
    path: input.sourceReviewVerdict.path,
    sha256: input.sourceReviewVerdict.sha256,
  }
  const merged: RoleAssignmentArtifactReference[] = []
  for (const reference of input.inputArtifactRefs) {
    if (reference.artifact_id !== METHOD_SOURCE_PREFLIGHT_VERDICT_ARTIFACT_ID) {
      merged.push(reference)
      continue
    }
    if (reference.path !== required.path || reference.sha256 !== required.sha256) {
      throw new RoleAssignmentError(
        `input artifact ${JSON.stringify(METHOD_SOURCE_PREFLIGHT_VERDICT_ARTIFACT_ID)} conflicts with source review ${JSON.stringify(input.sourceReviewId)}`,
        'ARTIFACT_CONFLICT',
      )
    }
  }
  merged.push(required)
  return merged
}

function validateCommonAssignmentInput(input: ControllerAssignmentInput): void {
  if (input.assignmentId.length === 0
    || input.objective.length === 0
    || input.sessionId.length === 0
    || !Number.isSafeInteger(input.runtimeRevision)
    || input.runtimeRevision < 0
    || !Number.isSafeInteger(input.issuedAt)
    || input.issuedAt < 0) {
    throw new RoleAssignmentError(
      'Assignment identity, objective, Session, revision, and issue time are invalid',
      'INVALID_INPUT',
    )
  }
  for (const reference of input.inputArtifactRefs) {
    if (reference.artifact_id.length === 0
      || !isAbsolute(reference.path)
      || !SHA256_PATTERN.test(reference.sha256)) {
      throw new RoleAssignmentError(
        'input artifact references require an id, absolute path, and SHA-256',
        'INVALID_INPUT',
      )
    }
  }
}

async function assertStoredBinding(input: ControllerAssignmentInput): Promise<void> {
  const stored = await readRoleBinding(
    input.frozen.manifest.authority_paths.lab_dir,
    input.role.role_id,
  )
  if (stored === undefined
    || stored.path !== input.binding.path
    || stored.hash !== input.binding.hash
    || canonicalJson(stored.receipt) !== canonicalJson(input.binding.receipt)) {
    throw new RoleAssignmentError(
      `Role ${JSON.stringify(input.role.role_id)} binding does not match its durable receipt`,
      'BINDING_MISMATCH',
    )
  }
}

function assertMethodRole(
  role: RootRoleBinding,
): asserts role is Extract<RootRoleBinding, { readonly role_kind: 'method' }> {
  if (role.role_kind !== 'method') {
    throw new RoleAssignmentError(
      `Controller Method Assignment does not target ${JSON.stringify(role.role_kind)}`,
      'UNSUPPORTED_ROLE',
    )
  }
}

function assertDispatchableRole(roleKind: RolePacket['header']['role_kind']): void {
  if (roleKind !== 'ops' && roleKind !== 'coordinator') {
    throw new RoleAssignmentError(
      `Controller Role Assignment does not target ${JSON.stringify(roleKind)}`,
      'UNSUPPORTED_ROLE',
    )
  }
}

function parseCanonicalPacket(bytes: Buffer): RolePacket {
  let text: string
  let packet: RolePacket
  try {
    text = UTF8.decode(bytes)
    packet = parseRolePacket(JSON.parse(text) as unknown)
  } catch (error) {
    throw new RoleAssignmentError(
      `Role Packet is not valid canonical JSON: ${errorMessage(error)}`,
      'INVALID_PACKET',
    )
  }
  if (canonicalJson(packet) !== text) {
    throw new RoleAssignmentError(
      'Role Packet bytes are not its canonical immutable form',
      'INVALID_PACKET',
    )
  }
  return packet
}

async function readPacket(path: string): Promise<Buffer> {
  try {
    return await readFile(path)
  } catch (error) {
    throw new RoleAssignmentError(
      `Role Packet cannot be read at ${path}: ${errorMessage(error)}`,
      'PACKET_READ_FAILED',
    )
  }
}

async function freezeText(path: string, text: string): Promise<string> {
  await freezeNoClobber(path, text, 'ARTIFACT_CONFLICT')
  return sha256(text)
}

async function freezeBytes(path: string, bytes: Buffer): Promise<void> {
  await freezeNoClobber(path, bytes, 'RECEIPT_CONFLICT')
}

async function freezeNoClobber(
  path: string,
  bytes: string | Buffer,
  conflictCode: 'ARTIFACT_CONFLICT' | 'RECEIPT_CONFLICT',
): Promise<void> {
  try {
    await durableWriteFile(path, bytes, false)
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') {
      throw new RoleAssignmentError(
        `cannot write immutable artifact at ${path}: ${errorMessage(error)}`,
        conflictCode === 'RECEIPT_CONFLICT' ? 'RECEIPT_WRITE_FAILED' : conflictCode,
      )
    }
  }
  let committed: Buffer
  try {
    committed = await readFile(path)
  } catch (error) {
    throw new RoleAssignmentError(
      `immutable artifact cannot be read at ${path}: ${errorMessage(error)}`,
      conflictCode,
    )
  }
  const expected = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes
  if (!committed.equals(expected)) {
    throw new RoleAssignmentError(`immutable artifact conflicts at ${path}`, conflictCode)
  }
}

function absolutePath(value: string, label: string): string {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new RoleAssignmentError(`${label} must be absolute`, 'INVALID_INPUT')
  }
  return resolve(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}
