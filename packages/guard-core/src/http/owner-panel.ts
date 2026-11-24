import type { FastifyInstance } from 'fastify'
import { listAgents } from '../db/agents.js'
import { subscribe, unsubscribe } from '../db/push.js'
import * as repo from '../db/repo.js'
import { openRequests } from '../db/requests.js'
import { loosened } from '../domain/loosen.js'
import { pushEndpointAllowed } from '../domain/push-host.js'
import type { PasskeySetup } from '../service/passkeys.js'
import { type OwnerAction, stepUpChallenge, verifyStepUp } from '../service/step-up.js'
import type { X402Deps } from '../service/x402.js'
import { closePositions } from '../service/close.js'
import { ownerPortfolio } from '../service/portfolio.js'
import { controls } from './control.js'
import { decideIntent, decideMandateFor } from './decisions.js'
import { ownerExecutions } from './executions.js'
import { HttpError } from './errors.js'
import { ownerKeysRoute } from './owner-setup.js'
import { type ChainHost, ownerSettingsRoutes } from './owner-settings.js'
import { ownerGuideRoutes } from './owner-guide.js'
import { ownerTradingRoutes } from './owner-trading.js'
import { jupiterTokens, type TokenSearch } from '../adapters/jupiter-tokens.js'
import { ownerWalletRoutes, type Signing, withLinks } from './owner-wallets.js'
import type { PublicKeys } from '../adapters/public-keys.js'
import {
  agentIdParam,
  agentRouteParam,
  idParam,
  intentIdParam,
  ownerChallenge,
  ownerClose,
  ownerDecision,
  ownerNewAgent,
  ownerPolicy,
  ownerPush,
  ownerResume,
} from './schemas.js'

type Address = Pick<PasskeySetup, 'rpId' | 'origin'>

/**
 * The owner's panel routes (CR-012), behind the session. What could cost money or widen what an
 * agent may do also needs a fresh passkey assertion over that exact action and body.
 */
export function ownerPanelRoutes(
  deps: X402Deps,
  rp: Address,
  setup: {
    botUrl?: string
    databaseUrl: string
    hosted?: boolean
    publicAdmin?: boolean
    /** The VAPID public key; push is off without it. */
    pushKey?: string
    signing?: Signing
    keys?: PublicKeys
    host?: ChainHost
    /** Jupiter's token search; a test passes its own. */
    tokenSearch?: TokenSearch
  },
) {
  const { db, now } = deps
  const control = controls(deps, 'panel')

  /** The passkey that signed this action, or a refusal the panel can act on. */
  async function stepUp(action: OwnerAction, body: unknown, assertion: unknown) {
    if (assertion === undefined) {
      throw new HttpError(403, 'step_up_required')
    }
    const passkey = await verifyStepUp(db, rp, action, body, assertion, now())
    if (passkey === undefined) {
      repo.audit(db, { event: 'step_up_refused', detail: { action } }, now())
      throw new HttpError(401, 'passkey_not_verified')
    }
    return passkey.slice(0, 8)
  }

  return async (app: FastifyInstance) => {
    await app.register(ownerExecutions(deps))
    if (setup.keys !== undefined) {
      await app.register(ownerKeysRoute(setup.keys, db))
    }
    if (setup.host !== undefined) {
      await app.register(ownerSettingsRoutes(deps, setup.host, stepUp))
      await app.register(ownerGuideRoutes(deps, setup.host, setup.signing?.page))
      await app.register(ownerWalletRoutes(deps, rp.origin, setup.host, stepUp, setup.signing))
    }

    await app.register(
      ownerTradingRoutes(deps, setup.tokenSearch ?? jupiterTokens(deps.fetch), stepUp),
    )

    app.post('/v1/owner/challenge', async (request) => {
      const { action, body } = ownerChallenge.parse(request.body)
      return stepUpChallenge(db, rp, action, body ?? null, now())
    })

    app.get('/v1/owner/overview', async (request) => ({
      chains: await control.chains(request.log),
      agents: listAgents(db),
      ...openRequests(db, now()),
    }))

    app.post('/v1/owner/intents/:id/decision', async (request) => {
      const { id } = intentIdParam.parse(request.params)
      const { decision, assertion } = ownerDecision.parse(request.body)
      const passkey =
        decision === 'approve'
          ? await stepUp('approve_intent', { intentId: id }, assertion)
          : undefined
      return decideIntent(deps, id, decision, 'passkey', { via: 'panel', passkey })
    })

    app.post('/v1/owner/mandates/:id/decision', async (request) => {
      const { id } = idParam.parse(request.params)
      const { decision, assertion } = ownerDecision.parse(request.body)
      const passkey =
        decision === 'approve'
          ? await stepUp('approve_mandate', { mandateId: id }, assertion)
          : undefined
      return decideMandateFor(deps, id, decision, { via: 'panel', passkey })
    })

    app.get('/v1/owner/portfolio', async () => ownerPortfolio(db, now()))
    // CR-021. Works while agents are paused: it is how the owner gets out of every token.
    app.post('/v1/owner/positions/close', async (request) => {
      const { assertion } = ownerClose.parse(request.body)
      const passkey = await stepUp('close_positions', {}, assertion)
      repo.audit(db, { event: 'positions_close', detail: { passkey } }, now())
      return { intents: await closePositions(deps) }
    })
    app.get('/v1/owner/report', async (request) => control.report(request.query))
    // CR-012 mirror: the panel matches a payment's execution entry to its receipt by hash.
    app.get('/v1/owner/receipts', async (request) => control.receipts(request.query))
    app.get('/v1/owner/doctor', async () => control.doctor({ ...setup, fetch: deps.fetch }))
    app.get('/v1/owner/budget/:agentId', async (request) =>
      control.budget(agentIdParam.parse(request.params).agentId),
    )
    app.get('/v1/owner/passkeys', async () => control.passkeys())

    app.get('/v1/owner/agents', async () => control.agents())
    app.post('/v1/owner/agents', async (request) => {
      const { agentId, assertion } = ownerNewAgent.parse(request.body)
      await stepUp('create_agent', { agentId }, assertion)
      return control.addAgent(agentId)
    })
    app.post('/v1/owner/agents/:id/revoke', async (request) =>
      control.revokeAgent(agentRouteParam.parse(request.params).id, request.log),
    )

    app.get('/v1/owner/policy/:agentId', async (request) =>
      control.existing(agentIdParam.parse(request.params).agentId),
    )
    app.put('/v1/owner/policy/:agentId', async (request) => {
      const { agentId } = agentIdParam.parse(request.params)
      const { policy, assertion } = ownerPolicy.parse(request.body)
      const next = { agentId, ...policy }
      if (loosened(control.existing(agentId), next).length > 0) {
        // Hashed as the panel sent it, so a field this route ignores still has to match.
        const sent = (request.body as { policy: unknown }).policy
        await stepUp('loosen_policy', { agentId, policy: sent }, assertion)
      }
      return control.putPolicy(next)
    })

    app.post('/v1/owner/pause', async (request) =>
      control.setPaused(agentIdParam.parse(request.body).agentId, true),
    )
    app.post('/v1/owner/resume', async (request) => {
      const { agentId, assertion } = ownerResume.parse(request.body)
      await stepUp('resume', { agentId }, assertion)
      return control.setPaused(agentId, false)
    })

    app.get('/v1/owner/push/key', async () => {
      if (setup.pushKey === undefined) {
        throw new HttpError(404, 'push_not_configured')
      }
      return { publicKey: setup.pushKey }
    })
    app.post('/v1/owner/push', async (request) => {
      if (setup.pushKey === undefined) {
        throw new HttpError(404, 'push_not_configured')
      }
      const { subscription } = ownerPush.parse(request.body)
      if (!pushEndpointAllowed(subscription.endpoint)) {
        throw new HttpError(400, 'push_host_not_allowed')
      }
      const id = subscribe(db, { endpoint: subscription.endpoint, ...subscription.keys }, now())
      repo.audit(db, { event: 'push_subscribed', detail: { id } }, now())
      return { id }
    })
    app.delete('/v1/owner/push/:id', async (request) => {
      const { id } = idParam.parse(request.params)
      if (!unsubscribe(db, id)) {
        throw new HttpError(404, 'not_found')
      }
      return { ok: true }
    })

    app.post('/v1/owner/kill', async (request) => {
      const killed = await control.kill(request.log)
      return {
        ...killed,
        ownerTransactions: withLinks(killed.ownerTransactions, setup.signing, now()),
      }
    })
  }
}
