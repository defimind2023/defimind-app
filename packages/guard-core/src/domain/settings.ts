import type { ChainId } from '@defimind/shared'
import type { Config } from '../config.js'

export type Field = 'rpcUrl' | 'vault'

export interface ChainSetting {
  chain: ChainId
  rpcUrl?: string
  vault?: string
}

type Key = keyof Config & string

/** Where each enabled chain keeps its RPC and its vault in the config. */
export function settingKeys(config: Config): { chain: ChainId; rpcUrl: Key; vault: Key }[] {
  return [
    { chain: config.SOLANA_CHAIN, rpcUrl: 'SOLANA_RPC_URL', vault: 'SQUADS_MULTISIG' } as const,
    ...(config.BASE_CHAIN === undefined
      ? []
      : [{ chain: config.BASE_CHAIN, rpcUrl: 'BASE_RPC_URL', vault: 'SAFE_ADDRESS' } as const]),
    ...(config.ROBINHOOD_CHAIN === undefined
      ? []
      : [
          {
            chain: config.ROBINHOOD_CHAIN,
            rpcUrl: 'ROBINHOOD_RPC_URL',
            vault: 'ROBINHOOD_SAFE_ADDRESS',
          } as const,
        ]),
  ]
}

/** The fields the env sets for a chain. Those always win, so the panel cannot change them. */
export function fromEnv(env: Config, chain: ChainId): Field[] {
  const keys = settingKeys(env).find((k) => k.chain === chain)
  if (keys === undefined) {
    return []
  }
  return (['rpcUrl', 'vault'] as const).filter((field) => env[keys[field]] !== undefined)
}

/** The env with each stored value filled in where the env leaves it unset. */
export function applySettings(env: Config, stored: ChainSetting[]): Config {
  const config: Record<string, unknown> = { ...env }
  for (const keys of settingKeys(env)) {
    const setting = stored.find((s) => s.chain === keys.chain)
    for (const field of ['rpcUrl', 'vault'] as const) {
      const value = setting?.[field]
      if (value !== undefined && config[keys[field]] === undefined) {
        config[keys[field]] = value
      }
    }
  }
  return config as Config
}

/** The stored settings with `changes` laid over them, field by field. */
export function mergeSettings(stored: ChainSetting[], changes: ChainSetting[]): ChainSetting[] {
  const merged = new Map(stored.map((s) => [s.chain, { ...s }]))
  for (const change of changes) {
    merged.set(change.chain, { ...merged.get(change.chain), ...change })
  }
  return [...merged.values()]
}
