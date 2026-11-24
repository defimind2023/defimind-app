import type { PayIntent } from '@defimind/shared'
import { getAddress, USDC_DECIMALS, usdSymbol } from '@defimind/shared'

const ATOMIC = /^(0|[1-9]\d*)$/
const UNIT = 10n ** BigInt(USDC_DECIMALS)
// One dot or one comma before the cents: an iPhone in pt-BR types "2,00". No thousands separators:
// "1.234,56" is refused, and so is a comma before exactly three digits, since "1,000" reads as a
// thousand in English and as one in Portuguese.
const DOLLARS = /^\$?(\d{1,12})(?:\.(\d{1,6})|,(?!\d{3}$)(\d{1,6}))?$/

/** Dollar-token atomic units to dollars, in bigint: always cents, more digits only when not zero. */
export function formatUsd(amount: string): string {
  if (!ATOMIC.test(amount)) {
    throw new Error(`not an atomic amount: ${amount}`)
  }
  const value = BigInt(amount)
  const whole = (value / UNIT).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const fraction = (value % UNIT).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '')
  return `$${whole}.${fraction.padEnd(2, '0')}`
}

/** "12.5", "12,50" or "$12.50" to atomic units; undefined for anything else, a negative included. */
export function parseDollars(text: string): string | undefined {
  const match = DOLLARS.exec(text.trim())
  if (match === null) {
    return undefined
  }
  const [, whole = '0', dot, comma] = match
  const fraction = dot ?? comma ?? ''
  return (BigInt(whole) * UNIT + BigInt(fraction.padEnd(USDC_DECIMALS, '0'))).toString()
}

/** Atomic units as the plain number a dollar input shows: no $ and no thousands separators. */
export function dollarsInput(amount: string): string {
  return formatUsd(amount).slice(1).split(',').join('')
}

/**
 * Dollars only for the chain's verified dollar. Any other token is shown in base units with its
 * address: a token with 6 decimals, or one named USDC, could otherwise pass for dollars.
 */
export function amountText({
  chain,
  token,
  amount,
}: Pick<PayIntent, 'chain' | 'token' | 'amount'>) {
  const symbol = usdSymbol(chain)
  if (symbol !== undefined && getAddress(chain, 'usd') === token && ATOMIC.test(amount)) {
    return `${formatUsd(amount)} ${symbol}`
  }
  return `${amount} base units of ${token} (not this chain's dollar)`
}

/**
 * How full a day's meter is, in whole percent from 0 to 100, in bigint. Any spend shows at least 1,
 * so a first payment is never drawn as nothing; no cap reads as empty.
 */
export function meterPercent(spent: string, cap: string): number {
  const used = BigInt(spent)
  const limit = BigInt(cap)
  if (limit <= 0n || used <= 0n) {
    return 0
  }
  const percent = (used * 100n) / limit
  return Number(percent > 100n ? 100n : percent === 0n ? 1n : percent)
}
