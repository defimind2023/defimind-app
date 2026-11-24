import type { KillTarget } from '@defimind/shared'
import type { Config } from '../config.js'

/**
 * Each chain's onchain kill. loadConfig refuses a half-configured chain, so a chain is either
 * complete here or left out. On EVM the hot wallet goes in whenever it is known: the hosted page
 * needs it, and a page built with that same one accepts it.
 */
export function killTargets(config: Config): KillTarget[] {
  const { SQUADS_MULTISIG, SOLANA_HOT_WALLET_PUBKEY, ROBINHOOD_SAFE_ADDRESS } = config
  const hot = config.ROBINHOOD_HOT_WALLET_ADDRESS
  return [
    ...(SQUADS_MULTISIG && SOLANA_HOT_WALLET_PUBKEY
      ? [{ chain: config.SOLANA_CHAIN, multisig: SQUADS_MULTISIG, hot: SOLANA_HOT_WALLET_PUBKEY }]
      : []),
    ...(ROBINHOOD_SAFE_ADDRESS
      ? [{ chain: config.ROBINHOOD_CHAIN, safe: ROBINHOOD_SAFE_ADDRESS, ...(hot ? { hot } : {}) }]
      : []),
  ]
}
