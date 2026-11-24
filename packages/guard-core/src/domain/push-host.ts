/** The browser push services: an exact host, or `.suffix` for the hosts under one. */
const ALLOWED = [
  'fcm.googleapis.com',
  'web.push.apple.com',
  '.push.apple.com',
  'updates.push.services.mozilla.com',
  '.push.services.mozilla.com',
  '.notify.windows.com',
]

/**
 * Whether guard-core may post to this subscription endpoint. A panel session chooses it, so
 * without this check a stolen session could point guard-core at any host, internal ones included.
 * Only the browser push services, over https on 443, by name: no IP literal, no other port.
 */
export function pushEndpointAllowed(endpoint: string): boolean {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || (url.port !== '' && url.port !== '443')) {
    return false
  }
  if (url.username !== '' || url.password !== '') {
    return false
  }
  const host = url.hostname.toLowerCase()
  return ALLOWED.some((entry) =>
    entry.startsWith('.') ? host.endsWith(entry) && host.length > entry.length : host === entry,
  )
}
