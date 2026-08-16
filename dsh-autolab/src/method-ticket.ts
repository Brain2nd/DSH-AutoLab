import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

import { z } from 'zod'

import { durableWriteFile } from './artifacts.js'
import { canonicalJson, sha256 } from './integrity.js'
import { parseRolePacket, type RolePacket } from './packet.js'

const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

const nonBlank = z.string().min(1).refine(value => value.trim().length > 0, 'must not be blank')
const hash = z.string().regex(SHA256_PATTERN)

/**
 * Runtime owns only the Method submission identity. The Method Session and
 * Preflight Judge define and interpret the Lab-specific payload in `content`.
 */
export const methodDesignTicketSchema = z.object({
  assignment_id: nonBlank,
  assignment_contract_sha256: hash,
  role_packet_sha256: hash,
  candidate_id: nonBlank,
  content: z.json(),
}).strict()

export type MethodDesignTicket = z.infer<typeof methodDesignTicketSchema>

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** JSON Schema embedded verbatim in a Method Role Packet output contract. */
export function methodDesignTicketOutputSchema(): JsonValue {
  return z.toJSONSchema(methodDesignTicketSchema) as JsonValue
}

export const METHOD_TICKET_HASH_BINDING = 'role_packet_sha256'

export interface FrozenMethodDesignTicket {
  readonly assignmentId: string
  readonly candidateId: string
  readonly rolePacketPath: string
  readonly rolePacketHash: string
  readonly sourceAssignmentPath: string
  readonly sourceAssignmentHash: string
  readonly sourceReceiptPath: string
  readonly artifactPath: string
  readonly artifactHash: string
  readonly ticket: MethodDesignTicket
}

export class MethodTicketError extends Error {
  readonly name = 'MethodTicketError'

  constructor(
    message: string,
    readonly code:
      | 'INVALID_INPUT'
      | 'INVALID_PACKET'
      | 'PACKET_HASH_MISMATCH'
      | 'OUTPUT_CONTRACT_MISMATCH'
      | 'INVALID_TICKET'
      | 'ASSIGNMENT_MISMATCH'
      | 'HASH_BINDING_MISMATCH'
      | 'ANCHOR_MISMATCH'
      | 'ARTIFACT_CONFLICT',
    readonly issues: readonly z.core.$ZodIssue[] = [],
  ) {
    super(message)
  }
}

export function parseMethodDesignTicket(value: unknown): MethodDesignTicket {
  const parsed = methodDesignTicketSchema.safeParse(value)
  if (!parsed.success) {
    throw new MethodTicketError(
      `Method Design Ticket is invalid: ${formatIssues(parsed.error.issues)}`,
      'INVALID_TICKET',
      parsed.error.issues,
    )
  }
  return parsed.data
}

/**
 * Freeze the exact Method receipt bytes selected by the current Role Packet.
 * Runtime verifies only packet/Assignment identity and immutable byte binding;
 * it does not inspect or reinterpret the Lab-specific Method content.
 */
export async function freezeMethodDesignTicket(input: {
  rolePacketPath: string
  rolePacketHash: string
  reviewArtifactPath: string
}): Promise<FrozenMethodDesignTicket> {
  validateFreezeInput(input)
  const rolePacketPath = resolve(input.rolePacketPath)
  const artifactPath = resolve(input.reviewArtifactPath)
  const packetBytes = await readBytes(rolePacketPath, 'Role Packet', 'INVALID_PACKET')
  const observedPacketHash = sha256(packetBytes)
  if (observedPacketHash !== input.rolePacketHash) {
    throw new MethodTicketError(
      'Role Packet bytes do not match the expected hash',
      'PACKET_HASH_MISMATCH',
    )
  }
  const packet = parseExactMethodPacket(packetBytes)
  validateOutputContract(packet)
  const sourceAssignment = await readSourceAssignment(packet)

  const sourceReceiptPath = resolve(packet.output_contract.receipt_path)
  if (sourceReceiptPath === artifactPath) {
    throw new MethodTicketError(
      'Review artifact must be distinct from the mutable Method receipt',
      'INVALID_INPUT',
    )
  }
  const receiptBytes = await readBytes(sourceReceiptPath, 'Method receipt', 'INVALID_TICKET')
  const ticket = parseTicketBytes(receiptBytes)
  validateTicketBindings(ticket, packet, observedPacketHash)

  try {
    await durableWriteFile(artifactPath, receiptBytes, false)
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') throw error
  }
  const committed = await readBytes(artifactPath, 'review artifact', 'ARTIFACT_CONFLICT')
  if (!Buffer.from(committed).equals(Buffer.from(receiptBytes))) {
    throw new MethodTicketError(
      `Immutable review artifact conflicts at ${artifactPath}`,
      'ARTIFACT_CONFLICT',
    )
  }
  return {
    assignmentId: ticket.assignment_id,
    candidateId: ticket.candidate_id,
    rolePacketPath,
    rolePacketHash: observedPacketHash,
    sourceAssignmentPath: sourceAssignment.path,
    sourceAssignmentHash: sourceAssignment.sha256,
    sourceReceiptPath,
    artifactPath,
    artifactHash: sha256(committed),
    ticket,
  }
}

async function readSourceAssignment(
  packet: RolePacket,
): Promise<{ readonly path: string; readonly sha256: string }> {
  const matches = packet.verbatim_blocks.assignment.filter(block => (
    block.text_sha256 === packet.anchors.assignment_contract_sha256
  ))
  if (matches.length !== 1 || !isAbsolute(matches[0]!.source_path)) {
    throw new MethodTicketError(
      'Role Packet does not identify one exact Assignment contract',
      'ANCHOR_MISMATCH',
    )
  }
  const block = matches[0]!
  const path = resolve(block.source_path)
  const bytes = await readBytes(path, 'Assignment contract', 'ANCHOR_MISMATCH')
  if (sha256(bytes) !== block.text_sha256
    || !Buffer.from(bytes).equals(Buffer.from(block.exact_text, 'utf8'))) {
    throw new MethodTicketError(
      'Assignment contract bytes do not match the Role Packet anchor',
      'ANCHOR_MISMATCH',
    )
  }
  return { path, sha256: block.text_sha256 }
}

function validateFreezeInput(input: {
  rolePacketPath: string
  rolePacketHash: string
  reviewArtifactPath: string
}): void {
  if (!isAbsolute(input.rolePacketPath)
    || !isAbsolute(input.reviewArtifactPath)
    || !SHA256_PATTERN.test(input.rolePacketHash)) {
    throw new MethodTicketError(
      'Role Packet path, review artifact path, and packet hash must be exact',
      'INVALID_INPUT',
    )
  }
}

function parseExactMethodPacket(bytes: Uint8Array): RolePacket {
  let text: string
  let value: unknown
  try {
    text = UTF8.decode(bytes)
    value = JSON.parse(text)
  } catch (error) {
    throw new MethodTicketError(
      `Role Packet is not valid UTF-8 JSON: ${errorMessage(error)}`,
      'INVALID_PACKET',
    )
  }
  let packet: RolePacket
  try {
    packet = parseRolePacket(value)
  } catch (error) {
    throw new MethodTicketError(
      `Role Packet schema is invalid: ${errorMessage(error)}`,
      'INVALID_PACKET',
    )
  }
  if (packet.header.role_kind !== 'method') {
    throw new MethodTicketError('Role Packet is not assigned to a Method Maker', 'INVALID_PACKET')
  }
  if (canonicalJson(packet) !== text) {
    throw new MethodTicketError('Role Packet bytes are not its canonical immutable form', 'INVALID_PACKET')
  }
  return packet
}

function validateOutputContract(packet: RolePacket): void {
  if (packet.output_contract.expected_hash_binding !== METHOD_TICKET_HASH_BINDING
    || canonicalJson(packet.output_contract.schema)
      !== canonicalJson(methodDesignTicketOutputSchema())) {
    throw new MethodTicketError(
      'Role Packet does not carry the exact Method Design Ticket output contract',
      'OUTPUT_CONTRACT_MISMATCH',
    )
  }
}

function parseTicketBytes(bytes: Uint8Array): MethodDesignTicket {
  let value: unknown
  try {
    value = JSON.parse(UTF8.decode(bytes))
  } catch (error) {
    throw new MethodTicketError(
      `Method receipt is not valid UTF-8 JSON: ${errorMessage(error)}`,
      'INVALID_TICKET',
    )
  }
  return parseMethodDesignTicket(value)
}

function validateTicketBindings(
  ticket: MethodDesignTicket,
  packet: RolePacket,
  packetHash: string,
): void {
  if (ticket.assignment_id !== packet.header.assignment_id) {
    throw new MethodTicketError(
      'Method Design Ticket belongs to another Assignment',
      'ASSIGNMENT_MISMATCH',
    )
  }
  if (ticket.role_packet_sha256 !== packetHash
    || ticket.assignment_contract_sha256 !== packet.anchors.assignment_contract_sha256) {
    throw new MethodTicketError(
      'Method Design Ticket hash bindings do not match the Role Packet anchors',
      'HASH_BINDING_MISMATCH',
    )
  }
}

async function readBytes(
  path: string,
  label: string,
  code: MethodTicketError['code'],
): Promise<Uint8Array> {
  try {
    return await readFile(path)
  } catch (error) {
    throw new MethodTicketError(`${label} cannot be read: ${errorMessage(error)}`, code)
  }
}

function formatIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues.map(issueValue => (
    `${issueValue.path.join('.') || '<root>'}: ${issueValue.message}`
  )).join('; ')
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}
