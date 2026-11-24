import { formatUsd } from './money.js'
import { FLAGS, percent } from './trading.js'

/**
 * A 5×5 pattern and a hue drawn from the mint itself: two tokens with the same symbol look different,
 * and no image is fetched (the CSP allows none). Mirrored, as identicons are, so it reads as a shape.
 */
export function identicon(mint: string): { hue: number; cells: boolean[] } {
  let hash = 2166136261
  for (const char of mint) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0
  }
  const cells = Array.from({ length: 25 }, (_, i) => {
    const column = i % 5
    const bit = Math.floor(i / 5) * 3 + (column > 2 ? 4 - column : column)
    return ((hash >>> bit) & 1) === 1
  })
  return { hue: hash % 360, cells }
}

const REFUSALS: Record<string, string> = {
  TOKEN_FREEZABLE: 'its issuer can freeze holders',
  TOKEN_EXTENSION_RISK: 'it uses a risky Token-2022 extension',
  NO_EXIT_ROUTE: 'there is no route to sell it back',
}

export interface Risk {
  freezeAuthority: boolean
  mintAuthority: boolean
  extensions: string[]
  risks: string[]
  flags: string[]
  exit: { amountUsd: string; priceImpactBps: number } | null
  venue: {
    verified: boolean
    holders?: number | undefined
    liquidityUsd?: string | undefined
    organicScore?: number | undefined
    createdAt?: string | undefined
  }
}

/** What the chain says, read by guard-core. Facts only: nothing here calls a token safe. */
export function onchainFacts(risk: Risk): string[] {
  return [
    risk.freezeAuthority
      ? "Its issuer can freeze any holder's tokens."
      : 'No one can freeze holders of this token.',
    risk.mintAuthority
      ? 'Its issuer can still mint more: the supply is not fixed.'
      : 'No one can mint more: the supply is fixed.',
    risk.extensions.length === 0
      ? 'No Token-2022 extensions.'
      : `Token-2022 extensions: ${risk.extensions.join(', ')}.`,
    risk.exit === null
      ? 'No route was found to sell it back to the dollar.'
      : `Selling ${formatUsd(risk.exit.amountUsd)} of it back to the dollar now would move the price by ${percent(risk.exit.priceImpactBps)}.`,
  ]
}

/** Why a buy would be refused or wait for the owner, from CR-021's own checks. */
export function checkFacts(risk: Risk): string[] {
  return [
    ...risk.risks.map((code) => `A buy is refused: ${REFUSALS[code] ?? code} (${code}).`),
    ...risk.flags.map((flag) => `A buy waits for you: ${FLAGS[flag] ?? flag} (${flag})`),
  ]
}

/** A venue's decimal dollar string, "41250000.5", as "$41,250,000.50". */
export function dollars(decimal: string): string {
  const [whole = '0', cents = ''] = decimal.split('.')
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${cents.padEnd(2, '0')}`
}

/** What Jupiter says, kept apart and labelled: the venue is not checked. */
export function venueFacts({ venue }: Risk): string[] {
  return [
    venue.verified ? 'Verified by Jupiter.' : 'Not verified by Jupiter.',
    venue.holders !== undefined && `${venue.holders.toLocaleString('en-US')} holders.`,
    venue.liquidityUsd !== undefined && `Liquidity ${dollars(venue.liquidityUsd)}.`,
    venue.organicScore !== undefined && `Organic score ${Math.round(venue.organicScore)} of 100.`,
    venue.createdAt !== undefined && `Listed since ${venue.createdAt.slice(0, 10)}.`,
  ].filter((fact): fact is string => fact !== false)
}

/** Verified first, as SPEC asks; unverified only when the owner asked to see them. */
export function listed<T extends { verified: boolean }>(tokens: T[], unverified: boolean): T[] {
  const verified = tokens.filter((token) => token.verified)
  return unverified ? [...verified, ...tokens.filter((token) => !token.verified)] : verified
}

/**
 * "1.5" or "1,5" in a token's units to base units, exactly in bigint; undefined for anything else,
 * thousands separators included. A comma before exactly three digits is refused, as for dollars.
 */
export function parseUnits(text: string, decimals: number): string | undefined {
  const match = /^(\d{1,30})(?:\.(\d+)|,(?!\d{3}$)(\d+))?$/.exec(text.trim())
  const fraction = match?.[2] ?? match?.[3] ?? ''
  if (match === null || fraction.length > decimals) {
    return undefined
  }
  const value =
    BigInt(match[1]!) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0')
  return value > 0n ? value.toString() : undefined
}
