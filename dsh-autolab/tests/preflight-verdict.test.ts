import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { canonicalJson, sha256 } from '../src/integrity.js'
import {
  freezePreflightVerdict,
  parsePreflightVerdict,
  type PreflightTopLevelVerdict,
} from '../src/preflight-verdict.js'
import { parseRolePacket, type RolePacket } from '../src/packet.js'

const HASH = 'a'.repeat(64)
const VERDICTS: readonly PreflightTopLevelVerdict[] = [
  'APPROVED',
  'REVISION_REQUIRED',
  'REJECTED',
  'REVIEW_ERROR',
]
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

interface Fixture {
  readonly root: string
  readonly rolePacketPath: string
  readonly rolePacketHash: string
  readonly receiptPath: string
  readonly artifactPath: string
  readonly receiptBytes: Buffer
  readonly packet: RolePacket
}

async function fixture(
  verdict: PreflightTopLevelVerdict = 'APPROVED',
  mutate?: (packet: Record<string, unknown>, receipt: Record<string, unknown>) => void,
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-autolab-preflight-verdict-'))
  roots.push(root)
  const packetPath = join(root, 'packets', 'preflight.json')
  const receiptPath = join(root, 'judge', 'receipt.json')
  const artifactPath = join(root, 'controller', 'preflight-receipt.json')
  const reviewId = 'review-001'
  const assignmentId = 'preflight:review-001'
  const reviewInputHash = 'b'.repeat(64)
  const outputSchema = {
    type: 'object',
    additionalProperties: false,
    required: [
      'version',
      'review_id',
      'assignment_id',
      'review_input_sha256',
      'top_level_verdict',
      'blocking_findings',
      'reasons',
      'warnings',
    ],
    properties: {
      version: { const: 1 },
      review_id: { const: reviewId },
      assignment_id: { const: assignmentId },
      review_input_sha256: { const: reviewInputHash },
      top_level_verdict: { enum: [...VERDICTS] },
      blocking_findings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['rule_or_frozen_field', 'blocked_transition', 'conflict_or_missing_evidence'],
          properties: {
            rule_or_frozen_field: { type: 'string', minLength: 1 },
            blocked_transition: { type: 'string', minLength: 1 },
            conflict_or_missing_evidence: { type: 'string', minLength: 1 },
          },
        },
      },
      reasons: { type: 'array', items: { type: 'string', minLength: 1 } },
      warnings: { type: 'array', items: { type: 'string', minLength: 1 } },
    },
  }
  const block = (id: string, text: string) => ({
    block_id: id,
    source_path: join(root, `${id}.txt`),
    exact_text: text,
    text_sha256: sha256(text),
  })
  const packetValue: Record<string, unknown> = {
    header: {
      packet_schema_version: 1,
      lab_id: 'lab-test',
      lane_id: 'lane-a',
      role_id: 'preflight-judge',
      role_kind: 'preflight_judge',
      session_id: 'judge-session',
      assignment_id: assignmentId,
      issued_at: 1,
    },
    anchors: {
      source_revision: 1,
      dialogue_head_sha256: HASH,
      lab_spec_sha256: HASH,
      lab_yaml_sha256: HASH,
      resolved_manifest_sha256: HASH,
      campaign_contract_sha256: HASH,
      role_binding_receipt_sha256: HASH,
      runtime_revision: 1,
      fact_set_sha256: HASH,
      evidence_index_sha256: HASH,
      assignment_contract_sha256: HASH,
    },
    authority_paths: {
      lab_dir: root,
      creation_log: join(root, 'creation.jsonl'),
      lab_spec: join(root, 'LAB_SPEC.md'),
      lab_yaml: join(root, 'lab.yaml'),
      resolved_manifest: join(root, 'RESOLVED_MANIFEST.json'),
      fact_set: join(root, 'facts.json'),
      evidence_index: join(root, 'evidence.json'),
      assignment_root: join(root, 'assignments'),
      worktree_root: join(root, 'worktrees'),
      repository: join(root, 'repository'),
      artifact_root: join(root, 'artifacts'),
      run_root: join(root, 'runs'),
    },
    role_binding: {
      prompt_sha256: HASH,
      lane_charter_sha256: HASH,
      model_route: {
        route_id: 'test-route',
        provider: 'test-provider',
        model: 'test-model',
        config: {},
      },
      fallback_routes: [],
      reasoning: { mode: 'high', config: {} },
    },
    verbatim_blocks: {
      universal: [block('universal', 'lab contract')],
      role: [block('role', 'judge kernel')],
      lane: [block('lane', 'lane charter')],
      stage: [block('stage', 'preflight rubric')],
      assignment: [block('assignment', 'review assignment')],
    },
    runtime_snapshot: {
      reveal_state: 'sealed',
      relevant_fact_refs: [],
      evidence_refs: [],
      open_obligation_refs: [],
      input_artifact_refs: [],
    },
    capability_scope: {
      tools: ['read'],
      worktree: null,
      dsh_preset_ref: 'read-only',
      communication: {
        acl_revision: 1,
        topology: 'lane_isolated',
        controller_visibility: 'global',
        send: true,
        receive: true,
        text_method_coder_within_lane: 'blocked',
        text_cross_lane_before_reveal: 'blocked',
        text_cross_lane_after_reveal: 'allowed',
        reveal_trigger: 'manual',
        text_pair_blocks: [],
      },
    },
    output_contract: {
      schema: outputSchema,
      receipt_path: receiptPath,
      expected_hash_binding: reviewInputHash,
    },
  }
  const receiptValue: Record<string, unknown> = {
    version: 1,
    review_id: reviewId,
    assignment_id: assignmentId,
    review_input_sha256: reviewInputHash,
    top_level_verdict: verdict,
    blocking_findings: [],
    reasons: ['mechanically bound fixture'],
    warnings: [],
  }
  mutate?.(packetValue, receiptValue)
  const packet = parseRolePacket(packetValue)
  const packetText = canonicalJson(packet)
  const receiptText = `${JSON.stringify(receiptValue, null, 2)}\n`
  const receiptBytes = Buffer.from(receiptText, 'utf8')
  await mkdir(join(root, 'packets'), { recursive: true })
  await mkdir(join(root, 'judge'), { recursive: true })
  await writeFile(packetPath, packetText, 'utf8')
  await writeFile(receiptPath, receiptBytes)
  return {
    root,
    rolePacketPath: packetPath,
    rolePacketHash: sha256(packetText),
    receiptPath,
    artifactPath,
    receiptBytes,
    packet,
  }
}

describe('strict Preflight verdict artifact', () => {
  it.each(VERDICTS)('accepts the exact %s verdict without rewriting receipt bytes', async verdict => {
    const input = await fixture(verdict)
    const first = await freezePreflightVerdict(input)
    expect(first.verdict.top_level_verdict).toBe(verdict)
    expect(first.receiptPath).toBe(input.receiptPath)
    expect(first.artifactPath).toBe(input.artifactPath)
    expect(first.receiptBytes).toEqual(input.receiptBytes)
    expect(await readFile(input.artifactPath)).toEqual(input.receiptBytes)
    expect(first.receiptHash).toBe(sha256(input.receiptBytes))

    const second = await freezePreflightVerdict(input)
    expect(second.receiptHash).toBe(first.receiptHash)
    expect(await readFile(input.artifactPath)).toEqual(input.receiptBytes)
  })

  it('rejects unknown receipt fields and malformed blocking findings', () => {
    expect(() => parsePreflightVerdict({
      version: 1,
      review_id: 'review',
      assignment_id: 'assignment',
      review_input_sha256: HASH,
      top_level_verdict: 'APPROVED',
      blocking_findings: [],
      reasons: [],
      warnings: [],
      confidence: 0.9,
    })).toThrowError(expect.objectContaining({ code: 'INVALID_RECEIPT' }))

    expect(() => parsePreflightVerdict({
      version: 1,
      review_id: 'review',
      assignment_id: 'assignment',
      review_input_sha256: HASH,
      top_level_verdict: 'APPROVED',
      blocking_findings: [{
        rule_or_frozen_field: 'contract',
        blocked_transition: 'admit',
        conflict_or_missing_evidence: 'missing',
        score: 1,
      }],
      reasons: [],
      warnings: [],
    })).toThrowError(expect.objectContaining({ code: 'INVALID_RECEIPT' }))
  })

  it('binds receipt identity to the packet contract mechanically', async () => {
    for (const field of ['review_id', 'assignment_id', 'review_input_sha256'] as const) {
      const input = await fixture('APPROVED', (_packet, receipt) => {
        receipt[field] = field === 'review_input_sha256' ? 'c'.repeat(64) : 'other'
      })
      await expect(freezePreflightVerdict(input)).rejects.toThrowError(
        expect.objectContaining({ code: 'REVIEW_BINDING_MISMATCH' }),
      )
    }
  })

  it('checks packet path/hash and requires a Preflight Judge packet', async () => {
    const input = await fixture()
    await expect(freezePreflightVerdict({
      ...input,
      rolePacketHash: 'c'.repeat(64),
    })).rejects.toThrowError(expect.objectContaining({ code: 'PACKET_HASH_MISMATCH' }))

    const nonJudge = await fixture('APPROVED', packet => {
      const header = packet.header as Record<string, unknown>
      header.role_kind = 'method'
    })
    await expect(freezePreflightVerdict(nonJudge)).rejects.toThrowError(
      expect.objectContaining({ code: 'ROLE_MISMATCH' }),
    )
  })

  it('fails without clobbering a conflicting Controller artifact', async () => {
    const input = await fixture()
    await freezePreflightVerdict(input)
    const conflicting = Buffer.from('different immutable bytes\n', 'utf8')
    await writeFile(input.artifactPath, conflicting)

    await expect(freezePreflightVerdict(input)).rejects.toThrowError(
      expect.objectContaining({ code: 'ARTIFACT_CONFLICT' }),
    )
    expect(await readFile(input.artifactPath)).toEqual(conflicting)
  })
})
