import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { Context } from '@deepseek-ai/cordis'
import { assembleContextFor, type Agent, type AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import GoalService, { type GoalView } from '@deepseek-ai/dsh-goal'
import type { LlmFailure, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { FrozenRevision } from '../src/artifacts.js'
import {
  freezeAttemptReceiptArtifact,
  freezeAttemptStateArtifact,
  readLocalAttemptIntent,
} from '../src/attempt-artifacts.js'
import {
  prepareInitialLocalAttempt,
  prepareRetryLocalAttempt,
} from '../src/attempt-launch.js'
import type { AttemptRuntimeConsumer, AttemptRuntimeResult } from '../src/attempt-runtime.js'
import AutoLabRuntime, { type Config } from '../src/index.js'
import {
  CONTROLLER_KERNEL_SECTION,
} from '../src/controller-surface.js'
import { sha256 } from '../src/integrity.js'
import { parseRolePacket } from '../src/packet.js'
import { METHOD_SOURCE_PREFLIGHT_VERDICT_ARTIFACT_ID } from '../src/role-assignment.js'
import { ROLE_KERNEL_SECTION, roleKernelFor, type RootRoleKind } from '../src/roles.js'
import {
  activeReviewSchema,
  activeTrialSchema,
  transitionRuntimeState,
  type ActiveCandidate,
  type ActiveTrial,
  type ControllerGoalState,
  type RuntimeState,
} from '../src/state.js'
import {
  compileAttemptCompletionReceipt,
  recordAttemptCompletion,
} from '../src/trial.js'
import { registerRoleToolFixtures } from './tool-fixtures.js'

interface MountedController {
  readonly ctx: Context
  readonly persistence: JsonlSessionPersistence
  readonly autolabRoot: string
  readonly messagingFaults: {
    permissionReads: number
  }
}

const roots: string[] = []
const execFileAsync = promisify(execFile)
const hash = (digit: string): string => digit.repeat(64)
const nativeRetryExhaustedPolicy: ResolvedRetryPolicy = Object.freeze({
  mode: 'normal',
  maxRetries: 2,
  retryableCodes: Object.freeze(['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
  initialDelayMs: 100,
  maxDelayMs: 1_000,
  jitterRatio: 0,
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function secureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-autolab-restart-'))
  await chmod(root, 0o700)
  roots.push(root)
  return root
}

function currentPermission(events: readonly SessionEvent[]): string {
  const selected = events.findLast(event => event.type === 'permission/preset')
  return selected?.type === 'permission/preset' ? selected.data.preset : 'workspace-write'
}

async function createController(ctx: Context, id: string): Promise<AgentHandle> {
  return await ctx.agents.create({ sessionId: SessionId(id) })
}

async function resumeController(ctx: Context, id: string): Promise<AgentHandle> {
  return await ctx.agents.resume({ resumeSessionId: SessionId(id) })
}

async function mountController(root: string, config: Partial<Config> = {}): Promise<MountedController> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'storage') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: '' } })
  registerRoleToolFixtures(ctx)

  // SessionStore must exist before the backend subscribes; the backend must
  // exist before AgentLoop can publish or resume any Agent Session.
  await ctx.plugin(JsonlSessionPersistence, {
    root: join(root, 'sessions'),
    compression: 'none',
    writeBatchMaxDelayMs: 1,
  })
  const persistence = ctx.sessionPersistence as JsonlSessionPersistence
  await ctx.plugin(GoalService, { defaultMaxGoalRounds: 4 })

  ctx.provide('agentPresets', {
    resolve: async (id?: string) => ({ id: id ?? 'standard' }),
    mount: async (_agentCtx: Context, id?: string) => ({ id: id ?? 'standard' }),
  })
  ctx.provide('permissionPresets', {
    resolve: (name: string) => ({ name }),
    current: currentPermission,
    set: (session: Session, name: string) => {
      if (currentPermission(session.events) !== name) {
        session.append('permission/preset', { preset: name })
      }
    },
  })
  const messagingFaults = { permissionReads: 0 }
  ctx.provide('sessionMessaging', {
    reserveSessionWriter: async (sessionId: ReturnType<typeof SessionId>) => ({
      sessionId,
      instanceId: 'restart-test-instance',
      ownerToken: '00000000-0000-4000-8000-000000000901',
      fenceToken: 1,
      release: async () => undefined,
    }),
    registerControlHandler: () => () => undefined,
    getPermissions: async (caller: Agent) => {
      if (messagingFaults.permissionReads > 0) {
        messagingFaults.permissionReads -= 1
        throw new Error('restart fixture permission read failed')
      }
      return {
        sessionId: caller.id,
        sendAllowed: true,
        receiveAllowed: true,
      }
    },
    setPermissions: async (caller: Agent, patch: {
      readonly sendAllowed?: boolean
      readonly receiveAllowed?: boolean
    }) => ({
      sessionId: caller.id,
      sendAllowed: patch.sendAllowed ?? true,
      receiveAllowed: patch.receiveAllowed ?? true,
    }),
    listBlockedPeers: async () => [],
    setPeerBlocked: async () => ({}),
  })
  // This recovery fixture never admits its GPU-backed non-local runner, but
  // the production Controller still requires the DSH subprocess capability.
  ctx.provide('subprocess', {
    resolveExecutable: async () => {
      throw new Error('restart fixture has no external executable calls')
    },
    spawn: () => {
      throw new Error('restart fixture did not expect a subprocess spawn')
    },
  } as unknown as Context['subprocess'])

  await ctx.plugin(AgentLoop, { agents: [] })
  const autolabRoot = config.root ?? join(root, 'autolab')
  await ctx.plugin(AutoLabRuntime, { root: autolabRoot })
  return { ctx, persistence, autolabRoot, messagingFaults }
}

async function sourceConfig(
  root: string,
  runnerAdapterId = 'local-runner',
): Promise<string> {
  const repository = join(root, 'repository')
  await mkdir(repository, { recursive: true })
  await execFileAsync('git', ['-C', repository, 'init', '--quiet', '--initial-branch=main'])
  await execFileAsync('git', ['-C', repository, 'config', 'user.name', 'AutoLab Test'])
  await execFileAsync('git', ['-C', repository, 'config', 'user.email', 'autolab@example.invalid'])
  await writeFile(join(repository, 'README.md'), '# Restart recovery fixture\n', 'utf8')
  await execFileAsync('git', ['-C', repository, 'add', 'README.md'])
  await execFileAsync('git', ['-C', repository, 'commit', '--quiet', '-m', 'initial'])

  const directory = join(root, 'source')
  const lane = {
    lane_id: 'lane-a',
    worktree_path: join(root, 'worktrees', 'lane-a'),
    base_ref: 'main',
    method_role_id: 'lane-a-method',
    coder_role_id: 'lane-a-coder',
    preflight_judge_role_id: 'lane-a-preflight',
    postflight_judge_role_id: 'lane-a-postflight',
    charter: {
      research_question: 'Does the candidate improve the frozen metric?',
      method_scope: 'Model method changes only.',
      initial_hypothesis_family: 'mechanism-a',
      inherited_facts: ['The baseline and evaluator are frozen.'],
      explicit_exclusions: ['Do not modify the evaluator.'],
    },
  }
  const commonRole = (roleId: string) => ({
    role_id: roleId,
    model_route: {
      route_id: `${roleId}-primary`,
      provider: 'test-provider',
      model: 'test-model',
      config: {},
    },
    fallback_routes: [],
    // The lightweight test seam defaults to workspace-write. Selecting a
    // different valid preset records one real event and materializes every
    // otherwise-idle role Session in the JSONL backend.
    dsh_preset: 'read-only',
    reasoning: { mode: 'high', config: {} },
    allowed_tools: ['read', 'exec'],
  })
  const roles = [
    { ...commonRole('controller'), role_kind: 'controller', max_goal_rounds: 64 },
    {
      ...commonRole('ops'),
      role_kind: 'ops',
      max_goal_rounds: 24,
      resource_domain: 'local',
    },
    {
      ...commonRole(lane.method_role_id),
      role_kind: 'method',
      max_goal_rounds: 64,
      lane_id: lane.lane_id,
    },
    {
      ...commonRole(lane.coder_role_id),
      role_kind: 'coder',
      max_goal_rounds: 48,
      lane_id: lane.lane_id,
    },
    {
      ...commonRole(lane.preflight_judge_role_id),
      role_kind: 'preflight_judge',
      lane_id: lane.lane_id,
    },
    {
      ...commonRole(lane.postflight_judge_role_id),
      role_kind: 'postflight_judge',
      lane_id: lane.lane_id,
    },
  ]
  const config = {
    schema_version: 1,
    repository: { path: repository, base_ref: 'main' },
    worktree_root: join(root, 'worktrees'),
    research: {
      objective: 'Improve the mechanism under the exact frozen contract.',
      primary_metric: 'score',
      metric_direction: 'maximize',
      formal_success_condition: 'Formal evaluator score exceeds the frozen baseline.',
      screening_vs_formal: 'Screening proposes candidates; only formal evaluation decides.',
      stop_condition: 'The Controller stops the Lab.',
    },
    contract: {
      hard_constraints: ['Keep the public interface unchanged.'],
      allowed_mutation_scope: ['src/model.ts'],
      forbidden_changes: ['Do not modify evaluator code.'],
      fixed_protocol: ['Use split-v1.'],
      baseline_refs: ['main'],
      formal_evidence_requirements: ['Retain the evaluator receipt.'],
    },
    search: {
      search_mode: 'sequential',
      coordinator_enabled: false,
      lanes: [lane],
    },
    roles,
    execution: {
      runner_adapter: { id: runnerAdapterId, version: '1', sha256: hash('1') },
      hosts: [{ host_id: 'local', runner_target: 'local' }],
      gpu_pool: [{ gpu_id: 'GPU-0', host_id: 'local' }],
      max_parallel_gpu_attempts: 1,
      contract: {
        protocol: {
          id: 'split-v1',
          dataset: 'dataset-v1',
          model: 'model-v1',
          environment: 'environment-v1',
          run_slots: [{ slot_id: 'primary' }],
        },
        experiment_command: 'node experiment.js',
        checkpoint_contract: 'Resume only an exact runner checkpoint.',
        progress_contract: 'Runner emits immutable progress receipts.',
      },
    },
    evidence: {
      contract: {
        evaluator: { id: 'evaluator', version: '1', sha256: hash('2') },
        metric_parser: { id: 'metric-parser', version: '1', sha256: hash('3') },
        comparator: { id: 'comparator', version: '1', sha256: hash('4') },
        control_policy: 'Compare against the frozen main baseline only.',
        observation_lens: 'score-and-runtime',
        query_target: 'formal-score',
        evidence_contract: 'Evaluator output is authoritative.',
      },
    },
    communication: {
      topology: 'lane_isolated',
      acl_revision: 1,
      coordinator_visibility: 'disabled',
      role_permissions: roles.map(role => ({
        role_id: role.role_id,
        send: true,
        receive: true,
      })),
      text_method_coder_within_lane: 'allowed',
      text_pair_blocks: [],
      reveal_policy: {
        initial_state: 'sealed',
        trigger: 'manual',
        text_cross_lane_before_reveal: 'blocked',
        text_cross_lane_after_reveal: 'allowed',
      },
      api_recovery: 'Retry transport failure without changing scientific state.',
      attempt_recovery: 'Adopt an exact live process before restart.',
      stop_pause_policy: 'Only the Controller changes Lab stop state.',
    },
    provenance: { '/research/objective': 'user' },
  }

  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'LAB_SPEC.md'), '# Exact restart recovery specification\n', 'utf8')
  await writeFile(join(directory, 'lab.yaml'), `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  return directory
}

function snapshotEvents(agent: Agent): readonly SessionEvent[] {
  return structuredClone(agent.session.events)
}

function snapshotGoal(goal: GoalView): GoalView {
  return structuredClone(goal)
}

async function roleKernelText(ctx: Context, agent: Agent): Promise<string | undefined> {
  const systemPrompt = ctx.get('systemPrompt') as {
    assemble(context: ReturnType<typeof assembleContextFor>): Promise<{
      sections: readonly { name: string; text: string }[]
    }>
  }
  const prompt = await systemPrompt.assemble(assembleContextFor(agent))
  return prompt.sections.find(section => section.name === ROLE_KERNEL_SECTION)?.text
}

async function controllerKernelText(ctx: Context, agent: Agent): Promise<string | undefined> {
  const systemPrompt = ctx.get('systemPrompt') as {
    assemble(context: ReturnType<typeof assembleContextFor>): Promise<{
      sections: readonly { name: string; text: string }[]
    }>
  }
  const prompt = await systemPrompt.assemble(assembleContextFor(agent))
  return prompt.sections.find(section => section.name === CONTROLLER_KERNEL_SECTION)?.text
}

const controllerToolNames = [
  'AutoLabRead',
  'AutoLabStatus',
  'AutoLabStart',
  'AutoLabPause',
  'AutoLabResume',
  'AutoLabStop',
      'AutoLabReveal',
      'AutoLabApplyPreflight',
      'AutoLabAssignMethod',
      'AutoLabAssignRole',
  'AutoLabLaunchAttempt',
  'AutoLabRetryAttempt',
  'AutoLabRequestPostflight',
  'AutoLabWait',
] as const

async function waitForControllerGoal(
  ctx: Context,
  agent: Agent,
  predicate: (goal: GoalView) => boolean,
): Promise<GoalView> {
  await vi.waitFor(() => {
    const goal = ctx.goals.get(agent)
    expect(goal).toBeDefined()
    expect(predicate(goal!)).toBe(true)
  })
  return snapshotGoal(ctx.goals.get(agent)!)
}

function apiRecoveryRecord(
  ctx: Context,
  sessionId: string,
): { readonly phase: string; readonly dueAt?: number } | undefined {
  const runtime = ctx.autolab as unknown as {
    readonly apiRecoveryStore?: {
      get(id: string): { readonly phase: string; readonly dueAt?: number } | undefined
    }
  }
  return runtime.apiRecoveryStore?.get(sessionId)
}

async function waitForControllerProjection(
  mounted: MountedController,
  controller: Agent,
  labId: string,
  predicate: (goal: ControllerGoalState) => boolean,
): Promise<void> {
  await vi.waitFor(() => {
    const projected = mounted.ctx.autolab.status(controller, labId).controllerGoal
    expect(projected).toBeDefined()
    expect(predicate(projected!)).toBe(true)
  })
}

async function drainControllerTasks(ctx: Context): Promise<void> {
  const runtime = ctx.autolab as unknown as {
    readonly controllerTasks: Set<Promise<void>>
  }
  for (let pass = 0; pass < 10 && runtime.controllerTasks.size > 0; pass += 1) {
    await Promise.allSettled([...runtime.controllerTasks])
  }
  expect(runtime.controllerTasks.size).toBe(0)
}

interface RuntimeTestInternals {
  readonly artifacts: {
    readCurrent(labId: string): Promise<FrozenRevision>
  }
  readonly table: KvTable<string, RuntimeState>
  readonly view: Map<string, RuntimeState>
  readonly attemptRuntime: AttemptRuntimeConsumer
  readonly attemptPoke: { readonly pointerPath: string }
  readonly reviewHolds: Map<string, { release(): Promise<void> }>
  replayRecordedReviewNotifications(state: RuntimeState): Promise<RuntimeState>
}

function runtimeInternals(ctx: Context): RuntimeTestInternals {
  return ctx.autolab as unknown as RuntimeTestInternals
}

async function persistRuntimeProjection(ctx: Context, state: RuntimeState): Promise<void> {
  const runtime = runtimeInternals(ctx)
  await runtime.table.put(state.labId, state)
  runtime.view.set(state.labId, state)
}

function matchingNoticeIds(agent: Agent, text: string): readonly string[] {
  const values: unknown[] = [
    ...agent.inbox.nextTurn,
    ...agent.inbox.nextStep,
    ...agent.session.events.flatMap(event => event.type === 'user/message' ? [event.data] : []),
  ]
  return [...new Set(values.flatMap(value => {
    if (typeof value !== 'object' || value === null) return []
    const record = value as { readonly id?: unknown }
    if (typeof record.id !== 'string' || !JSON.stringify(value).includes(text)) return []
    return [record.id]
  }))]
}

async function terminalFailedTrial(
  frozen: FrozenRevision,
  initial: Awaited<ReturnType<typeof prepareInitialLocalAttempt>>,
): Promise<ActiveTrial> {
  const attempt = initial.intent.attempt.value
  const receipt = compileAttemptCompletionReceipt({
    version: 1,
    type: 'attempt_completion',
    attempt_id: attempt.attempt_id,
    launch_nonce: attempt.launch_nonce,
    candidate_sha: attempt.candidate_sha,
    request_sha256: attempt.request.sha256,
    completed_at: attempt.launched_at,
    completion_identity: 'restart-fixture-technical-failure',
    technical_outcome: 'failed',
    technical_detail: { kind: 'runner', code: 'FIXTURE_FAILED' },
    artifacts: [],
  })
  const receiptArtifact = await freezeAttemptReceiptArtifact(
    frozen.manifest.execution.run_root,
    attempt.attempt_id,
    'completion',
    receipt,
  )
  const transition = recordAttemptCompletion(
    initial.intent.transition.state,
    initial.intent.transition.state.revision,
    attempt,
    receipt,
    receiptArtifact.path,
  )
  const artifact = await freezeAttemptStateArtifact(
    frozen.manifest.execution.run_root,
    transition.state.revision,
    transition.attempt,
  )
  const slot = initial.projection.runSlots['slot-a']
  if (slot?.activeAttempt === undefined) throw new Error('expected active fixture Attempt')
  return activeTrialSchema.parse({
    ...initial.projection,
    runSlots: {
      ...initial.projection.runSlots,
      'slot-a': {
        ...slot,
        state: transition.state,
        activeAttempt: {
          ...slot.activeAttempt,
          attemptId: transition.attempt.attempt_id,
          phase: transition.attempt.phase,
          path: artifact.path,
          hash: artifact.sha256,
        },
      },
    },
  })
}

interface RuntimeRetryFixture {
  readonly controller: Agent
  readonly labId: string
  readonly runtime: RuntimeTestInternals
  readonly frozen: FrozenRevision
  readonly initial: Awaited<ReturnType<typeof prepareInitialLocalAttempt>>
  readonly failed: ActiveTrial
  readonly activeProjection: RuntimeState
  readonly retryableProjection: RuntimeState
  readonly retryInput: {
    readonly labId: string
    readonly trialId: string
    readonly runSlotId: string
    readonly hostId: string
    readonly commandJson: string
    readonly envJson: string
  }
}

async function runtimeRetryFixture(
  mounted: MountedController,
  root: string,
  controllerSessionId: string,
): Promise<RuntimeRetryFixture> {
  const source = await sourceConfig(root, 'local-tmux')
  const controller = (await createController(mounted.ctx, controllerSessionId)).agent
  const created = await mounted.ctx.autolab.create(controller, source)
  await mounted.ctx.autolab.commit(controller, created.state.labId)
  const running = await mounted.ctx.autolab.start(controller, created.state.labId)
  const runtime = runtimeInternals(mounted.ctx)
  const frozen = await runtime.artifacts.readCurrent(created.state.labId)
  const coder = running.roles['lane-a-coder']!
  const candidate: ActiveCandidate = {
    version: 1,
    sourceRevision: frozen.ref.revision,
    laneId: 'lane-a',
    candidateId: 'candidate-retry-lineage',
    coderRoleId: 'lane-a-coder',
    coderSessionId: coder.sessionId,
    assignmentId: 'coder:fixture-retry-lineage',
    candidateSha: frozen.manifest.lanes[0]!.base_sha,
    captureReceipt: {
      path: join(root, 'candidate-retry-lineage.json'),
      hash: hash('9'),
    },
    frozenAt: running.updatedAt,
  }
  const initial = await prepareInitialLocalAttempt({
    frozen,
    candidate,
    laneId: 'lane-a',
    trialId: 'trial-retry-lineage',
    trialContract: { lab_defined: ['opaque', 'technical-retry-fixture'] },
    runSlots: [{ runSlotId: 'slot-a', contract: { seed: 11 } }],
    selectedRunSlotId: 'slot-a',
    hostId: 'local',
    command: ['node', '-e', 'process.exit(7)'],
    env: { AUTOLAB_FIXTURE: 'initial' },
    runtimePokeFile: runtime.attemptPoke.pointerPath,
    anchoredAt: running.updatedAt,
  })
  const failed = await terminalFailedTrial(frozen, initial)
  const activeProjection = transitionRuntimeState(running, {
    expectedRevision: running.runtimeRevision,
    ownerEpoch: running.ownerEpoch,
    lifecycle: running.lifecycle,
    candidates: { ...running.candidates, 'lane-a': candidate },
    trials: { ...running.trials, 'trial-retry-lineage': initial.projection },
  })
  const retryableProjection = transitionRuntimeState(activeProjection, {
    expectedRevision: activeProjection.runtimeRevision,
    ownerEpoch: activeProjection.ownerEpoch,
    lifecycle: activeProjection.lifecycle,
    trials: { ...activeProjection.trials, 'trial-retry-lineage': failed },
  })
  return {
    controller,
    labId: created.state.labId,
    runtime,
    frozen,
    initial,
    failed,
    activeProjection,
    retryableProjection,
    retryInput: {
      labId: created.state.labId,
      trialId: 'trial-retry-lineage',
      runSlotId: 'slot-a',
      hostId: 'local',
      commandJson: JSON.stringify(['node', '-e', 'process.exit(0)', '--retry']),
      envJson: JSON.stringify({ AUTOLAB_FIXTURE: 'retry' }),
    },
  }
}

type MethodTestVerdict = 'APPROVED' | 'REVISION_REQUIRED' | 'REJECTED' | 'REVIEW_ERROR'

interface RuntimeMethodFixture {
  readonly controller: Agent
  readonly labId: string
  readonly method: Agent
  readonly runtime: RuntimeTestInternals
  readonly frozen: FrozenRevision
  readonly projected: RuntimeState
  readonly reviewId?: string
  readonly verdictPath?: string
  readonly releaseHold: ReturnType<typeof vi.fn>
  readonly input: {
    readonly labId: string
    readonly methodRoleId: string
    readonly assignmentId: string
    readonly objective: string
    readonly contentJson: string
    readonly inputArtifactRefsJson: string
    readonly sourceReviewId?: string
  }
}

async function runtimeMethodFixture(
  mounted: MountedController,
  root: string,
  controllerSessionId: string,
  verdict?: MethodTestVerdict,
): Promise<RuntimeMethodFixture> {
  const source = await sourceConfig(root)
  const controller = (await createController(mounted.ctx, controllerSessionId)).agent
  const created = await mounted.ctx.autolab.create(controller, source)
  await mounted.ctx.autolab.commit(controller, created.state.labId)
  const running = await mounted.ctx.autolab.start(controller, created.state.labId)
  const runtime = runtimeInternals(mounted.ctx)
  const frozen = await runtime.artifacts.readCurrent(created.state.labId)
  const methodState = running.roles['lane-a-method']!
  const method = mounted.ctx.agents.get(SessionId(methodState.sessionId))!
  const goal = mounted.ctx.goals.get(method)!
  const paused = mounted.ctx.goals.pause(method, { id: goal.id, revision: goal.revision })
  const roles = structuredClone(running.roles)
  roles['lane-a-method'] = {
    ...methodState,
    phase: verdict === undefined ? 'paused' : 'reviewing',
    goalInstall: {
      ...methodState.goalInstall!,
      goalId: String(paused.id),
      goalRevision: paused.revision,
    },
  }

  const reviews = structuredClone(running.reviews)
  const reviewId = verdict === undefined ? undefined : `preflight-method-${verdict.toLowerCase()}`
  const verdictPath = reviewId === undefined
    ? undefined
    : join(root, 'not-read', reviewId, 'preflight-verdict.json')
  if (reviewId !== undefined && verdictPath !== undefined) {
    const judge = running.roles['lane-a-preflight']!
    const negotiatedAnchorHash = hash('6')
    const requestControlId = randomUUID()
    const acceptedControlId = randomUUID()
    const acceptedPayloadHash = `sha256:${hash('8')}`
    reviews[reviewId] = activeReviewSchema.parse({
      stage: 'preflight',
      phase: verdict === 'REVIEW_ERROR' ? 'error' : 'verdict_recorded',
      sourcePacket: methodState.packet,
      packetPath: judge.packet!.path,
      artifactPath: join(root, 'not-read', reviewId, 'method-ticket.json'),
      capability: {
        version: 1,
        reviewId,
        assignmentId: methodState.goalInstall!.assignmentId,
        configRevision: running.config!.revision,
        runtimeRevision: running.runtimeRevision,
        ownerFence: running.ownerEpoch,
        workerRoleId: 'lane-a-method',
        workerSessionId: methodState.sessionId,
        judgeRoleId: 'lane-a-preflight',
        judgeSessionId: judge.sessionId,
        packetHash: judge.packet!.hash,
        artifactHash: hash('5'),
        negotiatedAnchorHash,
        sourceTurn: 1,
        expectedGoalRef: { id: String(paused.id), revision: paused.revision },
        request: {
          controlId: requestControlId,
          payloadHash: `sha256:${hash('7')}`,
        },
        acceptedPause: {
          controlId: acceptedControlId,
          payloadHash: acceptedPayloadHash,
        },
      },
      pause: {
        controlId: acceptedControlId,
        payloadHash: acceptedPayloadHash,
        freeze: 'held',
        completedAt: running.updatedAt,
        goalOutcome: 'paused',
        activeTurn: true,
        observedTurn: 1,
        goalRef: { id: String(paused.id), revision: paused.revision },
        holdOwnerEpoch: running.ownerEpoch,
      },
      verdict: {
        path: verdictPath,
        hash: hash('9'),
        assignmentId: `preflight:${reviewId}`,
        reviewInputHash: negotiatedAnchorHash,
        topLevelVerdict: verdict,
        recordedAt: running.updatedAt,
      },
      createdAt: running.updatedAt,
      updatedAt: running.updatedAt,
    })
  }
  const projected = transitionRuntimeState(running, {
    expectedRevision: running.runtimeRevision,
    ownerEpoch: running.ownerEpoch,
    lifecycle: running.lifecycle,
    roles,
    reviews,
  })
  await persistRuntimeProjection(mounted.ctx, projected)

  const releaseHold = vi.fn(async () => {
    if (reviewId !== undefined) {
      expect(mounted.ctx.autolab.status(controller, created.state.labId).reviews[reviewId]?.resolution)
        .toBeDefined()
    }
  })
  if (reviewId !== undefined) {
    runtime.reviewHolds.set(`${created.state.labId}\0${reviewId}`, { release: releaseHold })
  }
  const assignmentId = `lane-a-method:controller:${verdict?.toLowerCase() ?? 'next'}`
  return {
    controller,
    labId: created.state.labId,
    method,
    runtime,
    frozen,
    projected,
    ...(reviewId === undefined ? {} : { reviewId, verdictPath: verdictPath! }),
    releaseHold,
    input: {
      labId: created.state.labId,
      methodRoleId: 'lane-a-method',
      assignmentId,
      objective: 'Produce the next exact Method Design Ticket from the selected direction.',
      contentJson: JSON.stringify({ lab_owned_method_request: ['opaque', assignmentId] }),
      inputArtifactRefsJson: JSON.stringify([{
        artifact_id: 'method-context',
        path: join(root, 'not-read', 'method-context.json'),
        sha256: hash('4'),
      }]),
      ...(reviewId === undefined ? {} : { sourceReviewId: reviewId }),
    },
  }
}

describe('AutoLab real JSONL restart recovery', () => {
  it('restores exact role Sessions and the same Method Goal without waking Judges', async () => {
    const root = await secureRoot()
    const source = await sourceConfig(root)
    const controllerSessionId = 'controller-restart'
    let first: MountedController | undefined
    let second: MountedController | undefined

    try {
      first = await mountController(root)
      const firstControllerHandle = await createController(first.ctx, controllerSessionId)
      const userController = firstControllerHandle.agent
      const created = await first.ctx.autolab.create(userController, source)
      await first.ctx.autolab.commit(userController, created.state.labId)
      const running = await first.ctx.autolab.start(userController, created.state.labId)

      const sessionIds = Object.fromEntries(Object.entries(running.roles).map(([roleId, role]) => [
        roleId,
        role.sessionId,
      ]))
      expect(Object.keys(sessionIds)).toHaveLength(5)

      const firstAgents = Object.fromEntries(Object.entries(sessionIds).map(([roleId, id]) => {
        const live = first!.ctx.agents.get(SessionId(id))
        expect(live).toBeDefined()
        return [roleId, live!]
      }))
      const firstHeaders = Object.fromEntries(Object.entries(firstAgents).map(([roleId, live]) => [
        roleId,
        structuredClone(live.session.header),
      ]))
      const firstOptions = Object.fromEntries(Object.entries(firstAgents).map(([roleId, live]) => [
        roleId,
        structuredClone(live.options),
      ]))
      const firstEvents = Object.fromEntries(Object.entries(firstAgents).map(([roleId, live]) => [
        roleId,
        snapshotEvents(live),
      ]))

      const firstControllerHeader = structuredClone(userController.session.header)
      const firstControllerEvents = snapshotEvents(userController)
      const firstControllerGoal = snapshotGoal(first.ctx.goals.get(userController)!)
      expect(running.controllerGoal).toMatchObject({
        status: 'applied',
        goalId: String(firstControllerGoal.id),
        goalRevision: firstControllerGoal.revision,
      })
      expect(firstControllerGoal).toMatchObject({
        phase: 'active',
        activation: 'armed',
        roundsStarted: 0,
        maxGoalRounds: 64,
      })
      expect(firstControllerGoal.objective).toContain(`Controller-Session-ID: "${controllerSessionId}"`)
      expect(await controllerKernelText(first.ctx, userController)).toContain(created.state.labId)
      for (const name of controllerToolNames) {
        expect(first.ctx.tools.get(name, userController)).toBeDefined()
        expect(first.ctx.tools.get(name)).toBeUndefined()
      }

      const persisted = await first.persistence.list()
      expect(persisted.map(header => String(header.id)).sort()).toEqual([
        controllerSessionId,
        ...Object.values(sessionIds),
      ].sort())
      for (const id of Object.values(sessionIds)) {
        const raw = await first.persistence.readRaw(SessionId(id))
        expect(raw?.content).toContain(`"id":"${id}"`)
        expect(raw?.content).toContain('"type":"permission/preset"')
      }

      const methodInstall = structuredClone(running.roles['lane-a-method']!.goalInstall!)
      const firstMethodGoal = snapshotGoal(first.ctx.goals.get(firstAgents['lane-a-method']!)!)
      expect(firstMethodGoal.objective).toContain(`AutoLab-Install-ID: "${methodInstall.installId}"`)
      expect(firstMethodGoal).toMatchObject({
        id: methodInstall.goalId,
        revision: methodInstall.goalRevision,
        phase: 'active',
        activation: 'armed',
        maxGoalRounds: 64,
      })

      const judgeIds = ['lane-a-preflight', 'lane-a-postflight'] as const
      for (const roleId of judgeIds) {
        expect(firstAgents[roleId]!.status).toBe('idle')
        expect(first.ctx.goals.get(firstAgents[roleId]!)).toBeUndefined()
        expect(firstEvents[roleId]!.some(event => event.type === 'turn/start')).toBe(false)
        expect(firstEvents[roleId]!.some(event => event.type === 'user/message')).toBe(false)
      }

      await first.ctx.fiber.dispose()
      first = undefined

      // A new Context with the same three durable roots models a full host/plugin
      // restart while avoiding a subprocess-only IPC fixture.
      second = await mountController(root)
      const secondControllerHandle = await resumeController(second.ctx, controllerSessionId)
      const resumedController = secondControllerHandle.agent
      await vi.waitFor(() => {
        expect(second!.ctx.autolab.status(resumedController, created.state.labId).controllerGoal?.status)
          .toBe('applied')
      })
      const restored = second.ctx.autolab.status(resumedController, created.state.labId)

      expect(restored.lifecycle).toBe('running')
      expect(restored.blocker).toBeUndefined()
      expect(String(resumedController.id)).toBe(controllerSessionId)
      expect(resumedController.session).not.toBe(userController.session)
      expect(resumedController.session.header).toMatchObject(firstControllerHeader)
      expect(resumedController.session.events.slice(0, firstControllerEvents.length)).toEqual(
        firstControllerEvents,
      )
      expect(await controllerKernelText(second.ctx, resumedController)).toContain(created.state.labId)
      for (const name of controllerToolNames) {
        expect(second.ctx.tools.get(name, resumedController)).toBeDefined()
        expect(second.ctx.tools.get(name)).toBeUndefined()
      }

      const restoredControllerGoal = await waitForControllerGoal(
        second.ctx,
        resumedController,
        goal => String(goal.id) === String(firstControllerGoal.id)
          && goal.phase === 'active'
          && goal.activation === 'armed',
      )
      expect(restoredControllerGoal).toMatchObject({
        id: firstControllerGoal.id,
        maxGoalRounds: firstControllerGoal.maxGoalRounds,
        roundsStarted: firstControllerGoal.roundsStarted,
      })
      expect(restoredControllerGoal.objective).toContain(`Controller-Session-ID: "${controllerSessionId}"`)
      expect(restoredControllerGoal.objective).toContain(`AutoLab-ID: "${created.state.labId}"`)
      expect(restored.controllerGoal).toMatchObject({
        installId: running.controllerGoal?.installId,
        assignmentId: running.controllerGoal?.assignmentId,
        goalId: String(firstControllerGoal.id),
        status: 'applied',
      })
      expect(Object.fromEntries(Object.entries(restored.roles).map(([roleId, role]) => [
        roleId,
        role.sessionId,
      ]))).toEqual(sessionIds)
      expect(restored.roles['lane-a-method']!.goalInstall?.installId).toBe(methodInstall.installId)

      for (const [roleId, id] of Object.entries(sessionIds)) {
        const resumed = second.ctx.agents.get(SessionId(id))
        expect(resumed).toBeDefined()
        expect(resumed!.session).not.toBe(firstAgents[roleId]!.session)
        expect(resumed!.session.header).toMatchObject(firstHeaders[roleId]!)
        expect(resumed!.session.header.delegationDepth).toBe(
          firstHeaders[roleId]!.delegationDepth ?? 0,
        )
        expect(resumed!.options).toEqual(firstOptions[roleId])
        expect(currentPermission(resumed!.session.events)).toBe('read-only')
        expect(await roleKernelText(second.ctx, resumed!)).toBe(
          roleKernelFor(roleKind(roleId)).text,
        )
      }

      const resumedMethod = second.ctx.agents.get(SessionId(sessionIds['lane-a-method']!))!
      for (const name of controllerToolNames) {
        expect(second.ctx.tools.get(name, resumedMethod)).toBeUndefined()
      }
      const restoredGoal = second.ctx.goals.get(resumedMethod)!
      expect(restoredGoal).toMatchObject({
        id: firstMethodGoal.id,
        revision: firstMethodGoal.revision + 1,
        objective: firstMethodGoal.objective,
        maxGoalRounds: firstMethodGoal.maxGoalRounds,
        roundsStarted: firstMethodGoal.roundsStarted,
        phase: 'active',
        activation: 'armed',
      })
      expect(restored.roles['lane-a-method']!.goalInstall).toMatchObject({
        installId: methodInstall.installId,
        goalId: firstMethodGoal.id,
        goalRevision: restoredGoal.revision,
        status: 'applied',
      })

      for (const roleId of judgeIds) {
        const resumed = second.ctx.agents.get(SessionId(sessionIds[roleId]!))!
        expect(resumed.status).toBe('idle')
        expect(second.ctx.goals.get(resumed)).toBeUndefined()
        expect(resumed.session.events.slice(0, firstEvents[roleId]!.length)).toEqual(
          firstEvents[roleId],
        )
        expect(resumed.session.events.slice(firstEvents[roleId]!.length).map(event => event.type)).toEqual([
          'session/end-seed',
        ])
        expect(resumed.session.events.some(event => event.type === 'turn/start')).toBe(false)
        expect(resumed.session.events.some(event => event.type === 'user/message')).toBe(false)
      }

      for (const roleId of ['lane-a-coder', 'ops']) {
        const resumed = second.ctx.agents.get(SessionId(sessionIds[roleId]!))!
        expect(second.ctx.goals.get(resumed)).toBeUndefined()
      }
    } finally {
      if (second !== undefined) await second.ctx.fiber.dispose()
      if (first !== undefined) await first.ctx.fiber.dispose()
    }
  })

  it('keeps an explicit Controller wait dormant across restart', async () => {
    const root = await secureRoot()
    const source = await sourceConfig(root)
    const controllerSessionId = 'controller-wait-restart'
    let first: MountedController | undefined
    let second: MountedController | undefined

    try {
      first = await mountController(root)
      const controller = (await createController(first.ctx, controllerSessionId)).agent
      const created = await first.ctx.autolab.create(controller, source)
      await first.ctx.autolab.commit(controller, created.state.labId)
      await first.ctx.autolab.start(controller, created.state.labId)

      const beforeWait = snapshotGoal(first.ctx.goals.get(controller)!)
      await expect(first.ctx.autolab.waitController(controller, created.state.labId)).resolves.toEqual({
        labId: created.state.labId,
        outcome: 'paused',
      })
      const waiting = snapshotGoal(first.ctx.goals.get(controller)!)
      expect(waiting).toMatchObject({
        id: beforeWait.id,
        phase: 'paused',
        roundsStarted: beforeWait.roundsStarted,
        maxGoalRounds: beforeWait.maxGoalRounds,
      })
      await first.ctx.sessions.flush(controller.session)
      await waitForControllerProjection(
        first,
        controller,
        created.state.labId,
        projected => projected.goalId === String(waiting.id)
          && projected.goalRevision === waiting.revision
          && projected.waiting === true,
      )

      await first.ctx.fiber.dispose()
      first = undefined

      second = await mountController(root)
      const offline = second.ctx.autolab.status(
        { id: SessionId(controllerSessionId) } as Agent,
        created.state.labId,
      )
      expect(offline.lifecycle).toBe('running')
      expect(offline.controllerGoal).toMatchObject({
        goalId: String(waiting.id),
        status: 'applied',
        waiting: true,
      })

      const resumed = (await resumeController(second.ctx, controllerSessionId)).agent
      await drainControllerTasks(second.ctx)
      const restored = snapshotGoal(second.ctx.goals.get(resumed)!)
      expect(restored).toMatchObject({
        id: waiting.id,
        phase: 'paused',
        roundsStarted: waiting.roundsStarted,
        maxGoalRounds: waiting.maxGoalRounds,
      })
      expect(String(resumed.id)).toBe(controllerSessionId)
      expect(second.ctx.autolab.status(resumed, created.state.labId)).toMatchObject({
        lifecycle: 'running',
        controllerGoal: { goalId: String(waiting.id), waiting: true },
      })

      const explicitlyResumed = await second.ctx.autolab.resume(resumed, created.state.labId)
      const active = await waitForControllerGoal(
        second.ctx,
        resumed,
        goal => goal.phase === 'active' && goal.activation === 'armed',
      )
      expect(active.id).toBe(waiting.id)
      expect(explicitlyResumed.controllerGoal).not.toHaveProperty('waiting')
    } finally {
      if (second !== undefined) await second.ctx.fiber.dispose()
      if (first !== undefined) await first.ctx.fiber.dispose()
    }
  })

  it('keeps a paused Lab and its Controller Goal dormant across restart', async () => {
    const root = await secureRoot()
    const source = await sourceConfig(root)
    const controllerSessionId = 'controller-paused-restart'
    let first: MountedController | undefined
    let second: MountedController | undefined

    try {
      first = await mountController(root)
      const controller = (await createController(first.ctx, controllerSessionId)).agent
      const created = await first.ctx.autolab.create(controller, source)
      await first.ctx.autolab.commit(controller, created.state.labId)
      await first.ctx.autolab.start(controller, created.state.labId)
      const pausedState = await first.ctx.autolab.pause(controller, created.state.labId)
      const pausedGoal = snapshotGoal(first.ctx.goals.get(controller)!)
      expect(pausedState.lifecycle).toBe('paused')
      expect(pausedGoal.phase).toBe('paused')
      await first.ctx.sessions.flush(controller.session)

      await first.ctx.fiber.dispose()
      first = undefined

      second = await mountController(root)
      const resumed = (await resumeController(second.ctx, controllerSessionId)).agent
      await drainControllerTasks(second.ctx)
      const restored = snapshotGoal(second.ctx.goals.get(resumed)!)
      expect(restored).toMatchObject({
        id: pausedGoal.id,
        phase: 'paused',
        roundsStarted: pausedGoal.roundsStarted,
        maxGoalRounds: pausedGoal.maxGoalRounds,
      })
      expect(second.ctx.autolab.status(resumed, created.state.labId)).toMatchObject({
        lifecycle: 'paused',
        controllerSessionId,
        controllerGoal: {
          goalId: String(pausedGoal.id),
          status: 'applied',
        },
      })
    } finally {
      if (second !== undefined) await second.ctx.fiber.dispose()
      if (first !== undefined) await first.ctx.fiber.dispose()
    }
  })

  it('re-arms the same Controller Goal for an authorized blocked Lab', async () => {
    const root = await secureRoot()
    const source = await sourceConfig(root)
    const controllerSessionId = 'controller-blocked-restart'
    let first: MountedController | undefined
    let second: MountedController | undefined

    try {
      first = await mountController(root)
      const controller = (await createController(first.ctx, controllerSessionId)).agent
      const created = await first.ctx.autolab.create(controller, source)
      await first.ctx.autolab.commit(controller, created.state.labId)
      first.messagingFaults.permissionReads = 1
      await expect(first.ctx.autolab.start(controller, created.state.labId)).rejects.toMatchObject({
        code: 'ROLE_ACTIVATION_UNAVAILABLE',
      })
      expect(first.ctx.autolab.status(controller, created.state.labId)).toMatchObject({
        lifecycle: 'blocked',
        controllerSessionId,
      })

      const disarmed = first.ctx.goals.disarm(controller)
      if (disarmed === undefined) throw new Error('expected blocked Controller Goal to disarm')
      await first.ctx.sessions.flush(controller.session)
      await waitForControllerProjection(
        first,
        controller,
        created.state.labId,
        projected => projected.goalId === String(disarmed.id)
          && projected.goalRevision === disarmed.revision,
      )
      expect(disarmed.activation).toBe('disarmed')

      await first.ctx.fiber.dispose()
      first = undefined

      second = await mountController(root)
      const resumed = (await resumeController(second.ctx, controllerSessionId)).agent
      await drainControllerTasks(second.ctx)
      const restored = await waitForControllerGoal(
        second.ctx,
        resumed,
        goal => goal.phase === 'active' && goal.activation === 'armed',
      )
      expect(restored).toMatchObject({
        id: disarmed.id,
        roundsStarted: disarmed.roundsStarted,
        maxGoalRounds: disarmed.maxGoalRounds,
      })
      expect(restored.revision).toBeGreaterThan(disarmed.revision)
      expect(second.ctx.autolab.status(resumed, created.state.labId)).toMatchObject({
        lifecycle: 'blocked',
        controllerSessionId,
        controllerGoal: {
          goalId: String(disarmed.id),
          goalRevision: restored.revision,
          status: 'applied',
        },
      })
    } finally {
      if (second !== undefined) await second.ctx.fiber.dispose()
      if (first !== undefined) await first.ctx.fiber.dispose()
    }
  })

  it('continues a Controller transient terminal API failure in place after restart', async () => {
    const root = await secureRoot()
    const source = await sourceConfig(root)
    const controllerSessionId = 'controller-api-restart'
    let first: MountedController | undefined
    let second: MountedController | undefined
    let dateNow: ReturnType<typeof vi.spyOn> | undefined

    try {
      first = await mountController(root)
      const controller = (await createController(first.ctx, controllerSessionId)).agent
      const created = await first.ctx.autolab.create(controller, source)
      await first.ctx.autolab.commit(controller, created.state.labId)
      await first.ctx.autolab.start(controller, created.state.labId)

      const disarmed = first.ctx.goals.disarm(controller)
      if (disarmed === undefined) throw new Error('expected API Controller Goal to disarm')
      await first.ctx.sessions.flush(controller.session)
      await waitForControllerProjection(
        first,
        controller,
        created.state.labId,
        projected => projected.goalId === String(disarmed.id)
          && projected.goalRevision === disarmed.revision,
      )
      const failure: LlmFailure = {
        message: 'restart fixture transport failure',
        code: 'TRANSPORT',
        providerRetryAfterMs: 10_000,
      }
      const turn = 41
      await expect(first.ctx.waterfall(
        'agent/request-error',
        {
          agent: controller,
          turn,
          step: 2,
          provider: 'test-provider',
          failure,
          retryPolicy: nativeRetryExhaustedPolicy,
          signal: new AbortController().signal,
        },
        () => Promise.resolve(undefined),
      )).resolves.toBeUndefined()
      controller.session.append('turn/end', {
        turn,
        reason: { kind: 'error', error: failure },
      })
      await vi.waitFor(() => {
        expect(apiRecoveryRecord(first!.ctx, controllerSessionId)?.phase).toBe('scheduled')
      })
      const scheduled = apiRecoveryRecord(first.ctx, controllerSessionId)
      expect(scheduled?.dueAt).toBeTypeOf('number')

      await first.ctx.fiber.dispose()
      first = undefined

      // AutoLab captures Date.now as its one-shot recovery clock at mount.
      // Keep that captured clock before the durable deadline until after the
      // no-early-rearm assertion, then advance the same clock for one real wake.
      dateNow = vi.spyOn(Date, 'now').mockReturnValue(scheduled!.dueAt! - 1_000)
      second = await mountController(root)
      expect(apiRecoveryRecord(second.ctx, controllerSessionId)?.phase).toBe('scheduled')
      const resumed = (await resumeController(second.ctx, controllerSessionId)).agent
      await drainControllerTasks(second.ctx)

      const beforeDeadline = snapshotGoal(second.ctx.goals.get(resumed)!)
      expect(beforeDeadline).toMatchObject({
        id: disarmed.id,
        revision: disarmed.revision,
        phase: 'active',
        activation: 'disarmed',
        roundsStarted: disarmed.roundsStarted,
        maxGoalRounds: disarmed.maxGoalRounds,
      })
      expect(String(resumed.id)).toBe(controllerSessionId)
      expect(resumed.status).toBe('idle')

      dateNow.mockReturnValue(scheduled!.dueAt! + 1)
      second.ctx.emit('llm/adapters-updated')
      await vi.waitFor(() => {
        expect(apiRecoveryRecord(second!.ctx, controllerSessionId)?.phase).toBe('recovering')
      })
      const recovered = await waitForControllerGoal(
        second.ctx,
        resumed,
        goal => goal.phase === 'active' && goal.activation === 'armed',
      )

      expect(recovered).toMatchObject({
        id: disarmed.id,
        revision: disarmed.revision + 1,
        roundsStarted: disarmed.roundsStarted,
        maxGoalRounds: disarmed.maxGoalRounds,
      })
      resumed.session.append('turn/end', {
        turn: turn + 1,
        reason: { kind: 'completed' },
      })
      await vi.waitFor(() => {
        expect(apiRecoveryRecord(second!.ctx, controllerSessionId)).toBeUndefined()
      })
    } finally {
      if (second !== undefined) await second.ctx.fiber.dispose()
      if (first !== undefined) await first.ctx.fiber.dispose()
      dateNow?.mockRestore()
    }
  })

  it('freezes one opaque Ops receipt, pauses its Goal, and delivers one stable Controller notice', async () => {
    const root = await secureRoot()
    const source = await sourceConfig(root)
    let mounted: MountedController | undefined

    try {
      mounted = await mountController(root)
      const controller = (await createController(mounted.ctx, 'controller-ops-result')).agent
      const created = await mounted.ctx.autolab.create(controller, source)
      await mounted.ctx.autolab.commit(controller, created.state.labId)
      const running = await mounted.ctx.autolab.start(controller, created.state.labId)
      const ops = mounted.ctx.agents.get(SessionId(running.roles.ops!.sessionId))!
      const absentLog = join(root, 'not-read', 'experiment.log')
      const absentCheckpoint = join(root, 'not-read', 'checkpoint.bin')
      const assignmentId = 'ops:repair-opaque-1'

      await expect(mounted.ctx.autolab.assignRole(controller, {
        labId: created.state.labId,
        roleId: 'ops',
        assignmentId,
        objective: 'Perform the explicitly requested environment repair and return the Lab receipt.',
        contentJson: JSON.stringify({
          exact_request: 'repair the declared local environment condition',
          controller_selected_scope: 'environment-repair-only',
        }),
        outputSchemaJson: JSON.stringify({ lab_owned_format: 'opaque-v9' }),
        inputArtifactRefsJson: JSON.stringify([
          { artifact_id: 'log-ref', path: absentLog, sha256: hash('7') },
          { artifact_id: 'checkpoint-ref', path: absentCheckpoint, sha256: hash('8') },
        ]),
      })).resolves.toEqual({
        labId: created.state.labId,
        roleId: 'ops',
        assignmentId,
        phase: 'working',
      })

      const working = mounted.ctx.autolab.status(controller, created.state.labId)
      expect(working.roles.ops).toMatchObject({
        phase: 'working',
        goalInstall: { assignmentId, status: 'applied' },
      })
      expect(mounted.ctx.goals.get(ops)).toMatchObject({
        phase: 'active',
        activation: 'armed',
      })
      const packet = parseRolePacket(JSON.parse(
        await readFile(working.roles.ops!.packet!.path, 'utf8'),
      ) as unknown)
      expect(packet.runtime_snapshot.input_artifact_refs.map(reference => reference.path)).toEqual([
        absentLog,
        absentCheckpoint,
      ])
      await expect(stat(absentLog)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(absentCheckpoint)).rejects.toMatchObject({ code: 'ENOENT' })

      const receiptBytes = Buffer.from([
        'LAB-OPS-RECEIPT-V9',
        `log=${absentLog}`,
        `checkpoint=${absentCheckpoint}`,
        'This is deliberately not JSON and must remain opaque.',
        '',
      ].join('\n'))
      await mkdir(dirname(packet.output_contract.receipt_path), { recursive: true })
      await writeFile(packet.output_contract.receipt_path, receiptBytes)
      await expect(mounted.ctx.autolab.waitController(controller, created.state.labId))
        .resolves.toMatchObject({ outcome: 'paused' })

      await expect(mounted.ctx.autolab.submitAutoLabRoleResult(ops)).resolves.toEqual({
        labId: created.state.labId,
        roleId: 'ops',
        assignmentId,
        phase: 'receipt_recorded',
      })
      const recorded = mounted.ctx.autolab.status(controller, created.state.labId)
      expect(recorded.roles.ops).toMatchObject({
        phase: 'paused',
        receipt: { assignmentId, hash: sha256(receiptBytes) },
      })
      expect(await readFile(recorded.roles.ops!.receipt!.path)).toEqual(receiptBytes)
      expect(mounted.ctx.goals.get(ops)).toMatchObject({ phase: 'paused' })
      await waitForControllerGoal(
        mounted.ctx,
        controller,
        goal => goal.phase === 'active' && goal.activation === 'armed',
      )
      const noticeText = `role ops recorded Assignment ${assignmentId}`
      expect(matchingNoticeIds(controller, noticeText)).toHaveLength(1)
      await expect(stat(absentLog)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(absentCheckpoint)).rejects.toMatchObject({ code: 'ENOENT' })

      // Replaying the exact receipt is idempotent and cannot wake a later,
      // unrelated Controller wait or duplicate its stable event identity.
      await mounted.ctx.autolab.waitController(controller, created.state.labId)
      await mounted.ctx.autolab.submitAutoLabRoleResult(ops)
      expect(mounted.ctx.goals.get(controller)).toMatchObject({ phase: 'paused' })
      expect(mounted.ctx.autolab.status(controller, created.state.labId).controllerGoal)
        .toMatchObject({ waiting: true })
      expect(matchingNoticeIds(controller, noticeText)).toHaveLength(1)
    } finally {
      if (mounted !== undefined) await mounted.ctx.fiber.dispose()
    }
  })

  it('installs an explicit next Method Assignment only from its paused Session', async () => {
    const root = await secureRoot()
    let mounted: MountedController | undefined

    try {
      mounted = await mountController(root)
      const value = await runtimeMethodFixture(mounted, root, 'controller-method-next')

      await expect(mounted.ctx.autolab.assignMethod(value.controller, value.input)).resolves.toEqual({
        labId: value.labId,
        methodRoleId: 'lane-a-method',
        assignmentId: value.input.assignmentId,
        phase: 'working',
      })
      const applied = mounted.ctx.autolab.status(value.controller, value.labId)
      expect(applied.roles['lane-a-method']).toMatchObject({
        phase: 'working',
        goalInstall: { assignmentId: value.input.assignmentId, status: 'applied' },
      })
      expect(applied.reviews).toEqual({})
      expect(mounted.ctx.goals.get(value.method)).toMatchObject({
        phase: 'active',
        activation: 'armed',
      })
      const packet = parseRolePacket(JSON.parse(
        await readFile(applied.roles['lane-a-method']!.packet!.path, 'utf8'),
      ) as unknown)
      expect(packet.runtime_snapshot.input_artifact_refs).toHaveLength(1)
      expect(packet.verbatim_blocks.assignment[0]!.exact_text).not.toContain('source_review_id')

      const revision = applied.runtimeRevision
      await expect(mounted.ctx.autolab.assignMethod(value.controller, value.input))
        .resolves.toMatchObject({ phase: 'working' })
      expect(mounted.ctx.autolab.status(value.controller, value.labId).runtimeRevision).toBe(revision)
      for (const conflict of [
        { ...value.input, contentJson: JSON.stringify({ changed: true }) },
        { ...value.input, inputArtifactRefsJson: '[]' },
      ]) {
        await expect(mounted.ctx.autolab.assignMethod(value.controller, conflict))
          .rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT' })
      }
    } finally {
      if (mounted !== undefined) await mounted.ctx.fiber.dispose()
    }
  })

  it.each(['REVISION_REQUIRED', 'REJECTED'] as const)(
    'binds one %s verdict to the revised Method Goal before releasing its hold',
    async verdict => {
      const root = await secureRoot()
      let mounted: MountedController | undefined

      try {
        mounted = await mountController(root)
        const value = await runtimeMethodFixture(
          mounted,
          root,
          `controller-method-${verdict.toLowerCase()}`,
          verdict,
        )
        await expect(mounted.ctx.autolab.assignMethod(value.controller, value.input)).resolves.toEqual({
          labId: value.labId,
          methodRoleId: 'lane-a-method',
          assignmentId: value.input.assignmentId,
          sourceReviewId: value.reviewId,
          phase: 'working',
        })
        let applied = mounted.ctx.autolab.status(value.controller, value.labId)
        const role = applied.roles['lane-a-method']!
        const review = applied.reviews[value.reviewId!]!
        expect(role).toMatchObject({
          phase: 'working',
          goalInstall: { assignmentId: value.input.assignmentId, status: 'applied' },
        })
        expect(review).toMatchObject({
          pause: { freeze: 'stopped' },
          resolution: {
            reviewId: value.reviewId,
            verdictHash: hash('9'),
            targetRoleId: 'lane-a-method',
            targetSessionId: role.sessionId,
            effect: {
              kind: 'goal_install',
              id: role.goalInstall!.installId,
              hash: role.goalInstall!.objectiveHash,
            },
          },
        })
        expect(review.pause).not.toHaveProperty('holdOwnerEpoch')
        expect(value.releaseHold).toHaveBeenCalledTimes(1)
        const packet = parseRolePacket(JSON.parse(
          await readFile(role.packet!.path, 'utf8'),
        ) as unknown)
        expect(packet.runtime_snapshot.input_artifact_refs).toEqual([
          {
            artifact_id: 'method-context',
            path: join(root, 'not-read', 'method-context.json'),
            sha256: hash('4'),
          },
          {
            artifact_id: METHOD_SOURCE_PREFLIGHT_VERDICT_ARTIFACT_ID,
            path: value.verdictPath,
            sha256: hash('9'),
          },
        ])
        await expect(stat(value.verdictPath!)).rejects.toMatchObject({ code: 'ENOENT' })

        const revision = applied.runtimeRevision
        await expect(mounted.ctx.autolab.assignMethod(value.controller, value.input))
          .resolves.toMatchObject({ phase: 'working' })
        expect(mounted.ctx.autolab.status(value.controller, value.labId).runtimeRevision)
          .toBe(revision)
        expect(value.releaseHold).toHaveBeenCalledTimes(1)
        for (const conflict of [
          { ...value.input, contentJson: JSON.stringify({ changed: true }) },
          { ...value.input, inputArtifactRefsJson: '[]' },
          (() => {
            const { sourceReviewId: _sourceReviewId, ...withoutReview } = value.input
            return withoutReview
          })(),
        ]) {
          await expect(mounted.ctx.autolab.assignMethod(value.controller, conflict))
            .rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT' })
        }
        await expect(mounted.ctx.autolab.assignMethod(value.controller, {
          ...value.input,
          sourceReviewId: 'wrong-review',
        })).rejects.toMatchObject({ code: 'REVIEW_NOT_READY' })

        // Model startup having already recovered the activating Goal while the
        // matching resolution CAS was absent. Exact replay must fill only that
        // marker, then release the reconstructed hold.
        applied = mounted.ctx.autolab.status(value.controller, value.labId)
        const currentReview = applied.reviews[value.reviewId!]!
        const { resolution: _resolution, ...unresolvedBody } = currentReview
        const unresolved = activeReviewSchema.parse({
          ...unresolvedBody,
          pause: {
            ...currentReview.pause,
            freeze: 'held',
            holdOwnerEpoch: applied.ownerEpoch,
          },
        })
        const recoveredWithoutResolution = transitionRuntimeState(applied, {
          expectedRevision: applied.runtimeRevision,
          ownerEpoch: applied.ownerEpoch,
          lifecycle: applied.lifecycle,
          reviews: { ...applied.reviews, [value.reviewId!]: unresolved },
        })
        await persistRuntimeProjection(mounted.ctx, recoveredWithoutResolution)
        value.runtime.reviewHolds.set(`${value.labId}\0${value.reviewId}`, {
          release: value.releaseHold,
        })
        await expect(mounted.ctx.autolab.assignMethod(value.controller, value.input))
          .resolves.toMatchObject({ phase: 'working' })
        expect(mounted.ctx.autolab.status(value.controller, value.labId).reviews[value.reviewId!]!.resolution)
          .toBeDefined()
        expect(value.releaseHold).toHaveBeenCalledTimes(2)
      } finally {
        if (mounted !== undefined) await mounted.ctx.fiber.dispose()
      }
    },
  )

  it('rejects APPROVED, REVIEW_ERROR, and an unrelated review on the Method revision path', async () => {
    const root = await secureRoot()
    let mounted: MountedController | undefined

    try {
      mounted = await mountController(root)
      const value = await runtimeMethodFixture(
        mounted,
        root,
        'controller-method-invalid-verdict',
        'APPROVED',
      )
      await expect(mounted.ctx.autolab.assignMethod(value.controller, value.input))
        .rejects.toMatchObject({ code: 'REVIEW_NOT_READY' })

      const approved = mounted.ctx.autolab.status(value.controller, value.labId)
      const review = approved.reviews[value.reviewId!]!
      const errorReview = activeReviewSchema.parse({
        ...review,
        phase: 'error',
        verdict: { ...review.verdict!, topLevelVerdict: 'REVIEW_ERROR' },
      })
      const withError = transitionRuntimeState(approved, {
        expectedRevision: approved.runtimeRevision,
        ownerEpoch: approved.ownerEpoch,
        lifecycle: approved.lifecycle,
        reviews: { ...approved.reviews, [value.reviewId!]: errorReview },
      })
      await persistRuntimeProjection(mounted.ctx, withError)
      await expect(mounted.ctx.autolab.assignMethod(value.controller, value.input))
        .rejects.toMatchObject({ code: 'REVIEW_NOT_READY' })
      await expect(mounted.ctx.autolab.assignMethod(value.controller, {
        ...value.input,
        sourceReviewId: 'unrelated-review',
      })).rejects.toMatchObject({ code: 'REVIEW_NOT_READY' })
      expect(value.releaseHold).not.toHaveBeenCalled()
      expect(mounted.ctx.autolab.status(value.controller, value.labId).roles['lane-a-method']!.goalInstall)
        .toMatchObject({ assignmentId: 'lane-a:method:initial', status: 'applied' })
    } finally {
      if (mounted !== undefined) await mounted.ctx.fiber.dispose()
    }
  })

  it('adopts concurrent exact retry CAS and redispatches only the exact active retry', async () => {
    const root = await realpath(await secureRoot())
    let mounted: MountedController | undefined
    let dispatchSpy: { mockRestore(): void } | undefined

    try {
      mounted = await mountController(root)
      const value = await runtimeRetryFixture(mounted, root, 'controller-attempt-retry')
      await persistRuntimeProjection(mounted.ctx, value.activeProjection)
      const dispatchObservedStates: RuntimeState[] = []
      dispatchSpy = vi.spyOn(value.runtime.attemptRuntime, 'dispatch').mockImplementation(
        async (target, edge): Promise<AttemptRuntimeResult> => {
          dispatchObservedStates.push(mounted!.ctx.autolab.status(value.controller, value.labId))
          return { outcome: 'stale', target, edge }
        },
      )

      // Attempt ordinal 1 is active, but it is not a retry and therefore cannot
      // be adopted through AutoLabRetryAttempt.
      await expect(mounted.ctx.autolab.retryAttempt(value.controller, value.retryInput))
        .rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' })
      expect(dispatchSpy).not.toHaveBeenCalled()

      await persistRuntimeProjection(mounted.ctx, value.retryableProjection)
      const [first, concurrentReplay] = await Promise.all([
        mounted.ctx.autolab.retryAttempt(value.controller, value.retryInput),
        mounted.ctx.autolab.retryAttempt(value.controller, value.retryInput),
      ])
      const retried = mounted.ctx.autolab.status(value.controller, value.labId)
      const slot = retried.trials['trial-retry-lineage']!.runSlots['slot-a']!
      const previousAttempt = value.initial.intent.attempt.value
      expect(first).toEqual(concurrentReplay)
      expect(first).toMatchObject({
        labId: value.labId,
        trialId: 'trial-retry-lineage',
        runSlotId: 'slot-a',
        attemptId: slot.activeAttempt!.attemptId,
        phase: 'launching',
      })
      expect(retried.runtimeRevision).toBe(value.retryableProjection.runtimeRevision + 1)
      expect(Object.keys(retried.trials)).toEqual(['trial-retry-lineage'])
      expect(retried.trials['trial-retry-lineage']).toMatchObject({
        sourceRevision: value.failed.sourceRevision,
        laneId: value.failed.laneId,
        candidateId: value.failed.candidateId,
        candidateSha: value.failed.candidateSha,
      })
      expect(slot).toMatchObject({
        contract: value.failed.runSlots['slot-a']!.contract,
        state: {
          status: 'attempt_active',
          attempt_ids: [previousAttempt.attempt_id, slot.activeAttempt!.attemptId],
        },
      })
      const retryIntent = await readLocalAttemptIntent({
        runRoot: value.frozen.manifest.execution.run_root,
        activeAttempt: { path: slot.activeAttempt!.path, hash: slot.activeAttempt!.hash },
      })
      expect(retryIntent.attempt.value).toMatchObject({
        attempt_ordinal: 2,
        predecessor_attempt_id: previousAttempt.attempt_id,
        trial_id: previousAttempt.trial_id,
        runslot_id: previousAttempt.runslot_id,
        candidate_sha: previousAttempt.candidate_sha,
      })
      expect(dispatchSpy).toHaveBeenCalledTimes(2)
      expect(dispatchObservedStates).toHaveLength(2)
      for (const observed of dispatchObservedStates) {
        expect(observed.runtimeRevision).toBe(retried.runtimeRevision)
        expect(observed.trials['trial-retry-lineage']?.runSlots['slot-a']?.activeAttempt)
          .toEqual(slot.activeAttempt)
      }

      const exactActiveReplay = await mounted.ctx.autolab.retryAttempt(
        value.controller,
        value.retryInput,
      )
      expect(exactActiveReplay).toEqual(first)
      expect(dispatchSpy).toHaveBeenCalledTimes(3)

      for (const conflict of [
        { ...value.retryInput, hostId: 'another-host' },
        { ...value.retryInput, commandJson: JSON.stringify(['node', 'other.js']) },
        { ...value.retryInput, envJson: JSON.stringify({ AUTOLAB_FIXTURE: 'changed' }) },
      ]) {
        await expect(mounted.ctx.autolab.retryAttempt(value.controller, conflict))
          .rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' })
      }
      expect(dispatchSpy).toHaveBeenCalledTimes(3)
      expect(mounted.ctx.autolab.status(value.controller, value.labId).runtimeRevision)
        .toBe(retried.runtimeRevision)
    } finally {
      dispatchSpy?.mockRestore()
      if (mounted !== undefined) await mounted.ctx.fiber.dispose()
    }
  })

  it('reuses predecessor-anchored retry artifacts after an unpublished CAS and clock drift', async () => {
    const root = await realpath(await secureRoot())
    let mounted: MountedController | undefined
    let dispatchSpy: { mockRestore(): void } | undefined

    try {
      mounted = await mountController(root)
      const value = await runtimeRetryFixture(mounted, root, 'controller-retry-crash-window')
      await persistRuntimeProjection(mounted.ctx, value.retryableProjection)
      const command = JSON.parse(value.retryInput.commandJson) as string[]
      const env = JSON.parse(value.retryInput.envJson) as Record<string, string>

      // Freeze every deterministic retry artifact, then deliberately omit its
      // RuntimeState CAS to model a crash/failing enqueue at that boundary.
      const prepared = await prepareRetryLocalAttempt({
        frozen: value.frozen,
        trialId: value.retryInput.trialId,
        trial: value.failed,
        runSlotId: value.retryInput.runSlotId,
        hostId: value.retryInput.hostId,
        command,
        env,
        runtimePokeFile: value.runtime.attemptPoke.pointerPath,
      })
      const stillFailed = mounted.ctx.autolab.status(value.controller, value.labId)
      expect(stillFailed.trials['trial-retry-lineage']!.runSlots['slot-a']!.activeAttempt)
        .toEqual(value.failed.runSlots['slot-a']!.activeAttempt)
      expect(await readFile(prepared.intent.request.path, 'utf8'))
        .toBe(prepared.intent.request.canonicalJson)

      const previous = await readLocalAttemptIntent({
        runRoot: value.frozen.manifest.execution.run_root,
        activeAttempt: {
          path: value.failed.runSlots['slot-a']!.activeAttempt!.path,
          hash: value.failed.runSlots['slot-a']!.activeAttempt!.hash,
        },
      })
      expect(previous.attempt.value).toMatchObject({
        phase: 'terminal',
        technical_outcome: 'failed',
      })
      if (previous.attempt.value.phase !== 'terminal') {
        throw new Error('expected terminal predecessor')
      }
      expect(prepared.intent.request.value.issued_at).toBe(previous.attempt.value.completed_at)

      const clockDrifted = transitionRuntimeState(value.retryableProjection, {
        expectedRevision: value.retryableProjection.runtimeRevision,
        ownerEpoch: value.retryableProjection.ownerEpoch,
        lifecycle: value.retryableProjection.lifecycle,
        now: value.retryableProjection.updatedAt + 10_000,
      })
      await persistRuntimeProjection(mounted.ctx, clockDrifted)
      expect(clockDrifted.updatedAt).toBeGreaterThan(prepared.intent.request.value.issued_at)

      let dispatchObservedState: RuntimeState | undefined
      dispatchSpy = vi.spyOn(value.runtime.attemptRuntime, 'dispatch').mockImplementation(
        async (target, edge): Promise<AttemptRuntimeResult> => {
          dispatchObservedState = mounted!.ctx.autolab.status(value.controller, value.labId)
          return { outcome: 'stale', target, edge }
        },
      )
      const result = await mounted.ctx.autolab.retryAttempt(value.controller, value.retryInput)
      const recovered = mounted.ctx.autolab.status(value.controller, value.labId)
      const active = recovered.trials['trial-retry-lineage']!.runSlots['slot-a']!.activeAttempt!
      expect(result.attemptId).toBe(prepared.intent.attempt.value.attempt_id)
      expect(active).toEqual(prepared.projection.runSlots['slot-a']!.activeAttempt)
      expect(recovered.runtimeRevision).toBe(clockDrifted.runtimeRevision + 1)
      expect(dispatchObservedState?.runtimeRevision).toBe(recovered.runtimeRevision)
      expect(dispatchObservedState?.trials['trial-retry-lineage']?.runSlots['slot-a']?.activeAttempt)
        .toEqual(active)
      expect(dispatchSpy).toHaveBeenCalledTimes(1)
    } finally {
      dispatchSpy?.mockRestore()
      if (mounted !== undefined) await mounted.ctx.fiber.dispose()
    }
  })

  it('replays one recorded Postflight output on attach without clearing a later wait', async () => {
    const root = await secureRoot()
    const source = await sourceConfig(root)
    const controllerSessionId = 'controller-postflight-replay'
    let first: MountedController | undefined
    let second: MountedController | undefined

    try {
      first = await mountController(root)
      const controller = (await createController(first.ctx, controllerSessionId)).agent
      const created = await first.ctx.autolab.create(controller, source)
      await first.ctx.autolab.commit(controller, created.state.labId)
      await first.ctx.autolab.start(controller, created.state.labId)
      await first.ctx.autolab.waitController(controller, created.state.labId)
      const waiting = first.ctx.autolab.status(controller, created.state.labId)
      const coder = waiting.roles['lane-a-coder']!
      const judge = waiting.roles['lane-a-postflight']!
      const reviewId = 'postflight-recorded-before-attach'
      const assignmentId = `postflight:${reviewId}`
      const negotiatedAnchorHash = hash('6')
      const resultPath = join(root, 'recorded-postflight-result.raw')
      const resultBytes = Buffer.from('LAB-POSTFLIGHT-OPAQUE\nnot-json=true\n')
      await writeFile(resultPath, resultBytes)
      const requestControlId = '00000000-0000-4000-8000-000000000701'
      const acceptedControlId = '00000000-0000-4000-8000-000000000702'
      const acceptedPayloadHash = `sha256:${hash('8')}`
      const review = activeReviewSchema.parse({
        stage: 'postflight',
        phase: 'result_recorded',
        sourcePacket: coder.packet,
        packetPath: judge.packet!.path,
        artifactPath: join(root, 'attempt-reference.json'),
        capability: {
          version: 1,
          reviewId,
          assignmentId,
          configRevision: waiting.config!.revision,
          runtimeRevision: waiting.runtimeRevision,
          ownerFence: waiting.ownerEpoch,
          workerRoleId: 'lane-a-coder',
          workerSessionId: coder.sessionId,
          judgeRoleId: 'lane-a-postflight',
          judgeSessionId: judge.sessionId,
          packetHash: judge.packet!.hash,
          artifactHash: hash('5'),
          negotiatedAnchorHash,
          sourceTurn: 1,
          expectedGoalRef: null,
          request: {
            controlId: requestControlId,
            payloadHash: `sha256:${hash('7')}`,
          },
          acceptedPause: {
            controlId: acceptedControlId,
            payloadHash: acceptedPayloadHash,
          },
        },
        pause: {
          controlId: acceptedControlId,
          payloadHash: acceptedPayloadHash,
          freeze: 'stopped',
          completedAt: waiting.updatedAt,
          goalOutcome: 'already-applied',
          activeTurn: false,
        },
        result: {
          path: resultPath,
          hash: sha256(resultBytes),
          assignmentId,
          reviewInputHash: negotiatedAnchorHash,
          recordedAt: waiting.updatedAt,
        },
        createdAt: waiting.updatedAt,
        updatedAt: waiting.updatedAt,
      })
      const roles = structuredClone(waiting.roles)
      roles['lane-a-coder'] = { ...coder, phase: 'paused' }
      const recorded = transitionRuntimeState(waiting, {
        expectedRevision: waiting.runtimeRevision,
        ownerEpoch: waiting.ownerEpoch,
        lifecycle: waiting.lifecycle,
        roles,
        reviews: { ...waiting.reviews, [reviewId]: review },
      })
      await persistRuntimeProjection(first.ctx, recorded)
      expect(matchingNoticeIds(controller, `Postflight review ${reviewId} recorded`)).toEqual([])

      await first.ctx.fiber.dispose()
      first = undefined

      second = await mountController(root)
      const resumed = (await resumeController(second.ctx, controllerSessionId)).agent
      await drainControllerTasks(second.ctx)
      const noticeText = `Postflight review ${reviewId} recorded its Lab-native result`
      await vi.waitFor(() => {
        expect(matchingNoticeIds(resumed, noticeText)).toHaveLength(1)
      })
      await waitForControllerGoal(
        second.ctx,
        resumed,
        goal => goal.phase === 'active' && goal.activation === 'armed',
      )
      const recovered = second.ctx.autolab.status(resumed, created.state.labId)
      expect(recovered.controllerGoal).not.toHaveProperty('waiting')
      expect(recovered.reviews[reviewId]).toMatchObject({
        stage: 'postflight',
        phase: 'result_recorded',
        result: {
          path: resultPath,
          hash: sha256(resultBytes),
          assignmentId,
          reviewInputHash: negotiatedAnchorHash,
        },
      })
      expect(await readFile(resultPath)).toEqual(resultBytes)

      await second.ctx.autolab.waitController(resumed, created.state.labId)
      const laterWait = second.ctx.autolab.status(resumed, created.state.labId)
      expect(laterWait.controllerGoal).toMatchObject({ waiting: true })
      expect(second.ctx.goals.get(resumed)).toMatchObject({ phase: 'paused' })
      await runtimeInternals(second.ctx).replayRecordedReviewNotifications(laterWait)
      expect(second.ctx.autolab.status(resumed, created.state.labId).controllerGoal)
        .toMatchObject({ waiting: true })
      expect(second.ctx.goals.get(resumed)).toMatchObject({ phase: 'paused' })
      expect(matchingNoticeIds(resumed, noticeText)).toHaveLength(1)
    } finally {
      if (second !== undefined) await second.ctx.fiber.dispose()
      if (first !== undefined) await first.ctx.fiber.dispose()
    }
  })
})

function roleKind(roleId: string): RootRoleKind {
  if (roleId === 'lane-a-method') return 'method'
  if (roleId === 'lane-a-coder') return 'coder'
  if (roleId === 'lane-a-preflight') return 'preflight_judge'
  if (roleId === 'lane-a-postflight') return 'postflight_judge'
  return 'ops'
}
