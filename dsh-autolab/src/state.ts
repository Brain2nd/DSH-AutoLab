import { z } from 'zod'
import { isAbsolute } from 'node:path'

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

import { apiRecoveryRecordSchema } from './api-recovery-store.js'
import type { ApiRecoveryRecord } from './api-recovery.js'
import { canonicalJson, sha256 } from './integrity.js'
import { runSlotStateSchema } from './trial.js'

export const LAB_ID_PATTERN = /^lab-[0-9]{8}-[0-9]{6}-[0-9a-f]{8}$/
export const SHA256_PATTERN = /^[0-9a-f]{64}$/
export const CONTROL_PAYLOAD_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/

export const labLifecycleSchema = z.enum([
  'configuring',
  'draft_ready',
  'ready',
  'starting',
  'running',
  'pausing',
  'paused',
  'blocked',
  'stopped',
])

export const rolePhaseSchema = z.enum([
  'declared',
  'starting',
  'working',
  'reviewing',
  'pausing',
  'paused',
  'blocked',
])

const reviewGoalRefSchema = z.object({
  id: z.string().min(1),
  revision: z.number().int().positive(),
}).strict()

export const reviewCapabilityStateSchema = z.object({
  version: z.literal(1),
  reviewId: z.string().min(1),
  assignmentId: z.string().min(1),
  configRevision: z.number().int().positive(),
  runtimeRevision: z.number().int().nonnegative(),
  ownerFence: z.string().uuid(),
  workerRoleId: z.string().min(1),
  workerSessionId: z.string().min(1),
  judgeRoleId: z.string().min(1),
  judgeSessionId: z.string().min(1),
  packetHash: z.string().regex(SHA256_PATTERN),
  artifactHash: z.string().regex(SHA256_PATTERN),
  negotiatedAnchorHash: z.string().regex(SHA256_PATTERN),
  sourceTurn: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  expectedGoalRef: reviewGoalRefSchema.nullable(),
  request: z.object({
    controlId: z.string().uuid(),
    payloadHash: z.string().regex(CONTROL_PAYLOAD_HASH_PATTERN),
  }).strict(),
  acceptedPause: z.object({
    controlId: z.string().uuid(),
    payloadHash: z.string().regex(CONTROL_PAYLOAD_HASH_PATTERN),
  }).strict(),
}).strict()

export const reviewPauseStateSchema = z.object({
  controlId: z.string().uuid(),
  payloadHash: z.string().regex(CONTROL_PAYLOAD_HASH_PATTERN),
  freeze: z.enum([
    'pending',
    'stopped',
    'hold-pending',
    'held',
    'stale',
    'user-override',
  ]),
  completedAt: z.number().int().nonnegative().optional(),
  goalOutcome: z.enum([
    'paused',
    'already-applied',
    'no-active-goal',
    'stale',
  ]).optional(),
  activeTurn: z.boolean().optional(),
  observedTurn: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  goalRef: reviewGoalRefSchema.optional(),
  holdOwnerEpoch: z.string().uuid().optional(),
  detail: z.string().min(1).optional(),
}).strict().superRefine((pause, context) => {
  const completed = pause.completedAt !== undefined
    && pause.goalOutcome !== undefined
    && pause.activeTurn !== undefined
  if (pause.freeze === 'pending') {
    if (completed
      || pause.completedAt !== undefined
      || pause.goalOutcome !== undefined
      || pause.activeTurn !== undefined
      || pause.observedTurn !== undefined
      || pause.goalRef !== undefined
      || pause.holdOwnerEpoch !== undefined
      || pause.detail !== undefined) {
      context.addIssue({ code: 'custom', message: 'pending review pause cannot carry an outcome' })
    }
    return
  }
  if (!completed) {
    context.addIssue({ code: 'custom', message: `${pause.freeze} review pause requires its completed outcome` })
  }
  if (pause.activeTurn === true && pause.observedTurn === undefined) {
    context.addIssue({ code: 'custom', message: 'active review pause requires its observed turn' })
  }
  if (pause.activeTurn !== true && pause.observedTurn !== undefined) {
    context.addIssue({ code: 'custom', message: 'inactive review pause cannot carry an observed turn' })
  }
  if (pause.freeze === 'held') {
    if (pause.holdOwnerEpoch === undefined || pause.activeTurn !== true) {
      context.addIssue({ code: 'custom', message: 'held review pause requires its owner epoch and active turn' })
    }
  } else if (pause.holdOwnerEpoch !== undefined) {
    context.addIssue({ code: 'custom', message: `${pause.freeze} review pause cannot carry a hold owner epoch` })
  }
  if (pause.freeze === 'stale' && pause.goalOutcome !== 'stale') {
    context.addIssue({ code: 'custom', message: 'stale review pause requires a stale Goal outcome' })
  }
  if ((pause.freeze === 'hold-pending' || pause.freeze === 'user-override')
    && pause.activeTurn !== true) {
    context.addIssue({ code: 'custom', message: `${pause.freeze} review pause requires an active turn` })
  }
  if (pause.freeze === 'user-override' && pause.detail === undefined) {
    context.addIssue({ code: 'custom', message: 'user-override review pause requires a detail' })
  }
})

export const reviewVerdictStateSchema = z.object({
  path: z.string().min(1),
  hash: z.string().regex(SHA256_PATTERN),
  assignmentId: z.string().min(1),
  reviewInputHash: z.string().regex(SHA256_PATTERN),
  topLevelVerdict: z.enum([
    'APPROVED',
    'REVISION_REQUIRED',
    'REJECTED',
    'REVIEW_ERROR',
  ]),
  recordedAt: z.number().int().nonnegative(),
}).strict()

/** Postflight scientific content stays opaque; Runtime stores only its binding. */
export const reviewResultStateSchema = z.object({
  path: z.string().min(1).refine(isAbsolute, 'review result path must be absolute'),
  hash: z.string().regex(SHA256_PATTERN),
  assignmentId: z.string().min(1),
  reviewInputHash: z.string().regex(SHA256_PATTERN),
  recordedAt: z.number().int().nonnegative(),
}).strict()

const reviewResolutionBodySchema = z.object({
  version: z.literal(1),
  reviewId: z.string().min(1),
  verdictHash: z.string().regex(SHA256_PATTERN),
  targetRoleId: z.string().min(1),
  targetSessionId: z.string().min(1),
  effect: z.object({
    kind: z.string().min(1),
    id: z.string().min(1),
    hash: z.string().regex(SHA256_PATTERN),
  }).strict(),
}).strict()

export const reviewResolutionStateSchema = reviewResolutionBodySchema.extend({
  resolutionHash: z.string().regex(SHA256_PATTERN),
}).strict().superRefine((resolution, context) => {
  const { resolutionHash: _storedHash, ...body } = resolution
  if (resolutionHash(body) !== resolution.resolutionHash) {
    context.addIssue({ code: 'custom', message: 'review resolution hash does not match its target effect' })
  }
})

export const activeReviewSchema = z.object({
  stage: z.enum(['preflight', 'postflight']),
  phase: z.enum(['reviewing', 'verdict_recorded', 'result_recorded', 'error']),
  sourcePacket: z.object({
    path: z.string().min(1),
    hash: z.string().regex(SHA256_PATTERN),
  }).strict(),
  packetPath: z.string().min(1),
  artifactPath: z.string().min(1),
  capability: reviewCapabilityStateSchema,
  pause: reviewPauseStateSchema,
  verdict: reviewVerdictStateSchema.optional(),
  result: reviewResultStateSchema.optional(),
  resolution: reviewResolutionStateSchema.optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict().superRefine((review, context) => {
  if (review.updatedAt < review.createdAt) {
    context.addIssue({ code: 'custom', message: 'review updatedAt must not precede createdAt' })
  }
  if (review.pause.controlId !== review.capability.acceptedPause.controlId
    || review.pause.payloadHash !== review.capability.acceptedPause.payloadHash) {
    context.addIssue({ code: 'custom', message: 'review pause does not match its accepted control edge' })
  }
  if (review.stage === 'preflight') {
    if (review.result !== undefined || review.phase === 'result_recorded') {
      context.addIssue({ code: 'custom', message: 'Preflight cannot carry a Postflight result' })
    }
    if ((review.phase === 'reviewing') !== (review.verdict === undefined)) {
      context.addIssue({ code: 'custom', message: `${review.phase} Preflight verdict projection is inconsistent` })
    }
    if (review.phase === 'error'
      && review.verdict?.topLevelVerdict !== 'REVIEW_ERROR') {
      context.addIssue({ code: 'custom', message: 'error review requires a REVIEW_ERROR verdict' })
    }
    if (review.phase === 'verdict_recorded'
      && review.verdict?.topLevelVerdict === 'REVIEW_ERROR') {
      context.addIssue({ code: 'custom', message: 'REVIEW_ERROR cannot be recorded as a scientific verdict' })
    }
    if (review.verdict !== undefined
      && review.verdict.reviewInputHash !== review.capability.negotiatedAnchorHash) {
      context.addIssue({ code: 'custom', message: 'review verdict does not match its negotiated input anchor' })
    }
  } else {
    if (review.verdict !== undefined
      || review.phase === 'verdict_recorded'
      || review.phase === 'error') {
      context.addIssue({ code: 'custom', message: 'Postflight output must remain opaque to Runtime' })
    }
    if ((review.phase === 'reviewing') !== (review.result === undefined)) {
      context.addIssue({ code: 'custom', message: `${review.phase} Postflight result projection is inconsistent` })
    }
    if (review.result !== undefined
      && review.result.reviewInputHash !== review.capability.negotiatedAnchorHash) {
      context.addIssue({ code: 'custom', message: 'Postflight result does not match its negotiated input anchor' })
    }
  }
  if (review.resolution !== undefined) {
    if (review.phase !== 'verdict_recorded'
      || review.verdict === undefined
      || review.resolution.reviewId !== review.capability.reviewId
      || review.resolution.verdictHash !== review.verdict.hash) {
      context.addIssue({ code: 'custom', message: 'review resolution does not match its persisted verdict' })
    }
    if (review.pause.freeze !== 'stopped') {
      context.addIssue({ code: 'custom', message: 'resolved review must project its worker freeze as stopped' })
    }
  }
})

export const goalInstallSchema = z.object({
  installId: z.string().min(1),
  assignmentId: z.string().min(1),
  objectiveHash: z.string().regex(SHA256_PATTERN),
  maxGoalRounds: z.number().int().positive(),
  status: z.enum(['pending', 'activating', 'applied']),
  goalId: z.string().min(1).optional(),
  goalRevision: z.number().int().positive().optional(),
}).strict().superRefine((install, context) => {
  if ((install.goalId === undefined) !== (install.goalRevision === undefined)) {
    context.addIssue({
      code: 'custom',
      message: 'goalId and goalRevision must be present together',
    })
  }
  if (install.status === 'applied' && install.goalId === undefined) {
    context.addIssue({
      code: 'custom',
      message: 'applied Goal install requires its durable Goal reference',
    })
  }
})

/**
 * The Controller is the user's existing Session, not an entry in `roles`.
 * Keep only the identity needed to recover its one native DSH Goal plus the
 * Controller's explicit AutoLabWait intent. Goal phase, activation, and round
 * counters remain owned by `@deepseek-ai/dsh-goal`.
 */
export const controllerGoalSchema = goalInstallSchema.safeExtend({
  roleId: z.string().min(1),
  packetHash: z.string().regex(SHA256_PATTERN),
  /** Presence means only a durable event or explicit resume may re-arm it. */
  waiting: z.literal(true).optional(),
}).strict()

export const roleActivationBlockerSchema = z.object({
  code: z.enum([
    'WORKTREE_PROVISION_FAILED',
    'ROLE_ACTIVATION_FAILED',
    'GOAL_INSTALL_FAILED',
  ]),
  message: z.string().min(1),
}).strict()

export const roleStateSchema = z.object({
  sessionId: z.string().min(1),
  phase: rolePhaseSchema,
  binding: z.object({
    path: z.string().min(1),
    hash: z.string().regex(SHA256_PATTERN),
  }).strict().optional(),
  packet: z.object({
    path: z.string().min(1),
    hash: z.string().regex(SHA256_PATTERN),
  }).strict().optional(),
  goalInstall: goalInstallSchema.optional(),
  /** Latest opaque result for a Controller-dispatched non-review Assignment. */
  receipt: z.object({
    assignmentId: z.string().min(1),
    path: z.string().min(1).refine(isAbsolute, 'role receipt path must be absolute'),
    hash: z.string().regex(SHA256_PATTERN),
    recordedAt: z.number().int().nonnegative(),
  }).strict().optional(),
  activationBlocker: roleActivationBlockerSchema.optional(),
}).strict().superRefine((role, context) => {
  if (role.phase !== 'starting' && (role.binding === undefined || role.packet === undefined)) {
    context.addIssue({
      code: 'custom',
      message: `${role.phase} role requires frozen binding and packet references`,
    })
  }
})

export const activeCandidateSchema = z.object({
  version: z.literal(1),
  sourceRevision: z.number().int().positive(),
  laneId: z.string().min(1),
  candidateId: z.string().min(1),
  reviewId: z.string().min(1).optional(),
  coderRoleId: z.string().min(1),
  coderSessionId: z.string().min(1),
  assignmentId: z.string().min(1),
  candidateSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u),
  captureReceipt: z.object({
    path: z.string().min(1).refine(isAbsolute, 'candidate receipt path must be absolute'),
    hash: z.string().regex(SHA256_PATTERN),
  }).strict(),
  sourceReport: z.object({
    path: z.string().min(1).refine(isAbsolute, 'implementation receipt path must be absolute'),
    hash: z.string().regex(SHA256_PATTERN),
  }).strict().optional(),
  frozenAt: z.number().int().nonnegative(),
}).strict()

const trialArtifactReferenceSchema = z.object({
  path: z.string().min(1).refine(isAbsolute, 'Trial artifact path must be absolute'),
  hash: z.string().regex(SHA256_PATTERN),
}).strict()

const activeAttemptReferenceSchema = z.object({
  attemptId: z.string().min(1),
  phase: z.enum(['launching', 'running', 'outcome_unknown', 'terminal']),
  path: z.string().min(1).refine(isAbsolute, 'Attempt artifact path must be absolute'),
  hash: z.string().regex(SHA256_PATTERN),
  /** External anchor for the detached checkout receipt; generic adapters may omit it. */
  checkout: trialArtifactReferenceSchema.optional(),
}).strict()

const activeRunSlotProjectionSchema = z.object({
  contract: trialArtifactReferenceSchema,
  state: runSlotStateSchema,
  activeAttempt: activeAttemptReferenceSchema.optional(),
}).strict().superRefine((slot, context) => {
  if (slot.state.status === 'pending') {
    if (slot.activeAttempt !== undefined) {
      context.addIssue({ code: 'custom', message: 'pending RunSlot cannot carry an Attempt' })
    }
    return
  }
  if (slot.activeAttempt === undefined
    || slot.activeAttempt.attemptId !== slot.state.attempt_id) {
    context.addIssue({ code: 'custom', message: 'occupied RunSlot requires its exact active Attempt reference' })
    return
  }
  const phaseMatches = slot.state.status === 'attempt_active'
    ? slot.activeAttempt.phase === 'launching' || slot.activeAttempt.phase === 'running'
    : slot.state.status === 'outcome_unknown'
      ? slot.activeAttempt.phase === 'outcome_unknown'
      : slot.activeAttempt.phase === 'terminal'
  if (!phaseMatches) {
    context.addIssue({ code: 'custom', message: 'RunSlot status does not match its Attempt phase' })
  }
})

export const activeTrialSchema = z.object({
  version: z.literal(1),
  sourceRevision: z.number().int().positive(),
  laneId: z.string().min(1),
  candidateId: z.string().min(1),
  candidateSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u),
  contract: trialArtifactReferenceSchema,
  runSlots: z.record(z.string().min(1), activeRunSlotProjectionSchema),
}).strict().superRefine((trial, context) => {
  if (Object.keys(trial.runSlots).length === 0) {
    context.addIssue({ code: 'custom', message: 'active Trial requires its frozen RunSlots' })
  }
  for (const [runSlotId, slot] of Object.entries(trial.runSlots)) {
    if (slot.state.runslot_id !== runSlotId
      || slot.state.runslot_contract_sha256 !== slot.contract.hash) {
      context.addIssue({
        code: 'custom',
        path: ['runSlots', runSlotId],
        message: 'RunSlot projection key or contract hash does not match its state identity',
      })
    }
  }
})

export const configRefSchema = z.object({
  revision: z.number().int().positive(),
  specHash: z.string().regex(SHA256_PATTERN),
  configHash: z.string().regex(SHA256_PATTERN),
  manifestHash: z.string().regex(SHA256_PATTERN),
  dialogueHeadHash: z.string().regex(SHA256_PATTERN),
  revisionPath: z.string().min(1),
}).strict()

export const runtimeStateSchema = z.object({
  schemaVersion: z.literal(1),
  labId: z.string().regex(LAB_ID_PATTERN),
  runtimeRevision: z.number().int().nonnegative(),
  ownerEpoch: z.string().uuid(),
  controllerSessionId: z.string().min(1),
  controllerGoal: controllerGoalSchema.optional(),
  lifecycle: labLifecycleSchema,
  config: configRefSchema.optional(),
  /** Current ACL reveal projection; absent only before commit or in legacy state. */
  revealState: z.enum(['sealed', 'revealed']).optional(),
  roles: z.record(z.string().min(1), roleStateSchema),
  reviews: z.record(z.string().min(1), activeReviewSchema).default({}),
  /** One bounded active projection per Lane; terminal history remains in artifacts/ledger. */
  candidates: z.record(z.string().min(1), activeCandidateSchema).default({}),
  /**
   * Superseded Lane candidates, keyed by candidateId. They are immutable
   * archived projections: Trials that were frozen against them remain valid,
   * while the Lane's `candidates[laneId]` slot is free for the next Coder
   * Assignment. History is never deleted.
   */
  retiredCandidates: z.record(z.string().min(1), activeCandidateSchema).default({}),
  /** Only active Trial/RunSlot working state; immutable contracts and history stay in artifacts. */
  trials: z.record(z.string().min(1), activeTrialSchema).default({}),
  blocker: z.object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    message: z.string().min(1),
  }).strict().optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict().superRefine((state, context) => {
  if (state.updatedAt < state.createdAt) {
    context.addIssue({
      code: 'custom',
      message: 'updatedAt must not precede createdAt',
      path: ['updatedAt'],
    })
  }
  const configured = state.lifecycle === 'ready'
    || state.lifecycle === 'starting'
    || state.lifecycle === 'running'
    || state.lifecycle === 'pausing'
    || state.lifecycle === 'paused'
  if (configured && state.config === undefined) {
    context.addIssue({
      code: 'custom',
      message: `${state.lifecycle} lifecycle requires a committed config revision`,
      path: ['config'],
    })
  }
  if ((state.lifecycle === 'configuring' || state.lifecycle === 'draft_ready')
    && state.config !== undefined) {
    context.addIssue({
      code: 'custom',
      message: `${state.lifecycle} lifecycle must not project a committed config revision`,
      path: ['config'],
    })
  }
  if (state.lifecycle === 'blocked' && state.blocker === undefined) {
    context.addIssue({
      code: 'custom',
      message: 'blocked lifecycle requires a blocker',
      path: ['blocker'],
    })
  }
  if (state.lifecycle !== 'blocked' && state.blocker !== undefined) {
    context.addIssue({
      code: 'custom',
      message: `${state.lifecycle} lifecycle must not retain a blocker`,
      path: ['blocker'],
    })
  }
  for (const [reviewId, review] of Object.entries(state.reviews)) {
    if (review.capability.reviewId !== reviewId) {
      context.addIssue({
        code: 'custom',
        message: `review key ${reviewId} does not match its capability`,
        path: ['reviews', reviewId],
      })
    }
    const worker = state.roles[review.capability.workerRoleId]
    const judge = state.roles[review.capability.judgeRoleId]
    if (worker?.sessionId !== review.capability.workerSessionId
      || judge?.sessionId !== review.capability.judgeSessionId) {
      context.addIssue({
        code: 'custom',
        message: `review ${reviewId} role Session binding does not match RuntimeState`,
        path: ['reviews', reviewId],
      })
    }
    if (state.config !== undefined
      && review.capability.configRevision > state.config.revision) {
      context.addIssue({
        code: 'custom',
        message: `review ${reviewId} config revision does not match RuntimeState`,
        path: ['reviews', reviewId],
      })
    }
    if (review.resolution !== undefined
      && state.roles[review.resolution.targetRoleId]?.sessionId
        !== review.resolution.targetSessionId) {
      context.addIssue({
        code: 'custom',
        message: `review ${reviewId} resolution target does not match RuntimeState`,
        path: ['reviews', reviewId, 'resolution'],
      })
    }
  }
  for (const [laneId, candidate] of Object.entries(state.candidates)) {
    const coder = state.roles[candidate.coderRoleId]
    if (candidate.laneId !== laneId) {
      context.addIssue({
        code: 'custom',
        message: `candidate key ${laneId} does not match its Lane identity`,
        path: ['candidates', laneId],
      })
    }
    if (coder?.sessionId !== candidate.coderSessionId
      || (coder.goalInstall !== undefined
        && coder.goalInstall.assignmentId !== candidate.assignmentId)) {
      context.addIssue({
        code: 'custom',
        message: `candidate ${candidate.candidateId} does not match its Coder Assignment`,
        path: ['candidates', laneId],
      })
    }
    if (state.config !== undefined && candidate.sourceRevision > state.config.revision) {
      context.addIssue({
        code: 'custom',
        message: `candidate ${candidate.candidateId} config revision does not match RuntimeState`,
        path: ['candidates', laneId],
      })
    }
  }
  for (const [candidateId, candidate] of Object.entries(state.retiredCandidates)) {
    const coder = state.roles[candidate.coderRoleId]
    if (candidate.candidateId !== candidateId) {
      context.addIssue({
        code: 'custom',
        message: `retired candidate key ${candidateId} does not match its identity`,
        path: ['retiredCandidates', candidateId],
      })
    }
    if (coder?.sessionId !== candidate.coderSessionId) {
      context.addIssue({
        code: 'custom',
        message: `retired candidate ${candidate.candidateId} does not match its Coder Session`,
        path: ['retiredCandidates', candidateId],
      })
    }
    if (coder?.goalInstall !== undefined
      && coder.goalInstall.assignmentId === candidate.assignmentId) {
      context.addIssue({
        code: 'custom',
        message: `retired candidate ${candidate.candidateId} still matches the active Coder Assignment`,
        path: ['retiredCandidates', candidateId],
      })
    }
    if (state.candidates[candidate.laneId] !== undefined) {
      const active = state.candidates[candidate.laneId]!
      // Candidate generations: one candidateId may have several generations
      // (v1 retired, v2 active, ...). A retired record conflicts with the
      // active slot only when it is the exact same frozen capture.
      if (active.candidateId === candidate.candidateId
        && active.candidateSha === candidate.candidateSha) {
        context.addIssue({
          code: 'custom',
          message: `candidate ${candidate.candidateId} is both active and retired`,
          path: ['retiredCandidates', candidateId],
        })
      }
    }
    if (state.config !== undefined && candidate.sourceRevision > state.config.revision) {
      context.addIssue({
        code: 'custom',
        message: `retired candidate ${candidate.candidateId} config revision does not match RuntimeState`,
        path: ['retiredCandidates', candidateId],
      })
    }
  }
  for (const [trialId, trial] of Object.entries(state.trials)) {
    // A Trial descends from the exact frozen capture (candidate id + sha +
    // source revision) that launched it. With candidate generations the same
    // candidateId may exist as an active capture (new sha) and a retired one
    // (older sha); the Trial is valid when EITHER record matches completely.
    const matches = (record: ActiveCandidate | undefined): boolean => (
      record !== undefined
      && record.candidateId === trial.candidateId
      && record.candidateSha === trial.candidateSha
      && record.sourceRevision === trial.sourceRevision
    )
    const active = state.candidates[trial.laneId]
    const candidate = matches(active)
      ? active
      : matches(state.retiredCandidates[trial.candidateId])
        ? state.retiredCandidates[trial.candidateId]
        : undefined
    if (candidate === undefined) {
      context.addIssue({
        code: 'custom',
        message: `Trial ${trialId} does not descend from its active or retired READY Candidate plan`,
        path: ['trials', trialId],
      })
    }
    if (state.config !== undefined && trial.sourceRevision > state.config.revision) {
      context.addIssue({
        code: 'custom',
        message: `Trial ${trialId} config revision does not match RuntimeState`,
        path: ['trials', trialId],
      })
    }
    for (const slot of Object.values(trial.runSlots)) {
      if (slot.state.trial_id !== trialId) {
        context.addIssue({
          code: 'custom',
          message: `Trial ${trialId} RunSlot belongs to another Trial`,
          path: ['trials', trialId, 'runSlots'],
        })
      }
    }
  }
})

export type LabLifecycle = z.infer<typeof labLifecycleSchema>
export type RoleState = z.infer<typeof roleStateSchema>
export type ControllerGoalState = z.infer<typeof controllerGoalSchema>
export type ActiveCandidate = z.infer<typeof activeCandidateSchema>
export type ActiveTrial = z.infer<typeof activeTrialSchema>
export type ActiveReview = z.infer<typeof activeReviewSchema>
export type ReviewResolutionBody = z.infer<typeof reviewResolutionBodySchema>
export type ReviewResolutionState = z.infer<typeof reviewResolutionStateSchema>
export type ConfigRef = z.infer<typeof configRefSchema>
export type RuntimeState = z.infer<typeof runtimeStateSchema>

export class ReviewResolutionError extends Error {
  readonly name = 'ReviewResolutionError'

  constructor(
    message: string,
    readonly code: 'NOT_READY' | 'VERDICT_MISMATCH' | 'RESOLUTION_CONFLICT',
  ) {
    super(message)
  }
}

export function resolutionHash(body: ReviewResolutionBody): string {
  const parsed = reviewResolutionBodySchema.parse(body)
  return sha256(`autolab-review-resolution-v1\0${canonicalJson(parsed)}`)
}

/** The only worker-freeze states from which a persisted verdict may advance. */
export function reviewFreezeComplete(review: ActiveReview, ownerEpoch: string): boolean {
  return review.pause.freeze === 'stopped'
    || (review.pause.freeze === 'held' && review.pause.holdOwnerEpoch === ownerEpoch)
}

/** Verdict and freeze are independent axes; both must meet at this boundary. */
export function reviewReadyToAdvance(review: ActiveReview, ownerEpoch: string): boolean {
  return review.phase === 'verdict_recorded'
    && review.resolution === undefined
    && reviewFreezeComplete(review, ownerEpoch)
}

/**
 * Record one already-applied deterministic route. This is a terminal marker,
 * not another lifecycle axis: exact retries are no-ops and conflicts fail.
 */
export function recordReviewResolution(
  review: ActiveReview,
  ownerEpoch: string,
  resolution: ReviewResolutionState,
  updatedAt: number,
): ActiveReview {
  const marker = reviewResolutionStateSchema.parse(resolution)
  if (review.resolution !== undefined) {
    if (canonicalJson(review.resolution) === canonicalJson(marker)) return review
    throw new ReviewResolutionError(
      `Review ${review.capability.reviewId} already records another resolution`,
      'RESOLUTION_CONFLICT',
    )
  }
  if (!reviewReadyToAdvance(review, ownerEpoch)) {
    throw new ReviewResolutionError(
      `Review ${review.capability.reviewId} is not ready to record an applied route`,
      'NOT_READY',
    )
  }
  if (review.verdict === undefined
    || marker.reviewId !== review.capability.reviewId
    || marker.verdictHash !== review.verdict.hash) {
    throw new ReviewResolutionError(
      `Review ${review.capability.reviewId} route does not match its verdict`,
      'VERDICT_MISMATCH',
    )
  }
  const { holdOwnerEpoch: _releasedOwner, ...pause } = review.pause
  return activeReviewSchema.parse({
    ...review,
    pause: { ...pause, freeze: 'stopped' },
    resolution: marker,
    updatedAt: Math.max(review.updatedAt, updatedAt),
  })
}

export const autolabDomainSpec = defineDomain({
  name: 'autolab',
  version: 1,
  tables: {
    labs: domainTable<string, RuntimeState>(runtimeStateSchema),
    api_recoveries: domainTable<string, ApiRecoveryRecord>(apiRecoveryRecordSchema),
  },
})

const LEGAL_TRANSITIONS: Readonly<Record<LabLifecycle, ReadonlySet<LabLifecycle>>> = {
  configuring: new Set(['draft_ready', 'ready', 'blocked', 'stopped']),
  draft_ready: new Set(['configuring', 'ready', 'blocked', 'stopped']),
  ready: new Set(['starting', 'paused', 'blocked', 'stopped']),
  starting: new Set(['running', 'blocked', 'paused']),
  running: new Set(['starting', 'pausing', 'blocked', 'stopped']),
  pausing: new Set(['paused', 'blocked']),
  paused: new Set(['starting', 'blocked', 'stopped']),
  blocked: new Set(['configuring', 'draft_ready', 'ready', 'starting', 'pausing', 'paused', 'stopped']),
  stopped: new Set(),
}

export class AutoLabStateError extends Error {
  readonly name = 'AutoLabStateError'

  constructor(
    message: string,
    readonly code:
      | 'LAB_NOT_FOUND'
      | 'REVISION_CONFLICT'
      | 'OWNER_FENCE_LOST'
      | 'INVALID_TRANSITION'
      | 'INVALID_STATE',
  ) {
    super(message)
  }
}

export function createRuntimeState(input: {
  labId: string
  ownerEpoch: string
  controllerSessionId: string
  lifecycle: 'configuring' | 'draft_ready' | 'ready'
  config?: ConfigRef
  revealState?: RuntimeState['revealState']
  now?: number
}): RuntimeState {
  const now = input.now ?? Date.now()
  const candidate: RuntimeState = {
    schemaVersion: 1,
    labId: input.labId,
    runtimeRevision: 0,
    ownerEpoch: input.ownerEpoch,
    controllerSessionId: input.controllerSessionId,
    lifecycle: input.lifecycle,
    ...(input.config === undefined ? {} : { config: input.config }),
    ...(input.revealState === undefined ? {} : { revealState: input.revealState }),
    roles: {},
    reviews: {},
    candidates: {},
    retiredCandidates: {},
    trials: {},
    createdAt: now,
    updatedAt: now,
  }
  return parseState(candidate)
}

export function transitionRuntimeState(
  current: RuntimeState,
  input: {
    expectedRevision: number
    ownerEpoch: string
    lifecycle: LabLifecycle
    config?: ConfigRef | null
    revealState?: RuntimeState['revealState']
    controllerGoal?: RuntimeState['controllerGoal'] | null
    roles?: RuntimeState['roles']
    reviews?: RuntimeState['reviews']
    candidates?: RuntimeState['candidates']
    retiredCandidates?: RuntimeState['retiredCandidates']
    trials?: RuntimeState['trials']
    blocker?: RuntimeState['blocker'] | null
    now?: number
  },
): RuntimeState {
  const validated = parseState(current)
  if (validated.ownerEpoch !== input.ownerEpoch) {
    throw new AutoLabStateError('controller owner epoch no longer matches', 'OWNER_FENCE_LOST')
  }
  if (validated.runtimeRevision !== input.expectedRevision) {
    throw new AutoLabStateError(
      `expected controller revision ${input.expectedRevision}, found ${validated.runtimeRevision}`,
      'REVISION_CONFLICT',
    )
  }
  if (input.lifecycle !== validated.lifecycle
    && !LEGAL_TRANSITIONS[validated.lifecycle].has(input.lifecycle)) {
    throw new AutoLabStateError(
      `invalid lifecycle transition ${validated.lifecycle} -> ${input.lifecycle}`,
      'INVALID_TRANSITION',
    )
  }
  const observedNow = input.now ?? Date.now()
  if (input.now !== undefined && observedNow < validated.updatedAt) {
    throw new AutoLabStateError('controller time must be monotonic', 'INVALID_STATE')
  }
  const now = Math.max(observedNow, validated.updatedAt)
  const blocker = resolveBlocker(validated, input.lifecycle, input.blocker)
  const config = input.config === undefined ? validated.config : input.config ?? undefined
  const revealState = input.revealState === undefined ? validated.revealState : input.revealState
  const controllerGoal = input.controllerGoal === undefined
    ? validated.controllerGoal
    : input.controllerGoal ?? undefined
  const roles = input.roles === undefined ? validated.roles : input.roles
  const reviews = input.reviews === undefined ? validated.reviews : input.reviews
  const candidates = input.candidates === undefined ? validated.candidates : input.candidates
  const retiredCandidates = input.retiredCandidates === undefined
    ? validated.retiredCandidates
    : input.retiredCandidates
  const trials = input.trials === undefined ? validated.trials : input.trials
  const {
    blocker: _priorBlocker,
    config: _priorConfig,
    revealState: _priorRevealState,
    controllerGoal: _priorControllerGoal,
    roles: _priorRoles,
    reviews: _priorReviews,
    candidates: _priorCandidates,
    retiredCandidates: _priorRetiredCandidates,
    trials: _priorTrials,
    ...withoutProjection
  } = validated
  return parseState({
    ...withoutProjection,
    lifecycle: input.lifecycle,
    runtimeRevision: validated.runtimeRevision + 1,
    updatedAt: now,
    roles,
    reviews,
    candidates,
    retiredCandidates,
    trials,
    ...(controllerGoal === undefined ? {} : { controllerGoal }),
    ...(config === undefined ? {} : { config }),
    ...(revealState === undefined ? {} : { revealState }),
    ...(blocker === undefined ? {} : { blocker }),
  })
}

export function adoptRuntimeOwner(
  current: RuntimeState,
  ownerEpoch: string,
  now?: number,
): RuntimeState {
  const validated = parseState(current)
  if (validated.ownerEpoch === ownerEpoch) return validated
  const observedNow = now ?? Date.now()
  if (now !== undefined && observedNow < validated.updatedAt) {
    throw new AutoLabStateError('controller time must be monotonic', 'INVALID_STATE')
  }
  return parseState({
    ...validated,
    ownerEpoch,
    runtimeRevision: validated.runtimeRevision + 1,
    updatedAt: Math.max(observedNow, validated.updatedAt),
  })
}

export function parseState(value: unknown): RuntimeState {
  const parsed = runtimeStateSchema.safeParse(value)
  if (!parsed.success) {
    throw new AutoLabStateError(`invalid RuntimeState: ${parsed.error.message}`, 'INVALID_STATE')
  }
  return parsed.data
}

export function validateLabId(value: string): string {
  if (!LAB_ID_PATTERN.test(value)) {
    throw new AutoLabStateError(`invalid lab id ${JSON.stringify(value)}`, 'INVALID_STATE')
  }
  return value
}

function resolveBlocker(
  current: RuntimeState,
  lifecycle: LabLifecycle,
  requested: RuntimeState['blocker'] | null | undefined,
): RuntimeState['blocker'] | undefined {
  if (lifecycle !== 'blocked') {
    if (requested !== undefined && requested !== null) {
      throw new AutoLabStateError('only blocked lifecycle may carry a blocker', 'INVALID_STATE')
    }
    return undefined
  }
  if (requested === null) {
    throw new AutoLabStateError('blocked lifecycle cannot clear its blocker', 'INVALID_STATE')
  }
  const blocker = requested ?? current.blocker
  if (blocker === undefined) {
    throw new AutoLabStateError('blocked lifecycle requires a blocker', 'INVALID_STATE')
  }
  return blocker
}
