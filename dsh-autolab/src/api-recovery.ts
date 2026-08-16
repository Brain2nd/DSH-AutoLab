import type { Context } from '@deepseek-ai/cordis'
import type {
  Agent,
  RequestErrorAction,
} from '@deepseek-ai/dsh-agent'
import type { GoalRef, GoalView } from '@deepseek-ai/dsh-goal'
import type {
  LlmFailure,
  ResolvedRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import {
  SessionId,
  type Session,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'

import { sha256 } from './integrity.js'
import { flushSessionDurably } from './session-durability.js'

const AUTOMATIC_FAILURE_CODES = new Set([
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
])

/** Codes whose meaning itself proves that an unchanged request has no safe fix. */
const OPERATOR_FAILURE_CODES = new Set([
  'AUTH',
  'FORBIDDEN',
  'INVALID_ARGS',
  'INVALID_CREDENTIAL',
  'INVALID_MODEL_CONTEXT',
  'INVALID_MODEL_INFO',
  'INVALID_MODEL_MAX_TOKENS',
  'INVALID_MODEL_REASONING',
  'INVALID_PREPARED_CALL',
  'INVALID_REQUEST',
  'MISSING_CREDENTIAL',
  'NO_ADAPTER',
  'PERMISSION',
  'PERMISSION_DENIED',
  'QUOTA',
  'CONTEXT_WINDOW_EXCEEDED',
  'UNAUTHORIZED',
  'UNSUPPORTED_REASONING_EFFORT',
])

export type ApiFailureDisposition = 'automatic' | 'operator' | 'unknown' | 'ignore'

/** Route only on the provider-neutral code. HTTP status and message are diagnostic facts. */
export function classifyApiFailure(failure: LlmFailure): ApiFailureDisposition {
  if (failure.code === 'ABORTED') return 'ignore'
  if (AUTOMATIC_FAILURE_CODES.has(failure.code)) return 'automatic'
  return OPERATOR_FAILURE_CODES.has(failure.code) ? 'operator' : 'unknown'
}

export interface GoalApiRecoveryContinuation {
  readonly kind: 'goal'
  readonly goalRef: GoalRef
  readonly objectiveHash: string
}

export interface ReviewApiRecoveryContinuation {
  readonly kind: 'review'
  readonly reviewId: string
  readonly reviewAnchorHash: string
}

export type ApiRecoveryContinuation =
  | GoalApiRecoveryContinuation
  | ReviewApiRecoveryContinuation

/** Current AutoLab identity resolved from one exact live Agent. */
export interface ApiRecoveryAssignment {
  readonly labId: string
  readonly roleId: string
  readonly sessionId: string
  readonly assignmentId: string
  readonly packetHash: string
  readonly continuation: ApiRecoveryContinuation
}

interface ApiRecoveryBase extends ApiRecoveryAssignment {
  readonly turn: number
  readonly step: number
  readonly provider: string
  readonly failure: LlmFailure
  readonly recordedAt: number
  /** Exactly one conservative continuation is allowed for one unknown code. */
  readonly unknownFallbackUsed: boolean
}

/** Written before AgentLoop is allowed to close the failed turn. */
export interface AwaitingApiTerminalRecord extends ApiRecoveryBase {
  readonly phase: 'awaiting-terminal'
}

/** One durable retry deadline; no interval or provider health probe exists. */
export interface ScheduledApiRecoveryRecord extends ApiRecoveryBase {
  readonly phase: 'scheduled'
  readonly terminalSeq: number
  readonly dueAt: number
}

/** Goal continuation was rearmed; retained until a later real turn settles. */
export interface RecoveringApiRecord extends ApiRecoveryBase {
  readonly phase: 'recovering'
  readonly terminalSeq: number
  readonly resumedContinuation: ApiRecoveryContinuation
  readonly resumedAt: number
}

/** A real terminal failure that needs configuration, credentials, quota, or user action. */
export interface OperatorApiIncidentRecord extends ApiRecoveryBase {
  readonly phase: 'operator'
  readonly terminalSeq: number
}

export type ApiRecoveryRecord =
  | AwaitingApiTerminalRecord
  | ScheduledApiRecoveryRecord
  | RecoveringApiRecord
  | OperatorApiIncidentRecord

/**
 * One active record per Session. `remove()` must compare the complete expected
 * record before deleting, so an old timer can never erase a newer failure.
 */
export interface ApiRecoveryStore {
  get(sessionId: string): ApiRecoveryRecord | undefined
  list(): readonly ApiRecoveryRecord[]
  put(record: ApiRecoveryRecord): Promise<void>
  remove(expected: ApiRecoveryRecord): Promise<boolean>
}

/** Register exactly one callback and return its cancellation function. */
export type ScheduleApiRecoveryOnce = (
  callback: () => void,
  delayMs: number,
) => () => void

export interface ApiRecoveryRequestError {
  readonly agent: Agent
  readonly turn: number
  readonly step: number
  readonly provider: string
  readonly failure: LlmFailure
  readonly retryPolicy: ResolvedRetryPolicy | undefined
  readonly signal: AbortSignal
}

export interface ApiRecoveryOptions {
  readonly store: ApiRecoveryStore
  readonly resolveAssignment: (agent: Agent) => ApiRecoveryAssignment | undefined
  readonly scheduleOnce: ScheduleApiRecoveryOnce
  readonly now: () => number
  /** Used only when the provider did not return a valid Retry-After delay. */
  readonly retryDelayMs: number
  /** Idempotently enqueue one retry wake for an exact active review. */
  readonly resumeReviewOnce?: (
    agent: Agent,
    wake: ReviewApiRecoveryWake,
    signal: AbortSignal,
  ) => 'started' | 'already-started' | 'stale'
    | Promise<'started' | 'already-started' | 'stale'>
  /** The only recovery state that should wake Controller/Ops for a decision. */
  readonly onOperatorIncident?: (
    record: OperatorApiIncidentRecord,
  ) => void | Promise<void>
  readonly onError?: (error: unknown) => void
}

export interface ReviewApiRecoveryWake {
  readonly wakeId: string
  readonly reviewId: string
  readonly reviewAnchorHash: string
  readonly labId: string
  readonly roleId: string
  readonly sessionId: string
  readonly assignmentId: string
  readonly packetHash: string
  readonly terminalSeq: number
}

interface ArmedTimer {
  readonly record: ScheduledApiRecoveryRecord
  readonly cancel: () => void
}

/**
 * Event-driven recovery for failures left terminal by DSH's native request
 * retry plugin. It never polls, probes a provider, cancels a user turn, creates
 * a Goal, or changes a Goal round budget.
 */
export class ApiRecoveryRuntime {
  private readonly timers = new Map<string, ArmedTimer>()
  private readonly inFlight = new Set<string>()
  /** Narrow in-process bridge when the first durable candidate write is unavailable. */
  private readonly pendingAwaiting = new Map<string, AwaitingApiTerminalRecord>()
  private readonly disposers: (() => boolean)[] = []
  private started = false

  constructor(
    private readonly ctx: Context,
    private readonly options: ApiRecoveryOptions,
  ) {
    if (!Number.isFinite(options.retryDelayMs) || options.retryDelayMs < 0) {
      throw new TypeError('retryDelayMs must be a finite non-negative number')
    }
  }

  start(): this {
    if (this.started) return this
    this.started = true

    // Prepend makes AutoLab the outer middleware. `await next()` therefore
    // observes the native retry owner's decision before recording a terminal.
    this.disposers.push(this.ctx.on(
      'agent/request-error',
      async (payload, next) => await this.handleRequestError(payload, next),
      { prepend: true },
    ))
    this.disposers.push(this.ctx.on('session/event', (session, event) => {
      void this.handleSessionEvent(session, event).catch(error => this.report(error))
    }))
    this.disposers.push(this.ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle') return
      void this.handleAgentReady(agent).catch(error => this.report(error))
    }))
    this.disposers.push(this.ctx.on('agent/created', ({ agent }) => {
      void this.handleAgentCreated(agent).catch(error => this.report(error))
    }))
    this.disposers.push(this.ctx.on('agent/session-start', ({ agent }) => {
      void this.handleAgentReady(agent).catch(error => this.report(error))
    }))
    this.disposers.push(this.ctx.on('llm/adapters-updated', () => {
      void this.handleAdaptersUpdated().catch(error => this.report(error))
    }))

    this.reconcile()
    return this
  }

  dispose(): void {
    if (!this.started) return
    this.started = false
    for (const dispose of this.disposers.splice(0)) dispose()
    for (const timer of this.timers.values()) this.cancelTimer(timer.cancel)
    this.timers.clear()
  }

  /**
   * Delegate first. A downstream `{ kind: 'retry' }` means DSH still owns the
   * request; only its final `undefined` can become an AutoLab terminal.
   */
  async handleRequestError(
    payload: ApiRecoveryRequestError,
    next: () => Promise<RequestErrorAction>,
  ): Promise<RequestErrorAction> {
    const action = await next()
    if (!this.started || action?.kind === 'retry') return action
    if (classifyApiFailure(payload.failure) === 'ignore') return action

    const assignment = this.options.resolveAssignment(payload.agent)
    if (assignment === undefined || assignment.sessionId !== String(payload.agent.id)) {
      return action
    }

    const prior = this.currentRecord(String(payload.agent.id))
    const record: AwaitingApiTerminalRecord = Object.freeze({
      phase: 'awaiting-terminal',
      ...snapshotAssignment(assignment),
      turn: payload.turn,
      step: payload.step,
      provider: payload.provider,
      failure: snapshotFailure(payload.failure),
      recordedAt: this.options.now(),
      unknownFallbackUsed: this.carryUnknownFallback(
        payload.agent,
        assignment,
        prior,
        payload.failure,
      ),
    })
    this.clearTimer(record.sessionId)
    this.pendingAwaiting.set(record.sessionId, record)
    try {
      await this.options.store.put(record)
      if (this.pendingAwaiting.get(record.sessionId) === record) {
        this.pendingAwaiting.delete(record.sessionId)
      }
    } catch (error) {
      // Do not let recovery storage turn the provider's terminal outcome into a
      // plugin failure. The exact candidate remains available until the real
      // turn/end (or a later local lifecycle edge) retries persistence.
      this.report(error)
    }
    return action
  }

  async handleSessionEvent(session: Session, event: SessionEvent): Promise<void> {
    if (!this.started) return
    if (event.type !== 'turn/end') return
    const current = this.currentRecord(String(session.id))
    if (current?.phase === 'recovering' && event.data.turn > current.turn) {
      await this.settleRecovering(session, event, current)
      return
    }
    if (current?.phase !== 'awaiting-terminal' || current.turn !== event.data.turn) return

    // `session/event` is post-commit fire-and-forget. This explicit checkpoint
    // makes the terminal durable before its retry deadline is published.
    await flushSessionDurably(this.ctx, session, 'API terminal checkpoint')
    if (!this.started) return
    if (!sameRecord(this.currentRecord(current.sessionId), current)) return

    const reason = event.data.reason
    if (reason.kind !== 'error' || !sameFailure(reason.error, current.failure)) {
      await this.removeCurrent(current)
      return
    }

    const disposition = classifyApiFailure(current.failure)
    if (disposition === 'automatic'
      || (disposition === 'unknown' && !current.unknownFallbackUsed)) {
      const record: ScheduledApiRecoveryRecord = Object.freeze({
        ...current,
        phase: 'scheduled',
        terminalSeq: event.seq,
        dueAt: this.options.now() + retryDelay(current.failure, this.options.retryDelayMs),
        unknownFallbackUsed: false,
      })
      await this.options.store.put(record)
      this.clearPendingAwaiting(current)
      this.arm(record)
      return
    }

    const record: OperatorApiIncidentRecord = Object.freeze({
      ...current,
      phase: 'operator',
      terminalSeq: event.seq,
    })
    await this.options.store.put(record)
    this.clearPendingAwaiting(current)
    this.publishOperator(record)
  }

  private reconcile(): void {
    for (const record of this.pendingAwaiting.values()) {
      const agent = this.ctx.agents.get(SessionId(record.sessionId))
      if (agent !== undefined) {
        void this.reconcileAwaiting(agent, record).catch(error => this.report(error))
      }
    }
    for (const record of this.options.store.list()) {
      if (this.pendingAwaiting.has(record.sessionId)) continue
      if (!sameRecord(this.options.store.get(record.sessionId), record)) continue
      if (record.phase === 'scheduled') {
        this.arm(record)
        continue
      }
      if (record.phase === 'recovering') {
        const agent = this.ctx.agents.get(SessionId(record.sessionId))
        if (agent !== undefined) {
          void this.handleAgentReady(agent).catch(error => this.report(error))
        }
        continue
      }
      if (record.phase === 'awaiting-terminal') {
        const agent = this.ctx.agents.get(SessionId(record.sessionId))
        if (agent !== undefined) {
          void this.reconcileAwaiting(agent, record).catch(error => this.report(error))
        }
      }
    }
  }

  private async handleAgentCreated(agent: Agent): Promise<void> {
    const pending = this.pendingAwaiting.get(String(agent.id))
    if (pending !== undefined) {
      await this.reconcileAwaiting(agent, pending)
      return
    }
    const record = this.options.store.get(String(agent.id))
    if (record?.phase === 'awaiting-terminal') {
      await this.reconcileAwaiting(agent, record)
      return
    }
    if (record?.phase === 'scheduled') this.arm(record)
    if (record?.phase === 'recovering') await this.handleAgentReady(agent)
  }

  /**
   * Adapter topology commits are the exact mechanical edge that can make a
   * credential, route, or provider configuration incident runnable again.
   * Each edge tries the still-current incident once; no endpoint probe or
   * background poll is introduced.
   */
  private async handleAdaptersUpdated(): Promise<void> {
    if (!this.started) return
    await Promise.all([...this.pendingAwaiting.values()].map(async record => {
      const agent = this.ctx.agents.get(SessionId(record.sessionId))
      if (agent !== undefined) await this.reconcileAwaiting(agent, record)
    }))
    const pending = this.options.store.list().filter(record => (
      record.phase === 'operator'
      || record.phase === 'awaiting-terminal'
      || record.phase === 'scheduled'
      || record.phase === 'recovering'
    ))
    await Promise.all(pending.map(async record => {
      if (this.pendingAwaiting.has(record.sessionId)) return
      if (!sameRecord(this.options.store.get(record.sessionId), record)) return
      const agent = this.ctx.agents.get(SessionId(record.sessionId))
      if (agent === undefined) return
      const resume = async (): Promise<void> => {
        if (record.phase === 'operator') {
          await this.resumeOperatorOnAdapterUpdate(record, agent)
          return
        }
        await this.handleAgentReady(agent)
      }
      if (agent.status !== 'idle') {
        void agent.whenIdle()
          .then(resume)
          .catch(error => this.report(error))
        return
      }
      await resume()
    }))
  }

  private async resumeOperatorOnAdapterUpdate(
    record: OperatorApiIncidentRecord,
    agent: Agent,
  ): Promise<void> {
    if (!this.started
      || !sameRecord(this.options.store.get(record.sessionId), record)
      || this.ctx.agents.get(SessionId(record.sessionId)) !== agent) return
    if (agent.status !== 'idle') return

    if (!this.assignmentAndContinuationMatch(agent, record, record.continuation)) {
      await this.removeCurrent(record)
      return
    }
    if (!this.mechanicalContinuationAvailable(agent, record.continuation)) return

    const scheduled: ScheduledApiRecoveryRecord = Object.freeze({
      ...baseRecord(record),
      phase: 'scheduled',
      terminalSeq: record.terminalSeq,
      dueAt: this.options.now(),
    })
    await this.options.store.put(scheduled)
    if (!sameRecord(this.options.store.get(record.sessionId), scheduled)) return
    await this.resumeScheduled(scheduled, agent)
  }

  private async reconcileAwaiting(
    agent: Agent,
    record: AwaitingApiTerminalRecord,
  ): Promise<void> {
    const terminal = agent.session.events.findLast(event => (
      event.type === 'turn/end' && event.data.turn === record.turn
    ))
    if (terminal !== undefined) await this.handleSessionEvent(agent.session, terminal)
  }

  private async handleAgentReady(agent: Agent): Promise<void> {
    if (!this.started) return
    const pending = this.pendingAwaiting.get(String(agent.id))
    if (pending !== undefined) {
      await this.reconcileAwaiting(agent, pending)
      return
    }
    const record = this.options.store.get(String(agent.id))
    if (record?.phase === 'awaiting-terminal') {
      await this.reconcileAwaiting(agent, record)
      return
    }
    if (record?.phase === 'recovering') {
      const terminal = agent.session.events.findLast(event => (
        event.type === 'turn/end' && event.data.turn > record.turn
      ))
      if (terminal !== undefined) {
        await this.handleSessionEvent(agent.session, terminal)
        return
      }
      await this.resumeRecovering(record, agent)
      return
    }
    if (record?.phase !== 'scheduled') return
    if (this.options.now() < record.dueAt) {
      this.arm(record)
      return
    }
    await this.resumeScheduled(record, agent)
  }

  private arm(record: ScheduledApiRecoveryRecord): void {
    if (!this.started) return
    if (!sameRecord(this.options.store.get(record.sessionId), record)) return
    const existing = this.timers.get(record.sessionId)
    if (existing !== undefined && sameRecord(existing.record, record)) return
    if (existing !== undefined) {
      this.timers.delete(record.sessionId)
      this.cancelTimer(existing.cancel)
    }

    try {
      const cancel = this.options.scheduleOnce(() => {
        const armed = this.timers.get(record.sessionId)
        if (armed !== undefined && sameRecord(armed.record, record)) {
          this.timers.delete(record.sessionId)
        }
        void this.resumeScheduled(record).catch(error => this.report(error))
      }, Math.max(0, record.dueAt - this.options.now()))
      this.timers.set(record.sessionId, { record, cancel })
    } catch (error) {
      // The durable scheduled record remains authoritative. A later idle,
      // session-start, adapter update, or Runtime restart can arm it again.
      this.report(error)
    }
  }

  private async resumeScheduled(
    record: ScheduledApiRecoveryRecord,
    knownAgent?: Agent,
  ): Promise<void> {
    if (!this.started) return
    if (!sameRecord(this.options.store.get(record.sessionId), record)) return
    if (this.options.now() < record.dueAt) {
      this.arm(record)
      return
    }
    if (this.inFlight.has(record.sessionId)) return

    const agent = knownAgent ?? this.ctx.agents.get(SessionId(record.sessionId))
    if (agent === undefined || this.ctx.agents.get(SessionId(record.sessionId)) !== agent) return
    if (agent.status !== 'idle') return

    const applied = this.appliedGoalContinuation(agent, record)
    if (applied !== undefined) {
      await this.resumeExact(record, agent, record.continuation, applied)
      return
    }
    if (!this.assignmentAndContinuationMatch(agent, record, record.continuation)) {
      await this.removeCurrent(record)
      return
    }

    await this.resumeExact(record, agent, record.continuation)
  }

  private async resumeRecovering(record: RecoveringApiRecord, agent: Agent): Promise<void> {
    if (!this.started
      || !sameRecord(this.options.store.get(record.sessionId), record)
      || this.ctx.agents.get(SessionId(record.sessionId)) !== agent
      || agent.status !== 'idle'
      || this.inFlight.has(record.sessionId)) {
      return
    }

    if (record.resumedContinuation.kind === 'review') {
      if (!this.assignmentAndContinuationMatch(
        agent,
        record,
        record.resumedContinuation,
      )) {
        await this.removeCurrent(record)
        return
      }
      await this.resumeExact(record, agent, record.resumedContinuation)
      return
    }

    const resumed = record.resumedContinuation
    const goal = this.ctx.goals.get(agent)
    if (goal?.id === resumed.goalRef.id
      && goal.revision === resumed.goalRef.revision
      && goal.phase === 'active'
      && sha256(goal.objective) === resumed.objectiveHash) {
      if (goal.activation === 'armed') return
      if (!this.assignmentAndContinuationMatch(agent, record, resumed)) {
        await this.removeCurrent(record)
        return
      }
      await this.resumeExact(record, agent, resumed)
      return
    }

    // Store commit may beat the Goal session checkpoint. If the old exact Goal
    // is what survived reload, repeat the same CAS from that durable point.
    const original = record.continuation
    if (original.kind === 'goal'
      && goal?.id === original.goalRef.id
      && goal.revision === original.goalRef.revision
      && goal.phase === 'active'
      && goal.activation === 'disarmed'
      && sha256(goal.objective) === original.objectiveHash
      && this.assignmentAndContinuationMatch(agent, record, original)) {
      await this.resumeExact(record, agent, original)
      return
    }

    await this.removeCurrent(record)
  }

  private async resumeExact(
    record: ScheduledApiRecoveryRecord | RecoveringApiRecord,
    agent: Agent,
    expectedContinuation: ApiRecoveryContinuation,
    appliedGoal?: GoalApiRecoveryContinuation,
  ): Promise<void> {
    if (!this.started) return
    if (this.inFlight.has(record.sessionId)) return
    if (appliedGoal === undefined
      && !this.mechanicalContinuationAvailable(agent, expectedContinuation)) {
      await this.promoteOperator(record)
      return
    }

    this.inFlight.add(record.sessionId)
    let entered = false
    try {
      const outcome = await agent.runMaintenance(async signal => {
        entered = true
        signal.throwIfAborted()
        if (!this.started) return 'stopped' as const
        if (!sameRecord(this.options.store.get(record.sessionId), record)
          || this.ctx.agents.get(SessionId(record.sessionId)) !== agent
          || !(appliedGoal === undefined
            ? this.assignmentAndContinuationMatch(agent, record, expectedContinuation)
            : this.assignmentAndAppliedGoalMatch(agent, record, appliedGoal))) {
          return 'stale' as const
        }

        const resumed = appliedGoal ?? await this.applyContinuation(
          agent, record, expectedContinuation, signal,
        )
        if (!this.started) return 'stopped' as const
        if (resumed === undefined) return 'stale' as const
        const recovering: RecoveringApiRecord = Object.freeze({
          ...baseRecord(record),
          phase: 'recovering',
          terminalSeq: record.terminalSeq,
          resumedContinuation: resumed,
          resumedAt: this.options.now(),
          unknownFallbackUsed: record.unknownFallbackUsed
            || classifyApiFailure(record.failure) === 'unknown',
        })
        await this.options.store.put(recovering)
        if (!this.started) return 'stopped' as const
        await flushSessionDurably(this.ctx, agent.session, 'API recovery continuation')
        return 'resumed' as const
      })

      if (!this.started) return
      if (outcome === 'stale') {
        await this.removeCurrent(record)
      }
    } catch (error) {
      if (!this.started) return
      if (entered) {
        this.report(error)
        // Adapter wake, Goal persistence, recovery-store persistence, and
        // session flush failures are mechanical. Keep the exact pending record;
        // a later real lifecycle edge can retry it without involving an LLM.
        return
      }

      // An idle→work claim race is not an error and never authorizes
      // cancellation. Join the one real activity once, then retry on quiescence.
      void agent.whenIdle()
        .then(() => this.handleAgentReady(agent))
        .catch(waitError => this.report(waitError))
    } finally {
      this.inFlight.delete(record.sessionId)
    }
  }

  private async applyContinuation(
    agent: Agent,
    record: ScheduledApiRecoveryRecord | RecoveringApiRecord,
    continuation: ApiRecoveryContinuation,
    signal: AbortSignal,
  ): Promise<ApiRecoveryContinuation | undefined> {
    if (continuation.kind === 'goal') {
      const resumed = this.ctx.goals.resume(agent, continuation.goalRef)
      return Object.freeze({
        kind: 'goal',
        goalRef: Object.freeze({ id: resumed.id, revision: resumed.revision }),
        objectiveHash: sha256(resumed.objective),
      })
    }

    const resume = this.options.resumeReviewOnce
    if (resume === undefined) return undefined
    const outcome = await resume(agent, reviewWake(record, continuation), signal)
    return outcome === 'stale' ? undefined : snapshotContinuation(continuation)
  }

  private assignmentAndContinuationMatch(
    agent: Agent,
    record: ApiRecoveryRecord,
    expectedContinuation: ApiRecoveryContinuation,
  ): boolean {
    const assignment = this.options.resolveAssignment(agent)
    if (assignment === undefined
      || !sameAssignment(assignment, record, expectedContinuation)) return false
    if (expectedContinuation.kind === 'review') return true
    const goal = this.ctx.goals.get(agent)
    return exactDisarmedGoal(goal, expectedContinuation)
  }

  private assignmentAndAppliedGoalMatch(
    agent: Agent,
    record: ApiRecoveryRecord,
    resumed: GoalApiRecoveryContinuation,
  ): boolean {
    const assignment = this.options.resolveAssignment(agent)
    if (assignment === undefined || !sameAssignmentIdentity(assignment, record)) return false
    if (!sameContinuation(assignment.continuation, record.continuation)
      && !sameContinuation(assignment.continuation, resumed)) return false
    return exactArmedGoal(this.ctx.goals.get(agent), resumed)
  }

  /** Recover the narrow Goal-applied/store-not-yet-committed crash window. */
  private appliedGoalContinuation(
    agent: Agent,
    record: ScheduledApiRecoveryRecord,
  ): GoalApiRecoveryContinuation | undefined {
    if (record.continuation.kind !== 'goal') return undefined
    const goal = this.ctx.goals.get(agent)
    if (goal === undefined
      || goal.id !== record.continuation.goalRef.id
      || goal.revision !== record.continuation.goalRef.revision + 1
      || goal.phase !== 'active'
      || goal.activation !== 'armed'
      || sha256(goal.objective) !== record.continuation.objectiveHash) return undefined
    const resumed: GoalApiRecoveryContinuation = Object.freeze({
      kind: 'goal',
      goalRef: Object.freeze({ id: goal.id, revision: goal.revision }),
      objectiveHash: sha256(goal.objective),
    })
    return this.assignmentAndAppliedGoalMatch(agent, record, resumed)
      ? resumed
      : undefined
  }

  private mechanicalContinuationAvailable(
    agent: Agent,
    continuation: ApiRecoveryContinuation,
  ): boolean {
    if (continuation.kind === 'review') return this.options.resumeReviewOnce !== undefined
    const goal = this.ctx.goals.get(agent)
    return goal !== undefined && goal.roundsStarted < goal.maxGoalRounds
  }

  private carryUnknownFallback(
    agent: Agent,
    assignment: ApiRecoveryAssignment,
    prior: ApiRecoveryRecord | undefined,
    failure: LlmFailure,
  ): boolean {
    if (classifyApiFailure(failure) !== 'unknown'
      || prior?.phase !== 'recovering'
      || !prior.unknownFallbackUsed
      || prior.failure.code !== failure.code
      || !sameAssignmentIdentity(assignment, prior)
      || (!sameContinuation(assignment.continuation, prior.continuation)
        && !sameContinuation(assignment.continuation, prior.resumedContinuation))) {
      return false
    }
    const resumed = prior.resumedContinuation
    if (resumed.kind === 'review') return true
    const goal = this.ctx.goals.get(agent)
    return goal !== undefined
      && goal.id === resumed.goalRef.id
      && goal.revision === resumed.goalRef.revision
      && goal.phase === 'active'
      && sha256(goal.objective) === resumed.objectiveHash
  }

  private currentRecord(sessionId: string): ApiRecoveryRecord | undefined {
    return this.pendingAwaiting.get(sessionId) ?? this.options.store.get(sessionId)
  }

  private clearPendingAwaiting(expected: AwaitingApiTerminalRecord): void {
    const pending = this.pendingAwaiting.get(expected.sessionId)
    if (pending !== undefined && sameRecord(pending, expected)) {
      this.pendingAwaiting.delete(expected.sessionId)
    }
  }

  private async removeCurrent(record: ApiRecoveryRecord): Promise<void> {
    const pending = this.pendingAwaiting.get(record.sessionId)
    if (pending !== undefined && sameRecord(pending, record)) {
      this.pendingAwaiting.delete(record.sessionId)
      const durable = this.options.store.get(record.sessionId)
      if (sameRecord(durable, record)) await this.options.store.remove(record)
      this.clearTimer(record.sessionId)
      return
    }
    if (!await this.options.store.remove(record)) return
    this.clearTimer(record.sessionId)
  }

  private async promoteOperator(
    expected: ScheduledApiRecoveryRecord | RecoveringApiRecord,
  ): Promise<void> {
    const current = this.options.store.get(expected.sessionId)
    if (current === undefined
      || (!sameRecord(current, expected) && !sameRecoveryChain(current, expected))) return
    const record: OperatorApiIncidentRecord = Object.freeze({
      ...current,
      phase: 'operator',
      terminalSeq: expected.terminalSeq,
      recordedAt: this.options.now(),
    })
    await this.options.store.put(record)
    this.publishOperator(record)
  }

  private clearTimer(sessionId: string): void {
    const timer = this.timers.get(sessionId)
    if (timer === undefined) return
    this.timers.delete(sessionId)
    this.cancelTimer(timer.cancel)
  }

  private cancelTimer(cancel: () => void): void {
    try {
      cancel()
    } catch (error) {
      this.report(error)
    }
  }

  private publishOperator(record: OperatorApiIncidentRecord): void {
    if (!this.started || this.options.onOperatorIncident === undefined) return
    void Promise.resolve(this.options.onOperatorIncident(record))
      .catch(error => this.report(error))
  }

  private async settleRecovering(
    session: Session,
    event: SessionEvent<'turn/end'>,
    current: RecoveringApiRecord,
  ): Promise<void> {
    await flushSessionDurably(this.ctx, session, 'API recovery settlement')
    if (!this.started) return
    if (!sameRecord(this.options.store.get(current.sessionId), current)) return

    if (event.data.reason.kind === 'error') {
      const disposition = classifyApiFailure(event.data.reason.error)
      if (disposition === 'ignore') {
        await this.removeCurrent(current)
        return
      }

      const agent = this.ctx.agents.get(SessionId(current.sessionId))
      const assignment = agent === undefined
        ? undefined
        : this.options.resolveAssignment(agent)
      if (assignment === undefined || !sameAssignmentIdentity(assignment, current)) {
        await this.removeCurrent(current)
        return
      }

      const sameUnknownFallback = disposition === 'unknown'
        && current.unknownFallbackUsed
        && current.failure.code === event.data.reason.error.code
      if (disposition === 'automatic'
        || (disposition === 'unknown' && !sameUnknownFallback)) {
        const failure = snapshotFailure(event.data.reason.error)
        const record: ScheduledApiRecoveryRecord = Object.freeze({
          ...snapshotAssignment(assignment),
          phase: 'scheduled',
          turn: event.data.turn,
          step: current.step,
          provider: current.provider,
          failure,
          recordedAt: this.options.now(),
          unknownFallbackUsed: false,
          terminalSeq: event.seq,
          dueAt: this.options.now() + retryDelay(failure, this.options.retryDelayMs),
        })
        await this.options.store.put(record)
        this.arm(record)
        return
      }

      const record: OperatorApiIncidentRecord = Object.freeze({
        ...snapshotAssignment(assignment),
        phase: 'operator',
        turn: event.data.turn,
        step: current.step,
        provider: current.provider,
        failure: snapshotFailure(event.data.reason.error),
        terminalSeq: event.seq,
        recordedAt: this.options.now(),
        unknownFallbackUsed: sameUnknownFallback,
      })
      await this.options.store.put(record)
      this.publishOperator(record)
      return
    }
    await this.removeCurrent(current)
  }

  private report(error: unknown): void {
    this.options.onError?.(error)
  }
}

export function installApiRecovery(
  ctx: Context,
  options: ApiRecoveryOptions,
): ApiRecoveryRuntime {
  return new ApiRecoveryRuntime(ctx, options).start()
}

function snapshotAssignment(assignment: ApiRecoveryAssignment): ApiRecoveryAssignment {
  return Object.freeze({
    ...assignment,
    continuation: snapshotContinuation(assignment.continuation),
  })
}

function snapshotContinuation(
  continuation: ApiRecoveryContinuation,
): ApiRecoveryContinuation {
  return continuation.kind === 'goal'
    ? Object.freeze({
        kind: 'goal',
        goalRef: Object.freeze({ ...continuation.goalRef }),
        objectiveHash: continuation.objectiveHash,
      })
    : Object.freeze({ ...continuation })
}

function snapshotFailure(failure: LlmFailure): LlmFailure {
  return Object.freeze({ ...failure })
}

function retryDelay(failure: LlmFailure, fallback: number): number {
  return failure.providerRetryAfterMs !== undefined
    && Number.isFinite(failure.providerRetryAfterMs)
    && failure.providerRetryAfterMs > 0
    ? failure.providerRetryAfterMs
    : fallback
}

function exactDisarmedGoal(
  goal: GoalView | undefined,
  continuation: GoalApiRecoveryContinuation,
): boolean {
  return goal !== undefined
    && goal.id === continuation.goalRef.id
    && goal.revision === continuation.goalRef.revision
    && goal.phase === 'active'
    && goal.activation === 'disarmed'
    && sha256(goal.objective) === continuation.objectiveHash
}

function exactArmedGoal(
  goal: GoalView | undefined,
  continuation: GoalApiRecoveryContinuation,
): boolean {
  return goal !== undefined
    && goal.id === continuation.goalRef.id
    && goal.revision === continuation.goalRef.revision
    && goal.phase === 'active'
    && goal.activation === 'armed'
    && sha256(goal.objective) === continuation.objectiveHash
}

function sameAssignmentIdentity(
  assignment: ApiRecoveryAssignment,
  record: ApiRecoveryRecord,
): boolean {
  return assignment.labId === record.labId
    && assignment.roleId === record.roleId
    && assignment.sessionId === record.sessionId
    && assignment.assignmentId === record.assignmentId
    && assignment.packetHash === record.packetHash
}

function sameAssignment(
  assignment: ApiRecoveryAssignment,
  record: ApiRecoveryRecord,
  expectedContinuation: ApiRecoveryContinuation,
): boolean {
  return sameAssignmentIdentity(assignment, record)
    && sameContinuation(assignment.continuation, expectedContinuation)
}

function sameFailure(left: LlmFailure, right: LlmFailure): boolean {
  return left.message === right.message
    && left.code === right.code
    && left.status === right.status
    && left.providerRetryAfterMs === right.providerRetryAfterMs
    && left.requestId === right.requestId
}

function sameRecoveryChain(left: ApiRecoveryRecord, right: ApiRecoveryRecord): boolean {
  return left.phase === 'recovering'
    && left.labId === right.labId
    && left.roleId === right.roleId
    && left.sessionId === right.sessionId
    && left.assignmentId === right.assignmentId
    && left.packetHash === right.packetHash
    && sameContinuation(left.continuation, right.continuation)
    && left.turn === right.turn
    && left.step === right.step
    && left.provider === right.provider
    && left.recordedAt === right.recordedAt
    && left.unknownFallbackUsed === right.unknownFallbackUsed
    && sameFailure(left.failure, right.failure)
}

function sameRecord(
  left: ApiRecoveryRecord | undefined,
  right: ApiRecoveryRecord,
): boolean {
  if (left === undefined
    || left.phase !== right.phase
    || left.labId !== right.labId
    || left.roleId !== right.roleId
    || left.sessionId !== right.sessionId
    || left.assignmentId !== right.assignmentId
    || left.packetHash !== right.packetHash
    || !sameContinuation(left.continuation, right.continuation)
    || left.turn !== right.turn
    || left.step !== right.step
    || left.provider !== right.provider
    || left.recordedAt !== right.recordedAt
    || left.unknownFallbackUsed !== right.unknownFallbackUsed
    || !sameFailure(left.failure, right.failure)) {
    return false
  }
  if (left.phase === 'awaiting-terminal' || right.phase === 'awaiting-terminal') {
    return left.phase === right.phase
  }
  if (left.terminalSeq !== right.terminalSeq) return false
  if (left.phase === 'operator' || right.phase === 'operator') {
    return left.phase === right.phase
  }
  if (left.phase === 'scheduled' || right.phase === 'scheduled') {
    return left.phase === 'scheduled'
      && right.phase === 'scheduled'
      && left.dueAt === right.dueAt
  }
  return sameContinuation(left.resumedContinuation, right.resumedContinuation)
    && left.resumedAt === right.resumedAt
}

function sameContinuation(
  left: ApiRecoveryContinuation,
  right: ApiRecoveryContinuation,
): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'goal') {
    return right.kind === 'goal'
      && left.goalRef.id === right.goalRef.id
      && left.goalRef.revision === right.goalRef.revision
      && left.objectiveHash === right.objectiveHash
  }
  return right.kind === 'review'
    && left.reviewId === right.reviewId
    && left.reviewAnchorHash === right.reviewAnchorHash
}

function reviewWake(
  record: ScheduledApiRecoveryRecord | RecoveringApiRecord,
  continuation: ReviewApiRecoveryContinuation,
): ReviewApiRecoveryWake {
  return Object.freeze({
    wakeId: `${continuation.reviewId}:api-recovery:${record.terminalSeq}`,
    reviewId: continuation.reviewId,
    reviewAnchorHash: continuation.reviewAnchorHash,
    labId: record.labId,
    roleId: record.roleId,
    sessionId: record.sessionId,
    assignmentId: record.assignmentId,
    packetHash: record.packetHash,
    terminalSeq: record.terminalSeq,
  })
}

function baseRecord(record: ApiRecoveryRecord): ApiRecoveryBase {
  return {
    labId: record.labId,
    roleId: record.roleId,
    sessionId: record.sessionId,
    assignmentId: record.assignmentId,
    packetHash: record.packetHash,
    continuation: snapshotContinuation(record.continuation),
    turn: record.turn,
    step: record.step,
    provider: record.provider,
    failure: snapshotFailure(record.failure),
    recordedAt: record.recordedAt,
    unknownFallbackUsed: record.unknownFallbackUsed,
  }
}
