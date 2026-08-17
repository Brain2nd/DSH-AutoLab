import { C as DraftSnapshot, Y as LabLifecycle, et as RuntimeState, i as PreflightTopLevelVerdict, w as FrozenRevision } from "./preflight-verdict-CXTEcGGj.js";
import "./tool-D47q6k_B.js";
import { Agent } from "@deepseek-ai/dsh-agent";
import { HarnessError } from "@deepseek-ai/dsh-llm";
import { Context, Service } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";

//#region src/controller-surface.d.ts
interface ControllerReadResult {
  readonly labId: string;
  readonly lifecycle: LabLifecycle;
  readonly directory: string;
  /** Decimal committed revision, or `draft` before the first commit. */
  readonly revision: string;
  readonly labSpec: string;
  readonly labYaml: string;
}
interface ControllerWaitResult {
  readonly labId: string;
  readonly outcome: 'paused' | 'already-paused' | 'no-goal';
}
interface ControllerLaunchAttemptInput {
  readonly labId: string;
  readonly laneId: string;
  readonly trialId: string;
  readonly trialContractJson: string;
  readonly runSlotsJson: string;
  readonly selectedRunSlotId: string;
  readonly hostId: string;
  readonly commandJson: string;
  readonly envJson: string;
}
interface ControllerLaunchAttemptResult {
  readonly labId: string;
  readonly trialId: string;
  readonly runSlotId: string;
  readonly attemptId: string;
  readonly phase: 'launching' | 'running' | 'outcome_unknown' | 'terminal';
}
interface ControllerRetryAttemptInput {
  readonly labId: string;
  readonly trialId: string;
  readonly runSlotId: string;
  readonly hostId: string;
  readonly commandJson: string;
  readonly envJson: string;
}
interface ControllerApplyPreflightInput {
  readonly labId: string;
  readonly reviewId: string;
}
interface ControllerApplyPreflightResult {
  readonly labId: string;
  readonly reviewId: string;
  readonly coderRoleId: string;
  readonly assignmentId: string;
  readonly phase: 'coder_working';
}
interface ControllerRequestPostflightInput {
  readonly labId: string;
  readonly trialId: string;
  readonly runSlotId: string;
}
interface ControllerRequestPostflightResult {
  readonly labId: string;
  readonly reviewId: string;
  readonly assignmentId: string;
  readonly coderRoleId: string;
  readonly judgeRoleId: string;
  readonly phase: 'reviewing' | 'result_recorded';
}
interface ControllerAssignRoleInput {
  readonly labId: string;
  readonly roleId: string;
  readonly assignmentId: string;
  readonly objective: string;
  readonly contentJson: string;
  readonly outputSchemaJson: string;
  readonly inputArtifactRefsJson: string;
}
interface ControllerAssignRoleResult {
  readonly labId: string;
  readonly roleId: string;
  readonly assignmentId: string;
  readonly phase: 'working' | 'receipt_recorded';
}
interface ControllerAssignMethodInput {
  readonly labId: string;
  readonly methodRoleId: string;
  readonly assignmentId: string;
  readonly objective: string;
  readonly contentJson: string;
  readonly inputArtifactRefsJson: string;
  /** Selects the exact REVISION_REQUIRED or REJECTED Preflight review resolved here. */
  readonly sourceReviewId?: string;
}
interface ControllerAssignMethodResult {
  readonly labId: string;
  readonly methodRoleId: string;
  readonly assignmentId: string;
  readonly sourceReviewId?: string;
  readonly phase: 'working';
}
interface ControllerAssignCoderFixInput {
  readonly labId: string;
  readonly coderRoleId: string;
  /** Must be `coder:<reviewId>:fix:<slug>`: the lineage APPROVED review of the candidate being fixed. */
  readonly assignmentId: string;
  readonly objective: string;
  /** Opaque fix mandate; must carry a non-empty `candidate_id` for the corrected candidate. */
  readonly contentJson: string;
  readonly inputArtifactRefsJson: string;
}
interface ControllerAssignCoderFixResult {
  readonly labId: string;
  readonly coderRoleId: string;
  readonly assignmentId: string;
  readonly reviewId: string;
  readonly phase: 'working';
}
interface ControllerRegisterUserDirectiveInput {
  readonly labId: string;
  /** Unique immutable fact id, e.g. `user-directive-20260816-recipe-23`. */
  readonly factId: string;
  /** Fact kind; Controller-authored, e.g. `user_directive`. */
  readonly kind: string;
  /** The directive text being registered; keep the user's wording verbatim. */
  readonly statement: string;
  /** Provenance: where and when the user decision was made. */
  readonly source: string;
  /** Evidence status of this fact, e.g. `user-authorized`. */
  readonly evidenceStatus: string;
}
interface ControllerRegisterUserDirectiveResult {
  readonly labId: string;
  readonly factPath: string;
  readonly factSetSha256: string;
  readonly factIndex: number;
  readonly runtimeRevision: number;
}
interface ControllerCommitConfigRevisionInput {
  readonly labId: string;
  /** Complete replacement LAB_SPEC.md text for the new revision. */
  readonly specText: string;
  /** Complete replacement lab.yaml text for the new revision. */
  readonly configText: string;
}
interface ControllerCommitConfigRevisionResult {
  readonly labId: string;
  readonly revision: number;
  readonly specHash: string;
  readonly configHash: string;
  readonly manifestHash: string;
}
interface ControllerRevealResult {
  readonly labId: string;
  readonly revealState: 'revealed';
  readonly runtimeRevision: number;
}
//#endregion
//#region src/index.d.ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    autolab: AutoLabRuntime;
  }
}
interface Config {
  /** Durable Lab artifacts and the process-owner lock. */
  root?: string;
}
interface CreateLabResult {
  readonly state: RuntimeState;
  readonly directory: string;
  readonly draft: DraftSnapshot;
}
interface ShowLabResult {
  readonly state: RuntimeState;
  readonly directory: string;
  readonly draft?: DraftSnapshot;
  readonly frozen?: FrozenRevision;
}
interface RoleSubmissionResult {
  readonly labId: string;
  readonly roleId: string;
  readonly assignmentId: string;
  readonly reviewId: string;
  readonly phase: 'reviewing';
}
interface PreflightVerdictResult {
  readonly labId: string;
  readonly roleId: string;
  readonly assignmentId: string;
  readonly reviewId: string;
  readonly phase: 'verdict_recorded' | 'error';
  readonly verdict: PreflightTopLevelVerdict;
}
interface CoderImplementationResult {
  readonly labId: string;
  readonly roleId: string;
  readonly assignmentId: string;
  readonly candidateId: string;
  readonly candidateSha: string;
  readonly phase: 'candidate_frozen';
}
interface PostflightResultSubmission {
  readonly labId: string;
  readonly roleId: string;
  readonly assignmentId: string;
  readonly reviewId: string;
  readonly phase: 'result_recorded';
}
interface AutoLabRoleResultSubmission {
  readonly labId: string;
  readonly roleId: string;
  readonly assignmentId: string;
  readonly phase: 'receipt_recorded';
}
declare class AutoLabRuntimeError extends HarnessError {
  readonly code: 'NOT_READY' | 'LAB_NOT_FOUND' | 'CONTROLLER_MISMATCH' | 'CONFIG_DRIFT' | 'NO_ROLES_DECLARED' | 'ROLE_ACTIVATION_UNAVAILABLE' | 'ROLE_MISMATCH' | 'REVIEW_NOT_READY' | 'IMPLEMENTATION_NOT_READY' | 'OPERATION_FAILED' | 'REVIEW_TRANSPORT_FAILED' | 'SERVICE_CLOSED';
  readonly name = "AutoLabRuntimeError";
  constructor(message: string, code: 'NOT_READY' | 'LAB_NOT_FOUND' | 'CONTROLLER_MISMATCH' | 'CONFIG_DRIFT' | 'NO_ROLES_DECLARED' | 'ROLE_ACTIVATION_UNAVAILABLE' | 'ROLE_MISMATCH' | 'REVIEW_NOT_READY' | 'IMPLEMENTATION_NOT_READY' | 'OPERATION_FAILED' | 'REVIEW_TRANSPORT_FAILED' | 'SERVICE_CLOSED');
}
declare class AutoLabRuntime extends Service {
  static inject: string[];
  static Config: s<Config>;
  private readonly root;
  private readonly artifacts;
  private readonly dialogue;
  private readonly view;
  private readonly roleHandles;
  private readonly borrowedRoleAgents;
  private readonly controllerSurfaces;
  private readonly controllerTasks;
  private readonly attemptTasks;
  private readonly reviewHolds;
  private readonly reviewHoldTasks;
  private readonly reviewStatusTasks;
  private readonly reviewControlTasks;
  private readonly shutdown;
  private domain;
  private table;
  private apiRecoveryStore;
  private apiRecovery;
  private attemptPoke;
  private attemptRuntime;
  private owner;
  private removeReviewControlHandlers;
  private removeReviewStatusListener;
  private removeControllerCreatedListener;
  private removeControllerDisposedListener;
  private removeControllerGoalListener;
  private removeSubmissionTools;
  private teardownTask;
  /** Serialize only mutations of the same Lab; independent Labs never block each other. */
  private readonly operationTails;
  private accepting;
  constructor(ctx: Context, config?: Config);
  [Service.init](): Promise<void>;
  create(controller: Agent, sourceDirectory?: string, signal?: AbortSignal): Promise<CreateLabResult>;
  show(caller: Agent, labId: string, signal?: AbortSignal): Promise<ShowLabResult>;
  readForController(caller: Agent, labId: string, signal?: AbortSignal): Promise<ControllerReadResult>;
  commit(caller: Agent, labId: string, signal?: AbortSignal): Promise<ShowLabResult>;
  /**
   * Commit one Controller-authored configuration revision (revision N+1) on a
   * running/paused Lab. The revision may change research content (objective,
   * families, scientific rules, contract, lane charters, evidence contract)
   * but NOT the Lab topology (roles, lanes, worktrees, repository, execution,
   * hosts, GPU pool, communication ACL, runner adapter): those must remain
   * byte-identical so every existing role, packet, and Attempt stays valid.
   */
  commitConfigRevision(caller: Agent, input: ControllerCommitConfigRevisionInput, signal?: AbortSignal): Promise<ControllerCommitConfigRevisionResult>;
  status(caller: Agent, labId: string): RuntimeState;
  reveal(caller: Agent, labId: string, signal?: AbortSignal): Promise<ControllerRevealResult>;
  /**
   * Apply only the APPROVED Preflight route explicitly selected by Controller.
   * Runtime compiles and installs identities; it never compares methods or
   * chooses which verdict should advance.
   */
  applyPreflight(caller: Agent, input: ControllerApplyPreflightInput, signal?: AbortSignal): Promise<ControllerApplyPreflightResult>;
  /** Install one explicit Method Assignment, optionally resolving one rejected Preflight review. */
  assignMethod(caller: Agent, input: ControllerAssignMethodInput, signal?: AbortSignal): Promise<ControllerAssignMethodResult>;
  /**
   * Install one Controller-authored Coder implementation-fix Assignment on a
   * paused Coder that owns the Lane's active candidate. The fix inherits the
   * candidate's lineage Preflight review (design ticket + verdict) as its
   * provenance, supersedes the active candidate, and lets the Coder freeze a
   * corrected candidate through the ordinary SubmitCoderImplementation path.
   * No Preflight review is fabricated and no scientific routing happens here:
   * the fix is an implementation continuation of the already-APPROVED design.
   */
  assignCoderFix(caller: Agent, input: ControllerAssignCoderFixInput, signal?: AbortSignal): Promise<ControllerAssignCoderFixResult>;
  /** Register one user decision as an immutable fact in the Lab fact set. */
  registerUserDirective(caller: Agent, input: ControllerRegisterUserDirectiveInput, signal?: AbortSignal): Promise<ControllerRegisterUserDirectiveResult>;
  /** Install exactly one Controller-authored Ops/Coordinator Assignment. */
  assignRole(caller: Agent, input: ControllerAssignRoleInput, signal?: AbortSignal): Promise<ControllerAssignRoleResult>;
  /**
   * Materialize one Controller-selected Trial/RunSlot and publish its first
   * active Attempt. All scientific JSON stays opaque; Candidate and CURRENT
   * identities are derived from the exact durable Lab projection.
   */
  launchAttempt(caller: Agent, input: ControllerLaunchAttemptInput, signal?: AbortSignal): Promise<ControllerLaunchAttemptResult>;
  /** Create one explicit technical retry without changing Trial/RunSlot lineage. */
  retryAttempt(caller: Agent, input: ControllerRetryAttemptInput, signal?: AbortSignal): Promise<ControllerLaunchAttemptResult>;
  /**
   * Bind one Controller-selected Attempt to its Lane Coder and Postflight
   * Judge. Runtime freezes only small immutable references and the review
   * handshake; the Judge owns every scientific read and decision.
   */
  requestPostflight(caller: Agent, input: ControllerRequestPostflightInput, signal?: AbortSignal): Promise<ControllerRequestPostflightResult>;
  private prepareCoderSubmission;
  private commitCoderSubmission;
  start(caller: Agent, labId: string, signal?: AbortSignal): Promise<RuntimeState>;
  pause(caller: Agent, labId: string, signal?: AbortSignal): Promise<RuntimeState>;
  resume(caller: Agent, labId: string, signal?: AbortSignal): Promise<RuntimeState>;
  stop(caller: Agent, labId: string, signal?: AbortSignal): Promise<RuntimeState>;
  waitController(caller: Agent, labId: string, signal?: AbortSignal): Promise<ControllerWaitResult>;
  private armControllerGoal;
  /** One exact active recovery owns Controller Goal continuation until it settles. */
  private controllerApiRecoveryOwnsGoal;
  private applyControllerGoal;
  private pauseControllerNativeGoal;
  private transition;
  private provisionWorktrees;
  private activateRolesForControl;
  private activateRole;
  private pauseRoleGoals;
  /** Reconcile only roles already projected paused; this is a startup edge, not polling. */
  private reconcileProjectedPausedRoleGoals;
  private readAttachedRoles;
  private reconcileCommunicationAcl;
  private hasAttachedRoleSet;
  private requireAgentPresets;
  private requireSessionPersistence;
  private requireSessionMessaging;
  private resolveReviewCapability;
  private replayActiveReviewRequests;
  private trackReviewControlStatus;
  private handleReviewControlStatus;
  private startJudgeReviewIfFrozen;
  private recordReviewPauseOutcome;
  private acquireReviewHoldOnce;
  private acquireReviewHold;
  private finishReviewFreeze;
  private startJudgeReviewOnce;
  private findActiveReview;
  private resolveExactRoleCaller;
  private resolveApiRecoveryAssignment;
  private resumeApiReviewOnce;
  private notifyOperatorIncident;
  private dispatchReviewRequest;
  private syncDialogue;
  private isControllerAgent;
  private attachControllerSurface;
  private controllerKernelText;
  private trackAttemptTask;
  /** Dispatch only materialized active references; never scan run directories or history. */
  private dispatchAllActiveAttempts;
  /** Apply at most one exact Attempt projection, then deliver its high-value event. */
  private applyAttemptRuntimeResult;
  private trackControllerTask;
  private reconcileControllerAgent;
  /** Recover only missing stable review notices from the small RuntimeState. */
  private replayRecordedReviewNotifications;
  private finalizeRoleResultNotification;
  private trackControllerGoalChange;
  /** Keep only the native Goal CAS ref current for one exact AutoLab role. */
  private trackRoleGoalChange;
  /** Resume the same paused Controller Goal from one durable scientific event. */
  private wakeControllerForEvent;
  private runReviewControlHandler;
  private teardown;
  private performTeardown;
  private enqueue;
  private requireState;
  private assertControllerSession;
  private assertReady;
  private requireAttemptRuntime;
  private requireOwner;
  private requireTable;
}
declare const name = "autolab-runtime";
declare const inject: string[];
declare const Config: s<Config>;
declare function apply(ctx: Context, config: Config): Promise<() => Promise<void>>;
//#endregion
export { AutoLabRoleResultSubmission, AutoLabRuntime, AutoLabRuntime as default, AutoLabRuntimeError, CoderImplementationResult, Config, CreateLabResult, PostflightResultSubmission, PreflightVerdictResult, RoleSubmissionResult, ShowLabResult, apply, inject, name };