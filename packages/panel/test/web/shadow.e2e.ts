import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildPanel } from '../../build.js'
import { openDevice, status } from './device.js'

let browser: Browser
let dist: string

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), 'defimind-panel-'))
  await buildPanel(dist)
  browser = await chromium.launch()
})

afterAll(async () => {
  await browser.close()
})

async function agentPage(page: Page, origin: string) {
  await page.goto(`${origin}/panel/enrol#code=one-time`)
  await page.getByRole('button', { name: 'Create passkey' }).click()
  await expect.poll(() => status(page).textContent()).toContain('Passkey saved')
  await page.getByRole('button', { name: 'Sign in with passkey' }).click()
  await page.getByRole('heading', { name: 'Overview' }).waitFor()
  await page.goto(`${origin}/panel/agents/research-bot`)
  await page.getByRole('heading', { name: 'Shadow mode' }).waitFor()
}

describe.each([390, 1280])('shadow mode at %i px (GC-68)', (width) => {
  it('says how often live would have asked, and why', async () => {
    const { guard, page, violations, close } = await openDevice(browser, dist, width)
    guard.state.policy['mode'] = 'shadow'
    guard.state.shadowAsked = { count: 2, flags: ['NEW_TOKEN', 'PRICE_JUMP'] }
    await agentPage(page, guard.origin)
    await page
      .getByText(
        'Live would have asked you 2 times: NEW_TOKEN (First buy of this token by any of your agents.); PRICE_JUMP (This API asks for much more than its last payment.)',
      )
      .waitFor()
    expect(violations).toEqual([])
    await close()
  })

  it('says nothing more when live would have asked nothing, or guard-core does not say', async () => {
    const { guard, page, close } = await openDevice(browser, dist, width)
    guard.state.policy['mode'] = 'shadow'
    await agentPage(page, guard.origin)
    expect(await page.getByText(/Live would have asked you/).count()).toBe(0)
    guard.state.shadowAsked = { count: 0, flags: [] }
    await page.reload()
    await page.getByRole('heading', { name: 'Shadow mode' }).waitFor()
    expect(await page.getByText(/Live would have asked you/).count()).toBe(0)
    await close()
  })
})
