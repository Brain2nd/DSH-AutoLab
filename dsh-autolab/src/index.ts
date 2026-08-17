import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { dshHomePath, expandHomePath } from '@deepseek-ai/dsh-home-paths'
import { GoalId, type GoalRef, type GoalView } from '@deepseek-ai/dsh-goal'
import { freezeMessage, HarnessError, MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import s from '@deepseek-ai/schemastery'
import {
  SessionMessagingError,
  type ControlHandlerDecision,
  type ControlReceipt,
} from 'dsh-local-session-messaging'
import {
  ArtifactError,
  ArtifactStore,
  type DraftSnapshot,
  generateLabId,
  type FrozenRevision,
  durableWriteFile,
  listCommittedManifestHashes,
} from './artifacts.js'
import {
  ActivationArtifactError,
  freezeInitialRoleArtifacts,
  restoreCurrentRoleArtifacts,
  type InitialRoleArtifacts,
} from './activation-artifacts.js'
import {
  applyApprovedCoderGoal,
  compileApprovedCoderActivation,
  freezeApprovedCoderActivation,
  installApprovedCoderGoal,
  resolveApprovedCoderReview,
  stageApprovedCoderActivation,
  type ApprovedCoderActivationPlan,
} from './approved-coder-activation.js'
import {
  installApiRecovery,
  type ApiRecoveryAssignment,
  type ApiRecoveryRecord,
  type ApiRecoveryRuntime,
  type OperatorApiIncidentRecord,
  type ReviewApiRecoveryWake,
} from './api-recovery.js'
import { DurableApiRecoveryStore } from './api-recovery-store.js'
import {
  freezeRoleBinding,
  readRoleBinding,
  type StoredRoleBinding,
} from './binding.js'
import { CandidateSnapshotError } from './candidate.js'
import { parseDraftLabYaml, resolveDraftLabConfig } from './config.js'
import {
  CoderSubmissionError,
  freezeApprovedCoderSubmission,
  type FreezeApprovedCoderSubmissionInput,
  type FrozenApprovedCoderSubmission,
} from './coder-submission.js'
import { CoderReceiptError } from './coder-receipt.js'
import {
  CommunicationAclError,
  reconcileCommunicationAcl,
  type CommunicationAclMessaging,
} from './communication.js'
import { DialogueLog } from './dialogue.js'
import {
  acquireLocalReviewHold,
  compileLocalGoalIntent,
  installLocalGoal,
  LocalGoalError,
  observeOpenAgentTurn,
  pauseLocalGoalContinuation,
  type LocalGoalHold,
} from './goal.js'
import { canonicalJson, sha256 } from './integrity.js'
import { compileControllerGoalIntent, type ControllerGoalIntent } from './controller-goal.js'
import {
  installControllerSurface,
  type ControllerAssignCoderFixInput,
  type ControllerAssignCoderFixResult,
  type ControllerAssignMethodInput,
  type ControllerCommitConfigRevisionInput,
  type ControllerCommitConfigRevisionResult,
  type ControllerAssignMethodResult,
  type ControllerAssignRoleInput,
  type ControllerAssignRoleResult,
  type ControllerApplyPreflightInput,
  type ControllerApplyPreflightResult,
  type ControllerLaunchAttemptInput,
  type ControllerLaunchAttemptResult,
  type ControllerReadResult,
  type ControllerRequestPostflightInput,
  type ControllerRequestPostflightResult,
  type ControllerRetryAttemptInput,
  type ControllerRegisterUserDirectiveInput,
  type ControllerRegisterUserDirectiveResult,
  type ControllerRevealResult,
  type ControllerWaitResult,
} from './controller-surface.js'
import { registerFact } from './fact-registry.js'
import { freezeCoderFixAssignment } from './coder-fix-assignment.js'
import {
  prepareInitialLocalAttempt,
  prepareRetryLocalAttempt,
  verifyRetryLocalAttemptReplay,
} from './attempt-launch.js'
import {
  openAttemptPokeEndpoint,
  type AttemptPokeEndpoint,
} from './attempt-poke.js'
import {
  AttemptRuntimeConsumer,
  type AttemptRuntimeResult,
  type AttemptRuntimeTarget,
} from './attempt-runtime.js'
import { freezeMethodDesignTicket } from './method-ticket.js'
import type { ResolvedManifest } from './manifest.js'
import {
  createRootRoleSession,
  resumeRootRoleSession,
  verifyBorrowedRootRoleSession,
  type RootRoleSessionHandle,
} from './role-session.js'
import {
  resolveRootRoleSessionSpec,
  rolePromptFor,
  type RootRoleBinding,
} from './roles.js'
import {
  projectRoleGoalRevision,
  roleOwnsExactAssignmentGoal,
} from './role-goal-revision.js'
import {
  freezePreflightReviewArtifacts,
} from './review-artifacts.js'
import {
  freezePreflightVerdict,
  type PreflightTopLevelVerdict,
} from './preflight-verdict.js'
import { freezePostflightReviewArtifacts } from './postflight-artifacts.js'
import { freezePostflightResult } from './postflight-result.js'
import {
  assertMethodAssignmentReplay,
  assertRoleAssignmentMayDispatch,
  assertRoleAssignmentReplay,
  freezeMethodAssignment,
  freezeRoleAssignment,
  freezeRoleAssignmentReceipt,
  type RoleAssignmentArtifactReference,
  type RoleAssignmentJson,
} from './role-assignment.js'
import {
  compileReviewResolution,
  compileReviewControlCapability,
  REVIEW_ACCEPTED_PAUSE,
  registerReviewControlHandlers,
  reviewJudgeStart,
  sendReviewRequest,
  type ReviewControlCapability,
  type ReviewJudgeStart,
  type ReviewJudgeStartOutcome,
} from './review.js'
import {
  adoptRuntimeOwner,
  autolabDomainSpec,
  createRuntimeState,
  recordReviewResolution,
  reviewFreezeComplete,
  roleStateSchema,
  transitionRuntimeState,
  validateLabId,
  type RuntimeState,
  type LabLifecycle,
  type RoleState,
} from './state.js'
import {
  acquireRuntimeLock,
  type RuntimeLock,
} from './lock.js'
import {
  provisionLaneWorktree,
  resolveRepositoryRefs,
  WorktreeError,
} from './worktree.js'
import { resolveLocalAttemptWrapperPath } from './runner.js'
import { flushSessionDurably, SessionDurabilityError } from './session-durability.js'
import { installSubmissionTools } from './tool.js'

const AUTOLAB_PLUGIN_VERSION = '0.1.0'
const DSH_COMPATIBILITY_VERSION = '0.1.0-rc.6'
const API_RECOVERY_DELAY_MS = 5_000
const ATTEMPT_PENDING_RETRY_MS = 1_000
const ATTEMPT_LAUNCH_SAFETY_MS = 250

interface NativeAgentPresets {
  resolve(id?: string): Promise<{ readonly id: string }>
}

interface NativeSessionHeader {
  readonly id: string
  readonly cwd?: string
  readonly agentPreset?: string
}

interface NativeSessionPersistence {
  list(signal?: AbortSignal): Promise<readonly NativeSessionHeader[]>
}

interface ActivatedRole {
  readonly role: RootRoleBinding
  readonly binding: StoredRoleBinding
  readonly artifacts: InitialRoleArtifacts
  readonly agent: Agent
  readonly ownership: 'owned' | 'borrowed'
}

type AttachedRole = Omit<ActivatedRole, 'artifacts'>
type RoleActivationBlocker = NonNullable<RoleState['activationBlocker']>

interface RoleActivationBatch {
  readonly activated: readonly ActivatedRole[]
  readonly blockers: ReadonlyMap<string, RoleActivationBlocker>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    autolab: AutoLabRuntime
  }
}

export interface Config {
  /** Durable Lab artifacts and the process-owner lock. */
  root?: string
}

export interface CreateLabResult {
  readonly state: RuntimeState
  readonly directory: string
  readonly draft: DraftSnapshot
}

export interface ShowLabResult {
  readonly state: RuntimeState
  readonly directory: string
  readonly draft?: DraftSnapshot
  readonly frozen?: FrozenRevision
}

export interface RoleSubmissionResult {
  readonly labId: string
  readonly roleId: string
  readonly assignmentId: string
  readonly reviewId: string
  readonly phase: 'reviewing'
}

export interface PreflightVerdictResult {
  readonly labId: string
  readonly roleId: string
  readonly assignmentId: string
  readonly reviewId: string
  readonly phase: 'verdict_recorded' | 'error'
  readonly verdict: PreflightTopLevelVerdict
}

export interface CoderImplementationResult {
  readonly labId: string
  readonly roleId: string
  readonly assignmentId: string
  readonly candidateId: string
  readonly candidateSha: string
  readonly phase: 'candidate_frozen'
}

export interface PostflightResultSubmission {
  readonly labId: string
  readonly roleId: string
  readonly assignmentId: string
  readonly reviewId: string
  readonly phase: 'result_recorded'
}

export interface AutoLabRoleResultSubmission {
  readonly labId: string
  readonly roleId: string
  readonly assignmentId: string
  readonly phase: 'receipt_recorded'
}

interface PreparedRoleResultSubmission {
  readonly labId: string
  readonly roleId: string
  readonly sessionId: string
  readonly assignmentId: string
  readonly packet: NonNullable<RoleState['packet']>
  readonly goalInstall: NonNullable<RoleState['goalInstall']>
  readonly config: NonNullable<RuntimeState['config']>
  readonly artifactPath: string
}

interface PreparedCoderSubmission {
  readonly labId: string
  readonly roleId: string
  readonly laneId: string
  readonly coderSessionId: string
  readonly assignmentId: string
  readonly packet: NonNullable<RoleState['packet']>
  readonly binding: NonNullable<RoleState['binding']>
  readonly goalInstall: NonNullable<RoleState['goalInstall']>
  readonly reviewId: string
  readonly config: NonNullable<RuntimeState['config']>
  readonly input: FreezeApprovedCoderSubmissionInput
}

export class AutoLabRuntimeError extends HarnessError {
  readonly name = 'AutoLabRuntimeError'

  constructor(
    message: string,
    readonly code:
      | 'NOT_READY'
      | 'LAB_NOT_FOUND'
      | 'CONTROLLER_MISMATCH'
      | 'CONFIG_DRIFT'
      | 'NO_ROLES_DECLARED'
      | 'ROLE_ACTIVATION_UNAVAILABLE'
      | 'ROLE_MISMATCH'
      | 'REVIEW_NOT_READY'
      | 'IMPLEMENTATION_NOT_READY'
      | 'OPERATION_FAILED'
      | 'REVIEW_TRANSPORT_FAILED'
      | 'SERVICE_CLOSED',
  ) {
    super(message, code)
  }
}

export class AutoLabRuntime extends Service {
  static inject = [
    'storageDomain',
    'agents',
    'goals',
    'tools',
    'systemPrompt',
    'sessions',
    'agentPresets',
    'permissionPresets',
    'sessionPersistence',
    'sessionMessaging',
    'subprocess',
  ]

  static Config: s<Config> = s.object({
    root: s.string().default(dshHomePath('autolab')),
  })

  private readonly root: string
  private readonly artifacts: ArtifactStore
  private readonly dialogue: DialogueLog
  private readonly view = new Map<string, RuntimeState>()
  private readonly roleHandles = new Map<string, RootRoleSessionHandle>()
  private readonly borrowedRoleAgents = new Map<string, Agent>()
  private readonly controllerSurfaces = new Map<string, {
    readonly agent: Agent
    readonly dispose: () => void
  }>()
  private readonly controllerTasks = new Set<Promise<void>>()
  private readonly attemptTasks = new Set<Promise<unknown>>()
  private readonly reviewHolds = new Map<string, LocalGoalHold>()
  private readonly reviewHoldTasks = new Map<string, Promise<void>>()
  private readonly reviewStatusTasks = new Set<Promise<void>>()
  private readonly reviewControlTasks = new Set<Promise<ControlHandlerDecision>>()
  private readonly shutdown = new AbortController()
  private domain: Domain<typeof autolabDomainSpec> | undefined
  private table: KvTable<string, RuntimeState> | undefined
  private apiRecoveryStore: DurableApiRecoveryStore | undefined
  private apiRecovery: ApiRecoveryRuntime | undefined
  private attemptPoke: AttemptPokeEndpoint | undefined
  private attemptRuntime: AttemptRuntimeConsumer | undefined
  private owner: RuntimeLock | undefined
  private removeReviewControlHandlers: (() => void) | undefined
  private removeReviewStatusListener: (() => unknown) | undefined
  private removeControllerCreatedListener: (() => unknown) | undefined
  private removeControllerDisposedListener: (() => unknown) | undefined
  private removeControllerGoalListener: (() => unknown) | undefined
  private removeSubmissionTools: (() => void) | undefined
  private teardownTask: Promise<void> | undefined
  /** Serialize only mutations of the same Lab; independent Labs never block each other. */
  private readonly operationTails = new Map<string, Promise<void>>()
  private accepting = false

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'autolab')
    this.root = resolve(expandHomePath(config.root ?? dshHomePath('autolab')))
    this.artifacts = new ArtifactStore(this.root)
    this.dialogue = new DialogueLog(this.artifacts.labsRoot)
  }

  async [Service.init](): Promise<void> {
    const owner = await acquireRuntimeLock(this.root)
    this.owner = owner
    // Register the role submission tools FIRST. Role activation restricts
    // each role Session's tool scope against the global registry, and the
    // Lab recovery below activates roles inside this very service init —
    // before the `tool-autolab-submission` bundle entry (which injects the
    // `autolab` service) can apply. The Runtime therefore owns this
    // registration itself so boot-time activation never races it.
    this.removeSubmissionTools = installSubmissionTools(this.ctx, this)
    // Cordis unloads top-level sibling effects concurrently. One explicit
    // lifecycle disposer therefore owns domain/receiver/task/role/owner order.
    const disposeLifecycle = this.ctx.effect(
      () => async () => this.teardown(),
      'autolab.lifecycle',
    )
    try {
      await this.artifacts.initialize()
      const domain = await this.ctx.storageDomain.open(autolabDomainSpec)
      this.domain = domain

      const table = domain.table('labs')
      this.table = table
      this.apiRecoveryStore = new DurableApiRecoveryStore(domain.table('api_recoveries'))
      for (const [labId, snapshot] of table.entries()) {
        const ownerChanged = snapshot.ownerEpoch !== owner.owner.token
        let projected = adoptRuntimeOwner(snapshot, owner.owner.token)
        const frozen = await this.artifacts.readCurrentIfPresent(labId)
        if (frozen === undefined) {
          if (projected.config !== undefined) {
            throw new AutoLabRuntimeError(
              `Lab ${labId} RuntimeState references a revision but CURRENT is absent`,
              'CONFIG_DRIFT',
            )
          }
        } else if (!sameConfigRef(projected.config, frozen.ref)) {
          const lifecycle = projected.lifecycle === 'configuring'
            || projected.lifecycle === 'draft_ready'
            ? 'ready'
            : projected.lifecycle
          projected = transitionRuntimeState(projected, {
            expectedRevision: projected.runtimeRevision,
            ownerEpoch: owner.owner.token,
            lifecycle,
            config: frozen.ref,
          })
        }
        if (ownerChanged) projected = recoverReviewFreezeProjection(projected, owner.owner.token)
        const current = projected === snapshot
          ? snapshot
          : await table.update(labId, value => {
              if (value.runtimeRevision !== snapshot.runtimeRevision) {
                throw new AutoLabRuntimeError(
                  `Lab ${labId} changed while adopting Controller ownership`,
                  'CONFIG_DRIFT',
                )
              }
              return projected
            })
        this.view.set(labId, current)
      }

      // Register before scanning so an Agent published during initialization is
      // either observed by the listener or found in the exact registry scan.
      this.removeControllerCreatedListener = this.ctx.on('agent/created', ({ agent }) => {
        if (!this.isControllerAgent(agent)) return
        try {
          this.attachControllerSurface(agent)
          if (this.accepting) this.trackControllerTask(this.reconcileControllerAgent(agent))
        } catch (error) {
          this.ctx.logger.error(
            `AutoLab could not attach Controller surface to ${String(agent.id)}: ${renderError(error)}`,
          )
        }
      })
      this.removeControllerDisposedListener = this.ctx.on('agent/disposed', ({ agent }) => {
        const key = String(agent.id)
        if (this.controllerSurfaces.get(key)?.agent === agent) {
          // The Agent scope has already unwound its registrations.
          this.controllerSurfaces.delete(key)
        }
      })
      this.removeControllerGoalListener = this.ctx.on('goal/changed', ({ agent, change }) => {
        if (this.isControllerAgent(agent)) {
          this.trackControllerTask(this.trackControllerGoalChange(
            agent,
            String(change.ref.id),
            change.ref.revision,
            change.goal,
          ))
          return
        }
        if (change.goal !== undefined) {
          this.trackControllerTask(this.trackRoleGoalChange(agent, change.goal))
        }
      })
      for (const agent of this.ctx.agents.list()) {
        if (this.isControllerAgent(agent)) this.attachControllerSurface(agent)
      }

      this.removeReviewControlHandlers = registerReviewControlHandlers(this.ctx, {
        resolveCapability: controlId => this.resolveReviewCapability(controlId),
        signal: this.shutdown.signal,
        runHandler: operation => this.runReviewControlHandler(operation),
      })
      this.removeReviewStatusListener = this.ctx.on(
        'session-messaging/control-status',
        receipt => this.trackReviewControlStatus(receipt),
      )
      const attemptRuntime = new AttemptRuntimeConsumer({
        readState: labId => this.view.get(labId),
        resolveRunRoot: async state => {
          const frozen = await this.artifacts.readCurrent(state.labId)
          if (!sameConfigRef(state.config, frozen.ref)) {
            throw new AutoLabRuntimeError(
              `Lab ${state.labId} CURRENT drifted while consuming an Attempt event`,
              'CONFIG_DRIFT',
            )
          }
          return frozen.manifest.execution.run_root
        },
        wrapperPath: await resolveLocalAttemptWrapperPath(),
        scheduleOnce: (callback, delayMs) => {
          const timer = setTimeout(callback, delayMs)
          timer.unref()
          return () => clearTimeout(timer)
        },
        pendingRetryDelayMs: ATTEMPT_PENDING_RETRY_MS,
        launchSafetyDelayMs: ATTEMPT_LAUNCH_SAFETY_MS,
        now: Date.now,
        onResult: result => this.applyAttemptRuntimeResult(result),
        onError: error => {
          if (this.shutdown.signal.aborted) return
          this.ctx.logger.warn(`AutoLab deferred an Attempt edge: ${renderError(error)}`)
        },
      })
      this.attemptRuntime = attemptRuntime
      this.attemptPoke = await openAttemptPokeEndpoint({
        root: this.root,
        onPoke: () => {
          if (!this.accepting) return
          this.trackAttemptTask(this.dispatchAllActiveAttempts('poke'))
        },
        onError: error => {
          if (this.shutdown.signal.aborted) return
          this.ctx.logger.warn(`AutoLab Attempt poke failed: ${renderError(error)}`)
        },
      })
      this.accepting = true
      this.apiRecovery = installApiRecovery(this.ctx, {
        store: this.apiRecoveryStore,
        resolveAssignment: agent => this.resolveApiRecoveryAssignment(agent),
        scheduleOnce: (callback, delayMs) => {
          const timer = setTimeout(callback, delayMs)
          timer.unref()
          return () => clearTimeout(timer)
        },
        now: Date.now,
        retryDelayMs: API_RECOVERY_DELAY_MS,
        resumeReviewOnce: (agent, wake, signal) => (
          this.resumeApiReviewOnce(agent, wake, signal)
        ),
        onOperatorIncident: record => this.notifyOperatorIncident(record),
        onError: error => {
          if (this.shutdown.signal.aborted) return
          this.ctx.logger.warn(`AutoLab API recovery deferred a mechanical action: ${renderError(error)}`)
        },
      })
      await Promise.allSettled(this.ctx.agents.list()
        .filter(agent => this.isControllerAgent(agent))
        .map(agent => this.reconcileControllerAgent(agent)))
      const recoverable = [...this.view.values()].filter(state => (
        state.lifecycle === 'running'
        || state.lifecycle === 'starting'
        || state.lifecycle === 'pausing'
      ))
      await Promise.allSettled(recoverable.map(state => {
        const controller = { id: SessionId(state.controllerSessionId) } as Agent
        return state.lifecycle === 'pausing'
          ? this.pause(controller, state.labId, this.shutdown.signal)
          : this.start(controller, state.labId, this.shutdown.signal)
      }))
      await this.dispatchAllActiveAttempts('startup')
    } catch (error) {
      await disposeLifecycle()
      throw error
    }
  }

  create(
    controller: Agent,
    sourceDirectory?: string,
    signal?: AbortSignal,
  ): Promise<CreateLabResult> {
    const labId = generateLabId()
    return this.enqueue(labId, async () => {
      signal?.throwIfAborted()
      const ownerEpoch = this.requireOwner().owner.token
      const scaffold = await this.artifacts.createLab({
        labId,
        controllerSessionId: String(controller.id),
        ...(sourceDirectory === undefined ? {} : { sourceDirectory }),
      })
      try {
        const controllerSessionId = String(controller.id)
        const events = controller.session?.events ?? []
        await this.dialogue.initialize({
          labId,
          controllerSessionId,
          timestamp: Date.now(),
          ...(sourceDirectory === undefined ? {} : { sourceDirectory }),
        })
        await this.dialogue.appendSessionEvents({
          labId,
          controllerSessionId,
          events,
          fromSeq: findCreateBoundary(events),
        })
        signal?.throwIfAborted()
        const state = createRuntimeState({
          labId,
          ownerEpoch,
          controllerSessionId,
          lifecycle: scaffold.imported ? 'draft_ready' : 'configuring',
        })
        await this.requireTable().put(labId, state)
        this.view.set(labId, state)
        this.attachControllerSurface(controller)
        return {
          state: cloneState(state),
          directory: scaffold.directory,
          draft: scaffold.draft,
        }
      } catch (error) {
        this.view.delete(labId)
        try {
          await this.requireTable().delete(labId)
          await this.artifacts.discardScaffold(labId)
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], `AutoLab ${labId} create rollback failed`)
        }
        throw error
      }
    })
  }

  async show(caller: Agent, labId: string, signal?: AbortSignal): Promise<ShowLabResult> {
    this.assertReady()
    signal?.throwIfAborted()
    const state = this.requireState(validateLabId(labId))
    this.assertControllerSession(caller, state)
    await this.syncDialogue(caller, state)
    if (state.config === undefined) {
      const draft = await this.artifacts.readDraft(labId)
      return {
        state: cloneState(state),
        directory: this.artifacts.labDirectory(labId),
        draft,
      }
    }
    const frozen = await this.artifacts.readCurrent(labId)
    signal?.throwIfAborted()
    if (!sameConfigRef(state.config, frozen.ref)) {
      throw new AutoLabRuntimeError(
        `Lab ${labId} CURRENT does not match RuntimeState`,
        'CONFIG_DRIFT',
      )
    }
    return {
      state: cloneState(state),
      directory: this.artifacts.labDirectory(labId),
      frozen,
    }
  }

  async readForController(
    caller: Agent,
    labId: string,
    signal?: AbortSignal,
  ): Promise<ControllerReadResult> {
    const result = await this.show(caller, labId, signal)
    const source = result.frozen ?? result.draft
    if (source === undefined) {
      throw new AutoLabRuntimeError(`Lab ${labId} has no readable originals`, 'CONFIG_DRIFT')
    }
    return {
      labId: result.state.labId,
      lifecycle: result.state.lifecycle,
      directory: result.directory,
      revision: result.frozen === undefined ? 'draft' : String(result.frozen.ref.revision),
      labSpec: source.spec,
      labYaml: source.config,
    }
  }

  commit(caller: Agent, labId: string, signal?: AbortSignal): Promise<ShowLabResult> {
    return this.enqueue(labId, async () => {
      signal?.throwIfAborted()
      let state = this.requireState(validateLabId(labId))
      this.assertControllerSession(caller, state)
      if (state.lifecycle !== 'configuring' && state.lifecycle !== 'draft_ready') {
        throw new AutoLabRuntimeError(
          `Lab ${labId} is ${state.lifecycle}; only an uncommitted draft can be committed`,
          'NOT_READY',
        )
      }
      await this.syncDialogue(caller, state)
      const draft = await this.artifacts.readDraft(labId)
      const config = parseDraftLabYaml(draft.config)
      const resolvedRepository = await resolveRepositoryRefs(
        config.repository.path,
        [config.repository.base_ref, ...config.search.lanes.map(lane => lane.base_ref)],
      )
      const repositoryBaseSha = resolvedRepository.commits[config.repository.base_ref]
      if (repositoryBaseSha === undefined) {
        throw new AutoLabRuntimeError('Repository base ref was not resolved', 'CONFIG_DRIFT')
      }
      const laneBaseShas = Object.fromEntries(config.search.lanes.map(lane => {
        const baseSha = resolvedRepository.commits[lane.base_ref]
        if (baseSha === undefined) {
          throw new AutoLabRuntimeError(
            `Lane ${lane.lane_id} base ref was not resolved`,
            'CONFIG_DRIFT',
          )
        }
        return [lane.lane_id, baseSha]
      }))
      await this.dialogue.appendControllerRecord({
        labId,
        controllerSessionId: state.controllerSessionId,
        timestamp: Date.now(),
        recordKind: 'discovery',
        payload: {
          kind: 'git_refs',
          repositoryPath: resolvedRepository.repositoryPath,
          repositoryBaseRef: config.repository.base_ref,
          repositoryBaseSha,
          laneBaseShas,
        },
        relatedRevision: 1,
      })
      const dialogueHead = await this.dialogue.appendControllerRecord({
        labId,
        controllerSessionId: state.controllerSessionId,
        timestamp: Date.now(),
        recordKind: 'acceptance',
        payload: { action: 'commit_revision', revision: 1 },
        relatedRevision: 1,
      })
      signal?.throwIfAborted()
      const rolePromptHashes = Object.fromEntries(config.roles.map(role => [
        role.role_id,
        rolePromptFor(role.role_kind).sha256,
      ]))
      const manifest = resolveDraftLabConfig(config, {
        lab_id: labId,
        revision: 1,
        controller_session_id: state.controllerSessionId,
        dialogue_head_sha256: dialogueHead.recordHash,
        lab_spec_sha256: draft.specHash,
        lab_yaml_sha256: draft.configHash,
        lab_directory: this.artifacts.labDirectory(labId),
        autolab_plugin_version: AUTOLAB_PLUGIN_VERSION,
        dsh_version: DSH_COMPATIBILITY_VERSION,
        repository_base_sha: repositoryBaseSha,
        lane_base_shas: laneBaseShas,
        role_prompt_sha256: rolePromptHashes,
      })
      const frozen = await this.artifacts.freezeDraftRevision({
        labId,
        revision: 1,
        manifest,
        dialogueHeadHash: dialogueHead.recordHash,
      })
      state = await this.transition(
        state,
        'ready',
        undefined,
        frozen.ref,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        frozen.manifest.communication.reveal_policy.initial_state,
      )
      await this.dialogue.appendControllerRecord({
        labId,
        controllerSessionId: state.controllerSessionId,
        timestamp: Date.now(),
        recordKind: 'configure_action',
        payload: {
          action: 'revision_committed',
          revision: 1,
          dialogueHead,
          specHash: frozen.ref.specHash,
          configHash: frozen.ref.configHash,
          manifestHash: frozen.ref.manifestHash,
          dialogueHeadHash: frozen.ref.dialogueHeadHash,
        },
        relatedRevision: 1,
      })
      return {
        state: cloneState(state),
        directory: this.artifacts.labDirectory(labId),
        frozen,
      }
    })
  }

  /**
   * Commit one Controller-authored configuration revision (revision N+1) on a
   * running/paused Lab. The revision may change research content (objective,
   * families, scientific rules, contract, lane charters, evidence contract)
   * but NOT the Lab topology (roles, lanes, worktrees, repository, execution,
   * hosts, GPU pool, communication ACL, runner adapter): those must remain
   * byte-identical so every existing role, packet, and Attempt stays valid.
   */
  async commitConfigRevision(
    caller: Agent,
    input: ControllerCommitConfigRevisionInput,
    signal?: AbortSignal,
  ): Promise<ControllerCommitConfigRevisionResult> {
    const labId = validateLabId(input.labId)
    return this.enqueue(labId, async () => {
      signal?.throwIfAborted()
      let state = this.requireState(labId)
      this.assertControllerSession(caller, state)
      if (state.lifecycle !== 'running' && state.lifecycle !== 'paused') {
        throw new AutoLabRuntimeError(
          `Lab ${labId} is ${state.lifecycle}; a revision requires running or paused`,
          'NOT_READY',
        )
      }
      const frozen = await this.artifacts.readCurrent(labId)
      if (!sameConfigRef(state.config, frozen.ref)) {
        throw new AutoLabRuntimeError(`Lab ${labId} CURRENT does not match RuntimeState`, 'CONFIG_DRIFT')
      }
      const revision = frozen.ref.revision + 1
      const config = parseDraftLabYaml(input.configText)
      const dialogueHead = await this.dialogue.appendControllerRecord({
        labId,
        controllerSessionId: state.controllerSessionId,
        timestamp: Date.now(),
        recordKind: 'acceptance',
        payload: { action: 'commit_revision', revision },
        relatedRevision: revision,
      })
      const rolePromptHashes = Object.fromEntries(config.roles.map(role => [
        role.role_id,
        rolePromptFor(role.role_kind).sha256,
      ]))
      const manifest = resolveDraftLabConfig(config, {
        lab_id: labId,
        revision,
        controller_session_id: state.controllerSessionId,
        dialogue_head_sha256: dialogueHead.recordHash,
        lab_spec_sha256: sha256(input.specText),
        lab_yaml_sha256: sha256(input.configText),
        lab_directory: this.artifacts.labDirectory(labId),
        autolab_plugin_version: AUTOLAB_PLUGIN_VERSION,
        dsh_version: DSH_COMPATIBILITY_VERSION,
        repository_base_sha: frozen.manifest.repository.base_sha,
        lane_base_shas: Object.fromEntries(frozen.manifest.lanes.map(lane => [
          lane.lane_id,
          lane.base_sha,
        ])),
        role_prompt_sha256: rolePromptHashes,
      })
      assertRevisionTopologyUnchanged(frozen.manifest, manifest)
      signal?.throwIfAborted()
      const next = await this.artifacts.freezeConfigRevision({
        labId,
        revision,
        spec: input.specText,
        config: input.configText,
        manifest,
        dialogueHeadHash: dialogueHead.recordHash,
      })
      // Sync the lane charter authority files to the new revision's content so
      // every packet compiled afterwards binds the updated charters (identical
      // bytes freeze idempotently; historical packets carry their own blocks).
      for (const charter of manifest.search.lane_charters) {
        const charterPath = join(
          this.artifacts.labDirectory(labId),
          'artifacts',
          'lanes',
          `${sha256(charter.lane_id)}.charter.json`,
        )
        await durableWriteFile(charterPath, canonicalJson(charter.content), true)
      }
      state = await this.transition(
        state,
        state.lifecycle,
        undefined,
        next.ref,
      )
      await this.dialogue.appendControllerRecord({
        labId,
        controllerSessionId: state.controllerSessionId,
        timestamp: Date.now(),
        recordKind: 'configure_action',
        payload: {
          action: 'revision_committed',
          revision: next.ref.revision,
          specHash: next.ref.specHash,
          configHash: next.ref.configHash,
          manifestHash: next.ref.manifestHash,
          dialogueHeadHash: next.ref.dialogueHeadHash,
        },
        relatedRevision: next.ref.revision,
      })
      return {
        labId,
        revision: next.ref.revision,
        specHash: next.ref.specHash,
        configHash: next.ref.configHash,
        manifestHash: next.ref.manifestHash,
      }
    })
  }

  status(caller: Agent, labId: string): RuntimeState {
    this.assertReady()
    const state = this.requireState(validateLabId(labId))
    this.assertControllerSession(caller, state)
    return cloneState(state)
  }

  reveal(caller: Agent, labId: string, signal?: AbortSignal): Promise<ControllerRevealResult> {
    return this.enqueue(labId, async () => {
      signal?.throwIfAborted()
      let state = this.requireState(validateLabId(labId))
      this.assertControllerSession(caller, state)
      if (state.config === undefined
        || (state.lifecycle !== 'running' && state.lifecycle !== 'paused')) {
        throw new AutoLabRuntimeError(
          `Lab ${labId} must be running or paused before reveal`,
          'NOT_READY',
        )
      }
      const frozen = await this.artifacts.readCurrent(labId)
      if (!sameConfigRef(state.config, frozen.ref)) {
        throw new AutoLabRuntimeError(`Lab ${labId} CURRENT does not match RuntimeState`, 'CONFIG_DRIFT')
      }
      if (state.revealState !== 'revealed') {
        state = await this.transition(
          state,
          state.lifecycle,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          'revealed',
        )
      }
      const workers = frozen.manifest.roles.filter(
        (role): role is RootRoleBinding => role.role_kind !== 'controller',
      )
      const attached = await this.readAttachedRoles(state, frozen, workers)
      await this.reconcileCommunicationAcl(caller, state, frozen, attached, signal)
      return {
        labId: state.labId,
        revealState: 'revealed',
        runtimeRevision: state.runtimeRevision,
      }
    })
  }

  /**
   * Freeze the exact Method receipt selected by its current Role Packet, then
   * commit one owner-fenced Preflight review before sending its typed request.
   * No caller-supplied path, control envelope, or target Session is accepted.
   */
  submitMethodForPreflightReview(
    caller: Agent,
    signal?: AbortSignal,
  ): Promise<RoleSubmissionResult> {
    const labId = this.resolveExactRoleCaller(caller).state.labId
    const sourceTurn = observeOpenAgentTurn(caller)
    if (sourceTurn === undefined) {
      throw new AutoLabRuntimeError(
        'Method review submission requires the exact open caller turn',
        'REVIEW_NOT_READY',
      )
    }
    return this.enqueue(labId, async () => {
      signal?.throwIfAborted()
      let { state, roleId } = this.resolveExactRoleCaller(caller)
      const existing = Object.values(state.reviews).find(review => (
        review.capability.workerRoleId === roleId
        && review.phase === 'reviewing'
      ))
      if (existing !== undefined) {
        if (existing.stage !== 'preflight'
          || state.roles[roleId]?.phase !== 'reviewing'
          || state.roles[roleId]?.goalInstall?.assignmentId
            !== existing.capability.assignmentId) {
          throw new AutoLabRuntimeError(
            `Role ${roleId} already has a non-replayable review state`,
            'REVIEW_NOT_READY',
          )
        }
        await this.dispatchReviewRequest(caller, existing.capability, signal)
        return roleSubmissionResult(state.labId, existing.capability, 'reviewing')
      }

      const methodState = state.roles[roleId]!
      if (state.lifecycle !== 'running'
        || methodState.phase !== 'working'
        || methodState.packet === undefined
        || methodState.binding === undefined
        || methodState.goalInstall?.status !== 'applied') {
        throw new AutoLabRuntimeError(
          `Method role ${roleId} is not an active review candidate`,
          'REVIEW_NOT_READY',
        )
      }
      const frozen = await this.artifacts.readCurrent(state.labId)
      if (!sameConfigRef(state.config, frozen.ref)) {
        throw new AutoLabRuntimeError(
          `Lab ${state.labId} CURRENT does not match RuntimeState`,
          'CONFIG_DRIFT',
        )
      }
      const methodRole = frozen.manifest.roles.find(role => role.role_id === roleId)
      if (methodRole?.role_kind !== 'method') {
        throw new AutoLabRuntimeError(
          `Role ${roleId} is not a Method role in CURRENT`,
          'CONFIG_DRIFT',
        )
      }
      const lane = frozen.manifest.lanes.find(value => (
        value.lane_id === methodRole.lane_id && value.method_role_id === roleId
      ))
      if (lane === undefined) {
        throw new AutoLabRuntimeError(
          `Method role ${roleId} has no exact Lane binding`,
          'CONFIG_DRIFT',
        )
      }
      const judgeState = state.roles[lane.preflight_judge_role_id]
      if (judgeState?.activationBlocker !== undefined) {
        throw new AutoLabRuntimeError(
          `Preflight Judge ${lane.preflight_judge_role_id} is unavailable: ${judgeState.activationBlocker.message}`,
          'ROLE_ACTIVATION_UNAVAILABLE',
        )
      }
      if (judgeState?.binding === undefined || judgeState.packet === undefined) {
        throw new AutoLabRuntimeError(
          `Preflight Judge ${lane.preflight_judge_role_id} is not bound`,
          'REVIEW_NOT_READY',
        )
      }
      const judgeBinding = await readRoleBinding(
        frozen.manifest.authority_paths.lab_dir,
        lane.preflight_judge_role_id,
      )
      if (judgeBinding === undefined
        || judgeBinding.path !== judgeState.binding.path
        || judgeBinding.hash !== judgeState.binding.hash) {
        throw new AutoLabRuntimeError(
          `Preflight Judge ${lane.preflight_judge_role_id} binding drifted`,
          'CONFIG_DRIFT',
        )
      }

      const plannedRevision = state.runtimeRevision + 1
      const reviewId = deterministicReviewId([
        state.labId,
        String(frozen.ref.revision),
        roleId,
        methodState.goalInstall.assignmentId,
        methodState.packet.hash,
        String(plannedRevision),
      ])
      const reviewRoot = join(
        frozen.manifest.authority_paths.lab_dir,
        'artifacts',
        'reviews',
        reviewId,
      )
      const ticket = await freezeMethodDesignTicket({
        rolePacketPath: methodState.packet.path,
        rolePacketHash: methodState.packet.hash,
        reviewArtifactPath: join(reviewRoot, 'method-ticket.json'),
      })
      if (ticket.assignmentId !== methodState.goalInstall.assignmentId) {
        throw new AutoLabRuntimeError(
          `Method receipt belongs to ${ticket.assignmentId}, not the active Assignment`,
          'CONFIG_DRIFT',
        )
      }
      const reviewArtifacts = await freezePreflightReviewArtifacts({
        frozen,
        judgeSessionId: judgeState.sessionId,
        judgeBinding,
        sourceMethodAssignment: {
          path: ticket.sourceAssignmentPath,
          sha256: ticket.sourceAssignmentHash,
        },
        sourceMethodPacket: {
          path: ticket.rolePacketPath,
          sha256: ticket.rolePacketHash,
        },
        designTicket: {
          path: ticket.artifactPath,
          sha256: ticket.artifactHash,
        },
        reviewId,
        runtimeRevision: plannedRevision,
        issuedAt: state.updatedAt,
      })
      const liveGoal = this.ctx.goals.get(caller)
      if (liveGoal === undefined
        || String(liveGoal.id) !== methodState.goalInstall.goalId
        || sha256(liveGoal.objective) !== methodState.goalInstall.objectiveHash) {
        throw new AutoLabRuntimeError(
          `Method role ${roleId} no longer owns its persisted Assignment Goal`,
          'REVIEW_NOT_READY',
        )
      }
      const capability = compileReviewControlCapability({
        reviewId,
        assignmentId: ticket.assignmentId,
        configRevision: frozen.ref.revision,
        runtimeRevision: plannedRevision,
        ownerFence: this.requireOwner().owner.token,
        workerRoleId: roleId,
        workerSessionId: methodState.sessionId,
        judgeRoleId: lane.preflight_judge_role_id,
        judgeSessionId: judgeState.sessionId,
        packetHash: reviewArtifacts.packet.packetHash,
        artifactHash: ticket.artifactHash,
        negotiatedAnchorHash: reviewArtifacts.reviewInputHash,
        sourceTurn,
        expectedGoalRef: {
          id: String(liveGoal.id),
          revision: liveGoal.revision,
        },
        requestControlId: randomUUID(),
        acceptedPauseControlId: randomUUID(),
      })
      const now = Date.now()
      const roles = structuredClone(state.roles)
      roles[roleId] = { ...methodState, phase: 'reviewing' }
      const reviews = structuredClone(state.reviews)
      reviews[reviewId] = {
        stage: 'preflight',
        phase: 'reviewing',
        sourcePacket: {
          path: methodState.packet.path,
          hash: methodState.packet.hash,
        },
        packetPath: reviewArtifacts.packetPath,
        artifactPath: ticket.artifactPath,
        capability,
        pause: {
          controlId: capability.acceptedPause.controlId,
          payloadHash: capability.acceptedPause.payloadHash,
          freeze: 'pending',
        },
        createdAt: now,
        updatedAt: now,
      }
      state = await this.transition(
        state,
        state.lifecycle,
        undefined,
        undefined,
        roles,
        reviews,
      )
      await this.dispatchReviewRequest(caller, capability, signal)
      return roleSubmissionResult(state.labId, capability, 'reviewing')
    })
  }

  /**
   * Freeze and project the exact receipt selected by the calling Judge's
   * current review. Verdict persistence is independent from worker freezing:
   * this method never releases a review hold or activates another Goal.
   */
  submitPreflightVerdict(
    caller: Agent,
    signal?: AbortSignal,
  ): Promise<PreflightVerdictResult> {
    const labId = this.resolveExactRoleCaller(caller).state.labId
    return this.enqueue(labId, async () => {
      signal?.throwIfAborted()
      const { state, roleId } = this.resolveExactRoleCaller(caller)
      const selected = selectJudgeReview(state, roleId)
      if (selected === undefined || selected.review.stage !== 'preflight') {
        throw new AutoLabRuntimeError(
          `Judge role ${roleId} has no unambiguous Preflight review`,
          'REVIEW_NOT_READY',
        )
      }
      const { reviewId, review } = selected
      const artifactPath = join(dirname(review.artifactPath), 'preflight-verdict.json')
      const frozen = await freezePreflightVerdict({
        rolePacketPath: review.packetPath,
        rolePacketHash: review.capability.packetHash,
        artifactPath,
      })
      signal?.throwIfAborted()
      if (frozen.verdict.review_id !== reviewId
        || frozen.verdict.review_input_sha256 !== review.capability.negotiatedAnchorHash
        || frozen.packet.header.session_id !== review.capability.judgeSessionId) {
        throw new AutoLabRuntimeError(
          `Preflight verdict does not match review ${reviewId}`,
          'CONFIG_DRIFT',
        )
      }

      const phase = frozen.verdict.top_level_verdict === 'REVIEW_ERROR'
        ? 'error' as const
        : 'verdict_recorded' as const
      const existing = review.verdict
      if (existing !== undefined) {
        if (existing.path !== artifactPath
          || existing.hash !== frozen.receiptHash
          || existing.assignmentId !== frozen.verdict.assignment_id
          || existing.reviewInputHash !== frozen.verdict.review_input_sha256
          || existing.topLevelVerdict !== frozen.verdict.top_level_verdict
          || review.phase !== phase) {
          throw new AutoLabRuntimeError(
            `Preflight review ${reviewId} already records a different verdict`,
            'CONFIG_DRIFT',
          )
        }
        return preflightVerdictResult(
          state.labId,
          roleId,
          reviewId,
          existing.assignmentId,
          review.phase,
          existing.topLevelVerdict,
        )
      }

      const now = Date.now()
      const reviews = structuredClone(state.reviews)
      reviews[reviewId] = {
        ...review,
        phase,
        verdict: {
          path: artifactPath,
          hash: frozen.receiptHash,
          assignmentId: frozen.verdict.assignment_id,
          reviewInputHash: frozen.verdict.review_input_sha256,
          topLevelVerdict: frozen.verdict.top_level_verdict,
          recordedAt: now,
        },
        updatedAt: now,
      }
      const recorded = await this.transition(
        state,
        state.lifecycle,
        undefined,
        undefined,
        undefined,
        reviews,
      )
      await this.wakeControllerForEvent(
        recorded,
        `preflight-verdict:${reviewId}:${frozen.receiptHash}`,
        [
          `AutoLab ${state.labId} Preflight review ${reviewId} recorded ${frozen.verdict.top_level_verdict}.`,
          `Read the complete original verdict at ${artifactPath} (sha256 ${frozen.receiptHash}) and decide the next responsibility from CURRENT.`,
        ].join('\n'),
      )
      return preflightVerdictResult(
        state.labId,
        roleId,
        reviewId,
        frozen.verdict.assignment_id,
        phase,
        frozen.verdict.top_level_verdict,
      )
    })
  }

  /** Freeze one Postflight Judge receipt as opaque bytes and project only its identity. */
  submitPostflightResult(
    caller: Agent,
    signal?: AbortSignal,
  ): Promise<PostflightResultSubmission> {
    const labId = this.resolveExactRoleCaller(caller).state.labId
    return this.enqueue(labId, async () => {
      signal?.throwIfAborted()
      const { state, roleId } = this.resolveExactRoleCaller(caller)
      const selected = selectJudgeReview(state, roleId)
      if (selected === undefined || selected.review.stage !== 'postflight') {
        throw new AutoLabRuntimeError(
          `Judge role ${roleId} has no unambiguous Postflight review`,
          'REVIEW_NOT_READY',
        )
      }
      const { reviewId, review } = selected
      if (!reviewFreezeComplete(review, state.ownerEpoch)) {
        throw new AutoLabRuntimeError(
          `Postflight review ${reviewId} has not completed its one review pause`,
          'REVIEW_NOT_READY',
        )
      }
      const frozenRevision = await this.artifacts.readCurrent(state.labId)
      if (!sameConfigRef(state.config, frozenRevision.ref)) {
        throw new AutoLabRuntimeError(
          `Lab ${state.labId} CURRENT does not match RuntimeState`,
          'CONFIG_DRIFT',
        )
      }
      const artifactPath = join(
        frozenRevision.manifest.authority_paths.lab_dir,
        'artifacts',
        'reviews',
        reviewId,
        'postflight-result.raw',
      )
      const frozen = await freezePostflightResult({
        rolePacketPath: review.packetPath,
        rolePacketHash: review.capability.packetHash,
        artifactPath,
      })
      signal?.throwIfAborted()
      if (frozen.packet.header.lab_id !== state.labId
        || frozen.packet.header.role_id !== roleId
        || frozen.packet.header.session_id !== review.capability.judgeSessionId
        || frozen.packet.header.assignment_id !== review.capability.assignmentId
        || frozen.packet.anchors.source_revision !== review.capability.configRevision
        || frozen.expectedHashBinding !== review.capability.negotiatedAnchorHash) {
        throw new AutoLabRuntimeError(
          `Postflight result does not match review ${reviewId}`,
          'CONFIG_DRIFT',
        )
      }

      const existing = review.result
      if (existing !== undefined) {
        if (review.phase !== 'result_recorded'
          || existing.path !== artifactPath
          || existing.hash !== frozen.receiptHash
          || existing.assignmentId !== frozen.packet.header.assignment_id
          || existing.reviewInputHash !== frozen.expectedHashBinding) {
          throw new AutoLabRuntimeError(
            `Postflight review ${reviewId} already records another result`,
            'CONFIG_DRIFT',
          )
        }
        await this.wakeControllerForEvent(
          state,
          `postflight-result:${reviewId}:${frozen.receiptHash}`,
          postflightControllerEventText(state.labId, reviewId, artifactPath, frozen.receiptHash),
        )
        const retainedHold = this.reviewHolds.get(reviewHoldKey(state.labId, reviewId))
        if (retainedHold !== undefined) {
          this.reviewHolds.delete(reviewHoldKey(state.labId, reviewId))
          await retainedHold.release()
        }
        return postflightResultSubmission(
          state.labId,
          roleId,
          reviewId,
          existing.assignmentId,
        )
      }

      const now = Date.now()
      const worker = state.roles[review.capability.workerRoleId]
      if (worker === undefined
        || worker.sessionId !== review.capability.workerSessionId) {
        throw new AutoLabRuntimeError(
          `Postflight review ${reviewId} lost its reviewed Coder identity`,
          'CONFIG_DRIFT',
        )
      }
      const completedPause = review.pause.freeze === 'held'
        ? (() => {
            const { holdOwnerEpoch: _owner, ...pause } = review.pause
            return { ...pause, freeze: 'stopped' as const }
          })()
        : review.pause
      const roles = structuredClone(state.roles)
      // The review result is the truthful record of the frozen Attempt. If the
      // Coder is still paused in the reviewed phase, recording returns it to
      // `paused`; if the Coder has meanwhile moved on to another Assignment,
      // the result still records and the live phase is left untouched.
      if (worker.phase === 'reviewing') {
        roles[review.capability.workerRoleId] = { ...worker, phase: 'paused' }
      }
      const reviews = structuredClone(state.reviews)
      reviews[reviewId] = {
        ...review,
        phase: 'result_recorded',
        pause: completedPause,
        result: {
          path: artifactPath,
          hash: frozen.receiptHash,
          assignmentId: frozen.packet.header.assignment_id,
          reviewInputHash: frozen.expectedHashBinding,
          recordedAt: now,
        },
        updatedAt: now,
      }
      const recorded = await this.transition(
        state,
        state.lifecycle,
        undefined,
        undefined,
        roles,
        reviews,
      )
      await this.wakeControllerForEvent(
        recorded,
        `postflight-result:${reviewId}:${frozen.receiptHash}`,
        postflightControllerEventText(state.labId, reviewId, artifactPath, frozen.receiptHash),
      )
      const retainedHold = this.reviewHolds.get(reviewHoldKey(state.labId, reviewId))
      if (retainedHold !== undefined) {
        this.reviewHolds.delete(reviewHoldKey(state.labId, reviewId))
        await retainedHold.release()
      }
      return postflightResultSubmission(
        state.labId,
        roleId,
        reviewId,
        frozen.packet.header.assignment_id,
      )
    })
  }

  /** Preserve one Controller-dispatched Ops/Coordinator receipt as opaque bytes. */
  async submitAutoLabRoleResult(
    caller: Agent,
    signal?: AbortSignal,
  ): Promise<AutoLabRoleResultSubmission> {
    const labId = this.resolveExactRoleCaller(caller).state.labId
    const prepared = await this.enqueue(labId, async () => {
      signal?.throwIfAborted()
      const { state, roleId } = this.resolveExactRoleCaller(caller)
      const projected = state.roles[roleId]!
      const frozen = await this.artifacts.readCurrent(state.labId)
      if (state.lifecycle !== 'running'
        || state.config === undefined
        || !sameConfigRef(state.config, frozen.ref)) {
        throw new AutoLabRuntimeError(
          `Lab ${state.labId} is not running on CURRENT`,
          'NOT_READY',
        )
      }
      const role = frozen.manifest.roles.find(value => value.role_id === roleId)
      if (role === undefined
        || role.role_kind === 'controller'
        || (role.role_kind !== 'ops' && role.role_kind !== 'coordinator')) {
        throw new AutoLabRuntimeError(
          `Role ${roleId} must use its dedicated submission protocol`,
          'ROLE_MISMATCH',
        )
      }
      const install = projected.goalInstall
      if (projected.packet === undefined
        || install?.status !== 'applied') {
        throw new AutoLabRuntimeError(
          `Role ${roleId} has no active Controller Assignment`,
          'IMPLEMENTATION_NOT_READY',
        )
      }
      if (projected.receipt !== undefined) {
        if (projected.phase !== 'paused'
          || projected.receipt.assignmentId !== install.assignmentId) {
          throw new AutoLabRuntimeError(
            `Role ${roleId} receipt does not match its active Assignment`,
            'CONFIG_DRIFT',
          )
        }
        return {
          completed: autoLabRoleResultSubmission(state.labId, roleId, install.assignmentId),
          receipt: projected.receipt,
        } as const
      }
      if (projected.phase !== 'working') {
        throw new AutoLabRuntimeError(
          `Role ${roleId} is not working on a result-bearing Assignment`,
          'IMPLEMENTATION_NOT_READY',
        )
      }
      assertLiveAssignmentGoal(this.ctx, caller, projected, roleId, 'AutoLab')
      return {
        labId: state.labId,
        roleId,
        sessionId: projected.sessionId,
        assignmentId: install.assignmentId,
        packet: projected.packet,
        goalInstall: install,
        config: state.config,
        artifactPath: join(
          frozen.manifest.authority_paths.lab_dir,
          'artifacts',
          'role-results',
          sha256(roleId),
          `${sha256(install.assignmentId)}.raw`,
        ),
      } satisfies PreparedRoleResultSubmission
    })
    if ('completed' in prepared) {
      if (prepared.receipt === undefined) {
        throw new AutoLabRuntimeError('recorded role result lost its receipt', 'CONFIG_DRIFT')
      }
      await this.finalizeRoleResultNotification(
        caller,
        prepared.completed,
        prepared.receipt.path,
        prepared.receipt.hash,
      )
      return prepared.completed
    }

    const frozenReceipt = await freezeRoleAssignmentReceipt({
      rolePacketPath: prepared.packet.path,
      rolePacketHash: prepared.packet.hash,
      artifactPath: prepared.artifactPath,
    })
    signal?.throwIfAborted()
    if (frozenReceipt.assignmentId !== prepared.assignmentId
      || frozenReceipt.roleId !== prepared.roleId
      || frozenReceipt.sessionId !== prepared.sessionId
      || frozenReceipt.expectedHashBinding !== prepared.assignmentId) {
      throw new AutoLabRuntimeError(
        `Role ${prepared.roleId} receipt does not match its exact Assignment Packet`,
        'CONFIG_DRIFT',
      )
    }

    const recorded = await this.enqueue(labId, async () => {
      signal?.throwIfAborted()
      const { state, roleId } = this.resolveExactRoleCaller(caller)
      const projected = state.roles[roleId]!
      if (roleId !== prepared.roleId
        || canonicalJson(state.config) !== canonicalJson(prepared.config)
        || projected.phase !== 'working'
        || canonicalJson(projected.packet) !== canonicalJson(prepared.packet)
        || canonicalJson(projected.goalInstall) !== canonicalJson(prepared.goalInstall)
        || projected.receipt !== undefined) {
        throw new AutoLabRuntimeError(
          `Role ${prepared.roleId} Assignment changed while freezing its receipt`,
          'CONFIG_DRIFT',
        )
      }
      assertLiveAssignmentGoal(this.ctx, caller, projected, roleId, 'AutoLab')
      const receipt = {
        assignmentId: prepared.assignmentId,
        path: prepared.artifactPath,
        hash: frozenReceipt.receiptHash,
        recordedAt: Date.now(),
      }
      const roles = structuredClone(state.roles)
      roles[roleId] = { ...projected, phase: 'paused', receipt }
      await this.transition(
        state,
        state.lifecycle,
        undefined,
        undefined,
        roles,
      )
      return receipt
    })
    const result = autoLabRoleResultSubmission(labId, prepared.roleId, prepared.assignmentId)
    await this.finalizeRoleResultNotification(caller, result, recorded.path, recorded.hash)
    return result
  }

  /**
   * Apply only the APPROVED Preflight route explicitly selected by Controller.
   * Runtime compiles and installs identities; it never compares methods or
   * chooses which verdict should advance.
   */
  async applyPreflight(
    caller: Agent,
    input: ControllerApplyPreflightInput,
    signal?: AbortSignal,
  ): Promise<ControllerApplyPreflightResult> {
    const labId = validateLabId(input.labId)
    if (input.reviewId.trim().length === 0) {
      throw new AutoLabRuntimeError('reviewId must be non-empty', 'REVIEW_NOT_READY')
    }

    const prepared = await this.enqueue(labId, async () => {
      signal?.throwIfAborted()
      let state = this.requireState(labId)
      this.assertControllerSession(caller, state)
      const review = state.reviews[input.reviewId]
      if (state.lifecycle !== 'running'
        || state.config === undefined
        || review?.stage !== 'preflight'
        || review.verdict?.topLevelVerdict !== 'APPROVED') {
        throw new AutoLabRuntimeError(
          `Review ${input.reviewId} is not an APPROVED Preflight route in a running Lab`,
          'REVIEW_NOT_READY',
        )
      }

      const frozen = await this.artifacts.readCurrent(labId)
      if (!sameConfigRef(state.config, frozen.ref)) {
        throw new AutoLabRuntimeError(`Lab ${labId} CURRENT does not match RuntimeState`, 'CONFIG_DRIFT')
      }
      const lane = frozen.manifest.lanes.find(value => (
        value.method_role_id === review.capability.workerRoleId
        && value.preflight_judge_role_id === review.capability.judgeRoleId
      ))
      const coderRole = lane === undefined
        ? undefined
        : frozen.manifest.roles.find(value => value.role_id === lane.coder_role_id)
      if (lane === undefined || coderRole?.role_kind !== 'coder') {
        throw new AutoLabRuntimeError(
          `Review ${input.reviewId} does not resolve to one CURRENT Coder`,
          'CONFIG_DRIFT',
        )
      }
      const coder = state.roles[coderRole.role_id]
      if (coder?.binding === undefined || coder.packet === undefined) {
        throw new AutoLabRuntimeError(
          `Coder role ${coderRole.role_id} is not durably activated`,
          'ROLE_ACTIVATION_UNAVAILABLE',
        )
      }
      if (review.resolution !== undefined) {
        const selected = selectApprovedCoderReview(state, coderRole.role_id, coder)
        if (selected?.reviewId !== input.reviewId || coder.goalInstall?.status !== 'applied') {
          throw new AutoLabRuntimeError(
            `Review ${input.reviewId} resolution does not match its Coder Goal`,
            'CONFIG_DRIFT',
          )
        }
        return {
          completed: controllerApplyPreflightResult(state.labId, input.reviewId, coderRole.role_id),
        } as const
      }
      if (!reviewFreezeComplete(review, state.ownerEpoch)) {
        throw new AutoLabRuntimeError(
          `Review ${input.reviewId} worker freeze is not complete`,
          'REVIEW_NOT_READY',
        )
      }
      const binding = await readRoleBinding(frozen.manifest.authority_paths.lab_dir, coderRole.role_id)
      if (binding === undefined
        || binding.path !== coder.binding.path
        || binding.hash !== coder.binding.hash) {
        throw new AutoLabRuntimeError(`Coder role ${coderRole.role_id} binding drifted`, 'CONFIG_DRIFT')
      }
      const expectedGoalRef = coder.goalInstall?.goalId === undefined
        ? null
        : {
            id: GoalId(coder.goalInstall.goalId),
            revision: coder.goalInstall.goalRevision!,
          }

      let plan: ApprovedCoderActivationPlan
      if (coder.goalInstall?.status === 'activating'
        && coder.goalInstall.assignmentId === `coder:${input.reviewId}`) {
        const restored = await restoreCurrentRoleArtifacts({
          frozen,
          role: coderRole,
          sessionId: coder.sessionId,
          binding,
          runtimeRevision: state.runtimeRevision,
          packetRef: coder.packet,
        })
        plan = compileApprovedCoderActivation({
          reviewId: input.reviewId,
          verdictHash: review.verdict.hash,
          coderRoleId: coderRole.role_id,
          coderSessionId: coder.sessionId,
          assignmentId: restored.assignmentId,
          packetPath: restored.packetPath,
          packetHash: restored.packet.packetHash,
          objectiveBody: restored.objectiveBody,
          maxGoalRounds: coder.goalInstall.maxGoalRounds,
          expectedGoalRef,
          installId: coder.goalInstall.installId,
        })
      } else {
        const activation = await freezeApprovedCoderActivation({
          artifacts: {
            frozen,
            coderRole,
            coderSessionId: coder.sessionId,
            coderBinding: binding,
            sourceMethodPacket: {
              path: review.sourcePacket.path,
              sha256: review.sourcePacket.hash,
            },
            designTicket: {
              path: review.artifactPath,
              sha256: review.capability.artifactHash,
            },
            preflightVerdict: {
              path: review.verdict.path,
              sha256: review.verdict.hash,
            },
            reviewId: input.reviewId,
            runtimeRevision: state.runtimeRevision,
            issuedAt: review.verdict.recordedAt,
          },
          maxGoalRounds: coderRole.max_goal_rounds,
          expectedGoalRef,
        })
        plan = activation
      }

      const roles = structuredClone(state.roles)
      roles[coderRole.role_id] = stageApprovedCoderActivation(coder, plan)

      // Candidate supersede: a Lane keeps at most one active candidate. When a
      // new APPROVED Coder Assignment supersedes the one that froze the Lane's
      // active candidate, retire the old projection (archive, never delete) so
      // the Coder is free for the next implementation cycle. Trials that were
      // frozen against the retired candidate keep their immutable lineage and
      // their Attempts continue/retry against their own frozen identities.
      let candidates: RuntimeState['candidates'] | undefined
      let retiredCandidates: RuntimeState['retiredCandidates'] | undefined
      const existingCandidate = state.candidates[lane.lane_id]
      if (existingCandidate !== undefined
        && existingCandidate.assignmentId !== plan.goalIntent.assignmentId) {
        candidates = { ...state.candidates }
        delete candidates[lane.lane_id]
        retiredCandidates = {
          ...state.retiredCandidates,
          [existingCandidate.candidateId]: existingCandidate,
        }
      }

      state = await this.transition(
        state,
        state.lifecycle,
        undefined,
        undefined,
        roles,
        undefined,
        candidates,
        undefined,
        undefined,
        undefined,
        retiredCandidates,
      )
      return {
        plan,
        stagedRuntimeRevision: state.runtimeRevision,
        coderRoleId: coderRole.role_id,
        workerRoleId: review.capability.workerRoleId,
      } as const
    })
    if ('completed' in prepared) return prepared.completed

    const installed = await installApprovedCoderGoal(this.ctx, prepared.plan)
    signal?.throwIfAborted()
    const committed = await this.enqueue(labId, async () => {
      signal?.throwIfAborted()
      const state = this.requireState(labId)
      this.assertControllerSession(caller, state)
      if (state.runtimeRevision !== prepared.stagedRuntimeRevision) {
        throw new AutoLabRuntimeError(
          `Lab ${labId} changed while installing its Coder Goal`,
          'CONFIG_DRIFT',
        )
      }
      const coder = state.roles[prepared.coderRoleId]
      const review = state.reviews[input.reviewId]
      const worker = state.roles[prepared.workerRoleId]
      if (coder === undefined || review === undefined || worker === undefined) {
        throw new AutoLabRuntimeError('Preflight route lost its durable role identity', 'CONFIG_DRIFT')
      }
      const roles = structuredClone(state.roles)
      roles[prepared.coderRoleId] = applyApprovedCoderGoal(coder, prepared.plan, installed)
      roles[prepared.workerRoleId] = { ...worker, phase: 'paused' }
      const reviews = structuredClone(state.reviews)
      reviews[input.reviewId] = resolveApprovedCoderReview(
        review,
        state.ownerEpoch,
        prepared.plan,
        Date.now(),
      )
      const next = await this.transition(
        state,
        state.lifecycle,
        undefined,
        undefined,
        roles,
        reviews,
      )
      return {
        state: next,
        hold: this.reviewHolds.get(reviewHoldKey(labId, input.reviewId)),
      }
    })

    if (committed.hold !== undefined) {
      this.reviewHolds.delete(reviewHoldKey(labId, input.reviewId))
      await committed.hold.release()
    }
    return controllerApplyPreflightResult(labId, input.reviewId, prepared.coderRoleId)
  }

  /** Install one explicit Method Assignment, optionally resolving one rejected Preflight review. */
  async assignMethod(
    caller: Agent,
    input: ControllerAssignMethodInput,
    signal?: AbortSignal,
  ): Promise<ControllerAssignMethodResult> {
    const labId = validateLabId(input.labId)
    if (input.methodRoleId.trim().length === 0
      || input.assignmentId.trim().length === 0
      || input.objective.trim().length === 0
      || (input.sourceReviewId !== undefined
        && input.sourceReviewId.trim().length === 0)) {
      throw new AutoLabRuntimeError(
        'methodRoleId, assignmentId, objective, and any sourceReviewId must be non-empty',
        'NOT_READY',
      )
    }
    const content = parseJsonArgument(input.contentJson, 'contentJson') as RoleAssignmentJson
    const inputArtifactRefs = parseRoleAssignmentReferences(input.inputArtifactRefsJson)

    const prepared = await this.enqueue(labId, async () => {
      signal?.throwIfAborted()
      let state = this.requireState(labId)
      this.assertControllerSession(caller, state)
      if (state.lifecycle !== 'running' || state.config === undefined) {
        throw new AutoLabRuntimeError(`Lab ${labId} is not running`, 'NOT_READY')
      }
      const frozen = await this.artifacts.readCurrent(labId)
      if (!sameConfigRef(state.config, frozen.ref)) {
        throw new AutoLabRuntimeError(`Lab ${labId} CURRENT does not match RuntimeState`, 'CONFIG_DRIFT')
      }
      const role = frozen.manifest.roles.find(value => value.role_id === input.methodRoleId)
      if (role?.role_kind !== 'method') {
        throw new AutoLabRuntimeError(
          `Role ${input.methodRoleId} is not a Method role in CURRENT`,
          'ROLE_MISMATCH',
        )
      }
      const projected = state.roles[input.methodRoleId]
      if (projected?.binding === undefined
        || projected.packet === undefined
        || projected.activationBlocker !== undefined) {
        throw new AutoLabRuntimeError(
          `Method role ${input.methodRoleId} is not durably available`,
          'ROLE_ACTIVATION_UNAVAILABLE',
        )
      }
      assertRoleAssignmentMayDispatch(projected.goalInstall, input.assignmentId)
      const binding = await readRoleBinding(
        frozen.manifest.authority_paths.lab_dir,
        input.methodRoleId,
      )
      if (binding === undefined
        || binding.path !== projected.binding.path
        || binding.hash !== projected.binding.hash) {
        throw new AutoLabRuntimeError(`Method role ${input.methodRoleId} binding drifted`, 'CONFIG_DRIFT')
      }
      const sourceReview = input.sourceReviewId === undefined
        ? undefined
        : requireMethodRevisionReview(
            state,
            input.sourceReviewId,
            input.methodRoleId,
            projected.sessionId,
          )
      const sourceReviewVerdict = sourceReview === undefined
        ? undefined
        : {
            path: sourceReview.verdict!.path,
            sha256: sourceReview.verdict!.hash,
          }

      if (projected.goalInstall?.assignmentId === input.assignmentId) {
        const restored = await restoreCurrentRoleArtifacts({
          frozen,
          role,
          sessionId: projected.sessionId,
          binding,
          runtimeRevision: state.runtimeRevision,
          packetRef: projected.packet,
        })
        if (restored.assignmentId !== input.assignmentId
          || restored.objectiveBody !== input.objective) {
          throw new AutoLabRuntimeError(
            `Method Assignment ${input.assignmentId} conflicts with its activating original`,
            'CONFIG_DRIFT',
          )
        }
        assertMethodAssignmentReplay(restored.packet.packet, {
          role,
          sessionId: projected.sessionId,
          assignmentId: input.assignmentId,
          objective: input.objective,
          content,
          inputArtifactRefs,
          ...(input.sourceReviewId === undefined
            ? {}
            : {
                sourceReviewId: input.sourceReviewId,
                sourceReviewVerdict: sourceReviewVerdict!,
              }),
        })
        const install = projected.goalInstall
        const intent = compileLocalGoalIntent({
          installId: install.installId,
          assignmentId: install.assignmentId,
          packetPath: restored.packetPath,
          packetHash: restored.packet.packetHash,
          body: restored.objectiveBody,
          maxGoalRounds: install.maxGoalRounds,
          expectedGoalRef: install.goalId === undefined
            ? null
            : { id: GoalId(install.goalId), revision: install.goalRevision! },
        })
        if (intent.objectiveHash !== install.objectiveHash) {
          throw new AutoLabRuntimeError(
            `Method Assignment ${input.assignmentId} activating Goal identity drifted`,
            'CONFIG_DRIFT',
          )
        }
        const resolution = sourceReview === undefined
          ? undefined
          : compileReviewResolution({
              reviewId: input.sourceReviewId!,
              verdictHash: sourceReview.verdict!.hash,
              targetRoleId: input.methodRoleId,
              targetSessionId: projected.sessionId,
              effect: {
                kind: 'goal_install',
                id: intent.installId,
                hash: intent.objectiveHash,
              },
            })
        if (install.status === 'applied') {
          if (resolution !== undefined) {
            const reviews = structuredClone(state.reviews)
            const resolved = recordReviewResolution(
              sourceReview!,
              state.ownerEpoch,
              resolution,
              Date.now(),
            )
            if (canonicalJson(resolved) !== canonicalJson(sourceReview)) {
              reviews[input.sourceReviewId!] = resolved
              state = await this.transition(
                state,
                state.lifecycle,
                undefined,
                undefined,
                undefined,
                reviews,
              )
            }
          }
          return {
            completed: controllerAssignMethodResult(
              state.labId,
              input.methodRoleId,
              input.assignmentId,
              input.sourceReviewId,
            ),
            hold: input.sourceReviewId === undefined
              ? undefined
              : this.reviewHolds.get(reviewHoldKey(labId, input.sourceReviewId)),
          } as const
        }
        if (sourceReview?.resolution !== undefined) {
          throw new AutoLabRuntimeError(
            `Review ${input.sourceReviewId} records a resolution before its Method Goal is applied`,
            'CONFIG_DRIFT',
          )
        }
        return {
          roleId: input.methodRoleId,
          sessionId: projected.sessionId,
          packet: projected.packet,
          intent,
          resolution,
          sourceReviewId: input.sourceReviewId,
          stagedRuntimeRevision: state.runtimeRevision,
        } as const
      }

      if (sourceReview === undefined) {
        if (projected.phase !== 'paused') {
          throw new AutoLabRuntimeError(
            `Method role ${input.methodRoleId} is ${projected.phase}; the next independent Assignment requires paused`,
            'NOT_READY',
          )
        }
      } else {
        if (projected.phase !== 'reviewing'
          || sourceReview.resolution !== undefined
          || sourceReview.sourcePacket.path !== projected.packet.path
          || sourceReview.sourcePacket.hash !== projected.packet.hash
          || sourceReview.capability.assignmentId !== projected.goalInstall?.assignmentId) {
          throw new AutoLabRuntimeError(
            `Review ${input.sourceReviewId} is not the unresolved current Method responsibility`,
            'REVIEW_NOT_READY',
          )
        }
      }
      const live = this.ctx.agents.get(SessionId(projected.sessionId))
      if (live === undefined) {
        throw new AutoLabRuntimeError(
          `Method Session ${projected.sessionId} is not live`,
          'ROLE_ACTIVATION_UNAVAILABLE',
        )
      }
      const currentGoal = this.ctx.goals.get(live)
      if (currentGoal !== undefined && !roleOwnsExactAssignmentGoal(projected, currentGoal)) {
        throw new AutoLabRuntimeError(
          `Method role ${input.methodRoleId} has another live Goal`,
          'REVIEW_NOT_READY',
        )
      }
      const plannedRevision = state.runtimeRevision + 1
      const artifacts = await freezeMethodAssignment({
        frozen,
        role,
        sessionId: projected.sessionId,
        binding,
        currentPacket: projected.packet,
        currentRevealState: state.revealState
          ?? frozen.manifest.communication.reveal_policy.initial_state,
        assignmentId: input.assignmentId,
        objective: input.objective,
        content,
        inputArtifactRefs,
        ...(input.sourceReviewId === undefined
          ? {}
          : {
              sourceReviewId: input.sourceReviewId,
              sourceReviewVerdict: sourceReviewVerdict!,
            }),
        runtimeRevision: plannedRevision,
        issuedAt: state.updatedAt,
      })
      const intent = compileLocalGoalIntent({
        installId: `${input.assignmentId}:install:1`,
        assignmentId: input.assignmentId,
        packetPath: artifacts.packetPath,
        packetHash: artifacts.packet.packetHash,
        body: artifacts.objectiveBody,
        maxGoalRounds: roleGoalRoundLimit(role),
        expectedGoalRef: currentGoal === undefined
          ? null
          : { id: currentGoal.id, revision: currentGoal.revision },
      })
      const resolution = sourceReview === undefined
        ? undefined
        : compileReviewResolution({
            reviewId: input.sourceReviewId!,
            verdictHash: sourceReview.verdict!.hash,
            targetRoleId: input.methodRoleId,
            targetSessionId: projected.sessionId,
            effect: {
              kind: 'goal_install',
              id: intent.installId,
              hash: intent.objectiveHash,
            },
          })
      const roles = structuredClone(state.roles)
      const { receipt: _oldReceipt, activationBlocker: _oldBlocker, ...base } = projected
      roles[input.methodRoleId] = {
        ...base,
        packet: { path: artifacts.packetPath, hash: artifacts.packet.packetHash },
        goalInstall: {
          installId: intent.installId,
          assignmentId: intent.assignmentId,
          objectiveHash: intent.objectiveHash,
          maxGoalRounds: intent.maxGoalRounds,
          status: 'activating',
          ...(intent.expectedGoalRef === null
            ? {}
            : {
                goalId: String(intent.expectedGoalRef.id),
                goalRevision: intent.expectedGoalRef.revision,
              }),
        },
      }
      state = await this.transition(
        state,
        state.lifecycle,
        undefined,
        undefined,
        roles,
      )
      return {
        roleId: input.methodRoleId,
        sessionId: projected.sessionId,
        packet: roles[input.methodRoleId]!.packet!,
        intent,
        resolution,
        sourceReviewId: input.sourceReviewId,
        stagedRuntimeRevision: state.runtimeRevision,
      } as const
    })

    if ('completed' in prepared) {
      if (prepared.hold !== undefined && input.sourceReviewId !== undefined) {
        this.reviewHolds.delete(reviewHoldKey(labId, input.sourceReviewId))
        await prepared.hold.release()
      }
      return prepared.completed
    }

    const installed = await installLocalGoal(this.ctx, prepared.sessionId, prepared.intent)
    if (installed.outcome === 'already-complete') {
      throw new AutoLabRuntimeError(
        `Method Assignment ${input.assignmentId} Goal is already complete and cannot be reinstalled`,
        'NOT_READY',
      )
    }
    signal?.throwIfAborted()
    const committed = await this.enqueue(labId, async () => {
      signal?.throwIfAborted()
      const state = this.requireState(labId)
      this.assertControllerSession(caller, state)
      const projected = state.roles[prepared.roleId]
      const install = projected?.goalInstall
      if (state.runtimeRevision !== prepared.stagedRuntimeRevision
        || projected === undefined
        || projected.packet?.path !== prepared.packet.path
        || projected.packet.hash !== prepared.packet.hash
        || install?.status !== 'activating'
        || install.installId !== prepared.intent.installId
        || install.assignmentId !== prepared.intent.assignmentId
        || install.objectiveHash !== prepared.intent.objectiveHash
        || installed.objectiveHash !== prepared.intent.objectiveHash) {
        throw new AutoLabRuntimeError(
          `Method Assignment ${input.assignmentId} changed during Goal installation`,
          'CONFIG_DRIFT',
        )
      }
      const roles = structuredClone(state.roles)
      roles[prepared.roleId] = {
        ...projected,
        phase: 'working',
        goalInstall: {
          ...install,
          status: 'applied',
          goalId: String(installed.ref.id),
          goalRevision: installed.ref.revision,
        },
      }
      let reviews: RuntimeState['reviews'] | undefined
      if (prepared.resolution !== undefined && prepared.sourceReviewId !== undefined) {
        const review = requireMethodRevisionReview(
          state,
          prepared.sourceReviewId,
          prepared.roleId,
          prepared.sessionId,
        )
        reviews = structuredClone(state.reviews)
        reviews[prepared.sourceReviewId] = recordReviewResolution(
          review,
          state.ownerEpoch,
          prepared.resolution,
          Date.now(),
        )
      }
      const next = await this.transition(
        state,
        state.lifecycle,
        undefined,
        undefined,
        roles,
        reviews,
      )
      return {
        result: controllerAssignMethodResult(
          next.labId,
          prepared.roleId,
          prepared.intent.assignmentId,
          prepared.sourceReviewId,
        ),
        hold: prepared.sourceReviewId === undefined
          ? undefined
          : this.reviewHolds.get(reviewHoldKey(labId, prepared.sourceReviewId)),
      }
    })
    if (committed.hold !== undefined && prepared.sourceReviewId !== undefined) {
      this.reviewHolds.delete(reviewHoldKey(labId, prepared.sourceReviewId))
      await committed.hold.release()
    }
    return committed.result
  }

  /**
   * Install one Controller-authored Coder implementation-fix Assignment on a
   * paused Coder that owns the Lane's active candidate. The fix inherits the
   * candidate's lineage Preflight review (design ticket + verdict) as its
   * provenance, supersedes the active candidate, and lets the Coder freeze a
   * corrected candidate through the ordinary SubmitCoderImplementation path.
   * No Preflight review is fabricated and no scientific routing happens here:
   * the fix is an implementation continuation of the already-APPROVED design.
   */
  async assignCoderFix(
    caller: Agent,
    input: ControllerAssignCoderFixInput,
    signal?: AbortSignal,
  ): Promise<ControllerAssignCoderFixResult> {
    const labId = validateLabId(input.labId)
    const fix = parseCoderFixAssignmentId(input.assignmentId)
    if (input.coderRoleId.trim().length === 0
      || input.objective.trim().length === 0) {
      throw new AutoLabRuntimeError(
        'coderRoleId, assignmentId, and objective must be non-empty',
        'NOT_READY',
      )
    }
    const content = parseJsonArgument(input.contentJson, 'contentJson') as RoleAssignmentJson
    const inputArtifactRefs = parseRoleAssignmentReferences(input.inputArtifactRefsJson)
    const candidateId = extractFixCandidateId(content, input.assignmentId)

    const prepared = await this.enqueue(labId, async () => {
      signal?.throwIfAborted()
      let state = this.requireState(labId)
      this.assertControllerSession(caller, state)
      if (state.lifecycle !== 'running' || state.config === undefined) {
        throw new AutoLabRuntimeError(`Lab ${labId} is not running`, 'NOT_READY')
      }
      const frozen = await this.artifacts.readCurrent(labId)
      if (!sameConfigRef(state.config, frozen.ref)) {
        throw new AutoLabRuntimeError(`Lab ${labId} CURRENT does not match RuntimeState`, 'CONFIG_DRIFT')
      }
      const role = frozen.manifest.roles.find(value => value.role_id === input.coderRoleId)
      if (role?.role_kind !== 'coder') {
        throw new AutoLabRuntimeError(
          `Role ${input.coderRoleId} is not a Coder role in CURRENT`,
          'ROLE_MISMATCH',
        )
      }
      const projected = state.roles[input.coderRoleId]
      if (projected?.binding === undefined
        || projected.packet === undefined
        || projected.activationBlocker !== undefined
        || projected.goalInstall?.status !== 'applied') {
        throw new AutoLabRuntimeError(
          `Coder role ${input.coderRoleId} is not durably available with an applied Assignment`,
          'ROLE_ACTIVATION_UNAVAILABLE',
        )
      }
      if (projected.phase !== 'paused') {
        throw new AutoLabRuntimeError(
          `Coder role ${input.coderRoleId} is ${projected.phase}; an implementation-fix Assignment requires paused`,
          'IMPLEMENTATION_NOT_READY',
        )
      }
      assertRoleAssignmentMayDispatch(projected.goalInstall, input.assignmentId)
      const lane = frozen.manifest.lanes.find(value => (
        value.lane_id === role.lane_id && value.coder_role_id === input.coderRoleId
      ))
      if (lane === undefined) {
        throw new AutoLabRuntimeError(
          `Coder role ${input.coderRoleId} does not resolve to one CURRENT Lane`,
          'CONFIG_DRIFT',
        )
      }
      const lineage = state.reviews[fix.reviewId]
      if (lineage?.stage !== 'preflight'
        || lineage.verdict?.topLevelVerdict !== 'APPROVED'
        || lineage.resolution?.targetRoleId !== input.coderRoleId
        || lineage.resolution.targetSessionId !== projected.sessionId
        || lineage.resolution.effect.kind !== 'goal_install'
        || lineage.resolution.effect.id !== `coder:${fix.reviewId}:install:1`) {
        throw new AutoLabRuntimeError(
          `Fix Assignment ${JSON.stringify(input.assignmentId)} lineage review is not the exact applied APPROVED Preflight review of Coder ${input.coderRoleId}`,
          'REVIEW_NOT_READY',
        )
      }
      const candidate = state.candidates[lane.lane_id]
      if (candidate === undefined
        || candidate.reviewId !== fix.reviewId
        || candidate.assignmentId !== `coder:${fix.reviewId}`) {
        throw new AutoLabRuntimeError(
          `Fix Assignment ${JSON.stringify(input.assignmentId)} requires the Lane's active candidate frozen under review ${fix.reviewId}`,
          'IMPLEMENTATION_NOT_READY',
        )
      }
      const binding = await readRoleBinding(
        frozen.manifest.authority_paths.lab_dir,
        input.coderRoleId,
      )
      if (binding === undefined
        || binding.path !== projected.binding.path
        || binding.hash !== projected.binding.hash) {
        throw new AutoLabRuntimeError(`Coder role ${input.coderRoleId} binding drifted`, 'CONFIG_DRIFT')
      }
      const artifacts = await freezeCoderFixAssignment({
        frozen,
        coderRole: role,
        coderSessionId: projected.sessionId,
        coderBinding: binding,
        currentPacket: { path: projected.packet.path, hash: projected.packet.hash },
        assignmentId: input.assignmentId,
        reviewId: fix.reviewId,
        objective: input.objective,
        content,
        candidateId,
        inputArtifactRefs,
        sourceMethodPacket: { path: lineage.sourcePacket.path, sha256: lineage.sourcePacket.hash },
        designTicket: { path: lineage.artifactPath, sha256: lineage.capability.artifactHash },
        preflightVerdict: { path: lineage.verdict.path, sha256: lineage.verdict.hash },
        runtimeRevision: state.runtimeRevision,
        issuedAt: Date.now(),
      })
      const intent = compileLocalGoalIntent({
        installId: `${input.assignmentId}:install:1`,
        assignmentId: input.assignmentId,
        packetPath: artifacts.packetPath,
        packetHash: artifacts.packet.packetHash,
        body: artifacts.objectiveBody,
        maxGoalRounds: role.max_goal_rounds,
        expectedGoalRef: projected.goalInstall?.goalId === undefined
          ? currentLiveGoalRef(this.ctx, projected.sessionId)
          : {
              id: GoalId(projected.goalInstall.goalId),
              revision: projected.goalInstall.goalRevision!,
            },
      })
      const roles = structuredClone(state.roles)
      roles[input.coderRoleId] = roleStateSchema.parse({
        ...projected,
        packet: { path: artifacts.packetPath, hash: artifacts.packet.packetHash },
        goalInstall: {
          installId: intent.installId,
          assignmentId: intent.assignmentId,
          objectiveHash: intent.objectiveHash,
          maxGoalRounds: intent.maxGoalRounds,
          status: 'activating' as const,
        },
      })
      // Candidate supersede: the fix cycle replaces the Lane's active capture.
      // The retired map keeps the latest retired generation per candidate id;
      // older generations remain immutable in the candidate artifacts.
      const candidates: RuntimeState['candidates'] = { ...state.candidates }
      delete candidates[lane.lane_id]
      const retiredCandidates: RuntimeState['retiredCandidates'] = {
        ...state.retiredCandidates,
        [candidate.candidateId]: candidate,
      }
      state = await this.transition(
        state,
        state.lifecycle,
        undefined,
        undefined,
        roles,
        undefined,
        candidates,
        undefined,
        undefined,
        undefined,
        retiredCandidates,
      )
      return {
        roleId: input.coderRoleId,
        sessionId: projected.sessionId,
        intent,
        packet: { path: artifacts.packetPath, hash: artifacts.packet.packetHash },
        stagedRuntimeRevision: state.runtimeRevision,
      } as const
    })

    const installed = await installLocalGoal(this.ctx, prepared.sessionId, prepared.intent)
    signal?.throwIfAborted()
    const committed = await this.enqueue(labId, async () => {
      signal?.throwIfAborted()
      const state = this.requireState(labId)
      this.assertControllerSession(caller, state)
      const projected = state.roles[prepared.roleId]
      const install = projected?.goalInstall
      if (state.runtimeRevision !== prepared.stagedRuntimeRevision
        || projected === undefined
        || projected.packet?.path !== prepared.packet.path
        || projected.packet.hash !== prepared.packet.hash
        || install?.status !== 'activating'
        || install.installId !== prepared.intent.installId
        || install.assignmentId !== prepared.intent.assignmentId
        || install.objectiveHash !== prepared.intent.objectiveHash
        || installed.objectiveHash !== prepared.intent.objectiveHash) {
        throw new AutoLabRuntimeError(
          `Coder fix Assignment ${input.assignmentId} changed during Goal installation`,
          'CONFIG_DRIFT',
        )
      }
      const roles = structuredClone(state.roles)
      roles[prepared.roleId] = {
        ...projected,
        phase: 'working',
        goalInstall: {
          ...install,
          status: 'applied',
          goalId: String(installed.ref.id),
          goalRevision: installed.ref.revision,
        },
      }
      const next = await this.transition(
        state,
        state.lifecycle,
        undefined,
        undefined,
        roles,
      )
      return controllerAssignCoderFixResult(
        next.labId,
        prepared.roleId,
        prepared.intent.assignmentId,
        fix.reviewId,
      )
    })
    return committed
  }

  /** Register one user decision as an immutable fact in the Lab fact set. */
  async registerUserDirective(
    caller: Agent,
    input: ControllerRegisterUserDirectiveInput,
    signal?: AbortSignal,
  ): Promise<ControllerRegisterUserDirectiveResult> {
    const labId = validateLabId(input.labId)
    const registered = await this.enqueue(labId, async () => {
      signal?.throwIfAborted()
      const state = this.requireState(labId)
      this.assertControllerSession(caller, state)
      if (state.lifecycle !== 'running' || state.config === undefined) {
        throw new AutoLabRuntimeError(`Lab ${labId} is not running`, 'NOT_READY')
      }
      const frozen = await this.artifacts.readCurrent(labId)
      if (!sameConfigRef(state.config, frozen.ref)) {
        throw new AutoLabRuntimeError(`Lab ${labId} CURRENT does not match RuntimeState`, 'CONFIG_DRIFT')
      }
      const result = await registerFact({
        factPath: frozen.manifest.authority_paths.fact_set,
        factId: input.factId,
        kind: input.kind,
        statement: input.statement,
        source: input.source,
        evidenceStatus: input.evidenceStatus,
        registeredBy: `controller:${state.controllerSessionId}`,
        registeredAt: Date.now(),
      })
      return {
        labId,
        factPath: result.factPath,
        factSetSha256: result.factSetSha256,
        factIndex: result.factIndex,
        runtimeRevision: state.runtimeRevision,
      }
    })
    return registered
  }

  /** Install exactly one Controller-authored Ops/Coordinator Assignment. */
  async assignRole(
    caller: Agent,
    input: ControllerAssignRoleInput,
    signal?: AbortSignal,
  ): Promise<ControllerAssignRoleResult> {
    const labId = validateLabId(input.labId)
    if (input.roleId.trim().length === 0
      || input.assignmentId.trim().length === 0
      || input.objective.trim().length === 0) {
      throw new AutoLabRuntimeError(
        'roleId, assignmentId, and objective must be non-empty',
        'NOT_READY',
      )
    }
    const content = parseJsonArgument(input.contentJson, 'contentJson') as RoleAssignmentJson
    const outputSchema = parseJsonArgument(
      input.outputSchemaJson,
      'outputSchemaJson',
    ) as RoleAssignmentJson
    const inputArtifactRefs = parseRoleAssignmentReferences(input.inputArtifactRefsJson)

    const prepared = await this.enqueue(labId, async () => {
      signal?.throwIfAborted()
      let state = this.requireState(labId)
      this.assertControllerSession(caller, state)
      if (state.lifecycle !== 'running' || state.config === undefined) {
        throw new AutoLabRuntimeError(`Lab ${labId} is not running`, 'NOT_READY')
      }
      const frozen = await this.artifacts.readCurrent(labId)
      if (!sameConfigRef(state.config, frozen.ref)) {
        throw new AutoLabRuntimeError(`Lab ${labId} CURRENT does not match RuntimeState`, 'CONFIG_DRIFT')
      }
      const role = frozen.manifest.roles.find(value => value.role_id === input.roleId)
      if (role === undefined
        || role.role_kind === 'controller'
        || (role.role_kind !== 'ops'
          && role.role_kind !== 'coordinator')) {
        throw new AutoLabRuntimeError(
          `Role ${input.roleId} cannot receive a Controller Role Assignment`,
          'ROLE_MISMATCH',
        )
      }
      const projected = state.roles[input.roleId]
      if (projected?.binding === undefined
        || projected.packet === undefined
        || projected.activationBlocker !== undefined) {
        throw new AutoLabRuntimeError(
          `Role ${input.roleId} is not durably available`,
          'ROLE_ACTIVATION_UNAVAILABLE',
        )
      }
      assertRoleAssignmentMayDispatch(projected.goalInstall, input.assignmentId)
      if (projected.goalInstall?.assignmentId === input.assignmentId) {
        const binding = await readRoleBinding(
          frozen.manifest.authority_paths.lab_dir,
          input.roleId,
        )
        if (binding === undefined
          || binding.path !== projected.binding.path
          || binding.hash !== projected.binding.hash) {
          throw new AutoLabRuntimeError(`Role ${input.roleId} binding drifted`, 'CONFIG_DRIFT')
        }
        const restored = await restoreCurrentRoleArtifacts({
          frozen,
          role,
          sessionId: projected.sessionId,
          binding,
          runtimeRevision: state.runtimeRevision,
          packetRef: projected.packet,
        })
        if (restored.assignmentId !== input.assignmentId
          || restored.objectiveBody !== input.objective) {
          throw new AutoLabRuntimeError(
            `Assignment ${input.assignmentId} conflicts with its activating original`,
            'CONFIG_DRIFT',
          )
        }
        assertRoleAssignmentReplay(restored.packet.packet, {
          role,
          sessionId: projected.sessionId,
          assignmentId: input.assignmentId,
          objective: input.objective,
          content,
          outputSchema,
          inputArtifactRefs,
        })
        if (projected.goalInstall.status === 'applied') {
          return {
            completed: controllerAssignRoleResult(
              state.labId,
              input.roleId,
              input.assignmentId,
              projected.receipt?.assignmentId === input.assignmentId
                ? 'receipt_recorded'
                : 'working',
            ),
          } as const
        }
        const install = projected.goalInstall
        const intent = compileLocalGoalIntent({
          installId: install.installId,
          assignmentId: install.assignmentId,
          packetPath: restored.packetPath,
          packetHash: restored.packet.packetHash,
          body: restored.objectiveBody,
          maxGoalRounds: install.maxGoalRounds,
          expectedGoalRef: install.goalId === undefined
            ? null
            : { id: GoalId(install.goalId), revision: install.goalRevision! },
        })
        if (intent.objectiveHash !== install.objectiveHash) {
          throw new AutoLabRuntimeError(
            `Assignment ${input.assignmentId} activating Goal identity drifted`,
            'CONFIG_DRIFT',
          )
        }
        return {
          roleId: input.roleId,
          sessionId: projected.sessionId,
          packet: projected.packet,
          intent,
          stagedRuntimeRevision: state.runtimeRevision,
        } as const
      }

      if (projected.phase !== 'declared' && projected.phase !== 'paused') {
        throw new AutoLabRuntimeError(
          `Role ${input.roleId} is ${projected.phase}; finish or pause its current responsibility first`,
          'NOT_READY',
        )
      }
      const binding = await readRoleBinding(
        frozen.manifest.authority_paths.lab_dir,
        input.roleId,
      )
      if (binding === undefined
        || binding.path !== projected.binding.path
        || binding.hash !== projected.binding.hash) {
        throw new AutoLabRuntimeError(`Role ${input.roleId} binding drifted`, 'CONFIG_DRIFT')
      }
      const live = this.ctx.agents.get(SessionId(projected.sessionId))
      if (live === undefined) {
        throw new AutoLabRuntimeError(
          `Role Session ${projected.sessionId} is not live`,
          'ROLE_ACTIVATION_UNAVAILABLE',
        )
      }
      const currentGoal = this.ctx.goals.get(live)
      if (currentGoal !== undefined
        && (projected.goalInstall === undefined
          || String(currentGoal.id) !== projected.goalInstall.goalId
          || sha256(currentGoal.objective) !== projected.goalInstall.objectiveHash)) {
        throw new AutoLabRuntimeError(
          `Role ${input.roleId} has another live Goal`,
          'REVIEW_NOT_READY',
        )
      }
      const plannedRevision = state.runtimeRevision + 1
      const artifacts = await freezeRoleAssignment({
        frozen,
        role,
        sessionId: projected.sessionId,
        binding,
        currentPacket: projected.packet,
        currentRevealState: state.revealState
          ?? frozen.manifest.communication.reveal_policy.initial_state,
        assignmentId: input.assignmentId,
        objective: input.objective,
        content,
        outputSchema,
        inputArtifactRefs,
        runtimeRevision: plannedRevision,
        issuedAt: state.updatedAt,
      })
      const intent = compileLocalGoalIntent({
        installId: `${input.assignmentId}:install:1`,
        assignmentId: input.assignmentId,
        packetPath: artifacts.packetPath,
        packetHash: artifacts.packet.packetHash,
        body: artifacts.objectiveBody,
        maxGoalRounds: roleGoalRoundLimit(role),
        expectedGoalRef: currentGoal === undefined
          ? null
          : { id: currentGoal.id, revision: currentGoal.revision },
      })
      const roles = structuredClone(state.roles)
      const { receipt: _oldReceipt, activationBlocker: _oldBlocker, ...base } = projected
      roles[input.roleId] = {
        ...base,
        packet: { path: artifacts.packetPath, hash: artifacts.packet.packetHash },
        goalInstall: {
          installId: intent.installId,
          assignmentId: intent.assignmentId,
          objectiveHash: intent.objectiveHash,
          maxGoalRounds: intent.maxGoalRounds,
          status: 'activating',
          ...(intent.expectedGoalRef === null
            ? {}
            : {
                goalId: String(intent.expectedGoalRef.id),
                goalRevision: intent.expectedGoalRef.revision,
              }),
        },
      }
      state = await this.transition(
        state,
        state.lifecycle,
        undefined,
        undefined,
        roles,
      )
      return {
        roleId: input.roleId,
        sessionId: projected.sessionId,
        packet: roles[input.roleId]!.packet!,
        intent,
        stagedRuntimeRevision: state.runtimeRevision,
      } as const
    })
    if ('completed' in prepared) return prepared.completed

    const installed = await installLocalGoal(this.ctx, prepared.sessionId, prepared.intent)
    if (installed.outcome === 'already-complete') {
      throw new AutoLabRuntimeError(
        `Assignment ${input.assignmentId} Goal is already complete and requires its receipt`,
        'NOT_READY',
      )
    }
    signal?.throwIfAborted()
    return await this.enqueue(labId, async () => {
      signal?.throwIfAborted()
      const state = this.requireState(labId)
      this.assertControllerSession(caller, state)
      const projected = state.roles[prepared.roleId]
      const install = projected?.goalInstall
      if (state.runtimeRevision !== prepared.stagedRuntimeRevision
        || projected === undefined
        || projected.packet?.path !== prepared.packet.path
        || projected.packet.hash !== prepared.packet.hash
        || install?.status !== 'activating'
        || install.installId !== prepared.intent.installId
        || install.assignmentId !== prepared.intent.assignmentId
        || install.objectiveHash !== prepared.intent.objectiveHash
        || installed.objectiveHash !== prepared.intent.objectiveHash) {
        throw new AutoLabRuntimeError(
          `Assignment ${input.assignmentId} changed during Goal installation`,
          'CONFIG_DRIFT',
        )
      }
      const roles = structuredClone(state.roles)
      roles[prepared.roleId] = {
        ...projected,
        phase: 'working',
        goalInstall: {
          ...install,
          status: 'applied',
          goalId: String(installed.ref.id),
          goalRevision: installed.ref.revision,
        },
      }
      await this.transition(
        state,
        state.lifecycle,
        undefined,
        undefined,
        roles,
      )
      return controllerAssignRoleResult(
        state.labId,
        prepared.roleId,
        prepared.intent.assignmentId,
        'working',
      )
    })
  }

  /**
   * Validate the current Coder report, freeze the Lane bytes, and compile the
   * trusted implementation receipt. Every target and path comes from the
   * exact caller, CURRENT, Role Packet, and applied APPROVED review.
   */
  async submitCoderImplementation(
    caller: Agent,
    signal?: AbortSignal,
  ): Promise<CoderImplementationResult> {
    const labId = this.resolveExactRoleCaller(caller).state.labId
    let prepared: PreparedCoderSubmission | CoderImplementationResult
    try {
      prepared = await this.enqueue(labId, async () => (
        await this.prepareCoderSubmission(caller, signal)
      ))
    } catch (error) {
      rethrowCoderBoundary(error, 'reconcile')
    }
    if (!('input' in prepared)) return prepared

    let submission: FrozenApprovedCoderSubmission
    try {
      // Git index/tree/commit/diff work deliberately runs outside the Lab
      // mutation queue; immutable identity is rechecked at commit.
      submission = await freezeApprovedCoderSubmission(prepared.input)
      signal?.throwIfAborted()
    } catch (error) {
      rethrowCoderBoundary(error, 'capture')
    }
    let result: CoderImplementationResult
    try {
      result = await this.enqueue(labId, async () => (
        await this.commitCoderSubmission(caller, prepared, submission, signal)
      ))
    } catch (error) {
      rethrowCoderBoundary(error, 'reconcile')
    }
    return result
  }

  /**
   * Materialize one Controller-selected Trial/RunSlot and publish its first
   * active Attempt. All scientific JSON stays opaque; Candidate and CURRENT
   * identities are derived from the exact durable Lab projection.
   */
  async launchAttempt(
    caller: Agent,
    input: ControllerLaunchAttemptInput,
    signal?: AbortSignal,
  ): Promise<ControllerLaunchAttemptResult> {
    this.assertReady()
    signal?.throwIfAborted()
    const labId = validateLabId(input.labId)
    const snapshot = this.requireState(labId)
    this.assertControllerSession(caller, snapshot)
    if (snapshot.lifecycle !== 'running' || snapshot.config === undefined) {
      throw new AutoLabRuntimeError(`Lab ${labId} is not running`, 'NOT_READY')
    }
    const candidate = snapshot.candidates[input.laneId]
    if (candidate === undefined) {
      throw new AutoLabRuntimeError(
        `Lane ${input.laneId} has no frozen active Candidate`,
        'IMPLEMENTATION_NOT_READY',
      )
    }
    const frozen = await this.artifacts.readCurrent(labId)
    if (!sameConfigRef(snapshot.config, frozen.ref)) {
      throw new AutoLabRuntimeError(`Lab ${labId} CURRENT does not match RuntimeState`, 'CONFIG_DRIFT')
    }
    const parsed = parseControllerAttemptInput(input)
    const poke = this.attemptPoke
    if (poke === undefined) {
      throw new AutoLabRuntimeError('Attempt event endpoint is unavailable', 'SERVICE_CLOSED')
    }
    const prepared = await prepareInitialLocalAttempt({
      frozen,
      candidate,
      laneId: input.laneId,
      trialId: input.trialId,
      trialContract: parsed.trialContract,
      runSlots: parsed.runSlots,
      selectedRunSlotId: input.selectedRunSlotId,
      hostId: input.hostId,
      command: parsed.command,
      env: parsed.env,
      runtimePokeFile: poke.pointerPath,
      anchoredAt: candidate.frozenAt,
    })
    signal?.throwIfAborted()

    await this.enqueue(labId, async () => {
      signal?.throwIfAborted()
      const state = this.requireState(labId)
      this.assertControllerSession(caller, state)
      const currentCandidate = state.candidates[input.laneId]
      if (state.lifecycle !== 'running'
        || !sameConfigRef(state.config, frozen.ref)
        || canonicalJson(currentCandidate ?? null) !== canonicalJson(candidate)) {
        throw new AutoLabRuntimeError(
          `Lane ${input.laneId} changed while preparing Trial ${input.trialId}`,
          'CONFIG_DRIFT',
        )
      }
      const existing = state.trials[input.trialId]
      if (existing !== undefined) {
        if (canonicalJson(existing) !== canonicalJson(prepared.projection)) {
          throw new AutoLabRuntimeError(
            `Trial ${input.trialId} already has another frozen identity`,
            'CONFIG_DRIFT',
          )
        }
        return
      }
      const trials = structuredClone(state.trials)
      trials[input.trialId] = prepared.projection
      await this.transition(
        state,
        state.lifecycle,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        trials,
      )
    })

    const target = {
      labId,
      trialId: input.trialId,
      runSlotId: input.selectedRunSlotId,
    }
    await this.requireAttemptRuntime().dispatch(target, 'poke')
    return attemptLaunchResult(this.requireState(labId), target)
  }

  /** Create one explicit technical retry without changing Trial/RunSlot lineage. */
  async retryAttempt(
    caller: Agent,
    input: ControllerRetryAttemptInput,
    signal?: AbortSignal,
  ): Promise<ControllerLaunchAttemptResult> {
    this.assertReady()
    signal?.throwIfAborted()
    const labId = validateLabId(input.labId)
    if (input.trialId.trim().length === 0 || input.runSlotId.trim().length === 0) {
      throw new AutoLabRuntimeError('trialId and runSlotId must be non-empty', 'NOT_READY')
    }
    const parsed = parseRetryAttemptInput(input)
    const snapshot = this.requireState(labId)
    this.assertControllerSession(caller, snapshot)
    if (snapshot.lifecycle !== 'running' || snapshot.config === undefined) {
      throw new AutoLabRuntimeError(`Lab ${labId} is not running`, 'NOT_READY')
    }
    const trial = snapshot.trials[input.trialId]
    const slot = trial?.runSlots[input.runSlotId]
    if (trial === undefined || slot?.activeAttempt === undefined) {
      throw new AutoLabRuntimeError(
        `Trial ${input.trialId} RunSlot ${input.runSlotId} has no active Attempt lineage`,
        'NOT_READY',
      )
    }
    const replayingActiveRetry = slot.state.status === 'attempt_active'
      || slot.state.status === 'outcome_unknown'
    if (!replayingActiveRetry && slot.state.status !== 'retryable') {
      throw new AutoLabRuntimeError(
        `Trial ${input.trialId} RunSlot ${input.runSlotId} is not a failed technical retry point`,
        'NOT_READY',
      )
    }
    const target = { labId, trialId: input.trialId, runSlotId: input.runSlotId }
    const frozen = await this.artifacts.readCurrent(labId)
    if (!sameConfigRef(snapshot.config, frozen.ref)) {
      throw new AutoLabRuntimeError(`Lab ${labId} CURRENT does not match RuntimeState`, 'CONFIG_DRIFT')
    }
    const poke = this.attemptPoke
    if (poke === undefined) {
      throw new AutoLabRuntimeError('Attempt event endpoint is unavailable', 'SERVICE_CLOSED')
    }
    if (replayingActiveRetry) {
      await verifyRetryLocalAttemptReplay({
        frozen,
        trialId: input.trialId,
        trial,
        runSlotId: input.runSlotId,
        hostId: input.hostId,
        command: parsed.command,
        env: parsed.env,
      })
      signal?.throwIfAborted()
      await this.requireAttemptRuntime().dispatch(target, 'poke')
      return attemptLaunchResult(this.requireState(labId), target)
    }
    const prepared = await prepareRetryLocalAttempt({
      frozen,
      trialId: input.trialId,
      trial,
      runSlotId: input.runSlotId,
      hostId: input.hostId,
      command: parsed.command,
      env: parsed.env,
      runtimePokeFile: poke.pointerPath,
    })
    signal?.throwIfAborted()

    await this.enqueue(labId, async () => {
      signal?.throwIfAborted()
      const state = this.requireState(labId)
      this.assertControllerSession(caller, state)
      const current = state.trials[input.trialId]
      if (state.lifecycle !== 'running' || !sameConfigRef(state.config, frozen.ref)) {
        throw new AutoLabRuntimeError(
          `Trial ${input.trialId} changed while preparing its technical retry`,
          'CONFIG_DRIFT',
        )
      }
      const publishedAttemptId = current?.runSlots[input.runSlotId]?.activeAttempt?.attemptId
      if (canonicalJson(current ?? null) === canonicalJson(prepared.projection)
        || publishedAttemptId === prepared.intent.attempt.value.attempt_id) return
      if (canonicalJson(current ?? null) !== canonicalJson(trial)) {
        throw new AutoLabRuntimeError(
          `Trial ${input.trialId} changed while preparing its technical retry`,
          'CONFIG_DRIFT',
        )
      }
      const trials = structuredClone(state.trials)
      trials[input.trialId] = prepared.projection
      await this.transition(
        state,
        state.lifecycle,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        trials,
      )
    })

    await this.requireAttemptRuntime().dispatch(target, 'poke')
    return attemptLaunchResult(this.requireState(labId), target)
  }

  /**
   * Bind one Controller-selected Attempt to its Lane Coder and Postflight
   * Judge. Runtime freezes only small immutable references and the review
   * handshake; the Judge owns every scientific read and decision.
   */
  requestPostflight(
    caller: Agent,
    input: ControllerRequestPostflightInput,
    signal?: AbortSignal,
  ): Promise<ControllerRequestPostflightResult> {
    const labId = validateLabId(input.labId)
    if (input.trialId.trim().length === 0 || input.runSlotId.trim().length === 0) {
      throw new AutoLabRuntimeError('trialId and runSlotId must be non-empty', 'REVIEW_NOT_READY')
    }
    return this.enqueue(labId, async () => {
      signal?.throwIfAborted()
      let state = this.requireState(labId)
      this.assertControllerSession(caller, state)
      if (state.lifecycle !== 'running' || state.config === undefined) {
        throw new AutoLabRuntimeError(`Lab ${labId} is not running`, 'NOT_READY')
      }
      const trial = state.trials[input.trialId]
      const runSlot = trial?.runSlots[input.runSlotId]
      const attempt = runSlot?.activeAttempt
      if (trial === undefined || runSlot === undefined || attempt === undefined
        || (attempt.phase !== 'terminal' && attempt.phase !== 'outcome_unknown')) {
        throw new AutoLabRuntimeError(
          `Trial ${input.trialId} RunSlot ${input.runSlotId} has no finished or outcome-unknown Attempt`,
          'REVIEW_NOT_READY',
        )
      }

      const frozen = await this.artifacts.readCurrent(labId)
      if (!sameConfigRef(state.config, frozen.ref)
        || trial.sourceRevision > frozen.ref.revision) {
        throw new AutoLabRuntimeError(`Lab ${labId} CURRENT does not match the Trial`, 'CONFIG_DRIFT')
      }
      const lane = frozen.manifest.lanes.find(value => value.lane_id === trial.laneId)
      const activeCandidate = state.candidates[trial.laneId]
      const retiredCandidate = state.retiredCandidates[trial.candidateId]
      const candidate = (activeCandidate !== undefined
        && trial.candidateId === activeCandidate.candidateId
        && trial.candidateSha === activeCandidate.candidateSha)
        ? activeCandidate
        : (retiredCandidate !== undefined
          && trial.candidateId === retiredCandidate.candidateId
          && trial.candidateSha === retiredCandidate.candidateSha)
          ? retiredCandidate
          : undefined
      if (lane === undefined
        || candidate === undefined
        || candidate.coderRoleId !== lane.coder_role_id
        || candidate.sourceReport === undefined
        || candidate.reviewId === undefined) {
        throw new AutoLabRuntimeError(
          `Trial ${input.trialId} does not resolve to its exact Coder and Preflight originals`,
          'CONFIG_DRIFT',
        )
      }
      const coder = state.roles[lane.coder_role_id]
      const judge = state.roles[lane.postflight_judge_role_id]
      if (coder?.packet === undefined || coder.binding === undefined
        || judge?.packet === undefined || judge.binding === undefined
        || coder.activationBlocker !== undefined || judge.activationBlocker !== undefined) {
        throw new AutoLabRuntimeError(
          `Lane ${lane.lane_id} Coder or Postflight Judge is unavailable`,
          'ROLE_ACTIVATION_UNAVAILABLE',
        )
      }
      const candidateIsRetired = candidate === retiredCandidate
      const approvedRoute = selectApprovedCoderReview(state, lane.coder_role_id, coder)
      // A retired-generation trial binds its OWN recorded APPROVED Preflight
      // review: its Coder may have legitimately moved to a later ticket, and
      // the retired candidate's review carries the exact source packet and
      // verdict provenance the Postflight Packet needs.
      const candidateReview = state.reviews[candidate.reviewId]
      const preflight = candidateIsRetired ? candidateReview : approvedRoute?.review
      const preflightVerdict = candidateIsRetired
        ? candidateReview?.verdict
        : approvedRoute?.review.verdict
      const approvedRouteMatches = candidateIsRetired
        ? candidateReview !== undefined
          && candidateReview.stage === 'preflight'
          && candidateReview.phase === 'verdict_recorded'
          && candidateReview.verdict?.topLevelVerdict === 'APPROVED'
          && candidateReview.resolution?.targetRoleId === lane.coder_role_id
        : approvedRoute?.reviewId === candidate.reviewId
          && approvedRoute.review.phase === 'verdict_recorded'
      const coderLineageMatches = candidateIsRetired
        ? candidate.coderSessionId === coder.sessionId
        : candidate.assignmentId === coder.goalInstall?.assignmentId
          || (coder.goalInstall?.assignmentId !== undefined
            && coder.goalInstall.assignmentId.startsWith(`coder:${candidate.reviewId}:fix:`))
      if (preflight === undefined
        || !approvedRouteMatches
        || candidate.coderSessionId !== coder.sessionId
        || !coderLineageMatches
        || candidate.sourceRevision > frozen.ref.revision
        || preflightVerdict === undefined) {
        throw new AutoLabRuntimeError(
          `Trial ${input.trialId} Candidate does not match its applied APPROVED Coder route`,
          'CONFIG_DRIFT',
        )
      }

      const matching = Object.entries(state.reviews).filter(([, review]) => (
        review.stage === 'postflight'
        && review.capability.workerRoleId === lane.coder_role_id
        && review.capability.judgeRoleId === lane.postflight_judge_role_id
        && review.artifactPath === attempt.path
        && review.capability.artifactHash === attempt.hash
      ))
      if (matching.length > 1) {
        throw new AutoLabRuntimeError(
          `Attempt ${attempt.attemptId} has more than one Postflight review`,
          'CONFIG_DRIFT',
        )
      }
      const existing = matching[0]
      if (existing !== undefined) {
        const [reviewId, review] = existing
        if (review.capability.workerSessionId !== coder.sessionId
          || review.capability.judgeSessionId !== judge.sessionId
          || review.capability.assignmentId !== `postflight:${reviewId}`) {
          throw new AutoLabRuntimeError(
            `Postflight review ${reviewId} no longer matches its Lane identities`,
            'CONFIG_DRIFT',
          )
        }
        if (review.sourcePacket.path !== coder.packet.path
          || review.sourcePacket.hash !== coder.packet.hash) {
          // Coder moved on: the review's own frozen Judge Packet must be intact.
          let packetBytes: Buffer
          try {
            packetBytes = await readFile(review.packetPath)
          } catch {
            throw new AutoLabRuntimeError(
              `Postflight review ${reviewId} packet cannot be read`,
              'CONFIG_DRIFT',
            )
          }
          if (sha256(packetBytes) !== review.capability.packetHash) {
            throw new AutoLabRuntimeError(
              `Postflight review ${reviewId} packet drifted`,
              'CONFIG_DRIFT',
            )
          }
        }
        if (review.result !== undefined) {
          return controllerRequestPostflightResult(state.labId, review, 'result_recorded')
        }
        // A result-less review may be re-dispatched even after its Coder moved
        // on (paused or a later Assignment): the Judge Packet and frozen
        // originals are immutable, and the result-recording path accepts the
        // moved-on Coder identity, so the Judge can still commit its receipt.
        const worker = this.ctx.agents.get(SessionId(coder.sessionId))
        if (worker === undefined) {
          throw new AutoLabRuntimeError(
            `Coder Session ${coder.sessionId} is not live`,
            'ROLE_ACTIVATION_UNAVAILABLE',
          )
        }
        await this.dispatchReviewRequest(worker, review.capability, signal)
        return controllerRequestPostflightResult(state.labId, review, 'reviewing')
      }

      if (coder.phase !== 'paused') {
        throw new AutoLabRuntimeError(
          `Coder role ${lane.coder_role_id} must finish its current Assignment before Postflight`,
          'REVIEW_NOT_READY',
        )
      }
      const worker = this.ctx.agents.get(SessionId(coder.sessionId))
      if (worker === undefined) {
        throw new AutoLabRuntimeError(
          `Coder Session ${coder.sessionId} is not live`,
          'ROLE_ACTIVATION_UNAVAILABLE',
        )
      }
      const exactWorker = this.resolveExactRoleCaller(worker)
      if (exactWorker.state.labId !== labId || exactWorker.roleId !== lane.coder_role_id) {
        throw new AutoLabRuntimeError('Coder Session ownership drifted', 'CONFIG_DRIFT')
      }
      const sourceTurn = lastCompletedAgentTurn(worker)
      if (sourceTurn === undefined) {
        throw new AutoLabRuntimeError(
          `Coder Session ${coder.sessionId} has no closed source turn for Postflight`,
          'REVIEW_NOT_READY',
        )
      }
      const install = coder.goalInstall
      const liveGoal = this.ctx.goals.get(worker)
      if (install?.status !== 'applied'
        || (liveGoal !== undefined
          && (String(liveGoal.id) !== install.goalId
            || sha256(liveGoal.objective) !== install.objectiveHash))) {
        throw new AutoLabRuntimeError(
          `Coder role ${lane.coder_role_id} no longer owns its Postflight source Assignment`,
          'REVIEW_NOT_READY',
        )
      }

      const judgeBinding = await readRoleBinding(
        frozen.manifest.authority_paths.lab_dir,
        lane.postflight_judge_role_id,
      )
      if (judgeBinding === undefined
        || judgeBinding.path !== judge.binding.path
        || judgeBinding.hash !== judge.binding.hash) {
        throw new AutoLabRuntimeError(
          `Postflight Judge ${lane.postflight_judge_role_id} binding drifted`,
          'CONFIG_DRIFT',
        )
      }
      const plannedRevision = state.runtimeRevision + 1
      const reviewId = deterministicReviewId([
        state.labId,
        String(frozen.ref.revision),
        'postflight',
        input.trialId,
        input.runSlotId,
        attempt.attemptId,
        attempt.hash,
        String(plannedRevision),
      ])
      const reviewArtifacts = await freezePostflightReviewArtifacts({
        frozen,
        judgeSessionId: judge.sessionId,
        judgeBinding,
        currentCoderPacket: { path: coder.packet.path, sha256: coder.packet.hash },
        methodPacket: { path: preflight.sourcePacket.path, sha256: preflight.sourcePacket.hash },
        preflightResult: { path: preflightVerdict.path, sha256: preflightVerdict.hash },
        coderResult: { path: candidate.sourceReport.path, sha256: candidate.sourceReport.hash },
        trial: { path: trial.contract.path, sha256: trial.contract.hash },
        runSlot: { path: runSlot.contract.path, sha256: runSlot.contract.hash },
        attempt: { path: attempt.path, sha256: attempt.hash },
        reviewId,
        runtimeRevision: plannedRevision,
        issuedAt: state.updatedAt,
        revealState: state.revealState
          ?? frozen.manifest.communication.reveal_policy.initial_state,
      })
      const capability = compileReviewControlCapability({
        reviewId,
        assignmentId: reviewArtifacts.assignmentId,
        configRevision: frozen.ref.revision,
        runtimeRevision: plannedRevision,
        ownerFence: this.requireOwner().owner.token,
        workerRoleId: lane.coder_role_id,
        workerSessionId: coder.sessionId,
        judgeRoleId: lane.postflight_judge_role_id,
        judgeSessionId: judge.sessionId,
        packetHash: reviewArtifacts.packet.packetHash,
        artifactHash: attempt.hash,
        negotiatedAnchorHash: reviewArtifacts.reviewInputHash,
        sourceTurn,
        expectedGoalRef: liveGoal === undefined
          ? null
          : { id: String(liveGoal.id), revision: liveGoal.revision },
        requestControlId: randomUUID(),
        acceptedPauseControlId: randomUUID(),
      })
      const now = Date.now()
      const roles = structuredClone(state.roles)
      roles[lane.coder_role_id] = { ...coder, phase: 'reviewing' }
      const reviews = structuredClone(state.reviews)
      reviews[reviewId] = {
        stage: 'postflight',
        phase: 'reviewing',
        sourcePacket: { path: coder.packet.path, hash: coder.packet.hash },
        packetPath: reviewArtifacts.packetPath,
        artifactPath: attempt.path,
        capability,
        pause: {
          controlId: capability.acceptedPause.controlId,
          payloadHash: capability.acceptedPause.payloadHash,
          freeze: 'pending',
        },
        createdAt: now,
        updatedAt: now,
      }
      state = await this.transition(
        state,
        state.lifecycle,
        undefined,
        undefined,
        roles,
        reviews,
      )
      await this.dispatchReviewRequest(worker, capability, signal)
      return controllerRequestPostflightResult(state.labId, reviews[reviewId]!, 'reviewing')
    })
  }

  private async prepareCoderSubmission(
    caller: Agent,
    signal?: AbortSignal,
  ): Promise<PreparedCoderSubmission | CoderImplementationResult> {
    signal?.throwIfAborted()
    const { state, roleId } = this.resolveExactRoleCaller(caller)
    const coderState = state.roles[roleId]!
    if (state.lifecycle !== 'running'
      || (coderState.phase !== 'working' && coderState.phase !== 'paused')
      || coderState.packet === undefined
      || coderState.binding === undefined
      || coderState.goalInstall?.status !== 'applied') {
      throw new AutoLabRuntimeError(
        `Coder role ${roleId} is not an active implementation Assignment`,
        'IMPLEMENTATION_NOT_READY',
      )
    }
    const projected = Object.values(state.candidates).filter(candidate => (
      candidate.coderRoleId === roleId
      && candidate.coderSessionId === coderState.sessionId
      && candidate.assignmentId === coderState.goalInstall!.assignmentId
    ))
    if (coderState.phase === 'paused') {
      if (projected.length !== 1) {
        throw new AutoLabRuntimeError(
          `Paused Coder role ${roleId} has no unique frozen candidate`,
          'IMPLEMENTATION_NOT_READY',
        )
      }
      return coderImplementationResult(state.labId, projected[0]!)
    }
    if (projected.length > 0) {
      throw new AutoLabRuntimeError(
        `Working Coder role ${roleId} already has a frozen candidate projection`,
        'CONFIG_DRIFT',
      )
    }
    const frozen = await this.artifacts.readCurrent(state.labId)
    if (state.config === undefined || !sameConfigRef(state.config, frozen.ref)) {
      throw new AutoLabRuntimeError(
        `Lab ${state.labId} CURRENT does not match RuntimeState`,
        'CONFIG_DRIFT',
      )
    }
    const coderRole = frozen.manifest.roles.find(role => role.role_id === roleId)
    if (coderRole?.role_kind !== 'coder') {
      throw new AutoLabRuntimeError(
        `Role ${roleId} is not a Coder role in CURRENT`,
        'CONFIG_DRIFT',
      )
    }
    const lane = frozen.manifest.lanes.find(value => (
      value.lane_id === coderRole.lane_id && value.coder_role_id === roleId
    ))
    const selected = selectApprovedCoderReview(state, roleId, coderState)
    if (lane === undefined || selected === undefined) {
      throw new AutoLabRuntimeError(
        `Coder role ${roleId} has no unique applied APPROVED review`,
        'IMPLEMENTATION_NOT_READY',
      )
    }
    const binding = await readRoleBinding(frozen.manifest.authority_paths.lab_dir, roleId)
    if (binding === undefined
      || binding.path !== coderState.binding.path
      || binding.hash !== coderState.binding.hash) {
      throw new AutoLabRuntimeError(`Coder role ${roleId} binding drifted`, 'CONFIG_DRIFT')
    }
    const review = selected.review
    if (review.verdict === undefined) {
      throw new AutoLabRuntimeError(
        `Review ${selected.reviewId} has no frozen verdict`,
        'CONFIG_DRIFT',
      )
    }
    assertLiveAssignmentGoal(this.ctx, caller, coderState, roleId, 'Coder')
    const input: FreezeApprovedCoderSubmissionInput = {
      frozen,
      coderRole,
      coderSessionId: coderState.sessionId,
      coderBinding: binding,
      coderPacket: coderState.packet,
      expectedAssignmentId: coderState.goalInstall.assignmentId,
      reviewId: selected.reviewId,
      sourceMethodPacket: review.sourcePacket,
      designTicket: {
        path: review.artifactPath,
        hash: review.capability.artifactHash,
      },
      preflightVerdict: {
        path: review.verdict.path,
        hash: review.verdict.hash,
      },
      runtimeRevision: state.runtimeRevision,
    }
    return {
      labId: state.labId,
      roleId,
      laneId: lane.lane_id,
      coderSessionId: coderState.sessionId,
      assignmentId: coderState.goalInstall.assignmentId,
      packet: coderState.packet,
      binding: coderState.binding,
      goalInstall: coderState.goalInstall,
      reviewId: selected.reviewId,
      config: state.config,
      input,
    }
  }

  private async commitCoderSubmission(
    caller: Agent,
    prepared: PreparedCoderSubmission,
    submission: FrozenApprovedCoderSubmission,
    signal?: AbortSignal,
  ): Promise<CoderImplementationResult> {
    signal?.throwIfAborted()
    let { state, roleId } = this.resolveExactRoleCaller(caller)
    if (state.labId !== prepared.labId || roleId !== prepared.roleId) {
      throw new AutoLabRuntimeError('Coder caller changed during candidate capture', 'CONFIG_DRIFT')
    }
    const coderState = state.roles[roleId]!
    const projection: RuntimeState['candidates'][string] = {
      version: 1,
      sourceRevision: prepared.input.frozen.ref.revision,
      laneId: submission.laneId,
      candidateId: submission.candidateId,
      reviewId: submission.reviewId,
      coderRoleId: roleId,
      coderSessionId: prepared.coderSessionId,
      assignmentId: submission.assignment.assignmentId,
      candidateSha: submission.candidate.candidateSha,
      captureReceipt: { path: submission.candidatePath, hash: submission.candidateHash },
      sourceReport: { path: submission.reportPath, hash: submission.reportHash },
      frozenAt: submission.candidate.capturedAt,
    }
    const existing = state.candidates[prepared.laneId]
    if (existing !== undefined) {
      if (canonicalJson(existing) === canonicalJson(projection)
        && coderState.phase === 'paused') {
        return coderImplementationResult(state.labId, existing)
      }
      throw new AutoLabRuntimeError(
        `Lane ${prepared.laneId} already projects another active candidate`,
        'CONFIG_DRIFT',
      )
    }
    const selected = selectApprovedCoderReview(state, roleId, coderState)
    if (state.lifecycle !== 'running'
      || coderState.phase !== 'working'
      || coderState.sessionId !== prepared.coderSessionId
      || canonicalJson(coderState.packet) !== canonicalJson(prepared.packet)
      || canonicalJson(coderState.binding) !== canonicalJson(prepared.binding)
      || canonicalJson(coderState.goalInstall) !== canonicalJson(prepared.goalInstall)
      || canonicalJson(state.config) !== canonicalJson(prepared.config)
      || !sameConfigRef(state.config, prepared.input.frozen.ref)
      || selected?.reviewId !== prepared.reviewId
      || submission.laneId !== prepared.laneId
      || submission.reviewId !== prepared.reviewId
      || submission.assignment.assignmentId !== prepared.assignmentId) {
      throw new AutoLabRuntimeError(
        `Coder role ${roleId} Assignment changed during candidate capture`,
        'CONFIG_DRIFT',
      )
    }
    assertLiveAssignmentGoal(this.ctx, caller, coderState, roleId, 'Coder')
    const roles = structuredClone(state.roles)
    roles[roleId] = { ...coderState, phase: 'paused' }
    const candidates = structuredClone(state.candidates)
    candidates[prepared.laneId] = projection
    state = await this.transition(
      state,
      state.lifecycle,
      undefined,
      undefined,
      roles,
      undefined,
      candidates,
    )
    try {
      await pauseLocalGoalContinuation(this.ctx, coderState.sessionId)
    } catch {
      // The immutable candidate is already safe; disarm prevents another Goal round.
      this.ctx.goals.disarm(caller)
    }
    state = await this.wakeControllerForEvent(
      state,
      `coder-candidate:${projection.candidateId}:${projection.candidateSha}`,
      [
        `AutoLab ${state.labId} Coder candidate ${projection.candidateId} is frozen at ${projection.candidateSha}.`,
        `Read the original report at ${projection.sourceReport?.path ?? projection.captureReceipt.path} and current RuntimeState before deciding Trial or review work.`,
      ].join('\n'),
    )
    return coderImplementationResult(state.labId, projection)
  }

  async start(caller: Agent, labId: string, signal?: AbortSignal): Promise<RuntimeState> {
    await this.enqueue(labId, async () => {
      signal?.throwIfAborted()
      let state = this.requireState(validateLabId(labId))
      this.assertControllerSession(caller, state)
      if (state.config === undefined
        || state.lifecycle === 'configuring'
        || state.lifecycle === 'draft_ready'
        || state.lifecycle === 'stopped'
        || state.lifecycle === 'pausing') {
        throw new AutoLabRuntimeError(`Lab ${labId} is not ready`, 'NOT_READY')
      }
      const frozen = await this.artifacts.readCurrent(labId)
      if (!sameConfigRef(state.config, frozen.ref)) {
        throw new AutoLabRuntimeError(
          `Lab ${labId} CURRENT does not match RuntimeState`,
          'CONFIG_DRIFT',
        )
      }
      const workers = frozen.manifest.roles.filter(
        (role): role is RootRoleBinding => role.role_kind !== 'controller',
      )
      if (workers.length === 0) {
        throw new AutoLabRuntimeError(
          `Lab ${labId} has no root worker roles`,
          'NO_ROLES_DECLARED',
        )
      }
      if (state.lifecycle === 'running'
        && this.hasAttachedRoleSet(state)
        && Object.values(state.roles).every(role => (
          role.activationBlocker === undefined
          && role.goalInstall?.status !== 'activating'
        ))) {
        state = await this.armControllerGoal(caller, state, frozen)
        const attached = await this.readAttachedRoles(state, frozen, workers)
        await this.reconcileCommunicationAcl(caller, state, frozen, attached, signal)
        await this.reconcileProjectedPausedRoleGoals(state)
        await this.replayActiveReviewRequests(state, signal)
        return cloneState(this.requireState(labId))
      }

      try {
        if (state.lifecycle !== 'starting') {
          state = await this.transition(
            state,
            'starting',
            null,
            undefined,
            startingRoleProjection(state, frozen.manifest, workers),
          )
        } else {
          assertStartingRoleProjection(state, workers)
        }

        state = await this.armControllerGoal(caller, state, frozen)

        const activation = await this.activateRolesForControl(
          caller,
          state,
          frozen,
          workers,
          signal,
        )
        const activated = activation.activated

        const stagedRoles = structuredClone(state.roles)
        for (const [roleId, activationBlocker] of activation.blockers) {
          stagedRoles[roleId] = {
            ...stagedRoles[roleId]!,
            activationBlocker,
          }
        }
        for (const item of activated) {
          const projected = state.roles[item.role.role_id]!
          const base = {
            sessionId: String(item.agent.id),
            phase: projected.phase === 'starting' && item.role.role_kind !== 'method'
              ? 'declared' as const
              : projected.phase,
            binding: { path: item.binding.path, hash: item.binding.hash },
            packet: {
              path: item.artifacts.packetPath,
              hash: item.artifacts.packet.packetHash,
            },
          }
          if (item.role.role_kind !== 'method' && projected.goalInstall === undefined) {
            stagedRoles[item.role.role_id] = base
            continue
          }
          if (projected.goalInstall !== undefined && projected.phase !== 'working'
            && projected.phase !== 'starting') {
            stagedRoles[item.role.role_id] = {
              ...base,
              goalInstall: projected.goalInstall,
            }
            continue
          }
          const intent = compileLocalGoalIntent({
            installId: projected.goalInstall?.installId
              ?? `${item.artifacts.assignmentId}:install:1`,
            assignmentId: projected.goalInstall?.assignmentId
              ?? item.artifacts.assignmentId,
            packetPath: item.artifacts.packetPath,
            packetHash: item.artifacts.packet.packetHash,
            body: item.artifacts.objectiveBody,
            maxGoalRounds: projected.goalInstall?.maxGoalRounds
              ?? roleGoalRoundLimit(item.role),
            expectedGoalRef: projected.goalInstall?.goalId === undefined
              ? null
              : {
                  id: GoalId(projected.goalInstall.goalId),
                  revision: projected.goalInstall.goalRevision!,
              },
          })
          stagedRoles[item.role.role_id] = {
            ...base,
            phase: projected.phase,
            goalInstall: {
              ...projected.goalInstall,
              installId: intent.installId,
              assignmentId: intent.assignmentId,
              objectiveHash: intent.objectiveHash,
              maxGoalRounds: intent.maxGoalRounds,
              status: 'activating' as const,
            },
          }
        }
        state = await this.transition(state, 'starting', undefined, undefined, stagedRoles)

        const goalTargets = activated
          .filter(item => state.roles[item.role.role_id]?.goalInstall?.status === 'activating')
        const goalResults = await Promise.allSettled(goalTargets.map(async item => {
            const roleState = state.roles[item.role.role_id]!
            const install = roleState.goalInstall!
            const intent = compileLocalGoalIntent({
              installId: install.installId,
              assignmentId: install.assignmentId,
              packetPath: item.artifacts.packetPath,
              packetHash: item.artifacts.packet.packetHash,
              body: item.artifacts.objectiveBody,
              maxGoalRounds: install.maxGoalRounds,
              expectedGoalRef: install.goalId === undefined
                ? currentLiveGoalRef(this.ctx, roleState.sessionId)
                : { id: GoalId(install.goalId), revision: install.goalRevision! },
            })
            const result = await installLocalGoal(this.ctx, roleState.sessionId, intent)
            if (result.outcome === 'already-complete') {
              throw new Error(
                `Assignment ${install.assignmentId} Goal is complete and requires receipt reconciliation`,
              )
            }
            return { roleId: item.role.role_id, result }
          }))

        const runningRoles = structuredClone(state.roles)
        for (let index = 0; index < goalResults.length; index += 1) {
          const settled = goalResults[index]!
          const roleId = goalTargets[index]!.role.role_id
          const current = runningRoles[roleId]!
          if (settled.status === 'rejected') {
            runningRoles[roleId] = {
              ...current,
              activationBlocker: {
                code: 'GOAL_INSTALL_FAILED',
                message: renderError(settled.reason),
              },
            }
            continue
          }
          runningRoles[roleId] = {
            ...current,
            phase: 'working',
            goalInstall: {
              ...current.goalInstall!,
              status: 'applied',
              goalId: String(settled.value.result.ref.id),
              goalRevision: settled.value.result.ref.revision,
            },
          }
        }
        state = await this.transition(state, 'running', null, undefined, runningRoles)
        await this.reconcileProjectedPausedRoleGoals(state)
        await this.replayActiveReviewRequests(state, signal)
        return cloneState(this.requireState(labId))
      } catch (error) {
        await this.pauseRoleGoals(frozen.manifest)
        const current = this.requireState(labId)
        if (current.lifecycle !== 'blocked') {
          await this.transition(current, 'blocked', {
            code: error instanceof CommunicationAclError
              ? 'ACL_SAFETY_FAILED'
              : 'ROLE_ACTIVATION_FAILED',
            message: renderError(error),
          })
        }
        throw new AutoLabRuntimeError(
          `Lab ${labId} start failed: ${renderError(error)}`,
          'ROLE_ACTIVATION_UNAVAILABLE',
        )
      }
    })
    return cloneState(this.requireState(labId))
  }

  pause(caller: Agent, labId: string, signal?: AbortSignal): Promise<RuntimeState> {
    return this.enqueue(labId, async () => {
      signal?.throwIfAborted()
      let state = this.requireState(validateLabId(labId))
      this.assertControllerSession(caller, state)
      if (state.lifecycle === 'paused') return cloneState(state)
      if (state.lifecycle === 'configuring'
        || state.lifecycle === 'draft_ready'
        || state.lifecycle === 'stopped') {
        throw new AutoLabRuntimeError(`Lab ${labId} is ${state.lifecycle} and cannot be paused`, 'NOT_READY')
      }
      if (state.lifecycle === 'running') state = await this.transition(state, 'pausing')

      if (!this.hasAttachedRoleSet(state) && Object.keys(state.roles).length > 0) {
        try {
          if (state.config === undefined) throw new Error('pausing Lab has no committed config')
          const frozen = await this.artifacts.readCurrent(labId)
          if (!sameConfigRef(state.config, frozen.ref)) {
            throw new Error('CURRENT does not match the pausing RuntimeState')
          }
          const workers = frozen.manifest.roles.filter(
            (role): role is RootRoleBinding => role.role_kind !== 'controller',
          )
          assertStartingRoleProjection(state, workers)
          const activation = await this.activateRolesForControl(
            caller,
            state,
            frozen,
            workers,
            signal,
          )
          if (activation.blockers.size > 0) {
            throw new Error([...activation.blockers]
              .map(([roleId, blocker]) => `${roleId}: ${blocker.message}`)
              .join('; '))
          }
        } catch (error) {
          state = await this.transition(state, 'blocked', {
            code: 'SESSION_RECOVERY_FAILED',
            message: renderError(error),
          })
          return cloneState(state)
        }
      }

      const failures: string[] = []
      await Promise.all(Object.values(state.roles).map(async role => {
        try {
          signal?.throwIfAborted()
          await pauseLocalGoalContinuation(this.ctx, role.sessionId)
        } catch (error) {
          failures.push(`${role.sessionId}: ${renderError(error)}`)
        }
      }))

      let controllerGoal = state.controllerGoal
      try {
        const paused = await this.pauseControllerNativeGoal(caller, state)
        controllerGoal = paused.controllerGoal
      } catch (error) {
        failures.push(`${state.controllerSessionId}: ${renderError(error)}`)
      }

      if (failures.length > 0) {
        state = await this.transition(state, 'blocked', {
          code: 'GOAL_PAUSE_FAILED',
          message: failures.join('; '),
        }, undefined, undefined, undefined, undefined, undefined, controllerGoal)
      } else {
        state = await this.transition(
          state,
          'paused',
          null,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          controllerGoal,
        )
      }
      return cloneState(state)
    })
  }

  async resume(caller: Agent, labId: string, signal?: AbortSignal): Promise<RuntimeState> {
    await this.enqueue(labId, async () => {
      signal?.throwIfAborted()
      const state = this.requireState(validateLabId(labId))
      this.assertControllerSession(caller, state)
      if (state.config === undefined
        || state.lifecycle === 'configuring'
        || state.lifecycle === 'draft_ready'
        || state.lifecycle === 'stopped'
        || state.lifecycle === 'pausing'
        || state.controllerGoal?.waiting !== true) return
      const { waiting: _waiting, ...controllerGoal } = state.controllerGoal
      await this.transition(
        state,
        state.lifecycle,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        controllerGoal,
      )
    })
    return await this.start(caller, labId, signal)
  }

  async stop(caller: Agent, labId: string, signal?: AbortSignal): Promise<RuntimeState> {
    const initial = this.status(caller, labId)
    if (initial.lifecycle === 'stopped') return initial
    if (initial.lifecycle === 'configuring' || initial.lifecycle === 'draft_ready') {
      return await this.enqueue(labId, async () => {
        signal?.throwIfAborted()
        const state = this.requireState(validateLabId(labId))
        this.assertControllerSession(caller, state)
        if (state.lifecycle === 'stopped') return cloneState(state)
        if (state.lifecycle !== 'configuring' && state.lifecycle !== 'draft_ready') {
          throw new AutoLabRuntimeError(
            `Lab ${labId} changed while stopping and is now ${state.lifecycle}`,
            'NOT_READY',
          )
        }
        return cloneState(await this.transition(state, 'stopped', null))
      })
    }
    const paused = await this.pause(caller, labId, signal)
    if (paused.lifecycle === 'blocked' || paused.lifecycle === 'stopped') return paused
    return await this.enqueue(labId, async () => {
      signal?.throwIfAborted()
      const state = this.requireState(validateLabId(labId))
      this.assertControllerSession(caller, state)
      if (state.lifecycle !== 'paused') {
        throw new AutoLabRuntimeError(
          `Lab ${labId} changed while stopping and is now ${state.lifecycle}`,
          'NOT_READY',
        )
      }
      return cloneState(await this.transition(state, 'stopped', null))
    })
  }

  waitController(
    caller: Agent,
    labId: string,
    signal?: AbortSignal,
  ): Promise<ControllerWaitResult> {
    return this.enqueue(labId, async () => {
      signal?.throwIfAborted()
      let state = this.requireState(validateLabId(labId))
      this.assertControllerSession(caller, state)
      const paused = await this.pauseControllerNativeGoal(caller, state)
      const controllerGoal = paused.controllerGoal === undefined || paused.outcome === 'no-goal'
        ? paused.controllerGoal
        : { ...paused.controllerGoal, waiting: true as const }
      if (canonicalJson(controllerGoal ?? null) !== canonicalJson(state.controllerGoal ?? null)) {
        state = await this.transition(
          state,
          state.lifecycle,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          controllerGoal,
        )
      }
      return { labId: state.labId, outcome: paused.outcome }
    })
  }

  private async armControllerGoal(
    caller: Agent,
    state: RuntimeState,
    frozen: FrozenRevision,
  ): Promise<RuntimeState> {
    if (state.controllerGoal?.waiting === true
      || this.controllerApiRecoveryOwnsGoal(state)) return state
    const intent = compileControllerGoalIntent(state, frozen)
    const live = this.ctx.agents.get(SessionId(state.controllerSessionId))
    const current = live === undefined ? undefined : this.ctx.goals.get(live)
    const retained = current?.phase === 'complete' ? undefined : current
    const desired = {
      roleId: intent.roleId,
      packetHash: intent.packetHash,
      installId: intent.installId,
      assignmentId: intent.assignmentId,
      objectiveHash: intent.objectiveHash,
      maxGoalRounds: retained?.maxGoalRounds
        ?? state.controllerGoal?.maxGoalRounds
        ?? intent.maxGoalRounds,
      status: live === caller ? 'activating' as const : 'pending' as const,
      ...(retained === undefined
        ? state.controllerGoal?.goalId === undefined
          ? {}
          : {
              goalId: state.controllerGoal.goalId,
              goalRevision: state.controllerGoal.goalRevision,
            }
        : { goalId: String(retained.id), goalRevision: retained.revision }),
    }
    if (canonicalJson(state.controllerGoal ?? null) !== canonicalJson(desired)) {
      state = await this.transition(
        state,
        state.lifecycle,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        desired,
      )
    }
    if (live !== caller) return state

    const goal = await this.applyControllerGoal(caller, intent)
    const applied: NonNullable<RuntimeState['controllerGoal']> = {
      ...desired,
      status: 'applied',
      maxGoalRounds: goal.maxGoalRounds,
      goalId: String(goal.id),
      goalRevision: goal.revision,
    }
    if (canonicalJson(state.controllerGoal ?? null) === canonicalJson(applied)) return state
    return await this.transition(
      state,
      state.lifecycle,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      applied,
    )
  }

  /** One exact active recovery owns Controller Goal continuation until it settles. */
  private controllerApiRecoveryOwnsGoal(state: RuntimeState): boolean {
    const stored = state.controllerGoal
    const record = this.apiRecoveryStore?.get(state.controllerSessionId)
    if (stored?.goalId === undefined
      || record === undefined
      || record.phase === 'operator'
      || record.labId !== state.labId
      || record.sessionId !== state.controllerSessionId
      || record.roleId !== stored.roleId
      || record.assignmentId !== stored.assignmentId
      || record.packetHash !== stored.packetHash) return false

    const continuations: ApiRecoveryRecord['continuation'][] = [record.continuation]
    if (record.phase === 'recovering') continuations.push(record.resumedContinuation)
    return continuations.some(continuation => (
      continuation.kind === 'goal'
      && String(continuation.goalRef.id) === stored.goalId
      && continuation.objectiveHash === stored.objectiveHash
    ))
  }

  private async applyControllerGoal(
    agent: Agent,
    intent: ControllerGoalIntent,
  ): Promise<GoalView> {
    let current = this.ctx.goals.get(agent)
    if (current === undefined || current.phase === 'complete') {
      current = this.ctx.goals.create(agent, {
        objective: intent.objective,
        maxGoalRounds: intent.maxGoalRounds,
      })
    } else {
      if (sha256(current.objective) !== intent.objectiveHash) {
        // `/autolab start|resume` is the user's explicit authorization to use
        // this Session's one native Goal. Preserve its id and remaining cap.
        current = this.ctx.goals.edit(agent, goalRef(current), {
          objective: intent.objective,
        })
      }
      if (current.phase !== 'active' || current.activation !== 'armed') {
        current = this.ctx.goals.resume(agent, goalRef(current))
      }
    }
    try {
      await flushSessionDurably(this.ctx, agent.session, 'Controller Goal checkpoint')
    } catch (error) {
      if (error instanceof SessionDurabilityError) throw error
      const applied = this.ctx.goals.get(agent)
      if (applied === undefined
        || sha256(applied.objective) !== intent.objectiveHash) throw error
      // The Goal mutation is already exact; retry only its mechanical durable
      // checkpoint once instead of asking an LLM to diagnose storage.
      await flushSessionDurably(this.ctx, agent.session, 'Controller Goal checkpoint retry')
      current = applied
    }
    return current
  }

  private async pauseControllerNativeGoal(
    caller: Agent,
    state: RuntimeState,
  ): Promise<{
    readonly outcome: ControllerWaitResult['outcome']
    readonly controllerGoal: RuntimeState['controllerGoal']
  }> {
    const stored = state.controllerGoal
    if (stored?.goalId === undefined) {
      return { outcome: 'no-goal', controllerGoal: stored }
    }
    const live = this.ctx.agents.get(SessionId(state.controllerSessionId))
    if (live === undefined || live !== caller) {
      // An offline Session cannot run. Its durable Goal is reconciled before
      // any later exact Agent is allowed to rearm.
      return { outcome: 'no-goal', controllerGoal: stored }
    }
    let goal = this.ctx.goals.get(live)
    // The live Goal id is the durable install identity. The objective text
    // carries a per-round progress block, so its hash is not stable across
    // rounds and must not gate the wait.
    if (goal === undefined
      || String(goal.id) !== stored.goalId) {
      return { outcome: 'no-goal', controllerGoal: stored }
    }
    let outcome: ControllerWaitResult['outcome']
    if (goal.phase === 'active') {
      goal = this.ctx.goals.pause(live, goalRef(goal))
      await flushSessionDurably(this.ctx, live.session, 'Controller Goal pause')
      outcome = 'paused'
    } else if (goal.phase === 'paused') {
      outcome = 'already-paused'
    } else {
      outcome = 'no-goal'
    }
    return {
      outcome,
      controllerGoal: {
        ...stored,
        goalRevision: goal.revision,
      },
    }
  }

  private async transition(
    current: RuntimeState,
    lifecycle: LabLifecycle,
    blocker?: RuntimeState['blocker'] | null,
    config?: FrozenRevision['ref'] | null,
    roles?: RuntimeState['roles'],
    reviews?: RuntimeState['reviews'],
    candidates?: RuntimeState['candidates'],
    trials?: RuntimeState['trials'],
    controllerGoal?: RuntimeState['controllerGoal'] | null,
    revealState?: RuntimeState['revealState'],
    retiredCandidates?: RuntimeState['retiredCandidates'],
  ): Promise<RuntimeState> {
    const next = await this.requireTable().update(current.labId, value => {
      if (value.runtimeRevision !== current.runtimeRevision) {
        throw new AutoLabRuntimeError(
          `Lab ${current.labId} Controller revision changed`,
          'CONFIG_DRIFT',
        )
      }
      return transitionRuntimeState(value, {
        expectedRevision: current.runtimeRevision,
        ownerEpoch: this.requireOwner().owner.token,
        lifecycle,
        ...(blocker === undefined ? {} : { blocker }),
        ...(config === undefined ? {} : { config }),
        ...(roles === undefined ? {} : { roles }),
        ...(reviews === undefined ? {} : { reviews }),
        ...(candidates === undefined ? {} : { candidates }),
        ...(trials === undefined ? {} : { trials }),
        ...(controllerGoal === undefined ? {} : { controllerGoal }),
        ...(revealState === undefined ? {} : { revealState }),
        ...(retiredCandidates === undefined ? {} : { retiredCandidates }),
      })
    })
    this.view.set(next.labId, next)
    return next
  }

  private async provisionWorktrees(
    frozen: FrozenRevision,
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, string>> {
    const results = await Promise.allSettled(frozen.manifest.lanes.map(async lane => {
      signal?.throwIfAborted()
      const worktree = await provisionLaneWorktree({
        labId: frozen.manifest.lab_id,
        laneId: lane.lane_id,
        labDirectory: frozen.manifest.authority_paths.lab_dir,
        repositoryPath: frozen.manifest.repository.path,
        worktreePath: lane.worktree_path,
        baseRef: lane.base_ref,
        baseSha: lane.base_sha,
      })
      if (worktree.receipt.baseSha !== lane.base_sha) {
        throw new AutoLabRuntimeError(
          `Lane ${lane.lane_id} worktree base does not match CURRENT`,
          'CONFIG_DRIFT',
        )
      }
      return lane.lane_id
    }))
    signal?.throwIfAborted()
    const failures = new Map<string, string>()
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index]!
      if (result.status === 'rejected') {
        failures.set(frozen.manifest.lanes[index]!.lane_id, renderError(result.reason))
      }
    }
    return failures
  }

  private async activateRolesForControl(
    caller: Agent,
    state: RuntimeState,
    frozen: FrozenRevision,
    workers: readonly RootRoleBinding[],
    signal?: AbortSignal,
  ): Promise<RoleActivationBatch> {
    const worktreeFailures = await this.provisionWorktrees(frozen, signal)
    let persistenceFailure: string | undefined
    let persisted = new Map<string, NativeSessionHeader>()
    try {
      persisted = new Map((await this.requireSessionPersistence().list(signal)).map(header => [
        String(header.id),
        header,
      ]))
    } catch (error) {
      signal?.throwIfAborted()
      persistenceFailure = renderError(error)
    }
    const settled = await Promise.allSettled(workers.map(async role => {
      const laneFailure = 'lane_id' in role
        ? worktreeFailures.get(role.lane_id)
        : undefined
      if (laneFailure !== undefined) throw new Error(laneFailure)
      const persistedHeader = persisted.get(state.roles[role.role_id]!.sessionId)
      return await this.activateRole({
        state,
        frozen,
        role,
        ...(persistedHeader === undefined ? {} : { persisted: persistedHeader }),
        ...(persistenceFailure === undefined ? {} : { persistenceFailure }),
        ...(signal === undefined ? {} : { signal }),
      })
    }))
    signal?.throwIfAborted()
    const activated: ActivatedRole[] = []
    const blockers = new Map<string, RoleActivationBlocker>()
    for (let index = 0; index < settled.length; index += 1) {
      const result = settled[index]!
      const role = workers[index]!
      if (result.status === 'fulfilled') {
        activated.push(result.value)
        continue
      }
      const laneFailure = 'lane_id' in role
        ? worktreeFailures.get(role.lane_id)
        : undefined
      blockers.set(role.role_id, {
        code: laneFailure === undefined
          ? 'ROLE_ACTIVATION_FAILED'
          : 'WORKTREE_PROVISION_FAILED',
        message: renderError(result.reason),
      })
    }
    const blockedEntries = [...blockers]
    const pauses = await Promise.allSettled(blockedEntries.map(async ([roleId]) => {
      const sessionId = state.roles[roleId]!.sessionId
      const agent = this.ctx.agents.get(SessionId(sessionId))
      if (agent === undefined) return
      try {
        await pauseLocalGoalContinuation(this.ctx, sessionId)
      } catch (error) {
        this.ctx.goals.disarm(agent)
        throw error
      }
    }))
    for (let index = 0; index < pauses.length; index += 1) {
      const pause = pauses[index]!
      if (pause.status === 'fulfilled') continue
      const [roleId, blocker] = blockedEntries[index]!
      blockers.set(roleId, {
        ...blocker,
        message: `${blocker.message}; Goal pause failed: ${renderError(pause.reason)}`,
      })
    }
    await this.reconcileCommunicationAcl(
      caller,
      state,
      frozen,
      activated,
      signal,
      activated.length !== workers.length,
    )
    return { activated, blockers }
  }

  private async activateRole(input: {
    state: RuntimeState
    frozen: FrozenRevision
    role: RootRoleBinding
    persisted?: NativeSessionHeader
    persistenceFailure?: string
    signal?: AbortSignal
  }): Promise<ActivatedRole> {
    input.signal?.throwIfAborted()
    const roleState = input.state.roles[input.role.role_id]!
    const spec = resolveRootRoleSessionSpec(input.frozen.manifest, input.role.role_id)
    let binding = await readRoleBinding(
      input.frozen.manifest.authority_paths.lab_dir,
      input.role.role_id,
    )
    if (roleState.binding !== undefined
      && (binding?.path !== roleState.binding.path || binding.hash !== roleState.binding.hash)) {
      throw new AutoLabRuntimeError(
        `Role ${input.role.role_id} binding receipt does not match RuntimeState`,
        'CONFIG_DRIFT',
      )
    }
    if (binding === undefined
      && (roleState.binding !== undefined
        || roleState.packet !== undefined
        || roleState.goalInstall !== undefined)) {
      throw new AutoLabRuntimeError(
        `Role ${input.role.role_id} has durable task state but no RoleBindingReceipt`,
        'CONFIG_DRIFT',
      )
    }
    if (input.persisted !== undefined) {
      if (input.persisted.cwd !== spec.cwd || input.persisted.agentPreset === undefined) {
        throw new AutoLabRuntimeError(
          `Persisted Session ${roleState.sessionId} does not match role ${input.role.role_id}`,
          'CONFIG_DRIFT',
        )
      }
    }
    const hadDurableIdentity = binding !== undefined
      || roleState.binding !== undefined
      || roleState.packet !== undefined
      || roleState.goalInstall !== undefined

    const key = roleHandleKey(input.state.labId, input.role.role_id)
    let owned = this.roleHandles.get(key)
    let borrowed = this.borrowedRoleAgents.get(key)
    const live = this.ctx.agents.get(SessionId(roleState.sessionId))
    if (owned !== undefined && live !== owned.agent) {
      throw new AutoLabRuntimeError(
        `Owned role ${input.role.role_id} is no longer the exact live Agent`,
        'ROLE_ACTIVATION_UNAVAILABLE',
      )
    }
    if (borrowed !== undefined && live !== borrowed) {
      this.borrowedRoleAgents.delete(key)
      borrowed = undefined
    }

    let agentPresetId = binding?.receipt.agentPresetId
      ?? input.persisted?.agentPreset
      ?? live?.session.header.agentPreset
    if (agentPresetId === undefined && live === undefined) {
      agentPresetId = (await this.requireAgentPresets().resolve()).id
    }
    if (agentPresetId === undefined) {
      throw new AutoLabRuntimeError(
        `Live Session ${roleState.sessionId} has no agent preset identity`,
        'CONFIG_DRIFT',
      )
    }

    if (live !== undefined && owned === undefined) {
      await verifyBorrowedRootRoleSession(this.ctx, {
        manifest: input.frozen.manifest,
        roleId: input.role.role_id,
        sessionId: roleState.sessionId,
        agentPresetId,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }, live)
      borrowed = live
      this.borrowedRoleAgents.set(key, live)
    }

    if (owned === undefined
      && borrowed === undefined
      && input.persisted === undefined
      && input.persistenceFailure !== undefined) {
      throw new AutoLabRuntimeError(
        `Cannot prove Session ${roleState.sessionId} is absent: ${input.persistenceFailure}`,
        'ROLE_ACTIVATION_UNAVAILABLE',
      )
    }

    if (owned === undefined && borrowed === undefined) {
      if (input.persisted === undefined && hadDurableIdentity) {
        throw new AutoLabRuntimeError(
          `Persisted Session ${roleState.sessionId} is missing for durable role ${input.role.role_id}`,
          'ROLE_ACTIVATION_UNAVAILABLE',
        )
      }
      owned = input.persisted === undefined
        ? await createRootRoleSession(this.ctx, {
            manifest: input.frozen.manifest,
            roleId: input.role.role_id,
            sessionId: roleState.sessionId,
            agentPresetId,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          })
        : await resumeRootRoleSession(this.ctx, {
            manifest: input.frozen.manifest,
            roleId: input.role.role_id,
            sessionId: roleState.sessionId,
            agentPresetId,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          })
      this.roleHandles.set(key, owned)
      await flushSessionDurably(this.ctx, owned.agent.session, 'AutoLab role Session activation')
    }

    binding ??= await freezeRoleBinding({
      labDirectory: input.frozen.manifest.authority_paths.lab_dir,
      labId: input.state.labId,
      manifestHash: input.frozen.ref.manifestHash,
      roleId: input.role.role_id,
      roleKind: input.role.role_kind,
      sessionId: roleState.sessionId,
      agentPresetId,
      permissionPresetId: input.role.dsh_preset,
      provider: input.role.model_route.provider,
      model: input.role.model_route.model,
      cwd: spec.cwd,
      runtimeRevision: input.state.runtimeRevision,
      issuedAt: input.state.updatedAt,
    })

    const artifacts = roleState.packet === undefined
      ? await freezeInitialRoleArtifacts({
          frozen: input.frozen,
          role: input.role,
          sessionId: roleState.sessionId,
          binding,
          runtimeRevision: binding.receipt.runtimeRevision,
          issuedAt: binding.receipt.issuedAt,
        })
      : await restoreCurrentRoleArtifacts({
          frozen: input.frozen,
          role: input.role,
          sessionId: roleState.sessionId,
          binding,
          runtimeRevision: input.state.runtimeRevision,
          packetRef: roleState.packet,
        })
    const agent = owned?.agent ?? borrowed
    if (agent === undefined) {
      throw new AutoLabRuntimeError(
        `Role ${input.role.role_id} has no exact local Agent after activation`,
        'ROLE_ACTIVATION_UNAVAILABLE',
      )
    }
    return {
      role: input.role,
      binding,
      artifacts,
      agent,
      ownership: owned === undefined ? 'borrowed' : 'owned',
    }
  }

  private async pauseRoleGoals(manifest: ResolvedManifest): Promise<void> {
    await Promise.allSettled(manifest.roles
      .filter(role => role.role_kind !== 'controller')
      .map(async role => {
        const state = this.view.get(manifest.lab_id)?.roles[role.role_id]
        if (state === undefined || this.ctx.agents.get(SessionId(state.sessionId)) === undefined) return
        await pauseLocalGoalContinuation(this.ctx, state.sessionId)
      }))
  }

  /** Reconcile only roles already projected paused; this is a startup edge, not polling. */
  private async reconcileProjectedPausedRoleGoals(state: RuntimeState): Promise<void> {
    await Promise.all(Object.values(state.roles)
      .filter(role => role.phase === 'paused')
      .map(async role => {
        const agent = this.ctx.agents.get(SessionId(role.sessionId))
        if (agent === undefined) return
        try {
          await pauseLocalGoalContinuation(this.ctx, role.sessionId)
        } catch (error) {
          try {
            this.ctx.goals.disarm(agent)
          } catch {
            // A later exact startup edge retries the same persisted pause projection.
          }
          this.ctx.logger.warn(
            `AutoLab kept paused role ${role.sessionId} disarmed after Goal pause failure: ${renderError(error)}`,
          )
        }
      }))
  }

  private async readAttachedRoles(
    state: RuntimeState,
    frozen: FrozenRevision,
    workers: readonly RootRoleBinding[],
  ): Promise<AttachedRole[]> {
    return await Promise.all(workers.map(async role => {
      const roleState = state.roles[role.role_id]!
      const key = roleHandleKey(state.labId, role.role_id)
      const owned = this.roleHandles.get(key)
      const borrowed = this.borrowedRoleAgents.get(key)
      const agent = owned?.agent ?? borrowed
      if (agent === undefined
        || agent.id !== SessionId(roleState.sessionId)
        || this.ctx.agents.get(agent.id) !== agent) {
        throw new AutoLabRuntimeError(
          `Role ${role.role_id} is no longer attached to its exact live Agent`,
          'ROLE_ACTIVATION_UNAVAILABLE',
        )
      }
      const binding = await readRoleBinding(
        frozen.manifest.authority_paths.lab_dir,
        role.role_id,
      )
      if (roleState.binding === undefined
        || binding?.path !== roleState.binding.path
        || binding.hash !== roleState.binding.hash) {
        throw new AutoLabRuntimeError(
          `Role ${role.role_id} binding drifted while attached`,
          'CONFIG_DRIFT',
        )
      }
      return {
        role,
        binding,
        agent,
        ownership: owned === undefined ? 'borrowed' as const : 'owned' as const,
      }
    }))
  }

  private async reconcileCommunicationAcl(
    caller: Agent,
    state: RuntimeState,
    frozen: FrozenRevision,
    activated: readonly AttachedRole[],
    signal?: AbortSignal,
    allowPartial = false,
  ): Promise<void> {
    const controllerRole = frozen.manifest.roles.find(role => role.role_kind === 'controller')
    if (controllerRole === undefined) {
      throw new AutoLabRuntimeError('CURRENT has no Controller role', 'CONFIG_DRIFT')
    }
    const liveController = this.ctx.agents.get(SessionId(state.controllerSessionId))
    const controller = liveController ?? caller
    if (String(controller.id) !== state.controllerSessionId) {
      throw new AutoLabRuntimeError('Controller communication identity drifted', 'CONFIG_DRIFT')
    }
    const attachedRoleIds = new Set(activated.map(item => item.role.role_id))
    const quarantineSessions = allowPartial
      ? frozen.manifest.roles.flatMap(role => {
          if (role.role_kind === 'controller' || attachedRoleIds.has(role.role_id)) return []
          const projected = state.roles[role.role_id]
          if (projected === undefined) return []
          const live = this.ctx.agents.get(SessionId(projected.sessionId))
          return live === undefined ? [] : [{ roleId: role.role_id, agent: live }]
        })
      : []
    await reconcileCommunicationAcl({
      manifest: frozen.manifest,
      revealState: state.revealState
        ?? frozen.manifest.communication.reveal_policy.initial_state,
      roleSessions: [
        { roleId: controllerRole.role_id, agent: controller },
        ...activated.map(item => ({
          roleId: item.role.role_id,
          agent: item.agent,
          binding: item.binding,
        })),
      ],
      messaging: this.requireSessionMessaging(),
      controllerOffline: liveController === undefined,
      authorizedManifestHashes: await listCommittedManifestHashes(
        frozen.manifest.authority_paths.lab_dir,
      ),
      ...(allowPartial ? { allowPartial: true, quarantineSessions } : {}),
      ...(signal === undefined ? {} : { signal }),
    })
  }

  private hasAttachedRoleSet(state: RuntimeState): boolean {
    const roles = Object.entries(state.roles)
    return roles.length > 0 && roles.every(([roleId, role]) => {
      const handle = this.roleHandles.get(roleHandleKey(state.labId, roleId))
      const borrowed = this.borrowedRoleAgents.get(roleHandleKey(state.labId, roleId))
      const agent = handle?.agent ?? borrowed
      return agent !== undefined
        && agent.id === SessionId(role.sessionId)
        && this.ctx.agents.get(SessionId(role.sessionId)) === agent
    })
  }

  private requireAgentPresets(): NativeAgentPresets {
    const service = this.ctx.get('agentPresets', false) as NativeAgentPresets | undefined
    if (service === undefined) {
      throw new AutoLabRuntimeError('DSH agent presets are unavailable', 'ROLE_ACTIVATION_UNAVAILABLE')
    }
    return service
  }

  private requireSessionPersistence(): NativeSessionPersistence {
    const service = this.ctx.get('sessionPersistence', false) as NativeSessionPersistence | undefined
    if (service === undefined) {
      throw new AutoLabRuntimeError('DSH Session persistence is unavailable', 'ROLE_ACTIVATION_UNAVAILABLE')
    }
    return service
  }

  private requireSessionMessaging(): CommunicationAclMessaging {
    const service = this.ctx.get('sessionMessaging', false) as CommunicationAclMessaging | undefined
    if (service === undefined) {
      throw new AutoLabRuntimeError('local Session messaging is unavailable', 'ROLE_ACTIVATION_UNAVAILABLE')
    }
    return service
  }

  private resolveReviewCapability(controlId: string): ReviewControlCapability | undefined {
    for (const state of this.view.values()) {
      for (const review of Object.values(state.reviews)) {
        const capability = review.capability
        if (capability.request.controlId !== controlId
          && capability.acceptedPause.controlId !== controlId) continue
        const worker = state.roles[capability.workerRoleId]
        const judge = state.roles[capability.judgeRoleId]
        if (state.config?.revision !== capability.configRevision
          || worker?.sessionId !== capability.workerSessionId
          || worker.phase !== 'reviewing'
          || worker.activationBlocker !== undefined
          || judge?.sessionId !== capability.judgeSessionId
          || judge.activationBlocker !== undefined) {
          return undefined
        }
        return capability
      }
    }
    return undefined
  }

  private async replayActiveReviewRequests(
    state: RuntimeState,
    signal?: AbortSignal,
  ): Promise<void> {
    const settled = await Promise.allSettled(Object.values(state.reviews)
      .filter(review => (
        !reviewHasOutput(review) || !reviewFreezeComplete(review, state.ownerEpoch)
      ))
      .map(async review => {
        const worker = this.ctx.agents.get(SessionId(review.capability.workerSessionId))
        if (worker === undefined) {
          throw new AutoLabRuntimeError(
            `review worker Session ${review.capability.workerSessionId} is not live`,
            'ROLE_ACTIVATION_UNAVAILABLE',
          )
        }
        const request = await sendReviewRequest(this.ctx, worker, review.capability, signal)
        if (controlReceiptFailed(request)) {
          throw new AutoLabRuntimeError(
            `review ${review.capability.reviewId} transport is ${controlReceiptFailure(request)}`,
            'REVIEW_TRANSPORT_FAILED',
          )
        }
        try {
          const accepted = await this.ctx.sessionMessaging.getControl(
            worker,
            review.capability.acceptedPause.controlId,
            signal,
          )
          if (controlReceiptFailed(accepted)) {
            throw new AutoLabRuntimeError(
              `review ${review.capability.reviewId} ACK transport is ${controlReceiptFailure(accepted)}`,
              'REVIEW_TRANSPORT_FAILED',
            )
          }
          if (!reviewHasOutput(review)
            && reviewFreezeComplete(review, state.ownerEpoch)) {
            await this.startJudgeReviewOnce(reviewJudgeStart(review.capability), signal)
          }
          // start() owns the current Lab queue slot. Reconciliation is
          // appended behind it instead of recursively awaiting the same queue.
          this.trackReviewControlStatus(accepted)
        } catch (error) {
          if (!(error instanceof SessionMessagingError)
            || error.code !== 'MESSAGE_NOT_FOUND') throw error
        }
      }))
    signal?.throwIfAborted()
    for (const result of settled) {
      if (result.status !== 'rejected') continue
      this.ctx.logger.warn(
        `AutoLab kept one review locally pending after replay failure: ${renderError(result.reason)}`,
      )
    }
  }

  private trackReviewControlStatus(receipt: ControlReceipt): void {
    if (!this.accepting) return
    const task = this.handleReviewControlStatus(receipt)
    this.reviewStatusTasks.add(task)
    void task.catch(error => {
      if (this.shutdown.signal.aborted) return
      this.ctx.logger.warn(
        `AutoLab review pause reconciliation failed: ${renderError(error)}`,
      )
    }).finally(() => {
      this.reviewStatusTasks.delete(task)
    })
  }

  private async handleReviewControlStatus(receipt: ControlReceipt): Promise<void> {
    if (!this.accepting
      || receipt.kind !== REVIEW_ACCEPTED_PAUSE
      || receipt.outcome?.status !== 'completed'
      || !isRecord(receipt.outcome.result)
      || receipt.outcome.result.type !== 'REVIEW_PAUSE_OUTCOME'
      || typeof receipt.outcome.result.reviewId !== 'string'
      || (receipt.outcome.result.activeTurn !== true
        && receipt.outcome.result.activeTurn !== false)
      || (receipt.outcome.result.activeTurn === true
        && (!Number.isSafeInteger(receipt.outcome.result.observedTurn)
          || (receipt.outcome.result.observedTurn as number) <= 0))
      || (receipt.outcome.result.activeTurn === false
        && receipt.outcome.result.observedTurn !== undefined)
      || (receipt.outcome.result.turnOutcome !== 'stopped'
        && receipt.outcome.result.turnOutcome !== 'source-active'
        && receipt.outcome.result.turnOutcome !== 'user-override')
      || (receipt.outcome.result.turnOutcome === 'stopped'
        && receipt.outcome.result.activeTurn !== false)
      || (receipt.outcome.result.turnOutcome !== 'stopped'
        && receipt.outcome.result.activeTurn !== true)
      || (receipt.outcome.result.goalOutcome !== 'paused'
        && receipt.outcome.result.goalOutcome !== 'already-applied'
        && receipt.outcome.result.goalOutcome !== 'no-active-goal'
        && receipt.outcome.result.goalOutcome !== 'stale')) return

    const located = this.findActiveReview(receipt.outcome.result.reviewId)
    if (located === undefined) return
    const { state, review } = located
    if (review.capability.acceptedPause.controlId !== receipt.controlId
      || review.capability.acceptedPause.payloadHash !== receipt.payloadHash
      || state.roles[review.capability.workerRoleId]?.phase !== 'reviewing') return

    const goalOutcome = receipt.outcome.result.goalOutcome
    const activeTurn = receipt.outcome.result.activeTurn
    const observedTurn = activeTurn
      ? receipt.outcome.result.observedTurn as number
      : undefined
    const expectedTurnOutcome = observedTurn === undefined
      ? 'stopped' as const
      : observedTurn === review.capability.sourceTurn
        ? 'source-active' as const
        : 'user-override' as const
    if (receipt.outcome.result.turnOutcome !== expectedTurnOutcome) return
    const goalRef = isReviewGoalRef(receipt.outcome.result.goalRef)
      ? receipt.outcome.result.goalRef
      : undefined
    const freeze = goalOutcome === 'stale'
      ? 'stale' as const
      : expectedTurnOutcome === 'user-override'
        ? 'user-override' as const
        : expectedTurnOutcome === 'source-active'
        ? 'hold-pending' as const
        : 'stopped' as const
    await this.recordReviewPauseOutcome(state.labId, review.capability.reviewId, {
      controlId: receipt.controlId,
      payloadHash: receipt.payloadHash,
      completedAt: receipt.updatedAt,
      goalOutcome,
      activeTurn,
      ...(observedTurn === undefined ? {} : { observedTurn }),
      ...(goalRef === undefined ? {} : { goalRef }),
      ...(freeze === 'user-override' ? { detail: 'SOURCE_TURN_CHANGED' } : {}),
      freeze,
    })
    if (freeze === 'hold-pending') {
      await this.acquireReviewHoldOnce(state.labId, review.capability.reviewId)
    }
    await this.startJudgeReviewIfFrozen(review.capability.reviewId)
  }

  private async startJudgeReviewIfFrozen(reviewId: string): Promise<void> {
    const located = this.findActiveReview(reviewId)
    if (located === undefined
      || reviewHasOutput(located.review)
      || !reviewFreezeComplete(located.review, located.state.ownerEpoch)) return
    await this.startJudgeReviewOnce(reviewJudgeStart(located.review.capability))
  }

  private async recordReviewPauseOutcome(
    labId: string,
    reviewId: string,
    pause: RuntimeState['reviews'][string]['pause'],
  ): Promise<void> {
    await this.enqueue(labId, async () => {
      const state = this.requireState(labId)
      const review = state.reviews[reviewId]
      if (review === undefined
        || review.pause.controlId !== pause.controlId
        || review.pause.payloadHash !== pause.payloadHash) return
      if (review.pause.freeze !== 'pending') {
        if (!sameReviewPauseReceipt(review.pause, pause)) {
          throw new AutoLabRuntimeError(
            `Review ${reviewId} received a conflicting pause outcome`,
            'CONFIG_DRIFT',
          )
        }
        return
      }
      const reviews = structuredClone(state.reviews)
      reviews[reviewId] = { ...review, pause, updatedAt: Date.now() }
      await this.transition(
        state,
        state.lifecycle,
        undefined,
        undefined,
        undefined,
        reviews,
      )
    })
  }

  private async acquireReviewHoldOnce(labId: string, reviewId: string): Promise<void> {
    const key = reviewHoldKey(labId, reviewId)
    const existing = this.reviewHoldTasks.get(key)
    if (existing !== undefined) return await existing
    const task = this.acquireReviewHold(labId, reviewId, key)
    this.reviewHoldTasks.set(key, task)
    try {
      await task
    } finally {
      if (this.reviewHoldTasks.get(key) === task) this.reviewHoldTasks.delete(key)
    }
  }

  private async acquireReviewHold(
    labId: string,
    reviewId: string,
    key: string,
  ): Promise<void> {
    const located = this.findActiveReview(reviewId)
    if (located?.state.labId !== labId || located.review.pause.freeze !== 'hold-pending') return
    const ownerEpoch = this.requireOwner().owner.token
    const worker = this.ctx.agents.get(SessionId(located.review.capability.workerSessionId))
    if (worker === undefined) {
      await this.finishReviewFreeze(labId, reviewId, 'user-override', 'SESSION_NOT_LOCAL')
      return
    }
    if (worker.status !== 'running') {
      await this.finishReviewFreeze(labId, reviewId, 'stopped')
      return
    }

    const result = await acquireLocalReviewHold(
      this.ctx,
      located.review.capability.workerSessionId,
      located.review.pause.observedTurn!,
      this.shutdown.signal,
    )
    if (result.outcome === 'not-required') {
      await this.finishReviewFreeze(labId, reviewId, 'stopped')
      return
    }
    if (result.outcome === 'user-override' || result.hold === undefined) {
      await this.finishReviewFreeze(labId, reviewId, 'user-override', 'SESSION_BUSY')
      return
    }
    if (!this.accepting) {
      await result.hold.release()
      return
    }
    const current = this.findActiveReview(reviewId)
    if (current?.state.labId !== labId || current.review.pause.freeze !== 'hold-pending') {
      await result.hold.release()
      return
    }
    const previous = this.reviewHolds.get(key)
    if (previous !== undefined) {
      await result.hold.release()
      return
    }
    this.reviewHolds.set(key, result.hold)
    try {
      await this.finishReviewFreeze(labId, reviewId, 'held', undefined, ownerEpoch)
    } catch (error) {
      if (this.reviewHolds.get(key) === result.hold) this.reviewHolds.delete(key)
      await result.hold.release()
      throw error
    }
  }

  private async finishReviewFreeze(
    labId: string,
    reviewId: string,
    freeze: 'stopped' | 'held' | 'user-override',
    detail?: string,
    holdOwnerEpoch?: string,
  ): Promise<void> {
    await this.enqueue(labId, async () => {
      const state = this.requireState(labId)
      const review = state.reviews[reviewId]
      if (review === undefined || review.pause.freeze !== 'hold-pending') return
      const pause = {
        ...review.pause,
        freeze,
        ...(detail === undefined ? {} : { detail }),
        ...(holdOwnerEpoch === undefined ? {} : { holdOwnerEpoch }),
      } satisfies RuntimeState['reviews'][string]['pause']
      const reviews = structuredClone(state.reviews)
      reviews[reviewId] = { ...review, pause, updatedAt: Date.now() }
      await this.transition(
        state,
        state.lifecycle,
        undefined,
        undefined,
        undefined,
        reviews,
      )
    })
  }

  private async startJudgeReviewOnce(
    input: ReviewJudgeStart,
    signal?: AbortSignal,
  ): Promise<ReviewJudgeStartOutcome> {
    this.shutdown.signal.throwIfAborted()
    signal?.throwIfAborted()
    const located = this.findActiveReview(input.reviewId)
    if (located === undefined) return 'already-started'
    const { state, review } = located
    const capability = review.capability
    if (capability.judgeSessionId !== input.judgeSessionId
      || capability.workerSessionId !== input.workerSessionId
      || capability.assignmentId !== input.assignmentId
      || capability.packetHash !== input.packetHash
      || capability.artifactHash !== input.artifactHash
      || capability.negotiatedAnchorHash !== input.negotiatedAnchorHash) {
      throw new AutoLabRuntimeError('review wake no longer matches RuntimeState', 'CONFIG_DRIFT')
    }
    if (reviewHasOutput(review)) return 'already-started'
    if (!reviewFreezeComplete(review, state.ownerEpoch)) {
      throw new AutoLabRuntimeError(
        `Review ${input.reviewId} worker freeze is not complete`,
        'REVIEW_NOT_READY',
      )
    }
    const judge = this.ctx.agents.get(SessionId(input.judgeSessionId))
    if (judge === undefined) {
      throw new AutoLabRuntimeError(
        `Judge Session ${input.judgeSessionId} is not live`,
        'ROLE_ACTIVATION_UNAVAILABLE',
      )
    }
    const messageId = MessageId(input.wakeId)
    const alreadyPresent = judge.inbox.nextTurn.some(message => message.id === messageId)
      || judge.inbox.nextStep.some(message => message.id === messageId)
      || judge.session.events.some(event => (
        event.type === 'user/message' && event.data.id === messageId
      ))
    if (alreadyPresent) {
      // The stable wake may be present only in memory after an earlier flush
      // failure. Re-flush before claiming the idempotent effect is durable.
      await flushSessionDurably(this.ctx, judge.session, 'AutoLab Judge wake replay')
      return 'already-started'
    }

    this.shutdown.signal.throwIfAborted()
    signal?.throwIfAborted()
    judge.followup(freezeMessage({
      id: messageId,
      role: 'user',
      content: [{
        type: 'text',
        text: [
          `AutoLab Review-ID: ${JSON.stringify(input.reviewId)}`,
          `Review Role-Packet path: ${review.packetPath}`,
          `Review Role-Packet SHA-256: ${capability.packetHash}`,
          `Frozen submission path: ${review.artifactPath}`,
          `Frozen submission SHA-256: ${capability.artifactHash}`,
          `Negotiated anchor SHA-256: ${capability.negotiatedAnchorHash}`,
          'Read the exact frozen files. Perform only the rubric-bound review and return its declared output contract; do not reconstruct the task from chat memory.',
        ].join('\n'),
      }],
      source: {
        kind: 'plugin',
        plugin: 'dsh-autolab',
        form: 'notice',
        summary: `AutoLab review ${input.reviewId}`,
      },
    }))
    await flushSessionDurably(this.ctx, judge.session, 'AutoLab Judge wake')
    return 'started'
  }

  private findActiveReview(reviewId: string): {
    readonly state: RuntimeState
    readonly review: RuntimeState['reviews'][string]
  } | undefined {
    for (const state of this.view.values()) {
      const review = state.reviews[reviewId]
      if (review !== undefined) return { state, review }
    }
    return undefined
  }

  private resolveExactRoleCaller(caller: Agent): {
    readonly state: RuntimeState
    readonly roleId: string
  } {
    if (this.ctx.agents.get(caller.id) !== caller) {
      throw new AutoLabRuntimeError(
        `Session ${String(caller.id)} is not a live AutoLab role Agent`,
        'ROLE_MISMATCH',
      )
    }
    const matches: Array<{
      state: RuntimeState
      roleId: string
      activationBlocker?: RoleActivationBlocker
    }> = []
    for (const state of this.view.values()) {
      for (const [roleId, role] of Object.entries(state.roles)) {
        if (role.sessionId !== String(caller.id)) continue
        const handle = this.roleHandles.get(roleHandleKey(state.labId, roleId))
        const borrowed = this.borrowedRoleAgents.get(roleHandleKey(state.labId, roleId))
        if ((handle?.agent === caller && handle.sessionId === caller.id)
          || borrowed === caller) {
          matches.push({
            state,
            roleId,
            ...(role.activationBlocker === undefined
              ? {}
              : { activationBlocker: role.activationBlocker }),
          })
        }
      }
    }
    if (matches.length !== 1) {
      throw new AutoLabRuntimeError(
        `Session ${String(caller.id)} does not resolve to exactly one owned AutoLab role`,
        'ROLE_MISMATCH',
      )
    }
    const match = matches[0]!
    if (match.activationBlocker !== undefined) {
      throw new AutoLabRuntimeError(
        `Role ${match.roleId} is unavailable: ${match.activationBlocker.message}`,
        'ROLE_ACTIVATION_UNAVAILABLE',
      )
    }
    return { state: match.state, roleId: match.roleId }
  }

  private resolveApiRecoveryAssignment(agent: Agent): ApiRecoveryAssignment | undefined {
    const controllerGoal = this.ctx.goals.get(agent)
    const controllerMatches = [...this.view.values()].filter(state => (
      state.controllerSessionId === String(agent.id)
      && state.controllerGoal?.status === 'applied'
      && state.controllerGoal.goalId !== undefined
      && state.controllerGoal.goalRevision !== undefined
      && controllerGoal !== undefined
      && String(controllerGoal.id) === state.controllerGoal.goalId
      && sha256(controllerGoal.objective) === state.controllerGoal.objectiveHash
    ))
    if (controllerMatches.length === 1) {
      const state = controllerMatches[0]!
      const install = state.controllerGoal!
      if (state.config !== undefined) {
        return {
          labId: state.labId,
          roleId: install.roleId,
          sessionId: String(agent.id),
          assignmentId: install.assignmentId,
          packetHash: install.packetHash,
          continuation: {
            kind: 'goal',
            goalRef: {
              id: GoalId(install.goalId!),
              revision: install.goalRevision!,
            },
            objectiveHash: install.objectiveHash,
          },
        }
      }
    }

    let located: ReturnType<AutoLabRuntime['resolveExactRoleCaller']>
    try {
      located = this.resolveExactRoleCaller(agent)
    } catch {
      return undefined
    }
    const { state, roleId } = located
    const role = state.roles[roleId]
    if (role === undefined) return undefined

    const reviews = Object.values(state.reviews).filter(review => (
      review.phase === 'reviewing'
      && !reviewHasOutput(review)
      && review.capability.judgeRoleId === roleId
      && review.capability.judgeSessionId === String(agent.id)
    ))
    if (reviews.length === 1) {
      const review = reviews[0]!
      return {
        labId: state.labId,
        roleId,
        sessionId: String(agent.id),
        assignmentId: review.capability.assignmentId,
        packetHash: review.capability.packetHash,
        continuation: {
          kind: 'review',
          reviewId: review.capability.reviewId,
          reviewAnchorHash: review.capability.negotiatedAnchorHash,
        },
      }
    }

    const install = role.goalInstall
    if (reviews.length !== 0
      || role.packet === undefined
      || install?.status !== 'applied'
      || install.goalId === undefined
      || install.goalRevision === undefined) return undefined
    return {
      labId: state.labId,
      roleId,
      sessionId: String(agent.id),
      assignmentId: install.assignmentId,
      packetHash: role.packet.hash,
      continuation: {
        kind: 'goal',
        goalRef: { id: GoalId(install.goalId), revision: install.goalRevision },
        objectiveHash: install.objectiveHash,
      },
    }
  }

  private async resumeApiReviewOnce(
    agent: Agent,
    wake: ReviewApiRecoveryWake,
    signal: AbortSignal,
  ): Promise<'started' | 'already-started' | 'stale'> {
    signal.throwIfAborted()
    const located = this.findActiveReview(wake.reviewId)
    if (located === undefined) return 'stale'
    const { state, review } = located
    const capability = review.capability
    if (state.labId !== wake.labId
      || review.phase !== 'reviewing'
      || reviewHasOutput(review)
      || capability.judgeRoleId !== wake.roleId
      || capability.judgeSessionId !== wake.sessionId
      || capability.judgeSessionId !== String(agent.id)
      || capability.assignmentId !== wake.assignmentId
      || capability.packetHash !== wake.packetHash
      || capability.negotiatedAnchorHash !== wake.reviewAnchorHash) return 'stale'

    return await this.startJudgeReviewOnce({
      ...reviewJudgeStart(capability),
      wakeId: wake.wakeId,
    }, signal)
  }

  private async notifyOperatorIncident(record: OperatorApiIncidentRecord): Promise<void> {
    if (!this.accepting || this.shutdown.signal.aborted) return
    const state = this.view.get(record.labId)
    if (state === undefined) return
    const controller = this.ctx.agents.get(SessionId(state.controllerSessionId))
    if (controller === undefined) {
      this.ctx.logger.warn(
        `AutoLab ${record.labId} retained API incident for offline Controller ${state.controllerSessionId}`,
      )
      return
    }
    const id = MessageId(`autolab-api-incident:${sha256(canonicalJson(record))}`)
    const alreadyPresent = controller.inbox.nextTurn.some(message => message.id === id)
      || controller.inbox.nextStep.some(message => message.id === id)
      || controller.session.events.some(event => (
        event.type === 'user/message' && event.data.id === id
      ))
    if (!alreadyPresent) {
      controller.followup(freezeMessage({
        id,
        role: 'user',
        content: [{
          type: 'text',
          text: [
            `AutoLab ${record.labId} exhausted its safe mechanical API recovery path.`,
            'The exact active incident follows; decide only the credential, configuration, quota, authorization, or request change it requires.',
            canonicalJson(record),
          ].join('\n'),
        }],
        source: {
          kind: 'plugin',
          plugin: 'dsh-autolab',
          form: 'notice',
          summary: `AutoLab API incident ${record.labId}`,
        },
      }))
    }
    await flushSessionDurably(this.ctx, controller.session, 'AutoLab operator incident')
  }

  private async dispatchReviewRequest(
    caller: Agent,
    capability: ReviewControlCapability,
    signal?: AbortSignal,
  ): Promise<void> {
    const receipt = await sendReviewRequest(this.ctx, caller, capability, signal)
    if (receipt.status === 'failed' || receipt.status === 'expired') {
      throw new AutoLabRuntimeError(
        `Review ${capability.reviewId} transport is ${receipt.status}; its persisted scientific state is unchanged`,
        'REVIEW_TRANSPORT_FAILED',
      )
    }
  }

  private async syncDialogue(caller: Agent, state: RuntimeState): Promise<void> {
    await this.dialogue.appendSessionEvents({
      labId: state.labId,
      controllerSessionId: state.controllerSessionId,
      events: caller.session?.events ?? [],
    })
  }

  private isControllerAgent(agent: Agent): boolean {
    return this.ctx.agents.get(agent.id) === agent
      && [...this.view.values()].some(state => state.controllerSessionId === String(agent.id))
  }

  private attachControllerSurface(agent: Agent): void {
    if (!this.isControllerAgent(agent)) return
    const sessionId = String(agent.id)
    const existing = this.controllerSurfaces.get(sessionId)
    if (existing?.agent === agent) return
    existing?.dispose()
    const dispose = installControllerSurface(
      agent,
      this,
      () => this.controllerKernelText(sessionId),
    )
    this.controllerSurfaces.set(sessionId, { agent, dispose })
  }

  private controllerKernelText(sessionId: string): string {
    const labs = [...this.view.values()]
      .filter(state => state.controllerSessionId === sessionId)
      .sort((left, right) => left.labId.localeCompare(right.labId))
    const owned = labs.length === 0
      ? '- no current AutoLab binding'
      : labs.map(state => {
          const directory = this.artifacts.labDirectory(state.labId)
          const source = state.config === undefined
            ? join(directory, 'draft')
            : join(directory, state.config.revisionPath)
          return `- ${state.labId}: ${state.lifecycle}; authoritative documents: ${source}`
        }).join('\n')
    return [
      rolePromptFor('controller').text,
      'Controller-scoped AutoLab tools are available only in this existing Session. AutoLabWait is the only waiting primitive; it pauses the native Goal and never polls.',
      'Labs owned by this exact Session:',
      owned,
    ].join('\n\n')
  }

  private trackAttemptTask(task: Promise<unknown>): void {
    this.attemptTasks.add(task)
    void task.catch(error => {
      if (!this.shutdown.signal.aborted) {
        this.ctx.logger.warn(`AutoLab deferred an Attempt event: ${renderError(error)}`)
      }
    }).finally(() => this.attemptTasks.delete(task))
  }

  /** Dispatch only materialized active references; never scan run directories or history. */
  private async dispatchAllActiveAttempts(edge: 'startup' | 'poke'): Promise<void> {
    const runtime = this.requireAttemptRuntime()
    const targets = [...this.view.values()].flatMap(state => (
      Object.entries(state.trials).flatMap(([trialId, trial]) => (
        Object.entries(trial.runSlots).flatMap(([runSlotId, slot]) => (
          slot.activeAttempt === undefined
            ? []
            : [{ labId: state.labId, trialId, runSlotId }]
        ))
      ))
    )).sort((left, right) => (
      left.labId.localeCompare(right.labId)
      || left.trialId.localeCompare(right.trialId)
      || left.runSlotId.localeCompare(right.runSlotId)
    ))
    const settled = await Promise.allSettled(targets.map(target => runtime.dispatch(target, edge)))
    for (const result of settled) {
      if (result.status === 'rejected' && !this.shutdown.signal.aborted) {
        this.ctx.logger.warn(`AutoLab kept one active Attempt pending: ${renderError(result.reason)}`)
      }
    }
  }

  /** Apply at most one exact Attempt projection, then deliver its high-value event. */
  private async applyAttemptRuntimeResult(result: AttemptRuntimeResult): Promise<void> {
    if (result.outcome !== 'handled') return
    const target = result.target
    const projection = result.projection
    if (projection !== undefined) {
      let retryFromNewProjection = false
      await this.enqueue(target.labId, async () => {
        const state = this.requireState(target.labId)
        const trial = state.trials[target.trialId]
        const slot = trial?.runSlots[target.runSlotId]
        const currentReference = slot?.activeAttempt
        if (trial === undefined || slot === undefined || currentReference === undefined) return
        if (canonicalJson(currentReference) === canonicalJson(projection.activeAttempt)
          && canonicalJson(slot.state) === canonicalJson(projection.runSlotState)) return
        if (state.runtimeRevision !== projection.expectedRuntimeRevision
          || canonicalJson(currentReference) !== canonicalJson(projection.expectedActiveAttempt)) {
          retryFromNewProjection = canonicalJson(currentReference)
            === canonicalJson(projection.expectedActiveAttempt)
          return
        }
        const trials = structuredClone(state.trials)
        trials[target.trialId]!.runSlots[target.runSlotId] = {
          ...trials[target.trialId]!.runSlots[target.runSlotId]!,
          state: projection.runSlotState,
          activeAttempt: projection.activeAttempt,
        }
        await this.transition(
          state,
          state.lifecycle,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          trials,
        )
      })
      if (retryFromNewProjection && this.accepting) {
        // One concurrent Lab CAS won. Re-read the same exact active reference
        // once after this consumer tail; this is not a timer or polling loop.
        this.trackAttemptTask(this.requireAttemptRuntime().dispatch(target, 'poke'))
        return
      }
    }

    let state = this.view.get(target.labId)
    const current = state?.trials[target.trialId]?.runSlots[target.runSlotId]?.activeAttempt
    if (state === undefined || current === undefined) return
    if (projection !== undefined
      && canonicalJson(current) !== canonicalJson(projection.activeAttempt)) return
    if (state.lifecycle !== 'running' && state.lifecycle !== 'blocked') return

    const attemptId = current.attemptId
    if (result.controllerWake !== undefined
      && result.controllerWake.controllerSessionId === state.controllerSessionId
      && result.controllerWake.attemptId === attemptId
      && result.controllerWake.phase === current.phase) {
      state = await this.wakeControllerForEvent(
        state,
        `attempt:${attemptId}:${current.phase}`,
        [
          `AutoLab ${state.labId} Attempt ${attemptId} reached ${current.phase}.`,
          `Trial ${target.trialId}; RunSlot ${target.runSlotId}.`,
          'Read the exact Attempt and Lab-authored evidence paths from RuntimeState and the frozen artifacts before deciding Postflight or recovery work.',
        ].join('\n'),
      )
      return
    }

    const escalation = attemptEscalation(result)
    if (escalation === undefined) return
    await this.wakeControllerForEvent(
      state,
      `attempt-runtime:${attemptId}:${escalation.code}`,
      [
        `AutoLab ${state.labId} Attempt ${attemptId} exhausted its bounded mechanical edge.`,
        `Trial ${target.trialId}; RunSlot ${target.runSlotId}.`,
        `${escalation.code}: ${escalation.message}`,
        'Assign Ops or decide the required environment, process, identity, credential, or authorization change; do not infer a scientific result from this incident.',
      ].join('\n'),
    )
  }

  private trackControllerTask(task: Promise<void>): void {
    this.controllerTasks.add(task)
    void task.catch(error => {
      if (!this.shutdown.signal.aborted) {
        this.ctx.logger.warn(`AutoLab deferred a Controller mechanical action: ${renderError(error)}`)
      }
    }).finally(() => this.controllerTasks.delete(task))
  }

  private async reconcileControllerAgent(agent: Agent): Promise<void> {
    if (!this.accepting || this.ctx.agents.get(agent.id) !== agent) return
    const labIds = [...this.view.values()]
      .filter(state => state.controllerSessionId === String(agent.id))
      .map(state => state.labId)
      .sort()
    for (const labId of labIds) {
      await this.enqueue(labId, async () => {
        let state = this.requireState(labId)
        if (state.controllerSessionId !== String(agent.id)) return
        if (state.config === undefined) return
        const frozen = await this.artifacts.readCurrent(labId)
        if (!sameConfigRef(state.config, frozen.ref)) {
          throw new AutoLabRuntimeError(
            `Lab ${labId} CURRENT does not match RuntimeState during Controller attach`,
            'CONFIG_DRIFT',
          )
        }
        if (state.lifecycle === 'running'
          || state.lifecycle === 'starting'
          || state.lifecycle === 'blocked') {
          state = await this.armControllerGoal(agent, state, frozen)
          await this.replayRecordedReviewNotifications(state)
          return
        }
        if (state.lifecycle === 'paused'
          || state.lifecycle === 'pausing'
          || state.lifecycle === 'stopped') {
          const paused = await this.pauseControllerNativeGoal(agent, state)
          if (paused.controllerGoal !== state.controllerGoal) {
            state = await this.transition(
              state,
              state.lifecycle,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              paused.controllerGoal,
            )
          }
        }
      })
    }
  }

  /** Recover only missing stable review notices from the small RuntimeState. */
  private async replayRecordedReviewNotifications(state: RuntimeState): Promise<RuntimeState> {
    const recorded = Object.entries(state.reviews)
      .filter(([, review]) => reviewHasOutput(review))
      .sort((left, right) => (
        left[1].updatedAt - right[1].updatedAt || left[0].localeCompare(right[0])
      ))
    for (const [reviewId, review] of recorded) {
      if (review.stage === 'preflight' && review.verdict !== undefined) {
        state = await this.wakeControllerForEvent(
          state,
          `preflight-verdict:${reviewId}:${review.verdict.hash}`,
          [
            `AutoLab ${state.labId} Preflight review ${reviewId} recorded ${review.verdict.topLevelVerdict}.`,
            `Read the complete original verdict at ${review.verdict.path} (sha256 ${review.verdict.hash}) and decide the next responsibility from CURRENT.`,
          ].join('\n'),
        )
      } else if (review.stage === 'postflight' && review.result !== undefined) {
        state = await this.wakeControllerForEvent(
          state,
          `postflight-result:${reviewId}:${review.result.hash}`,
          postflightControllerEventText(
            state.labId,
            reviewId,
            review.result.path,
            review.result.hash,
          ),
        )
      }
    }
    const receipts = Object.entries(state.roles)
      .flatMap(([roleId, role]) => role.receipt === undefined ? [] : [{ roleId, receipt: role.receipt }])
      .sort((left, right) => (
        left.receipt.recordedAt - right.receipt.recordedAt || left.roleId.localeCompare(right.roleId)
      ))
    for (const { roleId, receipt } of receipts) {
      state = await this.wakeControllerForEvent(
        state,
        `role-result:${roleId}:${receipt.assignmentId}:${receipt.hash}`,
        roleResultControllerEventText(
          state.labId,
          roleId,
          receipt.assignmentId,
          receipt.path,
          receipt.hash,
        ),
      )
    }
    return state
  }

  private async finalizeRoleResultNotification(
    caller: Agent,
    result: AutoLabRoleResultSubmission,
    artifactPath: string,
    artifactHash: string,
  ): Promise<void> {
    try {
      await pauseLocalGoalContinuation(this.ctx, String(caller.id))
    } catch {
      try {
        this.ctx.goals.disarm(caller)
      } catch {
        // RuntimeState already projects paused; startup reconciliation retries the pause.
      }
    }
    await this.enqueue(result.labId, async () => {
      const state = this.requireState(result.labId)
      const role = state.roles[result.roleId]
      if (role?.phase !== 'paused'
        || role.receipt?.assignmentId !== result.assignmentId
        || role.receipt.path !== artifactPath
        || role.receipt.hash !== artifactHash) {
        throw new AutoLabRuntimeError(
          `Role ${result.roleId} result notification lost its durable receipt`,
          'CONFIG_DRIFT',
        )
      }
      await this.wakeControllerForEvent(
        state,
        `role-result:${result.roleId}:${result.assignmentId}:${artifactHash}`,
        roleResultControllerEventText(
          result.labId,
          result.roleId,
          result.assignmentId,
          artifactPath,
          artifactHash,
        ),
      )
    })
  }

  private async trackControllerGoalChange(
    agent: Agent,
    goalId: string,
    goalRevision: number,
    goal: GoalView | undefined,
  ): Promise<void> {
    if (!this.accepting || this.ctx.agents.get(agent.id) !== agent) return
    const matches = [...this.view.values()].filter(state => (
      state.controllerSessionId === String(agent.id)
      && state.controllerGoal?.goalId === goalId
      && (goal === undefined || sha256(goal.objective) === state.controllerGoal.objectiveHash)
    ))
    for (const snapshot of matches) {
      await this.enqueue(snapshot.labId, async () => {
        const state = this.requireState(snapshot.labId)
        const stored = state.controllerGoal
        if (stored?.goalId !== goalId
          || stored.goalRevision === goalRevision
          || (goal !== undefined && sha256(goal.objective) !== stored.objectiveHash)) return
        await this.transition(
          state,
          state.lifecycle,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { ...stored, goalRevision },
        )
      })
    }
  }

  /** Keep only the native Goal CAS ref current for one exact AutoLab role. */
  private async trackRoleGoalChange(agent: Agent, goal: GoalView): Promise<void> {
    if (!this.accepting || this.ctx.agents.get(agent.id) !== agent) return
    const edge = {
      sessionId: String(agent.id),
      goalId: String(goal.id),
      goalRevision: goal.revision,
      objectiveHash: sha256(goal.objective),
    }
    const matches = [...this.view.values()].flatMap(state => {
      const projected = projectRoleGoalRevision(state, edge)
      return projected === undefined ? [] : [{ state, projected }]
    })
    if (matches.length !== 1) return
    const snapshot = matches[0]!
    await this.enqueue(snapshot.state.labId, async () => {
      const state = this.requireState(snapshot.state.labId)
      const projected = projectRoleGoalRevision(state, edge)
      if (projected === undefined) return
      await this.transition(
        state,
        state.lifecycle,
        undefined,
        undefined,
        projected.roles,
      )
    })
  }

  /** Resume the same paused Controller Goal from one durable scientific event. */
  private async wakeControllerForEvent(
    state: RuntimeState,
    eventId: string,
    text: string,
  ): Promise<RuntimeState> {
    let stored = state.controllerGoal
    if (stored?.status !== 'applied' || stored.goalId === undefined) return state
    const controller = this.ctx.agents.get(SessionId(state.controllerSessionId))
    if (controller === undefined) return state
    const messageId = MessageId(`autolab-event:${sha256(`${state.labId}\0${eventId}`)}`)
    const alreadyPresent = controller.inbox.nextTurn.some(message => message.id === messageId)
      || controller.inbox.nextStep.some(message => message.id === messageId)
      || controller.session.events.some(event => (
        event.type === 'user/message' && event.data.id === messageId
      ))
    // A historical event must never clear a later, unrelated AutoLabWait.
    if (alreadyPresent) return state
    if (stored.waiting === true) {
      const { waiting: _waiting, ...resumable } = stored
      state = await this.transition(
        state,
        state.lifecycle,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        resumable,
      )
      stored = resumable
    }
    // A transient terminal request already owns this exact continuation. Keep
    // the scientific event durably queued, but let that one-shot retry re-arm
    // the Goal; `inject` itself never wakes an idle Agent.
    const recoveryOwnsGoal = this.controllerApiRecoveryOwnsGoal(state)
    let goal = this.ctx.goals.get(controller)
    if (goal === undefined
      || String(goal.id) !== stored.goalId
      || sha256(goal.objective) !== stored.objectiveHash) return state

    if (!recoveryOwnsGoal && (goal.phase !== 'active' || goal.activation !== 'armed')) {
      if (goal.phase === 'complete' || goal.roundsStarted >= goal.maxGoalRounds) return state
      goal = this.ctx.goals.resume(controller, goalRef(goal))
      try {
        await flushSessionDurably(this.ctx, controller.session, 'Controller event Goal resume')
      } catch (error) {
        if (error instanceof SessionDurabilityError) throw error
        const applied = this.ctx.goals.get(controller)
        if (applied === undefined
          || applied.id !== goal.id
          || applied.revision !== goal.revision) throw error
        await flushSessionDurably(this.ctx, controller.session, 'Controller event Goal resume retry')
      }
      state = await this.transition(
        state,
        state.lifecycle,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { ...stored, goalRevision: goal.revision },
      )
    }

    controller.inject(freezeMessage({
      id: messageId,
      role: 'user',
      content: [{ type: 'text', text }],
      source: {
        kind: 'plugin',
        plugin: 'dsh-autolab',
        form: 'notice',
        summary: `AutoLab event ${state.labId}`,
      },
    }))
    await flushSessionDurably(this.ctx, controller.session, 'Controller event delivery')
    return state
  }

  private runReviewControlHandler(
    operation: () => Promise<ControlHandlerDecision>,
  ): Promise<ControlHandlerDecision> {
    if (!this.accepting || this.shutdown.signal.aborted) {
      return Promise.reject(new AutoLabRuntimeError(
        'AutoLab Controller is not accepting review control work',
        'SERVICE_CLOSED',
      ))
    }
    let task!: Promise<ControlHandlerDecision>
    task = Promise.resolve().then(async () => {
      this.assertReady()
      this.shutdown.signal.throwIfAborted()
      return await operation()
    }).finally(() => {
      this.reviewControlTasks.delete(task)
    })
    this.reviewControlTasks.add(task)
    return task
  }

  private teardown(): Promise<void> {
    if (this.teardownTask !== undefined) return this.teardownTask
    this.teardownTask = this.performTeardown()
    return this.teardownTask
  }

  private async performTeardown(): Promise<void> {
    const errors: unknown[] = []
    const capture = async (operation: () => unknown | PromiseLike<unknown>): Promise<void> => {
      try {
        await operation()
      } catch (error) {
        errors.push(error)
      }
    }

    // Close every admission edge synchronously before the first await.
    this.accepting = false
    const attemptRuntime = this.attemptRuntime
    this.attemptRuntime = undefined
    attemptRuntime?.dispose()
    const attemptPoke = this.attemptPoke
    this.attemptPoke = undefined
    const attemptPokeClose = attemptPoke?.close()
    this.apiRecovery?.dispose()
    this.apiRecovery = undefined
    const removeSubmissionTools = this.removeSubmissionTools
    this.removeSubmissionTools = undefined
    if (removeSubmissionTools !== undefined) {
      try {
        removeSubmissionTools()
      } catch (error) {
        errors.push(error)
      }
    }
    for (const key of [
      'removeControllerGoalListener',
      'removeControllerDisposedListener',
      'removeControllerCreatedListener',
    ] as const) {
      const remove = this[key]
      this[key] = undefined
      if (remove === undefined) continue
      try {
        remove()
      } catch (error) {
        errors.push(error)
      }
    }
    const removeStatus = this.removeReviewStatusListener
    this.removeReviewStatusListener = undefined
    if (removeStatus !== undefined) {
      try {
        removeStatus()
      } catch (error) {
        errors.push(error)
      }
    }
    this.shutdown.abort(new AutoLabRuntimeError(
      'AutoLab Controller is shutting down',
      'SERVICE_CLOSED',
    ))

    // A messaging pump may already hold a removed registration. Join those
    // handlers before any Controller-owned state or Session resource closes.
    await Promise.allSettled([...this.reviewControlTasks])
    this.reviewControlTasks.clear()
    await Promise.allSettled([...this.reviewStatusTasks])
    this.reviewStatusTasks.clear()
    await Promise.allSettled([...this.reviewHoldTasks.values()])
    this.reviewHoldTasks.clear()
    await Promise.allSettled([...this.controllerTasks])
    this.controllerTasks.clear()
    await Promise.allSettled([...this.attemptTasks])
    this.attemptTasks.clear()
    if (attemptRuntime !== undefined) await capture(() => attemptRuntime.drain())
    if (attemptPokeClose !== undefined) await capture(() => attemptPokeClose)
    await Promise.allSettled([...this.operationTails.values()])
    this.operationTails.clear()
    await this.apiRecoveryStore?.drain()

    const holds = [...this.reviewHolds.values()]
    this.reviewHolds.clear()
    await Promise.allSettled(holds.map(hold => hold.release()))

    const handles = [...this.roleHandles.values()]
    const attached = new Map<string, Agent>()
    for (const handle of handles) attached.set(String(handle.sessionId), handle.agent)
    for (const agent of this.borrowedRoleAgents.values()) attached.set(String(agent.id), agent)
    await Promise.allSettled([...attached.keys()].map(sessionId => (
      pauseLocalGoalContinuation(this.ctx, sessionId)
    )))
    this.borrowedRoleAgents.clear()
    this.roleHandles.clear()
    await Promise.allSettled(handles.map(handle => handle.dispose()))

    const controllerSurfaces = [...this.controllerSurfaces.values()]
    this.controllerSurfaces.clear()
    for (const { agent } of controllerSurfaces) {
      if (this.ctx.agents.get(agent.id) === agent) this.ctx.goals.disarm(agent)
    }
    for (const { dispose } of controllerSurfaces.reverse()) {
      try {
        dispose()
      } catch (error) {
        errors.push(error)
      }
    }

    // Keep the registrations present while owned Sessions wind down, so any
    // pump which races teardown gets a retryable shutdown error. Unregistering
    // now leaves a retryable transport tombstone until the next owner registers.
    const removeHandlers = this.removeReviewControlHandlers
    this.removeReviewControlHandlers = undefined
    if (removeHandlers !== undefined) {
      try {
        removeHandlers()
      } catch (error) {
        errors.push(error)
      }
    }

    const domain = this.domain
    if (domain !== undefined) await capture(() => domain.close())
    if (this.domain === domain) this.domain = undefined
    this.table = undefined
    this.apiRecoveryStore = undefined
    this.view.clear()

    // The owner fence is deliberately the final release point.
    const owner = this.owner
    if (owner !== undefined) await capture(() => owner.release())
    if (this.owner === owner) this.owner = undefined

    if (errors.length > 0) {
      throw new AggregateError(errors, 'AutoLab Controller teardown failed')
    }
  }

  private enqueue<T>(labId: string, operation: () => Promise<T>): Promise<T> {
    this.assertReady()
    const previous = this.operationTails.get(labId) ?? Promise.resolve()
    const run = previous.then(operation)
    const tail = run.then(() => undefined, () => undefined)
    this.operationTails.set(labId, tail)
    void tail.finally(() => {
      if (this.operationTails.get(labId) === tail) this.operationTails.delete(labId)
    })
    return run
  }

  private requireState(labId: string): RuntimeState {
    const state = this.view.get(labId)
    if (state === undefined) {
      throw new AutoLabRuntimeError(`Lab ${labId} was not found`, 'LAB_NOT_FOUND')
    }
    return state
  }

  private assertControllerSession(caller: Agent, state: RuntimeState): void {
    if (String(caller.id) !== state.controllerSessionId) {
      throw new AutoLabRuntimeError(
        `Session ${String(caller.id)} is not the Controller of Lab ${state.labId}`,
        'CONTROLLER_MISMATCH',
      )
    }
  }

  private assertReady(): void {
    if (!this.accepting) {
      throw new AutoLabRuntimeError('AutoLab Controller is not accepting work', 'SERVICE_CLOSED')
    }
  }

  private requireAttemptRuntime(): AttemptRuntimeConsumer {
    if (this.attemptRuntime === undefined) {
      throw new AutoLabRuntimeError('Attempt Runtime is unavailable', 'SERVICE_CLOSED')
    }
    return this.attemptRuntime
  }

  private requireOwner(): RuntimeLock {
    if (this.owner === undefined) {
      throw new AutoLabRuntimeError('AutoLab Controller has no owner lock', 'SERVICE_CLOSED')
    }
    return this.owner
  }

  private requireTable(): KvTable<string, RuntimeState> {
    if (this.table === undefined) {
      throw new AutoLabRuntimeError('AutoLab Controller domain is closed', 'SERVICE_CLOSED')
    }
    return this.table
  }
}

export const name = 'autolab-runtime'
export const inject = AutoLabRuntime.inject
export const Config = AutoLabRuntime.Config

export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  const fiber = ctx.plugin(AutoLabRuntime, config)
  await fiber
  return fiber.dispose
}

export default AutoLabRuntime

function cloneState(state: RuntimeState): RuntimeState {
  return structuredClone(state)
}

function goalRef(goal: GoalView): { readonly id: GoalView['id']; readonly revision: number } {
  return { id: goal.id, revision: goal.revision }
}

function sameConfigRef(left: RuntimeState['config'], right: FrozenRevision['ref']): boolean {
  return left !== undefined
    && left.revision === right.revision
    && left.revisionPath === right.revisionPath
    && left.specHash === right.specHash
    && left.configHash === right.configHash
    && left.manifestHash === right.manifestHash
    && left.dialogueHeadHash === right.dialogueHeadHash
}

function renderError(value: unknown): string {
  if (value instanceof ArtifactError) return `${value.code}: ${value.message}`
  return value instanceof Error ? value.message : String(value)
}

function controlReceiptFailed(receipt: ControlReceipt): boolean {
  return receipt.status === 'failed'
    || receipt.status === 'expired'
    || receipt.outcome?.status === 'failed'
    || receipt.outcome?.status === 'rejected'
}

function controlReceiptFailure(receipt: ControlReceipt): string {
  return receipt.outcome?.status ?? receipt.status
}

function rethrowCoderBoundary(
  error: unknown,
  stage: 'capture' | 'reconcile',
): never {
  if (error instanceof AutoLabRuntimeError || isAbortError(error)) throw error

  let code: AutoLabRuntimeError['code'] = stage === 'capture'
    ? 'OPERATION_FAILED'
    : 'CONFIG_DRIFT'
  if (error instanceof CandidateSnapshotError) {
    code = error.code === 'GIT_FAILED' || error.code === 'IO_FAILED'
        ? 'OPERATION_FAILED'
        : 'CONFIG_DRIFT'
  } else if (error instanceof CoderReceiptError) {
    code = error.code === 'IO_FAILED'
      ? 'OPERATION_FAILED'
      : stage === 'capture'
      && (error.code === 'RECEIPT_READ_FAILED'
        || error.code === 'INVALID_RECEIPT'
        || error.code === 'ANCHOR_MISMATCH'
        || error.code === 'HASH_MISMATCH')
      ? 'IMPLEMENTATION_NOT_READY'
      : error.code === 'ARTIFACT_WRITE_FAILED'
        ? 'OPERATION_FAILED'
        : 'CONFIG_DRIFT'
  } else if (error instanceof CoderSubmissionError
    || error instanceof ActivationArtifactError) {
    code = 'CONFIG_DRIFT'
  } else if (error instanceof WorktreeError) {
    code = error.code === 'GIT_FAILED' ? 'OPERATION_FAILED' : 'CONFIG_DRIFT'
  } else if (error instanceof LocalGoalError) {
    code = error.code === 'INVALID_INTENT' || error.code === 'STALE_GOAL'
      ? 'CONFIG_DRIFT'
      : 'OPERATION_FAILED'
  }
  throw new AutoLabRuntimeError(
    `Coder submission ${stage} failed: ${renderError(error)}`,
    code,
  )
}

function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === 'AbortError'
}

function findCreateBoundary(events: readonly { readonly seq: number; readonly type: string; readonly data: unknown }[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'command/run'
      || typeof event.data !== 'object'
      || event.data === null
      || !('name' in event.data)
      || event.data.name !== 'autolab') continue
    return event.seq
  }
  return events.at(-1)?.seq ?? 0
}

function startingRoleProjection(
  state: RuntimeState,
  manifest: ResolvedManifest,
  workers: readonly RootRoleBinding[],
): RuntimeState['roles'] {
  const expected = new Set(workers.map(role => role.role_id))
  for (const roleId of Object.keys(state.roles)) {
    if (!expected.has(roleId)) {
      throw new AutoLabRuntimeError(
        `RuntimeState contains role ${JSON.stringify(roleId)} outside CURRENT`,
        'CONFIG_DRIFT',
      )
    }
  }
  return Object.fromEntries(workers.map(role => {
    const sessionId = role.prebound_session_id
      ?? `autolab:${manifest.lab_id}:${sha256(role.role_id).slice(0, 24)}`
    const previous = state.roles[role.role_id]
    if (previous !== undefined && previous.sessionId !== sessionId) {
      throw new AutoLabRuntimeError(
        `Role ${role.role_id} SessionId does not match CURRENT`,
        'CONFIG_DRIFT',
      )
    }
    return [role.role_id, {
      ...(previous ?? { sessionId, phase: 'starting' as const }),
    }]
  }))
}

function assertStartingRoleProjection(
  state: RuntimeState,
  workers: readonly RootRoleBinding[],
): void {
  const expected = new Set(workers.map(role => role.role_id))
  if (Object.keys(state.roles).length !== expected.size) {
    throw new AutoLabRuntimeError('Starting role projection is incomplete', 'CONFIG_DRIFT')
  }
  for (const role of workers) {
    const projected = state.roles[role.role_id]
    if (projected === undefined
      || (role.prebound_session_id !== undefined
        && projected.sessionId !== role.prebound_session_id)) {
      throw new AutoLabRuntimeError(
        `Starting role ${role.role_id} does not match CURRENT`,
        'CONFIG_DRIFT',
      )
    }
  }
}

function roleHandleKey(labId: string, roleId: string): string {
  return `${labId}\0${roleId}`
}

function reviewHoldKey(labId: string, reviewId: string): string {
  return `${labId}\0${reviewId}`
}

function roleGoalRoundLimit(role: RootRoleBinding): number {
  if ('max_goal_rounds' in role) return role.max_goal_rounds
  throw new AutoLabRuntimeError(
    `Reactive role ${role.role_id} cannot receive a Goal install`,
    'CONFIG_DRIFT',
  )
}

function deterministicReviewId(parts: readonly string[]): string {
  const digits = sha256(`autolab-review-id-v1\0${parts.join('\0')}`)
    .slice(0, 32)
    .split('')
  digits[12] = '5'
  digits[16] = ((Number.parseInt(digits[16]!, 16) & 0x3) | 0x8).toString(16)
  const value = digits.join('')
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20),
  ].join('-')
}

function roleSubmissionResult(
  labId: string,
  capability: ReviewControlCapability,
  phase: 'reviewing',
): RoleSubmissionResult {
  return {
    labId,
    roleId: capability.workerRoleId,
    assignmentId: capability.assignmentId,
    reviewId: capability.reviewId,
    phase,
  }
}

function preflightVerdictResult(
  labId: string,
  roleId: string,
  reviewId: string,
  assignmentId: string,
  phase: 'verdict_recorded' | 'error',
  verdict: PreflightTopLevelVerdict,
): PreflightVerdictResult {
  return { labId, roleId, assignmentId, reviewId, phase, verdict }
}

function coderImplementationResult(
  labId: string,
  candidate: RuntimeState['candidates'][string],
): CoderImplementationResult {
  return {
    labId,
    roleId: candidate.coderRoleId,
    assignmentId: candidate.assignmentId,
    candidateId: candidate.candidateId,
    candidateSha: candidate.candidateSha,
    phase: 'candidate_frozen',
  }
}

function controllerApplyPreflightResult(
  labId: string,
  reviewId: string,
  coderRoleId: string,
): ControllerApplyPreflightResult {
  return {
    labId,
    reviewId,
    coderRoleId,
    assignmentId: `coder:${reviewId}`,
    phase: 'coder_working',
  }
}

function controllerAssignRoleResult(
  labId: string,
  roleId: string,
  assignmentId: string,
  phase: ControllerAssignRoleResult['phase'],
): ControllerAssignRoleResult {
  return { labId, roleId, assignmentId, phase }
}

function controllerAssignMethodResult(
  labId: string,
  methodRoleId: string,
  assignmentId: string,
  sourceReviewId?: string,
): ControllerAssignMethodResult {
  return {
    labId,
    methodRoleId,
    assignmentId,
    ...(sourceReviewId === undefined ? {} : { sourceReviewId }),
    phase: 'working',
  }
}

function controllerRequestPostflightResult(
  labId: string,
  review: RuntimeState['reviews'][string],
  phase: ControllerRequestPostflightResult['phase'],
): ControllerRequestPostflightResult {
  return {
    labId,
    reviewId: review.capability.reviewId,
    assignmentId: review.capability.assignmentId,
    coderRoleId: review.capability.workerRoleId,
    judgeRoleId: review.capability.judgeRoleId,
    phase,
  }
}

function postflightResultSubmission(
  labId: string,
  roleId: string,
  reviewId: string,
  assignmentId: string,
): PostflightResultSubmission {
  return { labId, roleId, assignmentId, reviewId, phase: 'result_recorded' }
}

function autoLabRoleResultSubmission(
  labId: string,
  roleId: string,
  assignmentId: string,
): AutoLabRoleResultSubmission {
  return { labId, roleId, assignmentId, phase: 'receipt_recorded' }
}

function postflightControllerEventText(
  labId: string,
  reviewId: string,
  artifactPath: string,
  artifactHash: string,
): string {
  return [
    `AutoLab ${labId} Postflight review ${reviewId} recorded its Lab-native result.`,
    `Read the complete original result at ${artifactPath} (sha256 ${artifactHash}) and decide the next responsibility from CURRENT.`,
  ].join('\n')
}

function roleResultControllerEventText(
  labId: string,
  roleId: string,
  assignmentId: string,
  artifactPath: string,
  artifactHash: string,
): string {
  return [
    `AutoLab ${labId} role ${roleId} recorded Assignment ${assignmentId}.`,
    `Read the complete original receipt at ${artifactPath} (sha256 ${artifactHash}) and decide the next responsibility from CURRENT.`,
  ].join('\n')
}

function parseControllerAttemptInput(input: ControllerLaunchAttemptInput): {
  readonly trialContract: unknown
  readonly runSlots: readonly {
    readonly runSlotId: string
    readonly contract?: unknown
  }[]
  readonly command: readonly string[]
  readonly env: Readonly<Record<string, string>>
} {
  const trialContract = parseJsonArgument(input.trialContractJson, 'trialContractJson')
  const runSlotsValue = parseJsonArgument(input.runSlotsJson, 'runSlotsJson')
  const commandValue = parseJsonArgument(input.commandJson, 'commandJson')
  const envValue = parseJsonArgument(input.envJson, 'envJson')
  if (!Array.isArray(runSlotsValue) || runSlotsValue.length === 0) {
    throw new AutoLabRuntimeError('runSlotsJson must be a non-empty JSON array', 'NOT_READY')
  }
  const runSlots = runSlotsValue.map((value, index) => {
    if (!isRecord(value)
      || typeof value.runSlotId !== 'string'
      || value.runSlotId.length === 0) {
      throw new AutoLabRuntimeError(
        `runSlotsJson[${index}] requires a non-empty runSlotId`,
        'NOT_READY',
      )
    }
    return {
      runSlotId: value.runSlotId,
      ...(!Object.hasOwn(value, 'contract') ? {} : { contract: value.contract }),
    }
  })
  if (!Array.isArray(commandValue)
    || commandValue.length === 0
    || commandValue.some(value => typeof value !== 'string' || value.length === 0)) {
    throw new AutoLabRuntimeError('commandJson must be a non-empty JSON argv array', 'NOT_READY')
  }
  if (!isRecord(envValue)
    || Object.values(envValue).some(value => typeof value !== 'string')) {
    throw new AutoLabRuntimeError('envJson must be a JSON object of string values', 'NOT_READY')
  }
  return {
    trialContract,
    runSlots,
    command: commandValue as string[],
    env: envValue as Record<string, string>,
  }
}

function parseRetryAttemptInput(input: ControllerRetryAttemptInput): {
  readonly command: readonly string[]
  readonly env: Readonly<Record<string, string>>
} {
  const command = parseJsonArgument(input.commandJson, 'commandJson')
  const env = parseJsonArgument(input.envJson, 'envJson')
  if (!Array.isArray(command)
    || command.length === 0
    || command.some(value => typeof value !== 'string' || value.length === 0)) {
    throw new AutoLabRuntimeError('commandJson must be a non-empty JSON argv array', 'NOT_READY')
  }
  if (!isRecord(env) || Object.values(env).some(value => typeof value !== 'string')) {
    throw new AutoLabRuntimeError('envJson must be a JSON object of string values', 'NOT_READY')
  }
  return {
    command: command as string[],
    env: env as Record<string, string>,
  }
}

function parseRoleAssignmentReferences(value: string): readonly RoleAssignmentArtifactReference[] {
  const parsed = parseJsonArgument(value, 'inputArtifactRefsJson')
  if (!Array.isArray(parsed)) {
    throw new AutoLabRuntimeError('inputArtifactRefsJson must be a JSON array', 'NOT_READY')
  }
  return parsed.map((reference, index) => {
    if (!isRecord(reference)
      || typeof reference.artifact_id !== 'string'
      || typeof reference.path !== 'string'
      || typeof reference.sha256 !== 'string') {
      throw new AutoLabRuntimeError(
        `inputArtifactRefsJson[${index}] requires artifact_id, path, and sha256 strings`,
        'NOT_READY',
      )
    }
    return {
      artifact_id: reference.artifact_id,
      path: reference.path,
      sha256: reference.sha256,
    }
  })
}

/**
 * Parse the `coder:<reviewId>:fix:<slug>` identity of a Coder fix Assignment.
 * The embedded review id is the lineage: the APPROVED, resolved Preflight
 * review whose candidate is being corrected. This keeps the fix's provenance
 * deterministic without any new durable state field.
 */
function parseCoderFixAssignmentId(assignmentId: string): {
  readonly reviewId: string
  readonly slug: string
} {
  const marker = ':fix:'
  const reviewStart = 'coder:'.length
  const markerIndex = assignmentId.startsWith('coder:')
    ? assignmentId.indexOf(marker, reviewStart)
    : -1
  if (markerIndex < 0) {
    throw new AutoLabRuntimeError(
      `Coder fix Assignment ${JSON.stringify(assignmentId)} must be coder:<reviewId>:fix:<slug>`,
      'NOT_READY',
    )
  }
  const reviewId = assignmentId.slice(reviewStart, markerIndex)
  const slug = assignmentId.slice(markerIndex + marker.length)
  if (reviewId.trim().length === 0 || slug.trim().length === 0) {
    throw new AutoLabRuntimeError(
      `Coder fix Assignment ${JSON.stringify(assignmentId)} requires a non-empty lineage review and slug`,
      'NOT_READY',
    )
  }
  return { reviewId, slug }
}

/** The fix mandate must carry the corrected candidate's identity. */
function extractFixCandidateId(content: RoleAssignmentJson, assignmentId: string): string {
  if (content === null || typeof content !== 'object' || Array.isArray(content)) {
    throw new AutoLabRuntimeError(
      `Coder fix Assignment ${JSON.stringify(assignmentId)} content must be a JSON object carrying candidate_id`,
      'NOT_READY',
    )
  }
  const candidateId = (content as { candidate_id?: unknown }).candidate_id
  if (typeof candidateId !== 'string' || candidateId.trim().length === 0) {
    throw new AutoLabRuntimeError(
      `Coder fix Assignment ${JSON.stringify(assignmentId)} content must carry a non-empty candidate_id string`,
      'NOT_READY',
    )
  }
  return candidateId
}

function controllerAssignCoderFixResult(
  labId: string,
  coderRoleId: string,
  assignmentId: string,
  reviewId: string,
): ControllerAssignCoderFixResult {
  return {
    labId,
    coderRoleId,
    assignmentId,
    reviewId,
    phase: 'working',
  }
}

/**
 * The live Goal currently installed on a role Session, or null. Used as the
 * expectedGoalRef fallback when a projected goalInstall lost its goalId
 * because its previous install attempt failed mid-flight: replacing the
 * Session's current Goal is then exactly the intent of the retry.
 */
function assertRevisionTopologyUnchanged(
  current: ResolvedManifest,
  next: ResolvedManifest,
): void {
  if (canonicalJson(current.roles) !== canonicalJson(next.roles)
    || canonicalJson(current.lanes) !== canonicalJson(next.lanes)
    || canonicalJson(current.repository) !== canonicalJson(next.repository)
    || canonicalJson(current.execution) !== canonicalJson(next.execution)
    || canonicalJson(current.communication) !== canonicalJson(next.communication)) {
    throw new AutoLabRuntimeError(
      'Configuration revision changes the frozen Lab topology (roles, lanes, worktrees, repository, execution, hosts, GPU pool, communication); topology is immutable in a revision',
      'CONFIG_DRIFT',
    )
  }
}

function controllerCommitConfigRevisionResult(
  labId: string,
  revision: number,
  specHash: string,
  configHash: string,
  manifestHash: string,
): ControllerCommitConfigRevisionResult {
  return { labId, revision, specHash, configHash, manifestHash }
}

function currentLiveGoalRef(
  ctx: Context,
  sessionId: string,
): GoalRef | null {
  const agent = ctx.agents.get(SessionId(sessionId))
  if (agent === undefined) return null
  const goal = ctx.goals.get(agent)
  if (goal === undefined) return null
  return { id: GoalId(String(goal.id)), revision: goal.revision }
}

function parseJsonArgument(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new AutoLabRuntimeError(
      `${label} is not valid JSON: ${renderError(error)}`,
      'NOT_READY',
    )
  }
}

function attemptLaunchResult(
  state: RuntimeState,
  target: AttemptRuntimeTarget,
): ControllerLaunchAttemptResult {
  const active = state.trials[target.trialId]?.runSlots[target.runSlotId]?.activeAttempt
  if (active === undefined) {
    throw new AutoLabRuntimeError(
      `Trial ${target.trialId} RunSlot ${target.runSlotId} lost its active Attempt`,
      'CONFIG_DRIFT',
    )
  }
  return {
    labId: state.labId,
    trialId: target.trialId,
    runSlotId: target.runSlotId,
    attemptId: active.attemptId,
    phase: active.phase,
  }
}

function attemptEscalation(result: Extract<AttemptRuntimeResult, { outcome: 'handled' }> ):
  { readonly code: string; readonly message: string } | undefined {
  if (result.reconcile.action === 'blocked') {
    return result.reconcile.blocker
  }
  if (result.reconcile.action === 'pending' && result.edge === 'pending-retry') {
    return result.reconcile.pending
  }
  if (result.reconcile.action === 'await_started_receipt'
    && result.edge === 'launch-safety') {
    return {
      code: 'ATTEMPT_START_RECEIPT_PENDING',
      message: 'the one launch-safety edge still found no durable started receipt',
    }
  }
  if (result.reconcile.action === 'launch_required' && result.launched) {
    return {
      code: 'ATTEMPT_LAUNCH_NOT_OBSERVED',
      message: 'the launch action returned without a matching process or durable receipt',
    }
  }
  return undefined
}

function assertLiveAssignmentGoal(
  ctx: Context,
  caller: Agent,
  role: RoleState,
  roleId: string,
  label: string,
): void {
  const live = ctx.goals.get(caller)
  if (!roleOwnsExactAssignmentGoal(role, live)) {
    throw new AutoLabRuntimeError(
      `${label} role ${roleId} no longer owns its exact persisted Assignment Goal`,
      'IMPLEMENTATION_NOT_READY',
    )
  }
}

function selectApprovedCoderReview(
  state: RuntimeState,
  coderRoleId: string,
  coder: RoleState,
): {
  readonly reviewId: string
  readonly review: RuntimeState['reviews'][string]
} | undefined {
  const install = coder.goalInstall
  if (install === undefined) return undefined
  const matches = Object.entries(state.reviews).filter(([reviewId, review]) => {
    if (review.stage !== 'preflight'
      || review.verdict?.topLevelVerdict !== 'APPROVED'
      || review.resolution?.targetRoleId !== coderRoleId
      || review.resolution.targetSessionId !== coder.sessionId
      || review.resolution.effect.kind !== 'goal_install') return false
    if (install.assignmentId === `coder:${reviewId}`) {
      // The review's own resolution installed this Assignment.
      return review.resolution.effect.id === install.installId
        && review.resolution.effect.hash === install.objectiveHash
    }
    // Controller-authored implementation-fix Assignments embed their lineage
    // review in the assignment identity (`coder:<reviewId>:fix:<slug>`); the
    // review's resolution recorded the superseded cycle, not the fix install.
    return install.assignmentId.startsWith(`coder:${reviewId}:fix:`)
  })
  return matches.length === 1
    ? { reviewId: matches[0]![0], review: matches[0]![1] }
    : undefined
}

function requireMethodRevisionReview(
  state: RuntimeState,
  reviewId: string,
  methodRoleId: string,
  methodSessionId: string,
): RuntimeState['reviews'][string] {
  const review = state.reviews[reviewId]
  const verdict = review?.verdict
  if (review?.stage !== 'preflight'
    || review.phase !== 'verdict_recorded'
    || review.capability.reviewId !== reviewId
    || review.capability.workerRoleId !== methodRoleId
    || review.capability.workerSessionId !== methodSessionId
    || verdict === undefined
    || (verdict.topLevelVerdict !== 'REVISION_REQUIRED'
      && verdict.topLevelVerdict !== 'REJECTED')
    || !reviewFreezeComplete(review, state.ownerEpoch)) {
    throw new AutoLabRuntimeError(
      `Review ${reviewId} is not an exact frozen REVISION_REQUIRED or REJECTED Preflight review for Method ${methodRoleId}`,
      'REVIEW_NOT_READY',
    )
  }
  return review
}

function selectJudgeReview(
  state: RuntimeState,
  judgeRoleId: string,
): {
  readonly reviewId: string
  readonly review: RuntimeState['reviews'][string]
} | undefined {
  const candidates = Object.entries(state.reviews)
    .filter(([, review]) => review.capability.judgeRoleId === judgeRoleId)
  const pending = candidates.filter(([, review]) => !reviewHasOutput(review))
  if (pending.length > 1) return undefined
  const selected = pending[0] ?? candidates.sort((left, right) => (
    right[1].updatedAt - left[1].updatedAt || right[0].localeCompare(left[0])
  ))[0]
  return selected === undefined
    ? undefined
    : { reviewId: selected[0], review: selected[1] }
}

function reviewHasOutput(review: RuntimeState['reviews'][string]): boolean {
  return review.verdict !== undefined || review.result !== undefined
}

/** Do not bind a Controller-initiated review across a newer open Coder turn. */
function lastCompletedAgentTurn(agent: Agent): number | undefined {
  const boundary = agent.session.events.findLast(event => (
    event.type === 'turn/start' || event.type === 'turn/end'
  ))
  if (boundary?.type !== 'turn/end'
    || !Number.isSafeInteger(boundary.data.turn)
    || boundary.data.turn <= 0) return undefined
  return boundary.data.turn
}

function sameReviewPauseReceipt(
  left: RuntimeState['reviews'][string]['pause'],
  right: RuntimeState['reviews'][string]['pause'],
): boolean {
  return left.controlId === right.controlId
    && left.payloadHash === right.payloadHash
    && left.completedAt === right.completedAt
    && left.goalOutcome === right.goalOutcome
    && left.activeTurn === right.activeTurn
    && left.observedTurn === right.observedTurn
    && left.goalRef?.id === right.goalRef?.id
    && left.goalRef?.revision === right.goalRef?.revision
}

function isReviewGoalRef(value: unknown): value is { id: string; revision: number } {
  return isRecord(value)
    && typeof value.id === 'string'
    && value.id.length > 0
    && Number.isSafeInteger(value.revision)
    && (value.revision as number) > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function recoverReviewFreezeProjection(
  state: RuntimeState,
  ownerEpoch: string,
): RuntimeState {
  const now = Date.now()
  let changed = false
  const reviews = Object.fromEntries(Object.entries(state.reviews).map(([reviewId, review]) => {
    // After a Controller restart every in-process review hold and the held
    // worker turn are gone. A `held` review under a foreign owner epoch and a
    // `hold-pending` review (whose acquisition task died with the previous
    // process) therefore have no live freeze to preserve: project them to
    // `stopped` so a recorded verdict/result can advance and a review without
    // output re-wakes its Judge through the ordinary replay once the worker
    // Session is live again. `user-override` freezes carry their own detail
    // and are never rewritten here.
    const wedgedHeld = review.pause.freeze === 'held'
      && review.pause.holdOwnerEpoch !== ownerEpoch
    const wedgedPending = review.pause.freeze === 'hold-pending'
    if (!wedgedHeld && !wedgedPending) return [reviewId, review]
    changed = true
    const { holdOwnerEpoch: _oldOwner, ...pause } = review.pause
    return [reviewId, {
      ...review,
      pause: { ...pause, freeze: 'stopped' as const },
      updatedAt: now,
    }]
  }))
  if (!changed) return state
  return transitionRuntimeState(state, {
    expectedRevision: state.runtimeRevision,
    ownerEpoch,
    lifecycle: state.lifecycle,
    reviews,
    now,
  })
}
