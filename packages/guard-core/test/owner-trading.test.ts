import { CHAINS, type TokenRisk } from '@defimind/shared'
import { describe, expect, it } from 'vitest'
import * as repo from '../src/db/repo.js'
import { CHAIN, harness, MINT as USDC } from './harness.js'
import { signedIn } from './owner.js'
import { BONK, trading, Venue } from './venue.js'

const MAINNET = CHAINS.solanaMainnet
const listed = [
  { id: BONK, symbol: 'FAKE', name: 'x'.repeat(500), decimals: 5, icon: 'https://evil/x.png' },
  { id: USDC, symbol: 'USDC', name: 'USD Coin', decimals: 6, isVerified: true, holderCount: 9.5 },
  { id: 'not a mint', symbol: 'BAD', name: 'bad', decimals: 6 },
]
const facts: Omit<TokenRisk, 'venue' | 'flags'> = {
  chain: CHAIN,
  mint: BONK,
  decimals: 5,
  freezeAuthority: false,
  mintAuthority: true,
  extensions: [],
  risks: [],
  exit: { amountUsd: '10000000', priceImpactBps: 40 },
}

async function setup(policy: object = {}) {
  const chain = new Venue()
  const h = await harness({ chain, policy: { trading, ...policy } })
  h.fetch.mockImplementation(async () => Response.json(listed))
  const owner = await signedIn(h)
  return { h, chain, owner }
}

const order = (extra: object = {}) => ({
  agentId: 'agent-1',
  chain: CHAIN,
  tokenIn: USDC,
  tokenOut: BONK,
  amountIn: '1000000',
  ...extra,
})

async function trade(owner: Awaited<ReturnType<typeof signedIn>>, minAmountOut = '995000000') {
  const { agentId, chain, tokenIn, tokenOut, amountIn } = order()
  const bound = { agentId, chain, tokenIn, tokenOut, amountIn, minAmountOut }
  return owner.call('POST', '/v1/owner/trade', {
    ...order(),
    minAmountOut,
    assertion: await owner.stepUp('manual_trade', bound),
  })
}

describe('token search (CR-025)', () => {
  const search = (q: string, chain: string = MAINNET) =>
    `/v1/owner/tokens/search?${new URLSearchParams({ q, chain })}`

  it("proxies Jupiter's search, verified first, bounded, and nothing else of the answer", async () => {
    const { h, owner } = await setup()
    const res = await owner.call('GET', search('bonk'))
    expect(res.statusCode).toBe(200)
    const tokens = res.json().tokens
    expect(tokens.map((t: { mint: string }) => t.mint)).toEqual([USDC, BONK])
    expect(tokens[0]).toEqual({
      chain: MAINNET,
      mint: USDC,
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      verified: true,
      venue: { holders: 9 },
    })
    expect(tokens[1].name).toHaveLength(64)
    expect(JSON.stringify(tokens)).not.toContain('evil')
    expect(String(h.fetch.mock.calls[0]?.[0])).toBe(
      'https://lite-api.jup.ag/tokens/v2/search?query=bonk',
    )
  })

  it('caches a query for a minute', async () => {
    const { h, owner } = await setup()
    await owner.call('GET', search('bonk'))
    await owner.call('GET', search('bonk'))
    expect(h.fetch).toHaveBeenCalledOnce()
  })

  it('allows 30 searches a minute per session', async () => {
    const { owner } = await setup()
    for (let i = 0; i < 30; i++) {
      expect((await owner.call('GET', search(`q${i}`))).statusCode).toBe(200)
    }
    const res = await owner.call('GET', search('one more'))
    expect(res.statusCode).toBe(429)
    expect(res.headers['retry-after']).toBeDefined()
  })

  it('searches Solana mainnet only, and needs a session', async () => {
    const { h, owner } = await setup()
    expect((await owner.call('GET', search('bonk', CHAIN))).json().error).toBe('not_tradable')
    expect((await owner.call('GET', search(''))).statusCode).toBe(400)
    expect((await h.app.inject({ url: search('bonk') })).statusCode).toBe(401)
  })

  it('answers 502 when Jupiter is down', async () => {
    const { h, owner } = await setup()
    h.fetch.mockImplementation(async () => new Response('', { status: 500 }))
    expect((await owner.call('GET', search('bonk'))).json().error).toBe('venue_unavailable')
  })
})

describe('the risk card (CR-025)', () => {
  const url = `/v1/owner/tokens/${BONK}/risk?chain=${encodeURIComponent(CHAIN)}`

  it('reads the facts onchain, adds the approval flags, and labels the venue', async () => {
    const { chain, owner } = await setup()
    Object.assign(chain, { tokenRisk: async () => facts })
    const risk = (await owner.call('GET', url)).json()
    expect(risk).toEqual({
      ...facts,
      flags: ['NEW_TOKEN', 'MINT_AUTHORITY'],
      venue: { verified: false },
    })
  })

  it('needs an adapter that reads it', async () => {
    const { owner } = await setup()
    expect((await owner.call('GET', url)).json().error).toBe('not_tradable')
  })
})

describe("the owner's quote and trade (CR-025)", () => {
  it("quotes under the agent's policy and records nothing", async () => {
    const { h, owner } = await setup()
    const res = await owner.call('POST', '/v1/owner/quote', order())
    expect(res.json()).toMatchObject({ minAmountOut: '995000000' })
    expect(repo.intentsBetween(h.db, new Date(0), new Date('2100-01-01'))).toEqual([])
    const nobody = await owner.call('POST', '/v1/owner/quote', order({ agentId: 'nobody' }))
    expect(nobody.statusCode).toBe(404)
  })

  it('always needs the passkey over the exact trade', async () => {
    const { owner } = await setup()
    const bare = await owner.call('POST', '/v1/owner/trade', { ...order(), minAmountOut: '1' })
    expect(bare.json().error).toBe('step_up_required')
    const other = await owner.call('POST', '/v1/owner/trade', {
      ...order(),
      minAmountOut: '1',
      assertion: await owner.stepUp('manual_trade', { ...order(), minAmountOut: '2' }),
    })
    expect(other.statusCode).toBe(401)
  })

  it("trades for the agent at once, through its pipeline, and counts in the agent's day", async () => {
    const { h, chain, owner } = await setup()
    const res = (await trade(owner)).json()
    expect(res).toMatchObject({ status: 'executed', rejectReasons: [] })
    expect(chain.sent[0]).toMatchObject({ reason: 'owner: manual trade', swap: { tokenOut: BONK } })
    expect(h.auditEvents()).toContain('owner_trade')
    const portfolio = (await h.agent('GET', '/v1/agent/portfolio/agent-1')).json()
    expect(portfolio.tradedToday).toBe('1000000')
  })

  it('refuses when the fresh quote promises less than the owner saw', async () => {
    const { chain, owner } = await setup()
    const res = (await trade(owner, '995000001')).json()
    expect(res).toMatchObject({ status: 'rejected', rejectReasons: ['SLIPPAGE_TOO_HIGH'] })
    expect(chain.sent).toEqual([])
  })

  it('refuses a paused agent, and shadows an agent in shadow mode', async () => {
    const paused = await setup({ paused: true })
    expect((await trade(paused.owner)).json().rejectReasons).toContain('PAUSED')
    const shadow = await setup({ mode: 'shadow' })
    const res = (await trade(shadow.owner)).json()
    expect(res.status).toBe('shadowed')
    expect(shadow.chain.sent).toEqual([])
  })
})
