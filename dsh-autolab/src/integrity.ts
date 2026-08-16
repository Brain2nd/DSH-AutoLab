import { createHash } from 'node:crypto'

export function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Stable JSON bytes for hashes and durable identities; never calls an LLM. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value)
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonical JSON does not allow NaN or Infinity')
      return JSON.stringify(value)
    case 'object': {
      if (Array.isArray(value)) {
        const items: string[] = []
        for (let index = 0; index < value.length; index += 1) {
          if (!Object.hasOwn(value, index)) throw new TypeError('canonical JSON does not allow sparse arrays')
          items.push(canonicalJson(value[index]))
        }
        return `[${items.join(',')}]`
      }
      const prototype = Object.getPrototypeOf(value)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('canonical JSON accepts only plain objects')
      }
      const record = value as Record<string, unknown>
      return `{${Object.keys(record).sort().map(key => (
        `${JSON.stringify(key)}:${canonicalJson(record[key])}`
      )).join(',')}}`
    }
    default:
      throw new TypeError(`canonical JSON does not allow ${typeof value}`)
  }
}
