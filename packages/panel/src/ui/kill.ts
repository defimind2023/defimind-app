import type { KillView } from '../adapters/schemas.js'
import { chainName } from '../domain/chains.js'
import { isSolana } from '../domain/guide.js'
import { spent, units } from '../domain/trading.js'
import type { Context, Screen } from './context.js'
import { button, card, el } from './dom.js'

/**
 * Without a link, a deployment whose hot wallet the hosted signing page does not know (a one-click
 * one), the owner removes the limit in the vault's own app. The agents are already paused; this only
 * takes away what the hot wallet could still draw.
 */
function byHand(chain: string, paused: string) {
  const [app, where] = isSolana(chain)
    ? [
        'https://app.squads.so',
        'open your vault, then Settings, then Spending limits, and remove the limit',
      ]
    : [
        'https://app.safe.global',
        'open your Safe, then Settings, then Spending limits, and delete the limit',
      ]
  return [
    el(
      'p',
      {},
      `${paused} To be sure the vault pays nothing more, connect your wallet there, ${where}.`,
    ),
    el('a', { href: app, class: 'button primary', rel: 'noreferrer' }, `Open ${new URL(app).host}`),
  ]
}

/** guard-core prefixes an own wallet's description with whose it is: said once, above, in full. */
function described({ description, wallet }: KillView['ownerTransactions'][number]) {
  const whose = wallet === undefined ? '' : `${wallet.agentId}'s own wallet: `
  return whose !== '' && description.startsWith(whose)
    ? description.slice(whose.length)
    : description
}

export function onchain(
  tx: KillView['ownerTransactions'][number],
  paused = 'Your agents are paused.',
) {
  const built = tx.payload !== null
  const linked = tx.link !== undefined || tx.pageLink !== undefined
  return card(
    el('h2', {}, chainName(tx.chain)),
    // An agent's own wallet, in full: the limit to remove is that address's, not the shared one's.
    tx.wallet !== undefined &&
      el(
        'p',
        {},
        `${tx.wallet.agentId}'s own wallet: `,
        el('span', { class: 'mono' }, tx.wallet.address),
      ),
    el('p', { class: built ? '' : 'flag' }, described(tx)),
    tx.link !== undefined && el('a', { href: tx.link, class: 'button primary' }, 'Open in Phantom'),
    tx.pageLink !== undefined &&
      el('a', { href: tx.pageLink, class: 'button' }, 'Open on this computer'),
    ...(linked ? [] : byHand(tx.chain, paused)),
    built &&
      tx.link === undefined &&
      el(
        'details',
        {},
        el('summary', {}, 'Transaction to sign'),
        el('pre', {}, JSON.stringify(tx.payload, null, 2)),
      ),
  )
}

/**
 * Whether any agent holds a token. The Stop screen must open on any guard-core, one without
 * trading included, so a failed read counts as none.
 */
const holding = (ctx: Context) =>
  ctx.api
    .portfolio()
    .then(({ agents }) => agents.some((agent) => agent.positions.length > 0))
    .catch(() => false)

/** CR-021: sells every token back to the chain's dollar, through the same checks as any swap. */
function closePositions(ctx: Context) {
  const result = el('div')
  return card(
    el('h2', {}, 'Close positions'),
    el(
      'p',
      {},
      "Sells every token your agents hold back to the chain's dollar, through the same checks as any trade. Works while agents are paused.",
    ),
    button(
      'Close positions with passkey',
      async () => {
        const { intents } = await ctx.api.closePositions()
        const tokens = intents.length === 1 ? 'token' : 'tokens'
        ctx.say(`Selling ${intents.length} ${tokens}.`, 'done')
        result.replaceChildren(
          ...intents.map((intent) =>
            el(
              'div',
              { class: 'item' },
              el('strong', { class: 'mono' }, units(spent(intent))),
              el('span', {}, `${chainName(intent.chain)}: ${intent.status}`),
            ),
          ),
        )
      },
      'danger',
    ),
    result,
  )
}

/** Never waits on trading: the Stop button renders at once, Close positions joins when it can. */
export async function kill(ctx: Context): Screen {
  const result = el('div')
  const close = el('div')
  void holding(ctx).then((held) => held && close.replaceChildren(closePositions(ctx)))
  return [
    el('h1', {}, 'Stop everything'),
    el(
      'p',
      {},
      'Pauses every agent at once: guard-core signs no more payments. Then remove the onchain limit on each chain with your wallet.',
    ),
    button(
      'Stop everything',
      async () => {
        const done = await ctx.api.kill()
        const agents = done.pausedAgents === 1 ? 'agent' : 'agents'
        ctx.say(`Stopped. ${done.pausedAgents} ${agents} paused.`, 'done')
        result.replaceChildren(...done.ownerTransactions.map((tx) => onchain(tx)))
      },
      'kill',
    ),
    result,
    close,
  ]
}
