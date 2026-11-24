import { Keypair } from '@solana/web3.js'
import { getAddress } from 'viem'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { keypairOwner } from '../../src/svm/owner.js'
import {
  addSpendingLimitInstruction,
  createMultisig,
  readSpendingLimit,
  spendingLimitPda,
} from '../../src/svm/squads.js'
import { enableData } from '../src/evm/calls.js'
import { MODULE, mockPhantomEvm, stageEvm, USDG } from './evm-node.js'
import { heading, lines, reconfigure, sentInstructions, shape, stage } from './harness.js'

/**
 * A deployment's own page with agent wallets (CR-022): it grants a limit to any hot wallet of the
 * deployment, shared or an agent's, and to no other key.
 */
let browser: Browser

beforeAll(async () => {
  browser = await chromium.launch()
})
afterAll(() => browser.close())
const servers: { close: () => unknown }[] = []
afterEach(() => servers.splice(0).forEach((server) => server.close()))

const settled = (page: Page, title: string) =>
  expect.poll(() => heading(page).textContent(), { timeout: 20_000 }).toBe(title)

describe('agent wallets on Solana', () => {
  async function staged() {
    const s = await stage()
    servers.push(s.server)
    const agent = Keypair.generate().publicKey
    await reconfigure(s.server.dist, (config) => {
      config.agents['localnet'] = [agent.toBase58()]
    })
    const { multisigPda } = await createMultisig(s.c.connection, keypairOwner(s.owner))
    const addLimit = (hot: string) => ({
      action: 'add-limit',
      multisig: multisigPda.toBase58(),
      hot,
      amount: '20000000',
    })
    return { s, agent, multisigPda, addLimit }
  }

  it("adds a limit whose only member and destination is the agent's wallet", async () => {
    const { s, agent, multisigPda, addLimit } = await staged()
    const page = await s.open(browser, addLimit(agent.toBase58()))
    await settled(page, 'Daily cap set')
    expect(sentInstructions(s.server.signed[0]!)).toEqual([
      shape(
        addSpendingLimitInstruction(s.owner.publicKey, {
          multisigPda,
          createKey: agent,
          mint: s.c.mint,
          amount: 20_000_000n,
          members: [agent],
          destinations: [agent],
        }),
      ),
    ])
    const own = await readSpendingLimit(s.c.connection, spendingLimitPda(multisigPda, agent))
    expect(own).toMatchObject({ cap: '20000000', members: [agent.toBase58()] })
    expect(s.c.svm.getAccount(spendingLimitPda(multisigPda, s.c.hotWallet.publicKey))).toBeNull()
  })

  it('still sets the shared limit for a link that names no hot wallet', async () => {
    const { s, multisigPda, addLimit } = await staged()
    const { hot: _, ...link } = addLimit('')
    const page = await s.open(browser, link)
    await settled(page, 'Daily cap set')
    const shared = spendingLimitPda(multisigPda, s.c.hotWallet.publicKey)
    expect(await readSpendingLimit(s.c.connection, shared)).toMatchObject({ cap: '20000000' })
  })

  it('refuses a key that is neither the shared wallet nor an agent wallet', async () => {
    const { s, addLimit } = await staged()
    const attacker = Keypair.generate().publicKey.toBase58()
    const page = await s.open(browser, addLimit(attacker))
    await settled(page, 'Nothing to sign')
    expect((await lines(page))[0]).toMatch(new RegExp(`^The link names ${attacker} as the hot`))
    expect(s.server.signed).toEqual([])
  })
})

describe('agent wallets on an EVM chain', () => {
  const shared = getAddress('0x5a4ed00000000000000000000000000000000001')

  async function staged() {
    const s = await stageEvm()
    servers.push(s.server)
    // The stand-in Safe knows one delegate, `state.hot`: here it is an agent's, not the shared one.
    await reconfigure(s.dist, (config) => {
      config.evm['evm-localnet'] = {
        ...config.evm['evm-localnet']!,
        hot: shared,
        agents: [s.state.hot],
      }
    })
    s.state.listed = false
    const open = async (query: Record<string, string>) => {
      const page = await browser.newPage()
      await page.addInitScript(mockPhantomEvm(s.state.owners[0]!))
      const link = { cluster: 'evm-localnet', action: 'enable', safe: s.state.safe, ...query }
      await page.goto(`${s.server.origin}/?${new URLSearchParams(link)}`)
      return page
    }
    return { s, open }
  }

  it("adds the agent's wallet as a delegate with its own allowance, the module already on", async () => {
    const { s, open } = await staged()
    const page = await open({ hot: s.state.hot, amount: String(s.state.cap) })
    await settled(page, 'Daily cap set')
    const owner = s.state.owners[0]!
    const allowance = { module: MODULE, hot: s.state.hot, usd: USDG, cap: s.state.cap }
    expect(s.sent.map((tx) => tx.data)).toEqual([enableData(owner, s.state.safe, allowance, true)])
  })

  it('refuses an address that is not one of the deployment', async () => {
    const { s, open } = await staged()
    const other = getAddress('0x00000000000000000000000000000000000a11ce')
    const page = await open({ hot: other, amount: String(s.state.cap) })
    await settled(page, 'Nothing to sign')
    expect((await lines(page))[0]).toContain(`only acts for ${shared}, ${s.state.hot}.`)
    expect(s.sent).toEqual([])
  })
})
