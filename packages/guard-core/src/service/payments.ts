import type { ChainAdapter } from '@defimind/onchain'
import type { ApprovalFlag, ChainId, PayIntent, RejectCode } from '@defimind/shared'
import type { FastifyBaseLogger } from 'fastify'
import { randomUUID, type KeyObject } from 'node:crypto'
import type { BotNotifier } from '../adapters/bot.js'
import type { Db } from '../db/client.js'
import { admit } from '../db/breaker.js'
import { addMandateSpend, getMandate } from '../db/mandates.js'
import { getPin } from '../db/pins.js'
import { ownerApprovalMethod, saveClearance } from '../db/receipts.js'
import * as repo from '../db/repo.js'
import { parseAmount, toAmount } from '../domain/amount.js'
import { mandateReasons } from '../domain/mandate.js'
import { pinFlags } from '../domain/pinning.js'
import { evaluate } from '../domain/policy.js'
import { askOwner, expiresAt } from './approvals.js'
import { needsPasskey, type PasskeySetup } from './passkeys.js'
import { policyHash, recordExecuted } from './receipts.js'
import { simulate } from './simulate.js'
import { alert, notify } from './events.js'
import type { IntegrityMonitor } from './integrity.js'
import type { Pusher } from './push.js'
import type { Serial } from './serial.js'
import { adapterFor, type Wallets } from './wallets.js'

export interface PaymentDeps {
  db: Db
  chains: ReadonlyMap<ChainId, ChainAdapter>
  /** USDC per served chain, from chains.ts' usdcFor. */
  usdc: ReadonlyMap<ChainId, string>
  bot: BotNotifier
  now: () => Date
  serial: Serial
  log: Pick<FastifyBaseLogger, 'warn' | 'error'>
  /** Signs a receipt for every executed payment. Receipts are off without it. */
  receiptKey?: KeyObject
  /** Re-checks the execution chain (CR-013); there with the receipt key. */
  integrity?: IntegrityMonitor
  /** Web Push to the owner's panel (CR-012). Off without VAPID keys. */
  push?: Pusher
  /** Set when approvals at or above an amount need the owner's passkey. */
  passkey?: PasskeySetup
  /** The agents' own hot wallets (CR-022); without it every agent uses the shared one. */
  wallets?: Wallets
}

export type Terms = Pick<
  PayIntent,
  | 'agentId'
  | 'kind'
  | 'chain'
  | 'token'
  | 'amount'
  | 'recipient'
  | 'reason'
  | 'domain'
  | 'mandateId'
>

export function newIntent(terms: Terms, now: Date): PayIntent {
  // Rejected until something clears it: an intent that escapes the pipeline early stays denied.
  return {
    ...terms,
    id: randomUUID(),
    status: 'rejected',
    rejectReasons: [],
    createdAt: now.toISOString(),
    expiresAt: expiresAt(now),
  }
}

export type Clearance =
  | { cleared: false; intent: PayIntent }
  | { cleared: true; intent: PayIntent; adapter: ChainAdapter }

/**
 * Policy, then simulation, then the owner if the amount calls for it. Persists and audits whatever
 * it decides. `ownerApproved` answers the approval threshold and nothing else: the rest of the
 * policy and the simulation run again, because the owner may have paused the agent or the day's
 * budget may have gone since they pressed the button.
 */
export async function clear(
  deps: PaymentDeps,
  intent: PayIntent,
  ownerApproved: boolean,
): Promise<Clearance> {
  const { db, now } = deps
  repo.saveIntent(db, intent)
  // Read here, under the agent's lock, not when the request arrived: a pause, a kill or a tighter
  // policy must reach a payment that was already waiting its turn. No policy allows nothing.
  const policy = repo.getPolicy(db, intent.agentId)
  if (policy === undefined) {
    return { cleared: false, intent: reject(deps, intent, ['PAUSED']) }
  }
  const adapter = adapterFor(deps, intent.agentId, intent.chain)
  // In shadow nothing is spent, so the daily max is held against what would have been.
  const shadow = policy.mode === 'shadow'
  const day = repo.utcDay(now())
  const spent = shadow
    ? repo.shadowSpentToday(db, intent.agentId, day)
    : repo.spentToday(db, intent.agentId, day)
  const verdict = evaluate(intent, policy, spent)
  const reasons = [...verdict.reasons]
  const mandate = intent.mandateId === undefined ? undefined : getMandate(db, intent.mandateId)
  const required = policy.requireMandate
  for (const reason of mandateReasons(intent, mandate, required, now())) {
    if (!reasons.includes(reason)) {
      reasons.push(reason)
    }
  }
  if (adapter === undefined && !reasons.includes('CHAIN_NOT_ALLOWED')) {
    reasons.push('CHAIN_NOT_ALLOWED')
  }
  const pinned =
    intent.kind === 'x402' && intent.domain !== undefined
      ? getPin(db, intent.agentId, intent.domain)
      : undefined
  // The owner's approval has already answered a pin's question, so it is not asked again.
  const flags = ownerApproved ? [] : pinFlags(pinned, intent, policy.priceIncreaseMaxPct)
  repo.audit(
    db,
    {
      event: 'policy_evaluated',
      intentId: intent.id,
      agentId: intent.agentId,
      decision:
        reasons.length > 0 ? 'reject' : flags.length > 0 ? 'needs_approval' : verdict.decision,
      reasons,
      ...(flags.length > 0 ? { detail: { flags } } : {}),
    },
    now(),
  )
  if (adapter === undefined || reasons.length > 0) {
    return { cleared: false, intent: reject(deps, intent, reasons) }
  }

  const { simulation, reasons: simReasons, error } = await simulate(deps, adapter, intent)
  repo.audit(
    db,
    {
      event: 'simulated',
      intentId: intent.id,
      agentId: intent.agentId,
      reasons: simReasons,
      detail: { summary: simulation?.summary, error },
    },
    now(),
  )
  if (simulation === undefined || simReasons.length > 0) {
    return { cleared: false, intent: reject(deps, intent, simReasons) }
  }

  if (shadow) {
    const asks = verdict.decision === 'needs_approval' || flags.length > 0
    return { cleared: false, intent: shadowed(deps, intent, flags, asks) }
  }

  if ((verdict.decision === 'needs_approval' || flags.length > 0) && !ownerApproved) {
    const passkey = needsPasskey(deps.passkey, intent)
    const ask =
      flags.length > 0 && pinned !== undefined ? { flags, pinned, passkey } : { flags, passkey }
    return { cleared: false, intent: await askOwner(deps, intent, simulation, ask) }
  }

  // Last, so it counts only payments that are about to be signed.
  const limit = policy.maxPaymentsPerMinute
  if (!admit(db, intent, limit, now())) {
    return { cleared: false, intent: trip(deps, intent, limit) }
  }

  const approved: PayIntent = { ...intent, status: 'approved', rejectReasons: [] }
  repo.saveIntent(db, approved)
  saveClearance(db, {
    intentId: intent.id,
    policyHash: policyHash(policy),
    simulation: simulation.summary,
    approvedBy: ownerApproved ? (ownerApprovalMethod(db, intent.id) ?? 'owner') : 'policy',
  })
  return { cleared: true, intent: approved, adapter }
}

/** Shadow mode: everything up to the signature ran and passed. Nothing is sent or told to the bot. */
/**
 * Records what live would have done (CR-024): `wouldAsk` and the flags behind it, so the owner sees
 * "Live would have asked you" before switching the agent live.
 */
export function shadowed(
  deps: PaymentDeps,
  intent: PayIntent,
  flags: ApprovalFlag[],
  wouldAsk = flags.length > 0,
): PayIntent {
  const done: PayIntent = { ...intent, status: 'shadowed', rejectReasons: [] }
  repo.saveIntent(deps.db, done)
  repo.audit(
    deps.db,
    {
      event: 'shadowed',
      intentId: intent.id,
      agentId: intent.agentId,
      detail: {
        chain: intent.chain,
        amount: intent.amount,
        ...(flags.length > 0 ? { flags } : {}),
        wouldAsk,
      },
    },
    deps.now(),
  )
  return done
}

/**
 * More payments in a minute than the policy allows is how a looping or hijacked agent looks. The
 * agent stops until the owner resumes it, and the owner hears about it at once.
 */
export function trip(deps: PaymentDeps, intent: PayIntent, limit: number): PayIntent {
  repo.setPaused(deps.db, intent.agentId, true, deps.now().toISOString())
  repo.audit(
    deps.db,
    { event: 'breaker_tripped', intentId: intent.id, agentId: intent.agentId, detail: { limit } },
    deps.now(),
  )
  alert(deps, {
    kind: 'breaker_tripped',
    agentId: intent.agentId,
    detail: `more than ${limit} payments within a minute; the agent is paused until the owner resumes it`,
  })
  return reject(deps, intent, ['BREAKER_TRIPPED'])
}

export function reject(deps: PaymentDeps, intent: PayIntent, reasons: RejectCode[]): PayIntent {
  const rejected: PayIntent = { ...intent, status: 'rejected', rejectReasons: reasons }
  repo.saveIntent(deps.db, rejected)
  repo.audit(
    deps.db,
    {
      event: 'rejected',
      intentId: intent.id,
      agentId: intent.agentId,
      decision: 'reject',
      reasons,
    },
    deps.now(),
  )
  notify(deps, rejected)
  return rejected
}

/** Tops the hot wallet up by the shortfall. The onchain cap bounds what this can ever pull. */
export async function fund(deps: PaymentDeps, adapter: ChainAdapter, intent: PayIntent) {
  const balance = parseAmount(await adapter.getHotWalletBalance(intent.token))
  const amount = parseAmount(intent.amount)
  if (balance >= amount) {
    return
  }
  const shortfall = toAmount(amount - balance)
  const txId = await adapter.topUpHotWallet(shortfall)
  repo.audit(
    deps.db,
    {
      event: 'topped_up',
      intentId: intent.id,
      agentId: intent.agentId,
      detail: { chain: intent.chain, amount: shortfall, txId },
    },
    deps.now(),
  )
}

/**
 * Counted as soon as a signed transaction leaves our hands, whether or not we learn that it landed.
 * Overcounting only shrinks what the agent has left today; undercounting would let it past the max.
 */
export function recordSpend(deps: PaymentDeps, intent: PayIntent): void {
  repo.addSpend(deps.db, intent.agentId, intent.chain, repo.utcDay(deps.now()), intent.amount)
  if (intent.mandateId !== undefined) {
    addMandateSpend(deps.db, intent.mandateId, intent.amount)
  }
}

export function finish(
  deps: PaymentDeps,
  intent: PayIntent,
  outcome: { status: 'executed' | 'failed'; txId?: string; reasons?: RejectCode[] },
): PayIntent {
  const done: PayIntent = {
    ...intent,
    status: outcome.status,
    rejectReasons: outcome.reasons ?? [],
    ...(outcome.txId === undefined ? {} : { txId: outcome.txId }),
  }
  repo.saveIntent(deps.db, done)
  repo.audit(
    deps.db,
    {
      event: outcome.status,
      intentId: intent.id,
      agentId: intent.agentId,
      reasons: done.rejectReasons,
      detail: { chain: intent.chain, amount: intent.amount, txId: outcome.txId },
    },
    deps.now(),
  )
  if (done.status === 'executed') {
    recordExecuted(deps, done)
  }
  notify(deps, done)
  return done
}
