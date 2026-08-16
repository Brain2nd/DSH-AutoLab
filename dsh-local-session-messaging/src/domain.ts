/**
 * DSH-independent domain values for the local durable message queue.
 *
 * Session ids are deliberately opaque strings here.  The integration layer is
 * responsible for branding them as DSH SessionId values at its boundary.
 */

export type SessionIdentity = string
export type InstanceId = string
export type MessageId = string
export type FenceToken = number
export type AgentPresenceStatus = 'idle' | 'running'
export type DeliveryMode = 'followup' | 'steer'
export type MessageChannel = 'text' | 'control'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

/**
 * Public delivery state.  A SQLite delivery lease is intentionally orthogonal
 * to this state: acquiring or losing a lease never invents an application ACK.
 */
export type MessageStatus = 'queued' | 'accepted' | 'claimed' | 'failed' | 'expired'

export interface PokeEndpoint {
  /** Absolute path of the owner-only Unix-domain socket. */
  readonly socketPath: string
}

export interface PresenceSnapshot {
  readonly sessionId: SessionIdentity
  /** Random identity for one process boot; never use a PID as this value. */
  readonly instanceId: InstanceId
  /** Monotonically increasing epoch for this session's live owner. */
  readonly fenceToken: FenceToken
  readonly endpoint?: PokeEndpoint
  readonly active: boolean
  readonly agentStatus: AgentPresenceStatus
  readonly cwd?: string
  readonly name?: string
  readonly title?: string
  readonly heartbeatAt: number
  readonly expiresAt: number
  readonly updatedAt: number
}

export interface PresenceClaim {
  readonly sessionId: SessionIdentity
  readonly instanceId: InstanceId
  readonly fenceToken: FenceToken
}

/** Principal-scoped text/control direction ceiling; an absent row allows both. */
export interface SessionPolicySnapshot {
  readonly principalSessionId: SessionIdentity
  readonly sendAllowed: boolean
  readonly receiveAllowed: boolean
  /** Zero denotes the implicit all-allowed default rather than a stored revision. */
  readonly updatedAt: number
}

export interface SetSessionPolicy {
  readonly principalSessionId: SessionIdentity
  readonly sendAllowed?: boolean
  readonly receiveAllowed?: boolean
  readonly now?: number
}

/** One symmetric free-text-only block, stored in canonical principal order. */
export interface PairBlockSnapshot {
  readonly firstPrincipalSessionId: SessionIdentity
  readonly secondPrincipalSessionId: SessionIdentity
  readonly blockedAt: number
}

export interface SetPairBlock {
  readonly firstPrincipalSessionId: SessionIdentity
  readonly secondPrincipalSessionId: SessionIdentity
  readonly blocked: boolean
  readonly now?: number
}

export interface MessageSnapshot {
  /** Stable UUID reused for every delivery attempt and later used as DSH MessageId. */
  readonly messageId: MessageId
  readonly enqueueSequence: number
  readonly senderSessionId: SessionIdentity
  readonly recipientSessionId: SessionIdentity
  /** Root/principal identities used only for authorization, never display routing. */
  readonly senderPrincipalSessionId: SessionIdentity
  readonly recipientPrincipalSessionId: SessionIdentity
  /** Text enters the DSH Inbox; control is consumed by a registered local handler. */
  readonly channel: MessageChannel
  /** Fixed at enqueue; the receiver never recomputes routing from later status. */
  readonly deliveryMode: DeliveryMode
  /** A detached JSON value; callers never receive SQLite-owned mutable state. */
  readonly payload: JsonValue
  readonly status: MessageStatus
  readonly createdAt: number
  readonly updatedAt: number
  readonly availableAt: number
  readonly expiresAt: number
  readonly attemptCount: number
  readonly maxAttempts: number
  readonly lease?: DeliveryLeaseSnapshot
  readonly acceptedAt?: number
  readonly acceptedByInstanceId?: InstanceId
  readonly acceptedByFenceToken?: FenceToken
  readonly claimedAt?: number
  readonly claimedByInstanceId?: InstanceId
  readonly claimedByFenceToken?: FenceToken
  readonly failedAt?: number
  readonly expiredAt?: number
  readonly lastError?: string
}

export interface DeliveryLeaseSnapshot {
  readonly token: string
  readonly ownerInstanceId: InstanceId
  readonly ownerFenceToken: FenceToken
  readonly until: number
}

export interface DeliveryLease {
  readonly message: MessageSnapshot
  readonly lease: DeliveryLeaseSnapshot
}

export interface EnqueueMessage {
  /**
   * Caller-supplied deterministic UUID.  Repeating the same UUID and immutable
   * envelope is idempotent; reusing it for different content is an error.
   */
  readonly messageId: MessageId
  readonly senderSessionId: SessionIdentity
  readonly recipientSessionId: SessionIdentity
  readonly senderPrincipalSessionId: SessionIdentity
  readonly recipientPrincipalSessionId: SessionIdentity
  /** Defaults to text for compatibility with the original relay API. */
  readonly channel?: MessageChannel
  readonly deliveryMode: DeliveryMode
  readonly payload: JsonValue
  readonly ttlMs: number
  readonly maxAttempts: number
  readonly now?: number
}

export interface EnqueueResult {
  readonly message: MessageSnapshot
  readonly deduplicated: boolean
}

export interface MessageListFilter {
  readonly senderSessionId?: SessionIdentity
  readonly recipientSessionId?: SessionIdentity
  readonly statuses?: readonly MessageStatus[]
  readonly limit?: number
}

export interface RetryDecision {
  readonly message: MessageSnapshot
  /** True when the exhausted attempt budget made this failure terminal. */
  readonly terminal: boolean
}

export type ControlOutcomeStatus = 'completed' | 'rejected' | 'failed'

/** Durable result of consuming a typed control envelope outside the model Inbox. */
export interface ControlOutcomeSnapshot {
  readonly controlId: MessageId
  readonly kind: string
  readonly payloadHash: string
  readonly status: ControlOutcomeStatus
  readonly result?: JsonValue
  readonly detail?: string
  readonly completedAt: number
}

export type MessagingErrorCode =
  | 'DATABASE_CLOSED'
  | 'DATABASE_INIT_FAILED'
  | 'UNSUPPORTED_SCHEMA'
  | 'INVALID_ARGUMENT'
  | 'INSECURE_PATH'
  | 'SESSION_CONFLICT'
  | 'FENCE_LOST'
  | 'MESSAGE_NOT_FOUND'
  | 'MESSAGE_ID_COLLISION'
  | 'LEASE_LOST'
  | 'INVALID_TRANSITION'
  | 'PERMISSION_DENIED'
  | 'ENDPOINT_IN_USE'
  | 'NOTIFIER_CLOSED'

/** Stable operational error whose code is safe for integration-layer mapping. */
export class MessagingError extends Error {
  readonly code: MessagingErrorCode

  constructor(code: MessagingErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'MessagingError'
    this.code = code
  }
}

export function isMessageStatus(value: unknown): value is MessageStatus {
  return value === 'queued'
    || value === 'accepted'
    || value === 'claimed'
    || value === 'failed'
    || value === 'expired'
}

export function isMessageChannel(value: unknown): value is MessageChannel {
  return value === 'text' || value === 'control'
}

/** Stable JSON encoding shared by envelope identity and typed-control hashing. */
export function canonicalJson(value: JsonValue): string {
  const active = new Set<object>()
  const encode = (candidate: unknown): string => {
    if (candidate === null) return 'null'
    if (typeof candidate === 'string' || typeof candidate === 'boolean') {
      return JSON.stringify(candidate)
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate) || Object.is(candidate, -0)) {
        throw new MessagingError('INVALID_ARGUMENT', 'payload contains a non-JSON number')
      }
      return JSON.stringify(candidate)
    }
    if (Array.isArray(candidate)) {
      if (active.has(candidate)) throw new MessagingError('INVALID_ARGUMENT', 'payload is cyclic')
      active.add(candidate)
      const parts: string[] = []
      for (let index = 0; index < candidate.length; index += 1) {
        if (!(index in candidate)) {
          throw new MessagingError('INVALID_ARGUMENT', 'payload contains a sparse array')
        }
        parts.push(encode(candidate[index]))
      }
      active.delete(candidate)
      return `[${parts.join(',')}]`
    }
    if (typeof candidate === 'object') {
      const prototype = Object.getPrototypeOf(candidate)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new MessagingError('INVALID_ARGUMENT', 'payload contains a non-plain object')
      }
      if (active.has(candidate)) throw new MessagingError('INVALID_ARGUMENT', 'payload is cyclic')
      active.add(candidate)
      const object = candidate as Record<string, unknown>
      const parts = Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${encode(object[key])}`)
      active.delete(candidate)
      return `{${parts.join(',')}}`
    }
    throw new MessagingError('INVALID_ARGUMENT', `payload contains unsupported ${typeof candidate}`)
  }
  return encode(value)
}
