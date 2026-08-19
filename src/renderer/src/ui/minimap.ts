// Overview minimap: a small non-interactive copy of the main graph in a corner,
// with a rectangle showing the current viewport. Click to recentre the main view.

import cytoscape from 'cytoscape'
import type { Core, ElementDefinition } from 'cytoscape'
import { NODE_KIND_META, type GraphNode } from '../graph/model'
import { pressFeedbackStyle, type ThemeName } from '../graph/view'

export class Minimap {
  private mini: Core
  private main: Core
  private host: HTMLElement
  private rect: HTMLElement
  /** Last applied dot size in model units, so viewport events only restyle when
   *  it actually changes (pan/zoom/render fire constantly). Tracking the model
   *  size rather than the pixel size matters: it also captures a change in the
   *  map's own zoom, which is what left dots styled for one zoom being drawn at
   *  another — the "sometimes massive, sometimes specks" problem. */
  private lastNodeSize = 0
  private theme: ThemeName
  private routed = true
  private insetLeft = 0
  private insetRight = 0
  private onViewport = (): void => this.updateRect()
  private onLayout = (): void => this.sync()
  /** Dragging a node on the canvas moves it here too. The main graph fires one
   *  `position` per node per frame, so the copy is coalesced into a single pass
   *  on the next frame rather than run per event. */
  private onNodePosition = (): void => {
    if (this.followFrame) return
    this.followFrame = requestAnimationFrame(() => {
      this.followFrame = 0
      this.followPositions()
    })
  }
  private followFrame = 0
  private dragging = false
  private onWinMove = (e: MouseEvent): void => {
    if (this.dragging) this.recenter(e)
  }
  private onWinUp = (): void => {
    this.dragging = false
  }

  constructor(host: HTMLElement, main: Core, theme: ThemeName, routed = true) {
    this.host = host
    this.main = main
    this.theme = theme
    this.routed = routed
    host.innerHTML = ''

    const canvas = document.createElement('div')
    canvas.style.position = 'absolute'
    canvas.style.inset = '0'
    host.appendChild(canvas)

    this.rect = document.createElement('div')
    Object.assign(this.rect.style, {
      position: 'absolute',
      border: '1.5px solid #0ea5e9',
      background: 'rgba(14,165,233,0.15)',
      pointerEvents: 'none'
    } as CSSStyleDeclaration)
    host.appendChild(this.rect)

    this.mini = cytoscape({
      container: canvas,
      style: miniStyle(theme, routed),
      userPanningEnabled: false,
      userZoomingEnabled: false,
      boxSelectionEnabled: false,
      autoungrabify: true
    })

    this.sync()
    main.on('pan zoom resize render', this.onViewport)
    main.on('layoutstop', this.onLayout)
    main.on('position', 'node', this.onNodePosition)

    // Click or drag to move the main view; scroll to zoom it.
    host.addEventListener('mousedown', (e) => {
      this.dragging = true
      this.recenter(e)
    })
    window.addEventListener('mousemove', this.onWinMove)
    window.addEventListener('mouseup', this.onWinUp)
    host.addEventListener('wheel', (e) => {
      e.preventDefault()
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
      const z = Math.max(main.minZoom(), Math.min(main.maxZoom(), main.zoom() * factor))
      main.zoom({ level: z, renderedPosition: { x: main.width() / 2, y: main.height() / 2 } })
    })
  }

  /** Bounds of the node POSITIONS, ignoring how big the dots are drawn.
   *
   *  Cytoscape's own fit() measures the styled bounding box, which includes node
   *  dimensions — and since the dots are then sized from the resulting zoom, each
   *  fit changed the next one. Fitting to positions breaks that loop, so the same
   *  graph always lands on the same zoom. */
  private positionBounds(): { x1: number; y1: number; x2: number; y2: number } | null {
    const nodes = this.mini.nodes()
    if (nodes.empty()) return null
    let x1 = Infinity
    let y1 = Infinity
    let x2 = -Infinity
    let y2 = -Infinity
    nodes.forEach((n) => {
      const p = n.position()
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return
      if (p.x < x1) x1 = p.x
      if (p.y < y1) y1 = p.y
      if (p.x > x2) x2 = p.x
      if (p.y > y2) y2 = p.y
    })
    return Number.isFinite(x1) ? { x1, y1, x2, y2 } : null
  }

  /** Frame the whole graph, deterministically. */
  private fitToPositions(padding = 8): void {
    const b = this.positionBounds()
    const w = this.mini.width()
    const h = this.mini.height()
    if (!b || !(w > 0) || !(h > 0)) return
    const spanX = Math.max(1, b.x2 - b.x1)
    const spanY = Math.max(1, b.y2 - b.y1)
    const z = Math.min(Math.max(1, w - padding * 2) / spanX, Math.max(1, h - padding * 2) / spanY)
    const zoom = Number.isFinite(z) && z > 0 ? z : 1
    this.mini.zoom(zoom)
    this.mini.pan({
      x: w / 2 - ((b.x1 + b.x2) / 2) * zoom,
      y: h / 2 - ((b.y1 + b.y2) / 2) * zoom
    })
  }

  /** Copy the main graph's node positions across without rebuilding the element
   *  set, and re-frame around where they've landed. This is what keeps the map
   *  honest while a node is being dragged — sync() would do it too, but throwing
   *  away and re-adding every element each frame is far too much work for a
   *  drag. Only the map's own zoom/pan and the link directions can change. */
  private followPositions(): void {
    if (this.mini.nodes().empty()) return
    let moved = false
    this.mini.batch(() => {
      this.mini.nodes().forEach((m) => {
        const n = this.main.getElementById(m.id())
        if (n.empty()) return
        const p = n.position()
        const q = m.position()
        if (p.x === q.x && p.y === q.y) return
        m.position({ x: p.x, y: p.y })
        moved = true
      })
      if (!moved) return
      // Which way a link flows can flip when a node is dragged past its
      // neighbour, and the elbow direction is styled off that class.
      this.mini.edges().forEach((e) => {
        e.toggleClass('back', e.target().position().x < e.source().position().x)
      })
    })
    if (!moved) return
    this.fitToPositions()
    this.applyScale()
    this.updateRect()
  }

  /** Re-frame the existing elements at the container's current size. Cheap enough
   *  to run every frame while the map is resized or slid open — unlike sync(),
   *  which rebuilds the whole element set. */
  refit(): void {
    this.mini.resize()
    // Mid-slide the box is a few pixels tall; fitting into that produces a wild
    // zoom, and there's nothing to see at that size anyway.
    if (this.mini.height() < 24) return
    this.fitToPositions()
    this.applyScale()
    this.updateRect()
  }

  sync(): void {
    const els: ElementDefinition[] = []
    this.main.nodes(':visible').forEach((n) => {
      const model = n.data('model') as GraphNode | undefined
      if (!model) return // department container — the minimap only shows real nodes
      const p = n.position()
      els.push({
        data: { id: n.id(), kind: model.kind },
        position: { x: p.x, y: p.y },
        classes: model.kind
      })
    })
    this.main.edges(':visible').forEach((e) => {
      // Skip self-loops (e.g. an IVR's "repeat prompt"): the minimap draws edges
      // with curve-style haystack, which cannot render a loop and logs "invalid
      // endpoints" for each one. They'd be a dot on a dot at this scale anyway.
      if (e.source().id() === e.target().id()) return
      // Which way the link flows, so the stylesheet can point its elbow the
      // right way without a second pass over the geometry.
      const back = e.target().position().x < e.source().position().x
      els.push({
        data: { id: e.id(), source: e.source().id(), target: e.target().id() },
        classes: back ? 'back' : undefined
      })
    })
    this.mini.elements().remove()
    this.mini.add(els)
    this.mini.resize()
    this.lastNodeSize = 0 // force a restyle for the new element set
    this.fitToPositions()
    this.applyScale()
    this.updateRect()
  }

  /** Size the dots and links for legibility at the map's current zoom.
   *
   *  Node sizes are in model units, so a fitted graph would otherwise draw them
   *  at whatever the fit happened to produce — sub-pixel specks on a big system.
   *  The target is a fixed number of screen pixels, chosen once from how many
   *  nodes there are: dense graphs get smaller dots or they merge into a blob.
   *  It deliberately does NOT change as you zoom the main graph — that made the
   *  map restyle constantly and look different every time you glanced at it. */
  private applyScale(): void {
    if (this.mini.nodes().empty()) return
    const z = this.mini.zoom()
    const usableZoom = Number.isFinite(z) && z > 0 ? z : 1
    const count = this.mini.nodes().length
    const dotPx = count > 400 ? 4 : count > 150 ? 5 : 6
    const nodeSize = dotPx / usableZoom
    const edgeWidth = Math.max(0.6, dotPx / 7) / usableZoom
    if (!Number.isFinite(nodeSize) || !Number.isFinite(edgeWidth) || nodeSize <= 0) return
    // Restyling is only needed when the map's own zoom changes (a refit or a
    // resize), not on every pan of the main graph.
    if (Math.abs(nodeSize - this.lastNodeSize) < this.lastNodeSize * 0.02) return
    this.lastNodeSize = nodeSize
    this.mini.batch(() => {
      this.mini.nodes().style({ width: nodeSize, height: nodeSize })
      this.mini.edges().style({ width: edgeWidth })
    })
  }

  /** Screen-pixel insets hidden behind the side panels, so the viewport
   *  indicator outlines what is actually on show rather than the full canvas. */
  setViewportInsets(left: number, right: number): void {
    this.insetLeft = Math.max(0, left)
    this.insetRight = Math.max(0, right)
    this.updateRect()
  }

  private updateRect(): void {
    const raw = this.main.extent()
    const mz = this.main.zoom()
    const ext = {
      x1: raw.x1 + this.insetLeft / mz,
      x2: raw.x2 - this.insetRight / mz,
      y1: raw.y1,
      y2: raw.y2
    }
    const z = this.mini.zoom()
    const pan = this.mini.pan()
    const hw = this.host.clientWidth
    const hh = this.host.clientHeight
    // Clamp the viewport indicator to the minimap's own bounds.
    const x1 = Math.max(0, ext.x1 * z + pan.x)
    const y1 = Math.max(0, ext.y1 * z + pan.y)
    const x2 = Math.min(hw, ext.x2 * z + pan.x)
    const y2 = Math.min(hh, ext.y2 * z + pan.y)
    Object.assign(this.rect.style, {
      left: `${x1}px`,
      top: `${y1}px`,
      width: `${Math.max(3, x2 - x1)}px`,
      height: `${Math.max(3, y2 - y1)}px`
    } as CSSStyleDeclaration)
  }

  private recenter(e: MouseEvent): void {
    if (this.mini.elements().empty()) return
    const r = this.host.getBoundingClientRect()
    const z = this.mini.zoom()
    const pan = this.mini.pan()
    // Clamp the target to the graph's content so you can't fling the view into
    // empty space beyond the minimap.
    const bb = this.mini.elements().boundingBox({})
    const modelX = clamp((e.clientX - r.left - pan.x) / z, bb.x1, bb.x2)
    const modelY = clamp((e.clientY - r.top - pan.y) / z, bb.y1, bb.y2)
    const mz = this.main.zoom()
    // Centre on the visible strip between the panels, not the whole canvas.
    const vx = (this.insetLeft + (this.main.width() - this.insetRight)) / 2
    this.main.pan({ x: vx - modelX * mz, y: this.main.height() / 2 - modelY * mz })
  }

  setTheme(theme: ThemeName): void {
    this.theme = theme
    this.mini.style(miniStyle(theme, this.routed))
  }

  setEdgeRouting(on: boolean): void {
    if (this.routed === on) return
    this.routed = on
    this.mini.style(miniStyle(this.theme, on))
  }

  destroy(): void {
    this.main.off('pan zoom resize render', this.onViewport)
    this.main.off('layoutstop', this.onLayout)
    this.main.off('position', 'node', this.onNodePosition)
    if (this.followFrame) cancelAnimationFrame(this.followFrame)
    window.removeEventListener('mousemove', this.onWinMove)
    window.removeEventListener('mouseup', this.onWinUp)
    this.mini.destroy()
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function miniStyle(theme: ThemeName, routed: boolean): cytoscape.StylesheetJson {
  const dark = theme === 'dark'
  const lineColor = dark ? '#334155' : '#cbd5e1'
  const style: cytoscape.StylesheetJson = [
    { selector: 'node', style: { width: 14, height: 14, shape: 'ellipse', 'border-width': 0 } },
    {
      selector: 'edge',
      style: {
        width: 1,
        // The same elbow shape as the canvas, but from the stylesheet rather
        // than per link: the map's nodes are drawn as fixed-size dots, not to
        // scale, so a turn position computed here would not be the canvas's
        // anyway — and at this size the difference is well under a pixel. A
        // percentage turn also can't fall into cytoscape's "too close"
        // fallbacks the way an absolute one could between overlapping dots.
        // haystack, the fastest style, is what routing-off goes back to.
        'curve-style': routed ? 'taxi' : 'haystack',
        'taxi-direction': 'rightward',
        'taxi-turn': '50%',
        'taxi-turn-min-distance': 1,
        'line-color': lineColor,
        opacity: 0.6
      }
    },
    // Links that flow back upstream mirror the rule, exactly as on the canvas.
    { selector: 'edge.back', style: { 'taxi-direction': 'leftward' } }
  ]
  for (const [kind, meta] of Object.entries(NODE_KIND_META)) {
    style.push({ selector: `node.${kind}`, style: { 'background-color': meta.color } })
  }
  // The map is click-and-drag to recentre, so the press feedback fires on every
  // use. At this scale Cytoscape's default 30px blob covers a good part of the
  // map — smallest setting of the three views.
  style.push(...pressFeedbackStyle(0.4))
  return style
}
