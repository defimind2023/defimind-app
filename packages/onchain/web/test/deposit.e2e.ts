import { Keypair, type PublicKey } from '@solana/web3.js'
import * as multisig from '@sqds/multisig'
import { chromium, type Browser } from 'playwright'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { keypairOwner } from '../../src/svm/owner.js'
import { createMultisig } from '../../src/svm/squads.js'
import { transferInstructions } from '../../src/svm/transfer.js'
import { USDC } from '../../test/fixture.js'
import { decodedLines, heading, lines, sentInstructions, shape, stage } from './harness.js'

/** The deposit page: a plain USDC transfer from a member into the multisig's vault. */
let browser: Browser
let s: Awaited<ReturnType<typeof stage>>
let multisigPda: PublicKey
let vault: PublicKey

beforeAll(async () => {
  browser = await chromium.launch()
})
afterAll(() => browser.close())
beforeEach(async () => {
  s = await stage()
  multisigPda = (await createMultisig(s.c.connection, keypairOwner(s.owner))).multisigPda
  ;[vault] = multisig.getVaultPda({ multisigPda, index: 0 })
  s.c.fund(s.owner.publicKey, 40n * USDC)
})
afterEach(() => s.server.close())

const depositLink = (amount?: string) => ({
  action: 'deposit',
  multisig: multisigPda.toBase58(),
  ...(amount ? { amount } : {}),
})
const settled = (page: Awaited<ReturnType<typeof s.open>>, title: string) =>
  expect.poll(() => heading(page).textContent(), { timeout: 20_000 }).toBe(title)

describe('the deposit page on Solana', () => {
  it('moves the typed amount into the vault, creating its USDC account, and grants nothing', async () => {
    const page = await s.open(browser, depositLink())
    await settled(page, 'Deposit into the vault')
    await page.fill('input[name=amount]', '12.5')
    await page.click('text=Continue')
    await settled(page, 'Deposited')
    const payment = {
      feePayer: s.owner.publicKey,
      hotWallet: s.owner.publicKey,
      recipient: vault,
      mint: s.c.mint,
      amount: 12_500_000n,
      decimals: 6,
    }
    expect(s.server.signed).toHaveLength(1)
    expect(sentInstructions(s.server.signed[0]!)).toEqual(
      transferInstructions(payment, true).map(shape),
    )
    expect(s.c.balance(vault)).toBe(12_500_000n)
    expect(await lines(page)).toEqual([`Vault ${vault.toBase58()} now holds 12.5 USDC.`])
  })

  it('puts a link amount in the field for the owner to confirm, then shows it before Phantom asks', async () => {
    const page = await s.open(browser, depositLink('5000000'), { rejects: true })
    await settled(page, 'Deposit into the vault')
    expect(await page.inputValue('input[name=amount]')).toBe('5')
    expect(s.server.signed).toEqual([])
    await page.click('text=Continue')
    await expect.poll(() => page.locator('button').textContent()).toBe('Ask Phantom again')
    expect(await lines(page)).toContain(`Deposit: 5 USDC into vault ${vault.toBase58()}.`)
    const mint = s.c.mint.toBase58()
    expect(await decodedLines(page)).toEqual([
      `Create the token account of ${vault.toBase58()} for token ${mint}.`,
      `Send 5 (5000000 base units at 6 decimals) of token ${mint} to the token account of ` +
        `${vault.toBase58()}.`,
    ])
  })

  it('refuses a wallet that is not a member, before asking for an amount', async () => {
    s.wallet.connected = Keypair.generate()
    const page = await s.open(browser, depositLink())
    await settled(page, 'Nothing to sign')
    expect((await lines(page))[0]).toMatch(/^The connected wallet \S+ is not a member of multisig/)
    expect(s.server.signed).toEqual([])
  })

  it('refuses more than the wallet holds', async () => {
    const page = await s.open(browser, depositLink('41000000'))
    await settled(page, 'Deposit into the vault')
    await page.click('text=Continue')
    await settled(page, 'Nothing to sign')
    expect(await lines(page)).toEqual(['Your wallet holds 40 USDC, less than 41 USDC.'])
    expect(s.server.signed).toEqual([])
  })

  it('refuses an address that is not a multisig', async () => {
    const page = await s.open(browser, { ...depositLink(), multisig: vault.toBase58() })
    await settled(page, 'Nothing to sign')
    expect(s.server.signed).toEqual([])
  })

  it('says it is not configured, and offers nothing, when served without a config', async () => {
    const page = await browser.newPage()
    await page.goto(`${s.server.origin}/index.template.html?action=deposit`)
    await settled(page, 'This page is not configured')
    expect(await page.locator('input').count()).toBe(0)
  })
})
