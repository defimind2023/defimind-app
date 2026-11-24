import type { AgentWalletView } from '../adapters/schemas.js'
import { chainName } from '../domain/chains.js'
import { gasText, lowGas, sameOrigin } from '../domain/wallets.js'
import type { Context } from './context.js'
import { button, card, el, row } from './dom.js'
import { onchain } from './kill.js'
import { walletLinks } from './steps.js'

const STATUS = { pending_limit: 'Waiting for its limit', active: 'Active' } as const

/** Where a wallet is on its way: sign the limit, then send it gas; active once guard-core reads both. */
function walletItem(wallet: AgentWalletView) {
  const page = sameOrigin(wallet.addLimitPage, location.origin)
  const gas = wallet.gas
  const short = gas !== undefined && gas.symbol !== '' && lowGas(gas)
  return el(
    'div',
    { class: 'wallet' },
    el('h3', {}, chainName(wallet.chain)),
    el(
      'dl',
      {},
      row(
        'State',
        el(
          'span',
          { class: `pill ${wallet.status === 'active' ? 'ok' : 'wait'}` },
          STATUS[wallet.status],
        ),
      ),
      row('Address', el('span', { class: 'mono' }, wallet.address)),
      // guard-core sends an empty symbol when it could not read the gas.
      gas !== undefined &&
        gas.symbol !== '' &&
        row(
          'Gas',
          `${gasText(wallet.chain, gas.balance, gas.symbol)} (needs at least ${gasText(wallet.chain, gas.minimum, gas.symbol)})`,
        ),
    ),
    wallet.status === 'pending_limit' &&
      el(
        'p',
        {},
        'Sign its daily limit in your wallet. Until guard-core reads that limit on the chain, the agent keeps using the shared wallet.',
      ),
    ...(wallet.status === 'pending_limit' ? walletLinks(page, 'Sign the limit') : []),
    short &&
      el(
        'p',
        { class: 'flag' },
        `Send a little ${gas.symbol} to the address above: the agent's wallet pays its own fees.`,
      ),
  )
}

/**
 * CR-022, HIGH-2: opt-in, per agent and chain. The benefit and the limit of the design are said
 * plainly; nothing here promises more than the onchain cap gives.
 */
export function walletsCard(
  ctx: Context,
  agentId: string,
  chains: string[],
  wallets: AgentWalletView[],
) {
  const missing = chains.filter((chain) => !wallets.some((wallet) => wallet.chain === chain))
  return card(
    el('h2', {}, 'Own wallet'),
    el(
      'p',
      {},
      "By default every agent spends from one shared wallet per chain. With its own wallet and daily limit, this agent's problem stays within its own cap: a bug or a hijack cannot spend another agent's share.",
    ),
    el(
      'p',
      { class: 'muted' },
      'All agent keys still sit on this one DefiMind server. If the server itself is broken into, the most at risk is the sum of every daily limit.',
    ),
    ...wallets.map(walletItem),
    ...missing.map((chain) =>
      button(
        `Give it its own wallet on ${chainName(chain)}`,
        async () => {
          await ctx.api.createAgentWallet(agentId, chain)
          await ctx.go({ name: 'agent', id: agentId }, true)
          ctx.say('Wallet created. Now sign its limit.', 'done')
        },
        'secondary',
      ),
    ),
  )
}

/** CR-022: pauses this agent alone; its own wallets' limits come off with the owner's signature. */
export function stopAgentCard(ctx: Context, agentId: string) {
  const result = el('div')
  return card(
    el('h2', {}, 'Stop this agent'),
    el(
      'p',
      {},
      "Pauses this agent at once. If it has its own wallet, then remove that wallet's limit with your wallet. Other agents keep running.",
    ),
    button(
      'Stop this agent',
      async () => {
        const done = await ctx.api.killAgent(agentId)
        ctx.say(`Stopped ${agentId}.`, 'done')
        result.replaceChildren(
          ...done.ownerTransactions.map((tx) => onchain(tx, `${agentId} is paused.`)),
        )
      },
      'kill',
    ),
    result,
  )
}
