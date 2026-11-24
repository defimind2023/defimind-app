import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { getReceipt } from '../db/receipts.js'
import * as repo from '../db/repo.js'
import { hashToken, parseBearer } from '../domain/auth.js'
import { UpstreamError } from '../adapters/upstream.js'
import { budget } from '../service/budget.js'
import { portfolio } from '../service/portfolio.js'
import { quote, swap, VenueUnavailable } from '../service/swap.js'
import { transfer } from '../service/transfer.js'
import { paidFetch, type X402Deps } from '../service/x402.js'
import { appendExecution } from '../service/executions.js'
import { HttpError } from './errors.js'
import { windowLimiter } from './limiter.js'
import { openMandate } from '../service/mandates.js'
import { mandateReply } from './mandates.js'
import {
  agentIdParam,
  executionReport,
  intentIdParam,
  mandateRequest,
  quoteRequest,
  swapRequest,
  transferRequest,
  x402FetchRequest,
} from './schemas.js'

export function agentRoutes(
  deps: X402Deps,
  limits: { perIp: number; perAgent: number; ipOf: (request: FastifyRequest) => string },
) {
  const { db } = deps
  const perIp = windowLimiter(limits.perIp, 60_000)
  const perAgent = windowLimiter(limits.perAgent, 60_000)

  async function requireAgent(request: FastifyRequest, reply: FastifyReply) {
    const presented = parseBearer(request.headers.authorization)
    const agent = presented === undefined ? undefined : repo.findAgentByToken(db, presented)
    if (agent === undefined) {
      return reply.code(401).send({ error: 'unauthorized' })
    }
    request.agentId = agent.id
  }

  /** An agent acts only as itself. A token for one agent naming another is refused outright. */
  function ownPolicy(request: FastifyRequest, agentId: string) {
    if (agentId !== request.agentId) {
      throw new HttpError(403, 'forbidden')
    }
    const policy = repo.getPolicy(db, agentId)
    if (policy === undefined) {
      throw new HttpError(404, 'not_found')
    }
    return policy
  }

  /** A venue that is down is a 502, as an x402 API that is down is. */
  function unavailable(reply: FastifyReply, error: unknown) {
    if (error instanceof VenueUnavailable) {
      return reply.code(502).send({ error: error.message })
    }
    throw error
  }

  return async (app: FastifyInstance) => {
    // Two budgets, both checked before the token is looked up. Per address, so one machine cannot
    // flood the routes with many tokens; per token, so one agent spread over many addresses still
    // gets one budget. The token is keyed by its digest, so the limiter never holds a usable token.
    app.addHook('onRequest', async (request, reply) => {
      const token = hashToken(parseBearer(request.headers.authorization) ?? '')
      for (const result of [perIp(`ip:${limits.ipOf(request)}`), perAgent(`agent:${token}`)]) {
        if (!result.allowed) {
          return reply
            .code(429)
            .header('retry-after', String(result.retryAfterS))
            .send({ error: 'rate_limited' })
        }
      }
    })
    app.addHook('preHandler', requireAgent)

    app.post('/transfer', async (request) => {
      const body = transferRequest.parse(request.body)
      ownPolicy(request, body.agentId)
      const intent = await transfer(deps, body)
      return {
        intentId: intent.id,
        status: intent.status,
        rejectReasons: intent.rejectReasons,
        ...(intent.txId === undefined ? {} : { txId: intent.txId }),
      }
    })

    app.post('/x402/fetch', async (request, reply) => {
      const body = x402FetchRequest.parse(request.body)
      const policy = ownPolicy(request, body.agentId)
      try {
        return await paidFetch(deps, body, policy)
      } catch (error) {
        if (error instanceof UpstreamError) {
          return reply.code(502).send({ error: error.message })
        }
        throw error
      }
    })

    app.post('/mandates', async (request, reply) => {
      const body = mandateRequest.parse(request.body)
      if (body.agentId !== request.agentId) {
        throw new HttpError(403, 'forbidden')
      }
      return mandateReply(reply, await openMandate(deps, body, false))
    })

    // CR-013. The agent comes from the token, so one agent cannot write into another's record.
    app.post('/executions', async (request) => {
      const report = executionReport.parse(request.body)
      const { agentId } = request
      if (agentId === undefined) {
        throw new HttpError(401, 'unauthorized')
      }
      if (deps.receiptKey === undefined) {
        throw new HttpError(409, 'receipts_not_configured')
      }
      return appendExecution(
        db,
        deps.receiptKey,
        { ...report, agentId, kind: 'tool_call', assurance: 'relayed' },
        deps.now(),
      )
    })

    // Same rule as the intent itself: another agent's receipt is reported as missing.
    app.get('/intents/:id/receipt', async (request, reply) => {
      const { id } = intentIdParam.parse(request.params)
      const intent = repo.getIntent(db, id)
      const receipt = intent?.agentId === request.agentId ? getReceipt(db, id) : undefined
      return receipt ?? reply.code(404).send({ error: 'not_found' })
    })

    app.get('/intents/:id', async (request, reply) => {
      const { id } = intentIdParam.parse(request.params)
      const intent = repo.getIntent(db, id)
      // An intent belonging to another agent is reported as missing, not as forbidden: otherwise
      // the response confirms that the id exists.
      if (!intent || intent.agentId !== request.agentId) {
        return reply.code(404).send({ error: 'not_found' })
      }
      return intent
    })

    // CR-021. The quote decides nothing; the swap runs the whole pipeline.
    app.post('/quote', async (request, reply) => {
      const body = quoteRequest.parse(request.body)
      const policy = ownPolicy(request, body.agentId)
      return quote(deps, body, policy).catch((error: unknown) => unavailable(reply, error))
    })

    app.post('/swap', async (request, reply) => {
      const body = swapRequest.parse(request.body)
      ownPolicy(request, body.agentId)
      let intent
      try {
        intent = await swap(deps, body)
      } catch (error) {
        return unavailable(reply, error)
      }
      return {
        intentId: intent.id,
        status: intent.status,
        rejectReasons: intent.rejectReasons,
        ...(intent.txId === undefined ? {} : { txId: intent.txId }),
      }
    })

    app.get('/portfolio/:agentId', async (request) => {
      const { agentId } = agentIdParam.parse(request.params)
      ownPolicy(request, agentId)
      return portfolio(db, agentId, deps.now())
    })

    app.get('/budget/:agentId', async (request) => {
      const { agentId } = agentIdParam.parse(request.params)
      const policy = ownPolicy(request, agentId)
      return budget(deps, policy)
    })
  }
}
