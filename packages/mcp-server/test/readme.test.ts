import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const readme = readFileSync(join(root, 'README.md'), 'utf8')

/** GitHub's heading anchor: lowercase, punctuation dropped, spaces to dashes. */
function anchor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s/g, '-')
}

describe('README trading quickstart', () => {
  it('links docs that exist, down to the heading', () => {
    const links = [...readme.matchAll(/\]\((\.\.\/[^)#\s]+)(?:#([^)\s]+))?\)/g)]
    const trading = links.filter((link) => link[1]?.endsWith('docs/trading.md'))
    expect(trading.length).toBeGreaterThan(0)
    for (const [, path, hash] of trading) {
      const file = join(root, path ?? '')
      expect(existsSync(file)).toBe(true)
      if (hash !== undefined) {
        const headings = [...readFileSync(file, 'utf8').matchAll(/^#+ (.+)$/gm)].map((m) =>
          anchor(m[1] ?? ''),
        )
        expect(headings).toContain(hash)
      }
    }
  })

  it('names the prompt the server serves and says it is not financial advice', () => {
    const quickstart = readme.slice(readme.indexOf('### Trading agent quickstart'))
    expect(quickstart).toContain('`trading-agent`')
    expect(quickstart).toContain('**Not financial advice.**')
    expect(quickstart).toMatch(/"Quote \$2 of `<mint>`/)
  })
})
