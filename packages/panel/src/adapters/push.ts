import type { OwnerApi } from './api.js'
import { fromBase64url } from './webauthn.js'

/** guard-core's id for this device's subscription, needed to delete it. */
const KEY = 'defimind.push'

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window

export async function pushEnabled(): Promise<boolean> {
  if (!supported() || localStorage.getItem(KEY) === null) {
    return false
  }
  const registration = await navigator.serviceWorker.ready
  return (await registration.pushManager.getSubscription()) !== null
}

export async function enablePush(api: OwnerApi): Promise<void> {
  if (!supported()) {
    throw new Error(
      'This browser cannot receive notifications. On iPhone, add the panel to the Home Screen first.',
    )
  }
  if ((await Notification.requestPermission()) !== 'granted') {
    throw new Error('Notifications are blocked for this site in the browser settings.')
  }
  const registration = await navigator.serviceWorker.ready
  const { publicKey } = await api.pushKey()
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: fromBase64url(publicKey),
  })
  const { endpoint, keys } = subscription.toJSON()
  const { id } = await api.subscribe({ endpoint, keys })
  localStorage.setItem(KEY, id)
}

export async function disablePush(api: OwnerApi): Promise<void> {
  const id = localStorage.getItem(KEY)
  if (id !== null) {
    await api.unsubscribe(id)
    localStorage.removeItem(KEY)
  }
  const registration = await navigator.serviceWorker.ready
  await (await registration.pushManager.getSubscription())?.unsubscribe()
}
