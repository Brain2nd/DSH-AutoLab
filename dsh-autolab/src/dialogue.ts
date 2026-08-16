import { open, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { SessionEvent } from '@deepseek-ai/dsh-session'

import { durableWriteFile } from './artifacts.js'
import { canonicalJson, sha256 } from './integrity.js'
import { validateLabId } from './state.js'

export { canonicalJson } from './integrity.js'

const ZERO_HASH = '0'.repeat(64)
const RECORD_DOMAIN = 'autolab-config-record-v1'

export type DialogueRecordKind =
  | 'begin_create'
  | 'user_message'
  | 'controller_message'
  | 'command'
  | 'discovery'
  | 'configure_action'
  | 'acceptance'
  | 'rejection'

export interface DialogueRecord {
  readonly recordVersion: 1
  readonly labId: string
  readonly sequence: number
  readonly timestamp: number
  readonly recordKind: DialogueRecordKind
  readonly source:
    | {
        readonly kind: 'controller'
        readonly controllerSessionId: string
      }
    | {
        readonly kind: 'dsh_session_event'
        readonly sessionId: string
        readonly eventSeq: number
        readonly eventType: string
      }
  /** Exact lossless-JSON payload or an immutable locator with its hash. */
  readonly payload: unknown
  readonly contentSha256: string
  readonly relatedRevision?: number
  readonly prevHash: string
  readonly recordHash: string
}

export interface DialogueHead {
  readonly sequence: number
  readonly recordHash: string
  readonly lastSessionEventSeq?: number
}

export class DialogueError extends Error {
  readonly name = 'DialogueError'

  constructor(
    message: string,
    readonly code:
      | 'DIALOGUE_MISSING'
      | 'DIALOGUE_CORRUPT'
      | 'CONTROLLER_MISMATCH'
      | 'EVENT_GAP',
  ) {
    super(message)
  }
}

/**
 * Append-only configuration transcript.
 *
 * This is deliberately not a live listener. The Controller snapshots exact
 * durable Session events at explicit configuration boundaries, keeping the
 * normal research path free of another recorder or daemon.
 */
export class DialogueLog {
  constructor(private readonly labsRoot: string) {}

  path(labId: string): string {
    return join(this.labsRoot, validateLabId(labId), 'dialogue', 'creation.jsonl')
  }

  async initialize(input: {
    labId: string
    controllerSessionId: string
    timestamp: number
    sourceDirectory?: string
  }): Promise<DialogueHead> {
    const payload = {
      controllerSessionId: input.controllerSessionId,
      ...(input.sourceDirectory === undefined
        ? {}
        : { sourceDirectory: input.sourceDirectory }),
    }
    const first = makeRecord({
      labId: input.labId,
      sequence: 1,
      timestamp: input.timestamp,
      recordKind: 'begin_create',
      source: { kind: 'controller', controllerSessionId: input.controllerSessionId },
      payload,
      prevHash: ZERO_HASH,
    })
    await durableWriteFile(this.path(input.labId), `${JSON.stringify(first)}\n`, false)
    return { sequence: 1, recordHash: first.recordHash }
  }

  async appendSessionEvents(input: {
    labId: string
    controllerSessionId: string
    events: readonly SessionEvent[]
    fromSeq?: number
  }): Promise<DialogueHead> {
    const records = await this.read(input.labId)
    assertControllerSession(records, input.controllerSessionId)
    const current = headOf(records)
    const lowerBound = Math.max(
      input.fromSeq ?? 0,
      current.lastSessionEventSeq === undefined ? 0 : current.lastSessionEventSeq + 1,
    )
    const selected = input.events
      .filter(event => event.seq >= lowerBound)
      .filter(isConfigurationEvent)

    if (selected.length === 0) return current

    const additions: DialogueRecord[] = []
    let sequence = current.sequence
    let prevHash = current.recordHash
    for (const event of selected) {
      sequence += 1
      const record = makeRecord({
        labId: input.labId,
        sequence,
        timestamp: event.time,
        recordKind: classifyEvent(event),
        source: {
          kind: 'dsh_session_event',
          sessionId: input.controllerSessionId,
          eventSeq: event.seq,
          eventType: event.type,
        },
        payload: event,
        prevHash,
      })
      additions.push(record)
      prevHash = record.recordHash
    }
    await appendLines(this.path(input.labId), additions)
    return headOf([...records, ...additions])
  }

  async appendControllerRecord(input: {
    labId: string
    controllerSessionId: string
    timestamp: number
    recordKind: Exclude<DialogueRecordKind, 'begin_create' | 'user_message' | 'controller_message' | 'command'>
    payload: unknown
    relatedRevision?: number
  }): Promise<DialogueHead> {
    const records = await this.read(input.labId)
    assertControllerSession(records, input.controllerSessionId)
    const current = headOf(records)
    const record = makeRecord({
      labId: input.labId,
      sequence: current.sequence + 1,
      timestamp: input.timestamp,
      recordKind: input.recordKind,
      source: { kind: 'controller', controllerSessionId: input.controllerSessionId },
      payload: input.payload,
      ...(input.relatedRevision === undefined ? {} : { relatedRevision: input.relatedRevision }),
      prevHash: current.recordHash,
    })
    await appendLines(this.path(input.labId), [record])
    return headOf([...records, record])
  }

  async head(labId: string): Promise<DialogueHead> {
    return headOf(await this.read(labId))
  }

  async read(labId: string): Promise<DialogueRecord[]> {
    let text: string
    try {
      text = await readFile(this.path(labId), 'utf8')
    } catch (error) {
      throw new DialogueError(
        `cannot read dialogue log: ${error instanceof Error ? error.message : String(error)}`,
        'DIALOGUE_MISSING',
      )
    }
    if (!text.endsWith('\n')) {
      throw new DialogueError('dialogue log has an incomplete trailing record', 'DIALOGUE_CORRUPT')
    }
    const records: DialogueRecord[] = []
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        throw new DialogueError('dialogue log contains malformed JSON', 'DIALOGUE_CORRUPT')
      }
      const record = parseRecord(value)
      const previous = records.at(-1)
      const expectedSequence = (previous?.sequence ?? 0) + 1
      const expectedPrevHash = previous?.recordHash ?? ZERO_HASH
      if (record.labId !== labId
        || record.sequence !== expectedSequence
        || record.prevHash !== expectedPrevHash
        || computeRecordHash(record) !== record.recordHash) {
        throw new DialogueError('dialogue hash chain is invalid', 'DIALOGUE_CORRUPT')
      }
      records.push(record)
    }
    if (records.length === 0) {
      throw new DialogueError('dialogue log is empty', 'DIALOGUE_CORRUPT')
    }
    return records
  }
}

function makeRecord(input: Omit<DialogueRecord, 'recordVersion' | 'contentSha256' | 'recordHash'>): DialogueRecord {
  const withoutHash = {
    recordVersion: 1 as const,
    ...input,
    contentSha256: sha256(canonicalJson(input.payload)),
  }
  return {
    ...withoutHash,
    recordHash: hashRecordWithoutHash(withoutHash),
  }
}

function computeRecordHash(record: DialogueRecord): string {
  const { recordHash: _recordHash, ...withoutHash } = record
  if (sha256(canonicalJson(record.payload)) !== record.contentSha256) return ''
  return hashRecordWithoutHash(withoutHash)
}

function hashRecordWithoutHash(value: Omit<DialogueRecord, 'recordHash'>): string {
  return sha256(`${RECORD_DOMAIN}\0${value.prevHash}\0${canonicalJson(value)}`)
}

function parseRecord(value: unknown): DialogueRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DialogueError('dialogue record must be an object', 'DIALOGUE_CORRUPT')
  }
  const record = value as Record<string, unknown>
  if (record.recordVersion !== 1
    || typeof record.labId !== 'string'
    || !Number.isSafeInteger(record.sequence)
    || (record.sequence as number) <= 0
    || !Number.isSafeInteger(record.timestamp)
    || (record.timestamp as number) < 0
    || typeof record.recordKind !== 'string'
    || !isRecordKind(record.recordKind)
    || typeof record.source !== 'object'
    || record.source === null
    || !('payload' in record)
    || typeof record.contentSha256 !== 'string'
    || !/^[0-9a-f]{64}$/u.test(record.contentSha256)
    || typeof record.prevHash !== 'string'
    || !/^[0-9a-f]{64}$/u.test(record.prevHash)
    || typeof record.recordHash !== 'string'
    || !/^[0-9a-f]{64}$/u.test(record.recordHash)
    || (record.relatedRevision !== undefined
      && (!Number.isSafeInteger(record.relatedRevision) || (record.relatedRevision as number) <= 0))) {
    throw new DialogueError('dialogue record schema is invalid', 'DIALOGUE_CORRUPT')
  }
  const source = record.source as Record<string, unknown>
  const validSource = source.kind === 'controller'
    ? typeof source.controllerSessionId === 'string'
    : source.kind === 'dsh_session_event'
      && typeof source.sessionId === 'string'
      && Number.isSafeInteger(source.eventSeq)
      && (source.eventSeq as number) >= 0
      && typeof source.eventType === 'string'
  if (!validSource) {
    throw new DialogueError('dialogue record source is invalid', 'DIALOGUE_CORRUPT')
  }
  return value as DialogueRecord
}

function isRecordKind(value: string): value is DialogueRecordKind {
  return value === 'begin_create'
    || value === 'user_message'
    || value === 'controller_message'
    || value === 'command'
    || value === 'discovery'
    || value === 'configure_action'
    || value === 'acceptance'
    || value === 'rejection'
}

function isConfigurationEvent(event: SessionEvent): boolean {
  return event.type === 'user/message'
    || event.type === 'assistant/message'
    || event.type === 'command/run'
    || event.type === 'command/done'
    || event.type === 'tool/call'
    || event.type === 'tool/result'
}

function classifyEvent(event: SessionEvent): DialogueRecordKind {
  if (event.type === 'user/message') return 'user_message'
  if (event.type === 'assistant/message') return 'controller_message'
  if (event.type === 'command/run') return 'command'
  if (event.type === 'tool/call' || event.type === 'tool/result') return 'discovery'
  return 'configure_action'
}

function assertControllerSession(records: readonly DialogueRecord[], controllerSessionId: string): void {
  const first = records[0]
  if (first?.source.kind !== 'controller'
    || first.source.controllerSessionId !== controllerSessionId) {
    throw new DialogueError('dialogue belongs to another Controller Session', 'CONTROLLER_MISMATCH')
  }
}

function headOf(records: readonly DialogueRecord[]): DialogueHead {
  const last = records.at(-1)
  if (last === undefined) throw new DialogueError('dialogue log is empty', 'DIALOGUE_CORRUPT')
  let lastSessionEventSeq: number | undefined
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const source = records[index]!.source
    if (source.kind === 'dsh_session_event') {
      lastSessionEventSeq = source.eventSeq
      break
    }
  }
  return {
    sequence: last.sequence,
    recordHash: last.recordHash,
    ...(lastSessionEventSeq === undefined ? {} : { lastSessionEventSeq }),
  }
}

async function appendLines(path: string, records: readonly DialogueRecord[]): Promise<void> {
  if (records.length === 0) return
  const handle = await open(path, 'a', 0o600)
  try {
    await handle.writeFile(records.map(record => `${JSON.stringify(record)}\n`).join(''), 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}
