import { Keypair, type PublicKey } from '@solana/web3.js'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { keypairOwner } from '../../src/svm/owner.js'
import {
  addDailySpendingLimit,
  createMultisig,
  removeSpendingLimitInstruction,
  spendingLimitPda,
} from '../../src/svm/squads.js'
import { USDC } from '../../test/fixture.js'
import { killData } from '../src/evm/calls.js'
import { MODULE, mockPhantomEvm, stageEvm } from './evm-node.js'
import { heading, lines, sentInstructions, shape, stage } from './harness.js'

/**
 * The hosted page (CR-020): one build for every deployment, with no hot wallet. It kills the hot
 * wallet the link names, which can only take authority away, and refuses anything that grants it.
 */
let browser: Browser

beforeAll(async () => {
  browser = await chromium.launch()
})
afterAll(() => browser.close())
const servers: { close: () => unknown }[] = []
afterEach(() => servers.splice(0).forEach((server) => server.close()))
const staged = async <T extends { server: { close: () => unknown } }>(s: Promise<T>) => {
  const done = await s
  servers.push(done.server)
  return done
}

const NEEDS_OWN_PAGE = "Open this from your DefiMind panel: it needs your deployment's own page."
const NO_LIMIT = "No limit found for this hot wallet. Check Spending limits in your vault's app."
const issued = () => String(Math.floor(Date.now() / 1000))
const settled = (page: Page, title: string) =>
  expect.poll(() => heading(page).textContent(), { timeout: 20_000 }).toBe(title)

describe('the hosted page on Solana', () => {
  async function hosted() {
    const s = await staged(stage({ hosted: true }))
    const owner = keypairOwner(s.owner)
    const { multisigPda } = await createMultisig(s.c.connection, owner)
    const addLimit = (key: PublicKey) =>
      addDailySpendingLimit(s.c.connection, owner, {
        multisigPda,
        createKey: key,
        mint: s.c.mint,
        amount: 100n * USDC,
        members: [key],
        destinations: [key],
      })
    const kill = (hot: PublicKey) => ({
      action: 'kill',
      multisig: multisigPda.toBase58(),
      hot: hot.toBase58(),
      issued: issued(),
    })
    return { s, multisigPda, addLimit, kill }
  }

  it("kills the hot wallet the link names, removing exactly that hot wallet's limit", async () => {
    const { s, multisigPda, addLimit, kill } = await hosted()
    const hot = s.c.hotWallet.publicKey
    await addLimit(hot)
    const page = await s.open(browser, kill(hot))
    await settled(page, 'Killed')
    const limit = spendingLimitPda(multisigPda, hot)
    expect(sentInstructions(s.server.signed[0]!)).toEqual([
      shape(removeSpendingLimitInstruction(multisigPda, s.owner.publicKey, limit)),
    ])
    expect(s.c.svm.getAccount(limit)).toBeNull()
  })

  it("removes only the other limit a link names on the owner's own multisig", async () => {
    const { s, multisigPda, addLimit, kill } = await hosted()
    const hot = s.c.hotWallet.publicKey
    const other = Keypair.generate().publicKey
    await addLimit(hot)
    await addLimit(other)
    const page = await s.open(browser, kill(other))
    await settled(page, 'Killed')
    expect(s.c.svm.getAccount(spendingLimitPda(multisigPda, other))).toBeNull()
    expect(s.c.svm.getAccount(spendingLimitPda(multisigPda, hot))).not.toBeNull()
  })

  it('says no limit was found for a hot wallet that has none, never already killed', async () => {
    const { s, kill } = await hosted()
    const page = await s.open(browser, kill(s.c.hotWallet.publicKey))
    await settled(page, 'Nothing to sign')
    expect(await lines(page)).toEqual([NO_LIMIT])
    expect(s.server.signed).toEqual([])
  })

  it('still refuses a wallet that is not the config authority', async () => {
    const { s, addLimit, kill } = await hosted()
    await addLimit(s.c.hotWallet.publicKey)
    s.wallet.connected = Keypair.generate()
    const page = await s.open(browser, kill(s.c.hotWallet.publicKey))
    await settled(page, 'Nothing to sign')
    expect((await lines(page))[0]).toMatch(/is not this multisig's config authority/)
    expect(s.server.signed).toEqual([])
  })

  it('refuses a kill link that names no hot wallet', async () => {
    const { s, kill } = await hosted()
    const { hot: _, ...link } = kill(s.c.hotWallet.publicKey)
    const page = await s.open(browser, link)
    await settled(page, 'Nothing to sign')
    expect((await lines(page))[0]).toMatch(/^This kill link names no hot wallet/)
  })

  it('refuses add-limit, which needs the deployment its own page', async () => {
    const { s, multisigPda } = await hosted()
    const page = await s.open(browser, {
      action: 'add-limit',
      multisig: multisigPda.toBase58(),
      hot: s.c.hotWallet.publicKey.toBase58(),
      amount: '1000000',
    })
    await settled(page, 'Nothing to sign')
    expect(await lines(page)).toEqual([NEEDS_OWN_PAGE])
    expect(s.server.signed).toEqual([])
  })
})

describe('the hosted page on an EVM chain', () => {
  async function open(s: Awaited<ReturnType<typeof stageEvm>>, query: Record<string, string>) {
    const page = await browser.newPage()
    await page.addInitScript(mockPhantomEvm(s.state.owners[0]!))
    const link = { cluster: 'evm-localnet', safe: s.state.safe, ...query }
    await page.goto(`${s.server.origin}/?${new URLSearchParams(link)}`)
    return page
  }
  const kill = (s: Awaited<ReturnType<typeof stageEvm>>) => ({
    action: 'kill',
    hot: s.state.hot,
    issued: issued(),
  })

  it('removes the delegate the link names, through the Safe', async () => {
    const s = await staged(stageEvm({ hosted: true }))
    const page = await open(s, kill(s))
    await settled(page, 'Killed')
    const owner = s.state.owners[0]!
    expect(s.sent.map((tx) => tx.data)).toEqual([killData(owner, MODULE, s.state.hot)])
  })

  it('says no limit was found when the hot wallet is not a delegate', async () => {
    const s = await staged(stageEvm({ hosted: true }))
    s.state.listed = false
    const page = await open(s, kill(s))
    await settled(page, 'Nothing to sign')
    expect(await lines(page)).toEqual([NO_LIMIT])
    expect(s.sent).toEqual([])
  })

  it('refuses enable, which needs the deployment its own page', async () => {
    const s = await staged(stageEvm({ hosted: true }))
    const page = await open(s, { action: 'enable', amount: '1000000' })
    await settled(page, 'Nothing to sign')
    expect(await lines(page)).toEqual([NEEDS_OWN_PAGE])
    expect(s.sent).toEqual([])
  })
})
