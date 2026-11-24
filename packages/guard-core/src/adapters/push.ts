import { createPrivateKey, createPublicKey, type JsonWebKey } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import webpush from 'web-push'

export interface Vapid {
  /** Uncompressed P-256 point, base64url: what a browser's pushManager.subscribe takes. */
  publicKey: string
  privateKey: string
  subject: string
}

export interface PushTarget {
  endpoint: string
  p256dh: string
  auth: string
}

/** Sends one encrypted message; answers the push service's status, so 404 and 410 can be acted on. */
export interface PushService {
  send(target: PushTarget, payload: string): Promise<number>
}

/** A P-256 private key in PEM, as `openssl ecparam -name prime256v1 -genkey -noout` writes it. */
export async function readVapidKeyFile(path: string, subject: string): Promise<Vapid> {
  let jwk: JsonWebKey
  try {
    const key = createPrivateKey(await readFile(path, 'utf8'))
    jwk = key.export({ format: 'jwk' })
    if (jwk.crv !== 'P-256') {
      throw new Error('not P-256')
    }
  } catch {
    // The path, never the contents: this is a signing key.
    throw new Error(`invalid VAPID key file: ${path}`)
  }
  const pub = createPublicKey({ key: jwk, format: 'jwk' }).export({ format: 'jwk' })
  const point = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(pub.x ?? '', 'base64url'),
    Buffer.from(pub.y ?? '', 'base64url'),
  ])
  return { publicKey: point.toString('base64url'), privateKey: jwk.d ?? '', subject }
}

export function pushOptions(vapid: Vapid) {
  return {
    vapidDetails: vapid,
    // An approval is worth nothing after its ten minutes.
    TTL: 600,
    urgency: 'high' as const,
    contentEncoding: 'aes128gcm' as const,
    timeout: 5_000,
  }
}

export const subscription = (target: PushTarget) => ({
  endpoint: target.endpoint,
  keys: { p256dh: target.p256dh, auth: target.auth },
})

/** RFC 8291 encryption and RFC 8292 VAPID, by the web-push library. */
export function webPushService(vapid: Vapid): PushService {
  return {
    async send(target, payload) {
      try {
        const result = await webpush.sendNotification(
          subscription(target),
          payload,
          pushOptions(vapid),
        )
        return result.statusCode
      } catch (error) {
        if (error instanceof webpush.WebPushError) {
          return error.statusCode
        }
        throw error
      }
    },
  }
}
