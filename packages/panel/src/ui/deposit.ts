import { getAddress, usdSymbol } from '@defimind/shared'
import type { DepositView } from '../adapters/schemas.js'
import { chainName } from '../domain/chains.js'
import { daysCovered, inPhantom } from '../domain/guide.js'
import { amountText } from '../domain/money.js'
import { qrCode } from '../domain/qr.js'
import type { Context, Screen } from './context.js'
import { button, card, el, row } from './dom.js'

const SVG = 'http://www.w3.org/2000/svg'

/**
 * The QR code as one SVG path, white quiet zone included: a phone camera needs the margin, and the
 * CSP allows no inline style, so the colors are attributes.
 */
export function qrImage(text: string, label: string): SVGSVGElement {
  const modules = qrCode(text)
  const size = modules.length + 8
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`)
  svg.setAttribute('class', 'qr')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', label)
  const back = document.createElementNS(SVG, 'rect')
  back.setAttribute('width', String(size))
  back.setAttribute('height', String(size))
  back.setAttribute('fill', '#fff')
  const path = document.createElementNS(SVG, 'path')
  const d = modules.flatMap((line, y) =>
    line.flatMap((dark, x) => (dark ? [`M${x + 4} ${y + 4}h1v1h-1z`] : [])),
  )
  path.setAttribute('d', d.join(''))
  path.setAttribute('fill', '#000')
  svg.append(back, path)
  return svg
}

function token({ chain, token }: DepositView): string {
  const symbol = usdSymbol(chain)
  return symbol !== undefined && getAddress(chain, 'usd') === token ? symbol : `the token ${token}`
}

function covers(chain: DepositView): string | undefined {
  const days = daysCovered(chain.balance, chain.dailyCap)
  if (days === undefined) {
    return undefined
  }
  return days === 1n ? 'About 1 day at the daily limit.' : `About ${days} days at the daily limit.`
}

/** One chain's vault: where money goes in, what is there, and the way to add more. */
export function depositCard(ctx: Context, chain: DepositView) {
  const name = chainName(chain.chain)
  const amount = (value: string) =>
    amountText({ chain: chain.chain, token: chain.token, amount: value })
  return card(
    el('h2', {}, name),
    el(
      'dl',
      {},
      row('In the vault', amount(chain.balance)),
      chain.dailyCap !== undefined && row('Daily limit', amount(chain.dailyCap)),
    ),
    covers(chain) !== undefined && el('p', {}, covers(chain)),
    chain.depositPage !== undefined &&
      el(
        'a',
        { href: inPhantom(chain.depositPage), class: 'button primary' },
        'Deposit with Phantom',
      ),
    chain.depositPage !== undefined &&
      el('a', { href: chain.depositPage, class: 'button' }, 'Deposit on this computer'),
    el('h3', {}, 'Or send to this address'),
    el('p', { class: 'muted' }, `Send only ${token(chain)} on ${name}. Anything else may be lost.`),
    qrImage(chain.vault, `QR code of the vault address on ${name}`),
    el('code', { class: 'token' }, chain.vault),
    button('Copy address', async () => {
      await navigator.clipboard.writeText(chain.vault)
      ctx.say('Address copied.', 'done')
    }),
  )
}

export async function deposit(ctx: Context): Screen {
  const { chains } = await ctx.api.deposit()
  return [
    el('h1', {}, 'Add money'),
    el(
      'p',
      {},
      'Your agents pay from the vault. Put in only what you are ready for them to spend.',
    ),
    ...chains.map((chain) => depositCard(ctx, chain)),
    chains.length === 0 &&
      card(
        el('p', {}, 'No vault yet. The guided setup creates one.'),
        el('a', { href: '/panel/start', class: 'button primary' }, 'Open the guided setup'),
      ),
  ]
}
