export const NEEDS_OWN_PAGE =
  "Open this from your DefiMind panel: it needs your deployment's own page."
const NAMES_NONE = 'This link names no hot wallet. Open it again from your panel.'
export const NO_LIMIT =
  "No limit found for this hot wallet. Check Spending limits in your vault's app."

/** The hot wallet an action acts for, and whether it came from the link rather than the build. */
export interface Hot<K> {
  key: K
  fromLink: boolean
}

/** The hot wallets a build acts for: the shared one, and one per agent that has its own (CR-022). */
export interface Built<K> {
  shared: K | undefined
  agents: K[]
}

/**
 * A build with hot wallets for the cluster acts for those only: a link naming another is refused,
 * since add-limit would grant it. A link naming none means the shared one. A build without any, the
 * hosted page (CR-020), takes the hot wallet from the link for a kill only, which can only take
 * authority away; anything that grants it needs the deployment's own page.
 */
export function whichHot<K>(
  { shared, agents }: Built<K>,
  named: K | undefined,
  kill: boolean,
  same: (a: K, b: K) => boolean,
  text: (key: K) => string,
): Hot<K> | string {
  const ours = shared === undefined ? agents : [shared, ...agents]
  if (ours.length > 0) {
    if (named === undefined) {
      return shared === undefined ? NAMES_NONE : { key: shared, fromLink: false }
    }
    const key = ours.find((k) => same(k, named))
    if (key === undefined) {
      return (
        `The link names ${text(named)} as the hot wallet, but this page only acts for ` +
        `${ours.map(text).join(', ')}. Do not sign anything from this link.`
      )
    }
    return { key, fromLink: false }
  }
  if (!kill) return NEEDS_OWN_PAGE
  if (named === undefined)
    return 'This kill link names no hot wallet. Open it again from your panel.'
  return { key: named, fromLink: true }
}
