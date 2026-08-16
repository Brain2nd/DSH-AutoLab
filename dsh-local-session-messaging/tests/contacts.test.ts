import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'

import {
  listAgentContacts,
  resolveAgentContact,
  sendAgentContactMessage,
  type AgentContact,
} from '../src/contacts.js'
import { SessionMessagingError, type PeerSessionSnapshot } from '../src/service.js'

function caller(id = 'caller-session'): Agent {
  return { id: SessionId(id) } as Agent
}

function context(value: object): Context {
  return value as Context
}

function peer(
  id: string,
  name: string,
  overrides: Partial<PeerSessionSnapshot> = {},
): PeerSessionSnapshot {
  return {
    sessionId: SessionId(id),
    name,
    connection: 'connected',
    agentStatus: 'idle',
    sendable: true,
    ...overrides,
  }
}

describe('contact discovery and resolution', () => {
  it('merges only direct child rows with independent Session peers', async () => {
    const signal = new AbortController().signal
    const listPeers = vi.fn(async () => [
      peer('peer-1', 'backend', {
        cwd: '/work/backend',
        agentStatus: 'running',
        sendable: false,
      }),
      peer('peer-2', 'offline', { connection: 'disconnected' }),
    ])
    const listChildren = vi.fn(async () => [
      {
        kind: 'diagnostic' as const,
        id: SessionId('bad-child'),
        reason: 'corrupt' as const,
      },
      {
        kind: 'child' as const,
        id: SessionId('child-1'),
        activity: 'inactive' as const,
        hasChildren: true,
        mode: 'continuable' as const,
        label: 'researcher',
      },
      {
        kind: 'child' as const,
        id: SessionId('child-2'),
        activity: 'running' as const,
        hasChildren: false,
        mode: 'one-shot' as const,
      },
    ])
    const ctx = context({
      sessionMessaging: { listPeers },
      subagents: { listChildren },
    })
    const owner = caller()

    await expect(listAgentContacts(ctx, owner, signal)).resolves.toEqual([
      {
        kind: 'subagent',
        sessionId: 'child-1',
        name: 'researcher',
        status: 'inactive',
        sendable: true,
        mode: 'continuable',
        hasChildren: true,
      },
      {
        kind: 'subagent',
        sessionId: 'child-2',
        name: 'subagent-child-2',
        status: 'running',
        sendable: false,
        mode: 'one-shot',
        hasChildren: false,
      },
      {
        kind: 'session',
        sessionId: 'peer-1',
        name: 'backend',
        status: 'running',
        sendable: false,
        cwd: '/work/backend',
      },
      {
        kind: 'session',
        sessionId: 'peer-2',
        name: 'offline',
        status: 'disconnected',
        sendable: true,
      },
    ])
    expect(listPeers).toHaveBeenCalledWith(owner, signal)
    expect(listChildren).toHaveBeenCalledWith(owner.id, signal)
  })

  it('prefers an exact id and accepts a unique case-insensitive name', () => {
    const contacts: AgentContact[] = [
      {
        kind: 'session',
        sessionId: 'session-a',
        name: 'Frontend',
        status: 'idle',
        sendable: true,
      },
      {
        kind: 'session',
        sessionId: 'Frontend',
        name: 'other',
        status: 'idle',
        sendable: true,
      },
    ]

    expect(resolveAgentContact(contacts, ' Frontend ')).toBe(contacts[1])
    expect(resolveAgentContact(contacts.slice(0, 1), 'frontend')).toBe(contacts[0])
  })

  it('fails closed for duplicate ids and ambiguous names', () => {
    const duplicateId: AgentContact[] = [
      {
        kind: 'session',
        sessionId: 'same-id',
        name: 'root',
        status: 'idle',
        sendable: true,
      },
      {
        kind: 'subagent',
        sessionId: 'same-id',
        name: 'child',
        status: 'inactive',
        sendable: true,
        mode: 'continuable',
        hasChildren: false,
      },
    ]
    expect(() => resolveAgentContact(duplicateId, 'same-id')).toThrowError(
      expect.objectContaining({ code: 'SESSION_CONFLICT' }),
    )

    const duplicateName = duplicateId.map((entry, index) => ({
      ...entry,
      sessionId: `id-${index}`,
      name: 'worker',
    }))
    expect(() => resolveAgentContact(duplicateName, 'worker')).toThrowError(
      expect.objectContaining({ code: 'AMBIGUOUS_TARGET' }),
    )
    expect(() => resolveAgentContact(duplicateName, 'missing')).toThrowError(
      expect.objectContaining({ code: 'UNKNOWN_TARGET' }),
    )
  })
})

describe('contact delivery routing', () => {
  it('sends independent Session messages through the abstract service seam', async () => {
    const signal = new AbortController().signal
    const send = vi.fn(async () => ({
      messageId: MessageId('message-1'),
      senderSessionId: SessionId('caller-session'),
      recipientSessionId: SessionId('peer-1'),
      recipientName: 'backend',
      status: 'queued' as const,
      createdAt: 100,
      updatedAt: 100,
    }))
    const ctx = context({ sessionMessaging: { send }, subagents: {} })
    const owner = caller()
    const contact: AgentContact = {
      kind: 'session',
      sessionId: 'peer-1',
      name: 'backend',
      status: 'idle',
      sendable: true,
    }

    await expect(sendAgentContactMessage(ctx, owner, contact, 'API changed', {
      replyTo: MessageId('prior-message'),
      signal,
    })).resolves.toEqual({
      messageId: 'message-1',
      recipientSessionId: 'peer-1',
      recipientName: 'backend',
      recipientKind: 'session',
      status: 'queued',
      createdAt: 100,
      updatedAt: 100,
    })
    expect(send).toHaveBeenCalledWith(owner, {
      recipient: 'peer-1',
      text: 'API changed',
      replyTo: 'prior-message',
    }, signal)
  })

  it('delegates continuable children to DSH subagent followup', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1234)
    try {
      const signal = new AbortController().signal
      const followup = vi.fn(async () => MessageId('child-message'))
      const ctx = context({ sessionMessaging: {}, subagents: { followup } })
      const owner = caller()
      const contact: AgentContact = {
        kind: 'subagent',
        sessionId: 'child-1',
        name: 'researcher',
        status: 'inactive',
        sendable: true,
        mode: 'continuable',
        hasChildren: false,
      }

      await expect(sendAgentContactMessage(ctx, owner, contact, 'new evidence', {
        replyTo: MessageId('parent-message'),
        signal,
      })).resolves.toEqual({
        messageId: 'child-message',
        recipientSessionId: 'child-1',
        recipientName: 'researcher',
        recipientKind: 'subagent',
        status: 'accepted',
        createdAt: 1234,
        updatedAt: 1234,
      })
      expect(followup).toHaveBeenCalledWith(
        owner,
        'child-1',
        [{ type: 'text', text: '[Reply to message parent-message]\nnew evidence' }],
        {
          source: {
            kind: 'coordinator',
            form: 'relay',
            senderSessionId: owner.id,
          },
          signal,
        },
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a one-shot child without invoking followup', async () => {
    const followup = vi.fn()
    const ctx = context({ sessionMessaging: {}, subagents: { followup } })
    const contact: AgentContact = {
      kind: 'subagent',
      sessionId: 'child-1',
      name: 'one-shot',
      status: 'inactive',
      sendable: false,
      mode: 'one-shot',
      hasChildren: false,
    }

    await expect(sendAgentContactMessage(ctx, caller(), contact, 'hello', {
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(SessionMessagingError)
    expect(followup).not.toHaveBeenCalled()
  })
})
