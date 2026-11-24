/**
 * The DefiMind logo (public/icons/logo.svg) as plain geometry, so icons.ts can draw the PWA icons
 * at build time without a browser or an image library. Every shape is the SVG's own, in its
 * 1000-unit viewBox; keep the two in step if the logo changes.
 */
type Point = [number, number]
export type Rgb = [number, number, number]

const TOP: Rgb = [0x2f, 0x8c, 0xff]
const BOTTOM: Rgb = [0x21, 0x66, 0xe8]
const SHADE: Rgb = [0x0c, 0x3f, 0xa6]
const SWOOSH: Rgb = [0x25, 0xe4, 0xff]

/** The part of the viewBox the logo covers, to centre and scale it. */
export const BOUNDS = { x: 263, y: 192, width: 424, height: 602 }

const inEllipse = (x: number, y: number, cx: number, cy: number, rx: number, ry: number) =>
  ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1

const inRect = (x: number, y: number, x0: number, y0: number, w: number, h: number) =>
  x >= x0 && x <= x0 + w && y >= y0 && y <= y0 + h

/** A quadratic Bézier from a to b through control c, as a polyline. */
function curve(a: Point, c: Point, b: Point, steps = 48): Point[] {
  return Array.from({ length: steps }, (_, i) => {
    const t = (i + 1) / steps
    const u = 1 - t
    return [
      u * u * a[0] + 2 * u * t * c[0] + t * t * b[0],
      u * u * a[1] + 2 * u * t * c[1] + t * t * b[1],
    ]
  })
}

const LOW: Point[] = [
  [200, 748],
  [355, 748],
  ...curve([355, 748], [640, 720], [687, 430]),
  [1000, 430],
  [1000, 1000],
  [200, 1000],
]

const BAND: Point[] = [
  [350, 742],
  ...curve([350, 742], [636, 718], [687, 424]),
  [687, 478],
  ...curve([687, 478], [648, 748], [372, 764]),
]

/** Even-odd point in polygon. */
function inside(x: number, y: number, polygon: Point[]): boolean {
  let hit = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!
    const [xj, yj] = polygon[j]!
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      hit = !hit
    }
  }
  return hit
}

/** The logo's colour at a viewBox point, or undefined where it is transparent. */
export function logoAt(x: number, y: number): Rgb | undefined {
  const shape =
    (inEllipse(x, y, 475, 558, 212, 236) || inRect(x, y, 585, 192, 102, 380)) &&
    !inEllipse(x, y, 455, 542, 100, 123) &&
    !inRect(x, y, 555, 0, 30, 420) &&
    x < 687
  if (!shape) {
    return undefined
  }
  if (inside(x, y, BAND)) {
    return SWOOSH
  }
  if (inside(x, y, LOW)) {
    return SHADE
  }
  const t = y / 1000
  return TOP.map((from, i) => from + (BOTTOM[i]! - from) * t) as Rgb
}
