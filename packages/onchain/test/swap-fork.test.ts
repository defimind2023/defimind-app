import { readFileSync } from 'node:fs'
import { CHAINS, type PayIntent } from '@defimind/shared'
import {
  ACCOUNT_SIZE,
  AccountLayout,
  AccountState,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  VersionedTransaction,
  type Connection,
} from '@solana/web3.js'
import { beforeEach, describe, expect, it } from 'vitest'
import type { JupiterQuote, Venue } from '../src/svm/swap/jupiter.js'
import { swaps } from '../src/svm/swap/service.js'
import { liteConnection } from './litesvm.js'
import { mainnetPrograms, type PinnedProgram } from './programs.js'
import { Clock, Svm } from './svm.js'

/**
 * A real Jupiter swap, 1 USDC for wrapped SOL through a Whirlpool, recorded from mainnet with every
 * account it touches (src/scripts/record-swap.ts) and run in LiteSVM by the real Jupiter and
 * Whirlpool programs. The hot wallet is a key made for the recording; no real funds are involved.
 */
const fixtures = new URL('./fixtures/', import.meta.url)
const recorded = JSON.parse(readFileSync(new URL('jupiter-swap.json', fixtures), 'utf8')) as {
  slot: number
  blockTime: number
  hotSecretKey: number[]
  quote: JupiterQuote
  swapTransaction: string
  programs: PinnedProgram[]
  accounts: Record<string, { lamports: number; owner: string; executable: boolean; data: string }>
}
/**
 * Jupiter and Whirlpool are read from mainnet at test time, never kept here. Offline, or after a
 * redeploy, the fork test is skipped by name, never passed silently; FORK_REQUIRED=1 (CI) makes
 * that a failure instead.
 */
const programs = await mainnetPrograms(recorded.programs)
const skipped = typeof programs === 'string' ? programs : undefined
if (skipped) {
  if (process.env['FORK_REQUIRED'] === '1') throw new Error(`fork test required: ${skipped}`)
  console.warn(`swap-fork skipped: ${skipped}`)
}

const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
const WSOL = new PublicKey('So11111111111111111111111111111111111111112')
const hotWallet = Keypair.fromSecretKey(Uint8Array.from(recorded.hotSecretKey))
const hot = hotWallet.publicKey
const usdcAccount = getAssociatedTokenAddressSync(USDC, hot)
const wsolAccount = getAssociatedTokenAddressSync(WSOL, hot)

let svm: Svm
let connection: Connection
let swapTransaction: string

function fork() {
  svm = new Svm()
  svm.withBlockhashCheck(false)
  for (const [id, code] of programs as Map<string, Buffer>) svm.addProgram(new PublicKey(id), code)
  for (const [address, account] of Object.entries(recorded.accounts)) {
    svm.setAccount(new PublicKey(address), {
      lamports: account.lamports,
      owner: new PublicKey(account.owner),
      executable: account.executable,
      data: Buffer.from(account.data, 'base64'),
    })
  }
  const now = svm.getClock()
  svm.setClock(
    new Clock(
      BigInt(recorded.slot),
      now.epochStartTimestamp,
      now.epoch,
      now.leaderScheduleEpoch,
      BigInt(recorded.blockTime),
    ),
  )
  svm.airdrop(hot, BigInt(LAMPORTS_PER_SOL))
  const data = Buffer.alloc(ACCOUNT_SIZE)
  AccountLayout.encode(
    {
      mint: USDC,
      owner: hot,
      amount: 5_000_000n,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: AccountState.Initialized,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  )
  svm.setAccount(usdcAccount, {
    lamports: 2_039_280,
    owner: TOKEN_PROGRAM_ID,
    executable: false,
    data,
  })
  const base = liteConnection(svm)
  // LiteSVM keeps no owner index; the hot wallet's accounts are its two associated ones.
  connection = Object.assign(base, {
    getTokenAccountsByOwner: async (
      _owner: PublicKey,
      { programId }: { programId: PublicKey },
    ) => ({
      value: [usdcAccount, wsolAccount]
        .map((pubkey) => ({ pubkey, account: svm.getAccount(pubkey) }))
        .filter(({ account }) => account?.owner.equals(programId)),
    }),
  }) as unknown as Connection
}

/** Jupiter as it answered that day: the recorded quote, and the recorded transaction. */
const venue: Venue = {
  async quote(request) {
    expect(request).toMatchObject({ inputMint: USDC.toBase58(), outputMint: WSOL.toBase58() })
    return recorded.quote
  },
  async swap(_quote, user) {
    expect(user).toBe(hot.toBase58())
    return VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'))
  },
}

const intent = (minAmountOut = recorded.quote.otherAmountThreshold): PayIntent => ({
  id: 'fork-1',
  agentId: 'agent',
  kind: 'swap',
  chain: CHAINS.solanaMainnet,
  token: USDC.toBase58(),
  amount: recorded.quote.inAmount,
  recipient: hot.toBase58(),
  reason: 'fork test',
  status: 'approved',
  rejectReasons: [],
  swap: {
    venue: 'jupiter',
    tokenOut: WSOL.toBase58(),
    minAmountOut,
    slippageBps: recorded.quote.slippageBps,
    priceImpactBps: 0,
    decimalsIn: 6,
    decimalsOut: 9,
    quotedAt: new Date().toISOString(),
  },
  createdAt: new Date().toISOString(),
  expiresAt: new Date().toISOString(),
})

const balance = (account: PublicKey) => {
  const info = svm.getAccount(account)
  return info ? AccountLayout.decode(Buffer.from(info.data)).amount : 0n
}

beforeEach(() => {
  swapTransaction = recorded.swapTransaction
  fork()
})

describe.skipIf(skipped)(
  `a real Jupiter route, on a fork of mainnet${skipped ? ` (skipped: ${skipped})` : ''}`,
  () => {
    it('passes the checks and the test run, then lands exactly what was checked', async () => {
      const s = swaps({ connection, hotWallet, dollar: USDC, venue })
      const outcome = await s.simulate(intent())
      expect(outcome.rejectReasons).toEqual([])
      const [spent, bought] = outcome.simulation.balanceChanges
      expect(spent).toEqual({ token: USDC.toBase58(), delta: `-${recorded.quote.inAmount}` })
      expect(bought?.token).toBe(WSOL.toBase58())
      expect(BigInt(bought!.delta)).toBeGreaterThanOrEqual(
        BigInt(recorded.quote.otherAmountThreshold),
      )

      await s.send(intent())
      expect(balance(usdcAccount)).toBe(5_000_000n - BigInt(recorded.quote.inAmount))
      expect(balance(wsolAccount)).toBe(BigInt(bought!.delta))
    })

    it("refuses the same transaction with the route's slippage opened to 100%", async () => {
      const tx = VersionedTransaction.deserialize(Buffer.from(recorded.swapTransaction, 'base64'))
      const route = tx.message.compiledInstructions.find((ix) =>
        tx.message.staticAccountKeys[ix.programIdIndex]?.toBase58().startsWith('JUP6'),
      )!
      // slippage_bps sits three bytes from the end of the route's data, before platform_fee_bps.
      Buffer.from(route.data.buffer, route.data.byteOffset, route.data.length).writeUInt16LE(
        10_000,
        route.data.length - 3,
      )
      swapTransaction = Buffer.from(tx.serialize()).toString('base64')
      const s = swaps({ connection, hotWallet, dollar: USDC, venue })
      expect((await s.simulate(intent())).rejectReasons).toEqual(['SLIPPAGE_TOO_HIGH'])
      expect(balance(usdcAccount)).toBe(5_000_000n)
    })

    it('refuses a route that cannot deliver the approved minimum', async () => {
      const s = swaps({ connection, hotWallet, dollar: USDC, venue })
      const more = (BigInt(recorded.quote.outAmount) + 1n).toString()
      expect((await s.simulate(intent(more))).rejectReasons).toEqual(['SLIPPAGE_TOO_HIGH'])
    })
  },
)
