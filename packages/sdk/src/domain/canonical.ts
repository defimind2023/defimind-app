import { createHash } from 'node:crypto'

/**
 * JSON with object keys sorted at every depth and no whitespace, byte for byte what guard-core
 * hashes and signs: anyone checking a receipt has to reproduce the same bytes.
 */
export function canonicalJson(value: unknown): string {
  // JSON.stringify(undefined) is not JSON; a call that returns nothing hashes as null.
  return JSON.stringify(sortKeys(value)) ?? 'null'
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys)
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    )
  }
  return value
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** What requestHash and responseHash are: the hex SHA-256 of a value's canonical JSON. */
export function hashOf(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}
