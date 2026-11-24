import type { PayIntent, SwapQuote } from '@defimind/shared'
import * as repo from '../db/repo.js'
import { boughtToday, everHeld, getPosition } from '../db/trades.js'
import { evaluateTrade } from '../domain/trading.js'
import { reject, type PaymentDeps } from './payments.js'
import { clearSwap, pairOf } from './swap.js'
import { adapterFor } from './wallets.js'

/**
 * A swap the owner approved. The policy runs again, since the agent may have been paused or the
 * day's budget spent meanwhile, then the adapter builds and checks a fresh transaction, which must
 * still give the minimum the owner saw for the amount the owner saw. Nothing is re-quoted into a
 * lower minimum.
 */
export async function sendApprovedSwap(deps: PaymentDeps, first: PayIntent): Promise<PayIntent> {
  return deps.serial(first.agentId, async () => {
    const { db, now } = deps
    const intent = repo.getIntent(db, first.id)
    if (intent?.status !== 'approved' || intent.kind !== 'swap' || intent.swap === undefined) {
      return intent ?? first
    }
    const details = intent.swap
    const adapter = adapterFor(deps, intent.agentId, intent.chain)
    const policy = repo.getPolicy(db, intent.agentId)
    const request = {
      agentId: intent.agentId,
      chain: intent.chain,
      tokenIn: intent.token,
      tokenOut: details.tokenOut,
      amountIn: intent.amount,
    }
    const pair = pairOf(deps, request)
    if (adapter === undefined || policy === undefined || pair === undefined) {
      return reject(deps, intent, ['CHAIN_NOT_ALLOWED'])
    }
    // The terms the owner approved, as a quote: its age and its minimum are the intent's own.
    const quote: SwapQuote = {
      ...request,
      venue: details.venue,
      expectedOut: details.minAmountOut,
      minAmountOut: details.minAmountOut,
      slippageBps: details.slippageBps,
      priceImpactBps: details.priceImpactBps,
      exitImpactBps: 0,
      risks: [],
      flags: [],
      quotedAt: now().toISOString(),
      decimalsIn: details.decimalsIn,
      decimalsOut: details.decimalsOut,
    }
    const verdict = evaluateTrade(
      { ...pair, request, quote },
      policy,
      {
        tradedToday: boughtToday(db, intent.agentId, intent.chain, repo.utcDay(now())),
        positionCost: getPosition(db, intent.agentId, intent.chain, pair.token).cost,
        boughtBefore: everHeld(db, intent.chain, pair.token),
      },
      now(),
    )
    if (verdict.reasons.length > 0) {
      return reject(deps, intent, verdict.reasons)
    }
    const how = { side: pair.side, verdict, shadow: false, policy }
    return clearSwap(deps, adapter, intent, how, 'approved')
  })
}
