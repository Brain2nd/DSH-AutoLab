import { spawn, execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  link,
  open,
  readFile,
  realpath,
  rm,
  stat,
} from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
const HASH_PATTERN = /^[0-9a-f]{64}$/u
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const ATTEMPT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const TMUX_PATTERN = /^autolab-[0-9a-f]{32}$/u
const TMUX_PANE_PATTERN = /^%[0-9]+$/u
const TMUX_LAUNCH_NONCE_ENV = 'AUTOLAB_TMUX_LAUNCH_NONCE'
const TMUX_LAUNCH_IDENTITY_ENV = 'AUTOLAB_TMUX_LAUNCH_IDENTITY_HASH'
const TMUX_INSPECTION_FORMAT = [
  '#{session_name}',
  '#{pane_id}',
  '#{pane_pid}',
  `#{E:${TMUX_LAUNCH_NONCE_ENV}}`,
  `#{E:${TMUX_LAUNCH_IDENTITY_ENV}}`,
].join('\t')
const READ_REGULAR_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const CREATE_LOG_FLAGS = constants.O_CREAT
  | constants.O_EXCL
  | constants.O_RDWR
  | constants.O_NOFOLLOW
  | constants.O_NONBLOCK
const RUNNER_KEYS = ['id', 'version']
const PATH_KEYS = ['exit', 'launch', 'log', 'started']
const LAUNCH_KEYS = [
  'attemptDirectory',
  'attemptId',
  'candidateSha',
  'command',
  'commandHash',
  'cwd',
  'cwdHash',
  'env',
  'envHash',
  'issuedAt',
  'kind',
  'launchIdentityHash',
  'launchNonce',
  'paths',
  'receiptHash',
  'runner',
  'tmuxSession',
  'version',
]
const RUNTIME_POKE_KEYS = ['socketPath', 'version']

const launchPath = process.argv[2]
const wrapperPath = fileURLToPath(import.meta.url)
try {
  if (process.argv.length !== 3 || launchPath === undefined) {
    throw new Error('usage: node attempt-wrapper.mjs /absolute/path/to/launch.json')
  }
  const spec = await readAndVerifyLaunch(launchPath)
  await verifyDetachedCheckout(spec.cwd, spec.candidateSha)
  await assertCanonicalRegularFile(wrapperPath, 'attempt wrapper')
  const identity = await inspectSelf(wrapperPath, launchPath)
  const tmuxIdentity = await verifyTmuxBinding(spec, identity)
  const logHandle = await open(spec.paths.log, CREATE_LOG_FLAGS, 0o600)
  let result
  try {
    if (!(await logHandle.stat()).isFile()) throw new Error('attempt log is not a regular file')
    const startedWithoutHash = {
      version: 1,
      kind: 'AUTOLAB_ATTEMPT_STARTED',
      runner: spec.runner,
      attemptId: spec.attemptId,
      tmuxSession: spec.tmuxSession,
      launchNonce: spec.launchNonce,
      candidateSha: spec.candidateSha,
      commandHash: spec.commandHash,
      cwd: spec.cwd,
      cwdHash: spec.cwdHash,
      envHash: spec.envHash,
      launchIdentityHash: spec.launchIdentityHash,
      launchSpecReceiptHash: spec.receiptHash,
      logPath: spec.paths.log,
      tmuxPaneId: tmuxIdentity.paneId,
      ...identity,
      startedAt: Date.now(),
    }
    const started = {
      ...startedWithoutHash,
      receiptHash: hashReceipt('started', startedWithoutHash),
    }
    await durableWriteExclusive(spec.paths.started, `${JSON.stringify(started)}\n`)
    await pokeRuntime(spec.runtimePokeFile)

    result = await runAttempt(spec, logHandle.fd)
    await logHandle.sync()

    const exitWithoutHash = {
      version: 1,
      kind: 'AUTOLAB_ATTEMPT_EXIT',
      runner: spec.runner,
      attemptId: spec.attemptId,
      tmuxSession: spec.tmuxSession,
      launchNonce: spec.launchNonce,
      candidateSha: spec.candidateSha,
      commandHash: spec.commandHash,
      cwdHash: spec.cwdHash,
      envHash: spec.envHash,
      launchIdentityHash: spec.launchIdentityHash,
      startedReceiptHash: started.receiptHash,
      tmuxPaneId: started.tmuxPaneId,
      pid: started.pid,
      pgid: started.pgid,
      processStartId: started.processStartId,
      processCommandHash: started.processCommandHash,
      hostname: started.hostname,
      bootId: started.bootId,
      ...result.receipt,
      logPath: spec.paths.log,
      finishedAt: Math.max(Date.now(), started.startedAt),
    }
    const exit = {
      ...exitWithoutHash,
      receiptHash: hashReceipt('exit', exitWithoutHash),
    }
    await durableWriteExclusive(spec.paths.exit, `${JSON.stringify(exit)}\n`)
    await pokeRuntime(spec.runtimePokeFile)
  } finally {
    await logHandle.close().catch(() => undefined)
  }
  process.exitCode = result.exitStatus
} catch (error) {
  fail(renderError(error))
}

async function readAndVerifyLaunch(path) {
  if (!isExactAbsolutePath(path)) throw new Error('launch path must be exact and absolute')
  let value
  try {
    value = JSON.parse((await readRegularFile(path, 'launch spec')).toString('utf8'))
  } catch (error) {
    throw new Error(`cannot parse launch spec: ${renderError(error)}`)
  }
  assertExactObject(
    value,
    Object.hasOwn(value, 'runtimePokeFile')
      ? [...LAUNCH_KEYS, 'runtimePokeFile']
      : LAUNCH_KEYS,
    'launch spec',
  )
  if (value.version !== 1 || value.kind !== 'AUTOLAB_LOCAL_TMUX_LAUNCH') {
    throw new Error('launch spec version or kind is invalid')
  }
  assertExactObject(value.runner, RUNNER_KEYS, 'runner')
  if (value.runner.id !== 'local-tmux' || value.runner.version !== 1) {
    throw new Error('runner identity is invalid')
  }
  assertPattern(value.attemptId, ATTEMPT_PATTERN, 'attemptId')
  assertPattern(value.tmuxSession, TMUX_PATTERN, 'tmuxSession')
  assertPattern(value.launchNonce, UUID_PATTERN, 'launchNonce')
  assertPattern(value.candidateSha, SHA_PATTERN, 'candidateSha')
  assertPattern(value.commandHash, HASH_PATTERN, 'commandHash')
  assertPattern(value.cwdHash, HASH_PATTERN, 'cwdHash')
  assertPattern(value.envHash, HASH_PATTERN, 'envHash')
  assertPattern(value.launchIdentityHash, HASH_PATTERN, 'launchIdentityHash')
  assertPattern(value.receiptHash, HASH_PATTERN, 'receiptHash')
  assertExactPath(value.cwd, 'cwd')
  assertExactPath(value.attemptDirectory, 'attemptDirectory')
  if (value.runtimePokeFile !== undefined) {
    assertExactPath(value.runtimePokeFile, 'runtimePokeFile')
  }
  if (!Number.isSafeInteger(value.issuedAt) || value.issuedAt < 0) {
    throw new Error('issuedAt is invalid')
  }
  if (!Array.isArray(value.command) || value.command.length === 0) {
    throw new Error('command must contain an executable')
  }
  for (const entry of value.command) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.includes('\0')) {
      throw new Error('command entries are invalid')
    }
  }
  assertRecord(value.env, 'env')
  for (const [key, entry] of Object.entries(value.env)) {
    if (key.length === 0 || key.includes('=') || key.includes('\0')
      || typeof entry !== 'string' || entry.includes('\0')) {
      throw new Error('environment entries are invalid')
    }
  }
  assertExactObject(value.paths, PATH_KEYS, 'paths')
  const expectedPaths = {
    launch: join(value.attemptDirectory, 'launch.json'),
    started: join(value.attemptDirectory, 'started.json'),
    exit: join(value.attemptDirectory, 'exit.json'),
    log: join(value.attemptDirectory, 'attempt.log'),
  }
  for (const key of PATH_KEYS) {
    assertExactPath(value.paths[key], `paths.${key}`)
    if (value.paths[key] !== expectedPaths[key]) throw new Error(`paths.${key} is invalid`)
  }
  if (path !== value.paths.launch || dirname(path) !== value.attemptDirectory) {
    throw new Error('launch spec does not belong to its attempt directory')
  }
  await assertCanonicalDirectory(value.attemptDirectory, 'attempt directory')

  const expectedTmux = `autolab-${sha256(`autolab-tmux-name-v1\0${value.attemptId}`).slice(0, 32)}`
  if (value.tmuxSession !== expectedTmux) throw new Error('tmux session identity is invalid')
  if (value.commandHash !== sha256(`autolab-command-v1\0${canonicalJson(value.command)}`)) {
    throw new Error('command hash is invalid')
  }
  if (value.cwdHash !== sha256(`autolab-cwd-v1\0${canonicalJson(value.cwd)}`)) {
    throw new Error('cwd hash is invalid')
  }
  if (value.envHash !== sha256(`autolab-env-v1\0${canonicalJson(value.env)}`)) {
    throw new Error('environment hash is invalid')
  }
  const identity = {
    version: 1,
    runner: value.runner,
    attemptId: value.attemptId,
    tmuxSession: value.tmuxSession,
    launchNonce: value.launchNonce,
    candidateSha: value.candidateSha,
    commandHash: value.commandHash,
    cwd: value.cwd,
    cwdHash: value.cwdHash,
    envHash: value.envHash,
  }
  if (value.launchIdentityHash
    !== sha256(`autolab-local-tmux-identity-v1\0${canonicalJson(identity)}`)) {
    throw new Error('launch identity hash is invalid')
  }
  const { receiptHash, ...withoutReceiptHash } = value
  if (receiptHash !== hashReceipt('launch-spec', withoutReceiptHash)) {
    throw new Error('launch receipt hash is invalid')
  }
  return value
}

async function verifyDetachedCheckout(cwd, candidateSha) {
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
}

async function inspectSelf(expectedWrapperPath, expectedLaunchPath) {
  const snapshot = await inspectProcessSnapshot(process.pid)
  const expectedArgv = [process.execPath, expectedWrapperPath, expectedLaunchPath]
  if (snapshot.executablePath !== process.execPath
    || canonicalJson(snapshot.argv) !== canonicalJson(expectedArgv)) {
    throw new Error('wrapper live command does not match its executable, wrapper, and launch path')
  }
  return {
    pid: snapshot.pid,
    pgid: snapshot.pgid,
    processStartId: snapshot.processStartId,
    processCommandHash: processCommandHash(snapshot),
    hostname: hostname(),
    bootId: snapshot.bootId,
  }
}

async function verifyTmuxBinding(spec, identity) {
  const expectedPane = process.env.TMUX_PANE
  if (typeof expectedPane !== 'string' || !TMUX_PANE_PATTERN.test(expectedPane)) {
    throw new Error('wrapper is not running in a tmux pane')
  }
  let value
  try {
    value = await run('tmux', [
      'display-message',
      '-p',
      '-t',
      expectedPane,
      TMUX_INSPECTION_FORMAT,
    ])
  } catch (error) {
    throw new Error(`cannot inspect wrapper tmux pane: ${renderError(error)}`)
  }
  const [sessionName, paneId, panePidText, launchNonce, launchIdentityHash] = value.split('\t')
  const panePid = Number.parseInt(panePidText ?? '', 10)
  if (sessionName !== spec.tmuxSession
    || paneId !== expectedPane
    || panePid !== identity.pid
    || launchNonce !== spec.launchNonce
    || launchIdentityHash !== spec.launchIdentityHash) {
    throw new Error('wrapper tmux pane does not match the exact launch identity')
  }
  return { paneId }
}

async function runAttempt(spec, logFd) {
  let child
  try {
    child = spawn(spec.command[0], spec.command.slice(1), {
      cwd: spec.cwd,
      env: spec.env,
      shell: false,
      stdio: ['ignore', logFd, logFd],
    })
  } catch (error) {
    const message = renderError(error)
    return {
      receipt: { outcome: 'spawn_failed', spawnError: message || 'spawn failed' },
      exitStatus: 127,
    }
  }
  const outcome = await new Promise(resolveOutcome => {
    let settled = false
    const settle = value => {
      if (settled) return
      settled = true
      resolveOutcome(value)
    }
    child.once('error', error => settle({ kind: 'spawn_failed', error }))
    child.once('close', (code, signal) => settle({ kind: 'closed', code, signal }))
  })
  if (outcome.kind === 'spawn_failed') {
    const message = renderError(outcome.error)
    return {
      receipt: { outcome: 'spawn_failed', spawnError: message || 'spawn failed' },
      exitStatus: 127,
    }
  }
  if (Number.isInteger(outcome.code)) {
    return {
      receipt: { outcome: 'exited', exitCode: outcome.code },
      exitStatus: outcome.code,
    }
  }
  if (typeof outcome.signal === 'string' && outcome.signal.length > 0) {
    return {
      receipt: { outcome: 'signaled', signal: outcome.signal },
      exitStatus: 128,
    }
  }
  throw new Error('attempt closed without an exit code or signal')
}

async function durableWriteExclusive(path, value) {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`)
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(value)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await link(temporary, path)
    const directory = await open(dirname(path), 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } finally {
    await rm(temporary, { force: true })
  }
}

async function pokeRuntime(pointerPath) {
  if (pointerPath === undefined) return
  try {
    const value = JSON.parse((await readRegularFile(
      pointerPath,
      'runtime poke endpoint pointer',
    )).toString('utf8'))
    assertExactObject(value, RUNTIME_POKE_KEYS, 'runtime poke endpoint pointer')
    if (value.version !== 1) throw new Error('runtime poke endpoint version is invalid')
    assertExactPath(value.socketPath, 'runtime poke socketPath')
    const { sendPoke } = await import('dsh-local-session-messaging/core')
    await sendPoke({ socketPath: value.socketPath }, { timeoutMs: 100 })
  } catch {
    // The durable receipt is authoritative; a poke is only a lossy wakeup hint.
  }
}

async function readRegularFile(path, label) {
  let handle
  try {
    handle = await open(path, READ_REGULAR_FLAGS)
    if (!(await handle.stat()).isFile()) throw new Error(`${label} is not a regular file`)
    return await handle.readFile()
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function assertCanonicalDirectory(path, label) {
  if (await realpath(path) !== path) {
    throw new Error(`${label} is not its exact canonical directory`)
  }
  let handle
  try {
    handle = await open(path, READ_REGULAR_FLAGS)
    if (!(await handle.stat()).isDirectory()) {
      throw new Error(`${label} is not its exact canonical directory`)
    }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function assertCanonicalRegularFile(path, label) {
  if (await realpath(path) !== path) throw new Error(`${label} is not canonical`)
  let handle
  try {
    handle = await open(path, READ_REGULAR_FLAGS)
    if (!(await handle.stat()).isFile()) throw new Error(`${label} is not a regular file`)
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function inspectProcessSnapshot(pid) {
  if (process.platform === 'linux') return await inspectLinuxProcessSnapshot(pid)
  if (process.platform === 'darwin') return await inspectDarwinProcessSnapshot(pid)
  throw new Error(`local tmux runner does not support ${process.platform}`)
}

async function inspectLinuxProcessSnapshot(pid) {
  const before = await readLinuxProcStat(pid)
  const [cmdline, executablePath, bootId] = await Promise.all([
    readFile(`/proc/${pid}/cmdline`),
    realpath(`/proc/${pid}/exe`),
    readLinuxBootId(),
  ])
  const after = await readLinuxProcStat(pid)
  if (before.pid !== after.pid
    || before.pgid !== after.pgid
    || before.startTicks !== after.startTicks) {
    throw new Error('wrapper process changed identity while it was inspected')
  }
  const argv = cmdline.toString('utf8').split('\0')
  if (argv.at(-1) === '') argv.pop()
  if (argv.length === 0) throw new Error('wrapper command line is unavailable')
  return {
    pid: before.pid,
    pgid: before.pgid,
    processStartId: `linux:${before.startTicks}`,
    executablePath,
    argv,
    bootId,
  }
}

async function readLinuxProcStat(pid) {
  const value = await readFile(`/proc/${pid}/stat`, 'utf8')
  const openParenthesis = value.indexOf('(')
  const closeParenthesis = value.lastIndexOf(')')
  if (openParenthesis <= 0 || closeParenthesis <= openParenthesis) {
    throw new Error('wrapper /proc stat record is invalid')
  }
  const parsedPid = Number.parseInt(value.slice(0, openParenthesis).trim(), 10)
  const fields = value.slice(closeParenthesis + 1).trim().split(/\s+/u)
  const pgid = Number.parseInt(fields[2] ?? '', 10)
  const startTicks = fields[19]
  if (parsedPid !== pid
    || !Number.isSafeInteger(pgid)
    || pgid <= 0
    || typeof startTicks !== 'string'
    || !/^[1-9][0-9]*$/u.test(startTicks)) {
    throw new Error('wrapper /proc stat is missing PID, PGID, or start ticks')
  }
  return { pid: parsedPid, pgid, startTicks }
}

async function readLinuxBootId() {
  const value = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value)) {
    throw new Error('Linux boot ID is invalid')
  }
  return `linux:${value}`
}

// Numeric ABI constants and struct layout are from the macOS SDK declarations
// for PROC_PIDTBSDINFO, KERN_PROCARGS2, proc_bsdinfo, and kern.boottime.
function darwinProcessSnapshotScript() {
  return String.raw`
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
}

async function inspectDarwinProcessSnapshot(pid) {
  const result = await execFileAsync(
    '/usr/bin/python3',
    ['-I', '-S', '-c', darwinProcessSnapshotScript(), String(pid)],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 },
  )
  const value = JSON.parse(result.stdout)
  assertRecord(value, 'macOS process snapshot')
  if (value.pid !== pid
    || !Number.isSafeInteger(value.pgid)
    || value.pgid <= 0
    || !Number.isSafeInteger(value.startSec)
    || value.startSec <= 0
    || !Number.isSafeInteger(value.startUsec)
    || value.startUsec < 0
    || value.startUsec > 999_999
    || !Number.isSafeInteger(value.bootSec)
    || value.bootSec <= 0
    || !Number.isSafeInteger(value.bootUsec)
    || value.bootUsec < 0
    || value.bootUsec > 999_999
    || typeof value.executablePath !== 'string'
    || value.executablePath.length === 0
    || !Array.isArray(value.argv)
    || value.argv.length === 0
    || value.argv.some(entry => typeof entry !== 'string')) {
    throw new Error('macOS process snapshot is invalid')
  }
  return {
    pid: value.pid,
    pgid: value.pgid,
    processStartId: `darwin:${value.startSec}:${value.startUsec}`,
    executablePath: value.executablePath,
    argv: value.argv,
    bootId: `darwin:${value.bootSec}:${value.bootUsec}`,
  }
}

function processCommandHash(snapshot) {
  return sha256(
    `autolab-wrapper-process-command-v1\0${canonicalJson({
      executablePath: snapshot.executablePath,
      argv: snapshot.argv,
    })}`,
  )
}

async function run(executable, args) {
  const result = await execFileAsync(executable, args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  })
  return result.stdout.trimEnd()
}

function hashReceipt(domain, value) {
  return sha256(`autolab-local-tmux-${domain}-v1\0${canonicalJson(value)}`)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalJson(value) {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value)
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonical JSON rejects non-finite numbers')
      return JSON.stringify(value)
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
      assertRecord(value, 'canonical JSON object')
      return `{${Object.keys(value).sort().map(key => (
        `${JSON.stringify(key)}:${canonicalJson(value[key])}`
      )).join(',')}}`
    }
    default:
      throw new TypeError(`canonical JSON rejects ${typeof value}`)
  }
}

function assertExactObject(value, keys, label) {
  assertRecord(value, label)
  const actual = Object.keys(value)
  if (actual.length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new Error(`${label} has an invalid schema`)
  }
}

function assertRecord(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
}

function assertPattern(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label} is invalid`)
}

function assertExactPath(value, label) {
  if (typeof value !== 'string' || !isExactAbsolutePath(value)) {
    throw new Error(`${label} must be exact and absolute`)
  }
}

function isExactAbsolutePath(value) {
  return isAbsolute(value) && resolve(value) === value && !value.includes('\0')
}

function renderError(value) {
  return value instanceof Error ? value.message : String(value)
}

function fail(message) {
  process.stderr.write(`attempt-wrapper: ${message}\n`)
  process.exitCode = 1
}
