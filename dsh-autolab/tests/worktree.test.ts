import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { inspectLaneWorktree, provisionLaneWorktree } from '../src/worktree.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []

async function fixture(): Promise<{
  root: string
  repository: string
  labDirectory: string
  baseSha: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-autolab-worktree-'))
  roots.push(root)
  const repository = join(root, 'repository')
  const labDirectory = join(root, 'lab')
  await Promise.all([mkdir(repository), mkdir(join(labDirectory, 'receipts'), { recursive: true })])
  await git(repository, ['init'])
  await git(repository, ['config', 'user.email', 'autolab@example.invalid'])
  await git(repository, ['config', 'user.name', 'AutoLab Test'])
  await writeFile(join(repository, 'README.md'), '# base\n')
  await git(repository, ['add', 'README.md'])
  await git(repository, ['commit', '-m', 'base'])
  const baseSha = await git(repository, ['rev-parse', 'HEAD'])
  return { root, repository, labDirectory, baseSha }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Lane worktree provisioning', () => {
  it('creates independent long-lived worktrees for lanes without a GPU coupling', async () => {
    const f = await fixture()
    const laneAPath = join(f.root, 'worktrees', 'lane-a')
    const laneBPath = join(f.root, 'worktrees', 'lane-b')
    const [laneA, laneB] = await Promise.all([
      provisionLaneWorktree({
        labId: 'lab-test',
        laneId: 'lane-a',
        labDirectory: f.labDirectory,
        repositoryPath: f.repository,
        worktreePath: laneAPath,
        baseRef: f.baseSha,
        now: 1,
      }),
      provisionLaneWorktree({
        labId: 'lab-test',
        laneId: 'lane-b',
        labDirectory: f.labDirectory,
        repositoryPath: f.repository,
        worktreePath: laneBPath,
        baseRef: f.baseSha,
        now: 1,
      }),
    ])

    expect(laneA.receipt.worktreePath).not.toBe(laneB.receipt.worktreePath)
    expect(laneA.currentHeadSha).toBe(f.baseSha)
    expect(laneB.currentHeadSha).toBe(f.baseSha)
    expect(await readFile(join(laneAPath, 'README.md'), 'utf8')).toBe('# base\n')
    expect((await inspectLaneWorktree(f.labDirectory, 'lane-a')).receipt).toEqual(laneA.receipt)
  })

  it('adopts only the exact clean crash-window worktree when no receipt exists', async () => {
    const f = await fixture()
    const worktreePath = join(f.root, 'worktrees', 'lane-a')
    await mkdir(join(f.root, 'worktrees'))
    await git(f.repository, ['worktree', 'add', '--detach', worktreePath, f.baseSha])

    const adopted = await provisionLaneWorktree({
      labId: 'lab-test',
      laneId: 'lane-a',
      labDirectory: f.labDirectory,
      repositoryPath: f.repository,
      worktreePath,
      baseRef: f.baseSha,
      now: 2,
    })
    expect(adopted.currentHeadSha).toBe(f.baseSha)

    const otherPath = join(f.root, 'worktrees', 'lane-b')
    await git(f.repository, ['worktree', 'add', '--detach', otherPath, f.baseSha])
    await writeFile(join(otherPath, 'dirty.txt'), 'not an adoptable crash window\n')
    await expect(provisionLaneWorktree({
      labId: 'lab-test',
      laneId: 'lane-b',
      labDirectory: f.labDirectory,
      repositoryPath: f.repository,
      worktreePath: otherPath,
      baseRef: f.baseSha,
    })).rejects.toMatchObject({ code: 'WORKTREE_CONFLICT' })
  })

  it('keeps recovery identity valid after the Lane advances or has edits', async () => {
    const f = await fixture()
    const worktreePath = join(f.root, 'worktrees', 'lane-a')
    await provisionLaneWorktree({
      labId: 'lab-test',
      laneId: 'lane-a',
      labDirectory: f.labDirectory,
      repositoryPath: f.repository,
      worktreePath,
      baseRef: f.baseSha,
      now: 3,
    })
    await writeFile(join(worktreePath, 'candidate.ts'), 'export const candidate = 1\n')

    const recovered = await provisionLaneWorktree({
      labId: 'lab-test',
      laneId: 'lane-a',
      labDirectory: f.labDirectory,
      repositoryPath: f.repository,
      worktreePath,
      baseRef: f.baseSha,
      now: 99,
    })
    expect(recovered.receipt.createdAt).toBe(3)
    expect(recovered.dirty).toBe(true)
  })

  it('rejects a worktree nested inside the repository or Lab directory', async () => {
    const f = await fixture()
    await expect(provisionLaneWorktree({
      labId: 'lab-test',
      laneId: 'lane-a',
      labDirectory: f.labDirectory,
      repositoryPath: f.repository,
      worktreePath: join(f.repository, 'nested-lane'),
      baseRef: f.baseSha,
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  return result.stdout.trim()
}
