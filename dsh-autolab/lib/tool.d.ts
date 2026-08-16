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
declare function apply(ctx: Context): void;
//#endregion
export { AutoLabRoleResultStatus, CoderImplementationStatus, MethodPreflightReviewStatus, PostflightResultStatus, PreflightTopLevelVerdict, PreflightVerdictStatus, apply, inject, name };