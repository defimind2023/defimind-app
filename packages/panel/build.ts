import { randomBytes } from 'node:crypto'
import { copyFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { writeIcon } from './icons.js'

/**
 * The panel as static files in dist, flat, for guard-core to serve at /panel/. Everything it runs is
 * bundled here from the lockfile: the CSP lets the page load nothing from anywhere else.
 */
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))

const STATIC = ['index.html', 'app.css', 'manifest.webmanifest', 'icons/logo.svg']

export async function buildPanel(outdir = here('./dist')) {
  await mkdir(`${outdir}/icons`, { recursive: true })
  const common = {
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    logLevel: 'warning',
  } as const
  await build({ ...common, entryPoints: [here('./src/main.ts')], outfile: `${outdir}/app.js` })
  await build({
    ...common,
    entryPoints: [here('./src/sw.ts')],
    outfile: `${outdir}/sw.js`,
    define: { BUILD_ID: JSON.stringify(randomBytes(6).toString('hex')) },
  })
  for (const file of STATIC) {
    await copyFile(here(`./public/${file}`), `${outdir}/${file}`)
  }
  for (const size of [192, 512]) {
    await writeIcon(`${outdir}/icons/icon-${size}.png`, size)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildPanel()
}
