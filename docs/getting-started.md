# Getting started

This page is for owners who have never run a server. You put DefiMind online with one button, and
the panel walks you through the rest. You never edit a file or paste a key.

> **Public beta.** DefiMind moves real money, it is new, and it has had no external audit. Put in
> only what you can afford to lose. The signing page refuses a daily limit above 50 dollars.

> **The one-click deployment is new.** If a step does not work as described here, stop and open an
> issue with the step's number and what you saw, never a key or the setup code. The Fly.io route in
> the [README](../README.md) is the other way in; step 4 below, connecting your agent, is the same
> for both.

## What you need

- A [Render](https://render.com) account. DefiMind needs a paid instance with a disk, because your
  database and your keys live on it. A free instance would forget both on every restart. Render's
  pricing page has the current price.
- [Phantom](https://phantom.app/download) on your phone or in your browser, with a new wallet you
  use for nothing else.
- About 1 dollar of SOL in that wallet for network fees, and the USDC your agents may spend.
- The computer where your AI agent runs (Claude Code, Claude Desktop or Cursor).

## 1. Put DefiMind online

1. Click the button below and sign in to Render.

   [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/defimind2023/defimind-app)

2. Render shows one service, `defimind`, with a disk. Click **Apply**. Render makes two secrets for
   you, `ADMIN_TOKEN` and `SETUP_CODE`; leave them as they are.
3. Wait until the service says **Live**. The first build takes a few minutes.
4. Open the address Render shows, such as `https://defimind-abcd.onrender.com`, and add `/panel/`.
   Bookmark it: this is your DefiMind.

Each person runs their own DefiMind. Nobody else, including the people who wrote it, can see your
keys or move your money.

## 2. First access

The panel asks for a setup code. It proves you are the one who deployed this service.

1. In Render, open the `defimind` service, then **Environment**.
2. Copy the value of `SETUP_CODE` and paste it into the panel.
3. Create your passkey when the browser asks. It is your fingerprint, face or device PIN. From now
   on the panel needs it, and the setup code no longer works.

Do this right after the deployment goes live, and do not share the setup code: until the first
passkey exists, whoever has it can claim your DefiMind.

## 3. Follow the guide

The panel shows nine steps and marks each one done by reading your vault on the chain, not by
taking your word for it. In short:

1. **Your passkey.** Done in step 2.
2. **Connect Phantom.** Install it and keep the recovery phrase on paper, never in a photo or a
   message.
3. **Create your vault.** Phantom signs a Squads multisig that you alone own. Your agents never
   touch the rest of your wallet.
4. **Set a daily limit.** You type the most the vault may pay out in a day, up to 50 during the
   beta. The vault itself enforces it, even if DefiMind were broken into.
5. **Add money.** Move USDC from your wallet into the vault. Start small.
6. **Connect your agent.** The panel gives the agent its own key. See the next section.
7. **Choose the rules.** How much the agent may pay at once and per day, and from which amount it
   must ask you first.
8. **Try it safely.** In test mode the agent works as usual and no money moves. You see what it
   would have paid.
9. **Go live.** The agent now pays for real, within your rules and the vault's daily limit.

Before every Phantom prompt, the signing page shows in large text where the money goes and how
much. If that is not what you meant, do not approve.

## 4. Connect your agent

Until the DefiMind MCP server is published on npm, this step needs a terminal on the computer where
your agent runs, with Node 20 or later, pnpm and git:

```bash
git clone https://github.com/defimind2023/defimind-app.git ~/DefiMind
cd ~/DefiMind && pnpm install
```

Then run the command the panel shows after **Create with passkey**. It asks for the agent's key at
a hidden prompt; paste the key the panel showed. For Claude Desktop or Cursor, replace `claude-code`
in that command with `claude-desktop` or `cursor`, and paste the block it prints into the file it
names. Restart the app afterwards.

More detail, including what an agent can and cannot do:
[`packages/mcp-server/README.md`](../packages/mcp-server/README.md).

## Everyday

- **Approvals.** Payments above your threshold wait for you in the panel. Turn on notifications in
  the panel to hear about them.
- **Stop everything.** The panel's **Kill** pauses every agent at once: DefiMind signs no more
  payments. On a one-click deployment it cannot yet open the Phantom step that also removes the
  daily limit from your vault, so the panel sends you to your vault's own app (app.squads.so for
  Solana, app.safe.global for a Safe) to remove it there. Until that step is one click, keep the
  limit and the vault balance small: the most a day can cost is the limit plus what DefiMind's own
  wallet holds.
- **Updates.** Your service never updates by itself, because it holds keys. To update, read the
  [CHANGELOG](../CHANGELOG.md), then in Render click **Manual Deploy**, then **Deploy latest
  commit**.

## If something goes wrong

- **The setup code is refused.** Copy it again from Render's Environment tab, with no space before
  or after. After five wrong tries, wait 15 minutes.
- **The panel says the setup is already done.** A passkey exists. Sign in with it.
- **Saving the vault says its limit "does not name this DefiMind".** The daily limit is not set
  for this DefiMind yet, or the address is wrong. Do step 4 of the guide, wait for Phantom to
  confirm, then save again.
- **You lost your passkey.** In Render, open the service's **Shell**. This lists your passkeys:

  ```bash
  cd /srv/defimind/packages/guard-core
  setpriv --reuid=node --regid=node --clear-groups -- node --import tsx src/scripts/remove-passkey.ts
  ```

  Run the same line again with the first 8 characters of the lost passkey's id at the end. Once
  no passkey is left, the panel asks for the setup code again, as in step 2. Your vault, its limit
  and your agents stay as they were.

Anything else: [`troubleshooting.md`](./troubleshooting.md). A security problem: report it
privately as described in [`SECURITY.md`](../SECURITY.md).
