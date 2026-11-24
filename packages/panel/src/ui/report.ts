import { formatUsd } from '../domain/money.js'
import type { Context, Screen } from './context.js'
import { card, el, row } from './dom.js'

const DAY = 24 * 60 * 60 * 1000
const MARK = { ok: '✓', warn: '!', fail: '✗' } as const

export async function report(ctx: Context, now = new Date()): Screen {
  const { agents } = await ctx.api.report(new Date(now.getTime() - 7 * DAY), now)
  return [
    el('h1', {}, 'Last 7 days'),
    agents.length === 0 && el('p', {}, 'No payments in these 7 days.'),
    ...agents.map((agent) => {
      const refused = Object.entries(agent.refused).filter(([, count]) => count > 0)
      return card(
        el('h2', {}, agent.agentId),
        el(
          'dl',
          {},
          row('Spent', formatUsd(agent.spent)),
          row('Payments', String(agent.payments)),
          row(
            'Refused',
            refused.length === 0 ? 'none' : refused.map(([code, n]) => `${code} ×${n}`).join(', '),
          ),
          ...agent.domains.map((domain) => row(domain.domain, formatUsd(domain.spent))),
        ),
      )
    }),
  ]
}

export async function doctor(ctx: Context): Screen {
  const { checks } = await ctx.api.doctor()
  return [
    el('h1', {}, 'Doctor'),
    card(
      ...checks.map((check) =>
        el(
          'div',
          { class: `item check-${check.status}` },
          el('strong', {}, `${MARK[check.status]} ${check.message}`),
          check.fix !== undefined && el('span', { class: 'muted' }, check.fix),
        ),
      ),
    ),
  ]
}
