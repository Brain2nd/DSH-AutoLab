import { execFile } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import {
  ArtifactStore,
  compileRunSlotContract,
  compileTrialContract,
  createRunSlotState,
  freezeInitialLocalAttempt,
  readLocalAttemptIntent,
  verifyInitialLocalAttempt,
  type CreateInitialLocalAttemptInput,
  type FrozenRevision,
} from '../src/core.js'
import { canonicalJson, sha256 } from '../src/integrity.js'
import { validManifest } from './manifest.test.js'

const DIALOGUE_HEAD_HASH = 'd'.repeat(64)
const CREATED_AT = 1_786_742_400_123
const ISSUED_AT = CREATED_AT + 17
const CANDIDATE_SHA = 'a'.repeat(40)
const roots: string[] = []
const execFileAsync = promisify(execFile)

interface Fixture {
  readonly root: string
  readonly frozen: FrozenRevision
  readonly input: CreateInitialLocalAttemptInput
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-autolab-attempt-artifacts-'))
  roots.push(root)
  const source = join(root, 'source')
  const spec = '# Exact Attempt contract\n\nRun only this frozen command.\n'
  const config = 'schema_version: 1\nfixture: attempt-artifacts\n'
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
    controllerSessionId: 'session-controller',
    sourceDirectory: source,
    now: 1,
  })
  bindManifest(manifest, store, root, spec, config)
  manifest.execution.runner_adapter.id = 'local-tmux'
  manifest.execution.run_root = join(root, 'runs')
  manifest.execution.hosts = [{ host_id: 'local', runner_target: 'local' }]
  const frozen = await store.freezeDraftRevision({
    labId: manifest.lab_id,
    revision: 1,
    manifest,
    dialogueHeadHash: DIALOGUE_HEAD_HASH,
  })

  const trial = compileTrialContract({
    version: 1,
    trial_id: 'trial-fusion-1',
    lane_id: 'lane-a',
    candidate_sha: CANDIDATE_SHA,
    config_revision: frozen.ref.revision,
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
    run_slots: [{
      runslot_id: 'slot-seed-7-r0',
      contract: { seed: 7, replicate: 0 },
    }],
    created_at: CREATED_AT,
  })
  const runSlot = compileRunSlotContract(trial, 'slot-seed-7-r0')
  const input: CreateInitialLocalAttemptInput = {
    frozen,
    trial,
    runSlot,
    runSlotState: createRunSlotState(runSlot),
    hostId: 'local',
    command: ['python', 'train.py', '--seed', '7'],
    env: { CUDA_VISIBLE_DEVICES: '0', PYTHONHASHSEED: '7' },
    runtimePokeFile: join(root, 'autolab', 'runtime-poke.json'),
    issuedAt: ISSUED_AT,
  }
  return { root, frozen, input }
}

describe('immutable local Attempt artifacts', () => {
  it('freezes and verifies one deterministic exact replay in canonical JSON', async () => {
    const value = await fixture()
    const first = await freezeInitialLocalAttempt(value.input)
    const replay = await freezeInitialLocalAttempt(value.input)

    expect(replay).toEqual(first)
    expect(await verifyInitialLocalAttempt(value.input)).toEqual(first)
    expect(await readFile(first.request.path, 'utf8')).toBe(first.request.canonicalJson)
    expect(await readFile(first.attempt.path, 'utf8')).toBe(first.attempt.canonicalJson)
    expect(first.request.canonicalJson).toBe(canonicalJson(first.request.value))
    expect(first.attempt.canonicalJson).toBe(canonicalJson(first.attempt.value))
  })

  it('rejects changed launch bytes at the same Attempt paths without overwriting', async () => {
    const value = await fixture()
    const first = await freezeInitialLocalAttempt(value.input)
    const originalRequest = await readFile(first.request.path)
    const originalAttempt = await readFile(first.attempt.path)
    const changed: CreateInitialLocalAttemptInput = {
      ...value.input,
      command: ['python', 'other.py'],
      env: { CUDA_VISIBLE_DEVICES: '1' },
      issuedAt: ISSUED_AT + 1,
    }

    await expect(freezeInitialLocalAttempt(changed)).rejects.toMatchObject({
      code: 'ARTIFACT_CONFLICT',
    })
    expect(await readFile(first.request.path)).toEqual(originalRequest)
    expect(await readFile(first.attempt.path)).toEqual(originalAttempt)
  })

  it('fails closed when a request, Attempt, or Controller hash is missing or altered', async () => {
    const value = await fixture()
    const first = await freezeInitialLocalAttempt(value.input)
    const reference = { path: first.attempt.path, hash: first.attempt.sha256 }

    await rm(first.request.path)
    await expect(readLocalAttemptIntent({
      runRoot: value.frozen.manifest.execution.run_root,
      activeAttempt: reference,
    })).rejects.toMatchObject({ code: 'ARTIFACT_CORRUPT' })
    await expect(verifyInitialLocalAttempt(value.input)).rejects.toMatchObject({
      code: 'ARTIFACT_CORRUPT',
    })

    await writeFile(first.request.path, first.request.canonicalJson)
    await writeFile(first.attempt.path, '{"tampered":true}')
    await expect(readLocalAttemptIntent({
      runRoot: value.frozen.manifest.execution.run_root,
      activeAttempt: reference,
    })).rejects.toMatchObject({ code: 'ARTIFACT_CORRUPT' })

    await writeFile(first.attempt.path, first.attempt.canonicalJson)
    await expect(readLocalAttemptIntent({
      runRoot: value.frozen.manifest.execution.run_root,
      activeAttempt: { path: first.attempt.path, hash: 'f'.repeat(64) },
    })).rejects.toMatchObject({ code: 'ARTIFACT_CORRUPT' })
  })

  it('rejects symlink and FIFO substitutions without following or blocking', async () => {
    const value = await fixture()
    const first = await freezeInitialLocalAttempt(value.input)
    const runRoot = value.frozen.manifest.execution.run_root
    const reference = { path: first.attempt.path, hash: first.attempt.sha256 }
    const target = join(value.root, 'substitution-target.json')
    await writeFile(target, first.request.canonicalJson)

    await rm(first.request.path)
    await symlink(target, first.request.path)
    await expect(readLocalAttemptIntent({ runRoot, activeAttempt: reference }))
      .rejects.toMatchObject({ code: 'ARTIFACT_CORRUPT' })

    await rm(first.request.path)
    await writeFile(first.request.path, first.request.canonicalJson)
    await rm(first.attempt.path)
    await symlink(target, first.attempt.path)
    await expect(readLocalAttemptIntent({ runRoot, activeAttempt: reference }))
      .rejects.toMatchObject({ code: 'ARTIFACT_CORRUPT' })

    await rm(first.attempt.path)
    await writeFile(first.attempt.path, first.attempt.canonicalJson)
    await rm(first.request.path)
    await execFileAsync('mkfifo', [first.request.path])
    await expect(readLocalAttemptIntent({ runRoot, activeAttempt: reference }))
      .rejects.toMatchObject({ code: 'ARTIFACT_CORRUPT' })

    await rm(first.request.path)
    await writeFile(first.request.path, first.request.canonicalJson)
    await rm(first.attempt.path)
    await execFileAsync('mkfifo', [first.attempt.path])
    await expect(readLocalAttemptIntent({ runRoot, activeAttempt: reference }))
      .rejects.toMatchObject({ code: 'ARTIFACT_CORRUPT' })
  })

  it('binds request, Attempt, and launch plan to one complete launch identity', async () => {
    const value = await fixture()
    const frozen = await freezeInitialLocalAttempt(value.input)
    const { request, attempt, launchPlan } = frozen

    expect(request.sha256).toBe(sha256(request.canonicalJson))
    expect(attempt.value).toMatchObject({
      request: { kind: 'runner_request', sha256: request.sha256 },
      attempt_id: request.value.attempt_id,
      attempt_ordinal: request.value.attempt_ordinal,
      launch_nonce: request.value.launch_nonce,
      candidate_sha: request.value.candidate_sha,
      config_revision: request.value.config_revision,
      trial_id: request.value.trial_id,
      runslot_id: request.value.runslot_id,
      runner: request.value.runner,
      host_id: request.value.host_id,
      cwd: request.value.cwd,
    })
    expect(request.value).toMatchObject({
      lab_id: value.frozen.manifest.lab_id,
      config_revision: value.frozen.ref.revision,
      trial_id: value.input.trial.value.trial_id,
      runslot_id: value.input.runSlot.value.runslot_id,
      candidate_sha: value.input.runSlot.value.candidate_sha,
      runner: value.frozen.manifest.execution.runner_adapter,
      host_id: value.input.hostId,
      checkout_path: frozen.checkoutPath,
      runtime_poke_file: value.input.runtimePokeFile,
    })
    expect(attempt.value.env_sha256).toBe(launchPlan.envHash)
    expect(launchPlan).toMatchObject({
      attemptId: request.value.attempt_id,
      launchNonce: request.value.launch_nonce,
      candidateSha: request.value.candidate_sha,
      command: request.value.command,
      env: request.value.env,
      cwd: request.value.cwd,
      attemptDirectory: request.value.attempt_directory,
      runtimePokeFile: value.input.runtimePokeFile,
      issuedAt: request.value.issued_at,
    })
  })
})

function bindManifest(
  manifest: ReturnType<typeof validManifest>,
  store: ArtifactStore,
  root: string,
  spec: string,
  config: string,
): void {
  const labDirectory = store.labDirectory(manifest.lab_id)
  const revisionDirectory = join(labDirectory, 'revisions', '000001')
  const worktreeRoot = join(root, 'worktrees')
  manifest.source_revision = 1
  manifest.anchors = {
    dialogue_head_sha256: DIALOGUE_HEAD_HASH,
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
  manifest.repository.path = join(root, 'repository')
  manifest.evidence.artifact_root = join(labDirectory, 'artifacts')
  for (const lane of manifest.lanes) lane.worktree_path = join(worktreeRoot, lane.lane_id)
  for (const role of manifest.roles) {
    if (role.role_kind === 'method' || role.role_kind === 'coder') {
      role.worktree_path = join(worktreeRoot, role.lane_id)
    }
  }
}
