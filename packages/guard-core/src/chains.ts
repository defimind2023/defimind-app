import { createEvmAdapter, createSvmAdapter, type ChainAdapter } from '@defimind/onchain'
import type { ChainId } from '@defimind/shared'
import { CHAINS, getAddress, requireAddress, signCluster, usdSymbol } from '@defimind/shared'
import { rpcUrls } from '@defimind/onchain/sign-page'
import { checkContracts } from './adapters/evm-check.js'
import { readEvmKeyFile, readKeypairFile } from './adapters/keypair.js'
import { StubChain } from './adapters/stub.js'
import type { Config } from './config.js'

/**
 * One adapter per chain that has its vault. A chain with a vault but another value missing stops
 * the start rather than running without it: a guard that quietly drops a chain looks healthy and
 * pays nothing, or worse, is fixed later by someone guessing. A chain without a vault is waiting for
 * the owner to adopt one (CR-019) and has no adapter until then.
 */
export async function buildChains(
  config: Config,
  fetchImpl: typeof fetch = fetch,
): Promise<Map<ChainId, ChainAdapter>> {
  const chains = new Map<ChainId, ChainAdapter>()
  if (config.GUARD_STUB_CHAINS === 'true') {
    chains.set(config.SOLANA_CHAIN, new StubChain(config.SOLANA_CHAIN, 100_000_000n))
    return chains
  }

  const multisig = config.SQUADS_MULTISIG
  if (multisig !== undefined) {
    const { SOLANA_RPC_URL: rpcUrl, SOLANA_HOT_WALLET_KEYPAIR: keypair } = required({
      SOLANA_RPC_URL: config.SOLANA_RPC_URL ?? publicRpc(config.SOLANA_CHAIN),
      SOLANA_HOT_WALLET_KEYPAIR: config.SOLANA_HOT_WALLET_KEYPAIR,
    })
    const chain = config.SOLANA_CHAIN
    chains.set(
      chain,
      createSvmAdapter({
        chain,
        rpcUrl,
        hotWalletSecretKey: await readKeypairFile(keypair),
        multisig,
        mint: requireAddress(chain, 'usd'),
      }),
    )
  }

  if (config.BASE_CHAIN !== undefined && config.SAFE_ADDRESS !== undefined) {
    const chain = config.BASE_CHAIN
    // A verified address in shared wins; the env value is only for a chain shared has none for.
    const values = required({
      BASE_RPC_URL: config.BASE_RPC_URL,
      SAFE_ADDRESS: config.SAFE_ADDRESS,
      BASE_HOT_WALLET_KEY_FILE: config.BASE_HOT_WALLET_KEY_FILE,
      BASE_USDC: usdcFor(config, chain),
      BASE_ALLOWANCE_MODULE: getAddress(chain, 'allowanceModule') ?? config.BASE_ALLOWANCE_MODULE,
    })
    chains.set(
      chain,
      await evmChain(
        chain,
        {
          rpcUrl: values.BASE_RPC_URL,
          rpcName: 'BASE_RPC_URL',
          keyFile: values.BASE_HOT_WALLET_KEY_FILE,
          safe: { name: 'SAFE_ADDRESS', address: values.SAFE_ADDRESS },
          usd: { name: 'BASE_USDC', address: values.BASE_USDC },
          module: { name: 'BASE_ALLOWANCE_MODULE', address: values.BASE_ALLOWANCE_MODULE },
        },
        fetchImpl,
      ),
    )
  }

  if (config.ROBINHOOD_CHAIN !== undefined && config.ROBINHOOD_SAFE_ADDRESS !== undefined) {
    const chain = config.ROBINHOOD_CHAIN
    const values = required({
      ROBINHOOD_RPC_URL: config.ROBINHOOD_RPC_URL ?? publicRpc(chain),
      ROBINHOOD_SAFE_ADDRESS: config.ROBINHOOD_SAFE_ADDRESS,
      ROBINHOOD_HOT_WALLET_KEY_FILE: config.ROBINHOOD_HOT_WALLET_KEY_FILE,
    })
    // CR-007: the dollar here is Paxos's USDG, and tokens named USDC are copies. Its address comes
    // from shared alone; there is no env value that could point at another token.
    chains.set(
      chain,
      await evmChain(
        chain,
        {
          rpcUrl: values.ROBINHOOD_RPC_URL,
          rpcName: 'ROBINHOOD_RPC_URL',
          keyFile: values.ROBINHOOD_HOT_WALLET_KEY_FILE,
          safe: { name: 'ROBINHOOD_SAFE_ADDRESS', address: values.ROBINHOOD_SAFE_ADDRESS },
          usd: { name: `shared usd for ${chain}`, address: requireAddress(chain, 'usd') },
          module: {
            name: `shared allowanceModule for ${chain}`,
            address: requireAddress(chain, 'allowanceModule'),
          },
        },
        fetchImpl,
      ),
    )
  }
  return chains
}

/**
 * An agent's own wallet (CR-022): the chain's adapter on the same vault, with the agent's key as
 * its hot wallet. Built from a config holding that chain alone, so no other chain is checked.
 */
export async function buildAgentChain(
  config: Config,
  chain: ChainId,
  keyFile: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ChainAdapter> {
  const only = (id: ChainId | undefined, value: string | undefined) =>
    id === chain ? value : undefined
  const solo: Config = {
    ...config,
    SQUADS_MULTISIG: only(config.SOLANA_CHAIN, config.SQUADS_MULTISIG),
    SOLANA_HOT_WALLET_KEYPAIR: keyFile,
    SAFE_ADDRESS: only(config.BASE_CHAIN, config.SAFE_ADDRESS),
    BASE_HOT_WALLET_KEY_FILE: keyFile,
    ROBINHOOD_SAFE_ADDRESS: only(config.ROBINHOOD_CHAIN, config.ROBINHOOD_SAFE_ADDRESS),
    ROBINHOOD_HOT_WALLET_KEY_FILE: keyFile,
  }
  const adapter = (await buildChains(solo, fetchImpl)).get(chain)
  if (adapter === undefined) {
    throw new Error(`no vault on ${chain} for an agent wallet`)
  }
  return adapter
}

/**
 * The cluster's public RPC, the one /sign uses, for a chain whose RPC neither the env nor the panel
 * sets (CR-019): a one-click owner need not know what an RPC is. It is rate-limited, so a busy
 * deployment sets its own. Base has none.
 */
export function publicRpc(chain: ChainId): string | undefined {
  const cluster = signCluster(chain)
  return cluster === undefined ? undefined : rpcUrls({})[cluster]
}

const EVM_IDS = {
  [CHAINS.baseSepolia]: '84532',
  [CHAINS.base]: '8453',
  [CHAINS.robinhoodTestnet]: '46630',
  [CHAINS.robinhood]: '4663',
} as const

/**
 * An EVM adapter once the chain has answered for every address it will use: the Safe, the token
 * and the module each hold code, and the token has 6 decimals. Verified addresses are asked too: a
 * wrong RPC URL, pointing at another chain, fails here and not at the first payment.
 */
async function evmChain(
  chain: keyof typeof EVM_IDS,
  values: {
    rpcUrl: string
    rpcName: string
    keyFile: string
    safe: { name: string; address: string }
    usd: { name: string; address: string }
    module: { name: string; address: string }
  },
  fetchImpl: typeof fetch,
): Promise<ChainAdapter> {
  await checkContracts(
    { url: values.rpcUrl, name: values.rpcName },
    [values.safe, { ...values.usd, usd: usdSymbol(chain) ?? 'USDC' }, values.module],
    fetchImpl,
  )
  return createEvmAdapter({
    chain: EVM_IDS[chain],
    rpcUrl: values.rpcUrl,
    hotWalletKey: await readEvmKeyFile(values.keyFile),
    safe: values.safe.address,
    usdc: values.usd.address,
    module: values.module.address,
  })
}

/**
 * The USDC address guard-core uses on a chain: the verified one in shared/addresses.ts, else the
 * Base env fallback, which buildChains checks against the chain before the adapter is built. The
 * one resolver for both the adapter and the budget view, so they cannot name different tokens.
 */
export function usdcFor(config: Config, chain: ChainId): string | undefined {
  return getAddress(chain, 'usd') ?? (chain === config.BASE_CHAIN ? config.BASE_USDC : undefined)
}

/** Every value, or an error naming the absent ones. Names only: an RPC URL can carry an API key. */
function required<T extends Record<string, string | undefined>>(
  values: T,
): { [K in keyof T]: string } {
  const absent = Object.keys(values).filter((name) => values[name] === undefined)
  if (absent.length > 0) {
    throw new Error(`invalid configuration: ${absent.join(', ')}`)
  }
  return values as { [K in keyof T]: string }
}
