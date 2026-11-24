import type { AgentSummary, DoctorCheck, Policy } from '@defimind/shared'
import { USDC_DECIMALS } from '@defimind/shared'
import { formatUsd } from './money.js'
import { chainName, escapeHtml } from './text.js'

/** The three amounts an owner edits from Telegram, only ever downwards there. */
export const LIMITS = ['perTxMax', 'dailyMax', 'approvalThreshold'] as const
export type Limit = (typeof LIMITS)[number]

export const LIMIT_NAMES: Record<Limit, string> = {
  perTxMax: 'per payment max',
  dailyMax: 'daily max',
  approvalThreshold: 'approval threshold',
}

const DOLLARS = /^\$?(\d{1,12})(?:\.(\d{1,6}))?$/

/** "12.5" or "$12.50" to atomic units, in bigint; undefined for anything else, a negative included. */
export function parseDollars(text: string): string | undefined {
  const match = DOLLARS.exec(text.trim())
  if (match === null) {
    return undefined
  }
  const [, whole = '0', fraction = ''] = match
  const unit = 10n ** BigInt(USDC_DECIMALS)
  return (BigInt(whole) * unit + BigInt(fraction.padEnd(USDC_DECIMALS, '0'))).toString()
}

export const PRESETS = {
  Careful: { perTxMax: '1000000', dailyMax: '5000000', approvalThreshold: '500000' },
  Standard: { perTxMax: '5000000', dailyMax: '20000000', approvalThreshold: '1000000' },
} as const satisfies Record<string, Record<Limit, string>>

export type Preset = keyof typeof PRESETS

/**
 * The body of POST /v1/bot/policy/:id/tighten (CR-016). It can only take a domain away or go to
 * shadow; a limit is the one field that could still go up, and guard-core refuses that.
 */
export type Tighten = Partial<Record<Limit, string>> & {
  removeDomains?: string[]
  mode?: 'shadow'
}

/** The limits a change would raise: the bot refuses those itself, before guard-core does. */
export function raises(before: Policy, change: Tighten): Limit[] {
  return LIMITS.filter((limit) => {
    const next = change[limit]
    return next !== undefined && BigInt(next) > BigInt(before[limit])
  })
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

export function policyText(policy: Policy): string {
  const domains = policy.allowedDomains.map((domain) => `<code>${escapeHtml(domain)}</code>`)
  return [
    `<b>Policy</b> for <code>${escapeHtml(policy.agentId)}</code>`,
    `Mode: ${policy.mode ?? 'live'}${policy.paused ? ', <b>paused</b>' : ''}`,
    `Per payment: up to ${formatUsd(policy.perTxMax)}`,
    `Daily: up to ${formatUsd(policy.dailyMax)}`,
    `Owner approval: at or above ${formatUsd(policy.approvalThreshold)}`,
    `Chains: ${policy.chains.map(chainName).join(', ') || 'none'}`,
    `Domains: ${domains.join(', ') || 'none (every x402 payment is refused)'}`,
    `Direct transfer recipients: ${policy.allowedRecipients.length}`,
  ].join('\n')
}

export function agentsText(agents: AgentSummary[]): string {
  if (agents.length === 0) {
    return 'No agents yet. Create one in the DefiMind panel.'
  }
  return [
    `<b>Agents</b> (${agents.length})`,
    ...agents.map(
      ({ agentId, mode, paused }) =>
        `• <code>${escapeHtml(agentId)}</code>: ${mode}${paused ? ', paused' : ''}`,
    ),
  ].join('\n')
}

const MARKS: Record<DoctorCheck['status'], string> = { ok: '✅', warn: '⚠️', fail: '❌' }

/** One block per check, with the fix under each warning or failure. */
export function doctorBlocks(checks: DoctorCheck[]): string[] {
  return checks.map(({ status, message, fix }) =>
    status !== 'ok' && fix !== undefined
      ? `${MARKS[status]} ${escapeHtml(message)}\n    Fix: ${escapeHtml(fix)}`
      : `${MARKS[status]} ${escapeHtml(message)}`,
  )
}
