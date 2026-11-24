import type { FastifyInstance } from 'fastify'
import { anchorJob, type AnchorPublisher } from '../service/anchor.js'
import { INTEGRITY_EVERY_MS } from '../service/integrity.js'
import type { PaymentDeps } from '../service/payments.js'
import { sweep } from '../service/sweep.js'

/** The background work: the daily chain check, the anchor job and the expiry sweep. */
export function startTimers(
  first: FastifyInstance,
  deps: PaymentDeps,
  options: { anchorPublisher?: AnchorPublisher; sweepMs?: number },
): void {
  if (deps.integrity !== undefined) {
    const { integrity } = deps
    integrity.check()
    const daily = setInterval(() => integrity.check(), INTEGRITY_EVERY_MS)
    daily.unref()
    first.addHook('onClose', async () => clearInterval(daily))
  }
  if (options.anchorPublisher !== undefined && deps.receiptKey !== undefined) {
    const anchors = anchorJob({
      db: deps.db,
      publisher: options.anchorPublisher,
      now: deps.now,
      log: first.log,
    })
    // Every minute: the job itself decides when an hour or 1,000 receipts have come.
    const minutely = setInterval(() => void anchors.tick(), 60_000)
    minutely.unref()
    first.addHook('onClose', async () => clearInterval(minutely))
  }
  if (options.sweepMs !== undefined) {
    const timer = setInterval(() => {
      const expired = sweep(deps)
      if (expired > 0) {
        first.log.info({ expired }, 'expired pending intents')
      }
    }, options.sweepMs)
    first.addHook('onClose', async () => clearInterval(timer))
  }
}
