import { CHAINS } from './constants.js'
import type { ChainId } from './types.js'

/**
 * CR-020: the signing page built from main with no hot wallet, the default for kill and deposit
 * links when a deployment sets no SIGN_PAGE_URL. Only main deploys it.
 */
export const HOSTED_SIGN_PAGE = 'https://defimind-sign.vercel.app'

/** The cluster names the signing page accepts (packages/onchain/web). Base has no page yet. */
const CLUSTERS = new Map<string, string>([
  [CHAINS.solanaDevnet, 'devnet'],
  [CHAINS.solanaMainnet, 'mainnet-beta'],
  [CHAINS.robinhoodTestnet, 'robinhood-testnet'],
  [CHAINS.robinhood, 'robinhood'],
])

export function signCluster(chain: ChainId | string): string | undefined {
  return CLUSTERS.get(chain)
}

/**
 * A link to the signing page at `page` (the hosted one, or guard-core's own /sign) for one chain.
 * Every value in `params` is public: the page derives what it signs from the chain, and a link never
 * names the hot wallet a deployment serves (SPEC, "Signing page").
 */
export function signPageUrl(
  page: string,
  chain: ChainId | string,
  params: Record<string, string>,
): string | undefined {
  const cluster = signCluster(chain)
  if (cluster === undefined) {
    return undefined
  }
  const query = new URLSearchParams(
    params['action'] === undefined ? [] : [['action', params['action']]],
  )
  // The chain decides the cluster: a parameter of that name never overrides it.
  query.set('cluster', cluster)
  for (const [key, value] of Object.entries(params)) {
    if (key !== 'action' && key !== 'cluster') {
      query.set(key, value)
    }
  }
  let base = page
  // A loop, not /\/+$/: that regex backtracks quadratically on a long run of slashes.
  while (base.endsWith('/')) {
    base = base.slice(0, -1)
  }
  return `${base}/?${query}`
}

/** The same page inside the Phantom app, for a phone. */
export function inPhantom(link: string): string {
  const { origin } = new URL(link)
  return `https://phantom.app/ul/browse/${encodeURIComponent(link)}?ref=${encodeURIComponent(origin)}`
}
