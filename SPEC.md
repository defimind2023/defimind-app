# DefiMind SPEC v0.19 (source of truth — do not change without owner approval)

## Goal
A security layer between AI agents and their wallets. The agent can only pay through DefiMind.
Every payment is checked against a policy, simulated, and either auto-approved, sent to the owner
on Telegram for approval, or rejected. Funds live in the owner's multisig; the agent only ever spends
from a small hot wallet that is refilled under an ONCHAIN daily cap.

## Money flow
Owner multisig (holds funds)
  └─ Spend-limit primitive: delegate = Guard hot wallet, token = USDC, amount = dailyCap, period = 24h
       └─ Guard hot wallet (small balance, key held ONLY by guard-core)
            └─ pays x402 APIs / transfers, after policy + simulation + (optional) human approval
            └─ swaps (CR-021), the same checks; what it buys stays in the hot wallet

Onchain guarantees: max loss per day = dailyCap + hot wallet balance (with trading, the tokens it
holds count in that balance).
Offchain guarantees (guard-core): per-tx limit, recipient/domain allowlist, token/chain allowlist,
approval threshold, pause, simulation checks.

Neither chain needs a contract we write. Both primitives are audited and already deployed:

                 | Solana                          | Base (EVM)
  multisig       | Squads v4                       | Safe
  spend limit    | Squads Spending Limit           | Safe Allowance Module (resetTimeMin = 1440)
  dev network    | Solana devnet                   | Base Sepolia (84532)
  launch network | Solana mainnet-beta             | Base mainnet (8453)

## Stack
- Monorepo: pnpm workspaces, TypeScript (strict), Node 20+
- Chains: Solana first, then Robinhood Chain, then Base (D6, CR-007). Token: each chain's dollar
  only: USDC, and USDG from Paxos on Robinhood Chain, which has no Circle USDC.
- Shared: @modelcontextprotocol/sdk, grammY (Telegram), Fastify (HTTP), Drizzle + SQLite (MVP DB),
  zod (validation), vitest (tests)
- Solana: @sqds/multisig (depends on @solana/web3.js v1) for the multisig and the spending limit;
  @x402/svm + @x402/core (scheme `exact` over SPL transfers, peer dependency on @solana/kit >= 8) for
  payments; LiteSVM or solana-test-validator for tests. Both Solana client libraries are present
  because the ecosystem is mid-migration and each half of the work sits on a different one. Keep each
  confined to the code that needs it; addresses are base58 strings in both, so the boundary is a
  `PublicKey` to string conversion and nothing more.
- Base: viem, @safe-global/protocol-kit, x402 TS SDK (@x402/* >= 2.28.0 ONLY), Foundry for fork tests
- Always verify current library APIs in official docs before use. Never guess an address, mint or
  program id: read it from official sources and put it in packages/shared/src/addresses.ts.

## Repo layout
/packages/shared        types, zod schemas, addresses, constants (owned by Session 5, read-only for others)
/packages/onchain       Session 1 — ChainAdapter interface + svm/ (Squads) and evm/ (Safe) implementations
/packages/guard-core    Session 2 — policy engine, simulation, signer, x402 client, HTTP API, DB
/packages/mcp-server    Session 3 — MCP server exposing tools to agents
/packages/telegram-bot  Session 4 — owner approvals + kill switch (panel role since CR-012)
/packages/panel         panel role — the owner web app (CR-012)
/packages/sdk           mcp role — withReceipt and the defimind-verify CLI (CR-013)
/e2e                    Session 5 — end-to-end + attack tests, run once per chain

## Chain identifiers
Chains are CAIP-2 strings, never numbers: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" style for Solana,
"eip155:8453" for Base mainnet, "eip155:84532" for Base Sepolia, "eip155:4663" for Robinhood Chain and
"eip155:46630" for its testnet (CR-007). The values live in
packages/shared/src/constants.ts. The Solana references are the first 32 characters of each cluster's
genesis hash, confirmed with `solana genesis-hash` (CR-002):

  mainnet-beta | solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp
  devnet       | solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1

Each chain's dollar is `ChainAddresses.usd = { address, symbol }` in packages/shared/src/addresses.ts,
symbol "USDC" or "USDG", always 6 decimals. Exactly that address is the chain's dollar: a token with
the same name or symbol at any other address is refused (CR-007).

Addresses, token identifiers and transaction ids are opaque strings. Solana uses base58, EVM uses hex;
nothing outside a chain adapter may assume either.

## Shared types (packages/shared/src/types.ts)
type Amount = string // atomic units (the chain's dollar = 6 decimals), decimal string, never JS number

interface Policy {
  agentId: string
  chains: string[]                 // CAIP-2, e.g. ["solana:5eykt4..."]
  tokens: string[]                 // allowed mints / token addresses
  perTxMax: Amount
  dailyMax: Amount                 // offchain daily max (<= onchain dailyCap)
  approvalThreshold: Amount        // >= this requires the owner's approval (CR-012: the panel)
  allowedRecipients: string[]      // empty = deny all direct transfers
  allowedDomains: string[]         // for x402, e.g. ["api.example.com"]; empty = deny all
  paused: boolean
  // v0.6 (CR-010). Optional on PUT: omitted keeps the stored value, and a policy that has none gets
  // the default. So a v0.5 client's PUT never turns shadow back into live. The defaults only add protection.
  mode?: "live" | "shadow"         // default "live"; shadow evaluates and simulates, never signs
  priceIncreaseMaxPct?: number     // default 100: an x402 price above the pinned one by more goes to the owner
  maxPaymentsPerMinute?: number    // default 10: the payment that would exceed it trips the breaker
  requireMandate?: boolean         // default false: when true, every payment needs an open mandate
  trading?: TradingPolicy          // CR-021; absent = no trading at all
}

interface TradingPolicy {          // CR-021. Every loosening needs the passkey step-up (CR-015)
  enabled: boolean                 // default false
  venues: string[]                 // e.g. ["jupiter"]; empty = none
  tokens: string[]                 // tradable mints / token addresses; empty = none
  allowAnyToken: boolean           // default false: true admits any token that passes the risk checks
  maxTradeUsd: Amount              // the most one buy may spend, in the chain's dollar
  dailyTradeMax: Amount            // the most a day's buys may spend; sells are not counted
  maxPositionUsd: Amount           // the most held in one token, at cost
  maxSlippageBps: number           // default 100
  maxPriceImpactBps: number        // default 300
}

interface Mandate {                // CR-010: a budget for one task
  id: string                       // uuid
  agentId: string
  budget: Amount
  spent: Amount
  domains: string[]                // x402 domains it may pay; a subset of Policy.allowedDomains
  recipients: string[]             // transfer recipients; a subset of Policy.allowedRecipients
  reason: string                   // untrusted, shown to the owner
  status: "pending_approval" | "active" | "exhausted" | "expired" | "revoked"
  createdAt: string; expiresAt: string
}

type IntentStatus = "approved" | "pending_approval" | "rejected" | "executed" | "failed" | "expired"
  | "shadowed"                     // CR-010: would have been sent; shadow mode signs nothing

interface PayIntent {
  id: string                       // uuid
  agentId: string
  kind: "x402" | "transfer" | "swap"   // swap: CR-021
  chain: string                    // CAIP-2
  token: string
  amount: Amount
  recipient: string
  domain?: string                  // x402 only
  reason: string                   // agent-provided, shown to owner, never trusted for decisions
  status: IntentStatus
  rejectReasons: RejectCode[]
  txId?: string                    // base58 signature on Solana, hex hash on EVM
  mandateId?: string               // CR-010
  swap?: {                         // CR-021, kind "swap" only. token/amount are tokenIn/amountIn and
                                   // recipient is the hot wallet itself: a swap sends nothing elsewhere
    venue: string
    tokenOut: string
    minAmountOut: Amount
    slippageBps: number
    priceImpactBps: number
    decimalsIn: number             // read from each mint onchain by the adapter, never from a venue
    decimalsOut: number
    symbolIn?: string              // display only, untrusted: always shown beside the mint
    symbolOut?: string
    quotedAt: string
  }
  createdAt: string; expiresAt: string
}

interface Receipt {                // CR-010: one per executed intent
  intent: PayIntent
  policyHash: string               // hex SHA-256 of the canonical JSON of the policy in force
  simulation: string               // the simulation summary
  approvedBy: "policy" | "owner" | "passkey"
  issuedAt: string
  signature: string                // hex Ed25519 over the canonical JSON of the fields above
}

interface ExecutionReceipt {       // CR-013: one per tool call or payment, one chain per deployment
  type: "defimind.execution.v1"    // domain separation from Receipt
  seq: number                      // 1, 2, 3… with no gap
  prevHash: string                 // hash of receipt seq-1; 64 zeros for seq 1
  agentId: string
  kind: "tool_call" | "payment"
  server: string                   // the downstream MCP server, or "defimind" for payments
  tool: string
  requestHash: string              // hex SHA-256 of the canonical JSON of the arguments
  responseHash: string             // hex SHA-256 of the canonical JSON of the result
  outcome: "ok" | "error" | "refused"
  assurance: "executed" | "relayed"
  paymentReceipt?: string          // kind "payment" only
  startedAt: string; endedAt: string; issuedAt: string
  hash: string                     // hex SHA-256 of the canonical JSON of the fields above
  signature: string                // hex Ed25519 over the same bytes
}

interface Anchor { fromSeq: number; toSeq: number; root: string; chain: string; txId: string; anchoredAt: string }
interface ProofBundle {            // what the owner hands a third party
  receipt: ExecutionReceipt
  siblings: { side: "left" | "right"; hash: string }[]   // leaf to root
  anchor: Anchor
}

## Reject codes
Shared: PAUSED, CHAIN_NOT_ALLOWED, TOKEN_NOT_ALLOWED, RECIPIENT_NOT_ALLOWED, DOMAIN_NOT_ALLOWED,
PER_TX_EXCEEDED, DAILY_EXCEEDED, SIM_FAILED, SIM_UNEXPECTED_EFFECT, OWNER_REJECTED, APPROVAL_TIMEOUT,
INVALID_402, MANDATE_REQUIRED, MANDATE_EXCEEDED, MANDATE_EXPIRED, BREAKER_TRIPPED (CR-010)

Approval flags (CR-010), not reject codes: they send a payment to the owner even below the
threshold. RECIPIENT_CHANGED (an x402 domain asks for another payTo, chain or token than its pinned
last payment), PRICE_JUMP (above the pinned amount by more than priceIncreaseMaxPct).

EVM only: APPROVAL_DETECTED (approve/increaseAllowance/setApprovalForAll), PERMIT_DETECTED
(Permit/Permit2 typed data), DELEGATION_DETECTED (EIP-7702 authorization)

Solana only: DELEGATE_DETECTED (SPL Approve), AUTHORITY_CHANGE_DETECTED (SetAuthority),
ACCOUNT_CLOSE_DETECTED (CloseAccount), UNKNOWN_PROGRAM_DETECTED (CPI into a program not on the
allowlist), HIDDEN_ACCOUNTS_DETECTED (address lookup tables obscuring touched accounts)

Trading (CR-021), shared: TRADING_DISABLED, VENUE_NOT_ALLOWED, TOKEN_NOT_TRADABLE, TRADE_EXCEEDED,
TRADE_DAILY_EXCEEDED, POSITION_EXCEEDED, SLIPPAGE_TOO_HIGH, PRICE_IMPACT_TOO_HIGH, NO_EXIT_ROUTE,
QUOTE_STALE. Solana only: TOKEN_FREEZABLE (the mint keeps a freeze authority), TOKEN_EXTENSION_RISK
(Token-2022 transfer fee, transfer hook, permanent delegate or non-transferable).
Trading approval flags: NEW_TOKEN (the first buy of a token), MINT_AUTHORITY (the mint can still be
inflated).

## ChainAdapter (packages/onchain/src/ChainAdapter.ts)
guard-core depends on this interface only and never imports a chain SDK directly.

type AllowanceState =                            // CR-008
  | { status: 'active'; cap: Amount; spent: Amount; resetsAt: string; delegate: string }
  | { status: 'none'; delegate: string }           // the chain shows no limit: after a kill
  // getAllowanceState throws when it cannot read the chain; it never reports a failed read as 'none',
  // and never reports 'none' as an active limit with a zero cap.
interface SimulationOutcome { simulation: SimulationResult; rejectReasons: RejectCode[] }

interface ChainAdapter {
  chain: string                                  // CAIP-2
  getAllowanceState(): Promise<AllowanceState>
  topUpHotWallet(amount: Amount): Promise<string>  // returns txId
  getHotWalletBalance(token: string): Promise<Amount>
  getHotWalletGas(): Promise<{ balance: Amount; minimum: Amount; symbol: string }>  // CR-011: native
                                                   // coin, and what a few draws need
  getVault(): Promise<{ address: string; token: string; balance: Amount }>  // CR-019: the owner's
                                                   // vault (Squads vault index 0, or the Safe),
                                                   // where deposits go, and its balance
    // CR-022: plus control?: { threshold: number; signers: number }, read onchain: the Safe's
    // threshold and owners, or the multisig's voters. A controlled Squads multisig (every
    // DefiMind vault: the kill uses its config authority) is { 1, 1 }: that authority alone can
    // empty it. Doctor warns at threshold 1. On Solana, it names the config authority as the key
    // to protect (a hardware wallet); on EVM, it advises another owner or a 2-of-3.
  getLandedChanges?(txId: TxId): Promise<BalanceChange[]>  // CR-024: the hot wallet's token deltas
                                                   // in a confirmed transaction, for settlement
  tokenRisk?(mint: Address): Promise<Omit<TokenRisk, "venue" | "flags">>  // CR-025: the mint read
                                                   // onchain, plus the exit for 10 USD
  buildKillTx(): Promise<{ description: string; payload: unknown }>  // owner signs this
  simulate(intent: PayIntent): Promise<SimulationOutcome>
  send(intent: PayIntent): Promise<string>         // returns txId
  x402Scheme(intent: PayIntent, requirements: PaymentRequirements): SchemeNetworkClient
  // CR-021, optional: an adapter without them refuses every swap with VENUE_NOT_ALLOWED.
  // simulate() and send() take kind "swap" too; send() re-quotes nothing and signs only the
  // transaction whose simulated balance deltas matched the intent.
  quoteSwap?(req: { tokenIn: string; tokenOut: string; amountIn: Amount; slippageBps: number })
    : Promise<SwapQuote>
  getPositions?(): Promise<{ token: string; amount: Amount; decimals: number }[]>
}

interface SwapQuote {               // CR-021. Venues are untrusted: every field is checked again
  venue: string; tokenIn: string; amountIn: Amount; tokenOut: string
  expectedOut: Amount; minAmountOut: Amount; slippageBps: number; priceImpactBps: number
  decimalsIn: number; decimalsOut: number   // from each mint onchain, never from the venue
  symbolIn?: string; symbolOut?: string     // display only, untrusted
  exitImpactBps: number | null      // a sell quote for the amount bought; null = no exit route
  risks: RejectCode[]               // TOKEN_FREEZABLE, TOKEN_EXTENSION_RISK, NO_EXIT_ROUTE
  flags: ("NEW_TOKEN" | "MINT_AUTHORITY")[]
  quotedAt: string
}

x402Scheme returns a scheme client for @x402/core that signs this one intent and nothing else: it
inspects the exact message before signing and refuses anything that differs from the intent.
PaymentRequirements and SchemeNetworkClient are the @x402/core types. This keeps chain SDKs out of
guard-core even for x402 signing.

## guard-core HTTP API (port 8787). Auth: header `Authorization: Bearer <token>`
Agent token (per agent) for /v1/agent/*; admin token for /v1/admin/*; bot token for /v1/bot/*.
The /v1/bot/* routes exist only when the Telegram bot is configured (CR-017).

POST /v1/agent/x402/fetch   { agentId, url, method, headers?, body?, maxAmount? }
  -> 200 { intentId?, status?, response?: { status, headers, body } , rejectReasons }
  Guard performs the request; on 402 parses requirements, runs policy + simulation,
  signs the payment ONLY if approved, retries, returns the paid response.
  If pending_approval: returns { status: "pending_approval", intentId } immediately.
  No payment, no intent: when the resource does not ask for a payment, intentId and status are absent
  and the response passes through with rejectReasons: []. When the host is refused before any request
  is made, intentId is absent and the result is { status: "rejected", rejectReasons: ["DOMAIN_NOT_ALLOWED"] }.
  After the owner approves, the agent repeats the same request. The approval is redeemed once, for
  exactly the approved chain, token, amount, recipient and domain, and (CR-022) only by the same
  request: guard-core keeps the SHA-256 of the method, the full URL with its query, and the body.
  Another request is a new intent. An approval not redeemed before
  expiresAt expires with APPROVAL_TIMEOUT.
POST /v1/agent/transfer     { agentId, chain, token, amount, recipient, reason, mandateId? } -> { intentId, status, txId?, rejectReasons }
  x402 fetch takes mandateId? too. With one, the payment must also fit that mandate (CR-010).
POST /v1/agent/mandates     { agentId, budget, domains, recipients?, ttlSeconds, reason } -> Mandate
  Inside the policy only; ttlSeconds is 60 to 86400. At or above approvalThreshold it starts
  pending_approval and goes to the owner.
GET  /v1/agent/intents/:id/receipt -> Receipt   (404 until the intent is executed)
GET  /v1/agent/intents/:id  -> PayIntent
GET  /v1/agent/budget/:agentId -> { spentToday, shadowSpentToday, dailyMax, perTxMax, hotWalletBalances, paused, chains, mandates }
  mandates: the agent's active mandates (CR-010).
  shadow?: { since, total, count }: since the agent's first shadowed payment, what shadow mode would
  have spent in all and how many payments (CR-011). Absent when it never ran in shadow. It carries
  asked: { count, flags }, how many of those live would have taken to the owner and the distinct
  flags behind them, at most 16 (CR-024).
  chains: the CAIP-2 ids guard-core runs an adapter for AND this agent's Policy.chains allows, so an
  agent learns only where it may actually pay, never the operator's full setup.

POST /v1/bot/decision       { intentId, decision: "approve" | "reject", telegramUserId } -> PayIntent
POST /v1/bot/mandates/:id/decision { decision: "approve" | "reject", telegramUserId } -> Mandate (CR-010)
  409 { error: "already_decided" } or 410 { error: "expired" }, as for intents. A pending mandate
  expires after the same 10 minutes as a pending intent.
Bot routes that only tighten or read (CR-016). The bot holds BOT_TOKEN only, never the admin token;
every write is audited with via: "bot".
POST /v1/bot/pause { agentId }; POST /v1/bot/kill {} -> the same body as POST /v1/admin/kill
POST /v1/bot/agents/:id/revoke -> { agentId, revoked: true }
POST /v1/bot/policy/:agentId/tighten { removeDomains?, removeRecipients?, mode?: "shadow",
  perTxMax?, dailyMax?, approvalThreshold? } -> Policy
  Each limit given must be at or below the current one. Anything loosened() would count is refused
  with 403 { error: "loosen_in_panel" }.
GET  /v1/bot/agents, /v1/bot/policy/:agentId, /v1/bot/budget/:agentId, /v1/bot/chains,
GET  /v1/bot/report?from&to, /v1/bot/doctor   the same bodies as the admin reads
The bot has no route that creates agents, adds to an allowlist, raises a limit, goes live, resumes or
issues an enrolment code: those are the panel's, with a passkey, or the machine's, with the admin
token within the CR-022 rule below. A bot started with GUARD_ADMIN_TOKEN set logs a warning and does not use it.
POST /v1/admin/pause        { agentId } ; POST /v1/admin/resume { agentId }
POST /v1/admin/kill         {} -> pauses all agents AND prepares, for every chain, the owner tx that
                                  sets the allowance to 0 and removes the delegate
  -> { pausedAgents: number,
       ownerTransactions: { chain: string, description: string, payload: unknown }[] }
  Each ownerTransactions entry is one chain's ChainAdapter.buildKillTx() with its CAIP-2 chain added.
  A chain whose kill tx could not be built stays in the list with payload: null and a description
  telling the owner to remove the spend limit by hand: that chain's allowance is still live.
GET/PUT /v1/admin/policy/:agentId  Policy
  Admin only tightens (CR-022). A PUT that loosens, as loosened() counts it, and every
  POST /v1/admin/resume are refused with 403 { error: "loosen_in_panel" }, as for the bot (CR-016):
  loosening is the panel's, with the passkey. POST /v1/admin/mandates opens the mandate
  as the agent's own request would (CR-010): at or above approvalThreshold it waits for the owner in
  the panel, so the admin token gets no more than the agent's token already has. Each refusal is audited (event
  "admin_loosen_refused", via "admin") and alerts the owner: { kind: "admin_loosen_refused" } to the
  bot and Web Push "attack". Reads, tightening, pause, kill, revoke and creating an agent (deny-all,
  shadow) are unchanged. Tests and local tools write a policy into the database directly.
POST /v1/admin/agents { agentId } -> { agentId, token }   (CR-011) the token once; only its hash is
  kept. The new agent gets a deny-all policy with mode "shadow". 409 { error: "exists" }.
GET  /v1/admin/agents -> { agents: { agentId, paused, mode }[] }
POST /v1/admin/agents/:id/revoke -> { agentId, revoked: true }   cuts it off at its next request
GET  /v1/admin/doctor -> { checks: { id, status: "ok" | "warn" | "fail", message, fix? }[] }
  Plain-English checks, never a secret: database writable, each chain's allowance readable, each
  hot wallet's gas (getHotWalletGas) and token balance, the bot reachable, the last backup's age.
POST /v1/admin/mandates { agentId, budget, domains, recipients?, ttlSeconds, reason } -> Mandate
  (since CR-022, opened as an agent's own: pending_approval at or above approvalThreshold)
POST /v1/admin/mandates/:id/revoke -> Mandate
GET  /v1/admin/receipts?from&to -> { receipts: Receipt[] }
GET  /v1/admin/report?from&to -> { agents: { agentId, spent, payments, refused: Record<RejectCode, number>,
                                   domains: { domain, spent }[] }[] }
POST /v1/admin/passkeys/options -> WebAuthn registration options; POST /v1/admin/passkeys { response }
POST /v1/admin/passkeys/code -> { code, expiresAt }   one-time, 10 minutes, hashed at rest; for
  GET /owner/enrol#code=… on the public listener (in the fragment, so no request line or log holds it),
  which runs WebAuthn registration for this origin via POST /v1/owner/passkeys/options { code } and
  POST /v1/owner/passkeys { code, response }. The bot's /passkey enrol sends the link.
  First passkey (CR-022). With SETUP_CODE set, only POST /v1/owner/setup { setupCode } issues the
  code for the first passkey: the admin passkey routes (code, options and the first enrolment) refuse
  it with 403 { error: "use_setup_code" }, audited
  and alerted as admin_loosen_refused, so an admin token cannot take over a fresh deployment. Without
  SETUP_CODE, guard-core warns at every start while no passkey exists.
  Code enrolment adds the FIRST passkey only. Once one exists, POST /v1/owner/passkeys also needs an
  assertion from an enrolled passkey (step-up), so a stolen Telegram account cannot add its own key.
  Every enrolment sends the bot an alert { kind: "passkey_enrolled" }. GET /v1/admin/passkeys lists them
  (id, created, last used); removing one is a command on the machine, never an API call.
GET  /v1/receipts/key -> { publicKey }   public: lets anyone check a receipt
GET  /owner/approve/:intentId            public page: WebAuthn for this origin, then
POST /v1/owner/approve { intentId, assertion } -> PayIntent
  With PASSKEY_ABOVE set, an intent at or above it is approved only here; /v1/bot/decision still
  rejects it but refuses to approve it. The challenge is single-use and expires with the intent.
## Owner panel (CR-012)
guard-core serves the panel (packages/panel, static) at /panel on the public listener, with
CSP default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self';
worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'.
Owner routes need the session cookie; every state-changing one also needs X-DefiMind-Request: 1 and
Origin == PASSKEY_ORIGIN. 401 { error: "no_session" }, 403 { error: "bad_origin" | "step_up_required" }.
Step-up (CR-015): no assertion gives 403 step_up_required; one that fails verification, is for another
action or body, or was already used gives 401 passkey_not_verified. Only a 401 no_session ends the
panel's session.
POST /v1/owner/session/options -> WebAuthn authentication options (single use, 2 minutes)
POST /v1/owner/session { assertion } -> { expiresAt }   sets dm_session: HttpOnly, Secure,
  SameSite=Strict, Path=/v1/owner; 30 minutes idle, 12 hours in all; stored as its SHA-256
POST /v1/owner/session/logout -> { ok: true }
POST /v1/owner/challenge { action: OwnerAction, body } -> WebAuthn options, single use, bound to
  sha256(canonical JSON of { action, body }); the step-up assertion for that exact action and body
  OwnerAction = "approve_intent" | "approve_mandate" | "loosen_policy" | "resume" | "create_agent"
    | "change_settings" (CR-019) | "close_positions" (CR-021, body {})
    | "agent_wallet" (CR-022, body { agentId, chain })
    | "manual_trade" (CR-025, body { agentId, chain, tokenIn, tokenOut, amountIn, minAmountOut })
GET  /v1/owner/overview -> { chains: { chain, allowance }[], agents: AgentSummary[],
  pending: ApprovalRequest[], mandates: MandateApprovalRequest[] }
GET  /v1/owner/deposit -> { chains: { chain, vault, token, balance, dailyCap?, depositPage? }[] }
  (CR-019) Session only. vault is where deposits go; depositPage opens the signing page's deposit.
POST /v1/owner/intents/:id/decision { decision: "approve" | "reject", assertion? } -> PayIntent
POST /v1/owner/mandates/:id/decision { decision, assertion? } -> Mandate
  approve needs the step-up assertion; every panel approval records approvedBy "passkey"
GET  /v1/owner/report?from&to, GET /v1/owner/doctor, GET /v1/owner/budget/:agentId,
GET  /v1/owner/receipts?from&to   as the admin ones (the panel matches a payment execution's
  paymentReceipt to its Receipt to show the amount)
GET  /v1/owner/agents; POST /v1/owner/agents { agentId, assertion } -> { agentId, token } (once);
POST /v1/owner/agents/:id/revoke
GET  /v1/owner/policy/:agentId; PUT /v1/owner/policy/:agentId { policy, assertion? }
  assertion required when the PUT raises perTxMax, dailyMax or approvalThreshold, adds to chains,
  tokens, allowedRecipients or allowedDomains, sets mode "live", sets requireMandate false, or (CR-015)
  sets paused from true to false, or raises maxPaymentsPerMinute or priceIncreaseMaxPct
POST /v1/owner/pause { agentId }; POST /v1/owner/resume { agentId, assertion }
POST /v1/owner/kill {} -> the same body as POST /v1/admin/kill, plus on each ownerTransactions entry
  link?: string (Phantom universal link) and pageLink?: string (the signing page itself), built with
  phantomKillUrl / killPageUrl from @defimind/shared, on SIGN_PAGE_URL or, without it, on
  HOSTED_SIGN_PAGE (CR-020), whenever the chain has a signing-page target. Each target names the
  vault and this deployment's hot wallet: multisig and hot on Solana, safe and hot on EVM. The
  admin kill never carries them.
GET  /v1/owner/passkeys -> as GET /v1/admin/passkeys
POST /v1/owner/push { subscription: { endpoint, keys: { p256dh, auth } } } -> { id }
DELETE /v1/owner/push/:id
GET  /v1/owner/push/key -> { publicKey }   the VAPID public key, base64url; session only (CR-014)
  Web Push with VAPID (VAPID_PRIVATE_KEY_FILE, VAPID_SUBJECT) and RFC 8291 encryption. Payload
  { kind: "approval" | "mandate" | "executed" | "attack" | "breaker" | "passkey_enrolled" | "kill"
  | "chain_broken" (CR-013) | "backup_failed" (CR-024),
  agentId?, chain?, amount?, intentId?, sentAt } and never a recipient or URL. A 404 or 410 from the
  push service deletes the subscription.
GET  /panel/enrol#code=…   the first-passkey page; src/scripts/passkey-code.ts prints the link
TELEGRAM_APPROVALS (default false): when false, POST /v1/bot/decision and /v1/bot/mandates/:id/decision
  refuse "approve" with 403 { error: "approve_in_panel" } and still accept "reject".

GET  /v1/admin/budget/:agentId -> BudgetView   same body as GET /v1/agent/budget/:agentId;
                                  404 { error: "not_found" } for an unknown agent
GET  /v1/admin/chains -> { chains: { chain: string, allowance: AllowanceState | null }[] }
  One entry per configured ChainAdapter, in the order guard-core holds them. allowance is that
  adapter's getAllowanceState(), or null when reading it failed. An empty list means no chain is
  configured, so every payment is refused. The bot shows status 'none' as "no onchain limit (killed)"
  and null as "could not be read" (CR-008).

## Verified execution (CR-013)
One hash chain of ExecutionReceipt per deployment, signed with RECEIPT_SIGNING_KEY. A single writer
appends in one DB transaction, so seq and prevHash cannot fork. guard-core stores hashes and metadata
only, never tool arguments or results. Every executed payment also appends a "payment" entry whose
paymentReceipt is the hex SHA-256 of the canonical JSON of its CR-010 Receipt.
assurance "executed": guard-core ran the action itself. "relayed": a gateway or the SDK reported a
call it made; guard-core vouches for when it heard of it and that the record never changed since, not
for what the tool really did. Docs and the panel must say this plainly.

POST /v1/agent/executions { server, tool, requestHash, responseHash, outcome, startedAt, endedAt }
  -> ExecutionReceipt (assurance "relayed")   agent token; agentId comes from the token
GET  /v1/owner/executions?agentId&from&to -> { receipts: ExecutionReceipt[] }   the panel timeline
GET  /v1/owner/executions/integrity -> { lastSeq, lastHash, brokenAt?: number, lastAnchor?: Anchor }
  The whole chain is re-checked at start-up and daily. A break sends the alert
  { kind: "chain_broken", detail, sentAt } to the bot and a push to the panel.
GET  /v1/owner/executions/:seq/proof -> ProofBundle   404 until the receipt is anchored
GET  /v1/admin/executions?from&to -> { receipts: ExecutionReceipt[] }
GET  /v1/anchors?from&to -> { anchors: Anchor[] }   public; anchors only, never a receipt

Anchoring, only with ANCHOR_CHAIN set (CAIP-2; Solana first): every hour or 1,000 receipts, whichever
comes first, and never with no new receipt. Merkle leaf = SHA-256(0x00 || hash), node =
SHA-256(0x01 || left || right), an odd node promoted unchanged. One tx carries the memo
defimind:anchor:v1:<fromSeq>-<toSeq>:<rootHex>: the Memo program on Solana; on EVM later, calldata to
the anchor key's own address. ANCHOR_KEY_FILE is its own keypair, funded for fees only, never the
hot wallet. A failed publication is retried; receipts stay valid without an anchor.

Gateway mode (mcp-server): a file lists downstream MCP servers (stdio command or HTTP URL). Their
tools are exposed as <server>__<tool>; each call is forwarded, then reported to POST
/v1/agent/executions. Fail closed: an unrecorded result waits in a local outbox and is retried, and
no new call is forwarded while the outbox is not empty. GATEWAY_KEEP_BODIES (default false) keeps
bodies in a local file for the operator.
SDK (packages/sdk): withReceipt(server, tool, fn) reports any async call the same way.
requestHash and responseHash are the hex SHA-256 of the canonical JSON of the arguments and of the
result. A thrown error hashes as { error: message }; a call that returns nothing hashes as null.
defimind-verify <bundle.json> [--key <hex>] [--rpc <url>]: checks offline the signature, the
receipt hash, the Merkle path and the root in the anchor tx, and, given a run of receipts, that seq
has no gap and every prevHash links. Prints pass or fail per check; trusts no DefiMind server.

## Guided setup (CR-019)
A one-click deployment (render.yaml) starts guard-core with only ADMIN_TOKEN and SETUP_CODE, both
generated by the host, and a persistent disk at /data. Everything else is set from the panel.

First access. GET /v1/owner/setup -> { needsSetup: boolean } (public). While no passkey is enrolled,
POST /v1/owner/setup { setupCode } -> { enrolLink } issues the same one-time enrol code as
passkey-code; the code is compared in constant time and rate-limited per IP. Once a passkey exists
it answers 410 { error: "setup_done" } and SETUP_CODE is never accepted again. A wrong code is
401 { error: "setup_code_invalid" }; too many tries is 429.

Keys. At start, each key not given by env or file is generated once and stored under
/data/keys (directory 0700, files 0600): a hot wallet per enabled chain, the receipt key, the VAPID
key and the anchor key. A key given by env or file always wins, so existing deployments are
unchanged. GET /v1/owner/keys -> { hotWallets: { chain, address, gas?: HotWalletGas }[], receiptKey, anchorKey? }
returns public keys only; no route ever returns a private key.

Settings. GET /v1/owner/settings -> { chains: { chain, rpcUrl?, vault? }[] }, one entry per enabled
chain, including chains with nothing stored yet. PUT /v1/owner/settings { chains: { chain, rpcUrl?,
vault? }[] } (step-up change_settings) answers with the same body as GET. Env always wins over a
stored setting. A vault is adopted only after guard-core reads it on chain: a Squads multisig whose
spending limit has guard-core's own hot wallet as its only member and destination, or a Safe whose
Allowance Module delegate is guard-core's hot wallet; anything else is 422 { error: "vault_not_ours" }.
So the vault is saved once its limit exists, and progress marks vault and limit done together.

Progress. GET /v1/owner/setup/progress -> { steps: { id, done }[] } with ids passkey, vault, limit,
deposit, agent, rules, shadow, live, each derived from stored state and the chain, never from a flag
the panel sets.

Signing page. guard-core serves the signing page itself at /sign, from the same build as the hosted
one, with its own hot wallets and chains injected at serve time; a link never names the hot wallet.
SIGN_PAGE_URL still overrides it. action=add-limit no longer needs amount: without it the owner types
the daily cap on the page, at most MAX_DAILY_CAP (50 during the beta). action=deposit (cluster, and
multisig or safe) derives the vault from the chain, signs only when the connected wallet is a member
of that multisig or an owner of that Safe, lets the owner type the amount, and signs a plain token
transfer into the vault; it never grants an allowance, delegate or other authority.
Only create and add-limit need this deployment's hot wallet. Deposit and kill need no
per-deployment value, so the panel opens them on the hosted page built from main; a compromised
guard-core cannot change that page.

Hosted page (CR-020). HOSTED_SIGN_PAGE in @defimind/shared is one page built from main with no hot
wallet, at a fixed URL, and the default for kill and deposit links when SIGN_PAGE_URL is unset. On a
cluster for which a build has no hot wallet, it serves create, deposit and kill only: action=kill
takes the vault and the hot wallet from the link (multisig and hot on Solana, safe and hot on EVM),
since a kill only removes authority, and add-limit and enable are refused. When no limit or
allowance exists for a hot wallet taken from the link, the page says so ("No limit found for this
hot wallet"), never "Already killed". A build that has a hot wallet for the cluster keeps the rule
that a link naming any other hot wallet is refused. Every action still checks the connected wallet
on the chain before Phantom opens: the config authority of the multisig, the sole owner of the Safe,
or a member or owner for a deposit. Before every Phantom prompt, /sign
and the hosted page show in large text what the transaction itself carries, decoded from its bytes
and not from the link or the server: the destination or delegate, and the amount. /sign is served
with the same strict CSP as the panel, and each release publishes the SHA-256 of the signing-page
build so a modified /sign can be detected.

Backups (CR-024). guard-core backs up its own database every day at BACKUP_HOUR_UTC (default 3),
with SQLite's online backup (the same as db:backup), to backups/guard-<UTC date>.db beside the
database on the data volume, mode 0600. It keeps the newest 14 and deletes older ones, and never
serves a backup over HTTP. With BACKUP_BUCKET_URL set (an S3-compatible bucket, path-style
https://<endpoint>/<bucket>[/<prefix>], signed with SigV4 for BACKUP_REGION, default "auto", with
BACKUP_ACCESS_KEY_ID and BACKUP_SECRET_ACCESS_KEY as secrets), each backup is also uploaded as
<name>.enc, encrypted with AES-256-GCM under BACKUP_ENCRYPTION_KEY (12-byte IV, ciphertext, 16-byte
tag), which a bucket requires. The doctor's backup check reads the newest backup: ok under 26 hours
old, warn otherwise; with a bucket it names the last upload and warns until one is under 26 hours
old. A failed backup or upload alerts the owner once a day:
{ kind: "backup_failed" } to the bot and Web Push "backup_failed".

Hosting behind one public listener. ADMIN_ROUTES=false leaves /v1/admin/* unregistered, as the
one-click deployment does. With one listener (PUBLIC_PORT unset), guard-core refuses to start with
ADMIN_ROUTES=true unless HOST is a loopback address or ALLOW_PUBLIC_ADMIN=true. The override logs a
warning at every start and doctor reports "warn" (CR-022).
Host check (CR-022). With PUBLIC_URL or PASSKEY_ORIGIN set, the public listener answers
421 { error: "misdirected" } when the Host header names another host. A single listener on loopback
accepts only localhost, 127.0.0.1, [::1] and its HOST. GET /health is exempt. PUBLIC_URL is the https address the owner opens; on Render it defaults to
RENDER_EXTERNAL_URL, and PASSKEY_RP_ID and PASSKEY_ORIGIN default from it. TRUST_FORWARDED_FOR=true
takes the client address for rate limits from the hop the host's proxy adds, never from one the
client sent.

## Trading (CR-021)
Phase 1: Solana through Jupiter only. Every swap has the chain's dollar on one side: a buy spends it,
a sell returns to it. EVM chains need their own design (router approvals) in a later CR.

POST /v1/agent/quote { agentId, chain, tokenIn, tokenOut, amountIn, maxSlippageBps? } -> SwapQuote
POST /v1/agent/swap  { agentId, chain, tokenIn, tokenOut, amountIn, maxSlippageBps?, reason, mandateId? }
  -> { intentId, status, txId?, rejectReasons }
GET  /v1/agent/portfolio/:agentId -> { positions: Position[], tradedToday, dailyTradeMax }
GET  /v1/owner/portfolio -> { agents: { agentId, positions: Position[], tradedToday, dailyTradeMax }[] }
  session only
POST /v1/owner/positions/close { assertion } -> { intents: PayIntent[] }   step-up, OwnerAction
  "close_positions" with body {}; sells every token the hot wallets hold back to the chain's dollar,
  through the same checks. Works while agents are paused.
Position = { chain, token, amount, cost, decimals, symbol? }: decimals read from the mint onchain by
  the adapter, never from a venue's token list; symbol is display only and untrusted, so a client
  always shows the mint beside it.

Checks, in order, all default deny:
1. Policy: trading enabled, the venue allowed, the token in tokens (or allowAnyToken), a buy within
   maxTradeUsd and dailyTradeMax, the position at cost within maxPositionUsd, the quote's slippage
   and price impact within the limits, and the quote no older than 30 seconds (QUOTE_STALE).
2. Token risk before a buy: freeze authority, Token-2022 risk extensions, an exit route within
   maxPriceImpactBps. Each is a rejection; NEW_TOKEN and MINT_AUTHORITY send the buy to the owner.
3. The transaction: lookup tables resolved from the chain (one that cannot be read or changed in
   the last 150 slots is HIDDEN_ACCOUNTS_DETECTED), then every inspectTransfer rule over the
   expanded message, top-level programs limited to Jupiter, Token, Token-2022, ATA, Compute Budget
   and System (wrapped-SOL rent only).
4. The test run: the hot wallet's tokenIn falls by at most amountIn, its tokenOut rises by at least
   minAmountOut, no other token account of the hot wallet loses anything, its SOL falls by fees and
   rent only, no delegate or authority changes. Anything else is SIM_UNEXPECTED_EFFECT.
5. Decide: a buy at or above approvalThreshold, or with a flag, waits for the owner; a sell never
   waits. Shadow mode simulates and signs nothing (paper trading). A shadowed swap records the
   flags and the needs-approval verdict live would have had (CR-024), and the owner's views show
   "Live would have asked you: …".
Buys count against dailyTradeMax, not dailyMax. A top-up for a buy draws the chain's dollar under the
same onchain cap, and never before the buy is decided (CR-024): a buy that waits for the owner is
asked with steps 1 to 3 done, and its top-up and test run (step 4) follow the approval, just before
signing. A failed test run then rejects the approved buy. When the hot wallet already holds enough,
the test run also runs before asking, and the request shows its balance changes.
Settlement (CR-024): positions, cost and proceeds come from what the confirmed transaction moved,
read with ChainAdapter.getLandedChanges(txId) -> BalanceChange[] (the hot wallet's token deltas,
from the transaction's own pre- and post-balances). The test run's deltas are only the check. A
position whose onchain balance is 0 after a sell is closed, dust included.

## Owner trading tools (CR-025)
The owner finds a token, reads its risk, allows it, and trades it from the panel. Solana mainnet
through Jupiter only, as for agents (CR-021). Every route here needs the owner's session.

GET  /v1/owner/tokens/search?q=&chain= -> { tokens: TokenInfo[] }
  guard-core proxies Jupiter's token search, since the panel's CSP allows no other origin. q is 1 to
  64 characters. The search is rate-limited per session to 30 a minute and cached for 60 seconds.
  The venue's answer is untrusted: it is validated with zod, its strings are bounded, and its
  fields are dropped except those below. Verified tokens come first; the panel shows unverified
  ones only after an explicit "Show unverified tokens", with a warning.
  TokenInfo = { chain, mint, symbol, name, decimals, verified, venue: { holders?, liquidityUsd?,
  organicScore?, createdAt? } }. liquidityUsd is the venue's figure as a decimal string, display
  only: never money and never in a decision. The symbol and name are display only and always shown
  beside the full mint. The decimals are the venue's and are re-read from the mint before any use. No remote
  image is ever loaded: the CSP allows img-src 'self' data: only, so at most a mint-derived
  identicon.
GET  /v1/owner/tokens/:mint/risk?chain= -> TokenRisk
  TokenRisk = { chain, mint, decimals, freezeAuthority: boolean, mintAuthority: boolean,
  extensions: string[], risks: RejectCode[], flags: TradingFlag[],
  exit: { amountUsd: Amount, priceImpactBps: number } | null, venue: TokenInfo["venue"] & { verified } }
  Every field outside venue is read onchain by ChainAdapter.tokenRisk?(mint) or computed by guard-core:
  - decimals, the authorities and the Token-2022 extensions come from the mint;
  - risks are the CR-021 rejections a buy would meet (TOKEN_FREEZABLE, TOKEN_EXTENSION_RISK,
    NO_EXIT_ROUTE);
  - flags are the CR-021 approval flags (NEW_TOKEN, MINT_AUTHORITY);
  - exit is the price impact of selling 10 USD worth back to the dollar, or null without a route.
  venue holds what Jupiter says, labelled as such. The card states facts only and never calls a token
  safe.
Allowing a token adds it to policy.trading.tokens: PUT /v1/owner/policy/:agentId with the step-up,
as any loosening. The panel shows the risk card before the passkey prompt.
POST /v1/owner/quote { agentId, chain, tokenIn, tokenOut, amountIn, maxSlippageBps? } -> SwapQuote
  The same quote an agent gets for that agent's policy, read-only: it decides nothing and records
  nothing.
POST /v1/owner/trade { agentId, chain, tokenIn, tokenOut, amountIn, minAmountOut, maxSlippageBps?,
  assertion } -> { intentId, status, rejectReasons, txId? }
  A manual trade for that agent. It always needs the step-up, OwnerAction "manual_trade" over
  { agentId, chain, tokenIn, tokenOut, amountIn, minAmountOut }, even below approvalThreshold. It runs
  the same pipeline as an agent's swap:
  - the policy, every limit and every risk check;
  - a fresh quote, which must still promise minAmountOut (the amount the owner saw) or the trade is
    SLIPPAGE_TOO_HIGH;
  - the inspection, the top-up and the test run;
  - with the assertion as the owner's approval, so no second request is made.
  It is audited via "owner" with reason "owner: manual trade", counts in that agent's day (buys
  against dailyTradeMax), and uses that agent's wallet (its own once it has one). A paused agent
  is refused (PAUSED); Close positions stays the way out. In shadow mode it is shadowed like any
  swap. The panel's copy describes controls, never returns.

## Agent wallets (CR-022, HIGH-2)
Opt-in, per agent and chain. By default every agent spends from the chain's shared spending (hot)
wallet, as before. An agent given its own wallet spends only from it, under its own onchain limit,
so a bug or a hijacked agent can never cost more than that agent's own cap.

Keys. guard-core generates the agent's hot wallet on request and stores it at
/data/keys/agents/<agentId>/<chain> (0600), or reads it from AGENT_WALLET_<AGENTID>_<CHAIN>_FILE if
that is set. It is never logged and never returned. One agent's key is never used for another agent.

Onchain limit. On Solana, a Squads spending limit on the same multisig, whose only member and only
destination is the agent's wallet: the spending-limit PDA is derived from that member, so limits never
collide. On EVM, an Allowance Module delegate with its own allowance on the same Safe. The owner signs
it on the signing page with action=add-limit naming the agent's wallet. /sign injects every hot wallet
of this deployment, shared and per agent, and refuses any other. The hosted page (CR-020) never
serves add-limit.

Routes (session, step-up "agent_wallet" over { agentId, chain }):
POST /v1/owner/agents/:id/wallets { chain, assertion } -> AgentWallet
  { chain, address, status: "pending_limit" | "active", addLimitPage, gas: { balance, minimum, symbol } }
  Idempotent: a second call returns the same wallet. The wallet is "active" only once guard-core
  reads its limit or allowance onchain, as for vault adoption (CR-019). Until then the agent keeps
  using the shared wallet.
GET  /v1/owner/agents/:id/wallets -> { wallets: AgentWallet[] }
AgentSummary gains wallets?: { chain, address, status }[]. GET /v1/owner/keys adds
agentWallets: { agentId, chain, address }[], public keys only.

Routing. For an agent with an active wallet on a chain, every payment, top-up and swap of that agent
on that chain uses only that wallet and its limit. getAllowanceState, doctor's gas and balance
checks, positions and Close positions all run per wallet. Agents without one keep the shared wallet.
Gas: the agent's wallet pays its own fees. The panel shows the address and the gas it needs, and
doctor warns below the minimum.

Kill. POST /v1/owner/kill still pauses every agent, and now returns one ownerTransactions entry per
chain and wallet, shared and per agent: every limit is removed. An agent's entry carries
wallet: { agentId, address }, and its links name that wallet. POST /v1/owner/agents/:id/kill {}
(session) pauses that agent and returns ownerTransactions for its own wallets only. Revoking an agent
with its own wallet returns the same transactions and says the limit is still live until they are
signed. The bot's and the admin's kill pause everything, as before, and carry no links.

Migration. Existing agents stay on the shared wallet until the owner opts in. To
move an agent: create its wallet, sign the limit, send it a little gas. It switches once its wallet is
active. Then lower the shared limit by what that agent used. Funds and positions already in the
shared wallet stay there; Close positions still reaches them.

Limit of the design. Every hot wallet key lives in the same guard-core. A compromised server holds them
all, and the bound is then the sum of the onchain caps, shared and per agent. Moving keys out of the
server (KMS or a signer service) is a later CR.

## Webhook guard-core -> telegram-bot
The Telegram bot is optional (CR-017). BOT_URL, BOT_TOKEN and BOT_WEBHOOK_SECRET are all set or all
unset; a partial set is a configuration error. With none set, guard-core sends no webhook, registers
no /v1/bot/* route, and doctor does not check a bot: the owner is reached through the panel and its
Web Push only. Push always goes out before the webhook, so a bot that is down never delays the panel.
POST {BOT_URL}/hooks/approval-request  (header X-Guard-Signature: HMAC-SHA256 of body with BOT_WEBHOOK_SECRET)
{ intent: PayIntent, simulation: { summary: string, balanceChanges: {token, delta}[] }, approveBefore: string }
Pending intents expire after 10 minutes -> status "expired", reason APPROVAL_TIMEOUT.

POST {BOT_URL}/hooks/intent-event      (same X-Guard-Signature scheme as approval-request)
{ intent: PayIntent, sentAt: string }  // sentAt: ISO time guard-core sent it
Sent when an intent reaches executed, rejected, failed or expired. The bot decides what to show
(executed at or above NOTIFY_ABOVE_AMOUNT, any per-chain attack code); guard-core has no notification
policy of its own. The bot refuses events older than 5 minutes and deduplicates on intent id plus
status. Attack-code alerts are throttled per agent and code; large-payment alerts are not.

POST {BOT_URL}/hooks/alert             (same X-Guard-Signature scheme; CR-010)
{ kind: "breaker_tripped", agentId: string, detail: string, sentAt: string }
  | { kind: "passkey_enrolled", detail: string, sentAt: string }
  | { kind: "chain_broken", detail: string, sentAt: string }   (CR-013)
  | { kind: "admin_loosen_refused", detail: string, sentAt: string }   (CR-022)
  | { kind: "backup_failed", detail: string, sentAt: string }   (CR-024: never a URL or a key)
The approval-request body gains flags: ("RECIPIENT_CHANGED" | "PRICE_JUMP")[] (empty when none),
pinned?: { recipient, amount } (the last executed payment to that domain, present with a flag),
passkey: boolean (approve only through /owner/approve), and mandate?: Mandate when the request is to
open a mandate rather than to pay (then intent is absent; approveBefore and simulation still come,
simulation with an empty balanceChanges). A mandate request also carries ttlSeconds, how long the budget
runs once approved: while pending, the mandate's expiresAt is only the approval deadline. A buy asked
before its test run (CR-024) carries untested: true, on the webhook, Web Push and the owner's pending
list: it is funded and test-run only once approved.

## MCP tools (mcp-server)
- paid_fetch { url, method?, headers?, body?, maxAmountUsd? }
- transfer   { to, amountUsd, reason, chain? }
- get_budget {}
- check_intent { intentId }
- start_task { budgetUsd, domains, recipients?, minutes, reason } -> mandate id (CR-010); paid_fetch and
  transfer take mandateId?. minutes is 1 to 1440; guard-core also refuses ttlSeconds above 86400.
- swap       { from, to, amountUsd? | amount?, maxSlippageBps?, reason, chain? } (CR-021): exactly one
  of amountUsd (a buy with the chain's dollar) or amount (atomic units of `from`, a sell)
- quote      { from, to, amountUsd? | amount?, chain? } -> SwapQuote, read-only (CR-021)
- get_portfolio {} -> positions, cost and the day's trade budget (CR-021)

## Security rules (all sessions)
- Agent-provided text (reason, URLs, headers, API responses) is untrusted. Never let it change policy.
- Default deny. Any parsing doubt = reject.
- The hot wallet keys live only in guard-core env (later: KMS). Never logged, never returned.
- Amounts are bigint internally. No floats for money.
- Every decision is written to the audit log (DB table audit_log) with reasons.
- Nothing outside a chain adapter may assume an address format, a signature format or a chain id shape.

## Changelog
- v0.19 (2026-11-24): CR-025, approved by the owner. Owner trading tools:
  - token search, proxied by guard-core;
  - a risk card read onchain;
  - a manual trade from the panel, through the agent pipeline with a passkey per trade.
- v0.18 (2026-11-24): CR-024. From a live trade:
  - a buy that waits for the owner draws nothing until approved;
  - positions settle from the landed transaction (ChainAdapter.getLandedChanges);
  - shadowed swaps record what live would have asked;
  - guard-core backs up its database daily, with an optional encrypted off-site copy.
- v0.17 (2026-11-24): CR-022. Review fixes:
  - the admin token only tightens: loosening, resuming and opening a mandate are the panel's;
  - with SETUP_CODE set, only the setup code enrols the first passkey;
  - one public listener refuses to serve the admin API unless told to;
  - an x402 approval is bound to its exact request;
  - the public listener checks the Host header;
  - getVault reports the vault's threshold, and doctor warns at threshold 1.
  The same day, opt-in agent wallets: a hot wallet and onchain limit
  per agent and chain, routed per agent, killed per agent.
- v0.16 (2026-11-24): CR-021, approved by the owner. Guarded trading, phase 1 on Solana through
  Jupiter: the swap intent kind, Policy.trading, the trading reject codes and approval flags,
  ChainAdapter.quoteSwap and getPositions, the agent quote, swap and portfolio routes, the owner's
  close-positions route, and the swap, quote and get_portfolio MCP tools. Clarified the same day
  for the panel: GET /v1/owner/portfolio, the "close_positions" OwnerAction, and token decimals
  (from the mint onchain) and an untrusted display symbol on positions and swaps.
- v0.15 (2026-11-20): CR-020, approved by the owner. One hosted kill and deposit page for every
  deployment: HOSTED_SIGN_PAGE, kill links that name the hot wallet on both families, and a page
  that takes the vault and hot wallet from a kill link when it was built with none.
- v0.14 (2026-11-20): CR-019, approved by the owner. Guided setup: one-click deploy, first access by
  SETUP_CODE, keys generated on the server's disk, settings and vaults from the panel, the setup
  progress, deposits (ChainAdapter.getVault, GET /v1/owner/deposit), and the signing page served by
  guard-core with an owner-typed cap and a deposit action.
- v0.13 (2026-11-20): CR-017, approved by the owner. The Telegram bot is optional: BOT_URL,
  BOT_TOKEN and BOT_WEBHOOK_SECRET all or none; without them no webhook and no /v1/bot/* route.
- v0.12 (2026-11-19): CR-016, approved by the owner. The bot loses the admin token: tightening-only
  and read-only /v1/bot/* routes under BOT_TOKEN, audited via "bot".
- v0.11 (2026-11-19): CR-015, approved by the owner. Three more policy changes need the step-up
  (unpausing, a raised maxPaymentsPerMinute, a raised priceIncreaseMaxPct), and the step-up error
  codes: 403 step_up_required, 401 passkey_not_verified.
- v0.10 (2026-11-18): CR-014, approved by the owner. GET /v1/owner/push/key for the VAPID public
  key; optional link and pageLink on the owner kill's ownerTransactions; the Phantom kill-link
  builders move from the bot to @defimind/shared.
- v0.9 (2026-11-18): CR-013, approved by the owner. Verified execution: a signed, hash-chained
  ExecutionReceipt for every tool call and payment, the MCP gateway mode, the SDK, optional Merkle
  anchoring with no custom contract, defimind-verify, and the executions routes for the panel.
- v0.8 (2026-11-16): CR-012, approved by the owner. The owner panel: passkey sessions, step-up
  assertions bound to each action, owner routes, Web Push, and TELEGRAM_APPROVALS (default false).
- v0.7 (2026-11-09): CR-011, approved by the owner. Agent creation, listing and revocation and a
  doctor on the admin API, for the bot's owner commands and the setup wizard; new agents start in
  shadow mode; ChainAdapter.getHotWalletGas.
- v0.6 (2026-11-09): CR-010, approved by the owner. Recipient and price pinning for x402, task
  budgets (mandates), a circuit breaker, shadow mode, passkey approvals above PASSKEY_ABOVE, signed
  receipts, an admin report, and the bot's alert webhook. Every new Policy field is optional with a
  default that only adds protection: a v0.5 policy keeps every limit it had.
- v0.5 (2026-11-08): CR-007 and CR-008, approved by the owner.
  CR-007: Robinhood Chain (eip155:4663, testnet eip155:46630) comes after Solana and before Base. Its
  dollar is Paxos USDG, so each chain's dollar is `usd: { address, symbol }` instead of `usdc`; the
  policy, the caps and the amounts do not change.
  CR-008: AllowanceState has an explicit 'none' status for a chain with no limit, so a kill is not
  shown as a read failure.
- v0.4 (2026-11-04): CR-006, approved by the owner. GET /v1/admin/chains lists the chains guard-core
  runs, with each one's onchain allowance, for the bot's /status and /kill. The budget routes gain
  `chains`, the configured chains this agent's policy allows, so mcp can check its DEFAULT_CHAIN.
- v0.3 (2026-11-03): three owner-approved changes.
  CR-002: the Solana CAIP-2 ids are confirmed against each cluster's genesis hash and written here; the
  values did not change.
  CR-003: ChainAdapter.x402Scheme, so x402 signing lives in the adapter and guard-core imports no chain
  SDK. intentId and status are optional on x402 fetch responses when no payment happens. An approved
  x402 payment is redeemed once, on exactly the approved terms.
  CR-004: the intent-event webhook to the bot, GET /v1/admin/budget/:agentId, and a pinned
  /v1/admin/kill response.
- v0.2.2 (2026-11-03): the Solana stack carries both client libraries. @sqds/multisig depends on
  @solana/web3.js v1 while @x402/svm requires @solana/kit >= 8, so the choice is the ecosystem's, not
  ours. Recorded rather than papered over: a wrapper hiding one behind the other would add a layer
  nobody can audit against either library's docs.
- v0.2.1 (2026-11-03): `ChainAdapter.simulate` returns `SimulationOutcome` rather than a bare
  `SimulationResult`. The per-chain checks in the adapters produce reject codes, and the caller needs
  both the summary shown to the owner and the codes written to the audit log. Correction to the
  interface introduced in v0.2, not a change to anything decided before it.
- v0.2 (2026-11-03): two chains, Solana first then Base, per CR-001. Chain ids are CAIP-2 strings;
  addresses, tokens and transaction ids are opaque strings. Reject codes split into a shared core plus
  per-chain sets. packages/onchain becomes a ChainAdapter interface with svm/ and evm/ implementations.
  Robinhood Chain rejected. Previous versions targeted Base alone.
