import { SessionId } from '@deepseek-ai/dsh-session'
import type { ControlReceipt, JsonValue } from 'dsh-local-session-messaging'
import { describe, expect, it, vi } from 'vitest'

import AutoLabRuntime from '../src/index.js'
import {
  REVIEW_ACCEPTED_PAUSE,
  compileReviewControlCapability,
  type ReviewControlCapability,
} from '../src/review.js'
import type { RuntimeState } from '../src/state.js'

const OWNER = '00000000-0000-4000-8000-000000000903'

function capability(): ReviewControlCapability {
  return compileReviewControlCapability({
    reviewId: 'review-lane-a-1',
    assignmentId: 'lane-a:method:1',
    configRevision: 1,
    runtimeRevision: 7,
    ownerFence: OWNER,
    workerRoleId: 'lane-a-method',
    workerSessionId: 'worker-session',
    judgeRoleId: 'lane-a-preflight',
    judgeSessionId: 'judge-session',
    packetHash: 'a'.repeat(64),
    artifactHash: 'b'.repeat(64),
    negotiatedAnchorHash: 'c'.repeat(64),
    sourceTurn: 7,
    expectedGoalRef: { id: 'goal-method-1', revision: 8 },
    requestControlId: '00000000-0000-4000-8000-000000000901',
    acceptedPauseControlId: '00000000-0000-4000-8000-000000000902',
  })
}

function receipt(
  edge: ReviewControlCapability,
  turnOutcome: 'stopped' | 'source-active' | 'user-override',
  observedTurn?: number,
): ControlReceipt {
  return {
    controlId: edge.acceptedPause.controlId,
    kind: REVIEW_ACCEPTED_PAUSE,
    payloadHash: edge.acceptedPause.payloadHash,
    senderSessionId: SessionId(edge.judgeSessionId),
    recipientSessionId: SessionId(edge.workerSessionId),
    recipientName: edge.workerSessionId,
    status: 'accepted',
    outcome: {
      status: 'completed',
      completedAt: 11,
      result: {
        version: 1,
        type: 'REVIEW_PAUSE_OUTCOME',
        reviewId: edge.reviewId,
        requestControlId: edge.request.controlId,
        acknowledgement: '已收到，请等待审核。\n/goal pause',
        goalAction: 'pause',
        goalOutcome: 'paused',
        activeTurn: observedTurn !== undefined,
        turnOutcome,
        ...(observedTurn === undefined ? {} : { observedTurn }),
        goalRef: { id: 'goal-method-1', revision: 9 },
      } as JsonValue,
    },
    createdAt: 10,
    updatedAt: 11,
  }
}

interface ReviewRuntimeInternals {
  handleReviewControlStatus(receipt: ControlReceipt): Promise<void>
  startJudgeReviewIfFrozen(reviewId: string): Promise<void>
}

const runtime = AutoLabRuntime.prototype as unknown as ReviewRuntimeInternals

describe('Controller review freeze ordering', () => {
  it('persists the pause, finishes the exact-turn hold, then starts Judge', async () => {
    const edge = capability()
    const calls: string[] = []
    let review = {
      capability: edge,
      verdict: undefined,
      pause: {
        controlId: edge.acceptedPause.controlId,
        payloadHash: edge.acceptedPause.payloadHash,
        freeze: 'pending',
      },
    } as unknown as RuntimeState['reviews'][string]
    const state = {
      labId: 'lab-20260815-120000-1234abcd',
      ownerEpoch: OWNER,
      roles: { 'lane-a-method': { phase: 'reviewing' } },
    } as unknown as RuntimeState
    const startJudgeReviewOnce = vi.fn(async () => {
      calls.push('judge-start')
      expect(review.pause).toMatchObject({ freeze: 'held', holdOwnerEpoch: OWNER })
      return 'started' as const
    })
    const receiver = {
      accepting: true,
      findActiveReview: () => ({ state, review }),
      recordReviewPauseOutcome: async (
        _labId: string,
        _reviewId: string,
        pause: RuntimeState['reviews'][string]['pause'],
      ) => {
        calls.push('pause-persisted')
        review = { ...review, pause }
      },
      acquireReviewHoldOnce: async () => {
        calls.push('hold-persisted')
        review = {
          ...review,
          pause: { ...review.pause, freeze: 'held', holdOwnerEpoch: OWNER },
        }
      },
      startJudgeReviewIfFrozen: runtime.startJudgeReviewIfFrozen,
      startJudgeReviewOnce,
    }

    await runtime.handleReviewControlStatus.call(
      receiver as unknown as AutoLabRuntime,
      receipt(edge, 'source-active', 7),
    )

    expect(calls).toEqual(['pause-persisted', 'hold-persisted', 'judge-start'])
    expect(startJudgeReviewOnce).toHaveBeenCalledTimes(1)
  })

  it('persists a newer turn as user override and never enters cancel/hold or Judge start', async () => {
    const edge = capability()
    let review = {
      capability: edge,
      verdict: undefined,
      pause: {
        controlId: edge.acceptedPause.controlId,
        payloadHash: edge.acceptedPause.payloadHash,
        freeze: 'pending',
      },
    } as unknown as RuntimeState['reviews'][string]
    const state = {
      labId: 'lab-20260815-120000-1234abcd',
      ownerEpoch: OWNER,
      roles: { 'lane-a-method': { phase: 'reviewing' } },
    } as unknown as RuntimeState
    const acquireReviewHoldOnce = vi.fn()
    const startJudgeReviewOnce = vi.fn()
    const receiver = {
      accepting: true,
      findActiveReview: () => ({ state, review }),
      recordReviewPauseOutcome: async (
        _labId: string,
        _reviewId: string,
        pause: RuntimeState['reviews'][string]['pause'],
      ) => {
        review = { ...review, pause }
      },
      acquireReviewHoldOnce,
      startJudgeReviewIfFrozen: runtime.startJudgeReviewIfFrozen,
      startJudgeReviewOnce,
    }

    await runtime.handleReviewControlStatus.call(
      receiver as unknown as AutoLabRuntime,
      receipt(edge, 'user-override', 8),
    )

    expect(review.pause).toMatchObject({
      freeze: 'user-override',
      observedTurn: 8,
      detail: 'SOURCE_TURN_CHANGED',
    })
    expect(acquireReviewHoldOnce).not.toHaveBeenCalled()
    expect(startJudgeReviewOnce).not.toHaveBeenCalled()
  })

  it('rejects a source-active outcome whose turn differs from the bound source turn', async () => {
    const edge = capability()
    const review = {
      capability: edge,
      verdict: undefined,
      pause: {
        controlId: edge.acceptedPause.controlId,
        payloadHash: edge.acceptedPause.payloadHash,
        freeze: 'pending',
      },
    } as unknown as RuntimeState['reviews'][string]
    const state = {
      labId: 'lab-20260815-120000-1234abcd',
      ownerEpoch: OWNER,
      roles: { 'lane-a-method': { phase: 'reviewing' } },
    } as unknown as RuntimeState
    const recordReviewPauseOutcome = vi.fn()
    const acquireReviewHoldOnce = vi.fn()
    const startJudgeReviewOnce = vi.fn()
    const receiver = {
      accepting: true,
      findActiveReview: () => ({ state, review }),
      recordReviewPauseOutcome,
      acquireReviewHoldOnce,
      startJudgeReviewIfFrozen: runtime.startJudgeReviewIfFrozen,
      startJudgeReviewOnce,
    }

    await runtime.handleReviewControlStatus.call(
      receiver as unknown as AutoLabRuntime,
      receipt(edge, 'source-active', 8),
    )

    expect(recordReviewPauseOutcome).not.toHaveBeenCalled()
    expect(acquireReviewHoldOnce).not.toHaveBeenCalled()
    expect(startJudgeReviewOnce).not.toHaveBeenCalled()
  })
})
