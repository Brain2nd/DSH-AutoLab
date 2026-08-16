import { createHash } from 'node:crypto'

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GoalRef, GoalView } from '@deepseek-ai/dsh-goal'
import { SessionId } from '@deepseek-ai/dsh-session'

const SHA256_PATTERN = /^[0-9a-f]{64}$/
const CONTROL_CANCEL_REASON = 'autolab-control'

export interface LocalGoalIntentInput {
  readonly installId: string
  readonly assignmentId: string
  readonly packetPath: string
  readonly packetHash: string
  readonly body: string
  readonly maxGoalRounds: number
  readonly expectedGoalRef: GoalRef | null
}

/** The exact, caller-persisted intent installed into one local Session. */
export interface LocalGoalInstallIntent extends LocalGoalIntentInput {
  readonly objective: string
  readonly objectiveHash: string
}

export interface LocalGoalInstallResult {
  readonly outcome: 'applied' | 'already-applied' | 'already-complete'
  readonly ref: GoalRef
  readonly objectiveHash: string
  readonly roundsStarted: number
}

export interface LocalGoalHold {
  /** Release this process-local fallback barrier. Safe to call more than once. */
  release(): Promise<void>
}

export interface LocalGoalPauseResult {
  readonly outcome: 'paused' | 'already-applied' | 'no-active-goal'
  readonly ref?: GoalRef
  /** Review barrier claimed after the durable Goal pause, when a turn was still active. */
  readonly hold?: LocalGoalHold
}

export interface LocalReviewHoldResult {
  readonly outcome: 'held' | 'not-required' | 'user-override'
  readonly hold?: LocalGoalHold
}

export class LocalGoalError extends Error {
  readonly name = 'LocalGoalError'

  constructor(
    message: string,
    readonly code:
      | 'SESSION_NOT_LOCAL'
      | 'DURABILITY_UNAVAILABLE'
      | 'INVALID_INTENT'
      | 'STALE_GOAL'
      | 'ROUND_BUDGET_EXHAUSTED'
      | 'SESSION_BUSY'
      | 'INVALID_TURN'
      | 'HOLD_RELEASED',
  ) {
    super(message)
  }
}

/**
 * Deterministically compile the short Goal payload before the Controller
 * persists its install intent. The full Lab specification remains in the
 * immutable packet; it is deliberately not copied into every Goal round.
 */
export function compileLocalGoalIntent(input: LocalGoalIntentInput): LocalGoalInstallIntent {
  validateIntentInput(input)
  const objective = [
    `AutoLab-Install-ID: ${JSON.stringify(input.installId)}`,
    `Assignment-ID: ${JSON.stringify(input.assignmentId)}`,
    `Role-Packet-Path: ${JSON.stringify(input.packetPath)}`,
    `Role-Packet-SHA256: ${input.packetHash}`,
    '',
    input.body,
  ].join('\n')

  return Object.freeze({
    ...input,
    expectedGoalRef: input.expectedGoalRef === null
      ? null
      : Object.freeze({ ...input.expectedGoalRef }),
    objective,
    objectiveHash: sha256(objective),
  })
}

/** Install or adopt one exact Assignment Goal on an Agent live in this process. */
export async function installLocalGoal(
  ctx: Context,
  sessionId: string,
  intent: LocalGoalInstallIntent,
): Promise<LocalGoalInstallResult> {
  const compiled = compileLocalGoalIntent(intent)
  if (intent.objective !== compiled.objective || intent.objectiveHash !== compiled.objectiveHash) {
    throw new LocalGoalError(
      `Goal install intent ${JSON.stringify(intent.installId)} does not match its compiled objective`,
      'INVALID_INTENT',
    )
  }

  const agent = resolveLocalAgent(ctx, sessionId)
  return await runInMaintenance(ctx, agent, async () => {
    assertStillLocal(ctx, agent)
    let current = ctx.goals.get(agent)

    if (current !== undefined && matchesIntent(current, intent)) {
      const alreadyApplied = current.phase === 'complete'
        || (current.phase === 'active' && current.activation === 'armed')
      current = resumeMatchingGoal(ctx, agent, current)
      await flushGoalSession(ctx, agent)
      return installResult(
        current.phase === 'complete'
          ? 'already-complete'
          : alreadyApplied
            ? 'already-applied'
            : 'applied',
        current,
        intent.objectiveHash,
      )
    }

    if (current?.objective === intent.objective) {
      throw new LocalGoalError(
        `Goal install intent ${JSON.stringify(intent.installId)} conflicts with the current round cap`,
        'STALE_GOAL',
      )
    }

    if (!mayReplaceCurrent(current, intent.expectedGoalRef)) {
      throw new LocalGoalError(
        `Goal install intent ${JSON.stringify(intent.installId)} has a stale expected GoalRef`,
        'STALE_GOAL',
      )
    }

    if (current !== undefined && current.phase !== 'complete') {
      if (current.phase === 'active') {
        current = ctx.goals.pause(agent, refOf(current))
      }
      ctx.goals.clear(agent, refOf(current))
    }

    const created = ctx.goals.create(agent, {
      objective: intent.objective,
      maxGoalRounds: intent.maxGoalRounds,
    })
    await flushGoalSession(ctx, agent)
    return installResult('applied', created, intent.objectiveHash)
  })
}

/**
 * Durably pause the current local Goal, then claim the native maintenance
 * phase only when an observed Agent turn still needs the review fallback.
 */
export async function pauseLocalGoal(
  ctx: Context,
  sessionId: string,
  signal?: AbortSignal,
): Promise<LocalGoalPauseResult> {
  const agent = resolveLocalAgent(ctx, sessionId)
  const result = await pauseGoalContinuation(ctx, agent)

  assertStillLocal(ctx, agent)
  const observedTurn = observeOpenAgentTurn(agent)
  if (agent.status !== 'running' || observedTurn === undefined) return result
  const reviewHold = await acquireLocalReviewHold(ctx, sessionId, observedTurn, signal)

  return {
    ...result,
    ...(reviewHold.hold === undefined ? {} : { hold: reviewHold.hold }),
  }
}

/**
 * Claim the narrow review fallback barrier for one exact Session. This is
 * event-driven and deliberately bounded: one observed turn cancellation, one
 * join after a claim race, and one retry. A continuously user-driven Session
 * is reported as an override instead of being cancelled in a loop.
 */
export async function acquireLocalReviewHold(
  ctx: Context,
  sessionId: string,
  expectedTurn: number,
  signal?: AbortSignal,
): Promise<LocalReviewHoldResult> {
  assertPositiveTurn(expectedTurn)
  signal?.throwIfAborted()
  const agent = resolveLocalAgent(ctx, sessionId)
  const active = activeHolds.get(agent)
  if (active !== undefined && !active.released && !active.closed) {
    return active.expectedTurn === expectedTurn
      ? { outcome: 'held', hold: publicHold(active) }
      : { outcome: 'user-override' }
  }

  const acquiring = acquiringHolds.get(agent)
  if (acquiring !== undefined) {
    if (acquiring.expectedTurn !== expectedTurn) return { outcome: 'user-override' }
    return { outcome: 'held', hold: publicHold(await acquiring.promise) }
  }

  if (agent.status !== 'running') return { outcome: 'not-required' }
  if (observeOpenAgentTurn(agent) !== expectedTurn) return { outcome: 'user-override' }

  // Stop only the turn observed at the review boundary. If another turn wins
  // the later maintenance claim race, the bounded claimant joins it once but
  // never cancels it as though it were the reviewed work.
  agent.cancel({ kind: 'hook', reason: CONTROL_CANCEL_REASON }, { keepInbox: true })
  await waitForAgentIdle(agent, signal)
  assertStillLocal(ctx, agent)
  signal?.throwIfAborted()

  const acquisition = acquireMaintenanceHoldBounded(ctx, agent, expectedTurn, signal)
  acquiringHolds.set(agent, { expectedTurn, promise: acquisition })
  try {
    const hold = await acquisition
    if (signal?.aborted) {
      await publicHold(hold).release()
      signal.throwIfAborted()
    }
    return { outcome: 'held', hold: publicHold(hold) }
  } catch (error) {
    if (error instanceof LocalGoalError && error.code === 'SESSION_BUSY') {
      return { outcome: 'user-override' }
    }
    throw error
  } finally {
    if (acquiringHolds.get(agent)?.promise === acquisition) acquiringHolds.delete(agent)
  }
}

/** Return the exact currently open durable turn, never merely Agent `running`. */
export function observeOpenAgentTurn(agent: Agent): number | undefined {
  const boundary = agent.session.events.findLast(event => (
    event.type === 'turn/start' || event.type === 'turn/end'
  ))
  if (boundary?.type !== 'turn/start') return undefined
  assertPositiveTurn(boundary.data.turn)
  return boundary.data.turn
}

/**
 * Stop only automatic Goal continuation. Used by `/autolab pause`: it never
 * cancels the current LLM turn and never acquires a maintenance barrier.
 */
export async function pauseLocalGoalContinuation(
  ctx: Context,
  sessionId: string,
): Promise<LocalGoalPauseResult> {
  const agent = resolveLocalAgent(ctx, sessionId)
  return await pauseGoalContinuation(ctx, agent)
}

async function pauseGoalContinuation(
  ctx: Context,
  agent: Agent,
): Promise<LocalGoalPauseResult> {
  const current = ctx.goals.get(agent)
  let outcome: LocalGoalPauseResult['outcome']
  let ref: GoalRef | undefined

  if (current?.phase === 'active') {
    const paused = ctx.goals.pause(agent, refOf(current))
    ref = refOf(paused)
    outcome = 'paused'
    await flushGoalSession(ctx, agent)
  } else if (current?.phase === 'paused') {
    ref = refOf(current)
    outcome = 'already-applied'
    await flushGoalSession(ctx, agent)
  } else {
    ref = current === undefined ? undefined : refOf(current)
    outcome = 'no-active-goal'
  }

  assertStillLocal(ctx, agent)
  return {
    outcome,
    ...(ref === undefined ? {} : { ref }),
  }
}

interface MaintenanceJob<T> {
  readonly run: (signal: AbortSignal) => Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason: unknown) => void
}

interface MaintenanceHoldState {
  readonly agent: Agent
  readonly expectedTurn: number
  readonly jobs: MaintenanceJob<unknown>[]
  readonly finished: Promise<void>
  closed: boolean
  released: boolean
  wake: (() => void) | undefined
}

const activeHolds = new WeakMap<Agent, MaintenanceHoldState>()
const acquiringHolds = new WeakMap<Agent, {
  readonly expectedTurn: number
  readonly promise: Promise<MaintenanceHoldState>
}>()

async function runInMaintenance<T>(
  ctx: Context,
  agent: Agent,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const active = activeHolds.get(agent)
  if (active !== undefined && !active.released && !active.closed) {
    return await submitHoldJob(active, operation)
  }

  const acquiring = acquiringHolds.get(agent)
  if (acquiring !== undefined) {
    const hold = await acquiring.promise
    return await submitHoldJob(hold, operation)
  }

  assertStillLocal(ctx, agent)
  let entered = false
  try {
    return await agent.runMaintenance(async signal => {
      entered = true
      return await operation(signal)
    })
  } catch (error) {
    // Once maintenance was claimed, this is the operation's own result. It
    // must never be mistaken for a claim race and executed a second time.
    if (entered) throw error

    // User/role work may win between inspection and the native maintenance
    // claim. Join it once and retry without cancellation. Only the review
    // fallback below is authorized to cancel its explicitly bound source turn.
    await agent.whenIdle()
    assertStillLocal(ctx, agent)
    let retryEntered = false
    try {
      return await agent.runMaintenance(async signal => {
        retryEntered = true
        return await operation(signal)
      })
    } catch (retryError) {
      if (retryEntered) throw retryError
      throw new LocalGoalError(
        `Session ${JSON.stringify(String(agent.id))} remained busy during an authorized Goal operation`,
        'SESSION_BUSY',
      )
    }
  }
}

async function acquireMaintenanceHold(
  ctx: Context,
  agent: Agent,
  expectedTurn: number,
): Promise<MaintenanceHoldState> {
  assertStillLocal(ctx, agent)
  const ready = deferred<MaintenanceHoldState>()
  let state!: MaintenanceHoldState
  const finished = agent.runMaintenance(async (signal) => {
    const claimed = await ready.promise
    try {
      while (!claimed.released && !signal.aborted) {
        const job = claimed.jobs.shift()
        if (job !== undefined) {
          try {
            job.resolve(await job.run(signal))
          } catch (error) {
            job.reject(error)
          }
          continue
        }
        await waitForHoldWork(claimed, signal)
      }
    } finally {
      claimed.closed = true
      while (claimed.jobs.length > 0) {
        claimed.jobs.shift()!.reject(new LocalGoalError(
          'AutoLab maintenance hold was released before the operation ran',
          'HOLD_RELEASED',
        ))
      }
    }
  })
  state = {
    agent,
    expectedTurn,
    jobs: [],
    finished,
    closed: false,
    released: false,
    wake: undefined,
  }
  ready.resolve(state)
  activeHolds.set(agent, state)
  void finished.finally(() => {
    if (activeHolds.get(agent) === state) activeHolds.delete(agent)
  }).catch(() => undefined)
  return state
}

async function acquireMaintenanceHoldBounded(
  ctx: Context,
  agent: Agent,
  expectedTurn: number,
  signal?: AbortSignal,
): Promise<MaintenanceHoldState> {
  signal?.throwIfAborted()
  try {
    return await acquireMaintenanceHold(ctx, agent, expectedTurn)
  } catch (error) {
    if (error instanceof LocalGoalError) throw error

    // A new turn can win the tiny idle→maintenance claim window. It is not the
    // originally reviewed turn, so join it without cancellation and retry once.
    await waitForAgentIdle(agent, signal)
    assertStillLocal(ctx, agent)
    signal?.throwIfAborted()
    try {
      return await acquireMaintenanceHold(ctx, agent, expectedTurn)
    } catch (retryError) {
      if (retryError instanceof LocalGoalError) throw retryError
      throw new LocalGoalError(
        `Session ${JSON.stringify(String(agent.id))} remained busy during review freeze`,
        'SESSION_BUSY',
      )
    }
  }
}

async function waitForAgentIdle(agent: Agent, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) {
    await agent.whenIdle()
    return
  }
  signal.throwIfAborted()
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([agent.whenIdle(), aborted])
  } finally {
    signal.removeEventListener('abort', onAbort!)
  }
}

function assertPositiveTurn(turn: number): void {
  if (!Number.isSafeInteger(turn) || turn <= 0) {
    throw new LocalGoalError(
      `review turn must be a positive safe integer, got ${String(turn)}`,
      'INVALID_TURN',
    )
  }
}

function submitHoldJob<T>(
  state: MaintenanceHoldState,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (state.released || state.closed) {
    throw new LocalGoalError('AutoLab maintenance hold is already released', 'HOLD_RELEASED')
  }
  return new Promise<T>((resolve, reject) => {
    state.jobs.push({
      run: operation as (signal: AbortSignal) => Promise<unknown>,
      resolve: resolve as (value: unknown) => void,
      reject,
    })
    state.wake?.()
  })
}

function publicHold(state: MaintenanceHoldState): LocalGoalHold {
  return {
    async release() {
      if (!state.released) {
        state.released = true
        state.wake?.()
      }
      await state.finished
    },
  }
}

async function waitForHoldWork(
  state: MaintenanceHoldState,
  signal: AbortSignal,
): Promise<void> {
  if (state.released || state.jobs.length > 0 || signal.aborted) return
  await new Promise<void>((resolve) => {
    const wake = () => {
      signal.removeEventListener('abort', wake)
      if (state.wake === wake) state.wake = undefined
      resolve()
    }
    state.wake = wake
    signal.addEventListener('abort', wake, { once: true })
    if (state.released || state.jobs.length > 0 || signal.aborted) wake()
  })
}

function resumeMatchingGoal(ctx: Context, agent: Agent, current: GoalView): GoalView {
  if (current.phase === 'complete') return current
  if (current.phase === 'active' && current.activation === 'armed') return current
  if (current.roundsStarted >= current.maxGoalRounds) {
    throw new LocalGoalError(
      `Goal ${JSON.stringify(String(current.id))} exhausted ${current.maxGoalRounds} rounds`,
      'ROUND_BUDGET_EXHAUSTED',
    )
  }
  return ctx.goals.resume(agent, refOf(current))
}

function matchesIntent(
  current: GoalView,
  intent: LocalGoalInstallIntent,
): boolean {
  return current.objective === intent.objective
    && sha256(current.objective) === intent.objectiveHash
    && current.maxGoalRounds === intent.maxGoalRounds
}

function mayReplaceCurrent(
  current: GoalView | undefined,
  expected: GoalRef | null,
): boolean {
  if (current === undefined) return true
  if (expected === null) return false
  if (sameRef(current, expected)) return true
  return current.id === expected.id
    && current.revision === expected.revision + 1
    && current.phase === 'paused'
}

function installResult(
  outcome: LocalGoalInstallResult['outcome'],
  goal: GoalView,
  objectiveHash: string,
): LocalGoalInstallResult {
  return {
    outcome,
    ref: refOf(goal),
    objectiveHash,
    roundsStarted: goal.roundsStarted,
  }
}

function resolveLocalAgent(ctx: Context, rawSessionId: string): Agent {
  const agent = ctx.agents.get(SessionId(rawSessionId))
  if (agent === undefined) {
    throw new LocalGoalError(
      `Session ${JSON.stringify(rawSessionId)} is not a live Agent in this process`,
      'SESSION_NOT_LOCAL',
    )
  }
  return agent
}

async function flushGoalSession(ctx: Context, agent: Agent): Promise<void> {
  if (!await ctx.sessions.flush(agent.session)) {
    throw new LocalGoalError(
      `Session ${JSON.stringify(String(agent.id))} has no durability listener`,
      'DURABILITY_UNAVAILABLE',
    )
  }
}

function assertStillLocal(ctx: Context, agent: Agent): void {
  if (ctx.agents.get(agent.id) !== agent) {
    throw new LocalGoalError(
      `Session ${JSON.stringify(String(agent.id))} is no longer the live Agent in this process`,
      'SESSION_NOT_LOCAL',
    )
  }
}

function validateIntentInput(input: LocalGoalIntentInput): void {
  if (input.installId.length === 0
    || input.assignmentId.length === 0
    || input.packetPath.length === 0
    || input.body.trim().length === 0
    || !SHA256_PATTERN.test(input.packetHash)
    || !Number.isSafeInteger(input.maxGoalRounds)
    || input.maxGoalRounds <= 0
    || (input.expectedGoalRef !== null
      && (String(input.expectedGoalRef.id).length === 0
        || !Number.isSafeInteger(input.expectedGoalRef.revision)
        || input.expectedGoalRef.revision <= 0))) {
    throw new LocalGoalError('invalid local Goal install intent', 'INVALID_INTENT')
  }
}

function refOf(goal: GoalView): GoalRef {
  return { id: goal.id, revision: goal.revision }
}

function sameRef(goal: GoalView, ref: GoalRef): boolean {
  return goal.id === ref.id && goal.revision === ref.revision
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
