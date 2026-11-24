import type { KillTarget } from '@defimind/shared'
import { readKeypairFile } from './adapters/keypair.js'
import type { Config } from './config.js'
import { base58 } from './domain/base58.js'

/**
 * The chains whose onchain kill the signing page can build (CR-014), from guard-core's own
 * config: the Squads multisig and the hot wallet's public key on Solana, the Safe on Robinhood
 * Chain. Every value is public; the page checks the chain before it asks for a signature.
 */
export async function killTargets(config: Config): Promise<KillTarget[]> {
  const targets: KillTarget[] = []
  if (config.SQUADS_MULTISIG !== undefined && config.SOLANA_HOT_WALLET_KEYPAIR !== undefined) {
    // A Solana keypair file holds the secret key, then the public key: the last 32 bytes.
    const secret = await readKeypairFile(config.SOLANA_HOT_WALLET_KEYPAIR)
    const hot = base58(secret.slice(32))
    targets.push({ chain: config.SOLANA_CHAIN, multisig: config.SQUADS_MULTISIG, hot })
  }
  if (config.ROBINHOOD_CHAIN !== undefined && config.ROBINHOOD_SAFE_ADDRESS !== undefined) {
    targets.push({ chain: config.ROBINHOOD_CHAIN, safe: config.ROBINHOOD_SAFE_ADDRESS })
  }
  return targets
}
