# @defimind/sdk

Signed execution receipts for agents that do not go through the DefiMind MCP gateway, and
`defimind-verify`, which checks a receipt offline.

Source of truth: [`/SPEC.md`](../../SPEC.md), section "Verified execution (CR-013)". Design:
[ADR 005](../../docs/adr/005-verified-execution.md).

## What a receipt proves

Every call wrapped with `withReceipt` is reported to guard-core, which appends an `ExecutionReceipt`
to the deployment's hash chain and signs it with the receipt key. These receipts have
`assurance: "relayed"`. That means:

- guard-core vouches for **when it heard of the call** and that **the record never changed since**;
- it does **not** vouch for what the tool really did. It only knows what the agent's process told it.

Payments that guard-core ran itself carry `assurance: "executed"`, the strong kind.

guard-core receives hashes only: the SHA-256 of the canonical JSON of the input and of the result.
It never sees the content. To show the content later, keep it yourself; the receipt proves it
matches.

## withReceipt

```ts
import { withReceipt, Refused } from '@defimind/sdk'

const search = withReceipt('search', 'query', async (input: { q: string }) => {
  if (input.q === '') {
    throw new Refused('empty query') // recorded as outcome "refused"
  }
  return api.search(input.q)
})

const hits = await search({ q: 'usdc' })
```

It reads `GUARD_URL` and `AGENT_TOKEN`, the same variables as the MCP server. To pass them
explicitly, or to get each receipt back, use `receipts()`:

```ts
import { httpRecorder, receipts } from '@defimind/sdk'

const { withReceipt } = receipts({
  recorder: httpRecorder({ guardUrl: 'https://guard.example.com', token }),
  onReceipt: (receipt) => log.info({ seq: receipt.seq }, 'recorded'),
})
```

| The wrapped function    | Outcome   | `responseHash` covers | Then                  |
| ----------------------- | --------- | --------------------- | --------------------- |
| returns `result`        | `ok`      | `result`              | returns it            |
| throws `Refused`        | `refused` | `{ error: message }`  | rethrows it           |
| throws anything else    | `error`   | `{ error: message }`  | rethrows it           |
| ran, receipt not stored | n/a       | n/a                   | throws `ReceiptError` |

**It fails closed.** When guard-core does not record the call, `withReceipt` throws `ReceiptError`
even though the call ran. Its `result` holds what the function returned, and its `cause` holds the
error it threw, so nothing is lost. The caller decides what to do with an action that has no
receipt.

## defimind-verify

```bash
pnpm --filter @defimind/sdk run verify bundle.json --key <hex> [--rpc <url>] [--anchor-key <pubkey>]
```

The input can be:

- a proof bundle (`GET /v1/owner/executions/:seq/proof`);
- a list of proof bundles;
- a run of receipts (`{ receipts: [...] }`, as the timeline routes return it, or a bare array).

It checks, and prints `pass` or `FAIL` for each:

| Check           | What it means                                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------------------- |
| `signature`     | Ed25519 over the receipt's canonical JSON, against `--key`                                                            |
| `hash`          | the receipt's fields hash to its `hash`                                                                               |
| `merkle path`   | the siblings lead from the receipt to the anchored root, from the receipt's position                                  |
| `anchor`        | the finalized anchor transaction carries exactly one memo, `defimind:anchor:v1:<from>-<to>:<root>`; prints its signer |
| `chain` (a run) | `seq` has no gap and every `prevHash` is the hash of the receipt before                                               |

It exits 0 only when every check passes, 1 when one fails, and 2 on a usage error.

**It trusts no DefiMind server.**

- **The key:** take it once from `GET /v1/receipts/key` of the deployment, or from its owner, and
  pass it as `--key`. Without one, no signature passes.
- **The anchor:** it is read from the cluster's public RPC (`api.devnet.solana.com`,
  `api.mainnet-beta.solana.com`), or from `--rpc <url>`, an RPC you choose.
- **The anchor key:** the check prints who signed the anchor transaction. With `--anchor-key`, the
  deployment's anchor public key, an anchor signed by any other key fails.
- **Not yet supported:** anchors on EVM chains.

The Merkle tree follows RFC 6962:

- a leaf is `SHA-256(0x00 || hash)`;
- a node is `SHA-256(0x01 || left || right)`;
- leaves are in `seq` order from `fromSeq` to `toSeq`;
- a node left without a partner is promoted unchanged.

The functions (`merkleRoot`, `merklePath`, `leafHash`, `nodeHash`, `canonicalJson`) are exported,
so anyone can rebuild the tree.

## Development

```bash
pnpm --filter @defimind/sdk test
pnpm --filter @defimind/sdk typecheck
```
