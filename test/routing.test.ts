import { describe, expect, it } from 'vitest'
import {
  boxesOverlap,
  controlPoint,
  detourOffset,
  quadPoint,
  routeEdge,
  type Box,
  type Pt
} from '../src/renderer/src/graph/routing'

const box = (cx: number, cy: number, w = 60, h = 30): Box => ({
  x1: cx - w / 2,
  y1: cy - h / 2,
  x2: cx + w / 2,
  y2: cy + h / 2
})
const centre = (b: Box): Pt => ({ x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2 })

/** Does the curve produced by `offset` pass through `box`? Mirrors what the
 *  renderer will draw, so a passing test means the drawn link clears it. */
function bowCrosses(p1: Pt, p2: Pt, offset: number, b: Box, margin = 0): boolean {
  const c = controlPoint(p1, p2, offset)
  for (let i = 1; i < 40; i++) {
    const p = quadPoint(p1, c, p2, i / 40)
    if (p.x >= b.x1 - margin && p.x <= b.x2 + margin && p.y >= b.y1 - margin && p.y <= b.y2 + margin)
      return true
  }
  return false
}

/** Walk the three legs cytoscape will draw for a taxi route and report whether
 *  any of them runs into `b`. Turn distance is measured from the facing edge of
 *  the source, matching findTaxiPoints. */
function elbowCrosses(
  src: Box,
  tgt: Box,
  direction: 'rightward' | 'leftward',
  turn: number,
  b: Box
): boolean {
  const sy = centre(src).y
  const ty = centre(tgt).y
  const sx = direction === 'rightward' ? src.x2 : src.x1
  const tx = direction === 'rightward' ? tgt.x1 : tgt.x2
  const turnX = direction === 'rightward' ? sx + turn : sx - turn
  const hits = (y: number, xa: number, xb: number): boolean =>
    y >= b.y1 && y <= b.y2 && Math.min(xa, xb) <= b.x2 && Math.max(xa, xb) >= b.x1
  const vHits = (x: number, ya: number, yb: number): boolean =>
    x >= b.x1 && x <= b.x2 && Math.min(ya, yb) <= b.y2 && Math.max(ya, yb) >= b.y1
  return hits(sy, sx, turnX) || vHits(turnX, sy, ty) || hits(ty, turnX, tx)
}

describe('routeEdge', () => {
  it('elbows rightward when the target is downstream', () => {
    const src = box(0, 0)
    const tgt = box(400, 200)
    const r = routeEdge(src, tgt, [])
    expect(r.kind).toBe('taxi')
    if (r.kind !== 'taxi') return
    expect(r.direction).toBe('rightward')
    // The turn sits inside the gap, clear of both nodes.
    expect(r.turn).toBeGreaterThan(0)
    expect(r.turn).toBeLessThan(tgt.x1 - src.x2)
  })

  it('elbows leftward for a link that flows back', () => {
    const r = routeEdge(box(400, 0), box(0, 150), [])
    expect(r.kind).toBe('taxi')
    if (r.kind !== 'taxi') return
    expect(r.direction).toBe('leftward')
    expect(r.turn).toBeLessThan(400 - 60)
  })

  it('moves the turn so the elbow misses a node in the gap', () => {
    const src = box(0, 0)
    const tgt = box(500, 300)
    // Straight down the middle of the gap, where the turn would go by default.
    const blocker = box(250, 150, 80, 200)
    const r = routeEdge(src, tgt, [blocker])
    expect(r.kind).toBe('taxi')
    if (r.kind !== 'taxi') return
    expect(elbowCrosses(src, tgt, r.direction, r.turn, blocker)).toBe(false)
  })

  it('keeps a clear route clear', () => {
    const src = box(0, 0)
    const tgt = box(500, 300)
    const bystander = box(250, -400)
    const r = routeEdge(src, tgt, [bystander])
    expect(r.kind).toBe('taxi')
    if (r.kind !== 'taxi') return
    expect(elbowCrosses(src, tgt, r.direction, r.turn, bystander)).toBe(false)
  })

  it('keeps looking when the nearer lanes are blocked too', () => {
    const src = box(0, 0)
    const tgt = box(600, 400)
    // Two columns standing in the gap, covering where the turn would first be
    // tried. Neither reaches the horizontal legs, so only the vertical run has
    // to dodge them.
    const blockers: Box[] = [
      { x1: 275, y1: 20, x2: 325, y2: 380 },
      { x1: 195, y1: 20, x2: 255, y2: 380 }
    ]
    const r = routeEdge(src, tgt, blockers)
    expect(r.kind).toBe('taxi')
    if (r.kind !== 'taxi') return
    for (const b of blockers) expect(elbowCrosses(src, tgt, r.direction, r.turn, b)).toBe(false)
  })

  it('bows instead when the two ends overlap horizontally', () => {
    // Stacked vertically: there is no gap to turn in.
    const src = box(0, 0)
    const tgt = box(10, 300)
    const blocker = box(5, 150)
    const r = routeEdge(src, tgt, [blocker])
    expect(r.kind).toBe('bezier')
    if (r.kind !== 'bezier') return
    expect(bowCrosses(centre(src), centre(tgt), r.offset, blocker)).toBe(false)
  })

  it('leaves a short, clear, overlapping link alone', () => {
    expect(routeEdge(box(0, 0), box(10, 300), []).kind).toBe('straight')
  })

  it('bows when the gap is too tight for a turn', () => {
    // Borders 20px apart: less than the two insets an elbow needs.
    const r = routeEdge(box(0, 0), box(80, 200), [box(40, 100)])
    expect(r.kind).not.toBe('taxi')
  })
})

describe('detourOffset', () => {
  const a: Pt = { x: 0, y: 0 }
  const b: Pt = { x: 600, y: 0 }

  it('leaves a clear line alone', () => {
    expect(detourOffset(a, b, [box(300, 400)])).toBe(0)
    expect(detourOffset(a, b, [])).toBe(0)
  })

  it('bends around a node sitting on the line', () => {
    const obstacle = box(300, 0)
    const d = detourOffset(a, b, [obstacle])
    expect(d).not.toBe(0)
    expect(bowCrosses(a, b, d, obstacle)).toBe(false)
  })

  it('clears the node with margin to spare', () => {
    const obstacle = box(300, 0, 80, 40)
    const d = detourOffset(a, b, [obstacle], { margin: 10 })
    expect(bowCrosses(a, b, d, obstacle, 6)).toBe(false)
  })

  it('picks the side needing the smaller bow', () => {
    const obstacle: Box = { x1: 260, y1: -6, x2: 340, y2: 120 }
    const d = detourOffset(a, b, [obstacle])
    expect(bowCrosses(a, b, d, obstacle)).toBe(false)
    expect(controlPoint(a, b, d).y).toBeLessThan(0)
  })

  it('clears several nodes strung along the line', () => {
    const obstacles = [box(180, 0), box(300, 0), box(420, 0)]
    const d = detourOffset(a, b, obstacles)
    for (const o of obstacles) expect(bowCrosses(a, b, d, o)).toBe(false)
  })

  it('works on a diagonal, not just a horizontal', () => {
    const p2: Pt = { x: 400, y: 400 }
    const obstacle = box(200, 200)
    const d = detourOffset(a, p2, [obstacle])
    expect(bowCrosses(a, p2, d, obstacle)).toBe(false)
  })

  it('never bows further than the cap', () => {
    const wall: Box = { x1: 200, y1: -5000, x2: 400, y2: 5000 }
    const d = detourOffset(a, b, [wall], { maxOffset: 200 })
    expect(Math.abs(d)).toBeLessThanOrEqual(200)
  })

  it('ignores an obstacle that only brushes past the ends', () => {
    expect(detourOffset(a, b, [box(-200, 0)])).toBe(0)
  })
})

describe('controlPoint', () => {
  it('offsets perpendicular to the line, matching cytoscape', () => {
    // The normal is (-dy, dx) normalised, so on a left-to-right line a positive
    // offset goes to +y (downwards on screen).
    const c = controlPoint({ x: 0, y: 0 }, { x: 100, y: 0 }, 40)
    expect(c.x).toBeCloseTo(50)
    expect(c.y).toBeCloseTo(40)
    const c2 = controlPoint({ x: 0, y: 0 }, { x: 0, y: 100 }, 40)
    expect(c2.x).toBeCloseTo(-40)
    expect(c2.y).toBeCloseTo(50)
  })

  it('is a no-op at zero offset', () => {
    expect(controlPoint({ x: 0, y: 0 }, { x: 100, y: 50 }, 0)).toEqual({ x: 50, y: 25 })
  })
})

describe('boxesOverlap', () => {
  it('detects overlap and separation', () => {
    expect(boxesOverlap(box(0, 0), box(10, 10))).toBe(true)
    expect(boxesOverlap(box(0, 0), box(500, 0))).toBe(false)
    expect(boxesOverlap({ x1: 0, y1: 0, x2: 10, y2: 10 }, { x1: 10, y1: 0, x2: 20, y2: 10 })).toBe(
      true
    )
  })
})
