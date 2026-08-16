import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'

import type { LabLifecycle, RuntimeState } from './state.js'

export const CONTROLLER_KERNEL_SECTION = 'autolab:controller-kernel'
export const CONTROLLER_KERNEL_ORDER = 20

export interface ControllerReadResult {
  readonly labId: string
  readonly lifecycle: LabLifecycle
  readonly directory: string
  /** Decimal committed revision, or `draft` before the first commit. */
  readonly revision: string
  readonly labSpec: string
  readonly labYaml: string
}

export interface ControllerStatusResult {
  readonly labId: string
  readonly stateJson: string
}

export interface ControllerActionResult {
  readonly labId: string
  readonly lifecycle: LabLifecycle
  readonly runtimeRevision: number
}

export interface ControllerWaitResult {
  readonly labId: string
  readonly outcome: 'paused' | 'already-paused' | 'no-goal'
}

export interface ControllerLaunchAttemptInput {
  readonly labId: string
  readonly laneId: string
  readonly trialId: string
  readonly trialContractJson: string
  readonly runSlotsJson: string
  readonly selectedRunSlotId: string
  readonly hostId: string
  readonly commandJson: string
  readonly envJson: string
}

export interface ControllerLaunchAttemptResult {
  readonly labId: string
  readonly trialId: string
  readonly runSlotId: string
  readonly attemptId: string
  readonly phase: 'launching' | 'running' | 'outcome_unknown' | 'terminal'
}

export interface ControllerRetryAttemptInput {
  readonly labId: string
  readonly trialId: string
  readonly runSlotId: string
  readonly hostId: string
  readonly commandJson: string
  readonly envJson: string
}

export interface ControllerApplyPreflightInput {
  readonly labId: string
  readonly reviewId: string
}

export interface ControllerApplyPreflightResult {
  readonly labId: string
  readonly reviewId: string
  readonly coderRoleId: string
  readonly assignmentId: string
  readonly phase: 'coder_working'
}

export interface ControllerRequestPostflightInput {
  readonly labId: string
  readonly trialId: string
  readonly runSlotId: string
}

export interface ControllerRequestPostflightResult {
  readonly labId: string
  readonly reviewId: string
  readonly assignmentId: string
  readonly coderRoleId: string
  readonly judgeRoleId: string
  readonly phase: 'reviewing' | 'result_recorded'
}

export interface ControllerAssignRoleInput {
  readonly labId: string
  readonly roleId: string
  readonly assignmentId: string
  readonly objective: string
  readonly contentJson: string
  readonly outputSchemaJson: string
  readonly inputArtifactRefsJson: string
}

export interface ControllerAssignRoleResult {
  readonly labId: string
  readonly roleId: string
  readonly assignmentId: string
  readonly phase: 'working' | 'receipt_recorded'
}

export interface ControllerAssignMethodInput {
  readonly labId: string
  readonly methodRoleId: string
  readonly assignmentId: string
  readonly objective: string
  readonly contentJson: string
  readonly inputArtifactRefsJson: string
  /** Selects the exact REVISION_REQUIRED or REJECTED Preflight review resolved here. */
  readonly sourceReviewId?: string
}

export interface ControllerAssignMethodResult {
  readonly labId: string
  readonly methodRoleId: string
  readonly assignmentId: string
  readonly sourceReviewId?: string
  readonly phase: 'working'
}

export interface ControllerAssignCoderFixInput {
  readonly labId: string
  readonly coderRoleId: string
  /** Must be `coder:<reviewId>:fix:<slug>`: the lineage APPROVED review of the candidate being fixed. */
  readonly assignmentId: string
  readonly objective: string
  /** Opaque fix mandate; must carry a non-empty `candidate_id` for the corrected candidate. */
  readonly contentJson: string
  readonly inputArtifactRefsJson: string
}

export interface ControllerAssignCoderFixResult {
  readonly labId: string
  readonly coderRoleId: string
  readonly assignmentId: string
  readonly reviewId: string
  readonly phase: 'working'
}

export interface ControllerRegisterUserDirectiveInput {
  readonly labId: string
  /** Unique immutable fact id, e.g. `user-directive-20260816-recipe-23`. */
  readonly factId: string
  /** Fact kind; Controller-authored, e.g. `user_directive`. */
  readonly kind: string
  /** The directive text being registered; keep the user's wording verbatim. */
  readonly statement: string
  /** Provenance: where and when the user decision was made. */
  readonly source: string
  /** Evidence status of this fact, e.g. `user-authorized`. */
  readonly evidenceStatus: string
}

export interface ControllerRegisterUserDirectiveResult {
  readonly labId: string
  readonly factPath: string
  readonly factSetSha256: string
  readonly factIndex: number
  readonly runtimeRevision: number
}

export interface ControllerRevealResult {
  readonly labId: string
  readonly revealState: 'revealed'
  readonly runtimeRevision: number
}

export interface ControllerSurfaceRuntime {
  readForController(
    caller: Agent,
    labId: string,
    signal?: AbortSignal,
  ): Promise<ControllerReadResult>
  status(caller: Agent, labId: string): RuntimeState
  start(caller: Agent, labId: string, signal?: AbortSignal): Promise<RuntimeState>
  pause(caller: Agent, labId: string, signal?: AbortSignal): Promise<RuntimeState>
  resume(caller: Agent, labId: string, signal?: AbortSignal): Promise<RuntimeState>
  stop(caller: Agent, labId: string, signal?: AbortSignal): Promise<RuntimeState>
  waitController(
    caller: Agent,
    labId: string,
    signal?: AbortSignal,
  ): Promise<ControllerWaitResult>
  launchAttempt(
    caller: Agent,
    input: ControllerLaunchAttemptInput,
    signal?: AbortSignal,
  ): Promise<ControllerLaunchAttemptResult>
  retryAttempt(
    caller: Agent,
    input: ControllerRetryAttemptInput,
    signal?: AbortSignal,
  ): Promise<ControllerLaunchAttemptResult>
  applyPreflight(
    caller: Agent,
    input: ControllerApplyPreflightInput,
    signal?: AbortSignal,
  ): Promise<ControllerApplyPreflightResult>
  requestPostflight(
    caller: Agent,
    input: ControllerRequestPostflightInput,
    signal?: AbortSignal,
  ): Promise<ControllerRequestPostflightResult>
  assignRole(
    caller: Agent,
    input: ControllerAssignRoleInput,
    signal?: AbortSignal,
  ): Promise<ControllerAssignRoleResult>
  assignMethod(
    caller: Agent,
    input: ControllerAssignMethodInput,
    signal?: AbortSignal,
  ): Promise<ControllerAssignMethodResult>
  assignCoderFix(
    caller: Agent,
    input: ControllerAssignCoderFixInput,
    signal?: AbortSignal,
  ): Promise<ControllerAssignCoderFixResult>
  registerUserDirective(
    caller: Agent,
    input: ControllerRegisterUserDirectiveInput,
    signal?: AbortSignal,
  ): Promise<ControllerRegisterUserDirectiveResult>
  reveal(
    caller: Agent,
    labId: string,
    signal?: AbortSignal,
  ): Promise<ControllerRevealResult>
}

const labIdParameter = {
  labId: {
    type: 'string' as const,
    required: true as const,
    description: 'Exact AutoLab lab_id owned by this Controller Session.',
  },
}

const actionOutput = {
  schema: {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
      labId: { type: 'string' as const, required: true as const },
      lifecycle: { type: 'string' as const, required: true as const },
      runtimeRevision: { type: 'number' as const, required: true as const },
    },
  },
  render: (_args: unknown, value: ControllerActionResult) => [{
    type: 'text' as const,
    text: `AutoLab ${value.labId}: ${value.lifecycle} at RuntimeState ${value.runtimeRevision}`,
  }],
}

/**
 * Add only the Controller-specific surface to the user's existing Agent scope.
 * No global restriction, replacement Agent, loop, or background monitor exists.
 */
export function installControllerSurface(
  agent: Agent,
  runtime: ControllerSurfaceRuntime,
  kernelText: () => string,
): () => void {
  const disposers: Array<() => void> = []
  try {
    disposers.push(agent.ctx.systemPrompt.section({
      name: CONTROLLER_KERNEL_SECTION,
      order: CONTROLLER_KERNEL_ORDER,
      text: kernelText,
    }))

    disposers.push(agent.ctx.tools.register(defineTool({
      name: 'AutoLabRead',
      description: 'Read the complete authoritative LAB_SPEC.md and lab.yaml for one AutoLab. This returns original bytes as text; it never substitutes a summary.',
      parameters: labIdParameter,
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            labId: { type: 'string', required: true },
            lifecycle: { type: 'string', required: true },
            directory: { type: 'string', required: true },
            revision: { type: 'string', required: true },
            labSpec: { type: 'string', required: true },
            labYaml: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: [
            `AutoLab ${value.labId} (${value.lifecycle}, revision ${value.revision})`,
            `Lab directory: ${value.directory}`,
            '----- BEGIN LAB_SPEC.md (verbatim) -----',
            value.labSpec,
            '----- END LAB_SPEC.md -----',
            '----- BEGIN lab.yaml (verbatim) -----',
            value.labYaml,
            '----- END lab.yaml -----',
          ].join('\n'),
        }],
      },
      async execute(args, exec) {
        requireInstalledCaller(agent, exec.agent, 'AutoLabRead')
        return await runtime.readForController(agent, args.labId, exec.signal)
      },
    })))

    disposers.push(agent.ctx.tools.register(defineTool({
      name: 'AutoLabStatus',
      description: 'Read the small materialized RuntimeState for one AutoLab without scanning logs, checkpoints, metrics, or experiment directories.',
      parameters: labIdParameter,
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            labId: { type: 'string', required: true },
            stateJson: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.stateJson }],
      },
      async execute(args, exec) {
        requireInstalledCaller(agent, exec.agent, 'AutoLabStatus')
        const state = runtime.status(agent, args.labId)
        return { labId: state.labId, stateJson: JSON.stringify(state, null, 2) }
      },
    })))

    for (const definition of [
      controllerActionTool(agent, 'AutoLabStart', 'Start an AutoLab from its committed CURRENT revision.',
        (labId, signal) => runtime.start(agent, labId, signal)),
      controllerActionTool(agent, 'AutoLabPause', 'Pause automatic work in an AutoLab without deleting its Sessions, Goals, originals, or history.',
        (labId, signal) => runtime.pause(agent, labId, signal)),
      controllerActionTool(agent, 'AutoLabResume', 'Resume the same AutoLab Sessions and native Goals from their durable state.',
        (labId, signal) => runtime.resume(agent, labId, signal)),
      controllerActionTool(agent, 'AutoLabStop', 'Stop an AutoLab only after its native Goals are durably paused; preserve all originals and history.',
        (labId, signal) => runtime.stop(agent, labId, signal)),
    ]) {
      disposers.push(agent.ctx.tools.register(definition))
    }

    disposers.push(agent.ctx.tools.register(defineTool({
      name: 'AutoLabReveal',
      description: 'Explicitly reveal a sealed AutoLab cohort and reconcile its configured communication ACL. This is one-way for the current revision and performs no comparison or promotion.',
      parameters: labIdParameter,
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            labId: { type: 'string', required: true },
            revealState: { type: 'string', required: true, const: 'revealed' },
            runtimeRevision: { type: 'number', required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `AutoLab ${value.labId}: revealed at RuntimeState ${value.runtimeRevision}`,
        }],
      },
      async execute(args, exec) {
        requireInstalledCaller(agent, exec.agent, 'AutoLabReveal')
        return await runtime.reveal(agent, args.labId, exec.signal)
      },
    })))

    disposers.push(agent.ctx.tools.register(defineTool({
      name: 'AutoLabApplyPreflight',
      description: 'Apply one explicitly selected APPROVED Preflight verdict by installing its exact Coder Assignment and native Goal. Runtime performs no comparison or scientific route selection.',
      parameters: {
        ...labIdParameter,
        reviewId: { type: 'string', required: true },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            labId: { type: 'string', required: true },
            reviewId: { type: 'string', required: true },
            coderRoleId: { type: 'string', required: true },
            assignmentId: { type: 'string', required: true },
            phase: { type: 'string', required: true, const: 'coder_working' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `AutoLab ${value.labId} review ${value.reviewId}: ${value.coderRoleId} is working on ${value.assignmentId}`,
        }],
      },
      async execute(args, exec) {
        requireInstalledCaller(agent, exec.agent, 'AutoLabApplyPreflight')
        return await runtime.applyPreflight(agent, args, exec.signal)
      },
    })))

    disposers.push(agent.ctx.tools.register(defineTool({
      name: 'AutoLabAssignMethod',
      description: 'Install one explicit Controller-authored Method Assignment on its existing Method Session. Supply sourceReviewId only to resolve that exact REVISION_REQUIRED or REJECTED Preflight review; Runtime binds the frozen verdict automatically. Omit it to start the next Method Assignment from a paused Method. Runtime performs no scientific route selection.',
      parameters: {
        ...labIdParameter,
        methodRoleId: { type: 'string', required: true },
        assignmentId: { type: 'string', required: true },
        objective: { type: 'string', required: true },
        contentJson: { type: 'string', required: true },
        inputArtifactRefsJson: {
          type: 'string',
          required: true,
          description: 'JSON array of {artifact_id, path, sha256}; Runtime does not open referenced targets.',
        },
        sourceReviewId: {
          type: 'string',
          description: 'Exact REVISION_REQUIRED or REJECTED Preflight review to resolve. Omit for a paused Method next Assignment.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            labId: { type: 'string', required: true },
            methodRoleId: { type: 'string', required: true },
            assignmentId: { type: 'string', required: true },
            sourceReviewId: { type: 'string' },
            phase: { type: 'string', required: true, const: 'working' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `AutoLab ${value.labId} ${value.methodRoleId} Method Assignment ${value.assignmentId}: ${value.phase}${value.sourceReviewId === undefined ? '' : ` (resolved ${value.sourceReviewId})`}`,
        }],
      },
      async execute(args, exec) {
        requireInstalledCaller(agent, exec.agent, 'AutoLabAssignMethod')
        return await runtime.assignMethod(agent, args, exec.signal)
      },
    })))

    disposers.push(agent.ctx.tools.register(defineTool({
      name: 'AutoLabAssignCoderFix',
      description: 'Install one explicit Controller-authored implementation-fix Assignment on a paused Coder that owns its Lane active candidate. The fix inherits the candidate lineage APPROVED Preflight review (design ticket + verdict) as provenance, supersedes the active candidate, and lets the Coder freeze a corrected candidate through the ordinary SubmitCoderImplementation path. No Preflight review is fabricated and no scientific route is selected. assignmentId must be coder:<reviewId>:fix:<slug> and contentJson must carry a non-empty candidate_id.',
      parameters: {
        ...labIdParameter,
        coderRoleId: { type: 'string', required: true },
        assignmentId: { type: 'string', required: true },
        objective: { type: 'string', required: true },
        contentJson: {
          type: 'string',
          required: true,
          description: 'Opaque fix mandate JSON; must carry a non-empty candidate_id string.',
        },
        inputArtifactRefsJson: {
          type: 'string',
          required: true,
          description: 'JSON array of {artifact_id, path, sha256}; Runtime does not open referenced targets.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            labId: { type: 'string', required: true },
            coderRoleId: { type: 'string', required: true },
            assignmentId: { type: 'string', required: true },
            reviewId: { type: 'string', required: true },
            phase: { type: 'string', required: true, const: 'working' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `AutoLab ${value.labId} ${value.coderRoleId} Coder fix Assignment ${value.assignmentId}: ${value.phase} (lineage ${value.reviewId})`,
        }],
      },
      async execute(args, exec) {
        requireInstalledCaller(agent, exec.agent, 'AutoLabAssignCoderFix')
        return await runtime.assignCoderFix(agent, args, exec.signal)
      },
    })))

    disposers.push(agent.ctx.tools.register(defineTool({
      name: 'AutoLabRegisterUserDirective',
      description: 'Register one explicit user decision as an immutable, additive fact in the Lab fact set (facts.json). Facts carry verbatim statement, source, and evidence status, and every packet compiled afterwards anchors the updated fact set, making the decision visible to Judges in the anchored record chain. Runtime performs no scientific interpretation of the directive.',
      parameters: {
        ...labIdParameter,
        factId: { type: 'string', required: true },
        kind: {
          type: 'string',
          required: true,
          description: 'Fact kind, e.g. "user_directive".',
        },
        statement: {
          type: 'string',
          required: true,
          description: 'The directive text being registered; keep the user wording verbatim.',
        },
        source: {
          type: 'string',
          required: true,
          description: 'Provenance: where and when the user decision was made.',
        },
        evidenceStatus: {
          type: 'string',
          required: true,
          description: 'Evidence status of this fact, e.g. "user-authorized".',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            labId: { type: 'string', required: true },
            factPath: { type: 'string', required: true },
            factSetSha256: { type: 'string', required: true },
            factIndex: { type: 'number', required: true },
            runtimeRevision: { type: 'number', required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `AutoLab ${value.labId} registered fact #${value.factIndex} in ${value.factPath} (fact set sha256 ${value.factSetSha256})`,
        }],
      },
      async execute(args, exec) {
        requireInstalledCaller(agent, exec.agent, 'AutoLabRegisterUserDirective')
        return await runtime.registerUserDirective(agent, args, exec.signal)
      },
    })))

    disposers.push(agent.ctx.tools.register(defineTool({
      name: 'AutoLabAssignRole',
      description: 'Install one explicit Controller-authored Assignment on an Ops or enabled Coordinator role. Method keeps its dedicated Method-to-Preflight protocol. Content, output schema, and input references are opaque JSON; Runtime performs no routing or scientific interpretation.',
      parameters: {
        ...labIdParameter,
        roleId: { type: 'string', required: true },
        assignmentId: { type: 'string', required: true },
        objective: { type: 'string', required: true },
        contentJson: { type: 'string', required: true },
        outputSchemaJson: { type: 'string', required: true },
        inputArtifactRefsJson: {
          type: 'string',
          required: true,
          description: 'JSON array of {artifact_id, path, sha256}; Runtime does not open referenced targets.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            labId: { type: 'string', required: true },
            roleId: { type: 'string', required: true },
            assignmentId: { type: 'string', required: true },
            phase: {
              type: 'string',
              required: true,
              enum: ['working', 'receipt_recorded'],
            },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `AutoLab ${value.labId} ${value.roleId} Assignment ${value.assignmentId}: ${value.phase}`,
        }],
      },
      async execute(args, exec) {
        requireInstalledCaller(agent, exec.agent, 'AutoLabAssignRole')
        return await runtime.assignRole(agent, args, exec.signal)
      },
    })))

    disposers.push(agent.ctx.tools.register(defineTool({
      name: 'AutoLabLaunchAttempt',
      description: 'Freeze one Controller-selected opaque Trial/RunSlot contract and launch its exact local Attempt from the active Lane Candidate. Contract, RunSlot, command, and environment arguments are JSON text; Runtime derives Candidate, CURRENT, checkout, and Attempt identities and does not interpret scientific content.',
      parameters: {
        ...labIdParameter,
        laneId: { type: 'string', required: true },
        trialId: { type: 'string', required: true },
        trialContractJson: { type: 'string', required: true },
        runSlotsJson: {
          type: 'string',
          required: true,
          description: 'JSON array of {"runSlotId": string, "contract"?: any}.',
        },
        selectedRunSlotId: { type: 'string', required: true },
        hostId: { type: 'string', required: true },
        commandJson: {
          type: 'string',
          required: true,
          description: 'JSON array of command argv strings; no shell parsing is applied.',
        },
        envJson: {
          type: 'string',
          required: true,
          description: 'JSON object containing the exact experiment environment.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            labId: { type: 'string', required: true },
            trialId: { type: 'string', required: true },
            runSlotId: { type: 'string', required: true },
            attemptId: { type: 'string', required: true },
            phase: {
              type: 'string',
              required: true,
              enum: ['launching', 'running', 'outcome_unknown', 'terminal'],
            },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `AutoLab ${value.labId} Trial ${value.trialId} RunSlot ${value.runSlotId}: Attempt ${value.attemptId} is ${value.phase}`,
        }],
      },
      async execute(args, exec) {
        requireInstalledCaller(agent, exec.agent, 'AutoLabLaunchAttempt')
        return await runtime.launchAttempt(agent, args, exec.signal)
      },
    })))

    disposers.push(agent.ctx.tools.register(defineTool({
      name: 'AutoLabRetryAttempt',
      description: 'Create one explicit technical retry in the same Trial/RunSlot after a mechanically recorded failed Attempt. Runtime preserves lineage and uses the supplied host, argv, and environment without inspecting checkpoints or deciding scientific meaning.',
      parameters: {
        ...labIdParameter,
        trialId: { type: 'string', required: true },
        runSlotId: { type: 'string', required: true },
        hostId: { type: 'string', required: true },
        commandJson: {
          type: 'string',
          required: true,
          description: 'JSON array of exact argv strings; no shell parsing is applied.',
        },
        envJson: {
          type: 'string',
          required: true,
          description: 'JSON object containing the exact retry environment.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            labId: { type: 'string', required: true },
            trialId: { type: 'string', required: true },
            runSlotId: { type: 'string', required: true },
            attemptId: { type: 'string', required: true },
            phase: {
              type: 'string',
              required: true,
              enum: ['launching', 'running', 'outcome_unknown', 'terminal'],
            },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `AutoLab ${value.labId} Trial ${value.trialId} RunSlot ${value.runSlotId}: retry Attempt ${value.attemptId} is ${value.phase}`,
        }],
      },
      async execute(args, exec) {
        requireInstalledCaller(agent, exec.agent, 'AutoLabRetryAttempt')
        return await runtime.retryAttempt(agent, args, exec.signal)
      },
    })))

    disposers.push(agent.ctx.tools.register(defineTool({
      name: 'AutoLabRequestPostflight',
      description: 'Request Postflight review for one exact Controller-selected Trial/RunSlot active Attempt. Runtime binds the current Coder, Judge, original artifacts, review pause, and Lab-authored output contract without interpreting experiment content.',
      parameters: {
        ...labIdParameter,
        trialId: { type: 'string', required: true },
        runSlotId: { type: 'string', required: true },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            labId: { type: 'string', required: true },
            reviewId: { type: 'string', required: true },
            assignmentId: { type: 'string', required: true },
            coderRoleId: { type: 'string', required: true },
            judgeRoleId: { type: 'string', required: true },
            phase: {
              type: 'string',
              required: true,
              enum: ['reviewing', 'result_recorded'],
            },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `AutoLab ${value.labId} Postflight ${value.reviewId}: ${value.phase} (${value.coderRoleId} -> ${value.judgeRoleId})`,
        }],
      },
      async execute(args, exec) {
        requireInstalledCaller(agent, exec.agent, 'AutoLabRequestPostflight')
        return await runtime.requestPostflight(agent, args, exec.signal)
      },
    })))

    disposers.push(agent.ctx.tools.register(defineTool({
      name: 'AutoLabWait',
      description: 'Durably pause this Controller Goal at a real waiting point. Runtime will resume it from the exact Judge, Attempt, recovery, or user event; this tool does not poll.',
      parameters: labIdParameter,
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            labId: { type: 'string', required: true },
            outcome: {
              type: 'string',
              required: true,
              enum: ['paused', 'already-paused', 'no-goal'],
            },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `AutoLab ${value.labId} Controller wait: ${value.outcome}`,
        }],
      },
      async execute(args, exec) {
        requireInstalledCaller(agent, exec.agent, 'AutoLabWait')
        const result = await runtime.waitController(agent, args.labId, exec.signal)
        exec.concludeTurn()
        return result
      },
    })))
  } catch (error) {
    disposeAll(disposers)
    throw error
  }

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    disposeAll(disposers)
  }
}

function controllerActionTool(
  agent: Agent,
  name: 'AutoLabStart' | 'AutoLabPause' | 'AutoLabResume' | 'AutoLabStop',
  description: string,
  action: (labId: string, signal: AbortSignal) => Promise<RuntimeState>,
) {
  return defineTool({
    name,
    description,
    parameters: labIdParameter,
    output: actionOutput,
    async execute(args, exec) {
      requireInstalledCaller(agent, exec.agent, name)
      const state = await action(args.labId, exec.signal)
      return controllerActionResult(state)
    },
  })
}

function controllerActionResult(state: RuntimeState): ControllerActionResult {
  return {
    labId: state.labId,
    lifecycle: state.lifecycle,
    runtimeRevision: state.runtimeRevision,
  }
}

function requireInstalledCaller(
  installed: Agent,
  caller: Agent | undefined,
  toolName: string,
): void {
  if (caller !== installed || installed.ctx.agents.get(installed.id) !== installed) {
    throw new Error(`${toolName} requires the exact live Controller Agent`)
  }
}

function disposeAll(disposers: Array<() => void>): void {
  const errors: unknown[] = []
  for (const dispose of disposers.splice(0).reverse()) {
    try {
      dispose()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'AutoLab Controller surface disposal failed')
}
