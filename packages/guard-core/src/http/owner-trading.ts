import { CHAINS, type TokenRisk } from '@defimind/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { TokenSearch } from '../adapters/jupiter-tokens.js'
import * as repo from '../db/repo.js'
import { everHeld } from '../db/trades.js'
import type { PaymentDeps } from '../service/payments.js'
import type { OwnerAction } from '../service/step-up.js'
import { quote, swap, VenueUnavailable } from '../service/swap.js'
import { HttpError } from './errors.js'
import { windowLimiter } from './limiter.js'
import {
  ownerTrade,
  quoteRequest,
  tokenRiskParams,
  tokenRiskQuery,
  tokenSearch,
} from './schemas.js'

const REASON = 'owner: manual trade'

/**
 * The owner's trading tools (CR-025): find a token, read its risk, quote, and trade for an agent
 * through that agent's own pipeline. Solana mainnet through Jupiter only, as for agents.
 */
export function ownerTradingRoutes(
  deps: PaymentDeps,
  search: TokenSearch,
  stepUp: (action: OwnerAction, body: unknown, assertion: unknown) => Promise<string>,
) {
  const { db, now } = deps
  const searches = windowLimiter(30, 60_000)

  function venueDown(reply: FastifyReply, error: unknown) {
    if (error instanceof VenueUnavailable) {
      return reply.code(502).send({ error: error.message })
    }
    throw error
  }

  function jupiter(chain: string) {
    if (chain !== CHAINS.solanaMainnet) {
      throw new HttpError(400, 'not_tradable')
    }
  }

  function policyOf(agentId: string) {
    const policy = repo.getPolicy(db, agentId)
    if (policy === undefined) {
      throw new HttpError(404, 'not_found')
    }
    return policy
  }

  async function risk(request: FastifyRequest): Promise<TokenRisk> {
    const { mint } = tokenRiskParams.parse(request.params)
    const { chain } = tokenRiskQuery.parse(request.query)
    const adapter = deps.chains.get(chain)
    if (adapter?.tokenRisk === undefined) {
      throw new HttpError(400, 'not_tradable')
    }
    const facts = await adapter.tokenRisk(mint).catch(() => {
      throw new VenueUnavailable()
    })
    // The venue's own claims, labelled as such; a venue that is down leaves them out.
    const listed = await search(chain, mint).catch(() => [])
    const token = listed.find((t) => t.mint === mint)
    return {
      ...facts,
      flags: [
        ...(everHeld(db, chain, mint) ? [] : (['NEW_TOKEN'] as const)),
        ...(facts.mintAuthority ? (['MINT_AUTHORITY'] as const) : []),
      ],
      venue: { verified: token?.verified ?? false, ...token?.venue },
    }
  }

  return async (app: FastifyInstance) => {
    app.get('/v1/owner/tokens/search', async (request, reply) => {
      const { q, chain } = tokenSearch.parse(request.query)
      jupiter(chain)
      const hit = searches(`session:${request.ownerSession?.tokenHash ?? ''}`)
      if (!hit.allowed) {
        return reply
          .code(429)
          .header('retry-after', String(hit.retryAfterS))
          .send({ error: 'rate_limited' })
      }
      try {
        return { tokens: await search(chain, q) }
      } catch (error) {
        request.log.warn({ err: error }, 'token search failed')
        return reply.code(502).send({ error: 'venue_unavailable' })
      }
    })

    app.get('/v1/owner/tokens/:mint/risk', async (request, reply) =>
      risk(request).catch((error: unknown) => venueDown(reply, error)),
    )

    app.post('/v1/owner/quote', async (request, reply) => {
      const body = quoteRequest.parse(request.body)
      const policy = policyOf(body.agentId)
      return quote(deps, body, policy).catch((error: unknown) => venueDown(reply, error))
    })

    app.post('/v1/owner/trade', async (request, reply) => {
      const { assertion, minAmountOut, ...order } = ownerTrade.parse(request.body)
      policyOf(order.agentId)
      const { agentId, chain, tokenIn, tokenOut, amountIn } = order
      const bound = { agentId, chain, tokenIn, tokenOut, amountIn, minAmountOut }
      const passkey = await stepUp('manual_trade', bound, assertion)
      repo.audit(
        db,
        { event: 'owner_trade', agentId, detail: { ...bound, passkey, via: 'owner' } },
        now(),
      )
      try {
        const intent = await swap(deps, { ...order, reason: REASON }, { minAmountOut })
        return {
          intentId: intent.id,
          status: intent.status,
          rejectReasons: intent.rejectReasons,
          ...(intent.txId === undefined ? {} : { txId: intent.txId }),
        }
      } catch (error) {
        return venueDown(reply, error)
      }
    })
  }
}
