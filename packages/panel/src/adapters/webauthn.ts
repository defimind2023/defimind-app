import { z } from 'zod'

/**
 * WebAuthn in the JSON shape guard-core speaks (the WebAuthn Level 3 *JSON types): binary fields
 * as base64url both ways. The browser's own parseRequestOptionsFromJSON is not everywhere yet.
 */

export function toBase64url(bytes: ArrayBuffer): string {
  let binary = ''
  for (const byte of new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64url(text: string): ArrayBuffer {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '='))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

const b64 = z.string().regex(/^[A-Za-z0-9_-]*$/)
const descriptor = z.object({
  id: b64,
  type: z.literal('public-key'),
  transports: z.array(z.string()).optional(),
})

export const requestOptions = z.object({
  challenge: b64,
  rpId: z.string().optional(),
  timeout: z.number().optional(),
  allowCredentials: z.array(descriptor).optional(),
  userVerification: z.enum(['required', 'preferred', 'discouraged']).optional(),
})

export const creationOptions = z.object({
  challenge: b64,
  rp: z.object({ id: z.string().optional(), name: z.string() }),
  user: z.object({ id: b64, name: z.string(), displayName: z.string() }),
  pubKeyCredParams: z.array(z.object({ type: z.literal('public-key'), alg: z.number() })),
  timeout: z.number().optional(),
  excludeCredentials: z.array(descriptor).optional(),
  authenticatorSelection: z
    .object({
      residentKey: z.enum(['required', 'preferred', 'discouraged']).optional(),
      userVerification: z.enum(['required', 'preferred', 'discouraged']).optional(),
    })
    .optional(),
  attestation: z.enum(['none', 'indirect', 'direct', 'enterprise']).optional(),
})

export type RequestOptionsJSON = z.infer<typeof requestOptions>
export type CreationOptionsJSON = z.infer<typeof creationOptions>

const credentials = (list: z.infer<typeof descriptor>[] | undefined) =>
  list?.map((item) => ({
    id: fromBase64url(item.id),
    type: item.type,
    ...(item.transports ? { transports: item.transports as AuthenticatorTransport[] } : {}),
  }))

export function decodeRequest(options: RequestOptionsJSON): PublicKeyCredentialRequestOptions {
  const allow = credentials(options.allowCredentials)
  return {
    challenge: fromBase64url(options.challenge),
    ...(options.rpId ? { rpId: options.rpId } : {}),
    ...(options.timeout ? { timeout: options.timeout } : {}),
    ...(allow ? { allowCredentials: allow } : {}),
    userVerification: options.userVerification ?? 'required',
  }
}

export function decodeCreation(options: CreationOptionsJSON): PublicKeyCredentialCreationOptions {
  const exclude = credentials(options.excludeCredentials)
  return {
    challenge: fromBase64url(options.challenge),
    rp: options.rp,
    user: { ...options.user, id: fromBase64url(options.user.id) },
    pubKeyCredParams: options.pubKeyCredParams,
    ...(options.timeout ? { timeout: options.timeout } : {}),
    ...(exclude ? { excludeCredentials: exclude } : {}),
    ...(options.authenticatorSelection
      ? { authenticatorSelection: options.authenticatorSelection }
      : {}),
    attestation: options.attestation ?? 'none',
  }
}

/** What guard-core verifies: the credential with every buffer as base64url. */
export function encodeAssertion(credential: PublicKeyCredential) {
  const response = credential.response as AuthenticatorAssertionResponse
  return {
    id: credential.id,
    rawId: toBase64url(credential.rawId),
    type: 'public-key' as const,
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: toBase64url(response.clientDataJSON),
      authenticatorData: toBase64url(response.authenticatorData),
      signature: toBase64url(response.signature),
      ...(response.userHandle ? { userHandle: toBase64url(response.userHandle) } : {}),
    },
  }
}

export function encodeRegistration(credential: PublicKeyCredential) {
  const response = credential.response as AuthenticatorAttestationResponse
  return {
    id: credential.id,
    rawId: toBase64url(credential.rawId),
    type: 'public-key' as const,
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: toBase64url(response.clientDataJSON),
      attestationObject: toBase64url(response.attestationObject),
      transports: response.getTransports(),
    },
  }
}

export type Assertion = ReturnType<typeof encodeAssertion>
export type Registration = ReturnType<typeof encodeRegistration>

/** The device's passkey prompt; null when the owner cancels it. */
export interface Authenticator {
  assert(options: RequestOptionsJSON): Promise<Assertion | null>
  register(options: CreationOptionsJSON): Promise<Registration | null>
}

export const browserAuthenticator: Authenticator = {
  async assert(options) {
    const credential = await navigator.credentials.get({ publicKey: decodeRequest(options) })
    return credential instanceof PublicKeyCredential ? encodeAssertion(credential) : null
  },
  async register(options) {
    const credential = await navigator.credentials.create({ publicKey: decodeCreation(options) })
    return credential instanceof PublicKeyCredential ? encodeRegistration(credential) : null
  },
}
