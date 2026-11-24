import type { IntentStatus, PayIntentKind, RejectCode, TradingFlag } from '@defimind/shared'

const REASONS: Record<RejectCode, string> = {
  PAUSED: 'the owner has paused all payments for this agent',
  CHAIN_NOT_ALLOWED: 'the policy does not allow payments on this chain',
  TOKEN_NOT_ALLOWED: 'the policy does not allow paying with this token',
  RECIPIENT_NOT_ALLOWED: 'the recipient is not on the allowed list',
  DOMAIN_NOT_ALLOWED: 'the policy does not allow paying this website',
  PER_TX_EXCEEDED: 'the amount is above the per-payment limit',
  DAILY_EXCEEDED: 'the payment would go over the daily spending limit',
  SIM_FAILED: 'the transaction failed when it was simulated',
  SIM_UNEXPECTED_EFFECT: 'simulating the transaction showed effects other than the payment',
  OWNER_REJECTED: 'the owner rejected it',
  APPROVAL_TIMEOUT: 'the owner did not answer within the approval window',
  INVALID_402: "the website's payment request was malformed or unsafe",
  MANDATE_REQUIRED: 'the owner requires every payment to belong to a task budget',
  MANDATE_EXCEEDED:
    'the payment does not fit the task budget: too little is left, or it does not cover this website or recipient',
  MANDATE_EXPIRED: 'the task budget has expired, or the owner closed it',
  BREAKER_TRIPPED:
    'more payments in one minute than the owner allows, so DefiMind paused this agent until the owner resumes it',
  APPROVAL_DETECTED: 'the transaction would grant a token approval',
  PERMIT_DETECTED: 'the payment asked for a token permit signature',
  DELEGATION_DETECTED: 'the transaction would delegate control of the wallet',
  DELEGATE_DETECTED: 'the transaction would set a delegate on a token account',
  AUTHORITY_CHANGE_DETECTED: 'the transaction would change an account authority',
  ACCOUNT_CLOSE_DETECTED: 'the transaction would close an account',
  UNKNOWN_PROGRAM_DETECTED: 'the transaction calls a program that is not on the allowlist',
  HIDDEN_ACCOUNTS_DETECTED: 'the transaction hides the accounts it touches behind lookup tables',
  TRADING_DISABLED: 'the owner has not turned trading on for this agent',
  VENUE_NOT_ALLOWED: 'the policy does not allow trading through this venue on this chain',
  TOKEN_NOT_TRADABLE: 'the policy does not allow trading this token',
  TRADE_EXCEEDED: 'the buy is above the per-trade limit',
  TRADE_DAILY_EXCEEDED: "the buy would go over the day's trading limit",
  POSITION_EXCEEDED: 'the buy would hold more of this token than the owner allows',
  SLIPPAGE_TOO_HIGH: 'the slippage asked for is above the limit',
  PRICE_IMPACT_TOO_HIGH: 'the trade would move the price more than the owner allows',
  NO_EXIT_ROUTE: 'no route exists to sell this token back, so it may not be sellable',
  QUOTE_STALE: 'the quote is too old to trade on',
  TOKEN_FREEZABLE: "the token's issuer can still freeze holders' tokens",
  TOKEN_EXTENSION_RISK: 'the token carries a transfer fee, transfer hook or permanent delegate',
}

/** Codes where the right next step is not the generic "do not retry". */
const ADVICE: Partial<Record<RejectCode, string>> = {
  MANDATE_REQUIRED:
    'Open a task budget for this task with start_task, then repeat the payment with its mandateId.',
  MANDATE_EXCEEDED:
    'Stop paying for this task and tell the user. Open another task budget only if the user agrees to spend more.',
  MANDATE_EXPIRED:
    'Stop paying for this task and tell the user. Open a new task budget only if the user still wants it done.',
  BREAKER_TRIPPED:
    'Stop making payments and tell the user: every payment is refused until the owner resumes the agent.',
  TRADING_DISABLED: 'Do not try to trade. Tell the user the owner has to turn trading on.',
  VENUE_NOT_ALLOWED: 'Trading is not available here for this agent. Tell the user.',
  TOKEN_NOT_TRADABLE: 'Do not try this token again. Tell the user the owner has to allow it.',
  TRADE_EXCEEDED: 'Tell the user. Do not split the trade into smaller ones to get under the limit.',
  TRADE_DAILY_EXCEEDED: 'Stop buying for today and tell the user.',
  POSITION_EXCEEDED: 'Do not buy more of this token. Tell the user.',
  SLIPPAGE_TOO_HIGH: "Leave maxSlippageBps out, or set it lower, to stay within the owner's limit.",
  PRICE_IMPACT_TOO_HIGH:
    "The trade is too large for the market's depth. Tell the user; do not split it to get under the limit.",
  NO_EXIT_ROUTE: 'Do not buy this token. Tell the user why it was refused.',
  TOKEN_FREEZABLE: 'Do not buy this token. Tell the user why it was refused.',
  TOKEN_EXTENSION_RISK: 'Do not buy this token. Tell the user why it was refused.',
  QUOTE_STALE:
    'The price moved on before the trade was checked. You may try the same swap once more.',
}

export function explainReject(code: string): string {
  return code in REASONS ? `${code}: ${REASONS[code as RejectCode]}` : `${code}: no description`
}

const NEXT_STEP: Record<IntentStatus, string> = {
  approved: 'The payment was approved and is being sent.',
  executed: 'The payment went through.',
  pending_approval:
    'The payment is waiting for the owner to approve it on Telegram. Tell the user it needs their ' +
    'approval, then call check_intent with this intent id every 15 to 30 seconds until it settles. ' +
    'Pending payments expire after 10 minutes. Do not repeat the request while it is pending.',
  rejected: 'The payment was rejected and no money moved. Do not retry the same payment.',
  failed: 'The payment was approved but sending it failed. No further action was taken.',
  expired: 'The owner did not approve the payment in time, so it expired. No money moved.',
  shadowed:
    'Shadow mode: nothing was paid and no money moved. This shows what the payment would have ' +
    'cost; the owner is trying the agent out before giving it money. Carry on as if the payment ' +
    'had been declined, and tell the user if the task needed it.',
}

/**
 * An x402 payment can only deliver its response to the agent's own request, so an approval is not
 * the end of it: the agent has to repeat the call to redeem it.
 */
const X402_NEXT_STEP: Partial<Record<IntentStatus, string>> = {
  pending_approval:
    'The payment is waiting for the owner to approve it on Telegram. Tell the user it needs their ' +
    'approval, then call check_intent with this intent id every 15 to 30 seconds. Do not repeat the ' +
    'request while it is pending. Once check_intent reports approved, call paid_fetch again with ' +
    'exactly the same url, method, headers and body to receive the response.',
  shadowed:
    'Shadow mode: nothing was paid and no money moved. The response below, if any, is the ' +
    "website's unpaid answer, not the paid content. The owner is trying the agent out before " +
    'giving it money; tell the user if the task needed the paid content.',
  approved:
    'The owner approved the payment. Call paid_fetch again with exactly the same url, method, ' +
    'headers and body to receive the response. The approval pays for that one request only and ' +
    'expires at the time check_intent shows if it is not used.',
}

/** A swap trades rather than pays: what it bought stays in the agent's wallet. */
const SWAP_NEXT_STEP: Partial<Record<IntentStatus, string>> = {
  approved: 'The owner approved the swap and it is being sent.',
  executed:
    "The swap went through. What it bought stays in the agent's wallet; get_portfolio shows it.",
  pending_approval:
    'The swap is waiting for the owner to approve it. Tell the user it needs their approval, then ' +
    'call check_intent with this intent id every 15 to 30 seconds until it settles. Pending swaps ' +
    'expire after 10 minutes. Do not repeat the swap while it is pending.',
  rejected: 'The swap was rejected and nothing was traded. Do not retry the same swap.',
  failed: 'The swap was approved but sending it failed. Nothing further was traded.',
  expired: 'The owner did not approve the swap in time, so it expired. Nothing was traded.',
  shadowed:
    'Shadow mode: nothing was traded and no money moved. This is a paper trade at a live quote; ' +
    'the owner is trying the agent out before letting it trade. Tell the user if the task needed it.',
}

const FLAGS: Record<TradingFlag, string> = {
  NEW_TOKEN: 'the first buy of this token',
  MINT_AUTHORITY: "the token's issuer can still create more of it",
}

/** Flags never refuse a buy: they send it to the owner, whatever its size. */
export function explainFlags(flags: readonly TradingFlag[]): string[] {
  return flags.length === 0
    ? []
    : [
        "A buy will wait for the owner's approval, because:",
        ...flags.map((flag) => `- ${flag}: ${FLAGS[flag]}`),
      ]
}

export function explainStatus(
  status: IntentStatus,
  rejectReasons: readonly string[],
  kind: PayIntentKind,
): string {
  const special = kind === 'x402' ? X402_NEXT_STEP : kind === 'swap' ? SWAP_NEXT_STEP : {}
  const lines = [special[status] ?? NEXT_STEP[status]]
  if (rejectReasons.length > 0) {
    lines.push('Reasons:', ...rejectReasons.map((code) => `- ${explainReject(code)}`))
    const advice = rejectReasons.flatMap((code) => ADVICE[code as RejectCode] ?? [])
    lines.push(...new Set(advice))
  }
  return lines.join('\n')
}

/** guard-core refuses a task budget outright, before any intent, when it leaves the policy. */
export function explainRefusedTask(rejectReasons: readonly string[]): string {
  return [
    "DefiMind refused this task budget: it does not fit the owner's policy. Nothing was opened.",
    'Reasons:',
    ...rejectReasons.map((code) => `- ${explainReject(code)}`),
    'Ask only for websites and recipients the policy allows, and for no more than is left of the ' +
      'daily limit; get_budget shows what is left. If the user needs more, tell them the owner has ' +
      'to change the policy. Do not open the same budget again.',
  ].join('\n')
}
