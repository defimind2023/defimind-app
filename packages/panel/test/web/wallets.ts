type Send = (status: number, data: unknown) => void
type Bound = { action: string; body: unknown } | undefined

export const AGENT_WALLET = 'Ag3ntWa11etXv1q9d8F7p2Lr5Kc4Tz6Ym8Nb3Hs7Qe'

/**
 * CR-022's agent wallet routes as SPEC v0.17 words them. The wallet starts waiting for its limit;
 * the test flips it active, as guard-core does once it reads the limit on the chain.
 */
export function walletsMock(origin: () => string) {
  const state = {
    wallets: [] as { chain: string; address: string; status: 'pending_limit' | 'active' }[],
    created: [] as Bound[],
    killed: [] as string[],
  }
  const view = (w: (typeof state.wallets)[number]) => ({
    ...w,
    addLimitPage: `${origin()}/sign/?action=add-limit&wallet=${w.address}`,
    gas: { balance: w.status === 'active' ? '3000000' : '0', minimum: '2000000', symbol: 'SOL' },
  })

  function route(
    method: string,
    path: string,
    body: Record<string, unknown>,
    send: Send,
    stepUp: () => Bound,
  ): boolean {
    const match = /^\/v1\/owner\/agents\/([^/]+)\/(wallets|kill)$/.exec(path)
    if (match === null) {
      return false
    }
    const agentId = decodeURIComponent(match[1]!)
    if (match[2] === 'kill') {
      state.killed.push(agentId)
      send(200, {
        pausedAgents: 1,
        ownerTransactions: state.wallets.map((w) => ({
          chain: w.chain,
          description: `${agentId}'s own wallet: Remove the limit of ${agentId}'s wallet.`,
          payload: { to: w.address },
          wallet: { agentId, address: w.address },
        })),
      })
      return true
    }
    if (method === 'GET') {
      send(200, { wallets: state.wallets.map(view) })
      return true
    }
    const bound = stepUp()
    if (bound?.action !== 'agent_wallet') {
      send(403, { error: 'step_up_required' })
      return true
    }
    state.created.push(bound)
    const wallet = {
      chain: String(body['chain']),
      address: AGENT_WALLET,
      status: 'pending_limit' as const,
    }
    state.wallets.push(wallet)
    send(200, view(wallet))
    return true
  }

  return { state, route }
}
