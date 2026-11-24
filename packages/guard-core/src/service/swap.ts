import { type ChainAdapter, SwapUnavailable } from '@defimind/onchain'
import type { Amount, PayIntent, Policy, SwapQuote } from '@defimind/shared'
import { z } from 'zod'
import { admit } from '../db/breaker.js'
import { ownerApprovalMethod, recordOwnerApproval, saveClearance } from '../db/receipts.js'
import * as repo from '../db/repo.js'
import { addBought, boughtToday, everHeld, getPosition, shadowBoughtToday } from '../db/trades.js'
import { parseAmount } from '../domain/amount.js'
import { evaluateTrade, type Trade, type TradeVerdict } from '../domain/trading.js'
import { HttpError } from '../http/errors.js'
import type { QuoteRequest, SwapRequest } from '../http/schemas.js'
import { askOwner } from './approvals.js'
import { needsPasskey } from './passkeys.js'
import { finish, fund, newIntent, reject, shadowed, trip, type PaymentDeps } from './payments.js'
import { policyHash } from './receipts.js'
import { simulate } from './simulate.js'
import { settle } from './swap-settle.js'
import { adapterFor } from './wallets.js'

/** Read from the mints onchain by the adapter; a quote without them is not one we can record. */
const mints = z.object({
  decimalsIn: z.number().int().min(0).max(255),
  decimalsOut: z.number().int().min(0).max(255),
  symbolIn: z.string().max(32).optional(),
  symbolOut: z.string().max(32).optional(),
})

type Pair = Pick<Trade, 'side' | 'token'>

/** Phase 1: every swap has the chain's dollar on exactly one side. */
export function pairOf(deps: PaymentDeps, req: QuoteRequest): Pair | undefined {
  const dollar = deps.usdc.get(req.chain)
  if (dollar === undefined || req.tokenIn === req.tokenOut) {
    return undefined
  }
  if (req.tokenIn === dollar) {
    return { side: 'buy', token: req.tokenOut }
  }
  return req.tokenOut === dollar ? { side: 'sell', token: req.tokenIn } : undefined
}

/** The venue is down or answered nonsense: the route says 502, as for an upstream x402 API. */
export class VenueUnavailable extends Error {
  constructor() {
    super('venue_unavailable')
  }
}

/** The venue's quote, or 'no_route'. A venue that is down is not a rejection of the trade. */
export async function fetchQuote(
  adapter: ChainAdapter,
  req: QuoteRequest,
  slippageBps: number,
): Promise<SwapQuote | 'no_route'> {
  if (adapter.quoteSwap === undefined) {
    return 'no_route'
  }
  try {
    const { tokenIn, tokenOut, amountIn } = req
    return await adapter.quoteSwap({ tokenIn, tokenOut, amountIn, slippageBps })
  } catch (error) {
    if (error instanceof SwapUnavailable && error.code === 'no_route') {
      return 'no_route'
    }
    throw new VenueUnavailable()
  }
}

/** The intent with the quote's terms, or undefined when the quote lacks the mints' decimals. */
export function withQuote(
  intent: PayIntent,
  quote: SwapQuote,
  tokenOut: string,
): PayIntent | undefined {
  const decimals = mints.safeParse(quote)
  if (!decimals.success) {
    return undefined
  }
  const { venue, minAmountOut, slippageBps, priceImpactBps, quotedAt } = quote
  return {
    ...intent,
    swap: {
      venue,
      tokenOut,
      minAmountOut,
      slippageBps,
      priceImpactBps,
      quotedAt,
      ...decimals.data,
    },
  }
}

/** What the owner is shown for a buy that has drawn nothing yet: it is tested once approved. */
const UNTESTED = {
  summary: 'not tested yet: the hot wallet is funded and the swap tested once you approve',
  balanceChanges: [],
}

/** POST /v1/agent/quote: read-only, so it decides nothing and records nothing. */
export async function quote(deps: PaymentDeps, req: QuoteRequest, policy: Policy) {
  const trading = policy.trading
  const adapter = adapterFor(deps, req.agentId, req.chain)
  if (trading === undefined || !trading.enabled) {
    throw new HttpError(403, 'trading_disabled')
  }
  if (adapter?.quoteSwap === undefined || pairOf(deps, req) === undefined) {
    throw new HttpError(400, 'not_tradable')
  }
  const slippage = Math.min(trading.maxSlippageBps, req.maxSlippageBps ?? Infinity)
  const answer = await fetchQuote(adapter, req, slippage)
  if (answer === 'no_route') {
    throw new HttpError(404, 'no_route')
  }
  return answer
}

/**
 * POST /v1/agent/swap: the same pipeline as a payment, with the trading policy (CR-021). `manual`
 * is the owner's own trade (CR-025): the passkey already approved it, for no less than the
 * minimum the owner saw.
 */
export async function swap(
  deps: PaymentDeps,
  req: SwapRequest,
  manual?: { minAmountOut: Amount },
): Promise<PayIntent> {
  return deps.serial(req.agentId, async () => {
    const { db, now } = deps
    const adapter = adapterFor(deps, req.agentId, req.chain)
    const intent = newIntent(
      {
        agentId: req.agentId,
        kind: 'swap',
        chain: req.chain,
        token: req.tokenIn,
        amount: req.amountIn,
        // A swap sends nothing anywhere: what it buys lands in the hot wallet itself.
        recipient: adapter === undefined ? '' : (await adapter.getAllowanceState()).delegate,
        reason: req.reason,
      },
      now(),
    )
    // Saved once there is something to decide: a venue that is down leaves no intent behind.
    const policy = repo.getPolicy(db, req.agentId)
    const pair = pairOf(deps, req)
    const early =
      policy === undefined
        ? 'PAUSED'
        : adapter === undefined || !policy.chains.includes(req.chain)
          ? 'CHAIN_NOT_ALLOWED'
          : policy.trading?.enabled !== true
            ? 'TRADING_DISABLED'
            : adapter.quoteSwap === undefined
              ? 'VENUE_NOT_ALLOWED'
              : pair === undefined
                ? 'TOKEN_NOT_TRADABLE'
                : undefined
    if (early !== undefined || policy?.trading === undefined || !adapter || !pair) {
      return reject(deps, intent, [early ?? 'TRADING_DISABLED'])
    }
    const slippage = Math.min(policy.trading.maxSlippageBps, req.maxSlippageBps ?? Infinity)
    const answer = await fetchQuote(adapter, req, slippage)
    if (answer === 'no_route') {
      return reject(deps, intent, ['NO_EXIT_ROUTE'])
    }
    const priced = withQuote(intent, answer, req.tokenOut)
    if (priced === undefined) {
      return reject(deps, intent, ['SIM_UNEXPECTED_EFFECT'])
    }
    if (manual && parseAmount(answer.minAmountOut) < parseAmount(manual.minAmountOut)) {
      return reject(deps, priced, ['SLIPPAGE_TOO_HIGH'])
    }
    repo.saveIntent(db, priced)
    const shadow = policy.mode === 'shadow'
    const day = repo.utcDay(now())
    const trade: Trade = { ...pair, request: req, quote: answer }
    const verdict = evaluateTrade(
      trade,
      policy,
      {
        tradedToday: shadow
          ? shadowBoughtToday(db, req.agentId, req.chain, day, req.tokenIn)
          : boughtToday(db, req.agentId, req.chain, day),
        positionCost: getPosition(db, req.agentId, req.chain, pair.token).cost,
        boughtBefore: everHeld(db, req.chain, pair.token),
      },
      now(),
    )
    repo.audit(
      db,
      {
        event: 'policy_evaluated',
        intentId: intent.id,
        agentId: intent.agentId,
        decision: verdict.decision,
        reasons: verdict.reasons,
        detail: {
          side: pair.side,
          ...(verdict.flags.length > 0 ? { flags: verdict.flags } : {}),
          ...(manual ? { via: 'owner' } : {}),
        },
      },
      now(),
    )
    if (verdict.reasons.length > 0) {
      return reject(deps, priced, verdict.reasons)
    }
    const how = { side: pair.side, verdict, shadow, policy }
    if (manual === undefined) {
      return clearSwap(deps, adapter, priced, how)
    }
    recordOwnerApproval(db, intent.id, 'passkey')
    return clearSwap(deps, adapter, priced, how, 'approved')
  })
}

/**
 * The adapter's checks, then the owner or the signature. A buy is topped up before its test run:
 * the adapter cannot draw inside a venue's transaction, and the onchain cap still bounds the draw.
 * Nothing is drawn while the owner has not answered (GC-66): a buy that must wait and that the hot
 * wallet cannot cover goes to the owner untested, and is funded and tested once approved. In
 * shadow nothing is drawn or signed, so a hot wallet short of the dollar records the quote alone.
 */
export async function clearSwap(
  deps: PaymentDeps,
  adapter: ChainAdapter,
  intent: PayIntent,
  how: { side: 'buy' | 'sell'; verdict: TradeVerdict; shadow: boolean; policy: Policy },
  /** Set when the owner has already answered: their approval, or their own Close. */
  owner?: 'approved' | 'close',
): Promise<PayIntent> {
  const { db, now } = deps
  const short =
    parseAmount(await adapter.getHotWalletBalance(intent.token)) < parseAmount(intent.amount)
  const asks = how.verdict.decision === 'needs_approval'
  if (how.shadow && short) {
    return shadowed(deps, intent, how.verdict.flags, asks)
  }
  const waits = how.verdict.decision === 'needs_approval' && owner === undefined
  if (waits && short) {
    const passkey = needsPasskey(deps.passkey, intent)
    return askOwner(deps, intent, UNTESTED, { flags: how.verdict.flags, passkey })
  }
  if (how.side === 'buy' && !how.shadow) {
    try {
      await fund(deps, adapter, intent)
    } catch (error) {
      deps.log.error({ err: error, intentId: intent.id }, 'hot wallet top-up failed')
      return finish(deps, intent, { status: 'failed' })
    }
  }
  const { simulation, reasons, error } = await simulate(deps, adapter, intent)
  repo.audit(
    db,
    {
      event: 'simulated',
      intentId: intent.id,
      agentId: intent.agentId,
      reasons,
      detail: { summary: simulation?.summary, error },
    },
    now(),
  )
  if (simulation === undefined || reasons.length > 0) {
    return reject(deps, intent, reasons)
  }
  if (how.shadow) {
    return shadowed(deps, intent, how.verdict.flags, asks)
  }
  if (waits) {
    const passkey = needsPasskey(deps.passkey, intent)
    return askOwner(deps, intent, simulation, { flags: how.verdict.flags, passkey })
  }
  const limit = how.policy.maxPaymentsPerMinute ?? 10
  // The owner's Close is not an agent looping, so the breaker does not count it.
  if (owner !== 'close' && !admit(db, intent, limit, now())) {
    return trip(deps, intent, limit)
  }
  const approved: PayIntent = { ...intent, status: 'approved', rejectReasons: [] }
  repo.saveIntent(db, approved)
  saveClearance(db, {
    intentId: intent.id,
    policyHash: policyHash(how.policy),
    simulation: simulation.summary,
    approvedBy: owner === undefined ? 'policy' : (ownerApprovalMethod(db, intent.id) ?? 'owner'),
  })
  if (how.side === 'buy') {
    addBought(db, intent.agentId, intent.chain, repo.utcDay(now()), intent.amount)
  }
  return settle(deps, adapter, approved, how.side, simulation)
}
