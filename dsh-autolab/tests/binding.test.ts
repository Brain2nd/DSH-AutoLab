import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ArtifactStore } from '../src/artifacts.js'
import {
  freezeRoleBinding,
  readRoleBinding,
  type RoleBindingReceipt,
} from '../src/binding.js'
import { canonicalJson, hashResolvedManifest } from '../src/manifest.js'
import { sha256 } from '../src/integrity.js'
import { validManifest } from './manifest.test.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-autolab-binding-'))
  roots.push(root)
  const store = new ArtifactStore(join(root, 'autolab'))
  await store.initialize()
  const manifest = validManifest()
  await store.createLab({
    labId: manifest.lab_id,
    controllerSessionId: 'session-controller',
    now: 1,
  })
  const role = manifest.roles.find(candidate => candidate.role_id === 'lane-a-method')!
  if (role.role_kind !== 'method') throw new Error('invalid Method fixture')
  const input = {
    labDirectory: store.labDirectory(manifest.lab_id),
    labId: manifest.lab_id,
    manifestHash: hashResolvedManifest(manifest),
    roleId: role.role_id,
    roleKind: role.role_kind,
    sessionId: 'session-lane-a-method',
    agentPresetId: 'default-agent',
    permissionPresetId: role.dsh_preset,
    provider: role.model_route.provider,
    model: role.model_route.model,
    cwd: role.worktree_path,
    runtimeRevision: 7,
    issuedAt: 1_786_742_400_000,
  } as const
  return { manifest, input }
}

describe('immutable Role binding receipt', () => {
  it('is idempotent for the same role-to-Session identity', async () => {
    const { input } = await fixture()
    const first = await freezeRoleBinding(input)
    const second = await freezeRoleBinding(input)

    expect(second).toEqual(first)
    expect(await readRoleBinding(input.labDirectory, input.roleId)).toEqual(first)
    expect(JSON.parse(await readFile(first.path, 'utf8'))).toEqual(first.receipt)
    const { receiptHash, ...withoutHash } = first.receipt
    expect(first.hash).toBe(receiptHash)
    expect(receiptHash).toBe(sha256(
      `autolab-role-binding-v1\0${canonicalJson(withoutHash)}`,
    ))
  })

  it('rejects a second Session or manifest for an already-bound role', async () => {
    const { input } = await fixture()
    const frozen = await freezeRoleBinding(input)

    await expect(freezeRoleBinding({
      ...input,
      sessionId: 'another-session',
    })).rejects.toMatchObject({ code: 'BINDING_CONFLICT' })
    await expect(freezeRoleBinding({
      ...input,
      manifestHash: 'f'.repeat(64),
    })).rejects.toMatchObject({ code: 'BINDING_CONFLICT' })
    expect(JSON.parse(await readFile(frozen.path, 'utf8'))).toEqual(frozen.receipt)
  })

  it('detects receipt-byte tampering before read or adoption', async () => {
    const { input } = await fixture()
    const frozen = await freezeRoleBinding(input)
    const tampered: RoleBindingReceipt = {
      ...frozen.receipt,
      model: 'tampered-model',
    }
    await writeFile(frozen.path, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8')

    await expect(readRoleBinding(input.labDirectory, input.roleId)).rejects.toMatchObject({
      code: 'BINDING_CORRUPT',
    })
    await expect(freezeRoleBinding(input)).rejects.toMatchObject({
      code: 'BINDING_CORRUPT',
    })
  })
})
