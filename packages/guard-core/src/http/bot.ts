import type { FastifyInstance } from 'fastify'
import * as repo from '../db/repo.js'
import { needsPasskey } from '../service/passkeys.js'
import type { X402Deps } from '../service/x402.js'
import { botControlRoutes } from './bot-tighten.js'
import { decideIntent, decideMandateFor } from './decisions.js'
import { HttpError } from './errors.js'
import { botDecisionRequest, idParam, mandateDecision } from './schemas.js'

export function botRoutes(
  deps: X402Deps,
  telegramApprovals: boolean,
  setup: { botUrl: string; databaseUrl: string },
) {
  /** With TELEGRAM_APPROVALS off, Telegram can say no to anything and yes to nothing. */
  function inPanel(decision: 'approve' | 'reject') {
    if (decision === 'approve' && !telegramApprovals) {
      throw new HttpError(403, 'approve_in_panel')
    }
  }

  return async (app: FastifyInstance) => {
    await app.register(botControlRoutes(deps, setup))

    app.post('/mandates/:id/decision', async (request) => {
      const { id } = idParam.parse(request.params)
      const { decision, telegramUserId } = mandateDecision.parse(request.body)
      inPanel(decision)
      return decideMandateFor(deps, id, decision, { telegramUserId })
    })

    app.post('/decision', async (request) => {
      const { intentId, decision, telegramUserId } = botDecisionRequest.parse(request.body)
      inPanel(decision)
      // Above PASSKEY_ABOVE a Telegram tap can still say no, never yes: a stolen Telegram account
      // must not be enough to move that much.
      const asked = repo.getIntent(deps.db, intentId)
      if (decision === 'approve' && asked !== undefined && needsPasskey(deps.passkey, asked)) {
        throw new HttpError(403, 'passkey_required')
      }
      return decideIntent(deps, intentId, decision, 'owner', { telegramUserId })
    })
  }
}
