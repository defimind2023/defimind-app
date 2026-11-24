import type { ChainStatus, Policy } from '@defimind/shared'
import type { FastifyBaseLogger } from 'fastify'
import { createAgent, listAgents, revokeAgent } from '../db/agents.js'
import { clearWindow } from '../db/breaker.js'
import { listPasskeys } from '../db/passkeys.js'
import { receiptsBetween } from '../db/receipts.js'
import * as repo from '../db/repo.js'
import { summarise } from '../domain/report.js'
import { budget } from '../service/budget.js'
import { doctor, type DoctorDeps } from '../service/doctor.js'
import { killTransactions, type KillTransaction } from '../service/kill.js'
import type { PaymentDeps } from '../service/payments.js'
import { HttpError } from './errors.js'
import { REPORT_DEFAULT_SPAN_MS, REPORT_MAX_SPAN_MS, reportQuery } from './schemas.js'

type Log = Pick<FastifyBaseLogger, 'warn' | 'error'>

/**
 * What the operator's admin routes and the owner's panel both do, so the two cannot drift. `via`
 * goes into the audit, so the log says which door a change came through.
 */
export function controls(deps: PaymentDeps, via: 'admin' | 'panel' | 'bot') {
  const { db, now } = deps

  function existing(agentId: string) {
    const policy = repo.getPolicy(db, agentId)
    if (policy === undefined) {
      throw new HttpError(404, 'not_found')
    }
    return policy
  }

  return {
    existing,

    /**
     * A report or receipt period: the last seven days by default, a year at most. Checked once
     * both ends are known, so a lone `from` cannot ask for ten years.
     */
    period(query: unknown) {
      const parsed = reportQuery.parse(query)
      const to = parsed.to === undefined ? now() : new Date(parsed.to)
      const from =
        parsed.from === undefined
          ? new Date(to.getTime() - REPORT_DEFAULT_SPAN_MS)
          : new Date(parsed.from)
      if (from >= to || to.getTime() - from.getTime() > REPORT_MAX_SPAN_MS) {
        throw new HttpError(400, 'invalid_request')
      }
      return { from, to }
    },

    report(query: unknown) {
      const { from, to } = this.period(query)
      const intents = repo.intentsBetween(db, from, to)
      // A revoked agent is listed only for the window it was still active in.
      const revoked = repo.revokedAgentIds(db)
      const active = new Set(intents.map((intent) => intent.agentId))
      const ids = repo.agentIds(db).filter((id) => !revoked.has(id) || active.has(id))
      return { agents: summarise(ids, intents) }
    },

    // CR-006. A chain whose allowance cannot be read stays listed with null, like a kill payload:
    // the owner still has to see that the chain exists.
    async chains(log: Log): Promise<ChainStatus[]> {
      return Promise.all(
        [...deps.chains.values()].map(async (adapter): Promise<ChainStatus> => {
          try {
            return { chain: adapter.chain, allowance: await adapter.getAllowanceState() }
          } catch (error) {
            log.warn({ err: error, chain: adapter.chain }, 'allowance read failed')
            return { chain: adapter.chain, allowance: null }
          }
        }),
      )
    },

    receipts(query: unknown) {
      const { from, to } = this.period(query)
      return { receipts: receiptsBetween(db, from, to) }
    },

    agents: () => ({ agents: listAgents(db) }),

    // A new agent pays nothing: its policy denies everything and it starts in shadow mode.
    addAgent(agentId: string) {
      if (repo.agentExists(db, agentId)) {
        throw new HttpError(409, 'exists')
      }
      const token = createAgent(db, agentId, now())
      repo.audit(db, { event: 'agent_created', agentId, detail: { via } }, now())
      return { agentId, token }
    },

    /**
     * The token dies at once, but an own wallet's onchain limit does not (CR-022): its kill
     * transactions come back, to be signed.
     */
    async revokeAgent(id: string, log: Log) {
      const result = revokeAgent(db, id, now())
      if (result === 'not_found') {
        throw new HttpError(404, 'not_found')
      }
      if (result === 'revoked') {
        repo.audit(db, { event: 'agent_revoked', agentId: id, detail: { via } }, now())
      }
      const ownerTransactions = await killTransactions(deps, log, id)
      return ownerTransactions.length === 0
        ? { agentId: id, revoked: true }
        : {
            agentId: id,
            revoked: true,
            ownerTransactions,
            note: "Its own wallet's limit is still live until you sign these transactions.",
          }
    },

    budget: (agentId: string) => budget(deps, existing(agentId)),

    putPolicy(policy: Policy) {
      existing(policy.agentId)
      repo.putPolicy(db, policy, now().toISOString())
      // Read back, so the answer shows the fields this request left as they were.
      const stored = repo.getPolicy(db, policy.agentId)
      repo.audit(
        db,
        { event: 'policy_updated', agentId: policy.agentId, detail: { policy: stored, via } },
        now(),
      )
      return stored
    },

    setPaused(agentId: string, paused: boolean) {
      if (!repo.setPaused(db, agentId, paused, now().toISOString())) {
        throw new HttpError(404, 'not_found')
      }
      // A resumed agent starts a fresh minute: the payments that tripped the breaker are not
      // counted against it again.
      if (!paused) {
        clearWindow(db, agentId)
      }
      repo.audit(db, { event: paused ? 'paused' : 'resumed', agentId, detail: { via } }, now())
      return { agentId, paused }
    },

    // Pausing comes first and cannot fail on a chain: whatever happens to the owner transactions,
    // guard-core has stopped signing.
    async kill(log: Log) {
      const pausedAgents = repo.pauseAll(db, now().toISOString())
      const ownerTransactions = await killTransactions(deps, log)
      repo.audit(
        db,
        { event: 'killed', detail: { pausedAgents, chains: built(ownerTransactions), via } },
        now(),
      )
      deps.push?.kill()
      return { pausedAgents, ownerTransactions }
    },

    /** CR-022: one agent stops; only its own wallets' limits come off. */
    async killAgent(agentId: string, log: Log) {
      if (!repo.setPaused(db, agentId, true, now().toISOString())) {
        throw new HttpError(404, 'not_found')
      }
      const ownerTransactions = await killTransactions(deps, log, agentId)
      repo.audit(
        db,
        { event: 'agent_killed', agentId, detail: { chains: built(ownerTransactions), via } },
        now(),
      )
      return { pausedAgents: 1, ownerTransactions }
    },

    passkeys: () => ({
      passkeys: listPasskeys(db).map(({ id, createdAt, lastUsedAt }) => ({
        id,
        createdAt,
        lastUsedAt,
      })),
    }),

    doctor: async (setup: Pick<DoctorDeps, 'fetch' | 'botUrl' | 'databaseUrl'>) => ({
      checks: await doctor({ ...deps, ...setup, passkeyAbove: deps.passkey?.above }),
    }),
  }
}

const built = (txs: KillTransaction[]) =>
  txs.map((tx) => ({ chain: tx.chain, built: tx.payload !== null, agentId: tx.wallet?.agentId }))
