#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { verify } from './verify.js'

const USAGE = `Usage: defimind-verify <bundle.json> [--key <hex>] [--rpc <url>] [--anchor-key <pubkey>]

Checks a proof bundle, a list of them, or a run of receipts, offline: each signature against --key
(the hex key from GET /v1/receipts/key of the deployment), each receipt hash, each Merkle path, the
root in its anchor transaction through --rpc or the cluster's public RPC, and over a run, that seq
has no gap and every prevHash links. --anchor-key fails an anchor published by any other key.
Exits 0 only when every check passes.`

async function main(argv: string[]): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        key: { type: 'string' },
        rpc: { type: 'string' },
        'anchor-key': { type: 'string' },
        help: { type: 'boolean' },
      },
    })
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}\n`)
    return 2
  }
  const [file] = parsed.positionals
  if (parsed.values.help === true || file === undefined || parsed.positionals.length > 1) {
    process.stderr.write(`${USAGE}\n`)
    return parsed.values.help === true ? 0 : 2
  }
  // pnpm runs the script from the package folder; the path is the caller's.
  const path = resolve(process.env['INIT_CWD'] ?? process.cwd(), file)
  let json: unknown
  try {
    // verify() parses it with zod before using any of it.
    // eslint-disable-next-line no-restricted-properties
    json = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    process.stderr.write(`${path} is not a readable JSON file\n`)
    return 2
  }
  const checks = await verify(json, {
    key: parsed.values.key,
    rpc: parsed.values.rpc,
    anchorKey: parsed.values['anchor-key'],
  })
  for (const check of checks) {
    process.stdout.write(`${check.pass ? 'pass' : 'FAIL'}  ${check.name}: ${check.detail}\n`)
  }
  const failed = checks.filter((check) => !check.pass).length
  process.stdout.write(failed === 0 ? 'All checks passed.\n' : `${failed} check(s) failed.\n`)
  return failed === 0 ? 0 : 1
}

process.exit(await main(process.argv.slice(2)))
