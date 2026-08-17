import type { FrozenRevision } from './artifacts.js'
import {
  freezeInitialLocalAttempt,
  freezeRetryLocalAttempt,
  type FrozenLocalAttemptIntent,
  type ReadLocalAttemptIntent,
  readLocalAttemptIntent,
} from './attempt-artifacts.js'
import {
  provisionDetachedRunCheckout,
  type DetachedRunCheckout,
} from './run-checkout.js'
import { canonicalJson } from './integrity.js'
import { activeTrialSchema, type ActiveCandidate, type ActiveTrial } from './state.js'
import { freezeTrialArtifacts, type FrozenTrialArtifacts } from './trial-artifacts.js'
import { createRunSlotState } from './trial.js'

export interface LocalTrialRunSlotInput {
  readonly runSlotId: string
  /** Lab-authored execution meaning. Runtime preserves it without interpretation. */
  readonly contract?: unknown
}

export interface PrepareInitialLocalAttemptInput {
  readonly frozen: FrozenRevision
  readonly candidate: ActiveCandidate
  readonly laneId: string
  readonly trialId: string
  /** Lab-authored scientific contract. Runtime preserves it without interpretation. */
  readonly trialContract: unknown
  readonly runSlots: readonly LocalTrialRunSlotInput[]
  readonly selectedRunSlotId: string
  readonly hostId: string
  readonly command: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly runtimePokeFile: string
  /** Stable time supplied from the current durable RuntimeState. */
  readonly anchoredAt: number
}

export interface PreparedInitialLocalAttempt {
  readonly artifacts: FrozenTrialArtifacts
  readonly intent: FrozenLocalAttemptIntent
  readonly checkout: DetachedRunCheckout
  readonly projection: ActiveTrial
}

export interface PrepareRetryLocalAttemptInput {
  readonly frozen: FrozenRevision
  readonly trialId: string
  /** Exact active Trial projection from the caller's current RuntimeState. */
  readonly trial: ActiveTrial
  readonly runSlotId: string
  readonly hostId: string
  readonly command: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly runtimePokeFile: string
}

export type VerifyRetryLocalAttemptReplayInput = Omit<
  PrepareRetryLocalAttemptInput,
  'runtimePokeFile'
>

export interface PreparedRetryLocalAttempt {
  readonly previous: ReadLocalAttemptIntent
  readonly intent: FrozenLocalAttemptIntent
  readonly checkout: DetachedRunCheckout
  readonly projection: ActiveTrial
}

export class AttemptLaunchError extends Error {
  readonly name = 'AttemptLaunchError'

  constructor(
    message: string,
    readonly code: 'IDENTITY_MISMATCH' | 'INVALID_INPUT',
  ) {
    super(message)
  }
}

/**
 * Materialize one Controller-selected Trial and its first local Attempt before
 * the caller publishes a short RuntimeState CAS. Scientific contracts remain
 * opaque; only frozen Candidate/CURRENT/RunSlot/checkout identities are joined.
 */
export async function prepareInitialLocalAttempt(
  input: PrepareInitialLocalAttemptInput,
): Promise<PreparedInitialLocalAttempt> {
  assertIdentity(input)

  const artifacts = await freezeTrialArtifacts(input.frozen.manifest.execution.run_root, {
    version: 1,
    trial_id: input.trialId,
    lane_id: input.laneId,
    candidate_sha: input.candidate.candidateSha,
    config_revision: input.frozen.ref.revision,
    contract: input.trialContract,
    run_slots: input.runSlots.map(slot => ({
      runslot_id: slot.runSlotId,
      ...(slot.contract === undefined ? {} : { contract: slot.contract }),
    })),
    created_at: input.anchoredAt,
  })
  const selected = artifacts.runSlots[input.selectedRunSlotId]
  if (selected === undefined) {
    throw new AttemptLaunchError(
      `selected RunSlot ${JSON.stringify(input.selectedRunSlotId)} is not in the Trial`,
      'INVALID_INPUT',
    )
  }

  const pendingStates = Object.fromEntries(Object.entries(artifacts.runSlots).map(([
    runSlotId,
    runSlot,
  ]) => [runSlotId, createRunSlotState(runSlot)]))
  const intent = await freezeInitialLocalAttempt({
    frozen: input.frozen,
    trial: artifacts.trial,
    runSlot: selected,
    runSlotState: pendingStates[input.selectedRunSlotId]!,
    hostId: input.hostId,
    command: input.command,
    env: input.env,
    runtimePokeFile: input.runtimePokeFile,
    issuedAt: input.anchoredAt,
  })
  const checkout = await provisionDetachedRunCheckout({
    repositoryPath: input.frozen.manifest.repository.path,
    checkoutPath: intent.checkoutPath,
    candidateSha: input.candidate.candidateSha,
    attemptId: intent.attempt.value.attempt_id,
    now: input.anchoredAt,
  })

  const runSlots = Object.fromEntries(Object.entries(artifacts.runSlots).map(([
    runSlotId,
    runSlot,
  ]) => {
    if (runSlotId !== input.selectedRunSlotId) {
      return [runSlotId, {
        contract: { path: runSlot.path, hash: runSlot.sha256 },
        state: pendingStates[runSlotId]!,
      }]
    }
    return [runSlotId, {
      contract: { path: runSlot.path, hash: runSlot.sha256 },
      state: intent.transition.state,
      activeAttempt: {
        attemptId: intent.attempt.value.attempt_id,
        phase: intent.attempt.value.phase,
        path: intent.attempt.path,
        hash: intent.attempt.sha256,
        checkout: {
          path: checkout.receiptPath,
          hash: checkout.receiptSha256,
        },
      },
    }]
  }))
  const projection: ActiveTrial = {
    version: 1,
    // The Trial descends from the exact frozen candidate capture, so it
    // carries the CANDIDATE's source revision (an earlier committed revision
    // remains valid after CURRENT advances).
    sourceRevision: input.candidate.sourceRevision,
    laneId: input.laneId,
    candidateId: input.candidate.candidateId,
    candidateSha: input.candidate.candidateSha,
    contract: { path: artifacts.trial.path, hash: artifacts.trial.sha256 },
    runSlots,
  }
  return Object.freeze({ artifacts, intent, checkout, projection })
}

/**
 * Materialize one Controller-selected technical retry before its short CAS.
 * The prior terminal Attempt is read only through its exact active reference;
 * Trial/RunSlot/Candidate lineage is preserved and scientific content is not read.
 */
export async function prepareRetryLocalAttempt(
  input: PrepareRetryLocalAttemptInput,
): Promise<PreparedRetryLocalAttempt> {
  const trial = activeTrialSchema.parse(input.trial)
  const slot = assertRetryProjection(input, trial)
  const active = slot.activeAttempt!
  const previous = await readLocalAttemptIntent({
    runRoot: input.frozen.manifest.execution.run_root,
    activeAttempt: { path: active.path, hash: active.hash },
  })
  assertRetryAttemptIdentity(input, trial, previous)

  const intent = await freezeRetryLocalAttempt({
    frozen: input.frozen,
    previous,
    runSlotState: slot.state,
    hostId: input.hostId,
    command: input.command,
    env: input.env,
    runtimePokeFile: input.runtimePokeFile,
  })
  const checkout = await provisionDetachedRunCheckout({
    repositoryPath: input.frozen.manifest.repository.path,
    checkoutPath: intent.checkoutPath,
    candidateSha: trial.candidateSha,
    attemptId: intent.attempt.value.attempt_id,
    now: intent.request.value.issued_at,
  })
  const projection = activeTrialSchema.parse({
    ...trial,
    runSlots: {
      ...trial.runSlots,
      [input.runSlotId]: {
        ...slot,
        state: intent.transition.state,
        activeAttempt: {
          attemptId: intent.attempt.value.attempt_id,
          phase: intent.attempt.value.phase,
          path: intent.attempt.path,
          hash: intent.attempt.sha256,
          checkout: {
            path: checkout.receiptPath,
            hash: checkout.receiptSha256,
          },
        },
      },
    },
  })
  return Object.freeze({ previous, intent, checkout, projection })
}

/**
 * Verify that an already-active projection is the exact retry requested by
 * this Controller call. This is an adopt/inspect boundary only: no process is
 * launched here and no experiment artifact is opened.
 */
export async function verifyRetryLocalAttemptReplay(
  input: VerifyRetryLocalAttemptReplayInput,
): Promise<ReadLocalAttemptIntent> {
  const trial = activeTrialSchema.parse(input.trial)
  const slot = trial.runSlots[input.runSlotId]
  const active = slot?.activeAttempt
  const lane = input.frozen.manifest.lanes.find(candidate => candidate.lane_id === trial.laneId)
  if (trial.sourceRevision > input.frozen.ref.revision
    || lane === undefined
    || slot === undefined
    || (slot.state.status !== 'attempt_active' && slot.state.status !== 'outcome_unknown')
    || slot.state.trial_id !== input.trialId
    || active === undefined) {
    throw new AttemptLaunchError(
      'CURRENT, Trial, RunSlot, and active retry projection do not identify the same work',
      'IDENTITY_MISMATCH',
    )
  }

  const replay = await readLocalAttemptIntent({
    runRoot: input.frozen.manifest.execution.run_root,
    activeAttempt: { path: active.path, hash: active.hash },
  })
  const attempt = replay.attempt.value
  const request = replay.request.value
  if (attempt.attempt_ordinal <= 1
    || attempt.predecessor_attempt_id === undefined
    || attempt.attempt_id !== active.attemptId
    || attempt.trial_id !== input.trialId
    || attempt.runslot_id !== input.runSlotId
    || attempt.trial_contract_sha256 !== trial.contract.hash
    || attempt.runslot_contract_sha256 !== slot.contract.hash
    || attempt.candidate_sha !== trial.candidateSha
    || attempt.config_revision !== input.frozen.ref.revision
    || request.lab_id !== input.frozen.manifest.lab_id
    || request.config_revision !== input.frozen.ref.revision
    || request.host_id !== input.hostId
    || canonicalJson(request.command) !== canonicalJson(input.command)
    || canonicalJson(request.env) !== canonicalJson(input.env)) {
    throw new AttemptLaunchError(
      'Active Attempt is not the exact host, argv, environment, and retry lineage requested',
      'IDENTITY_MISMATCH',
    )
  }
  return replay
}

function assertIdentity(input: PrepareInitialLocalAttemptInput): void {
  const lane = input.frozen.manifest.lanes.find(candidate => candidate.lane_id === input.laneId)
  if (input.candidate.laneId !== input.laneId
    // A candidate frozen under an earlier committed revision remains valid
    // work for a Trial launched after CURRENT advanced (same <= policy as
    // state/packet/review verification).
    || input.candidate.sourceRevision > input.frozen.ref.revision
    || lane === undefined
    || lane.coder_role_id !== input.candidate.coderRoleId) {
    throw new AttemptLaunchError(
      'Candidate, Lane, and CURRENT revision do not identify the same work',
      'IDENTITY_MISMATCH',
    )
  }
  if (input.trialId.length === 0
    || input.selectedRunSlotId.length === 0
    || input.runSlots.length === 0
    || !Number.isSafeInteger(input.anchoredAt)
    || input.anchoredAt < input.candidate.frozenAt) {
    throw new AttemptLaunchError('Trial launch input is incomplete or unstable', 'INVALID_INPUT')
  }
}

function assertRetryProjection(
  input: PrepareRetryLocalAttemptInput,
  trial: ActiveTrial,
): ActiveTrial['runSlots'][string] {
  const slot = trial.runSlots[input.runSlotId]
  const lane = input.frozen.manifest.lanes.find(candidate => candidate.lane_id === trial.laneId)
  if (trial.sourceRevision > input.frozen.ref.revision
    || lane === undefined
    || slot === undefined
    || slot.state.status !== 'retryable'
    || slot.state.trial_id !== input.trialId
    || slot.activeAttempt?.phase !== 'terminal') {
    throw new AttemptLaunchError(
      'CURRENT, Trial, RunSlot, and terminal retry projection do not identify the same work',
      'IDENTITY_MISMATCH',
    )
  }
  if (input.trialId.length === 0
    || input.runSlotId.length === 0
  ) {
    throw new AttemptLaunchError('Technical retry input is incomplete or unstable', 'INVALID_INPUT')
  }
  return slot
}

function assertRetryAttemptIdentity(
  input: PrepareRetryLocalAttemptInput,
  trial: ActiveTrial,
  previous: ReadLocalAttemptIntent,
): void {
  const slot = trial.runSlots[input.runSlotId]!
  const active = slot.activeAttempt!
  const attempt = previous.attempt.value
  const request = previous.request.value
  if (attempt.phase !== 'terminal'
    || attempt.technical_outcome !== 'failed'
    || attempt.attempt_id !== active.attemptId
    || attempt.trial_id !== input.trialId
    || attempt.runslot_id !== input.runSlotId
    || attempt.trial_contract_sha256 !== trial.contract.hash
    || attempt.runslot_contract_sha256 !== slot.contract.hash
    || attempt.candidate_sha !== trial.candidateSha
    || attempt.config_revision !== input.frozen.ref.revision
    || request.lab_id !== input.frozen.manifest.lab_id
    || request.config_revision !== input.frozen.ref.revision) {
    throw new AttemptLaunchError(
      'Failed Attempt does not match the exact CURRENT Trial and RunSlot lineage',
      'IDENTITY_MISMATCH',
    )
  }
}
