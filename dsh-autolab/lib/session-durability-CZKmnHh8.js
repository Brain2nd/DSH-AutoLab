import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { z } from "zod";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { constants } from "node:fs";
import { execFile, spawnSync } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SessionId } from "@deepseek-ai/dsh-session";
import { GoalId } from "@deepseek-ai/dsh-goal";
import { controlPayloadHash } from "dsh-local-session-messaging";
import { canonicalJson } from "dsh-local-session-messaging/core";
import { parseDocument } from "yaml";
import { assembleContextFor, installModelSelection } from "@deepseek-ai/dsh-agent";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";

//#region src/integrity.ts
function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}
/** Stable JSON bytes for hashes and durable identities; never calls an LLM. */
function canonicalJson$1(value) {
	if (value === null) return "null";
	switch (typeof value) {
		case "string":
		case "boolean": return JSON.stringify(value);
		case "number":
			if (!Number.isFinite(value)) throw new TypeError("canonical JSON does not allow NaN or Infinity");
			return JSON.stringify(value);
		case "object": {
			if (Array.isArray(value)) {
				const items = [];
				for (let index = 0; index < value.length; index += 1) {
					if (!Object.hasOwn(value, index)) throw new TypeError("canonical JSON does not allow sparse arrays");
					items.push(canonicalJson$1(value[index]));
				}
				return `[${items.join(",")}]`;
			}
			const prototype = Object.getPrototypeOf(value);
			if (prototype !== Object.prototype && prototype !== null) throw new TypeError("canonical JSON accepts only plain objects");
			const record$1 = value;
			return `{${Object.keys(record$1).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson$1(record$1[key])}`).join(",")}}`;
		}
		default: throw new TypeError(`canonical JSON does not allow ${typeof value}`);
	}
}

//#endregion
//#region src/api-recovery-store.ts
const hash$4 = z.string().regex(/^[0-9a-f]{64}$/u);
const nonBlank$1 = z.string().min(1);
const failureSchema = z.object({
	message: z.string(),
	code: nonBlank$1,
	status: z.number().int().optional(),
	providerRetryAfterMs: z.number().finite().positive().optional(),
	requestId: nonBlank$1.optional()
}).strict();
const goalContinuationSchema = z.object({
	kind: z.literal("goal"),
	goalRef: z.object({
		id: nonBlank$1,
		revision: z.number().int().positive()
	}).strict(),
	objectiveHash: hash$4
}).strict();
const reviewContinuationSchema = z.object({
	kind: z.literal("review"),
	reviewId: nonBlank$1,
	reviewAnchorHash: hash$4
}).strict();
const continuationSchema = z.discriminatedUnion("kind", [goalContinuationSchema, reviewContinuationSchema]);
const base = {
	labId: nonBlank$1,
	roleId: nonBlank$1,
	sessionId: nonBlank$1,
	assignmentId: nonBlank$1,
	packetHash: hash$4,
	continuation: continuationSchema,
	turn: z.number().int().positive(),
	step: z.number().int().positive(),
	provider: nonBlank$1,
	failure: failureSchema,
	recordedAt: z.number().int().nonnegative(),
	unknownFallbackUsed: z.boolean()
};
const terminal = { terminalSeq: z.number().int().nonnegative() };
const rawApiRecoveryRecordSchema = z.discriminatedUnion("phase", [
	z.object({
		...base,
		phase: z.literal("awaiting-terminal")
	}).strict(),
	z.object({
		...base,
		...terminal,
		phase: z.literal("scheduled"),
		dueAt: z.number().int().nonnegative()
	}).strict(),
	z.object({
		...base,
		...terminal,
		phase: z.literal("recovering"),
		resumedContinuation: continuationSchema,
		resumedAt: z.number().int().nonnegative()
	}).strict(),
	z.object({
		...base,
		...terminal,
		phase: z.literal("operator")
	}).strict()
]);
/** Durable form of the one active API incident attached to a Session. */
const apiRecoveryRecordSchema = rawApiRecoveryRecordSchema.transform((value) => value);
/**
* Small adapter over one DSH domain table. Per-Session serialization makes the
* compare-before-delete contract exact: an old timer can never delete a newer
* incident, while unrelated Sessions remain independent.
*/
var DurableApiRecoveryStore = class {
	tails = /* @__PURE__ */ new Map();
	constructor(table) {
		this.table = table;
	}
	get(sessionId) {
		return this.table.get(sessionId);
	}
	list() {
		return [...this.table.entries()].map(([, record$1]) => record$1);
	}
	async put(record$1) {
		const value = apiRecoveryRecordSchema.parse(record$1);
		await this.enqueue(value.sessionId, async () => {
			await this.table.put(value.sessionId, value);
		});
	}
	async remove(expected) {
		const value = apiRecoveryRecordSchema.parse(expected);
		return await this.enqueue(value.sessionId, async () => {
			const current = this.table.get(value.sessionId);
			if (current === void 0 || canonicalJson$1(current) !== canonicalJson$1(value)) return false;
			return await this.table.delete(value.sessionId);
		});
	}
	async drain() {
		await Promise.allSettled([...this.tails.values()]);
	}
	enqueue(sessionId, operation) {
		const run$1 = (this.tails.get(sessionId) ?? Promise.resolve()).then(operation);
		const tail = run$1.then(() => void 0, () => void 0);
		this.tails.set(sessionId, tail);
		tail.finally(() => {
			if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId);
		});
		return run$1;
	}
};

//#endregion
//#region src/trial.ts
const SHA256_PATTERN$18 = /^[0-9a-f]{64}$/u;
const GIT_SHA_PATTERN$3 = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const id$2 = z.string().min(1);
const hash$3 = z.string().regex(SHA256_PATTERN$18);
const gitSha = z.string().regex(GIT_SHA_PATTERN$3);
const timestamp = z.number().int().nonnegative();
const positiveInteger = z.number().int().positive();
const absolutePath$4 = z.string().min(1).refine(isAbsolute, "path must be absolute");
const componentIdentitySchema = z.object({
	id: id$2,
	version: id$2,
	sha256: hash$3
}).strict();
const artifactReferenceSchema$1 = z.object({
	kind: z.enum([
		"artifact",
		"log",
		"checkpoint",
		"exit"
	]),
	path: absolutePath$4
}).strict();
const receiptReferenceSchema = z.object({
	path: absolutePath$4,
	sha256: hash$3
}).strict();
const runSlotSpecSchema = z.object({
	runslot_id: id$2,
	contract: z.json().optional()
}).strict();
const trialContractSchema = z.object({
	version: z.literal(1),
	trial_id: id$2,
	lane_id: id$2,
	candidate_sha: gitSha,
	config_revision: positiveInteger,
	contract: z.json(),
	run_slots: z.array(runSlotSpecSchema).min(1),
	created_at: timestamp
}).strict().superRefine((trial, context) => {
	rejectDuplicates(trial.run_slots.map((slot) => slot.runslot_id), "run_slots.runslot_id", context);
});
const runSlotContractSchema = z.object({
	version: z.literal(1),
	runslot_id: id$2,
	trial_id: id$2,
	trial_contract_sha256: hash$3,
	candidate_sha: gitSha,
	config_revision: positiveInteger,
	contract: z.json().optional()
}).strict();
const runSlotStateIdentityShape = {
	version: z.literal(1),
	runslot_id: id$2,
	trial_id: id$2,
	runslot_contract_sha256: hash$3
};
const pendingRunSlotStateSchema = z.object({
	...runSlotStateIdentityShape,
	revision: z.literal(0),
	status: z.literal("pending")
}).strict();
const occupiedRunSlotStateShape = {
	...runSlotStateIdentityShape,
	revision: positiveInteger,
	attempt_id: id$2,
	attempt_ordinal: positiveInteger,
	attempt_identity_sha256: hash$3,
	attempt_ids: z.array(id$2).min(1),
	launch_nonces: z.array(id$2).min(1)
};
const activeRunSlotStateSchema = z.object({
	...occupiedRunSlotStateShape,
	status: z.literal("attempt_active")
}).strict().superRefine(validateRunSlotHistory);
const unknownRunSlotStateSchema = z.object({
	...occupiedRunSlotStateShape,
	status: z.literal("outcome_unknown")
}).strict().superRefine(validateRunSlotHistory);
const retryableRunSlotStateSchema = z.object({
	...occupiedRunSlotStateShape,
	status: z.literal("retryable")
}).strict().superRefine(validateRunSlotHistory);
const completedRunSlotStateSchema = z.object({
	...occupiedRunSlotStateShape,
	status: z.literal("execution_complete")
}).strict().superRefine(validateRunSlotHistory);
const runSlotStateSchema = z.discriminatedUnion("status", [
	pendingRunSlotStateSchema,
	activeRunSlotStateSchema,
	unknownRunSlotStateSchema,
	retryableRunSlotStateSchema,
	completedRunSlotStateSchema
]);
const requestIdentitySchema = z.object({
	kind: z.enum(["command", "runner_request"]),
	sha256: hash$3
}).strict();
const gpuLeaseSchema = z.object({
	gpu_uuid: id$2,
	lease_id: id$2,
	fencing_token: z.number().int().nonnegative()
}).strict();
const remoteConnectionSchema = z.object({ connection_identity: id$2 }).strict();
const processIdentitySchema = z.object({
	pid: positiveInteger.optional(),
	pgid: positiveInteger.optional(),
	start_identity: id$2.optional(),
	host_boot_id: id$2.optional(),
	tmux_session: id$2.optional()
}).strict().refine((process$1) => Object.values(process$1).some((value) => value !== void 0), "process identity cannot be empty");
const attemptCommonShape = {
	version: z.literal(1),
	attempt_id: id$2,
	attempt_ordinal: positiveInteger,
	predecessor_attempt_id: id$2.optional(),
	trial_id: id$2,
	runslot_id: id$2,
	trial_contract_sha256: hash$3,
	runslot_contract_sha256: hash$3,
	candidate_sha: gitSha,
	config_revision: positiveInteger,
	request: requestIdentitySchema,
	cwd: absolutePath$4,
	env_sha256: hash$3,
	runner: componentIdentitySchema,
	host_id: id$2,
	launch_nonce: id$2,
	launched_at: timestamp,
	gpu_lease: gpuLeaseSchema.optional(),
	remote_connection: remoteConnectionSchema.optional(),
	adapter_checkpoint_identity: id$2.optional()
};
const technicalDetailSchema = z.object({
	kind: z.enum([
		"api",
		"hardware",
		"runner",
		"process",
		"transport",
		"cancelled",
		"unknown"
	]),
	code: id$2,
	detail: id$2.optional()
}).strict();
const launchingAttemptSchema = z.object({
	...attemptCommonShape,
	phase: z.literal("launching")
}).strict().superRefine(validateAttemptLineage);
const runningAttemptSchema = z.object({
	...attemptCommonShape,
	phase: z.literal("running"),
	started_at: timestamp,
	started_receipt: receiptReferenceSchema,
	process: processIdentitySchema.optional()
}).strict().superRefine((attempt, context) => {
	validateAttemptLineage(attempt, context);
	if (attempt.started_at < attempt.launched_at) context.addIssue({
		code: "custom",
		message: "started_at precedes launched_at"
	});
});
const outcomeUnknownAttemptSchema = z.object({
	...attemptCommonShape,
	phase: z.literal("outcome_unknown"),
	started_at: timestamp.optional(),
	started_receipt: receiptReferenceSchema.optional(),
	process: processIdentitySchema.optional(),
	unknown_since: timestamp,
	uncertainty_receipt: receiptReferenceSchema,
	technical_detail: technicalDetailSchema,
	incident: artifactReferenceSchema$1.optional()
}).strict().superRefine((attempt, context) => {
	validateAttemptLineage(attempt, context);
	if (attempt.started_at === void 0 !== (attempt.started_receipt === void 0)) context.addIssue({
		code: "custom",
		message: "started_at and started_receipt must be present together"
	});
	if (attempt.process !== void 0 && attempt.started_receipt === void 0) context.addIssue({
		code: "custom",
		message: "process identity requires a started receipt"
	});
	if (attempt.unknown_since < attempt.launched_at || attempt.started_at !== void 0 && attempt.unknown_since < attempt.started_at) context.addIssue({
		code: "custom",
		message: "outcome_unknown time is not monotonic"
	});
});
const terminalAttemptSchema = z.object({
	...attemptCommonShape,
	phase: z.literal("terminal"),
	started_at: timestamp.optional(),
	started_receipt: receiptReferenceSchema.optional(),
	process: processIdentitySchema.optional(),
	completed_at: timestamp,
	completion_identity: id$2,
	completion_receipt: receiptReferenceSchema,
	technical_outcome: z.enum(["succeeded", "failed"]),
	technical_detail: technicalDetailSchema.optional(),
	artifacts: z.array(artifactReferenceSchema$1)
}).strict().superRefine((attempt, context) => {
	validateAttemptLineage(attempt, context);
	if (attempt.started_at === void 0 !== (attempt.started_receipt === void 0)) context.addIssue({
		code: "custom",
		message: "started_at and started_receipt must be present together"
	});
	if (attempt.process !== void 0 && attempt.started_receipt === void 0) context.addIssue({
		code: "custom",
		message: "process identity requires a started receipt"
	});
	if (attempt.completed_at < attempt.launched_at || attempt.started_at !== void 0 && attempt.completed_at < attempt.started_at) context.addIssue({
		code: "custom",
		message: "Attempt completion time is not monotonic"
	});
	if (attempt.technical_outcome === "succeeded" === (attempt.technical_detail !== void 0)) context.addIssue({
		code: "custom",
		message: "only failed Attempts require technical_detail"
	});
});
const attemptSchema = z.discriminatedUnion("phase", [
	launchingAttemptSchema,
	runningAttemptSchema,
	outcomeUnknownAttemptSchema,
	terminalAttemptSchema
]);
const attemptStartedReceiptSchema = z.object({
	version: z.literal(1),
	type: z.literal("attempt_started"),
	attempt_id: id$2,
	launch_nonce: id$2,
	candidate_sha: gitSha,
	request_sha256: hash$3,
	started_at: timestamp,
	process: processIdentitySchema.optional(),
	gpu_lease: gpuLeaseSchema.optional(),
	remote_connection: remoteConnectionSchema.optional(),
	adapter_checkpoint_identity: id$2.optional()
}).strict();
const attemptCompletionReceiptSchema = z.object({
	version: z.literal(1),
	type: z.literal("attempt_completion"),
	attempt_id: id$2,
	launch_nonce: id$2,
	candidate_sha: gitSha,
	request_sha256: hash$3,
	completed_at: timestamp,
	completion_identity: id$2,
	technical_outcome: z.enum(["succeeded", "failed"]),
	technical_detail: technicalDetailSchema.optional(),
	artifacts: z.array(artifactReferenceSchema$1)
}).strict().superRefine((receipt, context) => {
	if (receipt.technical_outcome === "succeeded" === (receipt.technical_detail !== void 0)) context.addIssue({
		code: "custom",
		message: "only failed receipts require technical_detail"
	});
});
const attemptUncertainReceiptSchema = z.object({
	version: z.literal(1),
	type: z.literal("attempt_outcome_unknown"),
	attempt_id: id$2,
	launch_nonce: id$2,
	candidate_sha: gitSha,
	request_sha256: hash$3,
	observed_at: timestamp,
	technical_detail: technicalDetailSchema,
	incident: artifactReferenceSchema$1.optional()
}).strict();
var TrialContractError = class extends Error {
	name = "TrialContractError";
	constructor(message, code) {
		super(message);
		this.code = code;
	}
};
var AttemptTransitionError = class extends Error {
	name = "AttemptTransitionError";
	constructor(message, code) {
		super(message);
		this.code = code;
	}
};
function parseTrialContract(value) {
	return parseOrThrow(trialContractSchema, value, (error) => new TrialContractError(`invalid Trial contract: ${error.message}`, "INVALID_TRIAL"));
}
function compileTrialContract(value) {
	return freezeRecord$1(parseTrialContract(value));
}
function compileRunSlotContract(trialInput, runSlotId) {
	const trial = validateFrozenRecord(trialInput, trialContractSchema, "Trial contract");
	const slot = trial.value.run_slots.find((candidate) => candidate.runslot_id === runSlotId);
	if (slot === void 0) throw new TrialContractError(`RunSlot ${JSON.stringify(runSlotId)} is not declared by Trial ${JSON.stringify(trial.value.trial_id)}`, "RUNSLOT_NOT_FOUND");
	return freezeRecord$1(parseOrThrow(runSlotContractSchema, {
		version: 1,
		runslot_id: slot.runslot_id,
		trial_id: trial.value.trial_id,
		trial_contract_sha256: trial.sha256,
		candidate_sha: trial.value.candidate_sha,
		config_revision: trial.value.config_revision,
		...slot.contract === void 0 ? {} : { contract: slot.contract }
	}, (error) => new TrialContractError(`invalid RunSlot contract: ${error.message}`, "INVALID_TRIAL")));
}
function createRunSlotState(runSlotInput) {
	const runslot = validateFrozenRecord(runSlotInput, runSlotContractSchema, "RunSlot contract");
	return parseRunSlotState({
		version: 1,
		runslot_id: runslot.value.runslot_id,
		trial_id: runslot.value.trial_id,
		runslot_contract_sha256: runslot.sha256,
		revision: 0,
		status: "pending"
	});
}
function parseRunSlotState(value) {
	return deepFreeze(parseOrThrow(runSlotStateSchema, value, (error) => new AttemptTransitionError(`invalid RunSlot state: ${error.message}`, "INVALID_ATTEMPT")));
}
const attemptExecutionInputSchema = z.object({
	attempt_id: id$2,
	request: requestIdentitySchema,
	cwd: absolutePath$4,
	env_sha256: hash$3,
	runner: componentIdentitySchema,
	host_id: id$2,
	launch_nonce: id$2,
	launched_at: timestamp,
	gpu_lease: gpuLeaseSchema.optional(),
	remote_connection: remoteConnectionSchema.optional(),
	adapter_checkpoint_identity: id$2.optional()
}).strict();
function createInitialAttempt(runSlotInput, stateInput, expectedRevision, inputValue) {
	const runslot = validateFrozenRecord(runSlotInput, runSlotContractSchema, "RunSlot contract");
	const state = parseRunSlotState(stateInput);
	assertExpectedRunSlotRevision(state, expectedRevision);
	assertRunSlotStateContract(state, runslot);
	if (state.status !== "pending") throw new AttemptTransitionError(`RunSlot ${JSON.stringify(state.runslot_id)} already consumed its initial launch`, "ILLEGAL_TRANSITION");
	const input = parseAttemptExecutionInput(inputValue);
	const attempt = parseAttempt({
		version: 1,
		attempt_id: input.attempt_id,
		attempt_ordinal: 1,
		trial_id: runslot.value.trial_id,
		runslot_id: runslot.value.runslot_id,
		trial_contract_sha256: runslot.value.trial_contract_sha256,
		runslot_contract_sha256: runslot.sha256,
		candidate_sha: runslot.value.candidate_sha,
		config_revision: runslot.value.config_revision,
		request: input.request,
		cwd: input.cwd,
		env_sha256: input.env_sha256,
		runner: input.runner,
		host_id: input.host_id,
		launch_nonce: input.launch_nonce,
		launched_at: input.launched_at,
		...input.gpu_lease === void 0 ? {} : { gpu_lease: input.gpu_lease },
		...input.remote_connection === void 0 ? {} : { remote_connection: input.remote_connection },
		...input.adapter_checkpoint_identity === void 0 ? {} : { adapter_checkpoint_identity: input.adapter_checkpoint_identity },
		phase: "launching"
	});
	return runSlotTransition(expectedRevision, advanceRunSlotState(state, attempt, "attempt_active", true), attempt);
}
function parseAttempt(value) {
	return deepFreeze(parseOrThrow(attemptSchema, value, (error) => new AttemptTransitionError(`invalid Attempt: ${error.message}`, "INVALID_ATTEMPT")));
}
function compileAttemptStartedReceipt(value) {
	return freezeReceipt(attemptStartedReceiptSchema, value);
}
function compileAttemptCompletionReceipt(value) {
	return freezeReceipt(attemptCompletionReceiptSchema, value);
}
function compileAttemptUncertainReceipt(value) {
	return freezeReceipt(attemptUncertainReceiptSchema, value);
}
function recordAttemptStarted(stateInput, expectedRevision, attemptInput, receiptInput, receiptPath$1) {
	const state = parseRunSlotState(stateInput);
	assertExpectedRunSlotRevision(state, expectedRevision);
	const current = parseAttempt(attemptInput);
	assertRunSlotStateAttempt(state, current, current.phase === "outcome_unknown" ? ["outcome_unknown"] : ["attempt_active"]);
	const attempt = transitionAttemptStarted(current, receiptInput, receiptPath$1);
	return runSlotTransition(expectedRevision, current.phase === "running" ? state : advanceRunSlotState(state, attempt, "attempt_active", false), attempt);
}
function transitionAttemptStarted(attemptInput, receiptInput, receiptPath$1) {
	const attempt = parseAttempt(attemptInput);
	const receipt = validateFrozenReceipt(receiptInput, attemptStartedReceiptSchema);
	const reference = parseReceiptReference(receiptPath$1, receipt.sha256);
	if (attempt.phase === "terminal") throw new AttemptTransitionError(`Attempt ${JSON.stringify(attempt.attempt_id)} is already terminal`, "ILLEGAL_TRANSITION");
	assertReceiptIdentity$1(attempt, receipt.value);
	if (attempt.phase === "running") {
		if (attempt.started_receipt.path === reference.path && attempt.started_receipt.sha256 === reference.sha256) {
			assertStartedProjection(attempt, receipt.value);
			return attempt;
		}
		throw new AttemptTransitionError(`Attempt ${JSON.stringify(attempt.attempt_id)} already has another started receipt`, "ILLEGAL_TRANSITION");
	}
	if (attempt.phase === "outcome_unknown" && attempt.started_receipt !== void 0) {
		if (attempt.started_receipt.path !== reference.path || attempt.started_receipt.sha256 !== reference.sha256) throw new AttemptTransitionError(`Attempt ${JSON.stringify(attempt.attempt_id)} already has another started receipt`, "ILLEGAL_TRANSITION");
		assertStartedProjection(attempt, receipt.value);
	}
	if (receipt.value.started_at < attempt.launched_at) throw new AttemptTransitionError("started receipt precedes launch intent", "IDENTITY_MISMATCH");
	const gpuLease = mergeObservedIdentity(attempt.gpu_lease, receipt.value.gpu_lease, "GPU lease");
	const remote = mergeObservedIdentity(attempt.remote_connection, receipt.value.remote_connection, "remote connection");
	const checkpointIdentity = mergeObservedScalar(attempt.adapter_checkpoint_identity, receipt.value.adapter_checkpoint_identity, "adapter checkpoint identity");
	return parseAttempt({
		...attemptBase(attempt),
		phase: "running",
		started_at: receipt.value.started_at,
		started_receipt: reference,
		...receipt.value.process === void 0 ? {} : { process: receipt.value.process },
		...gpuLease === void 0 ? {} : { gpu_lease: gpuLease },
		...remote === void 0 ? {} : { remote_connection: remote },
		...checkpointIdentity === void 0 ? {} : { adapter_checkpoint_identity: checkpointIdentity }
	});
}
function recordAttemptOutcomeUnknown(stateInput, expectedRevision, attemptInput, receiptInput, receiptPath$1) {
	const state = parseRunSlotState(stateInput);
	assertExpectedRunSlotRevision(state, expectedRevision);
	const current = parseAttempt(attemptInput);
	assertRunSlotStateAttempt(state, current, current.phase === "outcome_unknown" ? ["outcome_unknown"] : ["attempt_active"]);
	const attempt = transitionAttemptOutcomeUnknown(current, receiptInput, receiptPath$1);
	return runSlotTransition(expectedRevision, current.phase === "outcome_unknown" ? state : advanceRunSlotState(state, attempt, "outcome_unknown", false), attempt);
}
function transitionAttemptOutcomeUnknown(attemptInput, receiptInput, receiptPath$1) {
	const attempt = parseAttempt(attemptInput);
	const receipt = validateFrozenReceipt(receiptInput, attemptUncertainReceiptSchema);
	const reference = parseReceiptReference(receiptPath$1, receipt.sha256);
	if (attempt.phase === "terminal") throw new AttemptTransitionError(`Attempt ${JSON.stringify(attempt.attempt_id)} is already terminal`, "ILLEGAL_TRANSITION");
	assertReceiptIdentity$1(attempt, receipt.value);
	if (attempt.phase === "outcome_unknown") {
		if (attempt.uncertainty_receipt.path === reference.path && attempt.uncertainty_receipt.sha256 === reference.sha256) {
			assertUncertainProjection(attempt, receipt.value);
			return attempt;
		}
		throw new AttemptTransitionError(`Attempt ${JSON.stringify(attempt.attempt_id)} already has another uncertainty receipt`, "ILLEGAL_TRANSITION");
	}
	if (receipt.value.observed_at < attempt.launched_at || attempt.phase === "running" && receipt.value.observed_at < attempt.started_at) throw new AttemptTransitionError("uncertainty receipt time is not monotonic", "IDENTITY_MISMATCH");
	return parseAttempt({
		...attemptBase(attempt),
		phase: "outcome_unknown",
		...attempt.phase === "running" ? {
			started_at: attempt.started_at,
			started_receipt: attempt.started_receipt,
			...attempt.process === void 0 ? {} : { process: attempt.process }
		} : {},
		unknown_since: receipt.value.observed_at,
		uncertainty_receipt: reference,
		technical_detail: receipt.value.technical_detail,
		...receipt.value.incident === void 0 ? {} : { incident: receipt.value.incident }
	});
}
function recordAttemptCompletion(stateInput, expectedRevision, attemptInput, receiptInput, receiptPath$1) {
	const state = parseRunSlotState(stateInput);
	assertExpectedRunSlotRevision(state, expectedRevision);
	const current = parseAttempt(attemptInput);
	assertRunSlotStateAttempt(state, current, current.phase === "outcome_unknown" ? ["outcome_unknown"] : current.phase === "terminal" ? [current.technical_outcome === "succeeded" ? "execution_complete" : "retryable"] : ["attempt_active"]);
	const attempt = transitionAttemptCompletion(current, receiptInput, receiptPath$1);
	return runSlotTransition(expectedRevision, current.phase === "terminal" ? state : advanceRunSlotState(state, attempt, attempt.technical_outcome === "succeeded" ? "execution_complete" : "retryable", false), attempt);
}
function transitionAttemptCompletion(attemptInput, receiptInput, receiptPath$1) {
	const attempt = parseAttempt(attemptInput);
	const receipt = validateFrozenReceipt(receiptInput, attemptCompletionReceiptSchema);
	const reference = parseReceiptReference(receiptPath$1, receipt.sha256);
	if (attempt.phase === "terminal") {
		if (attempt.completion_receipt.path === reference.path && attempt.completion_receipt.sha256 === reference.sha256) {
			assertReceiptIdentity$1(attempt, receipt.value);
			assertCompletionProjection(attempt, receipt.value);
			return attempt;
		}
		throw new AttemptTransitionError(`Attempt ${JSON.stringify(attempt.attempt_id)} already has another completion receipt`, "ILLEGAL_TRANSITION");
	}
	assertReceiptIdentity$1(attempt, receipt.value);
	if (receipt.value.completed_at < attempt.launched_at || attempt.phase === "running" && receipt.value.completed_at < attempt.started_at) throw new AttemptTransitionError("completion receipt time is not monotonic", "IDENTITY_MISMATCH");
	return parseAttempt({
		...attemptBase(attempt),
		phase: "terminal",
		...(attempt.phase === "running" || attempt.phase === "outcome_unknown") && attempt.started_at !== void 0 ? {
			started_at: attempt.started_at,
			started_receipt: attempt.started_receipt,
			...attempt.process === void 0 ? {} : { process: attempt.process }
		} : {},
		completed_at: receipt.value.completed_at,
		completion_identity: receipt.value.completion_identity,
		completion_receipt: reference,
		technical_outcome: receipt.value.technical_outcome,
		...receipt.value.technical_detail === void 0 ? {} : { technical_detail: receipt.value.technical_detail },
		artifacts: receipt.value.artifacts
	});
}
function createRetryAttempt(stateInput, expectedRevision, previousInput, inputValue) {
	const state = parseRunSlotState(stateInput);
	assertExpectedRunSlotRevision(state, expectedRevision);
	const previous = parseAttempt(previousInput);
	if (state.status !== "retryable") throw new AttemptTransitionError("only a mechanically failed RunSlot may create a technical retry", "RETRY_NOT_ALLOWED");
	assertRunSlotStateAttempt(state, previous, ["retryable"]);
	const input = parseAttemptExecutionInput(inputValue);
	if (state.attempt_ids.includes(input.attempt_id) || state.launch_nonces.includes(input.launch_nonce)) throw new AttemptTransitionError("technical retry cannot reuse any prior Attempt or launch nonce in this RunSlot", "RETRY_NOT_ALLOWED");
	const attempt = transitionRetryAttempt(previous, inputValue);
	return runSlotTransition(expectedRevision, advanceRunSlotState(state, attempt, "attempt_active", true), attempt);
}
function transitionRetryAttempt(previousInput, inputValue) {
	const previous = parseAttempt(previousInput);
	if (previous.phase !== "terminal" || previous.technical_outcome !== "failed") throw new AttemptTransitionError("only a mechanically failed Attempt may create a technical retry", "RETRY_NOT_ALLOWED");
	const input = parseAttemptExecutionInput(inputValue);
	if (input.attempt_id === previous.attempt_id || input.launch_nonce === previous.launch_nonce || input.launched_at < previous.completed_at) throw new AttemptTransitionError("technical retry requires a new identity after the previous Attempt completes", "RETRY_NOT_ALLOWED");
	return parseAttempt({
		version: 1,
		attempt_id: input.attempt_id,
		attempt_ordinal: previous.attempt_ordinal + 1,
		predecessor_attempt_id: previous.attempt_id,
		trial_id: previous.trial_id,
		runslot_id: previous.runslot_id,
		trial_contract_sha256: previous.trial_contract_sha256,
		runslot_contract_sha256: previous.runslot_contract_sha256,
		candidate_sha: previous.candidate_sha,
		config_revision: previous.config_revision,
		request: input.request,
		cwd: input.cwd,
		env_sha256: input.env_sha256,
		runner: input.runner,
		host_id: input.host_id,
		launch_nonce: input.launch_nonce,
		launched_at: input.launched_at,
		...input.gpu_lease === void 0 ? {} : { gpu_lease: input.gpu_lease },
		...input.remote_connection === void 0 ? {} : { remote_connection: input.remote_connection },
		...input.adapter_checkpoint_identity === void 0 ? {} : { adapter_checkpoint_identity: input.adapter_checkpoint_identity },
		phase: "launching"
	});
}
function parseAttemptExecutionInput(value) {
	return parseOrThrow(attemptExecutionInputSchema, value, (error) => new AttemptTransitionError(`invalid Attempt launch identity: ${error.message}`, "INVALID_ATTEMPT"));
}
function parseReceiptReference(path, receiptHash) {
	return parseOrThrow(receiptReferenceSchema, {
		path,
		sha256: receiptHash
	}, (error) => new AttemptTransitionError(`invalid receipt reference: ${error.message}`, "INVALID_RECEIPT"));
}
function assertReceiptIdentity$1(attempt, receipt) {
	if (receipt.attempt_id !== attempt.attempt_id || receipt.launch_nonce !== attempt.launch_nonce || receipt.candidate_sha !== attempt.candidate_sha || receipt.request_sha256 !== attempt.request.sha256) throw new AttemptTransitionError(`receipt identity does not match Attempt ${JSON.stringify(attempt.attempt_id)}`, "IDENTITY_MISMATCH");
}
function assertStartedProjection(attempt, receipt) {
	if (attempt.started_at !== receipt.started_at || canonicalJson$1(attempt.process ?? null) !== canonicalJson$1(receipt.process ?? null) || receipt.gpu_lease !== void 0 && canonicalJson$1(attempt.gpu_lease ?? null) !== canonicalJson$1(receipt.gpu_lease) || receipt.remote_connection !== void 0 && canonicalJson$1(attempt.remote_connection ?? null) !== canonicalJson$1(receipt.remote_connection) || receipt.adapter_checkpoint_identity !== void 0 && attempt.adapter_checkpoint_identity !== receipt.adapter_checkpoint_identity) throw new AttemptTransitionError(`started receipt projection drifted for Attempt ${JSON.stringify(attempt.attempt_id)}`, "IDENTITY_MISMATCH");
}
function assertUncertainProjection(attempt, receipt) {
	if (attempt.unknown_since !== receipt.observed_at || canonicalJson$1(attempt.technical_detail) !== canonicalJson$1(receipt.technical_detail) || canonicalJson$1(attempt.incident ?? null) !== canonicalJson$1(receipt.incident ?? null)) throw new AttemptTransitionError(`uncertainty receipt projection drifted for Attempt ${JSON.stringify(attempt.attempt_id)}`, "IDENTITY_MISMATCH");
}
function assertCompletionProjection(attempt, receipt) {
	if (attempt.completed_at !== receipt.completed_at || attempt.completion_identity !== receipt.completion_identity || attempt.technical_outcome !== receipt.technical_outcome || canonicalJson$1(attempt.technical_detail ?? null) !== canonicalJson$1(receipt.technical_detail ?? null) || canonicalJson$1(attempt.artifacts) !== canonicalJson$1(receipt.artifacts)) throw new AttemptTransitionError(`completion receipt projection drifted for Attempt ${JSON.stringify(attempt.attempt_id)}`, "IDENTITY_MISMATCH");
}
function attemptBase(attempt) {
	return {
		version: 1,
		attempt_id: attempt.attempt_id,
		attempt_ordinal: attempt.attempt_ordinal,
		...attempt.predecessor_attempt_id === void 0 ? {} : { predecessor_attempt_id: attempt.predecessor_attempt_id },
		trial_id: attempt.trial_id,
		runslot_id: attempt.runslot_id,
		trial_contract_sha256: attempt.trial_contract_sha256,
		runslot_contract_sha256: attempt.runslot_contract_sha256,
		candidate_sha: attempt.candidate_sha,
		config_revision: attempt.config_revision,
		request: attempt.request,
		cwd: attempt.cwd,
		env_sha256: attempt.env_sha256,
		runner: attempt.runner,
		host_id: attempt.host_id,
		launch_nonce: attempt.launch_nonce,
		launched_at: attempt.launched_at,
		...attempt.gpu_lease === void 0 ? {} : { gpu_lease: attempt.gpu_lease },
		...attempt.remote_connection === void 0 ? {} : { remote_connection: attempt.remote_connection },
		...attempt.adapter_checkpoint_identity === void 0 ? {} : { adapter_checkpoint_identity: attempt.adapter_checkpoint_identity }
	};
}
function attemptIdentitySha256$1(attempt) {
	return sha256(canonicalJson$1(attemptBase(attempt)));
}
function mergeObservedIdentity(planned, observed, label) {
	if (planned === void 0 && observed !== void 0) throw new AttemptTransitionError(`${label} was not frozen by the Attempt launch identity`, "IDENTITY_MISMATCH");
	if (planned === void 0) return void 0;
	if (observed === void 0) return planned;
	if (canonicalJson$1(planned) !== canonicalJson$1(observed)) throw new AttemptTransitionError(`${label} drifted at Attempt start`, "IDENTITY_MISMATCH");
	return planned;
}
function mergeObservedScalar(planned, observed, label) {
	if (planned === void 0 && observed !== void 0) throw new AttemptTransitionError(`${label} was not frozen by the Attempt launch identity`, "IDENTITY_MISMATCH");
	if (planned !== void 0 && observed !== void 0 && planned !== observed) throw new AttemptTransitionError(`${label} drifted at Attempt start`, "IDENTITY_MISMATCH");
	return planned ?? observed;
}
function freezeReceipt(schema, value) {
	return freezeRecord$1(parseOrThrow(schema, value, (error) => new AttemptTransitionError(`invalid receipt: ${error.message}`, "INVALID_RECEIPT")));
}
function validateFrozenReceipt(input, schema) {
	try {
		return validateFrozenRecord(input, schema, "receipt");
	} catch (error) {
		if (error instanceof AttemptTransitionError) throw error;
		throw new AttemptTransitionError(renderError$3(error), "INVALID_RECEIPT");
	}
}
function validateFrozenRecord(input, schema, label) {
	const parsed = schema.safeParse(input.value);
	if (!parsed.success) throw new AttemptTransitionError(`invalid frozen ${label}: ${parsed.error.message}`, "INVALID_RECEIPT");
	const text = canonicalJson$1(stripUndefined(parsed.data));
	if (text !== input.canonicalJson || sha256(text) !== input.sha256) throw new AttemptTransitionError(`${label} immutable hash does not match`, "IDENTITY_MISMATCH");
	return input;
}
function freezeRecord$1(value) {
	const cleaned = deepFreeze(stripUndefined(value));
	const text = canonicalJson$1(cleaned);
	return Object.freeze({
		value: cleaned,
		canonicalJson: text,
		sha256: sha256(text)
	});
}
function parseOrThrow(schema, value, mapError) {
	const parsed = schema.safeParse(value);
	if (!parsed.success) throw mapError(parsed.error);
	return stripUndefined(parsed.data);
}
function rejectDuplicates(values, label, context) {
	if (new Set(values).size !== values.length) context.addIssue({
		code: "custom",
		message: `${label} cannot contain duplicates`
	});
}
function validateRunSlotHistory(state, context) {
	if (state.attempt_ids.length !== state.launch_nonces.length || state.attempt_ordinal !== state.attempt_ids.length || state.attempt_ids.at(-1) !== state.attempt_id) context.addIssue({
		code: "custom",
		message: "RunSlot Attempt history is inconsistent"
	});
	if (state.revision < state.attempt_ordinal) context.addIssue({
		code: "custom",
		message: "RunSlot revision precedes Attempt history"
	});
	rejectDuplicates(state.attempt_ids, "attempt_ids", context);
	rejectDuplicates(state.launch_nonces, "launch_nonces", context);
}
function assertExpectedRunSlotRevision(state, expectedRevision) {
	if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || state.revision !== expectedRevision) throw new AttemptTransitionError(`RunSlot revision is ${state.revision}, not expected revision ${expectedRevision}`, "STALE_RUNSLOT_STATE");
}
function assertRunSlotStateContract(state, runslot) {
	if (state.runslot_id !== runslot.value.runslot_id || state.trial_id !== runslot.value.trial_id || state.runslot_contract_sha256 !== runslot.sha256) throw new AttemptTransitionError("RunSlot state does not match its immutable contract", "IDENTITY_MISMATCH");
}
function assertRunSlotStateAttempt(state, attempt, allowedStatuses) {
	if (!allowedStatuses.includes(state.status)) throw new AttemptTransitionError(`RunSlot status ${JSON.stringify(state.status)} cannot migrate this Attempt`, "ILLEGAL_TRANSITION");
	if (state.status === "pending" || state.attempt_id !== attempt.attempt_id || state.attempt_ordinal !== attempt.attempt_ordinal || state.attempt_identity_sha256 !== attemptIdentitySha256$1(attempt) || state.launch_nonces.at(-1) !== attempt.launch_nonce || attempt.attempt_ordinal > 1 && state.attempt_ids.at(-2) !== attempt.predecessor_attempt_id || state.runslot_id !== attempt.runslot_id || state.trial_id !== attempt.trial_id || state.runslot_contract_sha256 !== attempt.runslot_contract_sha256) throw new AttemptTransitionError("RunSlot state and Attempt identity do not match", "IDENTITY_MISMATCH");
}
function advanceRunSlotState(state, attempt, status, appendAttempt) {
	const priorAttemptIds = state.status === "pending" ? [] : state.attempt_ids;
	const priorLaunchNonces = state.status === "pending" ? [] : state.launch_nonces;
	return parseRunSlotState({
		version: 1,
		runslot_id: state.runslot_id,
		trial_id: state.trial_id,
		runslot_contract_sha256: state.runslot_contract_sha256,
		revision: state.revision + 1,
		status,
		attempt_id: attempt.attempt_id,
		attempt_ordinal: attempt.attempt_ordinal,
		attempt_identity_sha256: attemptIdentitySha256$1(attempt),
		attempt_ids: appendAttempt ? [...priorAttemptIds, attempt.attempt_id] : priorAttemptIds,
		launch_nonces: appendAttempt ? [...priorLaunchNonces, attempt.launch_nonce] : priorLaunchNonces
	});
}
function runSlotTransition(expectedRevision, state, attempt) {
	return Object.freeze({
		expected_revision: expectedRevision,
		state,
		attempt
	});
}
function validateAttemptLineage(attempt, context) {
	if (attempt.attempt_ordinal === 1 !== (attempt.predecessor_attempt_id === void 0)) context.addIssue({
		code: "custom",
		message: "only retry Attempts require predecessor_attempt_id"
	});
}
function stripUndefined(value) {
	if (Array.isArray(value)) return value.map(stripUndefined);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => item === void 0 ? [] : [[key, stripUndefined(item)]]));
}
function deepFreeze(value) {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const item of Object.values(value)) deepFreeze(item);
		Object.freeze(value);
	}
	return value;
}
function renderError$3(value) {
	return value instanceof Error ? value.message : String(value);
}

//#endregion
//#region src/state.ts
const LAB_ID_PATTERN = /^lab-[0-9]{8}-[0-9]{6}-[0-9a-f]{8}$/;
const SHA256_PATTERN$17 = /^[0-9a-f]{64}$/;
const CONTROL_PAYLOAD_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const labLifecycleSchema = z.enum([
	"configuring",
	"draft_ready",
	"ready",
	"starting",
	"running",
	"pausing",
	"paused",
	"blocked",
	"stopped"
]);
const rolePhaseSchema = z.enum([
	"declared",
	"starting",
	"working",
	"reviewing",
	"pausing",
	"paused",
	"blocked"
]);
const reviewGoalRefSchema = z.object({
	id: z.string().min(1),
	revision: z.number().int().positive()
}).strict();
const reviewCapabilityStateSchema = z.object({
	version: z.literal(1),
	reviewId: z.string().min(1),
	assignmentId: z.string().min(1),
	configRevision: z.number().int().positive(),
	runtimeRevision: z.number().int().nonnegative(),
	ownerFence: z.string().uuid(),
	workerRoleId: z.string().min(1),
	workerSessionId: z.string().min(1),
	judgeRoleId: z.string().min(1),
	judgeSessionId: z.string().min(1),
	packetHash: z.string().regex(SHA256_PATTERN$17),
	artifactHash: z.string().regex(SHA256_PATTERN$17),
	negotiatedAnchorHash: z.string().regex(SHA256_PATTERN$17),
	sourceTurn: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
	expectedGoalRef: reviewGoalRefSchema.nullable(),
	request: z.object({
		controlId: z.string().uuid(),
		payloadHash: z.string().regex(CONTROL_PAYLOAD_HASH_PATTERN)
	}).strict(),
	acceptedPause: z.object({
		controlId: z.string().uuid(),
		payloadHash: z.string().regex(CONTROL_PAYLOAD_HASH_PATTERN)
	}).strict()
}).strict();
const reviewPauseStateSchema = z.object({
	controlId: z.string().uuid(),
	payloadHash: z.string().regex(CONTROL_PAYLOAD_HASH_PATTERN),
	freeze: z.enum([
		"pending",
		"stopped",
		"hold-pending",
		"held",
		"stale",
		"user-override"
	]),
	completedAt: z.number().int().nonnegative().optional(),
	goalOutcome: z.enum([
		"paused",
		"already-applied",
		"no-active-goal",
		"stale"
	]).optional(),
	activeTurn: z.boolean().optional(),
	observedTurn: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
	goalRef: reviewGoalRefSchema.optional(),
	holdOwnerEpoch: z.string().uuid().optional(),
	detail: z.string().min(1).optional()
}).strict().superRefine((pause, context) => {
	const completed = pause.completedAt !== void 0 && pause.goalOutcome !== void 0 && pause.activeTurn !== void 0;
	if (pause.freeze === "pending") {
		if (completed || pause.completedAt !== void 0 || pause.goalOutcome !== void 0 || pause.activeTurn !== void 0 || pause.observedTurn !== void 0 || pause.goalRef !== void 0 || pause.holdOwnerEpoch !== void 0 || pause.detail !== void 0) context.addIssue({
			code: "custom",
			message: "pending review pause cannot carry an outcome"
		});
		return;
	}
	if (!completed) context.addIssue({
		code: "custom",
		message: `${pause.freeze} review pause requires its completed outcome`
	});
	if (pause.activeTurn === true && pause.observedTurn === void 0) context.addIssue({
		code: "custom",
		message: "active review pause requires its observed turn"
	});
	if (pause.activeTurn !== true && pause.observedTurn !== void 0) context.addIssue({
		code: "custom",
		message: "inactive review pause cannot carry an observed turn"
	});
	if (pause.freeze === "held") {
		if (pause.holdOwnerEpoch === void 0 || pause.activeTurn !== true) context.addIssue({
			code: "custom",
			message: "held review pause requires its owner epoch and active turn"
		});
	} else if (pause.holdOwnerEpoch !== void 0) context.addIssue({
		code: "custom",
		message: `${pause.freeze} review pause cannot carry a hold owner epoch`
	});
	if (pause.freeze === "stale" && pause.goalOutcome !== "stale") context.addIssue({
		code: "custom",
		message: "stale review pause requires a stale Goal outcome"
	});
	if ((pause.freeze === "hold-pending" || pause.freeze === "user-override") && pause.activeTurn !== true) context.addIssue({
		code: "custom",
		message: `${pause.freeze} review pause requires an active turn`
	});
	if (pause.freeze === "user-override" && pause.detail === void 0) context.addIssue({
		code: "custom",
		message: "user-override review pause requires a detail"
	});
});
const reviewVerdictStateSchema = z.object({
	path: z.string().min(1),
	hash: z.string().regex(SHA256_PATTERN$17),
	assignmentId: z.string().min(1),
	reviewInputHash: z.string().regex(SHA256_PATTERN$17),
	topLevelVerdict: z.enum([
		"APPROVED",
		"REVISION_REQUIRED",
		"REJECTED",
		"REVIEW_ERROR"
	]),
	recordedAt: z.number().int().nonnegative()
}).strict();
/** Postflight scientific content stays opaque; Runtime stores only its binding. */
const reviewResultStateSchema = z.object({
	path: z.string().min(1).refine(isAbsolute, "review result path must be absolute"),
	hash: z.string().regex(SHA256_PATTERN$17),
	assignmentId: z.string().min(1),
	reviewInputHash: z.string().regex(SHA256_PATTERN$17),
	recordedAt: z.number().int().nonnegative()
}).strict();
const reviewResolutionBodySchema = z.object({
	version: z.literal(1),
	reviewId: z.string().min(1),
	verdictHash: z.string().regex(SHA256_PATTERN$17),
	targetRoleId: z.string().min(1),
	targetSessionId: z.string().min(1),
	effect: z.object({
		kind: z.string().min(1),
		id: z.string().min(1),
		hash: z.string().regex(SHA256_PATTERN$17)
	}).strict()
}).strict();
const reviewResolutionStateSchema = reviewResolutionBodySchema.extend({ resolutionHash: z.string().regex(SHA256_PATTERN$17) }).strict().superRefine((resolution, context) => {
	const { resolutionHash: _storedHash,...body } = resolution;
	if (resolutionHash(body) !== resolution.resolutionHash) context.addIssue({
		code: "custom",
		message: "review resolution hash does not match its target effect"
	});
});
const activeReviewSchema = z.object({
	stage: z.enum(["preflight", "postflight"]),
	phase: z.enum([
		"reviewing",
		"verdict_recorded",
		"result_recorded",
		"error"
	]),
	sourcePacket: z.object({
		path: z.string().min(1),
		hash: z.string().regex(SHA256_PATTERN$17)
	}).strict(),
	packetPath: z.string().min(1),
	artifactPath: z.string().min(1),
	capability: reviewCapabilityStateSchema,
	pause: reviewPauseStateSchema,
	verdict: reviewVerdictStateSchema.optional(),
	result: reviewResultStateSchema.optional(),
	resolution: reviewResolutionStateSchema.optional(),
	createdAt: z.number().int().nonnegative(),
	updatedAt: z.number().int().nonnegative()
}).strict().superRefine((review, context) => {
	if (review.updatedAt < review.createdAt) context.addIssue({
		code: "custom",
		message: "review updatedAt must not precede createdAt"
	});
	if (review.pause.controlId !== review.capability.acceptedPause.controlId || review.pause.payloadHash !== review.capability.acceptedPause.payloadHash) context.addIssue({
		code: "custom",
		message: "review pause does not match its accepted control edge"
	});
	if (review.stage === "preflight") {
		if (review.result !== void 0 || review.phase === "result_recorded") context.addIssue({
			code: "custom",
			message: "Preflight cannot carry a Postflight result"
		});
		if (review.phase === "reviewing" !== (review.verdict === void 0)) context.addIssue({
			code: "custom",
			message: `${review.phase} Preflight verdict projection is inconsistent`
		});
		if (review.phase === "error" && review.verdict?.topLevelVerdict !== "REVIEW_ERROR") context.addIssue({
			code: "custom",
			message: "error review requires a REVIEW_ERROR verdict"
		});
		if (review.phase === "verdict_recorded" && review.verdict?.topLevelVerdict === "REVIEW_ERROR") context.addIssue({
			code: "custom",
			message: "REVIEW_ERROR cannot be recorded as a scientific verdict"
		});
		if (review.verdict !== void 0 && review.verdict.reviewInputHash !== review.capability.negotiatedAnchorHash) context.addIssue({
			code: "custom",
			message: "review verdict does not match its negotiated input anchor"
		});
	} else {
		if (review.verdict !== void 0 || review.phase === "verdict_recorded" || review.phase === "error") context.addIssue({
			code: "custom",
			message: "Postflight output must remain opaque to Runtime"
		});
		if (review.phase === "reviewing" !== (review.result === void 0)) context.addIssue({
			code: "custom",
			message: `${review.phase} Postflight result projection is inconsistent`
		});
		if (review.result !== void 0 && review.result.reviewInputHash !== review.capability.negotiatedAnchorHash) context.addIssue({
			code: "custom",
			message: "Postflight result does not match its negotiated input anchor"
		});
	}
	if (review.resolution !== void 0) {
		if (review.phase !== "verdict_recorded" || review.verdict === void 0 || review.resolution.reviewId !== review.capability.reviewId || review.resolution.verdictHash !== review.verdict.hash) context.addIssue({
			code: "custom",
			message: "review resolution does not match its persisted verdict"
		});
		if (review.pause.freeze !== "stopped") context.addIssue({
			code: "custom",
			message: "resolved review must project its worker freeze as stopped"
		});
	}
});
const goalInstallSchema = z.object({
	installId: z.string().min(1),
	assignmentId: z.string().min(1),
	objectiveHash: z.string().regex(SHA256_PATTERN$17),
	maxGoalRounds: z.number().int().positive(),
	status: z.enum([
		"pending",
		"activating",
		"applied"
	]),
	goalId: z.string().min(1).optional(),
	goalRevision: z.number().int().positive().optional()
}).strict().superRefine((install, context) => {
	if (install.goalId === void 0 !== (install.goalRevision === void 0)) context.addIssue({
		code: "custom",
		message: "goalId and goalRevision must be present together"
	});
	if (install.status === "applied" && install.goalId === void 0) context.addIssue({
		code: "custom",
		message: "applied Goal install requires its durable Goal reference"
	});
});
/**
* The Controller is the user's existing Session, not an entry in `roles`.
* Keep only the identity needed to recover its one native DSH Goal plus the
* Controller's explicit AutoLabWait intent. Goal phase, activation, and round
* counters remain owned by `@deepseek-ai/dsh-goal`.
*/
const controllerGoalSchema = goalInstallSchema.safeExtend({
	roleId: z.string().min(1),
	packetHash: z.string().regex(SHA256_PATTERN$17),
	waiting: z.literal(true).optional()
}).strict();
const roleActivationBlockerSchema = z.object({
	code: z.enum([
		"WORKTREE_PROVISION_FAILED",
		"ROLE_ACTIVATION_FAILED",
		"GOAL_INSTALL_FAILED"
	]),
	message: z.string().min(1)
}).strict();
const roleStateSchema = z.object({
	sessionId: z.string().min(1),
	phase: rolePhaseSchema,
	binding: z.object({
		path: z.string().min(1),
		hash: z.string().regex(SHA256_PATTERN$17)
	}).strict().optional(),
	packet: z.object({
		path: z.string().min(1),
		hash: z.string().regex(SHA256_PATTERN$17)
	}).strict().optional(),
	goalInstall: goalInstallSchema.optional(),
	receipt: z.object({
		assignmentId: z.string().min(1),
		path: z.string().min(1).refine(isAbsolute, "role receipt path must be absolute"),
		hash: z.string().regex(SHA256_PATTERN$17),
		recordedAt: z.number().int().nonnegative()
	}).strict().optional(),
	activationBlocker: roleActivationBlockerSchema.optional()
}).strict().superRefine((role, context) => {
	if (role.phase !== "starting" && (role.binding === void 0 || role.packet === void 0)) context.addIssue({
		code: "custom",
		message: `${role.phase} role requires frozen binding and packet references`
	});
});
const activeCandidateSchema = z.object({
	version: z.literal(1),
	sourceRevision: z.number().int().positive(),
	laneId: z.string().min(1),
	candidateId: z.string().min(1),
	reviewId: z.string().min(1).optional(),
	coderRoleId: z.string().min(1),
	coderSessionId: z.string().min(1),
	assignmentId: z.string().min(1),
	candidateSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u),
	captureReceipt: z.object({
		path: z.string().min(1).refine(isAbsolute, "candidate receipt path must be absolute"),
		hash: z.string().regex(SHA256_PATTERN$17)
	}).strict(),
	sourceReport: z.object({
		path: z.string().min(1).refine(isAbsolute, "implementation receipt path must be absolute"),
		hash: z.string().regex(SHA256_PATTERN$17)
	}).strict().optional(),
	frozenAt: z.number().int().nonnegative()
}).strict();
const trialArtifactReferenceSchema = z.object({
	path: z.string().min(1).refine(isAbsolute, "Trial artifact path must be absolute"),
	hash: z.string().regex(SHA256_PATTERN$17)
}).strict();
const activeAttemptReferenceSchema = z.object({
	attemptId: z.string().min(1),
	phase: z.enum([
		"launching",
		"running",
		"outcome_unknown",
		"terminal"
	]),
	path: z.string().min(1).refine(isAbsolute, "Attempt artifact path must be absolute"),
	hash: z.string().regex(SHA256_PATTERN$17),
	checkout: trialArtifactReferenceSchema.optional()
}).strict();
const activeRunSlotProjectionSchema = z.object({
	contract: trialArtifactReferenceSchema,
	state: runSlotStateSchema,
	activeAttempt: activeAttemptReferenceSchema.optional()
}).strict().superRefine((slot, context) => {
	if (slot.state.status === "pending") {
		if (slot.activeAttempt !== void 0) context.addIssue({
			code: "custom",
			message: "pending RunSlot cannot carry an Attempt"
		});
		return;
	}
	if (slot.activeAttempt === void 0 || slot.activeAttempt.attemptId !== slot.state.attempt_id) {
		context.addIssue({
			code: "custom",
			message: "occupied RunSlot requires its exact active Attempt reference"
		});
		return;
	}
	if (!(slot.state.status === "attempt_active" ? slot.activeAttempt.phase === "launching" || slot.activeAttempt.phase === "running" : slot.state.status === "outcome_unknown" ? slot.activeAttempt.phase === "outcome_unknown" : slot.activeAttempt.phase === "terminal")) context.addIssue({
		code: "custom",
		message: "RunSlot status does not match its Attempt phase"
	});
});
const activeTrialSchema = z.object({
	version: z.literal(1),
	sourceRevision: z.number().int().positive(),
	laneId: z.string().min(1),
	candidateId: z.string().min(1),
	candidateSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u),
	contract: trialArtifactReferenceSchema,
	runSlots: z.record(z.string().min(1), activeRunSlotProjectionSchema)
}).strict().superRefine((trial, context) => {
	if (Object.keys(trial.runSlots).length === 0) context.addIssue({
		code: "custom",
		message: "active Trial requires its frozen RunSlots"
	});
	for (const [runSlotId, slot] of Object.entries(trial.runSlots)) if (slot.state.runslot_id !== runSlotId || slot.state.runslot_contract_sha256 !== slot.contract.hash) context.addIssue({
		code: "custom",
		path: ["runSlots", runSlotId],
		message: "RunSlot projection key or contract hash does not match its state identity"
	});
});
const configRefSchema = z.object({
	revision: z.number().int().positive(),
	specHash: z.string().regex(SHA256_PATTERN$17),
	configHash: z.string().regex(SHA256_PATTERN$17),
	manifestHash: z.string().regex(SHA256_PATTERN$17),
	dialogueHeadHash: z.string().regex(SHA256_PATTERN$17),
	revisionPath: z.string().min(1)
}).strict();
const runtimeStateSchema = z.object({
	schemaVersion: z.literal(1),
	labId: z.string().regex(LAB_ID_PATTERN),
	runtimeRevision: z.number().int().nonnegative(),
	ownerEpoch: z.string().uuid(),
	controllerSessionId: z.string().min(1),
	controllerGoal: controllerGoalSchema.optional(),
	lifecycle: labLifecycleSchema,
	config: configRefSchema.optional(),
	revealState: z.enum(["sealed", "revealed"]).optional(),
	roles: z.record(z.string().min(1), roleStateSchema),
	reviews: z.record(z.string().min(1), activeReviewSchema).default({}),
	candidates: z.record(z.string().min(1), activeCandidateSchema).default({}),
	retiredCandidates: z.record(z.string().min(1), activeCandidateSchema).default({}),
	trials: z.record(z.string().min(1), activeTrialSchema).default({}),
	blocker: z.object({
		code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
		message: z.string().min(1)
	}).strict().optional(),
	createdAt: z.number().int().nonnegative(),
	updatedAt: z.number().int().nonnegative()
}).strict().superRefine((state, context) => {
	if (state.updatedAt < state.createdAt) context.addIssue({
		code: "custom",
		message: "updatedAt must not precede createdAt",
		path: ["updatedAt"]
	});
	if ((state.lifecycle === "ready" || state.lifecycle === "starting" || state.lifecycle === "running" || state.lifecycle === "pausing" || state.lifecycle === "paused") && state.config === void 0) context.addIssue({
		code: "custom",
		message: `${state.lifecycle} lifecycle requires a committed config revision`,
		path: ["config"]
	});
	if ((state.lifecycle === "configuring" || state.lifecycle === "draft_ready") && state.config !== void 0) context.addIssue({
		code: "custom",
		message: `${state.lifecycle} lifecycle must not project a committed config revision`,
		path: ["config"]
	});
	if (state.lifecycle === "blocked" && state.blocker === void 0) context.addIssue({
		code: "custom",
		message: "blocked lifecycle requires a blocker",
		path: ["blocker"]
	});
	if (state.lifecycle !== "blocked" && state.blocker !== void 0) context.addIssue({
		code: "custom",
		message: `${state.lifecycle} lifecycle must not retain a blocker`,
		path: ["blocker"]
	});
	for (const [reviewId, review] of Object.entries(state.reviews)) {
		if (review.capability.reviewId !== reviewId) context.addIssue({
			code: "custom",
			message: `review key ${reviewId} does not match its capability`,
			path: ["reviews", reviewId]
		});
		const worker = state.roles[review.capability.workerRoleId];
		const judge = state.roles[review.capability.judgeRoleId];
		if (worker?.sessionId !== review.capability.workerSessionId || judge?.sessionId !== review.capability.judgeSessionId) context.addIssue({
			code: "custom",
			message: `review ${reviewId} role Session binding does not match RuntimeState`,
			path: ["reviews", reviewId]
		});
		if (state.config !== void 0 && review.capability.configRevision > state.config.revision) context.addIssue({
			code: "custom",
			message: `review ${reviewId} config revision does not match RuntimeState`,
			path: ["reviews", reviewId]
		});
		if (review.resolution !== void 0 && state.roles[review.resolution.targetRoleId]?.sessionId !== review.resolution.targetSessionId) context.addIssue({
			code: "custom",
			message: `review ${reviewId} resolution target does not match RuntimeState`,
			path: [
				"reviews",
				reviewId,
				"resolution"
			]
		});
	}
	for (const [laneId$2, candidate] of Object.entries(state.candidates)) {
		const coder = state.roles[candidate.coderRoleId];
		if (candidate.laneId !== laneId$2) context.addIssue({
			code: "custom",
			message: `candidate key ${laneId$2} does not match its Lane identity`,
			path: ["candidates", laneId$2]
		});
		if (coder?.sessionId !== candidate.coderSessionId || coder.goalInstall !== void 0 && coder.goalInstall.assignmentId !== candidate.assignmentId) context.addIssue({
			code: "custom",
			message: `candidate ${candidate.candidateId} does not match its Coder Assignment`,
			path: ["candidates", laneId$2]
		});
		if (state.config !== void 0 && candidate.sourceRevision > state.config.revision) context.addIssue({
			code: "custom",
			message: `candidate ${candidate.candidateId} config revision does not match RuntimeState`,
			path: ["candidates", laneId$2]
		});
	}
	for (const [candidateId, candidate] of Object.entries(state.retiredCandidates)) {
		const coder = state.roles[candidate.coderRoleId];
		if (candidate.candidateId !== candidateId) context.addIssue({
			code: "custom",
			message: `retired candidate key ${candidateId} does not match its identity`,
			path: ["retiredCandidates", candidateId]
		});
		if (coder?.sessionId !== candidate.coderSessionId) context.addIssue({
			code: "custom",
			message: `retired candidate ${candidate.candidateId} does not match its Coder Session`,
			path: ["retiredCandidates", candidateId]
		});
		if (coder?.goalInstall !== void 0 && coder.goalInstall.assignmentId === candidate.assignmentId) context.addIssue({
			code: "custom",
			message: `retired candidate ${candidate.candidateId} still matches the active Coder Assignment`,
			path: ["retiredCandidates", candidateId]
		});
		if (state.candidates[candidate.laneId] !== void 0) {
			const active = state.candidates[candidate.laneId];
			if (active.candidateId === candidate.candidateId && active.candidateSha === candidate.candidateSha) context.addIssue({
				code: "custom",
				message: `candidate ${candidate.candidateId} is both active and retired`,
				path: ["retiredCandidates", candidateId]
			});
		}
		if (state.config !== void 0 && candidate.sourceRevision > state.config.revision) context.addIssue({
			code: "custom",
			message: `retired candidate ${candidate.candidateId} config revision does not match RuntimeState`,
			path: ["retiredCandidates", candidateId]
		});
	}
	for (const [trialId, trial] of Object.entries(state.trials)) {
		const matches = (record$1) => record$1 !== void 0 && record$1.candidateId === trial.candidateId && record$1.candidateSha === trial.candidateSha && record$1.sourceRevision === trial.sourceRevision;
		const active = state.candidates[trial.laneId];
		if ((matches(active) ? active : matches(state.retiredCandidates[trial.candidateId]) ? state.retiredCandidates[trial.candidateId] : void 0) === void 0) context.addIssue({
			code: "custom",
			message: `Trial ${trialId} does not descend from its active or retired READY Candidate plan`,
			path: ["trials", trialId]
		});
		if (state.config !== void 0 && trial.sourceRevision > state.config.revision) context.addIssue({
			code: "custom",
			message: `Trial ${trialId} config revision does not match RuntimeState`,
			path: ["trials", trialId]
		});
		for (const slot of Object.values(trial.runSlots)) if (slot.state.trial_id !== trialId) context.addIssue({
			code: "custom",
			message: `Trial ${trialId} RunSlot belongs to another Trial`,
			path: [
				"trials",
				trialId,
				"runSlots"
			]
		});
	}
});
var ReviewResolutionError = class extends Error {
	name = "ReviewResolutionError";
	constructor(message, code) {
		super(message);
		this.code = code;
	}
};
function resolutionHash(body) {
	return sha256(`autolab-review-resolution-v1\0${canonicalJson$1(reviewResolutionBodySchema.parse(body))}`);
}
/** The only worker-freeze states from which a persisted verdict may advance. */
function reviewFreezeComplete(review, ownerEpoch) {
	return review.pause.freeze === "stopped" || review.pause.freeze === "held" && review.pause.holdOwnerEpoch === ownerEpoch;
}
/** Verdict and freeze are independent axes; both must meet at this boundary. */
function reviewReadyToAdvance(review, ownerEpoch) {
	return review.phase === "verdict_recorded" && review.resolution === void 0 && reviewFreezeComplete(review, ownerEpoch);
}
/**
* Record one already-applied deterministic route. This is a terminal marker,
* not another lifecycle axis: exact retries are no-ops and conflicts fail.
*/
function recordReviewResolution(review, ownerEpoch, resolution, updatedAt) {
	const marker = reviewResolutionStateSchema.parse(resolution);
	if (review.resolution !== void 0) {
		if (canonicalJson$1(review.resolution) === canonicalJson$1(marker)) return review;
		throw new ReviewResolutionError(`Review ${review.capability.reviewId} already records another resolution`, "RESOLUTION_CONFLICT");
	}
	if (!reviewReadyToAdvance(review, ownerEpoch)) throw new ReviewResolutionError(`Review ${review.capability.reviewId} is not ready to record an applied route`, "NOT_READY");
	if (review.verdict === void 0 || marker.reviewId !== review.capability.reviewId || marker.verdictHash !== review.verdict.hash) throw new ReviewResolutionError(`Review ${review.capability.reviewId} route does not match its verdict`, "VERDICT_MISMATCH");
	const { holdOwnerEpoch: _releasedOwner,...pause } = review.pause;
	return activeReviewSchema.parse({
		...review,
		pause: {
			...pause,
			freeze: "stopped"
		},
		resolution: marker,
		updatedAt: Math.max(review.updatedAt, updatedAt)
	});
}
const autolabDomainSpec = defineDomain({
	name: "autolab",
	version: 1,
	tables: {
		labs: domainTable(runtimeStateSchema),
		api_recoveries: domainTable(apiRecoveryRecordSchema)
	}
});
const LEGAL_TRANSITIONS = {
	configuring: new Set([
		"draft_ready",
		"ready",
		"blocked",
		"stopped"
	]),
	draft_ready: new Set([
		"configuring",
		"ready",
		"blocked",
		"stopped"
	]),
	ready: new Set([
		"starting",
		"paused",
		"blocked",
		"stopped"
	]),
	starting: new Set([
		"running",
		"blocked",
		"paused"
	]),
	running: new Set([
		"starting",
		"pausing",
		"blocked",
		"stopped"
	]),
	pausing: new Set(["paused", "blocked"]),
	paused: new Set([
		"starting",
		"blocked",
		"stopped"
	]),
	blocked: new Set([
		"configuring",
		"draft_ready",
		"ready",
		"starting",
		"pausing",
		"paused",
		"stopped"
	]),
	stopped: /* @__PURE__ */ new Set()
};
var AutoLabStateError = class extends Error {
	name = "AutoLabStateError";
	constructor(message, code) {
		super(message);
		this.code = code;
	}
};
function createRuntimeState(input) {
	const now = input.now ?? Date.now();
	return parseState({
		schemaVersion: 1,
		labId: input.labId,
		runtimeRevision: 0,
		ownerEpoch: input.ownerEpoch,
		controllerSessionId: input.controllerSessionId,
		lifecycle: input.lifecycle,
		...input.config === void 0 ? {} : { config: input.config },
		...input.revealState === void 0 ? {} : { revealState: input.revealState },
		roles: {},
		reviews: {},
		candidates: {},
		retiredCandidates: {},
		trials: {},
		createdAt: now,
		updatedAt: now
	});
}
function transitionRuntimeState(current, input) {
	const validated = parseState(current);
	if (validated.ownerEpoch !== input.ownerEpoch) throw new AutoLabStateError("controller owner epoch no longer matches", "OWNER_FENCE_LOST");
	if (validated.runtimeRevision !== input.expectedRevision) throw new AutoLabStateError(`expected controller revision ${input.expectedRevision}, found ${validated.runtimeRevision}`, "REVISION_CONFLICT");
	if (input.lifecycle !== validated.lifecycle && !LEGAL_TRANSITIONS[validated.lifecycle].has(input.lifecycle)) throw new AutoLabStateError(`invalid lifecycle transition ${validated.lifecycle} -> ${input.lifecycle}`, "INVALID_TRANSITION");
	const observedNow = input.now ?? Date.now();
	if (input.now !== void 0 && observedNow < validated.updatedAt) throw new AutoLabStateError("controller time must be monotonic", "INVALID_STATE");
	const now = Math.max(observedNow, validated.updatedAt);
	const blocker = resolveBlocker(validated, input.lifecycle, input.blocker);
	const config = input.config === void 0 ? validated.config : input.config ?? void 0;
	const revealState = input.revealState === void 0 ? validated.revealState : input.revealState;
	const controllerGoal = input.controllerGoal === void 0 ? validated.controllerGoal : input.controllerGoal ?? void 0;
	const roles = input.roles === void 0 ? validated.roles : input.roles;
	const reviews = input.reviews === void 0 ? validated.reviews : input.reviews;
	const candidates = input.candidates === void 0 ? validated.candidates : input.candidates;
	const retiredCandidates = input.retiredCandidates === void 0 ? validated.retiredCandidates : input.retiredCandidates;
	const trials = input.trials === void 0 ? validated.trials : input.trials;
	const { blocker: _priorBlocker, config: _priorConfig, revealState: _priorRevealState, controllerGoal: _priorControllerGoal, roles: _priorRoles, reviews: _priorReviews, candidates: _priorCandidates, retiredCandidates: _priorRetiredCandidates, trials: _priorTrials,...withoutProjection } = validated;
	return parseState({
		...withoutProjection,
		lifecycle: input.lifecycle,
		runtimeRevision: validated.runtimeRevision + 1,
		updatedAt: now,
		roles,
		reviews,
		candidates,
		retiredCandidates,
		trials,
		...controllerGoal === void 0 ? {} : { controllerGoal },
		...config === void 0 ? {} : { config },
		...revealState === void 0 ? {} : { revealState },
		...blocker === void 0 ? {} : { blocker }
	});
}
function adoptRuntimeOwner(current, ownerEpoch, now) {
	const validated = parseState(current);
	if (validated.ownerEpoch === ownerEpoch) return validated;
	const observedNow = now ?? Date.now();
	if (now !== void 0 && observedNow < validated.updatedAt) throw new AutoLabStateError("controller time must be monotonic", "INVALID_STATE");
	return parseState({
		...validated,
		ownerEpoch,
		runtimeRevision: validated.runtimeRevision + 1,
		updatedAt: Math.max(observedNow, validated.updatedAt)
	});
}
function parseState(value) {
	const parsed = runtimeStateSchema.safeParse(value);
	if (!parsed.success) throw new AutoLabStateError(`invalid RuntimeState: ${parsed.error.message}`, "INVALID_STATE");
	return parsed.data;
}
function validateLabId(value) {
	if (!LAB_ID_PATTERN.test(value)) throw new AutoLabStateError(`invalid lab id ${JSON.stringify(value)}`, "INVALID_STATE");
	return value;
}
function resolveBlocker(current, lifecycle, requested) {
	if (lifecycle !== "blocked") {
		if (requested !== void 0 && requested !== null) throw new AutoLabStateError("only blocked lifecycle may carry a blocker", "INVALID_STATE");
		return;
	}
	if (requested === null) throw new AutoLabStateError("blocked lifecycle cannot clear its blocker", "INVALID_STATE");
	const blocker = requested ?? current.blocker;
	if (blocker === void 0) throw new AutoLabStateError("blocked lifecycle requires a blocker", "INVALID_STATE");
	return blocker;
}

//#endregion
//#region src/manifest.ts
const SHA256_PATTERN$16 = /^[0-9a-f]{64}$/u;
const GIT_SHA_PATTERN$2 = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const idSchema$1 = z.string().min(1);
const hashSchema$1 = z.string().regex(SHA256_PATTERN$16);
const gitShaSchema = z.string().regex(GIT_SHA_PATTERN$2);
const absolutePathSchema$1 = z.string().min(1).refine(isAbsolute, "path must be absolute");
const stringListSchema = z.array(z.string().min(1));
const jsonObjectSchema = z.record(z.string(), z.json());
const maxGoalRoundsSchema = z.number().int().positive();
const componentRefSchema = z.object({
	id: idSchema$1,
	version: idSchema$1,
	sha256: hashSchema$1
}).strict();
const modelRouteSchema = z.object({
	route_id: idSchema$1,
	provider: idSchema$1,
	model: idSchema$1,
	config: jsonObjectSchema
}).strict();
const reasoningSchema = z.object({
	mode: idSchema$1,
	config: jsonObjectSchema
}).strict();
const roleCommonShape = {
	role_id: idSchema$1,
	model_route: modelRouteSchema,
	fallback_routes: z.array(modelRouteSchema),
	dsh_preset: z.enum([
		"read-only",
		"workspace-write",
		"danger-full-access"
	]),
	reasoning: reasoningSchema,
	allowed_tools: stringListSchema,
	prompt_sha256: hashSchema$1
};
const controllerRoleSchema = z.object({
	...roleCommonShape,
	role_kind: z.literal("controller"),
	max_goal_rounds: maxGoalRoundsSchema,
	prebound_session_id: idSchema$1
}).strict();
const methodRoleSchema = z.object({
	...roleCommonShape,
	role_kind: z.literal("method"),
	max_goal_rounds: maxGoalRoundsSchema,
	lane_id: idSchema$1,
	worktree_path: absolutePathSchema$1,
	prebound_session_id: idSchema$1.optional()
}).strict();
const coderRoleSchema = z.object({
	...roleCommonShape,
	role_kind: z.literal("coder"),
	max_goal_rounds: maxGoalRoundsSchema,
	lane_id: idSchema$1,
	worktree_path: absolutePathSchema$1,
	prebound_session_id: idSchema$1.optional()
}).strict();
const preflightRoleSchema = z.object({
	...roleCommonShape,
	role_kind: z.literal("preflight_judge"),
	lane_id: idSchema$1,
	prebound_session_id: idSchema$1.optional()
}).strict();
const postflightRoleSchema = z.object({
	...roleCommonShape,
	role_kind: z.literal("postflight_judge"),
	lane_id: idSchema$1,
	prebound_session_id: idSchema$1.optional()
}).strict();
const opsRoleSchema = z.object({
	...roleCommonShape,
	role_kind: z.literal("ops"),
	max_goal_rounds: maxGoalRoundsSchema,
	resource_domain: idSchema$1,
	prebound_session_id: idSchema$1.optional()
}).strict();
const coordinatorRoleSchema = z.object({
	...roleCommonShape,
	role_kind: z.literal("coordinator"),
	max_goal_rounds: maxGoalRoundsSchema,
	prebound_session_id: idSchema$1.optional()
}).strict();
const roleBindingSchema = z.discriminatedUnion("role_kind", [
	controllerRoleSchema,
	methodRoleSchema,
	coderRoleSchema,
	preflightRoleSchema,
	postflightRoleSchema,
	opsRoleSchema,
	coordinatorRoleSchema
]);
const laneCharterSchema = z.object({
	lane_id: idSchema$1,
	charter_sha256: hashSchema$1,
	content: jsonObjectSchema
}).strict();
const laneBindingSchema = z.object({
	lane_id: idSchema$1,
	worktree_path: absolutePathSchema$1,
	base_ref: idSchema$1,
	base_sha: gitShaSchema,
	method_role_id: idSchema$1,
	coder_role_id: idSchema$1,
	preflight_judge_role_id: idSchema$1,
	postflight_judge_role_id: idSchema$1
}).strict();
const hostSchema = z.object({
	host_id: idSchema$1,
	runner_target: idSchema$1
}).strict();
const gpuSchema = z.object({
	gpu_id: idSchema$1,
	host_id: idSchema$1
}).strict();
const roleCommunicationSchema = z.object({
	role_id: idSchema$1,
	send: z.boolean(),
	receive: z.boolean()
}).strict();
const pairBlockSchema = z.object({
	role_ids: z.tuple([idSchema$1, idSchema$1]),
	active_when: z.enum([
		"before_reveal",
		"after_reveal",
		"always"
	])
}).strict();
const provenanceSchema = z.string().refine((value) => value === "user" || value === "proposed" || value === "default" || value.startsWith("discovered:") && value.length > 11 || value.startsWith("inherited:") && value.length > 10, "invalid provenance");
const resolvedManifestSchema = z.object({
	schema_version: z.literal(1),
	lab_id: idSchema$1,
	source_revision: z.number().int().positive(),
	campaign_contract_sha256: hashSchema$1,
	anchors: z.object({
		dialogue_head_sha256: hashSchema$1,
		lab_spec_sha256: hashSchema$1,
		lab_yaml_sha256: hashSchema$1
	}).strict(),
	authority_paths: z.object({
		lab_dir: absolutePathSchema$1,
		creation_log: absolutePathSchema$1,
		lab_spec: absolutePathSchema$1,
		lab_yaml: absolutePathSchema$1,
		resolved_manifest: absolutePathSchema$1,
		fact_set: absolutePathSchema$1,
		evidence_index: absolutePathSchema$1,
		assignment_root: absolutePathSchema$1,
		worktree_root: absolutePathSchema$1
	}).strict(),
	versions: z.object({
		autolab_plugin: idSchema$1,
		dsh: idSchema$1
	}).strict(),
	repository: z.object({
		path: absolutePathSchema$1,
		base_ref: idSchema$1,
		base_sha: gitShaSchema
	}).strict(),
	research: jsonObjectSchema,
	contract: jsonObjectSchema,
	search: z.object({
		search_mode: z.enum(["sequential", "cohort"]),
		research_route_authority: z.enum(["user", "autolab"]).optional(),
		lane_count: z.number().int().positive(),
		coordinator_enabled: z.boolean(),
		lane_charters: z.array(laneCharterSchema).min(1)
	}).strict(),
	lanes: z.array(laneBindingSchema).min(1),
	roles: z.array(roleBindingSchema).min(1),
	execution: z.object({
		runner_adapter: componentRefSchema,
		hosts: z.array(hostSchema).min(1),
		gpu_pool: z.array(gpuSchema),
		max_parallel_gpu_attempts: z.number().int().nonnegative(),
		run_root: absolutePathSchema$1,
		contract: jsonObjectSchema
	}).strict(),
	evidence: z.object({
		artifact_root: absolutePathSchema$1,
		contract: jsonObjectSchema
	}).strict(),
	communication: z.object({
		topology: z.enum(["lane_isolated", "coordinated"]),
		acl_revision: z.number().int().nonnegative(),
		controller_visibility: z.literal("global"),
		coordinator_visibility: z.enum([
			"disabled",
			"runtime_only",
			"revealed",
			"global"
		]),
		role_permissions: z.array(roleCommunicationSchema).min(1),
		text_method_coder_within_lane: z.enum(["allowed", "blocked"]),
		text_pair_blocks: z.array(pairBlockSchema),
		reveal_policy: z.object({
			initial_state: z.enum(["sealed", "revealed"]),
			trigger: z.enum([
				"manual",
				"cohort_barrier",
				"immediate"
			]),
			text_cross_lane_before_reveal: z.enum(["blocked", "allowed"]),
			text_cross_lane_after_reveal: z.enum(["blocked", "allowed"])
		}).strict(),
		api_recovery: idSchema$1,
		attempt_recovery: idSchema$1,
		stop_pause_policy: idSchema$1
	}).strict(),
	provenance: z.record(z.string().min(1), provenanceSchema)
}).strict().superRefine((manifest, context) => {
	const charterIds = uniqueIndex(manifest.search.lane_charters, (charter) => charter.lane_id, context, ["search", "lane_charters"], "lane charter");
	const lanes = uniqueIndex(manifest.lanes, (lane) => lane.lane_id, context, ["lanes"], "lane");
	if (manifest.search.lane_count !== manifest.lanes.length || manifest.search.lane_count !== manifest.search.lane_charters.length) issue(context, ["search", "lane_count"], "lane_count must match lanes and lane_charters");
	for (const laneId$2 of charterIds.keys()) if (!lanes.has(laneId$2)) issue(context, ["lanes"], `missing lane binding for ${laneId$2}`);
	for (const laneId$2 of lanes.keys()) if (!charterIds.has(laneId$2)) issue(context, ["search", "lane_charters"], `missing lane charter for ${laneId$2}`);
	const worktrees = /* @__PURE__ */ new Map();
	for (const lane of manifest.lanes) {
		const normalized = resolve(lane.worktree_path);
		const owner = worktrees.get(normalized);
		if (owner !== void 0 && owner !== lane.lane_id) issue(context, ["lanes"], `lanes ${owner} and ${lane.lane_id} share worktree ${normalized}`);
		else worktrees.set(normalized, lane.lane_id);
	}
	const roles = uniqueIndex(manifest.roles, (role) => role.role_id, context, ["roles"], "role");
	const controllers = manifest.roles.filter((role) => role.role_kind === "controller");
	if (controllers.length !== 1) issue(context, ["roles"], "exactly one Controller role is required");
	if (!manifest.roles.some((role) => role.role_kind === "ops")) issue(context, ["roles"], "at least one Ops role is required");
	if (manifest.roles.filter((role) => role.role_kind === "coordinator").length !== (manifest.search.coordinator_enabled ? 1 : 0)) issue(context, ["roles"], manifest.search.coordinator_enabled ? "coordinator_enabled requires exactly one Coordinator role" : "Coordinator role requires coordinator_enabled");
	if (manifest.communication.coordinator_visibility === "disabled" !== !manifest.search.coordinator_enabled) issue(context, ["communication", "coordinator_visibility"], "Coordinator visibility must match coordinator_enabled");
	const sessionOwners = /* @__PURE__ */ new Map();
	for (const role of manifest.roles) {
		const sessionId = role.prebound_session_id;
		if (sessionId === void 0) continue;
		const owner = sessionOwners.get(sessionId);
		if (owner !== void 0) issue(context, ["roles"], `roles ${owner} and ${role.role_id} reuse prebound SessionId ${sessionId}`);
		else sessionOwners.set(sessionId, role.role_id);
	}
	const boundLaneRoles = /* @__PURE__ */ new Set();
	for (const [laneIndex, lane] of manifest.lanes.entries()) {
		const expected = [
			[
				"method_role_id",
				lane.method_role_id,
				"method"
			],
			[
				"coder_role_id",
				lane.coder_role_id,
				"coder"
			],
			[
				"preflight_judge_role_id",
				lane.preflight_judge_role_id,
				"preflight_judge"
			],
			[
				"postflight_judge_role_id",
				lane.postflight_judge_role_id,
				"postflight_judge"
			]
		];
		if (new Set(expected.map(([, roleId]) => roleId)).size !== expected.length) issue(context, ["lanes", laneIndex], `lane ${lane.lane_id} requires four independent roles`);
		for (const [field, roleId, kind] of expected) {
			const role = roles.get(roleId);
			if (role === void 0) {
				issue(context, [
					"lanes",
					laneIndex,
					field
				], `unknown role ${roleId}`);
				continue;
			}
			if (role.role_kind !== kind || !("lane_id" in role) || role.lane_id !== lane.lane_id) issue(context, [
				"lanes",
				laneIndex,
				field
			], `${roleId} must be the ${kind} role for lane ${lane.lane_id}`);
			boundLaneRoles.add(roleId);
			if ((kind === "method" || kind === "coder") && "worktree_path" in role && resolve(role.worktree_path) !== resolve(lane.worktree_path)) issue(context, ["roles"], `${roleId} must use its lane worktree ${lane.worktree_path}`);
		}
	}
	for (const role of manifest.roles) if ("lane_id" in role && !boundLaneRoles.has(role.role_id)) issue(context, ["roles"], `lane role ${role.role_id} is not bound by its lane`);
	const permissions = uniqueIndex(manifest.communication.role_permissions, (permission) => permission.role_id, context, ["communication", "role_permissions"], "role permission");
	for (const roleId of roles.keys()) if (!permissions.has(roleId)) issue(context, ["communication", "role_permissions"], `missing communication permission for ${roleId}`);
	for (const roleId of permissions.keys()) if (!roles.has(roleId)) issue(context, ["communication", "role_permissions"], `communication permission references unknown role ${roleId}`);
	const controller = controllers[0];
	if (controller !== void 0) {
		const permission = permissions.get(controller.role_id);
		if (permission?.send !== true || permission.receive !== true) issue(context, ["communication", "role_permissions"], "Controller send and receive must remain enabled");
	}
	const blocks = /* @__PURE__ */ new Set();
	for (const [blockIndex, block] of manifest.communication.text_pair_blocks.entries()) {
		const [first, second] = block.role_ids;
		if (first === second) issue(context, [
			"communication",
			"text_pair_blocks",
			blockIndex
		], "text pair block cannot target one role twice");
		if (!roles.has(first) || !roles.has(second)) issue(context, [
			"communication",
			"text_pair_blocks",
			blockIndex
		], "text pair block references an unknown role");
		if (controller !== void 0 && (first === controller.role_id || second === controller.role_id)) issue(context, [
			"communication",
			"text_pair_blocks",
			blockIndex
		], "Controller cannot be hidden by a text pair block");
		const key = `${[first, second].sort().join("\0")}\0${block.active_when}`;
		if (blocks.has(key)) issue(context, [
			"communication",
			"text_pair_blocks",
			blockIndex
		], "duplicate text pair block");
		blocks.add(key);
	}
	if ((manifest.communication.topology === "lane_isolated" || manifest.search.search_mode === "cohort") && manifest.communication.reveal_policy.text_cross_lane_before_reveal !== "blocked") issue(context, [
		"communication",
		"reveal_policy",
		"text_cross_lane_before_reveal"
	], "isolated/cohort Lane text must be blocked before reveal");
	const hosts = uniqueIndex(manifest.execution.hosts, (host) => host.host_id, context, ["execution", "hosts"], "host");
	const gpuIds = /* @__PURE__ */ new Set();
	for (const [gpuIndex, gpu] of manifest.execution.gpu_pool.entries()) {
		if (gpuIds.has(gpu.gpu_id)) issue(context, [
			"execution",
			"gpu_pool",
			gpuIndex
		], `duplicate GPU ${gpu.gpu_id}`);
		gpuIds.add(gpu.gpu_id);
		if (!hosts.has(gpu.host_id)) issue(context, [
			"execution",
			"gpu_pool",
			gpuIndex,
			"host_id"
		], `unknown host ${gpu.host_id}`);
	}
});
var ManifestValidationError = class extends Error {
	name = "ManifestValidationError";
	code = "INVALID_MANIFEST";
	constructor(message, issues) {
		super(message);
		this.issues = issues;
	}
};
function parseResolvedManifest(value) {
	const parsed = resolvedManifestSchema.safeParse(value);
	if (!parsed.success) throw new ManifestValidationError(formatIssues$5(parsed.error.issues), parsed.error.issues);
	return parsed.data;
}
function hashResolvedManifest(value) {
	return sha256(canonicalJson$1(parseResolvedManifest(value)));
}
function uniqueIndex(values, keyOf, context, path, label) {
	const index = /* @__PURE__ */ new Map();
	for (const [position, value] of values.entries()) {
		const key = keyOf(value);
		if (index.has(key)) issue(context, [...path, position], `duplicate ${label} ${key}`);
		else index.set(key, value);
	}
	return index;
}
function issue(context, path, message) {
	context.addIssue({
		code: "custom",
		path,
		message
	});
}
function formatIssues$5(issues) {
	return issues.map((issue$1) => `${issue$1.path.join(".") || "<root>"}: ${issue$1.message}`).join("; ");
}

//#endregion
//#region src/artifacts.ts
const UTF8$8 = new TextDecoder("utf-8", {
	fatal: true,
	ignoreBOM: true
});
var ArtifactError = class extends Error {
	name = "ArtifactError";
	constructor(message, code) {
		super(message);
		this.code = code;
	}
};
var ArtifactStore = class {
	root;
	labsRoot;
	constructor(root) {
		this.root = resolve(root);
		this.labsRoot = join(this.root, "labs");
	}
	async initialize() {
		await mkdir(this.labsRoot, {
			recursive: true,
			mode: 448
		});
	}
	labDirectory(labId) {
		return join(this.labsRoot, validateLabId(labId));
	}
	async createLab(input) {
		const directory = this.labDirectory(input.labId);
		try {
			await mkdir(directory, { mode: 448 });
		} catch (error) {
			if (isNodeError$17(error) && error.code === "EEXIST") throw new ArtifactError(`lab directory already exists: ${directory}`, "LAB_EXISTS");
			throw error;
		}
		try {
			await mkdir(join(directory, "draft"), { mode: 448 });
			await mkdir(join(directory, "dialogue"), { mode: 448 });
			await mkdir(join(directory, "sources"), { mode: 448 });
			await mkdir(join(directory, "revisions"), { mode: 448 });
			await mkdir(join(directory, "receipts"), { mode: 448 });
			await mkdir(join(directory, "artifacts"), { mode: 448 });
			await mkdir(join(directory, "packets"), { mode: 448 });
			await mkdir(join(directory, "assignments"), { mode: 448 });
			const imported = input.sourceDirectory !== void 0;
			const documents = imported ? await readSourceDocuments(input.sourceDirectory) : {
				specBytes: new Uint8Array(),
				configBytes: new Uint8Array(),
				spec: "",
				config: ""
			};
			await Promise.all([durableWriteFile(join(directory, "draft", "LAB_SPEC.md"), documents.specBytes, false), durableWriteFile(join(directory, "draft", "lab.yaml"), documents.configBytes, false)]);
			return {
				labId: input.labId,
				directory,
				draft: draftSnapshot(documents),
				imported
			};
		} catch (error) {
			await rm(directory, {
				recursive: true,
				force: true
			});
			throw error;
		}
	}
	async readDraft(labId) {
		const directory = this.labDirectory(labId);
		if ((await stat(directory).catch(() => void 0))?.isDirectory() !== true) throw new ArtifactError(`Lab ${labId} was not found`, "LAB_NOT_FOUND");
		const [specBytes, configBytes] = await Promise.all([readFile(join(directory, "draft", "LAB_SPEC.md")).catch(() => void 0), readFile(join(directory, "draft", "lab.yaml")).catch(() => void 0)]);
		if (specBytes === void 0 || configBytes === void 0) throw new ArtifactError("Lab draft is incomplete", "INVALID_SOURCE");
		return draftSnapshot({
			specBytes,
			configBytes,
			spec: decodeText(specBytes, "LAB_SPEC.md"),
			config: decodeText(configBytes, "lab.yaml")
		});
	}
	async freezeDraftRevision(input) {
		const { labId, revision } = input;
		if (!Number.isSafeInteger(revision) || revision <= 0) throw new ArtifactError("revision must be a positive safe integer", "INVALID_SOURCE");
		const draft = await this.readDraft(labId);
		if (draft.spec.trim().length === 0 || draft.config.trim().length === 0) throw new ArtifactError("LAB_SPEC.md and lab.yaml must not be empty", "INVALID_SOURCE");
		return await this.freezeRevision({
			labId,
			revision,
			specBytes: await readFile(join(this.labDirectory(labId), "draft", "LAB_SPEC.md")),
			configBytes: await readFile(join(this.labDirectory(labId), "draft", "lab.yaml")),
			spec: draft.spec,
			config: draft.config,
			manifest: input.manifest,
			dialogueHeadHash: input.dialogueHeadHash
		});
	}
	/** Exact rollback for a create transaction that never reached RuntimeState. */
	async discardScaffold(labId) {
		await rm(this.labDirectory(labId), {
			recursive: true,
			force: true
		});
	}
	async freezeImportedRevision(labId, sourceDirectory, revision, manifest, dialogueHeadHash) {
		if (!Number.isSafeInteger(revision) || revision <= 0) throw new ArtifactError("revision must be a positive safe integer", "INVALID_SOURCE");
		const { specBytes, configBytes, spec, config } = await readSourceDocuments(sourceDirectory);
		return await this.freezeRevision({
			labId,
			revision,
			specBytes,
			configBytes,
			spec,
			config,
			manifest,
			dialogueHeadHash
		});
	}
	async readCurrent(labId) {
		const directory = this.labDirectory(labId);
		if ((await stat(directory).catch((error) => {
			if (isNodeError$17(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) return void 0;
			throw error;
		}))?.isDirectory() !== true) throw new ArtifactError(`Lab ${labId} was not found`, "LAB_NOT_FOUND");
		return await readFrozenRevision(directory, await readCurrentPointer(join(directory, "CURRENT")));
	}
	/** Return no revision only when CURRENT is genuinely absent. */
	async readCurrentIfPresent(labId) {
		const currentStat = await stat(join(this.labDirectory(labId), "CURRENT")).catch((error) => {
			if (isNodeError$17(error) && error.code === "ENOENT") return void 0;
			throw error;
		});
		if (currentStat === void 0) return void 0;
		if (!currentStat.isFile()) throw new ArtifactError("CURRENT is not a regular file", "INVALID_CURRENT");
		return await this.readCurrent(labId);
	}
	/** Read one committed revision by number (historical or current). */
	async readRevisionAt(labId, revision) {
		return await readRevisionAtPath(this.labDirectory(labId), revision);
	}
	/** Freeze one Controller-authored configuration revision from exact texts. */
	async freezeConfigRevision(input) {
		if (input.spec.trim().length === 0 || input.config.trim().length === 0) throw new ArtifactError("LAB_SPEC.md and lab.yaml must not be empty", "INVALID_SOURCE");
		return await this.freezeRevision({
			labId: input.labId,
			revision: input.revision,
			specBytes: new TextEncoder().encode(input.spec),
			configBytes: new TextEncoder().encode(input.config),
			spec: input.spec,
			config: input.config,
			manifest: input.manifest,
			dialogueHeadHash: input.dialogueHeadHash
		});
	}
	async freezeRevision(input) {
		const labDirectory = this.labDirectory(input.labId);
		const revisions = join(labDirectory, "revisions");
		const revisionName = String(input.revision).padStart(6, "0");
		const revisionDirectory = join(revisions, revisionName);
		const temporary = join(revisions, `.${revisionName}.${randomUUID()}.tmp`);
		await mkdir(temporary, { mode: 448 });
		try {
			const specHash = sha256(input.specBytes);
			const configHash = sha256(input.configBytes);
			const manifestJson = canonicalJson$1(validateRevisionManifest({
				manifest: input.manifest,
				labId: input.labId,
				labDirectory,
				revision: input.revision,
				specHash,
				configHash,
				dialogueHeadHash: input.dialogueHeadHash
			}));
			const manifestHash = sha256(manifestJson);
			const validation = {
				version: 1,
				hashAlgorithm: "sha256",
				manifestCanonicalization: "autolab-canonical-json-v1",
				dialogueHeadHash: input.dialogueHeadHash,
				specHash,
				configHash,
				manifestHash
			};
			await durableWriteFile(join(temporary, "LAB_SPEC.md"), input.specBytes, false);
			await durableWriteFile(join(temporary, "lab.yaml"), input.configBytes, false);
			await durableWriteFile(join(temporary, "RESOLVED_MANIFEST.json"), manifestJson, false);
			await durableWriteFile(join(temporary, "VALIDATION.json"), `${JSON.stringify(validation, null, 2)}\n`, false);
			const metadata = {
				version: 2,
				revision: input.revision,
				specHash,
				configHash,
				manifestHash,
				dialogueHeadHash: input.dialogueHeadHash
			};
			await durableWriteFile(join(temporary, "REVISION.json"), `${JSON.stringify(metadata, null, 2)}\n`, false);
			await syncDirectory$1(temporary);
			let created = false;
			try {
				await rename(temporary, revisionDirectory);
				created = true;
			} catch (error) {
				if (!isNodeError$17(error) || error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
			}
			if (created) await syncDirectory$1(revisions);
			const pointer = {
				version: 2,
				revision: input.revision,
				revisionPath: relative(labDirectory, revisionDirectory),
				specHash,
				configHash,
				manifestHash,
				dialogueHeadHash: input.dialogueHeadHash
			};
			const committed = await readFrozenRevision(labDirectory, pointer);
			if (committed.ref.specHash !== specHash || committed.ref.configHash !== configHash || committed.ref.manifestHash !== manifestHash || committed.ref.dialogueHeadHash !== input.dialogueHeadHash) throw new ArtifactError(`revision ${input.revision} already exists with other bytes`, "REVISION_EXISTS");
			if (!created && (committed.spec !== input.spec || committed.config !== input.config || canonicalJson$1(committed.manifest) !== manifestJson)) throw new ArtifactError(`revision ${input.revision} already exists with other text`, "REVISION_EXISTS");
			await durableWriteFile(join(labDirectory, "CURRENT"), `${JSON.stringify(pointer, null, 2)}\n`, true);
			return committed;
		} finally {
			await rm(temporary, {
				recursive: true,
				force: true
			});
		}
	}
};
function generateLabId(now = /* @__PURE__ */ new Date()) {
	return `lab-${[
		now.getFullYear(),
		two(now.getMonth() + 1),
		two(now.getDate())
	].join("")}-${[
		two(now.getHours()),
		two(now.getMinutes()),
		two(now.getSeconds())
	].join("")}-${randomBytes(4).toString("hex")}`;
}
async function durableWriteFile(path, value, replace) {
	await mkdir(dirname(path), {
		recursive: true,
		mode: 448
	});
	const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
	const handle = await open(temporary, "wx", 384);
	try {
		await handle.writeFile(value);
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		if (replace) await rename(temporary, path);
		else await link(temporary, path);
		await syncDirectory$1(dirname(path));
	} finally {
		await rm(temporary, { force: true });
	}
}
/**
* Read one committed revision by number directly from the lab directory. Used
* by packet-verify paths so that a packet compiled under an older revision is
* verified against its own revision's texts after CURRENT advances.
*/
/** All committed revision manifestHashes (any revision number on disk). */
async function listCommittedManifestHashes(labDirectory) {
	const revisions = resolve(labDirectory, "revisions");
	const names = await readdir(revisions).catch(() => []);
	const hashes = /* @__PURE__ */ new Set();
	for (const name of names) {
		if (!/^\d{6}$/u.test(name)) continue;
		const metadataBytes = await readFile(join(revisions, name, "REVISION.json")).catch(() => void 0);
		if (metadataBytes === void 0) continue;
		try {
			const metadata = JSON.parse(decodeText(metadataBytes, "REVISION.json"));
			if (isRevisionMetadata(metadata)) hashes.add(metadata.manifestHash);
		} catch {
			continue;
		}
	}
	return hashes;
}
/** True when the hash matches the manifestHash of any committed revision <= current. */
async function isCommittedManifestHash(labDirectory, manifestHash) {
	return (await listCommittedManifestHashes(labDirectory)).has(manifestHash);
}
async function readRevisionAtPath(labDirectory, revision, current) {
	if (current !== void 0 && current.ref.revision === revision) return current;
	const metadataBytes = await readFile(join(resolve(labDirectory, "revisions", String(revision).padStart(6, "0")), "REVISION.json")).catch(() => void 0);
	if (metadataBytes === void 0) throw new ArtifactError(`Revision ${revision} does not exist`, "REVISION_MISSING");
	let metadata;
	try {
		metadata = JSON.parse(decodeText(metadataBytes, "REVISION.json"));
	} catch {
		throw new ArtifactError("REVISION.json is malformed", "INVALID_CURRENT");
	}
	if (!isRevisionMetadata(metadata) || metadata.revision !== revision) throw new ArtifactError("REVISION.json does not match the requested revision", "INVALID_CURRENT");
	return await readFrozenRevision(labDirectory, {
		version: 2,
		revision,
		revisionPath: join("revisions", String(revision).padStart(6, "0")),
		specHash: metadata.specHash,
		configHash: metadata.configHash,
		manifestHash: metadata.manifestHash,
		dialogueHeadHash: metadata.dialogueHeadHash
	});
}
async function readFrozenRevision(labDirectory, pointer) {
	const expectedPath = join("revisions", String(pointer.revision).padStart(6, "0"));
	if (pointer.revisionPath !== expectedPath) throw new ArtifactError("CURRENT revision path does not match its revision", "INVALID_CURRENT");
	const revisionDirectory = resolve(labDirectory, pointer.revisionPath);
	if (!isInside$2(resolve(labDirectory, "revisions"), revisionDirectory)) throw new ArtifactError("CURRENT points outside its revisions directory", "INVALID_CURRENT");
	const [specBytes, configBytes, manifestBytes, validationBytes, metadataBytes] = await Promise.all([
		readFile(join(revisionDirectory, "LAB_SPEC.md")).catch(() => void 0),
		readFile(join(revisionDirectory, "lab.yaml")).catch(() => void 0),
		readFile(join(revisionDirectory, "RESOLVED_MANIFEST.json")).catch(() => void 0),
		readFile(join(revisionDirectory, "VALIDATION.json")).catch(() => void 0),
		readFile(join(revisionDirectory, "REVISION.json")).catch(() => void 0)
	]);
	if (specBytes === void 0 || configBytes === void 0 || manifestBytes === void 0 || validationBytes === void 0 || metadataBytes === void 0) throw new ArtifactError("CURRENT revision is not completely committed", "REVISION_MISSING");
	let metadata;
	let manifestValue;
	let validationValue;
	try {
		metadata = JSON.parse(decodeText(metadataBytes, "REVISION.json"));
		manifestValue = JSON.parse(decodeText(manifestBytes, "RESOLVED_MANIFEST.json"));
		validationValue = JSON.parse(decodeText(validationBytes, "VALIDATION.json"));
	} catch {
		throw new ArtifactError("REVISION.json is malformed", "INVALID_CURRENT");
	}
	if (!isRevisionMetadata(metadata) || metadata.revision !== pointer.revision) throw new ArtifactError("REVISION.json does not match CURRENT revision", "INVALID_CURRENT");
	if (metadata.specHash !== pointer.specHash || metadata.configHash !== pointer.configHash || metadata.manifestHash !== pointer.manifestHash || metadata.dialogueHeadHash !== pointer.dialogueHeadHash) throw new ArtifactError("CURRENT hashes do not match REVISION.json", "HASH_MISMATCH");
	const specHash = sha256(specBytes);
	const configHash = sha256(configBytes);
	let manifest;
	try {
		manifest = parseResolvedManifest(manifestValue);
	} catch (error) {
		throw new ArtifactError(`RESOLVED_MANIFEST.json is invalid: ${error instanceof Error ? error.message : String(error)}`, "INVALID_CURRENT");
	}
	const manifestJson = canonicalJson$1(manifest);
	if (decodeText(manifestBytes, "RESOLVED_MANIFEST.json") !== manifestJson) throw new ArtifactError("RESOLVED_MANIFEST.json is not the committed canonical bytes", "HASH_MISMATCH");
	const manifestHash = sha256(manifestJson);
	if (specHash !== metadata.specHash || configHash !== metadata.configHash || manifestHash !== metadata.manifestHash) throw new ArtifactError("CURRENT revision hash does not match stored bytes", "HASH_MISMATCH");
	const validation = parseRevisionValidation(validationValue);
	if (validation.specHash !== specHash || validation.configHash !== configHash || validation.manifestHash !== manifestHash || validation.dialogueHeadHash !== pointer.dialogueHeadHash) throw new ArtifactError("VALIDATION.json does not match CURRENT", "HASH_MISMATCH");
	validateRevisionManifest({
		manifest,
		labId: basename(labDirectory),
		labDirectory,
		revision: pointer.revision,
		specHash,
		configHash,
		dialogueHeadHash: pointer.dialogueHeadHash
	});
	return {
		ref: {
			revision: pointer.revision,
			revisionPath: pointer.revisionPath,
			specHash,
			configHash,
			manifestHash,
			dialogueHeadHash: pointer.dialogueHeadHash
		},
		spec: decodeText(specBytes, "LAB_SPEC.md"),
		config: decodeText(configBytes, "lab.yaml"),
		manifest,
		validation
	};
}
async function readCurrentPointer(path) {
	let value;
	try {
		value = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		throw new ArtifactError(`cannot read CURRENT: ${error instanceof Error ? error.message : String(error)}`, "INVALID_CURRENT");
	}
	if (!isCurrentPointer(value)) throw new ArtifactError("CURRENT is malformed", "INVALID_CURRENT");
	return value;
}
function isCurrentPointer(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record$1 = value;
	return Object.keys(record$1).length === 7 && record$1.version === 2 && Number.isSafeInteger(record$1.revision) && record$1.revision > 0 && typeof record$1.revisionPath === "string" && record$1.revisionPath.length > 0 && typeof record$1.specHash === "string" && /^[0-9a-f]{64}$/.test(record$1.specHash) && typeof record$1.configHash === "string" && /^[0-9a-f]{64}$/.test(record$1.configHash) && typeof record$1.manifestHash === "string" && /^[0-9a-f]{64}$/.test(record$1.manifestHash) && typeof record$1.dialogueHeadHash === "string" && /^[0-9a-f]{64}$/.test(record$1.dialogueHeadHash);
}
function isRevisionMetadata(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record$1 = value;
	return Object.keys(record$1).length === 6 && record$1.version === 2 && Number.isSafeInteger(record$1.revision) && record$1.revision > 0 && typeof record$1.specHash === "string" && /^[0-9a-f]{64}$/.test(record$1.specHash) && typeof record$1.configHash === "string" && /^[0-9a-f]{64}$/.test(record$1.configHash) && typeof record$1.manifestHash === "string" && /^[0-9a-f]{64}$/.test(record$1.manifestHash) && typeof record$1.dialogueHeadHash === "string" && /^[0-9a-f]{64}$/.test(record$1.dialogueHeadHash);
}
function decodeText(value, name) {
	try {
		return UTF8$8.decode(value);
	} catch {
		throw new ArtifactError(`${name} is not valid UTF-8`, "INVALID_SOURCE");
	}
}
async function readSourceDocuments(sourceDirectory) {
	const source = resolve(sourceDirectory);
	if ((await stat(source).catch(() => void 0))?.isDirectory() !== true) throw new ArtifactError("config-path must be a directory", "INVALID_SOURCE");
	const specBytes = await readFile(join(source, "LAB_SPEC.md")).catch(() => void 0);
	const configBytes = await readFile(join(source, "lab.yaml")).catch(() => void 0);
	if (specBytes === void 0 || configBytes === void 0) throw new ArtifactError("config directory must contain LAB_SPEC.md and lab.yaml", "INVALID_SOURCE");
	const spec = decodeText(specBytes, "LAB_SPEC.md");
	const config = decodeText(configBytes, "lab.yaml");
	if (spec.trim().length === 0 || config.trim().length === 0) throw new ArtifactError("LAB_SPEC.md and lab.yaml must not be empty", "INVALID_SOURCE");
	return {
		specBytes,
		configBytes,
		spec,
		config
	};
}
function draftSnapshot(input) {
	return {
		spec: input.spec,
		config: input.config,
		specHash: sha256(input.specBytes),
		configHash: sha256(input.configBytes)
	};
}
function validateRevisionManifest(input) {
	const manifest = parseResolvedManifest(input.manifest);
	const revisionDirectory = join(resolve(input.labDirectory), "revisions", String(input.revision).padStart(6, "0"));
	if (manifest.lab_id !== input.labId || manifest.source_revision !== input.revision || manifest.anchors.dialogue_head_sha256 !== input.dialogueHeadHash || manifest.anchors.lab_spec_sha256 !== input.specHash || manifest.anchors.lab_yaml_sha256 !== input.configHash || resolve(manifest.authority_paths.lab_dir) !== resolve(input.labDirectory) || resolve(manifest.authority_paths.lab_spec) !== join(revisionDirectory, "LAB_SPEC.md") || resolve(manifest.authority_paths.lab_yaml) !== join(revisionDirectory, "lab.yaml") || resolve(manifest.authority_paths.resolved_manifest) !== join(revisionDirectory, "RESOLVED_MANIFEST.json")) throw new ArtifactError("ResolvedManifest anchors or authority paths do not match this revision", "INVALID_SOURCE");
	return manifest;
}
function parseRevisionValidation(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ArtifactError("VALIDATION.json must be an object", "INVALID_CURRENT");
	const record$1 = value;
	if (Object.keys(record$1).length !== 7 || record$1.version !== 1 || record$1.hashAlgorithm !== "sha256" || record$1.manifestCanonicalization !== "autolab-canonical-json-v1" || typeof record$1.dialogueHeadHash !== "string" || !/^[0-9a-f]{64}$/u.test(record$1.dialogueHeadHash) || typeof record$1.specHash !== "string" || !/^[0-9a-f]{64}$/u.test(record$1.specHash) || typeof record$1.configHash !== "string" || !/^[0-9a-f]{64}$/u.test(record$1.configHash) || typeof record$1.manifestHash !== "string" || !/^[0-9a-f]{64}$/u.test(record$1.manifestHash)) throw new ArtifactError("VALIDATION.json schema is invalid", "INVALID_CURRENT");
	return value;
}
async function syncDirectory$1(path) {
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}
function isInside$2(parent, child) {
	const path = relative(resolve(parent), resolve(child));
	return path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}
function two(value) {
	return String(value).padStart(2, "0");
}
function isNodeError$17(value) {
	return value instanceof Error && "code" in value;
}

//#endregion
//#region src/runner.ts
const execFileAsync$3 = promisify(execFile);
const SHA_PATTERN$2 = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const HASH_PATTERN$1 = /^[0-9a-f]{64}$/u;
const UUID_PATTERN$1 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ATTEMPT_PATTERN$1 = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const TMUX_PANE_PATTERN = /^%[0-9]+$/u;
const PROCESS_START_PATTERN = /^(?:linux:[1-9][0-9]*|darwin:[1-9][0-9]*:[0-9]{1,6})$/u;
const RUNNER = Object.freeze({
	id: "local-tmux",
	version: 1
});
const TMUX_LAUNCH_NONCE_ENV = "AUTOLAB_TMUX_LAUNCH_NONCE";
const TMUX_LAUNCH_IDENTITY_ENV = "AUTOLAB_TMUX_LAUNCH_IDENTITY_HASH";
const TMUX_CLIENT_OUTPUT_BYTES = 1024 * 1024;
const TMUX_CLIENT_TERMINATION_GRACE_MS = 1e3;
const TMUX_INSPECTION_FORMAT = [
	"#{session_name}",
	"#{pane_id}",
	"#{pane_pid}",
	`#{E:${TMUX_LAUNCH_NONCE_ENV}}`,
	`#{E:${TMUX_LAUNCH_IDENTITY_ENV}}`
].join("	");
const pathsSchema = z.object({
	launch: z.string().min(1),
	started: z.string().min(1),
	exit: z.string().min(1),
	log: z.string().min(1)
}).strict();
const runnerSchema = z.object({
	id: z.literal("local-tmux"),
	version: z.literal(1)
}).strict();
const darwinProcessSnapshotSchema = z.object({
	pid: z.number().int().positive(),
	pgid: z.number().int().positive(),
	startSec: z.number().int().positive(),
	startUsec: z.number().int().min(0).max(999999),
	bootSec: z.number().int().positive(),
	bootUsec: z.number().int().min(0).max(999999),
	executablePath: z.string().min(1),
	argv: z.array(z.string()).min(1)
}).strict();
const launchSpecSchema = z.object({
	version: z.literal(1),
	kind: z.literal("AUTOLAB_LOCAL_TMUX_LAUNCH"),
	runner: runnerSchema,
	attemptId: z.string().regex(ATTEMPT_PATTERN$1),
	tmuxSession: z.string().regex(/^autolab-[0-9a-f]{32}$/u),
	launchNonce: z.string().regex(UUID_PATTERN$1),
	candidateSha: z.string().regex(SHA_PATTERN$2),
	command: z.array(z.string()).min(1),
	commandHash: z.string().regex(HASH_PATTERN$1),
	cwd: z.string().min(1),
	cwdHash: z.string().regex(HASH_PATTERN$1),
	env: z.record(z.string(), z.string()),
	envHash: z.string().regex(HASH_PATTERN$1),
	attemptDirectory: z.string().min(1),
	runtimePokeFile: z.string().refine(isExactAbsolutePath).optional(),
	paths: pathsSchema,
	issuedAt: z.number().int().nonnegative(),
	launchIdentityHash: z.string().regex(HASH_PATTERN$1),
	receiptHash: z.string().regex(HASH_PATTERN$1)
}).strict();
const startedReceiptSchema = z.object({
	version: z.literal(1),
	kind: z.literal("AUTOLAB_ATTEMPT_STARTED"),
	runner: runnerSchema,
	attemptId: z.string().regex(ATTEMPT_PATTERN$1),
	tmuxSession: z.string().regex(/^autolab-[0-9a-f]{32}$/u),
	launchNonce: z.string().regex(UUID_PATTERN$1),
	candidateSha: z.string().regex(SHA_PATTERN$2),
	commandHash: z.string().regex(HASH_PATTERN$1),
	cwd: z.string().min(1),
	cwdHash: z.string().regex(HASH_PATTERN$1),
	envHash: z.string().regex(HASH_PATTERN$1),
	launchIdentityHash: z.string().regex(HASH_PATTERN$1),
	launchSpecReceiptHash: z.string().regex(HASH_PATTERN$1),
	logPath: z.string().min(1),
	tmuxPaneId: z.string().regex(TMUX_PANE_PATTERN),
	pid: z.number().int().positive(),
	pgid: z.number().int().positive(),
	processStartId: z.string().regex(PROCESS_START_PATTERN),
	processCommandHash: z.string().regex(HASH_PATTERN$1),
	hostname: z.string().min(1),
	bootId: z.string().min(1),
	startedAt: z.number().int().nonnegative(),
	receiptHash: z.string().regex(HASH_PATTERN$1)
}).strict();
const exitReceiptSchema = z.object({
	version: z.literal(1),
	kind: z.literal("AUTOLAB_ATTEMPT_EXIT"),
	runner: runnerSchema,
	attemptId: z.string().regex(ATTEMPT_PATTERN$1),
	tmuxSession: z.string().regex(/^autolab-[0-9a-f]{32}$/u),
	launchNonce: z.string().regex(UUID_PATTERN$1),
	candidateSha: z.string().regex(SHA_PATTERN$2),
	commandHash: z.string().regex(HASH_PATTERN$1),
	cwdHash: z.string().regex(HASH_PATTERN$1),
	envHash: z.string().regex(HASH_PATTERN$1),
	launchIdentityHash: z.string().regex(HASH_PATTERN$1),
	startedReceiptHash: z.string().regex(HASH_PATTERN$1),
	tmuxPaneId: z.string().regex(TMUX_PANE_PATTERN),
	pid: z.number().int().positive(),
	pgid: z.number().int().positive(),
	processStartId: z.string().regex(PROCESS_START_PATTERN),
	processCommandHash: z.string().regex(HASH_PATTERN$1),
	hostname: z.string().min(1),
	bootId: z.string().min(1),
	outcome: z.enum([
		"exited",
		"signaled",
		"spawn_failed"
	]),
	exitCode: z.number().int().nullable().optional(),
	signal: z.string().min(1).nullable().optional(),
	spawnError: z.string().min(1).optional(),
	logPath: z.string().min(1),
	finishedAt: z.number().int().nonnegative(),
	receiptHash: z.string().regex(HASH_PATTERN$1)
}).strict().superRefine((receipt, context) => {
	if (receipt.outcome === "exited" && (receipt.exitCode === void 0 || receipt.exitCode === null || receipt.signal != null || receipt.spawnError !== void 0)) context.addIssue({
		code: "custom",
		message: "exited requires only a numeric exitCode"
	});
	if (receipt.outcome === "signaled" && (receipt.signal === void 0 || receipt.signal === null || receipt.exitCode != null || receipt.spawnError !== void 0)) context.addIssue({
		code: "custom",
		message: "signaled requires only a signal"
	});
	if (receipt.outcome === "spawn_failed" && (receipt.spawnError === void 0 || receipt.exitCode != null || receipt.signal != null)) context.addIssue({
		code: "custom",
		message: "spawn_failed requires only spawnError"
	});
});
/** Resolve the one packaged wrapper beside lib/ (or src/ during tests). */
async function resolveLocalAttemptWrapperPath() {
	const expected = fileURLToPath(new URL("../scripts/attempt-wrapper.mjs", import.meta.url));
	await assertCanonicalRegularFile(expected, "packaged AutoLab attempt wrapper");
	return expected;
}
/** Compile only immutable launch identity. PID/PGID/boot fields appear only after real start. */
function compileLocalTmuxLaunch(input) {
	validateCompileInput(input);
	const command = [...input.command];
	const env = Object.fromEntries(Object.entries(input.env).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
	const tmuxSession = `autolab-${sha256(`autolab-tmux-name-v1\0${input.attemptId}`).slice(0, 32)}`;
	const commandHash = sha256(`autolab-command-v1\0${canonicalJson$1(command)}`);
	const cwdHash = sha256(`autolab-cwd-v1\0${canonicalJson$1(input.cwd)}`);
	const envHash = sha256(`autolab-env-v1\0${canonicalJson$1(env)}`);
	const paths = {
		launch: join(input.attemptDirectory, "launch.json"),
		started: join(input.attemptDirectory, "started.json"),
		exit: join(input.attemptDirectory, "exit.json"),
		log: join(input.attemptDirectory, "attempt.log")
	};
	const launchIdentityHash = sha256(`autolab-local-tmux-identity-v1\0${canonicalJson$1({
		version: 1,
		runner: RUNNER,
		attemptId: input.attemptId,
		tmuxSession,
		launchNonce: input.launchNonce,
		candidateSha: input.candidateSha,
		commandHash,
		cwd: input.cwd,
		cwdHash,
		envHash
	})}`);
	const withoutReceiptHash$1 = {
		version: 1,
		kind: "AUTOLAB_LOCAL_TMUX_LAUNCH",
		runner: RUNNER,
		attemptId: input.attemptId,
		tmuxSession,
		launchNonce: input.launchNonce,
		candidateSha: input.candidateSha,
		command,
		commandHash,
		cwd: input.cwd,
		cwdHash,
		env,
		envHash,
		attemptDirectory: input.attemptDirectory,
		...input.runtimePokeFile === void 0 ? {} : { runtimePokeFile: input.runtimePokeFile },
		paths,
		issuedAt: input.issuedAt,
		launchIdentityHash
	};
	const launchSpec = launchSpecSchema.parse({
		...withoutReceiptHash$1,
		receiptHash: hashReceipt$2("launch-spec", withoutReceiptHash$1)
	});
	Object.freeze(launchSpec.runner);
	Object.freeze(launchSpec.command);
	Object.freeze(launchSpec.env);
	Object.freeze(launchSpec.paths);
	Object.freeze(launchSpec);
	return Object.freeze({
		attemptId: input.attemptId,
		launchNonce: input.launchNonce,
		candidateSha: input.candidateSha,
		cwd: input.cwd,
		attemptDirectory: input.attemptDirectory,
		command: Object.freeze(command),
		env: Object.freeze(env),
		...input.runtimePokeFile === void 0 ? {} : { runtimePokeFile: input.runtimePokeFile },
		issuedAt: input.issuedAt,
		tmuxSession,
		commandHash,
		cwdHash,
		envHash,
		launchIdentityHash,
		paths: Object.freeze({ ...paths }),
		launchSpec: Object.freeze(launchSpec)
	});
}
/** Read receipts and live identities exactly once. It never launches, kills, or polls. */
async function inspectLocalTmuxAttempt(plan, options = {}) {
	const platform = options.platform ?? nodeLocalTmuxPlatform;
	const [launch, exitRead] = await Promise.all([readLaunchSpec(plan.paths.launch), readExitReceipt(plan.paths.exit)]);
	if (launch.status === "corrupt") return blocked("RECEIPT_CORRUPT", launch.message);
	if (launch.value !== void 0 && !sameJson(launch.value, plan.launchSpec)) return blocked("IDENTITY_MISMATCH", "launch.json belongs to another immutable launch identity");
	const launchPrepared = launch.value !== void 0;
	const startedRead = await readStartedReceipt(plan.paths.started);
	if (startedRead.status === "corrupt") return blocked("RECEIPT_CORRUPT", startedRead.message);
	if (exitRead.status === "corrupt") return blocked("RECEIPT_CORRUPT", exitRead.message);
	const started = startedRead.value;
	const exit = exitRead.value;
	if (started === void 0) {
		if (exit !== void 0) return blocked("RECEIPT_CORRUPT", "exit.json exists without started.json");
		const log$1 = await inspectRegularFile(plan.paths.log, "attempt log");
		if (log$1.status === "corrupt") return blocked("RECEIPT_CORRUPT", log$1.message);
		const tmux$1 = await platform.inspectTmux(plan.tmuxSession);
		if (!tmux$1.available) return pending("SYSTEM_UNAVAILABLE", "tmux cannot be inspected on this host");
		if (!tmux$1.present) {
			if (log$1.exists) return {
				status: "outcome_unknown",
				reason: "attempt log exists but started.json and the tmux handle are absent"
			};
			return {
				status: "absent",
				launchPrepared
			};
		}
		const tmuxMismatch = tmuxLaunchIdentityMismatch(plan, tmux$1);
		if (tmuxMismatch !== void 0) return blocked("TMUX_IDENTITY_MISMATCH", tmuxMismatch);
		if (tmux$1.paneId === void 0 || tmux$1.panePid === void 0) return pending("PROCESS_IDENTITY_UNKNOWN", "tmux pane identity cannot be read");
		return launchPrepared ? {
			status: "launching",
			launchPrepared,
			tmuxPresent: true
		} : blocked("TMUX_IDENTITY_MISMATCH", "stable tmux name exists without this attempt launch identity");
	}
	const startedMismatch = startedIdentityMismatch(plan, started);
	if (startedMismatch !== void 0) return blocked("IDENTITY_MISMATCH", startedMismatch);
	if (exit !== void 0) return await completedInspection(plan, started, exit);
	const log = await inspectRegularFile(plan.paths.log, "attempt log");
	if (log.status === "corrupt") return blocked("RECEIPT_CORRUPT", log.message);
	if (!log.exists) return blocked("RECEIPT_CORRUPT", "started.json exists without attempt.log");
	const [tmux, process$1] = await Promise.all([platform.inspectTmux(plan.tmuxSession), platform.inspectProcess(started.pid)]);
	if (tmux.available && tmux.present) {
		const tmuxMismatch = tmuxLaunchIdentityMismatch(plan, tmux, started);
		if (tmuxMismatch !== void 0) return blocked("TMUX_IDENTITY_MISMATCH", tmuxMismatch);
		if (tmux.paneId === void 0 || tmux.panePid === void 0) return pending("PROCESS_IDENTITY_UNKNOWN", "tmux pane identity cannot be read");
		if (tmux.panePid !== started.pid) return blocked("PROCESS_IDENTITY_MISMATCH", `tmux pane PID ${tmux.panePid} does not match started PID ${started.pid}`);
	}
	if (process$1.status === "unknown") return pending("PROCESS_IDENTITY_UNKNOWN", `process ${started.pid} identity is unavailable`);
	if (process$1.status === "dead") {
		const settledExit = await readExitReceipt(plan.paths.exit);
		if (settledExit.status === "corrupt") return blocked("RECEIPT_CORRUPT", settledExit.message);
		if (settledExit.value !== void 0) return await completedInspection(plan, started, settledExit.value);
		return {
			status: "outcome_unknown",
			started,
			reason: "started process is no longer present and no exit receipt exists"
		};
	}
	if (!sameProcessIdentity(started, process$1)) return blocked("PROCESS_IDENTITY_MISMATCH", `process ${started.pid} no longer matches its start, PGID, host, or boot identity`);
	return {
		status: "running",
		tmuxPresent: tmux.present,
		tmuxInspectable: tmux.available,
		started
	};
}
/** Adopt is inspect-only. Absence stays pending; this function never creates a replacement. */
async function adoptLocalTmuxAttempt(plan, options = {}) {
	const inspected = await inspectLocalTmuxAttempt(plan, options);
	return inspected.status === "absent" ? pending("ATTEMPT_NOT_FOUND", "no matching tmux process or durable receipt exists") : inspected;
}
/** Launch once from mechanically proven absence; exact replays inspect/adopt instead of spawning. */
async function launchLocalTmuxAttempt(plan, options) {
	const platform = options.platform ?? nodeLocalTmuxPlatform;
	if (!isExactAbsolutePath(options.wrapperPath)) return pending("SYSTEM_UNAVAILABLE", "attempt wrapper path must be exact and absolute");
	const before = await inspectLocalTmuxAttempt(plan, { platform });
	if (before.status !== "absent") return before;
	try {
		await platform.verifyDetachedCheckout(plan.cwd, plan.candidateSha);
	} catch (error) {
		return blocked("CHECKOUT_MISMATCH", renderError$2(error));
	}
	try {
		await assertCanonicalRegularFile(options.wrapperPath, "attempt wrapper");
	} catch (error) {
		return pending("SYSTEM_UNAVAILABLE", renderError$2(error));
	}
	let prepared;
	try {
		prepared = await prepareLaunchSpec(plan);
	} catch (error) {
		return pending("SYSTEM_UNAVAILABLE", `cannot prepare launch.json: ${renderError$2(error)}`);
	}
	if (prepared !== void 0) return prepared;
	try {
		await platform.launchTmux({
			plan,
			wrapperPath: options.wrapperPath
		});
	} catch (error) {
		return pending("TMUX_LAUNCH_FAILED", renderError$2(error));
	}
	const after = await inspectLocalTmuxAttempt(plan, { platform });
	if (after.status === "absent") return pending("TMUX_LAUNCH_FAILED", "tmux launch returned without a live handle or receipt");
	return after;
}
function tmuxCommandOperations(commandRunner) {
	const inspectTmux = async (tmuxSession) => {
		try {
			await commandRunner.run("tmux", [
				"has-session",
				"-t",
				`=${tmuxSession}`
			]);
		} catch (error) {
			if (commandRunner.isUnavailable(error)) return {
				available: false,
				present: false
			};
			if (exitStatus(error) === 1) return {
				available: true,
				present: false
			};
			return {
				available: false,
				present: false
			};
		}
		let pane;
		try {
			pane = await commandRunner.run("tmux", [
				"display-message",
				"-p",
				"-t",
				`=${tmuxSession}:`,
				TMUX_INSPECTION_FORMAT
			]);
		} catch (error) {
			commandRunner.isUnavailable(error);
			return {
				available: false,
				present: true
			};
		}
		const [sessionName, paneId, panePidText, launchNonce, launchIdentityHash] = pane.split("	");
		const panePid = Number.parseInt(panePidText ?? "", 10);
		return {
			available: true,
			present: true,
			...sessionName === tmuxSession && TMUX_PANE_PATTERN.test(paneId ?? "") ? { paneId } : {},
			...Number.isSafeInteger(panePid) && panePid > 0 ? { panePid } : {},
			...UUID_PATTERN$1.test(launchNonce ?? "") ? { launchNonce } : {},
			...HASH_PATTERN$1.test(launchIdentityHash ?? "") ? { launchIdentityHash } : {}
		};
	};
	const launchTmux = async ({ plan, wrapperPath }) => {
		const shellCommand = `exec ${shellQuote(process.execPath)} ${shellQuote(wrapperPath)} ${shellQuote(plan.paths.launch)}`;
		try {
			await commandRunner.run("tmux", [
				"new-session",
				"-d",
				"-s",
				plan.tmuxSession,
				"-c",
				plan.cwd,
				"-e",
				`${TMUX_LAUNCH_NONCE_ENV}=${plan.launchNonce}`,
				"-e",
				`${TMUX_LAUNCH_IDENTITY_ENV}=${plan.launchIdentityHash}`,
				shellCommand
			]);
			return "created";
		} catch (error) {
			if (commandRunner.isUnavailable(error)) throw new Error("tmux is not installed or executable");
			const observed = await inspectTmux(plan.tmuxSession);
			if (observed.available && observed.present) return "exists";
			throw error;
		}
	};
	return {
		inspectTmux,
		launchTmux
	};
}
const nodeTmuxCommandOperations = tmuxCommandOperations({
	run,
	isUnavailable: isMissingExecutable
});
const nodeLocalTmuxPlatform = {
	...nodeTmuxCommandOperations,
	async inspectProcess(pid) {
		try {
			return await inspectProcessSnapshot(pid);
		} catch (error) {
			return isProcessMissing(error) ? { status: "dead" } : { status: "unknown" };
		}
	},
	async verifyDetachedCheckout(cwd, candidateSha) {
		if (await realpath(cwd) !== cwd || !(await stat(cwd)).isDirectory()) throw new Error("run checkout cwd is not its exact canonical directory");
		const [head, symbolic, dirty] = await Promise.all([
			run("git", [
				"-C",
				cwd,
				"rev-parse",
				"HEAD"
			]),
			run("git", [
				"-C",
				cwd,
				"rev-parse",
				"--abbrev-ref",
				"HEAD"
			]),
			run("git", [
				"-C",
				cwd,
				"status",
				"--porcelain=v1",
				"--untracked-files=normal"
			])
		]);
		if (head.trim() !== candidateSha) throw new Error("run checkout HEAD does not match candidate SHA");
		if (symbolic.trim() !== "HEAD") throw new Error("run checkout is not detached");
		if (dirty.length > 0) throw new Error("run checkout contains uncommitted or untracked changes");
	}
};
/**
* DSH-runtime composition for Controller-owned tmux client calls. Process-table
* and Git checkout verification remain the existing local mechanical probes;
* only executable launch/inspection crosses the mounted subprocess seam.
*/
function createSubprocessLocalTmuxPlatform(subprocess, signal) {
	return {
		...tmuxCommandOperations({
			run: async (executable, args) => await runWithSubprocess(subprocess, executable, args, signal),
			isUnavailable: (error) => {
				signal?.throwIfAborted();
				return error instanceof SubprocessExecutableUnavailableError || isMissingExecutable(error);
			}
		}),
		inspectProcess: nodeLocalTmuxPlatform.inspectProcess,
		verifyDetachedCheckout: nodeLocalTmuxPlatform.verifyDetachedCheckout
	};
}
async function prepareLaunchSpec(plan) {
	await mkdir(plan.attemptDirectory, {
		recursive: true,
		mode: 448
	});
	await assertCanonicalDirectory(plan.attemptDirectory, "attempt directory");
	try {
		await durableWriteFile(plan.paths.launch, `${JSON.stringify(plan.launchSpec)}\n`, false);
		return;
	} catch (error) {
		if (!isNodeError$16(error) || error.code !== "EEXIST") throw error;
	}
	const existing = await readLaunchSpec(plan.paths.launch);
	if (existing.status === "corrupt") return blocked("RECEIPT_CORRUPT", existing.message);
	if (existing.value === void 0 || !sameJson(existing.value, plan.launchSpec)) return blocked("IDENTITY_MISMATCH", "launch.json already contains another launch identity");
}
function validateCompileInput(input) {
	if (!ATTEMPT_PATTERN$1.test(input.attemptId)) throw new TypeError("invalid attemptId");
	if (!UUID_PATTERN$1.test(input.launchNonce)) throw new TypeError("invalid launchNonce");
	if (!SHA_PATTERN$2.test(input.candidateSha)) throw new TypeError("invalid candidateSha");
	if (!isExactAbsolutePath(input.cwd)) throw new TypeError("cwd must be exact and absolute");
	if (!isExactAbsolutePath(input.attemptDirectory)) throw new TypeError("attemptDirectory must be exact and absolute");
	if (input.runtimePokeFile !== void 0 && !isExactAbsolutePath(input.runtimePokeFile)) throw new TypeError("runtimePokeFile must be exact and absolute");
	if (!Number.isSafeInteger(input.issuedAt) || input.issuedAt < 0) throw new TypeError("issuedAt must be a non-negative safe integer");
	if (!Array.isArray(input.command) || input.command.length === 0) throw new TypeError("command must contain an executable");
	for (const value of input.command) if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw new TypeError("command entries must be non-empty strings without NUL");
	if (Object.getPrototypeOf(input.env) !== Object.prototype && Object.getPrototypeOf(input.env) !== null) throw new TypeError("env must be a plain object");
	for (const [key, value] of Object.entries(input.env)) if (key.length === 0 || key.includes("=") || key.includes("\0") || value.includes("\0")) throw new TypeError("env entries must be valid exact process environment strings");
}
async function readLaunchSpec(path) {
	return await readReceipt$3(path, launchSpecSchema, "launch-spec");
}
async function readStartedReceipt(path) {
	return await readReceipt$3(path, startedReceiptSchema, "started");
}
async function readExitReceipt(path) {
	return await readReceipt$3(path, exitReceiptSchema, "exit");
}
async function readReceipt$3(path, schema, domain) {
	let text;
	const read = await readRegularFile(path, `${domain} receipt`);
	if (read.status === "corrupt") return read;
	if (read.bytes === void 0) return { status: "ok" };
	text = read.bytes.toString("utf8");
	let value;
	try {
		value = JSON.parse(text);
	} catch (error) {
		return {
			status: "corrupt",
			message: `${path} is not JSON: ${renderError$2(error)}`
		};
	}
	const parsed = schema.safeParse(value);
	if (!parsed.success) return {
		status: "corrupt",
		message: `${path} has an invalid schema`
	};
	const { receiptHash,...withoutReceiptHash$1 } = parsed.data;
	if (receiptHash !== hashReceipt$2(domain, withoutReceiptHash$1)) return {
		status: "corrupt",
		message: `${path} has an invalid receipt hash`
	};
	return {
		status: "ok",
		value: parsed.data
	};
}
async function completedInspection(plan, started, exit) {
	const mismatch$1 = exitIdentityMismatch(plan, started, exit);
	if (mismatch$1 !== void 0) return blocked("IDENTITY_MISMATCH", mismatch$1);
	if (exit.finishedAt < started.startedAt) return blocked("RECEIPT_CORRUPT", "exit.json finishedAt precedes started.json startedAt");
	const log = await inspectRegularFile(plan.paths.log, "attempt log");
	if (log.status === "corrupt") return blocked("RECEIPT_CORRUPT", log.message);
	if (!log.exists) return blocked("RECEIPT_CORRUPT", "exit.json exists without attempt.log");
	return {
		status: "completed",
		started,
		exit
	};
}
const READ_REGULAR_FLAGS$4 = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
async function readRegularFile(path, label) {
	let file;
	try {
		file = await open(path, READ_REGULAR_FLAGS$4);
		if (!(await file.stat()).isFile()) return {
			status: "corrupt",
			message: `${label} is not a regular file: ${path}`
		};
		return {
			status: "ok",
			bytes: await file.readFile()
		};
	} catch (error) {
		if (isNodeError$16(error) && error.code === "ENOENT") return { status: "ok" };
		return {
			status: "corrupt",
			message: `cannot read ${label} ${path}: ${renderError$2(error)}`
		};
	} finally {
		await file?.close().catch(() => void 0);
	}
}
async function inspectRegularFile(path, label) {
	let file;
	try {
		file = await open(path, READ_REGULAR_FLAGS$4);
		if (!(await file.stat()).isFile()) return {
			status: "corrupt",
			message: `${label} is not a regular file: ${path}`
		};
		return {
			status: "ok",
			exists: true
		};
	} catch (error) {
		if (isNodeError$16(error) && error.code === "ENOENT") return {
			status: "ok",
			exists: false
		};
		return {
			status: "corrupt",
			message: `cannot inspect ${label} ${path}: ${renderError$2(error)}`
		};
	} finally {
		await file?.close().catch(() => void 0);
	}
}
async function assertCanonicalRegularFile(path, label) {
	if (await realpath(path) !== path) throw new Error(`${label} is not canonical: ${path}`);
	const read = await inspectRegularFile(path, label);
	if (read.status === "corrupt") throw new Error(read.message);
	if (!read.exists) throw new Error(`${label} does not exist: ${path}`);
}
async function assertCanonicalDirectory(path, label) {
	if (await realpath(path) !== path) throw new Error(`${label} is not its exact canonical directory: ${path}`);
	let directory;
	try {
		directory = await open(path, READ_REGULAR_FLAGS$4);
		if (!(await directory.stat()).isDirectory()) throw new Error(`${label} is not its exact canonical directory: ${path}`);
	} finally {
		await directory?.close().catch(() => void 0);
	}
}
function startedIdentityMismatch(plan, started) {
	if (started.attemptId !== plan.attemptId || started.tmuxSession !== plan.tmuxSession || started.launchNonce !== plan.launchNonce || started.candidateSha !== plan.candidateSha || started.commandHash !== plan.commandHash || started.cwd !== plan.cwd || started.cwdHash !== plan.cwdHash || started.envHash !== plan.envHash || started.launchIdentityHash !== plan.launchIdentityHash || started.launchSpecReceiptHash !== plan.launchSpec.receiptHash || started.logPath !== plan.paths.log || started.processCommandHash !== expectedWrapperCommandHash(plan)) return "started.json does not match the immutable launch identity";
}
function exitIdentityMismatch(plan, started, exit) {
	if (exit.attemptId !== plan.attemptId || exit.tmuxSession !== plan.tmuxSession || exit.launchNonce !== plan.launchNonce || exit.candidateSha !== plan.candidateSha || exit.commandHash !== plan.commandHash || exit.cwdHash !== plan.cwdHash || exit.envHash !== plan.envHash || exit.launchIdentityHash !== plan.launchIdentityHash || exit.startedReceiptHash !== started.receiptHash || exit.tmuxPaneId !== started.tmuxPaneId || exit.pid !== started.pid || exit.pgid !== started.pgid || exit.processStartId !== started.processStartId || exit.processCommandHash !== started.processCommandHash || exit.hostname !== started.hostname || exit.bootId !== started.bootId || exit.logPath !== plan.paths.log) return "exit.json does not match launch.json and started.json";
}
function sameProcessIdentity(started, process$1) {
	return process$1.pid === started.pid && process$1.pgid === started.pgid && process$1.processStartId === started.processStartId && processCommandHash(process$1) === started.processCommandHash && process$1.hostname === started.hostname && process$1.bootId === started.bootId;
}
function tmuxLaunchIdentityMismatch(plan, tmux, started) {
	if (tmux.launchNonce !== plan.launchNonce || tmux.launchIdentityHash !== plan.launchIdentityHash) return `tmux session binding does not match launch ${plan.launchNonce}/${plan.launchIdentityHash}; observed ${tmux.launchNonce ?? "<missing>"}/${tmux.launchIdentityHash ?? "<missing>"}`;
	if (started !== void 0 && tmux.paneId !== void 0 && tmux.paneId !== started.tmuxPaneId) return `tmux pane ${tmux.paneId} does not match started pane ${started.tmuxPaneId}`;
}
function expectedWrapperCommandHash(plan) {
	const wrapperPath = fileURLToPath(new URL("../scripts/attempt-wrapper.mjs", import.meta.url));
	return processCommandHash({
		executablePath: process.execPath,
		argv: [
			process.execPath,
			wrapperPath,
			plan.paths.launch
		]
	});
}
function processCommandHash(processIdentity) {
	return sha256(`autolab-wrapper-process-command-v1\0${canonicalJson$1({
		executablePath: processIdentity.executablePath,
		argv: processIdentity.argv
	})}`);
}
function hashReceipt$2(domain, value) {
	return sha256(`autolab-local-tmux-${domain}-v1\0${canonicalJson$1(value)}`);
}
function sameJson(left, right) {
	return canonicalJson$1(left) === canonicalJson$1(right);
}
function blocked(code, message) {
	return {
		status: "blocked",
		code,
		message
	};
}
function pending(code, message) {
	return {
		status: "pending",
		code,
		message
	};
}
async function run(executable, args) {
	return (await execFileAsync$3(executable, [...args], {
		encoding: "utf8",
		maxBuffer: 1024 * 1024
	})).stdout.trimEnd();
}
var SubprocessExecutableUnavailableError = class extends Error {
	name = "SubprocessExecutableUnavailableError";
};
var SubprocessCommandExitError = class extends Error {
	name = "SubprocessCommandExitError";
	constructor(message, code, signal) {
		super(message);
		this.code = code;
		this.signal = signal;
	}
};
async function runWithSubprocess(subprocess, executable, args, signal) {
	let resolved;
	try {
		resolved = await subprocess.resolveExecutable(executable, void 0, signal);
	} catch (error) {
		signal?.throwIfAborted();
		throw new SubprocessExecutableUnavailableError(`${executable} is not installed or executable`, { cause: error });
	}
	const handle = subprocess.spawn({
		argv: [resolved, ...args],
		cwd: process.cwd(),
		stdio: {
			stdin: "ignore",
			stdout: { maxBytes: TMUX_CLIENT_OUTPUT_BYTES },
			stderr: { maxBytes: TMUX_CLIENT_OUTPUT_BYTES }
		},
		graceMs: TMUX_CLIENT_TERMINATION_GRACE_MS,
		...signal === void 0 ? {} : { signal }
	});
	const outcome = await handle.done;
	signal?.throwIfAborted();
	const stdout = handle.collected.stdout?.readFrom(0);
	const stderr = handle.collected.stderr?.readFrom(0);
	if (stdout === void 0 || stderr === void 0 || stdout.lossy || stderr.lossy) throw new Error("tmux client output exceeded its bounded DSH subprocess capture");
	if (outcome.exitCode !== 0) {
		const detail = stderr.text.trim();
		throw new SubprocessCommandExitError(`tmux client ${outcome.signal ?? `exit ${String(outcome.exitCode)}`}${detail === "" ? "" : `: ${detail}`}`, outcome.exitCode, outcome.signal);
	}
	return stdout.text.trimEnd();
}
var ProcessMissingError = class extends Error {};
async function inspectProcessSnapshot(pid) {
	if (process.platform === "linux") return await inspectLinuxProcessSnapshot(pid);
	if (process.platform === "darwin") return await inspectDarwinProcessSnapshot(pid);
	throw new Error(`local tmux runner does not support ${process.platform}`);
}
async function inspectLinuxProcessSnapshot(pid) {
	const before = await readLinuxProcStat(pid);
	let cmdline;
	let executablePath;
	let bootId;
	try {
		[cmdline, executablePath, bootId] = await Promise.all([
			readFile(`/proc/${pid}/cmdline`),
			realpath(`/proc/${pid}/exe`),
			readLinuxBootId()
		]);
	} catch (error) {
		if (isNodeError$16(error) && (error.code === "ENOENT" || error.code === "ESRCH")) throw new ProcessMissingError(`process ${pid} disappeared`);
		throw error;
	}
	const after = await readLinuxProcStat(pid);
	if (before.pid !== after.pid || before.pgid !== after.pgid || before.startTicks !== after.startTicks) throw new Error(`process ${pid} changed identity while it was inspected`);
	const argv = parseLinuxCmdline(cmdline);
	if (argv.length === 0) throw new Error(`process ${pid} command line is unavailable`);
	return {
		status: "alive",
		pid: before.pid,
		pgid: before.pgid,
		processStartId: `linux:${before.startTicks}`,
		executablePath,
		argv,
		hostname: hostname(),
		bootId
	};
}
async function readLinuxProcStat(pid) {
	let value;
	try {
		value = await readFile(`/proc/${pid}/stat`, "utf8");
	} catch (error) {
		if (isNodeError$16(error) && (error.code === "ENOENT" || error.code === "ESRCH")) throw new ProcessMissingError(`process ${pid} does not exist`);
		throw error;
	}
	const openParenthesis = value.indexOf("(");
	const closeParenthesis = value.lastIndexOf(")");
	if (openParenthesis <= 0 || closeParenthesis <= openParenthesis) throw new Error(`/proc/${pid}/stat has an invalid process record`);
	const parsedPid = Number.parseInt(value.slice(0, openParenthesis).trim(), 10);
	const fields = value.slice(closeParenthesis + 1).trim().split(/\s+/u);
	const pgid = Number.parseInt(fields[2] ?? "", 10);
	const startTicks = fields[19];
	if (parsedPid !== pid || !Number.isSafeInteger(pgid) || pgid <= 0 || startTicks === void 0 || !/^[1-9][0-9]*$/u.test(startTicks)) throw new Error(`/proc/${pid}/stat is missing PID, PGID, or start ticks`);
	return {
		pid: parsedPid,
		pgid,
		startTicks
	};
}
function parseLinuxCmdline(value) {
	const fields = value.toString("utf8").split("\0");
	if (fields.at(-1) === "") fields.pop();
	return fields;
}
async function readLinuxBootId() {
	const value = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
	if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value)) throw new Error("Linux boot ID is invalid");
	return `linux:${value}`;
}
const DARWIN_PROCESS_SNAPSHOT_SCRIPT = String.raw`
import ctypes
import json
import os
import struct
import sys

class ProcBsdInfo(ctypes.Structure):
    _fields_ = [
        ('flags', ctypes.c_uint32), ('status', ctypes.c_uint32),
        ('xstatus', ctypes.c_uint32), ('pid', ctypes.c_uint32),
        ('ppid', ctypes.c_uint32), ('uid', ctypes.c_uint32),
        ('gid', ctypes.c_uint32), ('ruid', ctypes.c_uint32),
        ('rgid', ctypes.c_uint32), ('svuid', ctypes.c_uint32),
        ('svgid', ctypes.c_uint32), ('rfu', ctypes.c_uint32),
        ('comm', ctypes.c_char * 16), ('name', ctypes.c_char * 32),
        ('nfiles', ctypes.c_uint32), ('pgid', ctypes.c_uint32),
        ('pjobc', ctypes.c_uint32), ('tdev', ctypes.c_uint32),
        ('tpgid', ctypes.c_uint32), ('nice', ctypes.c_int32),
        ('start_sec', ctypes.c_uint64), ('start_usec', ctypes.c_uint64),
    ]

class Timeval(ctypes.Structure):
    _fields_ = [('sec', ctypes.c_long), ('usec', ctypes.c_int)]

pid = int(sys.argv[1])
libproc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
libproc.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64,
                                 ctypes.c_void_p, ctypes.c_int]
libproc.proc_pidinfo.restype = ctypes.c_int

def bsd_info(missing_code):
    value = ProcBsdInfo()
    size = ctypes.sizeof(value)
    if libproc.proc_pidinfo(pid, 3, 0, ctypes.byref(value), size) != size:
        sys.exit(missing_code)
    return value

before = bsd_info(3)
libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
libc.sysctl.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.c_uint,
                        ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t),
                        ctypes.c_void_p, ctypes.c_size_t]
mib = (ctypes.c_int * 3)(1, 49, pid)
size = ctypes.c_size_t()
if libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0) != 0 or size.value < 5:
    sys.exit(5)
buffer = ctypes.create_string_buffer(size.value)
if libc.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0) != 0:
    sys.exit(5)
raw = buffer.raw[:size.value]
argc = struct.unpack_from('=i', raw, 0)[0]
cursor = 4
end = raw.find(b'\0', cursor)
if argc < 1 or end < 0:
    sys.exit(5)
executable = os.fsdecode(raw[cursor:end])
cursor = end + 1
while cursor < len(raw) and raw[cursor] == 0:
    cursor += 1
argv = []
for _ in range(argc):
    end = raw.find(b'\0', cursor)
    if end < 0:
        sys.exit(5)
    argv.append(os.fsdecode(raw[cursor:end]))
    cursor = end + 1

boot = Timeval()
boot_size = ctypes.c_size_t(ctypes.sizeof(boot))
libc.sysctlbyname.argtypes = [ctypes.c_char_p, ctypes.c_void_p,
                              ctypes.POINTER(ctypes.c_size_t),
                              ctypes.c_void_p, ctypes.c_size_t]
if libc.sysctlbyname(b'kern.boottime', ctypes.byref(boot),
                     ctypes.byref(boot_size), None, 0) != 0:
    sys.exit(5)
after = bsd_info(4)
identity_before = (before.pid, before.pgid, before.start_sec, before.start_usec)
identity_after = (after.pid, after.pgid, after.start_sec, after.start_usec)
if identity_before != identity_after or before.pid != pid:
    sys.exit(4)
print(json.dumps({
    'pid': before.pid,
    'pgid': before.pgid,
    'startSec': before.start_sec,
    'startUsec': before.start_usec,
    'bootSec': boot.sec,
    'bootUsec': boot.usec,
    'executablePath': executable,
    'argv': argv,
}, separators=(',', ':')))
`;
async function inspectDarwinProcessSnapshot(pid) {
	let stdout;
	try {
		stdout = (await execFileAsync$3("/usr/bin/python3", [
			"-I",
			"-S",
			"-c",
			DARWIN_PROCESS_SNAPSHOT_SCRIPT,
			String(pid)
		], {
			encoding: "utf8",
			maxBuffer: 1024 * 1024
		})).stdout;
	} catch (error) {
		if (exitStatus(error) === 3) throw new ProcessMissingError(`process ${pid} does not exist`);
		throw error;
	}
	const parsed = darwinProcessSnapshotSchema.parse(JSON.parse(stdout));
	if (parsed.pid !== pid) throw new Error(`macOS process snapshot returned PID ${parsed.pid}`);
	return {
		status: "alive",
		pid: parsed.pid,
		pgid: parsed.pgid,
		processStartId: `darwin:${parsed.startSec}:${parsed.startUsec}`,
		executablePath: parsed.executablePath,
		argv: parsed.argv,
		hostname: hostname(),
		bootId: `darwin:${parsed.bootSec}:${parsed.bootUsec}`
	};
}
function shellQuote(value) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}
function isExactAbsolutePath(value) {
	return isAbsolute(value) && resolve(value) === value && !value.includes("\0");
}
function isMissingExecutable(value) {
	return isNodeError$16(value) && value.code === "ENOENT";
}
function isProcessMissing(value) {
	return value instanceof ProcessMissingError;
}
function exitStatus(value) {
	if (!isNodeError$16(value)) return void 0;
	return typeof value.code === "number" ? value.code : void 0;
}
function isNodeError$16(value) {
	return value instanceof Error && "code" in value;
}
function renderError$2(value) {
	return value instanceof Error ? value.message : String(value);
}

//#endregion
//#region src/attempt-artifacts.ts
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const GIT_SHA_PATTERN$1 = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const READ_REGULAR_FLAGS$3 = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const id$1 = z.string().min(1);
const hash$2 = z.string().regex(HASH_PATTERN);
const absolutePath$3 = z.string().min(1).refine((value) => isAbsolute(value) && resolve(value) === value, "path must be normalized and absolute");
const component$1 = z.object({
	id: id$1,
	version: id$1,
	sha256: hash$2
}).strict();
const localAttemptRequestSchema = z.object({
	version: z.literal(1),
	kind: z.literal("AUTOLAB_LOCAL_TMUX_REQUEST"),
	lab_id: id$1,
	config_revision: z.number().int().positive(),
	trial_id: id$1,
	runslot_id: id$1,
	attempt_id: id$1,
	attempt_ordinal: z.number().int().positive(),
	launch_nonce: z.string().uuid(),
	candidate_sha: z.string().regex(GIT_SHA_PATTERN$1),
	runner: component$1,
	host_id: id$1,
	command: z.array(id$1).min(1),
	env: z.record(z.string(), z.string()),
	cwd: absolutePath$3,
	checkout_path: absolutePath$3,
	attempt_directory: absolutePath$3,
	runtime_poke_file: absolutePath$3.optional(),
	issued_at: z.number().int().nonnegative()
}).strict();
var AttemptArtifactError = class extends Error {
	name = "AttemptArtifactError";
	constructor(message, code) {
		super(message);
		this.code = code;
	}
};
/** Freeze the exact initial Attempt intent before its short Controller CAS. */
async function freezeInitialLocalAttempt(input) {
	const compiled = compileInitialLocalAttempt(input);
	await freezeCanonical$1(compiled.request.path, compiled.request.canonicalJson);
	await freezeCanonical$1(compiled.attempt.path, compiled.attempt.canonicalJson);
	return compiled;
}
/** Recompile and verify an initial intent without trusting mutable process state. */
async function verifyInitialLocalAttempt(input) {
	const expected = compileInitialLocalAttempt(input);
	const observed = await readLocalAttemptIntent({
		runRoot: input.frozen.manifest.execution.run_root,
		activeAttempt: {
			path: expected.attempt.path,
			hash: expected.attempt.sha256
		}
	});
	if (observed.request.canonicalJson !== expected.request.canonicalJson || observed.attempt.canonicalJson !== expected.attempt.canonicalJson) fail$1("Initial Attempt artifacts do not reproduce their frozen inputs", "ARTIFACT_CORRUPT");
	return expected;
}
/** Freeze one new technical retry while preserving the exact failed lineage. */
async function freezeRetryLocalAttempt(input) {
	const compiled = compileRetryLocalAttempt(input);
	await freezeCanonical$1(compiled.request.path, compiled.request.canonicalJson);
	await freezeCanonical$1(compiled.attempt.path, compiled.attempt.canonicalJson);
	return compiled;
}
/** Read the exact current Attempt plus its immutable local-runner request. */
async function readLocalAttemptIntent(input) {
	const attempt = await readAttemptArtifact(input.activeAttempt);
	const request = await readRequestArtifact(localAttemptRequestPath(input.runRoot, attempt.value.attempt_id));
	if (attempt.value.request.kind !== "runner_request" || attempt.value.request.sha256 !== request.sha256 || request.value.attempt_id !== attempt.value.attempt_id || request.value.attempt_ordinal !== attempt.value.attempt_ordinal || request.value.launch_nonce !== attempt.value.launch_nonce || request.value.candidate_sha !== attempt.value.candidate_sha || request.value.config_revision !== attempt.value.config_revision || request.value.trial_id !== attempt.value.trial_id || request.value.runslot_id !== attempt.value.runslot_id || request.value.runner.id !== attempt.value.runner.id || request.value.runner.version !== attempt.value.runner.version || request.value.runner.sha256 !== attempt.value.runner.sha256 || request.value.host_id !== attempt.value.host_id || request.value.cwd !== attempt.value.cwd) fail$1("Local runner request does not match its active Attempt", "IDENTITY_MISMATCH");
	const launchPlan = compileLaunchPlan(request.value);
	if (attempt.value.env_sha256 !== launchPlan.envHash) fail$1("Local runner request environment does not match its Attempt", "IDENTITY_MISMATCH");
	return Object.freeze({
		request,
		attempt,
		launchPlan
	});
}
/** Freeze a later running/unknown/terminal Attempt projection. */
async function freezeAttemptStateArtifact(runRoot, runSlotRevision, attemptInput) {
	const attempt = parseAttempt(attemptInput);
	const canonical = canonicalJson$1(attempt);
	const path = attemptStatePath(runRoot, attempt.attempt_id, runSlotRevision, attempt.phase);
	await freezeCanonical$1(path, canonical);
	return Object.freeze({
		value: attempt,
		canonicalJson: canonical,
		sha256: sha256(canonical),
		path
	});
}
async function freezeAttemptReceiptArtifact(runRoot, attemptId, kind, receipt) {
	const path = join(localAttemptDirectory(runRoot, attemptId), "receipts", `${kind}.json`);
	await freezeCanonical$1(path, receipt.canonicalJson);
	return Object.freeze({
		path,
		sha256: receipt.sha256
	});
}
/** Adopt the first durable unknown observation across the artifact-before-CAS crash window. */
async function readAttemptUncertainReceiptArtifactIfPresent(runRoot, attemptId) {
	const path = join(localAttemptDirectory(runRoot, attemptId), "receipts", "uncertain.json");
	const bytes = await readRegular$2(path, true, "Attempt uncertain receipt");
	if (bytes === void 0) return void 0;
	const text = decode(bytes, "Attempt uncertain receipt");
	let value;
	try {
		value = attemptUncertainReceiptSchema.parse(JSON.parse(text));
	} catch (error) {
		fail$1(`Attempt uncertain receipt is invalid: ${errorMessage$6(error)}`, "ARTIFACT_CORRUPT");
	}
	if (canonicalJson$1(value) !== text) fail$1("Attempt uncertain receipt is not canonical", "ARTIFACT_CORRUPT");
	return Object.freeze({
		value,
		canonicalJson: text,
		sha256: sha256(bytes),
		path
	});
}
function localAttemptDirectory(runRoot, attemptId) {
	assertRootAndId(runRoot, attemptId);
	return join(runRoot, "attempts", attemptId);
}
function localAttemptCheckoutPath(runRoot, attemptId) {
	assertRootAndId(runRoot, attemptId);
	return join(runRoot, "checkouts", attemptId);
}
function localAttemptRequestPath(runRoot, attemptId) {
	return join(localAttemptDirectory(runRoot, attemptId), "request.json");
}
function compileInitialLocalAttempt(input) {
	assertFrozenInputs(input);
	const state = parseRunSlotState(input.runSlotState);
	const attemptId = deriveAttemptId({
		labId: input.frozen.manifest.lab_id,
		configRevision: input.frozen.ref.revision,
		trialId: input.runSlot.value.trial_id,
		runSlotId: input.runSlot.value.runslot_id,
		runSlotContractSha256: input.runSlot.sha256,
		ordinal: 1
	});
	const launchNonce = uuidFromHash(sha256(`autolab-attempt-launch-nonce-v1\0${attemptId}`));
	const runRoot = input.frozen.manifest.execution.run_root;
	const attemptDirectory = localAttemptDirectory(runRoot, attemptId);
	const checkoutPath = localAttemptCheckoutPath(runRoot, attemptId);
	const requestValue = parseLocalAttemptRequest({
		version: 1,
		kind: "AUTOLAB_LOCAL_TMUX_REQUEST",
		lab_id: input.frozen.manifest.lab_id,
		config_revision: input.frozen.ref.revision,
		trial_id: input.trial.value.trial_id,
		runslot_id: input.runSlot.value.runslot_id,
		attempt_id: attemptId,
		attempt_ordinal: 1,
		launch_nonce: launchNonce,
		candidate_sha: input.runSlot.value.candidate_sha,
		runner: input.frozen.manifest.execution.runner_adapter,
		host_id: input.hostId,
		command: [...input.command],
		env: Object.fromEntries(Object.entries(input.env).sort(([left], [right]) => left.localeCompare(right))),
		cwd: checkoutPath,
		checkout_path: checkoutPath,
		attempt_directory: attemptDirectory,
		...input.runtimePokeFile === void 0 ? {} : { runtime_poke_file: input.runtimePokeFile },
		issued_at: input.issuedAt
	});
	const requestCanonical = canonicalJson$1(requestValue);
	const requestHash = sha256(requestCanonical);
	const request = Object.freeze({
		value: requestValue,
		canonicalJson: requestCanonical,
		sha256: requestHash,
		path: localAttemptRequestPath(runRoot, attemptId)
	});
	const launchPlan = compileLaunchPlan(requestValue);
	const transition = createInitialAttempt(input.runSlot, state, state.revision, {
		attempt_id: attemptId,
		request: {
			kind: "runner_request",
			sha256: requestHash
		},
		cwd: requestValue.cwd,
		env_sha256: launchPlan.envHash,
		runner: requestValue.runner,
		host_id: requestValue.host_id,
		launch_nonce: requestValue.launch_nonce,
		launched_at: requestValue.issued_at
	});
	const attemptCanonical = canonicalJson$1(transition.attempt);
	const attempt = Object.freeze({
		value: transition.attempt,
		canonicalJson: attemptCanonical,
		sha256: sha256(attemptCanonical),
		path: attemptStatePath(runRoot, attemptId, transition.state.revision, transition.attempt.phase)
	});
	return Object.freeze({
		request,
		attempt,
		transition,
		launchPlan,
		checkoutPath
	});
}
function compileRetryLocalAttempt(input) {
	const previous = assertRetryFrozenInputs(input);
	const state = parseRunSlotState(input.runSlotState);
	const attemptOrdinal = previous.attempt_ordinal + 1;
	const attemptId = deriveAttemptId({
		labId: input.frozen.manifest.lab_id,
		configRevision: input.frozen.ref.revision,
		trialId: previous.trial_id,
		runSlotId: previous.runslot_id,
		runSlotContractSha256: previous.runslot_contract_sha256,
		ordinal: attemptOrdinal
	});
	const launchNonce = uuidFromHash(sha256(`autolab-attempt-launch-nonce-v1\0${attemptId}`));
	const runRoot = input.frozen.manifest.execution.run_root;
	const attemptDirectory = localAttemptDirectory(runRoot, attemptId);
	const checkoutPath = localAttemptCheckoutPath(runRoot, attemptId);
	const requestValue = parseLocalAttemptRequest({
		version: 1,
		kind: "AUTOLAB_LOCAL_TMUX_REQUEST",
		lab_id: input.frozen.manifest.lab_id,
		config_revision: input.frozen.ref.revision,
		trial_id: previous.trial_id,
		runslot_id: previous.runslot_id,
		attempt_id: attemptId,
		attempt_ordinal: attemptOrdinal,
		launch_nonce: launchNonce,
		candidate_sha: previous.candidate_sha,
		runner: input.frozen.manifest.execution.runner_adapter,
		host_id: input.hostId,
		command: [...input.command],
		env: Object.fromEntries(Object.entries(input.env).sort(([left], [right]) => left.localeCompare(right))),
		cwd: checkoutPath,
		checkout_path: checkoutPath,
		attempt_directory: attemptDirectory,
		...input.runtimePokeFile === void 0 ? {} : { runtime_poke_file: input.runtimePokeFile },
		issued_at: previous.completed_at
	});
	const requestCanonical = canonicalJson$1(requestValue);
	const requestHash = sha256(requestCanonical);
	const request = Object.freeze({
		value: requestValue,
		canonicalJson: requestCanonical,
		sha256: requestHash,
		path: localAttemptRequestPath(runRoot, attemptId)
	});
	const launchPlan = compileLaunchPlan(requestValue);
	const transition = createRetryAttempt(state, state.revision, previous, {
		attempt_id: attemptId,
		request: {
			kind: "runner_request",
			sha256: requestHash
		},
		cwd: requestValue.cwd,
		env_sha256: launchPlan.envHash,
		runner: requestValue.runner,
		host_id: requestValue.host_id,
		launch_nonce: requestValue.launch_nonce,
		launched_at: requestValue.issued_at
	});
	const attemptCanonical = canonicalJson$1(transition.attempt);
	const attempt = Object.freeze({
		value: transition.attempt,
		canonicalJson: attemptCanonical,
		sha256: sha256(attemptCanonical),
		path: attemptStatePath(runRoot, attemptId, transition.state.revision, transition.attempt.phase)
	});
	return Object.freeze({
		request,
		attempt,
		transition,
		launchPlan,
		checkoutPath
	});
}
function compileLaunchPlan(request) {
	return compileLocalTmuxLaunch({
		attemptId: request.attempt_id,
		launchNonce: request.launch_nonce,
		candidateSha: request.candidate_sha,
		cwd: request.cwd,
		attemptDirectory: request.attempt_directory,
		command: request.command,
		env: request.env,
		...request.runtime_poke_file === void 0 ? {} : { runtimePokeFile: request.runtime_poke_file },
		issuedAt: request.issued_at
	});
}
function assertFrozenInputs(input) {
	if (input.frozen.manifest.execution.runner_adapter.id !== "local-tmux" || input.frozen.manifest.execution.runner_adapter.version !== "1") fail$1("Initial local Attempt requires the built-in local-tmux adapter v1", "INVALID_INPUT");
	if (!input.frozen.manifest.execution.hosts.some((host) => host.host_id === input.hostId && host.runner_target === "local")) fail$1("Initial local Attempt host is not a frozen local target", "INVALID_INPUT");
	const expectedSlot = input.trial.value.run_slots.find((slot) => slot.runslot_id === input.runSlot.value.runslot_id);
	if (input.trial.value.config_revision !== input.frozen.ref.revision || input.trial.value.trial_id !== input.runSlot.value.trial_id || input.runSlot.value.trial_contract_sha256 !== input.trial.sha256 || input.trial.value.candidate_sha !== input.runSlot.value.candidate_sha || expectedSlot === void 0 || input.runSlot.sha256 !== sha256(canonicalJson$1(runSlotContractSchema.parse(input.runSlot.value))) || input.runSlotState.status !== "pending" || input.runSlotState.runslot_contract_sha256 !== input.runSlot.sha256) fail$1("Trial, RunSlot, state, or CURRENT identity does not match", "IDENTITY_MISMATCH");
	if (!Number.isSafeInteger(input.issuedAt) || input.issuedAt < input.trial.value.created_at) fail$1("Attempt issuedAt must be a stable time at or after Trial creation", "INVALID_INPUT");
}
function assertRetryFrozenInputs(input) {
	const previous = parseAttempt(input.previous.attempt.value);
	const request = parseLocalAttemptRequest(input.previous.request.value);
	const runner = input.frozen.manifest.execution.runner_adapter;
	if (runner.id !== "local-tmux" || runner.version !== "1") fail$1("Local Attempt retry requires the built-in local-tmux adapter v1", "INVALID_INPUT");
	if (!input.frozen.manifest.execution.hosts.some((host) => host.host_id === input.hostId && host.runner_target === "local")) fail$1("Local Attempt retry host is not a frozen local target", "INVALID_INPUT");
	if (previous.phase !== "terminal" || previous.technical_outcome !== "failed" || previous.config_revision !== input.frozen.ref.revision || request.lab_id !== input.frozen.manifest.lab_id || request.config_revision !== input.frozen.ref.revision || request.attempt_id !== previous.attempt_id || request.attempt_ordinal !== previous.attempt_ordinal || request.candidate_sha !== previous.candidate_sha || request.trial_id !== previous.trial_id || request.runslot_id !== previous.runslot_id || canonicalJson$1(previous.runner) !== canonicalJson$1(runner)) fail$1("Failed Attempt, request, or CURRENT identity does not match", "IDENTITY_MISMATCH");
	return previous;
}
async function readAttemptArtifact(reference) {
	validateReference$2(reference);
	const bytes = await readRegular$2(reference.path, false, "Attempt artifact");
	if (bytes === void 0 || sha256(bytes) !== reference.hash) fail$1("Attempt artifact hash does not match its Controller reference", "ARTIFACT_CORRUPT");
	const text = decode(bytes, "Attempt artifact");
	let value;
	try {
		value = attemptSchema.parse(JSON.parse(text));
	} catch (error) {
		fail$1(`Attempt artifact is invalid: ${errorMessage$6(error)}`, "ARTIFACT_CORRUPT");
	}
	if (canonicalJson$1(value) !== text) fail$1("Attempt artifact is not canonical", "ARTIFACT_CORRUPT");
	return Object.freeze({
		value,
		canonicalJson: text,
		sha256: reference.hash,
		path: reference.path
	});
}
async function readRequestArtifact(path) {
	const bytes = await readRegular$2(path, false, "local Attempt request");
	if (bytes === void 0) fail$1("Local Attempt request is missing", "ARTIFACT_CORRUPT");
	const text = decode(bytes, "local Attempt request");
	let value;
	try {
		value = parseLocalAttemptRequest(JSON.parse(text));
	} catch (error) {
		fail$1(`Local Attempt request is invalid: ${errorMessage$6(error)}`, "ARTIFACT_CORRUPT");
	}
	if (canonicalJson$1(value) !== text) fail$1("Local Attempt request is not canonical", "ARTIFACT_CORRUPT");
	return Object.freeze({
		value,
		canonicalJson: text,
		sha256: sha256(text),
		path
	});
}
async function freezeCanonical$1(path, text) {
	let bytes = await readRegular$2(path, true, "immutable Attempt artifact");
	if (bytes === void 0) {
		try {
			await durableWriteFile(path, text, false);
		} catch (error) {
			if (!isNodeError$15(error) || error.code !== "EEXIST") throw error;
		}
		bytes = await readRegular$2(path, false, "immutable Attempt artifact");
	}
	if (bytes === void 0 || !bytes.equals(Buffer.from(text, "utf8"))) fail$1(`Immutable Attempt artifact conflicts at ${path}`, "ARTIFACT_CONFLICT");
}
async function readRegular$2(path, allowMissing, label) {
	let file;
	try {
		file = await open(path, READ_REGULAR_FLAGS$3);
		if (!(await file.stat()).isFile()) fail$1(`${label} is not a regular file at ${path}`, "ARTIFACT_CORRUPT");
		return await file.readFile();
	} catch (error) {
		if (error instanceof AttemptArtifactError) throw error;
		if (isNodeError$15(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
			if (allowMissing) return void 0;
			fail$1(`${label} is missing at ${path}`, "ARTIFACT_CORRUPT");
		}
		if (isNodeError$15(error) && error.code === "ELOOP") fail$1(`${label} is not a regular file at ${path}`, "ARTIFACT_CORRUPT");
		fail$1(`${label} I/O failed at ${path}: ${errorMessage$6(error)}`, "IO_FAILED");
	} finally {
		await file?.close().catch(() => void 0);
	}
}
function attemptStatePath(runRoot, attemptId, runSlotRevision, phase) {
	if (!Number.isSafeInteger(runSlotRevision) || runSlotRevision <= 0) fail$1("RunSlot revision must be positive for an Attempt artifact", "INVALID_INPUT");
	return join(localAttemptDirectory(runRoot, attemptId), "state", `${String(runSlotRevision).padStart(6, "0")}-${phase}.json`);
}
function deriveAttemptId(input) {
	return `attempt-${sha256(canonicalJson$1({
		version: 1,
		lab_id: input.labId,
		config_revision: input.configRevision,
		trial_id: input.trialId,
		runslot_id: input.runSlotId,
		runslot_contract_sha256: input.runSlotContractSha256,
		attempt_ordinal: input.ordinal
	}))}`;
}
function uuidFromHash(value) {
	const digits = value.slice(0, 32).split("");
	digits[12] = "5";
	digits[16] = (Number.parseInt(digits[16], 16) & 3 | 8).toString(16);
	const joined = digits.join("");
	return [
		joined.slice(0, 8),
		joined.slice(8, 12),
		joined.slice(12, 16),
		joined.slice(16, 20),
		joined.slice(20)
	].join("-");
}
function parseLocalAttemptRequest(value) {
	const parsed = localAttemptRequestSchema.safeParse(value);
	if (!parsed.success) fail$1(`Invalid local Attempt request: ${parsed.error.message}`, "INVALID_INPUT");
	return parsed.data;
}
function validateReference$2(reference) {
	if (!isAbsolute(reference.path) || resolve(reference.path) !== reference.path || !HASH_PATTERN.test(reference.hash)) fail$1("Attempt reference requires a normalized absolute path and SHA-256", "INVALID_INPUT");
}
function assertRootAndId(runRoot, attemptId) {
	if (!isAbsolute(runRoot) || resolve(runRoot) !== runRoot || !/^[A-Za-z0-9][A-Za-z0-9._:-]+$/u.test(attemptId)) fail$1("Run root and Attempt ID are invalid", "INVALID_INPUT");
}
function decode(bytes, label) {
	try {
		return new TextDecoder("utf-8", {
			fatal: true,
			ignoreBOM: true
		}).decode(bytes);
	} catch {
		fail$1(`${label} is not valid UTF-8`, "ARTIFACT_CORRUPT");
	}
}
function isNodeError$15(value) {
	return value instanceof Error && "code" in value;
}
function errorMessage$6(error) {
	return error instanceof Error ? error.message : String(error);
}
function fail$1(message, code) {
	throw new AttemptArtifactError(message, code);
}

//#endregion
//#region src/local-attempt-reconcile.ts
var LocalAttemptReconcileError = class extends Error {
	name = "LocalAttemptReconcileError";
	constructor(message, code) {
		super(message);
		this.code = code;
	}
};
/**
* Convert one already-completed local-tmux inspection into generic Attempt
* artifacts and CAS-ready RunSlot transitions. It performs no launch, poll,
* retry, or Controller mutation.
*/
async function reconcileLocalTmuxInspection(input) {
	const current = validateInput$5(input);
	const identity = Object.freeze({
		attemptId: current.attempt_id,
		launchNonce: current.launch_nonce,
		requestSha256: current.request.sha256
	});
	if (input.inspection.status === "absent") {
		if (current.phase !== "launching") return blockedResult(identity, "RECEIPT_CORRUPT", `local launch evidence disappeared after Attempt ${current.attempt_id} advanced`);
		return Object.freeze({
			action: "launch_required",
			identity,
			launchPrepared: input.inspection.launchPrepared
		});
	}
	if (input.inspection.status === "launching") {
		if (current.phase !== "launching" && !(current.phase === "outcome_unknown" && current.started_receipt === void 0)) return blockedResult(identity, "RECEIPT_CORRUPT", `started.json disappeared after Attempt ${current.attempt_id} recorded a start`);
		return Object.freeze({
			action: "await_started_receipt",
			identity,
			launchPrepared: input.inspection.launchPrepared
		});
	}
	if (input.inspection.status === "blocked") return Object.freeze({
		action: "blocked",
		identity,
		blocker: Object.freeze({
			code: input.inspection.code,
			message: input.inspection.message
		})
	});
	if (input.inspection.status === "pending") return Object.freeze({
		action: "pending",
		identity,
		pending: Object.freeze({
			code: input.inspection.code,
			message: input.inspection.message
		})
	});
	const observedStarted = input.inspection.started;
	if (observedStarted === void 0) {
		if (input.inspection.status !== "outcome_unknown") invalid("only an outcome-unknown inspection may omit started.json");
		if (current.phase === "running" || current.phase === "terminal" || current.phase === "outcome_unknown" && current.started_receipt !== void 0) return blockedResult(identity, "RECEIPT_CORRUPT", `started.json disappeared after Attempt ${current.attempt_id} recorded a start`);
	} else assertStartedIdentity(input.intent, observedStarted);
	if (current.phase === "terminal" && input.inspection.status !== "completed") return blockedResult(identity, "RECEIPT_CORRUPT", `exit.json disappeared after Attempt ${current.attempt_id} reached terminal`);
	if (input.inspection.status === "completed") assertExitIdentity(input.intent, input.inspection.started, input.inspection.exit);
	let state = parseRunSlotState(input.runSlotState);
	let attempt = current;
	const originalState = state;
	const originalAttempt = attempt;
	const records = [];
	if (observedStarted !== void 0) {
		const started = compileGenericStartedReceipt(attempt, observedStarted);
		const startedPath = receiptPath(input.runRoot, attempt.attempt_id, "started");
		if (attempt.phase === "terminal") {
			assertExistingStarted(attempt, started, startedPath);
			records.push(await freezeReceiptRecord(input.runRoot, attempt.attempt_id, "started", started));
		} else if (attempt.phase === "outcome_unknown" && attempt.started_receipt !== void 0 && input.inspection.status !== "running") {
			assertExistingStarted(attempt, started, startedPath);
			records.push(await freezeReceiptRecord(input.runRoot, attempt.attempt_id, "started", started));
		} else {
			const startedTransition = recordAttemptStarted(state, state.revision, attempt, started, startedPath);
			if (transitionChanged(state, attempt, startedTransition)) {
				records.push(input.inspection.status === "running" ? await freezeRecord(input.runRoot, "started", started, startedTransition) : await freezeReceiptRecord(input.runRoot, attempt.attempt_id, "started", started));
				state = startedTransition.state;
				attempt = startedTransition.attempt;
			} else records.push(await freezeReceiptRecord(input.runRoot, attempt.attempt_id, "started", started));
		}
	}
	if (input.inspection.status === "running") return finish("record_started", "running", identity, records, aggregateTransition(originalState, originalAttempt, state, attempt));
	if (input.inspection.status === "completed") {
		const completion = compileGenericCompletionReceipt(attempt, input.inspection.exit);
		const completionPath = receiptPath(input.runRoot, attempt.attempt_id, "completion");
		const transition$1 = recordAttemptCompletion(state, state.revision, attempt, completion, completionPath);
		if (transitionChanged(state, attempt, transition$1)) {
			records.push(await freezeRecord(input.runRoot, "completion", completion, transition$1));
			state = transition$1.state;
			attempt = transition$1.attempt;
		} else records.push(await freezeReceiptRecord(input.runRoot, attempt.attempt_id, "completion", completion));
		return finish("record_completion", "completed", identity, records, aggregateTransition(originalState, originalAttempt, state, attempt));
	}
	const existingUncertain = await readAttemptUncertainReceiptArtifactIfPresent(input.runRoot, attempt.attempt_id);
	if (existingUncertain !== void 0) assertExistingUncertain(attempt, existingUncertain);
	const uncertain = existingUncertain ?? compileGenericUncertainReceipt(attempt, input.inspection.reason, attempt.phase === "outcome_unknown" ? attempt.unknown_since : requireObservedAt(input.observedAt));
	const uncertainPath = receiptPath(input.runRoot, attempt.attempt_id, "uncertain");
	const transition = recordAttemptOutcomeUnknown(state, state.revision, attempt, uncertain, uncertainPath);
	if (transitionChanged(state, attempt, transition)) {
		records.push(await freezeRecord(input.runRoot, "uncertain", uncertain, transition));
		state = transition.state;
		attempt = transition.attempt;
	} else records.push(await freezeReceiptRecord(input.runRoot, attempt.attempt_id, "uncertain", uncertain));
	return finish("record_uncertain", "outcome_unknown", identity, records, aggregateTransition(originalState, originalAttempt, state, attempt));
}
function validateInput$5(input) {
	if (!isAbsolute(input.runRoot) || resolve(input.runRoot) !== input.runRoot) invalid("runRoot must be normalized and absolute");
	const state = parseRunSlotState(input.runSlotState);
	const attempt = parseAttempt(input.intent.attempt.value);
	const request = input.intent.request;
	const attemptText = canonicalJson$1(attempt);
	const requestText = canonicalJson$1(request.value);
	if (input.intent.attempt.canonicalJson !== attemptText || input.intent.attempt.sha256 !== sha256(attemptText) || request.canonicalJson !== requestText || request.sha256 !== sha256(requestText) || request.path !== localAttemptRequestPath(input.runRoot, attempt.attempt_id) || input.intent.launchPlan.attemptDirectory !== localAttemptDirectory(input.runRoot, attempt.attempt_id) || request.value.attempt_id !== attempt.attempt_id || request.value.attempt_ordinal !== attempt.attempt_ordinal || request.value.launch_nonce !== attempt.launch_nonce || request.value.candidate_sha !== attempt.candidate_sha || request.value.runslot_id !== attempt.runslot_id || request.value.trial_id !== attempt.trial_id || request.value.config_revision !== attempt.config_revision || request.value.cwd !== attempt.cwd || request.value.host_id !== attempt.host_id || request.value.runner.id !== attempt.runner.id || request.value.runner.version !== attempt.runner.version || request.value.runner.sha256 !== attempt.runner.sha256 || attempt.request.kind !== "runner_request" || attempt.request.sha256 !== request.sha256 || input.intent.launchPlan.attemptId !== attempt.attempt_id || input.intent.launchPlan.launchNonce !== attempt.launch_nonce || input.intent.launchPlan.candidateSha !== attempt.candidate_sha || input.intent.launchPlan.cwd !== attempt.cwd || input.intent.launchPlan.envHash !== attempt.env_sha256 || input.intent.launchPlan.attemptDirectory !== request.value.attempt_directory || input.intent.launchPlan.issuedAt !== request.value.issued_at || canonicalJson$1(input.intent.launchPlan.command) !== canonicalJson$1(request.value.command) || canonicalJson$1(input.intent.launchPlan.env) !== canonicalJson$1(request.value.env) || state.status === "pending" || state.attempt_id !== attempt.attempt_id || state.attempt_ordinal !== attempt.attempt_ordinal || state.attempt_identity_sha256 !== attemptIdentitySha256(attempt) || state.runslot_id !== attempt.runslot_id || state.trial_id !== attempt.trial_id || state.runslot_contract_sha256 !== attempt.runslot_contract_sha256 || state.launch_nonces.at(-1) !== attempt.launch_nonce) mismatch("Frozen request, RunSlot state, Attempt, and launch intent do not match");
	if (!(state.status === "attempt_active" ? attempt.phase === "launching" || attempt.phase === "running" : state.status === "outcome_unknown" ? attempt.phase === "outcome_unknown" : attempt.phase === "terminal")) mismatch("RunSlot status does not match the current Attempt phase");
	return attempt;
}
function compileGenericStartedReceipt(attempt, started) {
	return compileAttemptStartedReceipt({
		version: 1,
		type: "attempt_started",
		attempt_id: attempt.attempt_id,
		launch_nonce: attempt.launch_nonce,
		candidate_sha: attempt.candidate_sha,
		request_sha256: attempt.request.sha256,
		started_at: started.startedAt,
		process: {
			pid: started.pid,
			pgid: started.pgid,
			start_identity: started.receiptHash,
			host_boot_id: started.bootId,
			tmux_session: started.tmuxSession
		}
	});
}
function compileGenericCompletionReceipt(attempt, exit) {
	const succeeded = exit.outcome === "exited" && exit.exitCode === 0;
	return compileAttemptCompletionReceipt({
		version: 1,
		type: "attempt_completion",
		attempt_id: attempt.attempt_id,
		launch_nonce: attempt.launch_nonce,
		candidate_sha: attempt.candidate_sha,
		request_sha256: attempt.request.sha256,
		completed_at: exit.finishedAt,
		completion_identity: exit.receiptHash,
		technical_outcome: succeeded ? "succeeded" : "failed",
		...succeeded ? {} : { technical_detail: {
			kind: "runner",
			code: exitFailureCode(exit),
			...exit.outcome === "spawn_failed" ? { detail: exit.spawnError } : {}
		} },
		artifacts: [{
			kind: "log",
			path: exit.logPath
		}]
	});
}
function compileGenericUncertainReceipt(attempt, reason, observedAt) {
	return compileAttemptUncertainReceipt({
		version: 1,
		type: "attempt_outcome_unknown",
		attempt_id: attempt.attempt_id,
		launch_nonce: attempt.launch_nonce,
		candidate_sha: attempt.candidate_sha,
		request_sha256: attempt.request.sha256,
		observed_at: observedAt,
		technical_detail: {
			kind: "runner",
			code: "local_tmux_outcome_unknown",
			detail: reason
		}
	});
}
function assertStartedIdentity(intent, started) {
	assertRawReceiptHash("started", started);
	const plan = intent.launchPlan;
	if (started.attemptId !== plan.attemptId || started.launchNonce !== plan.launchNonce || started.candidateSha !== plan.candidateSha || started.tmuxSession !== plan.tmuxSession || started.commandHash !== plan.commandHash || started.cwd !== plan.cwd || started.cwdHash !== plan.cwdHash || started.envHash !== plan.envHash || started.launchIdentityHash !== plan.launchIdentityHash || started.launchSpecReceiptHash !== plan.launchSpec.receiptHash || started.logPath !== plan.paths.log) mismatch("Raw local-tmux started receipt does not match the frozen launch intent");
}
function assertExitIdentity(intent, started, exit) {
	assertRawReceiptHash("exit", exit);
	const plan = intent.launchPlan;
	if (exit.attemptId !== started.attemptId || exit.launchNonce !== started.launchNonce || exit.candidateSha !== started.candidateSha || exit.tmuxSession !== started.tmuxSession || exit.commandHash !== started.commandHash || exit.cwdHash !== plan.cwdHash || exit.envHash !== started.envHash || exit.launchIdentityHash !== started.launchIdentityHash || exit.startedReceiptHash !== started.receiptHash || exit.tmuxPaneId !== started.tmuxPaneId || exit.pid !== started.pid || exit.pgid !== started.pgid || exit.processStartId !== started.processStartId || exit.processCommandHash !== started.processCommandHash || exit.hostname !== started.hostname || exit.bootId !== started.bootId || exit.logPath !== plan.paths.log || exit.finishedAt < started.startedAt) mismatch("Raw local-tmux exit receipt does not match its started receipt and launch intent");
}
function assertRawReceiptHash(kind, receipt) {
	const { receiptHash,...body } = receipt;
	if (receiptHash !== sha256(`autolab-local-tmux-${kind === "started" ? "started" : "exit"}-v1\0${canonicalJson$1(body)}`)) mismatch(`Raw local-tmux ${kind} receipt hash is invalid`);
}
function assertExistingStarted(attempt, receipt, path) {
	if (attempt.phase !== "outcome_unknown" && attempt.phase !== "terminal" || attempt.started_at !== receipt.value.started_at || attempt.started_receipt?.path !== path || attempt.started_receipt.sha256 !== receipt.sha256 || canonicalJson$1(attempt.process ?? null) !== canonicalJson$1(receipt.value.process ?? null)) mismatch("Current Attempt does not project the exact raw local-tmux started receipt");
}
function assertExistingUncertain(attempt, receipt) {
	const value = receipt.value;
	if (value.attempt_id !== attempt.attempt_id || value.launch_nonce !== attempt.launch_nonce || value.candidate_sha !== attempt.candidate_sha || value.request_sha256 !== attempt.request.sha256 || value.observed_at < ("started_at" in attempt ? attempt.started_at ?? attempt.launched_at : attempt.launched_at) || value.technical_detail.kind !== "runner" || value.technical_detail.code !== "local_tmux_outcome_unknown" || attempt.phase === "outcome_unknown" && (attempt.unknown_since !== value.observed_at || attempt.uncertainty_receipt.sha256 !== receipt.sha256)) mismatch("Existing uncertain receipt does not match the current Attempt identity");
}
async function freezeGenericReceipt(runRoot, attemptId, kind, receipt) {
	const reference = await freezeAttemptReceiptArtifact(runRoot, attemptId, kind, receipt);
	return Object.freeze({
		...receipt,
		path: reference.path
	});
}
async function freezeRecord(runRoot, kind, receipt, transition) {
	const [frozenReceipt, attemptArtifact] = await Promise.all([freezeGenericReceipt(runRoot, transition.attempt.attempt_id, kind, receipt), freezeAttemptStateArtifact(runRoot, transition.state.revision, transition.attempt)]);
	return Object.freeze({
		kind,
		receipt: frozenReceipt,
		attemptArtifact
	});
}
async function freezeReceiptRecord(runRoot, attemptId, kind, receipt) {
	return Object.freeze({
		kind,
		receipt: await freezeGenericReceipt(runRoot, attemptId, kind, receipt)
	});
}
function receiptPath(runRoot, attemptId, kind) {
	return join(localAttemptDirectory(runRoot, attemptId), "receipts", `${kind}.json`);
}
function transitionChanged(state, attempt, transition) {
	return canonicalJson$1(state) !== canonicalJson$1(transition.state) || canonicalJson$1(attempt) !== canonicalJson$1(transition.attempt);
}
function attemptIdentitySha256(attempt) {
	return sha256(canonicalJson$1({
		version: 1,
		attempt_id: attempt.attempt_id,
		attempt_ordinal: attempt.attempt_ordinal,
		...attempt.predecessor_attempt_id === void 0 ? {} : { predecessor_attempt_id: attempt.predecessor_attempt_id },
		trial_id: attempt.trial_id,
		runslot_id: attempt.runslot_id,
		trial_contract_sha256: attempt.trial_contract_sha256,
		runslot_contract_sha256: attempt.runslot_contract_sha256,
		candidate_sha: attempt.candidate_sha,
		config_revision: attempt.config_revision,
		request: attempt.request,
		cwd: attempt.cwd,
		env_sha256: attempt.env_sha256,
		runner: attempt.runner,
		host_id: attempt.host_id,
		launch_nonce: attempt.launch_nonce,
		launched_at: attempt.launched_at,
		...attempt.gpu_lease === void 0 ? {} : { gpu_lease: attempt.gpu_lease },
		...attempt.remote_connection === void 0 ? {} : { remote_connection: attempt.remote_connection },
		...attempt.adapter_checkpoint_identity === void 0 ? {} : { adapter_checkpoint_identity: attempt.adapter_checkpoint_identity }
	}));
}
function aggregateTransition(originalState, originalAttempt, finalState, finalAttempt) {
	if (!transitionChanged(originalState, originalAttempt, {
		expected_revision: originalState.revision,
		state: finalState,
		attempt: finalAttempt
	})) return void 0;
	return Object.freeze({
		expected_revision: originalState.revision,
		state: finalState,
		attempt: finalAttempt
	});
}
function exitFailureCode(exit) {
	if (exit.outcome === "exited") return `exit_code_${String(exit.exitCode)}`;
	if (exit.outcome === "signaled") return `signal_${String(exit.signal)}`;
	return "spawn_failed";
}
function finish(action, inspectionStatus, identity, records, transition) {
	return Object.freeze({
		action: transition === void 0 ? "already_reconciled" : action,
		identity,
		inspectionStatus,
		records: Object.freeze([...records]),
		...transition === void 0 ? {} : { transition }
	});
}
function blockedResult(identity, code, message) {
	return Object.freeze({
		action: "blocked",
		identity,
		blocker: Object.freeze({
			code,
			message
		})
	});
}
function requireObservedAt(value) {
	if (!Number.isSafeInteger(value) || value === void 0 || value < 0) invalid("the first outcome-unknown observation requires a non-negative safe observedAt");
	return value;
}
function invalid(message) {
	throw new LocalAttemptReconcileError(message, "INVALID_INPUT");
}
function mismatch(message) {
	throw new LocalAttemptReconcileError(message, "IDENTITY_MISMATCH");
}

//#endregion
//#region src/attempt-runtime.ts
const DEFAULT_OPERATIONS = Object.freeze({
	readIntent: readLocalAttemptIntent,
	inspect: inspectLocalTmuxAttempt,
	launch: launchLocalTmuxAttempt,
	reconcile: reconcileLocalTmuxInspection
});
/**
* Event-driven consumer for one exact active RunSlot edge. It owns only
* process-local one-shot timers. Durable Attempt and RuntimeState truth remain
* in their existing artifacts and Controller CAS projection.
*/
var AttemptRuntimeConsumer = class {
	operations;
	armed = /* @__PURE__ */ new Map();
	tails = /* @__PURE__ */ new Map();
	disposed = false;
	constructor(options) {
		this.options = options;
		assertDelay(options.pendingRetryDelayMs, "pendingRetryDelayMs");
		assertDelay(options.launchSafetyDelayMs, "launchSafetyDelayMs");
		this.operations = Object.freeze({
			...DEFAULT_OPERATIONS,
			...options.operations
		});
	}
	dispatch(targetInput, edge) {
		const target = snapshotTarget(targetInput);
		if (this.disposed) return Promise.reject(/* @__PURE__ */ new Error("Attempt runtime consumer is disposed"));
		return this.enqueue(target, async () => await this.consumeAndPublish(target, edge));
	}
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		for (const edge of this.armed.values()) edge.cancel();
		this.armed.clear();
	}
	/** Call after dispose() and before closing RuntimeState/domain dependencies. */
	async drain() {
		await Promise.allSettled([...this.tails.values()]);
	}
	async consumeAndPublish(target, edge, expected) {
		const result$1 = await this.consume(target, edge, expected);
		await this.options.onResult(result$1);
		if (!this.disposed) this.reconcileTimers(result$1);
		return result$1;
	}
	async consume(target, edge, expected) {
		const stateInput = await this.options.readState(target.labId);
		if (stateInput === void 0) return inactive(edge, target);
		const state = parseState(stateInput);
		if (state.labId !== target.labId) return stale(edge, target);
		const reference = state.trials[target.trialId]?.runSlots[target.runSlotId]?.activeAttempt;
		if (reference === void 0) return inactive(edge, target);
		const sourceAttempt = snapshotReference(reference);
		if (expected !== void 0 && !sameReference$1(sourceAttempt, expected)) return stale(edge, target);
		const runRoot = await this.options.resolveRunRoot(state, target);
		const intent = await this.operations.readIntent({
			runRoot,
			activeAttempt: {
				path: sourceAttempt.path,
				hash: sourceAttempt.hash
			}
		});
		if (intent.attempt.value.attempt_id !== sourceAttempt.attemptId || intent.attempt.value.phase !== sourceAttempt.phase) throw new Error("RuntimeState active Attempt reference does not match its exact artifact");
		const resolved = {
			state,
			reference: sourceAttempt
		};
		let inspection = await this.operations.inspect(intent.launchPlan, this.options.platform === void 0 ? {} : { platform: this.options.platform });
		let launched = false;
		if (sourceAttempt.phase === "launching" && inspection.status === "absent") {
			launched = true;
			inspection = await this.operations.launch(intent.launchPlan, {
				wrapperPath: this.options.wrapperPath,
				...this.options.platform === void 0 ? {} : { platform: this.options.platform }
			});
		}
		const reconcile = await this.operations.reconcile({
			runRoot,
			runSlotState: state.trials[target.trialId].runSlots[target.runSlotId].state,
			intent,
			inspection,
			observedAt: this.options.now()
		});
		const projection = compileProjection(resolved, target, reconcile);
		const controllerWake = compileControllerWake(state, target, projection?.activeAttempt ?? sourceAttempt, reconcile, edge);
		return Object.freeze({
			outcome: "handled",
			edge,
			target,
			sourceAttempt,
			launched,
			inspection,
			reconcile,
			...projection === void 0 ? {} : { projection },
			...controllerWake === void 0 ? {} : { controllerWake }
		});
	}
	reconcileTimers(result$1) {
		if (result$1.outcome !== "handled") return;
		const target = result$1.target;
		const retryKey = armedKey(target, "pending-retry");
		if (result$1.reconcile.action === "pending") {
			if (result$1.edge !== "pending-retry") this.arm(target, "pending-retry", result$1.projection?.activeAttempt ?? result$1.sourceAttempt, this.options.pendingRetryDelayMs);
			return;
		}
		this.clearArmed(retryKey);
		if (result$1.edge === "poke" || result$1.controllerWake !== void 0) this.clearArmed(armedKey(target, "launch-safety"));
		if (result$1.controllerWake !== void 0) return;
		if (result$1.launched && (result$1.inspection.status === "launching" || result$1.inspection.status === "running")) this.arm(target, "launch-safety", result$1.projection?.activeAttempt ?? result$1.sourceAttempt, this.options.launchSafetyDelayMs);
	}
	arm(target, edge, expected, delayMs) {
		const key = armedKey(target, edge);
		if (this.armed.has(key) || this.disposed) return;
		const cancel = this.options.scheduleOnce(() => {
			if (!this.armed.delete(key) || this.disposed) return;
			this.enqueue(target, async () => await this.consumeAndPublish(target, edge, expected)).catch((error) => this.report(error));
		}, delayMs);
		this.armed.set(key, { cancel });
	}
	clearArmed(key) {
		const edge = this.armed.get(key);
		if (edge === void 0) return;
		this.armed.delete(key);
		edge.cancel();
	}
	enqueue(target, operation) {
		const key = targetKey(target);
		const run$1 = (this.tails.get(key) ?? Promise.resolve()).then(operation);
		const tail = run$1.then(() => void 0, () => void 0);
		this.tails.set(key, tail);
		tail.finally(() => {
			if (this.tails.get(key) === tail) this.tails.delete(key);
		});
		return run$1;
	}
	report(error) {
		try {
			this.options.onError?.(error);
		} catch {}
	}
};
function compileProjection(resolved, target, reconcile) {
	if (!("transition" in reconcile) || reconcile.transition === void 0) return void 0;
	const artifact = [...reconcile.records].reverse().find((record$1) => record$1.attemptArtifact !== void 0)?.attemptArtifact;
	if (artifact === void 0) throw new Error("Attempt reconcile transition is missing its exact Attempt artifact");
	const activeAttempt = snapshotReference({
		attemptId: reconcile.transition.attempt.attempt_id,
		phase: reconcile.transition.attempt.phase,
		path: artifact.path,
		hash: artifact.sha256,
		...resolved.reference.checkout === void 0 ? {} : { checkout: resolved.reference.checkout }
	});
	return Object.freeze({
		expectedRuntimeRevision: resolved.state.runtimeRevision,
		trialId: target.trialId,
		runSlotId: target.runSlotId,
		expectedActiveAttempt: resolved.reference,
		runSlotState: reconcile.transition.state,
		activeAttempt
	});
}
function compileControllerWake(state, target, activeAttempt, reconcile, edge) {
	if (activeAttempt.phase !== "terminal" && activeAttempt.phase !== "outcome_unknown") return;
	if (reconcile.action === "launch_required" || reconcile.action === "await_started_receipt" || reconcile.action === "pending" && edge !== "pending-retry") return void 0;
	const phase = activeAttempt.phase;
	const goal = state.controllerGoal;
	if (goal?.status !== "applied" || goal.goalId === void 0 || goal.goalRevision === void 0) return void 0;
	return Object.freeze({
		labId: state.labId,
		controllerSessionId: state.controllerSessionId,
		goalRef: Object.freeze({
			id: goal.goalId,
			revision: goal.goalRevision
		}),
		trialId: target.trialId,
		runSlotId: target.runSlotId,
		attemptId: activeAttempt.attemptId,
		phase
	});
}
function snapshotTarget(target) {
	if (target.labId.length === 0 || target.trialId.length === 0 || target.runSlotId.length === 0) throw new TypeError("Attempt runtime target identities must be non-empty");
	return Object.freeze({ ...target });
}
function snapshotReference(reference) {
	return Object.freeze({
		attemptId: reference.attemptId,
		phase: reference.phase,
		path: reference.path,
		hash: reference.hash,
		...reference.checkout === void 0 ? {} : { checkout: Object.freeze({ ...reference.checkout }) }
	});
}
function sameReference$1(left, right) {
	return canonicalJson$1(left) === canonicalJson$1(right);
}
function inactive(edge, target) {
	return Object.freeze({
		outcome: "inactive",
		edge,
		target
	});
}
function stale(edge, target) {
	return Object.freeze({
		outcome: "stale",
		edge,
		target
	});
}
function targetKey(target) {
	return canonicalJson$1(target);
}
function armedKey(target, edge) {
	return `${targetKey(target)}\0${edge}`;
}
function assertDelay(value, label) {
	if (!Number.isFinite(value) || value < 0) throw new TypeError(`${label} must be a finite non-negative number`);
}

//#endregion
//#region src/run-checkout.ts
const execFileAsync$2 = promisify(execFile);
const GIT_COMMIT_PATTERN$1 = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SHA256_PATTERN$15 = /^[0-9a-f]{64}$/u;
const ATTEMPT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const READ_REGULAR_FLAGS$2 = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const UTF8$7 = new TextDecoder("utf-8", {
	fatal: true,
	ignoreBOM: true
});
const normalizedAbsolutePath = z.string().min(1).refine((value) => isAbsolute(value) && resolve(value) === value, "path must be normalized and absolute");
const runCheckoutReceiptSchema = z.object({
	version: z.literal(1),
	kind: z.literal("AUTOLAB_DETACHED_RUN_CHECKOUT"),
	attemptId: z.string().regex(ATTEMPT_PATTERN),
	candidateSha: z.string().regex(GIT_COMMIT_PATTERN$1),
	repositoryPath: normalizedAbsolutePath,
	gitCommonDirectory: normalizedAbsolutePath,
	repositoryIdentitySha256: z.string().regex(SHA256_PATTERN$15),
	checkoutPath: normalizedAbsolutePath,
	receiptPath: normalizedAbsolutePath,
	createdAt: z.number().int().nonnegative(),
	receiptHash: z.string().regex(SHA256_PATTERN$15)
}).strict();
var RunCheckoutError = class extends Error {
	name = "RunCheckoutError";
	constructor(message, code) {
		super(message);
		this.code = code;
	}
};
const inFlight = /* @__PURE__ */ new Map();
/** Deterministic receipt location when the caller does not supply one. */
function runCheckoutReceiptPath(checkoutPath) {
	return join(dirname(checkoutPath), `${basename(checkoutPath)}.checkout.json`);
}
/**
* Create one Attempt-owned detached checkout, or adopt only its exact durable
* identity on replay. This helper never resets, cleans, removes, or overwrites.
*/
async function provisionDetachedRunCheckout(input) {
	const receiptPath$1 = input.receiptPath ?? runCheckoutReceiptPath(input.checkoutPath);
	const key = canonicalJson$1({
		version: 1,
		attemptId: input.attemptId,
		candidateSha: input.candidateSha,
		repositoryPath: input.repositoryPath,
		checkoutPath: input.checkoutPath,
		receiptPath: receiptPath$1
	});
	const current = inFlight.get(key);
	if (current !== void 0) return await current;
	const operation = provision({
		...input,
		receiptPath: receiptPath$1
	});
	inFlight.set(key, operation);
	try {
		return await operation;
	} finally {
		if (inFlight.get(key) === operation) inFlight.delete(key);
	}
}
/**
* Inspect a launched Attempt's frozen checkout identity without requiring a
* clean worktree. The experiment may legitimately create or edit files after
* launch; repository, common-dir, exact HEAD, detached state, and receipt
* identity remain invariant. This function is read-only.
*/
async function inspectDetachedRunCheckout(input) {
	validateInspectionInput(input);
	const repositoryPath = await canonicalExistingDirectory(input.repositoryPath, "repository", "IDENTITY_DRIFT");
	const checkoutPath = await canonicalLeafPath(input.checkoutPath, "checkout");
	const receiptPath$1 = await canonicalLeafPath(input.receiptPath, "receipt");
	if (repositoryPath !== input.repositoryPath || checkoutPath !== input.checkoutPath || receiptPath$1 !== input.receiptPath) fail("frozen checkout paths are no longer canonical", "IDENTITY_DRIFT");
	let repositoryTop;
	try {
		repositoryTop = await git$2(repositoryPath, ["rev-parse", "--show-toplevel"]);
	} catch (error) {
		if (error instanceof RunCheckoutError && error.code === "GIT_FAILED") fail(`frozen repository is no longer inspectable: ${error.message}`, "IDENTITY_DRIFT");
		throw error;
	}
	if (await canonicalExistingDirectory(repositoryTop, "repository root", "IDENTITY_DRIFT") !== repositoryPath) fail("repositoryPath no longer names the exact Git worktree root", "IDENTITY_DRIFT");
	const gitCommonDirectory = await canonicalGitCommonDirectory$1(repositoryPath, "IDENTITY_DRIFT");
	let candidateSha;
	try {
		candidateSha = await git$2(repositoryPath, [
			"rev-parse",
			"--verify",
			`${input.candidateSha}^{commit}`
		]);
	} catch (error) {
		if (error instanceof RunCheckoutError && error.code === "GIT_FAILED") fail(`frozen candidate is no longer present: ${error.message}`, "IDENTITY_DRIFT");
		throw error;
	}
	if (candidateSha !== input.candidateSha) fail("frozen candidate commit identity drifted", "IDENTITY_DRIFT");
	const expectedIdentity = {
		attemptId: input.attemptId,
		candidateSha,
		repositoryPath,
		gitCommonDirectory,
		repositoryIdentitySha256: hashRepositoryIdentity(repositoryPath, gitCommonDirectory),
		checkoutPath,
		receiptPath: receiptPath$1
	};
	const receipt = await readReceipt$2(receiptPath$1, false);
	if (receipt === void 0) fail("frozen checkout receipt is missing", "IDENTITY_DRIFT");
	assertReceiptIdentity(receipt, expectedIdentity);
	const receiptBytes = Buffer.from(canonicalJson$1(receipt), "utf8");
	if (sha256(receiptBytes) !== input.receiptSha256) fail("frozen checkout receipt SHA-256 drifted", "IDENTITY_DRIFT");
	await inspectCheckout(checkoutPath, candidateSha, gitCommonDirectory, false);
	return result(receipt, receiptBytes);
}
async function provision(input) {
	validateInput$4(input);
	const repositoryPath = await canonicalExistingDirectory(input.repositoryPath, "repository");
	const checkoutPath = await canonicalLeafPath(input.checkoutPath, "checkout");
	const receiptPath$1 = await canonicalLeafPath(input.receiptPath, "receipt");
	if (repositoryPath !== input.repositoryPath || checkoutPath !== input.checkoutPath || receiptPath$1 !== input.receiptPath) fail("repository, checkout, and receipt paths must be canonical", "INVALID_INPUT");
	if (repositoryPath === checkoutPath || isInside$1(checkoutPath, receiptPath$1)) fail("checkout must be independent and its receipt must remain outside it", "INVALID_INPUT");
	if (await canonicalExistingDirectory(await git$2(repositoryPath, ["rev-parse", "--show-toplevel"]), "repository root") !== repositoryPath) fail("repositoryPath must be the exact Git worktree root", "INVALID_INPUT");
	const gitCommonDirectory = await canonicalGitCommonDirectory$1(repositoryPath, "GIT_FAILED");
	const candidateSha = await git$2(repositoryPath, [
		"rev-parse",
		"--verify",
		`${input.candidateSha}^{commit}`
	]);
	if (candidateSha !== input.candidateSha) fail("candidateSha is not the exact commit resolved by the repository", "GIT_FAILED");
	const repositoryIdentitySha256 = hashRepositoryIdentity(repositoryPath, gitCommonDirectory);
	const expectedIdentity = {
		attemptId: input.attemptId,
		candidateSha,
		repositoryPath,
		gitCommonDirectory,
		repositoryIdentitySha256,
		checkoutPath,
		receiptPath: receiptPath$1
	};
	const existingReceipt = await readReceipt$2(receiptPath$1, true);
	if (existingReceipt !== void 0) {
		assertReceiptIdentity(existingReceipt, expectedIdentity);
		await inspectCheckout(checkoutPath, candidateSha, gitCommonDirectory, true);
		return result(existingReceipt, Buffer.from(canonicalJson$1(existingReceipt), "utf8"));
	}
	const existingCheckout = await lstat(checkoutPath).catch((error) => {
		if (isNodeError$14(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) return void 0;
		fail(`cannot inspect checkout path: ${errorMessage$5(error)}`, "IO_FAILED");
	});
	if (existingCheckout === void 0) {
		await mkdir(dirname(checkoutPath), {
			recursive: true,
			mode: 448
		}).catch((error) => {
			fail(`cannot create checkout parent: ${errorMessage$5(error)}`, "IO_FAILED");
		});
		try {
			await git$2(repositoryPath, [
				"worktree",
				"add",
				"--detach",
				checkoutPath,
				candidateSha
			]);
		} catch (error) {
			if (await lstat(checkoutPath).catch(() => void 0) === void 0) throw error;
			await inspectCheckout(checkoutPath, candidateSha, gitCommonDirectory, true);
		}
	} else {
		if (!existingCheckout.isDirectory() || existingCheckout.isSymbolicLink()) fail("existing checkout path is not a real directory", "IDENTITY_DRIFT");
		await inspectCheckout(checkoutPath, candidateSha, gitCommonDirectory, true);
	}
	await inspectCheckout(checkoutPath, candidateSha, gitCommonDirectory, true);
	const withoutHash = {
		version: 1,
		kind: "AUTOLAB_DETACHED_RUN_CHECKOUT",
		...expectedIdentity,
		createdAt: input.now ?? Date.now()
	};
	const receipt = runCheckoutReceiptSchema.parse({
		...withoutHash,
		receiptHash: hashReceipt$1(withoutHash)
	});
	const bytes = Buffer.from(canonicalJson$1(receipt), "utf8");
	try {
		await durableWriteFile(receiptPath$1, bytes, false);
	} catch (error) {
		if (!isNodeError$14(error) || error.code !== "EEXIST") fail(`cannot freeze checkout receipt: ${errorMessage$5(error)}`, "IO_FAILED");
		const collision = await lstat(receiptPath$1).catch(() => void 0);
		if (collision?.isFile() !== true || collision.isSymbolicLink()) fail(`cannot freeze checkout receipt: ${errorMessage$5(error)}`, "IO_FAILED");
	}
	const frozen = await readReceipt$2(receiptPath$1, false);
	if (frozen === void 0) fail("checkout receipt disappeared after creation", "IDENTITY_DRIFT");
	assertReceiptIdentity(frozen, expectedIdentity);
	const frozenBytes = Buffer.from(canonicalJson$1(frozen), "utf8");
	await inspectCheckout(checkoutPath, candidateSha, gitCommonDirectory, true);
	return result(frozen, frozenBytes);
}
async function inspectCheckout(checkoutPath, candidateSha, expectedCommonDirectory, requireClean) {
	let info;
	try {
		info = await lstat(checkoutPath);
	} catch (error) {
		fail(`detached checkout is missing: ${errorMessage$5(error)}`, "IDENTITY_DRIFT");
	}
	if (!info.isDirectory() || info.isSymbolicLink()) fail("detached checkout is not a real directory", "IDENTITY_DRIFT");
	let canonicalCheckout;
	try {
		canonicalCheckout = await realpath(checkoutPath);
	} catch (error) {
		fail(`cannot canonicalize detached checkout: ${errorMessage$5(error)}`, "IDENTITY_DRIFT");
	}
	if (canonicalCheckout !== checkoutPath) fail("detached checkout path is no longer canonical", "IDENTITY_DRIFT");
	let top;
	let commonDirectory;
	let headSha;
	let symbolicHead;
	let status;
	try {
		[top, commonDirectory, headSha, symbolicHead, status] = await Promise.all([
			git$2(checkoutPath, ["rev-parse", "--show-toplevel"]),
			canonicalGitCommonDirectory$1(checkoutPath, "IDENTITY_DRIFT"),
			git$2(checkoutPath, [
				"rev-parse",
				"--verify",
				"HEAD^{commit}"
			]),
			git$2(checkoutPath, [
				"rev-parse",
				"--abbrev-ref",
				"HEAD"
			]),
			requireClean ? git$2(checkoutPath, [
				"status",
				"--porcelain=v1",
				"--untracked-files=normal"
			]) : Promise.resolve("")
		]);
	} catch (error) {
		if (error instanceof RunCheckoutError && error.code === "GIT_FAILED") fail(`existing checkout is not inspectable as the expected worktree: ${error.message}`, "IDENTITY_DRIFT");
		throw error;
	}
	if (await canonicalExistingDirectory(top, "checkout root", "IDENTITY_DRIFT") !== checkoutPath || commonDirectory !== expectedCommonDirectory || headSha !== candidateSha || symbolicHead !== "HEAD" || requireClean && status.length !== 0) fail("detached checkout identity, HEAD, or cleanliness drifted", "IDENTITY_DRIFT");
}
async function readReceipt$2(path, allowMissing) {
	let file;
	try {
		file = await open(path, READ_REGULAR_FLAGS$2);
		if (!(await file.stat()).isFile()) fail("checkout receipt is not a regular file", "IDENTITY_DRIFT");
		const bytes = await file.readFile();
		let text;
		try {
			text = UTF8$7.decode(bytes);
		} catch {
			fail("checkout receipt is not valid UTF-8", "IDENTITY_DRIFT");
		}
		let value;
		try {
			value = JSON.parse(text);
		} catch {
			fail("checkout receipt is not valid JSON", "IDENTITY_DRIFT");
		}
		const parsed = runCheckoutReceiptSchema.safeParse(value);
		if (!parsed.success || canonicalJson$1(parsed.data) !== text) fail("checkout receipt schema or canonical bytes drifted", "IDENTITY_DRIFT");
		const { receiptHash,...withoutHash } = parsed.data;
		if (receiptHash !== hashReceipt$1(withoutHash)) fail("checkout receipt hash drifted", "IDENTITY_DRIFT");
		return parsed.data;
	} catch (error) {
		if (error instanceof RunCheckoutError) throw error;
		if (isNodeError$14(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
			if (allowMissing) return void 0;
			fail("checkout receipt is missing", "IDENTITY_DRIFT");
		}
		if (isNodeError$14(error) && error.code === "ELOOP") fail("checkout receipt is not a regular file", "IDENTITY_DRIFT");
		fail(`cannot read checkout receipt: ${errorMessage$5(error)}`, "IO_FAILED");
	} finally {
		await file?.close().catch(() => void 0);
	}
}
function assertReceiptIdentity(receipt, expected) {
	if (receipt.attemptId !== expected.attemptId || receipt.candidateSha !== expected.candidateSha || receipt.repositoryPath !== expected.repositoryPath || receipt.gitCommonDirectory !== expected.gitCommonDirectory || receipt.repositoryIdentitySha256 !== expected.repositoryIdentitySha256 || receipt.checkoutPath !== expected.checkoutPath || receipt.receiptPath !== expected.receiptPath) fail("checkout receipt does not match the requested Attempt identity", "IDENTITY_DRIFT");
}
function result(receipt, receiptBytes) {
	return Object.freeze({
		checkoutPath: receipt.checkoutPath,
		headSha: receipt.candidateSha,
		receiptPath: receipt.receiptPath,
		receiptSha256: sha256(receiptBytes),
		receipt: Object.freeze(receipt)
	});
}
async function canonicalGitCommonDirectory$1(worktreePath, code) {
	let output;
	try {
		output = await git$2(worktreePath, ["rev-parse", "--git-common-dir"]);
	} catch (error) {
		if (code === "IDENTITY_DRIFT") fail(`cannot resolve checkout Git identity: ${errorMessage$5(error)}`, code);
		throw error;
	}
	return await canonicalExistingDirectory(isAbsolute(output) ? output : resolve(worktreePath, output), "Git common directory", code);
}
async function canonicalExistingDirectory(path, label, code = "INVALID_INPUT") {
	if (!isAbsolute(path)) fail(`${label} path must be absolute`, code);
	try {
		const info = await lstat(path);
		if (!info.isDirectory() || info.isSymbolicLink()) fail(`${label} is not a real directory`, code);
		return await realpath(path);
	} catch (error) {
		if (error instanceof RunCheckoutError) throw error;
		fail(`cannot inspect ${label}: ${errorMessage$5(error)}`, code);
	}
}
async function canonicalLeafPath(path, label) {
	if (!isAbsolute(path) || resolve(path) !== path) fail(`${label} path must be normalized and absolute`, "INVALID_INPUT");
	return join(await canonicalPotentialPath$1(dirname(path), `${label} parent`), basename(path));
}
/** Resolve links in the longest existing prefix while preserving a missing suffix. */
async function canonicalPotentialPath$1(path, label) {
	if (!isAbsolute(path) || resolve(path) !== path) fail(`${label} path must be normalized and absolute`, "INVALID_INPUT");
	let cursor = path;
	const suffix = [];
	for (;;) {
		let info;
		try {
			info = await lstat(cursor);
		} catch (error) {
			if (!isNodeError$14(error) || error.code !== "ENOENT" && error.code !== "ENOTDIR") fail(`cannot inspect ${label} path: ${errorMessage$5(error)}`, "IO_FAILED");
		}
		if (info !== void 0) break;
		const parent = dirname(cursor);
		if (parent === cursor) fail(`${label} has no existing ancestor`, "INVALID_INPUT");
		suffix.unshift(basename(cursor));
		cursor = parent;
	}
	try {
		return join(await realpath(cursor), ...suffix);
	} catch (error) {
		fail(`cannot canonicalize ${label} path: ${errorMessage$5(error)}`, "IO_FAILED");
	}
}
async function git$2(cwd, args) {
	try {
		return (await execFileAsync$2("git", [
			"-C",
			cwd,
			...args
		], {
			encoding: "utf8",
			maxBuffer: 2 * 1024 * 1024,
			env: {
				...process.env,
				GIT_OPTIONAL_LOCKS: "0"
			}
		})).stdout.trim();
	} catch (error) {
		fail(`git ${args.join(" ")} failed: ${renderExecError$1(error)}`, "GIT_FAILED");
	}
}
function hashRepositoryIdentity(repositoryPath, gitCommonDirectory) {
	return sha256(`autolab-repository-identity-v1\0${canonicalJson$1({
		repositoryPath,
		gitCommonDirectory
	})}`);
}
function hashReceipt$1(value) {
	return sha256(`autolab-run-checkout-receipt-v1\0${canonicalJson$1(value)}`);
}
function validateInput$4(input) {
	if (!ATTEMPT_PATTERN.test(input.attemptId) || !GIT_COMMIT_PATTERN$1.test(input.candidateSha) || !isAbsolute(input.repositoryPath) || resolve(input.repositoryPath) !== input.repositoryPath || !isAbsolute(input.checkoutPath) || resolve(input.checkoutPath) !== input.checkoutPath || !isAbsolute(input.receiptPath) || resolve(input.receiptPath) !== input.receiptPath || input.now !== void 0 && (!Number.isSafeInteger(input.now) || input.now < 0)) fail("invalid detached run checkout input", "INVALID_INPUT");
}
function validateInspectionInput(input) {
	if (!ATTEMPT_PATTERN.test(input.attemptId) || !GIT_COMMIT_PATTERN$1.test(input.candidateSha) || !SHA256_PATTERN$15.test(input.receiptSha256) || !isAbsolute(input.repositoryPath) || resolve(input.repositoryPath) !== input.repositoryPath || !isAbsolute(input.checkoutPath) || resolve(input.checkoutPath) !== input.checkoutPath || !isAbsolute(input.receiptPath) || resolve(input.receiptPath) !== input.receiptPath) fail("invalid detached run checkout inspection input", "INVALID_INPUT");
}
function isInside$1(parent, child) {
	const path = relative(parent, child);
	return path === "" || path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}
function fail(message, code) {
	throw new RunCheckoutError(message, code);
}
function isNodeError$14(value) {
	return value instanceof Error && "code" in value;
}
function errorMessage$5(value) {
	return value instanceof Error ? value.message : String(value);
}
function renderExecError$1(value) {
	if (typeof value === "object" && value !== null && "stderr" in value) {
		const stderr = String(value.stderr).trim();
		if (stderr.length > 0) return stderr;
	}
	return errorMessage$5(value);
}

//#endregion
//#region src/trial-artifacts.ts
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
var TrialArtifactError = class extends Error {
	name = "TrialArtifactError";
	constructor(message, code) {
		super(message);
		this.code = code;
	}
};
/** Freeze one opaque Lab-authored Trial plus its minimal RunSlot contracts. */
async function freezeTrialArtifacts(runRoot, value) {
	if (!isAbsolute(runRoot) || resolve(runRoot) !== runRoot) throw new TrialArtifactError("runRoot must be normalized and absolute", "INVALID_INPUT");
	const trial = compileTrialContract(value);
	const directory = join(runRoot, "trials", sha256(trial.value.trial_id));
	const trialPath = join(directory, "trial.json");
	await freezeExact$4(trialPath, trial.canonicalJson);
	const runSlots = Object.fromEntries(await Promise.all(trial.value.run_slots.map(async (slot) => {
		const compiled = compileRunSlotContract(trial, slot.runslot_id);
		const path = join(directory, "run-slots", `${sha256(slot.runslot_id)}.json`);
		await freezeExact$4(path, compiled.canonicalJson);
		return [slot.runslot_id, Object.freeze({
			...compiled,
			path
		})];
	})));
	return Object.freeze({
		trial: Object.freeze({
			...trial,
			path: trialPath
		}),
		runSlots: Object.freeze(runSlots)
	});
}
async function freezeExact$4(path, text) {
	let observed = await readRegular$1(path, true);
	if (observed === void 0) {
		try {
			await durableWriteFile(path, text, false);
		} catch (error) {
			if (!isNodeError$13(error) || error.code !== "EEXIST") throw new TrialArtifactError(`cannot freeze Trial artifact ${path}: ${renderError$1(error)}`, "IO_FAILED");
		}
		observed = await readRegular$1(path, false);
	}
	if (observed === void 0 || observed !== text) throw new TrialArtifactError(`immutable Trial artifact conflicts at ${path}`, "ARTIFACT_CONFLICT");
}
async function readRegular$1(path, allowMissing) {
	let handle;
	try {
		handle = await open(path, READ_FLAGS);
		if (!(await handle.stat()).isFile()) throw new TrialArtifactError(`${path} is not a regular file`, "ARTIFACT_CONFLICT");
		return await handle.readFile("utf8");
	} catch (error) {
		if (error instanceof TrialArtifactError) throw error;
		if (allowMissing && isNodeError$13(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) return void 0;
		if (isNodeError$13(error) && error.code === "ELOOP") throw new TrialArtifactError(`${path} is not a regular file`, "ARTIFACT_CONFLICT");
		throw new TrialArtifactError(`cannot read Trial artifact ${path}: ${renderError$1(error)}`, "IO_FAILED");
	} finally {
		await handle?.close().catch(() => void 0);
	}
}
function isNodeError$13(value) {
	return value instanceof Error && "code" in value;
}
function renderError$1(value) {
	return value instanceof Error ? value.message : String(value);
}

//#endregion
//#region src/attempt-launch.ts
var AttemptLaunchError = class extends Error {
	name = "AttemptLaunchError";
	constructor(message, code) {
		super(message);
		this.code = code;
	}
};
/**
* Materialize one Controller-selected Trial and its first local Attempt before
* the caller publishes a short RuntimeState CAS. Scientific contracts remain
* opaque; only frozen Candidate/CURRENT/RunSlot/checkout identities are joined.
*/
async function prepareInitialLocalAttempt(input) {
	assertIdentity(input);
	const artifacts = await freezeTrialArtifacts(input.frozen.manifest.execution.run_root, {
		version: 1,
		trial_id: input.trialId,
		lane_id: input.laneId,
		candidate_sha: input.candidate.candidateSha,
		config_revision: input.frozen.ref.revision,
		contract: input.trialContract,
		run_slots: input.runSlots.map((slot) => ({
			runslot_id: slot.runSlotId,
			...slot.contract === void 0 ? {} : { contract: slot.contract }
		})),
		created_at: input.anchoredAt
	});
	const selected = artifacts.runSlots[input.selectedRunSlotId];
	if (selected === void 0) throw new AttemptLaunchError(`selected RunSlot ${JSON.stringify(input.selectedRunSlotId)} is not in the Trial`, "INVALID_INPUT");
	const pendingStates = Object.fromEntries(Object.entries(artifacts.runSlots).map(([runSlotId, runSlot]) => [runSlotId, createRunSlotState(runSlot)]));
	const intent = await freezeInitialLocalAttempt({
		frozen: input.frozen,
		trial: artifacts.trial,
		runSlot: selected,
		runSlotState: pendingStates[input.selectedRunSlotId],
		hostId: input.hostId,
		command: input.command,
		env: input.env,
		runtimePokeFile: input.runtimePokeFile,
		issuedAt: input.anchoredAt
	});
	const checkout = await provisionDetachedRunCheckout({
		repositoryPath: input.frozen.manifest.repository.path,
		checkoutPath: intent.checkoutPath,
		candidateSha: input.candidate.candidateSha,
		attemptId: intent.attempt.value.attempt_id,
		now: input.anchoredAt
	});
	const runSlots = Object.fromEntries(Object.entries(artifacts.runSlots).map(([runSlotId, runSlot]) => {
		if (runSlotId !== input.selectedRunSlotId) return [runSlotId, {
			contract: {
				path: runSlot.path,
				hash: runSlot.sha256
			},
			state: pendingStates[runSlotId]
		}];
		return [runSlotId, {
			contract: {
				path: runSlot.path,
				hash: runSlot.sha256
			},
			state: intent.transition.state,
			activeAttempt: {
				attemptId: intent.attempt.value.attempt_id,
				phase: intent.attempt.value.phase,
				path: intent.attempt.path,
				hash: intent.attempt.sha256,
				checkout: {
					path: checkout.receiptPath,
					hash: checkout.receiptSha256
				}
			}
		}];
	}));
	const projection = {
		version: 1,
		sourceRevision: input.candidate.sourceRevision,
		laneId: input.laneId,
		candidateId: input.candidate.candidateId,
		candidateSha: input.candidate.candidateSha,
		contract: {
			path: artifacts.trial.path,
			hash: artifacts.trial.sha256
		},
		runSlots
	};
	return Object.freeze({
		artifacts,
		intent,
		checkout,
		projection
	});
}
/**
* Materialize one Controller-selected technical retry before its short CAS.
* The prior terminal Attempt is read only through its exact active reference;
* Trial/RunSlot/Candidate lineage is preserved and scientific content is not read.
*/
async function prepareRetryLocalAttempt(input) {
	const trial = activeTrialSchema.parse(input.trial);
	const slot = assertRetryProjection(input, trial);
	const active = slot.activeAttempt;
	const previous = await readLocalAttemptIntent({
		runRoot: input.frozen.manifest.execution.run_root,
		activeAttempt: {
			path: active.path,
			hash: active.hash
		}
	});
	assertRetryAttemptIdentity(input, trial, previous);
	const intent = await freezeRetryLocalAttempt({
		frozen: input.frozen,
		previous,
		runSlotState: slot.state,
		hostId: input.hostId,
		command: input.command,
		env: input.env,
		runtimePokeFile: input.runtimePokeFile
	});
	const checkout = await provisionDetachedRunCheckout({
		repositoryPath: input.frozen.manifest.repository.path,
		checkoutPath: intent.checkoutPath,
		candidateSha: trial.candidateSha,
		attemptId: intent.attempt.value.attempt_id,
		now: intent.request.value.issued_at
	});
	const projection = activeTrialSchema.parse({
		...trial,
		runSlots: {
			...trial.runSlots,
			[input.runSlotId]: {
				...slot,
				state: intent.transition.state,
				activeAttempt: {
					attemptId: intent.attempt.value.attempt_id,
					phase: intent.attempt.value.phase,
					path: intent.attempt.path,
					hash: intent.attempt.sha256,
					checkout: {
						path: checkout.receiptPath,
						hash: checkout.receiptSha256
					}
				}
			}
		}
	});
	return Object.freeze({
		previous,
		intent,
		checkout,
		projection
	});
}
/**
* Verify that an already-active projection is the exact retry requested by
* this Controller call. This is an adopt/inspect boundary only: no process is
* launched here and no experiment artifact is opened.
*/
async function verifyRetryLocalAttemptReplay(input) {
	const trial = activeTrialSchema.parse(input.trial);
	const slot = trial.runSlots[input.runSlotId];
	const active = slot?.activeAttempt;
	const lane = input.frozen.manifest.lanes.find((candidate) => candidate.lane_id === trial.laneId);
	if (trial.sourceRevision > input.frozen.ref.revision || lane === void 0 || slot === void 0 || slot.state.status !== "attempt_active" && slot.state.status !== "outcome_unknown" || slot.state.trial_id !== input.trialId || active === void 0) throw new AttemptLaunchError("CURRENT, Trial, RunSlot, and active retry projection do not identify the same work", "IDENTITY_MISMATCH");
	const replay = await readLocalAttemptIntent({
		runRoot: input.frozen.manifest.execution.run_root,
		activeAttempt: {
			path: active.path,
			hash: active.hash
		}
	});
	const attempt = replay.attempt.value;
	const request = replay.request.value;
	if (attempt.attempt_ordinal <= 1 || attempt.predecessor_attempt_id === void 0 || attempt.attempt_id !== active.attemptId || attempt.trial_id !== input.trialId || attempt.runslot_id !== input.runSlotId || attempt.trial_contract_sha256 !== trial.contract.hash || attempt.runslot_contract_sha256 !== slot.contract.hash || attempt.candidate_sha !== trial.candidateSha || attempt.config_revision !== input.frozen.ref.revision || request.lab_id !== input.frozen.manifest.lab_id || request.config_revision !== input.frozen.ref.revision || request.host_id !== input.hostId || canonicalJson$1(request.command) !== canonicalJson$1(input.command) || canonicalJson$1(request.env) !== canonicalJson$1(input.env)) throw new AttemptLaunchError("Active Attempt is not the exact host, argv, environment, and retry lineage requested", "IDENTITY_MISMATCH");
	return replay;
}
function assertIdentity(input) {
	const lane = input.frozen.manifest.lanes.find((candidate) => candidate.lane_id === input.laneId);
	if (input.candidate.laneId !== input.laneId || input.candidate.sourceRevision > input.frozen.ref.revision || lane === void 0 || lane.coder_role_id !== input.candidate.coderRoleId) throw new AttemptLaunchError("Candidate, Lane, and CURRENT revision do not identify the same work", "IDENTITY_MISMATCH");
	if (input.trialId.length === 0 || input.selectedRunSlotId.length === 0 || input.runSlots.length === 0 || !Number.isSafeInteger(input.anchoredAt) || input.anchoredAt < input.candidate.frozenAt) throw new AttemptLaunchError("Trial launch input is incomplete or unstable", "INVALID_INPUT");
}
function assertRetryProjection(input, trial) {
	const slot = trial.runSlots[input.runSlotId];
	const lane = input.frozen.manifest.lanes.find((candidate) => candidate.lane_id === trial.laneId);
	if (trial.sourceRevision > input.frozen.ref.revision || lane === void 0 || slot === void 0 || slot.state.status !== "retryable" || slot.state.trial_id !== input.trialId || slot.activeAttempt?.phase !== "terminal") throw new AttemptLaunchError("CURRENT, Trial, RunSlot, and terminal retry projection do not identify the same work", "IDENTITY_MISMATCH");
	if (input.trialId.length === 0 || input.runSlotId.length === 0) throw new AttemptLaunchError("Technical retry input is incomplete or unstable", "INVALID_INPUT");
	return slot;
}
function assertRetryAttemptIdentity(input, trial, previous) {
	const slot = trial.runSlots[input.runSlotId];
	const active = slot.activeAttempt;
	const attempt = previous.attempt.value;
	const request = previous.request.value;
	if (attempt.phase !== "terminal" || attempt.technical_outcome !== "failed" || attempt.attempt_id !== active.attemptId || attempt.trial_id !== input.trialId || attempt.runslot_id !== input.runSlotId || attempt.trial_contract_sha256 !== trial.contract.hash || attempt.runslot_contract_sha256 !== slot.contract.hash || attempt.candidate_sha !== trial.candidateSha || attempt.config_revision !== input.frozen.ref.revision || request.lab_id !== input.frozen.manifest.lab_id || request.config_revision !== input.frozen.ref.revision) throw new AttemptLaunchError("Failed Attempt does not match the exact CURRENT Trial and RunSlot lineage", "IDENTITY_MISMATCH");
}

//#endregion
//#region src/binding.ts
const SHA256 = /^[0-9a-f]{64}$/u;
const receiptSchema = z.object({
	version: z.literal(1),
	labId: z.string().min(1),
	manifestHash: z.string().regex(SHA256),
	roleId: z.string().min(1),
	roleKind: z.enum([
		"method",
		"coder",
		"preflight_judge",
		"postflight_judge",
		"ops",
		"coordinator"
	]),
	sessionId: z.string().min(1),
	agentPresetId: z.string().min(1),
	permissionPresetId: z.enum([
		"read-only",
		"workspace-write",
		"danger-full-access"
	]),
	provider: z.string().min(1),
	model: z.string().min(1),
	cwd: z.string().min(1).refine(isAbsolute, "cwd must be absolute"),
	runtimeRevision: z.number().int().nonnegative(),
	issuedAt: z.number().int().nonnegative(),
	receiptHash: z.string().regex(SHA256)
}).strict();
var RoleBindingError = class extends Error {
	name = "RoleBindingError";
	constructor(message, code) {
		super(message);
		this.code = code;
	}
};
/** Freeze one exact role-to-Session binding before that Session is published. */
async function freezeRoleBinding(input) {
	if (!isAbsolute(input.labDirectory)) throw new RoleBindingError("Lab directory must be absolute", "INVALID_BINDING");
	const path = roleBindingPath(input.labDirectory, input.roleId);
	const existing = await readBinding(path);
	const committedManifestHashes = await listCommittedManifestHashes(input.labDirectory);
	if (existing !== void 0) return assertSameBinding(existing, path, input, committedManifestHashes);
	const withoutHash = {
		version: 1,
		labId: input.labId,
		manifestHash: input.manifestHash,
		roleId: input.roleId,
		roleKind: input.roleKind,
		sessionId: input.sessionId,
		agentPresetId: input.agentPresetId,
		permissionPresetId: input.permissionPresetId,
		provider: input.provider,
		model: input.model,
		cwd: input.cwd,
		runtimeRevision: input.runtimeRevision,
		issuedAt: input.issuedAt
	};
	const receipt = {
		...withoutHash,
		receiptHash: sha256(`autolab-role-binding-v1\0${canonicalJson$1(withoutHash)}`)
	};
	try {
		await durableWriteFile(path, `${JSON.stringify(receipt, null, 2)}\n`, false);
	} catch (error) {
		if (!isNodeError$12(error) || error.code !== "EEXIST") throw error;
	}
	const committed = await readBinding(path);
	if (committed === void 0) throw new RoleBindingError("Role binding was not committed", "BINDING_CORRUPT");
	return assertSameBinding(committed, path, input, committedManifestHashes);
}
async function readRoleBinding(labDirectory, roleId) {
	return await readBinding(roleBindingPath(labDirectory, roleId));
}
function roleBindingPath(labDirectory, roleId) {
	return join(labDirectory, "receipts", "roles", `${sha256(roleId)}.json`);
}
async function readBinding(path) {
	const text = await readFile(path, "utf8").catch((error) => {
		if (isNodeError$12(error) && error.code === "ENOENT") return void 0;
		throw error;
	});
	if (text === void 0) return void 0;
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new RoleBindingError("Role binding is malformed JSON", "BINDING_CORRUPT");
	}
	const result$1 = receiptSchema.safeParse(parsed);
	if (!result$1.success) throw new RoleBindingError(`Role binding schema is invalid: ${result$1.error.message}`, "BINDING_CORRUPT");
	const { receiptHash,...withoutHash } = result$1.data;
	if (receiptHash !== sha256(`autolab-role-binding-v1\0${canonicalJson$1(withoutHash)}`)) throw new RoleBindingError("Role binding hash is invalid", "BINDING_CORRUPT");
	return {
		path,
		hash: receiptHash,
		receipt: result$1.data
	};
}
function assertSameBinding(stored, path, input, committedManifestHashes) {
	const receipt = stored.receipt;
	const manifestHashAuthorized = receipt.manifestHash === input.manifestHash || committedManifestHashes.has(receipt.manifestHash);
	if (receipt.labId !== input.labId || !manifestHashAuthorized || receipt.roleId !== input.roleId || receipt.roleKind !== input.roleKind || receipt.sessionId !== input.sessionId || receipt.agentPresetId !== input.agentPresetId || receipt.permissionPresetId !== input.permissionPresetId || receipt.provider !== input.provider || receipt.model !== input.model || receipt.cwd !== input.cwd) throw new RoleBindingError(`Role ${JSON.stringify(input.roleId)} already has another frozen binding`, "BINDING_CONFLICT");
	return {
		...stored,
		path
	};
}
function isNodeError$12(value) {
	return value instanceof Error && "code" in value;
}

//#endregion
//#region src/coder-receipt.ts
const SHA256_PATTERN$14 = /^[0-9a-f]{64}$/u;
const GIT_COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const UTF8$6 = new TextDecoder("utf-8", {
	fatal: true,
	ignoreBOM: true
});
const READ_REGULAR_FLAGS$1 = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const identifier = z.string().min(1).refine((value) => value.trim().length > 0, "must not be blank");
const hash$1 = z.string().regex(SHA256_PATTERN$14);
const gitCommit = z.string().regex(GIT_COMMIT_PATTERN);
const absolutePath$2 = z.string().min(1).refine(isAbsolute, "path must be absolute");
const artifactReferenceSchema = z.object({
	path: absolutePath$2,
	sha256: hash$1
}).strict();
const expectedCoderImplementationAnchorsSchema = z.object({
	labId: identifier,
	sourceRevision: z.number().int().positive(),
	laneId: identifier,
	coderRoleId: identifier,
	coderSessionId: identifier,
	assignmentId: identifier,
	assignmentContractSha256: hash$1,
	rolePacket: artifactReferenceSchema,
	designTicket: artifactReferenceSchema.extend({ candidateId: identifier }).strict(),
	preflightVerdict: artifactReferenceSchema.extend({ reviewId: identifier }).strict(),
	sourceWorktree: z.object({
		path: absolutePath$2,
		receiptPath: absolutePath$2,
		receiptSha256: hash$1
	}).strict(),
	candidateSha: gitCommit
}).strict();
/** The complete model-facing contract. `content` is opaque JSON to Runtime. */
const coderImplementationReportSchema = z.object({
	schema_version: z.literal(1),
	content: z.json()
}).strict();
/** Runtime-authored receipt containing only mechanical identity bindings. */
const coderImplementationReceiptSchema = z.object({
	schema_version: z.literal(1),
	lab_id: identifier,
	source_revision: z.number().int().positive(),
	lane_id: identifier,
	coder: z.object({
		role_id: identifier,
		session_id: identifier
	}).strict(),
	assignment: z.object({
		assignment_id: identifier,
		assignment_contract_sha256: hash$1
	}).strict(),
	role_packet: artifactReferenceSchema,
	design_ticket: artifactReferenceSchema.extend({ candidate_id: identifier }).strict(),
	preflight_verdict: artifactReferenceSchema.extend({ review_id: identifier }).strict(),
	source_worktree: z.object({
		path: absolutePath$2,
		receipt_path: absolutePath$2,
		receipt_sha256: hash$1
	}).strict(),
	candidate_sha: gitCommit,
	source_report: artifactReferenceSchema
}).strict();
/** JSON Schema for the Runtime-authored immutable receipt. */
function coderImplementationReceiptOutputSchema() {
	return z.toJSONSchema(coderImplementationReceiptSchema);
}
/** JSON Schema installed as the Coder's model-facing output contract. */
function coderImplementationReportOutputSchema() {
	return z.toJSONSchema(coderImplementationReportSchema);
}
var CoderReceiptError = class extends Error {
	name = "CoderReceiptError";
	constructor(message, code, issues = []) {
		super(message);
		this.code = code;
		this.issues = issues;
	}
};
function parseCoderImplementationReceipt(value) {
	const parsed = coderImplementationReceiptSchema.safeParse(value);
	if (!parsed.success) throw new CoderReceiptError(`Coder implementation receipt is invalid: ${formatIssues$4(parsed.error.issues)}`, "INVALID_RECEIPT", parsed.error.issues);
	return parsed.data;
}
function parseCoderImplementationReport(value) {
	const parsed = coderImplementationReportSchema.safeParse(value);
	if (!parsed.success) throw new CoderReceiptError(`Coder implementation report is invalid: ${formatIssues$4(parsed.error.issues)}`, "INVALID_RECEIPT", parsed.error.issues);
	return parsed.data;
}
async function readCoderImplementationReport(path) {
	const absolute = validateAbsolutePath(path, "Coder implementation report path");
	const bytes = await readBytes$3(absolute, "Coder implementation report", "RECEIPT_READ_FAILED");
	let value;
	try {
		value = JSON.parse(UTF8$6.decode(bytes));
	} catch (error) {
		throw new CoderReceiptError(`Coder implementation report is not valid UTF-8 JSON: ${errorMessage$4(error)}`, "INVALID_RECEIPT");
	}
	return {
		path: absolute,
		sha256: sha256(bytes),
		bytes,
		report: parseCoderImplementationReport(value)
	};
}
/** Combine trusted anchors with only the opaque report's exact path/hash. */
function compileCoderImplementationReceipt(input) {
	const expected = parseExpectedAnchors(input.expected);
	const sourceReport = parseArtifactReference(input.sourceReport, "source report");
	return parseCoderImplementationReceipt({
		schema_version: 1,
		lab_id: expected.labId,
		source_revision: expected.sourceRevision,
		lane_id: expected.laneId,
		coder: {
			role_id: expected.coderRoleId,
			session_id: expected.coderSessionId
		},
		assignment: {
			assignment_id: expected.assignmentId,
			assignment_contract_sha256: expected.assignmentContractSha256
		},
		role_packet: expected.rolePacket,
		design_ticket: {
			path: expected.designTicket.path,
			sha256: expected.designTicket.sha256,
			candidate_id: expected.designTicket.candidateId
		},
		preflight_verdict: {
			path: expected.preflightVerdict.path,
			sha256: expected.preflightVerdict.sha256,
			review_id: expected.preflightVerdict.reviewId
		},
		source_worktree: {
			path: expected.sourceWorktree.path,
			receipt_path: expected.sourceWorktree.receiptPath,
			receipt_sha256: expected.sourceWorktree.receiptSha256
		},
		candidate_sha: expected.candidateSha,
		source_report: sourceReport
	});
}
/**
* Preserve exact valid Runtime-receipt bytes at one immutable destination.
* Exact replay adopts the existing file; different bytes never overwrite it.
* No referenced report or experiment file is opened by this path.
*/
async function freezeCoderImplementationReceipt(input) {
	const sourceReceiptPath = validateAbsolutePath(input.sourceReceiptPath, "source receipt path");
	const artifactPath = validateAbsolutePath(input.artifactPath, "artifact path");
	if (sourceReceiptPath === artifactPath) throw new CoderReceiptError("immutable artifact must be distinct from the mutable Runtime receipt", "INVALID_INPUT");
	const receiptBytes = await readBytes$3(sourceReceiptPath, "Coder receipt", "RECEIPT_READ_FAILED");
	const receipt = parseReceiptBytes$1(receiptBytes);
	assertExpectedAnchors(receipt, input.expected, input.sourceReport);
	const committed = await freezeReceiptBytes(artifactPath, receiptBytes);
	return {
		sourceReceiptPath,
		artifactPath,
		artifactHash: sha256(committed),
		receiptBytes: committed,
		receipt
	};
}
/**
* Preferred Runtime path: validate only the report's two-field envelope, bind
* its exact path/hash to trusted identities, and publish a canonical receipt.
* `report.content` is never interpreted and no path inside it is accessed.
*/
async function freezeCompiledCoderImplementationReceipt(input) {
	const report = await readCoderImplementationReport(input.sourceReportPath);
	validateHash$1(input.sourceReportSha256, "Coder implementation report SHA-256");
	if (report.sha256 !== input.sourceReportSha256) throw new CoderReceiptError("Coder implementation report changed while freezing the candidate", "HASH_MISMATCH");
	const artifactPath = validateAbsolutePath(input.artifactPath, "artifact path");
	if (report.path === artifactPath) throw new CoderReceiptError("immutable artifact must be distinct from the mutable Coder report", "INVALID_INPUT");
	const receipt = compileCoderImplementationReceipt({
		expected: input.expected,
		sourceReport: {
			path: report.path,
			sha256: report.sha256
		}
	});
	const committed = await freezeReceiptBytes(artifactPath, Buffer.from(canonicalJson$1(receipt), "utf8"));
	return {
		sourceReceiptPath: report.path,
		artifactPath,
		artifactHash: sha256(committed),
		receiptBytes: committed,
		receipt
	};
}
/** Read one exact immutable receipt through its path and SHA-256 reference. */
async function readCoderImplementationReceipt(reference) {
	const parsedReference = parseArtifactReference(reference, "immutable Coder receipt");
	const receiptBytes = await readBytes$3(parsedReference.path, "immutable Coder receipt", "ARTIFACT_CONFLICT");
	const artifactHash = sha256(receiptBytes);
	if (artifactHash !== parsedReference.sha256) throw new CoderReceiptError(`Immutable Coder receipt SHA-256 mismatch at ${parsedReference.path}`, "HASH_MISMATCH");
	return {
		sourceReceiptPath: parsedReference.path,
		artifactPath: parsedReference.path,
		artifactHash,
		receiptBytes,
		receipt: parseReceiptBytes$1(receiptBytes)
	};
}
function parseReceiptBytes$1(bytes) {
	let value;
	try {
		value = JSON.parse(UTF8$6.decode(bytes));
	} catch (error) {
		throw new CoderReceiptError(`Coder receipt is not valid UTF-8 JSON: ${errorMessage$4(error)}`, "INVALID_RECEIPT");
	}
	return parseCoderImplementationReceipt(value);
}
function parseExpectedAnchors(expected) {
	const parsed = expectedCoderImplementationAnchorsSchema.safeParse(expected);
	if (!parsed.success) throw new CoderReceiptError(`Expected Coder receipt anchors are invalid: ${formatIssues$4(parsed.error.issues)}`, "INVALID_INPUT", parsed.error.issues);
	return parsed.data;
}
function parseArtifactReference(reference, label) {
	const parsed = artifactReferenceSchema.safeParse(reference);
	if (!parsed.success) throw new CoderReceiptError(`${label} reference is invalid: ${formatIssues$4(parsed.error.issues)}`, "INVALID_INPUT", parsed.error.issues);
	return {
		path: resolve(parsed.data.path),
		sha256: parsed.data.sha256
	};
}
function assertExpectedAnchors(receipt, expected, sourceReport) {
	const expectedReceipt = compileCoderImplementationReceipt({
		expected,
		sourceReport
	});
	if (canonicalJson$1(receipt) !== canonicalJson$1(expectedReceipt)) throw new CoderReceiptError("Coder implementation receipt does not match the expected mechanical identities", "ANCHOR_MISMATCH");
}
async function freezeReceiptBytes(path, receiptBytes) {
	try {
		await durableWriteFile(path, receiptBytes, false);
	} catch (error) {
		if (!isNodeError$11(error) || error.code !== "EEXIST") throw new CoderReceiptError(`Cannot write immutable Coder receipt at ${path}: ${errorMessage$4(error)}`, "ARTIFACT_WRITE_FAILED");
	}
	const committed = await readBytes$3(path, "immutable Coder receipt", "ARTIFACT_CONFLICT");
	if (!committed.equals(receiptBytes)) throw new CoderReceiptError(`Immutable Coder receipt conflicts at ${path}`, "ARTIFACT_CONFLICT");
	return committed;
}
async function readBytes$3(path, label, code) {
	let file;
	try {
		file = await open(path, READ_REGULAR_FLAGS$1);
		if (!(await file.stat()).isFile()) throw new CoderReceiptError(`${label} is not a regular file at ${path}`, code);
		return await file.readFile();
	} catch (error) {
		if (error instanceof CoderReceiptError) throw error;
		if (isNodeError$11(error) && (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "ELOOP")) throw new CoderReceiptError(`${label} is missing or not a regular file at ${path}`, code);
		throw new CoderReceiptError(`${label} I/O failed at ${path}: ${errorMessage$4(error)}`, "IO_FAILED");
	} finally {
		await file?.close().catch(() => void 0);
	}
}
function validateAbsolutePath(value, label) {
	if (typeof value !== "string" || !isAbsolute(value)) throw new CoderReceiptError(`${label} must be absolute`, "INVALID_INPUT");
	return resolve(value);
}
function validateHash$1(value, label) {
	if (typeof value !== "string" || !SHA256_PATTERN$14.test(value)) throw new CoderReceiptError(`${label} must be a SHA-256 hash`, "INVALID_INPUT");
}
function formatIssues$4(issues) {
	return issues.map((issue$1) => {
		return `${issue$1.path.length === 0 ? "<root>" : issue$1.path.join(".")}: ${issue$1.message}`;
	}).join("; ");
}
function isNodeError$11(value) {
	return value instanceof Error && "code" in value;
}
function errorMessage$4(value) {
	return value instanceof Error ? value.message : String(value);
}

//#endregion
//#region src/fact-registry.ts
/**
* Lab fact set registry.
*
* The fact set file lives at `manifest.authority_paths.fact_set` and is frozen
* to the empty v1 set at initial role activation. Facts are additive,
* immutable, canonical-JSON records with explicit source and evidence status:
* they are the landing point for user decisions that override or refine frozen
* LAB_SPEC text (LAB_SPEC §0 grants the user final authority; a registered
* fact makes that decision visible in the anchored record chain Judges read).
*
* Every packet compiled AFTER a registration anchors the CURRENT fact set
* bytes; historical packets keep their historical anchors and still reproduce
* exactly from their stored anchors.
*/
const factSchema = z.object({
	fact_id: z.string().min(1),
	kind: z.string().min(1),
	statement: z.string().min(1),
	source: z.string().min(1),
	evidence_status: z.string().min(1),
	registered_by: z.string().min(1),
	registered_at: z.number().int().nonnegative()
}).strict();
const factSetSchema = z.object({
	version: z.literal(1),
	facts: z.array(factSchema)
}).strict();
const EMPTY_FACT_SET$1 = canonicalJson$1({
	version: 1,
	facts: []
});
var FactRegistryError = class extends Error {
	name = "FactRegistryError";
	constructor(message, code) {
		super(message);
		this.code = code;
	}
};
function decodeUtf8(bytes) {
	return new TextDecoder().decode(bytes);
}
async function readBytesIfPresent(factPath) {
	try {
		return await readFile(factPath);
	} catch (error) {
		if (error.code === "ENOENT") return void 0;
		throw error;
	}
}
/** Read and strictly validate the current fact set; a missing file is the empty set. */
async function readFactSet(factPath) {
	const bytes = await readBytesIfPresent(factPath);
	if (bytes === void 0) return {
		version: 1,
		facts: []
	};
	const text = decodeUtf8(bytes);
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		throw new FactRegistryError(`Fact set at ${factPath} is not JSON`, "INVALID_FACT_SET");
	}
	if (canonicalJson$1(value) !== text) throw new FactRegistryError(`Fact set at ${factPath} is not canonical JSON`, "INVALID_FACT_SET");
	const parsed = factSetSchema.safeParse(value);
	if (!parsed.success) throw new FactRegistryError(`Fact set at ${factPath} is not a valid v1 Fact Set`, "INVALID_FACT_SET");
	return parsed.data;
}
/**
* Anchor for a packet compiled NOW: the sha256 of the current fact set bytes
* plus a fact-set reference when at least one fact is registered, so Judges
* see the registered directives in the packet's runtime snapshot.
*/
async function currentFactAnchor(factPath) {
	const bytes = await readBytesIfPresent(factPath);
	const text = bytes === void 0 ? EMPTY_FACT_SET$1 : decodeUtf8(bytes);
	const factSet = factSetSchema.parse(JSON.parse(text));
	const factSetSha256 = sha256(text);
	return {
		factSetSha256,
		relevantFactRefs: factSet.facts.length === 0 ? [] : [{
			id: "fact-set",
			sha256: factSetSha256
		}]
	};
}
/** Append one immutable fact to the fact set and return the new anchor result. */
async function registerFact(input) {
	if (!isAbsolute(input.factPath)) throw new FactRegistryError("factPath must be absolute", "INVALID_INPUT");
	if (input.factId.trim().length === 0 || input.kind.trim().length === 0 || input.statement.trim().length === 0 || input.source.trim().length === 0 || input.evidenceStatus.trim().length === 0 || input.registeredBy.trim().length === 0) throw new FactRegistryError("fact fields must be non-empty", "INVALID_INPUT");
	const fact = factSchema.parse({
		fact_id: input.factId,
		kind: input.kind,
		statement: input.statement,
		source: input.source,
		evidence_status: input.evidenceStatus,
		registered_by: input.registeredBy,
		registered_at: input.registeredAt
	});
	const current = await readFactSet(input.factPath);
	if (current.facts.some((existing) => existing.fact_id === fact.fact_id)) throw new FactRegistryError(`Fact ${fact.fact_id} is already registered`, "FACT_CONFLICT");
	const text = canonicalJson$1({
		version: 1,
		facts: [...current.facts, fact]
	});
	await durableWriteFile(input.factPath, text, true);
	return {
		factPath: input.factPath,
		factSetSha256: sha256(text),
		factIndex: current.facts.length,
		fact
	};
}

//#endregion
//#region src/packet.ts
const SHA256_PATTERN$13 = /^[0-9a-f]{64}$/u;
const idSchema = z.string().min(1);
const hashSchema = z.string().regex(SHA256_PATTERN$13);
const absolutePathSchema = z.string().min(1).refine(isAbsolute, "path must be absolute");
const verbatimBlockSchema = z.object({
	block_id: idSchema,
	source_path: absolutePathSchema,
	exact_text: z.string(),
	text_sha256: hashSchema,
	byte_range: z.object({
		start: z.number().int().nonnegative(),
		end: z.number().int().nonnegative()
	}).strict().optional()
}).strict().superRefine((block, context) => {
	if (block.text_sha256 !== sha256(block.exact_text)) context.addIssue({
		code: "custom",
		path: ["text_sha256"],
		message: "text_sha256 does not match exact_text bytes"
	});
	if (block.byte_range !== void 0 && block.byte_range.end < block.byte_range.start) context.addIssue({
		code: "custom",
		path: ["byte_range", "end"],
		message: "byte range end precedes start"
	});
});
const verbatimBlocksSchema = z.object({
	universal: z.array(verbatimBlockSchema).min(1),
	role: z.array(verbatimBlockSchema).min(1),
	lane: z.array(verbatimBlockSchema),
	stage: z.array(verbatimBlockSchema),
	assignment: z.array(verbatimBlockSchema).min(1)
}).strict();
const hashedRefSchema = z.object({
	id: idSchema,
	sha256: hashSchema
}).strict();
const artifactRefSchema = z.object({
	artifact_id: idSchema,
	path: absolutePathSchema,
	sha256: hashSchema
}).strict();
const incumbentSchema = z.object({
	ref: idSchema,
	sha256: hashSchema
}).strict();
const outputContractSchema = z.object({
	schema: z.json(),
	receipt_path: absolutePathSchema,
	expected_hash_binding: idSchema
}).strict();
const compileInputSchema = z.object({
	manifest: resolvedManifestSchema,
	role_id: idSchema,
	session_id: idSchema,
	assignment_id: idSchema,
	issued_at: z.number().int().nonnegative(),
	role_binding_receipt_sha256: hashSchema,
	runtime_revision: z.number().int().nonnegative(),
	fact_set_sha256: hashSchema,
	evidence_index_sha256: hashSchema,
	assignment_contract_sha256: hashSchema,
	reveal_state: z.enum(["sealed", "revealed"]),
	verbatim_blocks: verbatimBlocksSchema,
	incumbent: incumbentSchema.optional(),
	relevant_fact_refs: z.array(hashedRefSchema),
	evidence_refs: z.array(hashedRefSchema),
	open_obligation_refs: z.array(idSchema),
	input_artifact_refs: z.array(artifactRefSchema),
	output_contract: outputContractSchema
}).strict();
const packetPairBlockSchema = z.object({
	other_role_id: idSchema,
	active_when: z.enum([
		"before_reveal",
		"after_reveal",
		"always"
	])
}).strict();
const rolePacketSchema = z.object({
	header: z.object({
		packet_schema_version: z.literal(1),
		lab_id: idSchema,
		lane_id: idSchema.nullable(),
		role_id: idSchema,
		role_kind: z.enum([
			"controller",
			"method",
			"coder",
			"preflight_judge",
			"postflight_judge",
			"ops",
			"coordinator"
		]),
		session_id: idSchema,
		assignment_id: idSchema,
		issued_at: z.number().int().nonnegative()
	}).strict(),
	anchors: z.object({
		source_revision: z.number().int().positive(),
		dialogue_head_sha256: hashSchema,
		lab_spec_sha256: hashSchema,
		lab_yaml_sha256: hashSchema,
		resolved_manifest_sha256: hashSchema,
		campaign_contract_sha256: hashSchema,
		role_binding_receipt_sha256: hashSchema,
		runtime_revision: z.number().int().nonnegative(),
		fact_set_sha256: hashSchema,
		evidence_index_sha256: hashSchema,
		assignment_contract_sha256: hashSchema
	}).strict(),
	authority_paths: z.object({
		lab_dir: absolutePathSchema,
		creation_log: absolutePathSchema,
		lab_spec: absolutePathSchema,
		lab_yaml: absolutePathSchema,
		resolved_manifest: absolutePathSchema,
		fact_set: absolutePathSchema,
		evidence_index: absolutePathSchema,
		assignment_root: absolutePathSchema,
		worktree_root: absolutePathSchema,
		repository: absolutePathSchema,
		artifact_root: absolutePathSchema,
		run_root: absolutePathSchema
	}).strict(),
	role_binding: z.object({
		prompt_sha256: hashSchema,
		lane_charter_sha256: hashSchema.nullable(),
		model_route: z.object({
			route_id: idSchema,
			provider: idSchema,
			model: idSchema,
			config: z.record(z.string(), z.json())
		}).strict(),
		fallback_routes: z.array(z.object({
			route_id: idSchema,
			provider: idSchema,
			model: idSchema,
			config: z.record(z.string(), z.json())
		}).strict()),
		reasoning: z.object({
			mode: idSchema,
			config: z.record(z.string(), z.json())
		}).strict()
	}).strict(),
	verbatim_blocks: verbatimBlocksSchema,
	runtime_snapshot: z.object({
		reveal_state: z.enum(["sealed", "revealed"]),
		incumbent: incumbentSchema.optional(),
		relevant_fact_refs: z.array(hashedRefSchema),
		evidence_refs: z.array(hashedRefSchema),
		open_obligation_refs: z.array(idSchema),
		input_artifact_refs: z.array(artifactRefSchema)
	}).strict(),
	capability_scope: z.object({
		tools: z.array(idSchema),
		worktree: absolutePathSchema.nullable(),
		dsh_preset_ref: z.enum([
			"read-only",
			"workspace-write",
			"danger-full-access"
		]),
		communication: z.object({
			acl_revision: z.number().int().nonnegative(),
			topology: z.enum(["lane_isolated", "coordinated"]),
			controller_visibility: z.literal("global"),
			send: z.boolean(),
			receive: z.boolean(),
			text_method_coder_within_lane: z.enum(["allowed", "blocked"]),
			text_cross_lane_before_reveal: z.enum(["blocked", "allowed"]),
			text_cross_lane_after_reveal: z.enum(["blocked", "allowed"]),
			reveal_trigger: z.enum([
				"manual",
				"cohort_barrier",
				"immediate"
			]),
			text_pair_blocks: z.array(packetPairBlockSchema)
		}).strict()
	}).strict(),
	output_contract: outputContractSchema
}).strict();
var PacketValidationError = class extends Error {
	name = "PacketValidationError";
	code = "INVALID_PACKET";
	constructor(message, issues = []) {
		super(message);
		this.issues = issues;
	}
};
function compileRolePacket(value) {
	const parsed = compileInputSchema.safeParse(value);
	if (!parsed.success) throw new PacketValidationError(formatIssues$3(parsed.error.issues), parsed.error.issues);
	const input = parsed.data;
	const role = input.manifest.roles.find((candidate) => candidate.role_id === input.role_id);
	if (role === void 0) throw new PacketValidationError(`unknown role ${input.role_id}`);
	if (role.prebound_session_id !== void 0 && role.prebound_session_id !== input.session_id) throw new PacketValidationError(`role ${role.role_id} is prebound to SessionId ${role.prebound_session_id}, not ${input.session_id}`);
	validateBlocks(input.verbatim_blocks, role, input.manifest);
	const permission = input.manifest.communication.role_permissions.find((candidate) => candidate.role_id === role.role_id);
	if (permission === void 0) throw new PacketValidationError(`manifest has no communication permission for ${role.role_id}`);
	const packet = {
		header: {
			packet_schema_version: 1,
			lab_id: input.manifest.lab_id,
			lane_id: laneId$1(role),
			role_id: role.role_id,
			role_kind: role.role_kind,
			session_id: input.session_id,
			assignment_id: input.assignment_id,
			issued_at: input.issued_at
		},
		anchors: {
			source_revision: input.manifest.source_revision,
			dialogue_head_sha256: input.manifest.anchors.dialogue_head_sha256,
			lab_spec_sha256: input.manifest.anchors.lab_spec_sha256,
			lab_yaml_sha256: input.manifest.anchors.lab_yaml_sha256,
			resolved_manifest_sha256: sha256(canonicalJson$1(input.manifest)),
			campaign_contract_sha256: input.manifest.campaign_contract_sha256,
			role_binding_receipt_sha256: input.role_binding_receipt_sha256,
			runtime_revision: input.runtime_revision,
			fact_set_sha256: input.fact_set_sha256,
			evidence_index_sha256: input.evidence_index_sha256,
			assignment_contract_sha256: input.assignment_contract_sha256
		},
		authority_paths: {
			...input.manifest.authority_paths,
			repository: input.manifest.repository.path,
			artifact_root: input.manifest.evidence.artifact_root,
			run_root: input.manifest.execution.run_root
		},
		role_binding: {
			prompt_sha256: role.prompt_sha256,
			lane_charter_sha256: roleLaneCharterHash(input.manifest, role),
			model_route: role.model_route,
			fallback_routes: role.fallback_routes,
			reasoning: role.reasoning
		},
		verbatim_blocks: input.verbatim_blocks,
		runtime_snapshot: {
			...input.incumbent === void 0 ? {} : { incumbent: input.incumbent },
			reveal_state: input.reveal_state,
			relevant_fact_refs: input.relevant_fact_refs,
			evidence_refs: input.evidence_refs,
			open_obligation_refs: input.open_obligation_refs,
			input_artifact_refs: input.input_artifact_refs
		},
		capability_scope: {
			tools: role.allowed_tools,
			worktree: roleWorktree$1(role),
			dsh_preset_ref: role.dsh_preset,
			communication: {
				acl_revision: input.manifest.communication.acl_revision,
				topology: input.manifest.communication.topology,
				controller_visibility: input.manifest.communication.controller_visibility,
				send: permission.send,
				receive: permission.receive,
				text_method_coder_within_lane: input.manifest.communication.text_method_coder_within_lane,
				text_cross_lane_before_reveal: input.manifest.communication.reveal_policy.text_cross_lane_before_reveal,
				text_cross_lane_after_reveal: input.manifest.communication.reveal_policy.text_cross_lane_after_reveal,
				reveal_trigger: input.manifest.communication.reveal_policy.trigger,
				text_pair_blocks: relevantPairBlocks(input.manifest, role.role_id)
			}
		},
		output_contract: input.output_contract
	};
	const encoded = canonicalJson$1(packet);
	return {
		packet,
		canonicalJson: encoded,
		packetHash: sha256(encoded)
	};
}
function parseRolePacket(value) {
	const parsed = rolePacketSchema.safeParse(value);
	if (!parsed.success) throw new PacketValidationError(formatIssues$3(parsed.error.issues), parsed.error.issues);
	return parsed.data;
}
function hashRolePacket(value) {
	return sha256(canonicalJson$1(parseRolePacket(value)));
}
function validateBlocks(blocks, role, manifest) {
	if ("lane_id" in role && blocks.lane.length === 0) throw new PacketValidationError(`lane role ${role.role_id} requires an exact LaneCharter block`);
	const charterHash = roleLaneCharterHash(manifest, role);
	if (charterHash !== null && !blocks.lane.some((block) => block.text_sha256 === charterHash)) throw new PacketValidationError(`lane blocks do not include LaneCharter bytes for ${role.role_id}`);
	if (!blocks.role.some((block) => block.text_sha256 === role.prompt_sha256)) throw new PacketValidationError(`role blocks do not include prompt bytes for ${role.role_id}`);
	const ids = /* @__PURE__ */ new Set();
	for (const group of Object.values(blocks)) for (const block of group) {
		if (ids.has(block.block_id)) throw new PacketValidationError(`duplicate verbatim block id ${block.block_id}`);
		ids.add(block.block_id);
	}
}
function laneId$1(role) {
	return "lane_id" in role ? role.lane_id : null;
}
function roleWorktree$1(role) {
	return role.role_kind === "method" || role.role_kind === "coder" ? role.worktree_path : null;
}
function roleLaneCharterHash(manifest, role) {
	if (!("lane_id" in role)) return null;
	return manifest.search.lane_charters.find((charter) => charter.lane_id === role.lane_id).charter_sha256;
}
function relevantPairBlocks(manifest, roleId) {
	return manifest.communication.text_pair_blocks.flatMap((block) => {
		const [first, second] = block.role_ids;
		if (first === roleId) return [{
			other_role_id: second,
			active_when: block.active_when
		}];
		if (second === roleId) return [{
			other_role_id: first,
			active_when: block.active_when
		}];
		return [];
	}).sort((left, right) => left.other_role_id.localeCompare(right.other_role_id) || left.active_when.localeCompare(right.active_when));
}
function formatIssues$3(issues) {
	return issues.map((issue$1) => `${issue$1.path.join(".") || "<root>"}: ${issue$1.message}`).join("; ");
}

//#endregion
//#region src/method-ticket.ts
const SHA256_PATTERN$12 = /^[0-9a-f]{64}$/u;
const UTF8$5 = new TextDecoder("utf-8", {
	fatal: true,
	ignoreBOM: true
});
const nonBlank = z.string().min(1).refine((value) => value.trim().length > 0, "must not be blank");
const hash = z.string().regex(SHA256_PATTERN$12);
/**
* Runtime owns only the Method submission identity. The Method Session and
* Preflight Judge define and interpret the Lab-specific payload in `content`.
*/
const methodDesignTicketSchema = z.object({
	assignment_id: nonBlank,
	assignment_contract_sha256: hash,
	role_packet_sha256: hash,
	candidate_id: nonBlank,
	content: z.json()
}).strict();
/** JSON Schema embedded verbatim in a Method Role Packet output contract. */
function methodDesignTicketOutputSchema() {
	return z.toJSONSchema(methodDesignTicketSchema);
}
const METHOD_TICKET_HASH_BINDING = "role_packet_sha256";
var MethodTicketError = class extends Error {
	name = "MethodTicketError";
	constructor(message, code, issues = []) {
		super(message);
		this.code = code;
		this.issues = issues;
	}
};
function parseMethodDesignTicket(value) {
	const parsed = methodDesignTicketSchema.safeParse(value);
	if (!parsed.success) throw new MethodTicketError(`Method Design Ticket is invalid: ${formatIssues$2(parsed.error.issues)}`, "INVALID_TICKET", parsed.error.issues);
	return parsed.data;
}
/**
* Freeze the exact Method receipt bytes selected by the current Role Packet.
* Runtime verifies only packet/Assignment identity and immutable byte binding;
* it does not inspect or reinterpret the Lab-specific Method content.
*/
async function freezeMethodDesignTicket(input) {
	validateFreezeInput(input);
	const rolePacketPath = resolve(input.rolePacketPath);
	const artifactPath = resolve(input.reviewArtifactPath);
	const packetBytes = await readBytes$2(rolePacketPath, "Role Packet", "INVALID_PACKET");
	const observedPacketHash = sha256(packetBytes);
	if (observedPacketHash !== input.rolePacketHash) throw new MethodTicketError("Role Packet bytes do not match the expected hash", "PACKET_HASH_MISMATCH");
	const packet = parseExactMethodPacket(packetBytes);
	validateOutputContract$1(packet);
	const sourceAssignment = await readSourceAssignment(packet);
	const sourceReceiptPath = resolve(packet.output_contract.receipt_path);
	if (sourceReceiptPath === artifactPath) throw new MethodTicketError("Review artifact must be distinct from the mutable Method receipt", "INVALID_INPUT");
	const receiptBytes = await readBytes$2(sourceReceiptPath, "Method receipt", "INVALID_TICKET");
	const ticket = parseTicketBytes(receiptBytes);
	validateTicketBindings(ticket, packet, observedPacketHash);
	try {
		await durableWriteFile(artifactPath, receiptBytes, false);
	} catch (error) {
		if (!isNodeError$10(error) || error.code !== "EEXIST") throw error;
	}
	const committed = await readBytes$2(artifactPath, "review artifact", "ARTIFACT_CONFLICT");
	if (!Buffer.from(committed).equals(Buffer.from(receiptBytes))) throw new MethodTicketError(`Immutable review artifact conflicts at ${artifactPath}`, "ARTIFACT_CONFLICT");
	return {
		assignmentId: ticket.assignment_id,
		candidateId: ticket.candidate_id,
		rolePacketPath,
		rolePacketHash: observedPacketHash,
		sourceAssignmentPath: sourceAssignment.path,
		sourceAssignmentHash: sourceAssignment.sha256,
		sourceReceiptPath,
		artifactPath,
		artifactHash: sha256(committed),
		ticket
	};
}
async function readSourceAssignment(packet) {
	const matches = packet.verbatim_blocks.assignment.filter((block$1) => block$1.text_sha256 === packet.anchors.assignment_contract_sha256);
	if (matches.length !== 1 || !isAbsolute(matches[0].source_path)) throw new MethodTicketError("Role Packet does not identify one exact Assignment contract", "ANCHOR_MISMATCH");
	const block = matches[0];
	const path = resolve(block.source_path);
	const bytes = await readBytes$2(path, "Assignment contract", "ANCHOR_MISMATCH");
	if (sha256(bytes) !== block.text_sha256 || !Buffer.from(bytes).equals(Buffer.from(block.exact_text, "utf8"))) throw new MethodTicketError("Assignment contract bytes do not match the Role Packet anchor", "ANCHOR_MISMATCH");
	return {
		path,
		sha256: block.text_sha256
	};
}
function validateFreezeInput(input) {
	if (!isAbsolute(input.rolePacketPath) || !isAbsolute(input.reviewArtifactPath) || !SHA256_PATTERN$12.test(input.rolePacketHash)) throw new MethodTicketError("Role Packet path, review artifact path, and packet hash must be exact", "INVALID_INPUT");
}
function parseExactMethodPacket(bytes) {
	let text;
	let value;
	try {
		text = UTF8$5.decode(bytes);
		value = JSON.parse(text);
	} catch (error) {
		throw new MethodTicketError(`Role Packet is not valid UTF-8 JSON: ${errorMessage$3(error)}`, "INVALID_PACKET");
	}
	let packet;
	try {
		packet = parseRolePacket(value);
	} catch (error) {
		throw new MethodTicketError(`Role Packet schema is invalid: ${errorMessage$3(error)}`, "INVALID_PACKET");
	}
	if (packet.header.role_kind !== "method") throw new MethodTicketError("Role Packet is not assigned to a Method Maker", "INVALID_PACKET");
	if (canonicalJson$1(packet) !== text) throw new MethodTicketError("Role Packet bytes are not its canonical immutable form", "INVALID_PACKET");
	return packet;
}
function validateOutputContract$1(packet) {
	if (packet.output_contract.expected_hash_binding !== METHOD_TICKET_HASH_BINDING || canonicalJson$1(packet.output_contract.schema) !== canonicalJson$1(methodDesignTicketOutputSchema())) throw new MethodTicketError("Role Packet does not carry the exact Method Design Ticket output contract", "OUTPUT_CONTRACT_MISMATCH");
}
function parseTicketBytes(bytes) {
	let value;
	try {
		value = JSON.parse(UTF8$5.decode(bytes));
	} catch (error) {
		throw new MethodTicketError(`Method receipt is not valid UTF-8 JSON: ${errorMessage$3(error)}`, "INVALID_TICKET");
	}
	return parseMethodDesignTicket(value);
}
function validateTicketBindings(ticket, packet, packetHash) {
	if (ticket.assignment_id !== packet.header.assignment_id) throw new MethodTicketError("Method Design Ticket belongs to another Assignment", "ASSIGNMENT_MISMATCH");
	if (ticket.role_packet_sha256 !== packetHash || ticket.assignment_contract_sha256 !== packet.anchors.assignment_contract_sha256) throw new MethodTicketError("Method Design Ticket hash bindings do not match the Role Packet anchors", "HASH_BINDING_MISMATCH");
}
async function readBytes$2(path, label, code) {
	try {
		return await readFile(path);
	} catch (error) {
		throw new MethodTicketError(`${label} cannot be read: ${errorMessage$3(error)}`, code);
	}
}
function formatIssues$2(issues) {
	return issues.map((issueValue) => `${issueValue.path.join(".") || "<root>"}: ${issueValue.message}`).join("; ");
}
function errorMessage$3(value) {
	return value instanceof Error ? value.message : String(value);
}
function isNodeError$10(value) {
	return value instanceof Error && "code" in value;
}

//#endregion
//#region src/preflight-verdict.ts
const SHA256_PATTERN$11 = /^[0-9a-f]{64}$/u;
const PREFLIGHT_VERDICTS = [
	"APPROVED",
	"REVISION_REQUIRED",
	"REJECTED",
	"REVIEW_ERROR"
];
const blockingFindingSchema = z.object({
	rule_or_frozen_field: z.string().min(1),
	blocked_transition: z.string().min(1),
	conflict_or_missing_evidence: z.string().min(1)
}).strict();
const preflightVerdictSchema$1 = z.object({
	version: z.literal(1),
	review_id: z.string().min(1),
	assignment_id: z.string().min(1),
	review_input_sha256: z.string().regex(SHA256_PATTERN$11),
	top_level_verdict: z.enum(PREFLIGHT_VERDICTS),
	blocking_findings: z.array(blockingFindingSchema),
	reasons: z.array(z.string().min(1)),
	warnings: z.array(z.string().min(1))
}).strict();
var PreflightVerdictError = class extends Error {
	name = "PreflightVerdictError";
	constructor(message, code, issues = []) {
		super(message);
		this.code = code;
		this.issues = issues;
	}
};
/** Parse one strict, model-produced Preflight receipt without adding policy gates. */
function parsePreflightVerdict(value) {
	const parsed = preflightVerdictSchema$1.safeParse(value);
	if (!parsed.success) throw new PreflightVerdictError(`Preflight verdict is invalid: ${formatIssues$1(parsed.error.issues)}`, "INVALID_RECEIPT", parsed.error.issues);
	return parsed.data;
}
/**
* Read the receipt path declared by the exact Judge Role Packet, validate its
* identity and output contract, then freeze the original receipt bytes into the
* Controller-owned destination. The destination is append/no-clobber only:
* identical retries succeed, different bytes fail.
*/
async function freezePreflightVerdict(input) {
	const packetPath = validatePath$1(input.rolePacketPath, "Role Packet path");
	const artifactPath = validatePath$1(input.artifactPath, "artifact path");
	validateHash(input.rolePacketHash, "Role Packet hash");
	if (packetPath === artifactPath) throw new PreflightVerdictError("Controller artifact path must differ from the Judge receipt path", "INVALID_INPUT");
	const packetBytes = await readBytes$1(packetPath, "Role Packet");
	const observedPacketHash = sha256(packetBytes);
	if (observedPacketHash !== input.rolePacketHash) throw new PreflightVerdictError("Role Packet bytes do not match the supplied hash", "PACKET_HASH_MISMATCH");
	const packet = parsePacketBytes(packetBytes);
	if (packet.header.role_kind !== "preflight_judge") throw new PreflightVerdictError(`Role Packet role_kind is ${JSON.stringify(packet.header.role_kind)}, not "preflight_judge"`, "ROLE_MISMATCH");
	const binding = validateOutputContract(packet);
	const receiptBytes = await readBytes$1(binding.receiptPath, "Preflight receipt");
	const receipt = parseReceiptBytes(receiptBytes);
	if (receipt.review_id !== binding.reviewId || receipt.assignment_id !== binding.assignmentId || receipt.review_input_sha256 !== binding.reviewInputHash) throw new PreflightVerdictError("Preflight receipt identity does not match the Role Packet output contract", "REVIEW_BINDING_MISMATCH");
	await freezeNoClobber$2(artifactPath, receiptBytes);
	return {
		rolePacketPath: packetPath,
		rolePacketHash: observedPacketHash,
		receiptPath: binding.receiptPath,
		artifactPath,
		receiptHash: sha256(receiptBytes),
		receiptBytes,
		packet,
		verdict: receipt
	};
}
/** Explicit artifact-named alias for callers that use the storage vocabulary. */
const freezePreflightVerdictArtifact = freezePreflightVerdict;
const parsePreflightVerdictArtifact = parsePreflightVerdict;
function validateOutputContract(packet) {
	const contract = packet.output_contract;
	const receiptPath$1 = validatePath$1(contract.receipt_path, "Role Packet receipt path");
	if (!SHA256_PATTERN$11.test(contract.expected_hash_binding)) throw new PreflightVerdictError("Role Packet output_contract.expected_hash_binding is not a SHA-256 hash", "OUTPUT_CONTRACT_MISMATCH");
	const schema = asRecord$1(contract.schema);
	if (schema === void 0 || schema.type !== "object" || schema.additionalProperties !== false) throw new PreflightVerdictError("Role Packet does not carry a strict Preflight verdict object schema", "OUTPUT_CONTRACT_MISMATCH");
	const required = asStringArray(schema.required);
	if (required === void 0 || ![
		"version",
		"review_id",
		"assignment_id",
		"review_input_sha256",
		"top_level_verdict",
		"blocking_findings",
		"reasons",
		"warnings"
	].every((field) => required.includes(field))) throw new PreflightVerdictError("Role Packet Preflight schema does not require the complete verdict identity", "OUTPUT_CONTRACT_MISMATCH");
	const properties = asRecord$1(schema.properties);
	if (properties === void 0) throw new PreflightVerdictError("Role Packet Preflight schema has no properties object", "OUTPUT_CONTRACT_MISMATCH");
	const version = asRecord$1(properties.version);
	const reviewId = constString(properties.review_id);
	const assignmentId = constString(properties.assignment_id);
	const reviewInputHash = constString(properties.review_input_sha256);
	const verdict = asRecord$1(properties.top_level_verdict);
	if (version?.const !== 1 || reviewId === void 0 || assignmentId === void 0 || reviewInputHash === void 0 || !SHA256_PATTERN$11.test(reviewInputHash) || verdict === void 0 || !sameStringSet(verdict.enum, PREFLIGHT_VERDICTS)) throw new PreflightVerdictError("Role Packet Preflight schema does not bind the required verdict identity", "OUTPUT_CONTRACT_MISMATCH");
	if (packet.header.assignment_id !== assignmentId || contract.expected_hash_binding !== reviewInputHash) throw new PreflightVerdictError("Role Packet assignment or review-input hash is internally inconsistent", "OUTPUT_CONTRACT_MISMATCH");
	for (const field of [
		"blocking_findings",
		"reasons",
		"warnings"
	]) if (asRecord$1(properties[field])?.type !== "array") throw new PreflightVerdictError(`Role Packet Preflight schema has no array field ${JSON.stringify(field)}`, "OUTPUT_CONTRACT_MISMATCH");
	return {
		receiptPath: receiptPath$1,
		reviewId,
		assignmentId,
		reviewInputHash
	};
}
function parsePacketBytes(bytes) {
	let value;
	let text;
	try {
		text = bytes.toString("utf8");
		value = JSON.parse(text);
	} catch (error) {
		throw new PreflightVerdictError(`Role Packet is not valid JSON: ${errorMessage$2(error)}`, "INVALID_PACKET");
	}
	let packet;
	try {
		packet = parseRolePacket(value);
	} catch (error) {
		throw new PreflightVerdictError(`Role Packet schema is invalid: ${errorMessage$2(error)}`, "INVALID_PACKET");
	}
	if (canonicalJson$1(packet) !== text) throw new PreflightVerdictError("Role Packet bytes are not its canonical immutable form", "INVALID_PACKET");
	return packet;
}
function parseReceiptBytes(bytes) {
	let value;
	try {
		value = JSON.parse(bytes.toString("utf8"));
	} catch (error) {
		throw new PreflightVerdictError(`Preflight receipt is not valid JSON: ${errorMessage$2(error)}`, "INVALID_RECEIPT");
	}
	return parsePreflightVerdict(value);
}
async function freezeNoClobber$2(path, bytes) {
	try {
		await durableWriteFile(path, bytes, false);
	} catch (error) {
		if (!isNodeError$9(error) || error.code !== "EEXIST") throw new PreflightVerdictError(`Cannot write immutable Preflight artifact at ${path}: ${errorMessage$2(error)}`, "ARTIFACT_WRITE_FAILED");
	}
	let committed;
	try {
		committed = await readFile(path);
	} catch (error) {
		throw new PreflightVerdictError(`Immutable Preflight artifact cannot be read at ${path}: ${errorMessage$2(error)}`, "ARTIFACT_CONFLICT");
	}
	if (!committed.equals(bytes)) throw new PreflightVerdictError(`Immutable Preflight artifact conflicts at ${path}`, "ARTIFACT_CONFLICT");
}
async function readBytes$1(path, label) {
	try {
		return await readFile(path);
	} catch (error) {
		throw new PreflightVerdictError(`${label} cannot be read at ${path}: ${errorMessage$2(error)}`, label === "Role Packet" ? "PACKET_READ_FAILED" : "RECEIPT_READ_FAILED");
	}
}
function validatePath$1(value, label) {
	if (typeof value !== "string" || !isAbsolute(value)) throw new PreflightVerdictError(`${label} must be absolute`, "INVALID_INPUT");
	return resolve(value);
}
function validateHash(value, label) {
	if (typeof value !== "string" || !SHA256_PATTERN$11.test(value)) throw new PreflightVerdictError(`${label} must be a SHA-256 hash`, "INVALID_INPUT");
}
function asRecord$1(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
	return value;
}
function asStringArray(value) {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return void 0;
	return value;
}
function constString(value) {
	const record$1 = asRecord$1(value);
	return typeof record$1?.const === "string" ? record$1.const : void 0;
}
function sameStringSet(value, expected) {
	const actual = asStringArray(value);
	return actual !== void 0 && actual.length === expected.length && new Set(actual).size === actual.length && expected.every((item) => actual.includes(item));
}
function formatIssues$1(issues) {
	return issues.map((issue$1) => `${issue$1.path.join(".")} ${issue$1.message}`).join("; ");
}
function errorMessage$2(error) {
	return error instanceof Error ? error.message : String(error);
}
function isNodeError$9(value) {
	return value instanceof Error && "code" in value;
}

//#endregion
//#region src/roles.ts
const ROLE_KERNEL_SECTION = "autolab:role-kernel";
const ROLE_KERNEL_ORDER = 20;
const ROLE_KERNEL_VERSION = 1;
var AutoLabRoleError = class extends Error {
	name = "AutoLabRoleError";
	constructor(message, code) {
		super(message);
		this.code = code;
	}
};
const KERNEL_TEXT = {
	method: [
		"You are AutoLab's Method Maker.",
		"Work only inside the current Role Packet and LaneCharter. Map every hard constraint, preserve active facts, separate method, feature/lens, and implementation hypotheses, and propose contrasts that can change the decision.",
		"Do not edit code, approve your own admission, or turn API, GPU, environment, or runner failures into scientific conclusions. Treat the current packet and its anchored files as authority, not chat memory. Return the packet's required output schema."
	].join("\n\n"),
	coder: [
		"You are AutoLab's Coder.",
		"Implement only the admitted candidate in this Lane worktree. Preserve the approved method and mutation scope; record the code identity, diff, reproducible command, and the raw report required by this Lab.",
		"For a small experiment assigned to Coder, run the intended experiment directly. Do not insert a preliminary smoke test or create any new gate, prerequisite, or approval step. This changes only the Coder workflow: checks explicitly required by the current Lab contract and reviews owned by other roles remain in force.",
		"Do not silently replace the method or interpret infrastructure failures as scientific evidence. If the method must change, return it to Method Maker and Preflight. Treat the current Role Packet and anchored files as authority, not chat memory. Return the packet's required output schema."
	].join("\n\n"),
	preflight_judge: [
		"You are AutoLab's Preflight Judge.",
		"Independently review the submitted method and experiment plan against this Lab's original constraints, facts, feature or lens choice, and ability to change the research decision. Produce the verdict and reasons required by this Lab.",
		"Do not implement the method, perform Postflight evidence attribution, or add unrelated gates. Treat the anchored original text and current Assignment as authority, not chat memory."
	].join("\n\n"),
	postflight_judge: [
		"You are AutoLab's Postflight Judge.",
		"Read the original Method, Preflight, Coder, Attempt, logs, checkpoints, metrics, evaluator or grader outputs, and incidents required by this Lab. Separate method, feature or lens, implementation, measurement, environment, protocol, mixed, and unknown causes.",
		"Do not count an operational failure as a method failure, infer refutation merely from a poor metric, or invent the next experiment. Treat the anchored original materials and current Lab contract as authority, not chat memory."
	].join("\n\n"),
	ops: [
		"You are AutoLab's Ops role.",
		"Resolve environment, dependency, hardware, SSH, process, storage, and runner incidents with the smallest verifiable repair. Preserve diagnostic and postcondition evidence and report only the operational facts authorized by the packet.",
		"Do not choose the scientific route or translate an operational incident into a method verdict. Treat the current incident packet and anchored files as authority, not chat memory."
	].join("\n\n"),
	coordinator: [
		"You are AutoLab's internal Coordinator.",
		"Coordinate only the research information and runtime state authorized by the current topology, reveal state, and communication ACL. Keep Lane-private science sealed until the configured reveal boundary and route responsibilities without rewriting their source packets.",
		"Select scientific routes only when the current Lab or Assignment delegates that authority; otherwise return the original options to the Controller. You are not the Lab Controller and cannot replace the user's authority or override a user decision. Treat current anchored state as authority, not chat memory. Return the packet's required output schema."
	].join("\n\n")
};
const PROMPT_TEXT = {
	controller: [
		"You are the user-owned AutoLab Lab Controller. The user is the final authority.",
		"Create, inspect, and direct this Lab from its local CURRENT revision and RuntimeState, never from chat memory. During creation, ask only choices that materially affect the research contract, topology, resources, evidence, or permissions; mark every proposed value as proposed and preserve its provenance.",
		"Route selection for the user is optional. Never infer authority: unless the current Lab explicitly delegates it to you or the Coordinator, return the original choices to the user. Stay within delegated scope; the user may always override.",
		"At commit, show the complete accepted original text and hashes; a summary never substitutes for the original. You are not the internal Coordinator or a monitoring worker.",
		"Runtime mechanically retries and reconnects API, Session, process, SSH, hardware, and environment failures before involving any LLM. Do not poll for them or repeat a repair that Runtime already completed. Act only when an unresolved incident requires credentials, authorization, configuration, operational judgment, or a research decision."
	].join("\n\n"),
	...KERNEL_TEXT
};
const ROLE_PROMPTS = Object.freeze(Object.fromEntries(Object.entries(PROMPT_TEXT).map(([roleKind, text]) => [roleKind, Object.freeze({
	id: roleKind === "method" ? "autolab:method-maker:v1" : roleKind === "controller" ? "autolab:lab-controller:v1" : `autolab:${roleKind.replaceAll("_", "-")}:v1`,
	version: ROLE_KERNEL_VERSION,
	roleKind,
	text,
	sha256: sha256(text)
})])));
function rolePromptFor(roleKind) {
	return ROLE_PROMPTS[roleKind];
}
function roleKernelFor(roleKind) {
	return rolePromptFor(roleKind);
}
function resolveRootRoleSessionSpec(manifest, roleId) {
	const role = manifest.roles.find((candidate) => candidate.role_id === roleId);
	if (role === void 0) throw new AutoLabRoleError(`unknown AutoLab role ${JSON.stringify(roleId)}`, "ROLE_NOT_FOUND");
	if (role.role_kind === "controller") throw new AutoLabRoleError(`role ${JSON.stringify(roleId)} is the user-owned Controller Session and must not be activated as a root worker`, "DIRECTOR_NOT_ACTIVATABLE");
	const kernel = roleKernelFor(role.role_kind);
	if (role.prompt_sha256 !== kernel.sha256) throw new AutoLabRoleError(`role ${JSON.stringify(roleId)} prompt hash does not match ${kernel.id}`, "PROMPT_HASH_MISMATCH");
	return {
		role,
		kernel,
		cwd: roleWorktree(manifest, role)
	};
}
function roleWorktree(manifest, role) {
	if (role.role_kind === "method" || role.role_kind === "coder") return role.worktree_path;
	if (role.role_kind === "preflight_judge" || role.role_kind === "postflight_judge") {
		const lane = manifest.lanes.find((candidate) => candidate.lane_id === role.lane_id);
		if (lane === void 0) throw new AutoLabRoleError(`role ${JSON.stringify(role.role_id)} references missing Lane ${JSON.stringify(role.lane_id)}`, "LANE_NOT_FOUND");
		return lane.worktree_path;
	}
	return manifest.repository.path;
}

//#endregion
//#region src/approved-coder-artifacts.ts
const SHA256_PATTERN$10 = /^[0-9a-f]{64}$/u;
const UTF8$4 = new TextDecoder("utf-8", {
	fatal: true,
	ignoreBOM: true
});
var ApprovedCoderArtifactError = class extends Error {
	name = "ApprovedCoderArtifactError";
	constructor(message, code) {
		super(message);
		this.code = code;
	}
};
/**
* Compile the exact APPROVED Preflight transition into one immutable Coder
* Assignment and Role Packet. This is a byte/hash compiler only: it never asks
* a model to summarize the Ticket or introduces another admission decision.
*/
async function freezeApprovedCoderArtifacts(input) {
	validateScalarInput$1(input);
	await assertFrozenRevision$2(input.frozen);
	const manifest = input.frozen.manifest;
	const target = await resolveCoder(input);
	const sourcePacket = await readSourceMethodPacket$1(input.sourceMethodPacket);
	const sourceAssignment = await assertSourceMethodPacket$1(input, sourcePacket, target.laneId, target.methodRoleId);
	const ticket = await readDesignTicket(input, sourcePacket);
	const verdict = await readApprovedVerdict(input);
	await assertApprovedReviewChain(input, sourcePacket, sourceAssignment, verdict, target.preflightJudgeRoleId);
	const [ticketText, verdictText] = await Promise.all([readExactText(input.designTicket, "Design Ticket", "DESIGN_TICKET_MISMATCH"), readExactText(input.preflightVerdict, "Preflight verdict", "PREFLIGHT_VERDICT_MISMATCH")]);
	const prompt = rolePromptFor("coder");
	const promptPath = join(manifest.authority_paths.lab_dir, "artifacts", "builtins", `${prompt.sha256}.txt`);
	await freezeExact$3(promptPath, prompt.text);
	const laneText = canonicalJson$1(target.charter.content);
	if (sha256(laneText) !== target.charter.charter_sha256) throw new ApprovedCoderArtifactError("LaneCharter bytes do not match CURRENT ResolvedManifest", "CURRENT_MISMATCH");
	const lanePath = join(manifest.authority_paths.lab_dir, "artifacts", "lanes", `${sha256(target.laneId)}.charter.json`);
	await freezeExact$3(lanePath, laneText);
	const assignmentId = `coder:${input.reviewId}`;
	const objectiveBody = [
		"Implement only the exact APPROVED Design Ticket bound by this Assignment in the Lane worktree.",
		"Do not change, reinterpret, or replace the approved method during implementation, including with an unapproved substitute that appears easier to code.",
		"If implementation requires a method change outside the approved variation space, stop and return it to Method Maker and Preflight; do not improvise the change in this Session.",
		"Write only the narrow implementation report declared by the output contract, then call SubmitCoderImplementation with no arguments; AutoLab derives and freezes all code and Controller identities mechanically."
	].join("\n");
	const assignmentPath = join(manifest.authority_paths.assignment_root, "coder", `${sha256(assignmentId)}.json`);
	const receiptPath$1 = join(manifest.authority_paths.assignment_root, "outputs", `${sha256(assignmentId)}.json`);
	const outputContract = {
		schema: coderImplementationReportOutputSchema(),
		receipt_path: receiptPath$1,
		expected_hash_binding: assignmentId
	};
	const assignmentText = canonicalJson$1({
		version: 1,
		assignment_type: "approved_coder_implementation",
		assignment_id: assignmentId,
		review_id: input.reviewId,
		runtime_revision: input.runtimeRevision,
		issued_at: input.issuedAt,
		coder: {
			role_id: target.roleId,
			session_id: input.coderSessionId,
			binding_path: input.coderBinding.path,
			binding_sha256: input.coderBinding.hash
		},
		source_method: {
			role_id: sourcePacket.header.role_id,
			session_id: sourcePacket.header.session_id,
			packet: artifactRef$1("source-method-packet", input.sourceMethodPacket)
		},
		design_ticket: {
			...artifactRef$1("design-ticket", input.designTicket),
			candidate_id: ticket.candidate_id
		},
		preflight_approval: {
			...artifactRef$1("preflight-verdict", input.preflightVerdict),
			judge_assignment_id: verdict.assignment_id,
			review_input_sha256: verdict.review_input_sha256,
			top_level_verdict: verdict.top_level_verdict
		},
		objective: objectiveBody,
		output_contract: outputContract
	});
	const assignmentHash = await freezeExact$3(assignmentPath, assignmentText);
	const factAnchor = await currentFactAnchor(manifest.authority_paths.fact_set);
	const packet = compileRolePacket({
		manifest,
		role_id: target.roleId,
		session_id: input.coderSessionId,
		assignment_id: assignmentId,
		issued_at: input.issuedAt,
		role_binding_receipt_sha256: input.coderBinding.hash,
		runtime_revision: input.runtimeRevision,
		fact_set_sha256: factAnchor.factSetSha256,
		evidence_index_sha256: sourcePacket.anchors.evidence_index_sha256,
		assignment_contract_sha256: assignmentHash,
		reveal_state: sourcePacket.runtime_snapshot.reveal_state,
		verbatim_blocks: {
			universal: [{
				block_id: "lab-spec",
				source_path: manifest.authority_paths.lab_spec,
				exact_text: input.frozen.spec,
				text_sha256: input.frozen.ref.specHash
			}],
			role: [{
				block_id: "role-prompt",
				source_path: promptPath,
				exact_text: prompt.text,
				text_sha256: prompt.sha256
			}],
			lane: [{
				block_id: "lane-charter",
				source_path: lanePath,
				exact_text: laneText,
				text_sha256: target.charter.charter_sha256
			}],
			stage: [{
				block_id: "approved-method-design-ticket",
				source_path: input.designTicket.path,
				exact_text: ticketText,
				text_sha256: input.designTicket.sha256
			}, {
				block_id: "preflight-approved-verdict",
				source_path: input.preflightVerdict.path,
				exact_text: verdictText,
				text_sha256: input.preflightVerdict.sha256
			}],
			assignment: [{
				block_id: "approved-coder-assignment",
				source_path: assignmentPath,
				exact_text: assignmentText,
				text_sha256: assignmentHash
			}]
		},
		...sourcePacket.runtime_snapshot.incumbent === void 0 ? {} : { incumbent: sourcePacket.runtime_snapshot.incumbent },
		relevant_fact_refs: [...sourcePacket.runtime_snapshot.relevant_fact_refs.filter((ref) => ref.id !== "fact-set"), ...factAnchor.relevantFactRefs],
		evidence_refs: sourcePacket.runtime_snapshot.evidence_refs,
		open_obligation_refs: sourcePacket.runtime_snapshot.open_obligation_refs,
		input_artifact_refs: [
			artifactRef$1("source-method-packet", input.sourceMethodPacket),
			artifactRef$1("design-ticket", input.designTicket),
			artifactRef$1("preflight-verdict", input.preflightVerdict)
		],
		output_contract: outputContract
	});
	const packetPath = join(manifest.authority_paths.lab_dir, "packets", sha256(assignmentId), `${sha256(target.roleId)}.json`);
	if (await freezeExact$3(packetPath, packet.canonicalJson) !== packet.packetHash) throw new ApprovedCoderArtifactError("Coder Role Packet file hash changed while committing", "ARTIFACT_CONFLICT");
	return {
		assignmentId,
		assignmentPath,
		assignmentHash,
		objectiveBody,
		packetPath,
		packet
	};
}
function validateScalarInput$1(input) {
	if (input.reviewId.trim().length === 0 || input.coderSessionId.trim().length === 0 || input.reviewId === "." || input.reviewId === ".." || input.reviewId.includes("/") || input.reviewId.includes("\\") || input.reviewId.includes("\0")) throw new ApprovedCoderArtifactError("reviewId must be one non-empty path-safe identity and Coder SessionId must be non-empty", "INVALID_INPUT");
	if (!Number.isSafeInteger(input.runtimeRevision) || input.runtimeRevision < 0 || !Number.isSafeInteger(input.issuedAt) || input.issuedAt < 0) throw new ApprovedCoderArtifactError("runtimeRevision and issuedAt must be non-negative safe integers", "INVALID_INPUT");
	validateReference$1(input.sourceMethodPacket, "source Method Packet");
	validateReference$1(input.designTicket, "Design Ticket");
	validateReference$1(input.preflightVerdict, "Preflight verdict");
}
function validateReference$1(reference, label) {
	if (!isAbsolute(reference.path) || !SHA256_PATTERN$10.test(reference.sha256)) throw new ApprovedCoderArtifactError(`${label} requires an absolute path and SHA-256`, "INVALID_INPUT");
}
async function assertFrozenRevision$2(frozen) {
	const manifest = frozen.manifest;
	const manifestText = canonicalJson$1(manifest);
	if (sha256(frozen.spec) !== frozen.ref.specHash || sha256(frozen.config) !== frozen.ref.configHash || sha256(manifestText) !== frozen.ref.manifestHash || frozen.validation.specHash !== frozen.ref.specHash || frozen.validation.configHash !== frozen.ref.configHash || frozen.validation.manifestHash !== frozen.ref.manifestHash || frozen.validation.dialogueHeadHash !== frozen.ref.dialogueHeadHash || manifest.source_revision !== frozen.ref.revision || manifest.anchors.dialogue_head_sha256 !== frozen.ref.dialogueHeadHash || manifest.anchors.lab_spec_sha256 !== frozen.ref.specHash || manifest.anchors.lab_yaml_sha256 !== frozen.ref.configHash) throw new ApprovedCoderArtifactError("FrozenRevision does not match its CURRENT hashes", "CURRENT_MISMATCH");
	await assertExactAuthority$1(manifest.authority_paths.lab_spec, frozen.spec, "CURRENT LAB_SPEC");
	await assertExactAuthority$1(manifest.authority_paths.lab_yaml, frozen.config, "CURRENT lab.yaml");
	await assertExactAuthority$1(manifest.authority_paths.resolved_manifest, manifestText, "CURRENT ResolvedManifest");
}
async function resolveCoder(input) {
	const manifest = input.frozen.manifest;
	const currentRole = manifest.roles.find((candidate) => candidate.role_id === input.coderRole.role_id);
	if (currentRole?.role_kind !== "coder" || input.coderRole.role_kind !== "coder" || canonicalJson$1(currentRole) !== canonicalJson$1(input.coderRole)) throw new ApprovedCoderArtifactError("target role is not the exact CURRENT Coder role", "CODER_BINDING_MISMATCH");
	const lane = manifest.lanes.find((candidate) => candidate.lane_id === currentRole.lane_id && candidate.coder_role_id === currentRole.role_id);
	const charter = manifest.search.lane_charters.find((candidate) => candidate.lane_id === currentRole.lane_id);
	if (lane === void 0 || charter === void 0) throw new ApprovedCoderArtifactError("target Coder does not resolve to one CURRENT Lane", "CODER_BINDING_MISMATCH");
	const stored = await readRoleBinding(manifest.authority_paths.lab_dir, currentRole.role_id);
	const receipt = input.coderBinding.receipt;
	const sessionSpec = resolveRootRoleSessionSpec(manifest, currentRole.role_id);
	if (stored === void 0 || stored.path !== input.coderBinding.path || stored.hash !== input.coderBinding.hash || canonicalJson$1(stored.receipt) !== canonicalJson$1(receipt) || receipt.receiptHash !== input.coderBinding.hash || receipt.labId !== manifest.lab_id || !await isCommittedManifestHash(input.frozen.manifest.authority_paths.lab_dir, receipt.manifestHash) || receipt.roleId !== currentRole.role_id || receipt.roleKind !== "coder" || receipt.sessionId !== input.coderSessionId || receipt.permissionPresetId !== currentRole.dsh_preset || receipt.provider !== currentRole.model_route.provider || receipt.model !== currentRole.model_route.model || receipt.cwd !== sessionSpec.cwd || receipt.runtimeRevision > input.runtimeRevision) throw new ApprovedCoderArtifactError("Coder Session does not match its frozen RoleBindingReceipt and CURRENT", "CODER_BINDING_MISMATCH");
	return {
		roleId: currentRole.role_id,
		laneId: currentRole.lane_id,
		methodRoleId: lane.method_role_id,
		preflightJudgeRoleId: lane.preflight_judge_role_id,
		charter
	};
}
async function readSourceMethodPacket$1(reference) {
	const bytes = await readExactBytes$1(reference, "source Method Packet", "SOURCE_PACKET_MISMATCH");
	let text;
	let value;
	try {
		text = UTF8$4.decode(bytes);
		value = JSON.parse(text);
	} catch {
		throw new ApprovedCoderArtifactError("source Method Packet is not valid UTF-8 JSON", "SOURCE_PACKET_MISMATCH");
	}
	let packet;
	try {
		packet = parseRolePacket(value);
	} catch {
		throw new ApprovedCoderArtifactError("source Method Packet does not satisfy Role Packet v1", "SOURCE_PACKET_MISMATCH");
	}
	if (canonicalJson$1(packet) !== text) throw new ApprovedCoderArtifactError("source Method Packet is not the exact canonical frozen packet", "SOURCE_PACKET_MISMATCH");
	return packet;
}
async function assertSourceMethodPacket$1(input, packet, laneId$2, methodRoleId) {
	const manifest = input.frozen.manifest;
	const expectedPath = join(manifest.authority_paths.lab_dir, "packets", sha256(packet.header.assignment_id), `${sha256(methodRoleId)}.json`);
	const packetRevision = await readRevisionAtPath(manifest.authority_paths.lab_dir, packet.anchors.source_revision, input.frozen);
	if (input.sourceMethodPacket.path !== expectedPath || packet.header.lab_id !== manifest.lab_id || packet.header.lane_id !== laneId$2 || packet.header.role_id !== methodRoleId || packet.header.role_kind !== "method" || packet.anchors.source_revision > input.frozen.ref.revision || packet.anchors.dialogue_head_sha256 !== packetRevision.ref.dialogueHeadHash || packet.anchors.lab_spec_sha256 !== packetRevision.ref.specHash || packet.anchors.lab_yaml_sha256 !== packetRevision.ref.configHash || packet.anchors.resolved_manifest_sha256 !== packetRevision.ref.manifestHash || packet.anchors.campaign_contract_sha256 !== packetRevision.manifest.campaign_contract_sha256 || packet.output_contract.expected_hash_binding !== METHOD_TICKET_HASH_BINDING || canonicalJson$1(packet.output_contract.schema) !== canonicalJson$1(methodDesignTicketOutputSchema())) throw new ApprovedCoderArtifactError("source Method Packet does not bind this CURRENT Lane, path, and output contract", "SOURCE_PACKET_MISMATCH");
	let recompiled;
	try {
		recompiled = compileRolePacket({
			manifest: packetRevision.manifest,
			role_id: packet.header.role_id,
			session_id: packet.header.session_id,
			assignment_id: packet.header.assignment_id,
			issued_at: packet.header.issued_at,
			role_binding_receipt_sha256: packet.anchors.role_binding_receipt_sha256,
			runtime_revision: packet.anchors.runtime_revision,
			fact_set_sha256: packet.anchors.fact_set_sha256,
			evidence_index_sha256: packet.anchors.evidence_index_sha256,
			assignment_contract_sha256: packet.anchors.assignment_contract_sha256,
			reveal_state: packet.runtime_snapshot.reveal_state,
			verbatim_blocks: packet.verbatim_blocks,
			...packet.runtime_snapshot.incumbent === void 0 ? {} : { incumbent: packet.runtime_snapshot.incumbent },
			relevant_fact_refs: packet.runtime_snapshot.relevant_fact_refs,
			evidence_refs: packet.runtime_snapshot.evidence_refs,
			open_obligation_refs: packet.runtime_snapshot.open_obligation_refs,
			input_artifact_refs: packet.runtime_snapshot.input_artifact_refs,
			output_contract: packet.output_contract
		});
	} catch {
		throw new ApprovedCoderArtifactError("source Method Packet cannot be reproduced from CURRENT", "SOURCE_PACKET_MISMATCH");
	}
	if (recompiled.canonicalJson !== canonicalJson$1(packet) || recompiled.packetHash !== input.sourceMethodPacket.sha256) throw new ApprovedCoderArtifactError("source Method Packet manifest-derived fields drifted from CURRENT", "SOURCE_PACKET_MISMATCH");
	const universal = packet.verbatim_blocks.universal.filter((block) => block.source_path === packetRevision.manifest.authority_paths.lab_spec && block.text_sha256 === packet.anchors.lab_spec_sha256 && sha256(block.exact_text) === packet.anchors.lab_spec_sha256);
	const assignment = packet.verbatim_blocks.assignment.filter((block) => block.text_sha256 === packet.anchors.assignment_contract_sha256 && isWithin$1(manifest.authority_paths.assignment_root, block.source_path));
	if (universal.length !== 1 || assignment.length !== 1) throw new ApprovedCoderArtifactError("source Method Packet does not bind one exact CURRENT LAB_SPEC and Assignment", "SOURCE_PACKET_MISMATCH");
	await assertExactAuthority$1(assignment[0].source_path, assignment[0].exact_text, "source Method Assignment", "SOURCE_PACKET_MISMATCH");
	return {
		path: assignment[0].source_path,
		sha256: assignment[0].text_sha256
	};
}
async function readDesignTicket(input, packet) {
	const expectedPath = join(input.frozen.manifest.authority_paths.lab_dir, "artifacts", "reviews", input.reviewId, "method-ticket.json");
	if (input.designTicket.path !== expectedPath) throw new ApprovedCoderArtifactError("Design Ticket path does not match the frozen review identity", "DESIGN_TICKET_MISMATCH");
	const bytes = await readExactBytes$1(input.designTicket, "Design Ticket", "DESIGN_TICKET_MISMATCH");
	let ticket;
	try {
		ticket = parseMethodDesignTicket(JSON.parse(UTF8$4.decode(bytes)));
	} catch {
		throw new ApprovedCoderArtifactError("Design Ticket does not satisfy the strict Method Design Ticket schema", "DESIGN_TICKET_MISMATCH");
	}
	if (ticket.assignment_id !== packet.header.assignment_id || ticket.assignment_contract_sha256 !== packet.anchors.assignment_contract_sha256 || ticket.role_packet_sha256 !== input.sourceMethodPacket.sha256) throw new ApprovedCoderArtifactError("Design Ticket hash bindings do not match the source Method Packet", "DESIGN_TICKET_MISMATCH");
	return ticket;
}
async function readApprovedVerdict(input) {
	const expectedPath = join(input.frozen.manifest.authority_paths.lab_dir, "artifacts", "reviews", input.reviewId, "preflight-verdict.json");
	if (input.preflightVerdict.path !== expectedPath) throw new ApprovedCoderArtifactError("Preflight verdict path does not match the frozen review identity", "PREFLIGHT_VERDICT_MISMATCH");
	const bytes = await readExactBytes$1(input.preflightVerdict, "Preflight verdict", "PREFLIGHT_VERDICT_MISMATCH");
	let verdict;
	try {
		verdict = parsePreflightVerdict(JSON.parse(UTF8$4.decode(bytes)));
	} catch {
		throw new ApprovedCoderArtifactError("Preflight verdict does not satisfy the strict receipt schema", "PREFLIGHT_VERDICT_MISMATCH");
	}
	if (verdict.review_id !== input.reviewId || verdict.assignment_id !== `preflight:${input.reviewId}` || verdict.top_level_verdict !== "APPROVED") throw new ApprovedCoderArtifactError("Preflight verdict is not the APPROVED receipt for this review", "PREFLIGHT_VERDICT_MISMATCH");
	return verdict;
}
async function assertApprovedReviewChain(input, sourcePacket, sourceAssignment, verdict, preflightJudgeRoleId) {
	const manifest = input.frozen.manifest;
	const assignmentPath = join(manifest.authority_paths.assignment_root, "reviews", `${sha256(input.reviewId)}.preflight.json`);
	let bytes;
	try {
		bytes = await readFile(assignmentPath);
	} catch {
		throw new ApprovedCoderArtifactError("frozen Preflight Assignment cannot be read", "PREFLIGHT_VERDICT_MISMATCH");
	}
	let text;
	let value;
	try {
		text = UTF8$4.decode(bytes);
		value = JSON.parse(text);
	} catch {
		throw new ApprovedCoderArtifactError("frozen Preflight Assignment is not valid UTF-8 JSON", "PREFLIGHT_VERDICT_MISMATCH");
	}
	if (!isRecord$1(value) || canonicalJson$1(value) !== text || value.version !== 1 || value.assignment_type !== "preflight_review" || value.review_id !== input.reviewId || value.assignment_id !== verdict.assignment_id || value.review_input_sha256 !== verdict.review_input_sha256 || !isNonNegativeSafeInteger(value.runtime_revision) || value.runtime_revision > input.runtimeRevision || !isNonNegativeSafeInteger(value.issued_at)) throw new ApprovedCoderArtifactError("frozen Preflight Assignment identity does not match the APPROVED verdict", "PREFLIGHT_VERDICT_MISMATCH");
	const judge = asRecord(value.judge);
	const sourceMethod = asRecord(value.source_method);
	const judgeRole = manifest.roles.find((candidate) => candidate.role_id === preflightJudgeRoleId);
	if (judge === void 0 || sourceMethod === void 0 || judgeRole?.role_kind !== "preflight_judge" || judge.role_id !== preflightJudgeRoleId || typeof judge.session_id !== "string" || judge.session_id.length === 0 || typeof judge.binding_path !== "string" || !isAbsolute(judge.binding_path) || typeof judge.binding_sha256 !== "string" || !SHA256_PATTERN$10.test(judge.binding_sha256) || sourceMethod.role_id !== sourcePacket.header.role_id || sourceMethod.session_id !== sourcePacket.header.session_id || !sameArtifactRef(sourceMethod.assignment, "source-method-assignment", sourceAssignment) || !sameArtifactRef(sourceMethod.packet, "source-method-packet", input.sourceMethodPacket) || !sameArtifactRef(value.design_ticket, "design-ticket", input.designTicket)) throw new ApprovedCoderArtifactError("frozen Preflight Assignment does not bind the exact Method Packet and Design Ticket", "PREFLIGHT_VERDICT_MISMATCH");
	const judgeBinding = await readRoleBinding(manifest.authority_paths.lab_dir, preflightJudgeRoleId);
	const judgeSession = resolveRootRoleSessionSpec(manifest, preflightJudgeRoleId);
	if (judgeBinding === void 0 || judgeBinding.path !== judge.binding_path || judgeBinding.hash !== judge.binding_sha256 || judgeBinding.receipt.labId !== manifest.lab_id || !await isCommittedManifestHash(input.frozen.manifest.authority_paths.lab_dir, judgeBinding.receipt.manifestHash) || judgeBinding.receipt.roleId !== preflightJudgeRoleId || judgeBinding.receipt.roleKind !== "preflight_judge" || judgeBinding.receipt.sessionId !== judge.session_id || judgeBinding.receipt.permissionPresetId !== judgeRole.dsh_preset || judgeBinding.receipt.provider !== judgeRole.model_route.provider || judgeBinding.receipt.model !== judgeRole.model_route.model || judgeBinding.receipt.cwd !== judgeSession.cwd) throw new ApprovedCoderArtifactError("frozen Preflight Assignment Judge binding drifted from CURRENT", "PREFLIGHT_VERDICT_MISMATCH");
	if (sha256(`autolab-preflight-review-input-v1\0${canonicalJson$1({
		review_id: input.reviewId,
		lab_id: manifest.lab_id,
		source_revision: input.frozen.ref.revision,
		resolved_manifest_sha256: input.frozen.ref.manifestHash,
		runtime_revision: value.runtime_revision,
		issued_at: value.issued_at,
		judge: {
			role_id: judge.role_id,
			session_id: judge.session_id,
			binding_path: judge.binding_path,
			binding_sha256: judge.binding_sha256
		},
		source_method_assignment: sourceAssignment,
		source_method_packet: input.sourceMethodPacket,
		design_ticket: input.designTicket
	})}`) !== verdict.review_input_sha256) throw new ApprovedCoderArtifactError("APPROVED verdict review-input hash does not bind the supplied frozen inputs", "PREFLIGHT_VERDICT_MISMATCH");
}
function artifactRef$1(artifactId, reference) {
	return {
		artifact_id: artifactId,
		path: reference.path,
		sha256: reference.sha256
	};
}
function sameArtifactRef(value, artifactId, expected) {
	const record$1 = asRecord(value);
	return record$1 !== void 0 && record$1.artifact_id === artifactId && record$1.path === expected.path && record$1.sha256 === expected.sha256;
}
function isNonNegativeSafeInteger(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function asRecord(value) {
	return isRecord$1(value) ? value : void 0;
}
function isRecord$1(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isWithin$1(root, path) {
	const child = relative(root, path);
	return child.length > 0 && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}
async function readExactBytes$1(reference, label, code) {
	let bytes;
	try {
		bytes = await readFile(reference.path);
	} catch {
		throw new ApprovedCoderArtifactError(`${label} cannot be read`, code);
	}
	if (sha256(bytes) !== reference.sha256) throw new ApprovedCoderArtifactError(`${label} SHA-256 mismatch`, code);
	return bytes;
}
async function readExactText(reference, label, code) {
	const bytes = await readExactBytes$1(reference, label, code);
	try {
		return UTF8$4.decode(bytes);
	} catch {
		throw new ApprovedCoderArtifactError(`${label} is not valid UTF-8`, code);
	}
}
async function assertExactAuthority$1(path, expected, label, code = "CURRENT_MISMATCH") {
	let bytes;
	try {
		bytes = await readFile(path);
	} catch {
		throw new ApprovedCoderArtifactError(`${label} cannot be read`, code);
	}
	if (!bytes.equals(Buffer.from(expected, "utf8"))) throw new ApprovedCoderArtifactError(`${label} bytes do not match their frozen anchor`, code);
}
async function freezeExact$3(path, bytes) {
	if (await readFile(path, "utf8").catch((error) => {
		if (isNodeError$8(error) && error.code === "ENOENT") return void 0;
		throw error;
	}) === void 0) try {
		await durableWriteFile(path, bytes, false);
	} catch (error) {
		if (!isNodeError$8(error) || error.code !== "EEXIST") throw error;
	}
	const committed = await readFile(path, "utf8");
	if (committed !== bytes) throw new ApprovedCoderArtifactError(`Immutable Coder artifact conflicts at ${path}`, "ARTIFACT_CONFLICT");
	return sha256(committed);
}
function isNodeError$8(value) {
	return value instanceof Error && "code" in value;
}

//#endregion
//#region src/goal.ts
const SHA256_PATTERN$9 = /^[0-9a-f]{64}$/;
const CONTROL_CANCEL_REASON = "autolab-control";
var LocalGoalError = class extends Error {
	name = "LocalGoalError";
	constructor(message, code) {
		super(message);
		this.code = code;
	}
};
/**
* Deterministically compile the short Goal payload before the Controller
* persists its install intent. The full Lab specification remains in the
* immutable packet; it is deliberately not copied into every Goal round.
*/
function compileLocalGoalIntent(input) {
	validateIntentInput(input);
	const objective = [
		`AutoLab-Install-ID: ${JSON.stringify(input.installId)}`,
		`Assignment-ID: ${JSON.stringify(input.assignmentId)}`,
		`Role-Packet-Path: ${JSON.stringify(input.packetPath)}`,
		`Role-Packet-SHA256: ${input.packetHash}`,
		"",
		input.body
	].join("\n");
	return Object.freeze({
		...input,
		expectedGoalRef: input.expectedGoalRef === null ? null : Object.freeze({ ...input.expectedGoalRef }),
		objective,
		objectiveHash: sha256$1(objective)
	});
}
/** Install or adopt one exact Assignment Goal on an Agent live in this process. */
async function installLocalGoal(ctx, sessionId, intent) {
	const compiled = compileLocalGoalIntent(intent);
	if (intent.objective !== compiled.objective || intent.objectiveHash !== compiled.objectiveHash) throw new LocalGoalError(`Goal install intent ${JSON.stringify(intent.installId)} does not match its compiled objective`, "INVALID_INTENT");
	const agent = resolveLocalAgent$1(ctx, sessionId);
	return await runInMaintenance(ctx, agent, async () => {
		assertStillLocal$1(ctx, agent);
		let current = ctx.goals.get(agent);
		if (current !== void 0 && matchesIntent(current, intent)) {
			const alreadyApplied = current.phase === "complete" || current.phase === "active" && current.activation === "armed";
			current = resumeMatchingGoal(ctx, agent, current);
			await flushGoalSession(ctx, agent);
			return installResult(current.phase === "complete" ? "already-complete" : alreadyApplied ? "already-applied" : "applied", current, intent.objectiveHash);
		}
		if (current?.objective === intent.objective) throw new LocalGoalError(`Goal install intent ${JSON.stringify(intent.installId)} conflicts with the current round cap`, "STALE_GOAL");
		if (!mayReplaceCurrent(current, intent.expectedGoalRef)) throw new LocalGoalError(`Goal install intent ${JSON.stringify(intent.installId)} has a stale expected GoalRef`, "STALE_GOAL");
		if (current !== void 0 && current.phase !== "complete") {
			if (current.phase === "active") current = ctx.goals.pause(agent, refOf(current));
			ctx.goals.clear(agent, refOf(current));
		}
		const created = ctx.goals.create(agent, {
			objective: intent.objective,
			maxGoalRounds: intent.maxGoalRounds
		});
		await flushGoalSession(ctx, agent);
		return installResult("applied", created, intent.objectiveHash);
	});
}
/**
* Durably pause the current local Goal, then claim the native maintenance
* phase only when an observed Agent turn still needs the review fallback.
*/
async function pauseLocalGoal(ctx, sessionId, signal) {
	const agent = resolveLocalAgent$1(ctx, sessionId);
	const result$1 = await pauseGoalContinuation(ctx, agent);
	assertStillLocal$1(ctx, agent);
	const observedTurn = observeOpenAgentTurn(agent);
	if (agent.status !== "running" || observedTurn === void 0) return result$1;
	const reviewHold = await acquireLocalReviewHold(ctx, sessionId, observedTurn, signal);
	return {
		...result$1,
		...reviewHold.hold === void 0 ? {} : { hold: reviewHold.hold }
	};
}
/**
* Claim the narrow review fallback barrier for one exact Session. This is
* event-driven and deliberately bounded: one observed turn cancellation, one
* join after a claim race, and one retry. A continuously user-driven Session
* is reported as an override instead of being cancelled in a loop.
*/
async function acquireLocalReviewHold(ctx, sessionId, expectedTurn, signal) {
	assertPositiveTurn(expectedTurn);
	signal?.throwIfAborted();
	const agent = resolveLocalAgent$1(ctx, sessionId);
	const active = activeHolds.get(agent);
	if (active !== void 0 && !active.released && !active.closed) return active.expectedTurn === expectedTurn ? {
		outcome: "held",
		hold: publicHold(active)
	} : { outcome: "user-override" };
	const acquiring = acquiringHolds.get(agent);
	if (acquiring !== void 0) {
		if (acquiring.expectedTurn !== expectedTurn) return { outcome: "user-override" };
		return {
			outcome: "held",
			hold: publicHold(await acquiring.promise)
		};
	}
	if (agent.status !== "running") return { outcome: "not-required" };
	if (observeOpenAgentTurn(agent) !== expectedTurn) return { outcome: "user-override" };
	agent.cancel({
		kind: "hook",
		reason: CONTROL_CANCEL_REASON
	}, { keepInbox: true });
	await waitForAgentIdle(agent, signal);
	assertStillLocal$1(ctx, agent);
	signal?.throwIfAborted();
	const acquisition = acquireMaintenanceHoldBounded(ctx, agent, expectedTurn, signal);
	acquiringHolds.set(agent, {
		expectedTurn,
		promise: acquisition
	});
	try {
		const hold = await acquisition;
		if (signal?.aborted) {
			await publicHold(hold).release();
			signal.throwIfAborted();
		}
		return {
			outcome: "held",
			hold: publicHold(hold)
		};
	} catch (error) {
		if (error instanceof LocalGoalError && error.code === "SESSION_BUSY") return { outcome: "user-override" };
		throw error;
	} finally {
		if (acquiringHolds.get(agent)?.promise === acquisition) acquiringHolds.delete(agent);
	}
}
/** Return the exact currently open durable turn, never merely Agent `running`. */
function observeOpenAgentTurn(agent) {
	const boundary = agent.session.events.findLast((event) => event.type === "turn/start" || event.type === "turn/end");
	if (boundary?.type !== "turn/start") return void 0;
	assertPositiveTurn(boundary.data.turn);
	return boundary.data.turn;
}
/**
* Stop only automatic Goal continuation. Used by `/autolab pause`: it never
* cancels the current LLM turn and never acquires a maintenance barrier.
*/
async function pauseLocalGoalContinuation(ctx, sessionId) {
	return await pauseGoalContinuation(ctx, resolveLocalAgent$1(ctx, sessionId));
}
async function pauseGoalContinuation(ctx, agent) {
	const current = ctx.goals.get(agent);
	let outcome;
	let ref;
	if (current?.phase === "active") {
		ref = refOf(ctx.goals.pause(agent, refOf(current)));
		outcome = "paused";
		await flushGoalSession(ctx, agent);
	} else if (current?.phase === "paused") {
		ref = refOf(current);
		outcome = "already-applied";
		await flushGoalSession(ctx, agent);
	} else {
		ref = current === void 0 ? void 0 : refOf(current);
		outcome = "no-active-goal";
	}
	assertStillLocal$1(ctx, agent);
	return {
		outcome,
		...ref === void 0 ? {} : { ref }
	};
}
const activeHolds = /* @__PURE__ */ new WeakMap();
const acquiringHolds = /* @__PURE__ */ new WeakMap();
async function runInMaintenance(ctx, agent, operation) {
	const active = activeHolds.get(agent);
	if (active !== void 0 && !active.released && !active.closed) return await submitHoldJob(active, operation);
	const acquiring = acquiringHolds.get(agent);
	if (acquiring !== void 0) return await submitHoldJob(await acquiring.promise, operation);
	assertStillLocal$1(ctx, agent);
	let entered = false;
	try {
		return await agent.runMaintenance(async (signal) => {
			entered = true;
			return await operation(signal);
		});
	} catch (error) {
		if (entered) throw error;
		await agent.whenIdle();
		assertStillLocal$1(ctx, agent);
		let retryEntered = false;
		try {
			return await agent.runMaintenance(async (signal) => {
				retryEntered = true;
				return await operation(signal);
			});
		} catch (retryError) {
			if (retryEntered) throw retryError;
			throw new LocalGoalError(`Session ${JSON.stringify(String(agent.id))} remained busy during an authorized Goal operation`, "SESSION_BUSY");
		}
	}
}
async function acquireMaintenanceHold(ctx, agent, expectedTurn) {
	assertStillLocal$1(ctx, agent);
	const ready = deferred();
	let state;
	const finished = agent.runMaintenance(async (signal) => {
		const claimed = await ready.promise;
		try {
			while (!claimed.released && !signal.aborted) {
				const job = claimed.jobs.shift();
				if (job !== void 0) {
					try {
						job.resolve(await job.run(signal));
					} catch (error) {
						job.reject(error);
					}
					continue;
				}
				await waitForHoldWork(claimed, signal);
			}
		} finally {
			claimed.closed = true;
			while (claimed.jobs.length > 0) claimed.jobs.shift().reject(new LocalGoalError("AutoLab maintenance hold was released before the operation ran", "HOLD_RELEASED"));
		}
	});
	state = {
		agent,
		expectedTurn,
		jobs: [],
		finished,
		closed: false,
		released: false,
		wake: void 0
	};
	ready.resolve(state);
	activeHolds.set(agent, state);
	finished.finally(() => {
		if (activeHolds.get(agent) === state) activeHolds.delete(agent);
	}).catch(() => void 0);
	return state;
}
async function acquireMaintenanceHoldBounded(ctx, agent, expectedTurn, signal) {
	signal?.throwIfAborted();
	try {
		return await acquireMaintenanceHold(ctx, agent, expectedTurn);
	} catch (error) {
		if (error instanceof LocalGoalError) throw error;
		await waitForAgentIdle(agent, signal);
		assertStillLocal$1(ctx, agent);
		signal?.throwIfAborted();
		try {
			return await acquireMaintenanceHold(ctx, agent, expectedTurn);
		} catch (retryError) {
			if (retryError instanceof LocalGoalError) throw retryError;
			throw new LocalGoalError(`Session ${JSON.stringify(String(agent.id))} remained busy during review freeze`, "SESSION_BUSY");
		}
	}
}
async function waitForAgentIdle(agent, signal) {
	if (signal === void 0) {
		await agent.whenIdle();
		return;
	}
	signal.throwIfAborted();
	let onAbort;
	const aborted = new Promise((_resolve, reject) => {
		onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		await Promise.race([agent.whenIdle(), aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}
function assertPositiveTurn(turn) {
	if (!Number.isSafeInteger(turn) || turn <= 0) throw new LocalGoalError(`review turn must be a positive safe integer, got ${String(turn)}`, "INVALID_TURN");
}
function submitHoldJob(state, operation) {
	if (state.released || state.closed) throw new LocalGoalError("AutoLab maintenance hold is already released", "HOLD_RELEASED");
	return new Promise((resolve$1, reject) => {
		state.jobs.push({
			run: operation,
			resolve: resolve$1,
			reject
		});
		state.wake?.();
	});
}
function publicHold(state) {
	return { async release() {
		if (!state.released) {
			state.released = true;
			state.wake?.();
		}
		await state.finished;
	} };
}
async function waitForHoldWork(state, signal) {
	if (state.released || state.jobs.length > 0 || signal.aborted) return;
	await new Promise((resolve$1) => {
		const wake = () => {
			signal.removeEventListener("abort", wake);
			if (state.wake === wake) state.wake = void 0;
			resolve$1();
		};
		state.wake = wake;
		signal.addEventListener("abort", wake, { once: true });
		if (state.released || state.jobs.length > 0 || signal.aborted) wake();
	});
}
function resumeMatchingGoal(ctx, agent, current) {
	if (current.phase === "complete") return current;
	if (current.phase === "active" && current.activation === "armed") return current;
	if (current.roundsStarted >= current.maxGoalRounds) throw new LocalGoalError(`Goal ${JSON.stringify(String(current.id))} exhausted ${current.maxGoalRounds} rounds`, "ROUND_BUDGET_EXHAUSTED");
	return ctx.goals.resume(agent, refOf(current));
}
function matchesIntent(current, intent) {
	return current.objective === intent.objective && sha256$1(current.objective) === intent.objectiveHash && current.maxGoalRounds === intent.maxGoalRounds;
}
function mayReplaceCurrent(current, expected) {
	if (current === void 0) return true;
	if (expected === null) return false;
	if (sameRef(current, expected)) return true;
	return current.id === expected.id && current.revision === expected.revision + 1 && current.phase === "paused";
}
function installResult(outcome, goal, objectiveHash) {
	return {
		outcome,
		ref: refOf(goal),
		objectiveHash,
		roundsStarted: goal.roundsStarted
	};
}
function resolveLocalAgent$1(ctx, rawSessionId) {
	const agent = ctx.agents.get(SessionId(rawSessionId));
	if (agent === void 0) throw new LocalGoalError(`Session ${JSON.stringify(rawSessionId)} is not a live Agent in this process`, "SESSION_NOT_LOCAL");
	return agent;
}
async function flushGoalSession(ctx, agent) {
	if (!await ctx.sessions.flush(agent.session)) throw new LocalGoalError(`Session ${JSON.stringify(String(agent.id))} has no durability listener`, "DURABILITY_UNAVAILABLE");
}
function assertStillLocal$1(ctx, agent) {
	if (ctx.agents.get(agent.id) !== agent) throw new LocalGoalError(`Session ${JSON.stringify(String(agent.id))} is no longer the live Agent in this process`, "SESSION_NOT_LOCAL");
}
function validateIntentInput(input) {
	if (input.installId.length === 0 || input.assignmentId.length === 0 || input.packetPath.length === 0 || input.body.trim().length === 0 || !SHA256_PATTERN$9.test(input.packetHash) || !Number.isSafeInteger(input.maxGoalRounds) || input.maxGoalRounds <= 0 || input.expectedGoalRef !== null && (String(input.expectedGoalRef.id).length === 0 || !Number.isSafeInteger(input.expectedGoalRef.revision) || input.expectedGoalRef.revision <= 0)) throw new LocalGoalError("invalid local Goal install intent", "INVALID_INTENT");
}
function refOf(goal) {
	return {
		id: goal.id,
		revision: goal.revision
	};
}
function sameRef(goal, ref) {
	return goal.id === ref.id && goal.revision === ref.revision;
}
function sha256$1(value) {
	return createHash("sha256").update(value).digest("hex");
}
function deferred() {
	let resolve$1;
	return {
		promise: new Promise((done) => {
			resolve$1 = done;
		}),
		resolve: resolve$1
	};
}

//#endregion
//#region src/review.ts
const REVIEW_REQUEST = "REVIEW_REQUEST";
const REVIEW_ACCEPTED_PAUSE = "REVIEW_ACCEPTED_PAUSE";
/** Fixed audit text. It is never executed as a slash command or sent to a model Inbox. */
const REVIEW_ACCEPTED_TEXT = "已收到，请等待审核。\n/goal pause";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN$8 = /^[0-9a-f]{64}$/u;
/** Compile the one immutable marker for a route whose effect already exists. */
function compileReviewResolution(input) {
	const body = {
		version: 1,
		reviewId: input.reviewId,
		verdictHash: input.verdictHash,
		targetRoleId: input.targetRoleId,
		targetSessionId: input.targetSessionId,
		effect: { ...input.effect }
	};
	return reviewResolutionStateSchema.parse({
		...body,
		resolutionHash: resolutionHash(body)
	});
}
var ReviewProtocolError = class extends Error {
	name = "ReviewProtocolError";
	constructor(message, code) {
		super(message);
		this.code = code;
	}
};
/** Compile the only two legal payloads and bind both canonical payload hashes. */
function compileReviewControlCapability(input) {
	validateCapabilityInput(input);
	const expectedGoalRef = freezeGoalRef(input.expectedGoalRef);
	const base$1 = Object.freeze({
		version: 1,
		reviewId: input.reviewId,
		assignmentId: input.assignmentId,
		configRevision: input.configRevision,
		runtimeRevision: input.runtimeRevision,
		ownerFence: input.ownerFence,
		workerRoleId: input.workerRoleId,
		workerSessionId: input.workerSessionId,
		judgeRoleId: input.judgeRoleId,
		judgeSessionId: input.judgeSessionId,
		packetHash: input.packetHash,
		artifactHash: input.artifactHash,
		negotiatedAnchorHash: input.negotiatedAnchorHash,
		sourceTurn: input.sourceTurn,
		expectedGoalRef
	});
	const requestPayloadHash = controlPayloadHash(asJson(requestPayloadFrom(base$1, input.requestControlId)));
	const acceptedPayload = acceptedPayloadFrom(base$1, input.acceptedPauseControlId, input.requestControlId, requestPayloadHash);
	return Object.freeze({
		...base$1,
		request: Object.freeze({
			controlId: input.requestControlId,
			payloadHash: requestPayloadHash
		}),
		acceptedPause: Object.freeze({
			controlId: input.acceptedPauseControlId,
			payloadHash: controlPayloadHash(asJson(acceptedPayload))
		})
	});
}
function reviewRequestPayload(capabilityInput) {
	const capability = normalizeCapability(capabilityInput);
	return requestPayloadFrom(capability, capability.request.controlId);
}
function reviewAcceptedPausePayload(capabilityInput) {
	const capability = normalizeCapability(capabilityInput);
	return acceptedPayloadFrom(capability, capability.acceptedPause.controlId, capability.request.controlId, capability.request.payloadHash);
}
/** Send the exact REVIEW_REQUEST from the reviewed root Agent. */
async function sendReviewRequest(ctx, caller, capabilityInput, signal) {
	const capability = normalizeCapability(capabilityInput);
	if (String(caller.id) !== capability.workerSessionId) throw new ReviewProtocolError("REVIEW_REQUEST caller does not match the capability worker Session", "CAPABILITY_MISMATCH");
	return await ctx.sessionMessaging.sendControl(caller, {
		controlId: capability.request.controlId,
		recipient: capability.judgeSessionId,
		kind: REVIEW_REQUEST,
		payload: asJson(requestPayloadFrom(capability, capability.request.controlId)),
		payloadHash: capability.request.payloadHash,
		waitForAcknowledgement: false
	}, signal);
}
/**
* Build both non-model handlers. Replays deliberately call the two existing
* idempotent transport boundary again. Judge work is deliberately not started
* here: the Controller starts it only after the pause outcome and stopped/held
* freeze are durable.
*/
function createReviewControlHandlers(ctx, options) {
	return Object.freeze({
		request: {
			authorize: async (control) => {
				options.signal?.throwIfAborted();
				const capability = authorizedCapability(control, "request", options);
				options.signal?.throwIfAborted();
				return capability !== void 0;
			},
			handle: (control) => runReviewHandler(options, async () => {
				options.signal?.throwIfAborted();
				const capability = authorizedCapability(control, "request", options);
				options.signal?.throwIfAborted();
				if (capability === void 0) return capabilityRejected();
				const judge = resolveLocalAgent(ctx, capability.judgeSessionId);
				const acceptedPayload = acceptedPayloadFrom(capability, capability.acceptedPause.controlId, capability.request.controlId, capability.request.payloadHash);
				const acceptedRequest = {
					controlId: capability.acceptedPause.controlId,
					recipient: capability.workerSessionId,
					kind: REVIEW_ACCEPTED_PAUSE,
					payload: asJson(acceptedPayload),
					payloadHash: capability.acceptedPause.payloadHash,
					waitForAcknowledgement: false
				};
				const accepted = options.signal === void 0 ? await ctx.sessionMessaging.sendControl(judge, acceptedRequest) : await ctx.sessionMessaging.sendControl(judge, acceptedRequest, options.signal);
				if (accepted.status === "failed" || accepted.status === "expired" || accepted.outcome?.status === "failed" || accepted.outcome?.status === "rejected") throw new ReviewProtocolError(`review ACK control ${accepted.controlId} is ${accepted.outcome?.status ?? accepted.status}`, "CONTROL_DELIVERY_FAILED");
				options.signal?.throwIfAborted();
				return {
					status: "completed",
					result: asJson({
						version: 1,
						type: "REVIEW_REQUEST_OUTCOME",
						reviewId: capability.reviewId,
						acceptedPauseControlId: capability.acceptedPause.controlId,
						acceptedPausePayloadHash: capability.acceptedPause.payloadHash,
						acceptedPauseTransportStatus: accepted.status,
						judgeStart: "awaiting-pause"
					})
				};
			})
		},
		acceptedPause: {
			authorize: async (control) => {
				options.signal?.throwIfAborted();
				const capability = authorizedCapability(control, "acceptedPause", options);
				options.signal?.throwIfAborted();
				return capability !== void 0;
			},
			handle: (control) => runReviewHandler(options, async () => {
				options.signal?.throwIfAborted();
				const capability = authorizedCapability(control, "acceptedPause", options);
				options.signal?.throwIfAborted();
				if (capability === void 0) return capabilityRejected();
				const paused = await pauseExpectedReviewGoal(ctx, capability.workerSessionId, capability.expectedGoalRef, capability.sourceTurn);
				return {
					status: "completed",
					result: asJson({
						version: 1,
						type: "REVIEW_PAUSE_OUTCOME",
						reviewId: capability.reviewId,
						requestControlId: capability.request.controlId,
						acknowledgement: REVIEW_ACCEPTED_TEXT,
						goalAction: "pause",
						goalOutcome: paused.outcome,
						activeTurn: paused.activeTurn,
						turnOutcome: paused.turnOutcome,
						...paused.observedTurn === void 0 ? {} : { observedTurn: paused.observedTurn },
						...paused.ref === void 0 ? {} : { goalRef: paused.ref }
					})
				};
			})
		}
	});
}
function runReviewHandler(options, operation) {
	return options.runHandler === void 0 ? operation() : options.runHandler(operation);
}
/** Register both kinds on the existing messaging transport; no daemon or poller is created. */
function registerReviewControlHandlers(ctx, options) {
	const handlers = createReviewControlHandlers(ctx, options);
	const removeRequest = ctx.sessionMessaging.registerControlHandler(REVIEW_REQUEST, handlers.request);
	let removeAccepted;
	try {
		removeAccepted = ctx.sessionMessaging.registerControlHandler(REVIEW_ACCEPTED_PAUSE, handlers.acceptedPause);
	} catch (error) {
		removeRequest();
		throw error;
	}
	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		removeAccepted();
		removeRequest();
	};
}
/**
* Pause only the Goal named by the review capability. This path flushes the
* durable phase but never cancels an Agent, acquires maintenance, or sends any
* model input.
*/
async function pauseExpectedReviewGoal(ctx, sessionId, expectedGoalRef, sourceTurn) {
	validateGoalRef(expectedGoalRef);
	validateTurn(sourceTurn);
	const agent = resolveLocalAgent(ctx, sessionId);
	const classified = classifyReviewGoal(ctx.goals.get(agent), expectedGoalRef);
	let outcome;
	let ref = classified.ref;
	if (classified.outcome === "pause") {
		const exact = classified.ref;
		ref = plainGoalRef(ctx.goals.pause(agent, {
			id: GoalId(exact.id),
			revision: exact.revision
		}));
		outcome = "paused";
		await flushReviewSession(ctx, agent);
	} else {
		outcome = classified.outcome;
		if (outcome === "already-applied") await flushReviewSession(ctx, agent);
	}
	assertStillLocal(ctx, agent);
	const observedTurn = outcome !== "stale" && agent.status === "running" ? observeOpenAgentTurn(agent) : void 0;
	const turnOutcome = observedTurn === void 0 ? "stopped" : observedTurn === sourceTurn ? "source-active" : "user-override";
	return {
		outcome,
		...ref === void 0 ? {} : { ref },
		activeTurn: observedTurn !== void 0,
		...observedTurn === void 0 ? {} : { observedTurn },
		turnOutcome
	};
}
function authorizedCapability(control, direction, options) {
	let capability;
	try {
		const resolved = options.resolveCapability(control.controlId);
		if (resolved === void 0) return void 0;
		capability = normalizeCapability(resolved);
	} catch (error) {
		options.signal?.throwIfAborted();
		if (error instanceof Error && error.name === "AbortError") throw error;
		return;
	}
	return matchesControl(control, capability, direction) ? capability : void 0;
}
function matchesControl(control, capability, direction) {
	const requestDirection = direction === "request";
	const edge = requestDirection ? capability.request : capability.acceptedPause;
	const kind = requestDirection ? REVIEW_REQUEST : REVIEW_ACCEPTED_PAUSE;
	const senderSessionId = requestDirection ? capability.workerSessionId : capability.judgeSessionId;
	const recipientSessionId = requestDirection ? capability.judgeSessionId : capability.workerSessionId;
	const payload = requestDirection ? requestPayloadFrom(capability, capability.request.controlId) : acceptedPayloadFrom(capability, capability.acceptedPause.controlId, capability.request.controlId, capability.request.payloadHash);
	try {
		return control.controlId === edge.controlId && control.kind === kind && control.payloadHash === edge.payloadHash && String(control.senderSessionId) === senderSessionId && String(control.senderPrincipalSessionId) === senderSessionId && String(control.recipientSessionId) === recipientSessionId && String(control.recipientPrincipalSessionId) === recipientSessionId && canonicalJson(control.payload) === canonicalJson(asJson(payload));
	} catch {
		return false;
	}
}
function normalizeCapability(input) {
	if (input === null || typeof input !== "object") invalidCapability();
	const candidate = input;
	const compiled = compileReviewControlCapability({
		reviewId: candidate.reviewId,
		assignmentId: candidate.assignmentId,
		configRevision: candidate.configRevision,
		runtimeRevision: candidate.runtimeRevision,
		ownerFence: candidate.ownerFence,
		workerRoleId: candidate.workerRoleId,
		workerSessionId: candidate.workerSessionId,
		judgeRoleId: candidate.judgeRoleId,
		judgeSessionId: candidate.judgeSessionId,
		packetHash: candidate.packetHash,
		artifactHash: candidate.artifactHash,
		negotiatedAnchorHash: candidate.negotiatedAnchorHash,
		sourceTurn: candidate.sourceTurn,
		expectedGoalRef: candidate.expectedGoalRef,
		requestControlId: candidate.request?.controlId,
		acceptedPauseControlId: candidate.acceptedPause?.controlId
	});
	if (candidate.version !== 1 || candidate.request?.payloadHash !== compiled.request.payloadHash || candidate.acceptedPause?.payloadHash !== compiled.acceptedPause.payloadHash) invalidCapability();
	return compiled;
}
function requestPayloadFrom(capability, requestControlId) {
	return Object.freeze({
		version: 1,
		type: REVIEW_REQUEST,
		requestControlId,
		reviewId: capability.reviewId,
		assignmentId: capability.assignmentId,
		configRevision: capability.configRevision,
		runtimeRevision: capability.runtimeRevision,
		ownerFence: capability.ownerFence,
		sourceRoleId: capability.workerRoleId,
		sourceSessionId: capability.workerSessionId,
		targetRoleId: capability.judgeRoleId,
		targetSessionId: capability.judgeSessionId,
		packetHash: capability.packetHash,
		artifactHash: capability.artifactHash,
		negotiatedAnchorHash: capability.negotiatedAnchorHash,
		sourceTurn: capability.sourceTurn,
		expectedGoalRef: freezeGoalRef(capability.expectedGoalRef)
	});
}
function acceptedPayloadFrom(capability, acceptedPauseControlId, requestControlId, requestPayloadHash) {
	return Object.freeze({
		version: 1,
		type: REVIEW_ACCEPTED_PAUSE,
		acceptedPauseControlId,
		requestControlId,
		requestPayloadHash,
		reviewId: capability.reviewId,
		assignmentId: capability.assignmentId,
		configRevision: capability.configRevision,
		runtimeRevision: capability.runtimeRevision,
		ownerFence: capability.ownerFence,
		sourceRoleId: capability.judgeRoleId,
		sourceSessionId: capability.judgeSessionId,
		targetRoleId: capability.workerRoleId,
		targetSessionId: capability.workerSessionId,
		packetHash: capability.packetHash,
		artifactHash: capability.artifactHash,
		negotiatedAnchorHash: capability.negotiatedAnchorHash,
		sourceTurn: capability.sourceTurn,
		expectedGoalRef: freezeGoalRef(capability.expectedGoalRef),
		acknowledgement: REVIEW_ACCEPTED_TEXT,
		goalAction: "pause"
	});
}
function reviewJudgeStart(capabilityInput) {
	const capability = normalizeCapability(capabilityInput);
	return Object.freeze({
		wakeId: capability.reviewId,
		reviewId: capability.reviewId,
		assignmentId: capability.assignmentId,
		judgeSessionId: capability.judgeSessionId,
		workerSessionId: capability.workerSessionId,
		configRevision: capability.configRevision,
		runtimeRevision: capability.runtimeRevision,
		ownerFence: capability.ownerFence,
		packetHash: capability.packetHash,
		artifactHash: capability.artifactHash,
		negotiatedAnchorHash: capability.negotiatedAnchorHash
	});
}
function classifyReviewGoal(current, expected) {
	if (current === void 0) return { outcome: "no-active-goal" };
	const ref = plainGoalRef(current);
	if (expected === null) return current.phase === "complete" ? {
		outcome: "no-active-goal",
		ref
	} : {
		outcome: "stale",
		ref
	};
	if (String(current.id) !== expected.id) return {
		outcome: "stale",
		ref
	};
	if (current.phase === "active") return current.revision === expected.revision ? {
		outcome: "pause",
		ref
	} : {
		outcome: "stale",
		ref
	};
	if (current.phase === "paused") return current.revision === expected.revision || current.revision === expected.revision + 1 ? {
		outcome: "already-applied",
		ref
	} : {
		outcome: "stale",
		ref
	};
	return current.revision >= expected.revision ? {
		outcome: "no-active-goal",
		ref
	} : {
		outcome: "stale",
		ref
	};
}
function resolveLocalAgent(ctx, rawSessionId) {
	const agent = ctx.agents.get(SessionId(rawSessionId));
	if (agent === void 0) throw new ReviewProtocolError(`Session ${JSON.stringify(rawSessionId)} is not a live Agent in this process`, "SESSION_NOT_LOCAL");
	return agent;
}
function assertStillLocal(ctx, agent) {
	if (ctx.agents.get(agent.id) !== agent) throw new ReviewProtocolError(`Session ${JSON.stringify(String(agent.id))} is no longer local`, "SESSION_NOT_LOCAL");
}
async function flushReviewSession(ctx, agent) {
	if (!await ctx.sessions.flush(agent.session)) throw new ReviewProtocolError(`Session ${JSON.stringify(String(agent.id))} has no durability listener`, "DURABILITY_UNAVAILABLE");
}
function validateCapabilityInput(input) {
	if (!nonEmpty(input.reviewId) || !nonEmpty(input.assignmentId) || !Number.isSafeInteger(input.configRevision) || input.configRevision <= 0 || !Number.isSafeInteger(input.runtimeRevision) || input.runtimeRevision < 0 || !UUID_PATTERN.test(input.ownerFence) || !nonEmpty(input.workerRoleId) || !nonEmpty(input.workerSessionId) || !nonEmpty(input.judgeRoleId) || !nonEmpty(input.judgeSessionId) || input.workerSessionId === input.judgeSessionId || !SHA256_PATTERN$8.test(input.packetHash) || !SHA256_PATTERN$8.test(input.artifactHash) || !SHA256_PATTERN$8.test(input.negotiatedAnchorHash) || !Number.isSafeInteger(input.sourceTurn) || input.sourceTurn <= 0 || !UUID_PATTERN.test(input.requestControlId) || !UUID_PATTERN.test(input.acceptedPauseControlId) || input.requestControlId === input.acceptedPauseControlId) invalidCapability();
	validateGoalRef(input.expectedGoalRef);
}
function validateTurn(value) {
	if (!Number.isSafeInteger(value) || value <= 0) invalidCapability();
}
function validateGoalRef(value) {
	if (value === null) return;
	if (typeof value !== "object" || Array.isArray(value) || !nonEmpty(value.id) || !Number.isSafeInteger(value.revision) || value.revision <= 0) invalidCapability();
}
function freezeGoalRef(value) {
	validateGoalRef(value);
	return value === null ? null : Object.freeze({
		id: value.id,
		revision: value.revision
	});
}
function plainGoalRef(goal) {
	return {
		id: String(goal.id),
		revision: goal.revision
	};
}
function invalidCapability() {
	throw new ReviewProtocolError("invalid or altered review control capability", "INVALID_CAPABILITY");
}
function capabilityRejected() {
	return {
		status: "rejected",
		detail: "review capability is absent, stale, or does not match the envelope"
	};
}
function nonEmpty(value) {
	return typeof value === "string" && value.length > 0 && !value.includes("\0");
}
function asJson(value) {
	return value;
}

//#endregion
//#region src/approved-coder-activation.ts
var ApprovedCoderActivationError = class extends Error {
	name = "ApprovedCoderActivationError";
	constructor(message, code) {
		super(message);
		this.code = code;
	}
};
/**
* Freeze the exact APPROVED Method/Preflight inputs, then compile the one Coder
* Goal identity. The caller has already selected this review; this function
* performs no comparison, promotion, or scientific routing.
*/
async function freezeApprovedCoderActivation(input) {
	const artifacts = await freezeApprovedCoderArtifacts(input.artifacts);
	return {
		...compileApprovedCoderActivation({
			reviewId: input.artifacts.reviewId,
			verdictHash: input.artifacts.preflightVerdict.sha256,
			coderRoleId: input.artifacts.coderRole.role_id,
			coderSessionId: input.artifacts.coderSessionId,
			assignmentId: artifacts.assignmentId,
			packetPath: artifacts.packetPath,
			packetHash: artifacts.packet.packetHash,
			objectiveBody: artifacts.objectiveBody,
			maxGoalRounds: input.maxGoalRounds,
			expectedGoalRef: input.expectedGoalRef,
			...input.installId === void 0 ? {} : { installId: input.installId }
		}),
		artifacts
	};
}
/** Compile the deterministic control identities after immutable artifacts exist. */
function compileApprovedCoderActivation(input) {
	const expectedAssignmentId = `coder:${input.reviewId}`;
	if (input.assignmentId !== expectedAssignmentId) throw new ApprovedCoderActivationError(`Coder Assignment ${JSON.stringify(input.assignmentId)} does not match review ${JSON.stringify(input.reviewId)}`, "IDENTITY_MISMATCH");
	const goalIntent = compileLocalGoalIntent({
		installId: input.installId ?? `${input.assignmentId}:install:1`,
		assignmentId: input.assignmentId,
		packetPath: input.packetPath,
		packetHash: input.packetHash,
		body: input.objectiveBody,
		maxGoalRounds: input.maxGoalRounds,
		expectedGoalRef: input.expectedGoalRef
	});
	const resolution = compileReviewResolution({
		reviewId: input.reviewId,
		verdictHash: input.verdictHash,
		targetRoleId: input.coderRoleId,
		targetSessionId: input.coderSessionId,
		effect: {
			kind: "goal_install",
			id: goalIntent.installId,
			hash: goalIntent.objectiveHash
		}
	});
	return {
		reviewId: input.reviewId,
		coderRoleId: input.coderRoleId,
		coderSessionId: input.coderSessionId,
		packet: {
			path: input.packetPath,
			hash: input.packetHash
		},
		goalIntent,
		resolution
	};
}
/**
* Build the short CAS projection that must precede the native Goal mutation.
* Exact retries are no-ops; a different in-flight activation is not overwritten.
*/
function stageApprovedCoderActivation(role, plan) {
	assertRoleSession(role, plan);
	const current = role.goalInstall;
	if (current !== void 0 && sameInstallIdentity(current, plan)) {
		assertPacket(role, plan);
		if (current.status === "applied") return role;
	} else if (current !== void 0) {
		if (current.status !== "applied" || !sameGoalRef(current, plan.goalIntent.expectedGoalRef)) throw new ApprovedCoderActivationError(`Coder Session ${JSON.stringify(role.sessionId)} already has another in-flight Goal activation`, "ACTIVATION_CONFLICT");
	}
	const expected = plan.goalIntent.expectedGoalRef;
	return roleStateSchema.parse({
		...role,
		packet: plan.packet,
		goalInstall: {
			installId: plan.goalIntent.installId,
			assignmentId: plan.goalIntent.assignmentId,
			objectiveHash: plan.goalIntent.objectiveHash,
			maxGoalRounds: plan.goalIntent.maxGoalRounds,
			status: "activating",
			...expected === null ? {} : {
				goalId: String(expected.id),
				goalRevision: expected.revision
			}
		}
	});
}
/** Install or adopt the exact Goal after the activating projection is durable. */
async function installApprovedCoderGoal(ctx, plan) {
	return await installLocalGoal(ctx, plan.coderSessionId, plan.goalIntent);
}
/** Build the second CAS projection after the native Goal mutation is durable. */
function applyApprovedCoderGoal(role, plan, result$1) {
	assertRoleSession(role, plan);
	assertPacket(role, plan);
	if (!sameInstallIdentity(role.goalInstall, plan)) throw new ApprovedCoderActivationError(`Coder Session ${JSON.stringify(role.sessionId)} activation changed before Goal apply`, "ACTIVATION_CONFLICT");
	if (result$1.objectiveHash !== plan.goalIntent.objectiveHash) throw new ApprovedCoderActivationError("native Goal result does not match the approved Coder activation", "IDENTITY_MISMATCH");
	if (result$1.outcome === "already-complete") throw new ApprovedCoderActivationError(`Coder Assignment ${JSON.stringify(plan.goalIntent.assignmentId)} already completed and requires receipt reconciliation`, "GOAL_ALREADY_COMPLETE");
	const { activationBlocker: _clearedAfterExactInstall,...base$1 } = role;
	return roleStateSchema.parse({
		...base$1,
		phase: "working",
		goalInstall: {
			installId: plan.goalIntent.installId,
			assignmentId: plan.goalIntent.assignmentId,
			objectiveHash: plan.goalIntent.objectiveHash,
			maxGoalRounds: plan.goalIntent.maxGoalRounds,
			status: "applied",
			goalId: String(result$1.ref.id),
			goalRevision: result$1.ref.revision
		}
	});
}
/**
* Record the already-applied Goal effect against the ready APPROVED review.
* The process-local review hold may be released only after this projection is
* durably committed by the caller.
*/
function resolveApprovedCoderReview(review, ownerEpoch, plan, updatedAt) {
	if (review.stage !== "preflight" || review.capability.reviewId !== plan.reviewId || review.verdict?.topLevelVerdict !== "APPROVED") throw new ApprovedCoderActivationError(`review ${JSON.stringify(plan.reviewId)} is not its exact APPROVED Preflight verdict`, "IDENTITY_MISMATCH");
	return recordReviewResolution(review, ownerEpoch, plan.resolution, updatedAt);
}
function assertRoleSession(role, plan) {
	if (role.sessionId !== plan.coderSessionId) throw new ApprovedCoderActivationError(`Coder role ${JSON.stringify(plan.coderRoleId)} is not bound to Session ${JSON.stringify(plan.coderSessionId)}`, "IDENTITY_MISMATCH");
}
function assertPacket(role, plan) {
	if (role.packet?.path !== plan.packet.path || role.packet.hash !== plan.packet.hash) throw new ApprovedCoderActivationError(`Coder Session ${JSON.stringify(role.sessionId)} does not project the approved Role Packet`, "ACTIVATION_CONFLICT");
}
function sameInstallIdentity(install, plan) {
	return install !== void 0 && install.installId === plan.goalIntent.installId && install.assignmentId === plan.goalIntent.assignmentId && install.objectiveHash === plan.goalIntent.objectiveHash && install.maxGoalRounds === plan.goalIntent.maxGoalRounds;
}
function sameGoalRef(install, ref) {
	return ref !== null && install.goalId === String(ref.id) && install.goalRevision === ref.revision;
}

//#endregion
//#region src/activation-artifacts.ts
const EMPTY_FACT_SET = canonicalJson$1({
	version: 1,
	facts: []
});
const EMPTY_EVIDENCE_INDEX = canonicalJson$1({
	version: 1,
	evidence: []
});
const SHA256_PATTERN$7 = /^[0-9a-f]{64}$/u;
var ActivationArtifactError = class extends Error {
	name = "ActivationArtifactError";
	constructor(message, code) {
		super(message);
		this.code = code;
	}
};
/**
* Compile immutable bootstrap packets directly from CURRENT and built-in exact
* texts. No model summarizes or rewrites any input on this path.
*/
async function freezeInitialRoleArtifacts(input) {
	const manifest = input.frozen.manifest;
	const labDirectory = manifest.authority_paths.lab_dir;
	const prompt = rolePromptFor(input.role.role_kind);
	const promptPath = join(labDirectory, "artifacts", "builtins", `${prompt.sha256}.txt`);
	await freezeExact$2(promptPath, prompt.text);
	const factSetHash = await freezeExact$2(manifest.authority_paths.fact_set, EMPTY_FACT_SET);
	const evidenceIndexHash = await freezeExact$2(manifest.authority_paths.evidence_index, EMPTY_EVIDENCE_INDEX);
	const laneId$2 = "lane_id" in input.role ? input.role.lane_id : void 0;
	const lane = laneId$2 === void 0 ? void 0 : manifest.search.lane_charters.find((candidate) => candidate.lane_id === laneId$2);
	if ("lane_id" in input.role && lane === void 0) throw new ActivationArtifactError(`Role ${input.role.role_id} references a missing LaneCharter`, "LANE_NOT_FOUND");
	const laneText = lane === void 0 ? void 0 : canonicalJson$1(lane.content);
	if (lane !== void 0 && sha256(laneText) !== lane.charter_sha256) throw new ActivationArtifactError("LaneCharter bytes do not match the manifest", "ARTIFACT_CONFLICT");
	const lanePath = lane === void 0 ? void 0 : join(labDirectory, "artifacts", "lanes", `${sha256(lane.lane_id)}.charter.json`);
	if (lanePath !== void 0) await freezeExact$2(lanePath, laneText);
	const assignmentId = input.role.role_kind === "method" ? `${input.role.lane_id}:method:initial` : `${input.role.role_id}:bootstrap`;
	const objectiveBody = initialObjective(input.frozen, input.role, lane);
	const assignmentPath = join(manifest.authority_paths.assignment_root, `${sha256(assignmentId)}.json`);
	const outputPath = join(manifest.authority_paths.assignment_root, "outputs", `${sha256(assignmentId)}.json`);
	const outputContract = {
		schema: input.role.role_kind === "method" ? methodDesignTicketOutputSchema() : idleOutputSchema(),
		receipt_path: outputPath,
		expected_hash_binding: input.role.role_kind === "method" ? METHOD_TICKET_HASH_BINDING : assignmentId
	};
	const assignmentText = canonicalJson$1({
		version: 1,
		assignment_id: assignmentId,
		role_id: input.role.role_id,
		role_kind: input.role.role_kind,
		objective: objectiveBody,
		output_contract: outputContract
	});
	const assignmentHash = await freezeExact$2(assignmentPath, assignmentText);
	const packet = compileRolePacket({
		manifest,
		role_id: input.role.role_id,
		session_id: input.sessionId,
		assignment_id: assignmentId,
		issued_at: input.issuedAt,
		role_binding_receipt_sha256: input.binding.hash,
		runtime_revision: input.runtimeRevision,
		fact_set_sha256: factSetHash,
		evidence_index_sha256: evidenceIndexHash,
		assignment_contract_sha256: assignmentHash,
		reveal_state: manifest.communication.reveal_policy.initial_state,
		verbatim_blocks: {
			universal: [{
				block_id: "lab-spec",
				source_path: manifest.authority_paths.lab_spec,
				exact_text: input.frozen.spec,
				text_sha256: input.frozen.ref.specHash
			}],
			role: [{
				block_id: "role-prompt",
				source_path: promptPath,
				exact_text: prompt.text,
				text_sha256: prompt.sha256
			}],
			lane: lane === void 0 ? [] : [{
				block_id: "lane-charter",
				source_path: lanePath,
				exact_text: laneText,
				text_sha256: lane.charter_sha256
			}],
			stage: [],
			assignment: [{
				block_id: "assignment-contract",
				source_path: assignmentPath,
				exact_text: assignmentText,
				text_sha256: assignmentHash
			}]
		},
		relevant_fact_refs: [],
		evidence_refs: [],
		open_obligation_refs: [],
		input_artifact_refs: [],
		output_contract: outputContract
	});
	const packetPath = join(labDirectory, "packets", sha256(assignmentId), `${sha256(input.role.role_id)}.json`);
	if (await freezeExact$2(packetPath, packet.canonicalJson) !== packet.packetHash) throw new ActivationArtifactError("Role Packet file hash changed while committing", "ARTIFACT_CONFLICT");
	return {
		assignmentId,
		assignmentPath,
		assignmentHash,
		objectiveBody,
		packetPath,
		packet
	};
}
/**
* Read the role's already-persisted Packet and Assignment without compiling a
* bootstrap replacement or touching the live Fact/Evidence ledgers.
*
* Recompilation here is validation only: dynamic Packet fields are retained,
* while every manifest-derived field is regenerated from CURRENT and must
* reproduce the exact frozen Packet bytes.
*/
async function restoreCurrentRoleArtifacts(input) {
	await validateRestoreInput(input);
	const manifest = input.frozen.manifest;
	const packetText = await readRequiredText$1(input.packetRef.path, "Role Packet");
	if (sha256(packetText) !== input.packetRef.hash) conflict("Role Packet bytes do not match RuntimeState");
	let packet;
	try {
		packet = parseRolePacket(JSON.parse(packetText));
	} catch {
		conflict("Role Packet is not strict Role Packet v1 JSON");
	}
	const canonicalPacket = canonicalJson$1(packet);
	if (canonicalPacket !== packetText || sha256(canonicalPacket) !== input.packetRef.hash) conflict("Role Packet is not the exact canonical frozen packet");
	await assertPacketIdentity(input, packet);
	const expectedPacketPath = join(manifest.authority_paths.lab_dir, "packets", sha256(packet.header.assignment_id), `${sha256(input.role.role_id)}.json`);
	if (input.packetRef.path !== expectedPacketPath) conflict("Role Packet path does not match its immutable identity");
	const packetRevision = await readRevisionAtPath(manifest.authority_paths.lab_dir, packet.anchors.source_revision, input.frozen);
	let recompiled;
	try {
		recompiled = compileRolePacket({
			manifest: packetRevision.manifest,
			role_id: packet.header.role_id,
			session_id: packet.header.session_id,
			assignment_id: packet.header.assignment_id,
			issued_at: packet.header.issued_at,
			role_binding_receipt_sha256: packet.anchors.role_binding_receipt_sha256,
			runtime_revision: packet.anchors.runtime_revision,
			fact_set_sha256: packet.anchors.fact_set_sha256,
			evidence_index_sha256: packet.anchors.evidence_index_sha256,
			assignment_contract_sha256: packet.anchors.assignment_contract_sha256,
			reveal_state: packet.runtime_snapshot.reveal_state,
			verbatim_blocks: packet.verbatim_blocks,
			...packet.runtime_snapshot.incumbent === void 0 ? {} : { incumbent: packet.runtime_snapshot.incumbent },
			relevant_fact_refs: packet.runtime_snapshot.relevant_fact_refs,
			evidence_refs: packet.runtime_snapshot.evidence_refs,
			open_obligation_refs: packet.runtime_snapshot.open_obligation_refs,
			input_artifact_refs: packet.runtime_snapshot.input_artifact_refs,
			output_contract: packet.output_contract
		});
	} catch {
		conflict("Role Packet cannot be reproduced from CURRENT");
	}
	if (recompiled.canonicalJson !== packetText || recompiled.packetHash !== input.packetRef.hash) conflict("Role Packet manifest-derived fields drifted from CURRENT");
	if (packet.verbatim_blocks.universal.find((block) => block.source_path === packetRevision.manifest.authority_paths.lab_spec && block.text_sha256 === packet.anchors.lab_spec_sha256 && sha256(block.exact_text) === packet.anchors.lab_spec_sha256) === void 0) {
		if (!await isStaleUniversalBlockTolerable(packet, packetRevision, manifest.authority_paths.lab_dir)) conflict("Role Packet does not carry its own exact LAB_SPEC block");
	}
	if (packet.verbatim_blocks.assignment.length !== 1) conflict("Role Packet must bind exactly one Assignment block");
	const assignmentBlock = packet.verbatim_blocks.assignment[0];
	if (assignmentBlock.byte_range !== void 0 || !isWithin(manifest.authority_paths.assignment_root, assignmentBlock.source_path) || assignmentBlock.text_sha256 !== packet.anchors.assignment_contract_sha256) conflict("Role Packet Assignment source does not match its authority anchor");
	const assignmentText = await readRequiredText$1(assignmentBlock.source_path, "Assignment contract");
	if (assignmentText !== assignmentBlock.exact_text || sha256(assignmentText) !== assignmentBlock.text_sha256) conflict("Assignment source bytes do not match the Role Packet block");
	const assignment = parseCanonicalAssignment(assignmentText);
	if (assignment.assignment_id !== packet.header.assignment_id) conflict("Assignment identity does not match the Role Packet");
	if (assignment.role_id !== void 0 && assignment.role_id !== packet.header.role_id) conflict("Assignment role does not match the Role Packet");
	if (assignment.role_kind !== void 0 && assignment.role_kind !== packet.header.role_kind) conflict("Assignment role kind does not match the Role Packet");
	if (assignment.runtime_revision !== void 0 && assignment.runtime_revision !== packet.anchors.runtime_revision) conflict("Assignment Controller revision does not match the Role Packet");
	if (canonicalJson$1(assignment.output_contract) !== canonicalJson$1(packet.output_contract)) conflict("Assignment output contract does not match the Role Packet");
	if (assignment.judge !== void 0 && (assignment.judge.role_id !== packet.header.role_id || assignment.judge.session_id !== packet.header.session_id)) conflict("Assignment Judge identity does not match the Role Packet");
	return {
		assignmentId: packet.header.assignment_id,
		assignmentPath: assignmentBlock.source_path,
		assignmentHash: assignmentBlock.text_sha256,
		objectiveBody: assignment.objective ?? assignment.instruction,
		packetPath: input.packetRef.path,
		packet: recompiled
	};
}
/**
* True when the packet's universal block is the exact known-buggy pattern: a
* single, internally consistent block whose bytes are an EARLIER committed
* revision's exact LAB_SPEC (path + hash + text all match), while the
* packet's anchors declare its own revision, and the packet carries no review
* lineage. Such packets were frozen by an earlier plugin build and are only
* superseded by the next Assignment; activation tolerates them so the
* superseding dispatch can proceed.
*/
async function isStaleUniversalBlockTolerable(packet, packetRevision, labDirectory) {
	if (packet.runtime_snapshot.incumbent !== void 0) return false;
	const blocks = packet.verbatim_blocks.universal;
	if (blocks.length !== 1) return false;
	const block = blocks[0];
	if (sha256(block.exact_text) !== block.text_sha256) return false;
	for (let revision = 1; revision < packetRevision.ref.revision; revision += 1) {
		const earlier = await readRevisionAtPath(labDirectory, revision, packetRevision);
		if (block.source_path !== earlier.manifest.authority_paths.lab_spec) continue;
		if (block.text_sha256 !== earlier.ref.specHash) continue;
		if (block.exact_text !== earlier.spec) continue;
		return true;
	}
	return false;
}
async function validateRestoreInput(input) {
	const manifest = input.frozen.manifest;
	const currentRole = manifest.roles.find((candidate) => candidate.role_id === input.role.role_id);
	if (currentRole === void 0 || currentRole.role_kind === "controller" || canonicalJson$1(currentRole) !== canonicalJson$1(input.role)) conflict("Role does not match CURRENT ResolvedManifest");
	if (!isAbsolute(input.packetRef.path) || !SHA256_PATTERN$7.test(input.packetRef.hash)) conflict("RuntimeState Packet reference is invalid");
	if (!Number.isSafeInteger(input.runtimeRevision) || input.runtimeRevision < 0) conflict("Controller revision is invalid");
	const manifestHash = sha256(canonicalJson$1(manifest));
	if (sha256(input.frozen.spec) !== input.frozen.ref.specHash || sha256(input.frozen.config) !== input.frozen.ref.configHash || manifestHash !== input.frozen.ref.manifestHash || input.frozen.validation.specHash !== input.frozen.ref.specHash || input.frozen.validation.configHash !== input.frozen.ref.configHash || input.frozen.validation.manifestHash !== input.frozen.ref.manifestHash || input.frozen.validation.dialogueHeadHash !== input.frozen.ref.dialogueHeadHash || manifest.source_revision !== input.frozen.ref.revision || manifest.anchors.dialogue_head_sha256 !== input.frozen.ref.dialogueHeadHash || manifest.anchors.lab_spec_sha256 !== input.frozen.ref.specHash || manifest.anchors.lab_yaml_sha256 !== input.frozen.ref.configHash) conflict("FrozenRevision does not match its CURRENT hashes");
	const receipt = input.binding.receipt;
	const manifestHashCommitted = await isCommittedManifestHash(manifest.authority_paths.lab_dir, receipt.manifestHash);
	const sessionSpec = resolveRootRoleSessionSpec(manifest, input.role.role_id);
	const expectedBindingPath = join(manifest.authority_paths.lab_dir, "receipts", "roles", `${sha256(input.role.role_id)}.json`);
	if (input.binding.path !== expectedBindingPath || input.binding.hash !== receipt.receiptHash || receipt.labId !== manifest.lab_id || !manifestHashCommitted || receipt.roleId !== input.role.role_id || receipt.roleKind !== input.role.role_kind || receipt.sessionId !== input.sessionId || receipt.permissionPresetId !== input.role.dsh_preset || receipt.provider !== input.role.model_route.provider || receipt.model !== input.role.model_route.model || receipt.cwd !== sessionSpec.cwd) conflict("RoleBindingReceipt does not match CURRENT role identity");
}
async function assertPacketIdentity(input, packet) {
	const manifest = input.frozen.manifest;
	const laneId$2 = "lane_id" in input.role ? input.role.lane_id : null;
	const anchor = packet.anchors;
	const packetRevision = await readRevisionAtPath(manifest.authority_paths.lab_dir, anchor.source_revision, input.frozen);
	if (packet.header.lab_id !== manifest.lab_id || packet.header.lane_id !== laneId$2 || packet.header.role_id !== input.role.role_id || packet.header.role_kind !== input.role.role_kind || packet.header.session_id !== input.sessionId || packet.header.issued_at < input.binding.receipt.issuedAt || anchor.source_revision > input.frozen.ref.revision || anchor.dialogue_head_sha256 !== packetRevision.ref.dialogueHeadHash || anchor.lab_spec_sha256 !== packetRevision.ref.specHash || anchor.lab_yaml_sha256 !== packetRevision.ref.configHash || anchor.resolved_manifest_sha256 !== packetRevision.ref.manifestHash || anchor.campaign_contract_sha256 !== packetRevision.manifest.campaign_contract_sha256 || anchor.role_binding_receipt_sha256 !== input.binding.hash || anchor.runtime_revision < input.binding.receipt.runtimeRevision || anchor.runtime_revision > input.runtimeRevision) conflict("Role Packet identity or immutable anchors do not match RuntimeState");
}
function parseCanonicalAssignment(text) {
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		conflict("Assignment contract is not JSON");
	}
	if (!isRecord(value) || canonicalJson$1(value) !== text || value.version !== 1 || typeof value.assignment_id !== "string" || value.assignment_id.length === 0 || value.role_id !== void 0 && (typeof value.role_id !== "string" || value.role_id.length === 0) || value.role_kind !== void 0 && (typeof value.role_kind !== "string" || value.role_kind.length === 0) || value.runtime_revision !== void 0 && (!Number.isSafeInteger(value.runtime_revision) || value.runtime_revision < 0) || value.objective !== void 0 && (typeof value.objective !== "string" || value.objective.length === 0) || value.instruction !== void 0 && (typeof value.instruction !== "string" || value.instruction.length === 0) || value.objective === void 0 && value.instruction === void 0 || !isJsonValue(value.output_contract)) conflict("Assignment contract does not satisfy the canonical Assignment envelope");
	if (value.judge !== void 0 && (!isRecord(value.judge) || typeof value.judge.role_id !== "string" || value.judge.role_id.length === 0 || typeof value.judge.session_id !== "string" || value.judge.session_id.length === 0)) conflict("Assignment Judge identity is invalid");
	return value;
}
function isJsonValue(value) {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	return isRecord(value) && Object.values(value).every(isJsonValue);
}
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isWithin(root, path) {
	const child = relative(root, path);
	return child.length > 0 && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}
async function readRequiredText$1(path, label) {
	try {
		return await readFile(path, "utf8");
	} catch {
		conflict(`${label} is missing or unreadable at ${path}`);
	}
}
function conflict(message) {
	throw new ActivationArtifactError(message, "ARTIFACT_CONFLICT");
}
function initialObjective(frozen, role, lane) {
	if (role.role_kind !== "method" || lane === void 0) return "Remain idle. Act only when the AutoLab Controller dispatches an authorized, hash-bound Assignment Packet.";
	return [
		"Read the exact LAB_SPEC and LaneCharter carried by the current Role Packet.",
		"Develop the first method proposal for this Lane and submit it to the bound Preflight Judge. Do not edit code.",
		"Respect every applicable constraint and preserved fact, distinguish method, feature or lens, implementation, measurement, and environment, and propose only work that can change the research decision."
	].join("\n");
}
function idleOutputSchema() {
	return {
		type: "object",
		additionalProperties: true
	};
}
async function freezeExact$2(path, bytes) {
	if (await readFile(path, "utf8").catch((error) => {
		if (isNodeError$7(error) && error.code === "ENOENT") return void 0;
		throw error;
	}) === void 0) try {
		await durableWriteFile(path, bytes, false);
	} catch (error) {
		if (!isNodeError$7(error) || error.code !== "EEXIST") throw error;
	}
	const committed = await readFile(path, "utf8");
	if (committed !== bytes) throw new ActivationArtifactError(`Immutable activation artifact conflicts at ${path}`, "ARTIFACT_CONFLICT");
	return sha256(committed);
}
function isNodeError$7(value) {
	return value instanceof Error && "code" in value;
}

//#endregion
//#region src/worktree.ts
const execFileAsync$1 = promisify(execFile);
const SHA_PATTERN$1 = /^[0-9a-f]{40,64}$/u;
const LANE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
var WorktreeError = class extends Error {
	name = "WorktreeError";
	constructor(message, code) {
		super(message);
		this.code = code;
	}
};
/**
* Resolve a set of refs against one exact Git worktree root. Commit uses this
* read-only discovery before freezing the manifest; start later verifies the
* same identities while provisioning each Lane worktree.
*/
async function resolveRepositoryRefs(repositoryPath, refs) {
	if (!isAbsolute(repositoryPath) || refs.length === 0 || refs.some((ref) => ref.length === 0)) throw new WorktreeError("repository path and refs must be non-empty", "INVALID_INPUT");
	const canonicalRepositoryPath = await canonicalDirectory(repositoryPath, "REPOSITORY_INVALID");
	if (await canonicalDirectory(await git$1(canonicalRepositoryPath, ["rev-parse", "--show-toplevel"]), "REPOSITORY_INVALID") !== canonicalRepositoryPath) throw new WorktreeError("repositoryPath must be the exact Git worktree root", "REPOSITORY_INVALID");
	const uniqueRefs = [...new Set(refs)];
	const entries = await Promise.all(uniqueRefs.map(async (ref) => [ref, await resolveCommit(canonicalRepositoryPath, ref)]));
	return {
		repositoryPath: canonicalRepositoryPath,
		commits: Object.freeze(Object.fromEntries(entries))
	};
}
/**
* Create or recover one long-lived Lane checkout using Git's own worktree
* identity. It neither schedules GPUs nor starts an Agent.
*/
async function provisionLaneWorktree(input) {
	validateInput$3(input);
	const labDirectory = await canonicalDirectory(input.labDirectory, "WORKTREE_MISSING");
	const repositoryPath = await canonicalDirectory(input.repositoryPath, "REPOSITORY_INVALID");
	const worktreePath = await canonicalPotentialPath(input.worktreePath);
	if (isInside(repositoryPath, worktreePath) || isInside(labDirectory, worktreePath)) throw new WorktreeError("Lane worktree must be outside both the repository root and the Lab artifact directory", "INVALID_INPUT");
	if (await realpath(await git$1(repositoryPath, ["rev-parse", "--show-toplevel"])) !== repositoryPath) throw new WorktreeError("repositoryPath must be the exact Git worktree root", "REPOSITORY_INVALID");
	const commonDirectory = await canonicalGitCommonDirectory(repositoryPath);
	const baseSha = input.baseSha === void 0 ? await resolveCommit(repositoryPath, input.baseRef) : await resolveCommit(repositoryPath, input.baseSha);
	if (input.baseSha !== void 0 && baseSha !== input.baseSha) throw new WorktreeError("frozen baseSha did not resolve to itself", "GIT_FAILED");
	const receiptPath$1 = worktreeReceiptPath(labDirectory, input.laneId);
	const existingReceipt = await readReceipt$1(receiptPath$1);
	if (existingReceipt !== void 0) {
		if (existingReceipt.labId !== input.labId || existingReceipt.laneId !== input.laneId || existingReceipt.repositoryPath !== repositoryPath || existingReceipt.worktreePath !== worktreePath || existingReceipt.gitCommonDirectory !== commonDirectory || existingReceipt.baseRef !== input.baseRef || existingReceipt.baseSha !== baseSha) throw new WorktreeError("worktree receipt does not match the requested Lane identity", "WORKTREE_CONFLICT");
		return await inspectReceipt(existingReceipt);
	}
	const existing = await lstat(worktreePath).catch(() => void 0);
	if (existing === void 0) {
		await mkdir(dirname(worktreePath), {
			recursive: true,
			mode: 448
		});
		await git$1(repositoryPath, [
			"worktree",
			"add",
			"--detach",
			worktreePath,
			baseSha
		]);
	} else {
		if (!existing.isDirectory()) throw new WorktreeError("configured worktree path is not a directory", "WORKTREE_CONFLICT");
		const observed$1 = await inspectUnboundWorktree(worktreePath);
		if (observed$1.commonDirectory !== commonDirectory || observed$1.headSha !== baseSha || observed$1.dirty) throw new WorktreeError("existing path is not the exact clean crash-recovery worktree at baseSha", "WORKTREE_CONFLICT");
	}
	const observed = await inspectUnboundWorktree(worktreePath);
	if (observed.commonDirectory !== commonDirectory || observed.headSha !== baseSha) throw new WorktreeError("Git created a worktree with unexpected identity", "WORKTREE_CONFLICT");
	const withoutHash = {
		version: 1,
		labId: input.labId,
		laneId: input.laneId,
		repositoryPath,
		worktreePath: observed.worktreePath,
		gitCommonDirectory: commonDirectory,
		baseRef: input.baseRef,
		baseSha,
		initialHeadSha: observed.headSha,
		createdAt: input.now ?? Date.now()
	};
	const receipt = {
		...withoutHash,
		receiptHash: sha256(`autolab-worktree-receipt-v1\0${canonicalJson$1(withoutHash)}`)
	};
	await durableWriteFile(receiptPath$1, `${JSON.stringify(receipt, null, 2)}\n`, false);
	return {
		receipt,
		currentHeadSha: observed.headSha,
		dirty: observed.dirty
	};
}
async function inspectLaneWorktree(labDirectory, laneId$2) {
	if (!LANE_PATTERN.test(laneId$2)) throw new WorktreeError("invalid laneId", "INVALID_INPUT");
	const receipt = await readReceipt$1(worktreeReceiptPath(resolve(labDirectory), laneId$2));
	if (receipt === void 0) throw new WorktreeError(`worktree receipt for ${laneId$2} is missing`, "WORKTREE_MISSING");
	return await inspectReceipt(receipt);
}
function worktreeReceiptPath(labDirectory, laneId$2) {
	return join(labDirectory, "receipts", "worktrees", `${laneId$2}.json`);
}
async function inspectReceipt(receipt) {
	const observed = await inspectUnboundWorktree(receipt.worktreePath).catch((error) => {
		if (error instanceof WorktreeError) throw error;
		throw new WorktreeError(`cannot inspect Lane worktree: ${error instanceof Error ? error.message : String(error)}`, "WORKTREE_MISSING");
	});
	if (observed.worktreePath !== receipt.worktreePath || observed.commonDirectory !== receipt.gitCommonDirectory) throw new WorktreeError("Lane worktree no longer matches its receipt", "WORKTREE_CONFLICT");
	return {
		receipt,
		currentHeadSha: observed.headSha,
		dirty: observed.dirty
	};
}
async function inspectUnboundWorktree(path) {
	const worktreePath = await canonicalDirectory(path, "WORKTREE_MISSING");
	if (await canonicalDirectory(await git$1(worktreePath, ["rev-parse", "--show-toplevel"]), "WORKTREE_MISSING") !== worktreePath) throw new WorktreeError("configured path is not the exact worktree root", "WORKTREE_CONFLICT");
	const [commonDirectory, headSha, status] = await Promise.all([
		canonicalGitCommonDirectory(worktreePath),
		git$1(worktreePath, ["rev-parse", "HEAD"]),
		git$1(worktreePath, [
			"status",
			"--porcelain=v1",
			"--untracked-files=normal"
		])
	]);
	if (!SHA_PATTERN$1.test(headSha)) throw new WorktreeError("worktree HEAD is not a commit hash", "GIT_FAILED");
	return {
		worktreePath,
		commonDirectory,
		headSha,
		dirty: status.length > 0
	};
}
async function readReceipt$1(path) {
	const text = await readFile(path, "utf8").catch(() => void 0);
	if (text === void 0) return void 0;
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		throw new WorktreeError("worktree receipt is malformed JSON", "RECEIPT_CORRUPT");
	}
	if (!isReceipt(value)) throw new WorktreeError("worktree receipt schema is invalid", "RECEIPT_CORRUPT");
	const { receiptHash,...withoutHash } = value;
	if (sha256(`autolab-worktree-receipt-v1\0${canonicalJson$1(withoutHash)}`) !== receiptHash) throw new WorktreeError("worktree receipt hash is invalid", "RECEIPT_CORRUPT");
	return value;
}
function isReceipt(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record$1 = value;
	return record$1.version === 1 && typeof record$1.labId === "string" && typeof record$1.laneId === "string" && LANE_PATTERN.test(record$1.laneId) && typeof record$1.repositoryPath === "string" && isAbsolute(record$1.repositoryPath) && typeof record$1.worktreePath === "string" && isAbsolute(record$1.worktreePath) && typeof record$1.gitCommonDirectory === "string" && isAbsolute(record$1.gitCommonDirectory) && typeof record$1.baseRef === "string" && record$1.baseRef.length > 0 && typeof record$1.baseSha === "string" && SHA_PATTERN$1.test(record$1.baseSha) && typeof record$1.initialHeadSha === "string" && SHA_PATTERN$1.test(record$1.initialHeadSha) && Number.isSafeInteger(record$1.createdAt) && record$1.createdAt >= 0 && typeof record$1.receiptHash === "string" && /^[0-9a-f]{64}$/u.test(record$1.receiptHash);
}
async function resolveCommit(repositoryPath, ref) {
	const sha = await git$1(repositoryPath, [
		"rev-parse",
		"--verify",
		`${ref}^{commit}`
	]);
	if (!SHA_PATTERN$1.test(sha)) throw new WorktreeError(`baseRef ${JSON.stringify(ref)} did not resolve to a commit`, "GIT_FAILED");
	return sha;
}
async function canonicalGitCommonDirectory(worktreePath) {
	const output = await git$1(worktreePath, ["rev-parse", "--git-common-dir"]);
	return await canonicalDirectory(isAbsolute(output) ? output : resolve(worktreePath, output), "REPOSITORY_INVALID");
}
async function canonicalDirectory(path, code) {
	if (!isAbsolute(path)) throw new WorktreeError("path must be absolute", "INVALID_INPUT");
	try {
		return await realpath(path);
	} catch (error) {
		throw new WorktreeError(`directory does not exist: ${path} (${error instanceof Error ? error.message : String(error)})`, code);
	}
}
/** Resolve symlinks in the longest existing prefix without requiring target existence. */
async function canonicalPotentialPath(path) {
	if (!isAbsolute(path)) throw new WorktreeError("path must be absolute", "INVALID_INPUT");
	let cursor = resolve(path);
	const suffix = [];
	while (await lstat(cursor).catch(() => void 0) === void 0) {
		const parent = dirname(cursor);
		if (parent === cursor) throw new WorktreeError(`no existing ancestor for path ${path}`, "INVALID_INPUT");
		suffix.unshift(basename(cursor));
		cursor = parent;
	}
	return join(await realpath(cursor), ...suffix);
}
async function git$1(cwd, args) {
	try {
		return (await execFileAsync$1("git", [
			"-C",
			cwd,
			...args
		], {
			encoding: "utf8",
			maxBuffer: 2 * 1024 * 1024,
			env: {
				...process.env,
				GIT_OPTIONAL_LOCKS: "0"
			}
		})).stdout.trim();
	} catch (error) {
		throw new WorktreeError(`git ${args.join(" ")} failed: ${renderExecError(error)}`, "GIT_FAILED");
	}
}
function validateInput$3(input) {
	if (!LANE_PATTERN.test(input.laneId) || input.labId.length === 0 || input.baseRef.length === 0 || !isAbsolute(input.labDirectory) || !isAbsolute(input.repositoryPath) || !isAbsolute(input.worktreePath)) throw new WorktreeError("invalid worktree provisioning input", "INVALID_INPUT");
}
function isInside(parent, child) {
	const path = relative(resolve(parent), resolve(child));
	return path === "" || path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}
function renderExecError(value) {
	if (typeof value === "object" && value !== null && "stderr" in value) {
		const stderr = String(value.stderr).trim();
		if (stderr.length > 0) return stderr;
	}
	return value instanceof Error ? value.message : String(value);
}

//#endregion
//#region src/candidate.ts
const execFileAsync = promisify(execFile);
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SHA256_PATTERN$6 = /^[0-9a-f]{64}$/u;
const READ_REGULAR_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
var CandidateSnapshotError = class extends Error {
	name = "CandidateSnapshotError";
	constructor(message, code) {
		super(message);
		this.code = code;
	}
};
/**
* Freeze the current Lane bytes as a synthetic Git commit without changing the
* worktree or its real index. Runtime records only Git and Assignment identity;
* it does not inspect the scientific meaning of the diff or report.
*/
async function freezeLaneCandidate(input) {
	validateInput$2(input);
	const root = candidateArtifactRoot(input.labDirectory, input.assignmentId);
	const receiptPath$1 = join(root, "candidate.json");
	const existing = await readReceipt(receiptPath$1);
	if (existing !== void 0) {
		assertReceiptInput(existing, input);
		await verifyCandidateObjects(existing);
		return existing;
	}
	const lane = await inspectLaneWorktree(input.labDirectory, input.laneId);
	if (lane.receipt.labId !== input.labId || lane.receipt.worktreePath !== input.expectedWorktreePath || lane.receipt.receiptHash !== input.expectedWorktreeReceiptHash || lane.receipt.baseSha !== input.expectedBaseSha) throw new CandidateSnapshotError("Lane worktree does not match the candidate capture identity", "WORKTREE_MISMATCH");
	if (input.sourceReport !== void 0) await assertSmallReference(input.sourceReport);
	const intentPath = join(root, "capture-intent.json");
	let intent = await readIntent(intentPath);
	if (intent === void 0) {
		const treeSha = await snapshotTree(lane.receipt.worktreePath, lane.currentHeadSha);
		const body$1 = {
			version: 1,
			labId: input.labId,
			sourceRevision: input.sourceRevision,
			manifestHash: input.manifestHash,
			runtimeRevision: input.runtimeRevision,
			laneId: input.laneId,
			candidateId: input.candidateId,
			coderRoleId: input.coderRoleId,
			coderSessionId: input.coderSessionId,
			assignmentId: input.assignmentId,
			assignmentHash: input.assignmentHash,
			worktreeReceiptHash: input.expectedWorktreeReceiptHash,
			worktreePath: input.expectedWorktreePath,
			baseSha: input.expectedBaseSha,
			sourceHeadSha: lane.currentHeadSha,
			treeSha,
			capturedAt: input.now ?? Date.now(),
			...input.sourceReport === void 0 ? {} : { sourceReport: input.sourceReport }
		};
		intent = {
			...body$1,
			captureHash: hashCapture(body$1)
		};
		await freezeCanonical(intentPath, intent);
	} else assertIntentInput(intent, input);
	const candidateSha = await createCandidateCommit(intent);
	const gitRef = candidateRef(intent);
	await createOrVerifyRef(intent.worktreePath, gitRef, candidateSha);
	const body = {
		...withoutReceipt(intent),
		gitRef,
		candidateSha
	};
	const receipt = {
		...body,
		receiptHash: hashReceipt(body)
	};
	await freezeCanonical(receiptPath$1, receipt);
	return receipt;
}
function candidateReceiptPath(labDirectory, assignmentId) {
	return join(candidateArtifactRoot(labDirectory, assignmentId), "candidate.json");
}
/** Controller-owned immutable copy of the small Coder report. */
function candidateFrozenReportPath(labDirectory, assignmentId) {
	return join(candidateArtifactRoot(labDirectory, assignmentId), "coder-report.json");
}
async function readCandidateSnapshotReceipt(reference) {
	validateReference(reference);
	const receipt = parseReceipt(await readCanonical(reference.path));
	if (sha256(canonicalJson$1(receipt)) !== reference.hash) throw new CandidateSnapshotError("candidate receipt reference hash mismatch", "RECEIPT_CORRUPT");
	await verifyCandidateObjects(receipt);
	return receipt;
}
/** On-demand utility for a Session; Runtime never turns this into a Gate. */
async function readCandidateChangedPaths(receipt) {
	const output = await git(receipt.worktreePath, [
		"diff",
		"--name-only",
		"-z",
		"--no-renames",
		receipt.baseSha,
		receipt.candidateSha,
		"--"
	]);
	if (output.length === 0) return Object.freeze([]);
	if (output.at(-1) !== 0) throw new CandidateSnapshotError("git changed-path output is not NUL terminated", "GIT_FAILED");
	return Object.freeze(output.subarray(0, -1).toString("utf8").split("\0").filter(Boolean));
}
function validateInput$2(input) {
	if (input.labId.length === 0 || input.laneId.length === 0 || input.candidateId.length === 0 || input.coderRoleId.length === 0 || input.coderSessionId.length === 0 || input.assignmentId.length === 0 || !SHA256_PATTERN$6.test(input.manifestHash) || !SHA256_PATTERN$6.test(input.assignmentHash) || !SHA256_PATTERN$6.test(input.expectedWorktreeReceiptHash) || !SHA_PATTERN.test(input.expectedBaseSha) || !isExactAbsolute(input.labDirectory) || !isExactAbsolute(input.expectedWorktreePath) || !Number.isSafeInteger(input.sourceRevision) || input.sourceRevision <= 0 || !Number.isSafeInteger(input.runtimeRevision) || input.runtimeRevision < 0 || input.now !== void 0 && (!Number.isSafeInteger(input.now) || input.now < 0)) throw new CandidateSnapshotError("invalid candidate capture input", "INVALID_INPUT");
	if (input.sourceReport !== void 0) validateReference(input.sourceReport);
}
function validateReference(reference) {
	if (!isExactAbsolute(reference.path) || !SHA256_PATTERN$6.test(reference.hash)) throw new CandidateSnapshotError("invalid candidate artifact reference", "INVALID_INPUT");
}
function isExactAbsolute(value) {
	return isAbsolute(value) && resolve(value) === value;
}
function candidateArtifactRoot(labDirectory, assignmentId) {
	if (!isExactAbsolute(labDirectory) || assignmentId.length === 0) throw new CandidateSnapshotError("invalid candidate artifact identity", "INVALID_INPUT");
	return join(labDirectory, "artifacts", "candidates", sha256(assignmentId));
}
async function snapshotTree(worktreePath, headSha) {
	const temporary = await mkdtemp(join(tmpdir(), "dsh-autolab-index-"));
	const indexPath = join(temporary, "index");
	try {
		const env = {
			...process.env,
			GIT_INDEX_FILE: indexPath,
			GIT_OPTIONAL_LOCKS: "0"
		};
		await git(worktreePath, ["read-tree", headSha], env);
		await git(worktreePath, [
			"add",
			"-A",
			"--",
			"."
		], env);
		const treeSha = (await git(worktreePath, ["write-tree"], env)).toString("utf8").trim();
		if (!SHA_PATTERN.test(treeSha)) failGit("git write-tree returned an invalid object ID");
		return treeSha;
	} finally {
		await rm(temporary, {
			recursive: true,
			force: true
		});
	}
}
async function createCandidateCommit(intent) {
	const date = new Date(intent.capturedAt).toISOString();
	const candidateSha = (await git(intent.worktreePath, [
		"commit-tree",
		intent.treeSha,
		"-p",
		intent.baseSha,
		"-m",
		`AutoLab candidate snapshot\n\n${intent.captureHash}\n`
	], {
		...process.env,
		GIT_AUTHOR_NAME: "AutoLab Runtime",
		GIT_AUTHOR_EMAIL: "autolab@localhost",
		GIT_AUTHOR_DATE: date,
		GIT_COMMITTER_NAME: "AutoLab Runtime",
		GIT_COMMITTER_EMAIL: "autolab@localhost",
		GIT_COMMITTER_DATE: date,
		GIT_OPTIONAL_LOCKS: "0"
	})).toString("utf8").trim();
	if (!SHA_PATTERN.test(candidateSha)) failGit("git commit-tree returned an invalid object ID");
	return candidateSha;
}
async function createOrVerifyRef(worktreePath, ref, candidateSha) {
	const current = await gitOptional(worktreePath, [
		"rev-parse",
		"--verify",
		ref
	]);
	if (current !== void 0) {
		if (current.toString("utf8").trim() !== candidateSha) throw new CandidateSnapshotError(`candidate ref ${ref} already points elsewhere`, "CAPTURE_CONFLICT");
		return;
	}
	try {
		await git(worktreePath, [
			"update-ref",
			ref,
			candidateSha,
			"0".repeat(candidateSha.length)
		]);
	} catch (error) {
		if ((await gitOptional(worktreePath, [
			"rev-parse",
			"--verify",
			ref
		]))?.toString("utf8").trim() === candidateSha) return;
		throw error;
	}
}
function candidateRef(intent) {
	return `refs/autolab/${sha256(intent.labId).slice(0, 16)}/${sha256(intent.assignmentId).slice(0, 24)}`;
}
async function verifyCandidateObjects(receipt) {
	if (await revParse(receipt.worktreePath, receipt.gitRef) !== receipt.candidateSha || await revParse(receipt.worktreePath, `${receipt.candidateSha}^{tree}`) !== receipt.treeSha) throw new CandidateSnapshotError("candidate Git identity no longer matches its receipt", "RECEIPT_CORRUPT");
	if (receipt.sourceReport !== void 0) await assertSmallReference(receipt.sourceReport);
}
async function assertSmallReference(reference) {
	if (sha256(await readRegular(reference.path)) !== reference.hash) throw new CandidateSnapshotError("small candidate source receipt hash mismatch", "RECEIPT_CORRUPT");
}
function assertIntentInput(intent, input) {
	const expected = {
		labId: input.labId,
		sourceRevision: input.sourceRevision,
		manifestHash: input.manifestHash,
		runtimeRevision: input.runtimeRevision,
		laneId: input.laneId,
		candidateId: input.candidateId,
		coderRoleId: input.coderRoleId,
		coderSessionId: input.coderSessionId,
		assignmentId: input.assignmentId,
		assignmentHash: input.assignmentHash,
		worktreeReceiptHash: input.expectedWorktreeReceiptHash,
		worktreePath: input.expectedWorktreePath,
		baseSha: input.expectedBaseSha,
		sourceReport: input.sourceReport
	};
	for (const [key, value] of Object.entries(expected)) if (canonicalJson$1(intent[key] ?? null) !== canonicalJson$1(value ?? null)) throw new CandidateSnapshotError(`candidate capture intent changed at ${key}`, "CAPTURE_CONFLICT");
	if (intent.captureHash !== hashCapture(withoutCapture(intent))) throw new CandidateSnapshotError("candidate capture intent hash is invalid", "RECEIPT_CORRUPT");
}
function assertReceiptInput(receipt, input) {
	const { gitRef: _gitRef, candidateSha: _candidateSha, receiptHash: _receiptHash,...intent } = receipt;
	assertIntentInput(intent, input);
	if (receipt.receiptHash !== hashReceipt(withoutReceiptHash(receipt))) throw new CandidateSnapshotError("candidate receipt hash is invalid", "RECEIPT_CORRUPT");
}
function withoutCapture(value) {
	const { captureHash: _captureHash,...body } = value;
	return body;
}
function withoutReceipt(intent) {
	return {
		...intent,
		gitRef: candidateRef(intent),
		candidateSha: ""
	};
}
function withoutReceiptHash(receipt) {
	const { receiptHash: _receiptHash,...body } = receipt;
	return body;
}
function hashCapture(body) {
	return sha256(`autolab-candidate-capture-v2\0${canonicalJson$1(body)}`);
}
function hashReceipt(body) {
	return sha256(`autolab-candidate-receipt-v2\0${canonicalJson$1(body)}`);
}
async function readIntent(path) {
	const value = await readCanonicalIfPresent(path);
	if (value === void 0) return void 0;
	const intent = parseIntent(value);
	if (intent.captureHash !== hashCapture(withoutCapture(intent))) throw new CandidateSnapshotError("candidate capture intent hash is invalid", "RECEIPT_CORRUPT");
	return intent;
}
async function readReceipt(path) {
	const value = await readCanonicalIfPresent(path);
	if (value === void 0) return void 0;
	return parseReceipt(value);
}
function parseIntent(value) {
	const intent = exactRecord(value);
	validateBody(intent);
	if (!SHA256_PATTERN$6.test(intent.captureHash)) corrupt("candidate capture hash is invalid");
	return intent;
}
function parseReceipt(value) {
	const receipt = exactRecord(value);
	validateBody(receipt);
	if (!SHA256_PATTERN$6.test(receipt.captureHash) || !SHA_PATTERN.test(receipt.candidateSha) || typeof receipt.gitRef !== "string" || !receipt.gitRef.startsWith("refs/autolab/") || !SHA256_PATTERN$6.test(receipt.receiptHash) || receipt.receiptHash !== hashReceipt(withoutReceiptHash(receipt))) corrupt("candidate receipt schema or hash is invalid");
	return receipt;
}
function validateBody(value) {
	if (value.version !== 1 || typeof value.labId !== "string" || value.labId.length === 0 || !Number.isSafeInteger(value.sourceRevision) || value.sourceRevision <= 0 || !SHA256_PATTERN$6.test(value.manifestHash) || !Number.isSafeInteger(value.runtimeRevision) || value.runtimeRevision < 0 || typeof value.laneId !== "string" || value.laneId.length === 0 || typeof value.candidateId !== "string" || value.candidateId.length === 0 || typeof value.coderRoleId !== "string" || value.coderRoleId.length === 0 || typeof value.coderSessionId !== "string" || value.coderSessionId.length === 0 || typeof value.assignmentId !== "string" || value.assignmentId.length === 0 || !SHA256_PATTERN$6.test(value.assignmentHash) || !SHA256_PATTERN$6.test(value.worktreeReceiptHash) || !isExactAbsolute(value.worktreePath) || !SHA_PATTERN.test(value.baseSha) || !SHA_PATTERN.test(value.sourceHeadSha) || !SHA_PATTERN.test(value.treeSha) || !Number.isSafeInteger(value.capturedAt) || value.capturedAt < 0) corrupt("candidate capture schema is invalid");
	if (value.sourceReport !== void 0) validateReference(value.sourceReport);
}
function exactRecord(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) corrupt("candidate record is not an object");
	return value;
}
async function freezeCanonical(path, value) {
	const text = canonicalJson$1(value);
	try {
		await durableWriteFile(path, text, false);
	} catch (error) {
		if (!isNodeError$6(error) || error.code !== "EEXIST") throw error;
	}
	if (await readRegular(path).then((bytes) => bytes.toString("utf8")) !== text) throw new CandidateSnapshotError(`candidate artifact conflicts at ${path}`, "CAPTURE_CONFLICT");
}
async function readCanonicalIfPresent(path) {
	const bytes = await readRegular(path, true);
	if (bytes === void 0) return void 0;
	let value;
	try {
		value = JSON.parse(bytes.toString("utf8"));
	} catch {
		corrupt(`candidate artifact is not JSON at ${path}`);
	}
	if (canonicalJson$1(value) !== bytes.toString("utf8")) corrupt("candidate artifact is not canonical JSON");
	return value;
}
async function readCanonical(path) {
	const value = await readCanonicalIfPresent(path);
	if (value === void 0) corrupt(`candidate artifact is missing at ${path}`);
	return value;
}
async function readRegular(path, optional = false) {
	let file;
	try {
		file = await open(path, READ_REGULAR_FLAGS);
		if (!(await file.stat()).isFile()) corrupt(`candidate artifact is not a regular file at ${path}`);
		return await file.readFile();
	} catch (error) {
		if (optional && isNodeError$6(error) && error.code === "ENOENT") return void 0;
		if (error instanceof CandidateSnapshotError) throw error;
		throw new CandidateSnapshotError(`cannot read candidate artifact ${path}`, "IO_FAILED");
	} finally {
		await file?.close().catch(() => void 0);
	}
}
async function revParse(worktreePath, ref) {
	return (await git(worktreePath, [
		"rev-parse",
		"--verify",
		ref
	])).toString("utf8").trim();
}
async function gitOptional(worktreePath, args) {
	try {
		return await git(worktreePath, args);
	} catch {
		return;
	}
}
async function git(worktreePath, args, env = process.env) {
	try {
		return (await execFileAsync("git", [
			"-C",
			worktreePath,
			...args
		], {
			encoding: "buffer",
			env,
			maxBuffer: 16 * 1024 * 1024
		})).stdout;
	} catch (error) {
		throw new CandidateSnapshotError(`git ${args[0] ?? "<unknown>"} failed: ${error instanceof Error ? error.message : String(error)}`, "GIT_FAILED");
	}
}
function failGit(message) {
	throw new CandidateSnapshotError(message, "GIT_FAILED");
}
function corrupt(message) {
	throw new CandidateSnapshotError(message, "RECEIPT_CORRUPT");
}
function isNodeError$6(value) {
	return value instanceof Error && "code" in value;
}

//#endregion
//#region src/coder-submission.ts
const SHA256_PATTERN$5 = /^[0-9a-f]{64}$/u;
const UTF8$3 = new TextDecoder("utf-8", {
	fatal: true,
	ignoreBOM: true
});
var CoderSubmissionError = class extends Error {
	name = "CoderSubmissionError";
	constructor(message, code) {
		super(message);
		this.code = code;
	}
};
/**
* Freeze the exact current Coder report and Lane candidate, then bind their
* mechanical identities. Runtime validates the report envelope but never
* interprets `content` or follows any path inside it.
*/
async function freezeApprovedCoderSubmission(input) {
	validateInput$1(input);
	const manifest = input.frozen.manifest;
	const role = manifest.roles.find((value) => value.role_id === input.coderRole.role_id);
	if (role?.role_kind !== "coder" || input.coderRole.role_kind !== "coder" || canonicalJson$1(role) !== canonicalJson$1(input.coderRole)) throw new CoderSubmissionError("Coder does not match one CURRENT Lane", "INVALID_INPUT");
	const lane = manifest.lanes.find((value) => value.lane_id === role.lane_id && value.coder_role_id === role.role_id);
	if (lane === void 0) throw new CoderSubmissionError("Coder does not match one CURRENT Lane", "INVALID_INPUT");
	const assignment = await restoreCurrentRoleArtifacts({
		frozen: input.frozen,
		role: input.coderRole,
		sessionId: input.coderSessionId,
		binding: input.coderBinding,
		runtimeRevision: input.runtimeRevision,
		packetRef: input.coderPacket
	});
	if (assignment.assignmentId !== input.expectedAssignmentId || input.expectedAssignmentId !== `coder:${input.reviewId}` && !input.expectedAssignmentId.startsWith(`coder:${input.reviewId}:fix:`)) throw new CoderSubmissionError("current Coder Packet does not match the authorized review Assignment", "ASSIGNMENT_MISMATCH");
	const packet = assignment.packet.packet;
	const expectedReportPath = join(manifest.authority_paths.assignment_root, "outputs", `${sha256(assignment.assignmentId)}.json`);
	if (packet.output_contract.receipt_path !== expectedReportPath || packet.output_contract.expected_hash_binding !== assignment.assignmentId || canonicalJson$1(packet.output_contract.schema) !== canonicalJson$1(coderImplementationReportOutputSchema())) throw new CoderSubmissionError("Coder Role Packet does not declare the opaque report contract", "ASSIGNMENT_MISMATCH");
	const candidateId = assertAssignmentChain(input, assignment, await readCanonicalRecord(assignment.assignmentPath, assignment.assignmentHash, "Coder Assignment"));
	if (!hasExactStageReference(packet, "approved-method-design-ticket", input.designTicket) || !hasExactStageReference(packet, "preflight-approved-verdict", input.preflightVerdict)) throw new CoderSubmissionError("Coder Packet does not bind the exact Ticket and Preflight receipt", "REVIEW_MISMATCH");
	const worktree = await inspectLaneWorktree(manifest.authority_paths.lab_dir, lane.lane_id);
	const manifestWorktreePath = await realpath(lane.worktree_path).catch(() => lane.worktree_path);
	const worktreeMismatches = [
		worktree.receipt.worktreePath === manifestWorktreePath ? void 0 : "worktree_path",
		worktree.receipt.baseSha === lane.base_sha ? void 0 : "base_sha",
		worktree.receipt.labId === manifest.lab_id ? void 0 : "lab_id",
		worktree.receipt.laneId === lane.lane_id ? void 0 : "lane_id"
	].filter((value) => value !== void 0);
	if (worktreeMismatches.length > 0) throw new CoderSubmissionError(`Lane worktree receipt does not match CURRENT: ${worktreeMismatches.join(", ")}`, "WORKTREE_MISMATCH");
	const report = await freezeCandidateReport(expectedReportPath, candidateFrozenReportPath(manifest.authority_paths.lab_dir, assignment.assignmentId));
	const candidate = await freezeLaneCandidate({
		labId: manifest.lab_id,
		sourceRevision: input.frozen.ref.revision,
		manifestHash: input.frozen.ref.manifestHash,
		runtimeRevision: packet.anchors.runtime_revision,
		laneId: lane.lane_id,
		candidateId,
		coderRoleId: role.role_id,
		coderSessionId: input.coderSessionId,
		assignmentId: assignment.assignmentId,
		assignmentHash: assignment.assignmentHash,
		labDirectory: manifest.authority_paths.lab_dir,
		expectedWorktreePath: worktree.receipt.worktreePath,
		expectedWorktreeReceiptHash: worktree.receipt.receiptHash,
		expectedBaseSha: worktree.receipt.baseSha,
		sourceReport: {
			path: report.path,
			hash: report.sha256
		},
		now: packet.header.issued_at
	});
	const candidatePath = candidateReceiptPath(manifest.authority_paths.lab_dir, assignment.assignmentId);
	const worktreeReceiptPath$1 = join(manifest.authority_paths.lab_dir, "receipts", "worktrees", `${lane.lane_id}.json`);
	const [candidateBytes, worktreeReceiptBytes] = await Promise.all([readControlFile(candidatePath, "candidate receipt"), readControlFile(worktreeReceiptPath$1, "worktree receipt")]);
	const implementation = await freezeCompiledCoderImplementationReceipt({
		sourceReportPath: report.path,
		sourceReportSha256: report.sha256,
		artifactPath: join(dirname(candidatePath), "coder-implementation.json"),
		expected: {
			labId: manifest.lab_id,
			sourceRevision: input.frozen.ref.revision,
			laneId: lane.lane_id,
			coderRoleId: role.role_id,
			coderSessionId: input.coderSessionId,
			assignmentId: assignment.assignmentId,
			assignmentContractSha256: assignment.assignmentHash,
			rolePacket: {
				path: assignment.packetPath,
				sha256: assignment.packet.packetHash
			},
			designTicket: {
				path: input.designTicket.path,
				sha256: input.designTicket.hash,
				candidateId
			},
			preflightVerdict: {
				path: input.preflightVerdict.path,
				sha256: input.preflightVerdict.hash,
				reviewId: input.reviewId
			},
			sourceWorktree: {
				path: worktree.receipt.worktreePath,
				receiptPath: worktreeReceiptPath$1,
				receiptSha256: sha256(worktreeReceiptBytes)
			},
			candidateSha: candidate.candidateSha
		}
	});
	return {
		laneId: lane.lane_id,
		candidateId,
		reviewId: input.reviewId,
		assignment,
		reportPath: report.path,
		reportHash: report.sha256,
		candidatePath,
		candidateHash: sha256(candidateBytes),
		candidate,
		implementation
	};
}
async function freezeCandidateReport(mutablePath, artifactPath) {
	if (await readFile(artifactPath).catch((error) => {
		if (isNodeError$5(error) && error.code === "ENOENT") return void 0;
		throw error;
	}) !== void 0) return readCoderImplementationReport(artifactPath);
	const source = await readCoderImplementationReport(mutablePath);
	try {
		await durableWriteFile(artifactPath, source.bytes, false);
	} catch (error) {
		if (!isNodeError$5(error) || error.code !== "EEXIST") throw error;
	}
	return readCoderImplementationReport(artifactPath);
}
function validateInput$1(input) {
	if (input.coderSessionId.trim().length === 0 || input.expectedAssignmentId.trim().length === 0 || input.reviewId.trim().length === 0 || !Number.isSafeInteger(input.runtimeRevision) || input.runtimeRevision < 0) throw new CoderSubmissionError("invalid Coder submission identity", "INVALID_INPUT");
	for (const reference of [
		input.coderPacket,
		input.sourceMethodPacket,
		input.designTicket,
		input.preflightVerdict
	]) if (!isAbsolute(reference.path) || !SHA256_PATTERN$5.test(reference.hash)) throw new CoderSubmissionError("Coder submission artifact reference is invalid", "INVALID_INPUT");
}
/** Return the candidate ID already bound by the immutable Assignment. */
function assertAssignmentChain(input, assignment, value) {
	const coder = record(value.coder);
	const source = record(value.source_method);
	const ticket = record(value.design_ticket);
	const approval = record(value.preflight_approval);
	const isFix = value.assignment_type === "controller_coder_fix_assignment";
	const isApproved = value.assignment_type === "approved_coder_implementation";
	if (value.version !== 1 || !isFix && !isApproved || value.assignment_id !== assignment.assignmentId || value.review_id !== input.reviewId || value.runtime_revision !== assignment.packet.packet.anchors.runtime_revision || value.issued_at !== assignment.packet.packet.header.issued_at || coder?.role_id !== input.coderRole.role_id || coder.session_id !== input.coderSessionId || coder.binding_path !== input.coderBinding.path || coder.binding_sha256 !== input.coderBinding.hash || !sameReference(source?.packet, input.sourceMethodPacket) || ticket === void 0 || !sameReference(ticket, input.designTicket) || !sameReference(approval, input.preflightVerdict) || approval?.top_level_verdict !== "APPROVED" || (isFix ? record(value.fix_mandate) === void 0 : record(value.fix_mandate) !== void 0) || canonicalJson$1(value.output_contract) !== canonicalJson$1(assignment.packet.packet.output_contract)) throw new CoderSubmissionError("Coder Assignment does not bind the expected role and review chain", "ASSIGNMENT_MISMATCH");
	const candidateId = isFix ? typeof value.candidate_id === "string" && value.candidate_id.trim().length > 0 ? value.candidate_id : void 0 : typeof ticket.candidate_id === "string" && ticket.candidate_id.trim().length > 0 ? ticket.candidate_id : void 0;
	if (candidateId === void 0) throw new CoderSubmissionError("Coder Assignment does not bind one candidate identity", "ASSIGNMENT_MISMATCH");
	return candidateId;
}
function sameReference(value, expected) {
	const item = record(value);
	return item?.path === expected.path && item.sha256 === expected.hash;
}
function hasExactStageReference(packet, blockId, reference) {
	const matches = packet.verbatim_blocks.stage.filter((block) => block.block_id === blockId);
	return matches.length === 1 && matches[0].byte_range === void 0 && matches[0].source_path === reference.path && matches[0].text_sha256 === reference.hash && sha256(Buffer.from(matches[0].exact_text, "utf8")) === reference.hash;
}
async function readControlFile(path, label) {
	try {
		return await readFile(path);
	} catch {
		throw new CoderSubmissionError(`${label} cannot be read`, "ARTIFACT_MISMATCH");
	}
}
async function readExact(reference, label) {
	const bytes = await readControlFile(reference.path, label);
	if (sha256(bytes) !== reference.hash) throw new CoderSubmissionError(`${label} SHA-256 mismatch`, "ARTIFACT_MISMATCH");
	return bytes;
}
async function readCanonicalRecord(path, expectedHash, label) {
	const bytes = await readExact({
		path,
		hash: expectedHash
	}, label);
	let text;
	let value;
	try {
		text = UTF8$3.decode(bytes);
		value = JSON.parse(text);
	} catch {
		throw new CoderSubmissionError(`${label} is not UTF-8 JSON`, "ARTIFACT_MISMATCH");
	}
	const parsed = record(value);
	if (parsed === void 0 || canonicalJson$1(parsed) !== text) throw new CoderSubmissionError(`${label} is not canonical JSON`, "ARTIFACT_MISMATCH");
	return parsed;
}
function record(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function isNodeError$5(value) {
	return value instanceof Error && "code" in value;
}

//#endregion
//#region src/communication.ts
var CommunicationAclError = class extends Error {
	name = "CommunicationAclError";
	constructor(message, code, options) {
		super(message, options);
		this.code = code;
	}
};
/** Compile only from one validated, committed Manifest and its frozen role bindings. */
function compileCommunicationAcl(input) {
	const manifest = parseResolvedManifest(input.manifest);
	const manifestHash = hashResolvedManifest(manifest);
	const sessions = indexRoleSessions(manifest, manifestHash, input.roleSessions, input.allowPartial === true, input.authorizedManifestHashes);
	const permissions = new Map(manifest.communication.role_permissions.map((permission) => [permission.role_id, permission]));
	const roles = [...manifest.roles].sort((left, right) => left.role_id.localeCompare(right.role_id)).flatMap((role) => {
		const session = sessions.get(role.role_id);
		if (session === void 0) return [];
		const permission = permissions.get(role.role_id);
		return [{
			roleId: role.role_id,
			roleKind: role.role_kind,
			sessionId: String(session.agent.id),
			agent: session.agent,
			sendAllowed: permission.send,
			receiveAllowed: permission.receive
		}];
	});
	const roleById = new Map(manifest.roles.map((role) => [role.role_id, role]));
	const textPairs = [];
	for (let firstIndex = 0; firstIndex < roles.length; firstIndex += 1) for (let secondIndex = firstIndex + 1; secondIndex < roles.length; secondIndex += 1) {
		const first = roles[firstIndex];
		const second = roles[secondIndex];
		textPairs.push({
			firstRoleId: first.roleId,
			secondRoleId: second.roleId,
			firstSessionId: first.sessionId,
			secondSessionId: second.sessionId,
			blocked: textPairBlocked(manifest, roleById.get(first.roleId), roleById.get(second.roleId), input.revealState)
		});
	}
	return {
		labId: manifest.lab_id,
		manifestHash,
		aclRevision: manifest.communication.acl_revision,
		revealState: input.revealState,
		roles,
		textPairs
	};
}
/**
* Event-driven, idempotent projection onto the existing messaging provider.
* Tightening finishes before any widening, so a failed run never continues by
* opening another edge. A later call re-reads provider state and resumes safely.
*/
async function reconcileCommunicationAcl(input) {
	input.signal?.throwIfAborted();
	const plan = compileCommunicationAcl({
		manifest: input.manifest,
		revealState: input.revealState,
		roleSessions: input.roleSessions,
		...input.allowPartial === true ? { allowPartial: true } : {},
		...input.authorizedManifestHashes === void 0 ? {} : { authorizedManifestHashes: input.authorizedManifestHashes }
	});
	const quarantine = indexQuarantineSessions(input, plan);
	const managedRoles = input.controllerOffline === true ? plan.roles.filter((role) => role.roleKind !== "controller") : plan.roles;
	let observations;
	try {
		observations = await Promise.all(managedRoles.map(async (role) => {
			const [permission, blockedPeers] = await Promise.all([input.messaging.getPermissions(role.agent, input.signal), input.messaging.listBlockedPeers(role.agent, input.signal)]);
			if (String(permission.sessionId) !== role.sessionId) throw new CommunicationAclError(`messaging resolved role ${JSON.stringify(role.roleId)} to Session ${JSON.stringify(String(permission.sessionId))}, not ${JSON.stringify(role.sessionId)}`, "ACL_OBSERVATION_MISMATCH");
			return {
				role,
				sendAllowed: permission.sendAllowed,
				receiveAllowed: permission.receiveAllowed,
				blockedPeerIds: new Set(blockedPeers.map((peer) => String(peer.sessionId)))
			};
		}));
	} catch (error) {
		if (error instanceof CommunicationAclError) throw error;
		throw new CommunicationAclError("failed to read the current messaging ACL", "ACL_READ_FAILED", { cause: error });
	}
	input.signal?.throwIfAborted();
	const observationByRole = new Map(observations.map((value) => [value.role.roleId, value]));
	const currentlyBlocked = /* @__PURE__ */ new Set();
	for (const pair of plan.textPairs) {
		const first = observationByRole.get(pair.firstRoleId);
		const second = observationByRole.get(pair.secondRoleId);
		if (first?.blockedPeerIds.has(pair.secondSessionId) === true || second?.blockedPeerIds.has(pair.firstSessionId) === true) currentlyBlocked.add(rolePairKey(pair.firstRoleId, pair.secondRoleId));
	}
	const restrictive = [];
	const permissive = [];
	let permissionUpdates = 0;
	let textPairUpdates = 0;
	let quarantinePermissions;
	try {
		quarantinePermissions = await Promise.all(quarantine.map(async (role) => {
			const permission = await input.messaging.getPermissions(role.agent, input.signal);
			const sessionId = String(role.agent.id);
			if (String(permission.sessionId) !== sessionId) throw new CommunicationAclError(`messaging resolved quarantined role ${JSON.stringify(role.roleId)} to Session ${JSON.stringify(String(permission.sessionId))}, not ${JSON.stringify(sessionId)}`, "ACL_OBSERVATION_MISMATCH");
			return {
				roleId: role.roleId,
				agent: role.agent,
				sessionId,
				sendAllowed: permission.sendAllowed,
				receiveAllowed: permission.receiveAllowed
			};
		}));
	} catch (error) {
		if (error instanceof CommunicationAclError) throw error;
		throw new CommunicationAclError("failed to read a live unattached role before ACL quarantine", "ACL_READ_FAILED", { cause: error });
	}
	for (const role of quarantinePermissions) {
		if (!role.sendAllowed && !role.receiveAllowed) continue;
		const patch = {
			sendAllowed: false,
			receiveAllowed: false
		};
		restrictive.push({
			label: `quarantine role ${role.roleId}`,
			run: async () => {
				assertPermissionResult(role, patch, await input.messaging.setPermissions(role.agent, patch, input.signal));
				permissionUpdates += 1;
			}
		});
	}
	for (const observation of observations) {
		const restrictivePatch = permissionPatch(observation, observation.role, false);
		if (restrictivePatch !== void 0) restrictive.push({
			label: `restrict role ${observation.role.roleId}`,
			run: async () => {
				const result$1 = await input.messaging.setPermissions(observation.role.agent, restrictivePatch, input.signal);
				assertPermissionResult(observation.role, restrictivePatch, result$1);
				permissionUpdates += 1;
			}
		});
		const permissivePatch = permissionPatch(observation, observation.role, true);
		if (permissivePatch !== void 0) permissive.push({
			label: `enable role ${observation.role.roleId}`,
			run: async () => {
				const result$1 = await input.messaging.setPermissions(observation.role.agent, permissivePatch, input.signal);
				assertPermissionResult(observation.role, permissivePatch, result$1);
				permissionUpdates += 1;
			}
		});
	}
	for (const pair of plan.textPairs) {
		if (currentlyBlocked.has(rolePairKey(pair.firstRoleId, pair.secondRoleId)) === pair.blocked) continue;
		const caller = observationByRole.get(pair.firstRoleId)?.role ?? observationByRole.get(pair.secondRoleId)?.role;
		if (caller === void 0) throw new CommunicationAclError(`no live ACL principal can reconcile ${JSON.stringify(pair.firstRoleId)}<->${JSON.stringify(pair.secondRoleId)}`, "ACL_OBSERVATION_MISMATCH");
		const mutation = {
			label: `${pair.blocked ? "block" : "unblock"} text ${pair.firstRoleId}<->${pair.secondRoleId}`,
			run: async () => {
				await input.messaging.setPeerBlocked(caller.agent, caller.roleId === pair.firstRoleId ? pair.secondSessionId : pair.firstSessionId, pair.blocked, input.signal);
				textPairUpdates += 1;
			}
		};
		if (pair.blocked) restrictive.push(mutation);
		else permissive.push(mutation);
	}
	await applyPhase(restrictive, "tighten");
	await applyPhase(permissive, "widen");
	return {
		plan,
		permissionUpdates,
		textPairUpdates
	};
}
function indexRoleSessions(manifest, manifestHash, values, allowPartial, authorizedManifestHashes) {
	const sessions = /* @__PURE__ */ new Map();
	const sessionOwners = /* @__PURE__ */ new Map();
	for (const value of values) {
		if (sessions.has(value.roleId)) throw bindingMismatch(`duplicate communication binding for role ${JSON.stringify(value.roleId)}`);
		sessions.set(value.roleId, value);
	}
	const controller = manifest.roles.find((role) => role.role_kind === "controller");
	if (controller === void 0 || !sessions.has(controller.role_id)) throw bindingMismatch("communication reconciliation requires the Controller role identity");
	for (const role of manifest.roles) {
		const value = sessions.get(role.role_id);
		if (value === void 0) {
			if (allowPartial) continue;
			throw bindingMismatch(`missing communication binding for role ${JSON.stringify(role.role_id)}`);
		}
		const sessionId = String(value.agent.id);
		const previousOwner = sessionOwners.get(sessionId);
		if (previousOwner !== void 0) throw bindingMismatch(`roles ${JSON.stringify(previousOwner)} and ${JSON.stringify(role.role_id)} share Session ${JSON.stringify(sessionId)}`);
		sessionOwners.set(sessionId, role.role_id);
		if (role.prebound_session_id !== void 0 && role.prebound_session_id !== sessionId) throw bindingMismatch(`role ${JSON.stringify(role.role_id)} is prebound to Session ${JSON.stringify(role.prebound_session_id)}, not ${JSON.stringify(sessionId)}`);
		if (role.role_kind === "controller") {
			if (value.binding !== void 0) throw bindingMismatch("Controller communication authority comes from its manifest prebinding");
			continue;
		}
		const binding = value.binding;
		if (binding === void 0) throw bindingMismatch(`role ${JSON.stringify(role.role_id)} has no frozen RoleBindingReceipt`);
		const receipt = binding.receipt;
		const manifestHashAuthorized = receipt.manifestHash === manifestHash || authorizedManifestHashes?.has(receipt.manifestHash) === true;
		if (binding.hash !== receipt.receiptHash || receipt.labId !== manifest.lab_id || !manifestHashAuthorized || receipt.roleId !== role.role_id || receipt.roleKind !== role.role_kind || receipt.sessionId !== sessionId) throw bindingMismatch(`frozen RoleBindingReceipt does not authorize role ${JSON.stringify(role.role_id)} on Session ${JSON.stringify(sessionId)}`);
	}
	for (const roleId of sessions.keys()) if (!manifest.roles.some((role) => role.role_id === roleId)) throw bindingMismatch(`communication binding references unknown role ${JSON.stringify(roleId)}`);
	return sessions;
}
function indexQuarantineSessions(input, plan) {
	const values = input.quarantineSessions ?? [];
	if (values.length === 0) return [];
	if (input.allowPartial !== true) throw bindingMismatch("live role quarantine is only valid during explicit partial recovery");
	const manifestRoles = new Map(input.manifest.roles.map((role) => [role.role_id, role]));
	const attachedRoleIds = new Set(plan.roles.map((role) => role.roleId));
	const attachedSessionIds = new Set(plan.roles.map((role) => role.sessionId));
	const roles = /* @__PURE__ */ new Set();
	const sessions = /* @__PURE__ */ new Set();
	for (const value of values) {
		const role = manifestRoles.get(value.roleId);
		const sessionId = String(value.agent.id);
		if (role === void 0 || role.role_kind === "controller" || attachedRoleIds.has(value.roleId) || attachedSessionIds.has(sessionId) || roles.has(value.roleId) || sessions.has(sessionId) || role.prebound_session_id !== void 0 && role.prebound_session_id !== sessionId) throw bindingMismatch(`invalid live quarantine identity for role ${JSON.stringify(value.roleId)} on Session ${JSON.stringify(sessionId)}`);
		roles.add(value.roleId);
		sessions.add(sessionId);
	}
	return values;
}
function textPairBlocked(manifest, first, second, revealState) {
	if (first.role_kind === "controller" || second.role_kind === "controller") return false;
	if (manifest.communication.text_pair_blocks.some((block) => {
		const [left, right] = block.role_ids;
		return (left === first.role_id && right === second.role_id || left === second.role_id && right === first.role_id) && blockActive(block.active_when, revealState);
	})) return true;
	if (sameLane(first, second) && isMethodCoderPair(first, second) && manifest.communication.text_method_coder_within_lane === "blocked") return true;
	const firstLane = laneId(first);
	const secondLane = laneId(second);
	if (firstLane !== void 0 && secondLane !== void 0 && firstLane !== secondLane) {
		if ((revealState === "sealed" ? manifest.communication.reveal_policy.text_cross_lane_before_reveal : manifest.communication.reveal_policy.text_cross_lane_after_reveal) === "blocked") return true;
	}
	const coordinator = first.role_kind === "coordinator" ? first : second.role_kind === "coordinator" ? second : void 0;
	const laneRole = coordinator === first ? second : coordinator === second ? first : void 0;
	if (coordinator !== void 0 && laneRole !== void 0 && laneId(laneRole) !== void 0) {
		const visibility = manifest.communication.coordinator_visibility;
		if (visibility === "runtime_only") return true;
		if (visibility === "revealed" && revealState === "sealed") return true;
	}
	return false;
}
function blockActive(activeWhen, revealState) {
	return activeWhen === "always" || activeWhen === "before_reveal" && revealState === "sealed" || activeWhen === "after_reveal" && revealState === "revealed";
}
function sameLane(first, second) {
	const firstLane = laneId(first);
	return firstLane !== void 0 && firstLane === laneId(second);
}
function laneId(role) {
	return "lane_id" in role ? role.lane_id : void 0;
}
function isMethodCoderPair(first, second) {
	return first.role_kind === "method" && second.role_kind === "coder" || first.role_kind === "coder" && second.role_kind === "method";
}
function permissionPatch(current, desired, enabling) {
	const patch = {};
	if (current.sendAllowed !== desired.sendAllowed && desired.sendAllowed === enabling) patch.sendAllowed = desired.sendAllowed;
	if (current.receiveAllowed !== desired.receiveAllowed && desired.receiveAllowed === enabling) patch.receiveAllowed = desired.receiveAllowed;
	return patch.sendAllowed === void 0 && patch.receiveAllowed === void 0 ? void 0 : patch;
}
function assertPermissionResult(role, patch, result$1) {
	if (String(result$1.sessionId) !== role.sessionId || patch.sendAllowed !== void 0 && result$1.sendAllowed !== patch.sendAllowed || patch.receiveAllowed !== void 0 && result$1.receiveAllowed !== patch.receiveAllowed) throw new CommunicationAclError(`messaging did not apply the exact permission patch for role ${JSON.stringify(role.roleId)}`, "ACL_OBSERVATION_MISMATCH");
}
async function applyPhase(mutations, phase) {
	if (mutations.length === 0) return;
	const results = await Promise.allSettled(mutations.map((mutation) => mutation.run()));
	const failureIndex = results.findIndex((result$2) => result$2.status === "rejected");
	if (failureIndex < 0) return;
	const result$1 = results[failureIndex];
	throw new CommunicationAclError(`failed to ${mutations[failureIndex].label}; ACL ${phase} phase stopped`, "ACL_APPLY_FAILED", { cause: result$1.reason });
}
function rolePairKey(firstRoleId, secondRoleId) {
	return firstRoleId < secondRoleId ? `${firstRoleId}\0${secondRoleId}` : `${secondRoleId}\0${firstRoleId}`;
}
function bindingMismatch(message) {
	return new CommunicationAclError(message, "ROLE_BINDING_MISMATCH");
}

//#endregion
//#region src/config.ts
const SHA256_PATTERN$4 = /^[0-9a-f]{64}$/u;
const GIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const id = z.string().min(1);
const absolutePath$1 = z.string().min(1).refine((value) => value.startsWith("/"), "path must be absolute");
const strings = z.array(z.string().min(1));
const jsonObject = z.record(z.string(), z.json());
const maxGoalRounds = z.number().int().positive();
const component = z.object({
	id,
	version: id,
	sha256: z.string().regex(SHA256_PATTERN$4)
}).strict();
const route = z.object({
	route_id: id,
	provider: id,
	model: id,
	config: jsonObject
}).strict();
const roleCommon = {
	role_id: id,
	model_route: route,
	fallback_routes: z.array(route),
	dsh_preset: z.enum([
		"read-only",
		"workspace-write",
		"danger-full-access"
	]),
	reasoning: z.object({
		mode: id,
		config: jsonObject
	}).strict(),
	allowed_tools: strings
};
const draftRoleSchema = z.discriminatedUnion("role_kind", [
	z.object({
		...roleCommon,
		role_kind: z.literal("controller"),
		max_goal_rounds: maxGoalRounds
	}).strict(),
	z.object({
		...roleCommon,
		role_kind: z.literal("method"),
		max_goal_rounds: maxGoalRounds,
		lane_id: id,
		prebound_session_id: id.optional()
	}).strict(),
	z.object({
		...roleCommon,
		role_kind: z.literal("coder"),
		max_goal_rounds: maxGoalRounds,
		lane_id: id,
		prebound_session_id: id.optional()
	}).strict(),
	z.object({
		...roleCommon,
		role_kind: z.literal("preflight_judge"),
		lane_id: id,
		prebound_session_id: id.optional()
	}).strict(),
	z.object({
		...roleCommon,
		role_kind: z.literal("postflight_judge"),
		lane_id: id,
		prebound_session_id: id.optional()
	}).strict(),
	z.object({
		...roleCommon,
		role_kind: z.literal("ops"),
		max_goal_rounds: maxGoalRounds,
		resource_domain: id,
		prebound_session_id: id.optional()
	}).strict(),
	z.object({
		...roleCommon,
		role_kind: z.literal("coordinator"),
		max_goal_rounds: maxGoalRounds,
		prebound_session_id: id.optional()
	}).strict()
]);
const laneSchema = z.object({
	lane_id: id,
	worktree_path: absolutePath$1,
	base_ref: id,
	method_role_id: id,
	coder_role_id: id,
	preflight_judge_role_id: id,
	postflight_judge_role_id: id,
	charter: jsonObject
}).strict();
const provenance = z.string().refine((value) => value === "user" || value === "proposed" || value === "default" || value.startsWith("discovered:") && value.length > 11 || value.startsWith("inherited:") && value.length > 10, "invalid provenance");
/**
* Human/Controller-authored machine projection. Runtime identities and hashes are
* deliberately absent; resolveDraftLabConfig injects only mechanically observed
* values at commit time.
*/
const draftLabConfigSchema = z.object({
	schema_version: z.literal(1),
	repository: z.object({
		path: absolutePath$1,
		base_ref: id
	}).strict(),
	worktree_root: absolutePath$1,
	research: jsonObject,
	contract: jsonObject,
	search: z.object({
		search_mode: z.enum(["sequential", "cohort"]),
		research_route_authority: z.enum(["user", "autolab"]).optional(),
		coordinator_enabled: z.boolean(),
		lanes: z.array(laneSchema).min(1)
	}).strict(),
	roles: z.array(draftRoleSchema).min(1),
	execution: z.object({
		runner_adapter: component,
		hosts: z.array(z.object({
			host_id: id,
			runner_target: id
		}).strict()).min(1),
		gpu_pool: z.array(z.object({
			gpu_id: id,
			host_id: id
		}).strict()),
		max_parallel_gpu_attempts: z.number().int().nonnegative(),
		run_root: absolutePath$1.optional(),
		contract: jsonObject
	}).strict(),
	evidence: z.object({
		artifact_root: absolutePath$1.optional(),
		contract: jsonObject
	}).strict(),
	communication: z.object({
		topology: z.enum(["lane_isolated", "coordinated"]),
		acl_revision: z.number().int().nonnegative(),
		coordinator_visibility: z.enum([
			"disabled",
			"runtime_only",
			"revealed",
			"global"
		]),
		role_permissions: z.array(z.object({
			role_id: id,
			send: z.boolean(),
			receive: z.boolean()
		}).strict()).min(1),
		text_method_coder_within_lane: z.enum(["allowed", "blocked"]),
		text_pair_blocks: z.array(z.object({
			role_ids: z.tuple([id, id]),
			active_when: z.enum([
				"before_reveal",
				"after_reveal",
				"always"
			])
		}).strict()),
		reveal_policy: z.object({
			initial_state: z.enum(["sealed", "revealed"]),
			trigger: z.enum([
				"manual",
				"cohort_barrier",
				"immediate"
			]),
			text_cross_lane_before_reveal: z.enum(["blocked", "allowed"]),
			text_cross_lane_after_reveal: z.enum(["blocked", "allowed"])
		}).strict(),
		api_recovery: id,
		attempt_recovery: id,
		stop_pause_policy: id
	}).strict(),
	provenance: z.record(z.string().min(1), provenance)
}).strict();
const resolutionSchema = z.object({
	lab_id: id,
	revision: z.number().int().positive(),
	controller_session_id: id,
	dialogue_head_sha256: z.string().regex(SHA256_PATTERN$4),
	lab_spec_sha256: z.string().regex(SHA256_PATTERN$4),
	lab_yaml_sha256: z.string().regex(SHA256_PATTERN$4),
	lab_directory: absolutePath$1,
	autolab_plugin_version: id,
	dsh_version: id,
	repository_base_sha: z.string().regex(GIT_SHA_PATTERN),
	lane_base_shas: z.record(z.string().min(1), z.string().regex(GIT_SHA_PATTERN)),
	role_prompt_sha256: z.record(z.string().min(1), z.string().regex(SHA256_PATTERN$4))
}).strict();
var LabConfigError = class extends Error {
	name = "LabConfigError";
	code = "INVALID_LAB_CONFIG";
	constructor(message) {
		super(message);
	}
};
function parseDraftLabConfig(value) {
	const parsed = draftLabConfigSchema.safeParse(value);
	if (!parsed.success) throw new LabConfigError(formatIssues(parsed.error.issues));
	return parsed.data;
}
function parseDraftLabYaml(text) {
	const document = parseDocument(text, {
		schema: "core",
		merge: false,
		uniqueKeys: true,
		prettyErrors: false
	});
	if (document.errors.length > 0) throw new LabConfigError(document.errors.map((error) => error.message).join("; "));
	return parseDraftLabConfig(document.toJS({ maxAliasCount: 100 }));
}
function resolveDraftLabConfig(configValue, resolutionValue) {
	const config = parseDraftLabConfig(configValue);
	const resolution = resolutionSchema.parse(resolutionValue);
	const labDirectory = resolve(resolution.lab_directory);
	const revisionDirectory = join(labDirectory, "revisions", String(resolution.revision).padStart(6, "0"));
	const lanes = config.search.lanes.map((lane) => {
		const baseSha = resolution.lane_base_shas[lane.lane_id];
		if (baseSha === void 0) throw new LabConfigError(`missing discovered base SHA for lane ${lane.lane_id}`);
		return {
			lane_id: lane.lane_id,
			worktree_path: resolve(lane.worktree_path),
			base_ref: lane.base_ref,
			base_sha: baseSha,
			method_role_id: lane.method_role_id,
			coder_role_id: lane.coder_role_id,
			preflight_judge_role_id: lane.preflight_judge_role_id,
			postflight_judge_role_id: lane.postflight_judge_role_id
		};
	});
	const laneCharters = config.search.lanes.map((lane) => ({
		lane_id: lane.lane_id,
		charter_sha256: sha256(canonicalJson$1(lane.charter)),
		content: lane.charter
	}));
	const roles = config.roles.map((role) => {
		const promptHash = resolution.role_prompt_sha256[role.role_id];
		if (promptHash === void 0) throw new LabConfigError(`missing built-in prompt hash for role ${role.role_id}`);
		const common = {
			role_id: role.role_id,
			model_route: role.model_route,
			fallback_routes: role.fallback_routes,
			dsh_preset: role.dsh_preset,
			reasoning: role.reasoning,
			allowed_tools: roleAllowedTools(role.role_kind, role.allowed_tools),
			prompt_sha256: promptHash
		};
		switch (role.role_kind) {
			case "controller": return {
				...common,
				role_kind: role.role_kind,
				max_goal_rounds: role.max_goal_rounds,
				prebound_session_id: resolution.controller_session_id
			};
			case "method":
			case "coder": {
				const lane = lanes.find((candidate) => candidate.lane_id === role.lane_id);
				if (lane === void 0) throw new LabConfigError(`role ${role.role_id} has unknown lane ${role.lane_id}`);
				return {
					...common,
					role_kind: role.role_kind,
					max_goal_rounds: role.max_goal_rounds,
					lane_id: role.lane_id,
					worktree_path: lane.worktree_path,
					...role.prebound_session_id === void 0 ? {} : { prebound_session_id: role.prebound_session_id }
				};
			}
			case "preflight_judge":
			case "postflight_judge": return {
				...common,
				role_kind: role.role_kind,
				lane_id: role.lane_id,
				...role.prebound_session_id === void 0 ? {} : { prebound_session_id: role.prebound_session_id }
			};
			case "ops": return {
				...common,
				role_kind: role.role_kind,
				max_goal_rounds: role.max_goal_rounds,
				resource_domain: role.resource_domain,
				...role.prebound_session_id === void 0 ? {} : { prebound_session_id: role.prebound_session_id }
			};
			case "coordinator": return {
				...common,
				role_kind: role.role_kind,
				max_goal_rounds: role.max_goal_rounds,
				...role.prebound_session_id === void 0 ? {} : { prebound_session_id: role.prebound_session_id }
			};
		}
	});
	const researchRouteAuthority = config.search.research_route_authority ?? "user";
	const search = {
		search_mode: config.search.search_mode,
		research_route_authority: researchRouteAuthority,
		lane_count: lanes.length,
		coordinator_enabled: config.search.coordinator_enabled,
		lane_charters: laneCharters
	};
	const campaignContract = {
		research: config.research,
		contract: config.contract,
		search,
		execution: config.execution.contract,
		evidence: config.evidence.contract
	};
	const artifactRoot = resolve(config.evidence.artifact_root ?? join(labDirectory, "artifacts"));
	const runRoot = resolve(config.execution.run_root ?? join(labDirectory, "artifacts", "runs"));
	return parseResolvedManifest({
		schema_version: 1,
		lab_id: resolution.lab_id,
		source_revision: resolution.revision,
		campaign_contract_sha256: sha256(canonicalJson$1(campaignContract)),
		anchors: {
			dialogue_head_sha256: resolution.dialogue_head_sha256,
			lab_spec_sha256: resolution.lab_spec_sha256,
			lab_yaml_sha256: resolution.lab_yaml_sha256
		},
		authority_paths: {
			lab_dir: labDirectory,
			creation_log: join(labDirectory, "dialogue", "creation.jsonl"),
			lab_spec: join(revisionDirectory, "LAB_SPEC.md"),
			lab_yaml: join(revisionDirectory, "lab.yaml"),
			resolved_manifest: join(revisionDirectory, "RESOLVED_MANIFEST.json"),
			fact_set: join(labDirectory, "artifacts", "facts.json"),
			evidence_index: join(labDirectory, "artifacts", "evidence.json"),
			assignment_root: join(labDirectory, "assignments"),
			worktree_root: resolve(config.worktree_root)
		},
		versions: {
			autolab_plugin: resolution.autolab_plugin_version,
			dsh: resolution.dsh_version
		},
		repository: {
			path: resolve(config.repository.path),
			base_ref: config.repository.base_ref,
			base_sha: resolution.repository_base_sha
		},
		research: config.research,
		contract: config.contract,
		search,
		lanes,
		roles,
		execution: {
			...config.execution,
			run_root: runRoot
		},
		evidence: {
			...config.evidence,
			artifact_root: artifactRoot
		},
		communication: {
			...config.communication,
			controller_visibility: "global"
		},
		provenance: config.search.research_route_authority === void 0 && config.provenance["/search/research_route_authority"] === void 0 ? {
			...config.provenance,
			"/search/research_route_authority": "default"
		} : config.provenance
	});
}
function roleAllowedTools(roleKind, configured) {
	const required = roleKind === "method" ? "SubmitMethodForPreflightReview" : roleKind === "preflight_judge" ? "SubmitPreflightVerdict" : roleKind === "postflight_judge" ? "SubmitPostflightResult" : roleKind === "coder" ? "SubmitCoderImplementation" : roleKind === "ops" || roleKind === "coordinator" ? "SubmitAutoLabRoleResult" : void 0;
	return required === void 0 || configured.includes(required) ? [...configured] : [...configured, required];
}
function formatIssues(issues) {
	return issues.map((issue$1) => `${issue$1.path.join(".") || "<root>"}: ${issue$1.message}`).join("; ");
}

//#endregion
//#region src/lock.ts
var RuntimeLockError = class extends Error {
	name = "RuntimeLockError";
	constructor(message, code) {
		super(message);
		this.code = code;
	}
};
async function acquireRuntimeLock(root) {
	await mkdir(root, {
		recursive: true,
		mode: 448
	});
	const lockPath = join(root, "controller.lock");
	for (let attempt = 0; attempt < 8; attempt += 1) {
		const owner = currentOwner();
		const candidate = join(root, `.controller.lock.candidate-${owner.token}`);
		await mkdir(candidate, { mode: 448 });
		try {
			await writeOwner(candidate, owner);
			try {
				await rename(candidate, lockPath);
				await syncDirectory(root);
				return ownedLock(lockPath, owner);
			} catch (error) {
				if (!isLockCollision(error)) throw error;
			}
		} finally {
			await rm(candidate, {
				recursive: true,
				force: true
			});
		}
		const existing = await tryReadOwner(lockPath);
		if (existing === void 0) continue;
		const liveness = probeOwner(existing);
		if (liveness === "alive") throw new RuntimeLockError(`AutoLab controller is already owned by pid ${existing.pid} on ${existing.hostname}`, "OWNER_ACTIVE");
		if (liveness === "unknown") throw new RuntimeLockError(`cannot prove whether AutoLab controller owner pid ${existing.pid} is dead`, "OWNER_UNKNOWN");
		const tombstone = join(root, `controller.lock.stale-${existing.token}-${randomUUID()}`);
		let moved = false;
		try {
			await rename(lockPath, tombstone);
			moved = true;
			await syncDirectory(root);
		} catch (error) {
			if (!isLockCollision(error) && !isMissing(error)) throw error;
		} finally {
			if (moved) {
				await rm(tombstone, {
					recursive: true,
					force: true
				});
				await syncDirectory(root);
			}
		}
	}
	throw new RuntimeLockError("controller ownership changed repeatedly during acquisition", "OWNER_UNKNOWN");
}
function processStartId(pid) {
	const result$1 = spawnSync("ps", [
		"-p",
		String(pid),
		"-o",
		"lstart="
	], {
		encoding: "utf8",
		stdio: [
			"ignore",
			"pipe",
			"ignore"
		],
		timeout: 2e3
	});
	if (result$1.status !== 0) return void 0;
	const value = result$1.stdout.trim().replace(/\s+/g, " ");
	return value.length === 0 ? void 0 : value;
}
function currentOwner() {
	const startId = processStartId(process.pid);
	if (startId === void 0) throw new RuntimeLockError("cannot resolve current process start identity", "OWNER_UNKNOWN");
	return {
		version: 1,
		token: randomUUID(),
		pid: process.pid,
		processStartId: startId,
		hostname: hostname(),
		acquiredAt: Date.now()
	};
}
function probeOwner(owner) {
	if (owner.hostname !== hostname()) return "unknown";
	try {
		process.kill(owner.pid, 0);
	} catch (error) {
		if (isNodeError$4(error) && error.code === "ESRCH") return "dead";
		return "unknown";
	}
	const actualStart = processStartId(owner.pid);
	if (actualStart === void 0) return "unknown";
	return actualStart === owner.processStartId ? "alive" : "dead";
}
function ownedLock(lockPath, owner) {
	let released = false;
	return {
		path: lockPath,
		owner,
		async release() {
			if (released) return;
			if ((await tryReadOwner(lockPath))?.token !== owner.token) throw new RuntimeLockError("controller lock token changed before release", "LOCK_LOST");
			const releasedPath = join(dirname(lockPath), `${basename(lockPath)}.released-${owner.token}`);
			await rename(lockPath, releasedPath);
			await syncDirectory(dirname(lockPath));
			released = true;
			await rm(releasedPath, {
				recursive: true,
				force: true
			});
			await syncDirectory(dirname(lockPath));
		}
	};
}
async function writeOwner(directory, owner) {
	const handle = await open(join(directory, "owner.json"), "wx", 384);
	try {
		await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	await syncDirectory(directory);
}
async function tryReadOwner(lockPath) {
	let value;
	try {
		value = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));
	} catch (error) {
		if (isMissing(error)) {
			if (await stat(lockPath).catch((statError) => {
				if (isMissing(statError)) return void 0;
				throw statError;
			}) === void 0) return void 0;
			throw new RuntimeLockError(`controller lock at ${lockPath} exists without an owner record`, "LOCK_CORRUPT");
		}
		throw new RuntimeLockError(`cannot read controller owner at ${lockPath}: ${error instanceof Error ? error.message : String(error)}`, "LOCK_CORRUPT");
	}
	if (!isOwner(value)) throw new RuntimeLockError(`controller owner at ${lockPath} is malformed`, "LOCK_CORRUPT");
	return value;
}
function isOwner(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const candidate = value;
	return candidate.version === 1 && typeof candidate.token === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(candidate.token) && Number.isSafeInteger(candidate.pid) && candidate.pid > 0 && typeof candidate.processStartId === "string" && candidate.processStartId.length > 0 && typeof candidate.hostname === "string" && candidate.hostname.length > 0 && Number.isSafeInteger(candidate.acquiredAt) && candidate.acquiredAt >= 0;
}
async function syncDirectory(path) {
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}
function isNodeError$4(value) {
	return value instanceof Error && "code" in value;
}
function isMissing(value) {
	return isNodeError$4(value) && value.code === "ENOENT";
}
function isLockCollision(value) {
	return isNodeError$4(value) && (value.code === "EEXIST" || value.code === "ENOTEMPTY");
}

//#endregion
//#region src/postflight-artifacts.ts
const SHA256_PATTERN$3 = /^[0-9a-f]{64}$/u;
const UTF8$2 = new TextDecoder("utf-8", {
	fatal: true,
	ignoreBOM: true
});
var PostflightArtifactError = class extends Error {
	name = "PostflightArtifactError";
	constructor(message, code) {
		super(message);
		this.code = code;
	}
};
/**
* Compile one Postflight Assignment directly from CURRENT and immutable control
* references. Method, result, Trial, RunSlot, and Attempt files are deliberately
* not opened: the Judge reads their original bytes and any Lab-declared paths.
*/
async function freezePostflightReviewArtifacts(input) {
	validateInput(input);
	await assertFrozenRevision$1(input.frozen);
	const manifest = input.frozen.manifest;
	const target = await resolveJudge$1(input);
	const coderPacket = await readCurrentCoderPacket(input, target.laneId, target.coderRoleId);
	const prompt = rolePromptFor("postflight_judge");
	const promptPath = join(manifest.authority_paths.lab_dir, "artifacts", "builtins", `${prompt.sha256}.txt`);
	await freezeExact$1(promptPath, prompt.text);
	const laneText = canonicalJson$1(target.charter.content);
	if (sha256(laneText) !== target.charter.charter_sha256) throw new PostflightArtifactError("LaneCharter bytes do not match CURRENT ResolvedManifest", "CURRENT_MISMATCH");
	const lanePath = join(manifest.authority_paths.lab_dir, "artifacts", "lanes", `${sha256(target.laneId)}.charter.json`);
	await freezeExact$1(lanePath, laneText);
	const assignmentId = `postflight:${input.reviewId}`;
	const assignmentPath = join(manifest.authority_paths.assignment_root, "reviews", `${sha256(input.reviewId)}.postflight.json`);
	const resultPath = join(manifest.authority_paths.assignment_root, "outputs", `${sha256(assignmentId)}.json`);
	const references = sourceReferences(input);
	const reviewInputHash = sha256(`autolab-postflight-review-input-v1\0${canonicalJson$1({
		review_id: input.reviewId,
		lab_id: manifest.lab_id,
		source_revision: input.frozen.ref.revision,
		resolved_manifest_sha256: input.frozen.ref.manifestHash,
		runtime_revision: input.runtimeRevision,
		issued_at: input.issuedAt,
		reveal_state: input.revealState,
		judge: {
			role_id: target.roleId,
			session_id: input.judgeSessionId,
			binding_path: input.judgeBinding.path,
			binding_sha256: input.judgeBinding.hash
		},
		sources: references
	})}`);
	const outputContract = {
		schema: manifest.evidence.contract,
		receipt_path: resultPath,
		expected_hash_binding: reviewInputHash
	};
	const assignmentText = canonicalJson$1({
		version: 1,
		assignment_type: "postflight_review",
		review_id: input.reviewId,
		assignment_id: assignmentId,
		runtime_revision: input.runtimeRevision,
		issued_at: input.issuedAt,
		reveal_state: input.revealState,
		review_input_sha256: reviewInputHash,
		judge: {
			role_id: target.roleId,
			session_id: input.judgeSessionId,
			binding_path: input.judgeBinding.path,
			binding_sha256: input.judgeBinding.hash
		},
		sources: references,
		instruction: [
			"Read the exact referenced Method, Preflight, Coder, Trial, RunSlot, and Attempt originals and the Lab-declared paths they reference.",
			"Apply the current LAB_SPEC.md and Lab-authored output contract directly; do not substitute a generic verdict taxonomy or invent another gate.",
			"Write the requested receipt at output_contract.receipt_path. Runtime will preserve its original bytes without interpreting scientific content."
		].join(" "),
		output_contract: outputContract
	});
	const assignmentHash = await freezeExact$1(assignmentPath, assignmentText);
	const factAnchor = await currentFactAnchor(manifest.authority_paths.fact_set);
	const packet = compileRolePacket({
		manifest,
		role_id: target.roleId,
		session_id: input.judgeSessionId,
		assignment_id: assignmentId,
		issued_at: input.issuedAt,
		role_binding_receipt_sha256: input.judgeBinding.hash,
		runtime_revision: input.runtimeRevision,
		fact_set_sha256: factAnchor.factSetSha256,
		evidence_index_sha256: coderPacket.anchors.evidence_index_sha256,
		assignment_contract_sha256: assignmentHash,
		reveal_state: input.revealState,
		verbatim_blocks: {
			universal: [{
				block_id: "lab-spec",
				source_path: manifest.authority_paths.lab_spec,
				exact_text: input.frozen.spec,
				text_sha256: input.frozen.ref.specHash
			}],
			role: [{
				block_id: "role-prompt",
				source_path: promptPath,
				exact_text: prompt.text,
				text_sha256: prompt.sha256
			}],
			lane: [{
				block_id: "lane-charter",
				source_path: lanePath,
				exact_text: laneText,
				text_sha256: target.charter.charter_sha256
			}],
			stage: [],
			assignment: [{
				block_id: "postflight-review-assignment",
				source_path: assignmentPath,
				exact_text: assignmentText,
				text_sha256: assignmentHash
			}]
		},
		...coderPacket.runtime_snapshot.incumbent === void 0 ? {} : { incumbent: coderPacket.runtime_snapshot.incumbent },
		relevant_fact_refs: [...coderPacket.runtime_snapshot.relevant_fact_refs.filter((ref) => ref.id !== "fact-set"), ...factAnchor.relevantFactRefs],
		evidence_refs: coderPacket.runtime_snapshot.evidence_refs,
		open_obligation_refs: coderPacket.runtime_snapshot.open_obligation_refs,
		input_artifact_refs: Object.entries(references).map(([artifactId, reference]) => ({
			artifact_id: artifactId.replaceAll("_", "-"),
			path: reference.path,
			sha256: reference.sha256
		})),
		output_contract: outputContract
	});
	const packetPath = join(manifest.authority_paths.lab_dir, "packets", sha256(assignmentId), `${sha256(target.roleId)}.json`);
	if (await freezeExact$1(packetPath, packet.canonicalJson) !== packet.packetHash) throw new PostflightArtifactError("Postflight Role Packet file hash changed while committing", "ARTIFACT_CONFLICT");
	return {
		reviewId: input.reviewId,
		assignmentId,
		reviewInputHash,
		assignmentPath,
		assignmentHash,
		assignmentText,
		resultPath,
		packetPath,
		packet
	};
}
function sourceReferences(input) {
	return {
		current_coder_packet: input.currentCoderPacket,
		method_packet: input.methodPacket,
		preflight_result: input.preflightResult,
		coder_result: input.coderResult,
		trial: input.trial,
		run_slot: input.runSlot,
		attempt: input.attempt
	};
}
function validateInput(input) {
	if (input.reviewId.trim().length === 0 || input.judgeSessionId.trim().length === 0) throw new PostflightArtifactError("reviewId and Postflight Judge SessionId must be non-empty", "INVALID_INPUT");
	if (!Number.isSafeInteger(input.runtimeRevision) || input.runtimeRevision < 0 || !Number.isSafeInteger(input.issuedAt) || input.issuedAt < 0) throw new PostflightArtifactError("runtimeRevision and issuedAt must be non-negative safe integers", "INVALID_INPUT");
	for (const [label, reference] of Object.entries(sourceReferences(input))) if (!isAbsolute(reference.path) || !SHA256_PATTERN$3.test(reference.sha256)) throw new PostflightArtifactError(`${label} requires an absolute path and SHA-256`, "INVALID_INPUT");
}
async function assertFrozenRevision$1(frozen) {
	const manifestText = canonicalJson$1(frozen.manifest);
	if (sha256(frozen.spec) !== frozen.ref.specHash || sha256(frozen.config) !== frozen.ref.configHash || sha256(manifestText) !== frozen.ref.manifestHash || frozen.validation.specHash !== frozen.ref.specHash || frozen.validation.configHash !== frozen.ref.configHash || frozen.validation.manifestHash !== frozen.ref.manifestHash || frozen.validation.dialogueHeadHash !== frozen.ref.dialogueHeadHash || frozen.manifest.source_revision !== frozen.ref.revision || frozen.manifest.anchors.dialogue_head_sha256 !== frozen.ref.dialogueHeadHash || frozen.manifest.anchors.lab_spec_sha256 !== frozen.ref.specHash || frozen.manifest.anchors.lab_yaml_sha256 !== frozen.ref.configHash) throw new PostflightArtifactError("FrozenRevision does not match its CURRENT hashes", "CURRENT_MISMATCH");
	await Promise.all([
		assertExactAuthority(frozen.manifest.authority_paths.lab_spec, frozen.spec),
		assertExactAuthority(frozen.manifest.authority_paths.lab_yaml, frozen.config),
		assertExactAuthority(frozen.manifest.authority_paths.resolved_manifest, manifestText)
	]);
}
async function resolveJudge$1(input) {
	const manifest = input.frozen.manifest;
	const receipt = input.judgeBinding.receipt;
	const stored = await readRoleBinding(manifest.authority_paths.lab_dir, receipt.roleId);
	const role = manifest.roles.find((candidate) => candidate.role_id === receipt.roleId);
	if (role?.role_kind !== "postflight_judge") throw new PostflightArtifactError("target role is not a CURRENT Postflight Judge", "JUDGE_BINDING_MISMATCH");
	const sessionSpec = resolveRootRoleSessionSpec(manifest, role.role_id);
	if (stored === void 0 || stored.path !== input.judgeBinding.path || stored.hash !== input.judgeBinding.hash || canonicalJson$1(stored.receipt) !== canonicalJson$1(receipt) || receipt.receiptHash !== input.judgeBinding.hash || receipt.labId !== manifest.lab_id || !await isCommittedManifestHash(manifest.authority_paths.lab_dir, receipt.manifestHash) || receipt.roleId !== role.role_id || receipt.roleKind !== "postflight_judge" || receipt.sessionId !== input.judgeSessionId || receipt.permissionPresetId !== role.dsh_preset || receipt.provider !== role.model_route.provider || receipt.model !== role.model_route.model || receipt.cwd !== sessionSpec.cwd || receipt.runtimeRevision > input.runtimeRevision) throw new PostflightArtifactError("Postflight Judge Session does not match its frozen binding and CURRENT", "JUDGE_BINDING_MISMATCH");
	const lane = manifest.lanes.find((candidate) => candidate.lane_id === role.lane_id && candidate.postflight_judge_role_id === role.role_id);
	const charter = manifest.search.lane_charters.find((candidate) => candidate.lane_id === role.lane_id);
	if (lane === void 0 || charter === void 0) throw new PostflightArtifactError("Postflight Judge does not resolve to one CURRENT Lane", "JUDGE_BINDING_MISMATCH");
	return {
		roleId: role.role_id,
		laneId: lane.lane_id,
		coderRoleId: lane.coder_role_id,
		charter
	};
}
async function readCurrentCoderPacket(input, laneId$2, coderRoleId) {
	let bytes;
	try {
		bytes = await readFile(input.currentCoderPacket.path);
	} catch {
		throw new PostflightArtifactError("current Coder Packet cannot be read", "CODER_PACKET_MISMATCH");
	}
	if (sha256(bytes) !== input.currentCoderPacket.sha256) throw new PostflightArtifactError("current Coder Packet hash does not match RuntimeState", "CODER_PACKET_MISMATCH");
	let text;
	let packet;
	try {
		text = UTF8$2.decode(bytes);
		packet = parseRolePacket(JSON.parse(text));
	} catch {
		throw new PostflightArtifactError("current Coder Packet is not canonical Role Packet v1 JSON", "CODER_PACKET_MISMATCH");
	}
	const manifest = input.frozen.manifest;
	const expectedPath = join(manifest.authority_paths.lab_dir, "packets", sha256(packet.header.assignment_id), `${sha256(coderRoleId)}.json`);
	const packetRevision = await readRevisionAtPath(manifest.authority_paths.lab_dir, packet.anchors.source_revision, input.frozen);
	if (canonicalJson$1(packet) !== text || input.currentCoderPacket.path !== expectedPath || packet.header.lab_id !== manifest.lab_id || packet.header.lane_id !== laneId$2 || packet.header.role_id !== coderRoleId || packet.header.role_kind !== "coder" || packet.anchors.source_revision > input.frozen.ref.revision || packet.anchors.dialogue_head_sha256 !== packetRevision.ref.dialogueHeadHash || packet.anchors.lab_spec_sha256 !== packetRevision.ref.specHash || packet.anchors.lab_yaml_sha256 !== packetRevision.ref.configHash || packet.anchors.resolved_manifest_sha256 !== packetRevision.ref.manifestHash || packet.anchors.campaign_contract_sha256 !== packetRevision.manifest.campaign_contract_sha256 || packet.anchors.runtime_revision > input.runtimeRevision) throw new PostflightArtifactError("current Coder Packet does not bind this CURRENT Lane", "CODER_PACKET_MISMATCH");
	return packet;
}
async function assertExactAuthority(path, expected) {
	let observed;
	try {
		observed = await readFile(path, "utf8");
	} catch {
		throw new PostflightArtifactError(`CURRENT authority cannot be read at ${path}`, "CURRENT_MISMATCH");
	}
	if (observed !== expected) throw new PostflightArtifactError(`CURRENT authority bytes changed at ${path}`, "CURRENT_MISMATCH");
}
async function freezeExact$1(path, bytes) {
	if (await readFile(path, "utf8").catch((error) => {
		if (isNodeError$3(error) && error.code === "ENOENT") return void 0;
		throw error;
	}) === void 0) try {
		await durableWriteFile(path, bytes, false);
	} catch (error) {
		if (!isNodeError$3(error) || error.code !== "EEXIST") throw error;
	}
	const committed = await readFile(path, "utf8");
	if (committed !== bytes) throw new PostflightArtifactError(`Immutable Postflight artifact conflicts at ${path}`, "ARTIFACT_CONFLICT");
	return sha256(committed);
}
function isNodeError$3(value) {
	return value instanceof Error && "code" in value;
}

//#endregion
//#region src/postflight-result.ts
const SHA256_PATTERN$2 = /^[0-9a-f]{64}$/u;
const UTF8$1 = new TextDecoder("utf-8", {
	fatal: true,
	ignoreBOM: true
});
var PostflightResultError = class extends Error {
	name = "PostflightResultError";
	constructor(message, code) {
		super(message);
		this.code = code;
	}
};
/**
* Freeze the exact receipt named by a Postflight Packet. Receipt bytes remain
* opaque: no JSON parse, generic verdict enum, scientific check, or referenced
* log/checkpoint read occurs on this Runtime path.
*/
async function freezePostflightResult(input) {
	const packetPath = validatePath(input.rolePacketPath, "Role Packet path");
	const artifactPath = validatePath(input.artifactPath, "artifact path");
	if (!SHA256_PATTERN$2.test(input.rolePacketHash)) throw new PostflightResultError("Role Packet hash must be SHA-256", "INVALID_INPUT");
	if (packetPath === artifactPath) throw new PostflightResultError("Controller artifact path must differ from the Judge receipt path", "INVALID_INPUT");
	const packetBytes = await readBytes(packetPath, "Role Packet");
	const observedPacketHash = sha256(packetBytes);
	if (observedPacketHash !== input.rolePacketHash) throw new PostflightResultError("Role Packet bytes do not match the supplied hash", "PACKET_HASH_MISMATCH");
	const packet = parsePacket(packetBytes);
	if (packet.header.role_kind !== "postflight_judge") throw new PostflightResultError(`Role Packet role_kind is ${JSON.stringify(packet.header.role_kind)}, not "postflight_judge"`, "ROLE_MISMATCH");
	const receiptPath$1 = validatePath(packet.output_contract.receipt_path, "receipt path");
	if (receiptPath$1 === artifactPath) throw new PostflightResultError("Controller artifact path must differ from the Judge receipt path", "INVALID_INPUT");
	const receiptBytes = await readBytes(receiptPath$1, "Postflight receipt");
	await freezeNoClobber$1(artifactPath, receiptBytes);
	return {
		rolePacketPath: packetPath,
		rolePacketHash: observedPacketHash,
		receiptPath: receiptPath$1,
		artifactPath,
		receiptHash: sha256(receiptBytes),
		receiptBytes,
		expectedHashBinding: packet.output_contract.expected_hash_binding,
		packet
	};
}
function parsePacket(bytes) {
	let text;
	let packet;
	try {
		text = UTF8$1.decode(bytes);
		packet = parseRolePacket(JSON.parse(text));
	} catch (error) {
		throw new PostflightResultError(`Role Packet is not valid canonical JSON: ${errorMessage$1(error)}`, "INVALID_PACKET");
	}
	if (canonicalJson$1(packet) !== text) throw new PostflightResultError("Role Packet bytes are not its canonical immutable form", "INVALID_PACKET");
	return packet;
}
async function freezeNoClobber$1(path, bytes) {
	try {
		await durableWriteFile(path, bytes, false);
	} catch (error) {
		if (!isNodeError$2(error) || error.code !== "EEXIST") throw new PostflightResultError(`Cannot write immutable Postflight artifact at ${path}: ${errorMessage$1(error)}`, "ARTIFACT_WRITE_FAILED");
	}
	let committed;
	try {
		committed = await readFile(path);
	} catch (error) {
		throw new PostflightResultError(`Immutable Postflight artifact cannot be read at ${path}: ${errorMessage$1(error)}`, "ARTIFACT_CONFLICT");
	}
	if (!committed.equals(bytes)) throw new PostflightResultError(`Immutable Postflight artifact conflicts at ${path}`, "ARTIFACT_CONFLICT");
}
async function readBytes(path, label) {
	try {
		return await readFile(path);
	} catch (error) {
		throw new PostflightResultError(`${label} cannot be read at ${path}: ${errorMessage$1(error)}`, label === "Role Packet" ? "PACKET_READ_FAILED" : "RECEIPT_READ_FAILED");
	}
}
function validatePath(value, label) {
	if (typeof value !== "string" || !isAbsolute(value)) throw new PostflightResultError(`${label} must be absolute`, "INVALID_INPUT");
	return resolve(value);
}
function errorMessage$1(error) {
	return error instanceof Error ? error.message : String(error);
}
function isNodeError$2(value) {
	return value instanceof Error && "code" in value;
}

//#endregion
//#region src/review-artifacts.ts
const SHA256_PATTERN$1 = /^[0-9a-f]{64}$/u;
var PreflightReviewArtifactError = class extends Error {
	name = "PreflightReviewArtifactError";
	constructor(message, code) {
		super(message);
		this.code = code;
	}
};
/**
* Freeze one exact Preflight Judge Assignment and Role Packet. All scientific
* text is copied byte-for-byte from CURRENT, built-ins, or immutable inputs;
* no model summary or additional admission rule is introduced here.
*/
async function freezePreflightReviewArtifacts(input) {
	validateScalarInput(input);
	assertFrozenRevision(input.frozen);
	const manifest = input.frozen.manifest;
	await assertExactInput({
		path: manifest.authority_paths.lab_spec,
		sha256: input.frozen.ref.specHash
	}, "CURRENT LAB_SPEC", input.frozen.spec);
	await assertExactInput({
		path: manifest.authority_paths.resolved_manifest,
		sha256: input.frozen.ref.manifestHash
	}, "CURRENT ResolvedManifest", canonicalJson$1(manifest));
	const judge = await resolveJudge(input);
	const sourcePacket = await readSourceMethodPacket(input.sourceMethodPacket);
	await assertSourceMethodPacket(sourcePacket, input.sourceMethodAssignment, input.frozen, judge.laneId, judge.methodRoleId);
	await assertExactInput(input.sourceMethodAssignment, "source Method Assignment");
	await assertExactInput(input.designTicket, "Design Ticket");
	const prompt = rolePromptFor("preflight_judge");
	const promptPath = join(manifest.authority_paths.lab_dir, "artifacts", "builtins", `${prompt.sha256}.txt`);
	await freezeExact(promptPath, prompt.text);
	const laneText = canonicalJson$1(judge.charter.content);
	if (sha256(laneText) !== judge.charter.charter_sha256) throw new PreflightReviewArtifactError("LaneCharter bytes do not match CURRENT ResolvedManifest", "CURRENT_MISMATCH");
	const lanePath = join(manifest.authority_paths.lab_dir, "artifacts", "lanes", `${sha256(judge.laneId)}.charter.json`);
	await freezeExact(lanePath, laneText);
	const assignmentId = `preflight:${input.reviewId}`;
	const assignmentPath = join(manifest.authority_paths.assignment_root, "reviews", `${sha256(input.reviewId)}.preflight.json`);
	const verdictPath = join(manifest.authority_paths.assignment_root, "outputs", `${sha256(assignmentId)}.json`);
	const reviewInputHash = sha256(`autolab-preflight-review-input-v1\0${canonicalJson$1({
		review_id: input.reviewId,
		lab_id: manifest.lab_id,
		source_revision: input.frozen.ref.revision,
		resolved_manifest_sha256: input.frozen.ref.manifestHash,
		runtime_revision: input.runtimeRevision,
		issued_at: input.issuedAt,
		judge: {
			role_id: judge.roleId,
			session_id: input.judgeSessionId,
			binding_path: input.judgeBinding.path,
			binding_sha256: input.judgeBinding.hash
		},
		source_method_assignment: input.sourceMethodAssignment,
		source_method_packet: input.sourceMethodPacket,
		design_ticket: input.designTicket
	})}`);
	const outputContract = {
		schema: preflightVerdictSchema({
			reviewId: input.reviewId,
			assignmentId,
			reviewInputHash
		}),
		receipt_path: verdictPath,
		expected_hash_binding: reviewInputHash
	};
	const assignmentText = canonicalJson$1({
		version: 1,
		assignment_type: "preflight_review",
		review_id: input.reviewId,
		assignment_id: assignmentId,
		runtime_revision: input.runtimeRevision,
		issued_at: input.issuedAt,
		review_input_sha256: reviewInputHash,
		judge: {
			role_id: judge.roleId,
			session_id: input.judgeSessionId,
			binding_path: input.judgeBinding.path,
			binding_sha256: input.judgeBinding.hash
		},
		source_method: {
			role_id: sourcePacket.header.role_id,
			session_id: sourcePacket.header.session_id,
			assignment: artifactRef("source-method-assignment", input.sourceMethodAssignment),
			packet: artifactRef("source-method-packet", input.sourceMethodPacket)
		},
		design_ticket: artifactRef("design-ticket", input.designTicket),
		instruction: "Review the exact submitted method under this Lab's anchored original contract. Do not add unrelated gates. Return the declared output contract.",
		output_contract: outputContract
	});
	const assignmentHash = await freezeExact(assignmentPath, assignmentText);
	const factAnchor = await currentFactAnchor(manifest.authority_paths.fact_set);
	const packet = compileRolePacket({
		manifest,
		role_id: judge.roleId,
		session_id: input.judgeSessionId,
		assignment_id: assignmentId,
		issued_at: input.issuedAt,
		role_binding_receipt_sha256: input.judgeBinding.hash,
		runtime_revision: input.runtimeRevision,
		fact_set_sha256: factAnchor.factSetSha256,
		evidence_index_sha256: sourcePacket.anchors.evidence_index_sha256,
		assignment_contract_sha256: assignmentHash,
		reveal_state: sourcePacket.runtime_snapshot.reveal_state,
		verbatim_blocks: {
			universal: [{
				block_id: "lab-spec",
				source_path: manifest.authority_paths.lab_spec,
				exact_text: input.frozen.spec,
				text_sha256: input.frozen.ref.specHash
			}],
			role: [{
				block_id: "role-prompt",
				source_path: promptPath,
				exact_text: prompt.text,
				text_sha256: prompt.sha256
			}],
			lane: [{
				block_id: "lane-charter",
				source_path: lanePath,
				exact_text: laneText,
				text_sha256: judge.charter.charter_sha256
			}],
			stage: [],
			assignment: [{
				block_id: "preflight-review-assignment",
				source_path: assignmentPath,
				exact_text: assignmentText,
				text_sha256: assignmentHash
			}]
		},
		...sourcePacket.runtime_snapshot.incumbent === void 0 ? {} : { incumbent: sourcePacket.runtime_snapshot.incumbent },
		relevant_fact_refs: [...sourcePacket.runtime_snapshot.relevant_fact_refs.filter((ref) => ref.id !== "fact-set"), ...factAnchor.relevantFactRefs],
		evidence_refs: sourcePacket.runtime_snapshot.evidence_refs,
		open_obligation_refs: sourcePacket.runtime_snapshot.open_obligation_refs,
		input_artifact_refs: [
			artifactRef("design-ticket", input.designTicket),
			artifactRef("source-method-assignment", input.sourceMethodAssignment),
			artifactRef("source-method-packet", input.sourceMethodPacket)
		],
		output_contract: outputContract
	});
	const packetPath = join(manifest.authority_paths.lab_dir, "packets", sha256(assignmentId), `${sha256(judge.roleId)}.json`);
	if (await freezeExact(packetPath, packet.canonicalJson) !== packet.packetHash) throw new PreflightReviewArtifactError("Preflight Role Packet file hash changed while committing", "ARTIFACT_CONFLICT");
	return {
		reviewId: input.reviewId,
		assignmentId,
		reviewInputHash,
		assignmentPath,
		assignmentHash,
		assignmentText,
		verdictPath,
		packetPath,
		packet
	};
}
function validateScalarInput(input) {
	if (input.reviewId.trim().length === 0 || input.judgeSessionId.trim().length === 0) throw new PreflightReviewArtifactError("reviewId and Judge SessionId must be non-empty", "INVALID_INPUT");
	if (!Number.isSafeInteger(input.runtimeRevision) || input.runtimeRevision < 0 || !Number.isSafeInteger(input.issuedAt) || input.issuedAt < 0) throw new PreflightReviewArtifactError("runtimeRevision and issuedAt must be non-negative safe integers", "INVALID_INPUT");
	validateRef(input.sourceMethodAssignment, "source Method Assignment");
	validateRef(input.sourceMethodPacket, "source Method Packet");
	validateRef(input.designTicket, "Design Ticket");
}
function validateRef(reference, label) {
	if (!isAbsolute(reference.path) || !SHA256_PATTERN$1.test(reference.sha256)) throw new PreflightReviewArtifactError(`${label} requires an absolute path and SHA-256`, "INVALID_INPUT");
}
function assertFrozenRevision(frozen) {
	const manifestHash = sha256(canonicalJson$1(frozen.manifest));
	if (sha256(frozen.spec) !== frozen.ref.specHash || sha256(frozen.config) !== frozen.ref.configHash || manifestHash !== frozen.ref.manifestHash || frozen.validation.specHash !== frozen.ref.specHash || frozen.validation.configHash !== frozen.ref.configHash || frozen.validation.manifestHash !== frozen.ref.manifestHash || frozen.validation.dialogueHeadHash !== frozen.ref.dialogueHeadHash || frozen.manifest.source_revision !== frozen.ref.revision || frozen.manifest.anchors.dialogue_head_sha256 !== frozen.ref.dialogueHeadHash || frozen.manifest.anchors.lab_spec_sha256 !== frozen.ref.specHash || frozen.manifest.anchors.lab_yaml_sha256 !== frozen.ref.configHash) throw new PreflightReviewArtifactError("FrozenRevision does not match its CURRENT hashes", "CURRENT_MISMATCH");
}
async function resolveJudge(input) {
	const receipt = input.judgeBinding.receipt;
	const stored = await readRoleBinding(input.frozen.manifest.authority_paths.lab_dir, receipt.roleId);
	if (stored === void 0 || stored.path !== input.judgeBinding.path || stored.hash !== input.judgeBinding.hash || canonicalJson$1(stored.receipt) !== canonicalJson$1(receipt) || receipt.receiptHash !== input.judgeBinding.hash || receipt.labId !== input.frozen.manifest.lab_id || !await isCommittedManifestHash(input.frozen.manifest.authority_paths.lab_dir, receipt.manifestHash) || receipt.roleKind !== "preflight_judge" || receipt.sessionId !== input.judgeSessionId) throw new PreflightReviewArtifactError("Judge Session does not match its frozen RoleBindingReceipt and CURRENT", "JUDGE_BINDING_MISMATCH");
	const role = input.frozen.manifest.roles.find((candidate) => candidate.role_id === receipt.roleId);
	if (role?.role_kind !== "preflight_judge") throw new PreflightReviewArtifactError("Judge role is not a Preflight Judge", "JUDGE_BINDING_MISMATCH");
	const sessionSpec = resolveRootRoleSessionSpec(input.frozen.manifest, role.role_id);
	if (receipt.permissionPresetId !== role.dsh_preset || receipt.provider !== role.model_route.provider || receipt.model !== role.model_route.model || receipt.cwd !== sessionSpec.cwd) throw new PreflightReviewArtifactError("Judge RoleBindingReceipt does not match CURRENT role capabilities", "JUDGE_BINDING_MISMATCH");
	const lane = input.frozen.manifest.lanes.find((candidate) => candidate.lane_id === role.lane_id && candidate.preflight_judge_role_id === role.role_id);
	const charter = input.frozen.manifest.search.lane_charters.find((candidate) => candidate.lane_id === role.lane_id);
	if (lane === void 0 || charter === void 0) throw new PreflightReviewArtifactError("Preflight Judge does not resolve to one CURRENT Lane", "JUDGE_BINDING_MISMATCH");
	return {
		roleId: role.role_id,
		laneId: role.lane_id,
		methodRoleId: lane.method_role_id,
		charter
	};
}
async function readSourceMethodPacket(reference) {
	const bytes = await readExactBytes(reference, "source Method Packet");
	let value;
	try {
		value = JSON.parse(bytes.toString("utf8"));
	} catch {
		throw new PreflightReviewArtifactError("source Method Packet is not JSON", "SOURCE_PACKET_MISMATCH");
	}
	let packet;
	try {
		packet = parseRolePacket(value);
	} catch {
		throw new PreflightReviewArtifactError("source Method Packet does not satisfy Role Packet v1", "SOURCE_PACKET_MISMATCH");
	}
	if (sha256(canonicalJson$1(packet)) !== reference.sha256) throw new PreflightReviewArtifactError("source Method Packet is not the exact canonical frozen packet", "SOURCE_PACKET_MISMATCH");
	return packet;
}
async function assertSourceMethodPacket(packet, sourceAssignment, frozen, laneId$2, methodRoleId) {
	const packetRevision = await readRevisionAtPath(frozen.manifest.authority_paths.lab_dir, packet.anchors.source_revision, frozen);
	if (packet.header.lab_id !== frozen.manifest.lab_id || packet.header.lane_id !== laneId$2 || packet.header.role_id !== methodRoleId || packet.header.role_kind !== "method" || packet.anchors.source_revision > frozen.ref.revision || packet.anchors.dialogue_head_sha256 !== packetRevision.ref.dialogueHeadHash || packet.anchors.lab_spec_sha256 !== packetRevision.ref.specHash || packet.anchors.lab_yaml_sha256 !== packetRevision.ref.configHash || packet.anchors.resolved_manifest_sha256 !== packetRevision.ref.manifestHash || packet.anchors.assignment_contract_sha256 !== sourceAssignment.sha256) throw new PreflightReviewArtifactError("source Method Packet does not bind this CURRENT Lane and Assignment", "SOURCE_PACKET_MISMATCH");
}
function artifactRef(artifactId, reference) {
	return {
		artifact_id: artifactId,
		path: reference.path,
		sha256: reference.sha256
	};
}
function preflightVerdictSchema(input) {
	return {
		type: "object",
		additionalProperties: false,
		required: [
			"version",
			"review_id",
			"assignment_id",
			"review_input_sha256",
			"top_level_verdict",
			"blocking_findings",
			"reasons",
			"warnings"
		],
		properties: {
			version: { const: 1 },
			review_id: { const: input.reviewId },
			assignment_id: { const: input.assignmentId },
			review_input_sha256: { const: input.reviewInputHash },
			top_level_verdict: { enum: [
				"APPROVED",
				"REVISION_REQUIRED",
				"REJECTED",
				"REVIEW_ERROR"
			] },
			blocking_findings: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: false,
					required: [
						"rule_or_frozen_field",
						"blocked_transition",
						"conflict_or_missing_evidence"
					],
					properties: {
						rule_or_frozen_field: {
							type: "string",
							minLength: 1
						},
						blocked_transition: {
							type: "string",
							minLength: 1
						},
						conflict_or_missing_evidence: {
							type: "string",
							minLength: 1
						}
					}
				}
			},
			reasons: {
				type: "array",
				items: {
					type: "string",
					minLength: 1
				}
			},
			warnings: {
				type: "array",
				items: {
					type: "string",
					minLength: 1
				}
			}
		}
	};
}
async function assertExactInput(reference, label, expectedText) {
	const bytes = await readExactBytes(reference, label);
	if (expectedText !== void 0 && !bytes.equals(Buffer.from(expectedText, "utf8"))) throw new PreflightReviewArtifactError(`${label} bytes differ from the supplied frozen authority`, "INPUT_HASH_MISMATCH");
}
async function readExactBytes(reference, label) {
	let bytes;
	try {
		bytes = await readFile(reference.path);
	} catch {
		throw new PreflightReviewArtifactError(`${label} cannot be read`, "INPUT_HASH_MISMATCH");
	}
	if (sha256(bytes) !== reference.sha256) throw new PreflightReviewArtifactError(`${label} SHA-256 mismatch`, "INPUT_HASH_MISMATCH");
	return bytes;
}
async function freezeExact(path, bytes) {
	if (await readFile(path, "utf8").catch((error) => {
		if (isNodeError$1(error) && error.code === "ENOENT") return void 0;
		throw error;
	}) === void 0) try {
		await durableWriteFile(path, bytes, false);
	} catch (error) {
		if (!isNodeError$1(error) || error.code !== "EEXIST") throw error;
	}
	const committed = await readFile(path, "utf8");
	if (committed !== bytes) throw new PreflightReviewArtifactError(`Immutable Preflight review artifact conflicts at ${path}`, "ARTIFACT_CONFLICT");
	return sha256(committed);
}
function isNodeError$1(value) {
	return value instanceof Error && "code" in value;
}

//#endregion
//#region src/role-assignment.ts
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UTF8 = new TextDecoder("utf-8", {
	fatal: true,
	ignoreBOM: true
});
const METHOD_SOURCE_PREFLIGHT_VERDICT_ARTIFACT_ID = "source-preflight-verdict";
var RoleAssignmentError = class extends Error {
	name = "RoleAssignmentError";
	constructor(message, code) {
		super(message);
		this.code = code;
	}
};
/**
* Freeze one Controller-selected Assignment and Role Packet. This is only an
* artifact compiler: role, objective, opaque content, schema, and references
* are all explicit inputs, and no downstream route is selected here.
*/
async function freezeRoleAssignment(input) {
	validateAssignmentInput(input);
	return await freezeControllerAssignment(input, {
		assignmentType: "controller_role_assignment",
		blockId: "controller-role-assignment",
		outputSchema: input.outputSchema,
		expectedHashBinding: input.assignmentId
	});
}
/** Freeze one Controller-authored Method Assignment with the native ticket contract. */
async function freezeMethodAssignment(input) {
	validateMethodAssignmentInput(input);
	const inputArtifactRefs = methodAssignmentInputArtifactRefs(input);
	return await freezeControllerAssignment({
		...input,
		inputArtifactRefs
	}, {
		assignmentType: "controller_method_assignment",
		blockId: "controller-method-assignment",
		outputSchema: methodDesignTicketOutputSchema(),
		expectedHashBinding: METHOD_TICKET_HASH_BINDING,
		...input.sourceReviewId === void 0 ? {} : { sourceReviewId: input.sourceReviewId }
	});
}
async function freezeControllerAssignment(input, flavor) {
	await assertStoredBinding(input);
	let current;
	try {
		current = await restoreCurrentRoleArtifacts({
			frozen: input.frozen,
			role: input.role,
			sessionId: input.sessionId,
			binding: input.binding,
			runtimeRevision: input.runtimeRevision,
			packetRef: input.currentPacket
		});
	} catch (error) {
		if (!(error instanceof ActivationArtifactError) || error.message !== "Role Packet does not carry its own exact LAB_SPEC block") throw error;
		current = void 0;
	}
	if (current !== void 0 && input.runtimeRevision < current.packet.packet.anchors.runtime_revision) throw new RoleAssignmentError("new Assignment runtime revision precedes the current Role Packet", "INVALID_INPUT");
	const manifest = input.frozen.manifest;
	const roleKey = sha256(input.role.role_id);
	const assignmentKey = sha256(input.assignmentId);
	const prompt = rolePromptFor(input.role.role_kind);
	const promptPath = join(manifest.authority_paths.lab_dir, "artifacts", "builtins", `${prompt.sha256}.txt`);
	await freezeNoClobber(promptPath, prompt.text, "ARTIFACT_CONFLICT");
	const laneId$2 = "lane_id" in input.role ? input.role.lane_id : void 0;
	const lane = laneId$2 === void 0 ? void 0 : manifest.search.lane_charters.find((charter) => charter.lane_id === laneId$2);
	let laneBlock;
	if (lane !== void 0) {
		const laneText = canonicalJson$1(lane.content);
		if (sha256(laneText) !== lane.charter_sha256) throw new RoleAssignmentError(`LaneCharter bytes do not match CURRENT ResolvedManifest for ${input.role.role_id}`, "ARTIFACT_CONFLICT");
		const lanePath = join(manifest.authority_paths.lab_dir, "artifacts", "lanes", `${sha256(lane.lane_id)}.charter.json`);
		await freezeNoClobber(lanePath, laneText, "ARTIFACT_CONFLICT");
		laneBlock = {
			block_id: "lane-charter",
			source_path: lanePath,
			exact_text: laneText,
			text_sha256: lane.charter_sha256
		};
	}
	const assignmentPath = join(manifest.authority_paths.assignment_root, "roles", roleKey, `${assignmentKey}.json`);
	const receiptPath$1 = join(manifest.authority_paths.assignment_root, "outputs", roleKey, `${assignmentKey}.json`);
	const outputContract = {
		schema: flavor.outputSchema,
		receipt_path: receiptPath$1,
		expected_hash_binding: flavor.expectedHashBinding
	};
	let assignmentText;
	try {
		assignmentText = canonicalJson$1(controllerAssignmentDocument(input, flavor, input.runtimeRevision, input.issuedAt, receiptPath$1));
	} catch (error) {
		throw new RoleAssignmentError(`Assignment content and output contract must be JSON values: ${errorMessage(error)}`, "INVALID_INPUT");
	}
	const assignmentHash = await freezeText(assignmentPath, assignmentText);
	const factAnchor = await currentFactAnchor(manifest.authority_paths.fact_set);
	let packet;
	try {
		packet = compileRolePacket({
			manifest,
			role_id: input.role.role_id,
			session_id: input.sessionId,
			assignment_id: input.assignmentId,
			issued_at: input.issuedAt,
			role_binding_receipt_sha256: input.binding.hash,
			runtime_revision: input.runtimeRevision,
			fact_set_sha256: factAnchor.factSetSha256,
			evidence_index_sha256: current === void 0 ? sha256(await readRequiredText(manifest.authority_paths.evidence_index, "Evidence index")) : current.packet.packet.anchors.evidence_index_sha256,
			assignment_contract_sha256: assignmentHash,
			reveal_state: input.currentRevealState ?? (current === void 0 ? manifest.communication.reveal_policy.initial_state : current.packet.packet.runtime_snapshot.reveal_state),
			verbatim_blocks: {
				universal: [{
					block_id: "lab-spec",
					source_path: manifest.authority_paths.lab_spec,
					exact_text: input.frozen.spec,
					text_sha256: input.frozen.ref.specHash
				}],
				role: [{
					block_id: "role-prompt",
					source_path: promptPath,
					exact_text: prompt.text,
					text_sha256: prompt.sha256
				}],
				lane: laneBlock === void 0 ? [] : [laneBlock],
				stage: current === void 0 ? [] : current.packet.packet.verbatim_blocks.stage,
				assignment: [{
					block_id: flavor.blockId,
					source_path: assignmentPath,
					exact_text: assignmentText,
					text_sha256: assignmentHash
				}]
			},
			...current === void 0 || current.packet.packet.runtime_snapshot.incumbent === void 0 ? {} : { incumbent: current.packet.packet.runtime_snapshot.incumbent },
			relevant_fact_refs: [...current === void 0 ? [] : current.packet.packet.runtime_snapshot.relevant_fact_refs.filter((ref) => ref.id !== "fact-set"), ...factAnchor.relevantFactRefs],
			evidence_refs: current === void 0 ? [] : current.packet.packet.runtime_snapshot.evidence_refs,
			open_obligation_refs: current === void 0 ? [] : current.packet.packet.runtime_snapshot.open_obligation_refs,
			input_artifact_refs: input.inputArtifactRefs.map((reference) => ({ ...reference })),
			output_contract: outputContract
		});
	} catch (error) {
		throw new RoleAssignmentError(`cannot compile Controller-selected Role Packet: ${errorMessage(error)}`, "INVALID_INPUT");
	}
	const packetPath = join(manifest.authority_paths.lab_dir, "packets", assignmentKey, `${roleKey}.json`);
	if (await freezeText(packetPath, packet.canonicalJson) !== packet.packetHash) throw new RoleAssignmentError("Role Packet file hash changed while committing", "ARTIFACT_CONFLICT");
	return {
		assignmentId: input.assignmentId,
		assignmentPath,
		assignmentHash,
		assignmentText,
		objectiveBody: input.objective,
		receiptPath: receiptPath$1,
		outputContract,
		packetPath,
		packet
	};
}
/**
* Prove that an idempotent dispatch is the exact same Controller request. The
* comparison is purely mechanical: opaque content and schema are compared as
* canonical JSON and referenced targets are never opened.
*/
function assertRoleAssignmentReplay(packet, input) {
	assertDispatchableRole(input.role.role_kind);
	assertControllerAssignmentReplay(packet, input, {
		assignmentType: "controller_role_assignment",
		blockId: "controller-role-assignment",
		outputSchema: input.outputSchema,
		expectedHashBinding: input.assignmentId
	});
}
/** Exact replay binding for the dedicated Method Assignment path. */
function assertMethodAssignmentReplay(packet, input) {
	assertMethodRole(input.role);
	validateMethodSourceReview(input);
	const inputArtifactRefs = methodAssignmentInputArtifactRefs(input);
	assertControllerAssignmentReplay(packet, {
		...input,
		inputArtifactRefs
	}, {
		assignmentType: "controller_method_assignment",
		blockId: "controller-method-assignment",
		outputSchema: methodDesignTicketOutputSchema(),
		expectedHashBinding: METHOD_TICKET_HASH_BINDING,
		...input.sourceReviewId === void 0 ? {} : { sourceReviewId: input.sourceReviewId }
	});
}
function assertControllerAssignmentReplay(packet, input, flavor) {
	const outputContract = {
		schema: flavor.outputSchema,
		receipt_path: packet.output_contract.receipt_path,
		expected_hash_binding: flavor.expectedHashBinding
	};
	const expectedAssignment = canonicalJson$1(controllerAssignmentDocument(input, flavor, packet.anchors.runtime_revision, packet.header.issued_at, packet.output_contract.receipt_path));
	const assignmentBlocks = packet.verbatim_blocks.assignment;
	if (packet.header.assignment_id !== input.assignmentId || packet.header.role_id !== input.role.role_id || packet.header.role_kind !== input.role.role_kind || packet.header.session_id !== input.sessionId || assignmentBlocks.length !== 1 || assignmentBlocks[0].exact_text !== expectedAssignment || assignmentBlocks[0].text_sha256 !== sha256(expectedAssignment) || canonicalJson$1(packet.output_contract) !== canonicalJson$1(outputContract) || canonicalJson$1(packet.runtime_snapshot.input_artifact_refs) !== canonicalJson$1(input.inputArtifactRefs)) throw new RoleAssignmentError(`Assignment ${JSON.stringify(input.assignmentId)} conflicts with its immutable Controller request`, "ARTIFACT_CONFLICT");
}
function controllerAssignmentDocument(input, flavor, runtimeRevision, issuedAt, receiptPath$1) {
	return {
		version: 1,
		assignment_type: flavor.assignmentType,
		assignment_id: input.assignmentId,
		runtime_revision: runtimeRevision,
		issued_at: issuedAt,
		role_id: input.role.role_id,
		role_kind: input.role.role_kind,
		session_id: input.sessionId,
		objective: input.objective,
		content: input.content,
		input_artifact_refs: input.inputArtifactRefs.map((reference) => ({ ...reference })),
		...flavor.sourceReviewId === void 0 ? {} : { source_review_id: flavor.sourceReviewId },
		output_contract: {
			schema: flavor.outputSchema,
			receipt_path: receiptPath$1,
			expected_hash_binding: flavor.expectedHashBinding
		}
	};
}
/** Do not let a newer request erase an install whose Goal effect may exist. */
function assertRoleAssignmentMayDispatch(current, requestedAssignmentId) {
	if (current?.status === "activating" && current.assignmentId !== requestedAssignmentId) throw new RoleAssignmentError(`Assignment ${JSON.stringify(current.assignmentId)} is still activating and must be reconciled before ${JSON.stringify(requestedAssignmentId)}`, "ARTIFACT_CONFLICT");
}
/**
* Freeze the exact receipt path named by a dispatched Role Packet. Receipt
* bytes are copied verbatim: no JSON parse, schema evaluation, scientific
* classification, or referenced artifact read occurs on this path.
*/
async function freezeRoleAssignmentReceipt(input) {
	const packetPath = absolutePath(input.rolePacketPath, "Role Packet path");
	const artifactPath = absolutePath(input.artifactPath, "receipt artifact path");
	if (!SHA256_PATTERN.test(input.rolePacketHash)) throw new RoleAssignmentError("Role Packet hash must be SHA-256", "INVALID_INPUT");
	if (packetPath === artifactPath) throw new RoleAssignmentError("receipt artifact path must differ from the Role Packet path", "INVALID_INPUT");
	const packetBytes = await readPacket(packetPath);
	const observedHash = sha256(packetBytes);
	if (observedHash !== input.rolePacketHash) throw new RoleAssignmentError("Role Packet bytes do not match the projected hash", "PACKET_HASH_MISMATCH");
	const packet = parseCanonicalPacket(packetBytes);
	assertDispatchableRole(packet.header.role_kind);
	const receiptPath$1 = absolutePath(packet.output_contract.receipt_path, "output receipt path");
	if (receiptPath$1 === artifactPath) throw new RoleAssignmentError("immutable artifact path must differ from the mutable output receipt path", "INVALID_INPUT");
	let receiptBytes;
	try {
		receiptBytes = await readFile(receiptPath$1);
	} catch (error) {
		throw new RoleAssignmentError(`output receipt cannot be read at ${receiptPath$1}: ${errorMessage(error)}`, "RECEIPT_READ_FAILED");
	}
	await freezeBytes(artifactPath, receiptBytes);
	return {
		assignmentId: packet.header.assignment_id,
		roleId: packet.header.role_id,
		sessionId: packet.header.session_id,
		rolePacketPath: packetPath,
		rolePacketHash: observedHash,
		receiptPath: receiptPath$1,
		artifactPath,
		receiptHash: sha256(receiptBytes),
		expectedHashBinding: packet.output_contract.expected_hash_binding,
		packet
	};
}
function validateAssignmentInput(input) {
	assertDispatchableRole(input.role.role_kind);
	validateCommonAssignmentInput(input);
}
function validateMethodAssignmentInput(input) {
	assertMethodRole(input.role);
	validateMethodSourceReview(input);
	validateCommonAssignmentInput(input);
}
function validateMethodSourceReview(input) {
	if (input.sourceReviewId === void 0 !== (input.sourceReviewVerdict === void 0)) throw new RoleAssignmentError("sourceReviewId and sourceReviewVerdict must be present together", "INVALID_INPUT");
	if (input.sourceReviewId === void 0 || input.sourceReviewVerdict === void 0) return;
	if (input.sourceReviewId.trim().length === 0) throw new RoleAssignmentError("sourceReviewId must not be blank", "INVALID_INPUT");
	if (!isAbsolute(input.sourceReviewVerdict.path) || !SHA256_PATTERN.test(input.sourceReviewVerdict.sha256)) throw new RoleAssignmentError("sourceReviewVerdict requires an absolute path and SHA-256", "INVALID_INPUT");
}
/**
* Bind a revision Assignment to the exact frozen verdict selected by the
* Controller. The referenced bytes remain opaque and are never opened here.
*/
function methodAssignmentInputArtifactRefs(input) {
	if (input.sourceReviewId === void 0 || input.sourceReviewVerdict === void 0) return input.inputArtifactRefs;
	const required = {
		artifact_id: METHOD_SOURCE_PREFLIGHT_VERDICT_ARTIFACT_ID,
		path: input.sourceReviewVerdict.path,
		sha256: input.sourceReviewVerdict.sha256
	};
	const merged = [];
	for (const reference of input.inputArtifactRefs) {
		if (reference.artifact_id !== METHOD_SOURCE_PREFLIGHT_VERDICT_ARTIFACT_ID) {
			merged.push(reference);
			continue;
		}
		if (reference.path !== required.path || reference.sha256 !== required.sha256) throw new RoleAssignmentError(`input artifact ${JSON.stringify(METHOD_SOURCE_PREFLIGHT_VERDICT_ARTIFACT_ID)} conflicts with source review ${JSON.stringify(input.sourceReviewId)}`, "ARTIFACT_CONFLICT");
	}
	merged.push(required);
	return merged;
}
function validateCommonAssignmentInput(input) {
	if (input.assignmentId.length === 0 || input.objective.length === 0 || input.sessionId.length === 0 || !Number.isSafeInteger(input.runtimeRevision) || input.runtimeRevision < 0 || !Number.isSafeInteger(input.issuedAt) || input.issuedAt < 0) throw new RoleAssignmentError("Assignment identity, objective, Session, revision, and issue time are invalid", "INVALID_INPUT");
	for (const reference of input.inputArtifactRefs) if (reference.artifact_id.length === 0 || !isAbsolute(reference.path) || !SHA256_PATTERN.test(reference.sha256)) throw new RoleAssignmentError("input artifact references require an id, absolute path, and SHA-256", "INVALID_INPUT");
}
async function assertStoredBinding(input) {
	const stored = await readRoleBinding(input.frozen.manifest.authority_paths.lab_dir, input.role.role_id);
	if (stored === void 0 || stored.path !== input.binding.path || stored.hash !== input.binding.hash || canonicalJson$1(stored.receipt) !== canonicalJson$1(input.binding.receipt)) throw new RoleAssignmentError(`Role ${JSON.stringify(input.role.role_id)} binding does not match its durable receipt`, "BINDING_MISMATCH");
}
function assertMethodRole(role) {
	if (role.role_kind !== "method") throw new RoleAssignmentError(`Controller Method Assignment does not target ${JSON.stringify(role.role_kind)}`, "UNSUPPORTED_ROLE");
}
function assertDispatchableRole(roleKind) {
	if (roleKind !== "ops" && roleKind !== "coordinator") throw new RoleAssignmentError(`Controller Role Assignment does not target ${JSON.stringify(roleKind)}`, "UNSUPPORTED_ROLE");
}
function parseCanonicalPacket(bytes) {
	let text;
	let packet;
	try {
		text = UTF8.decode(bytes);
		packet = parseRolePacket(JSON.parse(text));
	} catch (error) {
		throw new RoleAssignmentError(`Role Packet is not valid canonical JSON: ${errorMessage(error)}`, "INVALID_PACKET");
	}
	if (canonicalJson$1(packet) !== text) throw new RoleAssignmentError("Role Packet bytes are not its canonical immutable form", "INVALID_PACKET");
	return packet;
}
async function readPacket(path) {
	try {
		return await readFile(path);
	} catch (error) {
		throw new RoleAssignmentError(`Role Packet cannot be read at ${path}: ${errorMessage(error)}`, "PACKET_READ_FAILED");
	}
}
async function freezeText(path, text) {
	await freezeNoClobber(path, text, "ARTIFACT_CONFLICT");
	return sha256(text);
}
async function readRequiredText(path, label) {
	let bytes;
	try {
		bytes = await readFile(path);
	} catch (error) {
		throw new RoleAssignmentError(`${label} cannot be read at ${path}: ${errorMessage(error)}`, "PACKET_READ_FAILED");
	}
	try {
		return UTF8.decode(bytes);
	} catch (error) {
		throw new RoleAssignmentError(`${label} at ${path} is not UTF-8: ${errorMessage(error)}`, "PACKET_READ_FAILED");
	}
}
async function freezeBytes(path, bytes) {
	await freezeNoClobber(path, bytes, "RECEIPT_CONFLICT");
}
async function freezeNoClobber(path, bytes, conflictCode) {
	try {
		await durableWriteFile(path, bytes, false);
	} catch (error) {
		if (!isNodeError(error) || error.code !== "EEXIST") throw new RoleAssignmentError(`cannot write immutable artifact at ${path}: ${errorMessage(error)}`, conflictCode === "RECEIPT_CONFLICT" ? "RECEIPT_WRITE_FAILED" : conflictCode);
	}
	let committed;
	try {
		committed = await readFile(path);
	} catch (error) {
		throw new RoleAssignmentError(`immutable artifact cannot be read at ${path}: ${errorMessage(error)}`, conflictCode);
	}
	const expected = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
	if (!committed.equals(expected)) throw new RoleAssignmentError(`immutable artifact conflicts at ${path}`, conflictCode);
}
function absolutePath(value, label) {
	if (typeof value !== "string" || !isAbsolute(value)) throw new RoleAssignmentError(`${label} must be absolute`, "INVALID_INPUT");
	return resolve(value);
}
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
function isNodeError(value) {
	return value instanceof Error && "code" in value;
}

//#endregion
//#region src/role-session.ts
var AutoLabRoleSessionError = class extends Error {
	name = "AutoLabRoleSessionError";
	constructor(message, code) {
		super(message);
		this.code = code;
	}
};
/** Create a genuinely new root-role Session under the exact supplied SessionId. */
async function createRootRoleSession(ctx, input) {
	const spec = resolveRootRoleSessionSpec(input.manifest, input.roleId);
	assertPreboundSession(spec.role, input.sessionId);
	const sessionId = SessionId(input.sessionId);
	assertNotLive(ctx, sessionId);
	const presets = requireAgentPresets(ctx);
	const permissions = requirePermissionPresets(ctx);
	permissions.resolve(spec.role.dsh_preset);
	const resolvedPreset = await presets.resolve(input.agentPresetId);
	const writer = await reserveSessionWriter(ctx, sessionId);
	try {
		const handle = await ctx.agents.create({
			sessionId,
			seed: [],
			meta: {
				cwd: spec.cwd,
				agentPreset: resolvedPreset.id
			},
			agentOptions: {
				provider: spec.role.model_route.provider,
				model: spec.role.model_route.model
			},
			...input.signal === void 0 ? {} : { signal: input.signal },
			setup: async (agentCtx) => {
				const agent = requireSetupAgent(agentCtx);
				assertAgentIdentity(agent, sessionId, spec.cwd, spec.role.model_route);
				const mounted = await presets.mount(agentCtx, resolvedPreset.id);
				if (mounted.id !== resolvedPreset.id) throw new AutoLabRoleSessionError(`agent preset mount returned ${JSON.stringify(mounted.id)} for resolved preset ${JSON.stringify(resolvedPreset.id)}`, "AGENT_PRESET_MISMATCH");
				installRoleRuntime(agentCtx, spec.role);
				permissions.set(agent.session, spec.role.dsh_preset);
				if (permissions.current(agent.session.events) !== spec.role.dsh_preset) throw new AutoLabRoleSessionError(`permission preset ${JSON.stringify(spec.role.dsh_preset)} was not applied to Session ${JSON.stringify(String(sessionId))}`, "PERMISSION_PRESET_MISMATCH");
				await installAndVerifyKernel(agentCtx, agent, spec.kernel.text);
				await assertModelSelection(agentCtx, agent, spec.role.model_route);
			}
		});
		if (permissions.current(handle.agent.session.events) !== spec.role.dsh_preset) {
			await handle.dispose();
			throw new AutoLabRoleSessionError(`Session ${JSON.stringify(String(sessionId))} published without permission preset ${JSON.stringify(spec.role.dsh_preset)}`, "PERMISSION_PRESET_MISMATCH");
		}
		return ownedRoleHandle(handle, writer, {
			roleId: spec.role.role_id,
			roleKind: spec.role.role_kind,
			sessionId,
			cwd: spec.cwd,
			agentPresetId: resolvedPreset.id,
			permissionPresetId: spec.role.dsh_preset
		});
	} catch (error) {
		await writer.release().catch(() => void 0);
		throw error;
	}
}
/**
* Resume the exact persisted root-role Session. This path never calls create
* and never substitutes a fresh Session when persistence rejects or is absent.
*/
async function resumeRootRoleSession(ctx, input) {
	const spec = resolveRootRoleSessionSpec(input.manifest, input.roleId);
	assertPreboundSession(spec.role, input.sessionId);
	const sessionId = SessionId(input.sessionId);
	assertNotLive(ctx, sessionId);
	const presets = requireAgentPresets(ctx);
	const permissions = requirePermissionPresets(ctx);
	permissions.resolve(spec.role.dsh_preset);
	const writer = await reserveSessionWriter(ctx, sessionId);
	try {
		let mountedPresetId;
		const handle = await ctx.agents.resume({
			resumeSessionId: sessionId,
			agentOptions: {
				provider: spec.role.model_route.provider,
				model: spec.role.model_route.model
			},
			...input.signal === void 0 ? {} : { signal: input.signal },
			setup: async (agentCtx) => {
				const agent = requireSetupAgent(agentCtx);
				assertAgentIdentity(agent, sessionId, spec.cwd, spec.role.model_route);
				const storedPresetId = agent.session.header.agentPreset;
				if (storedPresetId === void 0) throw new AutoLabRoleSessionError(`persisted Session ${JSON.stringify(String(sessionId))} has no agent preset identity`, "AGENT_PRESET_MISSING");
				if (input.agentPresetId !== void 0 && input.agentPresetId !== storedPresetId) throw new AutoLabRoleSessionError(`persisted Session ${JSON.stringify(String(sessionId))} uses agent preset ${JSON.stringify(storedPresetId)}, not ${JSON.stringify(input.agentPresetId)}`, "AGENT_PRESET_MISMATCH");
				const mounted = await presets.mount(agentCtx, storedPresetId);
				if (mounted.id !== storedPresetId) throw new AutoLabRoleSessionError(`agent preset mount returned ${JSON.stringify(mounted.id)} for persisted preset ${JSON.stringify(storedPresetId)}`, "AGENT_PRESET_MISMATCH");
				mountedPresetId = storedPresetId;
				installRoleRuntime(agentCtx, spec.role);
				const currentPermission = permissions.current(agent.session.events);
				if (currentPermission !== spec.role.dsh_preset) throw new AutoLabRoleSessionError(`persisted Session ${JSON.stringify(String(sessionId))} uses permission preset ${JSON.stringify(currentPermission)}, not ${JSON.stringify(spec.role.dsh_preset)}`, "PERMISSION_PRESET_MISMATCH");
				await installAndVerifyKernel(agentCtx, agent, spec.kernel.text);
				await assertModelSelection(agentCtx, agent, spec.role.model_route);
			}
		});
		if (mountedPresetId === void 0) {
			await handle.dispose();
			throw new AutoLabRoleSessionError(`persisted Session ${JSON.stringify(String(sessionId))} published without a mounted agent preset`, "AGENT_PRESET_MISSING");
		}
		return ownedRoleHandle(handle, writer, {
			roleId: spec.role.role_id,
			roleKind: spec.role.role_kind,
			sessionId,
			cwd: spec.cwd,
			agentPresetId: mountedPresetId,
			permissionPresetId: spec.role.dsh_preset
		});
	} catch (error) {
		await writer.release().catch(() => void 0);
		throw error;
	}
}
/**
* Verify a live Agent that is owned elsewhere before borrowing it. This never
* mutates or disposes the Agent; every checked property is already observable
* from its DSH Session or scoped runtime.
*/
async function verifyBorrowedRootRoleSession(ctx, input, agent) {
	const spec = resolveRootRoleSessionSpec(input.manifest, input.roleId);
	assertPreboundSession(spec.role, input.sessionId);
	const sessionId = SessionId(input.sessionId);
	if (ctx.agents.get(sessionId) !== agent) throw new AutoLabRoleSessionError(`Session ${JSON.stringify(String(sessionId))} is not the exact live Agent in the DSH registry`, "SESSION_ID_MISMATCH");
	assertAgentIdentity(agent, sessionId, spec.cwd, spec.role.model_route);
	const expectedPreset = input.agentPresetId;
	if (expectedPreset === void 0 || agent.session.header.agentPreset !== expectedPreset) throw new AutoLabRoleSessionError(`live Session ${JSON.stringify(String(sessionId))} does not use the frozen agent preset ${JSON.stringify(expectedPreset)}`, "AGENT_PRESET_MISMATCH");
	if (requirePermissionPresets(ctx).current(agent.session.events) !== spec.role.dsh_preset) throw new AutoLabRoleSessionError(`live Session ${JSON.stringify(String(sessionId))} does not use permission preset ${JSON.stringify(spec.role.dsh_preset)}`, "PERMISSION_PRESET_MISMATCH");
	await assertKernel(agent.ctx, agent, spec.kernel.text);
	await assertModelSelection(agent.ctx, agent, spec.role.model_route);
	assertToolScope(ctx, agent, spec.role.allowed_tools);
}
function installRoleRuntime(agentCtx, role) {
	installModelSelection(agentCtx, {
		current: {
			provider: role.model_route.provider,
			model: role.model_route.model,
			...role.reasoning.mode === "default" ? {} : { reasoningEffort: ReasoningEffortId(role.reasoning.mode) }
		},
		assembled: void 0
	});
	try {
		agentCtx.tools.restrict({ allow: role.allowed_tools });
	} catch (error) {
		throw new AutoLabRoleSessionError(`role ${JSON.stringify(role.role_id)} tool scope is invalid: ${renderError(error)}`, "TOOL_SCOPE_MISMATCH");
	}
}
async function installAndVerifyKernel(agentCtx, agent, text) {
	const systemPrompt = agentCtx.get("systemPrompt", false);
	if (systemPrompt === void 0) throw new AutoLabRoleSessionError("DSH system-prompt service is unavailable in Agent setup", "SYSTEM_PROMPT_UNAVAILABLE");
	systemPrompt.section({
		name: ROLE_KERNEL_SECTION,
		order: ROLE_KERNEL_ORDER,
		text
	});
	if ((await systemPrompt.assemble(assembleContextFor(agent))).sections.find((section) => section.name === ROLE_KERNEL_SECTION)?.text !== text) throw new AutoLabRoleSessionError(`role kernel ${JSON.stringify(ROLE_KERNEL_SECTION)} is not effective in Session ${JSON.stringify(String(agent.id))}`, "ROLE_KERNEL_NOT_EFFECTIVE");
}
async function assertKernel(agentCtx, agent, text) {
	if ((await requireSystemPrompt(agentCtx).assemble(assembleContextFor(agent))).sections.find((section) => section.name === ROLE_KERNEL_SECTION)?.text !== text) throw new AutoLabRoleSessionError(`role kernel ${JSON.stringify(ROLE_KERNEL_SECTION)} is not effective in Session ${JSON.stringify(String(agent.id))}`, "ROLE_KERNEL_NOT_EFFECTIVE");
}
async function assertModelSelection(agentCtx, agent, route$1) {
	const assembled = await requireSystemPrompt(agentCtx).assemble(assembleContextFor(agent));
	if (assembled.variables.provider !== route$1.provider || assembled.variables.model !== route$1.model) throw new AutoLabRoleSessionError(`Session ${JSON.stringify(String(agent.id))} model selection is not effective in prompt assembly`, "MODEL_SELECTION_NOT_EFFECTIVE");
}
function assertToolScope(ctx, agent, allowedTools) {
	const allowed = new Set(allowedTools);
	for (const schema of ctx.tools.schemas()) {
		const globalDefinition = ctx.tools.get(schema.name);
		const scopedDefinition = ctx.tools.get(schema.name, agent);
		if (allowed.has(schema.name)) {
			if (scopedDefinition === void 0) throw new AutoLabRoleSessionError(`live Session ${JSON.stringify(String(agent.id))} is missing allowed tool ${JSON.stringify(schema.name)}`, "TOOL_SCOPE_MISMATCH");
		} else if (scopedDefinition === globalDefinition) throw new AutoLabRoleSessionError(`live Session ${JSON.stringify(String(agent.id))} still inherits disallowed tool ${JSON.stringify(schema.name)}`, "TOOL_SCOPE_MISMATCH");
	}
}
function requireSystemPrompt(ctx) {
	const systemPrompt = ctx.get("systemPrompt", false);
	if (systemPrompt === void 0) throw new AutoLabRoleSessionError("DSH system-prompt service is unavailable in Agent setup", "SYSTEM_PROMPT_UNAVAILABLE");
	return systemPrompt;
}
function assertAgentIdentity(agent, sessionId, cwd, route$1) {
	if (agent.id !== sessionId || agent.session.id !== sessionId) throw new AutoLabRoleSessionError(`Agent factory did not preserve SessionId ${JSON.stringify(String(sessionId))}`, "SESSION_ID_MISMATCH");
	if (agent.session.header.cwd !== cwd) throw new AutoLabRoleSessionError(`Session ${JSON.stringify(String(sessionId))} cwd is ${JSON.stringify(agent.session.header.cwd)}, expected ${JSON.stringify(cwd)}`, "SESSION_CWD_MISMATCH");
	if (agent.options.provider !== route$1.provider || agent.options.model !== route$1.model) throw new AutoLabRoleSessionError(`Session ${JSON.stringify(String(sessionId))} model route does not match its role binding`, "MODEL_ROUTE_MISMATCH");
}
function assertNotLive(ctx, sessionId) {
	if (ctx.agents.get(sessionId) !== void 0) throw new AutoLabRoleSessionError(`Session ${JSON.stringify(String(sessionId))} is already live; only its existing owner handle may adopt it`, "SESSION_ALREADY_LIVE");
}
function assertPreboundSession(role, sessionId) {
	if (role.prebound_session_id !== void 0 && role.prebound_session_id !== sessionId) throw new AutoLabRoleSessionError(`role ${JSON.stringify(role.role_id)} is prebound to SessionId ${JSON.stringify(role.prebound_session_id)}, not ${JSON.stringify(sessionId)}`, "PREBOUND_SESSION_MISMATCH");
}
function requireSetupAgent(agentCtx) {
	const agent = agentCtx.agent;
	if (agent === void 0) throw new AutoLabRoleSessionError("Agent setup did not receive the unpublished scoped Agent", "SESSION_ID_MISMATCH");
	return agent;
}
function requireAgentPresets(ctx) {
	const service = ctx.get("agentPresets", false);
	if (service === void 0) throw new AutoLabRoleSessionError("DSH agent-presets service is unavailable; role capabilities cannot be composed", "AGENT_PRESETS_UNAVAILABLE");
	return service;
}
function requirePermissionPresets(ctx) {
	const service = ctx.get("permissionPresets", false);
	if (service === void 0) throw new AutoLabRoleSessionError("DSH permission-presets service is unavailable; role execution permission cannot be pinned", "PERMISSION_PRESETS_UNAVAILABLE");
	return service;
}
function requireSessionMessaging(ctx) {
	const service = ctx.get("sessionMessaging", false);
	if (service === void 0 || typeof service.reserveSessionWriter !== "function") throw new AutoLabRoleSessionError("local Session messaging does not provide the persistence writer fence", "SESSION_WRITER_UNAVAILABLE");
	return service;
}
async function reserveSessionWriter(ctx, sessionId) {
	return await requireSessionMessaging(ctx).reserveSessionWriter(sessionId);
}
function ownedRoleHandle(handle, writer, metadata) {
	let disposed;
	return {
		...metadata,
		agent: handle.agent,
		dispose: () => {
			disposed ??= (async () => {
				let agentFailure;
				try {
					await handle.dispose();
				} catch (error) {
					agentFailure = error;
				}
				try {
					await writer.release();
				} catch (writerFailure) {
					if (agentFailure !== void 0) throw new AggregateError([agentFailure, writerFailure], "failed to dispose the role Agent and release its Session writer fence");
					throw writerFailure;
				}
				if (agentFailure !== void 0) throw agentFailure;
			})();
			return disposed;
		}
	};
}
function renderError(value) {
	return value instanceof Error ? value.message : String(value);
}

//#endregion
//#region src/session-durability.ts
var SessionDurabilityError = class extends Error {
	name = "SessionDurabilityError";
};
/** A false DSH flush means no persistence listener accepted the checkpoint. */
async function flushSessionDurably(ctx, session, label) {
	if (await ctx.sessions.flush(session) === false) throw new SessionDurabilityError(`${label} has no active Session durability backend`);
}

//#endregion
export { stageApprovedCoderActivation as $, roleBindingSchema as $n, recordAttemptStarted as $r, compileCoderImplementationReceipt as $t, compileCommunicationAcl as A, localAttemptRequestPath as An, validateLabId as Ar, freezePreflightVerdict as At, WorktreeError as B, nodeLocalTmuxPlatform as Bn, compileAttemptUncertainReceipt as Br, PacketValidationError as Bt, processStartId as C, AttemptArtifactError as Cn, reviewResultStateSchema as Cr, ROLE_KERNEL_ORDER as Ct, parseDraftLabYaml as D, freezeRetryLocalAttempt as Dn, roleStateSchema as Dr, roleKernelFor as Dt, parseDraftLabConfig as E, freezeInitialLocalAttempt as En, rolePhaseSchema as Er, resolveRootRoleSessionSpec as Et, candidateFrozenReportPath as F, adoptLocalTmuxAttempt as Fn, attemptSchema as Fr, MethodTicketError as Ft, freezeInitialRoleArtifacts as G, generateLabId as Gn, createRetryAttempt as Gr, verbatimBlockSchema as Gt, provisionLaneWorktree as H, ArtifactError as Hn, compileTrialContract as Hr, hashRolePacket as Ht, candidateReceiptPath as I, compileLocalTmuxLaunch as In, attemptStartedReceiptSchema as Ir, freezeMethodDesignTicket as It, applyApprovedCoderGoal as J, readRevisionAtPath as Jn, parseRunSlotState as Jr, CoderReceiptError as Jt, restoreCurrentRoleArtifacts as K, isCommittedManifestHash as Kn, createRunSlotState as Kr, currentFactAnchor as Kt, freezeLaneCandidate as L, createSubprocessLocalTmuxPlatform as Ln, attemptUncertainReceiptSchema as Lr, methodDesignTicketOutputSchema as Lt, CoderSubmissionError as M, readAttemptUncertainReceiptArtifactIfPresent as Mn, TrialContractError as Mr, parsePreflightVerdict as Mt, freezeApprovedCoderSubmission as N, readLocalAttemptIntent as Nn, artifactReferenceSchema$1 as Nr, parsePreflightVerdictArtifact as Nt, resolveDraftLabConfig as O, localAttemptCheckoutPath as On, runtimeStateSchema as Or, rolePromptFor as Ot, CandidateSnapshotError as P, verifyInitialLocalAttempt as Pn, attemptCompletionReceiptSchema as Pr, METHOD_TICKET_HASH_BINDING as Pt, resolveApprovedCoderReview as Q, resolvedManifestSchema as Qn, recordAttemptOutcomeUnknown as Qr, coderImplementationReportSchema as Qt, readCandidateChangedPaths as R, inspectLocalTmuxAttempt as Rn, compileAttemptCompletionReceipt as Rr, methodDesignTicketSchema as Rt, acquireRuntimeLock as S, reconcileLocalTmuxInspection as Sn, reviewResolutionStateSchema as Sr, AutoLabRoleError as St, draftLabConfigSchema as T, freezeAttemptStateArtifact as Tn, roleActivationBlockerSchema as Tr, ROLE_KERNEL_VERSION as Tt, resolveRepositoryRefs as U, ArtifactStore as Un, componentIdentitySchema as Ur, parseRolePacket as Ut, inspectLaneWorktree as V, resolveLocalAttemptWrapperPath as Vn, compileRunSlotContract as Vr, compileRolePacket as Vt, ActivationArtifactError as W, durableWriteFile as Wn, createInitialAttempt as Wr, rolePacketSchema as Wt, freezeApprovedCoderActivation as X, hashResolvedManifest as Xn, receiptReferenceSchema as Xr, coderImplementationReceiptSchema as Xt, compileApprovedCoderActivation as Y, ManifestValidationError as Yn, parseTrialContract as Yr, coderImplementationReceiptOutputSchema as Yt, installApprovedCoderGoal as Z, parseResolvedManifest as Zn, recordAttemptCompletion as Zr, coderImplementationReportOutputSchema as Zt, PostflightResultError as _, provisionDetachedRunCheckout as _n, resolutionHash as _r, observeOpenAgentTurn as _t, resumeRootRoleSession as a, sha256 as ai, readCoderImplementationReport as an, activeCandidateSchema as ar, compileReviewResolution as at, freezePostflightReviewArtifacts as b, AttemptRuntimeConsumer as bn, reviewPauseStateSchema as br, ApprovedCoderArtifactError as bt, RoleAssignmentError as c, readRoleBinding as cn, adoptRuntimeOwner as cr, registerReviewControlHandlers as ct, assertRoleAssignmentReplay as d, prepareRetryLocalAttempt as dn, controllerGoalSchema as dr, reviewRequestPayload as dt, runSlotContractSchema as ei, freezeCoderImplementationReceipt as en, AutoLabStateError as er, REVIEW_ACCEPTED_PAUSE as et, freezeMethodAssignment as f, verifyRetryLocalAttemptReplay as fn, createRuntimeState as fr, sendReviewRequest as ft, freezePreflightReviewArtifacts as g, inspectDetachedRunCheckout as gn, recordReviewResolution as gr, installLocalGoal as gt, PreflightReviewArtifactError as h, RunCheckoutError as hn, parseState as hr, compileLocalGoalIntent as ht, createRootRoleSession as i, canonicalJson$1 as ii, readCoderImplementationReceipt as in, SHA256_PATTERN$17 as ir, compileReviewControlCapability as it, reconcileCommunicationAcl as j, localAttemptRequestSchema as jn, AttemptTransitionError as jr, freezePreflightVerdictArtifact as jt, CommunicationAclError as k, localAttemptDirectory as kn, transitionRuntimeState as kr, PreflightVerdictError as kt, assertMethodAssignmentReplay as l, AttemptLaunchError as ln, autolabDomainSpec as lr, reviewAcceptedPausePayload as lt, freezeRoleAssignmentReceipt as m, freezeTrialArtifacts as mn, labLifecycleSchema as mr, acquireLocalReviewHold as mt, flushSessionDurably as n, trialContractSchema as ni, parseCoderImplementationReceipt as nn, LAB_ID_PATTERN as nr, REVIEW_REQUEST as nt, verifyBorrowedRootRoleSession as o, RoleBindingError as on, activeReviewSchema as or, createReviewControlHandlers as ot, freezeRoleAssignment as p, TrialArtifactError as pn, goalInstallSchema as pr, LocalGoalError as pt, ApprovedCoderActivationError as q, listCommittedManifestHashes as qn, parseAttempt as qr, registerFact as qt, AutoLabRoleSessionError as r, DurableApiRecoveryStore as ri, parseCoderImplementationReport as rn, ReviewResolutionError as rr, ReviewProtocolError as rt, METHOD_SOURCE_PREFLIGHT_VERDICT_ARTIFACT_ID as s, freezeRoleBinding as sn, activeTrialSchema as sr, pauseExpectedReviewGoal as st, SessionDurabilityError as t, runSlotStateSchema as ti, freezeCompiledCoderImplementationReceipt as tn, CONTROL_PAYLOAD_HASH_PATTERN as tr, REVIEW_ACCEPTED_TEXT as tt, assertRoleAssignmentMayDispatch as u, prepareInitialLocalAttempt as un, configRefSchema as ur, reviewJudgeStart as ut, freezePostflightResult as v, runCheckoutReceiptPath as vn, reviewCapabilityStateSchema as vr, pauseLocalGoal as vt, LabConfigError as w, freezeAttemptReceiptArtifact as wn, reviewVerdictStateSchema as wr, ROLE_KERNEL_SECTION as wt, RuntimeLockError as x, LocalAttemptReconcileError as xn, reviewReadyToAdvance as xr, freezeApprovedCoderArtifacts as xt, PostflightArtifactError as y, runCheckoutReceiptSchema as yn, reviewFreezeComplete as yr, pauseLocalGoalContinuation as yt, readCandidateSnapshotReceipt as z, launchLocalTmuxAttempt as zn, compileAttemptStartedReceipt as zr, parseMethodDesignTicket as zt };