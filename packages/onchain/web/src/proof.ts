import { USDC_DECIMALS } from '@defimind/shared'
import { AccountLayout, getAssociatedTokenAddressSync } from '@solana/spl-token'
import type { Connection, PublicKey } from '@solana/web3.js'
import * as multisig from '@sqds/multisig'
import { spendingLimitPda, VAULT_INDEX } from '../../src/svm/squads.js'
import { currentPeriod } from '../../src/svm/period.js'
import { formatUnits } from '../../src/svm/transfer.js'
import { decode } from './plan.js'

/** What the proof page shows: a headline and the facts behind it, read from the chain only. */
export interface Proof {
  verified: boolean
  title: string
  lines: string[]
}

export const notVerified = (lines: string[]): Proof => ({
  verified: false,
  title: 'Not verified',
  lines,
})

/**
 * A read the RPC refused or failed. Some RPCs refuse to list program accounts; without that list
 * the page could miss a spending right, so it never falls back to counting fewer of them.
 */
export const unreadable = (error: unknown): Proof =>
  notVerified([
    'This could not be verified: the RPC did not answer every read the proof needs, so the page ' +
      'cannot rule out a spending right it did not see.',
    `The RPC said: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
  ])

/** One hot wallet's daily right: what it can still draw before its reset, then its cap again. */
export interface Draw {
  wallet: string
  left: bigint
  cap: bigint
  resetsAt: Date
}

export interface Window {
  draws: Draw[]
  balance: bigint
  format: (amount: bigint) => string
  facts: string[]
  verifiedBy: string
}

/**
 * The most the agents can draw in the next 24 hours: for each hot wallet, what is left before its
 * reset and the whole cap again after it, which always falls within a day. With agent wallets
 * (CR-022) each draws on its own, so the rights add up. The vault's balance bounds them all.
 */
export function window({ draws, balance, format, facts, verifiedBy }: Window): Proof {
  const day = draws.reduce((sum, d) => sum + d.left + d.cap, 0n)
  const most = day < balance ? day : balance
  const one = draws.length === 1
  return {
    verified: true,
    title:
      `The most ${one ? 'this agent' : "this deployment's agents"} can draw in the next 24 ` +
      `hours: ${format(most)}`,
    lines: [
      verifiedBy,
      ...draws.map(
        (d) =>
          `${one ? 'Left' : `${d.wallet}: left`} until ${d.resetsAt.toISOString()}: ` +
          `${format(d.left)}. Then the daily cap again: ${format(d.cap)}.`,
      ),
      ...facts,
      ...(balance < day ? ['The vault holds less than that, so the vault is the limit.'] : []),
    ],
  }
}

export interface SolanaProofRequest {
  cluster: string
  multisig: PublicKey
  /**
   * The deployment's hot wallets, shared and per agent (CR-022), fixed when the page was built, as
   * is the mint: never taken from the link, which could pass off an attacker's limit as an agent's.
   */
  hotWallets: PublicKey[]
  usdc: PublicKey
}

const usdcText = (amount: bigint) => `${formatUnits(amount, USDC_DECIMALS)} USDC`

/**
 * How much the hot wallets can draw from a Squads vault, read from the chain. Every spending limit
 * on the multisig counts, not only the ones the adapters derive: a limit naming anyone else is a key
 * that can draw too.
 */
export async function proveSolana(
  connection: Connection,
  request: SolanaProofRequest,
  now = Date.now(),
): Promise<Proof> {
  const { cluster, hotWallets, usdc } = request
  const ms = decode(await connection.getAccountInfo(request.multisig), multisig.accounts.Multisig)
  if (!ms) {
    return notVerified([
      `There is no Squads multisig at ${request.multisig.toBase58()} on ${cluster}.`,
    ])
  }
  const [vault] = multisig.getVaultPda({ multisigPda: request.multisig, index: VAULT_INDEX })
  const [limits, balance] = await Promise.all([
    spendingLimits(connection, request.multisig),
    vaultBalance(connection, usdc, vault),
  ])
  const facts = [
    `Multisig ${request.multisig.toBase58()} on ${cluster}. Owner (config authority): ` +
      `${ms.configAuthority.toBase58()}. Members: ${list(ms.members.map((m) => m.key))}, ` +
      `threshold ${ms.threshold}.`,
    `Vault ${vault.toBase58()} holds ${usdcText(balance)}.`,
  ]
  const problems = [
    ...ownerProblems(ms, hotWallets),
    ...limits.flatMap((l) => limitProblems(l, request)),
  ]
  if (problems.length > 0) {
    return notVerified([
      `This multisig is not only its owner's, with ${walletsText(hotWallets)} drawing USDC into ` +
        'itself under its own daily limit, so this page cannot say how much can be drawn.',
      ...problems,
      ...facts,
    ])
  }
  if (limits.length === 0) {
    return {
      verified: true,
      title: 'The most this agent can draw in the next 24 hours: 0 USDC',
      lines: [
        `No spending limit: ${hotWallets.length === 1 ? 'the hot wallet cannot' : 'no hot wallet can'} ` +
          'draw from the vault. This is how a multisig looks after a kill, or before a limit is added.',
        ...facts,
      ],
    }
  }
  const draws = limits.map(({ limit }) => ({
    wallet: limit.members[0]!.toBase58(),
    ...today(limit, BigInt(Math.floor(now / 1000))),
    cap: BigInt(limit.amount.toString()),
  }))
  const [first] = limits
  return window({
    draws,
    balance,
    format: usdcText,
    facts,
    verifiedBy:
      limits.length === 1
        ? `Verified from the chain: one daily spending limit, ${first!.address.toBase58()}, lets ` +
          `only the hot wallet ${draws[0]!.wallet} draw, and only into itself.`
        : `Verified from the chain: ${limits.length} daily spending limits, one per hot wallet of ` +
          'this deployment, each letting only its own wallet draw, and only into itself.',
  })
}

const walletsText = (keys: PublicKey[]) =>
  keys.length === 1 ? `the hot wallet ${keys[0]!.toBase58()}` : `its hot wallets ${list(keys)} each`

/** Only the owner may run the multisig, and no hot wallet may be that owner. */
function ownerProblems(ms: multisig.accounts.Multisig, hotWallets: PublicKey[]): string[] {
  const owner = ms.configAuthority
  const problems = []
  if (hotWallets.some((key) => key.equals(owner))) {
    const which = hotWallets.length === 1 ? 'The hot wallet' : 'A hot wallet'
    problems.push(`${which} is the config authority: it can change the limits itself.`)
  }
  if (ms.members.length !== 1 || !ms.members[0]!.key.equals(owner)) {
    problems.push(
      `Its members are ${list(ms.members.map((m) => m.key))}, not only the config authority: ` +
        'members can move the vault through proposals.',
    )
  }
  return problems
}

interface Found {
  address: PublicKey
  limit: multisig.accounts.SpendingLimit
}

/** A limit must be one hot wallet's own: at the address derived from it, for it alone. */
function limitProblems({ address, limit }: Found, request: SolanaProofRequest): string[] {
  const { hotWallets, usdc } = request
  const hotWallet = hotWallets.find((key) =>
    address.equals(spendingLimitPda(request.multisig, key)),
  )
  const own = hotWallet ? [hotWallet] : hotWallets
  const only = (keys: PublicKey[]) => keys.length === 1 && own.some((key) => keys[0]!.equals(key))
  const found = []
  if (!hotWallet) {
    found.push(
      hotWallets.length === 1
        ? 'it is not the hot wallet limit the agent uses'
        : 'it is not the limit of any hot wallet of this deployment',
    )
  }
  if (!only(limit.members)) found.push(`its members are ${list(limit.members)}`)
  if (!only(limit.destinations)) found.push(`its destinations are ${list(limit.destinations)}`)
  if (!limit.mint.equals(usdc)) found.push(`its token is ${limit.mint.toBase58()}, not USDC`)
  if (limit.period !== multisig.generated.Period.Day) found.push('it does not reset daily')
  if (limit.vaultIndex !== VAULT_INDEX) found.push(`it draws on vault ${limit.vaultIndex}`)
  return found.length ? [`Spending limit ${address.toBase58()}: ${found.join('; ')}.`] : []
}

function today(limit: multisig.accounts.SpendingLimit, nowS: bigint) {
  const { left, resetsAtS } = currentPeriod(
    {
      cap: BigInt(limit.amount.toString()),
      remaining: BigInt(limit.remainingAmount.toString()),
      lastResetS: BigInt(limit.lastReset.toString()),
    },
    nowS,
  )
  return { left, resetsAt: seconds(resetsAtS) }
}

const seconds = (s: bigint) => new Date(Number(s) * 1000)
const list = (keys: PublicKey[]) => keys.map((key) => key.toBase58()).join(', ') || '(any)'

/** Every Squads spending limit whose multisig field is this one. */
async function spendingLimits(connection: Connection, multisigPda: PublicKey): Promise<Found[]> {
  const accounts = await connection.getProgramAccounts(multisig.PROGRAM_ID, {
    filters: [
      {
        memcmp: {
          offset: 0,
          encoding: 'base64',
          bytes: Buffer.from(multisig.accounts.spendingLimitDiscriminator).toString('base64'),
        },
      },
      { memcmp: { offset: 8, bytes: multisigPda.toBase58() } },
    ],
  })
  return accounts.map(({ pubkey, account }) => ({
    address: pubkey,
    limit: multisig.accounts.SpendingLimit.fromAccountInfo(account)[0],
  }))
}

async function vaultBalance(connection: Connection, usdc: PublicKey, vault: PublicKey) {
  const info = await connection.getAccountInfo(getAssociatedTokenAddressSync(usdc, vault, true))
  return info ? AccountLayout.decode(info.data).amount : 0n
}
