import { inPhantom, signPageUrl } from '@defimind/shared'

/**
 * CR-019's nine steps of the guided setup, in order. Each one says in plain words why it matters:
 * the owner may never have used a wallet before.
 */
export const STEPS = [
  {
    id: 'passkey',
    title: 'Your passkey',
    why: 'It proves it is you. Approving a payment, or giving an agent more room, always asks for it.',
  },
  {
    id: 'phantom',
    title: 'Connect Phantom',
    why: 'Phantom is the wallet that owns your money. DefiMind never holds it: you sign every change to your vault yourself.',
  },
  {
    id: 'vault',
    title: 'Create your vault',
    why: 'The vault keeps the money your agents may use apart from the rest of your wallet, so the rest is never at risk.',
  },
  {
    id: 'limit',
    title: 'Set a daily limit',
    why: 'The vault itself refuses to pay out more than this in a day, even if DefiMind were broken into.',
  },
  {
    id: 'deposit',
    title: 'Add money',
    why: 'Your agents can only spend what is in the vault. Start small: you can add more at any time.',
  },
  {
    id: 'agent',
    title: 'Connect your agent',
    why: 'Each agent gets its own key, so you can pause or remove one without touching the others.',
  },
  {
    id: 'rules',
    title: 'Choose the rules',
    why: 'Rules say how much an agent may pay at once and per day, and when it has to ask you first.',
  },
  {
    id: 'shadow',
    title: 'Try it safely',
    why: 'In test mode the agent works as usual but no money moves. You see what it would have paid.',
  },
  {
    id: 'live',
    title: 'Go live',
    why: 'From now on the agent pays for real, within your rules and the daily limit of the vault.',
  },
] as const

export type StepId = (typeof STEPS)[number]['id']

export const isStep = (id: string): id is StepId => STEPS.some((step) => step.id === id)

/**
 * Which steps are done, from guard-core's progress. Phantom leaves no trace on the server: it counts
 * as done once the vault it signed for is there.
 */
export function doneSteps(progress: { id: string; done: boolean }[]): Set<StepId> {
  const done = new Set(progress.filter((step) => step.done && isStep(step.id)).map((s) => s.id))
  if (done.has('vault')) {
    done.add('phantom')
  }
  return done as Set<StepId>
}

/** The first step not done yet, or undefined once all nine are. */
export function nextStep(done: Set<StepId>): StepId | undefined {
  return STEPS.find((step) => !done.has(step.id))?.id
}

export const isSolana = (chain: string) => chain.startsWith('solana:')

/**
 * A link to the signing page guard-core serves at /sign on this same origin, for the owner's wallet.
 * It never names the hot wallet: the page knows its own (SPEC, "Signing page").
 */
export function signLink(
  origin: string,
  chain: string,
  params: Record<string, string>,
): string | undefined {
  return signPageUrl(`${origin}/sign`, chain, params)
}

export { inPhantom }

/** Whole days of the daily cap the balance covers; undefined without a cap. */
export function daysCovered(balance: string, cap: string | undefined): bigint | undefined {
  if (cap === undefined || BigInt(cap) === 0n) {
    return undefined
  }
  return BigInt(balance) / BigInt(cap)
}

/** A CAIP-2 id, the only shape safe to put on a command line unquoted. */
const CHAIN_ID = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/

/**
 * One line for Claude Code. It asks for the token at a hidden prompt, never on the command line.
 * --chain names a chain this deployment runs, the first with a vault: without it the MCP server
 * defaults to Solana devnet, which a mainnet guard-core refuses.
 */
export function mcpCommand(
  origin: string,
  agentId: string,
  chains: { chain: string; vault?: string | undefined }[],
): string {
  const chain = (chains.find((c) => c.vault !== undefined) ?? chains[0])?.chain
  const flag = chain !== undefined && CHAIN_ID.test(chain) ? ` --chain ${chain}` : ''
  return `pnpm --filter @defimind/mcp-server run setup claude-code --guard-url ${origin} --agent-id ${agentId}${flag} --check`
}
