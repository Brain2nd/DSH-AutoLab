import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  freezeInitialRoleArtifacts,
  restoreCurrentRoleArtifacts,
} from '../src/activation-artifacts.js'
import { ArtifactStore, sha256, type FrozenRevision } from '../src/artifacts.js'
import { freezeRoleBinding, type StoredRoleBinding } from '../src/binding.js'
import { canonicalJson, type ResolvedManifest } from '../src/manifest.js'
import { compileRolePacket, type CompiledRolePacket } from '../src/packet.js'
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

interface ActivationFixture {
  readonly root: string
  readonly frozen: FrozenRevision
}

async function fixture(): Promise<ActivationFixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-autolab-activation-'))
  roots.push(root)
  const source = join(root, 'source')
  const spec = '# Exact research contract\n\n约束：保留原文。  \n'
  const config = 'schema_version: 1\nfixture: activation-artifacts\n'
  await mkdir(source, { recursive: true })
  await Promise.all([
    writeFile(join(source, 'LAB_SPEC.md'), spec, 'utf8'),
    writeFile(join(source, 'lab.yaml'), config, 'utf8'),
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
  bindManifestToFixture(manifest, store, root, spec, config)
  const frozen = await store.freezeDraftRevision({
    labId: manifest.lab_id,
    revision: 1,
    manifest,
    dialogueHeadHash: DIALOGUE_HEAD_HASH,
  })
  return { root, frozen }
}

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

  for (const lane of manifest.lanes) {
    lane.worktree_path = join(worktreeRoot, lane.lane_id)
  }
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
  if (role === undefined || role.role_kind === 'controller') {
    throw new Error(`invalid root-role fixture ${roleId}`)
  }
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

async function laterMethodArtifacts(input: {
  frozen: FrozenRevision
  role: RootRoleBinding
  binding: StoredRoleBinding
}): Promise<{
  readonly assignmentId: string
  readonly assignmentPath: string
  readonly assignmentText: string
  readonly objective: string
  readonly packetPath: string
  readonly packet: CompiledRolePacket
  readonly factText: string
  readonly evidenceText: string
}> {
  if (input.role.role_kind !== 'method') throw new Error('invalid later-Assignment fixture')
  const initial = await freezeInitialRoleArtifacts({
    frozen: input.frozen,
    role: input.role,
    sessionId: input.binding.receipt.sessionId,
    binding: input.binding,
    runtimeRevision: input.binding.receipt.runtimeRevision,
    issuedAt: input.binding.receipt.issuedAt,
  })
  const manifest = input.frozen.manifest
  const factText = canonicalJson({
    version: 1,
    facts: [{ id: 'fact-1', text: 'Preserve this accumulated fact.' }],
  })
  const evidenceText = canonicalJson({
    version: 1,
    evidence: [{ id: 'evidence-1', result: 'negative' }],
  })
  await Promise.all([
    writeFile(manifest.authority_paths.fact_set, factText, 'utf8'),
    writeFile(manifest.authority_paths.evidence_index, evidenceText, 'utf8'),
  ])

  const assignmentId = `${input.role.lane_id}:method:iteration-2`
  const objective = 'Develop the next exact Method Design Ticket from this accumulated evidence.'
  const assignmentPath = join(
    manifest.authority_paths.assignment_root,
    `${sha256(assignmentId)}.json`,
  )
  const outputContract = {
    schema: { type: 'object', additionalProperties: true },
    receipt_path: join(
      manifest.authority_paths.assignment_root,
      'outputs',
      `${sha256(assignmentId)}.json`,
    ),
    expected_hash_binding: assignmentId,
  }
  const assignmentText = canonicalJson({
    version: 1,
    assignment_id: assignmentId,
    role_id: input.role.role_id,
    role_kind: input.role.role_kind,
    objective,
    output_contract: outputContract,
  })
  await writeFile(assignmentPath, assignmentText, 'utf8')
  const packet = compileRolePacket({
    manifest,
    role_id: input.role.role_id,
    session_id: input.binding.receipt.sessionId,
    assignment_id: assignmentId,
    issued_at: input.binding.receipt.issuedAt + 1,
    role_binding_receipt_sha256: input.binding.hash,
    runtime_revision: input.binding.receipt.runtimeRevision + 2,
    fact_set_sha256: sha256(factText),
    evidence_index_sha256: sha256(evidenceText),
    assignment_contract_sha256: sha256(assignmentText),
    reveal_state: manifest.communication.reveal_policy.initial_state,
    verbatim_blocks: {
      ...initial.packet.packet.verbatim_blocks,
      assignment: [{
        block_id: 'assignment-contract-iteration-2',
        source_path: assignmentPath,
        exact_text: assignmentText,
        text_sha256: sha256(assignmentText),
      }],
    },
    relevant_fact_refs: [{ id: 'fact-1', sha256: sha256('Preserve this accumulated fact.') }],
    evidence_refs: [{ id: 'evidence-1', sha256: sha256('negative') }],
    open_obligation_refs: [],
    input_artifact_refs: [],
    output_contract: outputContract,
  })
  const packetPath = join(
    manifest.authority_paths.lab_dir,
    'packets',
    sha256(assignmentId),
    `${sha256(input.role.role_id)}.json`,
  )
  await mkdir(dirname(packetPath), { recursive: true })
  await writeFile(packetPath, packet.canonicalJson, 'utf8')
  return {
    assignmentId,
    assignmentPath,
    assignmentText,
    objective,
    packetPath,
    packet,
    factText,
    evidenceText,
  }
}

describe('initial immutable activation artifacts', () => {
  it('freezes the Method packet with exact universal, role, Lane, and Assignment blocks', async () => {
    const { frozen } = await fixture()
    const role = rootRole(frozen.manifest, 'lane-a-method')
    const binding = await bindingFor(frozen, role)
    const input = {
      frozen,
      role,
      sessionId: binding.receipt.sessionId,
      binding,
      runtimeRevision: binding.receipt.runtimeRevision,
      issuedAt: binding.receipt.issuedAt,
    }
    const first = await freezeInitialRoleArtifacts(input)
    const second = await freezeInitialRoleArtifacts(input)

    expect(second).toEqual(first)
    expect(first.assignmentId).toBe('lane-a:method:initial')
    expect(first.packet.packetHash).toBe(sha256(first.packet.canonicalJson))
    expect(await readFile(first.packetPath, 'utf8')).toBe(first.packet.canonicalJson)
    expect(first.packet.packet.header).toMatchObject({
      role_id: role.role_id,
      role_kind: 'method',
      session_id: binding.receipt.sessionId,
      assignment_id: first.assignmentId,
    })
    expect(first.packet.packet.anchors).toMatchObject({
      resolved_manifest_sha256: frozen.ref.manifestHash,
      role_binding_receipt_sha256: binding.hash,
      runtime_revision: binding.receipt.runtimeRevision,
      assignment_contract_sha256: first.assignmentHash,
    })

    const blocks = first.packet.packet.verbatim_blocks
    expect(blocks).toMatchObject({
      universal: [{ block_id: 'lab-spec', exact_text: frozen.spec }],
      role: [{
        block_id: 'role-prompt',
        exact_text: rolePromptFor('method').text,
      }],
      lane: [{ block_id: 'lane-charter' }],
      stage: [],
      assignment: [{
        block_id: 'assignment-contract',
      }],
    })
    for (const group of Object.values(blocks)) {
      for (const block of group) {
        expect(block.text_sha256).toBe(sha256(block.exact_text))
      }
    }
    expect(await readFile(blocks.universal[0]!.source_path, 'utf8'))
      .toBe(blocks.universal[0]!.exact_text)
    expect(await readFile(blocks.role[0]!.source_path, 'utf8'))
      .toBe(blocks.role[0]!.exact_text)
    expect(await readFile(blocks.lane[0]!.source_path, 'utf8'))
      .toBe(blocks.lane[0]!.exact_text)
    const assignmentText = await readFile(first.assignmentPath, 'utf8')
    const assignment = JSON.parse(assignmentText)
    expect(assignment.objective).toBe(first.objectiveBody)
    expect(blocks.assignment[0]!.exact_text).toBe(assignmentText)
    expect(blocks.assignment[0]!.text_sha256).toBe(first.assignmentHash)
    expect(sha256(await readFile(first.assignmentPath))).toBe(first.assignmentHash)
    expect(first.objectiveBody).toContain('Read the exact LAB_SPEC and LaneCharter')
    expect(first.objectiveBody).toContain('distinguish method, feature or lens')

    const factBytes = await readFile(frozen.manifest.authority_paths.fact_set, 'utf8')
    const evidenceBytes = await readFile(frozen.manifest.authority_paths.evidence_index, 'utf8')
    expect(first.packet.packet.anchors.fact_set_sha256).toBe(sha256(factBytes))
    expect(first.packet.packet.anchors.evidence_index_sha256).toBe(sha256(evidenceBytes))
  })

  it('binds Preflight and Postflight bootstrap packets to independent roles and Sessions', async () => {
    const { frozen } = await fixture()
    const judges = [
      ['lane-a-preflight', 'preflight_judge'],
      ['lane-a-postflight', 'postflight_judge'],
    ] as const
    const identities: Array<{ roleId: string; sessionId: string; packetHash: string }> = []

    for (const [roleId, roleKind] of judges) {
      const role = rootRole(frozen.manifest, roleId)
      if (role.role_kind !== roleKind) throw new Error(`invalid ${roleKind} fixture`)
      const binding = await bindingFor(frozen, role)
      const artifacts = await freezeInitialRoleArtifacts({
        frozen,
        role,
        sessionId: binding.receipt.sessionId,
        binding,
        runtimeRevision: binding.receipt.runtimeRevision,
        issuedAt: binding.receipt.issuedAt,
      })
      const packet = artifacts.packet.packet

      expect(artifacts.assignmentId).toBe(`${roleId}:bootstrap`)
      expect(artifacts.objectiveBody).toMatch(/^Remain idle\./u)
      expect(packet.header).toMatchObject({
        role_id: roleId,
        role_kind: roleKind,
        session_id: binding.receipt.sessionId,
      })
      expect(packet.verbatim_blocks.role).toEqual([expect.objectContaining({
        block_id: 'role-prompt',
        exact_text: rolePromptFor(roleKind).text,
        text_sha256: rolePromptFor(roleKind).sha256,
      })])
      expect(packet.verbatim_blocks.stage).toEqual([])
      expect(packet.role_binding.prompt_sha256).toBe(rolePromptFor(roleKind).sha256)
      expect(await readFile(artifacts.packetPath, 'utf8')).toBe(artifacts.packet.canonicalJson)
      identities.push({
        roleId,
        sessionId: binding.receipt.sessionId,
        packetHash: artifacts.packet.packetHash,
      })
    }

    expect(new Set(identities.map(identity => identity.roleId)).size).toBe(2)
    expect(new Set(identities.map(identity => identity.sessionId)).size).toBe(2)
    expect(new Set(identities.map(identity => identity.packetHash)).size).toBe(2)
  })

  it('rejects a different packet body at an already-frozen activation identity', async () => {
    const { frozen } = await fixture()
    const role = rootRole(frozen.manifest, 'lane-a-method')
    const binding = await bindingFor(frozen, role)
    const input = {
      frozen,
      role,
      sessionId: binding.receipt.sessionId,
      binding,
      runtimeRevision: binding.receipt.runtimeRevision,
      issuedAt: binding.receipt.issuedAt,
    }
    const committed = await freezeInitialRoleArtifacts(input)
    const committedBytes = await readFile(committed.packetPath, 'utf8')

    await expect(freezeInitialRoleArtifacts({
      ...input,
      issuedAt: input.issuedAt + 1,
    })).rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT' })
    expect(await readFile(committed.packetPath, 'utf8')).toBe(committedBytes)
  })
})

describe('current role artifact recovery', () => {
  it('restores a non-bootstrap Packet and canonical Assignment without rewriting non-empty ledgers', async () => {
    const { frozen } = await fixture()
    const role = rootRole(frozen.manifest, 'lane-a-method')
    const binding = await bindingFor(frozen, role)
    const later = await laterMethodArtifacts({ frozen, role, binding })
    const input = {
      frozen,
      role,
      sessionId: binding.receipt.sessionId,
      binding,
      runtimeRevision: binding.receipt.runtimeRevision + 3,
      packetRef: { path: later.packetPath, hash: later.packet.packetHash },
    }

    const first = await restoreCurrentRoleArtifacts(input)
    const second = await restoreCurrentRoleArtifacts(input)

    expect(second).toEqual(first)
    expect(first).toMatchObject({
      assignmentId: later.assignmentId,
      assignmentPath: later.assignmentPath,
      assignmentHash: sha256(later.assignmentText),
      objectiveBody: later.objective,
      packetPath: later.packetPath,
    })
    expect(first.packet).toEqual(later.packet)
    expect(await readFile(frozen.manifest.authority_paths.fact_set, 'utf8')).toBe(later.factText)
    expect(await readFile(frozen.manifest.authority_paths.evidence_index, 'utf8')).toBe(later.evidenceText)
  })

  it('fails closed when a canonical Packet has manifest-derived capability drift', async () => {
    const { frozen } = await fixture()
    const role = rootRole(frozen.manifest, 'lane-a-method')
    const binding = await bindingFor(frozen, role)
    const later = await laterMethodArtifacts({ frozen, role, binding })
    const changed = structuredClone(later.packet.packet)
    changed.capability_scope.tools = [...changed.capability_scope.tools, 'invented-tool']
    const changedText = canonicalJson(changed)
    await writeFile(later.packetPath, changedText, 'utf8')

    await expect(restoreCurrentRoleArtifacts({
      frozen,
      role,
      sessionId: binding.receipt.sessionId,
      binding,
      runtimeRevision: binding.receipt.runtimeRevision + 3,
      packetRef: { path: later.packetPath, hash: sha256(changedText) },
    })).rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT' })
  })

  it('fails closed when the canonical Assignment source bytes drift', async () => {
    const { frozen } = await fixture()
    const role = rootRole(frozen.manifest, 'lane-a-method')
    const binding = await bindingFor(frozen, role)
    const later = await laterMethodArtifacts({ frozen, role, binding })
    await writeFile(later.assignmentPath, canonicalJson({
      version: 1,
      assignment_id: later.assignmentId,
      role_id: role.role_id,
      role_kind: role.role_kind,
      objective: 'Drifted objective.',
      output_contract: later.packet.packet.output_contract,
    }), 'utf8')

    await expect(restoreCurrentRoleArtifacts({
      frozen,
      role,
      sessionId: binding.receipt.sessionId,
      binding,
      runtimeRevision: binding.receipt.runtimeRevision + 3,
      packetRef: { path: later.packetPath, hash: later.packet.packetHash },
    })).rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT' })
  })

  it('fails closed instead of rebuilding bootstrap artifacts when the persisted Packet is missing', async () => {
    const { frozen } = await fixture()
    const role = rootRole(frozen.manifest, 'lane-a-method')
    const binding = await bindingFor(frozen, role)
    const missingPath = join(
      frozen.manifest.authority_paths.lab_dir,
      'packets',
      sha256('missing-assignment'),
      `${sha256(role.role_id)}.json`,
    )

    await expect(restoreCurrentRoleArtifacts({
      frozen,
      role,
      sessionId: binding.receipt.sessionId,
      binding,
      runtimeRevision: binding.receipt.runtimeRevision,
      packetRef: { path: missingPath, hash: 'f'.repeat(64) },
    })).rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT' })
    await expect(readFile(frozen.manifest.authority_paths.fact_set, 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(frozen.manifest.authority_paths.evidence_index, 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })
})
