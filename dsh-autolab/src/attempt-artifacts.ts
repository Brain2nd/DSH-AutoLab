import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import { z } from 'zod'

import { durableWriteFile, type FrozenRevision } from './artifacts.js'
import { canonicalJson, sha256 } from './integrity.js'
import {
  compileLocalTmuxLaunch,
  type LocalTmuxLaunchPlan,
} from './runner.js'
import {
  attemptSchema,
  attemptUncertainReceiptSchema,
  createInitialAttempt,
  createRetryAttempt,
  parseAttempt,
  parseRunSlotState,
  runSlotContractSchema,
  type Attempt,
  type AttemptCompletionReceipt,
  type AttemptStartedReceipt,
  type AttemptUncertainReceipt,
  type FrozenRecord,
  type RunSlotAttemptTransition,
  type RunSlotContract,
  type RunSlotState,
  type TerminalAttempt,
  type TrialContract,
} from './trial.js'

const HASH_PATTERN = /^[0-9a-f]{64}$/u
const GIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
const READ_REGULAR_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

const id = z.string().min(1)
const hash = z.string().regex(HASH_PATTERN)
const absolutePath = z.string().min(1).refine(
  value => isAbsolute(value) && resolve(value) === value,
  'path must be normalized and absolute',
)
const component = z.object({ id, version: id, sha256: hash }).strict()

export const localAttemptRequestSchema = z.object({
  version: z.literal(1),
  kind: z.literal('AUTOLAB_LOCAL_TMUX_REQUEST'),
  lab_id: id,
  config_revision: z.number().int().positive(),
  trial_id: id,
  runslot_id: id,
  attempt_id: id,
  attempt_ordinal: z.number().int().positive(),
  launch_nonce: z.string().uuid(),
  candidate_sha: z.string().regex(GIT_SHA_PATTERN),
  runner: component,
  host_id: id,
  command: z.array(id).min(1),
  env: z.record(z.string(), z.string()),
  cwd: absolutePath,
  checkout_path: absolutePath,
  attempt_directory: absolutePath,
  runtime_poke_file: absolutePath.optional(),
  issued_at: z.number().int().nonnegative(),
}).strict()

export type LocalAttemptRequest = z.infer<typeof localAttemptRequestSchema>

export interface AttemptArtifactReference {
  readonly path: string
  readonly hash: string
}

export interface CreateInitialLocalAttemptInput {
  readonly frozen: FrozenRevision
  readonly trial: FrozenRecord<TrialContract>
  readonly runSlot: FrozenRecord<RunSlotContract>
  readonly runSlotState: RunSlotState
  readonly hostId: string
  readonly command: readonly string[]
  readonly env: Readonly<Record<string, string>>
  /** Stable mutable endpoint pointer; its contents are never Attempt truth. */
  readonly runtimePokeFile?: string
  /** Stable time already anchored by the Trial/Controller projection. */
  readonly issuedAt: number
}

export interface CreateRetryLocalAttemptInput {
  readonly frozen: FrozenRevision
  /** Exact immutable failed intent read from the active Controller reference. */
  readonly previous: ReadLocalAttemptIntent
  readonly runSlotState: RunSlotState
  readonly hostId: string
  readonly command: readonly string[]
  readonly env: Readonly<Record<string, string>>
  /** Stable mutable endpoint pointer; its contents are never Attempt truth. */
  readonly runtimePokeFile?: string
}

export interface FrozenLocalAttemptIntent {
  readonly request: FrozenRecord<LocalAttemptRequest> & { readonly path: string }
  readonly attempt: FrozenRecord<Attempt> & { readonly path: string }
  readonly transition: RunSlotAttemptTransition
  readonly launchPlan: LocalTmuxLaunchPlan
  readonly checkoutPath: string
}

export interface ReadLocalAttemptIntent {
  readonly request: FrozenRecord<LocalAttemptRequest> & { readonly path: string }
  readonly attempt: FrozenRecord<Attempt> & { readonly path: string }
  readonly launchPlan: LocalTmuxLaunchPlan
}

export class AttemptArtifactError extends Error {
  readonly name = 'AttemptArtifactError'

  constructor(
    message: string,
    readonly code:
      | 'INVALID_INPUT'
      | 'IDENTITY_MISMATCH'
      | 'ARTIFACT_CONFLICT'
      | 'ARTIFACT_CORRUPT'
      | 'IO_FAILED',
  ) {
    super(message)
  }
}

/** Freeze the exact initial Attempt intent before its short Controller CAS. */
export async function freezeInitialLocalAttempt(
  input: CreateInitialLocalAttemptInput,
): Promise<FrozenLocalAttemptIntent> {
  const compiled = compileInitialLocalAttempt(input)
  await freezeCanonical(compiled.request.path, compiled.request.canonicalJson)
  await freezeCanonical(compiled.attempt.path, compiled.attempt.canonicalJson)
  return compiled
}

/** Recompile and verify an initial intent without trusting mutable process state. */
export async function verifyInitialLocalAttempt(
  input: CreateInitialLocalAttemptInput,
): Promise<FrozenLocalAttemptIntent> {
  const expected = compileInitialLocalAttempt(input)
  const observed = await readLocalAttemptIntent({
    runRoot: input.frozen.manifest.execution.run_root,
    activeAttempt: { path: expected.attempt.path, hash: expected.attempt.sha256 },
  })
  if (observed.request.canonicalJson !== expected.request.canonicalJson
    || observed.attempt.canonicalJson !== expected.attempt.canonicalJson) {
    fail('Initial Attempt artifacts do not reproduce their frozen inputs', 'ARTIFACT_CORRUPT')
  }
  return expected
}

/** Freeze one new technical retry while preserving the exact failed lineage. */
export async function freezeRetryLocalAttempt(
  input: CreateRetryLocalAttemptInput,
): Promise<FrozenLocalAttemptIntent> {
  const compiled = compileRetryLocalAttempt(input)
  await freezeCanonical(compiled.request.path, compiled.request.canonicalJson)
  await freezeCanonical(compiled.attempt.path, compiled.attempt.canonicalJson)
  return compiled
}

/** Read the exact current Attempt plus its immutable local-runner request. */
export async function readLocalAttemptIntent(input: {
  readonly runRoot: string
  readonly activeAttempt: AttemptArtifactReference
}): Promise<ReadLocalAttemptIntent> {
  const attempt = await readAttemptArtifact(input.activeAttempt)
  const requestPath = localAttemptRequestPath(input.runRoot, attempt.value.attempt_id)
  const request = await readRequestArtifact(requestPath)
  if (attempt.value.request.kind !== 'runner_request'
    || attempt.value.request.sha256 !== request.sha256
    || request.value.attempt_id !== attempt.value.attempt_id
    || request.value.attempt_ordinal !== attempt.value.attempt_ordinal
    || request.value.launch_nonce !== attempt.value.launch_nonce
    || request.value.candidate_sha !== attempt.value.candidate_sha
    || request.value.config_revision !== attempt.value.config_revision
    || request.value.trial_id !== attempt.value.trial_id
    || request.value.runslot_id !== attempt.value.runslot_id
    || request.value.runner.id !== attempt.value.runner.id
    || request.value.runner.version !== attempt.value.runner.version
    || request.value.runner.sha256 !== attempt.value.runner.sha256
    || request.value.host_id !== attempt.value.host_id
    || request.value.cwd !== attempt.value.cwd) {
    fail('Local runner request does not match its active Attempt', 'IDENTITY_MISMATCH')
  }
  const launchPlan = compileLaunchPlan(request.value)
  if (attempt.value.env_sha256 !== launchPlan.envHash) {
    fail('Local runner request environment does not match its Attempt', 'IDENTITY_MISMATCH')
  }
  return Object.freeze({ request, attempt, launchPlan })
}

/** Freeze a later running/unknown/terminal Attempt projection. */
export async function freezeAttemptStateArtifact(
  runRoot: string,
  runSlotRevision: number,
  attemptInput: Attempt,
): Promise<FrozenRecord<Attempt> & { readonly path: string }> {
  const attempt = parseAttempt(attemptInput)
  const canonical = canonicalJson(attempt)
  const path = attemptStatePath(runRoot, attempt.attempt_id, runSlotRevision, attempt.phase)
  await freezeCanonical(path, canonical)
  return Object.freeze({ value: attempt, canonicalJson: canonical, sha256: sha256(canonical), path })
}

export async function freezeAttemptReceiptArtifact(
  runRoot: string,
  attemptId: string,
  kind: 'started' | 'completion' | 'uncertain',
  receipt: FrozenRecord<
    AttemptStartedReceipt | AttemptCompletionReceipt | AttemptUncertainReceipt
  >,
): Promise<{ readonly path: string; readonly sha256: string }> {
  const path = join(localAttemptDirectory(runRoot, attemptId), 'receipts', `${kind}.json`)
  await freezeCanonical(path, receipt.canonicalJson)
  return Object.freeze({ path, sha256: receipt.sha256 })
}

/** Adopt the first durable unknown observation across the artifact-before-CAS crash window. */
export async function readAttemptUncertainReceiptArtifactIfPresent(
  runRoot: string,
  attemptId: string,
): Promise<(FrozenRecord<AttemptUncertainReceipt> & { readonly path: string }) | undefined> {
  const path = join(localAttemptDirectory(runRoot, attemptId), 'receipts', 'uncertain.json')
  const bytes = await readRegular(path, true, 'Attempt uncertain receipt')
  if (bytes === undefined) return undefined
  const text = decode(bytes, 'Attempt uncertain receipt')
  let value: AttemptUncertainReceipt
  try {
    value = attemptUncertainReceiptSchema.parse(JSON.parse(text) as unknown)
  } catch (error) {
    fail(`Attempt uncertain receipt is invalid: ${errorMessage(error)}`, 'ARTIFACT_CORRUPT')
  }
  if (canonicalJson(value) !== text) {
    fail('Attempt uncertain receipt is not canonical', 'ARTIFACT_CORRUPT')
  }
  return Object.freeze({
    value,
    canonicalJson: text,
    sha256: sha256(bytes),
    path,
  })
}

export function localAttemptDirectory(runRoot: string, attemptId: string): string {
  assertRootAndId(runRoot, attemptId)
  return join(runRoot, 'attempts', attemptId)
}

export function localAttemptCheckoutPath(runRoot: string, attemptId: string): string {
  assertRootAndId(runRoot, attemptId)
  return join(runRoot, 'checkouts', attemptId)
}

export function localAttemptRequestPath(runRoot: string, attemptId: string): string {
  return join(localAttemptDirectory(runRoot, attemptId), 'request.json')
}

function compileInitialLocalAttempt(
  input: CreateInitialLocalAttemptInput,
): FrozenLocalAttemptIntent {
  assertFrozenInputs(input)
  const state = parseRunSlotState(input.runSlotState)
  const attemptId = deriveAttemptId({
    labId: input.frozen.manifest.lab_id,
    configRevision: input.frozen.ref.revision,
    trialId: input.runSlot.value.trial_id,
    runSlotId: input.runSlot.value.runslot_id,
    runSlotContractSha256: input.runSlot.sha256,
    ordinal: 1,
  })
  const launchNonce = uuidFromHash(sha256(`autolab-attempt-launch-nonce-v1\0${attemptId}`))
  const runRoot = input.frozen.manifest.execution.run_root
  const attemptDirectory = localAttemptDirectory(runRoot, attemptId)
  const checkoutPath = localAttemptCheckoutPath(runRoot, attemptId)
  const requestValue = parseLocalAttemptRequest({
    version: 1,
    kind: 'AUTOLAB_LOCAL_TMUX_REQUEST',
    lab_id: input.frozen.manifest.lab_id,
    config_revision: input.frozen.ref.revision,
    trial_id: input.trial.value.trial_id,
    runslot_id: input.runSlot.value.runslot_id,
    attempt_id: attemptId,
    attempt_ordinal: 1,
    launch_nonce: launchNonce,
    candidate_sha: input.runSlot.value.candidate_sha,
    runner: input.frozen.manifest.execution.runner_adapter,
    host_id: input.hostId,
    command: [...input.command],
    env: Object.fromEntries(Object.entries(input.env).sort(([left], [right]) => (
      left.localeCompare(right)
    ))),
    cwd: checkoutPath,
    checkout_path: checkoutPath,
    attempt_directory: attemptDirectory,
    ...(input.runtimePokeFile === undefined
      ? {}
      : { runtime_poke_file: input.runtimePokeFile }),
    issued_at: input.issuedAt,
  })
  const requestCanonical = canonicalJson(requestValue)
  const requestHash = sha256(requestCanonical)
  const request = Object.freeze({
    value: requestValue,
    canonicalJson: requestCanonical,
    sha256: requestHash,
    path: localAttemptRequestPath(runRoot, attemptId),
  })
  const launchPlan = compileLaunchPlan(requestValue)
  const transition = createInitialAttempt(
    input.runSlot,
    state,
    state.revision,
    {
      attempt_id: attemptId,
      request: { kind: 'runner_request', sha256: requestHash },
      cwd: requestValue.cwd,
      env_sha256: launchPlan.envHash,
      runner: requestValue.runner,
      host_id: requestValue.host_id,
      launch_nonce: requestValue.launch_nonce,
      launched_at: requestValue.issued_at,
    },
  )
  const attemptCanonical = canonicalJson(transition.attempt)
  const attempt = Object.freeze({
    value: transition.attempt,
    canonicalJson: attemptCanonical,
    sha256: sha256(attemptCanonical),
    path: attemptStatePath(
      runRoot,
      attemptId,
      transition.state.revision,
      transition.attempt.phase,
    ),
  })
  return Object.freeze({ request, attempt, transition, launchPlan, checkoutPath })
}

function compileRetryLocalAttempt(
  input: CreateRetryLocalAttemptInput,
): FrozenLocalAttemptIntent {
  const previous = assertRetryFrozenInputs(input)
  const state = parseRunSlotState(input.runSlotState)
  const attemptOrdinal = previous.attempt_ordinal + 1
  const attemptId = deriveAttemptId({
    labId: input.frozen.manifest.lab_id,
    configRevision: input.frozen.ref.revision,
    trialId: previous.trial_id,
    runSlotId: previous.runslot_id,
    runSlotContractSha256: previous.runslot_contract_sha256,
    ordinal: attemptOrdinal,
  })
  const launchNonce = uuidFromHash(sha256(`autolab-attempt-launch-nonce-v1\0${attemptId}`))
  const runRoot = input.frozen.manifest.execution.run_root
  const attemptDirectory = localAttemptDirectory(runRoot, attemptId)
  const checkoutPath = localAttemptCheckoutPath(runRoot, attemptId)
  const requestValue = parseLocalAttemptRequest({
    version: 1,
    kind: 'AUTOLAB_LOCAL_TMUX_REQUEST',
    lab_id: input.frozen.manifest.lab_id,
    config_revision: input.frozen.ref.revision,
    trial_id: previous.trial_id,
    runslot_id: previous.runslot_id,
    attempt_id: attemptId,
    attempt_ordinal: attemptOrdinal,
    launch_nonce: launchNonce,
    candidate_sha: previous.candidate_sha,
    runner: input.frozen.manifest.execution.runner_adapter,
    host_id: input.hostId,
    command: [...input.command],
    env: Object.fromEntries(Object.entries(input.env).sort(([left], [right]) => (
      left.localeCompare(right)
    ))),
    cwd: checkoutPath,
    checkout_path: checkoutPath,
    attempt_directory: attemptDirectory,
    ...(input.runtimePokeFile === undefined
      ? {}
      : { runtime_poke_file: input.runtimePokeFile }),
    // A retry intent may be frozen before its RuntimeState CAS and replayed
    // after another owner adopts the Lab. Anchor its immutable bytes to the
    // predecessor instead of mutable RuntimeState.updatedAt.
    issued_at: previous.completed_at,
  })
  const requestCanonical = canonicalJson(requestValue)
  const requestHash = sha256(requestCanonical)
  const request = Object.freeze({
    value: requestValue,
    canonicalJson: requestCanonical,
    sha256: requestHash,
    path: localAttemptRequestPath(runRoot, attemptId),
  })
  const launchPlan = compileLaunchPlan(requestValue)
  const transition = createRetryAttempt(
    state,
    state.revision,
    previous,
    {
      attempt_id: attemptId,
      request: { kind: 'runner_request', sha256: requestHash },
      cwd: requestValue.cwd,
      env_sha256: launchPlan.envHash,
      runner: requestValue.runner,
      host_id: requestValue.host_id,
      launch_nonce: requestValue.launch_nonce,
      launched_at: requestValue.issued_at,
    },
  )
  const attemptCanonical = canonicalJson(transition.attempt)
  const attempt = Object.freeze({
    value: transition.attempt,
    canonicalJson: attemptCanonical,
    sha256: sha256(attemptCanonical),
    path: attemptStatePath(
      runRoot,
      attemptId,
      transition.state.revision,
      transition.attempt.phase,
    ),
  })
  return Object.freeze({ request, attempt, transition, launchPlan, checkoutPath })
}

function compileLaunchPlan(request: LocalAttemptRequest): LocalTmuxLaunchPlan {
  return compileLocalTmuxLaunch({
    attemptId: request.attempt_id,
    launchNonce: request.launch_nonce,
    candidateSha: request.candidate_sha,
    cwd: request.cwd,
    attemptDirectory: request.attempt_directory,
    command: request.command,
    env: request.env,
    ...(request.runtime_poke_file === undefined
      ? {}
      : { runtimePokeFile: request.runtime_poke_file }),
    issuedAt: request.issued_at,
  })
}

function assertFrozenInputs(input: CreateInitialLocalAttemptInput): void {
  if (input.frozen.manifest.execution.runner_adapter.id !== 'local-tmux'
    || input.frozen.manifest.execution.runner_adapter.version !== '1') {
    fail('Initial local Attempt requires the built-in local-tmux adapter v1', 'INVALID_INPUT')
  }
  if (!input.frozen.manifest.execution.hosts.some(host => (
    host.host_id === input.hostId && host.runner_target === 'local'
  ))) {
    fail('Initial local Attempt host is not a frozen local target', 'INVALID_INPUT')
  }
  const expectedSlot = input.trial.value.run_slots.find(slot => (
    slot.runslot_id === input.runSlot.value.runslot_id
  ))
  if (input.trial.value.config_revision !== input.frozen.ref.revision
    || input.trial.value.trial_id !== input.runSlot.value.trial_id
    || input.runSlot.value.trial_contract_sha256 !== input.trial.sha256
    || input.trial.value.candidate_sha !== input.runSlot.value.candidate_sha
    || expectedSlot === undefined
    || input.runSlot.sha256 !== sha256(canonicalJson(runSlotContractSchema.parse(input.runSlot.value)))
    || input.runSlotState.status !== 'pending'
    || input.runSlotState.runslot_contract_sha256 !== input.runSlot.sha256) {
    fail('Trial, RunSlot, state, or CURRENT identity does not match', 'IDENTITY_MISMATCH')
  }
  if (!Number.isSafeInteger(input.issuedAt) || input.issuedAt < input.trial.value.created_at) {
    fail('Attempt issuedAt must be a stable time at or after Trial creation', 'INVALID_INPUT')
  }
}

function assertRetryFrozenInputs(input: CreateRetryLocalAttemptInput): TerminalAttempt {
  const previous = parseAttempt(input.previous.attempt.value)
  const request = parseLocalAttemptRequest(input.previous.request.value)
  const runner = input.frozen.manifest.execution.runner_adapter
  if (runner.id !== 'local-tmux' || runner.version !== '1') {
    fail('Local Attempt retry requires the built-in local-tmux adapter v1', 'INVALID_INPUT')
  }
  if (!input.frozen.manifest.execution.hosts.some(host => (
    host.host_id === input.hostId && host.runner_target === 'local'
  ))) {
    fail('Local Attempt retry host is not a frozen local target', 'INVALID_INPUT')
  }
  if (previous.phase !== 'terminal'
    || previous.technical_outcome !== 'failed'
    || previous.config_revision !== input.frozen.ref.revision
    || request.lab_id !== input.frozen.manifest.lab_id
    || request.config_revision !== input.frozen.ref.revision
    || request.attempt_id !== previous.attempt_id
    || request.attempt_ordinal !== previous.attempt_ordinal
    || request.candidate_sha !== previous.candidate_sha
    || request.trial_id !== previous.trial_id
    || request.runslot_id !== previous.runslot_id
    || canonicalJson(previous.runner) !== canonicalJson(runner)) {
    fail('Failed Attempt, request, or CURRENT identity does not match', 'IDENTITY_MISMATCH')
  }
  return previous
}

async function readAttemptArtifact(
  reference: AttemptArtifactReference,
): Promise<FrozenRecord<Attempt> & { readonly path: string }> {
  validateReference(reference)
  const bytes = await readRegular(reference.path, false, 'Attempt artifact')
  if (bytes === undefined || sha256(bytes) !== reference.hash) {
    fail('Attempt artifact hash does not match its Controller reference', 'ARTIFACT_CORRUPT')
  }
  const text = decode(bytes, 'Attempt artifact')
  let value: Attempt
  try {
    value = attemptSchema.parse(JSON.parse(text) as unknown)
  } catch (error) {
    fail(`Attempt artifact is invalid: ${errorMessage(error)}`, 'ARTIFACT_CORRUPT')
  }
  if (canonicalJson(value) !== text) fail('Attempt artifact is not canonical', 'ARTIFACT_CORRUPT')
  return Object.freeze({ value, canonicalJson: text, sha256: reference.hash, path: reference.path })
}

async function readRequestArtifact(
  path: string,
): Promise<FrozenRecord<LocalAttemptRequest> & { readonly path: string }> {
  const bytes = await readRegular(path, false, 'local Attempt request')
  if (bytes === undefined) fail('Local Attempt request is missing', 'ARTIFACT_CORRUPT')
  const text = decode(bytes, 'local Attempt request')
  let value: LocalAttemptRequest
  try {
    value = parseLocalAttemptRequest(JSON.parse(text) as unknown)
  } catch (error) {
    fail(`Local Attempt request is invalid: ${errorMessage(error)}`, 'ARTIFACT_CORRUPT')
  }
  if (canonicalJson(value) !== text) fail('Local Attempt request is not canonical', 'ARTIFACT_CORRUPT')
  return Object.freeze({ value, canonicalJson: text, sha256: sha256(text), path })
}

async function freezeCanonical(path: string, text: string): Promise<void> {
  let bytes = await readRegular(path, true, 'immutable Attempt artifact')
  if (bytes === undefined) {
    try {
      await durableWriteFile(path, text, false)
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') throw error
    }
    bytes = await readRegular(path, false, 'immutable Attempt artifact')
  }
  if (bytes === undefined || !bytes.equals(Buffer.from(text, 'utf8'))) {
    fail(`Immutable Attempt artifact conflicts at ${path}`, 'ARTIFACT_CONFLICT')
  }
}

async function readRegular(
  path: string,
  allowMissing: boolean,
  label: string,
): Promise<Buffer | undefined> {
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(path, READ_REGULAR_FLAGS)
    if (!(await file.stat()).isFile()) fail(`${label} is not a regular file at ${path}`, 'ARTIFACT_CORRUPT')
    return await file.readFile()
  } catch (error) {
    if (error instanceof AttemptArtifactError) throw error
    if (isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      if (allowMissing) return undefined
      fail(`${label} is missing at ${path}`, 'ARTIFACT_CORRUPT')
    }
    if (isNodeError(error) && error.code === 'ELOOP') {
      fail(`${label} is not a regular file at ${path}`, 'ARTIFACT_CORRUPT')
    }
    fail(`${label} I/O failed at ${path}: ${errorMessage(error)}`, 'IO_FAILED')
  } finally {
    await file?.close().catch(() => undefined)
  }
}

function attemptStatePath(
  runRoot: string,
  attemptId: string,
  runSlotRevision: number,
  phase: Attempt['phase'],
): string {
  if (!Number.isSafeInteger(runSlotRevision) || runSlotRevision <= 0) {
    fail('RunSlot revision must be positive for an Attempt artifact', 'INVALID_INPUT')
  }
  return join(
    localAttemptDirectory(runRoot, attemptId),
    'state',
    `${String(runSlotRevision).padStart(6, '0')}-${phase}.json`,
  )
}

function deriveAttemptId(input: {
  readonly labId: string
  readonly configRevision: number
  readonly trialId: string
  readonly runSlotId: string
  readonly runSlotContractSha256: string
  readonly ordinal: number
}): string {
  return `attempt-${sha256(canonicalJson({
    version: 1,
    lab_id: input.labId,
    config_revision: input.configRevision,
    trial_id: input.trialId,
    runslot_id: input.runSlotId,
    runslot_contract_sha256: input.runSlotContractSha256,
    attempt_ordinal: input.ordinal,
  }))}`
}

function uuidFromHash(value: string): string {
  const digits = value.slice(0, 32).split('')
  digits[12] = '5'
  digits[16] = ((Number.parseInt(digits[16]!, 16) & 0x3) | 0x8).toString(16)
  const joined = digits.join('')
  return [
    joined.slice(0, 8),
    joined.slice(8, 12),
    joined.slice(12, 16),
    joined.slice(16, 20),
    joined.slice(20),
  ].join('-')
}

function parseLocalAttemptRequest(value: unknown): LocalAttemptRequest {
  const parsed = localAttemptRequestSchema.safeParse(value)
  if (!parsed.success) fail(`Invalid local Attempt request: ${parsed.error.message}`, 'INVALID_INPUT')
  return parsed.data
}

function validateReference(reference: AttemptArtifactReference): void {
  if (!isAbsolute(reference.path)
    || resolve(reference.path) !== reference.path
    || !HASH_PATTERN.test(reference.hash)) {
    fail('Attempt reference requires a normalized absolute path and SHA-256', 'INVALID_INPUT')
  }
}

function assertRootAndId(runRoot: string, attemptId: string): void {
  if (!isAbsolute(runRoot) || resolve(runRoot) !== runRoot || !/^[A-Za-z0-9][A-Za-z0-9._:-]+$/u.test(attemptId)) {
    fail('Run root and Attempt ID are invalid', 'INVALID_INPUT')
  }
}

function decode(bytes: Buffer, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    fail(`${label} is not valid UTF-8`, 'ARTIFACT_CORRUPT')
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function fail(message: string, code: AttemptArtifactError['code']): never {
  throw new AttemptArtifactError(message, code)
}
