import { ApiError } from '../adapters/api.js'
import type { PortfolioView } from '../adapters/schemas.js'
import { chainName } from '../domain/chains.js'
import { formatUsd, meterPercent } from '../domain/money.js'
import { units } from '../domain/trading.js'
import { href } from '../domain/route.js'
import type { Context, Screen } from './context.js'
import { card, el, meter, row } from './dom.js'

/**
 * What each agent holds and what it paid, never what it is worth: the panel has no price it could
 * trust, and an estimate would read as a promise.
 */
function holdings(agent: PortfolioView) {
  const { positions, tradedToday, dailyTradeMax } = agent
  return card(
    el('h2', {}, agent.agentId),
    el('dl', {}, row('Bought today', `${formatUsd(tradedToday)} of ${formatUsd(dailyTradeMax)}`)),
    meter(meterPercent(tradedToday, dailyTradeMax)),
    positions.length === 0 && el('p', { class: 'muted' }, 'Holds no tokens.'),
    ...positions.map((position) =>
      el(
        'div',
        { class: 'item' },
        el('strong', { class: 'mono' }, units(position)),
        el('span', {}, `Cost ${formatUsd(position.cost)} on ${chainName(position.chain)}`),
      ),
    ),
  )
}

/** A guard-core older than CR-021 has no portfolio route: that is no trading, not an error. */
const read = (ctx: Context) =>
  ctx.api.portfolio().catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 404) {
      return undefined
    }
    throw error
  })

export async function portfolio(ctx: Context): Screen {
  const data = await read(ctx)
  if (data === undefined) {
    return [
      el('h1', {}, 'Portfolio'),
      el('p', {}, 'Trading is not available on this DefiMind yet: your agents hold no tokens.'),
    ]
  }
  const { agents } = data
  const held = agents.some((agent) => agent.positions.length > 0)
  return [
    el('h1', {}, 'Portfolio'),
    el(
      'p',
      { class: 'muted' },
      'Tokens your agents bought, at what they paid. Sells are not counted against the day.',
    ),
    agents.length === 0 &&
      el('p', {}, "No agent trades. Trading is off until you turn it on in an agent's rules."),
    ...agents.map(holdings),
    held && el('a', { href: href({ name: 'kill' }), class: 'button' }, 'Close positions'),
  ]
}
