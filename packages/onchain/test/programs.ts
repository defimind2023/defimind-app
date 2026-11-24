import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { PublicKey } from '@solana/web3.js'

/** A mainnet program the fork test runs, pinned to the slot its code was last deployed at. */
export interface PinnedProgram {
  id: string
  deploySlot: number
}

const CACHE = new URL('../.cache/programs/', import.meta.url)
const RPC = process.env['SOLANA_MAINNET_RPC'] ?? 'https://api.mainnet-beta.solana.com'

/**
 * The programs' code, from a local cache or else read from mainnet, never from the repository:
 * third-party binaries are not ours to redistribute. A program redeployed since the recording, or
 * a network that cannot reach mainnet, gives the reason instead, for the test to skip by name.
 */
export async function mainnetPrograms(
  pinned: PinnedProgram[],
): Promise<Map<string, Buffer> | string> {
  const code = new Map<string, Buffer>()
  for (const { id, deploySlot } of pinned) {
    const file = new URL(`${id}-${deploySlot}.so`, CACHE)
    const cached = await readFile(file).catch(() => undefined)
    if (cached) {
      code.set(id, cached)
      continue
    }
    let data: Buffer
    try {
      const program = await account(id)
      // An upgradeable program account holds only the address of its program data.
      data = await account(new PublicKey(program.subarray(4, 36)).toBase58())
    } catch (error) {
      return `mainnet RPC unreachable at ${RPC}: ${error instanceof Error ? error.message : error}`
    }
    // Program data: a 4-byte tag, the deploy slot, the upgrade authority, then the code from byte 45.
    const slot = Number(data.readBigUInt64LE(4))
    if (slot !== deploySlot) {
      return `${id} was redeployed at slot ${slot} after the recording at ${deploySlot}: run pnpm record:swap`
    }
    await mkdir(CACHE, { recursive: true })
    await writeFile(file, data.subarray(45))
    code.set(id, data.subarray(45))
  }
  return code
}

async function account(address: string): Promise<Buffer> {
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getAccountInfo',
      params: [address, { encoding: 'base64' }],
    }),
    signal: AbortSignal.timeout(30_000),
  })
  const body = (await response.json()) as { result?: { value?: { data: [string, string] } | null } }
  const value = body.result?.value
  if (!value) throw new Error(`no account ${address}`)
  return Buffer.from(value.data[0], 'base64')
}
