import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'

import type { FrozenRevision } from '../src/artifacts.js'
import { readRoleBinding } from '../src/binding.js'
import AutoLabRuntime from '../src/index.js'
import {
  rolePromptFor,
  type RootRoleBinding,
} from '../src/roles.js'
import {
  roleStateSchema,
  type RuntimeState,
  type RoleState,
} from '../src/state.js'

const HASH = 'a'.repeat(64)

describe('Lane-local activation isolation', () => {
  it('keeps activation failure orthogonal to the scientific role phase', () => {
    const role = roleStateSchema.parse({
      sessionId: 'method-session',
      phase: 'reviewing',
      binding: { path: '/lab/method-binding.json', hash: HASH },
      packet: { path: '/lab/method-packet.json', hash: HASH },
      activationBlocker: {
        code: 'ROLE_ACTIVATION_FAILED',
        message: 'provider temporarily unavailable',
      },
    })

    expect(role.phase).toBe('reviewing')
    expect(role.activationBlocker).toEqual({
      code: 'ROLE_ACTIVATION_FAILED',
      message: 'provider temporarily unavailable',
    })
  })

  it('settles worktree and role failures locally while admitting independent roles', async () => {
    const workers = [
      role('lane-a-method', 'method', 'lane-a'),
      role('lane-a-coder', 'coder', 'lane-a'),
      role('lane-b-method', 'method', 'lane-b'),
      role('ops', 'ops'),
    ]
    const roles = Object.fromEntries(workers.map(value => [
      value.role_id,
      { sessionId: `session-${value.role_id}`, phase: 'starting' },
    ])) as Record<string, RoleState>
    const activatedCalls: string[] = []
    let reconciledPartial = false
    const receiver = {
      ctx: { agents: { get: () => undefined } },
      provisionWorktrees: async () => new Map([['lane-b', 'lane-b worktree is unavailable']]),
      requireSessionPersistence: () => ({ list: async () => [] }),
      activateRole: async ({ role: value }: { role: RootRoleBinding }) => {
        activatedCalls.push(value.role_id)
        if (value.role_id === 'lane-a-coder') throw new Error('coder Session API failed')
        return {
          role: value,
          agent: { id: SessionId(`session-${value.role_id}`) } as Agent,
        }
      },
      reconcileCommunicationAcl: async (
        _caller: Agent,
        _state: RuntimeState,
        _frozen: FrozenRevision,
        _activated: readonly unknown[],
        _signal: AbortSignal | undefined,
        allowPartial: boolean,
      ) => {
        reconciledPartial = allowPartial
      },
    }
    const activate = (AutoLabRuntime.prototype as unknown as {
      activateRolesForControl: (
        caller: Agent,
        state: RuntimeState,
        frozen: FrozenRevision,
        workers: readonly RootRoleBinding[],
      ) => Promise<{
        activated: readonly { role: RootRoleBinding }[]
        blockers: ReadonlyMap<string, NonNullable<RoleState['activationBlocker']>>
      }>
    }).activateRolesForControl

    const result = await activate.call(
      receiver,
      { id: SessionId('controller') } as Agent,
      { roles } as RuntimeState,
      { manifest: { lanes: [] } } as unknown as FrozenRevision,
      workers,
    )

    expect(result.activated.map(value => value.role.role_id)).toEqual([
      'lane-a-method',
      'ops',
    ])
    expect(result.blockers.get('lane-a-coder')).toEqual({
      code: 'ROLE_ACTIVATION_FAILED',
      message: 'coder Session API failed',
    })
    expect(result.blockers.get('lane-b-method')).toEqual({
      code: 'WORKTREE_PROVISION_FAILED',
      message: 'lane-b worktree is unavailable',
    })
    expect(activatedCalls).toEqual(['lane-a-method', 'lane-a-coder', 'ops'])
    expect(reconciledPartial).toBe(true)
  })

  it('does not create or freeze a role identity when persistence discovery fails', async () => {
    const labDirectory = await mkdtemp(join(tmpdir(), 'autolab-persistence-failure-'))
    const ops = {
      role_id: 'ops',
      role_kind: 'ops',
      prebound_session_id: 'session-ops',
      prompt_sha256: rolePromptFor('ops').sha256,
      dsh_preset: 'workspace-write',
      model_route: { provider: 'provider', model: 'model' },
    } as RootRoleBinding
    const receiver = {
      ctx: { agents: { get: () => undefined } },
      roleHandles: new Map(),
      borrowedRoleAgents: new Map(),
      requireAgentPresets: () => ({ resolve: async () => ({ id: 'standard' }) }),
    }
    const activate = (AutoLabRuntime.prototype as unknown as {
      activateRole: (input: unknown) => Promise<unknown>
    }).activateRole

    try {
      await expect(activate.call(receiver, {
        state: {
          labId: 'lab-persistence-test',
          runtimeRevision: 1,
          updatedAt: 1,
          roles: { ops: { sessionId: 'session-ops', phase: 'starting' } },
        },
        frozen: {
          ref: { manifestHash: HASH },
          manifest: {
            roles: [ops],
            lanes: [],
            repository: { path: labDirectory },
            authority_paths: { lab_dir: labDirectory },
          },
        },
        role: ops,
        persistenceFailure: 'session index unavailable',
      })).rejects.toMatchObject({ code: 'ROLE_ACTIVATION_UNAVAILABLE' })
      await expect(readRoleBinding(labDirectory, 'ops')).resolves.toBeUndefined()
    } finally {
      await rm(labDirectory, { recursive: true, force: true })
    }
  })

  it('rejects activation-blocked callers, capabilities, and a new review Judge', async () => {
    const caller = {
      id: SessionId('method-session'),
      session: {
        events: [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }],
      },
    } as unknown as Agent
    const activationBlocker = {
      code: 'ROLE_ACTIVATION_FAILED' as const,
      message: 'method Session unavailable',
    }
    const capability = {
      configRevision: 1,
      workerRoleId: 'method',
      workerSessionId: 'method-session',
      judgeRoleId: 'judge',
      judgeSessionId: 'judge-session',
      request: { controlId: 'request-control' },
      acceptedPause: { controlId: 'pause-control' },
    }
    const state = {
      labId: 'lab-review-test',
      config: { revision: 1 },
      roles: {
        method: { sessionId: 'method-session', phase: 'reviewing', activationBlocker },
        judge: { sessionId: 'judge-session', phase: 'declared' },
      },
      reviews: { review: { capability } },
    } as unknown as RuntimeState
    const roleKey = `${state.labId}\0method`
    const receiver = {
      ctx: { agents: { get: () => caller } },
      view: new Map([[state.labId, state]]),
      roleHandles: new Map([[roleKey, { agent: caller, sessionId: caller.id }]]),
      borrowedRoleAgents: new Map(),
    }
    const prototype = AutoLabRuntime.prototype as unknown as {
      resolveExactRoleCaller: (caller: Agent) => unknown
      resolveReviewCapability: (controlId: string) => unknown
    }

    expect(() => prototype.resolveExactRoleCaller.call(receiver, caller))
      .toThrow(expect.objectContaining({ code: 'ROLE_ACTIVATION_UNAVAILABLE' }))
    expect(prototype.resolveReviewCapability.call(receiver, 'request-control')).toBeUndefined()

    state.roles.method = { sessionId: 'method-session', phase: 'reviewing' } as RoleState
    state.roles.judge = {
      sessionId: 'judge-session',
      phase: 'declared',
      activationBlocker: {
        code: 'ROLE_ACTIVATION_FAILED',
        message: 'judge Session unavailable',
      },
    } as RoleState
    expect(prototype.resolveReviewCapability.call(receiver, 'request-control')).toBeUndefined()

    const ref = {
      revision: 1,
      specHash: HASH,
      configHash: HASH,
      manifestHash: HASH,
      dialogueHeadHash: HASH,
      revisionPath: '/lab/revisions/000001',
    }
    const submitState = {
      labId: 'lab-20260815-120000-1234abcd',
      lifecycle: 'running',
      config: ref,
      roles: {
        method: {
          sessionId: 'method-session',
          phase: 'working',
          binding: { path: '/binding', hash: HASH },
          packet: { path: '/packet', hash: HASH },
          goalInstall: { status: 'applied' },
        },
        judge: {
          sessionId: 'judge-session',
          phase: 'declared',
          activationBlocker: {
            code: 'ROLE_ACTIVATION_FAILED',
            message: 'judge Session unavailable',
          },
        },
      },
      reviews: {},
    } as unknown as RuntimeState
    const submitReceiver = {
      enqueue: async (_labId: string, operation: () => Promise<unknown>) => await operation(),
      resolveExactRoleCaller: () => ({ state: submitState, roleId: 'method' }),
      artifacts: {
        readCurrent: async () => ({
          ref,
          manifest: {
            roles: [{ role_id: 'method', role_kind: 'method', lane_id: 'lane-a' }],
            lanes: [{
              lane_id: 'lane-a',
              method_role_id: 'method',
              preflight_judge_role_id: 'judge',
            }],
          },
        }),
      },
    }
    await expect(AutoLabRuntime.prototype.submitMethodForPreflightReview.call(
      submitReceiver as unknown as AutoLabRuntime,
      caller,
    )).rejects.toMatchObject({ code: 'ROLE_ACTIVATION_UNAVAILABLE' })
  })

  it('stops pause recovery when any role activation remains blocked', async () => {
    const ref = {
      revision: 1,
      specHash: HASH,
      configHash: HASH,
      manifestHash: HASH,
      dialogueHeadHash: HASH,
      revisionPath: '/lab/revisions/000001',
    }
    const worker = role('ops', 'ops')
    let current = {
      labId: 'lab-20260815-120000-1234abcd',
      controllerSessionId: 'controller',
      lifecycle: 'running',
      config: ref,
      roles: { ops: { sessionId: 'session-ops', phase: 'starting' } },
    } as unknown as RuntimeState
    const receiver = {
      enqueue: async (_labId: string, operation: () => Promise<RuntimeState>) => await operation(),
      requireState: () => current,
      assertControllerSession: () => undefined,
      hasAttachedRoleSet: () => false,
      artifacts: {
        readCurrent: async () => ({ ref, manifest: { roles: [worker] } }),
      },
      activateRolesForControl: async () => ({
        activated: [],
        blockers: new Map([[
          'ops',
          { code: 'ROLE_ACTIVATION_FAILED', message: 'ops Session unavailable' },
        ]]),
      }),
      transition: async (
        state: RuntimeState,
        lifecycle: RuntimeState['lifecycle'],
        blocker?: RuntimeState['blocker'] | null,
      ) => {
        current = {
          ...state,
          lifecycle,
          ...(blocker == null ? {} : { blocker }),
        }
        return current
      },
    }
    const pause = AutoLabRuntime.prototype.pause
    const result = await pause.call(
      receiver as unknown as AutoLabRuntime,
      { id: SessionId('controller') } as Agent,
      current.labId,
    )

    expect(result).toMatchObject({
      lifecycle: 'blocked',
      blocker: {
        code: 'SESSION_RECOVERY_FAILED',
        message: 'ops: ops Session unavailable',
      },
    })
  })
})

function role(
  roleId: string,
  roleKind: RootRoleBinding['role_kind'],
  laneId?: string,
): RootRoleBinding {
  const common = {
    role_id: roleId,
    role_kind: roleKind,
    prebound_session_id: `session-${roleId}`,
  }
  if (roleKind === 'ops') return common as RootRoleBinding
  return { ...common, lane_id: laneId } as RootRoleBinding
}
