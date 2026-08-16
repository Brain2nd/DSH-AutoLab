import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  restoreCurrentRoleArtifacts: vi.fn(),
  freezeLaneCandidate: vi.fn(),
  candidateFrozenReportPath: vi.fn((labDirectory: string, assignmentId: string) => (
    join(labDirectory, 'artifacts', 'candidates', assignmentId, 'coder-report.json')
  )),
  candidateReceiptPath: vi.fn((labDirectory: string, assignmentId: string) => (
    join(labDirectory, 'artifacts', 'candidates', assignmentId, 'candidate.json')
  )),
  inspectLaneWorktree: vi.fn(),
}))

vi.mock('../src/activation-artifacts.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/activation-artifacts.js')>(),
  restoreCurrentRoleArtifacts: mocks.restoreCurrentRoleArtifacts,
}))

vi.mock('../src/candidate.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/candidate.js')>(),
  freezeLaneCandidate: mocks.freezeLaneCandidate,
  candidateFrozenReportPath: mocks.candidateFrozenReportPath,
  candidateReceiptPath: mocks.candidateReceiptPath,
}))

vi.mock('../src/worktree.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/worktree.js')>(),
  inspectLaneWorktree: mocks.inspectLaneWorktree,
}))

import { coderImplementationReportOutputSchema } from '../src/coder-receipt.js'
import {
  freezeApprovedCoderSubmission,
  type FreezeApprovedCoderSubmissionInput,
} from '../src/coder-submission.js'
import { canonicalJson, sha256 } from '../src/integrity.js'

const roots: string[] = []

afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

interface SubmissionFixture {
  readonly root: string
  readonly input: FreezeApprovedCoderSubmissionInput
  readonly mutableReportPath: string
  readonly frozenReportPath: string
  readonly nestedMissingPath: string
  readonly candidatePath: string
  readonly candidate: Record<string, unknown> & { candidateSha: string; capturedAt: number }
  readonly assignmentValue: Record<string, unknown>
  rewriteAssignment(value: Record<string, unknown>): Promise<void>
}

async function fixture(): Promise<SubmissionFixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-autolab-coder-submission-'))
  roots.push(root)
  const labDirectory = join(root, 'lab')
  const assignmentRoot = join(labDirectory, 'assignments')
  const laneId = 'lane-a'
  const roleId = 'lane-a-coder'
  const sessionId = 'session-lane-a-coder'
  const reviewId = 'review-a-1'
  const assignmentId = `coder:${reviewId}`
  const worktreePath = join(root, 'lane-worktree')
  const baseSha = '1'.repeat(40)
  const candidateSha = '2'.repeat(40)
  const issuedAt = 1_723_700_000_000
  const runtimeRevision = 7

  const ticketText = canonicalJson({ domain_owned: 'ticket text remains opaque here' })
  const verdictText = canonicalJson({ domain_owned: 'verdict text remains opaque here' })
  const sourceMethodPacket = reference(join(root, 'missing', 'method-packet.json'), '3')
  const designTicket = {
    path: join(root, 'missing', 'design-ticket.json'),
    hash: sha256(ticketText),
  }
  const preflightVerdict = {
    path: join(root, 'missing', 'preflight-verdict.json'),
    hash: sha256(verdictText),
  }
  const coderPacket = reference(join(root, 'missing', 'coder-packet.json'), '4')
  const coderBinding = {
    path: join(root, 'missing', 'coder-binding.json'),
    hash: '5'.repeat(64),
  }
  const outputContract = {
    schema: coderImplementationReportOutputSchema(),
    receipt_path: join(assignmentRoot, 'outputs', `${sha256(assignmentId)}.json`),
    expected_hash_binding: assignmentId,
  }
  const stage = [
    {
      block_id: 'approved-method-design-ticket',
      source_path: designTicket.path,
      exact_text: ticketText,
      text_sha256: designTicket.hash,
    },
    {
      block_id: 'preflight-approved-verdict',
      source_path: preflightVerdict.path,
      exact_text: verdictText,
      text_sha256: preflightVerdict.hash,
    },
  ]
  const packetHash = '6'.repeat(64)
  const assignmentPath = join(assignmentRoot, 'coder-assignment.json')
  const assignmentValue: Record<string, unknown> = {
    version: 1,
    assignment_type: 'approved_coder_implementation',
    assignment_id: assignmentId,
    review_id: reviewId,
    runtime_revision: runtimeRevision,
    issued_at: issuedAt,
    coder: {
      role_id: roleId,
      session_id: sessionId,
      binding_path: coderBinding.path,
      binding_sha256: coderBinding.hash,
    },
    source_method: {
      packet: { path: sourceMethodPacket.path, sha256: sourceMethodPacket.hash },
    },
    design_ticket: {
      path: designTicket.path,
      sha256: designTicket.hash,
      candidate_id: 'candidate-fused-1',
    },
    preflight_approval: {
      path: preflightVerdict.path,
      sha256: preflightVerdict.hash,
      top_level_verdict: 'APPROVED',
    },
    output_contract: outputContract,
  }
  await mkdir(dirname(outputContract.receipt_path), { recursive: true })
  await writeFile(assignmentPath, canonicalJson(assignmentValue))
  const assignmentHash = sha256(canonicalJson(assignmentValue))

  const nestedMissingPath = join(root, 'missing', 'model-mentioned-output.bin')
  const report = {
    schema_version: 1,
    content: {
      summary: 'Implemented the requested candidate.',
      model_owned_notes: ['A Session may interpret these later.'],
      references: [{ path: nestedMissingPath, digest: 'not-a-runtime-contract' }],
    },
  }
  await writeFile(outputContract.receipt_path, `${JSON.stringify(report, null, 2)}\n`)

  const frozenReportPath = mocks.candidateFrozenReportPath(labDirectory, assignmentId)
  const candidatePath = mocks.candidateReceiptPath(labDirectory, assignmentId)
  await mkdir(dirname(candidatePath), { recursive: true })
  const candidateBytes = Buffer.from('small candidate control receipt\n')
  await writeFile(candidatePath, candidateBytes)
  const worktreeReceiptPath = join(labDirectory, 'receipts', 'worktrees', `${laneId}.json`)
  await mkdir(dirname(worktreeReceiptPath), { recursive: true })
  await writeFile(worktreeReceiptPath, 'small worktree control receipt\n')

  const coderRole = {
    role_kind: 'coder',
    role_id: roleId,
    lane_id: laneId,
  }
  const manifest = {
    lab_id: 'lab-a',
    roles: [coderRole],
    lanes: [{
      lane_id: laneId,
      coder_role_id: roleId,
      worktree_path: worktreePath,
      base_sha: baseSha,
    }],
    authority_paths: {
      lab_dir: labDirectory,
      assignment_root: assignmentRoot,
    },
  }
  const packet = {
    packetHash,
    canonicalJson: '',
    packet: {
      header: { issued_at: issuedAt },
      anchors: { runtime_revision: runtimeRevision },
      output_contract: outputContract,
      verbatim_blocks: { stage },
    },
  }
  const assignment = {
    assignmentId,
    assignmentPath,
    assignmentHash,
    objectiveBody: 'mechanically frozen assignment',
    packetPath: coderPacket.path,
    packet,
  }
  const candidate = {
    version: 1,
    candidateSha,
    capturedAt: issuedAt,
  }
  mocks.restoreCurrentRoleArtifacts.mockResolvedValue(assignment)
  mocks.inspectLaneWorktree.mockResolvedValue({
    currentHeadSha: baseSha,
    dirty: true,
    receipt: {
      labId: manifest.lab_id,
      laneId,
      worktreePath,
      baseSha,
      receiptHash: '7'.repeat(64),
    },
  })
  mocks.freezeLaneCandidate.mockResolvedValue(candidate)

  const input = {
    frozen: {
      ref: { revision: 1, manifestHash: '8'.repeat(64) },
      manifest,
    },
    coderRole,
    coderSessionId: sessionId,
    coderBinding,
    coderPacket,
    expectedAssignmentId: assignmentId,
    reviewId,
    sourceMethodPacket,
    designTicket,
    preflightVerdict,
    runtimeRevision,
  } as unknown as FreezeApprovedCoderSubmissionInput

  return {
    root,
    input,
    mutableReportPath: outputContract.receipt_path,
    frozenReportPath,
    nestedMissingPath,
    candidatePath,
    candidate,
    assignmentValue,
    rewriteAssignment: async value => {
      const text = canonicalJson(value)
      await writeFile(assignmentPath, text)
      assignment.assignmentHash = sha256(text)
    },
  }
}

describe('minimal Coder submission freeze', () => {
  it('freezes only mechanical identities and never opens model or review references', async () => {
    const value = await fixture()
    const reportBytes = await readFile(value.mutableReportPath)
    const result = await freezeApprovedCoderSubmission(value.input)

    expect(result).not.toHaveProperty('disposition')
    expect(result).toMatchObject({
      laneId: 'lane-a',
      candidateId: 'candidate-fused-1',
      reviewId: 'review-a-1',
      reportPath: value.frozenReportPath,
      reportHash: sha256(reportBytes),
      candidatePath: value.candidatePath,
      candidate: value.candidate,
    })
    expect(mocks.freezeLaneCandidate).toHaveBeenCalledTimes(1)
    expect(mocks.freezeLaneCandidate).toHaveBeenCalledWith(expect.objectContaining({
      assignmentId: 'coder:review-a-1',
      candidateId: 'candidate-fused-1',
      sourceReport: {
        path: value.frozenReportPath,
        hash: sha256(reportBytes),
      },
    }))
    expect(result.implementation.receipt).toMatchObject({
      lab_id: 'lab-a',
      lane_id: 'lane-a',
      candidate_sha: value.candidate.candidateSha,
      source_report: {
        path: value.frozenReportPath,
        sha256: sha256(reportBytes),
      },
    })
    expect(result.implementation.receipt).not.toHaveProperty('content')

    for (const path of [
      value.input.designTicket.path,
      value.input.preflightVerdict.path,
      value.input.sourceMethodPacket.path,
      value.nestedMissingPath,
    ]) {
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('adopts the immutable report after mutable output disappears', async () => {
    const value = await fixture()
    const first = await freezeApprovedCoderSubmission(value.input)
    const frozenBytes = await readFile(value.frozenReportPath)
    await rm(value.mutableReportPath)

    const replay = await freezeApprovedCoderSubmission(value.input)
    expect(replay.reportPath).toBe(first.reportPath)
    expect(replay.reportHash).toBe(first.reportHash)
    expect(replay.implementation).toEqual(first.implementation)
    expect(await readFile(value.frozenReportPath)).toEqual(frozenBytes)
  })

  it('rejects mechanical Assignment drift before candidate capture', async () => {
    const value = await fixture()
    await value.rewriteAssignment({ ...value.assignmentValue, review_id: 'review-other' })

    await expect(freezeApprovedCoderSubmission(value.input))
      .rejects.toMatchObject({ code: 'ASSIGNMENT_MISMATCH' })
    expect(mocks.freezeLaneCandidate).not.toHaveBeenCalled()
  })
})

function reference(path: string, character: string): { readonly path: string; readonly hash: string } {
  return { path, hash: character.repeat(64) }
}
