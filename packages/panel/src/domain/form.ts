import { dollarsInput, parseDollars } from './money.js'
import { hostname, type Rules } from './policy.js'

/** The policy form as the owner typed it: limits in dollars, lists one entry per line. */
export interface PolicyForm {
  perTxMax: string
  dailyMax: string
  approvalThreshold: string
  allowedDomains: string
  allowedRecipients: string
  requireMandate: boolean
}

const LABELS = {
  perTxMax: 'Per payment',
  dailyMax: 'Per day',
  approvalThreshold: 'Ask me from',
} as const

const entries = (text: string) => [...new Set(text.split(/[\s,]+/).filter(Boolean))]

export function toForm(policy: Rules): PolicyForm {
  return {
    perTxMax: dollarsInput(policy.perTxMax),
    dailyMax: dollarsInput(policy.dailyMax),
    approvalThreshold: dollarsInput(policy.approvalThreshold),
    allowedDomains: policy.allowedDomains.join('\n'),
    allowedRecipients: policy.allowedRecipients.join('\n'),
    requireMandate: policy.requireMandate ?? false,
  }
}

/** The policy after the form, or the first thing wrong with the form, said to the owner. */
export function fromForm<P extends Rules>(before: P, form: PolicyForm): P | string {
  const limits = {} as Record<keyof typeof LABELS, string>
  for (const key of Object.keys(LABELS) as (keyof typeof LABELS)[]) {
    const amount = parseDollars(form[key])
    if (amount === undefined) {
      return `${LABELS[key]}: write an amount in dollars, like 12.50.`
    }
    limits[key] = amount
  }
  const domains = entries(form.allowedDomains.toLowerCase())
  const bad = domains.find((domain) => hostname(domain) === undefined)
  if (bad !== undefined) {
    return `${bad} is not a hostname. Write the API's host only, like api.example.com.`
  }
  const recipients = entries(form.allowedRecipients)
  const long = recipients.find((recipient) => recipient.length > 128)
  if (long !== undefined) {
    return `${long.slice(0, 20)}… is too long for an address.`
  }
  return {
    ...before,
    ...limits,
    allowedDomains: domains,
    allowedRecipients: recipients,
    requireMandate: form.requireMandate,
  }
}
