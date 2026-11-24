import type { ChainId } from '@defimind/shared'
import { privateKeyToAddress } from 'viem/accounts'
import type { Config } from '../config.js'
import { base58 } from '../domain/base58.js'
import { publicKeyHex } from '../service/receipts.js'
import { readEvmKeyFile, readKeypairFile, readReceiptKeyFile } from './keypair.js'

/** What GET /v1/owner/keys answers: public halves only (CR-019). */
export interface PublicKeys {
  hotWallets: { chain: ChainId; address: string }[]
  receiptKey?: string
  anchorKey?: string
}

/** A Solana keypair file holds the secret key, then the public key: the last 32 bytes. */
export async function solanaAddress(path: string): Promise<string> {
  return base58((await readKeypairFile(path)).slice(32))
}

/**
 * Every enabled chain's hot wallet, whether or not its vault is set yet: the owner needs the
 * address to name it in the vault's limit before guard-core can adopt the vault.
 */
export async function publicKeys(config: Config): Promise<PublicKeys> {
  const hotWallets: PublicKeys['hotWallets'] = []
  if (config.SOLANA_HOT_WALLET_KEYPAIR !== undefined) {
    hotWallets.push({
      chain: config.SOLANA_CHAIN,
      address: await solanaAddress(config.SOLANA_HOT_WALLET_KEYPAIR),
    })
  }
  const evm: [ChainId | undefined, string | undefined][] = [
    [config.BASE_CHAIN, config.BASE_HOT_WALLET_KEY_FILE],
    [config.ROBINHOOD_CHAIN, config.ROBINHOOD_HOT_WALLET_KEY_FILE],
  ]
  for (const [chain, file] of evm) {
    if (chain !== undefined && file !== undefined) {
      hotWallets.push({ chain, address: privateKeyToAddress(await readEvmKeyFile(file)) })
    }
  }
  const { RECEIPT_SIGNING_KEY_FILE: receipt, ANCHOR_KEY_FILE: anchor } = config
  return {
    hotWallets,
    ...(receipt === undefined
      ? {}
      : { receiptKey: publicKeyHex(await readReceiptKeyFile(receipt)) }),
    ...(anchor === undefined ? {} : { anchorKey: await solanaAddress(anchor) }),
  }
}
