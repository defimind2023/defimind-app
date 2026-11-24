import { SystemProgram, type VersionedTransaction } from '@solana/web3.js'
import { createApproveInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import type { Policy } from '@defimind/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ATTACKER,
  fork,
  HOT,
  MAINNET,
  programs,
  QUOTE,
  USDC,
  WSOL,
  type Fork,
} from './support/fork.js'
import { intentIdIn, stack, type Stack } from './support/stack.js'

/**
 * CR-021 end to end: an agent trades through MCP, guard-core decides, and onchain's real adapter
 * checks and signs, on a fork of mainnet that runs the real Jupiter and Whirlpool programs over a
 * recorded 1 USDC → wSOL route. The venue is the attacker here: every case below is a quote or a
 * transaction Jupiter could hand back, and each must end with nothing signed and no balance moved.
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
  // The recorded route was quoted at 50 bps; the venue answers only that.
  maxSlippageBps: QUOTE.slippageBps,
  maxPriceImpactBps: 300,
}

async function start(overrides: Partial<Policy> = {}) {
  f = fork()
  s = await stack({ chain: f.chain, net: MAINNET })
  // The adapter stamps quotes with the real time; guard-core must agree on what "now" is.
  s.clock.now = new Date()
  s.setPolicy({ trading, ...overrides })
}

const buy = () =>
  s.tool('swap', {
    from: 'USDC',
    to: WSOL.toBase58(),
    amountUsd: '1.00',
    chain: MAINNET.chain,
    reason: 'e2e: buy wSOL',
  })

/** The run ended with nothing signed: no swap sent and both balances where they started. */
function untouched() {
  expect(f.chain.swapsSent).toEqual([])
  expect(f.balance(USDC)).toBe(5_000_000n)
  expect(f.balance(WSOL)).toBe(0n)
}

async function rejected(codes: string[]) {
  const text = await buy()
  expect(text).toContain(': rejected.')
  for (const code of codes) expect(text).toContain(code)
  untouched()
}

/** The route's slippage_bps, three bytes from the end of its data, opened to 100%. */
function wideOpen(tx: VersionedTransaction) {
  const route = tx.message.compiledInstructions.find((ix) =>
    tx.message.staticAccountKeys[ix.programIdIndex]?.toBase58().startsWith('JUP6'),
  )!
  Buffer.from(route.data.buffer, route.data.byteOffset, route.data.length).writeUInt16LE(
    10_000,
    route.data.length - 3,
  )
  return tx
}

afterEach(async () => {
  await s?.close()
})

describe.skipIf(skipped)(
  `guarded trading on a fork of mainnet${skipped ? ` (skipped: ${skipped})` : ''}`,
  () => {
    describe('an honest route', () => {
      beforeEach(() => start())

      it('asks the owner for a first buy, then lands exactly what was checked', async () => {
        const text = await buy()
        expect(text).toContain(': pending_approval.')
        expect(f.chain.swapsSent).toEqual([])
        await s.telegram.press(intentIdIn(text), 'approve')
        await vi.waitFor(async () =>
          expect((await s.intent(intentIdIn(text))).status).toBe('executed'),
        )
        expect(f.balance(USDC)).toBe(5_000_000n - BigInt(QUOTE.inAmount))
        expect(f.balance(WSOL)).toBeGreaterThanOrEqual(BigInt(QUOTE.otherAmountThreshold))
        expect(await s.tool('get_portfolio')).toContain(WSOL.toBase58())
      })

      it('paper trades in shadow: the real test run, nothing signed', async () => {
        s.setPolicy({ trading, mode: 'shadow' })
        const text = await buy()
        expect(text).toContain(': shadowed.')
        untouched()
      })

      it('refuses what the policy refuses before the venue builds anything', async () => {
        s.setPolicy({ trading: { ...trading, maxTradeUsd: '500000' } })
        await rejected(['TRADE_EXCEEDED'])
        s.setPolicy({ trading: { ...trading, dailyTradeMax: '500000' } })
        await rejected(['TRADE_DAILY_EXCEEDED'])
        s.setPolicy({ trading: { ...trading, maxPositionUsd: '500000' } })
        await rejected(['POSITION_EXCEEDED'])
        s.setPolicy({ trading: { ...trading, tokens: [] } })
        await rejected(['TOKEN_NOT_TRADABLE'])
        s.setPolicy({ trading: { ...trading, enabled: false } })
        await rejected(['TRADING_DISABLED'])
      })
    })

    describe('a hostile venue', () => {
      beforeEach(() => start())

      it("opens the route's own slippage to 100%, which the test run alone would pass", async () => {
        f.hostile.tx = wideOpen
        await rejected(['SLIPPAGE_TOO_HIGH'])
      })

      it('slips in a delegate over the hot wallet dollars', async () => {
        const usdc = getAssociatedTokenAddressSync(USDC, HOT)
        f.hostile.tx = (tx, fk) =>
          fk.withInstructions(tx, [createApproveInstruction(usdc, ATTACKER, HOT, 2n ** 64n - 1n)])
        await rejected(['DELEGATE_DETECTED'])
      })

      it('slips in a transfer of the hot wallet SOL', async () => {
        f.hostile.tx = (tx, fk) =>
          fk.withInstructions(tx, [
            SystemProgram.transfer({ fromPubkey: HOT, toPubkey: ATTACKER, lamports: 1_000_000 }),
          ])
        await rejected(['SIM_UNEXPECTED_EFFECT'])
      })

      it('routes through a lookup table extended in the last slots', async () => {
        f.hostile.tx = (tx, fk) => {
          const key = tx.message.addressTableLookups[0]!.accountKey
          const table = fk.svm.getAccount(key)!
          const data = Buffer.from(table.data)
          // last_extended_slot: u64 after the 4-byte type and the u64 deactivation slot.
          data.writeBigUInt64LE(fk.svm.getClock().slot, 12)
          fk.svm.setAccount(key, { ...table, data })
          return tx
        }
        await rejected(['HIDDEN_ACCOUNTS_DETECTED'])
      })

      it('quotes a lower minimum than the slippage allows', async () => {
        f.hostile.quote = (q) => ({ ...q, otherAmountThreshold: '1' })
        const text = await buy()
        expect(text).not.toContain(': executed.')
        untouched()
      })

      it('quotes another token than the one asked for', async () => {
        f.hostile.quote = (q) => ({ ...q, outputMint: ATTACKER.toBase58() })
        const text = await buy()
        expect(text).not.toContain(': executed.')
        untouched()
      })

      it('has no way back out of the token', async () => {
        f.hostile.exit = 'no_route'
        await rejected(['NO_EXIT_ROUTE'])
      })

      it('turns hostile after the owner was asked: the approved swap is checked again', async () => {
        const text = await buy()
        expect(text).toContain(': pending_approval.')
        f.hostile.tx = wideOpen
        await s.telegram.press(intentIdIn(text), 'approve')
        await vi.waitFor(async () =>
          expect((await s.intent(intentIdIn(text))).status).toBe('rejected'),
        )
        expect((await s.intent(intentIdIn(text))).rejectReasons).toEqual(['SLIPPAGE_TOO_HIGH'])
        untouched()
      })
    })

    describe('a risky token', () => {
      beforeEach(() => start())

      it('can be frozen by its issuer', async () => {
        f.patchMint(WSOL, { freezeAuthority: ATTACKER })
        await rejected(['TOKEN_FREEZABLE'])
      })

      it('can still be minted: the buy waits for the owner', async () => {
        f.patchMint(WSOL, { mintAuthority: ATTACKER })
        const text = await buy()
        expect(text).toContain(': pending_approval.')
        untouched()
      })

      it('reaches the owner on Telegram, with both sides and MINT_AUTHORITY explained', async () => {
        f.patchMint(WSOL, { mintAuthority: ATTACKER })
        const id = intentIdIn(await buy())
        await vi.waitFor(() => expect(s.telegram.approvalFor(id)).toBeDefined())
        const text = s.telegram.approvalFor(id)!.text
        expect(text).toContain('Buy with')
        expect(text).toContain(WSOL.toBase58())
        expect(text).toContain('mint more')
        untouched()
      })
    })
  },
)
