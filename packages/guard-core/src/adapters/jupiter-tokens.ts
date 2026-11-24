import type { ChainId, TokenInfo } from '@defimind/shared'
import { z } from 'zod'

export const JUPITER_TOKENS = 'https://lite-api.jup.ag/tokens/v2'
const TTL_MS = 60_000
const MAX_CACHED = 500
const MAX_RESULTS = 50

const bounded = (max: number) => z.string().transform((value) => value.slice(0, max))
const count = z.number().finite().nonnegative().optional().catch(undefined)

/**
 * What Jupiter answers, untrusted: every field not named here is dropped, strings are cut short,
 * and a field of the wrong shape is left out rather than failing the whole answer.
 */
const venueToken = z.object({
  id: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
  symbol: bounded(16),
  name: bounded(64),
  decimals: z.number().int().min(0).max(255),
  isVerified: z.boolean().optional().catch(undefined),
  holderCount: count,
  organicScore: count,
  liquidity: count,
  createdAt: z.iso.datetime({ offset: true }).optional().catch(undefined),
  firstPool: z
    .object({ createdAt: z.iso.datetime({ offset: true }).optional().catch(undefined) })
    .optional()
    .catch(undefined),
})

function info(chain: ChainId, token: z.infer<typeof venueToken>): TokenInfo {
  const createdAt = token.createdAt ?? token.firstPool?.createdAt
  return {
    chain,
    mint: token.id,
    symbol: token.symbol,
    name: token.name,
    decimals: token.decimals,
    verified: token.isVerified === true,
    venue: {
      ...(token.holderCount === undefined ? {} : { holders: Math.floor(token.holderCount) }),
      // toFixed writes 1e21 and up in exponent form, which no decimal reader takes: such a figure
      // is a lie anyway, so the field goes rather than the whole answer.
      ...(token.liquidity === undefined || token.liquidity >= 1e18
        ? {}
        : { liquidityUsd: token.liquidity.toFixed(2) }),
      ...(token.organicScore === undefined ? {} : { organicScore: token.organicScore }),
      ...(createdAt === undefined ? {} : { createdAt }),
    },
  }
}

/**
 * Jupiter's token search for the owner's panel (CR-025), cached for a minute per query. Verified
 * tokens first. An answer that is not a list, or a venue that is down, throws.
 */
export function jupiterTokens(fetchImpl: typeof fetch, now: () => number = Date.now) {
  const cache = new Map<string, { at: number; tokens: TokenInfo[] }>()

  return async function search(chain: ChainId, query: string): Promise<TokenInfo[]> {
    const key = `${chain}\n${query}`
    const hit = cache.get(key)
    if (hit !== undefined && now() - hit.at < TTL_MS) {
      return hit.tokens
    }
    const url = `${JUPITER_TOKENS}/search?${new URLSearchParams({ query })}`
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) {
      throw new Error(`token search answered ${res.status}`)
    }
    const listed = z
      .array(z.unknown())
      .max(1_000)
      .parse(await res.json())
    const tokens = listed
      .flatMap((entry) => {
        const parsed = venueToken.safeParse(entry)
        return parsed.success ? [info(chain, parsed.data)] : []
      })
      .sort((a, b) => Number(b.verified) - Number(a.verified))
      .slice(0, MAX_RESULTS)
    if (cache.size >= MAX_CACHED) {
      cache.clear()
    }
    cache.set(key, { at: now(), tokens })
    return tokens
  }
}

export type TokenSearch = ReturnType<typeof jupiterTokens>
