import type { ChainAdapter } from '@defimind/onchain'
import type { ChainId, PayIntent, Policy } from '@defimind/shared'
import { listAgents } from '../db/agents.js'
import * as repo from '../db/repo.js'
import { applyTrade, listPositions } from '../db/trades.js'
import { listWallets } from '../db/wallets.js'
import { evaluateTrade } from '../domain/trading.js'
import { newIntent, reject, type PaymentDeps } from './payments.js'
import { clearSwap, fetchQuote, VenueUnavailable, withQuote } from './swap.js'

const REASON = 'owner: close positions'

/**
 * The owner's Close (CR-021): every token the hot wallets hold goes back to the chain's dollar,
 * through the quote checks and the test run, even while the agents are paused. The hot wallet's
 * key never leaves guard-core, so this is the owner's only way out of a token. It sells at market:
 * price impact is not limited, slippage still is, so the sale cannot be sandwiched.
 */
export async function closePositions(deps: PaymentDeps): Promise<PayIntent[]> {
  const intents: PayIntent[] = []
  const shared = [...deps.chains.values()].map((adapter) => ({ adapter, agentId: undefined }))
  const own = (await deps.wallets?.all()) ?? []
  for (const { adapter: trader, agentId } of [...shared, ...own]) {
    const chain = trader.chain
    const dollar = deps.usdc.get(chain)
    if (trader.getPositions === undefined || dollar === undefined) {
      continue
    }
    for (const held of await trader.getPositions()) {
      if (held.token === dollar || held.amount === '0') {
        continue
      }
      const intent = await sell(deps, trader, { chain, dollar, ...held }, agentId)
      if (intent !== undefined) {
        intents.push(intent)
      }
    }
  }
  return intents
}

/**
 * One token, under the agent that holds most of it at cost, or the first agent when none bought it
 * (an airdrop): every intent belongs to an agent. Once sold, every agent's position in it is closed.
 * An agent's own wallet (CR-022) holds that agent's tokens alone, so its sale is `owner`'s.
 */
async function sell(
  deps: PaymentDeps,
  trader: ChainAdapter,
  held: { chain: ChainId; dollar: string; token: string; amount: string },
  owner?: string,
): Promise<PayIntent | undefined> {
  const { db, now } = deps
  // The shared wallet's tokens belong to the agents without an own wallet on this chain.
  const separate = new Set(
    listWallets(db)
      .filter((w) => w.chain === held.chain && w.status === 'active')
      .map((w) => w.agentId),
  )
  const holders = listPositions(db, owner)
    .filter((p) => p.chain === held.chain && p.token === held.token)
    .filter((p) => owner !== undefined || !separate.has(p.agentId))
    .sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1))
  const agentId = owner ?? holders[0]?.agentId ?? listAgents(db)[0]?.agentId
  const policy = agentId === undefined ? undefined : repo.getPolicy(db, agentId)
  if (agentId === undefined || policy === undefined) {
    return undefined
  }
  return deps.serial(agentId, async () => {
    const request = {
      agentId,
      chain: held.chain,
      tokenIn: held.token,
      tokenOut: held.dollar,
      amountIn: held.amount,
    }
    const intent = newIntent(
      {
        ...request,
        kind: 'swap',
        token: held.token,
        amount: held.amount,
        recipient: (await trader.getAllowanceState()).delegate,
        reason: REASON,
      },
      now(),
    )
    repo.saveIntent(db, intent)
    const slippage = policy.trading?.maxSlippageBps ?? 100
    let quote
    try {
      quote = await fetchQuote(trader, request, slippage)
    } catch (error) {
      if (error instanceof VenueUnavailable) {
        return reject(deps, intent, ['SIM_FAILED'])
      }
      throw error
    }
    if (quote === 'no_route') {
      return reject(deps, intent, ['NO_EXIT_ROUTE'])
    }
    const verdict = evaluateTrade(
      { side: 'sell', token: held.token, request, quote },
      closing(quote.venue, slippage),
      { tradedToday: 0n, positionCost: 0n, boughtBefore: true },
      now(),
    )
    repo.audit(
      db,
      {
        event: 'policy_evaluated',
        intentId: intent.id,
        agentId,
        decision: verdict.decision,
        reasons: verdict.reasons,
        detail: { side: 'sell', via: 'owner_close' },
      },
      now(),
    )
    if (verdict.reasons.length > 0) {
      return reject(deps, intent, verdict.reasons)
    }
    const priced = withQuote(intent, quote, held.dollar)
    if (priced === undefined) {
      return reject(deps, intent, ['SIM_UNEXPECTED_EFFECT'])
    }
    const how = { side: 'sell' as const, verdict, shadow: false, policy }
    const done = await clearSwap(deps, trader, priced, how, 'close')
    if (done.status === 'executed') {
      for (const holder of holders.filter((h) => h.agentId !== agentId)) {
        const { agentId: other, chain, token, amount, decimals } = holder
        const trade = { chain, token, amount: BigInt(amount), cost: 0n, decimals }
        applyTrade(db, { agentId: other, side: 'sell', ...trade }, now())
      }
    }
    return done
  })
}

/** The owner's own sale: any token, any size, at market, but never past the slippage limit. */
function closing(venue: string, maxSlippageBps: number): Policy {
  return {
    agentId: 'owner',
    chains: [],
    tokens: [],
    perTxMax: '0',
    dailyMax: '0',
    approvalThreshold: '0',
    allowedRecipients: [],
    allowedDomains: [],
    paused: false,
    trading: {
      enabled: true,
      venues: [venue],
      tokens: [],
      allowAnyToken: true,
      maxTradeUsd: '0',
      dailyTradeMax: '0',
      maxPositionUsd: '0',
      maxSlippageBps,
      maxPriceImpactBps: 10_000,
    },
  }
}
