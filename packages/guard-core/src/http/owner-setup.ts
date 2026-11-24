import type { FastifyInstance } from 'fastify'
import type { PublicKeys } from '../adapters/public-keys.js'
import { countPasskeys } from '../db/passkeys.js'
import { listWallets } from '../db/wallets.js'
import * as repo from '../db/repo.js'
import { tokenMatches } from '../domain/auth.js'
import { issueEnrolCode } from '../service/passkeys.js'
import type { PaymentDeps } from '../service/payments.js'
import { HttpError } from './errors.js'
import { sameOriginCheck } from './owner-session.js'
import { ownerSetup } from './schemas.js'

/** Tries per address before the first passkey; the code itself is far beyond guessing. */
const SETUP_TRIES = { max: 5, timeWindow: '15 minutes' }

/**
 * First access (CR-019). Until a passkey exists, the host's SETUP_CODE buys the same one-time enrol
 * link as `pnpm passkey-code`; once one exists the code is dead, so whoever reaches a fresh
 * deployment first still needs what only the host's dashboard shows.
 */
export function ownerSetupRoutes(deps: PaymentDeps, origin: string, setupCode?: string) {
  const { db, now } = deps
  return async (app: FastifyInstance) => {
    app.addHook('preHandler', sameOriginCheck(origin))

    app.get('/v1/owner/setup', async () => ({ needsSetup: countPasskeys(db) === 0 }))

    app.post('/v1/owner/setup', { config: { rateLimit: SETUP_TRIES } }, async (request) => {
      if (countPasskeys(db) > 0) {
        throw new HttpError(410, 'setup_done')
      }
      if (setupCode === undefined) {
        throw new HttpError(404, 'setup_not_configured')
      }
      const { setupCode: presented } = ownerSetup.parse(request.body)
      if (!tokenMatches(presented, setupCode)) {
        repo.audit(db, { event: 'setup_code_refused' }, now())
        throw new HttpError(401, 'setup_code_invalid')
      }
      const { code, expiresAt } = issueEnrolCode(db, now())
      repo.audit(db, { event: 'passkey_code_issued', detail: { expiresAt, via: 'setup' } }, now())
      // In the fragment, which the browser never sends, so the code reaches no server log.
      return { enrolLink: `${origin}/panel/enrol#code=${code}`, expiresAt }
    })
  }
}

/** Public halves only: no route ever answers a private key (ADR 006). */
export function ownerKeysRoute(keys: PublicKeys, db: PaymentDeps['db']) {
  return async (app: FastifyInstance) => {
    app.get('/v1/owner/keys', async () => ({
      ...keys,
      agentWallets: listWallets(db).map(({ agentId, chain, address }) => ({
        agentId,
        chain,
        address,
      })),
    }))
  }
}
