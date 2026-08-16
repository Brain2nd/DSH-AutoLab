import { isAbsolute } from 'node:path'

import { z } from 'zod'

import { canonicalJson, sha256 } from './integrity.js'

const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const GIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
const id = z.string().min(1)
const hash = z.string().regex(SHA256_PATTERN)
const gitSha = z.string().regex(GIT_SHA_PATTERN)
const timestamp = z.number().int().nonnegative()
const positiveInteger = z.number().int().positive()
const absolutePath = z.string().min(1).refine(isAbsolute, 'path must be absolute')

export const componentIdentitySchema = z.object({
  id,
  version: id,
  sha256: hash,
}).strict()

export const artifactReferenceSchema = z.object({
  kind: z.enum(['artifact', 'log', 'checkpoint', 'exit']),
  path: absolutePath,
}).strict()

export const receiptReferenceSchema = z.object({
  path: absolutePath,
  sha256: hash,
}).strict()

const runSlotSpecSchema = z.object({
  runslot_id: id,
  /** Lab-specific execution meaning; Runtime preserves but never interprets it. */
  contract: z.json().optional(),
}).strict()

export const trialContractSchema = z.object({
  version: z.literal(1),
  trial_id: id,
  lane_id: id,
  candidate_sha: gitSha,
  config_revision: positiveInteger,
  /** The scientific experiment contract is selected explicitly and kept opaque. */
  contract: z.json(),
  run_slots: z.array(runSlotSpecSchema).min(1),
  created_at: timestamp,
}).strict().superRefine((trial, context) => {
  rejectDuplicates(
    trial.run_slots.map(slot => slot.runslot_id),
    'run_slots.runslot_id',
    context,
  )
})

export const runSlotContractSchema = z.object({
  version: z.literal(1),
  runslot_id: id,
  trial_id: id,
  trial_contract_sha256: hash,
  candidate_sha: gitSha,
  config_revision: positiveInteger,
  contract: z.json().optional(),
}).strict()

const runSlotStateIdentityShape = {
  version: z.literal(1),
  runslot_id: id,
  trial_id: id,
  runslot_contract_sha256: hash,
} as const

const pendingRunSlotStateSchema = z.object({
  ...runSlotStateIdentityShape,
  revision: z.literal(0),
  status: z.literal('pending'),
}).strict()

const occupiedRunSlotStateShape = {
  ...runSlotStateIdentityShape,
  revision: positiveInteger,
  attempt_id: id,
  attempt_ordinal: positiveInteger,
  attempt_identity_sha256: hash,
  attempt_ids: z.array(id).min(1),
  launch_nonces: z.array(id).min(1),
} as const

const activeRunSlotStateSchema = z.object({
  ...occupiedRunSlotStateShape,
  status: z.literal('attempt_active'),
}).strict().superRefine(validateRunSlotHistory)

const unknownRunSlotStateSchema = z.object({
  ...occupiedRunSlotStateShape,
  status: z.literal('outcome_unknown'),
}).strict().superRefine(validateRunSlotHistory)

const retryableRunSlotStateSchema = z.object({
  ...occupiedRunSlotStateShape,
  status: z.literal('retryable'),
}).strict().superRefine(validateRunSlotHistory)

const completedRunSlotStateSchema = z.object({
  ...occupiedRunSlotStateShape,
  status: z.literal('execution_complete'),
}).strict().superRefine(validateRunSlotHistory)

export const runSlotStateSchema = z.discriminatedUnion('status', [
  pendingRunSlotStateSchema,
  activeRunSlotStateSchema,
  unknownRunSlotStateSchema,
  retryableRunSlotStateSchema,
  completedRunSlotStateSchema,
])

const requestIdentitySchema = z.object({
  kind: z.enum(['command', 'runner_request']),
  sha256: hash,
}).strict()

const gpuLeaseSchema = z.object({
  gpu_uuid: id,
  lease_id: id,
  fencing_token: z.number().int().nonnegative(),
}).strict()

const remoteConnectionSchema = z.object({
  connection_identity: id,
}).strict()

const processIdentitySchema = z.object({
  pid: positiveInteger.optional(),
  pgid: positiveInteger.optional(),
  start_identity: id.optional(),
  host_boot_id: id.optional(),
  tmux_session: id.optional(),
}).strict().refine(
  process => Object.values(process).some(value => value !== undefined),
  'process identity cannot be empty',
)

const attemptCommonShape = {
  version: z.literal(1),
  attempt_id: id,
  attempt_ordinal: positiveInteger,
  predecessor_attempt_id: id.optional(),
  trial_id: id,
  runslot_id: id,
  trial_contract_sha256: hash,
  runslot_contract_sha256: hash,
  candidate_sha: gitSha,
  config_revision: positiveInteger,
  request: requestIdentitySchema,
  cwd: absolutePath,
  env_sha256: hash,
  runner: componentIdentitySchema,
  host_id: id,
  launch_nonce: id,
  launched_at: timestamp,
  gpu_lease: gpuLeaseSchema.optional(),
  remote_connection: remoteConnectionSchema.optional(),
  adapter_checkpoint_identity: id.optional(),
} as const

const technicalDetailSchema = z.object({
  kind: z.enum([
    'api',
    'hardware',
    'runner',
    'process',
    'transport',
    'cancelled',
    'unknown',
  ]),
  code: id,
  detail: id.optional(),
}).strict()

const launchingAttemptSchema = z.object({
  ...attemptCommonShape,
  phase: z.literal('launching'),
}).strict().superRefine(validateAttemptLineage)

const runningAttemptSchema = z.object({
  ...attemptCommonShape,
  phase: z.literal('running'),
  started_at: timestamp,
  started_receipt: receiptReferenceSchema,
  process: processIdentitySchema.optional(),
}).strict().superRefine((attempt, context) => {
  validateAttemptLineage(attempt, context)
  if (attempt.started_at < attempt.launched_at) {
    context.addIssue({ code: 'custom', message: 'started_at precedes launched_at' })
  }
})

const outcomeUnknownAttemptSchema = z.object({
  ...attemptCommonShape,
  phase: z.literal('outcome_unknown'),
  started_at: timestamp.optional(),
  started_receipt: receiptReferenceSchema.optional(),
  process: processIdentitySchema.optional(),
  unknown_since: timestamp,
  uncertainty_receipt: receiptReferenceSchema,
  technical_detail: technicalDetailSchema,
  incident: artifactReferenceSchema.optional(),
}).strict().superRefine((attempt, context) => {
  validateAttemptLineage(attempt, context)
  if ((attempt.started_at === undefined) !== (attempt.started_receipt === undefined)) {
    context.addIssue({
      code: 'custom',
      message: 'started_at and started_receipt must be present together',
    })
  }
  if (attempt.process !== undefined && attempt.started_receipt === undefined) {
    context.addIssue({ code: 'custom', message: 'process identity requires a started receipt' })
  }
  if (attempt.unknown_since < attempt.launched_at
    || (attempt.started_at !== undefined && attempt.unknown_since < attempt.started_at)) {
    context.addIssue({ code: 'custom', message: 'outcome_unknown time is not monotonic' })
  }
})

const terminalAttemptSchema = z.object({
  ...attemptCommonShape,
  phase: z.literal('terminal'),
  started_at: timestamp.optional(),
  started_receipt: receiptReferenceSchema.optional(),
  process: processIdentitySchema.optional(),
  completed_at: timestamp,
  completion_identity: id,
  completion_receipt: receiptReferenceSchema,
  technical_outcome: z.enum(['succeeded', 'failed']),
  technical_detail: technicalDetailSchema.optional(),
  artifacts: z.array(artifactReferenceSchema),
}).strict().superRefine((attempt, context) => {
  validateAttemptLineage(attempt, context)
  if ((attempt.started_at === undefined) !== (attempt.started_receipt === undefined)) {
    context.addIssue({
      code: 'custom',
      message: 'started_at and started_receipt must be present together',
    })
  }
  if (attempt.process !== undefined && attempt.started_receipt === undefined) {
    context.addIssue({ code: 'custom', message: 'process identity requires a started receipt' })
  }
  if (attempt.completed_at < attempt.launched_at
    || (attempt.started_at !== undefined && attempt.completed_at < attempt.started_at)) {
    context.addIssue({ code: 'custom', message: 'Attempt completion time is not monotonic' })
  }
  if ((attempt.technical_outcome === 'succeeded') === (attempt.technical_detail !== undefined)) {
    context.addIssue({
      code: 'custom',
      message: 'only failed Attempts require technical_detail',
    })
  }
})

export const attemptSchema = z.discriminatedUnion('phase', [
  launchingAttemptSchema,
  runningAttemptSchema,
  outcomeUnknownAttemptSchema,
  terminalAttemptSchema,
])

export const attemptStartedReceiptSchema = z.object({
  version: z.literal(1),
  type: z.literal('attempt_started'),
  attempt_id: id,
  launch_nonce: id,
  candidate_sha: gitSha,
  request_sha256: hash,
  started_at: timestamp,
  process: processIdentitySchema.optional(),
  gpu_lease: gpuLeaseSchema.optional(),
  remote_connection: remoteConnectionSchema.optional(),
  adapter_checkpoint_identity: id.optional(),
}).strict()

export const attemptCompletionReceiptSchema = z.object({
  version: z.literal(1),
  type: z.literal('attempt_completion'),
  attempt_id: id,
  launch_nonce: id,
  candidate_sha: gitSha,
  request_sha256: hash,
  completed_at: timestamp,
  completion_identity: id,
  technical_outcome: z.enum(['succeeded', 'failed']),
  technical_detail: technicalDetailSchema.optional(),
  artifacts: z.array(artifactReferenceSchema),
}).strict().superRefine((receipt, context) => {
  if ((receipt.technical_outcome === 'succeeded') === (receipt.technical_detail !== undefined)) {
    context.addIssue({
      code: 'custom',
      message: 'only failed receipts require technical_detail',
    })
  }
})

export const attemptUncertainReceiptSchema = z.object({
  version: z.literal(1),
  type: z.literal('attempt_outcome_unknown'),
  attempt_id: id,
  launch_nonce: id,
  candidate_sha: gitSha,
  request_sha256: hash,
  observed_at: timestamp,
  technical_detail: technicalDetailSchema,
  incident: artifactReferenceSchema.optional(),
}).strict()

export type TrialContract = z.infer<typeof trialContractSchema>
export type RunSlotContract = z.infer<typeof runSlotContractSchema>
export type RunSlotState = z.infer<typeof runSlotStateSchema>
export type Attempt = z.infer<typeof attemptSchema>
export type TerminalAttempt = z.infer<typeof terminalAttemptSchema>
export type OutcomeUnknownAttempt = z.infer<typeof outcomeUnknownAttemptSchema>
export type AttemptStartedReceipt = z.infer<typeof attemptStartedReceiptSchema>
export type AttemptCompletionReceipt = z.infer<typeof attemptCompletionReceiptSchema>
export type AttemptUncertainReceipt = z.infer<typeof attemptUncertainReceiptSchema>
export type ArtifactReference = z.infer<typeof artifactReferenceSchema>
export type ComponentIdentity = z.infer<typeof componentIdentitySchema>
export interface FrozenRecord<T> {
  readonly value: T
  readonly canonicalJson: string
  readonly sha256: string
}

export interface RunSlotAttemptTransition<TAttempt extends Attempt = Attempt> {
  /** CAS token: persist `state` only if the durable revision still equals this value. */
  readonly expected_revision: number
  readonly state: RunSlotState
  readonly attempt: TAttempt
}

export class TrialContractError extends Error {
  readonly name = 'TrialContractError'

  constructor(
    message: string,
    readonly code: 'INVALID_TRIAL' | 'RUNSLOT_NOT_FOUND' | 'IDENTITY_MISMATCH',
  ) {
    super(message)
  }
}

export class AttemptTransitionError extends Error {
  readonly name = 'AttemptTransitionError'

  constructor(
    message: string,
    readonly code:
      | 'INVALID_ATTEMPT'
      | 'INVALID_RECEIPT'
      | 'ILLEGAL_TRANSITION'
      | 'IDENTITY_MISMATCH'
      | 'RETRY_NOT_ALLOWED'
      | 'STALE_RUNSLOT_STATE',
  ) {
    super(message)
  }
}

export function parseTrialContract(value: unknown): TrialContract {
  return parseOrThrow(
    trialContractSchema,
    value,
    error => new TrialContractError(`invalid Trial contract: ${error.message}`, 'INVALID_TRIAL'),
  )
}

export function compileTrialContract(value: unknown): FrozenRecord<TrialContract> {
  return freezeRecord(parseTrialContract(value))
}

export function compileRunSlotContract(
  trialInput: FrozenRecord<TrialContract>,
  runSlotId: string,
): FrozenRecord<RunSlotContract> {
  const trial = validateFrozenRecord(trialInput, trialContractSchema, 'Trial contract')
  const slot = trial.value.run_slots.find(candidate => candidate.runslot_id === runSlotId)
  if (slot === undefined) {
    throw new TrialContractError(
      `RunSlot ${JSON.stringify(runSlotId)} is not declared by Trial ${JSON.stringify(trial.value.trial_id)}`,
      'RUNSLOT_NOT_FOUND',
    )
  }
  const value = parseOrThrow(
    runSlotContractSchema,
    {
      version: 1,
      runslot_id: slot.runslot_id,
      trial_id: trial.value.trial_id,
      trial_contract_sha256: trial.sha256,
      candidate_sha: trial.value.candidate_sha,
      config_revision: trial.value.config_revision,
      ...(slot.contract === undefined ? {} : { contract: slot.contract }),
    },
    error => new TrialContractError(`invalid RunSlot contract: ${error.message}`, 'INVALID_TRIAL'),
  )
  return freezeRecord(value)
}

export function createRunSlotState(
  runSlotInput: FrozenRecord<RunSlotContract>,
): RunSlotState {
  const runslot = validateFrozenRecord(runSlotInput, runSlotContractSchema, 'RunSlot contract')
  return parseRunSlotState({
    version: 1,
    runslot_id: runslot.value.runslot_id,
    trial_id: runslot.value.trial_id,
    runslot_contract_sha256: runslot.sha256,
    revision: 0,
    status: 'pending',
  })
}

export function parseRunSlotState(value: unknown): RunSlotState {
  return deepFreeze(parseOrThrow(
    runSlotStateSchema,
    value,
    error => new AttemptTransitionError(
      `invalid RunSlot state: ${error.message}`,
      'INVALID_ATTEMPT',
    ),
  ))
}

interface AttemptExecutionInput {
  readonly attempt_id: string
  readonly request: z.infer<typeof requestIdentitySchema>
  readonly cwd: string
  readonly env_sha256: string
  readonly runner: z.infer<typeof componentIdentitySchema>
  readonly host_id: string
  readonly launch_nonce: string
  readonly launched_at: number
  readonly gpu_lease?: z.infer<typeof gpuLeaseSchema>
  readonly remote_connection?: z.infer<typeof remoteConnectionSchema>
  readonly adapter_checkpoint_identity?: string
}

const attemptExecutionInputSchema = z.object({
  attempt_id: id,
  request: requestIdentitySchema,
  cwd: absolutePath,
  env_sha256: hash,
  runner: componentIdentitySchema,
  host_id: id,
  launch_nonce: id,
  launched_at: timestamp,
  gpu_lease: gpuLeaseSchema.optional(),
  remote_connection: remoteConnectionSchema.optional(),
  adapter_checkpoint_identity: id.optional(),
}).strict()

export function createInitialAttempt(
  runSlotInput: FrozenRecord<RunSlotContract>,
  stateInput: RunSlotState,
  expectedRevision: number,
  inputValue: AttemptExecutionInput,
): RunSlotAttemptTransition {
  const runslot = validateFrozenRecord(runSlotInput, runSlotContractSchema, 'RunSlot contract')
  const state = parseRunSlotState(stateInput)
  assertExpectedRunSlotRevision(state, expectedRevision)
  assertRunSlotStateContract(state, runslot)
  if (state.status !== 'pending') {
    throw new AttemptTransitionError(
      `RunSlot ${JSON.stringify(state.runslot_id)} already consumed its initial launch`,
      'ILLEGAL_TRANSITION',
    )
  }
  const input = parseAttemptExecutionInput(inputValue)
  const attempt = parseAttempt({
    version: 1,
    attempt_id: input.attempt_id,
    attempt_ordinal: 1,
    trial_id: runslot.value.trial_id,
    runslot_id: runslot.value.runslot_id,
    trial_contract_sha256: runslot.value.trial_contract_sha256,
    runslot_contract_sha256: runslot.sha256,
    candidate_sha: runslot.value.candidate_sha,
    config_revision: runslot.value.config_revision,
    request: input.request,
    cwd: input.cwd,
    env_sha256: input.env_sha256,
    runner: input.runner,
    host_id: input.host_id,
    launch_nonce: input.launch_nonce,
    launched_at: input.launched_at,
    ...(input.gpu_lease === undefined ? {} : { gpu_lease: input.gpu_lease }),
    ...(input.remote_connection === undefined ? {} : {
      remote_connection: input.remote_connection,
    }),
    ...(input.adapter_checkpoint_identity === undefined ? {} : {
      adapter_checkpoint_identity: input.adapter_checkpoint_identity,
    }),
    phase: 'launching',
  })
  return runSlotTransition(
    expectedRevision,
    advanceRunSlotState(state, attempt, 'attempt_active', true),
    attempt,
  )
}

export function parseAttempt(value: unknown): Attempt {
  return deepFreeze(parseOrThrow(
    attemptSchema,
    value,
    error => new AttemptTransitionError(`invalid Attempt: ${error.message}`, 'INVALID_ATTEMPT'),
  ))
}

export function compileAttemptStartedReceipt(
  value: unknown,
): FrozenRecord<AttemptStartedReceipt> {
  return freezeReceipt(attemptStartedReceiptSchema, value)
}

export function compileAttemptCompletionReceipt(
  value: unknown,
): FrozenRecord<AttemptCompletionReceipt> {
  return freezeReceipt(attemptCompletionReceiptSchema, value)
}

export function compileAttemptUncertainReceipt(
  value: unknown,
): FrozenRecord<AttemptUncertainReceipt> {
  return freezeReceipt(attemptUncertainReceiptSchema, value)
}

export function recordAttemptStarted(
  stateInput: RunSlotState,
  expectedRevision: number,
  attemptInput: Attempt,
  receiptInput: FrozenRecord<AttemptStartedReceipt>,
  receiptPath: string,
): RunSlotAttemptTransition {
  const state = parseRunSlotState(stateInput)
  assertExpectedRunSlotRevision(state, expectedRevision)
  const current = parseAttempt(attemptInput)
  assertRunSlotStateAttempt(
    state,
    current,
    current.phase === 'outcome_unknown' ? ['outcome_unknown'] : ['attempt_active'],
  )
  const attempt = transitionAttemptStarted(current, receiptInput, receiptPath)
  return runSlotTransition(
    expectedRevision,
    current.phase === 'running'
      ? state
      : advanceRunSlotState(state, attempt, 'attempt_active', false),
    attempt,
  )
}

function transitionAttemptStarted(
  attemptInput: Attempt,
  receiptInput: FrozenRecord<AttemptStartedReceipt>,
  receiptPath: string,
): Attempt {
  const attempt = parseAttempt(attemptInput)
  const receipt = validateFrozenReceipt(receiptInput, attemptStartedReceiptSchema)
  const reference = parseReceiptReference(receiptPath, receipt.sha256)

  if (attempt.phase === 'terminal') {
    throw new AttemptTransitionError(
      `Attempt ${JSON.stringify(attempt.attempt_id)} is already terminal`,
      'ILLEGAL_TRANSITION',
    )
  }
  assertReceiptIdentity(attempt, receipt.value)
  if (attempt.phase === 'running') {
    if (attempt.started_receipt.path === reference.path
      && attempt.started_receipt.sha256 === reference.sha256) {
      assertStartedProjection(attempt, receipt.value)
      return attempt
    }
    throw new AttemptTransitionError(
      `Attempt ${JSON.stringify(attempt.attempt_id)} already has another started receipt`,
      'ILLEGAL_TRANSITION',
    )
  }
  if (attempt.phase === 'outcome_unknown' && attempt.started_receipt !== undefined) {
    if (attempt.started_receipt.path !== reference.path
      || attempt.started_receipt.sha256 !== reference.sha256) {
      throw new AttemptTransitionError(
        `Attempt ${JSON.stringify(attempt.attempt_id)} already has another started receipt`,
        'ILLEGAL_TRANSITION',
      )
    }
    assertStartedProjection(attempt, receipt.value)
  }
  if (receipt.value.started_at < attempt.launched_at) {
    throw new AttemptTransitionError(
      'started receipt precedes launch intent',
      'IDENTITY_MISMATCH',
    )
  }
  const gpuLease = mergeObservedIdentity(
    attempt.gpu_lease,
    receipt.value.gpu_lease,
    'GPU lease',
  )
  const remote = mergeObservedIdentity(
    attempt.remote_connection,
    receipt.value.remote_connection,
    'remote connection',
  )
  const checkpointIdentity = mergeObservedScalar(
    attempt.adapter_checkpoint_identity,
    receipt.value.adapter_checkpoint_identity,
    'adapter checkpoint identity',
  )
  return parseAttempt({
    ...attemptBase(attempt),
    phase: 'running',
    started_at: receipt.value.started_at,
    started_receipt: reference,
    ...(receipt.value.process === undefined ? {} : { process: receipt.value.process }),
    ...(gpuLease === undefined ? {} : { gpu_lease: gpuLease }),
    ...(remote === undefined ? {} : { remote_connection: remote }),
    ...(checkpointIdentity === undefined ? {} : {
      adapter_checkpoint_identity: checkpointIdentity,
    }),
  })
}

export function recordAttemptOutcomeUnknown(
  stateInput: RunSlotState,
  expectedRevision: number,
  attemptInput: Attempt,
  receiptInput: FrozenRecord<AttemptUncertainReceipt>,
  receiptPath: string,
): RunSlotAttemptTransition<OutcomeUnknownAttempt> {
  const state = parseRunSlotState(stateInput)
  assertExpectedRunSlotRevision(state, expectedRevision)
  const current = parseAttempt(attemptInput)
  assertRunSlotStateAttempt(
    state,
    current,
    current.phase === 'outcome_unknown' ? ['outcome_unknown'] : ['attempt_active'],
  )
  const attempt = transitionAttemptOutcomeUnknown(current, receiptInput, receiptPath)
  return runSlotTransition(
    expectedRevision,
    current.phase === 'outcome_unknown'
      ? state
      : advanceRunSlotState(state, attempt, 'outcome_unknown', false),
    attempt,
  )
}

function transitionAttemptOutcomeUnknown(
  attemptInput: Attempt,
  receiptInput: FrozenRecord<AttemptUncertainReceipt>,
  receiptPath: string,
): OutcomeUnknownAttempt {
  const attempt = parseAttempt(attemptInput)
  const receipt = validateFrozenReceipt(receiptInput, attemptUncertainReceiptSchema)
  const reference = parseReceiptReference(receiptPath, receipt.sha256)

  if (attempt.phase === 'terminal') {
    throw new AttemptTransitionError(
      `Attempt ${JSON.stringify(attempt.attempt_id)} is already terminal`,
      'ILLEGAL_TRANSITION',
    )
  }
  assertReceiptIdentity(attempt, receipt.value)
  if (attempt.phase === 'outcome_unknown') {
    if (attempt.uncertainty_receipt.path === reference.path
      && attempt.uncertainty_receipt.sha256 === reference.sha256) {
      assertUncertainProjection(attempt, receipt.value)
      return attempt
    }
    throw new AttemptTransitionError(
      `Attempt ${JSON.stringify(attempt.attempt_id)} already has another uncertainty receipt`,
      'ILLEGAL_TRANSITION',
    )
  }
  if (receipt.value.observed_at < attempt.launched_at
    || (attempt.phase === 'running' && receipt.value.observed_at < attempt.started_at)) {
    throw new AttemptTransitionError('uncertainty receipt time is not monotonic', 'IDENTITY_MISMATCH')
  }
  return parseAttempt({
    ...attemptBase(attempt),
    phase: 'outcome_unknown',
    ...(attempt.phase === 'running' ? {
      started_at: attempt.started_at,
      started_receipt: attempt.started_receipt,
      ...(attempt.process === undefined ? {} : { process: attempt.process }),
    } : {}),
    unknown_since: receipt.value.observed_at,
    uncertainty_receipt: reference,
    technical_detail: receipt.value.technical_detail,
    ...(receipt.value.incident === undefined ? {} : { incident: receipt.value.incident }),
  }) as OutcomeUnknownAttempt
}

export function recordAttemptCompletion(
  stateInput: RunSlotState,
  expectedRevision: number,
  attemptInput: Attempt,
  receiptInput: FrozenRecord<AttemptCompletionReceipt>,
  receiptPath: string,
): RunSlotAttemptTransition<TerminalAttempt> {
  const state = parseRunSlotState(stateInput)
  assertExpectedRunSlotRevision(state, expectedRevision)
  const current = parseAttempt(attemptInput)
  const expectedStatuses: readonly RunSlotState['status'][] = current.phase === 'outcome_unknown'
    ? ['outcome_unknown']
    : current.phase === 'terminal'
      ? [current.technical_outcome === 'succeeded' ? 'execution_complete' : 'retryable']
      : ['attempt_active']
  assertRunSlotStateAttempt(state, current, expectedStatuses)
  const attempt = transitionAttemptCompletion(current, receiptInput, receiptPath)
  return runSlotTransition(
    expectedRevision,
    current.phase === 'terminal'
      ? state
      : advanceRunSlotState(
        state,
        attempt,
        attempt.technical_outcome === 'succeeded' ? 'execution_complete' : 'retryable',
        false,
      ),
    attempt,
  )
}

function transitionAttemptCompletion(
  attemptInput: Attempt,
  receiptInput: FrozenRecord<AttemptCompletionReceipt>,
  receiptPath: string,
): TerminalAttempt {
  const attempt = parseAttempt(attemptInput)
  const receipt = validateFrozenReceipt(receiptInput, attemptCompletionReceiptSchema)
  const reference = parseReceiptReference(receiptPath, receipt.sha256)

  if (attempt.phase === 'terminal') {
    if (attempt.completion_receipt.path === reference.path
      && attempt.completion_receipt.sha256 === reference.sha256) {
      assertReceiptIdentity(attempt, receipt.value)
      assertCompletionProjection(attempt, receipt.value)
      return attempt
    }
    throw new AttemptTransitionError(
      `Attempt ${JSON.stringify(attempt.attempt_id)} already has another completion receipt`,
      'ILLEGAL_TRANSITION',
    )
  }
  assertReceiptIdentity(attempt, receipt.value)
  if (receipt.value.completed_at < attempt.launched_at
    || (attempt.phase === 'running' && receipt.value.completed_at < attempt.started_at)) {
    throw new AttemptTransitionError('completion receipt time is not monotonic', 'IDENTITY_MISMATCH')
  }
  return parseAttempt({
    ...attemptBase(attempt),
    phase: 'terminal',
    ...((attempt.phase === 'running' || attempt.phase === 'outcome_unknown')
      && attempt.started_at !== undefined ? {
        started_at: attempt.started_at,
        started_receipt: attempt.started_receipt,
        ...(attempt.process === undefined ? {} : { process: attempt.process }),
      } : {}),
    completed_at: receipt.value.completed_at,
    completion_identity: receipt.value.completion_identity,
    completion_receipt: reference,
    technical_outcome: receipt.value.technical_outcome,
    ...(receipt.value.technical_detail === undefined ? {} : {
      technical_detail: receipt.value.technical_detail,
    }),
    artifacts: receipt.value.artifacts,
  }) as TerminalAttempt
}

export function createRetryAttempt(
  stateInput: RunSlotState,
  expectedRevision: number,
  previousInput: Attempt,
  inputValue: AttemptExecutionInput,
): RunSlotAttemptTransition {
  const state = parseRunSlotState(stateInput)
  assertExpectedRunSlotRevision(state, expectedRevision)
  const previous = parseAttempt(previousInput)
  if (state.status !== 'retryable') {
    throw new AttemptTransitionError(
      'only a mechanically failed RunSlot may create a technical retry',
      'RETRY_NOT_ALLOWED',
    )
  }
  assertRunSlotStateAttempt(state, previous, ['retryable'])
  const input = parseAttemptExecutionInput(inputValue)
  if (state.attempt_ids.includes(input.attempt_id)
    || state.launch_nonces.includes(input.launch_nonce)) {
    throw new AttemptTransitionError(
      'technical retry cannot reuse any prior Attempt or launch nonce in this RunSlot',
      'RETRY_NOT_ALLOWED',
    )
  }
  const attempt = transitionRetryAttempt(previous, inputValue)
  return runSlotTransition(
    expectedRevision,
    advanceRunSlotState(state, attempt, 'attempt_active', true),
    attempt,
  )
}

function transitionRetryAttempt(
  previousInput: Attempt,
  inputValue: AttemptExecutionInput,
): Attempt {
  const previous = parseAttempt(previousInput)
  if (previous.phase !== 'terminal'
    || previous.technical_outcome !== 'failed') {
    throw new AttemptTransitionError(
      'only a mechanically failed Attempt may create a technical retry',
      'RETRY_NOT_ALLOWED',
    )
  }
  const input = parseAttemptExecutionInput(inputValue)
  if (input.attempt_id === previous.attempt_id
    || input.launch_nonce === previous.launch_nonce
    || input.launched_at < previous.completed_at) {
    throw new AttemptTransitionError(
      'technical retry requires a new identity after the previous Attempt completes',
      'RETRY_NOT_ALLOWED',
    )
  }
  return parseAttempt({
    version: 1,
    attempt_id: input.attempt_id,
    attempt_ordinal: previous.attempt_ordinal + 1,
    predecessor_attempt_id: previous.attempt_id,
    trial_id: previous.trial_id,
    runslot_id: previous.runslot_id,
    trial_contract_sha256: previous.trial_contract_sha256,
    runslot_contract_sha256: previous.runslot_contract_sha256,
    candidate_sha: previous.candidate_sha,
    config_revision: previous.config_revision,
    request: input.request,
    cwd: input.cwd,
    env_sha256: input.env_sha256,
    runner: input.runner,
    host_id: input.host_id,
    launch_nonce: input.launch_nonce,
    launched_at: input.launched_at,
    ...(input.gpu_lease === undefined ? {} : { gpu_lease: input.gpu_lease }),
    ...(input.remote_connection === undefined ? {} : {
      remote_connection: input.remote_connection,
    }),
    ...(input.adapter_checkpoint_identity === undefined ? {} : {
      adapter_checkpoint_identity: input.adapter_checkpoint_identity,
    }),
    phase: 'launching',
  })
}


function parseAttemptExecutionInput(value: unknown): z.infer<typeof attemptExecutionInputSchema> {
  return parseOrThrow(
    attemptExecutionInputSchema,
    value,
    error => new AttemptTransitionError(
      `invalid Attempt launch identity: ${error.message}`,
      'INVALID_ATTEMPT',
    ),
  )
}

function parseReceiptReference(path: string, receiptHash: string): z.infer<typeof receiptReferenceSchema> {
  return parseOrThrow(
    receiptReferenceSchema,
    { path, sha256: receiptHash },
    error => new AttemptTransitionError(
      `invalid receipt reference: ${error.message}`,
      'INVALID_RECEIPT',
    ),
  )
}

function assertReceiptIdentity(
  attempt: Attempt,
  receipt: AttemptStartedReceipt | AttemptCompletionReceipt | AttemptUncertainReceipt,
): void {
  if (receipt.attempt_id !== attempt.attempt_id
    || receipt.launch_nonce !== attempt.launch_nonce
    || receipt.candidate_sha !== attempt.candidate_sha
    || receipt.request_sha256 !== attempt.request.sha256) {
    throw new AttemptTransitionError(
      `receipt identity does not match Attempt ${JSON.stringify(attempt.attempt_id)}`,
      'IDENTITY_MISMATCH',
    )
  }
}

function assertStartedProjection(
  attempt: Extract<Attempt, { phase: 'running' | 'outcome_unknown' }>,
  receipt: AttemptStartedReceipt,
): void {
  if (attempt.started_at !== receipt.started_at
    || canonicalJson(attempt.process ?? null) !== canonicalJson(receipt.process ?? null)
    || (receipt.gpu_lease !== undefined
      && canonicalJson(attempt.gpu_lease ?? null) !== canonicalJson(receipt.gpu_lease))
    || (receipt.remote_connection !== undefined
      && canonicalJson(attempt.remote_connection ?? null)
        !== canonicalJson(receipt.remote_connection))
    || (receipt.adapter_checkpoint_identity !== undefined
      && attempt.adapter_checkpoint_identity !== receipt.adapter_checkpoint_identity)) {
    throw new AttemptTransitionError(
      `started receipt projection drifted for Attempt ${JSON.stringify(attempt.attempt_id)}`,
      'IDENTITY_MISMATCH',
    )
  }
}

function assertUncertainProjection(
  attempt: OutcomeUnknownAttempt,
  receipt: AttemptUncertainReceipt,
): void {
  if (attempt.unknown_since !== receipt.observed_at
    || canonicalJson(attempt.technical_detail) !== canonicalJson(receipt.technical_detail)
    || canonicalJson(attempt.incident ?? null) !== canonicalJson(receipt.incident ?? null)) {
    throw new AttemptTransitionError(
      `uncertainty receipt projection drifted for Attempt ${JSON.stringify(attempt.attempt_id)}`,
      'IDENTITY_MISMATCH',
    )
  }
}

function assertCompletionProjection(
  attempt: TerminalAttempt,
  receipt: AttemptCompletionReceipt,
): void {
  if (attempt.completed_at !== receipt.completed_at
    || attempt.completion_identity !== receipt.completion_identity
    || attempt.technical_outcome !== receipt.technical_outcome
    || canonicalJson(attempt.technical_detail ?? null)
      !== canonicalJson(receipt.technical_detail ?? null)
    || canonicalJson(attempt.artifacts) !== canonicalJson(receipt.artifacts)) {
    throw new AttemptTransitionError(
      `completion receipt projection drifted for Attempt ${JSON.stringify(attempt.attempt_id)}`,
      'IDENTITY_MISMATCH',
    )
  }
}

function attemptBase(attempt: Attempt): Omit<
  z.infer<typeof launchingAttemptSchema>,
  'phase'
> {
  return {
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
  }
}

function attemptIdentitySha256(attempt: Attempt): string {
  return sha256(canonicalJson(attemptBase(attempt)))
}

function mergeObservedIdentity<T extends object>(
  planned: T | undefined,
  observed: T | undefined,
  label: string,
): T | undefined {
  if (planned === undefined && observed !== undefined) {
    throw new AttemptTransitionError(
      `${label} was not frozen by the Attempt launch identity`,
      'IDENTITY_MISMATCH',
    )
  }
  if (planned === undefined) return undefined
  if (observed === undefined) return planned
  if (canonicalJson(planned) !== canonicalJson(observed)) {
    throw new AttemptTransitionError(`${label} drifted at Attempt start`, 'IDENTITY_MISMATCH')
  }
  return planned
}

function mergeObservedScalar(
  planned: string | undefined,
  observed: string | undefined,
  label: string,
): string | undefined {
  if (planned === undefined && observed !== undefined) {
    throw new AttemptTransitionError(
      `${label} was not frozen by the Attempt launch identity`,
      'IDENTITY_MISMATCH',
    )
  }
  if (planned !== undefined && observed !== undefined && planned !== observed) {
    throw new AttemptTransitionError(`${label} drifted at Attempt start`, 'IDENTITY_MISMATCH')
  }
  return planned ?? observed
}

function freezeReceipt<T>(schema: z.ZodType<T>, value: unknown): FrozenRecord<T> {
  const parsed = parseOrThrow(
    schema,
    value,
    error => new AttemptTransitionError(`invalid receipt: ${error.message}`, 'INVALID_RECEIPT'),
  )
  return freezeRecord(parsed)
}

function validateFrozenReceipt<T>(
  input: FrozenRecord<T>,
  schema: z.ZodType<T>,
): FrozenRecord<T> {
  try {
    return validateFrozenRecord(input, schema, 'receipt')
  } catch (error) {
    if (error instanceof AttemptTransitionError) throw error
    throw new AttemptTransitionError(renderError(error), 'INVALID_RECEIPT')
  }
}

function validateFrozenRecord<T>(
  input: FrozenRecord<T>,
  schema: z.ZodType<T>,
  label: string,
): FrozenRecord<T> {
  const parsed = schema.safeParse(input.value)
  if (!parsed.success) {
    throw new AttemptTransitionError(`invalid frozen ${label}: ${parsed.error.message}`, 'INVALID_RECEIPT')
  }
  const cleaned = stripUndefined(parsed.data) as T
  const text = canonicalJson(cleaned)
  if (text !== input.canonicalJson || sha256(text) !== input.sha256) {
    throw new AttemptTransitionError(`${label} immutable hash does not match`, 'IDENTITY_MISMATCH')
  }
  return input
}

function freezeRecord<T>(value: T): FrozenRecord<T> {
  const cleaned = deepFreeze(stripUndefined(value) as T)
  const text = canonicalJson(cleaned)
  return Object.freeze({ value: cleaned, canonicalJson: text, sha256: sha256(text) })
}

function parseOrThrow<T>(
  schema: z.ZodType<T>,
  value: unknown,
  mapError: (error: z.ZodError) => Error,
): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw mapError(parsed.error)
  return stripUndefined(parsed.data) as T
}

function rejectDuplicates(
  values: readonly string[],
  label: string,
  context: z.RefinementCtx,
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: 'custom', message: `${label} cannot contain duplicates` })
  }
}

function validateRunSlotHistory(
  state: {
    readonly revision: number
    readonly attempt_id: string
    readonly attempt_ordinal: number
    readonly attempt_ids: readonly string[]
    readonly launch_nonces: readonly string[]
  },
  context: z.RefinementCtx,
): void {
  if (state.attempt_ids.length !== state.launch_nonces.length
    || state.attempt_ordinal !== state.attempt_ids.length
    || state.attempt_ids.at(-1) !== state.attempt_id) {
    context.addIssue({ code: 'custom', message: 'RunSlot Attempt history is inconsistent' })
  }
  if (state.revision < state.attempt_ordinal) {
    context.addIssue({ code: 'custom', message: 'RunSlot revision precedes Attempt history' })
  }
  rejectDuplicates(state.attempt_ids, 'attempt_ids', context)
  rejectDuplicates(state.launch_nonces, 'launch_nonces', context)
}

function assertExpectedRunSlotRevision(
  state: RunSlotState,
  expectedRevision: number,
): void {
  if (!Number.isSafeInteger(expectedRevision)
    || expectedRevision < 0
    || state.revision !== expectedRevision) {
    throw new AttemptTransitionError(
      `RunSlot revision is ${state.revision}, not expected revision ${expectedRevision}`,
      'STALE_RUNSLOT_STATE',
    )
  }
}

function assertRunSlotStateContract(
  state: RunSlotState,
  runslot: FrozenRecord<RunSlotContract>,
): void {
  if (state.runslot_id !== runslot.value.runslot_id
    || state.trial_id !== runslot.value.trial_id
    || state.runslot_contract_sha256 !== runslot.sha256) {
    throw new AttemptTransitionError(
      'RunSlot state does not match its immutable contract',
      'IDENTITY_MISMATCH',
    )
  }
}

function assertRunSlotContractBelongsToTrial(
  runslot: FrozenRecord<RunSlotContract>,
  trial: FrozenRecord<TrialContract>,
): void {
  const slot = trial.value.run_slots.find(candidate => (
    candidate.runslot_id === runslot.value.runslot_id
  ))
  if (slot === undefined
    || runslot.value.trial_id !== trial.value.trial_id
    || runslot.value.trial_contract_sha256 !== trial.sha256
    || runslot.value.candidate_sha !== trial.value.candidate_sha
    || runslot.value.config_revision !== trial.value.config_revision
    || canonicalJson(runslot.value.contract ?? null)
      !== canonicalJson(slot.contract ?? null)) {
    throw new AttemptTransitionError(
      'RunSlot contract does not derive exactly from its frozen Trial',
      'IDENTITY_MISMATCH',
    )
  }
}

function assertRunSlotStateAttempt(
  state: RunSlotState,
  attempt: Attempt,
  allowedStatuses: readonly RunSlotState['status'][],
): void {
  if (!allowedStatuses.includes(state.status)) {
    throw new AttemptTransitionError(
      `RunSlot status ${JSON.stringify(state.status)} cannot migrate this Attempt`,
      'ILLEGAL_TRANSITION',
    )
  }
  if (state.status === 'pending'
    || state.attempt_id !== attempt.attempt_id
    || state.attempt_ordinal !== attempt.attempt_ordinal
    || state.attempt_identity_sha256 !== attemptIdentitySha256(attempt)
    || state.launch_nonces.at(-1) !== attempt.launch_nonce
    || (attempt.attempt_ordinal > 1
      && state.attempt_ids.at(-2) !== attempt.predecessor_attempt_id)
    || state.runslot_id !== attempt.runslot_id
    || state.trial_id !== attempt.trial_id
    || state.runslot_contract_sha256 !== attempt.runslot_contract_sha256) {
    throw new AttemptTransitionError(
      'RunSlot state and Attempt identity do not match',
      'IDENTITY_MISMATCH',
    )
  }
}

function advanceRunSlotState(
  state: RunSlotState,
  attempt: Attempt,
  status: Exclude<RunSlotState['status'], 'pending'>,
  appendAttempt: boolean,
): RunSlotState {
  const priorAttemptIds = state.status === 'pending' ? [] : state.attempt_ids
  const priorLaunchNonces = state.status === 'pending' ? [] : state.launch_nonces
  return parseRunSlotState({
    version: 1,
    runslot_id: state.runslot_id,
    trial_id: state.trial_id,
    runslot_contract_sha256: state.runslot_contract_sha256,
    revision: state.revision + 1,
    status,
    attempt_id: attempt.attempt_id,
    attempt_ordinal: attempt.attempt_ordinal,
    attempt_identity_sha256: attemptIdentitySha256(attempt),
    attempt_ids: appendAttempt ? [...priorAttemptIds, attempt.attempt_id] : priorAttemptIds,
    launch_nonces: appendAttempt
      ? [...priorLaunchNonces, attempt.launch_nonce]
      : priorLaunchNonces,
  })
}

function runSlotTransition<TAttempt extends Attempt>(
  expectedRevision: number,
  state: RunSlotState,
  attempt: TAttempt,
): RunSlotAttemptTransition<TAttempt> {
  return Object.freeze({ expected_revision: expectedRevision, state, attempt })
}

function validateAttemptLineage(
  attempt: {
    readonly attempt_ordinal: number
    readonly predecessor_attempt_id?: string | undefined
  },
  context: z.RefinementCtx,
): void {
  if ((attempt.attempt_ordinal === 1) !== (attempt.predecessor_attempt_id === undefined)) {
    context.addIssue({
      code: 'custom',
      message: 'only retry Attempts require predecessor_attempt_id',
    })
  }
}

function assertExactKeys(
  value: object,
  allowed: readonly string[],
  label: string,
): void {
  const extra = Object.keys(value).find(key => !allowed.includes(key))
  if (extra !== undefined) {
    throw new AttemptTransitionError(
      `${label} contains undeclared field ${JSON.stringify(extra)}`,
      'INVALID_RECEIPT',
    )
  }
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => (
    item === undefined ? [] : [[key, stripUndefined(item)]]
  )))
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item)
    Object.freeze(value)
  }
  return value
}

function renderError(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
