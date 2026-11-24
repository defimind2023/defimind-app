import type { ProofBundle } from '@defimind/shared'
import type { FastifyInstance } from 'fastify'
import { anchorFor, anchorsBetween, hashesBetween } from '../db/anchors.js'
import { executionAt, executionsBetween } from '../db/executions.js'
import { merkleProof } from '../domain/merkle.js'
import type { PaymentDeps } from '../service/payments.js'
import { controls } from './control.js'
import { HttpError } from './errors.js'
import { executionsQuery, seqParam } from './schemas.js'

/** CR-013, for the panel: the timeline, the chain's health, and a proof for any receipt. */
export function ownerExecutions(deps: PaymentDeps) {
  const { db } = deps
  const control = controls(deps, 'panel')

  return async (app: FastifyInstance) => {
    app.get('/v1/owner/executions', async (request) => {
      const { agentId } = executionsQuery.parse(request.query)
      const { from, to } = control.period(request.query)
      return { receipts: executionsBetween(db, from, to, agentId) }
    })

    // Checked again on each request: the owner asks to know now, not as of this morning.
    app.get('/v1/owner/executions/integrity', async () => {
      if (deps.integrity === undefined) {
        throw new HttpError(404, 'receipts_not_configured')
      }
      return deps.integrity.check()
    })

    // A receipt under no anchor yet has no root to prove against.
    app.get('/v1/owner/executions/:seq/proof', async (request): Promise<ProofBundle> => {
      const { seq } = seqParam.parse(request.params)
      const receipt = executionAt(db, seq)
      const anchor = anchorFor(db, seq)
      if (receipt === undefined || anchor === undefined) {
        throw new HttpError(404, 'not_found')
      }
      const hashes = hashesBetween(db, anchor.fromSeq, anchor.toSeq)
      return { receipt, siblings: merkleProof(hashes, seq - anchor.fromSeq), anchor }
    })
  }
}

/** The same timeline for the operator's scripts, behind the admin token. */
export function adminExecutions(deps: PaymentDeps) {
  const control = controls(deps, 'admin')
  return async (app: FastifyInstance) => {
    app.get('/executions', async (request) => {
      const { from, to } = control.period(request.query)
      return { receipts: executionsBetween(deps.db, from, to) }
    })
  }
}

/** Public: the anchors alone, never a receipt, so anyone can check a bundle against them. */
export function publicAnchors(deps: PaymentDeps) {
  const control = controls(deps, 'admin')
  return async (app: FastifyInstance) => {
    app.get('/v1/anchors', async (request) => {
      const { from, to } = control.period(request.query)
      return { anchors: anchorsBetween(deps.db, from, to) }
    })
  }
}
