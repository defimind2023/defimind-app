import type { KeyObject } from 'node:crypto'
import { alert } from './events.js'
import { allAnchors, hashesBetween, lastAnchor } from '../db/anchors.js'
import type { Db } from '../db/client.js'
import { merkleRoot } from '../domain/merkle.js'
import { checkChain, type Integrity } from './executions.js'
import type { PaymentDeps } from './payments.js'

export const INTEGRITY_EVERY_MS = 86_400_000

/**
 * Re-checks the execution chain at start-up and once a day (CR-013). A break is told to the owner
 * once, through the bot and the panel, not again on every check that finds the same one.
 */
export function integrityMonitor(deps: PaymentDeps, key: KeyObject) {
  let current: Integrity = { lastSeq: 0, lastHash: '' }
  return {
    check(): Integrity {
      const before = current.brokenAt
      current = withAnchors(deps.db, checkChain(deps.db, key))
      if (current.brokenAt !== undefined && current.brokenAt !== before) {
        deps.log.error({ brokenAt: current.brokenAt }, 'execution chain broken')
        alert(deps, { kind: 'chain_broken', detail: `seq ${current.brokenAt}` })
      }
      return current
    },
    current: () => current,
  }
}

export type IntegrityMonitor = ReturnType<typeof integrityMonitor>

/**
 * What the chain alone cannot see. Deleting the newest receipts leaves a valid, shorter chain; an
 * anchor remembers how far it reached and the root over what it covered. So a chain that ends
 * before an anchor's toSeq, or a range whose root no longer matches, is broken there too.
 */
export function withAnchors(db: Db, chain: Integrity): Integrity {
  let brokenAt = chain.brokenAt
  const mark = (seq: number) => {
    brokenAt = brokenAt === undefined ? seq : Math.min(brokenAt, seq)
  }
  for (const anchor of allAnchors(db)) {
    if (anchor.toSeq > chain.lastSeq) {
      mark(chain.lastSeq + 1)
      continue
    }
    const hashes = hashesBetween(db, anchor.fromSeq, anchor.toSeq)
    if (hashes.length !== anchor.toSeq - anchor.fromSeq + 1 || merkleRoot(hashes) !== anchor.root) {
      mark(anchor.fromSeq)
    }
  }
  const last = lastAnchor(db)
  return {
    ...chain,
    ...(brokenAt === undefined ? {} : { brokenAt }),
    ...(last === undefined ? {} : { lastAnchor: last }),
  }
}
