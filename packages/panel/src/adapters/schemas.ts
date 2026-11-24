import { z } from 'zod'

/**
 * guard-core's owner responses. Same-origin and behind a session, but the strings inside started
 * with an agent or a 402 server, so they are bounded here and only ever set as text.
 */

const atomic = z.string().regex(/^(0|[1-9]\d*)$/)
const isoTime = z.iso.datetime({ offset: true })
const text = (max: number) => z.string().max(max)
const agentId = z.string().min(1).max(64)
const bps = z.number().int().min(0).max(10_000)
/** A mint's decimals, read onchain: an SPL mint stores them in one byte. */
const decimals = z.number().int().min(0).max(255)

export const allowance = z
  .discriminatedUnion('status', [
    z.object({ status: z.literal('active'), cap: atomic, spent: atomic, resetsAt: isoTime }),
    z.object({ status: z.literal('none') }),
  ])
  .nullable()

/** CR-025: what Jupiter says about a token, labelled as the venue's. Untrusted display text. */
const venue = z.object({
  holders: z.number().int().nonnegative().optional(),
  // A decimal string, as the venue reports it: display only, never used in a decision.
  liquidityUsd: z
    .string()
    .regex(/^\d{1,20}(\.\d{1,2})?$/)
    .optional(),
  organicScore: z.number().nonnegative().optional(),
  createdAt: isoTime.optional(),
})

export const tokenInfo = z.object({
  chain: text(64),
  mint: text(128),
  symbol: text(32),
  name: text(64),
  decimals: z.number().int().min(0).max(255),
  verified: z.boolean(),
  venue,
})

export const tokens = z.object({ tokens: z.array(tokenInfo).max(50) })

/** CR-025: read onchain by guard-core, except venue. */
export const tokenRisk = z.object({
  chain: text(64),
  mint: text(128),
  decimals: z.number().int().min(0).max(255),
  freezeAuthority: z.boolean(),
  mintAuthority: z.boolean(),
  extensions: z.array(text(64)).max(32),
  risks: z.array(text(64)).max(16),
  flags: z.array(text(64)).max(8),
  exit: z.object({ amountUsd: atomic, priceImpactBps: bps }).nullable(),
  venue: venue.extend({ verified: z.boolean() }),
})

export const swapQuote = z.object({
  venue: text(64),
  tokenIn: text(128),
  amountIn: atomic,
  tokenOut: text(128),
  expectedOut: atomic,
  minAmountOut: atomic,
  slippageBps: bps,
  priceImpactBps: bps,
  exitImpactBps: bps.nullable(),
  decimalsIn: z.number().int().min(0).max(255).optional(),
  decimalsOut: z.number().int().min(0).max(255).optional(),
  symbolIn: text(32).optional(),
  symbolOut: text(32).optional(),
  risks: z.array(text(64)).max(16),
  flags: z.array(text(64)).max(8),
  quotedAt: isoTime,
})

export const tradeResult = z.object({
  intentId: z.uuid(),
  status: text(32),
  rejectReasons: z.array(text(64)).max(32),
  txId: text(128).optional(),
})

/** SPEC v0.17, CR-022: an agent's own hot wallet on one chain, opt-in. */
export const agentWallet = z.object({
  chain: text(64),
  address: text(128),
  status: z.enum(['pending_limit', 'active']),
  addLimitPage: text(2048).optional(),
  gas: z.object({ balance: atomic, minimum: atomic, symbol: text(16) }).optional(),
})

export const agentWallets = z.object({ wallets: z.array(agentWallet).max(16) })

export const agentSummary = z.object({
  agentId,
  paused: z.boolean(),
  mode: z.enum(['live', 'shadow']),
})

export const intent = z.object({
  id: z.uuid(),
  agentId,
  kind: z.enum(['x402', 'transfer', 'swap']),
  chain: text(64),
  token: text(128),
  amount: text(78),
  recipient: text(128),
  domain: text(253).optional(),
  reason: text(500),
  status: text(32),
  swap: z
    .object({
      venue: text(64),
      tokenOut: text(128),
      minAmountOut: atomic,
      slippageBps: bps,
      priceImpactBps: bps,
      quotedAt: isoTime,
      decimalsIn: decimals,
      decimalsOut: decimals,
      symbolIn: text(32).optional(),
      symbolOut: text(32).optional(),
    })
    .optional(),
  expiresAt: isoTime,
})

export const approvalRequest = z.object({
  intent,
  simulation: z.object({ summary: text(1000) }),
  approveBefore: isoTime,
  flags: z.array(text(64)).max(8).default([]),
  pinned: z.object({ recipient: text(128), amount: atomic }).optional(),
})

export const mandate = z.object({
  id: z.uuid(),
  agentId,
  budget: atomic,
  spent: atomic,
  domains: z.array(text(253)).max(64),
  recipients: z.array(text(128)).max(64),
  reason: text(500),
  status: text(32),
  expiresAt: isoTime,
})

export const mandateRequest = z.object({
  mandate,
  approveBefore: isoTime,
  ttlSeconds: z.number().int().positive().optional(),
})

export const overview = z.object({
  chains: z.array(z.object({ chain: text(64), allowance })).max(16),
  agents: z.array(agentSummary).max(1000),
  pending: z.array(approvalRequest).max(500),
  mandates: z.array(mandateRequest).max(500),
})

export const policy = z.object({
  agentId,
  chains: z.array(text(64)).max(16),
  tokens: z.array(text(128)).max(32),
  perTxMax: atomic,
  dailyMax: atomic,
  approvalThreshold: atomic,
  allowedRecipients: z.array(text(128)).max(256),
  allowedDomains: z.array(text(253)).max(256),
  paused: z.boolean(),
  mode: z.enum(['live', 'shadow']).optional(),
  priceIncreaseMaxPct: z.number().optional(),
  maxPaymentsPerMinute: z.number().optional(),
  requireMandate: z.boolean().optional(),
  trading: z
    .object({
      enabled: z.boolean(),
      venues: z.array(text(64)).max(16),
      tokens: z.array(text(128)).max(256),
      allowAnyToken: z.boolean(),
      maxTradeUsd: atomic,
      dailyTradeMax: atomic,
      maxPositionUsd: atomic,
      maxSlippageBps: bps,
      maxPriceImpactBps: bps,
    })
    .optional(),
})

/** CR-021, one owner read for every agent; amount is in the token's base units, cost in dollars. */
export const portfolio = z.object({
  agents: z
    .array(
      z.object({
        agentId,
        positions: z
          .array(
            z.object({
              chain: text(64),
              token: text(128),
              amount: atomic,
              cost: atomic,
              decimals,
              symbol: text(32).optional(),
            }),
          )
          .max(256),
        tradedToday: atomic,
        dailyTradeMax: atomic,
      }),
    )
    .max(1000),
})

/** CR-021: the sells the close started, one intent per token, each through the usual checks. */
export const closed = z.object({ intents: z.array(intent).max(256) })

export const budget = z.object({
  spentToday: atomic,
  dailyMax: atomic,
  perTxMax: atomic,
  paused: z.boolean(),
  shadowSpentToday: atomic.optional(),
  shadow: z
    .object({
      since: isoTime,
      total: atomic,
      count: z.number().int(),
      // GC-68: how often live would have asked the owner, and the flags behind it.
      asked: z
        .object({ count: z.number().int().nonnegative(), flags: z.array(text(64)).max(16) })
        .optional(),
    })
    .optional(),
})

export const report = z.object({
  agents: z
    .array(
      z.object({
        agentId,
        spent: atomic,
        payments: z.number().int().nonnegative(),
        refused: z.record(text(64), z.number().int().nonnegative()),
        domains: z.array(z.object({ domain: text(253), spent: atomic })).max(500),
      }),
    )
    .max(1000),
})

export const doctor = z.object({
  checks: z
    .array(
      z.object({
        // CR-022 names an agent's own wallet in the id: chain, agent and check.
        id: text(256),
        status: z.enum(['ok', 'warn', 'fail']),
        message: text(2000),
        fix: text(2000).optional(),
      }),
    )
    .max(64),
})

export const passkeys = z.object({
  passkeys: z
    .array(z.object({ id: text(256), createdAt: isoTime, lastUsedAt: isoTime.nullish() }))
    .max(64),
})

const https = z.url({ protocol: /^https$/ })

/**
 * payload is the transaction the owner signs, null when guard-core could not build it. link (the
 * Phantom app) and pageLink (the signing page on a desktop) are not in SPEC yet: shown when present.
 */
export const kill = z.object({
  pausedAgents: z.number().int().nonnegative(),
  ownerTransactions: z
    .array(
      z.object({
        chain: text(64),
        description: text(2000),
        payload: z.unknown(),
        link: https.optional(),
        pageLink: https.optional(),
        // CR-022: the agent whose own wallet this limit belongs to; absent for the shared one.
        wallet: z.object({ agentId, address: text(128) }).optional(),
      }),
    )
    .max(16),
})

export const agents = z.object({ agents: z.array(agentSummary).max(1000) })
const hex = (length: number) => z.string().regex(new RegExp(`^[0-9a-f]{${length}}$`))
const seq = z.number().int().positive()

/**
 * CR-013. Loose objects: a proof bundle is downloaded as guard-core sent it, and a field this panel
 * does not know yet still counts in the receipt's hash.
 */
export const receipt = z.looseObject({
  seq,
  agentId,
  kind: z.enum(['tool_call', 'payment']),
  server: text(128),
  tool: text(128),
  outcome: z.enum(['ok', 'error', 'refused']),
  assurance: z.enum(['executed', 'relayed']),
  startedAt: isoTime,
  endedAt: isoTime,
  hash: hex(64),
  paymentReceipt: hex(64).optional(),
})

export const anchor = z.looseObject({
  fromSeq: seq,
  toSeq: seq,
  root: hex(64),
  chain: text(64),
  txId: text(128),
  anchoredAt: isoTime,
})

export const executions = z.object({ receipts: z.array(receipt).max(10_000) })

/** CR-010 receipts, kept raw: their hash is matched against what each payment execution names. */
export const paymentReceipts = z.object({ receipts: z.array(z.unknown()).max(10_000) })

export const integrity = z.object({
  lastSeq: z.number().int().nonnegative(),
  lastHash: text(64),
  brokenAt: seq.optional(),
  lastAnchor: anchor.optional(),
})

export const proof = z.looseObject({
  receipt,
  siblings: z.array(z.object({ side: z.enum(['left', 'right']), hash: hex(64) })).max(64),
  anchor,
})

/** CR-019. The setup routes; a vault or RPC the owner never set is absent. */
export const setup = z.object({ needsSetup: z.boolean() })
// Any scheme: the panel follows it only to its own origin, which is http on a local guard-core.
export const enrolLink = z.object({ enrolLink: z.url() })
export const progress = z.object({
  steps: z.array(z.object({ id: text(32), done: z.boolean() })).max(32),
})
export const settingsView = z.object({
  chains: z
    .array(z.object({ chain: text(64), rpcUrl: text(512).optional(), vault: text(128).optional() }))
    .max(16),
})
export const keys = z.object({
  hotWallets: z.array(z.object({ chain: text(64), address: text(128) })).max(16),
  receiptKey: text(512),
  anchorKey: text(512).optional(),
})
export const deposit = z.object({
  chains: z
    .array(
      z.object({
        chain: text(64),
        vault: text(128),
        token: text(128),
        balance: atomic,
        dailyCap: atomic.optional(),
        depositPage: https.optional(),
      }),
    )
    .max(16),
})

export const created = z.object({ agentId, token: z.string().min(16).max(512) })
export const session = z.object({ expiresAt: isoTime })
export const pushKey = z.object({ publicKey: z.string().regex(/^[A-Za-z0-9_-]+$/) })
export const pushId = z.object({ id: text(128) })
export const problem = z.object({ error: text(64) })

export type Overview = z.infer<typeof overview>
export type ApprovalView = z.infer<typeof approvalRequest>
export type MandateView = z.infer<typeof mandateRequest>
export type AgentView = z.infer<typeof agentSummary>
export type AgentWalletView = z.infer<typeof agentWallet>
export type TokenInfo = z.infer<typeof tokenInfo>
export type TokenRiskView = z.infer<typeof tokenRisk>
export type QuoteView = z.infer<typeof swapQuote>
export type PolicyView = z.infer<typeof policy>
export type BudgetView = z.infer<typeof budget>
export type KillView = z.infer<typeof kill>
export type PortfolioView = z.infer<typeof portfolio>['agents'][number]
export type ReceiptView = z.infer<typeof receipt>
export type IntegrityView = z.infer<typeof integrity>
export type SettingsView = z.infer<typeof settingsView>
export type DepositView = z.infer<typeof deposit>['chains'][number]
