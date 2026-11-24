import type { TradingPolicy } from '@defimind/shared'
import { describe, expect, it } from 'vitest'
import { schema } from '../src/db/client.js'
import { applyTrade, getPosition } from '../src/db/trades.js'
import { activateWallet, addWallet } from '../src/db/wallets.js'
import { hashToken } from '../src/domain/auth.js'
import { CHAIN, harness, MINT as USDC, NOW, wouldHave } from './harness.js'
import { signedIn } from './owner.js'
import { BONK, trading, Venue } from './venue.js'

async function setup(
  options: {
    trading?: Partial<TradingPolicy> | null
    mode?: 'live' | 'shadow'
    balance?: bigint
  } = {},
) {
  const chain = new Venue(options.balance)
  const policy = {
    ...(options.trading === null ? {} : { trading: { ...trading, ...options.trading } }),
    ...(options.mode === undefined ? {} : { mode: options.mode }),
  }
  const h = await harness({ chain, policy })
  // The first buy of a token goes to the owner; most cases here are about the rest.
  return { h, chain }
}

const buy = (amountIn = '1000000', extra: object = {}) => ({
  agentId: 'agent-1',
  chain: CHAIN,
  tokenIn: USDC,
  tokenOut: BONK,
  amountIn,
  reason: 'buy the dip',
  ...extra,
})

const sell = (amountIn: string) => ({ ...buy(amountIn), tokenIn: BONK, tokenOut: USDC })

async function bought(h: Awaited<ReturnType<typeof setup>>['h']) {
  const res = await h.agent('POST', '/v1/agent/swap', buy())
  const owner = await signedIn(h)
  await owner.call('POST', `/v1/owner/intents/${res.json().intentId}/decision`, {
    decision: 'approve',
    assertion: await owner.stepUp('approve_intent', { intentId: res.json().intentId }),
  })
  return owner
}

describe('swaps (CR-021)', () => {
  it('sends the first buy of a token to the owner, then executes it once approved', async () => {
    const { h, chain } = await setup()
    const res = await h.agent('POST', '/v1/agent/swap', buy())
    expect(res.json()).toMatchObject({ status: 'pending_approval', rejectReasons: [] })
    expect(chain.sent).toHaveLength(0)
    await bought(h)
    expect(chain.sent).toHaveLength(1)
    expect(getPosition(h.db, 'agent-1', CHAIN, BONK)).toEqual({
      amount: 995_000_000n,
      cost: 1_000_000n,
    })
  })

  it('executes a later buy of a known token without asking, and counts it as traded', async () => {
    const { h, chain } = await setup()
    await bought(h)
    const res = await h.agent('POST', '/v1/agent/swap', buy())
    expect(res.json()).toMatchObject({ status: 'executed', txId: 'stub-tx-2' })
    expect(chain.sent[1]).toMatchObject({ kind: 'swap', token: USDC, swap: { tokenOut: BONK } })
    const portfolio = (await h.agent('GET', '/v1/agent/portfolio/agent-1')).json()
    expect(portfolio.tradedToday).toBe('2000000')
  })

  it('counts buys against dailyTradeMax and never against dailyMax', async () => {
    const { h } = await setup({ trading: { dailyTradeMax: '1500000' } })
    await bought(h)
    const res = await h.agent('POST', '/v1/agent/swap', buy())
    expect(res.json()).toMatchObject({
      status: 'rejected',
      rejectReasons: ['TRADE_DAILY_EXCEEDED'],
    })
    const budget = (await h.agent('GET', '/v1/agent/budget/agent-1')).json()
    expect(JSON.stringify(budget)).not.toContain('1000000"')
  })

  it('sells without asking, reducing the position at cost', async () => {
    const { h } = await setup()
    await bought(h)
    const res = await h.agent('POST', '/v1/agent/swap', sell('497500000'))
    expect(res.json()).toMatchObject({ status: 'executed' })
    expect(getPosition(h.db, 'agent-1', CHAIN, BONK)).toEqual({
      amount: 497_500_000n,
      cost: 500_000n,
    })
  })

  it('books what landed, not what the test run promised (GC-66)', async () => {
    const { h, chain } = await setup()
    chain.landed = 994_000_000n
    await bought(h)
    expect(getPosition(h.db, 'agent-1', CHAIN, BONK)).toEqual({
      amount: 994_000_000n,
      cost: 1_000_000n,
    })
  })

  it('closes a position the wallet no longer holds', async () => {
    const { h, chain } = await setup()
    await bought(h)
    await h.agent('POST', '/v1/agent/swap', sell('10000000'))
    chain.held.set(BONK, 0n)
    await h.agent('POST', '/v1/agent/swap', sell('1000000'))
    expect(getPosition(h.db, 'agent-1', CHAIN, BONK)).toEqual({ amount: 0n, cost: 0n })
  })

  it('caps only the agents the sending wallet serves (CR-022)', async () => {
    const { h, chain } = await setup()
    await bought(h)
    h.db
      .insert(schema.agents)
      .values({
        id: 'agent-2',
        name: 'agent-2',
        tokenHash: hashToken('b'.repeat(40)),
        createdAt: NOW.toISOString(),
      })
      .run()
    addWallet(h.db, { agentId: 'agent-2', chain: CHAIN, address: 'own' }, NOW)
    activateWallet(h.db, 'agent-2', CHAIN)
    const theirs = { chain: CHAIN, token: BONK, amount: 5n, cost: 1n, decimals: 5 }
    applyTrade(h.db, { agentId: 'agent-2', side: 'buy', ...theirs }, NOW)
    chain.held.set(BONK, 0n)
    await h.agent('POST', '/v1/agent/swap', sell('1000000'))
    expect(getPosition(h.db, 'agent-1', CHAIN, BONK).amount).toBe(0n)
    expect(getPosition(h.db, 'agent-2', CHAIN, BONK).amount).toBe(5n)
  })

  describe('settled from what landed (CR-024)', () => {
    const landedBuy = [
      { token: USDC, delta: '-1000000' },
      { token: BONK, delta: '1100000000' },
    ]

    it('books a fill better than the test run as it landed', async () => {
      const { h, chain } = await setup()
      Object.assign(chain, { getLandedChanges: async () => landedBuy })
      await bought(h)
      expect(getPosition(h.db, 'agent-1', CHAIN, BONK)).toEqual({
        amount: 1_100_000_000n,
        cost: 1_000_000n,
      })
    })

    it('waits for an RPC that has not seen the transaction yet', async () => {
      const { h, chain } = await setup()
      let reads = 0
      Object.assign(chain, {
        getLandedChanges: async () => {
          reads += 1
          if (reads === 1) {
            throw new Error('tx_not_found: x')
          }
          return landedBuy
        },
      })
      await bought(h)
      expect(reads).toBe(2)
      expect(getPosition(h.db, 'agent-1', CHAIN, BONK).amount).toBe(1_100_000_000n)
    })

    it('falls back to the test run, capped at the wallet, when the read fails', async () => {
      const { h, chain } = await setup()
      chain.landed = 994_000_000n
      Object.assign(chain, {
        getLandedChanges: async () => {
          throw new Error('tx_failed: x')
        },
      })
      await bought(h)
      expect(getPosition(h.db, 'agent-1', CHAIN, BONK).amount).toBe(994_000_000n)
    })
  })

  it('marks nothing untested when the buy was tested before asking', async () => {
    const { h } = await setup()
    await h.agent('POST', '/v1/agent/swap', buy())
    const owner = await signedIn(h)
    const [asked] = (await owner.call('GET', '/v1/owner/overview')).json().pending
    expect(asked.untested).toBeUndefined()
    expect(asked.simulation.balanceChanges).not.toEqual([])
  })

  it('tops the hot wallet up for a buy before the test run', async () => {
    const { h, chain } = await setup({ balance: 0n })
    await bought(h)
    expect(chain.topUps).toEqual(['1000000'])
  })

  it('draws nothing for a buy waiting for the owner, and funds it once approved (GC-66)', async () => {
    const { h, chain } = await setup({ balance: 0n })
    const res = await h.agent('POST', '/v1/agent/swap', buy())
    expect(res.json()).toMatchObject({ status: 'pending_approval' })
    expect(chain.topUps).toEqual([])
    expect((await h.agent('GET', '/v1/agent/portfolio/agent-1')).json().tradedToday).toBe('0')
    const owner = await signedIn(h)
    const id = res.json().intentId
    const [asked] = (await owner.call('GET', '/v1/owner/overview')).json().pending
    expect(asked).toMatchObject({ untested: true, simulation: { balanceChanges: [] } })
    await owner.call('POST', `/v1/owner/intents/${id}/decision`, {
      decision: 'approve',
      assertion: await owner.stepUp('approve_intent', { intentId: id }),
    })
    expect(chain.topUps).toEqual(['1000000'])
    expect(chain.sent).toHaveLength(1)
  })

  it('leaves the vault untouched when the owner rejects a waiting buy (GC-66)', async () => {
    const { h, chain } = await setup({ balance: 0n })
    const id = (await h.agent('POST', '/v1/agent/swap', buy())).json().intentId
    const owner = await signedIn(h)
    await owner.call('POST', `/v1/owner/intents/${id}/decision`, { decision: 'reject' })
    expect(chain.topUps).toEqual([])
    expect(chain.sent).toEqual([])
  })

  it('refuses without trading, before asking the venue', async () => {
    const { h, chain } = await setup({ trading: null })
    const res = await h.agent('POST', '/v1/agent/swap', buy())
    expect(res.json()).toMatchObject({ status: 'rejected', rejectReasons: ['TRADING_DISABLED'] })
    expect(chain.quotes).toBe(0)
  })

  it('refuses a pair without the chain dollar on one side', async () => {
    const { h } = await setup()
    const res = await h.agent('POST', '/v1/agent/swap', { ...buy(), tokenIn: 'Wif1111111111111' })
    expect(res.json()).toMatchObject({ rejectReasons: ['TOKEN_NOT_TRADABLE'] })
  })

  it('refuses when the venue has no route, and answers 502 when it is down', async () => {
    const { h, chain } = await setup()
    chain.down = 'no_route'
    expect((await h.agent('POST', '/v1/agent/swap', buy())).json()).toMatchObject({
      rejectReasons: ['NO_EXIT_ROUTE'],
    })
    chain.down = 'venue_unavailable'
    const res = await h.agent('POST', '/v1/agent/swap', buy())
    expect(res.statusCode).toBe(502)
    expect(res.json()).toEqual({ error: 'venue_unavailable' })
  })

  it('refuses a test run that brings in less than the minimum', async () => {
    const { h, chain } = await setup()
    await bought(h)
    chain.received = 1n
    const res = await h.agent('POST', '/v1/agent/swap', buy())
    expect(res.json()).toMatchObject({ rejectReasons: ['SIM_UNEXPECTED_EFFECT'] })
  })

  it('paper trades in shadow: live quote, test run, nothing drawn or signed', async () => {
    const { h, chain } = await setup({ mode: 'shadow', balance: 0n })
    const res = await h.agent('POST', '/v1/agent/swap', buy())
    expect(res.json()).toMatchObject({ status: 'shadowed' })
    expect(chain.quotes).toBe(1)
    expect(chain.topUps).toEqual([])
    expect(chain.sent).toEqual([])
  })

  it('never signs in shadow, even with the dollar in the hot wallet and a clean test run', async () => {
    const { h, chain } = await setup({ mode: 'shadow' })
    const res = await h.agent('POST', '/v1/agent/swap', buy())
    expect(res.json()).toMatchObject({ status: 'shadowed' })
    expect(h.auditEvents(res.json().intentId)).toContain('simulated')
    expect(chain.sent).toEqual([])
    expect(chain.topUps).toEqual([])
  })

  it('records in shadow the flags and the approval live would have asked for (CR-024)', async () => {
    const { h } = await setup({ mode: 'shadow', balance: 0n })
    const id = (await h.agent('POST', '/v1/agent/swap', buy())).json().intentId
    expect(wouldHave(h, id)).toMatchObject({ wouldAsk: true, flags: ['NEW_TOKEN'] })
    const view = (await h.agent('GET', '/v1/agent/budget/agent-1')).json()
    expect(view.shadow.asked).toEqual({ count: 1, flags: ['NEW_TOKEN'] })
  })

  it('refuses a swap when the policy allows payments only inside a mandate', async () => {
    const chain = new Venue()
    const h = await harness({ chain, policy: { trading, requireMandate: true } })
    const res = await h.agent('POST', '/v1/agent/swap', buy())
    expect(res.json()).toMatchObject({ status: 'rejected', rejectReasons: ['MANDATE_REQUIRED'] })
    expect(chain.sent).toEqual([])
  })

  it('refuses an approved buy when the owner has since required mandates', async () => {
    const { h, chain } = await setup()
    const res = await h.agent('POST', '/v1/agent/swap', buy())
    const owner = await signedIn(h)
    const policy = (await owner.call('GET', '/v1/owner/policy/agent-1')).json()
    await owner.call('PUT', '/v1/owner/policy/agent-1', {
      policy: { ...policy, requireMandate: true },
    })
    const id = res.json().intentId
    const decided = await owner.call('POST', `/v1/owner/intents/${id}/decision`, {
      decision: 'approve',
      assertion: await owner.stepUp('approve_intent', { intentId: id }),
    })
    expect(decided.json()).toMatchObject({
      status: 'rejected',
      rejectReasons: ['MANDATE_REQUIRED'],
    })
    expect(chain.sent).toEqual([])
  })

  it('answers a quote read-only, and refuses it without trading', async () => {
    const { h } = await setup()
    const quote = await h.agent('POST', '/v1/agent/quote', buy())
    expect(quote.json()).toMatchObject({ venue: 'jupiter', minAmountOut: '995000000' })
    const off = await setup({ trading: null })
    expect((await off.h.agent('POST', '/v1/agent/quote', buy())).statusCode).toBe(403)
  })
})

describe('the owner Close (CR-021)', () => {
  it('needs the passkey, then sells every token, even with the agent paused', async () => {
    const { h, chain } = await setup()
    const owner = await bought(h)
    chain.held.set(BONK, 995_000_000n)
    await owner.call('POST', '/v1/owner/pause', { agentId: 'agent-1' })
    const none = await owner.call('POST', '/v1/owner/positions/close', {})
    expect(none.json()).toEqual({ error: 'step_up_required' })
    const res = await owner.call('POST', '/v1/owner/positions/close', {
      assertion: await owner.stepUp('close_positions', {}),
    })
    expect(res.json().intents).toEqual([
      expect.objectContaining({ kind: 'swap', token: BONK, status: 'executed' }),
    ])
    expect(getPosition(h.db, 'agent-1', CHAIN, BONK)).toEqual({ amount: 0n, cost: 0n })
  })

  it("sells the shared wallet's tokens as an agent that holds them there (CR-022)", async () => {
    const { h, chain } = await setup()
    const owner = await bought(h)
    h.db
      .insert(schema.agents)
      .values({
        id: 'agent-2',
        name: 'agent-2',
        tokenHash: hashToken('b'.repeat(40)),
        createdAt: NOW.toISOString(),
      })
      .run()
    addWallet(h.db, { agentId: 'agent-2', chain: CHAIN, address: 'own' }, NOW)
    activateWallet(h.db, 'agent-2', CHAIN)
    const theirs = { chain: CHAIN, token: BONK, amount: 2_000_000_000n, cost: 1n, decimals: 5 }
    applyTrade(h.db, { agentId: 'agent-2', side: 'buy', ...theirs }, NOW)
    chain.held.set(BONK, 995_000_000n)
    const res = await owner.call('POST', '/v1/owner/positions/close', {
      assertion: await owner.stepUp('close_positions', {}),
    })
    expect(res.json().intents).toEqual([expect.objectContaining({ agentId: 'agent-1' })])
    expect(getPosition(h.db, 'agent-2', CHAIN, BONK).amount).toBe(2_000_000_000n)
  })

  it('sells even when the policy requires mandates: Close is the owner own action', async () => {
    const { h, chain } = await setup()
    const owner = await bought(h)
    const policy = (await owner.call('GET', '/v1/owner/policy/agent-1')).json()
    await owner.call('PUT', '/v1/owner/policy/agent-1', {
      policy: { ...policy, requireMandate: true },
    })
    chain.held.set(BONK, 995_000_000n)
    const res = await owner.call('POST', '/v1/owner/positions/close', {
      assertion: await owner.stepUp('close_positions', {}),
    })
    expect(res.json().intents).toEqual([expect.objectContaining({ status: 'executed' })])
  })
})
