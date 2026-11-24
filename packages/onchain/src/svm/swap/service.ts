import type { Amount, PayIntent, RejectCode, SwapQuote } from '@defimind/shared'
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackAccount,
  unpackMint,
} from '@solana/spl-token'
import {
  PublicKey,
  type AccountInfo,
  type Connection,
  type Keypair,
  type SimulatedTransactionAccountInfo,
  type VersionedTransaction,
} from '@solana/web3.js'
import type { SimulationOutcome } from '../../ChainAdapter.js'
import { confirm } from '../squads.js'
import { swapEffects, type Holding } from './effects.js'
import { inspectSwap, MAX_PRIORITY_LAMPORTS } from './inspect.js'
import type { Venue } from './jupiter.js'
import { expand } from './lookup.js'
import { mintFacts } from './mint.js'
import { checkQuote } from './quote.js'
import { exitImpact } from './risk.js'

export interface SwapDeps {
  connection: Connection
  hotWallet: Keypair
  /** The chain's dollar: one side of every swap (CR-021, phase 1). */
  dollar: PublicKey
  venue: Venue
}

const SIGNATURE_FEE = 5_000n
const CHECKED_TTL_MS = 90_000
const TOKEN_PROGRAMS = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]

/**
 * Swaps through an untrusted venue. Every quote is held to its request and every transaction is
 * inspected with its lookup tables written out, then run; send() signs only the transaction whose
 * run matched the intent, and only once.
 */
export function swaps({ connection, hotWallet, dollar, venue }: SwapDeps) {
  const hot = hotWallet.publicKey
  // A checked transaction is good until its blockhash expires, about a minute; kept no longer.
  const checked = new Map<string, { tx: VersionedTransaction; at: number }>()
  const fresh = (entry?: { at: number }) => !!entry && Date.now() - entry.at < CHECKED_TTL_MS

  async function quoteSwap(req: {
    tokenIn: string
    tokenOut: string
    amountIn: Amount
    slippageBps: number
  }): Promise<SwapQuote> {
    const request = {
      inputMint: new PublicKey(req.tokenIn).toBase58(),
      outputMint: new PublicKey(req.tokenOut).toBase58(),
      amount: positive(req.amountIn),
      slippageBps: slippage(req.slippageBps),
    }
    const buy = request.inputMint === dollar.toBase58()
    if (!buy && request.outputMint !== dollar.toBase58()) {
      throw new Error('invalid_swap: one side must be the chain dollar')
    }
    const quote = checkQuote(await venue.quote(request), request)
    const mints = [new PublicKey(request.inputMint), new PublicKey(request.outputMint)]
    const [infoIn, infoOut] = await connection.getMultipleAccountsInfo(mints)
    const factsIn = mintFacts(mints[0]!, infoIn ?? null)
    const factsOut = mintFacts(mints[1]!, infoOut ?? null)
    const risks: RejectCode[] = []
    let exitImpactBps: number | null = null
    if (buy) {
      risks.push(...factsOut.risks)
      exitImpactBps = await exitImpact(
        venue,
        dollar,
        request.outputMint,
        quote.expectedOut,
        request.slippageBps,
      )
      if (exitImpactBps === null) risks.push('NO_EXIT_ROUTE')
    }
    return {
      venue: 'jupiter',
      tokenIn: request.inputMint,
      amountIn: request.amount.toString(),
      tokenOut: request.outputMint,
      expectedOut: quote.expectedOut.toString(),
      minAmountOut: quote.minAmountOut.toString(),
      slippageBps: request.slippageBps,
      priceImpactBps: quote.priceImpactBps,
      exitImpactBps,
      risks,
      flags: buy && factsOut.mintAuthority ? ['MINT_AUTHORITY'] : [],
      decimalsIn: factsIn.decimals,
      decimalsOut: factsOut.decimals,
      quotedAt: new Date().toISOString(),
    }
  }

  async function simulate(intent: PayIntent): Promise<SimulationOutcome> {
    for (const [id, entry] of checked) if (!fresh(entry)) checked.delete(id)
    checked.delete(intent.id)
    const swap = intent.swap
    if (!swap || swap.venue !== 'jupiter') return refused('VENUE_NOT_ALLOWED', 'not a Jupiter swap')
    const request = {
      inputMint: intent.token,
      outputMint: swap.tokenOut,
      amount: positive(intent.amount),
      slippageBps: slippage(swap.slippageBps),
    }
    const minAmountOut = positive(swap.minAmountOut)
    const quote = await venue.quote(request)
    // Re-quoted for a fresh transaction: it must still promise what was approved, or it is not
    // the swap the owner or the policy agreed to.
    if (checkQuote(quote, request).minAmountOut < minAmountOut) {
      return refused('SLIPPAGE_TOO_HIGH', 'the market moved past the approved minimum')
    }
    const tx = await venue.swap(quote, hot.toBase58())
    const expanded = await expand(connection, tx.message)
    if (!expanded) return refused('HIDDEN_ACCOUNTS_DETECTED', 'a lookup table could not be trusted')
    const sides = {
      hotWallet: hot,
      tokenIn: new PublicKey(request.inputMint),
      tokenOut: new PublicKey(request.outputMint),
      amountIn: request.amount,
      minAmountOut,
    }
    const inspected = inspectSwap(tx.message, expanded, sides)
    if (inspected.length > 0) return { simulation: describe(intent, []), rejectReasons: inspected }

    const watched = await watch(expanded.instructions.flatMap((ix) => ix.keys))
    const before = await connection.getMultipleAccountsInfo(watched)
    const { value } = await connection.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      accounts: { encoding: 'base64', addresses: watched.map((key) => key.toBase58()) },
    })
    if (value.err || !value.accounts) {
      const summary = `simulation failed: ${JSON.stringify(value.err ?? 'no accounts returned')}`
      return { simulation: { summary, balanceChanges: [] }, rejectReasons: ['SIM_FAILED'] }
    }
    const after = value.accounts.map(fromSimulation)
    const effects = holdings(watched, before, after, minAmountOut, request)
    const outcome = {
      simulation: describe(intent, effects.changes),
      rejectReasons: effects.reasons,
    }
    if (effects.reasons.length === 0) checked.set(intent.id, { tx, at: Date.now() })
    return outcome
  }

  /** The hot wallet, its token accounts now, and every writable account the transaction names. */
  async function watch(keys: { pubkey: PublicKey; isWritable: boolean }[]) {
    const owned = await Promise.all(
      TOKEN_PROGRAMS.map((programId) => connection.getTokenAccountsByOwner(hot, { programId })),
    )
    const all = [
      hot,
      ...owned.flatMap(({ value }) => value.map(({ pubkey }) => pubkey)),
      ...keys.filter((key) => key.isWritable).map((key) => key.pubkey),
    ]
    return [...new Map(all.map((key) => [key.toBase58(), key])).values()]
  }

  function holdings(
    watched: PublicKey[],
    before: (AccountInfo<Buffer> | null)[],
    after: (AccountInfo<Buffer> | null)[],
    minAmountOut: bigint,
    request: { inputMint: string; outputMint: string; amount: bigint },
  ) {
    const was = new Map<string, Holding | null>()
    const now = new Map<string, Holding | null>()
    let rent = 0n
    watched.forEach((address, i) => {
      const prior = holding(address, before[i] ?? null)
      const next = holding(address, after[i] ?? null)
      const ours = (h: Holding | null) => h?.owner === hot.toBase58()
      if (!ours(prior) && !ours(next)) return
      was.set(address.toBase58(), ours(prior) ? prior : null)
      now.set(address.toBase58(), next)
      // An account the swap opens for the hot wallet is paid for by the hot wallet.
      if (!ours(prior) && next) rent += BigInt(after[i]!.lamports)
    })
    const lamports = {
      before: BigInt(before[0]?.lamports ?? 0),
      after: BigInt(after[0]?.lamports ?? 0),
    }
    return swapEffects(was, now, lamports, {
      hotWallet: hot.toBase58(),
      tokenIn: request.inputMint,
      amountIn: request.amount,
      tokenOut: request.outputMint,
      minAmountOut,
      maxLamports: SIGNATURE_FEE + MAX_PRIORITY_LAMPORTS + rent,
    })
  }

  async function send(intent: PayIntent): Promise<string> {
    const entry = checked.get(intent.id)
    checked.delete(intent.id)
    if (!entry || !fresh(entry)) throw new Error(`swap_not_simulated: ${intent.id}`)
    const { tx } = entry
    tx.sign([hotWallet])
    return confirm(connection, await connection.sendRawTransaction(tx.serialize()))
  }

  async function getPositions() {
    const owned = await Promise.all(
      TOKEN_PROGRAMS.map((programId) => connection.getTokenAccountsByOwner(hot, { programId })),
    )
    const totals = new Map<string, bigint>()
    for (const { pubkey, account } of owned.flatMap(({ value }) => value)) {
      const { mint, amount } = unpackAccount(pubkey, account, account.owner)
      if (amount > 0n && !mint.equals(dollar)) {
        totals.set(mint.toBase58(), (totals.get(mint.toBase58()) ?? 0n) + amount)
      }
    }
    const mints = [...totals.keys()].map((mint) => new PublicKey(mint))
    const infos = mints.length ? await connection.getMultipleAccountsInfo(mints) : []
    return mints.map((mint, i) => ({
      token: mint.toBase58(),
      amount: totals.get(mint.toBase58())!.toString(),
      decimals: unpackMint(mint, infos[i] ?? null, infos[i]?.owner).decimals,
    }))
  }

  return { quoteSwap, simulate, send, getPositions }
}

/** A token account, read with its own program; anything else is not a holding. */
function holding(address: PublicKey, info: AccountInfo<Buffer> | null): Holding | null {
  if (!info || !TOKEN_PROGRAMS.some((program) => info.owner.equals(program))) return null
  try {
    const account = unpackAccount(address, info, info.owner)
    return {
      mint: account.mint.toBase58(),
      owner: account.owner.toBase58(),
      amount: account.amount,
      delegate: account.delegate?.toBase58() ?? null,
      closeAuthority: account.closeAuthority?.toBase58() ?? null,
      frozen: account.isFrozen,
    }
  } catch {
    return null
  }
}

function positive(amount: Amount): bigint {
  if (!/^[1-9]\d{0,19}$/.test(amount)) throw new Error(`invalid_amount: ${amount}`)
  return BigInt(amount)
}

function slippage(bps: number): number {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new Error(`invalid_slippage: ${bps}`)
  return bps
}

const refused = (reason: RejectCode, why: string): SimulationOutcome => ({
  simulation: { summary: `not simulated: ${why}`, balanceChanges: [] },
  rejectReasons: [reason],
})

function describe(intent: PayIntent, changes: { token: string; delta: string }[]) {
  return {
    summary: `swaps ${intent.amount} of ${intent.token} for at least ${intent.swap?.minAmountOut} of ${intent.swap?.tokenOut}`,
    balanceChanges: changes,
  }
}

function fromSimulation(
  account: SimulatedTransactionAccountInfo | null | undefined,
): AccountInfo<Buffer> | null {
  if (!account) return null
  return {
    data: Buffer.from(account.data[0] ?? '', 'base64'),
    owner: new PublicKey(account.owner),
    lamports: account.lamports,
    executable: account.executable,
  }
}
