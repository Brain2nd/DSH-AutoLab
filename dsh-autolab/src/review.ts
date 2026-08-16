import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { GoalId, type GoalRef, type GoalView } from '@deepseek-ai/dsh-goal'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  controlPayloadHash,
  type ControlHandlerDecision,
  type ControlHandlerRegistration,
  type ControlReceipt,
  type IncomingControl,
  type JsonValue,
} from 'dsh-local-session-messaging'
import { canonicalJson } from 'dsh-local-session-messaging/core'

import {
  resolutionHash,
  reviewResolutionStateSchema,
  type ReviewResolutionBody,
  type ReviewResolutionState,
} from './state.js'
import { observeOpenAgentTurn } from './goal.js'

export const REVIEW_REQUEST = 'REVIEW_REQUEST'
export const REVIEW_ACCEPTED_PAUSE = 'REVIEW_ACCEPTED_PAUSE'

/** Fixed audit text. It is never executed as a slash command or sent to a model Inbox. */
export const REVIEW_ACCEPTED_TEXT = '已收到，请等待审核。\n/goal pause'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u

export interface ReviewGoalRef {
  readonly id: string
  readonly revision: number
}

export type ReviewResolutionInput = Omit<ReviewResolutionBody, 'version'>

/** Compile the one immutable marker for a route whose effect already exists. */
export function compileReviewResolution(
  input: ReviewResolutionInput,
): ReviewResolutionState {
  const body: ReviewResolutionBody = {
    version: 1,
    reviewId: input.reviewId,
    verdictHash: input.verdictHash,
    targetRoleId: input.targetRoleId,
    targetSessionId: input.targetSessionId,
    effect: { ...input.effect },
  }
  return reviewResolutionStateSchema.parse({
    ...body,
    resolutionHash: resolutionHash(body),
  })
}

/**
 * The exact Controller-issued edge for one review handshake. The resolver
 * supplied to the receiver is the authority for whether this edge is still
 * live; the receiver never mutates RuntimeState.
 */
export interface ReviewControlCapability {
  readonly version: 1
  readonly reviewId: string
  readonly assignmentId: string
  readonly configRevision: number
  readonly runtimeRevision: number
  readonly ownerFence: string
  readonly workerRoleId: string
  readonly workerSessionId: string
  readonly judgeRoleId: string
  readonly judgeSessionId: string
  readonly packetHash: string
  readonly artifactHash: string
  readonly negotiatedAnchorHash: string
  /** Exact worker turn which submitted this review. */
  readonly sourceTurn: number
  readonly expectedGoalRef: ReviewGoalRef | null
  readonly request: {
    readonly controlId: string
    readonly payloadHash: string
  }
  readonly acceptedPause: {
    readonly controlId: string
    readonly payloadHash: string
  }
}

export interface ReviewControlCapabilityInput {
  readonly reviewId: string
  readonly assignmentId: string
  readonly configRevision: number
  readonly runtimeRevision: number
  readonly ownerFence: string
  readonly workerRoleId: string
  readonly workerSessionId: string
  readonly judgeRoleId: string
  readonly judgeSessionId: string
  readonly packetHash: string
  readonly artifactHash: string
  readonly negotiatedAnchorHash: string
  readonly sourceTurn: number
  readonly expectedGoalRef: ReviewGoalRef | null
  readonly requestControlId: string
  readonly acceptedPauseControlId: string
}

export interface ReviewRequestPayload {
  readonly version: 1
  readonly type: 'REVIEW_REQUEST'
  readonly requestControlId: string
  readonly reviewId: string
  readonly assignmentId: string
  readonly configRevision: number
  readonly runtimeRevision: number
  readonly ownerFence: string
  readonly sourceRoleId: string
  readonly sourceSessionId: string
  readonly targetRoleId: string
  readonly targetSessionId: string
  readonly packetHash: string
  readonly artifactHash: string
  readonly negotiatedAnchorHash: string
  readonly sourceTurn: number
  readonly expectedGoalRef: ReviewGoalRef | null
}

export interface ReviewAcceptedPausePayload {
  readonly version: 1
  readonly type: 'REVIEW_ACCEPTED_PAUSE'
  readonly acceptedPauseControlId: string
  readonly requestControlId: string
  readonly requestPayloadHash: string
  readonly reviewId: string
  readonly assignmentId: string
  readonly configRevision: number
  readonly runtimeRevision: number
  readonly ownerFence: string
  readonly sourceRoleId: string
  readonly sourceSessionId: string
  readonly targetRoleId: string
  readonly targetSessionId: string
  readonly packetHash: string
  readonly artifactHash: string
  readonly negotiatedAnchorHash: string
  readonly sourceTurn: number
  readonly expectedGoalRef: ReviewGoalRef | null
  readonly acknowledgement: typeof REVIEW_ACCEPTED_TEXT
  readonly goalAction: 'pause'
}

export interface ReviewJudgeStart {
  /** Stable key which the implementation must also deduplicate across restart. */
  readonly wakeId: string
  readonly reviewId: string
  readonly assignmentId: string
  readonly judgeSessionId: string
  readonly workerSessionId: string
  readonly configRevision: number
  readonly runtimeRevision: number
  readonly ownerFence: string
  readonly packetHash: string
  readonly artifactHash: string
  readonly negotiatedAnchorHash: string
}

export type ReviewJudgeStartOutcome = 'started' | 'already-started'

export interface ReviewControlHandlersOptions {
  /** Return only a currently authorized, owner-fenced capability. */
  readonly resolveCapability: (
    controlId: string,
  ) => ReviewControlCapability | undefined
  /** Controller shutdown aborts an admitted handler at its await boundaries. */
  readonly signal?: AbortSignal
  /** Join one handler with the Controller lifecycle; omitted by isolated unit users. */
  readonly runHandler?: (
    operation: () => Promise<ControlHandlerDecision>,
  ) => Promise<ControlHandlerDecision>
}

export interface ReviewControlHandlers {
  readonly request: AsyncControlHandlerRegistration
  readonly acceptedPause: AsyncControlHandlerRegistration
}

interface AsyncControlHandlerRegistration extends ControlHandlerRegistration {
  readonly handle: (control: IncomingControl) => Promise<ControlHandlerDecision>
}

export interface ReviewGoalPauseResult {
  readonly outcome: 'paused' | 'already-applied' | 'no-active-goal' | 'stale'
  readonly ref?: ReviewGoalRef
  /**
   * True only when the exact reviewed Session still has an active turn after
   * the durable Goal mutation. The Controller may then invoke its explicit
   * cancel/join/maintenance-hold fallback; this receiver never does so itself.
   */
  readonly activeTurn: boolean
  /** Exact durable turn observed open after the Goal pause; present iff activeTurn. */
  readonly observedTurn?: number
  /** Mechanical relation between the open turn and the immutable submitting turn. */
  readonly turnOutcome: 'stopped' | 'source-active' | 'user-override'
}

export class ReviewProtocolError extends Error {
  readonly name = 'ReviewProtocolError'

  constructor(
    message: string,
    readonly code:
      | 'INVALID_CAPABILITY'
      | 'CAPABILITY_MISMATCH'
      | 'SESSION_NOT_LOCAL'
      | 'DURABILITY_UNAVAILABLE'
      | 'CONTROL_DELIVERY_FAILED',
  ) {
    super(message)
  }
}

/** Compile the only two legal payloads and bind both canonical payload hashes. */
export function compileReviewControlCapability(
  input: ReviewControlCapabilityInput,
): ReviewControlCapability {
  validateCapabilityInput(input)
  const expectedGoalRef = freezeGoalRef(input.expectedGoalRef)
  const base = Object.freeze({
    version: 1 as const,
    reviewId: input.reviewId,
    assignmentId: input.assignmentId,
    configRevision: input.configRevision,
    runtimeRevision: input.runtimeRevision,
    ownerFence: input.ownerFence,
    workerRoleId: input.workerRoleId,
    workerSessionId: input.workerSessionId,
    judgeRoleId: input.judgeRoleId,
    judgeSessionId: input.judgeSessionId,
    packetHash: input.packetHash,
    artifactHash: input.artifactHash,
    negotiatedAnchorHash: input.negotiatedAnchorHash,
    sourceTurn: input.sourceTurn,
    expectedGoalRef,
  })
  const requestPayload = requestPayloadFrom(base, input.requestControlId)
  const requestPayloadHash = controlPayloadHash(asJson(requestPayload))
  const acceptedPayload = acceptedPayloadFrom(
    base,
    input.acceptedPauseControlId,
    input.requestControlId,
    requestPayloadHash,
  )
  return Object.freeze({
    ...base,
    request: Object.freeze({
      controlId: input.requestControlId,
      payloadHash: requestPayloadHash,
    }),
    acceptedPause: Object.freeze({
      controlId: input.acceptedPauseControlId,
      payloadHash: controlPayloadHash(asJson(acceptedPayload)),
    }),
  })
}

export function reviewRequestPayload(
  capabilityInput: ReviewControlCapability,
): ReviewRequestPayload {
  const capability = normalizeCapability(capabilityInput)
  return requestPayloadFrom(capability, capability.request.controlId)
}

export function reviewAcceptedPausePayload(
  capabilityInput: ReviewControlCapability,
): ReviewAcceptedPausePayload {
  const capability = normalizeCapability(capabilityInput)
  return acceptedPayloadFrom(
    capability,
    capability.acceptedPause.controlId,
    capability.request.controlId,
    capability.request.payloadHash,
  )
}

/** Send the exact REVIEW_REQUEST from the reviewed root Agent. */
export async function sendReviewRequest(
  ctx: Context,
  caller: Agent,
  capabilityInput: ReviewControlCapability,
  signal?: AbortSignal,
): Promise<ControlReceipt> {
  const capability = normalizeCapability(capabilityInput)
  if (String(caller.id) !== capability.workerSessionId) {
    throw new ReviewProtocolError(
      'REVIEW_REQUEST caller does not match the capability worker Session',
      'CAPABILITY_MISMATCH',
    )
  }
  return await ctx.sessionMessaging.sendControl(caller, {
    controlId: capability.request.controlId,
    recipient: capability.judgeSessionId,
    kind: REVIEW_REQUEST,
    payload: asJson(requestPayloadFrom(capability, capability.request.controlId)),
    payloadHash: capability.request.payloadHash,
    // Controller progress is event-driven after the durable enqueue; waiting
    // here would unnecessarily occupy its serialized state-transition path.
    waitForAcknowledgement: false,
  }, signal)
}

/**
 * Build both non-model handlers. Replays deliberately call the two existing
 * idempotent transport boundary again. Judge work is deliberately not started
 * here: the Controller starts it only after the pause outcome and stopped/held
 * freeze are durable.
 */
export function createReviewControlHandlers(
  ctx: Context,
  options: ReviewControlHandlersOptions,
): ReviewControlHandlers {
  const request: AsyncControlHandlerRegistration = {
    authorize: async control => {
      options.signal?.throwIfAborted()
      const capability = authorizedCapability(control, 'request', options)
      options.signal?.throwIfAborted()
      return capability !== undefined
    },
    handle: control => runReviewHandler(options, async () => {
      options.signal?.throwIfAborted()
      const capability = authorizedCapability(control, 'request', options)
      options.signal?.throwIfAborted()
      if (capability === undefined) return capabilityRejected()

      const judge = resolveLocalAgent(ctx, capability.judgeSessionId)
      const acceptedPayload = acceptedPayloadFrom(
        capability,
        capability.acceptedPause.controlId,
        capability.request.controlId,
        capability.request.payloadHash,
      )
      const acceptedRequest = {
        controlId: capability.acceptedPause.controlId,
        recipient: capability.workerSessionId,
        kind: REVIEW_ACCEPTED_PAUSE,
        payload: asJson(acceptedPayload),
        payloadHash: capability.acceptedPause.payloadHash,
        // The enqueue commit is the one application ACK edge. Judge work remains
        // deferred until the worker's mechanical pause/hold is durably complete.
        waitForAcknowledgement: false,
      } as const
      const accepted = options.signal === undefined
        ? await ctx.sessionMessaging.sendControl(judge, acceptedRequest)
        : await ctx.sessionMessaging.sendControl(judge, acceptedRequest, options.signal)
      if (accepted.status === 'failed'
        || accepted.status === 'expired'
        || accepted.outcome?.status === 'failed'
        || accepted.outcome?.status === 'rejected') {
        throw new ReviewProtocolError(
          `review ACK control ${accepted.controlId} is ${accepted.outcome?.status ?? accepted.status}`,
          'CONTROL_DELIVERY_FAILED',
        )
      }
      options.signal?.throwIfAborted()
      return {
        status: 'completed',
        result: asJson({
          version: 1,
          type: 'REVIEW_REQUEST_OUTCOME',
          reviewId: capability.reviewId,
          acceptedPauseControlId: capability.acceptedPause.controlId,
          acceptedPausePayloadHash: capability.acceptedPause.payloadHash,
          acceptedPauseTransportStatus: accepted.status,
          judgeStart: 'awaiting-pause',
        }),
      }
    }),
  }

  const acceptedPause: AsyncControlHandlerRegistration = {
    authorize: async control => {
      options.signal?.throwIfAborted()
      const capability = authorizedCapability(control, 'acceptedPause', options)
      options.signal?.throwIfAborted()
      return capability !== undefined
    },
    handle: control => runReviewHandler(options, async () => {
      options.signal?.throwIfAborted()
      const capability = authorizedCapability(control, 'acceptedPause', options)
      options.signal?.throwIfAborted()
      if (capability === undefined) return capabilityRejected()
      const paused = await pauseExpectedReviewGoal(
        ctx,
        capability.workerSessionId,
        capability.expectedGoalRef,
        capability.sourceTurn,
      )
      return {
        status: 'completed',
        result: asJson({
          version: 1,
          type: 'REVIEW_PAUSE_OUTCOME',
          reviewId: capability.reviewId,
          requestControlId: capability.request.controlId,
          acknowledgement: REVIEW_ACCEPTED_TEXT,
          goalAction: 'pause',
          goalOutcome: paused.outcome,
          activeTurn: paused.activeTurn,
          turnOutcome: paused.turnOutcome,
          ...(paused.observedTurn === undefined ? {} : { observedTurn: paused.observedTurn }),
          ...(paused.ref === undefined ? {} : { goalRef: paused.ref }),
        }),
      }
    }),
  }

  return Object.freeze({ request, acceptedPause })
}

function runReviewHandler(
  options: ReviewControlHandlersOptions,
  operation: () => Promise<ControlHandlerDecision>,
): Promise<ControlHandlerDecision> {
  return options.runHandler === undefined
    ? operation()
    : options.runHandler(operation)
}

/** Register both kinds on the existing messaging transport; no daemon or poller is created. */
export function registerReviewControlHandlers(
  ctx: Context,
  options: ReviewControlHandlersOptions,
): () => void {
  const handlers = createReviewControlHandlers(ctx, options)
  const removeRequest = ctx.sessionMessaging.registerControlHandler(REVIEW_REQUEST, handlers.request)
  let removeAccepted: (() => void) | undefined
  try {
    removeAccepted = ctx.sessionMessaging.registerControlHandler(
      REVIEW_ACCEPTED_PAUSE,
      handlers.acceptedPause,
    )
  } catch (error) {
    removeRequest()
    throw error
  }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    removeAccepted!()
    removeRequest()
  }
}

/**
 * Pause only the Goal named by the review capability. This path flushes the
 * durable phase but never cancels an Agent, acquires maintenance, or sends any
 * model input.
 */
export async function pauseExpectedReviewGoal(
  ctx: Context,
  sessionId: string,
  expectedGoalRef: ReviewGoalRef | null,
  sourceTurn: number,
): Promise<ReviewGoalPauseResult> {
  validateGoalRef(expectedGoalRef)
  validateTurn(sourceTurn)
  const agent = resolveLocalAgent(ctx, sessionId)
  const current = ctx.goals.get(agent)
  const classified = classifyReviewGoal(current, expectedGoalRef)

  let outcome: ReviewGoalPauseResult['outcome']
  let ref = classified.ref
  if (classified.outcome === 'pause') {
    const exact = classified.ref!
    const paused = ctx.goals.pause(agent, {
      id: GoalId(exact.id),
      revision: exact.revision,
    })
    ref = plainGoalRef(paused)
    outcome = 'paused'
    await flushReviewSession(ctx, agent)
  } else {
    outcome = classified.outcome
    // A prior mutation can be visible in memory even when its first flush
    // failed. Re-flush the exact idempotent state before returning completed.
    if (outcome === 'already-applied') await flushReviewSession(ctx, agent)
  }

  assertStillLocal(ctx, agent)
  const observedTurn = outcome !== 'stale' && agent.status === 'running'
    ? observeOpenAgentTurn(agent)
    : undefined
  const turnOutcome = observedTurn === undefined
    ? 'stopped' as const
    : observedTurn === sourceTurn
      ? 'source-active' as const
      : 'user-override' as const
  return {
    outcome,
    ...(ref === undefined ? {} : { ref }),
    activeTurn: observedTurn !== undefined,
    ...(observedTurn === undefined ? {} : { observedTurn }),
    turnOutcome,
  }
}

type CapabilityDirection = 'request' | 'acceptedPause'

function authorizedCapability(
  control: IncomingControl,
  direction: CapabilityDirection,
  options: ReviewControlHandlersOptions,
): ReviewControlCapability | undefined {
  let capability: ReviewControlCapability
  try {
    const resolved = options.resolveCapability(control.controlId)
    if (resolved === undefined) return undefined
    capability = normalizeCapability(resolved)
  } catch (error) {
    // A shutdown/cancellation must leave the durable control retryable. Only
    // an ordinary resolver/validation failure is an authorization denial.
    options.signal?.throwIfAborted()
    if (error instanceof Error && error.name === 'AbortError') throw error
    return undefined
  }
  return matchesControl(control, capability, direction) ? capability : undefined
}

function matchesControl(
  control: IncomingControl,
  capability: ReviewControlCapability,
  direction: CapabilityDirection,
): boolean {
  const requestDirection = direction === 'request'
  const edge = requestDirection ? capability.request : capability.acceptedPause
  const kind = requestDirection ? REVIEW_REQUEST : REVIEW_ACCEPTED_PAUSE
  const senderSessionId = requestDirection
    ? capability.workerSessionId
    : capability.judgeSessionId
  const recipientSessionId = requestDirection
    ? capability.judgeSessionId
    : capability.workerSessionId
  const payload = requestDirection
    ? requestPayloadFrom(capability, capability.request.controlId)
    : acceptedPayloadFrom(
        capability,
        capability.acceptedPause.controlId,
        capability.request.controlId,
        capability.request.payloadHash,
      )

  try {
    return control.controlId === edge.controlId
      && control.kind === kind
      && control.payloadHash === edge.payloadHash
      && String(control.senderSessionId) === senderSessionId
      && String(control.senderPrincipalSessionId) === senderSessionId
      && String(control.recipientSessionId) === recipientSessionId
      && String(control.recipientPrincipalSessionId) === recipientSessionId
      && canonicalJson(control.payload) === canonicalJson(asJson(payload))
  } catch {
    return false
  }
}

function normalizeCapability(input: ReviewControlCapability): ReviewControlCapability {
  if (input === null || typeof input !== 'object') invalidCapability()
  const candidate = input as ReviewControlCapability
  const compiled = compileReviewControlCapability({
    reviewId: candidate.reviewId,
    assignmentId: candidate.assignmentId,
    configRevision: candidate.configRevision,
    runtimeRevision: candidate.runtimeRevision,
    ownerFence: candidate.ownerFence,
    workerRoleId: candidate.workerRoleId,
    workerSessionId: candidate.workerSessionId,
    judgeRoleId: candidate.judgeRoleId,
    judgeSessionId: candidate.judgeSessionId,
    packetHash: candidate.packetHash,
    artifactHash: candidate.artifactHash,
    negotiatedAnchorHash: candidate.negotiatedAnchorHash,
    sourceTurn: candidate.sourceTurn,
    expectedGoalRef: candidate.expectedGoalRef,
    requestControlId: candidate.request?.controlId,
    acceptedPauseControlId: candidate.acceptedPause?.controlId,
  })
  if (candidate.version !== 1
    || candidate.request?.payloadHash !== compiled.request.payloadHash
    || candidate.acceptedPause?.payloadHash !== compiled.acceptedPause.payloadHash) {
    invalidCapability()
  }
  return compiled
}

function requestPayloadFrom(
  capability: Omit<ReviewControlCapability, 'request' | 'acceptedPause'>,
  requestControlId: string,
): ReviewRequestPayload {
  return Object.freeze({
    version: 1,
    type: REVIEW_REQUEST,
    requestControlId,
    reviewId: capability.reviewId,
    assignmentId: capability.assignmentId,
    configRevision: capability.configRevision,
    runtimeRevision: capability.runtimeRevision,
    ownerFence: capability.ownerFence,
    sourceRoleId: capability.workerRoleId,
    sourceSessionId: capability.workerSessionId,
    targetRoleId: capability.judgeRoleId,
    targetSessionId: capability.judgeSessionId,
    packetHash: capability.packetHash,
    artifactHash: capability.artifactHash,
    negotiatedAnchorHash: capability.negotiatedAnchorHash,
    sourceTurn: capability.sourceTurn,
    expectedGoalRef: freezeGoalRef(capability.expectedGoalRef),
  })
}

function acceptedPayloadFrom(
  capability: Omit<ReviewControlCapability, 'request' | 'acceptedPause'>,
  acceptedPauseControlId: string,
  requestControlId: string,
  requestPayloadHash: string,
): ReviewAcceptedPausePayload {
  return Object.freeze({
    version: 1,
    type: REVIEW_ACCEPTED_PAUSE,
    acceptedPauseControlId,
    requestControlId,
    requestPayloadHash,
    reviewId: capability.reviewId,
    assignmentId: capability.assignmentId,
    configRevision: capability.configRevision,
    runtimeRevision: capability.runtimeRevision,
    ownerFence: capability.ownerFence,
    sourceRoleId: capability.judgeRoleId,
    sourceSessionId: capability.judgeSessionId,
    targetRoleId: capability.workerRoleId,
    targetSessionId: capability.workerSessionId,
    packetHash: capability.packetHash,
    artifactHash: capability.artifactHash,
    negotiatedAnchorHash: capability.negotiatedAnchorHash,
    sourceTurn: capability.sourceTurn,
    expectedGoalRef: freezeGoalRef(capability.expectedGoalRef),
    acknowledgement: REVIEW_ACCEPTED_TEXT,
    goalAction: 'pause',
  })
}

export function reviewJudgeStart(capabilityInput: ReviewControlCapability): ReviewJudgeStart {
  const capability = normalizeCapability(capabilityInput)
  return Object.freeze({
    // The review and both transport control identities survive Controller
    // owner-fence renewal unchanged.
    wakeId: capability.reviewId,
    reviewId: capability.reviewId,
    assignmentId: capability.assignmentId,
    judgeSessionId: capability.judgeSessionId,
    workerSessionId: capability.workerSessionId,
    configRevision: capability.configRevision,
    runtimeRevision: capability.runtimeRevision,
    ownerFence: capability.ownerFence,
    packetHash: capability.packetHash,
    artifactHash: capability.artifactHash,
    negotiatedAnchorHash: capability.negotiatedAnchorHash,
  })
}

function classifyReviewGoal(
  current: GoalView | undefined,
  expected: ReviewGoalRef | null,
): {
  readonly outcome: 'pause' | 'already-applied' | 'no-active-goal' | 'stale'
  readonly ref?: ReviewGoalRef
} {
  if (current === undefined) return { outcome: 'no-active-goal' }
  const ref = plainGoalRef(current)

  if (expected === null) {
    return current.phase === 'complete'
      ? { outcome: 'no-active-goal', ref }
      : { outcome: 'stale', ref }
  }
  if (String(current.id) !== expected.id) return { outcome: 'stale', ref }

  if (current.phase === 'active') {
    return current.revision === expected.revision
      ? { outcome: 'pause', ref }
      : { outcome: 'stale', ref }
  }
  if (current.phase === 'paused') {
    return current.revision === expected.revision
      || current.revision === expected.revision + 1
      ? { outcome: 'already-applied', ref }
      : { outcome: 'stale', ref }
  }
  return current.revision >= expected.revision
    ? { outcome: 'no-active-goal', ref }
    : { outcome: 'stale', ref }
}

function resolveLocalAgent(ctx: Context, rawSessionId: string): Agent {
  const agent = ctx.agents.get(SessionId(rawSessionId))
  if (agent === undefined) {
    throw new ReviewProtocolError(
      `Session ${JSON.stringify(rawSessionId)} is not a live Agent in this process`,
      'SESSION_NOT_LOCAL',
    )
  }
  return agent
}

function assertStillLocal(ctx: Context, agent: Agent): void {
  if (ctx.agents.get(agent.id) !== agent) {
    throw new ReviewProtocolError(
      `Session ${JSON.stringify(String(agent.id))} is no longer local`,
      'SESSION_NOT_LOCAL',
    )
  }
}

async function flushReviewSession(ctx: Context, agent: Agent): Promise<void> {
  if (!await ctx.sessions.flush(agent.session)) {
    throw new ReviewProtocolError(
      `Session ${JSON.stringify(String(agent.id))} has no durability listener`,
      'DURABILITY_UNAVAILABLE',
    )
  }
}

function validateCapabilityInput(input: ReviewControlCapabilityInput): void {
  if (!nonEmpty(input.reviewId)
    || !nonEmpty(input.assignmentId)
    || !Number.isSafeInteger(input.configRevision)
    || input.configRevision <= 0
    || !Number.isSafeInteger(input.runtimeRevision)
    || input.runtimeRevision < 0
    || !UUID_PATTERN.test(input.ownerFence)
    || !nonEmpty(input.workerRoleId)
    || !nonEmpty(input.workerSessionId)
    || !nonEmpty(input.judgeRoleId)
    || !nonEmpty(input.judgeSessionId)
    || input.workerSessionId === input.judgeSessionId
    || !SHA256_PATTERN.test(input.packetHash)
    || !SHA256_PATTERN.test(input.artifactHash)
    || !SHA256_PATTERN.test(input.negotiatedAnchorHash)
    || !Number.isSafeInteger(input.sourceTurn)
    || input.sourceTurn <= 0
    || !UUID_PATTERN.test(input.requestControlId)
    || !UUID_PATTERN.test(input.acceptedPauseControlId)
    || input.requestControlId === input.acceptedPauseControlId) {
    invalidCapability()
  }
  validateGoalRef(input.expectedGoalRef)
}

function validateTurn(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) invalidCapability()
}

function validateGoalRef(value: unknown): asserts value is ReviewGoalRef | null {
  if (value === null) return
  if (typeof value !== 'object'
    || Array.isArray(value)
    || !nonEmpty((value as Partial<ReviewGoalRef>).id)
    || !Number.isSafeInteger((value as Partial<ReviewGoalRef>).revision)
    || (value as Partial<ReviewGoalRef>).revision! <= 0) {
    invalidCapability()
  }
}

function freezeGoalRef(value: ReviewGoalRef | null): ReviewGoalRef | null {
  validateGoalRef(value)
  return value === null ? null : Object.freeze({ id: value.id, revision: value.revision })
}

function plainGoalRef(goal: GoalView): ReviewGoalRef {
  return { id: String(goal.id), revision: goal.revision }
}

function invalidCapability(): never {
  throw new ReviewProtocolError('invalid or altered review control capability', 'INVALID_CAPABILITY')
}

function capabilityRejected(): ControlHandlerDecision {
  return {
    status: 'rejected',
    detail: 'review capability is absent, stale, or does not match the envelope',
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0')
}

function asJson(value: unknown): JsonValue {
  return value as JsonValue
}
