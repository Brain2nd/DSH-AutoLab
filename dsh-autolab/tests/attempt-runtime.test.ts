import { describe, expect, it, vi } from 'vitest'

import {
  AttemptRuntimeConsumer,
  type AttemptRuntimeResult,
  type AttemptRuntimeTarget,
  type ScheduleAttemptRuntimeOnce,
} from '../src/attempt-runtime.js'
import type { ReadLocalAttemptIntent } from '../src/attempt-artifacts.js'
import type { LocalAttemptReconcileResult } from '../src/local-attempt-reconcile.js'
import type { LocalTmuxInspection } from '../src/runner.js'
import { createRuntimeState, parseState, type RuntimeState } from '../src/state.js'
import type { Attempt, RunSlotState } from '../src/trial.js'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)
const ATTEMPT_ID = 'attempt-local-1'
const TRIAL_ID = 'trial-1'
const RUN_SLOT_ID = 'slot-1'
const LAB_ID = 'lab-20260815-120000-89abcdef'
const TARGET: AttemptRuntimeTarget = Object.freeze({
  labId: LAB_ID,
  trialId: TRIAL_ID,
  runSlotId: RUN_SLOT_ID,
})

interface ScheduledJob {
  readonly callback: () => void
  readonly delayMs: number
  cancelled: boolean
  fired: boolean
}

class OneShotScheduler {
  readonly jobs: ScheduledJob[] = []
  readonly scheduleOnce: ScheduleAttemptRuntimeOnce = (callback, delayMs) => {
    const job: ScheduledJob = { callback, delayMs, cancelled: false, fired: false }
    this.jobs.push(job)
    return () => { job.cancelled = true }
  }

  fire(index: number): void {
    const job = this.jobs[index]
    if (job === undefined) throw new Error(`missing scheduled job ${index}`)
    if (job.cancelled || job.fired) return
    job.fired = true
    job.callback()
  }
}

describe('event-driven Attempt runtime consumer', () => {
  it('launches only an exact launching+absent Attempt and takes one launch safety edge', async () => {
    const state = runtimeState('launching')
    const scheduler = new OneShotScheduler()
    const results: AttemptRuntimeResult[] = []
    const inspections: LocalTmuxInspection[] = [
      { status: 'absent', launchPrepared: false },
      { status: 'launching', launchPrepared: true, tmuxPresent: true },
    ]
    const operations = operationsFor(() => inspections.shift() ?? inspections.at(-1)!, {
      launch: async () => ({ status: 'launching', launchPrepared: true, tmuxPresent: true }),
      reconcile: async () => awaitStarted(),
    })
    const consumer = consumerFor({
      readState: () => state,
      scheduler,
      operations,
      results,
    })

    const first = await consumer.dispatch(TARGET, 'startup')
    expect(first).toMatchObject({
      outcome: 'handled',
      edge: 'startup',
      launched: true,
      reconcile: { action: 'await_started_receipt' },
    })
    expect(operations.readIntent).toHaveBeenCalledWith({
      runRoot: '/tmp/autolab-runs',
      activeAttempt: {
        path: '/tmp/autolab-runs/attempts/attempt-local-1/state/launching.json',
        hash: HASH_B,
      },
    })
    expect(operations.launch).toHaveBeenCalledTimes(1)
    expect(scheduler.jobs).toHaveLength(1)
    expect(scheduler.jobs[0]?.delayMs).toBe(20)

    scheduler.fire(0)
    await vi.waitFor(() => expect(results).toHaveLength(2))
    expect(results[1]).toMatchObject({ outcome: 'handled', edge: 'launch-safety' })
    expect(operations.inspect).toHaveBeenCalledTimes(2)
    expect(operations.launch).toHaveBeenCalledTimes(1)
    expect(scheduler.jobs).toHaveLength(1)
    consumer.dispose()
  })

  it('never launches a non-launching Attempt even when inspection reports absence', async () => {
    const scheduler = new OneShotScheduler()
    const operations = operationsFor(
      () => ({ status: 'absent', launchPrepared: true }),
      { reconcile: async () => hardBlocked() },
    )
    const consumer = consumerFor({
      readState: () => runtimeState('running'),
      scheduler,
      operations,
      results: [],
    })

    await expect(consumer.dispatch(TARGET, 'startup')).resolves.toMatchObject({
      outcome: 'handled',
      launched: false,
      reconcile: { action: 'blocked' },
    })
    expect(operations.launch).not.toHaveBeenCalled()
    expect(scheduler.jobs).toHaveLength(0)
  })

  it('coalesces pending observations into at most one one-shot retry', async () => {
    const scheduler = new OneShotScheduler()
    const results: AttemptRuntimeResult[] = []
    const pendingInspection = {
      status: 'pending' as const,
      code: 'SYSTEM_UNAVAILABLE' as const,
      message: 'tmux is temporarily unavailable',
    }
    const operations = operationsFor(
      () => pendingInspection,
      { reconcile: async () => pendingReconcile() },
    )
    const consumer = consumerFor({
      readState: () => runtimeState('launching'),
      scheduler,
      operations,
      results,
    })

    await consumer.dispatch(TARGET, 'startup')
    await consumer.dispatch(TARGET, 'poke')
    expect(scheduler.jobs).toHaveLength(1)
    expect(scheduler.jobs[0]?.delayMs).toBe(10)

    scheduler.fire(0)
    await vi.waitFor(() => expect(results).toHaveLength(3))
    expect(results.map(result => result.edge)).toEqual(['startup', 'poke', 'pending-retry'])
    expect(scheduler.jobs).toHaveLength(1)
    expect(operations.inspect).toHaveBeenCalledTimes(3)
  })

  it('finishes one pending retry before waking an already-unknown Controller Goal', async () => {
    const scheduler = new OneShotScheduler()
    const results: AttemptRuntimeResult[] = []
    const operations = operationsFor(
      () => ({
        status: 'pending',
        code: 'PROCESS_IDENTITY_UNKNOWN',
        message: 'process identity is temporarily unavailable',
      }),
      { reconcile: async () => ({
        action: 'pending',
        identity: identity(),
        pending: {
          code: 'PROCESS_IDENTITY_UNKNOWN',
          message: 'process identity is temporarily unavailable',
        },
      }) },
    )
    const consumer = consumerFor({
      readState: () => runtimeState('outcome_unknown'),
      scheduler,
      operations,
      results,
    })

    const first = await consumer.dispatch(TARGET, 'startup')
    expect(first).not.toHaveProperty('controllerWake')
    scheduler.fire(0)
    await vi.waitFor(() => expect(results).toHaveLength(2))
    expect(results[1]).toMatchObject({
      edge: 'pending-retry',
      controllerWake: {
        controllerSessionId: 'controller-session',
        goalRef: { id: 'controller-goal', revision: 7 },
        phase: 'outcome_unknown',
      },
    })
    expect(scheduler.jobs).toHaveLength(1)
  })

  it('binds a scheduled edge to the exact active Attempt reference', async () => {
    let state = runtimeState('launching')
    const scheduler = new OneShotScheduler()
    const results: AttemptRuntimeResult[] = []
    const operations = operationsFor(
      () => ({ status: 'absent', launchPrepared: false }),
      {
        launch: async () => ({ status: 'launching', launchPrepared: true, tmuxPresent: true }),
        reconcile: async () => awaitStarted(),
      },
    )
    const consumer = consumerFor({
      readState: () => state,
      scheduler,
      operations,
      results,
    })

    await consumer.dispatch(TARGET, 'startup')
    state = replaceActiveReference(state, { hash: HASH_C })
    scheduler.fire(0)
    await vi.waitFor(() => expect(results).toHaveLength(2))

    expect(results[1]).toMatchObject({ outcome: 'stale', edge: 'launch-safety' })
    expect(operations.readIntent).toHaveBeenCalledTimes(1)
    expect(operations.inspect).toHaveBeenCalledTimes(1)
  })

  it('returns the exact RuntimeState CAS projection and same Controller Goal wake', async () => {
    const state = runtimeState('running')
    const scheduler = new OneShotScheduler()
    const results: AttemptRuntimeResult[] = []
    const terminalAttempt = attemptValue('terminal')
    const terminalState = runSlotState('terminal')
    const reconcile = projectionReconcile('completed', terminalAttempt, terminalState)
    const operations = operationsFor(
      () => ({ status: 'completed', started: {} as never, exit: {} as never }),
      { reconcile: async () => reconcile },
    )
    const consumer = consumerFor({
      readState: () => state,
      scheduler,
      operations,
      results,
    })

    const result = await consumer.dispatch(TARGET, 'poke')
    expect(result).toMatchObject({
      outcome: 'handled',
      projection: {
        expectedRuntimeRevision: state.runtimeRevision,
        trialId: TRIAL_ID,
        runSlotId: RUN_SLOT_ID,
        expectedActiveAttempt: { attemptId: ATTEMPT_ID, phase: 'running', hash: HASH_B },
        runSlotState: { status: 'execution_complete' },
        activeAttempt: {
          attemptId: ATTEMPT_ID,
          phase: 'terminal',
          path: '/tmp/autolab-runs/attempts/attempt-local-1/state/terminal.json',
          hash: HASH_C,
        },
      },
      controllerWake: {
        controllerSessionId: 'controller-session',
        goalRef: { id: 'controller-goal', revision: 7 },
        attemptId: ATTEMPT_ID,
        phase: 'terminal',
      },
    })
    expect(scheduler.jobs).toHaveLength(0)
  })

  it.each([
    ['terminal', 'completed'],
    ['outcome_unknown', 'outcome_unknown'],
  ] as const)('wakes the persisted Controller Goal for replayed %s', async (phase, status) => {
    const scheduler = new OneShotScheduler()
    const inspection: LocalTmuxInspection = status === 'completed'
      ? { status, started: {} as never, exit: {} as never }
      : { status, reason: 'exact durable uncertainty' }
    const operations = operationsFor(
      () => inspection,
      { reconcile: async () => alreadyReconciled(status) },
    )
    const consumer = consumerFor({
      readState: () => runtimeState(phase),
      scheduler,
      operations,
      results: [],
    })

    await expect(consumer.dispatch(TARGET, 'startup')).resolves.toMatchObject({
      outcome: 'handled',
      controllerWake: {
        controllerSessionId: 'controller-session',
        goalRef: { id: 'controller-goal', revision: 7 },
        phase,
      },
    })
  })

  it('drains admitted work after dispose without accepting another edge', async () => {
    let releaseRead!: () => void
    const readGate = new Promise<void>(resolve => { releaseRead = resolve })
    const scheduler = new OneShotScheduler()
    const operations = operationsFor(
      () => ({ status: 'launching', launchPrepared: true, tmuxPresent: true }),
      { reconcile: async () => awaitStarted() },
    )
    const consumer = consumerFor({
      readState: async () => {
        await readGate
        return runtimeState('launching')
      },
      scheduler,
      operations,
      results: [],
    })
    const admitted = consumer.dispatch(TARGET, 'startup')
    consumer.dispose()
    let drained = false
    const drain = consumer.drain().then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    await expect(consumer.dispatch(TARGET, 'poke')).rejects.toThrow('disposed')

    releaseRead()
    await admitted
    await drain
    expect(drained).toBe(true)
    expect(scheduler.jobs).toHaveLength(0)
  })
})

function consumerFor(input: {
  readonly readState: () => RuntimeState | Promise<RuntimeState>
  readonly scheduler: OneShotScheduler
  readonly operations: ReturnType<typeof operationsFor>
  readonly results: AttemptRuntimeResult[]
}): AttemptRuntimeConsumer {
  return new AttemptRuntimeConsumer({
    readState: input.readState,
    resolveRunRoot: () => '/tmp/autolab-runs',
    wrapperPath: '/opt/dsh-autolab/attempt-wrapper.mjs',
    scheduleOnce: input.scheduler.scheduleOnce,
    pendingRetryDelayMs: 10,
    launchSafetyDelayMs: 20,
    now: () => 100,
    onResult: result => { input.results.push(result) },
    operations: input.operations,
  })
}

function operationsFor(
  inspectValue: () => LocalTmuxInspection,
  overrides: {
    readonly launch?: () => Promise<LocalTmuxInspection>
    readonly reconcile?: () => Promise<LocalAttemptReconcileResult>
  },
) {
  return {
    readIntent: vi.fn(async ({ activeAttempt }: { activeAttempt: { path: string; hash: string } }) => (
      intentFor(activeAttempt.path.includes('/terminal.')
        ? 'terminal'
        : activeAttempt.path.includes('/outcome_unknown.')
          ? 'outcome_unknown'
          : activeAttempt.path.includes('/running.')
            ? 'running'
            : 'launching')
    )),
    inspect: vi.fn(async () => inspectValue()),
    launch: vi.fn(overrides.launch ?? (async () => ({
      status: 'launching' as const,
      launchPrepared: true,
      tmuxPresent: true as const,
    }))),
    reconcile: vi.fn(overrides.reconcile ?? (async () => awaitStarted())),
  }
}

function runtimeState(
  phase: 'launching' | 'running' | 'outcome_unknown' | 'terminal',
): RuntimeState {
  const base = createRuntimeState({
    labId: LAB_ID,
    ownerEpoch: '00000000-0000-4000-8000-000000000111',
    controllerSessionId: 'controller-session',
    lifecycle: 'ready',
    config: {
      revision: 1,
      specHash: HASH_A,
      configHash: HASH_A,
      manifestHash: HASH_A,
      dialogueHeadHash: HASH_A,
      revisionPath: '/tmp/autolab-revision',
    },
    now: 1,
  })
  return parseState({
    ...base,
    lifecycle: 'running',
    controllerGoal: {
      installId: 'controller-install',
      assignmentId: 'controller-assignment',
      objectiveHash: HASH_A,
      maxGoalRounds: 20,
      status: 'applied',
      goalId: 'controller-goal',
      goalRevision: 7,
      roleId: 'controller',
      packetHash: HASH_A,
    },
    roles: {
      coder: { sessionId: 'coder-session', phase: 'starting' },
    },
    candidates: {
      lane: {
        version: 1,
        sourceRevision: 1,
        laneId: 'lane',
        candidateId: 'candidate-1',
        coderRoleId: 'coder',
        coderSessionId: 'coder-session',
        assignmentId: 'assignment-1',
        candidateSha: '1'.repeat(40),
        captureReceipt: { path: '/tmp/candidate.json', hash: HASH_A },
        frozenAt: 1,
      },
    },
    trials: {
      [TRIAL_ID]: {
        version: 1,
        sourceRevision: 1,
        laneId: 'lane',
        candidateId: 'candidate-1',
        candidateSha: '1'.repeat(40),
        contract: { path: '/tmp/trial.json', hash: HASH_A },
        runSlots: {
          [RUN_SLOT_ID]: {
            contract: { path: '/tmp/runslot.json', hash: HASH_A },
            state: runSlotState(phase),
            activeAttempt: {
              attemptId: ATTEMPT_ID,
              phase,
              path: `/tmp/autolab-runs/attempts/${ATTEMPT_ID}/state/${phase}.json`,
              hash: HASH_B,
            },
          },
        },
      },
    },
  })
}

function replaceActiveReference(
  state: RuntimeState,
  replacement: Partial<NonNullable<
    RuntimeState['trials'][string]['runSlots'][string]['activeAttempt']
  >>,
): RuntimeState {
  const trial = state.trials[TRIAL_ID]!
  const slot = trial.runSlots[RUN_SLOT_ID]!
  return parseState({
    ...state,
    trials: {
      ...state.trials,
      [TRIAL_ID]: {
        ...trial,
        runSlots: {
          ...trial.runSlots,
          [RUN_SLOT_ID]: {
            ...slot,
            activeAttempt: { ...slot.activeAttempt!, ...replacement },
          },
        },
      },
    },
  })
}

function runSlotState(
  phase: 'launching' | 'running' | 'outcome_unknown' | 'terminal',
): RunSlotState {
  return {
    version: 1,
    runslot_id: RUN_SLOT_ID,
    trial_id: TRIAL_ID,
    runslot_contract_sha256: HASH_A,
    revision: phase === 'terminal' ? 3 : phase === 'outcome_unknown' ? 2 : 1,
    status: phase === 'terminal'
      ? 'execution_complete'
      : phase === 'outcome_unknown'
        ? 'outcome_unknown'
        : 'attempt_active',
    attempt_id: ATTEMPT_ID,
    attempt_ordinal: 1,
    attempt_identity_sha256: HASH_B,
    attempt_ids: [ATTEMPT_ID],
    launch_nonces: ['launch-nonce-1'],
  }
}

function intentFor(phase: Attempt['phase']): ReadLocalAttemptIntent {
  return {
    request: {} as never,
    attempt: { value: attemptValue(phase) } as never,
    launchPlan: { attemptId: ATTEMPT_ID } as never,
  }
}

function attemptValue(phase: Attempt['phase']): Attempt {
  return { attempt_id: ATTEMPT_ID, phase } as Attempt
}

function identity() {
  return { attemptId: ATTEMPT_ID, launchNonce: 'launch-nonce-1', requestSha256: HASH_A }
}

function awaitStarted(): LocalAttemptReconcileResult {
  return {
    action: 'await_started_receipt',
    identity: identity(),
    launchPrepared: true,
  }
}

function hardBlocked(): LocalAttemptReconcileResult {
  return {
    action: 'blocked',
    identity: identity(),
    blocker: { code: 'RECEIPT_CORRUPT', message: 'started receipt disappeared' },
  }
}

function pendingReconcile(): LocalAttemptReconcileResult {
  return {
    action: 'pending',
    identity: identity(),
    pending: { code: 'SYSTEM_UNAVAILABLE', message: 'tmux is temporarily unavailable' },
  }
}

function alreadyReconciled(
  status: 'completed' | 'outcome_unknown',
): LocalAttemptReconcileResult {
  return {
    action: 'already_reconciled',
    identity: identity(),
    inspectionStatus: status,
    records: [],
  }
}

function projectionReconcile(
  status: 'completed' | 'outcome_unknown',
  attempt: Attempt,
  state: RunSlotState,
): LocalAttemptReconcileResult {
  return {
    action: status === 'completed' ? 'record_completion' : 'record_uncertain',
    identity: identity(),
    inspectionStatus: status,
    records: [{
      kind: status === 'completed' ? 'completion' : 'uncertain',
      receipt: {} as never,
      attemptArtifact: {
        value: attempt,
        canonicalJson: '{}',
        sha256: HASH_C,
        path: `/tmp/autolab-runs/attempts/${ATTEMPT_ID}/state/${attempt.phase}.json`,
      },
    }],
    transition: {
      expected_revision: 1,
      state,
      attempt,
    },
  }
}
