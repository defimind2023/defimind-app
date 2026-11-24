# ADR 006 — Guided setup: keys generated on the server's disk

- **Status:** accepted, 2026-11-20, with CR-019 (SPEC v0.14).
- **Context:** a non-technical owner deploys DefiMind with one click and finishes setup in the panel.
  They cannot create key files or paste secrets into a host. Until now every key came from Fly
  secrets, written to tmpfs at boot (D5).

## Decisions

1. **guard-core makes each missing key once, on its own disk.** The keys are the hot wallets, the
   receipt key, the VAPID key and the anchor key. They live under `/data/keys`, with the directory
   at 0700 and each file at 0600. A key from env or a file always wins, so Fly deployments keep D5.
2. **Only public keys leave the server.** No route, log or backup endpoint returns a private key.
3. **The signing page comes from the owner's own guard-core.** The page must never take the hot
   wallet from a link, because a crafted link could make an attacker's key the delegate. With one
   hot wallet per deployment, no shared page can carry them all. So guard-core serves the page at
   `/sign` and injects its own addresses at serve time.

   Only create and add-limit need the hot wallet. Deposit and kill stay on the hosted page built
   from `main`, which a compromised guard-core cannot change.

4. **A vault is adopted only after an onchain check.** The check is that the vault's limit or
   allowance names this guard-core's hot wallet. A forged vault address in the panel, even one sent
   with a valid session, gets nothing to draw on.
5. **The setup code works only until the first passkey exists.** Whoever reaches the address first
   still cannot take the deployment without the code that only the host's dashboard shows.

## Consequences

- **The hot keys rest on a disk, not only in memory.** The disk is encrypted at rest, the files are
  readable by the app user alone, and the onchain daily cap still bounds what a stolen hot key can
  draw.
- **Losing the disk loses the hot keys.** That costs nothing held in the vault, which only the
  owner's Phantom controls. The owner kills the old limit and adds one for the new hot wallet.
- **Each owner's domain is new to Phantom** and may be flagged until it is reviewed.
- **`/sign` shares guard-core's trust domain** (the owner accepted this on 2026-11-20). A compromised guard-core or host account could serve
  a modified page. That page could ask the owner to sign an add-limit for an attacker's key, so for
  create and add-limit the worst case is what the owner signs, not just the cap. The mitigations:
  - the transaction's own decoded destination or delegate and amount appear in large text before
    Phantom opens, and owners are told to compare them with Phantom's own screen;
  - a strict CSP;
  - a published build hash;
  - deposit and kill stay on the hosted page.
- **Host snapshots carry the key files.** Anyone with access to the host dashboard's disk snapshots
  holds the hot keys. The onchain cap bounds what they can draw.
- **Keys kept in a KMS remain the next step** once caps rise (D5).
