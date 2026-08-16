import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { freezeTrialArtifacts } from '../src/trial-artifacts.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function trial() {
  return {
    version: 1 as const,
    trial_id: 'trial-a',
    lane_id: 'lane-a',
    candidate_sha: 'a'.repeat(40),
    config_revision: 1,
    contract: { arbitrary_lab_contract: ['kept', 'opaque'] },
    run_slots: [
      { runslot_id: 'slot-a', contract: { seed: 7 } },
      { runslot_id: 'slot-b' },
    ],
    created_at: 10,
  }
}

describe('immutable Trial artifacts', () => {
  it('freezes opaque science bytes once and replays the same identities', async () => {
    const runRoot = await mkdtemp(join(tmpdir(), 'dsh-autolab-trial-artifacts-'))
    roots.push(runRoot)
    const first = await freezeTrialArtifacts(runRoot, trial())
    const replay = await freezeTrialArtifacts(runRoot, structuredClone(trial()))

    expect(replay).toEqual(first)
    expect(await readFile(first.trial.path, 'utf8')).toBe(first.trial.canonicalJson)
    expect(Object.keys(first.runSlots).sort()).toEqual(['slot-a', 'slot-b'])
    expect(first.runSlots['slot-a']?.value.contract).toEqual({ seed: 7 })
  })

  it('does not replace conflicting or non-regular immutable paths', async () => {
    const runRoot = await mkdtemp(join(tmpdir(), 'dsh-autolab-trial-artifacts-'))
    roots.push(runRoot)
    const first = await freezeTrialArtifacts(runRoot, trial())
    await rm(first.trial.path)
    await symlink('/dev/null', first.trial.path)

    await expect(freezeTrialArtifacts(runRoot, trial())).rejects.toMatchObject({
      code: 'ARTIFACT_CONFLICT',
    })
  })
})
