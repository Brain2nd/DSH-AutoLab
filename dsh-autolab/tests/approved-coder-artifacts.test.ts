import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  freezeApprovedCoderArtifacts,
  type FreezeApprovedCoderArtifactsInput,
} from '../src/approved-coder-artifacts.js'
import { coderImplementationReportOutputSchema } from '../src/coder-receipt.js'
import { freezeInitialRoleArtifacts } from '../src/activation-artifacts.js'
import { ArtifactStore, sha256, type FrozenRevision } from '../src/artifacts.js'
import { freezeRoleBinding, type StoredRoleBinding } from '../src/binding.js'
import { EMPTY_FACT_SET } from '../src/fact-registry.js'
import { canonicalJson, type ResolvedManifest } from '../src/manifest.js'
import {
  METHOD_TICKET_HASH_BINDING,
  methodDesignTicketOutputSchema,
  parseMethodDesignTicket,
} from '../src/method-ticket.js'
import { compileRolePacket } from '../src/packet.js'
import { freezePreflightReviewArtifacts } from '../src/review-artifacts.js'
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

interface CoderFixture {
  readonly input: FreezeApprovedCoderArtifactsInput
  readonly sourcePacket: ReturnType<typeof compileRolePacket>
  readonly ticketBytes: string
  readonly verdictBytes: string
}

async function fixture(): Promise<CoderFixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-autolab-approved-coder-'))
  roots.push(root)
  const source = join(root, 'source')
  const spec = '# Exact research contract\n\n约束：只实现批准的方法，不做摘要。  \n'
  const config = 'schema_version: 1\nfixture: approved-coder-artifacts\n'
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
  if (methodRole.role_kind !== 'method') throw new Error('invalid Method fixture role')
  const methodBinding = await bindingFor(frozen, methodRole)
  const initial = await freezeInitialRoleArtifacts({
    frozen,
    role: methodRole,
    sessionId: methodBinding.receipt.sessionId,
    binding: methodBinding,
    runtimeRevision: methodBinding.receipt.runtimeRevision,
    issuedAt: methodBinding.receipt.issuedAt,
  })

  const assignmentId = 'lane-a:method:approved-candidate-1'
  const assignmentPath = join(
    frozen.manifest.authority_paths.assignment_root,
    `${sha256(assignmentId)}.json`,
  )
  const receiptPath = join(
    frozen.manifest.authority_paths.assignment_root,
    'outputs',
    `${sha256(assignmentId)}.json`,
  )
  const outputContract = {
    schema: methodDesignTicketOutputSchema(),
    receipt_path: receiptPath,
    expected_hash_binding: METHOD_TICKET_HASH_BINDING,
  }
  const assignmentText = canonicalJson({
    version: 1,
    assignment_id: assignmentId,
    role_id: methodRole.role_id,
    role_kind: methodRole.role_kind,
    objective: 'Produce the exact candidate admitted by Preflight.',
    output_contract: outputContract,
  })
  await writeFile(assignmentPath, assignmentText, 'utf8')

  const factHash = sha256(canonicalJson({ version: 1, facts: ['fact-live'] }))
  const evidenceHash = sha256(canonicalJson({ version: 1, evidence: ['evidence-live'] }))
  const sourcePacket = compileRolePacket({
    manifest: frozen.manifest,
    role_id: methodRole.role_id,
    session_id: methodBinding.receipt.sessionId,
    assignment_id: assignmentId,
    issued_at: methodBinding.receipt.issuedAt + 10,
    role_binding_receipt_sha256: methodBinding.hash,
    runtime_revision: 8,
    fact_set_sha256: factHash,
    evidence_index_sha256: evidenceHash,
    assignment_contract_sha256: sha256(assignmentText),
    reveal_state: 'revealed',
    verbatim_blocks: {
      ...initial.packet.packet.verbatim_blocks,
      assignment: [{
        block_id: 'method-approved-assignment',
        source_path: assignmentPath,
        exact_text: assignmentText,
        text_sha256: sha256(assignmentText),
      }],
    },
    incumbent: { ref: 'incumbent-candidate', sha256: 'a'.repeat(64) },
    relevant_fact_refs: [{ id: 'fact-live', sha256: 'b'.repeat(64) }],
    evidence_refs: [{ id: 'evidence-live', sha256: 'c'.repeat(64) }],
    open_obligation_refs: ['obligation-live'],
    input_artifact_refs: [{
      artifact_id: 'prior-evidence',
      path: join(frozen.manifest.evidence.artifact_root, 'prior.json'),
      sha256: 'e'.repeat(64),
    }],
    output_contract: outputContract,
  })
  const sourcePacketPath = join(
    frozen.manifest.authority_paths.lab_dir,
    'packets',
    sha256(assignmentId),
    `${sha256(methodRole.role_id)}.json`,
  )
  await mkdir(join(frozen.manifest.authority_paths.lab_dir, 'packets', sha256(assignmentId)), {
    recursive: true,
  })
  await writeFile(sourcePacketPath, sourcePacket.canonicalJson, 'utf8')

  const charter = frozen.manifest.search.lane_charters.find(candidate => (
    candidate.lane_id === methodRole.lane_id
  ))!
  const ticket = parseMethodDesignTicket({
    assignment_id: assignmentId,
    assignment_contract_sha256: sha256(assignmentText),
    role_packet_sha256: sourcePacket.packetHash,
    candidate_id: 'candidate-a-approved-1',
    content: {
      method: 'Fuse the projection into one large GEMM.',
      feature: {
        ref: 'lens-throughput',
        selection: 'End-to-end throughput and exact evaluator output.',
        hypothesis: 'The fused projection removes small-GEMM overhead.',
      },
      implementation: 'One fused matmul preserves the numerical interface.',
      lab_constraints: frozen.manifest.contract,
      lane_charter: charter.content,
      experiment: {
        comparison: 'Fused and split implementations under one protocol.',
        prediction: 'Throughput improves and output remains equivalent.',
        falsifier: 'Matched fusion is not faster or changes evaluator output.',
      },
    },
  })

  const reviewId = 'review-lane-a-approved-0001'
  const reviewRoot = join(
    frozen.manifest.authority_paths.lab_dir,
    'artifacts',
    'reviews',
    reviewId,
  )
  await mkdir(reviewRoot, { recursive: true })
  const ticketPath = join(reviewRoot, 'method-ticket.json')
  const ticketBytes = `${JSON.stringify(ticket, null, 2)}\n`
  await writeFile(ticketPath, ticketBytes, 'utf8')

  const judgeRole = rootRole(frozen.manifest, 'lane-a-preflight')
  const judgeBinding = await bindingFor(frozen, judgeRole)
  const reviewArtifacts = await freezePreflightReviewArtifacts({
    frozen,
    judgeSessionId: judgeBinding.receipt.sessionId,
    judgeBinding,
    sourceMethodAssignment: {
      path: assignmentPath,
      sha256: sha256(assignmentText),
    },
    sourceMethodPacket: { path: sourcePacketPath, sha256: sourcePacket.packetHash },
    designTicket: { path: ticketPath, sha256: sha256(ticketBytes) },
    reviewId,
    runtimeRevision: 9,
    issuedAt: 1_786_742_400_090,
  })

  const verdict = {
    version: 1 as const,
    review_id: reviewId,
    assignment_id: reviewArtifacts.assignmentId,
    review_input_sha256: reviewArtifacts.reviewInputHash,
    top_level_verdict: 'APPROVED' as const,
    blocking_findings: [],
    reasons: ['The exact frozen Design Ticket satisfies the applicable rubric.'],
    warnings: [],
  }
  const verdictPath = join(reviewRoot, 'preflight-verdict.json')
  const verdictBytes = `${JSON.stringify(verdict, null, 2)}\n`
  await writeFile(verdictPath, verdictBytes, 'utf8')

  const coderRole = rootRole(frozen.manifest, 'lane-a-coder')
  const coderBinding = await bindingFor(frozen, coderRole)
  return {
    sourcePacket,
    ticketBytes,
    verdictBytes,
    input: {
      frozen,
      coderRole,
      coderSessionId: coderBinding.receipt.sessionId,
      coderBinding,
      sourceMethodPacket: { path: sourcePacketPath, sha256: sourcePacket.packetHash },
      designTicket: { path: ticketPath, sha256: sha256(ticketBytes) },
      preflightVerdict: { path: verdictPath, sha256: sha256(verdictBytes) },
      reviewId,
      runtimeRevision: 10,
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
  if (role === undefined || role.role_kind === 'controller') throw new Error(`invalid role ${roleId}`)
  return role
}

async function bindingFor(
  frozen: FrozenRevision,
  role: RootRoleBinding,
): Promise<StoredRoleBinding> {
  const session = resolveRootRoleSessionSpec(frozen.manifest, role.role_id)
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
    cwd: session.cwd,
    runtimeRevision: 7,
    issuedAt: 1_786_742_400_000,
  })
}

describe('APPROVED Preflight to Coder artifacts', () => {
  it('compiles one canonical Coder Assignment and Packet without summarizing the approved inputs', async () => {
    const value = await fixture()
    const first = await freezeApprovedCoderArtifacts(value.input)
    const second = await freezeApprovedCoderArtifacts(value.input)

    expect(second).toEqual(first)
    expect(first.assignmentId).toBe(`coder:${value.input.reviewId}`)
    expect(isAbsolute(first.assignmentPath)).toBe(true)
    expect(isAbsolute(first.packetPath)).toBe(true)
    expect(await readFile(first.assignmentPath, 'utf8')).toBe(canonicalJson(
      JSON.parse(await readFile(first.assignmentPath, 'utf8')),
    ))
    expect(await readFile(first.packetPath, 'utf8')).toBe(first.packet.canonicalJson)
    expect(first.packet.packetHash).toBe(sha256(first.packet.canonicalJson))

    const assignment = JSON.parse(await readFile(first.assignmentPath, 'utf8'))
    expect(assignment).toMatchObject({
      assignment_type: 'approved_coder_implementation',
      assignment_id: first.assignmentId,
      review_id: value.input.reviewId,
      design_ticket: {
        candidate_id: 'candidate-a-approved-1',
        path: value.input.designTicket.path,
        sha256: value.input.designTicket.sha256,
      },
      preflight_approval: {
        path: value.input.preflightVerdict.path,
        sha256: value.input.preflightVerdict.sha256,
        top_level_verdict: 'APPROVED',
      },
    })
    expect(assignment.objective).toContain('Implement only the exact APPROVED Design Ticket')
    expect(assignment.objective).toContain('Do not change, reinterpret, or replace the approved method')
    expect(assignment.objective).toContain('do not improvise')
    expect(assignment.objective).toContain('SubmitCoderImplementation')
    expect(assignment.output_contract.schema).toEqual(coderImplementationReportOutputSchema())
    expect(assignment.output_contract.schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
    })

    const packet = first.packet.packet
    expect(packet.header).toMatchObject({
      role_id: value.input.coderRole.role_id,
      role_kind: 'coder',
      session_id: value.input.coderSessionId,
      assignment_id: first.assignmentId,
    })
    expect(packet.anchors).toMatchObject({
      source_revision: value.input.frozen.ref.revision,
      resolved_manifest_sha256: value.input.frozen.ref.manifestHash,
      role_binding_receipt_sha256: value.input.coderBinding.hash,
      runtime_revision: value.input.runtimeRevision,
      fact_set_sha256: sha256(EMPTY_FACT_SET),
      evidence_index_sha256: value.sourcePacket.packet.anchors.evidence_index_sha256,
    })
    expect(packet.runtime_snapshot).toMatchObject({
      reveal_state: 'revealed',
      incumbent: value.sourcePacket.packet.runtime_snapshot.incumbent,
      relevant_fact_refs: value.sourcePacket.packet.runtime_snapshot.relevant_fact_refs,
      evidence_refs: value.sourcePacket.packet.runtime_snapshot.evidence_refs,
      open_obligation_refs: value.sourcePacket.packet.runtime_snapshot.open_obligation_refs,
    })
    expect(packet.runtime_snapshot.input_artifact_refs).toEqual([
      { artifact_id: 'source-method-packet', ...value.input.sourceMethodPacket },
      { artifact_id: 'design-ticket', ...value.input.designTicket },
      { artifact_id: 'preflight-verdict', ...value.input.preflightVerdict },
    ].map(({ sha256: hash, ...reference }) => ({ ...reference, sha256: hash })))

    expect(packet.verbatim_blocks.universal).toEqual([expect.objectContaining({
      source_path: value.input.frozen.manifest.authority_paths.lab_spec,
      exact_text: value.input.frozen.spec,
      text_sha256: value.input.frozen.ref.specHash,
    })])
    expect(packet.verbatim_blocks.role).toEqual([expect.objectContaining({
      exact_text: rolePromptFor('coder').text,
      text_sha256: rolePromptFor('coder').sha256,
    })])
    expect(packet.verbatim_blocks.lane).toEqual([expect.objectContaining({
      block_id: 'lane-charter',
    })])
    expect(packet.verbatim_blocks.stage).toEqual([
      expect.objectContaining({
        block_id: 'approved-method-design-ticket',
        source_path: value.input.designTicket.path,
        exact_text: value.ticketBytes,
        text_sha256: value.input.designTicket.sha256,
      }),
      expect.objectContaining({
        block_id: 'preflight-approved-verdict',
        source_path: value.input.preflightVerdict.path,
        exact_text: value.verdictBytes,
        text_sha256: value.input.preflightVerdict.sha256,
      }),
    ])
    expect(packet.verbatim_blocks.assignment).toEqual([expect.objectContaining({
      exact_text: await readFile(first.assignmentPath, 'utf8'),
      text_sha256: first.assignmentHash,
    })])

    // Frozen model receipts remain original bytes; this compiler does not
    // canonicalize or summarize either one on the transition path.
    expect(await readFile(value.input.designTicket.path, 'utf8')).toBe(value.ticketBytes)
    expect(await readFile(value.input.preflightVerdict.path, 'utf8')).toBe(value.verdictBytes)
  })

  it('requires the exact APPROVED verdict and exact Method/Ticket hash chain', async () => {
    const wrongVerdict = await fixture()
    const changedVerdict = {
      ...JSON.parse(wrongVerdict.verdictBytes),
      top_level_verdict: 'REVISION_REQUIRED',
    }
    const changedVerdictBytes = `${JSON.stringify(changedVerdict, null, 2)}\n`
    await writeFile(wrongVerdict.input.preflightVerdict.path, changedVerdictBytes, 'utf8')
    await expect(freezeApprovedCoderArtifacts({
      ...wrongVerdict.input,
      preflightVerdict: {
        path: wrongVerdict.input.preflightVerdict.path,
        sha256: sha256(changedVerdictBytes),
      },
    })).rejects.toMatchObject({ code: 'PREFLIGHT_VERDICT_MISMATCH' })

    const wrongTicket = await fixture()
    const changedTicket = {
      ...JSON.parse(wrongTicket.ticketBytes),
      role_packet_sha256: '0'.repeat(64),
    }
    const changedTicketBytes = `${JSON.stringify(changedTicket, null, 2)}\n`
    await writeFile(wrongTicket.input.designTicket.path, changedTicketBytes, 'utf8')
    await expect(freezeApprovedCoderArtifacts({
      ...wrongTicket.input,
      designTicket: {
        path: wrongTicket.input.designTicket.path,
        sha256: sha256(changedTicketBytes),
      },
    })).rejects.toMatchObject({ code: 'DESIGN_TICKET_MISMATCH' })
  })

  it('fails closed on path/binding drift and immutable output conflicts', async () => {
    const pathDrift = await fixture()
    await expect(freezeApprovedCoderArtifacts({
      ...pathDrift.input,
      designTicket: {
        ...pathDrift.input.designTicket,
        path: join(pathDrift.input.frozen.manifest.authority_paths.lab_dir, 'method-ticket.json'),
      },
    })).rejects.toMatchObject({ code: 'DESIGN_TICKET_MISMATCH' })

    const bindingDrift = await fixture()
    await expect(freezeApprovedCoderArtifacts({
      ...bindingDrift.input,
      coderSessionId: 'another-coder-session',
    })).rejects.toMatchObject({ code: 'CODER_BINDING_MISMATCH' })

    const conflict = await fixture()
    const committed = await freezeApprovedCoderArtifacts(conflict.input)
    const original = await readFile(committed.assignmentPath, 'utf8')
    await expect(freezeApprovedCoderArtifacts({
      ...conflict.input,
      issuedAt: conflict.input.issuedAt + 1,
    })).rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT' })
    expect(await readFile(committed.assignmentPath, 'utf8')).toBe(original)
  })
})
