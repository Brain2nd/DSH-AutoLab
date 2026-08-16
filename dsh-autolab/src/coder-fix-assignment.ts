import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import {
  restoreCurrentRoleArtifacts,
  type FrozenPacketReference,
  type InitialRoleArtifacts,
} from './activation-artifacts.js'
import { durableWriteFile, type FrozenRevision } from './artifacts.js'
import type { StoredRoleBinding } from './binding.js'
import { coderImplementationReportOutputSchema } from './coder-receipt.js'
import { currentFactAnchor } from './fact-registry.js'
import { canonicalJson, sha256 } from './integrity.js'
import {
  compileRolePacket,
} from './packet.js'
import {
  rolePromptFor,
  type RootRoleBinding,
} from './roles.js'
import type {
  RoleAssignmentArtifactReference,
  RoleAssignmentJson,
} from './role-assignment.js'

const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export interface CoderFixArtifactReference {
  readonly path: string
  readonly sha256: string
}

export interface FreezeCoderFixAssignmentInput {
  /** The exact revision already read and verified through CURRENT. */
  readonly frozen: FrozenRevision
  readonly coderRole: Extract<RootRoleBinding, { readonly role_kind: 'coder' }>
  readonly coderSessionId: string
  readonly coderBinding: StoredRoleBinding
  readonly currentPacket: FrozenPacketReference
  /** Must be `coder:<reviewId>:fix:<slug>` with `<reviewId>` = the lineage review. */
  readonly assignmentId: string
  /** Lineage review: the APPROVED, resolved Preflight review of the candidate being fixed. */
  readonly reviewId: string
  readonly objective: string
  /** Opaque Controller fix mandate; it must carry a non-empty `candidate_id`. */
  readonly content: RoleAssignmentJson
  readonly candidateId: string
  readonly inputArtifactRefs: readonly RoleAssignmentArtifactReference[]
  readonly sourceMethodPacket: CoderFixArtifactReference
  readonly designTicket: CoderFixArtifactReference
  readonly preflightVerdict: CoderFixArtifactReference
  readonly runtimeRevision: number
  readonly issuedAt: number
}

export class CoderFixAssignmentError extends Error {
  readonly name = 'CoderFixAssignmentError'

  constructor(
    message: string,
    readonly code:
      | 'INVALID_INPUT'
      | 'CURRENT_MISMATCH'
      | 'BINDING_MISMATCH'
      | 'REFERENCE_MISMATCH'
      | 'ARTIFACT_CONFLICT',
  ) {
    super(message)
  }
}

/**
 * Freeze one Controller-authored Coder implementation-fix Assignment and Role
 * Packet. This is an artifact compiler only: the fix mandate, objective, and
 * references are explicit opaque inputs, the lineage review binds the approved
 * design (ticket + verdict), and no scientific interpretation happens here.
 */
export async function freezeCoderFixAssignment(
  input: FreezeCoderFixAssignmentInput,
): Promise<InitialRoleArtifacts> {
  validateInput(input)
  const manifest = input.frozen.manifest
  const labDirectory = manifest.authority_paths.lab_dir

  const lane = manifest.lanes.find(candidate => (
    candidate.lane_id === input.coderRole.lane_id
    && candidate.coder_role_id === input.coderRole.role_id
  ))
  const charter = manifest.search.lane_charters.find(candidate => (
    candidate.lane_id === input.coderRole.lane_id
  ))
  if (lane === undefined || charter === undefined) {
    throw new CoderFixAssignmentError(
      'target Coder does not resolve to one CURRENT Lane',
      'CURRENT_MISMATCH',
    )
  }

  const current = await restoreCurrentRoleArtifacts({
    frozen: input.frozen,
    role: input.coderRole,
    sessionId: input.coderSessionId,
    binding: input.coderBinding,
    runtimeRevision: input.runtimeRevision,
    packetRef: input.currentPacket,
  })
  const currentPacket = current.packet.packet
  if (input.runtimeRevision < currentPacket.anchors.runtime_revision) {
    throw new CoderFixAssignmentError(
      'new Assignment runtime revision precedes the current Role Packet',
      'INVALID_INPUT',
    )
  }

  const [ticketText, verdictText] = await Promise.all([
    readExactText(input.designTicket, 'Design Ticket'),
    readExactText(input.preflightVerdict, 'Preflight verdict'),
  ])

  const prompt = rolePromptFor('coder')
  const promptPath = join(labDirectory, 'artifacts', 'builtins', `${prompt.sha256}.txt`)
  await freezeExact(promptPath, prompt.text)

  const laneText = canonicalJson(charter.content)
  if (sha256(laneText) !== charter.charter_sha256) {
    throw new CoderFixAssignmentError(
      'LaneCharter bytes do not match CURRENT ResolvedManifest',
      'CURRENT_MISMATCH',
    )
  }
  const lanePath = join(
    labDirectory,
    'artifacts',
    'lanes',
    `${sha256(charter.lane_id)}.charter.json`,
  )
  await freezeExact(lanePath, laneText)

  const assignmentPath = join(
    manifest.authority_paths.assignment_root,
    'coder',
    `${sha256(input.assignmentId)}.json`,
  )
  const receiptPath = join(
    manifest.authority_paths.assignment_root,
    'outputs',
    `${sha256(input.assignmentId)}.json`,
  )
  const outputContract = {
    schema: coderImplementationReportOutputSchema(),
    receipt_path: receiptPath,
    expected_hash_binding: input.assignmentId,
  }
  const assignmentText = canonicalJson({
    version: 1,
    assignment_type: 'controller_coder_fix_assignment',
    assignment_id: input.assignmentId,
    review_id: input.reviewId,
    runtime_revision: input.runtimeRevision,
    issued_at: input.issuedAt,
    coder: {
      role_id: input.coderRole.role_id,
      session_id: input.coderSessionId,
      binding_path: input.coderBinding.path,
      binding_sha256: input.coderBinding.hash,
    },
    source_method: {
      role_id: lane.method_role_id,
      packet: artifactRef('source-method-packet', input.sourceMethodPacket),
    },
    design_ticket: {
      ...artifactRef('design-ticket', input.designTicket),
    },
    preflight_approval: {
      ...artifactRef('preflight-verdict', input.preflightVerdict),
      judge_assignment_id: `preflight:${input.reviewId}`,
      top_level_verdict: 'APPROVED',
    },
    candidate_id: input.candidateId,
    fix_mandate: {
      content: input.content,
      input_artifact_refs: input.inputArtifactRefs.map(reference => ({ ...reference })),
    },
    objective: input.objective,
    output_contract: outputContract,
  })
  const assignmentHash = await freezeExact(assignmentPath, assignmentText)
  const factAnchor = await currentFactAnchor(manifest.authority_paths.fact_set)

  const packet = compileRolePacket({
    manifest,
    role_id: input.coderRole.role_id,
    session_id: input.coderSessionId,
    assignment_id: input.assignmentId,
    issued_at: input.issuedAt,
    role_binding_receipt_sha256: input.coderBinding.hash,
    runtime_revision: input.runtimeRevision,
    fact_set_sha256: factAnchor.factSetSha256,
    evidence_index_sha256: currentPacket.anchors.evidence_index_sha256,
    assignment_contract_sha256: assignmentHash,
    reveal_state: currentPacket.runtime_snapshot.reveal_state,
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
        text_sha256: charter.charter_sha256,
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
        block_id: 'controller-coder-fix-assignment',
        source_path: assignmentPath,
        exact_text: assignmentText,
        text_sha256: assignmentHash,
      }],
    },
    ...(currentPacket.runtime_snapshot.incumbent === undefined
      ? {}
      : { incumbent: currentPacket.runtime_snapshot.incumbent }),
    relevant_fact_refs: [
      ...currentPacket.runtime_snapshot.relevant_fact_refs.filter(ref => ref.id !== 'fact-set'),
      ...factAnchor.relevantFactRefs,
    ],
    evidence_refs: currentPacket.runtime_snapshot.evidence_refs,
    open_obligation_refs: currentPacket.runtime_snapshot.open_obligation_refs,
    input_artifact_refs: [
      artifactRef('design-ticket', input.designTicket),
      artifactRef('preflight-verdict', input.preflightVerdict),
      ...input.inputArtifactRefs.map(reference => ({ ...reference })),
    ],
    output_contract: outputContract,
  })
  const packetPath = join(
    labDirectory,
    'packets',
    sha256(input.assignmentId),
    `${sha256(input.coderRole.role_id)}.json`,
  )
  const packetHash = await freezeExact(packetPath, packet.canonicalJson)
  if (packetHash !== packet.packetHash) {
    throw new CoderFixAssignmentError(
      'Coder Role Packet file hash changed while committing',
      'ARTIFACT_CONFLICT',
    )
  }

  return {
    assignmentId: input.assignmentId,
    assignmentPath,
    assignmentHash,
    objectiveBody: input.objective,
    packetPath,
    packet,
  }
}

function validateInput(input: FreezeCoderFixAssignmentInput): void {
  if (input.assignmentId.trim().length === 0
    || input.reviewId.trim().length === 0
    || input.objective.trim().length === 0
    || input.candidateId.trim().length === 0
    || input.coderSessionId.trim().length === 0) {
    throw new CoderFixAssignmentError(
      'assignmentId, reviewId, objective, candidateId and coderSessionId must be non-empty',
      'INVALID_INPUT',
    )
  }
  if (!input.assignmentId.startsWith(`coder:${input.reviewId}:fix:`)) {
    throw new CoderFixAssignmentError(
      `fix Assignment ${JSON.stringify(input.assignmentId)} does not embed its lineage review ${JSON.stringify(input.reviewId)}`,
      'INVALID_INPUT',
    )
  }
  if (!Number.isSafeInteger(input.runtimeRevision) || input.runtimeRevision < 0
    || !Number.isSafeInteger(input.issuedAt) || input.issuedAt < 0) {
    throw new CoderFixAssignmentError(
      'runtimeRevision and issuedAt must be non-negative safe integers',
      'INVALID_INPUT',
    )
  }
  for (const reference of [
    input.sourceMethodPacket,
    input.designTicket,
    input.preflightVerdict,
  ]) {
    if (!isAbsolute(reference.path) || !SHA256_PATTERN.test(reference.sha256)) {
      throw new CoderFixAssignmentError(
        'lineage references require an absolute path and SHA-256',
        'INVALID_INPUT',
      )
    }
  }
  for (const reference of input.inputArtifactRefs) {
    if (!isAbsolute(reference.path) || !SHA256_PATTERN.test(reference.sha256)) {
      throw new CoderFixAssignmentError(
        'input artifact references require an absolute path and SHA-256',
        'INVALID_INPUT',
      )
    }
  }
}

function artifactRef(
  artifactId: string,
  reference: CoderFixArtifactReference,
): { readonly artifact_id: string; readonly path: string; readonly sha256: string } {
  return { artifact_id: artifactId, path: reference.path, sha256: reference.sha256 }
}

async function readExactText(
  reference: CoderFixArtifactReference,
  label: string,
): Promise<string> {
  let bytes: Buffer
  try {
    bytes = await readFile(reference.path)
  } catch {
    throw new CoderFixAssignmentError(`${label} cannot be read`, 'REFERENCE_MISMATCH')
  }
  if (sha256(bytes) !== reference.sha256) {
    throw new CoderFixAssignmentError(`${label} SHA-256 mismatch`, 'REFERENCE_MISMATCH')
  }
  try {
    return UTF8.decode(bytes)
  } catch {
    throw new CoderFixAssignmentError(`${label} is not valid UTF-8`, 'REFERENCE_MISMATCH')
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
    throw new CoderFixAssignmentError(
      `Immutable Coder artifact conflicts at ${path}`,
      'ARTIFACT_CONFLICT',
    )
  }
  return sha256(committed)
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}
