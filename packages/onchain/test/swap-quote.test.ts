import { describe, expect, it } from 'vitest'
import { SwapUnavailable, type JupiterQuote } from '../src/svm/swap/jupiter.js'
import { bps, checkQuote } from '../src/svm/swap/quote.js'

const request = { inputMint: 'USDC', outputMint: 'BONK', amount: 10_000_000n, slippageBps: 50 }
const quote: JupiterQuote = {
  inputMint: 'USDC',
  inAmount: '10000000',
  outputMint: 'BONK',
  outAmount: '1000000',
  otherAmountThreshold: '995000',
  swapMode: 'ExactIn',
  slippageBps: 50,
  priceImpactPct: '0.0012',
}

describe("Jupiter's quote, held to the request", () => {
  it('takes the expected output, the minimum and the price impact in basis points', () => {
    expect(checkQuote(quote, request)).toEqual({
      expectedOut: 1_000_000n,
      minAmountOut: 995_000n,
      priceImpactBps: 12,
    })
  })

  it.each([
    ['another input', { inputMint: 'SOL' }],
    ['another output', { outputMint: 'WIF' }],
    ['another amount', { inAmount: '9999999' }],
    ['another slippage', { slippageBps: 100 }],
    ['a minimum looser than the slippage allows', { otherAmountThreshold: '994999' }],
    ['a minimum above the expected output', { otherAmountThreshold: '1000001' }],
    ['nothing out', { outAmount: '0', otherAmountThreshold: '0' }],
  ])('refuses a quote with %s', (_case, change) => {
    expect(() => checkQuote({ ...quote, ...change }, request)).toThrow(SwapUnavailable)
  })

  it.each([
    ['0', 0],
    ['0.0012', 12],
    ['0.00121', 13],
    ['0.5', 5000],
    ['1', 10000],
    ['-0.003', 0],
  ])('reads a price impact of %s as %i bps, rounding up', (fraction, expected) => {
    expect(bps(fraction)).toBe(expected)
  })
})
