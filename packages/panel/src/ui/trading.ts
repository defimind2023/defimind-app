import type { PolicyView } from '../adapters/schemas.js'
import { fromTradingForm, toTradingForm } from '../domain/trading.js'
import type { Context } from './context.js'
import { button, card, el } from './dom.js'

type Save = (after: PolicyView, message: string) => Promise<void>

function input(id: string, label: string, value: string) {
  const node = el('input', { id, inputmode: 'decimal', autocomplete: 'off' })
  node.value = value
  return { node, nodes: [el('label', { for: id }, label), node] }
}

function check(id: string, label: string, checked: boolean) {
  const node = el('input', { id, type: 'checkbox' })
  node.checked = checked
  return { node, label: el('label', { class: 'check' }, node, label) }
}

/** CR-021, phase 1: buys and sells on Solana through Jupiter, inside these limits. */
export function tradingForm(ctx: Context, policy: PolicyView, save: Save) {
  const form = toTradingForm(policy.trading)
  const enabled = check('trading', 'Let this agent trade', form.enabled)
  const any = check('any-token', 'Any token that passes the risk checks', form.allowAnyToken)
  const tokens = el('textarea', { id: 'trade-tokens', rows: '3', spellcheck: 'false' })
  tokens.value = form.tokens
  const perTrade = input('trade-max', 'Each buy, in dollars', form.maxTradeUsd)
  const daily = input('trade-daily', 'All buys in a day, in dollars', form.dailyTradeMax)
  const position = input(
    'position-max',
    'Held in one token at cost, in dollars',
    form.maxPositionUsd,
  )
  const slippage = input('slippage', 'Slippage up to, in percent', form.maxSlippage)
  const impact = input('impact', 'Price impact up to, in percent', form.maxPriceImpact)
  return card(
    el('h2', {}, 'Trading'),
    el(
      'p',
      { class: 'muted' },
      "Solana only, through Jupiter. Every trade has the chain's dollar on one side. A buy from your ask-me amount, or of a new or mintable token, waits for you; a sell never waits.",
    ),
    el(
      'p',
      { class: 'muted' },
      'Turning trading on, adding a token or raising a limit asks for your passkey.',
    ),
    enabled.label,
    el('label', { for: 'trade-tokens' }, 'Tokens it may buy (one mint address per line)'),
    tokens,
    any.label,
    ...perTrade.nodes,
    ...daily.nodes,
    ...position.nodes,
    ...slippage.nodes,
    ...impact.nodes,
    button(
      'Save trading',
      async () => {
        const trading = fromTradingForm(policy.trading, {
          enabled: enabled.node.checked,
          allowAnyToken: any.node.checked,
          tokens: tokens.value,
          maxTradeUsd: perTrade.node.value,
          dailyTradeMax: daily.node.value,
          maxPositionUsd: position.node.value,
          maxSlippage: slippage.node.value,
          maxPriceImpact: impact.node.value,
        })
        if (typeof trading === 'string') {
          ctx.say(trading, 'stop')
          return
        }
        await save({ ...policy, trading }, 'Trading saved.')
      },
      'primary',
    ),
  )
}
