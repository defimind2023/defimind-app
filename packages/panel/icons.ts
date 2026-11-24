import { writeFile } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'

import { BOUNDS, logoAt, type Rgb } from './logo.js'

/**
 * The PWA icons: the DefiMind logo at about 60% on its navy, drawn here so the repository holds no
 * binary. The logo sits inside a maskable icon's safe zone.
 */
const BACKGROUND: Rgb = [0x03, 0x0b, 0x26]
const SAMPLES = 4

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return c >>> 0
})

function crc32(bytes: Buffer): number {
  let c = 0xffffffff
  for (const byte of bytes) {
    c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** One pixel, averaged over a few samples so the edges are smooth. */
function pixel(x: number, y: number, size: number): number[] {
  const scale = BOUNDS.height / (size * 0.6)
  const left = BOUNDS.x + BOUNDS.width / 2 - (size / 2) * scale
  const top = BOUNDS.y + BOUNDS.height / 2 - (size / 2) * scale
  const sum = [0, 0, 0]
  for (let i = 0; i < SAMPLES; i++) {
    for (let j = 0; j < SAMPLES; j++) {
      const colour =
        logoAt(left + (x + (i + 0.5) / SAMPLES) * scale, top + (y + (j + 0.5) / SAMPLES) * scale) ??
        BACKGROUND
      colour.forEach((c, k) => (sum[k]! += c))
    }
  }
  return sum.map((c) => Math.round(c / SAMPLES ** 2))
}

export function icon(size: number): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const rows: number[] = []
  for (let y = 0; y < size; y++) {
    rows.push(0)
    for (let x = 0; x < size; x++) {
      rows.push(...pixel(x, y, size))
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

export const writeIcon = (path: string, size: number) => writeFile(path, icon(size))
