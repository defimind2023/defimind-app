# DefiMind

A security layer between AI agents and their wallets. An agent can only pay through DefiMind: every
payment is checked against a policy, simulated, and then auto-approved, sent to the owner's panel
for approval, or rejected.

Funds stay in a vault the owner alone controls: a **Squads multisig** on Solana, a **Safe** on EVM
chains. An onchain spend limit lets the guard's hot wallet draw at most a daily cap from it: the
Squads Spending Limit on Solana, the Safe Allowance Module on EVM chains, both third-party code
audited by their own makers. There is no custom contract. The agent never holds a key: guard-core signs, and only after the checks pass. The owner
approves with a passkey and kills from the owner panel in the browser, and signs vault changes in
Phantom. A Telegram bot is optional: it adds alerts and the kill in Telegram.

```
Owner vault (Squads multisig or Safe, owned by the owner's Phantom wallet)
  └─ onchain daily cap: delegate = guard hot wallet, token = the chain's dollar, 24h period
       └─ guard hot wallet (small balance, key held ONLY by guard-core)
            └─ pays x402 APIs / transfers, after policy + simulation + (optional) human approval
```

The most a day can cost is capped onchain at the daily cap plus whatever sits in the hot wallet,
even if the offchain guard has a bug.

Live on Robinhood Chain mainnet (USDG) and Solana mainnet (USDC). Base comes next. Base Sepolia is for
development.

> **Public beta (v0.1.0-beta).** DefiMind runs with real money on both chains, but it is new and
> has had no external audit. Put in the vault only what you can afford to lose, and keep the daily
> cap small: the default is 20, and the signing page refuses more than 50. The known risks are in
> [`docs/known-risks.md`](./docs/known-risks.md).

## Start here: one click

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/defimind2023/defimind-app)

Render builds your own DefiMind from this repository, and the owner panel guides you through the
passkey, the vault, the daily limit, the deposit and your first agent. It needs a paid Render
instance with a disk. No terminal is needed until you connect the agent. Step by step, in plain
words: [`docs/getting-started.md`](./docs/getting-started.md). The one-click route is new: report a
step that fails.

## Install the beta on Fly.io

The technical route, with the setup wizard. You need Node 20+, pnpm 10, git, [flyctl](https://fly.io/docs/flyctl/install/), accounts on Fly.io
and Vercel, and a new Phantom wallet used for nothing else. A Telegram bot token from @BotFather is
needed only if you also want the bot; the wizard asks.
On Windows, use WSL2 with Ubuntu.

```bash
git clone https://github.com/defimind2023/defimind-app.git ~/DefiMind
cd ~/DefiMind && pnpm install
pnpm --filter create-defimind start --dry-run   # see every step first, nothing runs
pnpm --filter create-defimind start             # the setup; run it again to continue
```

The wizard creates your keys, your Fly app and your signing page. You sign the vault and the cap
in Phantom, and the wizard creates your first agent in shadow mode: it pays nothing until you switch
it live. At the end it gives you your owner panel's address: open it, enter the setup code it names,
and create your passkey. From the panel you approve payments, change the rules, switch the agent
live and press kill. Then connect the agent from the same checkout:
`pnpm --filter @defimind/mcp-server run setup claude-code`.

- The same setup by hand: [`docs/self-host.md`](./docs/self-host.md).
- How it works and what it protects against: the technical whitepaper,
  [`docs/whitepaper.md`](./docs/whitepaper.md).
- When something goes wrong: [`docs/troubleshooting.md`](./docs/troubleshooting.md).
- Who controls your vaults, and how to protect that key: [`docs/owner-keys.md`](./docs/owner-keys.md).
- Connect an agent: "For agent builders" in
  [`packages/mcp-server/README.md`](./packages/mcp-server/README.md).
- Report a vulnerability privately: [`SECURITY.md`](./SECURITY.md). Anything else: open an issue.

## Read these first

- [`SPEC.md`](./SPEC.md) — the source of truth for all interfaces. Do not change it without owner approval.
- [`docs/adr/`](./docs/adr) — architecture decisions.

## Packages

| Package                                            | Owner      | What it does                                                 |
| -------------------------------------------------- | ---------- | ------------------------------------------------------------ |
| [`packages/shared`](./packages/shared)             | integrator | Types, zod schemas, verified addresses, constants            |
| [`packages/onchain`](./packages/onchain)           | Session 1  | Squads and Safe adapters, signing page, fork tests           |
| [`packages/guard-core`](./packages/guard-core)     | Session 2  | Policy engine, simulation, signer, x402 client, HTTP API, DB |
| [`packages/mcp-server`](./packages/mcp-server)     | Session 3  | MCP server exposing payment tools to agents                  |
| [`packages/panel`](./packages/panel)               | Session 4  | The owner panel: passkey approvals, rules, kill, setup guide |
| [`packages/telegram-bot`](./packages/telegram-bot) | Session 4  | Optional: alerts and the kill in Telegram                    |
| [`e2e`](./e2e)                                     | integrator | End-to-end and attack tests                                  |

## Getting started

Requires Node 20+ (see `.nvmrc`) and pnpm 10.

```bash
pnpm install
pnpm check        # lint + typecheck + test
```

### Running the whole stack

`pnpm dev:all` starts guard-core (:8787) and mcp-server over HTTP (:8789), and telegram-bot (:8788)
only when guard-core's `.env` names a bot (CR-017). It first cross-checks the `.env` files and
refuses to start if they disagree: part of the bot's three set, a webhook secret or token that
differs between guard-core and the bot, the admin token in the bot's `.env`, a service pointed at
the wrong port, or no agent.

1. Copy `packages/guard-core/.env.example` and `packages/mcp-server/.env.example` to `.env`.
   Generate every secret with `openssl rand -hex 32`. For the bot too, copy its `.env.example`,
   set guard-core's `BOT_URL`, `BOT_WEBHOOK_SECRET` and `BOT_TOKEN`, and give the last two to the
   bot as `BOT_WEBHOOK_SECRET` and `GUARD_BOT_TOKEN`. `ADMIN_TOKEN` stays with guard-core: the bot
   only reads and tightens, on its own routes (CR-016).
2. Create an agent: `pnpm --filter @defimind/guard-core create-agent agent-1`. Put the printed
   token in mcp-server's `AGENT_TOKEN`. In mcp-server's `.env`, set `MCP_TRANSPORT=http` and an
   `MCP_HTTP_TOKEN`.
3. Set the agent's policy with `PUT /v1/admin/policy/agent-1`. A new agent's policy denies
   everything.
4. `pnpm dev:all`.

With `GUARD_STUB_CHAINS=true`, guard-core runs on an offline chain that signs nothing. For Solana
devnet, set `SOLANA_RPC_URL`, `SOLANA_HOT_WALLET_KEYPAIR` and `SQUADS_MULTISIG` instead. Without
them every payment is refused. Agent clients that start the MCP server themselves over stdio don't
need it in `dev:all`; see [`packages/mcp-server`](./packages/mcp-server).

On Windows, develop inside **WSL2 + Ubuntu** and clone the repo into the Linux filesystem (`~`), not
`/mnt/c`. Foundry's installer does not run in PowerShell or Cmd, and pnpm and git are far slower across
the `/mnt/c` boundary.

### Branches

`main` is the base: every role branches off it as `feat/<role>` and opens its PR back to it.

The repository's default branch is still `claude/defimind-setup-smlps6`, because GitHub adopts the
first branch pushed to an empty repository and only an account with admin rights can change that. So a
plain `git clone` lands on the wrong branch. Until the default is switched, clone with `main` explicit:

```bash
git clone -b main https://github.com/defimind2023/defimind-app.git
```

In a clone you already have, `git checkout main` is enough — the two branches currently point at the
same commit.

Per-package commands: `pnpm --filter @defimind/guard-core test`.

`packages/onchain` also needs [Foundry](https://getfoundry.sh) for the fork tests (`forge test`).

## Status

Runs on Robinhood Chain and Solana mainnet. Base comes next. What to do in an incident is in
[`docs/runbook.md`](./docs/runbook.md).

## License

[Business Source License 1.1](./LICENSE): run your own DefiMind, for yourself or your organization,
in production. Offering it to others as a hosted or managed service is not allowed. Each version
becomes Apache-2.0 on its Change Date. `vendor/bigint-buffer` keeps its own Apache-2.0 license.
