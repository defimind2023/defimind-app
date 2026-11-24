import type { FastifyInstance, FastifyReply } from 'fastify'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// SPEC, CR-012: the panel loads nothing but its own files and calls nothing but this origin.
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

/** The build's files, by name; nothing else under /panel/ is ever read from disk. */
const FILES = new Map<string, string>([
  ['index.html', 'text/html; charset=utf-8'],
  ['app.js', 'text/javascript; charset=utf-8'],
  ['app.css', 'text/css; charset=utf-8'],
  ['sw.js', 'text/javascript; charset=utf-8'],
  ['manifest.webmanifest', 'application/manifest+json'],
  ['icons/icon-192.png', 'image/png'],
  ['icons/icon-512.png', 'image/png'],
  ['icons/logo.svg', 'image/svg+xml'],
])

// Names carry no hash, so a new build must reach the browser: the page and the service worker are
// always revalidated, and the rest are kept a day at most.
const FRESH = new Set(['index.html', 'sw.js'])

export const DEFAULT_PANEL_DIR = fileURLToPath(new URL('../../../panel/dist', import.meta.url))

/** The owner panel's static build at /panel/ (CR-012). Any other path under it is the app's own. */
export function panelRoutes(dir: string) {
  async function send(reply: FastifyReply, name: string) {
    const type = FILES.get(name)
    const body =
      type === undefined ? undefined : await readFile(join(dir, name)).catch(() => undefined)
    if (type === undefined || body === undefined) {
      return reply.code(404).send({ error: 'not_found' })
    }
    return reply
      .header('content-type', type)
      .header('content-security-policy', CSP)
      .header('x-content-type-options', 'nosniff')
      .header('x-frame-options', 'DENY')
      .header('strict-transport-security', 'max-age=31536000; includeSubDomains')
      .header('referrer-policy', 'no-referrer')
      .header('cache-control', FRESH.has(name) ? 'no-cache' : 'public, max-age=86400')
      .send(body)
  }

  return async (app: FastifyInstance) => {
    app.get('/panel', async (_request, reply) => reply.redirect('/panel/', 308))
    app.get('/panel/*', async (request, reply) => {
      const { '*': path } = request.params as { '*': string }
      return send(reply, FILES.has(path) ? path : 'index.html')
    })
  }
}
