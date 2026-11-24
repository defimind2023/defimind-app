import type { PublicKey } from '@solana/web3.js'
import {
  AddressLookupTableProgram,
  Keypair,
  SystemProgram,
  TransactionMessage,
  type AddressLookupTableAccount,
  type VersionedMessage,
} from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { expand, SETTLED_SLOTS } from '../src/svm/swap/lookup.js'
import { chain } from './fixture.js'

const c = chain()
const payer = c.payer.publicKey
const hidden = Array.from({ length: 3 }, () => Keypair.generate().publicKey)

/**
 * A lookup table account as the program lays it out: type 1, deactivation and last-extended slots,
 * the start index, an authority, padding to 56 bytes, then the addresses.
 */
function table(lastExtendedSlot: bigint, deactivation = 2n ** 64n - 1n): PublicKey {
  const address = Keypair.generate().publicKey
  const meta = Buffer.alloc(56)
  meta.writeUInt32LE(1, 0)
  meta.writeBigUInt64LE(deactivation, 4)
  meta.writeBigUInt64LE(lastExtendedSlot, 12)
  meta.writeUInt8(0, 20)
  meta.writeUInt8(1, 21)
  payer.toBuffer().copy(meta, 22)
  const data = Buffer.concat([meta, ...hidden.map((key) => key.toBuffer())])
  c.svm.setAccount(address, {
    lamports: Number(c.svm.minimumBalanceForRentExemption(BigInt(data.length))),
    data,
    owner: AddressLookupTableProgram.programId,
    executable: false,
  })
  return address
}

const at = (slot: bigint) => c.svm.warpToSlot(slot)

/** A transfer to the table's second entry, compiled against the table. */
function message(address: PublicKey, entries = hidden): VersionedMessage {
  const lookup = {
    key: address,
    state: { addresses: entries },
  } as unknown as AddressLookupTableAccount
  return new TransactionMessage({
    payerKey: payer,
    recentBlockhash: c.svm.latestBlockhash(),
    instructions: [
      SystemProgram.transfer({ fromPubkey: payer, toPubkey: hidden[1]!, lamports: 1 }),
    ],
  }).compileToV0Message([lookup])
}

describe('lookup tables, read from the chain', () => {
  const address = table(1_000n)

  it('refuses a table changed in the last slots', async () => {
    at(1_000n + BigInt(SETTLED_SLOTS) - 1n)
    expect(await expand(c.connection, message(address))).toBeUndefined()
  })

  it('writes out every entry once the table has settled', async () => {
    at(1_000n + BigInt(SETTLED_SLOTS))
    const expanded = await expand(c.connection, message(address))
    expect(expanded?.instructions[0]?.keys.map((k) => k.pubkey.toBase58())).toEqual([
      payer.toBase58(),
      hidden[1]!.toBase58(),
    ])
  })

  it('refuses a table it cannot find, or an account that is not a table', async () => {
    expect(await expand(c.connection, message(Keypair.generate().publicKey))).toBeUndefined()
    expect(await expand(c.connection, message(payer))).toBeUndefined()
  })

  it('refuses an index past the end of the table', async () => {
    const longer = [...hidden, ...Array.from({ length: 4 }, () => Keypair.generate().publicKey)]
    const outside = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: c.svm.latestBlockhash(),
      instructions: [
        SystemProgram.transfer({ fromPubkey: payer, toPubkey: longer[6]!, lamports: 1 }),
      ],
    }).compileToV0Message([
      { key: address, state: { addresses: longer } } as unknown as AddressLookupTableAccount,
    ])
    expect(await expand(c.connection, outside)).toBeUndefined()
  })

  it('refuses a table being closed', async () => {
    at(5_000n)
    expect(await expand(c.connection, message(table(1_000n, 4_000n)))).toBeUndefined()
  })

  it('passes a message with no table through', async () => {
    const plain = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: c.svm.latestBlockhash(),
      instructions: [
        SystemProgram.transfer({ fromPubkey: payer, toPubkey: hidden[0]!, lamports: 1 }),
      ],
    }).compileToV0Message()
    expect((await expand(c.connection, plain))?.instructions).toHaveLength(1)
  })
})
