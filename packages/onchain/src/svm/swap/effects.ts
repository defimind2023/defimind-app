import type { BalanceChange, RejectCode } from '@defimind/shared'

/** One token account of the hot wallet, as the chain holds it. */
export interface Holding {
  mint: string
  owner: string
  amount: bigint
  delegate: string | null
  closeAuthority: string | null
  frozen: boolean
}

export interface Deal {
  hotWallet: string
  tokenIn: string
  amountIn: bigint
  tokenOut: string
  minAmountOut: bigint
  /** Fees and the rent of accounts the swap may create: all the SOL it may cost. */
  maxLamports: bigint
}

export interface Effects {
  reasons: RejectCode[]
  /** The hot wallet's net change per mint, in atomic units. */
  changes: BalanceChange[]
}

/**
 * The test run's verdict, from the hot wallet's token accounts before and after it (SPEC v0.16, step
 * 4). tokenIn falls by at most amountIn, tokenOut rises by at least minAmountOut, no other account
 * loses anything, SOL pays fees and rent only, and every account stays the hot wallet's alone: no
 * delegate, no close authority, not frozen, not closed. Anything else is SIM_UNEXPECTED_EFFECT.
 */
export function swapEffects(
  before: Map<string, Holding | null>,
  after: Map<string, Holding | null>,
  lamports: { before: bigint; after: bigint },
  deal: Deal,
): Effects {
  const net = new Map<string, bigint>()
  let ok = lamports.before - lamports.after <= deal.maxLamports
  for (const address of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(address) ?? null
    const now = after.get(address) ?? null
    if (!now) {
      // Never held, or gone: a closed account of the hot wallet is an effect no swap needs.
      ok &&= was === null
      continue
    }
    if (was && was.mint !== now.mint) ok = false
    ok &&= isPlain(now, deal.hotWallet)
    const delta = now.amount - (was?.amount ?? 0n)
    if (delta < 0n && now.mint !== deal.tokenIn) ok = false
    net.set(now.mint, (net.get(now.mint) ?? 0n) + delta)
  }
  const spent = -(net.get(deal.tokenIn) ?? 0n)
  const bought = net.get(deal.tokenOut) ?? 0n
  ok &&= spent <= deal.amountIn && bought >= deal.minAmountOut
  return {
    reasons: ok ? [] : ['SIM_UNEXPECTED_EFFECT'],
    changes: [...net]
      .filter(([, delta]) => delta !== 0n)
      .map(([token, delta]) => ({ token, delta: delta.toString() })),
  }
}

const isPlain = (holding: Holding, hotWallet: string) =>
  holding.owner === hotWallet &&
  holding.delegate === null &&
  holding.closeAuthority === null &&
  !holding.frozen
