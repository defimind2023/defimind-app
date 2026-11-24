import type { ChainAdapter } from '@defimind/onchain'
import type { BalanceChange, PayIntent, SimulationResult } from '@defimind/shared'
import { applyTrade, capPositions } from '../db/trades.js'
import { listWallets } from '../db/wallets.js'
import { parseAmount } from '../domain/amount.js'
import { net } from '../domain/simulation.js'
import { finish, type PaymentDeps } from './payments.js'

/** How long a confirmed transaction may take to become readable: RPCs lag the confirmation. */
export const LANDED_TRIES = 5
export const LANDED_WAIT_MS = 1_000

/**
 * What the swap really moved for the wallet that sent it (CR-024): read from the confirmed
 * transaction, retried while the RPC does not have it yet. Undefined when it cannot be read.
 */
async function landed(
  deps: PaymentDeps,
  adapter: ChainAdapter,
  txId: string,
  wait: (ms: number) => Promise<void>,
): Promise<BalanceChange[] | undefined> {
  if (adapter.getLandedChanges === undefined) {
    return undefined
  }
  for (let attempt = 1; ; attempt++) {
    try {
      return await adapter.getLandedChanges(txId)
    } catch (error) {
      const pending = error instanceof Error && error.message.startsWith('tx_not_found')
      if (!pending || attempt >= LANDED_TRIES) {
        deps.log.warn({ err: error, txId }, 'landed changes not read; booking the test run')
        return undefined
      }
      await wait(LANDED_WAIT_MS)
    }
  }
}

/**
 * Without the landed changes, the test run's booking is capped at what the sending wallet holds,
 * for the agents that wallet serves: the agent alone for its own wallet (CR-022), every agent
 * without one for the shared wallet. A balance that cannot be read changes nothing.
 */
async function reconcile(
  deps: PaymentDeps,
  adapter: ChainAdapter,
  intent: PayIntent,
  token: string,
) {
  if (adapter.getPositions === undefined) {
    return
  }
  const own = deps.wallets?.route(intent.agentId, intent.chain) !== undefined
  const separate = new Set(
    listWallets(deps.db)
      .filter((w) => w.chain === intent.chain && w.status === 'active')
      .map((w) => w.agentId),
  )
  const agents = own ? (id: string) => id === intent.agentId : (id: string) => !separate.has(id)
  try {
    const held = (await adapter.getPositions()).find((p) => p.token === token)
    const where = { chain: intent.chain, token, first: intent.agentId, agents }
    capPositions(deps.db, where, parseAmount(held?.amount ?? '0'), deps.now())
  } catch (error) {
    deps.log.warn({ err: error, intentId: intent.id }, 'positions not reconciled')
  }
}

/**
 * Signs the swap the adapter simulated, and books it at cost from what landed onchain: a fill
 * better or worse than the test run's is booked as it was. When the landed changes cannot be
 * read, the test run's figures are booked and capped at the wallet's balance.
 */
export async function settle(
  deps: PaymentDeps,
  adapter: ChainAdapter,
  intent: PayIntent,
  side: 'buy' | 'sell',
  simulation: SimulationResult,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms)),
): Promise<PayIntent> {
  const details = intent.swap
  if (details === undefined) {
    return finish(deps, intent, { status: 'failed' })
  }
  let txId: string
  try {
    txId = await adapter.send(intent)
  } catch (error) {
    deps.log.error({ err: error, intentId: intent.id }, 'swap send failed')
    return finish(deps, intent, { status: 'failed' })
  }
  const changes = await landed(deps, adapter, txId, wait)
  const moved: SimulationResult =
    changes === undefined ? simulation : { summary: 'landed', balanceChanges: changes }
  const spent = -net(moved, intent.token)
  const position =
    side === 'buy'
      ? {
          token: details.tokenOut,
          amount: net(moved, details.tokenOut),
          cost: spent > 0n ? spent : parseAmount(intent.amount),
          decimals: details.decimalsOut,
          ...(details.symbolOut === undefined ? {} : { symbol: details.symbolOut }),
        }
      : {
          token: intent.token,
          amount: spent > 0n ? spent : parseAmount(intent.amount),
          cost: 0n,
          decimals: details.decimalsIn,
          ...(details.symbolIn === undefined ? {} : { symbol: details.symbolIn }),
        }
  applyTrade(
    deps.db,
    { agentId: intent.agentId, chain: intent.chain, side, ...position },
    deps.now(),
  )
  if (changes === undefined) {
    await reconcile(deps, adapter, intent, position.token)
  }
  return finish(deps, intent, { status: 'executed', txId })
}
