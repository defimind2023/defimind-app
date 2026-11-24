import type { Position } from '@defimind/shared'
import type { Db } from '../db/client.js'
import { listAgents } from '../db/agents.js'
import * as repo from '../db/repo.js'
import { boughtTodayAll, listPositions } from '../db/trades.js'
import { toAmount } from '../domain/amount.js'

export interface Portfolio {
  positions: Position[]
  tradedToday: string
  dailyTradeMax: string
}

/** An agent's positions at cost and the day's trade budget (CR-021). */
export function portfolio(db: Db, agentId: string, now: Date): Portfolio {
  const day = repo.utcDay(now)
  return {
    positions: listPositions(db, agentId).map(({ agentId: _, ...position }) => position),
    tradedToday: toAmount(boughtTodayAll(db, agentId, day)),
    dailyTradeMax: repo.getPolicy(db, agentId)?.trading?.dailyTradeMax ?? '0',
  }
}

/** Every agent's, for the owner's panel. */
export function ownerPortfolio(db: Db, now: Date) {
  return {
    agents: listAgents(db).map(({ agentId }) => ({ agentId, ...portfolio(db, agentId, now) })),
  }
}
