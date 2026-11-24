import { USDC_DECIMALS } from '@defimind/shared'
import {
  formatUnits,
  getAddress,
  isAddressEqual,
  parseAbi,
  slice,
  type Address,
  type PublicClient,
} from 'viem'
import { readAllowance, RESET_TIME_MIN, type AllowanceState } from '../../../src/evm/safe.js'
import { notVerified, window, type Proof } from '../proof.js'
import { SAFE_L2, safeAbi } from './calls.js'

export interface EvmProofRequest {
  cluster: string
  safe: Address
  /**
   * The deployment's hot wallets, shared and per agent (CR-022), fixed when the page was built, as
   * are the module and the token: never taken from the link.
   */
  hots: Address[]
  module: Address
  usd: Address
  symbol: string
}

const SENTINEL = '0x0000000000000000000000000000000000000001'
const readAbi = parseAbi([
  'function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)',
  'function getDelegates(address safe, uint48 start, uint8 pageSize) view returns (address[] results, uint48 next)',
  'function getTokens(address safe, address delegate) view returns (address[])',
  'function balanceOf(address owner) view returns (uint256)',
])

/**
 * How much the hot wallets can draw from a Safe, read from the chain. The Safe must be the canonical
 * SafeL2 behind its proxy, with one owner who is no hot wallet. Every enabled module and every
 * delegate counts: another module can move funds on its own terms, and a delegate outside the
 * deployment, or an allowance in another token, is a draw this page cannot bound.
 */
export async function proveEvm(client: PublicClient, request: EvmProofRequest): Promise<Proof> {
  const { cluster, safe, hots, module, usd, symbol } = request
  if (!(await client.getCode({ address: safe }))) {
    return notVerified([`There is no Safe at ${safe} on ${cluster}.`])
  }
  const read = { address: safe, abi: safeAbi } as const
  const [singleton, owners, threshold, [modules], [delegates], balance] = await Promise.all([
    client.getStorageAt({ address: safe, slot: '0x0' }),
    client.readContract({ ...read, functionName: 'getOwners' }),
    client.readContract({ ...read, functionName: 'getThreshold' }),
    client.readContract({
      address: safe,
      abi: readAbi,
      functionName: 'getModulesPaginated',
      args: [SENTINEL, 20n],
    }),
    client.readContract({
      address: module,
      abi: readAbi,
      functionName: 'getDelegates',
      args: [safe, 0, 50],
    }),
    client.readContract({ address: usd, abi: readAbi, functionName: 'balanceOf', args: [safe] }),
  ])
  const amount = (value: bigint) => `${formatUnits(value, USDC_DECIMALS)} ${symbol}`
  const facts = [
    `Safe ${safe} on ${cluster}. Owners: ${owners.join(', ')}, threshold ${threshold}.`,
    `It holds ${amount(balance)}.`,
  ]
  const moduleOn = modules.some((m) => isAddressEqual(m, module))
  const drawing = moduleOn
    ? hots.filter((hot) => delegates.some((d) => isAddressEqual(d, hot)))
    : []
  const [tokens, states] = await Promise.all([
    moduleOn ? tokensOf(client, module, safe, delegates) : [],
    Promise.all(drawing.map((hot) => readAllowance(client, module, safe, hot, usd))),
  ])
  const live = states.flatMap((state, i) =>
    state.amount > 0n ? [{ hot: drawing[i]!, state }] : [],
  )
  const problems = [
    ...safeProblems(singleton, owners, threshold, hots),
    ...rightProblems(request, modules, delegates, tokens),
    ...live
      .filter(({ state }) => state.resetTimeMin !== BigInt(RESET_TIME_MIN))
      .map(
        ({ hot, state }) =>
          `The allowance${hots.length === 1 ? '' : ` of ${hot}`} resets every ` +
          `${state.resetTimeMin} minutes, not daily.`,
      ),
  ]
  const one = hots.length === 1
  if (problems.length > 0) {
    return notVerified([
      `This Safe is not only its owner's, with ${one ? `the hot wallet ${hots[0]}` : `its hot wallets ${hots.join(', ')} each`} ` +
        `drawing ${symbol} through the Allowance Module under a daily cap, so this page cannot ` +
        'say how much can be drawn.',
      ...problems,
      ...facts,
    ])
  }
  if (live.length === 0) {
    return {
      verified: true,
      title: `The most this agent can draw in the next 24 hours: 0 ${symbol}`,
      lines: [
        `No allowance: ${one ? 'the hot wallet cannot' : 'no hot wallet can'} draw from the Safe. This is ` +
          'how a Safe looks after a kill, or before the allowance is set.',
        ...facts,
      ],
    }
  }
  return window({
    draws: live.map(({ hot, state }) => ({ wallet: hot, ...today(state), cap: state.amount })),
    balance,
    format: amount,
    facts,
    verifiedBy:
      live.length === 1
        ? `Verified from the chain: the Allowance Module ${module} lets only the hot wallet ` +
          `${live[0]!.hot} draw, and only ${symbol}.`
        : `Verified from the chain: the Allowance Module ${module} lets only this deployment's ` +
          `${live.length} hot wallets draw, each under its own cap, and only ${symbol}.`,
  })
}

/** The proxy must run the canonical SafeL2, with one owner, who is no hot wallet. */
function safeProblems(
  singleton: `0x${string}` | undefined,
  owners: readonly Address[],
  threshold: bigint,
  hots: Address[],
): string[] {
  const problems = []
  const runs = singleton ? getAddress(slice(singleton, 12)) : undefined
  if (!runs || !isAddressEqual(runs, SAFE_L2)) {
    problems.push(`The Safe runs ${runs ?? 'unknown code'}, not SafeL2 1.4.1 (${SAFE_L2}).`)
  }
  if (owners.length !== 1 || threshold !== 1n) {
    problems.push(`It has ${owners.length} owners at threshold ${threshold}, not one owner.`)
  }
  if (owners.some((owner) => hots.some((hot) => isAddressEqual(owner, hot)))) {
    const which = hots.length === 1 ? 'The hot wallet' : 'A hot wallet'
    problems.push(`${which} is an owner: it can change the allowance itself.`)
  }
  return problems
}

function rightProblems(
  { hots, module, usd, symbol }: EvmProofRequest,
  modules: readonly Address[],
  delegates: readonly Address[],
  tokens: readonly (readonly Address[])[],
): string[] {
  const problems = modules
    .filter((m) => !isAddressEqual(m, module))
    .map((m) => `Module ${m} is enabled: it can move the Safe's funds on its own terms.`)
  delegates.forEach((delegate, i) => {
    if (!hots.some((hot) => isAddressEqual(delegate, hot))) {
      problems.push(`Delegate ${delegate} of the Allowance Module can draw too.`)
    }
    const others = (tokens[i] ?? []).filter((token) => !isAddressEqual(token, usd))
    if (others.length > 0) {
      problems.push(`Delegate ${delegate} has allowances in ${others.join(', ')}, not ${symbol}.`)
    }
  })
  return problems
}

const tokensOf = (
  client: PublicClient,
  module: Address,
  safe: Address,
  delegates: readonly Address[],
) =>
  Promise.all(
    delegates.map((delegate) =>
      client.readContract({
        address: module,
        abi: readAbi,
        functionName: 'getTokens',
        args: [safe, delegate],
      }),
    ),
  )

/** The module applies the daily reset when read, so spent is already this period's. */
function today(state: AllowanceState) {
  const left = state.amount > state.spent ? state.amount - state.spent : 0n
  const resetsAt = new Date(Number(state.lastResetMin + state.resetTimeMin) * 60_000)
  return { left, resetsAt }
}
