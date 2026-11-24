/// <reference lib="webworker" />
import { notification } from './domain/notify.js'
import { BASE } from './domain/route.js'

declare const self: ServiceWorkerGlobalScope
/** Set by build.ts: a new build gets a new cache, and the old one is dropped. */
declare const BUILD_ID: string

const CACHE = `panel-${BUILD_ID}`
const SHELL = ['', 'app.js', 'app.css', 'manifest.webmanifest', 'icons/icon-192.png'].map(
  (path) => BASE + path,
)

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)))
  void self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  )
})

/** The shell only. API answers are never cached: an approval list from the cache could be stale. */
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (
    event.request.method !== 'GET' ||
    url.origin !== location.origin ||
    !url.pathname.startsWith(BASE)
  ) {
    return
  }
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(async () => (await caches.match(BASE)) ?? Response.error()),
    )
    return
  }
  event.respondWith(caches.match(event.request).then((hit) => hit ?? fetch(event.request)))
})

/** The payload never holds a recipient or a link: the notification only opens the panel. */
self.addEventListener('push', (event) => {
  let data: unknown
  try {
    data = event.data?.json()
  } catch {
    data = undefined
  }
  const { title, body, tag, path } = notification(data)
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      icon: `${BASE}icons/icon-192.png`,
      data: path,
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const path: unknown = event.notification.data
  event.waitUntil(
    self.clients.openWindow(typeof path === 'string' && path.startsWith(BASE) ? path : BASE),
  )
})
