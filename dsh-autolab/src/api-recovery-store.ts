import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

import type { ApiRecoveryRecord, ApiRecoveryStore } from './api-recovery.js'
import { canonicalJson } from './integrity.js'

const hash = z.string().regex(/^[0-9a-f]{64}$/u)
const nonBlank = z.string().min(1)

const failureSchema = z.object({
  message: z.string(),
  code: nonBlank,
  status: z.number().int().optional(),
  providerRetryAfterMs: z.number().finite().positive().optional(),
  requestId: nonBlank.optional(),
}).strict()

const goalContinuationSchema = z.object({
  kind: z.literal('goal'),
  goalRef: z.object({
    id: nonBlank,
    revision: z.number().int().positive(),
  }).strict(),
  objectiveHash: hash,
}).strict()

const reviewContinuationSchema = z.object({
  kind: z.literal('review'),
  reviewId: nonBlank,
  reviewAnchorHash: hash,
}).strict()

const continuationSchema = z.discriminatedUnion('kind', [
  goalContinuationSchema,
  reviewContinuationSchema,
])

const base = {
  labId: nonBlank,
  roleId: nonBlank,
  sessionId: nonBlank,
  assignmentId: nonBlank,
  packetHash: hash,
  continuation: continuationSchema,
  turn: z.number().int().positive(),
  step: z.number().int().positive(),
  provider: nonBlank,
  failure: failureSchema,
  recordedAt: z.number().int().nonnegative(),
  unknownFallbackUsed: z.boolean(),
} as const

const terminal = {
  terminalSeq: z.number().int().nonnegative(),
} as const

const rawApiRecoveryRecordSchema = z.discriminatedUnion('phase', [
  z.object({ ...base, phase: z.literal('awaiting-terminal') }).strict(),
  z.object({
    ...base,
    ...terminal,
    phase: z.literal('scheduled'),
    dueAt: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    ...base,
    ...terminal,
    phase: z.literal('recovering'),
    resumedContinuation: continuationSchema,
    resumedAt: z.number().int().nonnegative(),
  }).strict(),
  z.object({ ...base, ...terminal, phase: z.literal('operator') }).strict(),
])

/** Durable form of the one active API incident attached to a Session. */
export const apiRecoveryRecordSchema: z.ZodType<ApiRecoveryRecord> =
  rawApiRecoveryRecordSchema.transform(value => value as ApiRecoveryRecord)

/**
 * Small adapter over one DSH domain table. Per-Session serialization makes the
 * compare-before-delete contract exact: an old timer can never delete a newer
 * incident, while unrelated Sessions remain independent.
 */
export class DurableApiRecoveryStore implements ApiRecoveryStore {
  private readonly tails = new Map<string, Promise<void>>()

  constructor(private readonly table: KvTable<string, ApiRecoveryRecord>) {}

  get(sessionId: string): ApiRecoveryRecord | undefined {
    return this.table.get(sessionId)
  }

  list(): readonly ApiRecoveryRecord[] {
    return [...this.table.entries()].map(([, record]) => record)
  }

  async put(record: ApiRecoveryRecord): Promise<void> {
    const value = apiRecoveryRecordSchema.parse(record)
    await this.enqueue(value.sessionId, async () => {
      await this.table.put(value.sessionId, value)
    })
  }

  async remove(expected: ApiRecoveryRecord): Promise<boolean> {
    const value = apiRecoveryRecordSchema.parse(expected)
    return await this.enqueue(value.sessionId, async () => {
      const current = this.table.get(value.sessionId)
      if (current === undefined || canonicalJson(current) !== canonicalJson(value)) return false
      return await this.table.delete(value.sessionId)
    })
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.tails.values()])
  }

  private enqueue<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve()
    const run = previous.then(operation)
    const tail = run.then(() => undefined, () => undefined)
    this.tails.set(sessionId, tail)
    void tail.finally(() => {
      if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId)
    })
    return run
  }
}
