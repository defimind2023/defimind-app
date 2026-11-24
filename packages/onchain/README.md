# @defimind/onchain

The `ChainAdapter` interface guard-core depends on, and its implementations. **No custom contracts:**
the onchain cap is a Squads v4 Spending Limit on Solana and the Safe Allowance Module on Base, both
audited and already deployed.

- **Source of truth:** [`/SPEC.md`](../../SPEC.md).

## Setting up, end to end

The money flow is the same on both chains. The owner's funds sit in a multisig the owner alone
controls. A daily cap lets the guard's hot wallet draw up to `DAILY_CAP` a day from it, and nothing
else. The kill switch removes that cap, which cuts the hot wallet off. Most a day can cost is
`DAILY_CAP` plus what the hot wallet holds.

Every command below runs from `packages/onchain`, reads its settings from `.env` and prints only
public data: addresses, amounts, transaction ids. No key is ever passed on the command line.

```bash
pnpm install                 # from the repository root
cd packages/onchain
cp .env.example .env         # never commit .env
```

Set `DAILY_CAP` in atomic units (USDC has 6 decimals, so `100000000` is 100 USDC). Do the devnet or
testnet run first; the mainnet steps are the same with the changes listed at the end of each chain.

### Solana

You need the [Solana CLI](https://solana.com/docs/intro/installation), SOL for fees on the owner
account, and USDC to fund the vault.

1. **Keys.** Create the owner key and the hot wallet key, outside the repository:
   ```bash
   solana-keygen new -o ~/.defimind/sol-owner.json
   solana-keygen new -o ~/.defimind/sol-hot.json
   ```
   The hot wallet key goes to guard-core only. Here, set `SOLANA_OWNER_KEYPAIR` to the owner file
   and `SOLANA_HOT_WALLET_PUBKEY` to `solana-keygen pubkey ~/.defimind/sol-hot.json`.
2. **Network.** `SOLANA_CLUSTER` and `SOLANA_RPC_URL` (devnet: `https://api.devnet.solana.com`).
   `USDC_MINT` comes from Circle's list of USDC addresses (never from memory; the values we verified
   are in `packages/shared/src/addresses.ts`).
3. **Fees.** On devnet, `solana airdrop 1 <owner address> -u devnet`.
4. **The multisig.** `pnpm create-multisig` creates a Squads multisig with the owner as its only
   member and config authority. Copy the printed `SQUADS_MULTISIG` into `.env` (and into
   guard-core's). It refuses to run when `SQUADS_MULTISIG` is already set.
5. **The cap.** `pnpm add-spending-limit` adds a spending limit of `DAILY_CAP` per day on USDC, with
   the hot wallet as its only member and its only destination, and prints it as read back from the
   chain.
6. **Funds.** `pnpm fund-vault <atomic units>` moves USDC from the owner to the vault. The vault and
   the multisig are different addresses; the cap draws from the vault, so fund that one.
7. **Check.** `pnpm status` reads the whole setup back from the chain; `pnpm balances` shows each
   account. To see the cap work, `SOLANA_HOT_WALLET_KEYPAIR=~/.defimind/sol-hot.json pnpm top-up
<amount>` draws on it as guard-core would, and a draw past the cap is refused by Squads.
8. **Kill switch.** `pnpm kill` shows what it would remove; `pnpm kill --yes` removes the limit.
   Only `add-spending-limit` undoes it.

**For mainnet:** `SOLANA_CLUSTER=mainnet-beta`, a mainnet RPC, the mainnet USDC mint, and the owner
on a Ledger (`SOLANA_OWNER_KEYPAIR=usb://ledger?key=0`) from step 4 on, so that the Ledger is the
config authority. Read [The owner on a Ledger](#the-owner-on-a-ledger) before the first action.

### Base

You need Base Sepolia ETH for gas on the owner account (or the executor's, with a Ledger) and USDC
to fund the Safe.

1. **Check the chain has what the scripts need.** The Allowance Module must hold code at its
   address, and guard-core's simulation needs an RPC that serves `eth_simulateV1`. One command
   checks both, with no key:
   ```bash
   BASE_RPC_URL=https://sepolia.base.org pnpm check:simulate
   ```
   It must print `eth_simulateV1 supported` and `Allowance Module 0xAA46…091C: deployed`. CI runs it
   against Base Sepolia in the `eth_simulateV1 on Base Sepolia` job.
2. **Settings.** `BASE_CHAIN_ID=84532`, `BASE_RPC_URL`, the owner (`OWNER_SIGNER=key` with
   `OWNER_PRIVATE_KEY` on testnets), `HOT_WALLET_ADDRESS` (the guard's hot wallet; its key goes to
   guard-core only). On Base Sepolia `shared/addresses.ts` has both USDC and the Allowance
   Module, so leave `BASE_USDC` and `BASE_ALLOWANCE_MODULE` empty. On Base mainnet, USDC still comes
   from `.env`, read from Circle's list, until shared has it. The scripts refuse an address with no
   code, and a token that does not report 6 decimals.
3. **The Safe.** `pnpm create-safe` deploys a Safe 1.4.1 with the owner as its only owner,
   threshold 1. Copy the printed `SAFE_ADDRESS` into `.env` (and guard-core's). It refuses to run
   when `SAFE_ADDRESS` is already set.
4. **The cap.** `pnpm enable-allowance` sends one Safe transaction that enables the Allowance
   Module, adds the hot wallet as delegate and sets a USDC allowance of `DAILY_CAP` resetting every
   1440 minutes, then prints it as read back.
5. **Funds.** Send USDC to `SAFE_ADDRESS` from any wallet. There is no script for it.
6. **Check.** `pnpm status:base` reads owners, threshold, the module, the Safe's USDC and the
   allowance from the chain.
7. **Kill switch.** `pnpm kill:base` shows the allowance; `pnpm kill:base --yes` removes the hot
   wallet as delegate together with its allowances. Only `enable-allowance` undoes it.

**For mainnet:** `BASE_CHAIN_ID=8453`, a mainnet RPC and mainnet USDC. The scripts refuse mainnet
unless the owner is a Ledger: `OWNER_SIGNER=ledger`, `OWNER_LEDGER_PATH`, and an
`EXECUTOR_PRIVATE_KEY` that pays the gas. Read
[The Safe owner on a Ledger](#the-safe-owner-on-a-ledger) first, and create the Safe with the
Ledger as owner from the start.

## Reference

### Hot wallet gas

`getHotWalletGas()` returns the hot wallet's native coin and the `minimum` that a few draws and
payments need. guard-core's doctor warns below it.

- **Solana:** two token accounts' rent and ten 5,000-lamport fees, plus a quarter: about 0.0052
  SOL. A top-up creates the hot wallet's USDC account if it is missing, and a direct payment
  creates the recipient's, both paid by the hot wallet. On x402 payments the facilitator pays the
  fees.
- **EVM:** four calls at 250,000 gas each, at the current max fee per gas. On Robinhood Chain the
  gas a transaction uses includes its L1 data cost, so this is well above an L1 draw's.

### Swaps (CR-021, Solana through Jupiter)

Swaps run only on Solana mainnet, where Jupiter routes. On any other cluster the adapter has no
`quoteSwap` and refuses every swap with `VENUE_NOT_ALLOWED`. Jupiter is untrusted throughout, and any
doubt is a rejection.

- **`quoteSwap({ tokenIn, tokenOut, amountIn, slippageBps })`**
  - One side must be the chain's dollar.
  - Jupiter's quote is held to the request: same mints, amount and slippage, and a minimum no looser
    than the slippage allows.
  - Both mints are read from the chain, which gives `decimalsIn` and `decimalsOut`.
  - On a buy, the token bought is also checked:
    - a freeze authority is `TOKEN_FREEZABLE`;
    - any Token-2022 extension outside a short harmless list (metadata, group, close authority) is
      `TOKEN_EXTENSION_RISK`;
    - a remaining mint authority adds the `MINT_AUTHORITY` flag;
    - a sell quote for the amount bought sets `exitImpactBps`. When Jupiter has no route back, that
      is `null` with `NO_EXIT_ROUTE`.
  - It throws `SwapUnavailable` with `code` `venue_unavailable` (Jupiter down or malformed) or
    `no_route`.
- **`simulate(intent)` for `kind: "swap"`**
  1. It re-quotes. A fresh quote below the intent's `minAmountOut` is `SLIPPAGE_TOO_HIGH`.
  2. It takes Jupiter's transaction, with wrapped SOL left wrapped.
  3. It reads its lookup tables from the chain. A table that is missing, closing or changed in the
     last 150 slots is `HIDDEN_ACCOUNTS_DETECTED`.
  4. It inspects the expanded message. It must have one Jupiter route, compute budget within limits,
     a priority fee of at most 0.001 SOL, and only the hot wallet's own token accounts created. It
     must have no other signer, no System instruction and no top-level token instruction. An
     Approve, a SetAuthority or a CloseAccount gets its own code.
  5. It runs the transaction and compares the hot wallet's token accounts before and after:
     - `tokenIn` falls by at most `amountIn`;
     - `tokenOut` rises by at least `minAmountOut`;
     - no other account falls;
     - SOL pays the fee, the priority fee and the rent of new accounts only;
     - every account stays the hot wallet's alone: no delegate, no close authority, not frozen, not
       closed.

     Anything else is `SIM_UNEXPECTED_EFFECT`.

  6. `balanceChanges` lists the net change per mint, with no SOL entry.
- **`send(intent)`** signs only the transaction that passed `simulate`, once. Otherwise it throws
  `swap_not_simulated`. After an owner's approval, call `simulate` again. A buy does not draw on the
  vault, so guard-core tops up first.
- **`getPositions()`** returns every token the hot wallet holds but the dollar, in Token and
  Token-2022 accounts, with decimals read from the mint.

**Fork test.** `test/swap-fork.test.ts` runs a real Jupiter route in LiteSVM: 1 USDC for wrapped SOL
through a Whirlpool, executed by Jupiter's and Whirlpool's own programs. `pnpm record:swap` recorded
that route from mainnet, with every account it touches at one slot, into `test/fixtures/`.

Third-party program binaries are never kept in the repository. The fixture names each program by id
and by the slot its code was deployed at. The test reads that code from mainnet into
`packages/onchain/.cache/programs/` (gitignored), or from that cache when it is already there:

- **Offline,** the test is skipped by name, with the reason.
- **If a program was redeployed since the recording,** the test is skipped too.
- **With `FORK_REQUIRED=1`,** either case fails the test instead. CI sets it. The hot
  wallet is a key made for the recording, so no real funds are involved. The test checks three things:

- the route passes the checks and the test run, and lands exactly the balances checked;
- the same transaction, with its route's slippage opened to 100%, is refused;
- an approved minimum the route cannot reach is refused.

To refresh the fixtures, run `pnpm record:swap` again.

### Token risk (CR-025)

`tokenRisk(mint)` (Solana mainnet, with the swap venue) feeds the owner's risk card with facts only:
the mint's decimals, whether a freeze or mint authority is set, its Token-2022 extensions by name,
and the CR-021 rejections a buy would meet (`TOKEN_FREEZABLE`, `TOKEN_EXTENSION_RISK`,
`NO_EXIT_ROUTE`). `exit` is the price impact of selling what 10 USD buys back to the dollar, or null
with no route. A venue that is down throws; it is never read as "no route". The approval flags and
the venue's own facts are guard-core's. Tested against mainnet USDC, JUP and PYUSD mint accounts.

### Landed changes (ON-32)

`getLandedChanges(txId)` (Solana) returns what a confirmed transaction really moved for the hot
wallet: `{ token, delta }[]`, signed atomic deltas netted per mint from the transaction's own pre and
post token balances, none zero, SOL left out. A swap lands at its own price, never exactly the test
run's, so positions are booked from this. A failed transaction throws `tx_failed`, one the RPC does
not have yet `tx_not_found`. Tested against a recorded mainnet buy, Close and top-up.

### Vault (CR-019)

`getVault()` returns `{ address, token, balance }`. This is the vault deposits go to: the Squads
vault at index 0 of the multisig, or the Safe itself. `token` is the chain's stablecoin and
`balance` is read from the chain. A vault that has never held the token reports `'0'`.

`control` (CR-022) is `{ threshold, signers }`: how many signatures move the funds, out of how many
keys, read from the chain on every call. A Safe reports `getThreshold()` and `getOwners()`. An
autonomous Squads multisig reports its threshold out of the members who can vote. A controlled one
(every DefiMind deployment, since the kill needs a config authority) reports `{ threshold: 1,
signers: 1 }`: its config authority can add itself a spending limit and empty the vault with no vote,
whatever the threshold says.

### Agent wallets (CR-022)

An agent with its own wallet is one more hot wallet on the same multisig or Safe. Build an adapter
for it exactly as for the shared one, with the agent's key as `hotWallet` (Solana) or as the
wallet's account (EVM). `getAllowanceState`, `buildKillTx` and every payment then act on that
wallet's own limit only: on Solana the spending limit whose PDA derives from the agent's key, with
it as the only member and destination; on EVM the Allowance Module delegate for the agent's address,
with its own allowance. Killing one never touches another's.

`signPageHtml` takes `agents` per cluster next to `hot`. The page grants add-limit or enable to the
shared wallet or any of those, and refuses every other key; a link naming no hot wallet means the
shared one. The hosted page has none and never serves add-limit.

### Anchors (CR-013)

`createSvmAnchor({ chain, rpcUrl, secretKey })` returns `{ chain, publish(memo) }`. `publish`
sends one transaction holding one SPL Memo v2 instruction. The anchor key signs it and pays the
fee, and `publish` returns the signature once the transaction is confirmed. The key is
`ANCHOR_KEY_FILE`: a keypair of its own that holds only fees, never the hot wallet. Each anchor
costs one 5,000-lamport fee. The memo is `defimind:anchor:v1:<fromSeq>-<toSeq>:<rootHex>`, which
guard-core builds; this package does not parse it.

The anchor key is passed to the Memo program as a signer account. Memo v2 fails unless that key
signed, so the memo is tied to the key on chain as well as by the fee payer.

`readMemo(rpcUrl, txId)` gives the memo of a confirmed transaction, for `defimind-verify`.
`memoOf(connection, txId)` also gives the signer. Both give `undefined` in three cases:

- the transaction is missing;
- the transaction failed;
- the transaction carries no memo, or more than one.

### Solana adapter

`createSvmAdapter({ chain, rpcUrl, hotWalletSecretKey, multisig, mint })` returns a `ChainAdapter`
built from plain values, so guard-core never handles a Solana SDK type.

| Method                | What it does                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getAllowanceState`   | Cap, spent and next reset, read from the spending limit account                                                                                                                                                                                                                                                                                                                              |
| `getHotWalletBalance` | The hot wallet's token account; zero when it has none                                                                                                                                                                                                                                                                                                                                        |
| `topUpHotWallet`      | Draws on the spending limit into the hot wallet, creating its token account first if it has none. The Squads program refuses anything past the cap                                                                                                                                                                                                                                           |
| `simulate`            | Builds the exact message `send` would sign, runs `inspectTransfer`, then `simulateTransaction`. A hot wallet short of the amount gets the spending-limit draw for the shortfall in front of the payment, in the simulation only, and the vault must fall by exactly that. Both payment balances must move by exactly the amount, or `SIM_UNEXPECTED_EFFECT`. A `SIM_FAILED` summary says why |
| `send`                | Rebuilds, re-inspects, signs and confirms a `TransferChecked` from the hot wallet                                                                                                                                                                                                                                                                                                            |
| `buildKillTx`         | The unsigned `removeSpendingLimit` instruction for the config authority, as JSON, with a description for the owner                                                                                                                                                                                                                                                                           |
| `checkPayment`        | The same inspection and simulation for an x402 transaction guard-core did not build                                                                                                                                                                                                                                                                                                          |
| `x402Scheme`          | A scheme client for `@x402/core` bound to one intent. The hot wallet signs only after the SDK's transaction passes the inspection and the simulation; otherwise it throws `SigningRefused` with the reasons (CR-003)                                                                                                                                                                         |

#### Tests

```bash
pnpm --filter @defimind/onchain test
```

The adapter tests run against [LiteSVM](https://github.com/LiteSVM/litesvm) 1.x: the token,
associated token and memo programs execute for real, and only the RPC transport is faked
(`test/litesvm.ts`). LiteSVM 1.x speaks `@solana/kit`, so `test/svm.ts` converts at the boundary;
the 0.x releases, which spoke web3.js, abort with `std::bad_alloc` after a few program runs.

`test/cap.test.ts` proves the onchain cap with the real Squads v4 program, which gives every verdict:
a draw up to the cap succeeds, `cap + 1` is refused with `SpendingLimitExceeded`, the limit refills
after a warped day, and after the kill, signed by the owner through the fake Ledger, a draw is
refused because the limit account no longer exists. The program binary in `test/fixtures` was
dumped from mainnet:

```bash
solana program dump -u m SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf \
  packages/onchain/test/fixtures/squads_v4.so
```

`pnpm check:squads` reads Squads v4 on mainnet (or `SOLANA_RPC_URL`) and fails if the deployed
program is no longer this binary. It also prints the program config the create page reads: the
creation fee and the treasury it goes to. The tests plant a config with no fee by default, and one
create test plants a mainnet-like fee and checks that the treasury receives it.

#### The owner on a Ledger

Every script the owner signs (`create-multisig`, `add-spending-limit`, `fund-vault`, `kill`) takes
`SOLANA_OWNER_KEYPAIR` as either a keypair file or a Ledger URI in the Solana CLI's form:
`usb://ledger` is `44'/501'`, `usb://ledger?key=0` is `44'/501'/0'`. The key never leaves the
device; the scripts send it the exact message and add the signature it returns, through the official
`@ledgerhq/hw-app-solana` client. The owner pays the fee, so each action is one confirmation.

Setup, once per device:

1. In Ledger Live, install the **Solana** app.
2. Leave **Blind signing** off (Solana app, Settings). The app cannot display Squads instructions,
   so each Squads action needs it on, but only for that action; the steps below say when. Plain SOL
   and token transfers show in clear without it.
3. Read the owner address: `solana-keygen pubkey usb://ledger?key=0`. It is the same address the
   scripts use.

**Blind signing removes the device's main protection.** While it is on, the device cannot show what
it signs, so a compromised computer could replace the kill with a transaction that hands the vault
over, and the device would still sign it. The one check left is the message hash. Before the device
is asked to sign, every script prints the hash the Solana app will show, computed the same way the
app does (base58 of the SHA-256 of the message, as in `src/handle_sign_message.c` of
`LedgerHQ/app-solana`):

```
If the Ledger shows a Message Hash, it must read exactly: 7Xk...
Approve only on an exact match. On any difference, reject on the device.
```

For each action:

1. Plug the Ledger in, unlock it and open the Solana app.
2. Turn **Blind signing** on (Settings in the Solana app).
3. Run the script. For the kill switch:
   ```bash
   SOLANA_OWNER_KEYPAIR='usb://ledger?key=0' pnpm kill --yes
   ```
4. Compare the **Message Hash** on the device with the printed one, character by character. Approve
   only if they match exactly; otherwise reject and treat the computer as compromised. Do this within
   a minute, before the blockhash expires.
5. Turn **Blind signing** off again. The script reminds you once the device has signed.

`kill` refuses before asking the device when the Ledger account is not the multisig's config
authority, which is the only key that can remove the limit.

A multisig created with a file key keeps that key as its config authority. On mainnet, create the
multisig with the Ledger from the start. If the authority ever has to move, the Squads SDK has
`multisigSetConfigAuthority`; no script here wraps it yet.

The tests drive the real `hw-app-solana` client against a fake device (`test/ledger.ts`) that speaks
the Solana app's APDUs, signs with real ed25519 keys and refuses unknown programs while blind
signing is off. It records the Message Hash it would display, and the tests check that it equals the
hash the script printed. `test/cap.test.ts` signs the kill with it.

#### The owner in Phantom: the signing page

The scripts cannot sign with Phantom, so the owner signs through a static page in `web/`. The
design is in [ADR 003](../../docs/adr/003-phantom-owner.md).

- **The link carries the action and public addresses only.** Each action builds its instruction
  with the same builder as the script it replaces:

  | Link                                                                                | Instruction                   | Builder                          |
  | ----------------------------------------------------------------------------------- | ----------------------------- | -------------------------------- |
  | `/?action=create&cluster=<cluster>`                                                 | `multisigCreateV2`            | `createMultisigInstruction`      |
  | `/?action=add-limit&cluster=<cluster>&multisig=<pda>[&amount=<base units>]`         | `multisigAddSpendingLimit`    | `addSpendingLimitInstruction`    |
  | `/?action=kill&cluster=<cluster>&multisig=<pda>&hot=<pubkey>&issued=<unix seconds>` | `multisigRemoveSpendingLimit` | `removeSpendingLimitInstruction` |
  | `/?action=deposit&cluster=<cluster>&multisig=<pda>[&amount=<base units>]`           | SPL `transferChecked`         | `transferInstructions`           |

  The limit's address is derived from the hot wallet, so the page adds and removes the limit the
  adapter draws on and nothing else. The USDC mint comes from `shared/addresses.ts` at build time,
  never from the link. So does the hot wallet that add-limit grants: a link naming any other key is
  refused, since a crafted one could otherwise let an attacker's key draw the full cap. Rotating the
  hot wallet is a redeploy from `main`. The amount must not exceed `MAX_DAILY_CAP`.
  The link may leave the amount out. On add-limit, and on enable on EVM, the owner then types the
  daily cap in dollars on the page. The page refuses anything above `MAX_DAILY_CAP` and says that
  this ceiling is for the beta only.
  **Deposit** moves the owner's own USDC into the vault the chain derives from the multisig, as a
  plain transfer. On Solana it first creates the vault's token account if it is missing. It grants
  no delegate, approval or authority. Only a member of the multisig may deposit, and only an owner
  of the Safe; the page refuses anyone else before it asks for an amount. It needs no hot wallet,
  so it works on the hosted page for any deployment. Create makes its one-time create key in the browser; the key signs before
  Phantom does. A kill link carries `issued`, when the bot made it, and the page refuses it once it
  is more than 15 minutes old ("This link expired. Press Stop everything in your DefiMind panel, or send /kill to the bot, for a fresh one"), so a
  button left in an old message cannot remove the limit out of step with guard-core. After a kill,
  the page tells the owner to check in the panel that guard-core is paused (or with `/status`, with
  the Telegram bot).

  **If the bot is down,** build the kill link by hand. Its values are public: the multisig and the
  hot wallet from guard-core's `.env`, and the page's own URL. It is good for 15 minutes:

  ```bash
  issued=$(date +%s)
  echo "https://<signing page>/?action=kill&cluster=mainnet-beta&multisig=<SQUADS_MULTISIG>&hot=<SOLANA_HOT_WALLET_PUBKEY>&issued=$issued"
  ```

  Open it in a browser with the Phantom extension. On a phone, open it inside Phantom through
  `https://phantom.app/ul/browse/<the link, URL-encoded>`.

- **It checks the chain before asking Phantom.** The multisig must belong to the Squads program and
  have the connected wallet as its config authority. Add-limit refuses when a limit already exists:
  changing the cap means a kill, then a new limit. A kill still removes a limit with unexpected
  members or destinations, with a warning shown.
- **It shows the summary, then asks Phantom right away.** It uses `signAndSendTransaction`, then
  reads the chain until the change is there, and checks it is what was signed.
- **Proof of cap, for anyone, with no wallet:** `/?action=proof&cluster=<cluster>&multisig=<pda>` on
  Solana, or `&safe=<address>` on Robinhood. It only reads the chain, through the page's own RPCs.
  It never loads a wallet, and nothing on the way asks for a signature.
  - **The headline:** "The most this agent can draw in the next 24 hours: X". X is what is left
    before the next reset plus the whole cap again after it, because the reset always falls within
    a day. The vault's balance bounds X. Both numbers are shown, with the reset time. After a kill,
    X is 0.
  - **Agent wallets (CR-022):** a page built with agents' own wallets counts every one of them, and
    the headline becomes "The most this deployment's agents can draw in the next 24 hours: X". X adds
    up each wallet's own window, one line per wallet, still bounded by the vault's balance. The
    wallet list comes from the build, never from the link, so a limit or delegate outside it is still
    flagged.
  - **Below it:** the vault's owner, members and threshold (Squads), or its owners and threshold
    (Safe), and the vault's balance.
  - **"Verified" needs all of these.** Otherwise the headline is "Not verified", followed by what
    the page found:
    - Squads: the only member is the config authority, and that authority is not the hot wallet.
      The only spending limit is the one the agent uses, for the hot wallet only, into itself, in
      USDC, daily, on vault 0.
    - Safe: the proxy runs the canonical SafeL2 1.4.1 (storage slot 0), and it has one owner at
      threshold 1 who is not the hot wallet. No module other than the Allowance Module is enabled.
      Its only delegate is the hot wallet, with allowances in USDG only, resetting every 1440
      minutes.
  - **Every spending right counts.** On Squads, the page lists every spending limit on the
    multisig with `getProgramAccounts`. **Its RPC must serve that call** with memcmp filters on the
    Squads program. If any read fails, the page says it could not verify, never a lower number.
  - **Resets:** Squads refills a limit lazily and moves its reset forward by whole days. The
    Allowance Module applies its reset when read.

- **In a browser without Phantom,** it links to `https://phantom.app/ul/browse/<page>`, which opens it
  inside Phantom.
- **The build fixes what a link must not choose:**
  - the RPC endpoints, where `SOLANA_MAINNET_RPC` and `SOLANA_DEVNET_RPC` override the public
    defaults;
  - the hot wallet per cluster, `SOLANA_HOT_WALLET_MAINNET` and `SOLANA_HOT_WALLET_DEVNET`;
  - `MAX_DAILY_CAP`, in base units, 50 USDC unless set (D1).

- **Hot wallets per cluster (CR-020).**
  - **A build with a hot wallet for the cluster** acts for that one only. A link naming any other
    hot wallet is refused.
  - **A build with none for the cluster** serves only create, deposit and kill there. This is the
    case of the one hosted page, `HOSTED_SIGN_PAGE` in shared, which serves every deployment:
    - A kill takes the hot wallet from the link, which must name it. It can only remove authority:
      the limit is derived from the multisig and that key, or the delegate is removed from that
      Safe.
    - If the link's hot wallet has no limit or allowance, the page says "No limit found for this
      hot wallet. Check Spending limits in your vault's app.", never "Already killed".
    - add-limit and enable are refused ("Open this from your DefiMind panel: it needs your
      deployment's own page").
  - **The wallet checks stay on both kinds of build.** The connected wallet must be the config
    authority, or the Safe's only owner. The decoded-bytes stop also stays.
  - **A link naming another key's limit on the owner's own multisig** removes that limit only. That
    can stop an agent, but it cannot move funds.
- **Building the hosted page.** Run `pnpm --filter @defimind/onchain build:web` with no
  `*_HOT_WALLET_*` variable set. On Vercel this is its own project:
  - root `packages/onchain/web`, so `web/vercel.json` applies, with no environment variables at all;
  - production branch `main`, with preview deployments off;
  - public RPCs and USDC/USDG from shared, and no hot wallet.

  The CSP allows scripts and styles from the page's own origin and connections to those endpoints
  only. Its one relaxation is `'unsafe-eval'` in `script-src`: Phantom's injected provider compiles
  with `new Function` under the page's policy, and connect fails without it. ADR 003 records the
  exception, and a test pins the whole policy.

```bash
pnpm build:web   # web/dist, ready for any static host
pnpm test:web    # Chromium, against the real Squads program in LiteSVM, with a stand-in for Phantom
```

`web/vercel.json` deploys it as its own project, separate from the landing site, only from `main` (its `ignoreCommand` skips every other branch, previews included), with the security
headers. The owner creates that project and protects its deploys.

**What the transaction itself does (CR-019).** Before every Phantom prompt, the page shows the
transaction decoded from its own bytes, in large text under its summary. It shows who gains a right
or receives tokens, and how much:

- the members, destinations, token and amount of a spending limit;
- the delegate and allowance of a Safe call;
- the recipient of a transfer.

None of it is taken from the link or from whoever served the page. For a transfer, the bytes name
only the token account, so the page reads that account's owner from the chain, or from the
account-creating instruction in the same transaction. An instruction it cannot read says so, and
says to reject. Compare these lines with Phantom's screen before you approve.

**Build hash.** `pnpm build:web` writes `SHA256SUMS` next to the build and prints it. It covers
`app.js`, `style.css` and `index.template.html`, which are the same for every deployment because
none of them holds a config. A release publishes these hashes. To check a `/sign`, compare
`curl -s https://<guard-core>/sign/app.js | sha256sum` with them.

**Served by guard-core at `/sign` (CR-019).** `app.js` holds no address. Everything the page acts for
is a JSON config inside `index.html`, which the page reads once at load:

- the RPC endpoints;
- the hot wallets;
- the tokens and modules;
- `maxDailyCap`.

The hosted build fills that config from its env at build time. guard-core instead fills it at serve
time, with its own hot wallets, through `@defimind/onchain/sign-page`:

```ts
import { SIGN_PAGE_DIR, signPageHtml } from '@defimind/onchain/sign-page'

signPageHtml({
  solana: { 'mainnet-beta': { rpc, hot } }, // and/or devnet
  evm: { robinhood: { rpc, hot } }, // and/or robinhood-testnet
  maxDailyCap: '50000000',
})
// GET /sign/ -> that HTML; /sign/app.js and /sign/style.css -> files in SIGN_PAGE_DIR
```

What the caller can set, and what it cannot:

- **Per cluster, only the RPC and the hot wallet.** USDC, USDG, the Allowance Module and the chain
  ids always come from the verified addresses in `@defimind/shared`.
- **Validation:** the input is checked with zod. An unknown cluster, an extra field, an RPC that is
  not http(s), or a malformed key throws.
- **Escaping:** every `<` in the JSON is escaped, so no value can close the script element.
- **Build step:** `SIGN_PAGE_DIR` is `web/dist`, so the image must run `pnpm build:web` first.

### Base adapter

A Safe holds the funds and the Safe Allowance Module caps the hot wallet per day. Neither is ours.

`createEvmAdapter({ chain, rpcUrl, hotWalletKey, safe, usdc, module })` is the `ChainAdapter`:

- `topUpHotWallet` calls `executeAllowanceTransfer` as the delegate itself (an empty signature), so
  the module's cap is the only limit and no relayer is paid.
- `simulate` runs one `eth_simulateV1` block: the Safe, hot wallet and recipient balances, the
  transfer, the three balances again, so before and after are read against the same state.
  guard-core tops the hot wallet up only after the simulation clears, so when the hot wallet holds
  less than the amount, the block starts with the `executeAllowanceTransfer` for the shortfall. The
  Safe must fall by exactly the shortfall and the recipient rise by exactly the amount, or
  `SIM_UNEXPECTED_EFFECT`. A `SIM_FAILED` summary names the call that reverted and its revert
  string; a top-up past the allowance says the allowance cannot cover it.
- `x402Scheme` gives the `@x402/evm` client a signer that can only sign typed data, and only an
  EIP-3009 `TransferWithAuthorization` for this USDC, chain, payer, recipient and amount, valid for
  at most an hour. Any other typed data, Permit and Permit2 included, is `PERMIT_DETECTED`. It has
  no transaction signer and no EIP-7702 authorization, so approval and delegation paths have
  nothing to sign with. What gets signed is rebuilt from the checked values, not passed through.
- `buildKillTx` is one Safe call, `removeDelegate(hot, true)`, unsigned, for an owner.

**Two differences from Solana that the owner should know:**

- The Allowance Module does not pin where a draw goes. `executeAllowanceTransfer` takes any `to`,
  so a stolen hot key could send the day's allowance straight to an attacker instead of through the
  hot wallet. On Solana the spending limit's destination list holds the hot wallet alone. The loss
  bound is the same on both chains (the daily cap plus the hot wallet balance), since the hot key
  can pay anyone with what it holds anyway; what Base loses is the extra step. The module has no
  recipient restriction to turn on, and the transaction guard of Safe 1.4.1, the version we deploy,
  does not see module transactions.
- On mainnet (`BASE_CHAIN_ID=8453`) the scripts refuse a raw `OWNER_PRIVATE_KEY`: the Safe owner
  must be a Ledger (`OWNER_SIGNER=ledger`), below.

#### The Safe owner on a Ledger

`OWNER_SIGNER=ledger` makes `create-safe`, `enable-allowance` and `kill:base` sign as the account at
`OWNER_LEDGER_PATH` (default `44'/60'/0'/0/0`, Ledger Live's first Ethereum account) through the
official `@ledgerhq/hw-app-eth` client. The device signs only the Safe transaction's EIP-712 hash.
A separate `EXECUTOR_PRIVATE_KEY` pays the gas and submits it; it owns nothing, so the most it can
lose is its own ETH, and the owner confirms once per action.

The Ethereum app cannot show a Safe transaction's fields, only two hashes, and it signs hashes only
with **Blind signing** on; otherwise it refuses, and the scripts say to turn it on. Before asking the
device, the scripts print both hashes exactly as the app displays them, `0x` and uppercase hex
(app-ethereum `sign_message_eip712_common/common_712.c`, formatted by the plugin SDK's
`array_bytes_string`), and refuse to sign if their hash differs from the one protocol-kit will
submit:

```
With Blind signing on in the Ethereum app:
The Ledger will show Domain hash:  0x88FB…
                   and Message hash: 0x3C1A…
(safeTxHash 0x…)
Approve only if both match the device exactly. On any difference, reject on the device.
```

For each action:

1. Plug the Ledger in, unlock it and open the Ethereum app.
2. Turn **Blind signing** on (Settings in the Ethereum app).
3. Run the script, for the kill switch `OWNER_SIGNER=ledger pnpm kill:base --yes`.
4. Compare both hashes on the device with the printed ones, character by character. Approve only
   if both match exactly; otherwise reject and treat the computer as compromised.
5. Turn **Blind signing** off again. The script reminds you once the device has signed.

As on Solana, the Safe must be created with the Ledger as owner from the start. The tests drive the
real `hw-app-eth` client against a fake device (`test/evm-ledger.ts`) and check that its signature
recovers to the device address, that the printed hashes are character for character what it would
display, and that it refuses while Blind signing is off.

Safe's official list has no Allowance Module entry for Base Sepolia, so `shared/addresses.ts` lists
it there on a different proof (CR-005): the fork test `test_moduleOnSepoliaIsTheMainnetCode` checks
that its runtime code hash equals the official Base mainnet deployment's. `pnpm check:simulate`
prints the hash on any chain.

#### Fork tests

`forge/AllowanceCap.t.sol` proves the same four properties as the Solana cap tests, against the
official Allowance Module on a Base mainnet fork pinned to a fixed block. A Safe is created through
the official proxy factory, the owner enables the module, adds the hot wallet as delegate and sets a
100-unit daily allowance on a test token, and then:

1. the delegate draws up to the cap;
2. `cap + 1` reverts;
3. after a day the allowance refills;
4. after the kill, exactly the call `buildKillTx` builds (`removeDelegate(hot, true)`),
   `getTokenAllowance` returns 0 and a draw reverts.

The token is a test token on purpose: the cap is the module's, and this way no token address is
assumed. CI runs them in the `forge test (onchain)` job. On a machine with Foundry:

```bash
pnpm --filter @defimind/onchain test:fork
```

`BASE_FORK_RPC_URL` overrides the public endpoint (`https://mainnet.base.org`); the fork block needs
an RPC that serves historical state, so a public endpoint that prunes will fail in `setUp`.
`BASE_FORK_BLOCK` overrides the pinned block. The module is not there yet at block 30,000,000, so the
pin is recent and has to move forward when the RPC stops serving its state.

`simulate()` needs `eth_simulateV1`, which not every provider serves. One command checks an endpoint,
with no key, printing only its answer:

```bash
BASE_RPC_URL=https://sepolia.base.org pnpm --filter @defimind/onchain check:simulate
```

### Robinhood Chain

The Base adapter serves Robinhood Chain as it is: the same Safe 1.4.1 and Allowance Module 0.1.1, at
the same addresses with the same code ([`docs/robinhood-research.md`](./docs/robinhood-research.md)).
Pass `eip155:46630` (testnet) or `eip155:4663` (mainnet) as the chain. What differs is the token:
USDG from Paxos, at the one address per chain in `shared/addresses.ts`. Anything else is refused,
whatever its symbol.

- **The signing gate checks the token's own EIP-712 domain** (`src/evm/tokens.ts`): ("Global Dollar",
  "1") for USDG, ("USD Coin", "2") and ("USDC", "2") for USDC on Base. The x402 server picks the name
  and version, so a mismatch is refused (`SIM_UNEXPECTED_EFFECT`). The forge tests check every entry
  against the token's `DOMAIN_SEPARATOR` on its chain.
- **Paxos's reverts read as words in `SIM_FAILED`**: `AddressFrozen` (the issuer froze an address in
  the payment), `ContractPaused`, `InsufficientFunds` and the EIP-3009 errors.
- **A payment counts as made only on the token's own Transfer event**, from the hot wallet to the
  recipient for exactly the amount, on every EVM chain. A successful receipt without that event is
  `payment_unproven`.
- **Settings** use the `ROBINHOOD_*` names guard-core reads: `ROBINHOOD_CHAIN`, `ROBINHOOD_RPC_URL`,
  `ROBINHOOD_SAFE_ADDRESS` and `ROBINHOOD_HOT_WALLET_ADDRESS` (see `.env.example`). There is no owner
  key: on Robinhood the owner signs in Phantom, on the signing page (D4). `pnpm status:robinhood` reads the setup from the chain: the owners, the threshold, the module,
  the Safe's USDG and the allowance.
- **The signing page on Robinhood:** one Phantom transaction per action, from the owner's
  account. Phantom's EVM provider (`window.phantom.ethereum`) must switch to the chain first, or the
  page stops.

  | Link (`cluster=robinhood-testnet` or `robinhood`)                      | Sends                                                                                                              |
  | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
  | `/?action=create&cluster=<cluster>`                                    | `createProxyWithNonce` on Safe's factory: SafeL2 1.4.1, the owner alone, threshold 1                               |
  | `/?action=enable&cluster=<cluster>&safe=<Safe>[&amount=<base units>]`  | `execTransaction` → MultiSendCallOnly: `enableModule`, `addDelegate(hot)`, `setAllowance(hot, USDG, amount, 1440)` |
  | `/?action=deposit&cluster=<cluster>&safe=<Safe>[&amount=<base units>]` | `transfer(safe, amount)` on USDG                                                                                   |
  | `/?action=kill&cluster=<cluster>&safe=<Safe>&issued=<unix seconds>`    | `execTransaction` → `removeDelegate(hot, true)`, the call `buildKillTx` builds                                     |
  - The Safe calls carry the Safe's pre-validated signature (r = owner, v = 1). The Safe accepts it
    only with the owner as `msg.sender`, so nothing is signed off-chain. The batch is a delegatecall
    into MultiSendCallOnly, which itself refuses delegatecalls.
  - Create uses a new salt on each page load and names the Safe's address, from a dry run of the
    same call, before Phantom asks. Afterwards it prints `ROBINHOOD_SAFE_ADDRESS` for guard-core.
  - Enable and kill refuse unless the connected account is the Safe's only owner at threshold 1.
    Enable refuses when the hot wallet already has an allowance (kill first), leaves `enableModule`
    out when the module is already on (after a kill), and caps `amount` at `MAX_DAILY_CAP`.
  - Every call runs as `eth_call` from the owner first; the page does not ask Phantom if it would
    revert.
  - The module and USDG come from shared at build time, and the hot wallet from
    `ROBINHOOD_HOT_WALLET_TESTNET` and `ROBINHOOD_HOT_WALLET_MAINNET`. A `hot` in a link must match
    the built-in one, or the page refuses. `ROBINHOOD_TESTNET_RPC` and `ROBINHOOD_MAINNET_RPC`
    override the public RPCs. Kill links have the same 15-minute `issued` rule as on Solana.
  - `forge/SigningPage.t.sol` runs the page's exact bytes on a fork of **each** Robinhood chain,
    testnet and mainnet, against that chain's real factory, MultiSendCallOnly, Allowance Module and
    USDG: create, enable, kill, enable again. From anyone but the owner, the Safe calls revert. The
    bytes are in `forge/fixtures/signing-page-<cluster>.json`, generated from the page's builders
    and build values and kept equal to them by `test/web-evm.test.ts`.

## Addresses

Do **not** hardcode a guessed address. Read the Allowance Module address from the official Safe
deployment list and USDC from Circle's official list, then report both in
a change to [`/SPEC.md`](../../SPEC.md) before they are added to
`packages/shared/src/addresses.ts`.
