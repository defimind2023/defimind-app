import type {
  Address,
  AllowanceState,
  Amount,
  BalanceChange,
  ChainId,
  HotWalletGas,
  PayIntent,
  RejectCode,
  SimulationResult,
  SwapQuote,
  TokenRisk,
  TxId,
} from '@defimind/shared'
import type { PaymentRequirements, SchemeNetworkClient } from '@x402/core/types'

/** Who can move the vault's funds: how many signatures it takes, out of how many keys (CR-022). */
export interface Control {
  threshold: number
  signers: number
}

/** CR-025: what the chain says about a token, before anyone allows it. Facts, never a verdict. */
export type TokenRiskFacts = Omit<TokenRisk, 'venue' | 'flags'>

export interface Vault {
  address: Address
  token: Address
  balance: Amount
  control?: Control
}

/** The transaction only the owner can sign: it zeroes the spend limit and removes the delegate. */
export interface KillTx {
  /** Shown to the owner on Telegram before they sign. */
  description: string
  /** Chain-specific: a Safe transaction on EVM, a Squads proposal on Solana. */
  payload: unknown
}

export interface SimulationOutcome {
  simulation: SimulationResult
  /** Chain-specific detections. Empty means the simulation found nothing to object to. */
  rejectReasons: RejectCode[]
}

/**
 * Everything guard-core needs from a chain. guard-core imports this and never a chain SDK, which is
 * what keeps the policy engine and the HTTP API chain-agnostic.
 */
export interface ChainAdapter {
  readonly chain: ChainId

  getAllowanceState(): Promise<AllowanceState>
  getHotWalletBalance(token: Address): Promise<Amount>
  /** The chain's native coin in the hot wallet, and what a few draws and payments need. */
  getHotWalletGas(): Promise<HotWalletGas>
  /**
   * The owner's vault, where deposits go: the Squads vault at index 0, or the Safe itself, with its
   * stablecoin balance.
   */
  getVault(): Promise<Vault>

  /** Pulls from the owner's multisig into the hot wallet, under the onchain cap. */
  topUpHotWallet(amount: Amount): Promise<TxId>

  simulate(intent: PayIntent): Promise<SimulationOutcome>
  send(intent: PayIntent): Promise<TxId>

  /**
   * CR-021: a checked quote from an untrusted venue. simulate() and send() take kind "swap" too;
   * send() signs only the transaction whose test run matched the intent. An adapter without these
   * trades nothing.
   */
  quoteSwap?(req: {
    tokenIn: Address
    tokenOut: Address
    amountIn: Amount
    slippageBps: number
  }): Promise<SwapQuote>
  /** CR-021: every token the hot wallet holds but the chain's dollar, decimals read from the mint. */
  getPositions?(): Promise<{ token: Address; amount: Amount; decimals: number }[]>
  /**
   * What a confirmed transaction really moved for the hot wallet, per token: signed atomic deltas,
   * none zero. A swap lands at its own price, never exactly the test run's.
   */
  getLandedChanges?(txId: TxId): Promise<BalanceChange[]>
  /** CR-025: a token's mint and exit, read for the owner's risk card. Facts only, never a verdict. */
  tokenRisk?(mint: Address): Promise<TokenRiskFacts>

  buildKillTx(): Promise<KillTx>

  /**
   * A scheme client for @x402/core that signs this intent and nothing else. Whatever the SDK puts in
   * front of it is checked first, and anything other than that one payment throws SigningRefused
   * instead of producing a signature.
   */
  x402Scheme(intent: PayIntent, requirements: PaymentRequirements): SchemeNetworkClient
}

export class SigningRefused extends Error {
  constructor(readonly reasons: RejectCode[]) {
    super(`signing_refused: ${reasons.join(',')}`)
  }
}
