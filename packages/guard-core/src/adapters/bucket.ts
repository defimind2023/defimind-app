import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto'
import type { Config } from '../config.js'

export interface BucketConfig {
  /** https://<endpoint>/<bucket>[/<prefix>], path-style. */
  url: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  /** 32 bytes, hex. */
  encryptionKey: string
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest()

/** Path segments encoded as SigV4 wants: RFC 3986 unreserved characters kept, the rest escaped. */
const encodePath = (path: string) =>
  path
    .split('/')
    .map((part) =>
      encodeURIComponent(part).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join('/')

/**
 * The Authorization header of an AWS Signature Version 4 request, which every S3-compatible store
 * takes. Every header passed is signed; none of them may carry a secret, since a log of the request
 * would then hold it.
 */
export function signV4(request: {
  method: string
  url: URL
  headers: Record<string, string>
  payloadHash: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  amzDate: string
}): string {
  const day = request.amzDate.slice(0, 8)
  const scope = `${day}/${request.region}/s3/aws4_request`
  const headers = Object.entries({ ...request.headers, host: request.url.host })
    .map(([name, value]) => [name.toLowerCase(), value.trim()] as const)
    .sort(([a], [b]) => (a < b ? -1 : 1))
  const signed = headers.map(([name]) => name).join(';')
  const canonical = [
    request.method,
    encodePath(decodeURIComponent(request.url.pathname)),
    request.url.searchParams.toString(),
    ...headers.map(([name, value]) => `${name}:${value}`),
    '',
    signed,
    request.payloadHash,
  ].join('\n')
  const toSign = ['AWS4-HMAC-SHA256', request.amzDate, scope, sha256(canonical)].join('\n')
  let key: Buffer = hmac(`AWS4${request.secretAccessKey}`, day)
  for (const part of [request.region, 's3', 'aws4_request']) {
    key = hmac(key, part)
  }
  const signature = createHmac('sha256', key).update(toSign).digest('hex')
  return `AWS4-HMAC-SHA256 Credential=${request.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`
}

/** AES-256-GCM: a fresh 12-byte IV, then the ciphertext, then the 16-byte tag. */
export function seal(plain: Buffer, keyHex: string): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv)
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([iv, body, cipher.getAuthTag()])
}

/**
 * Uploads `plain`, sealed, as `<prefix>/<name>.enc`. Throws on any answer but 2xx, naming the
 * status only: the URL and the keys stay out of the error, which is logged.
 */
export async function upload(
  config: BucketConfig,
  name: string,
  plain: Buffer,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<void> {
  const body = seal(plain, config.encryptionKey)
  const base = config.url.endsWith('/') ? config.url : `${config.url}/`
  const url = new URL(`${name}.enc`, base)
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
  const headers = {
    'content-type': 'application/octet-stream',
    'x-amz-content-sha256': sha256(body),
    'x-amz-date': amzDate,
  }
  const authorization = signV4({
    method: 'PUT',
    url,
    headers,
    payloadHash: headers['x-amz-content-sha256'],
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    amzDate,
  })
  const res = await fetchImpl(url, {
    method: 'PUT',
    headers: { ...headers, authorization },
    body: new Uint8Array(body),
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) {
    throw new Error(`backup upload refused with status ${res.status}`)
  }
}

/** The backup bucket, when one is set; the schema has already required its keys with it. */
export function bucketConfig(c: Config): BucketConfig | undefined {
  const { BACKUP_BUCKET_URL: url, BACKUP_ACCESS_KEY_ID: id, BACKUP_SECRET_ACCESS_KEY: secret } = c
  const key = c.BACKUP_ENCRYPTION_KEY
  return url === undefined || id === undefined || secret === undefined || key === undefined
    ? undefined
    : { url, region: c.BACKUP_REGION, accessKeyId: id, secretAccessKey: secret, encryptionKey: key }
}
