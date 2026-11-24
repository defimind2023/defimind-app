import { USDC_DECIMALS } from '@defimind/shared'
import { erc20Abi, formatUnits, isAddressEqual, type Address, type PublicClient } from 'viem'
import { depositData, safeAbi } from './calls.js'
import type { EvmPlan } from './plan.js'

export interface EvmDepositRequest {
  cluster: string
  safe: Address
  /** The chain's stablecoin, from the page's config; never taken from the link. */
  usd: Address
  symbol: string
}

/**
 * A plain token transfer from the connected account into the Safe. Only an owner may deposit, for
 * the same reason as on Solana; the transfer grants nothing, no approval and no delegate. `amount`
 * is asked only once the account is known to be an owner.
 */
export async function prepareEvmDeposit(
  client: PublicClient,
  request: EvmDepositRequest,
  owner: Address,
  amount: () => Promise<bigint>,
): Promise<EvmPlan> {
  const { cluster, safe, usd, symbol } = request
  if (!(await client.getCode({ address: safe }))) {
    return { kind: 'refused', reason: `There is no Safe at ${safe} on ${cluster}.` }
  }
  const owners = await client.readContract({
    address: safe,
    abi: safeAbi,
    functionName: 'getOwners',
  })
  if (!owners.some((o) => isAddressEqual(o, owner))) {
    return {
      kind: 'refused',
      reason:
        `The connected account ${owner} is not an owner of Safe ${safe} (owners ` +
        `${owners.join(', ')}). Connect the owner account and open the link again.`,
    }
  }
  const balanceOf = (who: Address) =>
    client.readContract({ address: usd, abi: erc20Abi, functionName: 'balanceOf', args: [who] })
  const text = (value: bigint) => `${formatUnits(value, USDC_DECIMALS)} ${symbol}`
  const [held, before] = await Promise.all([balanceOf(owner), balanceOf(safe)])
  const value = await amount()
  if (held < value) {
    return {
      kind: 'refused',
      reason: `Your account holds ${text(held)}, less than ${text(value)}.`,
    }
  }
  return {
    kind: 'sign',
    title: 'Deposit into the Safe',
    to: usd,
    data: depositData(safe, value),
    after: 'Deposited',
    summary: [
      `Deposit: ${text(value)} into Safe ${safe}, on ${cluster}.`,
      `Token ${usd}, function transfer. A plain transfer: it gives no one any right over your ` +
        'account.',
      `Phantom should show ${text(value)} leaving your account, and only the network fee besides. ` +
        'Reject anything else.',
    ],
    landed: async () => {
      const after = await balanceOf(safe)
      return after >= before + value ? [`Safe ${safe} now holds ${text(after)}.`] : undefined
    },
  }
}
