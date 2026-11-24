import type { Policy, TradingPolicy } from '@defimind/shared'
import { parseAmount } from './amount.js'
import type { StoredPolicy } from './policy.js'

const LIMITS = ['perTxMax', 'dailyMax', 'approvalThreshold'] as const
const LISTS = ['chains', 'tokens', 'allowedRecipients', 'allowedDomains'] as const

/**
 * The fields a policy change loosens: SPEC's list (a raised limit, anything added to an allowlist,
 * going live, no longer requiring a mandate), plus three it leaves out. Unpausing here is a resume
 * without the resume's passkey, and a higher breaker or price-jump limit lets more through. Any of
 * them needs the owner's passkey; a change that only tightens needs the session alone.
 */
export function loosened(before: StoredPolicy, after: Policy): string[] {
  const raised = LIMITS.filter((limit) => parseAmount(after[limit]) > parseAmount(before[limit]))
  const added = LISTS.filter((list) => after[list].some((item) => !before[list].includes(item)))
  return [
    ...raised,
    ...added,
    ...(after.mode === 'live' && before.mode !== 'live' ? ['mode'] : []),
    ...(after.requireMandate === false && before.requireMandate ? ['requireMandate'] : []),
    ...(!after.paused && before.paused ? ['paused'] : []),
    ...((after.maxPaymentsPerMinute ?? 0) > before.maxPaymentsPerMinute
      ? ['maxPaymentsPerMinute']
      : []),
    ...((after.priceIncreaseMaxPct ?? 0) > before.priceIncreaseMaxPct
      ? ['priceIncreaseMaxPct']
      : []),
    ...tradingLoosened(before.trading, after.trading).map((field) => `trading.${field}`),
  ]
}

const TRADE_LIMITS = ['maxTradeUsd', 'dailyTradeMax', 'maxPositionUsd'] as const
const TRADE_BPS = ['maxSlippageBps', 'maxPriceImpactBps'] as const

/** No trading policy trades nothing, so it compares as one that allows nothing (CR-021). */
const CLOSED: TradingPolicy = {
  enabled: false,
  venues: [],
  tokens: [],
  allowAnyToken: false,
  maxTradeUsd: '0',
  dailyTradeMax: '0',
  maxPositionUsd: '0',
  maxSlippageBps: 0,
  maxPriceImpactBps: 0,
}

function tradingLoosened(before: TradingPolicy = CLOSED, after: TradingPolicy = CLOSED): string[] {
  return [
    ...(after.enabled && !before.enabled ? ['enabled'] : []),
    ...(after.allowAnyToken && !before.allowAnyToken ? ['allowAnyToken'] : []),
    ...(['venues', 'tokens'] as const).filter((list) =>
      after[list].some((item) => !before[list].includes(item)),
    ),
    ...TRADE_LIMITS.filter((limit) => parseAmount(after[limit]) > parseAmount(before[limit])),
    ...TRADE_BPS.filter((limit) => after[limit] > before[limit]),
  ]
}
