import { USDC_DECIMALS } from '@defimind/shared'
import { AccountLayout, getAssociatedTokenAddressSync } from '@solana/spl-token'
import type { Connection, PublicKey } from '@solana/web3.js'
import * as multisig from '@sqds/multisig'
import { VAULT_INDEX } from '../../src/svm/squads.js'
import { formatUnits, transferInstructions } from '../../src/svm/transfer.js'
import { decode, refused, type Plan } from './plan.js'

export interface DepositRequest {
  cluster: string
  multisig: PublicKey
  /** USDC for the cluster, from the page's config; never taken from the link. */
  usdc: PublicKey
}

const usdcText = (amount: bigint) => `${formatUnits(amount, USDC_DECIMALS)} USDC`

/**
 * A plain USDC transfer from the connected wallet into the multisig's vault, which the chain names,
 * not the link. Only a member may deposit: a link handed to anyone else would have them fund a vault
 * they cannot see into. The transfer grants nothing: no delegate, no approval, no authority.
 * `amount` is asked only once the wallet is known to be a member.
 */
export async function prepareDeposit(
  connection: Connection,
  request: DepositRequest,
  owner: PublicKey,
  amount: () => Promise<bigint>,
): Promise<Plan> {
  const { cluster, usdc } = request
  const ms = decode(await connection.getAccountInfo(request.multisig), multisig.accounts.Multisig)
  if (!ms) {
    return refused(`There is no Squads multisig at ${request.multisig.toBase58()} on ${cluster}.`)
  }
  if (!ms.members.some((member) => member.key.equals(owner))) {
    return refused(
      `The connected wallet ${owner.toBase58()} is not a member of multisig ` +
        `${request.multisig.toBase58()}. Connect the owner wallet and open the link again.`,
    )
  }
  const [vault] = multisig.getVaultPda({ multisigPda: request.multisig, index: VAULT_INDEX })
  const source = getAssociatedTokenAddressSync(usdc, owner)
  const destination = getAssociatedTokenAddressSync(usdc, vault, true)
  const [held, before] = await Promise.all([
    balance(connection, source),
    balance(connection, destination),
  ])
  const value = await amount()
  if (held < value) {
    return refused(`Your wallet holds ${usdcText(held)}, less than ${usdcText(value)}.`)
  }
  const pay = { feePayer: owner, hotWallet: owner, recipient: vault, mint: usdc, amount: value }
  const missing = (await connection.getAccountInfo(destination)) === null
  return {
    kind: 'sign',
    title: 'Deposit into the vault',
    instructions: transferInstructions({ ...pay, decimals: USDC_DECIMALS }, missing),
    coSigners: [],
    after: 'Deposited',
    summary: [
      `Deposit: ${usdcText(value)} into vault ${vault.toBase58()}.`,
      `The vault of multisig ${request.multisig.toBase58()}, on ${cluster}. Token ` +
        `${usdc.toBase58()}.`,
      ...(missing ? ["The vault's USDC account is created first, paid by your wallet."] : []),
      'A plain transfer: it gives no one any right over your wallet.',
      `Phantom should show ${usdcText(value)} leaving your wallet, and a little SOL for the fee. ` +
        'Reject anything else.',
    ],
    landed: async () => {
      const after = await balance(connection, destination)
      return after >= before + value
        ? [`Vault ${vault.toBase58()} now holds ${usdcText(after)}.`]
        : undefined
    },
  }
}

async function balance(connection: Connection, account: PublicKey) {
  const info = await connection.getAccountInfo(account)
  return info ? AccountLayout.decode(info.data).amount : 0n
}
