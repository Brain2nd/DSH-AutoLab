/** Narrow model submission tools over the AutoLab Controller service. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

export const name = 'tool-autolab-submission'
export const inject = ['tools', 'autolab']

export type PreflightTopLevelVerdict =
  | 'APPROVED'
  | 'REVISION_REQUIRED'
  | 'REJECTED'
  | 'REVIEW_ERROR'

export interface MethodPreflightReviewStatus {
  readonly labId: string
  readonly roleId: string
  readonly assignmentId: string
  readonly reviewId: string
  readonly phase: 'reviewing'
}

export interface PreflightVerdictStatus {
  readonly labId: string
  readonly roleId: string
  readonly assignmentId: string
  readonly reviewId: string
  readonly phase: 'verdict_recorded' | 'error'
  readonly verdict: PreflightTopLevelVerdict
}

export interface CoderImplementationStatus {
  readonly labId: string
  readonly roleId: string
  readonly assignmentId: string
  readonly candidateId: string
  readonly candidateSha: string
  readonly phase: 'candidate_frozen'
}

export interface PostflightResultStatus {
  readonly labId: string
  readonly roleId: string
  readonly assignmentId: string
  readonly reviewId: string
  readonly phase: 'result_recorded'
}

export interface AutoLabRoleResultStatus {
  readonly labId: string
  readonly roleId: string
  readonly assignmentId: string
  readonly phase: 'receipt_recorded'
}

/**
 * Keep the model surface coupled only to these identity-derived operations.
 * The Controller owns every path, hash, target Session, control capability,
 * and state transition.
 */
declare module './index.js' {
  interface AutoLabRuntime {
    submitMethodForPreflightReview(
      caller: Agent,
      signal?: AbortSignal,
    ): Promise<MethodPreflightReviewStatus>

    submitPreflightVerdict(
      caller: Agent,
      signal?: AbortSignal,
    ): Promise<PreflightVerdictStatus>

    submitCoderImplementation(
      caller: Agent,
      signal?: AbortSignal,
    ): Promise<CoderImplementationStatus>

    submitPostflightResult(
      caller: Agent,
      signal?: AbortSignal,
    ): Promise<PostflightResultStatus>

    submitAutoLabRoleResult(
      caller: Agent,
      signal?: AbortSignal,
    ): Promise<AutoLabRoleResultStatus>
  }
}

/** The exact Runtime surface the submission tools execute against. */
export interface SubmissionRuntime {
  submitMethodForPreflightReview(
    caller: Agent,
    signal?: AbortSignal,
  ): Promise<MethodPreflightReviewStatus>

  submitPreflightVerdict(
    caller: Agent,
    signal?: AbortSignal,
  ): Promise<PreflightVerdictStatus>

  submitCoderImplementation(
    caller: Agent,
    signal?: AbortSignal,
  ): Promise<CoderImplementationStatus>

  submitPostflightResult(
    caller: Agent,
    signal?: AbortSignal,
  ): Promise<PostflightResultStatus>

  submitAutoLabRoleResult(
    caller: Agent,
    signal?: AbortSignal,
  ): Promise<AutoLabRoleResultStatus>
}

const statusProperties = {
  labId: { type: 'string' as const, required: true as const },
  roleId: { type: 'string' as const, required: true as const },
  assignmentId: { type: 'string' as const, required: true as const },
  reviewId: { type: 'string' as const, required: true as const },
}

function requireExactCaller(agent: Agent | undefined, toolName: string): Agent {
  if (agent === undefined) {
    throw new Error(`${toolName} requires an exact calling Agent`)
  }
  return agent
}

/** DSH parameter roots are open; submission tools deliberately accept nothing. */
function requireNoArguments(args: Record<string, never>, toolName: string): void {
  if (Object.keys(args).length !== 0) {
    throw new Error(`${toolName} does not accept arguments`)
  }
}

/**
 * Register the five role submission tools and return their disposer.
 *
 * The AutoLab Runtime installs these itself at the top of its service
 * initialization — before it recovers any Lab and before it creates or
 * resumes any role Session — so role activation's `tools.restrict()` always
 * resolves them, including on the boot where the `tool-autolab-submission`
 * bundle entry cannot apply until the Runtime service has finished starting.
 *
 * Registration is idempotent: when the bundle entry later applies and finds a
 * name already present in the global tool view, it registers nothing.
 */
export function installSubmissionTools(
  ctx: Context,
  runtime: SubmissionRuntime,
): () => void {
  const register = (definition: ToolDefinition): (() => void) => {
    if (ctx.tools.get(definition.name) !== undefined) return () => undefined
    return ctx.tools.register(definition)
  }
  const disposers = [
    register(defineTool({
      name: 'SubmitMethodForPreflightReview',
      description: 'Submit the Method Design Ticket declared by your current AutoLab Role Packet for Preflight review. This tool takes no arguments: AutoLab derives the exact Lab, Method role, assignment, frozen receipt, Judge, and review identity from the calling Agent and durable Controller state.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ...statusProperties,
            phase: { type: 'string', required: true, const: 'reviewing' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `AutoLab ${value.labId} review ${value.reviewId}: ${value.phase} (${value.roleId}, ${value.assignmentId})`,
        }],
      },
      async execute(args, exec) {
        requireNoArguments(args, 'SubmitMethodForPreflightReview')
        const caller = requireExactCaller(exec.agent, 'SubmitMethodForPreflightReview')
        return await runtime.submitMethodForPreflightReview(caller, exec.signal)
      },
    })),

    register(defineTool({
      name: 'SubmitPreflightVerdict',
      description: 'Commit the Preflight verdict declared by your current AutoLab Judge Role Packet. This tool takes no arguments: AutoLab derives the exact Lab, Judge role, active review, verdict receipt, and frozen bindings from the calling Agent and durable Controller state.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ...statusProperties,
            phase: {
              type: 'string',
              required: true,
              enum: ['verdict_recorded', 'error'],
            },
            verdict: {
              type: 'string',
              required: true,
              enum: ['APPROVED', 'REVISION_REQUIRED', 'REJECTED', 'REVIEW_ERROR'],
            },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `AutoLab ${value.labId} review ${value.reviewId}: ${value.phase}, ${value.verdict} (${value.roleId}, ${value.assignmentId})`,
        }],
      },
      async execute(args, exec) {
        requireNoArguments(args, 'SubmitPreflightVerdict')
        const caller = requireExactCaller(exec.agent, 'SubmitPreflightVerdict')
        return await runtime.submitPreflightVerdict(caller, exec.signal)
      },
    })),

    register(defineTool({
      name: 'SubmitCoderImplementation',
      description: 'Submit the narrow implementation report declared by your current AutoLab Coder Role Packet. This tool takes no arguments: AutoLab derives the Lab, Lane, Assignment, APPROVED review, worktree, candidate snapshot, diff, and final receipt from the exact calling Agent and durable Controller state.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            labId: { type: 'string', required: true },
            roleId: { type: 'string', required: true },
            assignmentId: { type: 'string', required: true },
            candidateId: { type: 'string', required: true },
            candidateSha: { type: 'string', required: true },
            phase: {
              type: 'string',
              required: true,
              const: 'candidate_frozen',
            },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `AutoLab ${value.labId} candidate ${value.candidateId}: ${value.phase} at ${value.candidateSha} (${value.roleId}, ${value.assignmentId})`,
        }],
      },
      async execute(args, exec) {
        requireNoArguments(args, 'SubmitCoderImplementation')
        const caller = requireExactCaller(exec.agent, 'SubmitCoderImplementation')
        return await runtime.submitCoderImplementation(caller, exec.signal)
      },
    })),

    register(defineTool({
      name: 'SubmitPostflightResult',
      description: 'Commit the raw Postflight receipt declared by your current AutoLab Judge Role Packet. This tool takes no arguments: AutoLab derives the exact Lab, Judge, review, Packet, receipt path, and immutable binding from the calling Agent and never interprets scientific content.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ...statusProperties,
            phase: { type: 'string', required: true, const: 'result_recorded' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `AutoLab ${value.labId} review ${value.reviewId}: ${value.phase} (${value.roleId}, ${value.assignmentId})`,
        }],
      },
      async execute(args, exec) {
        requireNoArguments(args, 'SubmitPostflightResult')
        const caller = requireExactCaller(exec.agent, 'SubmitPostflightResult')
        return await runtime.submitPostflightResult(caller, exec.signal)
      },
    })),

    register(defineTool({
      name: 'SubmitAutoLabRoleResult',
      description: 'Commit the raw receipt declared by your current Controller-dispatched Ops or Coordinator Role Packet. This tool takes no arguments and preserves bytes without parsing the Lab-owned schema or following referenced artifacts.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            labId: { type: 'string', required: true },
            roleId: { type: 'string', required: true },
            assignmentId: { type: 'string', required: true },
            phase: { type: 'string', required: true, const: 'receipt_recorded' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `AutoLab ${value.labId} ${value.roleId} Assignment ${value.assignmentId}: ${value.phase}`,
        }],
      },
      async execute(args, exec) {
        requireNoArguments(args, 'SubmitAutoLabRoleResult')
        const caller = requireExactCaller(exec.agent, 'SubmitAutoLabRoleResult')
        return await runtime.submitAutoLabRoleResult(caller, exec.signal)
      },
    })),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/**
 * Legacy bundle entry. The AutoLab Runtime has already registered these tools
 * during its own service initialization; this apply is therefore an idempotent
 * no-op and only exists so a stale profile patch keeps loading cleanly.
 */
export function apply(ctx: Context): () => void {
  return installSubmissionTools(ctx, ctx.autolab)
}
