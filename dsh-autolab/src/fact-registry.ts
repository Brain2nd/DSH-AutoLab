import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import { z } from 'zod'

import { durableWriteFile } from './artifacts.js'
import { canonicalJson, sha256 } from './integrity.js'

/**
 * Lab fact set registry.
 *
 * The fact set file lives at `manifest.authority_paths.fact_set` and is frozen
 * to the empty v1 set at initial role activation. Facts are additive,
 * immutable, canonical-JSON records with explicit source and evidence status:
 * they are the landing point for user decisions that override or refine frozen
 * LAB_SPEC text (LAB_SPEC §0 grants the user final authority; a registered
 * fact makes that decision visible in the anchored record chain Judges read).
 *
 * Every packet compiled AFTER a registration anchors the CURRENT fact set
 * bytes; historical packets keep their historical anchors and still reproduce
 * exactly from their stored anchors.
 */

const factSchema = z.object({
  fact_id: z.string().min(1),
  kind: z.string().min(1),
  statement: z.string().min(1),
  source: z.string().min(1),
  evidence_status: z.string().min(1),
  registered_by: z.string().min(1),
  registered_at: z.number().int().nonnegative(),
}).strict()

const factSetSchema = z.object({
  version: z.literal(1),
  facts: z.array(factSchema),
}).strict()

export type RegisteredFact = z.infer<typeof factSchema>
export type FactSet = z.infer<typeof factSetSchema>

export const EMPTY_FACT_SET = canonicalJson({ version: 1, facts: [] })

export class FactRegistryError extends Error {
  readonly name = 'FactRegistryError'

  constructor(
    message: string,
    readonly code: 'INVALID_INPUT' | 'INVALID_FACT_SET' | 'FACT_CONFLICT',
  ) {
    super(message)
  }
}

export interface RegisterFactInput {
  readonly factPath: string
  readonly factId: string
  readonly kind: string
  readonly statement: string
  readonly source: string
  readonly evidenceStatus: string
  readonly registeredBy: string
  readonly registeredAt: number
}

export interface RegisterFactResult {
  readonly factPath: string
  readonly factSetSha256: string
  readonly factIndex: number
  readonly fact: RegisteredFact
}

export interface FactAnchor {
  readonly factSetSha256: string
  readonly relevantFactRefs: ReadonlyArray<{ readonly id: string; readonly sha256: string }>
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

async function readBytesIfPresent(factPath: string): Promise<Uint8Array | undefined> {
  try {
    return await readFile(factPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Read and strictly validate the current fact set; a missing file is the empty set. */
export async function readFactSet(factPath: string): Promise<FactSet> {
  const bytes = await readBytesIfPresent(factPath)
  if (bytes === undefined) return { version: 1, facts: [] }
  const text = decodeUtf8(bytes)
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new FactRegistryError(`Fact set at ${factPath} is not JSON`, 'INVALID_FACT_SET')
  }
  if (canonicalJson(value) !== text) {
    throw new FactRegistryError(`Fact set at ${factPath} is not canonical JSON`, 'INVALID_FACT_SET')
  }
  const parsed = factSetSchema.safeParse(value)
  if (!parsed.success) {
    throw new FactRegistryError(`Fact set at ${factPath} is not a valid v1 Fact Set`, 'INVALID_FACT_SET')
  }
  return parsed.data
}

/**
 * Anchor for a packet compiled NOW: the sha256 of the current fact set bytes
 * plus a fact-set reference when at least one fact is registered, so Judges
 * see the registered directives in the packet's runtime snapshot.
 */
export async function currentFactAnchor(factPath: string): Promise<FactAnchor> {
  const bytes = await readBytesIfPresent(factPath)
  const text = bytes === undefined ? EMPTY_FACT_SET : decodeUtf8(bytes)
  const factSet = factSetSchema.parse(JSON.parse(text))
  const factSetSha256 = sha256(text)
  return {
    factSetSha256,
    relevantFactRefs: factSet.facts.length === 0 ? [] : [{ id: 'fact-set', sha256: factSetSha256 }],
  }
}

/** Append one immutable fact to the fact set and return the new anchor result. */
export async function registerFact(input: RegisterFactInput): Promise<RegisterFactResult> {
  if (!isAbsolute(input.factPath)) {
    throw new FactRegistryError('factPath must be absolute', 'INVALID_INPUT')
  }
  if (input.factId.trim().length === 0
    || input.kind.trim().length === 0
    || input.statement.trim().length === 0
    || input.source.trim().length === 0
    || input.evidenceStatus.trim().length === 0
    || input.registeredBy.trim().length === 0) {
    throw new FactRegistryError('fact fields must be non-empty', 'INVALID_INPUT')
  }
  const fact = factSchema.parse({
    fact_id: input.factId,
    kind: input.kind,
    statement: input.statement,
    source: input.source,
    evidence_status: input.evidenceStatus,
    registered_by: input.registeredBy,
    registered_at: input.registeredAt,
  })
  const current = await readFactSet(input.factPath)
  if (current.facts.some(existing => existing.fact_id === fact.fact_id)) {
    throw new FactRegistryError(`Fact ${fact.fact_id} is already registered`, 'FACT_CONFLICT')
  }
  const next: FactSet = { version: 1, facts: [...current.facts, fact] }
  const text = canonicalJson(next)
  await durableWriteFile(input.factPath, text, true)
  return {
    factPath: input.factPath,
    factSetSha256: sha256(text),
    factIndex: current.facts.length,
    fact,
  }
}
