import type { Mandate, PayIntent } from '@defimind/shared'
import { decideMandate } from '../db/mandates.js'
import * as repo from '../db/repo.js'
import { decide, type Decision } from '../service/approvals.js'
import { afterApproval } from '../service/approved.js'
import { notify } from '../service/events.js'
import type { PaymentDeps } from '../service/payments.js'
import { HttpError } from './errors.js'

/**
 * The owner's answer on an intent, from Telegram or the panel. `method` is how the approval was
 * proven, and goes on the receipt; `detail` says who answered, for the audit.
 */
export async function decideIntent(
  deps: PaymentDeps,
  intentId: string,
  decision: Decision,
  method: 'owner' | 'passkey',
  detail: Record<string, unknown>,
): Promise<PayIntent> {
  const { db, now } = deps
  const result = decide(db, intentId, decision, now())
  if (!result.ok) {
    const late = result.reason === 'expired' ? repo.getIntent(db, intentId) : undefined
    if (late !== undefined) {
      notify(deps, late)
    }
    // A decision on something already settled is a conflict, not a bad request: the caller was
    // right about the id and only lost the race.
    throw new HttpError(result.reason === 'not_found' ? 404 : 409, result.reason)
  }
  repo.audit(
    db,
    {
      event: 'owner_decision',
      intentId,
      agentId: result.intent.agentId,
      reasons: result.intent.rejectReasons,
      detail: { decision, ...detail },
    },
    now(),
  )
  // A rejection keeps the old pin, so the same request stays flagged.
  if (decision === 'reject') {
    notify(deps, result.intent)
    return result.intent
  }
  return afterApproval(deps, result.intent, method)
}

export function decideMandateFor(
  deps: PaymentDeps,
  mandateId: string,
  decision: Decision,
  detail: Record<string, unknown>,
): Mandate {
  const { db, now } = deps
  const result = decideMandate(db, mandateId, decision, now())
  if (!result.ok) {
    const code = { not_found: 404, already_decided: 409, expired: 410 }[result.reason]
    throw new HttpError(code, result.reason)
  }
  repo.audit(
    db,
    {
      event: 'mandate_decision',
      agentId: result.mandate.agentId,
      detail: { mandateId, decision, ...detail },
    },
    now(),
  )
  return result.mandate
}
