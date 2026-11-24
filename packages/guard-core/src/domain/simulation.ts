import type { PayIntent, RejectCode, SimulationResult } from '@defimind/shared'
import { parseAmount } from './amount.js'

const SIGNED = /^-?(0|[1-9]\d*)$/

/**
 * The adapters run the chain-specific checks. This one holds on every chain: the wallet must not
 * lose more of the token than the intent pays, and a swap must bring in at least its minimum (CR-021).
 * A figure we cannot read fails the simulation.
 */
export function checkSimulation(simulation: SimulationResult, intent: PayIntent): RejectCode[] {
  if (simulation.balanceChanges.some((change) => !SIGNED.test(change.delta))) {
    return ['SIM_FAILED']
  }
  const spent = net(simulation, intent.token) < -parseAmount(intent.amount)
  const short =
    intent.swap !== undefined &&
    net(simulation, intent.swap.tokenOut) < parseAmount(intent.swap.minAmountOut)
  return spent || short ? ['SIM_UNEXPECTED_EFFECT'] : []
}

/** The wallet's net change in `token`, as the simulation reports it; deltas already checked. */
export function net(simulation: SimulationResult, token: string): bigint {
  return simulation.balanceChanges
    .filter((change) => change.token === token)
    .reduce((sum, change) => sum + BigInt(change.delta), 0n)
}
