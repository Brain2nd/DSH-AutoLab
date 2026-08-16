import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import {
  EMPTY_FACT_SET,
  currentFactAnchor,
  readFactSet,
  registerFact,
} from '../src/fact-registry.js'
import { canonicalJson, sha256 } from '../src/integrity.js'

describe('fact-registry', () => {
  it('registers facts additively as canonical JSON and anchors the current bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autolab-facts-'))
    const factPath = join(root, 'facts.json')
    try {
      const emptyAnchor = await currentFactAnchor(factPath)
      expect(emptyAnchor.factSetSha256).toBe(sha256(EMPTY_FACT_SET))
      expect(emptyAnchor.relevantFactRefs).toEqual([])
      expect(await readFactSet(factPath)).toEqual({ version: 1, facts: [] })

      const first = await registerFact({
        factPath,
        factId: 'user-directive-1',
        kind: 'user_directive',
        statement: 'Use native AdamW only.',
        source: 'user, session-a, 2026-08-16',
        evidenceStatus: 'user-authorized',
        registeredBy: 'controller:session-x',
        registeredAt: 1,
      })
      expect(first.factIndex).toBe(0)

      const text = await readFile(factPath, 'utf8')
      expect(text).toBe(canonicalJson({
        version: 1,
        facts: [{
          fact_id: 'user-directive-1',
          kind: 'user_directive',
          statement: 'Use native AdamW only.',
          source: 'user, session-a, 2026-08-16',
          evidence_status: 'user-authorized',
          registered_by: 'controller:session-x',
          registered_at: 1,
        }],
      }))
      const anchor = await currentFactAnchor(factPath)
      expect(anchor.factSetSha256).toBe(first.factSetSha256)
      expect(anchor.factSetSha256).toBe(sha256(text))
      expect(anchor.relevantFactRefs).toEqual([{ id: 'fact-set', sha256: anchor.factSetSha256 }])

      const second = await registerFact({
        factPath,
        factId: 'user-directive-2',
        kind: 'user_directive',
        statement: 'Keep thresholds same-recipe.',
        source: 'user, session-a, 2026-08-16',
        evidenceStatus: 'user-authorized',
        registeredBy: 'controller:session-x',
        registeredAt: 2,
      })
      expect(second.factIndex).toBe(1)
      const set = await readFactSet(factPath)
      expect(set.facts.map(fact => fact.fact_id)).toEqual(['user-directive-1', 'user-directive-2'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects duplicate fact ids and invalid fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-autolab-facts-'))
    const factPath = join(root, 'facts.json')
    try {
      await registerFact({
        factPath,
        factId: 'dup',
        kind: 'user_directive',
        statement: 'first',
        source: 'user',
        evidenceStatus: 'user-authorized',
        registeredBy: 'controller',
        registeredAt: 1,
      })
      await expect(registerFact({
        factPath,
        factId: 'dup',
        kind: 'user_directive',
        statement: 'second',
        source: 'user',
        evidenceStatus: 'user-authorized',
        registeredBy: 'controller',
        registeredAt: 2,
      })).rejects.toThrow('already registered')
      await expect(registerFact({
        factPath,
        factId: 'blank',
        kind: 'user_directive',
        statement: '   ',
        source: 'user',
        evidenceStatus: 'user-authorized',
        registeredBy: 'controller',
        registeredAt: 2,
      })).rejects.toThrow('non-empty')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
