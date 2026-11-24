import { href } from '../domain/route.js'
import type { Context, Screen } from './context.js'
import { button, card, el } from './dom.js'
import { agentBadges } from './overview.js'

const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/

/** The token exists in this response only: guard-core keeps its hash. */
function token(value: string) {
  const code = el('code', { class: 'token' }, value)
  return card(
    el('h2', {}, 'Agent token'),
    el('p', {}, "Shown once. Put it in the agent's config now: it cannot be shown again."),
    code,
    button('Copy token', async () => navigator.clipboard.writeText(value), 'primary'),
  )
}

export async function agents(ctx: Context): Screen {
  const { agents: list } = await ctx.api.agents()
  const input = el('input', {
    id: 'agent-id',
    autocomplete: 'off',
    maxlength: '64',
    placeholder: 'for example research-bot',
  })
  const slot = el('div')
  const create = button(
    'Create with passkey',
    async () => {
      const id = input.value.trim()
      if (id === '') {
        ctx.say('Type a name for the agent first.', 'stop')
        return
      }
      if (!AGENT_ID.test(id)) {
        ctx.say('Use letters, digits, - and _ only, up to 64.', 'stop')
        return
      }
      const created = await ctx.api.createAgent(id)
      input.value = ''
      slot.replaceChildren(token(created.token))
      ctx.say(`Created ${created.agentId}. It starts in shadow mode and may pay nothing.`, 'done')
    },
    'primary',
  )
  return [
    el('h1', {}, 'Agents'),
    card(
      ...list.map((agent) =>
        el(
          'a',
          { href: href({ name: 'agent', id: agent.agentId }), class: 'item' },
          el('strong', {}, agent.agentId, ...agentBadges(agent)),
        ),
      ),
      list.length === 0 && el('p', {}, 'No agents yet.'),
    ),
    card(el('h2', {}, 'New agent'), el('label', { for: 'agent-id' }, 'Name'), input, create),
    slot,
  ]
}
