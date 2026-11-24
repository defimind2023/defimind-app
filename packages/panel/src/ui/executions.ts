import { ApiError } from '../adapters/api.js'
import { byHash, type Paid } from '../adapters/receipts.js'
import type { IntegrityView, ReceiptView } from '../adapters/schemas.js'
import { chainName } from '../domain/chains.js'
import { amountText } from '../domain/money.js'
import type { Context, Screen } from './context.js'
import { button, card, el, when } from './dom.js'

const DAY = 24 * 60 * 60 * 1000
/** The newest first; more than this in a week is read better from the proof bundles. */
const SHOWN = 200

/** SPEC asks the panel to say plainly what relayed does and does not vouch for. */
const RELAYED =
  'Relayed: reported by the gateway. DefiMind vouches it was recorded then and not changed since, ' +
  'not what the tool did.'
const EXECUTED = 'Executed: guard-core made the call itself.'

const OUTCOME = { ok: 'ok', error: 'error', refused: 'refused' } as const

function integrityCard(state: IntegrityView | undefined) {
  if (state === undefined) {
    return card(
      el('h2', {}, 'Integrity'),
      el('p', {}, 'This guard-core keeps no execution record.'),
    )
  }
  const anchor = state.lastAnchor
  return card(
    el('h2', {}, 'Integrity'),
    state.brokenAt === undefined
      ? el(
          'p',
          { class: 'badge-line ok' },
          `✓ Intact: ${state.lastSeq} receipts, each one linked and signed.`,
        )
      : el(
          'p',
          { class: 'badge-line stop' },
          `✗ Broken at receipt #${state.brokenAt}: it, or one after it, was changed or removed after it was written.`,
        ),
    anchor === undefined
      ? el('p', { class: 'muted' }, 'Not anchored on a chain yet.')
      : el(
          'p',
          { class: 'muted' },
          `Anchored up to #${anchor.toSeq} on ${chainName(anchor.chain)}, ${when(anchor.anchoredAt)}, in transaction `,
          el('code', {}, anchor.txId),
        ),
  )
}

/** The bundle exactly as guard-core sent it, saved as a file anyone can verify offline. */
function save(name: string, data: unknown) {
  const url = URL.createObjectURL(
    new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' }),
  )
  const link = el('a', { href: url, download: name })
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** A payment with its amount when its receipt is in the window; otherwise just "Payment". */
function title(receipt: ReceiptView, payments: Map<string, Paid>): string {
  if (receipt.kind !== 'payment') {
    return `${receipt.server} · ${receipt.tool}`
  }
  const intent =
    receipt.paymentReceipt === undefined ? undefined : payments.get(receipt.paymentReceipt)
  return intent === undefined
    ? 'Payment'
    : `Payment ${amountText(intent)} on ${chainName(intent.chain)}`
}

function entry(
  ctx: Context,
  receipt: ReceiptView,
  anchoredTo: number,
  payments: Map<string, Paid>,
) {
  const what = title(receipt, payments)
  return el(
    'div',
    { class: 'item' },
    el(
      'strong',
      {},
      `#${receipt.seq} ${what}`,
      el(
        'span',
        { class: `badge ${receipt.outcome === 'ok' ? 'ok' : 'stop'}` },
        OUTCOME[receipt.outcome],
      ),
      el('span', { class: 'badge shadow' }, receipt.assurance),
    ),
    el('span', {}, `${receipt.agentId}, ${when(receipt.startedAt)}`),
    receipt.seq <= anchoredTo
      ? button('Download proof', async () => {
          save(`defimind-proof-${receipt.seq}.json`, await ctx.api.proof(receipt.seq))
        })
      : el('span', { class: 'muted' }, 'Proof once anchored.'),
  )
}

export async function executions(ctx: Context, now = new Date()): Screen {
  const from = new Date(now.getTime() - 7 * DAY)
  const [state, { receipts }, paid] = await Promise.all([
    ctx.api.integrity().catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 404) {
        return undefined
      }
      throw error
    }),
    ctx.api.executions(from, now),
    ctx.api.receipts(from, now).then(({ receipts: raw }) => byHash(raw)),
  ])
  const newest = receipts.slice(-SHOWN).reverse()
  const anchoredTo = state?.lastAnchor?.toSeq ?? 0
  return [
    el('h1', {}, 'Executions'),
    integrityCard(state),
    card(
      el('h2', {}, 'Last 7 days'),
      el('p', { class: 'muted' }, EXECUTED),
      el('p', { class: 'muted' }, RELAYED),
      newest.length === 0 && el('p', {}, 'Nothing recorded in these 7 days.'),
      ...newest.map((receipt) => entry(ctx, receipt, anchoredTo, paid)),
      receipts.length > SHOWN &&
        el('p', { class: 'muted' }, `The newest ${SHOWN} of ${receipts.length}.`),
    ),
  ]
}
