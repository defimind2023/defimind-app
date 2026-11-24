import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { checkEnvs, withBot } from './env-check.js'

const root = new URL('../../packages/', import.meta.url)
const envFile = (pkg: string) => new URL(`${pkg}/.env`, root)

function read(pkg: string): NodeJS.Dict<string> {
  try {
    return parseEnv(readFileSync(envFile(pkg), 'utf8'))
  } catch {
    console.error(`missing packages/${pkg}/.env: copy packages/${pkg}/.env.example and fill it in`)
    process.exit(1)
  }
}

/**
 * Checks the .env files and says whether the bot runs too. Without BOT_URL and its two in
 * guard-core's file, the owner works from the panel alone and no bot is started (CR-017).
 */
export function devCheck(): boolean {
  const guard = read('guard-core')
  const bot = existsSync(envFile('telegram-bot')) ? read('telegram-bot') : undefined
  const { errors, warnings } = checkEnvs({
    guard,
    ...(bot ? { bot } : {}),
    mcp: read('mcp-server'),
  })
  for (const warning of warnings) {
    console.warn(`warning: ${warning}`)
  }
  for (const error of errors) {
    console.error(`error: ${error}`)
  }
  if (errors.length > 0) {
    process.exit(1)
  }
  return withBot(guard)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  devCheck()
}
