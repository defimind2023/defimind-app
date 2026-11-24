import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { readEvmKeyFile, readKeypairFile, readReceiptKeyFile } from '../src/adapters/keypair.js'

const ENTRYPOINT = join(import.meta.dirname, '../deploy/entrypoint.sh')
const SOLANA_KEY = JSON.stringify(Array.from({ length: 64 }, (_, i) => i))
const BASE_KEY = `0x${'ab'.repeat(32)}`
const ROBINHOOD_KEY = `0x${'cd'.repeat(32)}`
const RECEIPT_KEY = generateKeyPairSync('ed25519')
  .privateKey.export({ format: 'pem', type: 'pkcs8' })
  .toString()
const ANCHOR_KEY = JSON.stringify(Array.from({ length: 64 }, (_, i) => (i * 7) % 256))
const VAPID_KEY = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  .privateKey.export({ format: 'pem', type: 'sec1' })
  .toString()

// Mounting tmpfs and dropping to another user both need root, as on a Fly machine.
const root = process.platform === 'linux' && process.getuid?.() === 0
// The parent must be traversable by the app user, as /run is.
const parent = mkdtempSync(join(tmpdir(), 'guard-entry-'))
chmodSync(parent, 0o755)
const dir = join(parent, 'run')
const data = join(parent, 'data')
mkdirSync(data)

describe.skipIf(!root)('deploy/entrypoint.sh', () => {
  afterAll(() => {
    execFileSync('umount', [dir])
  })

  const run = (script: string) =>
    execFileSync(ENTRYPOINT, ['sh', '-c', script], {
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'],
        DEFIMIND_KEY_DIR: dir,
        DEFIMIND_USER: 'nobody',
        DEFIMIND_DATA_DIR: data,
        SOLANA_HOT_WALLET_KEYPAIR_JSON: SOLANA_KEY,
        BASE_HOT_WALLET_KEY: BASE_KEY,
        ROBINHOOD_HOT_WALLET_KEY: ROBINHOOD_KEY,
        RECEIPT_SIGNING_KEY: RECEIPT_KEY,
        VAPID_PRIVATE_KEY: VAPID_KEY,
        ANCHOR_KEYPAIR_JSON: ANCHOR_KEY,
      },
    })

  it('moves every key to tmpfs files and out of the environment of what it runs', () => {
    const env = run('env')
    expect(env).not.toContain(SOLANA_KEY)
    expect(env).not.toContain(BASE_KEY)
    expect(env).not.toContain(ROBINHOOD_KEY)
    expect(env).not.toContain('PRIVATE KEY')
    expect(env).toContain(`SOLANA_HOT_WALLET_KEYPAIR=${dir}/hot.json`)
    expect(env).toContain(`BASE_HOT_WALLET_KEY_FILE=${dir}/base-hot`)
    expect(env).toContain(`ROBINHOOD_HOT_WALLET_KEY_FILE=${dir}/robinhood-hot`)
    expect(env).toContain(`RECEIPT_SIGNING_KEY_FILE=${dir}/receipt.pem`)
    expect(env).toContain(`VAPID_PRIVATE_KEY_FILE=${dir}/vapid.pem`)
    expect(env).toContain(`ANCHOR_KEY_FILE=${dir}/anchor.json`)
    expect(env).not.toContain(ANCHOR_KEY)
    expect(execFileSync('stat', ['-f', '-c', '%T', dir], { encoding: 'utf8' }).trim()).toBe('tmpfs')
  })

  it('runs the command as the app user, the only one who can read the files', () => {
    const nobody = execFileSync('id', ['-u', 'nobody'], { encoding: 'utf8' }).trim()
    expect(run('id -u').trim()).toBe(nobody)
    expect(String(statSync(data).uid)).toBe(nobody)
    for (const file of [
      'hot.json',
      'base-hot',
      'robinhood-hot',
      'receipt.pem',
      'vapid.pem',
      'anchor.json',
    ]) {
      const stat = statSync(join(dir, file))
      expect(stat.mode & 0o777).toBe(0o600)
      expect(String(stat.uid)).toBe(nobody)
    }
  })

  it('mounts nothing when the env carries no key, as on a one-click host', () => {
    const none = join(parent, 'none')
    const out = execFileSync(ENTRYPOINT, ['id', '-u'], {
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'],
        DEFIMIND_KEY_DIR: none,
        DEFIMIND_USER: 'nobody',
        DEFIMIND_DATA_DIR: data,
      },
    })
    expect(out.trim()).toBe(execFileSync('id', ['-u', 'nobody'], { encoding: 'utf8' }).trim())
    expect(existsSync(none)).toBe(false)
  })

  it('writes files guard-core reads back as the same keys', async () => {
    run('true')
    expect(await readKeypairFile(join(dir, 'hot.json'))).toEqual(
      Uint8Array.from(JSON.parse(SOLANA_KEY) as number[]),
    )
    expect(await readEvmKeyFile(join(dir, 'base-hot'))).toBe(BASE_KEY)
    expect(await readEvmKeyFile(join(dir, 'robinhood-hot'))).toBe(ROBINHOOD_KEY)
    expect((await readReceiptKeyFile(join(dir, 'receipt.pem'))).asymmetricKeyType).toBe('ed25519')
  })
})
