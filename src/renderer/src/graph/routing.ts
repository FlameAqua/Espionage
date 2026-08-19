import type { Core, EdgeCollection } from 'cytoscape'

// Deciding how a link gets from one node to another.
//
// Cytoscape draws a link as a straight line between two node borders, so on a
// busy system a link crossing the canvas runs through whatever sits between its
// ends. Nodes are painted opaque, so the link vanishes under them and reappears
// on the far side, reading as a connection that isn't there.
//
// The rule here follows the layout rather than inventing its own: the graph
// flows left to right, so a link leaves the side of its source that faces the
// destination, runs out into the gap between the two, turns once, and comes back
// in horizontally to the facing side of the target. Every link is built the same
// way, so a fan of links out of one node reads as a bundle peeling off rather
// than a spray of diagonals. The only thing chosen per link is WHERE in the gap
// it turns, which is what lets it dodge the nodes in between.
//
// Links whose ends overlap horizontally have no gap between them to turn in —
// dragging a node directly above or below the ones it connects to puts every one
// of its links in that state. Rather than give up and bow them all across each
// other, those take a lane down one side: out of the facing side of the source,
// along a clear vertical lane past both nodes, and back in horizontally to the
// same side of the target. It is the same rule read sideways, so a stack of
// links still reads as a bundle. Only when there is no vertical gap either (two
// nodes practically on top of each other) does a link fall back to a bow.

export interface Pt {
  x: number
  y: number
}
export interface Box {
  x1: number
  y1: number
  x2: number
  y2: number
}

export type Route =
  /** An elbow: out to `turn` px past the source's facing edge, then across. */
  | { kind: 'taxi'; direction: 'rightward' | 'leftward'; turn: number }
  /** A polyline through `points` (model coordinates), for links whose ends
   *  overlap horizontally and so route around one side instead. */
  | { kind: 'segments'; points: Pt[] }
  /** A single bow, `offset` px perpendicular to the straight line. */
  | { kind: 'bezier'; offset: number }
  /** Leave it alone. */
  | { kind: 'straight' }

/** Clearance kept around a node when testing whether a link runs into it. */
const MARGIN = 7
/** How close to either node the turn may sit. Also keeps cytoscape out of its
 *  own "too close" fallbacks, which ignore the turn distance entirely. */
const TURN_INSET = 16
/** Below this the gap can't hold a turn, so the link is bowed instead. */
const MIN_GAP = TURN_INSET * 2 + 10
/** Where in the gap to try turning, as fractions of the usable span. Middle
 *  first: that is the tidiest and, with dagre's rank separation, usually clear. */
const TURN_TRIES = [0.5, 0.35, 0.65, 0.22, 0.78, 0.1, 0.9]
/** How far past the outer edge of the two nodes a side lane is tried, nearest
 *  first — a lane hugging the pair is the tidiest one that works. */
const LANE_TRIES = [26, 46, 74, 112, 160, 220, 300]
/** Bow sizes tried, as multiples of what the geometry says is needed. */
const BOW_TRIES = [1, 1.5, 2.2, 3]

const overlaps1d = (a1: number, a2: number, b1: number, b2: number, m: number): boolean =>
  Math.min(a1, a2) - m <= b2 && Math.max(a1, a2) + m >= b1

/** Does the horizontal segment at `y` from `xa` to `xb` run into `b`? */
function hLineHits(y: number, xa: number, xb: number, b: Box, m: number): boolean {
  return y >= b.y1 - m && y <= b.y2 + m && overlaps1d(xa, xb, b.x1, b.x2, m)
}

/** Does the vertical segment at `x` from `ya` to `yb` run into `b`? */
function vLineHits(x: number, ya: number, yb: number, b: Box, m: number): boolean {
  return x >= b.x1 - m && x <= b.x2 + m && overlaps1d(ya, yb, b.y1, b.y2, m)
}

/** Obstacles the three legs of an elbow run through. Coordinates are given in
 *  "flowing rightwards" terms; a leftward link is mirrored before calling. */
function elbowHits(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  turnX: number,
  obstacles: Box[],
  margin: number
): number {
  let n = 0
  for (const b of obstacles) {
    if (
      hLineHits(fromY, fromX, turnX, b, margin) ||
      vLineHits(turnX, fromY, toY, b, margin) ||
      hLineHits(toY, turnX, toX, b, margin)
    )
      n++
  }
  return n
}

/** Mirror a box about x = 0, so a leftward link can reuse the rightward maths. */
const flipBox = (b: Box): Box => ({ x1: -b.x2, y1: b.y1, x2: -b.x1, y2: b.y2 })

/** Distance past the source's facing edge at which to turn, or null when the
 *  gap is too tight to turn in at all. Boxes are in rightward orientation. */
function pickTurn(src: Box, tgt: Box, obstacles: Box[], margin: number): number | null {
  const gap = tgt.x1 - src.x2
  if (gap < MIN_GAP) return null
  const fromY = (src.y1 + src.y2) / 2
  const toY = (tgt.y1 + tgt.y2) / 2
  const lo = TURN_INSET
  const hi = gap - TURN_INSET
  // A link that is already a straight horizontal run has nothing to dodge.
  let best = (lo + hi) / 2
  let bestHits = Infinity
  for (const f of TURN_TRIES) {
    const turn = lo + (hi - lo) * f
    const hits = elbowHits(src.x2, fromY, tgt.x1, toY, src.x2 + turn, obstacles, margin)
    if (hits === 0) return turn
    if (hits < bestHits) {
      bestHits = hits
      best = turn
    }
  }
  // Nothing was completely clear; the least-bad turn still beats a diagonal.
  return best
}

/** Obstacles the three legs of a side lane run through: out of the facing side
 *  of the source, down (or up) the lane, back in to the same side of the target. */
function laneHits(
  src: Box,
  tgt: Box,
  laneX: number,
  right: boolean,
  obstacles: Box[],
  margin: number
): number {
  const fromY = (src.y1 + src.y2) / 2
  const toY = (tgt.y1 + tgt.y2) / 2
  const sx = right ? src.x2 : src.x1
  const tx = right ? tgt.x2 : tgt.x1
  let n = 0
  for (const b of obstacles) {
    if (
      hLineHits(fromY, sx, laneX, b, margin) ||
      vLineHits(laneX, fromY, toY, b, margin) ||
      hLineHits(toY, laneX, tx, b, margin)
    )
      n++
  }
  return n
}

/**
 * The two bend points of a lane down one side, for a pair whose ends overlap
 * horizontally. Null when there isn't a vertical gap to run along either.
 *
 * Both sides are tried at each distance, nearest first, so the lane that lands
 * is the closest clear one. Which side is tried first only settles the ties: the
 * side the link already leans towards, since that is the shorter way round.
 */
function pickSideLane(src: Box, tgt: Box, obstacles: Box[], margin: number): Pt[] | null {
  const vGap = Math.max(tgt.y1 - src.y2, src.y1 - tgt.y2)
  if (vGap < MIN_GAP) return null
  const fromY = (src.y1 + src.y2) / 2
  const toY = (tgt.y1 + tgt.y2) / 2
  const rightEdge = Math.max(src.x2, tgt.x2)
  const leftEdge = Math.min(src.x1, tgt.x1)
  const lean = (tgt.x1 + tgt.x2) / 2 - (src.x1 + src.x2) / 2
  // Level ends go right: the graph flows left to right, so the right-hand side
  // is where a reader already expects links to run.
  const sides = lean < 0 ? [false, true] : [true, false]

  let best: Pt[] | null = null
  let bestHits = Infinity
  for (const d of LANE_TRIES) {
    for (const right of sides) {
      const laneX = right ? rightEdge + d : leftEdge - d
      const hits = laneHits(src, tgt, laneX, right, obstacles, margin)
      const pts: Pt[] = [
        { x: laneX, y: fromY },
        { x: laneX, y: toY }
      ]
      if (hits === 0) return pts
      if (hits < bestHits) {
        bestHits = hits
        best = pts
      }
    }
  }
  return best
}

/**
 * Express absolute points as the (weight, distance) pairs cytoscape's `segments`
 * curve style takes: a fraction along the line from `p1` to `p2`, and a
 * perpendicular offset from it. The normal matches `controlPoint`'s, which is
 * what cytoscape uses for both — see findSegmentsPoints. `p1` and `p2` must be
 * the node POSITIONS, which is why routed links also set edge-distances.
 */
export function segmentSpec(
  p1: Pt,
  p2: Pt,
  points: Pt[]
): { weights: number[]; distances: number[] } {
  const dx = p2.x - p1.x
  const dy = p2.y - p1.y
  const len2 = dx * dx + dy * dy
  const len = Math.sqrt(len2) || 1
  const nx = -dy / len
  const ny = dx / len
  const weights: number[] = []
  const distances: number[] = []
  for (const p of points) {
    const vx = p.x - p1.x
    const vy = p.y - p1.y
    weights.push(len2 ? (vx * dx + vy * dy) / len2 : 0)
    distances.push(vx * nx + vy * ny)
  }
  return { weights, distances }
}

/** The control point cytoscape places for `unbundled-bezier` with a single
 *  control-point-distance. Mirrors findBezierPoints: the normal is (-dy, dx)
 *  normalised, so the sign of `d` picks the side. */
export function controlPoint(p1: Pt, p2: Pt, d: number, weight = 0.5): Pt {
  const dx = p2.x - p1.x
  const dy = p2.y - p1.y
  const len = Math.hypot(dx, dy) || 1
  return {
    x: p1.x + dx * weight + (-dy / len) * d,
    y: p1.y + dy * weight + (dx / len) * d
  }
}

/** Point at `t` on the quadratic through p1, control, p2. */
export function quadPoint(p1: Pt, c: Pt, p2: Pt, t: number): Pt {
  const u = 1 - t
  return {
    x: u * u * p1.x + 2 * u * t * c.x + t * t * p2.x,
    y: u * u * p1.y + 2 * u * t * c.y + t * t * p2.y
  }
}

/** Samples along a bowed curve tested for a collision. The ends are skipped: a
 *  link always touches its own two nodes. */
const SAMPLES = 15

const inside = (p: Pt, b: Box, m: number): boolean =>
  p.x >= b.x1 - m && p.x <= b.x2 + m && p.y >= b.y1 - m && p.y <= b.y2 + m

/** Whether two boxes overlap — the cheap test that keeps the obstacle list for
 *  one link down to the handful of nodes anywhere near it. */
export function boxesOverlap(a: Box, b: Box, m = 0): boolean {
  return a.x1 - m <= b.x2 && a.x2 + m >= b.x1 && a.y1 - m <= b.y2 && a.y2 + m >= b.y1
}

/** How many of `obstacles` a curve with offset `d` still runs through. */
function bowHits(p1: Pt, p2: Pt, d: number, obstacles: Box[], margin: number): number {
  const c = controlPoint(p1, p2, d)
  let n = 0
  for (const b of obstacles) {
    for (let i = 1; i < SAMPLES; i++) {
      if (inside(quadPoint(p1, c, p2, i / SAMPLES), b, margin)) {
        n++
        break
      }
    }
  }
  return n
}

/** How far off the straight line the obstacle reaches, perpendicular to it. */
function reach(p1: Pt, p2: Pt, b: Box, margin: number): number {
  const dx = p2.x - p1.x
  const dy = p2.y - p1.y
  const len = Math.hypot(dx, dy) || 1
  const nx = -dy / len
  const ny = dx / len
  let far = 0
  for (const [x, y] of [
    [b.x1, b.y1],
    [b.x2, b.y1],
    [b.x1, b.y2],
    [b.x2, b.y2]
  ]) {
    far = Math.max(far, Math.abs((x - p1.x) * nx + (y - p1.y) * ny))
  }
  return far + margin
}

/**
 * Perpendicular control-point offset that clears `obstacles`, or 0 when the
 * straight line is already clear.
 *
 * A quadratic only reaches half its control offset at the midpoint, hence the
 * doubling: an offset of `2r` bows the curve `r` off the line.
 */
export function detourOffset(
  p1: Pt,
  p2: Pt,
  obstacles: Box[],
  opts: { margin?: number; maxOffset?: number } = {}
): number {
  const margin = opts.margin ?? MARGIN
  const maxOffset = opts.maxOffset ?? 320
  if (!obstacles.length) return 0
  let worst = bowHits(p1, p2, 0, obstacles, margin)
  if (worst === 0) return 0

  let needed = 0
  for (const b of obstacles) needed = Math.max(needed, reach(p1, p2, b, margin))
  const base = Math.min(maxOffset, Math.max(28, needed * 2))

  let best = 0
  for (const factor of BOW_TRIES) {
    const size = base * factor
    if (size > maxOffset) break
    for (const sign of [1, -1]) {
      const d = sign * size
      const hits = bowHits(p1, p2, d, obstacles, margin)
      if (hits === 0) return d
      if (hits < worst) {
        worst = hits
        best = d
      }
    }
  }
  return best
}

/**
 * How to draw one link. `obstacles` should already be narrowed to the nodes
 * anywhere near it (and must exclude its own two ends).
 */
export function routeEdge(
  src: Box,
  tgt: Box,
  obstacles: Box[],
  opts: { margin?: number } = {}
): Route {
  const margin = opts.margin ?? MARGIN
  // Which way does this link flow?
  if (tgt.x1 - src.x2 >= MIN_GAP) {
    const turn = pickTurn(src, tgt, obstacles, margin)
    if (turn != null) return { kind: 'taxi', direction: 'rightward', turn }
  } else if (src.x1 - tgt.x2 >= MIN_GAP) {
    const turn = pickTurn(flipBox(src), flipBox(tgt), obstacles.map(flipBox), margin)
    if (turn != null) return { kind: 'taxi', direction: 'leftward', turn }
  }
  // No gap between the ends to turn in. A clear line still needs nothing done to
  // it; one that runs through something takes a lane down whichever side is
  // clear, and only falls back to a bow when there is no vertical gap to run
  // along either.
  const centre = (b: Box): Pt => ({ x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2 })
  const offset = detourOffset(centre(src), centre(tgt), obstacles, { margin })
  if (!offset) return { kind: 'straight' }
  const points = pickSideLane(src, tgt, obstacles, margin)
  if (points) return { kind: 'segments', points }
  return { kind: 'bezier', offset }
}

// --- Applying a route to a live graph ---------------------------------------

/** Every style property routing sets, so switching it off puts the stylesheet
 *  back rather than leaving half a route behind. */
export const ROUTE_STYLE_PROPS =
  'curve-style control-point-distances control-point-weights taxi-direction taxi-turn taxi-radius taxi-turn-min-distance segment-distances segment-weights segment-radii edge-distances'

/** Above this much work the search costs more than the mess it tidies, so links
 *  are left as the stylesheet draws them. (edges x nodes, both visible.) */
const DEFAULT_BUDGET = 4_000_000

/**
 * Route every visible link in `cy`. Shared by the main canvas and the details
 * mini-view so the two cannot drift apart; each calls it after laying out.
 *
 * Loops have their own arc, and split routes are already fanned apart by the
 * bundling, so both are left alone.
 *
 * `only` narrows which links are re-routed (the obstacle set is always every
 * node): mid-drag, the links hanging off the node being moved are the ones that
 * have to keep up, and re-routing the whole graph every frame would not.
 */
export function applyEdgeRoutes(
  cy: Core,
  enabled: boolean,
  opts: { radius?: number; budget?: number; only?: EdgeCollection } = {}
): void {
  const pool = opts.only ?? cy.edges()
  const edges = pool.filter(
    (e) => !e.hasClass('hidden') && !e.isLoop() && !e.hasClass('route-split')
  )
  if (edges.empty()) return
  const reset = (): void => {
    cy.batch(() => {
      edges.forEach((e) => {
        e.removeStyle(ROUTE_STYLE_PROPS)
      })
    })
  }
  if (!enabled) return reset()

  const boxes: Array<Box & { id: string }> = []
  cy.nodes().forEach((n) => {
    if (n.hasClass('hidden') || n.hasClass('dept-parent')) return
    const bb = n.boundingBox({ includeLabels: false, includeOverlays: false })
    boxes.push({ id: n.id(), x1: bb.x1, y1: bb.y1, x2: bb.x2, y2: bb.y2 })
  })
  if (edges.length * boxes.length > (opts.budget ?? DEFAULT_BUDGET)) return reset()
  const byId = new Map(boxes.map((b) => [b.id, b]))
  const radius = opts.radius ?? 14

  cy.batch(() => {
    edges.forEach((e) => {
      // Parallel links share one control point, which cytoscape fans apart;
      // taking one over would stack them back on top of each other.
      const sb = byId.get(e.source().id())
      const tb = byId.get(e.target().id())
      if (!sb || !tb || e.parallelEdges().length > 1) {
        e.removeStyle(ROUTE_STYLE_PROPS)
        return
      }
      // Only nodes anywhere near the link can be in its way. The span is padded
      // so an elbow turning just outside the direct rectangle is still tested
      // against what it turns into.
      const span: Box = {
        x1: Math.min(sb.x1, tb.x1),
        y1: Math.min(sb.y1, tb.y1),
        x2: Math.max(sb.x2, tb.x2),
        y2: Math.max(sb.y2, tb.y2)
      }
      const obstacles = boxes.filter(
        (b) => b.id !== sb.id && b.id !== tb.id && boxesOverlap(b, span, 8)
      )
      const route = routeEdge(sb, tb, obstacles)
      if (route.kind === 'taxi') {
        e.removeStyle('segment-distances segment-weights segment-radii edge-distances')
        e.style({
          'curve-style': 'round-taxi',
          'taxi-direction': route.direction,
          'taxi-turn': `${Math.round(route.turn)}px`,
          'taxi-turn-min-distance': 8,
          'taxi-radius': radius
        })
      } else if (route.kind === 'segments') {
        e.removeStyle('taxi-direction taxi-turn taxi-radius taxi-turn-min-distance')
        const p1 = { x: (sb.x1 + sb.x2) / 2, y: (sb.y1 + sb.y2) / 2 }
        const p2 = { x: (tb.x1 + tb.x2) / 2, y: (tb.y1 + tb.y2) / 2 }
        const { weights, distances } = segmentSpec(p1, p2, route.points)
        e.style({
          'curve-style': 'round-segments',
          // The weights and distances above are measured from the node centres,
          // so the style has to be told to read them the same way — cytoscape
          // otherwise measures from the border intersections.
          'edge-distances': 'node-position',
          'segment-weights': weights.map((w) => w.toFixed(4)).join(' '),
          'segment-distances': distances.map((d) => d.toFixed(1)).join(' '),
          'segment-radii': String(radius)
        })
      } else if (route.kind === 'bezier') {
        e.removeStyle('segment-distances segment-weights segment-radii edge-distances')
        e.removeStyle('taxi-direction taxi-turn taxi-radius taxi-turn-min-distance')
        e.style({
          'curve-style': 'unbundled-bezier',
          'control-point-distances': `${Math.round(route.offset)}`,
          'control-point-weights': '0.5'
        })
      } else {
        e.removeStyle(ROUTE_STYLE_PROPS)
      }
    })
  })
}
