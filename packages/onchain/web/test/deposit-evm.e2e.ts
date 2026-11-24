import { encodeFunctionData, erc20Abi, getAddress, type Address } from 'viem'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mockPhantomEvm, stageEvm, USDG } from './evm-node.js'
import { heading, lines } from './harness.js'

/** The deposit page on an EVM chain: a plain USDG transfer from an owner into the Safe. */
let browser: Browser
let s: Awaited<ReturnType<typeof stageEvm>>

beforeAll(async () => {
  browser = await chromium.launch()
})
afterAll(() => browser.close())
beforeEach(async () => {
  s = await stageEvm()
})
afterEach(() => s.server.close())

async function open(query: Record<string, string>, account: Address = s.state.owners[0]!) {
  const page = await browser.newPage()
  await page.addInitScript(mockPhantomEvm(account))
  const link = { cluster: 'evm-localnet', action: 'deposit', safe: s.state.safe, ...query }
  await page.goto(`${s.server.origin}/?${new URLSearchParams(link)}`)
  return page
}

const settled = (page: Page, title: string) =>
  expect.poll(() => heading(page).textContent(), { timeout: 20_000 }).toBe(title)

describe('the deposit page on an EVM chain', () => {
  it('sends one transfer of the typed amount to the Safe, and nothing else', async () => {
    const page = await open({})
    await settled(page, 'Deposit into the vault')
    await page.fill('input[name=amount]', '15')
    await page.click('text=Continue')
    await settled(page, 'Deposited')
    expect(s.sent).toEqual([
      {
        from: s.state.owners[0],
        to: USDG,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'transfer',
          args: [s.state.safe, 15_000_000n],
        }),
        value: '0x0',
      },
    ])
    expect(await lines(page)).toEqual([`Safe ${s.state.safe} now holds 115 USDG.`])
  })

  it('refuses an account that is not an owner, before asking for an amount', async () => {
    const page = await open({}, getAddress('0x00000000000000000000000000000000000a11ce'))
    await settled(page, 'Nothing to sign')
    expect((await lines(page))[0]).toMatch(/is not an owner of Safe/)
    expect(s.sent).toEqual([])
  })

  it('refuses more than the account holds', async () => {
    const page = await open({ amount: '41000000' })
    await settled(page, 'Deposit into the vault')
    expect(await page.inputValue('input[name=amount]')).toBe('41')
    await page.click('text=Continue')
    await settled(page, 'Nothing to sign')
    expect(await lines(page)).toEqual(['Your account holds 40 USDG, less than 41 USDG.'])
    expect(s.sent).toEqual([])
  })
})
