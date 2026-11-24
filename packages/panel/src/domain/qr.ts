/**
 * A QR code for a short text such as a vault address, made in the page: the CSP loads no script from
 * anywhere else, and an address should not pass through a third party to become an image.
 * Byte mode, error correction level M, versions 1 to 10 (up to 213 bytes).
 */

/** Per version, level M: error correction codewords per block, then the blocks' data codewords. */
const BLOCKS: [number, number[]][] = [
  [10, [16]],
  [16, [28]],
  [26, [44]],
  [18, [32, 32]],
  [24, [43, 43]],
  [16, [27, 27, 27, 27]],
  [18, [31, 31, 31, 31]],
  [22, [38, 38, 39, 39]],
  [22, [36, 36, 36, 37, 37]],
  [26, [43, 43, 43, 43, 44]],
]

const ALIGN = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
]

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x
  LOG[x] = i
  x = (x << 1) ^ (x & 0x80 ? 0x11d : 0)
}
for (let i = 255; i < 512; i++) {
  EXP[i] = EXP[i - 255]!
}

const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!)

/** Reed-Solomon remainder of data over the generator of the given degree. */
function correction(data: number[], degree: number): number[] {
  let gen = [1]
  for (let i = 0; i < degree; i++) {
    gen = [...gen, 0].map((c, j) => c ^ mul(gen[j - 1] ?? 0, EXP[i]!))
  }
  const rem = new Array<number>(degree).fill(0)
  for (const byte of data) {
    const factor = byte ^ rem.shift()!
    rem.push(0)
    for (let j = 0; j < degree; j++) {
      rem[j] = rem[j]! ^ mul(gen[j + 1]!, factor)
    }
  }
  return rem
}

/** Mode, length, data, terminator and padding, split into blocks and interleaved with their codes. */
function codewords(bytes: Uint8Array, version: number): number[] {
  const [ec, sizes] = BLOCKS[version - 1]!
  const capacity = sizes.reduce((a, b) => a + b, 0)
  const bits: number[] = []
  const put = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) {
      bits.push((value >>> i) & 1)
    }
  }
  put(0b0100, 4)
  put(bytes.length, version < 10 ? 8 : 16)
  bytes.forEach((byte) => put(byte, 8))
  put(0, Math.min(4, capacity * 8 - bits.length))
  put(0, (8 - (bits.length % 8)) % 8)
  const data: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0))
  }
  for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) {
    data.push(pad)
  }
  let at = 0
  const blocks = sizes.map((size) => data.slice(at, (at += size)))
  const codes = blocks.map((block) => correction(block, ec))
  const out: number[] = []
  for (let i = 0; i < Math.max(...sizes); i++) {
    blocks.forEach((block) => i < block.length && out.push(block[i]!))
  }
  for (let i = 0; i < ec; i++) {
    codes.forEach((code) => out.push(code[i]!))
  }
  return out
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
]

function bch(data: number, poly: number, degree: number): number {
  let rem = data << degree
  for (let i = 31 - Math.clz32(rem); i >= degree; i--) {
    if ((rem >>> i) & 1) {
      rem ^= poly << (i - degree)
    }
  }
  return (data << degree) | rem
}

class Grid {
  readonly dark: boolean[][]
  readonly fixed: boolean[][]

  constructor(readonly size: number) {
    this.dark = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
    this.fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  }

  set(x: number, y: number, dark: boolean) {
    this.dark[y]![x] = dark
    this.fixed[y]![x] = true
  }

  /** Format bits for level M (00) and the mask, in both copies, with the dark module. */
  format(mask: number) {
    const bits = bch(mask, 0x537, 10) ^ 0x5412
    const bit = (i: number) => ((bits >>> i) & 1) === 1
    const n = this.size
    for (let i = 0; i < 6; i++) {
      this.set(8, i, bit(i))
    }
    this.set(8, 7, bit(6))
    this.set(8, 8, bit(7))
    this.set(7, 8, bit(8))
    for (let i = 9; i < 15; i++) {
      this.set(14 - i, 8, bit(i))
    }
    for (let i = 0; i < 8; i++) {
      this.set(n - 1 - i, 8, bit(i))
    }
    for (let i = 8; i < 15; i++) {
      this.set(8, n - 15 + i, bit(i))
    }
    this.set(8, n - 8, true)
  }
}

function patterns(grid: Grid, version: number) {
  const n = grid.size
  for (let i = 0; i < n; i++) {
    grid.set(6, i, i % 2 === 0)
    grid.set(i, 6, i % 2 === 0)
  }
  for (const [cx, cy] of [
    [3, 3],
    [n - 4, 3],
    [3, n - 4],
  ] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy))
        const x = cx + dx
        const y = cy + dy
        if (x >= 0 && x < n && y >= 0 && y < n) {
          grid.set(x, y, d !== 2 && d !== 4)
        }
      }
    }
  }
  const align = ALIGN[version - 1]!
  const last = align.length - 1
  align.forEach((cx, i) =>
    align.forEach((cy, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) {
        return
      }
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          grid.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
        }
      }
    }),
  )
  grid.format(0)
  if (version >= 7) {
    const bits = bch(version, 0x1f25, 12)
    for (let i = 0; i < 18; i++) {
      const on = ((bits >>> i) & 1) === 1
      grid.set(n - 11 + (i % 3), Math.floor(i / 3), on)
      grid.set(Math.floor(i / 3), n - 11 + (i % 3), on)
    }
  }
}

/** The data bits in the two-column zigzag from the bottom right, around the fixed patterns. */
function place(grid: Grid, data: number[]) {
  const n = grid.size
  let i = 0
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) {
      right = 5
    }
    const upward = ((right + 1) & 2) === 0
    for (let step = 0; step < n; step++) {
      const y = upward ? n - 1 - step : step
      for (const x of [right, right - 1]) {
        if (!grid.fixed[y]![x] && i < data.length * 8) {
          grid.dark[y]![x] = ((data[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1
          i++
        }
      }
    }
  }
}

function flip(grid: Grid, mask: number) {
  const test = MASKS[mask]!
  grid.dark.forEach((line, y) =>
    line.forEach((on, x) => {
      if (!grid.fixed[y]![x] && test(x, y)) {
        line[x] = !on
      }
    }),
  )
}

/** The standard penalty: runs, 2x2 blocks, finder-like patterns, and the dark share. */
export function penalty(dark: boolean[][]): number {
  const n = dark.length
  const lines = [...dark, ...dark.map((_, x) => dark.map((line) => line[x]!))]
  let score = 0
  for (const line of lines) {
    let run = 1
    for (let i = 1; i <= n; i++) {
      if (i < n && line[i] === line[i - 1]) {
        run++
        continue
      }
      score += run >= 5 ? run - 2 : 0
      run = 1
    }
    const text = line.map((on) => (on ? '1' : '0')).join('')
    score += 40 * (text.match(/(?=(10111010000|00001011101))/g)?.length ?? 0)
  }
  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const c = dark[y]![x]
      if (c === dark[y]![x + 1] && c === dark[y + 1]![x] && c === dark[y + 1]![x + 1]) {
        score += 3
      }
    }
  }
  const count = dark.flat().filter(Boolean).length
  return score + 10 * Math.floor(Math.abs((count * 100) / (n * n) - 50) / 5)
}

/** The modules of the smallest QR code that holds text, row by row; true is dark. */
export function qrCode(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text)
  const version = BLOCKS.findIndex(([, sizes], i) => {
    const capacity = sizes.reduce((a, b) => a + b, 0)
    return 4 + (i < 9 ? 8 : 16) + bytes.length * 8 <= capacity * 8
  })
  if (version < 0) {
    throw new Error('too long for a QR code here')
  }
  const grid = new Grid(17 + 4 * (version + 1))
  patterns(grid, version + 1)
  place(grid, codewords(bytes, version + 1))
  let best = { mask: 0, score: Infinity }
  for (let mask = 0; mask < 8; mask++) {
    flip(grid, mask)
    grid.format(mask)
    const score = penalty(grid.dark)
    if (score < best.score) {
      best = { mask, score }
    }
    flip(grid, mask)
  }
  flip(grid, best.mask)
  grid.format(best.mask)
  return grid.dark
}
