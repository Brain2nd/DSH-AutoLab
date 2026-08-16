import { describe, expect, it } from 'vitest'

import { sha256 } from '../src/artifacts.js'
import {
  canonicalJson,
  hashResolvedManifest,
  parseResolvedManifest,
  type ResolvedManifest,
} from '../src/manifest.js'
import {
  compileRolePacket,
  hashRolePacket,
  parseRolePacket,
  type CompileRolePacketInput,
  type VerbatimBlock,
} from '../src/packet.js'
import { validManifest } from './manifest.test.js'

const hash = (digit: string): string => digit.repeat(64)

function manifest(): ResolvedManifest {
  const value = structuredClone(validManifest())
  const revisionRoot = '/tmp/autolab/labs/example/revisions/000007'
  value.source_revision = 7
  value.anchors = {
    dialogue_head_sha256: hash('4'),
    lab_spec_sha256: hash('5'),
    lab_yaml_sha256: hash('6'),
  }
  value.authority_paths.lab_spec = `${revisionRoot}/LAB_SPEC.md`
  value.authority_paths.lab_yaml = `${revisionRoot}/lab.yaml`
  value.authority_paths.resolved_manifest = `${revisionRoot}/RESOLVED_MANIFEST.json`
  value.authority_paths.worktree_root = '/tmp/worktrees'
  value.repository.path = '/tmp/repository'
  value.research = {
    user_objective: 'Objective exact projection',
    domain_payload: { stopping_rule: 'Controller decision.' },
  }
  value.contract = {
    immutable_user_text: ['constraint'],
    domain_payload: { allowed_paths: ['src/model.ts'] },
  }
  value.execution.run_root = '/tmp/runs'
  value.execution.contract = {
    launch: { argv: ['python', 'train.py'] },
    domain_payload: { checkpoint_handling: 'assigned Session decides' },
  }
  value.evidence.contract = {
    owner: 'postflight_judge',
    domain_payload: { materials: ['raw outputs'] },
  }
  value.communication.acl_revision = 2
  value.communication.text_pair_blocks = [{
    role_ids: ['lane-a-method', 'ops'],
    active_when: 'always',
  }]

  const laneA = value.lanes.find(lane => lane.lane_id === 'lane-a')!
  laneA.worktree_path = '/tmp/worktrees/lane-a'
  for (const role of value.roles) {
    if ('lane_id' in role && role.lane_id === 'lane-a'
      && (role.role_kind === 'method' || role.role_kind === 'coder')) {
      role.worktree_path = laneA.worktree_path
    }
    if (role.role_id === 'lane-a-method') role.prompt_sha256 = sha256('Method kernel\n')
    if (role.role_id === 'lane-a-preflight') {
      role.prompt_sha256 = sha256('Preflight kernel')
      role.prebound_session_id = 'preflight-session'
    }
    if (role.role_id === 'lane-a-postflight') {
      role.prompt_sha256 = sha256('Postflight kernel')
      role.prebound_session_id = 'postflight-session'
    }
  }
  return parseResolvedManifest(value)
}

function block(blockId: string, sourcePath: string, exactText: string): VerbatimBlock {
  return {
    block_id: blockId,
    source_path: sourcePath,
    exact_text: exactText,
    text_sha256: sha256(exactText),
  }
}

function input(overrides: Partial<CompileRolePacketInput> = {}): CompileRolePacketInput {
  const source = '/tmp/autolab/labs/example/revisions/000007/LAB_SPEC.md'
  const resolved = manifest()
  const laneCharter = resolved.search.lane_charters.find(charter => charter.lane_id === 'lane-a')!
  return {
    manifest: resolved,
    role_id: 'lane-a-method',
    session_id: 'method-session',
    assignment_id: 'assignment-7',
    issued_at: 1_786_742_400_000,
    role_binding_receipt_sha256: hash('a'),
    runtime_revision: 42,
    fact_set_sha256: hash('b'),
    evidence_index_sha256: hash('c'),
    assignment_contract_sha256: hash('d'),
    reveal_state: 'sealed',
    verbatim_blocks: {
      universal: [block('universal-contract', source, '\uFEFF目标与硬约束原文  \n')],
      role: [block('method-kernel', '/tmp/autolab/prompts/method.md', 'Method kernel\n')],
      lane: [block('lane-a-charter', source, canonicalJson(laneCharter.content))],
      stage: [],
      assignment: [block('assignment-7-body', '/tmp/autolab/labs/example/assignments/7.md', '提出一个候选。\n')],
    },
    incumbent: { ref: 'candidate-6', sha256: hash('e') },
    relevant_fact_refs: [{ id: 'fact-1', sha256: hash('f') }],
    evidence_refs: [{ id: 'evidence-1', sha256: hash('0') }],
    open_obligation_refs: ['obligation-1'],
    input_artifact_refs: [{
      artifact_id: 'baseline-receipt',
      path: '/tmp/autolab/labs/example/artifacts/baseline.json',
      sha256: hash('1'),
    }],
    output_contract: {
      schema: {
        type: 'object',
        required: ['candidate'],
        properties: { candidate: { type: 'string' } },
      },
      receipt_path: '/tmp/autolab/labs/example/receipts/assignment-7.json',
      expected_hash_binding: 'assignment_contract_sha256',
    },
    ...overrides,
  }
}

describe('deterministic Role Packet v1', () => {
  it('compiles exact blocks and live hashes into one canonical immutable packet', () => {
    const source = input()
    const first = compileRolePacket(source)
    const second = compileRolePacket(source)

    expect(second).toEqual(first)
    expect(first.packetHash).toBe(sha256(first.canonicalJson))
    expect(hashRolePacket(first.packet)).toBe(first.packetHash)
    expect(first.packet.header).toMatchObject({
      packet_schema_version: 1,
      lab_id: source.manifest.lab_id,
      lane_id: 'lane-a',
      role_id: 'lane-a-method',
      session_id: 'method-session',
      assignment_id: 'assignment-7',
    })
    expect(first.packet.anchors).toMatchObject({
      source_revision: 7,
      resolved_manifest_sha256: hashResolvedManifest(source.manifest),
      runtime_revision: 42,
      fact_set_sha256: hash('b'),
      evidence_index_sha256: hash('c'),
      assignment_contract_sha256: hash('d'),
    })
    expect(first.packet.verbatim_blocks.universal[0]!.exact_text).toBe('\uFEFF目标与硬约束原文  \n')
    expect(first.packet.capability_scope).toMatchObject({
      worktree: '/tmp/worktrees/lane-a',
      dsh_preset_ref: 'workspace-write',
      communication: {
        acl_revision: 2,
        text_cross_lane_before_reveal: 'blocked',
        text_pair_blocks: [{ other_role_id: 'ops', active_when: 'always' }],
      },
    })
  })

  it('carries absolute authoritative paths instead of a chat summary', () => {
    const packet = compileRolePacket(input()).packet
    expect(packet.authority_paths).toEqual({
      lab_dir: '/tmp/autolab/labs/example',
      creation_log: '/tmp/autolab/labs/example/dialogue/creation.jsonl',
      lab_spec: '/tmp/autolab/labs/example/revisions/000007/LAB_SPEC.md',
      lab_yaml: '/tmp/autolab/labs/example/revisions/000007/lab.yaml',
      resolved_manifest: '/tmp/autolab/labs/example/revisions/000007/RESOLVED_MANIFEST.json',
      fact_set: '/tmp/autolab/labs/example/artifacts/facts.json',
      evidence_index: '/tmp/autolab/labs/example/artifacts/evidence.json',
      assignment_root: '/tmp/autolab/labs/example/assignments',
      worktree_root: '/tmp/worktrees',
      repository: '/tmp/repository',
      artifact_root: '/tmp/autolab/labs/example/artifacts',
      run_root: '/tmp/runs',
    })
  })

  it('binds packet identity to assignment, fact, and evidence revisions', () => {
    const original = compileRolePacket(input()).packetHash
    expect(compileRolePacket(input({ assignment_contract_sha256: hash('2') })).packetHash).not.toBe(original)
    expect(compileRolePacket(input({ fact_set_sha256: hash('3') })).packetHash).not.toBe(original)
    expect(compileRolePacket(input({ evidence_index_sha256: hash('4') })).packetHash).not.toBe(original)
  })

  it('rejects altered verbatim bytes and duplicate block identities', () => {
    const altered = input()
    altered.verbatim_blocks.universal[0]!.exact_text = 'rewritten summary'
    expect(() => compileRolePacket(altered)).toThrow(/does not match exact_text bytes/u)

    const duplicate = input()
    duplicate.verbatim_blocks.assignment[0]!.block_id = 'universal-contract'
    expect(() => compileRolePacket(duplicate)).toThrow(/duplicate verbatim block id/u)
  })

  it('requires the role kernel bytes and exact prebound Session identity', () => {
    const missingKernel = input()
    missingKernel.verbatim_blocks.role = [
      block('wrong-kernel', '/tmp/autolab/prompts/wrong.md', 'Wrong kernel'),
    ]
    expect(() => compileRolePacket(missingKernel)).toThrow(/do not include prompt bytes/u)

    const boundManifest = structuredClone(manifest())
    const method = boundManifest.roles.find(role => role.role_id === 'lane-a-method')!
    method.prebound_session_id = 'bound-method-session'
    expect(() => compileRolePacket(input({
      manifest: parseResolvedManifest(boundManifest),
      session_id: 'other-session',
    }))).toThrow(/prebound to SessionId/u)
  })

  it('binds Preflight and Postflight packets to independent Judge roles and Sessions', () => {
    const cases = [
      {
        roleId: 'lane-a-preflight',
        roleKind: 'preflight_judge',
        sessionId: 'preflight-session',
        kernel: 'Preflight kernel',
      },
      {
        roleId: 'lane-a-postflight',
        roleKind: 'postflight_judge',
        sessionId: 'postflight-session',
        kernel: 'Postflight kernel',
      },
    ] as const
    const packets = cases.map(item => {
      const judgeInput = input({ role_id: item.roleId, session_id: item.sessionId })
      judgeInput.verbatim_blocks.role = [
        block(`${item.roleId}-kernel`, `/tmp/autolab/prompts/${item.roleId}.md`, item.kernel),
      ]
      const compiled = compileRolePacket(judgeInput)
      expect(compiled.packet.header).toMatchObject({
        role_id: item.roleId,
        role_kind: item.roleKind,
        session_id: item.sessionId,
      })
      expect(compiled.packet.role_binding.prompt_sha256).toBe(sha256(item.kernel))
      expect(compiled.packet.verbatim_blocks.stage).toEqual([])
      return compiled
    })

    expect(packets[0]!.packetHash).not.toBe(packets[1]!.packetHash)

    const mismatched = input({ role_id: 'lane-a-preflight', session_id: 'postflight-session' })
    mismatched.verbatim_blocks.role = [
      block('preflight-kernel', '/tmp/autolab/prompts/preflight.md', 'Preflight kernel'),
    ]
    expect(() => compileRolePacket(mismatched)).toThrow(/prebound to SessionId/u)
  })

  it('keeps the packet schema strict', () => {
    const packet = compileRolePacket(input()).packet as ReturnType<typeof parseRolePacket> & { confidence?: number }
    packet.confidence = 0.8
    expect(() => parseRolePacket(packet)).toThrowError(
      expect.objectContaining({ code: 'INVALID_PACKET' }),
    )
  })
})
