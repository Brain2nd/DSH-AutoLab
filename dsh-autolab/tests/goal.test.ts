import { createHash } from 'node:crypto'

import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentCancelCause, AgentStatus } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import GoalService, { GoalId, type GoalRef, type GoalView } from '@deepseek-ai/dsh-goal'
import {
  SessionId,
  type Session,
  type SessionEvent,
  type TurnEndReason,
} from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'

import {
  acquireLocalReviewHold,
  compileLocalGoalIntent,
  installLocalGoal,
  pauseLocalGoal,
  pauseLocalGoalContinuation,
  type LocalGoalIntentInput,
} from '../src/goal.js'

const PACKET_HASH = 'a'.repeat(64)

function intentInput(overrides: Partial<LocalGoalIntentInput> = {}): LocalGoalIntentInput {
  return {
    installId: 'install-1',
    assignmentId: 'assignment-1',
    packetPath: '/tmp/autolab/labs/lab-1/packets/method-1.md',
    packetHash: PACKET_HASH,
    body: 'Implement the approved method using the exact packet constraints.',
    maxGoalRounds: 7,
    expectedGoalRef: null,
    ...overrides,
  }
}

function goal(overrides: Partial<GoalView> = {}): GoalView {
  return {
    id: GoalId('goal-old'),
    revision: 1,
    objective: 'old assignment',
    phase: 'active',
    maxGoalRounds: 20,
    roundsStarted: 9,
    createdAt: 1,
    updatedAt: 2,
    activation: 'armed',
    ...overrides,
  }
}

class FakeRuntime {
  readonly events: SessionEvent[] = []
  readonly session = {
    id: SessionId('worker-exact'),
    events: this.events,
  } as unknown as Session
  readonly cancelCalls: AgentCancelCause[] = []
  readonly agent: Agent
  phase: 'idle' | 'running' | 'maintenance' = 'idle'
  claimRaces = 0
  maintenanceClaims = 0
  whenIdleCalls = 0
  private maintenanceAbort: AbortController | undefined
  private maintenanceDone: Promise<unknown> | undefined
  private idleGate: Promise<void> | undefined
  private openTurn: number | undefined
  private nextTurn = 1
  private pendingCancel: AgentCancelCause | undefined

  constructor() {
    const runtime = this
    this.agent = {
      id: this.session.id,
      session: this.session,
      options: {},
      inbox: {} as Agent['inbox'],
      ctx: {} as Context,
      get status(): AgentStatus {
        return runtime.phase === 'running' ? 'running' : 'idle'
      },
      cancel(cause) {
        runtime.cancelCalls.push(cause)
        if (runtime.phase === 'running') runtime.pendingCancel = cause
        if (runtime.phase === 'maintenance') runtime.maintenanceAbort?.abort(cause)
      },
      async whenIdle() {
        runtime.whenIdleCalls += 1
        await runtime.idleGate
        await runtime.maintenanceDone
        if (runtime.phase === 'running') {
          if (runtime.openTurn === undefined) {
            runtime.phase = 'idle'
          } else {
            runtime.closeTurn(runtime.openTurn, runtime.pendingCancel === undefined
              ? { kind: 'completed' }
              : { kind: 'aborted', reason: runtime.pendingCancel })
          }
        }
      },
      runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
        if (runtime.phase !== 'idle') {
          throw new Error(`agent "${runtime.agent.id}" already has active work`)
        }
        if (runtime.claimRaces > 0) {
          runtime.claimRaces -= 1
          runtime.startTurn(runtime.nextTurn)
          throw new Error(`agent "${runtime.agent.id}" already has active work`)
        }
        runtime.phase = 'maintenance'
        runtime.maintenanceClaims += 1
        const abort = new AbortController()
        runtime.maintenanceAbort = abort
        const operation = (async () => {
          try {
            return await task(abort.signal)
          } finally {
            runtime.phase = 'idle'
            runtime.maintenanceAbort = undefined
          }
        })()
        runtime.maintenanceDone = operation
        return operation
      },
      send: vi.fn(() => {
        throw new Error('Goal control must not send model input')
      }),
      followup: vi.fn(() => {
        throw new Error('Goal control must not send model input')
      }),
      steer: vi.fn(() => {
        throw new Error('Goal control must not send model input')
      }),
      inject: vi.fn(() => {
        throw new Error('Goal control must not send model input')
      }),
    }
  }

  startTurn(turn: number): void {
    if (!Number.isSafeInteger(turn) || turn <= 0 || this.openTurn !== undefined) {
      throw new Error(`cannot start fake turn ${String(turn)}`)
    }
    this.events.push({
      type: 'turn/start',
      seq: this.events.length,
      time: this.events.length + 1,
      data: { turn },
    })
    this.openTurn = turn
    this.nextTurn = Math.max(this.nextTurn, turn + 1)
    this.phase = 'running'
  }

  closeTurn(
    turn: number,
    reason: TurnEndReason = { kind: 'completed' },
  ): void {
    if (this.openTurn !== turn) {
      throw new Error(`fake turn ${String(turn)} is not open`)
    }
    this.events.push({
      type: 'turn/end',
      seq: this.events.length,
      time: this.events.length + 1,
      data: { turn, reason },
    })
    this.openTurn = undefined
    this.pendingCancel = undefined
    if (this.phase === 'running') this.phase = 'idle'
  }

  blockWhenIdle(): () => void {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    this.idleGate = gate
    return () => {
      if (this.idleGate === gate) this.idleGate = undefined
      release()
    }
  }
}

function harness(initial?: GoalView): {
  readonly runtime: FakeRuntime
  readonly ctx: Context
  readonly flush: ReturnType<typeof vi.fn>
  readonly calls: string[]
  current(): GoalView | undefined
} {
  const runtime = new FakeRuntime()
  const calls: string[] = []
  let current = initial
  let created = 0

  function expectRef(ref: GoalRef): GoalView {
    if (current === undefined || current.id !== ref.id || current.revision !== ref.revision) {
      throw new Error('stale mock GoalRef')
    }
    return current
  }

  const goals = {
    get: vi.fn(() => current),
    pause: vi.fn((_agent: Agent, ref: GoalRef) => {
      const prior = expectRef(ref)
      calls.push('pause')
      current = {
        ...prior,
        revision: prior.revision + 1,
        phase: 'paused',
        activation: 'disarmed',
      }
      return current
    }),
    clear: vi.fn((_agent: Agent, ref: GoalRef) => {
      expectRef(ref)
      calls.push('clear')
      current = undefined
      return { id: ref.id, revision: ref.revision + 1 }
    }),
    create: vi.fn((_agent: Agent, request: { objective: string; maxGoalRounds?: number }) => {
      calls.push('create')
      created += 1
      current = goal({
        id: GoalId(`goal-created-${created}`),
        revision: 1,
        objective: request.objective,
        phase: 'active',
        maxGoalRounds: request.maxGoalRounds!,
        roundsStarted: 0,
        activation: 'armed',
      })
      return current
    }),
    resume: vi.fn((_agent: Agent, ref: GoalRef) => {
      const prior = expectRef(ref)
      calls.push('resume')
      current = {
        ...prior,
        revision: prior.revision + 1,
        phase: 'active',
        activation: 'armed',
      }
      return current
    }),
  }
  const flush = vi.fn(async () => {
    calls.push('flush')
    return true
  })
  const ctx = {
    agents: {
      get: vi.fn((id: ReturnType<typeof SessionId>) => id === runtime.agent.id
        ? runtime.agent
        : undefined),
    },
    goals,
    sessions: { flush },
  } as unknown as Context
  return { runtime, ctx, flush, calls, current: () => current }
}

describe('local Goal intent compilation', () => {
  it('renders the exact short Assignment anchor and hashes its final bytes', () => {
    const compiled = compileLocalGoalIntent(intentInput())
    expect(compiled.objective).toBe([
      'AutoLab-Install-ID: "install-1"',
      'Assignment-ID: "assignment-1"',
      'Role-Packet-Path: "/tmp/autolab/labs/lab-1/packets/method-1.md"',
      `Role-Packet-SHA256: ${PACKET_HASH}`,
      '',
      'Implement the approved method using the exact packet constraints.',
    ].join('\n'))
    expect(compiled.objectiveHash).toBe(
      createHash('sha256').update(compiled.objective).digest('hex'),
    )
    expect(compiled.maxGoalRounds).toBe(7)
  })

  it('rejects only malformed protocol identity and round-budget fields', () => {
    expect(() => compileLocalGoalIntent(intentInput({ packetHash: 'bad' })))
      .toThrowError(expect.objectContaining({ code: 'INVALID_INTENT' }))
    expect(() => compileLocalGoalIntent(intentInput({ maxGoalRounds: 0 })))
      .toThrowError(expect.objectContaining({ code: 'INVALID_INTENT' }))
  })
})

describe('same-process Goal install', () => {
  it('uses the real rc.6 Agent, GoalService, Session, and maintenance APIs', async () => {
    const ctx = new Context()
    try {
      await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: '' } })
      await ctx.plugin(GoalService)
      await ctx.plugin(AgentLoop, { agents: [] })
      ctx.on('session/flush', () => undefined)
      const handle = await ctx.agents.create({ sessionId: SessionId('real-worker') })

      const first = compileLocalGoalIntent(intentInput())
      const applied = await installLocalGoal(ctx, 'real-worker', first)
      expect(applied).toMatchObject({ outcome: 'applied', roundsStarted: 0 })
      expect(ctx.goals.get(handle.agent)).toMatchObject({
        id: applied.ref.id,
        objective: first.objective,
        maxGoalRounds: 7,
        roundsStarted: 0,
      })

      const second = compileLocalGoalIntent(intentInput({
        installId: 'install-2',
        assignmentId: 'assignment-2',
        expectedGoalRef: applied.ref,
        maxGoalRounds: 2,
      }))
      const replaced = await installLocalGoal(ctx, 'real-worker', second)
      expect(replaced).toMatchObject({ outcome: 'applied', roundsStarted: 0 })
      expect(replaced.ref.id).not.toBe(applied.ref.id)
      expect(ctx.goals.get(handle.agent)).toMatchObject({
        id: replaced.ref.id,
        objective: second.objective,
        maxGoalRounds: 2,
        roundsStarted: 0,
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('uses the exact SessionId and returns a stable error instead of name lookup', async () => {
    const { ctx } = harness()
    const compiled = compileLocalGoalIntent(intentInput())
    await expect(installLocalGoal(ctx, ' worker-exact ', compiled)).rejects.toMatchObject({
      code: 'SESSION_NOT_LOCAL',
      message: 'Session " worker-exact " is not a live Agent in this process',
    })
  })

  it('waits for a turn that wins the Goal maintenance race without cancelling it', async () => {
    const { ctx, runtime } = harness()
    runtime.claimRaces = 1

    await expect(installLocalGoal(ctx, 'worker-exact', compileLocalGoalIntent(intentInput())))
      .resolves.toMatchObject({ outcome: 'applied' })
    expect(runtime.cancelCalls).toEqual([])
    expect(runtime.whenIdleCalls).toBe(1)
  })

  it('pauses and clears the old Assignment, then creates a fresh zero-round Goal', async () => {
    const old = goal({ roundsStarted: 13, maxGoalRounds: 20 })
    const { ctx, calls, current } = harness(old)
    const compiled = compileLocalGoalIntent(intentInput({
      expectedGoalRef: { id: old.id, revision: old.revision },
      maxGoalRounds: 3,
    }))

    await expect(installLocalGoal(ctx, 'worker-exact', compiled)).resolves.toMatchObject({
      outcome: 'applied',
      ref: { id: 'goal-created-1', revision: 1 },
      objectiveHash: compiled.objectiveHash,
      roundsStarted: 0,
    })
    expect(calls).toEqual(['pause', 'clear', 'create', 'flush'])
    expect(current()).toMatchObject({
      objective: compiled.objective,
      maxGoalRounds: 3,
      roundsStarted: 0,
      activation: 'armed',
    })
  })

  it('adopts an exact active effect and flushes before returning the lost receipt', async () => {
    const compiled = compileLocalGoalIntent(intentInput())
    const existing = goal({
      id: GoalId('goal-installed'),
      objective: compiled.objective,
      maxGoalRounds: compiled.maxGoalRounds,
      roundsStarted: 2,
      activation: 'armed',
    })
    const { ctx, calls } = harness(existing)

    await expect(installLocalGoal(ctx, 'worker-exact', compiled)).resolves.toMatchObject({
      outcome: 'already-applied',
      ref: { id: 'goal-installed', revision: 1 },
      roundsStarted: 2,
    })
    expect(calls).toEqual(['flush'])
  })

  it('does not report an installed Goal when no durability listener participated', async () => {
    const compiled = compileLocalGoalIntent(intentInput())
    const { ctx, flush, calls, current } = harness()
    flush.mockImplementationOnce(async () => {
      calls.push('flush')
      return false
    })

    await expect(installLocalGoal(ctx, 'worker-exact', compiled)).rejects.toMatchObject({
      code: 'DURABILITY_UNAVAILABLE',
    })
    expect(current()).toMatchObject({ objective: compiled.objective, phase: 'active' })
    expect(calls).toEqual(['create', 'flush'])

    await expect(installLocalGoal(ctx, 'worker-exact', compiled)).resolves.toMatchObject({
      outcome: 'already-applied',
    })
    expect(calls).toEqual(['create', 'flush', 'flush'])
  })

  it('resumes an exact paused effect without resetting its Assignment rounds', async () => {
    const compiled = compileLocalGoalIntent(intentInput({ maxGoalRounds: 4 }))
    const existing = goal({
      id: GoalId('goal-installed'),
      objective: compiled.objective,
      phase: 'paused',
      maxGoalRounds: 4,
      roundsStarted: 2,
      activation: 'disarmed',
    })
    const { ctx, calls } = harness(existing)

    await expect(installLocalGoal(ctx, 'worker-exact', compiled)).resolves.toMatchObject({
      outcome: 'applied',
      ref: { id: 'goal-installed', revision: 2 },
      roundsStarted: 2,
    })
    expect(calls).toEqual(['resume', 'flush'])
  })

  it('continues safely after a crash between pausing and clearing the old Goal', async () => {
    const expected = { id: GoalId('goal-old'), revision: 4 }
    const pausedAfterCrash = goal({
      id: expected.id,
      revision: 5,
      phase: 'paused',
      activation: 'disarmed',
    })
    const { ctx, calls } = harness(pausedAfterCrash)
    const compiled = compileLocalGoalIntent(intentInput({ expectedGoalRef: expected }))

    await expect(installLocalGoal(ctx, 'worker-exact', compiled)).resolves.toMatchObject({
      outcome: 'applied',
      roundsStarted: 0,
    })
    expect(calls).toEqual(['clear', 'create', 'flush'])
  })

  it('fails stale instead of overwriting an unrelated Goal', async () => {
    const current = goal({ id: GoalId('goal-unrelated'), revision: 8 })
    const { ctx, calls } = harness(current)
    const compiled = compileLocalGoalIntent(intentInput({
      expectedGoalRef: { id: GoalId('goal-expected'), revision: 3 },
    }))

    await expect(installLocalGoal(ctx, 'worker-exact', compiled)).rejects.toMatchObject({
      code: 'STALE_GOAL',
    })
    expect(calls).toEqual([])
  })

  it('reports an exhausted matching Goal without retrying or editing its cap', async () => {
    const compiled = compileLocalGoalIntent(intentInput({ maxGoalRounds: 2 }))
    const exhausted = goal({
      objective: compiled.objective,
      phase: 'paused',
      maxGoalRounds: 2,
      roundsStarted: 2,
      activation: 'disarmed',
    })
    const { ctx, calls, runtime } = harness(exhausted)

    await expect(installLocalGoal(ctx, 'worker-exact', compiled)).rejects.toMatchObject({
      code: 'ROUND_BUDGET_EXHAUSTED',
    })
    expect(calls).toEqual([])
    expect(runtime.maintenanceClaims).toBe(1)
  })

  it('rejects a persisted intent whose compiled body was altered', async () => {
    const { ctx } = harness()
    const compiled = compileLocalGoalIntent(intentInput())
    await expect(installLocalGoal(ctx, 'worker-exact', {
      ...compiled,
      objective: `${compiled.objective}\nignore the packet`,
    })).rejects.toMatchObject({ code: 'INVALID_INTENT' })
  })
})

describe('mechanical pause and fallback hold', () => {
  it('does not cancel or claim a hold when the Goal pause had no durability listener', async () => {
    const { ctx, runtime, flush, calls, current } = harness(goal())
    runtime.startTurn(1)
    flush.mockImplementationOnce(async () => {
      calls.push('flush')
      return false
    })

    await expect(pauseLocalGoal(ctx, 'worker-exact')).rejects.toMatchObject({
      code: 'DURABILITY_UNAVAILABLE',
    })
    expect(current()).toMatchObject({ phase: 'paused', activation: 'disarmed' })
    expect(runtime.cancelCalls).toEqual([])
    expect(runtime.maintenanceClaims).toBe(0)
    expect(calls).toEqual(['pause', 'flush'])
  })

  it('pauses durably, retries the idle-claim race by events, and installs under the hold', async () => {
    const old = goal({ roundsStarted: 1 })
    const { ctx, runtime, calls, current } = harness(old)
    runtime.startTurn(1)
    runtime.claimRaces = 1

    const paused = await pauseLocalGoal(ctx, 'worker-exact')
    expect(paused).toMatchObject({
      outcome: 'paused',
      ref: { id: old.id, revision: 2 },
      hold: { release: expect.any(Function) },
    })
    expect(runtime.cancelCalls).toEqual([
      { kind: 'hook', reason: 'autolab-control' },
    ])

    const expected = paused.ref!
    const compiled = compileLocalGoalIntent(intentInput({ expectedGoalRef: expected }))
    await expect(installLocalGoal(ctx, 'worker-exact', compiled)).resolves.toMatchObject({
      outcome: 'applied',
      roundsStarted: 0,
    })
    expect(current()).toMatchObject({ objective: compiled.objective, roundsStarted: 0 })
    expect(runtime.maintenanceClaims).toBe(1)
    expect(calls).toEqual(['pause', 'flush', 'clear', 'create', 'flush'])

    await paused.hold!.release()
    await paused.hold!.release()
    expect(runtime.phase).toBe('idle')
  })

  it('does not gate an already-idle Session after its Goal is paused', async () => {
    const existing = goal({ phase: 'paused', activation: 'disarmed' })
    const { ctx, runtime, calls } = harness(existing)

    const paused = await pauseLocalGoal(ctx, 'worker-exact')
    expect(paused).toEqual({
      outcome: 'already-applied',
      ref: { id: existing.id, revision: existing.revision },
    })
    expect(runtime.cancelCalls).toEqual([])
    expect(runtime.maintenanceClaims).toBe(0)
    expect(calls).toEqual(['flush'])
  })

  it('does not cancel a new turn that wins the bounded hold-claim race', async () => {
    const { ctx, runtime } = harness(goal({ phase: 'paused', activation: 'disarmed' }))
    runtime.startTurn(1)
    runtime.claimRaces = 2

    await expect(acquireLocalReviewHold(ctx, 'worker-exact', 1)).resolves.toEqual({
      outcome: 'user-override',
    })
    expect(runtime.cancelCalls).toEqual([
      { kind: 'hook', reason: 'autolab-control' },
    ])
    expect(runtime.maintenanceClaims).toBe(0)
    expect(runtime.phase).toBe('running')
    expect(runtime.events.at(-1)).toMatchObject({
      type: 'turn/start',
      data: { turn: 3 },
    })
  })

  it('does not cancel when the current open turn differs from the reviewed turn', async () => {
    const { ctx, runtime } = harness(goal({ phase: 'paused', activation: 'disarmed' }))
    runtime.startTurn(2)

    await expect(acquireLocalReviewHold(ctx, 'worker-exact', 1)).resolves.toEqual({
      outcome: 'user-override',
    })
    expect(runtime.cancelCalls).toEqual([])
    expect(runtime.phase).toBe('running')
  })

  it('aborts immediately while hold acquisition is waiting for the reviewed turn to go idle', async () => {
    const { ctx, runtime } = harness(goal({ phase: 'paused', activation: 'disarmed' }))
    runtime.startTurn(4)
    const releaseIdle = runtime.blockWhenIdle()
    const controller = new AbortController()
    const reason = new Error('review request was torn down')

    const acquisition = acquireLocalReviewHold(ctx, 'worker-exact', 4, controller.signal)
    expect(runtime.whenIdleCalls).toBe(1)
    const rejection = expect(acquisition).rejects.toBe(reason)
    controller.abort(reason)
    await rejection

    expect(runtime.cancelCalls).toEqual([
      { kind: 'hook', reason: 'autolab-control' },
    ])
    expect(runtime.maintenanceClaims).toBe(0)
    releaseIdle()
  })

  it('lets /autolab pause stop continuation without cancelling the current turn', async () => {
    const existing = goal()
    const { ctx, runtime, calls } = harness(existing)
    runtime.startTurn(1)

    await expect(pauseLocalGoalContinuation(ctx, 'worker-exact')).resolves.toEqual({
      outcome: 'paused',
      ref: { id: existing.id, revision: existing.revision + 1 },
    })
    expect(runtime.phase).toBe('running')
    expect(runtime.cancelCalls).toEqual([])
    expect(runtime.maintenanceClaims).toBe(0)
    expect(calls).toEqual(['pause', 'flush'])
  })
})
