import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { freezeInitialRoleArtifacts } from '../src/activation-artifacts.js'
import { ArtifactStore, sha256, type FrozenRevision } from '../src/artifacts.js'
import { freezeRoleBinding, type StoredRoleBinding } from '../src/binding.js'
import { canonicalJson, type ResolvedManifest } from '../src/manifest.js'
import {
  freezePostflightReviewArtifacts,
  type FreezePostflightReviewArtifactsInput,
  type PostflightArtifactReference,
} from '../src/postflight-artifacts.js'
import {
  resolveRootRoleSessionSpec,
  rolePromptFor,
  type RootRoleBinding,
} from '../src/roles.js'
import { validManifest } from './manifest.test.js'

const DIALOGUE_HEAD_HASH = 'd'.repeat(64)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

interface Fixture {
  readonly root: string
  readonly input: FreezePostflightReviewArtifactsInput
  readonly missingReferences: readonly PostflightArtifactReference[]
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-autolab-postflight-artifacts-'))
  roots.push(root)
  const source = join(root, 'source')
  const spec = '# Exact Postflight contract\n\nRead the original evidence. Do not use a global verdict enum.\n'
  const config = 'schema_version: 1\nfixture: postflight-artifacts\n'
  await mkdir(source, { recursive: true })
  await Promise.all([
    writeFile(join(source, 'LAB_SPEC.md'), spec, 'utf8'),
    writeFile(join(source, 'lab.yaml'), config, 'utf8'),
  ])

  const store = new ArtifactStore(join(root, 'autolab'))
  await store.initialize()
  const manifest = structuredClone(validManifest())
  manifest.evidence.contract = {
    output_format: {
      attribution: 'Lab-owned free form',
      decision: 'Lab-owned free form',
      preserve_raw_observations: true,
    },
  }
  await store.createLab({
    labId: manifest.lab_id,
    controllerSessionId: 'session-controller',
    sourceDirectory: source,
    now: 1,
  })
  bindManifestToFixture(manifest, store, root, spec, config)
  const frozen = await store.freezeDraftRevision({
    labId: manifest.lab_id,
    revision: 1,
    manifest,
    dialogueHeadHash: DIALOGUE_HEAD_HASH,
  })

  const coderRole = rootRole(frozen.manifest, 'lane-a-coder')
  const coderBinding = await bindingFor(frozen, coderRole)
  const coderArtifacts = await freezeInitialRoleArtifacts({
    frozen,
    role: coderRole,
    sessionId: coderBinding.receipt.sessionId,
    binding: coderBinding,
    runtimeRevision: coderBinding.receipt.runtimeRevision,
    issuedAt: coderBinding.receipt.issuedAt,
  })

  const judgeRole = rootRole(frozen.manifest, 'lane-a-postflight')
  const judgeBinding = await bindingFor(frozen, judgeRole)
  const missingRoot = join(root, 'originals-not-opened-by-runtime')
  const missingReferences = [
    reference(join(missingRoot, 'method-packet.json'), '1'),
    reference(join(missingRoot, 'preflight-result.json'), '2'),
    reference(join(missingRoot, 'coder-result.json'), '3'),
    reference(join(missingRoot, 'trial.json'), '4'),
    reference(join(missingRoot, 'runslot.json'), '5'),
    reference(join(missingRoot, 'attempt.json'), '6'),
  ] as const

  return {
    root,
    missingReferences,
    input: {
      frozen,
      judgeSessionId: judgeBinding.receipt.sessionId,
      judgeBinding,
      currentCoderPacket: {
        path: coderArtifacts.packetPath,
        sha256: coderArtifacts.packet.packetHash,
      },
      methodPacket: missingReferences[0],
      preflightResult: missingReferences[1],
      coderResult: missingReferences[2],
      trial: missingReferences[3],
      runSlot: missingReferences[4],
      attempt: missingReferences[5],
      reviewId: 'postflight-lane-a-0001',
      runtimeRevision: 9,
      issuedAt: 1_786_742_400_200,
      revealState: 'revealed',
    },
  }
}

describe('opaque Postflight review artifacts', () => {
  it('compiles a CURRENT-bound Judge Packet without opening scientific inputs', async () => {
    const value = await fixture()
    const first = await freezePostflightReviewArtifacts(value.input)
    const replay = await freezePostflightReviewArtifacts(value.input)
    expect(replay).toEqual(first)

    expect(first.assignmentId).toBe(`postflight:${value.input.reviewId}`)
    expect(first.packet.packetHash).toBe(sha256(first.packet.canonicalJson))
    expect(await readFile(first.assignmentPath, 'utf8')).toBe(first.assignmentText)
    expect(await readFile(first.packetPath, 'utf8')).toBe(first.packet.canonicalJson)

    const packet = first.packet.packet
    expect(packet.header).toMatchObject({
      role_id: 'lane-a-postflight',
      role_kind: 'postflight_judge',
      session_id: value.input.judgeSessionId,
      assignment_id: first.assignmentId,
    })
    expect(packet.runtime_snapshot.reveal_state).toBe('revealed')
    expect(packet.output_contract).toEqual({
      schema: value.input.frozen.manifest.evidence.contract,
      receipt_path: first.resultPath,
      expected_hash_binding: first.reviewInputHash,
    })
    expect(packet.output_contract.schema).not.toHaveProperty('top_level_verdict')
    expect(packet.output_contract.schema).not.toHaveProperty('blocking_findings')
    expect(packet.verbatim_blocks.stage).toEqual([])

    expect(packet.runtime_snapshot.input_artifact_refs).toEqual([
      artifact('current-coder-packet', value.input.currentCoderPacket),
      artifact('method-packet', value.input.methodPacket),
      artifact('preflight-result', value.input.preflightResult),
      artifact('coder-result', value.input.coderResult),
      artifact('trial', value.input.trial),
      artifact('run-slot', value.input.runSlot),
      artifact('attempt', value.input.attempt),
    ])
    const assignment = JSON.parse(first.assignmentText) as Record<string, unknown>
    expect(assignment).toMatchObject({
      assignment_type: 'postflight_review',
      review_id: value.input.reviewId,
      review_input_sha256: first.reviewInputHash,
      reveal_state: 'revealed',
      output_contract: packet.output_contract,
    })

    for (const reference of value.missingReferences) {
      await expect(stat(reference.path)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('rejects only real CURRENT or binding drift, not absent experiment files', async () => {
    const value = await fixture()
    await expect(freezePostflightReviewArtifacts({
      ...value.input,
      judgeSessionId: 'another-session',
    })).rejects.toMatchObject({ code: 'JUDGE_BINDING_MISMATCH' })

    const changed = await fixture()
    await writeFile(changed.input.currentCoderPacket.path, 'changed packet bytes', 'utf8')
    await expect(freezePostflightReviewArtifacts(changed.input))
      .rejects.toMatchObject({ code: 'CODER_PACKET_MISMATCH' })
  })
})

function bindManifestToFixture(
  manifest: ResolvedManifest,
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
  manifest.execution.run_root = join(labDirectory, 'artifacts', 'runs')
  for (const lane of manifest.lanes) lane.worktree_path = join(worktreeRoot, lane.lane_id)
  for (const charter of manifest.search.lane_charters) {
    charter.charter_sha256 = sha256(canonicalJson(charter.content))
  }
  for (const role of manifest.roles) {
    role.prompt_sha256 = rolePromptFor(role.role_kind).sha256
    if (role.role_kind === 'method' || role.role_kind === 'coder') {
      role.worktree_path = join(worktreeRoot, role.lane_id)
    }
  }
}

function rootRole(manifest: ResolvedManifest, roleId: string): RootRoleBinding {
  const role = manifest.roles.find(candidate => candidate.role_id === roleId)
  if (role === undefined || role.role_kind === 'controller') throw new Error(`invalid role ${roleId}`)
  return role
}

async function bindingFor(
  frozen: FrozenRevision,
  role: RootRoleBinding,
): Promise<StoredRoleBinding> {
  const spec = resolveRootRoleSessionSpec(frozen.manifest, role.role_id)
  return await freezeRoleBinding({
    labDirectory: frozen.manifest.authority_paths.lab_dir,
    labId: frozen.manifest.lab_id,
    manifestHash: frozen.ref.manifestHash,
    roleId: role.role_id,
    roleKind: role.role_kind,
    sessionId: `session-${role.role_id}`,
    agentPresetId: 'default-agent',
    permissionPresetId: role.dsh_preset,
    provider: role.model_route.provider,
    model: role.model_route.model,
    cwd: spec.cwd,
    runtimeRevision: 7,
    issuedAt: 1_786_742_400_000,
  })
}

function reference(path: string, character: string): PostflightArtifactReference {
  return { path, sha256: character.repeat(64) }
}

function artifact(
  artifactId: string,
  reference: PostflightArtifactReference,
): { artifact_id: string; path: string; sha256: string } {
  return { artifact_id: artifactId, path: reference.path, sha256: reference.sha256 }
}
