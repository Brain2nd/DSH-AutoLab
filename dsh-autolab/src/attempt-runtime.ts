import type { LocalTmuxPlatform } from './runner.js'
import {
  inspectLocalTmuxAttempt,
  launchLocalTmuxAttempt,
  type LocalTmuxInspection,
} from './runner.js'
import {
  readLocalAttemptIntent,
} from './attempt-artifacts.js'
import {
  reconcileLocalTmuxInspection,
  type LocalAttemptReconcileResult,
} from './local-attempt-reconcile.js'
import { canonicalJson } from './integrity.js'
import { parseState, type ActiveTrial, type RuntimeState } from './state.js'
import type { RunSlotState } from './trial.js'

export interface AttemptRuntimeTarget {
  readonly labId: string
  readonly trialId: string
  readonly runSlotId: string
}

export type AttemptRuntimeReference = NonNullable<
  ActiveTrial['runSlots'][string]['activeAttempt']
>

export type AttemptRuntimeExternalEdge = 'startup' | 'poke'
export type AttemptRuntimeEdge = AttemptRuntimeExternalEdge | 'launch-safety' | 'pending-retry'

export interface AttemptRuntimeProjection {
  /** Root must CAS this exact RuntimeState revision before publishing the new reference. */
  readonly expectedRuntimeRevision: number
  readonly trialId: string
  readonly runSlotId: string
  readonly expectedActiveAttempt: AttemptRuntimeReference
  readonly runSlotState: RunSlotState
  readonly activeAttempt: AttemptRuntimeReference
}

export interface AttemptControllerWake {
  readonly labId: string
  readonly controllerSessionId: string
  readonly goalRef: {
    readonly id: string
    readonly revision: number
  }
  readonly trialId: string
  readonly runSlotId: string
  readonly attemptId: string
  readonly phase: 'terminal' | 'outcome_unknown'
}

export type AttemptRuntimeResult =
  | {
      readonly outcome: 'inactive' | 'stale'
      readonly edge: AttemptRuntimeEdge
      readonly target: AttemptRuntimeTarget
    }
  | {
      readonly outcome: 'handled'
      readonly edge: AttemptRuntimeEdge
      readonly target: AttemptRuntimeTarget
      readonly sourceAttempt: AttemptRuntimeReference
      readonly launched: boolean
      readonly inspection: LocalTmuxInspection
      readonly reconcile: LocalAttemptReconcileResult
      readonly projection?: AttemptRuntimeProjection
      readonly controllerWake?: AttemptControllerWake
    }

export type ScheduleAttemptRuntimeOnce = (
  callback: () => void,
  delayMs: number,
) => () => void

interface AttemptRuntimeOperations {
  readonly readIntent: typeof readLocalAttemptIntent
  readonly inspect: typeof inspectLocalTmuxAttempt
  readonly launch: typeof launchLocalTmuxAttempt
  readonly reconcile: typeof reconcileLocalTmuxInspection
}

export interface AttemptRuntimeConsumerOptions {
  readonly readState: (
    labId: string,
  ) => RuntimeState | undefined | Promise<RuntimeState | undefined>
  readonly resolveRunRoot: (
    state: RuntimeState,
    target: AttemptRuntimeTarget,
  ) => string | Promise<string>
  readonly wrapperPath: string
  readonly platform?: LocalTmuxPlatform
  readonly scheduleOnce: ScheduleAttemptRuntimeOnce
  readonly pendingRetryDelayMs: number
  readonly launchSafetyDelayMs: number
  readonly now: () => number
  /** Apply `projection` by exact CAS, then perform `controllerWake`, before returning. */
  readonly onResult: (result: AttemptRuntimeResult) => void | Promise<void>
  readonly onError?: (error: unknown) => void
  /** Test seam only; production uses the existing exact runner/reconcile functions. */
  readonly operations?: Partial<AttemptRuntimeOperations>
}

interface ArmedEdge {
  readonly cancel: () => void
}

interface ResolvedAttempt {
  readonly state: RuntimeState
  readonly reference: AttemptRuntimeReference
}

const DEFAULT_OPERATIONS: AttemptRuntimeOperations = Object.freeze({
  readIntent: readLocalAttemptIntent,
  inspect: inspectLocalTmuxAttempt,
  launch: launchLocalTmuxAttempt,
  reconcile: reconcileLocalTmuxInspection,
})

/**
 * Event-driven consumer for one exact active RunSlot edge. It owns only
 * process-local one-shot timers. Durable Attempt and RuntimeState truth remain
 * in their existing artifacts and Controller CAS projection.
 */
export class AttemptRuntimeConsumer {
  private readonly operations: AttemptRuntimeOperations
  private readonly armed = new Map<string, ArmedEdge>()
  private readonly tails = new Map<string, Promise<void>>()
  private disposed = false

  constructor(private readonly options: AttemptRuntimeConsumerOptions) {
    assertDelay(options.pendingRetryDelayMs, 'pendingRetryDelayMs')
    assertDelay(options.launchSafetyDelayMs, 'launchSafetyDelayMs')
    this.operations = Object.freeze({ ...DEFAULT_OPERATIONS, ...options.operations })
  }

  dispatch(
    targetInput: AttemptRuntimeTarget,
    edge: AttemptRuntimeExternalEdge,
  ): Promise<AttemptRuntimeResult> {
    const target = snapshotTarget(targetInput)
    if (this.disposed) return Promise.reject(new Error('Attempt runtime consumer is disposed'))
    return this.enqueue(target, async () => await this.consumeAndPublish(target, edge))
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const edge of this.armed.values()) edge.cancel()
    this.armed.clear()
  }

  /** Call after dispose() and before closing RuntimeState/domain dependencies. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.tails.values()])
  }

  private async consumeAndPublish(
    target: AttemptRuntimeTarget,
    edge: AttemptRuntimeEdge,
    expected?: AttemptRuntimeReference,
  ): Promise<AttemptRuntimeResult> {
    const result = await this.consume(target, edge, expected)
    await this.options.onResult(result)
    if (!this.disposed) this.reconcileTimers(result)
    return result
  }

  private async consume(
    target: AttemptRuntimeTarget,
    edge: AttemptRuntimeEdge,
    expected?: AttemptRuntimeReference,
  ): Promise<AttemptRuntimeResult> {
    const stateInput = await this.options.readState(target.labId)
    if (stateInput === undefined) return inactive(edge, target)
    const state = parseState(stateInput)
    if (state.labId !== target.labId) return stale(edge, target)
    const reference = state.trials[target.trialId]?.runSlots[target.runSlotId]?.activeAttempt
    if (reference === undefined) return inactive(edge, target)
    const sourceAttempt = snapshotReference(reference)
    if (expected !== undefined && !sameReference(sourceAttempt, expected)) {
      return stale(edge, target)
    }

    const runRoot = await this.options.resolveRunRoot(state, target)
    const intent = await this.operations.readIntent({
      runRoot,
      activeAttempt: { path: sourceAttempt.path, hash: sourceAttempt.hash },
    })
    if (intent.attempt.value.attempt_id !== sourceAttempt.attemptId
      || intent.attempt.value.phase !== sourceAttempt.phase) {
      throw new Error('RuntimeState active Attempt reference does not match its exact artifact')
    }
    const resolved: ResolvedAttempt = { state, reference: sourceAttempt }
    let inspection = await this.operations.inspect(
      intent.launchPlan,
      this.options.platform === undefined ? {} : { platform: this.options.platform },
    )
    let launched = false
    if (sourceAttempt.phase === 'launching' && inspection.status === 'absent') {
      launched = true
      inspection = await this.operations.launch(intent.launchPlan, {
        wrapperPath: this.options.wrapperPath,
        ...(this.options.platform === undefined ? {} : { platform: this.options.platform }),
      })
    }
    const reconcile = await this.operations.reconcile({
      runRoot,
      runSlotState: state.trials[target.trialId]!.runSlots[target.runSlotId]!.state,
      intent,
      inspection,
      observedAt: this.options.now(),
    })
    const projection = compileProjection(resolved, target, reconcile)
    const controllerWake = compileControllerWake(
      state,
      target,
      projection?.activeAttempt ?? sourceAttempt,
      reconcile,
      edge,
    )
    return Object.freeze({
      outcome: 'handled',
      edge,
      target,
      sourceAttempt,
      launched,
      inspection,
      reconcile,
      ...(projection === undefined ? {} : { projection }),
      ...(controllerWake === undefined ? {} : { controllerWake }),
    })
  }

  private reconcileTimers(result: AttemptRuntimeResult): void {
    if (result.outcome !== 'handled') return
    const target = result.target
    const retryKey = armedKey(target, 'pending-retry')
    if (result.reconcile.action === 'pending') {
      if (result.edge !== 'pending-retry') {
        this.arm(
          target,
          'pending-retry',
          result.projection?.activeAttempt ?? result.sourceAttempt,
          this.options.pendingRetryDelayMs,
        )
      }
      return
    }
    this.clearArmed(retryKey)

    if (result.edge === 'poke' || result.controllerWake !== undefined) {
      this.clearArmed(armedKey(target, 'launch-safety'))
    }
    if (result.controllerWake !== undefined) return
    if (result.launched
      && (result.inspection.status === 'launching' || result.inspection.status === 'running')) {
      this.arm(
        target,
        'launch-safety',
        result.projection?.activeAttempt ?? result.sourceAttempt,
        this.options.launchSafetyDelayMs,
      )
    }
  }

  private arm(
    target: AttemptRuntimeTarget,
    edge: 'launch-safety' | 'pending-retry',
    expected: AttemptRuntimeReference,
    delayMs: number,
  ): void {
    const key = armedKey(target, edge)
    if (this.armed.has(key) || this.disposed) return
    const cancel = this.options.scheduleOnce(() => {
      if (!this.armed.delete(key) || this.disposed) return
      void this.enqueue(target, async () => await this.consumeAndPublish(
        target,
        edge,
        expected,
      )).catch(error => this.report(error))
    }, delayMs)
    this.armed.set(key, { cancel })
  }

  private clearArmed(key: string): void {
    const edge = this.armed.get(key)
    if (edge === undefined) return
    this.armed.delete(key)
    edge.cancel()
  }

  private enqueue<T>(target: AttemptRuntimeTarget, operation: () => Promise<T>): Promise<T> {
    const key = targetKey(target)
    const previous = this.tails.get(key) ?? Promise.resolve()
    const run = previous.then(operation)
    const tail = run.then(() => undefined, () => undefined)
    this.tails.set(key, tail)
    void tail.finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return run
  }

  private report(error: unknown): void {
    try {
      this.options.onError?.(error)
    } catch {
      // Error reporting cannot create another recovery edge.
    }
  }
}

function compileProjection(
  resolved: ResolvedAttempt,
  target: AttemptRuntimeTarget,
  reconcile: LocalAttemptReconcileResult,
): AttemptRuntimeProjection | undefined {
  if (!('transition' in reconcile) || reconcile.transition === undefined) return undefined
  const artifact = [...reconcile.records].reverse().find(record => (
    record.attemptArtifact !== undefined
  ))?.attemptArtifact
  if (artifact === undefined) {
    throw new Error('Attempt reconcile transition is missing its exact Attempt artifact')
  }
  const activeAttempt = snapshotReference({
    attemptId: reconcile.transition.attempt.attempt_id,
    phase: reconcile.transition.attempt.phase,
    path: artifact.path,
    hash: artifact.sha256,
    ...(resolved.reference.checkout === undefined
      ? {}
      : { checkout: resolved.reference.checkout }),
  })
  return Object.freeze({
    expectedRuntimeRevision: resolved.state.runtimeRevision,
    trialId: target.trialId,
    runSlotId: target.runSlotId,
    expectedActiveAttempt: resolved.reference,
    runSlotState: reconcile.transition.state,
    activeAttempt,
  })
}

function compileControllerWake(
  state: RuntimeState,
  target: AttemptRuntimeTarget,
  activeAttempt: AttemptRuntimeReference,
  reconcile: LocalAttemptReconcileResult,
  edge: AttemptRuntimeEdge,
): AttemptControllerWake | undefined {
  if (activeAttempt.phase !== 'terminal' && activeAttempt.phase !== 'outcome_unknown') {
    return undefined
  }
  if (reconcile.action === 'launch_required'
    || reconcile.action === 'await_started_receipt'
    || (reconcile.action === 'pending' && edge !== 'pending-retry')) return undefined
  const phase = activeAttempt.phase
  const goal = state.controllerGoal
  if (goal?.status !== 'applied'
    || goal.goalId === undefined
    || goal.goalRevision === undefined) return undefined
  return Object.freeze({
    labId: state.labId,
    controllerSessionId: state.controllerSessionId,
    goalRef: Object.freeze({ id: goal.goalId, revision: goal.goalRevision }),
    trialId: target.trialId,
    runSlotId: target.runSlotId,
    attemptId: activeAttempt.attemptId,
    phase,
  })
}

function snapshotTarget(target: AttemptRuntimeTarget): AttemptRuntimeTarget {
  if (target.labId.length === 0 || target.trialId.length === 0 || target.runSlotId.length === 0) {
    throw new TypeError('Attempt runtime target identities must be non-empty')
  }
  return Object.freeze({ ...target })
}

function snapshotReference(reference: AttemptRuntimeReference): AttemptRuntimeReference {
  return Object.freeze({
    attemptId: reference.attemptId,
    phase: reference.phase,
    path: reference.path,
    hash: reference.hash,
    ...(reference.checkout === undefined
      ? {}
      : { checkout: Object.freeze({ ...reference.checkout }) }),
  })
}

function sameReference(left: AttemptRuntimeReference, right: AttemptRuntimeReference): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function inactive(
  edge: AttemptRuntimeEdge,
  target: AttemptRuntimeTarget,
): AttemptRuntimeResult {
  return Object.freeze({ outcome: 'inactive', edge, target })
}

function stale(
  edge: AttemptRuntimeEdge,
  target: AttemptRuntimeTarget,
): AttemptRuntimeResult {
  return Object.freeze({ outcome: 'stale', edge, target })
}

function targetKey(target: AttemptRuntimeTarget): string {
  return canonicalJson(target)
}

function armedKey(
  target: AttemptRuntimeTarget,
  edge: 'launch-safety' | 'pending-retry',
): string {
  return `${targetKey(target)}\0${edge}`
}

function assertDelay(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a finite non-negative number`)
  }
}
