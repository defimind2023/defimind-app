# Known risks

1. **On the Safe chains, a stolen hot key can send the day's cap to any address** without
   guard-core seeing it. On Solana it can only move the cap into the hot wallet. The loss bound is
   the same (cap + hot wallet balance), but the path differs.
2. **The owner key can move the whole vault.** Keep in the vault only what the agents need for the
   coming days, and read [`owner-keys.md`](./owner-keys.md).
3. **The signing page is a trust root.** Whoever can redeploy it can show a harmless summary of a
   harmful transaction. Each user deploys their own, from their own protected `main`.
4. **Rate limits count per socket address.** guard-core, the bot hooks and the MCP HTTP endpoint
   each have one, but behind a proxy every client shares the proxy's address.
5. **Single process, in-memory rate limits, SQLite.** This is fine for one guard. The database is on
   a persistent volume, guard-core backs it up every day with an optional encrypted off-site copy,
   and it refuses to start on mainnet with an unsafe database location.
6. **Not reachable from runtime, but in the lockfile:** a few moderate advisories, each triaged in
   [`security/dependency-triage.md`](./security/dependency-triage.md).
7. **Prompt injection through paid content** is limited, not solved. Tool output marks it as data,
   and every payment still needs the policy and, above the threshold, the owner. A model that ignores
   the marking can still ask to pay. It cannot pay more than the policy allows.
