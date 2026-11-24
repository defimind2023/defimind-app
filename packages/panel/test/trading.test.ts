import { CHAINS, getAddress } from '@defimind/shared'
import { describe, expect, it } from 'vitest'
import { loosens, type Rules } from '../src/domain/policy.js'
import {
  fromTradingForm,
  isBuy,
  NO_TRADING,
  parsePercent,
  percent,
  swapTitle,
  tokenAmount,
  toTradingForm,
  type Trading,
  tradingLoosens,
  units,
} from '../src/domain/trading.js'

const chain = CHAINS.solanaDevnet
const usd = getAddress(chain, 'usd')!
const mint = 'So11111111111111111111111111111111111111112'

const on: Trading = {
  ...NO_TRADING,
  enabled: true,
  venues: ['jupiter'],
  tokens: [mint],
  maxTradeUsd: '25000000',
  dailyTradeMax: '100000000',
  maxPositionUsd: '50000000',
}

describe('tradingLoosens', () => {
  it('counts turning trading on, from nothing too', () => {
    expect(tradingLoosens(undefined, on)).toBe(true)
    expect(tradingLoosens({ ...on, enabled: false }, on)).toBe(true)
  })

  it('counts a venue or token added, and any token allowed', () => {
    expect(tradingLoosens(on, { ...on, venues: ['jupiter', 'other'] })).toBe(true)
    expect(tradingLoosens(on, { ...on, tokens: [mint, 'x'] })).toBe(true)
    expect(tradingLoosens(on, { ...on, allowAnyToken: true })).toBe(true)
  })

  it('counts every raised limit', () => {
    expect(tradingLoosens(on, { ...on, maxTradeUsd: '25000001' })).toBe(true)
    expect(tradingLoosens(on, { ...on, dailyTradeMax: '100000001' })).toBe(true)
    expect(tradingLoosens(on, { ...on, maxPositionUsd: '50000001' })).toBe(true)
    expect(tradingLoosens(on, { ...on, maxSlippageBps: 101 })).toBe(true)
    expect(tradingLoosens(on, { ...on, maxPriceImpactBps: 301 })).toBe(true)
  })

  it('lets anything tighter or the same through without a passkey', () => {
    expect(tradingLoosens(on, on)).toBe(false)
    expect(tradingLoosens(on, undefined)).toBe(false)
    expect(tradingLoosens(on, { ...on, enabled: false, tokens: [], maxSlippageBps: 50 })).toBe(
      false,
    )
  })

  it('is part of loosens for the whole policy', () => {
    const policy: Rules = {
      chains: [chain],
      tokens: [usd],
      perTxMax: '1',
      dailyMax: '1',
      approvalThreshold: '1',
      allowedRecipients: [],
      allowedDomains: [],
    }
    expect(loosens(policy, { ...policy, trading: on })).toBe(true)
    expect(loosens({ ...policy, trading: on }, policy)).toBe(false)
  })
})

describe('percent', () => {
  it('shows basis points with two decimals', () => {
    expect(percent(150)).toBe('1.50%')
    expect(percent(0)).toBe('0.00%')
    expect(percent(10_000)).toBe('100.00%')
  })

  it('parses a percent to basis points, up to 100', () => {
    expect(parsePercent('1.5')).toBe(150)
    expect(parsePercent('1,5')).toBe(150)
    expect(parsePercent('0,25%')).toBe(25)
    expect(parsePercent(' 3% ')).toBe(300)
    expect(parsePercent('0.05')).toBe(5)
    expect(parsePercent('100')).toBe(10_000)
    for (const bad of ['', '100.01', '-1', '1.234', '1,234', '1.2,3', 'one', '1e2']) {
      expect(parsePercent(bad)).toBeUndefined()
    }
  })
})

describe('swaps', () => {
  it('tells a buy from a sell by the chain dollar', () => {
    expect(isBuy({ chain, token: usd })).toBe(true)
    expect(isBuy({ chain, token: mint })).toBe(false)
  })

  it('titles a buy in dollars and a sell in the token, with the whole mint', () => {
    expect(swapTitle({ chain, token: usd, amount: '25000000' })).toBe('Buy with $25.00 USDC')
    const sell = { chain, token: mint, amount: '1500000000', swap: { decimalsIn: 9 } }
    expect(swapTitle(sell)).toBe(`Sell 1.5 tokens (mint ${mint})`)
    expect(swapTitle({ ...sell, swap: { decimalsIn: 9, symbolIn: 'SOL' } })).toBe(
      `Sell 1.5 SOL (mint ${mint})`,
    )
  })

  it('never names a token by its symbol alone', () => {
    expect(units({ amount: '7', token: mint })).toBe(`7 base units of ${mint}`)
    expect(units({ amount: '7', token: mint, decimals: 0, symbol: 'USDC' })).toBe(
      `7 USDC (mint ${mint})`,
    )
  })

  it('places the decimal point with bigint', () => {
    expect(tokenAmount('1843920113', 6)).toBe('1,843.920113')
    expect(tokenAmount('912000000000', 5)).toBe('9,120,000')
    expect(tokenAmount('5', 9)).toBe('0.000000005')
    expect(tokenAmount('123456789012345678901234567890', 18)).toBe(
      '123,456,789,012.34567890123456789',
    )
  })
})

describe('trading form', () => {
  it('shows dollars and percents, and reads them back unchanged', () => {
    const form = toTradingForm(on)
    expect(form).toMatchObject({ maxTradeUsd: '25.00', maxSlippage: '1.00', tokens: mint })
    expect(fromTradingForm(on, form)).toEqual(on)
  })

  it('starts from no trading', () => {
    expect(toTradingForm(undefined)).toMatchObject({ enabled: false, maxPriceImpact: '3.00' })
  })

  it('allows Jupiter once trading is on, and keeps the venues when off', () => {
    const form = { ...toTradingForm(undefined), enabled: true }
    expect(fromTradingForm(undefined, form)).toMatchObject({ venues: ['jupiter'] })
    expect(fromTradingForm(on, { ...form, enabled: false })).toMatchObject({ venues: ['jupiter'] })
  })

  it('takes one token per line, commas too, without repeats', () => {
    const form = { ...toTradingForm(on), tokens: `${mint}\n a, b ,a` }
    expect(fromTradingForm(on, form)).toMatchObject({ tokens: [mint, 'a', 'b'] })
  })

  it('says what is wrong instead', () => {
    const form = toTradingForm(on)
    expect(fromTradingForm(on, { ...form, dailyTradeMax: 'lots' })).toBe(
      'All buys in a day: write an amount in dollars, like 5.00.',
    )
    expect(fromTradingForm(on, { ...form, maxPriceImpact: '200' })).toMatch(/percent/)
    expect(fromTradingForm(on, { ...form, tokens: 'x'.repeat(129) })).toMatch(/too long/)
  })
})
