import { beforeEach, describe, expect, it } from 'vitest'
import { schema } from '../src/db/client.js'
import { pruneSessions } from '../src/db/sessions.js'
import { removePasskey } from '../src/service/remove-passkey.js'
import { ADMIN_TOKEN, harness, NOW, PASSKEY_RP, type Harness } from './harness.js'
import { softAuthenticator } from './webauthn.js'

const panel = { origin: PASSKEY_RP.origin, 'x-defimind-request': '1' }
type Device = ReturnType<typeof softAuthenticator>

async function enrol(h: Harness): Promise<Device> {
  const device = softAuthenticator(PASSKEY_RP.id, PASSKEY_RP.origin)
  const admin = { authorization: `Bearer ${ADMIN_TOKEN}` }
  const options = (
    await h.app.inject({ method: 'POST', url: '/v1/admin/passkeys/options', headers: admin })
  ).json()
  await h.app.inject({
    method: 'POST',
    url: '/v1/admin/passkeys',
    headers: admin,
    payload: { response: device.register(options.challenge) },
  })
  return device
}

const options = async (h: Harness) =>
  (await h.app.inject({ method: 'POST', url: '/v1/owner/session/options', headers: panel })).json()

const signIn = (h: Harness, assertion: object, headers: Record<string, string> = panel) =>
  h.app.inject({ method: 'POST', url: '/v1/owner/session', headers, payload: { assertion } })

async function session(h: Harness, device: Device): Promise<string> {
  const res = await signIn(h, device.assert((await options(h)).challenge))
  return /dm_session=([^;]*)/.exec(String(res.headers['set-cookie']))?.[1] ?? ''
}

const passkeys = (h: Harness, cookie?: string) =>
  h.app.inject({
    method: 'GET',
    url: '/v1/owner/passkeys',
    ...(cookie === undefined ? {} : { headers: { cookie: `dm_session=${cookie}` } }),
  })

const at = (h: Harness, minutes: number) => {
  h.clock.now = new Date(NOW.getTime() + minutes * 60_000)
}

let h: Harness
let device: Device
beforeEach(async () => {
  h = await harness()
  device = await enrol(h)
})

describe('owner sessions', () => {
  it('signs in with a passkey and sets a strict, script-proof cookie', async () => {
    const res = await signIn(h, device.assert((await options(h)).challenge))
    expect(res.json()).toEqual({ expiresAt: new Date(NOW.getTime() + 30 * 60_000).toISOString() })
    const cookie = String(res.headers['set-cookie'])
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/v1/owner']) {
      expect(cookie).toContain(attribute)
    }
    const token = /dm_session=([^;]*)/.exec(cookie)?.[1] ?? ''
    expect((await passkeys(h, token)).json().passkeys).toHaveLength(1)
    expect(JSON.stringify(h.db.select().from(schema.ownerSessions).all())).not.toContain(token)
    expect(h.auditEvents()).toContain('owner_signed_in')
  })

  it('refuses a gated route with no session, or an unknown one', async () => {
    expect((await passkeys(h)).statusCode).toBe(401)
    expect((await passkeys(h)).json()).toEqual({ error: 'no_session' })
    expect((await passkeys(h, 'x'.repeat(43))).statusCode).toBe(401)
  })

  it('ends a session idle for 30 minutes', async () => {
    const token = await session(h, device)
    at(h, 29)
    expect((await passkeys(h, token)).statusCode).toBe(200)
    at(h, 58)
    expect((await passkeys(h, token)).statusCode).toBe(200)
    at(h, 89)
    expect((await passkeys(h, token)).statusCode).toBe(401)
  })

  it('ends a session after 12 hours however active it is', async () => {
    const token = await session(h, device)
    for (let minutes = 20; minutes < 12 * 60; minutes += 20) {
      at(h, minutes)
      expect((await passkeys(h, token)).statusCode).toBe(200)
    }
    at(h, 12 * 60)
    expect((await passkeys(h, token)).statusCode).toBe(401)
  })

  it('signs out', async () => {
    const token = await session(h, device)
    const out = await h.app.inject({
      method: 'POST',
      url: '/v1/owner/session/logout',
      headers: { ...panel, cookie: `dm_session=${token}` },
    })
    expect(out.json()).toEqual({ ok: true })
    expect(String(out.headers['set-cookie'])).toContain('Max-Age=0')
    expect((await passkeys(h, token)).statusCode).toBe(401)
  })

  it.each([
    ['without the panel header', { origin: PASSKEY_RP.origin }],
    ['from another origin', { origin: 'https://evil.example', 'x-defimind-request': '1' }],
    ['with no origin', { 'x-defimind-request': '1' }],
  ])('refuses every state-changing request %s', async (_case, headers) => {
    const assertion = device.assert((await options(h)).challenge)
    for (const url of [
      '/v1/owner/session/options',
      '/v1/owner/session',
      '/v1/owner/session/logout',
    ]) {
      const res = await h.app.inject({ method: 'POST', url, headers, payload: { assertion } })
      expect(res.statusCode).toBe(403)
      expect(res.json()).toEqual({ error: 'bad_origin' })
    }
  })

  it('refuses a passkey that was never enrolled, and audits it', async () => {
    const stranger = softAuthenticator(PASSKEY_RP.id, PASSKEY_RP.origin)
    const res = await signIn(h, stranger.assert((await options(h)).challenge))
    expect(res.statusCode).toBe(401)
    expect(h.auditEvents()).toContain('owner_sign_in_refused')
  })

  it('refuses an assertion for another origin, or for a challenge never issued', async () => {
    const { challenge } = await options(h)
    expect((await signIn(h, device.assert(challenge, 'https://evil.example'))).statusCode).toBe(401)
    expect((await signIn(h, device.assert('A'.repeat(43)))).statusCode).toBe(401)
  })

  it('lets sign-in options lapse after two minutes', async () => {
    const { challenge } = await options(h)
    at(h, 2)
    expect((await signIn(h, device.assert(challenge))).statusCode).toBe(401)
  })

  it('opens one session for one assertion, even sent twice at once', async () => {
    const assertion = device.assert((await options(h)).challenge)
    const both = await Promise.all([signIn(h, assertion), signIn(h, assertion)])
    expect(both.map((r) => r.statusCode).sort()).toEqual([200, 401])
    expect((await signIn(h, assertion)).statusCode).toBe(401)
    expect(h.db.select().from(schema.ownerSessions).all()).toHaveLength(1)
  })

  it('prunes sessions past their twelve hours', async () => {
    await session(h, device)
    at(h, 12 * 60)
    pruneSessions(h.db, h.clock.now)
    expect(h.db.select().from(schema.ownerSessions).all()).toHaveLength(0)
  })

  it('ends the sessions of a passkey when it is removed', async () => {
    const token = await session(h, device)
    expect(removePasskey(h.db, device.id.slice(0, 8), h.clock.now)).toMatchObject({
      ok: true,
      sessions: 1,
    })
    expect((await passkeys(h, token)).statusCode).toBe(401)
    expect(h.auditEvents()).toContain('passkey_removed')
  })

  it('removes nothing for a prefix shorter than 8 characters, or one matching none', () => {
    expect(removePasskey(h.db, '', h.clock.now)).toMatchObject({ ok: false, reason: 'too_short' })
    expect(removePasskey(h.db, 'zzzzzzzzzz', h.clock.now)).toMatchObject({ reason: 'none' })
  })
})
