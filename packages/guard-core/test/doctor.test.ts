import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { StubChain } from '../src/adapters/stub.js'
import { openDb, schema } from '../src/db/client.js'
import { doctor, type DoctorDeps } from '../src/service/doctor.js'
import { basePolicy, CHAIN, MINT, NOW } from './harness.js'

function deps(overrides: Partial<DoctorDeps> = {}): DoctorDeps & { chain: StubChain } {
  const db = openDb(':memory:')
  migrate(db, { migrationsFolder: 'migrations' })
  const chain = new StubChain(CHAIN, 1_000_000n)
  return {
    db,
    chain,
    chains: new Map([[CHAIN, chain]]),
    usdc: new Map([[CHAIN, MINT]]),
    fetch: vi.fn(async () => new Response('{"status":"ok"}', { status: 200 })),
    now: () => NOW,
    botUrl: 'http://bot.internal:8788',
    databaseUrl: ':memory:',
    ...overrides,
  }
}

const byId = async (d: DoctorDeps) => Object.fromEntries((await doctor(d)).map((c) => [c.id, c]))

describe('the doctor', () => {
  it('reports a healthy setup, and writes nothing to the database it checks', async () => {
    const d = deps()
    const checks = await byId(d)
    expect(checks['database']?.status).toBe('ok')
    expect(checks[`${CHAIN}:allowance`]?.status).toBe('ok')
    expect(checks[`${CHAIN}:gas`]?.status).toBe('ok')
    expect(checks[`${CHAIN}:balance`]?.message).toBe(
      'The hot wallet on Solana devnet holds 1.00 USDC.',
    )
    expect(checks[`${CHAIN}:allowance`]?.message).not.toContain(CHAIN)
    expect(checks['bot']?.status).toBe('ok')
    expect(d.db.select().from(schema.auditLog).all()).toEqual([])
  })

  it('warns when a chain has no onchain limit, as after a kill', async () => {
    const d = deps()
    vi.spyOn(d.chain, 'getAllowanceState').mockResolvedValue({ status: 'none', delegate: 'hot' })
    expect((await byId(d))[`${CHAIN}:allowance`]).toMatchObject({
      status: 'warn',
      fix: expect.any(String),
    })
  })

  it('warns when the hot wallet is below its gas minimum', async () => {
    const d = deps()
    vi.spyOn(d.chain, 'getHotWalletGas').mockResolvedValue({
      balance: '1',
      minimum: '2',
      symbol: 'SOL',
    })
    expect((await byId(d))[`${CHAIN}:gas`]).toMatchObject({
      status: 'warn',
      fix: 'Send some SOL to stub, the address of the hot wallet.',
    })
  })

  it('fails a read that throws without quoting the error, which may carry a URL or a key', async () => {
    const d = deps()
    vi.spyOn(d.chain, 'getAllowanceState').mockRejectedValue(
      new Error('fetch failed: https://rpc.example/v2/SECRET-KEY'),
    )
    const check = (await byId(d))[`${CHAIN}:allowance`]
    expect(check?.status).toBe('fail')
    expect(check?.message).toBe('guard-core could not read this from Solana devnet.')
    expect(JSON.stringify(check)).not.toMatch(/SECRET|https?:/)
  })

  it('gives up on a chain read after five seconds', async () => {
    vi.useFakeTimers()
    try {
      const d = deps()
      const hang = () => new Promise<never>(() => {})
      vi.spyOn(d.chain, 'getAllowanceState').mockImplementation(hang)
      vi.spyOn(d.chain, 'getHotWalletGas').mockImplementation(hang)
      vi.spyOn(d.chain, 'getHotWalletBalance').mockImplementation(hang)
      const pending = byId(d)
      // One timeout for the chain, not one per read.
      await vi.advanceTimersByTimeAsync(5_000)
      const checks = await pending
      expect(checks[`${CHAIN}:allowance`]?.status).toBe('fail')
      expect(checks[`${CHAIN}:balance`]?.status).toBe('fail')
    } finally {
      vi.useRealTimers()
    }
  })

  it('warns about an agent whose approval threshold is above PASSKEY_ABOVE', async () => {
    const d = deps()
    for (const [id, approvalThreshold] of [
      ['loose', '5000000'],
      ['tight', '1000000'],
    ] as const) {
      d.db
        .insert(schema.agents)
        .values({ id, name: id, tokenHash: id, createdAt: NOW.toISOString() })
        .run()
      d.db
        .insert(schema.policies)
        .values({ agentId: id, ...basePolicy, approvalThreshold, updatedAt: NOW.toISOString() })
        .run()
    }
    const checks = await byId({ ...d, passkeyAbove: '3000000' })
    expect(checks['loose:passkey']).toMatchObject({ status: 'warn', fix: expect.any(String) })
    expect(checks['tight:passkey']).toBeUndefined()
    expect((await byId(d))['loose:passkey']).toBeUndefined()
  })

  it.each([
    ['answers with an error', async () => new Response('no', { status: 500 })],
    ['is down', async () => Promise.reject(new TypeError('fetch failed'))],
  ])('fails when the bot %s, naming no URL', async (_case, answer) => {
    const check = (await byId(deps({ fetch: vi.fn(answer) as typeof fetch })))['bot']
    expect(check?.status).toBe('fail')
    expect(JSON.stringify(check)).not.toContain('bot.internal')
  })

  describe('backups', () => {
    function withBackup(ageMs?: number) {
      const dir = mkdtempSync(join(tmpdir(), 'guard-doctor-'))
      if (ageMs !== undefined) {
        mkdirSync(join(dir, 'backups'))
        const file = join(dir, 'backups', 'guard-1.db')
        writeFileSync(file, '')
        const at = new Date(NOW.getTime() - ageMs)
        utimesSync(file, at, at)
      }
      return deps({ databaseUrl: `file:${join(dir, 'guard.db')}` })
    }

    it('is happy with a backup from the last 26 hours', async () => {
      expect((await byId(withBackup(3_600_000)))['backup']?.status).toBe('ok')
    })

    it('warns when the newest backup is older than 26 hours', async () => {
      expect((await byId(withBackup(27 * 3_600_000)))['backup']?.status).toBe('warn')
    })

    it('warns when there is no backup at all', async () => {
      expect((await byId(withBackup()))['backup']).toMatchObject({
        status: 'warn',
        fix: expect.any(String),
      })
    })

    // CR-019: a one-click owner has the host's dashboard, not a terminal.
    it('points a one-click host at its disk', async () => {
      const hosted = { ...withBackup(), hosted: true }
      expect((await byId(hosted))['backup']?.fix).toMatch(/host's disk snapshots/)
      expect((await byId(withBackup()))['backup']?.fix).toMatch(/run the database backup by hand/)
    })

    it('with a bucket, names the last upload, and warns before the first', async () => {
      const d = { ...withBackup(3_600_000), bucket: true }
      expect((await byId(d))['backup']).toMatchObject({
        status: 'warn',
        message: expect.stringContaining('None has been uploaded'),
      })
      const dir = join(dirname(d.databaseUrl.slice('file:'.length)), 'backups')
      writeFileSync(join(dir, 'last-upload'), '2026-11-03T03:00:00.000Z')
      expect((await byId(d))['backup']).toMatchObject({
        status: 'ok',
        message: expect.stringContaining('2026-11-03T03:00:00.000Z'),
      })
    })

    it('warns when the last upload is over 26 hours old, and reads only a timestamp', async () => {
      const d = { ...withBackup(3_600_000), bucket: true }
      const dir = join(dirname(d.databaseUrl.slice('file:'.length)), 'backups')
      writeFileSync(join(dir, 'last-upload'), '2026-11-01T03:00:00.000Z')
      expect((await byId(d))['backup']).toMatchObject({ status: 'warn', fix: expect.any(String) })
      writeFileSync(join(dir, 'last-upload'), `2026-11-03T03:00:00.000Z${'x'.repeat(10_000)}`)
      const check = (await byId(d))['backup']
      expect(check?.message).toContain('None has been uploaded')
      expect(check?.message.length).toBeLessThan(200)
    })
  })
})

describe('public admin routes (CR-022)', () => {
  describe('vault control', () => {
    const vault = { address: 'vault', token: MINT, balance: '0' }

    it('says nothing when the adapter does not report who controls the vault', async () => {
      expect((await byId(deps()))[`${CHAIN}:control`]).toBeUndefined()
    })

    it('is happy with a vault that takes two keys', async () => {
      const d = deps()
      vi.spyOn(d.chain, 'getVault').mockResolvedValue({
        ...vault,
        control: { threshold: 2, signers: 3 },
      })
      expect((await byId(d))[`${CHAIN}:control`]).toMatchObject({
        status: 'ok',
        message: 'The vault on Solana devnet needs 2 of 3 keys to move funds.',
      })
    })

    it('on Solana names the config authority and a hardware wallet, never a higher threshold', async () => {
      const d = deps()
      vi.spyOn(d.chain, 'getVault').mockResolvedValue({
        ...vault,
        control: { threshold: 1, signers: 1 },
      })
      const check = (await byId(d))[`${CHAIN}:control`]
      expect(check).toMatchObject({ status: 'warn' })
      expect(check?.message).toContain('config authority')
      expect(check?.fix).toMatch(/^For larger balances/)
      expect(check?.fix).toContain('both as config authority and as member')
      expect(check?.fix).not.toMatch(/threshold|2-of-3/)
    })

    it('on EVM advises a 2-of-3 or a replaced owner, never one more owner at threshold 1', async () => {
      const base = 'eip155:8453'
      const chain = new StubChain(base, 1_000_000n)
      vi.spyOn(chain, 'getVault').mockResolvedValue({
        ...vault,
        control: { threshold: 1, signers: 2 },
      })
      const d = deps({ chains: new Map([[base, chain]]), usdc: new Map([[base, MINT]]) })
      expect((await byId(d))[`${base}:control`]).toMatchObject({
        status: 'warn',
        message: 'One key can empty the vault on Base.',
        fix: expect.stringContaining('2-of-3'),
      })
    })
  })

  it('warns when ALLOW_PUBLIC_ADMIN let the admin routes face every interface', async () => {
    expect((await byId({ ...deps(), publicAdmin: true }))['public_admin']).toMatchObject({
      status: 'warn',
      fix: expect.any(String),
    })
    expect((await byId(deps()))['public_admin']).toBeUndefined()
  })
})
