import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  coderImplementationReportOutputSchema,
  coderImplementationReceiptOutputSchema,
  compileCoderImplementationReceipt,
  freezeCompiledCoderImplementationReceipt,
  freezeCoderImplementationReceipt,
  parseCoderImplementationReceipt,
  parseCoderImplementationReport,
  readCoderImplementationReport,
  readCoderImplementationReceipt,
  type CoderImplementationReport,
  type CoderReceiptArtifactReference,
  type ExpectedCoderImplementationAnchors,
} from '../src/coder-receipt.js'
import { canonicalJson, sha256 } from '../src/integrity.js'

const HASH = 'a'.repeat(64)
const SHA1 = '1'.repeat(40)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{
  readonly root: string
  readonly expected: ExpectedCoderImplementationAnchors
  readonly report: CoderImplementationReport
  readonly sourceReport: CoderReceiptArtifactReference
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-autolab-coder-receipt-'))
  roots.push(root)
  return {
    root,
    expected: {
      labId: 'lab-20260815-120000-1234abcd',
      sourceRevision: 1,
      laneId: 'lane-a',
      coderRoleId: 'lane-a-coder',
      coderSessionId: 'session-lane-a-coder',
      assignmentId: 'coder:review-lane-a-0001',
      assignmentContractSha256: HASH,
      rolePacket: artifact(root, 'packets/coder.json', 'b'),
      designTicket: {
        ...artifact(root, 'reviews/method-ticket.json', 'c'),
        candidateId: 'candidate-fused-gemm-1',
      },
      preflightVerdict: {
        ...artifact(root, 'reviews/preflight-verdict.json', 'd'),
        reviewId: 'review-lane-a-0001',
      },
      sourceWorktree: {
        path: join(root, 'worktrees', 'lane-a'),
        receiptPath: join(root, 'receipts', 'worktrees', 'lane-a.json'),
        receiptSha256: 'e'.repeat(64),
      },
      candidateSha: SHA1,
    },
    report: {
      schema_version: 1,
      content: {
        summary: 'Implemented the requested fused kernel.',
        notes: ['Kept the large matrix multiplication intact.'],
        references: [{
          path: join(root, 'files-runtime-must-not-open', 'result.json'),
          claimed_digest: 'domain-owned-value',
        }],
      },
    },
    sourceReport: artifact(root, 'reports/coder.json', '8'),
  }
}

describe('Coder model report and Runtime identity receipt', () => {
  it('keeps the model-facing envelope to schema_version plus opaque JSON content', async () => {
    const value = await fixture()

    expect(parseCoderImplementationReport(value.report)).toEqual(value.report)
    expect(parseCoderImplementationReport({ schema_version: 1, content: null }))
      .toEqual({ schema_version: 1, content: null })
    expect(parseCoderImplementationReport({ schema_version: 1, content: ['any', 1, true] }))
      .toEqual({ schema_version: 1, content: ['any', 1, true] })
    expect(() => parseCoderImplementationReport({
      ...value.report,
      extra_runtime_field: true,
    })).toThrow(expect.objectContaining({ code: 'INVALID_RECEIPT' }))
    expect(() => parseCoderImplementationReport({ schema_version: 1, content: undefined }))
      .toThrow(expect.objectContaining({ code: 'INVALID_RECEIPT' }))

    const schema = coderImplementationReportOutputSchema() as Record<string, unknown>
    expect(schema).toMatchObject({ type: 'object', additionalProperties: false })
  })

  it('compiles exactly the trusted mechanical identities and report reference', async () => {
    const value = await fixture()
    const receipt = compileCoderImplementationReceipt({
      expected: value.expected,
      sourceReport: value.sourceReport,
    })

    expect(Object.keys(receipt).sort()).toEqual([
      'assignment',
      'candidate_sha',
      'coder',
      'design_ticket',
      'lab_id',
      'lane_id',
      'preflight_verdict',
      'role_packet',
      'schema_version',
      'source_report',
      'source_revision',
      'source_worktree',
    ])
    expect(receipt).toEqual({
      schema_version: 1,
      lab_id: value.expected.labId,
      source_revision: value.expected.sourceRevision,
      lane_id: value.expected.laneId,
      coder: {
        role_id: value.expected.coderRoleId,
        session_id: value.expected.coderSessionId,
      },
      assignment: {
        assignment_id: value.expected.assignmentId,
        assignment_contract_sha256: value.expected.assignmentContractSha256,
      },
      role_packet: value.expected.rolePacket,
      design_ticket: {
        path: value.expected.designTicket.path,
        sha256: value.expected.designTicket.sha256,
        candidate_id: value.expected.designTicket.candidateId,
      },
      preflight_verdict: {
        path: value.expected.preflightVerdict.path,
        sha256: value.expected.preflightVerdict.sha256,
        review_id: value.expected.preflightVerdict.reviewId,
      },
      source_worktree: {
        path: value.expected.sourceWorktree.path,
        receipt_path: value.expected.sourceWorktree.receiptPath,
        receipt_sha256: value.expected.sourceWorktree.receiptSha256,
      },
      candidate_sha: value.expected.candidateSha,
      source_report: value.sourceReport,
    })
    expect(parseCoderImplementationReceipt(receipt)).toEqual(receipt)

    const schema = coderImplementationReceiptOutputSchema() as Record<string, unknown>
    expect(schema).toMatchObject({ type: 'object', additionalProperties: false })
  })

  it('rejects extra Runtime fields and malformed mechanical identities', async () => {
    const value = await fixture()
    const receipt = compileCoderImplementationReceipt({
      expected: value.expected,
      sourceReport: value.sourceReport,
    })

    expect(() => parseCoderImplementationReceipt({ ...receipt, score: 0.9 }))
      .toThrow(expect.objectContaining({ code: 'INVALID_RECEIPT' }))
    expect(() => parseCoderImplementationReceipt({ ...receipt, candidate_sha: '3'.repeat(41) }))
      .toThrow(expect.objectContaining({ code: 'INVALID_RECEIPT' }))
    expect(() => compileCoderImplementationReceipt({
      expected: { ...value.expected, assignmentContractSha256: 'not-a-hash' },
      sourceReport: value.sourceReport,
    })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }))
  })
})

describe('immutable Coder Runtime receipt', () => {
  it('reads the small report while leaving every path inside content untouched', async () => {
    const value = await fixture()
    const sourceReportPath = join(value.root, 'implementation-report.json')
    const artifactPath = join(value.root, 'frozen', 'coder-receipt.json')
    const reportBytes = Buffer.from(`${JSON.stringify(value.report, null, 2)}\n`)
    await writeFile(sourceReportPath, reportBytes)

    const read = await readCoderImplementationReport(sourceReportPath)
    expect(read).toEqual({
      path: sourceReportPath,
      sha256: sha256(reportBytes),
      bytes: reportBytes,
      report: value.report,
    })

    const frozen = await freezeCompiledCoderImplementationReceipt({
      sourceReportPath,
      sourceReportSha256: sha256(reportBytes),
      artifactPath,
      expected: value.expected,
    })
    expect(frozen.receipt.source_report).toEqual({
      path: sourceReportPath,
      sha256: sha256(reportBytes),
    })
    expect(frozen.receipt).not.toHaveProperty('content')

    const nestedPath = (value.report.content as {
      references: { path: string }[]
    }).references[0]!.path
    await expect(stat(nestedPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('canonically freezes the compiled receipt and adopts an exact replay', async () => {
    const value = await fixture()
    const sourceReportPath = join(value.root, 'implementation-report.json')
    const artifactPath = join(value.root, 'frozen', 'coder-receipt.json')
    const reportBytes = Buffer.from(`${JSON.stringify(value.report, null, 2)}\n`)
    await writeFile(sourceReportPath, reportBytes)
    const input = {
      sourceReportPath,
      sourceReportSha256: sha256(reportBytes),
      artifactPath,
      expected: value.expected,
    }

    const first = await freezeCompiledCoderImplementationReceipt(input)
    const second = await freezeCompiledCoderImplementationReceipt(input)

    expect(second).toEqual(first)
    expect(first.receipt).toEqual(compileCoderImplementationReceipt({
      expected: value.expected,
      sourceReport: { path: sourceReportPath, sha256: sha256(reportBytes) },
    }))
    expect(first.receiptBytes.toString('utf8')).toBe(canonicalJson(first.receipt))
    expect(await readFile(artifactPath)).toEqual(first.receiptBytes)
  })

  it('rejects report hash drift before publishing the final receipt', async () => {
    const value = await fixture()
    const sourceReportPath = join(value.root, 'implementation-report.json')
    const artifactPath = join(value.root, 'frozen', 'coder-receipt.json')
    await writeFile(sourceReportPath, JSON.stringify(value.report))

    await expect(freezeCompiledCoderImplementationReceipt({
      sourceReportPath,
      sourceReportSha256: '0'.repeat(64),
      artifactPath,
      expected: value.expected,
    })).rejects.toMatchObject({ code: 'HASH_MISMATCH' })
    await expect(stat(artifactPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves exact valid receipt bytes and reads them by exact hash', async () => {
    const value = await fixture()
    const receipt = compileCoderImplementationReceipt({
      expected: value.expected,
      sourceReport: value.sourceReport,
    })
    const sourceReceiptPath = join(value.root, 'runtime-coder-receipt.json')
    const artifactPath = join(value.root, 'frozen', 'coder-receipt.json')
    const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`)
    await writeFile(sourceReceiptPath, receiptBytes)

    const input = {
      sourceReceiptPath,
      artifactPath,
      expected: value.expected,
      sourceReport: value.sourceReport,
    }
    const first = await freezeCoderImplementationReceipt(input)
    const second = await freezeCoderImplementationReceipt(input)
    expect(second).toEqual(first)
    expect(first.receiptBytes).toEqual(receiptBytes)
    expect(first.artifactHash).toBe(sha256(receiptBytes))

    const read = await readCoderImplementationReceipt({
      path: artifactPath,
      sha256: first.artifactHash,
    })
    expect(read.receipt).toEqual(receipt)
    expect(read.receiptBytes).toEqual(receiptBytes)
  })

  it('rejects candidate or source-report identity drift', async () => {
    const value = await fixture()
    const receipt = compileCoderImplementationReceipt({
      expected: value.expected,
      sourceReport: value.sourceReport,
    })
    const sourceReceiptPath = join(value.root, 'runtime-coder-receipt.json')
    const artifactPath = join(value.root, 'frozen', 'coder-receipt.json')
    await writeFile(sourceReceiptPath, JSON.stringify({
      ...receipt,
      candidate_sha: '2'.repeat(40),
    }))

    await expect(freezeCoderImplementationReceipt({
      sourceReceiptPath,
      artifactPath,
      expected: value.expected,
      sourceReport: value.sourceReport,
    })).rejects.toMatchObject({ code: 'ANCHOR_MISMATCH' })

    await writeFile(sourceReceiptPath, JSON.stringify({
      ...receipt,
      source_report: { ...value.sourceReport, sha256: '7'.repeat(64) },
    }))
    await expect(freezeCoderImplementationReceipt({
      sourceReceiptPath,
      artifactPath,
      expected: value.expected,
      sourceReport: value.sourceReport,
    })).rejects.toMatchObject({ code: 'ANCHOR_MISMATCH' })
    await expect(stat(artifactPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('never overwrites different immutable bytes and detects a stale read hash', async () => {
    const value = await fixture()
    const sourceReceiptPath = join(value.root, 'runtime-coder-receipt.json')
    const artifactPath = join(value.root, 'frozen', 'coder-receipt.json')
    const firstReceipt = compileCoderImplementationReceipt({
      expected: value.expected,
      sourceReport: value.sourceReport,
    })
    const firstBytes = Buffer.from(`${JSON.stringify(firstReceipt, null, 2)}\n`)
    await writeFile(sourceReceiptPath, firstBytes)
    await freezeCoderImplementationReceipt({
      sourceReceiptPath,
      artifactPath,
      expected: value.expected,
      sourceReport: value.sourceReport,
    })

    const changedExpected = { ...value.expected, candidateSha: '3'.repeat(40) }
    const changedReceipt = compileCoderImplementationReceipt({
      expected: changedExpected,
      sourceReport: value.sourceReport,
    })
    await writeFile(sourceReceiptPath, `${JSON.stringify(changedReceipt, null, 2)}\n`)
    await expect(freezeCoderImplementationReceipt({
      sourceReceiptPath,
      artifactPath,
      expected: changedExpected,
      sourceReport: value.sourceReport,
    })).rejects.toMatchObject({ code: 'ARTIFACT_CONFLICT' })
    expect(await readFile(artifactPath)).toEqual(firstBytes)

    await expect(readCoderImplementationReceipt({
      path: artifactPath,
      sha256: '0'.repeat(64),
    })).rejects.toMatchObject({ code: 'HASH_MISMATCH' })
  })
})

function artifact(
  root: string,
  relativePath: string,
  hashCharacter: string,
): CoderReceiptArtifactReference {
  return { path: join(root, relativePath), sha256: hashCharacter.repeat(64) }
}
