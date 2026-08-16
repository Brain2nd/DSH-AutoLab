import { randomUUID } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  adoptRuntimeOwner,
  activeReviewSchema,
  activeTrialSchema,
  AutoLabStateError,
  createRuntimeState,
  parseState,
  reviewFreezeComplete,
  reviewPauseStateSchema,
  reviewReadyToAdvance,
  recordReviewResolution,
  ReviewResolutionError,
  transitionRuntimeState,
  type ActiveReview,
  type ConfigRef,
} from '../src/state.js'
import { compileReviewResolution } from '../src/review.js'

const LAB_ID = 'lab-20260815-120000-1234abcd'
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)
const HASH_D = 'd'.repeat(64)
const REQUEST_ID = '00000000-0000-4000-8000-000000000101'
const ACCEPTED_ID = '00000000-0000-4000-8000-000000000102'

function reviewFixture(ownerEpoch: string): ActiveReview {
  return activeReviewSchema.parse({
    stage: 'preflight',
    phase: 'verdict_recorded',
    sourcePacket: {
      path: '/lab/packets/method.json',
      hash: HASH_A,
    },
    packetPath: '/lab/packets/preflight.json',
    artifactPath: '/lab/artifacts/method-ticket.json',
    capability: {
      version: 1,
      reviewId: 'review-lane-a-1',
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
      request: { controlId: REQUEST_ID, payloadHash: `sha256:${HASH_A}` },
      acceptedPause: { controlId: ACCEPTED_ID, payloadHash: `sha256:${HASH_B}` },
    },
    pause: {
      controlId: ACCEPTED_ID,
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
      assignmentId: 'preflight:review-lane-a-1',
      reviewInputHash: HASH_C,
      topLevelVerdict: 'APPROVED',
      recordedAt: 9,
    },
    createdAt: 5,
    updatedAt: 9,
  })
}

function configRef(): ConfigRef {
  return {
    revision: 1,
    specHash: HASH_A,
    configHash: HASH_B,
    manifestHash: HASH_C,
    dialogueHeadHash: HASH_D,
    revisionPath: 'revisions/000001',
  }
}

function expectStateCode(operation: () => unknown, code: AutoLabStateError['code']): void {
  try {
    operation()
  } catch (error) {
    expect(error).toBeInstanceOf(AutoLabStateError)
    expect(error).toMatchObject({ code })
    return
  }
  throw new Error(`expected AutoLabStateError ${code}`)
}

describe('RuntimeState invariants', () => {
  it('stores Controller AutoLabWait as one optional true marker', () => {
    const base = createRuntimeState({
      labId: LAB_ID,
      ownerEpoch: randomUUID(),
      controllerSessionId: 'controller',
      lifecycle: 'ready',
      config: configRef(),
      now: 10,
    })
    const controllerGoal = {
      roleId: 'controller',
      packetHash: HASH_A,
      installId: 'controller-install',
      assignmentId: 'controller-assignment',
      objectiveHash: HASH_B,
      maxGoalRounds: 64,
      status: 'applied' as const,
      goalId: 'controller-goal',
      goalRevision: 1,
      waiting: true as const,
    }
    expect(parseState({ ...base, controllerGoal }).controllerGoal?.waiting).toBe(true)
    expect(() => parseState({
      ...base,
      controllerGoal: { ...controllerGoal, waiting: false },
    })).toThrow()
  })

  it('binds an active review pause to one positive safe observed turn', () => {
    const pause = {
      controlId: ACCEPTED_ID,
      payloadHash: `sha256:${HASH_B}`,
      freeze: 'stopped' as const,
      completedAt: 8,
      goalOutcome: 'paused' as const,
      activeTurn: true,
      observedTurn: 7,
    }

    expect(reviewPauseStateSchema.parse(pause)).toEqual(pause)
    expect(() => reviewPauseStateSchema.parse({
      ...pause,
      observedTurn: undefined,
    })).toThrow()
    expect(() => reviewPauseStateSchema.parse({
      ...pause,
      activeTurn: false,
    })).toThrow()

    for (const observedTurn of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => reviewPauseStateSchema.parse({
        ...pause,
        observedTurn,
      })).toThrow()
    }
  })

  it('requires CURRENT projection exactly when lifecycle is configured', () => {
    const ownerEpoch = randomUUID()
    expectStateCode(() => createRuntimeState({
      labId: LAB_ID,
      ownerEpoch,
      controllerSessionId: 'controller',
      lifecycle: 'ready',
      now: 10,
    }), 'INVALID_STATE')

    expectStateCode(() => createRuntimeState({
      labId: LAB_ID,
      ownerEpoch,
      controllerSessionId: 'controller',
      lifecycle: 'configuring',
      config: configRef(),
      now: 10,
    }), 'INVALID_STATE')

    expect(createRuntimeState({
      labId: LAB_ID,
      ownerEpoch,
      controllerSessionId: 'controller',
      lifecycle: 'ready',
      config: configRef(),
      now: 10,
    }).config).toEqual(configRef())
  })

  it('fences stale owners before applying revision CAS', () => {
    const ownerEpoch = randomUUID()
    const state = createRuntimeState({
      labId: LAB_ID,
      ownerEpoch,
      controllerSessionId: 'controller',
      lifecycle: 'ready',
      config: configRef(),
      now: 10,
    })

    expectStateCode(() => transitionRuntimeState(state, {
      expectedRevision: 999,
      ownerEpoch: randomUUID(),
      lifecycle: 'starting',
      now: 11,
    }), 'OWNER_FENCE_LOST')

    expectStateCode(() => transitionRuntimeState(state, {
      expectedRevision: 1,
      ownerEpoch,
      lifecycle: 'starting',
      now: 11,
    }), 'REVISION_CONFLICT')
  })

  it('allows only declared lifecycle edges and advances CAS once', () => {
    const ownerEpoch = randomUUID()
    const ready = createRuntimeState({
      labId: LAB_ID,
      ownerEpoch,
      controllerSessionId: 'controller',
      lifecycle: 'ready',
      config: configRef(),
      now: 10,
    })

    expectStateCode(() => transitionRuntimeState(ready, {
      expectedRevision: 0,
      ownerEpoch,
      lifecycle: 'running',
      now: 11,
    }), 'INVALID_TRANSITION')

    const starting = transitionRuntimeState(ready, {
      expectedRevision: 0,
      ownerEpoch,
      lifecycle: 'starting',
      now: 11,
    })
    const running = transitionRuntimeState(starting, {
      expectedRevision: 1,
      ownerEpoch,
      lifecycle: 'running',
      now: 12,
    })
    expect(running).toMatchObject({ lifecycle: 'running', runtimeRevision: 2 })

    const recovering = transitionRuntimeState(running, {
      expectedRevision: 2,
      ownerEpoch,
      lifecycle: 'starting',
      now: 13,
    })
    const recovered = transitionRuntimeState(recovering, {
      expectedRevision: 3,
      ownerEpoch,
      lifecycle: 'running',
      now: 14,
    })
    expect(recovered).toMatchObject({ lifecycle: 'running', runtimeRevision: 4 })

    const stopped = transitionRuntimeState(recovered, {
      expectedRevision: 4,
      ownerEpoch,
      lifecycle: 'stopped',
      now: 15,
    })
    expectStateCode(() => transitionRuntimeState(stopped, {
      expectedRevision: 5,
      ownerEpoch,
      lifecycle: 'ready',
      now: 16,
    }), 'INVALID_TRANSITION')
  })

  it('requires blockers only while blocked and clears them on recovery', () => {
    const ownerEpoch = randomUUID()
    const ready = createRuntimeState({
      labId: LAB_ID,
      ownerEpoch,
      controllerSessionId: 'controller',
      lifecycle: 'ready',
      config: configRef(),
      now: 10,
    })

    expectStateCode(() => transitionRuntimeState(ready, {
      expectedRevision: 0,
      ownerEpoch,
      lifecycle: 'blocked',
      now: 11,
    }), 'INVALID_STATE')

    const blocked = transitionRuntimeState(ready, {
      expectedRevision: 0,
      ownerEpoch,
      lifecycle: 'blocked',
      blocker: { code: 'PROVIDER_DOWN', message: 'provider unavailable' },
      now: 11,
    })
    expect(blocked.blocker).toEqual({
      code: 'PROVIDER_DOWN',
      message: 'provider unavailable',
    })

    const recovered = transitionRuntimeState(blocked, {
      expectedRevision: 1,
      ownerEpoch,
      lifecycle: 'ready',
      now: 12,
    })
    expect(recovered.lifecycle).toBe('ready')
    expect('blocker' in recovered).toBe(false)

    expectStateCode(() => transitionRuntimeState(recovered, {
      expectedRevision: 2,
      ownerEpoch,
      lifecycle: 'starting',
      blocker: { code: 'SHOULD_NOT_STICK', message: 'invalid' },
      now: 13,
    }), 'INVALID_STATE')
  })

  it('rejects backward clocks and malformed durable state', () => {
    const ownerEpoch = randomUUID()
    const state = createRuntimeState({
      labId: LAB_ID,
      ownerEpoch,
      controllerSessionId: 'controller',
      lifecycle: 'ready',
      config: configRef(),
      now: 10,
    })

    expectStateCode(() => transitionRuntimeState(state, {
      expectedRevision: 0,
      ownerEpoch,
      lifecycle: 'starting',
      now: 9,
    }), 'INVALID_STATE')

    expectStateCode(() => parseState({ ...state, unexpected: true }), 'INVALID_STATE')
    expectStateCode(() => parseState({ ...state, updatedAt: 9 }), 'INVALID_STATE')
  })

  it('adopts a new owner with one fenced revision and rejects a backward clock', () => {
    const state = createRuntimeState({
      labId: LAB_ID,
      ownerEpoch: randomUUID(),
      controllerSessionId: 'controller',
      lifecycle: 'ready',
      config: configRef(),
      now: 10,
    })
    const nextEpoch = randomUUID()
    const adopted = adoptRuntimeOwner(state, nextEpoch, 11)
    expect(adopted).toMatchObject({ ownerEpoch: nextEpoch, runtimeRevision: 1, updatedAt: 11 })
    expect(adoptRuntimeOwner(adopted, nextEpoch, 12)).toEqual(adopted)
    expectStateCode(() => adoptRuntimeOwner(adopted, randomUUID(), 10), 'INVALID_STATE')
  })

  it('joins verdict and worker-freeze axes without treating either one as sufficient', () => {
    const ownerEpoch = randomUUID()
    const review = {
      phase: 'verdict_recorded',
      pause: { freeze: 'stopped' },
    } as ActiveReview
    expect(reviewFreezeComplete(review, ownerEpoch)).toBe(true)
    expect(reviewReadyToAdvance(review, ownerEpoch)).toBe(true)
    expect(reviewReadyToAdvance({ ...review, phase: 'reviewing' }, ownerEpoch)).toBe(false)
    expect(reviewReadyToAdvance({
      ...review,
      pause: { ...review.pause, freeze: 'hold-pending' },
    }, ownerEpoch)).toBe(false)
    expect(reviewReadyToAdvance({
      ...review,
      pause: { ...review.pause, freeze: 'held', holdOwnerEpoch: ownerEpoch },
    }, ownerEpoch)).toBe(true)
    expect(reviewReadyToAdvance({
      ...review,
      pause: { ...review.pause, freeze: 'held', holdOwnerEpoch: randomUUID() },
    }, ownerEpoch)).toBe(false)
  })

  it('records one applied route idempotently and closes the released hold projection', () => {
    const ownerEpoch = randomUUID()
    const review = reviewFixture(ownerEpoch)
    const resolution = compileReviewResolution({
      reviewId: review.capability.reviewId,
      verdictHash: review.verdict!.hash,
      targetRoleId: 'lane-a-coder',
      targetSessionId: 'coder-session',
      effect: {
        kind: 'goal_install',
        id: 'lane-a:coder:1:install:1',
        hash: HASH_A,
      },
    })

    const recorded = recordReviewResolution(review, ownerEpoch, resolution, 10)
    expect(recorded.resolution).toEqual(resolution)
    expect(recorded.pause).toMatchObject({ freeze: 'stopped' })
    expect(recorded.pause).not.toHaveProperty('holdOwnerEpoch')
    expect(reviewReadyToAdvance(recorded, ownerEpoch)).toBe(false)
    expect(recordReviewResolution(recorded, ownerEpoch, resolution, 99)).toBe(recorded)

    const conflict = compileReviewResolution({
      ...resolution,
      effect: { ...resolution.effect, hash: HASH_B },
    })
    expect(() => recordReviewResolution(recorded, ownerEpoch, conflict, 11))
      .toThrowError(expect.objectContaining<Partial<ReviewResolutionError>>({
        code: 'RESOLUTION_CONFLICT',
      }))
    expect(() => recordReviewResolution(
      review,
      randomUUID(),
      resolution,
      10,
    )).toThrowError(expect.objectContaining<Partial<ReviewResolutionError>>({
      code: 'NOT_READY',
    }))
  })

  it('accepts only bounded Candidate and Trial identities tied to their Lane and CURRENT', () => {
    const ownerEpoch = randomUUID()
    const review = reviewFixture(ownerEpoch)
    const resolution = compileReviewResolution({
      reviewId: review.capability.reviewId,
      verdictHash: review.verdict!.hash,
      targetRoleId: 'lane-a-coder',
      targetSessionId: 'coder-session',
      effect: { kind: 'goal_install', id: 'coder-install-1', hash: HASH_A },
    })
    const resolvedReview = recordReviewResolution(review, ownerEpoch, resolution, 10)
    const reference = (name: string) => ({ path: `/lab/${name}.json`, hash: HASH_A })
    const roles = {
      'lane-a-method': {
        sessionId: 'method-session',
        phase: 'paused' as const,
        binding: reference('method-binding'),
        packet: reference('method-packet'),
      },
      'lane-a-preflight': {
        sessionId: 'judge-session',
        phase: 'declared' as const,
        binding: reference('judge-binding'),
        packet: reference('judge-packet'),
      },
      'lane-a-coder': {
        sessionId: 'coder-session',
        phase: 'paused' as const,
        binding: reference('coder-binding'),
        packet: reference('coder-packet'),
        goalInstall: {
          installId: resolution.effect.id,
          assignmentId: `coder:${review.capability.reviewId}`,
          objectiveHash: resolution.effect.hash,
          maxGoalRounds: 24,
          status: 'applied' as const,
          goalId: 'coder-goal',
          goalRevision: 1,
        },
      },
    }
    const candidate = {
      version: 1 as const,
      sourceRevision: 1,
      laneId: 'lane-a',
      candidateId: 'candidate-fused-gemm',
      reviewId: review.capability.reviewId,
      coderRoleId: 'lane-a-coder',
      coderSessionId: 'coder-session',
      assignmentId: `coder:${review.capability.reviewId}`,
      candidateSha: '1'.repeat(40),
      captureReceipt: reference('candidate-snapshot'),
      sourceReport: reference('coder-implementation'),
      frozenAt: 10,
    }
    const base = createRuntimeState({
      labId: LAB_ID,
      ownerEpoch,
      controllerSessionId: 'controller',
      lifecycle: 'ready',
      config: configRef(),
      now: 10,
    })
    const valid = parseState({
      ...base,
      lifecycle: 'running',
      roles,
      reviews: { [review.capability.reviewId]: resolvedReview },
      candidates: { 'lane-a': candidate },
    })
    expect(valid.candidates['lane-a']).toEqual(candidate)

    const trialId = 'trial-lane-a-fusion'
    const runSlotId = `${trialId}:primary`
    const activeTrial = {
      version: 1 as const,
      sourceRevision: 1,
      laneId: 'lane-a',
      candidateId: candidate.candidateId,
      candidateSha: candidate.candidateSha,
      contract: reference('trial-contract'),
      runSlots: {
        [runSlotId]: {
          contract: reference('runslot-contract'),
          state: {
            version: 1 as const,
            runslot_id: runSlotId,
            trial_id: trialId,
            runslot_contract_sha256: HASH_A,
            revision: 0 as const,
            status: 'pending' as const,
          },
        },
      },
    }
    const withTrial = parseState({
      ...valid,
      candidates: { 'lane-a': candidate },
      trials: { [trialId]: activeTrial },
    })
    expect(withTrial.trials[trialId]).toEqual(activeTrial)
    expectStateCode(() => parseState({
      ...withTrial,
      trials: { [trialId]: { ...activeTrial, candidateSha: '2'.repeat(40) } },
    }), 'INVALID_STATE')
    expectStateCode(() => parseState({
      ...withTrial,
      trials: {
        [trialId]: {
          ...activeTrial,
          runSlots: {
            [runSlotId]: {
              ...activeTrial.runSlots[runSlotId],
              state: {
                ...activeTrial.runSlots[runSlotId]!.state,
                runslot_contract_sha256: HASH_B,
              },
            },
          },
        },
      },
    }), 'INVALID_STATE')
    for (const candidates of [
      { 'lane-b': candidate },
      { 'lane-a': { ...candidate, coderSessionId: 'another-coder' } },
      { 'lane-a': { ...candidate, assignmentId: 'coder:another-review' } },
      { 'lane-a': { ...candidate, sourceRevision: 2 } },
      {
        'lane-a': {
          ...candidate,
          captureReceipt: { ...candidate.captureReceipt, path: 'relative.json' },
        },
      },
    ]) {
      expectStateCode(() => parseState({ ...valid, candidates }), 'INVALID_STATE')
    }
  })
})
