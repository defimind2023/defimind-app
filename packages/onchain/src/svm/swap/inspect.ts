import type { RejectCode } from '@defimind/shared'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TokenInstruction,
} from '@solana/spl-token'
import {
  ComputeBudgetInstruction,
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
  type TransactionMessage,
  type VersionedMessage,
} from '@solana/web3.js'

/** Jupiter's aggregator, v6: the only venue (CR-021). */
export const JUPITER_PROGRAM_ID = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4')

export interface SwapSides {
  hotWallet: PublicKey
  tokenIn: PublicKey
  tokenOut: PublicKey
  amountIn: bigint
  /** What the owner or the policy approved: the route itself must refuse to deliver less. */
  minAmountOut: bigint
}

// Jupiter v6's exact-in routes (Anchor: sha256("global:<name>")[..8]). The token-ledger and exact-out
// variants spend an amount the instruction does not state, so they are not ours to sign.
const EXACT_IN_ROUTES = [
  Buffer.from([229, 23, 203, 151, 122, 227, 173, 42]), // route
  Buffer.from([193, 32, 155, 51, 65, 214, 156, 129]), // shared_accounts_route
]
// Both end with in_amount u64, quoted_out_amount u64, slippage_bps u16, platform_fee_bps u8.
const TERMS_BYTES = 19

// A route needs far more compute than a transfer. The priority fee is bounded in lamports rather
// than per unit, so a high limit cannot multiply it: at the cap it costs 0.001 SOL.
const MAX_COMPUTE_UNIT_LIMIT = 1_400_000
export const MAX_PRIORITY_LAMPORTS = 1_000_000n
const CREATE_IDEMPOTENT = 1

/**
 * The swap transaction, with its lookup tables written out, read against every inspectTransfer
 * rule. Jupiter is untrusted, so what it routes through is left to the test run; this only refuses
 * what no swap of ours needs: another signer, a standing authority over the hot wallet's tokens, a
 * program outside the list, or a priority fee past the cap. Wrapped SOL stays wrapped, so no System
 * instruction belongs here either.
 */
export function inspectSwap(
  signed: VersionedMessage,
  expanded: TransactionMessage,
  sides: SwapSides,
): RejectCode[] {
  const reasons = new Set<RejectCode>()
  if (!expanded.payerKey.equals(sides.hotWallet) || signed.header.numRequiredSignatures !== 1) {
    reasons.add('SIM_UNEXPECTED_EFFECT')
  }
  let routes = 0
  let units = 200_000n
  let microLamports = 0n
  for (const ix of expanded.instructions) {
    const program = ix.programId
    if (program.equals(JUPITER_PROGRAM_ID)) {
      routes++
      const reason = routeReason(ix, sides)
      if (reason) reasons.add(reason)
    } else if (program.equals(TOKEN_PROGRAM_ID) || program.equals(TOKEN_2022_PROGRAM_ID)) {
      reasons.add(tokenReason(ix))
    } else if (program.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      if (!createsOwnAccount(ix, sides)) reasons.add('SIM_UNEXPECTED_EFFECT')
    } else if (program.equals(ComputeBudgetProgram.programId)) {
      const budget = computeBudget(ix)
      if (budget === undefined) reasons.add('SIM_UNEXPECTED_EFFECT')
      else if (budget.units !== undefined) units = budget.units
      else microLamports = budget.microLamports
    } else if (program.equals(SystemProgram.programId)) {
      reasons.add('SIM_UNEXPECTED_EFFECT')
    } else {
      reasons.add('UNKNOWN_PROGRAM_DETECTED')
    }
  }
  // One route: a second could be a second trade the quote never showed.
  if (routes !== 1) reasons.add('SIM_UNEXPECTED_EFFECT')
  if (
    units > BigInt(MAX_COMPUTE_UNIT_LIMIT) ||
    (units * microLamports) / 1_000_000n > MAX_PRIORITY_LAMPORTS
  ) {
    reasons.add('SIM_UNEXPECTED_EFFECT')
  }
  return [...reasons]
}

/**
 * The route's own terms, held to the swap: the test run proves the output only at simulation time,
 * so a route whose slippage lets it deliver less than the approved minimum would hand the
 * difference to whoever moves the price before it lands.
 */
function routeReason(ix: TransactionInstruction, sides: SwapSides): RejectCode | undefined {
  const data = ix.data
  const exactIn = EXACT_IN_ROUTES.some((d) => data.subarray(0, 8).equals(d))
  if (!exactIn || data.length < 8 + 4 + TERMS_BYTES) return 'SIM_UNEXPECTED_EFFECT'
  const terms = data.subarray(data.length - TERMS_BYTES)
  const inAmount = terms.readBigUInt64LE(0)
  const quotedOut = terms.readBigUInt64LE(8)
  const slippageBps = BigInt(terms.readUInt16LE(16))
  const feeBps = terms.readUInt8(18)
  if (inAmount !== sides.amountIn || feeBps !== 0 || slippageBps > 10_000n) {
    return 'SIM_UNEXPECTED_EFFECT'
  }
  // Rounded up, as Jupiter rounds the threshold it quotes: the two agree to the atomic unit.
  const enforced = (quotedOut * (10_000n - slippageBps) + 9_999n) / 10_000n
  if (enforced < sides.minAmountOut) return 'SLIPPAGE_TOO_HIGH'
  return undefined
}

/** No token instruction belongs at the top level of a swap: the route moves tokens itself. */
function tokenReason(ix: TransactionInstruction): RejectCode {
  switch (ix.data[0]) {
    case TokenInstruction.Approve:
    case TokenInstruction.ApproveChecked:
      return 'DELEGATE_DETECTED'
    case TokenInstruction.SetAuthority:
      return 'AUTHORITY_CHANGE_DETECTED'
    case TokenInstruction.CloseAccount:
      return 'ACCOUNT_CLOSE_DETECTED'
    default:
      return 'SIM_UNEXPECTED_EFFECT'
  }
}

/** The hot wallet creating its own account for one side of the swap, and paying for it. */
function createsOwnAccount(
  ix: TransactionInstruction,
  { hotWallet, tokenIn, tokenOut }: SwapSides,
) {
  const [payer, , owner, mint] = ix.keys.map((key) => key.pubkey)
  return (
    ix.data.length === 1 &&
    ix.data[0] === CREATE_IDEMPOTENT &&
    !!payer?.equals(hotWallet) &&
    !!owner?.equals(hotWallet) &&
    (!!mint?.equals(tokenIn) || !!mint?.equals(tokenOut))
  )
}

function computeBudget(ix: TransactionInstruction) {
  try {
    switch (ComputeBudgetInstruction.decodeInstructionType(ix)) {
      case 'SetComputeUnitLimit':
        return { units: BigInt(ComputeBudgetInstruction.decodeSetComputeUnitLimit(ix).units) }
      case 'SetComputeUnitPrice':
        return {
          microLamports: BigInt(
            ComputeBudgetInstruction.decodeSetComputeUnitPrice(ix).microLamports,
          ),
        }
      default:
        return undefined
    }
  } catch {
    return undefined
  }
}
