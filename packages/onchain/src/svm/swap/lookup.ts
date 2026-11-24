import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  TransactionMessage,
  type Connection,
  type VersionedMessage,
} from '@solana/web3.js'

/** A table changed this recently could have been swapped under the quote (SPEC v0.16, step 3). */
export const SETTLED_SLOTS = 150
const ACTIVE = 2n ** 64n - 1n

/**
 * The message with every lookup table entry written out, so the inspection sees every account the
 * transaction touches. The tables are read from the chain, never taken from the venue. A table that
 * is missing, not a lookup table, being closed, or changed in the last SETTLED_SLOTS slots makes the
 * whole message unreadable: undefined, which is HIDDEN_ACCOUNTS_DETECTED.
 */
export async function expand(
  connection: Connection,
  message: VersionedMessage,
): Promise<TransactionMessage | undefined> {
  const keys = message.addressTableLookups.map((lookup) => lookup.accountKey)
  const [slot, infos] = await Promise.all([
    connection.getSlot('confirmed'),
    keys.length ? connection.getMultipleAccountsInfo(keys) : Promise.resolve([]),
  ])
  const tables: AddressLookupTableAccount[] = []
  for (const [i, info] of infos.entries()) {
    if (!info?.owner.equals(AddressLookupTableProgram.programId)) return undefined
    let state
    try {
      state = AddressLookupTableAccount.deserialize(info.data)
    } catch {
      return undefined
    }
    const settled = BigInt(slot) - BigInt(state.lastExtendedSlot) >= SETTLED_SLOTS
    if (state.deactivationSlot !== ACTIVE || !settled) return undefined
    tables.push(new AddressLookupTableAccount({ key: keys[i]!, state }))
  }
  try {
    return TransactionMessage.decompile(message, { addressLookupTableAccounts: tables })
  } catch {
    // An index past the end of a table: the venue named an account the table does not hold.
    return undefined
  }
}
