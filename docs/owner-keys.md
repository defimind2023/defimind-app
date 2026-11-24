# Who controls your vaults

DefiMind keeps your money in a vault you own: a Squads multisig on Solana, and a Safe on Robinhood
Chain or Base. Agents spend through a spending (hot) wallet, under a daily limit the vault grants it,
so a hijacked agent or server can lose at most that limit per day.

The daily limit does **not** protect against a stolen owner key. Whoever controls the vault can
empty it at once. This page is about that key (CR-022).

## The risk: one wallet behind every vault

When you set up through the panel with one Phantom account, the same recovery phrase controls the
Solana vault and the Robinhood Chain vault. Leak that phrase once, and every vault can be emptied,
past every daily limit.

Use a separate wallet for each chain, so one leaked phrase reaches one vault only.

## Solana: protect the config authority

Every DefiMind Solana vault is a _controlled_ Squads multisig. Its config authority, your wallet, can
remove the agent's spending limit in one signature; that is what makes the kill instant. The same key
can also add itself a spending limit and empty the vault without a vote.

So, on Solana:

- **Adding members or raising the threshold does not protect the vault.** The config authority acts
  alone whatever the threshold says. The panel and the doctor report such a vault as one key
  (`threshold 1 of 1`).
- **What protects it, if you choose to: hand the vault to a hardware wallet, entirely.** A Ledger connected through
  Phantom keeps the key off your phone and computer. It must take over every role your old key has:
  config authority _and_ member. A vault made in the panel has your old key as its only member,
  threshold 1, so a Ledger that only became the authority would leave the old key able to propose
  and approve alone. Every vault change and every kill then needs the device in your hand.
- **The change of keys** takes two signatures:
  1. your current wallet adds the Ledger as a member and makes it the config authority;
  2. the Ledger removes the old key.

  Until step 2 is signed, the old key still controls the vault. The signing page does not do this
  change.

- A vault that no single key can empty, an _autonomous_ multisig with a kill by proposal and vote, is
  not offered today (CR-023). Its price is a slower kill: two people or two devices,
  and minutes instead of seconds. guard-core's own pause stays instant either way.

## Robinhood Chain and Base: the Safe's threshold works

A Safe's threshold binds every owner, so more signers really do protect it:

- **A Safe that needs 2 of 3 signatures, one of them on a hardware key**, cannot be emptied with one
  stolen phrase.
- It is slower to stop in an emergency, because a second signer must sign the kill too. You then
  approve vault changes in the Safe app: the signing page works with a one-signer Safe.
- If you keep one signer, make it a separate wallet from your Solana one, and ideally a hardware
  wallet that **replaces** the old owner rather than joining it. The change is two steps here too,
  both in the Safe app:
  1. add the Ledger as an owner;
  2. the Ledger removes the old owner.

## What DefiMind checks for you

- The doctor reads each vault's control onchain (`getVault().control`) and warns when one key can
  move the funds. It names the fix for that chain.
- The panel shows the same advice where you create a vault, and in Settings.
- An agent can have its own spending wallet and daily limit ("Own wallet" on the agent). Then a bug
  or a hijack in that agent stays within its own cap. It does not change who controls the vault.

## Give an agent its own wallet

By default every agent spends from one shared spending wallet per chain. An agent with its own
wallet spends only from it, under its own daily limit, so one agent's bug or hijack cannot spend
another agent's share. Existing agents keep the shared wallet until you change them; nothing moves
on its own.

1. In the panel, open the agent, then **Own wallet**, and press **Give it its own wallet on
   Solana** (or the chain you want). Your passkey confirms it.
2. Press **Sign the limit** and sign the agent's daily limit in your wallet. Until DefiMind reads
   that limit on the chain, the card says _Waiting for its limit_ and the agent keeps paying from
   the shared wallet.
3. Send the new address a little of the chain's gas token (SOL or ETH); the card shows the minimum.
   The agent's wallet pays its own fees.

Once the card says _Active_, every payment, top-up and trade of that agent on that chain uses that
wallet alone. **Stop this agent** on the same page pauses this agent only, and gives you one
signature per own wallet to take its limit off. **Stop everything** on the Overview still stops
every agent.

Every agent key still sits on your one DefiMind server: if the server itself is broken into, the
most at risk is the sum of every daily limit.

## What it cannot do

DefiMind never holds your owner key, so it cannot stop someone who has it. Keep the recovery phrase
offline, never type it into a website, and treat any request for it as an attack.
