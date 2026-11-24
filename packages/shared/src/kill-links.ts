import { inPhantom, signPageUrl } from './sign-links.js'
import type { ChainId } from './types.js'

/**
 * Solana names the Squads multisig and the hot wallet. On EVM the Safe, and the hot wallet for the
 * hosted page, which knows none of its own (CR-020); a page built with one refuses any other.
 */
export type KillTarget = { chain: ChainId } & (
  { multisig: string; hot: string } | { safe: string; hot?: string }
)

/** One chain's onchain kill, as a link the bot stamps with the time it posts it. */
export interface PhantomKill {
  chain: ChainId
  /** The Phantom app's universal link. */
  link: (issued: Date) => string
  /** The same page in the browser, for Phantom's desktop extension. */
  page: (issued: Date) => string
}

/**
 * Opens the onchain kill on our signing page inside Phantom, where only the owner can sign it (ADR
 * 003). Every value comes from the caller's config (the bot's, or guard-core's for the owner kill) and all of
 * them are public: the page derives the
 * limit from them and checks the chain before it asks for a signature. The page refuses a link whose
 * `issued` is more than 15 minutes old, so a stale link stops working.
 */
export function phantomKillUrl(signPage: string, target: KillTarget, issued: Date): string {
  return inPhantom(killPageUrl(signPage, target, issued))
}

/**
 * The signing page itself. On a desktop browser with the Phantom extension the universal link stops
 * at a "open this in the Phantom app" page; this one opens straight in the browser.
 */
export function killPageUrl(signPage: string, target: KillTarget, issued: Date): string {
  const keys: Record<string, string> =
    'safe' in target
      ? { safe: target.safe, ...(target.hot === undefined ? {} : { hot: target.hot }) }
      : { multisig: target.multisig, hot: target.hot }
  const url = signPageUrl(signPage, target.chain, {
    action: 'kill',
    ...keys,
    issued: String(Math.floor(issued.getTime() / 1000)),
  })
  if (url === undefined) {
    throw new Error(`no signing-page cluster for ${target.chain}`)
  }
  return url
}

export function phantomKill(signPage: string, target: KillTarget): PhantomKill {
  return {
    chain: target.chain,
    link: (issued) => phantomKillUrl(signPage, target, issued),
    page: (issued) => killPageUrl(signPage, target, issued),
  }
}
