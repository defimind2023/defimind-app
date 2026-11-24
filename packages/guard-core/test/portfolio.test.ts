import { describe, expect, it } from 'vitest'
import { addBought, applyTrade } from '../src/db/trades.js'
import { CHAIN, harness, NOW } from './harness.js'
import { signedIn } from './owner.js'

const BONK = 'Bonk111111111111111111111111111111111111111'
const trading = {
  enabled: true,
  venues: ['jupiter'],
  tokens: [BONK],
  allowAnyToken: false,
  maxTradeUsd: '10000000',
  dailyTradeMax: '25000000',
  maxPositionUsd: '20000000',
  maxSlippageBps: 100,
  maxPriceImpactBps: 300,
}

async function withTrades() {
  const h = await harness({ policy: { trading } })
  addBought(h.db, 'agent-1', CHAIN, '2026-11-03', '3000000')
  const buy = { agentId: 'agent-1', chain: CHAIN, token: BONK, side: 'buy' as const }
  applyTrade(h.db, { ...buy, amount: 500n, cost: 3_000_000n, decimals: 5, symbol: 'BONK' }, NOW)
  return h
}

describe('the portfolio (CR-021)', () => {
  it('answers the agent its positions at cost and the day of buys', async () => {
    const h = await withTrades()
    expect((await h.agent('GET', '/v1/agent/portfolio/agent-1')).json()).toEqual({
      positions: [
        { chain: CHAIN, token: BONK, amount: '500', cost: '3000000', decimals: 5, symbol: 'BONK' },
      ],
      tradedToday: '3000000',
      dailyTradeMax: '25000000',
    })
  })

  it('answers no trade budget for an agent without trading', async () => {
    const h = await harness()
    expect((await h.agent('GET', '/v1/agent/portfolio/agent-1')).json()).toEqual({
      positions: [],
      tradedToday: '0',
      dailyTradeMax: '0',
    })
  })

  it('keeps one agent out of another agent portfolio', async () => {
    const h = await withTrades()
    expect((await h.agent('GET', '/v1/agent/portfolio/agent-2')).statusCode).toBe(403)
  })

  it('answers the owner every agent, behind the session', async () => {
    const h = await withTrades()
    expect((await h.app.inject({ url: '/v1/owner/portfolio' })).statusCode).toBe(401)
    const owner = await signedIn(h)
    const { agents } = (await owner.call('GET', '/v1/owner/portfolio')).json()
    expect(agents).toEqual([
      expect.objectContaining({ agentId: 'agent-1', tradedToday: '3000000' }),
    ])
  })
})
