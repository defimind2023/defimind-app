import type { TokenRisk } from '@defimind/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { fork, MAINNET, programs, QUOTE, USDC, WSOL, type Fork } from './support/fork.js'
import { owner } from './support/owner.js'
import { stack, type Stack } from './support/stack.js'

/**
 * The trading path a new owner takes, on the mainnet fork, through the panel's own routes: read a
 * token's risk card, turn trading on and allow it with the passkey, watch a shadow buy, go live,
 * and trade by hand. The fork records one 1 USDC buy and no sell, so a second signed buy, a sell and
 * Close positions are covered elsewhere: an agent's live buy in cr021-trading, sells live onchain.
 */

const skipped = typeof programs === 'string' ? programs : undefined
if (skipped && process.env['FORK_REQUIRED'] === '1') throw new Error(`fork required: ${skipped}`)

let s: Stack
let f: Fork

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

const jupiter: typeof fetch = async (input, init) =>
  String(input).startsWith('https://lite-api.jup.ag/tokens/')
    ? Response.json([])
    : fetch(input, init)

afterEach(async () => {
  await s?.close()
})

describe.skipIf(skipped)(
  `a new owner's trading day${skipped ? ` (skipped: ${skipped})` : ''}`,
  () => {
    it('risk card, allow with passkey, a shadow buy, live, then a trade by hand', async () => {
      f = fork()
      s = await stack({ chain: f.chain, net: MAINNET, panel: true, fetch: jupiter })
      s.clock.now = new Date()
      s.setPolicy({ mode: 'shadow' })
      const panel = await owner(s)

      /** Saves the agent's policy as the panel does: a loosening needs the passkey over it. */
      async function save(change: object) {
        const current = (await panel.call('/v1/owner/policy/agent-1', {}, 'GET')).body
        const { agentId: _id, ...policy } = { ...current, ...change }
        const assertion = await panel.stepUp('loosen_policy', { agentId: 'agent-1', policy })
        const saved = await panel.call('/v1/owner/policy/agent-1', { policy, assertion }, 'PUT')
        expect(saved.status).toBe(200)
      }

      const card = await panel.call(
        `/v1/owner/tokens/${WSOL.toBase58()}/risk?chain=${MAINNET.chain}`,
        {},
        'GET',
      )
      expect((card.body as unknown as TokenRisk).flags).toEqual(['NEW_TOKEN'])

      await save({ trading })
      const buy = (reason: string) =>
        s.tool('swap', {
          from: 'USDC',
          to: WSOL.toBase58(),
          amountUsd: '1.00',
          chain: MAINNET.chain,
          reason,
        })
      expect(await buy('e2e: a shadow buy')).toContain(': shadowed.')
      const budget = await panel.call('/v1/owner/budget/agent-1', {}, 'GET')
      expect(budget.body['shadow']).toMatchObject({ asked: { count: 1, flags: ['NEW_TOKEN'] } })
      expect(f.chain.swapsSent).toEqual([])

      await save({ mode: 'live' })
      const order = {
        agentId: 'agent-1',
        chain: MAINNET.chain,
        tokenIn: USDC.toBase58(),
        tokenOut: WSOL.toBase58(),
        amountIn: QUOTE.inAmount,
        minAmountOut: QUOTE.otherAmountThreshold,
      }
      const assertion = await panel.stepUp('manual_trade', order)
      const byHand = await panel.call('/v1/owner/trade', { ...order, assertion })
      expect(byHand.body).toMatchObject({ status: 'executed' })
      expect(f.balance(WSOL)).toBeGreaterThanOrEqual(BigInt(QUOTE.otherAmountThreshold))
    })
  },
)
