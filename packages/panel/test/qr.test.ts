import jsqr from 'jsqr'
import { describe, expect, it } from 'vitest'
import { penalty, qrCode } from '../src/domain/qr.js'

// A CommonJS module whose types declare an ES default export.
const jsQR = jsqr as unknown as typeof jsqr.default

/** The modules as an RGBA image, 4 pixels each, with the 4-module quiet zone a reader needs. */
function decode(modules: boolean[][]): string | undefined {
  const scale = 4
  const side = (modules.length + 8) * scale
  const pixels = new Uint8ClampedArray(side * side * 4).fill(255)
  modules.forEach((line, y) =>
    line.forEach((dark, x) => {
      if (!dark) {
        return
      }
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const at = (((y + 4) * scale + dy) * side + (x + 4) * scale + dx) * 4
          pixels.fill(0, at, at + 3)
        }
      }
    }),
  )
  return jsQR(pixels, side, side)?.data
}

describe('qrCode', () => {
  it.each([
    ['a Solana address', 'HVpb8eryjLYqX8q89znYPEyJxWTyTe9yS8XBNF8AwQUK', 33],
    ['an EVM address', '0xF663B0388586f1505796a8ef7ed6974A8d0BE45d', 29],
    ['one byte', 'x', 21],
    ['two blocks of different sizes', 'y'.repeat(150), 49],
    ['the largest it takes', 'z'.repeat(213), 57],
  ])('%s reads back', (_, text, size) => {
    const modules = qrCode(text)
    expect(modules).toHaveLength(size)
    expect(decode(modules)).toBe(text)
  })

  it('refuses text that does not fit', () => {
    expect(() => qrCode('z'.repeat(214))).toThrow('too long')
  })

  it('scores a plain grid by its runs, blocks and dark share', () => {
    const light = Array.from({ length: 5 }, () => new Array<boolean>(5).fill(false))
    expect(penalty(light)).toBe(10 * 3 + 16 * 3 + 100)
  })
})
