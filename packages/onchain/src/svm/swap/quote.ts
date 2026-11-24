import { SwapUnavailable, type JupiterQuote, type QuoteRequest } from './jupiter.js'

export interface Checked {
  expectedOut: bigint
  /** What the swap must return at least: Jupiter's threshold, never below our own reckoning. */
  minAmountOut: bigint
  priceImpactBps: number
}

const BPS = 10_000n

/**
 * A Jupiter quote held to the request it answers. A quote for another pair, amount or slippage, or
 * whose minimum is looser than the slippage allows, is not a quote for this swap.
 */
export function checkQuote(quote: JupiterQuote, request: QuoteRequest): Checked {
  const expectedOut = BigInt(quote.outAmount)
  const threshold = BigInt(quote.otherAmountThreshold)
  const ours = (expectedOut * (BPS - BigInt(request.slippageBps))) / BPS
  const answers =
    quote.inputMint === request.inputMint &&
    quote.outputMint === request.outputMint &&
    BigInt(quote.inAmount) === request.amount &&
    quote.slippageBps === request.slippageBps &&
    expectedOut > 0n &&
    threshold >= ours &&
    threshold <= expectedOut
  if (!answers) throw new SwapUnavailable('venue_unavailable', 'the quote answers another request')
  return { expectedOut, minAmountOut: threshold, priceImpactBps: bps(quote.priceImpactPct) }
}

/** Jupiter's price impact is a fraction as a decimal string; in basis points, rounded up. */
export function bps(fraction: string): number {
  // A negative impact is a price in the buyer's favour.
  if (fraction.startsWith('-')) return 0
  const [whole = '0', part = ''] = fraction.split('.')
  const scaled = BigInt(whole + part.padEnd(4, '0').slice(0, 4))
  const rest = /[1-9]/.test(part.slice(4)) ? 1n : 0n
  return Number(scaled + rest)
}
