import type { AgentWalletStatus, ChainId } from '@defimind/shared'
import { and, eq } from 'drizzle-orm'
import type { Db } from './client.js'
import { agentWallets } from './schema.js'

export interface WalletRow {
  agentId: string
  chain: ChainId
  address: string
  status: AgentWalletStatus
}

const columns = {
  agentId: agentWallets.agentId,
  chain: agentWallets.chain,
  address: agentWallets.address,
  status: agentWallets.status,
}

/** Every agent's wallets, or one agent's. */
export function listWallets(db: Db, agentId?: string): WalletRow[] {
  return db
    .select(columns)
    .from(agentWallets)
    .where(agentId === undefined ? undefined : eq(agentWallets.agentId, agentId))
    .orderBy(agentWallets.agentId, agentWallets.chain)
    .all()
}

/** Kept if there is one already: a second request returns the first wallet, never a new key. */
export function addWallet(db: Db, row: Omit<WalletRow, 'status'>, now: Date): void {
  db.insert(agentWallets)
    .values({ ...row, status: 'pending_limit', createdAt: now.toISOString() })
    .onConflictDoNothing()
    .run()
}

export function activateWallet(db: Db, agentId: string, chain: ChainId): void {
  db.update(agentWallets)
    .set({ status: 'active' })
    .where(and(eq(agentWallets.agentId, agentId), eq(agentWallets.chain, chain)))
    .run()
}
