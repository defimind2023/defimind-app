import type { ApprovalRequest } from '@defimind/shared'
import { amountText, chainName, escapeHtml, utcTime } from './text.js'

export function breakerText(agentId: string, detail: string): string {
  const id = `<code>${escapeHtml(agentId)}</code>`
  return [
    `<b>Circuit breaker tripped</b> for ${id}: paused. Resume it in the DefiMind panel when you have looked.`,
    ...(detail === '' ? [] : [`guard-core says: <i>${escapeHtml(detail)}</i>`]),
  ].join('\n')
}

/** Sent on every enrolment, so an owner who did not add the passkey hears of it at once. */
export function passkeyText(detail: string): string {
  return [
    '<b>A passkey was added</b> for approvals. If it was not you, run /kill and remove it on the machine.',
    ...(detail === '' ? [] : [`guard-core says: <i>${escapeHtml(detail)}</i>`]),
  ].join('\n')
}

/** CR-013: a receipt was changed or removed after it was written, or the chain has a gap. */
export function chainBrokenText(detail: string): string {
  return [
    '<b>The execution record failed its integrity check.</b> A receipt was changed or removed ' +
      'after it was written. Open the DefiMind panel to see where.',
    ...(detail === '' ? [] : [`guard-core says: <i>${escapeHtml(detail)}</i>`]),
  ].join('\n')
}

/**
 * CR-022: someone holding the admin token tried to widen a policy, resume an agent or open a task
 * budget, and guard-core refused it. The token is a machine credential: this is an attack until the
 * owner knows otherwise.
 */
export function adminLoosenText(detail: string): string {
  return [
    '<b>Possible attack blocked</b>',
    "Someone with guard-core's admin token tried to give an agent more room. guard-core refused " +
      'it: no rule changed. Only your passkey can do that, in the DefiMind panel.',
    'If it was not you, replace ADMIN_TOKEN on the server now, and consider /kill.',
    ...(detail === '' ? [] : [`guard-core says: <i>${escapeHtml(detail)}</i>`]),
  ].join('\n')
}

/** CR-024: the nightly copy of the database failed; what is on the server is untouched. */
export function backupFailedText(detail: string): string {
  return [
    '<b>Database backup failed.</b> Your data is still on the server. Open the doctor in the DefiMind panel.',
    ...(detail === '' ? [] : [`guard-core says: <i>${escapeHtml(detail)}</i>`]),
  ].join('\n')
}

// Telegram refuses a message over 4096 characters, and /status adds the chains after this.
const PENDING_LIMIT = 2000

export function statusText(guardUp: boolean, pending: ApprovalRequest[], tasks = 0): string {
  const lines: string[] = []
  let length = 0
  for (const { intent, approveBefore } of pending) {
    const line =
      `• <code>${escapeHtml(intent.agentId)}</code> ${amountText(intent)} on ` +
      `${chainName(intent.chain)}, expires ${utcTime(approveBefore)}`
    if (length + line.length > PENDING_LIMIT) {
      lines.push(`…and ${pending.length - lines.length} more. Each one is in the chat above.`)
      break
    }
    lines.push(line)
    length += line.length + 1
  }
  return [
    `guard-core: ${guardUp ? 'reachable' : '<b>unreachable</b>'}`,
    `Pending approvals: ${pending.length}`,
    ...lines,
    ...(tasks > 0 ? [`Pending task budgets: ${tasks}`] : []),
  ].join('\n')
}
