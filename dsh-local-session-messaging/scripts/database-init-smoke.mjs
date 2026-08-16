/**
 * Repeated, barrier-synchronized cold initialization of one shared mailbox.
 *
 * Run after `pnpm build`.  Every round starts several real Node processes,
 * releases them onto one absent database path at once, and verifies the
 * committed schema plus owner-only main/WAL/SHM files.
 */
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = dirname(scriptDir)
const workerPath = join(scriptDir, 'fixtures', 'database-init-worker.mjs')
const rounds = positiveInteger(process.env.DSH_DATABASE_INIT_ROUNDS ?? '6', 'rounds')
const workerCount = positiveInteger(process.env.DSH_DATABASE_INIT_WORKERS ?? '4', 'workers')
const scratch = await mkdtemp(join(tmpdir(), 'dsh-lsm-database-init-'))
const liveWorkers = new Set()

function positiveInteger(value, label) {
  const parsed = Number(value)
  assert.ok(Number.isSafeInteger(parsed) && parsed > 0, `${label} must be a positive integer`)
  return parsed
}

function withTimeout(promise, timeoutMs, label) {
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function remoteError(value) {
  const cause = value?.cause === undefined
    ? undefined
    : Object.assign(new Error(value.cause.message ?? String(value.cause)), {
        name: value.cause.name ?? 'Error',
        ...(typeof value.cause.stack === 'string' ? { stack: value.cause.stack } : {}),
        ...(typeof value.cause.code === 'string' ? { code: value.cause.code } : {}),
        ...(typeof value.cause.errcode === 'number' ? { errcode: value.cause.errcode } : {}),
        ...(typeof value.cause.errstr === 'string' ? { errstr: value.cause.errstr } : {}),
      })
  return Object.assign(new Error(value?.message ?? String(value), { cause }), {
    name: value?.name ?? 'Error',
    ...(typeof value?.stack === 'string' ? { stack: value.stack } : {}),
    ...(typeof value?.code === 'string' ? { code: value.code } : {}),
  })
}

class InitWorker {
  #waiting
  #resolveWaiting
  #opened
  #resolveOpened
  #openedReject
  #closed
  #resolveClosed
  #closedReject
  #reject
  #stdout = ''
  #stderr = ''

  constructor(path, label) {
    this.label = label
    this.#waiting = new Promise((resolve, reject) => {
      this.#resolveWaiting = resolve
      this.#reject = reject
    })
    this.#opened = new Promise((resolve, reject) => {
      this.#resolveOpened = resolve
      this.#openedReject = reject
    })
    this.#closed = new Promise((resolve, reject) => {
      this.#resolveClosed = resolve
      this.#closedReject = reject
    })
    this.child = fork(workerPath, [], {
      cwd: projectRoot,
      env: {
        ...process.env,
        FIXTURE_DATABASE_PATH: path,
        FIXTURE_LABEL: label,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    liveWorkers.add(this)
    this.child.stdout.on('data', chunk => { this.#stdout += String(chunk) })
    this.child.stderr.on('data', chunk => { this.#stderr += String(chunk) })
    this.child.on('message', message => this.#onMessage(message))
    this.child.on('error', error => this.#fail(error))
    this.child.on('exit', (code, signal) => {
      if (code !== 0) {
        this.#fail(new Error(
          `${label} exited with code=${String(code)} signal=${String(signal)}\n${this.diagnostics()}`,
        ))
      }
    })
  }

  waiting() {
    return withTimeout(this.#waiting, 10_000, `${this.label} barrier readiness`)
  }

  open() {
    this.child.send({ op: 'open' })
    return withTimeout(this.#opened, 10_000, `${this.label} database open`)
  }

  close() {
    if (!this.child.connected) return Promise.resolve()
    this.child.send({ op: 'close' })
    return withTimeout(this.#closed, 10_000, `${this.label} database close`)
  }

  terminate() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    this.child.kill('SIGTERM')
  }

  diagnostics() {
    return [
      this.#stdout.length === 0 ? '' : `${this.label} stdout:\n${this.#stdout}`,
      this.#stderr.length === 0 ? '' : `${this.label} stderr:\n${this.#stderr}`,
    ].filter(Boolean).join('\n')
  }

  #onMessage(message) {
    if (message?.type === 'waiting') this.#resolveWaiting()
    else if (message?.type === 'opened') this.#resolveOpened()
    else if (message?.type === 'closed') {
      this.#resolveClosed()
      liveWorkers.delete(this)
    } else if (message?.type === 'fatal') this.#fail(remoteError(message.error))
  }

  #fail(error) {
    this.#reject(error)
    this.#openedReject(error)
    this.#closedReject(error)
  }
}

async function assertOwnerOnly(path) {
  const mode = (await stat(path)).mode & 0o777
  assert.equal(mode, 0o600, `${path} mode must be 0600`)
}

try {
  for (let round = 1; round <= rounds; round += 1) {
    const root = join(scratch, `round-${round}`)
    const path = join(root, 'mailbox.sqlite3')
    await mkdir(root, { mode: 0o700 })
    await chmod(root, 0o700)
    const workers = Array.from(
      { length: workerCount },
      (_unused, index) => new InitWorker(path, `round-${round}-worker-${index + 1}`),
    )
    await Promise.all(workers.map(worker => worker.waiting()))
    await Promise.all(workers.map(worker => worker.open()))

    await assertOwnerOnly(path)
    await assertOwnerOnly(`${path}-wal`)
    await assertOwnerOnly(`${path}-shm`)

    await Promise.all(workers.map(worker => worker.close()))
    const inspector = new DatabaseSync(path, { readOnly: true })
    try {
      assert.equal(inspector.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
      assert.equal(inspector.prepare('PRAGMA user_version').get().user_version, 4)
      const tables = inspector.prepare(`
        SELECT name FROM sqlite_schema
        WHERE type = 'table' AND name IN (
          'control_outcomes', 'messages', 'pair_blocks', 'presence',
          'session_policies', 'session_writers'
        )
        ORDER BY name
      `).all().map(row => row.name)
      assert.deepEqual(tables, [
        'control_outcomes',
        'messages',
        'pair_blocks',
        'presence',
        'session_policies',
        'session_writers',
      ])
    } finally {
      inspector.close()
    }
  }
  console.log(`MessagingDatabase concurrent cold-start smoke passed: ${rounds} rounds x ${workerCount} processes`)
} catch (error) {
  for (const worker of liveWorkers) {
    const diagnostics = worker.diagnostics()
    if (diagnostics.length > 0) console.error(diagnostics)
  }
  throw error
} finally {
  for (const worker of liveWorkers) worker.terminate()
  if (process.env.KEEP_DSH_DATABASE_INIT_SMOKE === '1') {
    console.log(`Preserved database-init smoke directory: ${scratch}`)
  } else {
    const expectedPrefix = join(tmpdir(), 'dsh-lsm-database-init-')
    assert.ok(scratch.startsWith(expectedPrefix), `refusing to clean unexpected path ${scratch}`)
    await rm(scratch, { recursive: true, force: true })
  }
}
