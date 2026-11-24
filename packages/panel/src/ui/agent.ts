import type { BudgetView, PolicyView } from '../adapters/schemas.js'
import { chainName } from '../domain/chains.js'
import { isSolana } from '../domain/guide.js'
import { href } from '../domain/route.js'
import { fromForm, toForm } from '../domain/form.js'
import { formatUsd } from '../domain/money.js'
import { chainRules, loosens } from '../domain/policy.js'
import type { Context, Screen } from './context.js'
import { button, card, el, row, when } from './dom.js'
import { tradingForm } from './trading.js'
import { FLAGS } from '../domain/trading.js'
import { ownerTrading, tokenSearch } from './token-search.js'
import { stopAgentCard, walletsCard } from './wallets.js'

function field(id: string, label: string, value: string, multiline = false) {
  const input = multiline
    ? el('textarea', { id, rows: '3', spellcheck: 'false' })
    : el('input', { id, inputmode: 'decimal', autocomplete: 'off' })
  input.value = value
  return { input, nodes: [el('label', { for: id }, label), input] }
}

/** GC-68: what going live would change, before the owner does it. */
function wouldAsk(budget: BudgetView) {
  const asked = budget.shadow?.asked
  if (asked === undefined || asked.count === 0) {
    return false
  }
  const times = asked.count === 1 ? 'once' : `${asked.count} times`
  const why = asked.flags.map((flag) => `${flag} (${FLAGS[flag] ?? 'flagged by guard-core'})`)
  return el(
    'p',
    { class: 'flag' },
    `Live would have asked you ${times}${why.length > 0 ? `: ${why.join('; ')}` : '.'}`,
  )
}

function shadowLine(budget: BudgetView): string {
  if (budget.shadow) {
    return `Would have spent ${formatUsd(budget.shadow.total)} in ${budget.shadow.count} payments since ${when(budget.shadow.since)}.`
  }
  return `Would have spent ${formatUsd(budget.shadowSpentToday ?? '0')} today.`
}

/** Saves a policy, with a passkey first when SPEC says the change loosens it. */
async function save(ctx: Context, before: PolicyView, after: PolicyView, message: string) {
  const loose = loosens(before, after)
  await ctx.api.putPolicy(after, loose)
  await ctx.go({ name: 'agent', id: before.agentId }, true)
  ctx.say(loose ? `${message} Confirmed with your passkey.` : message, 'done')
}

/** One box per chain this deployment runs: ticking it lets the agent pay there in its dollar. */
function chainBoxes(known: string[], policy: PolicyView) {
  const boxes = known.map((chain, i) => {
    const box = el('input', { id: `chain-${i}`, type: 'checkbox' })
    box.checked = policy.chains.includes(chain)
    return { chain, box }
  })
  return {
    picked: () => boxes.filter(({ box }) => box.checked).map(({ chain }) => chain),
    nodes: [
      el('p', {}, 'Where it may pay'),
      ...boxes.map(({ chain, box }) =>
        el('label', { class: 'check' }, box, `${chainName(chain)}, in its dollar`),
      ),
    ],
  }
}

function policyForm(ctx: Context, policy: PolicyView, known: string[]) {
  const form = toForm(policy)
  const chains = chainBoxes(known, policy)
  const perTx = field('per-tx', 'Per payment, in dollars', form.perTxMax)
  const daily = field('daily', 'Per day, in dollars', form.dailyMax)
  const ask = field('threshold', 'Ask me from, in dollars', form.approvalThreshold)
  const domains = field(
    'domains',
    'Paid APIs it may use (one host per line)',
    form.allowedDomains,
    true,
  )
  const recipients = field(
    'recipients',
    'Addresses it may pay (one per line)',
    form.allowedRecipients,
    true,
  )
  const mandate = el('input', { id: 'mandate', type: 'checkbox' })
  mandate.checked = form.requireMandate
  return card(
    el('h2', {}, 'Policy'),
    el(
      'dl',
      {},
      known.length === 0 && row('Chains', policy.chains.map(chainName).join(', ') || 'none'),
      row('Tokens', el('span', { class: 'mono' }, policy.tokens.join(', ') || 'none')),
    ),
    ...(known.length > 0 ? chains.nodes : []),
    ...perTx.nodes,
    ...daily.nodes,
    ...ask.nodes,
    ...domains.nodes,
    ...recipients.nodes,
    el('label', { class: 'check' }, mandate, 'Only pay inside a task budget I approved'),
    el('p', { class: 'muted' }, 'Raising a limit or adding to a list asks for your passkey.'),
    button(
      'Save policy',
      async () => {
        const after = fromForm(policy, {
          perTxMax: perTx.input.value,
          dailyMax: daily.input.value,
          approvalThreshold: ask.input.value,
          allowedDomains: domains.input.value,
          allowedRecipients: recipients.input.value,
          requireMandate: mandate.checked,
        })
        if (typeof after === 'string') {
          ctx.say(after, 'stop')
          return
        }
        await save(ctx, policy, chainRules(after, known, chains.picked()), 'Policy saved.')
      },
      'primary',
    ),
  )
}

export async function agent(ctx: Context, id: string): Screen {
  // A guard-core older than CR-019 has no settings route: the chains are then shown, not edited.
  // A guard-core before CR-022 has no agent wallets: the card is then left out.
  const [policy, budget, known, wallets] = await Promise.all([
    ctx.api.policy(id),
    ctx.api.budget(id),
    ctx.api
      .settings()
      .then(({ chains }) => chains.map((c) => c.chain))
      .catch(() => []),
    ctx.api
      .agentWallets(id)
      .then(({ wallets }) => wallets)
      .catch(() => undefined),
  ])
  const shadow = policy.mode === 'shadow'
  // CR-025: tokens are searched and traded on Solana only, as agents trade.
  const solana = known.find(isSolana)
  const tools = solana !== undefined && (await ownerTrading(ctx, solana))
  return [
    el('h1', {}, id),
    card(
      el('h2', { class: `pill ${shadow ? 'wait' : 'ok'}` }, shadow ? 'Shadow mode' : 'Live'),
      el(
        'p',
        {},
        shadow
          ? 'Every payment is checked and simulated, and none is signed.'
          : 'Payments inside the policy are signed and sent.',
      ),
      shadow && el('p', { class: 'shadow-total' }, shadowLine(budget)),
      shadow && wouldAsk(budget),
      button(
        shadow ? 'Go live with passkey' : 'Switch to shadow',
        async () =>
          save(
            ctx,
            policy,
            { ...policy, mode: shadow ? 'live' : 'shadow' },
            shadow ? 'Live.' : 'In shadow mode.',
          ),
        shadow ? 'primary' : 'secondary',
      ),
    ),
    card(
      el('h2', {}, 'Today'),
      el(
        'dl',
        {},
        row('Spent', `${formatUsd(budget.spentToday)} of ${formatUsd(budget.dailyMax)}`),
        row('Per payment', formatUsd(budget.perTxMax)),
        row(
          'State',
          el(
            'span',
            { class: `pill ${budget.paused ? 'wait' : 'ok'}` },
            budget.paused ? 'Paused' : 'Running',
          ),
        ),
      ),
      budget.paused
        ? button(
            'Resume with passkey',
            async () => {
              await ctx.api.resume(id)
              await ctx.go({ name: 'agent', id }, true)
              ctx.say('Resumed.', 'done')
            },
            'primary',
          )
        : button('Pause', async () => {
            await ctx.api.pause(id)
            await ctx.go({ name: 'agent', id }, true)
            ctx.say('Paused: its payments are refused.', 'done')
          }),
    ),
    policyForm(ctx, policy, known),
    tradingForm(ctx, policy, (after, message) => save(ctx, policy, after, message)),
    tools &&
      solana !== undefined &&
      tokenSearch(ctx, policy, solana, (after, message) => save(ctx, policy, after, message)),
    tools &&
      policy.trading?.enabled === true &&
      el('a', { href: href({ name: 'trade', id }), class: 'button' }, 'Trade by hand'),
    wallets !== undefined && walletsCard(ctx, id, known, wallets),
    wallets !== undefined && stopAgentCard(ctx, id),
    card(
      el('h2', {}, 'Revoke'),
      el('p', {}, 'Cuts the agent off at its next request. Its token never works again.'),
      button(
        'Revoke agent',
        async () => {
          if (confirm(`Revoke ${id}? This cannot be undone.`)) {
            await ctx.api.revokeAgent(id)
            await ctx.go({ name: 'agents' })
            ctx.say(`Revoked ${id}.`, 'done')
          }
        },
        'danger',
      ),
    ),
  ]
}
