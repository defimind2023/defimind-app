import { CHAINS, type PayIntent } from '@defimind/shared'
import {
  AccountLayout,
  ACCOUNT_SIZE,
  AccountState,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  MINT_SIZE,
  MintLayout,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AccountInfo,
  type Connection,
} from '@solana/web3.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { JUPITER_PROGRAM_ID } from '../src/svm/swap/inspect.js'
import { SwapUnavailable, type JupiterQuote, type Venue } from '../src/svm/swap/jupiter.js'
import { swaps } from '../src/svm/swap/service.js'
import { createSvmAdapter } from '../src/svm/adapter.js'

const key = () => Keypair.generate().publicKey
const hotWallet = Keypair.generate()
const hot = hotWallet.publicKey
const usdc = key()
const bonk = key()
const usdcAccount = getAssociatedTokenAddressSync(usdc, hot)
const bonkAccount = getAssociatedTokenAddressSync(bonk, hot)

function mint(decimals: number, { freeze = false, authority = false } = {}): AccountInfo<Buffer> {
  const data = Buffer.alloc(MINT_SIZE)
  MintLayout.encode(
    {
      mintAuthorityOption: authority ? 1 : 0,
      mintAuthority: authority ? key() : PublicKey.default,
      supply: 1n,
      decimals,
      isInitialized: true,
      freezeAuthorityOption: freeze ? 1 : 0,
      freezeAuthority: freeze ? key() : PublicKey.default,
    },
    data,
  )
  return { data, owner: TOKEN_PROGRAM_ID, lamports: 1_461_600, executable: false }
}

function account(
  tokenMint: PublicKey,
  amount: bigint,
  { owner = hot, delegate = null as PublicKey | null } = {},
): AccountInfo<Buffer> {
  const data = Buffer.alloc(ACCOUNT_SIZE)
  AccountLayout.encode(
    {
      mint: tokenMint,
      owner,
      amount,
      delegateOption: delegate ? 1 : 0,
      delegate: delegate ?? PublicKey.default,
      state: AccountState.Initialized,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  )
  return { data, owner: TOKEN_PROGRAM_ID, lamports: 2_039_280, executable: false }
}

const wallet = (lamports: number): AccountInfo<Buffer> => ({
  data: Buffer.alloc(0),
  owner: SystemProgram.programId,
  lamports,
  executable: false,
})

/** The chain before and after the swap's test run, as the RPC would answer. */
let before: Map<string, AccountInfo<Buffer>>
let after: Map<string, AccountInfo<Buffer>>
let sent: Buffer[]

const connection = {
  getSlot: async () => 1_000,
  getMultipleAccountsInfo: async (keys: PublicKey[]) =>
    keys.map((k) => before.get(k.toBase58()) ?? null),
  getTokenAccountsByOwner: async (_owner: PublicKey, { programId }: { programId: PublicKey }) => ({
    value: [...before]
      .filter(([address, info]) => info.owner.equals(programId) && address !== usdc.toBase58())
      .filter(([address]) => ![usdc, bonk].some((m) => m.toBase58() === address))
      .map(([address, info]) => ({ pubkey: new PublicKey(address), account: info })),
  }),
  simulateTransaction: async (
    _tx: VersionedTransaction,
    config: { accounts: { addresses: string[] } },
  ) => ({
    value: {
      err: null,
      logs: [],
      accounts: config.accounts.addresses.map((address) => {
        const info = after.get(address)
        return info
          ? {
              ...info,
              owner: info.owner.toBase58(),
              data: [info.data.toString('base64'), 'base64'],
            }
          : null
      }),
    },
  }),
  sendRawTransaction: async (raw: Buffer) => {
    sent.push(raw)
    return 'sig'
  },
  getSignatureStatuses: async () => ({
    value: [{ err: null, confirmationStatus: 'confirmed' }],
  }),
} as unknown as Connection

/** Jupiter v6's route: discriminator, an empty route plan, then 10 USDC in, 1 BONK quoted, 0.5%. */
function routeData(slippageBps = 50) {
  const terms = Buffer.alloc(19)
  terms.writeBigUInt64LE(10_000_000n, 0)
  terms.writeBigUInt64LE(1_000_000n, 8)
  terms.writeUInt16LE(slippageBps, 16)
  return Buffer.concat([
    Buffer.from([229, 23, 203, 151, 122, 227, 173, 42]),
    Buffer.alloc(4),
    terms,
  ])
}

const route = (extra: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = []) =>
  new TransactionInstruction({
    programId: JUPITER_PROGRAM_ID,
    keys: [
      { pubkey: hot, isSigner: true, isWritable: true },
      { pubkey: usdcAccount, isSigner: false, isWritable: true },
      { pubkey: bonkAccount, isSigner: false, isWritable: true },
      ...extra,
    ],
    data: routeData(),
  })

/** A venue whose quotes and transactions the test sets, as an untrusted Jupiter would send them. */
function fakeVenue() {
  const state = {
    out: 1_000_000n,
    noExit: false,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      createAssociatedTokenAccountIdempotentInstruction(hot, bonkAccount, hot, bonk),
      route(),
    ],
  }
  const venue: Venue = {
    async quote({ inputMint, outputMint, amount, slippageBps }): Promise<JupiterQuote> {
      if (state.noExit && inputMint === bonk.toBase58()) {
        throw new SwapUnavailable('no_route', 'COULD_NOT_FIND_ANY_ROUTE')
      }
      const out = inputMint === usdc.toBase58() ? state.out : amount / 10n
      return {
        inputMint,
        inAmount: amount.toString(),
        outputMint,
        outAmount: out.toString(),
        otherAmountThreshold: ((out * BigInt(10_000 - slippageBps)) / 10_000n).toString(),
        swapMode: 'ExactIn',
        slippageBps,
        priceImpactPct: inputMint === usdc.toBase58() ? '0.002' : '0.03',
      }
    },
    async swap(_quote, user) {
      return new VersionedTransaction(
        new TransactionMessage({
          payerKey: new PublicKey(user),
          recentBlockhash: key().toBase58(),
          instructions: state.instructions,
        }).compileToV0Message(),
      )
    },
  }
  return { venue, state }
}

let v: ReturnType<typeof fakeVenue>
let s: ReturnType<typeof swaps>

beforeEach(() => {
  before = new Map([
    [hot.toBase58(), wallet(100_000_000)],
    [usdc.toBase58(), mint(6)],
    [bonk.toBase58(), mint(5)],
    [usdcAccount.toBase58(), account(usdc, 50_000_000n)],
  ])
  after = new Map([
    [hot.toBase58(), wallet(100_000_000 - 5_000 - 2_039_280)],
    [usdcAccount.toBase58(), account(usdc, 40_000_000n)],
    [bonkAccount.toBase58(), account(bonk, 999_000n)],
  ])
  sent = []
  v = fakeVenue()
  s = swaps({ connection, hotWallet, dollar: usdc, venue: v.venue })
})

const buy = (minAmountOut = '995000'): PayIntent => ({
  id: 'intent-1',
  agentId: 'agent',
  kind: 'swap',
  chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  token: usdc.toBase58(),
  amount: '10000000',
  recipient: hot.toBase58(),
  reason: 'test',
  status: 'approved',
  rejectReasons: [],
  swap: {
    venue: 'jupiter',
    tokenOut: bonk.toBase58(),
    minAmountOut,
    slippageBps: 50,
    priceImpactBps: 20,
    decimalsIn: 6,
    decimalsOut: 5,
    quotedAt: new Date().toISOString(),
  },
  createdAt: new Date().toISOString(),
  expiresAt: new Date().toISOString(),
})

const quoteBuy = () =>
  s.quoteSwap({
    tokenIn: usdc.toBase58(),
    tokenOut: bonk.toBase58(),
    amountIn: '10000000',
    slippageBps: 50,
  })

describe('quoteSwap', () => {
  it('checks the quote, reads both mints, and prices the exit', async () => {
    expect(await quoteBuy()).toMatchObject({
      venue: 'jupiter',
      tokenIn: usdc.toBase58(),
      amountIn: '10000000',
      tokenOut: bonk.toBase58(),
      expectedOut: '1000000',
      minAmountOut: '995000',
      slippageBps: 50,
      priceImpactBps: 20,
      exitImpactBps: 300,
      risks: [],
      flags: [],
      decimalsIn: 6,
      decimalsOut: 5,
    })
  })

  it('names the risks of the token bought, from its mint', async () => {
    before.set(bonk.toBase58(), mint(5, { freeze: true, authority: true }))
    const quote = await quoteBuy()
    expect(quote.risks).toEqual(['TOKEN_FREEZABLE'])
    expect(quote.flags).toEqual(['MINT_AUTHORITY'])
  })

  it('reports no exit route when Jupiter cannot sell the token back', async () => {
    v.state.noExit = true
    const quote = await quoteBuy()
    expect(quote.exitImpactBps).toBeNull()
    expect(quote.risks).toEqual(['NO_EXIT_ROUTE'])
  })

  it('asks nothing of a sell: no risks, no exit', async () => {
    before.set(bonk.toBase58(), mint(5, { freeze: true }))
    const quote = await s.quoteSwap({
      tokenIn: bonk.toBase58(),
      tokenOut: usdc.toBase58(),
      amountIn: '1000',
      slippageBps: 50,
    })
    expect(quote).toMatchObject({ risks: [], flags: [], exitImpactBps: null, decimalsIn: 5 })
  })

  it('refuses a pair without the chain dollar, and a bad amount or slippage', async () => {
    const other = key().toBase58()
    const ask = (tokenIn: string, amountIn = '1', slippageBps = 50) =>
      s.quoteSwap({ tokenIn, tokenOut: bonk.toBase58(), amountIn, slippageBps })
    await expect(ask(other)).rejects.toThrow(/^invalid_swap/)
    await expect(ask(usdc.toBase58(), '0')).rejects.toThrow(/^invalid_amount/)
    await expect(ask(usdc.toBase58(), '1', -1)).rejects.toThrow(/^invalid_slippage/)
    await expect(ask(usdc.toBase58(), '1', 10_001)).rejects.toThrow(/^invalid_slippage/)
  })
})

describe('simulate and send a swap', () => {
  it('passes a run that matches the intent, then signs exactly that transaction, once', async () => {
    const outcome = await s.simulate(buy())
    expect(outcome.rejectReasons).toEqual([])
    expect(outcome.simulation.balanceChanges).toEqual([
      { token: usdc.toBase58(), delta: '-10000000' },
      { token: bonk.toBase58(), delta: '999000' },
    ])
    expect(await s.send(buy())).toBe('sig')
    const signed = VersionedTransaction.deserialize(sent[0]!)
    expect(signed.message.staticAccountKeys[0]!.equals(hot)).toBe(true)
    await expect(s.send(buy())).rejects.toThrow(/^swap_not_simulated/)
  })

  it('refuses a fresh quote that no longer meets the approved minimum', async () => {
    v.state.out = 900_000n
    expect((await s.simulate(buy())).rejectReasons).toEqual(['SLIPPAGE_TOO_HIGH'])
    await expect(s.send(buy())).rejects.toThrow(/^swap_not_simulated/)
  })

  it('refuses a run that gives less than the minimum, or takes from elsewhere', async () => {
    after.set(bonkAccount.toBase58(), account(bonk, 994_999n))
    expect((await s.simulate(buy())).rejectReasons).toEqual(['SIM_UNEXPECTED_EFFECT'])
    after.set(bonkAccount.toBase58(), account(bonk, 999_000n, { delegate: key() }))
    expect((await s.simulate(buy())).rejectReasons).toEqual(['SIM_UNEXPECTED_EFFECT'])
    await expect(s.send(buy())).rejects.toThrow(/^swap_not_simulated/)
  })

  it('refuses a run that drains SOL past fees and rent', async () => {
    after.set(hot.toBase58(), wallet(90_000_000))
    expect((await s.simulate(buy())).rejectReasons).toEqual(['SIM_UNEXPECTED_EFFECT'])
  })

  it('refuses a transaction whose route would accept less than the approved minimum', async () => {
    v.state.instructions = [new TransactionInstruction({ ...route(), data: routeData(10_000) })]
    expect((await s.simulate(buy())).rejectReasons).toEqual(['SLIPPAGE_TOO_HIGH'])
  })

  it('forgets a checked transaction once its blockhash would have expired', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    expect((await s.simulate(buy())).rejectReasons).toEqual([])
    vi.advanceTimersByTime(91_000)
    await expect(s.send(buy())).rejects.toThrow(/^swap_not_simulated/)
    vi.useRealTimers()
  })

  it('inspects the transaction before running it', async () => {
    v.state.instructions = [
      route(),
      new TransactionInstruction({ programId: key(), keys: [], data: Buffer.alloc(0) }),
    ]
    expect((await s.simulate(buy())).rejectReasons).toEqual(['UNKNOWN_PROGRAM_DETECTED'])
  })

  it('refuses a swap of another venue', async () => {
    const intent = buy()
    expect(
      (await s.simulate({ ...intent, swap: { ...intent.swap!, venue: 'other' } })).rejectReasons,
    ).toEqual(['VENUE_NOT_ALLOWED'])
  })
})

describe('getPositions', () => {
  it('lists every token held but the dollar, with decimals from the mint', async () => {
    before.set(bonkAccount.toBase58(), account(bonk, 777n))
    expect(await s.getPositions()).toEqual([{ token: bonk.toBase58(), amount: '777', decimals: 5 }])
  })
})

describe('the Solana adapter and swaps', () => {
  const config = {
    rpcUrl: 'http://127.0.0.1:1',
    hotWalletSecretKey: hotWallet.secretKey,
    multisig: key().toBase58(),
    mint: usdc.toBase58(),
  }

  it('trades on mainnet only, where Jupiter routes', () => {
    const mainnet = createSvmAdapter({ ...config, chain: CHAINS.solanaMainnet })
    const devnet = createSvmAdapter({ ...config, chain: CHAINS.solanaDevnet })
    expect(typeof mainnet.quoteSwap).toBe('function')
    expect(typeof mainnet.getPositions).toBe('function')
    expect(devnet.quoteSwap).toBeUndefined()
  })

  it('refuses a swap without a venue, before and at send', async () => {
    const devnet = createSvmAdapter({ ...config, chain: CHAINS.solanaDevnet })
    const intent = { ...buy(), chain: CHAINS.solanaDevnet }
    expect((await devnet.simulate(intent)).rejectReasons).toEqual(['VENUE_NOT_ALLOWED'])
    await expect(devnet.send(intent)).rejects.toThrow(/VENUE_NOT_ALLOWED/)
  })

  it('refuses a swap for another chain', async () => {
    const mainnet = createSvmAdapter({ ...config, chain: CHAINS.solanaMainnet })
    const intent = { ...buy(), chain: CHAINS.solanaDevnet }
    expect((await mainnet.simulate(intent)).rejectReasons).toEqual(['CHAIN_NOT_ALLOWED'])
  })
})
