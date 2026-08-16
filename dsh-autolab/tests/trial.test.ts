import { describe, expect, it } from 'vitest'

import {
  AttemptTransitionError,
  TrialContractError,
  compileAttemptCompletionReceipt,
  compileAttemptStartedReceipt,
  compileAttemptUncertainReceipt,
  compileRunSlotContract,
  compileTrialContract,
  createInitialAttempt,
  createRetryAttempt,
  createRunSlotState,
  parseAttempt,
  parseTrialContract,
  recordAttemptCompletion,
  recordAttemptOutcomeUnknown,
  recordAttemptStarted,
} from '../src/trial.js'

const hash = (digit: string): string => digit.repeat(64)
const candidateSha = 'a'.repeat(40)

function trialInput() {
  return {
    version: 1 as const,
    trial_id: 'trial-fusion-1',
    lane_id: 'lane-a',
    candidate_sha: candidateSha,
    config_revision: 3,
    contract: {
      purpose: 'Distinguish one fused GEMM from the split implementation.',
      mode: 'confirmatory',
      claim_refs: ['claim-fusion'],
      changed_factors: ['projection implementation'],
      control_ref: 'baseline-split',
      outcome_to_decision_map: {
        faster_and_equal: 'continue',
        otherwise: 'do not promote',
      },
    },
    run_slots: [
      { runslot_id: 'slot-seed-7-r0', contract: { seed: 7, replicate: 0 } },
      { runslot_id: 'slot-protocol-control', contract: { protocol_slot: 'control' } },
    ],
    created_at: 100,
  }
}

function executionInput() {
  return {
    attempt_id: 'attempt-slot-1',
    request: { kind: 'command' as const, sha256: hash('3') },
    cwd: '/tmp/autolab/run/trial-fusion-1/slot-seed-7-r0',
    env_sha256: hash('4'),
    runner: { id: 'tmux-local', version: '1', sha256: hash('5') },
    host_id: 'host-a',
    launch_nonce: 'launch-nonce-1',
    launched_at: 110,
  }
}

function contracts() {
  const trial = compileTrialContract(trialInput())
  const runslot = compileRunSlotContract(trial, 'slot-seed-7-r0')
  return { trial, runslot }
}

function launched(
  runSlotId = 'slot-seed-7-r0',
  input: Parameters<typeof createInitialAttempt>[3] = executionInput(),
) {
  const trial = compileTrialContract(trialInput())
  const runslot = compileRunSlotContract(trial, runSlotId)
  const pending = createRunSlotState(runslot)
  const transition = createInitialAttempt(runslot, pending, pending.revision, input)
  return { trial, runslot, state: transition.state, attempt: transition.attempt }
}

describe('immutable Trial and RunSlot contracts', () => {
  it('freezes one scientific Trial separately from its logical RunSlots', () => {
    const input = trialInput()
    const first = compileTrialContract(input)
    const replay = compileTrialContract(structuredClone(input))
    expect(replay).toEqual(first)
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(first.canonicalJson).toBe(JSON.stringify(JSON.parse(first.canonicalJson)))

    const seed = compileRunSlotContract(first, 'slot-seed-7-r0')
    const protocol = compileRunSlotContract(first, 'slot-protocol-control')
    expect(seed.value).toMatchObject({
      trial_id: input.trial_id,
      trial_contract_sha256: first.sha256,
      candidate_sha: input.candidate_sha,
      contract: { seed: 7, replicate: 0 },
    })
    expect(protocol.value).toMatchObject({ contract: { protocol_slot: 'control' } })
    expect(seed.sha256).not.toBe(protocol.sha256)
  })

  it('preserves Lab-specific scientific contracts without interpreting them', () => {
    const input = {
      ...trialInput(),
      contract: {
        arbitrary_domain_payload: {
          feature_choice: 'method-owned',
          comparison: ['baseline', 'candidate'],
        },
      },
      run_slots: [{ runslot_id: 'slot-domain-defined' }],
    }

    const trial = compileTrialContract(input)
    const runslot = compileRunSlotContract(trial, 'slot-domain-defined')
    expect(trial.value.contract).toEqual(input.contract)
    expect(runslot.value).not.toHaveProperty('contract')
  })

  it('rejects duplicate slots and undeclared schema fields without requiring fake slot dimensions', () => {
    const duplicate = trialInput()
    duplicate.run_slots[1] = { ...duplicate.run_slots[0]! }
    expect(() => compileTrialContract(duplicate)).toThrowError(
      expect.objectContaining<Partial<TrialContractError>>({ code: 'INVALID_TRIAL' }),
    )

    const emptySlot = {
      ...trialInput(),
      run_slots: [{ runslot_id: 'slot-empty' }],
    }
    expect(() => compileTrialContract(emptySlot)).not.toThrow()

    expect(() => parseTrialContract({
      ...trialInput(),
      confidence_score: 0.9,
    })).toThrowError(expect.objectContaining<Partial<TrialContractError>>({
      code: 'INVALID_TRIAL',
    }))
  })
})

describe('Attempt technical execution and retry', () => {
  it('creates a launching Attempt without invented process, tmux, or GPU identity', () => {
    const { runslot } = contracts()
    const pending = createRunSlotState(runslot)
    const launched = createInitialAttempt(runslot, pending, 0, executionInput())
    const { attempt } = launched
    expect(attempt).toMatchObject({
      phase: 'launching',
      attempt_ordinal: 1,
      trial_id: runslot.value.trial_id,
      runslot_id: runslot.value.runslot_id,
      runslot_contract_sha256: runslot.sha256,
      candidate_sha: candidateSha,
    })
    expect(attempt).not.toHaveProperty('process')
    expect(attempt).not.toHaveProperty('gpu_lease')
    expect(attempt).not.toHaveProperty('tmux_session')
    expect(parseAttempt(attempt)).toEqual(attempt)
    expect(launched).toMatchObject({
      expected_revision: 0,
      state: {
        status: 'attempt_active',
        revision: 1,
        attempt_ids: [attempt.attempt_id],
        launch_nonces: [attempt.launch_nonce],
      },
    })
    expect(() => createInitialAttempt(
      runslot,
      launched.state,
      launched.state.revision,
      { ...executionInput(), attempt_id: 'attempt-duplicate', launch_nonce: 'nonce-duplicate' },
    )).toThrowError(expect.objectContaining<Partial<AttemptTransitionError>>({
      code: 'ILLEGAL_TRANSITION',
    }))
  })

  it('adopts one exact started receipt idempotently and rejects identity drift', () => {
    const gpuLease = {
      gpu_uuid: 'GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      lease_id: 'lease-1',
      fencing_token: 9,
    }
    const launchedValue = launched('slot-seed-7-r0', {
      ...executionInput(),
      gpu_lease: gpuLease,
    })
    const launching = launchedValue.attempt
    const started = compileAttemptStartedReceipt({
      version: 1,
      type: 'attempt_started',
      attempt_id: launching.attempt_id,
      launch_nonce: launching.launch_nonce,
      candidate_sha: launching.candidate_sha,
      request_sha256: launching.request.sha256,
      started_at: 120,
      process: {
        pid: 101,
        pgid: 101,
        start_identity: 'proc-start-101',
        host_boot_id: 'boot-a',
        tmux_session: 'autolab-attempt-slot-1',
      },
      gpu_lease: gpuLease,
    })
    const startedTransition = recordAttemptStarted(
      launchedValue.state,
      launchedValue.state.revision,
      launching,
      started,
      '/receipts/started.json',
    )
    const running = startedTransition.attempt
    expect(running).toMatchObject({
      phase: 'running',
      started_at: 120,
      started_receipt: { path: '/receipts/started.json', sha256: started.sha256 },
      process: { pid: 101, tmux_session: 'autolab-attempt-slot-1' },
      gpu_lease: { lease_id: 'lease-1', fencing_token: 9 },
    })
    const replay = recordAttemptStarted(
      startedTransition.state,
      startedTransition.state.revision,
      running,
      started,
      '/receipts/started.json',
    )
    expect(replay.attempt).toEqual(running)
    expect(replay.state).toEqual(startedTransition.state)

    const drifted = compileAttemptStartedReceipt({
      ...started.value,
      launch_nonce: 'another-launch',
    })
    expect(() => recordAttemptStarted(
      launchedValue.state,
      launchedValue.state.revision,
      launching,
      drifted,
      '/receipts/started.json',
    ))
      .toThrowError(expect.objectContaining<Partial<AttemptTransitionError>>({
        code: 'IDENTITY_MISMATCH',
      }))
  })

  it('replays a process-free API start receipt without inventing runtime identity', () => {
    const launchedValue = launched()
    const launching = launchedValue.attempt
    const receipt = compileAttemptStartedReceipt({
      version: 1,
      type: 'attempt_started',
      attempt_id: launching.attempt_id,
      launch_nonce: launching.launch_nonce,
      candidate_sha: launching.candidate_sha,
      request_sha256: launching.request.sha256,
      started_at: 120,
    })
    const started = recordAttemptStarted(
      launchedValue.state,
      launchedValue.state.revision,
      launching,
      receipt,
      '/receipts/api-started.json',
    )
    const running = started.attempt
    expect(running).not.toHaveProperty('process')
    expect(recordAttemptStarted(
      started.state,
      started.state.revision,
      running,
      receipt,
      '/receipts/api-started.json',
    ).attempt).toEqual(running)
  })

  it('records one terminal technical outcome and never reuses that Attempt', () => {
    const launchedValue = launched()
    const launching = launchedValue.attempt
    const completion = compileAttemptCompletionReceipt({
      version: 1,
      type: 'attempt_completion',
      attempt_id: launching.attempt_id,
      launch_nonce: launching.launch_nonce,
      candidate_sha: launching.candidate_sha,
      request_sha256: launching.request.sha256,
      completed_at: 130,
      completion_identity: 'api-response-request-123',
      technical_outcome: 'failed',
      technical_detail: {
        kind: 'api',
        code: 'HTTP_503',
        detail: 'upstream unavailable',
      },
      artifacts: [{
        kind: 'log',
        path: '/artifacts/attempt-slot-1.log',
      }],
    })
    const failedTransition = recordAttemptCompletion(
      launchedValue.state,
      launchedValue.state.revision,
      launching,
      completion,
      '/receipts/completion.json',
    )
    const failed = failedTransition.attempt
    expect(failed).toMatchObject({
      phase: 'terminal',
      technical_outcome: 'failed',
      technical_detail: { kind: 'api', code: 'HTTP_503' },
    })
    expect(recordAttemptCompletion(
      failedTransition.state,
      failedTransition.state.revision,
      failed,
      completion,
      '/receipts/completion.json',
    ).attempt).toEqual(failed)
    const driftedProjection = parseAttempt({
      ...failed,
      completion_identity: 'tampered-completion',
    })
    expect(() => recordAttemptCompletion(
      failedTransition.state,
      failedTransition.state.revision,
      driftedProjection,
      completion,
      '/receipts/completion.json',
    )).toThrowError(expect.objectContaining<Partial<AttemptTransitionError>>({
      code: 'IDENTITY_MISMATCH',
    }))
    expect(() => recordAttemptStarted(
      failedTransition.state,
      failedTransition.state.revision,
      failed,
      compileAttemptStartedReceipt({
      version: 1,
      type: 'attempt_started',
      attempt_id: launching.attempt_id,
      launch_nonce: launching.launch_nonce,
      candidate_sha: launching.candidate_sha,
      request_sha256: launching.request.sha256,
        started_at: 140,
      }),
      '/receipts/late-started.json',
    )).toThrow()
  })

  it('retries API/hardware uncertainty only as a new Attempt in the same RunSlot', () => {
    const launchedValue = launched()
    const first = launchedValue.attempt
    const unknownReceipt = compileAttemptUncertainReceipt({
      version: 1,
      type: 'attempt_outcome_unknown',
      attempt_id: first.attempt_id,
      launch_nonce: first.launch_nonce,
      candidate_sha: first.candidate_sha,
      request_sha256: first.request.sha256,
      observed_at: 140,
      technical_detail: { kind: 'hardware', code: 'HOST_LOST' },
    })
    const unknownTransition = recordAttemptOutcomeUnknown(
      launchedValue.state,
      launchedValue.state.revision,
      first,
      unknownReceipt,
      '/receipts/unknown.json',
    )
    const unknown = unknownTransition.attempt
    expect(() => createInitialAttempt(
      launchedValue.runslot,
      unknownTransition.state,
      unknownTransition.state.revision,
      {
        ...executionInput(),
        attempt_id: 'blind-duplicate',
        launch_nonce: 'blind-duplicate-nonce',
      },
    )).toThrowError(expect.objectContaining<Partial<AttemptTransitionError>>({
      code: 'ILLEGAL_TRANSITION',
    }))
    expect(() => createRetryAttempt(
      unknownTransition.state,
      unknownTransition.state.revision,
      unknown,
      {
      ...executionInput(),
      attempt_id: 'attempt-slot-2',
      launch_nonce: 'launch-nonce-2',
      launched_at: 150,
        host_id: 'host-b',
      },
    )).toThrowError(expect.objectContaining<Partial<AttemptTransitionError>>({
      code: 'RETRY_NOT_ALLOWED',
    }))

    const failedReceipt = compileAttemptCompletionReceipt({
      version: 1,
      type: 'attempt_completion',
      attempt_id: first.attempt_id,
      launch_nonce: first.launch_nonce,
      candidate_sha: first.candidate_sha,
      request_sha256: first.request.sha256,
      completed_at: 145,
      completion_identity: 'host-death-proven-1',
      technical_outcome: 'failed',
      technical_detail: { kind: 'hardware', code: 'HOST_DEAD' },
      artifacts: [],
    })
    const failedTransition = recordAttemptCompletion(
      unknownTransition.state,
      unknownTransition.state.revision,
      unknown,
      failedReceipt,
      '/receipts/failed.json',
    )
    const failed = failedTransition.attempt
    const retryTransition = createRetryAttempt(
      failedTransition.state,
      failedTransition.state.revision,
      failed,
      {
      ...executionInput(),
      attempt_id: 'attempt-slot-2',
      launch_nonce: 'launch-nonce-2',
      launched_at: 150,
        host_id: 'host-b',
      },
    )
    const retry = retryTransition.attempt
    expect(retry).toMatchObject({
      phase: 'launching',
      attempt_ordinal: 2,
      predecessor_attempt_id: first.attempt_id,
      trial_id: first.trial_id,
      runslot_id: first.runslot_id,
      trial_contract_sha256: first.trial_contract_sha256,
      runslot_contract_sha256: first.runslot_contract_sha256,
      candidate_sha: first.candidate_sha,
      config_revision: first.config_revision,
    })
    expect(retry.attempt_id).not.toBe(first.attempt_id)
    expect(retryTransition.state).toMatchObject({
      status: 'attempt_active',
      attempt_ids: [first.attempt_id, retry.attempt_id],
      launch_nonces: [first.launch_nonce, retry.launch_nonce],
    })
    expect(() => createRetryAttempt(
      retryTransition.state,
      failedTransition.state.revision,
      failed,
      {
        ...executionInput(),
        attempt_id: 'attempt-branch-2',
        launch_nonce: 'launch-branch-2',
        launched_at: 151,
      },
    )).toThrowError(expect.objectContaining<Partial<AttemptTransitionError>>({
      code: 'STALE_RUNSLOT_STATE',
    }))

    const retryFailedReceipt = compileAttemptCompletionReceipt({
      version: 1,
      type: 'attempt_completion',
      attempt_id: retry.attempt_id,
      launch_nonce: retry.launch_nonce,
      candidate_sha: retry.candidate_sha,
      request_sha256: retry.request.sha256,
      completed_at: 170,
      completion_identity: 'retry-failed-2',
      technical_outcome: 'failed',
      technical_detail: { kind: 'api', code: 'HTTP_503_AGAIN' },
      artifacts: [],
    })
    const retryFailed = recordAttemptCompletion(
      retryTransition.state,
      retryTransition.state.revision,
      retry,
      retryFailedReceipt,
      '/receipts/retry-failed.json',
    )
    expect(() => createRetryAttempt(
      retryFailed.state,
      retryFailed.state.revision,
      retryFailed.attempt,
      {
        ...executionInput(),
        attempt_id: first.attempt_id,
        launch_nonce: 'launch-nonce-3',
        launched_at: 180,
      },
    )).toThrowError(expect.objectContaining<Partial<AttemptTransitionError>>({
      code: 'RETRY_NOT_ALLOWED',
    }))

    const successReceipt = compileAttemptCompletionReceipt({
      version: 1,
      type: 'attempt_completion',
      attempt_id: first.attempt_id,
      launch_nonce: first.launch_nonce,
      candidate_sha: first.candidate_sha,
      request_sha256: first.request.sha256,
      completed_at: 145,
      technical_outcome: 'succeeded',
      completion_identity: 'completed-ok',
      artifacts: [],
    })
    const separate = launched()
    const successTransition = recordAttemptCompletion(
      separate.state,
      separate.state.revision,
      separate.attempt,
      successReceipt,
      '/receipts/success.json',
    )
    const success = successTransition.attempt
    expect(() => createRetryAttempt(
      successTransition.state,
      successTransition.state.revision,
      success,
      {
      ...executionInput(),
      attempt_id: 'illegal-retry',
      launch_nonce: 'launch-nonce-3',
        launched_at: 160,
      },
    )).toThrowError(expect.objectContaining<Partial<AttemptTransitionError>>({
      code: 'RETRY_NOT_ALLOWED',
    }))
  })

  it('reconciles outcome_unknown only by reusing the exact same Attempt identity', () => {
    const launchedValue = launched()
    const launching = launchedValue.attempt
    const unknownBeforeTransition = recordAttemptOutcomeUnknown(
      launchedValue.state,
      launchedValue.state.revision,
      launching,
      compileAttemptUncertainReceipt({
        version: 1,
        type: 'attempt_outcome_unknown',
        attempt_id: launching.attempt_id,
        launch_nonce: launching.launch_nonce,
        candidate_sha: launching.candidate_sha,
        request_sha256: launching.request.sha256,
        observed_at: 125,
        technical_detail: { kind: 'transport', code: 'START_ACK_LOST' },
      }),
      '/receipts/unknown-before-start.json',
    )
    const unknownBeforeStart = unknownBeforeTransition.attempt
    const startedReceipt = compileAttemptStartedReceipt({
      version: 1,
      type: 'attempt_started',
      attempt_id: launching.attempt_id,
      launch_nonce: launching.launch_nonce,
      candidate_sha: launching.candidate_sha,
      request_sha256: launching.request.sha256,
      started_at: 120,
      process: {
        pid: 101,
        start_identity: 'proc-start-101',
        host_boot_id: 'boot-a',
      },
    })
    const runningTransition = recordAttemptStarted(
      unknownBeforeTransition.state,
      unknownBeforeTransition.state.revision,
      unknownBeforeStart,
      startedReceipt,
      '/receipts/started.json',
    )
    const running = runningTransition.attempt
    expect(running).toMatchObject({
      phase: 'running',
      attempt_id: launching.attempt_id,
      attempt_ordinal: launching.attempt_ordinal,
      launch_nonce: launching.launch_nonce,
    })

    const unknownAfterTransition = recordAttemptOutcomeUnknown(
      runningTransition.state,
      runningTransition.state.revision,
      running,
      compileAttemptUncertainReceipt({
        version: 1,
        type: 'attempt_outcome_unknown',
        attempt_id: running.attempt_id,
        launch_nonce: running.launch_nonce,
        candidate_sha: running.candidate_sha,
        request_sha256: running.request.sha256,
        observed_at: 135,
        technical_detail: { kind: 'transport', code: 'EXIT_ACK_LOST' },
      }),
      '/receipts/unknown-after-start.json',
    )
    const unknownAfterStart = unknownAfterTransition.attempt
    expect(recordAttemptStarted(
      unknownAfterTransition.state,
      unknownAfterTransition.state.revision,
      unknownAfterStart,
      startedReceipt,
      '/receipts/started.json',
    )).toMatchObject({
      state: { status: 'attempt_active' },
      attempt: {
        phase: 'running',
        attempt_id: launching.attempt_id,
        attempt_ordinal: 1,
      },
    })

    const conflictingStarted = compileAttemptStartedReceipt({
      ...startedReceipt.value,
      started_at: 121,
    })
    expect(() => recordAttemptStarted(
      unknownAfterTransition.state,
      unknownAfterTransition.state.revision,
      unknownAfterStart,
      conflictingStarted,
      '/receipts/conflicting-started.json',
    )).toThrowError(expect.objectContaining<Partial<AttemptTransitionError>>({
      code: 'ILLEGAL_TRANSITION',
    }))

    const completed = recordAttemptCompletion(
      unknownAfterTransition.state,
      unknownAfterTransition.state.revision,
      unknownAfterStart,
      compileAttemptCompletionReceipt({
        version: 1,
        type: 'attempt_completion',
        attempt_id: launching.attempt_id,
        launch_nonce: launching.launch_nonce,
        candidate_sha: launching.candidate_sha,
        request_sha256: launching.request.sha256,
        completed_at: 140,
        completion_identity: 'exit-receipt-1',
        technical_outcome: 'succeeded',
        artifacts: [],
      }),
      '/receipts/completed-after-unknown.json',
    )
    expect(completed).toMatchObject({
      state: { status: 'execution_complete' },
      attempt: {
        phase: 'terminal',
        technical_outcome: 'succeeded',
        attempt_id: launching.attempt_id,
        attempt_ordinal: 1,
        launch_nonce: launching.launch_nonce,
      },
    })
  })

  it('rejects a drifted uncertainty projection during exact receipt replay', () => {
    const initial = launched()
    const rewrittenLaunch = parseAttempt({
      ...initial.attempt,
      launch_nonce: 'rewritten-launch-nonce',
    })
    const rewrittenReceipt = compileAttemptUncertainReceipt({
      version: 1,
      type: 'attempt_outcome_unknown',
      attempt_id: rewrittenLaunch.attempt_id,
      launch_nonce: rewrittenLaunch.launch_nonce,
      candidate_sha: rewrittenLaunch.candidate_sha,
      request_sha256: rewrittenLaunch.request.sha256,
      observed_at: 129,
      technical_detail: { kind: 'transport', code: 'REWRITTEN_IDENTITY' },
    })
    expect(() => recordAttemptOutcomeUnknown(
      initial.state,
      initial.state.revision,
      rewrittenLaunch,
      rewrittenReceipt,
      '/receipts/rewritten-unknown.json',
    )).toThrowError(expect.objectContaining<Partial<AttemptTransitionError>>({
      code: 'IDENTITY_MISMATCH',
    }))

    const receipt = compileAttemptUncertainReceipt({
      version: 1,
      type: 'attempt_outcome_unknown',
      attempt_id: initial.attempt.attempt_id,
      launch_nonce: initial.attempt.launch_nonce,
      candidate_sha: initial.attempt.candidate_sha,
      request_sha256: initial.attempt.request.sha256,
      observed_at: 130,
      technical_detail: { kind: 'transport', code: 'CONNECTION_LOST' },
    })
    const unknown = recordAttemptOutcomeUnknown(
      initial.state,
      initial.state.revision,
      initial.attempt,
      receipt,
      '/receipts/unknown.json',
    )
    const drifted = parseAttempt({
      ...unknown.attempt,
      technical_detail: { kind: 'hardware', code: 'INVENTED_FAILURE' },
    })
    expect(() => recordAttemptOutcomeUnknown(
      unknown.state,
      unknown.state.revision,
      drifted,
      receipt,
      '/receipts/unknown.json',
    )).toThrowError(expect.objectContaining<Partial<AttemptTransitionError>>({
      code: 'IDENTITY_MISMATCH',
    }))
  })

  it('rejects empty runtime placeholders while allowing an actually observed adapter field', () => {
    expect(() => compileAttemptStartedReceipt({
      version: 1,
      type: 'attempt_started',
      attempt_id: 'attempt-slot-1',
      launch_nonce: 'launch-nonce-1',
      candidate_sha: candidateSha,
      request_sha256: hash('3'),
      started_at: 120,
      process: {},
    })).toThrow()
    expect(() => compileAttemptStartedReceipt({
      version: 1,
      type: 'attempt_started',
      attempt_id: 'attempt-slot-1',
      launch_nonce: 'launch-nonce-1',
      candidate_sha: candidateSha,
      request_sha256: hash('3'),
      started_at: 120,
      process: { tmux_session: 'observed-tmux-session' },
    })).not.toThrow()
  })
})
