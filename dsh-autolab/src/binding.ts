import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { z } from 'zod'

import { durableWriteFile } from './artifacts.js'
import { canonicalJson, sha256 } from './integrity.js'
import type { RootRoleKind } from './roles.js'

const SHA256 = /^[0-9a-f]{64}$/u

const receiptSchema = z.object({
  version: z.literal(1),
  labId: z.string().min(1),
  manifestHash: z.string().regex(SHA256),
  roleId: z.string().min(1),
  roleKind: z.enum([
    'method',
    'coder',
    'preflight_judge',
    'postflight_judge',
    'ops',
    'coordinator',
  ]),
  sessionId: z.string().min(1),
  agentPresetId: z.string().min(1),
  permissionPresetId: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
  provider: z.string().min(1),
  model: z.string().min(1),
  cwd: z.string().min(1).refine(isAbsolute, 'cwd must be absolute'),
  runtimeRevision: z.number().int().nonnegative(),
  issuedAt: z.number().int().nonnegative(),
  receiptHash: z.string().regex(SHA256),
}).strict()

export type RoleBindingReceipt = z.infer<typeof receiptSchema>

export interface StoredRoleBinding {
  readonly path: string
  readonly hash: string
  readonly receipt: RoleBindingReceipt
}

export class RoleBindingError extends Error {
  readonly name = 'RoleBindingError'

  constructor(
    message: string,
    readonly code: 'INVALID_BINDING' | 'BINDING_CONFLICT' | 'BINDING_CORRUPT',
  ) {
    super(message)
  }
}

/** Freeze one exact role-to-Session binding before that Session is published. */
export async function freezeRoleBinding(input: {
  labDirectory: string
  labId: string
  manifestHash: string
  roleId: string
  roleKind: RootRoleKind
  sessionId: string
  agentPresetId: string
  permissionPresetId: RoleBindingReceipt['permissionPresetId']
  provider: string
  model: string
  cwd: string
  runtimeRevision: number
  issuedAt: number
}): Promise<StoredRoleBinding> {
  if (!isAbsolute(input.labDirectory)) {
    throw new RoleBindingError('Lab directory must be absolute', 'INVALID_BINDING')
  }
  const path = roleBindingPath(input.labDirectory, input.roleId)
  const existing = await readBinding(path)
  if (existing !== undefined) return assertSameBinding(existing, path, input)

  const withoutHash = {
    version: 1 as const,
    labId: input.labId,
    manifestHash: input.manifestHash,
    roleId: input.roleId,
    roleKind: input.roleKind,
    sessionId: input.sessionId,
    agentPresetId: input.agentPresetId,
    permissionPresetId: input.permissionPresetId,
    provider: input.provider,
    model: input.model,
    cwd: input.cwd,
    runtimeRevision: input.runtimeRevision,
    issuedAt: input.issuedAt,
  }
  const receipt: RoleBindingReceipt = {
    ...withoutHash,
    receiptHash: sha256(`autolab-role-binding-v1\0${canonicalJson(withoutHash)}`),
  }
  try {
    await durableWriteFile(path, `${JSON.stringify(receipt, null, 2)}\n`, false)
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') throw error
  }
  const committed = await readBinding(path)
  if (committed === undefined) {
    throw new RoleBindingError('Role binding was not committed', 'BINDING_CORRUPT')
  }
  return assertSameBinding(committed, path, input)
}

export async function readRoleBinding(
  labDirectory: string,
  roleId: string,
): Promise<StoredRoleBinding | undefined> {
  return await readBinding(roleBindingPath(labDirectory, roleId))
}

function roleBindingPath(labDirectory: string, roleId: string): string {
  return join(labDirectory, 'receipts', 'roles', `${sha256(roleId)}.json`)
}

async function readBinding(path: string): Promise<StoredRoleBinding | undefined> {
  const text = await readFile(path, 'utf8').catch(error => {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined
    throw error
  })
  if (text === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new RoleBindingError('Role binding is malformed JSON', 'BINDING_CORRUPT')
  }
  const result = receiptSchema.safeParse(parsed)
  if (!result.success) {
    throw new RoleBindingError(`Role binding schema is invalid: ${result.error.message}`, 'BINDING_CORRUPT')
  }
  const { receiptHash, ...withoutHash } = result.data
  const expected = sha256(`autolab-role-binding-v1\0${canonicalJson(withoutHash)}`)
  if (receiptHash !== expected) {
    throw new RoleBindingError('Role binding hash is invalid', 'BINDING_CORRUPT')
  }
  return { path, hash: receiptHash, receipt: result.data }
}

function assertSameBinding(
  stored: StoredRoleBinding,
  path: string,
  input: {
    labId: string
    manifestHash: string
    roleId: string
    roleKind: RootRoleKind
    sessionId: string
    agentPresetId: string
    permissionPresetId: RoleBindingReceipt['permissionPresetId']
    provider: string
    model: string
    cwd: string
  },
): StoredRoleBinding {
  const receipt = stored.receipt
  if (receipt.labId !== input.labId
    || receipt.manifestHash !== input.manifestHash
    || receipt.roleId !== input.roleId
    || receipt.roleKind !== input.roleKind
    || receipt.sessionId !== input.sessionId
    || receipt.agentPresetId !== input.agentPresetId
    || receipt.permissionPresetId !== input.permissionPresetId
    || receipt.provider !== input.provider
    || receipt.model !== input.model
    || receipt.cwd !== input.cwd) {
    throw new RoleBindingError(
      `Role ${JSON.stringify(input.roleId)} already has another frozen binding`,
      'BINDING_CONFLICT',
    )
  }
  return { ...stored, path }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}
