import { createHash, timingSafeEqual } from 'node:crypto'

import {
  canonicalJson,
  MessagingError,
  type JsonValue,
} from './domain.js'

const CONTROL_KIND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u
const PAYLOAD_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u

/** Private wire payload stored inside the existing durable mailbox row. */
export interface DurableControlPayload {
  readonly version: 1
  readonly type: 'control'
  readonly kind: string
  readonly payload: JsonValue
  readonly payloadHash: string
}

export function controlPayloadHash(payload: JsonValue): string {
  return `sha256:${createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex')}`
}

export function validateControlKind(value: string): string {
  if (typeof value !== 'string' || !CONTROL_KIND_PATTERN.test(value)) {
    throw new MessagingError(
      'INVALID_ARGUMENT',
      'control kind must be 1-128 ASCII letters, digits, dot, underscore, colon, slash, or hyphen',
    )
  }
  return value
}

export function validateControlPayloadHash(value: string, payload: JsonValue): string {
  if (typeof value !== 'string' || !PAYLOAD_HASH_PATTERN.test(value)) {
    throw new MessagingError('INVALID_ARGUMENT', 'payloadHash must be a lowercase sha256 digest')
  }
  const expected = controlPayloadHash(payload)
  if (!timingSafeEqual(Buffer.from(value, 'ascii'), Buffer.from(expected, 'ascii'))) {
    throw new MessagingError('INVALID_ARGUMENT', 'payloadHash does not match the canonical payload')
  }
  return value
}

export function durableControlPayload(
  kindInput: string,
  payload: JsonValue,
  payloadHashInput: string,
): DurableControlPayload {
  const kind = validateControlKind(kindInput)
  const payloadHash = validateControlPayloadHash(payloadHashInput, payload)
  // canonicalJson performs the runtime JsonValue validation before persistence.
  canonicalJson(payload)
  return { version: 1, type: 'control', kind, payload, payloadHash }
}

export function parseDurableControlPayload(value: JsonValue): DurableControlPayload {
  if (!isRecord(value)
    || value.version !== 1
    || value.type !== 'control'
    || typeof value.kind !== 'string'
    || typeof value.payloadHash !== 'string'
    || !('payload' in value)) {
    throw new MessagingError('INVALID_ARGUMENT', 'durable control payload is malformed')
  }
  return durableControlPayload(
    value.kind,
    value.payload as JsonValue,
    value.payloadHash,
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
