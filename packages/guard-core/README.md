# @defimind/guard-core

The guard service, and the only component that holds the hot wallet key. It checks every payment
against the policy, simulates it, asks the owner when needed, and only then signs.

- **Source of truth:** [`/SPEC.md`](../../SPEC.md): HTTP API, reject codes and the webhook contract.

## Run it

```bash
cp .env.example .env                 # fill it in; never commit .env
pnpm --filter @defimind/guard-core create-agent my-agent   # prints the agent token once
pnpm --filter @defimind/guard-core dev                     # API on 127.0.0.1:8787
```

A new agent's policy is empty and in shadow mode, so it pays nothing until the owner opens its
policy and switches it to `mode: "live"` in the panel, with the passkey step-up. The admin API
below only tightens (CR-022):

- `POST /v1/admin/agents { agentId }` returns `{ agentId, token }`. The token is shown once; only its
  hash is kept. 409 `{ error: "exists" }` for a taken id.
- `GET /v1/admin/agents` lists the agents with a working token, with `paused` and `mode`.
- `POST /v1/admin/agents/:id/revoke` cuts one off at its next request.
- `GET /v1/admin/doctor` checks, in plain English and never quoting a URL, key or token: the
  database accepts a write (undone at once), each chain's onchain limit is readable and in place,
  each hot wallet's gas is above its minimum and its token balance, the bot answers, and the newest
  backup is under two days old. Each warning or failure says what to do.

The budget routes add `shadow: { since, total, count }` for an agent that ran in shadow mode: what
it would have spent since its first shadowed payment, and how many payments that was.

`pnpm --filter @defimind/guard-core revoke-agent my-agent` revokes an agent's token. It stops
working on its next request, on every agent route. The agent's intents and audit history stay.

The API listens on `127.0.0.1` unless `HOST` is set. `PUBLIC_PORT` splits it into a public listener
for the agent routes and a private one for the admin and bot routes (see Deploy on Fly.io).

For Solana, set `SOLANA_HOT_WALLET_KEYPAIR`, `SOLANA_RPC_URL` and `SQUADS_MULTISIG`; guard-core
builds onchain's adapter from them. For Base, set `BASE_CHAIN` (`eip155:84532` or `eip155:8453`) with
`BASE_RPC_URL`, `SAFE_ADDRESS`, `BASE_HOT_WALLET_KEY_FILE` and, until `shared/addresses.ts` has
verified values, `BASE_USDC` and `BASE_ALLOWANCE_MODULE`. A chain switched on with a value missing
stops the start, naming the missing variables and never their values. For Robinhood Chain (CR-007),
set `ROBINHOOD_CHAIN` (`eip155:46630` or `eip155:4663`) with `ROBINHOOD_RPC_URL`,
`ROBINHOOD_SAFE_ADDRESS` and `ROBINHOOD_HOT_WALLET_KEY_FILE`. Its dollar is Paxos's USDG, taken from
`shared/addresses.ts` only, so no env value can name another token there.

On every EVM chain, guard-core asks the chain before building the adapter: the Safe, the token and
the module must each hold a contract, and the token must report 6 decimals. Verified addresses are
asked too, so an RPC URL for the wrong chain fails at startup. If any check fails, or the RPC cannot
be reached, it refuses to start. Every configured chain runs at once.

To run offline instead, set `GUARD_STUB_CHAINS=true`: nothing
is signed and no money moves. With neither, there is no adapter and every payment is refused.

## Pipeline

Both payment routes run the same steps, in `src/service/payments.ts`:

```
build PayIntent -> policy -> simulation -> [owner on Telegram] -> top up hot wallet -> sign/send
```

Every step writes to `audit_log`. Default deny throughout: an intent starts as `rejected` and only
the pipeline moves it on.

- **Policy** (`domain/policy.ts`) reports every broken rule, not just the first. A chain with no
  adapter counts as `CHAIN_NOT_ALLOWED`.
- **Simulation** calls `ChainAdapter.simulate`. Any reject code from the adapter refuses the
  payment, a simulation that throws is `SIM_FAILED`, and a simulation in which the wallet loses more
  of the token than the intent pays is `SIM_UNEXPECTED_EFFECT` on every chain.
- **Policy fields with defaults**: `mode` (`live`), `priceIncreaseMaxPct` (100),
  `maxPaymentsPerMinute` (10) and `requireMandate` (false). A `PUT` that leaves one out keeps the
  stored value, and a policy that never set one has the default. So a client that predates a field
  cannot reset it, and cannot switch a shadow agent live by omission. The `PUT` answers with the
  policy as stored.
- **Shadow mode** (`mode: "shadow"`): policy, pinning and simulation run as usual, then the intent
  is recorded as `shadowed` and stops there. Nothing is funded or signed, the owner is not asked,
  and an x402 fetch gets the unpaid 402 back. The daily max is held against what shadow mode would
  have spent, and both budget routes report it as `shadowSpentToday`, so the owner can watch an
  agent's habits before giving it money.
- **Breaker**: the payment that would make more than `maxPaymentsPerMinute` in a rolling minute is
  refused with `BREAKER_TRIPPED`, the agent is paused, and `POST {BOT_URL}/hooks/alert` tells the
  owner. It stays paused until the owner resumes it. Only payments about to be signed count, each
  once, and the window is kept in the database so a restart does not reset it. Resuming the agent
  clears its window. Shadow mode does not
  trip it: nothing it counts ever happened.
- **Owner approval**: at or above `approvalThreshold`, the intent is saved as `pending_approval`
  before the webhook goes out. Approval answers the threshold only: policy and simulation run again
  right before anything is sent, so a pause or a spent budget in the meantime still refuses it.
- **Top-up**: if the hot wallet holds less than the payment, the shortfall is pulled with
  `ChainAdapter.topUpHotWallet`, under the onchain cap.
- **Spend** is counted once a signed transaction leaves our hands, whether or not we hear that it
  landed. Overcounting only shrinks the day's budget; undercounting would let the agent past it.

The agent routes carry two rate limits, checked before the token is looked up: per IP
(`RATE_LIMIT_PER_IP`, 120 a minute) and per agent token (`RATE_LIMIT_PER_AGENT`, 60 a minute), so
neither many tokens from one address nor one token from many addresses gets past. Admin and bot
routes keep the per-IP limit. A limited request gets 429 with `retry-after`.

Payments for one agent run one at a time, so two concurrent requests cannot both pass the daily
max against the same total.

### `POST /v1/agent/transfer`

Sent at once when cleared. Over the threshold it returns `pending_approval`; the owner's approval
sends it from `POST /v1/bot/decision`, which returns the final intent.

### `POST /v1/agent/x402/fetch`

1. The URL's host must be in `allowedDomains` before the guard contacts it at all, so the guard
   cannot be pointed at internal hosts. Redirects are not followed. Payment headers the agent
   supplies are dropped.
2. A response other than 402 is passed through with no intent.
3. The `PAYMENT-REQUIRED` header is decoded with `@x402/core` and validated with zod. Only x402
   version 2 and scheme `exact` are accepted. `chooseAccept` picks the first offer within the policy
   and the agent's `maxAmount`.
4. Policy, pinning, simulation, approval and top-up as above. Over the threshold it returns
   `pending_approval` at once. Once the owner approves, the agent repeats the same request and the
   approval is redeemed, once, for exactly those terms. Unused approvals expire with the sweep.
5. The payment is built by the SDK through `ChainAdapter.x402Scheme` (CR-003), whose signer is
   bound to the intent: onchain inspects and simulates the exact message first and throws
   `SigningRefused` for anything but that one transfer, which guard-core records as `rejected`.
   The SDK's own spend control is set to the intent's amount as a second lock.
6. The request is retried with `PAYMENT-SIGNATURE`. A second 402 with different terms is
   `INVALID_402`. The paid response is returned as untrusted content.

**Pinning.** Each executed payment pins (and, on upgrade, a migration pins each domain from the
latest payment already made), per agent and domain, the chain, token, payee and amount
(table `x402_pins`). A later 402 from that domain that names another payee, chain or token
(`RECIPIENT_CHANGED`), or asks more than `priceIncreaseMaxPct` above the pinned amount
(`PRICE_JUMP`, default 100, so up to double passes), goes to the owner even below the threshold, with
`flags` on the approval request. That is what a compromised or swapped API looks like from here. The
owner's approval re-pins; a rejection keeps the old pin, so the same request is asked again. The
first payment to a domain has no pin to compare with and is judged by the policy alone.

A 402 that is refused before an offer qualifies is still recorded, with any field the server sent
missing or unreadably as `unknown` (an unreadable amount as `0`), so the bot can show it.

The reason shown to the owner is the method and URL without the query string, which often carries
the API's own credentials.

### Admin

`POST /v1/admin/kill` pauses every agent first, then returns
`{ pausedAgents, ownerTransactions: { chain, description, payload }[] }`, one entry per chain's
`buildKillTx()` (CR-004). A chain that cannot build its transaction stays in the list with
`payload: null` and a description telling the owner to remove its spend limit by hand; the pause
holds regardless.

`GET /v1/admin/chains` lists every chain guard-core runs, each with its onchain allowance (CR-006).
The allowance is `{ status: 'none' }` when the chain shows no limit at all, as after a kill
(CR-008), and `null` only when reading it failed. An empty list means every payment is refused.

Both budget routes carry `chains`: the chains guard-core runs that this agent's policy also allows,
so an agent learns where it can pay and nothing more of the setup.

`GET /v1/admin/budget/:agentId` returns the same view as the agent's own budget route, for the bot,
which holds no agent token.

### Mandates

A mandate is a budget for one task, inside the policy: its domains and recipients must already be
allowed, its budget is at most the daily max, and it lives 60 seconds to a day (`ttlSeconds`).

- `POST /v1/agent/mandates`: below `approvalThreshold` it starts `active`. At or above it, it is
  `pending_approval` and goes to the owner on the approval-request hook as `{ mandate, simulation,
approveBefore }`, with no intent. The bot answers at `POST /v1/bot/mandates/:id/decision`: 409
  once decided, 410 after the same ten minutes as a payment. Its time starts at the approval.
- `POST /v1/admin/mandates` opens one that starts active; `POST /v1/admin/mandates/:id/revoke`
  ends one. Both admin routes are the owner's.
- A transfer or x402 fetch with `mandateId` must fit the mandate as well as the policy:
  `MANDATE_EXCEEDED` above what is left (or once it is used up), `MANDATE_EXPIRED` when it is not
  active or its time is over, and the recipient or domain must be the mandate's. With
  `requireMandate`, a payment without one is `MANDATE_REQUIRED`, as is an unknown id or another
  agent's.
- Spend is added to the mandate at the same moment as to the day's total, under the agent's lock.
  At its budget it becomes `exhausted`. The sweep expires mandates, and the budget routes list the
  active ones.

A mandate wider than the policy is refused with 422 `{ error: "outside_policy", rejectReasons }`.

### Report

`GET /v1/admin/report?from&to` (ISO times; the last seven days by default, a year at most) returns
every agent, a quiet one included (a revoked one only if it had intents in the period), with what its executed payments spent (the sum in base units of
each chain's dollar, USDC or USDG, all with 6 decimals), how many there were,
every refusal counted by code, and the spend per x402 domain, biggest first.

### Receipts

With `RECEIPT_SIGNING_KEY_FILE`, an Ed25519 private key in PEM that is separate from every hot
wallet key and made at start when unset (CR-019), each executed payment gets a signed receipt: the intent, the SHA-256 of the canonical
JSON of the policy it cleared under, the simulation summary, who approved it (`policy`, `owner` or
`passkey`) and the time. The signature covers the canonical JSON of all of that: keys sorted at
every depth, no whitespace. The policy, simulation and approver are recorded when the payment
clears, because the policy may change before it executes.

- `GET /v1/agent/intents/:id/receipt`: 404 until the intent has executed, and for another agent's.
- `GET /v1/admin/receipts?from&to`: the same period rules as the report.
- `GET /v1/receipts/key` on both listeners, without a token: `{ publicKey }`, the raw 32-byte key in
  hex, so anyone holding a receipt can check it without trusting this server.

Without the key, receipts are off and nothing else changes. Generate one with
`openssl genpkey -algorithm ed25519 -out receipt.pem`. On Fly it is the `RECEIPT_SIGNING_KEY`
secret, which the entrypoint moves to tmpfs like the hot keys.

### The panel and Telegram

- guard-core serves the panel's static build at `/panel/` on the public listener, from
  `packages/panel/dist` or `PANEL_DIR`. Run `pnpm --filter @defimind/panel build` first.
  - `/panel` redirects (308) to `/panel/`.
  - Only the build's own files are read from disk, by a fixed list of names. Any other path under
    `/panel/` gets `index.html`, and the app routes itself.
  - Every response carries the SPEC CSP, `nosniff`, `X-Frame-Options: DENY` and HSTS.
  - `index.html` and `sw.js` are always revalidated. The other files are cached for a day: their
    names carry no hash, so a longer cache would keep an old `app.js` next to a new page.
- `TELEGRAM_APPROVALS` (default `false`): while false, `/v1/bot/decision` and
  `/v1/bot/mandates/:id/decision` refuse `approve` with 403 `approve_in_panel` and still take
  `reject`. Approving is then a passkey in the panel, and a stolen Telegram account moves nothing.
- `pnpm --filter @defimind/guard-core passkey-code` prints `{PASSKEY_ORIGIN}/panel/enrol#code=…`,
  the link that enrols the owner's first passkey. The code is good for one enrolment within ten
  minutes, sits in the fragment so no server log sees it, and its issue is audited.

### Verified execution (CR-013)

With the receipt key (`RECEIPT_SIGNING_KEY_FILE`), guard-core keeps one hash chain of
`ExecutionReceipt`s per deployment: one entry per tool call an agent reports, and one per payment.

- `POST /v1/agent/executions { server, tool, requestHash, responseHash, outcome, startedAt, endedAt }`
  returns the signed receipt. It is called with the agent token, and the agent comes from the token.
  The hashes are hex SHA-256: guard-core never sees or stores the arguments or the result. Without
  the receipt key the answer is 409 `receipts_not_configured`.
- **What a receipt is worth** is in `assurance`, and should be read as written:
  - `executed`: guard-core made the payment itself. An executed payment's receipt points to its
    payment receipt by `paymentReceipt`, the SHA-256 of that receipt's canonical JSON.
  - `relayed`: a gateway or the SDK reported the call. guard-core vouches for when it heard of it
    and that the record has not changed since. It does not vouch for what the tool really did.
- Every receipt has `seq` (1, 2, 3… with no gap), `prevHash` (the previous receipt's hash, 64 zeros
  for the first) and `hash`, the SHA-256 of the canonical JSON of every other field. `signature`
  is Ed25519 over the same bytes, with the key `GET /v1/receipts/key` serves. The last link is read
  and the next written in one synchronous transaction, so two appends at once cannot fork the chain.
- **Anchoring.** Given an anchor publisher (`AnchorPublisher`; the Solana Memo one comes from
  onchain), a job runs every minute. It anchors once an hour has passed since the last anchor, or as
  soon as 1,000 receipts wait, whichever comes first, and never with no new receipt. It takes at
  most 1,000 receipts per anchor.
  - The tree is RFC 6962 style: a leaf is `SHA-256(0x00 || hash)` and a node is
    `SHA-256(0x01 || left || right)`, so a node can never pass for a leaf. An odd node is promoted
    unchanged.
  - The memo is `defimind:anchor:v1:<fromSeq>-<toSeq>:<rootHex>`, published in one transaction.
  - The anchor `{ fromSeq, toSeq, root, chain, txId, anchoredAt }` is stored in `anchors`. A
    failed publication stores nothing and is tried again on the next tick.
  - Turned on by `ANCHOR_CHAIN` (a Solana cluster) and `ANCHOR_RPC_URL` together, with
    `ANCHOR_KEY_FILE`, which is made when unset (CR-019). The anchor key is a Solana keypair of its own: funded for fees only, never
    the hot wallet. On Fly, set it as the secret `ANCHOR_KEYPAIR_JSON`, and the entrypoint moves it
    to tmpfs.
  - **Limit:** the local `anchors` table lives in the same database as the receipts. Someone who
    can edit that database can delete anchor rows together with the newest receipts, and the local
    check then passes. Only a verifier that reads the memo from the chain, such as
    `defimind-verify`, catches that.
- **Reading the chain.**
  - `GET /v1/owner/executions?agentId&from&to` (panel session) and `GET /v1/admin/executions?from&to`
    (admin token) return `{ receipts }` in seq order, for the last seven days by default.
  - `GET /v1/owner/executions/integrity` returns `{ lastSeq, lastHash, brokenAt?, lastAnchor? }`,
    checked on the request.
  - `GET /v1/owner/executions/:seq/proof` returns the `ProofBundle` `{ receipt, siblings, anchor }`
    a third party can check offline. It answers 404 until the receipt is under an anchor.
  - `GET /v1/anchors?from&to` is public and lists anchors only, never a receipt.
- guard-core re-checks the whole chain at start-up and once a day: every `seq`, every `prevHash`,
  every hash and signature. A deleted, inserted or edited row breaks one of them. Against the
  anchors too: deleting the newest receipts leaves a valid shorter chain, so a chain that ends
  before an anchor's `toSeq`, or an anchored range whose root no longer matches, is broken there. A break is
  logged, sent to the bot as `{ kind: "chain_broken", detail: "seq <n>" }` and pushed to the
  panel, once per break.

### Web Push

With `VAPID_PRIVATE_KEY_FILE` (a P-256 private key in PEM, made at start when unset) and
`VAPID_SUBJECT` (`mailto:` or `https:`, defaulting to `PUBLIC_URL`), guard-core pushes to the owner's browsers. Messages use RFC 8291 encryption and RFC 8292
VAPID, by the pinned `web-push` library.

- `GET /v1/owner/push/key` returns `{ publicKey }`, the uncompressed P-256 point in base64url
  (CR-014).
- `POST /v1/owner/push { subscription: { endpoint, keys: { p256dh, auth } } }` returns `{ id }`.
  guard-core posts to the endpoint, so it must belong to a browser push service, or the answer is
  400 `push_host_not_allowed`: `fcm.googleapis.com`, `web.push.apple.com` or `*.push.apple.com`,
  `updates.push.services.mozilla.com` or `*.push.services.mozilla.com`, `*.notify.windows.com`.
  It must be https on 443, by name, with no IP literal. The same check runs again before every
  send. The same endpoint subscribing again keeps its id.
- `DELETE /v1/owner/push/:id` removes a subscription.
- All three need the session. Without VAPID keys they answer 404 `push_not_configured`.
- The payload is `{ kind, agentId?, chain?, amount?, intentId?, sentAt }`, never a recipient or a
  URL. The kinds:
  - `approval` and `mandate`: sent before the bot is called, so the panel hears even when the bot is
    down;
  - `executed`;
  - `attack`: throttled like the bot, once per agent and code every 5 minutes;
  - `breaker`;
  - `passkey_enrolled`;
  - `kill`.
- A 404 or 410 from the push service deletes the subscription. Pushes are never awaited, so a slow
  push service holds up no payment. Each message lives 10 minutes (`TTL`), the life of an approval.
  A failure is logged with the status and the endpoint's host only: the endpoint itself is a
  capability URL.
- On Fly, set the key as the secret `VAPID_PRIVATE_KEY` (the PEM). The entrypoint moves it to tmpfs
  with the hot keys and sets `VAPID_PRIVATE_KEY_FILE`.

### Without a Telegram bot (CR-017)

The bot is optional. `BOT_URL`, `BOT_TOKEN` and `BOT_WEBHOOK_SECRET` are all set or all unset. A
partial set stops the start, naming the missing variables. With none set:

- no webhook goes out, so there is no failed-webhook log or `approval_request_failed` audit row. The
  owner hears through the panel's Web Push, which always goes first.
- the `/v1/bot/*` routes are not registered, and answer 404.
- the doctor leaves out its bot check instead of failing it.

With all three set, everything is as before.

### The admin token only tightens (CR-022)

- An admin write that loosens is refused with 403 `loosen_in_panel`, before or after the first
  passkey and on every chain:
  - `PUT /v1/admin/policy/:agentId` with anything `loosened()` counts: a raised limit, a new chain,
    token, recipient or domain, going live, unpausing, dropping `requireMandate`, or any trading
    loosening;
  - every `POST /v1/admin/resume`.
- Each refusal is audited (`admin_loosen_refused`, `via: "admin"`) and alerts the owner: the bot's
  `admin_loosen_refused` alert and a Web Push "attack".
- `POST /v1/admin/mandates` opens the mandate as an agent's would: above the approval threshold it
  waits for the owner in the panel.
- Tightening, reads, pause, kill, revoke and creating an agent are unchanged.
- Loosening happens only in the owner's panel, with the passkey step-up (CR-015). A leaked admin
  token can stop, narrow and read, and nothing more.
- With one listener (no `PUBLIC_PORT`), the admin routes on and `HOST` beyond loopback, guard-core
  refuses to start, because the admin routes would face every interface. Split the listeners, keep
  `HOST` on loopback, set `ADMIN_ROUTES=false`, or set `ALLOW_PUBLIC_ADMIN=true`, which starts with
  a warning.
- The start-up log names each listener's address and its route groups (`listener layout`).
- With `SETUP_CODE` set, only the setup code enrols the first passkey. The admin token's passkey
  routes answer 403 `use_setup_code` while no passkey exists, audited (`admin_enrol_refused`)
  and alerted like a loosening. Without `SETUP_CODE`, as in a local run, the admin token still can,
  and the start-up log warns about it.
- An x402 approval is redeemed only by the same request: the SHA-256 of its method, full URL with
  query and body. Another request is a new intent.
- With `PUBLIC_URL` or `PASSKEY_ORIGIN` set, the public listener answers 421 `misdirected` to a Host
  header naming another host. A single loopback listener also takes `localhost`, `127.0.0.1`,
  `[::1]` and its `HOST`. `/health` answers any Host.

### Guarded trading (CR-021)

Phase 1 trades on Solana through Jupiter, with the chain's dollar on one side of every swap. A
policy without `trading` trades nothing, and an adapter without `quoteSwap` refuses every swap with
`VENUE_NOT_ALLOWED`.

- **Routes.**
  - `POST /v1/agent/quote` answers the venue's quote and decides nothing.
  - `POST /v1/agent/swap` runs the pipeline below.
  - `GET /v1/agent/portfolio/:agentId` and `GET /v1/owner/portfolio` answer positions at cost,
    the day's buys and `dailyTradeMax`.
  - A venue that is down answers 502 `venue_unavailable` and leaves no intent.
- **The pipeline**, every step default deny:
  - the trading policy: venue, token, `maxTradeUsd`, `dailyTradeMax`, `maxPositionUsd`, slippage,
    price impact and a quote no older than 30 seconds. The quote is checked against the request
    and against itself: a minimum that allows more slippage than the limit is `SLIPPAGE_TOO_HIGH`
    whatever the venue reports;
  - before a buy, the token risks the adapter found, and an exit route within the impact limit;
  - a top-up for a buy, under the same onchain cap, since a venue's transaction cannot carry the
    draw. It runs before the owner is asked, because the test run needs the dollar in the hot
    wallet, so a buy the owner then rejects has still counted against the vault's daily cap (the
    dollar stays in the hot wallet for the next trade or payment);
  - the adapter's test run, which must bring in at least the minimum for at most the amount;
  - approve, or the owner for a buy at or above `approvalThreshold`, the first buy of a token
    (`NEW_TOKEN`, which guard-core alone knows) or a mintable one (`MINT_AUTHORITY`). A sell never
    waits.
- **Owner approval.** A swap the owner approved runs the policy again, and the adapter builds and
  checks a fresh transaction against the minimum the owner saw. Nothing is re-quoted into a lower
  minimum.
- **Counting and positions.**
  - Buys count against `dailyTradeMax` (`daily_trades`), never `dailyMax`, and the report leaves
    swaps out of what payments spent.
  - Positions are per agent and token, at cost: a buy adds the simulated `tokenOut` delta at what
    it cost, and a sell takes the cost down in proportion.
  - Decimals come from the mint, read by the adapter.
- **Mandates.** A swap cannot name a mandate yet, so a policy with `requireMandate` gets no swaps
  at all (`MANDATE_REQUIRED`), whether direct or approved.
- **Shadow mode** is paper trading: a live quote and the test run, with nothing drawn or signed.
- **Close.** `POST /v1/owner/positions/close { assertion }` (step-up `close_positions`, body `{}`)
  sells every token the hot wallets hold back to the chain's dollar, even while agents are paused.
  Everything held is sold, airdrops included, each filed under the agent that holds most of it (or
  the first agent, for a token no agent bought). A policy that requires mandates does not stop it.
  It sells at market with no price-impact limit, but within the slippage limit.
- **Loosening needs the step-up.** Turning trading on, a new venue or token, `allowAnyToken`, or a
  raised limit is a loosening, so it needs the passkey step-up (CR-015). The bot can only tighten.

### Owner trading tools (CR-025)

Every route needs the owner's session. These routes serve Solana mainnet through Jupiter only.

- `GET /v1/owner/tokens/search?q=&chain=` proxies Jupiter's `tokens/v2` search.
  - Limited to 30 a minute per session, and each query is cached for 60 seconds.
  - The answer is untrusted: it is validated, strings are cut short, and every field outside
    `TokenInfo` is dropped, images included. Verified tokens come first.
- `GET /v1/owner/tokens/:mint/risk?chain=` returns the adapter's `tokenRisk` facts, read onchain.
  guard-core adds the approval flags (`NEW_TOKEN`, `MINT_AUTHORITY`) and Jupiter's own claims,
  labelled as `venue`.
- `POST /v1/owner/quote` returns the quote the agent would get under its policy. It decides and
  records nothing.
- `POST /v1/owner/trade` always needs the step-up `manual_trade` over
  `{ agentId, chain, tokenIn, tokenOut, amountIn, minAmountOut }`. It runs the agent's own swap
  pipeline and wallet, with the passkey as the owner's approval, so nothing waits.
  - A fresh quote below the owner's `minAmountOut` is `SLIPPAGE_TOO_HIGH`.
  - A paused agent is refused, and an agent in shadow is shadowed.
  - It is audited as `owner_trade` and counts in the agent's day.

### Agent wallets (CR-022)

Opt-in, per agent and chain. `POST /v1/owner/agents/:id/wallets { chain, assertion }` (step-up
`agent_wallet` over `{ agentId, chain }`) makes the agent's own hot wallet under
`KEYS_DIR/agents/<agentId>/<chain>` (0600), or takes the file `AGENT_WALLET_<AGENT>_<CHAIN>_FILE`
names, for example `AGENT_WALLET_FLY_AGENT_SOLANA_MAINNET_FILE`. A second call returns the same
wallet. It answers the wallet's address, its gas and the `/sign` add-limit page that names it.

- **Pending, then active.** Until guard-core reads the wallet's limit onchain, the agent keeps paying
  from the shared wallet. The wallet turns active on the next `GET /v1/owner/agents/:id/wallets`
  after the limit is signed. From then on every payment, top-up and swap of that agent on that chain
  goes through its own wallet only. If its adapter cannot be built, the payment is refused, never
  sent from the shared wallet.
- **A key that changed stops the start.** guard-core refuses to start when a wallet's key file no
  longer gives the stored address, since that limit names the old key.
- **Kill.** `POST /v1/owner/kill` returns one transaction per chain and wallet. Each link names its
  own hot wallet. `POST /v1/owner/agents/:id/kill` pauses that agent alone and returns its own
  wallets' transactions. A revoke returns them too, with a note that the limit stays live until
  they are signed.
- **Doctor.** Each own wallet gets its allowance, gas and balance lines, with ids
  `<chain>:<agentId>:<check>`.
- **Close positions.** It also sells what each agent's own wallet holds, as that agent.
- **`/sign`.** It is filled with every agent wallet when it is served.

### Guided setup (CR-019)

A one-click deployment starts with only `ADMIN_TOKEN` and `SETUP_CODE`, and a disk at `/data`.

- **Keys.** Each key file that the env leaves unset is made once under `KEYS_DIR` (default: `keys/`
  next to the database), directory 0700 and files 0600. That covers a hot wallet per enabled chain,
  the receipt key, the VAPID key and the anchor keypair. A file is never replaced, so a restart keeps
  the hot wallet its onchain limit names. A key given by env always wins, so Fly deployments are
  unchanged. `GET /v1/owner/keys` (session) answers the public halves only.
- **A chain without its vault waits.** It has a hot wallet but no adapter until the owner adopts a
  vault, so it pays nothing. With the vault set, a missing RPC or key still stops the start.
- **First access.** `GET /v1/owner/setup` answers `{ needsSetup }`. While no passkey exists,
  `POST /v1/owner/setup { setupCode }` answers `{ enrolLink, expiresAt }`, the same one-time link as
  `pnpm passkey-code`. The code is compared in constant time, five tries per address per 15 minutes,
  and every wrong one is audited (`setup_code_refused`). Once a passkey exists it answers
  `410 setup_done`.
- **Settings.** `GET /v1/owner/settings` answers each enabled chain's RPC and vault in force, the
  env's or the panel's. `PUT /v1/owner/settings { chains, assertion }` needs the `change_settings`
  step-up over `{ chains }` as sent, and answers like GET. A field the env sets is `409 set_by_env`,
  a chain that is off `400 chain_not_enabled`. Every chain is rebuilt from the env and the new
  settings, and a vault is adopted only if its adapter reports an active limit or allowance for this
  hot wallet; otherwise `422 vault_not_ours` and nothing is stored. A chain whose RPC neither the env nor the panel sets uses its
  cluster's public RPC, the one `/sign` uses, and logs that it is rate-limited; GET still answers no
  `rpcUrl` for it. Base has no public one, so a Base vault without an RPC is `400 settings_incomplete`. Adopted chains are swapped in for the next request, and the audit row
  `settings_changed` names fields only, since an RPC URL can carry an API key.
- **Progress.** `GET /v1/owner/setup/progress` answers the steps passkey, vault, limit, deposit,
  agent, rules, shadow and live, each read from the database or the chain. A chain that cannot be
  read counts as not done.
- **Deposit.** `GET /v1/owner/deposit` answers each chain's vault, token, balance and daily cap, and,
  with `SIGN_PAGE_URL`, the signing page's deposit link, which names the multisig or the Safe only.
- **Signing page.** `/sign/` serves onchain's build (`SIGN_DIR`, default
  `packages/onchain/web/dist`) with this deployment's hot wallets filled into the page's config at
  serve time. A link never names them, so a crafted one cannot make the page grant another key. The
  page reads the chain through each cluster's public RPC, never guard-core's own, since `/sign` is
  public and that URL can carry an API key. Only `app.js` and `style.css` are served next to it,
  under its CSP with `frame-ancestors 'none'`. The image builds the page in its own stage.
- **One public listener.** `ADMIN_ROUTES=false` leaves `/v1/admin/*` unregistered. `PUBLIC_URL`
  defaults to `RENDER_EXTERNAL_URL`, and `PASSKEY_RP_ID`, `PASSKEY_ORIGIN` and `VAPID_SUBJECT` default
  from it. `TRUST_FORWARDED_FOR=true` takes the client's address for rate limits from the last
  `X-Forwarded-For` hop, the one the host's proxy appends.

### Bot routes that only tighten or read (CR-016)

The bot holds `BOT_TOKEN` only, never the admin token. Under `/v1/bot`, with that token alone:

- `POST /v1/bot/pause { agentId }`, `POST /v1/bot/kill {}` (the admin kill's body) and
  `POST /v1/bot/agents/:id/revoke`.
- `POST /v1/bot/policy/:agentId/tighten { removeDomains?, removeRecipients?, mode?: "shadow",
perTxMax?, dailyMax?, approvalThreshold? }`. It builds the new policy, then refuses it with 403
  `loosen_in_panel` if the panel's loosening check finds anything: a limit above the current one
  counts. Any other field is a 400.
- `GET /v1/bot/agents`, `/policy/:agentId`, `/budget/:agentId`, `/chains`, `/report` and `/doctor`,
  with the admin reads' bodies.
- Every write is audited with `via: "bot"`.
- Nothing under `/v1/bot` creates an agent, adds to an allowlist, raises a limit, goes live,
  resumes or issues an enrolment code. Those take the panel's passkey, or the admin token on the
  machine.

### Owner panel sign-in

The owner panel (CR-012) signs the owner in with an enrolled passkey. These routes are on the
public listener, and only exist with `PASSKEY_RP_ID` and `PASSKEY_ORIGIN` set.

- `POST /v1/owner/session/options` returns WebAuthn authentication options. Each request gets its
  own challenge, good for one use within two minutes.
- `POST /v1/owner/session { assertion }` verifies the assertion and returns `{ expiresAt }`, the
  time the session ends if left idle. It sets the cookie `dm_session` with `HttpOnly; Secure;
SameSite=Strict; Path=/v1/owner`. A session ends after 30 minutes idle, or 12 hours after sign-in
  however active it is. Only the SHA-256 of its token is stored (`owner_sessions`). Sessions past
  their 12 hours are pruned by the sweep.
- `POST /v1/owner/session/logout` ends the session and clears the cookie.
- Without a live session, a panel route answers 401 `{ "error": "no_session" }`.
- Every state-changing request needs `X-DefiMind-Request: 1` and an `Origin` equal to
  `PASSKEY_ORIGIN`, or it gets 403 `{ "error": "bad_origin" }`. This covers sign-in and sign-out
  too. No plain form or cross-site request can set that header.
- Sign-ins, refused sign-ins and sign-outs are audited. Cookies are redacted from the logs.

### Passkey approvals

With `PASSKEY_ABOVE` set (an amount), an intent at or above it ### Owner panel routes

Behind the panel session, with the same `X-DefiMind-Request` and `Origin` check on every state
change. They mirror the admin routes, through the same code (`src/http/control.ts`), so the two
cannot drift. The audit says which one a change came through (`via: "admin" | "panel"`).

- `GET /v1/owner/overview` returns `{ chains, agents, pending, mandates }`. `pending` and `mandates`
  are the approval requests still waiting, as the bot received them. They are kept in
  `approval_requests` until their deadline passes.
- `POST /v1/owner/challenge { action, body }` returns WebAuthn options for one exact request. The
  challenge is keyed by the SHA-256 of the canonical JSON of `{ action, body }`. The route that takes
  the assertion rebuilds that body from its own request, so an assertion made for another action, or
  for the same action with another body, finds no challenge. A challenge lasts five minutes, and is
  used up by compare-and-delete: one assertion sent twice at once gets through once.
- These need a step-up, as `{ assertion }` in the body. Without one the answer is 403
  `step_up_required`; with a bad or reused one, 401 `passkey_not_verified`.
  - `POST /v1/owner/intents/:id/decision` and `POST /v1/owner/mandates/:id/decision` with
    `approve`. The step-up bodies are `{ intentId }` and `{ mandateId }`. A rejection needs the
    session only. Every panel approval records `approvedBy: "passkey"`.
  - `POST /v1/owner/agents { agentId }`, with the body `{ agentId }`.
  - `POST /v1/owner/resume { agentId }`, with the body `{ agentId }`.
  - `PUT /v1/owner/policy/:agentId { policy }` when the change loosens the policy. The body is
    `{ agentId, policy }`, with `policy` exactly as sent. A loosening is SPEC's list (a raised
    `perTxMax`, `dailyMax` or `approvalThreshold`, anything added to an allowlist, going live, no
    longer requiring a mandate) plus three more: unpausing (otherwise a resume without its passkey),
    and a raised `maxPaymentsPerMinute` or `priceIncreaseMaxPct`. A change that only tightens
    needs the session only.
- `POST /v1/owner/kill` returns what the admin kill returns. With `SIGN_PAGE_URL` set, each
  entry for a chain the signing page can kill also carries `link` (the Phantom universal link) and
  `pageLink` (the page itself), stamped now, since the page refuses a link more than 15 minutes old
  (CR-014). On Solana the target is `SQUADS_MULTISIG` with the hot wallet's public key, read from
  its own keypair file. On Robinhood Chain it is `ROBINHOOD_SAFE_ADDRESS`. The admin kill never
  carries links.
- Session only: `GET /v1/owner/report`, `/receipts` (as `GET /v1/admin/receipts`), `/doctor`, `/budget/:agentId`, `/agents`,
  `/policy/:agentId`, `/passkeys`; `POST /v1/owner/agents/:id/revoke`, `/pause` and `/kill`.

can be approved only with a passkey
the owner enrolled, never by a Telegram tap alone. A stolen Telegram account can still reject it,
never approve it. `PASSKEY_RP_ID` and `PASSKEY_ORIGIN` name guard-core's public address, which the
passkey is bound to, so a look-alike site cannot use it.

- Enrolment from a phone: `POST /v1/admin/passkeys/code` returns `{ code, expiresAt }`, a code good
  for one attempt within ten minutes, stored only as its SHA-256 and audited. The bot sends the
  owner `https://<guard-core>/owner/enrol#code=<code>`. The code is in the fragment, which the
  browser never sends, so it stays out of request lines and logs. The page's script posts it to
  `POST /v1/owner/passkeys/options { code }`, creates the passkey, and sends the result with the
  code to `POST /v1/owner/passkeys { code, response }`, which uses the code up. Each code has its
  own challenge, so one code's challenge cannot be answered with another.
- A code alone adds only the first passkey. Once one exists, the options also carry `stepUp`, and
  the enrolment needs `assertion`: a signature from an enrolled passkey over that challenge
  (single-use, five minutes). Without it the answer is 401 `step_up_required` and the code is not
  used up. Whoever holds the owner's Telegram therefore cannot add a passkey of their own.
- Enrolment through the admin routes, for a tool on the operator's side:
  `POST /v1/admin/passkeys/options` and `POST /v1/admin/passkeys { response }`. It adds only the
  first passkey (409 `step_up_required` after that). "First" is checked together with the insert,
  so two enrolments verified at the same moment cannot both be the first.
- Every enrolment is audited and sent to the bot as `/hooks/alert { kind: "passkey_enrolled",
detail: <first 8 characters of the credential id>, sentAt }`, so the owner hears of one they did
  not make. A credential already enrolled gets 409 `passkey_exists`, and the code stays good.
- `GET /v1/admin/passkeys` lists `{ id, createdAt, lastUsedAt }` for each passkey.
- Removing a passkey has no route: it takes a shell on the machine.
  `pnpm --filter @defimind/guard-core remove-passkey` lists them, and
  `pnpm --filter @defimind/guard-core remove-passkey <id or prefix>` removes one, audited. The
  prefix must be at least 8 characters and match exactly one passkey. Every panel session the passkey opened ends with it.
- Both require user verification. Challenges are single-use and last five minutes. Opening a page
  again reuses the challenge still out, and a challenge is used up only by a verified answer, so a
  stray or forged request cannot spoil the owner's open page. Challenges and codes are used up by
  a compare-and-delete, so of several copies of one answer sent at once, only one gets through. Expired challenges and codes are
  pruned by the sweep.
- The approval request for such an intent carries `passkey: true`, and `/v1/bot/decision` answers
  `approve` with 403 `passkey_required` (a rejection still works).
- `GET /owner/approve/:intentId`, on the public listener, is a small page that runs WebAuthn for
  this origin. Its challenge is bound to that one intent, single-use, and expires with it.
  `POST /v1/owner/approve { intentId, assertion }` verifies the assertion and approves; a transfer
  is then sent, and an x402 payment waits for the agent's repeat, as after any approval. The
  receipt says `approvedBy: "passkey"`.
- The page shows the amount in dollars with the chain's symbol ("3.00 USDC"). Its CSP allows only
  its own script (no inline code) and its own API, the agent's text is shown as text, and it is
  sent with `X-Frame-Options: DENY` and HSTS. The public listener's rate limit applies.
- At startup `PASSKEY_ORIGIN` must be a bare origin (`https://host[:port]`) whose host is
  `PASSKEY_RP_ID` or a subdomain of it.

Enrol a passkey before setting `PASSKEY_ABOVE`: with it set and none enrolled, guard-core refuses to
start, because nothing above the amount could ever be approved. The doctor warns when an agent's
approval threshold is above `PASSKEY_ABOVE`: amounts between the two pay without the owner.

### Events to the bot

A flagged approval request also carries `pinned: { recipient, amount }`, the domain's last executed
payment, so the bot can show the old payee and how many times the last price this is.

`POST {BOT_URL}/hooks/alert { kind, agentId, detail, sentAt }`, signed the same way, carries what
the owner must act on now: today, a tripped breaker. It is retried like an intent event.

Every intent that reaches `executed`, `rejected`, `failed` or `expired` is posted to
`{BOT_URL}/hooks/intent-event` as `{ intent, sentAt }`, signed like the approval request (CR-004).
The bot decides what the owner sees. The post is never awaited: a bot that is down does not hold up
or fail a payment. A failed post is retried after 1, 4 and 16 seconds with a fresh `sentAt` each
time (the bot deduplicates on intent id and status); an event still undelivered after that is logged,
without its payload.

## Known gaps

- The routes are tested end to end against `adapters/stub.ts`, and onchain's adapters have their
  own tests. Live payments ran on Solana devnet, Base Sepolia and Robinhood Chain mainnet; the
  open items are in [`docs/security-review.md`](../../docs/security-review.md).

## Layout

| Path            | Contents                                                                   |
| --------------- | -------------------------------------------------------------------------- |
| `src/domain/`   | Pure logic: policy, amount math, x402 offer choice, simulation check, auth |
| `src/service/`  | The pipeline, transfers, x402, approvals, the per-agent lock               |
| `src/adapters/` | I/O: bot webhook, the paid API, the keypair file, the stub chain           |
| `src/http/`     | Fastify routes per role, zod schemas, bearer auth, rate limits             |
| `src/db/`       | Drizzle + SQLite schema, migrations, queries                               |
| `src/main.ts`   | Startup: config, migrations, adapters, the expiry sweep timer              |
| `deploy/`       | The container entrypoint that moves Fly secrets to tmpfs                   |

## Security

- The hot wallet keys are read from files, `SOLANA_HOT_WALLET_KEYPAIR` (a Solana CLI keypair) and
  `BASE_HOT_WALLET_KEY_FILE` (0x and 64 hex digits), and live only in this process (later: KMS).
  Never logged, never returned by any endpoint. Logs redact `authorization` and
  `x-guard-signature`. The old raw `HOT_WALLET_PRIVATE_KEY` is refused at startup: move the key to
  a file, `chmod 600`, outside the repository.
- In a deployment the keys arrive as Fly secrets, `SOLANA_HOT_WALLET_KEYPAIR_JSON` (the keypair
  file's contents) and `BASE_HOT_WALLET_KEY`. `deploy/entrypoint.sh` runs as root, mounts tmpfs at
  `/run/defimind`, writes each key there with mode 600 for the `node` user, points the two path
  variables at the files, unsets the secrets and only then starts guard-core as `node`. It refuses
  to start if tmpfs cannot be mounted, so a key never lands on disk.
- Agent tokens are stored only as SHA-256 hashes and compared in constant time.
- Amounts are `bigint` internally. No floats for money.
- Agent-provided text (`reason`, URLs, headers, API responses) is untrusted and never affects a
  decision.

## Database

SQLite, at `DATABASE_URL`. It holds the day's spend per agent, pending approvals and the audit log,
so losing it resets the daily max to zero. **In production it must live on a persistent volume**,
outside the repository and outside any temp directory. On Solana or Base mainnet, guard-core refuses
to start otherwise. Devnet and local runs may keep the default `./data/guard.db`.

`pnpm --filter @defimind/guard-core db:backup [destination]` copies the live database with SQLite's
online backup API. It is safe while guard-core is running and never overwrites an existing file.
With no destination, the copy goes to `backups/guard-<time>.db` next to the database.

**Daily backup (CR-024).** guard-core backs itself up every day at `BACKUP_HOUR_UTC` (default 3),
to `backups/guard-<UTC date>.db` beside the database (0600). It keeps the newest 14, and a restart
on the same day keeps the day's first. A failure is logged as `database backup failed` and tried
again the next day. With `BACKUP_BUCKET_URL` (an S3-compatible bucket, path-style:
`https://<endpoint>/<bucket>[/<prefix>]`), each backup is also uploaded as `<name>.enc`, sealed with
AES-256-GCM under `BACKUP_ENCRYPTION_KEY`: 12-byte IV, then the ciphertext, then the 16-byte tag.
The bucket needs `BACKUP_ACCESS_KEY_ID`, `BACKUP_SECRET_ACCESS_KEY` and the encryption key, or the
start is refused; `BACKUP_REGION` defaults to `auto`. Keys and URLs are never logged. The doctor
warns when the newest backup is over 26 hours old, and with a bucket it names the last upload.

Env vars are documented in [`.env.example`](./.env.example).

## Deploy on Fly.io

The image builds the panel in its own stage and copies `packages/panel/dist` next to guard-core,
with `PANEL_DIR` pointing at it, so `/panel/` works with no extra step.

`Dockerfile` and `fly.toml` run guard-core as one machine, `your-guard-core`, in the same org
and region (`gru`) as the bot (`your-bot`, see its README):

- **Two listeners**, each with only its own routes registered:
  - **public**, `0.0.0.0:8080` behind Fly's TLS (`force_https`): `/v1/agent/*`, the owner's
    `/v1/owner/*` and `/owner/*` pages, the panel at `/panel/`, and `/health`. Agents call `https://<your-app>.fly.dev/v1/agent/...`. The per-IP
    limit keys on `Fly-Client-IP`, the real client, believed on this listener only and only with
    `TRUST_FLY_CLIENT_IP=true` (set in `fly.toml`). Without it the limit keys on the connection
    address, so a client off Fly cannot pick a fresh address per request.
  - **private**, `fly-local-6pn:8787`: `/v1/admin/*`, `/v1/bot/*` and `/health`. No Fly service
    exposes it. The bot reaches it at `http://your-guard-core.internal:8787`, and guard-core
    calls the bot, when there is one, at `http://your-bot.internal:8788` (the `BOT_URL` secret).

  Both listeners share one set of deps, so the per-agent lock covers an agent's request and the
  owner's approval alike. Without `PUBLIC_PORT`, as in a local run, one listener on `HOST:PORT`
  serves every route.

- **One machine.** The database is SQLite on the `guard_data` volume at `/data`, and a volume
  belongs to one machine. Hence `--ha=false`.
- **The image holds no secret.** The build copies only `package.json` and `src` of shared, onchain
  and guard-core, then runs `pnpm deploy --prod`. The root `.dockerignore` keeps every `.env`, key
  and database out of the build context. The container starts as root only so
  `deploy/entrypoint.sh` can mount tmpfs for the hot keys, then runs node as `node`.

Owner commands, run in bash on your own machine from `~/DefiMind`, after the bot's steps 1 and 2
(flyctl installed and logged in). No secret is typed or printed: each one is piped from a file.

```bash
# 1. Create the app and its database volume, in the bot's org and region. Once only.
fly apps create your-guard-core --org <your-fly-org>
fly volumes create guard_data --app your-guard-core --region gru --size 1

# 2. Settings, read from guard-core's .env. BOT_TOKEN and BOT_WEBHOOK_SECRET must equal the bot's
#    GUARD_BOT_TOKEN and BOT_WEBHOOK_SECRET; ADMIN_TOKEN is guard-core's alone (CR-016). SOLANA_CHAIN
#    must be in the .env for mainnet: without it guard-core runs on devnet.
cd ~/DefiMind && grep -E '^(ADMIN_TOKEN|BOT_TOKEN|BOT_WEBHOOK_SECRET|SOLANA_CHAIN|SOLANA_RPC_URL|SQUADS_MULTISIG|ROBINHOOD_CHAIN|ROBINHOOD_RPC_URL|ROBINHOOD_SAFE_ADDRESS)=.' packages/guard-core/.env | fly secrets import --app your-guard-core --stage

# 3. The hot wallet key, piped from the keypair file that SOLANA_HOT_WALLET_KEYPAIR names (a full
#    path, no ~). On mainnet it must be a new key, never used on devnet.
cd ~/DefiMind && key="$(grep '^SOLANA_HOT_WALLET_KEYPAIR=' packages/guard-core/.env | cut -d= -f2-)" && { printf 'SOLANA_HOT_WALLET_KEYPAIR_JSON='; tr -d ' \n' < "$key"; echo; } | fly secrets import --app your-guard-core --stage

# 4. Deploy one machine. The first test refuses to run if a .env would reach Fly's builder.
cd ~/DefiMind && if grep -qx '\*\*/.env' .dockerignore; then fly deploy . --config packages/guard-core/fly.toml --dockerfile packages/guard-core/Dockerfile --ha=false; else echo 'STOP: the root .dockerignore must exclude **/.env'; fi

# 5. Check: one machine, its health check passing, and no config error in the log. Then the public
#    side: /health answers, and an admin route is not there at all (404).
fly status --app your-guard-core && fly checks list --app your-guard-core && fly logs --app your-guard-core --no-tail
curl -s https://<your-app>.fly.dev/health && curl -s -o /dev/null -w '%{http_code}\n' https://<your-app>.fly.dev/v1/admin/chains
```

For Robinhood Chain, pipe its key the same way as step 3, from the file that
`ROBINHOOD_HOT_WALLET_KEY_FILE` names:

```bash
cd ~/DefiMind && key="$(grep '^ROBINHOOD_HOT_WALLET_KEY_FILE=' packages/guard-core/.env | cut -d= -f2-)" && { printf 'ROBINHOOD_HOT_WALLET_KEY='; tr -d ' \n' < "$key"; echo; } | fly secrets import --app your-guard-core --stage
```

To change a setting or a key later, repeat step 2 or 3 without `--stage`: Fly restarts the machine,
and the entrypoint writes the new key on the way up. Base, once D6 allows it, follows step 3 with
`BASE_HOT_WALLET_KEY` and the key file's contents, and step 2 with its `BASE_*` and `SAFE_ADDRESS`
settings.
