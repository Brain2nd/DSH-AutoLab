import { describe, expect, it } from 'vitest'

import type { FrozenRevision } from '../src/artifacts.js'
import { compileControllerGoalIntent } from '../src/controller-goal.js'
import { sha256 } from '../src/integrity.js'
import { rolePromptFor } from '../src/roles.js'
import { createRuntimeState, transitionRuntimeState } from '../src/state.js'
import { validManifest } from './manifest.test.js'

const OWNER = '00000000-0000-4000-8000-000000000001'

function fixture() {
  const manifest = structuredClone(validManifest())
  const controller = manifest.roles.find(role => role.role_kind === 'controller')!
  controller.prompt_sha256 = rolePromptFor('controller').sha256
  const ref = {
    revision: 1,
    specHash: manifest.anchors.lab_spec_sha256,
    configHash: manifest.anchors.lab_yaml_sha256,
    manifestHash: sha256(JSON.stringify({ manifest: 'fixture' })),
    dialogueHeadHash: manifest.anchors.dialogue_head_sha256,
    revisionPath: 'revisions/000001',
  }
  const created = createRuntimeState({
    labId: manifest.lab_id,
    ownerEpoch: OWNER,
    controllerSessionId: 'session-controller',
    lifecycle: 'ready',
    config: ref,
    now: 1,
  })
  const state = transitionRuntimeState(created, {
    expectedRevision: created.runtimeRevision,
    ownerEpoch: OWNER,
    lifecycle: 'starting',
    now: 2,
  })
  const frozen: FrozenRevision = {
    ref,
    spec: 'FULL LAB SPEC THAT MUST STAY IN ITS AUTHORITY FILE',
    config: 'schema_version: 1\n',
    manifest,
    validation: {
      version: 1,
      hashAlgorithm: 'sha256',
      manifestCanonicalization: 'autolab-canonical-json-v1',
      dialogueHeadHash: ref.dialogueHeadHash,
      specHash: ref.specHash,
      configHash: ref.configHash,
      manifestHash: ref.manifestHash,
    },
  }
  return { state, frozen }
}

describe('Controller native Goal intent', () => {
  it('references complete originals and current progress without copying a second summary', () => {
    const value = fixture()
    const first = compileControllerGoalIntent(value.state, value.frozen)
    const second = compileControllerGoalIntent(value.state, value.frozen)

    expect(first).toEqual(second)
    expect(first.roleId).toBe('controller')
    expect(first.maxGoalRounds).toBe(64)
    expect(first.packetHash).toBe(value.frozen.ref.manifestHash)
    expect(first.objectiveHash).toBe(sha256(first.objective))
    expect(first.objective).toContain(value.frozen.manifest.authority_paths.creation_log)
    expect(first.objective).toContain(value.frozen.manifest.authority_paths.lab_spec)
    expect(first.objective).toContain(value.frozen.manifest.authority_paths.lab_yaml)
    expect(first.objective).toContain(value.frozen.manifest.authority_paths.resolved_manifest)
    expect(first.objective).toContain('"lifecycle":"starting"')
    expect(first.objective).toContain('AutoLabWait')
    expect(first.objective).not.toContain(value.frozen.spec)
  })

  it('rejects a different Controller Session instead of creating a replacement owner', () => {
    const value = fixture()
    expect(() => compileControllerGoalIntent(
      { ...value.state, controllerSessionId: 'another-session' },
      value.frozen,
    )).toThrow(/binding does not match CURRENT/u)
  })
})
