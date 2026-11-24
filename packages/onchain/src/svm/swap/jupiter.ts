import { VersionedTransaction } from '@solana/web3.js'
import { z } from 'zod'

/** Jupiter's Swap API, v1. Untrusted: every answer is checked here, then again by the test run. */
export const JUPITER_API = 'https://lite-api.jup.ag/swap/v1'

/** Why a quote or a swap transaction could not be had: a 502 to guard-core, never a decision. */
export class SwapUnavailable extends Error {
  constructor(
    readonly code: 'venue_unavailable' | 'no_route',
    detail: string,
  ) {
    super(`${code}: ${detail}`)
    this.name = 'SwapUnavailable'
  }
}

const atomic = z.string().regex(/^\d{1,20}$/)
const quoteSchema = z
  .object({
    inputMint: z.string(),
    inAmount: atomic,
    outputMint: z.string(),
    outAmount: atomic,
    otherAmountThreshold: atomic,
    swapMode: z.literal('ExactIn'),
    slippageBps: z.number().int(),
    priceImpactPct: z.string().regex(/^-?\d+(\.\d+)?$/),
  })
  // The whole quote goes back to Jupiter to build the transaction, as Jupiter returned it.
  .passthrough()
export type JupiterQuote = z.infer<typeof quoteSchema>

export interface QuoteRequest {
  inputMint: string
  outputMint: string
  amount: bigint
  slippageBps: number
}

export interface Venue {
  quote(request: QuoteRequest): Promise<JupiterQuote>
  swap(quote: JupiterQuote, user: string): Promise<VersionedTransaction>
}

// Jupiter's own words for a pair it cannot route, from its error body.
const NO_ROUTE = /COULD_NOT_FIND_ANY_ROUTE|NO_ROUTES_FOUND|TOKEN_NOT_TRADABLE/

/**
 * The quote and the swap transaction, from Jupiter's HTTP API. Wrapped SOL stays wrapped, so the
 * transaction never closes an account of the hot wallet, and the priority fee is capped in the
 * request as well as checked in the transaction.
 */
export function jupiter(base = JUPITER_API, fetcher: typeof fetch = fetch): Venue {
  async function call(path: string, init?: RequestInit): Promise<unknown> {
    let response: Response
    try {
      response = await fetcher(`${base}${path}`, { ...init, signal: AbortSignal.timeout(10_000) })
    } catch (error) {
      throw new SwapUnavailable('venue_unavailable', String(error))
    }
    const body = await response.text()
    if (!response.ok) {
      const code = NO_ROUTE.test(body) ? 'no_route' : 'venue_unavailable'
      throw new SwapUnavailable(code, `${response.status} ${body.slice(0, 200)}`)
    }
    try {
      // eslint-disable-next-line no-restricted-properties -- every caller parses it with zod
      return JSON.parse(body)
    } catch {
      throw new SwapUnavailable('venue_unavailable', 'not JSON')
    }
  }

  return {
    async quote({ inputMint, outputMint, amount, slippageBps }) {
      const query = new URLSearchParams({
        inputMint,
        outputMint,
        amount: amount.toString(),
        slippageBps: String(slippageBps),
        swapMode: 'ExactIn',
        restrictIntermediateTokens: 'true',
      })
      const parsed = quoteSchema.safeParse(await call(`/quote?${query}`))
      if (!parsed.success) throw new SwapUnavailable('venue_unavailable', 'malformed quote')
      return parsed.data
    },

    async swap(quote, user) {
      const body = await call('/swap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: user,
          wrapAndUnwrapSol: false,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: {
            priorityLevelWithMaxLamports: { priorityLevel: 'medium', maxLamports: 500_000 },
          },
        }),
      })
      const parsed = z.object({ swapTransaction: z.string() }).safeParse(body)
      if (!parsed.success) throw new SwapUnavailable('venue_unavailable', 'malformed swap')
      try {
        return VersionedTransaction.deserialize(Buffer.from(parsed.data.swapTransaction, 'base64'))
      } catch {
        throw new SwapUnavailable('venue_unavailable', 'unreadable transaction')
      }
    },
  }
}
