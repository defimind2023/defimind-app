import type {
  Address,
  AgentWalletStatus,
  Mandate,
  Receipt,
  Amount,
  ChainId,
  IntentStatus,
  PayIntentKind,
  PolicyDecision,
  RejectCode,
  SwapDetails,
  TradingPolicy,
} from '@defimind/shared'
import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * Amounts are stored as text, not integers. They are decimal strings of atomic units everywhere else,
 * and text keeps that contract end to end with no chance of a driver handing back a double.
 * Timestamps are ISO-8601 strings for the same reason: they survive a round trip unchanged.
 */

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** SHA-256 of the bearer token. The token itself is shown once, at creation, and never stored. */
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: text('created_at').notNull(),
  revokedAt: text('revoked_at'),
})

export const policies = sqliteTable('policies', {
  agentId: text('agent_id')
    .primaryKey()
    .references(() => agents.id),
  chains: text('chains', { mode: 'json' }).$type<ChainId[]>().notNull(),
  tokens: text('tokens', { mode: 'json' }).$type<Address[]>().notNull(),
  perTxMax: text('per_tx_max').$type<Amount>().notNull(),
  dailyMax: text('daily_max').$type<Amount>().notNull(),
  approvalThreshold: text('approval_threshold').$type<Amount>().notNull(),
  allowedRecipients: text('allowed_recipients', { mode: 'json' }).$type<Address[]>().notNull(),
  allowedDomains: text('allowed_domains', { mode: 'json' }).$type<string[]>().notNull(),
  paused: integer('paused', { mode: 'boolean' }).notNull().default(false),
  // The defaults here and in POLICY_DEFAULTS are the same values: a policy written before these
  // columns existed reads back with them.
  mode: text('mode').$type<'live' | 'shadow'>().notNull().default('live'),
  priceIncreaseMaxPct: integer('price_increase_max_pct').notNull().default(100),
  maxPaymentsPerMinute: integer('max_payments_per_minute').notNull().default(10),
  requireMandate: integer('require_mandate', { mode: 'boolean' }).notNull().default(false),
  /** CR-021. Null trades nothing. */
  trading: text('trading', { mode: 'json' }).$type<TradingPolicy>(),
  updatedAt: text('updated_at').notNull(),
})

/**
 * What an agent last paid each x402 domain. A later 402 from the same domain that names another
 * payee, chain or token, or a much higher price, is the shape of a compromised or swapped API, so
 * it goes to the owner even when the amount alone would not.
 */
export const x402Pins = sqliteTable(
  'x402_pins',
  {
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    domain: text('domain').notNull(),
    chain: text('chain').$type<ChainId>().notNull(),
    token: text('token').$type<Address>().notNull(),
    recipient: text('recipient').$type<Address>().notNull(),
    amount: text('amount').$type<Amount>().notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.domain] })],
)

export const intents = sqliteTable(
  'intents',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    kind: text('kind').$type<PayIntentKind>().notNull(),
    chain: text('chain').$type<ChainId>().notNull(),
    token: text('token').$type<Address>().notNull(),
    amount: text('amount').$type<Amount>().notNull(),
    recipient: text('recipient').$type<Address>().notNull(),
    domain: text('domain'),
    /** Agent-provided. Stored so the owner sees it, never read back into a decision. */
    reason: text('reason').notNull(),
    status: text('status').$type<IntentStatus>().notNull(),
    rejectReasons: text('reject_reasons', { mode: 'json' }).$type<RejectCode[]>().notNull(),
    txId: text('tx_id'),
    /** The task budget this payment counts against, if any. */
    mandateId: text('mandate_id'),
    /** CR-021, kind swap only. */
    swap: text('swap', { mode: 'json' }).$type<SwapDetails>(),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
  },
  (t) => [
    index('intents_agent_status').on(t.agentId, t.status),
    /** The expiry sweep scans this; without it every pass is a full table read. */
    index('intents_expires_at').on(t.expiresAt),
  ],
)

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    at: text('at').notNull(),
    intentId: text('intent_id').references(() => intents.id),
    agentId: text('agent_id'),
    /** policy_evaluated | simulated | signed | sent | owner_decision | expired | paused | killed */
    event: text('event').notNull(),
    decision: text('decision').$type<PolicyDecision>(),
    reasons: text('reasons', { mode: 'json' }).$type<RejectCode[]>(),
    /** Anything chain- or event-specific. Never a key, a token or a full header. */
    detail: text('detail', { mode: 'json' }),
  },
  (t) => [index('audit_log_intent').on(t.intentId), index('audit_log_at').on(t.at)],
)

/**
 * Kept per chain so the offchain total can be reconciled against each chain's onchain cap, which is
 * enforced separately. The policy's dailyMax applies to the sum across chains.
 */
export const dailySpend = sqliteTable(
  'daily_spend',
  {
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    chain: text('chain').$type<ChainId>().notNull(),
    /** UTC calendar day, YYYY-MM-DD. The onchain caps reset on their own schedule. */
    day: text('day').notNull(),
    spent: text('spent')
      .$type<Amount>()
      .notNull()
      .default(sql`'0'`),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.chain, t.day] })],
)

/**
 * One row per payment cleared to be signed, for the breaker's rolling minute. Keyed by intent, so
 * a payment cleared twice (asked of the owner, then redeemed) counts once. In the database rather
 * than in memory, so a restart does not hand a runaway agent a fresh minute.
 */
export const clearedPayments = sqliteTable(
  'cleared_payments',
  {
    intentId: text('intent_id')
      .primaryKey()
      .references(() => intents.id),
    agentId: text('agent_id').notNull(),
    at: text('at').notNull(),
  },
  (t) => [index('cleared_payments_agent_at').on(t.agentId, t.at)],
)

/**
 * A budget for one task, inside the policy. A payment that names one must also fit it, and its
 * spend is counted here as well as in the day's total.
 */
export const mandates = sqliteTable(
  'mandates',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    budget: text('budget').$type<Amount>().notNull(),
    spent: text('spent')
      .$type<Amount>()
      .notNull()
      .default(sql`'0'`),
    domains: text('domains', { mode: 'json' }).$type<string[]>().notNull(),
    recipients: text('recipients', { mode: 'json' }).$type<Address[]>().notNull(),
    /** Agent-provided. Shown to the owner, never read back into a decision. */
    reason: text('reason').notNull(),
    status: text('status').$type<Mandate['status']>().notNull(),
    /** How long it runs once active. The clock starts when the owner approves, not when asked. */
    ttlSeconds: integer('ttl_seconds').notNull(),
    createdAt: text('created_at').notNull(),
    /** While pending, the owner's deadline; once active, the end of the task. */
    expiresAt: text('expires_at').notNull(),
  },
  (t) => [
    index('mandates_agent_status').on(t.agentId, t.status),
    index('mandates_expires_at').on(t.expiresAt),
  ],
)

/**
 * What cleared a payment, kept for its receipt: a hash of the policy in force, the simulation's
 * summary, and who approved it. Written at clearance, because by the time the payment executes the
 * policy may have changed.
 */
export const clearances = sqliteTable('clearances', {
  intentId: text('intent_id')
    .primaryKey()
    .references(() => intents.id),
  policyHash: text('policy_hash').notNull(),
  simulation: text('simulation').notNull(),
  approvedBy: text('approved_by').$type<Receipt['approvedBy']>().notNull(),
})

/** How the owner approved an intent: by a Telegram tap, or with a passkey. */
export const ownerApprovals = sqliteTable('owner_approvals', {
  intentId: text('intent_id')
    .primaryKey()
    .references(() => intents.id),
  method: text('method').$type<'owner' | 'passkey'>().notNull(),
})

/** One signed receipt per executed intent. */
export const receipts = sqliteTable(
  'receipts',
  {
    intentId: text('intent_id')
      .primaryKey()
      .references(() => intents.id),
    issuedAt: text('issued_at').notNull(),
    body: text('body', { mode: 'json' }).$type<Receipt>().notNull(),
  },
  (t) => [index('receipts_issued_at').on(t.issuedAt)],
)

/** The owner's passkeys. Only the public key is kept; the private one never leaves the device. */
export const passkeys = sqliteTable('passkeys', {
  /** The credential id, base64url. */
  id: text('id').primaryKey(),
  /** COSE public key, base64url. */
  publicKey: text('public_key').notNull(),
  /** The authenticator's signature counter; a step backwards hints at a cloned key. */
  counter: integer('counter').notNull(),
  transports: text('transports', { mode: 'json' }).$type<string[]>().notNull(),
  createdAt: text('created_at').notNull(),
  lastUsedAt: text('last_used_at'),
})

/**
 * Outstanding WebAuthn challenges, each for one purpose: enrolling a passkey, or approving one
 * intent. Taken once and deleted, so an assertion cannot be replayed.
 */
export const passkeyChallenges = sqliteTable('passkey_challenges', {
  /** `registration`, or the intent id the approval is for. */
  purpose: text('purpose').primaryKey(),
  challenge: text('challenge').notNull(),
  expiresAt: text('expires_at').notNull(),
})

/**
 * One-time codes that let the owner enrol a passkey from the public page. Only the SHA-256 of a
 * code is kept, so the table cannot be read back into a working link.
 */
export const enrolCodes = sqliteTable('enrol_codes', {
  hash: text('hash').primaryKey(),
  expiresAt: text('expires_at').notNull(),
})

/** An owner's signed-in panel session (CR-012). The cookie holds the token; only its hash is here. */
export const ownerSessions = sqliteTable('owner_sessions', {
  tokenHash: text('token_hash').primaryKey(),
  /** The passkey that signed in, so a removed passkey's sessions can be ended. */
  passkeyId: text('passkey_id').notNull(),
  createdAt: text('created_at').notNull(),
  lastSeenAt: text('last_seen_at').notNull(),
  /** Twelve hours after sign-in, however active the session. */
  expiresAt: text('expires_at').notNull(),
})

/**
 * What the owner was asked, kept so the panel can show it (CR-012): the bot gets it once, the
 * panel reads it on every visit. Pruned once its approval deadline has passed.
 */
export const approvalRequests = sqliteTable('approval_requests', {
  /** The intent's id, or the mandate's. */
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['intent', 'mandate'] }).notNull(),
  body: text('body', { mode: 'json' }).notNull(),
  approveBefore: text('approve_before').notNull(),
})

/** The owner's browsers that get Web Push (CR-012). The keys are the browser's, public by design. */
export const pushSubscriptions = sqliteTable('push_subscriptions', {
  id: text('id').primaryKey(),
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  createdAt: text('created_at').notNull(),
})

/**
 * CR-013: one row per tool call or payment, in one hash chain. Hashes and metadata only: the
 * arguments and results never reach guard-core's database.
 */
export const executions = sqliteTable(
  'executions',
  {
    seq: integer('seq').primaryKey(),
    prevHash: text('prev_hash').notNull(),
    agentId: text('agent_id').notNull(),
    kind: text('kind', { enum: ['tool_call', 'payment'] }).notNull(),
    server: text('server').notNull(),
    tool: text('tool').notNull(),
    requestHash: text('request_hash').notNull(),
    responseHash: text('response_hash').notNull(),
    outcome: text('outcome', { enum: ['ok', 'error', 'refused'] }).notNull(),
    assurance: text('assurance', { enum: ['executed', 'relayed'] }).notNull(),
    paymentReceipt: text('payment_receipt'),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at').notNull(),
    issuedAt: text('issued_at').notNull(),
    hash: text('hash').notNull().unique(),
    signature: text('signature').notNull(),
  },
  (t) => [index('executions_agent_issued').on(t.agentId, t.issuedAt)],
)

/** CR-013: a Merkle root over receipts fromSeq..toSeq, as published in one transaction. */
export const anchors = sqliteTable('anchors', {
  fromSeq: integer('from_seq').primaryKey(),
  toSeq: integer('to_seq').notNull().unique(),
  root: text('root').notNull(),
  chain: text('chain').notNull(),
  txId: text('tx_id').notNull(),
  anchoredAt: text('anchored_at').notNull(),
})

/**
 * CR-019: what the owner set in the panel for a chain. Used only where the env leaves the value
 * unset, and a vault only once guard-core has read on chain that it names this hot wallet.
 */
export const chainSettings = sqliteTable('chain_settings', {
  chain: text('chain').primaryKey(),
  rpcUrl: text('rpc_url'),
  vault: text('vault'),
  updatedAt: text('updated_at').notNull(),
})

/**
 * CR-021: a day's buys per agent, counted against dailyTradeMax and never against dailyMax.
 * Counted when the swap is signed, as payments are.
 */
export const dailyTrades = sqliteTable(
  'daily_trades',
  {
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    chain: text('chain').$type<ChainId>().notNull(),
    day: text('day').notNull(),
    bought: text('bought')
      .$type<Amount>()
      .notNull()
      .default(sql`'0'`),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.chain, t.day] })],
)

/**
 * CR-021: what each agent holds of a token, from its executed swaps, and what it paid, in the
 * chain's dollar. A sell takes the cost down in proportion to the amount sold.
 */
export const positions = sqliteTable(
  'positions',
  {
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    chain: text('chain').$type<ChainId>().notNull(),
    token: text('token').$type<Address>().notNull(),
    amount: text('amount').$type<Amount>().notNull(),
    cost: text('cost').$type<Amount>().notNull(),
    /** From the mint onchain, never a venue's list. */
    decimals: integer('decimals').notNull(),
    /** Display only, untrusted. */
    symbol: text('symbol'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.chain, t.token] })],
)

/**
 * CR-022: the request an x402 intent was for, as the SHA-256 of its method, full URL with query and
 * body. An approval is redeemed only by the same request; another one is a new intent.
 */
export const x402Requests = sqliteTable('x402_requests', {
  intentId: text('intent_id').primaryKey(),
  requestHash: text('request_hash').notNull(),
})

/**
 * An agent's own hot wallet on one chain (CR-022). The key is on disk; the address is kept so the
 * panel, /sign and the kill can name it without reading the key. "active" once its limit was read
 * onchain: only then are the agent's payments routed through it.
 */
export const agentWallets = sqliteTable(
  'agent_wallets',
  {
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    chain: text('chain').$type<ChainId>().notNull(),
    address: text('address').notNull(),
    status: text('status').$type<AgentWalletStatus>().notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.chain] })],
)
