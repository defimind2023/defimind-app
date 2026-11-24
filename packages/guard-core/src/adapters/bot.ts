import type {
  AlertEvent,
  ApprovalRequest,
  IntentEvent,
  MandateApprovalRequest,
} from '@defimind/shared'
import { botSettings, type Config } from '../config.js'
import { signWebhook } from '../domain/auth.js'

export interface BotNotifier {
  /** A payment, or a mandate, for the owner to decide; both go to the same hook. */
  requestApproval(request: ApprovalRequest | MandateApprovalRequest): Promise<void>
  intentEvent(event: IntentEvent): Promise<void>
  alert(event: AlertEvent): Promise<void>
}

/** Without a bot (CR-017) there is nobody to tell: the panel hears through Web Push alone. */
export const silentBotNotifier: BotNotifier = {
  requestApproval: async () => {},
  intentEvent: async () => {},
  alert: async () => {},
}

export function botNotifier(config: Config, fetchImpl: typeof fetch = fetch): BotNotifier {
  return botSettings(config) === undefined ? silentBotNotifier : httpBotNotifier(config, fetchImpl)
}

export function httpBotNotifier(config: Config, fetchImpl: typeof fetch = fetch): BotNotifier {
  // The sender needs the address and the signing secret; the bot's own token is for the other way.
  const { BOT_URL: url, BOT_WEBHOOK_SECRET: secret } = config
  if (url === undefined || secret === undefined) {
    throw new Error('the bot is not configured')
  }
  const bot = { url, secret }
  async function post(
    path: string,
    payload: ApprovalRequest | MandateApprovalRequest | IntentEvent | AlertEvent,
  ) {
    // Signed over the exact bytes sent: re-serialising on either side would change the signature.
    const body = JSON.stringify(payload)
    const response = await fetchImpl(`${bot.url}/hooks/${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-guard-signature': signWebhook(body, bot.secret),
      },
      body,
    })
    if (!response.ok) {
      throw new Error(`bot_webhook_failed: ${response.status}`)
    }
  }

  return {
    requestApproval: (request) => post('approval-request', request),
    intentEvent: (event) => post('intent-event', event),
    alert: (event) => post('alert', event),
  }
}
