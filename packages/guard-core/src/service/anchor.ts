import type { Anchor } from '@defimind/shared'
import type { FastifyBaseLogger } from 'fastify'
import type { Db } from '../db/client.js'
import { firstUnanchored, hashesBetween, lastAnchor, saveAnchor } from '../db/anchors.js'
import { lastExecution } from '../db/executions.js'
import { merkleRoot } from '../domain/merkle.js'

export const ANCHOR_EVERY_MS = 60 * 60_000
export const ANCHOR_MAX_RECEIPTS = 1_000

/** Publishes one memo in one transaction on `chain`; the anchor key pays its fee. */
export interface AnchorPublisher {
  chain: string
  publish(memo: string): Promise<string>
}

export function anchorMemo(fromSeq: number, toSeq: number, root: string): string {
  return `defimind:anchor:v1:${fromSeq}-${toSeq}:${root}`
}

/**
 * The anchor job (CR-013): every hour, or as soon as 1,000 receipts wait, whichever comes first,
 * and never with no new receipt. A failed publication stores nothing and is tried again on the
 * next tick: the receipts stay valid without an anchor.
 */
export function anchorJob(deps: {
  db: Db
  publisher: AnchorPublisher
  now: () => Date
  log: Pick<FastifyBaseLogger, 'warn' | 'info'>
}) {
  let running = false

  async function tick(): Promise<Anchor | undefined> {
    // One at a time, so a slow RPC cannot publish the same range twice.
    if (running) {
      return undefined
    }
    running = true
    try {
      return await anchorDue()
    } finally {
      running = false
    }
  }

  async function anchorDue(): Promise<Anchor | undefined> {
    const { db, now } = deps
    const previous = lastAnchor(db)
    const afterSeq = previous?.toSeq ?? 0
    const first = firstUnanchored(db, afterSeq)
    const last = lastExecution(db)
    if (first === undefined || last === undefined) {
      return undefined
    }
    const since = new Date(previous?.anchoredAt ?? first.issuedAt).getTime()
    const waiting = last.seq - afterSeq
    if (waiting < ANCHOR_MAX_RECEIPTS && now().getTime() - since < ANCHOR_EVERY_MS) {
      return undefined
    }
    const fromSeq = afterSeq + 1
    const toSeq = Math.min(last.seq, afterSeq + ANCHOR_MAX_RECEIPTS)
    const root = merkleRoot(hashesBetween(db, fromSeq, toSeq))
    try {
      const txId = await deps.publisher.publish(anchorMemo(fromSeq, toSeq, root))
      const anchor = {
        fromSeq,
        toSeq,
        root,
        chain: deps.publisher.chain,
        txId,
        anchoredAt: now().toISOString(),
      }
      saveAnchor(db, anchor)
      deps.log.info({ fromSeq, toSeq, txId }, 'receipts anchored')
      return anchor
    } catch {
      // The RPC's error may quote its URL, which can carry a key.
      deps.log.warn({ fromSeq, toSeq, chain: deps.publisher.chain }, 'anchor not published')
      return undefined
    }
  }

  return { tick }
}
