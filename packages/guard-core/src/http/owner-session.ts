import type { AuthenticationResponseJSON } from '@simplewebauthn/server'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import * as repo from '../db/repo.js'
import type { OwnerSession } from '../db/sessions.js'
import { verifyAssertion } from '../service/passkeys.js'
import type { PaymentDeps } from '../service/payments.js'
import {
  claimedChallenge,
  closeSession,
  LIFETIME_MS,
  openSession,
  sessionOptions,
  sessionPurpose,
  useSession,
} from '../service/sessions.js'
import { HttpError } from './errors.js'
import { ownerSignIn } from './schemas.js'

const COOKIE = 'dm_session'
type Address = { rpId: string; origin: string }

declare module 'fastify' {
  interface FastifyRequest {
    ownerSession?: OwnerSession
  }
}

/**
 * The panel's sign-in (CR-012). A session is a cookie the browser keeps from scripts and other
 * sites; a request that changes anything must also come from the panel's own origin, with a header
 * no plain form or cross-site fetch can set. `gated` registers the routes that need a session.
 */
export function ownerSessionRoutes(
  deps: PaymentDeps,
  rp: Address,
  gated: (app: FastifyInstance) => Promise<void>,
) {
  const { db, now } = deps
  const sameOrigin = sameOriginCheck(rp.origin)

  return async (app: FastifyInstance) => {
    app.addHook('preHandler', sameOrigin)

    app.post('/v1/owner/session/options', async () => sessionOptions(db, rp, now()))

    app.post('/v1/owner/session', async (request, reply) => {
      const { assertion } = ownerSignIn.parse(request.body)
      const challenge = claimedChallenge(assertion)
      const passkeyId =
        challenge === undefined
          ? undefined
          : await verifyAssertion(
              db,
              rp,
              sessionPurpose(challenge),
              assertion as unknown as AuthenticationResponseJSON,
              now(),
            )
      if (passkeyId === undefined) {
        repo.audit(db, { event: 'owner_sign_in_refused' }, now())
        throw new HttpError(401, 'passkey_not_verified')
      }
      const { token, expiresAt } = openSession(db, passkeyId, now())
      repo.audit(
        db,
        { event: 'owner_signed_in', detail: { passkey: passkeyId.slice(0, 8) } },
        now(),
      )
      setCookie(reply, token, LIFETIME_MS / 1000)
      return { expiresAt }
    })

    app.post('/v1/owner/session/logout', async (request, reply) => {
      const token = readCookie(request.headers.cookie)
      if (token !== undefined) {
        closeSession(db, token)
        repo.audit(db, { event: 'owner_signed_out' }, now())
      }
      setCookie(reply, '', 0)
      return { ok: true }
    })

    await app.register(async (scope) => {
      scope.addHook('preHandler', async (request, reply) => {
        const token = readCookie(request.headers.cookie)
        const session = token === undefined ? undefined : useSession(db, token, now())
        if (session === undefined) {
          return reply.code(401).send({ error: 'no_session' })
        }
        request.ownerSession = session
      })
      await gated(scope)
    })
  }
}

export function sameOriginCheck(origin: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.method === 'GET' || request.method === 'HEAD') {
      return
    }
    if (request.headers['x-defimind-request'] !== '1' || request.headers.origin !== origin) {
      return reply.code(403).send({ error: 'bad_origin' })
    }
  }
}

function setCookie(reply: FastifyReply, token: string, maxAge: number) {
  reply.header(
    'set-cookie',
    `${COOKIE}=${token}; Max-Age=${maxAge}; Path=/v1/owner; HttpOnly; Secure; SameSite=Strict`,
  )
}

export function readCookie(header: string | undefined): string | undefined {
  for (const part of header?.split(';') ?? []) {
    const [name, value] = part.trim().split('=', 2)
    if (name === COOKIE && value !== undefined && /^[A-Za-z0-9_-]{43}$/.test(value)) {
      return value
    }
  }
  return undefined
}
