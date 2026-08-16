import { candidateReceiptPath, readCandidateSnapshotReceipt, type CandidateSnapshotReceipt } from './candidate.js'
import type { FrozenRevision } from './artifacts.js'
import type { RuntimeState } from './state.js'
import { inspectLaneWorktree } from './worktree.js'

export interface VerifiedActiveCandidate {
  readonly snapshot: CandidateSnapshotReceipt
}

export class CandidateRecoveryError extends Error {
  readonly name = 'CandidateRecoveryError'

  constructor(
    message: string,
    readonly code: 'IDENTITY_MISMATCH' | 'IO_FAILED' = 'IDENTITY_MISMATCH',
  ) {
    super(message)
  }
}

/**
 * Reconcile only candidate identity. Scientific fidelity, changed paths and the
 * meaning of the Coder report belong to the relevant Sessions.
 */
export async function verifyActiveCandidateProjection(input: {
  readonly frozen: FrozenRevision
  readonly state: RuntimeState
  readonly laneId: string
}): Promise<VerifiedActiveCandidate> {
  const { frozen, state, laneId } = input
  const candidate = state.candidates[laneId]
  if (candidate === undefined) fail(`Lane ${laneId} has no active candidate`)
  if (state.config === undefined
    || state.config.revision !== frozen.ref.revision
    || state.config.manifestHash !== frozen.ref.manifestHash
    || candidate.sourceRevision !== frozen.ref.revision) {
    fail(`Lane ${laneId} candidate does not belong to CURRENT`)
  }

  const lane = frozen.manifest.lanes.find(value => value.lane_id === laneId)
  const coder = state.roles[candidate.coderRoleId]
  if (lane === undefined
    || lane.coder_role_id !== candidate.coderRoleId
    || coder?.sessionId !== candidate.coderSessionId) {
    fail(`Lane ${laneId} candidate has no exact Coder binding`)
  }

  const expectedPath = candidateReceiptPath(
    frozen.manifest.authority_paths.lab_dir,
    candidate.assignmentId,
  )
  if (candidate.captureReceipt.path !== expectedPath) {
    fail(`Lane ${laneId} candidate receipt path is not deterministic`)
  }

  let snapshot: CandidateSnapshotReceipt
  try {
    snapshot = await readCandidateSnapshotReceipt(candidate.captureReceipt)
  } catch (error) {
    throw new CandidateRecoveryError(
      `Lane ${laneId} candidate receipt cannot be adopted: ${renderError(error)}`,
      'IO_FAILED',
    )
  }
  const worktree = await inspectLaneWorktree(frozen.manifest.authority_paths.lab_dir, laneId)
  if (snapshot.labId !== frozen.manifest.lab_id
    || snapshot.sourceRevision !== frozen.ref.revision
    || snapshot.manifestHash !== frozen.ref.manifestHash
    || snapshot.laneId !== laneId
    || snapshot.candidateId !== candidate.candidateId
    || snapshot.coderRoleId !== candidate.coderRoleId
    || snapshot.coderSessionId !== candidate.coderSessionId
    || snapshot.assignmentId !== candidate.assignmentId
    || snapshot.candidateSha !== candidate.candidateSha
    || snapshot.worktreePath !== worktree.receipt.worktreePath
    || snapshot.worktreeReceiptHash !== worktree.receipt.receiptHash
    || snapshot.baseSha !== worktree.receipt.baseSha
    || snapshot.capturedAt !== candidate.frozenAt
    || canonicalReference(snapshot.sourceReport)
      !== canonicalReference(candidate.sourceReport)) {
    fail(`Lane ${laneId} candidate receipt does not reproduce RuntimeState`)
  }
  return { snapshot }
}

function canonicalReference(
  value: { readonly path: string; readonly hash: string } | undefined,
): string {
  return value === undefined ? '' : `${value.path}\0${value.hash}`
}

function fail(message: string): never {
  throw new CandidateRecoveryError(message)
}

function renderError(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

