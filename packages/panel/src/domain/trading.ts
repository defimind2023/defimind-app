import { getAddress } from '@defimind/shared'
import { amountText, dollarsInput, parseDollars } from './money.js'

/** CR-021's Policy.trading, as guard-core returns it. Absent means no trading at all. */
export interface Trading {
  enabled: boolean
  venues: string[]
  tokens: string[]
  allowAnyToken: boolean
  maxTradeUsd: string
  dailyTradeMax: string
  maxPositionUsd: string
  maxSlippageBps: number
  maxPriceImpactBps: number
}

/** SPEC v0.16's defaults: a policy without trading trades nothing. */
export const NO_TRADING: Trading = {
  enabled: false,
  venues: [],
  tokens: [],
  allowAnyToken: false,
  maxTradeUsd: '0',
  dailyTradeMax: '0',
  maxPositionUsd: '0',
  maxSlippageBps: 100,
  maxPriceImpactBps: 300,
}

const AMOUNTS = ['maxTradeUsd', 'dailyTradeMax', 'maxPositionUsd'] as const
const BPS = ['maxSlippageBps', 'maxPriceImpactBps'] as const

/**
 * Whether a trading change loosens the policy, as CR-021 counts it: turning trading on, a venue or
 * token added, any token allowed, or a limit, slippage or price impact raised. guard-core asks for
 * the passkey then; the panel asks first.
 */
export function tradingLoosens(before: Trading | undefined, after: Trading | undefined): boolean {
  const was = before ?? NO_TRADING
  const now = after ?? NO_TRADING
  return (
    (now.enabled && !was.enabled) ||
    (now.allowAnyToken && !was.allowAnyToken) ||
    now.venues.some((venue) => !was.venues.includes(venue)) ||
    now.tokens.some((token) => !was.tokens.includes(token)) ||
    AMOUNTS.some((key) => BigInt(now[key]) > BigInt(was[key])) ||
    BPS.some((key) => now[key] > was[key])
  )
}

/** Basis points as a percent, always two decimals: 150 is "1.50%". */
export function percent(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`
}

/** "1.5", "1,5" or "1.50%" to basis points, from 0 to 100%; undefined for anything else. */
export function parsePercent(text: string): number | undefined {
  const match = /^(\d{1,3})(?:[.,](\d{1,2}))?%?$/.exec(text.trim())
  if (match === null) {
    return undefined
  }
  const bps = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
  return bps <= 10_000 ? bps : undefined
}

/** A swap that spends the chain's dollar is a buy; any other is a sell back to it (CR-021). */
export const isBuy = (intent: { chain: string; token: string }) =>
  getAddress(intent.chain, 'usd') === intent.token

/** Base units to a decimal string, in bigint: thousands separated, trailing zeros dropped. */
export function tokenAmount(amount: string, decimals: number): string {
  const value = BigInt(amount)
  const unit = 10n ** BigInt(decimals)
  const whole = (value / unit).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const fraction = (value % unit).toString().padStart(decimals, '0').replace(/0+$/, '')
  return fraction === '' ? whole : `${whole}.${fraction}`
}

export interface Held {
  amount: string
  token: string
  decimals?: number | undefined
  symbol?: string | undefined
}

/**
 * A token amount with the whole mint beside it, always: the symbol is the venue's or the token's own
 * claim, and any token can call itself anything. Without decimals, the base units as they are.
 */
export function units({ amount, token, decimals, symbol }: Held): string {
  if (decimals === undefined) {
    return `${amount} base units of ${token}`
  }
  return `${tokenAmount(amount, decimals)} ${symbol ?? 'tokens'} (mint ${token})`
}

type Swapped = {
  chain: string
  token: string
  amount: string
  swap?: { decimalsIn: number; symbolIn?: string | undefined } | undefined
}

/** What a swap spends: the chain's dollar for a buy, the token held for a sell. */
export const spent = (intent: Swapped): Held => ({
  amount: intent.amount,
  token: intent.token,
  decimals: intent.swap?.decimalsIn,
  symbol: intent.swap?.symbolIn,
})

/** The headline of a swap: what it spends, in dollars for a buy. */
export function swapTitle(intent: Swapped): string {
  return isBuy(intent) ? `Buy with ${amountText(intent)}` : `Sell ${units(spent(intent))}`
}

/** What each approval flag means, said plainly: why this swap waits for the owner. */
export const FLAGS: Record<string, string> = {
  RECIPIENT_CHANGED: 'This API asks to pay a different recipient, chain or token than last time.',
  PRICE_JUMP: 'This API asks for much more than its last payment.',
  NEW_TOKEN: 'First buy of this token by any of your agents.',
  MINT_AUTHORITY: 'The token can still be minted: its supply is not fixed.',
}

/** The trading settings form, as the owner typed it: dollars and percents, one token per line. */
export interface TradingForm {
  enabled: boolean
  allowAnyToken: boolean
  tokens: string
  maxTradeUsd: string
  dailyTradeMax: string
  maxPositionUsd: string
  maxSlippage: string
  maxPriceImpact: string
}

export function toTradingForm(trading: Trading | undefined): TradingForm {
  const t = trading ?? NO_TRADING
  return {
    enabled: t.enabled,
    allowAnyToken: t.allowAnyToken,
    tokens: t.tokens.join('\n'),
    maxTradeUsd: dollarsInput(t.maxTradeUsd),
    dailyTradeMax: dollarsInput(t.dailyTradeMax),
    maxPositionUsd: dollarsInput(t.maxPositionUsd),
    maxSlippage: (t.maxSlippageBps / 100).toFixed(2),
    maxPriceImpact: (t.maxPriceImpactBps / 100).toFixed(2),
  }
}

const LABELS = {
  maxTradeUsd: 'Each buy',
  dailyTradeMax: 'All buys in a day',
  maxPositionUsd: 'Held in one token',
} as const

/**
 * The trading policy after the form, or the first thing wrong with it, said to the owner. The only
 * venue is Jupiter (CR-021, phase 1): turning trading on allows it, turning it off keeps the list.
 */
export function fromTradingForm(before: Trading | undefined, form: TradingForm): Trading | string {
  const amounts = {} as Record<(typeof AMOUNTS)[number], string>
  for (const key of AMOUNTS) {
    const amount = parseDollars(form[key])
    if (amount === undefined) {
      return `${LABELS[key]}: write an amount in dollars, like 5.00.`
    }
    amounts[key] = amount
  }
  const slippage = parsePercent(form.maxSlippage)
  const impact = parsePercent(form.maxPriceImpact)
  if (slippage === undefined || impact === undefined) {
    return 'Slippage and price impact: write a percent, like 1.00.'
  }
  const tokens = [...new Set(form.tokens.split(/[\s,]+/).filter(Boolean))]
  const long = tokens.find((token) => token.length > 128)
  if (long !== undefined) {
    return `${long.slice(0, 20)}… is too long for a token address.`
  }
  const venues = before?.venues ?? []
  return {
    enabled: form.enabled,
    venues: form.enabled && !venues.includes('jupiter') ? [...venues, 'jupiter'] : venues,
    tokens,
    allowAnyToken: form.allowAnyToken,
    ...amounts,
    maxSlippageBps: slippage,
    maxPriceImpactBps: impact,
  }
}
