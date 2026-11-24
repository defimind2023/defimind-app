import { parseUsd } from './usd.js'

export interface SwapRequest {
  from: string
  to: string
  amountUsd?: string
  amount?: string
}

export type ResolvedSwap =
  | { ok: true; side: 'buy' | 'sell'; tokenIn: string; tokenOut: string; amountIn: bigint }
  | { ok: false; error: string }

const DOLLAR_ALIASES = /^(usd|usdc|usdg|\$)$/i
const ATOMIC = /^[1-9]\d{0,39}$/

/**
 * Phase 1 of trading always has the chain's dollar on one side: a buy spends it, a sell returns to
 * it. So the side follows from the tokens, and so does which amount field is meaningful.
 */
export function resolveSwap(request: SwapRequest, dollar: string): ResolvedSwap {
  const isDollar = (token: string) => DOLLAR_ALIASES.test(token) || token === dollar
  const fromDollar = isDollar(request.from)
  const toDollar = isDollar(request.to)
  if (fromDollar === toDollar) {
    return {
      ok: false,
      error:
        "One side of a swap must be the chain's dollar and the other a token: a buy spends dollars, a sell returns to them.",
    }
  }
  if ((request.amountUsd === undefined) === (request.amount === undefined)) {
    return { ok: false, error: 'Give exactly one of amountUsd (to buy) or amount (to sell).' }
  }
  if (fromDollar) {
    if (request.amountUsd === undefined) {
      return { ok: false, error: 'A buy takes amountUsd, the dollars to spend.' }
    }
    const usd = parseUsd(request.amountUsd)
    if (!usd.ok) {
      return { ok: false, error: `amountUsd: ${usd.error}` }
    }
    if (usd.atomic === 0n) {
      return { ok: false, error: 'amountUsd: a buy must spend more than zero.' }
    }
    return { ok: true, side: 'buy', tokenIn: dollar, tokenOut: request.to, amountIn: usd.atomic }
  }
  if (request.amount === undefined || !ATOMIC.test(request.amount)) {
    return {
      ok: false,
      error:
        'A sell takes amount: a whole number above zero, in the smallest units of the token sold (get_portfolio shows them).',
    }
  }
  return {
    ok: true,
    side: 'sell',
    tokenIn: request.from,
    tokenOut: dollar,
    amountIn: BigInt(request.amount),
  }
}

/** An exact decimal from atomic units, with trailing zeros dropped: never through a float. */
export function formatUnits(atomic: string, decimals: number): string {
  const digits = atomic.padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals)
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '')
  return fraction === '' ? whole : `${whole}.${fraction}`
}

/**
 * How a token is named to the agent: always by its mint. A venue's or the mint's own symbol is only
 * a label anyone can set, so it is quoted as what the token calls itself, never trusted.
 */
export function tokenLabel(mint: string, symbol?: string): string {
  return symbol === undefined ? mint : `${mint} (calls itself "${symbol}")`
}
