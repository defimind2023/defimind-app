import { isSvm, type ChainId } from '@defimind/shared'
import {
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from '@solana/web3.js'
import { confirm, connect } from './squads.js'

/** SPL Memo v2: it logs the data and, unlike v1, checks that every account passed has signed. */
export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')

/** Publishes a CR-013 anchor memo in one transaction the anchor key signs and pays for. */
export interface SvmAnchor {
  chain: ChainId
  publish(memo: string): Promise<string>
}

export function svmAnchor(deps: {
  chain: ChainId
  connection: Connection
  key: Keypair
}): SvmAnchor {
  const { chain, connection, key } = deps
  if (!isSvm(chain)) throw new Error(`invalid_chain: ${chain} is not a Solana chain`)
  return {
    chain,
    async publish(memo) {
      const { blockhash } = await connection.getLatestBlockhash()
      const message = new TransactionMessage({
        payerKey: key.publicKey,
        recentBlockhash: blockhash,
        // The key as a signer account binds the memo to it: Memo v2 fails unless it signed.
        instructions: [
          new TransactionInstruction({
            programId: MEMO_PROGRAM_ID,
            keys: [{ pubkey: key.publicKey, isSigner: true, isWritable: false }],
            data: Buffer.from(memo, 'utf8'),
          }),
        ],
      }).compileToV0Message()
      const tx = new VersionedTransaction(message)
      tx.sign([key])
      return confirm(connection, await connection.sendRawTransaction(tx.serialize()))
    },
  }
}

export function createSvmAnchor(config: {
  chain: ChainId
  rpcUrl: string
  /** The anchor key's 64-byte secret key, as solana-keygen writes it. Never the hot wallet's. */
  secretKey: Uint8Array
}): SvmAnchor {
  return svmAnchor({
    chain: config.chain,
    connection: connect(config.rpcUrl),
    key: Keypair.fromSecretKey(config.secretKey),
  })
}

/** What a confirmed transaction says: its one memo and the key that signed it. */
export interface Memo {
  memo: string
  signer: string
}

/**
 * Reads the memo back for defimind-verify. A failed transaction, or one with no memo or more than
 * one, gives undefined: an anchor is one memo in one transaction that landed.
 */
export async function memoOf(connection: Connection, txId: string): Promise<Memo | undefined> {
  const tx = await connection.getTransaction(txId, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  })
  if (!tx || tx.meta?.err !== null) return undefined
  const { message } = tx.transaction
  const keys = message.staticAccountKeys
  const memos = message.compiledInstructions.filter((ix) =>
    keys[ix.programIdIndex]?.equals(MEMO_PROGRAM_ID),
  )
  if (memos.length !== 1) return undefined
  return {
    memo: Buffer.from(memos[0]!.data).toString('utf8'),
    signer: keys[0]!.toBase58(),
  }
}

export async function readMemo(rpcUrl: string, txId: string): Promise<string | undefined> {
  return (await memoOf(connect(rpcUrl), txId))?.memo
}
