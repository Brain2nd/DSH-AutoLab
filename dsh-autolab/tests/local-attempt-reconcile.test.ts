import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  localAttemptRequestPath,
  localAttemptRequestSchema,
  type ReadLocalAttemptIntent,
} from '../src/attempt-artifacts.js'
import { canonicalJson, sha256 } from '../src/integrity.js'
import { reconcileLocalTmuxInspection } from '../src/local-attempt-reconcile.js'
import {
  compileLocalTmuxLaunch,
  type ExitAttemptReceipt,
  type LocalTmuxInspection,
  type StartedAttemptReceipt,
} from '../src/runner.js'
import {
  compileRunSlotContract,
  compileTrialContract,
  createInitialAttempt,
  createRunSlotState,
  type Attempt,
  type FrozenRecord,
  type RunSlotState,
} from '../src/trial.js'

const roots: string[] = []
const candidateSha = 'a'.repeat(40)
const componentHash = 'b'.repeat(64)
const issuedAt = 1_786_742_400_000

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

interface Fixture {
  readonly runRoot: string
  readonly intent: ReadLocalAttemptIntent
  readonly state: RunSlotState
  readonly started: StartedAttemptReceipt
  readonly exit: ExitAttemptReceipt
}

async function fixture(exitCode = 0): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-autolab-reconcile-')))
  roots.push(root)
  const runRoot = join(root, 'runs')
  const attemptId = 'attempt-local-1'
  const launchNonce = '00000000-0000-4000-8000-000000000111'
  const attemptDirectory = join(runRoot, 'attempts', attemptId)
  const cwd = join(runRoot, 'checkouts', attemptId)
  const command = ['python', 'train.py', '--seed', '7']
  const env = { PYTHONHASHSEED: '7' }
  const runner = { id: 'local-tmux', version: '1', sha256: componentHash }
  const plan = compileLocalTmuxLaunch({
    attemptId,
    launchNonce,
    candidateSha,
    cwd,
    attemptDirectory,
    command,
    env,
    issuedAt,
  })
  const requestValue = localAttemptRequestSchema.parse({
    version: 1,
    kind: 'AUTOLAB_LOCAL_TMUX_REQUEST',
    lab_id: 'lab-20260815-120000-89abcdef',
    config_revision: 1,
    trial_id: 'trial-1',
    runslot_id: 'slot-1',
    attempt_id: attemptId,
    attempt_ordinal: 1,
    launch_nonce: launchNonce,
    candidate_sha: candidateSha,
    runner,
    host_id: 'local',
    command,
    env,
    cwd,
    checkout_path: cwd,
    attempt_directory: attemptDirectory,
    issued_at: issuedAt,
  })
  const request = frozen(requestValue, localAttemptRequestPath(runRoot, attemptId))
  const trial = compileTrialContract({
    version: 1,
    trial_id: 'trial-1',
    lane_id: 'lane-a',
    candidate_sha: candidateSha,
    config_revision: 1,
    contract: {
      purpose: 'Run the exact frozen experiment.',
      mode: 'confirmatory',
      claim_refs: ['claim-1'],
      changed_factors: ['method'],
      control_ref: 'baseline',
      outcome_to_decision_map: { better: 'continue', otherwise: 'stop' },
    },
    run_slots: [{ runslot_id: 'slot-1' }],
    created_at: issuedAt - 1,
  })
  const runSlot = compileRunSlotContract(trial, 'slot-1')
  const pending = createRunSlotState(runSlot)
  const launched = createInitialAttempt(runSlot, pending, 0, {
    attempt_id: attemptId,
    request: { kind: 'runner_request', sha256: request.sha256 },
    cwd,
    env_sha256: plan.envHash,
    runner,
    host_id: 'local',
    launch_nonce: launchNonce,
    launched_at: issuedAt,
  })
  const attempt = frozen(
    launched.attempt,
    join(attemptDirectory, 'state', '000001-launching.json'),
  )
  const intent: ReadLocalAttemptIntent = { request, attempt, launchPlan: plan }

  const startedBody = {
    version: 1 as const,
    kind: 'AUTOLAB_ATTEMPT_STARTED' as const,
    runner: { id: 'local-tmux' as const, version: 1 as const },
    attemptId,
    tmuxSession: plan.tmuxSession,
    launchNonce,
    candidateSha,
    commandHash: plan.commandHash,
    cwd,
    cwdHash: plan.cwdHash,
    envHash: plan.envHash,
    launchIdentityHash: plan.launchIdentityHash,
    launchSpecReceiptHash: plan.launchSpec.receiptHash,
    logPath: plan.paths.log,
    tmuxPaneId: '%7',
    pid: 701,
    pgid: 701,
    processStartId: 'darwin:1700000000:123456',
    processCommandHash: '3'.repeat(64),
    hostname: 'fixture-host',
    bootId: 'fixture-boot',
    startedAt: issuedAt + 10,
  }
  const started: StartedAttemptReceipt = {
    ...startedBody,
    receiptHash: rawReceiptHash('started', startedBody),
  }
  const exitBody = {
    version: 1 as const,
    kind: 'AUTOLAB_ATTEMPT_EXIT' as const,
    runner: { id: 'local-tmux' as const, version: 1 as const },
    attemptId,
    tmuxSession: plan.tmuxSession,
    launchNonce,
    candidateSha,
    commandHash: plan.commandHash,
    cwdHash: plan.cwdHash,
    envHash: plan.envHash,
    launchIdentityHash: plan.launchIdentityHash,
    startedReceiptHash: started.receiptHash,
    tmuxPaneId: started.tmuxPaneId,
    pid: started.pid,
    pgid: started.pgid,
    processStartId: started.processStartId,
    processCommandHash: started.processCommandHash,
    hostname: started.hostname,
    bootId: started.bootId,
    outcome: 'exited' as const,
    exitCode,
    signal: null,
    logPath: plan.paths.log,
    finishedAt: issuedAt + 20,
  }
  const exit: ExitAttemptReceipt = {
    ...exitBody,
    receiptHash: rawReceiptHash('exit', exitBody),
  }
  return { runRoot, intent, state: launched.state, started, exit }
}

describe('local-tmux inspection to generic Attempt transitions', () => {
  it('records one hash-bound start and replays it without another CAS step', async () => {
    const value = await fixture()
    const first = await reconcile(value, { status: 'running', ...running(value.started) })

    expect(first).toMatchObject({ action: 'record_started', inspectionStatus: 'running' })
    if (!('records' in first)) throw new Error('expected reconcile records')
    expect(first.records).toHaveLength(1)
    expect(first).toMatchObject({
      transition: { expected_revision: 1, state: { revision: 2, status: 'attempt_active' } },
    })
    expect(first.records[0]).toMatchObject({
      kind: 'started',
      receipt: {
        value: {
          type: 'attempt_started',
          process: {
            start_identity: value.started.receiptHash,
            tmux_session: value.started.tmuxSession,
          },
        },
      },
    })
    expect(await readFile(first.records[0]!.receipt.path, 'utf8'))
      .toBe(first.records[0]!.receipt.canonicalJson)

    const replay = await reconcileWithProjection(value, first, {
      status: 'running',
      ...running(value.started),
    })
    expect(replay).toMatchObject({ action: 'already_reconciled' })
    expect(replay).not.toHaveProperty('transition')
  })

  it('records start before successful completion and exactly replays the terminal projection', async () => {
    const value = await fixture(0)
    const first = await reconcile(value, {
      status: 'completed',
      started: value.started,
      exit: value.exit,
    })

    if (!('records' in first)) throw new Error('expected reconcile records')
    expect(first.action).toBe('record_completion')
    expect(first.records.map(record => record.kind)).toEqual(['started', 'completion'])
    expect(first).toMatchObject({
      transition: {
        expected_revision: 1,
        state: { revision: 3, status: 'execution_complete' },
        attempt: {
          phase: 'terminal',
          technical_outcome: 'succeeded',
          completion_identity: value.exit.receiptHash,
          artifacts: [{ kind: 'log', path: value.exit.logPath }],
        },
      },
    })

    const replay = await reconcileWithProjection(value, first, {
      status: 'completed',
      started: value.started,
      exit: value.exit,
    })
    expect(replay).toMatchObject({ action: 'already_reconciled' })
    expect(replay).not.toHaveProperty('transition')
  })

  it('maps every non-zero runner exit to failed with a mechanical runner detail', async () => {
    const value = await fixture(23)
    const result = await reconcile(value, {
      status: 'completed',
      started: value.started,
      exit: value.exit,
    })
    if (!('records' in result)) throw new Error('expected reconcile records')
    expect(result.transition).toMatchObject({
      state: { status: 'retryable' },
      attempt: {
        phase: 'terminal',
        technical_outcome: 'failed',
        technical_detail: { kind: 'runner', code: 'exit_code_23' },
      },
    })
  })

  it('records uncertainty once and retains its first stable observation on replay', async () => {
    const value = await fixture()
    const inspection = {
      status: 'outcome_unknown' as const,
      started: value.started,
      reason: 'process disappeared without an exit receipt',
    }
    const first = await reconcile(value, inspection)
    if (!('records' in first)) throw new Error('expected reconcile records')
    expect(first.records.map(record => record.kind)).toEqual(['started', 'uncertain'])
    expect(first.transition).toMatchObject({
      expected_revision: 1,
      state: { status: 'outcome_unknown' },
      attempt: {
        phase: 'outcome_unknown',
        unknown_since: issuedAt + 30,
        technical_detail: { kind: 'runner', code: 'local_tmux_outcome_unknown' },
      },
    })

    const artifactBeforeCasReplay = await reconcile(value, inspection, issuedAt + 999)
    expect(artifactBeforeCasReplay).toMatchObject({
      action: 'record_uncertain',
      transition: {
        attempt: { unknown_since: issuedAt + 30 },
      },
    })
    if (!('records' in artifactBeforeCasReplay)) throw new Error('expected reconcile records')
    expect(artifactBeforeCasReplay.records.map(record => record.receipt.canonicalJson))
      .toEqual(first.records.map(record => record.receipt.canonicalJson))

    const replay = await reconcileWithProjection(value, first, inspection, issuedAt + 999)
    expect(replay).toMatchObject({ action: 'already_reconciled' })
    expect(replay).not.toHaveProperty('transition')
  })

  it('records outcome_unknown without inventing a started receipt and can later complete', async () => {
    const value = await fixture()
    const unknownInspection = {
      status: 'outcome_unknown' as const,
      reason: 'attempt log exists but started.json and the tmux handle are absent',
    }
    const unknown = await reconcile(value, unknownInspection)
    expect(unknown).toMatchObject({
      action: 'record_uncertain',
      inspectionStatus: 'outcome_unknown',
      transition: {
        expected_revision: 1,
        state: { revision: 2, status: 'outcome_unknown' },
        attempt: {
          phase: 'outcome_unknown',
          unknown_since: issuedAt + 30,
        },
      },
    })
    if (!('records' in unknown)) throw new Error('expected reconcile records')
    expect(unknown.records.map(record => record.kind)).toEqual(['uncertain'])
    expect(unknown.transition?.attempt).not.toHaveProperty('started_receipt')

    await expect(reconcileWithProjection(value, unknown, {
      status: 'launching',
      launchPrepared: true,
      tmuxPresent: true,
    })).resolves.toMatchObject({
      action: 'await_started_receipt',
      launchPrepared: true,
    })

    const completed = await reconcileWithProjection(value, unknown, {
      status: 'completed',
      started: value.started,
      exit: value.exit,
    })
    expect(completed).toMatchObject({
      action: 'record_completion',
      transition: {
        expected_revision: 2,
        state: { revision: 4, status: 'execution_complete' },
        attempt: {
          phase: 'terminal',
          technical_outcome: 'succeeded',
          started_receipt: expect.any(Object),
        },
      },
    })
    if (!('records' in completed)) throw new Error('expected reconcile records')
    expect(completed.records.map(record => record.kind)).toEqual(['started', 'completion'])
  })

  it('preserves absent, launching, pending, and hard-blocked inspections', async () => {
    const value = await fixture()
    await expect(reconcile(value, { status: 'absent', launchPrepared: false }))
      .resolves.toMatchObject({ action: 'launch_required', launchPrepared: false })
    await expect(reconcile(value, {
      status: 'launching',
      launchPrepared: true,
      tmuxPresent: true,
    })).resolves.toMatchObject({ action: 'await_started_receipt', launchPrepared: true })
    await expect(reconcile(value, {
      status: 'pending',
      code: 'SYSTEM_UNAVAILABLE',
      message: 'tmux cannot be inspected on this host',
    })).resolves.toMatchObject({
      action: 'pending',
      pending: {
        code: 'SYSTEM_UNAVAILABLE',
        message: 'tmux cannot be inspected on this host',
      },
    })
    await expect(reconcile(value, {
      status: 'blocked',
      code: 'TMUX_IDENTITY_MISMATCH',
      message: 'foreign tmux session',
    })).resolves.toMatchObject({
      action: 'blocked',
      blocker: { code: 'TMUX_IDENTITY_MISMATCH', message: 'foreign tmux session' },
    })

    const runningResult = await reconcile(value, {
      status: 'running',
      ...running(value.started),
    })
    await expect(reconcileWithProjection(
      value,
      runningResult,
      {
        status: 'pending',
        code: 'PROCESS_IDENTITY_UNKNOWN',
        message: 'process identity is temporarily unavailable',
      },
    )).resolves.toMatchObject({
      action: 'pending',
      pending: { code: 'PROCESS_IDENTITY_UNKNOWN' },
    })
    await expect(reconcileWithProjection(
      value,
      runningResult,
      { status: 'absent', launchPrepared: true },
    )).resolves.toMatchObject({
      action: 'blocked',
      blocker: { code: 'RECEIPT_CORRUPT' },
    })
  })

  it('rejects a conflicting raw started identity without replacing the frozen generic receipt', async () => {
    const value = await fixture()
    const first = await reconcile(value, { status: 'running', ...running(value.started) })
    if (!('records' in first)) throw new Error('expected reconcile records')
    const receiptPath = first.records[0]!.receipt.path
    const original = await readFile(receiptPath)
    const { receiptHash: _oldHash, ...changedBody } = {
      ...value.started,
      tmuxPaneId: '%8',
    }
    const changed: StartedAttemptReceipt = {
      ...changedBody,
      receiptHash: rawReceiptHash('started', changedBody),
    }

    await expect(reconcileWithProjection(value, first, {
      status: 'running',
      ...running(changed),
    })).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' })
    expect(await readFile(receiptPath)).toEqual(original)
  })
})

function frozen<T>(value: T, path: string): FrozenRecord<T> & { readonly path: string } {
  const text = canonicalJson(value)
  return { value, canonicalJson: text, sha256: sha256(text), path }
}

function rawReceiptHash(kind: 'started' | 'exit', value: unknown): string {
  return sha256(`autolab-local-tmux-${kind}-v1\0${canonicalJson(value)}`)
}

function running(started: StartedAttemptReceipt) {
  return {
    tmuxPresent: true,
    tmuxInspectable: true,
    started,
  } as const
}

async function reconcile(
  value: Fixture,
  inspection: LocalTmuxInspection,
  observedAt = issuedAt + 30,
) {
  return await reconcileLocalTmuxInspection({
    runRoot: value.runRoot,
    runSlotState: value.state,
    intent: value.intent,
    inspection,
    observedAt,
  })
}

async function reconcileWithProjection(
  value: Fixture,
  result: Awaited<ReturnType<typeof reconcile>>,
  inspection: LocalTmuxInspection,
  observedAt = issuedAt + 30,
) {
  if (!('records' in result) || result.transition === undefined) {
    throw new Error('result has no projection')
  }
  const last = [...result.records].reverse().find(record => record.attemptArtifact !== undefined)
  if (last?.attemptArtifact === undefined) throw new Error('result has no Attempt artifact')
  return await reconcileLocalTmuxInspection({
    runRoot: value.runRoot,
    runSlotState: result.transition.state,
    intent: {
      request: value.intent.request,
      attempt: last.attemptArtifact,
      launchPlan: value.intent.launchPlan,
    },
    inspection,
    observedAt,
  })
}
