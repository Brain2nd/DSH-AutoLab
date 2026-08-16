/**
 * One real Node-process endpoint for provider-process-smoke.mjs.
 * It imports the built provider and exposes only test control over IPC.
 */
import { Context } from '@deepseek-ai/cordis'
import TimerService from '@deepseek-ai/cordis-plugin-timer'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import {
  LlmAdapter,
} from '@deepseek-ai/dsh-llm'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionTitleService from '@deepseek-ai/dsh-session-title'

import LocalSessionMessaging from '../../lib/local.js'
import { controlPayloadHash } from '../../lib/service.js'

const PROVIDER = 'process-smoke'
const MODEL = 'deterministic'

class FixtureSessionQuery extends SessionQueryEngine {
  async searchSessions() {
    throw new Error('provider smoke does not perform full-text session search')
  }

  async searchEvents() {
    throw new Error('provider smoke does not perform full-text event search')
  }
}

class ImmediateAdapter extends LlmAdapter {
  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options) {
    options.signal?.throwIfAborted()
    const text = `processed by ${String(options.sessionId)}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const sessionId = SessionId(requiredEnv('FIXTURE_SESSION_ID'))
const mailboxRoot = requiredEnv('FIXTURE_MAILBOX_ROOT')
const label = requiredEnv('FIXTURE_LABEL')
const ctx = new Context()
let handle
let closing = false
const statusReceipts = []
const controlReceipts = []
const handledControls = []
const writerReservations = new Map()

function requiredEnv(name) {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`)
  return value
}

function sendIpc(value) {
  if (process.connected) process.send(value)
}

function plainError(error) {
  const cause = error instanceof Error ? error.cause : undefined
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
    ...(error !== null && typeof error === 'object' && typeof error.code === 'string'
      ? { code: error.code }
      : {}),
    ...(cause instanceof Error
      ? {
          cause: {
            name: cause.name,
            message: cause.message,
            stack: cause.stack,
            ...(typeof cause.code === 'string' ? { code: cause.code } : {}),
          },
        }
      : {}),
  }
}

function relaySnapshot() {
  const agent = handle.agent
  return agent.session.events.flatMap(event => {
    if (event.type !== 'user/message' || event.data.source.kind !== 'local-session-relay') return []
    const textBlocks = event.data.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
    return [{
      messageId: String(event.data.id),
      seq: event.seq,
      senderSessionId: String(event.data.source.senderSessionId),
      replySessionId: String(event.data.source.replySessionId),
      senderName: event.data.source.senderName,
      envelopeId: event.data.source.envelopeId,
      attribution: textBlocks[0],
      text: textBlocks.at(-1),
    }]
  })
}

async function dispatch(message) {
  const agent = handle.agent
  switch (message.op) {
    case 'listPeers':
      return ctx.sessionMessaging.listPeers(agent)
    case 'send':
      return ctx.sessionMessaging.send(agent, {
        recipient: message.recipient,
        text: message.text,
      })
    case 'getMessage':
      return ctx.sessionMessaging.getMessage(agent, message.messageId)
    case 'sendControl':
      return ctx.sessionMessaging.sendControl(agent, {
        controlId: message.controlId,
        recipient: message.recipient,
        kind: message.kind,
        payload: message.payload,
        payloadHash: controlPayloadHash(message.payload),
      })
    case 'getControl':
      return ctx.sessionMessaging.getControl(agent, message.controlId)
    case 'reserveWriter': {
      const writerSessionId = SessionId(message.sessionId)
      if (writerReservations.has(String(writerSessionId))) {
        throw new Error(`writer ${String(writerSessionId)} is already reserved by this fixture`)
      }
      const lease = await ctx.sessionMessaging.reserveSessionWriter(writerSessionId)
      writerReservations.set(String(writerSessionId), lease)
      return {
        sessionId: String(lease.sessionId),
        instanceId: lease.instanceId,
        ownerToken: lease.ownerToken,
        fenceToken: lease.fenceToken,
      }
    }
    case 'releaseWriter': {
      const lease = writerReservations.get(message.sessionId)
      if (lease === undefined) throw new Error(`writer ${message.sessionId} is not reserved`)
      await lease.release()
      writerReservations.delete(message.sessionId)
      return { released: true }
    }
    case 'blockPeer':
      return ctx.sessionMessaging.setPeerBlocked(
        agent,
        message.recipient,
        message.blocked,
      )
    case 'waitIdle':
      await agent.whenIdle()
      return { status: agent.status }
    case 'snapshot':
      return {
        sessionId: String(agent.id),
        status: agent.status,
        relays: relaySnapshot(),
        handledControls: [...handledControls],
        controlReceipts: [...controlReceipts],
        statusReceipts: [...statusReceipts],
        turns: agent.session.events.filter(event => event.type === 'turn/start').length,
      }
    case 'shutdown':
      closing = true
      await handle.dispose()
      await ctx.fiber.dispose()
      return { closed: true }
    default:
      throw new Error(`unknown worker operation: ${String(message.op)}`)
  }
}

async function start() {
  await ctx.plugin(TimerService)
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: '' } })
  await ctx.plugin(FixtureSessionQuery)
  await ctx.plugin(SessionTitleService, {
    fallbackMaxWords: 8,
    fallbackMaxBytes: 128,
    maxTitleBytes: 256,
  })
  // The smoke fixture is a durability participant: provider admission must
  // cross the real SessionStore.flush() boundary even though this disposable
  // process does not need a disk transcript.
  ctx.on('session/flush', async () => undefined)
  ctx.llm.registerAdapter([PROVIDER], new ImmediateAdapter())
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSessionMessaging, {
    root: mailboxRoot,
    heartbeatIntervalMs: 100,
    presenceTtlMs: 1_000,
    pollIntervalMs: 50,
    deliveryLeaseMs: 1_000,
    retryBaseMs: 10,
    retryMaxMs: 100,
    ackWaitMs: 2_000,
    ackPollMs: 10,
    socketTimeoutMs: 250,
  })
  ctx.sessionMessaging.registerControlHandler('smoke.control', {
    authorize: control => control.recipientSessionId === sessionId,
    handle: control => {
      handledControls.push({
        controlId: control.controlId,
        senderSessionId: String(control.senderSessionId),
        payload: control.payload,
      })
      return { status: 'completed', result: { handledBy: String(sessionId) } }
    },
  })
  ctx.on('session-messaging/message-status', receipt => {
    statusReceipts.push({
      messageId: String(receipt.messageId),
      status: receipt.status,
      ...(receipt.acceptedAt === undefined ? {} : { acceptedAt: receipt.acceptedAt }),
      ...(receipt.claimedAt === undefined ? {} : { claimedAt: receipt.claimedAt }),
    })
  })
  ctx.on('session-messaging/control-status', receipt => {
    controlReceipts.push({
      controlId: receipt.controlId,
      status: receipt.status,
      outcome: receipt.outcome,
    })
  })
  handle = await ctx.agents.create({
    sessionId,
    meta: { cwd: process.cwd() },
    agentOptions: { provider: PROVIDER, model: MODEL },
  })
  sendIpc({ type: 'ready', label, sessionId: String(sessionId), pid: process.pid })
}

process.on('message', message => {
  if (closing || message === null || typeof message !== 'object') return
  void dispatch(message).then(
    value => {
      sendIpc({ type: 'response', requestId: message.requestId, ok: true, value })
      if (message.op === 'shutdown') {
        process.disconnect()
      }
    },
    error => sendIpc({
      type: 'response',
      requestId: message.requestId,
      ok: false,
      error: plainError(error),
    }),
  )
})

process.on('disconnect', () => {
  if (!closing) {
    closing = true
    void handle?.dispose().finally(() => ctx.fiber.dispose())
  }
})

start().catch(error => {
  sendIpc({ type: 'fatal', error: plainError(error) })
  process.exitCode = 1
  process.disconnect()
})
