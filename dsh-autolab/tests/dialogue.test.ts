import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'

import { DialogueLog, canonicalJson } from '../src/dialogue.js'

const LAB_ID = 'lab-20260815-040000-1234abcd'
const roots: string[] = []

async function fixture(): Promise<{ root: string; log: DialogueLog }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-autolab-dialogue-'))
  roots.push(root)
  const labsRoot = join(root, 'labs')
  await mkdir(join(labsRoot, LAB_ID, 'dialogue'), { recursive: true })
  return { root, log: new DialogueLog(labsRoot) }
}

function event(seq: number, type: SessionEvent['type'], data: unknown): SessionEvent {
  return { seq, time: 100 + seq, type, data } as SessionEvent
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('DialogueLog', () => {
  it('archives exact semantic Session events in a verified hash chain', async () => {
    const { log } = await fixture()
    await log.initialize({
      labId: LAB_ID,
      controllerSessionId: 'controller',
      timestamp: 1,
      sourceDirectory: '/tmp/source config',
    })
    const events = [
      event(7, 'command/run', {
        commandId: 'command-1',
        name: 'autolab',
        args: ' create /tmp/source config',
        source: { kind: 'user' },
      }),
      event(8, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text_delta', text: 'ignored duplicate' } }),
      event(9, 'user/message', {
        id: 'message-1',
        role: 'user',
        content: [{ type: 'text', text: '保留这段原文  \n' }],
        source: { kind: 'user' },
      }),
      event(10, 'assistant/message', {
        turn: 1,
        step: 1,
        message: {
          id: 'message-2',
          role: 'assistant',
          content: [{ type: 'text', text: '完整回应\n' }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      }),
    ]

    const firstHead = await log.appendSessionEvents({
      labId: LAB_ID,
      controllerSessionId: 'controller',
      events,
      fromSeq: 7,
    })
    expect(firstHead).toMatchObject({ sequence: 4, lastSessionEventSeq: 10 })
    const records = await log.read(LAB_ID)
    expect(records.map(record => record.recordKind)).toEqual([
      'begin_create',
      'command',
      'user_message',
      'controller_message',
    ])
    expect(records[2]!.payload).toEqual(events[2])
    expect(records.every(record => /^[0-9a-f]{64}$/u.test(record.recordHash))).toBe(true)

    await expect(log.appendSessionEvents({
      labId: LAB_ID,
      controllerSessionId: 'controller',
      events,
      fromSeq: 7,
    })).resolves.toEqual(firstHead)
  })

  it('rejects tampering and incomplete trailing records', async () => {
    const { log } = await fixture()
    await log.initialize({ labId: LAB_ID, controllerSessionId: 'controller', timestamp: 1 })
    const path = log.path(LAB_ID)
    const original = await readFile(path, 'utf8')
    await writeFile(path, original.replace('begin_create', 'acceptance'))
    await expect(log.read(LAB_ID)).rejects.toMatchObject({ code: 'DIALOGUE_CORRUPT' })

    await writeFile(path, `${original}{"partial":`)
    await expect(log.read(LAB_ID)).rejects.toMatchObject({ code: 'DIALOGUE_CORRUPT' })
  })

  it('binds appends to the exact Controller Session', async () => {
    const { log } = await fixture()
    await log.initialize({ labId: LAB_ID, controllerSessionId: 'controller', timestamp: 1 })
    await expect(log.appendControllerRecord({
      labId: LAB_ID,
      controllerSessionId: 'other',
      timestamp: 2,
      recordKind: 'acceptance',
      payload: { text: '按这个创建' },
    })).rejects.toMatchObject({ code: 'CONTROLLER_MISMATCH' })
  })
})

describe('canonicalJson', () => {
  it('sorts object keys without changing array order', () => {
    expect(canonicalJson({ z: 1, a: [{ y: 2, x: 1 }] }))
      .toBe('{"a":[{"x":1,"y":2}],"z":1}')
    expect(() => canonicalJson({ bad: Number.NaN })).toThrow(/NaN|Infinity/u)
  })
})
