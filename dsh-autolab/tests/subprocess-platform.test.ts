import { join } from 'node:path'

import type {
  SubprocessHandle,
  SubprocessRuntime,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it } from 'vitest'

import {
  compileLocalTmuxLaunch,
  createSubprocessLocalTmuxPlatform,
} from '../src/runner.js'

describe('DSH subprocess local-tmux composition', () => {
  it('uses explicit managed subprocess specs for tmux inspection and launch', async () => {
    const plan = compileLocalTmuxLaunch({
      attemptId: 'attempt-subprocess-seam',
      launchNonce: '00000000-0000-4000-8000-000000000501',
      candidateSha: 'a'.repeat(40),
      cwd: process.cwd(),
      attemptDirectory: join(process.cwd(), 'subprocess-platform-fixture'),
      command: ['node', 'experiment.mjs'],
      env: { EXACT_ENV: '1' },
      issuedAt: 1,
    })
    const calls: SubprocessSpawnSpec[] = []
    let present = false
    const runtime = {
      resolveExecutable: async (command: string) => `/managed/bin/${command}`,
      spawn: (spec: SubprocessSpawnSpec): SubprocessHandle => {
        calls.push(spec)
        const operation = spec.argv[1]
        if (operation === 'new-session') present = true
        const exitCode = operation === 'has-session' && !present ? 1 : 0
        const stdout = operation === 'display-message'
          ? `${plan.tmuxSession}\t%17\t901\t${plan.launchNonce}\t${plan.launchIdentityHash}\n`
          : ''
        return completedHandle(exitCode, stdout)
      },
    } satisfies Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'>
    const shutdown = new AbortController()
    const platform = createSubprocessLocalTmuxPlatform(runtime, shutdown.signal)

    await expect(platform.inspectTmux(plan.tmuxSession)).resolves.toEqual({
      available: true,
      present: false,
    })
    await expect(platform.launchTmux({
      plan,
      wrapperPath: '/managed/autolab/attempt-wrapper.mjs',
    })).resolves.toBe('created')
    await expect(platform.inspectTmux(plan.tmuxSession)).resolves.toMatchObject({
      available: true,
      present: true,
      paneId: '%17',
      panePid: 901,
      launchNonce: plan.launchNonce,
      launchIdentityHash: plan.launchIdentityHash,
    })

    expect(calls).toHaveLength(4)
    for (const spec of calls) {
      expect(spec).toMatchObject({
        argv: expect.arrayContaining(['/managed/bin/tmux']),
        cwd: process.cwd(),
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 1024 * 1024 },
          stderr: { maxBytes: 1024 * 1024 },
        },
        graceMs: 1_000,
        signal: shutdown.signal,
      })
    }
  })

  it('propagates Controller shutdown instead of disguising it as missing tmux', async () => {
    const stopped = new Error('controller stopped')
    const shutdown = new AbortController()
    shutdown.abort(stopped)
    const runtime = {
      resolveExecutable: async (
        _command: string,
        _env?: Readonly<Record<string, string>>,
        signal?: AbortSignal,
      ) => {
        signal?.throwIfAborted()
        return '/managed/bin/tmux'
      },
      spawn: (_spec: SubprocessSpawnSpec): SubprocessHandle => {
        throw new Error('spawn must not run after shutdown')
      },
    } satisfies Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'>
    const platform = createSubprocessLocalTmuxPlatform(runtime, shutdown.signal)

    await expect(platform.inspectTmux('autolab-0123456789abcdef0123456789abcdef'))
      .rejects.toBe(stopped)
  })
})

function completedHandle(exitCode: number, stdout: string): SubprocessHandle {
  const output = (text: string) => ({
    readFrom: (fromByte: number) => ({
      text: fromByte === 0 ? text : '',
      nextOffset: Buffer.byteLength(text, 'utf8'),
      lossy: false,
    }),
  })
  return {
    pid: 901,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: { stdout: output(stdout), stderr: output('') },
    done: Promise.resolve({ exitCode, signal: null }),
    terminate: () => undefined,
    waitForExit: async () => true,
  }
}
