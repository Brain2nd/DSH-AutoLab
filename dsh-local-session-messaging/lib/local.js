import { i as validateControlKind, n as durableControlPayload, o as MessagingError, r as parseDurableControlPayload, s as canonicalJson } from "./control-nVzhVCO9.js";
import { n as SessionMessagingError, t as SessionMessaging } from "./service-D6Vwsad_.js";
import { i as MessagingDatabase, n as sendPoke, t as createPokeServer } from "./notifier-CoqB9SH5.js";
import { SessionId } from "@deepseek-ai/dsh-session";
import { Context, Service } from "@deepseek-ai/cordis";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { setTimeout } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import z from "@deepseek-ai/schemastery";
import { dshHomePath, expandHomePath } from "@deepseek-ai/dsh-home-paths";
import { MessageId, freezeMessage } from "@deepseek-ai/dsh-llm";

//#region src/local.ts
const DEFAULT_ROOT = dshHomePath("local-session-messaging");
const DEFAULT_HEARTBEAT_INTERVAL_MS = 1e3;
const DEFAULT_PRESENCE_TTL_MS = 5e3;
const DEFAULT_POLL_INTERVAL_MS = 1e3;
const DEFAULT_DELIVERY_LEASE_MS = 3e4;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_RETRY_MAX_MS = 1e4;
const DEFAULT_MESSAGE_TTL_MS = 10080 * 60 * 1e3;
const DEFAULT_MAX_ATTEMPTS = 20;
const DEFAULT_MAX_MESSAGE_BYTES = 256 * 1024;
const DEFAULT_ACK_WAIT_MS = 1500;
const DEFAULT_ACK_POLL_MS = 50;
const DEFAULT_SOCKET_TIMEOUT_MS = 500;
const POLICY_REVOKED_ERROR = "permission denied: policy changed before Inbox claim";
/** DSH-native local provider. One instance serves all root Agents in a process. */
var LocalSessionMessaging = class extends SessionMessaging {
	static inject = [
		"agents",
		"sessions",
		"sessionQuery",
		"sessionTitle",
		"timer"
	];
	static Config = z.object({
		root: z.string().default(DEFAULT_ROOT),
		heartbeatIntervalMs: z.number().step(1).min(50).default(DEFAULT_HEARTBEAT_INTERVAL_MS),
		presenceTtlMs: z.number().step(1).min(250).default(DEFAULT_PRESENCE_TTL_MS),
		pollIntervalMs: z.number().step(1).min(50).default(DEFAULT_POLL_INTERVAL_MS),
		deliveryLeaseMs: z.number().step(1).min(250).default(DEFAULT_DELIVERY_LEASE_MS),
		retryBaseMs: z.number().step(1).min(0).default(DEFAULT_RETRY_BASE_MS),
		retryMaxMs: z.number().step(1).min(1).default(DEFAULT_RETRY_MAX_MS),
		messageTtlMs: z.number().step(1).min(1e3).default(DEFAULT_MESSAGE_TTL_MS),
		maxAttempts: z.number().step(1).min(1).default(DEFAULT_MAX_ATTEMPTS),
		maxMessageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_MESSAGE_BYTES),
		ackWaitMs: z.number().step(1).min(0).default(DEFAULT_ACK_WAIT_MS),
		ackPollMs: z.number().step(1).min(1).default(DEFAULT_ACK_POLL_MS),
		socketTimeoutMs: z.number().step(1).min(1).default(DEFAULT_SOCKET_TIMEOUT_MS)
	});
	config;
	database;
	instanceId = randomUUID();
	processIdentity = currentProcessIdentity();
	bindings = /* @__PURE__ */ new Map();
	writerBindings = /* @__PURE__ */ new Map();
	pumps = /* @__PURE__ */ new Map();
	work = /* @__PURE__ */ new Set();
	permissionDiscards = /* @__PURE__ */ new Set();
	controlHandlers = /* @__PURE__ */ new Map();
	retiredControlKinds = /* @__PURE__ */ new Set();
	notifier;
	initialized = false;
	closed = false;
	closePromise;
	constructor(ctx, config) {
		super(ctx);
		this.config = resolveConfig(config);
		if (this.config.presenceTtlMs <= this.config.heartbeatIntervalMs * 2) throw new SessionMessagingError("presenceTtlMs must be greater than twice heartbeatIntervalMs", "INVALID_MESSAGE");
		if (this.config.retryMaxMs < this.config.retryBaseMs) throw new SessionMessagingError("retryMaxMs must be greater than or equal to retryBaseMs", "INVALID_MESSAGE");
		this.database = new MessagingDatabase({
			path: join(this.config.root, "mailbox.sqlite3"),
			maxPayloadBytes: this.config.maxMessageBytes + 16384
		});
		ctx.effect(() => () => this.close(), "local-session-messaging.lifecycle()");
	}
	/** Cordis awaits this before making the class plugin active. */
	async [Service.init]() {
		if (this.initialized) return;
		this.ensureNotClosed();
		this.notifier = await createPokeServer({
			socketDir: socketDirectory(this.config.root),
			socketName: `poke-${this.instanceId}.sock`,
			connectionTimeoutMs: this.config.socketTimeoutMs,
			onPoke: () => this.requestAllPumps(),
			onError: (error) => this.ctx.logger.warn(`local-session-messaging: notifier error: ${errorText(error)}`)
		});
		this.ctx.on("agent/created", ({ agent }) => {
			if (this.closed) return;
			this.attachSessionWriter(agent);
			if (this.isRoot(agent)) this.attachRoot(agent);
		});
		this.ctx.on("agent/session-start", ({ agent }) => {
			const binding = this.bindings.get(String(agent.id));
			if (binding?.agent === agent) this.requestPump(binding);
		});
		this.ctx.on("agent/status", ({ agent, status }) => {
			const binding = this.bindings.get(String(agent.id));
			if (binding?.agent !== agent || binding.conflicted || this.closed) return;
			try {
				this.database.heartbeatPresence({
					...binding.claim,
					leaseMs: this.config.presenceTtlMs,
					agentStatus: status,
					...this.presenceMetadata(agent)
				});
				this.emitPeersChanged();
			} catch (error) {
				this.handlePresenceError(binding, error);
			}
			this.requestPump(binding);
		});
		this.ctx.on("agent/disposed", ({ agent }) => this.detachRoot(agent));
		this.ctx.on("agent/inbox/discarded", ({ agent, message }) => {
			const source = relaySource(message);
			const binding = this.bindings.get(String(agent.id));
			if (source === void 0 || binding?.agent !== agent) return;
			const snapshot = safeGetMessage(this.database, String(message.id));
			if (snapshot === void 0 || snapshot.recipientSessionId !== binding.claim.sessionId || !canonicalRelayMatches(message, snapshot)) {
				this.ctx.logger.error(`local-session-messaging: ignored non-canonical discarded relay ${String(message.id)}`);
				return;
			}
			const permissionRevoked = this.permissionDiscards.delete(String(message.id));
			this.track(this.flushAndMarkDiscarded(binding, message.id, permissionRevoked ? POLICY_REVOKED_ERROR : "DSH Inbox discarded the relay"));
		});
		this.ctx.on("agent/inbox/claimed", ({ agent, message }) => {
			const source = relaySource(message);
			const binding = this.bindings.get(String(agent.id));
			if (source === void 0 || binding?.agent !== agent) return;
			const snapshot = safeGetMessage(this.database, String(message.id));
			if (snapshot === void 0 || snapshot.recipientSessionId !== binding.claim.sessionId || !canonicalRelayMatches(message, snapshot)) {
				this.ctx.logger.error(`local-session-messaging: ignored non-canonical claimed relay ${String(message.id)}`);
				return;
			}
			this.track(this.flushAndMarkClaimed(binding, message.id));
		});
		this.ctx.on("session/event", (session, event) => {
			if (this.closed || event.type !== "session/title") return;
			const binding = this.bindings.get(String(session.id));
			if (binding?.agent.session !== session || binding.conflicted) return;
			try {
				this.database.heartbeatPresence({
					...binding.claim,
					leaseMs: this.config.presenceTtlMs,
					agentStatus: binding.agent.status,
					...this.presenceMetadata(binding.agent)
				});
				this.emitPeersChanged();
			} catch (error) {
				this.handlePresenceError(binding, error);
			}
		});
		this.ctx.interval(() => this.heartbeat(), this.config.heartbeatIntervalMs);
		this.ctx.interval(() => this.poll(), this.config.pollIntervalMs);
		for (const agent of this.ctx.agents.roots()) this.attachRoot(agent);
		this.initialized = true;
		this.requestAllPumps();
	}
	async listPeers(caller, signal) {
		this.ensureReady();
		this.assertLiveCaller(caller);
		signal?.throwIfAborted();
		const principal = this.policyPrincipal(caller);
		const peers = await this.projectPresence(this.database.listPresence({ activeOnly: false }), signal);
		const principalId = String(principal);
		const senderAllowed = this.database.getSessionPolicy(principalId).sendAllowed;
		const recipientPolicies = new Map(this.database.listSessionPolicies().map((policy) => [policy.principalSessionId, policy]));
		const blocked = new Set(this.database.listPairBlocks(principalId).map((block) => otherPrincipal(block, principalId)));
		return peers.filter((peer) => peer.sessionId !== principal).map((peer) => ({
			...peer,
			sendable: senderAllowed && (recipientPolicies.get(String(peer.sessionId))?.receiveAllowed ?? true) && !blocked.has(String(peer.sessionId))
		})).sort((left, right) => left.name.localeCompare(right.name) || String(left.sessionId).localeCompare(String(right.sessionId)));
	}
	async send(caller, request, signal) {
		this.ensureReady();
		this.assertLiveCaller(caller);
		signal?.throwIfAborted();
		const text = validateMessageText(request.text, this.config.maxMessageBytes);
		const presences = this.database.listPresence({ activeOnly: false });
		const senderPrincipal = this.policyPrincipal(caller);
		const { target, presence } = await this.resolveTarget(presences, String(senderPrincipal), request.recipient, signal);
		const sender = presences.find((item) => item.sessionId === String(senderPrincipal));
		const connected = isPresenceConnected(presence);
		const deliveryMode = connected && presence.agentStatus === "running" ? "steer" : "followup";
		const payload = {
			version: 1,
			text,
			senderName: presenceName(sender, String(senderPrincipal)),
			...request.replyTo === void 0 ? {} : { replyTo: String(request.replyTo) }
		};
		let enqueued;
		try {
			enqueued = this.database.enqueue({
				messageId: randomUUID(),
				senderSessionId: String(caller.id),
				recipientSessionId: presence.sessionId,
				senderPrincipalSessionId: String(senderPrincipal),
				recipientPrincipalSessionId: presence.sessionId,
				deliveryMode,
				payload,
				ttlMs: this.config.messageTtlMs,
				maxAttempts: this.config.maxAttempts
			});
		} catch (error) {
			throw mapMessagingError(error);
		}
		this.emitStatus(enqueued.message, target.name);
		const local = this.bindings.get(presence.sessionId);
		if (local !== void 0 && !local.conflicted) this.requestPump(local);
		else if (connected && presence.endpoint !== void 0) try {
			await sendPoke(presence.endpoint, { timeoutMs: this.config.socketTimeoutMs });
		} catch (error) {
			this.ctx.logger.warn(`local-session-messaging: poke failed after enqueue; polling will recover: ${errorText(error)}`);
		}
		if (!signal?.aborted && connected && this.config.ackWaitMs > 0) await this.waitForAcknowledgement(enqueued.message.messageId, signal);
		const current = this.database.getMessage(enqueued.message.messageId) ?? enqueued.message;
		return this.receipt(current, target.name);
	}
	async sendControl(caller, request, signal) {
		this.ensureReady();
		this.assertLiveCaller(caller);
		signal?.throwIfAborted();
		let payload;
		try {
			payload = durableControlPayload(request.kind, request.payload, request.payloadHash);
		} catch (error) {
			throw mapMessagingError(error);
		}
		const presences = this.database.listPresence({ activeOnly: false });
		const senderPrincipal = this.policyPrincipal(caller);
		const { target, presence } = await this.resolveTarget(presences, String(senderPrincipal), request.recipient, signal);
		let enqueued;
		try {
			enqueued = this.database.enqueue({
				messageId: request.controlId,
				senderSessionId: String(caller.id),
				recipientSessionId: presence.sessionId,
				senderPrincipalSessionId: String(senderPrincipal),
				recipientPrincipalSessionId: presence.sessionId,
				channel: "control",
				deliveryMode: "followup",
				payload,
				ttlMs: this.config.messageTtlMs,
				maxAttempts: this.config.maxAttempts
			});
		} catch (error) {
			throw mapMessagingError(error);
		}
		this.emitStatus(enqueued.message, target.name);
		await this.notifyRecipient(presence);
		const connected = isPresenceConnected(presence);
		if (request.waitForAcknowledgement !== false && !signal?.aborted && connected && this.config.ackWaitMs > 0) await this.waitForAcknowledgement(enqueued.message.messageId, signal);
		const current = this.database.getMessage(enqueued.message.messageId) ?? enqueued.message;
		return this.controlReceipt(current, target.name);
	}
	async getControl(caller, controlId, signal) {
		this.ensureReady();
		this.assertLiveCaller(caller);
		signal?.throwIfAborted();
		let message;
		try {
			message = this.database.getMessage(controlId);
		} catch (error) {
			throw mapMessagingError(error);
		}
		if (message === void 0 || message.channel !== "control") throw new SessionMessagingError(`control ${controlId} was not found`, "MESSAGE_NOT_FOUND");
		const principal = String(this.policyPrincipal(caller));
		if (message.senderSessionId !== String(caller.id) && message.recipientSessionId !== String(caller.id) && message.senderPrincipalSessionId !== principal && message.recipientPrincipalSessionId !== principal) throw new SessionMessagingError("control belongs to another Session", "MESSAGE_FORBIDDEN");
		return this.controlReceipt(message);
	}
	registerControlHandler(kindInput, registration) {
		this.ensureNotClosed();
		let kind;
		try {
			kind = validateControlKind(kindInput);
		} catch (error) {
			throw mapMessagingError(error);
		}
		if (typeof registration?.authorize !== "function" || typeof registration.handle !== "function") throw new SessionMessagingError("control registration requires explicit authorize and handle callbacks", "INVALID_MESSAGE");
		if (this.controlHandlers.has(kind)) throw new SessionMessagingError(`control kind ${JSON.stringify(kind)} already has a handler`, "SESSION_CONFLICT");
		const value = {
			registration,
			identity: Symbol(kind)
		};
		this.retiredControlKinds.delete(kind);
		this.controlHandlers.set(kind, value);
		this.requestAllPumps();
		return () => {
			if (this.controlHandlers.get(kind)?.identity === value.identity) {
				this.controlHandlers.delete(kind);
				this.retiredControlKinds.add(kind);
			}
		};
	}
	async reserveSessionWriter(sessionId) {
		this.ensureReady();
		const binding = this.acquireSessionWriterBinding(String(sessionId));
		const liveAgent = this.ctx.agents.get(sessionId);
		if (liveAgent !== void 0) binding.agents.add(liveAgent);
		const reservation = Symbol(String(sessionId));
		binding.reservations.add(reservation);
		let releasePromise;
		return Object.freeze({
			sessionId,
			instanceId: binding.snapshot.instanceId,
			ownerToken: binding.snapshot.ownerToken,
			fenceToken: binding.snapshot.fenceToken,
			release: () => {
				releasePromise ??= this.releaseWriterReservation(binding, reservation);
				return releasePromise;
			}
		});
	}
	async getMessage(caller, messageId, signal) {
		this.ensureReady();
		this.assertLiveCaller(caller);
		signal?.throwIfAborted();
		let message;
		try {
			message = this.database.getMessage(String(messageId));
		} catch (error) {
			throw mapMessagingError(error);
		}
		if (message === void 0) throw new SessionMessagingError(`message ${String(messageId)} was not found`, "MESSAGE_NOT_FOUND");
		if (message.channel !== "text") throw new SessionMessagingError(`message ${String(messageId)} was not found`, "MESSAGE_NOT_FOUND");
		if (message.senderSessionId !== String(caller.id) && message.recipientSessionId !== String(caller.id)) throw new SessionMessagingError("message belongs to another Session", "MESSAGE_FORBIDDEN");
		const name = presenceName(this.database.getPresence(message.recipientSessionId), message.recipientSessionId);
		return this.receipt(message, name);
	}
	async getPermissions(caller, signal) {
		this.ensureReady();
		this.assertLiveCaller(caller);
		signal?.throwIfAborted();
		return projectPolicy(this.database.getSessionPolicy(String(this.policyPrincipal(caller))));
	}
	async setPermissions(caller, patch, signal) {
		this.ensureReady();
		this.assertLiveCaller(caller);
		signal?.throwIfAborted();
		if (patch.sendAllowed === void 0 && patch.receiveAllowed === void 0) throw new SessionMessagingError("a send or receive permission is required", "INVALID_MESSAGE");
		let policy;
		try {
			policy = this.database.setSessionPolicy({
				principalSessionId: String(this.policyPrincipal(caller)),
				...patch.sendAllowed === void 0 ? {} : { sendAllowed: patch.sendAllowed },
				...patch.receiveAllowed === void 0 ? {} : { receiveAllowed: patch.receiveAllowed }
			});
		} catch (error) {
			throw mapMessagingError(error);
		}
		this.notifyPolicyChange();
		return projectPolicy(policy);
	}
	async listBlockedPeers(caller, signal) {
		this.ensureReady();
		this.assertLiveCaller(caller);
		signal?.throwIfAborted();
		const principal = String(this.policyPrincipal(caller));
		const blocks = this.database.listPairBlocks(principal);
		if (blocks.length === 0) return [];
		const names = await this.blockedPeerNames(principal, blocks, signal);
		return blocks.map((block) => {
			const peerId = otherPrincipal(block, principal);
			return {
				sessionId: SessionId(peerId),
				name: names.get(peerId) ?? fallbackSessionName(peerId),
				blockedAt: block.blockedAt
			};
		}).sort((left, right) => left.name.localeCompare(right.name) || String(left.sessionId).localeCompare(String(right.sessionId)));
	}
	async setPeerBlocked(caller, recipient, blocked, signal) {
		this.ensureReady();
		this.assertLiveCaller(caller);
		signal?.throwIfAborted();
		if (typeof blocked !== "boolean") throw new SessionMessagingError("blocked must be boolean", "INVALID_MESSAGE");
		const principal = String(this.policyPrincipal(caller));
		const presences = this.database.listPresence({ activeOnly: false });
		const { target } = await this.resolveTarget(presences, principal, recipient, signal);
		let result;
		try {
			result = this.database.setPairBlocked({
				firstPrincipalSessionId: principal,
				secondPrincipalSessionId: String(target.sessionId),
				blocked
			});
		} catch (error) {
			throw mapMessagingError(error);
		}
		this.notifyPolicyChange();
		return {
			sessionId: target.sessionId,
			name: target.name,
			blockedAt: result?.blockedAt ?? Date.now()
		};
	}
	acquireSessionWriterBinding(sessionId) {
		this.ensureNotClosed();
		const existing = this.writerBindings.get(sessionId);
		if (existing !== void 0 && !existing.released) return existing;
		let current;
		try {
			current = this.database.getSessionWriter(sessionId);
		} catch (error) {
			throw mapMessagingError(error);
		}
		let takeover;
		if (current?.active) {
			if (!isMechanicallyDeadWriter(current, this.processIdentity)) throw new SessionMessagingError(`Session ${sessionId} has another live persistence writer`, "SESSION_CONFLICT");
			takeover = {
				instanceId: current.instanceId,
				ownerToken: current.ownerToken,
				fenceToken: current.fenceToken
			};
		}
		let snapshot;
		try {
			snapshot = this.database.acquireSessionWriter({
				sessionId,
				instanceId: this.instanceId,
				ownerToken: randomUUID(),
				...this.processIdentity,
				...takeover === void 0 ? {} : { takeover }
			});
		} catch (error) {
			throw mapMessagingError(error);
		}
		const binding = {
			snapshot,
			reservations: /* @__PURE__ */ new Set(),
			agents: /* @__PURE__ */ new Set(),
			drainingAgents: /* @__PURE__ */ new Map(),
			released: false
		};
		this.writerBindings.set(sessionId, binding);
		return binding;
	}
	async releaseWriterReservation(binding, reservation) {
		if (!binding.reservations.delete(reservation)) return;
		await Promise.all(binding.drainingAgents.values());
		this.releaseSessionWriterIfUnused(binding);
	}
	releaseSessionWriterIfUnused(binding) {
		if (binding.released || binding.reservations.size > 0 || binding.agents.size > 0 || this.writerBindings.get(binding.snapshot.sessionId) !== binding) return;
		try {
			this.database.releaseSessionWriter(binding.snapshot);
		} catch (error) {
			if (error instanceof MessagingError && error.code === "FENCE_LOST") {
				binding.released = true;
				this.writerBindings.delete(binding.snapshot.sessionId);
			}
			throw mapMessagingError(error);
		}
		binding.released = true;
		this.writerBindings.delete(binding.snapshot.sessionId);
	}
	attachSessionWriter(agent) {
		const binding = this.writerBindings.get(String(agent.id));
		if (binding !== void 0 && !binding.released) binding.agents.add(agent);
	}
	detachSessionWriter(agent) {
		const binding = this.writerBindings.get(String(agent.id));
		if (binding === void 0 || !binding.agents.has(agent) || binding.drainingAgents.has(agent)) return;
		const draining = this.flushAndDetachSessionWriter(binding, agent);
		binding.drainingAgents.set(agent, draining);
		const tracked = draining.finally(() => {
			if (binding.drainingAgents.get(agent) === draining) binding.drainingAgents.delete(agent);
		});
		this.track(tracked).catch(() => void 0);
	}
	async flushAndDetachSessionWriter(binding, agent) {
		try {
			await this.ctx.sessions.flush(agent.session);
		} catch (error) {
			this.ctx.logger.warn(`local-session-messaging: retaining Session writer ${String(agent.id)} after flush failure: ${errorText(error)}`);
			return;
		}
		if (!binding.agents.delete(agent)) return;
		try {
			this.releaseSessionWriterIfUnused(binding);
		} catch (error) {
			this.ctx.logger.warn(`local-session-messaging: failed to release Session writer ${String(agent.id)}: ${errorText(error)}`);
		}
	}
	isRoot(agent) {
		return this.ctx.agents.roots().includes(agent);
	}
	presenceMetadata(agent) {
		return presenceMetadata(agent, this.ctx.sessionTitle.get(agent.session)?.title);
	}
	attachRoot(agent) {
		if (this.closed || this.notifier === void 0) return;
		const id = String(agent.id);
		const existing = this.bindings.get(id);
		if (existing !== void 0) {
			if (existing.agent !== agent) throw new SessionMessagingError(`Session ${id} is represented by two local Agent objects`, "SESSION_CONFLICT");
			return;
		}
		let snapshot;
		try {
			snapshot = this.database.upsertPresence({
				sessionId: id,
				instanceId: this.instanceId,
				endpoint: this.notifier.endpoint,
				agentStatus: agent.status,
				leaseMs: this.config.presenceTtlMs,
				...this.presenceMetadata(agent)
			});
		} catch (error) {
			throw mapMessagingError(error);
		}
		const binding = {
			agent,
			claim: {
				sessionId: id,
				instanceId: this.instanceId,
				fenceToken: snapshot.fenceToken
			},
			conflicted: false
		};
		this.bindings.set(id, binding);
		this.emitPeersChanged();
	}
	detachRoot(agent) {
		const id = String(agent.id);
		const binding = this.bindings.get(id);
		if (binding?.agent === agent) {
			this.bindings.delete(id);
			try {
				if (!binding.conflicted && !this.closed) this.database.releasePresence(binding.claim);
			} catch (error) {
				if (!(error instanceof MessagingError && error.code === "FENCE_LOST")) this.ctx.logger.warn(`local-session-messaging: failed to release ${id}: ${errorText(error)}`);
			}
			this.emitPeersChanged();
		}
		this.detachSessionWriter(agent);
	}
	heartbeat() {
		if (this.closed) return;
		try {
			if (this.database.expirePresence() > 0) this.emitPeersChanged();
		} catch (error) {
			this.ctx.logger.warn(`local-session-messaging: maintenance failed: ${errorText(error)}`);
		}
		for (const binding of this.bindings.values()) {
			if (binding.conflicted) continue;
			try {
				this.database.heartbeatPresence({
					...binding.claim,
					leaseMs: this.config.presenceTtlMs,
					agentStatus: binding.agent.status,
					...this.presenceMetadata(binding.agent)
				});
			} catch (error) {
				this.handlePresenceError(binding, error);
			}
		}
	}
	poll() {
		if (this.closed) return;
		this.requestAllPumps();
	}
	handlePresenceError(binding, error) {
		if (error instanceof MessagingError && (error.code === "FENCE_LOST" || error.code === "SESSION_CONFLICT")) {
			binding.conflicted = true;
			this.ctx.logger.error(`local-session-messaging: Session ${String(binding.agent.id)} lost its presence fence; messaging is disabled for this Session`);
			this.emitPeersChanged();
			return;
		}
		this.ctx.logger.warn(`local-session-messaging: heartbeat failed for ${String(binding.agent.id)}: ${errorText(error)}`);
	}
	requestAllPumps() {
		if (this.closed) return;
		for (const binding of this.bindings.values()) this.requestPump(binding);
	}
	requestPump(binding) {
		if (this.closed || binding.conflicted || this.bindings.get(binding.claim.sessionId) !== binding) return Promise.resolve();
		let state = this.pumps.get(binding.claim.sessionId);
		if (state === void 0) {
			state = {
				requested: false,
				running: false,
				promise: void 0
			};
			this.pumps.set(binding.claim.sessionId, state);
		}
		state.requested = true;
		if (state.running && state.promise !== void 0) return state.promise;
		state.running = true;
		const promise = Promise.resolve(this.ctx.agents.withoutInitiator(async () => {
			while (state.requested && !this.closed && !binding.conflicted && this.bindings.get(binding.claim.sessionId) === binding) {
				state.requested = false;
				await this.pump(binding);
			}
		})).catch((error) => {
			this.ctx.logger.warn(`local-session-messaging: mailbox pump for ${binding.claim.sessionId} failed: ${errorText(error)}`);
		}).finally(() => {
			state.running = false;
			state.promise = void 0;
			if (state.requested && !this.closed) this.requestPump(binding);
		});
		state.promise = promise;
		this.track(promise);
		return promise;
	}
	async pump(binding) {
		await this.reconcileDurableInbox(binding);
		while (!this.closed && !binding.conflicted) {
			let delivery;
			try {
				delivery = this.database.claimNextDelivery({
					...binding.claim,
					recipientSessionId: binding.claim.sessionId,
					leaseMs: this.config.deliveryLeaseMs
				});
			} catch (error) {
				this.handlePresenceError(binding, error);
				return;
			}
			if (delivery === void 0) return;
			try {
				await this.deliverLeased(binding, delivery);
			} catch (error) {
				if (error instanceof MessagingError && (error.code === "FENCE_LOST" || error.code === "SESSION_CONFLICT")) {
					this.handlePresenceError(binding, error);
					return;
				}
				if (delivery.message.channel === "control") await this.retryControlLeased(binding, delivery, error);
				else await this.retryLeased(binding, delivery, error);
				return;
			}
		}
	}
	async deliverLeased(binding, delivery) {
		const current = this.database.getMessage(delivery.message.messageId);
		if (current === void 0 || current.status !== "queued") {
			if (current !== void 0) this.emitStatus(current);
			return;
		}
		if (current.channel === "control") {
			await this.deliverControlLeased(binding, delivery, current);
			return;
		}
		if (!communicationAllowed(this.database, current)) {
			const denied = this.database.failDelivery({
				...deliveryMutation(binding, delivery),
				error: "permission denied before DSH Inbox admission"
			});
			this.emitStatus(denied);
			return;
		}
		const message = relayMessage(delivery.message);
		deliverToAgent(binding.agent, delivery.message.deliveryMode, message);
		await this.flushInbox(binding.agent.session);
		const accepted = this.database.acceptDelivery(deliveryMutation(binding, delivery));
		this.emitStatus(accepted);
	}
	async deliverControlLeased(binding, delivery, current) {
		let payload;
		try {
			payload = parseDurableControlPayload(current.payload);
		} catch (error) {
			throw new SessionMessagingError(errorText(error), "INVALID_MESSAGE", { cause: error });
		}
		const incoming = {
			controlId: current.messageId,
			kind: payload.kind,
			payload: payload.payload,
			payloadHash: payload.payloadHash,
			senderSessionId: SessionId(current.senderSessionId),
			senderPrincipalSessionId: SessionId(current.senderPrincipalSessionId),
			recipientSessionId: SessionId(current.recipientSessionId),
			recipientPrincipalSessionId: SessionId(current.recipientPrincipalSessionId),
			attempt: current.attemptCount
		};
		if (!directionalPolicyAllowed(this.database, current)) {
			const completed$1 = this.database.completeControlDelivery({
				...deliveryMutation(binding, delivery),
				kind: payload.kind,
				payloadHash: payload.payloadHash,
				outcomeStatus: "rejected",
				detail: "control rejected: sender send or recipient receive is disabled"
			});
			this.emitStatus(completed$1.message);
			return;
		}
		const registered = this.controlHandlers.get(payload.kind);
		if (registered === void 0) {
			if (this.retiredControlKinds.has(payload.kind)) throw new SessionMessagingError(`control handler ${JSON.stringify(payload.kind)} is temporarily unavailable`, "SERVICE_CLOSED");
			const completed$1 = this.database.completeControlDelivery({
				...deliveryMutation(binding, delivery),
				kind: payload.kind,
				payloadHash: payload.payloadHash,
				outcomeStatus: "rejected",
				detail: "no explicit control handler is registered"
			});
			this.emitStatus(completed$1.message);
			return;
		}
		if (await registered.registration.authorize(incoming) !== true) {
			const completed$1 = this.database.completeControlDelivery({
				...deliveryMutation(binding, delivery),
				kind: payload.kind,
				payloadHash: payload.payloadHash,
				outcomeStatus: "rejected",
				detail: "control authorizer denied the envelope"
			});
			this.emitStatus(completed$1.message);
			return;
		}
		const decision = await registered.registration.handle(incoming);
		assertControlHandlerDecision(decision);
		const completed = this.database.completeControlDelivery({
			...deliveryMutation(binding, delivery),
			kind: payload.kind,
			payloadHash: payload.payloadHash,
			outcomeStatus: decision.status,
			...decision.result === void 0 ? {} : { result: decision.result },
			...decision.status === "rejected" && decision.detail !== void 0 ? { detail: decision.detail } : {}
		});
		this.emitStatus(completed.message);
	}
	async retryLeased(binding, delivery, error) {
		const detail = errorText(error);
		try {
			const snapshot = error instanceof SessionMessagingError && error.code === "INVALID_MESSAGE" ? this.database.failDelivery({
				...deliveryMutation(binding, delivery),
				error: detail
			}) : this.database.retryDelivery({
				...deliveryMutation(binding, delivery),
				retryDelayMs: retryDelay(delivery.message.attemptCount, this.config.retryBaseMs, this.config.retryMaxMs),
				error: detail
			}).message;
			this.emitStatus(snapshot);
		} catch (mutationError) {
			const current = this.database.getMessage(delivery.message.messageId);
			if (current !== void 0 && current.status !== "queued") {
				this.emitStatus(current);
				return;
			}
			throw mutationError;
		}
	}
	async retryControlLeased(binding, delivery, error) {
		let payload;
		try {
			payload = parseDurableControlPayload(delivery.message.payload);
		} catch {
			const failed = this.database.failDelivery({
				...deliveryMutation(binding, delivery),
				error: errorText(error)
			});
			this.emitStatus(failed);
			return;
		}
		const detail = errorText(error);
		try {
			const result = error instanceof SessionMessagingError && error.code === "INVALID_MESSAGE" ? this.database.failControlDelivery({
				...deliveryMutation(binding, delivery),
				kind: payload.kind,
				payloadHash: payload.payloadHash,
				error: detail
			}) : this.database.retryControlDelivery({
				...deliveryMutation(binding, delivery),
				kind: payload.kind,
				payloadHash: payload.payloadHash,
				retryDelayMs: retryDelay(delivery.message.attemptCount, this.config.retryBaseMs, this.config.retryMaxMs),
				error: detail
			});
			this.emitStatus(result.message);
		} catch (mutationError) {
			const current = this.database.getMessage(delivery.message.messageId);
			if (current !== void 0 && current.status !== "queued") {
				this.emitStatus(current);
				return;
			}
			throw mutationError;
		}
	}
	/** Recover status edges that happened while this provider was down. */
	async reconcileDurableInbox(binding) {
		const durableCandidates = this.database.listReconciliationCandidates(binding.claim.sessionId);
		if (durableCandidates.length === 0) return;
		const candidatesById = new Map(durableCandidates.map((candidate) => [candidate.messageId, candidate]));
		const lifecycle = foldRelayLifecycle(binding.agent, candidatesById);
		for (const candidate of durableCandidates) {
			if (lifecycle.claimed.has(candidate.messageId) || lifecycle.removedForClaim.has(candidate.messageId)) {
				this.emitStatus(this.database.markClaimed({
					...binding.claim,
					messageId: candidate.messageId
				}));
				continue;
			}
			if (lifecycle.canceled.has(candidate.messageId)) {
				this.emitStatus(this.database.markDiscarded({
					...binding.claim,
					messageId: candidate.messageId,
					error: "relay was durably canceled in the DSH Inbox"
				}));
				continue;
			}
			let message = candidate;
			if (lifecycle.pending.has(message.messageId) && message.status === "queued") {
				message = this.database.recoverAccepted({
					...binding.claim,
					messageId: message.messageId
				});
				this.emitStatus(message);
			}
			if (!communicationAllowed(this.database, message)) {
				if (lifecycle.pending.has(message.messageId)) {
					this.permissionDiscards.add(message.messageId);
					if (!binding.agent.inbox.remove(MessageId(message.messageId))) {
						this.permissionDiscards.delete(message.messageId);
						const refreshed = foldRelayLifecycle(binding.agent, candidatesById);
						if (refreshed.claimed.has(message.messageId) || refreshed.removedForClaim.has(message.messageId)) {
							this.emitStatus(this.database.markClaimed({
								...binding.claim,
								messageId: message.messageId
							}));
							continue;
						}
					} else {
						this.permissionDiscards.delete(message.messageId);
						await this.flushInbox(binding.agent.session);
					}
				}
				this.emitStatus(this.database.markDiscarded({
					...binding.claim,
					messageId: message.messageId,
					error: POLICY_REVOKED_ERROR
				}));
				continue;
			}
			if (lifecycle.pending.has(message.messageId)) continue;
			if (message.status === "queued") continue;
			const recovered = relayMessage(message);
			deliverToAgent(binding.agent, message.deliveryMode, recovered);
			await this.flushInbox(binding.agent.session);
		}
	}
	async flushAndMarkClaimed(binding, messageId) {
		try {
			await this.flushInbox(binding.agent.session);
			const snapshot = this.database.markClaimed({
				...binding.claim,
				messageId: String(messageId)
			});
			this.emitStatus(snapshot);
		} catch (error) {
			if (safeGetMessage(this.database, String(messageId))?.status === "claimed") return;
			this.ctx.logger.warn(`local-session-messaging: failed to checkpoint claimed message ${String(messageId)}: ${errorText(error)}`);
		}
	}
	async flushAndMarkDiscarded(binding, messageId, detail) {
		try {
			await this.flushInbox(binding.agent.session);
			const snapshot = this.database.markDiscarded({
				...binding.claim,
				messageId: String(messageId),
				error: detail
			});
			this.emitStatus(snapshot);
		} catch (error) {
			const current = safeGetMessage(this.database, String(messageId));
			if (current?.status === "failed" || current?.status === "claimed") return;
			this.ctx.logger.warn(`local-session-messaging: failed to checkpoint discarded message ${String(messageId)}: ${errorText(error)}`);
		}
	}
	async flushInbox(session) {
		if (!await this.ctx.sessions.flush(session)) throw new Error("no DSH session persistence provider participated in Inbox flush");
	}
	async waitForAcknowledgement(messageId, signal) {
		const deadline = Date.now() + this.config.ackWaitMs;
		while (!signal?.aborted && Date.now() < deadline) {
			const current = this.database.getMessage(messageId);
			if (current === void 0 || current.status !== "queued") return;
			const remaining = deadline - Date.now();
			if (remaining <= 0) return;
			try {
				await setTimeout(Math.min(this.config.ackPollMs, remaining), void 0, { signal });
			} catch {
				return;
			}
		}
	}
	async projectPresence(presences, signal) {
		const ids = presences.filter((presence) => !isPresenceConnected(presence)).map((presence) => SessionId(presence.sessionId));
		const titles = /* @__PURE__ */ new Map();
		if (ids.length > 0) try {
			const results = await this.ctx.sessionQuery.readTitleSnapshots(ids, signal);
			for (const result of results) {
				if (result.status !== "fulfilled" || result.value.title === void 0) continue;
				titles.set(String(result.sessionId), result.value.title.title);
			}
		} catch (error) {
			if (signal?.aborted) throw error;
			this.ctx.logger.debug(`local-session-messaging: title projection unavailable: ${errorText(error)}`);
		}
		return presences.map((presence) => presencePeerSnapshot(presence, titles.get(presence.sessionId) ?? presence.title));
	}
	async resolveTarget(presences, callerSessionId, addressInput, signal) {
		const address = normalizePeerAddress(addressInput, callerSessionId);
		const exact = presences.find((presence$1) => presence$1.sessionId === address);
		if (exact !== void 0) return {
			target: presencePeerSnapshot(exact),
			presence: exact
		};
		const target = resolvePeer(await this.projectPresence(presences, signal), callerSessionId, address);
		const presence = presences.find((item) => item.sessionId === String(target.sessionId));
		if (presence === void 0) throw new SessionMessagingError("recipient disappeared during resolution", "UNKNOWN_TARGET");
		return {
			target,
			presence
		};
	}
	policyPrincipal(agent) {
		let current = agent;
		const visited = /* @__PURE__ */ new Set();
		const roots = new Set(this.ctx.agents.roots());
		while (!visited.has(String(current.id))) {
			if (roots.has(current)) {
				const binding = this.bindings.get(String(current.id));
				if (binding?.agent !== current || binding.conflicted) throw new SessionMessagingError(`root Session ${String(current.id)} has no current messaging presence fence`, "SESSION_CONFLICT");
				return current.id;
			}
			visited.add(String(current.id));
			const owner = this.ctx.agents.list().find((candidate) => this.ctx.agents.isOwnedBy(current.id, candidate));
			if (owner === void 0) throw new SessionMessagingError(`cannot resolve root policy principal for non-root Agent ${String(current.id)}`, "SESSION_CONFLICT");
			current = owner;
		}
		throw new SessionMessagingError("Agent ownership cycle prevents authorization", "SESSION_CONFLICT");
	}
	async blockedPeerNames(principal, blocks, signal) {
		const ids = new Set(blocks.map((block) => otherPrincipal(block, principal)));
		const rows = this.database.listPresence({ activeOnly: false }).filter((presence) => ids.has(presence.sessionId));
		const peers = await this.projectPresence(rows, signal);
		return new Map(peers.map((peer) => [String(peer.sessionId), peer.name]));
	}
	notifyPolicyChange() {
		this.requestAllPumps();
		const ownEndpoint = this.notifier?.endpoint.socketPath;
		const endpoints = /* @__PURE__ */ new Map();
		for (const presence of this.database.listPresence({ activeOnly: true })) {
			if (presence.endpoint === void 0 || presence.endpoint.socketPath === ownEndpoint) continue;
			endpoints.set(presence.endpoint.socketPath, presence.endpoint);
		}
		const notification = Promise.allSettled([...endpoints.values()].map((endpoint) => endpoint === void 0 ? Promise.resolve(false) : sendPoke(endpoint, { timeoutMs: this.config.socketTimeoutMs }))).then(() => void 0);
		this.track(notification);
	}
	async notifyRecipient(presence) {
		const local = this.bindings.get(presence.sessionId);
		if (local !== void 0 && !local.conflicted) {
			this.requestPump(local);
			return;
		}
		if (!isPresenceConnected(presence) || presence.endpoint === void 0) return;
		try {
			await sendPoke(presence.endpoint, { timeoutMs: this.config.socketTimeoutMs });
		} catch (error) {
			this.ctx.logger.warn(`local-session-messaging: control poke failed after enqueue; polling will recover: ${errorText(error)}`);
		}
	}
	receipt(message, recipientName) {
		return {
			messageId: MessageId(message.messageId),
			senderSessionId: SessionId(message.senderSessionId),
			recipientSessionId: SessionId(message.recipientSessionId),
			recipientName: recipientName ?? presenceName(safeGetPresence(this.database, message.recipientSessionId), message.recipientSessionId),
			status: message.status,
			createdAt: message.createdAt,
			updatedAt: message.updatedAt,
			...message.acceptedAt === void 0 ? {} : { acceptedAt: message.acceptedAt },
			...message.claimedAt === void 0 ? {} : { claimedAt: message.claimedAt },
			...message.lastError === void 0 ? {} : { failure: message.lastError }
		};
	}
	controlReceipt(message, recipientName) {
		if (message.channel !== "control") throw new SessionMessagingError("message is not a typed control", "MESSAGE_NOT_FOUND");
		let payload;
		try {
			payload = parseDurableControlPayload(message.payload);
		} catch (error) {
			throw mapMessagingError(error);
		}
		const outcome = this.database.getControlOutcome(message.messageId);
		return {
			controlId: message.messageId,
			kind: payload.kind,
			payloadHash: payload.payloadHash,
			senderSessionId: SessionId(message.senderSessionId),
			recipientSessionId: SessionId(message.recipientSessionId),
			recipientName: recipientName ?? presenceName(safeGetPresence(this.database, message.recipientSessionId), message.recipientSessionId),
			status: message.status,
			createdAt: message.createdAt,
			updatedAt: message.updatedAt,
			...outcome === void 0 ? {} : { outcome: projectControlOutcome(outcome) },
			...message.lastError === void 0 ? {} : { failure: message.lastError }
		};
	}
	emitStatus(message, recipientName) {
		if (this.closed) return;
		try {
			if (message.channel === "control") this.ctx.emit("session-messaging/control-status", this.controlReceipt(message, recipientName));
			else this.ctx.emit("session-messaging/message-status", this.receipt(message, recipientName));
		} catch (error) {
			this.ctx.logger.warn(`local-session-messaging: status observer failed: ${errorText(error)}`);
		}
	}
	emitPeersChanged() {
		if (this.closed) return;
		try {
			this.ctx.emit("session-messaging/peers-changed");
		} catch (error) {
			this.ctx.logger.warn(`local-session-messaging: peers-changed observer failed: ${errorText(error)}`);
		}
	}
	assertLiveCaller(caller) {
		if (this.ctx.agents.get(caller.id) !== caller) throw new SessionMessagingError("calling Agent is no longer live", "SERVICE_CLOSED");
		const binding = this.bindings.get(String(caller.id));
		if (binding?.agent === caller && binding.conflicted) throw new SessionMessagingError(`Session ${String(caller.id)} has lost its presence fence`, "SESSION_CONFLICT");
	}
	ensureNotClosed() {
		if (this.closed) throw new SessionMessagingError("messaging service is closed", "SERVICE_CLOSED");
	}
	ensureReady() {
		this.ensureNotClosed();
		if (!this.initialized || this.notifier === void 0) throw new SessionMessagingError("messaging service is still initializing", "SERVICE_CLOSED");
	}
	track(promise) {
		this.work.add(promise);
		promise.finally(() => this.work.delete(promise)).catch(() => {});
		return promise;
	}
	close() {
		if (this.closePromise !== void 0) return this.closePromise;
		this.closePromise = this.closeNow();
		return this.closePromise;
	}
	async closeNow() {
		if (this.closed) return;
		this.closed = true;
		for (const binding of this.bindings.values()) try {
			if (!binding.conflicted) this.database.releasePresence(binding.claim);
		} catch (error) {
			if (!(error instanceof MessagingError && error.code === "FENCE_LOST")) this.ctx.logger.warn(`local-session-messaging: teardown release failed for ${binding.claim.sessionId}: ${errorText(error)}`);
		}
		this.bindings.clear();
		this.controlHandlers.clear();
		this.retiredControlKinds.clear();
		while (this.work.size > 0) await Promise.allSettled([...this.work]);
		await this.notifier?.close();
		for (const binding of this.writerBindings.values()) {
			if (binding.released) continue;
			try {
				this.releaseSessionWriterIfUnused(binding);
			} catch (error) {
				if (!(error instanceof MessagingError && error.code === "FENCE_LOST")) this.ctx.logger.warn(`local-session-messaging: teardown writer release failed for ${binding.snapshot.sessionId}: ${errorText(error)}`);
			}
			if (!binding.released) this.ctx.logger.warn(`local-session-messaging: retaining active Session writer ${binding.snapshot.sessionId} during teardown because references remain`);
		}
		this.writerBindings.clear();
		this.database.close();
	}
};
function currentProcessIdentity() {
	const lookup = lookupProcess(process.pid);
	if (lookup.status !== "running") throw new SessionMessagingError("cannot determine the current process start identity", "SERVICE_CLOSED");
	return {
		pid: process.pid,
		processStartId: lookup.processStartId,
		hostname: hostname(),
		bootId: currentBootId()
	};
}
function currentBootId() {
	try {
		if (process.platform === "linux") {
			const value = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
			if (value.length > 0) return `linux:${value}`;
		} else if (process.platform === "darwin") {
			const value = execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], {
				encoding: "utf8",
				stdio: [
					"ignore",
					"pipe",
					"ignore"
				]
			}).trim();
			if (value.length > 0) return `darwin:${value}`;
		}
	} catch (error) {
		throw new SessionMessagingError("cannot determine the local boot identity", "SERVICE_CLOSED", { cause: error });
	}
	throw new SessionMessagingError(`Session writer fencing is unsupported on ${process.platform}`, "SERVICE_CLOSED");
}
function lookupProcess(pid) {
	try {
		process.kill(pid, 0);
	} catch (error) {
		if (isErrnoCode(error, "ESRCH")) return { status: "dead" };
		if (!isErrnoCode(error, "EPERM")) return { status: "unknown" };
	}
	if (process.platform === "linux") try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const commandEnd = stat.lastIndexOf(")");
		if (commandEnd < 0) return { status: "unknown" };
		const startTicks = stat.slice(commandEnd + 1).trim().split(/\s+/u)[19];
		return startTicks === void 0 || !/^\d+$/u.test(startTicks) ? { status: "unknown" } : {
			status: "running",
			processStartId: `linux:${startTicks}`
		};
	} catch (error) {
		return isErrnoCode(error, "ENOENT") || isErrnoCode(error, "ESRCH") ? { status: "dead" } : { status: "unknown" };
	}
	if (process.platform === "darwin") try {
		const value = execFileSync("/bin/ps", [
			"-p",
			String(pid),
			"-o",
			"lstart="
		], {
			encoding: "utf8",
			env: {
				...process.env,
				LC_ALL: "C"
			},
			stdio: [
				"ignore",
				"pipe",
				"ignore"
			]
		}).trim();
		return value.length === 0 ? { status: "unknown" } : {
			status: "running",
			processStartId: `darwin:${value}`
		};
	} catch {
		return { status: "unknown" };
	}
	return { status: "unknown" };
}
function isMechanicallyDeadWriter(writer, current) {
	if (writer.hostname !== current.hostname) return false;
	if (writer.bootId !== current.bootId) return true;
	const lookup = lookupProcess(writer.pid);
	return lookup.status === "dead" || lookup.status === "running" && lookup.processStartId !== writer.processStartId;
}
function isErrnoCode(error, code) {
	return error instanceof Error && "code" in error && error.code === code;
}
function resolveConfig(config) {
	return {
		root: resolve(expandHomePath(config.root ?? DEFAULT_ROOT)),
		heartbeatIntervalMs: config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
		presenceTtlMs: config.presenceTtlMs ?? DEFAULT_PRESENCE_TTL_MS,
		pollIntervalMs: config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
		deliveryLeaseMs: config.deliveryLeaseMs ?? DEFAULT_DELIVERY_LEASE_MS,
		retryBaseMs: config.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
		retryMaxMs: config.retryMaxMs ?? DEFAULT_RETRY_MAX_MS,
		messageTtlMs: config.messageTtlMs ?? DEFAULT_MESSAGE_TTL_MS,
		maxAttempts: config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
		maxMessageBytes: config.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES,
		ackWaitMs: config.ackWaitMs ?? DEFAULT_ACK_WAIT_MS,
		ackPollMs: config.ackPollMs ?? DEFAULT_ACK_POLL_MS,
		socketTimeoutMs: config.socketTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS
	};
}
function socketDirectory(root) {
	const suffix = join("sockets", `poke-${"0".repeat(36)}.sock`);
	const limit = process.platform === "darwin" ? 103 : 107;
	if (Buffer.byteLength(join(root, suffix), "utf8") <= limit) return join(root, "sockets");
	const uid = process.getuid?.() ?? "user";
	const digest = createHash("sha256").update(root).digest("hex").slice(0, 12);
	return join(process.platform === "darwin" ? "/tmp" : tmpdir(), `dsh-lsm-${uid}-${digest}`);
}
function presenceMetadata(agent, title) {
	const cwd = agent.session.header.cwd;
	return {
		...cwd === void 0 ? {} : { cwd },
		name: title ?? fallbackSessionName(String(agent.id), cwd),
		...title === void 0 ? {} : { title }
	};
}
function fallbackSessionName(sessionId, cwd) {
	if (cwd !== void 0) {
		const leaf = basename(cwd);
		if (leaf.length > 0) return `${leaf}-${sessionId.slice(-8)}`;
	}
	return `session-${sessionId.slice(-8)}`;
}
function presenceName(presence, sessionId) {
	return presence?.title ?? presence?.name ?? fallbackSessionName(sessionId, presence?.cwd);
}
function presencePeerSnapshot(presence, title = presence.title) {
	const connected = isPresenceConnected(presence);
	return {
		sessionId: SessionId(presence.sessionId),
		name: title ?? presence.name ?? fallbackSessionName(presence.sessionId, presence.cwd),
		...presence.cwd === void 0 ? {} : { cwd: presence.cwd },
		connection: connected ? "connected" : "disconnected",
		...connected ? { agentStatus: presence.agentStatus } : {}
	};
}
function projectPolicy(policy) {
	return {
		sessionId: SessionId(policy.principalSessionId),
		sendAllowed: policy.sendAllowed,
		receiveAllowed: policy.receiveAllowed,
		...policy.updatedAt === 0 ? {} : { updatedAt: policy.updatedAt }
	};
}
function projectControlOutcome(outcome) {
	return {
		status: outcome.status,
		completedAt: outcome.completedAt,
		...outcome.result === void 0 ? {} : { result: outcome.result },
		...outcome.detail === void 0 ? {} : { detail: outcome.detail }
	};
}
function otherPrincipal(block, principal) {
	if (block.firstPrincipalSessionId === principal) return block.secondPrincipalSessionId;
	if (block.secondPrincipalSessionId === principal) return block.firstPrincipalSessionId;
	throw new SessionMessagingError("pair block does not contain the requested Session", "SESSION_CONFLICT");
}
function communicationAllowed(database, message) {
	return principalsMayCommunicate(database, message.senderPrincipalSessionId, message.recipientPrincipalSessionId);
}
function principalsMayCommunicate(database, senderPrincipalSessionId, recipientPrincipalSessionId) {
	return directionalPrincipalsAllowed(database, senderPrincipalSessionId, recipientPrincipalSessionId) && !database.isPairBlocked(senderPrincipalSessionId, recipientPrincipalSessionId);
}
function directionalPolicyAllowed(database, message) {
	return directionalPrincipalsAllowed(database, message.senderPrincipalSessionId, message.recipientPrincipalSessionId);
}
function directionalPrincipalsAllowed(database, senderPrincipalSessionId, recipientPrincipalSessionId) {
	const sender = database.getSessionPolicy(senderPrincipalSessionId);
	const recipient = database.getSessionPolicy(recipientPrincipalSessionId);
	return sender.sendAllowed && recipient.receiveAllowed;
}
function isPresenceConnected(presence, now = Date.now()) {
	return presence.active && presence.expiresAt > now && presence.endpoint !== void 0;
}
function resolvePeer(peers, callerSessionId, addressInput) {
	const address = normalizePeerAddress(addressInput, callerSessionId);
	const byId = peers.filter((peer) => String(peer.sessionId) === address);
	if (byId.length === 1) return byId[0];
	if (byId.length > 1) throw new SessionMessagingError(`Session id ${address} has conflicting presence rows`, "SESSION_CONFLICT");
	const exact = peers.filter((peer) => peer.name === address);
	const matches = exact.length > 0 ? exact : peers.filter((peer) => peer.name.toLocaleLowerCase() === address.toLocaleLowerCase());
	if (matches.length === 0) throw new SessionMessagingError(`no known local root Session is named ${JSON.stringify(address)}`, "UNKNOWN_TARGET");
	if (matches.length > 1) throw new SessionMessagingError(`recipient ${JSON.stringify(address)} is ambiguous; use an exact Session id (${matches.map((peer) => peer.sessionId).join(", ")})`, "AMBIGUOUS_TARGET");
	if (String(matches[0].sessionId) === callerSessionId) throw new SessionMessagingError("a Session cannot message itself", "SELF_TARGET");
	return matches[0];
}
function normalizePeerAddress(addressInput, callerSessionId) {
	const address = addressInput.trim();
	if (address.length === 0) throw new SessionMessagingError("recipient must not be empty", "UNKNOWN_TARGET");
	if (address === callerSessionId) throw new SessionMessagingError("a Session cannot message itself", "SELF_TARGET");
	return address;
}
function validateMessageText(value, maxBytes) {
	if (typeof value !== "string" || value.trim().length === 0) throw new SessionMessagingError("message must contain non-whitespace text", "INVALID_MESSAGE");
	if (Buffer.byteLength(value, "utf8") > maxBytes) throw new SessionMessagingError(`message exceeds ${maxBytes} UTF-8 bytes`, "INVALID_MESSAGE");
	return value;
}
function assertControlHandlerDecision(value) {
	if (!isRecord(value) || value.status !== "completed" && value.status !== "rejected" || value.detail !== void 0 && (typeof value.detail !== "string" || value.detail.length === 0)) throw new SessionMessagingError("control handler returned an invalid decision", "INVALID_MESSAGE");
	if (value.result !== void 0) try {
		canonicalJson(value.result);
	} catch (error) {
		throw new SessionMessagingError("control handler returned a non-JSON result", "INVALID_MESSAGE", { cause: error });
	}
}
function relayPayload(value) {
	if (!isRecord(value) || value.version !== 1 || typeof value.text !== "string" || value.text.trim().length === 0 || value.senderName !== void 0 && (typeof value.senderName !== "string" || value.senderName.trim().length === 0) || value.replyTo !== void 0 && typeof value.replyTo !== "string") throw new SessionMessagingError("durable relay payload is malformed", "INVALID_MESSAGE");
	return {
		version: 1,
		text: value.text,
		...value.senderName === void 0 ? {} : { senderName: value.senderName },
		...value.replyTo === void 0 ? {} : { replyTo: value.replyTo }
	};
}
function relayMessage(snapshot) {
	const payload = relayPayload(snapshot.payload);
	const replySessionId = SessionId(snapshot.senderPrincipalSessionId);
	const senderName = payload.senderName ?? fallbackSessionName(snapshot.senderPrincipalSessionId);
	const via = snapshot.senderSessionId === snapshot.senderPrincipalSessionId ? "" : `, via Agent ${snapshot.senderSessionId}`;
	const action = payload.replyTo === void 0 ? "sent a message" : `replied to message ${payload.replyTo}`;
	return freezeMessage({
		id: MessageId(snapshot.messageId),
		role: "user",
		content: [{
			type: "text",
			text: `Local Session ${JSON.stringify(senderName)} (${String(replySessionId)})${via} ${action}:\n\n`
		}, {
			type: "text",
			text: payload.text
		}],
		source: {
			kind: "local-session-relay",
			form: "relay",
			senderSessionId: SessionId(snapshot.senderSessionId),
			replySessionId,
			senderName,
			envelopeId: snapshot.messageId,
			...payload.replyTo === void 0 ? {} : { replyTo: MessageId(payload.replyTo) }
		}
	});
}
function relaySource(message) {
	const source = message.source;
	if (!isRecord(source) || source.kind !== "local-session-relay" || source.form !== "relay" || typeof source.senderSessionId !== "string" || source.senderSessionId.length === 0 || typeof source.replySessionId !== "string" || source.replySessionId.length === 0 || source.senderName !== void 0 && (typeof source.senderName !== "string" || source.senderName.length === 0) || typeof source.envelopeId !== "string" || String(message.id) !== source.envelopeId || source.replyTo !== void 0 && typeof source.replyTo !== "string") return void 0;
	return source;
}
function deliverToAgent(agent, mode, message) {
	if (mode === "steer") agent.steer(message);
	else agent.followup(message);
}
function foldRelayLifecycle(agent, candidates) {
	const lists = {
		"next-turn": [],
		"next-step": []
	};
	const claimed = /* @__PURE__ */ new Set();
	const canceled = /* @__PURE__ */ new Set();
	const removedForClaim = /* @__PURE__ */ new Set();
	for (const event of agent.session.events.slice(agent.session.header.seedLength ?? 0)) {
		if (event.type === "user/message") {
			const source = canonicalRelaySource(event.data, candidates);
			if (source !== void 0) {
				claimed.add(source.envelopeId);
				canceled.delete(source.envelopeId);
				removedForClaim.delete(source.envelopeId);
			}
			continue;
		}
		if (event.type !== "agent/inbox/spliced") continue;
		const list = lists[event.data.target];
		const inserted = [...event.data.inserted];
		const removed = list.splice(event.data.start, event.data.removedCount ?? 0, ...inserted);
		for (const message of removed) {
			const source = canonicalRelaySource(message, candidates);
			if (source === void 0) continue;
			if (event.data.outcome === "canceled") {
				canceled.add(source.envelopeId);
				removedForClaim.delete(source.envelopeId);
			} else {
				removedForClaim.add(source.envelopeId);
				canceled.delete(source.envelopeId);
			}
		}
		for (const message of inserted) {
			const source = canonicalRelaySource(message, candidates);
			if (source === void 0) continue;
			canceled.delete(source.envelopeId);
			removedForClaim.delete(source.envelopeId);
		}
	}
	const pending = /* @__PURE__ */ new Set();
	for (const message of [...agent.inbox.nextTurn, ...agent.inbox.nextStep]) {
		const source = canonicalRelaySource(message, candidates);
		if (source !== void 0) pending.add(source.envelopeId);
	}
	return {
		pending,
		claimed,
		canceled,
		removedForClaim
	};
}
function canonicalRelaySource(message, candidates) {
	const source = relaySource(message);
	if (source === void 0) return void 0;
	const snapshot = candidates.get(source.envelopeId);
	return snapshot !== void 0 && canonicalRelayMatches(message, snapshot) ? source : void 0;
}
function canonicalRelayMatches(message, snapshot) {
	try {
		return isDeepStrictEqual(message, relayMessage(snapshot));
	} catch {
		return false;
	}
}
function deliveryMutation(binding, delivery) {
	return {
		...binding.claim,
		messageId: delivery.message.messageId,
		leaseToken: delivery.lease.token
	};
}
function retryDelay(attemptCount, base, max) {
	if (base === 0) return 0;
	return Math.min(max, base * 2 ** Math.min(20, Math.max(0, attemptCount - 1)));
}
function safeGetMessage(database, id) {
	try {
		return database.getMessage(id);
	} catch {
		return;
	}
}
function safeGetPresence(database, id) {
	try {
		return database.getPresence(id);
	} catch {
		return;
	}
}
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function errorText(error) {
	return error instanceof Error ? error.message : String(error);
}
function mapMessagingError(error) {
	if (error instanceof SessionMessagingError) return error;
	if (!(error instanceof MessagingError)) return new SessionMessagingError(errorText(error), "SERVICE_CLOSED", { cause: error });
	switch (error.code) {
		case "SESSION_CONFLICT":
		case "FENCE_LOST": return new SessionMessagingError(error.message, "SESSION_CONFLICT", { cause: error });
		case "MESSAGE_NOT_FOUND": return new SessionMessagingError(error.message, "MESSAGE_NOT_FOUND", { cause: error });
		case "PERMISSION_DENIED": return new SessionMessagingError(error.message, "PERMISSION_DENIED", { cause: error });
		case "DATABASE_CLOSED":
		case "NOTIFIER_CLOSED": return new SessionMessagingError(error.message, "SERVICE_CLOSED", { cause: error });
		default: return new SessionMessagingError(error.message, "INVALID_MESSAGE", { cause: error });
	}
}
var local_default = LocalSessionMessaging;

//#endregion
export { LocalSessionMessaging, local_default as default };