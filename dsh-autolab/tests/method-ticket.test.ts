import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { canonicalJson, sha256 } from '../src/integrity.js'
import {
  METHOD_TICKET_HASH_BINDING,
  freezeMethodDesignTicket,
  methodDesignTicketOutputSchema,
  parseMethodDesignTicket,
  type MethodDesignTicket,
} from '../src/method-ticket.js'
import { parseResolvedManifest, type ResolvedManifest } from '../src/manifest.js'
import { compileRolePacket } from '../src/packet.js'

const roots: string[] = []
const hash = (digit: string): string => digit.repeat(64)
const gitSha = (digit: string): string => digit.repeat(40)

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

interface TicketFixture {
  readonly packetPath: string
  readonly packetHash: string
  readonly receiptPath: string
  readonly reviewPath: string
  readonly assignmentPath: string
  readonly ticket: MethodDesignTicket
}

function route(roleId: string) {
  return {
    route_id: `route-${roleId}`,
    provider: 'provider-a',
    model: 'model-a',
    config: {},
  }
}

function commonRole(roleId: string, promptHash: string) {
  return {
    role_id: roleId,
    model_route: route(roleId),
    fallback_routes: [],
    dsh_preset: 'workspace-write' as const,
    reasoning: { mode: 'high', config: {} },
    allowed_tools: [],
    prompt_sha256: promptHash,
  }
}

function manifestFixture(input: {
  root: string
  rolePromptHash: string
  laneCharterHash: string
  laneCharterContent: Record<string, unknown>
}): ResolvedManifest {
  const labDirectory = join(input.root, 'lab')
  const artifactRoot = join(labDirectory, 'artifacts')
  const revisionDirectory = join(labDirectory, 'revisions', '000001')
  const worktree = join(input.root, 'worktrees', 'lane-a')
  const roles = [
    {
      ...commonRole('controller', hash('a')),
      role_kind: 'controller' as const,
      max_goal_rounds: 64,
      prebound_session_id: 'session-controller',
    },
    {
      ...commonRole('ops', hash('b')),
      role_kind: 'ops' as const,
      max_goal_rounds: 8,
      resource_domain: 'local',
    },
    {
      ...commonRole('lane-a-method', input.rolePromptHash),
      role_kind: 'method' as const,
      max_goal_rounds: 16,
      lane_id: 'lane-a',
      worktree_path: worktree,
      allowed_tools: ['SubmitMethodForPreflightReview'],
    },
    {
      ...commonRole('lane-a-coder', hash('d')),
      role_kind: 'coder' as const,
      max_goal_rounds: 16,
      lane_id: 'lane-a',
      worktree_path: worktree,
    },
    {
      ...commonRole('lane-a-preflight', hash('e')),
      role_kind: 'preflight_judge' as const,
      lane_id: 'lane-a',
    },
    {
      ...commonRole('lane-a-postflight', hash('f')),
      role_kind: 'postflight_judge' as const,
      lane_id: 'lane-a',
    },
  ]

  return parseResolvedManifest({
    schema_version: 1,
    lab_id: 'lab-method-ticket',
    source_revision: 1,
    campaign_contract_sha256: hash('1'),
    anchors: {
      dialogue_head_sha256: hash('2'),
      lab_spec_sha256: hash('3'),
      lab_yaml_sha256: hash('4'),
    },
    authority_paths: {
      lab_dir: labDirectory,
      creation_log: join(labDirectory, 'dialogue', 'creation.jsonl'),
      lab_spec: join(revisionDirectory, 'LAB_SPEC.md'),
      lab_yaml: join(revisionDirectory, 'lab.yaml'),
      resolved_manifest: join(revisionDirectory, 'RESOLVED_MANIFEST.json'),
      fact_set: join(artifactRoot, 'facts.json'),
      evidence_index: join(artifactRoot, 'evidence.json'),
      assignment_root: join(labDirectory, 'assignments'),
      worktree_root: join(input.root, 'worktrees'),
    },
    versions: { autolab_plugin: '0.1.0', dsh: '0.1.0-rc.6' },
    repository: {
      path: join(input.root, 'repository'),
      base_ref: 'refs/heads/main',
      base_sha: gitSha('1'),
    },
    research: { objective: 'Use the current Lab contract.' },
    contract: { source: 'LAB_SPEC.md' },
    search: {
      search_mode: 'sequential',
      lane_count: 1,
      coordinator_enabled: false,
      lane_charters: [{
        lane_id: 'lane-a',
        charter_sha256: input.laneCharterHash,
        content: input.laneCharterContent,
      }],
    },
    lanes: [{
      lane_id: 'lane-a',
      worktree_path: worktree,
      base_ref: 'refs/heads/main',
      base_sha: gitSha('1'),
      method_role_id: 'lane-a-method',
      coder_role_id: 'lane-a-coder',
      preflight_judge_role_id: 'lane-a-preflight',
      postflight_judge_role_id: 'lane-a-postflight',
    }],
    roles,
    execution: {
      runner_adapter: { id: 'local-runner', version: '1', sha256: hash('5') },
      hosts: [{ host_id: 'local', runner_target: 'local' }],
      gpu_pool: [],
      max_parallel_gpu_attempts: 0,
      run_root: join(artifactRoot, 'runs'),
      contract: {},
    },
    evidence: {
      artifact_root: artifactRoot,
      contract: {},
    },
    communication: {
      topology: 'lane_isolated',
      acl_revision: 1,
      controller_visibility: 'global',
      coordinator_visibility: 'disabled',
      role_permissions: roles.map(role => ({ role_id: role.role_id, send: true, receive: true })),
      text_method_coder_within_lane: 'allowed',
      text_pair_blocks: [],
      reveal_policy: {
        initial_state: 'sealed',
        trigger: 'manual',
        text_cross_lane_before_reveal: 'blocked',
        text_cross_lane_after_reveal: 'allowed',
      },
      api_recovery: 'Use the Lab recovery contract.',
      attempt_recovery: 'Adopt before restart.',
      stop_pause_policy: 'Controller-owned.',
    },
    provenance: {},
  })
}

async function fixture(): Promise<TicketFixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-autolab-method-ticket-'))
  roots.push(root)
  const labDirectory = join(root, 'lab')
  const revisionDirectory = join(labDirectory, 'revisions', '000001')
  const artifactRoot = join(labDirectory, 'artifacts')
  const assignmentRoot = join(labDirectory, 'assignments')
  const receiptPath = join(assignmentRoot, 'outputs', 'method.json')
  const assignmentPath = join(assignmentRoot, 'method.json')
  const reviewPath = join(artifactRoot, 'reviews', 'preflight', 'method-ticket.json')
  await Promise.all([
    mkdir(revisionDirectory, { recursive: true }),
    mkdir(join(assignmentRoot, 'outputs'), { recursive: true }),
  ])

  const roleText = 'Exact Method Maker role prompt.\n'
  const laneCharterContent = {
    direction: 'Investigate fused projection implementations.',
    inherited_context: ['Keep the public interface unchanged.'],
  }
  const laneCharterText = canonicalJson(laneCharterContent)
  const manifest = manifestFixture({
    root,
    rolePromptHash: sha256(roleText),
    laneCharterHash: sha256(laneCharterText),
    laneCharterContent,
  })
  await writeFile(manifest.authority_paths.resolved_manifest, canonicalJson(manifest))

  const assignmentId = 'lane-a:method:initial'
  const assignmentText = canonicalJson({
    assignment_id: assignmentId,
    objective: 'Submit the Method material required by this Lab.',
  })
  const assignmentContractHash = sha256(assignmentText)
  await writeFile(assignmentPath, assignmentText)

  const packet = compileRolePacket({
    manifest,
    role_id: 'lane-a-method',
    session_id: 'session-lane-a-method',
    assignment_id: assignmentId,
    issued_at: 1_786_742_400_000,
    role_binding_receipt_sha256: hash('6'),
    runtime_revision: 7,
    fact_set_sha256: hash('7'),
    evidence_index_sha256: hash('8'),
    assignment_contract_sha256: assignmentContractHash,
    reveal_state: 'sealed',
    verbatim_blocks: {
      universal: [{
        block_id: 'lab-spec',
        source_path: manifest.authority_paths.lab_spec,
        exact_text: 'Exact Lab contract.\n',
        text_sha256: sha256('Exact Lab contract.\n'),
      }],
      role: [{
        block_id: 'method-role',
        source_path: join(artifactRoot, 'builtins', 'method.txt'),
        exact_text: roleText,
        text_sha256: sha256(roleText),
      }],
      lane: [{
        block_id: 'lane-charter',
        source_path: join(artifactRoot, 'lanes', 'lane-a.json'),
        exact_text: laneCharterText,
        text_sha256: sha256(laneCharterText),
      }],
      stage: [],
      assignment: [{
        block_id: 'assignment',
        source_path: assignmentPath,
        exact_text: assignmentText,
        text_sha256: assignmentContractHash,
      }],
    },
    relevant_fact_refs: [],
    evidence_refs: [],
    open_obligation_refs: [],
    input_artifact_refs: [],
    output_contract: {
      schema: methodDesignTicketOutputSchema(),
      receipt_path: receiptPath,
      expected_hash_binding: METHOD_TICKET_HASH_BINDING,
    },
  })
  const packetPath = join(labDirectory, 'packets', 'method.json')
  await mkdir(join(labDirectory, 'packets'), { recursive: true })
  await writeFile(packetPath, packet.canonicalJson)

  const ticket = parseMethodDesignTicket({
    assignment_id: assignmentId,
    assignment_contract_sha256: assignmentContractHash,
    role_packet_sha256: packet.packetHash,
    candidate_id: 'candidate-a-1',
    content: {
      method: 'Fuse the projection into one large GEMM.',
      reasoning: ['Preserve the exact Lab constraints.', 'Let Preflight interpret this material.'],
      proposed_work: { kind: 'domain-specific', details: { arbitrary: true } },
    },
  })
  return {
    packetPath,
    packetHash: packet.packetHash,
    receiptPath,
    reviewPath,
    assignmentPath,
    ticket,
  }
}

describe('Method Design Ticket envelope', () => {
  it('contains only mechanical identity plus opaque JSON content', async () => {
    const { ticket } = await fixture()
    expect(parseMethodDesignTicket(ticket)).toEqual(ticket)
    expect(Object.keys(ticket).sort()).toEqual([
      'assignment_contract_sha256',
      'assignment_id',
      'candidate_id',
      'content',
      'role_packet_sha256',
    ])

    const schema = methodDesignTicketOutputSchema() as {
      properties?: Record<string, unknown>
      additionalProperties?: boolean
    }
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
      'assignment_contract_sha256',
      'assignment_id',
      'candidate_id',
      'content',
      'role_packet_sha256',
    ])
    expect(schema.additionalProperties).toBe(false)
  })

  it('does not interpret domain fields inside content', async () => {
    const { ticket } = await fixture()
    const domainContent = {
      hard_constraints: [],
      facts: [{ disposition: 'project-specific' }],
      feature_or_lens: null,
      claims: 'the current Lab may use any representation',
      experiments: [{ control: false, evaluator: { custom: ['anything', 1] } }],
      expected_code_scope: '../not-a-runtime-field',
    }
    expect(parseMethodDesignTicket({ ...ticket, content: domainContent }).content)
      .toEqual(domainContent)
    expect(parseMethodDesignTicket({ ...ticket, content: null }).content).toBeNull()
    expect(parseMethodDesignTicket({ ...ticket, content: ['raw', 1, true] }).content)
      .toEqual(['raw', 1, true])
  })

  it('rejects non-JSON content and extra envelope fields', async () => {
    const { ticket } = await fixture()
    expect(() => parseMethodDesignTicket({ ...ticket, content: undefined }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_TICKET' }))
    expect(() => parseMethodDesignTicket({ ...ticket, claims: [] }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_TICKET' }))
  })
})

describe('immutable Method submission', () => {
  it('reads only the receipt path selected by the Role Packet and preserves exact bytes idempotently', async () => {
    const value = await fixture()
    const sourceBytes = `${JSON.stringify(value.ticket, null, 2)}\n`
    await writeFile(value.receiptPath, sourceBytes)

    const first = await freezeMethodDesignTicket({
      rolePacketPath: value.packetPath,
      rolePacketHash: value.packetHash,
      reviewArtifactPath: value.reviewPath,
    })
    const second = await freezeMethodDesignTicket({
      rolePacketPath: value.packetPath,
      rolePacketHash: value.packetHash,
      reviewArtifactPath: value.reviewPath,
    })

    expect(second).toEqual(first)
    expect(first).toMatchObject({
      assignmentId: value.ticket.assignment_id,
      candidateId: value.ticket.candidate_id,
      rolePacketHash: value.packetHash,
      sourceAssignmentPath: value.assignmentPath,
      sourceAssignmentHash: value.ticket.assignment_contract_sha256,
      sourceReceiptPath: value.receiptPath,
      artifactPath: value.reviewPath,
      artifactHash: sha256(sourceBytes),
    })
    expect(first.ticket.content).toEqual(value.ticket.content)
    expect(await readFile(value.reviewPath, 'utf8')).toBe(sourceBytes)
  })

  it('fails closed when the same immutable review identity receives different valid bytes', async () => {
    const value = await fixture()
    const originalBytes = `${JSON.stringify(value.ticket, null, 2)}\n`
    await writeFile(value.receiptPath, originalBytes)
    await freezeMethodDesignTicket({
      rolePacketPath: value.packetPath,
      rolePacketHash: value.packetHash,
      reviewArtifactPath: value.reviewPath,
    })

    await writeFile(value.receiptPath, JSON.stringify({
      ...value.ticket,
      content: { replacement: 'still valid JSON, but different immutable bytes' },
    }))
    await expect(freezeMethodDesignTicket({
      rolePacketPath: value.packetPath,
      rolePacketHash: value.packetHash,
      reviewArtifactPath: value.reviewPath,
    })).rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT' })
    expect(await readFile(value.reviewPath, 'utf8')).toBe(originalBytes)
  })

  it('rejects stale Assignment and packet hash bindings without inspecting content', async () => {
    const value = await fixture()
    await writeFile(value.receiptPath, JSON.stringify({
      ...value.ticket,
      assignment_id: 'another-assignment',
    }))
    await expect(freezeMethodDesignTicket({
      rolePacketPath: value.packetPath,
      rolePacketHash: value.packetHash,
      reviewArtifactPath: value.reviewPath,
    })).rejects.toMatchObject({ code: 'ASSIGNMENT_MISMATCH' })

    await writeFile(value.receiptPath, JSON.stringify({
      ...value.ticket,
      role_packet_sha256: hash('f'),
    }))
    await expect(freezeMethodDesignTicket({
      rolePacketPath: value.packetPath,
      rolePacketHash: value.packetHash,
      reviewArtifactPath: value.reviewPath,
    })).rejects.toMatchObject({ code: 'HASH_BINDING_MISMATCH' })

    await writeFile(value.receiptPath, JSON.stringify({
      ...value.ticket,
      assignment_contract_sha256: hash('e'),
    }))
    await expect(freezeMethodDesignTicket({
      rolePacketPath: value.packetPath,
      rolePacketHash: value.packetHash,
      reviewArtifactPath: value.reviewPath,
    })).rejects.toMatchObject({ code: 'HASH_BINDING_MISMATCH' })
  })

  it('requires the exact Assignment bytes anchored by the current packet', async () => {
    const value = await fixture()
    await writeFile(value.receiptPath, JSON.stringify(value.ticket))
    await writeFile(value.assignmentPath, '{"changed":true}')

    await expect(freezeMethodDesignTicket({
      rolePacketPath: value.packetPath,
      rolePacketHash: value.packetHash,
      reviewArtifactPath: value.reviewPath,
    })).rejects.toMatchObject({ code: 'ANCHOR_MISMATCH' })
  })

  it('requires the exact canonical packet bytes in addition to the caller hash', async () => {
    const value = await fixture()
    await writeFile(value.receiptPath, JSON.stringify(value.ticket))
    const packetText = await readFile(value.packetPath, 'utf8')
    await writeFile(value.packetPath, `${packetText}\n`)

    await expect(freezeMethodDesignTicket({
      rolePacketPath: value.packetPath,
      rolePacketHash: sha256(`${packetText}\n`),
      reviewArtifactPath: value.reviewPath,
    })).rejects.toMatchObject({ code: 'INVALID_PACKET' })
  })

  it('requires the packet to carry the exact minimal output contract', async () => {
    const value = await fixture()
    await writeFile(value.receiptPath, JSON.stringify(value.ticket))
    const packet = JSON.parse(await readFile(value.packetPath, 'utf8')) as {
      output_contract: { schema: unknown }
    }
    packet.output_contract.schema = { type: 'object' }
    const changedPacket = canonicalJson(packet)
    await writeFile(value.packetPath, changedPacket)

    await expect(freezeMethodDesignTicket({
      rolePacketPath: value.packetPath,
      rolePacketHash: sha256(changedPacket),
      reviewArtifactPath: value.reviewPath,
    })).rejects.toMatchObject({ code: 'OUTPUT_CONTRACT_MISMATCH' })
  })
})
