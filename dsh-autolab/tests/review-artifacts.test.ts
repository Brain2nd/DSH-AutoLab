import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { freezeInitialRoleArtifacts, type InitialRoleArtifacts } from '../src/activation-artifacts.js'
import { ArtifactStore, sha256, type FrozenRevision } from '../src/artifacts.js'
import { freezeRoleBinding, type StoredRoleBinding } from '../src/binding.js'
import { canonicalJson, type ResolvedManifest } from '../src/manifest.js'
import {
  freezePreflightReviewArtifacts,
  type FreezePreflightReviewArtifactsInput,
} from '../src/review-artifacts.js'
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

interface ReviewFixture {
  readonly input: FreezePreflightReviewArtifactsInput
  readonly methodArtifacts: InitialRoleArtifacts
  readonly ticketText: string
}

async function fixture(): Promise<ReviewFixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-autolab-review-artifacts-'))
  roots.push(root)
  const source = join(root, 'source')
  const spec = '# Exact research contract\n\n约束：完整保留，不做摘要。  \n'
  const config = 'schema_version: 1\nfixture: review-artifacts\n'
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

  const methodRole = rootRole(frozen.manifest, 'lane-a-method')
  const methodBinding = await bindingFor(frozen, methodRole)
  const methodArtifacts = await freezeInitialRoleArtifacts({
    frozen,
    role: methodRole,
    sessionId: methodBinding.receipt.sessionId,
    binding: methodBinding,
    runtimeRevision: methodBinding.receipt.runtimeRevision,
    issuedAt: methodBinding.receipt.issuedAt,
  })

  const judgeRole = rootRole(frozen.manifest, 'lane-a-preflight')
  const judgeBinding = await bindingFor(frozen, judgeRole)
  const ticketText = canonicalJson({
    version: 1,
    assignment_id: methodArtifacts.assignmentId,
    assignment_contract_sha256: methodArtifacts.assignmentHash,
    role_packet_sha256: methodArtifacts.packet.packetHash,
    candidate_id: 'candidate-a-1',
    content: {
      proposed_method: 'exact method',
      domain_payload: {
        feature_choice: 'exact feature',
        implementation_note: 'exact implementation constraint',
        requested_observation: 'exact measurement',
      },
      preserved_notes: ['invariant-a', 'contrast-a'],
    },
  })
  const ticketPath = join(
    frozen.manifest.evidence.artifact_root,
    'design-tickets',
    `${sha256(ticketText)}.json`,
  )
  await mkdir(join(frozen.manifest.evidence.artifact_root, 'design-tickets'), { recursive: true })
  await writeFile(ticketPath, ticketText, { encoding: 'utf8', flag: 'wx' })

  return {
    methodArtifacts,
    ticketText,
    input: {
      frozen,
      judgeSessionId: judgeBinding.receipt.sessionId,
      judgeBinding,
      sourceMethodAssignment: {
        path: methodArtifacts.assignmentPath,
        sha256: methodArtifacts.assignmentHash,
      },
      sourceMethodPacket: {
        path: methodArtifacts.packetPath,
        sha256: methodArtifacts.packet.packetHash,
      },
      designTicket: { path: ticketPath, sha256: sha256(ticketText) },
      reviewId: 'review-lane-a-0001',
      runtimeRevision: 8,
      issuedAt: 1_786_742_400_100,
    },
  }
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
  if (role === undefined || role.role_kind === 'controller') throw new Error(`invalid root role ${roleId}`)
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

describe('immutable Preflight review artifacts', () => {
  it('compiles the exact Judge Packet from CURRENT and frozen Method inputs', async () => {
    const { input, methodArtifacts, ticketText } = await fixture()
    const first = await freezePreflightReviewArtifacts(input)
    const second = await freezePreflightReviewArtifacts(input)

    expect(second).toEqual(first)
    expect(first.assignmentId).toBe(`preflight:${input.reviewId}`)
    expect(first.packet.packetHash).toBe(sha256(first.packet.canonicalJson))
    expect(await readFile(first.assignmentPath, 'utf8')).toBe(first.assignmentText)
    expect(await readFile(first.packetPath, 'utf8')).toBe(first.packet.canonicalJson)
    expect(sha256(first.assignmentText)).toBe(first.assignmentHash)
    expect(isAbsolute(first.assignmentPath)).toBe(true)
    expect(isAbsolute(first.packetPath)).toBe(true)
    expect(isAbsolute(first.verdictPath)).toBe(true)

    const packet = first.packet.packet
    expect(packet.header).toMatchObject({
      role_id: input.judgeBinding.receipt.roleId,
      role_kind: 'preflight_judge',
      session_id: input.judgeSessionId,
      assignment_id: first.assignmentId,
      issued_at: input.issuedAt,
    })
    expect(packet.anchors).toMatchObject({
      source_revision: input.frozen.ref.revision,
      resolved_manifest_sha256: input.frozen.ref.manifestHash,
      role_binding_receipt_sha256: input.judgeBinding.hash,
      runtime_revision: input.runtimeRevision,
      assignment_contract_sha256: first.assignmentHash,
      fact_set_sha256: methodArtifacts.packet.packet.anchors.fact_set_sha256,
      evidence_index_sha256: methodArtifacts.packet.packet.anchors.evidence_index_sha256,
    })

    const blocks = packet.verbatim_blocks
    expect(blocks.universal).toEqual([expect.objectContaining({
      block_id: 'lab-spec',
      exact_text: input.frozen.spec,
      text_sha256: input.frozen.ref.specHash,
    })])
    expect(blocks.role).toEqual([expect.objectContaining({
      block_id: 'role-prompt',
      exact_text: rolePromptFor('preflight_judge').text,
    })])
    const laneCharter = input.frozen.manifest.search.lane_charters.find(
      charter => charter.lane_id === packet.header.lane_id,
    )!
    expect(blocks.lane).toEqual([expect.objectContaining({
      block_id: 'lane-charter',
      exact_text: canonicalJson(laneCharter.content),
      text_sha256: laneCharter.charter_sha256,
    })])
    expect(blocks.stage).toEqual([])
    expect(blocks.assignment).toEqual([expect.objectContaining({
      block_id: 'preflight-review-assignment',
      exact_text: first.assignmentText,
      text_sha256: first.assignmentHash,
    })])
    for (const group of Object.values(blocks)) {
      for (const block of group) {
        expect(block.text_sha256).toBe(sha256(block.exact_text))
        expect(await readFile(block.source_path, 'utf8')).toBe(block.exact_text)
      }
    }

    expect(packet.runtime_snapshot.input_artifact_refs).toEqual([
      { artifact_id: 'design-ticket', path: input.designTicket.path, sha256: sha256(ticketText) },
      {
        artifact_id: 'source-method-assignment',
        path: input.sourceMethodAssignment.path,
        sha256: input.sourceMethodAssignment.sha256,
      },
      {
        artifact_id: 'source-method-packet',
        path: input.sourceMethodPacket.path,
        sha256: input.sourceMethodPacket.sha256,
      },
    ])
    expect(packet.output_contract).toMatchObject({
      receipt_path: first.verdictPath,
      expected_hash_binding: first.reviewInputHash,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: expect.arrayContaining([
          'review_input_sha256',
          'top_level_verdict',
          'blocking_findings',
          'reasons',
          'warnings',
        ]),
        properties: {
          review_id: { const: input.reviewId },
          assignment_id: { const: first.assignmentId },
          review_input_sha256: { const: first.reviewInputHash },
          top_level_verdict: {
            enum: ['APPROVED', 'REVISION_REQUIRED', 'REJECTED', 'REVIEW_ERROR'],
          },
        },
      },
    })

    const assignment = JSON.parse(first.assignmentText)
    expect(assignment).toMatchObject({
      assignment_type: 'preflight_review',
      review_id: input.reviewId,
      review_input_sha256: first.reviewInputHash,
      design_ticket: {
        artifact_id: 'design-ticket',
        path: input.designTicket.path,
        sha256: input.designTicket.sha256,
      },
    })
  })

  it('fails closed instead of replacing an existing review identity', async () => {
    const { input } = await fixture()
    const committed = await freezePreflightReviewArtifacts(input)
    const assignmentBytes = await readFile(committed.assignmentPath, 'utf8')
    const packetBytes = await readFile(committed.packetPath, 'utf8')

    await expect(freezePreflightReviewArtifacts({
      ...input,
      issuedAt: input.issuedAt + 1,
    })).rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT' })
    expect(await readFile(committed.assignmentPath, 'utf8')).toBe(assignmentBytes)
    expect(await readFile(committed.packetPath, 'utf8')).toBe(packetBytes)
  })

  it('rejects a changed Design Ticket and a mismatched Judge Session mechanically', async () => {
    const { input } = await fixture()
    await writeFile(input.designTicket.path, 'changed ticket bytes', 'utf8')
    await expect(freezePreflightReviewArtifacts(input)).rejects.toMatchObject({
      code: 'INPUT_HASH_MISMATCH',
    })

    const fresh = await fixture()
    await expect(freezePreflightReviewArtifacts({
      ...fresh.input,
      judgeSessionId: 'another-session',
    })).rejects.toMatchObject({ code: 'JUDGE_BINDING_MISMATCH' })
  })
})
