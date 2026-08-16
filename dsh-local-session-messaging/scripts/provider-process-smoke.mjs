/**
 * Deterministic two-process acceptance for the built local provider.
 *
 * The workers share only one owner-only mailbox directory. Every Agent,
 * Cordis Context, AgentLoop, fake adapter, and Inbox lives in its own process.
 */
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = dirname(scriptDir)
const workerPath = join(scriptDir, 'fixtures', 'provider-worker.mjs')
const SESSION_A = 'process-smoke-root-a'
const SESSION_B = 'process-smoke-root-b'
const WRITER_SESSION = 'process-smoke-writer-fence'
const CONTROL_ID = '00000000-0000-4000-8000-000000000901'
const scratch = await mkdtemp(join(tmpdir(), 'dsh-lsm-process-smoke-'))
const mailboxRoot = join(scratch, 'mailbox')
const workers = new Set()

class WorkerClient {
  #nextRequestId = 1
  #pending = new Map()
  #ready
  #resolveReady
  #rejectReady
  #exit
  #resolveExit
  #exited = false
  #stdout = ''
  #stderr = ''

  constructor(label, sessionId) {
    this.label = label
    this.sessionId = sessionId
    this.#ready = new Promise((resolve, reject) => {
      this.#resolveReady = resolve
      this.#rejectReady = reject
    })
    this.#exit = new Promise(resolve => {
      this.#resolveExit = resolve
    })
    this.child = fork(workerPath, [], {
      cwd: projectRoot,
      env: {
        ...process.env,
        FIXTURE_LABEL: label,
        FIXTURE_SESSION_ID: sessionId,
        FIXTURE_MAILBOX_ROOT: mailboxRoot,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    this.child.stdout.on('data', chunk => { this.#stdout += String(chunk) })
    this.child.stderr.on('data', chunk => { this.#stderr += String(chunk) })
    this.child.on('message', message => this.#onMessage(message))
    this.child.on('error', error => this.#failAll(error))
    this.child.on('exit', (code, signal) => {
      this.#exited = true
      const error = code === 0
        ? new Error(`${label} exited`)
        : new Error(`${label} exited with code=${String(code)} signal=${String(signal)}\n${this.diagnostics()}`)
      this.#rejectReady(error)
      this.#failAll(error)
      this.#resolveExit({ code, signal })
    })
  }

  async ready() {
    await withTimeout(this.#ready, 10_000, `${this.label} readiness`)
    return this
  }

  request(op, fields = {}) {
    if (this.#exited || !this.child.connected) {
      return Promise.reject(new Error(`${this.label} is not connected`))
    }
    const requestId = this.#nextRequestId++
    const response = new Promise((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject })
    })
    this.child.send({ requestId, op, ...fields })
    return withTimeout(response, 10_000, `${this.label} ${op}`).finally(() => {
      this.#pending.delete(requestId)
    })
  }

  async shutdown() {
    if (this.#exited) return
    await this.request('shutdown')
    await withTimeout(this.#exit, 5_000, `${this.label} graceful exit`)
  }

  async terminate() {
    if (this.#exited) return
    this.child.kill('SIGTERM')
    try {
      await withTimeout(this.#exit, 2_000, `${this.label} SIGTERM exit`)
    } catch {
      this.child.kill('SIGKILL')
      await this.#exit
    }
  }

  diagnostics() {
    return [
      this.#stdout.length === 0 ? '' : `${this.label} stdout:\n${this.#stdout}`,
      this.#stderr.length === 0 ? '' : `${this.label} stderr:\n${this.#stderr}`,
    ].filter(Boolean).join('\n')
  }

  #onMessage(message) {
    if (message === null || typeof message !== 'object') return
    if (message.type === 'ready') {
      assert.equal(message.sessionId, this.sessionId)
      this.#resolveReady(message)
      return
    }
    if (message.type === 'fatal') {
      const error = remoteError(message.error)
      this.#rejectReady(error)
      this.#failAll(error)
      return
    }
    if (message.type !== 'response') return
    const pending = this.#pending.get(message.requestId)
    if (pending === undefined) return
    if (message.ok) pending.resolve(message.value)
    else pending.reject(remoteError(message.error))
  }

  #failAll(error) {
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
  }
}

function remoteError(value) {
  const cause = value?.cause === undefined
    ? undefined
    : Object.assign(new Error(value.cause.message ?? String(value.cause)), {
        name: value.cause.name ?? 'Error',
        ...(typeof value.cause.stack === 'string' ? { stack: value.cause.stack } : {}),
        ...(typeof value.cause.code === 'string' ? { code: value.cause.code } : {}),
      })
  const error = new Error(value?.message ?? String(value), { cause })
  error.name = value?.name ?? 'Error'
  if (typeof value?.code === 'string') error.code = value.code
  return error
}

function withTimeout(promise, timeoutMs, label) {
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function startWorker(label, sessionId) {
  const worker = new WorkerClient(label, sessionId)
  workers.add(worker)
  return worker.ready()
}

async function waitUntil(operation, predicate, label, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await operation()
    if (predicate(last)) return last
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`${label} did not converge; last=${JSON.stringify(last)}`)
}

function exactPeer(peers, sessionId, connection) {
  const matches = peers.filter(peer => String(peer.sessionId) === sessionId)
  assert.equal(matches.length, 1, `expected one presence row for ${sessionId}`)
  assert.equal(matches[0].connection, connection)
  return matches[0]
}

async function claimedReceipt(sender, messageId) {
  return waitUntil(
    () => sender.request('getMessage', { messageId }),
    receipt => receipt.status === 'claimed',
    `message ${messageId} claimed`,
  )
}

async function completedControl(sender, controlId) {
  return waitUntil(
    () => sender.request('getControl', { controlId }),
    receipt => receipt.status === 'claimed' && receipt.outcome?.status === 'completed',
    `control ${controlId} completed`,
  )
}

await mkdir(mailboxRoot, { mode: 0o700 })
await chmod(mailboxRoot, 0o700)

let rootA
let rootB
let restartedB
try {
  ;[rootA, rootB] = await Promise.all([
    startWorker('root-A', SESSION_A),
    startWorker('root-B-first-boot', SESSION_B),
  ])

  const [peersA, peersB] = await Promise.all([
    rootA.request('listPeers'),
    rootB.request('listPeers'),
  ])
  exactPeer(peersA, SESSION_B, 'connected')
  exactPeer(peersB, SESSION_A, 'connected')

  const online = await rootA.request('send', {
    recipient: SESSION_B,
    text: 'M0-online-idle-followup',
  })
  assert.ok(
    online.status === 'accepted' || online.status === 'claimed',
    `online send should cross Inbox admission before returning, got ${online.status}`,
  )
  const onlineClaimed = await claimedReceipt(rootA, online.messageId)
  assert.equal(onlineClaimed.status, 'claimed')
  assert.equal(typeof onlineClaimed.acceptedAt, 'number')
  assert.equal(typeof onlineClaimed.claimedAt, 'number')
  await rootB.request('waitIdle')
  const firstBootSnapshot = await rootB.request('snapshot')
  assert.deepEqual(firstBootSnapshot.relays.map(relay => relay.text), ['M0-online-idle-followup'])
  assert.equal(firstBootSnapshot.relays[0].senderSessionId, SESSION_A)
  assert.equal(firstBootSnapshot.relays[0].replySessionId, SESSION_A)
  assert.match(firstBootSnapshot.relays[0].attribution, new RegExp(`\\(${SESSION_A}\\) sent a message`))

  await rootB.shutdown()
  const disconnectedPeers = await waitUntil(
    () => rootA.request('listPeers'),
    peers => peers.some(peer => String(peer.sessionId) === SESSION_B && peer.connection === 'disconnected'),
    'B disconnected presence',
  )
  exactPeer(disconnectedPeers, SESSION_B, 'disconnected')

  const offlineTexts = ['M1-offline', 'M2-offline', 'M3-offline']
  const queued = []
  for (const text of offlineTexts) {
    const receipt = await rootA.request('send', { recipient: SESSION_B, text })
    assert.equal(receipt.status, 'queued')
    queued.push(receipt)
  }
  assert.equal(new Set(queued.map(receipt => receipt.messageId)).size, 3)
  const controlPayload = { action: 'pause', assignment: 'process-smoke' }
  const queuedControl = await rootA.request('sendControl', {
    controlId: CONTROL_ID,
    recipient: SESSION_B,
    kind: 'smoke.control',
    payload: controlPayload,
  })
  assert.equal(queuedControl.status, 'queued')

  restartedB = await startWorker('root-B-second-boot', SESSION_B)
  const reconnectedPeers = await waitUntil(
    () => rootA.request('listPeers'),
    peers => peers.some(peer => String(peer.sessionId) === SESSION_B && peer.connection === 'connected'),
    'B reconnected presence',
  )
  exactPeer(reconnectedPeers, SESSION_B, 'connected')

  const claimed = []
  for (const receipt of queued) claimed.push(await claimedReceipt(rootA, receipt.messageId))
  const control = await completedControl(rootA, CONTROL_ID)
  await restartedB.request('waitIdle')
  const secondBootSnapshot = await restartedB.request('snapshot')

  assert.deepEqual(secondBootSnapshot.relays.map(relay => relay.text), offlineTexts)
  assert.deepEqual(
    secondBootSnapshot.relays.map(relay => relay.envelopeId),
    queued.map(receipt => String(receipt.messageId)),
  )
  assert.equal(new Set(secondBootSnapshot.relays.map(relay => relay.envelopeId)).size, 3)
  assert.ok(secondBootSnapshot.relays.every(relay => relay.senderSessionId === SESSION_A))
  assert.ok(secondBootSnapshot.relays.every(relay => relay.replySessionId === SESSION_A))
  assert.ok(secondBootSnapshot.relays.every(relay => relay.attribution.includes(`(${SESSION_A}) sent a message`)))
  assert.deepEqual(claimed.map(receipt => receipt.status), ['claimed', 'claimed', 'claimed'])
  assert.ok(claimed.every(receipt => typeof receipt.acceptedAt === 'number'))
  assert.ok(claimed.every(receipt => typeof receipt.claimedAt === 'number'))
  assert.deepEqual(control.outcome, {
    status: 'completed',
    completedAt: control.outcome.completedAt,
    result: { handledBy: SESSION_B },
  })
  assert.deepEqual(secondBootSnapshot.handledControls, [{
    controlId: CONTROL_ID,
    senderSessionId: SESSION_A,
    payload: controlPayload,
  }])
  assert.equal(secondBootSnapshot.relays.some(relay => relay.envelopeId === CONTROL_ID), false)
  assert.equal(secondBootSnapshot.turns, offlineTexts.length)

  const duplicateControl = await rootA.request('sendControl', {
    controlId: CONTROL_ID,
    recipient: SESSION_B,
    kind: 'smoke.control',
    payload: { assignment: 'process-smoke', action: 'pause' },
  })
  assert.deepEqual(duplicateControl, control)
  const deduplicatedSnapshot = await restartedB.request('snapshot')
  assert.equal(deduplicatedSnapshot.handledControls.length, 1)

  await rootA.request('blockPeer', { recipient: SESSION_B, blocked: true })
  await assert.rejects(
    rootA.request('send', { recipient: SESSION_B, text: 'must-be-denied' }),
    error => error?.code === 'PERMISSION_DENIED',
  )
  await rootA.request('blockPeer', { recipient: SESSION_B, blocked: false })

  const firstWriter = await rootA.request('reserveWriter', { sessionId: WRITER_SESSION })
  assert.equal(firstWriter.sessionId, WRITER_SESSION)
  assert.equal(firstWriter.fenceToken, 1)
  await assert.rejects(
    restartedB.request('reserveWriter', { sessionId: WRITER_SESSION }),
    error => error?.code === 'SESSION_CONFLICT',
  )

  // Terminate without Cordis teardown. The durable row remains active, and a
  // different process may replace it only after PID/start/boot proves death.
  await rootA.terminate()
  const recoveredWriter = await restartedB.request('reserveWriter', {
    sessionId: WRITER_SESSION,
  })
  assert.equal(recoveredWriter.fenceToken, firstWriter.fenceToken + 1)
  assert.notEqual(recoveredWriter.instanceId, firstWriter.instanceId)
  assert.notEqual(recoveredWriter.ownerToken, firstWriter.ownerToken)
  await restartedB.request('releaseWriter', { sessionId: WRITER_SESSION })

  const mailboxMode = (await stat(mailboxRoot)).mode & 0o777
  assert.equal(mailboxMode, 0o700)
  assert.ok((await stat(join(mailboxRoot, 'mailbox.sqlite3'))).isFile())

  console.log('DSH rc.6 two-process provider smoke passed')
  console.log(JSON.stringify({
    discovery: [SESSION_A, SESSION_B],
    online: onlineClaimed.status,
    offline: claimed.map(receipt => receipt.status),
    control: control.outcome.status,
    fifo: secondBootSnapshot.relays.map(relay => relay.text),
    pairBlock: 'PERMISSION_DENIED',
    writerFence: `${firstWriter.fenceToken}->${recoveredWriter.fenceToken}`,
    mailboxMode: mailboxMode.toString(8),
  }))
} catch (error) {
  for (const worker of workers) {
    const diagnostics = worker.diagnostics()
    if (diagnostics.length > 0) console.error(diagnostics)
  }
  throw error
} finally {
  await Promise.allSettled([...workers].map(worker => worker.terminate()))
  if (process.env.KEEP_DSH_PROCESS_SMOKE === '1') {
    console.log(`Preserved process-smoke directory: ${scratch}`)
  } else {
    const expectedPrefix = join(tmpdir(), 'dsh-lsm-process-smoke-')
    assert.ok(scratch.startsWith(expectedPrefix), `refusing to clean unexpected path ${scratch}`)
    await rm(scratch, { recursive: true, force: true })
  }
}
