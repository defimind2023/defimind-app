import { randomUUID } from 'node:crypto'

type Body = Record<string, unknown> | undefined

/**
 * The CR-021 agent routes, shaped as the SPEC says and nothing more: a fixed price of 50 units of
 * any token per dollar, 1% slippage, and a policy that allows only `tradable` and buys under $20.
 * A quote for a token not held yet carries NEW_TOKEN. Unlike guard-core, which sends such a buy to
 * the owner, the mock only holds back buys of $10 or more, so a demo can trade without an owner.
 */
export function tradingRoutes(options: { usd: string; tradable: string[]; now: () => Date }) {
  const held = new Map<string, { amount: bigint; cost: bigint }>()
  let tradedToday = 0n
  const LIMIT = 20_000_000n

  function quote(body: Body) {
    const tokenIn = String(body?.['tokenIn'])
    const tokenOut = String(body?.['tokenOut'])
    const amountIn = BigInt(String(body?.['amountIn']))
    const buy = tokenIn === options.usd
    const expectedOut = buy ? amountIn * 50n : amountIn / 50n
    return {
      venue: 'jupiter',
      tokenIn,
      amountIn: amountIn.toString(),
      tokenOut,
      expectedOut: expectedOut.toString(),
      minAmountOut: ((expectedOut * 99n) / 100n).toString(),
      slippageBps: 100,
      priceImpactBps: 10,
      exitImpactBps: buy ? 12 : null,
      risks: [],
      flags: buy && !held.has(tokenOut) ? ['NEW_TOKEN'] : [],
      quotedAt: options.now().toISOString(),
      decimalsIn: 6,
      decimalsOut: 6,
    }
  }

  function swap(body: Body) {
    const priced = quote(body)
    const buy = priced.tokenIn === options.usd
    const token = buy ? priced.tokenOut : priced.tokenIn
    const amountIn = BigInt(priced.amountIn)
    const reasons = [
      ...(options.tradable.includes(token) ? [] : ['TOKEN_NOT_TRADABLE']),
      ...(buy && tradedToday + amountIn > LIMIT ? ['TRADE_DAILY_EXCEEDED'] : []),
    ]
    if (reasons.length > 0) {
      return { intentId: randomUUID(), status: 'rejected', rejectReasons: reasons }
    }
    if (buy && amountIn >= 10_000_000n) {
      return { intentId: randomUUID(), status: 'pending_approval', rejectReasons: [] }
    }
    const position = held.get(token) ?? { amount: 0n, cost: 0n }
    if (buy) {
      tradedToday += amountIn
      held.set(token, {
        amount: position.amount + BigInt(priced.expectedOut),
        cost: position.cost + amountIn,
      })
    } else {
      held.set(token, { ...position, amount: position.amount - amountIn })
    }
    return {
      intentId: randomUUID(),
      status: 'executed',
      txId: `mock-${randomUUID()}`,
      rejectReasons: [],
    }
  }

  /** Returns undefined for a path these routes do not serve. */
  return (
    method: string,
    path: string,
    body: Body,
    chain: string,
  ): [number, unknown] | undefined => {
    if (method === 'POST' && path === '/v1/agent/quote') {
      return [200, quote(body)]
    }
    if (method === 'POST' && path === '/v1/agent/swap') {
      return [200, swap(body)]
    }
    if (method === 'GET' && path.startsWith('/v1/agent/portfolio/')) {
      const positions = [...held].map(([token, { amount, cost }]) => ({
        chain,
        token,
        amount: amount.toString(),
        cost: cost.toString(),
        decimals: 6,
      }))
      return [
        200,
        { positions, tradedToday: tradedToday.toString(), dailyTradeMax: LIMIT.toString() },
      ]
    }
    return undefined
  }
}
