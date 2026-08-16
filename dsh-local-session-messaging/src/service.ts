/**
 * Service Definition for same-machine, independent-session messaging.
 *
 * The contract deliberately uses DSH's shared Agent/Session identity and never
 * treats a process, socket, working directory, or display name as authority.
 * A provider owns discovery and durable transport; model and human surfaces are
 * separate consumers of this seam.
 *
 * @module dsh-local-session-messaging
 */
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { controlPayloadHash } from './control.js'
import type { JsonValue } from './domain.js'

export { controlPayloadHash }
export type { JsonValue }

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionMessaging: SessionMessaging
  }

  interface Events {
    /** The contact set changed; consumers re-read rather than accumulating deltas. */
    'session-messaging/peers-changed'(): void
    /** A durable envelope advanced to a new externally meaningful state. */
    'session-messaging/message-status'(receipt: PeerMessageReceipt): void
    /** A typed control advanced or obtained a durable handler outcome. */
    'session-messaging/control-status'(receipt: ControlReceipt): void
  }
}

export type PeerConnection = 'connected' | 'disconnected'

export type PeerMessageStatus =
  | 'queued'
  | 'accepted'
  | 'claimed'
  | 'failed'
  | 'expired'

/** Fresh read model for one independently addressable top-level Session. */
export interface PeerSessionSnapshot {
  readonly sessionId: SessionId
  readonly name: string
  readonly cwd?: string
  readonly connection: PeerConnection
  readonly agentStatus?: AgentStatus
  /** Caller-specific ACL hint at snapshot time; `send()` remains authoritative. */
  readonly sendable: boolean
}

/** Input accepted only from an exact live caller Agent. */
export interface PeerMessageRequest {
  /** Exact Session id or an unambiguous current display name. */
  readonly recipient: string
  readonly text: string
  readonly replyTo?: MessageId
}

/** Durable status projected without exposing mutable database records. */
export interface PeerMessageReceipt {
  readonly messageId: MessageId
  readonly senderSessionId: SessionId
  readonly recipientSessionId: SessionId
  readonly recipientName: string
  readonly status: PeerMessageStatus
  readonly createdAt: number
  readonly updatedAt: number
  readonly acceptedAt?: number
  readonly claimedAt?: number
  readonly failure?: string
}

/** Caller-supplied typed control; this API is intentionally not model-exposed. */
export interface ControlRequest {
  /** Stable UUID used for retry deduplication and durable outcome lookup. */
  readonly controlId: string
  /** Exact root Session id or an unambiguous current display name. */
  readonly recipient: string
  /** Namespaced mechanical operation understood by a registered receiver. */
  readonly kind: string
  readonly payload: JsonValue
  /** `controlPayloadHash(payload)`; checked before enqueue and again before handling. */
  readonly payloadHash: string
  /**
   * By default the sender briefly waits for a connected receiver's durable
   * handler outcome. Set false when the protocol only needs the enqueue commit
   * before starting independent work; delivery and outcome remain durable and
   * observable through `control-status` / `getControl()`.
   */
  readonly waitForAcknowledgement?: boolean
}

export interface IncomingControl {
  readonly controlId: string
  readonly kind: string
  readonly payload: JsonValue
  readonly payloadHash: string
  readonly senderSessionId: SessionId
  readonly senderPrincipalSessionId: SessionId
  readonly recipientSessionId: SessionId
  readonly recipientPrincipalSessionId: SessionId
  readonly attempt: number
}

export type ControlHandlerDecision =
  | { readonly status: 'completed'; readonly result?: JsonValue }
  | { readonly status: 'rejected'; readonly detail?: string; readonly result?: JsonValue }

/** Both callbacks are mandatory: no registration or a false authorizer is deny-by-default. */
export interface ControlHandlerRegistration {
  readonly authorize: (control: IncomingControl) => boolean | Promise<boolean>
  readonly handle: (
    control: IncomingControl,
  ) => ControlHandlerDecision | Promise<ControlHandlerDecision>
}

export interface ControlOutcome {
  readonly status: 'completed' | 'rejected' | 'failed'
  readonly completedAt: number
  readonly result?: JsonValue
  readonly detail?: string
}

export interface ControlReceipt {
  readonly controlId: string
  readonly kind: string
  readonly payloadHash: string
  readonly senderSessionId: SessionId
  readonly recipientSessionId: SessionId
  readonly recipientName: string
  readonly status: PeerMessageStatus
  readonly createdAt: number
  readonly updatedAt: number
  readonly outcome?: ControlOutcome
  readonly failure?: string
}

/** Human-controlled text/control direction ceiling for one root Session subtree. */
export interface SessionMessagingPermissions {
  readonly sessionId: SessionId
  readonly sendAllowed: boolean
  readonly receiveAllowed: boolean
  readonly updatedAt?: number
}

export interface SessionMessagingPermissionPatch {
  readonly sendAllowed?: boolean
  readonly receiveAllowed?: boolean
}

/** One symmetric free-text isolation edge. Typed control uses its own authorization. */
export interface BlockedPeerSnapshot {
  readonly sessionId: SessionId
  readonly name: string
  readonly blockedAt: number
}

/**
 * Non-TTL ownership of one Session's persistence writer. The provider may
 * share an exact fence across nested reservations in this process; release is
 * idempotent and the durable row remains active while the Session Agent lives.
 */
export interface SessionWriterLease {
  readonly sessionId: SessionId
  readonly instanceId: string
  readonly ownerToken: string
  readonly fenceToken: number
  release(): Promise<void>
}

export type SessionMessagingErrorCode =
  | 'INVALID_MESSAGE'
  | 'UNKNOWN_TARGET'
  | 'AMBIGUOUS_TARGET'
  | 'SELF_TARGET'
  | 'SESSION_CONFLICT'
  | 'MESSAGE_NOT_FOUND'
  | 'MESSAGE_FORBIDDEN'
  | 'PERMISSION_DENIED'
  | 'SERVICE_CLOSED'

/** Stable provider errors translated by every model/human surface. */
export class SessionMessagingError extends Error {
  readonly name = 'SessionMessagingError'

  constructor(
    message: string,
    readonly code: SessionMessagingErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

/**
 * Abstract DSH capability seam. Implementations subclass and load themselves as
 * `ctx.sessionMessaging`; Cordis' duplicate-service fence permits one provider.
 */
export abstract class SessionMessaging extends Service {
  constructor(ctx: Context) {
    if (new.target === SessionMessaging) {
      throw new Error(
        'dsh-local-session-messaging is an abstract service seam; load dsh-local-session-messaging/local',
      )
    }
    super(ctx, 'sessionMessaging')
  }

  /** List same-machine root Sessions visible to the caller, excluding itself. */
  abstract listPeers(caller: Agent, signal?: AbortSignal): Promise<PeerSessionSnapshot[]>

  /** Resolve and durably enqueue one message. */
  abstract send(
    caller: Agent,
    request: PeerMessageRequest,
    signal?: AbortSignal,
  ): Promise<PeerMessageReceipt>

  /** Durably enqueue a non-model control on the existing local transport. */
  abstract sendControl(
    caller: Agent,
    request: ControlRequest,
    signal?: AbortSignal,
  ): Promise<ControlReceipt>

  /** Read one control and its durable outcome as sender or recipient. */
  abstract getControl(
    caller: Agent,
    controlId: string,
    signal?: AbortSignal,
  ): Promise<ControlReceipt>

  /** Register one process-local receiver. Duplicate kinds fail closed. */
  abstract registerControlHandler(
    kind: string,
    registration: ControlHandlerRegistration,
  ): () => void

  /** Reserve the Session's persistence writer before create/resume can write. */
  abstract reserveSessionWriter(sessionId: SessionId): Promise<SessionWriterLease>

  /** Read one envelope when the caller is its sender or recipient. */
  abstract getMessage(
    caller: Agent,
    messageId: MessageId,
    signal?: AbortSignal,
  ): Promise<PeerMessageReceipt>

  /** Read the root Session subtree's human-owned send/receive policy. */
  abstract getPermissions(
    caller: Agent,
    signal?: AbortSignal,
  ): Promise<SessionMessagingPermissions>

  /** Change global transport directions. Model tools intentionally do not expose this. */
  abstract setPermissions(
    caller: Agent,
    patch: SessionMessagingPermissionPatch,
    signal?: AbortSignal,
  ): Promise<SessionMessagingPermissions>

  /** List root Sessions symmetrically isolated from the caller's root subtree. */
  abstract listBlockedPeers(
    caller: Agent,
    signal?: AbortSignal,
  ): Promise<BlockedPeerSnapshot[]>

  /** Add or remove a symmetric pair block after exact-id/unambiguous-name resolution. */
  abstract setPeerBlocked(
    caller: Agent,
    recipient: string,
    blocked: boolean,
    signal?: AbortSignal,
  ): Promise<BlockedPeerSnapshot>
}

export default SessionMessaging
