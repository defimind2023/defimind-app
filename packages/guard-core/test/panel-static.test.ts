import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { CHAIN, harness, MERCHANT, MINT, type Harness } from './harness.js'

function build(): string {
  const dir = mkdtempSync(join(tmpdir(), 'panel-'))
  mkdirSync(join(dir, 'icons'))
  for (const name of ['index.html', 'app.js', 'app.css', 'sw.js', 'manifest.webmanifest']) {
    writeFileSync(join(dir, name), `/* ${name} */`)
  }
  writeFileSync(join(dir, 'icons/icon-192.png'), 'png')
  writeFileSync(join(dir, 'secret.txt'), 'not for the browser')
  return dir
}

const get = (h: Harness, url: string) => h.app.inject({ method: 'GET', url })

let h: Harness
beforeEach(async () => {
  h = await harness({ panelDir: build() })
})

describe('the panel at /panel', () => {
  it('redirects /panel to /panel/', async () => {
    const res = await get(h, '/panel')
    expect(res.statusCode).toBe(308)
    expect(res.headers.location).toBe('/panel/')
  })

  it.each([
    ['/panel/app.js', 'text/javascript; charset=utf-8', 'public, max-age=86400'],
    ['/panel/manifest.webmanifest', 'application/manifest+json', 'public, max-age=86400'],
    ['/panel/icons/icon-192.png', 'image/png', 'public, max-age=86400'],
    ['/panel/sw.js', 'text/javascript; charset=utf-8', 'no-cache'],
    ['/panel/index.html', 'text/html; charset=utf-8', 'no-cache'],
  ])('serves %s with its type and caching', async (url, type, cache) => {
    const res = await get(h, url)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe(type)
    expect(res.headers['cache-control']).toBe(cache)
  })

  it('sends the SPEC CSP and the page headers on every file', async () => {
    const res = await get(h, '/panel/app.css')
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'",
    )
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['x-frame-options']).toBe('DENY')
    expect(res.headers['strict-transport-security']).toContain('max-age=31536000')
  })

  it.each([
    '/panel/',
    '/panel/enrol',
    '/panel/agents/agent-1',
    '/panel/secret.txt',
    '/panel/..%2F..%2Fpackage.json',
    '/panel/constructor',
  ])('answers %s with the app page, never another file', async (url) => {
    const res = await get(h, url)
    expect(res.body).toBe('/* index.html */')
  })

  it('answers 404 when the panel is not built', async () => {
    const bare = await harness({ panelDir: join(tmpdir(), 'no-panel-here') })
    expect((await get(bare, '/panel/')).statusCode).toBe(404)
  })
})

describe('TELEGRAM_APPROVALS', () => {
  it('refuses approve from Telegram by default, and still takes reject', async () => {
    const panelOnly = await harness({ telegramApprovals: 'false' })
    const ask = () =>
      panelOnly.agent('POST', '/v1/agent/transfer', {
        agentId: 'agent-1',
        chain: CHAIN,
        token: MINT,
        amount: '3000000',
        recipient: MERCHANT,
        reason: 'pay',
      })
    const { intentId } = (await ask()).json()
    const approve = await panelOnly.asBot({ intentId, decision: 'approve', telegramUserId: '1' })
    expect(approve.statusCode).toBe(403)
    expect(approve.json()).toEqual({ error: 'approve_in_panel' })
    const reject = await panelOnly.asBot({ intentId, decision: 'reject', telegramUserId: '1' })
    expect(reject.json().status).toBe('rejected')
  })
})
