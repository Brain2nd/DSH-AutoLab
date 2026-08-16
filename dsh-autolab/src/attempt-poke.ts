import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createPokeServer,
  type PokeServer,
} from 'dsh-local-session-messaging/core'

import { durableWriteFile } from './artifacts.js'

export interface AttemptPokeEndpoint {
  /** Stable pointer embedded in immutable Attempt launch requests. */
  readonly pointerPath: string
  /** Current process-local endpoint. The pointer is atomically replaced on restart. */
  readonly socketPath: string
  close(): Promise<void>
}

/**
 * Publish one lossy wakeup endpoint for Attempt receipt events. The socket
 * carries no Attempt identity or state; callers always reread active durable
 * Attempt references before doing work.
 */
export async function openAttemptPokeEndpoint(input: {
  readonly root: string
  readonly onPoke: () => void
  readonly onError?: (error: unknown) => void
}): Promise<AttemptPokeEndpoint> {
  const server: PokeServer = await createPokeServer({
    socketDir: shortSocketDirectory(input.root),
    onPoke: input.onPoke,
    ...(input.onError === undefined ? {} : { onError: input.onError }),
  })
  const pointerPath = join(input.root, 'runtime-poke.json')
  try {
    await durableWriteFile(pointerPath, `${JSON.stringify({
      version: 1,
      socketPath: server.endpoint.socketPath,
    })}\n`, true)
  } catch (error) {
    await server.close()
    throw error
  }

  return {
    pointerPath,
    socketPath: server.endpoint.socketPath,
    close: () => server.close(),
  }
}

function shortSocketDirectory(root: string): string {
  const uid = process.getuid?.() ?? 'user'
  const digest = createHash('sha256').update(root).digest('hex').slice(0, 12)
  // macOS TMPDIR normally expands under /var/folders and exceeds sockaddr_un
  // once the notifier adds a random socket name. /tmp is the stable short
  // spelling; createPokeServer still owner-checks the child directory as 0700.
  const base = process.platform === 'darwin' ? '/tmp' : tmpdir()
  return join(base, `dsh-autolab-${uid}-${digest}`)
}
