import { randomUUID } from 'node:crypto'
import { CHAINS, getAddress } from '@defimind/shared'

type Send = (status: number, data: unknown) => void
type Bound = { action: string; body: unknown } | undefined

export const MINT = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
/** An unverified copy: same symbol and name, another mint. */
export const FAKE = 'JUPfake1111111111111111111111111111111111111'
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
const HOT = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'

/**
 * CR-021's owner side as SPEC v0.16 words it: one buy waiting with both flags, what the agent
 * holds, and the close that sells it all, behind its own step-up.
 */
export function tradingMock(later: string) {
  const chain = CHAINS.solanaDevnet
  const usd = getAddress(chain, 'usd')!
  const intentId = randomUUID()
  const state = {
    positions: [
      { chain, token: MINT, amount: '1843920113', cost: '25000000', decimals: 6, symbol: 'JUP' },
      { chain, token: BONK, amount: '912000000000', cost: '10000000', decimals: 5 },
    ],
    closes: [] as Bound[],
    quotes: [] as Record<string, unknown>[],
    trades: [] as { body: Record<string, unknown>; bound: Bound }[],
  }
  const token = (mint: string, verified: boolean) => ({
    chain,
    mint,
    symbol: 'JUP',
    name: 'Jupiter',
    decimals: 6,
    verified,
    venue: verified ? { holders: 812000, liquidityUsd: '41250000.00', organicScore: 91 } : {},
  })
  const risk = (mint: string) => ({
    chain,
    mint,
    decimals: 6,
    freezeAuthority: false,
    mintAuthority: mint === FAKE,
    extensions: [],
    risks: mint === FAKE ? ['NO_EXIT_ROUTE'] : [],
    flags: ['NEW_TOKEN', ...(mint === FAKE ? ['MINT_AUTHORITY'] : [])],
    exit: mint === FAKE ? null : { amountUsd: '10000000', priceImpactBps: 8 },
    venue: { ...token(mint, mint !== FAKE).venue, verified: mint !== FAKE },
  })

  const intent = (token: string, amount: string, tokenOut: string, extra = {}) => ({
    id: randomUUID(),
    agentId: 'research-bot',
    kind: 'swap',
    chain,
    token,
    amount,
    recipient: HOT,
    reason: 'Momentum entry, 25 USDC',
    status: 'pending_approval',
    swap: {
      venue: 'jupiter',
      tokenOut,
      minAmountOut: '1843920113',
      slippageBps: 50,
      priceImpactBps: 12,
      quotedAt: later,
      decimalsIn: 6,
      decimalsOut: 6,
      symbolOut: 'JUP',
    },
    expiresAt: later,
    ...extra,
  })

  const pending = () => ({
    intent: intent(usd, '25000000', MINT, { id: intentId }),
    simulation: { summary: 'Spends 25 USDC; receives at least 1,843.920113 JUP.' },
    approveBefore: later,
    flags: ['NEW_TOKEN', 'MINT_AUTHORITY'],
  })

  function route(
    method: string,
    path: string,
    body: Record<string, unknown>,
    send: Send,
    stepUp: () => Bound,
  ): boolean {
    if (path === '/v1/owner/tokens/search') {
      send(200, { tokens: [token(FAKE, false), token(MINT, true)] })
      return true
    }
    const risky = /^\/v1\/owner\/tokens\/([^/]+)\/risk$/.exec(path)
    if (risky) {
      send(200, risk(decodeURIComponent(risky[1]!)))
      return true
    }
    if (method === 'POST' && path === '/v1/owner/quote') {
      state.quotes.push(body)
      const amountIn = String(body['amountIn'])
      send(200, {
        venue: 'jupiter',
        tokenIn: body['tokenIn'],
        amountIn,
        tokenOut: body['tokenOut'],
        expectedOut: '1853000000',
        minAmountOut: '1843920113',
        slippageBps: 50,
        priceImpactBps: 12,
        exitImpactBps: 9,
        risks: [],
        flags: ['NEW_TOKEN'],
        quotedAt: later,
      })
      return true
    }
    if (method === 'POST' && path === '/v1/owner/trade') {
      const bound = stepUp()
      if (bound?.action !== 'manual_trade') {
        send(403, { error: 'step_up_required' })
        return true
      }
      state.trades.push({ body, bound })
      send(200, { intentId: randomUUID(), status: 'executed', rejectReasons: [], txId: 'sig' })
      return true
    }
    if (method === 'GET' && path === '/v1/owner/portfolio') {
      send(200, {
        agents: [
          {
            agentId: 'research-bot',
            positions: state.positions,
            tradedToday: '35000000',
            dailyTradeMax: '100000000',
          },
        ],
      })
      return true
    }
    if (method === 'POST' && path === '/v1/owner/positions/close') {
      const bound = stepUp()
      if (bound?.action !== 'close_positions') {
        send(403, { error: 'step_up_required' })
        return true
      }
      state.closes.push(bound)
      const sells = state.positions.map((p) => {
        const sell = intent(p.token, p.amount, usd, {
          status: 'approved',
          reason: 'Owner closed positions',
        })
        return { ...sell, swap: { ...sell.swap, decimalsIn: p.decimals, symbolIn: p.symbol } }
      })
      state.positions = []
      send(200, { intents: sells })
      return true
    }
    return false
  }

  return { state, intentId, pending, route }
}
