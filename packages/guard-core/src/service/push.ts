import type { ApprovalRequest, MandateApprovalRequest, PayIntent } from '@defimind/shared'
import type { FastifyBaseLogger } from 'fastify'
import type { PushService } from '../adapters/push.js'
import type { Db } from '../db/client.js'
import { subscriptions, unsubscribe } from '../db/push.js'
import { pushEndpointAllowed } from '../domain/push-host.js'
import type { AlertBody } from './events.js'

/** What a push says (SPEC, CR-012). Never a recipient or a URL: the panel shows the rest. */
export interface PushPayload {
  kind:
    | 'approval'
    | 'mandate'
    | 'executed'
    | 'attack'
    | 'breaker'
    | 'passkey_enrolled'
    | 'kill'
    | 'chain_broken'
    | 'backup_failed'
  agentId?: string
  chain?: string
  amount?: string
  intentId?: string
}

/** A rejection with one of these means something tried to take standing authority over funds. */
const ATTACK_CODES = new Set([
  'APPROVAL_DETECTED',
  'PERMIT_DETECTED',
  'DELEGATION_DETECTED',
  'DELEGATE_DETECTED',
  'AUTHORITY_CHANGE_DETECTED',
  'ACCOUNT_CLOSE_DETECTED',
  'UNKNOWN_PROGRAM_DETECTED',
  'HIDDEN_ACCOUNTS_DETECTED',
])

/** As in the bot: after an attack push, the same agent and code stay quiet this long. */
export const ATTACK_WINDOW_MS = 5 * 60_000

export interface PushDeps {
  db: Db
  service: PushService
  now: () => Date
  log: Pick<FastifyBaseLogger, 'warn'>
}

/**
 * Sends each event to every subscribed browser, never awaited: a push service that is slow or down
 * must not hold up a payment. A subscription the push service says is gone (404, 410) is deleted.
 */
export function pusher(deps: PushDeps) {
  const windows = new Map<string, number>()

  function send(payload: PushPayload) {
    const body = JSON.stringify({ ...payload, sentAt: deps.now().toISOString() })
    for (const target of subscriptions(deps.db)) {
      // Checked again here, so a row from before the allowlist, or written by hand, is never sent to.
      if (!pushEndpointAllowed(target.endpoint)) {
        continue
      }
      // The host only: the endpoint is a capability URL, and the error carries it and the reply.
      const host = new URL(target.endpoint).hostname
      void deps.service.send(target, body).then(
        (status) => {
          if (status === 404 || status === 410) {
            unsubscribe(deps.db, target.id)
          } else if (status >= 300) {
            deps.log.warn({ status, host }, 'push refused')
          }
        },
        () => deps.log.warn({ host }, 'push failed'),
      )
    }
  }

  /** True for the first attack by this agent with this code in its window. */
  function fresh(agentId: string, code: string): boolean {
    const key = `${agentId}\u0000${code}`
    const at = deps.now().getTime()
    const opened = windows.get(key)
    if (opened !== undefined && at - opened < ATTACK_WINDOW_MS) {
      return false
    }
    windows.set(key, at)
    return true
  }

  return {
    send,
    kill: () => send({ kind: 'kill' }),
    approval(request: ApprovalRequest | MandateApprovalRequest) {
      if ('mandate' in request) {
        const { agentId, budget } = request.mandate
        send({ kind: 'mandate', agentId, amount: budget })
        return
      }
      const { agentId, chain, amount, id } = request.intent
      send({ kind: 'approval', agentId, chain, amount, intentId: id })
    },
    intent(intent: PayIntent) {
      const { agentId, chain, amount, id } = intent
      if (intent.status === 'executed') {
        send({ kind: 'executed', agentId, chain, amount, intentId: id })
      }
      const attacks = intent.rejectReasons.filter((code) => ATTACK_CODES.has(code))
      if (attacks.filter((code) => fresh(agentId, code)).length > 0) {
        send({ kind: 'attack', agentId, chain, intentId: id })
      }
    },
    alert(event: AlertBody) {
      if (event.kind === 'breaker_tripped') {
        send({ kind: 'breaker', agentId: event.agentId })
      } else if (event.kind === 'admin_loosen_refused') {
        // CR-022: a leaked admin token at work reads as an attack, not as news.
        send({ kind: 'attack' })
      } else {
        send({ kind: event.kind })
      }
    },
  }
}

export type Pusher = ReturnType<typeof pusher>
