import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import type {
  SubprocessHandle,
  SubprocessRuntime,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it } from 'vitest'

import {
  adoptLocalTmuxAttempt,
  compileLocalTmuxLaunch,
  createSubprocessLocalTmuxPlatform,
  inspectLocalTmuxAttempt,
  launchLocalTmuxAttempt,
  resolveLocalAttemptWrapperPath,
  type LocalProcessInspection,
  type LocalTmuxLaunchPlan,
  type LocalTmuxPlatform,
  type StartedAttemptReceipt,
} from '../src/runner.js'
import { canonicalJson, sha256 } from '../src/integrity.js'
import { createPokeServer } from 'dsh-local-session-messaging/core'

const execFileAsync = promisify(execFile)
const realTmuxAvailable = await execFileAsync('tmux', ['-V']).then(
  () => true,
  () => false,
)
const wrapperPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'attempt-wrapper.mjs',
)
const roots: string[] = []

class FakePlatform implements LocalTmuxPlatform {
  available = true
  present = false
  paneId: string | undefined
  panePid: number | undefined
  launchNonce: string | undefined
  launchIdentityHash: string | undefined
  readonly processes = new Map<number, LocalProcessInspection>()
  readonly launchCalls: Array<{ plan: LocalTmuxLaunchPlan; wrapperPath: string }> = []
  readonly checkoutChecks: Array<{ cwd: string; candidateSha: string }> = []

  async inspectTmux(): Promise<{
    available: boolean
    present: boolean
    paneId?: string
    panePid?: number
    launchNonce?: string
    launchIdentityHash?: string
  }> {
    return {
      available: this.available,
      present: this.present,
      ...(this.paneId === undefined ? {} : { paneId: this.paneId }),
      ...(this.panePid === undefined ? {} : { panePid: this.panePid }),
      ...(this.launchNonce === undefined ? {} : { launchNonce: this.launchNonce }),
      ...(this.launchIdentityHash === undefined ? {} : {
        launchIdentityHash: this.launchIdentityHash,
      }),
    }
  }

  async launchTmux(input: {
    plan: LocalTmuxLaunchPlan
    wrapperPath: string
  }): Promise<'created' | 'exists'> {
    this.launchCalls.push(input)
    if (this.present) return 'exists'
    this.present = true
    this.paneId = '%1'
    this.panePid = 999_001
    this.launchNonce = input.plan.launchNonce
    this.launchIdentityHash = input.plan.launchIdentityHash
    return 'created'
  }

  async inspectProcess(pid: number): Promise<LocalProcessInspection> {
    return this.processes.get(pid) ?? { status: 'dead' }
  }

  async verifyDetachedCheckout(cwd: string, candidateSha: string): Promise<void> {
    this.checkoutChecks.push({ cwd, candidateSha })
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-autolab-runner-')))
  roots.push(root)
  return root
}

function planInput(root: string, overrides: Partial<{
  attemptId: string
  launchNonce: string
  candidateSha: string
  command: readonly string[]
  env: Readonly<Record<string, string>>
  cwd: string
  attemptDirectory: string
  runtimePokeFile: string
}> = {}) {
  return {
    attemptId: overrides.attemptId ?? 'attempt-lane-a-trial-1-run-1',
    launchNonce: overrides.launchNonce ?? '00000000-0000-4000-8000-000000000111',
    candidateSha: overrides.candidateSha ?? 'a'.repeat(40),
    cwd: overrides.cwd ?? root,
    attemptDirectory: overrides.attemptDirectory ?? join(root, 'attempt'),
    command: overrides.command ?? [process.execPath, '-e', 'process.stdout.write("done")'],
    env: overrides.env ?? { AUTOLAB_TEST: '1' },
    ...(overrides.runtimePokeFile === undefined
      ? {}
      : { runtimePokeFile: overrides.runtimePokeFile }),
    issuedAt: 1_786_732_800_000,
  }
}

describe('local tmux Attempt runner', () => {
  it('resolves the packaged wrapper through the installed module location', async () => {
    await expect(resolveLocalAttemptWrapperPath()).resolves.toBe(await realpath(wrapperPath))
  })

  it('compiles one deterministic, hash-bound launch identity without fake process fields', async () => {
    const root = await temporaryRoot()
    const first = compileLocalTmuxLaunch(planInput(root, {
      env: { Z_VALUE: 'last', A_VALUE: 'first' },
    }))
    const second = compileLocalTmuxLaunch(planInput(root, {
      env: { A_VALUE: 'first', Z_VALUE: 'last' },
    }))

    expect(second).toEqual(first)
    expect(first.tmuxSession).toMatch(/^autolab-[0-9a-f]{32}$/u)
    expect(first.launchIdentityHash).toMatch(/^[0-9a-f]{64}$/u)
    expect(first.commandHash).toMatch(/^[0-9a-f]{64}$/u)
    expect(first.cwdHash).toMatch(/^[0-9a-f]{64}$/u)
    expect(first.envHash).toMatch(/^[0-9a-f]{64}$/u)
    expect(first.paths).toEqual({
      launch: join(root, 'attempt', 'launch.json'),
      started: join(root, 'attempt', 'started.json'),
      exit: join(root, 'attempt', 'exit.json'),
      log: join(root, 'attempt', 'attempt.log'),
    })
    expect(first.launchSpec).not.toHaveProperty('pid')
    expect(first.launchSpec).not.toHaveProperty('pgid')
    expect(first.launchSpec).not.toHaveProperty('processStartId')
    expect(first.launchSpec.receiptHash).toMatch(/^[0-9a-f]{64}$/u)
    expect(() => compileLocalTmuxLaunch(planInput(root, {
      candidateSha: 'a'.repeat(41),
    }))).toThrow('invalid candidateSha')
    expect(() => compileLocalTmuxLaunch({
      ...planInput(root),
      runtimePokeFile: `${root}/../not-normalized.json`,
    })).toThrow('runtimePokeFile must be exact and absolute')
  })

  it('binds the optional runtime endpoint pointer into the launch receipt', async () => {
    const root = await temporaryRoot()
    const pointerPath = join(root, 'runtime-poke.json')
    const withPointer = compileLocalTmuxLaunch(planInput(root, {
      runtimePokeFile: pointerPath,
    }))
    const withoutPointer = compileLocalTmuxLaunch(planInput(root))

    expect(withPointer.runtimePokeFile).toBe(pointerPath)
    expect(withPointer.launchSpec.runtimePokeFile).toBe(pointerPath)
    expect(withPointer.launchSpec.receiptHash).not.toBe(withoutPointer.launchSpec.receiptHash)
    expect(withPointer.launchIdentityHash).toBe(withoutPointer.launchIdentityHash)
  })

  it('writes one no-clobber launch spec and invokes tmux only from the absent state', async () => {
    const root = await temporaryRoot()
    const plan = compileLocalTmuxLaunch(planInput(root))
    const platform = new FakePlatform()

    const launched = await launchLocalTmuxAttempt(plan, { platform, wrapperPath })
    expect(launched).toMatchObject({ status: 'launching', tmuxPresent: true })
    expect(platform.checkoutChecks).toEqual([{
      cwd: root,
      candidateSha: 'a'.repeat(40),
    }])
    expect(platform.launchCalls).toHaveLength(1)
    expect(JSON.parse(await readFile(plan.paths.launch, 'utf8'))).toEqual(plan.launchSpec)

    const replay = await launchLocalTmuxAttempt(plan, { platform, wrapperPath })
    expect(replay).toMatchObject({ status: 'launching', tmuxPresent: true })
    expect(platform.launchCalls).toHaveLength(1)
  })

  it('treats an exact concurrent launch as normal receipt wait, not a blocker', async () => {
    const root = await temporaryRoot()
    const plan = compileLocalTmuxLaunch(planInput(root))
    const platform = new FakePlatform()
    platform.launchTmux = async (input) => {
      platform.launchCalls.push(input)
      platform.present = true
      platform.paneId = '%8'
      platform.panePid = 999_008
      platform.launchNonce = input.plan.launchNonce
      platform.launchIdentityHash = input.plan.launchIdentityHash
      return 'exists'
    }

    await expect(
      launchLocalTmuxAttempt(plan, { platform, wrapperPath }),
    ).resolves.toMatchObject({ status: 'launching', launchPrepared: true })
    expect(platform.launchCalls).toHaveLength(1)
  })

  it('keeps a temporary tmux launch failure pending and retries the same identity', async () => {
    const root = await temporaryRoot()
    const plan = compileLocalTmuxLaunch(planInput(root))
    const platform = new FakePlatform()
    const originalLaunch = platform.launchTmux.bind(platform)
    let failOnce = true
    platform.launchTmux = async (input) => {
      if (failOnce) {
        failOnce = false
        throw new Error('tmux server temporarily unavailable')
      }
      return await originalLaunch(input)
    }

    await expect(
      launchLocalTmuxAttempt(plan, { platform, wrapperPath }),
    ).resolves.toMatchObject({
      status: 'pending',
      code: 'TMUX_LAUNCH_FAILED',
      message: 'tmux server temporarily unavailable',
    })
    await expect(
      launchLocalTmuxAttempt(plan, { platform, wrapperPath }),
    ).resolves.toMatchObject({ status: 'launching', launchPrepared: true })
    expect(platform.launchCalls).toHaveLength(1)
  })

  it('validates the canonical attempt directory and a canonical regular wrapper before launch', async () => {
    const root = await temporaryRoot()
    const realAttemptDirectory = join(root, 'real-attempt')
    const linkedAttemptDirectory = join(root, 'linked-attempt')
    await mkdir(realAttemptDirectory)
    await symlink(realAttemptDirectory, linkedAttemptDirectory)
    const linkedPlan = compileLocalTmuxLaunch(planInput(root, {
      attemptDirectory: linkedAttemptDirectory,
    }))
    const linkedPlatform = new FakePlatform()

    await expect(
      launchLocalTmuxAttempt(linkedPlan, { platform: linkedPlatform, wrapperPath }),
    ).resolves.toMatchObject({ status: 'pending', code: 'SYSTEM_UNAVAILABLE' })
    expect(linkedPlatform.launchCalls).toHaveLength(0)

    const wrapperLink = join(root, 'attempt-wrapper-link.mjs')
    await symlink(wrapperPath, wrapperLink)
    const regularPlan = compileLocalTmuxLaunch(planInput(root))
    const wrapperPlatform = new FakePlatform()
    await expect(
      launchLocalTmuxAttempt(regularPlan, { platform: wrapperPlatform, wrapperPath: wrapperLink }),
    ).resolves.toMatchObject({ status: 'pending', code: 'SYSTEM_UNAVAILABLE' })
    expect(wrapperPlatform.launchCalls).toHaveLength(0)
  })

  it('blocks a conflicting launch identity without overwriting or spawning', async () => {
    const root = await temporaryRoot()
    const first = compileLocalTmuxLaunch(planInput(root))
    const conflicting = compileLocalTmuxLaunch(planInput(root, {
      launchNonce: '00000000-0000-4000-8000-000000000222',
    }))
    const platform = new FakePlatform()
    await launchLocalTmuxAttempt(first, { platform, wrapperPath })
    const original = await readFile(first.paths.launch, 'utf8')

    platform.present = false
    const result = await launchLocalTmuxAttempt(conflicting, { platform, wrapperPath })
    expect(result).toMatchObject({
      status: 'blocked',
      code: 'IDENTITY_MISMATCH',
    })
    expect(await readFile(first.paths.launch, 'utf8')).toBe(original)
    expect(platform.launchCalls).toHaveLength(1)
  })

  it('rejects a foreign same-name tmux session without trusting its pane PID', async () => {
    const root = await temporaryRoot()
    const plan = compileLocalTmuxLaunch(planInput(root))
    await writeLaunch(plan)
    const platform = new FakePlatform()
    platform.present = true
    platform.paneId = '%91'
    platform.panePid = 91_001
    platform.launchNonce = '00000000-0000-4000-8000-000000000222'
    platform.launchIdentityHash = plan.launchIdentityHash

    await expect(
      inspectLocalTmuxAttempt(plan, { platform }),
    ).resolves.toMatchObject({ status: 'blocked', code: 'TMUX_IDENTITY_MISMATCH' })
  })

  it('wrapper atomically writes exact started, log, and exit receipts and never clobbers them', async () => {
    const { plan } = await runnablePlan({
      command: ['/usr/bin/env'],
    })
    await mkdir(plan.attemptDirectory, { recursive: true })
    await writeFile(plan.paths.launch, `${JSON.stringify(plan.launchSpec)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })

    await runWrapper(plan)
    const startedBytes = await readFile(plan.paths.started, 'utf8')
    const exitBytes = await readFile(plan.paths.exit, 'utf8')
    expect(JSON.parse(startedBytes)).toMatchObject({
      attemptId: plan.attemptId,
      launchNonce: plan.launchNonce,
      candidateSha: plan.candidateSha,
      commandHash: plan.commandHash,
      cwdHash: plan.cwdHash,
      envHash: plan.envHash,
      tmuxSession: plan.tmuxSession,
      tmuxPaneId: '%7',
      pid: expect.any(Number),
      pgid: expect.any(Number),
      processStartId: expect.stringMatching(/^(?:darwin:[0-9]+:[0-9]+|linux:[0-9]+)$/u),
      processCommandHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      hostname: expect.any(String),
      receiptHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    })
    expect(JSON.parse(exitBytes)).toMatchObject({
      attemptId: plan.attemptId,
      launchIdentityHash: plan.launchIdentityHash,
      startedReceiptHash: JSON.parse(startedBytes).receiptHash,
      outcome: 'exited',
      exitCode: 0,
      receiptHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    })
    expect(await readFile(plan.paths.log, 'utf8')).toBe('AUTOLAB_TEST=1\n')

    await expect(
      runWrapper(plan),
    ).rejects.toBeDefined()
    expect(await readFile(plan.paths.started, 'utf8')).toBe(startedBytes)
    expect(await readFile(plan.paths.exit, 'utf8')).toBe(exitBytes)
  })

  it('pokes the latest configured runtime endpoint after started and exit are durable', async () => {
    const base = await runnablePlan()
    const pointerPath = join(base.root, 'runtime-poke.json')
    const socketDirectory = await realpath(await mkdtemp('/tmp/autolab-poke-'))
    roots.push(socketDirectory)
    let startedPokeCount = 0
    let exitPokeCount = 0
    let resolveStartedPoke: (() => void) | undefined
    const startedPoke = new Promise<void>(resolvePromise => {
      resolveStartedPoke = resolvePromise
    })
    const startedServer = await createPokeServer({
      socketDir: socketDirectory,
      socketName: 'started.sock',
      onPoke: () => {
        startedPokeCount += 1
        resolveStartedPoke?.()
      },
    })
    const exitServer = await createPokeServer({
      socketDir: socketDirectory,
      socketName: 'exit.sock',
      onPoke: () => {
        exitPokeCount += 1
      },
    })
    try {
      await writeFile(pointerPath, `${JSON.stringify({
        version: 1,
        socketPath: startedServer.endpoint.socketPath,
      })}\n`, { mode: 0o600 })
      const plan = compileLocalTmuxLaunch(planInput(base.root, {
        cwd: base.plan.cwd,
        attemptDirectory: base.plan.attemptDirectory,
        candidateSha: base.plan.candidateSha,
        runtimePokeFile: pointerPath,
        command: [process.execPath, '-e', 'setTimeout(() => {}, 250)'],
      }))
      await writeLaunch(plan)

      const running = runWrapper(plan)
      await startedPoke
      expect(await readFile(plan.paths.started, 'utf8')).toContain('AUTOLAB_ATTEMPT_STARTED')
      await writeFile(pointerPath, `${JSON.stringify({
        version: 1,
        socketPath: exitServer.endpoint.socketPath,
      })}\n`, { mode: 0o600 })
      await running
      await waitFor(() => exitPokeCount === 1)
      expect(startedPokeCount).toBe(1)
      expect(await readFile(plan.paths.exit, 'utf8')).toContain('AUTOLAB_ATTEMPT_EXIT')
    } finally {
      await Promise.all([startedServer.close(), exitServer.close()])
    }
  })

  it('keeps Attempt completion independent of stale or malformed runtime endpoints', async () => {
    for (const pointerBytes of [
      undefined,
      JSON.stringify({ version: 1, socketPath: '/tmp/autolab-stale-controller.sock' }),
      '{malformed',
    ]) {
      const base = await runnablePlan()
      const pointerPath = join(base.root, 'runtime-poke.json')
      if (pointerBytes !== undefined) {
        await writeFile(pointerPath, `${pointerBytes}\n`, { mode: 0o600 })
      }
      const plan = compileLocalTmuxLaunch(planInput(base.root, {
        cwd: base.plan.cwd,
        attemptDirectory: base.plan.attemptDirectory,
        candidateSha: base.plan.candidateSha,
        runtimePokeFile: pointerPath,
      }))
      await writeLaunch(plan)

      await expect(runWrapper(plan)).resolves.toBeUndefined()
      expect(JSON.parse(await readFile(plan.paths.exit, 'utf8'))).toMatchObject({
        outcome: 'exited',
        exitCode: 0,
      })
    }
  })

  it('does not hash or interpret experiment log contents', async () => {
    const base = await runnablePlan()
    const plan = compileLocalTmuxLaunch(planInput(base.root, {
      cwd: base.plan.cwd,
      attemptDirectory: base.plan.attemptDirectory,
      candidateSha: base.plan.candidateSha,
      command: [
        process.execPath,
        '-e',
        [
          'const fs = require("node:fs");',
          'const path = process.env.AUTOLAB_LOG_PATH;',
          'fs.renameSync(path, path + ".held");',
          'fs.writeFileSync(path, "replacement\\n");',
          'process.stdout.write("held-handle\\n");',
        ].join(''),
      ],
      env: { AUTOLAB_LOG_PATH: base.plan.paths.log },
    }))
    await writeLaunch(plan)

    await runWrapper(plan)
    const exit = JSON.parse(await readFile(plan.paths.exit, 'utf8')) as Record<string, unknown>
    expect(await readFile(`${plan.paths.log}.held`, 'utf8')).toBe('held-handle\n')
    expect(await readFile(plan.paths.log, 'utf8')).toBe('replacement\n')
    expect(exit).not.toHaveProperty('logSha256')
    await expect(
      inspectLocalTmuxAttempt(plan, { platform: new FakePlatform() }),
    ).resolves.toMatchObject({ status: 'completed' })
  })

  it('refuses to create started or log receipts when invoked outside its exact tmux pane', async () => {
    const { plan } = await runnablePlan()
    await writeLaunch(plan)

    await expect(
      execFileAsync(process.execPath, [wrapperPath, plan.paths.launch]),
    ).rejects.toBeDefined()
    await expect(readFile(plan.paths.started)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(plan.paths.log)).rejects.toMatchObject({ code: 'ENOENT' })

    await expect(
      runWrapper(plan, { launchIdentityHash: 'b'.repeat(64) }),
    ).rejects.toBeDefined()
    await expect(readFile(plan.paths.started)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(plan.paths.log)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('never treats a no-clobber log without started.json as absent or restartable', async () => {
    const root = await temporaryRoot()
    const plan = compileLocalTmuxLaunch(planInput(root))
    await writeLaunch(plan)
    await writeFile(plan.paths.log, '')
    const platform = new FakePlatform()

    await expect(
      inspectLocalTmuxAttempt(plan, { platform }),
    ).resolves.toMatchObject({
      status: 'outcome_unknown',
      reason: 'attempt log exists but started.json and the tmux handle are absent',
    })
    await expect(
      launchLocalTmuxAttempt(plan, { platform, wrapperPath }),
    ).resolves.toMatchObject({
      status: 'outcome_unknown',
      reason: 'attempt log exists but started.json and the tmux handle are absent',
    })
    expect(platform.launchCalls).toHaveLength(0)
  })

  it('rejects final symlinks, FIFOs, and other non-regular receipt or log files', async () => {
    const launchRoot = await temporaryRoot()
    const launchPlan = compileLocalTmuxLaunch(planInput(launchRoot))
    await mkdir(launchPlan.attemptDirectory)
    const launchTarget = join(launchRoot, 'launch-target.json')
    await writeFile(launchTarget, `${JSON.stringify(launchPlan.launchSpec)}\n`)
    await symlink(launchTarget, launchPlan.paths.launch)
    await expect(
      inspectLocalTmuxAttempt(launchPlan, { platform: new FakePlatform() }),
    ).resolves.toMatchObject({ status: 'blocked', code: 'RECEIPT_CORRUPT' })

    const startedRoot = await temporaryRoot()
    const startedPlan = compileLocalTmuxLaunch(planInput(startedRoot))
    await writeLaunch(startedPlan)
    await execFileAsync('mkfifo', [startedPlan.paths.started])
    await expect(
      inspectLocalTmuxAttempt(startedPlan, { platform: new FakePlatform() }),
    ).resolves.toMatchObject({ status: 'blocked', code: 'RECEIPT_CORRUPT' })

    const wrapperRoot = await temporaryRoot()
    const wrapperPlan = compileLocalTmuxLaunch(planInput(wrapperRoot))
    await mkdir(wrapperPlan.attemptDirectory)
    await execFileAsync('mkfifo', [wrapperPlan.paths.launch])
    await expect(
      execFileAsync(process.execPath, [wrapperPath, wrapperPlan.paths.launch]),
    ).rejects.toBeDefined()

    const logRoot = await temporaryRoot()
    const logPlan = compileLocalTmuxLaunch(planInput(logRoot))
    await writeLaunch(logPlan)
    await mkdir(logPlan.paths.log)
    await expect(
      inspectLocalTmuxAttempt(logPlan, { platform: new FakePlatform() }),
    ).resolves.toMatchObject({ status: 'blocked', code: 'RECEIPT_CORRUPT' })

    const { plan: exitPlan } = await runnablePlan()
    await materializeCompletedFixture(exitPlan)
    const exitTarget = join(exitPlan.attemptDirectory, 'exit-target.json')
    await rm(exitPlan.paths.exit)
    await writeFile(exitTarget, '{}\n')
    await symlink(exitTarget, exitPlan.paths.exit)
    await expect(
      inspectLocalTmuxAttempt(exitPlan, { platform: new FakePlatform() }),
    ).resolves.toMatchObject({ status: 'blocked', code: 'RECEIPT_CORRUPT' })
  })

  it('adopts only a strictly matching live process, with or without its tmux handle', async () => {
    const { plan } = await runnablePlan()
    await materializeCompletedFixture(plan)
    await rm(plan.paths.exit)
    const started = JSON.parse(await readFile(plan.paths.started, 'utf8')) as StartedAttemptReceipt
    const platform = new FakePlatform()
    bindFakeTmux(platform, plan, started)
    platform.processes.set(started.pid, matchingProcess(started, plan))

    const adopted = await adoptLocalTmuxAttempt(plan, { platform })
    expect(adopted).toMatchObject({
      status: 'running',
      tmuxPresent: true,
      started: { receiptHash: started.receiptHash },
    })

    platform.present = false
    platform.paneId = undefined
    platform.panePid = undefined
    const withoutTmux = await adoptLocalTmuxAttempt(plan, { platform })
    expect(withoutTmux).toMatchObject({
      status: 'running',
      tmuxPresent: false,
      started: { receiptHash: started.receiptHash },
    })
  })

  it('keeps an absent adoption pending instead of creating a replacement', async () => {
    const root = await temporaryRoot()
    const plan = compileLocalTmuxLaunch(planInput(root))
    const platform = new FakePlatform()

    await expect(adoptLocalTmuxAttempt(plan, { platform })).resolves.toMatchObject({
      status: 'pending',
      code: 'ATTEMPT_NOT_FOUND',
    })
    expect(platform.launchCalls).toHaveLength(0)
  })

  it('keeps a temporarily unreadable process identity pending and then adopts it', async () => {
    const { plan } = await runnablePlan()
    await materializeCompletedFixture(plan)
    await rm(plan.paths.exit)
    const started = JSON.parse(await readFile(plan.paths.started, 'utf8')) as StartedAttemptReceipt
    const platform = new FakePlatform()
    platform.processes.set(started.pid, { status: 'unknown' })

    await expect(inspectLocalTmuxAttempt(plan, { platform })).resolves.toMatchObject({
      status: 'pending',
      code: 'PROCESS_IDENTITY_UNKNOWN',
    })

    platform.processes.set(started.pid, matchingProcess(started, plan))
    await expect(adoptLocalTmuxAttempt(plan, { platform })).resolves.toMatchObject({
      status: 'running',
      tmuxPresent: false,
      started: { receiptHash: started.receiptHash },
    })
  })

  it('blocks PID reuse from the numeric process start snapshot', async () => {
    const { plan } = await runnablePlan()
    await materializeCompletedFixture(plan)
    await rm(plan.paths.exit)
    const started = JSON.parse(await readFile(plan.paths.started, 'utf8')) as StartedAttemptReceipt
    const platform = new FakePlatform()
    bindFakeTmux(platform, plan, started)
    platform.processes.set(started.pid, {
      ...matchingProcess(started, plan),
      processStartId: process.platform === 'darwin' ? 'darwin:1:1' : 'linux:1',
    })

    const result = await inspectLocalTmuxAttempt(plan, { platform })
    expect(result).toMatchObject({
      status: 'blocked',
      code: 'PROCESS_IDENTITY_MISMATCH',
    })
  })

  it('blocks boot and live wrapper command mismatches from the same process identity', async () => {
    const { plan } = await runnablePlan()
    await materializeCompletedFixture(plan)
    await rm(plan.paths.exit)
    const started = JSON.parse(await readFile(plan.paths.started, 'utf8')) as StartedAttemptReceipt
    const platform = new FakePlatform()
    const matching = matchingProcess(started, plan)

    platform.processes.set(started.pid, { ...matching, bootId: `${started.bootId}:foreign` })
    await expect(
      inspectLocalTmuxAttempt(plan, { platform }),
    ).resolves.toMatchObject({ status: 'blocked', code: 'PROCESS_IDENTITY_MISMATCH' })

    platform.processes.set(started.pid, {
      ...matching,
      argv: [process.execPath, wrapperPath, `${plan.paths.launch}.foreign`],
    })
    await expect(
      inspectLocalTmuxAttempt(plan, { platform }),
    ).resolves.toMatchObject({ status: 'blocked', code: 'PROCESS_IDENTITY_MISMATCH' })
  })

  it('returns completed only from a valid exit receipt and otherwise preserves outcome_unknown', async () => {
    const { plan } = await runnablePlan()
    await materializeCompletedFixture(plan)
    const platform = new FakePlatform()

    const completed = await inspectLocalTmuxAttempt(plan, { platform })
    expect(completed).toMatchObject({
      status: 'completed',
      exit: { outcome: 'exited', exitCode: 0 },
    })

    await rm(plan.paths.exit)
    const unknown = await inspectLocalTmuxAttempt(plan, { platform })
    expect(unknown).toMatchObject({
      status: 'outcome_unknown',
      reason: 'started process is no longer present and no exit receipt exists',
    })
  })

  it('requires monotonic receipt time before completed', async () => {
    const nonMonotonic = await runnablePlan()
    await materializeCompletedFixture(nonMonotonic.plan)
    const started = JSON.parse(
      await readFile(nonMonotonic.plan.paths.started, 'utf8'),
    ) as StartedAttemptReceipt
    const originalExit = JSON.parse(
      await readFile(nonMonotonic.plan.paths.exit, 'utf8'),
    ) as Record<string, unknown>
    const { receiptHash: _receiptHash, ...exitWithoutHash } = originalExit
    const invalidExitWithoutHash = {
      ...exitWithoutHash,
      finishedAt: started.startedAt - 1,
    }
    await writeFile(nonMonotonic.plan.paths.exit, `${JSON.stringify({
      ...invalidExitWithoutHash,
      receiptHash: sha256(
        `autolab-local-tmux-exit-v1\0${canonicalJson(invalidExitWithoutHash)}`,
      ),
    })}\n`)
    await expect(
      inspectLocalTmuxAttempt(nonMonotonic.plan, { platform: new FakePlatform() }),
    ).resolves.toMatchObject({ status: 'blocked', code: 'RECEIPT_CORRUPT' })
  })

  it('keeps an unavailable tmux inspection pending and resumes when it recovers', async () => {
    const root = await temporaryRoot()
    const plan = compileLocalTmuxLaunch(planInput(root))
    const platform = new FakePlatform()
    platform.available = false

    const inspected = await inspectLocalTmuxAttempt(plan, { platform })
    expect(inspected).toMatchObject({ status: 'pending', code: 'SYSTEM_UNAVAILABLE' })
    await expect(
      launchLocalTmuxAttempt(plan, { platform, wrapperPath }),
    ).resolves.toMatchObject({ status: 'pending', code: 'SYSTEM_UNAVAILABLE' })
    expect(platform.launchCalls).toHaveLength(0)

    platform.available = true
    await expect(
      launchLocalTmuxAttempt(plan, { platform, wrapperPath }),
    ).resolves.toMatchObject({ status: 'launching' })
    expect(platform.launchCalls).toHaveLength(1)
  })

  it('keeps a tmux display inspection failure mechanically retryable', async () => {
    const runtime = {
      resolveExecutable: async (command: string) => `/managed/bin/${command}`,
      spawn: (spec: SubprocessSpawnSpec): SubprocessHandle => (
        spec.argv[1] === 'display-message'
          ? completedSubprocessHandle(2, '', 'tmux server temporarily unavailable')
          : completedSubprocessHandle(0)
      ),
    } satisfies Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'>
    const platform = createSubprocessLocalTmuxPlatform(runtime)
    const root = await temporaryRoot()
    const plan = compileLocalTmuxLaunch(planInput(root))

    await expect(platform.inspectTmux(plan.tmuxSession)).resolves.toEqual({
      available: false,
      present: true,
    })
    await expect(
      inspectLocalTmuxAttempt(plan, { platform }),
    ).resolves.toMatchObject({ status: 'pending', code: 'SYSTEM_UNAVAILABLE' })
  })

  it.skipIf(!realTmuxAvailable)('launches and completes through a real identity-bound tmux session', async () => {
    const { plan } = await runnablePlan()
    try {
      let inspected = await launchLocalTmuxAttempt(plan, { wrapperPath })
      for (let index = 0;
        index < 100 && (inspected.status === 'launching' || inspected.status === 'running');
        index += 1) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 20))
        inspected = await inspectLocalTmuxAttempt(plan)
      }
      if (inspected.status !== 'completed') throw new Error(JSON.stringify(inspected))
      expect(inspected).toMatchObject({
        status: 'completed',
        started: {
          tmuxPaneId: expect.stringMatching(/^%[0-9]+$/u),
          processCommandHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        },
      })
    } finally {
      await execFileAsync('tmux', ['kill-session', '-t', `=${plan.tmuxSession}`]).catch(() => undefined)
    }
  })
})

async function materializeCompletedFixture(plan: LocalTmuxLaunchPlan): Promise<void> {
  await writeLaunch(plan)
  await runWrapper(plan)
}

async function runWrapper(
  plan: LocalTmuxLaunchPlan,
  overrides: Partial<{
    tmuxSession: string
    launchNonce: string
    launchIdentityHash: string
  }> = {},
): Promise<void> {
  const binDirectory = join(plan.attemptDirectory, '.test-bin')
  const fakeTmuxPath = join(binDirectory, 'tmux')
  await mkdir(binDirectory, { recursive: true })
  await writeFile(fakeTmuxPath, [
    `#!${process.execPath}`,
    'const fields = [',
    '  process.env.AUTOLAB_TEST_TMUX_SESSION,',
    '  process.env.TMUX_PANE,',
    '  String(process.ppid),',
    '  process.env.AUTOLAB_TMUX_LAUNCH_NONCE,',
    '  process.env.AUTOLAB_TMUX_LAUNCH_IDENTITY_HASH,',
    '];',
    'process.stdout.write(`${fields.join("\\t")}\\n`);',
    '',
  ].join('\n'), { mode: 0o700 })
  await chmod(fakeTmuxPath, 0o700)
  await execFileAsync(process.execPath, [wrapperPath, plan.paths.launch], {
    env: {
      ...process.env,
      PATH: `${binDirectory}:${process.env.PATH ?? ''}`,
      TMUX: 'test-socket,1,0',
      TMUX_PANE: '%7',
      AUTOLAB_TEST_TMUX_SESSION: overrides.tmuxSession ?? plan.tmuxSession,
      AUTOLAB_TMUX_LAUNCH_NONCE: overrides.launchNonce ?? plan.launchNonce,
      AUTOLAB_TMUX_LAUNCH_IDENTITY_HASH: overrides.launchIdentityHash
        ?? plan.launchIdentityHash,
    },
  })
}

async function writeLaunch(plan: LocalTmuxLaunchPlan): Promise<void> {
  await mkdir(plan.attemptDirectory, { recursive: true })
  await writeFile(plan.paths.launch, `${JSON.stringify(plan.launchSpec)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  })
}

async function runnablePlan(
  overrides: Parameters<typeof planInput>[1] = {},
): Promise<{ root: string; plan: LocalTmuxLaunchPlan }> {
  const root = await temporaryRoot()
  const cwd = join(root, 'checkout')
  await mkdir(cwd)
  await execFileAsync('git', ['init', '--quiet', cwd])
  await writeFile(join(cwd, 'fixture.txt'), 'fixture\n')
  await execFileAsync('git', ['-C', cwd, 'add', 'fixture.txt'])
  await execFileAsync('git', [
    '-C', cwd,
    '-c', 'user.name=AutoLab Test',
    '-c', 'user.email=autolab@example.invalid',
    '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '-m', 'fixture',
  ])
  const revision = await execFileAsync('git', ['-C', cwd, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  })
  const candidateSha = revision.stdout.trim()
  await execFileAsync('git', ['-C', cwd, 'checkout', '--quiet', '--detach', candidateSha])
  return {
    root,
    plan: compileLocalTmuxLaunch(planInput(root, {
      ...overrides,
      cwd,
      attemptDirectory: join(root, 'attempt'),
      candidateSha,
    })),
  }
}

function matchingProcess(
  started: StartedAttemptReceipt,
  plan: LocalTmuxLaunchPlan,
): Extract<LocalProcessInspection, { status: 'alive' }> {
  return {
    status: 'alive',
    pid: started.pid,
    pgid: started.pgid,
    processStartId: started.processStartId,
    executablePath: process.execPath,
    argv: [process.execPath, wrapperPath, plan.paths.launch],
    hostname: started.hostname,
    bootId: started.bootId,
  }
}

function bindFakeTmux(
  platform: FakePlatform,
  plan: LocalTmuxLaunchPlan,
  started: StartedAttemptReceipt,
): void {
  platform.present = true
  platform.paneId = started.tmuxPaneId
  platform.panePid = started.pid
  platform.launchNonce = plan.launchNonce
  platform.launchIdentityHash = plan.launchIdentityHash
}

function completedSubprocessHandle(
  exitCode: number,
  stdout = '',
  stderr = '',
): SubprocessHandle {
  const output = (value: string) => ({
    readFrom: (fromByte: number) => ({
      text: fromByte === 0 ? value : '',
      nextOffset: Buffer.byteLength(value, 'utf8'),
      lossy: false,
    }),
  })
  return {
    pid: 901,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: { stdout: output(stdout), stderr: output(stderr) },
    done: Promise.resolve({ exitCode, signal: null }),
    terminate: () => undefined,
    waitForExit: async () => true,
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
  }
  throw new Error('timed out waiting for condition')
}
