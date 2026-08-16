import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { GoalId, type GoalRef, type GoalView } from '@deepseek-ai/dsh-goal'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  controlPayloadHash,
  type ControlReceipt,
  type IncomingControl,
  type JsonValue,
} from 'dsh-local-session-messaging'
import { describe, expect, it, vi } from 'vitest'

import {
  REVIEW_ACCEPTED_PAUSE,
  REVIEW_ACCEPTED_TEXT,
  REVIEW_REQUEST,
  compileReviewControlCapability,
  compileReviewResolution,
  createReviewControlHandlers,
  pauseExpectedReviewGoal,
  reviewAcceptedPausePayload,
  reviewRequestPayload,
  sendReviewRequest,
  type ReviewControlCapability,
  type ReviewControlCapabilityInput,
} from '../src/review.js'

const REQUEST_ID = '00000000-0000-4000-8000-000000000901'
const ACCEPTED_ID = '00000000-0000-4000-8000-000000000902'
const OWNER_FENCE = '00000000-0000-4000-8000-000000000903'
const PACKET_HASH = 'a'.repeat(64)
const ARTIFACT_HASH = 'b'.repeat(64)
const ANCHOR_HASH = 'c'.repeat(64)

function capabilityInput(
  overrides: Partial<ReviewControlCapabilityInput> = {},
): ReviewControlCapabilityInput {
  return {
    reviewId: 'review-lane-a-1',
    assignmentId: 'lane-a:method:1',
    configRevision: 3,
    runtimeRevision: 17,
    ownerFence: OWNER_FENCE,
    workerRoleId: 'lane-a-method',
    workerSessionId: 'worker-session',
    judgeRoleId: 'lane-a-preflight',
    judgeSessionId: 'judge-session',
    packetHash: PACKET_HASH,
    artifactHash: ARTIFACT_HASH,
    negotiatedAnchorHash: ANCHOR_HASH,
    sourceTurn: 7,
    expectedGoalRef: { id: 'goal-method-1', revision: 8 },
    requestControlId: REQUEST_ID,
    acceptedPauseControlId: ACCEPTED_ID,
    ...overrides,
  }
}

function incoming(
  capability: ReviewControlCapability,
  direction: 'request' | 'acceptedPause',
  overrides: Partial<IncomingControl> = {},
): IncomingControl {
  const request = direction === 'request'
  const payload = request
    ? reviewRequestPayload(capability)
    : reviewAcceptedPausePayload(capability)
  return {
    controlId: request
      ? capability.request.controlId
      : capability.acceptedPause.controlId,
    kind: request ? REVIEW_REQUEST : REVIEW_ACCEPTED_PAUSE,
    payload: payload as unknown as JsonValue,
    payloadHash: request
      ? capability.request.payloadHash
      : capability.acceptedPause.payloadHash,
    senderSessionId: SessionId(request
      ? capability.workerSessionId
      : capability.judgeSessionId),
    senderPrincipalSessionId: SessionId(request
      ? capability.workerSessionId
      : capability.judgeSessionId),
    recipientSessionId: SessionId(request
      ? capability.judgeSessionId
      : capability.workerSessionId),
    recipientPrincipalSessionId: SessionId(request
      ? capability.judgeSessionId
      : capability.workerSessionId),
    attempt: 1,
    ...overrides,
  }
}

interface FakeAgent extends Agent {
  readonly followup: ReturnType<typeof vi.fn>
  readonly steer: ReturnType<typeof vi.fn>
  readonly inject: ReturnType<typeof vi.fn>
  readonly cancel: ReturnType<typeof vi.fn>
  readonly runMaintenance: ReturnType<typeof vi.fn>
}

function turnStart(turn: number, seq = 0): SessionEvent<'turn/start'> {
  return { type: 'turn/start', seq, time: seq + 1, data: { turn } }
}

function turnEnd(turn: number, seq = 1): SessionEvent<'turn/end'> {
  return {
    type: 'turn/end',
    seq,
    time: seq + 1,
    data: { turn, reason: { kind: 'completed' } },
  }
}

function agent(
  id: string,
  status: AgentStatus = 'idle',
  events: readonly SessionEvent[] = status === 'running' ? [turnStart(7)] : [],
): FakeAgent {
  const session = { id: SessionId(id), events } as unknown as Session
  return {
    id: session.id,
    session,
    options: {},
    inbox: { hasPending: false } as Agent['inbox'],
    ctx: {} as Context,
    status,
    send: vi.fn(() => {
      throw new Error('review ACK must not use the model Inbox')
    }),
    followup: vi.fn(() => {
      throw new Error('review ACK must not create a model turn')
    }),
    steer: vi.fn(() => {
      throw new Error('review ACK must not create model steering')
    }),
    inject: vi.fn(() => {
      throw new Error('review ACK must not inject model context')
    }),
    cancel: vi.fn(() => {
      throw new Error('typed pause must not automatically cancel the active turn')
    }),
    whenIdle: vi.fn(async () => undefined),
    runMaintenance: vi.fn(() => {
      throw new Error('typed pause must not automatically acquire a fallback hold')
    }),
  } as unknown as FakeAgent
}

function receipt(
  capability: ReviewControlCapability,
  status: ControlReceipt['status'] = 'queued',
): ControlReceipt {
  return {
    controlId: capability.acceptedPause.controlId,
    kind: REVIEW_ACCEPTED_PAUSE,
    payloadHash: capability.acceptedPause.payloadHash,
    senderSessionId: SessionId(capability.judgeSessionId),
    recipientSessionId: SessionId(capability.workerSessionId),
    recipientName: capability.workerSessionId,
    status,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('review control capability', () => {
  it('binds both exact envelopes while keeping the ACK and action fixed', () => {
    const capability = compileReviewControlCapability(capabilityInput())
    const request = reviewRequestPayload(capability)
    const accepted = reviewAcceptedPausePayload(capability)

    expect(request).toMatchObject({
      type: REVIEW_REQUEST,
      requestControlId: REQUEST_ID,
      sourceSessionId: 'worker-session',
      targetSessionId: 'judge-session',
      configRevision: 3,
      runtimeRevision: 17,
      ownerFence: OWNER_FENCE,
      packetHash: PACKET_HASH,
      artifactHash: ARTIFACT_HASH,
      negotiatedAnchorHash: ANCHOR_HASH,
      sourceTurn: 7,
      expectedGoalRef: { id: 'goal-method-1', revision: 8 },
    })
    expect(accepted).toMatchObject({
      type: REVIEW_ACCEPTED_PAUSE,
      acceptedPauseControlId: ACCEPTED_ID,
      requestControlId: REQUEST_ID,
      requestPayloadHash: capability.request.payloadHash,
      sourceSessionId: 'judge-session',
      targetSessionId: 'worker-session',
      sourceTurn: 7,
      acknowledgement: REVIEW_ACCEPTED_TEXT,
      goalAction: 'pause',
    })
    expect(capability.request.payloadHash).toBe(
      controlPayloadHash(request as unknown as JsonValue),
    )
    expect(capability.acceptedPause.payloadHash).toBe(
      controlPayloadHash(accepted as unknown as JsonValue),
    )
    const anotherTurn = compileReviewControlCapability(capabilityInput({ sourceTurn: 8 }))
    expect(anotherTurn.request.payloadHash).not.toBe(capability.request.payloadHash)
    expect(anotherTurn.acceptedPause.payloadHash).not.toBe(capability.acceptedPause.payloadHash)
    expect(accepted).not.toHaveProperty('command')
    expect(accepted).not.toHaveProperty('shell')
    expect(accepted).not.toHaveProperty('text')
  })

  it('fails closed on altered hashes, identities, and control ids', () => {
    const capability = compileReviewControlCapability(capabilityInput())
    expect(() => reviewRequestPayload({
      ...capability,
      packetHash: 'd'.repeat(64),
    })).toThrowError(expect.objectContaining({ code: 'INVALID_CAPABILITY' }))
    expect(() => reviewAcceptedPausePayload({
      ...capability,
      acceptedPause: {
        ...capability.acceptedPause,
        payloadHash: `sha256:${'0'.repeat(64)}`,
      },
    })).toThrowError(expect.objectContaining({ code: 'INVALID_CAPABILITY' }))
    expect(() => compileReviewControlCapability(capabilityInput({
      requestControlId: 'not-a-control-id',
    }))).toThrowError(expect.objectContaining({ code: 'INVALID_CAPABILITY' }))
  })
})

describe('review resolution marker', () => {
  it('binds one deterministic target and already-applied effect', () => {
    const input = {
      reviewId: 'review-lane-a-1',
      verdictHash: 'd'.repeat(64),
      targetRoleId: 'lane-a-coder',
      targetSessionId: 'coder-session',
      effect: {
        kind: 'goal_install',
        id: 'lane-a:coder:1:install:1',
        hash: 'e'.repeat(64),
      },
    }
    const first = compileReviewResolution(input)
    const retry = compileReviewResolution(structuredClone(input))

    expect(retry).toEqual(first)
    expect(first).toMatchObject({ version: 1, ...input })
    expect(first.resolutionHash).toMatch(/^[0-9a-f]{64}$/u)
    expect(compileReviewResolution({
      ...input,
      targetSessionId: 'another-coder-session',
    }).resolutionHash).not.toBe(first.resolutionHash)
    expect(compileReviewResolution({
      ...input,
      effect: { ...input.effect, hash: 'f'.repeat(64) },
    }).resolutionHash).not.toBe(first.resolutionHash)
  })
})

describe('REVIEW_REQUEST receiver', () => {
  it('durably sends one fixed ACK control and leaves Judge start deferred to durable freeze', async () => {
    const capability = compileReviewControlCapability(capabilityInput())
    const worker = agent(capability.workerSessionId)
    const judge = agent(capability.judgeSessionId)
    const calls: string[] = []
    const persistedControls = new Set<string>()
    const sendControl = vi.fn(async (_caller: Agent, request: { controlId: string }) => {
      if (!persistedControls.has(request.controlId)) {
        persistedControls.add(request.controlId)
        calls.push('accepted-persisted')
      }
      return receipt(capability)
    })
    const ctx = {
      agents: {
        get: vi.fn((id: ReturnType<typeof SessionId>) => String(id) === String(judge.id)
          ? judge
          : String(id) === String(worker.id)
            ? worker
            : undefined),
      },
      sessionMessaging: { sendControl },
    } as unknown as Context
    const handlers = createReviewControlHandlers(ctx, {
      resolveCapability: controlId => controlId === REQUEST_ID || controlId === ACCEPTED_ID
        ? capability
        : undefined,
    })
    const control = incoming(capability, 'request')

    await expect(handlers.request.authorize(control)).resolves.toBe(true)
    const first = await handlers.request.handle(control)
    const duplicate = await handlers.request.handle({ ...control, attempt: 2 })

    expect(first).toMatchObject({ result: { judgeStart: 'awaiting-pause' } })
    expect(duplicate).toMatchObject({ result: { judgeStart: 'awaiting-pause' } })
    expect(calls).toEqual(['accepted-persisted'])
    expect(persistedControls).toEqual(new Set([ACCEPTED_ID]))
    expect(sendControl).toHaveBeenCalledTimes(2)
    expect(sendControl).toHaveBeenNthCalledWith(1, judge, {
      controlId: ACCEPTED_ID,
      recipient: 'worker-session',
      kind: REVIEW_ACCEPTED_PAUSE,
      payload: reviewAcceptedPausePayload(capability),
      payloadHash: capability.acceptedPause.payloadHash,
      waitForAcknowledgement: false,
    })
    expect(sendControl).toHaveBeenNthCalledWith(2, judge, {
      controlId: ACCEPTED_ID,
      recipient: 'worker-session',
      kind: REVIEW_ACCEPTED_PAUSE,
      payload: reviewAcceptedPausePayload(capability),
      payloadHash: capability.acceptedPause.payloadHash,
      waitForAcknowledgement: false,
    })
    expect(first).toMatchObject({
      status: 'completed',
      result: {
        type: 'REVIEW_REQUEST_OUTCOME',
        acceptedPauseControlId: ACCEPTED_ID,
        judgeStart: 'awaiting-pause',
      },
    })
    expect((first as { result?: object }).result).not.toHaveProperty('verdict')
    expect(worker.inbox.hasPending).toBe(false)
    expect(worker.followup).not.toHaveBeenCalled()
    expect(worker.steer).not.toHaveBeenCalled()
    expect(worker.inject).not.toHaveBeenCalled()
    expect(judge.followup).not.toHaveBeenCalled()
  })

  it('does not start Judge when shutdown wins after the ACK is durable', async () => {
    const capability = compileReviewControlCapability(capabilityInput())
    const worker = agent(capability.workerSessionId)
    const judge = agent(capability.judgeSessionId)
    const shutdown = new AbortController()
    const ackDurable = Promise.withResolvers<void>()
    const releaseSend = Promise.withResolvers<void>()
    const resolveCapability = vi.fn(() => capability)
    const sendControl = vi.fn(async () => {
      ackDurable.resolve()
      await releaseSend.promise
      return receipt(capability)
    })
    const ctx = {
      agents: {
        get: vi.fn((id: ReturnType<typeof SessionId>) => String(id) === String(judge.id)
          ? judge
          : String(id) === String(worker.id)
            ? worker
            : undefined),
      },
      sessionMessaging: { sendControl },
    } as unknown as Context
    const handlers = createReviewControlHandlers(ctx, {
      signal: shutdown.signal,
      resolveCapability,
    })

    const handling = handlers.request.handle(incoming(capability, 'request'))
    expect(resolveCapability).toHaveBeenCalledTimes(1)

    await ackDurable.promise
    shutdown.abort()
    releaseSend.resolve()
    await expect(handling).rejects.toMatchObject({ name: 'AbortError' })

    expect(sendControl).toHaveBeenCalledTimes(1)
  })

  it('rejects an envelope that misses any exact identity or live capability', async () => {
    const capability = compileReviewControlCapability(capabilityInput())
    const judge = agent(capability.judgeSessionId)
    const sendControl = vi.fn()
    let authorized = true
    const ctx = {
      agents: { get: vi.fn(() => judge) },
      sessionMessaging: { sendControl },
    } as unknown as Context
    const handlers = createReviewControlHandlers(ctx, {
      resolveCapability: () => authorized ? capability : undefined,
    })
    const exact = incoming(capability, 'request')
    const wrongPrincipal = {
      ...exact,
      senderPrincipalSessionId: SessionId('another-root'),
    }
    const alteredPayload = {
      ...(exact.payload as Record<string, JsonValue>),
      ownerFence: '00000000-0000-4000-8000-000000000999',
    }

    await expect(handlers.request.authorize(wrongPrincipal)).resolves.toBe(false)
    await expect(handlers.request.authorize({
      ...exact,
      payload: alteredPayload,
      payloadHash: controlPayloadHash(alteredPayload),
    })).resolves.toBe(false)

    authorized = false
    await expect(handlers.request.handle(exact)).resolves.toEqual({
      status: 'rejected',
      detail: 'review capability is absent, stale, or does not match the envelope',
    })
    expect(sendControl).not.toHaveBeenCalled()
  })

  it('sends REVIEW_REQUEST only from the exact reviewed Session', async () => {
    const capability = compileReviewControlCapability(capabilityInput())
    const worker = agent(capability.workerSessionId)
    const other = agent('other-worker')
    const requestReceipt = {
      ...receipt(capability),
      controlId: REQUEST_ID,
      kind: REVIEW_REQUEST,
      payloadHash: capability.request.payloadHash,
      senderSessionId: worker.id,
      recipientSessionId: SessionId(capability.judgeSessionId),
    }
    const sendControl = vi.fn(async () => requestReceipt)
    const ctx = { sessionMessaging: { sendControl } } as unknown as Context

    await expect(sendReviewRequest(ctx, worker, capability)).resolves.toEqual(requestReceipt)
    expect(sendControl).toHaveBeenCalledWith(worker, {
      controlId: REQUEST_ID,
      recipient: capability.judgeSessionId,
      kind: REVIEW_REQUEST,
      payload: reviewRequestPayload(capability),
      payloadHash: capability.request.payloadHash,
      waitForAcknowledgement: false,
    }, undefined)
    await expect(sendReviewRequest(ctx, other, capability)).rejects.toMatchObject({
      code: 'CAPABILITY_MISMATCH',
    })
  })
})

function goal(overrides: Partial<GoalView> = {}): GoalView {
  return {
    id: GoalId('goal-method-1'),
    revision: 8,
    objective: 'exact reviewed assignment',
    phase: 'active',
    maxGoalRounds: 10,
    roundsStarted: 2,
    createdAt: 1,
    updatedAt: 2,
    activation: 'armed',
    ...overrides,
  }
}

function pauseHarness(
  initial: GoalView | undefined,
  status: AgentStatus = 'idle',
  events?: readonly SessionEvent[],
): {
  readonly ctx: Context
  readonly worker: FakeAgent
  readonly pause: ReturnType<typeof vi.fn>
  readonly flush: ReturnType<typeof vi.fn>
  current(): GoalView | undefined
} {
  let current = initial
  const worker = agent('worker-session', status, events)
  const pause = vi.fn((_agent: Agent, ref: GoalRef) => {
    if (current === undefined
      || String(current.id) !== String(ref.id)
      || current.revision !== ref.revision) {
      throw new Error('stale GoalRef reached GoalService')
    }
    current = {
      ...current,
      revision: current.revision + 1,
      phase: 'paused',
      activation: 'disarmed',
    }
    return current
  })
  const flush = vi.fn(async () => true)
  const ctx = {
    agents: {
      get: vi.fn((id: ReturnType<typeof SessionId>) => id === worker.id ? worker : undefined),
    },
    goals: {
      get: vi.fn(() => current),
      pause,
    },
    sessions: { flush },
  } as unknown as Context
  return { ctx, worker, pause, flush, current: () => current }
}

describe('REVIEW_ACCEPTED_PAUSE receiver', () => {
  it('durably pauses the exact Goal but leaves active-turn fallback to the Controller', async () => {
    const capability = compileReviewControlCapability(capabilityInput())
    const harness = pauseHarness(goal(), 'running')
    const ctx = Object.assign(harness.ctx, {
      sessionMessaging: { sendControl: vi.fn() },
    }) as unknown as Context
    const handlers = createReviewControlHandlers(ctx, {
      resolveCapability: () => capability,
    })
    const control = incoming(capability, 'acceptedPause')

    await expect(handlers.acceptedPause.authorize(control)).resolves.toBe(true)
    const decision = await handlers.acceptedPause.handle(control)
    expect(decision).toMatchObject({
      status: 'completed',
      result: {
        type: 'REVIEW_PAUSE_OUTCOME',
        acknowledgement: REVIEW_ACCEPTED_TEXT,
        goalAction: 'pause',
        goalOutcome: 'paused',
        activeTurn: true,
        turnOutcome: 'source-active',
        observedTurn: 7,
        goalRef: { id: 'goal-method-1', revision: 9 },
      },
    })
    expect((decision as { result?: object }).result).not.toHaveProperty('verdict')
    expect(harness.pause).toHaveBeenCalledTimes(1)
    expect(harness.flush).toHaveBeenCalledTimes(1)
    expect(harness.worker.cancel).not.toHaveBeenCalled()
    expect(harness.worker.runMaintenance).not.toHaveBeenCalled()
    expect(harness.worker.followup).not.toHaveBeenCalled()
    expect(harness.worker.steer).not.toHaveBeenCalled()
    expect(harness.worker.inject).not.toHaveBeenCalled()

    await expect(handlers.acceptedPause.handle({ ...control, attempt: 2 })).resolves.toMatchObject({
      status: 'completed',
      result: {
        goalOutcome: 'already-applied',
        activeTurn: true,
        turnOutcome: 'source-active',
        observedTurn: 7,
      },
    })
    expect(harness.pause).toHaveBeenCalledTimes(1)
    expect(harness.flush).toHaveBeenCalledTimes(2)
  })

  it('retries the durability flush after the Goal mutation won the first attempt', async () => {
    const capability = compileReviewControlCapability(capabilityInput())
    const harness = pauseHarness(goal())
    const firstFlushFailure = new Error('first durability flush failed')
    const retryFlush = Promise.withResolvers<boolean>()
    const sequence: string[] = []
    harness.flush
      .mockRejectedValueOnce(firstFlushFailure)
      .mockImplementationOnce(async () => {
        sequence.push('retry-flush-started')
        await retryFlush.promise
        sequence.push('retry-flush-finished')
        return true
      })
    const ctx = Object.assign(harness.ctx, {
      sessionMessaging: { sendControl: vi.fn() },
    }) as unknown as Context
    const handlers = createReviewControlHandlers(ctx, {
      resolveCapability: () => capability,
    })
    const control = incoming(capability, 'acceptedPause')

    await expect(handlers.acceptedPause.handle(control)).rejects.toBe(firstFlushFailure)
    expect(harness.current()).toMatchObject({ revision: 9, phase: 'paused' })
    expect(harness.pause).toHaveBeenCalledTimes(1)
    expect(harness.flush).toHaveBeenCalledTimes(1)

    const retry = handlers.acceptedPause.handle({ ...control, attempt: 2 }).then(decision => {
      sequence.push('completed')
      return decision
    })
    expect(harness.pause).toHaveBeenCalledTimes(1)
    expect(harness.flush).toHaveBeenCalledTimes(2)
    expect(sequence).toEqual(['retry-flush-started'])

    retryFlush.resolve(true)
    await expect(retry).resolves.toMatchObject({
      status: 'completed',
      result: {
        goalOutcome: 'already-applied',
        activeTurn: false,
        turnOutcome: 'stopped',
      },
    })
    expect(sequence).toEqual(['retry-flush-started', 'retry-flush-finished', 'completed'])
  })

  it('treats a false flush as non-durable and retries the same pause effect', async () => {
    const capability = compileReviewControlCapability(capabilityInput())
    const harness = pauseHarness(goal())
    harness.flush.mockResolvedValueOnce(false)
    const ctx = Object.assign(harness.ctx, {
      sessionMessaging: { sendControl: vi.fn() },
    }) as unknown as Context
    const handlers = createReviewControlHandlers(ctx, {
      resolveCapability: () => capability,
    })
    const control = incoming(capability, 'acceptedPause')

    await expect(handlers.acceptedPause.handle(control)).rejects.toMatchObject({
      code: 'DURABILITY_UNAVAILABLE',
    })
    expect(harness.current()).toMatchObject({ revision: 9, phase: 'paused' })
    expect(harness.pause).toHaveBeenCalledTimes(1)

    await expect(handlers.acceptedPause.handle({ ...control, attempt: 2 })).resolves.toMatchObject({
      status: 'completed',
      result: {
        goalOutcome: 'already-applied',
        activeTurn: false,
        turnOutcome: 'stopped',
      },
    })
    expect(harness.pause).toHaveBeenCalledTimes(1)
    expect(harness.flush).toHaveBeenCalledTimes(2)
  })

  it('does not claim an active turn when the running Agent last closed that turn', async () => {
    const capability = compileReviewControlCapability(capabilityInput())
    const harness = pauseHarness(goal(), 'running', [turnStart(7), turnEnd(7)])
    const ctx = Object.assign(harness.ctx, {
      sessionMessaging: { sendControl: vi.fn() },
    }) as unknown as Context
    const handlers = createReviewControlHandlers(ctx, {
      resolveCapability: () => capability,
    })

    const decision = await handlers.acceptedPause.handle(incoming(capability, 'acceptedPause'))

    expect(decision).toMatchObject({
      status: 'completed',
      result: {
        type: 'REVIEW_PAUSE_OUTCOME',
        goalOutcome: 'paused',
        activeTurn: false,
        turnOutcome: 'stopped',
      },
    })
    expect((decision as { result?: object }).result).not.toHaveProperty('observedTurn')
    expect(harness.pause).toHaveBeenCalledTimes(1)
    expect(harness.worker.cancel).not.toHaveBeenCalled()
  })

  it('classifies a newer open turn as user override without cancelling it', async () => {
    const capability = compileReviewControlCapability(capabilityInput({ sourceTurn: 7 }))
    const harness = pauseHarness(goal(), 'running', [
      turnStart(7),
      turnEnd(7),
      turnStart(8, 2),
    ])
    const ctx = Object.assign(harness.ctx, {
      sessionMessaging: { sendControl: vi.fn() },
    }) as unknown as Context
    const handlers = createReviewControlHandlers(ctx, {
      resolveCapability: () => capability,
    })

    await expect(handlers.acceptedPause.handle(
      incoming(capability, 'acceptedPause'),
    )).resolves.toMatchObject({
      status: 'completed',
      result: {
        goalOutcome: 'paused',
        activeTurn: true,
        observedTurn: 8,
        turnOutcome: 'user-override',
      },
    })
    expect(harness.pause).toHaveBeenCalledTimes(1)
    expect(harness.worker.cancel).not.toHaveBeenCalled()
    expect(harness.worker.runMaintenance).not.toHaveBeenCalled()
  })

  it('returns no-active-goal without fabricating work or a fallback', async () => {
    const missing = pauseHarness(undefined)
    await expect(pauseExpectedReviewGoal(
      missing.ctx,
      'worker-session',
      { id: 'goal-method-1', revision: 8 },
      7,
    )).resolves.toEqual({
      outcome: 'no-active-goal',
      activeTurn: false,
      turnOutcome: 'stopped',
    })
    expect(missing.pause).not.toHaveBeenCalled()
    expect(missing.flush).not.toHaveBeenCalled()

    const complete = goal({ phase: 'complete', activation: 'disarmed', revision: 10 })
    const finished = pauseHarness(complete)
    await expect(pauseExpectedReviewGoal(
      finished.ctx,
      'worker-session',
      { id: 'goal-method-1', revision: 8 },
      7,
    )).resolves.toEqual({
      outcome: 'no-active-goal',
      ref: { id: 'goal-method-1', revision: 10 },
      activeTurn: false,
      turnOutcome: 'stopped',
    })
  })

  it('returns stale and forbids fallback when another Goal occupies the Session', async () => {
    const unrelated = pauseHarness(goal({ id: GoalId('goal-other'), revision: 4 }), 'running')
    await expect(pauseExpectedReviewGoal(
      unrelated.ctx,
      'worker-session',
      { id: 'goal-method-1', revision: 8 },
      7,
    )).resolves.toEqual({
      outcome: 'stale',
      ref: { id: 'goal-other', revision: 4 },
      activeTurn: false,
      turnOutcome: 'stopped',
    })
    expect(unrelated.pause).not.toHaveBeenCalled()
    expect(unrelated.flush).not.toHaveBeenCalled()
    expect(unrelated.worker.cancel).not.toHaveBeenCalled()
    expect(unrelated.worker.runMaintenance).not.toHaveBeenCalled()
  })

  it('reflushes a prior exact pause without another Goal mutation', async () => {
    const paused = pauseHarness(goal({
      revision: 9,
      phase: 'paused',
      activation: 'disarmed',
    }))
    await expect(pauseExpectedReviewGoal(
      paused.ctx,
      'worker-session',
      { id: 'goal-method-1', revision: 8 },
      7,
    )).resolves.toEqual({
      outcome: 'already-applied',
      ref: { id: 'goal-method-1', revision: 9 },
      activeTurn: false,
      turnOutcome: 'stopped',
    })
    expect(paused.pause).not.toHaveBeenCalled()
    expect(paused.flush).toHaveBeenCalledTimes(1)
  })
})
