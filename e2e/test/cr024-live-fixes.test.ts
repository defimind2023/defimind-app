import { afterEach, describe, expect, it, vi } from 'vitest'
import { fork, MAINNET, programs, QUOTE, USDC, WSOL, type Fork } from './support/fork.js'
import { intentIdIn, stack, type Stack } from './support/stack.js'

/**
 * CR-024, on the mainnet fork: a buy that waits for the owner draws nothing from the vault until
 * approved, and is funded and test-run only then.
 */

const skipped = typeof programs === 'string' ? programs : undefined
if (skipped && process.env['FORK_REQUIRED'] === '1') throw new Error(`fork required: ${skipped}`)

let s: Stack
let f: Fork

afterEach(async () => {
  await s?.close()
})

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

describe.skipIf(skipped)(
  `a buy waiting for the owner${skipped ? ` (skipped: ${skipped})` : ''}`,
  () => {
    it('draws nothing until approved, then tops up, test-runs and lands', async () => {
      f = fork()
      f.setUsdc(0n)
      s = await stack({ chain: f.chain, net: MAINNET })
      s.clock.now = new Date()
      s.setPolicy({ trading })

      const text = await s.tool('swap', {
        from: 'USDC',
        to: WSOL.toBase58(),
        amountUsd: '1.00',
        chain: MAINNET.chain,
        reason: 'e2e: a first buy, with an empty hot wallet',
      })
      expect(text).toContain(': pending_approval.')
      expect(f.chain.topUps).toEqual([])
      expect(f.balance(USDC)).toBe(0n)

      const id = intentIdIn(text)
      await s.telegram.press(id, 'approve')
      await vi.waitFor(async () => expect((await s.intent(id)).status).toBe('executed'))
      expect(f.chain.topUps).toEqual([QUOTE.inAmount])
      expect(f.balance(USDC)).toBe(0n)
      expect(f.balance(WSOL)).toBeGreaterThanOrEqual(BigInt(QUOTE.otherAmountThreshold))
    })
  },
)
