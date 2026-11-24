import { describe, expect, it } from 'vitest'
import { pushEndpointAllowed } from '../src/domain/push-host.js'

describe('pushEndpointAllowed', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://web.push.apple.com/QK1',
    'https://api.push.apple.com/3/device/x',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://eu.push.services.mozilla.com/wpush/v2/abc',
    'https://wns2-par02p.notify.windows.com/w/?token=x',
    'https://fcm.googleapis.com:443/fcm/send/abc',
    'https://FCM.googleapis.com/fcm/send/abc',
  ])('allows %s', (endpoint) => {
    expect(pushEndpointAllowed(endpoint)).toBe(true)
  })

  it.each([
    'https://internal.service.local/hook',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/x',
    'https://10.0.0.5/x',
    'https://fcm.googleapis.com.evil.example/fcm',
    'https://evilfcm.googleapis.com/fcm',
    'https://notify.windows.com/x',
    'https://push.apple.com/x',
    'https://evil-push.apple.com.example/x',
    'https://fcm.googleapis.com:8443/fcm/send/abc',
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://user:pw@fcm.googleapis.com/fcm/send/abc',
    'not a url',
  ])('refuses %s', (endpoint) => {
    expect(pushEndpointAllowed(endpoint)).toBe(false)
  })
})
