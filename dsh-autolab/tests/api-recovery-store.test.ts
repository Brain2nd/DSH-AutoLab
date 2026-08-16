import { describe, expect, it } from 'vitest'

import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import {
  DurableApiRecoveryStore,
  apiRecoveryRecordSchema,
} from '../src/api-recovery-store.js'
import type { ApiRecoveryRecord } from '../src/api-recovery.js'

class MemoryTable implements KvTable<string, ApiRecoveryRecord> {
  private readonly records = new Map<string, ApiRecoveryRecord>()

  get(key: string): ApiRecoveryRecord | undefined {
    return this.records.get(key)
  }

  entries(): IterableIterator<[string, ApiRecoveryRecord]> {
    return new Map(this.records).entries()
  }

  keys(): IterableIterator<string> {
    return new Map(this.records).keys()
  }

  get size(): number {
    return this.records.size
  }

  async put(key: string, value: ApiRecoveryRecord): Promise<void> {
    await Promise.resolve()
    this.records.set(key, value)
  }

  async delete(key: string): Promise<boolean> {
    await Promise.resolve()
    return this.records.delete(key)
  }

  async update(
    key: string,
    transform: (current: ApiRecoveryRecord) => ApiRecoveryRecord,
  ): Promise<ApiRecoveryRecord> {
    const current = this.records.get(key)
    if (current === undefined) throw new Error('missing key')
    const next = transform(current)
    this.records.set(key, next)
    return next
  }
}

function record(turn: number, phase: 'scheduled' | 'operator' = 'scheduled'): ApiRecoveryRecord {
  const common = {
    phase,
    labId: 'lab-20260815-120000-1234abcd',
    roleId: 'lane-a-method',
    sessionId: 'session-method',
    assignmentId: 'assignment-method',
    packetHash: 'a'.repeat(64),
    continuation: {
      kind: 'goal' as const,
      goalRef: { id: 'goal-method', revision: turn },
      objectiveHash: 'b'.repeat(64),
    },
    turn,
    step: 1,
    provider: 'provider-a',
    failure: { message: 'temporary', code: 'TRANSPORT' },
    recordedAt: turn,
    unknownFallbackUsed: false,
    terminalSeq: turn,
  }
  return phase === 'scheduled'
    ? apiRecoveryRecordSchema.parse({ ...common, dueAt: turn + 10 })
    : apiRecoveryRecordSchema.parse(common)
}

describe('durable API recovery store', () => {
  it('persists only the current record and compares the complete expected value on remove', async () => {
    const store = new DurableApiRecoveryStore(new MemoryTable())
    const first = record(1)
    const second = record(2)
    await store.put(first)
    await store.put(second)
    expect(await store.remove(first)).toBe(false)
    expect(store.get(second.sessionId)).toEqual(second)
    expect(await store.remove(second)).toBe(true)
    expect(store.list()).toEqual([])
  })

  it('serializes same-Session remove/replace races without blocking another Session', async () => {
    const store = new DurableApiRecoveryStore(new MemoryTable())
    const first = record(1)
    const second = record(2, 'operator')
    await store.put(first)
    const [removed] = await Promise.all([
      store.remove(first),
      store.put(second),
    ])
    expect(removed).toBe(true)
    expect(store.get(second.sessionId)).toEqual(second)
    await store.drain()
  })
})
