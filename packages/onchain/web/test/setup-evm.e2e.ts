import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeFunctionData, getAddress, parseAbi, type Hex } from 'viem'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { enableData, PROXY_FACTORY } from '../src/evm/calls.js'
import { MODULE, mockPhantomEvm, stageEvm, USDG } from './evm-node.js'
import { decodedLines, heading, lines } from './harness.js'

/** Creating the Safe and setting its allowance on Robinhood, with stand-ins for Phantom and the chain. */
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

async function open(query: Record<string, string>, account = s.state.owners[0]!) {
  const page = await browser.newPage()
  await page.addInitScript(mockPhantomEvm(account))
  await page.goto(
    `${s.server.origin}/?${new URLSearchParams({ cluster: 'evm-localnet', ...query })}`,
  )
  return page
}

const alice = getAddress('0x00000000000000000000000000000000000a11ce')

const settled = (page: Page, title: string) =>
  expect.poll(() => heading(page).textContent(), { timeout: 20_000 }).toBe(title)

const factory = parseAbi([
  'function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)',
])

describe('the create page on an EVM chain', () => {
  beforeEach(() => {
    s.state.exists = false
    s.state.owners = []
  })

  it('creates a Safe owned by the connected account alone, at the address it named', async () => {
    const owner = alice
    const page = await open({ action: 'create' }, owner)
    await settled(page, 'Safe created')
    const [tx, ...more] = s.sent
    expect(more).toEqual([])
    expect({ from: tx!.from, to: tx!.to, value: tx!.value }).toEqual({
      from: owner,
      to: PROXY_FACTORY,
      value: '0x0',
    })
    expect(decodeFunctionData({ abi: factory, data: tx!.data }).functionName).toBe(
      'createProxyWithNonce',
    )
    expect(s.state.owners).toEqual([owner])
    expect((await lines(page)).join(' ')).toContain(`ROBINHOOD_SAFE_ADDRESS=${s.state.safe}`)
  })

  it('uses a new salt on each page load', async () => {
    const salts: bigint[] = []
    for (let i = 0; i < 2; i++) {
      s.state.exists = false
      const page = await open({ action: 'create' }, alice)
      await settled(page, 'Safe created')
      salts.push(decodeFunctionData({ abi: factory, data: s.sent.at(-1)!.data }).args[2])
    }
    expect(salts[0]).not.toBe(salts[1])
  })
})

describe('the enable page on an EVM chain', () => {
  const enable = (amount: bigint | null = s.state.cap) => ({
    action: 'enable',
    safe: s.state.safe,
    ...(amount === null ? {} : { amount: String(amount) }),
  })

  beforeEach(() => {
    s.state.moduleEnabled = false
    s.state.listed = false
  })

  it('enables the module, adds the hot wallet and sets the cap, in one transaction', async () => {
    const page = await open(enable())
    await settled(page, 'Daily cap set')
    const owner = s.state.owners[0]!
    const allowance = { module: MODULE, hot: s.state.hot, usd: USDG, cap: s.state.cap }
    expect(s.sent).toEqual([
      {
        from: owner,
        to: s.state.safe,
        data: enableData(owner, s.state.safe, allowance, false),
        value: '0x0',
      },
    ])
    expect((await lines(page)).join(' ')).toContain('up to 20 USDG a day')
  })

  it('lets the owner type the cap when the link has none', async () => {
    const page = await open(enable(null))
    await settled(page, 'Set the daily cap')
    expect((await lines(page)).join(' ')).toContain('at most 50 USDG a day')
    await page.fill('input[name=amount]', '20')
    await page.click('text=Continue')
    await settled(page, 'Daily cap set')
    const owner = s.state.owners[0]!
    const allowance = { module: MODULE, hot: s.state.hot, usd: USDG, cap: 20_000_000n }
    expect(s.sent.map((tx) => tx.data)).toEqual([enableData(owner, s.state.safe, allowance, false)])
  })

  it('asks Phantom nothing when the bytes name a module it does not know, as a tampered /sign would', async () => {
    const index = join(s.dist, 'index.html')
    await writeFile(index, (await readFile(index, 'utf8')).replaceAll(MODULE, alice))
    const page = await open(enable())
    await settled(page, 'Nothing to sign')
    expect((await lines(page))[0]).toMatch(
      /^This transaction carries something this page cannot read/,
    )
    expect(await decodedLines(page)).toContain(
      'A call this page cannot read: reject this transaction.',
    )
    const requests = await page.evaluate(
      () => (window as never as { __requests: string[] }).__requests,
    )
    expect(requests).not.toContain('eth_sendTransaction')
    expect(s.sent).toEqual([])
  })

  it('leaves the module alone when it is on already, as after a kill', async () => {
    s.state.moduleEnabled = true
    const page = await open(enable())
    await settled(page, 'Daily cap set')
    const owner = s.state.owners[0]!
    const allowance = { module: MODULE, hot: s.state.hot, usd: USDG, cap: s.state.cap }
    expect(s.sent.map((tx) => tx.data as Hex)).toEqual([
      enableData(owner, s.state.safe, allowance, true),
    ])
  })

  it('refuses when the hot wallet already has an allowance', async () => {
    s.state.moduleEnabled = true
    s.state.listed = true
    const page = await open(enable())
    await settled(page, 'Nothing to sign')
    expect((await lines(page)).join(' ')).toContain('kill it first')
    expect(s.sent).toEqual([])
  })

  it("refuses a cap above the page's maximum", async () => {
    const page = await open(enable(50_000_001n))
    await settled(page, 'This link is not valid')
    expect(s.sent).toEqual([])
  })

  it('refuses a link naming another hot wallet', async () => {
    const other = alice
    const page = await open({ ...enable(), hot: other })
    await settled(page, 'Nothing to sign')
    expect((await lines(page)).join(' ')).toContain(`names ${other} as the hot wallet`)
    expect(s.sent).toEqual([])
  })

  it('refuses another account', async () => {
    const page = await open(enable(), alice)
    await settled(page, 'Nothing to sign')
    expect((await lines(page)).join(' ')).toContain("is not this Safe's only owner")
    expect(s.sent).toEqual([])
  })
})
