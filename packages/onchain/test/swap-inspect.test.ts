import {
  createApproveInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSetAuthorityInstruction,
  AuthorityType,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import {
  ComputeBudgetProgram,
  Keypair,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
} from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { inspectSwap, JUPITER_PROGRAM_ID } from '../src/svm/swap/inspect.js'

const key = () => Keypair.generate().publicKey
const hotWallet = key()
const tokenIn = key()
const tokenOut = key()
const sides = { hotWallet, tokenIn, tokenOut, amountIn: 10_000_000n, minAmountOut: 995_000n }
const inAccount = getAssociatedTokenAddressSync(tokenIn, hotWallet)

/** A Jupiter route instruction as v6 encodes it: discriminator, route plan, then its terms. */
function routeWith({
  discriminator = [229, 23, 203, 151, 122, 227, 173, 42],
  inAmount = 10_000_000n,
  quotedOut = 1_000_000n,
  slippageBps = 50,
  feeBps = 0,
} = {}) {
  const terms = Buffer.alloc(19)
  terms.writeBigUInt64LE(inAmount, 0)
  terms.writeBigUInt64LE(quotedOut, 8)
  terms.writeUInt16LE(slippageBps, 16)
  terms.writeUInt8(feeBps, 18)
  return new TransactionInstruction({
    programId: JUPITER_PROGRAM_ID,
    keys: [{ pubkey: hotWallet, isSigner: true, isWritable: true }],
    data: Buffer.concat([Buffer.from(discriminator), Buffer.from([1, 0, 0, 0, 9, 9, 9]), terms]),
  })
}
const route = routeWith()
const create = (mint = tokenOut, owner = hotWallet) =>
  createAssociatedTokenAccountIdempotentInstruction(
    hotWallet,
    getAssociatedTokenAddressSync(mint, owner, true),
    owner,
    mint,
  )
const budget = [
  ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
]

function check(instructions: TransactionInstruction[], payerKey = hotWallet) {
  const expanded = new TransactionMessage({
    payerKey,
    recentBlockhash: key().toBase58(),
    instructions,
  })
  return inspectSwap(expanded.compileToV0Message(), expanded, sides)
}

describe('a swap transaction, read before the test run', () => {
  it("passes Jupiter's shape: compute budget, the hot wallet's own account, one route", () => {
    expect(check([...budget, create(), route])).toEqual([])
  })

  it.each([
    [
      'an Approve on the hot wallet',
      createApproveInstruction(inAccount, key(), hotWallet, 1n),
      'DELEGATE_DETECTED',
    ],
    [
      'a SetAuthority',
      createSetAuthorityInstruction(inAccount, hotWallet, AuthorityType.AccountOwner, key()),
      'AUTHORITY_CHANGE_DETECTED',
    ],
    [
      'a CloseAccount',
      createCloseAccountInstruction(inAccount, key(), hotWallet),
      'ACCOUNT_CLOSE_DETECTED',
    ],
    [
      'an unknown program',
      new TransactionInstruction({ programId: key(), keys: [], data: Buffer.alloc(0) }),
      'UNKNOWN_PROGRAM_DETECTED',
    ],
    [
      'a System transfer',
      SystemProgram.transfer({ fromPubkey: hotWallet, toPubkey: key(), lamports: 1 }),
      'SIM_UNEXPECTED_EFFECT',
    ],
    ['an account created for someone else', create(tokenOut, key()), 'SIM_UNEXPECTED_EFFECT'],
    ['an account for another mint', create(key()), 'SIM_UNEXPECTED_EFFECT'],
    ['a second route', route, 'SIM_UNEXPECTED_EFFECT'],
  ])('refuses %s', (_case, extra, reason) => {
    expect(check([...budget, route, extra])).toContain(reason)
  })

  it('refuses no route at all, and another fee payer', () => {
    expect(check([...budget])).toEqual(['SIM_UNEXPECTED_EFFECT'])
    expect(check([route], key())).toContain('SIM_UNEXPECTED_EFFECT')
  })

  it('refuses a second signer', () => {
    const cosigned = new TransactionInstruction({
      ...route,
      keys: [...route.keys, { pubkey: key(), isSigner: true, isWritable: false }],
    })
    expect(check([cosigned])).toEqual(['SIM_UNEXPECTED_EFFECT'])
  })

  it('bounds the priority fee in lamports, and the compute limit', () => {
    const fee = (units: number, microLamports: number) => [
      ComputeBudgetProgram.setComputeUnitLimit({ units }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
      route,
    ]
    expect(check(fee(1_000_000, 1_000_000))).toEqual([])
    expect(check(fee(1_000_000, 1_000_001))).toEqual(['SIM_UNEXPECTED_EFFECT'])
    expect(check(fee(1_400_001, 1))).toEqual(['SIM_UNEXPECTED_EFFECT'])
    const heap = ComputeBudgetProgram.requestHeapFrame({ bytes: 64 * 1024 })
    expect(check([heap, route])).toEqual(['SIM_UNEXPECTED_EFFECT'])
  })

  it.each([
    [
      'slippage that lets it deliver less than the minimum',
      { slippageBps: 10_000 },
      'SLIPPAGE_TOO_HIGH',
    ],
    ['a quoted output below the minimum', { quotedOut: 999_000n }, 'SLIPPAGE_TOO_HIGH'],
    ['another input amount', { inAmount: 10_000_001n }, 'SIM_UNEXPECTED_EFFECT'],
    ['a platform fee', { feeBps: 1 }, 'SIM_UNEXPECTED_EFFECT'],
    [
      'a token-ledger route, whose amount is not in the instruction',
      { discriminator: [150, 86, 71, 116, 167, 93, 14, 104] },
      'SIM_UNEXPECTED_EFFECT',
    ],
    [
      'an exact-out route',
      { discriminator: [208, 51, 239, 151, 123, 43, 237, 92] },
      'SIM_UNEXPECTED_EFFECT',
    ],
  ])('refuses a route with %s', (_case, terms, reason) => {
    expect(check([routeWith(terms)])).toEqual([reason])
  })

  it('passes the shared-accounts route, and refuses one too short to hold its terms', () => {
    const shared = routeWith({ discriminator: [193, 32, 155, 51, 65, 214, 156, 129] })
    expect(check([shared])).toEqual([])
    const short = new TransactionInstruction({ ...route, data: route.data.subarray(0, 20) })
    expect(check([short])).toEqual(['SIM_UNEXPECTED_EFFECT'])
  })
})
