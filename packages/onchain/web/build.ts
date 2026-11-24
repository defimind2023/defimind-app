import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { configFromEnv, pageHtml } from './page.js'

/**
 * The owner's signing page, as static files in web/dist. Everything the page runs is bundled here
 * from the lockfile's pinned versions: nothing is fetched at runtime but the RPC, and the CSP allows
 * nothing else.
 *
 * app.js holds no address: index.html carries the config (page.ts). The hosted index.html gets it
 * from the env now; index.template.html is the same page unfilled, for guard-core's /sign.
 */
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export async function buildPage(outdir = here('./dist'), env = process.env) {
  await mkdir(outdir, { recursive: true })
  await build({
    entryPoints: [here('./src/main.ts')],
    outfile: `${outdir}/app.js`,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    // Some dependencies read process.env; a browser has no process.
    define: { 'process.env': '{}' },
    logLevel: 'warning',
  })
  const template = await readFile(here('./public/index.html'), 'utf8')
  await writeFile(`${outdir}/index.template.html`, template)
  await writeFile(`${outdir}/index.html`, pageHtml(template, configFromEnv(env)))
  await copyFile(here('./public/style.css'), `${outdir}/style.css`)
  await writeFile(`${outdir}/SHA256SUMS`, await sums(outdir))
}

/** The same for every deployment, since no file holds a config: what a release publishes. */
export const HASHED = ['app.js', 'style.css', 'index.template.html']

async function sums(outdir: string) {
  const lines = await Promise.all(
    HASHED.map(async (file) => {
      const digest = createHash('sha256').update(await readFile(`${outdir}/${file}`))
      return `${digest.digest('hex')}  ${file}\n`
    }),
  )
  return lines.join('')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildPage()
  process.stdout.write(await readFile(here('./dist/SHA256SUMS'), 'utf8'))
}
