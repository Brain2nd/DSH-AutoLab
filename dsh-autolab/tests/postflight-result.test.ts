import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { canonicalJson, sha256 } from '../src/integrity.js'
import { compileRolePacket } from '../src/packet.js'
import {
  freezePostflightResult,
  type FreezePostflightResultInput,
} from '../src/postflight-result.js'
import { rolePromptFor } from '../src/roles.js'
import { validManifest } from './manifest.test.js'

const HASH = 'a'.repeat(64)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

interface Fixture {
  readonly input: FreezePostflightResultInput
  readonly receiptPath: string
  readonly receiptBytes: Buffer
  readonly referencedLog: string
  readonly referencedCheckpoint: string
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-autolab-postflight-result-'))
  roots.push(root)
  const manifest = structuredClone(validManifest())
  const lane = manifest.search.lane_charters.find(value => value.lane_id === 'lane-a')!
  const role = manifest.roles.find(value => value.role_id === 'lane-a-postflight')!
  const prompt = rolePromptFor('postflight_judge')
  role.prompt_sha256 = prompt.sha256
  manifest.authority_paths.lab_dir = join(root, 'lab')
  manifest.authority_paths.creation_log = join(root, 'lab', 'dialogue', 'creation.jsonl')
  manifest.authority_paths.lab_spec = join(root, 'lab', 'LAB_SPEC.md')
  manifest.authority_paths.lab_yaml = join(root, 'lab', 'lab.yaml')
  manifest.authority_paths.resolved_manifest = join(root, 'lab', 'RESOLVED_MANIFEST.json')
  manifest.authority_paths.fact_set = join(root, 'lab', 'facts.json')
  manifest.authority_paths.evidence_index = join(root, 'lab', 'evidence.json')
  manifest.authority_paths.assignment_root = join(root, 'lab', 'assignments')
  manifest.authority_paths.worktree_root = join(root, 'worktrees')
  manifest.repository.path = join(root, 'repository')
  manifest.evidence.artifact_root = join(root, 'lab', 'artifacts')
  manifest.execution.run_root = join(root, 'runs')
  for (const laneBinding of manifest.lanes) {
    laneBinding.worktree_path = join(root, 'worktrees', laneBinding.lane_id)
  }
  for (const candidate of manifest.roles) {
    if (candidate.role_kind === 'method' || candidate.role_kind === 'coder') {
      candidate.worktree_path = join(root, 'worktrees', candidate.lane_id)
    }
  }

  const block = (blockId: string, sourcePath: string, exactText: string) => ({
    block_id: blockId,
    source_path: sourcePath,
    exact_text: exactText,
    text_sha256: sha256(exactText),
  })
  const assignmentId = 'postflight:review-001'
  const assignmentText = canonicalJson({ assignment_id: assignmentId, lab_owned: true })
  const receiptPath = join(root, 'judge', 'postflight.out')
  const reviewInputHash = 'b'.repeat(64)
  const packet = compileRolePacket({
    manifest,
    role_id: role.role_id,
    session_id: 'session-lane-a-postflight',
    assignment_id: assignmentId,
    issued_at: 1,
    role_binding_receipt_sha256: HASH,
    runtime_revision: 1,
    fact_set_sha256: HASH,
    evidence_index_sha256: HASH,
    assignment_contract_sha256: sha256(assignmentText),
    reveal_state: 'sealed',
    verbatim_blocks: {
      universal: [block('lab-spec', manifest.authority_paths.lab_spec, 'exact lab contract')],
      role: [block('role-prompt', join(root, 'prompt.txt'), prompt.text)],
      lane: [block('lane-charter', join(root, 'lane.json'), canonicalJson(lane.content))],
      stage: [],
      assignment: [block('assignment', join(root, 'assignment.json'), assignmentText)],
    },
    relevant_fact_refs: [],
    evidence_refs: [],
    open_obligation_refs: [],
    input_artifact_refs: [],
    output_contract: {
      schema: {
        lab_native_format: 'opaque',
        attribution_labels: ['feature', 'implementation', 'environment', 'unknown'],
      },
      receipt_path: receiptPath,
      expected_hash_binding: reviewInputHash,
    },
  })
  const packetPath = join(root, 'packet.json')
  const artifactPath = join(root, 'controller', 'postflight-result.raw')
  const referencedLog = join(root, 'experiment', 'large.log')
  const referencedCheckpoint = join(root, 'experiment', 'large.ckpt')
  const receiptBytes = Buffer.from([
    'LAB-NATIVE-POSTFLIGHT-V7',
    'attribution=feature-or-measurement',
    `log=${referencedLog}`,
    `checkpoint=${referencedCheckpoint}`,
    'This is intentionally not JSON and has no Preflight verdict enum.',
    '',
  ].join('\n'), 'utf8')
  await mkdir(join(root, 'judge'), { recursive: true })
  await writeFile(packetPath, packet.canonicalJson, 'utf8')
  await writeFile(receiptPath, receiptBytes)
  return {
    receiptPath,
    receiptBytes,
    referencedLog,
    referencedCheckpoint,
    input: { rolePacketPath: packetPath, rolePacketHash: packet.packetHash, artifactPath },
  }
}

describe('opaque Postflight result freeze', () => {
  it('preserves arbitrary Lab receipt bytes without parsing or following references', async () => {
    const value = await fixture()
    const first = await freezePostflightResult(value.input)
    const replay = await freezePostflightResult(value.input)

    expect(replay.receiptHash).toBe(first.receiptHash)
    expect(first.receiptPath).toBe(value.receiptPath)
    expect(first.receiptBytes).toEqual(value.receiptBytes)
    expect(first.receiptHash).toBe(sha256(value.receiptBytes))
    expect(first.expectedHashBinding).toBe('b'.repeat(64))
    expect(await readFile(value.input.artifactPath)).toEqual(value.receiptBytes)
    await expect(stat(value.referencedLog)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(value.referencedCheckpoint)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('never replaces a conflicting immutable Controller result', async () => {
    const value = await fixture()
    await freezePostflightResult(value.input)
    const conflict = Buffer.from('different immutable bytes\n', 'utf8')
    await writeFile(value.input.artifactPath, conflict)

    await expect(freezePostflightResult(value.input))
      .rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT' })
    expect(await readFile(value.input.artifactPath)).toEqual(conflict)
  })

  it('binds to the exact Postflight Packet bytes', async () => {
    const value = await fixture()
    await expect(freezePostflightResult({
      ...value.input,
      rolePacketHash: 'c'.repeat(64),
    })).rejects.toMatchObject({ code: 'PACKET_HASH_MISMATCH' })
  })
})
