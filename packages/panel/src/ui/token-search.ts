import type { PolicyView, TokenInfo } from '../adapters/schemas.js'
import { listed } from '../domain/tokens.js'
import { NO_TRADING } from '../domain/trading.js'
import type { Context } from './context.js'
import { button, card, el } from './dom.js'
import { riskCard, tokenLine } from './risk.js'

type Save = (after: PolicyView, message: string) => Promise<void>

/** Read the risk first; allowing adds the mint to the agent's tokens, a loosening, so the passkey. */
function result(ctx: Context, policy: PolicyView, token: TokenInfo, save: Save) {
  const detail = el('div')
  const allowed = policy.trading?.tokens.includes(token.mint) ?? false
  return el(
    'div',
    { class: 'item' },
    tokenLine(token),
    !token.verified && el('span', { class: 'flag' }, 'Jupiter says: not verified'),
    allowed
      ? el('span', { class: 'muted' }, 'Already allowed for this agent.')
      : button('Check risk', async () => {
          const risk = await ctx.api.tokenRisk(token.mint, token.chain)
          const trading = policy.trading ?? NO_TRADING
          detail.replaceChildren(
            riskCard(risk),
            button(
              'Allow this token with passkey',
              () =>
                save(
                  { ...policy, trading: { ...trading, tokens: [...trading.tokens, token.mint] } },
                  `${token.symbol} allowed.`,
                ),
              'primary',
            ),
          )
        }),
    detail,
  )
}

/**
 * Whether this guard-core serves CR-025's owner trading routes (GC-69). One search, cached by
 * guard-core for a minute, rather than a broken card and a screen that 404s on an older one.
 */
export const ownerTrading = (ctx: Context, chain: string) =>
  ctx.api
    .searchTokens('USDC', chain)
    .then(() => true)
    .catch(() => false)

/** CR-025: find a token by name, symbol or mint through guard-core, verified ones first. */
export function tokenSearch(ctx: Context, policy: PolicyView, chain: string, save: Save) {
  const query = el('input', { id: 'token-q', autocomplete: 'off', spellcheck: 'false' })
  const unverified = el('input', { id: 'unverified', type: 'checkbox' })
  const warning = el(
    'p',
    { class: 'flag', hidden: '' },
    'Unverified tokens include copies of real ones, under the same name and symbol. Compare the whole mint.',
  )
  const results = el('div')
  let found: TokenInfo[] = []
  const show = () => {
    warning.hidden = !unverified.checked
    const shown = listed(found, unverified.checked)
    const hidden = found.length - shown.length
    results.replaceChildren(
      el(
        'div',
        {},
        ...shown.map((token) => result(ctx, policy, token, save)),
        found.length > 0 && shown.length === 0 && el('p', {}, 'No verified token matches.'),
        hidden > 0 && el('p', { class: 'muted' }, `${hidden} unverified not shown.`),
      ),
    )
  }
  unverified.addEventListener('change', show)
  return card(
    el('h2', {}, 'Find a token'),
    el(
      'p',
      { class: 'muted' },
      'Names and symbols are what Jupiter lists, and anyone can copy them. The mint address is what identifies a token.',
    ),
    el('label', { for: 'token-q' }, 'Name, symbol or mint address'),
    query,
    button('Search', async () => {
      const q = query.value.trim()
      if (q.length === 0 || q.length > 64) {
        ctx.say('Write 1 to 64 characters.', 'stop')
        return
      }
      found = (await ctx.api.searchTokens(q, chain)).tokens
      show()
    }),
    el('label', { class: 'check' }, unverified, 'Show unverified tokens'),
    warning,
    results,
  )
}
