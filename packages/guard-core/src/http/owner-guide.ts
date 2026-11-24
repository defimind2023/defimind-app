import type { ChainAdapter } from '@defimind/onchain'
import { signPageUrl, type ChainId } from '@defimind/shared'
import type { FastifyInstance } from 'fastify'
import { listAgents } from '../db/agents.js'
import { countPasskeys } from '../db/passkeys.js'
import { anyShadowed } from '../db/progress.js'
import * as repo from '../db/repo.js'
import { readSettings } from '../db/settings.js'
import { applySettings, settingKeys } from '../domain/settings.js'
import type { X402Deps } from '../service/x402.js'
import type { ChainHost } from './owner-settings.js'

/**
 * The guided setup's progress and the deposit screen (CR-019). Every step is read from stored state
 * or from the chain, never from a flag the panel sets, so a step the owner undoes (a killed limit,
 * a revoked agent) shows as not done again.
 */
export function ownerGuideRoutes(deps: X402Deps, host: ChainHost, signPage?: string) {
  const { db } = deps
  const adapters = () => [...deps.chains.values()]

  /** A chain read that fails counts as not done; the owner retries by reloading. */
  async function any(read: (adapter: ChainAdapter) => Promise<boolean>): Promise<boolean> {
    const results = await Promise.all(
      adapters().map((adapter) =>
        read(adapter).catch((error: unknown) => {
          deps.log.warn({ err: error, chain: adapter.chain }, 'setup progress: chain read failed')
          return false
        }),
      ),
    )
    return results.some(Boolean)
  }

  async function steps() {
    const agents = listAgents(db)
    const opened = agents.some((agent) => {
      const policy = repo.getPolicy(db, agent.agentId)
      return policy !== undefined && policy.chains.length > 0 && BigInt(policy.dailyMax) > 0n
    })
    const done: Record<string, boolean> = {
      passkey: countPasskeys(db) > 0,
      vault: adapters().length > 0,
      limit: await any(async (a) => {
        const state = await a.getAllowanceState()
        return state.status === 'active' && BigInt(state.cap) > 0n
      }),
      deposit: await any(async (a) => BigInt((await a.getVault?.())?.balance ?? '0') > 0n),
      agent: agents.length > 0,
      rules: opened,
      shadow: anyShadowed(db),
      live: agents.some((agent) => agent.mode === 'live'),
    }
    return Object.entries(done).map(([id, isDone]) => ({ id, done: isDone }))
  }

  /** The page's deposit action names the multisig or the Safe; it derives the vault itself. */
  function depositPage(chain: ChainId): string | undefined {
    const ref = vaultRef(db, host, chain)
    return signPage === undefined || ref === undefined
      ? undefined
      : signPageUrl(signPage, chain, { action: 'deposit', ...ref })
  }

  return async (app: FastifyInstance) => {
    app.get('/v1/owner/setup/progress', async () => ({ steps: await steps() }))

    app.get('/v1/owner/deposit', async () => {
      const rows = await Promise.all(
        adapters().map(async (adapter) => {
          if (adapter.getVault === undefined) {
            return undefined
          }
          const [vault, allowance] = await Promise.all([
            adapter.getVault(),
            adapter.getAllowanceState().catch(() => undefined),
          ])
          const page = depositPage(adapter.chain)
          return {
            chain: adapter.chain,
            vault: vault.address,
            token: vault.token,
            balance: vault.balance,
            ...(allowance?.status === 'active' ? { dailyCap: allowance.cap } : {}),
            ...(page === undefined ? {} : { depositPage: page }),
          }
        }),
      )
      return { chains: rows.filter((row) => row !== undefined) }
    })
  }
}

/** How the signing page names a chain's vault: the Squads multisig, or the Safe. */
export function vaultRef(
  db: X402Deps['db'],
  host: Pick<ChainHost, 'env'>,
  chain: ChainId,
): Record<string, string> | undefined {
  const keys = settingKeys(host.env).find((k) => k.chain === chain)
  const vault = keys && applySettings(host.env, readSettings(db))[keys.vault]
  return typeof vault === 'string'
    ? { [chain.startsWith('solana:') ? 'multisig' : 'safe']: vault }
    : undefined
}
