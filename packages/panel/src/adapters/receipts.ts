import { z } from 'zod'
import { canonicalJson } from '../domain/canonical.js'

/** What the timeline shows of a payment: its intent's chain, token and amount. */
export const paid = z.object({
  intent: z.object({
    chain: z.string().max(64),
    token: z.string().max(128),
    amount: z.string().regex(/^(0|[1-9]\d*)$/),
  }),
})

export type Paid = z.infer<typeof paid>['intent']

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Each receipt by the hash a payment execution names it with. Hashed as received, before any
 * parsing: zod drops fields it does not know, and the hash covers all of them.
 */
export async function byHash(receipts: unknown[]): Promise<Map<string, Paid>> {
  const index = new Map<string, Paid>()
  for (const raw of receipts) {
    const view = paid.safeParse(raw)
    if (view.success) {
      index.set(await sha256Hex(canonicalJson(raw)), view.data.intent)
    }
  }
  return index
}
