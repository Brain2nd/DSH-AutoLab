import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
} from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { basename, dirname, isAbsolute, join } from 'node:path'

import { MessagingError, type PokeEndpoint } from './domain.js'

const POKE_BYTE = 0x01
const DEFAULT_CONNECTION_TIMEOUT_MS = 1_000
const DEFAULT_SEND_TIMEOUT_MS = 500
const SOCKET_NAME_PATTERN = /^[a-zA-Z0-9._-]+\.sock$/u

export interface PokeServerOptions {
  /** Dedicated, absolute, owner-only directory. */
  readonly socketDir: string
  /** Optional deterministic test name; production defaults to a random name. */
  readonly socketName?: string
  /** Coalesced callback; the database must be reread for authoritative work. */
  readonly onPoke: () => void
  readonly onError?: (error: unknown) => void
  readonly connectionTimeoutMs?: number
}

export interface SendPokeOptions {
  readonly timeoutMs?: number
}

export interface PokeServer {
  readonly endpoint: PokeEndpoint
  close(): Promise<void>
}

/**
 * Create a best-effort one-byte Unix-domain socket notifier.
 *
 * The socket carries no message payload, ACK, identity, or ordering fact.  A
 * valid byte merely asks the receiver to poll SQLite.  Consequently a dropped,
 * duplicated, forged-by-the-same-uid, or coalesced poke cannot corrupt state.
 */
export async function createPokeServer(options: PokeServerOptions): Promise<PokeServer> {
  const socketDir = prepareSocketDirectory(options.socketDir)
  const socketName = validateSocketName(options.socketName ?? `poke-${randomUUID()}.sock`)
  const socketPath = join(socketDir, socketName)
  validateUnixSocketPath(socketPath)
  if (existsSync(socketPath)) {
    throw new MessagingError('ENDPOINT_IN_USE', `socket endpoint already exists: ${socketPath}`)
  }
  const connectionTimeoutMs = positiveSafeInteger(
    options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    'connectionTimeoutMs',
  )
  if (typeof options.onPoke !== 'function') {
    throw new MessagingError('INVALID_ARGUMENT', 'onPoke must be a function')
  }

  const sockets = new Set<Socket>()
  let callbackQueued = false
  let closed = false
  const reportError = (error: unknown): void => {
    try {
      options.onError?.(error)
    } catch {
      // A diagnostic callback must not take down the notifier.
    }
  }
  const schedulePoke = (): void => {
    if (callbackQueued || closed) return
    callbackQueued = true
    queueMicrotask(() => {
      callbackQueued = false
      if (closed) return
      try {
        options.onPoke()
      } catch (error) {
        reportError(error)
      }
    })
  }

  const server = createServer(socket => {
    sockets.add(socket)
    socket.setTimeout(connectionTimeoutMs)
    let length = 0
    let valid = true
    socket.on('data', chunk => {
      for (const byte of chunk) {
        length += 1
        if (length !== 1 || byte !== POKE_BYTE) valid = false
        if (length > 1) {
          socket.destroy()
          return
        }
      }
    })
    socket.on('end', () => {
      if (valid && length === 1) schedulePoke()
    })
    socket.on('timeout', () => socket.destroy())
    socket.on('error', reportError)
    socket.on('close', () => sockets.delete(socket))
  })
  server.maxConnections = 128

  try {
    await listen(server, socketPath)
    // The directory is already 0700, so the bind-to-chmod interval is not
    // observable by another uid.  Do not publish the endpoint before this.
    chmodSync(socketPath, 0o600)
    assertSecureSocket(socketPath)
  } catch (error) {
    await closeServer(server, sockets)
    // Before `listen` succeeds this process does not own the pathname and must
    // never unlink it.  After success, Node's server.close() removes exactly the
    // Unix socket created by that server abstraction.
    if (error instanceof MessagingError) throw error
    throw new MessagingError('ENDPOINT_IN_USE', `failed to bind socket ${socketPath}`, { cause: error })
  }

  return {
    endpoint: { socketPath },
    async close(): Promise<void> {
      if (closed) return
      closed = true
      await closeServer(server, sockets)
    },
  }
}

/**
 * Best-effort poke.  `false` means the endpoint was absent, invalid at the
 * filesystem boundary, timed out, or refused the connection; callers rely on
 * polling and must never translate it into message failure.
 */
export async function sendPoke(
  endpoint: PokeEndpoint,
  options: SendPokeOptions = {},
): Promise<boolean> {
  const timeoutMs = positiveSafeInteger(options.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS, 'timeoutMs')
  let socketPath: string
  try {
    socketPath = validateEndpointForConnect(endpoint)
  } catch (error) {
    if (error instanceof MessagingError && error.code === 'ENDPOINT_IN_USE') return false
    throw error
  }

  return await new Promise<boolean>(resolve => {
    let settled = false
    let wrote = false
    const settle = (result: boolean, destroy = true): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (destroy) socket.destroy()
      resolve(result)
    }
    const socket = createConnection({ path: socketPath })
    const timer = setTimeout(() => settle(false), timeoutMs)
    timer.unref()
    socket.once('connect', () => {
      socket.end(Buffer.from([POKE_BYTE]), () => {
        wrote = true
      })
    })
    socket.once('error', () => settle(false))
    socket.once('close', hadError => settle(wrote && !hadError, false))
  })
}

/** Validate and return an endpoint without exposing a cached filesystem fact. */
export function validatePokeEndpoint(endpoint: PokeEndpoint): PokeEndpoint {
  return { socketPath: validateEndpointForConnect(endpoint) }
}

function prepareSocketDirectory(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || !isAbsolute(value)) {
    throw new MessagingError('INVALID_ARGUMENT', 'socketDir must be an absolute non-NUL path')
  }
  mkdirSync(value, { recursive: true, mode: 0o700 })
  const stats = lstatSync(value)
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new MessagingError('INSECURE_PATH', 'socketDir must be a real directory')
  }
  assertCurrentOwner(stats.uid, value)
  if ((stats.mode & 0o077) !== 0) {
    throw new MessagingError('INSECURE_PATH', 'socketDir must not be group/world accessible')
  }
  return value
}

function validateSocketName(value: string): string {
  if (!SOCKET_NAME_PATTERN.test(value) || basename(value) !== value) {
    throw new MessagingError('INVALID_ARGUMENT', 'socketName must be a simple .sock filename')
  }
  return value
}

function validateEndpointForConnect(endpoint: PokeEndpoint): string {
  if (endpoint === null || typeof endpoint !== 'object') {
    throw new MessagingError('INVALID_ARGUMENT', 'endpoint must be an object')
  }
  const socketPath = endpoint.socketPath
  if (typeof socketPath !== 'string'
    || socketPath.length === 0
    || socketPath.includes('\0')
    || !isAbsolute(socketPath)) {
    throw new MessagingError('INVALID_ARGUMENT', 'endpoint socketPath must be absolute and non-NUL')
  }
  validateUnixSocketPath(socketPath)
  const directory = dirname(socketPath)
  if (!existsSync(directory) || !existsSync(socketPath)) {
    throw new MessagingError('ENDPOINT_IN_USE', 'endpoint is not currently available')
  }
  const directoryStats = lstatSync(directory)
  if (!directoryStats.isDirectory()
    || directoryStats.isSymbolicLink()
    || (directoryStats.mode & 0o077) !== 0) {
    throw new MessagingError('INSECURE_PATH', 'endpoint directory is not owner-only')
  }
  assertCurrentOwner(directoryStats.uid, directory)
  assertSecureSocket(socketPath)
  return socketPath
}

function assertSecureSocket(socketPath: string): void {
  const stats = lstatSync(socketPath)
  if (!stats.isSocket() || stats.isSymbolicLink()) {
    throw new MessagingError('INSECURE_PATH', 'endpoint is not a Unix-domain socket')
  }
  assertCurrentOwner(stats.uid, socketPath)
  if ((stats.mode & 0o077) !== 0) {
    throw new MessagingError('INSECURE_PATH', 'endpoint socket must be owner-only')
  }
}

function validateUnixSocketPath(socketPath: string): void {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new MessagingError('INVALID_ARGUMENT', 'Unix-domain notifier supports macOS and Linux only')
  }
  const maxBytes = process.platform === 'darwin' ? 103 : 107
  if (Buffer.byteLength(socketPath, 'utf8') > maxBytes) {
    throw new MessagingError(
      'INVALID_ARGUMENT',
      `Unix-domain socket path exceeds ${maxBytes} bytes on ${process.platform}`,
    )
  }
}

function assertCurrentOwner(uid: number, path: string): void {
  const getuid = process.getuid
  if (getuid !== undefined && uid !== getuid()) {
    throw new MessagingError('INSECURE_PATH', `${JSON.stringify(path)} is owned by another user`)
  }
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(socketPath)
  })
}

async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy()
  if (!server.listening) return
  await new Promise<void>(resolve => server.close(() => resolve()))
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new MessagingError('INVALID_ARGUMENT', `${name} must be a positive safe integer`)
  }
  return value
}
