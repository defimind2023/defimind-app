import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Keypair, LAMPORTS_PER_SOL, TransactionMessage, type PublicKey } from '@solana/web3.js'
import type { TransactionInstruction, VersionedTransaction } from '@solana/web3.js'
import * as multisig from '@sqds/multisig'
import type { Browser, Page } from 'playwright'
import { chain, plantProgramConfig } from '../../test/fixture.js'
import { buildPage } from '../build.js'
import { pageHtml, type PageConfig } from '../page.js'
import { mockPhantom, servePage } from './server.js'

const squads = fileURLToPath(new URL('../../test/fixtures/squads_v4.so', import.meta.url))

/**
 * A chain with the real Squads program and its config, an owner with SOL, and the page built for a
 * local server whose stand-in Phantom signs with whichever key `connected` names. `hosted` builds it
 * as the one hosted page is built, with no hot wallet.
 */
export async function stage({ hosted = false } = {}) {
  const c = chain()
  c.svm.addProgramFromFile(multisig.PROGRAM_ID, squads)
  plantProgramConfig(c)
  const owner = Keypair.generate()
  c.svm.airdrop(owner.publicKey, BigInt(10 * LAMPORTS_PER_SOL))
  const wallet = { connected: owner }
  const scanned: PublicKey[] = []
  const server = await servePage(
    c.svm,
    await mkdtemp(join(tmpdir(), 'defimind-sign-')),
    () => wallet.connected,
    scanned,
  )
  // The server's port is only known once it listens, so the page is built for it afterwards.
  await buildPage(server.dist, {
    SOLANA_LOCALNET_RPC: `${server.origin}/rpc`,
    SOLANA_LOCALNET_USDC: c.mint.toBase58(),
    // The hosted page (CR-020) is built with no hot wallet.
    ...(hosted ? {} : { SOLANA_HOT_WALLET_LOCALNET: c.hotWallet.publicKey.toBase58() }),
    MAX_DAILY_CAP: '100000000',
  })

  async function open(
    browser: Browser,
    query: Record<string, string>,
    { phantom = true, rejects = false } = {},
  ): Promise<Page> {
    const page = await browser.newPage()
    if (phantom) {
      await page.addInitScript(mockPhantom(wallet.connected.publicKey.toBase58(), rejects))
    }
    await page.goto(`${server.origin}/?${new URLSearchParams({ cluster: 'localnet', ...query })}`)
    return page
  }
  return { c, owner, wallet, server, open, scanned }
}

export const heading = (page: Page) => page.locator('h1')
export const lines = (page: Page) => page.locator('p').allTextContents()
/** The transaction as the page decoded it from its bytes, before Phantom's prompt. */
export const decodedLines = (page: Page) => page.locator('.decoded li').allTextContents()

/**
 * What identifies an instruction: its program, data and accounts in order. Decompiling marks the fee
 * payer a signer wherever it appears, so the flags are left out.
 */
export const shape = (ix: TransactionInstruction) => ({
  programId: ix.programId.toBase58(),
  data: ix.data.toString('hex'),
  keys: ix.keys.map((key) => key.pubkey.toBase58()),
})

export const sentInstructions = (tx: VersionedTransaction) =>
  TransactionMessage.decompile(tx.message).instructions.map(shape)

/** The built page with its config changed, as guard-core would serve it for its agents' wallets. */
export async function reconfigure(dist: string, change: (config: PageConfig) => void) {
  const template = await readFile(join(dist, 'index.template.html'), 'utf8')
  const json = /id="config">([^<]*)<\/script>/.exec(
    await readFile(join(dist, 'index.html'), 'utf8'),
  )![1]!
  const config = JSON.parse(json) as PageConfig
  change(config)
  await writeFile(join(dist, 'index.html'), pageHtml(template, config))
}
