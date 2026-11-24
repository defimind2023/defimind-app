import type { RegistrationResponseJSON } from '@simplewebauthn/server'
import type { FastifyInstance } from 'fastify'
import { revokeMandate } from '../db/mandates.js'
import { countPasskeys } from '../db/passkeys.js'
import { loosened } from '../domain/loosen.js'
import { alert } from '../service/events.js'
import * as repo from '../db/repo.js'
import { openMandate } from '../service/mandates.js'
import { enrol, enrolmentOptions, issueEnrolCode } from '../service/passkeys.js'
import type { PaymentDeps } from '../service/payments.js'
import { controls } from './control.js'
import { adminExecutions } from './executions.js'
import { HttpError } from './errors.js'
import { mandateReply } from './mandates.js'
import { enrolledNotice, refusal } from './owner.js'
import {
  agentIdParam,
  agentRouteParam,
  idParam,
  mandateRequest,
  newAgentRequest,
  passkeyEnrolment,
  policyBody,
} from './schemas.js'

export function adminRoutes(
  deps: PaymentDeps & { fetch: typeof fetch },
  setup: {
    botUrl?: string
    databaseUrl: string
    passkeyRpId?: string
    passkeyOrigin?: string
    /** SETUP_CODE is set: only it may enrol the first passkey (CR-022). */
    setupCode: boolean
    publicAdmin?: boolean
  },
) {
  const { db, now } = deps
  const control = controls(deps, 'admin')

  /** Refuses a loosening by the admin token; audited, and the owner hears of it as an attack. */
  function refuse(agentId: string, fields: string[]): never {
    repo.audit(
      db,
      { event: 'admin_loosen_refused', agentId, detail: { fields, via: 'admin' } },
      now(),
    )
    alert(deps, {
      kind: 'admin_loosen_refused',
      detail: `the admin token tried to loosen ${agentId} (${fields.join(', ')}); refused`,
    })
    throw new HttpError(403, 'loosen_in_panel')
  }

  /**
   * With SETUP_CODE set, the first passkey comes only from the setup code: an admin token that
   * enrolled it would own the deployment. Refused, audited and alerted like a loosening.
   */
  function firstPasskeyBySetupCode() {
    if (!setup.setupCode || countPasskeys(db) > 0) {
      return
    }
    repo.audit(db, { event: 'admin_enrol_refused', detail: { via: 'admin' } }, now())
    alert(deps, {
      kind: 'admin_loosen_refused',
      detail:
        'the admin token tried to enrol the first passkey; refused, the setup code is required',
    })
    throw new HttpError(403, 'use_setup_code')
  }

  function passkeyAddress() {
    if (setup.passkeyRpId === undefined || setup.passkeyOrigin === undefined) {
      throw new HttpError(409, 'passkeys_not_configured')
    }
    return { rpId: setup.passkeyRpId, origin: setup.passkeyOrigin }
  }

  return async (app: FastifyInstance) => {
    app.post('/agents', async (request) =>
      control.addAgent(newAgentRequest.parse(request.body).agentId),
    )

    app.get('/agents', async () => control.agents())

    app.post('/agents/:id/revoke', async (request) =>
      control.revokeAgent(agentRouteParam.parse(request.params).id, request.log),
    )

    // The passkey is bound to guard-core's public address, so enrolment needs it configured.
    app.post('/passkeys/options', async () => {
      firstPasskeyBySetupCode()
      const setup = passkeyAddress()
      return enrolmentOptions(db, setup, now())
    })

    // For enrolling from a phone through the public page: the code goes to the owner in a link.
    app.post('/passkeys/code', async () => {
      firstPasskeyBySetupCode()
      passkeyAddress()
      const issued = issueEnrolCode(db, now())
      repo.audit(
        db,
        { event: 'passkey_code_issued', detail: { expiresAt: issued.expiresAt } },
        now(),
      )
      return issued
    })

    // Only the first passkey: after that, a new one is vouched for by an enrolled one, on the
    // owner page, so a leaked admin token alone cannot add one.
    app.post('/passkeys', async (request) => {
      firstPasskeyBySetupCode()
      const { response } = passkeyEnrolment.parse(request.body)
      // The library checks the whole response; the schema only bounded its size and outer shape.
      const registration = response as unknown as RegistrationResponseJSON
      const enrolled = await enrol(db, passkeyAddress(), registration, now(), { firstOnly: true })
      if (!enrolled.ok) {
        throw refusal(enrolled.reason)
      }
      enrolledNotice(deps, enrolled.id, 'admin')
      return { enrolled: true }
    })

    app.get('/passkeys', async () => control.passkeys())

    app.get('/doctor', async () => control.doctor({ ...setup, fetch: deps.fetch }))

    app.get('/policy/:agentId', async (request) =>
      control.existing(agentIdParam.parse(request.params).agentId),
    )

    app.get('/budget/:agentId', async (request) =>
      control.budget(agentIdParam.parse(request.params).agentId),
    )

    app.get('/chains', async (request) => ({ chains: await control.chains(request.log) }))

    // A mandate lets an agent pay, so one opened with the admin token waits for the owner's
    // approval in the panel, like an agent's own (CR-022).
    app.post('/mandates', async (request, reply) =>
      mandateReply(reply, await openMandate(deps, mandateRequest.parse(request.body), false)),
    )

    app.post('/mandates/:id/revoke', async (request) => {
      const { id } = idParam.parse(request.params)
      const result = revokeMandate(db, id)
      if (!result.ok) {
        throw new HttpError(result.reason === 'not_found' ? 404 : 409, result.reason)
      }
      const { mandate } = result
      repo.audit(
        db,
        { event: 'mandate_revoked', agentId: mandate.agentId, detail: { mandateId: id } },
        now(),
      )
      return mandate
    })

    app.get('/report', async (request) => control.report(request.query))

    app.get('/receipts', async (request) => control.receipts(request.query))

    // CR-022: the admin token alone only tightens. Anything loosened() counts takes the owner's
    // passkey in the panel (CR-015), so a leaked admin token cannot widen what an agent may pay.
    app.put('/policy/:agentId', async (request) => {
      const { agentId } = agentIdParam.parse(request.params)
      const next = { agentId, ...policyBody.parse(request.body) }
      const before = control.existing(agentId)
      const fields = loosened(before, next)
      if (fields.length > 0) {
        refuse(agentId, fields)
      }
      return control.putPolicy(next)
    })

    app.post('/pause', async (request) =>
      control.setPaused(agentIdParam.parse(request.body).agentId, true),
    )
    // Resuming lets a stopped agent pay again.
    app.post('/resume', async (request) => {
      const { agentId } = agentIdParam.parse(request.body)
      control.existing(agentId)
      refuse(agentId, ['paused'])
    })

    app.post('/kill', async (request) => control.kill(request.log))

    await app.register(adminExecutions(deps))
  }
}
