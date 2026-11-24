import type { Policy, SwapQuote, TradingPolicy } from '@defimind/shared'
import { describe, expect, it } from 'vitest'
import { evaluateTrade, type Book, type Trade } from '../src/domain/trading.js'
import { basePolicy } from './harness.js'

const NOW = new Date('2026-11-24T12:00:00Z')
const USDC = 'USDC111111111111111111111111111111111111111'
const BONK = 'Bonk111111111111111111111111111111111111111'

const trading: TradingPolicy = {
  enabled: true,
  venues: ['jupiter'],
  tokens: [BONK],
  allowAnyToken: false,
  maxTradeUsd: '10000000',
  dailyTradeMax: '25000000',
  maxPositionUsd: '20000000',
  maxSlippageBps: 100,
  maxPriceImpactBps: 300,
}
const policy = (over: Partial<TradingPolicy> = {}, base: Partial<Policy> = {}): Policy => ({
  agentId: 'agent-1',
  ...basePolicy,
  ...base,
  trading: { ...trading, ...over },
})

const quote = (over: Partial<SwapQuote> = {}): SwapQuote => ({
  venue: 'jupiter',
  tokenIn: USDC,
  amountIn: '1000000',
  tokenOut: BONK,
  expectedOut: '1000000000',
  minAmountOut: '995000000',
  slippageBps: 50,
  priceImpactBps: 20,
  exitImpactBps: 30,
  risks: [],
  flags: [],
  quotedAt: new Date(NOW.getTime() - 2_000).toISOString(),
  decimalsIn: 6,
  decimalsOut: 5,
  ...over,
})

const buy = (q: Partial<SwapQuote> = {}, request: Partial<Trade['request']> = {}): Trade => {
  const answer = quote(q)
  return {
    side: 'buy',
    token: BONK,
    request: { tokenIn: USDC, tokenOut: BONK, amountIn: '1000000', ...request },
    quote: answer,
  }
}

const sell = (q: Partial<SwapQuote> = {}): Trade => ({
  side: 'sell',
  token: BONK,
  request: { tokenIn: BONK, tokenOut: USDC, amountIn: '1000000000' },
  quote: quote({
    tokenIn: BONK,
    tokenOut: USDC,
    amountIn: '1000000000',
    expectedOut: '1000000',
    minAmountOut: '995000',
    exitImpactBps: null,
    ...q,
  }),
})

const book: Book = { tradedToday: 0n, positionCost: 0n, boughtBefore: true }
const reasons = (trade: Trade, p = policy(), b = book) => evaluateTrade(trade, p, b, NOW).reasons

describe('evaluateTrade (CR-021)', () => {
  it('approves a small buy of a listed token on a fresh, honest quote', () => {
    expect(evaluateTrade(buy(), policy(), book, NOW)).toEqual({
      decision: 'approve',
      reasons: [],
      flags: [],
    })
  })

  it('denies everything without a trading policy, or with trading off', () => {
    const none: Policy = { agentId: 'agent-1', ...basePolicy }
    expect(reasons(buy(), none)).toEqual(['TRADING_DISABLED'])
    expect(reasons(sell(), policy({ enabled: false }))).toEqual(['TRADING_DISABLED'])
  })

  it('refuses a paused agent, a venue not allowed and a token not listed', () => {
    expect(reasons(buy(), policy({}, { paused: true }))).toEqual(['PAUSED'])
    expect(reasons(buy({ venue: 'evil-dex' }))).toEqual(['VENUE_NOT_ALLOWED'])
    expect(reasons(buy(), policy({ tokens: [] }))).toEqual(['TOKEN_NOT_TRADABLE'])
    expect(reasons(buy(), policy({ tokens: [], allowAnyToken: true }))).toEqual([])
  })

  it('refuses every swap, sells too, when the policy requires a mandate', () => {
    expect(reasons(buy(), policy({}, { requireMandate: true }))).toEqual(['MANDATE_REQUIRED'])
    expect(reasons(sell(), policy({}, { requireMandate: true }))).toEqual(['MANDATE_REQUIRED'])
  })

  it('lets an agent sell a token that is no longer listed', () => {
    expect(evaluateTrade(sell(), policy({ tokens: [] }), book, NOW).decision).toBe('approve')
  })

  it.each([
    ['one buy over maxTradeUsd', '10000001', book, 'TRADE_EXCEEDED'],
    [
      'the day over dailyTradeMax',
      '1000000',
      { ...book, tradedToday: 24_500_000n },
      'TRADE_DAILY_EXCEEDED',
    ],
    [
      'the position over maxPositionUsd',
      '1000000',
      { ...book, positionCost: 19_500_000n },
      'POSITION_EXCEEDED',
    ],
  ] as const)('refuses %s', (_case, amountIn, b, code) => {
    const trade = buy({ amountIn }, { amountIn })
    expect(reasons(trade, policy(), b)).toContain(code)
  })

  it('counts only buys against the trade limits', () => {
    const full = { ...book, tradedToday: 25_000_000n, positionCost: 20_000_000n }
    expect(reasons(sell(), policy(), full)).toEqual([])
  })

  it('refuses slippage over the limit, whether the venue reports it or its minimum allows it', () => {
    expect(reasons(buy({ slippageBps: 150 }))).toContain('SLIPPAGE_TOO_HIGH')
    // Reported as 50 bps, but a minimum of 0.98x the expected output allows 200.
    expect(reasons(buy({ minAmountOut: '980000000' }))).toContain('SLIPPAGE_TOO_HIGH')
    expect(reasons(buy({}, { maxSlippageBps: 30 }))).toContain('SLIPPAGE_TOO_HIGH')
  })

  it('refuses price impact over the limit', () => {
    expect(reasons(buy({ priceImpactBps: 301 }))).toEqual(['PRICE_IMPACT_TOO_HIGH'])
  })

  it('refuses a stale quote, and one stamped in the future', () => {
    const old = new Date(NOW.getTime() - 30_001).toISOString()
    const ahead = new Date(NOW.getTime() + 10_000).toISOString()
    expect(reasons(buy({ quotedAt: old }))).toEqual(['QUOTE_STALE'])
    expect(reasons(buy({ quotedAt: ahead }))).toEqual(['QUOTE_STALE'])
    expect(reasons(buy({ quotedAt: 'not a date' }))).toEqual(['QUOTE_STALE'])
  })

  it.each([
    ['another token out', { tokenOut: USDC }],
    ['another amount in', { amountIn: '2000000' }],
    ['a minimum above the expected output', { minAmountOut: '1000000001' }],
    ['a minimum of nothing', { minAmountOut: '0' }],
  ])('refuses a quote with %s', (_case, q) => {
    expect(reasons(buy(q))).toContain('SIM_UNEXPECTED_EFFECT')
  })

  it('refuses a buy on the token risks the venue found', () => {
    expect(reasons(buy({ risks: ['TOKEN_FREEZABLE', 'TOKEN_EXTENSION_RISK'] }))).toEqual([
      'TOKEN_FREEZABLE',
      'TOKEN_EXTENSION_RISK',
    ])
  })

  it('refuses a buy with no exit route, or one past the impact limit', () => {
    expect(reasons(buy({ exitImpactBps: null }))).toEqual(['NO_EXIT_ROUTE'])
    expect(reasons(buy({ exitImpactBps: 301 }))).toEqual(['NO_EXIT_ROUTE'])
    expect(reasons(buy({ risks: ['NO_EXIT_ROUTE'], exitImpactBps: null }))).toEqual([
      'NO_EXIT_ROUTE',
    ])
  })

  it('sends the first buy of a token and a mintable token to the owner, below the threshold', () => {
    const first = evaluateTrade(buy(), policy(), { ...book, boughtBefore: false }, NOW)
    expect(first).toEqual({ decision: 'needs_approval', reasons: [], flags: ['NEW_TOKEN'] })
    const minted = evaluateTrade(buy({ flags: ['MINT_AUTHORITY'] }), policy(), book, NOW)
    expect(minted).toEqual({
      decision: 'needs_approval',
      reasons: [],
      flags: ['MINT_AUTHORITY'],
    })
  })

  it('does not take NEW_TOKEN from the venue: only guard-core knows what was bought before', () => {
    expect(evaluateTrade(buy({ flags: ['NEW_TOKEN'] }), policy(), book, NOW).flags).toEqual([])
  })

  it('sends a buy at the approval threshold to the owner, and never a sell', () => {
    const big = buy({ amountIn: '2000000' }, { amountIn: '2000000' })
    expect(evaluateTrade(big, policy(), book, NOW).decision).toBe('needs_approval')
    const newSell = evaluateTrade(sell(), policy(), { ...book, boughtBefore: false }, NOW)
    expect(newSell).toEqual({ decision: 'approve', reasons: [], flags: [] })
  })

  it('names every rule a trade breaks', () => {
    const bad = buy(
      { venue: 'x', priceImpactBps: 900, exitImpactBps: null },
      { amountIn: '1000000' },
    )
    expect(reasons(bad, policy({ tokens: [] }))).toEqual([
      'VENUE_NOT_ALLOWED',
      'TOKEN_NOT_TRADABLE',
      'PRICE_IMPACT_TOO_HIGH',
      'NO_EXIT_ROUTE',
    ])
  })
})
