import { loadConfig } from '@defimind/guard-core'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { z } from 'zod'
import { requirePersistentDb } from '../../packages/guard-core/src/db/placement.js'

const envVar = z.union([
  z.object({ key: z.string(), value: z.string() }).strict(),
  z.object({ key: z.string(), generateValue: z.literal(true) }).strict(),
])
const blueprint = z.object({
  services: z.tuple([
    z.object({
      autoDeployTrigger: z.string(),
      disk: z.object({ mountPath: z.string() }),
      envVars: z.array(envVar),
    }),
  ]),
})

const file = readFileSync(join(import.meta.dirname, '../../render.yaml'), 'utf8')
const [service] = blueprint.parse(parse(file)).services

/** What Render hands the container: the blueprint's values, its generated ones, and its own. */
function renderEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PORT: '10000',
    RENDER_EXTERNAL_URL: 'https://defimind-abcd.onrender.com',
  }
  for (const v of service.envVars) {
    env[v.key] = 'value' in v ? v.value : randomBytes(32).toString('base64')
  }
  return env
}

describe('render.yaml, the one-click deployment (CR-019)', () => {
  it('starts guard-core with nothing but what Render provides', () => {
    const config = loadConfig(renderEnv())
    expect(config).toMatchObject({
      HOST: '0.0.0.0',
      PORT: 10000,
      PUBLIC_URL: 'https://defimind-abcd.onrender.com',
      PASSKEY_RP_ID: 'defimind-abcd.onrender.com',
      PASSKEY_ORIGIN: 'https://defimind-abcd.onrender.com',
      ADMIN_ROUTES: 'false',
      TRUST_FORWARDED_FOR: 'true',
    })
    expect(config.SETUP_CODE).toBeDefined()
    expect(() => requirePersistentDb(config)).not.toThrow()
  })

  it('keeps the database on the disk', () => {
    const db = service.envVars.find((v) => v.key === 'DATABASE_URL')
    expect(db && 'value' in db && db.value).toBe(`file:${service.disk.mountPath}/guard.db`)
  })

  it('writes no secret into the repository: Render generates the two it needs', () => {
    const generated = service.envVars.filter((v) => !('value' in v)).map((v) => v.key)
    expect(generated.sort()).toEqual(['ADMIN_TOKEN', 'SETUP_CODE'])
    const keys = service.envVars.map((v) => v.key)
    expect(keys.filter((k) => /KEY|SECRET|TOKEN|JSON/.test(k))).toEqual(['ADMIN_TOKEN'])
  })

  it('never redeploys a service that holds hot keys on a push to main', () => {
    expect(service.autoDeployTrigger).toBe('off')
  })
})
