import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandDefinition, CommandInvocation } from '@deepseek-ai/dsh-commands'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionTitleInvalidError } from '@deepseek-ai/dsh-session-title'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'

import { apply as applyCommand } from '../src/command.js'
import { apply as applyTool } from '../src/tool.js'

function caller(id = 'caller-session'): Agent {
  return { id: SessionId(id), session: {} } as Agent
}

function context(value: object): Context {
  return value as Context
}

function execution(agent: Agent | undefined, signal: AbortSignal): ToolRunContext {
  return { agent, signal } as ToolRunContext
}

describe('model tool surface', () => {
  it('registers Claude-compatible tools and returns canonical values', async () => {
    const definitions: ToolDefinition[] = []
    const signal = new AbortController().signal
    const owner = caller()
    const listPeers = vi.fn(async () => [{
      sessionId: SessionId('peer-1'),
      name: 'backend',
      connection: 'connected' as const,
      agentStatus: 'idle' as const,
      sendable: true,
    }])
    const send = vi.fn(async () => ({
      messageId: 'message-1',
      senderSessionId: owner.id,
      recipientSessionId: SessionId('peer-1'),
      recipientName: 'backend',
      status: 'queued' as const,
      createdAt: 10,
      updatedAt: 11,
    }))
    const ctx = context({
      tools: {
        register(definition: ToolDefinition) {
          definitions.push(definition)
          return () => undefined
        },
      },
      sessionMessaging: { listPeers, send },
      subagents: { listChildren: vi.fn(async () => []) },
    })

    applyTool(ctx)
    expect(definitions.map(definition => definition.name)).toEqual(['ListAgents', 'SendMessage'])

    const listAgents = definitions[0]!
    await expect(listAgents.execute({}, execution(owner, signal))).resolves.toEqual({
      agents: [{
        kind: 'session',
        name: 'backend',
        session_id: 'peer-1',
        status: 'idle',
        sendable: true,
      }],
    })
    expect(listAgents.output.render({}, {
      agents: [{
        kind: 'session',
        name: 'backend',
        session_id: 'peer-1',
        status: 'idle',
        sendable: true,
      }],
    })).toEqual([{
      type: 'text',
      text: 'backend (session, idle, sendable, peer-1)',
    }])

    const sendMessage = definitions[1]!
    await expect(sendMessage.execute({
      recipient: 'backend',
      message: 'API changed',
    }, execution(owner, signal))).resolves.toEqual({
      message_id: 'message-1',
      recipient_session_id: 'peer-1',
      recipient_name: 'backend',
      recipient_kind: 'session',
      status: 'queued',
      created_at: 10,
      updated_at: 11,
    })
    expect(send).toHaveBeenCalledWith(owner, {
      recipient: 'peer-1',
      text: 'API changed',
    }, signal)
  })

  it('requires an exact calling Agent and never sends on ambiguous names', async () => {
    const definitions: ToolDefinition[] = []
    const send = vi.fn()
    const ctx = context({
      tools: {
        register(definition: ToolDefinition) {
          definitions.push(definition)
          return () => undefined
        },
      },
      sessionMessaging: {
        listPeers: vi.fn(async () => [
          {
            sessionId: SessionId('peer-1'),
            name: 'worker',
            connection: 'connected' as const,
            agentStatus: 'idle' as const,
            sendable: true,
          },
          {
            sessionId: SessionId('peer-2'),
            name: 'worker',
            connection: 'connected' as const,
            agentStatus: 'idle' as const,
            sendable: true,
          },
        ]),
        send,
      },
      subagents: { listChildren: vi.fn(async () => []) },
    })
    applyTool(ctx)

    const signal = new AbortController().signal
    await expect(definitions[0]!.execute({}, execution(undefined, signal))).rejects.toThrow(
      'requires an exact calling Agent',
    )
    await expect(definitions[1]!.execute({
      recipient: 'worker',
      message: 'hello',
    }, execution(caller(), signal))).rejects.toMatchObject({ code: 'AMBIGUOUS_TARGET' })
    expect(send).not.toHaveBeenCalled()
  })
})

describe('human command surface', () => {
  it('registers /list-agents without recording command input', async () => {
    const definitions: CommandDefinition[] = []
    const ctx = context({
      commands: {
        register(value: CommandDefinition) {
          definitions.push(value)
          return () => undefined
        },
      },
      sessionMessaging: {
        listPeers: vi.fn(async () => [{
          sessionId: SessionId('peer-1'),
          name: 'backend',
          cwd: '/work/backend',
          connection: 'connected' as const,
          agentStatus: 'running' as const,
          sendable: false,
        }]),
      },
      sessionTitle: { rename: vi.fn() },
      subagents: { listChildren: vi.fn(async () => []) },
    })
    applyCommand(ctx)

    const definition = definitions.find(value => value.name === 'list-agents')
    expect(definition).toMatchObject({
      name: 'list-agents',
      recordInput: false,
    })
    const invocation = {
      agent: caller(),
      signal: new AbortController().signal,
      rawInput: '',
    } as CommandInvocation
    await expect(definition!.handler(invocation)).resolves.toEqual({
      kind: 'success',
      text: '- backend — session — peer-1 — running, not sendable, /work/backend',
    })
  })

  it('returns a command error when discovery fails', async () => {
    const definitions: CommandDefinition[] = []
    const ctx = context({
      commands: {
        register(value: CommandDefinition) {
          definitions.push(value)
          return () => undefined
        },
      },
      sessionMessaging: {
        listPeers: vi.fn(async () => {
          throw new Error('database unavailable')
        }),
      },
      sessionTitle: { rename: vi.fn() },
      subagents: { listChildren: vi.fn(async () => []) },
    })
    applyCommand(ctx)

    const definition = definitions.find(value => value.name === 'list-agents')
    await expect(definition!.handler({
      agent: caller(),
      signal: new AbortController().signal,
      rawInput: '',
    } as CommandInvocation)).resolves.toEqual({
      kind: 'error',
      text: 'Unable to list agents: database unavailable',
    })
  })

  it('renames through the official session-title service and links its durable event', async () => {
    const definitions: CommandDefinition[] = []
    const rename = vi.fn(() => ({ title: 'Backend API', eventSeq: 42 }))
    const ctx = context({
      commands: {
        register(value: CommandDefinition) {
          definitions.push(value)
          return () => undefined
        },
      },
      sessionMessaging: {},
      sessionTitle: { rename },
      subagents: {},
    })
    applyCommand(ctx)

    const definition = definitions.find(value => value.name === 'rename')
    expect(definition).toMatchObject({
      name: 'rename',
      input: { hint: '<name>' },
      recordInput: false,
    })
    const owner = caller()
    expect(definition!.handler({
      agent: owner,
      signal: new AbortController().signal,
      rawInput: '  Backend   API  ',
    } as CommandInvocation)).toEqual({
      kind: 'success',
      text: 'Session renamed to "Backend API".',
      sourceEventSeq: 42,
    })
    expect(rename).toHaveBeenCalledWith(owner.session, '  Backend   API  ')
  })

  it('renders official invalid-title failures without recording raw input', async () => {
    const definitions: CommandDefinition[] = []
    const ctx = context({
      commands: {
        register(value: CommandDefinition) {
          definitions.push(value)
          return () => undefined
        },
      },
      sessionMessaging: {},
      sessionTitle: {
        rename: vi.fn(() => {
          throw new SessionTitleInvalidError('session title must contain visible characters')
        }),
      },
      subagents: {},
    })
    applyCommand(ctx)

    const definition = definitions.find(value => value.name === 'rename')
    expect(definition!.handler({
      agent: caller(),
      signal: new AbortController().signal,
      rawInput: '   ',
    } as CommandInvocation)).toEqual({
      kind: 'error',
      text: 'Invalid Session name: session title must contain visible characters',
    })
  })

  it('reports send and receive permissions without exposing them as a model tool', async () => {
    const definitions: CommandDefinition[] = []
    const getPermissions = vi.fn(async () => ({
      sessionId: SessionId('caller-session'),
      sendAllowed: false,
      receiveAllowed: true,
      updatedAt: 10,
    }))
    const ctx = context({
      commands: {
        register(value: CommandDefinition) {
          definitions.push(value)
          return () => undefined
        },
      },
      sessionMessaging: { getPermissions },
      sessionTitle: { rename: vi.fn() },
      subagents: {},
    })
    applyCommand(ctx)

    const definition = definitions.find(value => value.name === 'message-permissions')
    expect(definition).toMatchObject({
      name: 'message-permissions',
      recordInput: false,
    })
    const owner = caller()
    const signal = new AbortController().signal
    await expect(definition!.handler({
      agent: owner,
      signal,
      rawInput: '',
    } as CommandInvocation)).resolves.toEqual({
      kind: 'success',
      text: 'Local Session messaging for caller-session:\n- send: off\n- receive: on',
    })
    expect(getPermissions).toHaveBeenCalledWith(owner, signal)
  })

  it('changes directional policy and preserves a multi-word block target', async () => {
    const definitions: CommandDefinition[] = []
    const setPermissions = vi.fn(async (_owner, patch: {
      readonly sendAllowed?: boolean
      readonly receiveAllowed?: boolean
    }) => ({
      sessionId: SessionId('caller-session'),
      sendAllowed: patch.sendAllowed ?? true,
      receiveAllowed: patch.receiveAllowed ?? true,
    }))
    const setPeerBlocked = vi.fn(async (_owner, _recipient, blocked: boolean) => ({
      sessionId: SessionId('peer-1'),
      name: 'Backend Worker',
      blockedAt: blocked ? 100 : 0,
    }))
    const ctx = context({
      commands: {
        register(value: CommandDefinition) {
          definitions.push(value)
          return () => undefined
        },
      },
      sessionMessaging: { setPermissions, setPeerBlocked },
      sessionTitle: { rename: vi.fn() },
      subagents: {},
    })
    applyCommand(ctx)

    const definition = definitions.find(value => value.name === 'message-permissions')!
    const owner = caller()
    const signal = new AbortController().signal
    await expect(definition.handler({
      agent: owner,
      signal,
      rawInput: ' send off ',
    } as CommandInvocation)).resolves.toEqual({
      kind: 'success',
      text: 'Sending local Session messages is off.',
    })
    expect(setPermissions).toHaveBeenCalledWith(owner, { sendAllowed: false }, signal)

    await expect(definition.handler({
      agent: owner,
      signal,
      rawInput: 'receive on',
    } as CommandInvocation)).resolves.toEqual({
      kind: 'success',
      text: 'Receiving local Session messages is on.',
    })
    expect(setPermissions).toHaveBeenLastCalledWith(owner, { receiveAllowed: true }, signal)

    await expect(definition.handler({
      agent: owner,
      signal,
      rawInput: 'block   Backend Worker ',
    } as CommandInvocation)).resolves.toEqual({
      kind: 'success',
      text: 'Blocked "Backend Worker" (peer-1).',
    })
    expect(setPeerBlocked).toHaveBeenCalledWith(owner, 'Backend Worker', true, signal)

    await expect(definition.handler({
      agent: owner,
      signal,
      rawInput: 'unblock peer-1',
    } as CommandInvocation)).resolves.toEqual({
      kind: 'success',
      text: 'Unblocked "Backend Worker" (peer-1).',
    })
    expect(setPeerBlocked).toHaveBeenLastCalledWith(owner, 'peer-1', false, signal)
  })

  it('lists blocked peers and rejects malformed permission commands without mutation', async () => {
    const definitions: CommandDefinition[] = []
    const setPermissions = vi.fn()
    const setPeerBlocked = vi.fn()
    const listBlockedPeers = vi.fn(async () => [{
      sessionId: SessionId('peer-1'),
      name: 'backend',
      blockedAt: Date.parse('2026-08-14T00:00:00.000Z'),
    }])
    const ctx = context({
      commands: {
        register(value: CommandDefinition) {
          definitions.push(value)
          return () => undefined
        },
      },
      sessionMessaging: { listBlockedPeers, setPermissions, setPeerBlocked },
      sessionTitle: { rename: vi.fn() },
      subagents: {},
    })
    applyCommand(ctx)

    const definition = definitions.find(value => value.name === 'message-permissions')!
    const invocation = {
      agent: caller(),
      signal: new AbortController().signal,
      rawInput: 'blocks',
    } as CommandInvocation
    await expect(definition.handler(invocation)).resolves.toEqual({
      kind: 'success',
      text: '- backend — peer-1 — blocked 2026-08-14T00:00:00.000Z',
    })

    await expect(definition.handler({ ...invocation, rawInput: 'receive maybe' })).resolves.toEqual({
      kind: 'error',
      text: 'Usage: /message-permissions [status | send on|off | receive on|off | block <id|name> | unblock <id|name> | blocks]',
    })
    expect(setPermissions).not.toHaveBeenCalled()
    expect(setPeerBlocked).not.toHaveBeenCalled()
  })
})
