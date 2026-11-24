# @defimind/e2e

End-to-end and attack tests across guard-core, telegram-bot and mcp-server, run once per chain:
Solana devnet first, then Base Sepolia (SPEC v0.3).

- **`pnpm dev:all` preflight:** `src/env-check.ts` cross-checks the three services' `.env` files.
  See the root README for the full setup.

## How it runs

`test/support/stack.ts` wires guard-core, telegram-bot and mcp-server together over real HTTP, as
`pnpm dev:all` does. The webhooks are signed, the tokens are checked, and the agent calls MCP tools.
Two things are fake. The chain is guard-core's `StubChain`, which signs nothing. Telegram is
recorded rather than sent, while the real bot still handles every update. One clock drives all
three services, so expiry is tested without waiting. Runs in CI, with no network and no keys:

```bash
pnpm --filter @defimind/e2e test
```

## End-to-end flows, `test/solana-flows.test.ts`

1. Under the threshold: paid without asking the owner, and the body comes back fenced as untrusted.
2. Over the threshold: the owner approves (in these runs through the recorded bot, with
   `TELEGRAM_APPROVALS=true`; `panel-flows` covers the passkey approval), the agent repeats the
   request, and the approval is redeemed once.
3. The owner rejects: nothing is paid, and the buttons are removed.
4. Left unanswered: `APPROVAL_TIMEOUT`, and a late press is told it is too late.
5. `/kill`: the agent is paused, and the owner receives the chain's kill transaction.

## Attacks, `test/solana-attacks.test.ts`

Each one must end with nothing paid and the right reject code.

| Attack                                                                  | Code                                                                   | Where proven                                 |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------- |
| 402 for the whole balance, or above the agent's `maxAmountUsd`          | `PER_TX_EXCEEDED`                                                      | here                                         |
| 402 in another token, on another network, in another scheme             | `TOKEN_NOT_ALLOWED`, `CHAIN_NOT_ALLOWED`, `INVALID_402`                | here                                         |
| `payTo` moved between the quote and the retry                           | `INVALID_402`                                                          | here                                         |
| host not on the allowlist (refused before any request)                  | `DOMAIN_NOT_ALLOWED`                                                   | here                                         |
| payment header forged by the agent                                      | dropped, never reaches the API                                         | here                                         |
| transfer to a recipient off the allowlist; per-tx; daily; paused        | `RECIPIENT_NOT_ALLOWED`, `PER_TX_EXCEEDED`, `DAILY_EXCEEDED`, `PAUSED` | here                                         |
| SPL Approve, SetAuthority, CloseAccount, unknown program, lookup tables | the five Solana codes, plus an owner alert                             | wiring here; detection in `packages/onchain` |
| simulation showing a larger loss, or a failing simulation               | `SIM_UNEXPECTED_EFFECT`, `SIM_FAILED`                                  | here                                         |
| non-owner pressing Approve; webhook with a bad HMAC; replayed webhook   | ignored, 401, 409                                                      | here                                         |
| one approval redeemed twice                                             | the second asks the owner again                                        | here                                         |
| prompt-injected response telling the agent to pay someone               | body fenced by a nonce, allowlist still refuses                        | here                                         |
| hot wallet drained by a bug: loss capped by the onchain daily cap       | Squads Spending Limit                                                  | devnet and `packages/onchain` (LiteSVM)      |
| approve / Permit / Permit2 / EIP-7702 disguised as a payment            | the EVM codes                                                          | Base attacks, below                          |

The devnet run on the owner's machine covers the two the stub cannot: the real Solana adapter signing
and inspecting real transactions, and the onchain cap.

## The x402 path on Solana devnet (owner's machine)

No public x402 endpoint on Solana devnet is assumed. `pnpm --filter @defimind/e2e paywall`
(`src/devnet-paywall.ts`) is a paid API that acts as its own facilitator, using the x402 SDK's
`ExactSvmScheme`. It quotes a price and verifies the payment the guard signed. Then it settles that
payment on devnet itself, paying the network fee from its own key. Run it alongside `pnpm dev:all`,
after a plain transfer on devnet works.

1. `cp e2e/.env.example e2e/.env`. Set `PAYWALL_FEE_PAYER_KEYPAIR` to a keypair file that holds
   devnet SOL; the owner's works. Set `PAYWALL_PAY_TO` to the address that should receive the USDC,
   for example the owner's. That address needs a devnet USDC token account. Nothing is printed except
   the fee payer's public address.
2. Allow the paywall's host. A refused host is never even requested:

   ```bash
   t=$(grep '^ADMIN_TOKEN=' packages/guard-core/.env | cut -d= -f2-) && curl -sS http://localhost:8787/v1/admin/policy/agent-1 -H "Authorization: Bearer $t" | sed 's/"allowedDomains":\[[^]]*\]/"allowedDomains":["127.0.0.1"]/' | curl -sS -X PUT http://localhost:8787/v1/admin/policy/agent-1 -H "Authorization: Bearer $t" -H 'content-type: application/json' -d @-
   ```

3. In another window: `pnpm --filter @defimind/e2e paywall`.
4. Have the agent fetch it. 0.5 USDC is under a 1 USDC threshold, so this one pays without asking:

   ```bash
   t=$(grep '^AGENT_TOKEN=' packages/mcp-server/.env | cut -d= -f2-) && curl -sS -X POST http://localhost:8787/v1/agent/x402/fetch -H "Authorization: Bearer $t" -H 'content-type: application/json' -d '{"agentId":"agent-1","url":"http://127.0.0.1:8790/data","method":"GET"}'
   ```

   Expect `"status":"executed"`, with a body naming the devnet transaction. The paywall window prints
   `settled on devnet: <signature>`, which explorer.solana.com (cluster devnet) shows as a USDC
   transfer from the hot wallet.

5. The approval path: restart the paywall with `PAYWALL_AMOUNT=1500000`. Run step 4 and expect
   `"status":"pending_approval"`. Approve it in the panel with your passkey, then run step 4 again: it redeems the
   approval and returns `"status":"executed"`.

## The x402 path on Base Sepolia (owner's machine) and Robinhood Chain testnet

`pnpm --filter @defimind/e2e paywall:base` and `paywall:robinhood` (`src/evm-paywall.ts`) are the
EVM counterparts of the devnet paywall. Each is its own facilitator through the x402 SDK's
`ExactEvmScheme`: it verifies the EIP-3009 authorization the guard signed, then settles it, paying
the gas from its own key. The token is the chain's dollar in `shared/addresses.ts` and nothing else:
USDC on Base Sepolia, Paxos USDG on Robinhood Chain testnet (CR-007). It refuses a token that is not
6 decimals. It quotes the EIP-712 domain the token reports, and checks it against the token's own
`DOMAIN_SEPARATOR` before serving. USDG has no `version()`, so its version is "1", proven the same
way.

`paywall:robinhood-mainnet` serves real USDG on Robinhood Chain (4663) for the owner's pilot. It
pays `PAYWALL_ROBINHOOD_PAY_TO`, the owner's own address, so the money returns to him, and it refuses
a fee payer key from `.env`: the key must come from `PAYWALL_EVM_KEY_FILE`.

On Robinhood Chain testnet the steps are the same with `paywall:robinhood`, port 8792,
`PAYWALL_ROBINHOOD_PAY_TO`, Robinhood testnet ETH for the fee payer, and guard-core running with
`ROBINHOOD_CHAIN=eip155:46630`. The settled transaction is on explorer.testnet.chain.robinhood.com.

1. In `e2e/.env`, set `PAYWALL_EVM_KEY` (a testnet key with Base Sepolia ETH) and
   `PAYWALL_BASE_PAY_TO`.
2. Make sure guard-core runs with `BASE_CHAIN=eip155:84532` and its Base settings, and that the
   agent's policy allows `eip155:84532`, the Base Sepolia USDC, and the domain `127.0.0.1`.
3. In another window: `pnpm --filter @defimind/e2e paywall:base`.
4. Have the agent fetch it:

   ```bash
   t=$(grep '^AGENT_TOKEN=' packages/mcp-server/.env | cut -d= -f2-) && curl -sS -X POST http://localhost:8787/v1/agent/x402/fetch -H "Authorization: Bearer $t" -H 'content-type: application/json' -d '{"agentId":"agent-1","url":"http://127.0.0.1:8791/data","method":"GET"}'
   ```

   Expect `"status":"executed"`. The paywall window prints `settled on Base Sepolia: <hash>`, which
   sepolia.basescan.org shows as a USDC `transferWithAuthorization` from the hot wallet.

5. For the approval path, restart it with `PAYWALL_AMOUNT=1500000`: the first call is
   `pending_approval`, you approve it in the panel, and the second call is `executed`.

## Base attacks, `test/base-attacks.test.ts`

The same suite on the Base Sepolia stub chain, 15 cases. Every malicious 402 is refused: whole
balance, wrong token, Base mainnet while only Sepolia is allowed, a Solana offer to a Base-only
agent, an unknown scheme, payTo moved on the retry, and a host off the allowlist. The three EVM codes
(`APPROVAL_DETECTED`, `PERMIT_DETECTED`, `DELEGATION_DETECTED`) stop the payment and reach the owner.
A Permit handed to the signer is refused as `PERMIT_DETECTED`. An approval is redeemed once, and the
kill names the Base owner transaction. The cap itself and the real signing gate are proven in
`packages/onchain` (the fork tests and `evm-gate`).

## Guarded trading on a fork of mainnet, `test/cr021-trading.test.ts`

An agent trades through MCP, guard-core decides, and onchain's real Solana adapter checks, test-runs
and signs. Everything runs in LiteSVM at the slot onchain recorded a real 1 USDC → wSOL Whirlpool
route (`packages/onchain/test/fixtures/jupiter-swap.json`), executed by the real Jupiter v6 and
Whirlpool programs. Those programs are read from mainnet at test time into
`packages/onchain/.cache/programs` and are never kept in the repository. Offline, the suite is skipped
by name; CI sets `FORK_REQUIRED=1`, which turns a skip into a failure.

The venue is the attacker. Each case must end with nothing signed and no balance moved:

| Case                                                          | Expected                   |
| ------------------------------------------------------------- | -------------------------- |
| the route's own slippage opened to 100%                       | `SLIPPAGE_TOO_HIGH`        |
| an SPL approve to a stranger added to the transaction         | `DELEGATE_DETECTED`        |
| a SOL transfer out of the hot wallet added                    | `SIM_UNEXPECTED_EFFECT`    |
| a lookup table extended in the last slots                     | `HIDDEN_ACCOUNTS_DETECTED` |
| a minimum lower than the slippage allows, or another token    | refused, nothing signed    |
| no route back out of the token                                | `NO_EXIT_ROUTE`            |
| a freezable token                                             | `TOKEN_FREEZABLE`          |
| a mintable token                                              | waits for the owner        |
| the venue turns hostile after the owner was asked             | `SLIPPAGE_TOO_HIGH`        |
| trade, daily, position, token and on/off limits of the policy | refused before the venue   |

The honest route waits for the owner on a first buy, then lands exactly the balances its test run
showed. In shadow mode it runs the real test run and signs nothing.

Not covered here, and why:

- Close positions: the recording holds only the buy, so a sell is covered by guard-core's tests
  until a sell route is recorded.
- A stale quote: guard-core's unit tests cover it.

A swap waiting for the owner reaches Telegram with both sides and the reason it waits.

## The independent review's fixes, `test/cr022-review-fixes.test.ts` and `test/cr022-hosting.test.ts`

CR-022, end to end:

- **The admin token only tightens.** The reviewer's attack, a wider policy that pays a thief, is
  refused. It changes nothing, and the owner reads "Possible attack blocked" in Telegram. Going live
  and resuming are refused too. Lowering a limit, pausing and the kill still pass. An admin mandate
  waits for the owner.
- **One listener never serves the admin API publicly by accident.** The config refuses
  HOST=0.0.0.0 with the admin routes on, unless the listeners are split, the admin routes are off,
  or ALLOW_PUBLIC_ADMIN says so.
- **An approval pays only the request the owner saw.** Another query, path or method is a new
  intent. The same request redeems it once.
- **The Host header.** A name the owner never gave the deployment gets 421; `/health` answers any.
- **The first passkey** comes only from the setup code when one is set. The admin passkey routes
  answer `use_setup_code`, and the owner is alerted.
- **The doctor** warns when one key can empty a vault, and names the hardware-wallet fix on Solana.

## Live-trade fixes, `test/cr024-live-fixes.test.ts`

On the mainnet fork: a buy that waits for the owner, with an empty hot wallet, draws nothing from
the vault. Once approved, it is topped up, test-run and landed.
