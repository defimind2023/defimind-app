import { describe, expect, it } from 'vitest'
import { swapEffects, type Deal, type Holding } from '../src/svm/swap/effects.js'

const hot = 'HotWa11et'
const usdc = 'USDC'
const bonk = 'BONK'
const deal: Deal = {
  hotWallet: hot,
  tokenIn: usdc,
  amountIn: 10_000_000n,
  tokenOut: bonk,
  minAmountOut: 500n,
  maxLamports: 3_000_000n,
}
const holding = (mint: string, amount: bigint, change: Partial<Holding> = {}): Holding => ({
  mint,
  owner: hot,
  amount,
  delegate: null,
  closeAuthority: null,
  frozen: false,
  ...change,
})
const sol = { before: 1_000_000_000n, after: 999_990_000n }

function run(
  before: Record<string, Holding | null>,
  after: Record<string, Holding | null>,
  lamports = sol,
) {
  return swapEffects(
    new Map(Object.entries(before)),
    new Map(Object.entries(after)),
    lamports,
    deal,
  )
}

describe('the test run of a swap', () => {
  it('passes a buy that spends at most amountIn and gets at least minAmountOut, in a new account', () => {
    const effects = run(
      { a: holding(usdc, 25_000_000n), b: null },
      { a: holding(usdc, 15_000_000n), b: holding(bonk, 512n) },
    )
    expect(effects).toEqual({
      reasons: [],
      changes: [
        { token: usdc, delta: '-10000000' },
        { token: bonk, delta: '512' },
      ],
    })
  })

  it.each([
    ['spends more than amountIn', { a: holding(usdc, 14_999_999n), b: holding(bonk, 512n) }],
    ['gets less than minAmountOut', { a: holding(usdc, 15_000_000n), b: holding(bonk, 499n) }],
    [
      'takes from another account of the hot wallet',
      { a: holding(usdc, 15_000_000n), b: holding(bonk, 512n), c: holding('JUP', 9n) },
    ],
    [
      'leaves a delegate on an account',
      { a: holding(usdc, 15_000_000n, { delegate: 'thief' }), b: holding(bonk, 512n) },
    ],
    [
      'hands an account to another owner',
      { a: holding(usdc, 15_000_000n), b: holding(bonk, 512n, { owner: 'thief' }) },
    ],
    [
      'sets a close authority',
      { a: holding(usdc, 15_000_000n, { closeAuthority: 'thief' }), b: holding(bonk, 512n) },
    ],
    [
      'freezes an account',
      { a: holding(usdc, 15_000_000n), b: holding(bonk, 512n, { frozen: true }) },
    ],
    ['closes an account', { a: null, b: holding(bonk, 512n), c: holding('JUP', 10n) }],
  ])('refuses a run that %s', (_case, after) => {
    const before = { a: holding(usdc, 25_000_000n), b: null, c: holding('JUP', 10n) }
    expect(run(before, after as Record<string, Holding | null>).reasons).toEqual([
      'SIM_UNEXPECTED_EFFECT',
    ])
  })

  it('refuses SOL spent past fees and rent', () => {
    const before = { a: holding(usdc, 25_000_000n), b: null }
    const after = { a: holding(usdc, 15_000_000n), b: holding(bonk, 512n) }
    expect(run(before, after, { before: 10_000_000n, after: 7_000_000n }).reasons).toEqual([])
    expect(run(before, after, { before: 10_000_000n, after: 6_999_999n }).reasons).toEqual([
      'SIM_UNEXPECTED_EFFECT',
    ])
  })

  it('refuses an account whose mint changed', () => {
    const effects = run({ a: holding(usdc, 25_000_000n) }, { a: holding(bonk, 512n) })
    expect(effects.reasons).toEqual(['SIM_UNEXPECTED_EFFECT'])
  })
})
