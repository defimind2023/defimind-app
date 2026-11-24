import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { chain, rawKeyHex } from './chain.js'

const dir = mkdtempSync(join(tmpdir(), 'defimind-verify-'))

function run(args: string[]) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    encoding: 'utf8',
    env: { ...process.env, INIT_CWD: dir },
  })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

describe('defimind-verify', () => {
  const receipts = chain(3)
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ receipts }))
  writeFileSync(join(dir, 'gap.json'), JSON.stringify({ receipts: [receipts[0], receipts[2]] }))

  it('prints a pass per check and exits 0 for a good run', () => {
    const { code, out } = run(['run.json', '--key', rawKeyHex()])
    expect(out).toContain('pass  seq 1 signature: signed by the given key')
    expect(out).toContain('pass  chain: seq 1-3: no gap, every prevHash links')
    expect(out).toContain('All checks passed.')
    expect(code).toBe(0)
  })

  it('exits 1 and says FAIL for a gap', () => {
    const { code, out } = run(['gap.json', '--key', rawKeyHex()])
    expect(out).toContain('FAIL  chain: seq 1 is followed by 3')
    expect(code).toBe(1)
  })

  it('exits 2 for no file or one it cannot read', () => {
    expect(run([]).code).toBe(2)
    expect(run(['missing.json']).err).toContain('is not a readable JSON file')
  })
})
