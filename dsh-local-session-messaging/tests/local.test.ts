import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import TimerService from '@deepseek-ai/cordis-plugin-timer'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { freezeMessage, MessageId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import { describe, expect, it, vi } from 'vitest'

import LocalSessionMessaging from '../src/local.js'
import { MessagingDatabase } from '../src/database.js'
import {
  controlPayloadHash,
  type ControlReceipt,
  type PeerMessageReceipt,
} from '../src/service.js'

function secureRoot(prefix = 'dsh-local-provider-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  chmodSync(root, 0o700)
  return root
}

function withTimeout<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for provider status')), timeoutMs)
    timer.unref()
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

async function mountProvider(
  ctx: Context,
  root: string,
  ackWaitMs = 250,
  pollIntervalMs = 50,
  readTitleSnapshots: Context['sessionQuery']['readTitleSnapshots'] = () => Promise.resolve([]),
): Promise<void> {
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: '' } })
  await ctx.plugin(TimerService)
  ctx.provide('sessionQuery', {
    readTitleSnapshots,
  })
  await ctx.plugin(SessionTitleService, {
    fallbackMaxWords: 8,
    fallbackMaxBytes: 128,
    maxTitleBytes: 256,
  })
  await ctx.plugin(LocalSessionMessaging, {
    root,
    heartbeatIntervalMs: 50,
    presenceTtlMs: 250,
    pollIntervalMs,
    deliveryLeaseMs: 250,
    ackWaitMs,
    ackPollMs: 5,
  })
  await ctx.plugin(AgentLoop, { agents: [] })
}

describe('LocalSessionMessaging rc.6 provider boundary', () => {
  it('fences a second live provider and advances the epoch after exact release', async () => {
    const root = secureRoot()
    const firstCtx = new Context()
    const secondCtx = new Context()
    const sessionId = SessionId('writer-two-provider-session')
    let firstLease: Awaited<ReturnType<typeof firstCtx.sessionMessaging.reserveSessionWriter>> | undefined
    let secondLease: Awaited<ReturnType<typeof secondCtx.sessionMessaging.reserveSessionWriter>> | undefined

    try {
      await mountProvider(firstCtx, root)
      await mountProvider(secondCtx, root)

      firstLease = await firstCtx.sessionMessaging.reserveSessionWriter(sessionId)
      await expect(secondCtx.sessionMessaging.reserveSessionWriter(sessionId)).rejects.toMatchObject({
        code: 'SESSION_CONFLICT',
      })

      await firstLease.release()
      secondLease = await secondCtx.sessionMessaging.reserveSessionWriter(sessionId)
      expect(secondLease).toMatchObject({
        sessionId,
        fenceToken: firstLease.fenceToken + 1,
      })
      expect(secondLease.instanceId).not.toBe(firstLease.instanceId)
      expect(secondLease.ownerToken).not.toBe(firstLease.ownerToken)
    } finally {
      await firstLease?.release().catch(() => {})
      await secondLease?.release().catch(() => {})
      await Promise.allSettled([
        firstCtx.fiber.dispose(),
        secondCtx.fiber.dispose(),
      ])
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('shares one writer fence across reservations and releases only after Agent detach', async () => {
    const root = secureRoot()
    const ctx = new Context()
    const sessionId = SessionId('writer-shared-session')
    let firstLease: Awaited<ReturnType<typeof ctx.sessionMessaging.reserveSessionWriter>> | undefined
    let secondLease: Awaited<ReturnType<typeof ctx.sessionMessaging.reserveSessionWriter>> | undefined

    try {
      await mountProvider(ctx, root)
      firstLease = await ctx.sessionMessaging.reserveSessionWriter(sessionId)
      secondLease = await ctx.sessionMessaging.reserveSessionWriter(sessionId)
      expect(secondLease).toMatchObject({
        sessionId,
        instanceId: firstLease.instanceId,
        ownerToken: firstLease.ownerToken,
        fenceToken: firstLease.fenceToken,
      })

      const inspector = new MessagingDatabase({ path: join(root, 'mailbox.sqlite3') })
      try {
        expect(inspector.getSessionWriter(String(sessionId))).toMatchObject({
          active: true,
          instanceId: firstLease.instanceId,
          ownerToken: firstLease.ownerToken,
          fenceToken: firstLease.fenceToken,
        })

        const handle = await ctx.agents.create({ sessionId })
        await firstLease.release()
        await firstLease.release()
        expect(inspector.getSessionWriter(String(sessionId))?.active).toBe(true)

        await handle.dispose()
        expect(inspector.getSessionWriter(String(sessionId))?.active).toBe(true)
        await secondLease.release()
        await secondLease.release()
        expect(inspector.getSessionWriter(String(sessionId))).toMatchObject({
          active: false,
          fenceToken: firstLease.fenceToken,
        })
      } finally {
        inspector.close()
      }
    } finally {
      await firstLease?.release().catch(() => {})
      await secondLease?.release().catch(() => {})
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps the writer fenced until the disposed Agent Session flush completes', async () => {
    const root = secureRoot()
    const firstCtx = new Context()
    const secondCtx = new Context()
    const sessionId = SessionId('writer-flush-barrier-session')
    const flushEntered = Promise.withResolvers<void>()
    const allowFlush = Promise.withResolvers<void>()
    let lease: Awaited<ReturnType<typeof firstCtx.sessionMessaging.reserveSessionWriter>> | undefined
    let recovered: Awaited<ReturnType<typeof secondCtx.sessionMessaging.reserveSessionWriter>> | undefined

    try {
      await mountProvider(firstCtx, root)
      await mountProvider(secondCtx, root)
      lease = await firstCtx.sessionMessaging.reserveSessionWriter(sessionId)
      const handle = await firstCtx.agents.create({ sessionId })
      firstCtx.on('session/flush', async (session) => {
        if (session.id !== sessionId) return
        flushEntered.resolve()
        await allowFlush.promise
      })

      const disposal = handle.dispose()
      await flushEntered.promise
      const reservationRelease = lease.release()

      const inspector = new MessagingDatabase({ path: join(root, 'mailbox.sqlite3') })
      try {
        expect(inspector.getSessionWriter(String(sessionId))?.active).toBe(true)
        await expect(secondCtx.sessionMessaging.reserveSessionWriter(sessionId)).rejects.toMatchObject({
          code: 'SESSION_CONFLICT',
        })

        allowFlush.resolve()
        await Promise.all([disposal, reservationRelease])
        expect(inspector.getSessionWriter(String(sessionId))?.active).toBe(false)

        recovered = await secondCtx.sessionMessaging.reserveSessionWriter(sessionId)
        expect(recovered.fenceToken).toBe(lease.fenceToken + 1)
      } finally {
        inspector.close()
      }
    } finally {
      allowFlush.resolve()
      await lease?.release().catch(() => {})
      await recovered?.release().catch(() => {})
      await Promise.allSettled([
        firstCtx.fiber.dispose(),
        secondCtx.fiber.dispose(),
      ])
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('never force-releases an outstanding writer reservation during provider teardown', async () => {
    const root = secureRoot()
    const ctx = new Context()
    const sessionId = SessionId('writer-provider-teardown-session')
    let lease: Awaited<ReturnType<typeof ctx.sessionMessaging.reserveSessionWriter>> | undefined

    try {
      await mountProvider(ctx, root)
      lease = await ctx.sessionMessaging.reserveSessionWriter(sessionId)
      const inspector = new MessagingDatabase({ path: join(root, 'mailbox.sqlite3') })
      try {
        await ctx.fiber.dispose()
        expect(inspector.getSessionWriter(String(sessionId))).toMatchObject({
          active: true,
          instanceId: lease.instanceId,
          ownerToken: lease.ownerToken,
          fenceToken: lease.fenceToken,
        })
        await lease.release()
        expect(inspector.getSessionWriter(String(sessionId))?.active).toBe(true)
      } finally {
        inspector.close()
      }
    } finally {
      await lease?.release().catch(() => {})
      await ctx.fiber.dispose().catch(() => {})
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('takes over only when PID/start/boot identity mechanically proves the old writer dead', async () => {
    const root = secureRoot()
    const ctx = new Context()
    const liveSessionId = SessionId('writer-live-conflict')
    const staleSessionId = SessionId('writer-stale-owner')
    let staleLease: Awaited<ReturnType<typeof ctx.sessionMessaging.reserveSessionWriter>> | undefined

    try {
      await mountProvider(ctx, root)
      const probe = await ctx.sessionMessaging.reserveSessionWriter(SessionId('writer-identity-probe'))
      const inspector = new MessagingDatabase({ path: join(root, 'mailbox.sqlite3') })
      try {
        const identity = inspector.getSessionWriter('writer-identity-probe')!
        await probe.release()

        inspector.acquireSessionWriter({
          sessionId: String(liveSessionId),
          instanceId: 'old-live-instance',
          ownerToken: '00000000-0000-4000-8000-000000000901',
          pid: identity.pid,
          processStartId: identity.processStartId,
          hostname: identity.hostname,
          bootId: identity.bootId,
        })
        await expect(ctx.sessionMessaging.reserveSessionWriter(liveSessionId)).rejects.toMatchObject({
          code: 'SESSION_CONFLICT',
        })

        inspector.acquireSessionWriter({
          sessionId: String(staleSessionId),
          instanceId: 'old-reused-pid-instance',
          ownerToken: '00000000-0000-4000-8000-000000000902',
          pid: identity.pid,
          processStartId: `${identity.processStartId}-old`,
          hostname: identity.hostname,
          bootId: identity.bootId,
        })
        staleLease = await ctx.sessionMessaging.reserveSessionWriter(staleSessionId)
        expect(inspector.getSessionWriter(String(staleSessionId))).toMatchObject({
          active: true,
          instanceId: staleLease.instanceId,
          ownerToken: staleLease.ownerToken,
          fenceToken: 2,
        })
      } finally {
        inspector.close()
      }
    } finally {
      await staleLease?.release().catch(() => {})
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('queries titles only for disconnected name projection and skips exact-id routing', async () => {
    const root = secureRoot()
    const ctx = new Context()
    const readTitleSnapshots = vi.fn(async (_ids: readonly SessionId[]) => [])

    try {
      await mountProvider(ctx, root, 250, 50, readTitleSnapshots)
      const senderHandle = await ctx.agents.create({
        sessionId: SessionId('projection-sender'),
      })
      const receiverHandle = await ctx.agents.create({
        sessionId: SessionId('projection-receiver'),
      })
      const receiverId = receiverHandle.agent.id

      await ctx.sessionMessaging.listPeers(senderHandle.agent)
      expect(readTitleSnapshots).not.toHaveBeenCalled()

      await receiverHandle.dispose()
      await expect(ctx.sessionMessaging.listPeers(senderHandle.agent)).resolves.toEqual([
        expect.objectContaining({
          sessionId: receiverId,
          name: 'session-receiver',
          connection: 'disconnected',
        }),
      ])
      expect(readTitleSnapshots).toHaveBeenCalledWith([receiverId], undefined)

      readTitleSnapshots.mockClear()
      await expect(ctx.sessionMessaging.send(senderHandle.agent, {
        recipient: String(receiverId),
        text: 'exact id skips title projection',
      })).resolves.toMatchObject({
        recipientSessionId: receiverId,
        recipientName: 'session-receiver',
        status: 'queued',
      })
      await expect(ctx.sessionMessaging.setPeerBlocked(
        senderHandle.agent,
        String(receiverId),
        true,
      )).resolves.toMatchObject({
        sessionId: receiverId,
        name: 'session-receiver',
      })
      expect(readTitleSnapshots).not.toHaveBeenCalled()

      await ctx.sessionMessaging.setPeerBlocked(
        senderHandle.agent,
        'session-receiver',
        false,
      )
      expect(readTitleSnapshots).toHaveBeenCalledWith([receiverId], undefined)
    } finally {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses a short owner-only notifier path when the configured state root exceeds the UDS budget', async () => {
    const root = secureRoot(`dsh-${'x'.repeat(90)}-`)
    const ctx = new Context()
    let fallbackDirectory: string | undefined

    try {
      await mountProvider(ctx, root)
      const handle = await ctx.agents.create({
        sessionId: SessionId('long-root-receiver'),
      })
      const inspector = new MessagingDatabase({ path: join(root, 'mailbox.sqlite3') })
      try {
        const endpoint = inspector.getPresence(String(handle.agent.id))?.endpoint?.socketPath
        expect(endpoint).toBeDefined()
        expect(Buffer.byteLength(endpoint!, 'utf8')).toBeLessThanOrEqual(
          process.platform === 'darwin' ? 103 : 107,
        )
        expect(endpoint!.startsWith(join(root, 'sockets'))).toBe(false)
        fallbackDirectory = dirname(endpoint!)
        expect(statSync(fallbackDirectory).mode & 0o777).toBe(0o700)
      } finally {
        inspector.close()
      }
    } finally {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
      if (fallbackDirectory !== undefined
        && basename(fallbackDirectory).startsWith('dsh-lsm-')) {
        rmSync(fallbackDirectory, { recursive: true, force: true })
      }
    }
  })

  it('keeps a committed envelope queued when an advertised remote poke endpoint is unavailable', async () => {
    const root = secureRoot()
    const ctx = new Context()
    let inspector: MessagingDatabase | undefined

    try {
      await mountProvider(ctx, root, 20)
      const senderHandle = await ctx.agents.create({
        sessionId: SessionId('poke-loss-sender'),
      })
      inspector = new MessagingDatabase({ path: join(root, 'mailbox.sqlite3') })
      inspector.upsertPresence({
        sessionId: 'poke-loss-remote',
        instanceId: 'remote-instance',
        endpoint: { socketPath: join(root, 'missing-remote.sock') },
        agentStatus: 'idle',
        leaseMs: 2_000,
      })

      const receipt = await ctx.sessionMessaging.send(senderHandle.agent, {
        recipient: 'poke-loss-remote',
        text: 'polling, not the lossy poke, owns eventual progress',
      })

      expect(receipt).toMatchObject({
        recipientSessionId: 'poke-loss-remote',
        status: 'queued',
      })
      expect(inspector.getMessage(String(receipt.messageId))).toMatchObject({
        status: 'queued',
        recipientSessionId: 'poke-loss-remote',
      })
    } finally {
      inspector?.close()
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('recovers a flushed queued relay before TTL and max-attempt terminalization', async () => {
    const root = secureRoot()
    const ctx = new Context()
    const releaseMaintenance = Promise.withResolvers<void>()
    const accepted = Promise.withResolvers<PeerMessageReceipt>()
    const messageId = '00000000-0000-4000-8000-000000000101'
    let inspector: MessagingDatabase | undefined

    try {
      await mountProvider(ctx, root, 250, 250)
      ctx.on('session/flush', () => undefined)
      ctx.on('session-messaging/message-status', receipt => {
        if (String(receipt.messageId) === messageId && receipt.status === 'accepted') {
          accepted.resolve(receipt)
        }
      })
      const senderHandle = await ctx.agents.create({
        sessionId: SessionId('crash-gap-sender'),
      })
      const receiverHandle = await ctx.agents.create({
        sessionId: SessionId('crash-gap-receiver'),
        setup(agentCtx) {
          agentCtx.on('agent/pre-step', () => Promise.resolve({ kind: 'reject' }))
        },
      })
      const sender = senderHandle.agent
      const receiver = receiverHandle.agent
      const maintenance = receiver.runMaintenance(async () => releaseMaintenance.promise)

      inspector = new MessagingDatabase({ path: join(root, 'mailbox.sqlite3') })
      const presence = inspector.getPresence(String(receiver.id))
      expect(presence).toBeDefined()
      if (presence === undefined) throw new Error('receiver presence was not published')
      inspector.enqueue({
        messageId,
        senderSessionId: String(sender.id),
        recipientSessionId: String(receiver.id),
        senderPrincipalSessionId: String(sender.id),
        recipientPrincipalSessionId: String(receiver.id),
        deliveryMode: 'followup',
        payload: { version: 1, text: 'durable Inbox won before SQLite accept' },
        ttlMs: 100,
        maxAttempts: 1,
      })
      const lease = inspector.claimNextDelivery({
        sessionId: presence.sessionId,
        instanceId: presence.instanceId,
        fenceToken: presence.fenceToken,
        recipientSessionId: presence.sessionId,
        leaseMs: 250,
      })
      expect(lease?.message).toMatchObject({
        status: 'queued',
        attemptCount: 1,
        maxAttempts: 1,
      })

      receiver.inbox.append('next-turn', freezeMessage({
        id: MessageId(messageId),
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Local Session "session-p-sender" (crash-gap-sender) sent a message:\n\n',
          },
          { type: 'text', text: 'durable Inbox won before SQLite accept' },
        ],
        source: {
          kind: 'local-session-relay',
          form: 'relay',
          senderSessionId: sender.id,
          replySessionId: sender.id,
          senderName: 'session-p-sender',
          envelopeId: messageId,
        },
      }))
      await ctx.sessions.flush(receiver.session)
      await new Promise(resolve => setTimeout(resolve, 120))
      expect(Date.now()).toBeGreaterThanOrEqual(lease!.message.expiresAt)

      const recovered = await withTimeout(accepted.promise)
      expect(recovered).toMatchObject({
        messageId,
        status: 'accepted',
      })
      expect(recovered.acceptedAt).toBeDefined()
      const recoveredSnapshot = inspector.getMessage(messageId)
      expect(recoveredSnapshot).toMatchObject({
        status: 'accepted',
        attemptCount: 1,
        maxAttempts: 1,
      })
      expect(recoveredSnapshot).not.toHaveProperty('expiredAt')
      expect(recoveredSnapshot).not.toHaveProperty('failedAt')
      expect(receiver.inbox.nextTurn.map(message => String(message.id))).toEqual([messageId])

      releaseMaintenance.resolve()
      await maintenance
      await receiver.whenIdle()
    } finally {
      releaseMaintenance.resolve()
      inspector?.close()
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('records pending crash recovery as accepted before a revoked-policy discard', async () => {
    const root = secureRoot()
    const ctx = new Context()
    const releaseMaintenance = Promise.withResolvers<void>()
    const failed = Promise.withResolvers<PeerMessageReceipt>()
    const statuses: PeerMessageReceipt[] = []
    const messageId = '00000000-0000-4000-8000-000000000102'
    let inspector: MessagingDatabase | undefined

    try {
      await mountProvider(ctx, root)
      ctx.on('session/flush', () => undefined)
      ctx.on('session-messaging/message-status', receipt => {
        if (String(receipt.messageId) !== messageId) return
        statuses.push(receipt)
        if (receipt.status === 'failed') failed.resolve(receipt)
      })
      const senderHandle = await ctx.agents.create({
        sessionId: SessionId('crash-revoke-sender'),
      })
      const receiverHandle = await ctx.agents.create({
        sessionId: SessionId('crash-revoke-receiver'),
        setup(agentCtx) {
          agentCtx.on('agent/pre-step', () => Promise.resolve({ kind: 'reject' }))
        },
      })
      const sender = senderHandle.agent
      const receiver = receiverHandle.agent
      const maintenance = receiver.runMaintenance(async () => releaseMaintenance.promise)

      inspector = new MessagingDatabase({ path: join(root, 'mailbox.sqlite3') })
      const presence = inspector.getPresence(String(receiver.id))
      expect(presence).toBeDefined()
      if (presence === undefined) throw new Error('receiver presence was not published')
      inspector.enqueue({
        messageId,
        senderSessionId: String(sender.id),
        recipientSessionId: String(receiver.id),
        senderPrincipalSessionId: String(sender.id),
        recipientPrincipalSessionId: String(receiver.id),
        deliveryMode: 'followup',
        payload: { version: 1, text: 'accept this durable fact before revocation cleanup' },
        ttlMs: 10_000,
        maxAttempts: 1,
      })
      expect(inspector.claimNextDelivery({
        sessionId: presence.sessionId,
        instanceId: presence.instanceId,
        fenceToken: presence.fenceToken,
        recipientSessionId: presence.sessionId,
        leaseMs: 250,
      })).toBeDefined()
      receiver.inbox.append('next-turn', freezeMessage({
        id: MessageId(messageId),
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Local Session "session-e-sender" (crash-revoke-sender) sent a message:\n\n',
          },
          { type: 'text', text: 'accept this durable fact before revocation cleanup' },
        ],
        source: {
          kind: 'local-session-relay',
          form: 'relay',
          senderSessionId: sender.id,
          replySessionId: sender.id,
          senderName: 'session-e-sender',
          envelopeId: messageId,
        },
      }))
      await ctx.sessions.flush(receiver.session)
      inspector.setSessionPolicy({
        principalSessionId: String(receiver.id),
        receiveAllowed: false,
      })

      const finalReceipt = await withTimeout(failed.promise)
      expect(statuses.map(receipt => receipt.status)).toContain('accepted')
      expect(finalReceipt).toMatchObject({
        messageId,
        status: 'failed',
        failure: 'permission denied: policy changed before Inbox claim',
      })
      expect(finalReceipt.acceptedAt).toBeDefined()
      expect(receiver.inbox.hasPending).toBe(false)
      await expect(ctx.sessionMessaging.getMessage(sender, MessageId(messageId))).resolves.toMatchObject({
        status: 'failed',
        acceptedAt: finalReceipt.acceptedAt,
        failure: 'permission denied: policy changed before Inbox claim',
      })

      releaseMaintenance.resolve()
      await maintenance
      await receiver.whenIdle()
    } finally {
      releaseMaintenance.resolve()
      inspector?.close()
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('records claimed at agent/inbox/claimed even when pre-step rejects user/message', async () => {
    const root = secureRoot()
    const ctx = new Context()
    const claimed = Promise.withResolvers<PeerMessageReceipt>()

    try {
      await mountProvider(ctx, root)

      // `accepted` is a durability statement, so the provider must observe at
      // least one real DSH session/flush participant in this fixture.
      ctx.on('session/flush', () => undefined)
      ctx.on('session-messaging/message-status', receipt => {
        if (receipt.status === 'claimed') claimed.resolve(receipt)
      })
      // Delivery-status events are observations after durable mutations. A bad
      // observer must never turn a committed enqueue/ACK into a caller-visible
      // failure or feed back into retry control flow.
      ctx.on('session-messaging/message-status', () => {
        throw new Error('fixture status observer failed')
      })
      ctx.on('session-messaging/peers-changed', () => {
        throw new Error('fixture peer observer failed')
      })

      const senderHandle = await ctx.agents.create({
        sessionId: SessionId('provider-sender'),
      })
      const receiverHandle = await ctx.agents.create({
        sessionId: SessionId('provider-receiver'),
        setup(agentCtx) {
          agentCtx.on('agent/pre-step', () => Promise.resolve({ kind: 'reject' }))
        },
      })
      const receiver = receiverHandle.agent
      let inboxClaimed = 0
      receiver.ctx.on('agent/inbox/claimed', ({ message }) => {
        if (message.source.kind === 'local-session-relay') inboxClaimed += 1
      })

      const sent = await ctx.sessionMessaging.send(senderHandle.agent, {
        recipient: String(receiver.id),
        text: 'claim this relay without entering a model step',
      })
      await receiver.whenIdle()
      const finalReceipt = await withTimeout(claimed.promise)

      expect(finalReceipt).toMatchObject({
        messageId: sent.messageId,
        recipientSessionId: receiver.id,
        status: 'claimed',
      })
      expect(inboxClaimed).toBe(1)
      expect(receiver.inbox.hasPending).toBe(false)
      expect(receiver.session.events.some(event =>
        event.type === 'user/message' && event.data.id === sent.messageId,
      )).toBe(false)
      await expect(ctx.sessionMessaging.getMessage(
        senderHandle.agent,
        sent.messageId,
      )).resolves.toMatchObject({ status: 'claimed' })
    } finally {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('bounds same-process ACK waiting while a DSH Inbox flush is stalled', async () => {
    const root = secureRoot()
    const ctx = new Context()
    const flushEntered = Promise.withResolvers<void>()
    const releaseFlush = Promise.withResolvers<void>()
    const releaseMaintenance = Promise.withResolvers<void>()
    const accepted = Promise.withResolvers<PeerMessageReceipt>()

    try {
      await mountProvider(ctx, root, 40)
      const senderHandle = await ctx.agents.create({
        sessionId: SessionId('bounded-sender'),
      })
      ctx.sessionTitle.rename(senderHandle.agent.session, 'Bounded Sender')
      const receiverHandle = await ctx.agents.create({
        sessionId: SessionId('bounded-receiver'),
        setup(agentCtx) {
          agentCtx.on('agent/pre-step', () => Promise.resolve({ kind: 'reject' }))
        },
      })
      const receiver = receiverHandle.agent
      const maintenance = receiver.runMaintenance(async () => releaseMaintenance.promise)

      ctx.on('session/flush', async session => {
        if (session !== receiver.session
          || !session.events.some(event => event.type === 'agent/inbox/spliced'
            && event.data.inserted.some(message => message.source.kind === 'local-session-relay'))) {
          return
        }
        flushEntered.resolve()
        await releaseFlush.promise
      })
      ctx.on('session-messaging/message-status', receipt => {
        if (receipt.status === 'accepted' || receipt.status === 'claimed') accepted.resolve(receipt)
      })

      const sending = ctx.sessionMessaging.send(senderHandle.agent, {
        recipient: String(receiver.id),
        text: 'the sender must not inherit a stalled receiver flush',
      })
      await withTimeout(flushEntered.promise)
      const queued = await withTimeout(sending, 500)

      expect(queued.status).toBe('queued')
      expect(receiver.inbox.nextTurn).toHaveLength(1)
      expect(receiver.inbox.nextTurn[0]).toMatchObject({
        content: [
          {
            type: 'text',
            text: `Local Session "Bounded Sender" (${String(senderHandle.agent.id)}) sent a message:\n\n`,
          },
          { type: 'text', text: 'the sender must not inherit a stalled receiver flush' },
        ],
        source: {
          kind: 'local-session-relay',
          senderSessionId: senderHandle.agent.id,
          replySessionId: senderHandle.agent.id,
          senderName: 'Bounded Sender',
        },
      })

      releaseFlush.resolve()
      await expect(withTimeout(accepted.promise)).resolves.toMatchObject({
        messageId: queued.messageId,
        recipientSessionId: receiver.id,
      })

      releaseMaintenance.resolve()
      await maintenance
      await receiver.whenIdle()
    } finally {
      releaseFlush.resolve()
      releaseMaintenance.resolve()
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('consumes authorized typed controls without model admission and deduplicates outcomes', async () => {
    const root = secureRoot()
    const ctx = new Context()
    const handled = vi.fn(async () => ({
      status: 'completed' as const,
      result: { paused: true },
    }))

    try {
      await mountProvider(ctx, root)
      const senderHandle = await ctx.agents.create({
        sessionId: SessionId('control-sender'),
      })
      const receiverHandle = await ctx.agents.create({
        sessionId: SessionId('control-receiver'),
      })
      const sender = senderHandle.agent
      const receiver = receiverHandle.agent
      const unregister = ctx.sessionMessaging.registerControlHandler('test.pause', {
        authorize: control => control.senderPrincipalSessionId === sender.id
          && control.recipientSessionId === receiver.id,
        handle: handled,
      })

      // Pair isolation applies to free text, not registered mechanical control.
      await ctx.sessionMessaging.setPeerBlocked(sender, String(receiver.id), true)

      const controlId = '00000000-0000-4000-8000-000000000801'
      const payload = { assignment: 7, action: 'pause' } as const
      const payloadHash = controlPayloadHash(payload)
      const first = await ctx.sessionMessaging.sendControl(sender, {
        controlId,
        recipient: String(receiver.id),
        kind: 'test.pause',
        payload,
        payloadHash,
      })
      expect(first).toMatchObject({
        controlId,
        status: 'claimed',
        outcome: {
          status: 'completed',
          result: { paused: true },
        },
      })
      expect(handled).toHaveBeenCalledTimes(1)
      expect(receiver.inbox.hasPending).toBe(false)
      expect(receiver.session.events.some(event => event.type === 'user/message')).toBe(false)

      const duplicate = await ctx.sessionMessaging.sendControl(sender, {
        controlId,
        recipient: String(receiver.id),
        kind: 'test.pause',
        payload: { action: 'pause', assignment: 7 },
        payloadHash,
      })
      expect(duplicate).toEqual(first)
      expect(handled).toHaveBeenCalledTimes(1)

      await ctx.sessionMessaging.setPermissions(sender, { sendAllowed: false })
      await expect(ctx.sessionMessaging.sendControl(sender, {
        controlId: '00000000-0000-4000-8000-000000000805',
        recipient: String(receiver.id),
        kind: 'test.pause',
        payload,
        payloadHash,
      })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
      await ctx.sessionMessaging.setPermissions(sender, { sendAllowed: true })

      await ctx.sessionMessaging.setPermissions(receiver, { receiveAllowed: false })
      await expect(ctx.sessionMessaging.sendControl(sender, {
        controlId: '00000000-0000-4000-8000-000000000806',
        recipient: String(receiver.id),
        kind: 'test.pause',
        payload,
        payloadHash,
      })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
      await ctx.sessionMessaging.setPermissions(receiver, { receiveAllowed: true })

      await expect(ctx.sessionMessaging.sendControl(sender, {
        controlId: '00000000-0000-4000-8000-000000000802',
        recipient: String(receiver.id),
        kind: 'test.pause',
        payload,
        payloadHash: `sha256:${'0'.repeat(64)}`,
      })).rejects.toMatchObject({ code: 'INVALID_MESSAGE' })

      unregister()
      const replayed = Promise.withResolvers<ControlReceipt>()
      const replayedHandler = vi.fn(() => ({
        status: 'completed' as const,
        result: { resumed: true },
      }))
      ctx.on('session-messaging/control-status', receipt => {
        if (receipt.controlId === '00000000-0000-4000-8000-000000000803'
          && receipt.outcome?.status === 'completed') replayed.resolve(receipt)
      })
      const retiredPayload = { assignment: 8 }
      const retired = await ctx.sessionMessaging.sendControl(sender, {
        controlId: '00000000-0000-4000-8000-000000000803',
        recipient: String(receiver.id),
        kind: 'test.pause',
        payload: retiredPayload,
        payloadHash: controlPayloadHash(retiredPayload),
        waitForAcknowledgement: false,
      })
      expect(retired).toMatchObject({
        status: 'queued',
      })
      expect(retired).not.toHaveProperty('outcome')

      ctx.sessionMessaging.registerControlHandler('test.pause', {
        authorize: control => control.senderPrincipalSessionId === sender.id
          && control.recipientSessionId === receiver.id,
        handle: replayedHandler,
      })
      await expect(withTimeout(replayed.promise)).resolves.toMatchObject({
        status: 'claimed',
        outcome: {
          status: 'completed',
          result: { resumed: true },
        },
      })
      expect(replayedHandler).toHaveBeenCalledTimes(1)

      const unknownPayload = { assignment: 9 }
      const denied = await ctx.sessionMessaging.sendControl(sender, {
        controlId: '00000000-0000-4000-8000-000000000809',
        recipient: String(receiver.id),
        kind: 'test.unknown',
        payload: unknownPayload,
        payloadHash: controlPayloadHash(unknownPayload),
      })
      expect(denied).toMatchObject({
        status: 'claimed',
        outcome: {
          status: 'rejected',
          detail: 'no explicit control handler is registered',
        },
      })
      expect(receiver.inbox.hasPending).toBe(false)
    } finally {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('can return after durable control enqueue without serializing independent receiver work', async () => {
    const root = secureRoot()
    const ctx = new Context()
    const release = Promise.withResolvers<void>()
    const completed = Promise.withResolvers<ControlReceipt>()
    const controlId = '00000000-0000-4000-8000-000000000807'

    try {
      await mountProvider(ctx, root, 10_000)
      const sender = (await ctx.agents.create({
        sessionId: SessionId('control-no-wait-sender'),
      })).agent
      const receiver = (await ctx.agents.create({
        sessionId: SessionId('control-no-wait-receiver'),
      })).agent
      ctx.sessionMessaging.registerControlHandler('test.no-wait', {
        authorize: () => true,
        handle: async () => {
          await release.promise
          return { status: 'completed', result: { released: true } }
        },
      })
      ctx.on('session-messaging/control-status', receipt => {
        if (receipt.controlId === controlId && receipt.outcome?.status === 'completed') {
          completed.resolve(receipt)
        }
      })

      const payload = { boundary: 'durable-enqueue' }
      const enqueued = await ctx.sessionMessaging.sendControl(sender, {
        controlId,
        recipient: String(receiver.id),
        kind: 'test.no-wait',
        payload,
        payloadHash: controlPayloadHash(payload),
        waitForAcknowledgement: false,
      })
      expect(enqueued).toMatchObject({ controlId, status: 'queued' })

      release.resolve()
      await expect(withTimeout(completed.promise)).resolves.toMatchObject({
        controlId,
        status: 'claimed',
        outcome: { status: 'completed', result: { released: true } },
      })
    } finally {
      release.resolve()
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('delivers an offline typed control after the same Session reconnects', async () => {
    const root = secureRoot()
    const ctx = new Context()
    const completed = Promise.withResolvers<ControlReceipt>()
    const controlId = '00000000-0000-4000-8000-000000000804'

    try {
      await mountProvider(ctx, root, 20)
      const senderHandle = await ctx.agents.create({
        sessionId: SessionId('control-reconnect-sender'),
      })
      const receiverHandle = await ctx.agents.create({
        sessionId: SessionId('control-reconnect-receiver'),
      })
      const receiverId = receiverHandle.agent.id
      ctx.sessionMessaging.registerControlHandler('test.reconnect', {
        authorize: control => control.recipientSessionId === receiverId,
        handle: () => ({ status: 'completed', result: { restored: true } }),
      })
      ctx.on('session-messaging/control-status', receipt => {
        if (receipt.controlId === controlId && receipt.outcome?.status === 'completed') {
          completed.resolve(receipt)
        }
      })
      await receiverHandle.dispose()

      const payload = { sequence: 1 }
      const queued = await ctx.sessionMessaging.sendControl(senderHandle.agent, {
        controlId,
        recipient: String(receiverId),
        kind: 'test.reconnect',
        payload,
        payloadHash: controlPayloadHash(payload),
      })
      expect(queued.status).toBe('queued')

      const resumed = await ctx.agents.create({ sessionId: receiverId })
      const finalReceipt = await withTimeout(completed.promise)
      expect(finalReceipt).toMatchObject({
        controlId,
        status: 'claimed',
        outcome: { status: 'completed', result: { restored: true } },
      })
      expect(resumed.agent.inbox.hasPending).toBe(false)
      expect(resumed.agent.session.events.some(event => event.type === 'user/message')).toBe(false)
      await expect(ctx.sessionMessaging.getControl(
        senderHandle.agent,
        controlId,
      )).resolves.toEqual(finalReceipt)
    } finally {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('persistently rejects a queued control when a global direction is revoked', async () => {
    const root = secureRoot()
    const ctx = new Context()
    const rejected = Promise.withResolvers<ControlReceipt>()
    const authorize = vi.fn(() => true)
    const handle = vi.fn(() => ({ status: 'completed' as const }))
    const controlId = '00000000-0000-4000-8000-000000000807'

    try {
      await mountProvider(ctx, root, 20)
      const senderHandle = await ctx.agents.create({
        sessionId: SessionId('control-revoked-sender'),
      })
      const receiverHandle = await ctx.agents.create({
        sessionId: SessionId('control-revoked-receiver'),
      })
      const sender = senderHandle.agent
      const receiverId = receiverHandle.agent.id
      ctx.sessionMessaging.registerControlHandler('test.revoked', { authorize, handle })
      ctx.on('session-messaging/control-status', receipt => {
        if (receipt.controlId === controlId && receipt.outcome?.status === 'rejected') {
          rejected.resolve(receipt)
        }
      })
      await receiverHandle.dispose()

      const payload = { assignment: 11 }
      await expect(ctx.sessionMessaging.sendControl(sender, {
        controlId,
        recipient: String(receiverId),
        kind: 'test.revoked',
        payload,
        payloadHash: controlPayloadHash(payload),
      })).resolves.toMatchObject({ status: 'queued' })

      await ctx.sessionMessaging.setPermissions(sender, { sendAllowed: false })
      const stillQueued = await ctx.sessionMessaging.getControl(sender, controlId)
      expect(stillQueued).toMatchObject({ status: 'queued' })
      expect(stillQueued).not.toHaveProperty('outcome')

      const resumed = await ctx.agents.create({ sessionId: receiverId })
      const outcome = await withTimeout(rejected.promise)
      expect(outcome).toMatchObject({
        controlId,
        status: 'claimed',
        outcome: {
          status: 'rejected',
          detail: 'control rejected: sender send or recipient receive is disabled',
        },
      })
      expect(authorize).not.toHaveBeenCalled()
      expect(handle).not.toHaveBeenCalled()
      expect(resumed.agent.inbox.hasPending).toBe(false)
      expect(resumed.agent.session.events.some(event => event.type === 'user/message')).toBe(false)
      await expect(ctx.sessionMessaging.getControl(sender, controlId)).resolves.toEqual(outcome)
    } finally {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('treats a subagent and its root as one policy principal', async () => {
    const root = secureRoot()
    const ctx = new Context()

    try {
      await mountProvider(ctx, root)
      const rootHandle = await ctx.agents.create({
        sessionId: SessionId('principal-root'),
      })
      const peerHandle = await ctx.agents.create({
        sessionId: SessionId('principal-peer'),
      })
      const childHandle = await rootHandle.agent.ctx.agents.create({
        sessionId: SessionId('principal-child'),
      })

      await expect(ctx.sessionMessaging.listPeers(childHandle.agent)).resolves.toEqual([
        expect.objectContaining({ sessionId: peerHandle.agent.id }),
      ])
      await expect(ctx.sessionMessaging.send(childHandle.agent, {
        recipient: String(rootHandle.agent.id),
        text: 'must not route around the native parent-child boundary',
      })).rejects.toMatchObject({ code: 'SELF_TARGET' })
    } finally {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails descendant sends after the owning root loses its presence fence', async () => {
    const root = secureRoot()
    const ctx = new Context()
    let inspector: MessagingDatabase | undefined

    try {
      await mountProvider(ctx, root)
      const rootHandle = await ctx.agents.create({
        sessionId: SessionId('fenced-principal-root'),
      })
      const peerHandle = await ctx.agents.create({
        sessionId: SessionId('fenced-principal-peer'),
      })
      const childHandle = await rootHandle.agent.ctx.agents.create({
        sessionId: SessionId('fenced-principal-child'),
      })

      inspector = new MessagingDatabase({ path: join(root, 'mailbox.sqlite3') })
      const presence = inspector.getPresence(String(rootHandle.agent.id))
      expect(presence).toBeDefined()
      if (presence === undefined) throw new Error('root presence was not published')
      inspector.releasePresence({
        sessionId: presence.sessionId,
        instanceId: presence.instanceId,
        fenceToken: presence.fenceToken,
      })
      inspector.upsertPresence({
        sessionId: presence.sessionId,
        instanceId: 'replacement-instance',
        endpoint: { socketPath: join(root, 'replacement.sock') },
        agentStatus: 'idle',
        leaseMs: 2_000,
      })

      // The provider heartbeat observes the replacement fence and disables the
      // complete stale root subtree, not just the root Agent object itself.
      await new Promise(resolve => setTimeout(resolve, 100))
      await expect(ctx.sessionMessaging.send(childHandle.agent, {
        recipient: String(peerHandle.agent.id),
        text: 'a stale descendant must not send under a replacement root owner',
      })).rejects.toMatchObject({ code: 'SESSION_CONFLICT' })
      expect(inspector.listMessages()).toEqual([])
    } finally {
      inspector?.close()
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects blocked or receive-disabled envelopes before enqueue with no Inbox side effect', async () => {
    const root = secureRoot()
    const ctx = new Context()
    const messageStatuses: PeerMessageReceipt[] = []

    try {
      await mountProvider(ctx, root)
      const senderHandle = await ctx.agents.create({
        sessionId: SessionId('acl-sender'),
      })
      const receiverHandle = await ctx.agents.create({
        sessionId: SessionId('acl-receiver'),
      })
      const sender = senderHandle.agent
      const receiver = receiverHandle.agent
      ctx.on('session-messaging/message-status', receipt => messageStatuses.push(receipt))

      await expect(ctx.sessionMessaging.getPermissions(sender)).resolves.toMatchObject({
        sessionId: sender.id,
        sendAllowed: true,
        receiveAllowed: true,
      })
      await ctx.sessionMessaging.setPeerBlocked(sender, String(receiver.id), true)
      await expect(ctx.sessionMessaging.send(sender, {
        recipient: String(receiver.id),
        text: 'a pair block must reject before durable enqueue',
      })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
      expect(messageStatuses).toEqual([])
      expect(receiver.inbox.hasPending).toBe(false)

      await ctx.sessionMessaging.setPeerBlocked(sender, String(receiver.id), false)
      await ctx.sessionMessaging.setPermissions(receiver, { receiveAllowed: false })
      await expect(ctx.sessionMessaging.send(sender, {
        recipient: String(receiver.id),
        text: 'receive off must reject before durable enqueue',
      })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
      expect(messageStatuses).toEqual([])
      expect(receiver.inbox.hasPending).toBe(false)
    } finally {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('cancels an accepted but unclaimed Inbox relay when receive permission is revoked', async () => {
    const root = secureRoot()
    const ctx = new Context()
    const releaseMaintenance = Promise.withResolvers<void>()
    const failed = Promise.withResolvers<PeerMessageReceipt>()

    try {
      await mountProvider(ctx, root)
      ctx.on('session/flush', () => undefined)
      ctx.on('session-messaging/message-status', receipt => {
        if (receipt.status === 'failed') failed.resolve(receipt)
      })

      const senderHandle = await ctx.agents.create({
        sessionId: SessionId('revoke-sender'),
      })
      const receiverHandle = await ctx.agents.create({
        sessionId: SessionId('revoke-receiver'),
        setup(agentCtx) {
          agentCtx.on('agent/pre-step', () => Promise.resolve({ kind: 'reject' }))
        },
      })
      const sender = senderHandle.agent
      const receiver = receiverHandle.agent
      const maintenance = receiver.runMaintenance(async () => releaseMaintenance.promise)

      const accepted = await ctx.sessionMessaging.send(sender, {
        recipient: String(receiver.id),
        text: 'accepted now, revoked before Inbox claim',
      })
      expect(accepted.status).toBe('accepted')
      expect(receiver.inbox.nextTurn.map(message => message.id)).toEqual([accepted.messageId])

      await ctx.sessionMessaging.setPermissions(receiver, { receiveAllowed: false })
      const finalReceipt = await withTimeout(failed.promise)
      expect(finalReceipt).toMatchObject({
        messageId: accepted.messageId,
        status: 'failed',
        failure: 'permission denied: policy changed before Inbox claim',
      })
      expect(receiver.inbox.hasPending).toBe(false)
      expect(receiver.session.events.some(event =>
        event.type === 'agent/inbox/spliced'
          && event.data.outcome === 'canceled'
          && event.data.removedCount === 1,
      )).toBe(true)
      await expect(ctx.sessionMessaging.getMessage(
        sender,
        accepted.messageId,
      )).resolves.toMatchObject({
        status: 'failed',
        failure: 'permission denied: policy changed before Inbox claim',
      })

      releaseMaintenance.resolve()
      await maintenance
      await receiver.whenIdle()
    } finally {
      releaseMaintenance.resolve()
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    { edge: 'pending', messageId: '00000000-0000-4000-8000-000000000710' },
    { edge: 'claimed', messageId: '00000000-0000-4000-8000-000000000711' },
    { edge: 'discarded', messageId: '00000000-0000-4000-8000-000000000712' },
  ] as const)('ignores an exact-id non-canonical relay at the $edge edge', async ({ edge, messageId }) => {
    const root = secureRoot()
    const ctx = new Context()
    const releaseMaintenance = Promise.withResolvers<void>()
    let maintenance: Promise<void> | undefined
    let receiver: Awaited<ReturnType<typeof ctx.agents.create>>['agent'] | undefined
    let inspector: MessagingDatabase | undefined

    try {
      await mountProvider(ctx, root, 250, 50)
      ctx.on('session/flush', () => undefined)
      const senderHandle = await ctx.agents.create({
        sessionId: SessionId('canonical-relay-sender'),
      })
      const receiverHandle = await ctx.agents.create({
        sessionId: SessionId(`canonical-relay-${edge}-receiver`),
        setup(agentCtx) {
          agentCtx.on('agent/pre-step', () => Promise.resolve({ kind: 'reject' }))
        },
      })
      const sender = senderHandle.agent
      receiver = receiverHandle.agent
      maintenance = receiver.runMaintenance(async () => releaseMaintenance.promise)

      inspector = new MessagingDatabase({ path: join(root, 'mailbox.sqlite3') })
      const presence = inspector.getPresence(String(receiver.id))
      expect(presence).toBeDefined()
      if (presence === undefined) throw new Error('receiver presence was not published')
      inspector.enqueue({
        messageId,
        senderSessionId: String(sender.id),
        recipientSessionId: String(receiver.id),
        senderPrincipalSessionId: String(sender.id),
        recipientPrincipalSessionId: String(receiver.id),
        deliveryMode: 'followup',
        payload: {
          version: 1,
          text: 'canonical body from SQLite',
          senderName: 'Canonical Sender',
        },
        ttlMs: 10_000,
        maxAttempts: 2,
      })
      expect(inspector.claimNextDelivery({
        sessionId: presence.sessionId,
        instanceId: presence.instanceId,
        fenceToken: presence.fenceToken,
        recipientSessionId: presence.sessionId,
        leaseMs: 2_000,
      })).toBeDefined()

      const forged = freezeMessage({
        id: MessageId(messageId),
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Local Session "Canonical Sender" (canonical-relay-sender) sent a message:\n\n',
          },
          {
            type: 'text',
            text: edge === 'pending'
              ? 'canonical body from SQLite'
              : 'forged body outside the SQLite envelope',
          },
        ],
        source: {
          kind: 'local-session-relay',
          form: 'relay',
          senderSessionId: edge === 'pending' ? SessionId('forged-sender') : sender.id,
          replySessionId: edge === 'pending' ? SessionId('forged-root') : sender.id,
          senderName: 'Canonical Sender',
          envelopeId: messageId,
        },
      })

      if (edge === 'claimed') {
        receiver.session.append('user/message', forged, { surfaceOp: 'append' })
      } else {
        receiver.inbox.append('next-turn', forged)
        if (edge === 'discarded') {
          expect(receiver.inbox.remove(MessageId(messageId))).toBe(true)
        }
      }
      await ctx.sessions.flush(receiver.session)
      await new Promise(resolve => setTimeout(resolve, 100))

      expect(inspector.getMessage(messageId)).toMatchObject({ status: 'queued' })
      expect(inspector.getMessage(messageId)).not.toHaveProperty('acceptedAt')
      expect(inspector.getMessage(messageId)).not.toHaveProperty('claimedAt')
      expect(inspector.getMessage(messageId)).not.toHaveProperty('failedAt')
    } finally {
      releaseMaintenance.resolve()
      await maintenance
      await receiver?.whenIdle()
      inspector?.close()
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not inherit relay Inbox lifecycle facts across a fork seed boundary', async () => {
    const root = secureRoot()
    const ctx = new Context()
    const releaseMaintenance = Promise.withResolvers<void>()
    const accepted = Promise.withResolvers<PeerMessageReceipt>()
    const messageId = '00000000-0000-4000-8000-000000000601'
    let inspector: MessagingDatabase | undefined

    try {
      await mountProvider(ctx, root, 250, 50)
      ctx.on('session/flush', () => undefined)
      ctx.on('session-messaging/message-status', receipt => {
        if (String(receipt.messageId) === messageId && receipt.status === 'accepted') {
          accepted.resolve(receipt)
        }
      })

      const seedSession = Session.create(SessionId('fork-seed-source'))
      seedSession.append('agent/inbox/spliced', {
        target: 'next-turn',
        start: 0,
        inserted: [freezeMessage({
          id: MessageId(messageId),
          role: 'user',
          content: [{ type: 'text', text: 'inherited relay must stay with the parent' }],
          source: {
            kind: 'local-session-relay',
            form: 'relay',
            senderSessionId: SessionId('fork-seed-sender'),
            replySessionId: SessionId('fork-seed-sender'),
            envelopeId: messageId,
          },
        })],
      })

      const receiverHandle = await ctx.agents.create({
        sessionId: SessionId('fork-seed-receiver'),
        seed: seedSession.events,
        meta: {
          parentSession: seedSession.id,
          seedLength: seedSession.events.length,
        },
        setup(agentCtx) {
          agentCtx.on('agent/pre-step', () => Promise.resolve({ kind: 'reject' }))
        },
      })
      const receiver = receiverHandle.agent
      expect(receiver.inbox.hasPending).toBe(false)
      const maintenance = receiver.runMaintenance(async () => releaseMaintenance.promise)

      inspector = new MessagingDatabase({ path: join(root, 'mailbox.sqlite3') })
      inspector.enqueue({
        messageId,
        senderSessionId: 'fork-seed-sender',
        recipientSessionId: String(receiver.id),
        senderPrincipalSessionId: 'fork-seed-sender',
        recipientPrincipalSessionId: String(receiver.id),
        deliveryMode: 'followup',
        payload: { version: 1, text: 'new child-local relay with the reused identity' },
        ttlMs: 10_000,
        maxAttempts: 2,
      })

      await expect(withTimeout(accepted.promise)).resolves.toMatchObject({
        messageId,
        status: 'accepted',
      })
      expect(receiver.inbox.nextTurn.map(message => String(message.id))).toEqual([messageId])
      expect(receiver.inbox.nextTurn[0]?.content).toEqual([
        {
          type: 'text',
          text: 'Local Session "session-d-sender" (fork-seed-sender) sent a message:\n\n',
        },
        { type: 'text', text: 'new child-local relay with the reused identity' },
      ])

      releaseMaintenance.resolve()
      await maintenance
      await receiver.whenIdle()
    } finally {
      releaseMaintenance.resolve()
      inspector?.close()
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not treat mismatched MessageId and relay envelopeId as the same delivery', async () => {
    const root = secureRoot()
    const ctx = new Context()
    const releaseMaintenance = Promise.withResolvers<void>()
    const accepted = Promise.withResolvers<PeerMessageReceipt>()
    const messageId = '00000000-0000-4000-8000-000000000602'
    const forgedMessageId = '00000000-0000-4000-8000-000000000603'
    let inspector: MessagingDatabase | undefined

    try {
      await mountProvider(ctx, root, 250, 50)
      ctx.on('session/flush', () => undefined)
      ctx.on('session-messaging/message-status', receipt => {
        if (String(receipt.messageId) === messageId && receipt.status === 'accepted') {
          accepted.resolve(receipt)
        }
      })
      const receiverHandle = await ctx.agents.create({
        sessionId: SessionId('identity-mismatch-receiver'),
        setup(agentCtx) {
          agentCtx.on('agent/pre-step', () => Promise.resolve({ kind: 'reject' }))
        },
      })
      const receiver = receiverHandle.agent
      const maintenance = receiver.runMaintenance(async () => releaseMaintenance.promise)

      receiver.inbox.append('next-turn', freezeMessage({
        id: MessageId(forgedMessageId),
        role: 'user',
        content: [{ type: 'text', text: 'foreign message with a forged relay source' }],
        source: {
          kind: 'local-session-relay',
          form: 'relay',
          senderSessionId: SessionId('identity-mismatch-sender'),
          replySessionId: SessionId('identity-mismatch-sender'),
          envelopeId: messageId,
        },
      }))
      await ctx.sessions.flush(receiver.session)

      inspector = new MessagingDatabase({ path: join(root, 'mailbox.sqlite3') })
      inspector.enqueue({
        messageId,
        senderSessionId: 'identity-mismatch-sender',
        recipientSessionId: String(receiver.id),
        senderPrincipalSessionId: 'identity-mismatch-sender',
        recipientPrincipalSessionId: String(receiver.id),
        deliveryMode: 'followup',
        payload: { version: 1, text: 'canonical relay for the durable envelope' },
        ttlMs: 10_000,
        maxAttempts: 2,
      })

      await expect(withTimeout(accepted.promise)).resolves.toMatchObject({
        messageId,
        status: 'accepted',
      })
      expect(receiver.inbox.nextTurn.map(message => String(message.id))).toEqual([
        forgedMessageId,
        messageId,
      ])
      expect(receiver.inbox.nextTurn[1]?.content).toEqual([
        {
          type: 'text',
          text: 'Local Session "session-h-sender" (identity-mismatch-sender) sent a message:\n\n',
        },
        { type: 'text', text: 'canonical relay for the durable envelope' },
      ])

      releaseMaintenance.resolve()
      await maintenance
      await receiver.whenIdle()
    } finally {
      releaseMaintenance.resolve()
      inspector?.close()
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
