import type { ChainAdapter } from '@defimind/onchain'
import type { ChainId } from '@defimind/shared'
import type { FastifyInstance } from 'fastify'
import { usdcFor } from '../chains.js'
import type { Config } from '../config.js'
import * as repo from '../db/repo.js'
import { readSettings, writeSettings } from '../db/settings.js'
import {
  applySettings,
  type ChainSetting,
  fromEnv,
  mergeSettings,
  settingKeys,
} from '../domain/settings.js'
import type { X402Deps } from '../service/x402.js'
import { HttpError } from './errors.js'
import { ownerSettings } from './schemas.js'

/** How guard-core rebuilds its chains once the owner changes a setting (CR-019). */
export interface ChainHost {
  /** The env, with key files: what a stored setting may only fill in. */
  env: Config
  build: (config: Config) => Promise<Map<ChainId, ChainAdapter>>
  /** Runs after a change is adopted, with the config now in force. */
  changed?: (config: Config) => Promise<void>
}

const VAULT = {
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  eip155: /^0x[0-9a-fA-F]{40}$/,
}

export function ownerSettingsRoutes(
  deps: X402Deps,
  host: ChainHost,
  stepUp: (action: 'change_settings', body: unknown, assertion: unknown) => Promise<string>,
) {
  const { db, now } = deps
  // One change at a time: each rebuilds every chain from what the one before it stored.
  let queue = Promise.resolve()

  async function adopt(changes: ChainSetting[], passkey: string) {
    const stored = mergeSettings(readSettings(db), changes)
    const config = applySettings(host.env, stored)
    const chains = await host.build(config).catch((error: unknown) => {
      deps.log.warn({ err: error }, 'settings refused: the chains did not build')
      throw error instanceof Error && error.message.startsWith('invalid configuration')
        ? new HttpError(400, 'settings_incomplete')
        : new HttpError(422, 'vault_not_ours')
    })
    for (const { chain } of changes) {
      const adapter = chains.get(chain)
      // Only an active limit or allowance for this hot wallet makes the vault ours (ADR 006).
      const state = await adapter?.getAllowanceState().catch(() => undefined)
      if (adapter !== undefined && state?.status !== 'active') {
        throw new HttpError(422, 'vault_not_ours')
      }
    }
    writeSettings(db, changes, now())
    swap(deps, chains, config)
    await host.changed?.(config)
    repo.audit(
      db,
      {
        event: 'settings_changed',
        // Which fields only: an RPC URL can carry an API key.
        detail: {
          passkey,
          chains: changes.map(({ chain, ...rest }) => [chain, Object.keys(rest)]),
        },
      },
      now(),
    )
  }

  /** Each enabled chain's RPC and vault as in force, the env's or the panel's. */
  function current() {
    const config = applySettings(host.env, readSettings(db))
    return {
      chains: settingKeys(host.env).map((keys) => {
        // An RPC from the env goes out as its origin only: a provider's URL carries its API key, and
        // /sign shares this origin. One the owner typed in the panel comes back as typed.
        const env = host.env[keys.rpcUrl]
        const rpcUrl = typeof env === 'string' ? new URL(env).origin : config[keys.rpcUrl]
        const vault = config[keys.vault]
        return {
          chain: keys.chain,
          ...(typeof rpcUrl === 'string' ? { rpcUrl } : {}),
          ...(typeof vault === 'string' ? { vault } : {}),
        }
      }),
    }
  }

  return async (app: FastifyInstance) => {
    app.get('/v1/owner/settings', async () => current())

    app.put('/v1/owner/settings', async (request) => {
      const { chains, assertion } = ownerSettings.parse(request.body)
      const changes = chains.map((change) => checked(host.env, change))
      const sent = (request.body as { chains: unknown }).chains
      const passkey = await stepUp('change_settings', { chains: sent }, assertion)
      const run = queue.then(() => adopt(changes, passkey))
      queue = run.catch(() => undefined)
      await run
      return current()
    })
  }
}

/** A change for an enabled chain, in that chain's address format, touching nothing the env sets. */
function checked(env: Config, change: { chain: string; rpcUrl?: string; vault?: string }) {
  const keys = settingKeys(env).find((k) => k.chain === change.chain)
  if (keys === undefined) {
    throw new HttpError(400, 'chain_not_enabled')
  }
  const family = keys.chain.split(':')[0] as keyof typeof VAULT
  if (change.vault !== undefined && !VAULT[family].test(change.vault)) {
    throw new HttpError(400, 'invalid_vault')
  }
  const locked = fromEnv(env, keys.chain).filter((field) => change[field] !== undefined)
  if (locked.length > 0) {
    throw new HttpError(409, 'set_by_env')
  }
  return { ...change, chain: keys.chain }
}

/** In place: every route holds these maps, and the next request sees the new chains. */
function swap(deps: X402Deps, chains: Map<ChainId, ChainAdapter>, config: Config) {
  const live = deps.chains as Map<ChainId, ChainAdapter>
  const usdc = deps.usdc as Map<ChainId, string>
  live.clear()
  usdc.clear()
  for (const [chain, adapter] of chains) {
    live.set(chain, adapter)
    const address = usdcFor(config, chain)
    if (address !== undefined) {
      usdc.set(chain, address)
    }
  }
}
