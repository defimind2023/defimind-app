import type { ChainAdapter } from '@defimind/onchain'
import type { OwnerTransaction } from '@defimind/shared'
import type { FastifyBaseLogger } from 'fastify'
import type { PaymentDeps } from './payments.js'

/** An agent's own wallet carries its address, so the owner's link names that wallet's limit. */
export type KillTransaction = OwnerTransaction

type Source = { adapter: ChainAdapter; wallet?: { agentId: string; address: string } }

/**
 * The owner's transactions that remove every limit: the shared wallets' and the agents' own
 * (CR-022), or with `agentId` that agent's own wallets alone.
 */
export async function killTransactions(
  deps: PaymentDeps,
  log: Pick<FastifyBaseLogger, 'error'>,
  agentId?: string,
): Promise<KillTransaction[]> {
  const shared: Source[] =
    agentId === undefined ? [...deps.chains.values()].map((adapter) => ({ adapter })) : []
  const own: Source[] = ((await deps.wallets?.all(agentId)) ?? []).map((row) => ({
    adapter: row.adapter,
    wallet: { agentId: row.agentId, address: row.address },
  }))
  return Promise.all([...shared, ...own].map((source) => build(source, log)))
}

async function build(
  { adapter, wallet }: Source,
  log: Pick<FastifyBaseLogger, 'error'>,
): Promise<KillTransaction> {
  const chain = adapter.chain
  const whose = wallet === undefined ? '' : `${wallet.agentId}'s own wallet: `
  try {
    const tx = await adapter.buildKillTx()
    return { chain, ...tx, description: `${whose}${tx.description}`, ...(wallet && { wallet }) }
  } catch (error) {
    log.error({ err: error, chain, agentId: wallet?.agentId }, 'kill tx build failed')
    // The owner still has to act on this chain, so it stays in the list, saying so.
    return {
      chain,
      description: `${whose}Could not build the kill transaction for ${chain}. Remove the hot wallet's spend limit on this chain by hand.`,
      payload: null,
      ...(wallet && { wallet }),
    }
  }
}
