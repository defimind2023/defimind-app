import { describe, expect, it } from 'vitest'
import { listenerLayout, loadConfig } from '../src/config.js'
import { ADMIN_TOKEN } from './harness.js'

const env = { ADMIN_TOKEN }

describe('the admin routes on one listener (CR-022)', () => {
  it.each(['0.0.0.0', '::', '10.0.0.5', 'guard.internal'])(
    'refuses to start with them on %s',
    (HOST) => {
      expect(() => loadConfig({ ...env, HOST })).toThrow('invalid configuration: HOST')
    },
  )

  it.each(['127.0.0.1', '127.0.0.53', '::1', 'localhost'])('starts on loopback %s', (HOST) => {
    expect(() => loadConfig({ ...env, HOST })).not.toThrow()
  })

  it('starts on every interface when the listeners are split, or the admin routes off', () => {
    expect(() => loadConfig({ ...env, HOST: '0.0.0.0', PUBLIC_PORT: '8080' })).not.toThrow()
    expect(() => loadConfig({ ...env, HOST: '0.0.0.0', ADMIN_ROUTES: 'false' })).not.toThrow()
  })

  it('starts only when ALLOW_PUBLIC_ADMIN says it is meant', () => {
    expect(() => loadConfig({ ...env, HOST: '0.0.0.0', ALLOW_PUBLIC_ADMIN: 'true' })).not.toThrow()
  })
})

describe('listenerLayout', () => {
  it('names the routes on one listener', () => {
    expect(listenerLayout(loadConfig(env))).toEqual([
      { address: '127.0.0.1:8787', routes: ['agent', 'owner', 'admin'] },
    ])
  })

  it('keeps admin and bot on the private listener when split', () => {
    const bot = {
      BOT_URL: 'http://bot',
      BOT_TOKEN: 'b'.repeat(64),
      BOT_WEBHOOK_SECRET: 'c'.repeat(64),
    }
    const split = loadConfig({ ...env, ...bot, HOST: 'fly-local-6pn', PUBLIC_PORT: '8080' })
    expect(listenerLayout(split)).toEqual([
      { address: '0.0.0.0:8080', routes: ['agent', 'owner'] },
      { address: 'fly-local-6pn:8787', routes: ['admin', 'bot'] },
    ])
  })

  it('leaves admin out when ADMIN_ROUTES is off', () => {
    const render = loadConfig({ ...env, HOST: '0.0.0.0', PORT: '10000', ADMIN_ROUTES: 'false' })
    expect(listenerLayout(render)).toEqual([
      { address: '0.0.0.0:10000', routes: ['agent', 'owner'] },
    ])
  })
})
