import {
  createDecipheriv,
  createECDH,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import webpush from 'web-push'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  pushOptions,
  readVapidKeyFile,
  subscription,
  type PushService,
} from '../src/adapters/push.js'
import { schema } from '../src/db/client.js'
import { ATTACK_WINDOW_MS } from '../src/service/push.js'
import { CHAIN, harness, MERCHANT, MINT, NOW, type Harness } from './harness.js'
import { signedIn } from './owner.js'

/** A browser's push keys: the P-256 pair and the auth secret the panel gets from pushManager. */
function browser() {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const auth = randomBytes(16)
  return {
    ecdh,
    auth,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
  }
}

/** RFC 8291 and RFC 8188 decryption, as the browser does it. */
function decrypt(body: Buffer, { ecdh, auth }: ReturnType<typeof browser>): string {
  const salt = body.subarray(0, 16)
  const idlen = body[20] ?? 0
  const server = body.subarray(21, 21 + idlen)
  const ciphertext = body.subarray(21 + idlen)
  const shared = ecdh.computeSecret(server)
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), server])
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, info, 32))
  const key = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: aes128gcm\0', 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: nonce\0', 12))
  const decipher = createDecipheriv('aes-128-gcm', key, nonce)
  decipher.setAuthTag(ciphertext.subarray(-16))
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()])
  return plain.subarray(0, plain.lastIndexOf(2)).toString()
}

function vapidFile(curve = 'P-256'): string {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: curve })
  const file = join(mkdtempSync(join(tmpdir(), 'vapid-')), 'vapid.pem')
  writeFileSync(file, privateKey.export({ format: 'pem', type: 'sec1' }))
  return file
}

describe('VAPID keys and encryption', () => {
  it('reads a P-256 PEM and gives the uncompressed public point', async () => {
    const vapid = await readVapidKeyFile(vapidFile(), 'mailto:owner@example.com')
    expect(Buffer.from(vapid.publicKey, 'base64url')).toHaveLength(65)
    expect(Buffer.from(vapid.publicKey, 'base64url')[0]).toBe(4)
  })

  it('refuses a key on another curve, naming only the path', async () => {
    const file = vapidFile('secp384r1')
    await expect(readVapidKeyFile(file, 'mailto:o@example.com')).rejects.toThrow(
      `invalid VAPID key file: ${file}`,
    )
  })

  it('encrypts per RFC 8291 so the browser can read it, with a VAPID signature', async () => {
    const vapid = await readVapidKeyFile(vapidFile(), 'mailto:owner@example.com')
    const device = browser()
    const target = { endpoint: 'https://push.example/send/abc', ...device.keys }
    const request = webpush.generateRequestDetails(
      subscription(target),
      '{"kind":"kill"}',
      pushOptions(vapid),
    )
    expect(request.headers['Content-Encoding']).toBe('aes128gcm')
    expect(String(request.headers['Authorization'])).toMatch(
      new RegExp(`^vapid t=.+, k=${vapid.publicKey}$`),
    )
    expect(decrypt(Buffer.from(request.body as Buffer), device)).toBe('{"kind":"kill"}')
  })
})

describe('Web Push to the panel', () => {
  let h: Harness
  let sent: { endpoint: string; body: Record<string, unknown> }[]
  let status: number
  let owner: Awaited<ReturnType<typeof signedIn>>

  const service: PushService = {
    send: vi.fn(async (target, payload) => {
      sent.push({ endpoint: target.endpoint, body: JSON.parse(payload) })
      return status
    }),
  }
  const pay = (amount: string, recipient = MERCHANT) =>
    h.agent('POST', '/v1/agent/transfer', {
      agentId: 'agent-1',
      chain: CHAIN,
      token: MINT,
      amount,
      recipient,
      reason: 'pay',
    })
  const flush = () => new Promise((resolve) => setImmediate(resolve))

  beforeEach(async () => {
    sent = []
    status = 201
    h = await harness({ push: { service, publicKey: 'BPUBLIC' } })
    owner = await signedIn(h)
    await owner.call('POST', '/v1/owner/push', {
      subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/1', keys: browser().keys },
    })
  })

  it('gives the panel the public key, and keeps one subscription per endpoint', async () => {
    expect((await owner.call('GET', '/v1/owner/push/key')).json()).toEqual({ publicKey: 'BPUBLIC' })
    const again = await owner.call('POST', '/v1/owner/push', {
      subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/1', keys: browser().keys },
    })
    expect(h.db.select().from(schema.pushSubscriptions).all()).toHaveLength(1)
    expect((await owner.call('DELETE', `/v1/owner/push/${again.json().id}`)).json()).toEqual({
      ok: true,
    })
    expect(h.db.select().from(schema.pushSubscriptions).all()).toHaveLength(0)
  })

  it.each([
    'https://internal.service.local/hook',
    'https://169.254.169.254/latest',
    'https://fcm.googleapis.com.evil.example/fcm/send/1',
  ])('refuses %s, which is not a browser push service', async (endpoint) => {
    const res = await owner.call('POST', '/v1/owner/push', {
      subscription: { endpoint, keys: browser().keys },
    })
    expect(res.json()).toEqual({ error: 'push_host_not_allowed' })
  })

  it('never sends to a stored endpoint outside the push services', async () => {
    h.db
      .insert(schema.pushSubscriptions)
      .values({
        id: 'x',
        endpoint: 'https://internal.local/hook',
        p256dh: 'p',
        auth: 'a',
        createdAt: NOW.toISOString(),
      })
      .run()
    await owner.call('POST', '/v1/owner/kill', {})
    await flush()
    expect(sent.map((s) => s.endpoint)).toEqual(['https://fcm.googleapis.com/fcm/send/1'])
  })

  it('pushes an approval with no recipient and no URL', async () => {
    const { intentId } = (await pay('3000000')).json()
    await flush()
    expect(sent.map((s) => s.body)).toEqual([
      {
        kind: 'approval',
        agentId: 'agent-1',
        chain: CHAIN,
        amount: '3000000',
        intentId,
        sentAt: NOW.toISOString(),
      },
    ])
    expect(JSON.stringify(sent)).not.toContain(MERCHANT)
  })

  it('pushes an executed payment and a kill', async () => {
    await pay('1000000')
    await owner.call('POST', '/v1/owner/kill', {})
    await flush()
    expect(sent.map((s) => s.body['kind'])).toEqual(['executed', 'kill'])
  })

  it('pushes an attack once per agent and code in its window', async () => {
    vi.spyOn(h.chain, 'simulate').mockResolvedValue({
      simulation: { summary: 'approve', balanceChanges: [] },
      rejectReasons: ['DELEGATE_DETECTED'],
    })
    await pay('1000000')
    await pay('1000000')
    await flush()
    expect(sent.filter((s) => s.body['kind'] === 'attack')).toHaveLength(1)
    h.clock.now = new Date(NOW.getTime() + ATTACK_WINDOW_MS)
    await pay('1000000')
    await flush()
    expect(sent.filter((s) => s.body['kind'] === 'attack')).toHaveLength(2)
  })

  it('deletes a subscription the push service says is gone', async () => {
    status = 410
    await pay('1000000')
    await flush()
    await flush()
    expect(h.db.select().from(schema.pushSubscriptions).all()).toHaveLength(0)
  })

  it('answers 404 for the key when push is off', async () => {
    const off = await harness()
    const panel = await signedIn(off)
    expect((await panel.call('GET', '/v1/owner/push/key')).json()).toEqual({
      error: 'push_not_configured',
    })
  })
})
