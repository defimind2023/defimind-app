import type { Order } from '../adapters/api.js'
import type { QuoteView, TokenRiskView } from '../adapters/schemas.js'
import { chainName } from '../domain/chains.js'
import { isSolana } from '../domain/guide.js'
import { formatUsd, parseDollars } from '../domain/money.js'
import { href } from '../domain/route.js'
import { parseUnits } from '../domain/tokens.js'
import { FLAGS, percent, units } from '../domain/trading.js'
import { getAddress } from '@defimind/shared'
import type { Context, Screen } from './context.js'
import { button, card, el, row, when } from './dom.js'
import { tokenIcon } from './risk.js'
import { ownerTrading } from './token-search.js'

const mono = (text: string) => el('span', { class: 'mono' }, text)

function select(id: string, options: [string, string][]) {
  const node = el('select', { id })
  node.append(...options.map(([value, label]) => el('option', { value }, label)))
  return node
}

/** The exact amounts the passkey will confirm: what goes in, and the least that must come out. */
function confirmCard(
  ctx: Context,
  order: Order,
  quote: QuoteView,
  risk: TokenRiskView,
  buy: boolean,
  back: () => void,
) {
  const token = { token: risk.mint, decimals: risk.decimals }
  const spent = buy ? formatUsd(quote.amountIn) : units({ amount: quote.amountIn, ...token })
  const least = buy
    ? units({ amount: quote.minAmountOut, ...token })
    : formatUsd(quote.minAmountOut)
  const expected = buy
    ? units({ amount: quote.expectedOut, ...token })
    : formatUsd(quote.expectedOut)
  return card(
    el('h2', {}, 'Confirm'),
    el(
      'dl',
      {},
      row(buy ? 'Spends' : 'Sells', mono(spent)),
      row('Receives at least', mono(least)),
      row('Quoted to receive', mono(expected)),
      row('Slippage', `up to ${percent(quote.slippageBps)}`),
      row('Price impact', percent(quote.priceImpactBps)),
      row(
        'Selling it back',
        quote.exitImpactBps === null ? 'no route found' : `${percent(quote.exitImpactBps)} impact`,
      ),
      row('Venue', quote.venue),
      row('Quoted', when(quote.quotedAt)),
    ),
    ...quote.risks.map((code) => el('p', { class: 'flag' }, `Refused if sent: ${code}.`)),
    ...quote.flags.map((flag) => el('p', { class: 'flag' }, `${flag}: ${FLAGS[flag] ?? flag}`)),
    el(
      'p',
      { class: 'muted' },
      "Your passkey confirms these exact amounts. guard-core quotes again before it signs: if it cannot still get at least this much, the trade is refused. It counts in this agent's day and goes through every check of its rules.",
    ),
    el(
      'div',
      { class: 'actions' },
      button('Change', async () => back()),
      button(
        'Trade with passkey',
        async () => {
          const done = await ctx.api.trade({ ...order, minAmountOut: quote.minAmountOut })
          const why = done.rejectReasons.length > 0 ? `: ${done.rejectReasons.join(', ')}` : ''
          ctx.say(`Trade ${done.status}${why}.`, done.status === 'rejected' ? 'stop' : 'done')
        },
        'primary',
      ),
    ),
  )
}

/** CR-025: the owner trades for one agent, by hand, inside that agent's rules. */
export async function manualTrade(ctx: Context, agentId: string): Screen {
  const [policy, { chains }] = await Promise.all([ctx.api.policy(agentId), ctx.api.settings()])
  const chain = chains.map((c) => c.chain).find((c) => isSolana(c) && policy.chains.includes(c))
  const usd = chain === undefined ? undefined : getAddress(chain, 'usd')
  const tokens = policy.trading?.enabled === true ? policy.trading.tokens : []
  const head = [
    el('h1', {}, `Trade for ${agentId}`),
    el('a', { href: href({ name: 'agent', id: agentId }) }, `Back to ${agentId}`),
  ]
  if (chain !== undefined && !(await ownerTrading(ctx, chain))) {
    return [...head, card(el('p', {}, 'Trading by hand is not available on this DefiMind yet.'))]
  }
  if (chain === undefined || usd === undefined || tokens.length === 0) {
    return [
      ...head,
      card(
        el(
          'p',
          {},
          'Turn trading on and allow at least one token for this agent first, in its Trading settings. Trading runs on Solana only.',
        ),
      ),
    ]
  }
  const side = select('side', [
    ['buy', 'Buy with dollars'],
    ['sell', 'Sell back to dollars'],
  ])
  const token = select(
    'token',
    tokens.map((mint) => [mint, mint]),
  )
  const amount = el('input', { id: 'amount', inputmode: 'decimal', autocomplete: 'off' })
  const label = el('label', { for: 'amount' }, 'Spend, in dollars')
  side.addEventListener('change', () => {
    label.textContent = side.value === 'buy' ? 'Spend, in dollars' : "Sell, in the token's units"
  })
  const icon = el('div', {}, tokenIcon(token.value))
  token.addEventListener('change', () => icon.replaceChildren(tokenIcon(token.value)))
  const slot = el('div')
  const form = card(
    el('h2', {}, `On ${chainName(chain)}`),
    el('label', { for: 'side' }, 'Trade'),
    side,
    el('label', { for: 'token' }, 'Token (mint address)'),
    el('div', { class: 'token' }, icon, token),
    label,
    amount,
    button(
      'Get quote',
      async () => {
        const buy = side.value === 'buy'
        const risk = await ctx.api.tokenRisk(token.value, chain)
        const amountIn = buy ? parseDollars(amount.value) : parseUnits(amount.value, risk.decimals)
        if (amountIn === undefined || amountIn === '0') {
          ctx.say(
            buy
              ? 'Write an amount in dollars, like 5.00.'
              : 'Write an amount of the token, like 1.5.',
            'stop',
          )
          return
        }
        const order: Order = {
          agentId,
          chain,
          tokenIn: buy ? usd : token.value,
          tokenOut: buy ? token.value : usd,
          amountIn,
        }
        const quote = await ctx.api.quote(order)
        form.hidden = true
        slot.replaceChildren(
          confirmCard(ctx, order, quote, risk, buy, () => {
            slot.replaceChildren()
            form.hidden = false
          }),
        )
      },
      'primary',
    ),
  )
  return [
    ...head,
    el(
      'p',
      { class: 'muted' },
      "A trade by hand follows this agent's rules and limits, and always asks for your passkey.",
    ),
    form,
    slot,
  ]
}
