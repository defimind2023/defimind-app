import { appendFileSync } from 'node:fs'

export interface BodyEntry {
  /** The receipt this content belongs to; absent while the report waits in the outbox. */
  receipt?: { seq: number; hash: string }
  server: string
  tool: string
  requestHash: string
  responseHash: string
  arguments: unknown
  result: unknown
}

/**
 * GATEWAY_KEEP_BODIES: the operator's own copy of what was sent and received, so a receipt's
 * hashes can be matched to content later. DefiMind never sees it.
 */
export function bodyLog(path: string): (entry: BodyEntry) => void {
  return (entry) => appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
}
