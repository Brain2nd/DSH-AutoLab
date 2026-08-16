import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  ArtifactStore,
  durableWriteFile,
  sha256,
} from '../src/artifacts.js'
import { canonicalJson, type ResolvedManifest } from '../src/manifest.js'
import { validManifest } from './manifest.test.js'

const LAB_ID = 'lab-20260815-120000-89abcdef'
const DIALOGUE_HEAD_HASH = 'd'.repeat(64)
const roots: string[] = []

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  roots.push(directory)
  return directory
}

async function sourceDirectory(
  spec: string | Uint8Array,
  config: string | Uint8Array,
): Promise<string> {
  const source = await temporaryDirectory('dsh-autolab-source-')
  await Promise.all([
    writeFile(join(source, 'LAB_SPEC.md'), spec),
    writeFile(join(source, 'lab.yaml'), config),
  ])
  return source
}

function revisionManifest(
  store: ArtifactStore,
  revision: number,
  spec: string | Uint8Array,
  config: string | Uint8Array,
  dialogueHeadHash = DIALOGUE_HEAD_HASH,
): ResolvedManifest {
  const manifest = structuredClone(validManifest())
  const labDirectory = store.labDirectory(LAB_ID)
  const revisionDirectory = join(
    labDirectory,
    'revisions',
    String(revision).padStart(6, '0'),
  )
  manifest.lab_id = LAB_ID
  manifest.source_revision = revision
  manifest.anchors = {
    dialogue_head_sha256: dialogueHeadHash,
    lab_spec_sha256: sha256(spec),
    lab_yaml_sha256: sha256(config),
  }
  manifest.authority_paths = {
    ...manifest.authority_paths,
    lab_dir: labDirectory,
    creation_log: join(labDirectory, 'dialogue', 'creation.jsonl'),
    lab_spec: join(revisionDirectory, 'LAB_SPEC.md'),
    lab_yaml: join(revisionDirectory, 'lab.yaml'),
    resolved_manifest: join(revisionDirectory, 'RESOLVED_MANIFEST.json'),
    fact_set: join(labDirectory, 'artifacts', 'facts.json'),
    evidence_index: join(labDirectory, 'artifacts', 'evidence.json'),
    assignment_root: join(labDirectory, 'assignments'),
  }
  manifest.evidence.artifact_root = join(labDirectory, 'artifacts')
  return manifest
}

function draftRevisionInput(
  store: ArtifactStore,
  revision: number,
  spec: string | Uint8Array,
  config: string | Uint8Array,
) {
  return {
    labId: LAB_ID,
    revision,
    manifest: revisionManifest(store, revision, spec, config),
    dialogueHeadHash: DIALOGUE_HEAD_HASH,
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('ArtifactStore revision commit', () => {
  it('preserves the complete UTF-8 originals, including BOM and whitespace', async () => {
    const root = await temporaryDirectory('dsh-autolab-artifacts-')
    const spec = '\uFEFF  # 研究原文\n约束：保持逐字读取\0尾部  \n\n'
    const config = '\uFEFFlab:\n  title: "原样配置"\n  note: " trailing "\n'
    const source = await sourceDirectory(Buffer.from(spec), Buffer.from(config))
    const store = new ArtifactStore(root)
    await store.initialize()

    const scaffold = await store.createLab({
      labId: LAB_ID,
      controllerSessionId: 'controller',
      sourceDirectory: source,
      now: 1,
    })
    expect(scaffold.draft.spec).toBe(spec)
    expect(scaffold.draft.config).toBe(config)
    await expect(store.readCurrent(LAB_ID)).rejects.toMatchObject({ code: 'INVALID_CURRENT' })

    const current = await store.freezeDraftRevision(draftRevisionInput(store, 1, spec, config))
    expect(current.spec).toBe(spec)
    expect(current.config).toBe(config)
    expect(current.ref).toMatchObject({
      manifestHash: sha256(canonicalJson(current.manifest)),
      dialogueHeadHash: DIALOGUE_HEAD_HASH,
    })
    const revisionDirectory = join(store.labDirectory(LAB_ID), current.ref.revisionPath)
    expect(await readFile(join(revisionDirectory, 'LAB_SPEC.md'))).toEqual(Buffer.from(spec))
    expect(await readFile(join(revisionDirectory, 'lab.yaml'))).toEqual(Buffer.from(config))
    expect(await readFile(join(revisionDirectory, 'RESOLVED_MANIFEST.json'), 'utf8'))
      .toBe(canonicalJson(current.manifest))
    expect(JSON.parse(await readFile(join(revisionDirectory, 'VALIDATION.json'), 'utf8')))
      .toEqual(current.validation)
    expect(JSON.parse(await readFile(join(store.labDirectory(LAB_ID), 'CURRENT'), 'utf8')))
      .toEqual({
        version: 2,
        revision: 1,
        revisionPath: 'revisions/000001',
        specHash: current.ref.specHash,
        configHash: current.ref.configHash,
        manifestHash: current.ref.manifestHash,
        dialogueHeadHash: current.ref.dialogueHeadHash,
      })
  })

  it('rejects a CURRENT pointer to a half-written revision', async () => {
    const root = await temporaryDirectory('dsh-autolab-artifacts-')
    const store = new ArtifactStore(root)
    await store.initialize()
    await store.createLab({ labId: LAB_ID, controllerSessionId: 'controller', now: 1 })

    const labDirectory = store.labDirectory(LAB_ID)
    const revisionDirectory = join(labDirectory, 'revisions', '000001')
    const spec = '# incomplete\n'
    const config = 'lab: incomplete\n'
    await mkdir(revisionDirectory)
    await Promise.all([
      writeFile(join(revisionDirectory, 'LAB_SPEC.md'), spec),
      writeFile(join(revisionDirectory, 'lab.yaml'), config),
    ])
    await writeFile(join(labDirectory, 'CURRENT'), `${JSON.stringify({
      version: 2,
      revision: 1,
      revisionPath: 'revisions/000001',
      specHash: sha256(spec),
      configHash: sha256(config),
      manifestHash: 'e'.repeat(64),
      dialogueHeadHash: DIALOGUE_HEAD_HASH,
    })}\n`)

    await expect(store.readCurrent(LAB_ID)).rejects.toMatchObject({
      name: 'ArtifactError',
      code: 'REVISION_MISSING',
    })
  })

  it('detects immutable revision byte drift by hash', async () => {
    const root = await temporaryDirectory('dsh-autolab-artifacts-')
    const source = await sourceDirectory('# original\n', 'lab: original\n')
    const store = new ArtifactStore(root)
    await store.initialize()
    await store.createLab({
      labId: LAB_ID,
      controllerSessionId: 'controller',
      sourceDirectory: source,
      now: 1,
    })
    await store.freezeDraftRevision(draftRevisionInput(
      store,
      1,
      '# original\n',
      'lab: original\n',
    ))

    await writeFile(
      join(store.labDirectory(LAB_ID), 'revisions', '000001', 'LAB_SPEC.md'),
      '# tampered\n',
    )
    await expect(store.readCurrent(LAB_ID)).rejects.toMatchObject({
      name: 'ArtifactError',
      code: 'HASH_MISMATCH',
    })
  })

  it('detects immutable ResolvedManifest drift by hash', async () => {
    const root = await temporaryDirectory('dsh-autolab-artifacts-')
    const spec = '# original\n'
    const config = 'lab: original\n'
    const source = await sourceDirectory(spec, config)
    const store = new ArtifactStore(root)
    await store.initialize()
    await store.createLab({
      labId: LAB_ID,
      controllerSessionId: 'controller',
      sourceDirectory: source,
      now: 1,
    })
    const frozen = await store.freezeDraftRevision(draftRevisionInput(store, 1, spec, config))
    const tampered = structuredClone(frozen.manifest)
    tampered.research.objective = 'Tampered objective'
    await writeFile(
      join(store.labDirectory(LAB_ID), 'revisions', '000001', 'RESOLVED_MANIFEST.json'),
      canonicalJson(tampered),
    )

    await expect(store.readCurrent(LAB_ID)).rejects.toMatchObject({
      name: 'ArtifactError',
      code: 'HASH_MISMATCH',
    })
  })

  it('detects VALIDATION drift before accepting CURRENT', async () => {
    const root = await temporaryDirectory('dsh-autolab-artifacts-')
    const spec = '# original\n'
    const config = 'lab: original\n'
    const source = await sourceDirectory(spec, config)
    const store = new ArtifactStore(root)
    await store.initialize()
    await store.createLab({
      labId: LAB_ID,
      controllerSessionId: 'controller',
      sourceDirectory: source,
      now: 1,
    })
    const frozen = await store.freezeDraftRevision(draftRevisionInput(store, 1, spec, config))
    const tampered = {
      ...frozen.validation,
      dialogueHeadHash: 'f'.repeat(64),
    }
    await writeFile(
      join(store.labDirectory(LAB_ID), 'revisions', '000001', 'VALIDATION.json'),
      `${JSON.stringify(tampered, null, 2)}\n`,
    )

    await expect(store.readCurrent(LAB_ID)).rejects.toMatchObject({
      name: 'ArtifactError',
      code: 'HASH_MISMATCH',
    })
  })

  it('keeps CURRENT readable while complete revisions are atomically committed', async () => {
    const root = await temporaryDirectory('dsh-autolab-artifacts-')
    const source = await sourceDirectory('# revision 1\n', 'revision: 1\n')
    const store = new ArtifactStore(root)
    await store.initialize()
    await store.createLab({
      labId: LAB_ID,
      controllerSessionId: 'controller',
      sourceDirectory: source,
      now: 1,
    })
    await store.freezeDraftRevision(draftRevisionInput(
      store,
      1,
      '# revision 1\n',
      'revision: 1\n',
    ))

    let stop = false
    let reads = 0
    const reader = (async () => {
      while (!stop) {
        const current = await store.readCurrent(LAB_ID)
        expect(current.ref.revision).toBeGreaterThanOrEqual(1)
        expect(current.spec).toContain(`# revision ${current.ref.revision}`)
        expect(current.config).toContain(`revision: ${current.ref.revision}`)
        reads += 1
        await new Promise<void>(resolve => setImmediate(resolve))
      }
    })()

    try {
      for (let revision = 2; revision <= 12; revision += 1) {
        await Promise.all([
          writeFile(join(source, 'LAB_SPEC.md'), `# revision ${revision}\n`),
          writeFile(join(source, 'lab.yaml'), `revision: ${revision}\n`),
        ])
        const spec = `# revision ${revision}\n`
        const config = `revision: ${revision}\n`
        await store.freezeImportedRevision(
          LAB_ID,
          source,
          revision,
          revisionManifest(store, revision, spec, config),
          DIALOGUE_HEAD_HASH,
        )
      }
    } finally {
      stop = true
      await reader
    }

    expect(reads).toBeGreaterThan(0)
    expect((await store.readCurrent(LAB_ID)).ref.revision).toBe(12)
  })

  it('publishes the same complete revision idempotently under a concurrent race', async () => {
    const root = await temporaryDirectory('dsh-autolab-artifacts-')
    const source = await sourceDirectory('# revision 1\n', 'revision: 1\n')
    const store = new ArtifactStore(root)
    await store.initialize()
    await store.createLab({
      labId: LAB_ID,
      controllerSessionId: 'controller',
      sourceDirectory: source,
      now: 1,
    })
    await store.freezeDraftRevision(draftRevisionInput(
      store,
      1,
      '# revision 1\n',
      'revision: 1\n',
    ))
    await Promise.all([
      writeFile(join(source, 'LAB_SPEC.md'), '# revision 2\n'),
      writeFile(join(source, 'lab.yaml'), 'revision: 2\n'),
    ])

    const manifest = revisionManifest(store, 2, '# revision 2\n', 'revision: 2\n')
    const [first, second] = await Promise.all([
      store.freezeImportedRevision(LAB_ID, source, 2, manifest, DIALOGUE_HEAD_HASH),
      store.freezeImportedRevision(LAB_ID, source, 2, manifest, DIALOGUE_HEAD_HASH),
    ])
    expect(first.ref).toEqual(second.ref)
    expect((await store.readCurrent(LAB_ID)).ref).toEqual(first.ref)
  })

  it('uses an atomic no-clobber link for immutable files', async () => {
    const root = await temporaryDirectory('dsh-autolab-artifacts-')
    const path = join(root, 'immutable')
    const results = await Promise.allSettled([
      durableWriteFile(path, 'first', false),
      durableWriteFile(path, 'second', false),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(['first', 'second']).toContain(await readFile(path, 'utf8'))
  })
})
