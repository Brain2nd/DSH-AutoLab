import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

import { durableWriteFile } from './artifacts.js'
import { canonicalJson, sha256 } from './integrity.js'
import { parseRolePacket, type RolePacket } from './packet.js'

const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export interface FreezePostflightResultInput {
  /** Absolute path of the exact Postflight Judge Role Packet. */
  readonly rolePacketPath: string
  /** Hash projected by RuntimeState for that exact Packet. */
  readonly rolePacketHash: string
  /** Controller-owned immutable destination for the raw Judge receipt. */
  readonly artifactPath: string
}

export interface FrozenPostflightResult {
  readonly rolePacketPath: string
  readonly rolePacketHash: string
  readonly receiptPath: string
  readonly artifactPath: string
  readonly receiptHash: string
  readonly receiptBytes: Buffer
  readonly expectedHashBinding: string
  readonly packet: RolePacket
}

export class PostflightResultError extends Error {
  readonly name = 'PostflightResultError'

  constructor(
    message: string,
    readonly code:
      | 'INVALID_INPUT'
      | 'PACKET_READ_FAILED'
      | 'PACKET_HASH_MISMATCH'
      | 'INVALID_PACKET'
      | 'ROLE_MISMATCH'
      | 'RECEIPT_READ_FAILED'
      | 'ARTIFACT_WRITE_FAILED'
      | 'ARTIFACT_CONFLICT',
  ) {
    super(message)
  }
}

/**
 * Freeze the exact receipt named by a Postflight Packet. Receipt bytes remain
 * opaque: no JSON parse, generic verdict enum, scientific check, or referenced
 * log/checkpoint read occurs on this Runtime path.
 */
export async function freezePostflightResult(
  input: FreezePostflightResultInput,
): Promise<FrozenPostflightResult> {
  const packetPath = validatePath(input.rolePacketPath, 'Role Packet path')
  const artifactPath = validatePath(input.artifactPath, 'artifact path')
  if (!SHA256_PATTERN.test(input.rolePacketHash)) {
    throw new PostflightResultError('Role Packet hash must be SHA-256', 'INVALID_INPUT')
  }
  if (packetPath === artifactPath) {
    throw new PostflightResultError(
      'Controller artifact path must differ from the Judge receipt path',
      'INVALID_INPUT',
    )
  }

  const packetBytes = await readBytes(packetPath, 'Role Packet')
  const observedPacketHash = sha256(packetBytes)
  if (observedPacketHash !== input.rolePacketHash) {
    throw new PostflightResultError(
      'Role Packet bytes do not match the supplied hash',
      'PACKET_HASH_MISMATCH',
    )
  }
  const packet = parsePacket(packetBytes)
  if (packet.header.role_kind !== 'postflight_judge') {
    throw new PostflightResultError(
      `Role Packet role_kind is ${JSON.stringify(packet.header.role_kind)}, not "postflight_judge"`,
      'ROLE_MISMATCH',
    )
  }

  const receiptPath = validatePath(packet.output_contract.receipt_path, 'receipt path')
  if (receiptPath === artifactPath) {
    throw new PostflightResultError(
      'Controller artifact path must differ from the Judge receipt path',
      'INVALID_INPUT',
    )
  }
  const receiptBytes = await readBytes(receiptPath, 'Postflight receipt')
  await freezeNoClobber(artifactPath, receiptBytes)
  return {
    rolePacketPath: packetPath,
    rolePacketHash: observedPacketHash,
    receiptPath,
    artifactPath,
    receiptHash: sha256(receiptBytes),
    receiptBytes,
    expectedHashBinding: packet.output_contract.expected_hash_binding,
    packet,
  }
}

function parsePacket(bytes: Buffer): RolePacket {
  let text: string
  let packet: RolePacket
  try {
    text = UTF8.decode(bytes)
    packet = parseRolePacket(JSON.parse(text) as unknown)
  } catch (error) {
    throw new PostflightResultError(
      `Role Packet is not valid canonical JSON: ${errorMessage(error)}`,
      'INVALID_PACKET',
    )
  }
  if (canonicalJson(packet) !== text) {
    throw new PostflightResultError(
      'Role Packet bytes are not its canonical immutable form',
      'INVALID_PACKET',
    )
  }
  return packet
}

async function freezeNoClobber(path: string, bytes: Buffer): Promise<void> {
  try {
    await durableWriteFile(path, bytes, false)
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') {
      throw new PostflightResultError(
        `Cannot write immutable Postflight artifact at ${path}: ${errorMessage(error)}`,
        'ARTIFACT_WRITE_FAILED',
      )
    }
  }
  let committed: Buffer
  try {
    committed = await readFile(path)
  } catch (error) {
    throw new PostflightResultError(
      `Immutable Postflight artifact cannot be read at ${path}: ${errorMessage(error)}`,
      'ARTIFACT_CONFLICT',
    )
  }
  if (!committed.equals(bytes)) {
    throw new PostflightResultError(
      `Immutable Postflight artifact conflicts at ${path}`,
      'ARTIFACT_CONFLICT',
    )
  }
}

async function readBytes(path: string, label: 'Role Packet' | 'Postflight receipt'): Promise<Buffer> {
  try {
    return await readFile(path)
  } catch (error) {
    throw new PostflightResultError(
      `${label} cannot be read at ${path}: ${errorMessage(error)}`,
      label === 'Role Packet' ? 'PACKET_READ_FAILED' : 'RECEIPT_READ_FAILED',
    )
  }
}

function validatePath(value: string, label: string): string {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new PostflightResultError(`${label} must be absolute`, 'INVALID_INPUT')
  }
  return resolve(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}
