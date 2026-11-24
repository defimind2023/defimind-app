import type { TokenInfo, TokenRiskView } from '../adapters/schemas.js'
import { checkFacts, identicon, onchainFacts, venueFacts } from '../domain/tokens.js'
import { el } from './dom.js'

const SVG = 'http://www.w3.org/2000/svg'

/** Drawn from the mint, never fetched: the CSP allows no remote image, and a logo can be copied. */
export function tokenIcon(mint: string): SVGSVGElement {
  const { hue, cells } = identicon(mint)
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', '0 0 5 5')
  svg.setAttribute('class', 'identicon')
  svg.setAttribute('aria-hidden', 'true')
  cells.forEach((on, i) => {
    if (on) {
      const cell = document.createElementNS(SVG, 'rect')
      cell.setAttribute('x', String(i % 5))
      cell.setAttribute('y', String(Math.floor(i / 5)))
      cell.setAttribute('width', '1')
      cell.setAttribute('height', '1')
      cell.setAttribute('fill', `hsl(${hue} 55% 60%)`)
      svg.append(cell)
    }
  })
  return svg
}

/** Symbol and name are the token's own claim: always beside the whole mint, never alone. */
export function tokenLine(token: Pick<TokenInfo, 'mint' | 'symbol' | 'name'>) {
  return el(
    'div',
    { class: 'token' },
    tokenIcon(token.mint),
    el(
      'div',
      {},
      el('strong', {}, `${token.symbol} · ${token.name}`),
      el('span', { class: 'mono' }, token.mint),
    ),
  )
}

const list = (facts: string[]) => el('ul', { class: 'facts' }, ...facts.map((f) => el('li', {}, f)))

/** CR-025's risk card: what the chain says, what the checks would do, then what Jupiter says. */
export function riskCard(risk: TokenRiskView) {
  const checks = checkFacts(risk)
  return el(
    'div',
    { class: 'risk' },
    el('h3', {}, 'On the chain'),
    list(onchainFacts(risk)),
    checks.length > 0 && el('h3', {}, 'DefiMind checks'),
    checks.length > 0 && list(checks),
    el('h3', {}, 'Jupiter says (not checked)'),
    list(venueFacts(risk)),
    el(
      'p',
      { class: 'muted' },
      'These are facts about the token, not advice. A token can lose all its value.',
    ),
  )
}
