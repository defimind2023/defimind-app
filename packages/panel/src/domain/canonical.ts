/**
 * JSON with object keys sorted at every depth and no whitespace: byte for byte what guard-core
 * hashes, so a payment execution's paymentReceipt can be matched to the receipt it names.
 */
export function canonicalJson(value: unknown): string {
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
