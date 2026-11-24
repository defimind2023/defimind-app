import { CHAINS, getAddress } from '@defimind/shared'

type Send = (status: number, data: unknown) => void
type Bound = { action: string; body: unknown } | undefined

export const SETUP_CODE = 'host-made-setup-code'
export const VAULT = 'HVpb8eryjLYqX8q89znYPEyJxWTyTe9yS8XBNF8AwQUK'

/**
 * CR-019's routes as SPEC v0.14 words them, for a DefiMind fresh from a one-click deploy: one chain,
 * no vault until the owner saves one, and progress derived from that state, never from the panel.
 */
export function setupMock() {
  const chain = CHAINS.solanaDevnet
  const state = {
    vault: undefined as string | undefined,
    balance: '0',
    saved: [] as { chains: unknown; stepUp: Bound }[],
  }

  const settings = () => ({
    // The RPC comes from the env, shown as its origin only, as GC-56 does.
    chains: [
      {
        chain,
        rpcUrl: 'https://rpc.example',
        ...(state.vault === undefined ? {} : { vault: state.vault }),
      },
    ],
  })

  function route(
    method: string,
    path: string,
    body: Record<string, unknown>,
    send: Send,
    stepUp: () => Bound,
    { passkeys, origin }: { passkeys: number; origin: string },
  ): boolean {
    if (path === '/v1/owner/setup' && method === 'GET') {
      send(200, { needsSetup: passkeys === 0 })
    } else if (path === '/v1/owner/setup') {
      if (passkeys > 0) {
        send(410, { error: 'setup_done' })
      } else if (body['setupCode'] !== SETUP_CODE) {
        send(401, { error: 'setup_code_invalid' })
      } else {
        send(200, { enrolLink: `${origin}/panel/enrol#code=fresh` })
      }
    } else if (path === '/v1/owner/settings' && method === 'GET') {
      send(200, settings())
    } else if (path === '/v1/owner/settings') {
      const bound = stepUp()
      if (bound?.action !== 'change_settings') {
        send(403, { error: 'step_up_required' })
        return true
      }
      state.saved.push({ chains: body['chains'], stepUp: bound })
      if ((body['chains'] as { rpcUrl?: string }[]).some((c) => c.rpcUrl !== undefined)) {
        send(409, { error: 'set_by_env' })
        return true
      }
      const vault = (body['chains'] as { vault?: string }[])[0]?.vault
      if (vault !== VAULT) {
        send(422, { error: 'vault_not_ours' })
        return true
      }
      state.vault = vault
      state.balance = '30000000'
      send(200, settings())
    } else if (path === '/v1/owner/deposit') {
      send(200, {
        chains:
          state.vault === undefined
            ? []
            : [
                {
                  chain,
                  vault: state.vault,
                  token: getAddress(chain, 'usd'),
                  balance: state.balance,
                  dailyCap: '10000000',
                  depositPage: `https://dm.example/sign/?action=deposit&cluster=devnet&multisig=${state.vault}`,
                },
              ],
      })
    } else {
      return false
    }
    return true
  }

  return { state, route }
}
