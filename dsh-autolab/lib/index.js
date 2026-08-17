import { $ as stageApprovedCoderActivation, Ar as validateLabId, At as freezePreflightVerdict, B as WorktreeError, D as parseDraftLabYaml, Dr as roleStateSchema, Et as resolveRootRoleSessionSpec, G as freezeInitialRoleArtifacts, Gn as generateLabId, H as provisionLaneWorktree, Hn as ArtifactError, It as freezeMethodDesignTicket, J as applyApprovedCoderGoal, Jt as CoderReceiptError, K as restoreCurrentRoleArtifacts, Kt as currentFactAnchor, M as CoderSubmissionError, N as freezeApprovedCoderSubmission, O as resolveDraftLabConfig, Ot as rolePromptFor, P as CandidateSnapshotError, Q as resolveApprovedCoderReview, S as acquireRuntimeLock, U as resolveRepositoryRefs, Un as ArtifactStore, Vn as resolveLocalAttemptWrapperPath, Vt as compileRolePacket, W as ActivationArtifactError, Wn as durableWriteFile, X as freezeApprovedCoderActivation, Y as compileApprovedCoderActivation, Z as installApprovedCoderGoal, Zt as coderImplementationReportOutputSchema, _t as observeOpenAgentTurn, a as resumeRootRoleSession, ai as sha256, at as compileReviewResolution, b as freezePostflightReviewArtifacts, bn as AttemptRuntimeConsumer, cn as readRoleBinding, cr as adoptRuntimeOwner, ct as registerReviewControlHandlers, d as assertRoleAssignmentReplay, dn as prepareRetryLocalAttempt, et as REVIEW_ACCEPTED_PAUSE, f as freezeMethodAssignment, fn as verifyRetryLocalAttemptReplay, fr as createRuntimeState, ft as sendReviewRequest, g as freezePreflightReviewArtifacts, gr as recordReviewResolution, gt as installLocalGoal, ht as compileLocalGoalIntent, i as createRootRoleSession, ii as canonicalJson$1, it as compileReviewControlCapability, j as reconcileCommunicationAcl, k as CommunicationAclError, kr as transitionRuntimeState, l as assertMethodAssignmentReplay, lr as autolabDomainSpec, m as freezeRoleAssignmentReceipt, mt as acquireLocalReviewHold, n as flushSessionDurably, o as verifyBorrowedRootRoleSession, p as freezeRoleAssignment, pt as LocalGoalError, qn as listCommittedManifestHashes, qt as registerFact, ri as DurableApiRecoveryStore, sn as freezeRoleBinding, t as SessionDurabilityError, u as assertRoleAssignmentMayDispatch, un as prepareInitialLocalAttempt, ut as reviewJudgeStart, v as freezePostflightResult, yr as reviewFreezeComplete, yt as pauseLocalGoalContinuation } from "./session-durability-CZKmnHh8.js";
import { r as installSubmissionTools } from "./tool-Ca8RmQww.js";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SessionId } from "@deepseek-ai/dsh-session";
import { GoalId } from "@deepseek-ai/dsh-goal";
import { SessionMessagingError } from "dsh-local-session-messaging";
import { createPokeServer } from "dsh-local-session-messaging/core";
import { HarnessError, MessageId, freezeMessage } from "@deepseek-ai/dsh-llm";
import { Context, Service } from "@deepseek-ai/cordis";
import { dshHomePath, expandHomePath } from "@deepseek-ai/dsh-home-paths";
import s from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

//#region src/api-recovery.ts
const AUTOMATIC_FAILURE_CODES = new Set([
	"EMPTY_RESPONSE",
	"RATE_LIMIT",
	"SERVER",
	"TIMEOUT",
	"TRANSPORT"
]);
/** Codes whose meaning itself proves that an unchanged request has no safe fix. */
const OPERATOR_FAILURE_CODES = new Set([
	"AUTH",
	"FORBIDDEN",
	"INVALID_ARGS",
	"INVALID_CREDENTIAL",
	"INVALID_MODEL_CONTEXT",
	"INVALID_MODEL_INFO",
	"INVALID_MODEL_MAX_TOKENS",
	"INVALID_MODEL_REASONING",
	"INVALID_PREPARED_CALL",
	"INVALID_REQUEST",
	"MISSING_CREDENTIAL",
	"NO_ADAPTER",
	"PERMISSION",
	"PERMISSION_DENIED",
	"QUOTA",
	"CONTEXT_WINDOW_EXCEEDED",
	"UNAUTHORIZED",
	"UNSUPPORTED_REASONING_EFFORT"
]);
/** Route only on the provider-neutral code. HTTP status and message are diagnostic facts. */
function classifyApiFailure(failure) {
	if (failure.code === "ABORTED") return "ignore";
	if (AUTOMATIC_FAILURE_CODES.has(failure.code)) return "automatic";
	return OPERATOR_FAILURE_CODES.has(failure.code) ? "operator" : "unknown";
}
/**
* Event-driven recovery for failures left terminal by DSH's native request
* retry plugin. It never polls, probes a provider, cancels a user turn, creates
* a Goal, or changes a Goal round budget.
*/
var ApiRecoveryRuntime = class {
	timers = /* @__PURE__ */ new Map();
	inFlight = /* @__PURE__ */ new Set();
	/** Narrow in-process bridge when the first durable candidate write is unavailable. */
	pendingAwaiting = /* @__PURE__ */ new Map();
	disposers = [];
	started = false;
	constructor(ctx, options) {
		this.ctx = ctx;
		this.options = options;
		if (!Number.isFinite(options.retryDelayMs) || options.retryDelayMs < 0) throw new TypeError("retryDelayMs must be a finite non-negative number");
	}
	start() {
		if (this.started) return this;
		this.started = true;
		this.disposers.push(this.ctx.on("agent/request-error", async (payload, next) => await this.handleRequestError(payload, next), { prepend: true }));
		this.disposers.push(this.ctx.on("session/event", (session, event) => {
			this.handleSessionEvent(session, event).catch((error) => this.report(error));
		}));
		this.disposers.push(this.ctx.on("agent/status", ({ agent, status }) => {
			if (status !== "idle") return;
			this.handleAgentReady(agent).catch((error) => this.report(error));
		}));
		this.disposers.push(this.ctx.on("agent/created", ({ agent }) => {
			this.handleAgentCreated(agent).catch((error) => this.report(error));
		}));
		this.disposers.push(this.ctx.on("agent/session-start", ({ agent }) => {
			this.handleAgentReady(agent).catch((error) => this.report(error));
		}));
		this.disposers.push(this.ctx.on("llm/adapters-updated", () => {
			this.handleAdaptersUpdated().catch((error) => this.report(error));
		}));
		this.reconcile();
		return this;
	}
	dispose() {
		if (!this.started) return;
		this.started = false;
		for (const dispose of this.disposers.splice(0)) dispose();
		for (const timer of this.timers.values()) this.cancelTimer(timer.cancel);
		this.timers.clear();
	}
	/**
	* Delegate first. A downstream `{ kind: 'retry' }` means DSH still owns the
	* request; only its final `undefined` can become an AutoLab terminal.
	*/
	async handleRequestError(payload, next) {
		const action = await next();
		if (!this.started || action?.kind === "retry") return action;
		if (classifyApiFailure(payload.failure) === "ignore") return action;
		const assignment = this.options.resolveAssignment(payload.agent);
		if (assignment === void 0 || assignment.sessionId !== String(payload.agent.id)) return action;
		const prior = this.currentRecord(String(payload.agent.id));
		const record = Object.freeze({
			phase: "awaiting-terminal",
			...snapshotAssignment(assignment),
			turn: payload.turn,
			step: payload.step,
			provider: payload.provider,
			failure: snapshotFailure(payload.failure),
			recordedAt: this.options.now(),
			unknownFallbackUsed: this.carryUnknownFallback(payload.agent, assignment, prior, payload.failure)
		});
		this.clearTimer(record.sessionId);
		this.pendingAwaiting.set(record.sessionId, record);
		try {
			await this.options.store.put(record);
			if (this.pendingAwaiting.get(record.sessionId) === record) this.pendingAwaiting.delete(record.sessionId);
		} catch (error) {
			this.report(error);
		}
		return action;
	}
	async handleSessionEvent(session, event) {
		if (!this.started) return;
		if (event.type !== "turn/end") return;
		const current = this.currentRecord(String(session.id));
		if (current?.phase === "recovering" && event.data.turn > current.turn) {
			await this.settleRecovering(session, event, current);
			return;
		}
		if (current?.phase !== "awaiting-terminal" || current.turn !== event.data.turn) return;
		await flushSessionDurably(this.ctx, session, "API terminal checkpoint");
		if (!this.started) return;
		if (!sameRecord(this.currentRecord(current.sessionId), current)) return;
		const reason = event.data.reason;
		if (reason.kind !== "error" || !sameFailure(reason.error, current.failure)) {
			await this.removeCurrent(current);
			return;
		}
		const disposition = classifyApiFailure(current.failure);
		if (disposition === "automatic" || disposition === "unknown" && !current.unknownFallbackUsed) {
			const record$1 = Object.freeze({
				...current,
				phase: "scheduled",
				terminalSeq: event.seq,
				dueAt: this.options.now() + retryDelay(current.failure, this.options.retryDelayMs),
				unknownFallbackUsed: false
			});
			await this.options.store.put(record$1);
			this.clearPendingAwaiting(current);
			this.arm(record$1);
			return;
		}
		const record = Object.freeze({
			...current,
			phase: "operator",
			terminalSeq: event.seq
		});
		await this.options.store.put(record);
		this.clearPendingAwaiting(current);
		this.publishOperator(record);
	}
	reconcile() {
		for (const record of this.pendingAwaiting.values()) {
			const agent = this.ctx.agents.get(SessionId(record.sessionId));
			if (agent !== void 0) this.reconcileAwaiting(agent, record).catch((error) => this.report(error));
		}
		for (const record of this.options.store.list()) {
			if (this.pendingAwaiting.has(record.sessionId)) continue;
			if (!sameRecord(this.options.store.get(record.sessionId), record)) continue;
			if (record.phase === "scheduled") {
				this.arm(record);
				continue;
			}
			if (record.phase === "recovering") {
				const agent = this.ctx.agents.get(SessionId(record.sessionId));
				if (agent !== void 0) this.handleAgentReady(agent).catch((error) => this.report(error));
				continue;
			}
			if (record.phase === "awaiting-terminal") {
				const agent = this.ctx.agents.get(SessionId(record.sessionId));
				if (agent !== void 0) this.reconcileAwaiting(agent, record).catch((error) => this.report(error));
			}
		}
	}
	async handleAgentCreated(agent) {
		const pending = this.pendingAwaiting.get(String(agent.id));
		if (pending !== void 0) {
			await this.reconcileAwaiting(agent, pending);
			return;
		}
		const record = this.options.store.get(String(agent.id));
		if (record?.phase === "awaiting-terminal") {
			await this.reconcileAwaiting(agent, record);
			return;
		}
		if (record?.phase === "scheduled") this.arm(record);
		if (record?.phase === "recovering") await this.handleAgentReady(agent);
	}
	/**
	* Adapter topology commits are the exact mechanical edge that can make a
	* credential, route, or provider configuration incident runnable again.
	* Each edge tries the still-current incident once; no endpoint probe or
	* background poll is introduced.
	*/
	async handleAdaptersUpdated() {
		if (!this.started) return;
		await Promise.all([...this.pendingAwaiting.values()].map(async (record) => {
			const agent = this.ctx.agents.get(SessionId(record.sessionId));
			if (agent !== void 0) await this.reconcileAwaiting(agent, record);
		}));
		const pending = this.options.store.list().filter((record) => record.phase === "operator" || record.phase === "awaiting-terminal" || record.phase === "scheduled" || record.phase === "recovering");
		await Promise.all(pending.map(async (record) => {
			if (this.pendingAwaiting.has(record.sessionId)) return;
			if (!sameRecord(this.options.store.get(record.sessionId), record)) return;
			const agent = this.ctx.agents.get(SessionId(record.sessionId));
			if (agent === void 0) return;
			const resume = async () => {
				if (record.phase === "operator") {
					await this.resumeOperatorOnAdapterUpdate(record, agent);
					return;
				}
				await this.handleAgentReady(agent);
			};
			if (agent.status !== "idle") {
				agent.whenIdle().then(resume).catch((error) => this.report(error));
				return;
			}
			await resume();
		}));
	}
	async resumeOperatorOnAdapterUpdate(record, agent) {
		if (!this.started || !sameRecord(this.options.store.get(record.sessionId), record) || this.ctx.agents.get(SessionId(record.sessionId)) !== agent) return;
		if (agent.status !== "idle") return;
		if (!this.assignmentAndContinuationMatch(agent, record, record.continuation)) {
			await this.removeCurrent(record);
			return;
		}
		if (!this.mechanicalContinuationAvailable(agent, record.continuation)) return;
		const scheduled = Object.freeze({
			...baseRecord(record),
			phase: "scheduled",
			terminalSeq: record.terminalSeq,
			dueAt: this.options.now()
		});
		await this.options.store.put(scheduled);
		if (!sameRecord(this.options.store.get(record.sessionId), scheduled)) return;
		await this.resumeScheduled(scheduled, agent);
	}
	async reconcileAwaiting(agent, record) {
		const terminal = agent.session.events.findLast((event) => event.type === "turn/end" && event.data.turn === record.turn);
		if (terminal !== void 0) await this.handleSessionEvent(agent.session, terminal);
	}
	async handleAgentReady(agent) {
		if (!this.started) return;
		const pending = this.pendingAwaiting.get(String(agent.id));
		if (pending !== void 0) {
			await this.reconcileAwaiting(agent, pending);
			return;
		}
		const record = this.options.store.get(String(agent.id));
		if (record?.phase === "awaiting-terminal") {
			await this.reconcileAwaiting(agent, record);
			return;
		}
		if (record?.phase === "recovering") {
			const terminal = agent.session.events.findLast((event) => event.type === "turn/end" && event.data.turn > record.turn);
			if (terminal !== void 0) {
				await this.handleSessionEvent(agent.session, terminal);
				return;
			}
			await this.resumeRecovering(record, agent);
			return;
		}
		if (record?.phase !== "scheduled") return;
		if (this.options.now() < record.dueAt) {
			this.arm(record);
			return;
		}
		await this.resumeScheduled(record, agent);
	}
	arm(record) {
		if (!this.started) return;
		if (!sameRecord(this.options.store.get(record.sessionId), record)) return;
		const existing = this.timers.get(record.sessionId);
		if (existing !== void 0 && sameRecord(existing.record, record)) return;
		if (existing !== void 0) {
			this.timers.delete(record.sessionId);
			this.cancelTimer(existing.cancel);
		}
		try {
			const cancel = this.options.scheduleOnce(() => {
				const armed = this.timers.get(record.sessionId);
				if (armed !== void 0 && sameRecord(armed.record, record)) this.timers.delete(record.sessionId);
				this.resumeScheduled(record).catch((error) => this.report(error));
			}, Math.max(0, record.dueAt - this.options.now()));
			this.timers.set(record.sessionId, {
				record,
				cancel
			});
		} catch (error) {
			this.report(error);
		}
	}
	async resumeScheduled(record, knownAgent) {
		if (!this.started) return;
		if (!sameRecord(this.options.store.get(record.sessionId), record)) return;
		if (this.options.now() < record.dueAt) {
			this.arm(record);
			return;
		}
		if (this.inFlight.has(record.sessionId)) return;
		const agent = knownAgent ?? this.ctx.agents.get(SessionId(record.sessionId));
		if (agent === void 0 || this.ctx.agents.get(SessionId(record.sessionId)) !== agent) return;
		if (agent.status !== "idle") return;
		const applied = this.appliedGoalContinuation(agent, record);
		if (applied !== void 0) {
			await this.resumeExact(record, agent, record.continuation, applied);
			return;
		}
		if (!this.assignmentAndContinuationMatch(agent, record, record.continuation)) {
			await this.removeCurrent(record);
			return;
		}
		await this.resumeExact(record, agent, record.continuation);
	}
	async resumeRecovering(record, agent) {
		if (!this.started || !sameRecord(this.options.store.get(record.sessionId), record) || this.ctx.agents.get(SessionId(record.sessionId)) !== agent || agent.status !== "idle" || this.inFlight.has(record.sessionId)) return;
		if (record.resumedContinuation.kind === "review") {
			if (!this.assignmentAndContinuationMatch(agent, record, record.resumedContinuation)) {
				await this.removeCurrent(record);
				return;
			}
			await this.resumeExact(record, agent, record.resumedContinuation);
			return;
		}
		const resumed = record.resumedContinuation;
		const goal = this.ctx.goals.get(agent);
		if (goal?.id === resumed.goalRef.id && goal.revision === resumed.goalRef.revision && goal.phase === "active" && sha256(goal.objective) === resumed.objectiveHash) {
			if (goal.activation === "armed") return;
			if (!this.assignmentAndContinuationMatch(agent, record, resumed)) {
				await this.removeCurrent(record);
				return;
			}
			await this.resumeExact(record, agent, resumed);
			return;
		}
		const original = record.continuation;
		if (original.kind === "goal" && goal?.id === original.goalRef.id && goal.revision === original.goalRef.revision && goal.phase === "active" && goal.activation === "disarmed" && sha256(goal.objective) === original.objectiveHash && this.assignmentAndContinuationMatch(agent, record, original)) {
			await this.resumeExact(record, agent, original);
			return;
		}
		await this.removeCurrent(record);
	}
	async resumeExact(record, agent, expectedContinuation, appliedGoal) {
		if (!this.started) return;
		if (this.inFlight.has(record.sessionId)) return;
		if (appliedGoal === void 0 && !this.mechanicalContinuationAvailable(agent, expectedContinuation)) {
			await this.promoteOperator(record);
			return;
		}
		this.inFlight.add(record.sessionId);
		let entered = false;
		try {
			const outcome = await agent.runMaintenance(async (signal) => {
				entered = true;
				signal.throwIfAborted();
				if (!this.started) return "stopped";
				if (!sameRecord(this.options.store.get(record.sessionId), record) || this.ctx.agents.get(SessionId(record.sessionId)) !== agent || !(appliedGoal === void 0 ? this.assignmentAndContinuationMatch(agent, record, expectedContinuation) : this.assignmentAndAppliedGoalMatch(agent, record, appliedGoal))) return "stale";
				const resumed = appliedGoal ?? await this.applyContinuation(agent, record, expectedContinuation, signal);
				if (!this.started) return "stopped";
				if (resumed === void 0) return "stale";
				const recovering = Object.freeze({
					...baseRecord(record),
					phase: "recovering",
					terminalSeq: record.terminalSeq,
					resumedContinuation: resumed,
					resumedAt: this.options.now(),
					unknownFallbackUsed: record.unknownFallbackUsed || classifyApiFailure(record.failure) === "unknown"
				});
				await this.options.store.put(recovering);
				if (!this.started) return "stopped";
				await flushSessionDurably(this.ctx, agent.session, "API recovery continuation");
				return "resumed";
			});
			if (!this.started) return;
			if (outcome === "stale") await this.removeCurrent(record);
		} catch (error) {
			if (!this.started) return;
			if (entered) {
				this.report(error);
				return;
			}
			agent.whenIdle().then(() => this.handleAgentReady(agent)).catch((waitError) => this.report(waitError));
		} finally {
			this.inFlight.delete(record.sessionId);
		}
	}
	async applyContinuation(agent, record, continuation, signal) {
		if (continuation.kind === "goal") {
			const resumed = this.ctx.goals.resume(agent, continuation.goalRef);
			return Object.freeze({
				kind: "goal",
				goalRef: Object.freeze({
					id: resumed.id,
					revision: resumed.revision
				}),
				objectiveHash: sha256(resumed.objective)
			});
		}
		const resume = this.options.resumeReviewOnce;
		if (resume === void 0) return void 0;
		return await resume(agent, reviewWake(record, continuation), signal) === "stale" ? void 0 : snapshotContinuation(continuation);
	}
	assignmentAndContinuationMatch(agent, record, expectedContinuation) {
		const assignment = this.options.resolveAssignment(agent);
		if (assignment === void 0 || !sameAssignment(assignment, record, expectedContinuation)) return false;
		if (expectedContinuation.kind === "review") return true;
		return exactDisarmedGoal(this.ctx.goals.get(agent), expectedContinuation);
	}
	assignmentAndAppliedGoalMatch(agent, record, resumed) {
		const assignment = this.options.resolveAssignment(agent);
		if (assignment === void 0 || !sameAssignmentIdentity(assignment, record)) return false;
		if (!sameContinuation(assignment.continuation, record.continuation) && !sameContinuation(assignment.continuation, resumed)) return false;
		return exactArmedGoal(this.ctx.goals.get(agent), resumed);
	}
	/** Recover the narrow Goal-applied/store-not-yet-committed crash window. */
	appliedGoalContinuation(agent, record) {
		if (record.continuation.kind !== "goal") return void 0;
		const goal = this.ctx.goals.get(agent);
		if (goal === void 0 || goal.id !== record.continuation.goalRef.id || goal.revision !== record.continuation.goalRef.revision + 1 || goal.phase !== "active" || goal.activation !== "armed" || sha256(goal.objective) !== record.continuation.objectiveHash) return void 0;
		const resumed = Object.freeze({
			kind: "goal",
			goalRef: Object.freeze({
				id: goal.id,
				revision: goal.revision
			}),
			objectiveHash: sha256(goal.objective)
		});
		return this.assignmentAndAppliedGoalMatch(agent, record, resumed) ? resumed : void 0;
	}
	mechanicalContinuationAvailable(agent, continuation) {
		if (continuation.kind === "review") return this.options.resumeReviewOnce !== void 0;
		const goal = this.ctx.goals.get(agent);
		return goal !== void 0 && goal.roundsStarted < goal.maxGoalRounds;
	}
	carryUnknownFallback(agent, assignment, prior, failure) {
		if (classifyApiFailure(failure) !== "unknown" || prior?.phase !== "recovering" || !prior.unknownFallbackUsed || prior.failure.code !== failure.code || !sameAssignmentIdentity(assignment, prior) || !sameContinuation(assignment.continuation, prior.continuation) && !sameContinuation(assignment.continuation, prior.resumedContinuation)) return false;
		const resumed = prior.resumedContinuation;
		if (resumed.kind === "review") return true;
		const goal = this.ctx.goals.get(agent);
		return goal !== void 0 && goal.id === resumed.goalRef.id && goal.revision === resumed.goalRef.revision && goal.phase === "active" && sha256(goal.objective) === resumed.objectiveHash;
	}
	currentRecord(sessionId) {
		return this.pendingAwaiting.get(sessionId) ?? this.options.store.get(sessionId);
	}
	clearPendingAwaiting(expected) {
		const pending = this.pendingAwaiting.get(expected.sessionId);
		if (pending !== void 0 && sameRecord(pending, expected)) this.pendingAwaiting.delete(expected.sessionId);
	}
	async removeCurrent(record) {
		const pending = this.pendingAwaiting.get(record.sessionId);
		if (pending !== void 0 && sameRecord(pending, record)) {
			this.pendingAwaiting.delete(record.sessionId);
			if (sameRecord(this.options.store.get(record.sessionId), record)) await this.options.store.remove(record);
			this.clearTimer(record.sessionId);
			return;
		}
		if (!await this.options.store.remove(record)) return;
		this.clearTimer(record.sessionId);
	}
	async promoteOperator(expected) {
		const current = this.options.store.get(expected.sessionId);
		if (current === void 0 || !sameRecord(current, expected) && !sameRecoveryChain(current, expected)) return;
		const record = Object.freeze({
			...current,
			phase: "operator",
			terminalSeq: expected.terminalSeq,
			recordedAt: this.options.now()
		});
		await this.options.store.put(record);
		this.publishOperator(record);
	}
	clearTimer(sessionId) {
		const timer = this.timers.get(sessionId);
		if (timer === void 0) return;
		this.timers.delete(sessionId);
		this.cancelTimer(timer.cancel);
	}
	cancelTimer(cancel) {
		try {
			cancel();
		} catch (error) {
			this.report(error);
		}
	}
	publishOperator(record) {
		if (!this.started || this.options.onOperatorIncident === void 0) return;
		Promise.resolve(this.options.onOperatorIncident(record)).catch((error) => this.report(error));
	}
	async settleRecovering(session, event, current) {
		await flushSessionDurably(this.ctx, session, "API recovery settlement");
		if (!this.started) return;
		if (!sameRecord(this.options.store.get(current.sessionId), current)) return;
		if (event.data.reason.kind === "error") {
			const disposition = classifyApiFailure(event.data.reason.error);
			if (disposition === "ignore") {
				await this.removeCurrent(current);
				return;
			}
			const agent = this.ctx.agents.get(SessionId(current.sessionId));
			const assignment = agent === void 0 ? void 0 : this.options.resolveAssignment(agent);
			if (assignment === void 0 || !sameAssignmentIdentity(assignment, current)) {
				await this.removeCurrent(current);
				return;
			}
			const sameUnknownFallback = disposition === "unknown" && current.unknownFallbackUsed && current.failure.code === event.data.reason.error.code;
			if (disposition === "automatic" || disposition === "unknown" && !sameUnknownFallback) {
				const failure = snapshotFailure(event.data.reason.error);
				const record$1 = Object.freeze({
					...snapshotAssignment(assignment),
					phase: "scheduled",
					turn: event.data.turn,
					step: current.step,
					provider: current.provider,
					failure,
					recordedAt: this.options.now(),
					unknownFallbackUsed: false,
					terminalSeq: event.seq,
					dueAt: this.options.now() + retryDelay(failure, this.options.retryDelayMs)
				});
				await this.options.store.put(record$1);
				this.arm(record$1);
				return;
			}
			const record = Object.freeze({
				...snapshotAssignment(assignment),
				phase: "operator",
				turn: event.data.turn,
				step: current.step,
				provider: current.provider,
				failure: snapshotFailure(event.data.reason.error),
				terminalSeq: event.seq,
				recordedAt: this.options.now(),
				unknownFallbackUsed: sameUnknownFallback
			});
			await this.options.store.put(record);
			this.publishOperator(record);
			return;
		}
		await this.removeCurrent(current);
	}
	report(error) {
		this.options.onError?.(error);
	}
};
function installApiRecovery(ctx, options) {
	return new ApiRecoveryRuntime(ctx, options).start();
}
function snapshotAssignment(assignment) {
	return Object.freeze({
		...assignment,
		continuation: snapshotContinuation(assignment.continuation)
	});
}
function snapshotContinuation(continuation) {
	return continuation.kind === "goal" ? Object.freeze({
		kind: "goal",
		goalRef: Object.freeze({ ...continuation.goalRef }),
		objectiveHash: continuation.objectiveHash
	}) : Object.freeze({ ...continuation });
}
function snapshotFailure(failure) {
	return Object.freeze({ ...failure });
}
function retryDelay(failure, fallback) {
	return failure.providerRetryAfterMs !== void 0 && Number.isFinite(failure.providerRetryAfterMs) && failure.providerRetryAfterMs > 0 ? failure.providerRetryAfterMs : fallback;
}
function exactDisarmedGoal(goal, continuation) {
	return goal !== void 0 && goal.id === continuation.goalRef.id && goal.revision === continuation.goalRef.revision && goal.phase === "active" && goal.activation === "disarmed" && sha256(goal.objective) === continuation.objectiveHash;
}
function exactArmedGoal(goal, continuation) {
	return goal !== void 0 && goal.id === continuation.goalRef.id && goal.revision === continuation.goalRef.revision && goal.phase === "active" && goal.activation === "armed" && sha256(goal.objective) === continuation.objectiveHash;
}
function sameAssignmentIdentity(assignment, record) {
	return assignment.labId === record.labId && assignment.roleId === record.roleId && assignment.sessionId === record.sessionId && assignment.assignmentId === record.assignmentId && assignment.packetHash === record.packetHash;
}
function sameAssignment(assignment, record, expectedContinuation) {
	return sameAssignmentIdentity(assignment, record) && sameContinuation(assignment.continuation, expectedContinuation);
}
function sameFailure(left, right) {
	return left.message === right.message && left.code === right.code && left.status === right.status && left.providerRetryAfterMs === right.providerRetryAfterMs && left.requestId === right.requestId;
}
function sameRecoveryChain(left, right) {
	return left.phase === "recovering" && left.labId === right.labId && left.roleId === right.roleId && left.sessionId === right.sessionId && left.assignmentId === right.assignmentId && left.packetHash === right.packetHash && sameContinuation(left.continuation, right.continuation) && left.turn === right.turn && left.step === right.step && left.provider === right.provider && left.recordedAt === right.recordedAt && left.unknownFallbackUsed === right.unknownFallbackUsed && sameFailure(left.failure, right.failure);
}
function sameRecord(left, right) {
	if (left === void 0 || left.phase !== right.phase || left.labId !== right.labId || left.roleId !== right.roleId || left.sessionId !== right.sessionId || left.assignmentId !== right.assignmentId || left.packetHash !== right.packetHash || !sameContinuation(left.continuation, right.continuation) || left.turn !== right.turn || left.step !== right.step || left.provider !== right.provider || left.recordedAt !== right.recordedAt || left.unknownFallbackUsed !== right.unknownFallbackUsed || !sameFailure(left.failure, right.failure)) return false;
	if (left.phase === "awaiting-terminal" || right.phase === "awaiting-terminal") return left.phase === right.phase;
	if (left.terminalSeq !== right.terminalSeq) return false;
	if (left.phase === "operator" || right.phase === "operator") return left.phase === right.phase;
	if (left.phase === "scheduled" || right.phase === "scheduled") return left.phase === "scheduled" && right.phase === "scheduled" && left.dueAt === right.dueAt;
	return sameContinuation(left.resumedContinuation, right.resumedContinuation) && left.resumedAt === right.resumedAt;
}
function sameContinuation(left, right) {
	if (left.kind !== right.kind) return false;
	if (left.kind === "goal") return right.kind === "goal" && left.goalRef.id === right.goalRef.id && left.goalRef.revision === right.goalRef.revision && left.objectiveHash === right.objectiveHash;
	return right.kind === "review" && left.reviewId === right.reviewId && left.reviewAnchorHash === right.reviewAnchorHash;
}
function reviewWake(record, continuation) {
	return Object.freeze({
		wakeId: `${continuation.reviewId}:api-recovery:${record.terminalSeq}`,
		reviewId: continuation.reviewId,
		reviewAnchorHash: continuation.reviewAnchorHash,
		labId: record.labId,
		roleId: record.roleId,
		sessionId: record.sessionId,
		assignmentId: record.assignmentId,
		packetHash: record.packetHash,
		terminalSeq: record.terminalSeq
	});
}
function baseRecord(record) {
	return {
		labId: record.labId,
		roleId: record.roleId,
		sessionId: record.sessionId,
		assignmentId: record.assignmentId,
		packetHash: record.packetHash,
		continuation: snapshotContinuation(record.continuation),
		turn: record.turn,
		step: record.step,
		provider: record.provider,
		failure: snapshotFailure(record.failure),
		recordedAt: record.recordedAt,
		unknownFallbackUsed: record.unknownFallbackUsed
	};
}

//#endregion
//#region src/dialogue.ts
const ZERO_HASH = "0".repeat(64);
const RECORD_DOMAIN = "autolab-config-record-v1";
var DialogueError = class extends Error {
	name = "DialogueError";
	constructor(message, code) {
		super(message);
		this.code = code;
	}
};
/**
* Append-only configuration transcript.
*
* This is deliberately not a live listener. The Controller snapshots exact
* durable Session events at explicit configuration boundaries, keeping the
* normal research path free of another recorder or daemon.
*/
var DialogueLog = class {
	constructor(labsRoot) {
		this.labsRoot = labsRoot;
	}
	path(labId) {
		return join(this.labsRoot, validateLabId(labId), "dialogue", "creation.jsonl");
	}
	async initialize(input) {
		const payload = {
			controllerSessionId: input.controllerSessionId,
			...input.sourceDirectory === void 0 ? {} : { sourceDirectory: input.sourceDirectory }
		};
		const first = makeRecord({
			labId: input.labId,
			sequence: 1,
			timestamp: input.timestamp,
			recordKind: "begin_create",
			source: {
				kind: "controller",
				controllerSessionId: input.controllerSessionId
			},
			payload,
			prevHash: ZERO_HASH
		});
		await durableWriteFile(this.path(input.labId), `${JSON.stringify(first)}\n`, false);
		return {
			sequence: 1,
			recordHash: first.recordHash
		};
	}
	async appendSessionEvents(input) {
		const records = await this.read(input.labId);
		assertControllerSession(records, input.controllerSessionId);
		const current = headOf(records);
		const lowerBound = Math.max(input.fromSeq ?? 0, current.lastSessionEventSeq === void 0 ? 0 : current.lastSessionEventSeq + 1);
		const selected = input.events.filter((event) => event.seq >= lowerBound).filter(isConfigurationEvent);
		if (selected.length === 0) return current;
		const additions = [];
		let sequence = current.sequence;
		let prevHash = current.recordHash;
		for (const event of selected) {
			sequence += 1;
			const record = makeRecord({
				labId: input.labId,
				sequence,
				timestamp: event.time,
				recordKind: classifyEvent(event),
				source: {
					kind: "dsh_session_event",
					sessionId: input.controllerSessionId,
					eventSeq: event.seq,
					eventType: event.type
				},
				payload: event,
				prevHash
			});
			additions.push(record);
			prevHash = record.recordHash;
		}
		await appendLines(this.path(input.labId), additions);
		return headOf([...records, ...additions]);
	}
	async appendControllerRecord(input) {
		const records = await this.read(input.labId);
		assertControllerSession(records, input.controllerSessionId);
		const current = headOf(records);
		const record = makeRecord({
			labId: input.labId,
			sequence: current.sequence + 1,
			timestamp: input.timestamp,
			recordKind: input.recordKind,
			source: {
				kind: "controller",
				controllerSessionId: input.controllerSessionId
			},
			payload: input.payload,
			...input.relatedRevision === void 0 ? {} : { relatedRevision: input.relatedRevision },
			prevHash: current.recordHash
		});
		await appendLines(this.path(input.labId), [record]);
		return headOf([...records, record]);
	}
	async head(labId) {
		return headOf(await this.read(labId));
	}
	async read(labId) {
		let text;
		try {
			text = await readFile(this.path(labId), "utf8");
		} catch (error) {
			throw new DialogueError(`cannot read dialogue log: ${error instanceof Error ? error.message : String(error)}`, "DIALOGUE_MISSING");
		}
		if (!text.endsWith("\n")) throw new DialogueError("dialogue log has an incomplete trailing record", "DIALOGUE_CORRUPT");
		const records = [];
		for (const line of text.split("\n")) {
			if (line.length === 0) continue;
			let value;
			try {
				value = JSON.parse(line);
			} catch {
				throw new DialogueError("dialogue log contains malformed JSON", "DIALOGUE_CORRUPT");
			}
			const record = parseRecord(value);
			const previous = records.at(-1);
			const expectedSequence = (previous?.sequence ?? 0) + 1;
			const expectedPrevHash = previous?.recordHash ?? ZERO_HASH;
			if (record.labId !== labId || record.sequence !== expectedSequence || record.prevHash !== expectedPrevHash || computeRecordHash(record) !== record.recordHash) throw new DialogueError("dialogue hash chain is invalid", "DIALOGUE_CORRUPT");
			records.push(record);
		}
		if (records.length === 0) throw new DialogueError("dialogue log is empty", "DIALOGUE_CORRUPT");
		return records;
	}
};
function makeRecord(input) {
	const withoutHash = {
		recordVersion: 1,
		...input,
		contentSha256: sha256(canonicalJson$1(input.payload))
	};
	return {
		...withoutHash,
		recordHash: hashRecordWithoutHash(withoutHash)
	};
}
function computeRecordHash(record) {
	const { recordHash: _recordHash,...withoutHash } = record;
	if (sha256(canonicalJson$1(record.payload)) !== record.contentSha256) return "";
	return hashRecordWithoutHash(withoutHash);
}
function hashRecordWithoutHash(value) {
	return sha256(`${RECORD_DOMAIN}\0${value.prevHash}\0${canonicalJson$1(value)}`);
}
function parseRecord(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new DialogueError("dialogue record must be an object", "DIALOGUE_CORRUPT");
	const record = value;
	if (record.recordVersion !== 1 || typeof record.labId !== "string" || !Number.isSafeInteger(record.sequence) || record.sequence <= 0 || !Number.isSafeInteger(record.timestamp) || record.timestamp < 0 || typeof record.recordKind !== "string" || !isRecordKind(record.recordKind) || typeof record.source !== "object" || record.source === null || !("payload" in record) || typeof record.contentSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(record.contentSha256) || typeof record.prevHash !== "string" || !/^[0-9a-f]{64}$/u.test(record.prevHash) || typeof record.recordHash !== "string" || !/^[0-9a-f]{64}$/u.test(record.recordHash) || record.relatedRevision !== void 0 && (!Number.isSafeInteger(record.relatedRevision) || record.relatedRevision <= 0)) throw new DialogueError("dialogue record schema is invalid", "DIALOGUE_CORRUPT");
	const source = record.source;
	if (!(source.kind === "controller" ? typeof source.controllerSessionId === "string" : source.kind === "dsh_session_event" && typeof source.sessionId === "string" && Number.isSafeInteger(source.eventSeq) && source.eventSeq >= 0 && typeof source.eventType === "string")) throw new DialogueError("dialogue record source is invalid", "DIALOGUE_CORRUPT");
	return value;
}
function isRecordKind(value) {
	return value === "begin_create" || value === "user_message" || value === "controller_message" || value === "command" || value === "discovery" || value === "configure_action" || value === "acceptance" || value === "rejection";
}
function isConfigurationEvent(event) {
	return event.type === "user/message" || event.type === "assistant/message" || event.type === "command/run" || event.type === "command/done" || event.type === "tool/call" || event.type === "tool/result";
}
function classifyEvent(event) {
	if (event.type === "user/message") return "user_message";
	if (event.type === "assistant/message") return "controller_message";
	if (event.type === "command/run") return "command";
	if (event.type === "tool/call" || event.type === "tool/result") return "discovery";
	return "configure_action";
}
function assertControllerSession(records, controllerSessionId) {
	const first = records[0];
	if (first?.source.kind !== "controller" || first.source.controllerSessionId !== controllerSessionId) throw new DialogueError("dialogue belongs to another Controller Session", "CONTROLLER_MISMATCH");
}
function headOf(records) {
	const last = records.at(-1);
	if (last === void 0) throw new DialogueError("dialogue log is empty", "DIALOGUE_CORRUPT");
	let lastSessionEventSeq;
	for (let index = records.length - 1; index >= 0; index -= 1) {
		const source = records[index].source;
		if (source.kind === "dsh_session_event") {
			lastSessionEventSeq = source.eventSeq;
			break;
		}
	}
	return {
		sequence: last.sequence,
		recordHash: last.recordHash,
		...lastSessionEventSeq === void 0 ? {} : { lastSessionEventSeq }
	};
}
async function appendLines(path, records) {
	if (records.length === 0) return;
	const handle = await open(path, "a", 384);
	try {
		await handle.writeFile(records.map((record) => `${JSON.stringify(record)}\n`).join(""), "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
}

//#endregion
//#region src/controller-goal.ts
/**
* Compile one short native Goal from authoritative paths plus the small current
* projection. Original Lab text stays in its revision and must be read there;
* it is never summarized into another source of truth.
*/
function compileControllerGoalIntent(state, frozen) {
	const controller = frozen.manifest.roles.find((role) => role.role_kind === "controller");
	if (controller === void 0 || controller.prebound_session_id !== state.controllerSessionId || controller.prompt_sha256 !== rolePromptFor("controller").sha256) throw new Error(`AutoLab ${state.labId} Controller binding does not match CURRENT`);
	const revision = frozen.ref.revision;
	const assignmentId = `${state.labId}:controller:revision:${revision}`;
	const installId = `${assignmentId}:goal`;
	const progress = controllerProgress(state);
	const objective = [
		`AutoLab-Controller-Install-ID: ${JSON.stringify(installId)}`,
		`AutoLab-ID: ${JSON.stringify(state.labId)}`,
		`Controller-Session-ID: ${JSON.stringify(state.controllerSessionId)}`,
		`Controller-Assignment-ID: ${JSON.stringify(assignmentId)}`,
		"",
		"Authoritative Lab anchors (read the complete files; summaries and chat memory are not authority):",
		`- creation dialogue: ${frozen.manifest.authority_paths.creation_log}`,
		`- CURRENT: ${join(frozen.manifest.authority_paths.lab_dir, "CURRENT")}`,
		`- LAB_SPEC.md: ${frozen.manifest.authority_paths.lab_spec} (sha256 ${frozen.ref.specHash})`,
		`- lab.yaml: ${frozen.manifest.authority_paths.lab_yaml} (sha256 ${frozen.ref.configHash})`,
		`- RESOLVED_MANIFEST.json: ${frozen.manifest.authority_paths.resolved_manifest} (sha256 ${frozen.ref.manifestHash})`,
		"",
		"Before making an explicitly delegated choice or dispatching work, read the complete relevant originals and call AutoLabStatus for the live projection. Coordinate Method, Coder, Preflight Judge, Postflight Judge, Ops, and optional Coordinator without taking over their independent judgments.",
		"Runtime handles deterministic API, Session, process, SSH, hardware, and environment recovery. Do not poll or invoke an LLM for a repair Runtime can complete. Act only on an unresolved incident or on research work that requires understanding or choice.",
		"When no authorized action or decision is ready, call AutoLabWait once; Runtime will resume this same Goal from the exact durable event.",
		"",
		`Progress at Goal compilation: ${canonicalJson$1(progress)}`
	].join("\n");
	return Object.freeze({
		roleId: controller.role_id,
		installId,
		assignmentId,
		packetHash: frozen.ref.manifestHash,
		objective,
		objectiveHash: sha256(objective),
		maxGoalRounds: controller.max_goal_rounds
	});
}
function controllerProgress(state) {
	const roles = Object.fromEntries(Object.entries(state.roles).sort(([left], [right]) => left.localeCompare(right)).map(([roleId, role]) => [roleId, {
		phase: role.phase,
		...role.goalInstall === void 0 ? {} : { assignment_id: role.goalInstall.assignmentId },
		...role.activationBlocker === void 0 ? {} : { activation_blocker: role.activationBlocker.code }
	}]));
	const reviews = Object.fromEntries(Object.entries(state.reviews).sort(([left], [right]) => left.localeCompare(right)).map(([reviewId, review]) => [reviewId, {
		stage: review.stage,
		phase: review.phase,
		worker_role_id: review.capability.workerRoleId,
		judge_role_id: review.capability.judgeRoleId,
		...review.verdict === void 0 ? {} : { verdict: review.verdict.topLevelVerdict },
		...review.result === void 0 ? {} : { result_sha256: review.result.hash }
	}]));
	const candidates = Object.fromEntries(Object.entries(state.candidates).sort(([left], [right]) => left.localeCompare(right)).map(([laneId, candidate]) => [laneId, candidate.candidateId]));
	const trials = Object.fromEntries(Object.entries(state.trials).sort(([left], [right]) => left.localeCompare(right)).map(([trialId, trial]) => [trialId, Object.fromEntries(Object.entries(trial.runSlots).sort(([left], [right]) => left.localeCompare(right)).map(([runSlotId, slot]) => [runSlotId, slot.state.status]))]));
	return {
		runtime_revision: state.runtimeRevision,
		lifecycle: state.lifecycle,
		roles,
		reviews,
		candidates,
		trials,
		...state.blocker === void 0 ? {} : { blocker: state.blocker }
	};
}

//#endregion
//#region src/controller-surface.ts
const CONTROLLER_KERNEL_SECTION = "autolab:controller-kernel";
const CONTROLLER_KERNEL_ORDER = 20;
const labIdParameter = { labId: {
	type: "string",
	required: true,
	description: "Exact AutoLab lab_id owned by this Controller Session."
} };
const actionOutput = {
	schema: {
		type: "object",
		additionalProperties: false,
		properties: {
			labId: {
				type: "string",
				required: true
			},
			lifecycle: {
				type: "string",
				required: true
			},
			runtimeRevision: {
				type: "number",
				required: true
			}
		}
	},
	render: (_args, value) => [{
		type: "text",
		text: `AutoLab ${value.labId}: ${value.lifecycle} at RuntimeState ${value.runtimeRevision}`
	}]
};
/**
* Add only the Controller-specific surface to the user's existing Agent scope.
* No global restriction, replacement Agent, loop, or background monitor exists.
*/
function installControllerSurface(agent, runtime, kernelText) {
	const disposers = [];
	try {
		disposers.push(agent.ctx.systemPrompt.section({
			name: CONTROLLER_KERNEL_SECTION,
			order: CONTROLLER_KERNEL_ORDER,
			text: kernelText
		}));
		disposers.push(agent.ctx.tools.register(defineTool({
			name: "AutoLabRead",
			description: "Read the complete authoritative LAB_SPEC.md and lab.yaml for one AutoLab. This returns original bytes as text; it never substitutes a summary.",
			parameters: labIdParameter,
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						labId: {
							type: "string",
							required: true
						},
						lifecycle: {
							type: "string",
							required: true
						},
						directory: {
							type: "string",
							required: true
						},
						revision: {
							type: "string",
							required: true
						},
						labSpec: {
							type: "string",
							required: true
						},
						labYaml: {
							type: "string",
							required: true
						}
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: [
						`AutoLab ${value.labId} (${value.lifecycle}, revision ${value.revision})`,
						`Lab directory: ${value.directory}`,
						"----- BEGIN LAB_SPEC.md (verbatim) -----",
						value.labSpec,
						"----- END LAB_SPEC.md -----",
						"----- BEGIN lab.yaml (verbatim) -----",
						value.labYaml,
						"----- END lab.yaml -----"
					].join("\n")
				}]
			},
			async execute(args, exec) {
				requireInstalledCaller(agent, exec.agent, "AutoLabRead");
				return await runtime.readForController(agent, args.labId, exec.signal);
			}
		})));
		disposers.push(agent.ctx.tools.register(defineTool({
			name: "AutoLabStatus",
			description: "Read the small materialized RuntimeState for one AutoLab without scanning logs, checkpoints, metrics, or experiment directories.",
			parameters: labIdParameter,
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						labId: {
							type: "string",
							required: true
						},
						stateJson: {
							type: "string",
							required: true
						}
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: value.stateJson
				}]
			},
			async execute(args, exec) {
				requireInstalledCaller(agent, exec.agent, "AutoLabStatus");
				const state = runtime.status(agent, args.labId);
				return {
					labId: state.labId,
					stateJson: JSON.stringify(state, null, 2)
				};
			}
		})));
		for (const definition of [
			controllerActionTool(agent, "AutoLabStart", "Start an AutoLab from its committed CURRENT revision.", (labId, signal) => runtime.start(agent, labId, signal)),
			controllerActionTool(agent, "AutoLabPause", "Pause automatic work in an AutoLab without deleting its Sessions, Goals, originals, or history.", (labId, signal) => runtime.pause(agent, labId, signal)),
			controllerActionTool(agent, "AutoLabResume", "Resume the same AutoLab Sessions and native Goals from their durable state.", (labId, signal) => runtime.resume(agent, labId, signal)),
			controllerActionTool(agent, "AutoLabStop", "Stop an AutoLab only after its native Goals are durably paused; preserve all originals and history.", (labId, signal) => runtime.stop(agent, labId, signal))
		]) disposers.push(agent.ctx.tools.register(definition));
		disposers.push(agent.ctx.tools.register(defineTool({
			name: "AutoLabReveal",
			description: "Explicitly reveal a sealed AutoLab cohort and reconcile its configured communication ACL. This is one-way for the current revision and performs no comparison or promotion.",
			parameters: labIdParameter,
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						labId: {
							type: "string",
							required: true
						},
						revealState: {
							type: "string",
							required: true,
							const: "revealed"
						},
						runtimeRevision: {
							type: "number",
							required: true
						}
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: `AutoLab ${value.labId}: revealed at RuntimeState ${value.runtimeRevision}`
				}]
			},
			async execute(args, exec) {
				requireInstalledCaller(agent, exec.agent, "AutoLabReveal");
				return await runtime.reveal(agent, args.labId, exec.signal);
			}
		})));
		disposers.push(agent.ctx.tools.register(defineTool({
			name: "AutoLabApplyPreflight",
			description: "Apply one explicitly selected APPROVED Preflight verdict by installing its exact Coder Assignment and native Goal. Runtime performs no comparison or scientific route selection.",
			parameters: {
				...labIdParameter,
				reviewId: {
					type: "string",
					required: true
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						labId: {
							type: "string",
							required: true
						},
						reviewId: {
							type: "string",
							required: true
						},
						coderRoleId: {
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
							const: "coder_working"
						}
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: `AutoLab ${value.labId} review ${value.reviewId}: ${value.coderRoleId} is working on ${value.assignmentId}`
				}]
			},
			async execute(args, exec) {
				requireInstalledCaller(agent, exec.agent, "AutoLabApplyPreflight");
				return await runtime.applyPreflight(agent, args, exec.signal);
			}
		})));
		disposers.push(agent.ctx.tools.register(defineTool({
			name: "AutoLabAssignMethod",
			description: "Install one explicit Controller-authored Method Assignment on its existing Method Session. Supply sourceReviewId only to resolve that exact REVISION_REQUIRED or REJECTED Preflight review; Runtime binds the frozen verdict automatically. Omit it to start the next Method Assignment from a paused Method. Runtime performs no scientific route selection.",
			parameters: {
				...labIdParameter,
				methodRoleId: {
					type: "string",
					required: true
				},
				assignmentId: {
					type: "string",
					required: true
				},
				objective: {
					type: "string",
					required: true
				},
				contentJson: {
					type: "string",
					required: true
				},
				inputArtifactRefsJson: {
					type: "string",
					required: true,
					description: "JSON array of {artifact_id, path, sha256}; Runtime does not open referenced targets."
				},
				sourceReviewId: {
					type: "string",
					description: "Exact REVISION_REQUIRED or REJECTED Preflight review to resolve. Omit for a paused Method next Assignment."
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						labId: {
							type: "string",
							required: true
						},
						methodRoleId: {
							type: "string",
							required: true
						},
						assignmentId: {
							type: "string",
							required: true
						},
						sourceReviewId: { type: "string" },
						phase: {
							type: "string",
							required: true,
							const: "working"
						}
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: `AutoLab ${value.labId} ${value.methodRoleId} Method Assignment ${value.assignmentId}: ${value.phase}${value.sourceReviewId === void 0 ? "" : ` (resolved ${value.sourceReviewId})`}`
				}]
			},
			async execute(args, exec) {
				requireInstalledCaller(agent, exec.agent, "AutoLabAssignMethod");
				return await runtime.assignMethod(agent, args, exec.signal);
			}
		})));
		disposers.push(agent.ctx.tools.register(defineTool({
			name: "AutoLabAssignCoderFix",
			description: "Install one explicit Controller-authored implementation-fix Assignment on a paused Coder that owns its Lane active candidate. The fix inherits the candidate lineage APPROVED Preflight review (design ticket + verdict) as provenance, supersedes the active candidate, and lets the Coder freeze a corrected candidate through the ordinary SubmitCoderImplementation path. No Preflight review is fabricated and no scientific route is selected. assignmentId must be coder:<reviewId>:fix:<slug> and contentJson must carry a non-empty candidate_id.",
			parameters: {
				...labIdParameter,
				coderRoleId: {
					type: "string",
					required: true
				},
				assignmentId: {
					type: "string",
					required: true
				},
				objective: {
					type: "string",
					required: true
				},
				contentJson: {
					type: "string",
					required: true,
					description: "Opaque fix mandate JSON; must carry a non-empty candidate_id string."
				},
				inputArtifactRefsJson: {
					type: "string",
					required: true,
					description: "JSON array of {artifact_id, path, sha256}; Runtime does not open referenced targets."
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						labId: {
							type: "string",
							required: true
						},
						coderRoleId: {
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
						},
						phase: {
							type: "string",
							required: true,
							const: "working"
						}
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: `AutoLab ${value.labId} ${value.coderRoleId} Coder fix Assignment ${value.assignmentId}: ${value.phase} (lineage ${value.reviewId})`
				}]
			},
			async execute(args, exec) {
				requireInstalledCaller(agent, exec.agent, "AutoLabAssignCoderFix");
				return await runtime.assignCoderFix(agent, args, exec.signal);
			}
		})));
		disposers.push(agent.ctx.tools.register(defineTool({
			name: "AutoLabRegisterUserDirective",
			description: "Register one explicit user decision as an immutable, additive fact in the Lab fact set (facts.json). Facts carry verbatim statement, source, and evidence status, and every packet compiled afterwards anchors the updated fact set, making the decision visible to Judges in the anchored record chain. Runtime performs no scientific interpretation of the directive.",
			parameters: {
				...labIdParameter,
				factId: {
					type: "string",
					required: true
				},
				kind: {
					type: "string",
					required: true,
					description: "Fact kind, e.g. \"user_directive\"."
				},
				statement: {
					type: "string",
					required: true,
					description: "The directive text being registered; keep the user wording verbatim."
				},
				source: {
					type: "string",
					required: true,
					description: "Provenance: where and when the user decision was made."
				},
				evidenceStatus: {
					type: "string",
					required: true,
					description: "Evidence status of this fact, e.g. \"user-authorized\"."
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						labId: {
							type: "string",
							required: true
						},
						factPath: {
							type: "string",
							required: true
						},
						factSetSha256: {
							type: "string",
							required: true
						},
						factIndex: {
							type: "number",
							required: true
						},
						runtimeRevision: {
							type: "number",
							required: true
						}
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: `AutoLab ${value.labId} registered fact #${value.factIndex} in ${value.factPath} (fact set sha256 ${value.factSetSha256})`
				}]
			},
			async execute(args, exec) {
				requireInstalledCaller(agent, exec.agent, "AutoLabRegisterUserDirective");
				return await runtime.registerUserDirective(agent, args, exec.signal);
			}
		})));
		disposers.push(agent.ctx.tools.register(defineTool({
			name: "AutoLabCommitConfigRevision",
			description: "Commit one Controller-authored configuration revision (revision N+1) on a running/paused Lab: writes revisions/NNNNNN with the complete new LAB_SPEC.md and lab.yaml, recomputes the resolved manifest, and atomically advances CURRENT. Research content (objective, families, scientific rules, contract, lane charters, evidence contract) may change; the Lab topology (roles, lanes, worktrees, repository, execution, hosts, GPU pool, communication, runner adapter) must remain byte-identical. Historical revisions and all packets/Attempts stay valid.",
			parameters: {
				...labIdParameter,
				specText: {
					type: "string",
					required: true,
					description: "Complete replacement LAB_SPEC.md text for the new revision."
				},
				configText: {
					type: "string",
					required: true,
					description: "Complete replacement lab.yaml text for the new revision (topology fields must stay identical to the current revision)."
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						labId: {
							type: "string",
							required: true
						},
						revision: {
							type: "number",
							required: true
						},
						specHash: {
							type: "string",
							required: true
						},
						configHash: {
							type: "string",
							required: true
						},
						manifestHash: {
							type: "string",
							required: true
						}
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: `AutoLab ${value.labId} committed configuration revision ${value.revision} (spec ${value.specHash.slice(0, 8)}…, config ${value.configHash.slice(0, 8)}…, manifest ${value.manifestHash.slice(0, 8)}…)`
				}]
			},
			async execute(args, exec) {
				requireInstalledCaller(agent, exec.agent, "AutoLabCommitConfigRevision");
				return await runtime.commitConfigRevision(agent, args, exec.signal);
			}
		})));
		disposers.push(agent.ctx.tools.register(defineTool({
			name: "AutoLabAssignRole",
			description: "Install one explicit Controller-authored Assignment on an Ops or enabled Coordinator role. Method keeps its dedicated Method-to-Preflight protocol. Content, output schema, and input references are opaque JSON; Runtime performs no routing or scientific interpretation.",
			parameters: {
				...labIdParameter,
				roleId: {
					type: "string",
					required: true
				},
				assignmentId: {
					type: "string",
					required: true
				},
				objective: {
					type: "string",
					required: true
				},
				contentJson: {
					type: "string",
					required: true
				},
				outputSchemaJson: {
					type: "string",
					required: true
				},
				inputArtifactRefsJson: {
					type: "string",
					required: true,
					description: "JSON array of {artifact_id, path, sha256}; Runtime does not open referenced targets."
				}
			},
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
							enum: ["working", "receipt_recorded"]
						}
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: `AutoLab ${value.labId} ${value.roleId} Assignment ${value.assignmentId}: ${value.phase}`
				}]
			},
			async execute(args, exec) {
				requireInstalledCaller(agent, exec.agent, "AutoLabAssignRole");
				return await runtime.assignRole(agent, args, exec.signal);
			}
		})));
		disposers.push(agent.ctx.tools.register(defineTool({
			name: "AutoLabLaunchAttempt",
			description: "Freeze one Controller-selected opaque Trial/RunSlot contract and launch its exact local Attempt from the active Lane Candidate. Contract, RunSlot, command, and environment arguments are JSON text; Runtime derives Candidate, CURRENT, checkout, and Attempt identities and does not interpret scientific content.",
			parameters: {
				...labIdParameter,
				laneId: {
					type: "string",
					required: true
				},
				trialId: {
					type: "string",
					required: true
				},
				trialContractJson: {
					type: "string",
					required: true
				},
				runSlotsJson: {
					type: "string",
					required: true,
					description: "JSON array of {\"runSlotId\": string, \"contract\"?: any}."
				},
				selectedRunSlotId: {
					type: "string",
					required: true
				},
				hostId: {
					type: "string",
					required: true
				},
				commandJson: {
					type: "string",
					required: true,
					description: "JSON array of command argv strings; no shell parsing is applied."
				},
				envJson: {
					type: "string",
					required: true,
					description: "JSON object containing the exact experiment environment."
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						labId: {
							type: "string",
							required: true
						},
						trialId: {
							type: "string",
							required: true
						},
						runSlotId: {
							type: "string",
							required: true
						},
						attemptId: {
							type: "string",
							required: true
						},
						phase: {
							type: "string",
							required: true,
							enum: [
								"launching",
								"running",
								"outcome_unknown",
								"terminal"
							]
						}
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: `AutoLab ${value.labId} Trial ${value.trialId} RunSlot ${value.runSlotId}: Attempt ${value.attemptId} is ${value.phase}`
				}]
			},
			async execute(args, exec) {
				requireInstalledCaller(agent, exec.agent, "AutoLabLaunchAttempt");
				return await runtime.launchAttempt(agent, args, exec.signal);
			}
		})));
		disposers.push(agent.ctx.tools.register(defineTool({
			name: "AutoLabRetryAttempt",
			description: "Create one explicit technical retry in the same Trial/RunSlot after a mechanically recorded failed Attempt. Runtime preserves lineage and uses the supplied host, argv, and environment without inspecting checkpoints or deciding scientific meaning.",
			parameters: {
				...labIdParameter,
				trialId: {
					type: "string",
					required: true
				},
				runSlotId: {
					type: "string",
					required: true
				},
				hostId: {
					type: "string",
					required: true
				},
				commandJson: {
					type: "string",
					required: true,
					description: "JSON array of exact argv strings; no shell parsing is applied."
				},
				envJson: {
					type: "string",
					required: true,
					description: "JSON object containing the exact retry environment."
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						labId: {
							type: "string",
							required: true
						},
						trialId: {
							type: "string",
							required: true
						},
						runSlotId: {
							type: "string",
							required: true
						},
						attemptId: {
							type: "string",
							required: true
						},
						phase: {
							type: "string",
							required: true,
							enum: [
								"launching",
								"running",
								"outcome_unknown",
								"terminal"
							]
						}
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: `AutoLab ${value.labId} Trial ${value.trialId} RunSlot ${value.runSlotId}: retry Attempt ${value.attemptId} is ${value.phase}`
				}]
			},
			async execute(args, exec) {
				requireInstalledCaller(agent, exec.agent, "AutoLabRetryAttempt");
				return await runtime.retryAttempt(agent, args, exec.signal);
			}
		})));
		disposers.push(agent.ctx.tools.register(defineTool({
			name: "AutoLabRequestPostflight",
			description: "Request Postflight review for one exact Controller-selected Trial/RunSlot active Attempt. Runtime binds the current Coder, Judge, original artifacts, review pause, and Lab-authored output contract without interpreting experiment content.",
			parameters: {
				...labIdParameter,
				trialId: {
					type: "string",
					required: true
				},
				runSlotId: {
					type: "string",
					required: true
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						labId: {
							type: "string",
							required: true
						},
						reviewId: {
							type: "string",
							required: true
						},
						assignmentId: {
							type: "string",
							required: true
						},
						coderRoleId: {
							type: "string",
							required: true
						},
						judgeRoleId: {
							type: "string",
							required: true
						},
						phase: {
							type: "string",
							required: true,
							enum: ["reviewing", "result_recorded"]
						}
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: `AutoLab ${value.labId} Postflight ${value.reviewId}: ${value.phase} (${value.coderRoleId} -> ${value.judgeRoleId})`
				}]
			},
			async execute(args, exec) {
				requireInstalledCaller(agent, exec.agent, "AutoLabRequestPostflight");
				return await runtime.requestPostflight(agent, args, exec.signal);
			}
		})));
		disposers.push(agent.ctx.tools.register(defineTool({
			name: "AutoLabWait",
			description: "Durably pause this Controller Goal at a real waiting point. Runtime will resume it from the exact Judge, Attempt, recovery, or user event; this tool does not poll.",
			parameters: labIdParameter,
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						labId: {
							type: "string",
							required: true
						},
						outcome: {
							type: "string",
							required: true,
							enum: [
								"paused",
								"already-paused",
								"no-goal"
							]
						}
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: `AutoLab ${value.labId} Controller wait: ${value.outcome}`
				}]
			},
			async execute(args, exec) {
				requireInstalledCaller(agent, exec.agent, "AutoLabWait");
				const result = await runtime.waitController(agent, args.labId, exec.signal);
				exec.concludeTurn();
				return result;
			}
		})));
	} catch (error) {
		disposeAll(disposers);
		throw error;
	}
	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		disposeAll(disposers);
	};
}
function controllerActionTool(agent, name$1, description, action) {
	return defineTool({
		name: name$1,
		description,
		parameters: labIdParameter,
		output: actionOutput,
		async execute(args, exec) {
			requireInstalledCaller(agent, exec.agent, name$1);
			return controllerActionResult(await action(args.labId, exec.signal));
		}
	});
}
function controllerActionResult(state) {
	return {
		labId: state.labId,
		lifecycle: state.lifecycle,
		runtimeRevision: state.runtimeRevision
	};
}
function requireInstalledCaller(installed, caller, toolName) {
	if (caller !== installed || installed.ctx.agents.get(installed.id) !== installed) throw new Error(`${toolName} requires the exact live Controller Agent`);
}
function disposeAll(disposers) {
	const errors = [];
	for (const dispose of disposers.splice(0).reverse()) try {
		dispose();
	} catch (error) {
		errors.push(error);
	}
	if (errors.length > 0) throw new AggregateError(errors, "AutoLab Controller surface disposal failed");
}

//#endregion
//#region src/coder-fix-assignment.ts
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UTF8 = new TextDecoder("utf-8", {
	fatal: true,
	ignoreBOM: true
});
var CoderFixAssignmentError = class extends Error {
	name = "CoderFixAssignmentError";
	constructor(message, code) {
		super(message);
		this.code = code;
	}
};
/**
* Freeze one Controller-authored Coder implementation-fix Assignment and Role
* Packet. This is an artifact compiler only: the fix mandate, objective, and
* references are explicit opaque inputs, the lineage review binds the approved
* design (ticket + verdict), and no scientific interpretation happens here.
*/
async function freezeCoderFixAssignment(input) {
	validateInput(input);
	const manifest = input.frozen.manifest;
	const labDirectory = manifest.authority_paths.lab_dir;
	const lane = manifest.lanes.find((candidate) => candidate.lane_id === input.coderRole.lane_id && candidate.coder_role_id === input.coderRole.role_id);
	const charter = manifest.search.lane_charters.find((candidate) => candidate.lane_id === input.coderRole.lane_id);
	if (lane === void 0 || charter === void 0) throw new CoderFixAssignmentError("target Coder does not resolve to one CURRENT Lane", "CURRENT_MISMATCH");
	const currentPacket = (await restoreCurrentRoleArtifacts({
		frozen: input.frozen,
		role: input.coderRole,
		sessionId: input.coderSessionId,
		binding: input.coderBinding,
		runtimeRevision: input.runtimeRevision,
		packetRef: input.currentPacket
	})).packet.packet;
	if (input.runtimeRevision < currentPacket.anchors.runtime_revision) throw new CoderFixAssignmentError("new Assignment runtime revision precedes the current Role Packet", "INVALID_INPUT");
	const [ticketText, verdictText] = await Promise.all([readExactText(input.designTicket, "Design Ticket"), readExactText(input.preflightVerdict, "Preflight verdict")]);
	const prompt = rolePromptFor("coder");
	const promptPath = join(labDirectory, "artifacts", "builtins", `${prompt.sha256}.txt`);
	await freezeExact(promptPath, prompt.text);
	const laneText = canonicalJson$1(charter.content);
	if (sha256(laneText) !== charter.charter_sha256) throw new CoderFixAssignmentError("LaneCharter bytes do not match CURRENT ResolvedManifest", "CURRENT_MISMATCH");
	const lanePath = join(labDirectory, "artifacts", "lanes", `${sha256(charter.lane_id)}.charter.json`);
	await freezeExact(lanePath, laneText);
	const assignmentPath = join(manifest.authority_paths.assignment_root, "coder", `${sha256(input.assignmentId)}.json`);
	const receiptPath = join(manifest.authority_paths.assignment_root, "outputs", `${sha256(input.assignmentId)}.json`);
	const outputContract = {
		schema: coderImplementationReportOutputSchema(),
		receipt_path: receiptPath,
		expected_hash_binding: input.assignmentId
	};
	const assignmentText = canonicalJson$1({
		version: 1,
		assignment_type: "controller_coder_fix_assignment",
		assignment_id: input.assignmentId,
		review_id: input.reviewId,
		runtime_revision: input.runtimeRevision,
		issued_at: input.issuedAt,
		coder: {
			role_id: input.coderRole.role_id,
			session_id: input.coderSessionId,
			binding_path: input.coderBinding.path,
			binding_sha256: input.coderBinding.hash
		},
		source_method: {
			role_id: lane.method_role_id,
			packet: artifactRef("source-method-packet", input.sourceMethodPacket)
		},
		design_ticket: { ...artifactRef("design-ticket", input.designTicket) },
		preflight_approval: {
			...artifactRef("preflight-verdict", input.preflightVerdict),
			judge_assignment_id: `preflight:${input.reviewId}`,
			top_level_verdict: "APPROVED"
		},
		candidate_id: input.candidateId,
		fix_mandate: {
			content: input.content,
			input_artifact_refs: input.inputArtifactRefs.map((reference) => ({ ...reference }))
		},
		objective: input.objective,
		output_contract: outputContract
	});
	const assignmentHash = await freezeExact(assignmentPath, assignmentText);
	const factAnchor = await currentFactAnchor(manifest.authority_paths.fact_set);
	const packet = compileRolePacket({
		manifest,
		role_id: input.coderRole.role_id,
		session_id: input.coderSessionId,
		assignment_id: input.assignmentId,
		issued_at: input.issuedAt,
		role_binding_receipt_sha256: input.coderBinding.hash,
		runtime_revision: input.runtimeRevision,
		fact_set_sha256: factAnchor.factSetSha256,
		evidence_index_sha256: currentPacket.anchors.evidence_index_sha256,
		assignment_contract_sha256: assignmentHash,
		reveal_state: currentPacket.runtime_snapshot.reveal_state,
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
				text_sha256: charter.charter_sha256
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
				block_id: "controller-coder-fix-assignment",
				source_path: assignmentPath,
				exact_text: assignmentText,
				text_sha256: assignmentHash
			}]
		},
		...currentPacket.runtime_snapshot.incumbent === void 0 ? {} : { incumbent: currentPacket.runtime_snapshot.incumbent },
		relevant_fact_refs: [...currentPacket.runtime_snapshot.relevant_fact_refs.filter((ref) => ref.id !== "fact-set"), ...factAnchor.relevantFactRefs],
		evidence_refs: currentPacket.runtime_snapshot.evidence_refs,
		open_obligation_refs: currentPacket.runtime_snapshot.open_obligation_refs,
		input_artifact_refs: [
			artifactRef("design-ticket", input.designTicket),
			artifactRef("preflight-verdict", input.preflightVerdict),
			...input.inputArtifactRefs.map((reference) => ({ ...reference }))
		],
		output_contract: outputContract
	});
	const packetPath = join(labDirectory, "packets", sha256(input.assignmentId), `${sha256(input.coderRole.role_id)}.json`);
	if (await freezeExact(packetPath, packet.canonicalJson) !== packet.packetHash) throw new CoderFixAssignmentError("Coder Role Packet file hash changed while committing", "ARTIFACT_CONFLICT");
	return {
		assignmentId: input.assignmentId,
		assignmentPath,
		assignmentHash,
		objectiveBody: input.objective,
		packetPath,
		packet
	};
}
function validateInput(input) {
	if (input.assignmentId.trim().length === 0 || input.reviewId.trim().length === 0 || input.objective.trim().length === 0 || input.candidateId.trim().length === 0 || input.coderSessionId.trim().length === 0) throw new CoderFixAssignmentError("assignmentId, reviewId, objective, candidateId and coderSessionId must be non-empty", "INVALID_INPUT");
	if (!input.assignmentId.startsWith(`coder:${input.reviewId}:fix:`)) throw new CoderFixAssignmentError(`fix Assignment ${JSON.stringify(input.assignmentId)} does not embed its lineage review ${JSON.stringify(input.reviewId)}`, "INVALID_INPUT");
	if (!Number.isSafeInteger(input.runtimeRevision) || input.runtimeRevision < 0 || !Number.isSafeInteger(input.issuedAt) || input.issuedAt < 0) throw new CoderFixAssignmentError("runtimeRevision and issuedAt must be non-negative safe integers", "INVALID_INPUT");
	for (const reference of [
		input.sourceMethodPacket,
		input.designTicket,
		input.preflightVerdict
	]) if (!isAbsolute(reference.path) || !SHA256_PATTERN.test(reference.sha256)) throw new CoderFixAssignmentError("lineage references require an absolute path and SHA-256", "INVALID_INPUT");
	for (const reference of input.inputArtifactRefs) if (!isAbsolute(reference.path) || !SHA256_PATTERN.test(reference.sha256)) throw new CoderFixAssignmentError("input artifact references require an absolute path and SHA-256", "INVALID_INPUT");
}
function artifactRef(artifactId, reference) {
	return {
		artifact_id: artifactId,
		path: reference.path,
		sha256: reference.sha256
	};
}
async function readExactText(reference, label) {
	let bytes;
	try {
		bytes = await readFile(reference.path);
	} catch {
		throw new CoderFixAssignmentError(`${label} cannot be read`, "REFERENCE_MISMATCH");
	}
	if (sha256(bytes) !== reference.sha256) throw new CoderFixAssignmentError(`${label} SHA-256 mismatch`, "REFERENCE_MISMATCH");
	try {
		return UTF8.decode(bytes);
	} catch {
		throw new CoderFixAssignmentError(`${label} is not valid UTF-8`, "REFERENCE_MISMATCH");
	}
}
async function freezeExact(path, bytes) {
	if (await readFile(path, "utf8").catch((error) => {
		if (isNodeError(error) && error.code === "ENOENT") return void 0;
		throw error;
	}) === void 0) try {
		await durableWriteFile(path, bytes, false);
	} catch (error) {
		if (!isNodeError(error) || error.code !== "EEXIST") throw error;
	}
	const committed = await readFile(path, "utf8");
	if (committed !== bytes) throw new CoderFixAssignmentError(`Immutable Coder artifact conflicts at ${path}`, "ARTIFACT_CONFLICT");
	return sha256(committed);
}
function isNodeError(value) {
	return value instanceof Error && "code" in value;
}

//#endregion
//#region src/attempt-poke.ts
/**
* Publish one lossy wakeup endpoint for Attempt receipt events. The socket
* carries no Attempt identity or state; callers always reread active durable
* Attempt references before doing work.
*/
async function openAttemptPokeEndpoint(input) {
	const server = await createPokeServer({
		socketDir: shortSocketDirectory(input.root),
		onPoke: input.onPoke,
		...input.onError === void 0 ? {} : { onError: input.onError }
	});
	const pointerPath = join(input.root, "runtime-poke.json");
	try {
		await durableWriteFile(pointerPath, `${JSON.stringify({
			version: 1,
			socketPath: server.endpoint.socketPath
		})}\n`, true);
	} catch (error) {
		await server.close();
		throw error;
	}
	return {
		pointerPath,
		socketPath: server.endpoint.socketPath,
		close: () => server.close()
	};
}
function shortSocketDirectory(root) {
	const uid = process.getuid?.() ?? "user";
	const digest = createHash("sha256").update(root).digest("hex").slice(0, 12);
	return join(process.platform === "darwin" ? "/tmp" : tmpdir(), `dsh-autolab-${uid}-${digest}`);
}

//#endregion
//#region src/role-goal-revision.ts
/**
* Project one exact native Goal revision edge onto its owning AutoLab role.
* Goal phase and counters remain owned by DSH; this only keeps the persisted
* compare-and-set reference current after pause/resume/API-recovery mutations.
*/
function projectRoleGoalRevision(state, edge) {
	const matches = Object.entries(state.roles).filter(([, role$1]) => {
		const install = role$1.goalInstall;
		return role$1.sessionId === edge.sessionId && install?.status === "applied" && install.goalId === edge.goalId && install.objectiveHash === edge.objectiveHash && install.goalRevision !== void 0 && edge.goalRevision > install.goalRevision;
	});
	if (matches.length !== 1) return void 0;
	const [roleId, role] = matches[0];
	const roles = structuredClone(state.roles);
	roles[roleId] = {
		...role,
		goalInstall: {
			...role.goalInstall,
			goalRevision: edge.goalRevision
		}
	};
	return {
		roleId,
		roles
	};
}
/** Exact identity check shared by result-bearing role submissions. */
function roleOwnsExactAssignmentGoal(role, goal) {
	const install = role.goalInstall;
	return install?.status === "applied" && goal !== void 0 && String(goal.id) === install.goalId && goal.revision === install.goalRevision && sha256(goal.objective) === install.objectiveHash;
}

//#endregion
//#region src/index.ts
const AUTOLAB_PLUGIN_VERSION = "0.1.0";
const DSH_COMPATIBILITY_VERSION = "0.1.0-rc.6";
const API_RECOVERY_DELAY_MS = 5e3;
const ATTEMPT_PENDING_RETRY_MS = 1e3;
const ATTEMPT_LAUNCH_SAFETY_MS = 250;
var AutoLabRuntimeError = class extends HarnessError {
	name = "AutoLabRuntimeError";
	constructor(message, code) {
		super(message, code);
		this.code = code;
	}
};
var AutoLabRuntime = class extends Service {
	static inject = [
		"storageDomain",
		"agents",
		"goals",
		"tools",
		"systemPrompt",
		"sessions",
		"agentPresets",
		"permissionPresets",
		"sessionPersistence",
		"sessionMessaging",
		"subprocess"
	];
	static Config = s.object({ root: s.string().default(dshHomePath("autolab")) });
	root;
	artifacts;
	dialogue;
	view = /* @__PURE__ */ new Map();
	roleHandles = /* @__PURE__ */ new Map();
	borrowedRoleAgents = /* @__PURE__ */ new Map();
	controllerSurfaces = /* @__PURE__ */ new Map();
	controllerTasks = /* @__PURE__ */ new Set();
	attemptTasks = /* @__PURE__ */ new Set();
	reviewHolds = /* @__PURE__ */ new Map();
	reviewHoldTasks = /* @__PURE__ */ new Map();
	reviewStatusTasks = /* @__PURE__ */ new Set();
	reviewControlTasks = /* @__PURE__ */ new Set();
	shutdown = new AbortController();
	domain;
	table;
	apiRecoveryStore;
	apiRecovery;
	attemptPoke;
	attemptRuntime;
	owner;
	removeReviewControlHandlers;
	removeReviewStatusListener;
	removeControllerCreatedListener;
	removeControllerDisposedListener;
	removeControllerGoalListener;
	removeSubmissionTools;
	teardownTask;
	/** Serialize only mutations of the same Lab; independent Labs never block each other. */
	operationTails = /* @__PURE__ */ new Map();
	accepting = false;
	constructor(ctx, config = {}) {
		super(ctx, "autolab");
		this.root = resolve(expandHomePath(config.root ?? dshHomePath("autolab")));
		this.artifacts = new ArtifactStore(this.root);
		this.dialogue = new DialogueLog(this.artifacts.labsRoot);
	}
	async [Service.init]() {
		const owner = await acquireRuntimeLock(this.root);
		this.owner = owner;
		this.removeSubmissionTools = installSubmissionTools(this.ctx, this);
		const disposeLifecycle = this.ctx.effect(() => async () => this.teardown(), "autolab.lifecycle");
		try {
			await this.artifacts.initialize();
			const domain = await this.ctx.storageDomain.open(autolabDomainSpec);
			this.domain = domain;
			const table = domain.table("labs");
			this.table = table;
			this.apiRecoveryStore = new DurableApiRecoveryStore(domain.table("api_recoveries"));
			for (const [labId, snapshot] of table.entries()) {
				const ownerChanged = snapshot.ownerEpoch !== owner.owner.token;
				let projected = adoptRuntimeOwner(snapshot, owner.owner.token);
				const frozen = await this.artifacts.readCurrentIfPresent(labId);
				if (frozen === void 0) {
					if (projected.config !== void 0) throw new AutoLabRuntimeError(`Lab ${labId} RuntimeState references a revision but CURRENT is absent`, "CONFIG_DRIFT");
				} else if (!sameConfigRef(projected.config, frozen.ref)) {
					const lifecycle = projected.lifecycle === "configuring" || projected.lifecycle === "draft_ready" ? "ready" : projected.lifecycle;
					projected = transitionRuntimeState(projected, {
						expectedRevision: projected.runtimeRevision,
						ownerEpoch: owner.owner.token,
						lifecycle,
						config: frozen.ref
					});
				}
				if (ownerChanged) projected = recoverReviewFreezeProjection(projected, owner.owner.token);
				const current = projected === snapshot ? snapshot : await table.update(labId, (value) => {
					if (value.runtimeRevision !== snapshot.runtimeRevision) throw new AutoLabRuntimeError(`Lab ${labId} changed while adopting Controller ownership`, "CONFIG_DRIFT");
					return projected;
				});
				this.view.set(labId, current);
			}
			this.removeControllerCreatedListener = this.ctx.on("agent/created", ({ agent }) => {
				if (!this.isControllerAgent(agent)) return;
				try {
					this.attachControllerSurface(agent);
					if (this.accepting) this.trackControllerTask(this.reconcileControllerAgent(agent));
				} catch (error) {
					this.ctx.logger.error(`AutoLab could not attach Controller surface to ${String(agent.id)}: ${renderError(error)}`);
				}
			});
			this.removeControllerDisposedListener = this.ctx.on("agent/disposed", ({ agent }) => {
				const key = String(agent.id);
				if (this.controllerSurfaces.get(key)?.agent === agent) this.controllerSurfaces.delete(key);
			});
			this.removeControllerGoalListener = this.ctx.on("goal/changed", ({ agent, change }) => {
				if (this.isControllerAgent(agent)) {
					this.trackControllerTask(this.trackControllerGoalChange(agent, String(change.ref.id), change.ref.revision, change.goal));
					return;
				}
				if (change.goal !== void 0) this.trackControllerTask(this.trackRoleGoalChange(agent, change.goal));
			});
			for (const agent of this.ctx.agents.list()) if (this.isControllerAgent(agent)) this.attachControllerSurface(agent);
			this.removeReviewControlHandlers = registerReviewControlHandlers(this.ctx, {
				resolveCapability: (controlId) => this.resolveReviewCapability(controlId),
				signal: this.shutdown.signal,
				runHandler: (operation) => this.runReviewControlHandler(operation)
			});
			this.removeReviewStatusListener = this.ctx.on("session-messaging/control-status", (receipt) => this.trackReviewControlStatus(receipt));
			this.attemptRuntime = new AttemptRuntimeConsumer({
				readState: (labId) => this.view.get(labId),
				resolveRunRoot: async (state) => {
					const frozen = await this.artifacts.readCurrent(state.labId);
					if (!sameConfigRef(state.config, frozen.ref)) throw new AutoLabRuntimeError(`Lab ${state.labId} CURRENT drifted while consuming an Attempt event`, "CONFIG_DRIFT");
					return frozen.manifest.execution.run_root;
				},
				wrapperPath: await resolveLocalAttemptWrapperPath(),
				scheduleOnce: (callback, delayMs) => {
					const timer = setTimeout(callback, delayMs);
					timer.unref();
					return () => clearTimeout(timer);
				},
				pendingRetryDelayMs: ATTEMPT_PENDING_RETRY_MS,
				launchSafetyDelayMs: ATTEMPT_LAUNCH_SAFETY_MS,
				now: Date.now,
				onResult: (result) => this.applyAttemptRuntimeResult(result),
				onError: (error) => {
					if (this.shutdown.signal.aborted) return;
					this.ctx.logger.warn(`AutoLab deferred an Attempt edge: ${renderError(error)}`);
				}
			});
			this.attemptPoke = await openAttemptPokeEndpoint({
				root: this.root,
				onPoke: () => {
					if (!this.accepting) return;
					this.trackAttemptTask(this.dispatchAllActiveAttempts("poke"));
				},
				onError: (error) => {
					if (this.shutdown.signal.aborted) return;
					this.ctx.logger.warn(`AutoLab Attempt poke failed: ${renderError(error)}`);
				}
			});
			this.accepting = true;
			this.apiRecovery = installApiRecovery(this.ctx, {
				store: this.apiRecoveryStore,
				resolveAssignment: (agent) => this.resolveApiRecoveryAssignment(agent),
				scheduleOnce: (callback, delayMs) => {
					const timer = setTimeout(callback, delayMs);
					timer.unref();
					return () => clearTimeout(timer);
				},
				now: Date.now,
				retryDelayMs: API_RECOVERY_DELAY_MS,
				resumeReviewOnce: (agent, wake, signal) => this.resumeApiReviewOnce(agent, wake, signal),
				onOperatorIncident: (record) => this.notifyOperatorIncident(record),
				onError: (error) => {
					if (this.shutdown.signal.aborted) return;
					this.ctx.logger.warn(`AutoLab API recovery deferred a mechanical action: ${renderError(error)}`);
				}
			});
			await Promise.allSettled(this.ctx.agents.list().filter((agent) => this.isControllerAgent(agent)).map((agent) => this.reconcileControllerAgent(agent)));
			const recoverable = [...this.view.values()].filter((state) => state.lifecycle === "running" || state.lifecycle === "starting" || state.lifecycle === "pausing");
			await Promise.allSettled(recoverable.map((state) => {
				const controller = { id: SessionId(state.controllerSessionId) };
				return state.lifecycle === "pausing" ? this.pause(controller, state.labId, this.shutdown.signal) : this.start(controller, state.labId, this.shutdown.signal);
			}));
			await this.dispatchAllActiveAttempts("startup");
		} catch (error) {
			await disposeLifecycle();
			throw error;
		}
	}
	create(controller, sourceDirectory, signal) {
		const labId = generateLabId();
		return this.enqueue(labId, async () => {
			signal?.throwIfAborted();
			const ownerEpoch = this.requireOwner().owner.token;
			const scaffold = await this.artifacts.createLab({
				labId,
				controllerSessionId: String(controller.id),
				...sourceDirectory === void 0 ? {} : { sourceDirectory }
			});
			try {
				const controllerSessionId = String(controller.id);
				const events = controller.session?.events ?? [];
				await this.dialogue.initialize({
					labId,
					controllerSessionId,
					timestamp: Date.now(),
					...sourceDirectory === void 0 ? {} : { sourceDirectory }
				});
				await this.dialogue.appendSessionEvents({
					labId,
					controllerSessionId,
					events,
					fromSeq: findCreateBoundary(events)
				});
				signal?.throwIfAborted();
				const state = createRuntimeState({
					labId,
					ownerEpoch,
					controllerSessionId,
					lifecycle: scaffold.imported ? "draft_ready" : "configuring"
				});
				await this.requireTable().put(labId, state);
				this.view.set(labId, state);
				this.attachControllerSurface(controller);
				return {
					state: cloneState(state),
					directory: scaffold.directory,
					draft: scaffold.draft
				};
			} catch (error) {
				this.view.delete(labId);
				try {
					await this.requireTable().delete(labId);
					await this.artifacts.discardScaffold(labId);
				} catch (rollbackError) {
					throw new AggregateError([error, rollbackError], `AutoLab ${labId} create rollback failed`);
				}
				throw error;
			}
		});
	}
	async show(caller, labId, signal) {
		this.assertReady();
		signal?.throwIfAborted();
		const state = this.requireState(validateLabId(labId));
		this.assertControllerSession(caller, state);
		await this.syncDialogue(caller, state);
		if (state.config === void 0) {
			const draft = await this.artifacts.readDraft(labId);
			return {
				state: cloneState(state),
				directory: this.artifacts.labDirectory(labId),
				draft
			};
		}
		const frozen = await this.artifacts.readCurrent(labId);
		signal?.throwIfAborted();
		if (!sameConfigRef(state.config, frozen.ref)) throw new AutoLabRuntimeError(`Lab ${labId} CURRENT does not match RuntimeState`, "CONFIG_DRIFT");
		return {
			state: cloneState(state),
			directory: this.artifacts.labDirectory(labId),
			frozen
		};
	}
	async readForController(caller, labId, signal) {
		const result = await this.show(caller, labId, signal);
		const source = result.frozen ?? result.draft;
		if (source === void 0) throw new AutoLabRuntimeError(`Lab ${labId} has no readable originals`, "CONFIG_DRIFT");
		return {
			labId: result.state.labId,
			lifecycle: result.state.lifecycle,
			directory: result.directory,
			revision: result.frozen === void 0 ? "draft" : String(result.frozen.ref.revision),
			labSpec: source.spec,
			labYaml: source.config
		};
	}
	commit(caller, labId, signal) {
		return this.enqueue(labId, async () => {
			signal?.throwIfAborted();
			let state = this.requireState(validateLabId(labId));
			this.assertControllerSession(caller, state);
			if (state.lifecycle !== "configuring" && state.lifecycle !== "draft_ready") throw new AutoLabRuntimeError(`Lab ${labId} is ${state.lifecycle}; only an uncommitted draft can be committed`, "NOT_READY");
			await this.syncDialogue(caller, state);
			const draft = await this.artifacts.readDraft(labId);
			const config = parseDraftLabYaml(draft.config);
			const resolvedRepository = await resolveRepositoryRefs(config.repository.path, [config.repository.base_ref, ...config.search.lanes.map((lane) => lane.base_ref)]);
			const repositoryBaseSha = resolvedRepository.commits[config.repository.base_ref];
			if (repositoryBaseSha === void 0) throw new AutoLabRuntimeError("Repository base ref was not resolved", "CONFIG_DRIFT");
			const laneBaseShas = Object.fromEntries(config.search.lanes.map((lane) => {
				const baseSha = resolvedRepository.commits[lane.base_ref];
				if (baseSha === void 0) throw new AutoLabRuntimeError(`Lane ${lane.lane_id} base ref was not resolved`, "CONFIG_DRIFT");
				return [lane.lane_id, baseSha];
			}));
			await this.dialogue.appendControllerRecord({
				labId,
				controllerSessionId: state.controllerSessionId,
				timestamp: Date.now(),
				recordKind: "discovery",
				payload: {
					kind: "git_refs",
					repositoryPath: resolvedRepository.repositoryPath,
					repositoryBaseRef: config.repository.base_ref,
					repositoryBaseSha,
					laneBaseShas
				},
				relatedRevision: 1
			});
			const dialogueHead = await this.dialogue.appendControllerRecord({
				labId,
				controllerSessionId: state.controllerSessionId,
				timestamp: Date.now(),
				recordKind: "acceptance",
				payload: {
					action: "commit_revision",
					revision: 1
				},
				relatedRevision: 1
			});
			signal?.throwIfAborted();
			const rolePromptHashes = Object.fromEntries(config.roles.map((role) => [role.role_id, rolePromptFor(role.role_kind).sha256]));
			const manifest = resolveDraftLabConfig(config, {
				lab_id: labId,
				revision: 1,
				controller_session_id: state.controllerSessionId,
				dialogue_head_sha256: dialogueHead.recordHash,
				lab_spec_sha256: draft.specHash,
				lab_yaml_sha256: draft.configHash,
				lab_directory: this.artifacts.labDirectory(labId),
				autolab_plugin_version: AUTOLAB_PLUGIN_VERSION,
				dsh_version: DSH_COMPATIBILITY_VERSION,
				repository_base_sha: repositoryBaseSha,
				lane_base_shas: laneBaseShas,
				role_prompt_sha256: rolePromptHashes
			});
			const frozen = await this.artifacts.freezeDraftRevision({
				labId,
				revision: 1,
				manifest,
				dialogueHeadHash: dialogueHead.recordHash
			});
			state = await this.transition(state, "ready", void 0, frozen.ref, void 0, void 0, void 0, void 0, void 0, frozen.manifest.communication.reveal_policy.initial_state);
			await this.dialogue.appendControllerRecord({
				labId,
				controllerSessionId: state.controllerSessionId,
				timestamp: Date.now(),
				recordKind: "configure_action",
				payload: {
					action: "revision_committed",
					revision: 1,
					dialogueHead,
					specHash: frozen.ref.specHash,
					configHash: frozen.ref.configHash,
					manifestHash: frozen.ref.manifestHash,
					dialogueHeadHash: frozen.ref.dialogueHeadHash
				},
				relatedRevision: 1
			});
			return {
				state: cloneState(state),
				directory: this.artifacts.labDirectory(labId),
				frozen
			};
		});
	}
	/**
	* Commit one Controller-authored configuration revision (revision N+1) on a
	* running/paused Lab. The revision may change research content (objective,
	* families, scientific rules, contract, lane charters, evidence contract)
	* but NOT the Lab topology (roles, lanes, worktrees, repository, execution,
	* hosts, GPU pool, communication ACL, runner adapter): those must remain
	* byte-identical so every existing role, packet, and Attempt stays valid.
	*/
	async commitConfigRevision(caller, input, signal) {
		const labId = validateLabId(input.labId);
		return this.enqueue(labId, async () => {
			signal?.throwIfAborted();
			let state = this.requireState(labId);
			this.assertControllerSession(caller, state);
			if (state.lifecycle !== "running" && state.lifecycle !== "paused") throw new AutoLabRuntimeError(`Lab ${labId} is ${state.lifecycle}; a revision requires running or paused`, "NOT_READY");
			const frozen = await this.artifacts.readCurrent(labId);
			if (!sameConfigRef(state.config, frozen.ref)) throw new AutoLabRuntimeError(`Lab ${labId} CURRENT does not match RuntimeState`, "CONFIG_DRIFT");
			const revision = frozen.ref.revision + 1;
			const config = parseDraftLabYaml(input.configText);
			const dialogueHead = await this.dialogue.appendControllerRecord({
				labId,
				controllerSessionId: state.controllerSessionId,
				timestamp: Date.now(),
				recordKind: "acceptance",
				payload: {
					action: "commit_revision",
					revision
				},
				relatedRevision: revision
			});
			const rolePromptHashes = Object.fromEntries(config.roles.map((role) => [role.role_id, rolePromptFor(role.role_kind).sha256]));
			const manifest = resolveDraftLabConfig(config, {
				lab_id: labId,
				revision,
				controller_session_id: state.controllerSessionId,
				dialogue_head_sha256: dialogueHead.recordHash,
				lab_spec_sha256: sha256(input.specText),
				lab_yaml_sha256: sha256(input.configText),
				lab_directory: this.artifacts.labDirectory(labId),
				autolab_plugin_version: AUTOLAB_PLUGIN_VERSION,
				dsh_version: DSH_COMPATIBILITY_VERSION,
				repository_base_sha: frozen.manifest.repository.base_sha,
				lane_base_shas: Object.fromEntries(frozen.manifest.lanes.map((lane) => [lane.lane_id, lane.base_sha])),
				role_prompt_sha256: rolePromptHashes
			});
			assertRevisionTopologyUnchanged(frozen.manifest, manifest);
			signal?.throwIfAborted();
			const next = await this.artifacts.freezeConfigRevision({
				labId,
				revision,
				spec: input.specText,
				config: input.configText,
				manifest,
				dialogueHeadHash: dialogueHead.recordHash
			});
			for (const charter of manifest.search.lane_charters) await durableWriteFile(join(this.artifacts.labDirectory(labId), "artifacts", "lanes", `${sha256(charter.lane_id)}.charter.json`), canonicalJson$1(charter.content), true);
			state = await this.transition(state, state.lifecycle, void 0, next.ref);
			await this.dialogue.appendControllerRecord({
				labId,
				controllerSessionId: state.controllerSessionId,
				timestamp: Date.now(),
				recordKind: "configure_action",
				payload: {
					action: "revision_committed",
					revision: next.ref.revision,
					specHash: next.ref.specHash,
					configHash: next.ref.configHash,
					manifestHash: next.ref.manifestHash,
					dialogueHeadHash: next.ref.dialogueHeadHash
				},
				relatedRevision: next.ref.revision
			});
			return {
				labId,
				revision: next.ref.revision,
				specHash: next.ref.specHash,
				configHash: next.ref.configHash,
				manifestHash: next.ref.manifestHash
			};
		});
	}
	status(caller, labId) {
		this.assertReady();
		const state = this.requireState(validateLabId(labId));
		this.assertControllerSession(caller, state);
		return cloneState(state);
	}
	reveal(caller, labId, signal) {
		return this.enqueue(labId, async () => {
			signal?.throwIfAborted();
			let state = this.requireState(validateLabId(labId));
			this.assertControllerSession(caller, state);
			if (state.config === void 0 || state.lifecycle !== "running" && state.lifecycle !== "paused") throw new AutoLabRuntimeError(`Lab ${labId} must be running or paused before reveal`, "NOT_READY");
			const frozen = await this.artifacts.readCurrent(labId);
			if (!sameConfigRef(state.config, frozen.ref)) throw new AutoLabRuntimeError(`Lab ${labId} CURRENT does not match RuntimeState`, "CONFIG_DRIFT");
			if (state.revealState !== "revealed") state = await this.transition(state, state.lifecycle, void 0, void 0, void 0, void 0, void 0, void 0, void 0, "revealed");
			const workers = frozen.manifest.roles.filter((role) => role.role_kind !== "controller");
			const attached = await this.readAttachedRoles(state, frozen, workers);
			await this.reconcileCommunicationAcl(caller, state, frozen, attached, signal);
			return {
				labId: state.labId,
				revealState: "revealed",
				runtimeRevision: state.runtimeRevision
			};
		});
	}
	/**
	* Freeze the exact Method receipt selected by its current Role Packet, then
	* commit one owner-fenced Preflight review before sending its typed request.
	* No caller-supplied path, control envelope, or target Session is accepted.
	*/
	submitMethodForPreflightReview(caller, signal) {
		const labId = this.resolveExactRoleCaller(caller).state.labId;
		const sourceTurn = observeOpenAgentTurn(caller);
		if (sourceTurn === void 0) throw new AutoLabRuntimeError("Method review submission requires the exact open caller turn", "REVIEW_NOT_READY");
		return this.enqueue(labId, async () => {
			signal?.throwIfAborted();
			let { state, roleId } = this.resolveExactRoleCaller(caller);
			const existing = Object.values(state.reviews).find((review) => review.capability.workerRoleId === roleId && review.phase === "reviewing");
			if (existing !== void 0) {
				if (existing.stage !== "preflight" || state.roles[roleId]?.phase !== "reviewing" || state.roles[roleId]?.goalInstall?.assignmentId !== existing.capability.assignmentId) throw new AutoLabRuntimeError(`Role ${roleId} already has a non-replayable review state`, "REVIEW_NOT_READY");
				await this.dispatchReviewRequest(caller, existing.capability, signal);
				return roleSubmissionResult(state.labId, existing.capability, "reviewing");
			}
			const methodState = state.roles[roleId];
			if (state.lifecycle !== "running" || methodState.phase !== "working" || methodState.packet === void 0 || methodState.binding === void 0 || methodState.goalInstall?.status !== "applied") throw new AutoLabRuntimeError(`Method role ${roleId} is not an active review candidate`, "REVIEW_NOT_READY");
			const frozen = await this.artifacts.readCurrent(state.labId);
			if (!sameConfigRef(state.config, frozen.ref)) throw new AutoLabRuntimeError(`Lab ${state.labId} CURRENT does not match RuntimeState`, "CONFIG_DRIFT");
			const methodRole = frozen.manifest.roles.find((role) => role.role_id === roleId);
			if (methodRole?.role_kind !== "method") throw new AutoLabRuntimeError(`Role ${roleId} is not a Method role in CURRENT`, "CONFIG_DRIFT");
			const lane = frozen.manifest.lanes.find((value) => value.lane_id === methodRole.lane_id && value.method_role_id === roleId);
			if (lane === void 0) throw new AutoLabRuntimeError(`Method role ${roleId} has no exact Lane binding`, "CONFIG_DRIFT");
			const judgeState = state.roles[lane.preflight_judge_role_id];
			if (judgeState?.activationBlocker !== void 0) throw new AutoLabRuntimeError(`Preflight Judge ${lane.preflight_judge_role_id} is unavailable: ${judgeState.activationBlocker.message}`, "ROLE_ACTIVATION_UNAVAILABLE");
			if (judgeState?.binding === void 0 || judgeState.packet === void 0) throw new AutoLabRuntimeError(`Preflight Judge ${lane.preflight_judge_role_id} is not bound`, "REVIEW_NOT_READY");
			const judgeBinding = await readRoleBinding(frozen.manifest.authority_paths.lab_dir, lane.preflight_judge_role_id);
			if (judgeBinding === void 0 || judgeBinding.path !== judgeState.binding.path || judgeBinding.hash !== judgeState.binding.hash) throw new AutoLabRuntimeError(`Preflight Judge ${lane.preflight_judge_role_id} binding drifted`, "CONFIG_DRIFT");
			const plannedRevision = state.runtimeRevision + 1;
			const reviewId = deterministicReviewId([
				state.labId,
				String(frozen.ref.revision),
				roleId,
				methodState.goalInstall.assignmentId,
				methodState.packet.hash,
				String(plannedRevision)
			]);
			const reviewRoot = join(frozen.manifest.authority_paths.lab_dir, "artifacts", "reviews", reviewId);
			const ticket = await freezeMethodDesignTicket({
				rolePacketPath: methodState.packet.path,
				rolePacketHash: methodState.packet.hash,
				reviewArtifactPath: join(reviewRoot, "method-ticket.json")
			});
			if (ticket.assignmentId !== methodState.goalInstall.assignmentId) throw new AutoLabRuntimeError(`Method receipt belongs to ${ticket.assignmentId}, not the active Assignment`, "CONFIG_DRIFT");
			const reviewArtifacts = await freezePreflightReviewArtifacts({
				frozen,
				judgeSessionId: judgeState.sessionId,
				judgeBinding,
				sourceMethodAssignment: {
					path: ticket.sourceAssignmentPath,
					sha256: ticket.sourceAssignmentHash
				},
				sourceMethodPacket: {
					path: ticket.rolePacketPath,
					sha256: ticket.rolePacketHash
				},
				designTicket: {
					path: ticket.artifactPath,
					sha256: ticket.artifactHash
				},
				reviewId,
				runtimeRevision: plannedRevision,
				issuedAt: state.updatedAt
			});
			const liveGoal = this.ctx.goals.get(caller);
			if (liveGoal === void 0 || String(liveGoal.id) !== methodState.goalInstall.goalId || sha256(liveGoal.objective) !== methodState.goalInstall.objectiveHash) throw new AutoLabRuntimeError(`Method role ${roleId} no longer owns its persisted Assignment Goal`, "REVIEW_NOT_READY");
			const capability = compileReviewControlCapability({
				reviewId,
				assignmentId: ticket.assignmentId,
				configRevision: frozen.ref.revision,
				runtimeRevision: plannedRevision,
				ownerFence: this.requireOwner().owner.token,
				workerRoleId: roleId,
				workerSessionId: methodState.sessionId,
				judgeRoleId: lane.preflight_judge_role_id,
				judgeSessionId: judgeState.sessionId,
				packetHash: reviewArtifacts.packet.packetHash,
				artifactHash: ticket.artifactHash,
				negotiatedAnchorHash: reviewArtifacts.reviewInputHash,
				sourceTurn,
				expectedGoalRef: {
					id: String(liveGoal.id),
					revision: liveGoal.revision
				},
				requestControlId: randomUUID(),
				acceptedPauseControlId: randomUUID()
			});
			const now = Date.now();
			const roles = structuredClone(state.roles);
			roles[roleId] = {
				...methodState,
				phase: "reviewing"
			};
			const reviews = structuredClone(state.reviews);
			reviews[reviewId] = {
				stage: "preflight",
				phase: "reviewing",
				sourcePacket: {
					path: methodState.packet.path,
					hash: methodState.packet.hash
				},
				packetPath: reviewArtifacts.packetPath,
				artifactPath: ticket.artifactPath,
				capability,
				pause: {
					controlId: capability.acceptedPause.controlId,
					payloadHash: capability.acceptedPause.payloadHash,
					freeze: "pending"
				},
				createdAt: now,
				updatedAt: now
			};
			state = await this.transition(state, state.lifecycle, void 0, void 0, roles, reviews);
			await this.dispatchReviewRequest(caller, capability, signal);
			return roleSubmissionResult(state.labId, capability, "reviewing");
		});
	}
	/**
	* Freeze and project the exact receipt selected by the calling Judge's
	* current review. Verdict persistence is independent from worker freezing:
	* this method never releases a review hold or activates another Goal.
	*/
	submitPreflightVerdict(caller, signal) {
		const labId = this.resolveExactRoleCaller(caller).state.labId;
		return this.enqueue(labId, async () => {
			signal?.throwIfAborted();
			const { state, roleId } = this.resolveExactRoleCaller(caller);
			const selected = selectJudgeReview(state, roleId);
			if (selected === void 0 || selected.review.stage !== "preflight") throw new AutoLabRuntimeError(`Judge role ${roleId} has no unambiguous Preflight review`, "REVIEW_NOT_READY");
			const { reviewId, review } = selected;
			const artifactPath = join(dirname(review.artifactPath), "preflight-verdict.json");
			const frozen = await freezePreflightVerdict({
				rolePacketPath: review.packetPath,
				rolePacketHash: review.capability.packetHash,
				artifactPath
			});
			signal?.throwIfAborted();
			if (frozen.verdict.review_id !== reviewId || frozen.verdict.review_input_sha256 !== review.capability.negotiatedAnchorHash || frozen.packet.header.session_id !== review.capability.judgeSessionId) throw new AutoLabRuntimeError(`Preflight verdict does not match review ${reviewId}`, "CONFIG_DRIFT");
			const phase = frozen.verdict.top_level_verdict === "REVIEW_ERROR" ? "error" : "verdict_recorded";
			const existing = review.verdict;
			if (existing !== void 0) {
				if (existing.path !== artifactPath || existing.hash !== frozen.receiptHash || existing.assignmentId !== frozen.verdict.assignment_id || existing.reviewInputHash !== frozen.verdict.review_input_sha256 || existing.topLevelVerdict !== frozen.verdict.top_level_verdict || review.phase !== phase) throw new AutoLabRuntimeError(`Preflight review ${reviewId} already records a different verdict`, "CONFIG_DRIFT");
				return preflightVerdictResult(state.labId, roleId, reviewId, existing.assignmentId, review.phase, existing.topLevelVerdict);
			}
			const now = Date.now();
			const reviews = structuredClone(state.reviews);
			reviews[reviewId] = {
				...review,
				phase,
				verdict: {
					path: artifactPath,
					hash: frozen.receiptHash,
					assignmentId: frozen.verdict.assignment_id,
					reviewInputHash: frozen.verdict.review_input_sha256,
					topLevelVerdict: frozen.verdict.top_level_verdict,
					recordedAt: now
				},
				updatedAt: now
			};
			const recorded = await this.transition(state, state.lifecycle, void 0, void 0, void 0, reviews);
			await this.wakeControllerForEvent(recorded, `preflight-verdict:${reviewId}:${frozen.receiptHash}`, [`AutoLab ${state.labId} Preflight review ${reviewId} recorded ${frozen.verdict.top_level_verdict}.`, `Read the complete original verdict at ${artifactPath} (sha256 ${frozen.receiptHash}) and decide the next responsibility from CURRENT.`].join("\n"));
			return preflightVerdictResult(state.labId, roleId, reviewId, frozen.verdict.assignment_id, phase, frozen.verdict.top_level_verdict);
		});
	}
	/** Freeze one Postflight Judge receipt as opaque bytes and project only its identity. */
	submitPostflightResult(caller, signal) {
		const labId = this.resolveExactRoleCaller(caller).state.labId;
		return this.enqueue(labId, async () => {
			signal?.throwIfAborted();
			const { state, roleId } = this.resolveExactRoleCaller(caller);
			const selected = selectJudgeReview(state, roleId);
			if (selected === void 0 || selected.review.stage !== "postflight") throw new AutoLabRuntimeError(`Judge role ${roleId} has no unambiguous Postflight review`, "REVIEW_NOT_READY");
			const { reviewId, review } = selected;
			if (!reviewFreezeComplete(review, state.ownerEpoch)) throw new AutoLabRuntimeError(`Postflight review ${reviewId} has not completed its one review pause`, "REVIEW_NOT_READY");
			const frozenRevision = await this.artifacts.readCurrent(state.labId);
			if (!sameConfigRef(state.config, frozenRevision.ref)) throw new AutoLabRuntimeError(`Lab ${state.labId} CURRENT does not match RuntimeState`, "CONFIG_DRIFT");
			const artifactPath = join(frozenRevision.manifest.authority_paths.lab_dir, "artifacts", "reviews", reviewId, "postflight-result.raw");
			const frozen = await freezePostflightResult({
				rolePacketPath: review.packetPath,
				rolePacketHash: review.capability.packetHash,
				artifactPath
			});
			signal?.throwIfAborted();
			if (frozen.packet.header.lab_id !== state.labId || frozen.packet.header.role_id !== roleId || frozen.packet.header.session_id !== review.capability.judgeSessionId || frozen.packet.header.assignment_id !== review.capability.assignmentId || frozen.packet.anchors.source_revision !== review.capability.configRevision || frozen.expectedHashBinding !== review.capability.negotiatedAnchorHash) throw new AutoLabRuntimeError(`Postflight result does not match review ${reviewId}`, "CONFIG_DRIFT");
			const existing = review.result;
			if (existing !== void 0) {
				if (review.phase !== "result_recorded" || existing.path !== artifactPath || existing.hash !== frozen.receiptHash || existing.assignmentId !== frozen.packet.header.assignment_id || existing.reviewInputHash !== frozen.expectedHashBinding) throw new AutoLabRuntimeError(`Postflight review ${reviewId} already records another result`, "CONFIG_DRIFT");
				await this.wakeControllerForEvent(state, `postflight-result:${reviewId}:${frozen.receiptHash}`, postflightControllerEventText(state.labId, reviewId, artifactPath, frozen.receiptHash));
				const retainedHold$1 = this.reviewHolds.get(reviewHoldKey(state.labId, reviewId));
				if (retainedHold$1 !== void 0) {
					this.reviewHolds.delete(reviewHoldKey(state.labId, reviewId));
					await retainedHold$1.release();
				}
				return postflightResultSubmission(state.labId, roleId, reviewId, existing.assignmentId);
			}
			const now = Date.now();
			const worker = state.roles[review.capability.workerRoleId];
			if (worker === void 0 || worker.sessionId !== review.capability.workerSessionId) throw new AutoLabRuntimeError(`Postflight review ${reviewId} lost its reviewed Coder identity`, "CONFIG_DRIFT");
			const completedPause = review.pause.freeze === "held" ? (() => {
				const { holdOwnerEpoch: _owner,...pause } = review.pause;
				return {
					...pause,
					freeze: "stopped"
				};
			})() : review.pause;
			const roles = structuredClone(state.roles);
			if (worker.phase === "reviewing") roles[review.capability.workerRoleId] = {
				...worker,
				phase: "paused"
			};
			const reviews = structuredClone(state.reviews);
			reviews[reviewId] = {
				...review,
				phase: "result_recorded",
				pause: completedPause,
				result: {
					path: artifactPath,
					hash: frozen.receiptHash,
					assignmentId: frozen.packet.header.assignment_id,
					reviewInputHash: frozen.expectedHashBinding,
					recordedAt: now
				},
				updatedAt: now
			};
			const recorded = await this.transition(state, state.lifecycle, void 0, void 0, roles, reviews);
			await this.wakeControllerForEvent(recorded, `postflight-result:${reviewId}:${frozen.receiptHash}`, postflightControllerEventText(state.labId, reviewId, artifactPath, frozen.receiptHash));
			const retainedHold = this.reviewHolds.get(reviewHoldKey(state.labId, reviewId));
			if (retainedHold !== void 0) {
				this.reviewHolds.delete(reviewHoldKey(state.labId, reviewId));
				await retainedHold.release();
			}
			return postflightResultSubmission(state.labId, roleId, reviewId, frozen.packet.header.assignment_id);
		});
	}
	/** Preserve one Controller-dispatched Ops/Coordinator receipt as opaque bytes. */
	async submitAutoLabRoleResult(caller, signal) {
		const labId = this.resolveExactRoleCaller(caller).state.labId;
		const prepared = await this.enqueue(labId, async () => {
			signal?.throwIfAborted();
			const { state, roleId } = this.resolveExactRoleCaller(caller);
			const projected = state.roles[roleId];
			const frozen = await this.artifacts.readCurrent(state.labId);
			if (state.lifecycle !== "running" || state.config === void 0 || !sameConfigRef(state.config, frozen.ref)) throw new AutoLabRuntimeError(`Lab ${state.labId} is not running on CURRENT`, "NOT_READY");
			const role = frozen.manifest.roles.find((value) => value.role_id === roleId);
			if (role === void 0 || role.role_kind === "controller" || role.role_kind !== "ops" && role.role_kind !== "coordinator") throw new AutoLabRuntimeError(`Role ${roleId} must use its dedicated submission protocol`, "ROLE_MISMATCH");
			const install = projected.goalInstall;
			if (projected.packet === void 0 || install?.status !== "applied") throw new AutoLabRuntimeError(`Role ${roleId} has no active Controller Assignment`, "IMPLEMENTATION_NOT_READY");
			if (projected.receipt !== void 0) {
				if (projected.phase !== "paused" || projected.receipt.assignmentId !== install.assignmentId) throw new AutoLabRuntimeError(`Role ${roleId} receipt does not match its active Assignment`, "CONFIG_DRIFT");
				return {
					completed: autoLabRoleResultSubmission(state.labId, roleId, install.assignmentId),
					receipt: projected.receipt
				};
			}
			if (projected.phase !== "working") throw new AutoLabRuntimeError(`Role ${roleId} is not working on a result-bearing Assignment`, "IMPLEMENTATION_NOT_READY");
			assertLiveAssignmentGoal(this.ctx, caller, projected, roleId, "AutoLab");
			return {
				labId: state.labId,
				roleId,
				sessionId: projected.sessionId,
				assignmentId: install.assignmentId,
				packet: projected.packet,
				goalInstall: install,
				config: state.config,
				artifactPath: join(frozen.manifest.authority_paths.lab_dir, "artifacts", "role-results", sha256(roleId), `${sha256(install.assignmentId)}.raw`)
			};
		});
		if ("completed" in prepared) {
			if (prepared.receipt === void 0) throw new AutoLabRuntimeError("recorded role result lost its receipt", "CONFIG_DRIFT");
			await this.finalizeRoleResultNotification(caller, prepared.completed, prepared.receipt.path, prepared.receipt.hash);
			return prepared.completed;
		}
		const frozenReceipt = await freezeRoleAssignmentReceipt({
			rolePacketPath: prepared.packet.path,
			rolePacketHash: prepared.packet.hash,
			artifactPath: prepared.artifactPath
		});
		signal?.throwIfAborted();
		if (frozenReceipt.assignmentId !== prepared.assignmentId || frozenReceipt.roleId !== prepared.roleId || frozenReceipt.sessionId !== prepared.sessionId || frozenReceipt.expectedHashBinding !== prepared.assignmentId) throw new AutoLabRuntimeError(`Role ${prepared.roleId} receipt does not match its exact Assignment Packet`, "CONFIG_DRIFT");
		const recorded = await this.enqueue(labId, async () => {
			signal?.throwIfAborted();
			const { state, roleId } = this.resolveExactRoleCaller(caller);
			const projected = state.roles[roleId];
			if (roleId !== prepared.roleId || canonicalJson$1(state.config) !== canonicalJson$1(prepared.config) || projected.phase !== "working" || canonicalJson$1(projected.packet) !== canonicalJson$1(prepared.packet) || canonicalJson$1(projected.goalInstall) !== canonicalJson$1(prepared.goalInstall) || projected.receipt !== void 0) throw new AutoLabRuntimeError(`Role ${prepared.roleId} Assignment changed while freezing its receipt`, "CONFIG_DRIFT");
			assertLiveAssignmentGoal(this.ctx, caller, projected, roleId, "AutoLab");
			const receipt = {
				assignmentId: prepared.assignmentId,
				path: prepared.artifactPath,
				hash: frozenReceipt.receiptHash,
				recordedAt: Date.now()
			};
			const roles = structuredClone(state.roles);
			roles[roleId] = {
				...projected,
				phase: "paused",
				receipt
			};
			await this.transition(state, state.lifecycle, void 0, void 0, roles);
			return receipt;
		});
		const result = autoLabRoleResultSubmission(labId, prepared.roleId, prepared.assignmentId);
		await this.finalizeRoleResultNotification(caller, result, recorded.path, recorded.hash);
		return result;
	}
	/**
	* Apply only the APPROVED Preflight route explicitly selected by Controller.
	* Runtime compiles and installs identities; it never compares methods or
	* chooses which verdict should advance.
	*/
	async applyPreflight(caller, input, signal) {
		const labId = validateLabId(input.labId);
		if (input.reviewId.trim().length === 0) throw new AutoLabRuntimeError("reviewId must be non-empty", "REVIEW_NOT_READY");
		const prepared = await this.enqueue(labId, async () => {
			signal?.throwIfAborted();
			let state = this.requireState(labId);
			this.assertControllerSession(caller, state);
			const review = state.reviews[input.reviewId];
			if (state.lifecycle !== "running" || state.config === void 0 || review?.stage !== "preflight" || review.verdict?.topLevelVerdict !== "APPROVED") throw new AutoLabRuntimeError(`Review ${input.reviewId} is not an APPROVED Preflight route in a running Lab`, "REVIEW_NOT_READY");
			const frozen = await this.artifacts.readCurrent(labId);
			if (!sameConfigRef(state.config, frozen.ref)) throw new AutoLabRuntimeError(`Lab ${labId} CURRENT does not match RuntimeState`, "CONFIG_DRIFT");
			const lane = frozen.manifest.lanes.find((value) => value.method_role_id === review.capability.workerRoleId && value.preflight_judge_role_id === review.capability.judgeRoleId);
			const coderRole = lane === void 0 ? void 0 : frozen.manifest.roles.find((value) => value.role_id === lane.coder_role_id);
			if (lane === void 0 || coderRole?.role_kind !== "coder") throw new AutoLabRuntimeError(`Review ${input.reviewId} does not resolve to one CURRENT Coder`, "CONFIG_DRIFT");
			const coder = state.roles[coderRole.role_id];
			if (coder?.binding === void 0 || coder.packet === void 0) throw new AutoLabRuntimeError(`Coder role ${coderRole.role_id} is not durably activated`, "ROLE_ACTIVATION_UNAVAILABLE");
			if (review.resolution !== void 0) {
				if (selectApprovedCoderReview(state, coderRole.role_id, coder)?.reviewId !== input.reviewId || coder.goalInstall?.status !== "applied") throw new AutoLabRuntimeError(`Review ${input.reviewId} resolution does not match its Coder Goal`, "CONFIG_DRIFT");
				return { completed: controllerApplyPreflightResult(state.labId, input.reviewId, coderRole.role_id) };
			}
			if (!reviewFreezeComplete(review, state.ownerEpoch)) throw new AutoLabRuntimeError(`Review ${input.reviewId} worker freeze is not complete`, "REVIEW_NOT_READY");
			const binding = await readRoleBinding(frozen.manifest.authority_paths.lab_dir, coderRole.role_id);
			if (binding === void 0 || binding.path !== coder.binding.path || binding.hash !== coder.binding.hash) throw new AutoLabRuntimeError(`Coder role ${coderRole.role_id} binding drifted`, "CONFIG_DRIFT");
			const expectedGoalRef = coder.goalInstall?.goalId === void 0 ? null : {
				id: GoalId(coder.goalInstall.goalId),
				revision: coder.goalInstall.goalRevision
			};
			let plan;
			if (coder.goalInstall?.status === "activating" && coder.goalInstall.assignmentId === `coder:${input.reviewId}`) {
				const restored = await restoreCurrentRoleArtifacts({
					frozen,
					role: coderRole,
					sessionId: coder.sessionId,
					binding,
					runtimeRevision: state.runtimeRevision,
					packetRef: coder.packet
				});
				plan = compileApprovedCoderActivation({
					reviewId: input.reviewId,
					verdictHash: review.verdict.hash,
					coderRoleId: coderRole.role_id,
					coderSessionId: coder.sessionId,
					assignmentId: restored.assignmentId,
					packetPath: restored.packetPath,
					packetHash: restored.packet.packetHash,
					objectiveBody: restored.objectiveBody,
					maxGoalRounds: coder.goalInstall.maxGoalRounds,
					expectedGoalRef,
					installId: coder.goalInstall.installId
				});
			} else plan = await freezeApprovedCoderActivation({
				artifacts: {
					frozen,
					coderRole,
					coderSessionId: coder.sessionId,
					coderBinding: binding,
					sourceMethodPacket: {
						path: review.sourcePacket.path,
						sha256: review.sourcePacket.hash
					},
					designTicket: {
						path: review.artifactPath,
						sha256: review.capability.artifactHash
					},
					preflightVerdict: {
						path: review.verdict.path,
						sha256: review.verdict.hash
					},
					reviewId: input.reviewId,
					runtimeRevision: state.runtimeRevision,
					issuedAt: review.verdict.recordedAt
				},
				maxGoalRounds: coderRole.max_goal_rounds,
				expectedGoalRef
			});
			const roles = structuredClone(state.roles);
			roles[coderRole.role_id] = stageApprovedCoderActivation(coder, plan);
			let candidates;
			let retiredCandidates;
			const existingCandidate = state.candidates[lane.lane_id];
			if (existingCandidate !== void 0 && existingCandidate.assignmentId !== plan.goalIntent.assignmentId) {
				candidates = { ...state.candidates };
				delete candidates[lane.lane_id];
				retiredCandidates = {
					...state.retiredCandidates,
					[existingCandidate.candidateId]: existingCandidate
				};
			}
			state = await this.transition(state, state.lifecycle, void 0, void 0, roles, void 0, candidates, void 0, void 0, void 0, retiredCandidates);
			return {
				plan,
				stagedRuntimeRevision: state.runtimeRevision,
				coderRoleId: coderRole.role_id,
				workerRoleId: review.capability.workerRoleId
			};
		});
		if ("completed" in prepared) return prepared.completed;
		const installed = await installApprovedCoderGoal(this.ctx, prepared.plan);
		signal?.throwIfAborted();
		const committed = await this.enqueue(labId, async () => {
			signal?.throwIfAborted();
			const state = this.requireState(labId);
			this.assertControllerSession(caller, state);
			if (state.runtimeRevision !== prepared.stagedRuntimeRevision) throw new AutoLabRuntimeError(`Lab ${labId} changed while installing its Coder Goal`, "CONFIG_DRIFT");
			const coder = state.roles[prepared.coderRoleId];
			const review = state.reviews[input.reviewId];
			const worker = state.roles[prepared.workerRoleId];
			if (coder === void 0 || review === void 0 || worker === void 0) throw new AutoLabRuntimeError("Preflight route lost its durable role identity", "CONFIG_DRIFT");
			const roles = structuredClone(state.roles);
			roles[prepared.coderRoleId] = applyApprovedCoderGoal(coder, prepared.plan, installed);
			roles[prepared.workerRoleId] = {
				...worker,
				phase: "paused"
			};
			const reviews = structuredClone(state.reviews);
			reviews[input.reviewId] = resolveApprovedCoderReview(review, state.ownerEpoch, prepared.plan, Date.now());
			return {
				state: await this.transition(state, state.lifecycle, void 0, void 0, roles, reviews),
				hold: this.reviewHolds.get(reviewHoldKey(labId, input.reviewId))
			};
		});
		if (committed.hold !== void 0) {
			this.reviewHolds.delete(reviewHoldKey(labId, input.reviewId));
			await committed.hold.release();
		}
		return controllerApplyPreflightResult(labId, input.reviewId, prepared.coderRoleId);
	}
	/** Install one explicit Method Assignment, optionally resolving one rejected Preflight review. */
	async assignMethod(caller, input, signal) {
		const labId = validateLabId(input.labId);
		if (input.methodRoleId.trim().length === 0 || input.assignmentId.trim().length === 0 || input.objective.trim().length === 0 || input.sourceReviewId !== void 0 && input.sourceReviewId.trim().length === 0) throw new AutoLabRuntimeError("methodRoleId, assignmentId, objective, and any sourceReviewId must be non-empty", "NOT_READY");
		const content = parseJsonArgument(input.contentJson, "contentJson");
		const inputArtifactRefs = parseRoleAssignmentReferences(input.inputArtifactRefsJson);
		const prepared = await this.enqueue(labId, async () => {
			signal?.throwIfAborted();
			let state = this.requireState(labId);
			this.assertControllerSession(caller, state);
			if (state.lifecycle !== "running" || state.config === void 0) throw new AutoLabRuntimeError(`Lab ${labId} is not running`, "NOT_READY");
			const frozen = await this.artifacts.readCurrent(labId);
			if (!sameConfigRef(state.config, frozen.ref)) throw new AutoLabRuntimeError(`Lab ${labId} CURRENT does not match RuntimeState`, "CONFIG_DRIFT");
			const role = frozen.manifest.roles.find((value) => value.role_id === input.methodRoleId);
			if (role?.role_kind !== "method") throw new AutoLabRuntimeError(`Role ${input.methodRoleId} is not a Method role in CURRENT`, "ROLE_MISMATCH");
			const projected = state.roles[input.methodRoleId];
			if (projected?.binding === void 0 || projected.packet === void 0 || projected.activationBlocker !== void 0) throw new AutoLabRuntimeError(`Method role ${input.methodRoleId} is not durably available`, "ROLE_ACTIVATION_UNAVAILABLE");
			assertRoleAssignmentMayDispatch(projected.goalInstall, input.assignmentId);
			const binding = await readRoleBinding(frozen.manifest.authority_paths.lab_dir, input.methodRoleId);
			if (binding === void 0 || binding.path !== projected.binding.path || binding.hash !== projected.binding.hash) throw new AutoLabRuntimeError(`Method role ${input.methodRoleId} binding drifted`, "CONFIG_DRIFT");
			const sourceReview = input.sourceReviewId === void 0 ? void 0 : requireMethodRevisionReview(state, input.sourceReviewId, input.methodRoleId, projected.sessionId);
			const sourceReviewVerdict = sourceReview === void 0 ? void 0 : {
				path: sourceReview.verdict.path,
				sha256: sourceReview.verdict.hash
			};
			if (projected.goalInstall?.assignmentId === input.assignmentId) {
				const restored = await restoreCurrentRoleArtifacts({
					frozen,
					role,
					sessionId: projected.sessionId,
					binding,
					runtimeRevision: state.runtimeRevision,
					packetRef: projected.packet
				});
				if (restored.assignmentId !== input.assignmentId || restored.objectiveBody !== input.objective) throw new AutoLabRuntimeError(`Method Assignment ${input.assignmentId} conflicts with its activating original`, "CONFIG_DRIFT");
				assertMethodAssignmentReplay(restored.packet.packet, {
					role,
					sessionId: projected.sessionId,
					assignmentId: input.assignmentId,
					objective: input.objective,
					content,
					inputArtifactRefs,
					...input.sourceReviewId === void 0 ? {} : {
						sourceReviewId: input.sourceReviewId,
						sourceReviewVerdict
					}
				});
				const install = projected.goalInstall;
				const intent$1 = compileLocalGoalIntent({
					installId: install.installId,
					assignmentId: install.assignmentId,
					packetPath: restored.packetPath,
					packetHash: restored.packet.packetHash,
					body: restored.objectiveBody,
					maxGoalRounds: install.maxGoalRounds,
					expectedGoalRef: install.goalId === void 0 ? null : {
						id: GoalId(install.goalId),
						revision: install.goalRevision
					}
				});
				if (intent$1.objectiveHash !== install.objectiveHash) throw new AutoLabRuntimeError(`Method Assignment ${input.assignmentId} activating Goal identity drifted`, "CONFIG_DRIFT");
				const resolution$1 = sourceReview === void 0 ? void 0 : compileReviewResolution({
					reviewId: input.sourceReviewId,
					verdictHash: sourceReview.verdict.hash,
					targetRoleId: input.methodRoleId,
					targetSessionId: projected.sessionId,
					effect: {
						kind: "goal_install",
						id: intent$1.installId,
						hash: intent$1.objectiveHash
					}
				});
				if (install.status === "applied") {
					if (resolution$1 !== void 0) {
						const reviews = structuredClone(state.reviews);
						const resolved = recordReviewResolution(sourceReview, state.ownerEpoch, resolution$1, Date.now());
						if (canonicalJson$1(resolved) !== canonicalJson$1(sourceReview)) {
							reviews[input.sourceReviewId] = resolved;
							state = await this.transition(state, state.lifecycle, void 0, void 0, void 0, reviews);
						}
					}
					return {
						completed: controllerAssignMethodResult(state.labId, input.methodRoleId, input.assignmentId, input.sourceReviewId),
						hold: input.sourceReviewId === void 0 ? void 0 : this.reviewHolds.get(reviewHoldKey(labId, input.sourceReviewId))
					};
				}
				if (sourceReview?.resolution !== void 0) throw new AutoLabRuntimeError(`Review ${input.sourceReviewId} records a resolution before its Method Goal is applied`, "CONFIG_DRIFT");
				return {
					roleId: input.methodRoleId,
					sessionId: projected.sessionId,
					packet: projected.packet,
					intent: intent$1,
					resolution: resolution$1,
					sourceReviewId: input.sourceReviewId,
					stagedRuntimeRevision: state.runtimeRevision
				};
			}
			if (sourceReview === void 0) {
				if (projected.phase !== "paused") throw new AutoLabRuntimeError(`Method role ${input.methodRoleId} is ${projected.phase}; the next independent Assignment requires paused`, "NOT_READY");
			} else if (projected.phase !== "reviewing" || sourceReview.resolution !== void 0 || sourceReview.sourcePacket.path !== projected.packet.path || sourceReview.sourcePacket.hash !== projected.packet.hash || sourceReview.capability.assignmentId !== projected.goalInstall?.assignmentId) throw new AutoLabRuntimeError(`Review ${input.sourceReviewId} is not the unresolved current Method responsibility`, "REVIEW_NOT_READY");
			const live = this.ctx.agents.get(SessionId(projected.sessionId));
			if (live === void 0) throw new AutoLabRuntimeError(`Method Session ${projected.sessionId} is not live`, "ROLE_ACTIVATION_UNAVAILABLE");
			const currentGoal = this.ctx.goals.get(live);
			if (currentGoal !== void 0 && !roleOwnsExactAssignmentGoal(projected, currentGoal)) throw new AutoLabRuntimeError(`Method role ${input.methodRoleId} has another live Goal`, "REVIEW_NOT_READY");
			const plannedRevision = state.runtimeRevision + 1;
			const artifacts = await freezeMethodAssignment({
				frozen,
				role,
				sessionId: projected.sessionId,
				binding,
				currentPacket: projected.packet,
				currentRevealState: state.revealState ?? frozen.manifest.communication.reveal_policy.initial_state,
				assignmentId: input.assignmentId,
				objective: input.objective,
				content,
				inputArtifactRefs,
				...input.sourceReviewId === void 0 ? {} : {
					sourceReviewId: input.sourceReviewId,
					sourceReviewVerdict
				},
				runtimeRevision: plannedRevision,
				issuedAt: state.updatedAt
			});
			const intent = compileLocalGoalIntent({
				installId: `${input.assignmentId}:install:1`,
				assignmentId: input.assignmentId,
				packetPath: artifacts.packetPath,
				packetHash: artifacts.packet.packetHash,
				body: artifacts.objectiveBody,
				maxGoalRounds: roleGoalRoundLimit(role),
				expectedGoalRef: currentGoal === void 0 ? null : {
					id: currentGoal.id,
					revision: currentGoal.revision
				}
			});
			const resolution = sourceReview === void 0 ? void 0 : compileReviewResolution({
				reviewId: input.sourceReviewId,
				verdictHash: sourceReview.verdict.hash,
				targetRoleId: input.methodRoleId,
				targetSessionId: projected.sessionId,
				effect: {
					kind: "goal_install",
					id: intent.installId,
					hash: intent.objectiveHash
				}
			});
			const roles = structuredClone(state.roles);
			const { receipt: _oldReceipt, activationBlocker: _oldBlocker,...base } = projected;
			roles[input.methodRoleId] = {
				...base,
				packet: {
					path: artifacts.packetPath,
					hash: artifacts.packet.packetHash
				},
				goalInstall: {
					installId: intent.installId,
					assignmentId: intent.assignmentId,
					objectiveHash: intent.objectiveHash,
					maxGoalRounds: intent.maxGoalRounds,
					status: "activating",
					...intent.expectedGoalRef === null ? {} : {
						goalId: String(intent.expectedGoalRef.id),
						goalRevision: intent.expectedGoalRef.revision
					}
				}
			};
			state = await this.transition(state, state.lifecycle, void 0, void 0, roles);
			return {
				roleId: input.methodRoleId,
				sessionId: projected.sessionId,
				packet: roles[input.methodRoleId].packet,
				intent,
				resolution,
				sourceReviewId: input.sourceReviewId,
				stagedRuntimeRevision: state.runtimeRevision
			};
		});
		if ("completed" in prepared) {
			if (prepared.hold !== void 0 && input.sourceReviewId !== void 0) {
				this.reviewHolds.delete(reviewHoldKey(labId, input.sourceReviewId));
				await prepared.hold.release();
			}
			return prepared.completed;
		}
		const installed = await installLocalGoal(this.ctx, prepared.sessionId, prepared.intent);
		if (installed.outcome === "already-complete") throw new AutoLabRuntimeError(`Method Assignment ${input.assignmentId} Goal is already complete and cannot be reinstalled`, "NOT_READY");
		signal?.throwIfAborted();
		const committed = await this.enqueue(labId, async () => {
			signal?.throwIfAborted();
			const state = this.requireState(labId);
			this.assertControllerSession(caller, state);
			const projected = state.roles[prepared.roleId];
			const install = projected?.goalInstall;
			if (state.runtimeRevision !== prepared.stagedRuntimeRevision || projected === void 0 || projected.packet?.path !== prepared.packet.path || projected.packet.hash !== prepared.packet.hash || install?.status !== "activating" || install.installId !== prepared.intent.installId || install.assignmentId !== prepared.intent.assignmentId || install.objectiveHash !== prepared.intent.objectiveHash || installed.objectiveHash !== prepared.intent.objectiveHash) throw new AutoLabRuntimeError(`Method Assignment ${input.assignmentId} changed during Goal installation`, "CONFIG_DRIFT");
			const roles = structuredClone(state.roles);
			roles[prepared.roleId] = {
				...projected,
				phase: "working",
				goalInstall: {
					...install,
					status: "applied",
					goalId: String(installed.ref.id),
					goalRevision: installed.ref.revision
				}
			};
			let reviews;
			if (prepared.resolution !== void 0 && prepared.sourceReviewId !== void 0) {
				const review = requireMethodRevisionReview(state, prepared.sourceReviewId, prepared.roleId, prepared.sessionId);
				reviews = structuredClone(state.reviews);
				reviews[prepared.sourceReviewId] = recordReviewResolution(review, state.ownerEpoch, prepared.resolution, Date.now());
			}
			return {
				result: controllerAssignMethodResult((await this.transition(state, state.lifecycle, void 0, void 0, roles, reviews)).labId, prepared.roleId, prepared.intent.assignmentId, prepared.sourceReviewId),
				hold: prepared.sourceReviewId === void 0 ? void 0 : this.reviewHolds.get(reviewHoldKey(labId, prepared.sourceReviewId))
			};
		});
		if (committed.hold !== void 0 && prepared.sourceReviewId !== void 0) {
			this.reviewHolds.delete(reviewHoldKey(labId, prepared.sourceReviewId));
			await committed.hold.release();
		}
		return committed.result;
	}
	/**
	* Install one Controller-authored Coder implementation-fix Assignment on a
	* paused Coder that owns the Lane's active candidate. The fix inherits the
	* candidate's lineage Preflight review (design ticket + verdict) as its
	* provenance, supersedes the active candidate, and lets the Coder freeze a
	* corrected candidate through the ordinary SubmitCoderImplementation path.
	* No Preflight review is fabricated and no scientific routing happens here:
	* the fix is an implementation continuation of the already-APPROVED design.
	*/
	async assignCoderFix(caller, input, signal) {
		const labId = validateLabId(input.labId);
		const fix = parseCoderFixAssignmentId(input.assignmentId);
		if (input.coderRoleId.trim().length === 0 || input.objective.trim().length === 0) throw new AutoLabRuntimeError("coderRoleId, assignmentId, and objective must be non-empty", "NOT_READY");
		const content = parseJsonArgument(input.contentJson, "contentJson");
		const inputArtifactRefs = parseRoleAssignmentReferences(input.inputArtifactRefsJson);
		const candidateId = extractFixCandidateId(content, input.assignmentId);
		const prepared = await this.enqueue(labId, async () => {
			signal?.throwIfAborted();
			let state = this.requireState(labId);
			this.assertControllerSession(caller, state);
			if (state.lifecycle !== "running" || state.config === void 0) throw new AutoLabRuntimeError(`Lab ${labId} is not running`, "NOT_READY");
			const frozen = await this.artifacts.readCurrent(labId);
			if (!sameConfigRef(state.config, frozen.ref)) throw new AutoLabRuntimeError(`Lab ${labId} CURRENT does not match RuntimeState`, "CONFIG_DRIFT");
			const role = frozen.manifest.roles.find((value) => value.role_id === input.coderRoleId);
			if (role?.role_kind !== "coder") throw new AutoLabRuntimeError(`Role ${input.coderRoleId} is not a Coder role in CURRENT`, "ROLE_MISMATCH");
			const projected = state.roles[input.coderRoleId];
			if (projected?.binding === void 0 || projected.packet === void 0 || projected.activationBlocker !== void 0 || projected.goalInstall?.status !== "applied") throw new AutoLabRuntimeError(`Coder role ${input.coderRoleId} is not durably available with an applied Assignment`, "ROLE_ACTIVATION_UNAVAILABLE");
			if (projected.phase !== "paused") throw new AutoLabRuntimeError(`Coder role ${input.coderRoleId} is ${projected.phase}; an implementation-fix Assignment requires paused`, "IMPLEMENTATION_NOT_READY");
			assertRoleAssignmentMayDispatch(projected.goalInstall, input.assignmentId);
			const lane = frozen.manifest.lanes.find((value) => value.lane_id === role.lane_id && value.coder_role_id === input.coderRoleId);
			if (lane === void 0) throw new AutoLabRuntimeError(`Coder role ${input.coderRoleId} does not resolve to one CURRENT Lane`, "CONFIG_DRIFT");
			const lineage = state.reviews[fix.reviewId];
			if (lineage?.stage !== "preflight" || lineage.verdict?.topLevelVerdict !== "APPROVED" || lineage.resolution?.targetRoleId !== input.coderRoleId || lineage.resolution.targetSessionId !== projected.sessionId || lineage.resolution.effect.kind !== "goal_install" || lineage.resolution.effect.id !== `coder:${fix.reviewId}:install:1`) throw new AutoLabRuntimeError(`Fix Assignment ${JSON.stringify(input.assignmentId)} lineage review is not the exact applied APPROVED Preflight review of Coder ${input.coderRoleId}`, "REVIEW_NOT_READY");
			const candidate = state.candidates[lane.lane_id];
			if (candidate === void 0 || candidate.reviewId !== fix.reviewId || candidate.assignmentId !== `coder:${fix.reviewId}`) throw new AutoLabRuntimeError(`Fix Assignment ${JSON.stringify(input.assignmentId)} requires the Lane's active candidate frozen under review ${fix.reviewId}`, "IMPLEMENTATION_NOT_READY");
			const binding = await readRoleBinding(frozen.manifest.authority_paths.lab_dir, input.coderRoleId);
			if (binding === void 0 || binding.path !== projected.binding.path || binding.hash !== projected.binding.hash) throw new AutoLabRuntimeError(`Coder role ${input.coderRoleId} binding drifted`, "CONFIG_DRIFT");
			const artifacts = await freezeCoderFixAssignment({
				frozen,
				coderRole: role,
				coderSessionId: projected.sessionId,
				coderBinding: binding,
				currentPacket: {
					path: projected.packet.path,
					hash: projected.packet.hash
				},
				assignmentId: input.assignmentId,
				reviewId: fix.reviewId,
				objective: input.objective,
				content,
				candidateId,
				inputArtifactRefs,
				sourceMethodPacket: {
					path: lineage.sourcePacket.path,
					sha256: lineage.sourcePacket.hash
				},
				designTicket: {
					path: lineage.artifactPath,
					sha256: lineage.capability.artifactHash
				},
				preflightVerdict: {
					path: lineage.verdict.path,
					sha256: lineage.verdict.hash
				},
				runtimeRevision: state.runtimeRevision,
				issuedAt: Date.now()
			});
			const intent = compileLocalGoalIntent({
				installId: `${input.assignmentId}:install:1`,
				assignmentId: input.assignmentId,
				packetPath: artifacts.packetPath,
				packetHash: artifacts.packet.packetHash,
				body: artifacts.objectiveBody,
				maxGoalRounds: role.max_goal_rounds,
				expectedGoalRef: projected.goalInstall?.goalId === void 0 ? currentLiveGoalRef(this.ctx, projected.sessionId) : {
					id: GoalId(projected.goalInstall.goalId),
					revision: projected.goalInstall.goalRevision
				}
			});
			const roles = structuredClone(state.roles);
			roles[input.coderRoleId] = roleStateSchema.parse({
				...projected,
				packet: {
					path: artifacts.packetPath,
					hash: artifacts.packet.packetHash
				},
				goalInstall: {
					installId: intent.installId,
					assignmentId: intent.assignmentId,
					objectiveHash: intent.objectiveHash,
					maxGoalRounds: intent.maxGoalRounds,
					status: "activating"
				}
			});
			const candidates = { ...state.candidates };
			delete candidates[lane.lane_id];
			const retiredCandidates = {
				...state.retiredCandidates,
				[candidate.candidateId]: candidate
			};
			state = await this.transition(state, state.lifecycle, void 0, void 0, roles, void 0, candidates, void 0, void 0, void 0, retiredCandidates);
			return {
				roleId: input.coderRoleId,
				sessionId: projected.sessionId,
				intent,
				packet: {
					path: artifacts.packetPath,
					hash: artifacts.packet.packetHash
				},
				stagedRuntimeRevision: state.runtimeRevision
			};
		});
		const installed = await installLocalGoal(this.ctx, prepared.sessionId, prepared.intent);
		signal?.throwIfAborted();
		return await this.enqueue(labId, async () => {
			signal?.throwIfAborted();
			const state = this.requireState(labId);
			this.assertControllerSession(caller, state);
			const projected = state.roles[prepared.roleId];
			const install = projected?.goalInstall;
			if (state.runtimeRevision !== prepared.stagedRuntimeRevision || projected === void 0 || projected.packet?.path !== prepared.packet.path || projected.packet.hash !== prepared.packet.hash || install?.status !== "activating" || install.installId !== prepared.intent.installId || install.assignmentId !== prepared.intent.assignmentId || install.objectiveHash !== prepared.intent.objectiveHash || installed.objectiveHash !== prepared.intent.objectiveHash) throw new AutoLabRuntimeError(`Coder fix Assignment ${input.assignmentId} changed during Goal installation`, "CONFIG_DRIFT");
			const roles = structuredClone(state.roles);
			roles[prepared.roleId] = {
				...projected,
				phase: "working",
				goalInstall: {
					...install,
					status: "applied",
					goalId: String(installed.ref.id),
					goalRevision: installed.ref.revision
				}
			};
			return controllerAssignCoderFixResult((await this.transition(state, state.lifecycle, void 0, void 0, roles)).labId, prepared.roleId, prepared.intent.assignmentId, fix.reviewId);
		});
	}
	/** Register one user decision as an immutable fact in the Lab fact set. */
	async registerUserDirective(caller, input, signal) {
		const labId = validateLabId(input.labId);
		return await this.enqueue(labId, async () => {
			signal?.throwIfAborted();
			const state = this.requireState(labId);
			this.assertControllerSession(caller, state);
			if (state.lifecycle !== "running" || state.config === void 0) throw new AutoLabRuntimeError(`Lab ${labId} is not running`, "NOT_READY");
			const frozen = await this.artifacts.readCurrent(labId);
			if (!sameConfigRef(state.config, frozen.ref)) throw new AutoLabRuntimeError(`Lab ${labId} CURRENT does not match RuntimeState`, "CONFIG_DRIFT");
			const result = await registerFact({
				factPath: frozen.manifest.authority_paths.fact_set,
				factId: input.factId,
				kind: input.kind,
				statement: input.statement,
				source: input.source,
				evidenceStatus: input.evidenceStatus,
				registeredBy: `controller:${state.controllerSessionId}`,
				registeredAt: Date.now()
			});
			return {
				labId,
				factPath: result.factPath,
				factSetSha256: result.factSetSha256,
				factIndex: result.factIndex,
				runtimeRevision: state.runtimeRevision
			};
		});
	}
	/** Install exactly one Controller-authored Ops/Coordinator Assignment. */
	async assignRole(caller, input, signal) {
		const labId = validateLabId(input.labId);
		if (input.roleId.trim().length === 0 || input.assignmentId.trim().length === 0 || input.objective.trim().length === 0) throw new AutoLabRuntimeError("roleId, assignmentId, and objective must be non-empty", "NOT_READY");
		const content = parseJsonArgument(input.contentJson, "contentJson");
		const outputSchema = parseJsonArgument(input.outputSchemaJson, "outputSchemaJson");
		const inputArtifactRefs = parseRoleAssignmentReferences(input.inputArtifactRefsJson);
		const prepared = await this.enqueue(labId, async () => {
			signal?.throwIfAborted();
			let state = this.requireState(labId);
			this.assertControllerSession(caller, state);
			if (state.lifecycle !== "running" || state.config === void 0) throw new AutoLabRuntimeError(`Lab ${labId} is not running`, "NOT_READY");
			const frozen = await this.artifacts.readCurrent(labId);
			if (!sameConfigRef(state.config, frozen.ref)) throw new AutoLabRuntimeError(`Lab ${labId} CURRENT does not match RuntimeState`, "CONFIG_DRIFT");
			const role = frozen.manifest.roles.find((value) => value.role_id === input.roleId);
			if (role === void 0 || role.role_kind === "controller" || role.role_kind !== "ops" && role.role_kind !== "coordinator") throw new AutoLabRuntimeError(`Role ${input.roleId} cannot receive a Controller Role Assignment`, "ROLE_MISMATCH");
			const projected = state.roles[input.roleId];
			if (projected?.binding === void 0 || projected.packet === void 0 || projected.activationBlocker !== void 0) throw new AutoLabRuntimeError(`Role ${input.roleId} is not durably available`, "ROLE_ACTIVATION_UNAVAILABLE");
			assertRoleAssignmentMayDispatch(projected.goalInstall, input.assignmentId);
			if (projected.goalInstall?.assignmentId === input.assignmentId) {
				const binding$1 = await readRoleBinding(frozen.manifest.authority_paths.lab_dir, input.roleId);
				if (binding$1 === void 0 || binding$1.path !== projected.binding.path || binding$1.hash !== projected.binding.hash) throw new AutoLabRuntimeError(`Role ${input.roleId} binding drifted`, "CONFIG_DRIFT");
				const restored = await restoreCurrentRoleArtifacts({
					frozen,
					role,
					sessionId: projected.sessionId,
					binding: binding$1,
					runtimeRevision: state.runtimeRevision,
					packetRef: projected.packet
				});
				if (restored.assignmentId !== input.assignmentId || restored.objectiveBody !== input.objective) throw new AutoLabRuntimeError(`Assignment ${input.assignmentId} conflicts with its activating original`, "CONFIG_DRIFT");
				assertRoleAssignmentReplay(restored.packet.packet, {
					role,
					sessionId: projected.sessionId,
					assignmentId: input.assignmentId,
					objective: input.objective,
					content,
					outputSchema,
					inputArtifactRefs
				});
				if (projected.goalInstall.status === "applied") return { completed: controllerAssignRoleResult(state.labId, input.roleId, input.assignmentId, projected.receipt?.assignmentId === input.assignmentId ? "receipt_recorded" : "working") };
				const install = projected.goalInstall;
				const intent$1 = compileLocalGoalIntent({
					installId: install.installId,
					assignmentId: install.assignmentId,
					packetPath: restored.packetPath,
					packetHash: restored.packet.packetHash,
					body: restored.objectiveBody,
					maxGoalRounds: install.maxGoalRounds,
					expectedGoalRef: install.goalId === void 0 ? null : {
						id: GoalId(install.goalId),
						revision: install.goalRevision
					}
				});
				if (intent$1.objectiveHash !== install.objectiveHash) throw new AutoLabRuntimeError(`Assignment ${input.assignmentId} activating Goal identity drifted`, "CONFIG_DRIFT");
				return {
					roleId: input.roleId,
					sessionId: projected.sessionId,
					packet: projected.packet,
					intent: intent$1,
					stagedRuntimeRevision: state.runtimeRevision
				};
			}
			if (projected.phase !== "declared" && projected.phase !== "paused") throw new AutoLabRuntimeError(`Role ${input.roleId} is ${projected.phase}; finish or pause its current responsibility first`, "NOT_READY");
			const binding = await readRoleBinding(frozen.manifest.authority_paths.lab_dir, input.roleId);
			if (binding === void 0 || binding.path !== projected.binding.path || binding.hash !== projected.binding.hash) throw new AutoLabRuntimeError(`Role ${input.roleId} binding drifted`, "CONFIG_DRIFT");
			const live = this.ctx.agents.get(SessionId(projected.sessionId));
			if (live === void 0) throw new AutoLabRuntimeError(`Role Session ${projected.sessionId} is not live`, "ROLE_ACTIVATION_UNAVAILABLE");
			const currentGoal = this.ctx.goals.get(live);
			if (currentGoal !== void 0 && (projected.goalInstall === void 0 || String(currentGoal.id) !== projected.goalInstall.goalId || sha256(currentGoal.objective) !== projected.goalInstall.objectiveHash)) throw new AutoLabRuntimeError(`Role ${input.roleId} has another live Goal`, "REVIEW_NOT_READY");
			const plannedRevision = state.runtimeRevision + 1;
			const artifacts = await freezeRoleAssignment({
				frozen,
				role,
				sessionId: projected.sessionId,
				binding,
				currentPacket: projected.packet,
				currentRevealState: state.revealState ?? frozen.manifest.communication.reveal_policy.initial_state,
				assignmentId: input.assignmentId,
				objective: input.objective,
				content,
				outputSchema,
				inputArtifactRefs,
				runtimeRevision: plannedRevision,
				issuedAt: state.updatedAt
			});
			const intent = compileLocalGoalIntent({
				installId: `${input.assignmentId}:install:1`,
				assignmentId: input.assignmentId,
				packetPath: artifacts.packetPath,
				packetHash: artifacts.packet.packetHash,
				body: artifacts.objectiveBody,
				maxGoalRounds: roleGoalRoundLimit(role),
				expectedGoalRef: currentGoal === void 0 ? null : {
					id: currentGoal.id,
					revision: currentGoal.revision
				}
			});
			const roles = structuredClone(state.roles);
			const { receipt: _oldReceipt, activationBlocker: _oldBlocker,...base } = projected;
			roles[input.roleId] = {
				...base,
				packet: {
					path: artifacts.packetPath,
					hash: artifacts.packet.packetHash
				},
				goalInstall: {
					installId: intent.installId,
					assignmentId: intent.assignmentId,
					objectiveHash: intent.objectiveHash,
					maxGoalRounds: intent.maxGoalRounds,
					status: "activating",
					...intent.expectedGoalRef === null ? {} : {
						goalId: String(intent.expectedGoalRef.id),
						goalRevision: intent.expectedGoalRef.revision
					}
				}
			};
			state = await this.transition(state, state.lifecycle, void 0, void 0, roles);
			return {
				roleId: input.roleId,
				sessionId: projected.sessionId,
				packet: roles[input.roleId].packet,
				intent,
				stagedRuntimeRevision: state.runtimeRevision
			};
		});
		if ("completed" in prepared) return prepared.completed;
		const installed = await installLocalGoal(this.ctx, prepared.sessionId, prepared.intent);
		if (installed.outcome === "already-complete") throw new AutoLabRuntimeError(`Assignment ${input.assignmentId} Goal is already complete and requires its receipt`, "NOT_READY");
		signal?.throwIfAborted();
		return await this.enqueue(labId, async () => {
			signal?.throwIfAborted();
			const state = this.requireState(labId);
			this.assertControllerSession(caller, state);
			const projected = state.roles[prepared.roleId];
			const install = projected?.goalInstall;
			if (state.runtimeRevision !== prepared.stagedRuntimeRevision || projected === void 0 || projected.packet?.path !== prepared.packet.path || projected.packet.hash !== prepared.packet.hash || install?.status !== "activating" || install.installId !== prepared.intent.installId || install.assignmentId !== prepared.intent.assignmentId || install.objectiveHash !== prepared.intent.objectiveHash || installed.objectiveHash !== prepared.intent.objectiveHash) throw new AutoLabRuntimeError(`Assignment ${input.assignmentId} changed during Goal installation`, "CONFIG_DRIFT");
			const roles = structuredClone(state.roles);
			roles[prepared.roleId] = {
				...projected,
				phase: "working",
				goalInstall: {
					...install,
					status: "applied",
					goalId: String(installed.ref.id),
					goalRevision: installed.ref.revision
				}
			};
			await this.transition(state, state.lifecycle, void 0, void 0, roles);
			return controllerAssignRoleResult(state.labId, prepared.roleId, prepared.intent.assignmentId, "working");
		});
	}
	/**
	* Validate the current Coder report, freeze the Lane bytes, and compile the
	* trusted implementation receipt. Every target and path comes from the
	* exact caller, CURRENT, Role Packet, and applied APPROVED review.
	*/
	async submitCoderImplementation(caller, signal) {
		const labId = this.resolveExactRoleCaller(caller).state.labId;
		let prepared;
		try {
			prepared = await this.enqueue(labId, async () => await this.prepareCoderSubmission(caller, signal));
		} catch (error) {
			rethrowCoderBoundary(error, "reconcile");
		}
		if (!("input" in prepared)) return prepared;
		let submission;
		try {
			submission = await freezeApprovedCoderSubmission(prepared.input);
			signal?.throwIfAborted();
		} catch (error) {
			rethrowCoderBoundary(error, "capture");
		}
		let result;
		try {
			result = await this.enqueue(labId, async () => await this.commitCoderSubmission(caller, prepared, submission, signal));
		} catch (error) {
			rethrowCoderBoundary(error, "reconcile");
		}
		return result;
	}
	/**
	* Materialize one Controller-selected Trial/RunSlot and publish its first
	* active Attempt. All scientific JSON stays opaque; Candidate and CURRENT
	* identities are derived from the exact durable Lab projection.
	*/
	async launchAttempt(caller, input, signal) {
		this.assertReady();
		signal?.throwIfAborted();
		const labId = validateLabId(input.labId);
		const snapshot = this.requireState(labId);
		this.assertControllerSession(caller, snapshot);
		if (snapshot.lifecycle !== "running" || snapshot.config === void 0) throw new AutoLabRuntimeError(`Lab ${labId} is not running`, "NOT_READY");
		const candidate = snapshot.candidates[input.laneId];
		if (candidate === void 0) throw new AutoLabRuntimeError(`Lane ${input.laneId} has no frozen active Candidate`, "IMPLEMENTATION_NOT_READY");
		const frozen = await this.artifacts.readCurrent(labId);
		if (!sameConfigRef(snapshot.config, frozen.ref)) throw new AutoLabRuntimeError(`Lab ${labId} CURRENT does not match RuntimeState`, "CONFIG_DRIFT");
		const parsed = parseControllerAttemptInput(input);
		const poke = this.attemptPoke;
		if (poke === void 0) throw new AutoLabRuntimeError("Attempt event endpoint is unavailable", "SERVICE_CLOSED");
		const prepared = await prepareInitialLocalAttempt({
			frozen,
			candidate,
			laneId: input.laneId,
			trialId: input.trialId,
			trialContract: parsed.trialContract,
			runSlots: parsed.runSlots,
			selectedRunSlotId: input.selectedRunSlotId,
			hostId: input.hostId,
			command: parsed.command,
			env: parsed.env,
			runtimePokeFile: poke.pointerPath,
			anchoredAt: candidate.frozenAt
		});
		signal?.throwIfAborted();
		await this.enqueue(labId, async () => {
			signal?.throwIfAborted();
			const state = this.requireState(labId);
			this.assertControllerSession(caller, state);
			const currentCandidate = state.candidates[input.laneId];
			if (state.lifecycle !== "running" || !sameConfigRef(state.config, frozen.ref) || canonicalJson$1(currentCandidate ?? null) !== canonicalJson$1(candidate)) throw new AutoLabRuntimeError(`Lane ${input.laneId} changed while preparing Trial ${input.trialId}`, "CONFIG_DRIFT");
			const existing = state.trials[input.trialId];
			if (existing !== void 0) {
				if (canonicalJson$1(existing) !== canonicalJson$1(prepared.projection)) throw new AutoLabRuntimeError(`Trial ${input.trialId} already has another frozen identity`, "CONFIG_DRIFT");
				return;
			}
			const trials = structuredClone(state.trials);
			trials[input.trialId] = prepared.projection;
			await this.transition(state, state.lifecycle, void 0, void 0, void 0, void 0, void 0, trials);
		});
		const target = {
			labId,
			trialId: input.trialId,
			runSlotId: input.selectedRunSlotId
		};
		await this.requireAttemptRuntime().dispatch(target, "poke");
		return attemptLaunchResult(this.requireState(labId), target);
	}
	/** Create one explicit technical retry without changing Trial/RunSlot lineage. */
	async retryAttempt(caller, input, signal) {
		this.assertReady();
		signal?.throwIfAborted();
		const labId = validateLabId(input.labId);
		if (input.trialId.trim().length === 0 || input.runSlotId.trim().length === 0) throw new AutoLabRuntimeError("trialId and runSlotId must be non-empty", "NOT_READY");
		const parsed = parseRetryAttemptInput(input);
		const snapshot = this.requireState(labId);
		this.assertControllerSession(caller, snapshot);
		if (snapshot.lifecycle !== "running" || snapshot.config === void 0) throw new AutoLabRuntimeError(`Lab ${labId} is not running`, "NOT_READY");
		const trial = snapshot.trials[input.trialId];
		const slot = trial?.runSlots[input.runSlotId];
		if (trial === void 0 || slot?.activeAttempt === void 0) throw new AutoLabRuntimeError(`Trial ${input.trialId} RunSlot ${input.runSlotId} has no active Attempt lineage`, "NOT_READY");
		const replayingActiveRetry = slot.state.status === "attempt_active" || slot.state.status === "outcome_unknown";
		if (!replayingActiveRetry && slot.state.status !== "retryable") throw new AutoLabRuntimeError(`Trial ${input.trialId} RunSlot ${input.runSlotId} is not a failed technical retry point`, "NOT_READY");
		const target = {
			labId,
			trialId: input.trialId,
			runSlotId: input.runSlotId
		};
		const frozen = await this.artifacts.readCurrent(labId);
		if (!sameConfigRef(snapshot.config, frozen.ref)) throw new AutoLabRuntimeError(`Lab ${labId} CURRENT does not match RuntimeState`, "CONFIG_DRIFT");
		const poke = this.attemptPoke;
		if (poke === void 0) throw new AutoLabRuntimeError("Attempt event endpoint is unavailable", "SERVICE_CLOSED");
		if (replayingActiveRetry) {
			await verifyRetryLocalAttemptReplay({
				frozen,
				trialId: input.trialId,
				trial,
				runSlotId: input.runSlotId,
				hostId: input.hostId,
				command: parsed.command,
				env: parsed.env
			});
			signal?.throwIfAborted();
			await this.requireAttemptRuntime().dispatch(target, "poke");
			return attemptLaunchResult(this.requireState(labId), target);
		}
		const prepared = await prepareRetryLocalAttempt({
			frozen,
			trialId: input.trialId,
			trial,
			runSlotId: input.runSlotId,
			hostId: input.hostId,
			command: parsed.command,
			env: parsed.env,
			runtimePokeFile: poke.pointerPath
		});
		signal?.throwIfAborted();
		await this.enqueue(labId, async () => {
			signal?.throwIfAborted();
			const state = this.requireState(labId);
			this.assertControllerSession(caller, state);
			const current = state.trials[input.trialId];
			if (state.lifecycle !== "running" || !sameConfigRef(state.config, frozen.ref)) throw new AutoLabRuntimeError(`Trial ${input.trialId} changed while preparing its technical retry`, "CONFIG_DRIFT");
			const publishedAttemptId = current?.runSlots[input.runSlotId]?.activeAttempt?.attemptId;
			if (canonicalJson$1(current ?? null) === canonicalJson$1(prepared.projection) || publishedAttemptId === prepared.intent.attempt.value.attempt_id) return;
			if (canonicalJson$1(current ?? null) !== canonicalJson$1(trial)) throw new AutoLabRuntimeError(`Trial ${input.trialId} changed while preparing its technical retry`, "CONFIG_DRIFT");
			const trials = structuredClone(state.trials);
			trials[input.trialId] = prepared.projection;
			await this.transition(state, state.lifecycle, void 0, void 0, void 0, void 0, void 0, trials);
		});
		await this.requireAttemptRuntime().dispatch(target, "poke");
		return attemptLaunchResult(this.requireState(labId), target);
	}
	/**
	* Bind one Controller-selected Attempt to its Lane Coder and Postflight
	* Judge. Runtime freezes only small immutable references and the review
	* handshake; the Judge owns every scientific read and decision.
	*/
	requestPostflight(caller, input, signal) {
		const labId = validateLabId(input.labId);
		if (input.trialId.trim().length === 0 || input.runSlotId.trim().length === 0) throw new AutoLabRuntimeError("trialId and runSlotId must be non-empty", "REVIEW_NOT_READY");
		return this.enqueue(labId, async () => {
			signal?.throwIfAborted();
			let state = this.requireState(labId);
			this.assertControllerSession(caller, state);
			if (state.lifecycle !== "running" || state.config === void 0) throw new AutoLabRuntimeError(`Lab ${labId} is not running`, "NOT_READY");
			const trial = state.trials[input.trialId];
			const runSlot = trial?.runSlots[input.runSlotId];
			const attempt = runSlot?.activeAttempt;
			if (trial === void 0 || runSlot === void 0 || attempt === void 0 || attempt.phase !== "terminal" && attempt.phase !== "outcome_unknown") throw new AutoLabRuntimeError(`Trial ${input.trialId} RunSlot ${input.runSlotId} has no finished or outcome-unknown Attempt`, "REVIEW_NOT_READY");
			const frozen = await this.artifacts.readCurrent(labId);
			if (!sameConfigRef(state.config, frozen.ref) || trial.sourceRevision > frozen.ref.revision) throw new AutoLabRuntimeError(`Lab ${labId} CURRENT does not match the Trial`, "CONFIG_DRIFT");
			const lane = frozen.manifest.lanes.find((value) => value.lane_id === trial.laneId);
			const activeCandidate = state.candidates[trial.laneId];
			const retiredCandidate = state.retiredCandidates[trial.candidateId];
			const candidate = activeCandidate !== void 0 && trial.candidateId === activeCandidate.candidateId && trial.candidateSha === activeCandidate.candidateSha ? activeCandidate : retiredCandidate !== void 0 && trial.candidateId === retiredCandidate.candidateId && trial.candidateSha === retiredCandidate.candidateSha ? retiredCandidate : void 0;
			if (lane === void 0 || candidate === void 0 || candidate.coderRoleId !== lane.coder_role_id || candidate.sourceReport === void 0 || candidate.reviewId === void 0) throw new AutoLabRuntimeError(`Trial ${input.trialId} does not resolve to its exact Coder and Preflight originals`, "CONFIG_DRIFT");
			const coder = state.roles[lane.coder_role_id];
			const judge = state.roles[lane.postflight_judge_role_id];
			if (coder?.packet === void 0 || coder.binding === void 0 || judge?.packet === void 0 || judge.binding === void 0 || coder.activationBlocker !== void 0 || judge.activationBlocker !== void 0) throw new AutoLabRuntimeError(`Lane ${lane.lane_id} Coder or Postflight Judge is unavailable`, "ROLE_ACTIVATION_UNAVAILABLE");
			const candidateIsRetired = candidate === retiredCandidate;
			const approvedRoute = selectApprovedCoderReview(state, lane.coder_role_id, coder);
			const candidateReview = state.reviews[candidate.reviewId];
			const preflight = candidateIsRetired ? candidateReview : approvedRoute?.review;
			const preflightVerdict = candidateIsRetired ? candidateReview?.verdict : approvedRoute?.review.verdict;
			const approvedRouteMatches = candidateIsRetired ? candidateReview !== void 0 && candidateReview.stage === "preflight" && candidateReview.phase === "verdict_recorded" && candidateReview.verdict?.topLevelVerdict === "APPROVED" && candidateReview.resolution?.targetRoleId === lane.coder_role_id : approvedRoute?.reviewId === candidate.reviewId && approvedRoute.review.phase === "verdict_recorded";
			const coderLineageMatches = candidateIsRetired ? candidate.coderSessionId === coder.sessionId : candidate.assignmentId === coder.goalInstall?.assignmentId || coder.goalInstall?.assignmentId !== void 0 && coder.goalInstall.assignmentId.startsWith(`coder:${candidate.reviewId}:fix:`);
			if (preflight === void 0 || !approvedRouteMatches || candidate.coderSessionId !== coder.sessionId || !coderLineageMatches || candidate.sourceRevision > frozen.ref.revision || preflightVerdict === void 0) throw new AutoLabRuntimeError(`Trial ${input.trialId} Candidate does not match its applied APPROVED Coder route`, "CONFIG_DRIFT");
			const matching = Object.entries(state.reviews).filter(([, review]) => review.stage === "postflight" && review.capability.workerRoleId === lane.coder_role_id && review.capability.judgeRoleId === lane.postflight_judge_role_id && review.artifactPath === attempt.path && review.capability.artifactHash === attempt.hash);
			if (matching.length > 1) throw new AutoLabRuntimeError(`Attempt ${attempt.attemptId} has more than one Postflight review`, "CONFIG_DRIFT");
			const existing = matching[0];
			if (existing !== void 0) {
				const [reviewId$1, review] = existing;
				if (review.capability.workerSessionId !== coder.sessionId || review.capability.judgeSessionId !== judge.sessionId || review.capability.assignmentId !== `postflight:${reviewId$1}`) throw new AutoLabRuntimeError(`Postflight review ${reviewId$1} no longer matches its Lane identities`, "CONFIG_DRIFT");
				if (review.sourcePacket.path !== coder.packet.path || review.sourcePacket.hash !== coder.packet.hash) {
					let packetBytes;
					try {
						packetBytes = await readFile(review.packetPath);
					} catch {
						throw new AutoLabRuntimeError(`Postflight review ${reviewId$1} packet cannot be read`, "CONFIG_DRIFT");
					}
					if (sha256(packetBytes) !== review.capability.packetHash) throw new AutoLabRuntimeError(`Postflight review ${reviewId$1} packet drifted`, "CONFIG_DRIFT");
				}
				if (review.result !== void 0) return controllerRequestPostflightResult(state.labId, review, "result_recorded");
				const worker$1 = this.ctx.agents.get(SessionId(coder.sessionId));
				if (worker$1 === void 0) throw new AutoLabRuntimeError(`Coder Session ${coder.sessionId} is not live`, "ROLE_ACTIVATION_UNAVAILABLE");
				await this.dispatchReviewRequest(worker$1, review.capability, signal);
				return controllerRequestPostflightResult(state.labId, review, "reviewing");
			}
			if (coder.phase !== "paused") throw new AutoLabRuntimeError(`Coder role ${lane.coder_role_id} must finish its current Assignment before Postflight`, "REVIEW_NOT_READY");
			const worker = this.ctx.agents.get(SessionId(coder.sessionId));
			if (worker === void 0) throw new AutoLabRuntimeError(`Coder Session ${coder.sessionId} is not live`, "ROLE_ACTIVATION_UNAVAILABLE");
			const exactWorker = this.resolveExactRoleCaller(worker);
			if (exactWorker.state.labId !== labId || exactWorker.roleId !== lane.coder_role_id) throw new AutoLabRuntimeError("Coder Session ownership drifted", "CONFIG_DRIFT");
			const sourceTurn = lastCompletedAgentTurn(worker);
			if (sourceTurn === void 0) throw new AutoLabRuntimeError(`Coder Session ${coder.sessionId} has no closed source turn for Postflight`, "REVIEW_NOT_READY");
			const install = coder.goalInstall;
			const liveGoal = this.ctx.goals.get(worker);
			if (install?.status !== "applied" || liveGoal !== void 0 && (String(liveGoal.id) !== install.goalId || sha256(liveGoal.objective) !== install.objectiveHash)) throw new AutoLabRuntimeError(`Coder role ${lane.coder_role_id} no longer owns its Postflight source Assignment`, "REVIEW_NOT_READY");
			const judgeBinding = await readRoleBinding(frozen.manifest.authority_paths.lab_dir, lane.postflight_judge_role_id);
			if (judgeBinding === void 0 || judgeBinding.path !== judge.binding.path || judgeBinding.hash !== judge.binding.hash) throw new AutoLabRuntimeError(`Postflight Judge ${lane.postflight_judge_role_id} binding drifted`, "CONFIG_DRIFT");
			const plannedRevision = state.runtimeRevision + 1;
			const reviewId = deterministicReviewId([
				state.labId,
				String(frozen.ref.revision),
				"postflight",
				input.trialId,
				input.runSlotId,
				attempt.attemptId,
				attempt.hash,
				String(plannedRevision)
			]);
			const reviewArtifacts = await freezePostflightReviewArtifacts({
				frozen,
				judgeSessionId: judge.sessionId,
				judgeBinding,
				currentCoderPacket: {
					path: coder.packet.path,
					sha256: coder.packet.hash
				},
				methodPacket: {
					path: preflight.sourcePacket.path,
					sha256: preflight.sourcePacket.hash
				},
				preflightResult: {
					path: preflightVerdict.path,
					sha256: preflightVerdict.hash
				},
				coderResult: {
					path: candidate.sourceReport.path,
					sha256: candidate.sourceReport.hash
				},
				trial: {
					path: trial.contract.path,
					sha256: trial.contract.hash
				},
				runSlot: {
					path: runSlot.contract.path,
					sha256: runSlot.contract.hash
				},
				attempt: {
					path: attempt.path,
					sha256: attempt.hash
				},
				reviewId,
				runtimeRevision: plannedRevision,
				issuedAt: state.updatedAt,
				revealState: state.revealState ?? frozen.manifest.communication.reveal_policy.initial_state
			});
			const capability = compileReviewControlCapability({
				reviewId,
				assignmentId: reviewArtifacts.assignmentId,
				configRevision: frozen.ref.revision,
				runtimeRevision: plannedRevision,
				ownerFence: this.requireOwner().owner.token,
				workerRoleId: lane.coder_role_id,
				workerSessionId: coder.sessionId,
				judgeRoleId: lane.postflight_judge_role_id,
				judgeSessionId: judge.sessionId,
				packetHash: reviewArtifacts.packet.packetHash,
				artifactHash: attempt.hash,
				negotiatedAnchorHash: reviewArtifacts.reviewInputHash,
				sourceTurn,
				expectedGoalRef: liveGoal === void 0 ? null : {
					id: String(liveGoal.id),
					revision: liveGoal.revision
				},
				requestControlId: randomUUID(),
				acceptedPauseControlId: randomUUID()
			});
			const now = Date.now();
			const roles = structuredClone(state.roles);
			roles[lane.coder_role_id] = {
				...coder,
				phase: "reviewing"
			};
			const reviews = structuredClone(state.reviews);
			reviews[reviewId] = {
				stage: "postflight",
				phase: "reviewing",
				sourcePacket: {
					path: coder.packet.path,
					hash: coder.packet.hash
				},
				packetPath: reviewArtifacts.packetPath,
				artifactPath: attempt.path,
				capability,
				pause: {
					controlId: capability.acceptedPause.controlId,
					payloadHash: capability.acceptedPause.payloadHash,
					freeze: "pending"
				},
				createdAt: now,
				updatedAt: now
			};
			state = await this.transition(state, state.lifecycle, void 0, void 0, roles, reviews);
			await this.dispatchReviewRequest(worker, capability, signal);
			return controllerRequestPostflightResult(state.labId, reviews[reviewId], "reviewing");
		});
	}
	async prepareCoderSubmission(caller, signal) {
		signal?.throwIfAborted();
		const { state, roleId } = this.resolveExactRoleCaller(caller);
		const coderState = state.roles[roleId];
		if (state.lifecycle !== "running" || coderState.phase !== "working" && coderState.phase !== "paused" || coderState.packet === void 0 || coderState.binding === void 0 || coderState.goalInstall?.status !== "applied") throw new AutoLabRuntimeError(`Coder role ${roleId} is not an active implementation Assignment`, "IMPLEMENTATION_NOT_READY");
		const projected = Object.values(state.candidates).filter((candidate) => candidate.coderRoleId === roleId && candidate.coderSessionId === coderState.sessionId && candidate.assignmentId === coderState.goalInstall.assignmentId);
		if (coderState.phase === "paused") {
			if (projected.length !== 1) throw new AutoLabRuntimeError(`Paused Coder role ${roleId} has no unique frozen candidate`, "IMPLEMENTATION_NOT_READY");
			return coderImplementationResult(state.labId, projected[0]);
		}
		if (projected.length > 0) throw new AutoLabRuntimeError(`Working Coder role ${roleId} already has a frozen candidate projection`, "CONFIG_DRIFT");
		const frozen = await this.artifacts.readCurrent(state.labId);
		if (state.config === void 0 || !sameConfigRef(state.config, frozen.ref)) throw new AutoLabRuntimeError(`Lab ${state.labId} CURRENT does not match RuntimeState`, "CONFIG_DRIFT");
		const coderRole = frozen.manifest.roles.find((role) => role.role_id === roleId);
		if (coderRole?.role_kind !== "coder") throw new AutoLabRuntimeError(`Role ${roleId} is not a Coder role in CURRENT`, "CONFIG_DRIFT");
		const lane = frozen.manifest.lanes.find((value) => value.lane_id === coderRole.lane_id && value.coder_role_id === roleId);
		const selected = selectApprovedCoderReview(state, roleId, coderState);
		if (lane === void 0 || selected === void 0) throw new AutoLabRuntimeError(`Coder role ${roleId} has no unique applied APPROVED review`, "IMPLEMENTATION_NOT_READY");
		const binding = await readRoleBinding(frozen.manifest.authority_paths.lab_dir, roleId);
		if (binding === void 0 || binding.path !== coderState.binding.path || binding.hash !== coderState.binding.hash) throw new AutoLabRuntimeError(`Coder role ${roleId} binding drifted`, "CONFIG_DRIFT");
		const review = selected.review;
		if (review.verdict === void 0) throw new AutoLabRuntimeError(`Review ${selected.reviewId} has no frozen verdict`, "CONFIG_DRIFT");
		assertLiveAssignmentGoal(this.ctx, caller, coderState, roleId, "Coder");
		const input = {
			frozen,
			coderRole,
			coderSessionId: coderState.sessionId,
			coderBinding: binding,
			coderPacket: coderState.packet,
			expectedAssignmentId: coderState.goalInstall.assignmentId,
			reviewId: selected.reviewId,
			sourceMethodPacket: review.sourcePacket,
			designTicket: {
				path: review.artifactPath,
				hash: review.capability.artifactHash
			},
			preflightVerdict: {
				path: review.verdict.path,
				hash: review.verdict.hash
			},
			runtimeRevision: state.runtimeRevision
		};
		return {
			labId: state.labId,
			roleId,
			laneId: lane.lane_id,
			coderSessionId: coderState.sessionId,
			assignmentId: coderState.goalInstall.assignmentId,
			packet: coderState.packet,
			binding: coderState.binding,
			goalInstall: coderState.goalInstall,
			reviewId: selected.reviewId,
			config: state.config,
			input
		};
	}
	async commitCoderSubmission(caller, prepared, submission, signal) {
		signal?.throwIfAborted();
		let { state, roleId } = this.resolveExactRoleCaller(caller);
		if (state.labId !== prepared.labId || roleId !== prepared.roleId) throw new AutoLabRuntimeError("Coder caller changed during candidate capture", "CONFIG_DRIFT");
		const coderState = state.roles[roleId];
		const projection = {
			version: 1,
			sourceRevision: prepared.input.frozen.ref.revision,
			laneId: submission.laneId,
			candidateId: submission.candidateId,
			reviewId: submission.reviewId,
			coderRoleId: roleId,
			coderSessionId: prepared.coderSessionId,
			assignmentId: submission.assignment.assignmentId,
			candidateSha: submission.candidate.candidateSha,
			captureReceipt: {
				path: submission.candidatePath,
				hash: submission.candidateHash
			},
			sourceReport: {
				path: submission.reportPath,
				hash: submission.reportHash
			},
			frozenAt: submission.candidate.capturedAt
		};
		const existing = state.candidates[prepared.laneId];
		if (existing !== void 0) {
			if (canonicalJson$1(existing) === canonicalJson$1(projection) && coderState.phase === "paused") return coderImplementationResult(state.labId, existing);
			throw new AutoLabRuntimeError(`Lane ${prepared.laneId} already projects another active candidate`, "CONFIG_DRIFT");
		}
		const selected = selectApprovedCoderReview(state, roleId, coderState);
		if (state.lifecycle !== "running" || coderState.phase !== "working" || coderState.sessionId !== prepared.coderSessionId || canonicalJson$1(coderState.packet) !== canonicalJson$1(prepared.packet) || canonicalJson$1(coderState.binding) !== canonicalJson$1(prepared.binding) || canonicalJson$1(coderState.goalInstall) !== canonicalJson$1(prepared.goalInstall) || canonicalJson$1(state.config) !== canonicalJson$1(prepared.config) || !sameConfigRef(state.config, prepared.input.frozen.ref) || selected?.reviewId !== prepared.reviewId || submission.laneId !== prepared.laneId || submission.reviewId !== prepared.reviewId || submission.assignment.assignmentId !== prepared.assignmentId) throw new AutoLabRuntimeError(`Coder role ${roleId} Assignment changed during candidate capture`, "CONFIG_DRIFT");
		assertLiveAssignmentGoal(this.ctx, caller, coderState, roleId, "Coder");
		const roles = structuredClone(state.roles);
		roles[roleId] = {
			...coderState,
			phase: "paused"
		};
		const candidates = structuredClone(state.candidates);
		candidates[prepared.laneId] = projection;
		state = await this.transition(state, state.lifecycle, void 0, void 0, roles, void 0, candidates);
		try {
			await pauseLocalGoalContinuation(this.ctx, coderState.sessionId);
		} catch {
			this.ctx.goals.disarm(caller);
		}
		state = await this.wakeControllerForEvent(state, `coder-candidate:${projection.candidateId}:${projection.candidateSha}`, [`AutoLab ${state.labId} Coder candidate ${projection.candidateId} is frozen at ${projection.candidateSha}.`, `Read the original report at ${projection.sourceReport?.path ?? projection.captureReceipt.path} and current RuntimeState before deciding Trial or review work.`].join("\n"));
		return coderImplementationResult(state.labId, projection);
	}
	async start(caller, labId, signal) {
		await this.enqueue(labId, async () => {
			signal?.throwIfAborted();
			let state = this.requireState(validateLabId(labId));
			this.assertControllerSession(caller, state);
			if (state.config === void 0 || state.lifecycle === "configuring" || state.lifecycle === "draft_ready" || state.lifecycle === "stopped" || state.lifecycle === "pausing") throw new AutoLabRuntimeError(`Lab ${labId} is not ready`, "NOT_READY");
			const frozen = await this.artifacts.readCurrent(labId);
			if (!sameConfigRef(state.config, frozen.ref)) throw new AutoLabRuntimeError(`Lab ${labId} CURRENT does not match RuntimeState`, "CONFIG_DRIFT");
			const workers = frozen.manifest.roles.filter((role) => role.role_kind !== "controller");
			if (workers.length === 0) throw new AutoLabRuntimeError(`Lab ${labId} has no root worker roles`, "NO_ROLES_DECLARED");
			if (state.lifecycle === "running" && this.hasAttachedRoleSet(state) && Object.values(state.roles).every((role) => role.activationBlocker === void 0 && role.goalInstall?.status !== "activating")) {
				state = await this.armControllerGoal(caller, state, frozen);
				const attached = await this.readAttachedRoles(state, frozen, workers);
				await this.reconcileCommunicationAcl(caller, state, frozen, attached, signal);
				await this.reconcileProjectedPausedRoleGoals(state);
				await this.replayActiveReviewRequests(state, signal);
				return cloneState(this.requireState(labId));
			}
			try {
				if (state.lifecycle !== "starting") state = await this.transition(state, "starting", null, void 0, startingRoleProjection(state, frozen.manifest, workers));
				else assertStartingRoleProjection(state, workers);
				state = await this.armControllerGoal(caller, state, frozen);
				const activation = await this.activateRolesForControl(caller, state, frozen, workers, signal);
				const activated = activation.activated;
				const stagedRoles = structuredClone(state.roles);
				for (const [roleId, activationBlocker] of activation.blockers) stagedRoles[roleId] = {
					...stagedRoles[roleId],
					activationBlocker
				};
				for (const item of activated) {
					const projected = state.roles[item.role.role_id];
					const base = {
						sessionId: String(item.agent.id),
						phase: projected.phase === "starting" && item.role.role_kind !== "method" ? "declared" : projected.phase,
						binding: {
							path: item.binding.path,
							hash: item.binding.hash
						},
						packet: {
							path: item.artifacts.packetPath,
							hash: item.artifacts.packet.packetHash
						}
					};
					if (item.role.role_kind !== "method" && projected.goalInstall === void 0) {
						stagedRoles[item.role.role_id] = base;
						continue;
					}
					if (projected.goalInstall !== void 0 && projected.phase !== "working" && projected.phase !== "starting") {
						stagedRoles[item.role.role_id] = {
							...base,
							goalInstall: projected.goalInstall
						};
						continue;
					}
					const intent = compileLocalGoalIntent({
						installId: projected.goalInstall?.installId ?? `${item.artifacts.assignmentId}:install:1`,
						assignmentId: projected.goalInstall?.assignmentId ?? item.artifacts.assignmentId,
						packetPath: item.artifacts.packetPath,
						packetHash: item.artifacts.packet.packetHash,
						body: item.artifacts.objectiveBody,
						maxGoalRounds: projected.goalInstall?.maxGoalRounds ?? roleGoalRoundLimit(item.role),
						expectedGoalRef: projected.goalInstall?.goalId === void 0 ? null : {
							id: GoalId(projected.goalInstall.goalId),
							revision: projected.goalInstall.goalRevision
						}
					});
					stagedRoles[item.role.role_id] = {
						...base,
						phase: projected.phase,
						goalInstall: {
							...projected.goalInstall,
							installId: intent.installId,
							assignmentId: intent.assignmentId,
							objectiveHash: intent.objectiveHash,
							maxGoalRounds: intent.maxGoalRounds,
							status: "activating"
						}
					};
				}
				state = await this.transition(state, "starting", void 0, void 0, stagedRoles);
				const goalTargets = activated.filter((item) => state.roles[item.role.role_id]?.goalInstall?.status === "activating");
				const goalResults = await Promise.allSettled(goalTargets.map(async (item) => {
					const roleState = state.roles[item.role.role_id];
					const install = roleState.goalInstall;
					const intent = compileLocalGoalIntent({
						installId: install.installId,
						assignmentId: install.assignmentId,
						packetPath: item.artifacts.packetPath,
						packetHash: item.artifacts.packet.packetHash,
						body: item.artifacts.objectiveBody,
						maxGoalRounds: install.maxGoalRounds,
						expectedGoalRef: install.goalId === void 0 ? currentLiveGoalRef(this.ctx, roleState.sessionId) : {
							id: GoalId(install.goalId),
							revision: install.goalRevision
						}
					});
					const result = await installLocalGoal(this.ctx, roleState.sessionId, intent);
					if (result.outcome === "already-complete") throw new Error(`Assignment ${install.assignmentId} Goal is complete and requires receipt reconciliation`);
					return {
						roleId: item.role.role_id,
						result
					};
				}));
				const runningRoles = structuredClone(state.roles);
				for (let index = 0; index < goalResults.length; index += 1) {
					const settled = goalResults[index];
					const roleId = goalTargets[index].role.role_id;
					const current = runningRoles[roleId];
					if (settled.status === "rejected") {
						runningRoles[roleId] = {
							...current,
							activationBlocker: {
								code: "GOAL_INSTALL_FAILED",
								message: renderError(settled.reason)
							}
						};
						continue;
					}
					runningRoles[roleId] = {
						...current,
						phase: "working",
						goalInstall: {
							...current.goalInstall,
							status: "applied",
							goalId: String(settled.value.result.ref.id),
							goalRevision: settled.value.result.ref.revision
						}
					};
				}
				state = await this.transition(state, "running", null, void 0, runningRoles);
				await this.reconcileProjectedPausedRoleGoals(state);
				await this.replayActiveReviewRequests(state, signal);
				return cloneState(this.requireState(labId));
			} catch (error) {
				await this.pauseRoleGoals(frozen.manifest);
				const current = this.requireState(labId);
				if (current.lifecycle !== "blocked") await this.transition(current, "blocked", {
					code: error instanceof CommunicationAclError ? "ACL_SAFETY_FAILED" : "ROLE_ACTIVATION_FAILED",
					message: renderError(error)
				});
				throw new AutoLabRuntimeError(`Lab ${labId} start failed: ${renderError(error)}`, "ROLE_ACTIVATION_UNAVAILABLE");
			}
		});
		return cloneState(this.requireState(labId));
	}
	pause(caller, labId, signal) {
		return this.enqueue(labId, async () => {
			signal?.throwIfAborted();
			let state = this.requireState(validateLabId(labId));
			this.assertControllerSession(caller, state);
			if (state.lifecycle === "paused") return cloneState(state);
			if (state.lifecycle === "configuring" || state.lifecycle === "draft_ready" || state.lifecycle === "stopped") throw new AutoLabRuntimeError(`Lab ${labId} is ${state.lifecycle} and cannot be paused`, "NOT_READY");
			if (state.lifecycle === "running") state = await this.transition(state, "pausing");
			if (!this.hasAttachedRoleSet(state) && Object.keys(state.roles).length > 0) try {
				if (state.config === void 0) throw new Error("pausing Lab has no committed config");
				const frozen = await this.artifacts.readCurrent(labId);
				if (!sameConfigRef(state.config, frozen.ref)) throw new Error("CURRENT does not match the pausing RuntimeState");
				const workers = frozen.manifest.roles.filter((role) => role.role_kind !== "controller");
				assertStartingRoleProjection(state, workers);
				const activation = await this.activateRolesForControl(caller, state, frozen, workers, signal);
				if (activation.blockers.size > 0) throw new Error([...activation.blockers].map(([roleId, blocker]) => `${roleId}: ${blocker.message}`).join("; "));
			} catch (error) {
				state = await this.transition(state, "blocked", {
					code: "SESSION_RECOVERY_FAILED",
					message: renderError(error)
				});
				return cloneState(state);
			}
			const failures = [];
			await Promise.all(Object.values(state.roles).map(async (role) => {
				try {
					signal?.throwIfAborted();
					await pauseLocalGoalContinuation(this.ctx, role.sessionId);
				} catch (error) {
					failures.push(`${role.sessionId}: ${renderError(error)}`);
				}
			}));
			let controllerGoal = state.controllerGoal;
			try {
				controllerGoal = (await this.pauseControllerNativeGoal(caller, state)).controllerGoal;
			} catch (error) {
				failures.push(`${state.controllerSessionId}: ${renderError(error)}`);
			}
			if (failures.length > 0) state = await this.transition(state, "blocked", {
				code: "GOAL_PAUSE_FAILED",
				message: failures.join("; ")
			}, void 0, void 0, void 0, void 0, void 0, controllerGoal);
			else state = await this.transition(state, "paused", null, void 0, void 0, void 0, void 0, void 0, controllerGoal);
			return cloneState(state);
		});
	}
	async resume(caller, labId, signal) {
		await this.enqueue(labId, async () => {
			signal?.throwIfAborted();
			const state = this.requireState(validateLabId(labId));
			this.assertControllerSession(caller, state);
			if (state.config === void 0 || state.lifecycle === "configuring" || state.lifecycle === "draft_ready" || state.lifecycle === "stopped" || state.lifecycle === "pausing" || state.controllerGoal?.waiting !== true) return;
			const { waiting: _waiting,...controllerGoal } = state.controllerGoal;
			await this.transition(state, state.lifecycle, void 0, void 0, void 0, void 0, void 0, void 0, controllerGoal);
		});
		return await this.start(caller, labId, signal);
	}
	async stop(caller, labId, signal) {
		const initial = this.status(caller, labId);
		if (initial.lifecycle === "stopped") return initial;
		if (initial.lifecycle === "configuring" || initial.lifecycle === "draft_ready") return await this.enqueue(labId, async () => {
			signal?.throwIfAborted();
			const state = this.requireState(validateLabId(labId));
			this.assertControllerSession(caller, state);
			if (state.lifecycle === "stopped") return cloneState(state);
			if (state.lifecycle !== "configuring" && state.lifecycle !== "draft_ready") throw new AutoLabRuntimeError(`Lab ${labId} changed while stopping and is now ${state.lifecycle}`, "NOT_READY");
			return cloneState(await this.transition(state, "stopped", null));
		});
		const paused = await this.pause(caller, labId, signal);
		if (paused.lifecycle === "blocked" || paused.lifecycle === "stopped") return paused;
		return await this.enqueue(labId, async () => {
			signal?.throwIfAborted();
			const state = this.requireState(validateLabId(labId));
			this.assertControllerSession(caller, state);
			if (state.lifecycle !== "paused") throw new AutoLabRuntimeError(`Lab ${labId} changed while stopping and is now ${state.lifecycle}`, "NOT_READY");
			return cloneState(await this.transition(state, "stopped", null));
		});
	}
	waitController(caller, labId, signal) {
		return this.enqueue(labId, async () => {
			signal?.throwIfAborted();
			let state = this.requireState(validateLabId(labId));
			this.assertControllerSession(caller, state);
			const paused = await this.pauseControllerNativeGoal(caller, state);
			const controllerGoal = paused.controllerGoal === void 0 || paused.outcome === "no-goal" ? paused.controllerGoal : {
				...paused.controllerGoal,
				waiting: true
			};
			if (canonicalJson$1(controllerGoal ?? null) !== canonicalJson$1(state.controllerGoal ?? null)) state = await this.transition(state, state.lifecycle, void 0, void 0, void 0, void 0, void 0, void 0, controllerGoal);
			return {
				labId: state.labId,
				outcome: paused.outcome
			};
		});
	}
	async armControllerGoal(caller, state, frozen) {
		if (state.controllerGoal?.waiting === true || this.controllerApiRecoveryOwnsGoal(state)) return state;
		const intent = compileControllerGoalIntent(state, frozen);
		const live = this.ctx.agents.get(SessionId(state.controllerSessionId));
		const current = live === void 0 ? void 0 : this.ctx.goals.get(live);
		const retained = current?.phase === "complete" ? void 0 : current;
		const desired = {
			roleId: intent.roleId,
			packetHash: intent.packetHash,
			installId: intent.installId,
			assignmentId: intent.assignmentId,
			objectiveHash: intent.objectiveHash,
			maxGoalRounds: retained?.maxGoalRounds ?? state.controllerGoal?.maxGoalRounds ?? intent.maxGoalRounds,
			status: live === caller ? "activating" : "pending",
			...retained === void 0 ? state.controllerGoal?.goalId === void 0 ? {} : {
				goalId: state.controllerGoal.goalId,
				goalRevision: state.controllerGoal.goalRevision
			} : {
				goalId: String(retained.id),
				goalRevision: retained.revision
			}
		};
		if (canonicalJson$1(state.controllerGoal ?? null) !== canonicalJson$1(desired)) state = await this.transition(state, state.lifecycle, void 0, void 0, void 0, void 0, void 0, void 0, desired);
		if (live !== caller) return state;
		const goal = await this.applyControllerGoal(caller, intent);
		const applied = {
			...desired,
			status: "applied",
			maxGoalRounds: goal.maxGoalRounds,
			goalId: String(goal.id),
			goalRevision: goal.revision
		};
		if (canonicalJson$1(state.controllerGoal ?? null) === canonicalJson$1(applied)) return state;
		return await this.transition(state, state.lifecycle, void 0, void 0, void 0, void 0, void 0, void 0, applied);
	}
	/** One exact active recovery owns Controller Goal continuation until it settles. */
	controllerApiRecoveryOwnsGoal(state) {
		const stored = state.controllerGoal;
		const record = this.apiRecoveryStore?.get(state.controllerSessionId);
		if (stored?.goalId === void 0 || record === void 0 || record.phase === "operator" || record.labId !== state.labId || record.sessionId !== state.controllerSessionId || record.roleId !== stored.roleId || record.assignmentId !== stored.assignmentId || record.packetHash !== stored.packetHash) return false;
		const continuations = [record.continuation];
		if (record.phase === "recovering") continuations.push(record.resumedContinuation);
		return continuations.some((continuation) => continuation.kind === "goal" && String(continuation.goalRef.id) === stored.goalId && continuation.objectiveHash === stored.objectiveHash);
	}
	async applyControllerGoal(agent, intent) {
		let current = this.ctx.goals.get(agent);
		if (current === void 0 || current.phase === "complete") current = this.ctx.goals.create(agent, {
			objective: intent.objective,
			maxGoalRounds: intent.maxGoalRounds
		});
		else {
			if (sha256(current.objective) !== intent.objectiveHash) current = this.ctx.goals.edit(agent, goalRef(current), { objective: intent.objective });
			if (current.phase !== "active" || current.activation !== "armed") current = this.ctx.goals.resume(agent, goalRef(current));
		}
		try {
			await flushSessionDurably(this.ctx, agent.session, "Controller Goal checkpoint");
		} catch (error) {
			if (error instanceof SessionDurabilityError) throw error;
			const applied = this.ctx.goals.get(agent);
			if (applied === void 0 || sha256(applied.objective) !== intent.objectiveHash) throw error;
			await flushSessionDurably(this.ctx, agent.session, "Controller Goal checkpoint retry");
			current = applied;
		}
		return current;
	}
	async pauseControllerNativeGoal(caller, state) {
		const stored = state.controllerGoal;
		if (stored?.goalId === void 0) return {
			outcome: "no-goal",
			controllerGoal: stored
		};
		const live = this.ctx.agents.get(SessionId(state.controllerSessionId));
		if (live === void 0 || live !== caller) return {
			outcome: "no-goal",
			controllerGoal: stored
		};
		let goal = this.ctx.goals.get(live);
		if (goal === void 0 || String(goal.id) !== stored.goalId) return {
			outcome: "no-goal",
			controllerGoal: stored
		};
		let outcome;
		if (goal.phase === "active") {
			goal = this.ctx.goals.pause(live, goalRef(goal));
			await flushSessionDurably(this.ctx, live.session, "Controller Goal pause");
			outcome = "paused";
		} else if (goal.phase === "paused") outcome = "already-paused";
		else outcome = "no-goal";
		return {
			outcome,
			controllerGoal: {
				...stored,
				goalRevision: goal.revision
			}
		};
	}
	async transition(current, lifecycle, blocker, config, roles, reviews, candidates, trials, controllerGoal, revealState, retiredCandidates) {
		const next = await this.requireTable().update(current.labId, (value) => {
			if (value.runtimeRevision !== current.runtimeRevision) throw new AutoLabRuntimeError(`Lab ${current.labId} Controller revision changed`, "CONFIG_DRIFT");
			return transitionRuntimeState(value, {
				expectedRevision: current.runtimeRevision,
				ownerEpoch: this.requireOwner().owner.token,
				lifecycle,
				...blocker === void 0 ? {} : { blocker },
				...config === void 0 ? {} : { config },
				...roles === void 0 ? {} : { roles },
				...reviews === void 0 ? {} : { reviews },
				...candidates === void 0 ? {} : { candidates },
				...trials === void 0 ? {} : { trials },
				...controllerGoal === void 0 ? {} : { controllerGoal },
				...revealState === void 0 ? {} : { revealState },
				...retiredCandidates === void 0 ? {} : { retiredCandidates }
			});
		});
		this.view.set(next.labId, next);
		return next;
	}
	async provisionWorktrees(frozen, signal) {
		const results = await Promise.allSettled(frozen.manifest.lanes.map(async (lane) => {
			signal?.throwIfAborted();
			if ((await provisionLaneWorktree({
				labId: frozen.manifest.lab_id,
				laneId: lane.lane_id,
				labDirectory: frozen.manifest.authority_paths.lab_dir,
				repositoryPath: frozen.manifest.repository.path,
				worktreePath: lane.worktree_path,
				baseRef: lane.base_ref,
				baseSha: lane.base_sha
			})).receipt.baseSha !== lane.base_sha) throw new AutoLabRuntimeError(`Lane ${lane.lane_id} worktree base does not match CURRENT`, "CONFIG_DRIFT");
			return lane.lane_id;
		}));
		signal?.throwIfAborted();
		const failures = /* @__PURE__ */ new Map();
		for (let index = 0; index < results.length; index += 1) {
			const result = results[index];
			if (result.status === "rejected") failures.set(frozen.manifest.lanes[index].lane_id, renderError(result.reason));
		}
		return failures;
	}
	async activateRolesForControl(caller, state, frozen, workers, signal) {
		const worktreeFailures = await this.provisionWorktrees(frozen, signal);
		let persistenceFailure;
		let persisted = /* @__PURE__ */ new Map();
		try {
			persisted = new Map((await this.requireSessionPersistence().list(signal)).map((header) => [String(header.id), header]));
		} catch (error) {
			signal?.throwIfAborted();
			persistenceFailure = renderError(error);
		}
		const settled = await Promise.allSettled(workers.map(async (role) => {
			const laneFailure = "lane_id" in role ? worktreeFailures.get(role.lane_id) : void 0;
			if (laneFailure !== void 0) throw new Error(laneFailure);
			const persistedHeader = persisted.get(state.roles[role.role_id].sessionId);
			return await this.activateRole({
				state,
				frozen,
				role,
				...persistedHeader === void 0 ? {} : { persisted: persistedHeader },
				...persistenceFailure === void 0 ? {} : { persistenceFailure },
				...signal === void 0 ? {} : { signal }
			});
		}));
		signal?.throwIfAborted();
		const activated = [];
		const blockers = /* @__PURE__ */ new Map();
		for (let index = 0; index < settled.length; index += 1) {
			const result = settled[index];
			const role = workers[index];
			if (result.status === "fulfilled") {
				activated.push(result.value);
				continue;
			}
			const laneFailure = "lane_id" in role ? worktreeFailures.get(role.lane_id) : void 0;
			blockers.set(role.role_id, {
				code: laneFailure === void 0 ? "ROLE_ACTIVATION_FAILED" : "WORKTREE_PROVISION_FAILED",
				message: renderError(result.reason)
			});
		}
		const blockedEntries = [...blockers];
		const pauses = await Promise.allSettled(blockedEntries.map(async ([roleId]) => {
			const sessionId = state.roles[roleId].sessionId;
			const agent = this.ctx.agents.get(SessionId(sessionId));
			if (agent === void 0) return;
			try {
				await pauseLocalGoalContinuation(this.ctx, sessionId);
			} catch (error) {
				this.ctx.goals.disarm(agent);
				throw error;
			}
		}));
		for (let index = 0; index < pauses.length; index += 1) {
			const pause = pauses[index];
			if (pause.status === "fulfilled") continue;
			const [roleId, blocker] = blockedEntries[index];
			blockers.set(roleId, {
				...blocker,
				message: `${blocker.message}; Goal pause failed: ${renderError(pause.reason)}`
			});
		}
		await this.reconcileCommunicationAcl(caller, state, frozen, activated, signal, activated.length !== workers.length);
		return {
			activated,
			blockers
		};
	}
	async activateRole(input) {
		input.signal?.throwIfAborted();
		const roleState = input.state.roles[input.role.role_id];
		const spec = resolveRootRoleSessionSpec(input.frozen.manifest, input.role.role_id);
		let binding = await readRoleBinding(input.frozen.manifest.authority_paths.lab_dir, input.role.role_id);
		if (roleState.binding !== void 0 && (binding?.path !== roleState.binding.path || binding.hash !== roleState.binding.hash)) throw new AutoLabRuntimeError(`Role ${input.role.role_id} binding receipt does not match RuntimeState`, "CONFIG_DRIFT");
		if (binding === void 0 && (roleState.binding !== void 0 || roleState.packet !== void 0 || roleState.goalInstall !== void 0)) throw new AutoLabRuntimeError(`Role ${input.role.role_id} has durable task state but no RoleBindingReceipt`, "CONFIG_DRIFT");
		if (input.persisted !== void 0) {
			if (input.persisted.cwd !== spec.cwd || input.persisted.agentPreset === void 0) throw new AutoLabRuntimeError(`Persisted Session ${roleState.sessionId} does not match role ${input.role.role_id}`, "CONFIG_DRIFT");
		}
		const hadDurableIdentity = binding !== void 0 || roleState.binding !== void 0 || roleState.packet !== void 0 || roleState.goalInstall !== void 0;
		const key = roleHandleKey(input.state.labId, input.role.role_id);
		let owned = this.roleHandles.get(key);
		let borrowed = this.borrowedRoleAgents.get(key);
		const live = this.ctx.agents.get(SessionId(roleState.sessionId));
		if (owned !== void 0 && live !== owned.agent) throw new AutoLabRuntimeError(`Owned role ${input.role.role_id} is no longer the exact live Agent`, "ROLE_ACTIVATION_UNAVAILABLE");
		if (borrowed !== void 0 && live !== borrowed) {
			this.borrowedRoleAgents.delete(key);
			borrowed = void 0;
		}
		let agentPresetId = binding?.receipt.agentPresetId ?? input.persisted?.agentPreset ?? live?.session.header.agentPreset;
		if (agentPresetId === void 0 && live === void 0) agentPresetId = (await this.requireAgentPresets().resolve()).id;
		if (agentPresetId === void 0) throw new AutoLabRuntimeError(`Live Session ${roleState.sessionId} has no agent preset identity`, "CONFIG_DRIFT");
		if (live !== void 0 && owned === void 0) {
			await verifyBorrowedRootRoleSession(this.ctx, {
				manifest: input.frozen.manifest,
				roleId: input.role.role_id,
				sessionId: roleState.sessionId,
				agentPresetId,
				...input.signal === void 0 ? {} : { signal: input.signal }
			}, live);
			borrowed = live;
			this.borrowedRoleAgents.set(key, live);
		}
		if (owned === void 0 && borrowed === void 0 && input.persisted === void 0 && input.persistenceFailure !== void 0) throw new AutoLabRuntimeError(`Cannot prove Session ${roleState.sessionId} is absent: ${input.persistenceFailure}`, "ROLE_ACTIVATION_UNAVAILABLE");
		if (owned === void 0 && borrowed === void 0) {
			if (input.persisted === void 0 && hadDurableIdentity) throw new AutoLabRuntimeError(`Persisted Session ${roleState.sessionId} is missing for durable role ${input.role.role_id}`, "ROLE_ACTIVATION_UNAVAILABLE");
			owned = input.persisted === void 0 ? await createRootRoleSession(this.ctx, {
				manifest: input.frozen.manifest,
				roleId: input.role.role_id,
				sessionId: roleState.sessionId,
				agentPresetId,
				...input.signal === void 0 ? {} : { signal: input.signal }
			}) : await resumeRootRoleSession(this.ctx, {
				manifest: input.frozen.manifest,
				roleId: input.role.role_id,
				sessionId: roleState.sessionId,
				agentPresetId,
				...input.signal === void 0 ? {} : { signal: input.signal }
			});
			this.roleHandles.set(key, owned);
			await flushSessionDurably(this.ctx, owned.agent.session, "AutoLab role Session activation");
		}
		binding ??= await freezeRoleBinding({
			labDirectory: input.frozen.manifest.authority_paths.lab_dir,
			labId: input.state.labId,
			manifestHash: input.frozen.ref.manifestHash,
			roleId: input.role.role_id,
			roleKind: input.role.role_kind,
			sessionId: roleState.sessionId,
			agentPresetId,
			permissionPresetId: input.role.dsh_preset,
			provider: input.role.model_route.provider,
			model: input.role.model_route.model,
			cwd: spec.cwd,
			runtimeRevision: input.state.runtimeRevision,
			issuedAt: input.state.updatedAt
		});
		const artifacts = roleState.packet === void 0 ? await freezeInitialRoleArtifacts({
			frozen: input.frozen,
			role: input.role,
			sessionId: roleState.sessionId,
			binding,
			runtimeRevision: binding.receipt.runtimeRevision,
			issuedAt: binding.receipt.issuedAt
		}) : await restoreCurrentRoleArtifacts({
			frozen: input.frozen,
			role: input.role,
			sessionId: roleState.sessionId,
			binding,
			runtimeRevision: input.state.runtimeRevision,
			packetRef: roleState.packet
		});
		const agent = owned?.agent ?? borrowed;
		if (agent === void 0) throw new AutoLabRuntimeError(`Role ${input.role.role_id} has no exact local Agent after activation`, "ROLE_ACTIVATION_UNAVAILABLE");
		return {
			role: input.role,
			binding,
			artifacts,
			agent,
			ownership: owned === void 0 ? "borrowed" : "owned"
		};
	}
	async pauseRoleGoals(manifest) {
		await Promise.allSettled(manifest.roles.filter((role) => role.role_kind !== "controller").map(async (role) => {
			const state = this.view.get(manifest.lab_id)?.roles[role.role_id];
			if (state === void 0 || this.ctx.agents.get(SessionId(state.sessionId)) === void 0) return;
			await pauseLocalGoalContinuation(this.ctx, state.sessionId);
		}));
	}
	/** Reconcile only roles already projected paused; this is a startup edge, not polling. */
	async reconcileProjectedPausedRoleGoals(state) {
		await Promise.all(Object.values(state.roles).filter((role) => role.phase === "paused").map(async (role) => {
			const agent = this.ctx.agents.get(SessionId(role.sessionId));
			if (agent === void 0) return;
			try {
				await pauseLocalGoalContinuation(this.ctx, role.sessionId);
			} catch (error) {
				try {
					this.ctx.goals.disarm(agent);
				} catch {}
				this.ctx.logger.warn(`AutoLab kept paused role ${role.sessionId} disarmed after Goal pause failure: ${renderError(error)}`);
			}
		}));
	}
	async readAttachedRoles(state, frozen, workers) {
		return await Promise.all(workers.map(async (role) => {
			const roleState = state.roles[role.role_id];
			const key = roleHandleKey(state.labId, role.role_id);
			const owned = this.roleHandles.get(key);
			const borrowed = this.borrowedRoleAgents.get(key);
			const agent = owned?.agent ?? borrowed;
			if (agent === void 0 || agent.id !== SessionId(roleState.sessionId) || this.ctx.agents.get(agent.id) !== agent) throw new AutoLabRuntimeError(`Role ${role.role_id} is no longer attached to its exact live Agent`, "ROLE_ACTIVATION_UNAVAILABLE");
			const binding = await readRoleBinding(frozen.manifest.authority_paths.lab_dir, role.role_id);
			if (roleState.binding === void 0 || binding?.path !== roleState.binding.path || binding.hash !== roleState.binding.hash) throw new AutoLabRuntimeError(`Role ${role.role_id} binding drifted while attached`, "CONFIG_DRIFT");
			return {
				role,
				binding,
				agent,
				ownership: owned === void 0 ? "borrowed" : "owned"
			};
		}));
	}
	async reconcileCommunicationAcl(caller, state, frozen, activated, signal, allowPartial = false) {
		const controllerRole = frozen.manifest.roles.find((role) => role.role_kind === "controller");
		if (controllerRole === void 0) throw new AutoLabRuntimeError("CURRENT has no Controller role", "CONFIG_DRIFT");
		const liveController = this.ctx.agents.get(SessionId(state.controllerSessionId));
		const controller = liveController ?? caller;
		if (String(controller.id) !== state.controllerSessionId) throw new AutoLabRuntimeError("Controller communication identity drifted", "CONFIG_DRIFT");
		const attachedRoleIds = new Set(activated.map((item) => item.role.role_id));
		const quarantineSessions = allowPartial ? frozen.manifest.roles.flatMap((role) => {
			if (role.role_kind === "controller" || attachedRoleIds.has(role.role_id)) return [];
			const projected = state.roles[role.role_id];
			if (projected === void 0) return [];
			const live = this.ctx.agents.get(SessionId(projected.sessionId));
			return live === void 0 ? [] : [{
				roleId: role.role_id,
				agent: live
			}];
		}) : [];
		await reconcileCommunicationAcl({
			manifest: frozen.manifest,
			revealState: state.revealState ?? frozen.manifest.communication.reveal_policy.initial_state,
			roleSessions: [{
				roleId: controllerRole.role_id,
				agent: controller
			}, ...activated.map((item) => ({
				roleId: item.role.role_id,
				agent: item.agent,
				binding: item.binding
			}))],
			messaging: this.requireSessionMessaging(),
			controllerOffline: liveController === void 0,
			authorizedManifestHashes: await listCommittedManifestHashes(frozen.manifest.authority_paths.lab_dir),
			...allowPartial ? {
				allowPartial: true,
				quarantineSessions
			} : {},
			...signal === void 0 ? {} : { signal }
		});
	}
	hasAttachedRoleSet(state) {
		const roles = Object.entries(state.roles);
		return roles.length > 0 && roles.every(([roleId, role]) => {
			const handle = this.roleHandles.get(roleHandleKey(state.labId, roleId));
			const borrowed = this.borrowedRoleAgents.get(roleHandleKey(state.labId, roleId));
			const agent = handle?.agent ?? borrowed;
			return agent !== void 0 && agent.id === SessionId(role.sessionId) && this.ctx.agents.get(SessionId(role.sessionId)) === agent;
		});
	}
	requireAgentPresets() {
		const service = this.ctx.get("agentPresets", false);
		if (service === void 0) throw new AutoLabRuntimeError("DSH agent presets are unavailable", "ROLE_ACTIVATION_UNAVAILABLE");
		return service;
	}
	requireSessionPersistence() {
		const service = this.ctx.get("sessionPersistence", false);
		if (service === void 0) throw new AutoLabRuntimeError("DSH Session persistence is unavailable", "ROLE_ACTIVATION_UNAVAILABLE");
		return service;
	}
	requireSessionMessaging() {
		const service = this.ctx.get("sessionMessaging", false);
		if (service === void 0) throw new AutoLabRuntimeError("local Session messaging is unavailable", "ROLE_ACTIVATION_UNAVAILABLE");
		return service;
	}
	resolveReviewCapability(controlId) {
		for (const state of this.view.values()) for (const review of Object.values(state.reviews)) {
			const capability = review.capability;
			if (capability.request.controlId !== controlId && capability.acceptedPause.controlId !== controlId) continue;
			const worker = state.roles[capability.workerRoleId];
			const judge = state.roles[capability.judgeRoleId];
			if (state.config?.revision !== capability.configRevision || worker?.sessionId !== capability.workerSessionId || worker.phase !== "reviewing" || worker.activationBlocker !== void 0 || judge?.sessionId !== capability.judgeSessionId || judge.activationBlocker !== void 0) return;
			return capability;
		}
	}
	async replayActiveReviewRequests(state, signal) {
		const settled = await Promise.allSettled(Object.values(state.reviews).filter((review) => !reviewHasOutput(review) || !reviewFreezeComplete(review, state.ownerEpoch)).map(async (review) => {
			const worker = this.ctx.agents.get(SessionId(review.capability.workerSessionId));
			if (worker === void 0) throw new AutoLabRuntimeError(`review worker Session ${review.capability.workerSessionId} is not live`, "ROLE_ACTIVATION_UNAVAILABLE");
			const request = await sendReviewRequest(this.ctx, worker, review.capability, signal);
			if (controlReceiptFailed(request)) throw new AutoLabRuntimeError(`review ${review.capability.reviewId} transport is ${controlReceiptFailure(request)}`, "REVIEW_TRANSPORT_FAILED");
			try {
				const accepted = await this.ctx.sessionMessaging.getControl(worker, review.capability.acceptedPause.controlId, signal);
				if (controlReceiptFailed(accepted)) throw new AutoLabRuntimeError(`review ${review.capability.reviewId} ACK transport is ${controlReceiptFailure(accepted)}`, "REVIEW_TRANSPORT_FAILED");
				if (!reviewHasOutput(review) && reviewFreezeComplete(review, state.ownerEpoch)) await this.startJudgeReviewOnce(reviewJudgeStart(review.capability), signal);
				this.trackReviewControlStatus(accepted);
			} catch (error) {
				if (!(error instanceof SessionMessagingError) || error.code !== "MESSAGE_NOT_FOUND") throw error;
			}
		}));
		signal?.throwIfAborted();
		for (const result of settled) {
			if (result.status !== "rejected") continue;
			this.ctx.logger.warn(`AutoLab kept one review locally pending after replay failure: ${renderError(result.reason)}`);
		}
	}
	trackReviewControlStatus(receipt) {
		if (!this.accepting) return;
		const task = this.handleReviewControlStatus(receipt);
		this.reviewStatusTasks.add(task);
		task.catch((error) => {
			if (this.shutdown.signal.aborted) return;
			this.ctx.logger.warn(`AutoLab review pause reconciliation failed: ${renderError(error)}`);
		}).finally(() => {
			this.reviewStatusTasks.delete(task);
		});
	}
	async handleReviewControlStatus(receipt) {
		if (!this.accepting || receipt.kind !== REVIEW_ACCEPTED_PAUSE || receipt.outcome?.status !== "completed" || !isRecord(receipt.outcome.result) || receipt.outcome.result.type !== "REVIEW_PAUSE_OUTCOME" || typeof receipt.outcome.result.reviewId !== "string" || receipt.outcome.result.activeTurn !== true && receipt.outcome.result.activeTurn !== false || receipt.outcome.result.activeTurn === true && (!Number.isSafeInteger(receipt.outcome.result.observedTurn) || receipt.outcome.result.observedTurn <= 0) || receipt.outcome.result.activeTurn === false && receipt.outcome.result.observedTurn !== void 0 || receipt.outcome.result.turnOutcome !== "stopped" && receipt.outcome.result.turnOutcome !== "source-active" && receipt.outcome.result.turnOutcome !== "user-override" || receipt.outcome.result.turnOutcome === "stopped" && receipt.outcome.result.activeTurn !== false || receipt.outcome.result.turnOutcome !== "stopped" && receipt.outcome.result.activeTurn !== true || receipt.outcome.result.goalOutcome !== "paused" && receipt.outcome.result.goalOutcome !== "already-applied" && receipt.outcome.result.goalOutcome !== "no-active-goal" && receipt.outcome.result.goalOutcome !== "stale") return;
		const located = this.findActiveReview(receipt.outcome.result.reviewId);
		if (located === void 0) return;
		const { state, review } = located;
		if (review.capability.acceptedPause.controlId !== receipt.controlId || review.capability.acceptedPause.payloadHash !== receipt.payloadHash || state.roles[review.capability.workerRoleId]?.phase !== "reviewing") return;
		const goalOutcome = receipt.outcome.result.goalOutcome;
		const activeTurn = receipt.outcome.result.activeTurn;
		const observedTurn = activeTurn ? receipt.outcome.result.observedTurn : void 0;
		const expectedTurnOutcome = observedTurn === void 0 ? "stopped" : observedTurn === review.capability.sourceTurn ? "source-active" : "user-override";
		if (receipt.outcome.result.turnOutcome !== expectedTurnOutcome) return;
		const goalRef$1 = isReviewGoalRef(receipt.outcome.result.goalRef) ? receipt.outcome.result.goalRef : void 0;
		const freeze = goalOutcome === "stale" ? "stale" : expectedTurnOutcome === "user-override" ? "user-override" : expectedTurnOutcome === "source-active" ? "hold-pending" : "stopped";
		await this.recordReviewPauseOutcome(state.labId, review.capability.reviewId, {
			controlId: receipt.controlId,
			payloadHash: receipt.payloadHash,
			completedAt: receipt.updatedAt,
			goalOutcome,
			activeTurn,
			...observedTurn === void 0 ? {} : { observedTurn },
			...goalRef$1 === void 0 ? {} : { goalRef: goalRef$1 },
			...freeze === "user-override" ? { detail: "SOURCE_TURN_CHANGED" } : {},
			freeze
		});
		if (freeze === "hold-pending") await this.acquireReviewHoldOnce(state.labId, review.capability.reviewId);
		await this.startJudgeReviewIfFrozen(review.capability.reviewId);
	}
	async startJudgeReviewIfFrozen(reviewId) {
		const located = this.findActiveReview(reviewId);
		if (located === void 0 || reviewHasOutput(located.review) || !reviewFreezeComplete(located.review, located.state.ownerEpoch)) return;
		await this.startJudgeReviewOnce(reviewJudgeStart(located.review.capability));
	}
	async recordReviewPauseOutcome(labId, reviewId, pause) {
		await this.enqueue(labId, async () => {
			const state = this.requireState(labId);
			const review = state.reviews[reviewId];
			if (review === void 0 || review.pause.controlId !== pause.controlId || review.pause.payloadHash !== pause.payloadHash) return;
			if (review.pause.freeze !== "pending") {
				if (!sameReviewPauseReceipt(review.pause, pause)) throw new AutoLabRuntimeError(`Review ${reviewId} received a conflicting pause outcome`, "CONFIG_DRIFT");
				return;
			}
			const reviews = structuredClone(state.reviews);
			reviews[reviewId] = {
				...review,
				pause,
				updatedAt: Date.now()
			};
			await this.transition(state, state.lifecycle, void 0, void 0, void 0, reviews);
		});
	}
	async acquireReviewHoldOnce(labId, reviewId) {
		const key = reviewHoldKey(labId, reviewId);
		const existing = this.reviewHoldTasks.get(key);
		if (existing !== void 0) return await existing;
		const task = this.acquireReviewHold(labId, reviewId, key);
		this.reviewHoldTasks.set(key, task);
		try {
			await task;
		} finally {
			if (this.reviewHoldTasks.get(key) === task) this.reviewHoldTasks.delete(key);
		}
	}
	async acquireReviewHold(labId, reviewId, key) {
		const located = this.findActiveReview(reviewId);
		if (located?.state.labId !== labId || located.review.pause.freeze !== "hold-pending") return;
		const ownerEpoch = this.requireOwner().owner.token;
		const worker = this.ctx.agents.get(SessionId(located.review.capability.workerSessionId));
		if (worker === void 0) {
			await this.finishReviewFreeze(labId, reviewId, "user-override", "SESSION_NOT_LOCAL");
			return;
		}
		if (worker.status !== "running") {
			await this.finishReviewFreeze(labId, reviewId, "stopped");
			return;
		}
		const result = await acquireLocalReviewHold(this.ctx, located.review.capability.workerSessionId, located.review.pause.observedTurn, this.shutdown.signal);
		if (result.outcome === "not-required") {
			await this.finishReviewFreeze(labId, reviewId, "stopped");
			return;
		}
		if (result.outcome === "user-override" || result.hold === void 0) {
			await this.finishReviewFreeze(labId, reviewId, "user-override", "SESSION_BUSY");
			return;
		}
		if (!this.accepting) {
			await result.hold.release();
			return;
		}
		const current = this.findActiveReview(reviewId);
		if (current?.state.labId !== labId || current.review.pause.freeze !== "hold-pending") {
			await result.hold.release();
			return;
		}
		if (this.reviewHolds.get(key) !== void 0) {
			await result.hold.release();
			return;
		}
		this.reviewHolds.set(key, result.hold);
		try {
			await this.finishReviewFreeze(labId, reviewId, "held", void 0, ownerEpoch);
		} catch (error) {
			if (this.reviewHolds.get(key) === result.hold) this.reviewHolds.delete(key);
			await result.hold.release();
			throw error;
		}
	}
	async finishReviewFreeze(labId, reviewId, freeze, detail, holdOwnerEpoch) {
		await this.enqueue(labId, async () => {
			const state = this.requireState(labId);
			const review = state.reviews[reviewId];
			if (review === void 0 || review.pause.freeze !== "hold-pending") return;
			const pause = {
				...review.pause,
				freeze,
				...detail === void 0 ? {} : { detail },
				...holdOwnerEpoch === void 0 ? {} : { holdOwnerEpoch }
			};
			const reviews = structuredClone(state.reviews);
			reviews[reviewId] = {
				...review,
				pause,
				updatedAt: Date.now()
			};
			await this.transition(state, state.lifecycle, void 0, void 0, void 0, reviews);
		});
	}
	async startJudgeReviewOnce(input, signal) {
		this.shutdown.signal.throwIfAborted();
		signal?.throwIfAborted();
		const located = this.findActiveReview(input.reviewId);
		if (located === void 0) return "already-started";
		const { state, review } = located;
		const capability = review.capability;
		if (capability.judgeSessionId !== input.judgeSessionId || capability.workerSessionId !== input.workerSessionId || capability.assignmentId !== input.assignmentId || capability.packetHash !== input.packetHash || capability.artifactHash !== input.artifactHash || capability.negotiatedAnchorHash !== input.negotiatedAnchorHash) throw new AutoLabRuntimeError("review wake no longer matches RuntimeState", "CONFIG_DRIFT");
		if (reviewHasOutput(review)) return "already-started";
		if (!reviewFreezeComplete(review, state.ownerEpoch)) throw new AutoLabRuntimeError(`Review ${input.reviewId} worker freeze is not complete`, "REVIEW_NOT_READY");
		const judge = this.ctx.agents.get(SessionId(input.judgeSessionId));
		if (judge === void 0) throw new AutoLabRuntimeError(`Judge Session ${input.judgeSessionId} is not live`, "ROLE_ACTIVATION_UNAVAILABLE");
		const messageId = MessageId(input.wakeId);
		if (judge.inbox.nextTurn.some((message) => message.id === messageId) || judge.inbox.nextStep.some((message) => message.id === messageId) || judge.session.events.some((event) => event.type === "user/message" && event.data.id === messageId)) {
			await flushSessionDurably(this.ctx, judge.session, "AutoLab Judge wake replay");
			return "already-started";
		}
		this.shutdown.signal.throwIfAborted();
		signal?.throwIfAborted();
		judge.followup(freezeMessage({
			id: messageId,
			role: "user",
			content: [{
				type: "text",
				text: [
					`AutoLab Review-ID: ${JSON.stringify(input.reviewId)}`,
					`Review Role-Packet path: ${review.packetPath}`,
					`Review Role-Packet SHA-256: ${capability.packetHash}`,
					`Frozen submission path: ${review.artifactPath}`,
					`Frozen submission SHA-256: ${capability.artifactHash}`,
					`Negotiated anchor SHA-256: ${capability.negotiatedAnchorHash}`,
					"Read the exact frozen files. Perform only the rubric-bound review and return its declared output contract; do not reconstruct the task from chat memory."
				].join("\n")
			}],
			source: {
				kind: "plugin",
				plugin: "dsh-autolab",
				form: "notice",
				summary: `AutoLab review ${input.reviewId}`
			}
		}));
		await flushSessionDurably(this.ctx, judge.session, "AutoLab Judge wake");
		return "started";
	}
	findActiveReview(reviewId) {
		for (const state of this.view.values()) {
			const review = state.reviews[reviewId];
			if (review !== void 0) return {
				state,
				review
			};
		}
	}
	resolveExactRoleCaller(caller) {
		if (this.ctx.agents.get(caller.id) !== caller) throw new AutoLabRuntimeError(`Session ${String(caller.id)} is not a live AutoLab role Agent`, "ROLE_MISMATCH");
		const matches = [];
		for (const state of this.view.values()) for (const [roleId, role] of Object.entries(state.roles)) {
			if (role.sessionId !== String(caller.id)) continue;
			const handle = this.roleHandles.get(roleHandleKey(state.labId, roleId));
			const borrowed = this.borrowedRoleAgents.get(roleHandleKey(state.labId, roleId));
			if (handle?.agent === caller && handle.sessionId === caller.id || borrowed === caller) matches.push({
				state,
				roleId,
				...role.activationBlocker === void 0 ? {} : { activationBlocker: role.activationBlocker }
			});
		}
		if (matches.length !== 1) throw new AutoLabRuntimeError(`Session ${String(caller.id)} does not resolve to exactly one owned AutoLab role`, "ROLE_MISMATCH");
		const match = matches[0];
		if (match.activationBlocker !== void 0) throw new AutoLabRuntimeError(`Role ${match.roleId} is unavailable: ${match.activationBlocker.message}`, "ROLE_ACTIVATION_UNAVAILABLE");
		return {
			state: match.state,
			roleId: match.roleId
		};
	}
	resolveApiRecoveryAssignment(agent) {
		const controllerGoal = this.ctx.goals.get(agent);
		const controllerMatches = [...this.view.values()].filter((state$1) => state$1.controllerSessionId === String(agent.id) && state$1.controllerGoal?.status === "applied" && state$1.controllerGoal.goalId !== void 0 && state$1.controllerGoal.goalRevision !== void 0 && controllerGoal !== void 0 && String(controllerGoal.id) === state$1.controllerGoal.goalId && sha256(controllerGoal.objective) === state$1.controllerGoal.objectiveHash);
		if (controllerMatches.length === 1) {
			const state$1 = controllerMatches[0];
			const install$1 = state$1.controllerGoal;
			if (state$1.config !== void 0) return {
				labId: state$1.labId,
				roleId: install$1.roleId,
				sessionId: String(agent.id),
				assignmentId: install$1.assignmentId,
				packetHash: install$1.packetHash,
				continuation: {
					kind: "goal",
					goalRef: {
						id: GoalId(install$1.goalId),
						revision: install$1.goalRevision
					},
					objectiveHash: install$1.objectiveHash
				}
			};
		}
		let located;
		try {
			located = this.resolveExactRoleCaller(agent);
		} catch {
			return;
		}
		const { state, roleId } = located;
		const role = state.roles[roleId];
		if (role === void 0) return void 0;
		const reviews = Object.values(state.reviews).filter((review) => review.phase === "reviewing" && !reviewHasOutput(review) && review.capability.judgeRoleId === roleId && review.capability.judgeSessionId === String(agent.id));
		if (reviews.length === 1) {
			const review = reviews[0];
			return {
				labId: state.labId,
				roleId,
				sessionId: String(agent.id),
				assignmentId: review.capability.assignmentId,
				packetHash: review.capability.packetHash,
				continuation: {
					kind: "review",
					reviewId: review.capability.reviewId,
					reviewAnchorHash: review.capability.negotiatedAnchorHash
				}
			};
		}
		const install = role.goalInstall;
		if (reviews.length !== 0 || role.packet === void 0 || install?.status !== "applied" || install.goalId === void 0 || install.goalRevision === void 0) return void 0;
		return {
			labId: state.labId,
			roleId,
			sessionId: String(agent.id),
			assignmentId: install.assignmentId,
			packetHash: role.packet.hash,
			continuation: {
				kind: "goal",
				goalRef: {
					id: GoalId(install.goalId),
					revision: install.goalRevision
				},
				objectiveHash: install.objectiveHash
			}
		};
	}
	async resumeApiReviewOnce(agent, wake, signal) {
		signal.throwIfAborted();
		const located = this.findActiveReview(wake.reviewId);
		if (located === void 0) return "stale";
		const { state, review } = located;
		const capability = review.capability;
		if (state.labId !== wake.labId || review.phase !== "reviewing" || reviewHasOutput(review) || capability.judgeRoleId !== wake.roleId || capability.judgeSessionId !== wake.sessionId || capability.judgeSessionId !== String(agent.id) || capability.assignmentId !== wake.assignmentId || capability.packetHash !== wake.packetHash || capability.negotiatedAnchorHash !== wake.reviewAnchorHash) return "stale";
		return await this.startJudgeReviewOnce({
			...reviewJudgeStart(capability),
			wakeId: wake.wakeId
		}, signal);
	}
	async notifyOperatorIncident(record) {
		if (!this.accepting || this.shutdown.signal.aborted) return;
		const state = this.view.get(record.labId);
		if (state === void 0) return;
		const controller = this.ctx.agents.get(SessionId(state.controllerSessionId));
		if (controller === void 0) {
			this.ctx.logger.warn(`AutoLab ${record.labId} retained API incident for offline Controller ${state.controllerSessionId}`);
			return;
		}
		const id = MessageId(`autolab-api-incident:${sha256(canonicalJson$1(record))}`);
		if (!(controller.inbox.nextTurn.some((message) => message.id === id) || controller.inbox.nextStep.some((message) => message.id === id) || controller.session.events.some((event) => event.type === "user/message" && event.data.id === id))) controller.followup(freezeMessage({
			id,
			role: "user",
			content: [{
				type: "text",
				text: [
					`AutoLab ${record.labId} exhausted its safe mechanical API recovery path.`,
					"The exact active incident follows; decide only the credential, configuration, quota, authorization, or request change it requires.",
					canonicalJson$1(record)
				].join("\n")
			}],
			source: {
				kind: "plugin",
				plugin: "dsh-autolab",
				form: "notice",
				summary: `AutoLab API incident ${record.labId}`
			}
		}));
		await flushSessionDurably(this.ctx, controller.session, "AutoLab operator incident");
	}
	async dispatchReviewRequest(caller, capability, signal) {
		const receipt = await sendReviewRequest(this.ctx, caller, capability, signal);
		if (receipt.status === "failed" || receipt.status === "expired") throw new AutoLabRuntimeError(`Review ${capability.reviewId} transport is ${receipt.status}; its persisted scientific state is unchanged`, "REVIEW_TRANSPORT_FAILED");
	}
	async syncDialogue(caller, state) {
		await this.dialogue.appendSessionEvents({
			labId: state.labId,
			controllerSessionId: state.controllerSessionId,
			events: caller.session?.events ?? []
		});
	}
	isControllerAgent(agent) {
		return this.ctx.agents.get(agent.id) === agent && [...this.view.values()].some((state) => state.controllerSessionId === String(agent.id));
	}
	attachControllerSurface(agent) {
		if (!this.isControllerAgent(agent)) return;
		const sessionId = String(agent.id);
		const existing = this.controllerSurfaces.get(sessionId);
		if (existing?.agent === agent) return;
		existing?.dispose();
		const dispose = installControllerSurface(agent, this, () => this.controllerKernelText(sessionId));
		this.controllerSurfaces.set(sessionId, {
			agent,
			dispose
		});
	}
	controllerKernelText(sessionId) {
		const labs = [...this.view.values()].filter((state) => state.controllerSessionId === sessionId).sort((left, right) => left.labId.localeCompare(right.labId));
		const owned = labs.length === 0 ? "- no current AutoLab binding" : labs.map((state) => {
			const directory = this.artifacts.labDirectory(state.labId);
			const source = state.config === void 0 ? join(directory, "draft") : join(directory, state.config.revisionPath);
			return `- ${state.labId}: ${state.lifecycle}; authoritative documents: ${source}`;
		}).join("\n");
		return [
			rolePromptFor("controller").text,
			"Controller-scoped AutoLab tools are available only in this existing Session. AutoLabWait is the only waiting primitive; it pauses the native Goal and never polls.",
			"Labs owned by this exact Session:",
			owned
		].join("\n\n");
	}
	trackAttemptTask(task) {
		this.attemptTasks.add(task);
		task.catch((error) => {
			if (!this.shutdown.signal.aborted) this.ctx.logger.warn(`AutoLab deferred an Attempt event: ${renderError(error)}`);
		}).finally(() => this.attemptTasks.delete(task));
	}
	/** Dispatch only materialized active references; never scan run directories or history. */
	async dispatchAllActiveAttempts(edge) {
		const runtime = this.requireAttemptRuntime();
		const targets = [...this.view.values()].flatMap((state) => Object.entries(state.trials).flatMap(([trialId, trial]) => Object.entries(trial.runSlots).flatMap(([runSlotId, slot]) => slot.activeAttempt === void 0 ? [] : [{
			labId: state.labId,
			trialId,
			runSlotId
		}]))).sort((left, right) => left.labId.localeCompare(right.labId) || left.trialId.localeCompare(right.trialId) || left.runSlotId.localeCompare(right.runSlotId));
		const settled = await Promise.allSettled(targets.map((target) => runtime.dispatch(target, edge)));
		for (const result of settled) if (result.status === "rejected" && !this.shutdown.signal.aborted) this.ctx.logger.warn(`AutoLab kept one active Attempt pending: ${renderError(result.reason)}`);
	}
	/** Apply at most one exact Attempt projection, then deliver its high-value event. */
	async applyAttemptRuntimeResult(result) {
		if (result.outcome !== "handled") return;
		const target = result.target;
		const projection = result.projection;
		if (projection !== void 0) {
			let retryFromNewProjection = false;
			await this.enqueue(target.labId, async () => {
				const state$1 = this.requireState(target.labId);
				const trial = state$1.trials[target.trialId];
				const slot = trial?.runSlots[target.runSlotId];
				const currentReference = slot?.activeAttempt;
				if (trial === void 0 || slot === void 0 || currentReference === void 0) return;
				if (canonicalJson$1(currentReference) === canonicalJson$1(projection.activeAttempt) && canonicalJson$1(slot.state) === canonicalJson$1(projection.runSlotState)) return;
				if (state$1.runtimeRevision !== projection.expectedRuntimeRevision || canonicalJson$1(currentReference) !== canonicalJson$1(projection.expectedActiveAttempt)) {
					retryFromNewProjection = canonicalJson$1(currentReference) === canonicalJson$1(projection.expectedActiveAttempt);
					return;
				}
				const trials = structuredClone(state$1.trials);
				trials[target.trialId].runSlots[target.runSlotId] = {
					...trials[target.trialId].runSlots[target.runSlotId],
					state: projection.runSlotState,
					activeAttempt: projection.activeAttempt
				};
				await this.transition(state$1, state$1.lifecycle, void 0, void 0, void 0, void 0, void 0, trials);
			});
			if (retryFromNewProjection && this.accepting) {
				this.trackAttemptTask(this.requireAttemptRuntime().dispatch(target, "poke"));
				return;
			}
		}
		let state = this.view.get(target.labId);
		const current = state?.trials[target.trialId]?.runSlots[target.runSlotId]?.activeAttempt;
		if (state === void 0 || current === void 0) return;
		if (projection !== void 0 && canonicalJson$1(current) !== canonicalJson$1(projection.activeAttempt)) return;
		if (state.lifecycle !== "running" && state.lifecycle !== "blocked") return;
		const attemptId = current.attemptId;
		if (result.controllerWake !== void 0 && result.controllerWake.controllerSessionId === state.controllerSessionId && result.controllerWake.attemptId === attemptId && result.controllerWake.phase === current.phase) {
			state = await this.wakeControllerForEvent(state, `attempt:${attemptId}:${current.phase}`, [
				`AutoLab ${state.labId} Attempt ${attemptId} reached ${current.phase}.`,
				`Trial ${target.trialId}; RunSlot ${target.runSlotId}.`,
				"Read the exact Attempt and Lab-authored evidence paths from RuntimeState and the frozen artifacts before deciding Postflight or recovery work."
			].join("\n"));
			return;
		}
		const escalation = attemptEscalation(result);
		if (escalation === void 0) return;
		await this.wakeControllerForEvent(state, `attempt-runtime:${attemptId}:${escalation.code}`, [
			`AutoLab ${state.labId} Attempt ${attemptId} exhausted its bounded mechanical edge.`,
			`Trial ${target.trialId}; RunSlot ${target.runSlotId}.`,
			`${escalation.code}: ${escalation.message}`,
			"Assign Ops or decide the required environment, process, identity, credential, or authorization change; do not infer a scientific result from this incident."
		].join("\n"));
	}
	trackControllerTask(task) {
		this.controllerTasks.add(task);
		task.catch((error) => {
			if (!this.shutdown.signal.aborted) this.ctx.logger.warn(`AutoLab deferred a Controller mechanical action: ${renderError(error)}`);
		}).finally(() => this.controllerTasks.delete(task));
	}
	async reconcileControllerAgent(agent) {
		if (!this.accepting || this.ctx.agents.get(agent.id) !== agent) return;
		const labIds = [...this.view.values()].filter((state) => state.controllerSessionId === String(agent.id)).map((state) => state.labId).sort();
		for (const labId of labIds) await this.enqueue(labId, async () => {
			let state = this.requireState(labId);
			if (state.controllerSessionId !== String(agent.id)) return;
			if (state.config === void 0) return;
			const frozen = await this.artifacts.readCurrent(labId);
			if (!sameConfigRef(state.config, frozen.ref)) throw new AutoLabRuntimeError(`Lab ${labId} CURRENT does not match RuntimeState during Controller attach`, "CONFIG_DRIFT");
			if (state.lifecycle === "running" || state.lifecycle === "starting" || state.lifecycle === "blocked") {
				state = await this.armControllerGoal(agent, state, frozen);
				await this.replayRecordedReviewNotifications(state);
				return;
			}
			if (state.lifecycle === "paused" || state.lifecycle === "pausing" || state.lifecycle === "stopped") {
				const paused = await this.pauseControllerNativeGoal(agent, state);
				if (paused.controllerGoal !== state.controllerGoal) state = await this.transition(state, state.lifecycle, void 0, void 0, void 0, void 0, void 0, void 0, paused.controllerGoal);
			}
		});
	}
	/** Recover only missing stable review notices from the small RuntimeState. */
	async replayRecordedReviewNotifications(state) {
		const recorded = Object.entries(state.reviews).filter(([, review]) => reviewHasOutput(review)).sort((left, right) => left[1].updatedAt - right[1].updatedAt || left[0].localeCompare(right[0]));
		for (const [reviewId, review] of recorded) if (review.stage === "preflight" && review.verdict !== void 0) state = await this.wakeControllerForEvent(state, `preflight-verdict:${reviewId}:${review.verdict.hash}`, [`AutoLab ${state.labId} Preflight review ${reviewId} recorded ${review.verdict.topLevelVerdict}.`, `Read the complete original verdict at ${review.verdict.path} (sha256 ${review.verdict.hash}) and decide the next responsibility from CURRENT.`].join("\n"));
		else if (review.stage === "postflight" && review.result !== void 0) state = await this.wakeControllerForEvent(state, `postflight-result:${reviewId}:${review.result.hash}`, postflightControllerEventText(state.labId, reviewId, review.result.path, review.result.hash));
		const receipts = Object.entries(state.roles).flatMap(([roleId, role]) => role.receipt === void 0 ? [] : [{
			roleId,
			receipt: role.receipt
		}]).sort((left, right) => left.receipt.recordedAt - right.receipt.recordedAt || left.roleId.localeCompare(right.roleId));
		for (const { roleId, receipt } of receipts) state = await this.wakeControllerForEvent(state, `role-result:${roleId}:${receipt.assignmentId}:${receipt.hash}`, roleResultControllerEventText(state.labId, roleId, receipt.assignmentId, receipt.path, receipt.hash));
		return state;
	}
	async finalizeRoleResultNotification(caller, result, artifactPath, artifactHash) {
		try {
			await pauseLocalGoalContinuation(this.ctx, String(caller.id));
		} catch {
			try {
				this.ctx.goals.disarm(caller);
			} catch {}
		}
		await this.enqueue(result.labId, async () => {
			const state = this.requireState(result.labId);
			const role = state.roles[result.roleId];
			if (role?.phase !== "paused" || role.receipt?.assignmentId !== result.assignmentId || role.receipt.path !== artifactPath || role.receipt.hash !== artifactHash) throw new AutoLabRuntimeError(`Role ${result.roleId} result notification lost its durable receipt`, "CONFIG_DRIFT");
			await this.wakeControllerForEvent(state, `role-result:${result.roleId}:${result.assignmentId}:${artifactHash}`, roleResultControllerEventText(result.labId, result.roleId, result.assignmentId, artifactPath, artifactHash));
		});
	}
	async trackControllerGoalChange(agent, goalId, goalRevision, goal) {
		if (!this.accepting || this.ctx.agents.get(agent.id) !== agent) return;
		const matches = [...this.view.values()].filter((state) => state.controllerSessionId === String(agent.id) && state.controllerGoal?.goalId === goalId && (goal === void 0 || sha256(goal.objective) === state.controllerGoal.objectiveHash));
		for (const snapshot of matches) await this.enqueue(snapshot.labId, async () => {
			const state = this.requireState(snapshot.labId);
			const stored = state.controllerGoal;
			if (stored?.goalId !== goalId || stored.goalRevision === goalRevision || goal !== void 0 && sha256(goal.objective) !== stored.objectiveHash) return;
			await this.transition(state, state.lifecycle, void 0, void 0, void 0, void 0, void 0, void 0, {
				...stored,
				goalRevision
			});
		});
	}
	/** Keep only the native Goal CAS ref current for one exact AutoLab role. */
	async trackRoleGoalChange(agent, goal) {
		if (!this.accepting || this.ctx.agents.get(agent.id) !== agent) return;
		const edge = {
			sessionId: String(agent.id),
			goalId: String(goal.id),
			goalRevision: goal.revision,
			objectiveHash: sha256(goal.objective)
		};
		const matches = [...this.view.values()].flatMap((state) => {
			const projected = projectRoleGoalRevision(state, edge);
			return projected === void 0 ? [] : [{
				state,
				projected
			}];
		});
		if (matches.length !== 1) return;
		const snapshot = matches[0];
		await this.enqueue(snapshot.state.labId, async () => {
			const state = this.requireState(snapshot.state.labId);
			const projected = projectRoleGoalRevision(state, edge);
			if (projected === void 0) return;
			await this.transition(state, state.lifecycle, void 0, void 0, projected.roles);
		});
	}
	/** Resume the same paused Controller Goal from one durable scientific event. */
	async wakeControllerForEvent(state, eventId, text) {
		let stored = state.controllerGoal;
		if (stored?.status !== "applied" || stored.goalId === void 0) return state;
		const controller = this.ctx.agents.get(SessionId(state.controllerSessionId));
		if (controller === void 0) return state;
		const messageId = MessageId(`autolab-event:${sha256(`${state.labId}\0${eventId}`)}`);
		if (controller.inbox.nextTurn.some((message) => message.id === messageId) || controller.inbox.nextStep.some((message) => message.id === messageId) || controller.session.events.some((event) => event.type === "user/message" && event.data.id === messageId)) return state;
		if (stored.waiting === true) {
			const { waiting: _waiting,...resumable } = stored;
			state = await this.transition(state, state.lifecycle, void 0, void 0, void 0, void 0, void 0, void 0, resumable);
			stored = resumable;
		}
		const recoveryOwnsGoal = this.controllerApiRecoveryOwnsGoal(state);
		let goal = this.ctx.goals.get(controller);
		if (goal === void 0 || String(goal.id) !== stored.goalId || sha256(goal.objective) !== stored.objectiveHash) return state;
		if (!recoveryOwnsGoal && (goal.phase !== "active" || goal.activation !== "armed")) {
			if (goal.phase === "complete" || goal.roundsStarted >= goal.maxGoalRounds) return state;
			goal = this.ctx.goals.resume(controller, goalRef(goal));
			try {
				await flushSessionDurably(this.ctx, controller.session, "Controller event Goal resume");
			} catch (error) {
				if (error instanceof SessionDurabilityError) throw error;
				const applied = this.ctx.goals.get(controller);
				if (applied === void 0 || applied.id !== goal.id || applied.revision !== goal.revision) throw error;
				await flushSessionDurably(this.ctx, controller.session, "Controller event Goal resume retry");
			}
			state = await this.transition(state, state.lifecycle, void 0, void 0, void 0, void 0, void 0, void 0, {
				...stored,
				goalRevision: goal.revision
			});
		}
		controller.inject(freezeMessage({
			id: messageId,
			role: "user",
			content: [{
				type: "text",
				text
			}],
			source: {
				kind: "plugin",
				plugin: "dsh-autolab",
				form: "notice",
				summary: `AutoLab event ${state.labId}`
			}
		}));
		await flushSessionDurably(this.ctx, controller.session, "Controller event delivery");
		return state;
	}
	runReviewControlHandler(operation) {
		if (!this.accepting || this.shutdown.signal.aborted) return Promise.reject(new AutoLabRuntimeError("AutoLab Controller is not accepting review control work", "SERVICE_CLOSED"));
		let task;
		task = Promise.resolve().then(async () => {
			this.assertReady();
			this.shutdown.signal.throwIfAborted();
			return await operation();
		}).finally(() => {
			this.reviewControlTasks.delete(task);
		});
		this.reviewControlTasks.add(task);
		return task;
	}
	teardown() {
		if (this.teardownTask !== void 0) return this.teardownTask;
		this.teardownTask = this.performTeardown();
		return this.teardownTask;
	}
	async performTeardown() {
		const errors = [];
		const capture = async (operation) => {
			try {
				await operation();
			} catch (error) {
				errors.push(error);
			}
		};
		this.accepting = false;
		const attemptRuntime = this.attemptRuntime;
		this.attemptRuntime = void 0;
		attemptRuntime?.dispose();
		const attemptPoke = this.attemptPoke;
		this.attemptPoke = void 0;
		const attemptPokeClose = attemptPoke?.close();
		this.apiRecovery?.dispose();
		this.apiRecovery = void 0;
		const removeSubmissionTools = this.removeSubmissionTools;
		this.removeSubmissionTools = void 0;
		if (removeSubmissionTools !== void 0) try {
			removeSubmissionTools();
		} catch (error) {
			errors.push(error);
		}
		for (const key of [
			"removeControllerGoalListener",
			"removeControllerDisposedListener",
			"removeControllerCreatedListener"
		]) {
			const remove = this[key];
			this[key] = void 0;
			if (remove === void 0) continue;
			try {
				remove();
			} catch (error) {
				errors.push(error);
			}
		}
		const removeStatus = this.removeReviewStatusListener;
		this.removeReviewStatusListener = void 0;
		if (removeStatus !== void 0) try {
			removeStatus();
		} catch (error) {
			errors.push(error);
		}
		this.shutdown.abort(new AutoLabRuntimeError("AutoLab Controller is shutting down", "SERVICE_CLOSED"));
		await Promise.allSettled([...this.reviewControlTasks]);
		this.reviewControlTasks.clear();
		await Promise.allSettled([...this.reviewStatusTasks]);
		this.reviewStatusTasks.clear();
		await Promise.allSettled([...this.reviewHoldTasks.values()]);
		this.reviewHoldTasks.clear();
		await Promise.allSettled([...this.controllerTasks]);
		this.controllerTasks.clear();
		await Promise.allSettled([...this.attemptTasks]);
		this.attemptTasks.clear();
		if (attemptRuntime !== void 0) await capture(() => attemptRuntime.drain());
		if (attemptPokeClose !== void 0) await capture(() => attemptPokeClose);
		await Promise.allSettled([...this.operationTails.values()]);
		this.operationTails.clear();
		await this.apiRecoveryStore?.drain();
		const holds = [...this.reviewHolds.values()];
		this.reviewHolds.clear();
		await Promise.allSettled(holds.map((hold) => hold.release()));
		const handles = [...this.roleHandles.values()];
		const attached = /* @__PURE__ */ new Map();
		for (const handle of handles) attached.set(String(handle.sessionId), handle.agent);
		for (const agent of this.borrowedRoleAgents.values()) attached.set(String(agent.id), agent);
		await Promise.allSettled([...attached.keys()].map((sessionId) => pauseLocalGoalContinuation(this.ctx, sessionId)));
		this.borrowedRoleAgents.clear();
		this.roleHandles.clear();
		await Promise.allSettled(handles.map((handle) => handle.dispose()));
		const controllerSurfaces = [...this.controllerSurfaces.values()];
		this.controllerSurfaces.clear();
		for (const { agent } of controllerSurfaces) if (this.ctx.agents.get(agent.id) === agent) this.ctx.goals.disarm(agent);
		for (const { dispose } of controllerSurfaces.reverse()) try {
			dispose();
		} catch (error) {
			errors.push(error);
		}
		const removeHandlers = this.removeReviewControlHandlers;
		this.removeReviewControlHandlers = void 0;
		if (removeHandlers !== void 0) try {
			removeHandlers();
		} catch (error) {
			errors.push(error);
		}
		const domain = this.domain;
		if (domain !== void 0) await capture(() => domain.close());
		if (this.domain === domain) this.domain = void 0;
		this.table = void 0;
		this.apiRecoveryStore = void 0;
		this.view.clear();
		const owner = this.owner;
		if (owner !== void 0) await capture(() => owner.release());
		if (this.owner === owner) this.owner = void 0;
		if (errors.length > 0) throw new AggregateError(errors, "AutoLab Controller teardown failed");
	}
	enqueue(labId, operation) {
		this.assertReady();
		const run = (this.operationTails.get(labId) ?? Promise.resolve()).then(operation);
		const tail = run.then(() => void 0, () => void 0);
		this.operationTails.set(labId, tail);
		tail.finally(() => {
			if (this.operationTails.get(labId) === tail) this.operationTails.delete(labId);
		});
		return run;
	}
	requireState(labId) {
		const state = this.view.get(labId);
		if (state === void 0) throw new AutoLabRuntimeError(`Lab ${labId} was not found`, "LAB_NOT_FOUND");
		return state;
	}
	assertControllerSession(caller, state) {
		if (String(caller.id) !== state.controllerSessionId) throw new AutoLabRuntimeError(`Session ${String(caller.id)} is not the Controller of Lab ${state.labId}`, "CONTROLLER_MISMATCH");
	}
	assertReady() {
		if (!this.accepting) throw new AutoLabRuntimeError("AutoLab Controller is not accepting work", "SERVICE_CLOSED");
	}
	requireAttemptRuntime() {
		if (this.attemptRuntime === void 0) throw new AutoLabRuntimeError("Attempt Runtime is unavailable", "SERVICE_CLOSED");
		return this.attemptRuntime;
	}
	requireOwner() {
		if (this.owner === void 0) throw new AutoLabRuntimeError("AutoLab Controller has no owner lock", "SERVICE_CLOSED");
		return this.owner;
	}
	requireTable() {
		if (this.table === void 0) throw new AutoLabRuntimeError("AutoLab Controller domain is closed", "SERVICE_CLOSED");
		return this.table;
	}
};
const name = "autolab-runtime";
const inject = AutoLabRuntime.inject;
const Config = AutoLabRuntime.Config;
async function apply(ctx, config) {
	const fiber = ctx.plugin(AutoLabRuntime, config);
	await fiber;
	return fiber.dispose;
}
var src_default = AutoLabRuntime;
function cloneState(state) {
	return structuredClone(state);
}
function goalRef(goal) {
	return {
		id: goal.id,
		revision: goal.revision
	};
}
function sameConfigRef(left, right) {
	return left !== void 0 && left.revision === right.revision && left.revisionPath === right.revisionPath && left.specHash === right.specHash && left.configHash === right.configHash && left.manifestHash === right.manifestHash && left.dialogueHeadHash === right.dialogueHeadHash;
}
function renderError(value) {
	if (value instanceof ArtifactError) return `${value.code}: ${value.message}`;
	return value instanceof Error ? value.message : String(value);
}
function controlReceiptFailed(receipt) {
	return receipt.status === "failed" || receipt.status === "expired" || receipt.outcome?.status === "failed" || receipt.outcome?.status === "rejected";
}
function controlReceiptFailure(receipt) {
	return receipt.outcome?.status ?? receipt.status;
}
function rethrowCoderBoundary(error, stage) {
	if (error instanceof AutoLabRuntimeError || isAbortError(error)) throw error;
	let code = stage === "capture" ? "OPERATION_FAILED" : "CONFIG_DRIFT";
	if (error instanceof CandidateSnapshotError) code = error.code === "GIT_FAILED" || error.code === "IO_FAILED" ? "OPERATION_FAILED" : "CONFIG_DRIFT";
	else if (error instanceof CoderReceiptError) code = error.code === "IO_FAILED" ? "OPERATION_FAILED" : stage === "capture" && (error.code === "RECEIPT_READ_FAILED" || error.code === "INVALID_RECEIPT" || error.code === "ANCHOR_MISMATCH" || error.code === "HASH_MISMATCH") ? "IMPLEMENTATION_NOT_READY" : error.code === "ARTIFACT_WRITE_FAILED" ? "OPERATION_FAILED" : "CONFIG_DRIFT";
	else if (error instanceof CoderSubmissionError || error instanceof ActivationArtifactError) code = "CONFIG_DRIFT";
	else if (error instanceof WorktreeError) code = error.code === "GIT_FAILED" ? "OPERATION_FAILED" : "CONFIG_DRIFT";
	else if (error instanceof LocalGoalError) code = error.code === "INVALID_INTENT" || error.code === "STALE_GOAL" ? "CONFIG_DRIFT" : "OPERATION_FAILED";
	throw new AutoLabRuntimeError(`Coder submission ${stage} failed: ${renderError(error)}`, code);
}
function isAbortError(value) {
	return value instanceof Error && value.name === "AbortError";
}
function findCreateBoundary(events) {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event?.type !== "command/run" || typeof event.data !== "object" || event.data === null || !("name" in event.data) || event.data.name !== "autolab") continue;
		return event.seq;
	}
	return events.at(-1)?.seq ?? 0;
}
function startingRoleProjection(state, manifest, workers) {
	const expected = new Set(workers.map((role) => role.role_id));
	for (const roleId of Object.keys(state.roles)) if (!expected.has(roleId)) throw new AutoLabRuntimeError(`RuntimeState contains role ${JSON.stringify(roleId)} outside CURRENT`, "CONFIG_DRIFT");
	return Object.fromEntries(workers.map((role) => {
		const sessionId = role.prebound_session_id ?? `autolab:${manifest.lab_id}:${sha256(role.role_id).slice(0, 24)}`;
		const previous = state.roles[role.role_id];
		if (previous !== void 0 && previous.sessionId !== sessionId) throw new AutoLabRuntimeError(`Role ${role.role_id} SessionId does not match CURRENT`, "CONFIG_DRIFT");
		return [role.role_id, { ...previous ?? {
			sessionId,
			phase: "starting"
		} }];
	}));
}
function assertStartingRoleProjection(state, workers) {
	const expected = new Set(workers.map((role) => role.role_id));
	if (Object.keys(state.roles).length !== expected.size) throw new AutoLabRuntimeError("Starting role projection is incomplete", "CONFIG_DRIFT");
	for (const role of workers) {
		const projected = state.roles[role.role_id];
		if (projected === void 0 || role.prebound_session_id !== void 0 && projected.sessionId !== role.prebound_session_id) throw new AutoLabRuntimeError(`Starting role ${role.role_id} does not match CURRENT`, "CONFIG_DRIFT");
	}
}
function roleHandleKey(labId, roleId) {
	return `${labId}\0${roleId}`;
}
function reviewHoldKey(labId, reviewId) {
	return `${labId}\0${reviewId}`;
}
function roleGoalRoundLimit(role) {
	if ("max_goal_rounds" in role) return role.max_goal_rounds;
	throw new AutoLabRuntimeError(`Reactive role ${role.role_id} cannot receive a Goal install`, "CONFIG_DRIFT");
}
function deterministicReviewId(parts) {
	const digits = sha256(`autolab-review-id-v1\0${parts.join("\0")}`).slice(0, 32).split("");
	digits[12] = "5";
	digits[16] = (Number.parseInt(digits[16], 16) & 3 | 8).toString(16);
	const value = digits.join("");
	return [
		value.slice(0, 8),
		value.slice(8, 12),
		value.slice(12, 16),
		value.slice(16, 20),
		value.slice(20)
	].join("-");
}
function roleSubmissionResult(labId, capability, phase) {
	return {
		labId,
		roleId: capability.workerRoleId,
		assignmentId: capability.assignmentId,
		reviewId: capability.reviewId,
		phase
	};
}
function preflightVerdictResult(labId, roleId, reviewId, assignmentId, phase, verdict) {
	return {
		labId,
		roleId,
		assignmentId,
		reviewId,
		phase,
		verdict
	};
}
function coderImplementationResult(labId, candidate) {
	return {
		labId,
		roleId: candidate.coderRoleId,
		assignmentId: candidate.assignmentId,
		candidateId: candidate.candidateId,
		candidateSha: candidate.candidateSha,
		phase: "candidate_frozen"
	};
}
function controllerApplyPreflightResult(labId, reviewId, coderRoleId) {
	return {
		labId,
		reviewId,
		coderRoleId,
		assignmentId: `coder:${reviewId}`,
		phase: "coder_working"
	};
}
function controllerAssignRoleResult(labId, roleId, assignmentId, phase) {
	return {
		labId,
		roleId,
		assignmentId,
		phase
	};
}
function controllerAssignMethodResult(labId, methodRoleId, assignmentId, sourceReviewId) {
	return {
		labId,
		methodRoleId,
		assignmentId,
		...sourceReviewId === void 0 ? {} : { sourceReviewId },
		phase: "working"
	};
}
function controllerRequestPostflightResult(labId, review, phase) {
	return {
		labId,
		reviewId: review.capability.reviewId,
		assignmentId: review.capability.assignmentId,
		coderRoleId: review.capability.workerRoleId,
		judgeRoleId: review.capability.judgeRoleId,
		phase
	};
}
function postflightResultSubmission(labId, roleId, reviewId, assignmentId) {
	return {
		labId,
		roleId,
		assignmentId,
		reviewId,
		phase: "result_recorded"
	};
}
function autoLabRoleResultSubmission(labId, roleId, assignmentId) {
	return {
		labId,
		roleId,
		assignmentId,
		phase: "receipt_recorded"
	};
}
function postflightControllerEventText(labId, reviewId, artifactPath, artifactHash) {
	return [`AutoLab ${labId} Postflight review ${reviewId} recorded its Lab-native result.`, `Read the complete original result at ${artifactPath} (sha256 ${artifactHash}) and decide the next responsibility from CURRENT.`].join("\n");
}
function roleResultControllerEventText(labId, roleId, assignmentId, artifactPath, artifactHash) {
	return [`AutoLab ${labId} role ${roleId} recorded Assignment ${assignmentId}.`, `Read the complete original receipt at ${artifactPath} (sha256 ${artifactHash}) and decide the next responsibility from CURRENT.`].join("\n");
}
function parseControllerAttemptInput(input) {
	const trialContract = parseJsonArgument(input.trialContractJson, "trialContractJson");
	const runSlotsValue = parseJsonArgument(input.runSlotsJson, "runSlotsJson");
	const commandValue = parseJsonArgument(input.commandJson, "commandJson");
	const envValue = parseJsonArgument(input.envJson, "envJson");
	if (!Array.isArray(runSlotsValue) || runSlotsValue.length === 0) throw new AutoLabRuntimeError("runSlotsJson must be a non-empty JSON array", "NOT_READY");
	const runSlots = runSlotsValue.map((value, index) => {
		if (!isRecord(value) || typeof value.runSlotId !== "string" || value.runSlotId.length === 0) throw new AutoLabRuntimeError(`runSlotsJson[${index}] requires a non-empty runSlotId`, "NOT_READY");
		return {
			runSlotId: value.runSlotId,
			...!Object.hasOwn(value, "contract") ? {} : { contract: value.contract }
		};
	});
	if (!Array.isArray(commandValue) || commandValue.length === 0 || commandValue.some((value) => typeof value !== "string" || value.length === 0)) throw new AutoLabRuntimeError("commandJson must be a non-empty JSON argv array", "NOT_READY");
	if (!isRecord(envValue) || Object.values(envValue).some((value) => typeof value !== "string")) throw new AutoLabRuntimeError("envJson must be a JSON object of string values", "NOT_READY");
	return {
		trialContract,
		runSlots,
		command: commandValue,
		env: envValue
	};
}
function parseRetryAttemptInput(input) {
	const command = parseJsonArgument(input.commandJson, "commandJson");
	const env = parseJsonArgument(input.envJson, "envJson");
	if (!Array.isArray(command) || command.length === 0 || command.some((value) => typeof value !== "string" || value.length === 0)) throw new AutoLabRuntimeError("commandJson must be a non-empty JSON argv array", "NOT_READY");
	if (!isRecord(env) || Object.values(env).some((value) => typeof value !== "string")) throw new AutoLabRuntimeError("envJson must be a JSON object of string values", "NOT_READY");
	return {
		command,
		env
	};
}
function parseRoleAssignmentReferences(value) {
	const parsed = parseJsonArgument(value, "inputArtifactRefsJson");
	if (!Array.isArray(parsed)) throw new AutoLabRuntimeError("inputArtifactRefsJson must be a JSON array", "NOT_READY");
	return parsed.map((reference, index) => {
		if (!isRecord(reference) || typeof reference.artifact_id !== "string" || typeof reference.path !== "string" || typeof reference.sha256 !== "string") throw new AutoLabRuntimeError(`inputArtifactRefsJson[${index}] requires artifact_id, path, and sha256 strings`, "NOT_READY");
		return {
			artifact_id: reference.artifact_id,
			path: reference.path,
			sha256: reference.sha256
		};
	});
}
/**
* Parse the `coder:<reviewId>:fix:<slug>` identity of a Coder fix Assignment.
* The embedded review id is the lineage: the APPROVED, resolved Preflight
* review whose candidate is being corrected. This keeps the fix's provenance
* deterministic without any new durable state field.
*/
function parseCoderFixAssignmentId(assignmentId) {
	const marker = ":fix:";
	const reviewStart = 6;
	const markerIndex = assignmentId.startsWith("coder:") ? assignmentId.indexOf(marker, reviewStart) : -1;
	if (markerIndex < 0) throw new AutoLabRuntimeError(`Coder fix Assignment ${JSON.stringify(assignmentId)} must be coder:<reviewId>:fix:<slug>`, "NOT_READY");
	const reviewId = assignmentId.slice(reviewStart, markerIndex);
	const slug = assignmentId.slice(markerIndex + 5);
	if (reviewId.trim().length === 0 || slug.trim().length === 0) throw new AutoLabRuntimeError(`Coder fix Assignment ${JSON.stringify(assignmentId)} requires a non-empty lineage review and slug`, "NOT_READY");
	return {
		reviewId,
		slug
	};
}
/** The fix mandate must carry the corrected candidate's identity. */
function extractFixCandidateId(content, assignmentId) {
	if (content === null || typeof content !== "object" || Array.isArray(content)) throw new AutoLabRuntimeError(`Coder fix Assignment ${JSON.stringify(assignmentId)} content must be a JSON object carrying candidate_id`, "NOT_READY");
	const candidateId = content.candidate_id;
	if (typeof candidateId !== "string" || candidateId.trim().length === 0) throw new AutoLabRuntimeError(`Coder fix Assignment ${JSON.stringify(assignmentId)} content must carry a non-empty candidate_id string`, "NOT_READY");
	return candidateId;
}
function controllerAssignCoderFixResult(labId, coderRoleId, assignmentId, reviewId) {
	return {
		labId,
		coderRoleId,
		assignmentId,
		reviewId,
		phase: "working"
	};
}
/**
* The live Goal currently installed on a role Session, or null. Used as the
* expectedGoalRef fallback when a projected goalInstall lost its goalId
* because its previous install attempt failed mid-flight: replacing the
* Session's current Goal is then exactly the intent of the retry.
*/
function assertRevisionTopologyUnchanged(current, next) {
	if (canonicalJson$1(current.roles) !== canonicalJson$1(next.roles) || canonicalJson$1(current.lanes) !== canonicalJson$1(next.lanes) || canonicalJson$1(current.repository) !== canonicalJson$1(next.repository) || canonicalJson$1(current.execution) !== canonicalJson$1(next.execution) || canonicalJson$1(current.communication) !== canonicalJson$1(next.communication)) throw new AutoLabRuntimeError("Configuration revision changes the frozen Lab topology (roles, lanes, worktrees, repository, execution, hosts, GPU pool, communication); topology is immutable in a revision", "CONFIG_DRIFT");
}
function currentLiveGoalRef(ctx, sessionId) {
	const agent = ctx.agents.get(SessionId(sessionId));
	if (agent === void 0) return null;
	const goal = ctx.goals.get(agent);
	if (goal === void 0) return null;
	return {
		id: GoalId(String(goal.id)),
		revision: goal.revision
	};
}
function parseJsonArgument(text, label) {
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new AutoLabRuntimeError(`${label} is not valid JSON: ${renderError(error)}`, "NOT_READY");
	}
}
function attemptLaunchResult(state, target) {
	const active = state.trials[target.trialId]?.runSlots[target.runSlotId]?.activeAttempt;
	if (active === void 0) throw new AutoLabRuntimeError(`Trial ${target.trialId} RunSlot ${target.runSlotId} lost its active Attempt`, "CONFIG_DRIFT");
	return {
		labId: state.labId,
		trialId: target.trialId,
		runSlotId: target.runSlotId,
		attemptId: active.attemptId,
		phase: active.phase
	};
}
function attemptEscalation(result) {
	if (result.reconcile.action === "blocked") return result.reconcile.blocker;
	if (result.reconcile.action === "pending" && result.edge === "pending-retry") return result.reconcile.pending;
	if (result.reconcile.action === "await_started_receipt" && result.edge === "launch-safety") return {
		code: "ATTEMPT_START_RECEIPT_PENDING",
		message: "the one launch-safety edge still found no durable started receipt"
	};
	if (result.reconcile.action === "launch_required" && result.launched) return {
		code: "ATTEMPT_LAUNCH_NOT_OBSERVED",
		message: "the launch action returned without a matching process or durable receipt"
	};
}
function assertLiveAssignmentGoal(ctx, caller, role, roleId, label) {
	if (!roleOwnsExactAssignmentGoal(role, ctx.goals.get(caller))) throw new AutoLabRuntimeError(`${label} role ${roleId} no longer owns its exact persisted Assignment Goal`, "IMPLEMENTATION_NOT_READY");
}
function selectApprovedCoderReview(state, coderRoleId, coder) {
	const install = coder.goalInstall;
	if (install === void 0) return void 0;
	const matches = Object.entries(state.reviews).filter(([reviewId, review]) => {
		if (review.stage !== "preflight" || review.verdict?.topLevelVerdict !== "APPROVED" || review.resolution?.targetRoleId !== coderRoleId || review.resolution.targetSessionId !== coder.sessionId || review.resolution.effect.kind !== "goal_install") return false;
		if (install.assignmentId === `coder:${reviewId}`) return review.resolution.effect.id === install.installId && review.resolution.effect.hash === install.objectiveHash;
		return install.assignmentId.startsWith(`coder:${reviewId}:fix:`);
	});
	return matches.length === 1 ? {
		reviewId: matches[0][0],
		review: matches[0][1]
	} : void 0;
}
function requireMethodRevisionReview(state, reviewId, methodRoleId, methodSessionId) {
	const review = state.reviews[reviewId];
	const verdict = review?.verdict;
	if (review?.stage !== "preflight" || review.phase !== "verdict_recorded" || review.capability.reviewId !== reviewId || review.capability.workerRoleId !== methodRoleId || review.capability.workerSessionId !== methodSessionId || verdict === void 0 || verdict.topLevelVerdict !== "REVISION_REQUIRED" && verdict.topLevelVerdict !== "REJECTED" || !reviewFreezeComplete(review, state.ownerEpoch)) throw new AutoLabRuntimeError(`Review ${reviewId} is not an exact frozen REVISION_REQUIRED or REJECTED Preflight review for Method ${methodRoleId}`, "REVIEW_NOT_READY");
	return review;
}
function selectJudgeReview(state, judgeRoleId) {
	const candidates = Object.entries(state.reviews).filter(([, review]) => review.capability.judgeRoleId === judgeRoleId);
	const pending = candidates.filter(([, review]) => !reviewHasOutput(review));
	if (pending.length > 1) return void 0;
	const selected = pending[0] ?? candidates.sort((left, right) => right[1].updatedAt - left[1].updatedAt || right[0].localeCompare(left[0]))[0];
	return selected === void 0 ? void 0 : {
		reviewId: selected[0],
		review: selected[1]
	};
}
function reviewHasOutput(review) {
	return review.verdict !== void 0 || review.result !== void 0;
}
/** Do not bind a Controller-initiated review across a newer open Coder turn. */
function lastCompletedAgentTurn(agent) {
	const boundary = agent.session.events.findLast((event) => event.type === "turn/start" || event.type === "turn/end");
	if (boundary?.type !== "turn/end" || !Number.isSafeInteger(boundary.data.turn) || boundary.data.turn <= 0) return void 0;
	return boundary.data.turn;
}
function sameReviewPauseReceipt(left, right) {
	return left.controlId === right.controlId && left.payloadHash === right.payloadHash && left.completedAt === right.completedAt && left.goalOutcome === right.goalOutcome && left.activeTurn === right.activeTurn && left.observedTurn === right.observedTurn && left.goalRef?.id === right.goalRef?.id && left.goalRef?.revision === right.goalRef?.revision;
}
function isReviewGoalRef(value) {
	return isRecord(value) && typeof value.id === "string" && value.id.length > 0 && Number.isSafeInteger(value.revision) && value.revision > 0;
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function recoverReviewFreezeProjection(state, ownerEpoch) {
	const now = Date.now();
	let changed = false;
	const reviews = Object.fromEntries(Object.entries(state.reviews).map(([reviewId, review]) => {
		const wedgedHeld = review.pause.freeze === "held" && review.pause.holdOwnerEpoch !== ownerEpoch;
		const wedgedPending = review.pause.freeze === "hold-pending";
		if (!wedgedHeld && !wedgedPending) return [reviewId, review];
		changed = true;
		const { holdOwnerEpoch: _oldOwner,...pause } = review.pause;
		return [reviewId, {
			...review,
			pause: {
				...pause,
				freeze: "stopped"
			},
			updatedAt: now
		}];
	}));
	if (!changed) return state;
	return transitionRuntimeState(state, {
		expectedRevision: state.runtimeRevision,
		ownerEpoch,
		lifecycle: state.lifecycle,
		reviews,
		now
	});
}

//#endregion
export { AutoLabRuntime, AutoLabRuntimeError, Config, apply, src_default as default, inject, name };