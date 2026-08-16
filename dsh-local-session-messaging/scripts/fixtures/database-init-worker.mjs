/** One barrier-synchronized production MessagingDatabase opener. */
import { MessagingDatabase } from '../../lib/core.js'

const path = requiredEnv('FIXTURE_DATABASE_PATH')
const label = requiredEnv('FIXTURE_LABEL')
let database

function requiredEnv(name) {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`)
  return value
}

function send(value) {
  if (process.connected) process.send(value)
}

function plainError(error) {
  const cause = error instanceof Error ? error.cause : undefined
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    ...(error !== null && typeof error === 'object' && typeof error.code === 'string'
      ? { code: error.code }
      : {}),
    ...(cause instanceof Error
      ? {
          cause: {
            name: cause.name,
            message: cause.message,
            stack: cause.stack,
            ...(typeof cause.code === 'string' ? { code: cause.code } : {}),
            ...(typeof cause.errcode === 'number' ? { errcode: cause.errcode } : {}),
            ...(typeof cause.errstr === 'string' ? { errstr: cause.errstr } : {}),
          },
        }
      : {}),
  }
}

process.on('message', message => {
  if (message?.op === 'open') {
    try {
      database = new MessagingDatabase({ path })
      send({ type: 'opened', label })
    } catch (error) {
      send({ type: 'fatal', label, error: plainError(error) })
      process.exitCode = 1
      process.disconnect()
    }
    return
  }
  if (message?.op === 'close') {
    database?.close()
    send({ type: 'closed', label })
    process.disconnect()
  }
})

send({ type: 'waiting', label })
