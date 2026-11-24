import { CHAINS } from '@defimind/shared'
import {
  Keypair,
  LAMPORTS_PER_SOL,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from '@solana/web3.js'
import { beforeEach, describe, expect, it } from 'vitest'
import { MEMO_PROGRAM_ID, memoOf, svmAnchor } from '../src/svm/anchor.js'
import { liteConnection } from './litesvm.js'
import { Svm } from './svm.js'

const MEMO = `defimind:anchor:v1:1-1000:${'ab'.repeat(32)}`

let svm: Svm
let connection: Connection
let key: Keypair

beforeEach(() => {
  svm = new Svm()
  connection = liteConnection(svm)
  key = Keypair.generate()
  svm.airdrop(key.publicKey, BigInt(LAMPORTS_PER_SOL))
})

const anchor = () => svmAnchor({ chain: CHAINS.solanaDevnet, connection, key })

function send(instructions: TransactionInstruction[]) {
  const message = new TransactionMessage({
    payerKey: key.publicKey,
    recentBlockhash: svm.latestBlockhash(),
    instructions,
  }).compileToV0Message()
  const tx = new VersionedTransaction(message)
  tx.sign([key])
  return connection.sendRawTransaction(tx.serialize())
}

const memo = (text: string) =>
  new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(text) })

describe('the Solana anchor', () => {
  it('publishes the memo in one confirmed transaction the anchor key signs and pays for', async () => {
    const before = svm.getBalance(key.publicKey)!
    const txId = await anchor().publish(MEMO)
    expect(await memoOf(connection, txId)).toEqual({ memo: MEMO, signer: key.publicKey.toBase58() })
    expect(svm.getBalance(key.publicKey)).toBeLessThan(before)
  })

  it('fails when the anchor key cannot pay the fee', async () => {
    key = Keypair.generate()
    await expect(anchor().publish(MEMO)).rejects.toThrow()
  })

  it('refuses a chain that is not Solana', () => {
    expect(() => svmAnchor({ chain: CHAINS.base, connection, key })).toThrow(/invalid_chain/)
  })
})

describe('reading a memo back', () => {
  it('gives undefined for a transaction it cannot find', async () => {
    expect(await memoOf(connection, '1'.repeat(64))).toBeUndefined()
  })

  it('gives undefined for a transaction with no memo, or with two', async () => {
    expect(await memoOf(connection, await send([]))).toBeUndefined()
    expect(await memoOf(connection, await send([memo('a'), memo('b')]))).toBeUndefined()
  })

  it('gives undefined for a transaction that failed', async () => {
    const txId = await anchor().publish(MEMO)
    const failed = {
      getTransaction: async () => ({
        ...(await connection.getTransaction(txId, { maxSupportedTransactionVersion: 0 })),
        meta: { err: { InstructionError: [0, 'Custom'] } },
      }),
    } as unknown as Connection
    expect(await memoOf(failed, txId)).toBeUndefined()
  })
})
