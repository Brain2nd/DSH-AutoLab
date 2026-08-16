import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'

import { afterEach, describe, expect, it } from 'vitest'

import { MessagingDatabase } from '../src/database.js'
import { MessagingError, type JsonValue, type PresenceSnapshot } from '../src/domain.js'

const MESSAGE_1 = '00000000-0000-4000-8000-000000000001'
const MESSAGE_2 = '00000000-0000-4000-8000-000000000002'
const MESSAGE_3 = '00000000-0000-4000-8000-000000000003'
const MESSAGE_4 = '00000000-0000-4000-8000-000000000004'
const WRITER_OWNER_1 = '00000000-0000-4000-8000-000000000101'
const WRITER_OWNER_2 = '00000000-0000-4000-8000-000000000102'
const WRITER_OWNER_3 = '00000000-0000-4000-8000-000000000103'

interface Fixture {
  readonly root: string
  readonly path: string
  readonly database: MessagingDatabase
  now: number
}

const fixtures: Fixture[] = []

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.database.close()
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

function fixture(start = 1_000, busyTimeoutMs?: number): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'dsh-messaging-db-'))
  chmodSync(root, 0o700)
  const path = join(root, 'messages.sqlite')
  let result!: Fixture
  const database = new MessagingDatabase({
    path,
    clock: () => result.now,
    ...(busyTimeoutMs === undefined ? {} : { busyTimeoutMs }),
  })
  result = { root, path, now: start, database }
  fixtures.push(result)
  return result
}

function acquire(
  state: Fixture,
  instanceId = 'instance-a',
  leaseMs = 10_000,
): PresenceSnapshot {
  return acquireRecipient(state, 'recipient', instanceId, leaseMs)
}

function acquireRecipient(
  state: Fixture,
  sessionId: string,
  instanceId: string,
  leaseMs: number,
): PresenceSnapshot {
  return state.database.upsertPresence({
    sessionId,
    instanceId,
    endpoint: { socketPath: join(state.root, `${sessionId}-${instanceId}.sock`) },
    agentStatus: 'idle',
    leaseMs,
  })
}

function enqueue(
  state: Fixture,
  messageId = MESSAGE_1,
  overrides: Partial<{
    payload: JsonValue
    ttlMs: number
    maxAttempts: number
    senderSessionId: string
    recipientSessionId: string
    senderPrincipalSessionId: string
    recipientPrincipalSessionId: string
    deliveryMode: 'followup' | 'steer'
    channel: 'text' | 'control'
  }> = {},
) {
  return state.database.enqueue({
    messageId,
    senderSessionId: overrides.senderSessionId ?? 'sender',
    recipientSessionId: overrides.recipientSessionId ?? 'recipient',
    senderPrincipalSessionId: overrides.senderPrincipalSessionId ?? 'principal-sender',
    recipientPrincipalSessionId: overrides.recipientPrincipalSessionId ?? 'principal-recipient',
    ...(overrides.channel === undefined ? {} : { channel: overrides.channel }),
    deliveryMode: overrides.deliveryMode ?? 'followup',
    payload: overrides.payload ?? { text: 'hello' },
    ttlMs: overrides.ttlMs ?? 5_000,
    maxAttempts: overrides.maxAttempts ?? 3,
  })
}

function expectCode(operation: () => unknown, code: MessagingError['code']): void {
  try {
    operation()
    throw new Error(`expected ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(MessagingError)
    expect((error as MessagingError).code).toBe(code)
  }
}

describe('MessagingDatabase presence fencing', () => {
  it('fails closed for a live conflicting instance and increments fences on takeover/release', () => {
    const state = fixture()
    const first = acquire(state, 'instance-a', 100)
    expect(first.fenceToken).toBe(1)

    state.now = 1_050
    const renewed = acquire(state, 'instance-a', 100)
    expect(renewed.fenceToken).toBe(1)
    expect(renewed.expiresAt).toBe(1_150)
    expectCode(() => acquire(state, 'instance-b', 100), 'SESSION_CONFLICT')

    state.now = 1_150
    const takeover = acquire(state, 'instance-b', 100)
    expect(takeover.fenceToken).toBe(2)
    expectCode(() => state.database.heartbeatPresence({
      sessionId: 'recipient',
      instanceId: 'instance-a',
      fenceToken: first.fenceToken,
      leaseMs: 100,
    }), 'FENCE_LOST')

    state.now = 1_160
    const released = state.database.releasePresence({
      sessionId: 'recipient',
      instanceId: 'instance-b',
      fenceToken: takeover.fenceToken,
    })
    expect(released.active).toBe(false)
    expect(released.endpoint).toBeUndefined()
    expect(released.fenceToken).toBe(3)

    const third = acquire(state, 'instance-c', 100)
    expect(third.fenceToken).toBe(4)
  })

  it('does not let heartbeat resurrect an elapsed lease', () => {
    const state = fixture()
    const owner = acquire(state, 'instance-a', 10)
    state.now = owner.expiresAt
    expectCode(() => state.database.heartbeatPresence({
      sessionId: owner.sessionId,
      instanceId: owner.instanceId,
      fenceToken: owner.fenceToken,
      leaseMs: 10,
    }), 'FENCE_LOST')
    const reacquired = acquire(state, 'instance-a', 10)
    expect(reacquired.fenceToken).toBe(owner.fenceToken + 1)
  })

  it('returns fresh presence snapshots and fences elapsed rows exactly once', () => {
    const state = fixture()
    acquire(state, 'instance-a', 10)
    const first = state.database.getPresence('recipient')!
    const second = state.database.getPresence('recipient')!
    expect(first).toEqual(second)
    expect(first).not.toBe(second)

    state.now = 1_010
    expect(state.database.expirePresence()).toBe(1)
    expect(state.database.expirePresence()).toBe(0)
    expect(state.database.listPresence()).toEqual([])
    expect(state.database.listPresence({ activeOnly: false })[0]).toMatchObject({
      active: false,
      fenceToken: 2,
    })
  })

  it('projects and heartbeat-updates agent status and optional display metadata', () => {
    const state = fixture()
    const owner = state.database.upsertPresence({
      sessionId: 'recipient',
      instanceId: 'instance-a',
      endpoint: { socketPath: join(state.root, 'instance-a.sock') },
      agentStatus: 'running',
      cwd: '/workspace',
      name: 'worker',
      title: 'Initial title',
      leaseMs: 100,
    })
    expect(owner).toMatchObject({
      agentStatus: 'running',
      cwd: '/workspace',
      name: 'worker',
      title: 'Initial title',
    })
    state.now += 1
    const updated = state.database.heartbeatPresence({
      ...owner,
      leaseMs: 100,
      agentStatus: 'idle',
      title: null,
    })
    expect(updated).toMatchObject({ agentStatus: 'idle', cwd: '/workspace', name: 'worker' })
    expect(updated.title).toBeUndefined()
  })
})

describe('MessagingDatabase Session persistence writer fencing', () => {
  const firstOwner = {
    sessionId: 'writer-session',
    instanceId: 'instance-a',
    ownerToken: WRITER_OWNER_1,
    pid: 101,
    processStartId: 'boot-ticks:1001',
    hostname: 'host-a',
    bootId: 'boot-a',
  } as const

  it('keeps an exact owner idempotent and never treats elapsed presence as writer death', () => {
    const state = fixture()
    const first = state.database.acquireSessionWriter(firstOwner)
    expect(first).toMatchObject({
      ...firstOwner,
      fenceToken: 1,
      active: true,
      acquiredAt: state.now,
    })
    expect(state.database.acquireSessionWriter(firstOwner)).toEqual(first)

    state.now += 1_000_000
    expectCode(() => state.database.acquireSessionWriter({
      ...firstOwner,
      instanceId: 'instance-b',
      ownerToken: WRITER_OWNER_2,
      pid: 202,
      processStartId: 'boot-ticks:2002',
    }), 'SESSION_CONFLICT')
    expect(state.database.getSessionWriter(firstOwner.sessionId)).toEqual(first)
  })

  it('requires an exact takeover identity and CAS-fences every replacement', () => {
    const state = fixture()
    const first = state.database.acquireSessionWriter(firstOwner)
    const secondOwner = {
      ...firstOwner,
      instanceId: 'instance-b',
      ownerToken: WRITER_OWNER_2,
      pid: 202,
      processStartId: 'boot-ticks:2002',
    } as const

    expectCode(() => state.database.acquireSessionWriter({
      ...secondOwner,
      takeover: {
        instanceId: first.instanceId,
        ownerToken: first.ownerToken,
        fenceToken: first.fenceToken + 1,
      },
    }), 'SESSION_CONFLICT')

    state.now += 1
    const second = state.database.acquireSessionWriter({
      ...secondOwner,
      takeover: {
        instanceId: first.instanceId,
        ownerToken: first.ownerToken,
        fenceToken: first.fenceToken,
      },
    })
    expect(second).toMatchObject({ ...secondOwner, fenceToken: 2, active: true })

    expectCode(() => state.database.acquireSessionWriter({
      ...firstOwner,
      instanceId: 'instance-c',
      ownerToken: WRITER_OWNER_3,
      pid: 303,
      processStartId: 'boot-ticks:3003',
      takeover: {
        instanceId: first.instanceId,
        ownerToken: first.ownerToken,
        fenceToken: first.fenceToken,
      },
    }), 'SESSION_CONFLICT')
    expectCode(() => state.database.releaseSessionWriter(first), 'FENCE_LOST')
  })

  it('releases only the exact owner and reacquires an inactive row with a new fence', () => {
    const state = fixture()
    const first = state.database.acquireSessionWriter(firstOwner)
    state.now += 1
    const released = state.database.releaseSessionWriter(first)
    expect(released).toMatchObject({ active: false, releasedAt: state.now, fenceToken: 1 })
    expectCode(() => state.database.releaseSessionWriter(first), 'FENCE_LOST')

    state.now += 1
    const second = state.database.acquireSessionWriter({
      ...firstOwner,
      instanceId: 'instance-b',
      ownerToken: WRITER_OWNER_2,
      pid: 202,
      processStartId: 'boot-ticks:2002',
    })
    expect(second).toMatchObject({ active: true, fenceToken: 2 })
    expect(second.releasedAt).toBeUndefined()
  })

  it('rejects reuse of an owner token with changed process identity', () => {
    const state = fixture()
    state.database.acquireSessionWriter(firstOwner)
    expectCode(() => state.database.acquireSessionWriter({
      ...firstOwner,
      processStartId: 'boot-ticks:reused-pid',
    }), 'SESSION_CONFLICT')
  })
})

describe('MessagingDatabase durable queue', () => {
  it('deduplicates an identical canonical envelope and rejects UUID collisions', () => {
    const state = fixture()
    const inserted = enqueue(state, MESSAGE_1, { payload: { b: 2, a: 1 } })
    expect(inserted.deduplicated).toBe(false)
    const duplicate = enqueue(state, MESSAGE_1, { payload: { a: 1, b: 2 } })
    expect(duplicate.deduplicated).toBe(true)
    expect(duplicate.message.enqueueSequence).toBe(inserted.message.enqueueSequence)
    expectCode(() => enqueue(state, MESSAGE_1, { payload: { a: 2, b: 2 } }), 'MESSAGE_ID_COLLISION')
    expect(state.database.listMessages()).toHaveLength(1)
  })

  it('persists delivery mode as immutable envelope data', () => {
    const state = fixture()
    const inserted = enqueue(state, MESSAGE_1, { deliveryMode: 'steer' })
    expect(inserted.message.deliveryMode).toBe('steer')
    expect(state.database.getMessage(MESSAGE_1)!.deliveryMode).toBe('steer')
    expectCode(() => enqueue(state, MESSAGE_1, { deliveryMode: 'followup' }), 'MESSAGE_ID_COLLISION')
  })

  it('applies directional policy to controls while keeping pair blocks text-only', () => {
    const state = fixture()
    const owner = acquire(state)
    const payloadHash = `sha256:${'a'.repeat(64)}`
    const inserted = enqueue(state, MESSAGE_1, {
      channel: 'control',
      payload: {
        version: 1,
        type: 'control',
        kind: 'test.pause',
        payload: { assignment: 7 },
        payloadHash,
      },
    })
    expect(inserted.message.channel).toBe('control')
    state.database.setPairBlocked({
      firstPrincipalSessionId: 'principal-sender',
      secondPrincipalSessionId: 'principal-recipient',
      blocked: true,
    })
    expect(state.database.getMessage(MESSAGE_1)).toMatchObject({ status: 'queued' })
    expect(state.database.listReconciliationCandidates('recipient')).toEqual([])
    const lease = state.database.claimNextDelivery({
      ...owner,
      recipientSessionId: 'recipient',
      leaseMs: 100,
    })!
    const completed = state.database.completeControlDelivery({
      ...owner,
      messageId: MESSAGE_1,
      leaseToken: lease.lease.token,
      kind: 'test.pause',
      payloadHash,
      outcomeStatus: 'completed',
      result: { paused: true },
    })
    expect(completed.message).toMatchObject({ channel: 'control', status: 'claimed' })
    expect(completed.outcome).toEqual({
      controlId: MESSAGE_1,
      kind: 'test.pause',
      payloadHash,
      status: 'completed',
      result: { paused: true },
      completedAt: state.now,
    })
    expect(state.database.getControlOutcome(MESSAGE_1)).toEqual(completed.outcome)

    const duplicate = enqueue(state, MESSAGE_1, {
      channel: 'control',
      payload: {
        payloadHash,
        payload: { assignment: 7 },
        kind: 'test.pause',
        type: 'control',
        version: 1,
      },
    })
    expect(duplicate.deduplicated).toBe(true)
    expectCode(() => enqueue(state, MESSAGE_1, {
      channel: 'control',
      payload: {
        version: 1,
        type: 'control',
        kind: 'test.pause',
        payload: { assignment: 8 },
        payloadHash,
      },
    }), 'MESSAGE_ID_COLLISION')

    // Existing pair isolation does not block a newly issued mechanical control.
    enqueue(state, MESSAGE_3, {
      channel: 'control',
      payload: {
        version: 1,
        type: 'control',
        kind: 'test.pause',
        payload: { assignment: 9 },
        payloadHash,
      },
    })
    expect(state.database.getMessage(MESSAGE_3)).toMatchObject({ status: 'queued' })

    state.database.setSessionPolicy({
      principalSessionId: 'principal-sender',
      sendAllowed: false,
    })
    expect(state.database.getMessage(MESSAGE_3)).toMatchObject({ status: 'queued' })
    expectCode(() => enqueue(state, MESSAGE_4, {
      channel: 'control',
      payload: {
        version: 1,
        type: 'control',
        kind: 'test.pause',
        payload: { assignment: 10 },
        payloadHash,
      },
    }), 'PERMISSION_DENIED')

    state.database.setSessionPolicy({
      principalSessionId: 'principal-sender',
      sendAllowed: true,
    })
    state.database.setSessionPolicy({
      principalSessionId: 'principal-recipient',
      receiveAllowed: false,
    })
    expectCode(() => enqueue(state, MESSAGE_4, {
      channel: 'control',
      payload: {
        version: 1,
        type: 'control',
        kind: 'test.pause',
        payload: { assignment: 10 },
        payloadHash,
      },
    }), 'PERMISSION_DENIED')
  })

  it('atomically records an exhausted typed-control handler failure', () => {
    const state = fixture()
    const owner = acquire(state)
    const payloadHash = `sha256:${'b'.repeat(64)}`
    enqueue(state, MESSAGE_2, {
      channel: 'control',
      maxAttempts: 1,
      payload: {
        version: 1,
        type: 'control',
        kind: 'test.retry',
        payload: null,
        payloadHash,
      },
    })
    const lease = state.database.claimNextDelivery({
      ...owner,
      recipientSessionId: 'recipient',
      leaseMs: 100,
    })!
    const failed = state.database.retryControlDelivery({
      ...owner,
      messageId: MESSAGE_2,
      leaseToken: lease.lease.token,
      retryDelayMs: 1,
      error: 'handler unavailable',
      kind: 'test.retry',
      payloadHash,
    })
    expect(failed).toMatchObject({
      terminal: true,
      message: { status: 'failed' },
      outcome: { status: 'failed', detail: 'handler unavailable' },
    })
    expect(state.database.getControlOutcome(MESSAGE_2)).toEqual(failed.outcome)
  })

  it('reconciles only accepted or lease-bearing queued rows through the partial recipient index', () => {
    const state = fixture()
    const owner = acquire(state)
    enqueue(state, MESSAGE_1)
    expect(state.database.listReconciliationCandidates('recipient')).toEqual([])

    const lease = state.database.claimNextDelivery({
      ...owner,
      recipientSessionId: 'recipient',
      leaseMs: 100,
    })!
    expect(state.database.listReconciliationCandidates('recipient')).toEqual([
      expect.objectContaining({ messageId: MESSAGE_1, status: 'queued', lease: lease.lease }),
    ])

    state.database.acceptDelivery({
      ...owner,
      messageId: MESSAGE_1,
      leaseToken: lease.lease.token,
    })
    expect(state.database.listReconciliationCandidates('recipient')).toEqual([
      expect.objectContaining({ messageId: MESSAGE_1, status: 'accepted' }),
    ])
    state.database.markClaimed({ ...owner, messageId: MESSAGE_1 })
    expect(state.database.listReconciliationCandidates('recipient')).toEqual([])

    const inspector = new DatabaseSync(state.path)
    try {
      const plan = inspector.prepare(`
        EXPLAIN QUERY PLAN
        SELECT * FROM messages
        WHERE recipient_session_id = ?
          AND (
            status = 'accepted'
            OR (status = 'queued' AND lease_token IS NOT NULL)
          )
        ORDER BY enqueue_seq ASC
      `).all('recipient') as Array<Record<string, unknown>>
      expect(plan.map(row => String(row.detail)).join('\n')).toContain(
        'messages_recipient_reconcile',
      )
    } finally {
      inspector.close()
    }
  })

  it('keeps empty claim and no-op presence expiry read-only under another writer', () => {
    const state = fixture(1_000, 0)
    const owner = acquire(state)
    const writer = new DatabaseSync(state.path, { timeout: 0 })
    writer.exec('BEGIN IMMEDIATE')
    try {
      expect(state.database.expirePresence()).toBe(0)
      expect(state.database.claimNextDelivery({
        ...owner,
        recipientSessionId: 'recipient',
        leaseMs: 100,
      })).toBeUndefined()
    } finally {
      writer.exec('ROLLBACK')
      writer.close()
    }
  })

  it('returns detached message payload snapshots', () => {
    const state = fixture()
    enqueue(state, MESSAGE_1, { payload: { nested: { value: 1 } } })
    const first = state.database.getMessage(MESSAGE_1)!
    ;(first.payload as { nested: { value: number } }).nested.value = 99
    const second = state.database.getMessage(MESSAGE_1)!
    expect(second.payload).toEqual({ nested: { value: 1 } })
    expect(second).not.toBe(first)
  })

  it('enforces strict FIFO, retry backoff, and monotonic accepted/claimed states', () => {
    const state = fixture()
    const owner = acquire(state)
    enqueue(state, MESSAGE_1)
    state.now += 1
    enqueue(state, MESSAGE_2)

    const firstLease = state.database.claimNextDelivery({
      ...owner,
      recipientSessionId: 'recipient',
      leaseMs: 100,
    })!
    expect(firstLease.message.messageId).toBe(MESSAGE_1)
    expect(firstLease.message.attemptCount).toBe(1)
    expect(state.database.claimNextDelivery({
      ...owner,
      recipientSessionId: 'recipient',
      leaseMs: 100,
    })).toBeUndefined()

    state.now += 9
    const retry = state.database.retryDelivery({
      ...owner,
      messageId: MESSAGE_1,
      leaseToken: firstLease.lease.token,
      retryDelayMs: 20,
      error: 'temporary',
    })
    expect(retry.terminal).toBe(false)
    state.now += 19
    expect(state.database.claimNextDelivery({
      ...owner,
      recipientSessionId: 'recipient',
      leaseMs: 100,
    })).toBeUndefined()

    state.now += 1
    const secondLease = state.database.claimNextDelivery({
      ...owner,
      recipientSessionId: 'recipient',
      leaseMs: 100,
    })!
    expect(secondLease.message.messageId).toBe(MESSAGE_1)
    expect(secondLease.message.attemptCount).toBe(2)
    expectCode(() => state.database.acceptDelivery({
      ...owner,
      messageId: MESSAGE_1,
      leaseToken: firstLease.lease.token,
    }), 'LEASE_LOST')

    const accepted = state.database.acceptDelivery({
      ...owner,
      messageId: MESSAGE_1,
      leaseToken: secondLease.lease.token,
    })
    expect(accepted.status).toBe('accepted')
    expect(accepted.lease).toBeUndefined()
    const claimed = state.database.markClaimed({ ...owner, messageId: MESSAGE_1 })
    expect(claimed.status).toBe('claimed')
    expect(state.database.markClaimed({ ...owner, messageId: MESSAGE_1 })).toEqual(claimed)

    const next = state.database.claimNextDelivery({
      ...owner,
      recipientSessionId: 'recipient',
      leaseMs: 100,
    })!
    expect(next.message.messageId).toBe(MESSAGE_2)
    expectCode(() => state.database.failDelivery({
      ...owner,
      messageId: MESSAGE_1,
      leaseToken: secondLease.lease.token,
      error: 'must not regress',
    }), 'INVALID_TRANSITION')
  })

  it('lets a new presence epoch immediately fence and replace an old delivery lease', () => {
    const state = fixture()
    const firstOwner = acquire(state, 'instance-a', 10)
    enqueue(state)
    const firstLease = state.database.claimNextDelivery({
      ...firstOwner,
      recipientSessionId: 'recipient',
      leaseMs: 1_000,
    })!

    state.now = firstOwner.expiresAt
    const secondOwner = acquire(state, 'instance-b', 100)
    expectCode(() => state.database.acceptDelivery({
      ...firstOwner,
      messageId: MESSAGE_1,
      leaseToken: firstLease.lease.token,
    }), 'FENCE_LOST')
    const replacement = state.database.claimNextDelivery({
      ...secondOwner,
      recipientSessionId: 'recipient',
      leaseMs: 100,
    })!
    expect(replacement.message.messageId).toBe(MESSAGE_1)
    expect(replacement.message.attemptCount).toBe(2)
    expect(replacement.lease.token).not.toBe(firstLease.lease.token)
  })

  it('reconciles queued messages directly to claimed or discarded under the current fence', () => {
    const state = fixture()
    const owner = acquire(state)
    enqueue(state, MESSAGE_1)
    const claimed = state.database.markClaimed({ ...owner, messageId: MESSAGE_1 })
    expect(claimed).toMatchObject({ status: 'claimed', acceptedAt: state.now, claimedAt: state.now })

    enqueue(state, MESSAGE_2)
    const discardedQueued = state.database.markDiscarded({
      ...owner,
      messageId: MESSAGE_2,
      error: 'canceled before accept transaction',
    })
    expect(discardedQueued).toMatchObject({ status: 'failed', lastError: 'canceled before accept transaction' })

    enqueue(state, MESSAGE_3)
    const lease = state.database.claimNextDelivery({
      ...owner,
      recipientSessionId: 'recipient',
      leaseMs: 100,
    })!
    state.database.acceptDelivery({
      ...owner,
      messageId: MESSAGE_3,
      leaseToken: lease.lease.token,
    })
    const discardedAccepted = state.database.markDiscarded({
      ...owner,
      messageId: MESSAGE_3,
      error: 'inbox discarded',
    })
    expect(discardedAccepted).toMatchObject({ status: 'failed', lastError: 'inbox discarded' })
    expect(discardedAccepted.acceptedAt).toBeDefined()
  })

  it('recovers an accepted DSH fact across an old delivery lease and presence fence', () => {
    const state = fixture()
    const firstOwner = acquire(state, 'instance-a', 10)
    enqueue(state, MESSAGE_1)
    const oldLease = state.database.claimNextDelivery({
      ...firstOwner,
      recipientSessionId: 'recipient',
      leaseMs: 1_000,
    })!

    state.now = firstOwner.expiresAt
    const recoveringOwner = acquire(state, 'instance-b', 100)
    expectCode(() => state.database.recoverAccepted({
      ...firstOwner,
      messageId: MESSAGE_1,
    }), 'FENCE_LOST')

    const recovered = state.database.recoverAccepted({
      ...recoveringOwner,
      messageId: MESSAGE_1,
    })
    expect(recovered).toMatchObject({
      status: 'accepted',
      attemptCount: 1,
      acceptedAt: state.now,
      acceptedByInstanceId: recoveringOwner.instanceId,
      acceptedByFenceToken: recoveringOwner.fenceToken,
    })
    expect(recovered.lease).toBeUndefined()
    expect(oldLease.lease.ownerInstanceId).toBe(firstOwner.instanceId)
    expect(state.database.recoverAccepted({
      ...recoveringOwner,
      messageId: MESSAGE_1,
    })).toEqual(recovered)

    const claimed = state.database.markClaimed({
      ...recoveringOwner,
      messageId: MESSAGE_1,
    })
    expect(state.database.recoverAccepted({
      ...recoveringOwner,
      messageId: MESSAGE_1,
    })).toEqual(claimed)
  })

  it('requires recoverAccepted to hold the current exact recipient fence', () => {
    const state = fixture()
    enqueue(state, MESSAGE_1)
    const otherOwner = acquireRecipient(state, 'other-recipient', 'instance-other', 100)
    expectCode(() => state.database.recoverAccepted({
      ...otherOwner,
      messageId: MESSAGE_1,
    }), 'FENCE_LOST')
    expect(state.database.getMessage(MESSAGE_1)!.status).toBe('queued')
  })

  it('does not let recoverAccepted reverse failed or expired terminal facts', () => {
    const state = fixture()
    const owner = acquire(state)
    enqueue(state, MESSAGE_1)
    state.database.markDiscarded({
      ...owner,
      messageId: MESSAGE_1,
      error: 'durably canceled',
    })
    expectCode(() => state.database.recoverAccepted({
      ...owner,
      messageId: MESSAGE_1,
    }), 'INVALID_TRANSITION')

    enqueue(state, MESSAGE_2, { ttlMs: 10 })
    state.now = state.database.getMessage(MESSAGE_2)!.expiresAt
    expect(state.database.terminalizeDueForRecipient(owner)).toBe(1)
    expect(state.database.getMessage(MESSAGE_2)!.status).toBe('expired')
    expectCode(() => state.database.recoverAccepted({
      ...owner,
      messageId: MESSAGE_2,
    }), 'INVALID_TRANSITION')
  })

  it('recovers due TTL and exhausted-attempt crash gaps before recipient terminalization', () => {
    const state = fixture()
    const owner = acquire(state)
    enqueue(state, MESSAGE_1, { ttlMs: 10 })
    const ttlLease = state.database.claimNextDelivery({
      ...owner,
      recipientSessionId: 'recipient',
      leaseMs: 100,
    })!
    state.now = ttlLease.message.expiresAt
    const ttlRecovered = state.database.recoverAccepted({
      ...owner,
      messageId: MESSAGE_1,
    })
    expect(ttlRecovered).toMatchObject({ status: 'accepted', acceptedAt: state.now })
    expect(ttlRecovered.lease).toBeUndefined()

    enqueue(state, MESSAGE_2, { maxAttempts: 1, ttlMs: 1_000 })
    const exhaustedLease = state.database.claimNextDelivery({
      ...owner,
      recipientSessionId: 'recipient',
      leaseMs: 10,
    })!
    state.now = exhaustedLease.lease.until
    expect(state.database.getMessage(MESSAGE_2)).toMatchObject({
      status: 'queued',
      attemptCount: 1,
      lease: exhaustedLease.lease,
    })
    expect(state.database.recoverAccepted({
      ...owner,
      messageId: MESSAGE_2,
    })).toMatchObject({ status: 'accepted', acceptedAt: state.now })
    expect(state.database.terminalizeDueForRecipient(owner)).toBe(0)
  })

  it('keeps another offline recipient crash gap queued during claim and lease sweeps', () => {
    const state = fixture()
    const ownerA = acquireRecipient(state, 'recipient-a', 'instance-a', 1_000)
    const ownerB = acquireRecipient(state, 'recipient-b', 'instance-b', 10)
    enqueue(state, MESSAGE_1, {
      recipientSessionId: 'recipient-b',
      recipientPrincipalSessionId: 'principal-b',
      ttlMs: 10,
      maxAttempts: 1,
    })
    const crashGap = state.database.claimNextDelivery({
      ...ownerB,
      recipientSessionId: 'recipient-b',
      leaseMs: 10,
    })!
    enqueue(state, MESSAGE_2, {
      recipientSessionId: 'recipient-a',
      recipientPrincipalSessionId: 'principal-a',
      ttlMs: 1_000,
    })

    state.now = crashGap.lease.until
    expect(state.database.getMessage(MESSAGE_1)).toMatchObject({
      status: 'queued',
      attemptCount: 1,
      lease: crashGap.lease,
    })

    expect(state.database.claimNextDelivery({
      ...ownerA,
      recipientSessionId: 'recipient-a',
      leaseMs: 100,
    })!.message.messageId).toBe(MESSAGE_2)
    expect(state.database.terminalizeDueForRecipient(ownerA)).toBe(0)
    expect(state.database.getMessage(MESSAGE_1)!.status).toBe('queued')

    const recoveringB = acquireRecipient(state, 'recipient-b', 'instance-b-restarted', 100)
    expect(state.database.recoverAccepted({
      ...recoveringB,
      messageId: MESSAGE_1,
    })).toMatchObject({
      status: 'accepted',
      acceptedByInstanceId: 'instance-b-restarted',
      acceptedByFenceToken: recoveringB.fenceToken,
    })
    expect(state.database.terminalizeDueForRecipient(recoveringB)).toBe(0)
  })

  it('leaves leased due facts to the fenced recipient but globally terminalizes unleased facts', () => {
    const state = fixture()
    const owner = acquire(state)
    enqueue(state, MESSAGE_1, { maxAttempts: 1, ttlMs: 1_000 })
    const exhaustedLease = state.database.claimNextDelivery({
      ...owner,
      recipientSessionId: 'recipient',
      leaseMs: 10,
    })!
    expect(exhaustedLease.message.attemptCount).toBe(1)
    state.now = exhaustedLease.lease.until
    expect(state.database.terminalizeDue()).toBe(0)
    expect(state.database.getMessage(MESSAGE_1)).toMatchObject({
      status: 'queued',
      lease: exhaustedLease.lease,
    })
    expect(state.database.terminalizeDueForRecipient(owner)).toBe(1)
    expect(state.database.getMessage(MESSAGE_1)).toMatchObject({ status: 'failed', attemptCount: 1 })

    enqueue(state, MESSAGE_2, { ttlMs: 10 })
    const ttlLease = state.database.claimNextDelivery({
      ...owner,
      recipientSessionId: 'recipient',
      leaseMs: 100,
    })!
    state.now = ttlLease.message.expiresAt
    expect(state.database.terminalizeDue()).toBe(0)
    expect(state.database.getMessage(MESSAGE_2)).toMatchObject({
      status: 'queued',
      lease: ttlLease.lease,
    })
    expect(state.database.terminalizeDueForRecipient(owner)).toBe(1)
    expect(state.database.getMessage(MESSAGE_2)!.status).toBe('expired')

    enqueue(state, MESSAGE_3, { ttlMs: 10 })
    state.now = state.database.getMessage(MESSAGE_3)!.expiresAt
    expect(state.database.terminalizeDue()).toBe(1)
    expect(state.database.getMessage(MESSAGE_3)!.status).toBe('expired')
  })

  it('allows only one lease across two WAL connections', () => {
    const state = fixture()
    const owner = acquire(state)
    enqueue(state)
    const second = new MessagingDatabase({ path: state.path, clock: () => state.now })
    try {
      const one = state.database.claimNextDelivery({
        ...owner,
        recipientSessionId: 'recipient',
        leaseMs: 100,
      })
      const two = second.claimNextDelivery({
        ...owner,
        recipientSessionId: 'recipient',
        leaseMs: 100,
      })
      expect([one, two].filter(Boolean)).toHaveLength(1)
    } finally {
      second.close()
    }
  })

  it('uses WAL/FULL and survives close/reopen with owner-only files', () => {
    const state = fixture()
    enqueue(state, MESSAGE_3)
    const mode = statSync(state.path).mode & 0o777
    expect(mode).toBe(0o600)
    const inspector = new DatabaseSync(state.path)
    try {
      expect(inspector.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' })
      expect(inspector.prepare('PRAGMA synchronous').get()).toMatchObject({ synchronous: 2 })
    } finally {
      inspector.close()
    }

    state.database.close()
    const reopened = new MessagingDatabase({ path: state.path, clock: () => state.now })
    try {
      expect(reopened.getMessage(MESSAGE_3)).toMatchObject({
        messageId: MESSAGE_3,
        status: 'queued',
      })
    } finally {
      reopened.close()
    }
  })

  it('upgrades a schema-v1 mailbox in place without changing relay identity', () => {
    const state = fixture()
    enqueue(state, MESSAGE_3, { payload: { text: 'pre-control-schema' } })
    state.database.close()

    const legacy = new DatabaseSync(state.path)
    try {
      legacy.exec(`
        DROP TABLE session_writers;
        DROP TABLE control_outcomes;
        DROP TABLE pair_blocks;
        DROP TABLE session_policies;
        DROP INDEX messages_sender_principal_queued;
        DROP INDEX messages_recipient_principal_queued;
        ALTER TABLE messages DROP COLUMN channel;
        PRAGMA user_version = 1;
      `)
    } finally {
      legacy.close()
    }

    const upgraded = new MessagingDatabase({ path: state.path, clock: () => state.now })
    try {
      expect(upgraded.getMessage(MESSAGE_3)).toMatchObject({
        messageId: MESSAGE_3,
        channel: 'text',
        payload: { text: 'pre-control-schema' },
      })
      const inspector = new DatabaseSync(state.path, { readOnly: true })
      try {
        expect(inspector.prepare('PRAGMA user_version').get()).toMatchObject({
          user_version: 4,
        })
        expect(inspector.prepare(`
          SELECT name FROM sqlite_schema
          WHERE type = 'table' AND name = 'control_outcomes'
        `).get()).toMatchObject({ name: 'control_outcomes' })
      } finally {
        inspector.close()
      }
    } finally {
      upgraded.close()
    }
  })

  it('upgrades a schema-v2 mailbox by adding only the writer fence table', () => {
    const state = fixture()
    enqueue(state, MESSAGE_4, { payload: { text: 'pre-writer-schema' } })
    state.database.close()

    const legacy = new DatabaseSync(state.path)
    try {
      legacy.exec(`
        DROP TABLE session_writers;
        DROP TABLE pair_blocks;
        DROP TABLE session_policies;
        DROP INDEX messages_sender_principal_queued;
        DROP INDEX messages_recipient_principal_queued;
        PRAGMA user_version = 2;
      `)
    } finally {
      legacy.close()
    }

    const upgraded = new MessagingDatabase({ path: state.path, clock: () => state.now })
    try {
      expect(upgraded.getMessage(MESSAGE_4)).toMatchObject({
        messageId: MESSAGE_4,
        channel: 'text',
        payload: { text: 'pre-writer-schema' },
      })
      expect(upgraded.getSessionWriter('writer-session')).toBeUndefined()
      const inspector = new DatabaseSync(state.path, { readOnly: true })
      try {
        expect(inspector.prepare('PRAGMA user_version').get()).toMatchObject({
          user_version: 4,
        })
        expect(inspector.prepare(`
          SELECT name FROM sqlite_schema
          WHERE type = 'table' AND name = 'session_writers'
        `).get()).toMatchObject({ name: 'session_writers' })
      } finally {
        inspector.close()
      }
    } finally {
      upgraded.close()
    }
  })

  it('waits through a real cross-thread SQLite initialization lock', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-messaging-init-lock-'))
    chmodSync(root, 0o700)
    const path = join(root, 'messages.sqlite')
    const seed = new DatabaseSync(path)
    seed.close()
    chmodSync(path, 0o600)

    const source = `
      import { parentPort, workerData } from 'node:worker_threads'
      import { DatabaseSync } from 'node:sqlite'
      const database = new DatabaseSync(workerData.path)
      database.exec('BEGIN EXCLUSIVE')
      parentPort.postMessage('locked')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.holdMs)
      database.exec('COMMIT')
      database.close()
    `
    const worker = new Worker(
      new URL(`data:text/javascript,${encodeURIComponent(source)}`),
      { workerData: { path, holdMs: 100 } },
    )
    const exited = new Promise<number | null>((resolve, reject) => {
      worker.once('exit', resolve)
      worker.once('error', reject)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        worker.once('message', () => resolve())
        worker.once('error', reject)
      })
      const database = new MessagingDatabase({ path, busyTimeoutMs: 1_000 })
      try {
        const inspector = new DatabaseSync(path, { readOnly: true })
        try {
          expect(inspector.prepare('PRAGMA journal_mode').get()).toMatchObject({
            journal_mode: 'wal',
          })
          expect(inspector.prepare('PRAGMA user_version').get()).toMatchObject({
            user_version: 4,
          })
        } finally {
          inspector.close()
        }
      } finally {
        database.close()
      }
      expect(await exited).toBe(0)
    } finally {
      await worker.terminate()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a group/world-accessible database directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-messaging-insecure-'))
    chmodSync(root, 0o755)
    try {
      expectCode(() => new MessagingDatabase({ path: join(root, 'messages.sqlite') }), 'INSECURE_PATH')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('MessagingDatabase principal permissions', () => {
  it('projects all-allowed defaults and persists policy patches across WAL connections', () => {
    const state = fixture()
    const firstDefault = state.database.getSessionPolicy('principal-a')
    const secondDefault = state.database.getSessionPolicy('principal-a')
    expect(firstDefault).toEqual({
      principalSessionId: 'principal-a',
      sendAllowed: true,
      receiveAllowed: true,
      updatedAt: 0,
    })
    expect(firstDefault).not.toBe(secondDefault)

    const sendDisabled = state.database.setSessionPolicy({
      principalSessionId: 'principal-a',
      sendAllowed: false,
    })
    expect(sendDisabled).toMatchObject({ sendAllowed: false, receiveAllowed: true })
    state.now += 1
    const bothDisabled = state.database.setSessionPolicy({
      principalSessionId: 'principal-a',
      receiveAllowed: false,
    })
    expect(bothDisabled).toMatchObject({ sendAllowed: false, receiveAllowed: false })

    const second = new MessagingDatabase({ path: state.path, clock: () => state.now })
    try {
      expect(second.getSessionPolicy('principal-a')).toEqual(bothDisabled)
    } finally {
      second.close()
    }
  })

  it('atomically denies enqueue for sender, recipient, and symmetric pair policy', () => {
    const state = fixture()
    state.database.setSessionPolicy({
      principalSessionId: 'principal-sender',
      sendAllowed: false,
    })
    expectCode(() => enqueue(state, MESSAGE_1), 'PERMISSION_DENIED')
    expect(state.database.getMessage(MESSAGE_1)).toBeUndefined()

    state.database.setSessionPolicy({
      principalSessionId: 'principal-sender',
      sendAllowed: true,
    })
    state.database.setSessionPolicy({
      principalSessionId: 'principal-recipient',
      receiveAllowed: false,
    })
    expectCode(() => enqueue(state, MESSAGE_1), 'PERMISSION_DENIED')

    state.database.setSessionPolicy({
      principalSessionId: 'principal-recipient',
      receiveAllowed: true,
    })
    state.database.setPairBlocked({
      firstPrincipalSessionId: 'principal-recipient',
      secondPrincipalSessionId: 'principal-sender',
      blocked: true,
    })
    expectCode(() => enqueue(state, MESSAGE_1), 'PERMISSION_DENIED')
    expectCode(() => enqueue(state, MESSAGE_2, {
      senderPrincipalSessionId: 'principal-recipient',
      recipientPrincipalSessionId: 'principal-sender',
    }), 'PERMISSION_DENIED')
    expect(state.database.listMessages()).toEqual([])
  })

  it('sets, lists, resolves, and removes a canonical bidirectional block', () => {
    const state = fixture()
    const block = state.database.setPairBlocked({
      firstPrincipalSessionId: 'principal-z',
      secondPrincipalSessionId: 'principal-a',
      blocked: true,
    })
    expect(block).toEqual({
      firstPrincipalSessionId: 'principal-a',
      secondPrincipalSessionId: 'principal-z',
      blockedAt: state.now,
    })
    expect(state.database.isPairBlocked('principal-a', 'principal-z')).toBe(true)
    expect(state.database.isPairBlocked('principal-z', 'principal-a')).toBe(true)
    expect(state.database.isPairBlocked('principal-a', 'principal-a')).toBe(false)
    expect(state.database.listPairBlocks()).toEqual([block])
    expect(state.database.listPairBlocks('principal-z')).toEqual([block])
    expect(state.database.listPairBlocks('unrelated')).toEqual([])

    expect(state.database.setPairBlocked({
      firstPrincipalSessionId: 'principal-a',
      secondPrincipalSessionId: 'principal-z',
      blocked: false,
    })).toBeUndefined()
    expect(state.database.isPairBlocked('principal-a', 'principal-z')).toBe(false)
    expect(state.database.listPairBlocks()).toEqual([])
  })

  it('preserves accepted and actively leased facts while cutting off unleased queued envelopes', () => {
    const state = fixture()
    const owner = acquire(state)
    enqueue(state, MESSAGE_1)
    const acceptedLease = state.database.claimNextDelivery({
      ...owner,
      recipientSessionId: 'recipient',
      leaseMs: 100,
    })!
    state.database.acceptDelivery({
      ...owner,
      messageId: MESSAGE_1,
      leaseToken: acceptedLease.lease.token,
    })

    enqueue(state, MESSAGE_2)
    const queuedLease = state.database.claimNextDelivery({
      ...owner,
      recipientSessionId: 'recipient',
      leaseMs: 100,
    })!
    enqueue(state, MESSAGE_3)

    const second = new MessagingDatabase({ path: state.path, clock: () => state.now })
    try {
      second.setSessionPolicy({
        principalSessionId: 'principal-sender',
        sendAllowed: false,
      })
      expect(state.database.getMessage(MESSAGE_1)!.status).toBe('accepted')
      expect(state.database.getMessage(MESSAGE_2)).toMatchObject({
        status: 'queued',
        lease: queuedLease.lease,
      })
      const cutOff = state.database.getMessage(MESSAGE_3)!
      expect(cutOff).toMatchObject({
        status: 'failed',
        lastError: 'permission denied: session policy revoked',
      })
      expect(cutOff.lease).toBeUndefined()
    } finally {
      second.close()
    }

    expect(state.database.acceptDelivery({
      ...owner,
      messageId: MESSAGE_2,
      leaseToken: queuedLease.lease.token,
    }).status).toBe('accepted')
  })

  it('lets the admitted receiver fail an active lease after its permission recheck', () => {
    const state = fixture()
    const owner = acquire(state)
    enqueue(state, MESSAGE_1)
    const lease = state.database.claimNextDelivery({
      ...owner,
      recipientSessionId: 'recipient',
      leaseMs: 100,
    })!

    const second = new MessagingDatabase({ path: state.path, clock: () => state.now })
    try {
      second.setSessionPolicy({
        principalSessionId: 'principal-sender',
        sendAllowed: false,
      })
    } finally {
      second.close()
    }

    const failed = state.database.failDelivery({
      ...owner,
      messageId: MESSAGE_1,
      leaseToken: lease.lease.token,
      error: 'permission denied by receiver recheck',
    })
    expect(failed).toMatchObject({
      status: 'failed',
      lastError: 'permission denied by receiver recheck',
    })
    expect(failed.lease).toBeUndefined()
  })

  it('terminalizes a revoked delivery during its fenced claim after the lease expires', () => {
    const state = fixture()
    const owner = acquire(state)
    enqueue(state, MESSAGE_1)
    const lease = state.database.claimNextDelivery({
      ...owner,
      recipientSessionId: 'recipient',
      leaseMs: 100,
    })!

    const second = new MessagingDatabase({ path: state.path, clock: () => state.now })
    try {
      second.setSessionPolicy({
        principalSessionId: 'principal-sender',
        sendAllowed: false,
      })
    } finally {
      second.close()
    }
    expect(state.database.getMessage(MESSAGE_1)).toMatchObject({
      status: 'queued',
      lease: lease.lease,
    })

    state.now = lease.lease.until
    expect(state.database.getMessage(MESSAGE_1)).toMatchObject({
      status: 'queued',
      lease: lease.lease,
    })
    expect(state.database.claimNextDelivery({
      ...owner,
      recipientSessionId: 'recipient',
      leaseMs: 100,
    })).toBeUndefined()
    expect(state.database.getMessage(MESSAGE_1)).toMatchObject({
      status: 'failed',
      lastError: 'permission denied: policy changed before delivery',
    })
  })

  it('does not let a concurrent claim cancel the current owner active lease after revocation', () => {
    const state = fixture()
    const owner = acquire(state)
    enqueue(state, MESSAGE_1)
    const lease = state.database.claimNextDelivery({
      ...owner,
      recipientSessionId: 'recipient',
      leaseMs: 100,
    })!

    const second = new MessagingDatabase({ path: state.path, clock: () => state.now })
    try {
      second.setSessionPolicy({
        principalSessionId: 'principal-sender',
        sendAllowed: false,
      })
      expect(second.claimNextDelivery({
        ...owner,
        recipientSessionId: 'recipient',
        leaseMs: 100,
      })).toBeUndefined()
      expect(second.getMessage(MESSAGE_1)).toMatchObject({
        status: 'queued',
        attemptCount: 1,
        lease: lease.lease,
      })
    } finally {
      second.close()
    }
  })

  it('preserves an active admitted lease when its principal pair becomes blocked', () => {
    const state = fixture()
    const owner = acquire(state)
    enqueue(state, MESSAGE_1)
    const lease = state.database.claimNextDelivery({
      ...owner,
      recipientSessionId: 'recipient',
      leaseMs: 100,
    })!
    enqueue(state, MESSAGE_2)

    const second = new MessagingDatabase({ path: state.path, clock: () => state.now })
    try {
      second.setPairBlocked({
        firstPrincipalSessionId: 'principal-sender',
        secondPrincipalSessionId: 'principal-recipient',
        blocked: true,
      })
      expect(second.getMessage(MESSAGE_1)).toMatchObject({
        status: 'queued',
        lease: lease.lease,
      })
      expect(second.getMessage(MESSAGE_2)).toMatchObject({
        status: 'failed',
        lastError: 'permission denied: principal pair blocked',
      })
    } finally {
      second.close()
    }

    expect(state.database.acceptDelivery({
      ...owner,
      messageId: MESSAGE_1,
      leaseToken: lease.lease.token,
    }).status).toBe('accepted')
  })

  it('cuts off queued envelopes when the recipient principal disables receive', () => {
    const state = fixture()
    enqueue(state, MESSAGE_1)
    state.database.setSessionPolicy({
      principalSessionId: 'principal-recipient',
      receiveAllowed: false,
    })
    expect(state.database.getMessage(MESSAGE_1)).toMatchObject({
      status: 'failed',
      lastError: 'permission denied: session policy revoked',
    })
  })

  it('cuts off both queued directions of a blocked pair and leaves other principals alone', () => {
    const state = fixture()
    enqueue(state, MESSAGE_1, {
      senderPrincipalSessionId: 'principal-a',
      recipientPrincipalSessionId: 'principal-b',
    })
    enqueue(state, MESSAGE_2, {
      senderPrincipalSessionId: 'principal-b',
      recipientPrincipalSessionId: 'principal-a',
    })
    enqueue(state, MESSAGE_3, {
      senderPrincipalSessionId: 'principal-a',
      recipientPrincipalSessionId: 'principal-c',
    })
    state.database.setPairBlocked({
      firstPrincipalSessionId: 'principal-a',
      secondPrincipalSessionId: 'principal-b',
      blocked: true,
    })
    expect(state.database.getMessage(MESSAGE_1)!.status).toBe('failed')
    expect(state.database.getMessage(MESSAGE_2)!.status).toBe('failed')
    expect(state.database.getMessage(MESSAGE_3)!.status).toBe('queued')
  })

  it('rechecks policy in claim and terminalizes a queued head changed outside the API', () => {
    const state = fixture()
    const owner = acquire(state)
    enqueue(state, MESSAGE_1)
    const external = new DatabaseSync(state.path)
    try {
      external.prepare(`
        INSERT INTO session_policies (
          principal_session_id, send_allowed, receive_allowed, updated_at
        ) VALUES (?, 0, 1, ?)
      `).run('principal-sender', state.now)
    } finally {
      external.close()
    }
    expect(state.database.claimNextDelivery({
      ...owner,
      recipientSessionId: 'recipient',
      leaseMs: 100,
    })).toBeUndefined()
    expect(state.database.getMessage(MESSAGE_1)).toMatchObject({
      status: 'failed',
      lastError: 'permission denied: policy changed before delivery',
    })
  })

  it('treats both principal identities as immutable collision fields', () => {
    const state = fixture()
    enqueue(state, MESSAGE_1, {
      senderPrincipalSessionId: 'principal-a',
      recipientPrincipalSessionId: 'principal-b',
    })
    expectCode(() => enqueue(state, MESSAGE_1, {
      senderPrincipalSessionId: 'principal-c',
      recipientPrincipalSessionId: 'principal-b',
    }), 'MESSAGE_ID_COLLISION')
  })

  it('serializes WAL policy cutoff against another connection enqueue', () => {
    const state = fixture()
    const second = new MessagingDatabase({ path: state.path, clock: () => state.now })
    try {
      enqueue(state, MESSAGE_4, {
        senderPrincipalSessionId: 'principal-a',
        recipientPrincipalSessionId: 'principal-b',
      })
      second.setSessionPolicy({ principalSessionId: 'principal-a', sendAllowed: false })
      expect(state.database.getMessage(MESSAGE_4)!.status).toBe('failed')
      expectCode(() => state.database.enqueue({
        messageId: MESSAGE_3,
        senderSessionId: 'sender',
        recipientSessionId: 'recipient',
        senderPrincipalSessionId: 'principal-a',
        recipientPrincipalSessionId: 'principal-b',
        deliveryMode: 'followup',
        payload: { text: 'after cutoff' },
        ttlMs: 1_000,
        maxAttempts: 3,
      }), 'PERMISSION_DENIED')
    } finally {
      second.close()
    }
  })
})
