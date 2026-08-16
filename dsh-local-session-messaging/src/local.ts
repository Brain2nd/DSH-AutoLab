/**
 * Same-machine provider for the {@link SessionMessaging} capability seam.
 *
 * SQLite is only the cross-process hand-off and presence authority.  Delivery
 * is accepted only after the stable message has entered DSH's event-sourced
 * Inbox and `ctx.sessions.flush()` has completed.  The Unix socket is merely a
 * lossy wake-up hint; polling the database is always sufficient for progress.
 *
 * @module dsh-local-session-messaging/local
 */
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'

import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { dshHomePath, expandHomePath } from '@deepseek-ai/dsh-home-paths'
import {
  freezeMessage,
  MessageId,
  type MessageId as DshMessageId,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session-title'
import {
  SessionId,
  type Session,
} from '@deepseek-ai/dsh-session'

import {
  MessagingDatabase,
  type DeliveryMutationOptions,
  type SessionWriterSnapshot,
} from './database.js'
import {
  durableControlPayload,
  parseDurableControlPayload,
  validateControlKind,
} from './control.js'
import {
  canonicalJson,
  MessagingError,
  type DeliveryLease,
  type JsonValue,
  type MessageSnapshot,
  type ControlOutcomeSnapshot,
  type PairBlockSnapshot,
  type PresenceClaim,
  type PresenceSnapshot,
  type SessionPolicySnapshot,
} from './domain.js'
import { createPokeServer, sendPoke, type PokeServer } from './notifier.js'
import {
  SessionMessaging,
  SessionMessagingError,
  type BlockedPeerSnapshot,
  type ControlHandlerDecision,
  type ControlHandlerRegistration,
  type ControlReceipt,
  type ControlRequest,
  type IncomingControl,
  type PeerMessageReceipt,
  type PeerMessageRequest,
  type PeerSessionSnapshot,
  type SessionMessagingPermissionPatch,
  type SessionMessagingPermissions,
  type SessionWriterLease,
} from './service.js'

/** Source attached to every relayed DSH user message. */
export interface LocalSessionRelaySource {
  readonly kind: 'local-session-relay'
  readonly form: 'relay'
  /** Exact Agent Session that initiated the send, including a descendant. */
  readonly senderSessionId: SessionId
  /** Contactable root Session that owns the sender and should receive replies. */
  readonly replySessionId: SessionId
  /** Trusted display-name snapshot for model-facing attribution. */
  readonly senderName?: string
  /** Same UUID as both the SQLite envelope and the DSH MessageId. */
  readonly envelopeId: string
  readonly replyTo?: DshMessageId
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'local-session-relay': LocalSessionRelaySource
  }
}

export interface Config {
  /** Owner-only state directory. Defaults below the resolved DSH home. */
  root?: string
  heartbeatIntervalMs?: number
  presenceTtlMs?: number
  pollIntervalMs?: number
  deliveryLeaseMs?: number
  retryBaseMs?: number
  retryMaxMs?: number
  messageTtlMs?: number
  maxAttempts?: number
  maxMessageBytes?: number
  ackWaitMs?: number
  ackPollMs?: number
  socketTimeoutMs?: number
}

interface ResolvedConfig {
  readonly root: string
  readonly heartbeatIntervalMs: number
  readonly presenceTtlMs: number
  readonly pollIntervalMs: number
  readonly deliveryLeaseMs: number
  readonly retryBaseMs: number
  readonly retryMaxMs: number
  readonly messageTtlMs: number
  readonly maxAttempts: number
  readonly maxMessageBytes: number
  readonly ackWaitMs: number
  readonly ackPollMs: number
  readonly socketTimeoutMs: number
}

interface RootBinding {
  readonly agent: Agent
  readonly claim: PresenceClaim
  conflicted: boolean
}

interface LocalProcessIdentity {
  readonly pid: number
  readonly processStartId: string
  readonly hostname: string
  readonly bootId: string
}

interface SessionWriterBinding {
  readonly snapshot: SessionWriterSnapshot
  readonly reservations: Set<symbol>
  readonly agents: Set<Agent>
  readonly drainingAgents: Map<Agent, Promise<void>>
  released: boolean
}

type ProcessLookup =
  | { readonly status: 'running'; readonly processStartId: string }
  | { readonly status: 'dead' | 'unknown' }

interface PumpState {
  requested: boolean
  running: boolean
  promise: Promise<void> | undefined
}

interface RelayPayload {
  readonly version: 1
  readonly text: string
  readonly senderName?: string
  readonly replyTo?: string
}

interface RelayLifecycle {
  readonly pending: Set<string>
  readonly claimed: Set<string>
  readonly canceled: Set<string>
  readonly removedForClaim: Set<string>
}

interface RegisteredControlHandler {
  readonly registration: ControlHandlerRegistration
  readonly identity: symbol
}

type PresencePeerSnapshot = Omit<PeerSessionSnapshot, 'sendable'>

const DEFAULT_ROOT = dshHomePath('local-session-messaging')
const DEFAULT_HEARTBEAT_INTERVAL_MS = 1_000
const DEFAULT_PRESENCE_TTL_MS = 5_000
const DEFAULT_POLL_INTERVAL_MS = 1_000
const DEFAULT_DELIVERY_LEASE_MS = 30_000
const DEFAULT_RETRY_BASE_MS = 250
const DEFAULT_RETRY_MAX_MS = 10_000
const DEFAULT_MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1_000
const DEFAULT_MAX_ATTEMPTS = 20
const DEFAULT_MAX_MESSAGE_BYTES = 256 * 1_024
const DEFAULT_ACK_WAIT_MS = 1_500
const DEFAULT_ACK_POLL_MS = 50
const DEFAULT_SOCKET_TIMEOUT_MS = 500
const POLICY_REVOKED_ERROR = 'permission denied: policy changed before Inbox claim'

/** DSH-native local provider. One instance serves all root Agents in a process. */
export class LocalSessionMessaging extends SessionMessaging {
  static inject = ['agents', 'sessions', 'sessionQuery', 'sessionTitle', 'timer']

  static Config: z<Config> = z.object({
    root: z.string().default(DEFAULT_ROOT),
    heartbeatIntervalMs: z.number().step(1).min(50).default(DEFAULT_HEARTBEAT_INTERVAL_MS),
    presenceTtlMs: z.number().step(1).min(250).default(DEFAULT_PRESENCE_TTL_MS),
    pollIntervalMs: z.number().step(1).min(50).default(DEFAULT_POLL_INTERVAL_MS),
    deliveryLeaseMs: z.number().step(1).min(250).default(DEFAULT_DELIVERY_LEASE_MS),
    retryBaseMs: z.number().step(1).min(0).default(DEFAULT_RETRY_BASE_MS),
    retryMaxMs: z.number().step(1).min(1).default(DEFAULT_RETRY_MAX_MS),
    messageTtlMs: z.number().step(1).min(1_000).default(DEFAULT_MESSAGE_TTL_MS),
    maxAttempts: z.number().step(1).min(1).default(DEFAULT_MAX_ATTEMPTS),
    maxMessageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_MESSAGE_BYTES),
    ackWaitMs: z.number().step(1).min(0).default(DEFAULT_ACK_WAIT_MS),
    ackPollMs: z.number().step(1).min(1).default(DEFAULT_ACK_POLL_MS),
    socketTimeoutMs: z.number().step(1).min(1).default(DEFAULT_SOCKET_TIMEOUT_MS),
  })

  private readonly config: ResolvedConfig
  private readonly database: MessagingDatabase
  private readonly instanceId = randomUUID()
  private readonly processIdentity = currentProcessIdentity()
  private readonly bindings = new Map<string, RootBinding>()
  private readonly writerBindings = new Map<string, SessionWriterBinding>()
  private readonly pumps = new Map<string, PumpState>()
  private readonly work = new Set<Promise<unknown>>()
  private readonly permissionDiscards = new Set<string>()
  private readonly controlHandlers = new Map<string, RegisteredControlHandler>()
  private readonly retiredControlKinds = new Set<string>()
  private notifier?: PokeServer
  private initialized = false
  private closed = false
  private closePromise?: Promise<void>

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = resolveConfig(config)
    if (this.config.presenceTtlMs <= this.config.heartbeatIntervalMs * 2) {
      throw new SessionMessagingError(
        'presenceTtlMs must be greater than twice heartbeatIntervalMs',
        'INVALID_MESSAGE',
      )
    }
    if (this.config.retryMaxMs < this.config.retryBaseMs) {
      throw new SessionMessagingError(
        'retryMaxMs must be greater than or equal to retryBaseMs',
        'INVALID_MESSAGE',
      )
    }
    this.database = new MessagingDatabase({
      path: join(this.config.root, 'mailbox.sqlite3'),
      maxPayloadBytes: this.config.maxMessageBytes + 16_384,
    })
    ctx.effect(() => () => this.close(), 'local-session-messaging.lifecycle()')
  }

  /** Cordis awaits this before making the class plugin active. */
  async [Service.init](): Promise<void> {
    if (this.initialized) return
    this.ensureNotClosed()
    this.notifier = await createPokeServer({
      socketDir: socketDirectory(this.config.root),
      socketName: `poke-${this.instanceId}.sock`,
      connectionTimeoutMs: this.config.socketTimeoutMs,
      onPoke: () => this.requestAllPumps(),
      onError: error => this.ctx.logger.warn(
        `local-session-messaging: notifier error: ${errorText(error)}`,
      ),
    })

    this.ctx.on('agent/created', ({ agent }) => {
      if (this.closed) return
      this.attachSessionWriter(agent)
      if (this.isRoot(agent)) this.attachRoot(agent)
    })
    this.ctx.on('agent/session-start', ({ agent }) => {
      const binding = this.bindings.get(String(agent.id))
      if (binding?.agent === agent) void this.requestPump(binding)
    })
    this.ctx.on('agent/status', ({ agent, status }) => {
      const binding = this.bindings.get(String(agent.id))
      if (binding?.agent !== agent || binding.conflicted || this.closed) return
      try {
        this.database.heartbeatPresence({
          ...binding.claim,
          leaseMs: this.config.presenceTtlMs,
          agentStatus: status,
          ...this.presenceMetadata(agent),
        })
        this.emitPeersChanged()
      } catch (error) {
        this.handlePresenceError(binding, error)
      }
      void this.requestPump(binding)
    })
    this.ctx.on('agent/disposed', ({ agent }) => this.detachRoot(agent))
    this.ctx.on('agent/inbox/discarded', ({ agent, message }) => {
      const source = relaySource(message)
      const binding = this.bindings.get(String(agent.id))
      if (source === undefined || binding?.agent !== agent) return
      const snapshot = safeGetMessage(this.database, String(message.id))
      if (snapshot === undefined
        || snapshot.recipientSessionId !== binding.claim.sessionId
        || !canonicalRelayMatches(message, snapshot)) {
        this.ctx.logger.error(
          `local-session-messaging: ignored non-canonical discarded relay ${String(message.id)}`,
        )
        return
      }
      const permissionRevoked = this.permissionDiscards.delete(String(message.id))
      this.track(this.flushAndMarkDiscarded(
        binding,
        message.id,
        permissionRevoked ? POLICY_REVOKED_ERROR : 'DSH Inbox discarded the relay',
      ))
    })
    this.ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      const source = relaySource(message)
      const binding = this.bindings.get(String(agent.id))
      if (source === undefined || binding?.agent !== agent) return
      const snapshot = safeGetMessage(this.database, String(message.id))
      if (snapshot === undefined
        || snapshot.recipientSessionId !== binding.claim.sessionId
        || !canonicalRelayMatches(message, snapshot)) {
        this.ctx.logger.error(
          `local-session-messaging: ignored non-canonical claimed relay ${String(message.id)}`,
        )
        return
      }
      // `claimed` deliberately means this Inbox edge, including a pre-step
      // rejection that never appends user/message. It is not a completion ACK.
      this.track(this.flushAndMarkClaimed(binding, message.id))
    })
    this.ctx.on('session/event', (session, event) => {
      if (this.closed || event.type !== 'session/title') return
      const binding = this.bindings.get(String(session.id))
      if (binding?.agent.session !== session || binding.conflicted) return
      try {
        this.database.heartbeatPresence({
          ...binding.claim,
          leaseMs: this.config.presenceTtlMs,
          agentStatus: binding.agent.status,
          ...this.presenceMetadata(binding.agent),
        })
        this.emitPeersChanged()
      } catch (error) {
        this.handlePresenceError(binding, error)
      }
    })
    this.ctx.interval(() => this.heartbeat(), this.config.heartbeatIntervalMs)
    this.ctx.interval(() => this.poll(), this.config.pollIntervalMs)

    for (const agent of this.ctx.agents.roots()) this.attachRoot(agent)
    this.initialized = true
    this.requestAllPumps()
  }

  async listPeers(caller: Agent, signal?: AbortSignal): Promise<PeerSessionSnapshot[]> {
    this.ensureReady()
    this.assertLiveCaller(caller)
    signal?.throwIfAborted()
    const principal = this.policyPrincipal(caller)
    const peers = await this.projectPresence(this.database.listPresence({ activeOnly: false }), signal)
    const principalId = String(principal)
    const senderAllowed = this.database.getSessionPolicy(principalId).sendAllowed
    const recipientPolicies = new Map(
      this.database.listSessionPolicies().map(policy => [policy.principalSessionId, policy]),
    )
    const blocked = new Set(
      this.database.listPairBlocks(principalId).map(block => otherPrincipal(block, principalId)),
    )
    return peers
      .filter(peer => peer.sessionId !== principal)
      .map(peer => ({
        ...peer,
        // This is only a caller-facing snapshot. The enqueue transaction below
        // repeats the same checks and remains the authorization authority.
        sendable: senderAllowed
          && (recipientPolicies.get(String(peer.sessionId))?.receiveAllowed ?? true)
          && !blocked.has(String(peer.sessionId)),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)
        || String(left.sessionId).localeCompare(String(right.sessionId)))
  }

  async send(
    caller: Agent,
    request: PeerMessageRequest,
    signal?: AbortSignal,
  ): Promise<PeerMessageReceipt> {
    this.ensureReady()
    this.assertLiveCaller(caller)
    signal?.throwIfAborted()
    const text = validateMessageText(request.text, this.config.maxMessageBytes)

    const presences = this.database.listPresence({ activeOnly: false })
    const senderPrincipal = this.policyPrincipal(caller)
    const { target, presence } = await this.resolveTarget(
      presences,
      String(senderPrincipal),
      request.recipient,
      signal,
    )
    const sender = presences.find(item => item.sessionId === String(senderPrincipal))
    const connected = isPresenceConnected(presence)
    const deliveryMode = connected && presence.agentStatus === 'running' ? 'steer' : 'followup'
    const payload: RelayPayload = {
      version: 1,
      text,
      senderName: presenceName(sender, String(senderPrincipal)),
      ...(request.replyTo === undefined ? {} : { replyTo: String(request.replyTo) }),
    }
    let enqueued
    try {
      enqueued = this.database.enqueue({
        messageId: randomUUID(),
        senderSessionId: String(caller.id),
        recipientSessionId: presence.sessionId,
        senderPrincipalSessionId: String(senderPrincipal),
        recipientPrincipalSessionId: presence.sessionId,
        deliveryMode,
        payload: payload as unknown as JsonValue,
        ttlMs: this.config.messageTtlMs,
        maxAttempts: this.config.maxAttempts,
      })
    } catch (error) {
      throw mapMessagingError(error)
    }
    this.emitStatus(enqueued.message, target.name)

    const local = this.bindings.get(presence.sessionId)
    if (local !== undefined && !local.conflicted) {
      // Keep the caller-facing ACK bound identical to cross-process delivery.
      // A slow persistence flush belongs to the detached receiver pump.
      void this.requestPump(local)
    } else if (connected && presence.endpoint !== undefined) {
      try {
        await sendPoke(presence.endpoint, { timeoutMs: this.config.socketTimeoutMs })
      } catch (error) {
        // The envelope is already committed. A notifier failure is only a
        // latency loss; rejecting here would invite a duplicate caller retry.
        this.ctx.logger.warn(
          `local-session-messaging: poke failed after enqueue; polling will recover: ${errorText(error)}`,
        )
      }
    }

    // Durability is already committed. Caller cancellation after this point may
    // shorten ACK waiting, but it never retracts or ambiguously re-enqueues work.
    if (!signal?.aborted && connected && this.config.ackWaitMs > 0) {
      await this.waitForAcknowledgement(enqueued.message.messageId, signal)
    }
    const current = this.database.getMessage(enqueued.message.messageId) ?? enqueued.message
    return this.receipt(current, target.name)
  }

  async sendControl(
    caller: Agent,
    request: ControlRequest,
    signal?: AbortSignal,
  ): Promise<ControlReceipt> {
    this.ensureReady()
    this.assertLiveCaller(caller)
    signal?.throwIfAborted()
    let payload
    try {
      payload = durableControlPayload(request.kind, request.payload, request.payloadHash)
    } catch (error) {
      throw mapMessagingError(error)
    }

    const presences = this.database.listPresence({ activeOnly: false })
    const senderPrincipal = this.policyPrincipal(caller)
    const { target, presence } = await this.resolveTarget(
      presences,
      String(senderPrincipal),
      request.recipient,
      signal,
    )
    let enqueued
    try {
      enqueued = this.database.enqueue({
        messageId: request.controlId,
        senderSessionId: String(caller.id),
        recipientSessionId: presence.sessionId,
        senderPrincipalSessionId: String(senderPrincipal),
        recipientPrincipalSessionId: presence.sessionId,
        channel: 'control',
        // Controls never use this field; retaining it keeps one proven queue.
        deliveryMode: 'followup',
        payload: payload as unknown as JsonValue,
        ttlMs: this.config.messageTtlMs,
        maxAttempts: this.config.maxAttempts,
      })
    } catch (error) {
      throw mapMessagingError(error)
    }
    this.emitStatus(enqueued.message, target.name)
    await this.notifyRecipient(presence)

    const connected = isPresenceConnected(presence)
    if (request.waitForAcknowledgement !== false
      && !signal?.aborted
      && connected
      && this.config.ackWaitMs > 0) {
      await this.waitForAcknowledgement(enqueued.message.messageId, signal)
    }
    const current = this.database.getMessage(enqueued.message.messageId) ?? enqueued.message
    return this.controlReceipt(current, target.name)
  }

  async getControl(
    caller: Agent,
    controlId: string,
    signal?: AbortSignal,
  ): Promise<ControlReceipt> {
    this.ensureReady()
    this.assertLiveCaller(caller)
    signal?.throwIfAborted()
    let message: MessageSnapshot | undefined
    try {
      message = this.database.getMessage(controlId)
    } catch (error) {
      throw mapMessagingError(error)
    }
    if (message === undefined || message.channel !== 'control') {
      throw new SessionMessagingError(`control ${controlId} was not found`, 'MESSAGE_NOT_FOUND')
    }
    const principal = String(this.policyPrincipal(caller))
    if (message.senderSessionId !== String(caller.id)
      && message.recipientSessionId !== String(caller.id)
      && message.senderPrincipalSessionId !== principal
      && message.recipientPrincipalSessionId !== principal) {
      throw new SessionMessagingError('control belongs to another Session', 'MESSAGE_FORBIDDEN')
    }
    return this.controlReceipt(message)
  }

  registerControlHandler(
    kindInput: string,
    registration: ControlHandlerRegistration,
  ): () => void {
    this.ensureNotClosed()
    let kind: string
    try {
      kind = validateControlKind(kindInput)
    } catch (error) {
      throw mapMessagingError(error)
    }
    if (typeof registration?.authorize !== 'function'
      || typeof registration.handle !== 'function') {
      throw new SessionMessagingError(
        'control registration requires explicit authorize and handle callbacks',
        'INVALID_MESSAGE',
      )
    }
    if (this.controlHandlers.has(kind)) {
      throw new SessionMessagingError(
        `control kind ${JSON.stringify(kind)} already has a handler`,
        'SESSION_CONFLICT',
      )
    }
    const value = { registration, identity: Symbol(kind) }
    this.retiredControlKinds.delete(kind)
    this.controlHandlers.set(kind, value)
    this.requestAllPumps()
    return () => {
      if (this.controlHandlers.get(kind)?.identity === value.identity) {
        this.controlHandlers.delete(kind)
        // A known domain handler disappearing is a lifecycle handoff, not an
        // authorization verdict. Preserve stable control ids for re-registration.
        this.retiredControlKinds.add(kind)
      }
    }
  }

  async reserveSessionWriter(sessionId: SessionId): Promise<SessionWriterLease> {
    this.ensureReady()
    const binding = this.acquireSessionWriterBinding(String(sessionId))
    const liveAgent = this.ctx.agents.get(sessionId)
    if (liveAgent !== undefined) binding.agents.add(liveAgent)
    const reservation = Symbol(String(sessionId))
    binding.reservations.add(reservation)
    let releasePromise: Promise<void> | undefined
    return Object.freeze({
      sessionId,
      instanceId: binding.snapshot.instanceId,
      ownerToken: binding.snapshot.ownerToken,
      fenceToken: binding.snapshot.fenceToken,
      release: () => {
        releasePromise ??= this.releaseWriterReservation(binding, reservation)
        return releasePromise
      },
    })
  }

  async getMessage(
    caller: Agent,
    messageId: DshMessageId,
    signal?: AbortSignal,
  ): Promise<PeerMessageReceipt> {
    this.ensureReady()
    this.assertLiveCaller(caller)
    signal?.throwIfAborted()
    let message: MessageSnapshot | undefined
    try {
      message = this.database.getMessage(String(messageId))
    } catch (error) {
      throw mapMessagingError(error)
    }
    if (message === undefined) {
      throw new SessionMessagingError(`message ${String(messageId)} was not found`, 'MESSAGE_NOT_FOUND')
    }
    if (message.channel !== 'text') {
      throw new SessionMessagingError(`message ${String(messageId)} was not found`, 'MESSAGE_NOT_FOUND')
    }
    if (message.senderSessionId !== String(caller.id)
      && message.recipientSessionId !== String(caller.id)) {
      throw new SessionMessagingError('message belongs to another Session', 'MESSAGE_FORBIDDEN')
    }
    const presence = this.database.getPresence(message.recipientSessionId)
    const name = presenceName(presence, message.recipientSessionId)
    return this.receipt(message, name)
  }

  async getPermissions(
    caller: Agent,
    signal?: AbortSignal,
  ): Promise<SessionMessagingPermissions> {
    this.ensureReady()
    this.assertLiveCaller(caller)
    signal?.throwIfAborted()
    return projectPolicy(this.database.getSessionPolicy(String(this.policyPrincipal(caller))))
  }

  async setPermissions(
    caller: Agent,
    patch: SessionMessagingPermissionPatch,
    signal?: AbortSignal,
  ): Promise<SessionMessagingPermissions> {
    this.ensureReady()
    this.assertLiveCaller(caller)
    signal?.throwIfAborted()
    if (patch.sendAllowed === undefined && patch.receiveAllowed === undefined) {
      throw new SessionMessagingError('a send or receive permission is required', 'INVALID_MESSAGE')
    }
    let policy: SessionPolicySnapshot
    try {
      policy = this.database.setSessionPolicy({
        principalSessionId: String(this.policyPrincipal(caller)),
        ...(patch.sendAllowed === undefined ? {} : { sendAllowed: patch.sendAllowed }),
        ...(patch.receiveAllowed === undefined ? {} : { receiveAllowed: patch.receiveAllowed }),
      })
    } catch (error) {
      throw mapMessagingError(error)
    }
    this.notifyPolicyChange()
    return projectPolicy(policy)
  }

  async listBlockedPeers(
    caller: Agent,
    signal?: AbortSignal,
  ): Promise<BlockedPeerSnapshot[]> {
    this.ensureReady()
    this.assertLiveCaller(caller)
    signal?.throwIfAborted()
    const principal = String(this.policyPrincipal(caller))
    const blocks = this.database.listPairBlocks(principal)
    if (blocks.length === 0) return []
    const names = await this.blockedPeerNames(principal, blocks, signal)
    return blocks.map(block => {
      const peerId = otherPrincipal(block, principal)
      return {
        sessionId: SessionId(peerId),
        name: names.get(peerId) ?? fallbackSessionName(peerId),
        blockedAt: block.blockedAt,
      }
    }).sort((left, right) => left.name.localeCompare(right.name)
      || String(left.sessionId).localeCompare(String(right.sessionId)))
  }

  async setPeerBlocked(
    caller: Agent,
    recipient: string,
    blocked: boolean,
    signal?: AbortSignal,
  ): Promise<BlockedPeerSnapshot> {
    this.ensureReady()
    this.assertLiveCaller(caller)
    signal?.throwIfAborted()
    if (typeof blocked !== 'boolean') {
      throw new SessionMessagingError('blocked must be boolean', 'INVALID_MESSAGE')
    }
    const principal = String(this.policyPrincipal(caller))
    const presences = this.database.listPresence({ activeOnly: false })
    const { target } = await this.resolveTarget(presences, principal, recipient, signal)
    let result: PairBlockSnapshot | undefined
    try {
      result = this.database.setPairBlocked({
        firstPrincipalSessionId: principal,
        secondPrincipalSessionId: String(target.sessionId),
        blocked,
      })
    } catch (error) {
      throw mapMessagingError(error)
    }
    this.notifyPolicyChange()
    return {
      sessionId: target.sessionId,
      name: target.name,
      blockedAt: result?.blockedAt ?? Date.now(),
    }
  }

  private acquireSessionWriterBinding(sessionId: string): SessionWriterBinding {
    this.ensureNotClosed()
    const existing = this.writerBindings.get(sessionId)
    if (existing !== undefined && !existing.released) return existing

    let current: SessionWriterSnapshot | undefined
    try {
      current = this.database.getSessionWriter(sessionId)
    } catch (error) {
      throw mapMessagingError(error)
    }
    let takeover
    if (current?.active) {
      if (!isMechanicallyDeadWriter(current, this.processIdentity)) {
        throw new SessionMessagingError(
          `Session ${sessionId} has another live persistence writer`,
          'SESSION_CONFLICT',
        )
      }
      takeover = {
        instanceId: current.instanceId,
        ownerToken: current.ownerToken,
        fenceToken: current.fenceToken,
      }
    }

    let snapshot: SessionWriterSnapshot
    try {
      snapshot = this.database.acquireSessionWriter({
        sessionId,
        instanceId: this.instanceId,
        ownerToken: randomUUID(),
        ...this.processIdentity,
        ...(takeover === undefined ? {} : { takeover }),
      })
    } catch (error) {
      throw mapMessagingError(error)
    }
    const binding: SessionWriterBinding = {
      snapshot,
      reservations: new Set(),
      agents: new Set(),
      drainingAgents: new Map(),
      released: false,
    }
    this.writerBindings.set(sessionId, binding)
    return binding
  }

  private async releaseWriterReservation(
    binding: SessionWriterBinding,
    reservation: symbol,
  ): Promise<void> {
    if (!binding.reservations.delete(reservation)) return
    await Promise.all(binding.drainingAgents.values())
    this.releaseSessionWriterIfUnused(binding)
  }

  private releaseSessionWriterIfUnused(binding: SessionWriterBinding): void {
    if (binding.released
      || binding.reservations.size > 0
      || binding.agents.size > 0
      || this.writerBindings.get(binding.snapshot.sessionId) !== binding) {
      return
    }
    try {
      this.database.releaseSessionWriter(binding.snapshot)
    } catch (error) {
      if (error instanceof MessagingError && error.code === 'FENCE_LOST') {
        binding.released = true
        this.writerBindings.delete(binding.snapshot.sessionId)
      }
      throw mapMessagingError(error)
    }
    binding.released = true
    this.writerBindings.delete(binding.snapshot.sessionId)
  }

  private attachSessionWriter(agent: Agent): void {
    const binding = this.writerBindings.get(String(agent.id))
    if (binding !== undefined && !binding.released) binding.agents.add(agent)
  }

  private detachSessionWriter(agent: Agent): void {
    const binding = this.writerBindings.get(String(agent.id))
    if (binding === undefined
      || !binding.agents.has(agent)
      || binding.drainingAgents.has(agent)) return

    const draining = this.flushAndDetachSessionWriter(binding, agent)
    binding.drainingAgents.set(agent, draining)
    const tracked = draining.finally(() => {
      if (binding.drainingAgents.get(agent) === draining) {
        binding.drainingAgents.delete(agent)
      }
    })
    void this.track(tracked).catch(() => undefined)
  }

  private async flushAndDetachSessionWriter(
    binding: SessionWriterBinding,
    agent: Agent,
  ): Promise<void> {
    try {
      // agent/disposed is emitted immediately before the paired Session is
      // detached. Enter the awaited SessionStore flush while that exact
      // carrier is still live, and retain the writer fence until it settles.
      await this.ctx.sessions.flush(agent.session)
    } catch (error) {
      this.ctx.logger.warn(
        `local-session-messaging: retaining Session writer ${String(agent.id)} after flush failure: ${errorText(error)}`,
      )
      return
    }
    if (!binding.agents.delete(agent)) return
    try {
      this.releaseSessionWriterIfUnused(binding)
    } catch (error) {
      this.ctx.logger.warn(
        `local-session-messaging: failed to release Session writer ${String(agent.id)}: ${errorText(error)}`,
      )
    }
  }

  private isRoot(agent: Agent): boolean {
    return this.ctx.agents.roots().includes(agent)
  }

  private presenceMetadata(agent: Agent): ReturnType<typeof presenceMetadata> {
    return presenceMetadata(agent, this.ctx.sessionTitle.get(agent.session)?.title)
  }

  private attachRoot(agent: Agent): void {
    if (this.closed || this.notifier === undefined) return
    const id = String(agent.id)
    const existing = this.bindings.get(id)
    if (existing !== undefined) {
      if (existing.agent !== agent) {
        throw new SessionMessagingError(
          `Session ${id} is represented by two local Agent objects`,
          'SESSION_CONFLICT',
        )
      }
      return
    }
    let snapshot: PresenceSnapshot
    try {
      snapshot = this.database.upsertPresence({
        sessionId: id,
        instanceId: this.instanceId,
        endpoint: this.notifier.endpoint,
        agentStatus: agent.status,
        leaseMs: this.config.presenceTtlMs,
        ...this.presenceMetadata(agent),
      })
    } catch (error) {
      throw mapMessagingError(error)
    }
    const binding: RootBinding = {
      agent,
      claim: {
        sessionId: id,
        instanceId: this.instanceId,
        fenceToken: snapshot.fenceToken,
      },
      conflicted: false,
    }
    this.bindings.set(id, binding)
    this.emitPeersChanged()
  }

  private detachRoot(agent: Agent): void {
    const id = String(agent.id)
    const binding = this.bindings.get(id)
    if (binding?.agent === agent) {
      this.bindings.delete(id)
      try {
        if (!binding.conflicted && !this.closed) this.database.releasePresence(binding.claim)
      } catch (error) {
        if (!(error instanceof MessagingError && error.code === 'FENCE_LOST')) {
          this.ctx.logger.warn(`local-session-messaging: failed to release ${id}: ${errorText(error)}`)
        }
      }
      this.emitPeersChanged()
    }
    this.detachSessionWriter(agent)
  }

  private heartbeat(): void {
    if (this.closed) return
    try {
      const expired = this.database.expirePresence()
      if (expired > 0) this.emitPeersChanged()
    } catch (error) {
      this.ctx.logger.warn(`local-session-messaging: maintenance failed: ${errorText(error)}`)
    }
    for (const binding of this.bindings.values()) {
      if (binding.conflicted) continue
      try {
        this.database.heartbeatPresence({
          ...binding.claim,
          leaseMs: this.config.presenceTtlMs,
          agentStatus: binding.agent.status,
          ...this.presenceMetadata(binding.agent),
        })
      } catch (error) {
        this.handlePresenceError(binding, error)
      }
    }
  }

  private poll(): void {
    if (this.closed) return
    // A queued lease is also the only durable witness that a process may have
    // crossed DSH Inbox admission before crashing ahead of SQLite accept.  It
    // cannot be globally requeued or terminalized without first loading that
    // recipient's Session log.  The fenced pump performs that reconciliation
    // and only then enters claimNextDelivery's recipient-scoped sweep.
    this.requestAllPumps()
  }

  private handlePresenceError(binding: RootBinding, error: unknown): void {
    if (error instanceof MessagingError
      && (error.code === 'FENCE_LOST' || error.code === 'SESSION_CONFLICT')) {
      binding.conflicted = true
      this.ctx.logger.error(
        `local-session-messaging: Session ${String(binding.agent.id)} lost its presence fence; messaging is disabled for this Session`,
      )
      this.emitPeersChanged()
      return
    }
    this.ctx.logger.warn(
      `local-session-messaging: heartbeat failed for ${String(binding.agent.id)}: ${errorText(error)}`,
    )
  }

  private requestAllPumps(): void {
    if (this.closed) return
    for (const binding of this.bindings.values()) void this.requestPump(binding)
  }

  private requestPump(binding: RootBinding): Promise<void> {
    if (this.closed || binding.conflicted || this.bindings.get(binding.claim.sessionId) !== binding) {
      return Promise.resolve()
    }
    let state = this.pumps.get(binding.claim.sessionId)
    if (state === undefined) {
      state = { requested: false, running: false, promise: undefined }
      this.pumps.set(binding.claim.sessionId, state)
    }
    state.requested = true
    if (state.running && state.promise !== undefined) return state.promise

    state.running = true
    const promise = Promise.resolve(this.ctx.agents.withoutInitiator(async () => {
      while (state!.requested
        && !this.closed
        && !binding.conflicted
        && this.bindings.get(binding.claim.sessionId) === binding) {
        state!.requested = false
        await this.pump(binding)
      }
    })).catch(error => {
      this.ctx.logger.warn(
        `local-session-messaging: mailbox pump for ${binding.claim.sessionId} failed: ${errorText(error)}`,
      )
    }).finally(() => {
      state!.running = false
      state!.promise = undefined
      if (state!.requested && !this.closed) void this.requestPump(binding)
    })
    state.promise = promise
    this.track(promise)
    return promise
  }

  private async pump(binding: RootBinding): Promise<void> {
    await this.reconcileDurableInbox(binding)
    while (!this.closed && !binding.conflicted) {
      let delivery: DeliveryLease | undefined
      try {
        delivery = this.database.claimNextDelivery({
          ...binding.claim,
          recipientSessionId: binding.claim.sessionId,
          leaseMs: this.config.deliveryLeaseMs,
        })
      } catch (error) {
        this.handlePresenceError(binding, error)
        return
      }
      if (delivery === undefined) return
      try {
        await this.deliverLeased(binding, delivery)
      } catch (error) {
        if (error instanceof MessagingError
          && (error.code === 'FENCE_LOST' || error.code === 'SESSION_CONFLICT')) {
          this.handlePresenceError(binding, error)
          return
        }
        if (delivery.message.channel === 'control') {
          await this.retryControlLeased(binding, delivery, error)
        } else {
          await this.retryLeased(binding, delivery, error)
        }
        return // strict FIFO: the delayed head blocks later envelopes
      }
    }
  }

  private async deliverLeased(binding: RootBinding, delivery: DeliveryLease): Promise<void> {
    const current = this.database.getMessage(delivery.message.messageId)
    if (current === undefined || current.status !== 'queued') {
      if (current !== undefined) this.emitStatus(current)
      return
    }
    if (current.channel === 'control') {
      await this.deliverControlLeased(binding, delivery, current)
      return
    }
    if (!communicationAllowed(this.database, current)) {
      const denied = this.database.failDelivery({
        ...deliveryMutation(binding, delivery),
        error: 'permission denied before DSH Inbox admission',
      })
      this.emitStatus(denied)
      return
    }
    // The pump reconciles every accepted or lease-bearing crash candidate once
    // before claiming fresh work. DSH Inbox identity/digest checks make this
    // stable MessageId insertion idempotent across a later retry.
    const message = relayMessage(delivery.message)
    deliverToAgent(binding.agent, delivery.message.deliveryMode, message)
    await this.flushInbox(binding.agent.session)
    const accepted = this.database.acceptDelivery(deliveryMutation(binding, delivery))
    this.emitStatus(accepted)
  }

  private async deliverControlLeased(
    binding: RootBinding,
    delivery: DeliveryLease,
    current: MessageSnapshot,
  ): Promise<void> {
    let payload
    try {
      payload = parseDurableControlPayload(current.payload)
    } catch (error) {
      throw new SessionMessagingError(errorText(error), 'INVALID_MESSAGE', { cause: error })
    }
    const incoming: IncomingControl = {
      controlId: current.messageId,
      kind: payload.kind,
      payload: payload.payload,
      payloadHash: payload.payloadHash,
      senderSessionId: SessionId(current.senderSessionId),
      senderPrincipalSessionId: SessionId(current.senderPrincipalSessionId),
      recipientSessionId: SessionId(current.recipientSessionId),
      recipientPrincipalSessionId: SessionId(current.recipientPrincipalSessionId),
      attempt: current.attemptCount,
    }
    if (!directionalPolicyAllowed(this.database, current)) {
      const completed = this.database.completeControlDelivery({
        ...deliveryMutation(binding, delivery),
        kind: payload.kind,
        payloadHash: payload.payloadHash,
        outcomeStatus: 'rejected',
        detail: 'control rejected: sender send or recipient receive is disabled',
      })
      this.emitStatus(completed.message)
      return
    }
    const registered = this.controlHandlers.get(payload.kind)
    if (registered === undefined) {
      if (this.retiredControlKinds.has(payload.kind)) {
        throw new SessionMessagingError(
          `control handler ${JSON.stringify(payload.kind)} is temporarily unavailable`,
          'SERVICE_CLOSED',
        )
      }
      const completed = this.database.completeControlDelivery({
        ...deliveryMutation(binding, delivery),
        kind: payload.kind,
        payloadHash: payload.payloadHash,
        outcomeStatus: 'rejected',
        detail: 'no explicit control handler is registered',
      })
      this.emitStatus(completed.message)
      return
    }

    const allowed = await registered.registration.authorize(incoming)
    if (allowed !== true) {
      const completed = this.database.completeControlDelivery({
        ...deliveryMutation(binding, delivery),
        kind: payload.kind,
        payloadHash: payload.payloadHash,
        outcomeStatus: 'rejected',
        detail: 'control authorizer denied the envelope',
      })
      this.emitStatus(completed.message)
      return
    }

    const decision = await registered.registration.handle(incoming)
    assertControlHandlerDecision(decision)
    const completed = this.database.completeControlDelivery({
      ...deliveryMutation(binding, delivery),
      kind: payload.kind,
      payloadHash: payload.payloadHash,
      outcomeStatus: decision.status,
      ...(decision.result === undefined ? {} : { result: decision.result }),
      ...(decision.status === 'rejected' && decision.detail !== undefined
        ? { detail: decision.detail }
        : {}),
    })
    this.emitStatus(completed.message)
  }

  private async retryLeased(
    binding: RootBinding,
    delivery: DeliveryLease,
    error: unknown,
  ): Promise<void> {
    const detail = errorText(error)
    try {
      const invalid = error instanceof SessionMessagingError && error.code === 'INVALID_MESSAGE'
      const snapshot = invalid
        ? this.database.failDelivery({
            ...deliveryMutation(binding, delivery),
            error: detail,
          })
        : this.database.retryDelivery({
            ...deliveryMutation(binding, delivery),
            retryDelayMs: retryDelay(
              delivery.message.attemptCount,
              this.config.retryBaseMs,
              this.config.retryMaxMs,
            ),
            error: detail,
          }).message
      this.emitStatus(snapshot)
    } catch (mutationError) {
      const current = this.database.getMessage(delivery.message.messageId)
      if (current !== undefined && current.status !== 'queued') {
        this.emitStatus(current)
        return
      }
      throw mutationError
    }
  }

  private async retryControlLeased(
    binding: RootBinding,
    delivery: DeliveryLease,
    error: unknown,
  ): Promise<void> {
    let payload
    try {
      payload = parseDurableControlPayload(delivery.message.payload)
    } catch {
      const failed = this.database.failDelivery({
        ...deliveryMutation(binding, delivery),
        error: errorText(error),
      })
      this.emitStatus(failed)
      return
    }
    const detail = errorText(error)
    try {
      const invalid = error instanceof SessionMessagingError && error.code === 'INVALID_MESSAGE'
      const result = invalid
        ? this.database.failControlDelivery({
            ...deliveryMutation(binding, delivery),
            kind: payload.kind,
            payloadHash: payload.payloadHash,
            error: detail,
          })
        : this.database.retryControlDelivery({
            ...deliveryMutation(binding, delivery),
            kind: payload.kind,
            payloadHash: payload.payloadHash,
            retryDelayMs: retryDelay(
              delivery.message.attemptCount,
              this.config.retryBaseMs,
              this.config.retryMaxMs,
            ),
            error: detail,
          })
      this.emitStatus(result.message)
    } catch (mutationError) {
      const current = this.database.getMessage(delivery.message.messageId)
      if (current !== undefined && current.status !== 'queued') {
        this.emitStatus(current)
        return
      }
      throw mutationError
    }
  }

  /** Recover status edges that happened while this provider was down. */
  private async reconcileDurableInbox(binding: RootBinding): Promise<void> {
    const durableCandidates = this.database.listReconciliationCandidates(
      binding.claim.sessionId,
    )
    if (durableCandidates.length === 0) return
    const candidatesById = new Map(
      durableCandidates.map(candidate => [candidate.messageId, candidate]),
    )
    const lifecycle = foldRelayLifecycle(binding.agent, candidatesById)
    for (const candidate of durableCandidates) {
      if (lifecycle.claimed.has(candidate.messageId)
        || lifecycle.removedForClaim.has(candidate.messageId)) {
        this.emitStatus(this.database.markClaimed({
          ...binding.claim,
          messageId: candidate.messageId,
        }))
        continue
      }
      if (lifecycle.canceled.has(candidate.messageId)) {
        this.emitStatus(this.database.markDiscarded({
          ...binding.claim,
          messageId: candidate.messageId,
          error: 'relay was durably canceled in the DSH Inbox',
        }))
        continue
      }

      // The DSH Session log is the recovery authority for the cross-store
      // crash window.  Establish accepted before authorization cleanup so a
      // later permission discard preserves the true Inbox-admission timestamp.
      let message = candidate
      if (lifecycle.pending.has(message.messageId) && message.status === 'queued') {
        message = this.database.recoverAccepted({
          ...binding.claim,
          messageId: message.messageId,
        })
        this.emitStatus(message)
      }

      if (!communicationAllowed(this.database, message)) {
        if (lifecycle.pending.has(message.messageId)) {
          this.permissionDiscards.add(message.messageId)
          const removed = binding.agent.inbox.remove(MessageId(message.messageId))
          if (!removed) {
            this.permissionDiscards.delete(message.messageId)
            const refreshed = foldRelayLifecycle(binding.agent, candidatesById)
            if (refreshed.claimed.has(message.messageId)
              || refreshed.removedForClaim.has(message.messageId)) {
              this.emitStatus(this.database.markClaimed({
                ...binding.claim,
                messageId: message.messageId,
              }))
              continue
            }
          } else {
            this.permissionDiscards.delete(message.messageId)
            await this.flushInbox(binding.agent.session)
          }
        }
        this.emitStatus(this.database.markDiscarded({
          ...binding.claim,
          messageId: message.messageId,
          error: POLICY_REVOKED_ERROR,
        }))
        continue
      }
      if (lifecycle.pending.has(message.messageId)) continue

      // A queued item with no DSH durable fact has never crossed Inbox
      // admission; the ordinary lease/TTL/attempt state machine owns it.
      if (message.status === 'queued') continue

      // Accepted implies an earlier durable Inbox insertion. If neither the
      // pending projection nor a later claimed/canceled deletion contains it,
      // repair the projection with the same stable identity.
      const recovered = relayMessage(message)
      deliverToAgent(binding.agent, message.deliveryMode, recovered)
      await this.flushInbox(binding.agent.session)
    }
  }

  private async flushAndMarkClaimed(binding: RootBinding, messageId: DshMessageId): Promise<void> {
    try {
      await this.flushInbox(binding.agent.session)
      const snapshot = this.database.markClaimed({
        ...binding.claim,
        messageId: String(messageId),
      })
      this.emitStatus(snapshot)
    } catch (error) {
      const current = safeGetMessage(this.database, String(messageId))
      if (current?.status === 'claimed') return
      this.ctx.logger.warn(
        `local-session-messaging: failed to checkpoint claimed message ${String(messageId)}: ${errorText(error)}`,
      )
    }
  }

  private async flushAndMarkDiscarded(
    binding: RootBinding,
    messageId: DshMessageId,
    detail: string,
  ): Promise<void> {
    try {
      await this.flushInbox(binding.agent.session)
      const snapshot = this.database.markDiscarded({
        ...binding.claim,
        messageId: String(messageId),
        error: detail,
      })
      this.emitStatus(snapshot)
    } catch (error) {
      const current = safeGetMessage(this.database, String(messageId))
      if (current?.status === 'failed' || current?.status === 'claimed') return
      this.ctx.logger.warn(
        `local-session-messaging: failed to checkpoint discarded message ${String(messageId)}: ${errorText(error)}`,
      )
    }
  }

  private async flushInbox(session: Session): Promise<void> {
    const participated = await this.ctx.sessions.flush(session)
    if (!participated) {
      throw new Error('no DSH session persistence provider participated in Inbox flush')
    }
  }

  private async waitForAcknowledgement(messageId: string, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.config.ackWaitMs
    while (!signal?.aborted && Date.now() < deadline) {
      const current = this.database.getMessage(messageId)
      if (current === undefined || current.status !== 'queued') return
      const remaining = deadline - Date.now()
      if (remaining <= 0) return
      try {
        await sleep(Math.min(this.config.ackPollMs, remaining), undefined, { signal })
      } catch {
        return
      }
    }
  }

  private async projectPresence(
    presences: readonly PresenceSnapshot[],
    signal?: AbortSignal,
  ): Promise<PresencePeerSnapshot[]> {
    const ids = presences
      .filter(presence => !isPresenceConnected(presence))
      .map(presence => SessionId(presence.sessionId))
    const titles = new Map<string, string>()
    if (ids.length > 0) {
      try {
        const results = await this.ctx.sessionQuery.readTitleSnapshots(ids, signal)
        for (const result of results) {
          if (result.status !== 'fulfilled' || result.value.title === undefined) continue
          titles.set(String(result.sessionId), result.value.title.title)
        }
      } catch (error) {
        if (signal?.aborted) throw error
        this.ctx.logger.debug(
          `local-session-messaging: title projection unavailable: ${errorText(error)}`,
        )
      }
    }
    return presences.map(presence => presencePeerSnapshot(
      presence,
      titles.get(presence.sessionId) ?? presence.title,
    ))
  }

  private async resolveTarget(
    presences: readonly PresenceSnapshot[],
    callerSessionId: string,
    addressInput: string,
    signal?: AbortSignal,
  ): Promise<{ readonly target: PresencePeerSnapshot; readonly presence: PresenceSnapshot }> {
    const address = normalizePeerAddress(addressInput, callerSessionId)
    const exact = presences.find(presence => presence.sessionId === address)
    if (exact !== undefined) {
      return { target: presencePeerSnapshot(exact), presence: exact }
    }

    const peers = await this.projectPresence(presences, signal)
    const target = resolvePeer(peers, callerSessionId, address)
    const presence = presences.find(item => item.sessionId === String(target.sessionId))
    if (presence === undefined) {
      throw new SessionMessagingError('recipient disappeared during resolution', 'UNKNOWN_TARGET')
    }
    return { target, presence }
  }

  private policyPrincipal(agent: Agent): SessionId {
    let current = agent
    const visited = new Set<string>()
    const roots = new Set(this.ctx.agents.roots())
    while (!visited.has(String(current.id))) {
      if (roots.has(current)) {
        const binding = this.bindings.get(String(current.id))
        if (binding?.agent !== current || binding.conflicted) {
          throw new SessionMessagingError(
            `root Session ${String(current.id)} has no current messaging presence fence`,
            'SESSION_CONFLICT',
          )
        }
        return current.id
      }
      visited.add(String(current.id))
      const owner = this.ctx.agents.list().find(candidate =>
        this.ctx.agents.isOwnedBy(current.id, candidate),
      )
      if (owner === undefined) {
        throw new SessionMessagingError(
          `cannot resolve root policy principal for non-root Agent ${String(current.id)}`,
          'SESSION_CONFLICT',
        )
      }
      current = owner
    }
    throw new SessionMessagingError('Agent ownership cycle prevents authorization', 'SESSION_CONFLICT')
  }

  private async blockedPeerNames(
    principal: string,
    blocks: readonly PairBlockSnapshot[],
    signal?: AbortSignal,
  ): Promise<Map<string, string>> {
    const ids = new Set(blocks.map(block => otherPrincipal(block, principal)))
    const rows = this.database.listPresence({ activeOnly: false })
      .filter(presence => ids.has(presence.sessionId))
    const peers = await this.projectPresence(rows, signal)
    return new Map(peers.map(peer => [String(peer.sessionId), peer.name]))
  }

  private notifyPolicyChange(): void {
    this.requestAllPumps()
    const ownEndpoint = this.notifier?.endpoint.socketPath
    const endpoints = new Map<string, PresenceSnapshot['endpoint']>()
    for (const presence of this.database.listPresence({ activeOnly: true })) {
      if (presence.endpoint === undefined || presence.endpoint.socketPath === ownEndpoint) continue
      endpoints.set(presence.endpoint.socketPath, presence.endpoint)
    }
    const notification = Promise.allSettled(
      [...endpoints.values()].map(endpoint =>
        endpoint === undefined
          ? Promise.resolve(false)
          : sendPoke(endpoint, { timeoutMs: this.config.socketTimeoutMs }),
      ),
    ).then(() => undefined)
    this.track(notification)
  }

  private async notifyRecipient(presence: PresenceSnapshot): Promise<void> {
    const local = this.bindings.get(presence.sessionId)
    if (local !== undefined && !local.conflicted) {
      void this.requestPump(local)
      return
    }
    if (!isPresenceConnected(presence) || presence.endpoint === undefined) return
    try {
      await sendPoke(presence.endpoint, { timeoutMs: this.config.socketTimeoutMs })
    } catch (error) {
      this.ctx.logger.warn(
        `local-session-messaging: control poke failed after enqueue; polling will recover: ${errorText(error)}`,
      )
    }
  }

  private receipt(message: MessageSnapshot, recipientName?: string): PeerMessageReceipt {
    return {
      messageId: MessageId(message.messageId),
      senderSessionId: SessionId(message.senderSessionId),
      recipientSessionId: SessionId(message.recipientSessionId),
      recipientName: recipientName ?? presenceName(
        safeGetPresence(this.database, message.recipientSessionId),
        message.recipientSessionId,
      ),
      status: message.status,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      ...(message.acceptedAt === undefined ? {} : { acceptedAt: message.acceptedAt }),
      ...(message.claimedAt === undefined ? {} : { claimedAt: message.claimedAt }),
      ...(message.lastError === undefined ? {} : { failure: message.lastError }),
    }
  }

  private controlReceipt(message: MessageSnapshot, recipientName?: string): ControlReceipt {
    if (message.channel !== 'control') {
      throw new SessionMessagingError('message is not a typed control', 'MESSAGE_NOT_FOUND')
    }
    let payload
    try {
      payload = parseDurableControlPayload(message.payload)
    } catch (error) {
      throw mapMessagingError(error)
    }
    const outcome = this.database.getControlOutcome(message.messageId)
    return {
      controlId: message.messageId,
      kind: payload.kind,
      payloadHash: payload.payloadHash,
      senderSessionId: SessionId(message.senderSessionId),
      recipientSessionId: SessionId(message.recipientSessionId),
      recipientName: recipientName ?? presenceName(
        safeGetPresence(this.database, message.recipientSessionId),
        message.recipientSessionId,
      ),
      status: message.status,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      ...(outcome === undefined ? {} : { outcome: projectControlOutcome(outcome) }),
      ...(message.lastError === undefined ? {} : { failure: message.lastError }),
    }
  }

  private emitStatus(message: MessageSnapshot, recipientName?: string): void {
    if (this.closed) return
    try {
      if (message.channel === 'control') {
        this.ctx.emit(
          'session-messaging/control-status',
          this.controlReceipt(message, recipientName),
        )
      } else {
        this.ctx.emit('session-messaging/message-status', this.receipt(message, recipientName))
      }
    } catch (error) {
      this.ctx.logger.warn(
        `local-session-messaging: status observer failed: ${errorText(error)}`,
      )
    }
  }

  private emitPeersChanged(): void {
    if (this.closed) return
    try {
      this.ctx.emit('session-messaging/peers-changed')
    } catch (error) {
      this.ctx.logger.warn(
        `local-session-messaging: peers-changed observer failed: ${errorText(error)}`,
      )
    }
  }

  private assertLiveCaller(caller: Agent): void {
    if (this.ctx.agents.get(caller.id) !== caller) {
      throw new SessionMessagingError('calling Agent is no longer live', 'SERVICE_CLOSED')
    }
    const binding = this.bindings.get(String(caller.id))
    if (binding?.agent === caller && binding.conflicted) {
      throw new SessionMessagingError(
        `Session ${String(caller.id)} has lost its presence fence`,
        'SESSION_CONFLICT',
      )
    }
  }

  private ensureNotClosed(): void {
    if (this.closed) throw new SessionMessagingError('messaging service is closed', 'SERVICE_CLOSED')
  }

  private ensureReady(): void {
    this.ensureNotClosed()
    if (!this.initialized || this.notifier === undefined) {
      throw new SessionMessagingError('messaging service is still initializing', 'SERVICE_CLOSED')
    }
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.work.add(promise)
    void promise.finally(() => this.work.delete(promise)).catch(() => {})
    return promise
  }

  private close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    this.closePromise = this.closeNow()
    return this.closePromise
  }

  private async closeNow(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const binding of this.bindings.values()) {
      try {
        if (!binding.conflicted) this.database.releasePresence(binding.claim)
      } catch (error) {
        if (!(error instanceof MessagingError && error.code === 'FENCE_LOST')) {
          this.ctx.logger.warn(
            `local-session-messaging: teardown release failed for ${binding.claim.sessionId}: ${errorText(error)}`,
          )
        }
      }
    }
    this.bindings.clear()
    this.controlHandlers.clear()
    this.retiredControlKinds.clear()
    while (this.work.size > 0) await Promise.allSettled([...this.work])
    await this.notifier?.close()
    for (const binding of this.writerBindings.values()) {
      if (binding.released) continue
      try {
        this.releaseSessionWriterIfUnused(binding)
      } catch (error) {
        if (!(error instanceof MessagingError && error.code === 'FENCE_LOST')) {
          this.ctx.logger.warn(
            `local-session-messaging: teardown writer release failed for ${binding.snapshot.sessionId}: ${errorText(error)}`,
          )
        }
      }
      if (!binding.released) {
        this.ctx.logger.warn(
          `local-session-messaging: retaining active Session writer ${binding.snapshot.sessionId} during teardown because references remain`,
        )
      }
    }
    this.writerBindings.clear()
    this.database.close()
  }
}

function currentProcessIdentity(): LocalProcessIdentity {
  const lookup = lookupProcess(process.pid)
  if (lookup.status !== 'running') {
    throw new SessionMessagingError(
      'cannot determine the current process start identity',
      'SERVICE_CLOSED',
    )
  }
  return {
    pid: process.pid,
    processStartId: lookup.processStartId,
    hostname: hostname(),
    bootId: currentBootId(),
  }
}

function currentBootId(): string {
  try {
    if (process.platform === 'linux') {
      const value = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
      if (value.length > 0) return `linux:${value}`
    } else if (process.platform === 'darwin') {
      const value = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.boottime'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      if (value.length > 0) return `darwin:${value}`
    }
  } catch (error) {
    throw new SessionMessagingError(
      'cannot determine the local boot identity',
      'SERVICE_CLOSED',
      { cause: error },
    )
  }
  throw new SessionMessagingError(
    `Session writer fencing is unsupported on ${process.platform}`,
    'SERVICE_CLOSED',
  )
}

function lookupProcess(pid: number): ProcessLookup {
  try {
    process.kill(pid, 0)
  } catch (error) {
    if (isErrnoCode(error, 'ESRCH')) return { status: 'dead' }
    if (!isErrnoCode(error, 'EPERM')) return { status: 'unknown' }
  }

  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const commandEnd = stat.lastIndexOf(')')
      if (commandEnd < 0) return { status: 'unknown' }
      // The suffix starts at field 3 (state); field 22 is index 19 here.
      const startTicks = stat.slice(commandEnd + 1).trim().split(/\s+/u)[19]
      return startTicks === undefined || !/^\d+$/u.test(startTicks)
        ? { status: 'unknown' }
        : { status: 'running', processStartId: `linux:${startTicks}` }
    } catch (error) {
      return isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ESRCH')
        ? { status: 'dead' }
        : { status: 'unknown' }
    }
  }

  if (process.platform === 'darwin') {
    try {
      const value = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C' },
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      return value.length === 0
        ? { status: 'unknown' }
        : { status: 'running', processStartId: `darwin:${value}` }
    } catch {
      // kill(0) already observed this PID. Failure to read its start time is
      // not mechanical proof of death, so takeover must fail closed.
      return { status: 'unknown' }
    }
  }

  return { status: 'unknown' }
}

function isMechanicallyDeadWriter(
  writer: SessionWriterSnapshot,
  current: LocalProcessIdentity,
): boolean {
  if (writer.hostname !== current.hostname) return false
  if (writer.bootId !== current.bootId) return true
  const lookup = lookupProcess(writer.pid)
  return lookup.status === 'dead'
    || (lookup.status === 'running' && lookup.processStartId !== writer.processStartId)
}

function isErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code
}

function resolveConfig(config: Config): ResolvedConfig {
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
    socketTimeoutMs: config.socketTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS,
  }
}

function socketDirectory(root: string): string {
  const suffix = join('sockets', `poke-${'0'.repeat(36)}.sock`)
  const limit = process.platform === 'darwin' ? 103 : 107
  if (Buffer.byteLength(join(root, suffix), 'utf8') <= limit) return join(root, 'sockets')
  const uid = process.getuid?.() ?? 'user'
  const digest = createHash('sha256').update(root).digest('hex').slice(0, 12)
  // macOS' TMPDIR normally lives under a long /var/folders path and can itself
  // exceed sockaddr_un once the random socket name is appended. `/tmp` is the
  // stable short spelling; the child directory is still owner-checked 0700.
  const base = process.platform === 'darwin' ? '/tmp' : tmpdir()
  return join(base, `dsh-lsm-${uid}-${digest}`)
}

function presenceMetadata(agent: Agent, title?: string): {
  readonly cwd?: string
  readonly name: string
  readonly title?: string
} {
  const cwd = agent.session.header.cwd
  return {
    ...(cwd === undefined ? {} : { cwd }),
    name: title ?? fallbackSessionName(String(agent.id), cwd),
    ...(title === undefined ? {} : { title }),
  }
}

function fallbackSessionName(sessionId: string, cwd?: string): string {
  if (cwd !== undefined) {
    const leaf = basename(cwd)
    if (leaf.length > 0) return `${leaf}-${sessionId.slice(-8)}`
  }
  return `session-${sessionId.slice(-8)}`
}

function presenceName(presence: PresenceSnapshot | undefined, sessionId: string): string {
  return presence?.title ?? presence?.name ?? fallbackSessionName(sessionId, presence?.cwd)
}

function presencePeerSnapshot(
  presence: PresenceSnapshot,
  title = presence.title,
): PresencePeerSnapshot {
  const connected = isPresenceConnected(presence)
  return {
    sessionId: SessionId(presence.sessionId),
    name: title ?? presence.name ?? fallbackSessionName(presence.sessionId, presence.cwd),
    ...(presence.cwd === undefined ? {} : { cwd: presence.cwd }),
    connection: connected ? 'connected' : 'disconnected',
    ...(connected ? { agentStatus: presence.agentStatus } : {}),
  }
}

function projectPolicy(policy: SessionPolicySnapshot): SessionMessagingPermissions {
  return {
    sessionId: SessionId(policy.principalSessionId),
    sendAllowed: policy.sendAllowed,
    receiveAllowed: policy.receiveAllowed,
    ...(policy.updatedAt === 0 ? {} : { updatedAt: policy.updatedAt }),
  }
}

function projectControlOutcome(outcome: ControlOutcomeSnapshot): NonNullable<ControlReceipt['outcome']> {
  return {
    status: outcome.status,
    completedAt: outcome.completedAt,
    ...(outcome.result === undefined ? {} : { result: outcome.result }),
    ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
  }
}

function otherPrincipal(block: PairBlockSnapshot, principal: string): string {
  if (block.firstPrincipalSessionId === principal) return block.secondPrincipalSessionId
  if (block.secondPrincipalSessionId === principal) return block.firstPrincipalSessionId
  throw new SessionMessagingError('pair block does not contain the requested Session', 'SESSION_CONFLICT')
}

function communicationAllowed(database: MessagingDatabase, message: MessageSnapshot): boolean {
  return principalsMayCommunicate(
    database,
    message.senderPrincipalSessionId,
    message.recipientPrincipalSessionId,
  )
}

function principalsMayCommunicate(
  database: MessagingDatabase,
  senderPrincipalSessionId: string,
  recipientPrincipalSessionId: string,
): boolean {
  return directionalPrincipalsAllowed(
    database,
    senderPrincipalSessionId,
    recipientPrincipalSessionId,
  ) && !database.isPairBlocked(
    senderPrincipalSessionId,
    recipientPrincipalSessionId,
  )
}

function directionalPolicyAllowed(
  database: MessagingDatabase,
  message: MessageSnapshot,
): boolean {
  return directionalPrincipalsAllowed(
    database,
    message.senderPrincipalSessionId,
    message.recipientPrincipalSessionId,
  )
}

function directionalPrincipalsAllowed(
  database: MessagingDatabase,
  senderPrincipalSessionId: string,
  recipientPrincipalSessionId: string,
): boolean {
  const sender = database.getSessionPolicy(senderPrincipalSessionId)
  const recipient = database.getSessionPolicy(recipientPrincipalSessionId)
  return sender.sendAllowed && recipient.receiveAllowed
}

function isPresenceConnected(presence: PresenceSnapshot, now = Date.now()): boolean {
  return presence.active && presence.expiresAt > now && presence.endpoint !== undefined
}

function resolvePeer(
  peers: readonly PresencePeerSnapshot[],
  callerSessionId: string,
  addressInput: string,
): PresencePeerSnapshot {
  const address = normalizePeerAddress(addressInput, callerSessionId)
  const byId = peers.filter(peer => String(peer.sessionId) === address)
  if (byId.length === 1) return byId[0]!
  if (byId.length > 1) {
    throw new SessionMessagingError(`Session id ${address} has conflicting presence rows`, 'SESSION_CONFLICT')
  }
  const exact = peers.filter(peer => peer.name === address)
  const matches = exact.length > 0
    ? exact
    : peers.filter(peer => peer.name.toLocaleLowerCase() === address.toLocaleLowerCase())
  if (matches.length === 0) {
    throw new SessionMessagingError(
      `no known local root Session is named ${JSON.stringify(address)}`,
      'UNKNOWN_TARGET',
    )
  }
  if (matches.length > 1) {
    throw new SessionMessagingError(
      `recipient ${JSON.stringify(address)} is ambiguous; use an exact Session id (${matches.map(peer => peer.sessionId).join(', ')})`,
      'AMBIGUOUS_TARGET',
    )
  }
  if (String(matches[0]!.sessionId) === callerSessionId) {
    throw new SessionMessagingError('a Session cannot message itself', 'SELF_TARGET')
  }
  return matches[0]!
}

function normalizePeerAddress(addressInput: string, callerSessionId: string): string {
  const address = addressInput.trim()
  if (address.length === 0) {
    throw new SessionMessagingError('recipient must not be empty', 'UNKNOWN_TARGET')
  }
  if (address === callerSessionId) {
    throw new SessionMessagingError('a Session cannot message itself', 'SELF_TARGET')
  }
  return address
}

function validateMessageText(value: string, maxBytes: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SessionMessagingError('message must contain non-whitespace text', 'INVALID_MESSAGE')
  }
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new SessionMessagingError(`message exceeds ${maxBytes} UTF-8 bytes`, 'INVALID_MESSAGE')
  }
  return value
}

function assertControlHandlerDecision(value: unknown): asserts value is ControlHandlerDecision {
  if (!isRecord(value)
    || (value.status !== 'completed' && value.status !== 'rejected')
    || (value.detail !== undefined
      && (typeof value.detail !== 'string' || value.detail.length === 0))) {
    throw new SessionMessagingError(
      'control handler returned an invalid decision',
      'INVALID_MESSAGE',
    )
  }
  if (value.result !== undefined) {
    try {
      canonicalJson(value.result as JsonValue)
    } catch (error) {
      throw new SessionMessagingError(
        'control handler returned a non-JSON result',
        'INVALID_MESSAGE',
        { cause: error },
      )
    }
  }
}

function relayPayload(value: JsonValue): RelayPayload {
  if (!isRecord(value)
    || value.version !== 1
    || typeof value.text !== 'string'
    || value.text.trim().length === 0
    || (value.senderName !== undefined
      && (typeof value.senderName !== 'string' || value.senderName.trim().length === 0))
    || (value.replyTo !== undefined && typeof value.replyTo !== 'string')) {
    throw new SessionMessagingError('durable relay payload is malformed', 'INVALID_MESSAGE')
  }
  return {
    version: 1,
    text: value.text,
    ...(value.senderName === undefined ? {} : { senderName: value.senderName }),
    ...(value.replyTo === undefined ? {} : { replyTo: value.replyTo }),
  }
}

function relayMessage(snapshot: MessageSnapshot): UserMessage {
  const payload = relayPayload(snapshot.payload)
  const replySessionId = SessionId(snapshot.senderPrincipalSessionId)
  const senderName = payload.senderName ?? fallbackSessionName(snapshot.senderPrincipalSessionId)
  const via = snapshot.senderSessionId === snapshot.senderPrincipalSessionId
    ? ''
    : `, via Agent ${snapshot.senderSessionId}`
  const action = payload.replyTo === undefined
    ? 'sent a message'
    : `replied to message ${payload.replyTo}`
  return freezeMessage({
    id: MessageId(snapshot.messageId),
    role: 'user',
    // DSH adapters intentionally send model-facing content, not MessageSource,
    // to the provider.  Mirror native subagent reports by framing the relay in
    // content while retaining structured provenance for the durable log/UI.
    content: [
      {
        type: 'text',
        text: `Local Session ${JSON.stringify(senderName)} (${String(replySessionId)})${via} ${action}:\n\n`,
      },
      { type: 'text', text: payload.text },
    ],
    source: {
      kind: 'local-session-relay',
      form: 'relay',
      senderSessionId: SessionId(snapshot.senderSessionId),
      replySessionId,
      senderName,
      envelopeId: snapshot.messageId,
      ...(payload.replyTo === undefined ? {} : { replyTo: MessageId(payload.replyTo) }),
    },
  })
}

function relaySource(message: {
  readonly id: unknown
  readonly source: unknown
}): LocalSessionRelaySource | undefined {
  const source = message.source
  if (!isRecord(source)
    || source.kind !== 'local-session-relay'
    || source.form !== 'relay'
    || typeof source.senderSessionId !== 'string'
    || source.senderSessionId.length === 0
    || typeof source.replySessionId !== 'string'
    || source.replySessionId.length === 0
    || (source.senderName !== undefined
      && (typeof source.senderName !== 'string' || source.senderName.length === 0))
    || typeof source.envelopeId !== 'string'
    || String(message.id) !== source.envelopeId
    || (source.replyTo !== undefined && typeof source.replyTo !== 'string')) return undefined
  return source as unknown as LocalSessionRelaySource
}

function deliverToAgent(agent: Agent, mode: MessageSnapshot['deliveryMode'], message: UserMessage): void {
  if (mode === 'steer') agent.steer(message)
  else agent.followup(message)
}

function foldRelayLifecycle(
  agent: Agent,
  candidates: ReadonlyMap<string, MessageSnapshot>,
): RelayLifecycle {
  const lists: Record<'next-turn' | 'next-step', UserMessage[]> = {
    'next-turn': [],
    'next-step': [],
  }
  const claimed = new Set<string>()
  const canceled = new Set<string>()
  const removedForClaim = new Set<string>()

  for (const event of agent.session.events.slice(agent.session.header.seedLength ?? 0)) {
    if (event.type === 'user/message') {
      const source = canonicalRelaySource(event.data, candidates)
      if (source !== undefined) {
        claimed.add(source.envelopeId)
        canceled.delete(source.envelopeId)
        removedForClaim.delete(source.envelopeId)
      }
      continue
    }
    if (event.type !== 'agent/inbox/spliced') continue
    const list = lists[event.data.target]
    const inserted = [...event.data.inserted]
    const removed = list.splice(event.data.start, event.data.removedCount ?? 0, ...inserted)
    for (const message of removed) {
      const source = canonicalRelaySource(message, candidates)
      if (source === undefined) continue
      if (event.data.outcome === 'canceled') {
        canceled.add(source.envelopeId)
        removedForClaim.delete(source.envelopeId)
      } else {
        removedForClaim.add(source.envelopeId)
        canceled.delete(source.envelopeId)
      }
    }
    for (const message of inserted) {
      const source = canonicalRelaySource(message, candidates)
      if (source === undefined) continue
      canceled.delete(source.envelopeId)
      removedForClaim.delete(source.envelopeId)
    }
  }

  const pending = new Set<string>()
  for (const message of [...agent.inbox.nextTurn, ...agent.inbox.nextStep]) {
    const source = canonicalRelaySource(message, candidates)
    if (source !== undefined) pending.add(source.envelopeId)
  }
  return { pending, claimed, canceled, removedForClaim }
}

function canonicalRelaySource(
  message: UserMessage,
  candidates: ReadonlyMap<string, MessageSnapshot>,
): LocalSessionRelaySource | undefined {
  const source = relaySource(message)
  if (source === undefined) return undefined
  const snapshot = candidates.get(source.envelopeId)
  return snapshot !== undefined && canonicalRelayMatches(message, snapshot)
    ? source
    : undefined
}

function canonicalRelayMatches(message: UserMessage, snapshot: MessageSnapshot): boolean {
  try {
    return isDeepStrictEqual(message, relayMessage(snapshot))
  } catch {
    return false
  }
}

function deliveryMutation(binding: RootBinding, delivery: DeliveryLease): DeliveryMutationOptions {
  return {
    ...binding.claim,
    messageId: delivery.message.messageId,
    leaseToken: delivery.lease.token,
  }
}

function retryDelay(attemptCount: number, base: number, max: number): number {
  if (base === 0) return 0
  return Math.min(max, base * (2 ** Math.min(20, Math.max(0, attemptCount - 1))))
}

function safeGetMessage(database: MessagingDatabase, id: string): MessageSnapshot | undefined {
  try {
    return database.getMessage(id)
  } catch {
    return undefined
  }
}

function safeGetPresence(database: MessagingDatabase, id: string): PresenceSnapshot | undefined {
  try {
    return database.getPresence(id)
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function mapMessagingError(error: unknown): SessionMessagingError {
  if (error instanceof SessionMessagingError) return error
  if (!(error instanceof MessagingError)) {
    return new SessionMessagingError(errorText(error), 'SERVICE_CLOSED', { cause: error })
  }
  switch (error.code) {
    case 'SESSION_CONFLICT':
    case 'FENCE_LOST':
      return new SessionMessagingError(error.message, 'SESSION_CONFLICT', { cause: error })
    case 'MESSAGE_NOT_FOUND':
      return new SessionMessagingError(error.message, 'MESSAGE_NOT_FOUND', { cause: error })
    case 'PERMISSION_DENIED':
      return new SessionMessagingError(error.message, 'PERMISSION_DENIED', { cause: error })
    case 'DATABASE_CLOSED':
    case 'NOTIFIER_CLOSED':
      return new SessionMessagingError(error.message, 'SERVICE_CLOSED', { cause: error })
    default:
      return new SessionMessagingError(error.message, 'INVALID_MESSAGE', { cause: error })
  }
}

export default LocalSessionMessaging
