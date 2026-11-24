import { request } from 'node:http'
import { StubChain } from '@defimind/guard-core'
import type { Vault } from '@defimind/onchain'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SOLANA } from './support/paid-api.js'
import { stack, type Stack } from './support/stack.js'

/**
 * CR-022 on the deployment's edges: the Host a request names (LOW-2), who may enrol the first
 * passkey, and the doctor's word on who controls the vault (HIGH-3).
 */

let s: Stack

afterEach(async () => {
  await s.close()
})

/** A GET with a Host header fetch() would not let us set. */
function getAs(host: string, path: string): Promise<number> {
  const url = new URL(path, s.guardUrl)
  return new Promise((resolve, reject) => {
    const req = request(
      { host: url.hostname, port: url.port, path: url.pathname, headers: { host } },
      (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      },
    )
    req.on('error', reject)
    req.end()
  })
}

describe('the Host header (LOW-2)', () => {
  it('answers 421 to a name the owner never gave it, and /health to any', async () => {
    s = await stack({ panel: true })
    expect(await getAs('evil.example', '/v1/owner/setup')).toBe(421)
    expect(await getAs('guard.example', '/v1/owner/setup')).not.toBe(421)
    expect(await getAs('evil.example', '/health')).toBe(200)
  })
})

describe('the first passkey (CR-022)', () => {
  it('comes only from the setup code: the admin token is refused, and the owner hears of it', async () => {
    s = await stack({ panel: true, setupCode: 's'.repeat(32) })
    for (const path of ['/v1/admin/passkeys/options', '/v1/admin/passkeys/code']) {
      expect(await s.admin('POST', path)).toEqual({
        status: 403,
        body: { error: 'use_setup_code' },
      })
    }
    await vi.waitFor(() =>
      expect(s.telegram.messages.some((m) => m.text.includes('Possible attack blocked'))).toBe(
        true,
      ),
    )
  })
})

/** A chain whose vault one key controls, as every controlled Squads multisig is. */
class OneKeyVault extends StubChain {
  override async getVault(): Promise<Vault> {
    return { ...(await super.getVault()), control: { threshold: 1, signers: 1 } }
  }
}

describe('who controls the vault (HIGH-3)', () => {
  it('warns when one key can empty it, and names the Solana fix', async () => {
    s = await stack({ chain: new OneKeyVault(SOLANA.chain, 100_000_000n) })
    const { body } = await s.admin('GET', '/v1/admin/doctor')
    const checks = (body as { checks: { id: string; status: string; fix?: string }[] }).checks
    expect(checks.find((c) => c.id === `${SOLANA.chain}:control`)).toMatchObject({
      status: 'warn',
      fix: expect.stringContaining('hardware wallet'),
    })
  })
})
