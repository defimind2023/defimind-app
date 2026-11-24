import { getAddress } from '@defimind/shared'
import { type Trading, tradingLoosens } from './trading.js'

const LIMITS = ['perTxMax', 'dailyMax', 'approvalThreshold'] as const
const LISTS = ['chains', 'tokens', 'allowedRecipients', 'allowedDomains'] as const

/** The parts of a Policy a change can loosen. */
export type Rules = Record<(typeof LIMITS)[number], string> &
  Record<(typeof LISTS)[number], string[]> & {
    mode?: 'live' | 'shadow' | undefined
    requireMandate?: boolean | undefined
    paused?: boolean | undefined
    priceIncreaseMaxPct?: number | undefined
    maxPaymentsPerMinute?: number | undefined
    trading?: Trading | undefined
  }

/** SPEC's defaults for a policy that leaves these out, as guard-core applies them. */
const DEFAULTS = { priceIncreaseMaxPct: 100, maxPaymentsPerMinute: 10 } as const

/**
 * Whether a policy change loosens anything, as guard-core counts it: SPEC's list (a raised limit,
 * anything added to an allowlist, going live, no longer requiring a mandate), plus unpausing, which
 * would otherwise be a resume without its passkey, a raised breaker or price margin, and CR-021's
 * trading rules. guard-core asks for a passkey then; the panel asks first, so the owner is not
 * refused after pressing Save.
 */
export function loosens(before: Rules, after: Rules): boolean {
  const raised = LIMITS.some((limit) => BigInt(after[limit]) > BigInt(before[limit]))
  const added = LISTS.some((list) => after[list].some((item) => !before[list].includes(item)))
  const live = after.mode === 'live' && (before.mode ?? 'live') !== 'live'
  const unmandated = after.requireMandate === false && before.requireMandate === true
  const unpaused = after.paused === false && before.paused === true
  const wider = (Object.keys(DEFAULTS) as (keyof typeof DEFAULTS)[]).some(
    (key) => (after[key] ?? DEFAULTS[key]) > (before[key] ?? DEFAULTS[key]),
  )
  const trades = tradingLoosens(before.trading, after.trading)
  return raised || added || live || unmandated || unpaused || wider || trades
}

/** Lowercase DNS labels only: an allowlist entry that is not a hostname would never match a request. */
export function hostname(text: string): string | undefined {
  const host = text.trim().toLowerCase()
  const label = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/
  const labels = host.split('.')
  return host.length <= 253 && labels.length >= 2 && labels.every((part) => label.test(part))
    ? host
    : undefined
}

/**
 * The chains an agent may pay on and their dollar tokens, as the owner picked them out of the
 * chains this deployment runs. A token of a chain left out goes too; a token the panel does not
 * know as a chain's dollar stays, so a hand-set one survives.
 */
export function chainRules<P extends Rules>(policy: P, known: string[], picked: string[]): P {
  const usd = (chain: string) => getAddress(chain, 'usd')
  const managed = new Set(known.map(usd).filter((token) => token !== undefined))
  const tokens = picked.map(usd).filter((token) => token !== undefined)
  return {
    ...policy,
    chains: [...policy.chains.filter((chain) => !known.includes(chain)), ...picked],
    tokens: [...new Set([...policy.tokens.filter((token) => !managed.has(token)), ...tokens])],
  }
}

/** The chains a new agent can pay on: those with a vault, where the money is. */
export const vaulted = (chains: { chain: string; vault?: string | undefined }[]) =>
  chains.filter((c) => c.vault !== undefined).map((c) => c.chain)
