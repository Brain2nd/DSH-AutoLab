import { z } from "zod";
import * as _deepseek_ai_dsh_storage_domain0 from "@deepseek-ai/dsh-storage-domain";
import { Session } from "@deepseek-ai/dsh-session";
import { GoalRef } from "@deepseek-ai/dsh-goal";
import { Agent } from "@deepseek-ai/dsh-agent";
import { LlmFailure } from "@deepseek-ai/dsh-llm";
import { Context } from "@deepseek-ai/cordis";

//#region src/api-recovery.d.ts
interface GoalApiRecoveryContinuation {
  readonly kind: 'goal';
  readonly goalRef: GoalRef;
  readonly objectiveHash: string;
}
interface ReviewApiRecoveryContinuation {
  readonly kind: 'review';
  readonly reviewId: string;
  readonly reviewAnchorHash: string;
}
type ApiRecoveryContinuation = GoalApiRecoveryContinuation | ReviewApiRecoveryContinuation;
/** Current AutoLab identity resolved from one exact live Agent. */
interface ApiRecoveryAssignment {
  readonly labId: string;
  readonly roleId: string;
  readonly sessionId: string;
  readonly assignmentId: string;
  readonly packetHash: string;
  readonly continuation: ApiRecoveryContinuation;
}
interface ApiRecoveryBase extends ApiRecoveryAssignment {
  readonly turn: number;
  readonly step: number;
  readonly provider: string;
  readonly failure: LlmFailure;
  readonly recordedAt: number;
  /** Exactly one conservative continuation is allowed for one unknown code. */
  readonly unknownFallbackUsed: boolean;
}
/** Written before AgentLoop is allowed to close the failed turn. */
interface AwaitingApiTerminalRecord extends ApiRecoveryBase {
  readonly phase: 'awaiting-terminal';
}
/** One durable retry deadline; no interval or provider health probe exists. */
interface ScheduledApiRecoveryRecord extends ApiRecoveryBase {
  readonly phase: 'scheduled';
  readonly terminalSeq: number;
  readonly dueAt: number;
}
/** Goal continuation was rearmed; retained until a later real turn settles. */
interface RecoveringApiRecord extends ApiRecoveryBase {
  readonly phase: 'recovering';
  readonly terminalSeq: number;
  readonly resumedContinuation: ApiRecoveryContinuation;
  readonly resumedAt: number;
}
/** A real terminal failure that needs configuration, credentials, quota, or user action. */
interface OperatorApiIncidentRecord extends ApiRecoveryBase {
  readonly phase: 'operator';
  readonly terminalSeq: number;
}
type ApiRecoveryRecord = AwaitingApiTerminalRecord | ScheduledApiRecoveryRecord | RecoveringApiRecord | OperatorApiIncidentRecord;
//#endregion
//#region src/state.d.ts
declare const LAB_ID_PATTERN: RegExp;
declare const SHA256_PATTERN: RegExp;
declare const CONTROL_PAYLOAD_HASH_PATTERN: RegExp;
declare const labLifecycleSchema: z.ZodEnum<{
  configuring: "configuring";
  draft_ready: "draft_ready";
  ready: "ready";
  starting: "starting";
  running: "running";
  pausing: "pausing";
  paused: "paused";
  blocked: "blocked";
  stopped: "stopped";
}>;
declare const rolePhaseSchema: z.ZodEnum<{
  starting: "starting";
  pausing: "pausing";
  paused: "paused";
  blocked: "blocked";
  declared: "declared";
  working: "working";
  reviewing: "reviewing";
}>;
declare const reviewCapabilityStateSchema: z.ZodObject<{
  version: z.ZodLiteral<1>;
  reviewId: z.ZodString;
  assignmentId: z.ZodString;
  configRevision: z.ZodNumber;
  runtimeRevision: z.ZodNumber;
  ownerFence: z.ZodString;
  workerRoleId: z.ZodString;
  workerSessionId: z.ZodString;
  judgeRoleId: z.ZodString;
  judgeSessionId: z.ZodString;
  packetHash: z.ZodString;
  artifactHash: z.ZodString;
  negotiatedAnchorHash: z.ZodString;
  sourceTurn: z.ZodNumber;
  expectedGoalRef: z.ZodNullable<z.ZodObject<{
    id: z.ZodString;
    revision: z.ZodNumber;
  }, z.core.$strict>>;
  request: z.ZodObject<{
    controlId: z.ZodString;
    payloadHash: z.ZodString;
  }, z.core.$strict>;
  acceptedPause: z.ZodObject<{
    controlId: z.ZodString;
    payloadHash: z.ZodString;
  }, z.core.$strict>;
}, z.core.$strict>;
declare const reviewPauseStateSchema: z.ZodObject<{
  controlId: z.ZodString;
  payloadHash: z.ZodString;
  freeze: z.ZodEnum<{
    stopped: "stopped";
    pending: "pending";
    "hold-pending": "hold-pending";
    held: "held";
    stale: "stale";
    "user-override": "user-override";
  }>;
  completedAt: z.ZodOptional<z.ZodNumber>;
  goalOutcome: z.ZodOptional<z.ZodEnum<{
    paused: "paused";
    stale: "stale";
    "already-applied": "already-applied";
    "no-active-goal": "no-active-goal";
  }>>;
  activeTurn: z.ZodOptional<z.ZodBoolean>;
  observedTurn: z.ZodOptional<z.ZodNumber>;
  goalRef: z.ZodOptional<z.ZodObject<{
    id: z.ZodString;
    revision: z.ZodNumber;
  }, z.core.$strict>>;
  holdOwnerEpoch: z.ZodOptional<z.ZodString>;
  detail: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
declare const reviewVerdictStateSchema: z.ZodObject<{
  path: z.ZodString;
  hash: z.ZodString;
  assignmentId: z.ZodString;
  reviewInputHash: z.ZodString;
  topLevelVerdict: z.ZodEnum<{
    APPROVED: "APPROVED";
    REVISION_REQUIRED: "REVISION_REQUIRED";
    REJECTED: "REJECTED";
    REVIEW_ERROR: "REVIEW_ERROR";
  }>;
  recordedAt: z.ZodNumber;
}, z.core.$strict>;
/** Postflight scientific content stays opaque; Runtime stores only its binding. */
declare const reviewResultStateSchema: z.ZodObject<{
  path: z.ZodString;
  hash: z.ZodString;
  assignmentId: z.ZodString;
  reviewInputHash: z.ZodString;
  recordedAt: z.ZodNumber;
}, z.core.$strict>;
declare const reviewResolutionBodySchema: z.ZodObject<{
  version: z.ZodLiteral<1>;
  reviewId: z.ZodString;
  verdictHash: z.ZodString;
  targetRoleId: z.ZodString;
  targetSessionId: z.ZodString;
  effect: z.ZodObject<{
    kind: z.ZodString;
    id: z.ZodString;
    hash: z.ZodString;
  }, z.core.$strict>;
}, z.core.$strict>;
declare const reviewResolutionStateSchema: z.ZodObject<{
  version: z.ZodLiteral<1>;
  reviewId: z.ZodString;
  verdictHash: z.ZodString;
  targetRoleId: z.ZodString;
  targetSessionId: z.ZodString;
  effect: z.ZodObject<{
    kind: z.ZodString;
    id: z.ZodString;
    hash: z.ZodString;
  }, z.core.$strict>;
  resolutionHash: z.ZodString;
}, z.core.$strict>;
declare const activeReviewSchema: z.ZodObject<{
  stage: z.ZodEnum<{
    preflight: "preflight";
    postflight: "postflight";
  }>;
  phase: z.ZodEnum<{
    reviewing: "reviewing";
    error: "error";
    verdict_recorded: "verdict_recorded";
    result_recorded: "result_recorded";
  }>;
  sourcePacket: z.ZodObject<{
    path: z.ZodString;
    hash: z.ZodString;
  }, z.core.$strict>;
  packetPath: z.ZodString;
  artifactPath: z.ZodString;
  capability: z.ZodObject<{
    version: z.ZodLiteral<1>;
    reviewId: z.ZodString;
    assignmentId: z.ZodString;
    configRevision: z.ZodNumber;
    runtimeRevision: z.ZodNumber;
    ownerFence: z.ZodString;
    workerRoleId: z.ZodString;
    workerSessionId: z.ZodString;
    judgeRoleId: z.ZodString;
    judgeSessionId: z.ZodString;
    packetHash: z.ZodString;
    artifactHash: z.ZodString;
    negotiatedAnchorHash: z.ZodString;
    sourceTurn: z.ZodNumber;
    expectedGoalRef: z.ZodNullable<z.ZodObject<{
      id: z.ZodString;
      revision: z.ZodNumber;
    }, z.core.$strict>>;
    request: z.ZodObject<{
      controlId: z.ZodString;
      payloadHash: z.ZodString;
    }, z.core.$strict>;
    acceptedPause: z.ZodObject<{
      controlId: z.ZodString;
      payloadHash: z.ZodString;
    }, z.core.$strict>;
  }, z.core.$strict>;
  pause: z.ZodObject<{
    controlId: z.ZodString;
    payloadHash: z.ZodString;
    freeze: z.ZodEnum<{
      stopped: "stopped";
      pending: "pending";
      "hold-pending": "hold-pending";
      held: "held";
      stale: "stale";
      "user-override": "user-override";
    }>;
    completedAt: z.ZodOptional<z.ZodNumber>;
    goalOutcome: z.ZodOptional<z.ZodEnum<{
      paused: "paused";
      stale: "stale";
      "already-applied": "already-applied";
      "no-active-goal": "no-active-goal";
    }>>;
    activeTurn: z.ZodOptional<z.ZodBoolean>;
    observedTurn: z.ZodOptional<z.ZodNumber>;
    goalRef: z.ZodOptional<z.ZodObject<{
      id: z.ZodString;
      revision: z.ZodNumber;
    }, z.core.$strict>>;
    holdOwnerEpoch: z.ZodOptional<z.ZodString>;
    detail: z.ZodOptional<z.ZodString>;
  }, z.core.$strict>;
  verdict: z.ZodOptional<z.ZodObject<{
    path: z.ZodString;
    hash: z.ZodString;
    assignmentId: z.ZodString;
    reviewInputHash: z.ZodString;
    topLevelVerdict: z.ZodEnum<{
      APPROVED: "APPROVED";
      REVISION_REQUIRED: "REVISION_REQUIRED";
      REJECTED: "REJECTED";
      REVIEW_ERROR: "REVIEW_ERROR";
    }>;
    recordedAt: z.ZodNumber;
  }, z.core.$strict>>;
  result: z.ZodOptional<z.ZodObject<{
    path: z.ZodString;
    hash: z.ZodString;
    assignmentId: z.ZodString;
    reviewInputHash: z.ZodString;
    recordedAt: z.ZodNumber;
  }, z.core.$strict>>;
  resolution: z.ZodOptional<z.ZodObject<{
    version: z.ZodLiteral<1>;
    reviewId: z.ZodString;
    verdictHash: z.ZodString;
    targetRoleId: z.ZodString;
    targetSessionId: z.ZodString;
    effect: z.ZodObject<{
      kind: z.ZodString;
      id: z.ZodString;
      hash: z.ZodString;
    }, z.core.$strict>;
    resolutionHash: z.ZodString;
  }, z.core.$strict>>;
  createdAt: z.ZodNumber;
  updatedAt: z.ZodNumber;
}, z.core.$strict>;
declare const goalInstallSchema: z.ZodObject<{
  installId: z.ZodString;
  assignmentId: z.ZodString;
  objectiveHash: z.ZodString;
  maxGoalRounds: z.ZodNumber;
  status: z.ZodEnum<{
    pending: "pending";
    activating: "activating";
    applied: "applied";
  }>;
  goalId: z.ZodOptional<z.ZodString>;
  goalRevision: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
/**
 * The Controller is the user's existing Session, not an entry in `roles`.
 * Keep only the identity needed to recover its one native DSH Goal plus the
 * Controller's explicit AutoLabWait intent. Goal phase, activation, and round
 * counters remain owned by `@deepseek-ai/dsh-goal`.
 */
declare const controllerGoalSchema: z.ZodObject<{
  installId: z.ZodString;
  assignmentId: z.ZodString;
  objectiveHash: z.ZodString;
  maxGoalRounds: z.ZodNumber;
  status: z.ZodEnum<{
    pending: "pending";
    activating: "activating";
    applied: "applied";
  }>;
  goalId: z.ZodOptional<z.ZodString>;
  goalRevision: z.ZodOptional<z.ZodNumber>;
  roleId: z.ZodString;
  packetHash: z.ZodString;
  waiting: z.ZodOptional<z.ZodLiteral<true>>;
}, z.core.$strict>;
declare const roleActivationBlockerSchema: z.ZodObject<{
  code: z.ZodEnum<{
    WORKTREE_PROVISION_FAILED: "WORKTREE_PROVISION_FAILED";
    ROLE_ACTIVATION_FAILED: "ROLE_ACTIVATION_FAILED";
    GOAL_INSTALL_FAILED: "GOAL_INSTALL_FAILED";
  }>;
  message: z.ZodString;
}, z.core.$strict>;
declare const roleStateSchema: z.ZodObject<{
  sessionId: z.ZodString;
  phase: z.ZodEnum<{
    starting: "starting";
    pausing: "pausing";
    paused: "paused";
    blocked: "blocked";
    declared: "declared";
    working: "working";
    reviewing: "reviewing";
  }>;
  binding: z.ZodOptional<z.ZodObject<{
    path: z.ZodString;
    hash: z.ZodString;
  }, z.core.$strict>>;
  packet: z.ZodOptional<z.ZodObject<{
    path: z.ZodString;
    hash: z.ZodString;
  }, z.core.$strict>>;
  goalInstall: z.ZodOptional<z.ZodObject<{
    installId: z.ZodString;
    assignmentId: z.ZodString;
    objectiveHash: z.ZodString;
    maxGoalRounds: z.ZodNumber;
    status: z.ZodEnum<{
      pending: "pending";
      activating: "activating";
      applied: "applied";
    }>;
    goalId: z.ZodOptional<z.ZodString>;
    goalRevision: z.ZodOptional<z.ZodNumber>;
  }, z.core.$strict>>;
  receipt: z.ZodOptional<z.ZodObject<{
    assignmentId: z.ZodString;
    path: z.ZodString;
    hash: z.ZodString;
    recordedAt: z.ZodNumber;
  }, z.core.$strict>>;
  activationBlocker: z.ZodOptional<z.ZodObject<{
    code: z.ZodEnum<{
      WORKTREE_PROVISION_FAILED: "WORKTREE_PROVISION_FAILED";
      ROLE_ACTIVATION_FAILED: "ROLE_ACTIVATION_FAILED";
      GOAL_INSTALL_FAILED: "GOAL_INSTALL_FAILED";
    }>;
    message: z.ZodString;
  }, z.core.$strict>>;
}, z.core.$strict>;
declare const activeCandidateSchema: z.ZodObject<{
  version: z.ZodLiteral<1>;
  sourceRevision: z.ZodNumber;
  laneId: z.ZodString;
  candidateId: z.ZodString;
  reviewId: z.ZodOptional<z.ZodString>;
  coderRoleId: z.ZodString;
  coderSessionId: z.ZodString;
  assignmentId: z.ZodString;
  candidateSha: z.ZodString;
  captureReceipt: z.ZodObject<{
    path: z.ZodString;
    hash: z.ZodString;
  }, z.core.$strict>;
  sourceReport: z.ZodOptional<z.ZodObject<{
    path: z.ZodString;
    hash: z.ZodString;
  }, z.core.$strict>>;
  frozenAt: z.ZodNumber;
}, z.core.$strict>;
declare const activeTrialSchema: z.ZodObject<{
  version: z.ZodLiteral<1>;
  sourceRevision: z.ZodNumber;
  laneId: z.ZodString;
  candidateId: z.ZodString;
  candidateSha: z.ZodString;
  contract: z.ZodObject<{
    path: z.ZodString;
    hash: z.ZodString;
  }, z.core.$strict>;
  runSlots: z.ZodRecord<z.ZodString, z.ZodObject<{
    contract: z.ZodObject<{
      path: z.ZodString;
      hash: z.ZodString;
    }, z.core.$strict>;
    state: z.ZodDiscriminatedUnion<[z.ZodObject<{
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
    activeAttempt: z.ZodOptional<z.ZodObject<{
      attemptId: z.ZodString;
      phase: z.ZodEnum<{
        running: "running";
        outcome_unknown: "outcome_unknown";
        launching: "launching";
        terminal: "terminal";
      }>;
      path: z.ZodString;
      hash: z.ZodString;
      checkout: z.ZodOptional<z.ZodObject<{
        path: z.ZodString;
        hash: z.ZodString;
      }, z.core.$strict>>;
    }, z.core.$strict>>;
  }, z.core.$strict>>;
}, z.core.$strict>;
declare const configRefSchema: z.ZodObject<{
  revision: z.ZodNumber;
  specHash: z.ZodString;
  configHash: z.ZodString;
  manifestHash: z.ZodString;
  dialogueHeadHash: z.ZodString;
  revisionPath: z.ZodString;
}, z.core.$strict>;
declare const runtimeStateSchema: z.ZodObject<{
  schemaVersion: z.ZodLiteral<1>;
  labId: z.ZodString;
  runtimeRevision: z.ZodNumber;
  ownerEpoch: z.ZodString;
  controllerSessionId: z.ZodString;
  controllerGoal: z.ZodOptional<z.ZodObject<{
    installId: z.ZodString;
    assignmentId: z.ZodString;
    objectiveHash: z.ZodString;
    maxGoalRounds: z.ZodNumber;
    status: z.ZodEnum<{
      pending: "pending";
      activating: "activating";
      applied: "applied";
    }>;
    goalId: z.ZodOptional<z.ZodString>;
    goalRevision: z.ZodOptional<z.ZodNumber>;
    roleId: z.ZodString;
    packetHash: z.ZodString;
    waiting: z.ZodOptional<z.ZodLiteral<true>>;
  }, z.core.$strict>>;
  lifecycle: z.ZodEnum<{
    configuring: "configuring";
    draft_ready: "draft_ready";
    ready: "ready";
    starting: "starting";
    running: "running";
    pausing: "pausing";
    paused: "paused";
    blocked: "blocked";
    stopped: "stopped";
  }>;
  config: z.ZodOptional<z.ZodObject<{
    revision: z.ZodNumber;
    specHash: z.ZodString;
    configHash: z.ZodString;
    manifestHash: z.ZodString;
    dialogueHeadHash: z.ZodString;
    revisionPath: z.ZodString;
  }, z.core.$strict>>;
  revealState: z.ZodOptional<z.ZodEnum<{
    sealed: "sealed";
    revealed: "revealed";
  }>>;
  roles: z.ZodRecord<z.ZodString, z.ZodObject<{
    sessionId: z.ZodString;
    phase: z.ZodEnum<{
      starting: "starting";
      pausing: "pausing";
      paused: "paused";
      blocked: "blocked";
      declared: "declared";
      working: "working";
      reviewing: "reviewing";
    }>;
    binding: z.ZodOptional<z.ZodObject<{
      path: z.ZodString;
      hash: z.ZodString;
    }, z.core.$strict>>;
    packet: z.ZodOptional<z.ZodObject<{
      path: z.ZodString;
      hash: z.ZodString;
    }, z.core.$strict>>;
    goalInstall: z.ZodOptional<z.ZodObject<{
      installId: z.ZodString;
      assignmentId: z.ZodString;
      objectiveHash: z.ZodString;
      maxGoalRounds: z.ZodNumber;
      status: z.ZodEnum<{
        pending: "pending";
        activating: "activating";
        applied: "applied";
      }>;
      goalId: z.ZodOptional<z.ZodString>;
      goalRevision: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    receipt: z.ZodOptional<z.ZodObject<{
      assignmentId: z.ZodString;
      path: z.ZodString;
      hash: z.ZodString;
      recordedAt: z.ZodNumber;
    }, z.core.$strict>>;
    activationBlocker: z.ZodOptional<z.ZodObject<{
      code: z.ZodEnum<{
        WORKTREE_PROVISION_FAILED: "WORKTREE_PROVISION_FAILED";
        ROLE_ACTIVATION_FAILED: "ROLE_ACTIVATION_FAILED";
        GOAL_INSTALL_FAILED: "GOAL_INSTALL_FAILED";
      }>;
      message: z.ZodString;
    }, z.core.$strict>>;
  }, z.core.$strict>>;
  reviews: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
    stage: z.ZodEnum<{
      preflight: "preflight";
      postflight: "postflight";
    }>;
    phase: z.ZodEnum<{
      reviewing: "reviewing";
      error: "error";
      verdict_recorded: "verdict_recorded";
      result_recorded: "result_recorded";
    }>;
    sourcePacket: z.ZodObject<{
      path: z.ZodString;
      hash: z.ZodString;
    }, z.core.$strict>;
    packetPath: z.ZodString;
    artifactPath: z.ZodString;
    capability: z.ZodObject<{
      version: z.ZodLiteral<1>;
      reviewId: z.ZodString;
      assignmentId: z.ZodString;
      configRevision: z.ZodNumber;
      runtimeRevision: z.ZodNumber;
      ownerFence: z.ZodString;
      workerRoleId: z.ZodString;
      workerSessionId: z.ZodString;
      judgeRoleId: z.ZodString;
      judgeSessionId: z.ZodString;
      packetHash: z.ZodString;
      artifactHash: z.ZodString;
      negotiatedAnchorHash: z.ZodString;
      sourceTurn: z.ZodNumber;
      expectedGoalRef: z.ZodNullable<z.ZodObject<{
        id: z.ZodString;
        revision: z.ZodNumber;
      }, z.core.$strict>>;
      request: z.ZodObject<{
        controlId: z.ZodString;
        payloadHash: z.ZodString;
      }, z.core.$strict>;
      acceptedPause: z.ZodObject<{
        controlId: z.ZodString;
        payloadHash: z.ZodString;
      }, z.core.$strict>;
    }, z.core.$strict>;
    pause: z.ZodObject<{
      controlId: z.ZodString;
      payloadHash: z.ZodString;
      freeze: z.ZodEnum<{
        stopped: "stopped";
        pending: "pending";
        "hold-pending": "hold-pending";
        held: "held";
        stale: "stale";
        "user-override": "user-override";
      }>;
      completedAt: z.ZodOptional<z.ZodNumber>;
      goalOutcome: z.ZodOptional<z.ZodEnum<{
        paused: "paused";
        stale: "stale";
        "already-applied": "already-applied";
        "no-active-goal": "no-active-goal";
      }>>;
      activeTurn: z.ZodOptional<z.ZodBoolean>;
      observedTurn: z.ZodOptional<z.ZodNumber>;
      goalRef: z.ZodOptional<z.ZodObject<{
        id: z.ZodString;
        revision: z.ZodNumber;
      }, z.core.$strict>>;
      holdOwnerEpoch: z.ZodOptional<z.ZodString>;
      detail: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    verdict: z.ZodOptional<z.ZodObject<{
      path: z.ZodString;
      hash: z.ZodString;
      assignmentId: z.ZodString;
      reviewInputHash: z.ZodString;
      topLevelVerdict: z.ZodEnum<{
        APPROVED: "APPROVED";
        REVISION_REQUIRED: "REVISION_REQUIRED";
        REJECTED: "REJECTED";
        REVIEW_ERROR: "REVIEW_ERROR";
      }>;
      recordedAt: z.ZodNumber;
    }, z.core.$strict>>;
    result: z.ZodOptional<z.ZodObject<{
      path: z.ZodString;
      hash: z.ZodString;
      assignmentId: z.ZodString;
      reviewInputHash: z.ZodString;
      recordedAt: z.ZodNumber;
    }, z.core.$strict>>;
    resolution: z.ZodOptional<z.ZodObject<{
      version: z.ZodLiteral<1>;
      reviewId: z.ZodString;
      verdictHash: z.ZodString;
      targetRoleId: z.ZodString;
      targetSessionId: z.ZodString;
      effect: z.ZodObject<{
        kind: z.ZodString;
        id: z.ZodString;
        hash: z.ZodString;
      }, z.core.$strict>;
      resolutionHash: z.ZodString;
    }, z.core.$strict>>;
    createdAt: z.ZodNumber;
    updatedAt: z.ZodNumber;
  }, z.core.$strict>>>;
  candidates: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
    version: z.ZodLiteral<1>;
    sourceRevision: z.ZodNumber;
    laneId: z.ZodString;
    candidateId: z.ZodString;
    reviewId: z.ZodOptional<z.ZodString>;
    coderRoleId: z.ZodString;
    coderSessionId: z.ZodString;
    assignmentId: z.ZodString;
    candidateSha: z.ZodString;
    captureReceipt: z.ZodObject<{
      path: z.ZodString;
      hash: z.ZodString;
    }, z.core.$strict>;
    sourceReport: z.ZodOptional<z.ZodObject<{
      path: z.ZodString;
      hash: z.ZodString;
    }, z.core.$strict>>;
    frozenAt: z.ZodNumber;
  }, z.core.$strict>>>;
  retiredCandidates: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
    version: z.ZodLiteral<1>;
    sourceRevision: z.ZodNumber;
    laneId: z.ZodString;
    candidateId: z.ZodString;
    reviewId: z.ZodOptional<z.ZodString>;
    coderRoleId: z.ZodString;
    coderSessionId: z.ZodString;
    assignmentId: z.ZodString;
    candidateSha: z.ZodString;
    captureReceipt: z.ZodObject<{
      path: z.ZodString;
      hash: z.ZodString;
    }, z.core.$strict>;
    sourceReport: z.ZodOptional<z.ZodObject<{
      path: z.ZodString;
      hash: z.ZodString;
    }, z.core.$strict>>;
    frozenAt: z.ZodNumber;
  }, z.core.$strict>>>;
  trials: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
    version: z.ZodLiteral<1>;
    sourceRevision: z.ZodNumber;
    laneId: z.ZodString;
    candidateId: z.ZodString;
    candidateSha: z.ZodString;
    contract: z.ZodObject<{
      path: z.ZodString;
      hash: z.ZodString;
    }, z.core.$strict>;
    runSlots: z.ZodRecord<z.ZodString, z.ZodObject<{
      contract: z.ZodObject<{
        path: z.ZodString;
        hash: z.ZodString;
      }, z.core.$strict>;
      state: z.ZodDiscriminatedUnion<[z.ZodObject<{
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
      activeAttempt: z.ZodOptional<z.ZodObject<{
        attemptId: z.ZodString;
        phase: z.ZodEnum<{
          running: "running";
          outcome_unknown: "outcome_unknown";
          launching: "launching";
          terminal: "terminal";
        }>;
        path: z.ZodString;
        hash: z.ZodString;
        checkout: z.ZodOptional<z.ZodObject<{
          path: z.ZodString;
          hash: z.ZodString;
        }, z.core.$strict>>;
      }, z.core.$strict>>;
    }, z.core.$strict>>;
  }, z.core.$strict>>>;
  blocker: z.ZodOptional<z.ZodObject<{
    code: z.ZodString;
    message: z.ZodString;
  }, z.core.$strict>>;
  createdAt: z.ZodNumber;
  updatedAt: z.ZodNumber;
}, z.core.$strict>;
type LabLifecycle = z.infer<typeof labLifecycleSchema>;
type RoleState = z.infer<typeof roleStateSchema>;
type ControllerGoalState = z.infer<typeof controllerGoalSchema>;
type ActiveCandidate = z.infer<typeof activeCandidateSchema>;
type ActiveTrial = z.infer<typeof activeTrialSchema>;
type ActiveReview = z.infer<typeof activeReviewSchema>;
type ReviewResolutionBody = z.infer<typeof reviewResolutionBodySchema>;
type ReviewResolutionState = z.infer<typeof reviewResolutionStateSchema>;
type ConfigRef = z.infer<typeof configRefSchema>;
type RuntimeState = z.infer<typeof runtimeStateSchema>;
declare class ReviewResolutionError extends Error {
  readonly code: 'NOT_READY' | 'VERDICT_MISMATCH' | 'RESOLUTION_CONFLICT';
  readonly name = "ReviewResolutionError";
  constructor(message: string, code: 'NOT_READY' | 'VERDICT_MISMATCH' | 'RESOLUTION_CONFLICT');
}
declare function resolutionHash(body: ReviewResolutionBody): string;
/** The only worker-freeze states from which a persisted verdict may advance. */
declare function reviewFreezeComplete(review: ActiveReview, ownerEpoch: string): boolean;
/** Verdict and freeze are independent axes; both must meet at this boundary. */
declare function reviewReadyToAdvance(review: ActiveReview, ownerEpoch: string): boolean;
/**
 * Record one already-applied deterministic route. This is a terminal marker,
 * not another lifecycle axis: exact retries are no-ops and conflicts fail.
 */
declare function recordReviewResolution(review: ActiveReview, ownerEpoch: string, resolution: ReviewResolutionState, updatedAt: number): ActiveReview;
declare const autolabDomainSpec: {
  name: string;
  version: number;
  tables: {
    labs: _deepseek_ai_dsh_storage_domain0.DomainTableSpec<string, {
      schemaVersion: 1;
      labId: string;
      runtimeRevision: number;
      ownerEpoch: string;
      controllerSessionId: string;
      lifecycle: "configuring" | "draft_ready" | "ready" | "starting" | "running" | "pausing" | "paused" | "blocked" | "stopped";
      roles: Record<string, {
        sessionId: string;
        phase: "starting" | "pausing" | "paused" | "blocked" | "declared" | "working" | "reviewing";
        binding?: {
          path: string;
          hash: string;
        } | undefined;
        packet?: {
          path: string;
          hash: string;
        } | undefined;
        goalInstall?: {
          installId: string;
          assignmentId: string;
          objectiveHash: string;
          maxGoalRounds: number;
          status: "pending" | "activating" | "applied";
          goalId?: string | undefined;
          goalRevision?: number | undefined;
        } | undefined;
        receipt?: {
          assignmentId: string;
          path: string;
          hash: string;
          recordedAt: number;
        } | undefined;
        activationBlocker?: {
          code: "WORKTREE_PROVISION_FAILED" | "ROLE_ACTIVATION_FAILED" | "GOAL_INSTALL_FAILED";
          message: string;
        } | undefined;
      }>;
      reviews: Record<string, {
        stage: "preflight" | "postflight";
        phase: "reviewing" | "error" | "verdict_recorded" | "result_recorded";
        sourcePacket: {
          path: string;
          hash: string;
        };
        packetPath: string;
        artifactPath: string;
        capability: {
          version: 1;
          reviewId: string;
          assignmentId: string;
          configRevision: number;
          runtimeRevision: number;
          ownerFence: string;
          workerRoleId: string;
          workerSessionId: string;
          judgeRoleId: string;
          judgeSessionId: string;
          packetHash: string;
          artifactHash: string;
          negotiatedAnchorHash: string;
          sourceTurn: number;
          expectedGoalRef: {
            id: string;
            revision: number;
          } | null;
          request: {
            controlId: string;
            payloadHash: string;
          };
          acceptedPause: {
            controlId: string;
            payloadHash: string;
          };
        };
        pause: {
          controlId: string;
          payloadHash: string;
          freeze: "stopped" | "pending" | "hold-pending" | "held" | "stale" | "user-override";
          completedAt?: number | undefined;
          goalOutcome?: "paused" | "stale" | "already-applied" | "no-active-goal" | undefined;
          activeTurn?: boolean | undefined;
          observedTurn?: number | undefined;
          goalRef?: {
            id: string;
            revision: number;
          } | undefined;
          holdOwnerEpoch?: string | undefined;
          detail?: string | undefined;
        };
        createdAt: number;
        updatedAt: number;
        verdict?: {
          path: string;
          hash: string;
          assignmentId: string;
          reviewInputHash: string;
          topLevelVerdict: "APPROVED" | "REVISION_REQUIRED" | "REJECTED" | "REVIEW_ERROR";
          recordedAt: number;
        } | undefined;
        result?: {
          path: string;
          hash: string;
          assignmentId: string;
          reviewInputHash: string;
          recordedAt: number;
        } | undefined;
        resolution?: {
          version: 1;
          reviewId: string;
          verdictHash: string;
          targetRoleId: string;
          targetSessionId: string;
          effect: {
            kind: string;
            id: string;
            hash: string;
          };
          resolutionHash: string;
        } | undefined;
      }>;
      candidates: Record<string, {
        version: 1;
        sourceRevision: number;
        laneId: string;
        candidateId: string;
        coderRoleId: string;
        coderSessionId: string;
        assignmentId: string;
        candidateSha: string;
        captureReceipt: {
          path: string;
          hash: string;
        };
        frozenAt: number;
        reviewId?: string | undefined;
        sourceReport?: {
          path: string;
          hash: string;
        } | undefined;
      }>;
      retiredCandidates: Record<string, {
        version: 1;
        sourceRevision: number;
        laneId: string;
        candidateId: string;
        coderRoleId: string;
        coderSessionId: string;
        assignmentId: string;
        candidateSha: string;
        captureReceipt: {
          path: string;
          hash: string;
        };
        frozenAt: number;
        reviewId?: string | undefined;
        sourceReport?: {
          path: string;
          hash: string;
        } | undefined;
      }>;
      trials: Record<string, {
        version: 1;
        sourceRevision: number;
        laneId: string;
        candidateId: string;
        candidateSha: string;
        contract: {
          path: string;
          hash: string;
        };
        runSlots: Record<string, {
          contract: {
            path: string;
            hash: string;
          };
          state: {
            revision: 0;
            status: "pending";
            version: 1;
            runslot_id: string;
            trial_id: string;
            runslot_contract_sha256: string;
          } | {
            status: "attempt_active";
            revision: number;
            attempt_id: string;
            attempt_ordinal: number;
            attempt_identity_sha256: string;
            attempt_ids: string[];
            launch_nonces: string[];
            version: 1;
            runslot_id: string;
            trial_id: string;
            runslot_contract_sha256: string;
          } | {
            status: "outcome_unknown";
            revision: number;
            attempt_id: string;
            attempt_ordinal: number;
            attempt_identity_sha256: string;
            attempt_ids: string[];
            launch_nonces: string[];
            version: 1;
            runslot_id: string;
            trial_id: string;
            runslot_contract_sha256: string;
          } | {
            status: "retryable";
            revision: number;
            attempt_id: string;
            attempt_ordinal: number;
            attempt_identity_sha256: string;
            attempt_ids: string[];
            launch_nonces: string[];
            version: 1;
            runslot_id: string;
            trial_id: string;
            runslot_contract_sha256: string;
          } | {
            status: "execution_complete";
            revision: number;
            attempt_id: string;
            attempt_ordinal: number;
            attempt_identity_sha256: string;
            attempt_ids: string[];
            launch_nonces: string[];
            version: 1;
            runslot_id: string;
            trial_id: string;
            runslot_contract_sha256: string;
          };
          activeAttempt?: {
            attemptId: string;
            phase: "running" | "outcome_unknown" | "launching" | "terminal";
            path: string;
            hash: string;
            checkout?: {
              path: string;
              hash: string;
            } | undefined;
          } | undefined;
        }>;
      }>;
      createdAt: number;
      updatedAt: number;
      controllerGoal?: {
        installId: string;
        assignmentId: string;
        objectiveHash: string;
        maxGoalRounds: number;
        status: "pending" | "activating" | "applied";
        roleId: string;
        packetHash: string;
        goalId?: string | undefined;
        goalRevision?: number | undefined;
        waiting?: true | undefined;
      } | undefined;
      config?: {
        revision: number;
        specHash: string;
        configHash: string;
        manifestHash: string;
        dialogueHeadHash: string;
        revisionPath: string;
      } | undefined;
      revealState?: "sealed" | "revealed" | undefined;
      blocker?: {
        code: string;
        message: string;
      } | undefined;
    }>;
    api_recoveries: _deepseek_ai_dsh_storage_domain0.DomainTableSpec<string, ApiRecoveryRecord>;
  };
};
declare class AutoLabStateError extends Error {
  readonly code: 'LAB_NOT_FOUND' | 'REVISION_CONFLICT' | 'OWNER_FENCE_LOST' | 'INVALID_TRANSITION' | 'INVALID_STATE';
  readonly name = "AutoLabStateError";
  constructor(message: string, code: 'LAB_NOT_FOUND' | 'REVISION_CONFLICT' | 'OWNER_FENCE_LOST' | 'INVALID_TRANSITION' | 'INVALID_STATE');
}
declare function createRuntimeState(input: {
  labId: string;
  ownerEpoch: string;
  controllerSessionId: string;
  lifecycle: 'configuring' | 'draft_ready' | 'ready';
  config?: ConfigRef;
  revealState?: RuntimeState['revealState'];
  now?: number;
}): RuntimeState;
declare function transitionRuntimeState(current: RuntimeState, input: {
  expectedRevision: number;
  ownerEpoch: string;
  lifecycle: LabLifecycle;
  config?: ConfigRef | null;
  revealState?: RuntimeState['revealState'];
  controllerGoal?: RuntimeState['controllerGoal'] | null;
  roles?: RuntimeState['roles'];
  reviews?: RuntimeState['reviews'];
  candidates?: RuntimeState['candidates'];
  retiredCandidates?: RuntimeState['retiredCandidates'];
  trials?: RuntimeState['trials'];
  blocker?: RuntimeState['blocker'] | null;
  now?: number;
}): RuntimeState;
declare function adoptRuntimeOwner(current: RuntimeState, ownerEpoch: string, now?: number): RuntimeState;
declare function parseState(value: unknown): RuntimeState;
declare function validateLabId(value: string): string;
//#endregion
//#region src/integrity.d.ts
declare function sha256(value: Uint8Array | string): string;
/** Stable JSON bytes for hashes and durable identities; never calls an LLM. */
declare function canonicalJson(value: unknown): string;
//#endregion
//#region src/manifest.d.ts
declare const roleBindingSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
  role_kind: z.ZodLiteral<"controller">;
  max_goal_rounds: z.ZodNumber;
  prebound_session_id: z.ZodString;
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
  prompt_sha256: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
  role_kind: z.ZodLiteral<"method">;
  max_goal_rounds: z.ZodNumber;
  lane_id: z.ZodString;
  worktree_path: z.ZodString;
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
  prompt_sha256: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
  role_kind: z.ZodLiteral<"coder">;
  max_goal_rounds: z.ZodNumber;
  lane_id: z.ZodString;
  worktree_path: z.ZodString;
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
  prompt_sha256: z.ZodString;
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
  prompt_sha256: z.ZodString;
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
  prompt_sha256: z.ZodString;
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
  prompt_sha256: z.ZodString;
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
  prompt_sha256: z.ZodString;
}, z.core.$strict>], "role_kind">;
declare const resolvedManifestSchema: z.ZodObject<{
  schema_version: z.ZodLiteral<1>;
  lab_id: z.ZodString;
  source_revision: z.ZodNumber;
  campaign_contract_sha256: z.ZodString;
  anchors: z.ZodObject<{
    dialogue_head_sha256: z.ZodString;
    lab_spec_sha256: z.ZodString;
    lab_yaml_sha256: z.ZodString;
  }, z.core.$strict>;
  authority_paths: z.ZodObject<{
    lab_dir: z.ZodString;
    creation_log: z.ZodString;
    lab_spec: z.ZodString;
    lab_yaml: z.ZodString;
    resolved_manifest: z.ZodString;
    fact_set: z.ZodString;
    evidence_index: z.ZodString;
    assignment_root: z.ZodString;
    worktree_root: z.ZodString;
  }, z.core.$strict>;
  versions: z.ZodObject<{
    autolab_plugin: z.ZodString;
    dsh: z.ZodString;
  }, z.core.$strict>;
  repository: z.ZodObject<{
    path: z.ZodString;
    base_ref: z.ZodString;
    base_sha: z.ZodString;
  }, z.core.$strict>;
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
    lane_count: z.ZodNumber;
    coordinator_enabled: z.ZodBoolean;
    lane_charters: z.ZodArray<z.ZodObject<{
      lane_id: z.ZodString;
      charter_sha256: z.ZodString;
      content: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
    }, z.core.$strict>>;
  }, z.core.$strict>;
  lanes: z.ZodArray<z.ZodObject<{
    lane_id: z.ZodString;
    worktree_path: z.ZodString;
    base_ref: z.ZodString;
    base_sha: z.ZodString;
    method_role_id: z.ZodString;
    coder_role_id: z.ZodString;
    preflight_judge_role_id: z.ZodString;
    postflight_judge_role_id: z.ZodString;
  }, z.core.$strict>>;
  roles: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
    role_kind: z.ZodLiteral<"controller">;
    max_goal_rounds: z.ZodNumber;
    prebound_session_id: z.ZodString;
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
    prompt_sha256: z.ZodString;
  }, z.core.$strict>, z.ZodObject<{
    role_kind: z.ZodLiteral<"method">;
    max_goal_rounds: z.ZodNumber;
    lane_id: z.ZodString;
    worktree_path: z.ZodString;
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
    prompt_sha256: z.ZodString;
  }, z.core.$strict>, z.ZodObject<{
    role_kind: z.ZodLiteral<"coder">;
    max_goal_rounds: z.ZodNumber;
    lane_id: z.ZodString;
    worktree_path: z.ZodString;
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
    prompt_sha256: z.ZodString;
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
    prompt_sha256: z.ZodString;
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
    prompt_sha256: z.ZodString;
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
    prompt_sha256: z.ZodString;
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
    prompt_sha256: z.ZodString;
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
    run_root: z.ZodString;
    contract: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
  }, z.core.$strict>;
  evidence: z.ZodObject<{
    artifact_root: z.ZodString;
    contract: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
  }, z.core.$strict>;
  communication: z.ZodObject<{
    topology: z.ZodEnum<{
      lane_isolated: "lane_isolated";
      coordinated: "coordinated";
    }>;
    acl_revision: z.ZodNumber;
    controller_visibility: z.ZodLiteral<"global">;
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
type RoleBinding = z.infer<typeof roleBindingSchema>;
type ResolvedManifest = z.infer<typeof resolvedManifestSchema>;
declare class ManifestValidationError extends Error {
  readonly issues: readonly z.core.$ZodIssue[];
  readonly name = "ManifestValidationError";
  readonly code = "INVALID_MANIFEST";
  constructor(message: string, issues: readonly z.core.$ZodIssue[]);
}
declare function parseResolvedManifest(value: unknown): ResolvedManifest;
declare function hashResolvedManifest(value: unknown): string;
//#endregion
//#region src/artifacts.d.ts
interface FrozenRevision {
  readonly ref: ConfigRef;
  readonly spec: string;
  readonly config: string;
  readonly manifest: ResolvedManifest;
  readonly validation: RevisionValidation;
}
interface RevisionValidation {
  readonly version: 1;
  readonly hashAlgorithm: 'sha256';
  readonly manifestCanonicalization: 'autolab-canonical-json-v1';
  readonly dialogueHeadHash: string;
  readonly specHash: string;
  readonly configHash: string;
  readonly manifestHash: string;
}
interface LabScaffold {
  readonly labId: string;
  readonly directory: string;
  readonly draft: DraftSnapshot;
  readonly imported: boolean;
}
interface DraftSnapshot {
  readonly spec: string;
  readonly config: string;
  readonly specHash: string;
  readonly configHash: string;
}
declare class ArtifactError extends Error {
  readonly code: 'LAB_EXISTS' | 'LAB_NOT_FOUND' | 'REVISION_EXISTS' | 'REVISION_MISSING' | 'HASH_MISMATCH' | 'INVALID_SOURCE' | 'INVALID_CURRENT';
  readonly name = "ArtifactError";
  constructor(message: string, code: 'LAB_EXISTS' | 'LAB_NOT_FOUND' | 'REVISION_EXISTS' | 'REVISION_MISSING' | 'HASH_MISMATCH' | 'INVALID_SOURCE' | 'INVALID_CURRENT');
}
declare class ArtifactStore {
  readonly root: string;
  readonly labsRoot: string;
  constructor(root: string);
  initialize(): Promise<void>;
  labDirectory(labId: string): string;
  createLab(input: {
    labId: string;
    controllerSessionId: string;
    sourceDirectory?: string;
    now?: number;
  }): Promise<LabScaffold>;
  readDraft(labId: string): Promise<DraftSnapshot>;
  freezeDraftRevision(input: {
    labId: string;
    revision: number;
    manifest: ResolvedManifest;
    dialogueHeadHash: string;
  }): Promise<FrozenRevision>;
  /** Exact rollback for a create transaction that never reached RuntimeState. */
  discardScaffold(labId: string): Promise<void>;
  freezeImportedRevision(labId: string, sourceDirectory: string, revision: number, manifest: ResolvedManifest, dialogueHeadHash: string): Promise<FrozenRevision>;
  readCurrent(labId: string): Promise<FrozenRevision>;
  /** Return no revision only when CURRENT is genuinely absent. */
  readCurrentIfPresent(labId: string): Promise<FrozenRevision | undefined>;
  private freezeRevision;
}
declare function generateLabId(now?: Date): string;
declare function durableWriteFile(path: string, value: Uint8Array | string, replace: boolean): Promise<void>;
//#endregion
//#region src/packet.d.ts
declare const verbatimBlockSchema: z.ZodObject<{
  block_id: z.ZodString;
  source_path: z.ZodString;
  exact_text: z.ZodString;
  text_sha256: z.ZodString;
  byte_range: z.ZodOptional<z.ZodObject<{
    start: z.ZodNumber;
    end: z.ZodNumber;
  }, z.core.$strict>>;
}, z.core.$strict>;
declare const compileInputSchema: z.ZodObject<{
  manifest: z.ZodObject<{
    schema_version: z.ZodLiteral<1>;
    lab_id: z.ZodString;
    source_revision: z.ZodNumber;
    campaign_contract_sha256: z.ZodString;
    anchors: z.ZodObject<{
      dialogue_head_sha256: z.ZodString;
      lab_spec_sha256: z.ZodString;
      lab_yaml_sha256: z.ZodString;
    }, z.core.$strict>;
    authority_paths: z.ZodObject<{
      lab_dir: z.ZodString;
      creation_log: z.ZodString;
      lab_spec: z.ZodString;
      lab_yaml: z.ZodString;
      resolved_manifest: z.ZodString;
      fact_set: z.ZodString;
      evidence_index: z.ZodString;
      assignment_root: z.ZodString;
      worktree_root: z.ZodString;
    }, z.core.$strict>;
    versions: z.ZodObject<{
      autolab_plugin: z.ZodString;
      dsh: z.ZodString;
    }, z.core.$strict>;
    repository: z.ZodObject<{
      path: z.ZodString;
      base_ref: z.ZodString;
      base_sha: z.ZodString;
    }, z.core.$strict>;
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
      lane_count: z.ZodNumber;
      coordinator_enabled: z.ZodBoolean;
      lane_charters: z.ZodArray<z.ZodObject<{
        lane_id: z.ZodString;
        charter_sha256: z.ZodString;
        content: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
      }, z.core.$strict>>;
    }, z.core.$strict>;
    lanes: z.ZodArray<z.ZodObject<{
      lane_id: z.ZodString;
      worktree_path: z.ZodString;
      base_ref: z.ZodString;
      base_sha: z.ZodString;
      method_role_id: z.ZodString;
      coder_role_id: z.ZodString;
      preflight_judge_role_id: z.ZodString;
      postflight_judge_role_id: z.ZodString;
    }, z.core.$strict>>;
    roles: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
      role_kind: z.ZodLiteral<"controller">;
      max_goal_rounds: z.ZodNumber;
      prebound_session_id: z.ZodString;
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
      prompt_sha256: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
      role_kind: z.ZodLiteral<"method">;
      max_goal_rounds: z.ZodNumber;
      lane_id: z.ZodString;
      worktree_path: z.ZodString;
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
      prompt_sha256: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
      role_kind: z.ZodLiteral<"coder">;
      max_goal_rounds: z.ZodNumber;
      lane_id: z.ZodString;
      worktree_path: z.ZodString;
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
      prompt_sha256: z.ZodString;
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
      prompt_sha256: z.ZodString;
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
      prompt_sha256: z.ZodString;
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
      prompt_sha256: z.ZodString;
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
      prompt_sha256: z.ZodString;
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
      run_root: z.ZodString;
      contract: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
    }, z.core.$strict>;
    evidence: z.ZodObject<{
      artifact_root: z.ZodString;
      contract: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
    }, z.core.$strict>;
    communication: z.ZodObject<{
      topology: z.ZodEnum<{
        lane_isolated: "lane_isolated";
        coordinated: "coordinated";
      }>;
      acl_revision: z.ZodNumber;
      controller_visibility: z.ZodLiteral<"global">;
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
  role_id: z.ZodString;
  session_id: z.ZodString;
  assignment_id: z.ZodString;
  issued_at: z.ZodNumber;
  role_binding_receipt_sha256: z.ZodString;
  runtime_revision: z.ZodNumber;
  fact_set_sha256: z.ZodString;
  evidence_index_sha256: z.ZodString;
  assignment_contract_sha256: z.ZodString;
  reveal_state: z.ZodEnum<{
    sealed: "sealed";
    revealed: "revealed";
  }>;
  verbatim_blocks: z.ZodObject<{
    universal: z.ZodArray<z.ZodObject<{
      block_id: z.ZodString;
      source_path: z.ZodString;
      exact_text: z.ZodString;
      text_sha256: z.ZodString;
      byte_range: z.ZodOptional<z.ZodObject<{
        start: z.ZodNumber;
        end: z.ZodNumber;
      }, z.core.$strict>>;
    }, z.core.$strict>>;
    role: z.ZodArray<z.ZodObject<{
      block_id: z.ZodString;
      source_path: z.ZodString;
      exact_text: z.ZodString;
      text_sha256: z.ZodString;
      byte_range: z.ZodOptional<z.ZodObject<{
        start: z.ZodNumber;
        end: z.ZodNumber;
      }, z.core.$strict>>;
    }, z.core.$strict>>;
    lane: z.ZodArray<z.ZodObject<{
      block_id: z.ZodString;
      source_path: z.ZodString;
      exact_text: z.ZodString;
      text_sha256: z.ZodString;
      byte_range: z.ZodOptional<z.ZodObject<{
        start: z.ZodNumber;
        end: z.ZodNumber;
      }, z.core.$strict>>;
    }, z.core.$strict>>;
    stage: z.ZodArray<z.ZodObject<{
      block_id: z.ZodString;
      source_path: z.ZodString;
      exact_text: z.ZodString;
      text_sha256: z.ZodString;
      byte_range: z.ZodOptional<z.ZodObject<{
        start: z.ZodNumber;
        end: z.ZodNumber;
      }, z.core.$strict>>;
    }, z.core.$strict>>;
    assignment: z.ZodArray<z.ZodObject<{
      block_id: z.ZodString;
      source_path: z.ZodString;
      exact_text: z.ZodString;
      text_sha256: z.ZodString;
      byte_range: z.ZodOptional<z.ZodObject<{
        start: z.ZodNumber;
        end: z.ZodNumber;
      }, z.core.$strict>>;
    }, z.core.$strict>>;
  }, z.core.$strict>;
  incumbent: z.ZodOptional<z.ZodObject<{
    ref: z.ZodString;
    sha256: z.ZodString;
  }, z.core.$strict>>;
  relevant_fact_refs: z.ZodArray<z.ZodObject<{
    id: z.ZodString;
    sha256: z.ZodString;
  }, z.core.$strict>>;
  evidence_refs: z.ZodArray<z.ZodObject<{
    id: z.ZodString;
    sha256: z.ZodString;
  }, z.core.$strict>>;
  open_obligation_refs: z.ZodArray<z.ZodString>;
  input_artifact_refs: z.ZodArray<z.ZodObject<{
    artifact_id: z.ZodString;
    path: z.ZodString;
    sha256: z.ZodString;
  }, z.core.$strict>>;
  output_contract: z.ZodObject<{
    schema: z.ZodJSONSchema;
    receipt_path: z.ZodString;
    expected_hash_binding: z.ZodString;
  }, z.core.$strict>;
}, z.core.$strict>;
declare const rolePacketSchema: z.ZodObject<{
  header: z.ZodObject<{
    packet_schema_version: z.ZodLiteral<1>;
    lab_id: z.ZodString;
    lane_id: z.ZodNullable<z.ZodString>;
    role_id: z.ZodString;
    role_kind: z.ZodEnum<{
      method: "method";
      coder: "coder";
      preflight_judge: "preflight_judge";
      postflight_judge: "postflight_judge";
      ops: "ops";
      coordinator: "coordinator";
      controller: "controller";
    }>;
    session_id: z.ZodString;
    assignment_id: z.ZodString;
    issued_at: z.ZodNumber;
  }, z.core.$strict>;
  anchors: z.ZodObject<{
    source_revision: z.ZodNumber;
    dialogue_head_sha256: z.ZodString;
    lab_spec_sha256: z.ZodString;
    lab_yaml_sha256: z.ZodString;
    resolved_manifest_sha256: z.ZodString;
    campaign_contract_sha256: z.ZodString;
    role_binding_receipt_sha256: z.ZodString;
    runtime_revision: z.ZodNumber;
    fact_set_sha256: z.ZodString;
    evidence_index_sha256: z.ZodString;
    assignment_contract_sha256: z.ZodString;
  }, z.core.$strict>;
  authority_paths: z.ZodObject<{
    lab_dir: z.ZodString;
    creation_log: z.ZodString;
    lab_spec: z.ZodString;
    lab_yaml: z.ZodString;
    resolved_manifest: z.ZodString;
    fact_set: z.ZodString;
    evidence_index: z.ZodString;
    assignment_root: z.ZodString;
    worktree_root: z.ZodString;
    repository: z.ZodString;
    artifact_root: z.ZodString;
    run_root: z.ZodString;
  }, z.core.$strict>;
  role_binding: z.ZodObject<{
    prompt_sha256: z.ZodString;
    lane_charter_sha256: z.ZodNullable<z.ZodString>;
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
    reasoning: z.ZodObject<{
      mode: z.ZodString;
      config: z.ZodRecord<z.ZodString, z.ZodJSONSchema>;
    }, z.core.$strict>;
  }, z.core.$strict>;
  verbatim_blocks: z.ZodObject<{
    universal: z.ZodArray<z.ZodObject<{
      block_id: z.ZodString;
      source_path: z.ZodString;
      exact_text: z.ZodString;
      text_sha256: z.ZodString;
      byte_range: z.ZodOptional<z.ZodObject<{
        start: z.ZodNumber;
        end: z.ZodNumber;
      }, z.core.$strict>>;
    }, z.core.$strict>>;
    role: z.ZodArray<z.ZodObject<{
      block_id: z.ZodString;
      source_path: z.ZodString;
      exact_text: z.ZodString;
      text_sha256: z.ZodString;
      byte_range: z.ZodOptional<z.ZodObject<{
        start: z.ZodNumber;
        end: z.ZodNumber;
      }, z.core.$strict>>;
    }, z.core.$strict>>;
    lane: z.ZodArray<z.ZodObject<{
      block_id: z.ZodString;
      source_path: z.ZodString;
      exact_text: z.ZodString;
      text_sha256: z.ZodString;
      byte_range: z.ZodOptional<z.ZodObject<{
        start: z.ZodNumber;
        end: z.ZodNumber;
      }, z.core.$strict>>;
    }, z.core.$strict>>;
    stage: z.ZodArray<z.ZodObject<{
      block_id: z.ZodString;
      source_path: z.ZodString;
      exact_text: z.ZodString;
      text_sha256: z.ZodString;
      byte_range: z.ZodOptional<z.ZodObject<{
        start: z.ZodNumber;
        end: z.ZodNumber;
      }, z.core.$strict>>;
    }, z.core.$strict>>;
    assignment: z.ZodArray<z.ZodObject<{
      block_id: z.ZodString;
      source_path: z.ZodString;
      exact_text: z.ZodString;
      text_sha256: z.ZodString;
      byte_range: z.ZodOptional<z.ZodObject<{
        start: z.ZodNumber;
        end: z.ZodNumber;
      }, z.core.$strict>>;
    }, z.core.$strict>>;
  }, z.core.$strict>;
  runtime_snapshot: z.ZodObject<{
    reveal_state: z.ZodEnum<{
      sealed: "sealed";
      revealed: "revealed";
    }>;
    incumbent: z.ZodOptional<z.ZodObject<{
      ref: z.ZodString;
      sha256: z.ZodString;
    }, z.core.$strict>>;
    relevant_fact_refs: z.ZodArray<z.ZodObject<{
      id: z.ZodString;
      sha256: z.ZodString;
    }, z.core.$strict>>;
    evidence_refs: z.ZodArray<z.ZodObject<{
      id: z.ZodString;
      sha256: z.ZodString;
    }, z.core.$strict>>;
    open_obligation_refs: z.ZodArray<z.ZodString>;
    input_artifact_refs: z.ZodArray<z.ZodObject<{
      artifact_id: z.ZodString;
      path: z.ZodString;
      sha256: z.ZodString;
    }, z.core.$strict>>;
  }, z.core.$strict>;
  capability_scope: z.ZodObject<{
    tools: z.ZodArray<z.ZodString>;
    worktree: z.ZodNullable<z.ZodString>;
    dsh_preset_ref: z.ZodEnum<{
      "read-only": "read-only";
      "workspace-write": "workspace-write";
      "danger-full-access": "danger-full-access";
    }>;
    communication: z.ZodObject<{
      acl_revision: z.ZodNumber;
      topology: z.ZodEnum<{
        lane_isolated: "lane_isolated";
        coordinated: "coordinated";
      }>;
      controller_visibility: z.ZodLiteral<"global">;
      send: z.ZodBoolean;
      receive: z.ZodBoolean;
      text_method_coder_within_lane: z.ZodEnum<{
        blocked: "blocked";
        allowed: "allowed";
      }>;
      text_cross_lane_before_reveal: z.ZodEnum<{
        blocked: "blocked";
        allowed: "allowed";
      }>;
      text_cross_lane_after_reveal: z.ZodEnum<{
        blocked: "blocked";
        allowed: "allowed";
      }>;
      reveal_trigger: z.ZodEnum<{
        manual: "manual";
        cohort_barrier: "cohort_barrier";
        immediate: "immediate";
      }>;
      text_pair_blocks: z.ZodArray<z.ZodObject<{
        other_role_id: z.ZodString;
        active_when: z.ZodEnum<{
          before_reveal: "before_reveal";
          after_reveal: "after_reveal";
          always: "always";
        }>;
      }, z.core.$strict>>;
    }, z.core.$strict>;
  }, z.core.$strict>;
  output_contract: z.ZodObject<{
    schema: z.ZodJSONSchema;
    receipt_path: z.ZodString;
    expected_hash_binding: z.ZodString;
  }, z.core.$strict>;
}, z.core.$strict>;
type VerbatimBlock = z.infer<typeof verbatimBlockSchema>;
type RolePacket = z.infer<typeof rolePacketSchema>;
type CompileRolePacketInput = z.input<typeof compileInputSchema>;
interface CompiledRolePacket {
  readonly packet: RolePacket;
  readonly canonicalJson: string;
  readonly packetHash: string;
}
declare class PacketValidationError extends Error {
  readonly issues: readonly z.core.$ZodIssue[];
  readonly name = "PacketValidationError";
  readonly code = "INVALID_PACKET";
  constructor(message: string, issues?: readonly z.core.$ZodIssue[]);
}
declare function compileRolePacket(value: CompileRolePacketInput): CompiledRolePacket;
declare function parseRolePacket(value: unknown): RolePacket;
declare function hashRolePacket(value: unknown): string;
//#endregion
//#region src/preflight-verdict.d.ts
declare const blockingFindingSchema: z.ZodObject<{
  rule_or_frozen_field: z.ZodString;
  blocked_transition: z.ZodString;
  conflict_or_missing_evidence: z.ZodString;
}, z.core.$strict>;
declare const preflightVerdictSchema: z.ZodObject<{
  version: z.ZodLiteral<1>;
  review_id: z.ZodString;
  assignment_id: z.ZodString;
  review_input_sha256: z.ZodString;
  top_level_verdict: z.ZodEnum<{
    APPROVED: "APPROVED";
    REVISION_REQUIRED: "REVISION_REQUIRED";
    REJECTED: "REJECTED";
    REVIEW_ERROR: "REVIEW_ERROR";
  }>;
  blocking_findings: z.ZodArray<z.ZodObject<{
    rule_or_frozen_field: z.ZodString;
    blocked_transition: z.ZodString;
    conflict_or_missing_evidence: z.ZodString;
  }, z.core.$strict>>;
  reasons: z.ZodArray<z.ZodString>;
  warnings: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
type PreflightTopLevelVerdict = z.infer<typeof preflightVerdictSchema>['top_level_verdict'];
type PreflightBlockingFinding = z.infer<typeof blockingFindingSchema>;
type PreflightVerdict = z.infer<typeof preflightVerdictSchema>;
interface FreezePreflightVerdictInput {
  /** Absolute path of the CURRENT Preflight Judge Role Packet. */
  readonly rolePacketPath: string;
  /** Hash recorded by Controller for the exact Role Packet bytes. */
  readonly rolePacketHash: string;
  /** Controller-owned immutable destination for the raw Judge receipt. */
  readonly artifactPath: string;
}
interface FrozenPreflightVerdict {
  readonly rolePacketPath: string;
  readonly rolePacketHash: string;
  /** The receipt path declared by the Role Packet output contract. */
  readonly receiptPath: string;
  readonly artifactPath: string;
  readonly receiptHash: string;
  /** Exact bytes copied to the immutable artifact, without JSON re-encoding. */
  readonly receiptBytes: Buffer;
  readonly packet: RolePacket;
  readonly verdict: PreflightVerdict;
}
declare class PreflightVerdictError extends Error {
  readonly code: 'INVALID_INPUT' | 'PACKET_READ_FAILED' | 'PACKET_HASH_MISMATCH' | 'INVALID_PACKET' | 'ROLE_MISMATCH' | 'OUTPUT_CONTRACT_MISMATCH' | 'RECEIPT_READ_FAILED' | 'INVALID_RECEIPT' | 'REVIEW_BINDING_MISMATCH' | 'ARTIFACT_WRITE_FAILED' | 'ARTIFACT_CONFLICT';
  readonly issues: readonly z.core.$ZodIssue[];
  readonly name = "PreflightVerdictError";
  constructor(message: string, code: 'INVALID_INPUT' | 'PACKET_READ_FAILED' | 'PACKET_HASH_MISMATCH' | 'INVALID_PACKET' | 'ROLE_MISMATCH' | 'OUTPUT_CONTRACT_MISMATCH' | 'RECEIPT_READ_FAILED' | 'INVALID_RECEIPT' | 'REVIEW_BINDING_MISMATCH' | 'ARTIFACT_WRITE_FAILED' | 'ARTIFACT_CONFLICT', issues?: readonly z.core.$ZodIssue[]);
}
/** Parse one strict, model-produced Preflight receipt without adding policy gates. */
declare function parsePreflightVerdict(value: unknown): PreflightVerdict;
/**
 * Read the receipt path declared by the exact Judge Role Packet, validate its
 * identity and output contract, then freeze the original receipt bytes into the
 * Controller-owned destination. The destination is append/no-clobber only:
 * identical retries succeed, different bytes fail.
 */
declare function freezePreflightVerdict(input: FreezePreflightVerdictInput): Promise<FrozenPreflightVerdict>;
/** Explicit artifact-named alias for callers that use the storage vocabulary. */
declare const freezePreflightVerdictArtifact: typeof freezePreflightVerdict;
declare const parsePreflightVerdictArtifact: typeof parsePreflightVerdict;
//#endregion
export { activeCandidateSchema as $, ResolvedManifest as A, ActiveTrial as B, DraftSnapshot as C, transitionRuntimeState as Ct, durableWriteFile as D, RevisionValidation as E, roleBindingSchema as F, LAB_ID_PATTERN as G, CONTROL_PAYLOAD_HASH_PATTERN as H, canonicalJson as I, ReviewResolutionError as J, LabLifecycle as K, sha256 as L, hashResolvedManifest as M, parseResolvedManifest as N, generateLabId as O, resolvedManifestSchema as P, SHA256_PATTERN as Q, ActiveCandidate as R, ArtifactStore as S, runtimeStateSchema as St, LabScaffold as T, ConfigRef as U, AutoLabStateError as V, ControllerGoalState as W, RoleState as X, ReviewResolutionState as Y, RuntimeState as Z, hashRolePacket as _, reviewResultStateSchema as _t, PreflightVerdict as a, controllerGoalSchema as at, verbatimBlockSchema as b, rolePhaseSchema as bt, freezePreflightVerdictArtifact as c, labLifecycleSchema as ct, CompileRolePacketInput as d, resolutionHash as dt, activeReviewSchema as et, CompiledRolePacket as f, reviewCapabilityStateSchema as ft, compileRolePacket as g, reviewResolutionStateSchema as gt, VerbatimBlock as h, reviewReadyToAdvance as ht, PreflightTopLevelVerdict as i, configRefSchema as it, RoleBinding as j, ManifestValidationError as k, parsePreflightVerdict as l, parseState as lt, RolePacket as m, reviewPauseStateSchema as mt, FrozenPreflightVerdict as n, adoptRuntimeOwner as nt, PreflightVerdictError as o, createRuntimeState as ot, PacketValidationError as p, reviewFreezeComplete as pt, ReviewResolutionBody as q, PreflightBlockingFinding as r, autolabDomainSpec as rt, freezePreflightVerdict as s, goalInstallSchema as st, FreezePreflightVerdictInput as t, activeTrialSchema as tt, parsePreflightVerdictArtifact as u, recordReviewResolution as ut, parseRolePacket as v, reviewVerdictStateSchema as vt, FrozenRevision as w, validateLabId as wt, ArtifactError as x, roleStateSchema as xt, rolePacketSchema as y, roleActivationBlockerSchema as yt, ActiveReview as z };