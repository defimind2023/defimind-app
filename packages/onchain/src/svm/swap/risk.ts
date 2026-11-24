import type { ChainId } from '@defimind/shared'
import { PublicKey, type Connection } from '@solana/web3.js'
import type { TokenRiskFacts } from '../../ChainAdapter.js'
import { SwapUnavailable, type Venue } from './jupiter.js'
import { mintFacts } from './mint.js'
import { checkQuote } from './quote.js'

/** 10 USD in the chain dollar's six decimals: the exit the risk card prices. */
const PROBE = 10_000_000n
const PROBE_SLIPPAGE_BPS = 100

/** The price impact of selling `amount` of a token back to the dollar, or null with no route. */
export async function exitImpact(
  venue: Venue,
  dollar: PublicKey,
  token: string,
  amount: bigint,
  slippageBps: number,
): Promise<number | null> {
  const request = { inputMint: token, outputMint: dollar.toBase58(), amount, slippageBps }
  try {
    return checkQuote(await venue.quote(request), request).priceImpactBps
  } catch (error) {
    if (error instanceof SwapUnavailable && error.code === 'no_route') return null
    throw error
  }
}

/**
 * The mint read from the chain, and what selling 10 USD worth of it would cost: the amount 10 USD
 * buys, quoted back to the dollar. A token with no buy route has no exit to price either.
 */
export async function tokenRisk(
  deps: { connection: Connection; dollar: PublicKey; venue: Venue; chain: ChainId },
  token: string,
): Promise<TokenRiskFacts> {
  const mint = new PublicKey(token)
  const facts = mintFacts(mint, await deps.connection.getAccountInfo(mint))
  const exit = await priceExit(deps, mint.toBase58())
  return {
    chain: deps.chain,
    mint: mint.toBase58(),
    decimals: facts.decimals,
    freezeAuthority: facts.freezeAuthority,
    mintAuthority: facts.mintAuthority,
    extensions: facts.extensions,
    risks: exit === null ? [...facts.risks, 'NO_EXIT_ROUTE'] : facts.risks,
    exit: exit === null ? null : { amountUsd: PROBE.toString(), priceImpactBps: exit },
  }
}

async function priceExit(deps: { dollar: PublicKey; venue: Venue }, token: string) {
  const buy = {
    inputMint: deps.dollar.toBase58(),
    outputMint: token,
    amount: PROBE,
    slippageBps: PROBE_SLIPPAGE_BPS,
  }
  let bought: bigint
  try {
    bought = checkQuote(await deps.venue.quote(buy), buy).expectedOut
  } catch (error) {
    if (error instanceof SwapUnavailable && error.code === 'no_route') return null
    throw error
  }
  return exitImpact(deps.venue, deps.dollar, token, bought, PROBE_SLIPPAGE_BPS)
}
