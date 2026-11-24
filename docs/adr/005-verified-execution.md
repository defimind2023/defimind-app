# ADR 005 — Verified execution: receipts signed outside the agent, anchored without a contract

- **Status:** accepted, 2026-11-18, with CR-013 (SPEC v0.9).
- **Context:** operators, their clients and auditors need to prove what an agent did. Logs that the
  agent's own process writes cannot prove that, because whoever runs the agent can rewrite them.

## Decisions

1. **guard-core signs, not the agent.** guard-core already holds the receipt key and runs apart from
   the agent, so receipts reuse that key and its public endpoint.

   A payment receipt is strong, because guard-core executed the payment itself. A tool call reported
   by the gateway is weaker: guard-core only knows what it was told. Every receipt carries
   `assurance` so a reader never mistakes one kind for the other.

2. **One chain per deployment, a single writer.** A gap or an edit anywhere breaks `seq` or
   `prevHash`. Appending inside one database transaction keeps the chain from forking. One chain per
   agent would only multiply the anchors.
3. **Hashes only.** guard-core never stores tool arguments or results, so a breach of guard-core
   leaks no customer data, and the operator decides what to keep.
4. **No custom contract.** A Merkle root in a Memo transaction gives the same proof of existence as
   a contract call. It needs nothing deployed or audited, and nothing anyone can upgrade.

   The anchor key pays fees only and is not the hot wallet, so a leaked anchor key cannot move
   funds.

5. **RFC 6962-style tree.** Prefixing leaves with 0x00 and nodes with 0x01 means an inner node can
   never be presented as a leaf.
6. **Offline verification.** `defimind-verify` needs the bundle, the public key and any RPC the
   verifier picks. A proof that required trusting our server would prove nothing.

## Consequences

- The gateway fails closed: a call whose receipt cannot be recorded stops further calls until the
  outbox drains. An agent may pause rather than act unrecorded.
- guard-core's own integrity check compares the chain with the anchors table, which lives in the
  same database. Someone who can edit that database can delete the newest receipts and their anchor
  rows together, and the local check passes. Only `defimind-verify`, which reads the memo from the
  chain, catches that. This is why anchoring exists, and why a bundle is checked against the chain,
  not against our server.
- Credit or scoring built on receipts is out of scope until a legal review.
