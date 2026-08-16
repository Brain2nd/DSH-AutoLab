import { Context } from '@deepseek-ai/cordis'
import type {
  Agent,
  AgentCancelCause,
  AgentStatus,
  RequestErrorAction,
} from '@deepseek-ai/dsh-agent'
import {
  GoalId,
  type GoalRef,
  type GoalView,
} from '@deepseek-ai/dsh-goal'
import type {
  LlmFailure,
  ResolvedRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import {
  SessionId,
  type Session,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'

import {
  classifyApiFailure,
  installApiRecovery,
  type ApiRecoveryAssignment,
  type ApiRecoveryOptions,
  type ApiRecoveryRecord,
  type ApiRecoveryStore,
  type ReviewApiRecoveryWake,
  type ScheduleApiRecoveryOnce,
} from '../src/api-recovery.js'
import { sha256 } from '../src/integrity.js'

const OBJECTIVE = 'Continue the exact AutoLab assignment.'
const PACKET_HASH = 'a'.repeat(64)
const REVIEW_CONTINUATION = Object.freeze({
  kind: 'review' as const,
  reviewId: 'review-method-a-7',
  reviewAnchorHash: 'c'.repeat(64),
})

type ReviewResume = NonNullable<ApiRecoveryOptions['resumeReviewOnce']>
type ReviewOutcome = Awaited<ReturnType<ReviewResume>>

const NORMAL_POLICY: ResolvedRetryPolicy = Object.freeze({
  mode: 'normal',
  maxRetries: 2,
  retryableCodes: Object.freeze(['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  jitterRatio: 0.1,
})

const ALWAYS_POLICY: ResolvedRetryPolicy = Object.freeze({
  mode: 'always',
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  jitterRatio: 0.1,
})

function failure(code: string, overrides: Partial<LlmFailure> = {}): LlmFailure {
  return { message: `${code} fixture`, code, ...overrides }
}

function terminalEvent(
  seq: number,
  turn: number,
  value: LlmFailure,
): SessionEvent<'turn/end'> {
  return {
    type: 'turn/end',
    seq,
    time: 10_000 + seq,
    data: { turn, reason: { kind: 'error', error: value } },
  }
}

function completedEvent(seq: number, turn: number): SessionEvent<'turn/end'> {
  return {
    type: 'turn/end',
    seq,
    time: 10_000 + seq,
    data: { turn, reason: { kind: 'completed' } },
  }
}

class MemoryRecoveryStore implements ApiRecoveryStore {
  readonly records = new Map<string, ApiRecoveryRecord>()
  readonly writes: ApiRecoveryRecord[] = []
  readonly trace: string[]
  private failedPhase: ApiRecoveryRecord['phase'] | undefined
  private putFailures = 0

  constructor(trace: string[] = []) {
    this.trace = trace
  }

  get(sessionId: string): ApiRecoveryRecord | undefined {
    return this.records.get(sessionId)
  }

  list(): readonly ApiRecoveryRecord[] {
    return [...this.records.values()]
  }

  async put(record: ApiRecoveryRecord): Promise<void> {
    if (this.failedPhase === record.phase && this.putFailures > 0) {
      this.putFailures -= 1
      throw new Error(`fixture ${record.phase} store failure`)
    }
    this.trace.push(`put:${record.phase}`)
    this.writes.push(record)
    this.records.set(record.sessionId, record)
  }

  async remove(expected: ApiRecoveryRecord): Promise<boolean> {
    const current = this.records.get(expected.sessionId)
    if (current === undefined || JSON.stringify(current) !== JSON.stringify(expected)) return false
    this.records.delete(expected.sessionId)
    return true
  }

  failNextPut(phase: ApiRecoveryRecord['phase']): void {
    this.failedPhase = phase
    this.putFailures += 1
  }
}

interface ScheduledJob {
  readonly callback: () => void
  readonly delayMs: number
  cancelled: boolean
  fired: boolean
}

class OneShotScheduler {
  readonly jobs: ScheduledJob[] = []
  failures = 0
  readonly scheduleOnce: ScheduleApiRecoveryOnce = (callback, delayMs) => {
    if (this.failures > 0) {
      this.failures -= 1
      throw new Error('fixture timer registration failure')
    }
    const job: ScheduledJob = { callback, delayMs, cancelled: false, fired: false }
    this.jobs.push(job)
    return () => {
      job.cancelled = true
    }
  }

  fire(index = 0): void {
    const job = this.jobs[index]
    if (job === undefined) throw new Error(`No scheduled job ${index}`)
    if (job.cancelled || job.fired) return
    job.fired = true
    job.callback()
  }
}

class FakeAgent {
  readonly cancelCalls: AgentCancelCause[] = []
  readonly maintenance = vi.fn()
  readonly agent: Agent
  readonly events: SessionEvent[] = []
  readonly session: Session
  status: AgentStatus = 'idle'
  claimRace = false
  private maintenanceActive = false
  private idleWaiters: (() => void)[] = []

  constructor(readonly id: string, ctx: Context) {
    this.session = {
      id: SessionId(id),
      events: this.events,
    } as unknown as Session
    const runtime = this
    this.agent = {
      id: SessionId(id),
      options: {},
      session: this.session,
      inbox: {} as Agent['inbox'],
      ctx,
      get status() {
        return runtime.status
      },
      cancel(cause) {
        runtime.cancelCalls.push(cause)
      },
      whenIdle() {
        if (runtime.status === 'idle' && !runtime.maintenanceActive) return Promise.resolve()
        return new Promise<void>(resolve => runtime.idleWaiters.push(resolve))
      },
      runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
        runtime.maintenance()
        if (runtime.claimRace) {
          runtime.claimRace = false
          runtime.status = 'running'
          throw new Error('fixture claim race')
        }
        if (runtime.status !== 'idle' || runtime.maintenanceActive) {
          throw new Error('fixture agent busy')
        }
        runtime.maintenanceActive = true
        const abort = new AbortController()
        return (async () => {
          try {
            return await task(abort.signal)
          } finally {
            runtime.maintenanceActive = false
            runtime.releaseIdleWaiters()
          }
        })()
      },
      send: vi.fn(),
      followup: vi.fn(),
      steer: vi.fn(),
      inject: vi.fn(),
    }
  }

  setStatus(status: AgentStatus): void {
    this.status = status
    if (status === 'idle') this.releaseIdleWaiters()
  }

  private releaseIdleWaiters(): void {
    if (this.status !== 'idle' || this.maintenanceActive) return
    for (const resolve of this.idleWaiters.splice(0)) resolve()
  }
}

interface Harness {
  readonly ctx: Context
  readonly runtime: ReturnType<typeof installApiRecovery>
  readonly store: MemoryRecoveryStore
  readonly scheduler: OneShotScheduler
  readonly clock: { now: number }
  readonly fake: FakeAgent
  readonly flush: ReturnType<typeof vi.fn>
  readonly resumeGoal: ReturnType<typeof vi.fn>
  readonly resumeReview: ReturnType<typeof vi.fn<ReviewResume>>
  readonly trace: string[]
  currentGoal(): GoalView
  setGoal(value: GoalView): void
  assignment(): ApiRecoveryAssignment
  setAssignment(value: ApiRecoveryAssignment | undefined): void
  setNativeDecision(value: RequestErrorAction): void
  request(
    value: LlmFailure,
    policy?: ResolvedRetryPolicy,
    turn?: number,
  ): Promise<RequestErrorAction>
  appendAndEmit(event: SessionEvent): void
  emitIdle(): void
  emitAdaptersUpdated(): void
}

function makeHarness(options: {
  readonly store?: MemoryRecoveryStore
  readonly scheduler?: OneShotScheduler
  readonly clock?: { now: number }
  readonly goal?: GoalView
  readonly continuation?: ApiRecoveryAssignment['continuation']
  readonly reviewOutcome?: ReviewOutcome
  readonly resumeReviewOnce?: ReviewResume
  readonly onOperatorIncident?: (record: ApiRecoveryRecord) => void
  readonly onError?: (error: unknown) => void
} = {}): Harness {
  const ctx = new Context()
  const trace = options.store?.trace ?? []
  const store = options.store ?? new MemoryRecoveryStore(trace)
  const scheduler = options.scheduler ?? new OneShotScheduler()
  const clock = options.clock ?? { now: 1_000 }
  const fake = new FakeAgent('session-method-a', ctx)
  const agents = new Map([[fake.id, fake.agent]])
  let goal: GoalView = options.goal ?? {
    id: GoalId('goal-method-a'),
    revision: 3,
    objective: OBJECTIVE,
    phase: 'active',
    maxGoalRounds: 20,
    roundsStarted: 7,
    createdAt: 1,
    updatedAt: 2,
    activation: 'disarmed',
  }
  let assignment: ApiRecoveryAssignment | undefined = {
    labId: 'lab-1',
    roleId: 'method-a',
    sessionId: fake.id,
    assignmentId: 'assignment-a',
    packetHash: PACKET_HASH,
    continuation: options.continuation ?? {
      kind: 'goal',
      goalRef: { id: goal.id, revision: goal.revision },
      objectiveHash: sha256(goal.objective),
    },
  }
  let nativeDecision: RequestErrorAction
  const flush = vi.fn(async () => undefined)
  const resumeGoal = vi.fn((_agent: Agent, ref: GoalRef) => {
    if (ref.id !== goal.id || ref.revision !== goal.revision) throw new Error('stale fixture GoalRef')
    if (goal.roundsStarted >= goal.maxGoalRounds) throw new Error('fixture round limit')
    goal = { ...goal, revision: goal.revision + 1, activation: 'armed' }
    if (assignment !== undefined) {
      assignment = {
        ...assignment,
        continuation: {
          kind: 'goal',
          goalRef: { id: goal.id, revision: goal.revision },
          objectiveHash: sha256(goal.objective),
        },
      }
    }
    return goal
  })
  const resumeReview = vi.fn<ReviewResume>(options.resumeReviewOnce ?? (
    (_agent: Agent, _wake: ReviewApiRecoveryWake, _signal: AbortSignal) => (
      options.reviewOutcome ?? 'started'
    )
  ))

  ctx.provide('agents', {
    get: (id: ReturnType<typeof SessionId>) => agents.get(String(id)),
  } as unknown as Context['agents'])
  ctx.provide('goals', {
    get: (agent: Agent) => agent === fake.agent ? goal : undefined,
    resume: resumeGoal,
  } as unknown as Context['goals'])
  ctx.provide('sessions', { flush } as unknown as Context['sessions'])

  // Simulates the already-installed native DSH retry owner. AutoLab is added
  // later but prepended, so it must observe this decision through `next()`.
  ctx.on('agent/request-error', async (_payload, next) => {
    trace.push('native-retry')
    return nativeDecision ?? await next()
  })

  const runtime = installApiRecovery(ctx, {
    store,
    resolveAssignment: agent => agent === fake.agent ? assignment : undefined,
    scheduleOnce: scheduler.scheduleOnce,
    now: () => clock.now,
    retryDelayMs: 2_000,
    resumeReviewOnce: resumeReview,
    ...(options.onOperatorIncident === undefined
      ? {}
      : { onOperatorIncident: options.onOperatorIncident }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  })

  return {
    ctx,
    runtime,
    store,
    scheduler,
    clock,
    fake,
    flush,
    resumeGoal,
    resumeReview,
    trace,
    currentGoal: () => goal,
    setGoal: value => {
      goal = value
    },
    assignment: () => {
      if (assignment === undefined) throw new Error('fixture has no assignment')
      return assignment
    },
    setAssignment: value => {
      assignment = value
    },
    setNativeDecision: value => {
      nativeDecision = value
    },
    request: async (value, policy = NORMAL_POLICY, turn = 5) => await ctx.waterfall(
      'agent/request-error',
      {
        agent: fake.agent,
        turn,
        step: 2,
        provider: 'provider-a',
        failure: value,
        retryPolicy: policy,
        signal: new AbortController().signal,
      },
      () => Promise.resolve(undefined),
    ),
    appendAndEmit: event => {
      fake.events.push(event)
      ctx.emit('session/event', fake.session, event)
    },
    emitIdle: () => {
      fake.setStatus('idle')
      ctx.emit('agent/status', { agent: fake.agent, status: 'idle' })
    },
    emitAdaptersUpdated: () => {
      ctx.emit('llm/adapters-updated')
    },
  }
}

async function waitForPhase(
  harness: Harness,
  phase: ApiRecoveryRecord['phase'] | undefined,
): Promise<void> {
  await vi.waitFor(() => {
    expect(harness.store.get(harness.fake.id)?.phase).toBe(phase)
  })
}

describe('AutoLab terminal API recovery', () => {
  it('routes only on the documented/open LlmFailure.code taxonomy', () => {
    for (const code of ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']) {
      expect(classifyApiFailure(failure(code))).toBe('automatic')
    }
    expect(classifyApiFailure(failure('ABORTED', { status: 503 }))).toBe('ignore')
    expect(classifyApiFailure(failure('QUOTA', { status: 429 }))).toBe('operator')
    expect(classifyApiFailure(failure('AUTH', { message: 'transport timeout' }))).toBe('operator')
    expect(classifyApiFailure(failure('CONTEXT_WINDOW_EXCEEDED'))).toBe('operator')
    expect(classifyApiFailure(failure('UNKNOWN', { status: 401 }))).toBe('unknown')
    expect(classifyApiFailure(failure('VENDOR_UNCLASSIFIED'))).toBe('unknown')
  })

  it('awaits native retry and records nothing while DSH still owns the request', async () => {
    const harness = makeHarness()
    harness.setNativeDecision({ kind: 'retry' })

    await expect(harness.request(failure('TRANSPORT'))).resolves.toEqual({ kind: 'retry' })
    expect(harness.trace).toEqual(['native-retry'])
    expect(harness.store.list()).toEqual([])
    expect(harness.scheduler.jobs).toEqual([])
  })

  it('does not interfere with an always-retry provider policy', async () => {
    const harness = makeHarness()
    harness.setNativeDecision({ kind: 'retry' })
    await expect(harness.request(failure('SERVER'), ALWAYS_POLICY)).resolves.toEqual({ kind: 'retry' })
    expect(harness.trace).toEqual(['native-retry'])
    expect(harness.store.list()).toEqual([])
  })

  it.each(['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'])(
    'waits for durable turn/end(error) before scheduling %s',
    async code => {
      const harness = makeHarness()
      const value = failure(code, code === 'RATE_LIMIT'
        ? { status: 429, providerRetryAfterMs: 7_000 }
        : {})

      await harness.request(value)
      expect(harness.trace).toEqual(['native-retry', 'put:awaiting-terminal'])
      expect(harness.scheduler.jobs).toEqual([])

      harness.appendAndEmit(terminalEvent(9, 5, value))
      await waitForPhase(harness, 'scheduled')
      expect(harness.flush).toHaveBeenCalledTimes(1)
      expect(harness.scheduler.jobs).toHaveLength(1)
      expect(harness.scheduler.jobs[0]!.delayMs).toBe(code === 'RATE_LIMIT' ? 7_000 : 2_000)
    },
  )

  it.each([
    failure('AUTH', { status: 401 }),
    failure('MISSING_CREDENTIAL'),
    failure('INVALID_CREDENTIAL'),
    failure('PERMISSION_DENIED', { status: 403 }),
    failure('INVALID_REQUEST', { status: 400 }),
    failure('CONTEXT_WINDOW_EXCEEDED', { status: 400 }),
    failure('QUOTA', { status: 429 }),
  ])('records operator incident for $code without an automatic timer', async value => {
    const incident = vi.fn()
    const harness = makeHarness({ onOperatorIncident: incident })
    await harness.request(value)
    harness.appendAndEmit(terminalEvent(9, 5, value))

    await waitForPhase(harness, 'operator')
    expect(harness.scheduler.jobs).toEqual([])
    expect(harness.resumeGoal).not.toHaveBeenCalled()
    expect(incident).toHaveBeenCalledOnce()
  })

  it('gives one exact cross-turn fallback to the same unknown failure code', async () => {
    const incident = vi.fn()
    const harness = makeHarness({ onOperatorIncident: incident })
    const value = failure('UNKNOWN', { status: 502 })
    await harness.request(value)
    harness.appendAndEmit(terminalEvent(40, 5, value))
    await waitForPhase(harness, 'scheduled')
    const first = harness.store.get(harness.fake.id)
    if (first?.phase !== 'scheduled') throw new Error('expected unknown fallback schedule')
    expect(first.unknownFallbackUsed).toBe(false)
    expect(incident).not.toHaveBeenCalled()

    harness.clock.now = first.dueAt
    harness.scheduler.fire(0)
    await waitForPhase(harness, 'recovering')
    expect(harness.store.get(harness.fake.id)?.unknownFallbackUsed).toBe(true)
    harness.setGoal({ ...harness.currentGoal(), activation: 'disarmed' })

    await harness.request(value, NORMAL_POLICY, 6)
    const secondCandidate = harness.store.get(harness.fake.id)
    expect(secondCandidate).toMatchObject({
      phase: 'awaiting-terminal',
      turn: 6,
      unknownFallbackUsed: true,
    })
    harness.appendAndEmit(terminalEvent(41, 6, value))
    await waitForPhase(harness, 'operator')

    expect(harness.scheduler.jobs).toHaveLength(1)
    expect(harness.resumeGoal).toHaveBeenCalledOnce()
    expect(incident).toHaveBeenCalledOnce()
  })

  it('gives a different unknown code its own single conservative fallback', async () => {
    const incident = vi.fn()
    const harness = makeHarness({ onOperatorIncident: incident })
    const firstFailure = failure('UNKNOWN')
    await harness.request(firstFailure)
    harness.appendAndEmit(terminalEvent(42, 5, firstFailure))
    await waitForPhase(harness, 'scheduled')
    const first = harness.store.get(harness.fake.id)
    if (first?.phase !== 'scheduled') throw new Error('expected first unknown fallback')
    harness.clock.now = first.dueAt
    harness.scheduler.fire(0)
    await waitForPhase(harness, 'recovering')
    harness.setGoal({ ...harness.currentGoal(), activation: 'disarmed' })

    const different = failure('VENDOR_UNCLASSIFIED')
    await harness.request(different, NORMAL_POLICY, 6)
    harness.appendAndEmit(terminalEvent(43, 6, different))
    await waitForPhase(harness, 'scheduled')
    const second = harness.store.get(harness.fake.id)
    if (second?.phase !== 'scheduled') throw new Error('expected second unknown fallback')
    expect(second.unknownFallbackUsed).toBe(false)
    expect(second.failure.code).toBe('VENDOR_UNCLASSIFIED')
    expect(harness.scheduler.jobs).toHaveLength(2)
    expect(incident).not.toHaveBeenCalled()
  })

  it('applies the same one-fallback rule to an exact Judge review', async () => {
    const incident = vi.fn()
    const harness = makeHarness({
      continuation: REVIEW_CONTINUATION,
      onOperatorIncident: incident,
    })
    const value = failure('UNKNOWN')
    await harness.request(value)
    harness.appendAndEmit(terminalEvent(44, 5, value))
    await waitForPhase(harness, 'scheduled')
    const scheduled = harness.store.get(harness.fake.id)
    if (scheduled?.phase !== 'scheduled') throw new Error('expected Judge fallback')
    harness.clock.now = scheduled.dueAt
    harness.scheduler.fire()
    await waitForPhase(harness, 'recovering')
    expect(harness.store.get(harness.fake.id)?.unknownFallbackUsed).toBe(true)

    await harness.request(value, NORMAL_POLICY, 6)
    harness.appendAndEmit(terminalEvent(45, 6, value))
    await waitForPhase(harness, 'operator')
    expect(harness.resumeReview).toHaveBeenCalledOnce()
    expect(harness.scheduler.jobs).toHaveLength(1)
    expect(incident).toHaveBeenCalledOnce()
  })

  it('mechanically resumes an exact Goal incident on an adapter topology commit', async () => {
    const incident = vi.fn()
    const harness = makeHarness({ onOperatorIncident: incident })
    const value = failure('MISSING_CREDENTIAL')
    await harness.request(value)
    harness.appendAndEmit(terminalEvent(21, 5, value))
    await waitForPhase(harness, 'operator')

    harness.emitAdaptersUpdated()
    await waitForPhase(harness, 'recovering')
    expect(harness.resumeGoal).toHaveBeenCalledOnce()
    expect(harness.resumeReview).not.toHaveBeenCalled()
    expect(incident).toHaveBeenCalledOnce()
    expect(harness.scheduler.jobs).toEqual([])
  })

  it('mechanically resumes an exact Judge incident on an adapter topology commit', async () => {
    const incident = vi.fn()
    const harness = makeHarness({
      continuation: REVIEW_CONTINUATION,
      onOperatorIncident: incident,
    })
    const value = failure('INVALID_REQUEST', { status: 400 })
    await harness.request(value)
    harness.appendAndEmit(terminalEvent(22, 5, value))
    await waitForPhase(harness, 'operator')

    harness.emitAdaptersUpdated()
    await waitForPhase(harness, 'recovering')
    expect(harness.resumeReview).toHaveBeenCalledOnce()
    expect(harness.resumeReview.mock.calls[0]?.[1]).toMatchObject({
      wakeId: `${REVIEW_CONTINUATION.reviewId}:api-recovery:22`,
      reviewId: REVIEW_CONTINUATION.reviewId,
      reviewAnchorHash: REVIEW_CONTINUATION.reviewAnchorHash,
      assignmentId: 'assignment-a',
      packetHash: PACKET_HASH,
    })
    expect(harness.resumeGoal).not.toHaveBeenCalled()
    expect(incident).toHaveBeenCalledOnce()
  })

  it.each(['goal', 'assignment', 'packet', 'review-anchor'])(
    'does not resume a stale operator incident after %s identity changes',
    async change => {
      const review = change === 'review-anchor'
      const harness = makeHarness({
        ...(review ? { continuation: REVIEW_CONTINUATION } : {}),
      })
      const value = failure('AUTH', { status: 401 })
      await harness.request(value)
      harness.appendAndEmit(terminalEvent(23, 5, value))
      await waitForPhase(harness, 'operator')

      if (change === 'goal') {
        harness.setGoal({ ...harness.currentGoal(), revision: 4 })
      } else if (change === 'assignment') {
        harness.setAssignment({ ...harness.assignment(), assignmentId: 'assignment-new' })
      } else if (change === 'packet') {
        harness.setAssignment({ ...harness.assignment(), packetHash: 'b'.repeat(64) })
      } else {
        harness.setAssignment({
          ...harness.assignment(),
          continuation: { ...REVIEW_CONTINUATION, reviewAnchorHash: 'd'.repeat(64) },
        })
      }

      harness.emitAdaptersUpdated()
      await waitForPhase(harness, undefined)
      expect(harness.resumeGoal).not.toHaveBeenCalled()
      expect(harness.resumeReview).not.toHaveBeenCalled()
    },
  )

  it('ignores unrelated terminal events and removes an unconfirmed candidate', async () => {
    const harness = makeHarness()
    const value = failure('TRANSPORT')
    await harness.request(value)

    harness.appendAndEmit(terminalEvent(8, 4, value))
    await Promise.resolve()
    expect(harness.store.get(harness.fake.id)?.phase).toBe('awaiting-terminal')

    harness.appendAndEmit(completedEvent(9, 5))
    await waitForPhase(harness, undefined)
    expect(harness.scheduler.jobs).toEqual([])
  })

  it('fires one real Goal CAS resume and never creates, edits, cancels, or probes', async () => {
    const harness = makeHarness()
    const value = failure('TRANSPORT')
    await harness.request(value)
    harness.appendAndEmit(terminalEvent(9, 5, value))
    await waitForPhase(harness, 'scheduled')

    const record = harness.store.get(harness.fake.id)
    if (record?.phase !== 'scheduled') throw new Error('expected scheduled record')
    if (record.continuation.kind !== 'goal') throw new Error('expected Goal continuation')
    harness.clock.now = record.dueAt
    harness.scheduler.fire()
    await waitForPhase(harness, 'recovering')
    harness.appendAndEmit(completedEvent(10, 6))
    await waitForPhase(harness, undefined)

    expect(harness.fake.maintenance).toHaveBeenCalledTimes(1)
    expect(harness.resumeGoal).toHaveBeenCalledTimes(1)
    expect(harness.resumeGoal).toHaveBeenCalledWith(harness.fake.agent, record.continuation.goalRef)
    expect(harness.currentGoal()).toMatchObject({
      id: record.continuation.goalRef.id,
      revision: record.continuation.goalRef.revision + 1,
      activation: 'armed',
      maxGoalRounds: 20,
      roundsStarted: 7,
    })
    expect(harness.fake.cancelCalls).toEqual([])

    harness.scheduler.fire()
    await Promise.resolve()
    expect(harness.resumeGoal).toHaveBeenCalledTimes(1)
  })

  it('does not cancel a busy Agent and resumes only on its real idle edge', async () => {
    const harness = makeHarness()
    const value = failure('TIMEOUT')
    await harness.request(value)
    harness.appendAndEmit(terminalEvent(9, 5, value))
    await waitForPhase(harness, 'scheduled')
    const record = harness.store.get(harness.fake.id)
    if (record?.phase !== 'scheduled') throw new Error('expected scheduled record')

    harness.clock.now = record.dueAt
    harness.fake.setStatus('running')
    harness.scheduler.fire()
    await Promise.resolve()
    expect(harness.resumeGoal).not.toHaveBeenCalled()
    expect(harness.fake.cancelCalls).toEqual([])
    expect(harness.store.get(harness.fake.id)?.phase).toBe('scheduled')

    harness.emitIdle()
    await waitForPhase(harness, 'recovering')
    harness.appendAndEmit(completedEvent(10, 6))
    await waitForPhase(harness, undefined)
    expect(harness.resumeGoal).toHaveBeenCalledTimes(1)
    expect(harness.fake.cancelCalls).toEqual([])
  })

  it('joins one idle claim race without cancelling the winning user turn', async () => {
    const incident = vi.fn()
    const harness = makeHarness({ onOperatorIncident: incident })
    const value = failure('SERVER')
    await harness.request(value)
    harness.appendAndEmit(terminalEvent(9, 5, value))
    await waitForPhase(harness, 'scheduled')
    const record = harness.store.get(harness.fake.id)
    if (record?.phase !== 'scheduled') throw new Error('expected scheduled record')

    harness.clock.now = record.dueAt
    harness.fake.claimRace = true
    harness.scheduler.fire()
    await vi.waitFor(() => expect(harness.fake.status).toBe('running'))
    expect(harness.fake.cancelCalls).toEqual([])
    expect(harness.store.get(harness.fake.id)?.phase).toBe('scheduled')
    expect(incident).not.toHaveBeenCalled()

    harness.emitIdle()
    await waitForPhase(harness, 'recovering')
    harness.appendAndEmit(completedEvent(10, 6))
    await waitForPhase(harness, undefined)
    expect(harness.resumeGoal).toHaveBeenCalledTimes(1)
    expect(harness.fake.cancelCalls).toEqual([])
    expect(incident).not.toHaveBeenCalled()
  })

  it('keeps a scheduled recovery when one-shot timer registration fails', async () => {
    const timerError = vi.fn()
    const incident = vi.fn()
    const scheduler = new OneShotScheduler()
    scheduler.failures = 1
    const harness = makeHarness({
      scheduler,
      onError: timerError,
      onOperatorIncident: incident,
    })
    const value = failure('SERVER')
    await harness.request(value)
    harness.appendAndEmit(terminalEvent(24, 5, value))
    await waitForPhase(harness, 'scheduled')
    await vi.waitFor(() => expect(timerError).toHaveBeenCalledOnce())
    expect(scheduler.jobs).toEqual([])
    expect(incident).not.toHaveBeenCalled()

    harness.emitIdle()
    await vi.waitFor(() => expect(scheduler.jobs).toHaveLength(1))
    const scheduled = harness.store.get(harness.fake.id)
    if (scheduled?.phase !== 'scheduled') throw new Error('expected retained schedule')
    harness.clock.now = scheduled.dueAt
    scheduler.fire()
    await waitForPhase(harness, 'recovering')
    expect(incident).not.toHaveBeenCalled()
  })

  it('recovers an applied Goal after one recovery-store write failure', async () => {
    const storeError = vi.fn()
    const incident = vi.fn()
    const store = new MemoryRecoveryStore()
    const harness = makeHarness({
      store,
      onError: storeError,
      onOperatorIncident: incident,
    })
    const value = failure('TRANSPORT')
    await harness.request(value)
    harness.appendAndEmit(terminalEvent(25, 5, value))
    await waitForPhase(harness, 'scheduled')
    const scheduled = store.get(harness.fake.id)
    if (scheduled?.phase !== 'scheduled') throw new Error('expected scheduled recovery')
    store.failNextPut('recovering')

    harness.clock.now = scheduled.dueAt
    harness.scheduler.fire()
    await vi.waitFor(() => expect(storeError).toHaveBeenCalledOnce())
    expect(store.get(harness.fake.id)?.phase).toBe('scheduled')
    expect(harness.resumeGoal).toHaveBeenCalledOnce()
    expect(incident).not.toHaveBeenCalled()

    harness.emitIdle()
    await waitForPhase(harness, 'recovering')
    expect(harness.resumeGoal).toHaveBeenCalledOnce()
    expect(incident).not.toHaveBeenCalled()
  })

  it('bridges one initial recovery-store failure through the real terminal event', async () => {
    const storeError = vi.fn()
    const incident = vi.fn()
    const store = new MemoryRecoveryStore()
    store.failNextPut('awaiting-terminal')
    const harness = makeHarness({
      store,
      onError: storeError,
      onOperatorIncident: incident,
    })
    const value = failure('TRANSPORT')

    await expect(harness.request(value)).resolves.toBeUndefined()
    expect(store.get(harness.fake.id)).toBeUndefined()
    expect(storeError).toHaveBeenCalledOnce()
    harness.appendAndEmit(terminalEvent(27, 5, value))
    await waitForPhase(harness, 'scheduled')
    expect(harness.scheduler.jobs).toHaveLength(1)
    expect(incident).not.toHaveBeenCalled()

    const scheduled = store.get(harness.fake.id)
    if (scheduled?.phase !== 'scheduled') throw new Error('expected persisted schedule')
    harness.clock.now = scheduled.dueAt
    harness.scheduler.fire()
    await waitForPhase(harness, 'recovering')
  })

  it('retries a failed terminal-to-scheduled store transition on the next idle edge', async () => {
    const storeError = vi.fn()
    const incident = vi.fn()
    const store = new MemoryRecoveryStore()
    const harness = makeHarness({
      store,
      onError: storeError,
      onOperatorIncident: incident,
    })
    const value = failure('SERVER')
    await harness.request(value)
    store.failNextPut('scheduled')
    harness.appendAndEmit(terminalEvent(28, 5, value))
    await vi.waitFor(() => expect(storeError).toHaveBeenCalledOnce())
    expect(store.get(harness.fake.id)?.phase).toBe('awaiting-terminal')
    expect(harness.scheduler.jobs).toEqual([])
    expect(incident).not.toHaveBeenCalled()

    harness.emitIdle()
    await waitForPhase(harness, 'scheduled')
    expect(harness.scheduler.jobs).toHaveLength(1)
    expect(incident).not.toHaveBeenCalled()
  })

  it('keeps a Judge wake pending when its mechanical enqueue throws', async () => {
    const wakeError = vi.fn()
    const incident = vi.fn()
    const harness = makeHarness({
      continuation: REVIEW_CONTINUATION,
      onError: wakeError,
      onOperatorIncident: incident,
    })
    harness.resumeReview.mockRejectedValueOnce(new Error('fixture review queue unavailable'))
    const value = failure('TIMEOUT')
    await harness.request(value)
    harness.appendAndEmit(terminalEvent(26, 5, value))
    await waitForPhase(harness, 'scheduled')
    const scheduled = harness.store.get(harness.fake.id)
    if (scheduled?.phase !== 'scheduled') throw new Error('expected scheduled review')

    harness.clock.now = scheduled.dueAt
    harness.scheduler.fire()
    await vi.waitFor(() => expect(wakeError).toHaveBeenCalledOnce())
    expect(harness.store.get(harness.fake.id)?.phase).toBe('scheduled')
    expect(incident).not.toHaveBeenCalled()

    harness.emitIdle()
    await waitForPhase(harness, 'recovering')
    expect(harness.resumeReview).toHaveBeenCalledTimes(2)
    expect(incident).not.toHaveBeenCalled()
  })

  it('turns a mechanical resume refusal into one operator incident instead of stalling', async () => {
    const incident = vi.fn()
    const harness = makeHarness({ onOperatorIncident: incident })
    harness.setGoal({
      ...harness.currentGoal(),
      roundsStarted: harness.currentGoal().maxGoalRounds,
    })
    const value = failure('TRANSPORT')
    await harness.request(value)
    harness.appendAndEmit(terminalEvent(9, 5, value))
    await waitForPhase(harness, 'scheduled')
    const record = harness.store.get(harness.fake.id)
    if (record?.phase !== 'scheduled') throw new Error('expected scheduled record')

    harness.clock.now = record.dueAt
    harness.scheduler.fire()
    await waitForPhase(harness, 'operator')
    expect(incident).toHaveBeenCalledOnce()
    expect(harness.scheduler.jobs).toHaveLength(1)
    expect(harness.fake.cancelCalls).toEqual([])
  })

  it.each(['goal-revision', 'goal-phase', 'assignment', 'packet'])(
    'drops stale recovery without resuming after %s changes',
    async change => {
      const harness = makeHarness()
      const value = failure('TRANSPORT')
      await harness.request(value)
      harness.appendAndEmit(terminalEvent(9, 5, value))
      await waitForPhase(harness, 'scheduled')
      const record = harness.store.get(harness.fake.id)
      if (record?.phase !== 'scheduled') throw new Error('expected scheduled record')
      if (record.continuation.kind !== 'goal') throw new Error('expected Goal continuation')

      if (change === 'goal-revision') {
        harness.setGoal({
          ...harness.currentGoal(),
          revision: record.continuation.goalRef.revision + 1,
        })
      } else if (change === 'goal-phase') {
        harness.setGoal({ ...harness.currentGoal(), phase: 'paused' })
      } else if (change === 'assignment') {
        harness.setAssignment({ ...harness.assignment(), assignmentId: 'assignment-new' })
      } else {
        harness.setAssignment({ ...harness.assignment(), packetHash: 'b'.repeat(64) })
      }

      harness.clock.now = record.dueAt
      harness.scheduler.fire()
      await waitForPhase(harness, undefined)
      expect(harness.resumeGoal).not.toHaveBeenCalled()
      expect(harness.fake.cancelCalls).toEqual([])
    },
  )

  it('re-arms exactly one remaining deadline after Runtime restart', async () => {
    const store = new MemoryRecoveryStore()
    const clock = { now: 1_000 }
    const firstScheduler = new OneShotScheduler()
    const first = makeHarness({ store, clock, scheduler: firstScheduler })
    const value = failure('TRANSPORT')
    await first.request(value)
    first.appendAndEmit(terminalEvent(9, 5, value))
    await waitForPhase(first, 'scheduled')
    expect(firstScheduler.jobs).toHaveLength(1)
    first.runtime.dispose()
    expect(firstScheduler.jobs[0]!.cancelled).toBe(true)

    const secondScheduler = new OneShotScheduler()
    const second = makeHarness({ store, clock, scheduler: secondScheduler })
    expect(secondScheduler.jobs).toHaveLength(1)
    second.runtime.start()
    expect(secondScheduler.jobs).toHaveLength(1)
  })

  it('leaves an awaiting terminal durable when disposed during its Session checkpoint', async () => {
    const harness = makeHarness()
    const value = failure('TRANSPORT')
    await harness.request(value)
    const checkpoint = Promise.withResolvers<void>()
    harness.flush.mockImplementationOnce(async () => {
      await checkpoint.promise
      return true
    })
    const terminal = terminalEvent(32, 5, value)
    harness.fake.events.push(terminal)
    const transition = harness.runtime.handleSessionEvent(harness.fake.session, terminal)
    await vi.waitFor(() => expect(harness.flush).toHaveBeenCalledOnce())

    harness.runtime.dispose()
    checkpoint.resolve()
    await transition

    expect(harness.store.get(harness.fake.id)?.phase).toBe('awaiting-terminal')
    expect(harness.scheduler.jobs).toEqual([])
  })

  it('leaves a scheduled Judge recovery durable when disposed during its wake', async () => {
    const releaseWake = Promise.withResolvers<ReviewOutcome>()
    const harness = makeHarness({
      continuation: REVIEW_CONTINUATION,
      resumeReviewOnce: async () => await releaseWake.promise,
    })
    const value = failure('TIMEOUT')
    await harness.request(value)
    harness.appendAndEmit(terminalEvent(33, 5, value))
    await waitForPhase(harness, 'scheduled')
    const scheduled = harness.store.get(harness.fake.id)
    if (scheduled?.phase !== 'scheduled') throw new Error('expected scheduled review')
    harness.clock.now = scheduled.dueAt
    harness.scheduler.fire()
    await vi.waitFor(() => expect(harness.resumeReview).toHaveBeenCalledOnce())

    harness.runtime.dispose()
    releaseWake.resolve('started')
    await new Promise<void>(resolve => setImmediate(resolve))

    expect(harness.store.get(harness.fake.id)).toEqual(scheduled)
    expect(harness.flush).toHaveBeenCalledOnce()
  })

  it('retains recovery until a real turn settles and re-arms after a process restart', async () => {
    const store = new MemoryRecoveryStore()
    const clock = { now: 1_000 }
    const first = makeHarness({ store, clock })
    const value = failure('TRANSPORT')
    await first.request(value)
    first.appendAndEmit(terminalEvent(9, 5, value))
    await waitForPhase(first, 'scheduled')
    const scheduled = store.get(first.fake.id)
    if (scheduled?.phase !== 'scheduled') throw new Error('expected scheduled record')
    clock.now = scheduled.dueAt
    first.scheduler.fire()
    await waitForPhase(first, 'recovering')

    const restartedGoal = { ...first.currentGoal(), activation: 'disarmed' as const }
    first.runtime.dispose()
    const second = makeHarness({ store, clock, goal: restartedGoal })
    await vi.waitFor(() => expect(second.resumeGoal).toHaveBeenCalledTimes(1))
    expect(store.get(second.fake.id)?.phase).toBe('recovering')
    expect(second.currentGoal()).toMatchObject({
      id: restartedGoal.id,
      revision: restartedGoal.revision + 1,
      activation: 'armed',
      roundsStarted: restartedGoal.roundsStarted,
      maxGoalRounds: restartedGoal.maxGoalRounds,
    })

    second.appendAndEmit(completedEvent(10, 6))
    await waitForPhase(second, undefined)
  })

  it('leaves recovering durable when disposed during its settlement checkpoint', async () => {
    const harness = makeHarness()
    const value = failure('SERVER')
    await harness.request(value)
    harness.appendAndEmit(terminalEvent(34, 5, value))
    await waitForPhase(harness, 'scheduled')
    const scheduled = harness.store.get(harness.fake.id)
    if (scheduled?.phase !== 'scheduled') throw new Error('expected scheduled recovery')
    harness.clock.now = scheduled.dueAt
    harness.scheduler.fire()
    await waitForPhase(harness, 'recovering')
    const recovering = harness.store.get(harness.fake.id)
    if (recovering?.phase !== 'recovering') throw new Error('expected recovering record')

    const checkpoint = Promise.withResolvers<void>()
    harness.flush.mockImplementationOnce(async () => {
      await checkpoint.promise
      return true
    })
    const terminal = completedEvent(35, 6)
    harness.fake.events.push(terminal)
    const settlement = harness.runtime.handleSessionEvent(harness.fake.session, terminal)
    await vi.waitFor(() => expect(harness.flush).toHaveBeenCalledTimes(3))

    harness.runtime.dispose()
    checkpoint.resolve()
    await settlement

    expect(harness.store.get(harness.fake.id)).toEqual(recovering)
  })

  it('starts the next one-shot recovery after a later transient terminal error', async () => {
    const incident = vi.fn()
    const harness = makeHarness({ onOperatorIncident: incident })
    const firstFailure = failure('TRANSPORT')
    await harness.request(firstFailure)
    harness.appendAndEmit(terminalEvent(30, 5, firstFailure))
    await waitForPhase(harness, 'scheduled')
    const first = harness.store.get(harness.fake.id)
    if (first?.phase !== 'scheduled') throw new Error('expected first scheduled recovery')
    harness.clock.now = first.dueAt
    harness.scheduler.fire(0)
    await waitForPhase(harness, 'recovering')

    // Goal driving consumes the armed edge before the next terminal settles.
    harness.setGoal({ ...harness.currentGoal(), activation: 'disarmed' })
    const secondFailure = failure('TIMEOUT')
    harness.appendAndEmit(terminalEvent(31, 6, secondFailure))
    await waitForPhase(harness, 'scheduled')
    const second = harness.store.get(harness.fake.id)
    if (second?.phase !== 'scheduled') throw new Error('expected second scheduled recovery')
    expect(second.turn).toBe(6)
    expect(second.failure.code).toBe('TIMEOUT')
    expect(incident).not.toHaveBeenCalled()

    harness.clock.now = second.dueAt
    harness.scheduler.fire(1)
    await waitForPhase(harness, 'recovering')
    expect(harness.resumeGoal).toHaveBeenCalledTimes(2)
    expect(incident).not.toHaveBeenCalled()
  })

  it('wakes one exact Judge review and keeps recovery open until a later real turn', async () => {
    const harness = makeHarness({ continuation: REVIEW_CONTINUATION })
    const value = failure('TRANSPORT')
    await harness.request(value)
    harness.appendAndEmit(terminalEvent(9, 5, value))
    await waitForPhase(harness, 'scheduled')

    const scheduled = harness.store.get(harness.fake.id)
    if (scheduled?.phase !== 'scheduled') throw new Error('expected scheduled review')
    harness.clock.now = scheduled.dueAt
    harness.scheduler.fire()
    await waitForPhase(harness, 'recovering')

    expect(harness.resumeReview).toHaveBeenCalledTimes(1)
    const [agent, wake, signal] = harness.resumeReview.mock.calls[0]!
    expect(agent).toBe(harness.fake.agent)
    expect(signal.aborted).toBe(false)
    expect(wake).toEqual({
      wakeId: `${REVIEW_CONTINUATION.reviewId}:api-recovery:9`,
      reviewId: REVIEW_CONTINUATION.reviewId,
      reviewAnchorHash: REVIEW_CONTINUATION.reviewAnchorHash,
      labId: 'lab-1',
      roleId: 'method-a',
      sessionId: harness.fake.id,
      assignmentId: 'assignment-a',
      packetHash: PACKET_HASH,
      terminalSeq: 9,
    })
    expect(harness.resumeGoal).not.toHaveBeenCalled()

    harness.scheduler.fire()
    await Promise.resolve()
    expect(harness.resumeReview).toHaveBeenCalledTimes(1)
    expect(harness.store.get(harness.fake.id)?.phase).toBe('recovering')

    harness.appendAndEmit(completedEvent(10, 6))
    await waitForPhase(harness, undefined)
  })

  it('treats an already-started Judge wake as a live recovering continuation', async () => {
    const harness = makeHarness({
      continuation: REVIEW_CONTINUATION,
      reviewOutcome: 'already-started',
    })
    const value = failure('TIMEOUT')
    await harness.request(value)
    harness.appendAndEmit(terminalEvent(12, 5, value))
    await waitForPhase(harness, 'scheduled')
    const scheduled = harness.store.get(harness.fake.id)
    if (scheduled?.phase !== 'scheduled') throw new Error('expected scheduled review')

    harness.clock.now = scheduled.dueAt
    harness.scheduler.fire()
    await waitForPhase(harness, 'recovering')
    expect(harness.resumeReview).toHaveBeenCalledOnce()
    expect(harness.store.get(harness.fake.id)).toMatchObject({
      phase: 'recovering',
      terminalSeq: 12,
      resumedContinuation: REVIEW_CONTINUATION,
    })
  })

  it('replays the same idempotent Judge wake after restart', async () => {
    const store = new MemoryRecoveryStore()
    const clock = { now: 1_000 }
    const first = makeHarness({ store, clock, continuation: REVIEW_CONTINUATION })
    const value = failure('SERVER')
    await first.request(value)
    first.appendAndEmit(terminalEvent(14, 5, value))
    await waitForPhase(first, 'scheduled')
    const scheduled = store.get(first.fake.id)
    if (scheduled?.phase !== 'scheduled') throw new Error('expected scheduled review')

    clock.now = scheduled.dueAt
    first.scheduler.fire()
    await waitForPhase(first, 'recovering')
    const firstWake = first.resumeReview.mock.calls[0]?.[1]
    if (firstWake === undefined) throw new Error('expected first Judge wake')
    first.runtime.dispose()

    const second = makeHarness({
      store,
      clock,
      continuation: REVIEW_CONTINUATION,
      reviewOutcome: 'already-started',
    })
    await vi.waitFor(() => expect(second.resumeReview).toHaveBeenCalledOnce())
    const secondWake = second.resumeReview.mock.calls[0]?.[1]
    expect(secondWake).toEqual(firstWake)
    expect(secondWake?.wakeId).toBe(`${REVIEW_CONTINUATION.reviewId}:api-recovery:14`)
    expect(store.get(second.fake.id)?.phase).toBe('recovering')

    second.appendAndEmit(completedEvent(15, 6))
    await waitForPhase(second, undefined)
  })

  it('deletes a stale Judge recovery instead of waking it again', async () => {
    const harness = makeHarness({
      continuation: REVIEW_CONTINUATION,
      reviewOutcome: 'stale',
    })
    const value = failure('RATE_LIMIT')
    await harness.request(value)
    harness.appendAndEmit(terminalEvent(16, 5, value))
    await waitForPhase(harness, 'scheduled')
    const scheduled = harness.store.get(harness.fake.id)
    if (scheduled?.phase !== 'scheduled') throw new Error('expected scheduled review')

    harness.clock.now = scheduled.dueAt
    harness.scheduler.fire()
    await waitForPhase(harness, undefined)
    expect(harness.resumeReview).toHaveBeenCalledOnce()
    expect(harness.resumeGoal).not.toHaveBeenCalled()
  })

  it.each(['review-anchor', 'assignment', 'packet'])(
    'drops stale Judge recovery after %s changes',
    async change => {
      const harness = makeHarness({ continuation: REVIEW_CONTINUATION })
      const value = failure('TRANSPORT')
      await harness.request(value)
      harness.appendAndEmit(terminalEvent(18, 5, value))
      await waitForPhase(harness, 'scheduled')
      const scheduled = harness.store.get(harness.fake.id)
      if (scheduled?.phase !== 'scheduled') throw new Error('expected scheduled review')

      if (change === 'review-anchor') {
        harness.setAssignment({
          ...harness.assignment(),
          continuation: {
            ...REVIEW_CONTINUATION,
            reviewAnchorHash: 'd'.repeat(64),
          },
        })
      } else if (change === 'assignment') {
        harness.setAssignment({ ...harness.assignment(), assignmentId: 'assignment-new' })
      } else {
        harness.setAssignment({ ...harness.assignment(), packetHash: 'b'.repeat(64) })
      }

      harness.clock.now = scheduled.dueAt
      harness.scheduler.fire()
      await waitForPhase(harness, undefined)
      expect(harness.resumeReview).not.toHaveBeenCalled()
      expect(harness.resumeGoal).not.toHaveBeenCalled()
    },
  )

  it('never wakes a Judge review for an operator-class API failure', async () => {
    const incident = vi.fn()
    const harness = makeHarness({
      continuation: REVIEW_CONTINUATION,
      onOperatorIncident: incident,
    })
    const value = failure('AUTH', { status: 401 })
    await harness.request(value)
    harness.appendAndEmit(terminalEvent(20, 5, value))

    await waitForPhase(harness, 'operator')
    expect(harness.scheduler.jobs).toEqual([])
    expect(harness.resumeReview).not.toHaveBeenCalled()
    expect(incident).toHaveBeenCalledOnce()
  })
})
