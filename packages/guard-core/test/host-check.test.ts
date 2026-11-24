import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { allowedHosts } from '../src/http/host-check.js'
import { ADMIN_TOKEN, harness, type Harness } from './harness.js'

const get = (h: Harness, url: string, host: string) =>
  h.app.inject({ method: 'GET', url, headers: { host } })

describe('the Host check (CR-022)', () => {
  it('answers the public address and the loopback names on a loopback listener', async () => {
    const h = await harness()
    for (const host of [
      'guard.example',
      'GUARD.example:443',
      'localhost:8787',
      '127.0.0.1',
      '[::1]:8787',
    ]) {
      expect((await get(h, '/v1/receipts/key', host)).statusCode).not.toBe(421)
    }
  })

  it('refuses any other host with 421 misdirected', async () => {
    const h = await harness()
    const res = await get(h, '/v1/receipts/key', 'evil.example')
    expect(res.statusCode).toBe(421)
    expect(res.json()).toEqual({ error: 'misdirected' })
    expect((await get(h, '/panel/', 'guard.example.evil')).statusCode).toBe(421)
  })

  it('answers /health under any name, for the host own checks', async () => {
    const h = await harness()
    expect((await get(h, '/health', 'fly-internal-check')).statusCode).toBe(200)
  })

  it('takes only the public address on a listener beyond loopback', async () => {
    const h = await harness({
      env: { HOST: '0.0.0.0', ADMIN_ROUTES: 'false', PUBLIC_URL: 'https://guard.example' },
    })
    expect((await get(h, '/v1/receipts/key', 'localhost')).statusCode).toBe(421)
    expect((await get(h, '/v1/receipts/key', 'guard.example')).statusCode).not.toBe(421)
  })
})

describe('allowedHosts', () => {
  it('names nothing to check when no address is configured beyond loopback', () => {
    const config = loadConfig({ ADMIN_TOKEN, HOST: '0.0.0.0', ADMIN_ROUTES: 'false' })
    expect(allowedHosts('all', config).size).toBe(0)
  })

  it('takes PUBLIC_URL and PASSKEY_ORIGIN on the public side of a split', () => {
    const config = loadConfig({
      ADMIN_TOKEN,
      HOST: 'fly-local-6pn',
      PUBLIC_PORT: '8080',
      PUBLIC_URL: 'https://dm.example',
      PASSKEY_RP_ID: 'example',
      PASSKEY_ORIGIN: 'https://panel.example',
    })
    expect([...allowedHosts('public', config)].sort()).toEqual(['dm.example', 'panel.example'])
  })
})
