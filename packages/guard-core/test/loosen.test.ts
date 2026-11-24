import type { Policy } from '@defimind/shared'
import { describe, expect, it } from 'vitest'
import { loosened } from '../src/domain/loosen.js'
import type { StoredPolicy } from '../src/domain/policy.js'

const before: StoredPolicy = {
  agentId: 'a',
  chains: ['solana:x'],
  tokens: ['T1'],
  perTxMax: '1000',
  dailyMax: '5000',
  approvalThreshold: '500',
  allowedRecipients: ['R1'],
  allowedDomains: ['api.example.com'],
  paused: true,
  mode: 'shadow',
  priceIncreaseMaxPct: 100,
  maxPaymentsPerMinute: 10,
  requireMandate: true,
}

const change = (patch: Partial<Policy>): string[] => loosened(before, { ...before, ...patch })

describe('loosened', () => {
  it('finds nothing in an unchanged policy', () => {
    expect(change({})).toEqual([])
  })

  it.each(['perTxMax', 'dailyMax', 'approvalThreshold'] as const)(
    'flags %s raised, not lowered or kept',
    (limit) => {
      expect(change({ [limit]: '999999' })).toEqual([limit])
      expect(change({ [limit]: '1' })).toEqual([])
    },
  )

  it.each([
    ['chains', 'eip155:1'],
    ['tokens', 'T2'],
    ['allowedRecipients', 'R2'],
    ['allowedDomains', 'evil.example'],
  ] as const)('flags anything added to %s, not a removal', (list, item) => {
    expect(change({ [list]: [...before[list], item] })).toEqual([list])
    expect(change({ [list]: [] })).toEqual([])
  })

  it('flags a swap that removes one entry and adds another', () => {
    expect(change({ allowedRecipients: ['R2'] })).toEqual(['allowedRecipients'])
  })

  it('flags going live, not going to shadow or leaving mode out', () => {
    expect(change({ mode: 'live' })).toEqual(['mode'])
    expect(loosened({ ...before, mode: 'live' }, { ...before, mode: 'shadow' })).toEqual([])
    const { mode: _, ...noMode } = before
    expect(loosened(before, noMode)).toEqual([])
  })

  it('flags dropping the mandate requirement, not adding it', () => {
    expect(change({ requireMandate: false })).toEqual(['requireMandate'])
    expect(
      loosened({ ...before, requireMandate: false }, { ...before, requireMandate: true }),
    ).toEqual([])
  })

  it('flags unpausing, which would otherwise be a resume without a passkey', () => {
    expect(change({ paused: false })).toEqual(['paused'])
    expect(loosened({ ...before, paused: false }, { ...before, paused: true })).toEqual([])
  })

  it('flags a higher breaker or price-jump limit, not a lower one', () => {
    expect(change({ maxPaymentsPerMinute: 11 })).toEqual(['maxPaymentsPerMinute'])
    expect(change({ priceIncreaseMaxPct: 101 })).toEqual(['priceIncreaseMaxPct'])
    expect(change({ maxPaymentsPerMinute: 1, priceIncreaseMaxPct: 0 })).toEqual([])
  })

  it('lists every loosened field at once', () => {
    expect(change({ perTxMax: '2000', tokens: ['T1', 'T2'], mode: 'live' })).toEqual([
      'perTxMax',
      'tokens',
      'mode',
    ])
  })
})

describe('loosened trading (CR-021)', () => {
  const trading = {
    enabled: true,
    venues: ['jupiter'],
    tokens: ['BONK'],
    allowAnyToken: false,
    maxTradeUsd: '1000',
    dailyTradeMax: '5000',
    maxPositionUsd: '3000',
    maxSlippageBps: 100,
    maxPriceImpactBps: 300,
  }
  const trades = { ...before, trading }
  const tradeChange = (patch: Partial<typeof trading>) =>
    loosened(trades, { ...trades, trading: { ...trading, ...patch } })

  it('flags turning trading on, from nothing or from off', () => {
    expect(loosened(before, trades)).toEqual([
      'trading.enabled',
      'trading.venues',
      'trading.tokens',
      'trading.maxTradeUsd',
      'trading.dailyTradeMax',
      'trading.maxPositionUsd',
      'trading.maxSlippageBps',
      'trading.maxPriceImpactBps',
    ])
    const off = { ...before, trading: { ...trading, enabled: false } }
    expect(loosened(off, trades)).toEqual(['trading.enabled'])
  })

  it('flags each loosening field, and none of the tightening ones', () => {
    expect(tradeChange({ allowAnyToken: true })).toEqual(['trading.allowAnyToken'])
    expect(tradeChange({ venues: ['jupiter', 'other'] })).toEqual(['trading.venues'])
    expect(tradeChange({ tokens: ['WIF'] })).toEqual(['trading.tokens'])
    expect(tradeChange({ dailyTradeMax: '5001' })).toEqual(['trading.dailyTradeMax'])
    expect(tradeChange({ maxPriceImpactBps: 301 })).toEqual(['trading.maxPriceImpactBps'])
    expect(
      tradeChange({ enabled: false, tokens: [], maxTradeUsd: '1', maxSlippageBps: 10 }),
    ).toEqual([])
    expect(loosened(trades, before)).toEqual([])
  })
})
