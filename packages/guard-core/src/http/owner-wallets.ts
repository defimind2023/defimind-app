import { type KillTarget, isSvm, killPageUrl, phantomKillUrl, signPageUrl } from '@defimind/shared'
import type { AgentWallet } from '@defimind/shared'
import type { FastifyInstance } from 'fastify'
import * as repo from '../db/repo.js'
import type { KillTransaction } from '../service/kill.js'
import type { PaymentDeps } from '../service/payments.js'
import type { OwnerAction } from '../service/step-up.js'
import type { WalletRow } from '../db/wallets.js'
import type { ChainAdapter } from '@defimind/onchain'
import { controls } from './control.js'
import { HttpError } from './errors.js'
import { vaultRef } from './owner-guide.js'
import type { ChainHost } from './owner-settings.js'
import { agentRouteParam, ownerAgentWallet } from './schemas.js'

export type Signing = { page: string; targets: KillTarget[] }

/**
 * Each kill transaction with its signing-page links, stamped now: the page refuses a link more than
 * 15 minutes old. An agent's own wallet is named in its link, the shared one never is.
 */
export function withLinks(txs: KillTransaction[], signing: Signing | undefined, issued: Date) {
  return txs.map(({ wallet, ...tx }) => {
    const shared = signing?.targets.find((t) => t.chain === tx.chain)
    if (signing === undefined || shared === undefined) {
      return tx
    }
    const target: KillTarget = wallet === undefined ? shared : { ...shared, hot: wallet.address }
    return {
      ...tx,
      link: phantomKillUrl(signing.page, target, issued),
      pageLink: killPageUrl(signing.page, target, issued),
    }
  })
}

/**
 * CR-022: an agent's own hot wallet, per chain, on the same vault as the shared one. The limit is
 * granted on this deployment's own /sign, the only page that knows the agents' keys.
 */
export function ownerWalletRoutes(
  deps: PaymentDeps,
  origin: string,
  host: Pick<ChainHost, 'env'>,
  stepUp: (action: OwnerAction, body: unknown, assertion: unknown) => Promise<string>,
  signing: Signing | undefined,
) {
  const { db, now } = deps
  const control = controls(deps, 'panel')

  /** The limit goes on the chain's vault, for this wallet alone: the page refuses any other key. */
  function addLimitPage(row: WalletRow): string {
    const ref = vaultRef(db, host, row.chain) ?? {}
    const action = isSvm(row.chain) ? 'add-limit' : 'enable'
    return signPageUrl(`${origin}/sign`, row.chain, { action, ...ref, hot: row.address }) ?? ''
  }

  async function view(row: WalletRow & { adapter: ChainAdapter }): Promise<AgentWallet> {
    const gas = await row.adapter
      .getHotWalletGas()
      .catch(() => ({ balance: '0', minimum: '0', symbol: '' }))
    return {
      chain: row.chain,
      address: row.address,
      status: row.status,
      addLimitPage: addLimitPage(row),
      gas,
    }
  }

  function agent(id: string) {
    if (!repo.agentExists(db, id)) {
      throw new HttpError(404, 'not_found')
    }
    if (deps.wallets === undefined) {
      throw new HttpError(404, 'wallets_not_available')
    }
    return deps.wallets
  }

  return async (app: FastifyInstance) => {
    app.get('/v1/owner/agents/:id/wallets', async (request) => {
      const { id } = agentRouteParam.parse(request.params)
      const rows = await agent(id).refresh(id)
      return { wallets: await Promise.all(rows.map(view)) }
    })

    app.post('/v1/owner/agents/:id/wallets', async (request) => {
      const { id } = agentRouteParam.parse(request.params)
      const { chain, assertion } = ownerAgentWallet.parse(request.body)
      const wallets = agent(id)
      if (!deps.chains.has(chain)) {
        throw new HttpError(409, 'no_vault')
      }
      const passkey = await stepUp('agent_wallet', { agentId: id, chain }, assertion)
      const created = await wallets.create(id, chain, now())
      repo.audit(
        db,
        {
          event: 'agent_wallet_created',
          agentId: id,
          detail: { chain, address: created.address, passkey },
        },
        now(),
      )
      const row = (await wallets.refresh(id)).find((w) => w.chain === chain)
      if (row === undefined) {
        throw new Error(`agent wallet not stored: ${id} on ${chain}`)
      }
      return view(row)
    })

    app.post('/v1/owner/agents/:id/kill', async (request) => {
      const { id } = agentRouteParam.parse(request.params)
      const killed = await control.killAgent(id, request.log)
      return { ...killed, ownerTransactions: withLinks(killed.ownerTransactions, signing, now()) }
    })
  }
}
