// The mini-view in the details panel: the selected node and its surroundings.
//
// It started as a read-only thumbnail, which made it decorative — you could see
// a neighbour but had to go find it on the main canvas to do anything with it.
// It now carries the same gestures as the main graph (click to navigate,
// double-click to focus, right-click for the full node menu) plus its own reach
// control, so a whole "what's around this?" investigation can happen in the
// panel without touching the canvas.

import cytoscape from 'cytoscape'
import type { Core, ElementDefinition, NodeSingular } from 'cytoscape'
import {
  EDGE_KIND_META,
  NODE_KIND_META,
  PRESENCE_META,
  departmentColor,
  departmentLabel,
  presenceOf,
  routeGroupOf,
  SHARED_DEPARTMENT,
  type GraphEdge,
  type GraphNode,
  type TopologyGraph
} from '../graph/model'
// NB importing from view.ts is also what guarantees `cytoscape.use(dagre)` has
// run — the Flow layout below depends on that registration.
import {
  DEFAULT_EDGE_OPACITY,
  blendToBackground,
  idsWithMembers,
  presenceDotUri,
  pressFeedbackStyle,
  statusClasses,
  themePalette,
  type ThemeName
} from '../graph/view'
import { applyEdgeRoutes } from '../graph/routing'
import { readEdgeRouting } from './prefs'

const DEPTH_KEY = '3cx-spy.egoDepth'
const LAYOUT_KEY = '3cx-spy.egoLayout'

/** The mini-map's arrangement. Deliberately the same three the main View Mode
 *  offers, so the small view is a scaled-down version of the big one rather than
 *  a second thing to learn. */
export type EgoLayout = 'flow' | 'compact' | 'department'

/** The link display settings the main canvas is using. The mini-map draws the
 *  same graph, so it has to honour them too — otherwise a link type switched off
 *  in Settings quietly reappears down here. */
export interface EgoMapEdgeOptions {
  opacity: number
  hiddenKinds: string[]
  hiddenRoutes: string[]
}

export interface EgoMapCallbacks {
  /** A neighbour was clicked — select it in the main graph. */
  onNavigate: (id: string) => void
  /** A node was double-clicked — focus the main graph on it. */
  onFocus: (id: string) => void
  /** A node was right-clicked; coords are viewport (client) pixels. */
  onContext: (id: string, x: number, y: number) => void
}

export class EgoMap {
  private cy: Core
  private container!: HTMLElement
  private onWheel!: (e: WheelEvent) => void
  private destroyed = false
  private toolbar!: HTMLElement
  private graph: TopologyGraph
  private centerId: string
  private depth: number
  private layout: EgoLayout
  private theme: ThemeName
  private edgeOptions: EgoMapEdgeOptions
  /** Link routing, mirroring the main canvas so the two read the same way. */
  private edgeRouting = readEdgeRouting()

  constructor(
    container: HTMLElement,
    graph: TopologyGraph,
    centerId: string,
    theme: ThemeName,
    cb: EgoMapCallbacks,
    edgeOptions?: EgoMapEdgeOptions
  ) {
    this.graph = graph
    this.centerId = centerId
    this.container = container
    this.theme = theme
    this.edgeOptions = edgeOptions ?? {
      opacity: DEFAULT_EDGE_OPACITY,
      hiddenKinds: [],
      hiddenRoutes: []
    }
    const stored = Number(localStorage.getItem(DEPTH_KEY))
    this.depth = stored === 2 ? 2 : 1
    const savedLayout = localStorage.getItem(LAYOUT_KEY)
    // Flow by default: in a neighbourhood view, which way the calls go is the
    // thing you came to find out.
    this.layout =
      savedLayout === 'compact' || savedLayout === 'department' ? savedLayout : 'flow'

    this.cy = cytoscape({
      container,
      elements: this.elements(),
      style: egoStyle(theme, this.edgeOptions.opacity),
      autoungrabify: true,
      boxSelectionEnabled: false,
      userZoomingEnabled: false,
      minZoom: 0.2,
      maxZoom: 2.5
    })

    // Same gesture vocabulary as the main canvas, so nothing has to be relearned
    // for the small view.
    let lastTapId = ''
    let lastTapAt = 0
    this.cy.on('tap', 'node', (evt) => {
      const id = (evt.target as NodeSingular).id()
      const now = Date.now()
      const isDouble = id === lastTapId && now - lastTapAt < 350
      lastTapId = id
      lastTapAt = now
      if (isDouble) cb.onFocus(id)
      else if (id !== centerId) cb.onNavigate(id)
    })
    this.cy.on('cxttap', 'node', (evt) => {
      const oe = evt.originalEvent as MouseEvent | undefined
      cb.onContext((evt.target as NodeSingular).id(), oe?.clientX ?? 0, oe?.clientY ?? 0)
    })

    // Manual wheel zoom around the cursor: stronger, Ctrl doubles the step.
    this.onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const sensitivity = (e.ctrlKey ? 0.006 : 0.003) / (e.deltaMode === 1 ? 1 / 16 : 1)
      const factor = Math.exp(-e.deltaY * sensitivity)
      const rect = container.getBoundingClientRect()
      const level = Math.max(this.cy.minZoom(), Math.min(this.cy.maxZoom(), this.cy.zoom() * factor))
      this.cy.zoom({
        level,
        renderedPosition: { x: e.clientX - rect.left, y: e.clientY - rect.top }
      })
    }
    container.addEventListener('wheel', this.onWheel, { passive: false })

    this.buildToolbar()
    requestAnimationFrame(() => this.relayout())
  }

  /** Whether a link is switched off in Settings — by type, or because every route
   *  it carries has had its route type hidden (the same rule the canvas uses). */
  private edgeHidden(e: GraphEdge): boolean {
    if (this.edgeOptions.hiddenKinds.includes(e.kind)) return true
    const routes = this.edgeOptions.hiddenRoutes
    if (!routes.length || !e.labels.length) return false
    return e.labels.every((l) => routes.includes(routeGroupOf(l)))
  }

  /** The centre node plus everything within `depth` hops of it. */
  private elements(): ElementDefinition[] {
    const nodeById = new Map(this.graph.nodes.map((n) => [n.id, n]))
    const edges = this.graph.edges.filter((e) => !this.edgeHidden(e))
    // Grow the kept set one hop at a time so depth 2 picks up the neighbours'
    // neighbours rather than only what touches the centre directly.
    const keep = new Set<string>([this.centerId])
    let frontier = new Set<string>([this.centerId])
    const hops = new Map<string, number>([[this.centerId, 0]])
    for (let hop = 1; hop <= this.depth; hop++) {
      const next = new Set<string>()
      for (const e of edges) {
        const touches = frontier.has(e.source) ? e.target : frontier.has(e.target) ? e.source : null
        if (touches === null || keep.has(touches)) continue
        next.add(touches)
      }
      for (const id of next) {
        keep.add(id)
        hops.set(id, hop)
      }
      if (!next.size) break
      frontier = next
    }

    const els: ElementDefinition[] = []
    // Department mode wraps the members in compound boxes, exactly as the main
    // canvas does — but only for buckets actually present in this neighbourhood,
    // so a box is never drawn around nothing.
    const kept: GraphNode[] = []
    for (const id of keep) {
      const n = nodeById.get(id)
      if (n) kept.push(n)
    }
    const buckets = new Set<string>()
    if (this.layout === 'department') {
      for (const n of kept) if (n.deptGroup) buckets.add(n.deptGroup)
      for (const bucket of buckets) {
        els.push({
          data: {
            id: `dept:${bucket}`,
            label: departmentLabel(bucket),
            deptColor: departmentColor(bucket)
          },
          classes: 'dept-parent'
        })
      }
    }
    const hasMembers = idsWithMembers(this.graph)
    for (const n of kept) {
      // Status flags too — an unregistered trunk or an empty queue should look
      // wrong in the mini-map exactly as it does on the canvas.
      const classes: string[] = [n.kind, ...statusClasses(n, hasMembers)]
      if (n.id === this.centerId) classes.push('center')
      // A second-hop node is context, not the subject — drawn quieter.
      if ((hops.get(n.id) ?? 0) > 1) classes.push('outer')
      if (n.kind === 'user') {
        const p = presenceOf(n.raw)
        if (p) classes.push(`presence-${p}`)
      }
      els.push({
        data: {
          id: n.id,
          label: n.number ? `${n.label}\n${n.number}` : n.label,
          parent: n.deptGroup && buckets.has(n.deptGroup) ? `dept:${n.deptGroup}` : undefined
        },
        classes: classes.join(' ')
      })
    }
    for (const e of edges) {
      if (!keep.has(e.source) || !keep.has(e.target)) continue
      els.push({
        data: { id: e.id, source: e.source, target: e.target, label: egoEdgeLabel(e) },
        classes: e.kind
      })
    }
    return els
  }

  /** Follow a live change to the link settings (Settings applies immediately, and
   *  the mini-map is already on screen when it does). */
  setEdgeRouting(on: boolean): void {
    if (this.destroyed || this.edgeRouting === on) return
    this.edgeRouting = on
    applyEdgeRoutes(this.cy, on, { radius: 7 })
  }

  setEdgeOptions(o: EgoMapEdgeOptions): void {
    if (this.destroyed) return
    this.edgeOptions = o
    this.cy.style(egoStyle(this.theme, o.opacity))
    // Hidden types change which elements exist at all, not just their styling.
    this.rebuild()
  }

  /** Reach + fit controls, floated over the top-right of the map. Kept faint
   *  until the map is hovered so the thumbnail stays uncluttered at rest. */
  private buildToolbar(): void {
    const bar = document.createElement('div')
    bar.className =
      'absolute top-1 right-1 z-20 flex items-center gap-0.5 opacity-30 hover:opacity-100 focus-within:opacity-100 transition-opacity'
    // One skin for every control in the bar. The arrangement picker is a
    // <select>, which the browser draws taller than a button unless its native
    // appearance is dropped and its padding matched exactly.
    const control =
      'h-5 px-1.5 rounded text-[10px] leading-none bg-white/90 dark:bg-slate-700/90 border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-200 shadow-sm'
    const mk = (label: string, title: string, fn: () => void): HTMLButtonElement => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = `${control} hover:bg-slate-100 dark:hover:bg-slate-600`
      b.textContent = label
      b.title = title
      // The map sits inside a scrollable panel; stop clicks reaching Cytoscape.
      b.addEventListener('mousedown', (e) => e.stopPropagation())
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        fn()
      })
      return b
    }
    const depthBtn = mk('', '', () => {
      this.depth = this.depth === 1 ? 2 : 1
      localStorage.setItem(DEPTH_KEY, String(this.depth))
      syncDepth()
      this.rebuild()
    })
    const syncDepth = (): void => {
      depthBtn.textContent = this.depth === 1 ? '1 hop' : '2 hops'
      depthBtn.title =
        this.depth === 1
          ? 'Showing direct neighbours - click for two hops'
          : 'Showing two hops out - click for direct neighbours only'
    }
    syncDepth()

    // The same modes as the main View Mode, in the same order. A select rather
    // than a cycling button: three states is one too many to cycle blind in a
    // corner. Department is offered only when the graph has any.
    const hasDepartments = this.graph.nodes.some(
      (n) => n.deptGroup && n.deptGroup !== SHARED_DEPARTMENT
    )
    const modes: Array<[EgoLayout, string]> = [
      ['flow', 'Flow'],
      ...((hasDepartments ? [['department', 'Dept']] : []) as Array<[EgoLayout, string]>),
      ['compact', 'Compact']
    ]
    // A remembered Department layout is meaningless on a system without any.
    if (!hasDepartments && this.layout === 'department') this.layout = 'flow'
    const sel = document.createElement('select')
    sel.className = `${control} appearance-none cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-600`
    sel.title = 'How the mini-map is arranged'
    sel.innerHTML = modes
      .map(
        ([value, label]) =>
          `<option value="${value}"${value === this.layout ? ' selected' : ''}>${label}</option>`
      )
      .join('')
    sel.addEventListener('mousedown', (e) => e.stopPropagation())
    sel.addEventListener('change', () => {
      this.layout = sel.value as EgoLayout
      localStorage.setItem(LAYOUT_KEY, this.layout)
      // Department mode reparents nodes into compound boxes, so the elements
      // themselves change — a plain relayout isn't enough.
      this.rebuild()
    })

    bar.append(sel, depthBtn, mk('⤢', 'Fit', () => this.fit()))
    this.container.appendChild(bar)
    this.toolbar = bar
  }

  /** Swap the elements for the current depth, keeping the same core. */
  private rebuild(): void {
    if (this.destroyed) return
    this.cy.batch(() => {
      this.cy.elements().remove()
      this.cy.add(this.elements())
    })
    this.relayout()
  }

  /** Layout options for the current mode, mirroring the main canvas at small
   *  scale. */
  private layoutOptions(w: number, h: number): cytoscape.LayoutOptions {
    const base = { animate: false as const, fit: false, padding: 8 }
    switch (this.layout) {
      case 'compact':
        // Same idea as the main Compact: pack them in, no wasted middle. Grid is
        // the one layout here that SHOULD see the container box — with condense +
        // avoidOverlap the cells stay node-sized regardless, and the box's aspect
        // ratio is what makes the grid come out panel-shaped.
        return {
          name: 'grid',
          boundingBox: { x1: 0, y1: 0, w, h },
          condense: true,
          avoidOverlap: true,
          avoidOverlapPadding: 4,
          // The subject first, so it's top-left rather than lost in the grid.
          sort: (a: NodeSingular, b: NodeSingular) =>
            (a.hasClass('center') ? 0 : 1) - (b.hasClass('center') ? 0 : 1),
          ...base
        } as cytoscape.LayoutOptions
      case 'department':
        // cytoscape-dagre is compound-aware, so it arranges each department box's
        // members internally AND the boxes along the flow.
        return {
          name: 'dagre',
          rankDir: 'LR',
          nodeSep: 14,
          rankSep: 80,
          edgeSep: 6,
          ranker: 'tight-tree',
          ...base
        } as unknown as cytoscape.LayoutOptions
      case 'flow':
      default:
        // Left-to-right call flow: what routes IN sits left of the subject, what
        // it routes to sits right. At this size that reads far better than a
        // ring, and it's why the mini-map is worth traversing a big system with.
        // Spacing is the main canvas's, scaled to this node size — NOT squeezed
        // to the panel; see the boundingBox note in relayout().
        return {
          name: 'dagre',
          rankDir: 'LR',
          nodeSep: 10,
          rankSep: 92,
          edgeSep: 4,
          ranker: 'tight-tree',
          ...base
        } as unknown as cytoscape.LayoutOptions
    }
  }

  private relayout(): void {
    // A rapid re-navigation can destroy this mini-map before the deferred layout
    // runs; bail rather than lay out a torn-down / detached graph.
    if (this.destroyed) return
    this.cy.resize()
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    // IMPORTANT: dagre must NOT be given a boundingBox. cytoscape-dagre doesn't
    // treat it as a hint — it rescales the finished layout into that box, so
    // handing it the panel's ~176px height crushed a 20-node fan-out into a solid
    // overlapping block with no node separation at all. Let dagre lay out at its
    // natural spacing and let fit() below do the shrinking, which is what the
    // main canvas does. Grid still takes the box (see layoutOptions).
    //
    // Only lay out with a real size and something to arrange; guard against any
    // residual edge case so a throw can't leave the map blank.
    if (this.cy.nodes().length > 1 && w > 0 && h > 0) {
      try {
        this.cy.elements().layout(this.layoutOptions(w, h)).run()
      } catch {
        // Fall through to fit — the nodes still render, just un-arranged.
      }
    }
    // Same rule as the main canvas, on the same code. A smaller corner radius:
    // the elbows here are a third of the size.
    applyEdgeRoutes(this.cy, this.edgeRouting, { radius: 7 })
    this.fit()
  }

  fit(): void {
    try {
      this.cy.fit(undefined, 10)
    } catch {
      /* ignore fit on a degenerate/empty graph */
    }
  }

  destroy(): void {
    this.destroyed = true
    this.container.removeEventListener('wheel', this.onWheel)
    this.toolbar?.remove()
    this.cy.destroy()
  }
}

/** Short edge caption — the single relationship, or an "N routes" count. Long
 *  labels are truncated: at this size the full text would cover the nodes, and
 *  the main canvas / link details carry the complete version. */
function egoEdgeLabel(e: GraphEdge): string {
  if (e.labels.length > 1) return `${e.labels.length} routes`
  const one = e.labels[0] ?? ''
  return one.length > 18 ? `${one.slice(0, 17)}…` : one
}

/** The mini-map's stylesheet. Everything colour-related comes from the same
 *  `themePalette` the main canvas uses — this file used to keep its own copy,
 *  which is how it ended up with translucent node bodies (links showed straight
 *  through them) and a dark mode that didn't match. */
function egoStyle(theme: ThemeName, edgeOpacity: number): cytoscape.StylesheetJson {
  const dark = theme === 'dark'
  const p = themePalette(theme)
  const style: cytoscape.StylesheetJson = [
    {
      selector: 'node',
      style: {
        label: 'data(label)',
        'text-wrap': 'wrap',
        'text-valign': 'center',
        'text-halign': 'center',
        color: p.labelColor,
        'font-size': 8,
        'font-weight': 600,
        'text-max-width': '90px',
        width: 86,
        height: 30,
        shape: 'round-rectangle',
        'border-width': 1.5,
        'border-color': p.borderColor,
        'border-opacity': p.nodeBorderOpacity
      }
    },
    {
      selector: 'edge',
      style: {
        width: 1,
        'curve-style': 'bezier',
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.7,
        // Honours the Link opacity setting, like the canvas.
        opacity: edgeOpacity,
        'line-color': dark ? '#475569' : '#94a3b8',
        'target-arrow-color': dark ? '#475569' : '#94a3b8',
        label: 'data(label)',
        'font-size': 6,
        color: p.edgeLabelColor,
        'text-background-color': p.edgeLabelBg,
        'text-background-opacity': 0.85,
        'text-background-padding': '1px'
      }
    },
    // Loops (an IVR repeating its prompt) need an explicit arc, else Cytoscape
    // can't place the endpoints and logs an "impossible to draw" warning.
    {
      selector: 'edge:loop',
      style: {
        'curve-style': 'bezier',
        'loop-direction': '-45deg',
        'loop-sweep': '30deg',
        'control-point-step-size': 24
      }
    },
    // Department boxes, scaled down from the main canvas.
    {
      selector: 'node.dept-parent',
      style: {
        shape: 'round-rectangle',
        'background-color': 'data(deptColor)',
        'background-opacity': dark ? 0.1 : 0.06,
        'border-width': 1,
        'border-style': 'dashed',
        'border-color': 'data(deptColor)',
        'border-opacity': 0.9,
        label: 'data(label)',
        'text-valign': 'top',
        'text-halign': 'center',
        'text-margin-y': -3,
        'font-size': 8,
        'font-weight': 700,
        color: 'data(deptColor)',
        padding: '6px',
        'compound-sizing-wrt-labels': 'exclude',
        // The box is scenery here — there's no department panel to open from
        // the mini-map, so it shouldn't swallow clicks meant for the canvas.
        events: 'no'
      }
    }
  ]
  for (const [kind, meta] of Object.entries(NODE_KIND_META)) {
    style.push({
      selector: `node.${kind}`,
      style: {
        // Pre-blended and fully OPAQUE, same as the canvas: a translucent body
        // let every link behind it show through, which at this size turned a
        // fan-out into a mess of arrows crossing the nodes.
        'background-color': blendToBackground(meta.color, p.fillBase, p.fillAlpha),
        'background-opacity': 1,
        'border-color': meta.color
      }
    })
  }
  // Link colours match the main canvas, so a route and a queue membership don't
  // look like the same relationship down here.
  for (const [kind, meta] of Object.entries(EDGE_KIND_META)) {
    style.push({
      selector: `edge.${kind}`,
      style: { 'line-color': meta.color, 'target-arrow-color': meta.color }
    })
  }
  // Status flags, after the kind colours so they win the border — same language
  // as the canvas: washed-out for disabled, red for a line that's down, amber for
  // a queue nobody is in.
  style.push(
    {
      selector: 'node.status-disabled',
      style: {
        'background-color': blendToBackground('#94a3b8', p.fillBase, dark ? 0.3 : 0.1),
        'background-opacity': 1,
        'border-style': 'dashed',
        'border-opacity': 0.5
      }
    },
    {
      selector: 'node.status-unregistered',
      style: { 'border-color': '#ef4444', 'border-style': 'dashed', 'border-opacity': 0.95 }
    },
    {
      selector: 'node.status-empty',
      style: { 'border-color': '#f59e0b', 'border-style': 'dashed', 'border-opacity': 0.95 }
    },
    // Out-of-hours routing is dashed here too, so it isn't mistaken for the
    // business-hours path.
    { selector: 'edge.afterhours', style: { 'line-style': 'dashed' } }
  )
  for (const [presence, meta] of Object.entries(PRESENCE_META)) {
    style.push({
      selector: `node.presence-${presence}`,
      style: {
        'background-image': presenceDotUri(meta.color, dark ? '#0f172a' : '#ffffff'),
        'background-width': '9px',
        'background-height': '9px',
        'background-position-x': '98%',
        'background-position-y': '6%',
        'background-clip': 'none',
        'background-image-opacity': 1
      }
    })
  }
  // Emphasis LAST so it wins the border back off the category colour above.
  style.push(
    {
      selector: 'node.center',
      style: {
        'border-width': 3,
        'border-color': '#0ea5e9',
        'border-style': 'solid',
        'border-opacity': 1
      }
    },
    // Second-hop context: present, but clearly behind the first ring.
    { selector: 'node.outer', style: { opacity: 0.65, width: 74, height: 26, 'font-size': 7 } }
  )
  // Scaled right down — the default 10px halo is a third of a node's height here.
  style.push(...pressFeedbackStyle(0.6))
  return style
}
