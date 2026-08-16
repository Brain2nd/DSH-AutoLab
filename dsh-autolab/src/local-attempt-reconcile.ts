import { isAbsolute, join, resolve } from 'node:path'

import {
  freezeAttemptReceiptArtifact,
  freezeAttemptStateArtifact,
  localAttemptDirectory,
  localAttemptRequestPath,
  readAttemptUncertainReceiptArtifactIfPresent,
  type ReadLocalAttemptIntent,
} from './attempt-artifacts.js'
import { canonicalJson, sha256 } from './integrity.js'
import type {
  ExitAttemptReceipt as LocalExitAttemptReceipt,
  LocalTmuxBlockerCode,
  LocalTmuxInspection,
  LocalTmuxPendingCode,
  StartedAttemptReceipt as LocalStartedAttemptReceipt,
} from './runner.js'
import {
  compileAttemptCompletionReceipt,
  compileAttemptStartedReceipt,
  compileAttemptUncertainReceipt,
  parseAttempt,
  parseRunSlotState,
  recordAttemptCompletion,
  recordAttemptOutcomeUnknown,
  recordAttemptStarted,
  type Attempt,
  type AttemptCompletionReceipt,
  type AttemptStartedReceipt,
  type AttemptUncertainReceipt,
  type FrozenRecord,
  type RunSlotAttemptTransition,
  type RunSlotState,
} from './trial.js'

type GenericAttemptReceipt =
  | AttemptStartedReceipt
  | AttemptCompletionReceipt
  | AttemptUncertainReceipt

export interface LocalAttemptReconcileInput {
  readonly runRoot: string
  readonly runSlotState: RunSlotState
  /** Frozen request/Attempt artifacts previously verified by readLocalAttemptIntent(). */
  readonly intent: ReadLocalAttemptIntent
  readonly inspection: LocalTmuxInspection
  /** Needed only for the first outcome-unknown observation. */
  readonly observedAt?: number
}

export interface LocalAttemptReconcileIdentity {
  readonly attemptId: string
  readonly launchNonce: string
  readonly requestSha256: string
}

export interface FrozenLocalAttemptReconcileRecord {
  readonly kind: 'started' | 'completion' | 'uncertain'
  readonly receipt: FrozenRecord<GenericAttemptReceipt> & { readonly path: string }
  /** Present only when this observation derived a new Attempt projection. */
  readonly attemptArtifact?: FrozenRecord<Attempt> & { readonly path: string }
}

export type LocalAttemptReconcileResult =
  | {
      readonly action: 'launch_required'
      readonly identity: LocalAttemptReconcileIdentity
      readonly launchPrepared: boolean
    }
  | {
      readonly action: 'await_started_receipt'
      readonly identity: LocalAttemptReconcileIdentity
      readonly launchPrepared: boolean
    }
  | {
      readonly action: 'blocked'
      readonly identity: LocalAttemptReconcileIdentity
      readonly blocker: {
        readonly code: LocalTmuxBlockerCode
        readonly message: string
      }
    }
  | {
      readonly action: 'pending'
      readonly identity: LocalAttemptReconcileIdentity
      readonly pending: {
        readonly code: LocalTmuxPendingCode
        readonly message: string
      }
    }
  | {
      readonly action:
        | 'record_started'
        | 'record_completion'
        | 'record_uncertain'
        | 'already_reconciled'
      readonly identity: LocalAttemptReconcileIdentity
      readonly inspectionStatus: 'running' | 'completed' | 'outcome_unknown'
      /** Frozen derivation records; these are not separate Controller CAS operations. */
      readonly records: readonly FrozenLocalAttemptReconcileRecord[]
      /** At most one aggregate CAS from the input RunSlot revision to the final projection. */
      readonly transition?: RunSlotAttemptTransition
    }

export class LocalAttemptReconcileError extends Error {
  readonly name = 'LocalAttemptReconcileError'

  constructor(
    message: string,
    readonly code: 'INVALID_INPUT' | 'IDENTITY_MISMATCH',
  ) {
    super(message)
  }
}

/**
 * Convert one already-completed local-tmux inspection into generic Attempt
 * artifacts and CAS-ready RunSlot transitions. It performs no launch, poll,
 * retry, or Controller mutation.
 */
export async function reconcileLocalTmuxInspection(
  input: LocalAttemptReconcileInput,
): Promise<LocalAttemptReconcileResult> {
  const current = validateInput(input)
  const identity = Object.freeze({
    attemptId: current.attempt_id,
    launchNonce: current.launch_nonce,
    requestSha256: current.request.sha256,
  })

  if (input.inspection.status === 'absent') {
    if (current.phase !== 'launching') {
      return blockedResult(
        identity,
        'RECEIPT_CORRUPT',
        `local launch evidence disappeared after Attempt ${current.attempt_id} advanced`,
      )
    }
    return Object.freeze({
      action: 'launch_required',
      identity,
      launchPrepared: input.inspection.launchPrepared,
    })
  }
  if (input.inspection.status === 'launching') {
    if (current.phase !== 'launching'
      && !(current.phase === 'outcome_unknown' && current.started_receipt === undefined)) {
      return blockedResult(
        identity,
        'RECEIPT_CORRUPT',
        `started.json disappeared after Attempt ${current.attempt_id} recorded a start`,
      )
    }
    return Object.freeze({
      action: 'await_started_receipt',
      identity,
      launchPrepared: input.inspection.launchPrepared,
    })
  }
  if (input.inspection.status === 'blocked') {
    return Object.freeze({
      action: 'blocked',
      identity,
      blocker: Object.freeze({
        code: input.inspection.code,
        message: input.inspection.message,
      }),
    })
  }
  if (input.inspection.status === 'pending') {
    return Object.freeze({
      action: 'pending',
      identity,
      pending: Object.freeze({
        code: input.inspection.code,
        message: input.inspection.message,
      }),
    })
  }

  const observedStarted = input.inspection.started
  if (observedStarted === undefined) {
    if (input.inspection.status !== 'outcome_unknown') {
      invalid('only an outcome-unknown inspection may omit started.json')
    }
    if (current.phase === 'running'
      || current.phase === 'terminal'
      || (current.phase === 'outcome_unknown' && current.started_receipt !== undefined)) {
      return blockedResult(
        identity,
        'RECEIPT_CORRUPT',
        `started.json disappeared after Attempt ${current.attempt_id} recorded a start`,
      )
    }
  } else {
    assertStartedIdentity(input.intent, observedStarted)
  }
  if (current.phase === 'terminal' && input.inspection.status !== 'completed') {
    return blockedResult(
      identity,
      'RECEIPT_CORRUPT',
      `exit.json disappeared after Attempt ${current.attempt_id} reached terminal`,
    )
  }
  if (input.inspection.status === 'completed') {
    assertExitIdentity(input.intent, input.inspection.started, input.inspection.exit)
  }

  let state = parseRunSlotState(input.runSlotState)
  let attempt = current
  const originalState = state
  const originalAttempt = attempt
  const records: FrozenLocalAttemptReconcileRecord[] = []
  if (observedStarted !== undefined) {
    const started = compileGenericStartedReceipt(attempt, observedStarted)
    const startedPath = receiptPath(input.runRoot, attempt.attempt_id, 'started')

    if (attempt.phase === 'terminal') {
      assertExistingStarted(attempt, started, startedPath)
      records.push(await freezeReceiptRecord(
        input.runRoot,
        attempt.attempt_id,
        'started',
        started,
      ))
    } else if (attempt.phase === 'outcome_unknown'
      && attempt.started_receipt !== undefined
      && input.inspection.status !== 'running') {
      assertExistingStarted(attempt, started, startedPath)
      records.push(await freezeReceiptRecord(
        input.runRoot,
        attempt.attempt_id,
        'started',
        started,
      ))
    } else {
      const startedTransition = recordAttemptStarted(
        state,
        state.revision,
        attempt,
        started,
        startedPath,
      )
      if (transitionChanged(state, attempt, startedTransition)) {
        records.push(input.inspection.status === 'running'
          ? await freezeRecord(input.runRoot, 'started', started, startedTransition)
          : await freezeReceiptRecord(
              input.runRoot,
              attempt.attempt_id,
              'started',
              started,
            ))
        state = startedTransition.state
        attempt = startedTransition.attempt
      } else {
        records.push(await freezeReceiptRecord(
          input.runRoot,
          attempt.attempt_id,
          'started',
          started,
        ))
      }
    }
  }

  if (input.inspection.status === 'running') {
    return finish(
      'record_started',
      'running',
      identity,
      records,
      aggregateTransition(originalState, originalAttempt, state, attempt),
    )
  }

  if (input.inspection.status === 'completed') {
    const completion = compileGenericCompletionReceipt(attempt, input.inspection.exit)
    const completionPath = receiptPath(input.runRoot, attempt.attempt_id, 'completion')
    const transition = recordAttemptCompletion(
      state,
      state.revision,
      attempt,
      completion,
      completionPath,
    )
    if (transitionChanged(state, attempt, transition)) {
      records.push(await freezeRecord(input.runRoot, 'completion', completion, transition))
      state = transition.state
      attempt = transition.attempt
    } else {
      records.push(await freezeReceiptRecord(
        input.runRoot,
        attempt.attempt_id,
        'completion',
        completion,
      ))
    }
    return finish(
      'record_completion',
      'completed',
      identity,
      records,
      aggregateTransition(originalState, originalAttempt, state, attempt),
    )
  }

  const existingUncertain = await readAttemptUncertainReceiptArtifactIfPresent(
    input.runRoot,
    attempt.attempt_id,
  )
  if (existingUncertain !== undefined) assertExistingUncertain(attempt, existingUncertain)
  const uncertain = existingUncertain ?? compileGenericUncertainReceipt(
    attempt,
    input.inspection.reason,
    attempt.phase === 'outcome_unknown'
      ? attempt.unknown_since
      : requireObservedAt(input.observedAt),
  )
  const uncertainPath = receiptPath(input.runRoot, attempt.attempt_id, 'uncertain')
  const transition = recordAttemptOutcomeUnknown(
    state,
    state.revision,
    attempt,
    uncertain,
    uncertainPath,
  )
  if (transitionChanged(state, attempt, transition)) {
    records.push(await freezeRecord(input.runRoot, 'uncertain', uncertain, transition))
    state = transition.state
    attempt = transition.attempt
  } else {
    records.push(await freezeReceiptRecord(
      input.runRoot,
      attempt.attempt_id,
      'uncertain',
      uncertain,
    ))
  }
  return finish(
    'record_uncertain',
    'outcome_unknown',
    identity,
    records,
    aggregateTransition(originalState, originalAttempt, state, attempt),
  )
}

function validateInput(input: LocalAttemptReconcileInput): Attempt {
  if (!isAbsolute(input.runRoot) || resolve(input.runRoot) !== input.runRoot) {
    invalid('runRoot must be normalized and absolute')
  }
  const state = parseRunSlotState(input.runSlotState)
  const attempt = parseAttempt(input.intent.attempt.value)
  const request = input.intent.request
  const attemptText = canonicalJson(attempt)
  const requestText = canonicalJson(request.value)
  if (input.intent.attempt.canonicalJson !== attemptText
    || input.intent.attempt.sha256 !== sha256(attemptText)
    || request.canonicalJson !== requestText
    || request.sha256 !== sha256(requestText)
    || request.path !== localAttemptRequestPath(input.runRoot, attempt.attempt_id)
    || input.intent.launchPlan.attemptDirectory !== localAttemptDirectory(
      input.runRoot,
      attempt.attempt_id,
    )
    || request.value.attempt_id !== attempt.attempt_id
    || request.value.attempt_ordinal !== attempt.attempt_ordinal
    || request.value.launch_nonce !== attempt.launch_nonce
    || request.value.candidate_sha !== attempt.candidate_sha
    || request.value.runslot_id !== attempt.runslot_id
    || request.value.trial_id !== attempt.trial_id
    || request.value.config_revision !== attempt.config_revision
    || request.value.cwd !== attempt.cwd
    || request.value.host_id !== attempt.host_id
    || request.value.runner.id !== attempt.runner.id
    || request.value.runner.version !== attempt.runner.version
    || request.value.runner.sha256 !== attempt.runner.sha256
    || attempt.request.kind !== 'runner_request'
    || attempt.request.sha256 !== request.sha256
    || input.intent.launchPlan.attemptId !== attempt.attempt_id
    || input.intent.launchPlan.launchNonce !== attempt.launch_nonce
    || input.intent.launchPlan.candidateSha !== attempt.candidate_sha
    || input.intent.launchPlan.cwd !== attempt.cwd
    || input.intent.launchPlan.envHash !== attempt.env_sha256
    || input.intent.launchPlan.attemptDirectory !== request.value.attempt_directory
    || input.intent.launchPlan.issuedAt !== request.value.issued_at
    || canonicalJson(input.intent.launchPlan.command) !== canonicalJson(request.value.command)
    || canonicalJson(input.intent.launchPlan.env) !== canonicalJson(request.value.env)
    || state.status === 'pending'
    || state.attempt_id !== attempt.attempt_id
    || state.attempt_ordinal !== attempt.attempt_ordinal
    || state.attempt_identity_sha256 !== attemptIdentitySha256(attempt)
    || state.runslot_id !== attempt.runslot_id
    || state.trial_id !== attempt.trial_id
    || state.runslot_contract_sha256 !== attempt.runslot_contract_sha256
    || state.launch_nonces.at(-1) !== attempt.launch_nonce) {
    mismatch('Frozen request, RunSlot state, Attempt, and launch intent do not match')
  }
  const phaseMatches = state.status === 'attempt_active'
    ? attempt.phase === 'launching' || attempt.phase === 'running'
    : state.status === 'outcome_unknown'
      ? attempt.phase === 'outcome_unknown'
      : attempt.phase === 'terminal'
  if (!phaseMatches) mismatch('RunSlot status does not match the current Attempt phase')
  return attempt
}

function compileGenericStartedReceipt(
  attempt: Attempt,
  started: LocalStartedAttemptReceipt,
): FrozenRecord<AttemptStartedReceipt> {
  return compileAttemptStartedReceipt({
    version: 1,
    type: 'attempt_started',
    attempt_id: attempt.attempt_id,
    launch_nonce: attempt.launch_nonce,
    candidate_sha: attempt.candidate_sha,
    request_sha256: attempt.request.sha256,
    started_at: started.startedAt,
    process: {
      pid: started.pid,
      pgid: started.pgid,
      // The raw receipt hash commits pane, wrapper command, host, boot, and OS start identity.
      start_identity: started.receiptHash,
      host_boot_id: started.bootId,
      tmux_session: started.tmuxSession,
    },
  })
}

function compileGenericCompletionReceipt(
  attempt: Attempt,
  exit: LocalExitAttemptReceipt,
): FrozenRecord<AttemptCompletionReceipt> {
  const succeeded = exit.outcome === 'exited' && exit.exitCode === 0
  return compileAttemptCompletionReceipt({
    version: 1,
    type: 'attempt_completion',
    attempt_id: attempt.attempt_id,
    launch_nonce: attempt.launch_nonce,
    candidate_sha: attempt.candidate_sha,
    request_sha256: attempt.request.sha256,
    completed_at: exit.finishedAt,
    completion_identity: exit.receiptHash,
    technical_outcome: succeeded ? 'succeeded' : 'failed',
    ...(succeeded ? {} : {
      technical_detail: {
        kind: 'runner',
        code: exitFailureCode(exit),
        ...(exit.outcome === 'spawn_failed' ? { detail: exit.spawnError } : {}),
      },
    }),
    artifacts: [{ kind: 'log', path: exit.logPath }],
  })
}

function compileGenericUncertainReceipt(
  attempt: Attempt,
  reason: string,
  observedAt: number,
): FrozenRecord<AttemptUncertainReceipt> {
  return compileAttemptUncertainReceipt({
    version: 1,
    type: 'attempt_outcome_unknown',
    attempt_id: attempt.attempt_id,
    launch_nonce: attempt.launch_nonce,
    candidate_sha: attempt.candidate_sha,
    request_sha256: attempt.request.sha256,
    observed_at: observedAt,
    technical_detail: {
      kind: 'runner',
      code: 'local_tmux_outcome_unknown',
      detail: reason,
    },
  })
}

function assertStartedIdentity(
  intent: ReadLocalAttemptIntent,
  started: LocalStartedAttemptReceipt,
): void {
  assertRawReceiptHash('started', started)
  const plan = intent.launchPlan
  if (started.attemptId !== plan.attemptId
    || started.launchNonce !== plan.launchNonce
    || started.candidateSha !== plan.candidateSha
    || started.tmuxSession !== plan.tmuxSession
    || started.commandHash !== plan.commandHash
    || started.cwd !== plan.cwd
    || started.cwdHash !== plan.cwdHash
    || started.envHash !== plan.envHash
    || started.launchIdentityHash !== plan.launchIdentityHash
    || started.launchSpecReceiptHash !== plan.launchSpec.receiptHash
    || started.logPath !== plan.paths.log) {
    mismatch('Raw local-tmux started receipt does not match the frozen launch intent')
  }
}

function assertExitIdentity(
  intent: ReadLocalAttemptIntent,
  started: LocalStartedAttemptReceipt,
  exit: LocalExitAttemptReceipt,
): void {
  assertRawReceiptHash('exit', exit)
  const plan = intent.launchPlan
  if (exit.attemptId !== started.attemptId
    || exit.launchNonce !== started.launchNonce
    || exit.candidateSha !== started.candidateSha
    || exit.tmuxSession !== started.tmuxSession
    || exit.commandHash !== started.commandHash
    || exit.cwdHash !== plan.cwdHash
    || exit.envHash !== started.envHash
    || exit.launchIdentityHash !== started.launchIdentityHash
    || exit.startedReceiptHash !== started.receiptHash
    || exit.tmuxPaneId !== started.tmuxPaneId
    || exit.pid !== started.pid
    || exit.pgid !== started.pgid
    || exit.processStartId !== started.processStartId
    || exit.processCommandHash !== started.processCommandHash
    || exit.hostname !== started.hostname
    || exit.bootId !== started.bootId
    || exit.logPath !== plan.paths.log
    || exit.finishedAt < started.startedAt) {
    mismatch('Raw local-tmux exit receipt does not match its started receipt and launch intent')
  }
}

function assertRawReceiptHash(
  kind: 'started' | 'exit',
  receipt: LocalStartedAttemptReceipt | LocalExitAttemptReceipt,
): void {
  const { receiptHash, ...body } = receipt
  const domain = kind === 'started' ? 'started' : 'exit'
  const expected = sha256(`autolab-local-tmux-${domain}-v1\0${canonicalJson(body)}`)
  if (receiptHash !== expected) mismatch(`Raw local-tmux ${kind} receipt hash is invalid`)
}

function assertExistingStarted(
  attempt: Attempt,
  receipt: FrozenRecord<AttemptStartedReceipt>,
  path: string,
): void {
  if ((attempt.phase !== 'outcome_unknown' && attempt.phase !== 'terminal')
    || attempt.started_at !== receipt.value.started_at
    || attempt.started_receipt?.path !== path
    || attempt.started_receipt.sha256 !== receipt.sha256
    || canonicalJson(attempt.process ?? null) !== canonicalJson(receipt.value.process ?? null)) {
    mismatch('Current Attempt does not project the exact raw local-tmux started receipt')
  }
}

function assertExistingUncertain(
  attempt: Attempt,
  receipt: FrozenRecord<AttemptUncertainReceipt>,
): void {
  const value = receipt.value
  if (value.attempt_id !== attempt.attempt_id
    || value.launch_nonce !== attempt.launch_nonce
    || value.candidate_sha !== attempt.candidate_sha
    || value.request_sha256 !== attempt.request.sha256
    || value.observed_at < ('started_at' in attempt
      ? attempt.started_at ?? attempt.launched_at
      : attempt.launched_at)
    || value.technical_detail.kind !== 'runner'
    || value.technical_detail.code !== 'local_tmux_outcome_unknown'
    || (attempt.phase === 'outcome_unknown'
      && (attempt.unknown_since !== value.observed_at
        || attempt.uncertainty_receipt.sha256 !== receipt.sha256))) {
    mismatch('Existing uncertain receipt does not match the current Attempt identity')
  }
}

async function freezeGenericReceipt<T extends GenericAttemptReceipt>(
  runRoot: string,
  attemptId: string,
  kind: 'started' | 'completion' | 'uncertain',
  receipt: FrozenRecord<T>,
): Promise<FrozenRecord<T> & { readonly path: string }> {
  const reference = await freezeAttemptReceiptArtifact(runRoot, attemptId, kind, receipt)
  return Object.freeze({ ...receipt, path: reference.path })
}

async function freezeRecord<T extends GenericAttemptReceipt>(
  runRoot: string,
  kind: FrozenLocalAttemptReconcileRecord['kind'],
  receipt: FrozenRecord<T>,
  transition: RunSlotAttemptTransition,
): Promise<FrozenLocalAttemptReconcileRecord> {
  const [frozenReceipt, attemptArtifact] = await Promise.all([
    freezeGenericReceipt(runRoot, transition.attempt.attempt_id, kind, receipt),
    freezeAttemptStateArtifact(runRoot, transition.state.revision, transition.attempt),
  ])
  return Object.freeze({
    kind,
    receipt: frozenReceipt,
    attemptArtifact,
  })
}

async function freezeReceiptRecord<T extends GenericAttemptReceipt>(
  runRoot: string,
  attemptId: string,
  kind: FrozenLocalAttemptReconcileRecord['kind'],
  receipt: FrozenRecord<T>,
): Promise<FrozenLocalAttemptReconcileRecord> {
  return Object.freeze({
    kind,
    receipt: await freezeGenericReceipt(runRoot, attemptId, kind, receipt),
  })
}

function receiptPath(
  runRoot: string,
  attemptId: string,
  kind: 'started' | 'completion' | 'uncertain',
): string {
  return join(localAttemptDirectory(runRoot, attemptId), 'receipts', `${kind}.json`)
}

function transitionChanged(
  state: RunSlotState,
  attempt: Attempt,
  transition: RunSlotAttemptTransition,
): boolean {
  return canonicalJson(state) !== canonicalJson(transition.state)
    || canonicalJson(attempt) !== canonicalJson(transition.attempt)
}

function attemptIdentitySha256(attempt: Attempt): string {
  return sha256(canonicalJson({
    version: 1,
    attempt_id: attempt.attempt_id,
    attempt_ordinal: attempt.attempt_ordinal,
    ...(attempt.predecessor_attempt_id === undefined ? {} : {
      predecessor_attempt_id: attempt.predecessor_attempt_id,
    }),
    trial_id: attempt.trial_id,
    runslot_id: attempt.runslot_id,
    trial_contract_sha256: attempt.trial_contract_sha256,
    runslot_contract_sha256: attempt.runslot_contract_sha256,
    candidate_sha: attempt.candidate_sha,
    config_revision: attempt.config_revision,
    request: attempt.request,
    cwd: attempt.cwd,
    env_sha256: attempt.env_sha256,
    runner: attempt.runner,
    host_id: attempt.host_id,
    launch_nonce: attempt.launch_nonce,
    launched_at: attempt.launched_at,
    ...(attempt.gpu_lease === undefined ? {} : { gpu_lease: attempt.gpu_lease }),
    ...(attempt.remote_connection === undefined ? {} : {
      remote_connection: attempt.remote_connection,
    }),
    ...(attempt.adapter_checkpoint_identity === undefined ? {} : {
      adapter_checkpoint_identity: attempt.adapter_checkpoint_identity,
    }),
  }))
}

function aggregateTransition(
  originalState: RunSlotState,
  originalAttempt: Attempt,
  finalState: RunSlotState,
  finalAttempt: Attempt,
): RunSlotAttemptTransition | undefined {
  if (!transitionChanged(originalState, originalAttempt, {
    expected_revision: originalState.revision,
    state: finalState,
    attempt: finalAttempt,
  })) return undefined
  return Object.freeze({
    expected_revision: originalState.revision,
    state: finalState,
    attempt: finalAttempt,
  })
}

function exitFailureCode(exit: LocalExitAttemptReceipt): string {
  if (exit.outcome === 'exited') return `exit_code_${String(exit.exitCode)}`
  if (exit.outcome === 'signaled') return `signal_${String(exit.signal)}`
  return 'spawn_failed'
}

function finish(
  action: 'record_started' | 'record_completion' | 'record_uncertain',
  inspectionStatus: 'running' | 'completed' | 'outcome_unknown',
  identity: LocalAttemptReconcileIdentity,
  records: readonly FrozenLocalAttemptReconcileRecord[],
  transition: RunSlotAttemptTransition | undefined,
): LocalAttemptReconcileResult {
  return Object.freeze({
    action: transition === undefined ? 'already_reconciled' : action,
    identity,
    inspectionStatus,
    records: Object.freeze([...records]),
    ...(transition === undefined ? {} : { transition }),
  })
}

function blockedResult(
  identity: LocalAttemptReconcileIdentity,
  code: LocalTmuxBlockerCode,
  message: string,
): LocalAttemptReconcileResult {
  return Object.freeze({
    action: 'blocked',
    identity,
    blocker: Object.freeze({ code, message }),
  })
}

function requireObservedAt(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || value === undefined || value < 0) {
    invalid('the first outcome-unknown observation requires a non-negative safe observedAt')
  }
  return value
}

function invalid(message: string): never {
  throw new LocalAttemptReconcileError(message, 'INVALID_INPUT')
}

function mismatch(message: string): never {
  throw new LocalAttemptReconcileError(message, 'IDENTITY_MISMATCH')
}
