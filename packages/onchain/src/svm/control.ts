import { PublicKey } from '@solana/web3.js'
import * as multisig from '@sqds/multisig'
import type { Control } from '../ChainAdapter.js'

const { Permission, Permissions } = multisig.types

/**
 * A config authority can add itself a spending limit and empty the vault without a vote, so a
 * controlled multisig is held by that one key whatever its threshold says. Only voters count
 * towards an autonomous multisig's threshold.
 */
export function squadsControl(account: multisig.accounts.Multisig): Control {
  if (!account.configAuthority.equals(PublicKey.default)) return { threshold: 1, signers: 1 }
  const voters = account.members.filter((m) => Permissions.has(m.permissions, Permission.Vote))
  return { threshold: account.threshold, signers: voters.length }
}
