import { InlineKeyboard } from 'grammy'

/**
 * Callback data is capped at 64 bytes by Telegram; an action plus a uuid fits. approve: undefined for
 * an Approve button; a URL for a passkey request, which only guard-core's passkey page can approve;
 * null for no way to approve here at all, for the panel or a passkey page whose address is unknown.
 */
export function approvalKeyboard(intentId: string, approve?: string | null): InlineKeyboard {
  const keyboard = new InlineKeyboard()
  if (approve === undefined) {
    keyboard.text('Approve', `approve:${intentId}`)
  } else if (approve !== null) {
    keyboard.url('Approve with passkey', approve)
  }
  return keyboard
    .text('Reject', `reject:${intentId}`)
    .row()
    .text('Show full recipient', `recipient:${intentId}`)
}

export function mandateKeyboard(mandateId: string, approve = true): InlineKeyboard {
  const keyboard = new InlineKeyboard()
  if (approve) {
    keyboard.text('Approve', `task-approve:${mandateId}`)
  }
  return keyboard.text('Reject', `task-reject:${mandateId}`)
}
