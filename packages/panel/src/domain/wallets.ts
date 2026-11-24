import { isEvm } from '@defimind/shared'
import { tokenAmount } from './trading.js'

/** Native coins: SOL has 9 decimals, ETH (Base, Robinhood Chain) 18. */
const nativeDecimals = (chain: string) => (isEvm(chain) ? 18 : 9)

/** A native gas amount as the owner reads it: "0.0025 SOL". */
export function gasText(chain: string, amount: string, symbol: string): string {
  return `${tokenAmount(amount, nativeDecimals(chain))} ${symbol}`
}

export const lowGas = (gas: { balance: string; minimum: string }) =>
  BigInt(gas.balance) < BigInt(gas.minimum)

/**
 * The signing page to add the agent's limit, only on this origin: /sign knows this deployment's hot
 * wallets and refuses any other, so a link elsewhere could only be someone else's page.
 */
export function sameOrigin(page: string | undefined, origin: string): string | undefined {
  if (page === undefined) {
    return undefined
  }
  try {
    const url = new URL(page, origin)
    return url.origin === origin && url.pathname.startsWith('/sign') ? url.href : undefined
  } catch {
    return undefined
  }
}
