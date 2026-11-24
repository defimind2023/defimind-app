import type { Position, SwapQuote, TradingFlag } from '@defimind/shared'
import { z } from 'zod'

const atomic = z.string().regex(/^\d{1,40}$/)
const bps = z.number().int().min(0).max(10_000)
// Codes and flags are echoed to the model, so only well-formed ones get through.
const code = z.string().regex(/^[A-Z0-9_]{1,64}$/)
const flag = z.enum(['NEW_TOKEN', 'MINT_AUTHORITY']) satisfies z.ZodType<TradingFlag>
export const decimals = z.number().int().min(0).max(30)
// Untrusted display text: kept only to be quoted beside the mint, and only when it is plain.
export const symbol = z
  .string()
  .optional()
  .transform((value) =>
    value !== undefined && /^[A-Za-z0-9.$_-]{1,16}$/.test(value) ? value : undefined,
  )

export const swapQuote = z.object({
  venue: z.string().min(1).max(32),
  tokenIn: z.string().min(1).max(128),
  amountIn: atomic,
  tokenOut: z.string().min(1).max(128),
  expectedOut: atomic,
  minAmountOut: atomic,
  slippageBps: bps,
  priceImpactBps: bps,
  exitImpactBps: bps.nullable(),
  risks: z.array(code).max(32),
  flags: z.array(flag).max(8),
  quotedAt: z.iso.datetime({ offset: true }),
  decimalsIn: decimals,
  decimalsOut: decimals,
  symbolIn: symbol,
  symbolOut: symbol,
}) satisfies z.ZodType<Omit<SwapQuote, 'risks'> & { risks: string[] }>

export const portfolio = z.object({
  positions: z
    .array(
      z.object({
        chain: z.string().min(1),
        token: z.string().min(1).max(128),
        amount: atomic,
        cost: atomic,
        decimals,
        symbol,
      }) satisfies z.ZodType<Position>,
    )
    .max(500),
  tradedToday: atomic,
  dailyTradeMax: atomic,
})

/** Risks stay strings: a code this server does not know yet is still shown, not dropped. */
export type Quote = Omit<SwapQuote, 'risks'> & { risks: string[] }
export interface Portfolio {
  positions: Position[]
  tradedToday: string
  dailyTradeMax: string
}

/** The body of POST /v1/agent/quote and /v1/agent/swap, as the SPEC shapes them. */
export interface SwapInput {
  chain: string
  tokenIn: string
  tokenOut: string
  amountIn: string
  maxSlippageBps?: number
}

export interface SwapOrder extends SwapInput {
  reason: string
  mandateId?: string
}
