import {
  Keypair,
  TransactionMessage,
  type Connection,
  type TransactionInstruction,
} from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import {
  addSpendingLimitInstruction,
  createMultisigInstruction,
  removeSpendingLimitInstruction,
  spendingLimitPda,
} from '../src/svm/squads.js'
import { transferInstructions } from '../src/svm/transfer.js'
import { cannotRead, decodeSolana } from '../web/src/decoded.js'
import { decodeEvm } from '../web/src/evm/decoded.js'

const key = () => Keypair.generate().publicKey
const owner = key()
const hot = key()
const mint = key()
const multisigPda = key()
const units = '2.5 (2500000 base units at 6 decimals)'
/** A chain where no token account exists yet. */
const empty = { getAccountInfo: async () => null } as unknown as Connection

const lines = (instructions: TransactionInstruction[], connection = empty) =>
  decodeSolana(
    connection,
    new TransactionMessage({
      payerKey: owner,
      recentBlockhash: key().toBase58(),
      instructions,
    }).compileToV0Message(),
  )
const decode = async (instructions: TransactionInstruction[]) =>
  (await lines(instructions)).map((line) => line.text)

describe('the Solana transaction, read from its bytes', () => {
  it('names who may draw, how much, in which token, how often and into what, on add-limit', async () => {
    const ix = addSpendingLimitInstruction(owner, {
      multisigPda,
      createKey: hot,
      mint,
      amount: 2_500_000n,
      members: [hot],
      destinations: [hot],
    })
    expect(await decode([ix])).toEqual([
      `Let ${hot.toBase58()} draw ${units} of token ${mint.toBase58()} from vault 0 every Day, ` +
        `into ${hot.toBase58()}.`,
    ])
  })

  it('names the limit the kill removes', async () => {
    const limit = spendingLimitPda(multisigPda, hot)
    expect(await decode([removeSpendingLimitInstruction(multisigPda, owner, limit)])).toEqual([
      `Remove spending limit ${limit.toBase58()}.`,
    ])
  })

  it('names the wallet a deposit pays, from the account the same transaction creates', async () => {
    const vault = key()
    const pay = { feePayer: owner, hotWallet: owner, recipient: vault, mint, amount: 2_500_000n }
    expect(await decode(transferInstructions({ ...pay, decimals: 6 }, true))).toEqual([
      `Create the token account of ${vault.toBase58()} for token ${mint.toBase58()}.`,
      `Send ${units} of token ${mint.toBase58()} to the token account of ${vault.toBase58()}.`,
    ])
  })

  it('formats a transfer with the decimals its own bytes carry', async () => {
    const vault = key()
    const pay = { feePayer: owner, hotWallet: owner, recipient: vault, mint, amount: 2_500_000n }
    const [, transfer] = transferInstructions({ ...pay, decimals: 9 }, true)
    expect((await decode([transfer!]))[0]).toMatch(
      /^Send 0\.0025 \(2500000 base units at 9 decimals\)/,
    )
  })

  it('names the multisig a create makes', async () => {
    expect(await decode([createMultisigInstruction(owner, key(), key())])).toEqual([
      `Create a multisig run by ${owner.toBase58()}, members ${owner.toBase58()}, threshold 1.`,
    ])
  })

  it('says it cannot read anything else', async () => {
    const program = key()
    const ix = { programId: program, keys: [], data: Buffer.from([1]) } as TransactionInstruction
    expect(await decode([ix])).toEqual([
      `An instruction for ${program.toBase58()} this page cannot read: reject this transaction.`,
    ])
  })

  it('flags a transaction with any unreadable line, on either chain, and none of ours', async () => {
    const program = key()
    const ix = { programId: program, keys: [], data: Buffer.from([1]) } as TransactionInstruction
    expect(cannotRead(await lines([ix]))).toBe(true)
    expect(cannotRead(decodeEvm('0x0000000000000000000000000000000000000001', '0xdeadbeef'))).toBe(
      true,
    )
    const limit = spendingLimitPda(multisigPda, hot)
    expect(
      cannotRead(await lines([removeSpendingLimitInstruction(multisigPda, owner, limit)])),
    ).toBe(false)
  })
})
