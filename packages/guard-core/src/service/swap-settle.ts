import type { ChainAdapter } from '@defimind/onchain'
import type { PayIntent, SimulationResult } from '@defimind/shared'
import { listWallets } from '../db/wallets.js'
import { applyTrade, capPositions } from '../db/trades.js'
import { parseAmount } from '../domain/amount.js'
import { net } from '../domain/simulation.js'
import { finish, type PaymentDeps } from './payments.js'

/**
 * After the swap landed, the positions in its token are capped at what the hot wallet holds: the
 * fill can differ from the test run's (GC-66). A balance that cannot be read changes nothing.
 */
async function reconcile(
  deps: PaymentDeps,
  adapter: ChainAdapter,
  intent: PayIntent,
  token: string,
) {
  // With an agent's own wallet on the chain (CR-022) a token can sit in several wallets, and one
  // wallet's balance says nothing about the others': the booking then stands as simulated.
  if (listWallets(deps.db).some((w) => w.chain === intent.chain)) {
    return
  }
  try {
    const held = (await adapter.getPositions?.())?.find((p) => p.token === token)
    if (adapter.getPositions !== undefined) {
      const where = { chain: intent.chain, token, first: intent.agentId }
      capPositions(deps.db, where, parseAmount(held?.amount ?? '0'), deps.now())
    }
  } catch (error) {
    deps.log.warn({ err: error, intentId: intent.id }, 'positions not reconciled')
  }
}

/**
 * Signs the swap the adapter simulated, and books it at cost. What a buy brought in is the
 * simulation's tokenOut delta, which the adapter checked against the minimum before we got here.
 */
export async function settle(
  deps: PaymentDeps,
  adapter: ChainAdapter,
  intent: PayIntent,
  side: 'buy' | 'sell',
  simulation: SimulationResult,
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
  const position =
    side === 'buy'
      ? {
          token: details.tokenOut,
          amount: net(simulation, details.tokenOut),
          cost: parseAmount(intent.amount),
          decimals: details.decimalsOut,
          ...(details.symbolOut === undefined ? {} : { symbol: details.symbolOut }),
        }
      : {
          token: intent.token,
          amount: parseAmount(intent.amount),
          cost: 0n,
          decimals: details.decimalsIn,
          ...(details.symbolIn === undefined ? {} : { symbol: details.symbolIn }),
        }
  applyTrade(
    deps.db,
    { agentId: intent.agentId, chain: intent.chain, side, ...position },
    deps.now(),
  )
  await reconcile(deps, adapter, intent, position.token)
  return finish(deps, intent, { status: 'executed', txId })
}
