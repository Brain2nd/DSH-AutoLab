import { describe, expect, it } from 'vitest'

import {
  createRuntimeState,
  parseState,
  transitionRuntimeState,
} from '../src/state.js'
import { randomUUID } from 'node:crypto'

const LAB_ID = 'lab-20260815-120000-1234abcd'
const HASH = (digit: string) => digit.repeat(64)
const SHA = '1'.repeat(40)
const SHA_GEN2 = '2'.repeat(40)
const SHA_GEN3 = '3'.repeat(40)

function baseState(overrides: Record<string, unknown> = {}) {
  const ownerEpoch = randomUUID()
  const ready = createRuntimeState({
    labId: LAB_ID,
    ownerEpoch,
    controllerSessionId: 'controller',
    lifecycle: 'ready',
    config: {
      revision: 1,
      specHash: HASH('a'),
      configHash: HASH('b'),
      manifestHash: HASH('c'),
      dialogueHeadHash: HASH('d'),
      revisionPath: 'revisions/000001',
    },
    now: 10,
  })
  const starting = transitionRuntimeState(ready, {
    expectedRevision: ready.runtimeRevision,
    ownerEpoch,
    lifecycle: 'starting',
    now: 11,
  })
  const running = transitionRuntimeState(starting, {
    expectedRevision: starting.runtimeRevision,
    ownerEpoch,
    lifecycle: 'running',
    now: 12,
  })
  return { ownerEpoch, state: parseState({ ...running, ...overrides }) }
}

function coderRole(assignmentId: string) {
  return {
    sessionId: 'coder-session',
    phase: 'working' as const,
    binding: { path: '/lab/binding.json', hash: HASH('e') },
    packet: { path: '/lab/packet.json', hash: HASH('f') },
    goalInstall: {
      installId: `${assignmentId}:install:1`,
      assignmentId,
      objectiveHash: HASH('0'),
      maxGoalRounds: 80,
      status: 'applied' as const,
      goalId: `goal-${assignmentId}`,
      goalRevision: 1,
    },
  }
}

function candidate(candidateId: string, assignmentId: string) {
  return {
    version: 1 as const,
    sourceRevision: 1,
    laneId: 'f1',
    candidateId,
    reviewId: `review-${candidateId}`,
    coderRoleId: 'f1-coder',
    coderSessionId: 'coder-session',
    assignmentId,
    candidateSha: SHA,
    captureReceipt: { path: '/lab/cand.json', hash: HASH('7') },
    sourceReport: { path: '/lab/report.json', hash: HASH('8') },
    frozenAt: 5,
  }
}

function trial(trialId: string, candidateId: string) {
  const runSlotHash = HASH('9')
  return {
    version: 1 as const,
    sourceRevision: 1,
    laneId: 'f1',
    candidateId,
    candidateSha: SHA,
    contract: { path: '/lab/trial.json', hash: HASH('6') },
    runSlots: {
      'seed-2026': {
        contract: { path: '/lab/runslot.json', hash: runSlotHash },
        state: {
          version: 1 as const,
          runslot_id: 'seed-2026',
          trial_id: trialId,
          runslot_contract_sha256: runSlotHash,
          revision: 0 as const,
          status: 'pending' as const,
        },
      },
    },
  }
}

describe('Candidate supersede invariants', () => {
  it('accepts an active candidate matching its Coder Assignment', () => {
    const { state } = baseState({
      roles: { 'f1-coder': coderRole('coder:old-assignment') },
      candidates: { f1: candidate('cand-a', 'coder:old-assignment') },
    })
    expect(state.candidates.f1?.candidateId).toBe('cand-a')
    expect(state.retiredCandidates).toEqual({})
  })

  it('retires the old candidate so a Trial keeps its lineage while the Coder moves on', () => {
    const { state } = baseState({
      roles: { 'f1-coder': coderRole('coder:new-assignment') },
      candidates: {},
      retiredCandidates: { 'cand-a': candidate('cand-a', 'coder:old-assignment') },
      trials: { 'trial-1': trial('trial-1', 'cand-a') },
    })
    expect(state.retiredCandidates['cand-a']?.candidateId).toBe('cand-a')
    expect(state.trials['trial-1']?.candidateId).toBe('cand-a')
  })

  it('rejects a retired candidate that still matches the active Coder Assignment', () => {
    expect(() => baseState({
      roles: { 'f1-coder': coderRole('coder:old-assignment') },
      candidates: {},
      retiredCandidates: { 'cand-a': candidate('cand-a', 'coder:old-assignment') },
    })).toThrow()
  })

  it('rejects a Trial that descends from neither active nor retired candidate', () => {
    expect(() => baseState({
      roles: { 'f1-coder': coderRole('coder:new-assignment') },
      candidates: {},
      retiredCandidates: { 'cand-a': candidate('cand-a', 'coder:old-assignment') },
      trials: { 'trial-2': trial('trial-2', 'cand-unknown') },
    })).toThrow()
  })

  it('transitionRuntimeState retires the active candidate in one CAS', () => {
    const { ownerEpoch, state } = baseState({
      roles: { 'f1-coder': coderRole('coder:old-assignment') },
      candidates: { f1: candidate('cand-a', 'coder:old-assignment') },
    })
    const next = transitionRuntimeState(state, {
      expectedRevision: state.runtimeRevision,
      ownerEpoch,
      lifecycle: 'running',
      roles: { 'f1-coder': coderRole('coder:new-assignment') },
      candidates: {},
      retiredCandidates: { 'cand-a': candidate('cand-a', 'coder:old-assignment') },
      now: 12,
    })
    expect(next.retiredCandidates['cand-a']?.candidateId).toBe('cand-a')
    expect(next.candidates).toEqual({})
    expect(next.roles['f1-coder']?.goalInstall?.assignmentId).toBe('coder:new-assignment')
  })

  it('rejects a candidate that is both active and retired (dedicated)', () => {
    expect(() => baseState({
      roles: { 'f1-coder': coderRole('coder:old-assignment') },
      candidates: { f1: candidate('cand-a', 'coder:old-assignment') },
      retiredCandidates: { 'cand-a': candidate('cand-a', 'coder:old-assignment') },
    })).toThrow()
  })

  it('allows a next-generation active capture under a retired candidate id', () => {
    const { state } = baseState({
      roles: { 'f1-coder': coderRole('coder:new-assignment') },
      candidates: {
        f1: { ...candidate('cand-a', 'coder:new-assignment'), candidateSha: SHA_GEN2 },
      },
      retiredCandidates: { 'cand-a': candidate('cand-a', 'coder:old-assignment') },
    })
    expect(state.candidates.f1?.candidateSha).toBe(SHA_GEN2)
    expect(state.retiredCandidates['cand-a']?.candidateSha).toBe(SHA)
  })

  it('keeps a Trial on the retired generation when the active capture reused the id', () => {
    const { state } = baseState({
      roles: { 'f1-coder': coderRole('coder:new-assignment') },
      candidates: {
        f1: { ...candidate('cand-a', 'coder:new-assignment'), candidateSha: SHA_GEN2 },
      },
      retiredCandidates: { 'cand-a': candidate('cand-a', 'coder:old-assignment') },
      trials: { 'trial-1': trial('trial-1', 'cand-a') },
    })
    expect(state.trials['trial-1']?.candidateId).toBe('cand-a')
    expect(state.trials['trial-1']?.candidateSha).toBe(SHA)
  })

  it('rejects a Trial whose sha matches neither generation of its candidate id', () => {
    expect(() => baseState({
      roles: { 'f1-coder': coderRole('coder:new-assignment') },
      candidates: {
        f1: { ...candidate('cand-a', 'coder:new-assignment'), candidateSha: SHA_GEN2 },
      },
      retiredCandidates: { 'cand-a': candidate('cand-a', 'coder:old-assignment') },
      trials: {
        'trial-3': { ...trial('trial-3', 'cand-a'), candidateSha: SHA_GEN3 },
      },
    })).toThrow()
  })
})
