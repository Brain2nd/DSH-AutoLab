import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import { ArtifactStore, type FrozenRevision } from '../src/artifacts.js'
import {
  freezeAttemptReceiptArtifact,
  freezeAttemptStateArtifact,
} from '../src/attempt-artifacts.js'
import {
  prepareInitialLocalAttempt,
  prepareRetryLocalAttempt,
  verifyRetryLocalAttemptReplay,
} from '../src/attempt-launch.js'
import { sha256 } from '../src/integrity.js'
import { activeTrialSchema, type ActiveCandidate, type ActiveTrial } from '../src/state.js'
import {
  compileAttemptCompletionReceipt,
  recordAttemptCompletion,
} from '../src/trial.js'
import { validManifest } from './manifest.test.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []
const dialogueHash = 'd'.repeat(64)

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Controller-selected initial local Attempt', () => {
  it('joins opaque Trial bytes to the exact frozen Candidate and detached checkout', async () => {
    const { root, frozen, candidate } = await fixture()
    const input = {
      frozen,
      candidate,
      laneId: 'lane-a',
      trialId: 'trial-a',
      trialContract: { arbitrary: ['opaque', { threshold: 0.7 }] },
      runSlots: [
        { runSlotId: 'slot-a', contract: { seed: 7 } },
        { runSlotId: 'slot-b' },
      ],
      selectedRunSlotId: 'slot-a',
      hostId: 'local',
      command: ['node', '-e', 'process.exit(0)'],
      env: { CUDA_VISIBLE_DEVICES: '0' },
      runtimePokeFile: join(root, 'autolab', 'runtime-poke.json'),
      anchoredAt: 20,
    }

    const first = await prepareInitialLocalAttempt(input)
    const replay = await prepareInitialLocalAttempt(input)

    expect(replay).toEqual(first)
    expect(activeTrialSchema.parse(first.projection)).toEqual(first.projection)
    expect(first.artifacts.trial.value.contract).toEqual(input.trialContract)
    expect(first.projection.runSlots['slot-b']).toMatchObject({
      state: { status: 'pending', revision: 0 },
    })
    expect(first.projection.runSlots['slot-a']).toMatchObject({
      state: { status: 'attempt_active', revision: 1 },
      activeAttempt: {
        phase: 'launching',
        checkout: {
          path: first.checkout.receiptPath,
          hash: first.checkout.receiptSha256,
        },
      },
    })
    expect(first.checkout.headSha).toBe(candidate.candidateSha)
    expect(first.intent.request.value.runtime_poke_file).toBe(input.runtimePokeFile)
  })
})

describe('Controller-selected local technical retry', () => {
  it('adopts one immutable retry in the same Trial, RunSlot, and Candidate lineage', async () => {
    const { root, frozen, candidate } = await fixture()
    const initial = await prepareInitialLocalAttempt(initialInput(root, frozen, candidate))
    const failed = await terminalProjection(frozen, initial, 'failed')
    const input = {
      frozen,
      trialId: 'trial-a',
      trial: failed,
      runSlotId: 'slot-a',
      hostId: 'local',
      command: ['node', '-e', 'process.exit(0)', '--retry'],
      env: { CUDA_VISIBLE_DEVICES: '1', AUTOLAB_RETRY: '1' },
      runtimePokeFile: join(root, 'autolab', 'runtime-poke.json'),
    }

    const first = await prepareRetryLocalAttempt(input)
    const replay = await prepareRetryLocalAttempt(input)
    const previous = initial.intent.attempt.value
    const retry = first.intent.attempt.value

    expect(replay).toEqual(first)
    expect(retry).toMatchObject({
      phase: 'launching',
      attempt_ordinal: 2,
      predecessor_attempt_id: previous.attempt_id,
      trial_id: previous.trial_id,
      runslot_id: previous.runslot_id,
      trial_contract_sha256: previous.trial_contract_sha256,
      runslot_contract_sha256: previous.runslot_contract_sha256,
      candidate_sha: previous.candidate_sha,
      config_revision: previous.config_revision,
      host_id: input.hostId,
    })
    expect(first.intent.request.value).toMatchObject({
      command: input.command,
      env: input.env,
      attempt_ordinal: 2,
      candidate_sha: candidate.candidateSha,
      issued_at: 30,
    })
    expect(first.checkout.receipt.createdAt).toBe(30)
    expect(first.projection).toEqual(activeTrialSchema.parse(first.projection))
    expect(first.projection).toMatchObject({
      sourceRevision: failed.sourceRevision,
      laneId: failed.laneId,
      candidateId: failed.candidateId,
      candidateSha: failed.candidateSha,
    })
    expect(first.projection.runSlots['slot-a']).toMatchObject({
      contract: failed.runSlots['slot-a']!.contract,
      state: {
        status: 'attempt_active',
        revision: 3,
        attempt_ids: [previous.attempt_id, retry.attempt_id],
        launch_nonces: [previous.launch_nonce, retry.launch_nonce],
      },
      activeAttempt: {
        attemptId: retry.attempt_id,
        phase: 'launching',
        checkout: {
          path: first.checkout.receiptPath,
          hash: first.checkout.receiptSha256,
        },
      },
    })
    expect(first.projection.runSlots['slot-b']).toEqual(failed.runSlots['slot-b'])
    expect(first.checkout.headSha).toBe(candidate.candidateSha)
    expect(first.checkout.checkoutPath).not.toBe(initial.checkout.checkoutPath)

    await expect(prepareRetryLocalAttempt({
      ...input,
      command: ['node', '-e', 'process.exit(2)'],
    })).rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT' })
  })

  it('rejects non-failed or drifted projections before creating a retry', async () => {
    const { root, frozen, candidate } = await fixture()
    const initial = await prepareInitialLocalAttempt(initialInput(root, frozen, candidate))
    const succeeded = await terminalProjection(frozen, initial, 'succeeded')
    const base = {
      frozen,
      trialId: 'trial-a',
      runSlotId: 'slot-a',
      hostId: 'local',
      command: ['node', '-e', 'process.exit(0)'],
      env: {},
      runtimePokeFile: join(root, 'autolab', 'runtime-poke.json'),
    }

    await expect(prepareRetryLocalAttempt({ ...base, trial: succeeded }))
      .rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' })

    const retryable = await fixture()
    const retryableInitial = await prepareInitialLocalAttempt(initialInput(
      retryable.root,
      retryable.frozen,
      retryable.candidate,
    ))
    const failed = await terminalProjection(retryable.frozen, retryableInitial, 'failed')
    const drifted = activeTrialSchema.parse({
      ...failed,
      candidateSha: 'b'.repeat(40),
    })
    await expect(prepareRetryLocalAttempt({
      ...base,
      frozen: retryable.frozen,
      runtimePokeFile: join(retryable.root, 'autolab', 'runtime-poke.json'),
      trial: drifted,
    }))
      .rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' })
  })

  it('adopts only the exact active retry request and rejects an initial or conflicting Attempt', async () => {
    const { root, frozen, candidate } = await fixture()
    const initial = await prepareInitialLocalAttempt(initialInput(root, frozen, candidate))
    const failed = await terminalProjection(frozen, initial, 'failed')
    const request = {
      frozen,
      trialId: 'trial-a',
      runSlotId: 'slot-a',
      hostId: 'local',
      command: ['node', '-e', 'process.exit(0)', '--retry'],
      env: { AUTOLAB_RETRY: '1', CUDA_VISIBLE_DEVICES: '1' },
    }
    const prepared = await prepareRetryLocalAttempt({
      ...request,
      trial: failed,
      runtimePokeFile: join(root, 'autolab', 'runtime-poke.json'),
    })

    await expect(verifyRetryLocalAttemptReplay({
      ...request,
      trial: prepared.projection,
    })).resolves.toEqual({
      request: prepared.intent.request,
      attempt: prepared.intent.attempt,
      launchPlan: prepared.intent.launchPlan,
    })
    await expect(verifyRetryLocalAttemptReplay({
      ...request,
      trial: initial.projection,
    })).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' })
    await expect(verifyRetryLocalAttemptReplay({
      ...request,
      trial: prepared.projection,
      hostId: 'other-host',
    })).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' })
    await expect(verifyRetryLocalAttemptReplay({
      ...request,
      trial: prepared.projection,
      command: ['node', '-e', 'process.exit(9)'],
    })).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' })
    await expect(verifyRetryLocalAttemptReplay({
      ...request,
      trial: prepared.projection,
      env: { AUTOLAB_RETRY: '2', CUDA_VISIBLE_DEVICES: '1' },
    })).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' })
  })
})

function initialInput(
  root: string,
  frozen: FrozenRevision,
  candidate: ActiveCandidate,
) {
  return {
    frozen,
    candidate,
    laneId: 'lane-a',
    trialId: 'trial-a',
    trialContract: { arbitrary: ['opaque', { threshold: 0.7 }] },
    runSlots: [
      { runSlotId: 'slot-a', contract: { seed: 7 } },
      { runSlotId: 'slot-b' },
    ],
    selectedRunSlotId: 'slot-a',
    hostId: 'local',
    command: ['node', '-e', 'process.exit(0)'],
    env: { CUDA_VISIBLE_DEVICES: '0' },
    runtimePokeFile: join(root, 'autolab', 'runtime-poke.json'),
    anchoredAt: 20,
  } as const
}

async function terminalProjection(
  frozen: FrozenRevision,
  initial: Awaited<ReturnType<typeof prepareInitialLocalAttempt>>,
  outcome: 'succeeded' | 'failed',
): Promise<ActiveTrial> {
  const attempt = initial.intent.attempt.value
  const receipt = compileAttemptCompletionReceipt({
    version: 1,
    type: 'attempt_completion',
    attempt_id: attempt.attempt_id,
    launch_nonce: attempt.launch_nonce,
    candidate_sha: attempt.candidate_sha,
    request_sha256: attempt.request.sha256,
    completed_at: 30,
    completion_identity: `fixture-${outcome}`,
    technical_outcome: outcome,
    ...(outcome === 'failed'
      ? { technical_detail: { kind: 'runner' as const, code: 'FIXTURE_FAILED' } }
      : {}),
    artifacts: [],
  })
  const receiptArtifact = await freezeAttemptReceiptArtifact(
    frozen.manifest.execution.run_root,
    attempt.attempt_id,
    'completion',
    receipt,
  )
  const transition = recordAttemptCompletion(
    initial.intent.transition.state,
    initial.intent.transition.state.revision,
    attempt,
    receipt,
    receiptArtifact.path,
  )
  const artifact = await freezeAttemptStateArtifact(
    frozen.manifest.execution.run_root,
    transition.state.revision,
    transition.attempt,
  )
  const slot = initial.projection.runSlots['slot-a']!
  return activeTrialSchema.parse({
    ...initial.projection,
    runSlots: {
      ...initial.projection.runSlots,
      'slot-a': {
        ...slot,
        state: transition.state,
        activeAttempt: {
          ...slot.activeAttempt,
          attemptId: transition.attempt.attempt_id,
          phase: transition.attempt.phase,
          path: artifact.path,
          hash: artifact.sha256,
        },
      },
    },
  })
}

async function fixture(): Promise<{
  readonly root: string
  readonly frozen: FrozenRevision
  readonly candidate: ActiveCandidate
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-autolab-attempt-launch-')))
  roots.push(root)
  const repository = join(root, 'repository')
  await mkdir(repository, { recursive: true })
  await execFileAsync('git', ['-C', repository, 'init', '--quiet', '--initial-branch=main'])
  await execFileAsync('git', ['-C', repository, 'config', 'user.name', 'AutoLab Test'])
  await execFileAsync('git', ['-C', repository, 'config', 'user.email', 'autolab@example.invalid'])
  await writeFile(join(repository, 'candidate.js'), 'export default 1\n')
  await execFileAsync('git', ['-C', repository, 'add', 'candidate.js'])
  await execFileAsync('git', ['-C', repository, 'commit', '--quiet', '-m', 'candidate'])
  const { stdout } = await execFileAsync('git', ['-C', repository, 'rev-parse', 'HEAD'])
  const candidateSha = stdout.trim()

  const source = join(root, 'source')
  const spec = '# Trial fixture\n'
  const config = 'schema_version: 1\nfixture: attempt-launch\n'
  await mkdir(source, { recursive: true })
  await Promise.all([
    writeFile(join(source, 'LAB_SPEC.md'), spec),
    writeFile(join(source, 'lab.yaml'), config),
  ])
  const store = new ArtifactStore(join(root, 'autolab'))
  await store.initialize()
  const manifest = structuredClone(validManifest())
  await store.createLab({
    labId: manifest.lab_id,
    controllerSessionId: 'controller-session',
    sourceDirectory: source,
  })
  bindManifest(manifest, store, root, repository, spec, config)
  const frozen = await store.freezeDraftRevision({
    labId: manifest.lab_id,
    revision: 1,
    manifest,
    dialogueHeadHash: dialogueHash,
  })
  const candidate: ActiveCandidate = {
    version: 1,
    sourceRevision: 1,
    laneId: 'lane-a',
    candidateId: 'candidate-a',
    coderRoleId: 'lane-a-coder',
    coderSessionId: 'coder-session',
    assignmentId: 'coder-assignment',
    candidateSha,
    captureReceipt: { path: join(root, 'candidate.json'), hash: 'a'.repeat(64) },
    frozenAt: 10,
  }
  return { root, frozen, candidate }
}

function bindManifest(
  manifest: ReturnType<typeof validManifest>,
  store: ArtifactStore,
  root: string,
  repository: string,
  spec: string,
  config: string,
): void {
  const labDirectory = store.labDirectory(manifest.lab_id)
  const revisionDirectory = join(labDirectory, 'revisions', '000001')
  const worktreeRoot = join(root, 'worktrees')
  manifest.source_revision = 1
  manifest.anchors = {
    dialogue_head_sha256: dialogueHash,
    lab_spec_sha256: sha256(spec),
    lab_yaml_sha256: sha256(config),
  }
  manifest.authority_paths = {
    lab_dir: labDirectory,
    creation_log: join(labDirectory, 'dialogue', 'creation.jsonl'),
    lab_spec: join(revisionDirectory, 'LAB_SPEC.md'),
    lab_yaml: join(revisionDirectory, 'lab.yaml'),
    resolved_manifest: join(revisionDirectory, 'RESOLVED_MANIFEST.json'),
    fact_set: join(labDirectory, 'artifacts', 'facts.json'),
    evidence_index: join(labDirectory, 'artifacts', 'evidence.json'),
    assignment_root: join(labDirectory, 'assignments'),
    worktree_root: worktreeRoot,
  }
  manifest.repository.path = repository
  manifest.execution.runner_adapter = {
    id: 'local-tmux',
    version: '1',
    sha256: '1'.repeat(64),
  }
  manifest.execution.run_root = join(root, 'runs')
  manifest.execution.hosts = [{ host_id: 'local', runner_target: 'local' }]
  manifest.evidence.artifact_root = join(labDirectory, 'artifacts')
  for (const lane of manifest.lanes) lane.worktree_path = join(worktreeRoot, lane.lane_id)
  for (const role of manifest.roles) {
    if (role.role_kind === 'method' || role.role_kind === 'coder') {
      role.worktree_path = join(worktreeRoot, role.lane_id)
    }
  }
}
