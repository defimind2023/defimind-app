import type {
  Policy,
  PolicyDecision,
  RejectCode,
  SwapQuote,
  TradingFlag,
  TradingPolicy,
} from '@defimind/shared'
import { parseAmount } from './amount.js'

/** What a trading policy means for the fields it leaves out (SPEC v0.16). */
export const TRADING_DEFAULTS = { maxSlippageBps: 100, maxPriceImpactBps: 300 } as const

/** A quote older than this has moved on; a quote stamped later than this ahead is not believed. */
export const QUOTE_MAX_AGE_MS = 30_000
const QUOTE_SKEW_MS = 5_000

const BPS = 10_000n

/**
 * One swap as the policy sees it. Every swap has the chain's dollar on one side (phase 1): a buy
 * spends it on `token`, a sell turns `token` back into it.
 */
export interface Trade {
  side: 'buy' | 'sell'
  /** The token that is not the chain's dollar. */
  token: string
  /** What the agent asked for: the quote must answer exactly this. */
  request: { tokenIn: string; tokenOut: string; amountIn: string; maxSlippageBps?: number }
  quote: SwapQuote
}

/** What the agent's trading so far means for this trade, from executed swaps. */
export interface Book {
  /** Today's buys, in the chain's dollar. */
  tradedToday: bigint
  /** What the agent holds of `token`, at cost. */
  positionCost: bigint
  /** Whether any buy of `token` has ever executed, for any agent. */
  boughtBefore: boolean
}

export interface TradeVerdict {
  decision: PolicyDecision
  reasons: RejectCode[]
  flags: TradingFlag[]
}

/**
 * Default deny, as for payments: a swap is approved only when no rule objects. The quote comes
 * from a venue nobody trusts, so it is checked against the request and against itself, never
 * believed. Pure, so every attack case is a test.
 */
export function evaluateTrade(trade: Trade, policy: Policy, book: Book, now: Date): TradeVerdict {
  const trading = policy.trading
  if (trading === undefined || !trading.enabled) {
    return { decision: 'reject', reasons: ['TRADING_DISABLED'], flags: [] }
  }
  const reasons: RejectCode[] = []
  const add = (reason: RejectCode) => {
    if (!reasons.includes(reason)) {
      reasons.push(reason)
    }
  }
  if (policy.paused) {
    add('PAUSED')
  }
  // A swap cannot name a mandate yet, so an owner who allows payments only inside a task budget
  // gets no swaps at all until mandates have a design for trades.
  if (policy.requireMandate === true) {
    add('MANDATE_REQUIRED')
  }
  const { quote, request, side } = trade
  if (!trading.venues.includes(quote.venue)) {
    add('VENUE_NOT_ALLOWED')
  }
  // Selling is always allowed, so an agent can leave a token the owner has since taken off the list.
  if (side === 'buy' && !trading.allowAnyToken && !trading.tokens.includes(trade.token)) {
    add('TOKEN_NOT_TRADABLE')
  }
  for (const reason of quoteReasons(trade, trading, now)) {
    add(reason)
  }

  const amountIn = parseAmount(request.amountIn)
  if (side === 'buy') {
    if (amountIn > parseAmount(trading.maxTradeUsd)) {
      add('TRADE_EXCEEDED')
    }
    if (book.tradedToday + amountIn > parseAmount(trading.dailyTradeMax)) {
      add('TRADE_DAILY_EXCEEDED')
    }
    if (book.positionCost + amountIn > parseAmount(trading.maxPositionUsd)) {
      add('POSITION_EXCEEDED')
    }
    for (const risk of quote.risks) {
      add(risk)
    }
    const exit = quote.exitImpactBps
    if (exit === null || exit > trading.maxPriceImpactBps) {
      add('NO_EXIT_ROUTE')
    }
  }

  if (reasons.length > 0) {
    return { decision: 'reject', reasons, flags: [] }
  }
  // A sell never waits: holding a token is the risk, and the owner's own Close is a sell too.
  if (side === 'sell') {
    return { decision: 'approve', reasons: [], flags: [] }
  }
  const flags = buyFlags(quote, book)
  const waits = flags.length > 0 || amountIn >= parseAmount(policy.approvalThreshold)
  return { decision: waits ? 'needs_approval' : 'approve', reasons: [], flags }
}

/** The quote answers the request, keeps its own promises, and is fresh. */
function quoteReasons(trade: Trade, trading: TradingPolicy, now: Date): RejectCode[] {
  const { quote, request } = trade
  const reasons: RejectCode[] = []
  const answers =
    quote.tokenIn === request.tokenIn &&
    quote.tokenOut === request.tokenOut &&
    quote.amountIn === request.amountIn
  const minOut = parseAmount(quote.minAmountOut)
  const expected = parseAmount(quote.expectedOut)
  if (!answers || minOut === 0n || minOut > expected) {
    reasons.push('SIM_UNEXPECTED_EFFECT')
  }
  // The slippage the minimum really allows, not the one the venue reports.
  const slippage = Math.min(trading.maxSlippageBps, request.maxSlippageBps ?? Infinity)
  if (quote.slippageBps > slippage || minOut * BPS < expected * (BPS - BigInt(slippage))) {
    reasons.push('SLIPPAGE_TOO_HIGH')
  }
  if (quote.priceImpactBps > trading.maxPriceImpactBps) {
    reasons.push('PRICE_IMPACT_TOO_HIGH')
  }
  const age = now.getTime() - Date.parse(quote.quotedAt)
  if (!(age <= QUOTE_MAX_AGE_MS && age >= -QUOTE_SKEW_MS)) {
    reasons.push('QUOTE_STALE')
  }
  return reasons
}

/** The venue may know the mint's authority; only guard-core knows what has been bought before. */
function buyFlags(quote: SwapQuote, book: Book): TradingFlag[] {
  const flags = quote.flags.filter((flag) => flag === 'MINT_AUTHORITY')
  return book.boughtBefore ? flags : ['NEW_TOKEN', ...flags]
}
