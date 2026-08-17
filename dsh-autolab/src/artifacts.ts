import { randomBytes, randomUUID } from 'node:crypto'
import {
  mkdir,
  link,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'

import { validateLabId, type ConfigRef } from './state.js'
import { canonicalJson, sha256 } from './integrity.js'
import {
  parseResolvedManifest,
  type ResolvedManifest,
} from './manifest.js'

export { sha256 } from './integrity.js'

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export interface FrozenRevision {
  readonly ref: ConfigRef
  readonly spec: string
  readonly config: string
  readonly manifest: ResolvedManifest
  readonly validation: RevisionValidation
}

export interface RevisionValidation {
  readonly version: 1
  readonly hashAlgorithm: 'sha256'
  readonly manifestCanonicalization: 'autolab-canonical-json-v1'
  readonly dialogueHeadHash: string
  readonly specHash: string
  readonly configHash: string
  readonly manifestHash: string
}

export interface LabScaffold {
  readonly labId: string
  readonly directory: string
  readonly draft: DraftSnapshot
  readonly imported: boolean
}

export interface DraftSnapshot {
  readonly spec: string
  readonly config: string
  readonly specHash: string
  readonly configHash: string
}

interface CurrentPointer {
  readonly version: 2
  readonly revision: number
  readonly revisionPath: string
  readonly specHash: string
  readonly configHash: string
  readonly manifestHash: string
  readonly dialogueHeadHash: string
}

interface RevisionMetadata {
  readonly version: 2
  readonly revision: number
  readonly specHash: string
  readonly configHash: string
  readonly manifestHash: string
  readonly dialogueHeadHash: string
}

export class ArtifactError extends Error {
  readonly name = 'ArtifactError'

  constructor(
    message: string,
    readonly code:
      | 'LAB_EXISTS'
      | 'LAB_NOT_FOUND'
      | 'REVISION_EXISTS'
      | 'REVISION_MISSING'
      | 'HASH_MISMATCH'
      | 'INVALID_SOURCE'
      | 'INVALID_CURRENT',
  ) {
    super(message)
  }
}

export class ArtifactStore {
  readonly root: string
  readonly labsRoot: string

  constructor(root: string) {
    this.root = resolve(root)
    this.labsRoot = join(this.root, 'labs')
  }

  async initialize(): Promise<void> {
    await mkdir(this.labsRoot, { recursive: true, mode: 0o700 })
  }

  labDirectory(labId: string): string {
    return join(this.labsRoot, validateLabId(labId))
  }

  async createLab(input: {
    labId: string
    controllerSessionId: string
    sourceDirectory?: string
    now?: number
  }): Promise<LabScaffold> {
    const directory = this.labDirectory(input.labId)
    try {
      await mkdir(directory, { mode: 0o700 })
    } catch (error) {
      if (isNodeError(error) && error.code === 'EEXIST') {
        throw new ArtifactError(`lab directory already exists: ${directory}`, 'LAB_EXISTS')
      }
      throw error
    }

    try {
      await mkdir(join(directory, 'draft'), { mode: 0o700 })
      await mkdir(join(directory, 'dialogue'), { mode: 0o700 })
      await mkdir(join(directory, 'sources'), { mode: 0o700 })
      await mkdir(join(directory, 'revisions'), { mode: 0o700 })
      await mkdir(join(directory, 'receipts'), { mode: 0o700 })
      await mkdir(join(directory, 'artifacts'), { mode: 0o700 })
      await mkdir(join(directory, 'packets'), { mode: 0o700 })
      await mkdir(join(directory, 'assignments'), { mode: 0o700 })

      const imported = input.sourceDirectory !== undefined
      const documents = imported
        ? await readSourceDocuments(input.sourceDirectory!)
        : {
            specBytes: new Uint8Array(),
            configBytes: new Uint8Array(),
            spec: '',
            config: '',
          }
      await Promise.all([
        durableWriteFile(join(directory, 'draft', 'LAB_SPEC.md'), documents.specBytes, false),
        durableWriteFile(join(directory, 'draft', 'lab.yaml'), documents.configBytes, false),
      ])
      return {
        labId: input.labId,
        directory,
        draft: draftSnapshot(documents),
        imported,
      }
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
  }

  async readDraft(labId: string): Promise<DraftSnapshot> {
    const directory = this.labDirectory(labId)
    const directoryStat = await stat(directory).catch(() => undefined)
    if (directoryStat?.isDirectory() !== true) {
      throw new ArtifactError(`Lab ${labId} was not found`, 'LAB_NOT_FOUND')
    }
    const [specBytes, configBytes] = await Promise.all([
      readFile(join(directory, 'draft', 'LAB_SPEC.md')).catch(() => undefined),
      readFile(join(directory, 'draft', 'lab.yaml')).catch(() => undefined),
    ])
    if (specBytes === undefined || configBytes === undefined) {
      throw new ArtifactError('Lab draft is incomplete', 'INVALID_SOURCE')
    }
    return draftSnapshot({
      specBytes,
      configBytes,
      spec: decodeText(specBytes, 'LAB_SPEC.md'),
      config: decodeText(configBytes, 'lab.yaml'),
    })
  }

  async freezeDraftRevision(input: {
    labId: string
    revision: number
    manifest: ResolvedManifest
    dialogueHeadHash: string
  }): Promise<FrozenRevision> {
    const { labId, revision } = input
    if (!Number.isSafeInteger(revision) || revision <= 0) {
      throw new ArtifactError('revision must be a positive safe integer', 'INVALID_SOURCE')
    }
    const draft = await this.readDraft(labId)
    if (draft.spec.trim().length === 0 || draft.config.trim().length === 0) {
      throw new ArtifactError('LAB_SPEC.md and lab.yaml must not be empty', 'INVALID_SOURCE')
    }
    return await this.freezeRevision({
      labId,
      revision,
      specBytes: await readFile(join(this.labDirectory(labId), 'draft', 'LAB_SPEC.md')),
      configBytes: await readFile(join(this.labDirectory(labId), 'draft', 'lab.yaml')),
      spec: draft.spec,
      config: draft.config,
      manifest: input.manifest,
      dialogueHeadHash: input.dialogueHeadHash,
    })
  }

  /** Exact rollback for a create transaction that never reached RuntimeState. */
  async discardScaffold(labId: string): Promise<void> {
    await rm(this.labDirectory(labId), { recursive: true, force: true })
  }

  async freezeImportedRevision(
    labId: string,
    sourceDirectory: string,
    revision: number,
    manifest: ResolvedManifest,
    dialogueHeadHash: string,
  ): Promise<FrozenRevision> {
    if (!Number.isSafeInteger(revision) || revision <= 0) {
      throw new ArtifactError('revision must be a positive safe integer', 'INVALID_SOURCE')
    }
    const { specBytes, configBytes, spec, config } = await readSourceDocuments(sourceDirectory)
    return await this.freezeRevision({
      labId,
      revision,
      specBytes,
      configBytes,
      spec,
      config,
      manifest,
      dialogueHeadHash,
    })
  }

  async readCurrent(labId: string): Promise<FrozenRevision> {
    const directory = this.labDirectory(labId)
    const directoryStat = await stat(directory).catch(error => {
      if (isNodeError(error)
        && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return undefined
      throw error
    })
    if (directoryStat?.isDirectory() !== true) {
      throw new ArtifactError(`Lab ${labId} was not found`, 'LAB_NOT_FOUND')
    }
    const pointer = await readCurrentPointer(join(directory, 'CURRENT'))
    return await readFrozenRevision(directory, pointer)
  }

  /** Return no revision only when CURRENT is genuinely absent. */
  async readCurrentIfPresent(labId: string): Promise<FrozenRevision | undefined> {
    const currentPath = join(this.labDirectory(labId), 'CURRENT')
    const currentStat = await stat(currentPath).catch(error => {
      if (isNodeError(error) && error.code === 'ENOENT') return undefined
      throw error
    })
    if (currentStat === undefined) return undefined
    if (!currentStat.isFile()) {
      throw new ArtifactError('CURRENT is not a regular file', 'INVALID_CURRENT')
    }
    return await this.readCurrent(labId)
  }

  /** Read one committed revision by number (historical or current). */
  async readRevisionAt(labId: string, revision: number): Promise<FrozenRevision> {
    return await readRevisionAtPath(this.labDirectory(labId), revision)
  }

  /** Freeze one Controller-authored configuration revision from exact texts. */
  async freezeConfigRevision(input: {
    labId: string
    revision: number
    spec: string
    config: string
    manifest: ResolvedManifest
    dialogueHeadHash: string
  }): Promise<FrozenRevision> {
    if (input.spec.trim().length === 0 || input.config.trim().length === 0) {
      throw new ArtifactError('LAB_SPEC.md and lab.yaml must not be empty', 'INVALID_SOURCE')
    }
    return await this.freezeRevision({
      labId: input.labId,
      revision: input.revision,
      specBytes: new TextEncoder().encode(input.spec),
      configBytes: new TextEncoder().encode(input.config),
      spec: input.spec,
      config: input.config,
      manifest: input.manifest,
      dialogueHeadHash: input.dialogueHeadHash,
    })
  }

  private async freezeRevision(input: {
    labId: string
    revision: number
    specBytes: Uint8Array
    configBytes: Uint8Array
    spec: string
    config: string
    manifest: ResolvedManifest
    dialogueHeadHash: string
  }): Promise<FrozenRevision> {
    const labDirectory = this.labDirectory(input.labId)
    const revisions = join(labDirectory, 'revisions')
    const revisionName = String(input.revision).padStart(6, '0')
    const revisionDirectory = join(revisions, revisionName)
    const temporary = join(revisions, `.${revisionName}.${randomUUID()}.tmp`)
    await mkdir(temporary, { mode: 0o700 })
    try {
      const specHash = sha256(input.specBytes)
      const configHash = sha256(input.configBytes)
      const manifest = validateRevisionManifest({
        manifest: input.manifest,
        labId: input.labId,
        labDirectory,
        revision: input.revision,
        specHash,
        configHash,
        dialogueHeadHash: input.dialogueHeadHash,
      })
      const manifestJson = canonicalJson(manifest)
      const manifestHash = sha256(manifestJson)
      const validation: RevisionValidation = {
        version: 1,
        hashAlgorithm: 'sha256',
        manifestCanonicalization: 'autolab-canonical-json-v1',
        dialogueHeadHash: input.dialogueHeadHash,
        specHash,
        configHash,
        manifestHash,
      }
      await durableWriteFile(join(temporary, 'LAB_SPEC.md'), input.specBytes, false)
      await durableWriteFile(join(temporary, 'lab.yaml'), input.configBytes, false)
      await durableWriteFile(join(temporary, 'RESOLVED_MANIFEST.json'), manifestJson, false)
      await durableWriteFile(
        join(temporary, 'VALIDATION.json'),
        `${JSON.stringify(validation, null, 2)}\n`,
        false,
      )
      const metadata = {
        version: 2,
        revision: input.revision,
        specHash,
        configHash,
        manifestHash,
        dialogueHeadHash: input.dialogueHeadHash,
      }
      await durableWriteFile(
        join(temporary, 'REVISION.json'),
        `${JSON.stringify(metadata, null, 2)}\n`,
        false,
      )
      await syncDirectory(temporary)
      let created = false
      try {
        await rename(temporary, revisionDirectory)
        created = true
      } catch (error) {
        if (!isNodeError(error) || (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY')) throw error
      }
      if (created) {
        await syncDirectory(revisions)
      }

      const pointer: CurrentPointer = {
        version: 2,
        revision: input.revision,
        revisionPath: relative(labDirectory, revisionDirectory),
        specHash,
        configHash,
        manifestHash,
        dialogueHeadHash: input.dialogueHeadHash,
      }
      const committed = await readFrozenRevision(labDirectory, pointer)
      if (committed.ref.specHash !== specHash
        || committed.ref.configHash !== configHash
        || committed.ref.manifestHash !== manifestHash
        || committed.ref.dialogueHeadHash !== input.dialogueHeadHash) {
        throw new ArtifactError(`revision ${input.revision} already exists with other bytes`, 'REVISION_EXISTS')
      }
      if (!created && (committed.spec !== input.spec
        || committed.config !== input.config
        || canonicalJson(committed.manifest) !== manifestJson)) {
        throw new ArtifactError(`revision ${input.revision} already exists with other text`, 'REVISION_EXISTS')
      }

      await durableWriteFile(
        join(labDirectory, 'CURRENT'),
        `${JSON.stringify(pointer, null, 2)}\n`,
        true,
      )
      return committed
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }
}

export function generateLabId(now = new Date()): string {
  const date = [
    now.getFullYear(),
    two(now.getMonth() + 1),
    two(now.getDate()),
  ].join('')
  const time = [two(now.getHours()), two(now.getMinutes()), two(now.getSeconds())].join('')
  return `lab-${date}-${time}-${randomBytes(4).toString('hex')}`
}

export async function durableWriteFile(
  path: string,
  value: Uint8Array | string,
  replace: boolean,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(value)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    if (replace) await rename(temporary, path)
    else await link(temporary, path)
    await syncDirectory(dirname(path))
  } finally {
    await rm(temporary, { force: true })
  }
}

/**
 * Read one committed revision by number directly from the lab directory. Used
 * by packet-verify paths so that a packet compiled under an older revision is
 * verified against its own revision's texts after CURRENT advances.
 */
/** All committed revision manifestHashes (any revision number on disk). */
export async function listCommittedManifestHashes(
  labDirectory: string,
): Promise<ReadonlySet<string>> {
  const revisions = resolve(labDirectory, 'revisions')
  const names = await readdir(revisions).catch(() => [] as string[])
  const hashes = new Set<string>()
  for (const name of names) {
    if (!/^\d{6}$/u.test(name)) continue
    const metadataBytes = await readFile(join(revisions, name, 'REVISION.json')).catch(() => undefined)
    if (metadataBytes === undefined) continue
    try {
      const metadata = JSON.parse(decodeText(metadataBytes, 'REVISION.json'))
      if (isRevisionMetadata(metadata)) hashes.add(metadata.manifestHash)
    } catch {
      continue
    }
  }
  return hashes
}

/** True when the hash matches the manifestHash of any committed revision <= current. */
export async function isCommittedManifestHash(
  labDirectory: string,
  manifestHash: string,
): Promise<boolean> {
  return (await listCommittedManifestHashes(labDirectory)).has(manifestHash)
}

export async function readRevisionAtPath(
  labDirectory: string,
  revision: number,
  current?: FrozenRevision,
): Promise<FrozenRevision> {
  if (current !== undefined && current.ref.revision === revision) return current
  const revisionDirectory = resolve(
    labDirectory,
    'revisions',
    String(revision).padStart(6, '0'),
  )
  const metadataBytes = await readFile(join(revisionDirectory, 'REVISION.json')).catch(() => undefined)
  if (metadataBytes === undefined) {
    throw new ArtifactError(`Revision ${revision} does not exist`, 'REVISION_MISSING')
  }
  let metadata: unknown
  try {
    metadata = JSON.parse(decodeText(metadataBytes, 'REVISION.json'))
  } catch {
    throw new ArtifactError('REVISION.json is malformed', 'INVALID_CURRENT')
  }
  if (!isRevisionMetadata(metadata) || metadata.revision !== revision) {
    throw new ArtifactError(
      'REVISION.json does not match the requested revision',
      'INVALID_CURRENT',
    )
  }
  return await readFrozenRevision(labDirectory, {
    version: 2,
    revision,
    revisionPath: join('revisions', String(revision).padStart(6, '0')),
    specHash: metadata.specHash,
    configHash: metadata.configHash,
    manifestHash: metadata.manifestHash,
    dialogueHeadHash: metadata.dialogueHeadHash,
  })
}

async function readFrozenRevision(
  labDirectory: string,
  pointer: CurrentPointer,
): Promise<FrozenRevision> {  const revisionName = String(pointer.revision).padStart(6, '0')
  const expectedPath = join('revisions', revisionName)
  if (pointer.revisionPath !== expectedPath) {
    throw new ArtifactError('CURRENT revision path does not match its revision', 'INVALID_CURRENT')
  }
  const revisionDirectory = resolve(labDirectory, pointer.revisionPath)
  const revisionsDirectory = resolve(labDirectory, 'revisions')
  if (!isInside(revisionsDirectory, revisionDirectory)) {
    throw new ArtifactError('CURRENT points outside its revisions directory', 'INVALID_CURRENT')
  }

  const [specBytes, configBytes, manifestBytes, validationBytes, metadataBytes] = await Promise.all([
    readFile(join(revisionDirectory, 'LAB_SPEC.md')).catch(() => undefined),
    readFile(join(revisionDirectory, 'lab.yaml')).catch(() => undefined),
    readFile(join(revisionDirectory, 'RESOLVED_MANIFEST.json')).catch(() => undefined),
    readFile(join(revisionDirectory, 'VALIDATION.json')).catch(() => undefined),
    readFile(join(revisionDirectory, 'REVISION.json')).catch(() => undefined),
  ])
  if (specBytes === undefined
    || configBytes === undefined
    || manifestBytes === undefined
    || validationBytes === undefined
    || metadataBytes === undefined) {
    throw new ArtifactError('CURRENT revision is not completely committed', 'REVISION_MISSING')
  }

  let metadata: unknown
  let manifestValue: unknown
  let validationValue: unknown
  try {
    metadata = JSON.parse(decodeText(metadataBytes, 'REVISION.json'))
    manifestValue = JSON.parse(decodeText(manifestBytes, 'RESOLVED_MANIFEST.json'))
    validationValue = JSON.parse(decodeText(validationBytes, 'VALIDATION.json'))
  } catch {
    throw new ArtifactError('REVISION.json is malformed', 'INVALID_CURRENT')
  }
  if (!isRevisionMetadata(metadata) || metadata.revision !== pointer.revision) {
    throw new ArtifactError('REVISION.json does not match CURRENT revision', 'INVALID_CURRENT')
  }
  if (metadata.specHash !== pointer.specHash
    || metadata.configHash !== pointer.configHash
    || metadata.manifestHash !== pointer.manifestHash
    || metadata.dialogueHeadHash !== pointer.dialogueHeadHash) {
    throw new ArtifactError('CURRENT hashes do not match REVISION.json', 'HASH_MISMATCH')
  }

  const specHash = sha256(specBytes)
  const configHash = sha256(configBytes)
  let manifest: ResolvedManifest
  try {
    manifest = parseResolvedManifest(manifestValue)
  } catch (error) {
    throw new ArtifactError(
      `RESOLVED_MANIFEST.json is invalid: ${error instanceof Error ? error.message : String(error)}`,
      'INVALID_CURRENT',
    )
  }
  const manifestJson = canonicalJson(manifest)
  if (decodeText(manifestBytes, 'RESOLVED_MANIFEST.json') !== manifestJson) {
    throw new ArtifactError('RESOLVED_MANIFEST.json is not the committed canonical bytes', 'HASH_MISMATCH')
  }
  const manifestHash = sha256(manifestJson)
  if (specHash !== metadata.specHash
    || configHash !== metadata.configHash
    || manifestHash !== metadata.manifestHash) {
    throw new ArtifactError('CURRENT revision hash does not match stored bytes', 'HASH_MISMATCH')
  }
  const validation = parseRevisionValidation(validationValue)
  if (validation.specHash !== specHash
    || validation.configHash !== configHash
    || validation.manifestHash !== manifestHash
    || validation.dialogueHeadHash !== pointer.dialogueHeadHash) {
    throw new ArtifactError('VALIDATION.json does not match CURRENT', 'HASH_MISMATCH')
  }
  validateRevisionManifest({
    manifest,
    labId: basename(labDirectory),
    labDirectory,
    revision: pointer.revision,
    specHash,
    configHash,
    dialogueHeadHash: pointer.dialogueHeadHash,
  })
  return {
    ref: {
      revision: pointer.revision,
      revisionPath: pointer.revisionPath,
      specHash,
      configHash,
      manifestHash,
      dialogueHeadHash: pointer.dialogueHeadHash,
    },
    spec: decodeText(specBytes, 'LAB_SPEC.md'),
    config: decodeText(configBytes, 'lab.yaml'),
    manifest,
    validation,
  }
}

async function readCurrentPointer(path: string): Promise<CurrentPointer> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new ArtifactError(
      `cannot read CURRENT: ${error instanceof Error ? error.message : String(error)}`,
      'INVALID_CURRENT',
    )
  }
  if (!isCurrentPointer(value)) {
    throw new ArtifactError('CURRENT is malformed', 'INVALID_CURRENT')
  }
  return value
}

function isCurrentPointer(value: unknown): value is CurrentPointer {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).length === 7
    && record.version === 2
    && Number.isSafeInteger(record.revision)
    && (record.revision as number) > 0
    && typeof record.revisionPath === 'string'
    && record.revisionPath.length > 0
    && typeof record.specHash === 'string'
    && /^[0-9a-f]{64}$/.test(record.specHash)
    && typeof record.configHash === 'string'
    && /^[0-9a-f]{64}$/.test(record.configHash)
    && typeof record.manifestHash === 'string'
    && /^[0-9a-f]{64}$/.test(record.manifestHash)
    && typeof record.dialogueHeadHash === 'string'
    && /^[0-9a-f]{64}$/.test(record.dialogueHeadHash)
}

function isRevisionMetadata(value: unknown): value is RevisionMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).length === 6
    && record.version === 2
    && Number.isSafeInteger(record.revision)
    && (record.revision as number) > 0
    && typeof record.specHash === 'string'
    && /^[0-9a-f]{64}$/.test(record.specHash)
    && typeof record.configHash === 'string'
    && /^[0-9a-f]{64}$/.test(record.configHash)
    && typeof record.manifestHash === 'string'
    && /^[0-9a-f]{64}$/.test(record.manifestHash)
    && typeof record.dialogueHeadHash === 'string'
    && /^[0-9a-f]{64}$/.test(record.dialogueHeadHash)
}

function decodeText(value: Uint8Array, name: string): string {
  try {
    return UTF8.decode(value)
  } catch {
    throw new ArtifactError(`${name} is not valid UTF-8`, 'INVALID_SOURCE')
  }
}

async function readSourceDocuments(sourceDirectory: string): Promise<{
  specBytes: Uint8Array
  configBytes: Uint8Array
  spec: string
  config: string
}> {
  const source = resolve(sourceDirectory)
  const sourceStat = await stat(source).catch(() => undefined)
  if (sourceStat?.isDirectory() !== true) {
    throw new ArtifactError('config-path must be a directory', 'INVALID_SOURCE')
  }
  const specBytes = await readFile(join(source, 'LAB_SPEC.md')).catch(() => undefined)
  const configBytes = await readFile(join(source, 'lab.yaml')).catch(() => undefined)
  if (specBytes === undefined || configBytes === undefined) {
    throw new ArtifactError(
      'config directory must contain LAB_SPEC.md and lab.yaml',
      'INVALID_SOURCE',
    )
  }
  const spec = decodeText(specBytes, 'LAB_SPEC.md')
  const config = decodeText(configBytes, 'lab.yaml')
  if (spec.trim().length === 0 || config.trim().length === 0) {
    throw new ArtifactError('LAB_SPEC.md and lab.yaml must not be empty', 'INVALID_SOURCE')
  }
  return { specBytes, configBytes, spec, config }
}

function draftSnapshot(input: {
  specBytes: Uint8Array
  configBytes: Uint8Array
  spec: string
  config: string
}): DraftSnapshot {
  return {
    spec: input.spec,
    config: input.config,
    specHash: sha256(input.specBytes),
    configHash: sha256(input.configBytes),
  }
}

function validateRevisionManifest(input: {
  manifest: ResolvedManifest
  labId: string
  labDirectory: string
  revision: number
  specHash: string
  configHash: string
  dialogueHeadHash: string
}): ResolvedManifest {
  const manifest = parseResolvedManifest(input.manifest)
  const revisionDirectory = join(
    resolve(input.labDirectory),
    'revisions',
    String(input.revision).padStart(6, '0'),
  )
  if (manifest.lab_id !== input.labId
    || manifest.source_revision !== input.revision
    || manifest.anchors.dialogue_head_sha256 !== input.dialogueHeadHash
    || manifest.anchors.lab_spec_sha256 !== input.specHash
    || manifest.anchors.lab_yaml_sha256 !== input.configHash
    || resolve(manifest.authority_paths.lab_dir) !== resolve(input.labDirectory)
    || resolve(manifest.authority_paths.lab_spec) !== join(revisionDirectory, 'LAB_SPEC.md')
    || resolve(manifest.authority_paths.lab_yaml) !== join(revisionDirectory, 'lab.yaml')
    || resolve(manifest.authority_paths.resolved_manifest)
      !== join(revisionDirectory, 'RESOLVED_MANIFEST.json')) {
    throw new ArtifactError(
      'ResolvedManifest anchors or authority paths do not match this revision',
      'INVALID_SOURCE',
    )
  }
  return manifest
}

function parseRevisionValidation(value: unknown): RevisionValidation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ArtifactError('VALIDATION.json must be an object', 'INVALID_CURRENT')
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 7
    || record.version !== 1
    || record.hashAlgorithm !== 'sha256'
    || record.manifestCanonicalization !== 'autolab-canonical-json-v1'
    || typeof record.dialogueHeadHash !== 'string'
    || !/^[0-9a-f]{64}$/u.test(record.dialogueHeadHash)
    || typeof record.specHash !== 'string'
    || !/^[0-9a-f]{64}$/u.test(record.specHash)
    || typeof record.configHash !== 'string'
    || !/^[0-9a-f]{64}$/u.test(record.configHash)
    || typeof record.manifestHash !== 'string'
    || !/^[0-9a-f]{64}$/u.test(record.manifestHash)) {
    throw new ArtifactError('VALIDATION.json schema is invalid', 'INVALID_CURRENT')
  }
  return value as RevisionValidation
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function isInside(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child))
  return path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
}

function two(value: number): string {
  return String(value).padStart(2, '0')
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}
