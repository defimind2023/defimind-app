import type { SwapQuote, TokenInfo, TokenRisk } from '@defimind/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { ATTACKER, fork, MAINNET, programs, QUOTE, USDC, WSOL, type Fork } from './support/fork.js'
import { owner } from './support/owner.js'
import { stack, type Stack } from './support/stack.js'

/**
 * CR-025 end to end, on the mainnet fork: the owner finds a token, reads its risk card, quotes, and
 * trades for an agent with the passkey. The trade runs the agent's own pipeline and policy, and the
 * token search is Jupiter's answer, untrusted.
 */

const skipped = typeof programs === 'string' ? programs : undefined
if (skipped && process.env['FORK_REQUIRED'] === '1') throw new Error(`fork required: ${skipped}`)

let s: Stack
let f: Fork
let panel: Awaited<ReturnType<typeof owner>>
const venue = { answer: [] as unknown[] }

const trading = {
  enabled: true,
  venues: ['jupiter'],
  tokens: [WSOL.toBase58()],
  allowAnyToken: false,
  maxTradeUsd: '10000000',
  dailyTradeMax: '25000000',
  maxPositionUsd: '20000000',
  maxSlippageBps: QUOTE.slippageBps,
  maxPriceImpactBps: 300,
}

/** Jupiter's token search, played here; every other request goes out as usual. */
const jupiter: typeof fetch = async (input, init) =>
  String(input).startsWith('https://lite-api.jup.ag/tokens/')
    ? Response.json(venue.answer)
    : fetch(input, init)

async function start() {
  f = fork()
  s = await stack({ chain: f.chain, net: MAINNET, panel: true, fetch: jupiter })
  s.clock.now = new Date()
  s.setPolicy({ trading })
  panel = await owner(s)
}

const order = {
  agentId: 'agent-1',
  chain: MAINNET.chain,
  tokenIn: USDC.toBase58(),
  tokenOut: WSOL.toBase58(),
  amountIn: QUOTE.inAmount,
}

async function trade(minAmountOut: string, signed = { ...order, minAmountOut }) {
  const assertion = await panel.stepUp('manual_trade', signed)
  return panel.call('/v1/owner/trade', { ...order, minAmountOut, assertion })
}

function untouched() {
  expect(f.chain.swapsSent).toEqual([])
  expect(f.balance(WSOL)).toBe(0n)
}

afterEach(async () => {
  await s?.close()
})

describe.skipIf(skipped)(
  `the owner's trading tools${skipped ? ` (skipped: ${skipped})` : ''}`,
  () => {
    describe('a manual trade', () => {
      it('quotes, then trades with the passkey, with no approval to wait for', async () => {
        await start()
        const quoted = await panel.call('/v1/owner/quote', order)
        const { minAmountOut } = quoted.body as unknown as SwapQuote
        expect(BigInt(minAmountOut)).toBeGreaterThanOrEqual(BigInt(QUOTE.otherAmountThreshold))
        expect(f.chain.swapsSent).toEqual([])

        const done = await trade(minAmountOut)
        expect(done.body).toMatchObject({ status: 'executed', rejectReasons: [] })
        expect(f.balance(WSOL)).toBeGreaterThanOrEqual(BigInt(minAmountOut))
        expect(s.telegram.approvalFor(String(done.body['intentId']))).toBeUndefined()
      })

      it('needs the passkey over the exact trade', async () => {
        await start()
        const bare = await panel.call('/v1/owner/trade', { ...order, minAmountOut: '1' })
        expect(bare.body).toEqual({ error: 'step_up_required' })
        const other = await trade(QUOTE.otherAmountThreshold, {
          ...order,
          amountIn: '1',
          minAmountOut: QUOTE.otherAmountThreshold,
        })
        expect(other.body).toEqual({ error: 'passkey_not_verified' })
        untouched()
      })

      it('refuses when the fresh quote no longer promises what the owner saw', async () => {
        await start()
        const done = await trade((BigInt(QUOTE.outAmount) * 2n).toString())
        expect(done.body).toMatchObject({
          status: 'rejected',
          rejectReasons: ['SLIPPAGE_TOO_HIGH'],
        })
        untouched()
      })

      it("stays inside the agent's policy: a token it may not trade, a paused agent", async () => {
        await start()
        s.setPolicy({ trading: { ...trading, tokens: [] } })
        const refused = await trade(QUOTE.otherAmountThreshold)
        expect(refused.body).toMatchObject({ rejectReasons: ['TOKEN_NOT_TRADABLE'] })

        s.setPolicy({ trading })
        await panel.call('/v1/owner/pause', { agentId: 'agent-1' })
        const paused = await trade(QUOTE.otherAmountThreshold)
        expect(paused.body).toMatchObject({ rejectReasons: ['PAUSED'] })
        untouched()
      })
    })

    describe('the token search and the risk card', () => {
      it("keeps the venue's answer to known fields, bounded, verified first", async () => {
        await start()
        venue.answer = [
          {
            id: ATTACKER.toBase58(),
            symbol: 'USDC'.padEnd(200, 'C'),
            name: 'x',
            decimals: 6,
            liquidity: 41250000.5,
          },
          {
            id: WSOL.toBase58(),
            symbol: 'SOL',
            name: 'Wrapped SOL',
            decimals: 9,
            isVerified: true,
            icon: 'https://attacker.example/pixel.png',
            liquidity: 'a lot',
          },
          { id: 'not a mint', symbol: 'BAD', name: 'bad', decimals: 6 },
        ]
        const found = await panel.call(
          '/v1/owner/tokens/search?q=sol&chain=' + MAINNET.chain,
          {},
          'GET',
        )
        const tokens = found.body['tokens'] as TokenInfo[]
        expect(tokens.map((t) => t.mint)).toEqual([WSOL.toBase58(), ATTACKER.toBase58()])
        expect(tokens[0]).toEqual({
          chain: MAINNET.chain,
          mint: WSOL.toBase58(),
          symbol: 'SOL',
          name: 'Wrapped SOL',
          decimals: 9,
          verified: true,
          venue: {},
        })
        expect(tokens[1]?.symbol).toHaveLength(16)
        // The panel reads it as display-only decimal dollars (#152), never as atomic units.
        expect(tokens[1]?.venue).toEqual({ liquidityUsd: '41250000.50' })
      })

      it('reads the facts onchain, and only labels what the venue claims', async () => {
        await start()
        f.patchMint(WSOL, { mintAuthority: ATTACKER })
        venue.answer = [
          { id: WSOL.toBase58(), symbol: 'SOL', name: 'SOL', decimals: 2, isVerified: true },
        ]
        const card = await panel.call(
          `/v1/owner/tokens/${WSOL.toBase58()}/risk?chain=${MAINNET.chain}`,
          {},
          'GET',
        )
        const risk = card.body as unknown as TokenRisk
        expect(risk).toMatchObject({ decimals: 9, mintAuthority: true, venue: { verified: true } })
        expect(risk.flags).toEqual(['NEW_TOKEN', 'MINT_AUTHORITY'])
      })
    })
  },
)
