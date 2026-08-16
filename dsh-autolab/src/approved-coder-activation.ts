import type { Context } from '@deepseek-ai/cordis'
import type { GoalRef } from '@deepseek-ai/dsh-goal'

import type { InitialRoleArtifacts } from './activation-artifacts.js'
import {
  freezeApprovedCoderArtifacts,
  type FreezeApprovedCoderArtifactsInput,
} from './approved-coder-artifacts.js'
import {
  compileLocalGoalIntent,
  installLocalGoal,
  type LocalGoalInstallIntent,
  type LocalGoalInstallResult,
} from './goal.js'
import { compileReviewResolution } from './review.js'
import {
  recordReviewResolution,
  roleStateSchema,
  type ActiveReview,
  type ReviewResolutionState,
  type RoleState,
} from './state.js'

export interface ApprovedCoderActivationPlan {
  readonly reviewId: string
  readonly coderRoleId: string
  readonly coderSessionId: string
  readonly packet: {
    readonly path: string
    readonly hash: string
  }
  readonly goalIntent: LocalGoalInstallIntent
  /** Recorded only after the exact Goal effect has been durably projected. */
  readonly resolution: ReviewResolutionState
}

export interface PreparedApprovedCoderActivation extends ApprovedCoderActivationPlan {
  readonly artifacts: InitialRoleArtifacts
}

export interface FreezeApprovedCoderActivationInput {
  readonly artifacts: FreezeApprovedCoderArtifactsInput
  readonly maxGoalRounds: number
  readonly expectedGoalRef: GoalRef | null
  /** Optional only for adopting an already-persisted activation identity. */
  readonly installId?: string
}

export interface CompileApprovedCoderActivationInput {
  readonly reviewId: string
  readonly verdictHash: string
  readonly coderRoleId: string
  readonly coderSessionId: string
  readonly assignmentId: string
  readonly packetPath: string
  readonly packetHash: string
  readonly objectiveBody: string
  readonly maxGoalRounds: number
  readonly expectedGoalRef: GoalRef | null
  readonly installId?: string
}

export class ApprovedCoderActivationError extends Error {
  readonly name = 'ApprovedCoderActivationError'

  constructor(
    message: string,
    readonly code:
      | 'IDENTITY_MISMATCH'
      | 'ACTIVATION_CONFLICT'
      | 'GOAL_ALREADY_COMPLETE',
  ) {
    super(message)
  }
}

/**
 * Freeze the exact APPROVED Method/Preflight inputs, then compile the one Coder
 * Goal identity. The caller has already selected this review; this function
 * performs no comparison, promotion, or scientific routing.
 */
export async function freezeApprovedCoderActivation(
  input: FreezeApprovedCoderActivationInput,
): Promise<PreparedApprovedCoderActivation> {
  const artifacts = await freezeApprovedCoderArtifacts(input.artifacts)
  const plan = compileApprovedCoderActivation({
    reviewId: input.artifacts.reviewId,
    verdictHash: input.artifacts.preflightVerdict.sha256,
    coderRoleId: input.artifacts.coderRole.role_id,
    coderSessionId: input.artifacts.coderSessionId,
    assignmentId: artifacts.assignmentId,
    packetPath: artifacts.packetPath,
    packetHash: artifacts.packet.packetHash,
    objectiveBody: artifacts.objectiveBody,
    maxGoalRounds: input.maxGoalRounds,
    expectedGoalRef: input.expectedGoalRef,
    ...(input.installId === undefined ? {} : { installId: input.installId }),
  })
  return { ...plan, artifacts }
}

/** Compile the deterministic control identities after immutable artifacts exist. */
export function compileApprovedCoderActivation(
  input: CompileApprovedCoderActivationInput,
): ApprovedCoderActivationPlan {
  const expectedAssignmentId = `coder:${input.reviewId}`
  if (input.assignmentId !== expectedAssignmentId) {
    throw new ApprovedCoderActivationError(
      `Coder Assignment ${JSON.stringify(input.assignmentId)} does not match review ${JSON.stringify(input.reviewId)}`,
      'IDENTITY_MISMATCH',
    )
  }
  const goalIntent = compileLocalGoalIntent({
    installId: input.installId ?? `${input.assignmentId}:install:1`,
    assignmentId: input.assignmentId,
    packetPath: input.packetPath,
    packetHash: input.packetHash,
    body: input.objectiveBody,
    maxGoalRounds: input.maxGoalRounds,
    expectedGoalRef: input.expectedGoalRef,
  })
  const resolution = compileReviewResolution({
    reviewId: input.reviewId,
    verdictHash: input.verdictHash,
    targetRoleId: input.coderRoleId,
    targetSessionId: input.coderSessionId,
    effect: {
      kind: 'goal_install',
      id: goalIntent.installId,
      hash: goalIntent.objectiveHash,
    },
  })
  return {
    reviewId: input.reviewId,
    coderRoleId: input.coderRoleId,
    coderSessionId: input.coderSessionId,
    packet: { path: input.packetPath, hash: input.packetHash },
    goalIntent,
    resolution,
  }
}

/**
 * Build the short CAS projection that must precede the native Goal mutation.
 * Exact retries are no-ops; a different in-flight activation is not overwritten.
 */
export function stageApprovedCoderActivation(
  role: RoleState,
  plan: ApprovedCoderActivationPlan,
): RoleState {
  assertRoleSession(role, plan)
  const current = role.goalInstall
  if (current !== undefined && sameInstallIdentity(current, plan)) {
    assertPacket(role, plan)
    if (current.status === 'applied') return role
  } else if (current !== undefined) {
    if (current.status !== 'applied'
      || !sameGoalRef(current, plan.goalIntent.expectedGoalRef)) {
      throw new ApprovedCoderActivationError(
        `Coder Session ${JSON.stringify(role.sessionId)} already has another in-flight Goal activation`,
        'ACTIVATION_CONFLICT',
      )
    }
  }

  const expected = plan.goalIntent.expectedGoalRef
  return roleStateSchema.parse({
    ...role,
    packet: plan.packet,
    goalInstall: {
      installId: plan.goalIntent.installId,
      assignmentId: plan.goalIntent.assignmentId,
      objectiveHash: plan.goalIntent.objectiveHash,
      maxGoalRounds: plan.goalIntent.maxGoalRounds,
      status: 'activating',
      ...(expected === null
        ? {}
        : { goalId: String(expected.id), goalRevision: expected.revision }),
    },
  })
}

/** Install or adopt the exact Goal after the activating projection is durable. */
export async function installApprovedCoderGoal(
  ctx: Context,
  plan: ApprovedCoderActivationPlan,
): Promise<LocalGoalInstallResult> {
  return await installLocalGoal(ctx, plan.coderSessionId, plan.goalIntent)
}

/** Build the second CAS projection after the native Goal mutation is durable. */
export function applyApprovedCoderGoal(
  role: RoleState,
  plan: ApprovedCoderActivationPlan,
  result: LocalGoalInstallResult,
): RoleState {
  assertRoleSession(role, plan)
  assertPacket(role, plan)
  if (!sameInstallIdentity(role.goalInstall, plan)) {
    throw new ApprovedCoderActivationError(
      `Coder Session ${JSON.stringify(role.sessionId)} activation changed before Goal apply`,
      'ACTIVATION_CONFLICT',
    )
  }
  if (result.objectiveHash !== plan.goalIntent.objectiveHash) {
    throw new ApprovedCoderActivationError(
      'native Goal result does not match the approved Coder activation',
      'IDENTITY_MISMATCH',
    )
  }
  if (result.outcome === 'already-complete') {
    throw new ApprovedCoderActivationError(
      `Coder Assignment ${JSON.stringify(plan.goalIntent.assignmentId)} already completed and requires receipt reconciliation`,
      'GOAL_ALREADY_COMPLETE',
    )
  }

  const { activationBlocker: _clearedAfterExactInstall, ...base } = role
  return roleStateSchema.parse({
    ...base,
    phase: 'working',
    goalInstall: {
      installId: plan.goalIntent.installId,
      assignmentId: plan.goalIntent.assignmentId,
      objectiveHash: plan.goalIntent.objectiveHash,
      maxGoalRounds: plan.goalIntent.maxGoalRounds,
      status: 'applied',
      goalId: String(result.ref.id),
      goalRevision: result.ref.revision,
    },
  })
}

/**
 * Record the already-applied Goal effect against the ready APPROVED review.
 * The process-local review hold may be released only after this projection is
 * durably committed by the caller.
 */
export function resolveApprovedCoderReview(
  review: ActiveReview,
  ownerEpoch: string,
  plan: ApprovedCoderActivationPlan,
  updatedAt: number,
): ActiveReview {
  if (review.stage !== 'preflight'
    || review.capability.reviewId !== plan.reviewId
    || review.verdict?.topLevelVerdict !== 'APPROVED') {
    throw new ApprovedCoderActivationError(
      `review ${JSON.stringify(plan.reviewId)} is not its exact APPROVED Preflight verdict`,
      'IDENTITY_MISMATCH',
    )
  }
  return recordReviewResolution(review, ownerEpoch, plan.resolution, updatedAt)
}

function assertRoleSession(role: RoleState, plan: ApprovedCoderActivationPlan): void {
  if (role.sessionId !== plan.coderSessionId) {
    throw new ApprovedCoderActivationError(
      `Coder role ${JSON.stringify(plan.coderRoleId)} is not bound to Session ${JSON.stringify(plan.coderSessionId)}`,
      'IDENTITY_MISMATCH',
    )
  }
}

function assertPacket(role: RoleState, plan: ApprovedCoderActivationPlan): void {
  if (role.packet?.path !== plan.packet.path || role.packet.hash !== plan.packet.hash) {
    throw new ApprovedCoderActivationError(
      `Coder Session ${JSON.stringify(role.sessionId)} does not project the approved Role Packet`,
      'ACTIVATION_CONFLICT',
    )
  }
}

function sameInstallIdentity(
  install: RoleState['goalInstall'],
  plan: ApprovedCoderActivationPlan,
): boolean {
  return install !== undefined
    && install.installId === plan.goalIntent.installId
    && install.assignmentId === plan.goalIntent.assignmentId
    && install.objectiveHash === plan.goalIntent.objectiveHash
    && install.maxGoalRounds === plan.goalIntent.maxGoalRounds
}

function sameGoalRef(
  install: NonNullable<RoleState['goalInstall']>,
  ref: GoalRef | null,
): boolean {
  return ref !== null
    && install.goalId === String(ref.id)
    && install.goalRevision === ref.revision
}
