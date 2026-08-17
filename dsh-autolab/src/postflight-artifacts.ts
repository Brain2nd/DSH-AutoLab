import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { durableWriteFile, isCommittedManifestHash, readRevisionAtPath, type FrozenRevision } from './artifacts.js'
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
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export interface PostflightArtifactReference {
  readonly path: string
  readonly sha256: string
}

export interface FreezePostflightReviewArtifactsInput {
  /** The revision read through CURRENT and already verified by ArtifactStore. */
  readonly frozen: FrozenRevision
  readonly judgeSessionId: string
  readonly judgeBinding: StoredRoleBinding
  /** The immutable Coder Packet currently projected by RuntimeState. */
  readonly currentCoderPacket: PostflightArtifactReference
  /** Small immutable control artifacts. Their target files are not opened here. */
  readonly methodPacket: PostflightArtifactReference
  readonly preflightResult: PostflightArtifactReference
  readonly coderResult: PostflightArtifactReference
  readonly trial: PostflightArtifactReference
  readonly runSlot: PostflightArtifactReference
  readonly attempt: PostflightArtifactReference
  readonly reviewId: string
  readonly runtimeRevision: number
  readonly issuedAt: number
  /** Current RuntimeState value, which may differ from the initial Manifest state. */
  readonly revealState: 'sealed' | 'revealed'
}

export interface PostflightReviewArtifacts {
  readonly reviewId: string
  readonly assignmentId: string
  readonly reviewInputHash: string
  readonly assignmentPath: string
  readonly assignmentHash: string
  readonly assignmentText: string
  readonly resultPath: string
  readonly packetPath: string
  readonly packet: CompiledRolePacket
}

export class PostflightArtifactError extends Error {
  readonly name = 'PostflightArtifactError'

  constructor(
    message: string,
    readonly code:
      | 'INVALID_INPUT'
      | 'CURRENT_MISMATCH'
      | 'JUDGE_BINDING_MISMATCH'
      | 'CODER_PACKET_MISMATCH'
      | 'ARTIFACT_CONFLICT',
  ) {
    super(message)
  }
}

/**
 * Compile one Postflight Assignment directly from CURRENT and immutable control
 * references. Method, result, Trial, RunSlot, and Attempt files are deliberately
 * not opened: the Judge reads their original bytes and any Lab-declared paths.
 */
export async function freezePostflightReviewArtifacts(
  input: FreezePostflightReviewArtifactsInput,
): Promise<PostflightReviewArtifacts> {
  validateInput(input)
  await assertFrozenRevision(input.frozen)

  const manifest = input.frozen.manifest
  const target = await resolveJudge(input)
  const coderPacket = await readCurrentCoderPacket(input, target.laneId, target.coderRoleId)

  const prompt = rolePromptFor('postflight_judge')
  const promptPath = join(
    manifest.authority_paths.lab_dir,
    'artifacts',
    'builtins',
    `${prompt.sha256}.txt`,
  )
  await freezeExact(promptPath, prompt.text)

  const laneText = canonicalJson(target.charter.content)
  if (sha256(laneText) !== target.charter.charter_sha256) {
    throw new PostflightArtifactError(
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

  const assignmentId = `postflight:${input.reviewId}`
  const assignmentPath = join(
    manifest.authority_paths.assignment_root,
    'reviews',
    `${sha256(input.reviewId)}.postflight.json`,
  )
  const resultPath = join(
    manifest.authority_paths.assignment_root,
    'outputs',
    `${sha256(assignmentId)}.json`,
  )
  const references = sourceReferences(input)
  const reviewInputHash = sha256(`autolab-postflight-review-input-v1\0${canonicalJson({
    review_id: input.reviewId,
    lab_id: manifest.lab_id,
    source_revision: input.frozen.ref.revision,
    resolved_manifest_sha256: input.frozen.ref.manifestHash,
    runtime_revision: input.runtimeRevision,
    issued_at: input.issuedAt,
    reveal_state: input.revealState,
    judge: {
      role_id: target.roleId,
      session_id: input.judgeSessionId,
      binding_path: input.judgeBinding.path,
      binding_sha256: input.judgeBinding.hash,
    },
    sources: references,
  })}`)
  const outputContract = {
    // This is the exact Lab-authored contract. Runtime never replaces it with
    // a global Postflight verdict enum or validates scientific meaning.
    schema: manifest.evidence.contract,
    receipt_path: resultPath,
    expected_hash_binding: reviewInputHash,
  }
  const assignmentText = canonicalJson({
    version: 1,
    assignment_type: 'postflight_review',
    review_id: input.reviewId,
    assignment_id: assignmentId,
    runtime_revision: input.runtimeRevision,
    issued_at: input.issuedAt,
    reveal_state: input.revealState,
    review_input_sha256: reviewInputHash,
    judge: {
      role_id: target.roleId,
      session_id: input.judgeSessionId,
      binding_path: input.judgeBinding.path,
      binding_sha256: input.judgeBinding.hash,
    },
    sources: references,
    instruction: [
      'Read the exact referenced Method, Preflight, Coder, Trial, RunSlot, and Attempt originals and the Lab-declared paths they reference.',
      'Apply the current LAB_SPEC.md and Lab-authored output contract directly; do not substitute a generic verdict taxonomy or invent another gate.',
      'Write the requested receipt at output_contract.receipt_path. Runtime will preserve its original bytes without interpreting scientific content.',
    ].join(' '),
    output_contract: outputContract,
  })
  const assignmentHash = await freezeExact(assignmentPath, assignmentText)
  const factAnchor = await currentFactAnchor(manifest.authority_paths.fact_set)

  const packet = compileRolePacket({
    manifest,
    role_id: target.roleId,
    session_id: input.judgeSessionId,
    assignment_id: assignmentId,
    issued_at: input.issuedAt,
    role_binding_receipt_sha256: input.judgeBinding.hash,
    runtime_revision: input.runtimeRevision,
    fact_set_sha256: factAnchor.factSetSha256,
    evidence_index_sha256: coderPacket.anchors.evidence_index_sha256,
    assignment_contract_sha256: assignmentHash,
    reveal_state: input.revealState,
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
      stage: [],
      assignment: [{
        block_id: 'postflight-review-assignment',
        source_path: assignmentPath,
        exact_text: assignmentText,
        text_sha256: assignmentHash,
      }],
    },
    ...(coderPacket.runtime_snapshot.incumbent === undefined
      ? {}
      : { incumbent: coderPacket.runtime_snapshot.incumbent }),
    relevant_fact_refs: [
      ...coderPacket.runtime_snapshot.relevant_fact_refs.filter(ref => ref.id !== 'fact-set'),
      ...factAnchor.relevantFactRefs,
    ],
    evidence_refs: coderPacket.runtime_snapshot.evidence_refs,
    open_obligation_refs: coderPacket.runtime_snapshot.open_obligation_refs,
    input_artifact_refs: Object.entries(references).map(([artifactId, reference]) => ({
      artifact_id: artifactId.replaceAll('_', '-'),
      path: reference.path,
      sha256: reference.sha256,
    })),
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
    throw new PostflightArtifactError(
      'Postflight Role Packet file hash changed while committing',
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
    resultPath,
    packetPath,
    packet,
  }
}

function sourceReferences(input: FreezePostflightReviewArtifactsInput): Readonly<{
  current_coder_packet: PostflightArtifactReference
  method_packet: PostflightArtifactReference
  preflight_result: PostflightArtifactReference
  coder_result: PostflightArtifactReference
  trial: PostflightArtifactReference
  run_slot: PostflightArtifactReference
  attempt: PostflightArtifactReference
}> {
  return {
    current_coder_packet: input.currentCoderPacket,
    method_packet: input.methodPacket,
    preflight_result: input.preflightResult,
    coder_result: input.coderResult,
    trial: input.trial,
    run_slot: input.runSlot,
    attempt: input.attempt,
  }
}

function validateInput(input: FreezePostflightReviewArtifactsInput): void {
  if (input.reviewId.trim().length === 0 || input.judgeSessionId.trim().length === 0) {
    throw new PostflightArtifactError(
      'reviewId and Postflight Judge SessionId must be non-empty',
      'INVALID_INPUT',
    )
  }
  if (!Number.isSafeInteger(input.runtimeRevision) || input.runtimeRevision < 0
    || !Number.isSafeInteger(input.issuedAt) || input.issuedAt < 0) {
    throw new PostflightArtifactError(
      'runtimeRevision and issuedAt must be non-negative safe integers',
      'INVALID_INPUT',
    )
  }
  for (const [label, reference] of Object.entries(sourceReferences(input))) {
    if (!isAbsolute(reference.path) || !SHA256_PATTERN.test(reference.sha256)) {
      throw new PostflightArtifactError(
        `${label} requires an absolute path and SHA-256`,
        'INVALID_INPUT',
      )
    }
  }
}

async function assertFrozenRevision(frozen: FrozenRevision): Promise<void> {
  const manifestText = canonicalJson(frozen.manifest)
  if (sha256(frozen.spec) !== frozen.ref.specHash
    || sha256(frozen.config) !== frozen.ref.configHash
    || sha256(manifestText) !== frozen.ref.manifestHash
    || frozen.validation.specHash !== frozen.ref.specHash
    || frozen.validation.configHash !== frozen.ref.configHash
    || frozen.validation.manifestHash !== frozen.ref.manifestHash
    || frozen.validation.dialogueHeadHash !== frozen.ref.dialogueHeadHash
    || frozen.manifest.source_revision !== frozen.ref.revision
    || frozen.manifest.anchors.dialogue_head_sha256 !== frozen.ref.dialogueHeadHash
    || frozen.manifest.anchors.lab_spec_sha256 !== frozen.ref.specHash
    || frozen.manifest.anchors.lab_yaml_sha256 !== frozen.ref.configHash) {
    throw new PostflightArtifactError(
      'FrozenRevision does not match its CURRENT hashes',
      'CURRENT_MISMATCH',
    )
  }
  await Promise.all([
    assertExactAuthority(frozen.manifest.authority_paths.lab_spec, frozen.spec),
    assertExactAuthority(frozen.manifest.authority_paths.lab_yaml, frozen.config),
    assertExactAuthority(frozen.manifest.authority_paths.resolved_manifest, manifestText),
  ])
}

async function resolveJudge(input: FreezePostflightReviewArtifactsInput): Promise<{
  readonly roleId: string
  readonly laneId: string
  readonly coderRoleId: string
  readonly charter: FrozenRevision['manifest']['search']['lane_charters'][number]
}> {
  const manifest = input.frozen.manifest
  const receipt = input.judgeBinding.receipt
  const stored = await readRoleBinding(manifest.authority_paths.lab_dir, receipt.roleId)
  const role = manifest.roles.find(candidate => candidate.role_id === receipt.roleId)
  if (role?.role_kind !== 'postflight_judge') {
    throw new PostflightArtifactError(
      'target role is not a CURRENT Postflight Judge',
      'JUDGE_BINDING_MISMATCH',
    )
  }
  const sessionSpec = resolveRootRoleSessionSpec(manifest, role.role_id)
  if (stored === undefined
    || stored.path !== input.judgeBinding.path
    || stored.hash !== input.judgeBinding.hash
    || canonicalJson(stored.receipt) !== canonicalJson(receipt)
    || receipt.receiptHash !== input.judgeBinding.hash
    || receipt.labId !== manifest.lab_id
    || !(await isCommittedManifestHash(manifest.authority_paths.lab_dir, receipt.manifestHash))
    || receipt.roleId !== role.role_id
    || receipt.roleKind !== 'postflight_judge'
    || receipt.sessionId !== input.judgeSessionId
    || receipt.permissionPresetId !== role.dsh_preset
    || receipt.provider !== role.model_route.provider
    || receipt.model !== role.model_route.model
    || receipt.cwd !== sessionSpec.cwd
    || receipt.runtimeRevision > input.runtimeRevision) {
    throw new PostflightArtifactError(
      'Postflight Judge Session does not match its frozen binding and CURRENT',
      'JUDGE_BINDING_MISMATCH',
    )
  }
  const lane = manifest.lanes.find(candidate => (
    candidate.lane_id === role.lane_id
    && candidate.postflight_judge_role_id === role.role_id
  ))
  const charter = manifest.search.lane_charters.find(candidate => (
    candidate.lane_id === role.lane_id
  ))
  if (lane === undefined || charter === undefined) {
    throw new PostflightArtifactError(
      'Postflight Judge does not resolve to one CURRENT Lane',
      'JUDGE_BINDING_MISMATCH',
    )
  }
  return { roleId: role.role_id, laneId: lane.lane_id, coderRoleId: lane.coder_role_id, charter }
}

async function readCurrentCoderPacket(
  input: FreezePostflightReviewArtifactsInput,
  laneId: string,
  coderRoleId: string,
): Promise<RolePacket> {
  let bytes: Buffer
  try {
    bytes = await readFile(input.currentCoderPacket.path)
  } catch {
    throw new PostflightArtifactError(
      'current Coder Packet cannot be read',
      'CODER_PACKET_MISMATCH',
    )
  }
  if (sha256(bytes) !== input.currentCoderPacket.sha256) {
    throw new PostflightArtifactError(
      'current Coder Packet hash does not match RuntimeState',
      'CODER_PACKET_MISMATCH',
    )
  }
  let text: string
  let packet: RolePacket
  try {
    text = UTF8.decode(bytes)
    packet = parseRolePacket(JSON.parse(text) as unknown)
  } catch {
    throw new PostflightArtifactError(
      'current Coder Packet is not canonical Role Packet v1 JSON',
      'CODER_PACKET_MISMATCH',
    )
  }
  const manifest = input.frozen.manifest
  const expectedPath = join(
    manifest.authority_paths.lab_dir,
    'packets',
    sha256(packet.header.assignment_id),
    `${sha256(coderRoleId)}.json`,
  )
  const packetRevision = await readRevisionAtPath(
    manifest.authority_paths.lab_dir,
    packet.anchors.source_revision,
    input.frozen,
  )
  if (canonicalJson(packet) !== text
    || input.currentCoderPacket.path !== expectedPath
    || packet.header.lab_id !== manifest.lab_id
    || packet.header.lane_id !== laneId
    || packet.header.role_id !== coderRoleId
    || packet.header.role_kind !== 'coder'
    || packet.anchors.source_revision > input.frozen.ref.revision
    || packet.anchors.dialogue_head_sha256 !== packetRevision.ref.dialogueHeadHash
    || packet.anchors.lab_spec_sha256 !== packetRevision.ref.specHash
    || packet.anchors.lab_yaml_sha256 !== packetRevision.ref.configHash
    || packet.anchors.resolved_manifest_sha256 !== packetRevision.ref.manifestHash
    || packet.anchors.campaign_contract_sha256 !== packetRevision.manifest.campaign_contract_sha256
    || packet.anchors.runtime_revision > input.runtimeRevision) {
    throw new PostflightArtifactError(
      'current Coder Packet does not bind this CURRENT Lane',
      'CODER_PACKET_MISMATCH',
    )
  }
  return packet
}

async function assertExactAuthority(path: string, expected: string): Promise<void> {
  let observed: string
  try {
    observed = await readFile(path, 'utf8')
  } catch {
    throw new PostflightArtifactError(
      `CURRENT authority cannot be read at ${path}`,
      'CURRENT_MISMATCH',
    )
  }
  if (observed !== expected) {
    throw new PostflightArtifactError(
      `CURRENT authority bytes changed at ${path}`,
      'CURRENT_MISMATCH',
    )
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
    throw new PostflightArtifactError(
      `Immutable Postflight artifact conflicts at ${path}`,
      'ARTIFACT_CONFLICT',
    )
  }
  return sha256(committed)
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}
