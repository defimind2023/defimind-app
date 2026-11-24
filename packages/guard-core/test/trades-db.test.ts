import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { describe, expect, it } from 'vitest'
import { openDb, schema } from '../src/db/client.js'
import {
  addBought,
  applyTrade,
  boughtToday,
  everHeld,
  getPosition,
  listPositions,
} from '../src/db/trades.js'
import { CHAIN, NOW } from './harness.js'

const BONK = 'Bonk111111111111111111111111111111111111111'

function db() {
  const d = openDb(':memory:')
  migrate(d, { migrationsFolder: 'migrations' })
  for (const id of ['agent-1', 'agent-2']) {
    d.insert(schema.agents)
      .values({ id, name: id, tokenHash: id, createdAt: NOW.toISOString() })
      .run()
  }
  return d
}

const trade = (side: 'buy' | 'sell', amount: bigint, cost = 0n, agentId = 'agent-1') => ({
  agentId,
  chain: CHAIN,
  token: BONK,
  side,
  amount,
  cost,
  decimals: 5,
})

describe('the day of buys (CR-021)', () => {
  it('adds up per agent, chain and day', () => {
    const d = db()
    addBought(d, 'agent-1', CHAIN, '2026-11-24', '1000000')
    addBought(d, 'agent-1', CHAIN, '2026-11-24', '500000')
    addBought(d, 'agent-1', CHAIN, '2026-11-25', '7')
    addBought(d, 'agent-2', CHAIN, '2026-11-24', '9')
    expect(boughtToday(d, 'agent-1', CHAIN, '2026-11-24')).toBe(1_500_000n)
    expect(boughtToday(d, 'agent-1', 'solana:other', '2026-11-24')).toBe(0n)
  })
})

describe('positions at cost (CR-021)', () => {
  it('adds a buy at what it cost', () => {
    const d = db()
    applyTrade(d, trade('buy', 1000n, 10_000_000n), NOW)
    applyTrade(d, trade('buy', 1000n, 30_000_000n), NOW)
    expect(getPosition(d, 'agent-1', CHAIN, BONK)).toEqual({ amount: 2000n, cost: 40_000_000n })
  })

  it('takes the cost down in proportion to a sell, keeping the average price', () => {
    const d = db()
    applyTrade(d, trade('buy', 2000n, 40_000_000n), NOW)
    applyTrade(d, trade('sell', 500n), NOW)
    expect(getPosition(d, 'agent-1', CHAIN, BONK)).toEqual({ amount: 1500n, cost: 30_000_000n })
  })

  it('never goes below zero when more is sold than the agent bought', () => {
    const d = db()
    applyTrade(d, trade('buy', 100n, 1_000_000n), NOW)
    applyTrade(d, trade('sell', 500n), NOW)
    expect(getPosition(d, 'agent-1', CHAIN, BONK)).toEqual({ amount: 0n, cost: 0n })
    applyTrade(d, trade('sell', 5n, 0n, 'agent-2'), NOW)
    expect(getPosition(d, 'agent-2', CHAIN, BONK)).toEqual({ amount: 0n, cost: 0n })
  })

  it('remembers a token sold out, so its next buy is not new', () => {
    const d = db()
    expect(everHeld(d, CHAIN, BONK)).toBe(false)
    applyTrade(d, trade('buy', 100n, 1n), NOW)
    applyTrade(d, trade('sell', 100n), NOW)
    expect(everHeld(d, CHAIN, BONK)).toBe(true)
    expect(listPositions(d)).toEqual([])
  })

  it('lists open positions, for one agent or all', () => {
    const d = db()
    applyTrade(d, trade('buy', 100n, 1n), NOW)
    applyTrade(d, trade('buy', 7n, 2n, 'agent-2'), NOW)
    expect(listPositions(d, 'agent-2')).toEqual([
      { agentId: 'agent-2', chain: CHAIN, token: BONK, amount: '7', cost: '2', decimals: 5 },
    ])
    expect(listPositions(d)).toHaveLength(2)
  })
})
