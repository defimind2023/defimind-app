import type { Anchor, ExecutionReceipt } from '@defimind/shared'
import { createHash, sign, verify, type KeyObject } from 'node:crypto'
import type { Db } from '../db/client.js'
import { executionsFrom, insertExecution, lastExecution } from '../db/executions.js'
import { canonicalJson } from '../domain/canonical.js'

export const GENESIS = '0'.repeat(64)

/** What the caller knows about one call; the chain adds the rest. */
export type Entry = Pick<
  ExecutionReceipt,
  | 'agentId'
  | 'kind'
  | 'server'
  | 'tool'
  | 'requestHash'
  | 'responseHash'
  | 'outcome'
  | 'assurance'
  | 'startedAt'
  | 'endedAt'
> & { paymentReceipt?: string }

type Unsigned = Omit<ExecutionReceipt, 'hash' | 'signature'>

/** The bytes both the hash and the signature cover. */
function body(receipt: Unsigned): Buffer {
  return Buffer.from(canonicalJson(receipt))
}

export function sha256Hex(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Appends one receipt to the deployment's chain. The read of the last link and the insert run in
 * one synchronous transaction, so two appends at once take seq n and n+1, never both n.
 */
export function appendExecution(db: Db, key: KeyObject, entry: Entry, now: Date): ExecutionReceipt {
  return db.$client.transaction(() => {
    const last = lastExecution(db)
    const unsigned: Unsigned = {
      type: 'defimind.execution.v1',
      seq: (last?.seq ?? 0) + 1,
      prevHash: last?.hash ?? GENESIS,
      ...entry,
      issuedAt: now.toISOString(),
    }
    const bytes = body(unsigned)
    const receipt: ExecutionReceipt = {
      ...unsigned,
      hash: sha256Hex(bytes),
      signature: sign(null, bytes, key).toString('hex'),
    }
    insertExecution(db, receipt)
    return receipt
  })()
}

export interface Integrity {
  lastSeq: number
  lastHash: string
  /** The first seq whose link, hash or signature does not hold, or that an anchor no longer covers. */
  brokenAt?: number
  lastAnchor?: Anchor
}

/** Whether one receipt is what was signed: its own hash and the key's signature over it. */
export function receiptHolds(receipt: ExecutionReceipt, key: KeyObject): boolean {
  const { hash, signature, ...unsigned } = receipt
  const bytes = body(unsigned)
  return (
    sha256Hex(bytes) === hash &&
    /^[0-9a-f]{128}$/.test(signature) &&
    verify(null, bytes, key, Buffer.from(signature, 'hex'))
  )
}

/**
 * Walks the whole chain: every seq one more than the last, every prevHash the last hash, every
 * receipt its own hash and signed by the key. A deleted, inserted or edited row breaks one of them.
 */
export function checkChain(db: Db, key: KeyObject, page = 1_000): Integrity {
  let lastSeq = 0
  let lastHash = GENESIS
  for (;;) {
    const batch = executionsFrom(db, lastSeq, page)
    for (const receipt of batch) {
      if (
        receipt.seq !== lastSeq + 1 ||
        receipt.prevHash !== lastHash ||
        !receiptHolds(receipt, key)
      ) {
        return { lastSeq, lastHash, brokenAt: lastSeq + 1 }
      }
      lastSeq = receipt.seq
      lastHash = receipt.hash
    }
    if (batch.length < page) {
      return { lastSeq, lastHash }
    }
  }
}
