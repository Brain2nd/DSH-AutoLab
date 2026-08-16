import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import { durableWriteFile } from './artifacts.js'
import { canonicalJson, sha256 } from './integrity.js'
import {
  compileRunSlotContract,
  compileTrialContract,
  type FrozenRecord,
  type RunSlotContract,
  type TrialContract,
} from './trial.js'

const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

export interface FrozenTrialArtifacts {
  readonly trial: FrozenRecord<TrialContract> & { readonly path: string }
  readonly runSlots: Readonly<Record<
    string,
    FrozenRecord<RunSlotContract> & { readonly path: string }
  >>
}

export class TrialArtifactError extends Error {
  readonly name = 'TrialArtifactError'

  constructor(
    message: string,
    readonly code: 'INVALID_INPUT' | 'ARTIFACT_CONFLICT' | 'IO_FAILED',
  ) {
    super(message)
  }
}

/** Freeze one opaque Lab-authored Trial plus its minimal RunSlot contracts. */
export async function freezeTrialArtifacts(
  runRoot: string,
  value: unknown,
): Promise<FrozenTrialArtifacts> {
  if (!isAbsolute(runRoot) || resolve(runRoot) !== runRoot) {
    throw new TrialArtifactError('runRoot must be normalized and absolute', 'INVALID_INPUT')
  }
  const trial = compileTrialContract(value)
  const directory = join(runRoot, 'trials', sha256(trial.value.trial_id))
  const trialPath = join(directory, 'trial.json')
  await freezeExact(trialPath, trial.canonicalJson)

  const runSlots = Object.fromEntries(await Promise.all(trial.value.run_slots.map(async slot => {
    const compiled = compileRunSlotContract(trial, slot.runslot_id)
    const path = join(directory, 'run-slots', `${sha256(slot.runslot_id)}.json`)
    await freezeExact(path, compiled.canonicalJson)
    return [slot.runslot_id, Object.freeze({ ...compiled, path })] as const
  })))

  return Object.freeze({
    trial: Object.freeze({ ...trial, path: trialPath }),
    runSlots: Object.freeze(runSlots),
  })
}

async function freezeExact(path: string, text: string): Promise<void> {
  let observed = await readRegular(path, true)
  if (observed === undefined) {
    try {
      await durableWriteFile(path, text, false)
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') {
        throw new TrialArtifactError(
          `cannot freeze Trial artifact ${path}: ${renderError(error)}`,
          'IO_FAILED',
        )
      }
    }
    observed = await readRegular(path, false)
  }
  if (observed === undefined || observed !== text) {
    throw new TrialArtifactError(
      `immutable Trial artifact conflicts at ${path}`,
      'ARTIFACT_CONFLICT',
    )
  }
}

async function readRegular(path: string, allowMissing: boolean): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, READ_FLAGS)
    if (!(await handle.stat()).isFile()) {
      throw new TrialArtifactError(`${path} is not a regular file`, 'ARTIFACT_CONFLICT')
    }
    return await handle.readFile('utf8')
  } catch (error) {
    if (error instanceof TrialArtifactError) throw error
    if (allowMissing && isNodeError(error)
      && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return undefined
    if (isNodeError(error) && error.code === 'ELOOP') {
      throw new TrialArtifactError(`${path} is not a regular file`, 'ARTIFACT_CONFLICT')
    }
    throw new TrialArtifactError(`cannot read Trial artifact ${path}: ${renderError(error)}`, 'IO_FAILED')
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}

function renderError(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
