import type { Context } from '@deepseek-ai/cordis'
import {
  assembleContextFor,
  installModelSelection,
  type Agent,
  type AgentHandle,
} from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'

import type { ResolvedManifest } from './manifest.js'
import {
  ROLE_KERNEL_ORDER,
  ROLE_KERNEL_SECTION,
  resolveRootRoleSessionSpec,
  type RootRoleKind,
} from './roles.js'

type RoleManifest = Pick<ResolvedManifest, 'roles' | 'lanes' | 'repository'>

export interface RootRoleSessionInput {
  readonly manifest: RoleManifest
  readonly roleId: string
  readonly sessionId: string
  /** DSH agent-composition preset. This is distinct from the role's permission preset. */
  readonly agentPresetId?: string
  readonly signal?: AbortSignal
}

export interface RootRoleSessionHandle extends AgentHandle {
  readonly roleId: string
  readonly roleKind: RootRoleKind
  readonly sessionId: ReturnType<typeof SessionId>
  readonly cwd: string
  readonly agentPresetId: string
  readonly permissionPresetId: string
}

export class AutoLabRoleSessionError extends Error {
  readonly name = 'AutoLabRoleSessionError'

  constructor(
    message: string,
    readonly code:
      | 'AGENT_PRESETS_UNAVAILABLE'
      | 'PERMISSION_PRESETS_UNAVAILABLE'
      | 'SESSION_WRITER_UNAVAILABLE'
      | 'SYSTEM_PROMPT_UNAVAILABLE'
      | 'SESSION_ALREADY_LIVE'
      | 'PREBOUND_SESSION_MISMATCH'
      | 'SESSION_ID_MISMATCH'
      | 'SESSION_CWD_MISMATCH'
      | 'AGENT_PRESET_MISSING'
      | 'AGENT_PRESET_MISMATCH'
      | 'PERMISSION_PRESET_MISMATCH'
      | 'MODEL_ROUTE_MISMATCH'
      | 'MODEL_SELECTION_NOT_EFFECTIVE'
      | 'TOOL_SCOPE_MISMATCH'
      | 'ROLE_KERNEL_NOT_EFFECTIVE',
  ) {
    super(message)
  }
}

interface AgentPresetRef {
  readonly id: string
}

interface NativeAgentPresets {
  resolve(id?: string): Promise<AgentPresetRef>
  mount(agentCtx: Context, id?: string): Promise<AgentPresetRef>
}

interface NativePermissionPresets {
  resolve(name: string): unknown
  current(events: Session['events']): string
  set(session: Session, name: string): void
}

interface NativeSessionWriterLease {
  release(): Promise<void>
}

interface NativeSessionMessaging {
  reserveSessionWriter(sessionId: ReturnType<typeof SessionId>): Promise<NativeSessionWriterLease>
}

interface NativeSystemPrompt {
  section(section: {
    readonly name: string
    readonly order: number
    readonly text: string
  }): () => void
  assemble(context: ReturnType<typeof assembleContextFor>): Promise<{
    readonly sections: readonly { readonly name: string; readonly text: string }[]
    readonly variables: Readonly<Record<string, unknown>>
  }>
}

/** Create a genuinely new root-role Session under the exact supplied SessionId. */
export async function createRootRoleSession(
  ctx: Context,
  input: RootRoleSessionInput,
): Promise<RootRoleSessionHandle> {
  const spec = resolveRootRoleSessionSpec(input.manifest, input.roleId)
  assertPreboundSession(spec.role, input.sessionId)
  const sessionId = SessionId(input.sessionId)
  assertNotLive(ctx, sessionId)

  const presets = requireAgentPresets(ctx)
  const permissions = requirePermissionPresets(ctx)
  permissions.resolve(spec.role.dsh_preset)

  // Resolve before Session creation so the exact identity recorded in the
  // immutable header is the composition that setup will really mount.
  const resolvedPreset = await presets.resolve(input.agentPresetId)
  const writer = await reserveSessionWriter(ctx, sessionId)
  try {
    const handle = await ctx.agents.create({
      sessionId,
      // An explicit empty seed gives DSH a durable initialization boundary. Its
      // permission-preset listener then preserves setup-applied permission facts
      // instead of replacing an otherwise blank Session with a later user default.
      seed: [],
      meta: {
        cwd: spec.cwd,
        agentPreset: resolvedPreset.id,
      },
      agentOptions: {
        provider: spec.role.model_route.provider,
        model: spec.role.model_route.model,
      },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      setup: async agentCtx => {
        const agent = requireSetupAgent(agentCtx)
        assertAgentIdentity(agent, sessionId, spec.cwd, spec.role.model_route)
        const mounted = await presets.mount(agentCtx, resolvedPreset.id)
        if (mounted.id !== resolvedPreset.id) {
          throw new AutoLabRoleSessionError(
            `agent preset mount returned ${JSON.stringify(mounted.id)} for resolved preset ${JSON.stringify(resolvedPreset.id)}`,
            'AGENT_PRESET_MISMATCH',
          )
        }
        installRoleRuntime(agentCtx, spec.role)
        permissions.set(agent.session, spec.role.dsh_preset)
        if (permissions.current(agent.session.events) !== spec.role.dsh_preset) {
          throw new AutoLabRoleSessionError(
            `permission preset ${JSON.stringify(spec.role.dsh_preset)} was not applied to Session ${JSON.stringify(String(sessionId))}`,
            'PERMISSION_PRESET_MISMATCH',
          )
        }
        await installAndVerifyKernel(agentCtx, agent, spec.kernel.text)
        await assertModelSelection(agentCtx, agent, spec.role.model_route)
      },
    })

    if (permissions.current(handle.agent.session.events) !== spec.role.dsh_preset) {
      await handle.dispose()
      throw new AutoLabRoleSessionError(
        `Session ${JSON.stringify(String(sessionId))} published without permission preset ${JSON.stringify(spec.role.dsh_preset)}`,
        'PERMISSION_PRESET_MISMATCH',
      )
    }

    return ownedRoleHandle(handle, writer, {
      roleId: spec.role.role_id,
      roleKind: spec.role.role_kind,
      sessionId,
      cwd: spec.cwd,
      agentPresetId: resolvedPreset.id,
      permissionPresetId: spec.role.dsh_preset,
    })
  } catch (error) {
    await writer.release().catch(() => undefined)
    throw error
  }
}

/**
 * Resume the exact persisted root-role Session. This path never calls create
 * and never substitutes a fresh Session when persistence rejects or is absent.
 */
export async function resumeRootRoleSession(
  ctx: Context,
  input: RootRoleSessionInput,
): Promise<RootRoleSessionHandle> {
  const spec = resolveRootRoleSessionSpec(input.manifest, input.roleId)
  assertPreboundSession(spec.role, input.sessionId)
  const sessionId = SessionId(input.sessionId)
  assertNotLive(ctx, sessionId)

  const presets = requireAgentPresets(ctx)
  const permissions = requirePermissionPresets(ctx)
  permissions.resolve(spec.role.dsh_preset)

  const writer = await reserveSessionWriter(ctx, sessionId)
  try {
    let mountedPresetId: string | undefined
    const handle = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: {
        provider: spec.role.model_route.provider,
        model: spec.role.model_route.model,
      },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      setup: async agentCtx => {
        const agent = requireSetupAgent(agentCtx)
        assertAgentIdentity(agent, sessionId, spec.cwd, spec.role.model_route)
        const storedPresetId = agent.session.header.agentPreset
        if (storedPresetId === undefined) {
          throw new AutoLabRoleSessionError(
            `persisted Session ${JSON.stringify(String(sessionId))} has no agent preset identity`,
            'AGENT_PRESET_MISSING',
          )
        }
        if (input.agentPresetId !== undefined && input.agentPresetId !== storedPresetId) {
          throw new AutoLabRoleSessionError(
            `persisted Session ${JSON.stringify(String(sessionId))} uses agent preset ${JSON.stringify(storedPresetId)}, not ${JSON.stringify(input.agentPresetId)}`,
            'AGENT_PRESET_MISMATCH',
          )
        }
        const mounted = await presets.mount(agentCtx, storedPresetId)
        if (mounted.id !== storedPresetId) {
          throw new AutoLabRoleSessionError(
            `agent preset mount returned ${JSON.stringify(mounted.id)} for persisted preset ${JSON.stringify(storedPresetId)}`,
            'AGENT_PRESET_MISMATCH',
          )
        }
        mountedPresetId = storedPresetId

        installRoleRuntime(agentCtx, spec.role)

        // Permission selection is durable Session state. Resume verifies it; it
        // does not silently rewrite an old role under a new permission bundle.
        const currentPermission = permissions.current(agent.session.events)
        if (currentPermission !== spec.role.dsh_preset) {
          throw new AutoLabRoleSessionError(
            `persisted Session ${JSON.stringify(String(sessionId))} uses permission preset ${JSON.stringify(currentPermission)}, not ${JSON.stringify(spec.role.dsh_preset)}`,
            'PERMISSION_PRESET_MISMATCH',
          )
        }
        await installAndVerifyKernel(agentCtx, agent, spec.kernel.text)
        await assertModelSelection(agentCtx, agent, spec.role.model_route)
      },
    })

    if (mountedPresetId === undefined) {
      await handle.dispose()
      throw new AutoLabRoleSessionError(
        `persisted Session ${JSON.stringify(String(sessionId))} published without a mounted agent preset`,
        'AGENT_PRESET_MISSING',
      )
    }
    return ownedRoleHandle(handle, writer, {
      roleId: spec.role.role_id,
      roleKind: spec.role.role_kind,
      sessionId,
      cwd: spec.cwd,
      agentPresetId: mountedPresetId,
      permissionPresetId: spec.role.dsh_preset,
    })
  } catch (error) {
    await writer.release().catch(() => undefined)
    throw error
  }
}

/**
 * Verify a live Agent that is owned elsewhere before borrowing it. This never
 * mutates or disposes the Agent; every checked property is already observable
 * from its DSH Session or scoped runtime.
 */
export async function verifyBorrowedRootRoleSession(
  ctx: Context,
  input: RootRoleSessionInput,
  agent: Agent,
): Promise<void> {
  const spec = resolveRootRoleSessionSpec(input.manifest, input.roleId)
  assertPreboundSession(spec.role, input.sessionId)
  const sessionId = SessionId(input.sessionId)
  if (ctx.agents.get(sessionId) !== agent) {
    throw new AutoLabRoleSessionError(
      `Session ${JSON.stringify(String(sessionId))} is not the exact live Agent in the DSH registry`,
      'SESSION_ID_MISMATCH',
    )
  }
  assertAgentIdentity(agent, sessionId, spec.cwd, spec.role.model_route)
  const expectedPreset = input.agentPresetId
  if (expectedPreset === undefined || agent.session.header.agentPreset !== expectedPreset) {
    throw new AutoLabRoleSessionError(
      `live Session ${JSON.stringify(String(sessionId))} does not use the frozen agent preset ${JSON.stringify(expectedPreset)}`,
      'AGENT_PRESET_MISMATCH',
    )
  }
  const permissions = requirePermissionPresets(ctx)
  if (permissions.current(agent.session.events) !== spec.role.dsh_preset) {
    throw new AutoLabRoleSessionError(
      `live Session ${JSON.stringify(String(sessionId))} does not use permission preset ${JSON.stringify(spec.role.dsh_preset)}`,
      'PERMISSION_PRESET_MISMATCH',
    )
  }
  await assertKernel(agent.ctx, agent, spec.kernel.text)
  await assertModelSelection(agent.ctx, agent, spec.role.model_route)
  assertToolScope(ctx, agent, spec.role.allowed_tools)
}

function installRoleRuntime(
  agentCtx: Context,
  role: ReturnType<typeof resolveRootRoleSessionSpec>['role'],
): void {
  installModelSelection(agentCtx, {
    current: {
      provider: role.model_route.provider,
      model: role.model_route.model,
      ...(role.reasoning.mode === 'default'
        ? {}
        : { reasoningEffort: ReasoningEffortId(role.reasoning.mode) }),
    },
    assembled: undefined,
  })
  try {
    agentCtx.tools.restrict({ allow: role.allowed_tools })
  } catch (error) {
    throw new AutoLabRoleSessionError(
      `role ${JSON.stringify(role.role_id)} tool scope is invalid: ${renderError(error)}`,
      'TOOL_SCOPE_MISMATCH',
    )
  }
}

async function installAndVerifyKernel(
  agentCtx: Context,
  agent: Agent,
  text: string,
): Promise<void> {
  const systemPrompt = agentCtx.get('systemPrompt', false) as NativeSystemPrompt | undefined
  if (systemPrompt === undefined) {
    throw new AutoLabRoleSessionError(
      'DSH system-prompt service is unavailable in Agent setup',
      'SYSTEM_PROMPT_UNAVAILABLE',
    )
  }
  systemPrompt.section({
    name: ROLE_KERNEL_SECTION,
    order: ROLE_KERNEL_ORDER,
    text,
  })
  const assembled = await systemPrompt.assemble(assembleContextFor(agent))
  const effective = assembled.sections.find(section => section.name === ROLE_KERNEL_SECTION)
  if (effective?.text !== text) {
    throw new AutoLabRoleSessionError(
      `role kernel ${JSON.stringify(ROLE_KERNEL_SECTION)} is not effective in Session ${JSON.stringify(String(agent.id))}`,
      'ROLE_KERNEL_NOT_EFFECTIVE',
    )
  }
}

async function assertKernel(
  agentCtx: Context,
  agent: Agent,
  text: string,
): Promise<void> {
  const systemPrompt = requireSystemPrompt(agentCtx)
  const assembled = await systemPrompt.assemble(assembleContextFor(agent))
  const effective = assembled.sections.find(section => section.name === ROLE_KERNEL_SECTION)
  if (effective?.text !== text) {
    throw new AutoLabRoleSessionError(
      `role kernel ${JSON.stringify(ROLE_KERNEL_SECTION)} is not effective in Session ${JSON.stringify(String(agent.id))}`,
      'ROLE_KERNEL_NOT_EFFECTIVE',
    )
  }
}

async function assertModelSelection(
  agentCtx: Context,
  agent: Agent,
  route: { readonly provider: string; readonly model: string },
): Promise<void> {
  const assembled = await requireSystemPrompt(agentCtx).assemble(assembleContextFor(agent))
  if (assembled.variables.provider !== route.provider
    || assembled.variables.model !== route.model) {
    throw new AutoLabRoleSessionError(
      `Session ${JSON.stringify(String(agent.id))} model selection is not effective in prompt assembly`,
      'MODEL_SELECTION_NOT_EFFECTIVE',
    )
  }
}

function assertToolScope(ctx: Context, agent: Agent, allowedTools: readonly string[]): void {
  const allowed = new Set(allowedTools)
  for (const schema of ctx.tools.schemas()) {
    const globalDefinition = ctx.tools.get(schema.name)
    const scopedDefinition = ctx.tools.get(schema.name, agent)
    if (allowed.has(schema.name)) {
      if (scopedDefinition === undefined) {
        throw new AutoLabRoleSessionError(
          `live Session ${JSON.stringify(String(agent.id))} is missing allowed tool ${JSON.stringify(schema.name)}`,
          'TOOL_SCOPE_MISMATCH',
        )
      }
    } else if (scopedDefinition === globalDefinition) {
      throw new AutoLabRoleSessionError(
        `live Session ${JSON.stringify(String(agent.id))} still inherits disallowed tool ${JSON.stringify(schema.name)}`,
        'TOOL_SCOPE_MISMATCH',
      )
    }
  }
}

function requireSystemPrompt(ctx: Context): NativeSystemPrompt {
  const systemPrompt = ctx.get('systemPrompt', false) as NativeSystemPrompt | undefined
  if (systemPrompt === undefined) {
    throw new AutoLabRoleSessionError(
      'DSH system-prompt service is unavailable in Agent setup',
      'SYSTEM_PROMPT_UNAVAILABLE',
    )
  }
  return systemPrompt
}

function assertAgentIdentity(
  agent: Agent,
  sessionId: ReturnType<typeof SessionId>,
  cwd: string,
  route: { readonly provider: string; readonly model: string },
): void {
  if (agent.id !== sessionId || agent.session.id !== sessionId) {
    throw new AutoLabRoleSessionError(
      `Agent factory did not preserve SessionId ${JSON.stringify(String(sessionId))}`,
      'SESSION_ID_MISMATCH',
    )
  }
  if (agent.session.header.cwd !== cwd) {
    throw new AutoLabRoleSessionError(
      `Session ${JSON.stringify(String(sessionId))} cwd is ${JSON.stringify(agent.session.header.cwd)}, expected ${JSON.stringify(cwd)}`,
      'SESSION_CWD_MISMATCH',
    )
  }
  if (agent.options.provider !== route.provider || agent.options.model !== route.model) {
    throw new AutoLabRoleSessionError(
      `Session ${JSON.stringify(String(sessionId))} model route does not match its role binding`,
      'MODEL_ROUTE_MISMATCH',
    )
  }
}

function assertNotLive(ctx: Context, sessionId: ReturnType<typeof SessionId>): void {
  if (ctx.agents.get(sessionId) !== undefined) {
    throw new AutoLabRoleSessionError(
      `Session ${JSON.stringify(String(sessionId))} is already live; only its existing owner handle may adopt it`,
      'SESSION_ALREADY_LIVE',
    )
  }
}

function assertPreboundSession(
  role: { readonly role_id: string; readonly prebound_session_id?: string | undefined },
  sessionId: string,
): void {
  if (role.prebound_session_id !== undefined && role.prebound_session_id !== sessionId) {
    throw new AutoLabRoleSessionError(
      `role ${JSON.stringify(role.role_id)} is prebound to SessionId ${JSON.stringify(role.prebound_session_id)}, not ${JSON.stringify(sessionId)}`,
      'PREBOUND_SESSION_MISMATCH',
    )
  }
}

function requireSetupAgent(agentCtx: Context): Agent {
  const agent = agentCtx.agent
  if (agent === undefined) {
    throw new AutoLabRoleSessionError(
      'Agent setup did not receive the unpublished scoped Agent',
      'SESSION_ID_MISMATCH',
    )
  }
  return agent
}

function requireAgentPresets(ctx: Context): NativeAgentPresets {
  const service = ctx.get('agentPresets', false) as NativeAgentPresets | undefined
  if (service === undefined) {
    throw new AutoLabRoleSessionError(
      'DSH agent-presets service is unavailable; role capabilities cannot be composed',
      'AGENT_PRESETS_UNAVAILABLE',
    )
  }
  return service
}

function requirePermissionPresets(ctx: Context): NativePermissionPresets {
  const service = ctx.get('permissionPresets', false) as NativePermissionPresets | undefined
  if (service === undefined) {
    throw new AutoLabRoleSessionError(
      'DSH permission-presets service is unavailable; role execution permission cannot be pinned',
      'PERMISSION_PRESETS_UNAVAILABLE',
    )
  }
  return service
}

function requireSessionMessaging(ctx: Context): NativeSessionMessaging {
  const service = ctx.get('sessionMessaging', false) as NativeSessionMessaging | undefined
  if (service === undefined || typeof service.reserveSessionWriter !== 'function') {
    throw new AutoLabRoleSessionError(
      'local Session messaging does not provide the persistence writer fence',
      'SESSION_WRITER_UNAVAILABLE',
    )
  }
  return service
}

async function reserveSessionWriter(
  ctx: Context,
  sessionId: ReturnType<typeof SessionId>,
): Promise<NativeSessionWriterLease> {
  return await requireSessionMessaging(ctx).reserveSessionWriter(sessionId)
}

function ownedRoleHandle(
  handle: AgentHandle,
  writer: NativeSessionWriterLease,
  metadata: Omit<RootRoleSessionHandle, keyof AgentHandle>,
): RootRoleSessionHandle {
  let disposed: Promise<void> | undefined
  return {
    ...metadata,
    agent: handle.agent,
    dispose: () => {
      disposed ??= (async () => {
        let agentFailure: unknown
        try {
          await handle.dispose()
        } catch (error) {
          agentFailure = error
        }
        try {
          await writer.release()
        } catch (writerFailure) {
          if (agentFailure !== undefined) {
            throw new AggregateError(
              [agentFailure, writerFailure],
              'failed to dispose the role Agent and release its Session writer fence',
            )
          }
          throw writerFailure
        }
        if (agentFailure !== undefined) throw agentFailure
      })()
      return disposed
    },
  }
}

function renderError(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
