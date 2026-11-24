import type { RejectCode } from '@defimind/shared'
import {
  ExtensionType,
  getExtensionTypes,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackMint,
} from '@solana/spl-token'
import type { AccountInfo, PublicKey } from '@solana/web3.js'

/**
 * Token-2022 extensions that change nothing about holding or selling the token. Every other one is a
 * risk: a transfer fee or hook taxes or blocks the sell, a permanent delegate can take the tokens,
 * a default frozen state or a pause can lock them. An extension this list does not name, including
 * one added to the program later, is a risk too.
 */
const HARMLESS = new Set<ExtensionType>([
  ExtensionType.MetadataPointer,
  ExtensionType.TokenMetadata,
  ExtensionType.GroupPointer,
  ExtensionType.TokenGroup,
  ExtensionType.GroupMemberPointer,
  ExtensionType.TokenGroupMember,
  ExtensionType.MintCloseAuthority,
])

export interface MintFacts {
  decimals: number
  freezeAuthority: boolean
  /** The Token-2022 extensions by name, harmless ones included. */
  extensions: string[]
  /** TOKEN_FREEZABLE and TOKEN_EXTENSION_RISK: each rejects a buy. */
  risks: RejectCode[]
  /** The mint can still be inflated: the buy goes to the owner. */
  mintAuthority: boolean
}

/** What a mint account says about the token, read from the chain and nothing else. */
export function mintFacts(address: PublicKey, info: AccountInfo<Buffer> | null): MintFacts {
  if (!info) throw new Error(`not_a_mint: no account at ${address.toBase58()}`)
  const program = info.owner
  if (!program.equals(TOKEN_PROGRAM_ID) && !program.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error(`not_a_mint: ${address.toBase58()} is owned by ${program.toBase58()}`)
  }
  const mint = unpackMint(address, info, program)
  const types = getExtensionTypes(mint.tlvData)
  const risks: RejectCode[] = []
  if (mint.freezeAuthority) risks.push('TOKEN_FREEZABLE')
  if (types.some((type) => !HARMLESS.has(type))) risks.push('TOKEN_EXTENSION_RISK')
  return {
    decimals: mint.decimals,
    freezeAuthority: mint.freezeAuthority !== null,
    extensions: types.map((type) => ExtensionType[type] ?? `Unknown${type}`),
    risks,
    mintAuthority: mint.mintAuthority !== null,
  }
}
