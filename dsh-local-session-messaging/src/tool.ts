/** Claude-compatible model tools over the DSH-native messaging seam. */
import type { Context } from '@deepseek-ai/cordis'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  listAgentContacts,
  resolveAgentContact,
  sendAgentContactMessage,
  type AgentContact,
} from './contacts.js'

export const name = 'tool-local-session-messaging'
export const inject = ['tools', 'sessionMessaging', 'subagents']

function contactValue(contact: AgentContact) {
  return {
    kind: contact.kind,
    name: contact.name,
    session_id: contact.sessionId,
    status: contact.status,
    sendable: contact.sendable,
    ...(contact.kind === 'session' && contact.cwd !== undefined ? { cwd: contact.cwd } : {}),
    ...(contact.kind === 'subagent' ? {
      mode: contact.mode,
      has_children: contact.hasChildren,
    } : {}),
  }
}

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'ListAgents',
    description: 'List other known local DSH Sessions and this Session\'s direct subagents, including point-in-time sendability. Use this before SendMessage when you do not know the exact recipient name or Session id. Remote Control peers are intentionally not included.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          agents: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, enum: ['session', 'subagent'] },
                name: { type: 'string', required: true },
                session_id: { type: 'string', required: true },
                status: { type: 'string', required: true },
                sendable: { type: 'boolean', required: true },
                cwd: { type: 'string' },
                mode: { type: 'string', enum: ['one-shot', 'continuable'] },
                has_children: { type: 'boolean' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.agents.length === 0
          ? 'No other local Sessions or direct subagents are currently known.'
          : value.agents
            .map((agent) => `${agent.name} (${agent.kind}, ${agent.status}, ${agent.sendable ? 'sendable' : 'not sendable'}, ${agent.session_id})`)
            .join('\n'),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      if (exec.agent === undefined) {
        throw new Error('ListAgents requires an exact calling Agent')
      }
      const contacts = await listAgentContacts(ctx, exec.agent, exec.signal)
      return { agents: contacts.map(contactValue) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'SendMessage',
    description: 'Send a message to one named local DSH Session or direct continuable subagent. Name resolution fails on ambiguity rather than broadcasting. A queued or accepted result does not mean the recipient model has finished processing it.',
    parameters: {
      recipient: {
        type: 'string',
        required: true,
        description: 'Exact Session id or the unique name returned by ListAgents.',
      },
      message: {
        type: 'string',
        required: true,
        description: 'The information, decision, status, question, or dependency update to deliver.',
      },
      reply_to: {
        type: 'string',
        description: 'Optional message id being answered.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message_id: { type: 'string', required: true },
          recipient_session_id: { type: 'string', required: true },
          recipient_name: { type: 'string', required: true },
          recipient_kind: { type: 'string', required: true, enum: ['session', 'subagent'] },
          status: {
            type: 'string',
            required: true,
            enum: ['queued', 'accepted', 'claimed', 'failed', 'expired'],
          },
          created_at: { type: 'integer', required: true },
          updated_at: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `message ${value.message_id} ${value.status} for ${value.recipient_name} (${value.recipient_session_id})`,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec.agent === undefined) {
        throw new Error('SendMessage requires an exact calling Agent')
      }
      const contacts = await listAgentContacts(ctx, exec.agent, exec.signal)
      const recipient = resolveAgentContact(contacts, args.recipient)
      const receipt = await sendAgentContactMessage(ctx, exec.agent, recipient, args.message, {
        signal: exec.signal,
        ...(args.reply_to === undefined ? {} : { replyTo: MessageId(args.reply_to) }),
      })
      return {
        message_id: receipt.messageId,
        recipient_session_id: receipt.recipientSessionId,
        recipient_name: receipt.recipientName,
        recipient_kind: receipt.recipientKind,
        status: receipt.status,
        created_at: receipt.createdAt,
        updated_at: receipt.updatedAt,
      }
    },
  }))
}
