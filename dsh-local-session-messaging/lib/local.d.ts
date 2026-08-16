import "./control-BSZRIKTe.js";
import { _ as SessionMessagingPermissions, a as ControlReceipt, f as PeerSessionSnapshot, g as SessionMessagingPermissionPatch, l as PeerMessageReceipt, o as ControlRequest, p as SessionMessaging, r as ControlHandlerRegistration, t as BlockedPeerSnapshot, u as PeerMessageRequest, v as SessionWriterLease } from "./service-CSPV5J2b.js";
import { SessionId } from "@deepseek-ai/dsh-session";
import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { MessageId } from "@deepseek-ai/dsh-llm";
import { Agent } from "@deepseek-ai/dsh-agent";

//#region src/local.d.ts
/** Source attached to every relayed DSH user message. */
interface LocalSessionRelaySource {
  readonly kind: 'local-session-relay';
  readonly form: 'relay';
  /** Exact Agent Session that initiated the send, including a descendant. */
  readonly senderSessionId: SessionId;
  /** Contactable root Session that owns the sender and should receive replies. */
  readonly replySessionId: SessionId;
  /** Trusted display-name snapshot for model-facing attribution. */
  readonly senderName?: string;
  /** Same UUID as both the SQLite envelope and the DSH MessageId. */
  readonly envelopeId: string;
  readonly replyTo?: MessageId;
}
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'local-session-relay': LocalSessionRelaySource;
  }
}
interface Config {
  /** Owner-only state directory. Defaults below the resolved DSH home. */
  root?: string;
  heartbeatIntervalMs?: number;
  presenceTtlMs?: number;
  pollIntervalMs?: number;
  deliveryLeaseMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  messageTtlMs?: number;
  maxAttempts?: number;
  maxMessageBytes?: number;
  ackWaitMs?: number;
  ackPollMs?: number;
  socketTimeoutMs?: number;
}
/** DSH-native local provider. One instance serves all root Agents in a process. */
declare class LocalSessionMessaging extends SessionMessaging {
  static inject: string[];
  static Config: z<Config>;
  private readonly config;
  private readonly database;
  private readonly instanceId;
  private readonly processIdentity;
  private readonly bindings;
  private readonly writerBindings;
  private readonly pumps;
  private readonly work;
  private readonly permissionDiscards;
  private readonly controlHandlers;
  private readonly retiredControlKinds;
  private notifier?;
  private initialized;
  private closed;
  private closePromise?;
  constructor(ctx: Context, config: Config);
  /** Cordis awaits this before making the class plugin active. */
  [Service.init](): Promise<void>;
  listPeers(caller: Agent, signal?: AbortSignal): Promise<PeerSessionSnapshot[]>;
  send(caller: Agent, request: PeerMessageRequest, signal?: AbortSignal): Promise<PeerMessageReceipt>;
  sendControl(caller: Agent, request: ControlRequest, signal?: AbortSignal): Promise<ControlReceipt>;
  getControl(caller: Agent, controlId: string, signal?: AbortSignal): Promise<ControlReceipt>;
  registerControlHandler(kindInput: string, registration: ControlHandlerRegistration): () => void;
  reserveSessionWriter(sessionId: SessionId): Promise<SessionWriterLease>;
  getMessage(caller: Agent, messageId: MessageId, signal?: AbortSignal): Promise<PeerMessageReceipt>;
  getPermissions(caller: Agent, signal?: AbortSignal): Promise<SessionMessagingPermissions>;
  setPermissions(caller: Agent, patch: SessionMessagingPermissionPatch, signal?: AbortSignal): Promise<SessionMessagingPermissions>;
  listBlockedPeers(caller: Agent, signal?: AbortSignal): Promise<BlockedPeerSnapshot[]>;
  setPeerBlocked(caller: Agent, recipient: string, blocked: boolean, signal?: AbortSignal): Promise<BlockedPeerSnapshot>;
  private acquireSessionWriterBinding;
  private releaseWriterReservation;
  private releaseSessionWriterIfUnused;
  private attachSessionWriter;
  private detachSessionWriter;
  private flushAndDetachSessionWriter;
  private isRoot;
  private presenceMetadata;
  private attachRoot;
  private detachRoot;
  private heartbeat;
  private poll;
  private handlePresenceError;
  private requestAllPumps;
  private requestPump;
  private pump;
  private deliverLeased;
  private deliverControlLeased;
  private retryLeased;
  private retryControlLeased;
  /** Recover status edges that happened while this provider was down. */
  private reconcileDurableInbox;
  private flushAndMarkClaimed;
  private flushAndMarkDiscarded;
  private flushInbox;
  private waitForAcknowledgement;
  private projectPresence;
  private resolveTarget;
  private policyPrincipal;
  private blockedPeerNames;
  private notifyPolicyChange;
  private notifyRecipient;
  private receipt;
  private controlReceipt;
  private emitStatus;
  private emitPeersChanged;
  private assertLiveCaller;
  private ensureNotClosed;
  private ensureReady;
  private track;
  private close;
  private closeNow;
}
//#endregion
export { Config, LocalSessionMessaging, LocalSessionMessaging as default, LocalSessionRelaySource };