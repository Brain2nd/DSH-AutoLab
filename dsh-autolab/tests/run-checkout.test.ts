import { execFile } from 'node:child_process'
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import {
  inspectDetachedRunCheckout,
  provisionDetachedRunCheckout,
  runCheckoutReceiptSchema,
} from '../src/run-checkout.js'
import { canonicalJson, sha256 } from '../src/integrity.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []

async function fixture(): Promise<{
  root: string
  repository: string
  checkoutPath: string
  candidateSha: string
}> {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'dsh-autolab-run-checkout-'))
  roots.push(root)
  const repository = join(root, 'repository')
  const checkoutPath = join(root, 'attempts', 'attempt-1', 'checkout')
  await mkdir(repository)
  await git(repository, ['init'])
  await git(repository, ['config', 'user.email', 'autolab@example.invalid'])
  await git(repository, ['config', 'user.name', 'AutoLab Test'])
  await writeFile(join(repository, 'candidate.txt'), 'candidate\n')
  await git(repository, ['add', 'candidate.txt'])
  await git(repository, ['commit', '-m', 'candidate'])
  const candidateSha = await git(repository, ['rev-parse', 'HEAD'])
  return { root, repository, checkoutPath, candidateSha }
}

function input(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    repositoryPath: f.repository,
    checkoutPath: f.checkoutPath,
    candidateSha: f.candidateSha,
    attemptId: 'attempt-1',
    now: 123,
  } as const
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('detached Attempt checkout', () => {
  it('creates once and adopts the exact clean detached checkout on replay', async () => {
    const f = await fixture()
    const created = await provisionDetachedRunCheckout(input(f))
    const replayed = await provisionDetachedRunCheckout({ ...input(f), now: 999 })

    expect(replayed).toEqual(created)
    expect(await git(f.checkoutPath, ['rev-parse', 'HEAD'])).toBe(f.candidateSha)
    expect(await git(f.checkoutPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD')
    expect(await git(f.checkoutPath, ['status', '--porcelain=v1', '--untracked-files=normal'])).toBe('')
    const receiptBytes = await readFile(created.receiptPath)
    expect(created.receiptSha256).toBe(sha256(receiptBytes))
    expect(canonicalJson(runCheckoutReceiptSchema.parse(JSON.parse(receiptBytes.toString('utf8')))))
      .toBe(receiptBytes.toString('utf8'))
  })

  it('inspects launched checkout identity without treating experiment writes as drift', async () => {
    const f = await fixture()
    const frozen = await provisionDetachedRunCheckout(input(f))
    await writeFile(join(f.checkoutPath, 'candidate.txt'), 'experiment modified this file\n')
    await writeFile(join(f.checkoutPath, 'result.json'), '{"metric":1}\n')

    const inspected = await inspectDetachedRunCheckout({
      repositoryPath: f.repository,
      checkoutPath: f.checkoutPath,
      candidateSha: f.candidateSha,
      attemptId: 'attempt-1',
      receiptPath: frozen.receiptPath,
      receiptSha256: frozen.receiptSha256,
    })
    expect(inspected).toEqual(frozen)
    await expect(provisionDetachedRunCheckout(input(f)))
      .rejects.toMatchObject({ code: 'IDENTITY_DRIFT' })
  })

  it('requires the externally frozen receipt hash during post-launch inspection', async () => {
    const wrongHash = await fixture()
    const wrongHashFrozen = await provisionDetachedRunCheckout(input(wrongHash))
    await expect(inspectDetachedRunCheckout({
      repositoryPath: wrongHash.repository,
      checkoutPath: wrongHash.checkoutPath,
      candidateSha: wrongHash.candidateSha,
      attemptId: 'attempt-1',
      receiptPath: wrongHashFrozen.receiptPath,
      receiptSha256: '0'.repeat(64),
    })).rejects.toMatchObject({ code: 'IDENTITY_DRIFT' })

    const corrupt = await fixture()
    const corruptFrozen = await provisionDetachedRunCheckout(input(corrupt))
    await writeFile(corruptFrozen.receiptPath, '{}')
    await expect(inspectDetachedRunCheckout({
      repositoryPath: corrupt.repository,
      checkoutPath: corrupt.checkoutPath,
      candidateSha: corrupt.candidateSha,
      attemptId: 'attempt-1',
      receiptPath: corruptFrozen.receiptPath,
      receiptSha256: corruptFrozen.receiptSha256,
    })).rejects.toMatchObject({ code: 'IDENTITY_DRIFT' })
  })

  it('rejects post-launch HEAD, attached-branch, and repository identity drift', async () => {
    const wrongHead = await fixture()
    const wrongHeadFrozen = await provisionDetachedRunCheckout(input(wrongHead))
    await writeFile(join(wrongHead.repository, 'candidate.txt'), 'next commit\n')
    await git(wrongHead.repository, ['add', 'candidate.txt'])
    await git(wrongHead.repository, ['commit', '-m', 'next'])
    const nextSha = await git(wrongHead.repository, ['rev-parse', 'HEAD'])
    await git(wrongHead.checkoutPath, ['reset', '--hard', nextSha])
    await expect(inspectDetachedRunCheckout({
      repositoryPath: wrongHead.repository,
      checkoutPath: wrongHead.checkoutPath,
      candidateSha: wrongHead.candidateSha,
      attemptId: 'attempt-1',
      receiptPath: wrongHeadFrozen.receiptPath,
      receiptSha256: wrongHeadFrozen.receiptSha256,
    })).rejects.toMatchObject({ code: 'IDENTITY_DRIFT' })

    const attached = await fixture()
    const attachedFrozen = await provisionDetachedRunCheckout(input(attached))
    await git(attached.repository, ['branch', 'launched-branch', attached.candidateSha])
    await git(attached.checkoutPath, ['checkout', 'launched-branch'])
    await expect(inspectDetachedRunCheckout({
      repositoryPath: attached.repository,
      checkoutPath: attached.checkoutPath,
      candidateSha: attached.candidateSha,
      attemptId: 'attempt-1',
      receiptPath: attachedFrozen.receiptPath,
      receiptSha256: attachedFrozen.receiptSha256,
    })).rejects.toMatchObject({ code: 'IDENTITY_DRIFT' })

    const repositoryDrift = await fixture()
    const repositoryFrozen = await provisionDetachedRunCheckout(input(repositoryDrift))
    const foreign = await fixture()
    await rename(repositoryDrift.checkoutPath, `${repositoryDrift.checkoutPath}-original`)
    await git(
      foreign.repository,
      ['worktree', 'add', '--detach', repositoryDrift.checkoutPath, foreign.candidateSha],
    )
    await expect(inspectDetachedRunCheckout({
      repositoryPath: repositoryDrift.repository,
      checkoutPath: repositoryDrift.checkoutPath,
      candidateSha: repositoryDrift.candidateSha,
      attemptId: 'attempt-1',
      receiptPath: repositoryFrozen.receiptPath,
      receiptSha256: repositoryFrozen.receiptSha256,
    })).rejects.toMatchObject({ code: 'IDENTITY_DRIFT' })
  })

  it('coalesces concurrent identical creators so the loser adopts the winner', async () => {
    const f = await fixture()
    const [left, right] = await Promise.all([
      provisionDetachedRunCheckout(input(f)),
      provisionDetachedRunCheckout(input(f)),
    ])
    expect(right).toEqual(left)
    expect(await git(f.repository, ['worktree', 'list', '--porcelain']))
      .toContain(`worktree ${f.checkoutPath}`)
  })

  it('adopts an exact crash-window worktree when the receipt is absent', async () => {
    const f = await fixture()
    await mkdir(join(f.root, 'attempts', 'attempt-1'), { recursive: true })
    await git(f.repository, ['worktree', 'add', '--detach', f.checkoutPath, f.candidateSha])

    const adopted = await provisionDetachedRunCheckout(input(f))
    expect(adopted.headSha).toBe(f.candidateSha)
    expect(JSON.parse(await readFile(adopted.receiptPath, 'utf8'))).toMatchObject({
      attemptId: 'attempt-1',
      candidateSha: f.candidateSha,
      repositoryPath: f.repository,
      checkoutPath: f.checkoutPath,
    })
  })

  it('fails closed on partial, dirty, attached, and wrong-HEAD checkouts', async () => {
    const partial = await fixture()
    await mkdir(partial.checkoutPath, { recursive: true })
    await expect(provisionDetachedRunCheckout(input(partial)))
      .rejects.toMatchObject({ code: 'IDENTITY_DRIFT' })

    const dirty = await fixture()
    await mkdir(join(dirty.root, 'attempts', 'attempt-1'), { recursive: true })
    await git(dirty.repository, ['worktree', 'add', '--detach', dirty.checkoutPath, dirty.candidateSha])
    await writeFile(join(dirty.checkoutPath, 'untracked.txt'), 'dirty\n')
    await expect(provisionDetachedRunCheckout(input(dirty)))
      .rejects.toMatchObject({ code: 'IDENTITY_DRIFT' })

    const attached = await fixture()
    await mkdir(join(attached.root, 'attempts', 'attempt-1'), { recursive: true })
    await git(attached.repository, ['branch', 'attempt-branch', attached.candidateSha])
    await git(attached.repository, ['worktree', 'add', attached.checkoutPath, 'attempt-branch'])
    await expect(provisionDetachedRunCheckout(input(attached)))
      .rejects.toMatchObject({ code: 'IDENTITY_DRIFT' })

    const wrongHead = await fixture()
    await writeFile(join(wrongHead.repository, 'candidate.txt'), 'other\n')
    await git(wrongHead.repository, ['add', 'candidate.txt'])
    await git(wrongHead.repository, ['commit', '-m', 'other'])
    const otherSha = await git(wrongHead.repository, ['rev-parse', 'HEAD'])
    await mkdir(join(wrongHead.root, 'attempts', 'attempt-1'), { recursive: true })
    await git(wrongHead.repository, ['worktree', 'add', '--detach', wrongHead.checkoutPath, otherSha])
    await expect(provisionDetachedRunCheckout(input(wrongHead)))
      .rejects.toMatchObject({ code: 'IDENTITY_DRIFT' })
  })

  it('rejects checkout repository identity drift without deleting the foreign directory', async () => {
    const f = await fixture()
    const foreign = await fixture()
    await mkdir(join(f.root, 'attempts', 'attempt-1'), { recursive: true })
    await git(foreign.repository, ['worktree', 'add', '--detach', f.checkoutPath, foreign.candidateSha])

    await expect(provisionDetachedRunCheckout(input(f)))
      .rejects.toMatchObject({ code: 'IDENTITY_DRIFT' })
    expect(await readFile(join(f.checkoutPath, 'candidate.txt'), 'utf8')).toBe('candidate\n')
  })

  it('fails closed when receipt bytes or requested identity drift', async () => {
    const corrupt = await fixture()
    const created = await provisionDetachedRunCheckout(input(corrupt))
    await writeFile(created.receiptPath, '{}')
    await expect(provisionDetachedRunCheckout(input(corrupt)))
      .rejects.toMatchObject({ code: 'IDENTITY_DRIFT' })

    const conflicting = await fixture()
    await provisionDetachedRunCheckout(input(conflicting))
    await expect(provisionDetachedRunCheckout({
      ...input(conflicting),
      attemptId: 'attempt-2',
    })).rejects.toMatchObject({ code: 'IDENTITY_DRIFT' })
  })

  it('rejects receipt symlinks and FIFOs promptly through one nonblocking descriptor', async () => {
    const linked = await fixture()
    const linkedCreated = await provisionDetachedRunCheckout(input(linked))
    const target = join(linked.root, 'receipt-target.json')
    await writeFile(target, await readFile(linkedCreated.receiptPath))
    await unlink(linkedCreated.receiptPath)
    await symlink(target, linkedCreated.receiptPath)
    await expect(provisionDetachedRunCheckout(input(linked)))
      .rejects.toMatchObject({ code: 'IDENTITY_DRIFT' })

    const fifo = await fixture()
    const fifoCreated = await provisionDetachedRunCheckout(input(fifo))
    await unlink(fifoCreated.receiptPath)
    await execFileAsync('mkfifo', [fifoCreated.receiptPath])
    await expect(provisionDetachedRunCheckout(input(fifo)))
      .rejects.toMatchObject({ code: 'IDENTITY_DRIFT' })
  })

  it('rejects a checkout symlink and distinguishes ordinary Git and I/O failures', async () => {
    const linked = await fixture()
    const created = await provisionDetachedRunCheckout(input(linked))
    const moved = `${linked.checkoutPath}-moved`
    await rename(linked.checkoutPath, moved)
    await symlink(moved, linked.checkoutPath)
    await expect(provisionDetachedRunCheckout(input(linked)))
      .rejects.toMatchObject({ code: 'IDENTITY_DRIFT' })

    const badCommit = await fixture()
    await expect(provisionDetachedRunCheckout({
      ...input(badCommit),
      candidateSha: '0'.repeat(40),
    })).rejects.toMatchObject({ code: 'GIT_FAILED' })

    const io = await fixture()
    const parentFile = join(io.root, 'receipt-parent')
    await writeFile(parentFile, 'not a directory\n')
    await expect(provisionDetachedRunCheckout({
      ...input(io),
      receiptPath: join(parentFile, 'receipt.json'),
    })).rejects.toMatchObject({ code: 'IO_FAILED' })
  })
})

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  return result.stdout.trim()
}
