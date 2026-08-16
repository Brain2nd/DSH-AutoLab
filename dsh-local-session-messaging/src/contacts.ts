/** Shared contact projection used by the model tool and human command surfaces. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentListEntry } from '@deepseek-ai/dsh-subagent'
import {
  SessionMessagingError,
  type PeerMessageReceipt,
  type PeerSessionSnapshot,
} from './service.js'

export type SessionContact = {
  readonly kind: 'session'
  readonly sessionId: string
  readonly name: string
  readonly status: 'running' | 'idle' | 'disconnected'
  readonly sendable: boolean
  readonly cwd?: string
}

export type SubagentContact = {
  readonly kind: 'subagent'
  readonly sessionId: string
  readonly name: string
  readonly status: 'running' | 'inactive'
  readonly sendable: boolean
  readonly mode: 'one-shot' | 'continuable'
  readonly hasChildren: boolean
}

export type AgentContact = SessionContact | SubagentContact

export interface ContactSendReceipt {
  readonly messageId: string
  readonly recipientSessionId: string
  readonly recipientName: string
  readonly recipientKind: AgentContact['kind']
  readonly status: 'queued' | 'accepted' | 'claimed' | 'failed' | 'expired'
  readonly createdAt: number
  readonly updatedAt: number
}

function subagentContact(entry: Extract<SubagentListEntry, { kind: 'child' }>): SubagentContact {
  const id = String(entry.id)
  return {
    kind: 'subagent',
    sessionId: id,
    name: entry.label ?? `subagent-${id.slice(-8)}`,
    status: entry.activity,
    sendable: entry.mode === 'continuable',
    mode: entry.mode,
    hasChildren: entry.hasChildren,
  }
}

function sessionContact(peer: PeerSessionSnapshot): SessionContact {
  return {
    kind: 'session',
    sessionId: String(peer.sessionId),
    name: peer.name,
    status: peer.connection === 'disconnected' ? 'disconnected' : (peer.agentStatus ?? 'idle'),
    sendable: peer.sendable,
    ...(peer.cwd === undefined ? {} : { cwd: peer.cwd }),
  }
}

/** List independent Sessions plus only the caller's direct durable children. */
export async function listAgentContacts(
  ctx: Context,
  caller: Agent,
  signal?: AbortSignal,
): Promise<AgentContact[]> {
  const [peers, children] = await Promise.all([
    ctx.sessionMessaging.listPeers(caller, signal),
    ctx.subagents.listChildren(caller.id, signal),
  ])
  return [
    ...children
      .filter((entry): entry is Extract<SubagentListEntry, { kind: 'child' }> => entry.kind === 'child')
      .map(subagentContact),
    ...peers.map(sessionContact),
  ]
}

/** Exact ids win; display names must resolve uniquely across both namespaces. */
export function resolveAgentContact(contacts: readonly AgentContact[], address: string): AgentContact {
  const normalized = address.trim()
  if (normalized.length === 0) {
    throw new SessionMessagingError('recipient must not be empty', 'UNKNOWN_TARGET')
  }

  const exactIds = contacts.filter((contact) => contact.sessionId === normalized)
  if (exactIds.length === 1) return exactIds[0]!
  if (exactIds.length > 1) {
    throw new SessionMessagingError(
      `Session id ${JSON.stringify(normalized)} appears in more than one contact namespace`,
      'SESSION_CONFLICT',
    )
  }

  const exactNames = contacts.filter((contact) => contact.name === normalized)
  const matches = exactNames.length > 0
    ? exactNames
    : contacts.filter((contact) => contact.name.toLowerCase() === normalized.toLowerCase())

  if (matches.length === 0) {
    throw new SessionMessagingError(
      `no local Session or direct subagent is named ${JSON.stringify(normalized)}`,
      'UNKNOWN_TARGET',
    )
  }
  if (matches.length > 1) {
    const ids = matches.map((contact) => contact.sessionId).join(', ')
    throw new SessionMessagingError(
      `recipient ${JSON.stringify(normalized)} is ambiguous; use an exact Session id (${ids})`,
      'AMBIGUOUS_TARGET',
    )
  }
  return matches[0]!
}

function peerReceipt(receipt: PeerMessageReceipt): ContactSendReceipt {
  return {
    messageId: String(receipt.messageId),
    recipientSessionId: String(receipt.recipientSessionId),
    recipientName: receipt.recipientName,
    recipientKind: 'session',
    status: receipt.status,
    createdAt: receipt.createdAt,
    updatedAt: receipt.updatedAt,
  }
}

/** Route through the DSH subagent service or the independent-session seam. */
export async function sendAgentContactMessage(
  ctx: Context,
  caller: Agent,
  contact: AgentContact,
  text: string,
  options: { readonly replyTo?: MessageId; readonly signal: AbortSignal },
): Promise<ContactSendReceipt> {
  if (contact.kind === 'session') {
    return peerReceipt(await ctx.sessionMessaging.send(caller, {
      recipient: contact.sessionId,
      text,
      ...(options.replyTo === undefined ? {} : { replyTo: options.replyTo }),
    }, options.signal))
  }

  if (!contact.sendable || contact.mode !== 'continuable') {
    throw new SessionMessagingError(
      `subagent ${JSON.stringify(contact.name)} is one-shot and cannot accept follow-up messages`,
      'UNKNOWN_TARGET',
    )
  }

  const deliveredText = options.replyTo === undefined
    ? text
    : `[Reply to message ${String(options.replyTo)}]\n${text}`
  const messageId = await ctx.subagents.followup(
    caller,
    SessionId(contact.sessionId),
    [{ type: 'text', text: deliveredText }],
    {
      source: {
        kind: 'coordinator',
        form: 'relay',
        senderSessionId: caller.id,
      },
      signal: options.signal,
    },
  )
  const now = Date.now()
  return {
    messageId: String(messageId),
    recipientSessionId: contact.sessionId,
    recipientName: contact.name,
    recipientKind: 'subagent',
    status: 'accepted',
    createdAt: now,
    updatedAt: now,
  }
}
