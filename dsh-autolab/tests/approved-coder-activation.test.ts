import { randomUUID } from 'node:crypto'

import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import GoalService, { GoalId } from '@deepseek-ai/dsh-goal'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'

import {
  applyApprovedCoderGoal,
  ApprovedCoderActivationError,
  compileApprovedCoderActivation,
  installApprovedCoderGoal,
  resolveApprovedCoderReview,
  stageApprovedCoderActivation,
} from '../src/approved-coder-activation.js'
import {
  activeReviewSchema,
  roleStateSchema,
  type ActiveReview,
} from '../src/state.js'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)
const HASH_D = 'd'.repeat(64)
const REVIEW_ID = 'review-lane-a-1'
const CODER_SESSION_ID = 'coder-session'

function plan(expectedGoalRef: { id: ReturnType<typeof GoalId>; revision: number } | null = null) {
  return compileApprovedCoderActivation({
    reviewId: REVIEW_ID,
    verdictHash: HASH_D,
    coderRoleId: 'lane-a-coder',
    coderSessionId: CODER_SESSION_ID,
    assignmentId: `coder:${REVIEW_ID}`,
    packetPath: '/lab/packets/coder-approved.json',
    packetHash: HASH_A,
    objectiveBody: 'Implement only the exact approved Design Ticket.',
    maxGoalRounds: 24,
    expectedGoalRef,
  })
}

function declaredCoder() {
  return roleStateSchema.parse({
    sessionId: CODER_SESSION_ID,
    phase: 'declared',
    binding: { path: '/lab/bindings/coder.json', hash: HASH_B },
    packet: { path: '/lab/packets/coder-bootstrap.json', hash: HASH_C },
  })
}

function approvedReview(ownerEpoch: string): ActiveReview {
  return activeReviewSchema.parse({
    stage: 'preflight',
    phase: 'verdict_recorded',
    sourcePacket: { path: '/lab/packets/method.json', hash: HASH_A },
    packetPath: '/lab/packets/preflight.json',
    artifactPath: '/lab/artifacts/method-ticket.json',
    capability: {
      version: 1,
      reviewId: REVIEW_ID,
      assignmentId: 'lane-a:method:1',
      configRevision: 1,
      runtimeRevision: 7,
      ownerFence: ownerEpoch,
      workerRoleId: 'lane-a-method',
      workerSessionId: 'method-session',
      judgeRoleId: 'lane-a-preflight',
      judgeSessionId: 'judge-session',
      packetHash: HASH_A,
      artifactHash: HASH_B,
      negotiatedAnchorHash: HASH_C,
      sourceTurn: 7,
      expectedGoalRef: { id: 'method-goal', revision: 2 },
      request: {
        controlId: '00000000-0000-4000-8000-000000000101',
        payloadHash: `sha256:${HASH_A}`,
      },
      acceptedPause: {
        controlId: '00000000-0000-4000-8000-000000000102',
        payloadHash: `sha256:${HASH_B}`,
      },
    },
    pause: {
      controlId: '00000000-0000-4000-8000-000000000102',
      payloadHash: `sha256:${HASH_B}`,
      freeze: 'held',
      completedAt: 8,
      goalOutcome: 'paused',
      activeTurn: true,
      observedTurn: 7,
      goalRef: { id: 'method-goal', revision: 3 },
      holdOwnerEpoch: ownerEpoch,
    },
    verdict: {
      path: '/lab/artifacts/preflight-verdict.json',
      hash: HASH_D,
      assignmentId: `preflight:${REVIEW_ID}`,
      reviewInputHash: HASH_C,
      topLevelVerdict: 'APPROVED',
      recordedAt: 9,
    },
    createdAt: 5,
    updatedAt: 9,
  })
}

describe('APPROVED Preflight to Coder activation', () => {
  it('compiles one deterministic Goal effect and stages only its durable projection', () => {
    const compiled = plan()
    const staged = stageApprovedCoderActivation(declaredCoder(), compiled)

    expect(compiled.goalIntent).toMatchObject({
      installId: `coder:${REVIEW_ID}:install:1`,
      assignmentId: `coder:${REVIEW_ID}`,
      maxGoalRounds: 24,
    })
    expect(compiled.resolution).toMatchObject({
      reviewId: REVIEW_ID,
      verdictHash: HASH_D,
      targetRoleId: 'lane-a-coder',
      targetSessionId: CODER_SESSION_ID,
      effect: {
        kind: 'goal_install',
        id: compiled.goalIntent.installId,
        hash: compiled.goalIntent.objectiveHash,
      },
    })
    expect(staged).toMatchObject({
      phase: 'declared',
      packet: compiled.packet,
      goalInstall: {
        status: 'activating',
        installId: compiled.goalIntent.installId,
        objectiveHash: compiled.goalIntent.objectiveHash,
      },
    })
    expect(stageApprovedCoderActivation(staged, compiled)).toEqual(staged)
  })

  it('uses the native Goal service, then projects applied without changing its round cap', async () => {
    const ctx = new Context()
    try {
      await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: '' } })
      await ctx.plugin(GoalService)
      await ctx.plugin(AgentLoop, { agents: [] })
      ctx.on('session/flush', () => undefined)
      await ctx.agents.create({ sessionId: SessionId(CODER_SESSION_ID) })

      const compiled = plan()
      const staged = stageApprovedCoderActivation(declaredCoder(), compiled)
      const installed = await installApprovedCoderGoal(ctx, compiled)
      const applied = applyApprovedCoderGoal(staged, compiled, installed)

      expect(installed).toMatchObject({ outcome: 'applied', roundsStarted: 0 })
      expect(applied).toMatchObject({
        phase: 'working',
        goalInstall: {
          status: 'applied',
          maxGoalRounds: 24,
          goalId: String(installed.ref.id),
          goalRevision: installed.ref.revision,
        },
      })
      expect(ctx.goals.get(ctx.agents.get(SessionId(CODER_SESSION_ID))!)).toMatchObject({
        objective: compiled.goalIntent.objective,
        maxGoalRounds: 24,
        roundsStarted: 0,
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('records the exact applied effect before the caller releases its held worker', () => {
    const ownerEpoch = randomUUID()
    const compiled = plan()
    const resolved = resolveApprovedCoderReview(
      approvedReview(ownerEpoch),
      ownerEpoch,
      compiled,
      10,
    )

    expect(resolved.resolution).toEqual(compiled.resolution)
    expect(resolved.pause.freeze).toBe('stopped')
    expect(resolved.pause).not.toHaveProperty('holdOwnerEpoch')
  })

  it('does not overwrite another in-flight activation or route a non-approved review', () => {
    const compiled = plan()
    const unrelated = roleStateSchema.parse({
      ...declaredCoder(),
      goalInstall: {
        installId: 'another-install',
        assignmentId: 'another-assignment',
        objectiveHash: HASH_B,
        maxGoalRounds: 12,
        status: 'activating',
      },
    })
    expect(() => stageApprovedCoderActivation(unrelated, compiled))
      .toThrowError(expect.objectContaining<Partial<ApprovedCoderActivationError>>({
        code: 'ACTIVATION_CONFLICT',
      }))

    const ownerEpoch = randomUUID()
    const rejected = activeReviewSchema.parse({
      ...approvedReview(ownerEpoch),
      verdict: {
        ...approvedReview(ownerEpoch).verdict!,
        topLevelVerdict: 'REJECTED',
      },
    })
    expect(() => resolveApprovedCoderReview(rejected, ownerEpoch, compiled, 10))
      .toThrowError(expect.objectContaining<Partial<ApprovedCoderActivationError>>({
        code: 'IDENTITY_MISMATCH',
      }))
  })
})
