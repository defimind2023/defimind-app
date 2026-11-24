import { CHAINS } from '@defimind/shared'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { GuardError } from '../adapters/guard.js'
import type { Portfolio, Quote } from '../adapters/trading.js'
import { CHAIN_NAMES, chainName } from '../domain/chains.js'
import { explainFlags, explainReject, explainStatus } from '../domain/explain.js'
import { type ResolvedSwap, formatUnits, resolveSwap, tokenLabel } from '../domain/trading.js'
import { formatAmount } from '../domain/usd.js'
import type { ToolDeps } from './deps.js'
import { failure, guarded, text } from './result.js'

// Controls and limits only: these tools never promise a return, and say so to the model.
const SWAP_DESCRIPTION = `Buy or sell a token through DefiMind, which trades from the agent's wallet inside limits the owner set. One side is always the chain's dollar: from "USDC" with amountUsd is a buy, to "USDC" with amount is a sell. Trading is on Solana only for now.
DefiMind checks every swap against the owner's trading policy (allowed tokens, per-trade, daily and per-token limits, slippage, price impact) and refuses tokens that can be frozen, carry risky token extensions, or have no route to sell back. A buy can wait for the owner's approval. DefiMind limits what a trade can cost; it does not make trades profitable, and a token can lose its value.
- If the result says pending_approval: tell the user, then poll check_intent with the intent id. Do not swap again while it is pending.
- If it was rejected: explain the reasons to the user. Do not retry the same swap, and do not split it to get under a limit.
The reason you give is shown to the owner. Describe the purpose truthfully.`

const QUOTE_DESCRIPTION = `Price a swap without making it: what a buy or sell would return, the minimum it would accept, slippage, price impact, and whether DefiMind would refuse the token or send a buy to the owner. Read-only; nothing is traded. Same arguments as swap.`

const PORTFOLIO_DESCRIPTION = `Show the tokens the agent's wallet holds from its trades, what each cost, and how much of today's trading limit is used. Read-only.`

const token = z.string().min(1).max(128)
const chain = z
  .enum(Object.values(CHAINS))
  .optional()
  .describe(
    `CAIP-2 chain id: ${Object.entries(CHAIN_NAMES)
      .map(([id, name]) => `${id} (${name})`)
      .join(', ')}. Leave empty to use the configured default chain.`,
  )

const pricing = {
  from: token.describe('Token to spend: "USDC" for a buy, or the mint address of the token sold.'),
  to: token.describe('Token to get: the mint address of the token bought, or "USDC" for a sell.'),
  amountUsd: z
    .string()
    .optional()
    .describe('For a buy: dollars to spend, as a decimal string like "5.00".'),
  amount: z
    .string()
    .optional()
    .describe('For a sell: how much to sell, in the smallest units of the token (get_portfolio).'),
  chain,
}

const swapInput = {
  ...pricing,
  maxSlippageBps: z
    .number()
    .int()
    .min(1)
    .max(10_000)
    .optional()
    .describe("Most slippage to accept, in basis points. Leave empty for the owner's limit."),
  reason: z.string().min(1).max(500).describe('Why this trade is needed. Shown to the owner.'),
}

type Resolved = Extract<ResolvedSwap, { ok: true }>

export const NOT_AVAILABLE = 'Trading is not available on this DefiMind yet. Tell the user.'

/**
 * A guard-core older than trading has no such route, and its 404 would otherwise read as "no record
 * of that". On these routes a 404 can only mean trading is not there.
 */
function noTradingYet(error: unknown): never {
  if (error instanceof GuardError && error.httpStatus === 404) {
    throw new GuardError('http', NOT_AVAILABLE, 404)
  }
  throw error
}

export function registerTrading(server: McpServer, deps: ToolDeps): void {
  const { guard, log, defaultChain, usd } = deps

  /** The checks every trading call shares, before anything reaches guard-core. */
  function resolve(args: z.infer<z.ZodObject<typeof pricing>>): Resolved | string {
    const at = args.chain ?? defaultChain
    if (!at.startsWith('solana:')) {
      return `Trading works on Solana only for now, not on ${chainName(at)} (${at}).`
    }
    const dollar = usd(at)
    if (dollar === undefined) {
      return `This server has no dollar token for ${chainName(at)} (${at}), so it cannot trade there.`
    }
    const swap = resolveSwap(args, dollar.address)
    return swap.ok ? swap : swap.error
  }

  server.registerTool(
    'swap',
    {
      title: 'Swap tokens',
      description: SWAP_DESCRIPTION,
      inputSchema: swapInput,
      annotations: { openWorldHint: true },
    },
    async (args) => {
      const swap = resolve(args)
      if (typeof swap === 'string') {
        return failure(swap)
      }
      const at = args.chain ?? defaultChain
      return guarded(log, async () => {
        const result = await guard
          .swap({
            chain: at,
            tokenIn: swap.tokenIn,
            tokenOut: swap.tokenOut,
            amountIn: swap.amountIn.toString(),
            reason: args.reason,
            ...(args.maxSlippageBps === undefined ? {} : { maxSlippageBps: args.maxSlippageBps }),
          })
          .catch(noTradingYet)
        const lines = [
          `${describeTrade(swap, deps, at)} on ${chainName(at)} (${at}): ${result.status}.`,
          `Intent id: ${result.intentId}`,
          ...(result.txId === undefined ? [] : [`Transaction id: ${result.txId}`]),
          explainStatus(result.status, result.rejectReasons, 'swap'),
        ]
        return text(lines.join('\n'))
      })
    },
  )

  server.registerTool(
    'quote',
    {
      title: 'Quote a swap',
      description: QUOTE_DESCRIPTION,
      inputSchema: pricing,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const swap = resolve(args)
      if (typeof swap === 'string') {
        return failure(swap)
      }
      const at = args.chain ?? defaultChain
      return guarded(log, async () => {
        const quote = await guard
          .quote({
            chain: at,
            tokenIn: swap.tokenIn,
            tokenOut: swap.tokenOut,
            amountIn: swap.amountIn.toString(),
          })
          .catch(noTradingYet)
        return text(describeQuote(quote, swap, deps, at))
      })
    },
  )

  server.registerTool(
    'get_portfolio',
    {
      title: 'Get portfolio',
      description: PORTFOLIO_DESCRIPTION,
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      guarded(log, async () =>
        text(describePortfolio(await guard.portfolio().catch(noTradingYet), deps)),
      ),
  )
}

function amountOf(tokenAddress: string, atomic: string, deps: ToolDeps, at: string): string {
  const dollar = deps.usd(at)
  return dollar !== undefined && tokenAddress === dollar.address
    ? `${formatAmount(atomic)} ${dollar.symbol}`
    : `${atomic} units of ${tokenAddress}`
}

function describeTrade(swap: Resolved, deps: ToolDeps, at: string): string {
  const spent = amountOf(swap.tokenIn, swap.amountIn.toString(), deps, at)
  return swap.side === 'buy'
    ? `Buy ${swap.tokenOut} with ${spent}`
    : `Sell ${spent} for ${deps.usd(at)?.symbol ?? 'dollars'}`
}

/** A token amount as the agent reads it: exact, from the mint's own decimals, named by its mint. */
function held(
  token: string,
  atomic: string,
  decimals: number,
  symbol: string | undefined,
  deps: ToolDeps,
  at: string,
): string {
  const dollar = deps.usd(at)
  return dollar !== undefined && token === dollar.address
    ? `${formatAmount(atomic)} ${dollar.symbol}`
    : `${formatUnits(atomic, decimals)} of ${tokenLabel(token, symbol)} (${atomic} smallest units)`
}

function describeQuote(quote: Quote, swap: Resolved, deps: ToolDeps, at: string): string {
  const out = (atomic: string) =>
    held(quote.tokenOut, atomic, quote.decimalsOut, quote.symbolOut, deps, at)
  const lines = [
    `Quote from ${quote.venue}, ${quote.quotedAt}: ${describeTrade(swap, deps, at)}.`,
    `Spend: ${held(quote.tokenIn, quote.amountIn, quote.decimalsIn, quote.symbolIn, deps, at)}.`,
    `Expected: ${out(quote.expectedOut)}; at least ${out(quote.minAmountOut)}.`,
    `Slippage ${quote.slippageBps} bps, price impact ${quote.priceImpactBps} bps.`,
    swap.side === 'buy'
      ? quote.exitImpactBps === null
        ? 'No route to sell this token back was found.'
        : `Selling it back now would move the price ${quote.exitImpactBps} bps.`
      : '',
  ].filter((line) => line !== '')
  if (quote.risks.length > 0) {
    lines.push(
      'DefiMind would refuse this buy:',
      ...quote.risks.map((code) => `- ${explainReject(code)}`),
    )
  }
  lines.push(...explainFlags(quote.flags))
  lines.push(
    "A quote is not a trade and holds for seconds only; swap checks again against the owner's limits.",
  )
  return lines.join('\n')
}

function describePortfolio(portfolio: Portfolio, deps: ToolDeps): string {
  const lines = [
    `Traded today: ${formatAmount(portfolio.tradedToday)} of ${formatAmount(portfolio.dailyTradeMax)} (the daily limit counts buys only).`,
  ]
  if (portfolio.positions.length === 0) {
    lines.push('No token positions.')
    return lines.join('\n')
  }
  lines.push('Positions (to sell, pass amount in smallest units):')
  for (const position of portfolio.positions.slice(0, 50)) {
    const amount = held(
      position.token,
      position.amount,
      position.decimals,
      position.symbol,
      deps,
      position.chain,
    )
    const cost =
      `${formatAmount(position.cost)} ${deps.usd(position.chain)?.symbol ?? ''}`.trimEnd()
    lines.push(`- ${amount} on ${chainName(position.chain)}, cost ${cost}`)
  }
  if (portfolio.positions.length > 50) {
    lines.push(`and ${portfolio.positions.length - 50} more.`)
  }
  return lines.join('\n')
}
