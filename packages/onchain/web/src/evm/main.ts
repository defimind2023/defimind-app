import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  isAddressEqual,
  type Address,
  type PublicClient,
} from 'viem'
import { z } from 'zod'
import { askCap, askDeposit, cap, deposit, EXPIRED, expired, issued, problems } from '../link.js'
import { unreadable } from '../proof.js'
import { button, decoded, link, show, waitFor } from '../view.js'
import { openInPhantom } from '../wallet.js'
import { prepareEvmCreate } from './create.js'
import { cannotRead, NOT_ASKED } from '../decoded.js'
import { decodeEvm } from './decoded.js'
import { prepareEvmDeposit } from './deposit.js'
import { prepareEvmEnable } from './enable.js'
import { whichHot } from '../hot.js'
import { prepareEvmKill } from './kill.js'
import type { EvmPlan } from './plan.js'
import { proveEvm } from './proof.js'
import { onChain, phantomEvm, type Eip1193 } from './wallet.js'

/** What the build fixed for one EVM chain: its id, the module, the dollar token, the hot wallets. */
export interface EvmChain {
  name: string
  chainId: number
  rpc: string
  module: Address
  usd: Address
  symbol: string
  hot?: Address
  agents: Address[]
}

const address = z
  .string()
  .refine((value) => isAddress(value), 'not an EVM address')
  .transform((value) => getAddress(value))
// `hot` is optional, and only ever checked against the hot wallet the page was built for.
const hot = address.optional()
const evmLink = z.discriminatedUnion('action', [
  z.object({ action: z.literal('kill'), safe: address, hot, issued }),
  z.object({ action: z.literal('create') }),
  z.object({ action: z.literal('proof'), safe: address }),
  z.object({ action: z.literal('deposit'), safe: address, amount: deposit }),
  z.object({
    action: z.literal('enable'),
    safe: address,
    hot,
    amount: cap,
  }),
])
type EvmLink = z.infer<typeof evmLink>

const refuse = (reason: string): EvmPlan => ({ kind: 'refused', reason })

export async function evmMain(query: Record<string, string>, chain: EvmChain) {
  const parsed = evmLink.safeParse(query)
  if (!parsed.success) {
    show('This link is not valid', [problems(parsed.error)], 'stop')
    return
  }
  const client = createPublicClient({ transport: http(chain.rpc) }) as PublicClient
  const proving = parsed.data.action === 'proof'
  if ((await client.getChainId()) !== chain.chainId) {
    const reason = `This page's RPC for ${chain.name} serves another chain.`
    show(proving ? 'Not verified' : 'Nothing to sign', [reason], 'stop')
    return
  }
  if (parsed.data.action === 'proof') {
    await prove(client, chain, parsed.data.safe)
    return
  }
  const wallet = phantomEvm()
  if (!wallet) {
    show('Open this page in Phantom', ['No Phantom wallet was found in this browser.'], 'stop')
    link('Open in Phantom', openInPhantom(location.href))
    return
  }
  const [account] = z
    .array(address)
    .min(1)
    .parse(await wallet.request({ method: 'eth_requestAccounts' }))
  if (!(await onChain(wallet, chain.chainId))) {
    const reason = `Phantom did not switch to ${chain.name} (chain ${chain.chainId}).`
    show('Nothing to sign', [reason], 'stop')
    return
  }
  show('Checking the chain…', [])
  await run(client, wallet, account!, await prepare(client, chain, parsed.data, account!))
}

/** Read-only: anyone can open it, with no wallet, and nothing on the way asks for a signature. */
async function prove(client: PublicClient, chain: EvmChain, safe: Address) {
  const hots = [...(chain.hot ? [chain.hot] : []), ...chain.agents]
  if (hots.length === 0) {
    show('Not verified', [`This page knows no hot wallet for ${chain.name}.`], 'stop')
    return
  }
  show('Reading the chain…', [])
  const { module, usd, symbol } = chain
  const proof = await proveEvm(client, {
    cluster: chain.name,
    safe,
    hots,
    module,
    usd,
    symbol,
  }).catch(unreadable)
  show(proof.title, proof.lines, proof.verified ? 'done' : 'stop')
}

async function prepare(
  client: PublicClient,
  chain: EvmChain,
  request: Exclude<EvmLink, { action: 'proof' }>,
  owner: Address,
): Promise<EvmPlan> {
  if (request.action === 'create') {
    return prepareEvmCreate(client, chain.name, owner)
  }
  if (request.action === 'kill' && expired(request.issued)) {
    return refuse(EXPIRED)
  }
  if (request.action === 'deposit') {
    const { usd, symbol } = chain
    return prepareEvmDeposit(
      client,
      { cluster: chain.name, safe: request.safe, usd, symbol },
      owner,
      () => askDeposit(symbol, request.amount),
    )
  }
  const hot = whichHot(
    { shared: chain.hot, agents: chain.agents },
    request.hot,
    request.action === 'kill',
    (a, b) => isAddressEqual(a, b),
    (key) => key,
  )
  if (typeof hot === 'string') {
    return refuse(hot)
  }
  const { module, usd, symbol } = chain
  const known = { cluster: chain.name, safe: request.safe, hot: hot.key, module, usd }
  if (request.action === 'kill') {
    return prepareEvmKill(client, { ...known, fromLink: hot.fromLink }, owner)
  }
  const amount = request.amount ?? (await askCap(symbol))
  return prepareEvmEnable(client, { ...known, symbol, amount }, owner)
}

async function run(client: PublicClient, wallet: Eip1193, owner: Address, plan: EvmPlan) {
  if (plan.kind === 'refused') {
    show('Nothing to sign', [plan.reason], 'stop')
    return
  }
  if (plan.kind === 'done') {
    show(plan.title, plan.summary, 'done')
    return
  }
  const what = decodeEvm(plan.to, plan.data)
  if (cannotRead(what)) {
    show('Nothing to sign', NOT_ASKED, 'stop')
    decoded(what)
    return
  }
  // The exact call Phantom will send, from the owner: the Safe takes its approval only from them.
  try {
    await client.call({ account: owner, to: plan.to, data: plan.data })
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] : String(error)
    show('Nothing to sign', [`The chain would refuse this transaction: ${reason}`], 'stop')
    return
  }
  show(plan.title, plan.summary)
  decoded(what)
  try {
    await wallet.request({
      method: 'eth_sendTransaction',
      params: [{ from: owner, to: plan.to, data: plan.data, value: '0x0' }],
    })
  } catch (error) {
    show(plan.title, [...plan.summary, `Not sent: ${String(error)}`], 'stop')
    decoded(what)
    button('Ask Phantom again', () => void run(client, wallet, owner, plan))
    return
  }
  show('Waiting for the chain…', plan.summary)
  await waitFor(plan)
}
