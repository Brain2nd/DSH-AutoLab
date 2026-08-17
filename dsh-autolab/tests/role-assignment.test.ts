import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { freezeInitialRoleArtifacts } from '../src/activation-artifacts.js'
import { ArtifactStore, sha256, type FrozenRevision } from '../src/artifacts.js'
import { freezeRoleBinding, type StoredRoleBinding } from '../src/binding.js'
import { EMPTY_FACT_SET } from '../src/fact-registry.js'
import { canonicalJson, type ResolvedManifest } from '../src/manifest.js'
import { compileRolePacket, parseRolePacket, type CompiledRolePacket } from '../src/packet.js'
import {
  assertMethodAssignmentReplay,
  assertRoleAssignmentMayDispatch,
  assertRoleAssignmentReplay,
  freezeMethodAssignment,
  freezeRoleAssignment,
  freezeRoleAssignmentReceipt,
  METHOD_SOURCE_PREFLIGHT_VERDICT_ARTIFACT_ID,
  RoleAssignmentError,
} from '../src/role-assignment.js'
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
  readonly frozen: FrozenRevision
  readonly role: RootRoleBinding
  readonly binding: StoredRoleBinding
  readonly current: {
    readonly packetPath: string
    readonly packet: CompiledRolePacket
  }
}

async function fixture(
  roleId: 'lane-a-method' | 'ops' | 'coordinator' = 'ops',
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-autolab-role-assignment-'))
  roots.push(root)
  const source = join(root, 'source')
  const spec = '# Exact contract\n\nKeep original constraints and facts.\n'
  const config = 'schema_version: 1\nfixture: role-assignment\n'
  await mkdir(source, { recursive: true })
  await Promise.all([
    writeFile(join(source, 'LAB_SPEC.md'), spec, 'utf8'),
    writeFile(join(source, 'lab.yaml'), config, 'utf8'),
  ])

  const store = new ArtifactStore(join(root, 'autolab'))
  await store.initialize()
  const manifest = structuredClone(validManifest())
  if (roleId === 'coordinator') addCoordinator(manifest)
  await store.createLab({
    labId: manifest.lab_id,
    controllerSessionId: 'session-controller',
    sourceDirectory: source,
    now: 1,
  })
  bindManifest(manifest, store, root, spec, config)
  const frozen = await store.freezeDraftRevision({
    labId: manifest.lab_id,
    revision: 1,
    manifest,
    dialogueHeadHash: DIALOGUE_HEAD_HASH,
  })
  const role = rootRole(frozen.manifest, roleId)
  const binding = await bindingFor(frozen, role)
  const current = await currentPacket(frozen, role, binding)
  return { root, frozen, role, binding, current }
}

function addCoordinator(manifest: ResolvedManifest): void {
  const ops = manifest.roles.find(role => role.role_kind === 'ops')!
  const coordinator = {
    role_id: 'coordinator',
    role_kind: 'coordinator' as const,
    max_goal_rounds: 32,
    model_route: structuredClone(ops.model_route),
    fallback_routes: structuredClone(ops.fallback_routes),
    dsh_preset: ops.dsh_preset,
    reasoning: structuredClone(ops.reasoning),
    allowed_tools: [...ops.allowed_tools],
    prompt_sha256: rolePromptFor('coordinator').sha256,
  }
  manifest.search.coordinator_enabled = true
  manifest.communication.coordinator_visibility = 'runtime_only'
  manifest.roles.push(coordinator)
  manifest.communication.role_permissions.push({
    role_id: coordinator.role_id,
    send: true,
    receive: true,
  })
}

function bindManifest(
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
  if (role === undefined || role.role_kind === 'controller') throw new Error('invalid role fixture')
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

async function currentPacket(
  frozen: FrozenRevision,
  role: RootRoleBinding,
  binding: StoredRoleBinding,
): Promise<{ packetPath: string; packet: CompiledRolePacket }> {
  const initial = await freezeInitialRoleArtifacts({
    frozen,
    role,
    sessionId: binding.receipt.sessionId,
    binding,
    runtimeRevision: 7,
    issuedAt: binding.receipt.issuedAt,
  })
  const assignmentId = `${role.role_id}:current`
  const assignmentPath = join(
    frozen.manifest.authority_paths.assignment_root,
    `${sha256(assignmentId)}.json`,
  )
  const outputContract = {
    schema: { type: 'object', additionalProperties: true },
    receipt_path: join(
      frozen.manifest.authority_paths.assignment_root,
      'outputs',
      `${sha256(assignmentId)}.json`,
    ),
    expected_hash_binding: assignmentId,
  }
  const assignmentText = canonicalJson({
    version: 1,
    assignment_id: assignmentId,
    role_id: role.role_id,
    role_kind: role.role_kind,
    objective: 'Current assignment before Controller dispatch.',
    output_contract: outputContract,
  })
  const stageText = 'Preserve this exact stage-specific original text.\n'
  const stagePath = join(frozen.manifest.authority_paths.lab_dir, 'artifacts', 'stage.txt')
  await Promise.all([
    mkdir(dirname(assignmentPath), { recursive: true }),
    mkdir(dirname(stagePath), { recursive: true }),
  ])
  await Promise.all([
    writeFile(assignmentPath, assignmentText, 'utf8'),
    writeFile(stagePath, stageText, 'utf8'),
  ])
  const packet = compileRolePacket({
    manifest: frozen.manifest,
    role_id: role.role_id,
    session_id: binding.receipt.sessionId,
    assignment_id: assignmentId,
    issued_at: binding.receipt.issuedAt + 1,
    role_binding_receipt_sha256: binding.hash,
    runtime_revision: 8,
    fact_set_sha256: '1'.repeat(64),
    evidence_index_sha256: '2'.repeat(64),
    assignment_contract_sha256: sha256(assignmentText),
    reveal_state: 'sealed',
    verbatim_blocks: {
      ...initial.packet.packet.verbatim_blocks,
      stage: [{
        block_id: 'current-stage-original',
        source_path: stagePath,
        exact_text: stageText,
        text_sha256: sha256(stageText),
      }],
      assignment: [{
        block_id: 'current-assignment',
        source_path: assignmentPath,
        exact_text: assignmentText,
        text_sha256: sha256(assignmentText),
      }],
    },
    incumbent: { ref: 'candidate-current', sha256: '3'.repeat(64) },
    relevant_fact_refs: [{ id: 'fact-current', sha256: '4'.repeat(64) }],
    evidence_refs: [{ id: 'evidence-current', sha256: '5'.repeat(64) }],
    open_obligation_refs: ['obligation-current'],
    input_artifact_refs: [{
      artifact_id: 'old-input',
      path: join(frozen.manifest.evidence.artifact_root, 'old-input.bin'),
      sha256: '6'.repeat(64),
    }],
    output_contract: outputContract,
  })
  const packetPath = join(
    frozen.manifest.authority_paths.lab_dir,
    'packets',
    sha256(assignmentId),
    `${sha256(role.role_id)}.json`,
  )
  await mkdir(dirname(packetPath), { recursive: true })
  await writeFile(packetPath, packet.canonicalJson, 'utf8')
  return { packetPath, packet }
}

describe('Controller-selected Method Assignment', () => {
  it('automatically binds a revision to the exact frozen verdict without reading it', async () => {
    const value = await fixture('lane-a-method')
    if (value.role.role_kind !== 'method') throw new Error('invalid Method fixture')
    const verdict = {
      path: join(value.root, 'intentionally-not-read', 'preflight-verdict.json'),
      sha256: '9'.repeat(64),
    }
    const ordinaryInput = {
      artifact_id: 'method-context',
      path: join(value.root, 'intentionally-not-read', 'method-context.json'),
      sha256: '8'.repeat(64),
    }
    const request = {
      frozen: value.frozen,
      role: value.role,
      sessionId: value.binding.receipt.sessionId,
      binding: value.binding,
      currentPacket: { path: value.current.packetPath, hash: value.current.packet.packetHash },
      assignmentId: 'lane-a-method:revision:2',
      objective: 'Revise the Method Design Ticket from the selected original verdict.',
      content: { method_owned_revision_request: ['opaque', 2] },
      inputArtifactRefs: [ordinaryInput],
      sourceReviewId: 'preflight:lane-a-method:1',
      sourceReviewVerdict: verdict,
      runtimeRevision: 9,
      issuedAt: 1_786_742_400_100,
    }

    const assigned = await freezeMethodAssignment(request)
    const requiredVerdictRef = {
      artifact_id: METHOD_SOURCE_PREFLIGHT_VERDICT_ARTIFACT_ID,
      ...verdict,
    }

    expect(JSON.parse(assigned.assignmentText)).toMatchObject({
      assignment_type: 'controller_method_assignment',
      assignment_id: request.assignmentId,
      source_review_id: request.sourceReviewId,
      objective: request.objective,
      content: request.content,
      input_artifact_refs: [ordinaryInput, requiredVerdictRef],
      output_contract: { expected_hash_binding: 'role_packet_sha256' },
    })
    expect(assigned.packet.packet.runtime_snapshot.input_artifact_refs)
      .toEqual([ordinaryInput, requiredVerdictRef])
    expect(() => assertMethodAssignmentReplay(assigned.packet.packet, request)).not.toThrow()

    for (const changed of [
      { ...request, sourceReviewId: 'preflight:lane-a-method:different' },
      { ...request, sourceReviewVerdict: { ...verdict, sha256: 'a'.repeat(64) } },
      { ...request, content: { method_owned_revision_request: ['different'] } },
      { ...request, inputArtifactRefs: [] },
    ]) {
      expect(() => assertMethodAssignmentReplay(assigned.packet.packet, changed))
        .toThrowError(expect.objectContaining<Partial<RoleAssignmentError>>({
          code: 'ARTIFACT_CONFLICT',
        }))
    }
  })

  it('deduplicates an exact caller verdict ref and rejects a conflicting one', async () => {
    const value = await fixture('lane-a-method')
    if (value.role.role_kind !== 'method') throw new Error('invalid Method fixture')
    const verdict = {
      path: join(value.root, 'not-opened', 'preflight-verdict.json'),
      sha256: 'a'.repeat(64),
    }
    const mandatory = {
      artifact_id: METHOD_SOURCE_PREFLIGHT_VERDICT_ARTIFACT_ID,
      ...verdict,
    }
    const request = {
      frozen: value.frozen,
      role: value.role,
      sessionId: value.binding.receipt.sessionId,
      binding: value.binding,
      currentPacket: { path: value.current.packetPath, hash: value.current.packet.packetHash },
      assignmentId: 'lane-a-method:revision:deduplicated',
      objective: 'Revise from the exact selected verdict.',
      content: null,
      inputArtifactRefs: [mandatory, mandatory],
      sourceReviewId: 'preflight:lane-a-method:deduplicated',
      sourceReviewVerdict: verdict,
      runtimeRevision: 9,
      issuedAt: 1_786_742_400_100,
    }

    const assigned = await freezeMethodAssignment(request)
    expect(assigned.packet.packet.runtime_snapshot.input_artifact_refs).toEqual([mandatory])
    expect(() => assertMethodAssignmentReplay(assigned.packet.packet, {
      ...request,
      inputArtifactRefs: [],
    })).not.toThrow()

    await expect(freezeMethodAssignment({
      ...request,
      assignmentId: 'lane-a-method:revision:conflict',
      inputArtifactRefs: [{ ...mandatory, sha256: 'b'.repeat(64) }],
    })).rejects.toEqual(expect.objectContaining<Partial<RoleAssignmentError>>({
      code: 'ARTIFACT_CONFLICT',
    }))
  })

  it('requires the durable verdict identity whenever a source review is selected', async () => {
    const value = await fixture('lane-a-method')
    if (value.role.role_kind !== 'method') throw new Error('invalid Method fixture')
    await expect(freezeMethodAssignment({
      frozen: value.frozen,
      role: value.role,
      sessionId: value.binding.receipt.sessionId,
      binding: value.binding,
      currentPacket: { path: value.current.packetPath, hash: value.current.packet.packetHash },
      assignmentId: 'lane-a-method:revision:missing-verdict',
      objective: 'This request is missing its selected verdict identity.',
      content: null,
      inputArtifactRefs: [],
      sourceReviewId: 'preflight:lane-a-method:missing-verdict',
      runtimeRevision: 9,
      issuedAt: 1_786_742_400_100,
    })).rejects.toEqual(expect.objectContaining<Partial<RoleAssignmentError>>({
      code: 'INVALID_INPUT',
    }))
  })
})

describe('Controller-selected generic Role Assignment', () => {
  it.each(['ops', 'coordinator'] as const)(
    'freezes opaque content for %s while preserving current original anchors and refs',
    async roleId => {
      const value = await fixture(roleId)
      const inputArtifactRefs = [{
        artifact_id: 'controller-selected-input',
        path: join(value.root, 'intentionally-not-read', 'checkpoint-or-anything.bin'),
        sha256: '7'.repeat(64),
      }]
      const input = {
        frozen: value.frozen,
        role: value.role,
        sessionId: value.binding.receipt.sessionId,
        binding: value.binding,
        currentPacket: {
          path: value.current.packetPath,
          hash: value.current.packet.packetHash,
        },
        currentRevealState: 'revealed' as const,
        assignmentId: `${roleId}:controller:iteration-2`,
        objective: 'Perform exactly the Controller-selected work and write the declared receipt.',
        content: {
          lab_defined: ['opaque', { arbitrary_number: 17 }],
          no_runtime_interpretation: true,
        },
        outputSchema: {
          type: 'object',
          domain_owned_shape: { any_future_field: true },
        },
        inputArtifactRefs,
        runtimeRevision: 9,
        issuedAt: 1_786_742_400_100,
      }

      const first = await freezeRoleAssignment(input)
      const second = await freezeRoleAssignment(input)

      expect(second).toEqual(first)
      expect(await readFile(first.assignmentPath, 'utf8')).toBe(first.assignmentText)
      expect(await readFile(first.packetPath, 'utf8')).toBe(first.packet.canonicalJson)
      expect(JSON.parse(first.assignmentText)).toMatchObject({
        assignment_id: input.assignmentId,
        role_id: roleId,
        objective: input.objective,
        content: input.content,
        output_contract: { schema: input.outputSchema, receipt_path: first.receiptPath },
      })
      const current = value.current.packet.packet
      const packet = first.packet.packet
      expect(packet.verbatim_blocks.universal).toEqual(current.verbatim_blocks.universal)
      expect(packet.verbatim_blocks.role).toEqual(current.verbatim_blocks.role)
      expect(packet.verbatim_blocks.lane).toEqual(current.verbatim_blocks.lane)
      expect(packet.verbatim_blocks.stage).toEqual(current.verbatim_blocks.stage)
      expect(packet.runtime_snapshot).toMatchObject({
        reveal_state: 'revealed',
        incumbent: current.runtime_snapshot.incumbent,
        relevant_fact_refs: current.runtime_snapshot.relevant_fact_refs,
        evidence_refs: current.runtime_snapshot.evidence_refs,
        open_obligation_refs: current.runtime_snapshot.open_obligation_refs,
        input_artifact_refs: inputArtifactRefs,
      })
      expect(packet.anchors).toMatchObject({
        fact_set_sha256: sha256(EMPTY_FACT_SET),
        evidence_index_sha256: current.anchors.evidence_index_sha256,
        assignment_contract_sha256: first.assignmentHash,
        runtime_revision: 9,
      })
    },
  )

  it('binds every idempotent replay to the complete opaque Controller request', async () => {
    const value = await fixture('ops')
    const request = {
      frozen: value.frozen,
      role: value.role,
      sessionId: value.binding.receipt.sessionId,
      binding: value.binding,
      currentPacket: { path: value.current.packetPath, hash: value.current.packet.packetHash },
      assignmentId: 'ops:controller:replay-exact',
      objective: 'Repair the assigned incident and report the original facts.',
      content: { incident: { kind: 'opaque', attempt: 3 } },
      outputSchema: { lab_owned: ['anything'] },
      inputArtifactRefs: [{
        artifact_id: 'incident',
        path: join(value.root, 'not-opened', 'incident.json'),
        sha256: '8'.repeat(64),
      }],
      runtimeRevision: 9,
      issuedAt: 1_786_742_400_100,
    }
    const assigned = await freezeRoleAssignment(request)

    expect(() => assertRoleAssignmentReplay(assigned.packet.packet, request)).not.toThrow()
    for (const changed of [
      { ...request, objective: `${request.objective} changed` },
      { ...request, content: { incident: { kind: 'different' } } },
      { ...request, outputSchema: { lab_owned: ['different'] } },
      { ...request, inputArtifactRefs: [] },
    ]) {
      expect(() => assertRoleAssignmentReplay(assigned.packet.packet, changed))
        .toThrowError(expect.objectContaining<Partial<RoleAssignmentError>>({
          code: 'ARTIFACT_CONFLICT',
        }))
    }
  })

  it('does not let another Assignment erase an activating Goal intent', () => {
    expect(() => assertRoleAssignmentMayDispatch({
      assignmentId: 'ops:activating',
      status: 'activating',
    }, 'ops:new')).toThrowError(expect.objectContaining<Partial<RoleAssignmentError>>({
      code: 'ARTIFACT_CONFLICT',
    }))
    expect(() => assertRoleAssignmentMayDispatch({
      assignmentId: 'ops:activating',
      status: 'activating',
    }, 'ops:activating')).not.toThrow()
    expect(() => assertRoleAssignmentMayDispatch({
      assignmentId: 'ops:old',
      status: 'applied',
    }, 'ops:new')).not.toThrow()
  })

  it('freezes arbitrary raw receipt bytes without parsing or applying the declared schema', async () => {
    const value = await fixture()
    const assigned = await freezeRoleAssignment({
      frozen: value.frozen,
      role: value.role,
      sessionId: value.binding.receipt.sessionId,
      binding: value.binding,
      currentPacket: { path: value.current.packetPath, hash: value.current.packet.packetHash },
      assignmentId: 'lane-a-method:controller:raw-receipt',
      objective: 'Write the domain-owned receipt.',
      content: { domain: 'opaque' },
      outputSchema: { const: { deliberately: 'different from raw bytes' } },
      inputArtifactRefs: [],
      runtimeRevision: 9,
      issuedAt: 1_786_742_400_100,
    })
    const raw = Buffer.alloc(1024 * 1024 + 3, 0xff)
    raw.set(Buffer.from([0x00, 0x01, 0x02]), raw.length - 3)
    await mkdir(dirname(assigned.receiptPath), { recursive: true })
    await writeFile(assigned.receiptPath, raw)
    const artifactPath = join(value.frozen.manifest.evidence.artifact_root, 'role-results', 'raw.bin')

    const first = await freezeRoleAssignmentReceipt({
      rolePacketPath: assigned.packetPath,
      rolePacketHash: assigned.packet.packetHash,
      artifactPath,
    })
    const second = await freezeRoleAssignmentReceipt({
      rolePacketPath: assigned.packetPath,
      rolePacketHash: assigned.packet.packetHash,
      artifactPath,
    })

    expect(second).toEqual(first)
    expect(first).toMatchObject({
      assignmentId: assigned.assignmentId,
      roleId: value.role.role_id,
      receiptPath: assigned.receiptPath,
      artifactPath,
      receiptHash: sha256(raw),
      expectedHashBinding: assigned.assignmentId,
    })
    expect(await readFile(artifactPath)).toEqual(raw)
  })

  it('keeps Method, Coder, and Judge dispatch on their dedicated protocols', async () => {
    const value = await fixture()
    for (const roleId of ['lane-a-method', 'lane-a-coder', 'lane-a-preflight'] as const) {
      const role = rootRole(value.frozen.manifest, roleId)
      await expect(freezeRoleAssignment({
        frozen: value.frozen,
        role,
        sessionId: `session-${roleId}`,
        binding: value.binding,
        currentPacket: { path: value.current.packetPath, hash: value.current.packet.packetHash },
        assignmentId: 'not-allowed-through-generic-path',
        objective: 'Would bypass the dedicated protocol.',
        content: null,
        outputSchema: null,
        inputArtifactRefs: [],
        runtimeRevision: 9,
        issuedAt: 1,
      })).rejects.toEqual(expect.objectContaining<Partial<RoleAssignmentError>>({
        code: 'UNSUPPORTED_ROLE',
      }))
    }
  })

  it('supersedes an incumbent Packet corrupted by a stale LAB_SPEC block, and still fails loud for other corruption', async () => {
    const value = await fixture('ops')
    const originalBytes = await readFile(value.current.packetPath, 'utf8')
    const original = parseRolePacket(JSON.parse(originalBytes))

    // Known plugin-bug corruption: the universal block carries an internally
    // consistent but STALE spec (older revision text + its own hash).
    const staleText = '# Stale older-revision contract\n'
    const corrupted = structuredClone(original)
    corrupted.verbatim_blocks.universal[0] = {
      ...corrupted.verbatim_blocks.universal[0]!,
      source_path: join(value.root, 'revisions', '000000', 'LAB_SPEC.md'),
      exact_text: staleText,
      text_sha256: sha256(staleText),
    }
    const corruptedText = canonicalJson(corrupted)
    await writeFile(value.current.packetPath, corruptedText, 'utf8')

    const request = {
      frozen: value.frozen,
      role: value.role,
      sessionId: value.binding.receipt.sessionId,
      binding: value.binding,
      currentPacket: { path: value.current.packetPath, hash: sha256(corruptedText) },
      assignmentId: 'ops:supersede-corrupt-packet',
      objective: 'Supersede the corrupt incumbent Packet.',
      content: null,
      outputSchema: null,
      inputArtifactRefs: [],
      runtimeRevision: 9,
      issuedAt: 1_786_742_400_200,
    }
    const assigned = await freezeRoleAssignment(request)
    expect(assigned.packet.packet.verbatim_blocks.universal[0]!.text_sha256)
      .toBe(value.frozen.ref.specHash)
    expect(assigned.packet.packet.verbatim_blocks.universal[0]!.source_path)
      .toBe(value.frozen.manifest.authority_paths.lab_spec)
    expect(assigned.packet.packet.runtime_snapshot.incumbent).toBeUndefined()
    expect(assigned.packet.packet.runtime_snapshot.evidence_refs).toEqual([])

    // A different corruption (tampered Assignment block) must still fail.
    const tampered = parseRolePacket(JSON.parse(originalBytes))
    tampered.verbatim_blocks.assignment[0] = {
      ...tampered.verbatim_blocks.assignment[0]!,
      text_sha256: 'b'.repeat(64),
    }
    const tamperedText = canonicalJson(tampered)
    await writeFile(value.current.packetPath, tamperedText, 'utf8')
    await expect(freezeRoleAssignment({
      ...request,
      assignmentId: 'ops:supersede-corrupt-packet-reject',
      currentPacket: { path: value.current.packetPath, hash: sha256(tamperedText) },
    })).rejects.toThrowError(expect.objectContaining<Partial<RoleAssignmentError>>({
      code: 'ARTIFACT_CONFLICT',
    }))
  })
})
