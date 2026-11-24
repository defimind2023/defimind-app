/**
 * Shared types, transcribed from /SPEC.md.
 * Every other package imports from here; changes are proposed as SPEC changes.
 */

/** Atomic units (USDC = 6 decimals) as a decimal string. Parse to bigint before any math. */
export type Amount = string

/**
 * CAIP-2 chain identifier, e.g. "eip155:8453". Chains are never numbers: Solana has no numeric id.
 */
export type ChainId = string

/**
 * An address, mint or program id. Base58 on Solana, hex on EVM. Nothing outside a chain adapter
 * may assume which.
 */
export type Address = string

/** Base58 signature on Solana, hex hash on EVM. */
export type TxId = string

export interface Policy {
  agentId: string
  chains: ChainId[]
  tokens: Address[]
  perTxMax: Amount
  dailyMax: Amount
  /** At or above this amount, the owner must approve with a passkey in the panel. */
  approvalThreshold: Amount
  /** Empty denies all direct transfers. */
  allowedRecipients: Address[]
  /** x402 hosts, e.g. ["api.example.com"]. Empty denies all. */
  allowedDomains: string[]
  paused: boolean
  /** CR-010. Shadow evaluates and simulates every payment and signs none. Default 'live'. */
  mode?: 'live' | 'shadow'
  /** CR-010. An x402 price above the pinned one by more than this goes to the owner. Default 100. */
  priceIncreaseMaxPct?: number
  /** CR-010. The payment that would exceed it trips the breaker and pauses the agent. Default 10. */
  maxPaymentsPerMinute?: number
  /** CR-010. When true, a payment without an open mandate is refused. Default false. */
  requireMandate?: boolean
  /** CR-021. Absent means no trading at all. */
  trading?: TradingPolicy
}

/** CR-021. Every loosening needs the passkey step-up. Limits are in the chain's dollar. */
export interface TradingPolicy {
  enabled: boolean
  /** e.g. ["jupiter"]. Empty allows none. */
  venues: string[]
  /** Tradable mints or token addresses. Empty allows none, unless allowAnyToken. */
  tokens: Address[]
  /** Any token that passes the risk checks. Default false. */
  allowAnyToken: boolean
  maxTradeUsd: Amount
  /** Buys only; sells are not counted. */
  dailyTradeMax: Amount
  /** The most held in one token, at cost. */
  maxPositionUsd: Amount
  /** Default 100. */
  maxSlippageBps: number
  /** Default 300. */
  maxPriceImpactBps: number
}

/** CR-010: a budget for one task, inside the policy. */
export interface Mandate {
  id: string
  agentId: string
  budget: Amount
  spent: Amount
  /** x402 domains it may pay, a subset of the policy's. */
  domains: string[]
  /** Transfer recipients it may pay, a subset of the policy's. */
  recipients: Address[]
  /** Agent-provided, shown to the owner, never used in a decision. */
  reason: string
  status: 'pending_approval' | 'active' | 'exhausted' | 'expired' | 'revoked'
  createdAt: string
  expiresAt: string
}

/** CR-010: why a payment goes to the owner even below the threshold. */
export type ApprovalFlag = 'RECIPIENT_CHANGED' | 'PRICE_JUMP' | TradingFlag

/** CR-010: one per executed intent, signed by RECEIPT_SIGNING_KEY. */
export interface Receipt {
  intent: PayIntent
  /** Hex SHA-256 of the canonical JSON of the policy in force. */
  policyHash: string
  /** The simulation summary. */
  simulation: string
  approvedBy: 'policy' | 'owner' | 'passkey'
  issuedAt: string
  /** Hex Ed25519 signature over the canonical JSON of the fields above. */
  signature: string
}

/** CR-013: one per tool call or payment, in one hash chain per deployment. */
export interface ExecutionReceipt {
  type: 'defimind.execution.v1'
  /** 1, 2, 3… with no gap. */
  seq: number
  /** The previous receipt's hash; 64 zeros for seq 1. */
  prevHash: string
  agentId: string
  kind: 'tool_call' | 'payment'
  /** The downstream MCP server, or "defimind" for payments. */
  server: string
  tool: string
  /** Hex SHA-256 of the canonical JSON of the arguments; the arguments are never stored. */
  requestHash: string
  responseHash: string
  outcome: 'ok' | 'error' | 'refused'
  /** executed: guard-core ran it. relayed: a gateway reported it, so only its record is vouched for. */
  assurance: 'executed' | 'relayed'
  /** Hex SHA-256 of the canonical JSON of the CR-010 Receipt; kind "payment" only. */
  paymentReceipt?: string
  startedAt: string
  endedAt: string
  issuedAt: string
  /** Hex SHA-256 of the canonical JSON of the fields above. */
  hash: string
  /** Hex Ed25519 over the same bytes, with the receipt key. */
  signature: string
}

/** CR-013: a Merkle root over receipts fromSeq..toSeq, published in one transaction. */
export interface Anchor {
  fromSeq: number
  toSeq: number
  root: string
  /** CAIP-2. */
  chain: string
  txId: string
  anchoredAt: string
}

/** CR-013: everything a third party needs to verify one receipt offline. */
export interface ProofBundle {
  receipt: ExecutionReceipt
  /** From the leaf up to the root. */
  siblings: { side: 'left' | 'right'; hash: string }[]
  anchor: Anchor
}

/** Body of POST {BOT_URL}/hooks/alert (CR-010). */
export type AlertEvent =
  | { kind: 'breaker_tripped'; agentId: string; detail: string; sentAt: string }
  | { kind: 'passkey_enrolled'; detail: string; sentAt: string }
  /** CR-022: someone with the admin token tried to widen a policy. */
  | { kind: 'admin_loosen_refused'; detail: string; sentAt: string }
  /** CR-013: the execution receipt chain failed its integrity check. */
  | { kind: 'chain_broken'; detail: string; sentAt: string }
  /** CR-024: the daily backup or its upload failed; plain English, never a URL or a key. */
  | { kind: 'backup_failed'; detail: string; sentAt: string }

export type IntentStatus =
  | 'approved'
  | 'pending_approval'
  | 'rejected'
  | 'executed'
  | 'failed'
  | 'expired'
  /** CR-010: would have been sent; shadow mode signs nothing. */
  | 'shadowed'

export type PayIntentKind = 'x402' | 'transfer' | 'swap'

export interface PayIntent {
  id: string
  agentId: string
  kind: PayIntentKind
  chain: ChainId
  token: Address
  amount: Amount
  recipient: Address
  /** x402 only: the host of the requested URL. */
  domain?: string
  /** Agent-provided, shown to the owner, never used in a decision. */
  reason: string
  status: IntentStatus
  rejectReasons: RejectCode[]
  txId?: TxId
  /** CR-010: the mandate this payment counts against. */
  mandateId?: string
  /**
   * CR-021, kind "swap" only. token and amount are what is spent; recipient is the hot wallet
   * itself, because a swap sends nothing anywhere else.
   */
  swap?: SwapDetails
  createdAt: string
  expiresAt: string
}

export interface SwapDetails {
  venue: string
  tokenOut: Address
  minAmountOut: Amount
  slippageBps: number
  priceImpactBps: number
  /** Read from each mint onchain by the adapter, never from a venue. */
  decimalsIn: number
  decimalsOut: number
  /** Display only and untrusted: always shown beside the mint. */
  symbolIn?: string
  symbolOut?: string
  quotedAt: string
}

/** CR-021. A venue's quote, untrusted: guard-core and the adapter check every field again. */
export interface SwapQuote {
  venue: string
  tokenIn: Address
  amountIn: Amount
  tokenOut: Address
  expectedOut: Amount
  minAmountOut: Amount
  slippageBps: number
  priceImpactBps: number
  /** Read from each mint onchain by the adapter, never from the venue. */
  decimalsIn: number
  decimalsOut: number
  /** Display only and untrusted: always shown beside the mint. */
  symbolIn?: string
  symbolOut?: string
  /** A sell quote for the amount bought; null when there is no exit route. */
  exitImpactBps: number | null
  risks: RejectCode[]
  flags: TradingFlag[]
  quotedAt: string
}

/** CR-021: these send a buy to the owner even below the threshold. */
export type TradingFlag = 'NEW_TOKEN' | 'MINT_AUTHORITY'

/** CR-025: what the venue says about a token. Untrusted, display only, labelled as the venue's. */
export interface VenueTokenFacts {
  holders?: number
  /** As the venue reports it, a decimal string for display; never used in a decision. */
  liquidityUsd?: string
  organicScore?: number
  createdAt?: string
}

/** CR-025: a token search result. The symbol and name are claims; decimals are re-read onchain. */
export interface TokenInfo {
  chain: ChainId
  mint: Address
  symbol: string
  name: string
  decimals: number
  verified: boolean
  venue: VenueTokenFacts
}

/** CR-025: what a buy of this token would meet, read onchain; venue holds the venue's own facts. */
export interface TokenRisk {
  chain: ChainId
  mint: Address
  decimals: number
  freezeAuthority: boolean
  mintAuthority: boolean
  extensions: string[]
  risks: RejectCode[]
  flags: TradingFlag[]
  /** Selling 10 USD worth back to the dollar; null without a route. */
  exit: { amountUsd: Amount; priceImpactBps: number } | null
  venue: VenueTokenFacts & { verified: boolean }
}

export interface Position {
  chain: ChainId
  token: Address
  amount: Amount
  /** At cost, in the chain's dollar. */
  cost: Amount
  /** Read from the mint onchain by the adapter, never from a venue's token list. */
  decimals: number
  /** Display only and untrusted: always shown beside the mint. */
  symbol?: string
}

/** Applies on every chain. */
export type SharedRejectCode =
  | 'PAUSED'
  | 'CHAIN_NOT_ALLOWED'
  | 'TOKEN_NOT_ALLOWED'
  | 'RECIPIENT_NOT_ALLOWED'
  | 'DOMAIN_NOT_ALLOWED'
  | 'PER_TX_EXCEEDED'
  | 'DAILY_EXCEEDED'
  | 'SIM_FAILED'
  | 'SIM_UNEXPECTED_EFFECT'
  | 'OWNER_REJECTED'
  | 'APPROVAL_TIMEOUT'
  | 'INVALID_402'
  | 'MANDATE_REQUIRED'
  | 'MANDATE_EXCEEDED'
  | 'MANDATE_EXPIRED'
  | 'BREAKER_TRIPPED'
  | TradingRejectCode

/** CR-021. Swaps on every chain that supports them. */
export type TradingRejectCode =
  | 'TRADING_DISABLED'
  | 'VENUE_NOT_ALLOWED'
  | 'TOKEN_NOT_TRADABLE'
  | 'TRADE_EXCEEDED'
  | 'TRADE_DAILY_EXCEEDED'
  | 'POSITION_EXCEEDED'
  | 'SLIPPAGE_TOO_HIGH'
  | 'PRICE_IMPACT_TOO_HIGH'
  | 'NO_EXIT_ROUTE'
  | 'QUOTE_STALE'

/** Standing authority an EVM payment must never grant. */
export type EvmRejectCode = 'APPROVAL_DETECTED' | 'PERMIT_DETECTED' | 'DELEGATION_DETECTED'

/** The Solana equivalents are different mechanisms, not renames of the EVM ones. */
export type SvmRejectCode =
  | 'DELEGATE_DETECTED'
  | 'AUTHORITY_CHANGE_DETECTED'
  | 'ACCOUNT_CLOSE_DETECTED'
  | 'UNKNOWN_PROGRAM_DETECTED'
  | 'HIDDEN_ACCOUNTS_DETECTED'
  /** CR-021: the mint keeps a freeze authority, so bought tokens could be locked. */
  | 'TOKEN_FREEZABLE'
  /** CR-021: Token-2022 transfer fee, transfer hook, permanent delegate or non-transferable. */
  | 'TOKEN_EXTENSION_RISK'

export type RejectCode = SharedRejectCode | EvmRejectCode | SvmRejectCode

export type PolicyDecision = 'approve' | 'needs_approval' | 'reject'

export interface BalanceChange {
  token: Address
  /** Signed atomic-unit delta as a decimal string. */
  delta: Amount
}

export interface SimulationResult {
  summary: string
  balanceChanges: BalanceChange[]
}

/**
 * CR-008. `none` means the chain shows no limit for the hot wallet, as a kill leaves it. A read that
 * fails throws instead, so a kill is never mistaken for an outage, nor an outage for a kill.
 */
export type AllowanceState =
  | { status: 'active'; cap: Amount; spent: Amount; resetsAt: string; delegate: Address }
  | { status: 'none'; delegate: Address }

/** Body of POST {BOT_URL}/hooks/approval-request for a payment. */
export interface ApprovalRequest {
  intent: PayIntent
  simulation: SimulationResult
  approveBefore: string
  /** CR-010: why it reached the owner below the threshold. Absent from a v0.5 guard-core. */
  flags?: ApprovalFlag[]
  /** CR-010: the domain's last executed payment, present whenever a flag is. */
  pinned?: { recipient: Address; amount: Amount }
  /** CR-010: true when only a passkey may approve it; the bot then offers no Approve button. */
  passkey?: boolean
}

/** CR-010: the same hook, asking the owner to open a task budget rather than to pay. */
export interface MandateApprovalRequest {
  /** While pending, its expiresAt is the approval deadline, not the budget's end. */
  mandate: Mandate
  /** How long the budget runs once approved, from the moment of approval. */
  ttlSeconds: number
  /** Its summary describes the budget; balanceChanges is empty. */
  simulation: SimulationResult
  approveBefore: string
}

export interface BudgetView {
  spentToday: Amount
  dailyMax: Amount
  perTxMax: Amount
  hotWalletBalances: Record<ChainId, Amount>
  paused: boolean
  /**
   * CR-006: chains guard-core runs an adapter for that this agent's policy allows. Optional only
   * until guard-core returns it; consumers must treat its absence as "not reported".
   */
  chains?: ChainId[]
  /** CR-010: what shadow mode would have spent today. Absent from a v0.5 guard-core. */
  shadowSpentToday?: Amount
  /** CR-010: the agent's active mandates. Absent from a v0.5 guard-core. */
  mandates?: Mandate[]
  /** CR-011: shadow mode since its first shadowed payment, so the bot can offer to go live. */
  shadow?: { since: string; total: Amount; count: number }
}

/** One entry of GET /v1/admin/chains (CR-006). */
export interface ChainStatus {
  chain: ChainId
  /** Null when the adapter's allowance could not be read. */
  allowance: AllowanceState | null
}

/** Body of POST {BOT_URL}/hooks/intent-event, sent when an intent reaches a final status. */
export interface IntentEvent {
  intent: PayIntent
  /** When guard-core sent it. The bot refuses events older than 5 minutes. */
  sentAt: string
}

export interface OwnerTransaction {
  chain: ChainId
  description: string
  /** Null when the transaction could not be built: that chain's allowance is still live. */
  payload: unknown
  /** CR-014: the Phantom universal link to the signing page; owner kill only, with SIGN_PAGE_URL. */
  link?: string
  /** CR-014: the signing page itself, for Phantom's desktop extension. */
  pageLink?: string
  /** CR-022: set when the entry removes an agent's own wallet's limit; absent for the shared one. */
  wallet?: { agentId: string; address: string }
}

/** Response of POST /v1/admin/kill. */
export interface KillResponse {
  pausedAgents: number
  ownerTransactions: OwnerTransaction[]
}

/** Response of POST /v1/agent/x402/fetch. No intent exists when no payment was asked for. */
export interface X402FetchResponse {
  intentId?: string
  status?: IntentStatus
  response?: { status: number; headers: Record<string, string>; body: string }
  rejectReasons: RejectCode[]
}

/** One line of GET /v1/admin/doctor (CR-011). Plain English, never a secret. */
export interface DoctorCheck {
  id: string
  status: 'ok' | 'warn' | 'fail'
  message: string
  /** What the owner can do about it. */
  fix?: string
}

/** The hot wallet's native coin, which pays the gas of each draw (CR-011). */
export interface HotWalletGas {
  balance: Amount
  /** Enough for a few draws; below it the doctor warns. */
  minimum: Amount
  symbol: string
}

/** One entry of GET /v1/admin/agents (CR-011). */
export interface AgentSummary {
  agentId: string
  paused: boolean
  mode: 'live' | 'shadow'
  /** CR-022: the agent's own spending wallets; absent or empty means the shared one everywhere. */
  wallets?: { chain: ChainId; address: string; status: AgentWalletStatus }[]
}

/** CR-022. "active" only once guard-core has read the wallet's onchain limit or allowance. */
export type AgentWalletStatus = 'pending_limit' | 'active'

/** CR-022: an agent's own spending (hot) wallet on one chain. */
export interface AgentWallet {
  chain: ChainId
  address: string
  status: AgentWalletStatus
  /** The signing page's add-limit for this wallet. */
  addLimitPage: string
  gas: { balance: Amount; minimum: Amount; symbol: string }
}
