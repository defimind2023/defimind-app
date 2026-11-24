import { CHAINS } from '@defimind/shared'
import { describe, expect, it, vi } from 'vitest'
import type { Quote, SwapOrder } from '../src/adapters/trading.js'
import { usdTokenFor } from '../src/domain/chains.js'
import { formatUnits, resolveSwap, tokenLabel } from '../src/domain/trading.js'
import { GuardError } from '../src/adapters/guard.js'
import { NOT_AVAILABLE } from '../src/tools/trading.js'
import { call, connect, fakeGuard } from './support.js'

const USDC = usdTokenFor(CHAINS.solanaDevnet, undefined)?.address ?? ''
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
const INTENT = '7d1e7c2a-3b4c-4d5e-8f60-718293a4b5c6'

describe('resolveSwap', () => {
  it('reads a buy from the dollar, by alias or by address', () => {
    for (const from of ['USDC', 'usd', '$', USDC]) {
      expect(resolveSwap({ from, to: BONK, amountUsd: '5' }, USDC)).toEqual({
        ok: true,
        side: 'buy',
        tokenIn: USDC,
        tokenOut: BONK,
        amountIn: 5_000_000n,
      })
    }
  })

  it('reads a sell into the dollar, in atomic units of the token sold', () => {
    expect(resolveSwap({ from: BONK, to: 'USDC', amount: '123456789' }, USDC)).toEqual({
      ok: true,
      side: 'sell',
      tokenIn: BONK,
      tokenOut: USDC,
      amountIn: 123_456_789n,
    })
  })

  it.each([
    [{ from: BONK, to: 'SOMEOTHERMINT', amountUsd: '1' }, "chain's dollar"],
    [{ from: 'USDC', to: 'usd', amountUsd: '1' }, "chain's dollar"],
    [{ from: 'USDC', to: BONK }, 'exactly one'],
    [{ from: 'USDC', to: BONK, amountUsd: '1', amount: '1' }, 'exactly one'],
    [{ from: 'USDC', to: BONK, amount: '1' }, 'A buy takes amountUsd'],
    [{ from: BONK, to: 'USDC', amountUsd: '1' }, 'A sell takes amount'],
    [{ from: BONK, to: 'USDC', amount: '0' }, 'A sell takes amount'],
    [{ from: BONK, to: 'USDC', amount: '1.5' }, 'A sell takes amount'],
    [{ from: 'USDC', to: BONK, amountUsd: '0' }, 'more than zero'],
    [{ from: 'USDC', to: BONK, amountUsd: '1e3' }, 'amountUsd:'],
  ])('refuses %j', (request, message) => {
    const result = resolveSwap(request, USDC)
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toContain(message)
  })
})

const quote: Quote = {
  venue: 'jupiter',
  tokenIn: USDC,
  amountIn: '5000000',
  tokenOut: BONK,
  expectedOut: '250000000',
  minAmountOut: '247500000',
  slippageBps: 100,
  priceImpactBps: 12,
  exitImpactBps: 15,
  risks: [],
  flags: [],
  quotedAt: '2026-11-24T16:00:00.000Z',
  decimalsIn: 6,
  decimalsOut: 5,
  symbolIn: 'USDC',
  symbolOut: 'BONK',
}

describe('swap tool', () => {
  it('buys with the chain dollar, in atomic units, and says what happened', async () => {
    const swap = vi.fn(async (_order: SwapOrder) => ({
      intentId: INTENT,
      status: 'executed' as const,
      txId: '5sig',
      rejectReasons: [],
    }))
    const client = await connect(fakeGuard({ swap }))
    const result = await call(client, 'swap', {
      from: 'USDC',
      to: BONK,
      amountUsd: '5',
      maxSlippageBps: 50,
      reason: 'rebalance',
    })
    expect(swap).toHaveBeenCalledWith({
      chain: CHAINS.solanaDevnet,
      tokenIn: USDC,
      tokenOut: BONK,
      amountIn: '5000000',
      maxSlippageBps: 50,
      reason: 'rebalance',
    })
    expect(result.isError).toBe(false)
    expect(result.text).toContain(`Buy ${BONK} with $5.00 USDC on Solana devnet`)
    expect(result.text).toContain(`Intent id: ${INTENT}`)
    expect(result.text).toContain("stays in the agent's wallet; get_portfolio shows it")
  })

  it('sells into the dollar and leaves maxSlippageBps to the owner when not given', async () => {
    const swap = vi.fn(async (_order: SwapOrder) => ({
      intentId: INTENT,
      status: 'pending_approval' as const,
      rejectReasons: [],
    }))
    const client = await connect(fakeGuard({ swap }))
    const result = await call(client, 'swap', {
      from: BONK,
      to: 'USDC',
      amount: '1000',
      reason: 'exit',
    })
    expect(swap.mock.calls[0]?.[0]).not.toHaveProperty('maxSlippageBps')
    expect(result.text).toContain(`Sell 1000 units of ${BONK} for USDC`)
    expect(result.text).toContain('The swap is waiting for the owner to approve it')
  })

  it('explains each trading refusal and what to do', async () => {
    const swap = vi.fn(async () => ({
      intentId: INTENT,
      status: 'rejected' as const,
      rejectReasons: ['TRADE_EXCEEDED', 'TOKEN_FREEZABLE'],
    }))
    const client = await connect(fakeGuard({ swap }))
    const { text } = await call(client, 'swap', {
      from: 'USDC',
      to: BONK,
      amountUsd: '500',
      reason: 'r',
    })
    expect(text).toContain(
      'The swap was rejected and nothing was traded. Do not retry the same swap.',
    )
    expect(text).toContain('- TRADE_EXCEEDED: the buy is above the per-trade limit')
    expect(text).toContain("- TOKEN_FREEZABLE: the token's issuer can still freeze holders' tokens")
    expect(text).toContain('Do not split the trade into smaller ones to get under the limit.')
    expect(text).toContain('Do not buy this token. Tell the user why it was refused.')
  })

  it('refuses before guard-core: a chain other than Solana, and a malformed request', async () => {
    const client = await connect(fakeGuard({}))
    const base = await call(client, 'swap', {
      from: 'USDC',
      to: BONK,
      amountUsd: '5',
      reason: 'r',
      chain: CHAINS.baseSepolia,
    })
    expect(base.isError).toBe(true)
    expect(base.text).toMatch(/Trading works on Solana only for now/)
    const both = await call(client, 'swap', { from: BONK, to: BONK, amountUsd: '5', reason: 'r' })
    expect(both.isError).toBe(true)
    expect(both.text).toContain("chain's dollar")
  })

  it('describes controls and limits, never returns', async () => {
    const client = await connect(fakeGuard({}))
    const { tools } = await client.listTools()
    for (const name of ['swap', 'quote', 'get_portfolio']) {
      const description = tools.find((tool) => tool.name === name)?.description ?? ''
      expect(description).not.toMatch(/profit(?!able)|earn|yield|guarantee|returns? on/i)
    }
    const swap = tools.find((tool) => tool.name === 'swap')?.description ?? ''
    expect(swap).toContain('it does not make trades profitable, and a token can lose its value')
  })
})

describe('quote tool', () => {
  it('prices a buy read-only, with the exit route, risks and flags explained', async () => {
    const quoteFn = vi.fn(async () => ({
      ...quote,
      exitImpactBps: null,
      risks: ['NO_EXIT_ROUTE'],
      flags: ['NEW_TOKEN' as const, 'MINT_AUTHORITY' as const],
    }))
    const client = await connect(fakeGuard({ quote: quoteFn }))
    const { text, isError } = await call(client, 'quote', {
      from: 'USDC',
      to: BONK,
      amountUsd: '5',
    })
    expect(isError).toBe(false)
    expect(quoteFn).toHaveBeenCalledWith({
      chain: CHAINS.solanaDevnet,
      tokenIn: USDC,
      tokenOut: BONK,
      amountIn: '5000000',
    })
    expect(text).toContain('Spend: $5.00 USDC.')
    expect(text).toContain(
      `Expected: 2500 of ${BONK} (calls itself "BONK") (250000000 smallest units); at least 2475 of ${BONK} (calls itself "BONK") (247500000 smallest units).`,
    )
    expect(text).toContain('Slippage 100 bps, price impact 12 bps.')
    expect(text).toContain('No route to sell this token back was found.')
    expect(text).toContain('DefiMind would refuse this buy:')
    expect(text).toContain('- NO_EXIT_ROUTE:')
    expect(text).toContain("A buy will wait for the owner's approval, because:")
    expect(text).toContain('- NEW_TOKEN: the first buy of this token')
    expect(text).toContain("- MINT_AUTHORITY: the token's issuer can still create more of it")
  })

  it('shows a sell in dollars and no exit line', async () => {
    const quoteFn = vi.fn(async () => ({
      ...quote,
      tokenIn: BONK,
      amountIn: '1000',
      tokenOut: USDC,
      expectedOut: '1990000',
      minAmountOut: '1970000',
    }))
    const client = await connect(fakeGuard({ quote: quoteFn }))
    const { text } = await call(client, 'quote', { from: BONK, to: 'USDC', amount: '1000' })
    expect(text).toContain('Expected: $1.99 USDC; at least $1.97 USDC.')
    expect(text).toContain(`Sell 1000 units of ${BONK} for USDC`)
    expect(text).not.toContain('sell this token back')
  })
})

describe('token amounts and names', () => {
  it('formats atomic units exactly, without a float', () => {
    expect(formatUnits('250000000', 5)).toBe('2500')
    expect(formatUnits('123456789012345678901', 9)).toBe('123456789012.345678901')
    expect(formatUnits('5', 6)).toBe('0.000005')
    expect(formatUnits('7', 0)).toBe('7')
  })

  it('names a token by its mint and quotes its symbol as a claim', () => {
    expect(tokenLabel(BONK)).toBe(BONK)
    expect(tokenLabel(BONK, 'BONK')).toBe(`${BONK} (calls itself "BONK")`)
  })
})

describe('get_portfolio tool', () => {
  it('lists positions at cost and the day trading budget', async () => {
    const portfolio = vi.fn(async () => ({
      positions: [
        {
          chain: CHAINS.solanaDevnet,
          token: BONK,
          amount: '250000000',
          cost: '5000000',
          decimals: 5,
          symbol: 'BONK',
        },
      ],
      tradedToday: '5000000',
      dailyTradeMax: '50000000',
    }))
    const client = await connect(fakeGuard({ portfolio }))
    const { text } = await call(client, 'get_portfolio')
    expect(text).toContain('Traded today: $5.00 of $50.00 (the daily limit counts buys only).')
    expect(text).toContain(
      `- 2500 of ${BONK} (calls itself "BONK") (250000000 smallest units) on Solana devnet, cost $5.00 USDC`,
    )
  })

  it('says when there is nothing held', async () => {
    const portfolio = vi.fn(async () => ({ positions: [], tradedToday: '0', dailyTradeMax: '0' }))
    const { text } = await call(await connect(fakeGuard({ portfolio })), 'get_portfolio')
    expect(text).toContain('No token positions.')
  })
})

describe('check_intent on a swap', () => {
  it('describes what was spent and the minimum it must return', async () => {
    const intent = vi.fn(async () => ({
      id: INTENT,
      kind: 'swap' as const,
      chain: CHAINS.solanaDevnet,
      token: USDC,
      amount: '5000000',
      recipient: 'HotWallet111',
      status: 'pending_approval' as const,
      rejectReasons: [],
      swap: {
        venue: 'jupiter',
        tokenOut: BONK,
        minAmountOut: '247500000',
        slippageBps: 100,
        priceImpactBps: 12,
        decimalsIn: 6,
        decimalsOut: 5,
        symbolIn: undefined,
        symbolOut: 'BONK',
      },
      createdAt: '2026-11-24T16:00:00.000Z',
      expiresAt: '2026-11-24T16:10:00.000Z',
    }))
    const { text } = await call(await connect(fakeGuard({ intent })), 'check_intent', {
      intentId: INTENT,
    })
    expect(text).toContain(
      `Swap of $5.00 USDC for at least 2475 of ${BONK} (calls itself "BONK") (247500000 smallest units) through jupiter, on Solana devnet`,
    )
    expect(text).toContain('The swap is waiting for the owner to approve it')
  })
})

describe('a guard-core without trading', () => {
  const missing = async (): Promise<never> => {
    throw new GuardError('http', 'AgentGuard has no record of that.', 404)
  }

  it.each([
    ['swap', { from: 'USDC', to: BONK, amountUsd: '5', reason: 'r' }],
    ['quote', { from: 'USDC', to: BONK, amountUsd: '5' }],
    ['get_portfolio', {}],
  ])('%s says trading is not available yet, not "no record"', async (tool, args) => {
    const client = await connect(fakeGuard({ swap: missing, quote: missing, portfolio: missing }))
    const result = await call(client, tool, args)
    expect(result.isError).toBe(true)
    expect(result.text).toBe(NOT_AVAILABLE)
  })

  it('keeps any other guard-core error as it was', async () => {
    const down = async (): Promise<never> => {
      throw new GuardError('http', 'AgentGuard returned an error (HTTP 500).', 500)
    }
    const result = await call(await connect(fakeGuard({ portfolio: down })), 'get_portfolio')
    expect(result.text).toBe('AgentGuard returned an error (HTTP 500).')
  })
})
