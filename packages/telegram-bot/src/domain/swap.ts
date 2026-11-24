import type { PayIntent, SwapDetails } from '@defimind/shared'
import { getAddress, usdSymbol } from '@defimind/shared'
import { formatUsd } from './money.js'
import { escapeHtml as escape } from './text.js'

/** Base units to a decimal string, in bigint: thousands separated, trailing zeros dropped. */
export function tokenAmount(amount: string, decimals: number): string {
  const value = BigInt(amount)
  const unit = 10n ** BigInt(decimals)
  const whole = (value / unit).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const fraction = (value % unit).toString().padStart(decimals, '0').replace(/0+$/, '')
  return fraction === '' ? whole : `${whole}.${fraction}`
}

/**
 * A token with its whole mint beside it, always: the symbol is the token's own claim, and any token
 * can call itself USDC.
 */
function held(amount: string, token: string, decimals: number, symbol: string | undefined) {
  const name = symbol === undefined ? 'tokens' : escape(symbol)
  return `<b>${tokenAmount(amount, decimals)}</b> ${name} (mint <code>${escape(token)}</code>)`
}

const dollars = (chain: string, amount: string) =>
  `<b>${formatUsd(amount)}</b> ${usdSymbol(chain) ?? ''}`.trimEnd()

const percent = (bps: number) => `${(bps / 100).toFixed(2)}%`

/** A swap that spends the chain's dollar is a buy; any other is a sell back to it (CR-021). */
export const isBuy = (intent: Pick<PayIntent, 'chain' | 'token'>) =>
  getAddress(intent.chain, 'usd') === intent.token

type Swap = PayIntent & { swap: SwapDetails }

export const isSwap = (intent: PayIntent): intent is Swap =>
  intent.kind === 'swap' && intent.swap !== undefined

/** What the swap trades, both sides whole, then the limits its quote keeps to. */
export function swapLines(intent: Swap): string[] {
  const { swap } = intent
  const trade = isBuy(intent)
    ? `Buy with ${dollars(intent.chain, intent.amount)}, at least ` +
      held(swap.minAmountOut, swap.tokenOut, swap.decimalsOut, swap.symbolOut)
    : `Sell ${held(intent.amount, intent.token, swap.decimalsIn, swap.symbolIn)} for at least ` +
      dollars(intent.chain, swap.minAmountOut)
  return [
    trade,
    `Slippage: up to ${percent(swap.slippageBps)} · Price impact: ${percent(swap.priceImpactBps)}`,
    `Venue: ${escape(swap.venue)}`,
  ]
}

/** The dollars a payment or trade moves: a sell's amount is the token's, its proceeds are dollars. */
export function dollarsMoved(intent: PayIntent): bigint {
  return isSwap(intent) && !isBuy(intent) ? BigInt(intent.swap.minAmountOut) : BigInt(intent.amount)
}
