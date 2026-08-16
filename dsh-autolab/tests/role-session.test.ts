import { Context } from '@deepseek-ai/cordis'
import { assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import {
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
  SessionPreparation,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'

import type { ResolvedManifest, RoleBinding } from '../src/manifest.js'
import {
  createRootRoleSession,
  resumeRootRoleSession,
  verifyBorrowedRootRoleSession,
  type RootRoleSessionHandle,
} from '../src/role-session.js'
import { ROLE_KERNEL_SECTION, roleKernelFor } from '../src/roles.js'
import { registerRoleToolFixtures } from './tool-fixtures.js'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'permission/preset': { preset: string }
  }
}

const HASH = 'a'.repeat(64)
const GIT_SHA = 'b'.repeat(40)
const REPOSITORY = '/tmp/autolab-role-sessions/repository'
const WORKTREE = '/tmp/autolab-role-sessions/lane-1'

interface NativeSeams {
  readonly agentPresets: {
    readonly resolve: ReturnType<typeof vi.fn>
    readonly mount: ReturnType<typeof vi.fn>
  }
  readonly permissionPresets: {
    readonly resolve: ReturnType<typeof vi.fn>
    readonly current: (events: readonly SessionEvent[]) => string
    readonly set: ReturnType<typeof vi.fn>
  }
  readonly writerReservations: string[]
}

function binding(
  roleKind: 'method' | 'coder',
  overrides: Partial<RoleBinding> = {},
): RoleBinding {
  return {
    role_id: `role-${roleKind}`,
    role_kind: roleKind,
    max_goal_rounds: roleKind === 'method' ? 64 : 48,
    lane_id: 'lane-1',
    worktree_path: WORKTREE,
    model_route: {
      route_id: `route-${roleKind}`,
      provider: `provider-${roleKind}`,
      model: `model-${roleKind}`,
      config: {},
    },
    fallback_routes: [],
    dsh_preset: roleKind === 'method' ? 'read-only' : 'workspace-write',
    reasoning: { mode: roleKind === 'method' ? 'high' : 'default', config: {} },
    allowed_tools: ['read'],
    prompt_sha256: roleKernelFor(roleKind).sha256,
    ...overrides,
  } as RoleBinding
}

function manifestView(
  roleBindings: RoleBinding[] = [binding('method'), binding('coder')],
): Pick<ResolvedManifest, 'roles' | 'lanes' | 'repository'> {
  return {
    roles: roleBindings,
    lanes: [{
      lane_id: 'lane-1',
      worktree_path: WORKTREE,
      base_ref: 'main',
      base_sha: GIT_SHA,
      method_role_id: 'role-method',
      coder_role_id: 'role-coder',
      preflight_judge_role_id: 'role-preflight',
      postflight_judge_role_id: 'role-postflight',
    }],
    repository: {
      path: REPOSITORY,
      base_ref: 'main',
      base_sha: GIT_SHA,
    },
  }
}

async function mountHarness(options: {
  readonly persisted?: Session
  readonly completePreset?: boolean
} = {}): Promise<{
  readonly ctx: Context
  readonly seams: NativeSeams
  readonly prepare?: ReturnType<typeof vi.fn>
}> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: 'global persona' } })
  registerRoleToolFixtures(ctx)

  const currentPermission = (events: readonly SessionEvent[]): string => {
    const selected = events.findLast(event => event.type === 'permission/preset')
    return selected?.type === 'permission/preset' ? selected.data.preset : 'workspace-write'
  }
  const agentPresets = {
    resolve: vi.fn(async (id?: string) => ({ id: id ?? 'standard' })),
    mount: vi.fn(async (agentCtx: Context, id?: string) => {
      const resolved = id ?? 'standard'
      const systemPrompt = agentCtx.get('systemPrompt') as {
        section(section: {
          name: string
          order: number
          text: string
          complete?: boolean
        }): void
      }
      systemPrompt.section({
        name: 'test:agent-preset',
        order: 1,
        text: `agent-preset:${resolved}`,
        ...(options.completePreset === true ? { complete: true } : {}),
      })
      return { id: resolved }
    }),
  }
  const permissionPresets = {
    resolve: vi.fn((name: string) => {
      if (!['read-only', 'workspace-write', 'danger-full-access'].includes(name)) {
        throw new Error(`unknown permission preset ${name}`)
      }
      return { name }
    }),
    current: currentPermission,
    set: vi.fn((session: Session, name: string) => {
      if (currentPermission(session.events) !== name) {
        session.append('permission/preset', { preset: name })
      }
    }),
  }
  ctx.provide('agentPresets', agentPresets)
  ctx.provide('permissionPresets', permissionPresets)
  const writerReservations: string[] = []
  ctx.provide('sessionMessaging', {
    reserveSessionWriter: vi.fn(async (id: ReturnType<typeof SessionId>) => {
      const sessionId = String(id)
      writerReservations.push(`reserve:${sessionId}`)
      let released = false
      return {
        sessionId: id,
        instanceId: 'test-instance',
        ownerToken: '00000000-0000-4000-8000-000000000901',
        fenceToken: 1,
        release: async () => {
          if (released) return
          released = true
          writerReservations.push(`release:${sessionId}`)
        },
      }
    }),
  })

  let prepare: ReturnType<typeof vi.fn> | undefined
  if (options.persisted !== undefined) {
    prepare = vi.fn(async (id: ReturnType<typeof SessionId>) => {
      writerReservations.push(`prepare:${String(id)}`)
      if (id !== options.persisted!.id) throw new Error(`persisted Session ${id} not found`)
      return SessionPreparation.create(options.persisted!)
    })
    ctx.provide('sessionPersistence', { prepare })
  }

  await ctx.plugin(AgentLoop, { agents: [] })
  return {
    ctx,
    seams: { agentPresets, permissionPresets, writerReservations },
    ...(prepare === undefined ? {} : { prepare }),
  }
}

async function promptSections(ctx: Context, agent?: Agent): Promise<readonly {
  readonly name: string
  readonly text: string
}[]> {
  const systemPrompt = ctx.get('systemPrompt') as {
    assemble(context?: ReturnType<typeof assembleContextFor>): Promise<{
      sections: readonly { name: string; text: string }[]
    }>
  }
  return (await systemPrompt.assemble(agent === undefined ? undefined : assembleContextFor(agent))).sections
}

async function disposeAll(ctx: Context, handles: RootRoleSessionHandle[]): Promise<void> {
  await Promise.allSettled(handles.splice(0).map(handle => handle.dispose()))
  await ctx.fiber.dispose()
}

describe('DSH-native AutoLab root role Session activation', () => {
  it('creates exact scoped idle Sessions without starting a turn or Goal', async () => {
    const mounted = await mountHarness()
    const handles: RootRoleSessionHandle[] = []
    try {
      const method = await createRootRoleSession(mounted.ctx, {
        manifest: manifestView(),
        roleId: 'role-method',
        sessionId: 'autolab-method-exact',
        agentPresetId: 'standard',
      })
      handles.push(method)
      const coder = await createRootRoleSession(mounted.ctx, {
        manifest: manifestView(),
        roleId: 'role-coder',
        sessionId: 'autolab-coder-exact',
        agentPresetId: 'code',
      })
      handles.push(coder)

      expect(method).toMatchObject({
        roleId: 'role-method',
        roleKind: 'method',
        sessionId: 'autolab-method-exact',
        cwd: WORKTREE,
        agentPresetId: 'standard',
        permissionPresetId: 'read-only',
      })
      expect(method.agent.id).toBe(SessionId('autolab-method-exact'))
      expect(method.agent.session.id).toBe(SessionId('autolab-method-exact'))
      expect(method.agent.session.header).toMatchObject({
        cwd: WORKTREE,
        agentPreset: 'standard',
      })
      expect(method.agent.options).toMatchObject({
        provider: 'provider-method',
        model: 'model-method',
      })
      expect(mounted.seams.permissionPresets.current(method.agent.session.events)).toBe('read-only')
      expect(mounted.seams.writerReservations).toContain('reserve:autolab-method-exact')

      for (const handle of handles) {
        expect(handle.agent.status).toBe('idle')
        expect(handle.agent.session.events.some(event => event.type === 'turn/start')).toBe(false)
        expect(handle.agent.session.events.some(event => event.type === 'user/message')).toBe(false)
      }

      const methodSections = await promptSections(mounted.ctx, method.agent)
      const coderSections = await promptSections(mounted.ctx, coder.agent)
      const globalSections = await promptSections(mounted.ctx)
      expect(methodSections).toContainEqual({
        name: ROLE_KERNEL_SECTION,
        text: roleKernelFor('method').text,
      })
      expect(coderSections).toContainEqual({
        name: ROLE_KERNEL_SECTION,
        text: roleKernelFor('coder').text,
      })
      expect(methodSections).not.toContainEqual(expect.objectContaining({ text: roleKernelFor('coder').text }))
      expect(coderSections).not.toContainEqual(expect.objectContaining({ text: roleKernelFor('method').text }))
      expect(globalSections.some(section => section.name === ROLE_KERNEL_SECTION)).toBe(false)
      expect(mounted.ctx.tools.get('read', method.agent)).toBeDefined()
      expect(mounted.ctx.tools.get('exec', method.agent)).toBeUndefined()
      const selected = await method.agent.ctx.waterfall('agent/request', {
        agent: method.agent,
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
      }, async () => ({ provider: 'wrong-provider', model: 'wrong-model' }))
      expect(selected).toMatchObject({
        provider: 'provider-method',
        model: 'model-method',
        reasoningEffort: 'high',
      })
      await expect(verifyBorrowedRootRoleSession(mounted.ctx, {
        manifest: manifestView(),
        roleId: 'role-method',
        sessionId: method.sessionId,
        agentPresetId: 'standard',
      }, method.agent)).resolves.toBeUndefined()
      await expect(verifyBorrowedRootRoleSession(mounted.ctx, {
        manifest: manifestView(),
        roleId: 'role-method',
        sessionId: method.sessionId,
        agentPresetId: 'different-preset',
      }, method.agent)).rejects.toMatchObject({ code: 'AGENT_PRESET_MISMATCH' })
      expect(mounted.ctx.agents.get(method.sessionId)).toBe(method.agent)

      await method.dispose()
      handles.splice(handles.indexOf(method), 1)
      expect(mounted.ctx.agents.get(SessionId('autolab-method-exact'))).toBeUndefined()
      expect(mounted.seams.writerReservations).toContain('release:autolab-method-exact')
      expect(mounted.ctx.sessions.get(SessionId('autolab-method-exact'))).toBeUndefined()
      expect(mounted.ctx.agents.get(SessionId('autolab-coder-exact'))).toBe(coder.agent)
    } finally {
      await disposeAll(mounted.ctx, handles)
    }
  })

  it('resumes the exact persisted Session and re-applies its recorded composition', async () => {
    const sessionId = SessionId('autolab-method-resume')
    const persisted = Session.create(sessionId, undefined, {
      version: SESSION_FORMAT_VERSION,
      id: sessionId,
      createdAt: 1,
      cwd: WORKTREE,
      agentPreset: 'standard',
    })
    persisted.append('permission/preset', { preset: 'read-only' })
    const mounted = await mountHarness({ persisted })
    const handles: RootRoleSessionHandle[] = []
    try {
      const resumed = await resumeRootRoleSession(mounted.ctx, {
        manifest: manifestView(),
        roleId: 'role-method',
        sessionId,
        agentPresetId: 'standard',
      })
      handles.push(resumed)

      expect(mounted.prepare).toHaveBeenCalledOnce()
      expect(mounted.prepare).toHaveBeenCalledWith(sessionId, expect.any(AbortSignal))
      expect(mounted.seams.writerReservations.slice(0, 2)).toEqual([
        `reserve:${sessionId}`,
        `prepare:${sessionId}`,
      ])
      expect(resumed.agent.session).toBe(persisted)
      expect(resumed.agent.id).toBe(sessionId)
      expect(resumed.agent.session.header.cwd).toBe(WORKTREE)
      expect(resumed.agent.options).toMatchObject({
        provider: 'provider-method',
        model: 'model-method',
      })
      expect(mounted.seams.agentPresets.mount).toHaveBeenCalledWith(
        expect.any(Context),
        'standard',
      )
      expect(mounted.seams.permissionPresets.set).not.toHaveBeenCalled()
      expect(resumed.agent.status).toBe('idle')
      expect(resumed.agent.session.events.some(event => event.type === 'turn/start')).toBe(false)
      expect(await promptSections(mounted.ctx, resumed.agent)).toContainEqual({
        name: ROLE_KERNEL_SECTION,
        text: roleKernelFor('method').text,
      })
    } finally {
      await disposeAll(mounted.ctx, handles)
    }
  })

  it('never creates a replacement when exact resume is unavailable', async () => {
    const mounted = await mountHarness()
    try {
      await expect(resumeRootRoleSession(mounted.ctx, {
        manifest: manifestView(),
        roleId: 'role-method',
        sessionId: 'missing-persisted-session',
        agentPresetId: 'standard',
      })).rejects.toThrow('session persistence is not configured')
      expect(mounted.ctx.agents.get(SessionId('missing-persisted-session'))).toBeUndefined()
      expect(mounted.ctx.sessions.get(SessionId('missing-persisted-session'))).toBeUndefined()
    } finally {
      await mounted.ctx.fiber.dispose()
    }
  })

  it('enforces an explicitly prebound role SessionId before calling the factory', async () => {
    const mounted = await mountHarness()
    try {
      const prebound = binding('method', { prebound_session_id: 'bound-method-session' })
      await expect(createRootRoleSession(mounted.ctx, {
        manifest: manifestView([prebound, binding('coder')]),
        roleId: 'role-method',
        sessionId: 'different-method-session',
        agentPresetId: 'standard',
      })).rejects.toMatchObject({ code: 'PREBOUND_SESSION_MISMATCH' })
      expect(mounted.seams.agentPresets.resolve).not.toHaveBeenCalled()
      expect(mounted.ctx.agents.get(SessionId('different-method-session'))).toBeUndefined()
    } finally {
      await mounted.ctx.fiber.dispose()
    }
  })

  it('rolls creation back when the chosen agent preset suppresses the role kernel', async () => {
    const mounted = await mountHarness({ completePreset: true })
    try {
      await expect(createRootRoleSession(mounted.ctx, {
        manifest: manifestView(),
        roleId: 'role-method',
        sessionId: 'suppressed-role-kernel',
        agentPresetId: 'minimal-like',
      })).rejects.toMatchObject({ code: 'ROLE_KERNEL_NOT_EFFECTIVE' })
      expect(mounted.ctx.agents.get(SessionId('suppressed-role-kernel'))).toBeUndefined()
      expect(mounted.ctx.sessions.get(SessionId('suppressed-role-kernel'))).toBeUndefined()
      expect(mounted.seams.writerReservations).toEqual([
        'reserve:suppressed-role-kernel',
        'release:suppressed-role-kernel',
      ])
    } finally {
      await mounted.ctx.fiber.dispose()
    }
  })
})
