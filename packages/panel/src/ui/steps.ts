import type { SettingsView } from '../adapters/schemas.js'
import { chainName } from '../domain/chains.js'
import { inPhantom, isSolana, signLink, type StepId } from '../domain/guide.js'
import { ownerKeyNote } from './owner-key.js'
import { spendingCards } from './spending.js'
import type { Context } from './context.js'
import { depositCard } from './deposit.js'
import { agent, live, next, rules, shadow } from './agent-steps.js'
import { button, el, type Child } from './dom.js'

/** The beta's ceiling on the vault's daily limit (SPEC, "Signing page"). */
const MAX_DAILY_CAP = 50

type Chain = SettingsView['chains'][number]

/**
 * The address the owner pasted after creating the vault. guard-core only adopts a vault once its
 * daily limit names DefiMind, so it is kept on this device until the limit step saves it.
 */
const draft = {
  key: (chain: string) => `defimind.vault.${chain}`,
  get(chain: string): string {
    try {
      return localStorage.getItem(this.key(chain)) ?? ''
    } catch {
      return ''
    }
  },
  set(chain: string, vault: string) {
    try {
      localStorage.setItem(this.key(chain), vault)
    } catch {
      // A private window: the owner pastes it again on the next step.
    }
  },
}

/** The chain the guide sets up: Solana when it is on, as the signing page creates vaults there. */
async function setupChain(ctx: Context): Promise<Chain | undefined> {
  const { chains } = await ctx.api.settings()
  return chains.find((c) => isSolana(c.chain)) ?? chains[0]
}

export function walletLinks(link: string | undefined, what: string): Child[] {
  if (link === undefined) {
    return [el('p', { class: 'flag' }, 'The signing page does not serve this chain yet.')]
  }
  return [
    el('a', { href: inPhantom(link), class: 'button primary' }, `${what} in Phantom`),
    el('a', { href: link, class: 'button' }, `${what} on this computer`),
  ]
}

async function vault(ctx: Context): Promise<Child[]> {
  const setup = await setupChain(ctx)
  if (setup === undefined) {
    return [el('p', { class: 'flag' }, 'No chain is turned on in this DefiMind.')]
  }
  const { chain } = setup
  const input = el('input', { id: 'vault', autocomplete: 'off', spellcheck: 'false' })
  input.value = setup.vault ?? draft.get(chain)
  return [
    el(
      'p',
      {},
      'Open the signing page with Phantom and approve. It creates your vault and shows its address.',
    ),
    ...walletLinks(signLink(location.origin, chain, { action: 'create' }), 'Create'),
    ...ownerKeyNote(chain),
    el('label', { for: 'vault' }, `Your vault address on ${chainName(chain)}`),
    input,
    button(
      'Next',
      async () => {
        const value = input.value.trim()
        if (!/^\w{32,64}$/.test(value)) {
          ctx.say('Paste the vault address the page showed.', 'stop')
          return
        }
        draft.set(chain, value)
        await ctx.go({ name: 'guide', step: 'limit' })
      },
      'primary',
    ),
  ]
}

async function limit(ctx: Context): Promise<Child[]> {
  const setup = await setupChain(ctx)
  const address = setup && (setup.vault ?? draft.get(setup.chain))
  if (setup === undefined || !address) {
    return [el('p', {}, 'First create your vault.'), next(ctx, 'vault', 'Back to the vault')]
  }
  const { chain } = setup
  const link = isSolana(chain)
    ? signLink(location.origin, chain, { action: 'add-limit', multisig: address })
    : signLink(location.origin, chain, { action: 'enable', safe: address })
  return [
    el(
      'p',
      {},
      `On the signing page, type how much your agents may take from the vault in one day, then approve in Phantom. During the beta the most is $${MAX_DAILY_CAP}.`,
    ),
    ...walletLinks(link, 'Set the limit'),
    el(
      'p',
      {},
      'Once Phantom confirms, save the vault here. DefiMind checks it on the chain first.',
    ),
    button(
      'Save vault with passkey',
      async () => {
        // The vault only: an RPC the env sets would be refused with set_by_env.
        await ctx.api.putSettings([{ chain, vault: address }])
        await ctx.go({ name: 'guide', step: 'deposit' })
        ctx.say('Vault saved.', 'done')
      },
      'primary',
    ),
  ]
}

async function deposit(ctx: Context): Promise<Child[]> {
  const { chains } = await ctx.api.deposit()
  if (chains.length === 0) {
    return [el('p', {}, 'First save your vault.'), next(ctx, 'limit', 'Back to the limit')]
  }
  return [
    ...chains.map((chain) => depositCard(ctx, chain)),
    el('p', { class: 'muted' }, 'The balance updates once the chain confirms. Reload to check.'),
    ...(await spendingCards(ctx)),
    next(ctx, 'agent'),
  ]
}

/** The body of one step: what to do now, and the way to the next one. */
export function stepBody(ctx: Context, step: StepId): Promise<Child[]> {
  switch (step) {
    case 'passkey':
      return Promise.resolve([
        el('p', {}, 'Done: your passkey is on this device.'),
        next(ctx, 'phantom'),
      ])
    case 'phantom':
      return Promise.resolve([
        el(
          'p',
          {},
          'Install Phantom on your phone or in your browser from phantom.app and create a wallet. Keep its recovery phrase on paper, never in a photo or a message.',
        ),
        el(
          'p',
          {},
          'Put a little SOL in it, about $1: the network charges a small fee for each change.',
        ),
        el(
          'a',
          { href: 'https://phantom.app/download', class: 'button', rel: 'noreferrer' },
          'Get Phantom',
        ),
        next(ctx, 'vault', 'I have Phantom'),
      ])
    case 'vault':
      return vault(ctx)
    case 'limit':
      return limit(ctx)
    case 'deposit':
      return deposit(ctx)
    case 'agent':
      return agent(ctx)
    case 'rules':
      return rules(ctx)
    case 'shadow':
      return shadow(ctx)
    case 'live':
      return live(ctx)
  }
}
