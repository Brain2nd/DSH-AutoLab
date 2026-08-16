import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { mkdir, open, readFile, realpath, stat } from 'node:fs/promises'
import { hostname } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { z } from 'zod'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

import { durableWriteFile } from './artifacts.js'
import { canonicalJson, sha256 } from './integrity.js'

const execFileAsync = promisify(execFile)
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
const HASH_PATTERN = /^[0-9a-f]{64}$/u
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const ATTEMPT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const TMUX_PANE_PATTERN = /^%[0-9]+$/u
const PROCESS_START_PATTERN = /^(?:linux:[1-9][0-9]*|darwin:[1-9][0-9]*:[0-9]{1,6})$/u
const RUNNER = Object.freeze({ id: 'local-tmux', version: 1 as const })
const TMUX_LAUNCH_NONCE_ENV = 'AUTOLAB_TMUX_LAUNCH_NONCE'
const TMUX_LAUNCH_IDENTITY_ENV = 'AUTOLAB_TMUX_LAUNCH_IDENTITY_HASH'
const TMUX_CLIENT_OUTPUT_BYTES = 1024 * 1024
const TMUX_CLIENT_TERMINATION_GRACE_MS = 1_000
const TMUX_INSPECTION_FORMAT = [
  '#{session_name}',
  '#{pane_id}',
  '#{pane_pid}',
  `#{E:${TMUX_LAUNCH_NONCE_ENV}}`,
  `#{E:${TMUX_LAUNCH_IDENTITY_ENV}}`,
].join('\t')

const pathsSchema = z.object({
  launch: z.string().min(1),
  started: z.string().min(1),
  exit: z.string().min(1),
  log: z.string().min(1),
}).strict()

const runnerSchema = z.object({
  id: z.literal('local-tmux'),
  version: z.literal(1),
}).strict()

const darwinProcessSnapshotSchema = z.object({
  pid: z.number().int().positive(),
  pgid: z.number().int().positive(),
  startSec: z.number().int().positive(),
  startUsec: z.number().int().min(0).max(999_999),
  bootSec: z.number().int().positive(),
  bootUsec: z.number().int().min(0).max(999_999),
  executablePath: z.string().min(1),
  argv: z.array(z.string()).min(1),
}).strict()

const launchSpecSchema = z.object({
  version: z.literal(1),
  kind: z.literal('AUTOLAB_LOCAL_TMUX_LAUNCH'),
  runner: runnerSchema,
  attemptId: z.string().regex(ATTEMPT_PATTERN),
  tmuxSession: z.string().regex(/^autolab-[0-9a-f]{32}$/u),
  launchNonce: z.string().regex(UUID_PATTERN),
  candidateSha: z.string().regex(SHA_PATTERN),
  command: z.array(z.string()).min(1),
  commandHash: z.string().regex(HASH_PATTERN),
  cwd: z.string().min(1),
  cwdHash: z.string().regex(HASH_PATTERN),
  env: z.record(z.string(), z.string()),
  envHash: z.string().regex(HASH_PATTERN),
  attemptDirectory: z.string().min(1),
  runtimePokeFile: z.string().refine(isExactAbsolutePath).optional(),
  paths: pathsSchema,
  issuedAt: z.number().int().nonnegative(),
  launchIdentityHash: z.string().regex(HASH_PATTERN),
  receiptHash: z.string().regex(HASH_PATTERN),
}).strict()

const startedReceiptSchema = z.object({
  version: z.literal(1),
  kind: z.literal('AUTOLAB_ATTEMPT_STARTED'),
  runner: runnerSchema,
  attemptId: z.string().regex(ATTEMPT_PATTERN),
  tmuxSession: z.string().regex(/^autolab-[0-9a-f]{32}$/u),
  launchNonce: z.string().regex(UUID_PATTERN),
  candidateSha: z.string().regex(SHA_PATTERN),
  commandHash: z.string().regex(HASH_PATTERN),
  cwd: z.string().min(1),
  cwdHash: z.string().regex(HASH_PATTERN),
  envHash: z.string().regex(HASH_PATTERN),
  launchIdentityHash: z.string().regex(HASH_PATTERN),
  launchSpecReceiptHash: z.string().regex(HASH_PATTERN),
  logPath: z.string().min(1),
  tmuxPaneId: z.string().regex(TMUX_PANE_PATTERN),
  pid: z.number().int().positive(),
  pgid: z.number().int().positive(),
  processStartId: z.string().regex(PROCESS_START_PATTERN),
  processCommandHash: z.string().regex(HASH_PATTERN),
  hostname: z.string().min(1),
  bootId: z.string().min(1),
  startedAt: z.number().int().nonnegative(),
  receiptHash: z.string().regex(HASH_PATTERN),
}).strict()

const exitReceiptSchema = z.object({
  version: z.literal(1),
  kind: z.literal('AUTOLAB_ATTEMPT_EXIT'),
  runner: runnerSchema,
  attemptId: z.string().regex(ATTEMPT_PATTERN),
  tmuxSession: z.string().regex(/^autolab-[0-9a-f]{32}$/u),
  launchNonce: z.string().regex(UUID_PATTERN),
  candidateSha: z.string().regex(SHA_PATTERN),
  commandHash: z.string().regex(HASH_PATTERN),
  cwdHash: z.string().regex(HASH_PATTERN),
  envHash: z.string().regex(HASH_PATTERN),
  launchIdentityHash: z.string().regex(HASH_PATTERN),
  startedReceiptHash: z.string().regex(HASH_PATTERN),
  tmuxPaneId: z.string().regex(TMUX_PANE_PATTERN),
  pid: z.number().int().positive(),
  pgid: z.number().int().positive(),
  processStartId: z.string().regex(PROCESS_START_PATTERN),
  processCommandHash: z.string().regex(HASH_PATTERN),
  hostname: z.string().min(1),
  bootId: z.string().min(1),
  outcome: z.enum(['exited', 'signaled', 'spawn_failed']),
  exitCode: z.number().int().nullable().optional(),
  signal: z.string().min(1).nullable().optional(),
  spawnError: z.string().min(1).optional(),
  logPath: z.string().min(1),
  finishedAt: z.number().int().nonnegative(),
  receiptHash: z.string().regex(HASH_PATTERN),
}).strict().superRefine((receipt, context) => {
  if (receipt.outcome === 'exited'
    && (receipt.exitCode === undefined
      || receipt.exitCode === null
      || receipt.signal != null
      || receipt.spawnError !== undefined)) {
    context.addIssue({ code: 'custom', message: 'exited requires only a numeric exitCode' })
  }
  if (receipt.outcome === 'signaled'
    && (receipt.signal === undefined
      || receipt.signal === null
      || receipt.exitCode != null
      || receipt.spawnError !== undefined)) {
    context.addIssue({ code: 'custom', message: 'signaled requires only a signal' })
  }
  if (receipt.outcome === 'spawn_failed'
    && (receipt.spawnError === undefined
      || receipt.exitCode != null
      || receipt.signal != null)) {
    context.addIssue({ code: 'custom', message: 'spawn_failed requires only spawnError' })
  }
})

export type LocalTmuxLaunchSpec = z.infer<typeof launchSpecSchema>
export type StartedAttemptReceipt = z.infer<typeof startedReceiptSchema>
export type ExitAttemptReceipt = z.infer<typeof exitReceiptSchema>

export interface CompileLocalTmuxLaunchInput {
  readonly attemptId: string
  readonly launchNonce: string
  readonly candidateSha: string
  readonly cwd: string
  readonly attemptDirectory: string
  readonly command: readonly string[]
  /** Exact environment passed to the experiment; no implicit inheritance. */
  readonly env: Readonly<Record<string, string>>
  /** Mutable endpoint pointer reread after durable started/exit receipts. */
  readonly runtimePokeFile?: string
  readonly issuedAt: number
}

export interface LocalTmuxLaunchPlan {
  readonly attemptId: string
  readonly launchNonce: string
  readonly candidateSha: string
  readonly cwd: string
  readonly attemptDirectory: string
  readonly command: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly runtimePokeFile?: string
  readonly issuedAt: number
  readonly tmuxSession: string
  readonly commandHash: string
  readonly cwdHash: string
  readonly envHash: string
  readonly launchIdentityHash: string
  readonly paths: LocalTmuxLaunchSpec['paths']
  readonly launchSpec: LocalTmuxLaunchSpec
}

export type LocalProcessInspection =
  | { readonly status: 'dead' }
  | { readonly status: 'unknown' }
  | {
      readonly status: 'alive'
      readonly pid: number
      readonly pgid: number
      readonly processStartId: string
      readonly executablePath: string
      readonly argv: readonly string[]
      readonly hostname: string
      readonly bootId: string
    }

export interface LocalTmuxPlatform {
  inspectTmux(tmuxSession: string): Promise<{
    readonly available: boolean
    readonly present: boolean
    readonly paneId?: string
    readonly panePid?: number
    readonly launchNonce?: string
    readonly launchIdentityHash?: string
  }>
  launchTmux(input: {
    readonly plan: LocalTmuxLaunchPlan
    readonly wrapperPath: string
  }): Promise<'created' | 'exists'>
  inspectProcess(pid: number): Promise<LocalProcessInspection>
  verifyDetachedCheckout(cwd: string, candidateSha: string): Promise<void>
}

export type LocalTmuxBlockerCode =
  | 'CHECKOUT_MISMATCH'
  | 'IDENTITY_MISMATCH'
  | 'PROCESS_IDENTITY_MISMATCH'
  | 'RECEIPT_CORRUPT'
  | 'TMUX_IDENTITY_MISMATCH'

export type LocalTmuxPendingCode =
  | 'ATTEMPT_NOT_FOUND'
  | 'PROCESS_IDENTITY_UNKNOWN'
  | 'SYSTEM_UNAVAILABLE'
  | 'TMUX_LAUNCH_FAILED'

export type LocalTmuxInspection =
  | { readonly status: 'absent'; readonly launchPrepared: boolean }
  | {
      readonly status: 'launching'
      readonly launchPrepared: boolean
      readonly tmuxPresent: true
    }
  | {
      readonly status: 'running'
      readonly tmuxPresent: boolean
      readonly tmuxInspectable: boolean
      readonly started: StartedAttemptReceipt
    }
  | {
      readonly status: 'completed'
      readonly started: StartedAttemptReceipt
      readonly exit: ExitAttemptReceipt
    }
  | {
      readonly status: 'outcome_unknown'
      /** Absent when launch evidence exists but started.json was never committed. */
      readonly started?: StartedAttemptReceipt
      readonly reason: string
    }
  | {
      readonly status: 'pending'
      readonly code: LocalTmuxPendingCode
      readonly message: string
    }
  | {
      readonly status: 'blocked'
      readonly code: LocalTmuxBlockerCode
      readonly message: string
    }

export interface LocalTmuxOperationOptions {
  readonly platform?: LocalTmuxPlatform
}

export interface LocalTmuxLaunchOptions extends LocalTmuxOperationOptions {
  readonly wrapperPath: string
}

/** Resolve the one packaged wrapper beside lib/ (or src/ during tests). */
export async function resolveLocalAttemptWrapperPath(): Promise<string> {
  const expected = fileURLToPath(new URL('../scripts/attempt-wrapper.mjs', import.meta.url))
  await assertCanonicalRegularFile(expected, 'packaged AutoLab attempt wrapper')
  return expected
}

/** Compile only immutable launch identity. PID/PGID/boot fields appear only after real start. */
export function compileLocalTmuxLaunch(
  input: CompileLocalTmuxLaunchInput,
): LocalTmuxLaunchPlan {
  validateCompileInput(input)
  const command = [...input.command]
  const env = Object.fromEntries(Object.entries(input.env).sort(([left], [right]) => (
    left < right ? -1 : left > right ? 1 : 0
  )))
  const tmuxSession = `autolab-${sha256(`autolab-tmux-name-v1\0${input.attemptId}`).slice(0, 32)}`
  const commandHash = sha256(`autolab-command-v1\0${canonicalJson(command)}`)
  const cwdHash = sha256(`autolab-cwd-v1\0${canonicalJson(input.cwd)}`)
  const envHash = sha256(`autolab-env-v1\0${canonicalJson(env)}`)
  const paths = {
    launch: join(input.attemptDirectory, 'launch.json'),
    started: join(input.attemptDirectory, 'started.json'),
    exit: join(input.attemptDirectory, 'exit.json'),
    log: join(input.attemptDirectory, 'attempt.log'),
  }
  const identity = {
    version: 1 as const,
    runner: RUNNER,
    attemptId: input.attemptId,
    tmuxSession,
    launchNonce: input.launchNonce,
    candidateSha: input.candidateSha,
    commandHash,
    cwd: input.cwd,
    cwdHash,
    envHash,
  }
  const launchIdentityHash = sha256(
    `autolab-local-tmux-identity-v1\0${canonicalJson(identity)}`,
  )
  const withoutReceiptHash = {
    version: 1 as const,
    kind: 'AUTOLAB_LOCAL_TMUX_LAUNCH' as const,
    runner: RUNNER,
    attemptId: input.attemptId,
    tmuxSession,
    launchNonce: input.launchNonce,
    candidateSha: input.candidateSha,
    command,
    commandHash,
    cwd: input.cwd,
    cwdHash,
    env,
    envHash,
    attemptDirectory: input.attemptDirectory,
    ...(input.runtimePokeFile === undefined
      ? {}
      : { runtimePokeFile: input.runtimePokeFile }),
    paths,
    issuedAt: input.issuedAt,
    launchIdentityHash,
  }
  const launchSpec = launchSpecSchema.parse({
    ...withoutReceiptHash,
    receiptHash: hashReceipt('launch-spec', withoutReceiptHash),
  })
  Object.freeze(launchSpec.runner)
  Object.freeze(launchSpec.command)
  Object.freeze(launchSpec.env)
  Object.freeze(launchSpec.paths)
  Object.freeze(launchSpec)
  return Object.freeze({
    attemptId: input.attemptId,
    launchNonce: input.launchNonce,
    candidateSha: input.candidateSha,
    cwd: input.cwd,
    attemptDirectory: input.attemptDirectory,
    command: Object.freeze(command),
    env: Object.freeze(env),
    ...(input.runtimePokeFile === undefined
      ? {}
      : { runtimePokeFile: input.runtimePokeFile }),
    issuedAt: input.issuedAt,
    tmuxSession,
    commandHash,
    cwdHash,
    envHash,
    launchIdentityHash,
    paths: Object.freeze({ ...paths }),
    launchSpec: Object.freeze(launchSpec),
  })
}

/** Read receipts and live identities exactly once. It never launches, kills, or polls. */
export async function inspectLocalTmuxAttempt(
  plan: LocalTmuxLaunchPlan,
  options: LocalTmuxOperationOptions = {},
): Promise<LocalTmuxInspection> {
  const platform = options.platform ?? nodeLocalTmuxPlatform
  const [launch, exitRead] = await Promise.all([
    readLaunchSpec(plan.paths.launch),
    readExitReceipt(plan.paths.exit),
  ])
  if (launch.status === 'corrupt') return blocked('RECEIPT_CORRUPT', launch.message)
  if (launch.value !== undefined && !sameJson(launch.value, plan.launchSpec)) {
    return blocked('IDENTITY_MISMATCH', 'launch.json belongs to another immutable launch identity')
  }
  const launchPrepared = launch.value !== undefined

  // exit.json is linked only after started.json. Reading in this order avoids
  // inventing an exit-without-start corruption while the wrapper is committing.
  const startedRead = await readStartedReceipt(plan.paths.started)
  if (startedRead.status === 'corrupt') return blocked('RECEIPT_CORRUPT', startedRead.message)
  if (exitRead.status === 'corrupt') return blocked('RECEIPT_CORRUPT', exitRead.message)
  const started = startedRead.value
  const exit = exitRead.value

  if (started === undefined) {
    if (exit !== undefined) {
      return blocked('RECEIPT_CORRUPT', 'exit.json exists without started.json')
    }
    const log = await inspectRegularFile(plan.paths.log, 'attempt log')
    if (log.status === 'corrupt') return blocked('RECEIPT_CORRUPT', log.message)
    const tmux = await platform.inspectTmux(plan.tmuxSession)
    if (!tmux.available) {
      return pending('SYSTEM_UNAVAILABLE', 'tmux cannot be inspected on this host')
    }
    if (!tmux.present) {
      if (log.exists) {
        return {
          status: 'outcome_unknown',
          reason: 'attempt log exists but started.json and the tmux handle are absent',
        }
      }
      return { status: 'absent', launchPrepared }
    }
    const tmuxMismatch = tmuxLaunchIdentityMismatch(plan, tmux)
    if (tmuxMismatch !== undefined) {
      return blocked('TMUX_IDENTITY_MISMATCH', tmuxMismatch)
    }
    if (tmux.paneId === undefined || tmux.panePid === undefined) {
      return pending('PROCESS_IDENTITY_UNKNOWN', 'tmux pane identity cannot be read')
    }
    return launchPrepared
      ? { status: 'launching', launchPrepared, tmuxPresent: true }
      : blocked(
          'TMUX_IDENTITY_MISMATCH',
          'stable tmux name exists without this attempt launch identity',
        )
  }

  const startedMismatch = startedIdentityMismatch(plan, started)
  if (startedMismatch !== undefined) return blocked('IDENTITY_MISMATCH', startedMismatch)

  if (exit !== undefined) {
    return await completedInspection(plan, started, exit)
  }

  const log = await inspectRegularFile(plan.paths.log, 'attempt log')
  if (log.status === 'corrupt') return blocked('RECEIPT_CORRUPT', log.message)
  if (!log.exists) return blocked('RECEIPT_CORRUPT', 'started.json exists without attempt.log')

  const [tmux, process] = await Promise.all([
    platform.inspectTmux(plan.tmuxSession),
    platform.inspectProcess(started.pid),
  ])
  if (tmux.available && tmux.present) {
    const tmuxMismatch = tmuxLaunchIdentityMismatch(plan, tmux, started)
    if (tmuxMismatch !== undefined) {
      return blocked('TMUX_IDENTITY_MISMATCH', tmuxMismatch)
    }
    if (tmux.paneId === undefined || tmux.panePid === undefined) {
      return pending('PROCESS_IDENTITY_UNKNOWN', 'tmux pane identity cannot be read')
    }
    if (tmux.panePid !== started.pid) {
      return blocked(
        'PROCESS_IDENTITY_MISMATCH',
        `tmux pane PID ${tmux.panePid} does not match started PID ${started.pid}`,
      )
    }
  }
  if (process.status === 'unknown') {
    return pending('PROCESS_IDENTITY_UNKNOWN', `process ${started.pid} identity is unavailable`)
  }
  if (process.status === 'dead') {
    // The process may have exited between the first exit read and this probe.
    // One immediate receipt reconciliation is enough; there is no polling loop.
    const settledExit = await readExitReceipt(plan.paths.exit)
    if (settledExit.status === 'corrupt') {
      return blocked('RECEIPT_CORRUPT', settledExit.message)
    }
    if (settledExit.value !== undefined) {
      return await completedInspection(plan, started, settledExit.value)
    }
    return {
      status: 'outcome_unknown',
      started,
      reason: 'started process is no longer present and no exit receipt exists',
    }
  }
  if (!sameProcessIdentity(started, process)) {
    return blocked(
      'PROCESS_IDENTITY_MISMATCH',
      `process ${started.pid} no longer matches its start, PGID, host, or boot identity`,
    )
  }
  return {
    status: 'running',
    tmuxPresent: tmux.present,
    tmuxInspectable: tmux.available,
    started,
  }
}

/** Adopt is inspect-only. Absence stays pending; this function never creates a replacement. */
export async function adoptLocalTmuxAttempt(
  plan: LocalTmuxLaunchPlan,
  options: LocalTmuxOperationOptions = {},
): Promise<LocalTmuxInspection> {
  const inspected = await inspectLocalTmuxAttempt(plan, options)
  return inspected.status === 'absent'
    ? pending('ATTEMPT_NOT_FOUND', 'no matching tmux process or durable receipt exists')
    : inspected
}

/** Launch once from mechanically proven absence; exact replays inspect/adopt instead of spawning. */
export async function launchLocalTmuxAttempt(
  plan: LocalTmuxLaunchPlan,
  options: LocalTmuxLaunchOptions,
): Promise<LocalTmuxInspection> {
  const platform = options.platform ?? nodeLocalTmuxPlatform
  if (!isExactAbsolutePath(options.wrapperPath)) {
    return pending('SYSTEM_UNAVAILABLE', 'attempt wrapper path must be exact and absolute')
  }
  const before = await inspectLocalTmuxAttempt(plan, { platform })
  if (before.status !== 'absent') return before

  try {
    await platform.verifyDetachedCheckout(plan.cwd, plan.candidateSha)
  } catch (error) {
    return blocked('CHECKOUT_MISMATCH', renderError(error))
  }
  try {
    await assertCanonicalRegularFile(options.wrapperPath, 'attempt wrapper')
  } catch (error) {
    return pending('SYSTEM_UNAVAILABLE', renderError(error))
  }
  let prepared: LocalTmuxInspection | undefined
  try {
    prepared = await prepareLaunchSpec(plan)
  } catch (error) {
    return pending('SYSTEM_UNAVAILABLE', `cannot prepare launch.json: ${renderError(error)}`)
  }
  if (prepared !== undefined) return prepared

  try {
    await platform.launchTmux({ plan, wrapperPath: options.wrapperPath })
  } catch (error) {
    return pending('TMUX_LAUNCH_FAILED', renderError(error))
  }
  const after = await inspectLocalTmuxAttempt(plan, { platform })
  if (after.status === 'absent') {
    return pending('TMUX_LAUNCH_FAILED', 'tmux launch returned without a live handle or receipt')
  }
  return after
}

interface TmuxCommandRunner {
  run(executable: string, args: readonly string[]): Promise<string>
  isUnavailable(error: unknown): boolean
}

function tmuxCommandOperations(
  commandRunner: TmuxCommandRunner,
): Pick<LocalTmuxPlatform, 'inspectTmux' | 'launchTmux'> {
  const inspectTmux: LocalTmuxPlatform['inspectTmux'] = async (tmuxSession) => {
    try {
      await commandRunner.run('tmux', ['has-session', '-t', `=${tmuxSession}`])
    } catch (error) {
      if (commandRunner.isUnavailable(error)) return { available: false, present: false }
      if (exitStatus(error) === 1) return { available: true, present: false }
      return { available: false, present: false }
    }
    let pane: string
    try {
      pane = await commandRunner.run('tmux', [
        'display-message',
        '-p',
        '-t',
        `=${tmuxSession}:`,
        TMUX_INSPECTION_FORMAT,
      ])
    } catch (error) {
      // The DSH composition uses this hook to preserve shutdown cancellation.
      commandRunner.isUnavailable(error)
      // Presence is known, but the exact pane identity is temporarily
      // unavailable. Keep this mechanically retryable instead of inventing a
      // permanent foreign-session mismatch.
      return { available: false, present: true }
    }
    const [sessionName, paneId, panePidText, launchNonce, launchIdentityHash] = pane.split('\t')
    const panePid = Number.parseInt(panePidText ?? '', 10)
    return {
      available: true,
      present: true,
      ...(sessionName === tmuxSession && TMUX_PANE_PATTERN.test(paneId ?? '')
        ? { paneId }
        : {}),
      ...(Number.isSafeInteger(panePid) && panePid > 0 ? { panePid } : {}),
      ...(UUID_PATTERN.test(launchNonce ?? '') ? { launchNonce } : {}),
      ...(HASH_PATTERN.test(launchIdentityHash ?? '') ? { launchIdentityHash } : {}),
    }
  }

  const launchTmux: LocalTmuxPlatform['launchTmux'] = async ({ plan, wrapperPath }) => {
    const shellCommand = `exec ${shellQuote(process.execPath)} ${shellQuote(wrapperPath)} ${shellQuote(plan.paths.launch)}`
    try {
      await commandRunner.run('tmux', [
        'new-session',
        '-d',
        '-s',
        plan.tmuxSession,
        '-c',
        plan.cwd,
        '-e',
        `${TMUX_LAUNCH_NONCE_ENV}=${plan.launchNonce}`,
        '-e',
        `${TMUX_LAUNCH_IDENTITY_ENV}=${plan.launchIdentityHash}`,
        shellCommand,
      ])
      return 'created'
    } catch (error) {
      if (commandRunner.isUnavailable(error)) throw new Error('tmux is not installed or executable')
      const observed = await inspectTmux(plan.tmuxSession)
      if (observed.available && observed.present) return 'exists'
      throw error
    }
  }

  return { inspectTmux, launchTmux }
}

const nodeTmuxCommandOperations = tmuxCommandOperations({
  run,
  isUnavailable: isMissingExecutable,
})

export const nodeLocalTmuxPlatform: LocalTmuxPlatform = {
  ...nodeTmuxCommandOperations,

  async inspectProcess(pid) {
    try {
      return await inspectProcessSnapshot(pid)
    } catch (error) {
      return isProcessMissing(error) ? { status: 'dead' } : { status: 'unknown' }
    }
  },

  async verifyDetachedCheckout(cwd, candidateSha) {
    if (await realpath(cwd) !== cwd || !(await stat(cwd)).isDirectory()) {
      throw new Error('run checkout cwd is not its exact canonical directory')
    }
    const [head, symbolic, dirty] = await Promise.all([
      run('git', ['-C', cwd, 'rev-parse', 'HEAD']),
      run('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD']),
      run('git', ['-C', cwd, 'status', '--porcelain=v1', '--untracked-files=normal']),
    ])
    if (head.trim() !== candidateSha) throw new Error('run checkout HEAD does not match candidate SHA')
    if (symbolic.trim() !== 'HEAD') throw new Error('run checkout is not detached')
    if (dirty.length > 0) throw new Error('run checkout contains uncommitted or untracked changes')
  },
}

/**
 * DSH-runtime composition for Controller-owned tmux client calls. Process-table
 * and Git checkout verification remain the existing local mechanical probes;
 * only executable launch/inspection crosses the mounted subprocess seam.
 */
export function createSubprocessLocalTmuxPlatform(
  subprocess: Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'>,
  signal?: AbortSignal,
): LocalTmuxPlatform {
  return {
    ...tmuxCommandOperations({
      run: async (executable, args) => await runWithSubprocess(
        subprocess,
        executable,
        args,
        signal,
      ),
      isUnavailable: error => {
        signal?.throwIfAborted()
        return error instanceof SubprocessExecutableUnavailableError
          || isMissingExecutable(error)
      },
    }),
    inspectProcess: nodeLocalTmuxPlatform.inspectProcess,
    verifyDetachedCheckout: nodeLocalTmuxPlatform.verifyDetachedCheckout,
  }
}

async function prepareLaunchSpec(plan: LocalTmuxLaunchPlan): Promise<LocalTmuxInspection | undefined> {
  await mkdir(plan.attemptDirectory, { recursive: true, mode: 0o700 })
  await assertCanonicalDirectory(plan.attemptDirectory, 'attempt directory')
  try {
    await durableWriteFile(
      plan.paths.launch,
      `${JSON.stringify(plan.launchSpec)}\n`,
      false,
    )
    return undefined
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') throw error
  }
  const existing = await readLaunchSpec(plan.paths.launch)
  if (existing.status === 'corrupt') return blocked('RECEIPT_CORRUPT', existing.message)
  if (existing.value === undefined || !sameJson(existing.value, plan.launchSpec)) {
    return blocked('IDENTITY_MISMATCH', 'launch.json already contains another launch identity')
  }
  return undefined
}

function validateCompileInput(input: CompileLocalTmuxLaunchInput): void {
  if (!ATTEMPT_PATTERN.test(input.attemptId)) throw new TypeError('invalid attemptId')
  if (!UUID_PATTERN.test(input.launchNonce)) throw new TypeError('invalid launchNonce')
  if (!SHA_PATTERN.test(input.candidateSha)) throw new TypeError('invalid candidateSha')
  if (!isExactAbsolutePath(input.cwd)) throw new TypeError('cwd must be exact and absolute')
  if (!isExactAbsolutePath(input.attemptDirectory)) {
    throw new TypeError('attemptDirectory must be exact and absolute')
  }
  if (input.runtimePokeFile !== undefined
    && !isExactAbsolutePath(input.runtimePokeFile)) {
    throw new TypeError('runtimePokeFile must be exact and absolute')
  }
  if (!Number.isSafeInteger(input.issuedAt) || input.issuedAt < 0) {
    throw new TypeError('issuedAt must be a non-negative safe integer')
  }
  if (!Array.isArray(input.command) || input.command.length === 0) {
    throw new TypeError('command must contain an executable')
  }
  for (const value of input.command) {
    if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
      throw new TypeError('command entries must be non-empty strings without NUL')
    }
  }
  if (Object.getPrototypeOf(input.env) !== Object.prototype
    && Object.getPrototypeOf(input.env) !== null) {
    throw new TypeError('env must be a plain object')
  }
  for (const [key, value] of Object.entries(input.env)) {
    if (key.length === 0 || key.includes('=') || key.includes('\0') || value.includes('\0')) {
      throw new TypeError('env entries must be valid exact process environment strings')
    }
  }
}

type ReceiptRead<T> =
  | { readonly status: 'ok'; readonly value?: T }
  | { readonly status: 'corrupt'; readonly message: string }

async function readLaunchSpec(path: string): Promise<ReceiptRead<LocalTmuxLaunchSpec>> {
  return await readReceipt(path, launchSpecSchema, 'launch-spec')
}

async function readStartedReceipt(path: string): Promise<ReceiptRead<StartedAttemptReceipt>> {
  return await readReceipt(path, startedReceiptSchema, 'started')
}

async function readExitReceipt(path: string): Promise<ReceiptRead<ExitAttemptReceipt>> {
  return await readReceipt(path, exitReceiptSchema, 'exit')
}

async function readReceipt<T extends { readonly receiptHash: string }>(
  path: string,
  schema: z.ZodType<T>,
  domain: 'launch-spec' | 'started' | 'exit',
): Promise<ReceiptRead<T>> {
  let text: string
  const read = await readRegularFile(path, `${domain} receipt`)
  if (read.status === 'corrupt') return read
  if (read.bytes === undefined) return { status: 'ok' }
  text = read.bytes.toString('utf8')
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return { status: 'corrupt', message: `${path} is not JSON: ${renderError(error)}` }
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success) return { status: 'corrupt', message: `${path} has an invalid schema` }
  const { receiptHash, ...withoutReceiptHash } = parsed.data
  if (receiptHash !== hashReceipt(domain, withoutReceiptHash)) {
    return { status: 'corrupt', message: `${path} has an invalid receipt hash` }
  }
  return { status: 'ok', value: parsed.data }
}

async function completedInspection(
  plan: LocalTmuxLaunchPlan,
  started: StartedAttemptReceipt,
  exit: ExitAttemptReceipt,
): Promise<LocalTmuxInspection> {
  const mismatch = exitIdentityMismatch(plan, started, exit)
  if (mismatch !== undefined) return blocked('IDENTITY_MISMATCH', mismatch)
  if (exit.finishedAt < started.startedAt) {
    return blocked('RECEIPT_CORRUPT', 'exit.json finishedAt precedes started.json startedAt')
  }
  const log = await inspectRegularFile(plan.paths.log, 'attempt log')
  if (log.status === 'corrupt') return blocked('RECEIPT_CORRUPT', log.message)
  if (!log.exists) {
    return blocked('RECEIPT_CORRUPT', 'exit.json exists without attempt.log')
  }
  return { status: 'completed', started, exit }
}

type RegularFileRead =
  | { readonly status: 'ok'; readonly bytes?: Buffer }
  | { readonly status: 'corrupt'; readonly message: string }

type RegularFileInspection =
  | { readonly status: 'ok'; readonly exists: boolean }
  | { readonly status: 'corrupt'; readonly message: string }

const READ_REGULAR_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

async function readRegularFile(path: string, label: string): Promise<RegularFileRead> {
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(path, READ_REGULAR_FLAGS)
    if (!(await file.stat()).isFile()) {
      return { status: 'corrupt', message: `${label} is not a regular file: ${path}` }
    }
    return { status: 'ok', bytes: await file.readFile() }
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return { status: 'ok' }
    return { status: 'corrupt', message: `cannot read ${label} ${path}: ${renderError(error)}` }
  } finally {
    await file?.close().catch(() => undefined)
  }
}

async function inspectRegularFile(path: string, label: string): Promise<RegularFileInspection> {
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(path, READ_REGULAR_FLAGS)
    if (!(await file.stat()).isFile()) {
      return { status: 'corrupt', message: `${label} is not a regular file: ${path}` }
    }
    return { status: 'ok', exists: true }
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return { status: 'ok', exists: false }
    return { status: 'corrupt', message: `cannot inspect ${label} ${path}: ${renderError(error)}` }
  } finally {
    await file?.close().catch(() => undefined)
  }
}

async function assertCanonicalRegularFile(path: string, label: string): Promise<void> {
  if (await realpath(path) !== path) throw new Error(`${label} is not canonical: ${path}`)
  const read = await inspectRegularFile(path, label)
  if (read.status === 'corrupt') throw new Error(read.message)
  if (!read.exists) throw new Error(`${label} does not exist: ${path}`)
}

async function assertCanonicalDirectory(path: string, label: string): Promise<void> {
  if (await realpath(path) !== path) {
    throw new Error(`${label} is not its exact canonical directory: ${path}`)
  }
  let directory: Awaited<ReturnType<typeof open>> | undefined
  try {
    directory = await open(path, READ_REGULAR_FLAGS)
    if (!(await directory.stat()).isDirectory()) {
      throw new Error(`${label} is not its exact canonical directory: ${path}`)
    }
  } finally {
    await directory?.close().catch(() => undefined)
  }
}

function startedIdentityMismatch(
  plan: LocalTmuxLaunchPlan,
  started: StartedAttemptReceipt,
): string | undefined {
  if (started.attemptId !== plan.attemptId
    || started.tmuxSession !== plan.tmuxSession
    || started.launchNonce !== plan.launchNonce
    || started.candidateSha !== plan.candidateSha
    || started.commandHash !== plan.commandHash
    || started.cwd !== plan.cwd
    || started.cwdHash !== plan.cwdHash
    || started.envHash !== plan.envHash
    || started.launchIdentityHash !== plan.launchIdentityHash
    || started.launchSpecReceiptHash !== plan.launchSpec.receiptHash
    || started.logPath !== plan.paths.log
    || started.processCommandHash !== expectedWrapperCommandHash(plan)) {
    return 'started.json does not match the immutable launch identity'
  }
  return undefined
}

function exitIdentityMismatch(
  plan: LocalTmuxLaunchPlan,
  started: StartedAttemptReceipt,
  exit: ExitAttemptReceipt,
): string | undefined {
  if (exit.attemptId !== plan.attemptId
    || exit.tmuxSession !== plan.tmuxSession
    || exit.launchNonce !== plan.launchNonce
    || exit.candidateSha !== plan.candidateSha
    || exit.commandHash !== plan.commandHash
    || exit.cwdHash !== plan.cwdHash
    || exit.envHash !== plan.envHash
    || exit.launchIdentityHash !== plan.launchIdentityHash
    || exit.startedReceiptHash !== started.receiptHash
    || exit.tmuxPaneId !== started.tmuxPaneId
    || exit.pid !== started.pid
    || exit.pgid !== started.pgid
    || exit.processStartId !== started.processStartId
    || exit.processCommandHash !== started.processCommandHash
    || exit.hostname !== started.hostname
    || exit.bootId !== started.bootId
    || exit.logPath !== plan.paths.log) {
    return 'exit.json does not match launch.json and started.json'
  }
  return undefined
}

function sameProcessIdentity(
  started: StartedAttemptReceipt,
  process: Extract<LocalProcessInspection, { status: 'alive' }>,
): boolean {
  return process.pid === started.pid
    && process.pgid === started.pgid
    && process.processStartId === started.processStartId
    && processCommandHash(process) === started.processCommandHash
    && process.hostname === started.hostname
    && process.bootId === started.bootId
}

function tmuxLaunchIdentityMismatch(
  plan: LocalTmuxLaunchPlan,
  tmux: Awaited<ReturnType<LocalTmuxPlatform['inspectTmux']>>,
  started?: StartedAttemptReceipt,
): string | undefined {
  if (tmux.launchNonce !== plan.launchNonce
    || tmux.launchIdentityHash !== plan.launchIdentityHash) {
    return `tmux session binding does not match launch ${plan.launchNonce}/${plan.launchIdentityHash}; observed ${tmux.launchNonce ?? '<missing>'}/${tmux.launchIdentityHash ?? '<missing>'}`
  }
  if (started !== undefined
    && tmux.paneId !== undefined
    && tmux.paneId !== started.tmuxPaneId) {
    return `tmux pane ${tmux.paneId} does not match started pane ${started.tmuxPaneId}`
  }
  return undefined
}

function expectedWrapperCommandHash(plan: LocalTmuxLaunchPlan): string {
  const wrapperPath = fileURLToPath(new URL('../scripts/attempt-wrapper.mjs', import.meta.url))
  return processCommandHash({
    executablePath: process.execPath,
    argv: [process.execPath, wrapperPath, plan.paths.launch],
  })
}

function processCommandHash(
  processIdentity: Pick<
    Extract<LocalProcessInspection, { status: 'alive' }>,
    'executablePath' | 'argv'
  >,
): string {
  return sha256(
    `autolab-wrapper-process-command-v1\0${canonicalJson({
      executablePath: processIdentity.executablePath,
      argv: processIdentity.argv,
    })}`,
  )
}

function hashReceipt(
  domain: 'launch-spec' | 'started' | 'exit',
  value: unknown,
): string {
  return sha256(`autolab-local-tmux-${domain}-v1\0${canonicalJson(value)}`)
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function blocked(code: LocalTmuxBlockerCode, message: string): LocalTmuxInspection {
  return { status: 'blocked', code, message }
}

function pending(code: LocalTmuxPendingCode, message: string): LocalTmuxInspection {
  return { status: 'pending', code, message }
}

async function run(executable: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync(executable, [...args], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  })
  return result.stdout.trimEnd()
}

class SubprocessExecutableUnavailableError extends Error {
  readonly name = 'SubprocessExecutableUnavailableError'
}

class SubprocessCommandExitError extends Error {
  readonly name = 'SubprocessCommandExitError'

  constructor(
    message: string,
    readonly code: number | null,
    readonly signal: NodeJS.Signals | null,
  ) {
    super(message)
  }
}

async function runWithSubprocess(
  subprocess: Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'>,
  executable: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  let resolved: string
  try {
    resolved = await subprocess.resolveExecutable(executable, undefined, signal)
  } catch (error) {
    signal?.throwIfAborted()
    throw new SubprocessExecutableUnavailableError(
      `${executable} is not installed or executable`,
      { cause: error },
    )
  }
  const handle = subprocess.spawn({
    argv: [resolved, ...args],
    cwd: process.cwd(),
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: TMUX_CLIENT_OUTPUT_BYTES },
      stderr: { maxBytes: TMUX_CLIENT_OUTPUT_BYTES },
    },
    graceMs: TMUX_CLIENT_TERMINATION_GRACE_MS,
    ...(signal === undefined ? {} : { signal }),
  })
  const outcome = await handle.done
  signal?.throwIfAborted()
  const stdout = handle.collected.stdout?.readFrom(0)
  const stderr = handle.collected.stderr?.readFrom(0)
  if (stdout === undefined || stderr === undefined || stdout.lossy || stderr.lossy) {
    throw new Error('tmux client output exceeded its bounded DSH subprocess capture')
  }
  if (outcome.exitCode !== 0) {
    const detail = stderr.text.trim()
    throw new SubprocessCommandExitError(
      `tmux client ${outcome.signal ?? `exit ${String(outcome.exitCode)}`}${detail === '' ? '' : `: ${detail}`}`,
      outcome.exitCode,
      outcome.signal,
    )
  }
  return stdout.text.trimEnd()
}

class ProcessMissingError extends Error {}

interface ProcessSnapshot {
  readonly status: 'alive'
  readonly pid: number
  readonly pgid: number
  readonly processStartId: string
  readonly executablePath: string
  readonly argv: readonly string[]
  readonly hostname: string
  readonly bootId: string
}

async function inspectProcessSnapshot(pid: number): Promise<ProcessSnapshot> {
  if (process.platform === 'linux') return await inspectLinuxProcessSnapshot(pid)
  if (process.platform === 'darwin') return await inspectDarwinProcessSnapshot(pid)
  throw new Error(`local tmux runner does not support ${process.platform}`)
}

interface LinuxProcStat {
  readonly pid: number
  readonly pgid: number
  readonly startTicks: string
}

async function inspectLinuxProcessSnapshot(pid: number): Promise<ProcessSnapshot> {
  const before = await readLinuxProcStat(pid)
  let cmdline: Buffer
  let executablePath: string
  let bootId: string
  try {
    [cmdline, executablePath, bootId] = await Promise.all([
      readFile(`/proc/${pid}/cmdline`),
      realpath(`/proc/${pid}/exe`),
      readLinuxBootId(),
    ])
  } catch (error) {
    if (isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ESRCH')) {
      throw new ProcessMissingError(`process ${pid} disappeared`)
    }
    throw error
  }
  const after = await readLinuxProcStat(pid)
  if (before.pid !== after.pid
    || before.pgid !== after.pgid
    || before.startTicks !== after.startTicks) {
    throw new Error(`process ${pid} changed identity while it was inspected`)
  }
  const argv = parseLinuxCmdline(cmdline)
  if (argv.length === 0) throw new Error(`process ${pid} command line is unavailable`)
  return {
    status: 'alive',
    pid: before.pid,
    pgid: before.pgid,
    processStartId: `linux:${before.startTicks}`,
    executablePath,
    argv,
    hostname: hostname(),
    bootId,
  }
}

async function readLinuxProcStat(pid: number): Promise<LinuxProcStat> {
  let value: string
  try {
    value = await readFile(`/proc/${pid}/stat`, 'utf8')
  } catch (error) {
    if (isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ESRCH')) {
      throw new ProcessMissingError(`process ${pid} does not exist`)
    }
    throw error
  }
  const openParenthesis = value.indexOf('(')
  const closeParenthesis = value.lastIndexOf(')')
  if (openParenthesis <= 0 || closeParenthesis <= openParenthesis) {
    throw new Error(`/proc/${pid}/stat has an invalid process record`)
  }
  const parsedPid = Number.parseInt(value.slice(0, openParenthesis).trim(), 10)
  const fields = value.slice(closeParenthesis + 1).trim().split(/\s+/u)
  const pgid = Number.parseInt(fields[2] ?? '', 10)
  const startTicks = fields[19]
  if (parsedPid !== pid
    || !Number.isSafeInteger(pgid)
    || pgid <= 0
    || startTicks === undefined
    || !/^[1-9][0-9]*$/u.test(startTicks)) {
    throw new Error(`/proc/${pid}/stat is missing PID, PGID, or start ticks`)
  }
  return { pid: parsedPid, pgid, startTicks }
}

function parseLinuxCmdline(value: Buffer): string[] {
  const fields = value.toString('utf8').split('\0')
  if (fields.at(-1) === '') fields.pop()
  return fields
}

async function readLinuxBootId(): Promise<string> {
  const value = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value)) {
    throw new Error('Linux boot ID is invalid')
  }
  return `linux:${value}`
}

// PROC_PIDTBSDINFO (3), struct proc_bsdinfo, KERN_PROCARGS2 (49), and
// kern.boottime are the numeric interfaces declared by the macOS SDK headers.
// One helper process obtains PID/PGID/start in one proc_pidinfo call, reads
// argv, then repeats proc_pidinfo to reject reuse during that read.
const DARWIN_PROCESS_SNAPSHOT_SCRIPT = String.raw`
import ctypes
import json
import os
import struct
import sys

class ProcBsdInfo(ctypes.Structure):
    _fields_ = [
        ('flags', ctypes.c_uint32), ('status', ctypes.c_uint32),
        ('xstatus', ctypes.c_uint32), ('pid', ctypes.c_uint32),
        ('ppid', ctypes.c_uint32), ('uid', ctypes.c_uint32),
        ('gid', ctypes.c_uint32), ('ruid', ctypes.c_uint32),
        ('rgid', ctypes.c_uint32), ('svuid', ctypes.c_uint32),
        ('svgid', ctypes.c_uint32), ('rfu', ctypes.c_uint32),
        ('comm', ctypes.c_char * 16), ('name', ctypes.c_char * 32),
        ('nfiles', ctypes.c_uint32), ('pgid', ctypes.c_uint32),
        ('pjobc', ctypes.c_uint32), ('tdev', ctypes.c_uint32),
        ('tpgid', ctypes.c_uint32), ('nice', ctypes.c_int32),
        ('start_sec', ctypes.c_uint64), ('start_usec', ctypes.c_uint64),
    ]

class Timeval(ctypes.Structure):
    _fields_ = [('sec', ctypes.c_long), ('usec', ctypes.c_int)]

pid = int(sys.argv[1])
libproc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
libproc.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64,
                                 ctypes.c_void_p, ctypes.c_int]
libproc.proc_pidinfo.restype = ctypes.c_int

def bsd_info(missing_code):
    value = ProcBsdInfo()
    size = ctypes.sizeof(value)
    if libproc.proc_pidinfo(pid, 3, 0, ctypes.byref(value), size) != size:
        sys.exit(missing_code)
    return value

before = bsd_info(3)
libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
libc.sysctl.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.c_uint,
                        ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t),
                        ctypes.c_void_p, ctypes.c_size_t]
mib = (ctypes.c_int * 3)(1, 49, pid)
size = ctypes.c_size_t()
if libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0) != 0 or size.value < 5:
    sys.exit(5)
buffer = ctypes.create_string_buffer(size.value)
if libc.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0) != 0:
    sys.exit(5)
raw = buffer.raw[:size.value]
argc = struct.unpack_from('=i', raw, 0)[0]
cursor = 4
end = raw.find(b'\0', cursor)
if argc < 1 or end < 0:
    sys.exit(5)
executable = os.fsdecode(raw[cursor:end])
cursor = end + 1
while cursor < len(raw) and raw[cursor] == 0:
    cursor += 1
argv = []
for _ in range(argc):
    end = raw.find(b'\0', cursor)
    if end < 0:
        sys.exit(5)
    argv.append(os.fsdecode(raw[cursor:end]))
    cursor = end + 1

boot = Timeval()
boot_size = ctypes.c_size_t(ctypes.sizeof(boot))
libc.sysctlbyname.argtypes = [ctypes.c_char_p, ctypes.c_void_p,
                              ctypes.POINTER(ctypes.c_size_t),
                              ctypes.c_void_p, ctypes.c_size_t]
if libc.sysctlbyname(b'kern.boottime', ctypes.byref(boot),
                     ctypes.byref(boot_size), None, 0) != 0:
    sys.exit(5)
after = bsd_info(4)
identity_before = (before.pid, before.pgid, before.start_sec, before.start_usec)
identity_after = (after.pid, after.pgid, after.start_sec, after.start_usec)
if identity_before != identity_after or before.pid != pid:
    sys.exit(4)
print(json.dumps({
    'pid': before.pid,
    'pgid': before.pgid,
    'startSec': before.start_sec,
    'startUsec': before.start_usec,
    'bootSec': boot.sec,
    'bootUsec': boot.usec,
    'executablePath': executable,
    'argv': argv,
}, separators=(',', ':')))
`

async function inspectDarwinProcessSnapshot(pid: number): Promise<ProcessSnapshot> {
  let stdout: string
  try {
    const result = await execFileAsync(
      '/usr/bin/python3',
      ['-I', '-S', '-c', DARWIN_PROCESS_SNAPSHOT_SCRIPT, String(pid)],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
    )
    stdout = result.stdout
  } catch (error) {
    if (exitStatus(error) === 3) throw new ProcessMissingError(`process ${pid} does not exist`)
    throw error
  }
  const parsed = darwinProcessSnapshotSchema.parse(JSON.parse(stdout))
  if (parsed.pid !== pid) throw new Error(`macOS process snapshot returned PID ${parsed.pid}`)
  return {
    status: 'alive',
    pid: parsed.pid,
    pgid: parsed.pgid,
    processStartId: `darwin:${parsed.startSec}:${parsed.startUsec}`,
    executablePath: parsed.executablePath,
    argv: parsed.argv,
    hostname: hostname(),
    bootId: `darwin:${parsed.bootSec}:${parsed.bootUsec}`,
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function isExactAbsolutePath(value: string): boolean {
  return isAbsolute(value) && resolve(value) === value && !value.includes('\0')
}

function isMissingExecutable(value: unknown): boolean {
  return isNodeError(value) && value.code === 'ENOENT'
}

function isProcessMissing(value: unknown): boolean {
  return value instanceof ProcessMissingError
}

function exitStatus(value: unknown): number | undefined {
  if (!isNodeError(value)) return undefined
  return typeof value.code === 'number' ? value.code : undefined
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}

function renderError(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
