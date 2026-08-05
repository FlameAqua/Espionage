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
  /** Last applied dot diameter, so viewport events only restyle when it actually
   *  changes (pan/zoom/render fire constantly). */
  private lastDotPx = 0
  private onViewport = (): void => {
    this.applyScale()
    this.updateRect()
  }
  private onLayout = (): void => this.sync()
  private dragging = false
  private onWinMove = (e: MouseEvent): void => {
    if (this.dragging) this.recenter(e)
  }
  private onWinUp = (): void => {
    this.dragging = false
  }

  constructor(host: HTMLElement, main: Core, theme: ThemeName) {
    this.host = host
    this.main = main
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
      style: miniStyle(theme),
      userPanningEnabled: false,
      userZoomingEnabled: false,
      boxSelectionEnabled: false,
      autoungrabify: true
    })

    this.sync()
    main.on('pan zoom resize render', this.onViewport)
    main.on('layoutstop', this.onLayout)

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

  /** Rebuild the minimap from the main graph's current visible nodes/positions. */
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
      els.push({ data: { id: e.id(), source: e.source().id(), target: e.target().id() } })
    })
    this.mini.elements().remove()
    this.mini.add(els)
    this.mini.resize()
    if (!this.mini.nodes().empty()) {
      this.mini.fit(undefined, 8)
      this.lastDotPx = 0 // force a restyle for the new element set
      this.applyScale()
    }
    this.updateRect()
  }

  /** Size the minimap's dots and links for legibility at the current view scale.
   *
   *  Two things fight each other: node/edge sizes are in model units, so fitting a
   *  large graph shrinks them to sub-pixel specks; but drawing them big enough to
   *  see turns a few hundred nodes into an unreadable blob. So the diameter is
   *  derived from how much of the graph is currently on screen — zoomed right out
   *  over a whole system the dots go small and the map stays legible, and as you
   *  zoom into a corner they grow, because far fewer of them are in play. */
  private applyScale(): void {
    if (this.mini.nodes().empty()) return
    const z = this.mini.zoom()
    const bb = this.mini.elements().boundingBox({})
    const ext = this.main.extent()
    // Every input here can be non-finite in normal use: an empty or zero-sized
    // main viewport makes extent() NaN/Infinity, and a not-yet-laid-out minimap
    // can report a zero bounding box. Unguarded, that produced "width: NaN"
    // warnings from Cytoscape on every animation frame.
    const usableZoom = Number.isFinite(z) && z > 0 ? z : 1
    const spanX = ext.x2 - ext.x1
    const spanY = ext.y2 - ext.y1
    const fracX = bb.w > 0 && Number.isFinite(spanX) ? spanX / bb.w : 1
    const fracY = bb.h > 0 && Number.isFinite(spanY) ? spanY / bb.h : 1
    // Fraction of the graph's extent the main viewport currently covers (1 = all).
    const shown = clamp(Math.max(fracX, fracY), 0, 1)
    // Denser graphs start smaller, then everything grows as you zoom in.
    const count = this.mini.nodes().length
    const base = count > 400 ? 3.5 : count > 150 ? 4.5 : 6
    const dotPx = base + (1 - shown) * 4
    if (!Number.isFinite(dotPx) || dotPx <= 0) return
    if (Math.abs(dotPx - this.lastDotPx) < 0.25) return // avoid restyling every frame
    this.lastDotPx = dotPx
    const nodeSize = dotPx / usableZoom
    const edgeWidth = Math.max(0.6, dotPx / 7) / usableZoom
    if (!Number.isFinite(nodeSize) || !Number.isFinite(edgeWidth)) return
    this.mini.batch(() => {
      this.mini.nodes().style({ width: nodeSize, height: nodeSize })
      this.mini.edges().style({ width: edgeWidth })
    })
  }

  private updateRect(): void {
    const ext = this.main.extent()
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
    this.main.pan({
      x: this.main.width() / 2 - modelX * mz,
      y: this.main.height() / 2 - modelY * mz
    })
  }

  setTheme(theme: ThemeName): void {
    this.mini.style(miniStyle(theme))
  }

  destroy(): void {
    this.main.off('pan zoom resize render', this.onViewport)
    this.main.off('layoutstop', this.onLayout)
    window.removeEventListener('mousemove', this.onWinMove)
    window.removeEventListener('mouseup', this.onWinUp)
    this.mini.destroy()
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function miniStyle(theme: ThemeName): cytoscape.StylesheetJson {
  const dark = theme === 'dark'
  const style: cytoscape.StylesheetJson = [
    { selector: 'node', style: { width: 14, height: 14, shape: 'ellipse', 'border-width': 0 } },
    {
      selector: 'edge',
      style: {
        width: 1,
        'curve-style': 'haystack',
        'line-color': dark ? '#334155' : '#cbd5e1',
        opacity: 0.6
      }
    }
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
