import type { KeysView } from '../adapters/schemas.js'
import { chainName } from '../domain/chains.js'
import { isSolana } from '../domain/guide.js'
import { gasText, lowGas } from '../domain/wallets.js'
import type { Context } from './context.js'
import { button, card, el, row } from './dom.js'

/** What each chain's native coin is for, and roughly how much is enough. */
const need = (chain: string) =>
  isSolana(chain)
    ? 'About $1 of SOL covers fees and new token accounts.'
    : 'A little ETH covers its network fees.'

function copy(ctx: Context, address: string) {
  return button('Copy address', async () => {
    await navigator.clipboard.writeText(address)
    ctx.say('Address copied.', 'done')
  })
}

type Hot = KeysView['hotWallets'][number]

/**
 * The shared spending (hot) wallet of one chain. It pays from the vault within the daily limit, but
 * its fees come from its own native coin, which the owner sends it once: the address is in full.
 */
function hotCard(ctx: Context, { chain, address, gas }: Hot) {
  const known = gas !== undefined && gas.symbol !== ''
  return card(
    el('h2', {}, `Spending wallet · ${chainName(chain)}`),
    el(
      'p',
      {},
      'Your agents pay from this wallet, which draws from your vault within the daily limit. Its network fees come from its own balance.',
    ),
    el('code', { class: 'token' }, address),
    copy(ctx, address),
    known &&
      el(
        'dl',
        {},
        row('Balance', gasText(chain, gas.balance, gas.symbol)),
        row('Needs at least', gasText(chain, gas.minimum, gas.symbol)),
      ),
    known && lowGas(gas) && el('p', { class: 'flag' }, `Send ${gas.symbol} to the address above.`),
    el('p', { class: 'muted' }, need(chain)),
    !known && el('p', { class: 'muted' }, 'Doctor shows whether it has enough.'),
  )
}

/** CR-022: an agent's own wallet pays its own fees; its gas shows on the agent's page. */
function ownCard(ctx: Context, wallet: NonNullable<KeysView['agentWallets']>[number]) {
  return card(
    el('h2', {}, `${wallet.agentId}'s own wallet · ${chainName(wallet.chain)}`),
    el('code', { class: 'token' }, wallet.address),
    copy(ctx, wallet.address),
    el('p', { class: 'muted' }, `${need(wallet.chain)} Its balance shows on the agent's page.`),
  )
}

/** Every spending wallet this DefiMind runs, or none on a guard-core that does not list them. */
export async function spendingCards(ctx: Context) {
  const keys = await ctx.api.keys().catch(() => undefined)
  if (keys === undefined) {
    return []
  }
  return [
    ...keys.hotWallets.map((hot) => hotCard(ctx, hot)),
    ...(keys.agentWallets ?? []).map((wallet) => ownCard(ctx, wallet)),
  ]
}
