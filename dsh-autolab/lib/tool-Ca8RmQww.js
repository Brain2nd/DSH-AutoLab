import { defineTool } from "@deepseek-ai/dsh-tools";

//#region src/tool.ts
const name = "tool-autolab-submission";
const inject = ["tools", "autolab"];
const statusProperties = {
	labId: {
		type: "string",
		required: true
	},
	roleId: {
		type: "string",
		required: true
	},
	assignmentId: {
		type: "string",
		required: true
	},
	reviewId: {
		type: "string",
		required: true
	}
};
function requireExactCaller(agent, toolName) {
	if (agent === void 0) throw new Error(`${toolName} requires an exact calling Agent`);
	return agent;
}
/** DSH parameter roots are open; submission tools deliberately accept nothing. */
function requireNoArguments(args, toolName) {
	if (Object.keys(args).length !== 0) throw new Error(`${toolName} does not accept arguments`);
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
function installSubmissionTools(ctx, runtime) {
	const register = (definition) => {
		if (ctx.tools.get(definition.name) !== void 0) return () => void 0;
		return ctx.tools.register(definition);
	};
	const disposers = [
		register(defineTool({
			name: "SubmitMethodForPreflightReview",
			description: "Submit the Method Design Ticket declared by your current AutoLab Role Packet for Preflight review. This tool takes no arguments: AutoLab derives the exact Lab, Method role, assignment, frozen receipt, Judge, and review identity from the calling Agent and durable Controller state.",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						...statusProperties,
						phase: {
							type: "string",
							required: true,
							const: "reviewing"
						}
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: `AutoLab ${value.labId} review ${value.reviewId}: ${value.phase} (${value.roleId}, ${value.assignmentId})`
				}]
			},
			async execute(args, exec) {
				requireNoArguments(args, "SubmitMethodForPreflightReview");
				const caller = requireExactCaller(exec.agent, "SubmitMethodForPreflightReview");
				return await runtime.submitMethodForPreflightReview(caller, exec.signal);
			}
		})),
		register(defineTool({
			name: "SubmitPreflightVerdict",
			description: "Commit the Preflight verdict declared by your current AutoLab Judge Role Packet. This tool takes no arguments: AutoLab derives the exact Lab, Judge role, active review, verdict receipt, and frozen bindings from the calling Agent and durable Controller state.",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						...statusProperties,
						phase: {
							type: "string",
							required: true,
							enum: ["verdict_recorded", "error"]
						},
						verdict: {
							type: "string",
							required: true,
							enum: [
								"APPROVED",
								"REVISION_REQUIRED",
								"REJECTED",
								"REVIEW_ERROR"
							]
						}
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: `AutoLab ${value.labId} review ${value.reviewId}: ${value.phase}, ${value.verdict} (${value.roleId}, ${value.assignmentId})`
				}]
			},
			async execute(args, exec) {
				requireNoArguments(args, "SubmitPreflightVerdict");
				const caller = requireExactCaller(exec.agent, "SubmitPreflightVerdict");
				return await runtime.submitPreflightVerdict(caller, exec.signal);
			}
		})),
		register(defineTool({
			name: "SubmitCoderImplementation",
			description: "Submit the narrow implementation report declared by your current AutoLab Coder Role Packet. This tool takes no arguments: AutoLab derives the Lab, Lane, Assignment, APPROVED review, worktree, candidate snapshot, diff, and final receipt from the exact calling Agent and durable Controller state.",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						labId: {
							type: "string",
							required: true
						},
						roleId: {
							type: "string",
							required: true
						},
						assignmentId: {
							type: "string",
							required: true
						},
						candidateId: {
							type: "string",
							required: true
						},
						candidateSha: {
							type: "string",
							required: true
						},
						phase: {
							type: "string",
							required: true,
							const: "candidate_frozen"
						}
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: `AutoLab ${value.labId} candidate ${value.candidateId}: ${value.phase} at ${value.candidateSha} (${value.roleId}, ${value.assignmentId})`
				}]
			},
			async execute(args, exec) {
				requireNoArguments(args, "SubmitCoderImplementation");
				const caller = requireExactCaller(exec.agent, "SubmitCoderImplementation");
				return await runtime.submitCoderImplementation(caller, exec.signal);
			}
		})),
		register(defineTool({
			name: "SubmitPostflightResult",
			description: "Commit the raw Postflight receipt declared by your current AutoLab Judge Role Packet. This tool takes no arguments: AutoLab derives the exact Lab, Judge, review, Packet, receipt path, and immutable binding from the calling Agent and never interprets scientific content.",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						...statusProperties,
						phase: {
							type: "string",
							required: true,
							const: "result_recorded"
						}
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: `AutoLab ${value.labId} review ${value.reviewId}: ${value.phase} (${value.roleId}, ${value.assignmentId})`
				}]
			},
			async execute(args, exec) {
				requireNoArguments(args, "SubmitPostflightResult");
				const caller = requireExactCaller(exec.agent, "SubmitPostflightResult");
				return await runtime.submitPostflightResult(caller, exec.signal);
			}
		})),
		register(defineTool({
			name: "SubmitAutoLabRoleResult",
			description: "Commit the raw receipt declared by your current Controller-dispatched Ops or Coordinator Role Packet. This tool takes no arguments and preserves bytes without parsing the Lab-owned schema or following referenced artifacts.",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						labId: {
							type: "string",
							required: true
						},
						roleId: {
							type: "string",
							required: true
						},
						assignmentId: {
							type: "string",
							required: true
						},
						phase: {
							type: "string",
							required: true,
							const: "receipt_recorded"
						}
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: `AutoLab ${value.labId} ${value.roleId} Assignment ${value.assignmentId}: ${value.phase}`
				}]
			},
			async execute(args, exec) {
				requireNoArguments(args, "SubmitAutoLabRoleResult");
				const caller = requireExactCaller(exec.agent, "SubmitAutoLabRoleResult");
				return await runtime.submitAutoLabRoleResult(caller, exec.signal);
			}
		}))
	];
	return () => {
		for (const dispose of disposers) dispose();
	};
}
/**
* Legacy bundle entry. The AutoLab Runtime has already registered these tools
* during its own service initialization; this apply is therefore an idempotent
* no-op and only exists so a stale profile patch keeps loading cleanly.
*/
function apply(ctx) {
	return installSubmissionTools(ctx, ctx.autolab);
}

//#endregion
export { name as i, inject as n, installSubmissionTools as r, apply as t };