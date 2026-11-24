import type { BalanceChange } from '@defimind/shared'
import type { ConfirmedTransactionMeta, TokenBalance } from '@solana/web3.js'

/** The owner's token balance changes in a confirmed transaction, per mint, from its own record. */
export function landedChanges(meta: ConfirmedTransactionMeta, owner: string): BalanceChange[] {
  if (meta.err) throw new Error(`tx_failed: ${JSON.stringify(meta.err)}`)
  const totals = new Map<string, bigint>()
  const add = (balances: TokenBalance[] | null | undefined, sign: bigint) => {
    for (const b of balances ?? []) {
      if (b.owner !== owner) continue
      totals.set(b.mint, (totals.get(b.mint) ?? 0n) + sign * BigInt(b.uiTokenAmount.amount))
    }
  }
  add(meta.preTokenBalances, -1n)
  add(meta.postTokenBalances, 1n)
  return [...totals]
    .filter(([, delta]) => delta !== 0n)
    .map(([token, delta]) => ({ token, delta: delta.toString() }))
}
