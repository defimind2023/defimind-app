import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CHAINS, getAddress, usdSymbol, type ChainId } from '@defimind/shared'
import { isAddress } from 'viem'
import { z } from 'zod'
import { isPublicKey } from './src/plan.js'

/**
 * What the signing page acts for: the RPC endpoints, the hot wallets, the tokens and the largest
 * daily cap. It is fixed by whoever serves the page, the hosted build from its env or the owner's
 * guard-core at /sign, and never taken from a link: a link that could name the hot wallet or the RPC
 * could make the page grant an attacker's key, or read a node that lies about the chain.
 */
export interface PageConfig {
  rpc: Record<string, string>
  usdc: Record<string, string>
  hot: Record<string, string>
  /** Per cluster, the agents' own hot wallets (CR-022): never the hosted build's. */
  agents: Record<string, string[]>
  maxDailyCap: string
  evm: Record<string, EvmCluster>
}

export interface EvmCluster {
  chainId: number
  module: string
  usd: string
  symbol: string
  hot?: string
  agents?: string[]
}

/** The built app.js and style.css, which guard-core serves next to the page at /sign. */
export const SIGN_PAGE_DIR = fileURLToPath(new URL('./dist', import.meta.url))

export function rpcUrls(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    devnet: env['SOLANA_DEVNET_RPC'] ?? 'https://api.devnet.solana.com',
    'mainnet-beta': env['SOLANA_MAINNET_RPC'] ?? 'https://api.mainnet-beta.solana.com',
    ...(env['SOLANA_LOCALNET_RPC'] ? { localnet: env['SOLANA_LOCALNET_RPC'] } : {}),
    'robinhood-testnet': env['ROBINHOOD_TESTNET_RPC'] ?? 'https://rpc.testnet.chain.robinhood.com',
    robinhood: env['ROBINHOOD_MAINNET_RPC'] ?? 'https://rpc.mainnet.chain.robinhood.com',
    ...(env['EVM_LOCALNET_RPC'] ? { 'evm-localnet': env['EVM_LOCALNET_RPC'] } : {}),
  }
}

/**
 * The EVM clusters: the chain id Phantom must be on, the module and token from the verified
 * addresses in shared, and the hot wallet whose delegate entry the kill removes. A link names the
 * cluster and the Safe only. The tests' evm-localnet stands in for Robinhood testnet, with its id
 * and addresses.
 */
export function evmChains(env: NodeJS.ProcessEnv = process.env) {
  const chain = (id: ChainId, hotVar: string) => {
    const hot = env[hotVar]
    if (hot && !isAddress(hot)) {
      throw new Error(`${hotVar} is not an EVM address: ${hot}`)
    }
    return evmCluster(id, hot)
  }
  return {
    'robinhood-testnet': chain(CHAINS.robinhoodTestnet, 'ROBINHOOD_HOT_WALLET_TESTNET'),
    robinhood: chain(CHAINS.robinhood, 'ROBINHOOD_HOT_WALLET_MAINNET'),
    ...(env['EVM_LOCALNET_RPC']
      ? { 'evm-localnet': chain(CHAINS.robinhoodTestnet, 'EVM_HOT_WALLET_LOCALNET') }
      : {}),
  }
}

const evmCluster = (id: ChainId, hot: string | undefined, agents: string[] = []): EvmCluster => ({
  chainId: Number(id.split(':')[1]),
  module: getAddress(id, 'allowanceModule')!,
  usd: getAddress(id, 'usd')!,
  symbol: usdSymbol(id)!,
  ...(hot ? { hot } : {}),
  ...(agents.length > 0 ? { agents } : {}),
})

/** USDC for each cluster, from the verified addresses in shared, so no link can name another mint. */
export function usdcMints(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const known = {
    devnet: getAddress(CHAINS.solanaDevnet, 'usd'),
    'mainnet-beta': getAddress(CHAINS.solanaMainnet, 'usd'),
    localnet: env['SOLANA_LOCALNET_USDC'],
  }
  return Object.fromEntries(
    Object.entries(known).filter(([, mint]) => mint !== undefined),
  ) as Record<string, string>
}

/**
 * The hot wallet each cluster's limit is for. The add-limit page grants exactly this key the right to
 * draw, so it is fixed here, where only a deploy from protected main can change it, and never read
 * from a link: a crafted link could otherwise name an attacker's key.
 */
export function hotWallets(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const known = {
    devnet: env['SOLANA_HOT_WALLET_DEVNET'],
    'mainnet-beta': env['SOLANA_HOT_WALLET_MAINNET'],
    localnet: env['SOLANA_HOT_WALLET_LOCALNET'],
  }
  const set = Object.entries(known).filter((entry): entry is [string, string] => Boolean(entry[1]))
  for (const [cluster, key] of set) {
    // A typo fails the deploy here rather than the owner's page later.
    if (!isPublicKey(key)) {
      throw new Error(`the hot wallet for ${cluster} is not a Solana public key: ${key}`)
    }
  }
  return Object.fromEntries(set)
}

/** The largest daily cap a link may ask for, in USDC base units. D1 sets 50 USDC. */
export function maxDailyCap(env: NodeJS.ProcessEnv = process.env): string {
  const max = env['MAX_DAILY_CAP'] ?? '50000000'
  if (!/^[1-9]\d*$/.test(max)) {
    throw new Error(`MAX_DAILY_CAP must be a positive whole number of base units, not ${max}`)
  }
  return max
}

export function csp(rpc: Record<string, string>): string {
  const origins = [...new Set(Object.values(rpc).map((url) => new URL(url).origin))]
  return [
    "default-src 'none'",
    // 'unsafe-eval' is for Phantom, not for us: its provider runs in this page's world and compiles
    // zod schemas with new Function, so without it connect fails (ADR 003). Scripts still load
    // from this origin only, and the page has no string-to-code sink of its own.
    "script-src 'self' 'unsafe-eval'",
    "style-src 'self'",
    `connect-src ${origins.join(' ')}`,
    "img-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
}

/** The hosted build's config, from its env at build time. */
export const configFromEnv = (env: NodeJS.ProcessEnv = process.env): PageConfig => ({
  rpc: rpcUrls(env),
  usdc: usdcMints(env),
  hot: hotWallets(env),
  agents: {},
  maxDailyCap: maxDailyCap(env),
  evm: evmChains(env),
})

const SOLANA = { devnet: CHAINS.solanaDevnet, 'mainnet-beta': CHAINS.solanaMainnet } as const
const EVM = { 'robinhood-testnet': CHAINS.robinhoodTestnet, robinhood: CHAINS.robinhood } as const

const rpcUrl = z.url({ protocol: /^https?$/ })
const cluster = <K extends string, T extends z.ZodType>(names: Record<K, string>, hot: T) =>
  z.partialRecord(
    z.enum(Object.keys(names) as [K, ...K[]]),
    z
      .object({ rpc: rpcUrl, hot: hot.optional(), agents: z.array(hot).max(100).default([]) })
      .strict(),
  )

/**
 * What guard-core passes for its own /sign: per cluster, the RPC, its shared hot wallet and every
 * agent's own (CR-022). Tokens and
 * modules always come from the verified addresses in shared, never from the caller.
 */
export const signPageConfig = z
  .object({
    solana: cluster(SOLANA, z.string().refine(isPublicKey, 'not a Solana public key')).default({}),
    evm: cluster(
      EVM,
      z.string().refine((value) => isAddress(value), 'not an EVM address'),
    ).default({}),
    maxDailyCap: z.string().regex(/^[1-9]\d*$/, 'a positive whole number of base units'),
  })
  .strict()
export type SignPageConfig = z.input<typeof signPageConfig>

export function fromSignPage(input: SignPageConfig): PageConfig {
  const { solana, evm, maxDailyCap } = signPageConfig.parse(input)
  const config: PageConfig = { rpc: {}, usdc: {}, hot: {}, agents: {}, maxDailyCap, evm: {} }
  for (const [name, { rpc, hot, agents }] of entries(solana)) {
    config.rpc[name] = rpc
    config.usdc[name] = getAddress(SOLANA[name], 'usd')!
    if (hot) config.hot[name] = hot
    if (agents.length > 0) config.agents[name] = agents
  }
  for (const [name, { rpc, hot, agents }] of entries(evm)) {
    config.rpc[name] = rpc
    config.evm[name] = evmCluster(EVM[name], hot, agents)
  }
  return config
}

const entries = <K extends string, V>(record: Partial<Record<K, V>>) =>
  Object.entries(record) as [K, V][]

/**
 * The page's HTML with its CSP and config filled in. The config is JSON inside a script element, so
 * every "<" is escaped: no value can close the element and start markup of its own.
 */
export function pageHtml(template: string, config: PageConfig): string {
  const json = JSON.stringify(config).replace(/</g, '\\u003c')
  return template.replace('%CSP%', csp(config.rpc)).replace('%CONFIG%', () => json)
}

/** The whole index.html for guard-core's /sign, next to app.js and style.css in SIGN_PAGE_DIR. */
export const signPageHtml = (input: SignPageConfig): string =>
  pageHtml(readFileSync(`${SIGN_PAGE_DIR}/index.template.html`, 'utf8'), fromSignPage(input))
