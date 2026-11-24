import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createDecipheriv } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { seal, signV4, upload, type BucketConfig } from '../src/adapters/bucket.js'
import { loadConfig } from '../src/config.js'
import { openDb } from '../src/db/client.js'
import { backUp, prune, scheduleBackups, untilHour } from '../src/service/backup.js'
import { ADMIN_TOKEN, NOW } from './harness.js'

const KEY = 'ab'.repeat(32)
const bucket: BucketConfig = {
  url: 'https://store.example/backups/guard',
  region: 'auto',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'secret-access-key',
  encryptionKey: KEY,
}

function open(key: string, sealed: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), sealed.subarray(0, 12))
  decipher.setAuthTag(sealed.subarray(-16))
  return Buffer.concat([decipher.update(sealed.subarray(12, -16)), decipher.final()])
}

function live(dir = mkdtempSync(join(tmpdir(), 'guard-backup-'))) {
  const file = join(dir, 'guard.db')
  const db = openDb(`file:${file}`)
  migrate(db, { migrationsFolder: 'migrations' })
  const log = { info: vi.fn(), error: vi.fn() }
  return { dir, db, log, databaseUrl: `file:${file}`, now: () => NOW, fetch: vi.fn<typeof fetch>() }
}

describe('the backup bucket', () => {
  it('signs as AWS Signature Version 4 does (the AWS documentation example)', () => {
    const hash = '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072'
    const auth = signV4({
      method: 'PUT',
      url: new URL('https://examplebucket.s3.amazonaws.com/test$file.text'),
      headers: {
        date: 'Fri, 24 May 2013 00:00:00 GMT',
        'x-amz-date': '20130524T000000Z',
        'x-amz-storage-class': 'REDUCED_REDUNDANCY',
        'x-amz-content-sha256': hash,
      },
      payloadHash: hash,
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      amzDate: '20130524T000000Z',
    })
    expect(auth).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, ' +
        'Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd',
    )
  })

  it('seals with AES-256-GCM under a fresh IV each time', () => {
    const plain = Buffer.from('the database')
    const once = seal(plain, KEY)
    expect(open(KEY, once).toString()).toBe('the database')
    expect(seal(plain, KEY).subarray(0, 12)).not.toEqual(once.subarray(0, 12))
    expect(() => open('cd'.repeat(32), once)).toThrow()
  })

  it('puts the sealed file under the prefix, signed, and never the key in the clear', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }))
    await upload(bucket, 'guard-2026-11-03.db', Buffer.from('plain'), fetchImpl, NOW)
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(String(url)).toBe('https://store.example/backups/guard/guard-2026-11-03.db.enc')
    const headers = init?.headers as Record<string, string>
    expect(headers['authorization']).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261103\/auto\/s3\//,
    )
    expect(headers['x-amz-date']).toBe('20261103T120000Z')
    const body = Buffer.from(init?.body as Uint8Array)
    expect(open(KEY, body).toString()).toBe('plain')
    expect(JSON.stringify(headers)).not.toContain('secret-access-key')
  })

  it('fails naming the status only', async () => {
    const refused = vi.fn<typeof fetch>(async () => new Response(null, { status: 403 }))
    const error = await upload(bucket, 'x.db', Buffer.from(''), refused, NOW).catch((e) => e)
    expect(error.message).toBe('backup upload refused with status 403')
  })
})

describe('the daily backup (CR-024)', () => {
  afterEach(() => vi.useRealTimers())

  it("writes the day's backup once, 0600, beside the database", async () => {
    const deps = live()
    const file = await backUp(deps)
    expect(file).toBe(join(deps.dir, 'backups', 'guard-2026-11-03.db'))
    expect(statSync(file ?? '').mode & 0o777).toBe(0o600)
    expect(await backUp(deps)).toBe(file)
    expect(readdirSync(join(deps.dir, 'backups'))).toEqual(['guard-2026-11-03.db'])
  })

  it('keeps the newest 14', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-prune-'))
    const names = Array.from(
      { length: 16 },
      (_, i) => `guard-2026-10-${String(i + 1).padStart(2, '0')}.db`,
    )
    for (const name of names) {
      writeFileSync(join(dir, name), '')
    }
    writeFileSync(join(dir, 'last-upload'), '')
    await prune(dir)
    expect(readdirSync(dir).sort()).toEqual([...names.slice(2), 'last-upload'].sort())
  })

  it('uploads it sealed when a bucket is set, and records when', async () => {
    const deps = { ...live(), bucket }
    deps.fetch.mockResolvedValue(new Response(null, { status: 200 }))
    await backUp(deps)
    expect(deps.fetch).toHaveBeenCalledOnce()
    expect(existsSync(join(deps.dir, 'backups', 'last-upload'))).toBe(true)
  })

  it('has nothing to back up in memory', async () => {
    expect(await backUp({ ...live(), databaseUrl: ':memory:' })).toBeUndefined()
  })

  it('runs at the hour, and logs a failure without stopping the schedule', async () => {
    expect(untilHour(new Date('2026-11-03T02:30:00Z'), 3)).toBe(30 * 60_000)
    expect(untilHour(new Date('2026-11-03T03:00:00Z'), 3)).toBe(86_400_000)

    vi.useFakeTimers({ now: new Date('2026-11-03T02:59:00Z') })
    const deps = { ...live(), now: () => new Date() }
    const days: string[] = []
    const run = vi.fn(async (d: { now: () => Date }) => {
      days.push(d.now().toISOString())
      if (days.length === 1) {
        throw new Error('disk full')
      }
    })
    const schedule = scheduleBackups(deps, 3, run)
    await vi.advanceTimersByTimeAsync(60_000 + 86_400_000)
    schedule.stop()
    expect(days).toEqual(['2026-11-03T03:00:00.000Z', '2026-11-04T03:00:00.000Z'])
    expect(deps.log.error).toHaveBeenCalledOnce()
  })

  it('refuses a bucket without its keys', () => {
    expect(() => loadConfig({ ADMIN_TOKEN, BACKUP_BUCKET_URL: 'https://store.example/b' })).toThrow(
      /BACKUP_ENCRYPTION_KEY/,
    )
  })
})
