import { readFileSync } from 'node:fs'
import { StubChain } from '@defimind/guard-core'
import { SwapUnavailable, svmAdapter, type SimulationOutcome } from '@defimind/onchain'
import { CHAINS, type PayIntent, type TokenRisk } from '@defimind/shared'
import {
  ACCOUNT_SIZE,
  AccountLayout,
  AccountState,
  getAssociatedTokenAddressSync,
  MintLayout,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import {
  AddressLookupTableAccount,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
  type TransactionInstruction,
} from '@solana/web3.js'
// The onchain package's own LiteSVM harness and mainnet program loader: one fork, not two.
import { liteConnection } from '../../../packages/onchain/test/litesvm.js'
import { mainnetPrograms, type PinnedProgram } from '../../../packages/onchain/test/programs.js'
import { Clock, Svm } from '../../../packages/onchain/test/svm.js'
import type { Net } from './paid-api.js'

type JupiterQuote = Record<string, unknown> & {
  inAmount: string
  outAmount: string
  otherAmountThreshold: string
  slippageBps: number
}

/** The real 1 USDC → wSOL Whirlpool route onchain recorded from mainnet (record-swap.ts). */
const recorded = JSON.parse(
  readFileSync(
    new URL('../../../packages/onchain/test/fixtures/jupiter-swap.json', import.meta.url),
    'utf8',
  ),
) as {
  slot: number
  blockTime: number
  hotSecretKey: number[]
  quote: JupiterQuote
  swapTransaction: string
  programs: PinnedProgram[]
  accounts: Record<string, { lamports: number; owner: string; executable: boolean; data: string }>
}

export const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
export const WSOL = new PublicKey('So11111111111111111111111111111111111111112')
export const QUOTE = recorded.quote
export const ATTACKER = new PublicKey('DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy')

export const MAINNET: Net = {
  chain: CHAINS.solanaMainnet,
  token: USDC.toBase58(),
  merchant: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
  attacker: ATTACKER.toBase58(),
  extra: {},
}

/** Jupiter and Whirlpool from mainnet, or why they cannot be had here. */
export const programs = await mainnetPrograms(recorded.programs)

const hotWallet = Keypair.fromSecretKey(Uint8Array.from(recorded.hotSecretKey))
export const HOT = hotWallet.publicKey
const usdcAccount = getAssociatedTokenAddressSync(USDC, HOT)
const wsolAccount = getAssociatedTokenAddressSync(WSOL, HOT)

/** What a hostile venue does to the quote or the transaction it hands back. */
export interface Hostile {
  quote?: (quote: JupiterQuote) => JupiterQuote
  tx?: (tx: VersionedTransaction, fork: Omit<Fork, 'chain'>) => VersionedTransaction
  /** Jupiter's answer for the sell that would get out of the token. */
  exit?: 'no_route'
}

export type Fork = ReturnType<typeof fork>

/**
 * Mainnet at the recorded slot in LiteSVM, with the real Jupiter and Whirlpool programs, and a
 * guard-core chain whose swaps go through onchain's real adapter: quote checks, mint risk, lookup
 * tables, inspection, test run and signing. Payments stay on the stub; they are not under test.
 */
export function fork() {
  const svm = new Svm()
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
  const clock = svm.getClock()
  svm.setClock(
    new Clock(
      BigInt(recorded.slot),
      clock.epochStartTimestamp,
      clock.epoch,
      clock.leaderScheduleEpoch,
      BigInt(recorded.blockTime),
    ),
  )
  svm.airdrop(HOT, BigInt(LAMPORTS_PER_SOL))
  svm.setAccount(usdcAccount, tokenAccount(USDC, 5_000_000n))

  // LiteSVM keeps no owner index; the hot wallet's accounts are its two associated ones.
  const connection = Object.assign(liteConnection(svm), {
    getTokenAccountsByOwner: async (
      _owner: PublicKey,
      { programId }: { programId: PublicKey },
    ) => ({
      value: [usdcAccount, wsolAccount]
        .map((pubkey) => ({ pubkey, account: svm.getAccount(pubkey) }))
        .filter(({ account }) => account?.owner.equals(programId)),
    }),
  }) as unknown as Connection

  const hostile: Hostile = {}
  const self = {
    svm,
    hostile,
    /** The hot wallet's dollars, as a top-up or a spend would leave them. */
    setUsdc(amount: bigint) {
      svm.setAccount(usdcAccount, tokenAccount(USDC, amount))
    },
    balance(token: PublicKey) {
      const info = svm.getAccount(getAssociatedTokenAddressSync(token, HOT))
      return info ? AccountLayout.decode(Buffer.from(info.data)).amount : 0n
    },
    /** The message with extra instructions, compiled against the same lookup tables. */
    withInstructions(tx: VersionedTransaction, extra: TransactionInstruction[]) {
      const tables = tx.message.addressTableLookups.map(
        ({ accountKey }) =>
          new AddressLookupTableAccount({
            key: accountKey,
            state: AddressLookupTableAccount.deserialize(svm.getAccount(accountKey)!.data),
          }),
      )
      const message = TransactionMessage.decompile(tx.message, {
        addressLookupTableAccounts: tables,
      })
      message.instructions.push(...extra)
      return new VersionedTransaction(message.compileToV0Message(tables))
    },
    /** Rewrites a mint in place: an authority the recorded token never had. */
    patchMint(mint: PublicKey, patch: { freezeAuthority?: PublicKey; mintAuthority?: PublicKey }) {
      const info = svm.getAccount(mint)!
      const data = Buffer.from(info.data)
      const decoded = MintLayout.decode(data)
      if (patch.freezeAuthority) {
        decoded.freezeAuthorityOption = 1
        decoded.freezeAuthority = patch.freezeAuthority
      }
      if (patch.mintAuthority) {
        decoded.mintAuthorityOption = 1
        decoded.mintAuthority = patch.mintAuthority
      }
      MintLayout.encode(decoded, data)
      svm.setAccount(mint, { ...info, data })
    },
  }

  const real = svmAdapter({
    chain: CHAINS.solanaMainnet,
    connection,
    hotWallet,
    multisigPda: Keypair.generate().publicKey,
    mint: USDC,
    venue: {
      async quote(request) {
        const sell = request.inputMint === WSOL.toBase58()
        if (sell && hostile.exit === 'no_route') {
          throw new SwapUnavailable('no_route', 'COULD_NOT_FIND_ANY_ROUTE')
        }
        // The recorded route answers the buy; the way out is priced as the same pool backwards.
        const quote = sell
          ? { ...QUOTE, inputMint: request.inputMint, outputMint: request.outputMint }
          : QUOTE
        const recordedBuy =
          request.amount === BigInt(QUOTE.inAmount) && request.slippageBps === QUOTE.slippageBps
        const sized = sell
          ? { ...quote, inAmount: request.amount.toString(), slippageBps: request.slippageBps }
          : recordedBuy
            ? quote
            : scaled(request.amount, request.slippageBps)
        return (hostile.quote ?? ((q) => q))(sized) as never
      },
      async swap() {
        const tx = VersionedTransaction.deserialize(Buffer.from(recorded.swapTransaction, 'base64'))
        return hostile.tx ? hostile.tx(tx, self) : tx
      },
    },
  })
  // A top-up stands in for the vault's spending-limit draw: the dollars arrive in the hot wallet.
  const chain = new ForkChain(real, (amount) => self.setUsdc(self.balance(USDC) + amount))
  return { ...self, chain }
}

/** The recorded route's price for another amount: only a quote, since only 1 USDC has a transaction. */
function scaled(amount: bigint, slippageBps: number) {
  const out = (BigInt(QUOTE.outAmount) * amount) / BigInt(QUOTE.inAmount)
  return {
    ...QUOTE,
    inAmount: amount.toString(),
    outAmount: out.toString(),
    otherAmountThreshold: ((out * BigInt(10_000 - slippageBps)) / 10_000n).toString(),
    slippageBps,
  }
}

/** guard-core's view of the fork: swaps are real, everything else is the offline stub. */
class ForkChain extends StubChain {
  readonly swapsSent: PayIntent[] = []

  constructor(
    private readonly real: ReturnType<typeof svmAdapter>,
    private readonly credit: (amount: bigint) => void,
  ) {
    super(CHAINS.solanaMainnet, 0n)
  }

  override async topUpHotWallet(amount: string): Promise<string> {
    this.credit(BigInt(amount))
    return super.topUpHotWallet(amount)
  }

  quoteSwap = (req: Parameters<NonNullable<typeof this.real.quoteSwap>>[0]) =>
    this.real.quoteSwap!(req)

  getPositions = () => this.real.getPositions!()

  tokenRisk = (mint: string): Promise<Omit<TokenRisk, 'venue' | 'flags'>> =>
    this.real.tokenRisk!(mint)

  override getHotWalletBalance(token?: string) {
    return this.real.getHotWalletBalance(token ?? USDC.toBase58())
  }

  override simulate(intent: PayIntent): Promise<SimulationOutcome> {
    return intent.kind === 'swap' ? this.real.simulate(intent) : super.simulate(intent)
  }

  override async send(intent: PayIntent): Promise<string> {
    if (intent.kind !== 'swap') return super.send(intent)
    const tx = await this.real.send(intent)
    this.swapsSent.push(intent)
    return tx
  }
}

function tokenAccount(mint: PublicKey, amount: bigint) {
  const data = Buffer.alloc(ACCOUNT_SIZE)
  AccountLayout.encode(
    {
      mint,
      owner: HOT,
      amount,
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
  return { lamports: 2_039_280, owner: TOKEN_PROGRAM_ID, executable: false, data }
}
