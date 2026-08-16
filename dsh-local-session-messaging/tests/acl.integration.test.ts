import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import TimerService from '@deepseek-ai/cordis-plugin-timer'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import { describe, expect, it } from 'vitest'

import { MessagingDatabase } from '../src/database.js'
import LocalSessionMessaging from '../src/local.js'

function secureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-local-acl-'))
  chmodSync(root, 0o700)
  return root
}

async function mountProvider(ctx: Context, root: string): Promise<void> {
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: '' } })
  await ctx.plugin(TimerService)
  ctx.provide('sessionQuery', {
    readTitleSnapshots: () => Promise.resolve([]),
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
    pollIntervalMs: 50,
    deliveryLeaseMs: 250,
    ackWaitMs: 250,
    ackPollMs: 5,
  })
  await ctx.plugin(AgentLoop, { agents: [] })
}

describe('root-subtree messaging ACL', () => {
  it('isolates two method subtrees symmetrically while preserving coordinator spokes', async () => {
    const root = secureRoot()
    const ctx = new Context()
    const releaseCoordinator = Promise.withResolvers<void>()
    let coordinatorMaintenance: Promise<void> | undefined
    let inspector: MessagingDatabase | undefined

    try {
      await mountProvider(ctx, root)
      // A real persistence participant is required before an Inbox admission
      // can become `accepted`.
      ctx.on('session/flush', () => undefined)

      const coordinatorHandle = await ctx.agents.create({
        sessionId: SessionId('acl-coordinator'),
        setup(agentCtx) {
          agentCtx.on('agent/pre-step', () => Promise.resolve({ kind: 'reject' }))
        },
      })
      const methodAHandle = await ctx.agents.create({
        sessionId: SessionId('acl-method-a'),
      })
      const methodBHandle = await ctx.agents.create({
        sessionId: SessionId('acl-method-b'),
      })
      const childHandle = await methodAHandle.agent.ctx.agents.create({
        sessionId: SessionId('acl-method-a-child'),
      })
      const grandchildHandle = await childHandle.agent.ctx.agents.create({
        sessionId: SessionId('acl-method-a-grandchild'),
      })
      const coordinator = coordinatorHandle.agent
      const methodA = methodAHandle.agent
      const methodB = methodBHandle.agent
      const grandchild = grandchildHandle.agent
      coordinatorMaintenance = coordinator.runMaintenance(async () => releaseCoordinator.promise)
      inspector = new MessagingDatabase({ path: join(root, 'mailbox.sqlite3') })

      // Direction switches belong to the runtime root even when a descendant
      // is the actual sender.
      await ctx.sessionMessaging.setPermissions(methodA, { sendAllowed: false })
      await expect(ctx.sessionMessaging.getPermissions(grandchild)).resolves.toMatchObject({
        sessionId: methodA.id,
        sendAllowed: false,
        receiveAllowed: true,
      })
      await expect(ctx.sessionMessaging.listPeers(grandchild)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sessionId: coordinator.id, sendable: false }),
          expect.objectContaining({ sessionId: methodB.id, sendable: false }),
        ]),
      )
      await expect(ctx.sessionMessaging.send(grandchild, {
        recipient: String(coordinator.id),
        text: 'a descendant cannot route around its root send switch',
      })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
      await ctx.sessionMessaging.setPermissions(methodA, { sendAllowed: true })

      // One block creates a symmetric edge between the complete A and B root
      // subtrees. It deliberately does not create A-C or B-C edges.
      await ctx.sessionMessaging.setPeerBlocked(methodA, String(methodB.id), true)
      expect(inspector.isPairBlocked(String(methodA.id), String(methodB.id))).toBe(true)
      expect(inspector.isPairBlocked(String(methodA.id), String(coordinator.id))).toBe(false)
      expect(inspector.isPairBlocked(String(methodB.id), String(coordinator.id))).toBe(false)
      await expect(ctx.sessionMessaging.listBlockedPeers(methodB)).resolves.toEqual([
        expect.objectContaining({ sessionId: methodA.id }),
      ])
      await expect(ctx.sessionMessaging.listPeers(methodA)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sessionId: methodB.id, sendable: false }),
          expect.objectContaining({ sessionId: coordinator.id, sendable: true }),
        ]),
      )
      await expect(ctx.sessionMessaging.listPeers(methodB)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sessionId: methodA.id, sendable: false }),
          expect.objectContaining({ sessionId: coordinator.id, sendable: true }),
        ]),
      )
      await expect(ctx.sessionMessaging.listPeers(grandchild)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sessionId: methodB.id, sendable: false }),
          expect.objectContaining({ sessionId: coordinator.id, sendable: true }),
        ]),
      )

      await expect(ctx.sessionMessaging.send(methodA, {
        recipient: String(methodB.id),
        text: 'method A must not disclose its candidate to method B',
      })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
      await expect(ctx.sessionMessaging.send(methodB, {
        recipient: String(methodA.id),
        text: 'the reverse direction is blocked by the same edge',
      })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
      await expect(ctx.sessionMessaging.send(grandchild, {
        recipient: String(methodB.id),
        text: 'a deep descendant must not bypass the A-B block',
      })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
      expect(inspector.listMessages()).toHaveLength(0)

      const reportA = await ctx.sessionMessaging.send(methodA, {
        recipient: String(coordinator.id),
        text: 'method A report',
      })
      const reportB = await ctx.sessionMessaging.send(methodB, {
        recipient: String(coordinator.id),
        text: 'method B report',
      })
      const descendantReport = await ctx.sessionMessaging.send(grandchild, {
        recipient: String(coordinator.id),
        text: 'method A descendant report',
      })
      expect([reportA.status, reportB.status, descendantReport.status]).toEqual([
        'accepted',
        'accepted',
        'accepted',
      ])
      expect(coordinator.inbox.nextTurn.map(message => message.id)).toEqual([
        reportA.messageId,
        reportB.messageId,
        descendantReport.messageId,
      ])
      expect(coordinator.inbox.nextTurn[2]).toMatchObject({
        content: [
          {
            type: 'text',
            text: 'Local Session "session-method-a" (acl-method-a), via Agent acl-method-a-grandchild sent a message:\n\n',
          },
          { type: 'text', text: 'method A descendant report' },
        ],
        source: {
          senderSessionId: grandchild.id,
          replySessionId: methodA.id,
          senderName: 'session-method-a',
        },
      })

      // Receiving can be closed independently without disabling B's outbound
      // coordinator report path.
      await ctx.sessionMessaging.setPermissions(methodB, { receiveAllowed: false })
      await expect(ctx.sessionMessaging.listPeers(coordinator)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sessionId: methodB.id, sendable: false }),
        ]),
      )
      await expect(ctx.sessionMessaging.listPeers(methodB)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sessionId: coordinator.id, sendable: true }),
        ]),
      )
      await expect(ctx.sessionMessaging.send(coordinator, {
        recipient: String(methodB.id),
        text: 'B has disabled incoming cross-session messages',
      })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
      await expect(ctx.sessionMessaging.send(methodB, {
        recipient: String(coordinator.id),
        text: 'B can still submit another coordinator report',
      })).resolves.toMatchObject({ status: 'accepted' })
    } finally {
      inspector?.close()
      releaseCoordinator.resolve()
      await coordinatorMaintenance
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps an ACL-allowed disconnected root sendable for durable offline delivery', async () => {
    const root = secureRoot()
    const ctx = new Context()

    try {
      await mountProvider(ctx, root)
      const senderHandle = await ctx.agents.create({
        sessionId: SessionId('offline-sender'),
      })
      const receiverHandle = await ctx.agents.create({
        sessionId: SessionId('offline-receiver'),
      })
      const receiverId = receiverHandle.agent.id
      await receiverHandle.dispose()

      await expect(ctx.sessionMessaging.listPeers(senderHandle.agent)).resolves.toEqual([
        expect.objectContaining({
          sessionId: receiverId,
          connection: 'disconnected',
          sendable: true,
        }),
      ])
      await expect(ctx.sessionMessaging.send(senderHandle.agent, {
        recipient: String(receiverId),
        text: 'durable offline message',
      })).resolves.toMatchObject({
        recipientSessionId: receiverId,
        status: 'queued',
      })
    } finally {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('publishes official renames immediately and fails closed on ambiguous ACL names', async () => {
    const root = secureRoot()
    const ctx = new Context()
    let inspector: MessagingDatabase | undefined

    try {
      await mountProvider(ctx, root)
      const coordinatorHandle = await ctx.agents.create({
        sessionId: SessionId('rename-coordinator'),
      })
      const methodAHandle = await ctx.agents.create({
        sessionId: SessionId('rename-method-a'),
      })
      const methodBHandle = await ctx.agents.create({
        sessionId: SessionId('rename-method-b'),
      })
      const coordinator = coordinatorHandle.agent
      const methodA = methodAHandle.agent
      const methodB = methodBHandle.agent
      inspector = new MessagingDatabase({ path: join(root, 'mailbox.sqlite3') })

      ctx.sessionTitle.rename(methodA.session, '  Method   Candidate  ')
      ctx.sessionTitle.rename(methodB.session, 'Method Candidate')
      expect(inspector.getPresence(String(methodA.id))).toMatchObject({
        name: 'Method Candidate',
        title: 'Method Candidate',
      })
      await expect(ctx.sessionMessaging.listPeers(coordinator)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sessionId: methodA.id, name: 'Method Candidate' }),
          expect.objectContaining({ sessionId: methodB.id, name: 'Method Candidate' }),
        ]),
      )

      await expect(ctx.sessionMessaging.setPeerBlocked(
        coordinator,
        'Method Candidate',
        true,
      )).rejects.toMatchObject({ code: 'AMBIGUOUS_TARGET' })
      expect(inspector.listPairBlocks()).toEqual([])

      await expect(ctx.sessionMessaging.setPeerBlocked(
        coordinator,
        String(methodA.id),
        true,
      )).resolves.toMatchObject({ sessionId: methodA.id, name: 'Method Candidate' })
      expect(inspector.isPairBlocked(String(coordinator.id), String(methodA.id))).toBe(true)
    } finally {
      inspector?.close()
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
