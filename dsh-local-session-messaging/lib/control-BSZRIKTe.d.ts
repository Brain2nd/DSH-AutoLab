//#region src/domain.d.ts
/**
 * DSH-independent domain values for the local durable message queue.
 *
 * Session ids are deliberately opaque strings here.  The integration layer is
 * responsible for branding them as DSH SessionId values at its boundary.
 */
type SessionIdentity = string;
type InstanceId = string;
type MessageId = string;
type FenceToken = number;
type AgentPresenceStatus = 'idle' | 'running';
type DeliveryMode = 'followup' | 'steer';
type MessageChannel = 'text' | 'control';
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | {
  [key: string]: JsonValue;
};
/**
 * Public delivery state.  A SQLite delivery lease is intentionally orthogonal
 * to this state: acquiring or losing a lease never invents an application ACK.
 */
type MessageStatus = 'queued' | 'accepted' | 'claimed' | 'failed' | 'expired';
interface PokeEndpoint {
  /** Absolute path of the owner-only Unix-domain socket. */
  readonly socketPath: string;
}
interface PresenceSnapshot {
  readonly sessionId: SessionIdentity;
  /** Random identity for one process boot; never use a PID as this value. */
  readonly instanceId: InstanceId;
  /** Monotonically increasing epoch for this session's live owner. */
  readonly fenceToken: FenceToken;
  readonly endpoint?: PokeEndpoint;
  readonly active: boolean;
  readonly agentStatus: AgentPresenceStatus;
  readonly cwd?: string;
  readonly name?: string;
  readonly title?: string;
  readonly heartbeatAt: number;
  readonly expiresAt: number;
  readonly updatedAt: number;
}
interface PresenceClaim {
  readonly sessionId: SessionIdentity;
  readonly instanceId: InstanceId;
  readonly fenceToken: FenceToken;
}
/** Principal-scoped text/control direction ceiling; an absent row allows both. */
interface SessionPolicySnapshot {
  readonly principalSessionId: SessionIdentity;
  readonly sendAllowed: boolean;
  readonly receiveAllowed: boolean;
  /** Zero denotes the implicit all-allowed default rather than a stored revision. */
  readonly updatedAt: number;
}
interface SetSessionPolicy {
  readonly principalSessionId: SessionIdentity;
  readonly sendAllowed?: boolean;
  readonly receiveAllowed?: boolean;
  readonly now?: number;
}
/** One symmetric free-text-only block, stored in canonical principal order. */
interface PairBlockSnapshot {
  readonly firstPrincipalSessionId: SessionIdentity;
  readonly secondPrincipalSessionId: SessionIdentity;
  readonly blockedAt: number;
}
interface SetPairBlock {
  readonly firstPrincipalSessionId: SessionIdentity;
  readonly secondPrincipalSessionId: SessionIdentity;
  readonly blocked: boolean;
  readonly now?: number;
}
interface MessageSnapshot {
  /** Stable UUID reused for every delivery attempt and later used as DSH MessageId. */
  readonly messageId: MessageId;
  readonly enqueueSequence: number;
  readonly senderSessionId: SessionIdentity;
  readonly recipientSessionId: SessionIdentity;
  /** Root/principal identities used only for authorization, never display routing. */
  readonly senderPrincipalSessionId: SessionIdentity;
  readonly recipientPrincipalSessionId: SessionIdentity;
  /** Text enters the DSH Inbox; control is consumed by a registered local handler. */
  readonly channel: MessageChannel;
  /** Fixed at enqueue; the receiver never recomputes routing from later status. */
  readonly deliveryMode: DeliveryMode;
  /** A detached JSON value; callers never receive SQLite-owned mutable state. */
  readonly payload: JsonValue;
  readonly status: MessageStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly availableAt: number;
  readonly expiresAt: number;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly lease?: DeliveryLeaseSnapshot;
  readonly acceptedAt?: number;
  readonly acceptedByInstanceId?: InstanceId;
  readonly acceptedByFenceToken?: FenceToken;
  readonly claimedAt?: number;
  readonly claimedByInstanceId?: InstanceId;
  readonly claimedByFenceToken?: FenceToken;
  readonly failedAt?: number;
  readonly expiredAt?: number;
  readonly lastError?: string;
}
interface DeliveryLeaseSnapshot {
  readonly token: string;
  readonly ownerInstanceId: InstanceId;
  readonly ownerFenceToken: FenceToken;
  readonly until: number;
}
interface DeliveryLease {
  readonly message: MessageSnapshot;
  readonly lease: DeliveryLeaseSnapshot;
}
interface EnqueueMessage {
  /**
   * Caller-supplied deterministic UUID.  Repeating the same UUID and immutable
   * envelope is idempotent; reusing it for different content is an error.
   */
  readonly messageId: MessageId;
  readonly senderSessionId: SessionIdentity;
  readonly recipientSessionId: SessionIdentity;
  readonly senderPrincipalSessionId: SessionIdentity;
  readonly recipientPrincipalSessionId: SessionIdentity;
  /** Defaults to text for compatibility with the original relay API. */
  readonly channel?: MessageChannel;
  readonly deliveryMode: DeliveryMode;
  readonly payload: JsonValue;
  readonly ttlMs: number;
  readonly maxAttempts: number;
  readonly now?: number;
}
interface EnqueueResult {
  readonly message: MessageSnapshot;
  readonly deduplicated: boolean;
}
interface MessageListFilter {
  readonly senderSessionId?: SessionIdentity;
  readonly recipientSessionId?: SessionIdentity;
  readonly statuses?: readonly MessageStatus[];
  readonly limit?: number;
}
interface RetryDecision {
  readonly message: MessageSnapshot;
  /** True when the exhausted attempt budget made this failure terminal. */
  readonly terminal: boolean;
}
type ControlOutcomeStatus = 'completed' | 'rejected' | 'failed';
/** Durable result of consuming a typed control envelope outside the model Inbox. */
interface ControlOutcomeSnapshot {
  readonly controlId: MessageId;
  readonly kind: string;
  readonly payloadHash: string;
  readonly status: ControlOutcomeStatus;
  readonly result?: JsonValue;
  readonly detail?: string;
  readonly completedAt: number;
}
type MessagingErrorCode = 'DATABASE_CLOSED' | 'DATABASE_INIT_FAILED' | 'UNSUPPORTED_SCHEMA' | 'INVALID_ARGUMENT' | 'INSECURE_PATH' | 'SESSION_CONFLICT' | 'FENCE_LOST' | 'MESSAGE_NOT_FOUND' | 'MESSAGE_ID_COLLISION' | 'LEASE_LOST' | 'INVALID_TRANSITION' | 'PERMISSION_DENIED' | 'ENDPOINT_IN_USE' | 'NOTIFIER_CLOSED';
/** Stable operational error whose code is safe for integration-layer mapping. */
declare class MessagingError extends Error {
  readonly code: MessagingErrorCode;
  constructor(code: MessagingErrorCode, message: string, options?: ErrorOptions);
}
declare function isMessageStatus(value: unknown): value is MessageStatus;
declare function isMessageChannel(value: unknown): value is MessageChannel;
/** Stable JSON encoding shared by envelope identity and typed-control hashing. */
declare function canonicalJson(value: JsonValue): string;
//#endregion
//#region src/control.d.ts
/** Private wire payload stored inside the existing durable mailbox row. */
interface DurableControlPayload {
  readonly version: 1;
  readonly type: 'control';
  readonly kind: string;
  readonly payload: JsonValue;
  readonly payloadHash: string;
}
declare function controlPayloadHash(payload: JsonValue): string;
declare function validateControlKind(value: string): string;
declare function validateControlPayloadHash(value: string, payload: JsonValue): string;
declare function durableControlPayload(kindInput: string, payload: JsonValue, payloadHashInput: string): DurableControlPayload;
declare function parseDurableControlPayload(value: JsonValue): DurableControlPayload;
//#endregion
export { RetryDecision as A, MessageStatus as C, PokeEndpoint as D, PairBlockSnapshot as E, canonicalJson as F, isMessageChannel as I, isMessageStatus as L, SessionPolicySnapshot as M, SetPairBlock as N, PresenceClaim as O, SetSessionPolicy as P, MessageSnapshot as S, MessagingErrorCode as T, JsonPrimitive as _, validateControlKind as a, MessageId as b, ControlOutcomeSnapshot as c, DeliveryLeaseSnapshot as d, DeliveryMode as f, InstanceId as g, FenceToken as h, parseDurableControlPayload as i, SessionIdentity as j, PresenceSnapshot as k, ControlOutcomeStatus as l, EnqueueResult as m, controlPayloadHash as n, validateControlPayloadHash as o, EnqueueMessage as p, durableControlPayload as r, AgentPresenceStatus as s, DurableControlPayload as t, DeliveryLease as u, JsonValue as v, MessagingError as w, MessageListFilter as x, MessageChannel as y };