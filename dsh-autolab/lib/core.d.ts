import { $ as activeCandidateSchema, A as ResolvedManifest, B as ActiveTrial, C as DraftSnapshot, Ct as transitionRuntimeState, D as durableWriteFile, E as RevisionValidation, F as roleBindingSchema, G as LAB_ID_PATTERN, H as CONTROL_PAYLOAD_HASH_PATTERN, I as canonicalJson, J as ReviewResolutionError, K as LabLifecycle, L as sha256, M as hashResolvedManifest, N as parseResolvedManifest, O as generateLabId, P as resolvedManifestSchema, Q as SHA256_PATTERN, R as ActiveCandidate, S as ArtifactStore, St as runtimeStateSchema, T as LabScaffold, U as ConfigRef, V as AutoLabStateError, W as ControllerGoalState, X as RoleState, Y as ReviewResolutionState, Z as RuntimeState, _ as hashRolePacket, _t as reviewResultStateSchema, a as PreflightVerdict, at as controllerGoalSchema, b as verbatimBlockSchema, bt as rolePhaseSchema, c as freezePreflightVerdictArtifact, ct as labLifecycleSchema, d as CompileRolePacketInput, dt as resolutionHash, et as activeReviewSchema, f as CompiledRolePacket, ft as reviewCapabilityStateSchema, g as compileRolePacket, gt as reviewResolutionStateSchema, h as VerbatimBlock, ht as reviewReadyToAdvance, i as PreflightTopLevelVerdict, it as configRefSchema, j as RoleBinding, k as ManifestValidationError, l as parsePreflightVerdict, lt as parseState, m as RolePacket, mt as reviewPauseStateSchema, n as FrozenPreflightVerdict, nt as adoptRuntimeOwner, o as PreflightVerdictError, ot as createRuntimeState, p as PacketValidationError, pt as reviewFreezeComplete, q as ReviewResolutionBody, r as PreflightBlockingFinding, rt as autolabDomainSpec, s as freezePreflightVerdict, st as goalInstallSchema, t as FreezePreflightVerdictInput, tt as activeTrialSchema, u as parsePreflightVerdictArtifact, ut as recordReviewResolution, v as parseRolePacket, vt as reviewVerdictStateSchema, w as FrozenRevision, wt as validateLabId, x as ArtifactError, xt as roleStateSchema, y as rolePacketSchema, yt as roleActivationBlockerSchema, z as ActiveReview } from "./preflight-verdict-Bl7oSf3q.js";
import { z } from "zod";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { GoalRef } from "@deepseek-ai/dsh-goal";
import { ControlHandlerDecision, ControlHandlerRegistration, ControlReceipt, IncomingControl } from "dsh-local-session-messaging";
import { Agent, AgentHandle } from "@deepseek-ai/dsh-agent";
import { Context } from "@deepseek-ai/cordis";
import { SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";

//#region src/runner.d.ts
declare const launchSpecSchema: z.ZodObject<{
  version: z.ZodLiteral<1>;
  kind: z.ZodLiteral<"AUTOLAB_LOCAL_TMUX_LAUNCH">;
  runner: z.ZodObject<{
    id: z.ZodLiteral<"local-tmux">;
    version: z.ZodLiteral<1>;
  }, z.core.$strict>;
  attemptId: z.ZodString;
  tmuxSession: z.ZodString;
  launchNonce: z.ZodString;
  candidateSha: z.ZodString;
  command: z.ZodArray<z.ZodString>;
  commandHash: z.ZodString;
  cwd: z.ZodString;
  cwdHash: z.ZodString;
  env: z.ZodRecord<z.ZodString, z.ZodString>;
  envHash: z.ZodString;
  attemptDirectory: z.ZodString;
  runtimePokeFile: z.ZodOptional<z.ZodString>;
  paths: z.ZodObject<{
    launch: z.ZodString;
    started: z.ZodString;
    exit: z.ZodString;
    log: z.ZodString;
  }, z.core.$strict>;
  issuedAt: z.ZodNumber;
  launchIdentityHash: z.ZodString;
  receiptHash: z.ZodString;
}, z.core.$strict>;
declare const startedReceiptSchema: z.ZodObject<{
  version: z.ZodLiteral<1>;
  kind: z.ZodLiteral<"AUTOLAB_ATTEMPT_STARTED">;
  runner: z.ZodObject<{
    id: z.ZodLiteral<"local-tmux">;
    version: z.ZodLiteral<1>;
  }, z.core.$strict>;
  attemptId: z.ZodString;
  tmuxSession: z.ZodString;
  launchNonce: z.ZodString;
  candidateSha: z.ZodString;
  commandHash: z.ZodString;
  cwd: z.ZodString;
  cwdHash: z.ZodString;
  envHash: z.ZodString;
  launchIdentityHash: z.ZodString;
  launchSpecReceiptHash: z.ZodString;
  logPath: z.ZodString;
  tmuxPaneId: z.ZodString;
  pid: z.ZodNumber;
  pgid: z.ZodNumber;
  processStartId: z.ZodString;
  processCommandHash: z.ZodString;
  hostname: z.ZodString;
  bootId: z.ZodString;
  startedAt: z.ZodNumber;
  receiptHash: z.ZodString;
}, z.core.$strict>;
declare const exitReceiptSchema: z.ZodObject<{
  version: z.ZodLiteral<1>;
  kind: z.ZodLiteral<"AUTOLAB_ATTEMPT_EXIT">;
  runner: z.ZodObject<{
    id: z.ZodLiteral<"local-tmux">;
    version: z.ZodLiteral<1>;
  }, z.core.$strict>;
  attemptId: z.ZodString;
  tmuxSession: z.ZodString;
  launchNonce: z.ZodString;
  candidateSha: z.ZodString;
  commandHash: z.ZodString;
  cwdHash: z.ZodString;
  envHash: z.ZodString;
  launchIdentityHash: z.ZodString;
  startedReceiptHash: z.ZodString;
  tmuxPaneId: z.ZodString;
  pid: z.ZodNumber;
  pgid: z.ZodNumber;
  processStartId: z.ZodString;
  processCommandHash: z.ZodString;
  hostname: z.ZodString;
  bootId: z.ZodString;
  outcome: z.ZodEnum<{
    exited: "exited";
    signaled: "signaled";
    spawn_failed: "spawn_failed";
  }>;
  exitCode: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
  signal: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  spawnError: z.ZodOptional<z.ZodString>;
  logPath: z.ZodString;
  finishedAt: z.ZodNumber;
  receiptHash: z.ZodString;
}, z.core.$strict>;
type LocalTmuxLaunchSpec = z.infer<typeof launchSpecSchema>;
type StartedAttemptReceipt = z.infer<typeof startedReceiptSchema>;
type ExitAttemptReceipt = z.infer<typeof exitReceiptSchema>;
interface CompileLocalTmuxLaunchInput {
  readonly attemptId: string;
  readonly launchNonce: string;
  readonly candidateSha: string;
  readonly cwd: string;
  readonly attemptDirectory: string;
  readonly command: readonly string[];
  /** Exact environment passed to the experiment; no implicit inheritance. */
  readonly env: Readonly<Record<string, string>>;
  /** Mutable endpoint pointer reread after durable started/exit receipts. */
  readonly runtimePokeFile?: string;
  readonly issuedAt: number;
}
interface LocalTmuxLaunchPlan {
  readonly attemptId: string;
  readonly launchNonce: string;
  readonly candidateSha: string;
  readonly cwd: string;
  readonly attemptDirectory: string;
  readonly command: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly runtimePokeFile?: string;
  readonly issuedAt: number;
  readonly tmuxSession: string;
  readonly commandHash: string;
  readonly cwdHash: string;
  readonly envHash: string;
  readonly launchIdentityHash: string;
  readonly paths: LocalTmuxLaunchSpec['paths'];
  readonly launchSpec: LocalTmuxLaunchSpec;
}
type LocalProcessInspection = {
  readonly status: 'dead';
} | {
  readonly status: 'unknown';
} | {
  readonly status: 'alive';
  readonly pid: number;
  readonly pgid: number;
  readonly processStartId: string;
  readonly executablePath: string;
  readonly argv: readonly string[];
  readonly hostname: string;
  readonly bootId: string;
};
interface LocalTmuxPlatform {
  inspectTmux(tmuxSession: string): Promise<{
    readonly available: boolean;
    readonly present: boolean;
    readonly paneId?: string;
    readonly panePid?: number;
    readonly launchNonce?: string;
    readonly launchIdentityHash?: string;
  }>;
  launchTmux(input: {
    readonly plan: LocalTmuxLaunchPlan;
    readonly wrapperPath: string;
  }): Promise<'created' | 'exists'>;
  inspectProcess(pid: number): Promise<LocalProcessInspection>;
  verifyDetachedCheckout(cwd: string, candidateSha: string): Promise<void>;
}
type LocalTmuxBlockerCode = 'CHECKOUT_MISMATCH' | 'IDENTITY_MISMATCH' | 'PROCESS_IDENTITY_MISMATCH' | 'RECEIPT_CORRUPT' | 'TMUX_IDENTITY_MISMATCH';
type LocalTmuxPendingCode = 'ATTEMPT_NOT_FOUND' | 'PROCESS_IDENTITY_UNKNOWN' | 'SYSTEM_UNAVAILABLE' | 'TMUX_LAUNCH_FAILED';
type LocalTmuxInspection = {
  readonly status: 'absent';
  readonly launchPrepared: boolean;
} | {
  readonly status: 'launching';
  readonly launchPrepared: boolean;
  readonly tmuxPresent: true;
} | {
  readonly status: 'running';
  readonly tmuxPresent: boolean;
  readonly tmuxInspectable: boolean;
  readonly started: StartedAttemptReceipt;
} | {
  readonly status: 'completed';
  readonly started: StartedAttemptReceipt;
  readonly exit: ExitAttemptReceipt;
} | {
  readonly status: 'outcome_unknown';
  /** Absent when launch evidence exists but started.json was never committed. */
  readonly started?: StartedAttemptReceipt;
  readonly reason: string;
} | {
  readonly status: 'pending';
  readonly code: LocalTmuxPendingCode;
  readonly message: string;
} | {
  readonly status: 'blocked';
  readonly code: LocalTmuxBlockerCode;
  readonly message: string;
};
interface LocalTmuxOperationOptions {
  readonly platform?: LocalTmuxPlatform;
}
interface LocalTmuxLaunchOptions extends LocalTmuxOperationOptions {
  readonly wrapperPath: string;
}
/** Resolve the one packaged wrapper beside lib/ (or src/ during tests). */
declare function resolveLocalAttemptWrapperPath(): Promise<string>;
/** Compile only immutable launch identity. PID/PGID/boot fields appear only after real start. */
declare function compileLocalTmuxLaunch(input: CompileLocalTmuxLaunchInput): LocalTmuxLaunchPlan;
/** Read receipts and live identities exactly once. It never launches, kills, or polls. */
declare function inspectLocalTmuxAttempt(plan: LocalTmuxLaunchPlan, options?: LocalTmuxOperationOptions): Promise<LocalTmuxInspection>;
/** Adopt is inspect-only. Absence stays pending; this function never creates a replacement. */
declare function adoptLocalTmuxAttempt(plan: LocalTmuxLaunchPlan, options?: LocalTmuxOperationOptions): Promise<LocalTmuxInspection>;
/** Launch once from mechanically proven absence; exact replays inspect/adopt instead of spawning. */
declare function launchLocalTmuxAttempt(plan: LocalTmuxLaunchPlan, options: LocalTmuxLaunchOptions): Promise<LocalTmuxInspection>;
declare const nodeLocalTmuxPlatform: LocalTmuxPlatform;
/**
 * DSH-runtime composition for Controller-owned tmux client calls. Process-table
 * and Git checkout verification remain the existing local mechanical probes;
 * only executable launch/inspection crosses the mounted subprocess seam.
 */
declare function createSubprocessLocalTmuxPlatform(subprocess: Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'>, signal?: AbortSignal): LocalTmuxPlatform;
//#endregion
//#region src/trial.d.ts
declare const componentIdentitySchema: z.ZodObject<{
  id: z.ZodString;
  version: z.ZodString;
  sha256: z.ZodString;
}, z.core.$strict>;
declare const artifactReferenceSchema: z.ZodObject<{
  kind: z.ZodEnum<{
    exit: "exit";
    log: "log";
    artifact: "artifact";
    checkpoint: "checkpoint";
  }>;
  path: z.ZodString;
}, z.core.$strict>;
declare const receiptReferenceSchema: z.ZodObject<{
  path: z.ZodString;
  sha256: z.ZodString;
}, z.core.$strict>;
declare const trialContractSchema: z.ZodObject<{
  version: z.ZodLiteral<1>;
  trial_id: z.ZodString;
  lane_id: z.ZodString;
  candidate_sha: z.ZodString;
  config_revision: z.ZodNumber;
  contract: z.ZodJSONSchema;
  run_slots: z.ZodArray<z.ZodObject<{
    runslot_id: z.ZodString;
    contract: z.ZodOptional<z.ZodJSONSchema>;
  }, z.core.$strict>>;
  created_at: z.ZodNumber;
}, z.core.$strict>;
declare const runSlotContractSchema: z.ZodObject<{
  version: z.ZodLiteral<1>;
  runslot_id: z.ZodString;
  trial_id: z.ZodString;
  trial_contract_sha256: z.ZodString;
  candidate_sha: z.ZodString;
  config_revision: z.ZodNumber;
  contract: z.ZodOptional<z.ZodJSONSchema>;
}, z.core.$strict>;
declare const runSlotStateSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
  revision: z.ZodLiteral<0>;
  status: z.ZodLiteral<"pending">;
  version: z.ZodLiteral<1>;
  runslot_id: z.ZodString;
  trial_id: z.ZodString;
  runslot_contract_sha256: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
  status: z.ZodLiteral<"attempt_active">;
  revision: z.ZodNumber;
  attempt_id: z.ZodString;
  attempt_ordinal: z.ZodNumber;
  attempt_identity_sha256: z.ZodString;
  attempt_ids: z.ZodArray<z.ZodString>;
  launch_nonces: z.ZodArray<z.ZodString>;
  version: z.ZodLiteral<1>;
  runslot_id: z.ZodString;
  trial_id: z.ZodString;
  runslot_contract_sha256: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
  status: z.ZodLiteral<"outcome_unknown">;
  revision: z.ZodNumber;
  attempt_id: z.ZodString;
  attempt_ordinal: z.ZodNumber;
  attempt_identity_sha256: z.ZodString;
  attempt_ids: z.ZodArray<z.ZodString>;
  launch_nonces: z.ZodArray<z.ZodString>;
  version: z.ZodLiteral<1>;
  runslot_id: z.ZodString;
  trial_id: z.ZodString;
  runslot_contract_sha256: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
  status: z.ZodLiteral<"retryable">;
  revision: z.ZodNumber;
  attempt_id: z.ZodString;
  attempt_ordinal: z.ZodNumber;
  attempt_identity_sha256: z.ZodString;
  attempt_ids: z.ZodArray<z.ZodString>;
  launch_nonces: z.ZodArray<z.ZodString>;
  version: z.ZodLiteral<1>;
  runslot_id: z.ZodString;
  trial_id: z.ZodString;
  runslot_contract_sha256: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
  status: z.ZodLiteral<"execution_complete">;
  revision: z.ZodNumber;
  attempt_id: z.ZodString;
  attempt_ordinal: z.ZodNumber;
  attempt_identity_sha256: z.ZodString;
  attempt_ids: z.ZodArray<z.ZodString>;
  launch_nonces: z.ZodArray<z.ZodString>;
  version: z.ZodLiteral<1>;
  runslot_id: z.ZodString;
  trial_id: z.ZodString;
  runslot_contract_sha256: z.ZodString;
}, z.core.$strict>], "status">;
declare const requestIdentitySchema: z.ZodObject<{
  kind: z.ZodEnum<{
    command: "command";
    runner_request: "runner_request";
  }>;
  sha256: z.ZodString;
}, z.core.$strict>;
declare const gpuLeaseSchema: z.ZodObject<{
  gpu_uuid: z.ZodString;
  lease_id: z.ZodString;
  fencing_token: z.ZodNumber;
}, z.core.$strict>;
declare const remoteConnectionSchema: z.ZodObject<{
  connection_identity: z.ZodString;
}, z.core.$strict>;
declare const outcomeUnknownAttemptSchema: z.ZodObject<{
  phase: z.ZodLiteral<"outcome_unknown">;
  started_at: z.ZodOptional<z.ZodNumber>;
  started_receipt: z.ZodOptional<z.ZodObject<{
    path: z.ZodString;
    sha256: z.ZodString;
  }, z.core.$strict>>;
  process: z.ZodOptional<z.ZodObject<{
    pid: z.ZodOptional<z.ZodNumber>;
    pgid: z.ZodOptional<z.ZodNumber>;
    start_identity: z.ZodOptional<z.ZodString>;
    host_boot_id: z.ZodOptional<z.ZodString>;
    tmux_session: z.ZodOptional<z.ZodString>;
  }, z.core.$strict>>;
  unknown_since: z.ZodNumber;
  uncertainty_receipt: z.ZodObject<{
    path: z.ZodString;
    sha256: z.ZodString;
  }, z.core.$strict>;
  technical_detail: z.ZodObject<{
    kind: z.ZodEnum<{
      unknown: "unknown";
      runner: "runner";
      process: "process";
      api: "api";
      hardware: "hardware";
      transport: "transport";
      cancelled: "cancelled";
    }>;
    code: z.ZodString;
    detail: z.ZodOptional<z.ZodString>;
  }, z.core.$strict>;
  incident: z.ZodOptional<z.ZodObject<{
    kind: z.ZodEnum<{
      exit: "exit";
      log: "log";
      artifact: "artifact";
      checkpoint: "checkpoint";
    }>;
    path: z.ZodString;
  }, z.core.$strict>>;
  version: z.ZodLiteral<1>;
  attempt_id: z.ZodString;
  attempt_ordinal: z.ZodNumber;
  predecessor_attempt_id: z.ZodOptional<z.ZodString>;
  trial_id: z.ZodString;
  runslot_id: z.ZodString;
  trial_contract_sha256: z.ZodString;
  runslot_contract_sha256: z.ZodString;
  candidate_sha: z.ZodString;
  config_revision: z.ZodNumber;
  request: z.ZodObject<{
    kind: z.ZodEnum<{
      command: "command";
      runner_request: "runner_request";
    }>;
    sha256: z.ZodString;
  }, z.core.$strict>;
  cwd: z.ZodString;
  env_sha256: z.ZodString;
  runner: z.ZodObject<{
    id: z.ZodString;
    version: z.ZodString;
    sha256: z.ZodString;
  }, z.core.$strict>;
  host_id: z.ZodString;
  launch_nonce: z.ZodString;
  launched_at: z.ZodNumber;
  gpu_lease: z.ZodOptional<z.ZodObject<{
    gpu_uuid: z.ZodString;
    lease_id: z.ZodString;
    fencing_token: z.ZodNumber;
  }, z.core.$strict>>;
  remote_connection: z.ZodOptional<z.ZodObject<{
    connection_identity: z.ZodString;
  }, z.core.$strict>>;
  adapter_checkpoint_identity: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
declare const terminalAttemptSchema: z.ZodObject<{
  phase: z.ZodLiteral<"terminal">;
  started_at: z.ZodOptional<z.ZodNumber>;
  started_receipt: z.ZodOptional<z.ZodObject<{
    path: z.ZodString;
    sha256: z.ZodString;
  }, z.core.$strict>>;
  process: z.ZodOptional<z.ZodObject<{
    pid: z.ZodOptional<z.ZodNumber>;
    pgid: z.ZodOptional<z.ZodNumber>;
    start_identity: z.ZodOptional<z.ZodString>;
    host_boot_id: z.ZodOptional<z.ZodString>;
    tmux_session: z.ZodOptional<z.ZodString>;
  }, z.core.$strict>>;
  completed_at: z.ZodNumber;
  completion_identity: z.ZodString;
  completion_receipt: z.ZodObject<{
    path: z.ZodString;
    sha256: z.ZodString;
  }, z.core.$strict>;
  technical_outcome: z.ZodEnum<{
    succeeded: "succeeded";
    failed: "failed";
  }>;
  technical_detail: z.ZodOptional<z.ZodObject<{
    kind: z.ZodEnum<{
      unknown: "unknown";
      runner: "runner";
      process: "process";
      api: "api";
      hardware: "hardware";
      transport: "transport";
      cancelled: "cancelled";
    }>;
    code: z.ZodString;
    detail: z.ZodOptional<z.ZodString>;
  }, z.core.$strict>>;
  artifacts: z.ZodArray<z.ZodObject<{
    kind: z.ZodEnum<{
      exit: "exit";
      log: "log";
      artifact: "artifact";
      checkpoint: "checkpoint";
    }>;
    path: z.ZodString;
  }, z.core.$strict>>;
  version: z.ZodLiteral<1>;
  attempt_id: z.ZodString;
  attempt_ordinal: z.ZodNumber;
  predecessor_attempt_id: z.ZodOptional<z.ZodString>;
  trial_id: z.ZodString;
  runslot_id: z.ZodString;
  trial_contract_sha256: z.ZodString;
  runslot_contract_sha256: z.ZodString;
  candidate_sha: z.ZodString;
  config_revision: z.ZodNumber;
  request: z.ZodObject<{
    kind: z.ZodEnum<{
      command: "command";
      runner_request: "runner_request";
    }>;
    sha256: z.ZodString;
  }, z.core.$strict>;
  cwd: z.ZodString;
  env_sha256: z.ZodString;
  runner: z.ZodObject<{
    id: z.ZodString;
    version: z.ZodString;
    sha256: z.ZodString;
  }, z.core.$strict>;
  host_id: z.ZodString;
  launch_nonce: z.ZodString;
  launched_at: z.ZodNumber;
  gpu_lease: z.ZodOptional<z.ZodObject<{
    gpu_uuid: z.ZodString;
    lease_id: z.ZodString;
    fencing_token: z.ZodNumber;
  }, z.core.$strict>>;
  remote_connection: z.ZodOptional<z.ZodObject<{
    connection_identity: z.ZodString;
  }, z.core.$strict>>;
  adapter_checkpoint_identity: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
declare const attemptSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
  phase: z.ZodLiteral<"launching">;
  version: z.ZodLiteral<1>;
  attempt_id: z.ZodString;
  attempt_ordinal: z.ZodNumber;
  predecessor_attempt_id: z.ZodOptional<z.ZodString>;
  trial_id: z.ZodString;
  runslot_id: z.ZodString;
  trial_contract_sha256: z.ZodString;
  runslot_contract_sha256: z.ZodString;
  candidate_sha: z.ZodString;
  config_revision: z.ZodNumber;
  request: z.ZodObject<{
    kind: z.ZodEnum<{
      command: "command";
      runner_request: "runner_request";
    }>;
    sha256: z.ZodString;
  }, z.core.$strict>;
  cwd: z.ZodString;
  env_sha256: z.ZodString;
  runner: z.ZodObject<{
    id: z.ZodString;
    version: z.ZodString;
    sha256: z.ZodString;
  }, z.core.$strict>;
  host_id: z.ZodString;
  launch_nonce: z.ZodString;
  launched_at: z.ZodNumber;
  gpu_lease: z.ZodOptional<z.ZodObject<{
    gpu_uuid: z.ZodString;
    lease_id: z.ZodString;
    fencing_token: z.ZodNumber;
  }, z.core.$strict>>;
  remote_connection: z.ZodOptional<z.ZodObject<{
    connection_identity: z.ZodString;
  }, z.core.$strict>>;
  adapter_checkpoint_identity: z.ZodOptional<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
  phase: z.ZodLiteral<"running">;
  started_at: z.ZodNumber;
  started_receipt: z.ZodObject<{
    path: z.ZodString;
    sha256: z.ZodString;
  }, z.core.$strict>;
  process: z.ZodOptional<z.ZodObject<{
    pid: z.ZodOptional<z.ZodNumber>;
    pgid: z.ZodOptional<z.ZodNumber>;
    start_identity: z.ZodOptional<z.ZodString>;
    host_boot_id: z.ZodOptional<z.ZodString>;
    tmux_session: z.ZodOptional<z.ZodString>;
  }, z.core.$strict>>;
  version: z.ZodLiteral<1>;
  attempt_id: z.ZodString;
  attempt_ordinal: z.ZodNumber;
  predecessor_attempt_id: z.ZodOptional<z.ZodString>;
  trial_id: z.ZodString;
  runslot_id: z.ZodString;
  trial_contract_sha256: z.ZodString;
  runslot_contract_sha256: z.ZodString;
  candidate_sha: z.ZodString;
  config_revision: z.ZodNumber;
  request: z.ZodObject<{
    kind: z.ZodEnum<{
      command: "command";
      runner_request: "runner_request";
    }>;
    sha256: z.ZodString;
  }, z.core.$strict>;
  cwd: z.ZodString;
  env_sha256: z.ZodString;
  runner: z.ZodObject<{
    id: z.ZodString;
    version: z.ZodString;
    sha256: z.ZodString;
  }, z.core.$strict>;
  host_id: z.ZodString;
  launch_nonce: z.ZodString;
  launched_at: z.ZodNumber;
  gpu_lease: z.ZodOptional<z.ZodObject<{
    gpu_uuid: z.ZodString;
    lease_id: z.ZodString;
    fencing_token: z.ZodNumber;
  }, z.core.$strict>>;
  remote_connection: z.ZodOptional<z.ZodObject<{
    connection_identity: z.ZodString;
  }, z.core.$strict>>;
  adapter_checkpoint_identity: z.ZodOptional<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
  phase: z.ZodLiteral<"outcome_unknown">;
  started_at: z.ZodOptional<z.ZodNumber>;
  started_receipt: z.ZodOptional<z.ZodObject<{
    path: z.ZodString;
    sha256: z.ZodString;
  }, z.core.$strict>>;
  process: z.ZodOptional<z.ZodObject<{
    pid: z.ZodOptional<z.ZodNumber>;
    pgid: z.ZodOptional<z.ZodNumber>;
    start_identity: z.ZodOptional<z.ZodString>;
    host_boot_id: z.ZodOptional<z.ZodString>;
    tmux_session: z.ZodOptional<z.ZodString>;
  }, z.core.$strict>>;
  unknown_since: z.ZodNumber;
  uncertainty_receipt: z.ZodObject<{
    path: z.ZodString;
    sha256: z.ZodString;
  }, z.core.$strict>;
  technical_detail: z.ZodObject<{
    kind: z.ZodEnum<{
      unknown: "unknown";
      runner: "runner";
      process: "process";
      api: "api";
      hardware: "hardware";
      transport: "transport";
      cancelled: "cancelled";
    }>;
    code: z.ZodString;
    detail: z.ZodOptional<z.ZodString>;
  }, z.core.$strict>;
  incident: z.ZodOptional<z.ZodObject<{
    kind: z.ZodEnum<{
      exit: "exit";
      log: "log";
      artifact: "artifact";
      checkpoint: "checkpoint";
    }>;
    path: z.ZodString;
  }, z.core.$strict>>;
  version: z.ZodLiteral<1>;
  attempt_id: z.ZodString;
  attempt_ordinal: z.ZodNumber;
  predecessor_attempt_id: z.ZodOptional<z.ZodString>;
  trial_id: z.ZodString;
  runslot_id: z.ZodString;
  trial_contract_sha256: z.ZodString;
  runslot_contract_sha256: z.ZodString;
  candidate_sha: z.ZodString;
  config_revision: z.ZodNumber;
  request: z.ZodObject<{
    kind: z.ZodEnum<{
      command: "command";
      runner_request: "runner_request";
    }>;
    sha256: z.ZodString;
  }, z.core.$strict>;
  cwd: z.ZodString;
  env_sha256: z.ZodString;
  runner: z.ZodObject<{
    id: z.ZodString;
    version: z.ZodString;
    sha256: z.ZodString;
  }, z.core.$strict>;
  host_id: z.ZodString;
  launch_nonce: z.ZodString;
  launched_at: z.ZodNumber;
  gpu_lease: z.ZodOptional<z.ZodObject<{
    gpu_uuid: z.ZodString;
    lease_id: z.ZodString;
    fencing_token: z.ZodNumber;
  }, z.core.$strict>>;
  remote_connection: z.ZodOptional<z.ZodObject<{
    connection_identity: z.ZodString;
  }, z.core.$strict>>;
  adapter_checkpoint_identity: z.ZodOptional<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
  phase: z.ZodLiteral<"terminal">;
  started_at: z.ZodOptional<z.ZodNumber>;
  started_receipt: z.ZodOptional<z.ZodObject<{
    path: z.ZodString;
    sha256: z.ZodString;
  }, z.core.$strict>>;
  process: z.ZodOptional<z.ZodObject<{
    pid: z.ZodOptional<z.ZodNumber>;
    pgid: z.ZodOptional<z.ZodNumber>;
    start_identity: z.ZodOptional<z.ZodString>;
    host_boot_id: z.ZodOptional<z.ZodString>;
    tmux_session: z.ZodOptional<z.ZodString>;
  }, z.core.$strict>>;
  completed_at: z.ZodNumber;
  completion_identity: z.ZodString;
  completion_receipt: z.ZodObject<{
    path: z.ZodString;
    sha256: z.ZodString;
  }, z.core.$strict>;
  technical_outcome: z.ZodEnum<{
    succeeded: "succeeded";
    failed: "failed";
  }>;
  technical_detail: z.ZodOptional<z.ZodObject<{
    kind: z.ZodEnum<{
      unknown: "unknown";
      runner: "runner";
      process: "process";
      api: "api";
      hardware: "hardware";
      transport: "transport";
      cancelled: "cancelled";
    }>;
    code: z.ZodString;
    detail: z.ZodOptional<z.ZodString>;
  }, z.core.$strict>>;
  artifacts: z.ZodArray<z.ZodObject<{
    kind: z.ZodEnum<{
      exit: "exit";
      log: "log";
      artifact: "artifact";
      checkpoint: "checkpoint";
    }>;
    path: z.ZodString;
  }, z.core.$strict>>;
  version: z.ZodLiteral<1>;
  attempt_id: z.ZodString;
  attempt_ordinal: z.ZodNumber;
  predecessor_attempt_id: z.ZodOptional<z.ZodString>;
  trial_id: z.ZodString;
  runslot_id: z.ZodString;
  trial_contract_sha256: z.ZodString;
  runslot_contract_sha256: z.ZodString;
  candidate_sha: z.ZodString;
  config_revision: z.ZodNumber;
  request: z.ZodObject<{
    kind: z.ZodEnum<{
      command: "command";
      runner_request: "runner_request";
    }>;
    sha256: z.ZodString;
  }, z.core.$strict>;
  cwd: z.ZodString;
  env_sha256: z.ZodString;
  runner: z.ZodObject<{
    id: z.ZodString;
    version: z.ZodString;
    sha256: z.ZodString;
  }, z.core.$strict>;
  host_id: z.ZodString;
  launch_nonce: z.ZodString;
  launched_at: z.ZodNumber;
  gpu_lease: z.ZodOptional<z.ZodObject<{
    gpu_uuid: z.ZodString;
    lease_id: z.ZodString;
    fencing_token: z.ZodNumber;
  }, z.core.$strict>>;
  remote_connection: z.ZodOptional<z.ZodObject<{
    connection_identity: z.ZodString;
  }, z.core.$strict>>;
  adapter_checkpoint_identity: z.ZodOptional<z.ZodString>;
}, z.core.$strict>], "phase">;
declare const attemptStartedReceiptSchema: z.ZodObject<{
  version: z.ZodLiteral<1>;
  type: z.ZodLiteral<"attempt_started">;
  attempt_id: z.ZodString;
  launch_nonce: z.ZodString;
  candidate_sha: z.ZodString;
  request_sha256: z.ZodString;
  started_at: z.ZodNumber;
  process: z.ZodOptional<z.ZodObject<{
    pid: z.ZodOptional<z.ZodNumber>;
    pgid: z.ZodOptional<z.ZodNumber>;
    start_identity: z.ZodOptional<z.ZodString>;
    host_boot_id: z.ZodOptional<z.ZodString>;
    tmux_session: z.ZodOptional<z.ZodString>;
  }, z.core.$strict>>;
  gpu_lease: z.ZodOptional<z.ZodObject<{
    gpu_uuid: z.ZodString;
    lease_id: z.ZodString;
    fencing_token: z.ZodNumber;
  }, z.core.$strict>>;
  remote_connection: z.ZodOptional<z.ZodObject<{
    connection_identity: z.ZodString;
  }, z.core.$strict>>;
  adapter_checkpoint_identity: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
declare const attemptCompletionReceiptSchema: z.ZodObject<{
  version: z.ZodLiteral<1>;
  type: z.ZodLiteral<"attempt_completion">;
  attempt_id: z.ZodString;
  launch_nonce: z.ZodString;
  candidate_sha: z.ZodString;
  request_sha256: z.ZodString;
  completed_at: z.ZodNumber;
  completion_identity: z.ZodString;
  technical_outcome: z.ZodEnum<{
    succeeded: "succeeded";
    failed: "failed";
  }>;
  technical_detail: z.ZodOptional<z.ZodObject<{
    kind: z.ZodEnum<{
      unknown: "unknown";
      runner: "runner";
      process: "process";
      api: "api";
      hardware: "hardware";
      transport: "transport";
      cancelled: "cancelled";
    }>;
    code: z.ZodString;
    detail: z.ZodOptional<z.ZodString>;
  }, z.core.$strict>>;
  artifacts: z.ZodArray<z.ZodObject<{
    kind: z.ZodEnum<{
      exit: "exit";
      log: "log";
      artifact: "artifact";
      checkpoint: "checkpoint";
    }>;
    path: z.ZodString;
  }, z.core.$strict>>;
}, z.core.$strict>;
declare const attemptUncertainReceiptSchema: z.ZodObject<{
  version: z.ZodLiteral<1>;
  type: z.ZodLiteral<"attempt_outcome_unknown">;
  attempt_id: z.ZodString;
  launch_nonce: z.ZodString;
  candidate_sha: z.ZodString;
  request_sha256: z.ZodString;
  observed_at: z.ZodNumber;
  technical_detail: z.ZodObject<{
    kind: z.ZodEnum<{
      unknown: "unknown";
      runner: "runner";
      process: "process";
      api: "api";
      hardware: "hardware";
      transport: "transport";
      cancelled: "cancelled";
    }>;
    code: z.ZodString;
    detail: z.ZodOptional<z.ZodString>;
  }, z.core.$strict>;
  incident: z.ZodOptional<z.ZodObject<{
    kind: z.ZodEnum<{
      exit: "exit";
      log: "log";
      artifact: "artifact";
      checkpoint: "checkpoint";
    }>;
    path: z.ZodString;
  }, z.core.$strict>>;
}, z.core.$strict>;
type TrialContract = z.infer<typeof trialContractSchema>;
type RunSlotContract = z.infer<typeof runSlotContractSchema>;
type RunSlotState = z.infer<typeof runSlotStateSchema>;
type Attempt = z.infer<typeof attemptSchema>;
type TerminalAttempt = z.infer<typeof terminalAttemptSchema>;
type OutcomeUnknownAttempt = z.infer<typeof outcomeUnknownAttemptSchema>;
type AttemptStartedReceipt = z.infer<typeof attemptStartedReceiptSchema>;
type AttemptCompletionReceipt = z.infer<typeof attemptCompletionReceiptSchema>;
type AttemptUncertainReceipt = z.infer<typeof attemptUncertainReceiptSchema>;
type ArtifactReference = z.infer<typeof artifactReferenceSchema>;
type ComponentIdentity = z.infer<typeof componentIdentitySchema>;
interface FrozenRecord<T> {
  readonly value: T;
  readonly canonicalJson: string;
  readonly sha256: string;
}
interface RunSlotAttemptTransition<TAttempt extends Attempt = Attempt> {
  /** CAS token: persist `state` only if the durable revision still equals this value. */
  readonly expected_revision: number;
  readonly state: RunSlotState;
  readonly attempt: TAttempt;
}
declare class TrialContractError extends Error {
  readonly code: 'INVALID_TRIAL' | 'RUNSLOT_NOT_FOUND' | 'IDENTITY_MISMATCH';
  readonly name = "TrialContractError";
  constructor(message: string, code: 'INVALID_TRIAL' | 'RUNSLOT_NOT_FOUND' | 'IDENTITY_MISMATCH');
}
declare class AttemptTransitionError extends Error {
  readonly code: 'INVALID_ATTEMPT' | 'INVALID_RECEIPT' | 'ILLEGAL_TRANSITION' | 'IDENTITY_MISMATCH' | 'RETRY_NOT_ALLOWED' | 'STALE_RUNSLOT_STATE';
  readonly name = "AttemptTransitionError";
  constructor(message: string, code: 'INVALID_ATTEMPT' | 'INVALID_RECEIPT' | 'ILLEGAL_TRANSITION' | 'IDENTITY_MISMATCH' | 'RETRY_NOT_ALLOWED' | 'STALE_RUNSLOT_STATE');
}
declare function parseTrialContract(value: unknown): TrialContract;
declare function compileTrialContract(value: unknown): FrozenRecord<TrialContract>;
declare function compileRunSlotContract(trialInput: FrozenRecord<TrialContract>, runSlotId: string): FrozenRecord<RunSlotContract>;
declare function createRunSlotState(runSlotInput: FrozenRecord<RunSlotContract>): RunSlotState;
declare function parseRunSlotState(value: unknown): RunSlotState;
interface AttemptExecutionInput {
  readonly attempt_id: string;
  readonly request: z.infer<typeof requestIdentitySchema>;
  readonly cwd: string;
  readonly env_sha256: string;
  readonly runner: z.infer<typeof componentIdentitySchema>;
  readonly host_id: string;
  readonly launch_nonce: string;
  readonly launched_at: number;
  readonly gpu_lease?: z.infer<typeof gpuLeaseSchema>;
  readonly remote_connection?: z.infer<typeof remoteConnectionSchema>;
  readonly adapter_checkpoint_identity?: string;
}
declare function createInitialAttempt(runSlotInput: FrozenRecord<RunSlotContract>, stateInput: RunSlotState, expectedRevision: number, inputValue: AttemptExecutionInput): RunSlotAttemptTransition;
declare function parseAttempt(value: unknown): Attempt;
declare function compileAttemptStartedReceipt(value: unknown): FrozenRecord<AttemptStartedReceipt>;
declare function compileAttemptCompletionReceipt(value: unknown): FrozenRecord<AttemptCompletionReceipt>;
declare function compileAttemptUncertainReceipt(value: unknown): FrozenRecord<AttemptUncertainReceipt>;
declare function recordAttemptStarted(stateInput: RunSlotState, expectedRevision: number, attemptInput: Attempt, receiptInput: FrozenRecord<AttemptStartedReceipt>, receiptPath: string): RunSlotAttemptTransition;
declare function recordAttemptOutcomeUnknown(stateInput: RunSlotState, expectedRevision: number, attemptInput: Attempt, receiptInput: FrozenRecord<AttemptUncertainReceipt>, receiptPath: string): RunSlotAttemptTransition<OutcomeUnknownAttempt>;
declare function recordAttemptCompletion(stateInput: RunSlotState, expectedRevision: number, attemptInput: Attempt, receiptInput: FrozenRecord<AttemptCompletionReceipt>, receiptPath: string): RunSlotAttemptTransition<TerminalAttempt>;
declare function createRetryAttempt(stateInput: RunSlotState, expectedRevision: number, previousInput: Attempt, inputValue: AttemptExecutionInput): RunSlotAttemptTransition;
//#endregion
//#region src/attempt-artifacts.d.ts
declare const localAttemptRequestSchema: z.ZodObject<{
  version: z.ZodLiteral<1>;
  kind: z.ZodLiteral<"AUTOLAB_LOCAL_TMUX_REQUEST">;
  lab_id: z.ZodString;
  config_revision: z.ZodNumber;
  trial_id: z.ZodString;
  runslot_id: z.ZodString;
  attempt_id: z.ZodString;
  attempt_ordinal: z.ZodNumber;
  launch_nonce: z.ZodString;
  candidate_sha: z.ZodString;
  runner: z.ZodObject<{
    id: z.ZodString;
    version: z.ZodString;
    sha256: z.ZodString;
  }, z.core.$strict>;
  host_id: z.ZodString;
  command: z.ZodArray<z.ZodString>;
  env: z.ZodRecord<z.ZodString, z.ZodString>;
  cwd: z.ZodString;
  checkout_path: z.ZodString;
  attempt_directory: z.ZodString;
  runtime_poke_file: z.ZodOptional<z.ZodString>;
  issued_at: z.ZodNumber;
}, z.core.$strict>;
type LocalAttemptRequest = z.infer<typeof localAttemptRequestSchema>;
interface AttemptArtifactReference {
  readonly path: string;
  readonly hash: string;
}
interface CreateInitialLocalAttemptInput {
  readonly frozen: FrozenRevision;
  readonly trial: FrozenRecord<TrialContract>;
  readonly runSlot: FrozenRecord<RunSlotContract>;
  readonly runSlotState: RunSlotState;
  readonly hostId: string;
  readonly command: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** Stable mutable endpoint pointer; its contents are never Attempt truth. */
  readonly runtimePokeFile?: string;
  /** Stable time already anchored by the Trial/Controller projection. */
  readonly issuedAt: number;
}
interface CreateRetryLocalAttemptInput {
  readonly frozen: FrozenRevision;
  /** Exact immutable failed intent read from the active Controller reference. */
  readonly previous: ReadLocalAttemptIntent;
  readonly runSlotState: RunSlotState;
  readonly hostId: string;
  readonly command: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** Stable mutable endpoint pointer; its contents are never Attempt truth. */
  readonly runtimePokeFile?: string;
}
interface FrozenLocalAttemptIntent {
  readonly request: FrozenRecord<LocalAttemptRequest> & {
    readonly path: string;
  };
  readonly attempt: FrozenRecord<Attempt> & {
    readonly path: string;
  };
  readonly transition: RunSlotAttemptTransition;
  readonly launchPlan: LocalTmuxLaunchPlan;
  readonly checkoutPath: string;
}
interface ReadLocalAttemptIntent {
  readonly request: FrozenRecord<LocalAttemptRequest> & {
    readonly path: string;
  };
  readonly attempt: FrozenRecord<Attempt> & {
    readonly path: string;
  };
  readonly launchPlan: LocalTmuxLaunchPlan;
}
declare class AttemptArtifactError extends Error {
  readonly code: 'INVALID_INPUT' | 'IDENTITY_MISMATCH' | 'ARTIFACT_CONFLICT' | 'ARTIFACT_CORRUPT' | 'IO_FAILED';
  readonly name = "AttemptArtifactError";
  constructor(message: string, code: 'INVALID_INPUT' | 'IDENTITY_MISMATCH' | 'ARTIFACT_CONFLICT' | 'ARTIFACT_CORRUPT' | 'IO_FAILED');
}
/** Freeze the exact initial Attempt intent before its short Controller CAS. */
declare function freezeInitialLocalAttempt(input: CreateInitialLocalAttemptInput): Promise<FrozenLocalAttemptIntent>;
/** Recompile and verify an initial intent without trusting mutable process state. */
declare function verifyInitialLocalAttempt(input: CreateInitialLocalAttemptInput): Promise<FrozenLocalAttemptIntent>;
/** Freeze one new technical retry while preserving the exact failed lineage. */
declare function freezeRetryLocalAttempt(input: CreateRetryLocalAttemptInput): Promise<FrozenLocalAttemptIntent>;
/** Read the exact current Attempt plus its immutable local-runner request. */
declare function readLocalAttemptIntent(input: {
  readonly runRoot: string;
  readonly activeAttempt: AttemptArtifactReference;
}): Promise<ReadLocalAttemptIntent>;
/** Freeze a later running/unknown/terminal Attempt projection. */
declare function freezeAttemptStateArtifact(runRoot: string, runSlotRevision: number, attemptInput: Attempt): Promise<FrozenRecord<Attempt> & {
  readonly path: string;
}>;
declare function freezeAttemptReceiptArtifact(runRoot: string, attemptId: string, kind: 'started' | 'completion' | 'uncertain', receipt: FrozenRecord<AttemptStartedReceipt | AttemptCompletionReceipt | AttemptUncertainReceipt>): Promise<{
  readonly path: string;
  readonly sha256: string;
}>;
/** Adopt the first durable unknown observation across the artifact-before-CAS crash window. */
declare function readAttemptUncertainReceiptArtifactIfPresent(runRoot: string, attemptId: string): Promise<(FrozenRecord<AttemptUncertainReceipt> & {
  readonly path: string;
}) | undefined>;
declare function localAttemptDirectory(runRoot: string, attemptId: string): string;
declare function localAttemptCheckoutPath(runRoot: string, attemptId: string): string;
declare function localAttemptRequestPath(runRoot: string, attemptId: string): string;
//#endregion
//#region src/local-attempt-reconcile.d.ts
type GenericAttemptReceipt = AttemptStartedReceipt | AttemptCompletionReceipt | AttemptUncertainReceipt;
interface LocalAttemptReconcileInput {
  readonly runRoot: string;
  readonly runSlotState: RunSlotState;
  /** Frozen request/Attempt artifacts previously verified by readLocalAttemptIntent(). */
  readonly intent: ReadLocalAttemptIntent;
  readonly inspection: LocalTmuxInspection;
  /** Needed only for the first outcome-unknown observation. */
  readonly observedAt?: number;
}
interface LocalAttemptReconcileIdentity {
  readonly attemptId: string;
  readonly launchNonce: string;
  readonly requestSha256: string;
}
interface FrozenLocalAttemptReconcileRecord {
  readonly kind: 'started' | 'completion' | 'uncertain';
  readonly receipt: FrozenRecord<GenericAttemptReceipt> & {
    readonly path: string;
  };
  /** Present only when this observation derived a new Attempt projection. */
  readonly attemptArtifact?: FrozenRecord<Attempt> & {
    readonly path: string;
  };
}
type LocalAttemptReconcileResult = {
  readonly action: 'launch_required';
  readonly identity: LocalAttemptReconcileIdentity;
  readonly launchPrepared: boolean;
} | {
  readonly action: 'await_started_receipt';
  readonly identity: LocalAttemptReconcileIdentity;
  readonly launchPrepared: boolean;
} | {
  readonly action: 'blocked';
  readonly identity: LocalAttemptReconcileIdentity;
  readonly blocker: {
    readonly code: LocalTmuxBlockerCode;
    readonly message: string;
  };
} | {
  readonly action: 'pending';
  readonly identity: LocalAttemptReconcileIdentity;
  readonly pending: {
    readonly code: LocalTmuxPendingCode;
    readonly message: string;
  };
} | {
  readonly action: 'record_started' | 'record_completion' | 'record_uncertain' | 'already_reconciled';
  readonly identity: LocalAttemptReconcileIdentity;
  readonly inspectionStatus: 'running' | 'completed' | 'outcome_unknown';
  /** Frozen derivation records; these are not separate Controller CAS operations. */
  readonly records: readonly FrozenLocalAttemptReconcileRecord[];
  /** At most one aggregate CAS from the input RunSlot revision to the final projection. */
  readonly transition?: RunSlotAttemptTransition;
};
declare class LocalAttemptReconcileError extends Error {
  readonly code: 'INVALID_INPUT' | 'IDENTITY_MISMATCH';
  readonly name = "LocalAttemptReconcileError";
  constructor(message: string, code: 'INVALID_INPUT' | 'IDENTITY_MISMATCH');
}
/**
 * Convert one already-completed local-tmux inspection into generic Attempt
 * artifacts and CAS-ready RunSlot transitions. It performs no launch, poll,
 * retry, or Controller mutation.
 */
declare function reconcileLocalTmuxInspection(input: LocalAttemptReconcileInput): Promise<LocalAttemptReconcileResult>;
//#endregion
//#region src/attempt-runtime.d.ts
interface AttemptRuntimeTarget {
  readonly labId: string;
  readonly trialId: string;
  readonly runSlotId: string;
}
type AttemptRuntimeReference = NonNullable<ActiveTrial['runSlots'][string]['activeAttempt']>;
type AttemptRuntimeExternalEdge = 'startup' | 'poke';
type AttemptRuntimeEdge = AttemptRuntimeExternalEdge | 'launch-safety' | 'pending-retry';
interface AttemptRuntimeProjection {
  /** Root must CAS this exact RuntimeState revision before publishing the new reference. */
  readonly expectedRuntimeRevision: number;
  readonly trialId: string;
  readonly runSlotId: string;
  readonly expectedActiveAttempt: AttemptRuntimeReference;
  readonly runSlotState: RunSlotState;
  readonly activeAttempt: AttemptRuntimeReference;
}
interface AttemptControllerWake {
  readonly labId: string;
  readonly controllerSessionId: string;
  readonly goalRef: {
    readonly id: string;
    readonly revision: number;
  };
  readonly trialId: string;
  readonly runSlotId: string;
  readonly attemptId: string;
  readonly phase: 'terminal' | 'outcome_unknown';
}
type AttemptRuntimeResult = {
  readonly outcome: 'inactive' | 'stale';
  readonly edge: AttemptRuntimeEdge;
  readonly target: AttemptRuntimeTarget;
} | {
  readonly outcome: 'handled';
  readonly edge: AttemptRuntimeEdge;
  readonly target: AttemptRuntimeTarget;
  readonly sourceAttempt: AttemptRuntimeReference;
  readonly launched: boolean;
  readonly inspection: LocalTmuxInspection;
  readonly reconcile: LocalAttemptReconcileResult;
  readonly projection?: AttemptRuntimeProjection;
  readonly controllerWake?: AttemptControllerWake;
};
type ScheduleAttemptRuntimeOnce = (callback: () => void, delayMs: number) => () => void;
interface AttemptRuntimeOperations {
  readonly readIntent: typeof readLocalAttemptIntent;
  readonly inspect: typeof inspectLocalTmuxAttempt;
  readonly launch: typeof launchLocalTmuxAttempt;
  readonly reconcile: typeof reconcileLocalTmuxInspection;
}
interface AttemptRuntimeConsumerOptions {
  readonly readState: (labId: string) => RuntimeState | undefined | Promise<RuntimeState | undefined>;
  readonly resolveRunRoot: (state: RuntimeState, target: AttemptRuntimeTarget) => string | Promise<string>;
  readonly wrapperPath: string;
  readonly platform?: LocalTmuxPlatform;
  readonly scheduleOnce: ScheduleAttemptRuntimeOnce;
  readonly pendingRetryDelayMs: number;
  readonly launchSafetyDelayMs: number;
  readonly now: () => number;
  /** Apply `projection` by exact CAS, then perform `controllerWake`, before returning. */
  readonly onResult: (result: AttemptRuntimeResult) => void | Promise<void>;
  readonly onError?: (error: unknown) => void;
  /** Test seam only; production uses the existing exact runner/reconcile functions. */
  readonly operations?: Partial<AttemptRuntimeOperations>;
}
/**
 * Event-driven consumer for one exact active RunSlot edge. It owns only
 * process-local one-shot timers. Durable Attempt and RuntimeState truth remain
 * in their existing artifacts and Controller CAS projection.
 */
declare class AttemptRuntimeConsumer {
  private readonly options;
  private readonly operations;
  private readonly armed;
  private readonly tails;
  private disposed;
  constructor(options: AttemptRuntimeConsumerOptions);
  dispatch(targetInput: AttemptRuntimeTarget, edge: AttemptRuntimeExternalEdge): Promise<AttemptRuntimeResult>;
  dispose(): void;
  /** Call after dispose() and before closing RuntimeState/domain dependencies. */
  drain(): Promise<void>;
  private consumeAndPublish;
  private consume;
  private reconcileTimers;
  private arm;
  private clearArmed;
  private enqueue;
  private report;
}
//#endregion
//#region src/run-checkout.d.ts
declare const runCheckoutReceiptSchema: z.ZodObject<{
  version: z.ZodLiteral<1>;
  kind: z.ZodLiteral<"AUTOLAB_DETACHED_RUN_CHECKOUT">;
  attemptId: z.ZodString;
  candidateSha: z.ZodString;
  repositoryPath: z.ZodString;
  gitCommonDirectory: z.ZodString;
  repositoryIdentitySha256: z.ZodString;
  checkoutPath: z.ZodString;
  receiptPath: z.ZodString;
  createdAt: z.ZodNumber;
  receiptHash: z.ZodString;
}, z.core.$strict>;
type RunCheckoutReceipt = z.infer<typeof runCheckoutReceiptSchema>;
interface ProvisionDetachedRunCheckoutInput {
  readonly repositoryPath: string;
  readonly checkoutPath: string;
  readonly candidateSha: string;
  readonly attemptId: string;
  /** Defaults to a sibling file, never a file inside the clean checkout. */
  readonly receiptPath?: string;
  readonly now?: number;
}
interface DetachedRunCheckout {
  readonly checkoutPath: string;
  readonly headSha: string;
  readonly receiptPath: string;
  readonly receiptSha256: string;
  readonly receipt: RunCheckoutReceipt;
}
interface InspectDetachedRunCheckoutInput {
  readonly repositoryPath: string;
  readonly checkoutPath: string;
  readonly candidateSha: string;
  readonly attemptId: string;
  /** Exact frozen receipt path returned by provisioning. */
  readonly receiptPath: string;
  /** External hash returned by provisioning; the receipt cannot authorize itself. */
  readonly receiptSha256: string;
}
declare class RunCheckoutError extends Error {
  readonly code: 'INVALID_INPUT' | 'GIT_FAILED' | 'IO_FAILED' | 'IDENTITY_DRIFT';
  readonly name = "RunCheckoutError";
  constructor(message: string, code: 'INVALID_INPUT' | 'GIT_FAILED' | 'IO_FAILED' | 'IDENTITY_DRIFT');
}
/** Deterministic receipt location when the caller does not supply one. */
declare function runCheckoutReceiptPath(checkoutPath: string): string;
/**
 * Create one Attempt-owned detached checkout, or adopt only its exact durable
 * identity on replay. This helper never resets, cleans, removes, or overwrites.
 */
declare function provisionDetachedRunCheckout(input: ProvisionDetachedRunCheckoutInput): Promise<DetachedRunCheckout>;
/**
 * Inspect a launched Attempt's frozen checkout identity without requiring a
 * clean worktree. The experiment may legitimately create or edit files after
 * launch; repository, common-dir, exact HEAD, detached state, and receipt
 * identity remain invariant. This function is read-only.
 */
declare function inspectDetachedRunCheckout(input: InspectDetachedRunCheckoutInput): Promise<DetachedRunCheckout>;
//#endregion
//#region src/trial-artifacts.d.ts
interface FrozenTrialArtifacts {
  readonly trial: FrozenRecord<TrialContract> & {
    readonly path: string;
  };
  readonly runSlots: Readonly<Record<string, FrozenRecord<RunSlotContract> & {
    readonly path: string;
  }>>;
}
declare class TrialArtifactError extends Error {
  readonly code: 'INVALID_INPUT' | 'ARTIFACT_CONFLICT' | 'IO_FAILED';
  readonly name = "TrialArtifactError";
  constructor(message: string, code: 'INVALID_INPUT' | 'ARTIFACT_CONFLICT' | 'IO_FAILED');
}
/** Freeze one opaque Lab-authored Trial plus its minimal RunSlot contracts. */
declare function freezeTrialArtifacts(runRoot: string, value: unknown): Promise<FrozenTrialArtifacts>;
//#endregion
//#region src/attempt-launch.d.ts
interface LocalTrialRunSlotInput {
  readonly runSlotId: string;
  /** Lab-authored execution meaning. Runtime preserves it without interpretation. */
  readonly contract?: unknown;
}
interface PrepareInitialLocalAttemptInput {
  readonly frozen: FrozenRevision;
  readonly candidate: ActiveCandidate;
  readonly laneId: string;
  readonly trialId: string;
  /** Lab-authored scientific contract. Runtime preserves it without interpretation. */
  readonly trialContract: unknown;
  readonly runSlots: readonly LocalTrialRunSlotInput[];
  readonly selectedRunSlotId: string;
  readonly hostId: string;
  readonly command: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly runtimePokeFile: string;
  /** Stable time supplied from the current durable RuntimeState. */
  readonly anchoredAt: number;
}
interface PreparedInitialLocalAttempt {
  readonly artifacts: FrozenTrialArtifacts;
  readonly intent: FrozenLocalAttemptIntent;
  readonly checkout: DetachedRunCheckout;
  readonly projection: ActiveTrial;
}
interface PrepareRetryLocalAttemptInput {
  readonly frozen: FrozenRevision;
  readonly trialId: string;
  /** Exact active Trial projection from the caller's current RuntimeState. */
  readonly trial: ActiveTrial;
  readonly runSlotId: string;
  readonly hostId: string;
  readonly command: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly runtimePokeFile: string;
}
type VerifyRetryLocalAttemptReplayInput = Omit<PrepareRetryLocalAttemptInput, 'runtimePokeFile'>;
interface PreparedRetryLocalAttempt {
  readonly previous: ReadLocalAttemptIntent;
  readonly intent: FrozenLocalAttemptIntent;
  readonly checkout: DetachedRunCheckout;
  readonly projection: ActiveTrial;
}
declare class AttemptLaunchError extends Error {
  readonly code: 'IDENTITY_MISMATCH' | 'INVALID_INPUT';
  readonly name = "AttemptLaunchError";
  constructor(message: string, code: 'IDENTITY_MISMATCH' | 'INVALID_INPUT');
}
/**
 * Materialize one Controller-selected Trial and its first local Attempt before
 * the caller publishes a short RuntimeState CAS. Scientific contracts remain
 * opaque; only frozen Candidate/CURRENT/RunSlot/checkout identities are joined.
 */
declare function prepareInitialLocalAttempt(input: PrepareInitialLocalAttemptInput): Promise<PreparedInitialLocalAttempt>;
/**
 * Materialize one Controller-selected technical retry before its short CAS.
 * The prior terminal Attempt is read only through its exact active reference;
 * Trial/RunSlot/Candidate lineage is preserved and scientific content is not read.
 */
declare function prepareRetryLocalAttempt(input: PrepareRetryLocalAttemptInput): Promise<PreparedRetryLocalAttempt>;
/**
 * Verify that an already-active projection is the exact retry requested by
 * this Controller call. This is an adopt/inspect boundary only: no process is
 * launched here and no experiment artifact is opened.
 */
declare function verifyRetryLocalAttemptReplay(input: VerifyRetryLocalAttemptReplayInput): Promise<ReadLocalAttemptIntent>;
//#endregion
//#region src/roles.d.ts
declare const ROLE_KERNEL_SECTION = "autolab:role-kernel";
declare const ROLE_KERNEL_ORDER = 20;
declare const ROLE_KERNEL_VERSION = 1;
type AutoLabRoleKind = RoleBinding['role_kind'];
type RootRoleBinding = Exclude<RoleBinding, {
  role_kind: 'controller';
}>;
type RootRoleKind = RootRoleBinding['role_kind'];
interface RolePrompt<RoleKind extends AutoLabRoleKind = AutoLabRoleKind> {
  readonly id: string;
  readonly version: typeof ROLE_KERNEL_VERSION;
  readonly roleKind: RoleKind;
  readonly text: string;
  readonly sha256: string;
}
type RoleKernel = RolePrompt<RootRoleKind>;
interface RootRoleSessionSpec {
  readonly role: RootRoleBinding;
  readonly cwd: string;
  readonly kernel: RoleKernel;
}
declare class AutoLabRoleError extends Error {
  readonly code: 'ROLE_NOT_FOUND' | 'DIRECTOR_NOT_ACTIVATABLE' | 'LANE_NOT_FOUND' | 'PROMPT_HASH_MISMATCH';
  readonly name = "AutoLabRoleError";
  constructor(message: string, code: 'ROLE_NOT_FOUND' | 'DIRECTOR_NOT_ACTIVATABLE' | 'LANE_NOT_FOUND' | 'PROMPT_HASH_MISMATCH');
}
declare function rolePromptFor<Kind extends AutoLabRoleKind>(roleKind: Kind): RolePrompt<Kind>;
declare function roleKernelFor(roleKind: RootRoleKind): RoleKernel;
declare function resolveRootRoleSessionSpec(manifest: Pick<ResolvedManifest, 'roles' | 'lanes' | 'repository'>, roleId: string): RootRoleSessionSpec;
//#endregion
//#region src/binding.d.ts
declare const receiptSchema: z.ZodObject<{
  version: z.ZodLiteral<1>;
  labId: z.ZodString;
  manifestHash: z.ZodString;
  roleId: z.ZodString;
  roleKind: z.ZodEnum<{
    coder: "coder";
    method: "method";
    preflight_judge: "preflight_judge";
    postflight_judge: "postflight_judge";
    ops: "ops";
    coordinator: "coordinator";
  }>;
  sessionId: z.ZodString;
  agentPresetId: z.ZodString;
  permissionPresetId: z.ZodEnum<{
    "read-only": "read-only";
    "workspace-write": "workspace-write";
    "danger-full-access": "danger-full-access";
  }>;
  provider: z.ZodString;
  model: z.ZodString;
  cwd: z.ZodString;
  runtimeRevision: z.ZodNumber;
  issuedAt: z.ZodNumber;
  receiptHash: z.ZodString;
}, z.core.$strict>;
type RoleBindingReceipt = z.infer<typeof receiptSchema>;
interface StoredRoleBinding {
  readonly path: string;
  readonly hash: string;
  readonly receipt: RoleBindingReceipt;
}
declare class RoleBindingError extends Error {
  readonly code: 'INVALID_BINDING' | 'BINDING_CONFLICT' | 'BINDING_CORRUPT';
  readonly name = "RoleBindingError";
  constructor(message: string, code: 'INVALID_BINDING' | 'BINDING_CONFLICT' | 'BINDING_CORRUPT');
}
/** Freeze one exact role-to-Session binding before that Session is published. */
declare function freezeRoleBinding(input: {
  labDirectory: string;
  labId: string;
  manifestHash: string;
  roleId: string;
  roleKind: RootRoleKind;
  sessionId: string;
  agentPresetId: string;
  permissionPresetId: RoleBindingReceipt['permissionPresetId'];
  provider: string;
  model: string;
  cwd: string;
  runtimeRevision: number;
  issuedAt: number;
}): Promise<StoredRoleBinding>;
declare function readRoleBinding(labDirectory: string, roleId: string): Promise<StoredRoleBinding | undefined>;
//#endregion
//#region src/activation-artifacts.d.ts
interface InitialRoleArtifacts {
  readonly assignmentId: string;
  readonly assignmentPath: string;
  readonly assignmentHash: string;
  readonly objectiveBody: string;
  readonly packetPath: string;
  readonly packet: CompiledRolePacket;
}
interface FrozenPacketReference {
  readonly path: string;
  readonly hash: string;
}
interface RestoreCurrentRoleArtifactsInput {
  readonly frozen: FrozenRevision;
  readonly role: RootRoleBinding;
  readonly sessionId: string;
  readonly binding: StoredRoleBinding;
  /** The RuntimeState revision observing this Packet; Packet revision may be older. */
  readonly runtimeRevision: number;
  readonly packetRef: FrozenPacketReference;
}
declare class ActivationArtifactError extends Error {
  readonly code: 'ROLE_NOT_FOUND' | 'ARTIFACT_CONFLICT' | 'LANE_NOT_FOUND';
  readonly name = "ActivationArtifactError";
  constructor(message: string, code: 'ROLE_NOT_FOUND' | 'ARTIFACT_CONFLICT' | 'LANE_NOT_FOUND');
}
/**
 * Compile immutable bootstrap packets directly from CURRENT and built-in exact
 * texts. No model summarizes or rewrites any input on this path.
 */
declare function freezeInitialRoleArtifacts(input: {
  frozen: FrozenRevision;
  role: RootRoleBinding;
  sessionId: string;
  binding: StoredRoleBinding;
  runtimeRevision: number;
  issuedAt: number;
}): Promise<InitialRoleArtifacts>;
/**
 * Read the role's already-persisted Packet and Assignment without compiling a
 * bootstrap replacement or touching the live Fact/Evidence ledgers.
 *
 * Recompilation here is validation only: dynamic Packet fields are retained,
 * while every manifest-derived field is regenerated from CURRENT and must
 * reproduce the exact frozen Packet bytes.
 */
declare function restoreCurrentRoleArtifacts(input: RestoreCurrentRoleArtifactsInput): Promise<InitialRoleArtifacts>;
//#endregion
//#region src/approved-coder-artifacts.d.ts
interface ApprovedCoderArtifactReference {
  readonly path: string;
  readonly sha256: string;
}
interface FreezeApprovedCoderArtifactsInput {
  /** The exact revision already read and verified through CURRENT. */
  readonly frozen: FrozenRevision;
  readonly coderRole: RootRoleBinding;
  readonly coderSessionId: string;
  readonly coderBinding: StoredRoleBinding;
  readonly sourceMethodPacket: ApprovedCoderArtifactReference;
  readonly designTicket: ApprovedCoderArtifactReference;
  readonly preflightVerdict: ApprovedCoderArtifactReference;
  readonly reviewId: string;
  readonly runtimeRevision: number;
  readonly issuedAt: number;
}
declare class ApprovedCoderArtifactError extends Error {
  readonly code: 'INVALID_INPUT' | 'CURRENT_MISMATCH' | 'CODER_BINDING_MISMATCH' | 'SOURCE_PACKET_MISMATCH' | 'DESIGN_TICKET_MISMATCH' | 'PREFLIGHT_VERDICT_MISMATCH' | 'ARTIFACT_CONFLICT';
  readonly name = "ApprovedCoderArtifactError";
  constructor(message: string, code: 'INVALID_INPUT' | 'CURRENT_MISMATCH' | 'CODER_BINDING_MISMATCH' | 'SOURCE_PACKET_MISMATCH' | 'DESIGN_TICKET_MISMATCH' | 'PREFLIGHT_VERDICT_MISMATCH' | 'ARTIFACT_CONFLICT');
}
/**
 * Compile the exact APPROVED Preflight transition into one immutable Coder
 * Assignment and Role Packet. This is a byte/hash compiler only: it never asks
 * a model to summarize the Ticket or introduces another admission decision.
 */
declare function freezeApprovedCoderArtifacts(input: FreezeApprovedCoderArtifactsInput): Promise<InitialRoleArtifacts>;
//#endregion
//#region src/goal.d.ts
interface LocalGoalIntentInput {
  readonly installId: string;
  readonly assignmentId: string;
  readonly packetPath: string;
  readonly packetHash: string;
  readonly body: string;
  readonly maxGoalRounds: number;
  readonly expectedGoalRef: GoalRef | null;
}
/** The exact, caller-persisted intent installed into one local Session. */
interface LocalGoalInstallIntent extends LocalGoalIntentInput {
  readonly objective: string;
  readonly objectiveHash: string;
}
interface LocalGoalInstallResult {
  readonly outcome: 'applied' | 'already-applied' | 'already-complete';
  readonly ref: GoalRef;
  readonly objectiveHash: string;
  readonly roundsStarted: number;
}
interface LocalGoalHold {
  /** Release this process-local fallback barrier. Safe to call more than once. */
  release(): Promise<void>;
}
interface LocalGoalPauseResult {
  readonly outcome: 'paused' | 'already-applied' | 'no-active-goal';
  readonly ref?: GoalRef;
  /** Review barrier claimed after the durable Goal pause, when a turn was still active. */
  readonly hold?: LocalGoalHold;
}
interface LocalReviewHoldResult {
  readonly outcome: 'held' | 'not-required' | 'user-override';
  readonly hold?: LocalGoalHold;
}
declare class LocalGoalError extends Error {
  readonly code: 'SESSION_NOT_LOCAL' | 'DURABILITY_UNAVAILABLE' | 'INVALID_INTENT' | 'STALE_GOAL' | 'ROUND_BUDGET_EXHAUSTED' | 'SESSION_BUSY' | 'INVALID_TURN' | 'HOLD_RELEASED';
  readonly name = "LocalGoalError";
  constructor(message: string, code: 'SESSION_NOT_LOCAL' | 'DURABILITY_UNAVAILABLE' | 'INVALID_INTENT' | 'STALE_GOAL' | 'ROUND_BUDGET_EXHAUSTED' | 'SESSION_BUSY' | 'INVALID_TURN' | 'HOLD_RELEASED');
}
/**
 * Deterministically compile the short Goal payload before the Controller
 * persists its install intent. The full Lab specification remains in the
 * immutable packet; it is deliberately not copied into every Goal round.
 */
declare function compileLocalGoalIntent(input: LocalGoalIntentInput): LocalGoalInstallIntent;
/** Install or adopt one exact Assignment Goal on an Agent live in this process. */
declare function installLocalGoal(ctx: Context, sessionId: string, intent: LocalGoalInstallIntent): Promise<LocalGoalInstallResult>;
/**
 * Durably pause the current local Goal, then claim the native maintenance
 * phase only when an observed Agent turn still needs the review fallback.
 */
declare function pauseLocalGoal(ctx: Context, sessionId: string, signal?: AbortSignal): Promise<LocalGoalPauseResult>;
/**
 * Claim the narrow review fallback barrier for one exact Session. This is
 * event-driven and deliberately bounded: one observed turn cancellation, one
 * join after a claim race, and one retry. A continuously user-driven Session
 * is reported as an override instead of being cancelled in a loop.
 */
declare function acquireLocalReviewHold(ctx: Context, sessionId: string, expectedTurn: number, signal?: AbortSignal): Promise<LocalReviewHoldResult>;
/** Return the exact currently open durable turn, never merely Agent `running`. */
declare function observeOpenAgentTurn(agent: Agent): number | undefined;
/**
 * Stop only automatic Goal continuation. Used by `/autolab pause`: it never
 * cancels the current LLM turn and never acquires a maintenance barrier.
 */
declare function pauseLocalGoalContinuation(ctx: Context, sessionId: string): Promise<LocalGoalPauseResult>;
//#endregion
//#region src/approved-coder-activation.d.ts
interface ApprovedCoderActivationPlan {
  readonly reviewId: string;
  readonly coderRoleId: string;
  readonly coderSessionId: string;
  readonly packet: {
    readonly path: string;
    readonly hash: string;
  };
  readonly goalIntent: LocalGoalInstallIntent;
  /** Recorded only after the exact Goal effect has been durably projected. */
  readonly resolution: ReviewResolutionState;
}
interface PreparedApprovedCoderActivation extends ApprovedCoderActivationPlan {
  readonly artifacts: InitialRoleArtifacts;
}
interface FreezeApprovedCoderActivationInput {
  readonly artifacts: FreezeApprovedCoderArtifactsInput;
  readonly maxGoalRounds: number;
  readonly expectedGoalRef: GoalRef | null;
  /** Optional only for adopting an already-persisted activation identity. */
  readonly installId?: string;
}
interface CompileApprovedCoderActivationInput {
  readonly reviewId: string;
  readonly verdictHash: string;
  readonly coderRoleId: string;
  readonly coderSessionId: string;
  readonly assignmentId: string;
  readonly packetPath: string;
  readonly packetHash: string;
  readonly objectiveBody: string;
  readonly maxGoalRounds: number;
  readonly expectedGoalRef: GoalRef | null;
  readonly installId?: string;
}
declare class ApprovedCoderActivationError extends Error {
  readonly code: 'IDENTITY_MISMATCH' | 'ACTIVATION_CONFLICT' | 'GOAL_ALREADY_COMPLETE';
  readonly name = "ApprovedCoderActivationError";
  constructor(message: string, code: 'IDENTITY_MISMATCH' | 'ACTIVATION_CONFLICT' | 'GOAL_ALREADY_COMPLETE');
}
/**
 * Freeze the exact APPROVED Method/Preflight inputs, then compile the one Coder
 * Goal identity. The caller has already selected this review; this function
 * performs no comparison, promotion, or scientific routing.
 */
declare function freezeApprovedCoderActivation(input: FreezeApprovedCoderActivationInput): Promise<PreparedApprovedCoderActivation>;
/** Compile the deterministic control identities after immutable artifacts exist. */
declare function compileApprovedCoderActivation(input: CompileApprovedCoderActivationInput): ApprovedCoderActivationPlan;
/**
 * Build the short CAS projection that must precede the native Goal mutation.
 * Exact retries are no-ops; a different in-flight activation is not overwritten.
 */
declare function stageApprovedCoderActivation(role: RoleState, plan: ApprovedCoderActivationPlan): RoleState;
/** Install or adopt the exact Goal after the activating projection is durable. */
declare function installApprovedCoderGoal(ctx: Context, plan: ApprovedCoderActivationPlan): Promise<LocalGoalInstallResult>;
/** Build the second CAS projection after the native Goal mutation is durable. */
declare function applyApprovedCoderGoal(role: RoleState, plan: ApprovedCoderActivationPlan, result: LocalGoalInstallResult): RoleState;
/**
 * Record the already-applied Goal effect against the ready APPROVED review.
 * The process-local review hold may be released only after this projection is
 * durably committed by the caller.
 */
declare function resolveApprovedCoderReview(review: ActiveReview, ownerEpoch: string, plan: ApprovedCoderActivationPlan, updatedAt: number): ActiveReview;
//#endregion
//#region src/candidate.d.ts
interface CandidateCaptureBody {
  readonly version: 1;
  readonly labId: string;
  readonly sourceRevision: number;
  readonly manifestHash: string;
  readonly runtimeRevision: number;
  readonly laneId: string;
  readonly candidateId: string;
  readonly coderRoleId: string;
  readonly coderSessionId: string;
  readonly assignmentId: string;
  readonly assignmentHash: string;
  readonly worktreeReceiptHash: string;
  readonly worktreePath: string;
  readonly baseSha: string;
  readonly sourceHeadSha: string;
  readonly treeSha: string;
  readonly capturedAt: number;
  readonly sourceReport?: CandidateSnapshotReference;
}
interface CandidateCaptureIntent extends CandidateCaptureBody {
  readonly captureHash: string;
}
interface CandidateSnapshotReceiptBody extends CandidateCaptureBody {
  readonly captureHash: string;
  readonly gitRef: string;
  readonly candidateSha: string;
}
interface CandidateSnapshotReceipt extends CandidateSnapshotReceiptBody {
  readonly receiptHash: string;
}
interface CandidateSnapshotReference {
  readonly path: string;
  readonly hash: string;
}
interface FreezeLaneCandidateInput {
  readonly labId: string;
  readonly sourceRevision: number;
  readonly manifestHash: string;
  readonly runtimeRevision: number;
  readonly laneId: string;
  readonly candidateId: string;
  readonly coderRoleId: string;
  readonly coderSessionId: string;
  readonly assignmentId: string;
  readonly assignmentHash: string;
  readonly labDirectory: string;
  readonly expectedWorktreePath: string;
  readonly expectedWorktreeReceiptHash: string;
  readonly expectedBaseSha: string;
  readonly sourceReport?: CandidateSnapshotReference;
  readonly now?: number;
}
declare class CandidateSnapshotError extends Error {
  readonly code: 'INVALID_INPUT' | 'WORKTREE_MISMATCH' | 'CAPTURE_CONFLICT' | 'GIT_FAILED' | 'RECEIPT_CORRUPT' | 'IO_FAILED';
  readonly name = "CandidateSnapshotError";
  constructor(message: string, code: 'INVALID_INPUT' | 'WORKTREE_MISMATCH' | 'CAPTURE_CONFLICT' | 'GIT_FAILED' | 'RECEIPT_CORRUPT' | 'IO_FAILED');
}
/**
 * Freeze the current Lane bytes as a synthetic Git commit without changing the
 * worktree or its real index. Runtime records only Git and Assignment identity;
 * it does not inspect the scientific meaning of the diff or report.
 */
declare function freezeLaneCandidate(input: FreezeLaneCandidateInput): Promise<CandidateSnapshotReceipt>;
declare function candidateReceiptPath(labDirectory: string, assignmentId: string): string;
/** Controller-owned immutable copy of the small Coder report. */
declare function candidateFrozenReportPath(labDirectory: string, assignmentId: string): string;
declare function readCandidateSnapshotReceipt(reference: CandidateSnapshotReference): Promise<CandidateSnapshotReceipt>;
/** On-demand utility for a Session; Runtime never turns this into a Gate. */
declare function readCandidateChangedPaths(receipt: CandidateSnapshotReceipt): Promise<readonly string[]>;
//#endregion
//#region src/candidate-recovery.d.ts
interface VerifiedActiveCandidate {
  readonly snapshot: CandidateSnapshotReceipt;
}
declare class CandidateRecoveryError extends Error {
  readonly code: 'IDENTITY_MISMATCH' | 'IO_FAILED';
  readonly name = "CandidateRecoveryError";
  constructor(message: string, code?: 'IDENTITY_MISMATCH' | 'IO_FAILED');
}
/**
 * Reconcile only candidate identity. Scientific fidelity, changed paths and the
 * meaning of the Coder report belong to the relevant Sessions.
 */
declare function verifyActiveCandidateProjection(input: {
  readonly frozen: FrozenRevision;
  readonly state: RuntimeState;
  readonly laneId: string;
}): Promise<VerifiedActiveCandidate>;
//#endregion
//#region src/coder-receipt.d.ts
/** The complete model-facing contract. `content` is opaque JSON to Runtime. */
declare const coderImplementationReportSchema: z.ZodObject<{
  schema_version: z.ZodLiteral<1>;
  content: z.ZodJSONSchema;
}, z.core.$strict>;
/** Runtime-authored receipt containing only mechanical identity bindings. */
declare const coderImplementationReceiptSchema: z.ZodObject<{
  schema_version: z.ZodLiteral<1>;
  lab_id: z.ZodString;
  source_revision: z.ZodNumber;
  lane_id: z.ZodString;
  coder: z.ZodObject<{
    role_id: z.ZodString;
    session_id: z.ZodString;
  }, z.core.$strict>;
  assignment: z.ZodObject<{
    assignment_id: z.ZodString;
    assignment_contract_sha256: z.ZodString;
  }, z.core.$strict>;
  role_packet: z.ZodObject<{
    path: z.ZodString;
    sha256: z.ZodString;
  }, z.core.$strict>;
  design_ticket: z.ZodObject<{
    path: z.ZodString;
    sha256: z.ZodString;
    candidate_id: z.ZodString;
  }, z.core.$strict>;
  preflight_verdict: z.ZodObject<{
    path: z.ZodString;
    sha256: z.ZodString;
    review_id: z.ZodString;
  }, z.core.$strict>;
  source_worktree: z.ZodObject<{
    path: z.ZodString;
    receipt_path: z.ZodString;
    receipt_sha256: z.ZodString;
  }, z.core.$strict>;
  candidate_sha: z.ZodString;
  source_report: z.ZodObject<{
    path: z.ZodString;
    sha256: z.ZodString;
  }, z.core.$strict>;
}, z.core.$strict>;
type CoderImplementationReceipt = z.infer<typeof coderImplementationReceiptSchema>;
type CoderImplementationReport = z.infer<typeof coderImplementationReportSchema>;
type JsonValue$1 = null | boolean | number | string | JsonValue$1[] | {
  [key: string]: JsonValue$1;
};
/** JSON Schema for the Runtime-authored immutable receipt. */
declare function coderImplementationReceiptOutputSchema(): JsonValue$1;
/** JSON Schema installed as the Coder's model-facing output contract. */
declare function coderImplementationReportOutputSchema(): JsonValue$1;
interface CoderReceiptArtifactReference {
  readonly path: string;
  readonly sha256: string;
}
interface ExpectedCoderImplementationAnchors {
  readonly labId: string;
  readonly sourceRevision: number;
  readonly laneId: string;
  readonly coderRoleId: string;
  readonly coderSessionId: string;
  readonly assignmentId: string;
  readonly assignmentContractSha256: string;
  readonly rolePacket: CoderReceiptArtifactReference;
  readonly designTicket: CoderReceiptArtifactReference & {
    readonly candidateId: string;
  };
  readonly preflightVerdict: CoderReceiptArtifactReference & {
    readonly reviewId: string;
  };
  readonly sourceWorktree: {
    readonly path: string;
    readonly receiptPath: string;
    readonly receiptSha256: string;
  };
  readonly candidateSha: string;
}
interface FreezeCoderImplementationReceiptInput {
  /** A small, already-compiled Runtime receipt. */
  readonly sourceReceiptPath: string;
  /** Controller-owned immutable destination. */
  readonly artifactPath: string;
  readonly expected: ExpectedCoderImplementationAnchors;
  /** Trusted reference to the opaque model report bound by the receipt. */
  readonly sourceReport: CoderReceiptArtifactReference;
}
interface FreezeCompiledCoderImplementationReceiptInput {
  /** Small model-authored report selected by the current Role Packet. */
  readonly sourceReportPath: string;
  /** Hash observed at candidate capture; closes report/candidate TOCTOU. */
  readonly sourceReportSha256: string;
  /** Controller-owned immutable final receipt destination. */
  readonly artifactPath: string;
  readonly expected: ExpectedCoderImplementationAnchors;
}
interface FrozenCoderImplementationReceipt {
  readonly sourceReceiptPath: string;
  readonly artifactPath: string;
  readonly artifactHash: string;
  readonly receiptBytes: Buffer;
  readonly receipt: CoderImplementationReceipt;
}
interface ReadCoderImplementationReport {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: Buffer;
  readonly report: CoderImplementationReport;
}
declare class CoderReceiptError extends Error {
  readonly code: 'INVALID_INPUT' | 'RECEIPT_READ_FAILED' | 'INVALID_RECEIPT' | 'ANCHOR_MISMATCH' | 'ARTIFACT_WRITE_FAILED' | 'ARTIFACT_CONFLICT' | 'HASH_MISMATCH' | 'IO_FAILED';
  readonly issues: readonly z.core.$ZodIssue[];
  readonly name = "CoderReceiptError";
  constructor(message: string, code: 'INVALID_INPUT' | 'RECEIPT_READ_FAILED' | 'INVALID_RECEIPT' | 'ANCHOR_MISMATCH' | 'ARTIFACT_WRITE_FAILED' | 'ARTIFACT_CONFLICT' | 'HASH_MISMATCH' | 'IO_FAILED', issues?: readonly z.core.$ZodIssue[]);
}
declare function parseCoderImplementationReceipt(value: unknown): CoderImplementationReceipt;
declare function parseCoderImplementationReport(value: unknown): CoderImplementationReport;
declare function readCoderImplementationReport(path: string): Promise<ReadCoderImplementationReport>;
/** Combine trusted anchors with only the opaque report's exact path/hash. */
declare function compileCoderImplementationReceipt(input: {
  readonly expected: ExpectedCoderImplementationAnchors;
  readonly sourceReport: CoderReceiptArtifactReference;
}): CoderImplementationReceipt;
/**
 * Preserve exact valid Runtime-receipt bytes at one immutable destination.
 * Exact replay adopts the existing file; different bytes never overwrite it.
 * No referenced report or experiment file is opened by this path.
 */
declare function freezeCoderImplementationReceipt(input: FreezeCoderImplementationReceiptInput): Promise<FrozenCoderImplementationReceipt>;
/**
 * Preferred Runtime path: validate only the report's two-field envelope, bind
 * its exact path/hash to trusted identities, and publish a canonical receipt.
 * `report.content` is never interpreted and no path inside it is accessed.
 */
declare function freezeCompiledCoderImplementationReceipt(input: FreezeCompiledCoderImplementationReceiptInput): Promise<FrozenCoderImplementationReceipt>;
/** Read one exact immutable receipt through its path and SHA-256 reference. */
declare function readCoderImplementationReceipt(reference: CoderReceiptArtifactReference): Promise<FrozenCoderImplementationReceipt>;
//#endregion
//#region src/coder-submission.d.ts
interface CoderSubmissionArtifactReference {
  readonly path: string;
  readonly hash: string;
}
interface FreezeApprovedCoderSubmissionInput {
  readonly frozen: FrozenRevision;
  readonly coderRole: RootRoleBinding;
  readonly coderSessionId: string;
  readonly coderBinding: StoredRoleBinding;
  readonly coderPacket: CoderSubmissionArtifactReference;
  readonly expectedAssignmentId: string;
  readonly reviewId: string;
  readonly sourceMethodPacket: CoderSubmissionArtifactReference;
  readonly designTicket: CoderSubmissionArtifactReference;
  readonly preflightVerdict: CoderSubmissionArtifactReference;
  readonly runtimeRevision: number;
}
/** A frozen submission is identity-only; later Sessions decide what it means. */
interface FrozenApprovedCoderSubmission {
  readonly laneId: string;
  readonly candidateId: string;
  readonly reviewId: string;
  readonly assignment: InitialRoleArtifacts;
  readonly reportPath: string;
  readonly reportHash: string;
  readonly candidatePath: string;
  readonly candidateHash: string;
  readonly candidate: CandidateSnapshotReceipt;
  readonly implementation: FrozenCoderImplementationReceipt;
}
declare class CoderSubmissionError extends Error {
  readonly code: 'INVALID_INPUT' | 'ASSIGNMENT_MISMATCH' | 'REVIEW_MISMATCH' | 'WORKTREE_MISMATCH' | 'ARTIFACT_MISMATCH';
  readonly name = "CoderSubmissionError";
  constructor(message: string, code: 'INVALID_INPUT' | 'ASSIGNMENT_MISMATCH' | 'REVIEW_MISMATCH' | 'WORKTREE_MISMATCH' | 'ARTIFACT_MISMATCH');
}
/**
 * Freeze the exact current Coder report and Lane candidate, then bind their
 * mechanical identities. Runtime validates the report envelope but never
 * interprets `content` or follows any path inside it.
 */
declare function freezeApprovedCoderSubmission(input: FreezeApprovedCoderSubmissionInput): Promise<FrozenApprovedCoderSubmission>;
//#endregion
//#region src/communication.d.ts
type AutoLabRevealState = 'sealed' | 'revealed';
/** The exact live root Agent used by the messaging provider as ACL principal. */
interface CommunicationRoleSession {
  readonly roleId: string;
  readonly agent: Agent;
  /** Required for every Controller-created role; Controller is bound by the manifest. */
  readonly binding?: StoredRoleBinding;
}
/** A live intended role identity that is not yet safe to admit to the Lab ACL. */
interface CommunicationQuarantineSession {
  readonly roleId: string;
  readonly agent: Agent;
}
interface CommunicationRolePolicy {
  readonly roleId: string;
  readonly roleKind: RoleBinding['role_kind'];
  readonly sessionId: string;
  readonly agent: Agent;
  readonly sendAllowed: boolean;
  readonly receiveAllowed: boolean;
}
interface CommunicationTextPairPolicy {
  readonly firstRoleId: string;
  readonly secondRoleId: string;
  readonly firstSessionId: string;
  readonly secondSessionId: string;
  readonly blocked: boolean;
}
interface CommunicationAclPlan {
  readonly labId: string;
  readonly manifestHash: string;
  readonly aclRevision: number;
  readonly revealState: AutoLabRevealState;
  readonly roles: readonly CommunicationRolePolicy[];
  /** Complete Lab-internal free-text matrix. It never grants typed control. */
  readonly textPairs: readonly CommunicationTextPairPolicy[];
}
/** Narrow structural seam implemented by dsh-local-session-messaging. */
interface CommunicationAclMessaging {
  getPermissions(caller: Agent, signal?: AbortSignal): Promise<{
    readonly sessionId: unknown;
    readonly sendAllowed: boolean;
    readonly receiveAllowed: boolean;
  }>;
  setPermissions(caller: Agent, patch: {
    readonly sendAllowed?: boolean;
    readonly receiveAllowed?: boolean;
  }, signal?: AbortSignal): Promise<{
    readonly sessionId: unknown;
    readonly sendAllowed: boolean;
    readonly receiveAllowed: boolean;
  }>;
  listBlockedPeers(caller: Agent, signal?: AbortSignal): Promise<readonly {
    readonly sessionId: unknown;
  }[]>;
  setPeerBlocked(caller: Agent, recipient: string, blocked: boolean, signal?: AbortSignal): Promise<unknown>;
}
interface ReconcileCommunicationAclInput {
  readonly manifest: ResolvedManifest;
  readonly revealState: AutoLabRevealState;
  readonly roleSessions: readonly CommunicationRoleSession[];
  readonly messaging: CommunicationAclMessaging;
  /**
   * Recovery-only mode. Attached roles are still checked against their exact
   * Manifest/binding identity; omitted live roles are disabled before any
   * permissive mutation. The default remains a complete, strict role set.
   */
  readonly allowPartial?: boolean;
  readonly quarantineSessions?: readonly CommunicationQuarantineSession[];
  /**
   * Recovery may run while the user-owned Controller Session is offline. Its
   * direction policy is invariantly enabled by Manifest validation; symmetric
   * Lab pair edges are then reconciled from the live worker endpoint.
   */
  readonly controllerOffline?: boolean;
  readonly signal?: AbortSignal;
}
interface CommunicationAclReconcileResult {
  readonly plan: CommunicationAclPlan;
  readonly permissionUpdates: number;
  readonly textPairUpdates: number;
}
declare class CommunicationAclError extends Error {
  readonly code: 'ROLE_BINDING_MISMATCH' | 'ACL_OBSERVATION_MISMATCH' | 'ACL_READ_FAILED' | 'ACL_APPLY_FAILED';
  readonly name = "CommunicationAclError";
  constructor(message: string, code: 'ROLE_BINDING_MISMATCH' | 'ACL_OBSERVATION_MISMATCH' | 'ACL_READ_FAILED' | 'ACL_APPLY_FAILED', options?: ErrorOptions);
}
/** Compile only from one validated, committed Manifest and its frozen role bindings. */
declare function compileCommunicationAcl(input: {
  readonly manifest: ResolvedManifest;
  readonly revealState: AutoLabRevealState;
  readonly roleSessions: readonly CommunicationRoleSession[];
  readonly allowPartial?: boolean;
}): CommunicationAclPlan;
/**
 * Event-driven, idempotent projection onto the existing messaging provider.
 * Tightening finishes before any widening, so a failed run never continues by
 * opening another edge. A later call re-reads provider state and resumes safely.
 */
declare function reconcileCommunicationAcl(input: ReconcileCommunicationAclInput): Promise<CommunicationAclReconcileResult>;
//#endregion
//#region src/config.d.ts
/**
 * Human/Controller-authored machine projection. Runtime identities and hashes are
 * deliberately absent; resolveDraftLabConfig injects only mechanically observed
 * values at commit time.
 */
declare const draftLabConfigSchema: z.ZodObject<{
  schema_version: z.ZodLiteral<1>;
  repository: z.ZodObject<{
    path: z.ZodString;
    base_ref: z.ZodString;
  }, z.core.$strict>;
  worktree_root: z.ZodString;
  research: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
  contract: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
  search: z.ZodObject<{
    search_mode: z.ZodEnum<{
      sequential: "sequential";
      cohort: "cohort";
    }>;
    research_route_authority: z.ZodOptional<z.ZodEnum<{
      autolab: "autolab";
      user: "user";
    }>>;
    coordinator_enabled: z.ZodBoolean;
    lanes: z.ZodArray<z.ZodObject<{
      lane_id: z.ZodString;
      worktree_path: z.ZodString;
      base_ref: z.ZodString;
      method_role_id: z.ZodString;
      coder_role_id: z.ZodString;
      preflight_judge_role_id: z.ZodString;
      postflight_judge_role_id: z.ZodString;
      charter: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
    }, z.core.$strict>>;
  }, z.core.$strict>;
  roles: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
    role_kind: z.ZodLiteral<"controller">;
    max_goal_rounds: z.ZodNumber;
    role_id: z.ZodString;
    model_route: z.ZodObject<{
      route_id: z.ZodString;
      provider: z.ZodString;
      model: z.ZodString;
      config: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
    }, z.core.$strict>;
    fallback_routes: z.ZodArray<z.ZodObject<{
      route_id: z.ZodString;
      provider: z.ZodString;
      model: z.ZodString;
      config: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
    }, z.core.$strict>>;
    dsh_preset: z.ZodEnum<{
      "read-only": "read-only";
      "workspace-write": "workspace-write";
      "danger-full-access": "danger-full-access";
    }>;
    reasoning: z.ZodObject<{
      mode: z.ZodString;
      config: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
    }, z.core.$strict>;
    allowed_tools: z.ZodArray<z.ZodString>;
  }, z.core.$strict>, z.ZodObject<{
    role_kind: z.ZodLiteral<"method">;
    max_goal_rounds: z.ZodNumber;
    lane_id: z.ZodString;
    prebound_session_id: z.ZodOptional<z.ZodString>;
    role_id: z.ZodString;
    model_route: z.ZodObject<{
      route_id: z.ZodString;
      provider: z.ZodString;
      model: z.ZodString;
      config: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
    }, z.core.$strict>;
    fallback_routes: z.ZodArray<z.ZodObject<{
      route_id: z.ZodString;
      provider: z.ZodString;
      model: z.ZodString;
      config: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
    }, z.core.$strict>>;
    dsh_preset: z.ZodEnum<{
      "read-only": "read-only";
      "workspace-write": "workspace-write";
      "danger-full-access": "danger-full-access";
    }>;
    reasoning: z.ZodObject<{
      mode: z.ZodString;
      config: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
    }, z.core.$strict>;
    allowed_tools: z.ZodArray<z.ZodString>;
  }, z.core.$strict>, z.ZodObject<{
    role_kind: z.ZodLiteral<"coder">;
    max_goal_rounds: z.ZodNumber;
    lane_id: z.ZodString;
    prebound_session_id: z.ZodOptional<z.ZodString>;
    role_id: z.ZodString;
    model_route: z.ZodObject<{
      route_id: z.ZodString;
      provider: z.ZodString;
      model: z.ZodString;
      config: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
    }, z.core.$strict>;
    fallback_routes: z.ZodArray<z.ZodObject<{
      route_id: z.ZodString;
      provider: z.ZodString;
      model: z.ZodString;
      config: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
    }, z.core.$strict>>;
    dsh_preset: z.ZodEnum<{
      "read-only": "read-only";
      "workspace-write": "workspace-write";
      "danger-full-access": "danger-full-access";
    }>;
    reasoning: z.ZodObject<{
      mode: z.ZodString;
      config: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
    }, z.core.$strict>;
    allowed_tools: z.ZodArray<z.ZodString>;
  }, z.core.$strict>, z.ZodObject<{
    role_kind: z.ZodLiteral<"preflight_judge">;
    lane_id: z.ZodString;
    prebound_session_id: z.ZodOptional<z.ZodString>;
    role_id: z.ZodString;
    model_route: z.ZodObject<{
      route_id: z.ZodString;
      provider: z.ZodString;
      model: z.ZodString;
      config: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
    }, z.core.$strict>;
    fallback_routes: z.ZodArray<z.ZodObject<{
      route_id: z.ZodString;
      provider: z.ZodString;
      model: z.ZodString;
      config: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
    }, z.core.$strict>>;
    dsh_preset: z.ZodEnum<{
      "read-only": "read-only";
      "workspace-write": "workspace-write";
      "danger-full-access": "danger-full-access";
    }>;
    reasoning: z.ZodObject<{
      mode: z.ZodString;
      config: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
    }, z.core.$strict>;
    allowed_tools: z.ZodArray<z.ZodString>;
  }, z.core.$strict>, z.ZodObject<{
    role_kind: z.ZodLiteral<"postflight_judge">;
    lane_id: z.ZodString;
    prebound_session_id: z.ZodOptional<z.ZodString>;
    role_id: z.ZodString;
    model_route: z.ZodObject<{
      route_id: z.ZodString;
      provider: z.ZodString;
      model: z.ZodString;
      config: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
    }, z.core.$strict>;
    fallback_routes: z.ZodArray<z.ZodObject<{
      route_id: z.ZodString;
      provider: z.ZodString;
      model: z.ZodString;
      config: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
    }, z.core.$strict>>;
    dsh_preset: z.ZodEnum<{
      "read-only": "read-only";
      "workspace-write": "workspace-write";
      "danger-full-access": "danger-full-access";
    }>;
    reasoning: z.ZodObject<{
      mode: z.ZodString;
      config: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
    }, z.core.$strict>;
    allowed_tools: z.ZodArray<z.ZodString>;
  }, z.core.$strict>, z.ZodObject<{
    role_kind: z.ZodLiteral<"ops">;
    max_goal_rounds: z.ZodNumber;
    resource_domain: z.ZodString;
    prebound_session_id: z.ZodOptional<z.ZodString>;
    role_id: z.ZodString;
    model_route: z.ZodObject<{
      route_id: z.ZodString;
      provider: z.ZodString;
      model: z.ZodString;
      config: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
    }, z.core.$strict>;
    fallback_routes: z.ZodArray<z.ZodObject<{
      route_id: z.ZodString;
      provider: z.ZodString;
      model: z.ZodString;
      config: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
    }, z.core.$strict>>;
    dsh_preset: z.ZodEnum<{
      "read-only": "read-only";
      "workspace-write": "workspace-write";
      "danger-full-access": "danger-full-access";
    }>;
    reasoning: z.ZodObject<{
      mode: z.ZodString;
      config: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
    }, z.core.$strict>;
    allowed_tools: z.ZodArray<z.ZodString>;
  }, z.core.$strict>, z.ZodObject<{
    role_kind: z.ZodLiteral<"coordinator">;
    max_goal_rounds: z.ZodNumber;
    prebound_session_id: z.ZodOptional<z.ZodString>;
    role_id: z.ZodString;
    model_route: z.ZodObject<{
      route_id: z.ZodString;
      provider: z.ZodString;
      model: z.ZodString;
      config: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
    }, z.core.$strict>;
    fallback_routes: z.ZodArray<z.ZodObject<{
      route_id: z.ZodString;
      provider: z.ZodString;
      model: z.ZodString;
      config: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
    }, z.core.$strict>>;
    dsh_preset: z.ZodEnum<{
      "read-only": "read-only";
      "workspace-write": "workspace-write";
      "danger-full-access": "danger-full-access";
    }>;
    reasoning: z.ZodObject<{
      mode: z.ZodString;
      config: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
    }, z.core.$strict>;
    allowed_tools: z.ZodArray<z.ZodString>;
  }, z.core.$strict>], "role_kind">>;
  execution: z.ZodObject<{
    runner_adapter: z.ZodObject<{
      id: z.ZodString;
      version: z.ZodString;
      sha256: z.ZodString;
    }, z.core.$strict>;
    hosts: z.ZodArray<z.ZodObject<{
      host_id: z.ZodString;
      runner_target: z.ZodString;
    }, z.core.$strict>>;
    gpu_pool: z.ZodArray<z.ZodObject<{
      gpu_id: z.ZodString;
      host_id: z.ZodString;
    }, z.core.$strict>>;
    max_parallel_gpu_attempts: z.ZodNumber;
    run_root: z.ZodOptional<z.ZodString>;
    contract: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
  }, z.core.$strict>;
  evidence: z.ZodObject<{
    artifact_root: z.ZodOptional<z.ZodString>;
    contract: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
  }, z.core.$strict>;
  communication: z.ZodObject<{
    topology: z.ZodEnum<{
      lane_isolated: "lane_isolated";
      coordinated: "coordinated";
    }>;
    acl_revision: z.ZodNumber;
    coordinator_visibility: z.ZodEnum<{
      revealed: "revealed";
      disabled: "disabled";
      runtime_only: "runtime_only";
      global: "global";
    }>;
    role_permissions: z.ZodArray<z.ZodObject<{
      role_id: z.ZodString;
      send: z.ZodBoolean;
      receive: z.ZodBoolean;
    }, z.core.$strict>>;
    text_method_coder_within_lane: z.ZodEnum<{
      blocked: "blocked";
      allowed: "allowed";
    }>;
    text_pair_blocks: z.ZodArray<z.ZodObject<{
      role_ids: z.ZodTuple<[z.ZodString, z.ZodString], null>;
      active_when: z.ZodEnum<{
        before_reveal: "before_reveal";
        after_reveal: "after_reveal";
        always: "always";
      }>;
    }, z.core.$strict>>;
    reveal_policy: z.ZodObject<{
      initial_state: z.ZodEnum<{
        sealed: "sealed";
        revealed: "revealed";
      }>;
      trigger: z.ZodEnum<{
        manual: "manual";
        cohort_barrier: "cohort_barrier";
        immediate: "immediate";
      }>;
      text_cross_lane_before_reveal: z.ZodEnum<{
        blocked: "blocked";
        allowed: "allowed";
      }>;
      text_cross_lane_after_reveal: z.ZodEnum<{
        blocked: "blocked";
        allowed: "allowed";
      }>;
    }, z.core.$strict>;
    api_recovery: z.ZodString;
    attempt_recovery: z.ZodString;
    stop_pause_policy: z.ZodString;
  }, z.core.$strict>;
  provenance: z.ZodRecord<z.ZodString, z.ZodString>;
}, z.core.$strict>;
declare const resolutionSchema: z.ZodObject<{
  lab_id: z.ZodString;
  revision: z.ZodNumber;
  controller_session_id: z.ZodString;
  dialogue_head_sha256: z.ZodString;
  lab_spec_sha256: z.ZodString;
  lab_yaml_sha256: z.ZodString;
  lab_directory: z.ZodString;
  autolab_plugin_version: z.ZodString;
  dsh_version: z.ZodString;
  repository_base_sha: z.ZodString;
  lane_base_shas: z.ZodRecord<z.ZodString, z.ZodString>;
  role_prompt_sha256: z.ZodRecord<z.ZodString, z.ZodString>;
}, z.core.$strict>;
type DraftLabConfig = z.infer<typeof draftLabConfigSchema>;
type LabConfigResolution = z.infer<typeof resolutionSchema>;
declare class LabConfigError extends Error {
  readonly name = "LabConfigError";
  readonly code = "INVALID_LAB_CONFIG";
  constructor(message: string);
}
declare function parseDraftLabConfig(value: unknown): DraftLabConfig;
declare function parseDraftLabYaml(text: string): DraftLabConfig;
declare function resolveDraftLabConfig(configValue: unknown, resolutionValue: LabConfigResolution): ResolvedManifest;
//#endregion
//#region src/lock.d.ts
interface ControllerOwner {
  readonly version: 1;
  readonly token: string;
  readonly pid: number;
  readonly processStartId: string;
  readonly hostname: string;
  readonly acquiredAt: number;
}
interface RuntimeLock {
  readonly path: string;
  readonly owner: ControllerOwner;
  release(): Promise<void>;
}
declare class RuntimeLockError extends Error {
  readonly code: 'OWNER_ACTIVE' | 'OWNER_UNKNOWN' | 'LOCK_CORRUPT' | 'LOCK_LOST';
  readonly name = "RuntimeLockError";
  constructor(message: string, code: 'OWNER_ACTIVE' | 'OWNER_UNKNOWN' | 'LOCK_CORRUPT' | 'LOCK_LOST');
}
declare function acquireRuntimeLock(root: string): Promise<RuntimeLock>;
declare function processStartId(pid: number): string | undefined;
//#endregion
//#region src/method-ticket.d.ts
/**
 * Runtime owns only the Method submission identity. The Method Session and
 * Preflight Judge define and interpret the Lab-specific payload in `content`.
 */
declare const methodDesignTicketSchema: z.ZodObject<{
  assignment_id: z.ZodString;
  assignment_contract_sha256: z.ZodString;
  role_packet_sha256: z.ZodString;
  candidate_id: z.ZodString;
  content: z.ZodJSONSchema;
}, z.core.$strict>;
type MethodDesignTicket = z.infer<typeof methodDesignTicketSchema>;
type JsonValue = null | boolean | number | string | JsonValue[] | {
  [key: string]: JsonValue;
};
/** JSON Schema embedded verbatim in a Method Role Packet output contract. */
declare function methodDesignTicketOutputSchema(): JsonValue;
declare const METHOD_TICKET_HASH_BINDING = "role_packet_sha256";
interface FrozenMethodDesignTicket {
  readonly assignmentId: string;
  readonly candidateId: string;
  readonly rolePacketPath: string;
  readonly rolePacketHash: string;
  readonly sourceAssignmentPath: string;
  readonly sourceAssignmentHash: string;
  readonly sourceReceiptPath: string;
  readonly artifactPath: string;
  readonly artifactHash: string;
  readonly ticket: MethodDesignTicket;
}
declare class MethodTicketError extends Error {
  readonly code: 'INVALID_INPUT' | 'INVALID_PACKET' | 'PACKET_HASH_MISMATCH' | 'OUTPUT_CONTRACT_MISMATCH' | 'INVALID_TICKET' | 'ASSIGNMENT_MISMATCH' | 'HASH_BINDING_MISMATCH' | 'ANCHOR_MISMATCH' | 'ARTIFACT_CONFLICT';
  readonly issues: readonly z.core.$ZodIssue[];
  readonly name = "MethodTicketError";
  constructor(message: string, code: 'INVALID_INPUT' | 'INVALID_PACKET' | 'PACKET_HASH_MISMATCH' | 'OUTPUT_CONTRACT_MISMATCH' | 'INVALID_TICKET' | 'ASSIGNMENT_MISMATCH' | 'HASH_BINDING_MISMATCH' | 'ANCHOR_MISMATCH' | 'ARTIFACT_CONFLICT', issues?: readonly z.core.$ZodIssue[]);
}
declare function parseMethodDesignTicket(value: unknown): MethodDesignTicket;
/**
 * Freeze the exact Method receipt bytes selected by the current Role Packet.
 * Runtime verifies only packet/Assignment identity and immutable byte binding;
 * it does not inspect or reinterpret the Lab-specific Method content.
 */
declare function freezeMethodDesignTicket(input: {
  rolePacketPath: string;
  rolePacketHash: string;
  reviewArtifactPath: string;
}): Promise<FrozenMethodDesignTicket>;
//#endregion
//#region src/postflight-artifacts.d.ts
interface PostflightArtifactReference {
  readonly path: string;
  readonly sha256: string;
}
interface FreezePostflightReviewArtifactsInput {
  /** The revision read through CURRENT and already verified by ArtifactStore. */
  readonly frozen: FrozenRevision;
  readonly judgeSessionId: string;
  readonly judgeBinding: StoredRoleBinding;
  /** The immutable Coder Packet currently projected by RuntimeState. */
  readonly currentCoderPacket: PostflightArtifactReference;
  /** Small immutable control artifacts. Their target files are not opened here. */
  readonly methodPacket: PostflightArtifactReference;
  readonly preflightResult: PostflightArtifactReference;
  readonly coderResult: PostflightArtifactReference;
  readonly trial: PostflightArtifactReference;
  readonly runSlot: PostflightArtifactReference;
  readonly attempt: PostflightArtifactReference;
  readonly reviewId: string;
  readonly runtimeRevision: number;
  readonly issuedAt: number;
  /** Current RuntimeState value, which may differ from the initial Manifest state. */
  readonly revealState: 'sealed' | 'revealed';
}
interface PostflightReviewArtifacts {
  readonly reviewId: string;
  readonly assignmentId: string;
  readonly reviewInputHash: string;
  readonly assignmentPath: string;
  readonly assignmentHash: string;
  readonly assignmentText: string;
  readonly resultPath: string;
  readonly packetPath: string;
  readonly packet: CompiledRolePacket;
}
declare class PostflightArtifactError extends Error {
  readonly code: 'INVALID_INPUT' | 'CURRENT_MISMATCH' | 'JUDGE_BINDING_MISMATCH' | 'CODER_PACKET_MISMATCH' | 'ARTIFACT_CONFLICT';
  readonly name = "PostflightArtifactError";
  constructor(message: string, code: 'INVALID_INPUT' | 'CURRENT_MISMATCH' | 'JUDGE_BINDING_MISMATCH' | 'CODER_PACKET_MISMATCH' | 'ARTIFACT_CONFLICT');
}
/**
 * Compile one Postflight Assignment directly from CURRENT and immutable control
 * references. Method, result, Trial, RunSlot, and Attempt files are deliberately
 * not opened: the Judge reads their original bytes and any Lab-declared paths.
 */
declare function freezePostflightReviewArtifacts(input: FreezePostflightReviewArtifactsInput): Promise<PostflightReviewArtifacts>;
//#endregion
//#region src/postflight-result.d.ts
interface FreezePostflightResultInput {
  /** Absolute path of the exact Postflight Judge Role Packet. */
  readonly rolePacketPath: string;
  /** Hash projected by RuntimeState for that exact Packet. */
  readonly rolePacketHash: string;
  /** Controller-owned immutable destination for the raw Judge receipt. */
  readonly artifactPath: string;
}
interface FrozenPostflightResult {
  readonly rolePacketPath: string;
  readonly rolePacketHash: string;
  readonly receiptPath: string;
  readonly artifactPath: string;
  readonly receiptHash: string;
  readonly receiptBytes: Buffer;
  readonly expectedHashBinding: string;
  readonly packet: RolePacket;
}
declare class PostflightResultError extends Error {
  readonly code: 'INVALID_INPUT' | 'PACKET_READ_FAILED' | 'PACKET_HASH_MISMATCH' | 'INVALID_PACKET' | 'ROLE_MISMATCH' | 'RECEIPT_READ_FAILED' | 'ARTIFACT_WRITE_FAILED' | 'ARTIFACT_CONFLICT';
  readonly name = "PostflightResultError";
  constructor(message: string, code: 'INVALID_INPUT' | 'PACKET_READ_FAILED' | 'PACKET_HASH_MISMATCH' | 'INVALID_PACKET' | 'ROLE_MISMATCH' | 'RECEIPT_READ_FAILED' | 'ARTIFACT_WRITE_FAILED' | 'ARTIFACT_CONFLICT');
}
/**
 * Freeze the exact receipt named by a Postflight Packet. Receipt bytes remain
 * opaque: no JSON parse, generic verdict enum, scientific check, or referenced
 * log/checkpoint read occurs on this Runtime path.
 */
declare function freezePostflightResult(input: FreezePostflightResultInput): Promise<FrozenPostflightResult>;
//#endregion
//#region src/review.d.ts
declare const REVIEW_REQUEST = "REVIEW_REQUEST";
declare const REVIEW_ACCEPTED_PAUSE = "REVIEW_ACCEPTED_PAUSE";
/** Fixed audit text. It is never executed as a slash command or sent to a model Inbox. */
declare const REVIEW_ACCEPTED_TEXT = "\u5DF2\u6536\u5230\uFF0C\u8BF7\u7B49\u5F85\u5BA1\u6838\u3002\n/goal pause";
interface ReviewGoalRef {
  readonly id: string;
  readonly revision: number;
}
type ReviewResolutionInput = Omit<ReviewResolutionBody, 'version'>;
/** Compile the one immutable marker for a route whose effect already exists. */
declare function compileReviewResolution(input: ReviewResolutionInput): ReviewResolutionState;
/**
 * The exact Controller-issued edge for one review handshake. The resolver
 * supplied to the receiver is the authority for whether this edge is still
 * live; the receiver never mutates RuntimeState.
 */
interface ReviewControlCapability {
  readonly version: 1;
  readonly reviewId: string;
  readonly assignmentId: string;
  readonly configRevision: number;
  readonly runtimeRevision: number;
  readonly ownerFence: string;
  readonly workerRoleId: string;
  readonly workerSessionId: string;
  readonly judgeRoleId: string;
  readonly judgeSessionId: string;
  readonly packetHash: string;
  readonly artifactHash: string;
  readonly negotiatedAnchorHash: string;
  /** Exact worker turn which submitted this review. */
  readonly sourceTurn: number;
  readonly expectedGoalRef: ReviewGoalRef | null;
  readonly request: {
    readonly controlId: string;
    readonly payloadHash: string;
  };
  readonly acceptedPause: {
    readonly controlId: string;
    readonly payloadHash: string;
  };
}
interface ReviewControlCapabilityInput {
  readonly reviewId: string;
  readonly assignmentId: string;
  readonly configRevision: number;
  readonly runtimeRevision: number;
  readonly ownerFence: string;
  readonly workerRoleId: string;
  readonly workerSessionId: string;
  readonly judgeRoleId: string;
  readonly judgeSessionId: string;
  readonly packetHash: string;
  readonly artifactHash: string;
  readonly negotiatedAnchorHash: string;
  readonly sourceTurn: number;
  readonly expectedGoalRef: ReviewGoalRef | null;
  readonly requestControlId: string;
  readonly acceptedPauseControlId: string;
}
interface ReviewRequestPayload {
  readonly version: 1;
  readonly type: 'REVIEW_REQUEST';
  readonly requestControlId: string;
  readonly reviewId: string;
  readonly assignmentId: string;
  readonly configRevision: number;
  readonly runtimeRevision: number;
  readonly ownerFence: string;
  readonly sourceRoleId: string;
  readonly sourceSessionId: string;
  readonly targetRoleId: string;
  readonly targetSessionId: string;
  readonly packetHash: string;
  readonly artifactHash: string;
  readonly negotiatedAnchorHash: string;
  readonly sourceTurn: number;
  readonly expectedGoalRef: ReviewGoalRef | null;
}
interface ReviewAcceptedPausePayload {
  readonly version: 1;
  readonly type: 'REVIEW_ACCEPTED_PAUSE';
  readonly acceptedPauseControlId: string;
  readonly requestControlId: string;
  readonly requestPayloadHash: string;
  readonly reviewId: string;
  readonly assignmentId: string;
  readonly configRevision: number;
  readonly runtimeRevision: number;
  readonly ownerFence: string;
  readonly sourceRoleId: string;
  readonly sourceSessionId: string;
  readonly targetRoleId: string;
  readonly targetSessionId: string;
  readonly packetHash: string;
  readonly artifactHash: string;
  readonly negotiatedAnchorHash: string;
  readonly sourceTurn: number;
  readonly expectedGoalRef: ReviewGoalRef | null;
  readonly acknowledgement: typeof REVIEW_ACCEPTED_TEXT;
  readonly goalAction: 'pause';
}
interface ReviewJudgeStart {
  /** Stable key which the implementation must also deduplicate across restart. */
  readonly wakeId: string;
  readonly reviewId: string;
  readonly assignmentId: string;
  readonly judgeSessionId: string;
  readonly workerSessionId: string;
  readonly configRevision: number;
  readonly runtimeRevision: number;
  readonly ownerFence: string;
  readonly packetHash: string;
  readonly artifactHash: string;
  readonly negotiatedAnchorHash: string;
}
type ReviewJudgeStartOutcome = 'started' | 'already-started';
interface ReviewControlHandlersOptions {
  /** Return only a currently authorized, owner-fenced capability. */
  readonly resolveCapability: (controlId: string) => ReviewControlCapability | undefined;
  /** Controller shutdown aborts an admitted handler at its await boundaries. */
  readonly signal?: AbortSignal;
  /** Join one handler with the Controller lifecycle; omitted by isolated unit users. */
  readonly runHandler?: (operation: () => Promise<ControlHandlerDecision>) => Promise<ControlHandlerDecision>;
}
interface ReviewControlHandlers {
  readonly request: AsyncControlHandlerRegistration;
  readonly acceptedPause: AsyncControlHandlerRegistration;
}
interface AsyncControlHandlerRegistration extends ControlHandlerRegistration {
  readonly handle: (control: IncomingControl) => Promise<ControlHandlerDecision>;
}
interface ReviewGoalPauseResult {
  readonly outcome: 'paused' | 'already-applied' | 'no-active-goal' | 'stale';
  readonly ref?: ReviewGoalRef;
  /**
   * True only when the exact reviewed Session still has an active turn after
   * the durable Goal mutation. The Controller may then invoke its explicit
   * cancel/join/maintenance-hold fallback; this receiver never does so itself.
   */
  readonly activeTurn: boolean;
  /** Exact durable turn observed open after the Goal pause; present iff activeTurn. */
  readonly observedTurn?: number;
  /** Mechanical relation between the open turn and the immutable submitting turn. */
  readonly turnOutcome: 'stopped' | 'source-active' | 'user-override';
}
declare class ReviewProtocolError extends Error {
  readonly code: 'INVALID_CAPABILITY' | 'CAPABILITY_MISMATCH' | 'SESSION_NOT_LOCAL' | 'DURABILITY_UNAVAILABLE' | 'CONTROL_DELIVERY_FAILED';
  readonly name = "ReviewProtocolError";
  constructor(message: string, code: 'INVALID_CAPABILITY' | 'CAPABILITY_MISMATCH' | 'SESSION_NOT_LOCAL' | 'DURABILITY_UNAVAILABLE' | 'CONTROL_DELIVERY_FAILED');
}
/** Compile the only two legal payloads and bind both canonical payload hashes. */
declare function compileReviewControlCapability(input: ReviewControlCapabilityInput): ReviewControlCapability;
declare function reviewRequestPayload(capabilityInput: ReviewControlCapability): ReviewRequestPayload;
declare function reviewAcceptedPausePayload(capabilityInput: ReviewControlCapability): ReviewAcceptedPausePayload;
/** Send the exact REVIEW_REQUEST from the reviewed root Agent. */
declare function sendReviewRequest(ctx: Context, caller: Agent, capabilityInput: ReviewControlCapability, signal?: AbortSignal): Promise<ControlReceipt>;
/**
 * Build both non-model handlers. Replays deliberately call the two existing
 * idempotent transport boundary again. Judge work is deliberately not started
 * here: the Controller starts it only after the pause outcome and stopped/held
 * freeze are durable.
 */
declare function createReviewControlHandlers(ctx: Context, options: ReviewControlHandlersOptions): ReviewControlHandlers;
/** Register both kinds on the existing messaging transport; no daemon or poller is created. */
declare function registerReviewControlHandlers(ctx: Context, options: ReviewControlHandlersOptions): () => void;
/**
 * Pause only the Goal named by the review capability. This path flushes the
 * durable phase but never cancels an Agent, acquires maintenance, or sends any
 * model input.
 */
declare function pauseExpectedReviewGoal(ctx: Context, sessionId: string, expectedGoalRef: ReviewGoalRef | null, sourceTurn: number): Promise<ReviewGoalPauseResult>;
declare function reviewJudgeStart(capabilityInput: ReviewControlCapability): ReviewJudgeStart;
//#endregion
//#region src/review-artifacts.d.ts
interface FrozenArtifactReference {
  readonly path: string;
  readonly sha256: string;
}
interface FreezePreflightReviewArtifactsInput {
  /** The revision read through CURRENT and already verified by ArtifactStore. */
  readonly frozen: FrozenRevision;
  readonly judgeSessionId: string;
  readonly judgeBinding: StoredRoleBinding;
  readonly sourceMethodAssignment: FrozenArtifactReference;
  readonly sourceMethodPacket: FrozenArtifactReference;
  readonly designTicket: FrozenArtifactReference;
  readonly reviewId: string;
  readonly runtimeRevision: number;
  readonly issuedAt: number;
}
interface PreflightReviewArtifacts {
  readonly reviewId: string;
  readonly assignmentId: string;
  readonly reviewInputHash: string;
  readonly assignmentPath: string;
  readonly assignmentHash: string;
  readonly assignmentText: string;
  readonly verdictPath: string;
  readonly packetPath: string;
  readonly packet: CompiledRolePacket;
}
declare class PreflightReviewArtifactError extends Error {
  readonly code: 'INVALID_INPUT' | 'CURRENT_MISMATCH' | 'JUDGE_BINDING_MISMATCH' | 'SOURCE_PACKET_MISMATCH' | 'INPUT_HASH_MISMATCH' | 'ARTIFACT_CONFLICT';
  readonly name = "PreflightReviewArtifactError";
  constructor(message: string, code: 'INVALID_INPUT' | 'CURRENT_MISMATCH' | 'JUDGE_BINDING_MISMATCH' | 'SOURCE_PACKET_MISMATCH' | 'INPUT_HASH_MISMATCH' | 'ARTIFACT_CONFLICT');
}
/**
 * Freeze one exact Preflight Judge Assignment and Role Packet. All scientific
 * text is copied byte-for-byte from CURRENT, built-ins, or immutable inputs;
 * no model summary or additional admission rule is introduced here.
 */
declare function freezePreflightReviewArtifacts(input: FreezePreflightReviewArtifactsInput): Promise<PreflightReviewArtifacts>;
//#endregion
//#region src/role-assignment.d.ts
type RoleAssignmentJson = null | boolean | number | string | RoleAssignmentJson[] | {
  [key: string]: RoleAssignmentJson;
};
interface RoleAssignmentArtifactReference {
  readonly artifact_id: string;
  readonly path: string;
  readonly sha256: string;
}
interface MethodSourceReviewVerdictReference {
  readonly path: string;
  readonly sha256: string;
}
declare const METHOD_SOURCE_PREFLIGHT_VERDICT_ARTIFACT_ID = "source-preflight-verdict";
interface FreezeRoleAssignmentInput {
  /** Exact CURRENT revision already read through ArtifactStore. */
  readonly frozen: FrozenRevision;
  /** Controller-selected Ops or Coordinator role. */
  readonly role: RootRoleBinding;
  readonly sessionId: string;
  readonly binding: StoredRoleBinding;
  /** Current durable Packet whose original anchors and runtime snapshot continue. */
  readonly currentPacket: FrozenPacketReference;
  /** Current RuntimeState reveal projection; legacy callers may inherit the Packet value. */
  readonly currentRevealState?: 'sealed' | 'revealed';
  readonly assignmentId: string;
  readonly objective: string;
  /** Lab-defined Assignment content; Runtime stores it without interpretation. */
  readonly content: RoleAssignmentJson;
  /** Lab-defined output schema; Runtime does not evaluate a receipt against it. */
  readonly outputSchema: RoleAssignmentJson;
  /** Controller-selected small references; their target files are not read here. */
  readonly inputArtifactRefs: readonly RoleAssignmentArtifactReference[];
  readonly runtimeRevision: number;
  readonly issuedAt: number;
}
interface FrozenRoleAssignment extends InitialRoleArtifacts {
  readonly assignmentText: string;
  readonly receiptPath: string;
  readonly outputContract: {
    readonly schema: RoleAssignmentJson;
    readonly receipt_path: string;
    readonly expected_hash_binding: string;
  };
}
interface FreezeMethodAssignmentInput extends Omit<FreezeRoleAssignmentInput, 'role' | 'outputSchema'> {
  readonly role: Extract<RootRoleBinding, {
    readonly role_kind: 'method';
  }>;
  /** Present only when this Assignment resolves a non-APPROVED Preflight review. */
  readonly sourceReviewId?: string;
  /** Durable verdict identity resolved mechanically from sourceReviewId. */
  readonly sourceReviewVerdict?: MethodSourceReviewVerdictReference;
}
type FrozenMethodAssignment = FrozenRoleAssignment;
interface FreezeRoleAssignmentReceiptInput {
  /** Exact Packet currently projected for the dispatched role. */
  readonly rolePacketPath: string;
  readonly rolePacketHash: string;
  /** Controller-owned immutable destination for the original receipt bytes. */
  readonly artifactPath: string;
}
interface FrozenRoleAssignmentReceipt {
  readonly assignmentId: string;
  readonly roleId: string;
  readonly sessionId: string;
  readonly rolePacketPath: string;
  readonly rolePacketHash: string;
  readonly receiptPath: string;
  readonly artifactPath: string;
  readonly receiptHash: string;
  readonly expectedHashBinding: string;
  readonly packet: RolePacket;
}
interface RoleAssignmentInstallProjection {
  readonly assignmentId: string;
  readonly status: 'pending' | 'activating' | 'applied';
}
declare class RoleAssignmentError extends Error {
  readonly code: 'INVALID_INPUT' | 'UNSUPPORTED_ROLE' | 'BINDING_MISMATCH' | 'ARTIFACT_CONFLICT' | 'PACKET_READ_FAILED' | 'PACKET_HASH_MISMATCH' | 'INVALID_PACKET' | 'RECEIPT_READ_FAILED' | 'RECEIPT_WRITE_FAILED' | 'RECEIPT_CONFLICT';
  readonly name = "RoleAssignmentError";
  constructor(message: string, code: 'INVALID_INPUT' | 'UNSUPPORTED_ROLE' | 'BINDING_MISMATCH' | 'ARTIFACT_CONFLICT' | 'PACKET_READ_FAILED' | 'PACKET_HASH_MISMATCH' | 'INVALID_PACKET' | 'RECEIPT_READ_FAILED' | 'RECEIPT_WRITE_FAILED' | 'RECEIPT_CONFLICT');
}
/**
 * Freeze one Controller-selected Assignment and Role Packet. This is only an
 * artifact compiler: role, objective, opaque content, schema, and references
 * are all explicit inputs, and no downstream route is selected here.
 */
declare function freezeRoleAssignment(input: FreezeRoleAssignmentInput): Promise<FrozenRoleAssignment>;
/** Freeze one Controller-authored Method Assignment with the native ticket contract. */
declare function freezeMethodAssignment(input: FreezeMethodAssignmentInput): Promise<FrozenMethodAssignment>;
/**
 * Prove that an idempotent dispatch is the exact same Controller request. The
 * comparison is purely mechanical: opaque content and schema are compared as
 * canonical JSON and referenced targets are never opened.
 */
declare function assertRoleAssignmentReplay(packet: RolePacket, input: Pick<FreezeRoleAssignmentInput, 'role' | 'sessionId' | 'assignmentId' | 'objective' | 'content' | 'outputSchema' | 'inputArtifactRefs'>): void;
/** Exact replay binding for the dedicated Method Assignment path. */
declare function assertMethodAssignmentReplay(packet: RolePacket, input: Pick<FreezeMethodAssignmentInput, 'role' | 'sessionId' | 'assignmentId' | 'objective' | 'content' | 'inputArtifactRefs' | 'sourceReviewId' | 'sourceReviewVerdict'>): void;
/** Do not let a newer request erase an install whose Goal effect may exist. */
declare function assertRoleAssignmentMayDispatch(current: RoleAssignmentInstallProjection | undefined, requestedAssignmentId: string): void;
/**
 * Freeze the exact receipt path named by a dispatched Role Packet. Receipt
 * bytes are copied verbatim: no JSON parse, schema evaluation, scientific
 * classification, or referenced artifact read occurs on this path.
 */
declare function freezeRoleAssignmentReceipt(input: FreezeRoleAssignmentReceiptInput): Promise<FrozenRoleAssignmentReceipt>;
//#endregion
//#region src/role-session.d.ts
type RoleManifest = Pick<ResolvedManifest, 'roles' | 'lanes' | 'repository'>;
interface RootRoleSessionInput {
  readonly manifest: RoleManifest;
  readonly roleId: string;
  readonly sessionId: string;
  /** DSH agent-composition preset. This is distinct from the role's permission preset. */
  readonly agentPresetId?: string;
  readonly signal?: AbortSignal;
}
interface RootRoleSessionHandle extends AgentHandle {
  readonly roleId: string;
  readonly roleKind: RootRoleKind;
  readonly sessionId: ReturnType<typeof SessionId>;
  readonly cwd: string;
  readonly agentPresetId: string;
  readonly permissionPresetId: string;
}
declare class AutoLabRoleSessionError extends Error {
  readonly code: 'AGENT_PRESETS_UNAVAILABLE' | 'PERMISSION_PRESETS_UNAVAILABLE' | 'SESSION_WRITER_UNAVAILABLE' | 'SYSTEM_PROMPT_UNAVAILABLE' | 'SESSION_ALREADY_LIVE' | 'PREBOUND_SESSION_MISMATCH' | 'SESSION_ID_MISMATCH' | 'SESSION_CWD_MISMATCH' | 'AGENT_PRESET_MISSING' | 'AGENT_PRESET_MISMATCH' | 'PERMISSION_PRESET_MISMATCH' | 'MODEL_ROUTE_MISMATCH' | 'MODEL_SELECTION_NOT_EFFECTIVE' | 'TOOL_SCOPE_MISMATCH' | 'ROLE_KERNEL_NOT_EFFECTIVE';
  readonly name = "AutoLabRoleSessionError";
  constructor(message: string, code: 'AGENT_PRESETS_UNAVAILABLE' | 'PERMISSION_PRESETS_UNAVAILABLE' | 'SESSION_WRITER_UNAVAILABLE' | 'SYSTEM_PROMPT_UNAVAILABLE' | 'SESSION_ALREADY_LIVE' | 'PREBOUND_SESSION_MISMATCH' | 'SESSION_ID_MISMATCH' | 'SESSION_CWD_MISMATCH' | 'AGENT_PRESET_MISSING' | 'AGENT_PRESET_MISMATCH' | 'PERMISSION_PRESET_MISMATCH' | 'MODEL_ROUTE_MISMATCH' | 'MODEL_SELECTION_NOT_EFFECTIVE' | 'TOOL_SCOPE_MISMATCH' | 'ROLE_KERNEL_NOT_EFFECTIVE');
}
/** Create a genuinely new root-role Session under the exact supplied SessionId. */
declare function createRootRoleSession(ctx: Context, input: RootRoleSessionInput): Promise<RootRoleSessionHandle>;
/**
 * Resume the exact persisted root-role Session. This path never calls create
 * and never substitutes a fresh Session when persistence rejects or is absent.
 */
declare function resumeRootRoleSession(ctx: Context, input: RootRoleSessionInput): Promise<RootRoleSessionHandle>;
/**
 * Verify a live Agent that is owned elsewhere before borrowing it. This never
 * mutates or disposes the Agent; every checked property is already observable
 * from its DSH Session or scoped runtime.
 */
declare function verifyBorrowedRootRoleSession(ctx: Context, input: RootRoleSessionInput, agent: Agent): Promise<void>;
//#endregion
//#region src/session-durability.d.ts
declare class SessionDurabilityError extends Error {
  readonly name = "SessionDurabilityError";
}
/** A false DSH flush means no persistence listener accepted the checkpoint. */
declare function flushSessionDurably(ctx: Context, session: Session, label: string): Promise<void>;
//#endregion
//#region src/worktree.d.ts
interface WorktreeReceipt {
  readonly version: 1;
  readonly labId: string;
  readonly laneId: string;
  readonly repositoryPath: string;
  readonly worktreePath: string;
  readonly gitCommonDirectory: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly initialHeadSha: string;
  readonly createdAt: number;
  readonly receiptHash: string;
}
interface LaneWorktree {
  readonly receipt: WorktreeReceipt;
  readonly currentHeadSha: string;
  readonly dirty: boolean;
}
interface ResolvedRepositoryRefs {
  readonly repositoryPath: string;
  readonly commits: Readonly<Record<string, string>>;
}
declare class WorktreeError extends Error {
  readonly code: 'INVALID_INPUT' | 'REPOSITORY_INVALID' | 'WORKTREE_CONFLICT' | 'WORKTREE_MISSING' | 'RECEIPT_CORRUPT' | 'GIT_FAILED';
  readonly name = "WorktreeError";
  constructor(message: string, code: 'INVALID_INPUT' | 'REPOSITORY_INVALID' | 'WORKTREE_CONFLICT' | 'WORKTREE_MISSING' | 'RECEIPT_CORRUPT' | 'GIT_FAILED');
}
/**
 * Resolve a set of refs against one exact Git worktree root. Commit uses this
 * read-only discovery before freezing the manifest; start later verifies the
 * same identities while provisioning each Lane worktree.
 */
declare function resolveRepositoryRefs(repositoryPath: string, refs: readonly string[]): Promise<ResolvedRepositoryRefs>;
/**
 * Create or recover one long-lived Lane checkout using Git's own worktree
 * identity. It neither schedules GPUs nor starts an Agent.
 */
declare function provisionLaneWorktree(input: {
  labId: string;
  laneId: string;
  labDirectory: string;
  repositoryPath: string;
  worktreePath: string;
  baseRef: string;
  /** Frozen commit identity; when present, baseRef is provenance, not a moving lookup. */
  baseSha?: string;
  now?: number;
}): Promise<LaneWorktree>;
declare function inspectLaneWorktree(labDirectory: string, laneId: string): Promise<LaneWorktree>;
//#endregion
export { ActivationArtifactError, ActiveCandidate, ActiveReview, ActiveTrial, ApprovedCoderActivationError, ApprovedCoderActivationPlan, ApprovedCoderArtifactError, ApprovedCoderArtifactReference, ArtifactError, ArtifactReference, ArtifactStore, Attempt, AttemptArtifactError, AttemptArtifactReference, AttemptCompletionReceipt, AttemptControllerWake, AttemptLaunchError, AttemptRuntimeConsumer, AttemptRuntimeConsumerOptions, AttemptRuntimeEdge, AttemptRuntimeExternalEdge, AttemptRuntimeProjection, AttemptRuntimeReference, AttemptRuntimeResult, AttemptRuntimeTarget, AttemptStartedReceipt, AttemptTransitionError, AttemptUncertainReceipt, AutoLabRevealState, AutoLabRoleError, AutoLabRoleKind, AutoLabRoleSessionError, AutoLabStateError, CONTROL_PAYLOAD_HASH_PATTERN, CandidateCaptureIntent, CandidateRecoveryError, CandidateSnapshotError, CandidateSnapshotReceipt, CandidateSnapshotReference, CoderImplementationReceipt, CoderImplementationReport, CoderReceiptArtifactReference, CoderReceiptError, CoderSubmissionArtifactReference, CoderSubmissionError, CommunicationAclError, CommunicationAclMessaging, CommunicationAclPlan, CommunicationAclReconcileResult, CommunicationQuarantineSession, CommunicationRolePolicy, CommunicationRoleSession, CommunicationTextPairPolicy, CompileApprovedCoderActivationInput, CompileLocalTmuxLaunchInput, CompileRolePacketInput, CompiledRolePacket, ComponentIdentity, ConfigRef, ControllerGoalState, ControllerOwner, CreateInitialLocalAttemptInput, CreateRetryLocalAttemptInput, DetachedRunCheckout, DraftLabConfig, DraftSnapshot, ExitAttemptReceipt, ExpectedCoderImplementationAnchors, FreezeApprovedCoderActivationInput, FreezeApprovedCoderArtifactsInput, FreezeApprovedCoderSubmissionInput, FreezeCoderImplementationReceiptInput, FreezeCompiledCoderImplementationReceiptInput, FreezeLaneCandidateInput, FreezeMethodAssignmentInput, FreezePostflightResultInput, FreezePostflightReviewArtifactsInput, FreezePreflightReviewArtifactsInput, FreezePreflightVerdictInput, FreezeRoleAssignmentInput, FreezeRoleAssignmentReceiptInput, FrozenApprovedCoderSubmission, FrozenArtifactReference, FrozenCoderImplementationReceipt, FrozenLocalAttemptIntent, FrozenLocalAttemptReconcileRecord, FrozenMethodAssignment, FrozenMethodDesignTicket, FrozenPacketReference, FrozenPostflightResult, FrozenPreflightVerdict, FrozenRecord, FrozenRevision, FrozenRoleAssignment, FrozenRoleAssignmentReceipt, FrozenTrialArtifacts, InitialRoleArtifacts, InspectDetachedRunCheckoutInput, LAB_ID_PATTERN, LabConfigError, LabConfigResolution, LabLifecycle, LabScaffold, LaneWorktree, LocalAttemptReconcileError, LocalAttemptReconcileIdentity, LocalAttemptReconcileInput, LocalAttemptReconcileResult, LocalAttemptRequest, LocalGoalError, LocalGoalHold, LocalGoalInstallIntent, LocalGoalInstallResult, LocalGoalIntentInput, LocalGoalPauseResult, LocalProcessInspection, LocalReviewHoldResult, LocalTmuxBlockerCode, LocalTmuxInspection, LocalTmuxLaunchOptions, LocalTmuxLaunchPlan, LocalTmuxLaunchSpec, LocalTmuxOperationOptions, LocalTmuxPendingCode, LocalTmuxPlatform, LocalTrialRunSlotInput, METHOD_SOURCE_PREFLIGHT_VERDICT_ARTIFACT_ID, METHOD_TICKET_HASH_BINDING, ManifestValidationError, MethodDesignTicket, MethodSourceReviewVerdictReference, MethodTicketError, OutcomeUnknownAttempt, PacketValidationError, PostflightArtifactError, PostflightArtifactReference, PostflightResultError, PostflightReviewArtifacts, PreflightBlockingFinding, PreflightReviewArtifactError, PreflightReviewArtifacts, PreflightTopLevelVerdict, PreflightVerdict, PreflightVerdictError, PrepareInitialLocalAttemptInput, PrepareRetryLocalAttemptInput, PreparedApprovedCoderActivation, PreparedInitialLocalAttempt, PreparedRetryLocalAttempt, ProvisionDetachedRunCheckoutInput, REVIEW_ACCEPTED_PAUSE, REVIEW_ACCEPTED_TEXT, REVIEW_REQUEST, ROLE_KERNEL_ORDER, ROLE_KERNEL_SECTION, ROLE_KERNEL_VERSION, ReadCoderImplementationReport, ReadLocalAttemptIntent, ReconcileCommunicationAclInput, ResolvedManifest, ResolvedRepositoryRefs, RestoreCurrentRoleArtifactsInput, ReviewAcceptedPausePayload, ReviewControlCapability, ReviewControlCapabilityInput, ReviewControlHandlers, ReviewControlHandlersOptions, ReviewGoalPauseResult, ReviewGoalRef, ReviewJudgeStart, ReviewJudgeStartOutcome, ReviewProtocolError, ReviewRequestPayload, ReviewResolutionBody, ReviewResolutionError, ReviewResolutionInput, ReviewResolutionState, RevisionValidation, RoleAssignmentArtifactReference, RoleAssignmentError, RoleAssignmentInstallProjection, RoleAssignmentJson, RoleBinding, RoleBindingError, RoleBindingReceipt, RoleKernel, RolePacket, RolePrompt, RoleState, RootRoleBinding, RootRoleKind, RootRoleSessionHandle, RootRoleSessionInput, RootRoleSessionSpec, RunCheckoutError, RunCheckoutReceipt, RunSlotAttemptTransition, RunSlotContract, RunSlotState, RuntimeLock, RuntimeLockError, RuntimeState, SHA256_PATTERN, ScheduleAttemptRuntimeOnce, SessionDurabilityError, StartedAttemptReceipt, StoredRoleBinding, TerminalAttempt, TrialArtifactError, TrialContract, TrialContractError, VerbatimBlock, VerifiedActiveCandidate, VerifyRetryLocalAttemptReplayInput, WorktreeError, WorktreeReceipt, acquireLocalReviewHold, acquireRuntimeLock, activeCandidateSchema, activeReviewSchema, activeTrialSchema, adoptLocalTmuxAttempt, adoptRuntimeOwner, applyApprovedCoderGoal, artifactReferenceSchema, assertMethodAssignmentReplay, assertRoleAssignmentMayDispatch, assertRoleAssignmentReplay, attemptCompletionReceiptSchema, attemptSchema, attemptStartedReceiptSchema, attemptUncertainReceiptSchema, autolabDomainSpec, candidateFrozenReportPath, candidateReceiptPath, canonicalJson, coderImplementationReceiptOutputSchema, coderImplementationReceiptSchema, coderImplementationReportOutputSchema, coderImplementationReportSchema, compileApprovedCoderActivation, compileAttemptCompletionReceipt, compileAttemptStartedReceipt, compileAttemptUncertainReceipt, compileCoderImplementationReceipt, compileCommunicationAcl, compileLocalGoalIntent, compileLocalTmuxLaunch, compileReviewControlCapability, compileReviewResolution, compileRolePacket, compileRunSlotContract, compileTrialContract, componentIdentitySchema, configRefSchema, controllerGoalSchema, createInitialAttempt, createRetryAttempt, createReviewControlHandlers, createRootRoleSession, createRunSlotState, createRuntimeState, createSubprocessLocalTmuxPlatform, draftLabConfigSchema, durableWriteFile, flushSessionDurably, freezeApprovedCoderActivation, freezeApprovedCoderArtifacts, freezeApprovedCoderSubmission, freezeAttemptReceiptArtifact, freezeAttemptStateArtifact, freezeCoderImplementationReceipt, freezeCompiledCoderImplementationReceipt, freezeInitialLocalAttempt, freezeInitialRoleArtifacts, freezeLaneCandidate, freezeMethodAssignment, freezeMethodDesignTicket, freezePostflightResult, freezePostflightReviewArtifacts, freezePreflightReviewArtifacts, freezePreflightVerdict, freezePreflightVerdictArtifact, freezeRetryLocalAttempt, freezeRoleAssignment, freezeRoleAssignmentReceipt, freezeRoleBinding, freezeTrialArtifacts, generateLabId, goalInstallSchema, hashResolvedManifest, hashRolePacket, inspectDetachedRunCheckout, inspectLaneWorktree, inspectLocalTmuxAttempt, installApprovedCoderGoal, installLocalGoal, labLifecycleSchema, launchLocalTmuxAttempt, localAttemptCheckoutPath, localAttemptDirectory, localAttemptRequestPath, localAttemptRequestSchema, methodDesignTicketOutputSchema, methodDesignTicketSchema, nodeLocalTmuxPlatform, observeOpenAgentTurn, parseAttempt, parseCoderImplementationReceipt, parseCoderImplementationReport, parseDraftLabConfig, parseDraftLabYaml, parseMethodDesignTicket, parsePreflightVerdict, parsePreflightVerdictArtifact, parseResolvedManifest, parseRolePacket, parseRunSlotState, parseState, parseTrialContract, pauseExpectedReviewGoal, pauseLocalGoal, pauseLocalGoalContinuation, prepareInitialLocalAttempt, prepareRetryLocalAttempt, processStartId, provisionDetachedRunCheckout, provisionLaneWorktree, readAttemptUncertainReceiptArtifactIfPresent, readCandidateChangedPaths, readCandidateSnapshotReceipt, readCoderImplementationReceipt, readCoderImplementationReport, readLocalAttemptIntent, readRoleBinding, receiptReferenceSchema, reconcileCommunicationAcl, reconcileLocalTmuxInspection, recordAttemptCompletion, recordAttemptOutcomeUnknown, recordAttemptStarted, recordReviewResolution, registerReviewControlHandlers, resolutionHash, resolveApprovedCoderReview, resolveDraftLabConfig, resolveLocalAttemptWrapperPath, resolveRepositoryRefs, resolveRootRoleSessionSpec, resolvedManifestSchema, restoreCurrentRoleArtifacts, resumeRootRoleSession, reviewAcceptedPausePayload, reviewCapabilityStateSchema, reviewFreezeComplete, reviewJudgeStart, reviewPauseStateSchema, reviewReadyToAdvance, reviewRequestPayload, reviewResolutionStateSchema, reviewResultStateSchema, reviewVerdictStateSchema, roleActivationBlockerSchema, roleBindingSchema, roleKernelFor, rolePacketSchema, rolePhaseSchema, rolePromptFor, roleStateSchema, runCheckoutReceiptPath, runCheckoutReceiptSchema, runSlotContractSchema, runSlotStateSchema, runtimeStateSchema, sendReviewRequest, sha256, stageApprovedCoderActivation, transitionRuntimeState, trialContractSchema, validateLabId, verbatimBlockSchema, verifyActiveCandidateProjection, verifyBorrowedRootRoleSession, verifyInitialLocalAttempt, verifyRetryLocalAttemptReplay };