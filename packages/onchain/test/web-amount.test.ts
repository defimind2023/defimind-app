import { describe, expect, it } from 'vitest'
import { amountProblem, parseAmount } from '../web/src/amount.js'

describe('a typed amount', () => {
  it.each([
    ['25', 25_000_000n],
    ['12.5', 12_500_000n],
    [' 0.000001 ', 1n],
  ])('reads %j in base units', (text, amount) => {
    expect(parseAmount(text)).toBe(amount)
  })

  it.each(['', '0', '0.0', '-1', '1e3', '1.2345678', '1,5', '12.'])('refuses %j', (text) => {
    expect(parseAmount(text)).toBeUndefined()
  })

  it('says why, and holds to the ceiling', () => {
    expect(amountProblem('x', 50_000_000n, 'USDC')).toMatch(/^Type an amount in USDC/)
    expect(amountProblem('50.000001', 50_000_000n, 'USDC')).toBe(
      'The most this page allows is 50 USDC.',
    )
    expect(amountProblem('50', 50_000_000n, 'USDC')).toBeUndefined()
  })
})
