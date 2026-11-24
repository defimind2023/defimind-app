import { CHAINS } from '@defimind/shared'

const NAMES = new Map<string, string>([
  [CHAINS.solanaMainnet, 'Solana'],
  [CHAINS.solanaDevnet, 'Solana devnet'],
  [CHAINS.base, 'Base'],
  [CHAINS.baseSepolia, 'Base Sepolia'],
  [CHAINS.robinhood, 'Robinhood Chain'],
  [CHAINS.robinhoodTestnet, 'Robinhood Chain testnet'],
])

/** A chain the panel does not know is shown by its id, never guessed. */
export function chainName(chain: string): string {
  return NAMES.get(chain) ?? chain
}

const NETWORKS = new Map<string, 'Mainnet' | 'Devnet' | 'Testnet'>([
  [CHAINS.solanaMainnet, 'Mainnet'],
  [CHAINS.base, 'Mainnet'],
  [CHAINS.robinhood, 'Mainnet'],
  [CHAINS.solanaDevnet, 'Devnet'],
  [CHAINS.baseSepolia, 'Testnet'],
  [CHAINS.robinhoodTestnet, 'Testnet'],
])

/**
 * The network the header names: Mainnet only when every chain is one, so test money is never
 * shown as real. Undefined with no chain, or with one the panel does not know.
 */
export function networkOf(chains: string[]): 'Mainnet' | 'Devnet' | 'Testnet' | undefined {
  const kinds = chains.map((chain) => NETWORKS.get(chain))
  if (kinds.length === 0 || kinds.includes(undefined)) {
    return undefined
  }
  return kinds.includes('Devnet') ? 'Devnet' : kinds.includes('Testnet') ? 'Testnet' : 'Mainnet'
}
