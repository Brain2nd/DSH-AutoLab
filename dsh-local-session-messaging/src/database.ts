import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
} from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'

import {
  canonicalJson,
  MessagingError,
  isMessageChannel,
  isMessageStatus,
  type AgentPresenceStatus,
  type DeliveryMode,
  type ControlOutcomeSnapshot,
  type ControlOutcomeStatus,
  type DeliveryLease,
  type EnqueueMessage,
  type EnqueueResult,
  type FenceToken,
  type InstanceId,
  type JsonValue,
  type MessageId,
  type MessageChannel,
  type MessageListFilter,
  type MessageSnapshot,
  type MessageStatus,
  type PairBlockSnapshot,
  type PresenceClaim,
  type PresenceSnapshot,
  type RetryDecision,
  type SessionPolicySnapshot,
  type SetPairBlock,
  type SetSessionPolicy,
  type SessionIdentity,
} from './domain.js'

const SCHEMA_VERSION = 4
const WRITER_SCHEMA_VERSION = 3
const CONTROL_SCHEMA_VERSION = 2
const PREVIOUS_SCHEMA_VERSION = 1
const DEFAULT_BUSY_TIMEOUT_MS = 5_000
const DEFAULT_MAX_PAYLOAD_BYTES = 1_048_576
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const BUSY_RETRY_MAX_DELAY_MS = 25
const BUSY_RETRY_SIGNAL = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))

export interface MessagingDatabaseOptions {
  /** Absolute path in a dedicated owner-only directory. */
  readonly path: string
  readonly busyTimeoutMs?: number
  readonly maxPayloadBytes?: number
  /** Injectable wall clock for deterministic tests. */
  readonly clock?: () => number
}

export interface UpsertPresenceOptions {
  readonly sessionId: SessionIdentity
  readonly instanceId: InstanceId
  readonly endpoint: { readonly socketPath: string }
  readonly agentStatus: AgentPresenceStatus
  readonly cwd?: string | null
  readonly name?: string | null
  readonly title?: string | null
  readonly leaseMs: number
  readonly now?: number
}

export interface PresenceMutationOptions extends PresenceClaim {
  readonly now?: number
}

export interface HeartbeatPresenceOptions extends PresenceMutationOptions {
  readonly leaseMs: number
  readonly agentStatus?: AgentPresenceStatus
  readonly cwd?: string | null
  readonly name?: string | null
  readonly title?: string | null
}

export interface ListPresenceOptions {
  /** Defaults to true and excludes released or elapsed leases. */
  readonly activeOnly?: boolean
  readonly now?: number
}

export interface SessionWriterSnapshot {
  readonly sessionId: string
  readonly instanceId: string
  readonly ownerToken: string
  readonly fenceToken: number
  readonly active: boolean
  readonly pid: number
  readonly processStartId: string
  readonly hostname: string
  readonly bootId: string
  readonly acquiredAt: number
  readonly releasedAt?: number
  readonly updatedAt: number
}

export interface SessionWriterOwnerInput {
  readonly sessionId: string
  readonly instanceId: string
  readonly ownerToken: string
  readonly pid: number
  readonly processStartId: string
  readonly hostname: string
  readonly bootId: string
  readonly now?: number
}

export interface SessionWriterTakeover {
  readonly instanceId: string
  readonly ownerToken: string
  readonly fenceToken: number
}

export interface AcquireSessionWriterOptions extends SessionWriterOwnerInput {
  /** Exact prior live owner mechanically proven dead by the integration layer. */
  readonly takeover?: SessionWriterTakeover
}

export interface ReleaseSessionWriterOptions {
  readonly sessionId: string
  readonly instanceId: string
  readonly ownerToken: string
  readonly fenceToken: number
  readonly now?: number
}

export interface ClaimDeliveryOptions extends PresenceClaim {
  readonly recipientSessionId: SessionIdentity
  readonly leaseMs: number
  readonly now?: number
}

export interface DeliveryMutationOptions extends PresenceClaim {
  readonly messageId: MessageId
  readonly leaseToken: string
  readonly now?: number
}

export interface RecoverAcceptedOptions extends PresenceClaim {
  readonly messageId: MessageId
  readonly now?: number
}

export interface RetryDeliveryOptions extends DeliveryMutationOptions {
  readonly retryDelayMs: number
  readonly error: string
}

export interface FailDeliveryOptions extends DeliveryMutationOptions {
  readonly error: string
}

export interface MarkClaimedOptions extends PresenceClaim {
  readonly messageId: MessageId
  readonly now?: number
}

export interface MarkDiscardedOptions extends MarkClaimedOptions {
  readonly error: string
}

export interface CompleteControlDeliveryOptions extends DeliveryMutationOptions {
  readonly kind: string
  readonly payloadHash: string
  readonly outcomeStatus: Exclude<ControlOutcomeStatus, 'failed'>
  readonly result?: JsonValue
  readonly detail?: string
}

export interface RetryControlDeliveryOptions extends RetryDeliveryOptions {
  readonly kind: string
  readonly payloadHash: string
}

export interface FailControlDeliveryOptions extends FailDeliveryOptions {
  readonly kind: string
  readonly payloadHash: string
}

type SqliteRow = Record<string, unknown>

/**
 * Synchronous, process-local connection to the shared durable queue.
 *
 * The integration layer may place this object in a Worker when it cannot
 * tolerate synchronous SQLite calls on its event loop.  Transactions here are
 * deliberately short and never span DSH calls or Unix-socket I/O.
 */
export class MessagingDatabase {
  readonly path: string

  private readonly database: DatabaseSync
  private readonly clock: () => number
  private readonly busyTimeoutMs: number
  private readonly maxPayloadBytes: number
  private closed = false

  constructor(options: MessagingDatabaseOptions) {
    this.path = validateAndPrepareDatabasePath(options.path)
    this.clock = options.clock ?? Date.now
    this.maxPayloadBytes = positiveSafeInteger(
      options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
      'maxPayloadBytes',
    )
    const busyTimeoutMs = nonNegativeSafeInteger(
      options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
      'busyTimeoutMs',
    )
    this.busyTimeoutMs = busyTimeoutMs

    let database: DatabaseSync | undefined
    try {
      database = new DatabaseSync(this.path, { timeout: busyTimeoutMs })
      this.database = database
      this.initialize()
      this.secureSidecars()
    } catch (error) {
      try {
        database?.close()
      } catch {
        // Preserve the initialization error.
      }
      if (error instanceof MessagingError) throw error
      throw new MessagingError(
        'DATABASE_INIT_FAILED',
        `failed to initialize messaging database at ${JSON.stringify(this.path)}`,
        { cause: error },
      )
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.database.close()
  }

  /** Acquire, renew, or take over an expired SessionId presence lease. */
  upsertPresence(options: UpsertPresenceOptions): PresenceSnapshot {
    this.assertOpen()
    const sessionId = opaqueId(options.sessionId, 'sessionId')
    const instanceId = opaqueId(options.instanceId, 'instanceId')
    const socketPath = absoluteSocketPath(options.endpoint.socketPath)
    const agentStatus = validateAgentStatus(options.agentStatus)
    const cwd = optionalMetadata(options.cwd, 'cwd', 4_096)
    const name = optionalMetadata(options.name, 'name', 1_024)
    const title = optionalMetadata(options.title, 'title', 4_096)
    const now = this.resolveNow(options.now)
    const leaseMs = positiveSafeInteger(options.leaseMs, 'leaseMs')

    return this.transaction(() => {
      const current = this.selectPresence(sessionId)
      if (current === undefined) {
        const expiresAt = safeAdd(now, leaseMs, 'presence expiry')
        this.database.prepare(`
          INSERT INTO presence (
            session_id, instance_id, fence_token, socket_path, active, agent_status,
            cwd, display_name, title,
            heartbeat_at, expires_at, updated_at
          ) VALUES (?, ?, 1, ?, 1, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          sessionId,
          instanceId,
          socketPath,
          agentStatus,
          cwd ?? null,
          name ?? null,
          title ?? null,
          now,
          expiresAt,
          now,
        )
        return this.requirePresence(sessionId)
      }

      const active = integer(current, 'active') === 1
      const currentInstance = text(current, 'instance_id')
      const currentExpiry = integer(current, 'expires_at')
      const currentFence = integer(current, 'fence_token')
      const currentUpdatedAt = integer(current, 'updated_at')

      if (active && currentExpiry > now && currentInstance !== instanceId) {
        throw new MessagingError(
          'SESSION_CONFLICT',
          `session ${JSON.stringify(sessionId)} is owned by another live instance`,
        )
      }

      if (active && currentExpiry > now && currentInstance === instanceId) {
        const currentSnapshot = presenceFromRow(current)
        const heartbeatAt = Math.max(integer(current, 'heartbeat_at'), now)
        const updatedAt = Math.max(currentUpdatedAt, now)
        const expiresAt = Math.max(currentExpiry, safeAdd(now, leaseMs, 'presence expiry'))
        this.database.prepare(`
          UPDATE presence
          SET socket_path = ?, agent_status = ?, cwd = ?, display_name = ?, title = ?,
              heartbeat_at = ?, expires_at = ?, updated_at = ?
          WHERE session_id = ? AND instance_id = ? AND fence_token = ? AND active = 1
        `).run(
          socketPath,
          agentStatus,
          cwd === undefined ? currentSnapshot.cwd ?? null : cwd,
          name === undefined ? currentSnapshot.name ?? null : name,
          title === undefined ? currentSnapshot.title ?? null : title,
          heartbeatAt,
          expiresAt,
          updatedAt,
          sessionId,
          instanceId,
          currentFence,
        )
        return this.requirePresence(sessionId)
      }

      const nextFence = safeAdd(currentFence, 1, 'presence fence')
      const updatedAt = Math.max(currentUpdatedAt, now)
      const expiresAt = safeAdd(now, leaseMs, 'presence expiry')
      this.database.prepare(`
        UPDATE presence
        SET instance_id = ?, fence_token = ?, socket_path = ?, active = 1,
            agent_status = ?, cwd = ?, display_name = ?, title = ?,
            heartbeat_at = ?, expires_at = ?, updated_at = ?
        WHERE session_id = ? AND fence_token = ?
      `).run(
        instanceId,
        nextFence,
        socketPath,
        agentStatus,
        cwd ?? null,
        name ?? null,
        title ?? null,
        now,
        expiresAt,
        updatedAt,
        sessionId,
        currentFence,
      )
      return this.requirePresence(sessionId)
    })
  }

  /** Renew only an unexpired exact owner; an elapsed lease must be reacquired. */
  heartbeatPresence(options: HeartbeatPresenceOptions): PresenceSnapshot {
    this.assertOpen()
    const claim = validatePresenceClaim(options)
    const now = this.resolveNow(options.now)
    const leaseMs = positiveSafeInteger(options.leaseMs, 'leaseMs')
    const agentStatus = options.agentStatus === undefined
      ? undefined
      : validateAgentStatus(options.agentStatus)
    const cwd = optionalMetadata(options.cwd, 'cwd', 4_096)
    const name = optionalMetadata(options.name, 'name', 1_024)
    const title = optionalMetadata(options.title, 'title', 4_096)

    return this.transaction(() => {
      const current = this.requireCurrentPresence(claim, now)
      const heartbeatAt = Math.max(current.heartbeatAt, now)
      const expiresAt = Math.max(current.expiresAt, safeAdd(now, leaseMs, 'presence expiry'))
      const updatedAt = Math.max(current.updatedAt, now)
      const result = this.database.prepare(`
        UPDATE presence
        SET agent_status = ?, cwd = ?, display_name = ?, title = ?,
            heartbeat_at = ?, expires_at = ?, updated_at = ?
        WHERE session_id = ? AND instance_id = ? AND fence_token = ?
          AND active = 1 AND expires_at > ?
      `).run(
        agentStatus ?? current.agentStatus,
        cwd === undefined ? current.cwd ?? null : cwd,
        name === undefined ? current.name ?? null : name,
        title === undefined ? current.title ?? null : title,
        heartbeatAt,
        expiresAt,
        updatedAt,
        claim.sessionId,
        claim.instanceId,
        claim.fenceToken,
        now,
      )
      if (Number(result.changes) !== 1) throw fenceLost(claim.sessionId)
      return this.requirePresence(claim.sessionId)
    })
  }

  /** Release an exact owner and advance the fence so late callbacks fail closed. */
  releasePresence(options: PresenceMutationOptions): PresenceSnapshot {
    this.assertOpen()
    const claim = validatePresenceClaim(options)
    const now = this.resolveNow(options.now)

    return this.transaction(() => {
      const current = this.requireCurrentPresence(claim, now)
      const nextFence = safeAdd(current.fenceToken, 1, 'presence fence')
      const updatedAt = Math.max(current.updatedAt, now)
      const result = this.database.prepare(`
        UPDATE presence
        SET fence_token = ?, socket_path = NULL, active = 0,
            expires_at = ?, updated_at = ?
        WHERE session_id = ? AND instance_id = ? AND fence_token = ?
          AND active = 1 AND expires_at > ?
      `).run(
        nextFence,
        now,
        updatedAt,
        claim.sessionId,
        claim.instanceId,
        claim.fenceToken,
        now,
      )
      if (Number(result.changes) !== 1) throw fenceLost(claim.sessionId)
      return this.requirePresence(claim.sessionId)
    })
  }

  /** Read the non-TTL Session persistence writer fence, if one was ever issued. */
  getSessionWriter(sessionIdInput: string): SessionWriterSnapshot | undefined {
    this.assertOpen()
    const sessionId = opaqueId(sessionIdInput, 'sessionId')
    const row = this.selectSessionWriter(sessionId)
    return row === undefined ? undefined : sessionWriterFromRow(row)
  }

  /**
   * Acquire a Session persistence writer fence. A live different owner is
   * replaceable only when the caller supplies its exact mechanically-dead
   * identity; elapsed mailbox presence is deliberately irrelevant.
   */
  acquireSessionWriter(options: AcquireSessionWriterOptions): SessionWriterSnapshot {
    this.assertOpen()
    const owner = validateSessionWriterOwner(options)
    const takeover = options.takeover === undefined
      ? undefined
      : validateSessionWriterTakeover(options.takeover)
    const now = this.resolveNow(options.now)

    return this.transaction(() => {
      const currentRow = this.selectSessionWriter(owner.sessionId)
      if (currentRow === undefined) {
        this.database.prepare(`
          INSERT INTO session_writers (
            session_id, instance_id, owner_token, fence_token, active,
            pid, process_start_id, hostname, boot_id,
            acquired_at, released_at, updated_at
          ) VALUES (?, ?, ?, 1, 1, ?, ?, ?, ?, ?, NULL, ?)
        `).run(
          owner.sessionId,
          owner.instanceId,
          owner.ownerToken,
          owner.pid,
          owner.processStartId,
          owner.hostname,
          owner.bootId,
          now,
          now,
        )
        return this.requireSessionWriter(owner.sessionId)
      }

      const current = sessionWriterFromRow(currentRow)
      if (current.active
        && current.instanceId === owner.instanceId
        && current.ownerToken === owner.ownerToken) {
        if (!sameSessionWriterOwner(current, owner)) {
          throw new MessagingError(
            'SESSION_CONFLICT',
            `session ${JSON.stringify(owner.sessionId)} persistence writer identity changed`,
          )
        }
        return current
      }
      if (current.active && !sameSessionWriterTakeover(current, takeover)) {
        throw new MessagingError(
          'SESSION_CONFLICT',
          `session ${JSON.stringify(owner.sessionId)} has another active persistence writer`,
        )
      }

      const nextFence = safeAdd(current.fenceToken, 1, 'session writer fence')
      const result = this.database.prepare(`
        UPDATE session_writers
        SET instance_id = ?, owner_token = ?, fence_token = ?, active = 1,
            pid = ?, process_start_id = ?, hostname = ?, boot_id = ?,
            acquired_at = ?, released_at = NULL, updated_at = MAX(updated_at, ?)
        WHERE session_id = ? AND fence_token = ?
          AND instance_id = ? AND owner_token = ? AND active = ?
      `).run(
        owner.instanceId,
        owner.ownerToken,
        nextFence,
        owner.pid,
        owner.processStartId,
        owner.hostname,
        owner.bootId,
        now,
        now,
        owner.sessionId,
        current.fenceToken,
        current.instanceId,
        current.ownerToken,
        current.active ? 1 : 0,
      )
      if (Number(result.changes) !== 1) {
        throw new MessagingError(
          'SESSION_CONFLICT',
          `session ${JSON.stringify(owner.sessionId)} persistence writer changed during acquisition`,
        )
      }
      return this.requireSessionWriter(owner.sessionId)
    })
  }

  /** Release only the exact active writer; late owners cannot clear a newer fence. */
  releaseSessionWriter(options: ReleaseSessionWriterOptions): SessionWriterSnapshot {
    this.assertOpen()
    const sessionId = opaqueId(options.sessionId, 'sessionId')
    const instanceId = opaqueId(options.instanceId, 'instanceId')
    const ownerToken = uuid(options.ownerToken, 'ownerToken')
    const fenceToken = positiveSafeInteger(options.fenceToken, 'fenceToken')
    const now = this.resolveNow(options.now)
    return this.transaction(() => {
      const result = this.database.prepare(`
        UPDATE session_writers
        SET active = 0, released_at = ?, updated_at = MAX(updated_at, ?)
        WHERE session_id = ? AND instance_id = ? AND owner_token = ?
          AND fence_token = ? AND active = 1
      `).run(now, now, sessionId, instanceId, ownerToken, fenceToken)
      if (Number(result.changes) !== 1) throw sessionWriterFenceLost(sessionId)
      return this.requireSessionWriter(sessionId)
    })
  }

  /** Fence every elapsed presence row once. */
  expirePresence(nowInput?: number): number {
    this.assertOpen()
    const now = this.resolveNow(nowInput)
    const due = this.database.prepare(`
      SELECT 1 FROM presence
      WHERE active = 1 AND expires_at <= ?
      LIMIT 1
    `).get(now)
    if (due === undefined) return 0
    return this.transaction(() => {
      const result = this.database.prepare(`
        UPDATE presence
        SET active = 0, socket_path = NULL, fence_token = fence_token + 1,
            updated_at = MAX(updated_at, ?)
        WHERE active = 1 AND expires_at <= ?
      `).run(now, now)
      return Number(result.changes)
    })
  }

  getPresence(sessionIdInput: SessionIdentity): PresenceSnapshot | undefined {
    this.assertOpen()
    const sessionId = opaqueId(sessionIdInput, 'sessionId')
    const row = this.selectPresence(sessionId)
    return row === undefined ? undefined : presenceFromRow(row)
  }

  listPresence(options: ListPresenceOptions = {}): PresenceSnapshot[] {
    this.assertOpen()
    const activeOnly = options.activeOnly ?? true
    const now = this.resolveNow(options.now)
    const rows = activeOnly
      ? this.database.prepare(`
          SELECT * FROM presence
          WHERE active = 1 AND expires_at > ?
          ORDER BY session_id ASC
        `).all(now)
      : this.database.prepare('SELECT * FROM presence ORDER BY session_id ASC').all()
    return rows.map(row => presenceFromRow(asRow(row)))
  }

  /** Read the stored policy or project the implicit all-allowed default. */
  getSessionPolicy(principalSessionIdInput: SessionIdentity): SessionPolicySnapshot {
    this.assertOpen()
    const principalSessionId = opaqueId(principalSessionIdInput, 'principalSessionId')
    const row = this.selectSessionPolicy(principalSessionId)
    return row === undefined
      ? defaultSessionPolicy(principalSessionId)
      : sessionPolicyFromRow(row)
  }

  /** Read the sparse set of non-default policy rows in one snapshot query. */
  listSessionPolicies(): SessionPolicySnapshot[] {
    this.assertOpen()
    return this.database.prepare(`
      SELECT * FROM session_policies
      ORDER BY principal_session_id ASC
    `).all().map(row => sessionPolicyFromRow(asRow(row)))
  }

  /**
   * Atomically change a principal policy and fail affected unleased text
   * envelopes. Controls stay queued so the fenced receiver can persist a
   * typed rejected outcome before any handler invocation.
   */
  setSessionPolicy(input: SetSessionPolicy): SessionPolicySnapshot {
    this.assertOpen()
    const principalSessionId = opaqueId(input.principalSessionId, 'principalSessionId')
    if (input.sendAllowed === undefined && input.receiveAllowed === undefined) {
      throw new MessagingError('INVALID_ARGUMENT', 'setSessionPolicy requires a policy field')
    }
    const sendPatch = optionalBoolean(input.sendAllowed, 'sendAllowed')
    const receivePatch = optionalBoolean(input.receiveAllowed, 'receiveAllowed')
    const now = this.resolveNow(input.now)

    return this.transaction(() => {
      const currentRow = this.selectSessionPolicy(principalSessionId)
      const current = currentRow === undefined
        ? defaultSessionPolicy(principalSessionId)
        : sessionPolicyFromRow(currentRow)
      const sendAllowed = sendPatch ?? current.sendAllowed
      const receiveAllowed = receivePatch ?? current.receiveAllowed
      const updatedAt = Math.max(current.updatedAt, now)
      this.database.prepare(`
        INSERT INTO session_policies (
          principal_session_id, send_allowed, receive_allowed, updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(principal_session_id) DO UPDATE SET
          send_allowed = excluded.send_allowed,
          receive_allowed = excluded.receive_allowed,
          updated_at = MAX(session_policies.updated_at, excluded.updated_at)
      `).run(
        principalSessionId,
        sendAllowed ? 1 : 0,
        receiveAllowed ? 1 : 0,
        updatedAt,
      )

      if (!sendAllowed || !receiveAllowed) {
        this.database.prepare(`
          UPDATE messages
          SET status = 'failed', failed_at = ?,
              last_error = 'permission denied: session policy revoked',
              lease_token = NULL, lease_owner_instance_id = NULL,
              lease_owner_fence_token = NULL, lease_until = NULL,
              updated_at = MAX(updated_at, ?)
          WHERE status = 'queued' AND channel = 'text' AND lease_token IS NULL AND (
            (? = 0 AND sender_principal_session_id = ?)
            OR (? = 0 AND recipient_principal_session_id = ?)
          )
        `).run(
          updatedAt,
          updatedAt,
          sendAllowed ? 1 : 0,
          principalSessionId,
          receiveAllowed ? 1 : 0,
          principalSessionId,
        )
      }
      return sessionPolicyFromRow(this.requireSessionPolicy(principalSessionId))
    })
  }

  /**
   * Add/remove one symmetric text-only block and cut off both unleased queued
   * text directions. Typed controls deliberately ignore pair blocks.
   */
  setPairBlocked(input: SetPairBlock): PairBlockSnapshot | undefined {
    this.assertOpen()
    if (typeof input.blocked !== 'boolean') {
      throw new MessagingError('INVALID_ARGUMENT', 'blocked must be boolean')
    }
    const [first, second] = canonicalPrincipalPair(
      input.firstPrincipalSessionId,
      input.secondPrincipalSessionId,
    )
    const now = this.resolveNow(input.now)

    return this.transaction(() => {
      if (!input.blocked) {
        this.database.prepare(`
          DELETE FROM pair_blocks
          WHERE first_principal_session_id = ? AND second_principal_session_id = ?
        `).run(first, second)
        return undefined
      }

      this.database.prepare(`
        INSERT INTO pair_blocks (
          first_principal_session_id, second_principal_session_id, blocked_at
        ) VALUES (?, ?, ?)
        ON CONFLICT(first_principal_session_id, second_principal_session_id)
        DO UPDATE SET blocked_at = MAX(pair_blocks.blocked_at, excluded.blocked_at)
      `).run(first, second, now)
      this.database.prepare(`
        UPDATE messages
        SET status = 'failed', failed_at = ?,
            last_error = 'permission denied: principal pair blocked',
            lease_token = NULL, lease_owner_instance_id = NULL,
            lease_owner_fence_token = NULL, lease_until = NULL,
            updated_at = MAX(updated_at, ?)
        WHERE status = 'queued' AND channel = 'text' AND lease_token IS NULL AND (
          (sender_principal_session_id = ? AND recipient_principal_session_id = ?)
          OR
          (sender_principal_session_id = ? AND recipient_principal_session_id = ?)
        )
      `).run(now, now, first, second, second, first)
      return this.requirePairBlock(first, second)
    })
  }

  isPairBlocked(
    firstPrincipalSessionId: SessionIdentity,
    secondPrincipalSessionId: SessionIdentity,
  ): boolean {
    this.assertOpen()
    const validatedFirst = opaqueId(firstPrincipalSessionId, 'firstPrincipalSessionId')
    const validatedSecond = opaqueId(secondPrincipalSessionId, 'secondPrincipalSessionId')
    if (validatedFirst === validatedSecond) return false
    const [first, second] = canonicalPrincipalPair(validatedFirst, validatedSecond)
    return this.selectPairBlock(first, second) !== undefined
  }

  listPairBlocks(principalSessionIdInput?: SessionIdentity): PairBlockSnapshot[] {
    this.assertOpen()
    if (principalSessionIdInput === undefined) {
      return this.database.prepare(`
        SELECT * FROM pair_blocks
        ORDER BY first_principal_session_id ASC, second_principal_session_id ASC
      `).all().map(row => pairBlockFromRow(asRow(row)))
    }
    const principalSessionId = opaqueId(principalSessionIdInput, 'principalSessionId')
    return this.database.prepare(`
      SELECT * FROM pair_blocks
      WHERE first_principal_session_id = ? OR second_principal_session_id = ?
      ORDER BY first_principal_session_id ASC, second_principal_session_id ASC
    `).all(principalSessionId, principalSessionId).map(row => pairBlockFromRow(asRow(row)))
  }

  /** Insert once by caller-supplied UUID; an identical repeat is idempotent. */
  enqueue(input: EnqueueMessage): EnqueueResult {
    this.assertOpen()
    const messageId = uuid(input.messageId, 'messageId')
    const senderSessionId = opaqueId(input.senderSessionId, 'senderSessionId')
    const recipientSessionId = opaqueId(input.recipientSessionId, 'recipientSessionId')
    const senderPrincipalSessionId = opaqueId(
      input.senderPrincipalSessionId,
      'senderPrincipalSessionId',
    )
    const recipientPrincipalSessionId = opaqueId(
      input.recipientPrincipalSessionId,
      'recipientPrincipalSessionId',
    )
    const channel = validateMessageChannel(input.channel ?? 'text')
    const deliveryMode = validateDeliveryMode(input.deliveryMode)
    const ttlMs = positiveSafeInteger(input.ttlMs, 'ttlMs')
    const maxAttempts = positiveSafeInteger(input.maxAttempts, 'maxAttempts')
    const now = this.resolveNow(input.now)
    const expiresAt = safeAdd(now, ttlMs, 'message expiry')
    const payloadJson = canonicalJson(input.payload)
    if (Buffer.byteLength(payloadJson, 'utf8') > this.maxPayloadBytes) {
      throw new MessagingError('INVALID_ARGUMENT', 'payload exceeds maxPayloadBytes')
    }
    return this.transaction(() => {
      if (channel === 'text') {
        this.assertEnvelopeAllowedInTransaction(
          senderPrincipalSessionId,
          recipientPrincipalSessionId,
        )
      } else {
        this.assertDirectionalPolicyAllowedInTransaction(
          senderPrincipalSessionId,
          recipientPrincipalSessionId,
        )
      }
      const existing = this.selectMessage(messageId)
      if (existing !== undefined) {
        const sameEnvelope = text(existing, 'sender_session_id') === senderSessionId
          && text(existing, 'recipient_session_id') === recipientSessionId
          && text(existing, 'sender_principal_session_id') === senderPrincipalSessionId
          && text(existing, 'recipient_principal_session_id') === recipientPrincipalSessionId
          && text(existing, 'channel') === channel
          && text(existing, 'delivery_mode') === deliveryMode
          && text(existing, 'payload_json') === payloadJson
          && integer(existing, 'ttl_ms') === ttlMs
          && integer(existing, 'max_attempts') === maxAttempts
        if (!sameEnvelope) {
          throw new MessagingError(
            'MESSAGE_ID_COLLISION',
            `message id ${JSON.stringify(messageId)} was reused for another envelope`,
          )
        }
        return { message: messageFromRow(existing), deduplicated: true }
      }

      this.database.prepare(`
        INSERT INTO messages (
          message_id, sender_session_id, recipient_session_id,
          sender_principal_session_id, recipient_principal_session_id,
          channel, delivery_mode,
          payload_json, status,
          created_at, updated_at, available_at, ttl_ms, expires_at,
          attempt_count, max_attempts
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, 0, ?)
      `).run(
        messageId,
        senderSessionId,
        recipientSessionId,
        senderPrincipalSessionId,
        recipientPrincipalSessionId,
        channel,
        deliveryMode,
        payloadJson,
        now,
        now,
        now,
        ttlMs,
        expiresAt,
        maxAttempts,
      )
      return { message: this.requireMessage(messageId), deduplicated: false }
    })
  }

  getMessage(messageIdInput: MessageId): MessageSnapshot | undefined {
    this.assertOpen()
    const messageId = uuid(messageIdInput, 'messageId')
    const row = this.selectMessage(messageId)
    return row === undefined ? undefined : messageFromRow(row)
  }

  getControlOutcome(controlIdInput: MessageId): ControlOutcomeSnapshot | undefined {
    this.assertOpen()
    const controlId = uuid(controlIdInput, 'controlId')
    const row = this.selectControlOutcome(controlId)
    return row === undefined ? undefined : controlOutcomeFromRow(row)
  }

  listMessages(filter: MessageListFilter = {}): MessageSnapshot[] {
    this.assertOpen()
    const where: string[] = []
    const values: Array<string | number> = []

    if (filter.senderSessionId !== undefined) {
      where.push('sender_session_id = ?')
      values.push(opaqueId(filter.senderSessionId, 'senderSessionId'))
    }
    if (filter.recipientSessionId !== undefined) {
      where.push('recipient_session_id = ?')
      values.push(opaqueId(filter.recipientSessionId, 'recipientSessionId'))
    }
    if (filter.statuses !== undefined) {
      if (filter.statuses.length === 0) return []
      for (const status of filter.statuses) {
        if (!isMessageStatus(status)) {
          throw new MessagingError('INVALID_ARGUMENT', `invalid message status: ${String(status)}`)
        }
      }
      where.push(`status IN (${filter.statuses.map(() => '?').join(', ')})`)
      values.push(...filter.statuses)
    }

    const limit = filter.limit === undefined
      ? undefined
      : positiveSafeInteger(filter.limit, 'limit')
    const sql = [
      'SELECT * FROM messages',
      where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`,
      'ORDER BY enqueue_seq ASC',
      limit === undefined ? '' : 'LIMIT ?',
    ].filter(Boolean).join(' ')
    if (limit !== undefined) values.push(limit)
    return this.database.prepare(sql).all(...values).map(row => messageFromRow(asRow(row)))
  }

  /**
   * Return only rows whose DSH Inbox lifecycle may need crash reconciliation.
   *
   * A fresh unleased queued row has not crossed delivery admission. Accepted
   * rows and queued rows that still carry a delivery lease may have a durable
   * Inbox fact that won the race with the SQLite acknowledgement.
   */
  listReconciliationCandidates(
    recipientSessionIdInput: SessionIdentity,
  ): MessageSnapshot[] {
    this.assertOpen()
    const recipientSessionId = opaqueId(recipientSessionIdInput, 'recipientSessionId')
    return this.database.prepare(`
      SELECT * FROM messages
      WHERE recipient_session_id = ?
        AND channel = 'text'
        AND (
          status = 'accepted'
          OR (status = 'queued' AND lease_token IS NOT NULL)
        )
      ORDER BY enqueue_seq ASC
    `).all(recipientSessionId).map(row => messageFromRow(asRow(row)))
  }

  /** Lease the strict FIFO head for one currently fenced recipient owner. */
  claimNextDelivery(options: ClaimDeliveryOptions): DeliveryLease | undefined {
    this.assertOpen()
    const claim = validatePresenceClaim(options)
    const recipientSessionId = opaqueId(options.recipientSessionId, 'recipientSessionId')
    if (recipientSessionId !== claim.sessionId) {
      throw new MessagingError('INVALID_ARGUMENT', 'presence claim must belong to recipientSessionId')
    }
    const leaseMs = positiveSafeInteger(options.leaseMs, 'leaseMs')
    const now = this.resolveNow(options.now)

    const hasQueued = this.database.prepare(`
      SELECT 1 FROM messages
      WHERE recipient_session_id = ? AND status = 'queued'
      LIMIT 1
    `).get(recipientSessionId)
    if (hasQueued === undefined) return undefined

    return this.transaction(() => {
      this.requireCurrentPresence(claim, now)
      this.terminalizeDueForRecipientInTransaction(recipientSessionId, now)
      this.terminalizeUnauthorizedForRecipientInTransaction(recipientSessionId, now)

      const candidateValue = this.database.prepare(`
        SELECT * FROM messages
        WHERE recipient_session_id = ? AND status = 'queued'
        ORDER BY enqueue_seq ASC
        LIMIT 1
      `).get(recipientSessionId)
      if (candidateValue === undefined) return undefined
      const candidate = asRow(candidateValue)
      if (integer(candidate, 'available_at') > now) return undefined
      const priorLease = nullableText(candidate, 'lease_token')
      const priorOwnerInstance = nullableText(candidate, 'lease_owner_instance_id')
      const priorOwnerFence = nullableInteger(candidate, 'lease_owner_fence_token')
      if (priorLease !== undefined
        && nullableInteger(candidate, 'lease_until')! > now
        && priorOwnerInstance === claim.instanceId
        && priorOwnerFence === claim.fenceToken) {
        return undefined
      }

      const leaseToken = randomUUID()
      const leaseUntil = safeAdd(now, leaseMs, 'delivery lease expiry')
      const messageId = text(candidate, 'message_id')
      const result = this.database.prepare(`
        UPDATE messages
        SET attempt_count = attempt_count + 1,
            lease_token = ?, lease_owner_instance_id = ?,
            lease_owner_fence_token = ?, lease_until = ?,
            updated_at = MAX(updated_at, ?)
        WHERE message_id = ? AND status = 'queued'
          AND available_at <= ? AND expires_at > ?
          AND attempt_count < max_attempts
          AND (
            lease_token IS NULL OR lease_until <= ?
            OR lease_owner_instance_id <> ? OR lease_owner_fence_token <> ?
          )
      `).run(
        leaseToken,
        claim.instanceId,
        claim.fenceToken,
        leaseUntil,
        now,
        messageId,
        now,
        now,
        now,
        claim.instanceId,
        claim.fenceToken,
      )
      if (Number(result.changes) !== 1) return undefined
      const message = this.requireMessage(messageId)
      if (message.lease === undefined) {
        throw new MessagingError('DATABASE_INIT_FAILED', 'claimed message has no lease')
      }
      return { message, lease: message.lease }
    })
  }

  /**
   * Record durable DSH inbox admission.  The caller, not this store, establishes
   * that `ctx.sessions.flush(agent.session)` completed before invoking it.
   */
  acceptDelivery(options: DeliveryMutationOptions): MessageSnapshot {
    this.assertOpen()
    const claim = validatePresenceClaim(options)
    const messageId = uuid(options.messageId, 'messageId')
    const leaseToken = uuid(options.leaseToken, 'leaseToken')
    const now = this.resolveNow(options.now)

    return this.transaction(() => {
      this.requireCurrentPresence(claim, now)
      const current = this.requireMessage(messageId)
      this.assertRecipient(current, claim.sessionId)
      if (current.status === 'accepted' || current.status === 'claimed') return current
      if (current.status !== 'queued') invalidTransition(messageId, current.status, 'accepted')
      assertLease(current, claim, leaseToken)

      const result = this.database.prepare(`
        UPDATE messages
        SET status = 'accepted', accepted_at = ?,
            accepted_by_instance_id = ?, accepted_by_fence_token = ?,
            lease_token = NULL, lease_owner_instance_id = NULL,
            lease_owner_fence_token = NULL, lease_until = NULL,
            updated_at = MAX(updated_at, ?)
        WHERE message_id = ? AND status = 'queued'
          AND lease_token = ? AND lease_owner_instance_id = ?
          AND lease_owner_fence_token = ?
      `).run(
        now,
        claim.instanceId,
        claim.fenceToken,
        now,
        messageId,
        leaseToken,
        claim.instanceId,
        claim.fenceToken,
      )
      if (Number(result.changes) !== 1) throw leaseLost(messageId)
      return this.requireMessage(messageId)
    })
  }

  /** Atomically checkpoint a receiver-side control result and consume its lease. */
  completeControlDelivery(options: CompleteControlDeliveryOptions): {
    readonly message: MessageSnapshot
    readonly outcome: ControlOutcomeSnapshot
  } {
    this.assertOpen()
    const claim = validatePresenceClaim(options)
    const controlId = uuid(options.messageId, 'controlId')
    const leaseToken = uuid(options.leaseToken, 'leaseToken')
    const kind = boundedControlKind(options.kind)
    const payloadHash = sha256Hash(options.payloadHash)
    const outcomeStatus = validateControlOutcomeStatus(options.outcomeStatus, false)
    const resultJson = options.result === undefined ? undefined : canonicalJson(options.result)
    if (resultJson !== undefined && Buffer.byteLength(resultJson, 'utf8') > this.maxPayloadBytes) {
      throw new MessagingError('INVALID_ARGUMENT', 'control result exceeds maxPayloadBytes')
    }
    const detail = optionalBoundedError(options.detail)
    const now = this.resolveNow(options.now)

    return this.transaction(() => {
      this.requireCurrentPresence(claim, now)
      const current = this.requireMessage(controlId)
      this.assertRecipient(current, claim.sessionId)
      this.assertControlChannel(current)
      const existing = this.selectControlOutcome(controlId)
      if (existing !== undefined) {
        const outcome = controlOutcomeFromRow(existing)
        assertSameControlOutcomeIdentity(outcome, kind, payloadHash)
        if (current.status !== 'claimed') invalidTransition(controlId, current.status, 'claimed')
        return { message: current, outcome }
      }
      if (current.status !== 'queued') invalidTransition(controlId, current.status, 'claimed')
      assertLease(current, claim, leaseToken)

      this.insertControlOutcome({
        controlId,
        kind,
        payloadHash,
        status: outcomeStatus,
        ...(resultJson === undefined ? {} : { resultJson }),
        ...(detail === undefined ? {} : { detail }),
        completedAt: now,
      })
      const result = this.database.prepare(`
        UPDATE messages
        SET status = 'claimed',
            accepted_at = ?, accepted_by_instance_id = ?, accepted_by_fence_token = ?,
            claimed_at = ?, claimed_by_instance_id = ?, claimed_by_fence_token = ?,
            lease_token = NULL, lease_owner_instance_id = NULL,
            lease_owner_fence_token = NULL, lease_until = NULL,
            updated_at = MAX(updated_at, ?)
        WHERE message_id = ? AND status = 'queued'
          AND lease_token = ? AND lease_owner_instance_id = ?
          AND lease_owner_fence_token = ?
      `).run(
        now,
        claim.instanceId,
        claim.fenceToken,
        now,
        claim.instanceId,
        claim.fenceToken,
        now,
        controlId,
        leaseToken,
        claim.instanceId,
        claim.fenceToken,
      )
      if (Number(result.changes) !== 1) throw leaseLost(controlId)
      return {
        message: this.requireMessage(controlId),
        outcome: this.requireControlOutcome(controlId),
      }
    })
  }

  /**
   * Recover a durable DSH Inbox admission that won the race with the SQLite
   * accept transaction.  The current fenced recipient may establish the
   * accepted fact without inheriting an old process lease.  Callers must run
   * durable Inbox reconciliation before any due-message sweep for this owner.
   */
  recoverAccepted(options: RecoverAcceptedOptions): MessageSnapshot {
    this.assertOpen()
    const claim = validatePresenceClaim(options)
    const messageId = uuid(options.messageId, 'messageId')
    const now = this.resolveNow(options.now)

    return this.transaction(() => {
      this.requireCurrentPresence(claim, now)
      const current = this.requireMessage(messageId)
      this.assertRecipient(current, claim.sessionId)
      if (current.status === 'accepted' || current.status === 'claimed') return current
      if (current.status !== 'queued') invalidTransition(messageId, current.status, 'accepted')

      const result = this.database.prepare(`
        UPDATE messages
        SET status = 'accepted', accepted_at = ?,
            accepted_by_instance_id = ?, accepted_by_fence_token = ?,
            lease_token = NULL, lease_owner_instance_id = NULL,
            lease_owner_fence_token = NULL, lease_until = NULL,
            updated_at = MAX(updated_at, ?)
        WHERE message_id = ? AND status = 'queued'
      `).run(
        now,
        claim.instanceId,
        claim.fenceToken,
        now,
        messageId,
      )
      if (Number(result.changes) !== 1) invalidTransition(messageId, current.status, 'accepted')
      return this.requireMessage(messageId)
    })
  }

  /**
   * Record the DSH inbox-claimed edge.  queued -> claimed is the crash
   * reconciliation path when the Session log won the race with SQLite accept.
   */
  markClaimed(options: MarkClaimedOptions): MessageSnapshot {
    this.assertOpen()
    const claim = validatePresenceClaim(options)
    const messageId = uuid(options.messageId, 'messageId')
    const now = this.resolveNow(options.now)

    return this.transaction(() => {
      this.requireCurrentPresence(claim, now)
      const current = this.requireMessage(messageId)
      this.assertRecipient(current, claim.sessionId)
      if (current.status === 'claimed') return current
      if (current.status !== 'queued' && current.status !== 'accepted') {
        invalidTransition(messageId, current.status, 'claimed')
      }
      const result = this.database.prepare(`
        UPDATE messages
        SET status = 'claimed',
            accepted_at = COALESCE(accepted_at, ?),
            accepted_by_instance_id = COALESCE(accepted_by_instance_id, ?),
            accepted_by_fence_token = COALESCE(accepted_by_fence_token, ?),
            claimed_at = ?,
            claimed_by_instance_id = ?, claimed_by_fence_token = ?,
            lease_token = NULL, lease_owner_instance_id = NULL,
            lease_owner_fence_token = NULL, lease_until = NULL,
            updated_at = MAX(updated_at, ?)
        WHERE message_id = ? AND status IN ('queued', 'accepted')
      `).run(
        now,
        claim.instanceId,
        claim.fenceToken,
        now,
        claim.instanceId,
        claim.fenceToken,
        now,
        messageId,
      )
      if (Number(result.changes) !== 1) invalidTransition(messageId, current.status, 'claimed')
      return this.requireMessage(messageId)
    })
  }

  /** Record a DSH inbox discard even when it raced ahead of SQLite accept. */
  markDiscarded(options: MarkDiscardedOptions): MessageSnapshot {
    this.assertOpen()
    const claim = validatePresenceClaim(options)
    const messageId = uuid(options.messageId, 'messageId')
    const error = boundedError(options.error)
    const now = this.resolveNow(options.now)

    return this.transaction(() => {
      this.requireCurrentPresence(claim, now)
      const current = this.requireMessage(messageId)
      this.assertRecipient(current, claim.sessionId)
      if (current.status === 'failed') return current
      if (current.status !== 'queued' && current.status !== 'accepted') {
        invalidTransition(messageId, current.status, 'failed')
      }
      const result = this.database.prepare(`
        UPDATE messages
        SET status = 'failed', failed_at = ?, last_error = ?,
            lease_token = NULL, lease_owner_instance_id = NULL,
            lease_owner_fence_token = NULL, lease_until = NULL,
            updated_at = MAX(updated_at, ?)
        WHERE message_id = ? AND status IN ('queued', 'accepted')
      `).run(now, error, now, messageId)
      if (Number(result.changes) !== 1) invalidTransition(messageId, current.status, 'failed')
      return this.requireMessage(messageId)
    })
  }

  /** Clear a lease with bounded backoff, or terminally fail the exhausted head. */
  retryDelivery(options: RetryDeliveryOptions): RetryDecision {
    this.assertOpen()
    const claim = validatePresenceClaim(options)
    const messageId = uuid(options.messageId, 'messageId')
    const leaseToken = uuid(options.leaseToken, 'leaseToken')
    const retryDelayMs = nonNegativeSafeInteger(options.retryDelayMs, 'retryDelayMs')
    const error = boundedError(options.error)
    const now = this.resolveNow(options.now)

    return this.transaction(() => {
      this.requireCurrentPresence(claim, now)
      const current = this.requireMessage(messageId)
      this.assertRecipient(current, claim.sessionId)
      if (current.status !== 'queued') invalidTransition(messageId, current.status, 'queued')
      assertLease(current, claim, leaseToken)

      if (current.attemptCount >= current.maxAttempts) {
        this.updateTerminalFromLease('failed', current, claim, leaseToken, now, error)
        return { message: this.requireMessage(messageId), terminal: true }
      }

      const retryAt = safeAdd(now, retryDelayMs, 'retry availability')
      const result = this.database.prepare(`
        UPDATE messages
        SET available_at = MAX(available_at, ?), last_error = ?,
            lease_token = NULL, lease_owner_instance_id = NULL,
            lease_owner_fence_token = NULL, lease_until = NULL,
            updated_at = MAX(updated_at, ?)
        WHERE message_id = ? AND status = 'queued'
          AND lease_token = ? AND lease_owner_instance_id = ?
          AND lease_owner_fence_token = ?
      `).run(
        retryAt,
        error,
        now,
        messageId,
        leaseToken,
        claim.instanceId,
        claim.fenceToken,
      )
      if (Number(result.changes) !== 1) throw leaseLost(messageId)
      return { message: this.requireMessage(messageId), terminal: false }
    })
  }

  /** Retry a control handler, atomically persisting failure on final exhaustion. */
  retryControlDelivery(options: RetryControlDeliveryOptions): RetryDecision & {
    readonly outcome?: ControlOutcomeSnapshot
  } {
    this.assertOpen()
    const claim = validatePresenceClaim(options)
    const controlId = uuid(options.messageId, 'controlId')
    const leaseToken = uuid(options.leaseToken, 'leaseToken')
    const retryDelayMs = nonNegativeSafeInteger(options.retryDelayMs, 'retryDelayMs')
    const error = boundedError(options.error)
    const kind = boundedControlKind(options.kind)
    const payloadHash = sha256Hash(options.payloadHash)
    const now = this.resolveNow(options.now)

    return this.transaction(() => {
      this.requireCurrentPresence(claim, now)
      const current = this.requireMessage(controlId)
      this.assertRecipient(current, claim.sessionId)
      this.assertControlChannel(current)
      if (current.status !== 'queued') invalidTransition(controlId, current.status, 'queued')
      assertLease(current, claim, leaseToken)

      if (current.attemptCount >= current.maxAttempts) {
        this.updateTerminalFromLease('failed', current, claim, leaseToken, now, error)
        this.insertControlOutcome({
          controlId,
          kind,
          payloadHash,
          status: 'failed',
          detail: error,
          completedAt: now,
        })
        return {
          message: this.requireMessage(controlId),
          terminal: true,
          outcome: this.requireControlOutcome(controlId),
        }
      }

      const retryAt = safeAdd(now, retryDelayMs, 'retry availability')
      const result = this.database.prepare(`
        UPDATE messages
        SET available_at = MAX(available_at, ?), last_error = ?,
            lease_token = NULL, lease_owner_instance_id = NULL,
            lease_owner_fence_token = NULL, lease_until = NULL,
            updated_at = MAX(updated_at, ?)
        WHERE message_id = ? AND status = 'queued'
          AND lease_token = ? AND lease_owner_instance_id = ?
          AND lease_owner_fence_token = ?
      `).run(
        retryAt,
        error,
        now,
        controlId,
        leaseToken,
        claim.instanceId,
        claim.fenceToken,
      )
      if (Number(result.changes) !== 1) throw leaseLost(controlId)
      return { message: this.requireMessage(controlId), terminal: false }
    })
  }

  failControlDelivery(options: FailControlDeliveryOptions): {
    readonly message: MessageSnapshot
    readonly outcome: ControlOutcomeSnapshot
  } {
    this.assertOpen()
    const claim = validatePresenceClaim(options)
    const controlId = uuid(options.messageId, 'controlId')
    const leaseToken = uuid(options.leaseToken, 'leaseToken')
    const error = boundedError(options.error)
    const kind = boundedControlKind(options.kind)
    const payloadHash = sha256Hash(options.payloadHash)
    const now = this.resolveNow(options.now)

    return this.transaction(() => {
      this.requireCurrentPresence(claim, now)
      const current = this.requireMessage(controlId)
      this.assertRecipient(current, claim.sessionId)
      this.assertControlChannel(current)
      if (current.status !== 'queued') invalidTransition(controlId, current.status, 'failed')
      assertLease(current, claim, leaseToken)
      this.updateTerminalFromLease('failed', current, claim, leaseToken, now, error)
      this.insertControlOutcome({
        controlId,
        kind,
        payloadHash,
        status: 'failed',
        detail: error,
        completedAt: now,
      })
      return {
        message: this.requireMessage(controlId),
        outcome: this.requireControlOutcome(controlId),
      }
    })
  }

  failDelivery(options: FailDeliveryOptions): MessageSnapshot {
    this.assertOpen()
    const claim = validatePresenceClaim(options)
    const messageId = uuid(options.messageId, 'messageId')
    const leaseToken = uuid(options.leaseToken, 'leaseToken')
    const error = boundedError(options.error)
    const now = this.resolveNow(options.now)

    return this.transaction(() => {
      this.requireCurrentPresence(claim, now)
      const current = this.requireMessage(messageId)
      this.assertRecipient(current, claim.sessionId)
      if (current.status !== 'queued') invalidTransition(messageId, current.status, 'failed')
      assertLease(current, claim, leaseToken)
      this.updateTerminalFromLease('failed', current, claim, leaseToken, now, error)
      return this.requireMessage(messageId)
    })
  }

  /**
   * Conservative core-only sweep.  A leased row may already have won durable
   * DSH Inbox admission, so only an unleased queued fact is safe globally.
   */
  terminalizeDue(nowInput?: number): number {
    this.assertOpen()
    const now = this.resolveNow(nowInput)
    return this.transaction(() => this.terminalizeDueInTransaction(now))
  }

  /**
   * Fence-bound due sweep for one live recipient.  Its integration must first
   * reconcile durable DSH Inbox facts through recoverAccepted/markClaimed.
   */
  terminalizeDueForRecipient(options: PresenceMutationOptions): number {
    this.assertOpen()
    const claim = validatePresenceClaim(options)
    const now = this.resolveNow(options.now)
    return this.transaction(() => {
      this.requireCurrentPresence(claim, now)
      return this.terminalizeDueForRecipientInTransaction(claim.sessionId, now)
    })
  }

  private initialize(): void {
    // DatabaseSync's timeout installs SQLite's busy handler, but SQLite does
    // not invoke it for every journal-mode lock conflict.  Keep the native
    // timeout and add a bounded retry around those lock-acquisition edges.
    this.database.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`)
    this.database.exec('PRAGMA foreign_keys = ON')
    this.database.exec('PRAGMA trusted_schema = OFF')
    this.database.exec('PRAGMA synchronous = FULL')
    const journal = asRow(this.withBusyRetry(
      () => this.database.prepare('PRAGMA journal_mode = WAL').get(),
    ))
    if (text(journal, 'journal_mode').toLowerCase() !== 'wal') {
      throw new MessagingError('DATABASE_INIT_FAILED', 'SQLite refused WAL journal mode')
    }

    const versionRow = asRow(this.database.prepare('PRAGMA user_version').get())
    const version = integer(versionRow, 'user_version')
    if (version !== 0
      && version !== PREVIOUS_SCHEMA_VERSION
      && version !== CONTROL_SCHEMA_VERSION
      && version !== WRITER_SCHEMA_VERSION
      && version !== SCHEMA_VERSION) {
      throw new MessagingError(
        'UNSUPPORTED_SCHEMA',
        `unsupported messaging schema version ${version}`,
      )
    }
    if (version === SCHEMA_VERSION) return

    this.transaction(() => {
      const observed = integer(asRow(this.database.prepare('PRAGMA user_version').get()), 'user_version')
      if (observed !== 0
        && observed !== PREVIOUS_SCHEMA_VERSION
        && observed !== CONTROL_SCHEMA_VERSION
        && observed !== WRITER_SCHEMA_VERSION
        && observed !== SCHEMA_VERSION) {
        throw new MessagingError(
          'UNSUPPORTED_SCHEMA',
          `unsupported messaging schema version ${observed}`,
        )
      }
      if (observed === SCHEMA_VERSION) return

      if (observed === PREVIOUS_SCHEMA_VERSION) {
        this.database.exec(`
          ALTER TABLE messages
            ADD COLUMN channel TEXT NOT NULL DEFAULT 'text'
            CHECK (channel IN ('text', 'control'));

          CREATE TABLE control_outcomes (
            control_id TEXT PRIMARY KEY NOT NULL,
            kind TEXT NOT NULL,
            payload_hash TEXT NOT NULL,
            outcome_status TEXT NOT NULL
              CHECK (outcome_status IN ('completed', 'rejected', 'failed')),
            result_json TEXT,
            detail TEXT,
            completed_at INTEGER NOT NULL,
            FOREIGN KEY (control_id) REFERENCES messages(message_id)
          ) STRICT;

          PRAGMA user_version = ${CONTROL_SCHEMA_VERSION};
        `)
      }

      if (observed === PREVIOUS_SCHEMA_VERSION || observed === CONTROL_SCHEMA_VERSION) {
        this.database.exec(`
          CREATE TABLE session_writers (
            session_id TEXT PRIMARY KEY NOT NULL,
            instance_id TEXT NOT NULL,
            owner_token TEXT NOT NULL,
            fence_token INTEGER NOT NULL CHECK (fence_token > 0),
            active INTEGER NOT NULL CHECK (active IN (0, 1)),
            pid INTEGER NOT NULL CHECK (pid > 0),
            process_start_id TEXT NOT NULL,
            hostname TEXT NOT NULL,
            boot_id TEXT NOT NULL,
            acquired_at INTEGER NOT NULL,
            released_at INTEGER,
            updated_at INTEGER NOT NULL,
            CHECK (
              (active = 1 AND released_at IS NULL)
              OR (active = 0 AND released_at IS NOT NULL)
            )
          ) STRICT;

          PRAGMA user_version = ${WRITER_SCHEMA_VERSION};
        `)
      }

      if (observed === PREVIOUS_SCHEMA_VERSION
        || observed === CONTROL_SCHEMA_VERSION
        || observed === WRITER_SCHEMA_VERSION) {
        // Schema v3 predates principal ACLs. CREATE IF NOT EXISTS also accepts
        // the short-lived development v3 layout that already contained these
        // tables, so every published v1-v3 mailbox follows one safe upgrade.
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS session_policies (
            principal_session_id TEXT PRIMARY KEY NOT NULL,
            send_allowed INTEGER NOT NULL CHECK (send_allowed IN (0, 1)),
            receive_allowed INTEGER NOT NULL CHECK (receive_allowed IN (0, 1)),
            updated_at INTEGER NOT NULL
          ) STRICT;

          CREATE TABLE IF NOT EXISTS pair_blocks (
            first_principal_session_id TEXT NOT NULL,
            second_principal_session_id TEXT NOT NULL,
            blocked_at INTEGER NOT NULL,
            PRIMARY KEY (first_principal_session_id, second_principal_session_id),
            CHECK (first_principal_session_id < second_principal_session_id)
          ) STRICT;

          CREATE INDEX IF NOT EXISTS messages_sender_principal_queued
            ON messages(sender_principal_session_id)
            WHERE status = 'queued';
          CREATE INDEX IF NOT EXISTS messages_recipient_principal_queued
            ON messages(recipient_principal_session_id)
            WHERE status = 'queued';

          PRAGMA user_version = ${SCHEMA_VERSION};
        `)
        return
      }

      this.database.exec(`
        CREATE TABLE session_policies (
          principal_session_id TEXT PRIMARY KEY NOT NULL,
          send_allowed INTEGER NOT NULL CHECK (send_allowed IN (0, 1)),
          receive_allowed INTEGER NOT NULL CHECK (receive_allowed IN (0, 1)),
          updated_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE pair_blocks (
          first_principal_session_id TEXT NOT NULL,
          second_principal_session_id TEXT NOT NULL,
          blocked_at INTEGER NOT NULL,
          PRIMARY KEY (first_principal_session_id, second_principal_session_id),
          CHECK (first_principal_session_id < second_principal_session_id)
        ) STRICT;

        CREATE TABLE presence (
          session_id TEXT PRIMARY KEY NOT NULL,
          instance_id TEXT NOT NULL,
          fence_token INTEGER NOT NULL CHECK (fence_token > 0),
          socket_path TEXT,
          active INTEGER NOT NULL CHECK (active IN (0, 1)),
          agent_status TEXT NOT NULL CHECK (agent_status IN ('idle', 'running')),
          cwd TEXT,
          display_name TEXT,
          title TEXT,
          heartbeat_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          CHECK ((active = 1 AND socket_path IS NOT NULL) OR (active = 0 AND socket_path IS NULL))
        ) STRICT;

        CREATE INDEX presence_expiry
          ON presence(expires_at)
          WHERE active = 1;

        CREATE TABLE session_writers (
          session_id TEXT PRIMARY KEY NOT NULL,
          instance_id TEXT NOT NULL,
          owner_token TEXT NOT NULL,
          fence_token INTEGER NOT NULL CHECK (fence_token > 0),
          active INTEGER NOT NULL CHECK (active IN (0, 1)),
          pid INTEGER NOT NULL CHECK (pid > 0),
          process_start_id TEXT NOT NULL,
          hostname TEXT NOT NULL,
          boot_id TEXT NOT NULL,
          acquired_at INTEGER NOT NULL,
          released_at INTEGER,
          updated_at INTEGER NOT NULL,
          CHECK (
            (active = 1 AND released_at IS NULL)
            OR (active = 0 AND released_at IS NOT NULL)
          )
        ) STRICT;

        CREATE TABLE messages (
          enqueue_seq INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id TEXT NOT NULL UNIQUE,
          sender_session_id TEXT NOT NULL,
          recipient_session_id TEXT NOT NULL,
          sender_principal_session_id TEXT NOT NULL,
          recipient_principal_session_id TEXT NOT NULL,
          channel TEXT NOT NULL DEFAULT 'text' CHECK (channel IN ('text', 'control')),
          delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('followup', 'steer')),
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('queued', 'accepted', 'claimed', 'failed', 'expired')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          available_at INTEGER NOT NULL,
          ttl_ms INTEGER NOT NULL CHECK (ttl_ms > 0),
          expires_at INTEGER NOT NULL,
          attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
          max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
          lease_token TEXT,
          lease_owner_instance_id TEXT,
          lease_owner_fence_token INTEGER,
          lease_until INTEGER,
          accepted_at INTEGER,
          accepted_by_instance_id TEXT,
          accepted_by_fence_token INTEGER,
          claimed_at INTEGER,
          claimed_by_instance_id TEXT,
          claimed_by_fence_token INTEGER,
          failed_at INTEGER,
          expired_at INTEGER,
          last_error TEXT,
          CHECK (expires_at >= created_at),
          CHECK (attempt_count <= max_attempts),
          CHECK (
            (lease_token IS NULL AND lease_owner_instance_id IS NULL
              AND lease_owner_fence_token IS NULL AND lease_until IS NULL)
            OR
            (status = 'queued' AND lease_token IS NOT NULL
              AND lease_owner_instance_id IS NOT NULL
              AND lease_owner_fence_token IS NOT NULL AND lease_until IS NOT NULL)
          ),
          CHECK (
            (accepted_at IS NULL AND accepted_by_instance_id IS NULL AND accepted_by_fence_token IS NULL)
            OR
            (accepted_at IS NOT NULL AND accepted_by_instance_id IS NOT NULL
              AND accepted_by_fence_token IS NOT NULL)
          ),
          CHECK (status NOT IN ('accepted', 'claimed') OR accepted_at IS NOT NULL),
          CHECK (status NOT IN ('queued', 'expired') OR accepted_at IS NULL),
          CHECK (
            (status = 'claimed' AND claimed_at IS NOT NULL
              AND claimed_by_instance_id IS NOT NULL AND claimed_by_fence_token IS NOT NULL)
            OR
            (status <> 'claimed' AND claimed_at IS NULL
              AND claimed_by_instance_id IS NULL AND claimed_by_fence_token IS NULL)
          ),
          CHECK ((status = 'failed' AND failed_at IS NOT NULL) OR (status <> 'failed' AND failed_at IS NULL)),
          CHECK ((status = 'expired' AND expired_at IS NOT NULL) OR (status <> 'expired' AND expired_at IS NULL))
        ) STRICT;

        CREATE INDEX messages_recipient_fifo
          ON messages(recipient_session_id, enqueue_seq)
          WHERE status = 'queued';
        CREATE INDEX messages_due
          ON messages(expires_at, lease_until)
          WHERE status = 'queued';
        CREATE INDEX messages_sender_principal_queued
          ON messages(sender_principal_session_id)
          WHERE status = 'queued';
        CREATE INDEX messages_recipient_principal_queued
          ON messages(recipient_principal_session_id)
          WHERE status = 'queued';
        CREATE UNIQUE INDEX messages_one_recipient_lease
          ON messages(recipient_session_id)
          WHERE status = 'queued' AND lease_token IS NOT NULL;
        CREATE INDEX messages_recipient_reconcile
          ON messages(recipient_session_id, enqueue_seq)
          WHERE status = 'accepted'
            OR (status = 'queued' AND lease_token IS NOT NULL);

        CREATE TABLE control_outcomes (
          control_id TEXT PRIMARY KEY NOT NULL,
          kind TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          outcome_status TEXT NOT NULL
            CHECK (outcome_status IN ('completed', 'rejected', 'failed')),
          result_json TEXT,
          detail TEXT,
          completed_at INTEGER NOT NULL,
          FOREIGN KEY (control_id) REFERENCES messages(message_id)
        ) STRICT;

        PRAGMA user_version = ${SCHEMA_VERSION};
      `)
    })
  }

  private transaction<T>(operation: () => T): T {
    this.withBusyRetry(() => this.database.exec('BEGIN IMMEDIATE'))
    try {
      const result = operation()
      this.withBusyRetry(() => this.database.exec('COMMIT'))
      this.secureSidecars()
      return result
    } catch (error) {
      try {
        this.database.exec('ROLLBACK')
      } catch {
        // Preserve the operation error.
      }
      throw error
    }
  }

  private withBusyRetry<T>(operation: () => T): T {
    const deadline = performance.now() + this.busyTimeoutMs
    let delayMs = 1
    for (;;) {
      try {
        return operation()
      } catch (error) {
        const remainingMs = deadline - performance.now()
        if (!isSqliteLockConflict(error) || remainingMs <= 0) throw error
        Atomics.wait(
          BUSY_RETRY_SIGNAL,
          0,
          0,
          Math.min(delayMs, remainingMs),
        )
        delayMs = Math.min(delayMs * 2, BUSY_RETRY_MAX_DELAY_MS)
      }
    }
  }

  private terminalizeDueInTransaction(now: number): number {
    const expired = this.database.prepare(`
      UPDATE messages
      SET status = 'expired', expired_at = ?,
          lease_token = NULL, lease_owner_instance_id = NULL,
          lease_owner_fence_token = NULL, lease_until = NULL,
          updated_at = MAX(updated_at, ?)
      WHERE status = 'queued' AND lease_token IS NULL AND expires_at <= ?
    `).run(now, now, now)
    const failed = this.database.prepare(`
      UPDATE messages
      SET status = 'failed', failed_at = ?,
          lease_token = NULL, lease_owner_instance_id = NULL,
          lease_owner_fence_token = NULL, lease_until = NULL,
          last_error = COALESCE(last_error, 'delivery attempts exhausted'),
          updated_at = MAX(updated_at, ?)
      WHERE status = 'queued' AND lease_token IS NULL AND expires_at > ?
        AND attempt_count >= max_attempts
    `).run(now, now, now)
    return Number(expired.changes) + Number(failed.changes)
  }

  private terminalizeDueForRecipientInTransaction(
    recipientSessionId: SessionIdentity,
    now: number,
  ): number {
    const expired = this.database.prepare(`
      UPDATE messages
      SET status = 'expired', expired_at = ?,
          lease_token = NULL, lease_owner_instance_id = NULL,
          lease_owner_fence_token = NULL, lease_until = NULL,
          updated_at = MAX(updated_at, ?)
      WHERE status = 'queued' AND recipient_session_id = ? AND expires_at <= ?
    `).run(now, now, recipientSessionId, now)
    const failed = this.database.prepare(`
      UPDATE messages
      SET status = 'failed', failed_at = ?,
          lease_token = NULL, lease_owner_instance_id = NULL,
          lease_owner_fence_token = NULL, lease_until = NULL,
          last_error = COALESCE(last_error, 'delivery attempts exhausted'),
          updated_at = MAX(updated_at, ?)
      WHERE status = 'queued' AND recipient_session_id = ? AND expires_at > ?
        AND attempt_count >= max_attempts
        AND (
          lease_token IS NULL OR lease_until <= ?
          OR NOT EXISTS (
            SELECT 1 FROM presence
            WHERE presence.session_id = messages.recipient_session_id
              AND presence.active = 1 AND presence.expires_at > ?
              AND presence.instance_id = messages.lease_owner_instance_id
              AND presence.fence_token = messages.lease_owner_fence_token
          )
        )
    `).run(now, now, recipientSessionId, now, now, now)
    return Number(expired.changes) + Number(failed.changes)
  }

  private updateTerminalFromLease(
    status: 'failed',
    current: MessageSnapshot,
    claim: PresenceClaim,
    leaseToken: string,
    now: number,
    error: string,
  ): void {
    const result = this.database.prepare(`
      UPDATE messages
      SET status = ?, failed_at = ?, last_error = ?,
          lease_token = NULL, lease_owner_instance_id = NULL,
          lease_owner_fence_token = NULL, lease_until = NULL,
          updated_at = MAX(updated_at, ?)
      WHERE message_id = ? AND status = 'queued'
        AND lease_token = ? AND lease_owner_instance_id = ?
        AND lease_owner_fence_token = ?
    `).run(
      status,
      now,
      error,
      now,
      current.messageId,
      leaseToken,
      claim.instanceId,
      claim.fenceToken,
    )
    if (Number(result.changes) !== 1) throw leaseLost(current.messageId)
  }

  private assertEnvelopeAllowedInTransaction(
    senderPrincipalSessionId: SessionIdentity,
    recipientPrincipalSessionId: SessionIdentity,
  ): void {
    this.assertDirectionalPolicyAllowedInTransaction(
      senderPrincipalSessionId,
      recipientPrincipalSessionId,
    )
    if (senderPrincipalSessionId !== recipientPrincipalSessionId) {
      const [first, second] = canonicalPrincipalPair(
        senderPrincipalSessionId,
        recipientPrincipalSessionId,
      )
      if (this.selectPairBlock(first, second) !== undefined) {
        throw permissionDenied('principal pair is blocked')
      }
    }
  }

  private assertDirectionalPolicyAllowedInTransaction(
    senderPrincipalSessionId: SessionIdentity,
    recipientPrincipalSessionId: SessionIdentity,
  ): void {
    const senderPolicyRow = this.selectSessionPolicy(senderPrincipalSessionId)
    if (senderPolicyRow !== undefined
      && integer(senderPolicyRow, 'send_allowed') !== 1) {
      throw permissionDenied('sender principal has disabled messaging')
    }
    const recipientPolicyRow = this.selectSessionPolicy(recipientPrincipalSessionId)
    if (recipientPolicyRow !== undefined
      && integer(recipientPolicyRow, 'receive_allowed') !== 1) {
      throw permissionDenied('recipient principal has disabled messaging')
    }
  }

  private terminalizeUnauthorizedForRecipientInTransaction(
    recipientSessionId: SessionIdentity,
    now: number,
  ): number {
    const result = this.database.prepare(`
      UPDATE messages
      SET status = 'failed', failed_at = ?,
          last_error = 'permission denied: policy changed before delivery',
          lease_token = NULL, lease_owner_instance_id = NULL,
          lease_owner_fence_token = NULL, lease_until = NULL,
          updated_at = MAX(updated_at, ?)
      WHERE status = 'queued' AND channel = 'text' AND recipient_session_id = ?
        AND (
          lease_token IS NULL OR lease_until <= ?
          OR NOT EXISTS (
            SELECT 1 FROM presence
            WHERE presence.session_id = messages.recipient_session_id
              AND presence.active = 1 AND presence.expires_at > ?
              AND presence.instance_id = messages.lease_owner_instance_id
              AND presence.fence_token = messages.lease_owner_fence_token
          )
        )
        AND (
          EXISTS (
            SELECT 1 FROM session_policies AS sender_policy
            WHERE sender_policy.principal_session_id = messages.sender_principal_session_id
              AND sender_policy.send_allowed = 0
          )
          OR EXISTS (
            SELECT 1 FROM session_policies AS recipient_policy
            WHERE recipient_policy.principal_session_id = messages.recipient_principal_session_id
              AND recipient_policy.receive_allowed = 0
          )
          OR EXISTS (
            SELECT 1 FROM pair_blocks
            WHERE (
              pair_blocks.first_principal_session_id = messages.sender_principal_session_id
              AND pair_blocks.second_principal_session_id = messages.recipient_principal_session_id
            ) OR (
              pair_blocks.first_principal_session_id = messages.recipient_principal_session_id
              AND pair_blocks.second_principal_session_id = messages.sender_principal_session_id
            )
          )
        )
    `).run(now, now, recipientSessionId, now, now)
    return Number(result.changes)
  }

  private selectSessionPolicy(principalSessionId: string): SqliteRow | undefined {
    const value = this.database.prepare(`
      SELECT * FROM session_policies WHERE principal_session_id = ?
    `).get(principalSessionId)
    return value === undefined ? undefined : asRow(value)
  }

  private requireSessionPolicy(principalSessionId: string): SqliteRow {
    const row = this.selectSessionPolicy(principalSessionId)
    if (row === undefined) {
      throw new MessagingError('DATABASE_INIT_FAILED', 'policy mutation committed no row')
    }
    return row
  }

  private selectPairBlock(first: string, second: string): SqliteRow | undefined {
    const value = this.database.prepare(`
      SELECT * FROM pair_blocks
      WHERE first_principal_session_id = ? AND second_principal_session_id = ?
    `).get(first, second)
    return value === undefined ? undefined : asRow(value)
  }

  private requirePairBlock(first: string, second: string): PairBlockSnapshot {
    const row = this.selectPairBlock(first, second)
    if (row === undefined) {
      throw new MessagingError('DATABASE_INIT_FAILED', 'pair block mutation committed no row')
    }
    return pairBlockFromRow(row)
  }

  private selectSessionWriter(sessionId: string): SqliteRow | undefined {
    const value = this.database.prepare(
      'SELECT * FROM session_writers WHERE session_id = ?',
    ).get(sessionId)
    return value === undefined ? undefined : asRow(value)
  }

  private requireSessionWriter(sessionId: string): SessionWriterSnapshot {
    const row = this.selectSessionWriter(sessionId)
    if (row === undefined) {
      throw new MessagingError(
        'DATABASE_INIT_FAILED',
        'session writer mutation committed no row',
      )
    }
    return sessionWriterFromRow(row)
  }

  private requireCurrentPresence(claim: PresenceClaim, now: number): PresenceSnapshot {
    const row = this.selectPresence(claim.sessionId)
    if (row === undefined) throw fenceLost(claim.sessionId)
    const snapshot = presenceFromRow(row)
    if (!snapshot.active
      || snapshot.expiresAt <= now
      || snapshot.instanceId !== claim.instanceId
      || snapshot.fenceToken !== claim.fenceToken) {
      throw fenceLost(claim.sessionId)
    }
    return snapshot
  }

  private assertRecipient(message: MessageSnapshot, sessionId: SessionIdentity): void {
    if (message.recipientSessionId !== sessionId) {
      throw new MessagingError('FENCE_LOST', 'presence owner does not own this recipient')
    }
  }

  private assertControlChannel(message: MessageSnapshot): void {
    if (message.channel !== 'control') {
      throw new MessagingError('INVALID_TRANSITION', 'message is not a typed control envelope')
    }
  }

  private selectPresence(sessionId: string): SqliteRow | undefined {
    const value = this.database.prepare('SELECT * FROM presence WHERE session_id = ?').get(sessionId)
    return value === undefined ? undefined : asRow(value)
  }

  private requirePresence(sessionId: string): PresenceSnapshot {
    const row = this.selectPresence(sessionId)
    if (row === undefined) {
      throw new MessagingError('DATABASE_INIT_FAILED', 'presence mutation committed no row')
    }
    return presenceFromRow(row)
  }

  private selectMessage(messageId: string): SqliteRow | undefined {
    const value = this.database.prepare('SELECT * FROM messages WHERE message_id = ?').get(messageId)
    return value === undefined ? undefined : asRow(value)
  }

  private requireMessage(messageId: string): MessageSnapshot {
    const row = this.selectMessage(messageId)
    if (row === undefined) {
      throw new MessagingError('MESSAGE_NOT_FOUND', `message ${JSON.stringify(messageId)} was not found`)
    }
    return messageFromRow(row)
  }

  private selectControlOutcome(controlId: string): SqliteRow | undefined {
    const value = this.database.prepare(
      'SELECT * FROM control_outcomes WHERE control_id = ?',
    ).get(controlId)
    return value === undefined ? undefined : asRow(value)
  }

  private requireControlOutcome(controlId: string): ControlOutcomeSnapshot {
    const row = this.selectControlOutcome(controlId)
    if (row === undefined) {
      throw new MessagingError('DATABASE_INIT_FAILED', 'control completion committed no outcome')
    }
    return controlOutcomeFromRow(row)
  }

  private insertControlOutcome(input: {
    readonly controlId: string
    readonly kind: string
    readonly payloadHash: string
    readonly status: ControlOutcomeStatus
    readonly resultJson?: string
    readonly detail?: string
    readonly completedAt: number
  }): void {
    const result = this.database.prepare(`
      INSERT INTO control_outcomes (
        control_id, kind, payload_hash, outcome_status,
        result_json, detail, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(control_id) DO NOTHING
    `).run(
      input.controlId,
      input.kind,
      input.payloadHash,
      input.status,
      input.resultJson ?? null,
      input.detail ?? null,
      input.completedAt,
    )
    if (Number(result.changes) === 1) return
    assertSameControlOutcomeIdentity(
      this.requireControlOutcome(input.controlId),
      input.kind,
      input.payloadHash,
    )
  }

  private resolveNow(value: number | undefined): number {
    return nonNegativeSafeInteger(value ?? this.clock(), 'now')
  }

  private secureSidecars(): void {
    for (const suffix of ['', '-wal', '-shm']) {
      const path = `${this.path}${suffix}`
      let stats
      try {
        stats = lstatSync(path)
      } catch (error) {
        if (isErrno(error, 'ENOENT')) continue
        throw error
      }
      if (!stats.isFile() || stats.isSymbolicLink()) insecureRegularFile(path)
      assertOwnedByCurrentUser(stats.uid, path)
      if ((stats.mode & 0o777) === 0o600) continue
      try {
        chmodSync(path, 0o600)
      } catch (error) {
        // WAL/SHM files are ephemeral and another SQLite connection may have
        // checkpointed and removed one after lstat.  Never open an auxiliary
        // file to close this race: closing any fd for the same inode can drop
        // this process's POSIX locks and split the WAL generation.
        if (!isErrno(error, 'ENOENT')) throw error
      }
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new MessagingError('DATABASE_CLOSED', 'messaging database is closed')
  }
}

function validateAndPrepareDatabasePath(path: string): string {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0') || !isAbsolute(path)) {
    throw new MessagingError('INVALID_ARGUMENT', 'database path must be an absolute non-NUL path')
  }
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const directoryStats = lstatSync(directory)
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new MessagingError('INSECURE_PATH', 'database directory must be a real directory')
  }
  assertOwnedByCurrentUser(directoryStats.uid, directory)
  if ((directoryStats.mode & 0o077) !== 0) {
    throw new MessagingError('INSECURE_PATH', 'database directory must not be group/world accessible')
  }

  // SQLite normally creates a missing database according to the process
  // umask.  That exposes a short 0644 window in which a concurrent opener can
  // fail the owner-only check.  O_EXCL gives every cold-starting process one
  // stable 0600 inode before any SQLite connection is allowed to open it.
  try {
    const descriptor = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      fchmodSync(descriptor, 0o600)
    } finally {
      closeSync(descriptor)
    }
  } catch (error) {
    if (!isErrno(error, 'EEXIST')) throw error
  }

  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    assertOwnerOnlyRegularFile(candidate, candidate !== path)
  }
  return path
}

function assertOwnerOnlyRegularFile(path: string, allowMissing: boolean): void {
  let stats
  try {
    stats = lstatSync(path)
  } catch (error) {
    if (allowMissing && isErrno(error, 'ENOENT')) return
    throw error
  }
  if (!stats.isFile() || stats.isSymbolicLink()) insecureRegularFile(path)
  assertOwnedByCurrentUser(stats.uid, path)
  if ((stats.mode & 0o077) !== 0) {
    throw new MessagingError('INSECURE_PATH', `${JSON.stringify(path)} is not owner-only`)
  }
}

function insecureRegularFile(path: string): never {
  throw new MessagingError('INSECURE_PATH', `${JSON.stringify(path)} is not a regular file`)
}

function isErrno(error: unknown, code: string): boolean {
  return error !== null
    && typeof error === 'object'
    && 'code' in error
    && error.code === code
}

function isSqliteLockConflict(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  if ('errcode' in error && (error.errcode === 5 || error.errcode === 6)) return true
  if ('code' in error && (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED')) return true
  return error instanceof Error
    && 'code' in error
    && error.code === 'ERR_SQLITE_ERROR'
    && /(?:database|table).*(?:busy|locked)|(?:busy|locked).*(?:database|table)/iu.test(error.message)
}

function assertOwnedByCurrentUser(uid: number, path: string): void {
  const getuid = process.getuid
  if (getuid !== undefined && uid !== getuid()) {
    throw new MessagingError('INSECURE_PATH', `${JSON.stringify(path)} is owned by another user`)
  }
}

function validatePresenceClaim(claim: PresenceClaim): PresenceClaim {
  return {
    sessionId: opaqueId(claim.sessionId, 'sessionId'),
    instanceId: opaqueId(claim.instanceId, 'instanceId'),
    fenceToken: positiveSafeInteger(claim.fenceToken, 'fenceToken'),
  }
}

type ValidatedSessionWriterOwner = Omit<SessionWriterOwnerInput, 'now'>

function validateSessionWriterOwner(owner: SessionWriterOwnerInput): ValidatedSessionWriterOwner {
  return {
    sessionId: opaqueId(owner.sessionId, 'sessionId'),
    instanceId: opaqueId(owner.instanceId, 'instanceId'),
    ownerToken: uuid(owner.ownerToken, 'ownerToken'),
    pid: positiveSafeInteger(owner.pid, 'pid'),
    processStartId: boundedIdentity(owner.processStartId, 'processStartId', 1_024),
    hostname: boundedIdentity(owner.hostname, 'hostname', 255),
    bootId: boundedIdentity(owner.bootId, 'bootId', 1_024),
  }
}

function validateSessionWriterTakeover(takeover: SessionWriterTakeover): SessionWriterTakeover {
  return {
    instanceId: opaqueId(takeover.instanceId, 'takeover.instanceId'),
    ownerToken: uuid(takeover.ownerToken, 'takeover.ownerToken'),
    fenceToken: positiveSafeInteger(takeover.fenceToken, 'takeover.fenceToken'),
  }
}

function sameSessionWriterOwner(
  current: SessionWriterSnapshot,
  owner: ValidatedSessionWriterOwner,
): boolean {
  return current.sessionId === owner.sessionId
    && current.instanceId === owner.instanceId
    && current.ownerToken === owner.ownerToken
    && current.pid === owner.pid
    && current.processStartId === owner.processStartId
    && current.hostname === owner.hostname
    && current.bootId === owner.bootId
}

function sameSessionWriterTakeover(
  current: SessionWriterSnapshot,
  takeover: SessionWriterTakeover | undefined,
): boolean {
  return takeover !== undefined
    && current.instanceId === takeover.instanceId
    && current.ownerToken === takeover.ownerToken
    && current.fenceToken === takeover.fenceToken
}

function defaultSessionPolicy(principalSessionId: string): SessionPolicySnapshot {
  return {
    principalSessionId,
    sendAllowed: true,
    receiveAllowed: true,
    updatedAt: 0,
  }
}

function sessionPolicyFromRow(row: SqliteRow): SessionPolicySnapshot {
  return {
    principalSessionId: text(row, 'principal_session_id'),
    sendAllowed: integer(row, 'send_allowed') === 1,
    receiveAllowed: integer(row, 'receive_allowed') === 1,
    updatedAt: integer(row, 'updated_at'),
  }
}

function pairBlockFromRow(row: SqliteRow): PairBlockSnapshot {
  return {
    firstPrincipalSessionId: text(row, 'first_principal_session_id'),
    secondPrincipalSessionId: text(row, 'second_principal_session_id'),
    blockedAt: integer(row, 'blocked_at'),
  }
}

function canonicalPrincipalPair(
  firstInput: SessionIdentity,
  secondInput: SessionIdentity,
): readonly [SessionIdentity, SessionIdentity] {
  const first = opaqueId(firstInput, 'firstPrincipalSessionId')
  const second = opaqueId(secondInput, 'secondPrincipalSessionId')
  if (first === second) {
    throw new MessagingError('INVALID_ARGUMENT', 'pair block principals must be distinct')
  }
  // SQLite's default BINARY collation compares UTF-8 bytes; use the same order
  // so the CHECK constraint and every process agree on the symmetric key.
  return Buffer.compare(Buffer.from(first, 'utf8'), Buffer.from(second, 'utf8')) < 0
    ? [first, second]
    : [second, first]
}

function presenceFromRow(row: SqliteRow): PresenceSnapshot {
  const socketPath = nullableText(row, 'socket_path')
  const agentStatus = validateAgentStatus(text(row, 'agent_status'))
  const cwd = nullableText(row, 'cwd')
  const name = nullableText(row, 'display_name')
  const title = nullableText(row, 'title')
  return {
    sessionId: text(row, 'session_id'),
    instanceId: text(row, 'instance_id'),
    fenceToken: integer(row, 'fence_token'),
    ...(socketPath === undefined ? {} : { endpoint: { socketPath } }),
    active: integer(row, 'active') === 1,
    agentStatus,
    ...(cwd === undefined ? {} : { cwd }),
    ...(name === undefined ? {} : { name }),
    ...(title === undefined ? {} : { title }),
    heartbeatAt: integer(row, 'heartbeat_at'),
    expiresAt: integer(row, 'expires_at'),
    updatedAt: integer(row, 'updated_at'),
  }
}

function sessionWriterFromRow(row: SqliteRow): SessionWriterSnapshot {
  const releasedAt = nullableInteger(row, 'released_at')
  return {
    sessionId: text(row, 'session_id'),
    instanceId: text(row, 'instance_id'),
    ownerToken: text(row, 'owner_token'),
    fenceToken: integer(row, 'fence_token'),
    active: integer(row, 'active') === 1,
    pid: integer(row, 'pid'),
    processStartId: text(row, 'process_start_id'),
    hostname: text(row, 'hostname'),
    bootId: text(row, 'boot_id'),
    acquiredAt: integer(row, 'acquired_at'),
    ...(releasedAt === undefined ? {} : { releasedAt }),
    updatedAt: integer(row, 'updated_at'),
  }
}

function messageFromRow(row: SqliteRow): MessageSnapshot {
  const statusValue = text(row, 'status')
  if (!isMessageStatus(statusValue)) {
    throw new MessagingError('DATABASE_INIT_FAILED', `invalid stored message status ${statusValue}`)
  }
  const channel = validateMessageChannel(text(row, 'channel'))
  const deliveryMode = validateDeliveryMode(text(row, 'delivery_mode'))
  const leaseToken = nullableText(row, 'lease_token')
  const acceptedAt = nullableInteger(row, 'accepted_at')
  const claimedAt = nullableInteger(row, 'claimed_at')
  const failedAt = nullableInteger(row, 'failed_at')
  const expiredAt = nullableInteger(row, 'expired_at')
  const lastError = nullableText(row, 'last_error')
  let payload: JsonValue
  try {
    payload = JSON.parse(text(row, 'payload_json')) as JsonValue
  } catch (error) {
    throw new MessagingError('DATABASE_INIT_FAILED', 'stored message payload is corrupt', { cause: error })
  }

  return {
    messageId: text(row, 'message_id'),
    enqueueSequence: integer(row, 'enqueue_seq'),
    senderSessionId: text(row, 'sender_session_id'),
    recipientSessionId: text(row, 'recipient_session_id'),
    senderPrincipalSessionId: text(row, 'sender_principal_session_id'),
    recipientPrincipalSessionId: text(row, 'recipient_principal_session_id'),
    channel,
    deliveryMode,
    payload,
    status: statusValue,
    createdAt: integer(row, 'created_at'),
    updatedAt: integer(row, 'updated_at'),
    availableAt: integer(row, 'available_at'),
    expiresAt: integer(row, 'expires_at'),
    attemptCount: integer(row, 'attempt_count'),
    maxAttempts: integer(row, 'max_attempts'),
    ...(leaseToken === undefined
      ? {}
      : {
          lease: {
            token: leaseToken,
            ownerInstanceId: requiredNullableText(row, 'lease_owner_instance_id'),
            ownerFenceToken: requiredNullableInteger(row, 'lease_owner_fence_token'),
            until: requiredNullableInteger(row, 'lease_until'),
          },
        }),
    ...(acceptedAt === undefined
      ? {}
      : {
          acceptedAt,
          acceptedByInstanceId: requiredNullableText(row, 'accepted_by_instance_id'),
          acceptedByFenceToken: requiredNullableInteger(row, 'accepted_by_fence_token'),
        }),
    ...(claimedAt === undefined
      ? {}
      : {
          claimedAt,
          claimedByInstanceId: requiredNullableText(row, 'claimed_by_instance_id'),
          claimedByFenceToken: requiredNullableInteger(row, 'claimed_by_fence_token'),
        }),
    ...(failedAt === undefined ? {} : { failedAt }),
    ...(expiredAt === undefined ? {} : { expiredAt }),
    ...(lastError === undefined ? {} : { lastError }),
  }
}

function controlOutcomeFromRow(row: SqliteRow): ControlOutcomeSnapshot {
  const status = validateControlOutcomeStatus(text(row, 'outcome_status'), true)
  const resultJson = nullableText(row, 'result_json')
  const detail = nullableText(row, 'detail')
  let result: JsonValue | undefined
  if (resultJson !== undefined) {
    try {
      result = JSON.parse(resultJson) as JsonValue
      canonicalJson(result)
    } catch (error) {
      throw new MessagingError(
        'DATABASE_INIT_FAILED',
        'stored control outcome is corrupt',
        { cause: error },
      )
    }
  }
  return {
    controlId: text(row, 'control_id'),
    kind: boundedControlKind(text(row, 'kind')),
    payloadHash: sha256Hash(text(row, 'payload_hash')),
    status,
    ...(result === undefined ? {} : { result }),
    ...(detail === undefined ? {} : { detail }),
    completedAt: integer(row, 'completed_at'),
  }
}

function assertLease(message: MessageSnapshot, claim: PresenceClaim, token: string): void {
  const lease = message.lease
  if (lease === undefined
    || lease.token !== token
    || lease.ownerInstanceId !== claim.instanceId
    || lease.ownerFenceToken !== claim.fenceToken) {
    throw leaseLost(message.messageId)
  }
}

function invalidTransition(messageId: string, from: MessageStatus, to: MessageStatus): never {
  throw new MessagingError(
    'INVALID_TRANSITION',
    `message ${JSON.stringify(messageId)} cannot transition from ${from} to ${to}`,
  )
}

function fenceLost(sessionId: string): MessagingError {
  return new MessagingError('FENCE_LOST', `presence fence was lost for ${JSON.stringify(sessionId)}`)
}

function sessionWriterFenceLost(sessionId: string): MessagingError {
  return new MessagingError(
    'FENCE_LOST',
    `session writer fence was lost for ${JSON.stringify(sessionId)}`,
  )
}

function leaseLost(messageId: string): MessagingError {
  return new MessagingError('LEASE_LOST', `delivery lease was lost for ${JSON.stringify(messageId)}`)
}

function permissionDenied(reason: string): MessagingError {
  return new MessagingError('PERMISSION_DENIED', reason)
}

function asRow(value: unknown): SqliteRow {
  if (value === undefined || value === null || typeof value !== 'object') {
    throw new MessagingError('DATABASE_INIT_FAILED', 'SQLite returned no row')
  }
  return value as SqliteRow
}

function text(row: SqliteRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') {
    throw new MessagingError('DATABASE_INIT_FAILED', `stored ${key} is not text`)
  }
  return value
}

function nullableText(row: SqliteRow, key: string): string | undefined {
  const value = row[key]
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new MessagingError('DATABASE_INIT_FAILED', `stored ${key} is not nullable text`)
  }
  return value
}

function requiredNullableText(row: SqliteRow, key: string): string {
  const value = nullableText(row, key)
  if (value === undefined) throw new MessagingError('DATABASE_INIT_FAILED', `stored ${key} is unexpectedly null`)
  return value
}

function integer(row: SqliteRow, key: string): number {
  const value = row[key]
  const number = typeof value === 'bigint' ? Number(value) : value
  if (typeof number !== 'number' || !Number.isSafeInteger(number)) {
    throw new MessagingError('DATABASE_INIT_FAILED', `stored ${key} is not a safe integer`)
  }
  return number
}

function nullableInteger(row: SqliteRow, key: string): number | undefined {
  const value = row[key]
  if (value === null || value === undefined) return undefined
  const number = typeof value === 'bigint' ? Number(value) : value
  if (typeof number !== 'number' || !Number.isSafeInteger(number)) {
    throw new MessagingError('DATABASE_INIT_FAILED', `stored ${key} is not a nullable safe integer`)
  }
  return number
}

function requiredNullableInteger(row: SqliteRow, key: string): number {
  const value = nullableInteger(row, key)
  if (value === undefined) throw new MessagingError('DATABASE_INIT_FAILED', `stored ${key} is unexpectedly null`)
  return value
}

function opaqueId(value: string, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_024 || value.includes('\0')) {
    throw new MessagingError('INVALID_ARGUMENT', `${name} must be a non-empty bounded string`)
  }
  return value
}

function boundedIdentity(value: string, name: string, maxLength: number): string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > maxLength
    || value.includes('\0')) {
    throw new MessagingError('INVALID_ARGUMENT', `${name} must be a non-empty bounded string`)
  }
  return value
}

function uuid(value: string, name: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new MessagingError('INVALID_ARGUMENT', `${name} must be a canonical UUID`)
  }
  return value
}

function absoluteSocketPath(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || !isAbsolute(value)) {
    throw new MessagingError('INVALID_ARGUMENT', 'socketPath must be absolute and non-NUL')
  }
  return value
}

function validateAgentStatus(value: unknown): AgentPresenceStatus {
  if (value !== 'idle' && value !== 'running') {
    throw new MessagingError('INVALID_ARGUMENT', 'agentStatus must be idle or running')
  }
  return value
}

function optionalBoolean(value: boolean | undefined, name: string): boolean | undefined {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new MessagingError('INVALID_ARGUMENT', `${name} must be boolean when provided`)
  }
  return value
}

function validateDeliveryMode(value: unknown): DeliveryMode {
  if (value !== 'followup' && value !== 'steer') {
    throw new MessagingError('INVALID_ARGUMENT', 'deliveryMode must be followup or steer')
  }
  return value
}

function validateMessageChannel(value: unknown): MessageChannel {
  if (!isMessageChannel(value)) {
    throw new MessagingError('INVALID_ARGUMENT', `invalid message channel: ${String(value)}`)
  }
  return value
}

function validateControlOutcomeStatus(
  value: unknown,
  allowFailed: true,
): ControlOutcomeStatus
function validateControlOutcomeStatus(
  value: unknown,
  allowFailed: false,
): Exclude<ControlOutcomeStatus, 'failed'>
function validateControlOutcomeStatus(
  value: unknown,
  allowFailed: boolean,
): ControlOutcomeStatus {
  if (value === 'completed' || value === 'rejected' || (allowFailed && value === 'failed')) {
    return value
  }
  throw new MessagingError('INVALID_ARGUMENT', `invalid control outcome status: ${String(value)}`)
}

function boundedControlKind(value: string): string {
  if (typeof value !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value)) {
    throw new MessagingError('INVALID_ARGUMENT', 'invalid control kind')
  }
  return value
}

function sha256Hash(value: string): string {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new MessagingError('INVALID_ARGUMENT', 'invalid control payload hash')
  }
  return value
}

function assertSameControlOutcomeIdentity(
  outcome: ControlOutcomeSnapshot,
  kind: string,
  payloadHash: string,
): void {
  if (outcome.kind !== kind || outcome.payloadHash !== payloadHash) {
    throw new MessagingError(
      'MESSAGE_ID_COLLISION',
      `control id ${JSON.stringify(outcome.controlId)} was reused for another outcome`,
    )
  }
}

function optionalMetadata(
  value: string | null | undefined,
  name: string,
  maxLength: number,
): string | null | undefined {
  if (value === undefined || value === null) return value
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > maxLength
    || value.includes('\0')) {
    throw new MessagingError('INVALID_ARGUMENT', `${name} must be null or a non-empty bounded string`)
  }
  return value
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new MessagingError('INVALID_ARGUMENT', `${name} must be a positive safe integer`)
  }
  return value
}

function nonNegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MessagingError('INVALID_ARGUMENT', `${name} must be a non-negative safe integer`)
  }
  return value
}

function safeAdd(left: number, right: number, name: string): number {
  const result = left + right
  if (!Number.isSafeInteger(result)) {
    throw new MessagingError('INVALID_ARGUMENT', `${name} exceeds the safe integer range`)
  }
  return result
}

function boundedError(value: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new MessagingError('INVALID_ARGUMENT', 'error must be a non-empty string')
  }
  return value.length <= 4_096 ? value : value.slice(0, 4_096)
}

function optionalBoundedError(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return boundedError(value)
}
