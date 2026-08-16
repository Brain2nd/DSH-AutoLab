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
function apply(ctx) {
	ctx.tools.register(defineTool({
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
			return await ctx.autolab.submitMethodForPreflightReview(caller, exec.signal);
		}
	}));
	ctx.tools.register(defineTool({
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
			return await ctx.autolab.submitPreflightVerdict(caller, exec.signal);
		}
	}));
	ctx.tools.register(defineTool({
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
			return await ctx.autolab.submitCoderImplementation(caller, exec.signal);
		}
	}));
	ctx.tools.register(defineTool({
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
			return await ctx.autolab.submitPostflightResult(caller, exec.signal);
		}
	}));
	ctx.tools.register(defineTool({
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
			return await ctx.autolab.submitAutoLabRoleResult(caller, exec.signal);
		}
	}));
}

//#endregion
export { apply, inject, name };