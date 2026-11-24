import type { ChainAdapter } from '@defimind/onchain'
import type { ChainId } from '@defimind/shared'
import type { Db } from '../db/client.js'
import { activateWallet, addWallet, listWallets, type WalletRow } from '../db/wallets.js'

/** Where an agent's key comes from and how its adapter is built: real files and RPCs, or a test's. */
export interface WalletKeys {
  /** The agent's key file on this chain, made once, and its public address. */
  ensure(agentId: string, chain: ChainId): Promise<{ file: string; address: string }>
  build(chain: ChainId, file: string): Promise<ChainAdapter>
}

const keyOf = (agentId: string, chain: ChainId) => `${agentId}\n${chain}`

/**
 * The agents' own hot wallets (CR-022). An agent with an active wallet on a chain pays only from
 * it: if its adapter is missing the payment is refused, never sent from the shared wallet, which
 * would undo the isolation the owner asked for.
 */
export class Wallets {
  private readonly adapters = new Map<string, ChainAdapter>()

  constructor(
    private readonly db: Db,
    private readonly keys: WalletKeys,
  ) {}

  /** Builds every stored wallet's adapter, so routing never waits on a key file or an RPC. */
  async load(): Promise<void> {
    for (const row of listWallets(this.db)) {
      await this.adapter(row)
    }
  }

  /** Undefined when the agent has no active wallet on the chain; `adapter` undefined refuses. */
  route(agentId: string, chain: ChainId): { adapter: ChainAdapter | undefined } | undefined {
    const row = listWallets(this.db, agentId).find((w) => w.chain === chain)
    return row?.status === 'active'
      ? { adapter: this.adapters.get(keyOf(agentId, chain)) }
      : undefined
  }

  async create(agentId: string, chain: ChainId, now: Date): Promise<WalletRow> {
    const { file, address } = await this.keys.ensure(agentId, chain)
    addWallet(this.db, { agentId, chain, address }, now)
    const row = this.row(agentId, chain)
    this.adapters.set(keyOf(agentId, chain), await this.keys.build(chain, file))
    return row
  }

  /**
   * The agent's wallets, a pending one turned active once its limit or allowance reads onchain.
   * A read that fails leaves it pending: the owner reloads.
   */
  async refresh(agentId: string): Promise<(WalletRow & { adapter: ChainAdapter })[]> {
    const rows = []
    for (const row of listWallets(this.db, agentId)) {
      const adapter = await this.adapter(row)
      if (row.status === 'pending_limit' && (await limited(adapter))) {
        activateWallet(this.db, agentId, row.chain)
        row.status = 'active'
      }
      rows.push({ ...row, adapter })
    }
    return rows
  }

  /** Every wallet with its adapter, pending ones included: a kill must reach them all. */
  async all(agentId?: string): Promise<(WalletRow & { adapter: ChainAdapter })[]> {
    const rows = listWallets(this.db, agentId)
    return Promise.all(rows.map(async (row) => ({ ...row, adapter: await this.adapter(row) })))
  }

  private row(agentId: string, chain: ChainId): WalletRow {
    const row = listWallets(this.db, agentId).find((w) => w.chain === chain)
    if (row === undefined) {
      throw new Error(`agent wallet not stored: ${agentId} on ${chain}`)
    }
    return row
  }

  private async adapter(row: WalletRow): Promise<ChainAdapter> {
    const key = keyOf(row.agentId, row.chain)
    const built = this.adapters.get(key)
    if (built !== undefined) {
      return built
    }
    const { file, address } = await this.keys.ensure(row.agentId, row.chain)
    // A key lost from disk comes back as a new one, which its onchain limit never named.
    if (address !== row.address) {
      throw new Error(`agent wallet key changed: ${row.agentId} on ${row.chain}`)
    }
    const adapter = await this.keys.build(row.chain, file)
    this.adapters.set(key, adapter)
    return adapter
  }
}

async function limited(adapter: ChainAdapter): Promise<boolean> {
  try {
    const state = await adapter.getAllowanceState()
    return state.status === 'active' && BigInt(state.cap) > 0n
  } catch {
    return false
  }
}

/** The adapter a payment, top-up or swap of this agent on this chain must use. */
export function adapterFor(
  deps: { chains: ReadonlyMap<ChainId, ChainAdapter>; wallets?: Wallets | undefined },
  agentId: string,
  chain: ChainId,
): ChainAdapter | undefined {
  const own = deps.wallets?.route(agentId, chain)
  return own === undefined ? deps.chains.get(chain) : own.adapter
}
