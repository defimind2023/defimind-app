import { formatUsd } from '../domain/money.js'
import { chainRules, loosens, vaulted } from '../domain/policy.js'
import { mcpCommand, type StepId } from '../domain/guide.js'
import type { Context } from './context.js'
import { button, card, el, type Child } from './dom.js'

/** Rule presets in dollar-token units: per payment, per day, and the amount from which it asks. */
export const PRESETS = {
  Careful: { perTxMax: '1000000', dailyMax: '5000000', approvalThreshold: '500000' },
  Standard: { perTxMax: '5000000', dailyMax: '20000000', approvalThreshold: '1000000' },
} as const

export const next = (ctx: Context, step: StepId, label = 'Next') =>
  button(label, () => ctx.go({ name: 'guide', step }), 'primary')

export async function agent(ctx: Context): Promise<Child[]> {
  const [{ agents }, { chains }] = await Promise.all([ctx.api.agents(), ctx.api.settings()])
  const input = el('input', {
    id: 'agent-id',
    autocomplete: 'off',
    maxlength: '64',
    value: 'my-agent',
  })
  const slot = el('div')
  const create = button(
    'Create with passkey',
    async () => {
      const id = input.value.trim()
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
        ctx.say('Use letters, digits, - and _ only.', 'stop')
        return
      }
      const created = await ctx.api.createAgent(id)
      slot.replaceChildren(
        card(
          el('h3', {}, 'Its key'),
          el('p', {}, 'Shown only now. Copy it, then paste it when the command below asks.'),
          el('code', { class: 'token' }, created.token),
          button('Copy key', () => navigator.clipboard.writeText(created.token), 'primary'),
          el('h3', {}, 'Connect it to Claude Code'),
          el('p', {}, 'Run this once in a terminal, in your DefiMind folder:'),
          el('code', { class: 'token' }, mcpCommand(location.origin, created.agentId, chains)),
          next(ctx, 'rules'),
        ),
      )
    },
    'primary',
  )
  return [
    agents.length > 0 &&
      el('p', {}, `Connected already: ${agents.map((a) => a.agentId).join(', ')}.`),
    el('label', { for: 'agent-id' }, 'A name for your agent'),
    input,
    create,
    slot,
    el(
      'p',
      { class: 'muted' },
      "Later, on the agent's page, you can give it its own wallet and daily limit, so a problem with one agent stays within its own cap. All agent keys still sit on this one server.",
    ),
    agents.length > 0 && next(ctx, 'rules'),
  ]
}

async function firstAgent(ctx: Context) {
  return (await ctx.api.agents()).agents[0]
}

export async function rules(ctx: Context): Promise<Child[]> {
  const found = await firstAgent(ctx)
  if (found === undefined) {
    return [el('p', {}, 'First connect an agent.'), next(ctx, 'agent', 'Back to the agent')]
  }
  const [policy, { chains }] = await Promise.all([
    ctx.api.policy(found.agentId),
    ctx.api.settings(),
  ])
  const payable = vaulted(chains)
  if (payable.length === 0) {
    return [el('p', {}, 'First save your vault.'), next(ctx, 'limit', 'Back to the limit')]
  }
  const choose = (name: keyof typeof PRESETS) =>
    card(
      el('h3', {}, name),
      el(
        'p',
        {},
        `Up to ${formatUsd(PRESETS[name].perTxMax)} a payment and ${formatUsd(PRESETS[name].dailyMax)} a day. Asks you from ${formatUsd(PRESETS[name].approvalThreshold)}.`,
      ),
      button(`Use ${name}`, async () => {
        // A new agent may pay on no chain at all: the preset opens the vaulted ones and their dollar.
        const after = {
          ...chainRules(
            policy,
            chains.map((c) => c.chain),
            payable,
          ),
          ...PRESETS[name],
        }
        await ctx.api.putPolicy(after, loosens(policy, after))
        await ctx.go({ name: 'guide', step: 'shadow' })
        ctx.say(`${name} rules saved for ${found.agentId}.`, 'done')
      }),
    )
  return [
    el('p', {}, `For ${found.agentId}. You can change every number later in Agents.`),
    choose('Careful'),
    choose('Standard'),
  ]
}

export async function shadow(ctx: Context): Promise<Child[]> {
  const found = await firstAgent(ctx)
  if (found === undefined) {
    return [el('p', {}, 'First connect an agent.'), next(ctx, 'agent', 'Back to the agent')]
  }
  const budget = await ctx.api.budget(found.agentId)
  const total = budget.shadow?.total ?? budget.shadowSpentToday ?? '0'
  return [
    el(
      'p',
      {},
      `Ask ${found.agentId} to do a task that needs a paid service. It works as usual, but DefiMind only notes what it would have paid.`,
    ),
    el('p', { class: 'shadow-total' }, `Would have paid so far: ${formatUsd(total)}`),
    button('Check again', () => ctx.go({ name: 'guide', step: 'shadow' }, true)),
    next(ctx, 'live'),
  ]
}

export async function live(ctx: Context): Promise<Child[]> {
  const found = await firstAgent(ctx)
  if (found === undefined) {
    return [el('p', {}, 'First connect an agent.'), next(ctx, 'agent', 'Back to the agent')]
  }
  if (found.mode === 'live' && !found.paused) {
    return [el('p', {}, `${found.agentId} is live.`)]
  }
  return [
    el(
      'p',
      {},
      `${found.agentId} starts paying for real. You can pause it at any time from Agents.`,
    ),
    button(
      'Go live with passkey',
      async () => {
        const policy = await ctx.api.policy(found.agentId)
        const after = { ...policy, mode: 'live' as const }
        await ctx.api.putPolicy(after, true)
        if (found.paused) {
          await ctx.api.resume(found.agentId)
        }
        await ctx.go({ name: 'guide' }, true)
        ctx.say(`${found.agentId} is live.`, 'done')
      },
      'primary',
    ),
  ]
}
