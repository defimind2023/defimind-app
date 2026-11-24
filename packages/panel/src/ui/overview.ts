import type { Overview } from '../adapters/schemas.js'
import { chainName, networkOf } from '../domain/chains.js'
import { amountText, formatUsd, meterPercent } from '../domain/money.js'
import { swapTitle } from '../domain/trading.js'
import { doneSteps, nextStep, STEPS, type StepId } from '../domain/guide.js'
import { href, type Route } from '../domain/route.js'
import type { Context, Screen } from './context.js'
import { card, el, meter, when } from './dom.js'

const link = (route: Route, ...children: (Node | string)[]) =>
  el('a', { href: href(route), class: 'item' }, ...children)

function allowance(value: Overview['chains'][number]['allowance']): string {
  if (value === null) {
    return 'Could not be read'
  }
  if (value.status === 'none') {
    return 'No onchain limit (killed)'
  }
  return `${formatUsd(value.spent)} of ${formatUsd(value.cap)} spent, resets ${when(value.resetsAt)}`
}

export function agentBadges(agent: { paused: boolean; mode: 'live' | 'shadow' }) {
  return [
    agent.mode === 'shadow' && el('span', { class: 'badge shadow' }, 'shadow'),
    agent.paused && el('span', { class: 'badge stop' }, 'paused'),
  ]
}

/**
 * The steps done, for the way back into the guided setup. A guard-core older than CR-019 has no
 * progress route, and the overview must still load there.
 */
const setupDone = (ctx: Context) =>
  ctx.api
    .progress()
    .then(({ steps }) => doneSteps(steps))
    .catch(() => undefined)

function setupNotice(done: Set<StepId> | undefined) {
  return (
    done !== undefined &&
    nextStep(done) !== undefined &&
    card(
      el('h2', {}, 'Finish setting up'),
      el('p', {}, `${done.size} of ${STEPS.length} steps done.`),
      el('a', { href: href({ name: 'guide' }), class: 'button primary' }, 'Continue'),
    )
  )
}

/** Accurate but alarming for an owner one step into the guide: point them to the vault step. */
function noChain(done: Set<StepId> | undefined) {
  return done !== undefined && !done.has('vault')
    ? el(
        'p',
        {},
        'No vault yet: finish the guided setup. ',
        el('a', { href: href({ name: 'guide', step: 'vault' }) }, 'Create your vault'),
      )
    : el('p', {}, 'No chain is configured: every payment is refused.')
}

const cell = (label: string, value: string) =>
  el('div', {}, el('div', { class: 'label' }, label), el('div', { class: 'value' }, value))

/**
 * Today's spend against each chain's onchain cap, one block per chain: their tokens are not summed.
 * Then the counts the owner looks for first. All of it from the overview already fetched.
 */
function summary(data: Overview) {
  const active = data.chains.flatMap(({ chain, allowance }) =>
    allowance?.status === 'active' ? [{ chain, ...allowance }] : [],
  )
  const waiting = data.pending.length + data.mandates.length
  const names = data.chains.map(({ chain }) => chainName(chain))
  return el(
    'section',
    { class: 'card summary' },
    ...active.map(({ chain, spent, cap }) =>
      el(
        'div',
        { class: 'spend' },
        el(
          'div',
          { class: 'label' },
          active.length > 1 ? `Spent today · ${chainName(chain)}` : 'Spent today',
        ),
        el('div', { class: 'big' }, formatUsd(spent), el('small', {}, `of ${formatUsd(cap)}`)),
        meter(meterPercent(spent, cap)),
      ),
    ),
    el(
      'div',
      { class: 'split' },
      cell('Agents', String(data.agents.length)),
      cell('Waiting', String(waiting)),
      cell(names.length > 1 ? 'Chains' : 'Chain', names.join(', ') || 'None'),
    ),
  )
}

/** The header's network, from the chains the overview names; left blank when it cannot be told. */
function showNetwork(chains: string[]) {
  const slot = document.getElementById('network')
  const network = networkOf(chains)
  if (slot === null) {
    return
  }
  slot.hidden = network === undefined
  slot.className = `network ${network === 'Mainnet' ? 'ok' : 'warn'}`
  slot.textContent = network ?? ''
}

export async function overview(ctx: Context): Screen {
  const [data, done] = await Promise.all([ctx.api.overview(), setupDone(ctx)])
  const waiting = data.pending.length + data.mandates.length
  showNetwork(data.chains.map(({ chain }) => chain))
  const today = new Date().toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
  return [
    el('div', { class: 'title' }, el('h1', {}, 'Overview'), el('span', { class: 'date' }, today)),
    summary(data),
    setupNotice(done),
    el('a', { href: href({ name: 'kill' }), class: 'kill' }, 'Stop everything'),
    el(
      'section',
      { class: waiting === 0 ? 'card' : 'card req' },
      el('h2', {}, waiting === 0 ? 'Nothing waiting' : `Waiting for you (${waiting})`),
      ...data.pending.map(({ intent }) =>
        link(
          { name: 'approval', id: intent.id },
          el('strong', {}, intent.kind === 'swap' ? swapTitle(intent) : amountText(intent)),
          el('span', {}, `${intent.agentId} on ${chainName(intent.chain)}`),
          el(
            'span',
            { class: 'muted' },
            intent.swap?.tokenOut ?? intent.domain ?? intent.recipient,
          ),
        ),
      ),
      ...data.mandates.map(({ mandate }) =>
        link(
          { name: 'mandate', id: mandate.id },
          el('strong', {}, `Task budget ${formatUsd(mandate.budget)}`),
          el('span', {}, mandate.agentId),
          el('span', { class: 'muted' }, mandate.reason),
        ),
      ),
    ),
    card(
      el('h2', {}, 'Chains'),
      data.chains.length === 0 && noChain(done),
      ...data.chains.map((chain) =>
        el(
          'div',
          { class: 'item' },
          el('strong', {}, chainName(chain.chain)),
          el('span', {}, allowance(chain.allowance)),
        ),
      ),
    ),
    card(
      el('h2', {}, 'Agents'),
      data.agents.length === 0 && el('p', {}, 'No agents yet.'),
      ...data.agents.map((agent) =>
        link(
          { name: 'agent', id: agent.agentId },
          el('strong', {}, agent.agentId, ...agentBadges(agent)),
        ),
      ),
    ),
  ]
}
