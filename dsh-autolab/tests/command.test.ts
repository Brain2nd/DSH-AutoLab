import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandDefinition, CommandInvocation } from '@deepseek-ai/dsh-commands'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'

import { apply } from '../src/command.js'
import type { DraftSnapshot, FrozenRevision } from '../src/artifacts.js'
import type { CreateLabResult, ShowLabResult } from '../src/index.js'
import type { RuntimeState, LabLifecycle } from '../src/state.js'
import { validManifest } from './manifest.test.js'

const LAB_ID = 'lab-20260815-030000-1234abcd'
const LAB_DIRECTORY = `/var/tmp/autolab/labs/${LAB_ID}`
const SPEC_HASH = 'a'.repeat(64)
const CONFIG_HASH = 'b'.repeat(64)
const MANIFEST_HASH = 'c'.repeat(64)
const DIALOGUE_HEAD_HASH = 'd'.repeat(64)
const USAGE = 'Usage: /autolab create [config-path] | show <lab-id> | commit <lab-id> | start <lab-id> | status <lab-id> | pause <lab-id> | resume <lab-id> | stop <lab-id>'

function controllerState(lifecycle: LabLifecycle): RuntimeState {
  return {
    schemaVersion: 1,
    labId: LAB_ID,
    runtimeRevision: lifecycle === 'configuring' ? 0 : 3,
    ownerEpoch: '00000000-0000-4000-8000-000000000001',
    controllerSessionId: 'controller-session',
    lifecycle,
    ...(lifecycle === 'configuring' || lifecycle === 'draft_ready'
      ? {}
      : {
          config: {
            revision: 1,
            revisionPath: 'revisions/000001',
            specHash: SPEC_HASH,
            configHash: CONFIG_HASH,
            manifestHash: MANIFEST_HASH,
            dialogueHeadHash: DIALOGUE_HEAD_HASH,
          },
        }),
    roles: {},
    reviews: {},
    candidates: {},
    retiredCandidates: {},
    trials: {},
    createdAt: 1,
    updatedAt: 2,
  }
}

function draft(spec = '', config = ''): DraftSnapshot {
  return {
    spec,
    config,
    specHash: spec.length === 0 ? '0'.repeat(64) : SPEC_HASH,
    configHash: config.length === 0 ? '0'.repeat(64) : CONFIG_HASH,
  }
}

function frozen(): FrozenRevision {
  return {
    ref: {
      revision: 1,
      revisionPath: 'revisions/000001',
      specHash: SPEC_HASH,
      configHash: CONFIG_HASH,
      manifestHash: MANIFEST_HASH,
      dialogueHeadHash: DIALOGUE_HEAD_HASH,
    },
    spec: '# Exact specification\n\nConstraint: do not summarize this line.\n',
    config: 'version: 1\nroles:\n  method_maker: 2\n',
    manifest: validManifest(),
    validation: {
      version: 1,
      hashAlgorithm: 'sha256',
      manifestCanonicalization: 'autolab-canonical-json-v1',
      dialogueHeadHash: DIALOGUE_HEAD_HASH,
      specHash: SPEC_HASH,
      configHash: CONFIG_HASH,
      manifestHash: MANIFEST_HASH,
    },
  }
}

function caller(): Agent {
  return { id: SessionId('controller-session') } as Agent
}

function invocation(agent: Agent, rawInput: string, signal: AbortSignal): CommandInvocation {
  return { agent, rawInput, signal } as CommandInvocation
}

function mount(service: object): {
  readonly definition: CommandDefinition
  readonly ctx: Context
} {
  const definitions: CommandDefinition[] = []
  const ctx = {
    commands: {
      register(definition: CommandDefinition) {
        definitions.push(definition)
        return () => undefined
      },
    },
    autolab: service,
  } as Context
  apply(ctx)
  expect(definitions).toHaveLength(1)
  return { definition: definitions[0]!, ctx }
}

describe('/autolab command surface', () => {
  it('registers one provenance-recording command and creates a CONFIGURING draft without starting', async () => {
    const agent = caller()
    const signal = new AbortController().signal
    const result: CreateLabResult = {
      state: controllerState('configuring'),
      directory: LAB_DIRECTORY,
      draft: draft(),
    }
    const create = vi.fn(async () => result)
    const service = {
      create,
      show: vi.fn(),
      commit: vi.fn(),
      start: vi.fn(),
      status: vi.fn(),
      pause: vi.fn(),
    }
    const { definition } = mount(service)

    expect(definition).toMatchObject({
      name: 'autolab',
      recordInput: true,
      input: {
        hint: 'create [config-path] | show <lab-id> | commit <lab-id> | start <lab-id> | status <lab-id> | pause <lab-id> | resume <lab-id> | stop <lab-id>',
      },
    })
    await expect(definition.handler(invocation(agent, ' create ', signal))).resolves.toEqual({
      kind: 'success',
      text: [
        `Created AutoLab ${LAB_ID}.`,
        'Lifecycle: CONFIGURING',
        `Lab directory: ${LAB_DIRECTORY}`,
        `Draft directory: ${LAB_DIRECTORY}/draft`,
        `The Lab was not started. Continue the directed configuration conversation, then use /autolab commit <lab-id> to create a revision.`,
      ].join('\n'),
    })
    expect(create).toHaveBeenCalledWith(agent, undefined, signal)
    expect(service.start).not.toHaveBeenCalled()
  })

  it('imports complete source into DRAFT_READY without silently committing it', async () => {
    const agent = caller()
    const signal = new AbortController().signal
    const revision = frozen()
    const create = vi.fn(async (): Promise<CreateLabResult> => ({
      state: controllerState('draft_ready'),
      directory: LAB_DIRECTORY,
      draft: draft(revision.spec, revision.config),
    }))
    const { definition } = mount({
      create,
      show: vi.fn(),
      commit: vi.fn(),
      start: vi.fn(),
      status: vi.fn(),
      pause: vi.fn(),
    })

    const response = await definition.handler(invocation(agent, 'create ./lab-config', signal))
    expect(response).toMatchObject({ kind: 'success' })
    if (response.kind !== 'success') throw new Error('expected imported create success')
    expect(create).toHaveBeenCalledWith(agent, './lab-config', signal)
    expect(response.text).not.toContain(`Revision: 1`)
    expect(response.text).toContain(
      `LAB_SPEC.md path: ${LAB_DIRECTORY}/draft/LAB_SPEC.md`,
    )
    expect(response.text).toContain(`LAB_SPEC.md SHA-256: ${SPEC_HASH}`)
    expect(response.text).toContain(
      `lab.yaml path: ${LAB_DIRECTORY}/draft/lab.yaml`,
    )
    expect(response.text).toContain(`lab.yaml SHA-256: ${CONFIG_HASH}`)
    expect(response.text).toContain(
      `----- BEGIN LAB_SPEC.md (verbatim) -----\n${revision.spec}----- END LAB_SPEC.md -----`,
    )
    expect(response.text).toContain(
      `----- BEGIN lab.yaml (verbatim) -----\n${revision.config}----- END lab.yaml -----`,
    )
  })

  it('keeps a create path with spaces as one verbatim argument', async () => {
    const agent = caller()
    const signal = new AbortController().signal
    const create = vi.fn(async (): Promise<CreateLabResult> => ({
      state: controllerState('configuring'),
      directory: LAB_DIRECTORY,
      draft: draft(),
    }))
    const { definition } = mount({
      create,
      show: vi.fn(),
      commit: vi.fn(),
      start: vi.fn(),
      status: vi.fn(),
      pause: vi.fn(),
    })

    await expect(definition.handler(invocation(
      agent,
      'create /tmp/Research Lab/config',
      signal,
    ))).resolves.toMatchObject({ kind: 'success' })
    expect(create).toHaveBeenCalledWith(agent, '/tmp/Research Lab/config', signal)
  })

  it('show returns both frozen files verbatim rather than a summary', async () => {
    const agent = caller()
    const signal = new AbortController().signal
    const revision = frozen()
    const shown: ShowLabResult = {
      state: controllerState('ready'),
      directory: LAB_DIRECTORY,
      frozen: revision,
    }
    const show = vi.fn(async () => shown)
    const { definition } = mount({
      create: vi.fn(),
      show,
      commit: vi.fn(),
      start: vi.fn(),
      status: vi.fn(),
      pause: vi.fn(),
    })

    const response = await definition.handler(invocation(agent, `show ${LAB_ID}`, signal))
    expect(response).toMatchObject({ kind: 'success' })
    if (response.kind !== 'success') throw new Error('expected show success')
    expect(show).toHaveBeenCalledWith(agent, LAB_ID, signal)
    expect(response.text).toContain(revision.spec)
    expect(response.text).toContain(revision.config)
    expect(response.text).not.toContain('Summary:')
    expect(response.text).toContain(`LAB_SPEC.md SHA-256: ${SPEC_HASH}`)
    expect(response.text).toContain(`lab.yaml SHA-256: ${CONFIG_HASH}`)
  })

  it('commits only through the explicit commit boundary and prints full originals', async () => {
    const agent = caller()
    const signal = new AbortController().signal
    const revision = frozen()
    const committed: ShowLabResult = {
      state: controllerState('ready'),
      directory: LAB_DIRECTORY,
      frozen: revision,
    }
    const commit = vi.fn(async () => committed)
    const { definition } = mount({
      create: vi.fn(),
      show: vi.fn(),
      commit,
      start: vi.fn(),
      status: vi.fn(),
      pause: vi.fn(),
    })

    const response = await definition.handler(invocation(agent, `commit ${LAB_ID}`, signal))
    expect(response).toMatchObject({ kind: 'success' })
    if (response.kind !== 'success') throw new Error('expected commit success')
    expect(commit).toHaveBeenCalledWith(agent, LAB_ID, signal)
    expect(response.text).toContain('Revision: 1')
    expect(response.text).toContain(revision.spec)
    expect(response.text).toContain(revision.config)
  })

  it('formats only returned RuntimeState for status, pause, resume, and stop', async () => {
    const agent = caller()
    const signal = new AbortController().signal
    const running = controllerState('running')
    const paused = controllerState('paused')
    const status = vi.fn(() => running)
    const pause = vi.fn(async () => paused)
    const resume = vi.fn(async () => running)
    const stop = vi.fn(async () => controllerState('stopped'))
    const show = vi.fn()
    const { definition } = mount({
      create: vi.fn(),
      show,
      commit: vi.fn(),
      start: vi.fn(),
      status,
      pause,
      resume,
      stop,
    })

    await expect(definition.handler(invocation(agent, `status ${LAB_ID}`, signal))).resolves.toEqual({
      kind: 'success',
      text: `AutoLab ${LAB_ID}.\nLifecycle: RUNNING\nRuntimeState:\n${JSON.stringify(running, null, 2)}`,
    })
    expect(status).toHaveBeenCalledWith(agent, LAB_ID)
    expect(show).not.toHaveBeenCalled()

    await expect(definition.handler(invocation(agent, `pause ${LAB_ID}`, signal))).resolves.toEqual({
      kind: 'success',
      text: `AutoLab ${LAB_ID}.\nLifecycle: PAUSED\nRuntimeState:\n${JSON.stringify(paused, null, 2)}`,
    })
    expect(pause).toHaveBeenCalledWith(agent, LAB_ID, signal)
    expect(show).not.toHaveBeenCalled()

    await definition.handler(invocation(agent, `resume ${LAB_ID}`, signal))
    expect(resume).toHaveBeenCalledWith(agent, LAB_ID, signal)

    await definition.handler(invocation(agent, `stop ${LAB_ID}`, signal))
    expect(stop).toHaveBeenCalledWith(agent, LAB_ID, signal)
  })

  it('reports the Controller start error instead of claiming activation', async () => {
    const agent = caller()
    const signal = new AbortController().signal
    const controllerError = Object.assign(
      new Error(`Lab ${LAB_ID} role activation is not installed yet`),
      { code: 'NO_ROLES_DECLARED' },
    )
    const start = vi.fn(async () => { throw controllerError })
    const { definition } = mount({
      create: vi.fn(),
      show: vi.fn(),
      commit: vi.fn(),
      start,
      status: vi.fn(),
      pause: vi.fn(),
    })

    await expect(definition.handler(invocation(agent, `start ${LAB_ID}`, signal))).resolves.toEqual({
      kind: 'error',
      text: `AutoLab start failed: NO_ROLES_DECLARED: Lab ${LAB_ID} role activation is not installed yet`,
    })
    expect(start).toHaveBeenCalledWith(agent, LAB_ID, signal)
  })

  it.each([
    '',
    `show`,
    `commit`,
    `show ${LAB_ID} extra`,
    `start`,
    `status ${LAB_ID} extra`,
    `pause`,
    `resume`,
    `stop`,
    'unknown value',
  ])('rejects non-mechanical input %j without calling the Controller', async rawInput => {
    const service = {
      create: vi.fn(),
      show: vi.fn(),
      commit: vi.fn(),
      start: vi.fn(),
      status: vi.fn(),
      pause: vi.fn(),
    }
    const { definition } = mount(service)
    await expect(definition.handler(invocation(
      caller(),
      rawInput,
      new AbortController().signal,
    ))).resolves.toEqual({ kind: 'error', text: USAGE })
    expect(service.create).not.toHaveBeenCalled()
    expect(service.show).not.toHaveBeenCalled()
    expect(service.commit).not.toHaveBeenCalled()
    expect(service.start).not.toHaveBeenCalled()
    expect(service.status).not.toHaveBeenCalled()
    expect(service.pause).not.toHaveBeenCalled()
  })
})
