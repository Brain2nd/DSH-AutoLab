import { v as JsonValue } from "./control-BSZRIKTe.js";
import { SessionId } from "@deepseek-ai/dsh-session";
import { Context, Service } from "@deepseek-ai/cordis";
import { MessageId } from "@deepseek-ai/dsh-llm";
import { Agent, AgentStatus } from "@deepseek-ai/dsh-agent";

//#region src/service.d.ts

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionMessaging: SessionMessaging;
  }
  interface Events {
    /** The contact set changed; consumers re-read rather than accumulating deltas. */
    'session-messaging/peers-changed'(): void;
    /** A durable envelope advanced to a new externally meaningful state. */
    'session-messaging/message-status'(receipt: PeerMessageReceipt): void;
    /** A typed control advanced or obtained a durable handler outcome. */
    'session-messaging/control-status'(receipt: ControlReceipt): void;
  }
}
type PeerConnection = 'connected' | 'disconnected';
type PeerMessageStatus = 'queued' | 'accepted' | 'claimed' | 'failed' | 'expired';
/** Fresh read model for one independently addressable top-level Session. */
interface PeerSessionSnapshot {
  readonly sessionId: SessionId;
  readonly name: string;
  readonly cwd?: string;
  readonly connection: PeerConnection;
  readonly agentStatus?: AgentStatus;
  /** Caller-specific ACL hint at snapshot time; `send()` remains authoritative. */
  readonly sendable: boolean;
}
/** Input accepted only from an exact live caller Agent. */
interface PeerMessageRequest {
  /** Exact Session id or an unambiguous current display name. */
  readonly recipient: string;
  readonly text: string;
  readonly replyTo?: MessageId;
}
/** Durable status projected without exposing mutable database records. */
interface PeerMessageReceipt {
  readonly messageId: MessageId;
  readonly senderSessionId: SessionId;
  readonly recipientSessionId: SessionId;
  readonly recipientName: string;
  readonly status: PeerMessageStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly acceptedAt?: number;
  readonly claimedAt?: number;
  readonly failure?: string;
}
/** Caller-supplied typed control; this API is intentionally not model-exposed. */
interface ControlRequest {
  /** Stable UUID used for retry deduplication and durable outcome lookup. */
  readonly controlId: string;
  /** Exact root Session id or an unambiguous current display name. */
  readonly recipient: string;
  /** Namespaced mechanical operation understood by a registered receiver. */
  readonly kind: string;
  readonly payload: JsonValue;
  /** `controlPayloadHash(payload)`; checked before enqueue and again before handling. */
  readonly payloadHash: string;
  /**
   * By default the sender briefly waits for a connected receiver's durable
   * handler outcome. Set false when the protocol only needs the enqueue commit
   * before starting independent work; delivery and outcome remain durable and
   * observable through `control-status` / `getControl()`.
   */
  readonly waitForAcknowledgement?: boolean;
}
interface IncomingControl {
  readonly controlId: string;
  readonly kind: string;
  readonly payload: JsonValue;
  readonly payloadHash: string;
  readonly senderSessionId: SessionId;
  readonly senderPrincipalSessionId: SessionId;
  readonly recipientSessionId: SessionId;
  readonly recipientPrincipalSessionId: SessionId;
  readonly attempt: number;
}
type ControlHandlerDecision = {
  readonly status: 'completed';
  readonly result?: JsonValue;
} | {
  readonly status: 'rejected';
  readonly detail?: string;
  readonly result?: JsonValue;
};
/** Both callbacks are mandatory: no registration or a false authorizer is deny-by-default. */
interface ControlHandlerRegistration {
  readonly authorize: (control: IncomingControl) => boolean | Promise<boolean>;
  readonly handle: (control: IncomingControl) => ControlHandlerDecision | Promise<ControlHandlerDecision>;
}
interface ControlOutcome {
  readonly status: 'completed' | 'rejected' | 'failed';
  readonly completedAt: number;
  readonly result?: JsonValue;
  readonly detail?: string;
}
interface ControlReceipt {
  readonly controlId: string;
  readonly kind: string;
  readonly payloadHash: string;
  readonly senderSessionId: SessionId;
  readonly recipientSessionId: SessionId;
  readonly recipientName: string;
  readonly status: PeerMessageStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly outcome?: ControlOutcome;
  readonly failure?: string;
}
/** Human-controlled text/control direction ceiling for one root Session subtree. */
interface SessionMessagingPermissions {
  readonly sessionId: SessionId;
  readonly sendAllowed: boolean;
  readonly receiveAllowed: boolean;
  readonly updatedAt?: number;
}
interface SessionMessagingPermissionPatch {
  readonly sendAllowed?: boolean;
  readonly receiveAllowed?: boolean;
}
/** One symmetric free-text isolation edge. Typed control uses its own authorization. */
interface BlockedPeerSnapshot {
  readonly sessionId: SessionId;
  readonly name: string;
  readonly blockedAt: number;
}
/**
 * Non-TTL ownership of one Session's persistence writer. The provider may
 * share an exact fence across nested reservations in this process; release is
 * idempotent and the durable row remains active while the Session Agent lives.
 */
interface SessionWriterLease {
  readonly sessionId: SessionId;
  readonly instanceId: string;
  readonly ownerToken: string;
  readonly fenceToken: number;
  release(): Promise<void>;
}
type SessionMessagingErrorCode = 'INVALID_MESSAGE' | 'UNKNOWN_TARGET' | 'AMBIGUOUS_TARGET' | 'SELF_TARGET' | 'SESSION_CONFLICT' | 'MESSAGE_NOT_FOUND' | 'MESSAGE_FORBIDDEN' | 'PERMISSION_DENIED' | 'SERVICE_CLOSED';
/** Stable provider errors translated by every model/human surface. */
declare class SessionMessagingError extends Error {
  readonly code: SessionMessagingErrorCode;
  readonly name = "SessionMessagingError";
  constructor(message: string, code: SessionMessagingErrorCode, options?: ErrorOptions);
}
/**
 * Abstract DSH capability seam. Implementations subclass and load themselves as
 * `ctx.sessionMessaging`; Cordis' duplicate-service fence permits one provider.
 */
declare abstract class SessionMessaging extends Service {
  constructor(ctx: Context);
  /** List same-machine root Sessions visible to the caller, excluding itself. */
  abstract listPeers(caller: Agent, signal?: AbortSignal): Promise<PeerSessionSnapshot[]>;
  /** Resolve and durably enqueue one message. */
  abstract send(caller: Agent, request: PeerMessageRequest, signal?: AbortSignal): Promise<PeerMessageReceipt>;
  /** Durably enqueue a non-model control on the existing local transport. */
  abstract sendControl(caller: Agent, request: ControlRequest, signal?: AbortSignal): Promise<ControlReceipt>;
  /** Read one control and its durable outcome as sender or recipient. */
  abstract getControl(caller: Agent, controlId: string, signal?: AbortSignal): Promise<ControlReceipt>;
  /** Register one process-local receiver. Duplicate kinds fail closed. */
  abstract registerControlHandler(kind: string, registration: ControlHandlerRegistration): () => void;
  /** Reserve the Session's persistence writer before create/resume can write. */
  abstract reserveSessionWriter(sessionId: SessionId): Promise<SessionWriterLease>;
  /** Read one envelope when the caller is its sender or recipient. */
  abstract getMessage(caller: Agent, messageId: MessageId, signal?: AbortSignal): Promise<PeerMessageReceipt>;
  /** Read the root Session subtree's human-owned send/receive policy. */
  abstract getPermissions(caller: Agent, signal?: AbortSignal): Promise<SessionMessagingPermissions>;
  /** Change global transport directions. Model tools intentionally do not expose this. */
  abstract setPermissions(caller: Agent, patch: SessionMessagingPermissionPatch, signal?: AbortSignal): Promise<SessionMessagingPermissions>;
  /** List root Sessions symmetrically isolated from the caller's root subtree. */
  abstract listBlockedPeers(caller: Agent, signal?: AbortSignal): Promise<BlockedPeerSnapshot[]>;
  /** Add or remove a symmetric pair block after exact-id/unambiguous-name resolution. */
  abstract setPeerBlocked(caller: Agent, recipient: string, blocked: boolean, signal?: AbortSignal): Promise<BlockedPeerSnapshot>;
}
//#endregion
export { SessionMessagingPermissions as _, ControlReceipt as a, PeerConnection as c, PeerMessageStatus as d, PeerSessionSnapshot as f, SessionMessagingPermissionPatch as g, SessionMessagingErrorCode as h, ControlOutcome as i, PeerMessageReceipt as l, SessionMessagingError as m, ControlHandlerDecision as n, ControlRequest as o, SessionMessaging as p, ControlHandlerRegistration as r, IncomingControl as s, BlockedPeerSnapshot as t, PeerMessageRequest as u, SessionWriterLease as v };