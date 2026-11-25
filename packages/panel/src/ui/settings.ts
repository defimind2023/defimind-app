import { disablePush, enablePush, pushEnabled } from '../adapters/push.js'
import type { SettingsView } from '../adapters/schemas.js'
import { chainName } from '../domain/chains.js'
import { changedSettings } from '../domain/settings.js'
import type { Context, Screen } from './context.js'
import { button, card, el, when } from './dom.js'
import { ownerKeyCard } from './owner-key.js'
import { spendingCards } from './spending.js'

function pushSwitch(ctx: Context, on: boolean) {
  const toggle = el('input', { id: 'push', type: 'checkbox', role: 'switch' })
  toggle.checked = on
  toggle.addEventListener('change', () => {
    const want = toggle.checked
    toggle.disabled = true
    void (want ? enablePush(ctx.api) : disablePush(ctx.api))
      .then(() => ctx.say(want ? 'Notifications on.' : 'Notifications off.', 'done'))
      .catch((error: unknown) => {
        toggle.checked = !want
        ctx.say(error instanceof Error ? error.message : 'Could not change notifications.', 'stop')
      })
      .finally(() => {
        toggle.disabled = false
      })
  })
  return el('label', { class: 'check' }, toggle, 'Notify this device of approvals and alerts')
}

/** CR-019: each chain's RPC and vault. guard-core adopts a vault only once it reads it on chain. */
function chainsCard(ctx: Context, current: SettingsView['chains']) {
  const fields = current.map(({ chain, rpcUrl, vault }, i) => {
    const rpc = el('input', {
      id: `rpc-${i}`,
      type: 'url',
      autocomplete: 'off',
      spellcheck: 'false',
    })
    const box = el('input', { id: `vault-${i}`, autocomplete: 'off', spellcheck: 'false' })
    rpc.value = rpcUrl ?? ''
    box.value = vault ?? ''
    return {
      chain,
      rpc,
      box,
      nodes: [
        el('h3', {}, chainName(chain)),
        el('label', { for: rpc.id }, 'RPC address (leave empty for the default)'),
        rpc,
        el('label', { for: box.id }, 'Vault address'),
        box,
      ],
    }
  })
  return card(
    el('h2', {}, 'Chains'),
    el(
      'p',
      { class: 'muted' },
      'The vault must be the one you made for DefiMind: DefiMind checks on the chain that its limit names DefiMind before it uses it.',
    ),
    ...fields.flatMap((field) => field.nodes),
    current.length === 0 && el('p', {}, 'No chain is turned on.'),
    current.length > 0 &&
      button(
        'Save with passkey',
        async () => {
          const changed = changedSettings(
            current,
            fields.map(({ chain, rpc, box }) => ({ chain, rpcUrl: rpc.value, vault: box.value })),
          )
          if (changed.length === 0) {
            ctx.say('Nothing changed.')
            return
          }
          await ctx.api.putSettings(changed)
          await ctx.go({ name: 'settings' }, true)
          ctx.say('Saved. Confirmed with your passkey.', 'done')
        },
        'primary',
      ),
  )
}

export async function settings(ctx: Context): Screen {
  const [{ passkeys }, push, { chains }, spending] = await Promise.all([
    ctx.api.passkeys(),
    pushEnabled(),
    ctx.api.settings(),
    spendingCards(ctx),
  ])
  return [
    el('h1', {}, 'Settings'),
    chainsCard(ctx, chains),
    chains.length > 0 && ownerKeyCard(chains.map((c) => c.chain)),
    ...spending,
    card(el('h2', {}, 'Notifications'), pushSwitch(ctx, push)),
    card(
      el('h2', {}, 'Passkeys'),
      ...passkeys.map((key) =>
        el(
          'div',
          { class: 'item' },
          el('strong', {}, `…${key.id.slice(-8)}`),
          el('span', {}, `Added ${when(key.createdAt)}`),
          el(
            'span',
            { class: 'muted' },
            key.lastUsedAt ? `Last used ${when(key.lastUsedAt)}` : 'Never used',
          ),
        ),
      ),
      el('p', { class: 'muted' }, 'Removing a passkey is a command on the guard-core machine.'),
    ),
    button('Sign out', async () => {
      await ctx.api.logout()
      await ctx.go({ name: 'login' })
    }),
  ]
}
