# Incident runbook

**Who presses kill:** the owner, anyone in `OWNER_TELEGRAM_IDS`. Only the owner key can remove the
onchain limit. **When:** an attack alert they do not recognise, payments they did not expect, a
leaked token or key, or any doubt at all. A kill is cheap to undo; a drain is not.

## Kill, in order

**Always start from Stop everything in the owner panel**, or from `/kill` in Telegram when the bot
runs. A Phantom kill link from earlier removes the onchain limit but does not pause guard-core, and
old links expire.

1. **Stop new payments.** In the panel open **Kill** and press **Stop everything**, or in Telegram
   send `/kill` and press **Kill everything**. guard-core pauses every agent first
   (`POST /v1/owner/kill`, or `POST /v1/admin/kill` for the bot). From then on every payment is
   refused with `PAUSED`. The panel, or the bot, then shows the owner transaction for each chain. If
   neither is available, use the admin call directly. On Fly the admin route is private, so open it on your machine first with
   `fly proxy 18787:8787 --app <your guard-core app>` in another terminal, then:

   ```bash
   t=$(grep '^ADMIN_TOKEN=' packages/guard-core/.env | cut -d= -f2-) && curl -sS -X POST http://127.0.0.1:18787/v1/admin/kill -H "Authorization: Bearer $t" -H 'content-type: application/json' -d '{}'
   ```

2. **Remove the onchain limit.** This is what actually stops the hot wallet drawing from the vault;
   step 1 only stops the guard. The bot's message gives the `removeSpendingLimit` instruction, which
   must be signed by the config authority, the owner key.

   With the owner key in Phantom: press the Phantom button the panel shows for the chain (or
   **Open kill in Phantom** under the bot's message), check that the page names your multisig and hot
   wallet, and approve in Phantom. The page waits until the limit is gone. "Already killed" means there was nothing left
   to remove. Then the panel's overview (or `/status`) shows the chain without a limit.

   The link expires 15 minutes after the kill result is shown, and the page refuses an older one. If the panel and the bot are both down, build the link by hand. Every value in it is public,
   and it is good for 15 minutes:

   ```bash
   issued=$(date +%s) && m=$(grep '^SQUADS_MULTISIG=' packages/guard-core/.env | cut -d= -f2-) && h=$(solana-keygen pubkey "$(grep '^SOLANA_HOT_WALLET_KEYPAIR=' packages/guard-core/.env | cut -d= -f2-)") && s=$(grep '^SIGN_PAGE_URL=' packages/guard-core/.env | cut -d= -f2-) && echo "$s/?action=kill&cluster=mainnet-beta&multisig=$m&hot=$h&issued=$issued"
   ```

   Open it in a browser with Phantom, or on a phone inside Phantom through
   `https://phantom.app/ul/browse/<the link, URL-encoded>`. Use `cluster=devnet` on devnet.

   With the owner key on a Ledger:
   1. Plug the Ledger in, unlock it, and open the Solana app.
   2. Turn **Blind signing** on (Solana app, Settings). The app cannot display Squads instructions.
   3. Run:

      ```bash
      SOLANA_OWNER_KEYPAIR='usb://ledger?key=0' pnpm --filter @defimind/onchain kill --yes
      ```

   4. Compare the **Message Hash** on the device with the one the script printed, character by
      character. Approve only on an exact match. On any difference, reject, and treat the computer as
      compromised: run the kill from another machine. Do it within a minute, before the blockhash
      expires.
   5. Turn **Blind signing** off again.

   With the owner key as a file (devnet today): `pnpm --filter @defimind/onchain kill` shows the
   limit and changes nothing; `kill --yes` removes it.

3. **Confirm it is gone.** `pnpm --filter @defimind/onchain status` must print
   `spending limit:   none at <address>`. On explorer.solana.com, on the right cluster, that
   address must show no account. The vault balance is unchanged: the funds never left.
4. **Deal with what the hot wallet still holds.** The limit is gone, but the hot wallet keeps its
   current balance. If its key may be compromised, treat that balance as lost; it is the bounded part
   of the daily loss. If not, leave it, or move it back to the vault with the hot wallet key.

## Rotate the hot wallet key

Do this after any suspected exposure, and after any kill caused by one.

1. Run steps 1–3 of the kill above for the old hot wallet.
2. Generate a new keypair outside the repo (`solana-keygen new -o <path>`), and store it in the
   secrets manager.
3. In `packages/onchain/.env`, set `SOLANA_HOT_WALLET_PUBKEY` to the new **public** key. Then run
   `pnpm --filter @defimind/onchain add-spending-limit`. The limit's address is derived from the hot
   wallet, so the new limit is a new account, and the old one stays removed.
4. Run `pnpm --filter @defimind/onchain status`. It must show the cap, the new hot wallet as the
   only member, and the new hot wallet as the only destination.
5. Point guard-core's `SOLANA_HOT_WALLET_KEYPAIR` at the new key and restart it. Fund the new hot
   wallet with a little SOL for fees. Then `POST /v1/admin/resume` each agent the owner trusts.
   Agents stay paused until resumed one by one.

## Rotate the service tokens

`ADMIN_TOKEN`, `BOT_TOKEN` and `BOT_WEBHOOK_SECRET` are generated with `openssl rand -hex 32` and must
match between guard-core and the bot. Change them in both, restart both, and let the `pnpm dev:all`
preflight (or its equivalent at deploy) confirm they agree. A leaked agent token is revoked with
`pnpm --filter @defimind/guard-core revoke-agent <agentId>`, which takes effect on the token's next
request. A token can't be rotated in place: `create-agent` issues a new agent with its own token and a
deny-all policy, which the owner then sets.
