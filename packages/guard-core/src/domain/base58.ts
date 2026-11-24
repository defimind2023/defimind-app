const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** Bitcoin-alphabet base58, as Solana writes a public key. */
export function base58(bytes: Uint8Array): string {
  let n = 0n
  for (const byte of bytes) {
    n = n * 256n + BigInt(byte)
  }
  let out = ''
  while (n > 0n) {
    out = ALPHABET.charAt(Number(n % 58n)) + out
    n /= 58n
  }
  // Each leading zero byte is a leading '1': the number alone would drop them.
  for (const byte of bytes) {
    if (byte !== 0) {
      break
    }
    out = `1${out}`
  }
  return out
}
