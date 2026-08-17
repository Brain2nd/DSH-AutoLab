import { Agent } from "@deepseek-ai/dsh-agent";
import { Context } from "@deepseek-ai/cordis";

//#region src/tool.d.ts
declare const name = "tool-autolab-submission";
declare const inject: string[];
type PreflightTopLevelVerdict = 'APPROVED' | 'REVISION_REQUIRED' | 'REJECTED' | 'REVIEW_ERROR';
interface MethodPreflightReviewStatus {
  readonly labId: string;
  readonly roleId: string;
  readonly assignmentId: string;
  readonly reviewId: string;
  readonly phase: 'reviewing';
}
interface PreflightVerdictStatus {
  readonly labId: string;
  readonly roleId: string;
  readonly assignmentId: string;
  readonly reviewId: string;
  readonly phase: 'verdict_recorded' | 'error';
  readonly verdict: PreflightTopLevelVerdict;
}
interface CoderImplementationStatus {
  readonly labId: string;
  readonly roleId: string;
  readonly assignmentId: string;
  readonly candidateId: string;
  readonly candidateSha: string;
  readonly phase: 'candidate_frozen';
}
interface PostflightResultStatus {
  readonly labId: string;
  readonly roleId: string;
  readonly assignmentId: string;
  readonly reviewId: string;
  readonly phase: 'result_recorded';
}
interface AutoLabRoleResultStatus {
  readonly labId: string;
  readonly roleId: string;
  readonly assignmentId: string;
  readonly phase: 'receipt_recorded';
}
/**
 * Keep the model surface coupled only to these identity-derived operations.
 * The Controller owns every path, hash, target Session, control capability,
 * and state transition.
 */
declare module './index.js' {
  interface AutoLabRuntime {
    submitMethodForPreflightReview(caller: Agent, signal?: AbortSignal): Promise<MethodPreflightReviewStatus>;
    submitPreflightVerdict(caller: Agent, signal?: AbortSignal): Promise<PreflightVerdictStatus>;
    submitCoderImplementation(caller: Agent, signal?: AbortSignal): Promise<CoderImplementationStatus>;
    submitPostflightResult(caller: Agent, signal?: AbortSignal): Promise<PostflightResultStatus>;
    submitAutoLabRoleResult(caller: Agent, signal?: AbortSignal): Promise<AutoLabRoleResultStatus>;
  }
}
/** The exact Runtime surface the submission tools execute against. */
interface SubmissionRuntime {
  submitMethodForPreflightReview(caller: Agent, signal?: AbortSignal): Promise<MethodPreflightReviewStatus>;
  submitPreflightVerdict(caller: Agent, signal?: AbortSignal): Promise<PreflightVerdictStatus>;
  submitCoderImplementation(caller: Agent, signal?: AbortSignal): Promise<CoderImplementationStatus>;
  submitPostflightResult(caller: Agent, signal?: AbortSignal): Promise<PostflightResultStatus>;
  submitAutoLabRoleResult(caller: Agent, signal?: AbortSignal): Promise<AutoLabRoleResultStatus>;
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
declare function installSubmissionTools(ctx: Context, runtime: SubmissionRuntime): () => void;
/**
 * Legacy bundle entry. The AutoLab Runtime has already registered these tools
 * during its own service initialization; this apply is therefore an idempotent
 * no-op and only exists so a stale profile patch keeps loading cleanly.
 */
declare function apply(ctx: Context): () => void;
//#endregion
export { PreflightTopLevelVerdict as a, apply as c, name as d, PostflightResultStatus as i, inject as l, CoderImplementationStatus as n, PreflightVerdictStatus as o, MethodPreflightReviewStatus as r, SubmissionRuntime as s, AutoLabRoleResultStatus as t, installSubmissionTools as u };