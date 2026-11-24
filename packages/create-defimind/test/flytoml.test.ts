import { describe, expect, it } from 'vitest'
import { rewriteFlyToml } from '../src/domain/flytoml.js'
import { repoFile } from './fakes.js'

const guard = repoFile('packages/guard-core/fly.toml')
const bot = repoFile('packages/telegram-bot/fly.toml')

function changed(before: string, after: string): [string, string][] {
  const a = before.split('\n')
  const b = after.split('\n')
  expect(b).toHaveLength(a.length)
  return a.flatMap((line, i) => (line === b[i] ? [] : [[line, b[i] ?? '']]))
}

describe('rewriteFlyToml', () => {
  it("changes only guard-core's app and region: BOT_URL is a secret now (CR-017)", () => {
    const out = rewriteFlyToml(guard, { app: 'acme-guard-core', region: 'iad' })
    expect(changed(guard, out)).toEqual([
      ['app = "your-guard-core"', 'app = "acme-guard-core"'],
      ['primary_region = "gru"', 'primary_region = "iad"'],
    ])
    expect(guard).not.toMatch(/^\s*BOT_URL/m)
  })

  it("changes only the bot's app, region and GUARD_URL host, keeping the port", () => {
    const out = rewriteFlyToml(bot, {
      app: 'acme-bot',
      region: 'gru',
      peer: { name: 'GUARD_URL', app: 'acme-guard-core' },
    })
    expect(changed(bot, out)).toEqual([
      ['app = "your-bot"', 'app = "acme-bot"'],
      [
        '  GUARD_URL = "http://your-guard-core.internal:8787"',
        '  GUARD_URL = "http://acme-guard-core.internal:8787"',
      ],
    ])
  })

  it('refuses a fly.toml whose shape it does not know', () => {
    const changes = { app: 'a-b', region: 'gru' }
    expect(() => rewriteFlyToml(guard.replace(/^app = .*$/m, ''), changes)).toThrow(/app line/)
    expect(() => rewriteFlyToml(`${guard}\napp = "again"\n`, changes)).toThrow(/exactly one app/)
    const peer = { ...changes, peer: { name: 'GUARD_URL', app: 'x' } } as const
    expect(() => rewriteFlyToml(bot.replace(/GUARD_URL/, 'OTHER'), peer)).toThrow(/GUARD_URL/)
    expect(() => rewriteFlyToml(guard.replace(/primary_region.*/, ''), changes)).toThrow(
      /primary_region/,
    )
  })
})
