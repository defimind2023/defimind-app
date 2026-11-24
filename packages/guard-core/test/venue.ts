import { type SimulationOutcome, SwapUnavailable } from '@defimind/onchain'
import type { PayIntent, SwapQuote, TradingPolicy } from '@defimind/shared'
import { StubChain } from '../src/adapters/stub.js'
import { CHAIN, MINT as USDC, NOW } from './harness.js'

export const BONK = 'Bonk111111111111111111111111111111111111111'
export const trading: TradingPolicy = {
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

/** A chain whose venue quotes 1 USDC = 1000 BONK, and whose test run gives what was quoted. */
export class Venue extends StubChain {
  quotes = 0
  down: 'venue_unavailable' | 'no_route' | undefined
  received: bigint | undefined
  held = new Map<string, bigint>()

  constructor(balance = 100_000_000n) {
    super(CHAIN, balance)
  }

  async quoteSwap(req: { tokenIn: string; tokenOut: string; amountIn: string }) {
    this.quotes += 1
    if (this.down !== undefined) {
      throw new SwapUnavailable(this.down, 'test venue')
    }
    const buy = req.tokenIn === USDC
    const out = buy ? BigInt(req.amountIn) * 1000n : BigInt(req.amountIn) / 1000n
    const quote: SwapQuote = {
      venue: 'jupiter',
      ...req,
      expectedOut: `${out}`,
      minAmountOut: `${(out * 995n) / 1000n}`,
      slippageBps: 50,
      priceImpactBps: 10,
      exitImpactBps: 12,
      risks: [],
      flags: [],
      quotedAt: NOW.toISOString(),
      decimalsIn: buy ? 6 : 5,
      decimalsOut: buy ? 5 : 6,
    }
    return quote
  }

  /** What the swap really brings in, when the market moved after its test run. */
  landed: bigint | undefined

  override async send(intent: PayIntent): Promise<string> {
    const tx = await super.send(intent)
    const swap = intent.swap
    if (swap !== undefined) {
      const bought = intent.token === USDC
      const token = bought ? swap.tokenOut : intent.token
      const before = this.held.get(token) ?? 0n
      const got = this.landed ?? this.received ?? BigInt(swap.minAmountOut)
      const left = bought ? before + got : before - BigInt(intent.amount)
      this.held.set(token, left > 0n ? left : 0n)
    }
    return tx
  }

  async getPositions() {
    return [...this.held].map(([token, amount]) => ({ token, amount: `${amount}`, decimals: 5 }))
  }

  override async simulate(intent: PayIntent): Promise<SimulationOutcome> {
    if (intent.swap === undefined) {
      return super.simulate(intent)
    }
    const got = this.received ?? BigInt(intent.swap.minAmountOut)
    return {
      simulation: {
        summary: `swaps ${intent.amount} of ${intent.token}`,
        balanceChanges: [
          { token: intent.token, delta: `-${intent.amount}` },
          { token: intent.swap.tokenOut, delta: `${got}` },
        ],
      },
      rejectReasons: [],
    }
  }
}
