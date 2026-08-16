import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import {
  candidateFrozenReportPath,
  candidateReceiptPath,
  CandidateSnapshotError,
  freezeLaneCandidate,
  readCandidateChangedPaths,
  readCandidateSnapshotReceipt,
  type FreezeLaneCandidateInput,
} from '../src/candidate.js'
import { sha256 } from '../src/integrity.js'
import { provisionLaneWorktree } from '../src/worktree.js'

const execFileAsync = promisify(execFile)
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async path => {
    await rm(path, { recursive: true, force: true })
  }))
})

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  })
  return result.stdout.trim()
}

async function fixture(): Promise<{
  readonly input: FreezeLaneCandidateInput
  readonly repositoryPath: string
  readonly worktreePath: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-autolab-candidate-test-'))
  temporaryRoots.push(root)
  const repositoryPath = join(root, 'repository')
  const labDirectory = join(root, 'autolab', 'labs', 'lab-candidate-fixture')
  const worktreePath = join(root, 'worktrees', 'lane-a')
  await Promise.all([
    mkdir(repositoryPath, { recursive: true }),
    mkdir(labDirectory, { recursive: true }),
  ])
  await git(repositoryPath, ['init', '-q'])
  await git(repositoryPath, ['config', 'user.name', 'Fixture'])
  await git(repositoryPath, ['config', 'user.email', 'fixture@example.invalid'])
  await writeFile(join(repositoryPath, 'tracked.txt'), 'base\n', 'utf8')
  await git(repositoryPath, ['add', 'tracked.txt'])
  await git(repositoryPath, ['commit', '-q', '-m', 'base'])
  const baseSha = await git(repositoryPath, ['rev-parse', 'HEAD'])

  const lane = await provisionLaneWorktree({
    labId: 'lab-candidate-fixture',
    laneId: 'lane-a',
    labDirectory,
    repositoryPath,
    worktreePath,
    baseRef: 'HEAD',
    baseSha,
    now: 1_700_000_000_000,
  })
  await writeFile(join(worktreePath, 'tracked.txt'), 'candidate\n', 'utf8')
  await writeFile(join(worktreePath, 'new.txt'), 'new candidate file\n', 'utf8')
  const assignmentId = 'coder:review-a'
  const frozenReportPath = candidateFrozenReportPath(labDirectory, assignmentId)
  const frozenReport = Buffer.from('{"report":"candidate A"}\n', 'utf8')
  await mkdir(dirname(frozenReportPath), { recursive: true })
  await writeFile(frozenReportPath, frozenReport)

  return {
    repositoryPath,
    worktreePath,
    input: {
      labId: 'lab-candidate-fixture',
      sourceRevision: 1,
      manifestHash: sha256('manifest'),
      runtimeRevision: 7,
      laneId: 'lane-a',
      candidateId: 'candidate/a is allowed because paths use hashes',
      coderRoleId: 'lane-a-coder',
      coderSessionId: 'coder-session-a',
      assignmentId,
      assignmentHash: sha256('coder assignment'),
      labDirectory,
      expectedWorktreePath: lane.receipt.worktreePath,
      expectedWorktreeReceiptHash: lane.receipt.receiptHash,
      expectedBaseSha: lane.receipt.baseSha,
      sourceReport: {
        path: frozenReportPath,
        hash: sha256(frozenReport),
      },
      now: 1_700_000_001_234,
    },
  }
}

describe('Lane candidate snapshot', () => {
  it('freezes tracked and untracked bytes without changing the long-lived worktree or index', async () => {
    const value = await fixture()
    const first = await freezeLaneCandidate(value.input)
    const second = await freezeLaneCandidate({ ...value.input, now: value.input.now! + 999 })

    expect(second).toEqual(first)
    expect(first.candidateSha).toMatch(/^[0-9a-f]{40,64}$/u)
    expect(first.baseSha).toBe(value.input.expectedBaseSha)
    expect(first.worktreeReceiptHash).toBe(value.input.expectedWorktreeReceiptHash)
    expect(first.assignmentHash).toBe(value.input.assignmentHash)
    expect(first.sourceReport).toEqual(value.input.sourceReport)
    await expect(readCandidateChangedPaths(first)).resolves.toEqual(['new.txt', 'tracked.txt'])
    expect(await git(value.worktreePath, ['show', `${first.candidateSha}:tracked.txt`])).toBe('candidate')
    expect(await git(value.worktreePath, ['show', `${first.candidateSha}:new.txt`])).toBe('new candidate file')
    expect(await git(value.worktreePath, ['rev-parse', 'HEAD'])).toBe(value.input.expectedBaseSha)
    expect(await git(value.worktreePath, ['diff', '--cached', '--name-only'])).toBe('')
    expect(await git(value.worktreePath, ['status', '--porcelain'])).toContain('tracked.txt')
  })

  it('verifies a receipt reference and every immutable artifact it binds', async () => {
    const value = await fixture()
    const receipt = await freezeLaneCandidate(value.input)
    const path = candidateReceiptPath(value.input.labDirectory, value.input.assignmentId)

    await expect(readCandidateSnapshotReceipt({
      path,
      hash: sha256(await readFile(path)),
    })).resolves.toEqual(receipt)

    await writeFile(value.input.sourceReport!.path, 'tampered report\n')
    await expect(readCandidateSnapshotReceipt({
      path,
      hash: sha256(await readFile(path)),
    })).rejects.toMatchObject({
      name: 'CandidateSnapshotError',
      code: 'RECEIPT_CORRUPT',
    } satisfies Partial<CandidateSnapshotError>)
  })

  it('replays the write-ahead intent after a crash even if the Lane worktree changed later', async () => {
    const value = await fixture()
    const first = await freezeLaneCandidate(value.input)
    await rm(candidateReceiptPath(value.input.labDirectory, value.input.assignmentId))
    await writeFile(join(value.worktreePath, 'tracked.txt'), 'later unrelated edit\n', 'utf8')

    const recovered = await freezeLaneCandidate({ ...value.input, now: value.input.now! + 999 })

    expect(recovered).toEqual(first)
    expect(await git(value.worktreePath, ['show', `${recovered.candidateSha}:tracked.txt`])).toBe('candidate')
  })

  it('rejects changed identities and a mismatched worktree receipt instead of recapturing', async () => {
    const value = await fixture()
    await freezeLaneCandidate(value.input)

    await expect(freezeLaneCandidate({
      ...value.input,
      assignmentHash: sha256('another assignment'),
    })).rejects.toMatchObject({
      name: 'CandidateSnapshotError',
      code: 'CAPTURE_CONFLICT',
    } satisfies Partial<CandidateSnapshotError>)

    const another = await fixture()
    await expect(freezeLaneCandidate({
      ...another.input,
      expectedWorktreeReceiptHash: sha256('wrong receipt'),
    })).rejects.toMatchObject({
      name: 'CandidateSnapshotError',
      code: 'WORKTREE_MISMATCH',
    } satisfies Partial<CandidateSnapshotError>)
  })

  it('rejects receipt extension fields and Git ref drift', async () => {
    const firstValue = await fixture()
    const first = await freezeLaneCandidate(firstValue.input)
    const path = candidateReceiptPath(firstValue.input.labDirectory, firstValue.input.assignmentId)
    const extended = { ...JSON.parse(await readFile(path, 'utf8')), confidence: 1 }
    await writeFile(path, JSON.stringify(extended), 'utf8')
    await expect(freezeLaneCandidate(firstValue.input)).rejects.toMatchObject({
      name: 'CandidateSnapshotError',
      code: 'RECEIPT_CORRUPT',
    } satisfies Partial<CandidateSnapshotError>)

    const secondValue = await fixture()
    const second = await freezeLaneCandidate(secondValue.input)
    const unrelated = await git(secondValue.repositoryPath, ['rev-parse', 'HEAD'])
    await git(secondValue.worktreePath, ['update-ref', second.gitRef, unrelated, second.candidateSha])
    await expect(freezeLaneCandidate(secondValue.input)).rejects.toMatchObject({
      name: 'CandidateSnapshotError',
      code: 'RECEIPT_CORRUPT',
    } satisfies Partial<CandidateSnapshotError>)
  })

  it('rejects non-Git object-id lengths and captures Git bytes without a generated diff artifact', async () => {
    const value = await fixture()
    await expect(freezeLaneCandidate({
      ...value.input,
      expectedBaseSha: 'a'.repeat(41),
    })).rejects.toMatchObject({
      name: 'CandidateSnapshotError',
      code: 'INVALID_INPUT',
    } satisfies Partial<CandidateSnapshotError>)

    await writeFile(join(value.worktreePath, '.gitattributes'), '*.txt diff=autolab-test\n', 'utf8')
    await git(value.worktreePath, ['config', 'diff.autolab-test.textconv', 'wc -c'])
    const receipt = await freezeLaneCandidate(value.input)
    expect(await git(value.worktreePath, ['show', `${receipt.candidateSha}:tracked.txt`])).toBe('candidate')
    await expect(readCandidateChangedPaths(receipt)).resolves.toEqual([
      '.gitattributes',
      'new.txt',
      'tracked.txt',
    ])
  })
})
