/**
 * Records one real Jupiter swap from mainnet for the fork test (test/swap-fork.test.ts): the quote,
 * Jupiter's transaction, and every account that transaction touches at one slot, programs included,
 * so the test can run the real route in LiteSVM. Programs are recorded by id and deploy slot only. The hot wallet is a key made
 * here for the test; it never holds anything on mainnet.
 *
 *   NODE_USE_ENV_PROXY=1 pnpm tsx src/scripts/record-swap.ts
 */
import { writeFile } from 'node:fs/promises'
import type { AddressLookupTableAccount } from '@solana/web3.js'
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'

const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111'
const RPC = process.env['SOLANA_MAINNET_RPC'] ?? 'https://api.mainnet-beta.solana.com'
const JUPITER = 'https://lite-api.jup.ag/swap/v1'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const WSOL = 'So11111111111111111111111111111111111111112'
const OUT = new URL('../../test/fixtures/jupiter-swap.json', import.meta.url)

const connection = new Connection(RPC, 'confirmed')
const hot = Keypair.generate()
const get = async (path: string, init?: RequestInit) => {
  const response = await fetch(`${JUPITER}${path}`, init)
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`)
  return response.json() as Promise<Record<string, unknown>>
}

// One Whirlpool hop keeps the recorded program set small; the checks do not depend on the route.
const quote = await get(
  `/quote?inputMint=${USDC}&outputMint=${WSOL}&amount=1000000&slippageBps=50&swapMode=ExactIn` +
    '&restrictIntermediateTokens=true&onlyDirectRoutes=true&dexes=Whirlpool',
)
const { swapTransaction } = (await get('/swap', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    quoteResponse: quote,
    userPublicKey: hot.publicKey.toBase58(),
    wrapAndUnwrapSol: false,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: {
      priorityLevelWithMaxLamports: { priorityLevel: 'medium', maxLamports: 500_000 },
    },
  }),
})) as { swapTransaction: string }
const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'))

const slot = await connection.getSlot('confirmed')
const tables = await Promise.all(
  tx.message.addressTableLookups.map(async ({ accountKey }) => {
    const { value } = await connection.getAddressLookupTable(accountKey)
    if (!value) throw new Error(`no lookup table ${accountKey.toBase58()}`)
    return value
  }),
)
const message = TransactionMessage.decompile(tx.message, {
  addressLookupTableAccounts: tables as AddressLookupTableAccount[],
})
const keys = new Map<string, PublicKey>()
const add = (key: PublicKey) => keys.set(key.toBase58(), key)
message.instructions.forEach((ix) => [ix.programId, ...ix.keys.map((k) => k.pubkey)].forEach(add))
tables.forEach((table) => add(table.key))
;[USDC, WSOL].forEach((mint) => add(new PublicKey(mint)))

const accounts: Record<
  string,
  { lamports: number; owner: string; executable: boolean; data: string }
> = {}
async function fetchAll(list: PublicKey[]) {
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100)
    const infos = await connection.getMultipleAccountsInfo(chunk, { minContextSlot: slot })
    infos.forEach((info, j) => {
      if (!info) return
      accounts[chunk[j]!.toBase58()] = {
        lamports: info.lamports,
        owner: info.owner.toBase58(),
        executable: info.executable,
        data: info.data.toString('base64'),
      }
    })
  }
}
await fetchAll([...keys.values()])
// Programs are pinned by id and the slot their code was last deployed at, never copied into the
// repository: the fork test reads their code from mainnet (test/programs.ts). LiteSVM brings its own
// token and system programs.
const BUILT_IN = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
])
const programs: { id: string; deploySlot: number }[] = []
for (const [id, account] of Object.entries(accounts)) {
  if (!account.executable) continue
  delete accounts[id]
  if (account.owner !== UPGRADEABLE_LOADER || BUILT_IN.has(id)) continue
  const dataKey = new PublicKey(Buffer.from(account.data, 'base64').subarray(4, 36))
  const info = await connection.getAccountInfo(dataKey, { minContextSlot: slot })
  if (!info) throw new Error(`no program data for ${id}`)
  programs.push({ id, deploySlot: Number(info.data.readBigUInt64LE(4)) })
}

const blockTime = (await connection.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000)
await writeFile(
  OUT,
  `${JSON.stringify(
    {
      recordedAt: new Date().toISOString(),
      slot,
      blockTime,
      hotSecretKey: [...hot.secretKey],
      quote,
      swapTransaction,
      programs,
      accounts,
    },
    null,
    1,
  )}\n`,
)
console.log(
  `recorded ${Object.keys(accounts).length} accounts at slot ${slot} into ${OUT.pathname}`,
)
