import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/server'
import { generateAuthenticationOptions } from '@simplewebauthn/server'
import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { Db } from '../db/client.js'
import { listPasskeys, putChallenge } from '../db/passkeys.js'
import * as store from '../db/sessions.js'
import type { PasskeySetup } from './passkeys.js'

export const IDLE_MS = 30 * 60_000
export const LIFETIME_MS = 12 * 60 * 60_000
const OPTIONS_MS = 2 * 60_000

/**
 * Sign-in options. Nobody is known yet, so each request gets its own challenge, keyed by the
 * challenge itself: the answer names it in its client data, and that is how it is found again.
 */
export async function sessionOptions(
  db: Db,
  setup: Pick<PasskeySetup, 'rpId'>,
  now: Date,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const options = await generateAuthenticationOptions({
    rpID: setup.rpId,
    userVerification: 'required',
    allowCredentials: listPasskeys(db).map((key) => ({ id: key.id })),
  })
  putChallenge(
    db,
    sessionPurpose(options.challenge),
    options.challenge,
    new Date(now.getTime() + OPTIONS_MS),
  )
  return options
}

export function sessionPurpose(challenge: string): string {
  return `session:${challenge}`
}

const withClientData = z.object({ response: z.object({ clientDataJSON: z.base64url() }) })
const clientData = z.object({ challenge: z.string().min(16).max(128) })

/** The challenge an assertion claims to answer, read from its client data; verification follows. */
export function claimedChallenge(assertion: unknown): string | undefined {
  const outer = withClientData.safeParse(assertion)
  if (!outer.success) {
    return undefined
  }
  const text = Buffer.from(outer.data.response.clientDataJSON, 'base64url').toString()
  let json: unknown
  try {
    // The zod schema below is exactly the validation the rule asks for.
    // eslint-disable-next-line no-restricted-properties
    json = JSON.parse(text)
  } catch {
    return undefined
  }
  const inner = clientData.safeParse(json)
  return inner.success ? inner.data.challenge : undefined
}

export function openSession(db: Db, passkeyId: string, now: Date) {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(now.getTime() + LIFETIME_MS)
  store.saveSession(db, {
    tokenHash: tokenHash(token),
    passkeyId,
    createdAt: now.toISOString(),
    lastSeenAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  })
  return { token, expiresAt: idleEnd(now, expiresAt).toISOString() }
}

/**
 * The live session this token belongs to, kept alive by the use. One idle for 30 minutes, or 12
 * hours old, is ended instead.
 */
export function useSession(db: Db, token: string, now: Date): store.OwnerSession | undefined {
  const hash = tokenHash(token)
  const session = store.getSession(db, hash)
  if (session === undefined) {
    return undefined
  }
  const idle = new Date(session.lastSeenAt).getTime() + IDLE_MS
  if (now.getTime() >= Math.min(idle, new Date(session.expiresAt).getTime())) {
    store.deleteSession(db, hash)
    return undefined
  }
  store.touchSession(db, hash, now)
  return session
}

export function closeSession(db: Db, token: string): void {
  store.deleteSession(db, tokenHash(token))
}

function idleEnd(now: Date, expiresAt: Date): Date {
  return new Date(Math.min(now.getTime() + IDLE_MS, expiresAt.getTime()))
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
