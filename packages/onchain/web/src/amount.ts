import { USDC_DECIMALS } from '@defimind/shared'
import { formatUnits } from '../../src/svm/transfer.js'

/** "12.5" in whole dollars to base units; undefined for anything else, zero included. */
export function parseAmount(text: string): bigint | undefined {
  const match = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(text.trim())
  if (!match) return undefined
  const [, whole, fraction = ''] = match
  const amount = BigInt(whole! + fraction.padEnd(USDC_DECIMALS, '0'))
  return amount > 0n ? amount : undefined
}

/** Why a typed amount cannot be used, or undefined when it can. */
export function amountProblem(text: string, max: bigint | undefined, symbol: string) {
  const amount = parseAmount(text)
  if (amount === undefined) {
    return `Type an amount in ${symbol}, such as 25 or 12.5, with at most 6 decimals.`
  }
  if (max !== undefined && amount > max) {
    return `The most this page allows is ${formatUnits(max, USDC_DECIMALS)} ${symbol}.`
  }
  return undefined
}
