import { A as RetryDecision, C as MessageStatus, D as PokeEndpoint, E as PairBlockSnapshot, F as canonicalJson, I as isMessageChannel, L as isMessageStatus, M as SessionPolicySnapshot, N as SetPairBlock, O as PresenceClaim, P as SetSessionPolicy, S as MessageSnapshot, T as MessagingErrorCode, _ as JsonPrimitive, a as validateControlKind, b as MessageId, c as ControlOutcomeSnapshot, d as DeliveryLeaseSnapshot, f as DeliveryMode, g as InstanceId, h as FenceToken, i as parseDurableControlPayload, j as SessionIdentity, k as PresenceSnapshot, l as ControlOutcomeStatus, m as EnqueueResult, n as controlPayloadHash, o as validateControlPayloadHash, p as EnqueueMessage, r as durableControlPayload, s as AgentPresenceStatus, t as DurableControlPayload, u as DeliveryLease, v as JsonValue, w as MessagingError, x as MessageListFilter, y as MessageChannel } from "./control-BSZRIKTe.js";

//#region src/database.d.ts
interface MessagingDatabaseOptions {
  /** Absolute path in a dedicated owner-only directory. */
  readonly path: string;
  readonly busyTimeoutMs?: number;
  readonly maxPayloadBytes?: number;
  /** Injectable wall clock for deterministic tests. */
  readonly clock?: () => number;
}
interface UpsertPresenceOptions {
  readonly sessionId: SessionIdentity;
  readonly instanceId: InstanceId;
  readonly endpoint: {
    readonly socketPath: string;
  };
  readonly agentStatus: AgentPresenceStatus;
  readonly cwd?: string | null;
  readonly name?: string | null;
  readonly title?: string | null;
  readonly leaseMs: number;
  readonly now?: number;
}
interface PresenceMutationOptions extends PresenceClaim {
  readonly now?: number;
}
interface HeartbeatPresenceOptions extends PresenceMutationOptions {
  readonly leaseMs: number;
  readonly agentStatus?: AgentPresenceStatus;
  readonly cwd?: string | null;
  readonly name?: string | null;
  readonly title?: string | null;
}
interface ListPresenceOptions {
  /** Defaults to true and excludes released or elapsed leases. */
  readonly activeOnly?: boolean;
  readonly now?: number;
}
interface SessionWriterSnapshot {
  readonly sessionId: string;
  readonly instanceId: string;
  readonly ownerToken: string;
  readonly fenceToken: number;
  readonly active: boolean;
  readonly pid: number;
  readonly processStartId: string;
  readonly hostname: string;
  readonly bootId: string;
  readonly acquiredAt: number;
  readonly releasedAt?: number;
  readonly updatedAt: number;
}
interface SessionWriterOwnerInput {
  readonly sessionId: string;
  readonly instanceId: string;
  readonly ownerToken: string;
  readonly pid: number;
  readonly processStartId: string;
  readonly hostname: string;
  readonly bootId: string;
  readonly now?: number;
}
interface SessionWriterTakeover {
  readonly instanceId: string;
  readonly ownerToken: string;
  readonly fenceToken: number;
}
interface AcquireSessionWriterOptions extends SessionWriterOwnerInput {
  /** Exact prior live owner mechanically proven dead by the integration layer. */
  readonly takeover?: SessionWriterTakeover;
}
interface ReleaseSessionWriterOptions {
  readonly sessionId: string;
  readonly instanceId: string;
  readonly ownerToken: string;
  readonly fenceToken: number;
  readonly now?: number;
}
interface ClaimDeliveryOptions extends PresenceClaim {
  readonly recipientSessionId: SessionIdentity;
  readonly leaseMs: number;
  readonly now?: number;
}
interface DeliveryMutationOptions extends PresenceClaim {
  readonly messageId: MessageId;
  readonly leaseToken: string;
  readonly now?: number;
}
interface RecoverAcceptedOptions extends PresenceClaim {
  readonly messageId: MessageId;
  readonly now?: number;
}
interface RetryDeliveryOptions extends DeliveryMutationOptions {
  readonly retryDelayMs: number;
  readonly error: string;
}
interface FailDeliveryOptions extends DeliveryMutationOptions {
  readonly error: string;
}
interface MarkClaimedOptions extends PresenceClaim {
  readonly messageId: MessageId;
  readonly now?: number;
}
interface MarkDiscardedOptions extends MarkClaimedOptions {
  readonly error: string;
}
interface CompleteControlDeliveryOptions extends DeliveryMutationOptions {
  readonly kind: string;
  readonly payloadHash: string;
  readonly outcomeStatus: Exclude<ControlOutcomeStatus, 'failed'>;
  readonly result?: JsonValue;
  readonly detail?: string;
}
interface RetryControlDeliveryOptions extends RetryDeliveryOptions {
  readonly kind: string;
  readonly payloadHash: string;
}
interface FailControlDeliveryOptions extends FailDeliveryOptions {
  readonly kind: string;
  readonly payloadHash: string;
}
/**
 * Synchronous, process-local connection to the shared durable queue.
 *
 * The integration layer may place this object in a Worker when it cannot
 * tolerate synchronous SQLite calls on its event loop.  Transactions here are
 * deliberately short and never span DSH calls or Unix-socket I/O.
 */
declare class MessagingDatabase {
  readonly path: string;
  private readonly database;
  private readonly clock;
  private readonly busyTimeoutMs;
  private readonly maxPayloadBytes;
  private closed;
  constructor(options: MessagingDatabaseOptions);
  close(): void;
  /** Acquire, renew, or take over an expired SessionId presence lease. */
  upsertPresence(options: UpsertPresenceOptions): PresenceSnapshot;
  /** Renew only an unexpired exact owner; an elapsed lease must be reacquired. */
  heartbeatPresence(options: HeartbeatPresenceOptions): PresenceSnapshot;
  /** Release an exact owner and advance the fence so late callbacks fail closed. */
  releasePresence(options: PresenceMutationOptions): PresenceSnapshot;
  /** Read the non-TTL Session persistence writer fence, if one was ever issued. */
  getSessionWriter(sessionIdInput: string): SessionWriterSnapshot | undefined;
  /**
   * Acquire a Session persistence writer fence. A live different owner is
   * replaceable only when the caller supplies its exact mechanically-dead
   * identity; elapsed mailbox presence is deliberately irrelevant.
   */
  acquireSessionWriter(options: AcquireSessionWriterOptions): SessionWriterSnapshot;
  /** Release only the exact active writer; late owners cannot clear a newer fence. */
  releaseSessionWriter(options: ReleaseSessionWriterOptions): SessionWriterSnapshot;
  /** Fence every elapsed presence row once. */
  expirePresence(nowInput?: number): number;
  getPresence(sessionIdInput: SessionIdentity): PresenceSnapshot | undefined;
  listPresence(options?: ListPresenceOptions): PresenceSnapshot[];
  /** Read the stored policy or project the implicit all-allowed default. */
  getSessionPolicy(principalSessionIdInput: SessionIdentity): SessionPolicySnapshot;
  /** Read the sparse set of non-default policy rows in one snapshot query. */
  listSessionPolicies(): SessionPolicySnapshot[];
  /**
   * Atomically change a principal policy and fail affected unleased text
   * envelopes. Controls stay queued so the fenced receiver can persist a
   * typed rejected outcome before any handler invocation.
   */
  setSessionPolicy(input: SetSessionPolicy): SessionPolicySnapshot;
  /**
   * Add/remove one symmetric text-only block and cut off both unleased queued
   * text directions. Typed controls deliberately ignore pair blocks.
   */
  setPairBlocked(input: SetPairBlock): PairBlockSnapshot | undefined;
  isPairBlocked(firstPrincipalSessionId: SessionIdentity, secondPrincipalSessionId: SessionIdentity): boolean;
  listPairBlocks(principalSessionIdInput?: SessionIdentity): PairBlockSnapshot[];
  /** Insert once by caller-supplied UUID; an identical repeat is idempotent. */
  enqueue(input: EnqueueMessage): EnqueueResult;
  getMessage(messageIdInput: MessageId): MessageSnapshot | undefined;
  getControlOutcome(controlIdInput: MessageId): ControlOutcomeSnapshot | undefined;
  listMessages(filter?: MessageListFilter): MessageSnapshot[];
  /**
   * Return only rows whose DSH Inbox lifecycle may need crash reconciliation.
   *
   * A fresh unleased queued row has not crossed delivery admission. Accepted
   * rows and queued rows that still carry a delivery lease may have a durable
   * Inbox fact that won the race with the SQLite acknowledgement.
   */
  listReconciliationCandidates(recipientSessionIdInput: SessionIdentity): MessageSnapshot[];
  /** Lease the strict FIFO head for one currently fenced recipient owner. */
  claimNextDelivery(options: ClaimDeliveryOptions): DeliveryLease | undefined;
  /**
   * Record durable DSH inbox admission.  The caller, not this store, establishes
   * that `ctx.sessions.flush(agent.session)` completed before invoking it.
   */
  acceptDelivery(options: DeliveryMutationOptions): MessageSnapshot;
  /** Atomically checkpoint a receiver-side control result and consume its lease. */
  completeControlDelivery(options: CompleteControlDeliveryOptions): {
    readonly message: MessageSnapshot;
    readonly outcome: ControlOutcomeSnapshot;
  };
  /**
   * Recover a durable DSH Inbox admission that won the race with the SQLite
   * accept transaction.  The current fenced recipient may establish the
   * accepted fact without inheriting an old process lease.  Callers must run
   * durable Inbox reconciliation before any due-message sweep for this owner.
   */
  recoverAccepted(options: RecoverAcceptedOptions): MessageSnapshot;
  /**
   * Record the DSH inbox-claimed edge.  queued -> claimed is the crash
   * reconciliation path when the Session log won the race with SQLite accept.
   */
  markClaimed(options: MarkClaimedOptions): MessageSnapshot;
  /** Record a DSH inbox discard even when it raced ahead of SQLite accept. */
  markDiscarded(options: MarkDiscardedOptions): MessageSnapshot;
  /** Clear a lease with bounded backoff, or terminally fail the exhausted head. */
  retryDelivery(options: RetryDeliveryOptions): RetryDecision;
  /** Retry a control handler, atomically persisting failure on final exhaustion. */
  retryControlDelivery(options: RetryControlDeliveryOptions): RetryDecision & {
    readonly outcome?: ControlOutcomeSnapshot;
  };
  failControlDelivery(options: FailControlDeliveryOptions): {
    readonly message: MessageSnapshot;
    readonly outcome: ControlOutcomeSnapshot;
  };
  failDelivery(options: FailDeliveryOptions): MessageSnapshot;
  /**
   * Conservative core-only sweep.  A leased row may already have won durable
   * DSH Inbox admission, so only an unleased queued fact is safe globally.
   */
  terminalizeDue(nowInput?: number): number;
  /**
   * Fence-bound due sweep for one live recipient.  Its integration must first
   * reconcile durable DSH Inbox facts through recoverAccepted/markClaimed.
   */
  terminalizeDueForRecipient(options: PresenceMutationOptions): number;
  private initialize;
  private transaction;
  private withBusyRetry;
  private terminalizeDueInTransaction;
  private terminalizeDueForRecipientInTransaction;
  private updateTerminalFromLease;
  private assertEnvelopeAllowedInTransaction;
  private assertDirectionalPolicyAllowedInTransaction;
  private terminalizeUnauthorizedForRecipientInTransaction;
  private selectSessionPolicy;
  private requireSessionPolicy;
  private selectPairBlock;
  private requirePairBlock;
  private selectSessionWriter;
  private requireSessionWriter;
  private requireCurrentPresence;
  private assertRecipient;
  private assertControlChannel;
  private selectPresence;
  private requirePresence;
  private selectMessage;
  private requireMessage;
  private selectControlOutcome;
  private requireControlOutcome;
  private insertControlOutcome;
  private resolveNow;
  private secureSidecars;
  private assertOpen;
}
//#endregion
//#region src/notifier.d.ts
interface PokeServerOptions {
  /** Dedicated, absolute, owner-only directory. */
  readonly socketDir: string;
  /** Optional deterministic test name; production defaults to a random name. */
  readonly socketName?: string;
  /** Coalesced callback; the database must be reread for authoritative work. */
  readonly onPoke: () => void;
  readonly onError?: (error: unknown) => void;
  readonly connectionTimeoutMs?: number;
}
interface SendPokeOptions {
  readonly timeoutMs?: number;
}
interface PokeServer {
  readonly endpoint: PokeEndpoint;
  close(): Promise<void>;
}
/**
 * Create a best-effort one-byte Unix-domain socket notifier.
 *
 * The socket carries no message payload, ACK, identity, or ordering fact.  A
 * valid byte merely asks the receiver to poll SQLite.  Consequently a dropped,
 * duplicated, forged-by-the-same-uid, or coalesced poke cannot corrupt state.
 */
declare function createPokeServer(options: PokeServerOptions): Promise<PokeServer>;
/**
 * Best-effort poke.  `false` means the endpoint was absent, invalid at the
 * filesystem boundary, timed out, or refused the connection; callers rely on
 * polling and must never translate it into message failure.
 */
declare function sendPoke(endpoint: PokeEndpoint, options?: SendPokeOptions): Promise<boolean>;
/** Validate and return an endpoint without exposing a cached filesystem fact. */
declare function validatePokeEndpoint(endpoint: PokeEndpoint): PokeEndpoint;
//#endregion
export { AcquireSessionWriterOptions, AgentPresenceStatus, ClaimDeliveryOptions, CompleteControlDeliveryOptions, ControlOutcomeSnapshot, ControlOutcomeStatus, DeliveryLease, DeliveryLeaseSnapshot, DeliveryMode, DeliveryMutationOptions, DurableControlPayload, EnqueueMessage, EnqueueResult, FailControlDeliveryOptions, FailDeliveryOptions, FenceToken, HeartbeatPresenceOptions, InstanceId, JsonPrimitive, JsonValue, ListPresenceOptions, MarkClaimedOptions, MarkDiscardedOptions, MessageChannel, MessageId, MessageListFilter, MessageSnapshot, MessageStatus, MessagingDatabase, MessagingDatabaseOptions, MessagingError, MessagingErrorCode, PairBlockSnapshot, PokeEndpoint, PokeServer, PokeServerOptions, PresenceClaim, PresenceMutationOptions, PresenceSnapshot, RecoverAcceptedOptions, ReleaseSessionWriterOptions, RetryControlDeliveryOptions, RetryDecision, RetryDeliveryOptions, SendPokeOptions, SessionIdentity, SessionPolicySnapshot, SessionWriterOwnerInput, SessionWriterSnapshot, SessionWriterTakeover, SetPairBlock, SetSessionPolicy, UpsertPresenceOptions, canonicalJson, controlPayloadHash, createPokeServer, durableControlPayload, isMessageChannel, isMessageStatus, parseDurableControlPayload, sendPoke, validateControlKind, validateControlPayloadHash, validatePokeEndpoint };