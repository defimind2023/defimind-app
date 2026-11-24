import type { FastifyInstance } from 'fastify'
import { loosened } from '../domain/loosen.js'
import type { X402Deps } from '../service/x402.js'
import { controls } from './control.js'
import { HttpError } from './errors.js'
import { agentIdParam, agentRouteParam, policyTighten } from './schemas.js'

/**
 * CR-016: what the bot may do with its own token. It can stop, cut off and narrow, and read; it can
 * never create, allow, raise, go live or resume. Those take the panel's passkey or the admin token.
 */
export function botControlRoutes(deps: X402Deps, setup: { botUrl: string; databaseUrl: string }) {
  const control = controls(deps, 'bot')

  return async (app: FastifyInstance) => {
    app.post('/pause', async (request) =>
      control.setPaused(agentIdParam.parse(request.body).agentId, true),
    )
    app.post('/kill', async (request) => control.kill(request.log))
    app.post('/agents/:id/revoke', async (request) =>
      control.revokeAgent(agentRouteParam.parse(request.params).id, request.log),
    )

    app.post('/policy/:agentId/tighten', async (request) => {
      const { agentId } = agentIdParam.parse(request.params)
      const change = policyTighten.parse(request.body)
      const before = control.existing(agentId)
      const after = {
        ...before,
        allowedDomains: before.allowedDomains.filter((d) => !change.removeDomains?.includes(d)),
        allowedRecipients: before.allowedRecipients.filter(
          (r) => !change.removeRecipients?.includes(r),
        ),
        ...(change.mode === undefined ? {} : { mode: change.mode }),
        ...(change.perTxMax === undefined ? {} : { perTxMax: change.perTxMax }),
        ...(change.dailyMax === undefined ? {} : { dailyMax: change.dailyMax }),
        ...(change.approvalThreshold === undefined
          ? {}
          : { approvalThreshold: change.approvalThreshold }),
      }
      // The same rule as the panel's passkey, applied to the result: nothing here may loosen.
      if (loosened(before, after).length > 0) {
        throw new HttpError(403, 'loosen_in_panel')
      }
      return control.putPolicy(after)
    })

    app.get('/agents', async () => control.agents())
    app.get('/policy/:agentId', async (request) =>
      control.existing(agentIdParam.parse(request.params).agentId),
    )
    app.get('/budget/:agentId', async (request) =>
      control.budget(agentIdParam.parse(request.params).agentId),
    )
    app.get('/chains', async (request) => ({ chains: await control.chains(request.log) }))
    app.get('/report', async (request) => control.report(request.query))
    app.get('/doctor', async () => control.doctor({ ...setup, fetch: deps.fetch }))
  }
}
