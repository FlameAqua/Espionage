// Cytoscape rendering of a TopologyGraph: selectable nodes, category and focus
// filtering, switchable layouts, theming, zoom control and space-to-pan.

import cytoscape from 'cytoscape'
import type { Core, EdgeSingular, ElementDefinition, NodeSingular } from 'cytoscape'
import dagre from 'cytoscape-dagre'
import {
  EDGE_KIND_META,
  NODE_KIND_META,
  PRESENCE_META,
  departmentColor,
  departmentLabel,
  presenceOf,
  routeGroupOf,
  type GraphNode,
  type NodeKind,
  type TopologyGraph
} from './model'
import { rankSearchHits, type SearchHit } from './search'
import { applyEdgeRoutes } from './routing'

cytoscape.use(dagre)

export type ThemeName = 'light' | 'dark'
export type LayoutName = 'flow' | 'compact' | 'department'

/** Default link opacity — links read as background structure so the nodes stay
 *  the foreground. Adjustable in Settings (see setEdgeMuting). */
export const DEFAULT_EDGE_OPACITY = 0.5

// Cytoscape's traversal methods live on the node/edge collection types rather
// than on the general Collection, so the reach walks below have to say which
// they are holding at each step.
type NodeColl = cytoscape.NodeCollection
type EdgeColl = cytoscape.EdgeCollection

/** Reference size the edge-label widths are measured at, then scaled from. */
const LABEL_MEASURE_PX = 100

export interface EdgeTapInfo {
  sourceId: string
  targetId: string
  kind: string
  /** Every individual relationship collapsed into this edge (e.g. "key 1"). */
  labels: string[]
  /** Set when one of the split-out per-route edges was tapped, so the details
   *  panel can call out which single route it was. */
  tappedLabel?: string
  /** The id that hides just the tapped route, set alongside `tappedLabel`. */
  tappedRouteId?: string
}

/** Everything the edge context menu needs: the link itself, plus the distinct
 *  route types it carries so each can be hidden on its own. */
export interface EdgeContextInfo extends EdgeTapInfo {
  edgeId: string
  /** Normalised route groups on this link (see routeGroupOf), most specific
   *  first — the tapped route, when a split-out one was clicked. */
  routeGroups: string[]
}

export type { SearchHit }

/** One node's position change from a drag, for the undo/redo timeline. */
export interface NodeMove {
  id: string
  from: { x: number; y: number }
  to: { x: number; y: number }
}

interface ViewCallbacks {
  /** A node was tapped on the canvas (user-initiated selection). */
  onNodeTap: (node: GraphNode) => void
  /** The empty background was tapped. */
  onBackgroundTap: () => void
  /** Current zoom changed (drives the zoom slider). */
  onZoomChange: (zoom: number) => void
  /** A node was right-clicked; coords are viewport (client) pixels. */
  onNodeContext: (node: GraphNode, x: number, y: number) => void
  /** A node was double-clicked. */
  onNodeDoubleTap: (node: GraphNode) => void
  /** A link/edge was tapped. */
  onEdgeTap: (info: EdgeTapInfo) => void
  /** A link was right-clicked; coords are viewport (client) pixels. */
  onEdgeContext: (info: EdgeContextInfo, x: number, y: number) => void
  /** A department box (its own empty space, not a node inside it) was tapped. */
  onDepartmentTap: (bucket: string) => void
  /** A department box was right-clicked; coords are viewport (client) pixels. */
  onDepartmentContext: (bucket: string, x: number, y: number) => void
  /** One or more nodes finished being dragged to a new position. */
  onNodesMoved: (moves: NodeMove[]) => void
  /** What's on screen changed — a filter, a focus, a department, a hide. Lets the
   *  legend report the counts actually visible rather than the whole system's. */
  onVisibilityChange?: () => void
  /** The empty background was right-clicked (not a box-select drag); coords are
   *  viewport (client) pixels. */
  onBackgroundContext: (x: number, y: number) => void
}

export class GraphView {
  private cy: Core
  private cb: ViewCallbacks
  private container: HTMLElement
  private resizeObserver: ResizeObserver
  private onWheel!: (e: WheelEvent) => void
  private didInitialFit = false

  /** Set while a re-route is already queued for the end of this frame. */
  private reroutePending = false

  private layoutName: LayoutName = 'flow'
  private visibleKinds: Set<NodeKind>
  private focusId: string | null = null
  // How many hops out from the focus node stay visible. Infinity = the whole
  // connected cluster the focus node belongs to.
  private focusDepth = 1
  private hideUnconnected = false
  private deptFilter: string | null = null
  /** Node whose whole call corridor is the current view (see focusTrace). */
  private traceId: string | null = null
  private deptParentsActive = false
  private boxEl!: HTMLElement
  /** Overlay the edge labels are painted onto (see setupEdgeLabels). */
  private labelEl!: HTMLCanvasElement
  /** measureText is the expensive part of the label pass and the same handful of
   *  labels recur every frame, so a per-pixel-of-font-size width is kept per
   *  typeface + text (see drawEdgeLabels). */
  private labelWidths = new Map<string, number>()
  /** Nodes the user explicitly hid via the context menu. Wins over every filter. */
  private manuallyHidden = new Set<string>()
  /** Individual links hidden via the edge context menu. */
  private hiddenEdgeIds = new Set<string>()
  /** Whole link types hidden (context menu "Hide all" / Settings). */
  private hiddenEdgeKinds = new Set<string>()
  /** Individual route types hidden (context menu "Hide all … routes"), e.g. just
   *  the out-of-hours destinations rather than every `route` link. */
  private hiddenRouteGroups = new Set<string>()
  /** The collapsed edge currently exploded into its individual routes, if any. */
  private splitEdgeId: string | null = null
  private theme: ThemeName
  private edgeOpacity = DEFAULT_EDGE_OPACITY

  constructor(
    container: HTMLElement,
    graph: TopologyGraph,
    visibleKinds: Set<NodeKind>,
    theme: ThemeName,
    cb: ViewCallbacks
  ) {
    this.cb = cb
    this.container = container
    this.visibleKinds = visibleKinds
    this.theme = theme

    this.cy = cytoscape({
      container,
      elements: toElements(graph),
      style: buildStyle(theme),
      minZoom: 0.04,
      maxZoom: 3,
      // Wheel zoom is handled manually (see below) for a stronger, tunable step.
      userZoomingEnabled: false,
      // Drag a node to move it, drag the background to pan, scroll to zoom.
      // The padlock / Space-pan toggle node grabbability at runtime.
      // Selection powers right-drag box-select + grouped node move.
      boxSelectionEnabled: true,
      selectionType: 'single'
    })

    // Manual wheel zoom around the cursor: ~3x the previous feel, and holding
    // Ctrl doubles the step.
    this.onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const sensitivity = (e.ctrlKey ? 0.006 : 0.003) / (e.deltaMode === 1 ? 1 / 16 : 1)
      const factor = Math.exp(-e.deltaY * sensitivity)
      const rect = container.getBoundingClientRect()
      const level = Math.max(
        this.cy.minZoom(),
        Math.min(this.cy.maxZoom(), this.cy.zoom() * factor)
      )
      this.cy.zoom({
        level,
        renderedPosition: { x: e.clientX - rect.left, y: e.clientY - rect.top }
      })
    }
    container.addEventListener('wheel', this.onWheel, { passive: false })

    this.resizeObserver = new ResizeObserver(() => {
      this.cy.resize()
      if (!this.didInitialFit && container.clientHeight > 0 && this.cy.nodes().length) {
        this.didInitialFit = true
        this.runLayout(false)
      }
    })
    this.resizeObserver.observe(container)

    let lastTapId = ''
    let lastTapAt = 0
    this.cy.on('tap', 'node', (evt) => {
      const target = evt.target as NodeSingular
      // A compound department box has no model; tapping its own space selects the
      // whole department rather than doing nothing.
      if (target.hasClass('dept-parent')) {
        this.collapseEdge()
        this.cb.onDepartmentTap(String(target.data('bucket') ?? ''))
        return
      }
      const node = target.data('model') as GraphNode | undefined
      if (!node) return
      this.collapseEdge() // leaving a link restores its compact "N routes" form
      this.cy.nodes().unselect() // a plain tap clears any right-drag group selection
      const now = Date.now()
      const isDouble = node.id === lastTapId && now - lastTapAt < 350
      lastTapId = node.id
      lastTapAt = now
      this.cb.onNodeTap(node)
      if (isDouble) this.cb.onNodeDoubleTap(node)
    })
    this.cy.on('tap', (evt) => {
      if (evt.target === this.cy) {
        this.collapseEdge()
        this.cy.elements().removeClass('faded selected dim lit')
        this.cy.nodes().unselect()
        this.cb.onBackgroundTap()
      }
    })
    this.cy.on('cxttap', 'node', (evt) => {
      const target = evt.target as NodeSingular
      const oe = evt.originalEvent as MouseEvent
      if (target.hasClass('dept-parent')) {
        this.cb.onDepartmentContext(
          String(target.data('bucket') ?? ''),
          oe?.clientX ?? 0,
          oe?.clientY ?? 0
        )
        return
      }
      const node = target.data('model') as GraphNode | undefined
      if (!node) return
      this.cb.onNodeContext(node, oe?.clientX ?? 0, oe?.clientY ?? 0)
    })
    this.cy.on('tap', 'edge', (evt) => {
      const e = evt.target
      // Tapping a per-route copy shouldn't re-split (it's already one route) — it
      // just reports that single route's detail.
      const isSplit = e.hasClass('route-split')
      const originalId = isSplit ? String(e.id()).split('::route:')[0] : String(e.id())
      const original = this.cy.getElementById(originalId)
      const allLabels = (original.empty() ? e : original).data('labels') as string[] | undefined
      if (!isSplit) this.expandEdge(e.id())
      this.cb.onEdgeTap({
        sourceId: String(e.data('source')),
        targetId: String(e.data('target')),
        kind: String(e.data('kind')),
        labels: allLabels ?? [],
        tappedLabel: isSplit ? String(e.data('label')) : undefined
      })
    })
    this.cy.on('cxttap', 'edge', (evt) => {
      const e = evt.target
      const oe = evt.originalEvent as MouseEvent | undefined
      // Right-clicking a per-route copy targets the link it came from, so "Hide"
      // hides the whole link rather than one temporary stand-in — but the route
      // that was actually clicked still leads the per-route hide options.
      const isSplit = e.hasClass('route-split')
      const baseId = this.baseEdgeId(e)
      const base = this.cy.getElementById(baseId)
      const tappedLabel = isSplit ? String(e.data('label')) : undefined
      // A per-route copy's own id is what hides that one route, so it survives
      // the collapse back to the bundled link.
      const tappedRouteId = isSplit ? String(e.id()) : undefined
      const labels = ((base.empty() ? e : base).data('labels') as string[]) ?? []
      const groups: string[] = []
      for (const l of tappedLabel ? [tappedLabel, ...labels] : labels) {
        const g = routeGroupOf(l)
        if (g && !groups.includes(g)) groups.push(g)
      }
      this.cb.onEdgeContext(
        {
          edgeId: baseId,
          sourceId: String(e.data('source')),
          targetId: String(e.data('target')),
          // A per-route copy carries its own type, so "hide all X links" from
          // inside an expanded bundle acts on the route that was clicked rather
          // than on whichever type the bundle happens to be coloured by.
          kind: String(e.data('kind')),
          labels,
          tappedLabel,
          tappedRouteId,
          routeGroups: groups
        },
        oe?.clientX ?? 0,
        oe?.clientY ?? 0
      )
    })
    this.cy.on('zoom', () => this.cb.onZoomChange(this.cy.zoom()))

    // Node-move tracking for undo/redo: snapshot positions when a grab starts
    // (the grabbed node plus any co-selected nodes that move together), then diff
    // on release and report the ones that actually moved.
    let grabStart = new Map<string, { x: number; y: number }>()
    // Links hanging off whatever is being dragged, so they can be re-routed
    // as it moves rather than snapping into shape only on release.
    let dragEdges: cytoscape.EdgeCollection | null = null
    let dragFrame = 0
    this.cy.on('grab', 'node', (evt) => {
      grabStart = new Map()
      const grabbed = evt.target as NodeSingular
      const moving = grabbed.selected() ? this.cy.nodes(':selected') : grabbed
      moving.forEach((n) => {
        if (n.data('model')) {
          const p = n.position()
          grabStart.set(n.id(), { x: p.x, y: p.y })
        }
      })
      dragEdges = moving.connectedEdges()
    })
    // A dragged node's links are re-routed as it moves, so what's on screen is
    // already what will be there on release — an elbow that will become a side
    // lane changes as you cross, rather than after the fact. Only the moving
    // node's own links are recomputed each frame; everything else is a link
    // whose obstacle set has barely changed, and is caught by the full pass on
    // release. Coalesced to one recompute per frame.
    this.cy.on('drag', 'node', () => {
      if (!this.edgeRouting || !dragEdges || dragEdges.empty() || dragFrame) return
      dragFrame = requestAnimationFrame(() => {
        dragFrame = 0
        if (dragEdges && !dragEdges.empty()) this.routeEdges(dragEdges)
      })
    })
    this.cy.on('free', 'node', () => {
      dragEdges = null
      if (dragFrame) {
        cancelAnimationFrame(dragFrame)
        dragFrame = 0
      }
      if (!grabStart.size) return
      const moves: NodeMove[] = []
      grabStart.forEach((from, id) => {
        const n = this.cy.getElementById(id)
        if (n.empty()) return
        const to = n.position()
        if (Math.abs(to.x - from.x) > 0.5 || Math.abs(to.y - from.y) > 0.5)
          moves.push({ id, from, to: { x: to.x, y: to.y } })
      })
      grabStart = new Map()
      if (moves.length) {
        this.cb.onNodesMoved(moves)
        this.routeEdges() // a moved node is a new obstacle for everything else
      }
    })

    this.setupBoxSelect(container)
    this.setupEdgeLabels(container)

    this.applyVisibility()
    requestAnimationFrame(() => {
      if (container.clientHeight > 0) {
        this.didInitialFit = true
        this.runLayout(false)
      }
    })
  }

  /** Hold the right mouse button and drag on empty space to rubber-band a group
   *  of nodes; grabbing any one of them then moves the whole group together
   *  (Cytoscape's built-in grouped-drag on selected nodes). */
  /** Edge labels are painted here rather than by cytoscape.
   *
   *  Cytoscape draws a label in the same pass as the link that owns it (see
   *  drawCachedElement in its canvas renderer), so any link drawn afterwards
   *  paints straight over it - which is what buries a label wherever links
   *  converge on a lane. There is no stylesheet fix: every link carries a label,
   *  so no z-order satisfies them all. One pass over a canvas above cytoscape's
   *  own, run after each render, puts every label above every link.
   *
   *  The stylesheet stays the source of truth for font, colour, plate and
   *  padding - they are read back per edge - and `text-opacity: 0` on the edge
   *  selector is what stops cytoscape drawing the labels a second time
   *  underneath. Label geometry is cytoscape's too: it is computed whatever the
   *  text opacity, so the labels land exactly where they always did. */
  private setupEdgeLabels(container: HTMLElement): void {
    const canvas = document.createElement('canvas')
    Object.assign(canvas.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      // Never take a click: the link underneath must stay selectable.
      pointerEvents: 'none',
      // Above cytoscape's canvases, below the box-select rectangle.
      zIndex: '4'
    } as CSSStyleDeclaration)
    container.appendChild(canvas)
    this.labelEl = canvas
    this.cy.on('render', this.drawEdgeLabels)
  }

  /** Bound so it can be removed on destroy, and so `this` survives the event. */
  private drawEdgeLabels = (): void => {
    const canvas = this.labelEl
    const ctx = canvas?.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    if (w <= 0 || h <= 0) return
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const zoom = this.cy.zoom()
    const pan = this.cy.pan()
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    this.cy.edges().forEach((e) => {
      if (!e.visible()) return
      const text = String(e.data('label') ?? '')
      if (!text) return

      // Cytoscape's own label placement, in model coordinates.
      const rs = (e as unknown as { _private?: { rscratch?: Record<string, unknown> } })._private
        ?.rscratch
      const mx = rs?.labelX
      const my = rs?.labelY
      if (typeof mx !== 'number' || typeof my !== 'number') return

      const x = mx * zoom + pan.x
      const y = my * zoom + pan.y
      // Generous margins: the plate and a rotated label both overhang the point.
      if (x < -200 || y < -80 || x > w + 200 || y > h + 80) return

      const size = e.numericStyle('font-size') * zoom
      // Below this the text is a smudge, and skipping it keeps a zoomed-out
      // graph of several hundred links cheap to pan.
      if (!(size >= 4)) return

      const alpha = e.effectiveOpacity()
      if (alpha <= 0) return

      // An empty part would make the shorthand invalid, and an invalid assignment
      // to ctx.font is ignored - leaving the previous edge's font in place.
      const weight = e.style('font-weight') || 'normal'
      const family = e.style('font-family') || 'sans-serif'
      // Measured once per face at a reference size and scaled from there. Text
      // width is linear in font size, and the size here carries the zoom - so
      // caching against it would mint a fresh entry for every zoom level a
      // scroll passes through, and never reuse one.
      const key = `${weight} ${family} ${text}`
      let unitW = this.labelWidths.get(key)
      if (unitW === undefined) {
        ctx.font = `${weight} ${LABEL_MEASURE_PX}px ${family}`
        unitW = ctx.measureText(text).width / LABEL_MEASURE_PX
        this.labelWidths.set(key, unitW)
      }
      ctx.font = `${weight} ${size}px ${family}`
      const textW = unitW * size
      const textH = size * 1.2

      const angle = typeof rs?.labelAngle === 'number' ? (rs.labelAngle as number) : 0
      ctx.save()
      ctx.translate(x, y)
      if (angle) ctx.rotate(angle)

      const bgAlpha = e.numericStyle('text-background-opacity')
      if (bgAlpha > 0) {
        const pad = (e.numericStyle('text-background-padding') || 0) * zoom
        ctx.globalAlpha = alpha * bgAlpha
        ctx.fillStyle = e.style('text-background-color')
        const bw = textW + pad * 2
        const bh = textH + pad * 2
        const r = Math.min(3 * zoom, bw / 2, bh / 2)
        ctx.beginPath()
        ctx.roundRect(-bw / 2, -bh / 2, bw, bh, r)
        ctx.fill()
      }

      ctx.globalAlpha = alpha
      ctx.fillStyle = e.style('color')
      ctx.fillText(text, 0, 0)
      ctx.restore()
    })
  }

  private setupBoxSelect(container: HTMLElement): void {
    const box = document.createElement('div')
    Object.assign(box.style, {
      position: 'absolute',
      display: 'none',
      border: '1px dashed #0ea5e9',
      background: 'rgba(14,165,233,0.12)',
      pointerEvents: 'none',
      zIndex: '5'
    } as CSSStyleDeclaration)
    container.appendChild(box)
    this.boxEl = box

    let startR: { x: number; y: number } | null = null
    let startM: { x: number; y: number } | null = null

    this.cy.on('cxttapstart', (evt) => {
      if (evt.target !== this.cy) return // only when starting on empty background
      startR = { x: evt.renderedPosition.x, y: evt.renderedPosition.y }
      startM = { x: evt.position.x, y: evt.position.y }
      Object.assign(box.style, {
        display: 'block',
        left: `${startR.x}px`,
        top: `${startR.y}px`,
        width: '0px',
        height: '0px'
      })
    })
    this.cy.on('cxtdrag', (evt) => {
      if (!startR) return
      const rp = evt.renderedPosition
      Object.assign(box.style, {
        left: `${Math.min(startR.x, rp.x)}px`,
        top: `${Math.min(startR.y, rp.y)}px`,
        width: `${Math.abs(rp.x - startR.x)}px`,
        height: `${Math.abs(rp.y - startR.y)}px`
      })
    })
    this.cy.on('cxttapend', (evt) => {
      if (!startR || !startM) return
      const s = startR
      const sm = startM
      startR = null
      startM = null
      box.style.display = 'none'
      const rp = evt.renderedPosition
      if (Math.hypot(rp.x - s.x, rp.y - s.y) < 8) {
        // A right-click on empty space, not a box-select drag: surface the
        // background context menu (undo/redo).
        const oe = evt.originalEvent as MouseEvent | undefined
        this.cb.onBackgroundContext(oe?.clientX ?? 0, oe?.clientY ?? 0)
        return
      }
      const em = evt.position
      const x1 = Math.min(sm.x, em.x)
      const x2 = Math.max(sm.x, em.x)
      const y1 = Math.min(sm.y, em.y)
      const y2 = Math.max(sm.y, em.y)
      this.cy.elements().removeClass('faded selected dim lit')
      this.cy.nodes().unselect()
      this.cy
        .nodes()
        .filter((n) => {
          if (!n.data('model') || n.hasClass('hidden')) return false
          const p = n.position()
          return p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2
        })
        .select()
    })
  }

  // --- Layout -------------------------------------------------------------

  setLayout(name: LayoutName): void {
    this.layoutName = name
    if (name === 'department') this.enterDepartmentMode()
    else this.exitDepartmentMode()
    // Reparenting into/out of department boxes resets element visibility, so
    // recompute it (kind filters, focus, dept filter, hide-unconnected) before
    // laying out — otherwise "Hide unconnected" silently reverts on a view switch.
    this.applyVisibility()
    this.runLayout()
  }

  /** Wrap nodes in coloured compound "department" boxes, one per bucket
   *  present in the graph (see GraphNode.deptGroup). */
  private enterDepartmentMode(): void {
    if (this.deptParentsActive) return
    const buckets = new Map<string, string>() // bucket -> colour
    this.cy.nodes().forEach((n) => {
      const model = n.data('model') as GraphNode | undefined
      if (model?.deptGroup) buckets.set(model.deptGroup, departmentColor(model.deptGroup))
    })
    // Nothing to box. The flag stays down so a later attempt still tries: it was
    // being raised before the work, so bailing here left the mode marked active
    // with no boxes, and every later switch into it did nothing.
    if (!buckets.size) return
    this.deptParentsActive = true
    const parents: ElementDefinition[] = []
    buckets.forEach((color, bucket) => {
      parents.push({
        // `bucket` is read back by the tap / context handlers.
        data: { id: `dept:${bucket}`, bucket, label: departmentLabel(bucket), deptColor: color },
        classes: 'dept-parent'
      })
    })
    this.cy.add(parents)
    this.cy.nodes().forEach((n) => {
      const model = n.data('model') as GraphNode | undefined
      if (model?.deptGroup) n.move({ parent: `dept:${model.deptGroup}` })
    })
  }

  /** Un-parent every node and remove the department boxes (children must be
   *  moved out first — removing a parent removes its descendants too). */
  private exitDepartmentMode(): void {
    if (!this.deptParentsActive) return
    this.deptParentsActive = false
    this.cy.nodes().forEach((n) => {
      if (n.data('model')) n.move({ parent: null })
    })
    this.cy.nodes('.dept-parent').remove()
  }

  getLayout(): LayoutName {
    return this.layoutName
  }

  /** Lay out the visible elements instantly, then glide the camera into frame.
   *  Animating the camera (not node positions) avoids the flicker / "shoot out"
   *  / blank-render glitches that node-tweening produced on large subsets. */
  runLayout(animate = true): void {
    this.cy.resize()
    const eles = this.cy.elements(':visible')
    if (eles.empty()) return
    eles.layout(this.layoutOptions()).run()
    this.routeEdges()
    this.frameView(animate)
  }

  /**
   * Lay the department view out, rebuilding its boxes first — which is what
   * switching to Flow and back does by hand, and the only thing that reliably
   * stops the departments piling onto one another.
   *
   * A department box has no size of its own: cytoscape derives it from where its
   * members sit, and cytoscape-dagre measures every node it is handed and passes
   * that on as the cluster's size. So a box that has been measured around one
   * view goes on describing that view. Filter down to a single department and
   * the rest report a collapsed box; come back to all of them and they report
   * whatever span their members were last scattered over. Either way dagre is
   * told the wrong amount of room to keep for each cluster, and with a dozen
   * departments that puts most of them on top of each other.
   *
   * A box that has only just been created has been measured for nothing, so
   * dagre sizes each cluster from the members it actually holds. Hence the
   * rebuild — cheap next to the layout it precedes, and only on the actions that
   * change which departments are on screen.
   */
  private relayoutDepartments(animate: boolean): void {
    this.exitDepartmentMode()
    this.enterDepartmentMode()
    // The boxes above are new elements, carrying neither the hidden flags the
    // filter needs nor the "no visible member" state applyVisibility maintains.
    this.applyVisibility()
    this.runLayout(animate)
  }

  /** Lay out for the current mode, rebuilding the department boxes when there
   *  are any. Used by the actions that change which departments are on screen. */
  private relayoutForVisibility(animate: boolean): void {
    if (this.layoutName === 'department' && this.deptParentsActive)
      this.relayoutDepartments(animate)
    else this.runLayout(animate)
  }

  // --- Link routing -------------------------------------------------------

  private edgeRouting = true

  /** Route links along the flow instead of straight through whatever is in the
   *  way. See graph/routing.ts for the rule. */
  setEdgeRouting(on: boolean): void {
    if (this.edgeRouting === on) return
    this.edgeRouting = on
    this.routeEdges()
  }

  getEdgeRouting(): boolean {
    return this.edgeRouting
  }

  /** Recompute every visible link's route. Called after a layout and after a
   *  drag, which are the only two things that move a node.
   *
   *  Routing is how links are drawn, not whether the graph works, and it runs
   *  in the middle of runLayout — before the camera is framed, and inside the
   *  dimmed window of a view-mode switch. So a failure here is contained: the
   *  links fall back to however the stylesheet draws them and the layout carries
   *  on, rather than taking the framing and the un-dimming down with it. */
  /** Re-route once at the end of the frame.
   *
   *  A link is only routed while it is drawn (applyEdgeRoutes skips hidden ones),
   *  and a hidden node stops being an obstacle - so any change to what is on
   *  screen leaves the routes stale. Restoring a hidden link was the visible
   *  case: it came back as the stylesheet's plain curve, because nothing had
   *  routed it since it went away. Coalesced because a single user action can
   *  run applyVisibility several times over. */
  private scheduleReroute(): void {
    if (this.reroutePending) return
    this.reroutePending = true
    requestAnimationFrame(() => {
      this.reroutePending = false
      if (this.cy.destroyed()) return
      this.routeEdges()
    })
  }

  private routeEdges(edges?: cytoscape.EdgeCollection): void {
    try {
      applyEdgeRoutes(this.cy, this.edgeRouting, edges ? { only: edges } : {})
    } catch (err) {
      console.error('Link routing failed; leaving links as the stylesheet draws them.', err)
    }
  }

  private layoutOptions(): cytoscape.LayoutOptions {
    const base = { animate: false as const, fit: false, padding: 45 }
    switch (this.layoutName) {
      case 'compact': {
        // A dense grid, blocked by category. This used to be a concentric ring,
        // which spent most of its area on empty space in the middle and put a
        // single node at the centre of a huge circle — the opposite of compact.
        // A grid packs the most nodes into the least space, which is the only
        // thing this mode is for: an inventory read of a big system, or a
        // focused node's neighbourhood seen all at once.
        const id = this.focusId
        const order = Object.keys(NODE_KIND_META)
        const rank = (n: NodeSingular): number => {
          // The focused node leads, so it's findable at a glance (top-left).
          if (id && n.id() === id) return -1
          const model = n.data('model') as GraphNode | undefined
          return model ? order.indexOf(model.kind) : order.length
        }
        return {
          name: 'grid',
          condense: true,
          avoidOverlap: true,
          avoidOverlapPadding: 8,
          // Like with like, so the grid reads as blocks of extensions, queues,
          // rules … rather than an arbitrary scatter.
          sort: (a: NodeSingular, b: NodeSingular) => {
            const d = rank(a) - rank(b)
            if (d !== 0) return d
            const an = (a.data('model') as GraphNode | undefined) ?? null
            const bn = (b.data('model') as GraphNode | undefined) ?? null
            return (an?.number ?? an?.label ?? '').localeCompare(
              bn?.number ?? bn?.label ?? '',
              undefined,
              { numeric: true }
            )
          },
          ...base
        } as cytoscape.LayoutOptions
      }
      case 'department':
        // Same dagre (LR flow) engine as Flow, but compound-aware: each box's
        // members are laid out internally in call-flow order and the boxes
        // themselves arranged along the flow, with shared / department-less nodes
        // between them. Only nodeSep is loosened over Flow, and only enough to
        // clear the boxes' outside top labels — matching Flow's rank spacing
        // keeps the two views the same size, rather than Department reading as a
        // sparser copy of the same graph.
        return {
          name: 'dagre',
          // @ts-ignore dagre options
          rankDir: 'LR',
          nodeSep: 22,
          rankSep: 160,
          edgeSep: 6,
          ranker: 'tight-tree',
          ...base
        }
      case 'flow':
      default:
        return {
          name: 'dagre',
          // @ts-ignore dagre options — tighter node spacing + wider ranks makes
          // big systems less of a tall ribbon and more spread horizontally.
          rankDir: 'LR',
          nodeSep: 12,
          rankSep: 160,
          edgeSep: 6,
          ranker: 'tight-tree',
          ...base
        }
    }
  }

  // --- Viewport insets ----------------------------------------------------
  // The canvas spans the whole window and the side panels float over it, so the
  // part of it the user can actually see is inset by their widths. Every camera
  // move frames into THAT rectangle rather than the raw canvas, otherwise fit
  // and centre would park content underneath a panel.

  private insetLeft = 0
  private insetRight = 0

  setViewportInsets(left: number, right: number): void {
    this.insetLeft = Math.max(0, left)
    this.insetRight = Math.max(0, right)
  }

  /** The visible rectangle in rendered (screen) pixels. */
  private viewBox(): { x: number; y: number; w: number; h: number } {
    return {
      x: this.insetLeft,
      y: 0,
      // Floors, so a container that is momentarily unsized (mid-mount, or
      // hidden) can't turn into a negative or absurd zoom.
      w: Math.max(80, this.cy.width() - this.insetLeft - this.insetRight),
      h: Math.max(80, this.cy.height())
    }
  }

  /** Pan that puts the centre of `bb` in the centre of the visible rectangle. */
  private centreOn(eles: cytoscape.Collection, zoom: number): { x: number; y: number } {
    const bb = eles.boundingBox({})
    const v = this.viewBox()
    return {
      x: v.x + v.w / 2 - zoom * (bb.x1 + bb.w / 2),
      y: v.y + v.h / 2 - zoom * (bb.y1 + bb.h / 2)
    }
  }

  /** Zoom + pan that frames `eles` inside the visible rectangle. */
  private fitTarget(
    eles: cytoscape.Collection,
    padding: number
  ): { zoom: number; pan: { x: number; y: number } } {
    const zoom = this.fitZoom(eles, padding)
    return { zoom, pan: this.centreOn(eles, zoom) }
  }

  /** Move the camera to frame the visible graph. When focused, always end
   *  centred on the focus node at a zoom that fits its neighbourhood. */
  private frameView(animate: boolean): void {
    const eles = this.cy.elements(':visible')
    if (eles.empty()) return
    const target = this.focusId
      ? (() => {
          const zoom = this.fitZoomAroundFocus(eles, 55)
          return { zoom, pan: this.centreOn(this.cy.getElementById(this.focusId!), zoom) }
        })()
      : this.fitTarget(eles, 45)
    if (!animate) {
      this.cy.zoom(target.zoom)
      this.cy.pan(target.pan)
      return
    }
    this.cy.stop()
    this.cy.animate(
      { zoom: target.zoom, pan: target.pan },
      { duration: 400, easing: 'ease-in-out' }
    )
  }

  /** Zoom that fits the visible elements while the FOCUS node stays dead centre.
   *  Plain fit-zoom assumes the bounding box is centred, so on a lopsided
   *  neighbourhood (the usual case — a node with everything hanging off one side)
   *  half the revealed nodes ended up off screen. Sizing on the furthest reach
   *  from the focus node in each direction keeps it centred AND everything in
   *  frame. */
  private fitZoomAroundFocus(eles: cytoscape.Collection, padding: number): number {
    if (!this.focusId) return this.fitZoom(eles, padding)
    const node = this.cy.getElementById(this.focusId)
    if (node.empty()) return this.fitZoom(eles, padding)
    const bb = eles.boundingBox({})
    const p = node.position()
    const halfW = Math.max(p.x - bb.x1, bb.x2 - p.x)
    const halfH = Math.max(p.y - bb.y1, bb.y2 - p.y)
    if (halfW <= 0 || halfH <= 0) return this.fitZoom(eles, padding)
    const v = this.viewBox()
    const z = Math.min((v.w / 2 - padding) / halfW, (v.h / 2 - padding) / halfH)
    return Math.max(this.cy.minZoom(), Math.min(this.cy.maxZoom(), z))
  }

  /** Zoom level that fits the given elements within the viewport. */
  private fitZoom(eles: cytoscape.Collection, padding: number): number {
    const bb = eles.boundingBox({})
    const v = this.viewBox()
    if (bb.w === 0 || bb.h === 0) return this.cy.zoom()
    const usableW = v.w - 2 * padding
    const usableH = v.h - 2 * padding
    if (usableW <= 0 || usableH <= 0) return this.cy.zoom()
    const z = Math.min(usableW / bb.w, usableH / bb.h)
    return Math.max(this.cy.minZoom(), Math.min(this.cy.maxZoom(), z))
  }

  // --- Zoom / pan ---------------------------------------------------------

  fit(): void {
    const eles = this.cy.elements(':visible')
    if (eles.empty()) return
    const t = this.fitTarget(eles, 45)
    this.cy.zoom(t.zoom)
    this.cy.pan(t.pan)
  }

  /** Zoom about the middle of the visible rectangle, so the point the user is
   *  looking at stays put rather than drifting under a panel. */
  private zoomAnchor(): { x: number; y: number } {
    const v = this.viewBox()
    return { x: v.x + v.w / 2, y: v.y + v.h / 2 }
  }

  zoomBy(factor: number): void {
    this.cy.zoom({ level: this.cy.zoom() * factor, renderedPosition: this.zoomAnchor() })
  }

  setZoom(level: number): void {
    this.cy.zoom({ level, renderedPosition: this.zoomAnchor() })
  }

  getZoom(): number {
    return this.cy.zoom()
  }
  getMinZoom(): number {
    return this.cy.minZoom()
  }
  getMaxZoom(): number {
    return this.cy.maxZoom()
  }

  /** The currently focused node id (null when showing the whole graph) — used to
   *  restore focus across a soft refresh. */
  getFocusId(): string | null {
    return this.focusId
  }

  getPan(): { x: number; y: number } {
    const p = this.cy.pan()
    return { x: p.x, y: p.y }
  }

  /** Restore an exact camera position (soft refresh, unfocused case). */
  applyViewport(zoom: number, pan: { x: number; y: number }): void {
    this.cy.viewport({ zoom, pan })
  }

  /** Padlock lock: nodes (and department boxes) can't be dragged, but stay fully
   *  clickable / selectable — so a drag to pan never accidentally moves a node,
   *  while taps, right-clicks and edge clicks all still work. */
  setDraggable(draggable: boolean): void {
    if (draggable) this.cy.nodes().grabify()
    else this.cy.nodes().ungrabify()
    this.cy.autoungrabify(!draggable)
  }

  /** Underlying Cytoscape core — used by the overview minimap (read-only). */
  core(): Core {
    return this.cy
  }

  /** Render the current graph to a PNG Blob for export. */
  pngBlob(bg: string): Blob {
    return this.cy.png({ output: 'blob', full: true, scale: 2, bg }) as Blob
  }

  // --- Selection / focus --------------------------------------------------

  /** Move nodes to their recorded `from` or `to` positions (undo / redo of a
   *  drag), animating so the change is legible, then keep them where they land. */
  applyPositions(moves: NodeMove[], which: 'from' | 'to'): void {
    this.cy.stop()
    for (const m of moves) {
      const n = this.cy.getElementById(m.id)
      if (n.empty()) continue
      n.animate({ position: which === 'from' ? m.from : m.to }, { duration: 250 })
    }
  }

  /** Highlight + smoothly pan to a node without firing a selection callback.
   *  Inside a focus view the reach is already the filter, so use the gentler
   *  graded emphasis rather than hard-fading everything outside one hop. */
  centerOn(id: string): void {
    const node = this.cy.getElementById(id)
    if (node.empty()) return
    if (this.focusId) this.emphasizeFocus(id)
    else this.highlightNeighbourhood(node as NodeSingular)
    this.cy.animate({ pan: this.centreOn(node, this.cy.zoom()) }, { duration: 300 })
  }

  /** The set of elements kept visible when focused on `id`: the focus node grown
   *  outward `focusDepth` hops, or its whole connected cluster when the depth is
   *  Infinity (the slider's top notch). */
  private focusNeighbourhoodSet(id: string): cytoscape.Collection {
    const start = this.cy.getElementById(id)
    if (start.empty()) return this.cy.collection()
    // Walk only the links that are actually drawn. A hidden link is not a way to
    // reach anything, so crossing one would bring in a neighbour with nothing
    // joining it to the focus node - a node floating on its own.
    const live = this.liveEdges()
    let hood = start
    let frontier = start
    for (let hop = 0; hop < this.focusDepth; hop++) {
      const step = frontier.connectedEdges().intersection(live)
      const next = step.connectedNodes().difference(hood)
      // Infinity depth (the slider's top notch) means the whole cluster the
      // focus node belongs to, which is just this walk run until it stops.
      if (next.empty()) break
      hood = hood.union(next).union(step)
      frontier = next
    }
    return hood
  }

  /** Collapse the graph to a node and the nodes within `focusDepth` hops of it,
   *  then lay out. The layout is deferred one frame so the visibility
   *  (display:none) changes flush first — otherwise the layout/bounding-box is
   *  computed against stale positions and the view ends up blank or wildly
   *  zoomed. */
  focusNeighbourhood(id: string, layout?: LayoutName): void {
    this.cy.stop() // cancel any in-flight centring from the preceding tap
    if (layout) this.layoutName = layout
    this.focusId = id
    this.deptFilter = null // mutually exclusive with the department filter
    this.traceId = null
    this.applyVisibility()
    this.emphasizeFocus(id)
    requestAnimationFrame(() => this.relayoutForVisibility(true))
  }

  /** Change how many hops out from the focus node stay visible (Infinity = the
   *  whole connected cluster).
   *
   *  Runs the same layout + framing as entering focus does, so every reach step
   *  lands on a freshly laid-out view centred on the focused node. Earlier
   *  attempts to preserve existing positions (placing only the newly-revealed
   *  nodes, or translating a re-layout to pin the focus node) left revealed nodes
   *  at their whole-graph coordinates — scattered far from the focus and off
   *  camera — so don't reintroduce that. */
  setFocusDepth(depth: number): void {
    this.focusDepth = depth
    // Applies to a focused node and to a department filter alike.
    if (this.focusId == null && this.deptFilter == null) return
    this.cy.stop()
    this.applyVisibility()
    // A focused node stays anchored as the reach grows. A filtered department
    // gets no such treatment: the filter has already done the narrowing, and
    // spotlighting the department on top of it faded out the very nodes the
    // reach had just been widened to reveal — including any node belonging to
    // more than one department, which is bucketed as shared and so fails a
    // `deptGroup === bucket` test for the department it is actually in. The
    // view ended up muted end to end, and differed from the same department
    // entered without touching the slider. Emphasis belongs to the spotlight
    // (see highlightDepartment), not to the filter.
    if (this.focusId != null) this.emphasizeFocus(this.focusId)
    else this.cy.elements().removeClass('faded selected dim lit')
    // Deferred a frame so the display:none changes flush before the layout reads
    // positions (otherwise re-shown nodes lay out from stale coordinates).
    requestAnimationFrame(() => this.relayoutForVisibility(true))
  }

  getFocusDepth(): number {
    return this.focusDepth
  }

  /** Emphasise the focused node and its immediate neighbours, dimming anything
   *  further out. Nodes outside the reach are already display:none, so this is
   *  purely about keeping the node the user focused on visually anchored as the
   *  reach grows (rather than every revealed node looking equally prominent). */
  private emphasizeFocus(id: string): void {
    this.cy.elements().removeClass('faded selected dim lit')
    const node = this.cy.getElementById(id)
    if (node.empty()) return
    const nearIds = new Set(this.liveNeighbourhood(node).map((e) => e.id()))
    // Deliberately iterates ALL elements rather than `:visible`: this runs right
    // after applyVisibility()'s batch, whose display changes haven't been flushed
    // yet, so a `:visible` query still returns the PREVIOUS set — which left
    // nodes revealed by a Focus Reach change undimmed until they were re-clicked.
    // Classes on hidden elements are harmless, and become correct if re-revealed.
    this.cy
      .elements()
      .not('.dept-parent')
      .forEach((el) => {
        if (!nearIds.has(el.id())) el.addClass('dim')
        else if (el.isEdge()) el.addClass('lit')
      })
    node.addClass('selected')
  }

  clearFocus(layout?: LayoutName): void {
    this.cy.stop()
    if (layout) this.layoutName = layout
    this.focusId = null
    this.deptFilter = null
    this.traceId = null
    this.cy.elements().removeClass('faded selected dim lit')
    this.applyVisibility()
    requestAnimationFrame(() => this.relayoutForVisibility(true))
  }

  isFocused(): boolean {
    return this.focusId !== null
  }

  /** Filter the view to one department bucket's nodes plus any node with an
   *  edge into that bucket (so cross-department links stay visible). Pass
   *  null to clear. Mutually exclusive with node-focus mode. */
  setDepartmentFilter(bucket: string | null): void {
    this.focusId = null
    this.traceId = null
    this.deptFilter = bucket
    this.cy.elements().removeClass('faded selected dim lit')
    this.applyVisibility()
    // Entering, leaving or changing a department changes which boxes are on
    // screen, so the boxes are rebuilt around the result. See
    // relayoutDepartments.
    requestAnimationFrame(() => this.relayoutForVisibility(true))
  }

  getDepartmentFilter(): string | null {
    return this.deptFilter
  }

  /** Whether the view is narrowed to something — a focused node OR a department.
   *  Both are "focused views", so both are governed by the Focus Reach setting. */
  isFocusedView(): boolean {
    return this.focusId !== null || this.deptFilter !== null
  }

  /** Narrow the view to one node's whole call corridor and lay it out on its
   *  own. traceFlow only highlights the corridor in place, which on a busy
   *  system leaves the path threaded through everything else; this drops the
   *  rest so the path is all that's drawn. */
  focusTrace(id: string): { sources: GraphNode[]; terminals: GraphNode[] } {
    this.cy.stop()
    this.focusId = null
    this.deptFilter = null
    this.traceId = id
    const ends = this.traceFlow(id)
    // traceFlow fades everything outside the corridor; here it is hidden
    // outright, so the fade would only mute the path itself.
    this.cy.elements().removeClass('faded')
    this.applyVisibility()
    requestAnimationFrame(() => this.relayoutForVisibility(true))
    return ends
  }

  getTraceId(): string | null {
    return this.traceId
  }

  /** Every node assigned to a department bucket. */
  departmentMembers(bucket: string): GraphNode[] {
    const out: GraphNode[] = []
    this.cy.nodes().forEach((n) => {
      const model = n.data('model') as GraphNode | undefined
      if (model && model.deptGroup === bucket) out.push(model)
    })
    return out
  }

  /** Spotlight a department: its members and the links between them, dimming the
   *  rest. Mirrors what focusing a node does, one level up.
   *
   *  Returns whether it actually lit anything. A spotlight is only meaningful
   *  when the thing being lit is on screen, and a department's members need not
   *  be: inside a node-focus view the graph is cut down to one neighbourhood,
   *  which may hold none of them. Fading everything to light nothing left the
   *  whole canvas muted with no way back, so that case is declined here and the
   *  caller is left to do something that makes sense instead.
   *
   *  Membership is read from the `hidden` CLASS rather than `:visible` for the
   *  reason emphasizeFocus documents: this can run directly after
   *  applyVisibility(), whose display changes have not been flushed yet. */
  highlightDepartment(bucket: string): boolean {
    const members = this.cy.nodes().filter((n) => {
      const model = n.data('model') as GraphNode | undefined
      return !!model && model.deptGroup === bucket && !n.hasClass('hidden')
    })
    this.cy.elements().removeClass('faded selected dim lit')
    if (members.empty()) return false
    this.cy.elements().not('.dept-parent').addClass('faded')
    members.removeClass('faded').addClass('selected')
    // Internal links only: a link leaving the department belongs to its neighbour
    // as much as to it, so leave those dimmed.
    members.edgesWith(members).removeClass('faded').addClass('lit')
    return true
  }

  /** Hide every member of a department. Returns the ids hidden, for undo. */
  hideDepartment(bucket: string): string[] {
    const ids = this.departmentMembers(bucket).map((n) => n.id)
    for (const id of ids) this.manuallyHidden.add(id)
    this.applyVisibility()
    return ids
  }

  /** Whether a node exists and is currently on-screen (not filtered out). */
  isVisible(id: string): boolean {
    const n = this.cy.getElementById(id)
    return !n.empty() && !n.hasClass('hidden')
  }

  // --- Manual node hiding --------------------------------------------------

  /** Hide one node (context menu → Hide). Deliberately does NOT re-run the
   *  layout: everything else stays exactly where it is, so hiding clutter never
   *  reshuffles the part of the graph being read. */
  hideNode(id: string): void {
    this.manuallyHidden.add(id)
    this.applyVisibility()
  }

  /** Restore every manually-hidden node. */
  unhideAll(): void {
    if (!this.manuallyHidden.size) return
    this.manuallyHidden.clear()
    this.applyVisibility()
  }

  hiddenCount(): number {
    return this.manuallyHidden.size
  }

  /** Restore specific nodes (undo of a Hide). */
  unhideNodes(ids: string[]): void {
    for (const id of ids) this.manuallyHidden.delete(id)
    this.applyVisibility()
  }

  /** Every manually-hidden node id, so a "show all" can be undone. */
  hiddenNodeIds(): string[] {
    return [...this.manuallyHidden]
  }

  // --- Link hiding ---------------------------------------------------------

  /** Hide one specific link. */
  hideEdge(id: string): void {
    this.collapseEdge()
    this.hiddenEdgeIds.add(id)
    this.applyVisibility()
  }

  unhideEdges(ids: string[]): void {
    for (const id of ids) this.hiddenEdgeIds.delete(id)
    this.applyVisibility()
  }

  /** Hide every link of a given type (e.g. all "manager" links). */
  hideEdgeKind(kind: string): void {
    this.collapseEdge()
    this.hiddenEdgeKinds.add(kind)
    this.applyVisibility()
  }

  /** Replace the set of hidden link types outright (Settings panel). */
  setHiddenEdgeKinds(kinds: Iterable<string>): void {
    this.collapseEdge()
    this.hiddenEdgeKinds = new Set(kinds)
    this.applyVisibility()
  }

  getHiddenEdgeKinds(): string[] {
    return [...this.hiddenEdgeKinds]
  }

  /** Hide every link carrying only routes of one type (e.g. every "out of office
   *  hours destination"), leaving the rest of that link *kind* alone. */
  hideRouteGroup(group: string): void {
    this.collapseEdge()
    this.hiddenRouteGroups.add(group)
    this.applyVisibility()
  }

  /** Replace the set of hidden route types outright (Settings panel / undo). */
  setHiddenRouteGroups(groups: Iterable<string>): void {
    this.collapseEdge()
    this.hiddenRouteGroups = new Set(groups)
    this.applyVisibility()
  }

  getHiddenRouteGroups(): string[] {
    return [...this.hiddenRouteGroups]
  }

  /** Every distinct route type currently on the graph, with how many links carry
   *  it — drives the per-route list in Settings. */
  routeGroupCounts(): Array<{ group: string; count: number }> {
    const counts = new Map<string, number>()
    this.cy.edges().forEach((e) => {
      if (e.hasClass('route-split')) return
      const seen = new Set<string>()
      for (const l of ((e.data('labels') as string[]) ?? [])) {
        const g = routeGroupOf(l)
        if (!g || seen.has(g)) continue
        seen.add(g)
        counts.set(g, (counts.get(g) ?? 0) + 1)
      }
    })
    return [...counts.entries()]
      .map(([group, count]) => ({ group, count }))
      .sort((a, b) => a.group.localeCompare(b.group))
  }

  hiddenEdgeIdList(): string[] {
    return [...this.hiddenEdgeIds]
  }

  /** Bring a bundled link's label and colour in line with the routes it still
   *  carries. Hiding every "manager" route out of a link that also carries a
   *  "member" one has to leave a member link behind, not an unchanged "2 routes"
   *  that still lists the manager when you click it. */
  private retagBundle(e: EdgeSingular): void {
    const labels = (e.data('labels') as string[]) ?? []
    if (!labels.length) return
    const keep = this.survivingRoutes(e)

    const label = compactEdgeLabel(keep.map((i) => labels[i]))
    if (e.data('label') !== label) e.data('label', label)

    const kinds = (e.data('labelKinds') as string[] | undefined) ?? []
    const fallback = String(e.data('kind'))
    const distinct = new Set(keep.map((i) => kinds[i] ?? fallback))
    // Only recoloured when what is left is all of one type. A bundle that still
    // mixes types keeps the colour of its dominant kind, as before.
    const shownKind = distinct.size === 1 ? [...distinct][0] : fallback
    const current = String(e.data('kindShown') ?? fallback)
    if (shownKind !== current) {
      e.removeClass(current).addClass(shownKind)
      e.data('kindShown', shownKind)
    }
  }

  /** The link a per-route copy came from; the link itself otherwise. */
  private baseEdgeId(e: EdgeSingular): string {
    return e.hasClass('route-split') ? String(e.id()).split('::route:')[0] : String(e.id())
  }

  /** The id that hides one single route out of a bundled link. It is the id its
   *  per-route copy is given when the link is expanded, so hiding a route from
   *  the expanded view and hiding it from the collapsed one are the same act. */
  private routeEdgeId(baseId: string, index: number): string {
    return `${baseId}::route:${index}`
  }

  /** Which of a link's routes are still shown, as indices into its own `labels`.
   *
   *  A link bundles every relationship between the same two nodes (see addEdge in
   *  build.ts), and those can be of different types — a queue's manager who is
   *  also a ring group member collapses into one link. So "is this filtered out"
   *  has to be asked per route and not per link, otherwise hiding one type either
   *  takes the whole bundle or misses it entirely depending on which relationship
   *  happened to be recorded first. */
  private survivingRoutes(e: EdgeSingular): number[] {
    const labels = (e.data('labels') as string[]) ?? []
    const kinds = (e.data('labelKinds') as string[] | undefined) ?? []
    const fallback = String(e.data('kind'))
    const baseId = this.baseEdgeId(e)
    const out: number[] = []
    for (let i = 0; i < labels.length; i++) {
      if (this.hiddenEdgeIds.has(this.routeEdgeId(baseId, i))) continue
      if (this.hiddenEdgeKinds.has(kinds[i] ?? fallback)) continue
      const group = routeGroupOf(labels[i])
      if (group && this.hiddenRouteGroups.has(group)) continue
      out.push(i)
    }
    return out
  }

  /** Whether a link is currently filtered out — hidden outright, or left with no
   *  route still worth drawing. This is what "not drawn" means, so it also
   *  decides what counts as a connection when a reach is walked (see
   *  focusNeighbourhoodSet). */
  private edgeSuppressed(e: EdgeSingular): boolean {
    const baseId = this.baseEdgeId(e)
    // Hiding the link itself takes everything it carries.
    if (this.hiddenEdgeIds.has(baseId)) return true
    if (e.hasClass('route-split')) {
      // A per-route copy stands for exactly one route of its link, and is judged
      // on that route alone.
      const index = Number(e.data('routeIndex'))
      if (Number.isFinite(index) && this.hiddenEdgeIds.has(this.routeEdgeId(baseId, index)))
        return true
      if (this.hiddenEdgeKinds.has(String(e.data('kind')))) return true
      const group = routeGroupOf(String(e.data('label') ?? ''))
      return !!group && this.hiddenRouteGroups.has(group)
    }
    const labels = (e.data('labels') as string[]) ?? []
    // A link carrying no routes of its own is judged by its type alone.
    if (!labels.length) return this.hiddenEdgeKinds.has(String(e.data('kind')))
    return this.survivingRoutes(e).length === 0
  }

  /** Every link currently drawn. This is what "connected" has to mean once links
   *  can be hidden - otherwise a reach crosses a link that isn't there. */
  private liveEdges(): cytoscape.EdgeCollection {
    return this.cy.edges().filter((e) => !this.edgeSuppressed(e))
  }

  /** `node`, the nodes one drawn link away, and the links between them. */
  private liveNeighbourhood(node: NodeSingular): cytoscape.Collection {
    const step = node.connectedEdges().intersection(this.liveEdges())
    return node.union(step).union(step.connectedNodes())
  }

  /** `nodes` grown outward `depth` hops over drawn links only, or to the whole
   *  connected cluster when the depth is Infinity. The collection form of
   *  liveNeighbourhood, for a department's members rather than one node. */
  private liveReach(nodes: NodeColl, depth: number): cytoscape.Collection {
    const live = this.liveEdges()
    let acc = nodes
    let edges = this.cy.collection() as unknown as EdgeColl
    let frontier = nodes
    for (let hop = 0; hop < depth; hop++) {
      const step = frontier.connectedEdges().intersection(live) as EdgeColl
      const next = step.connectedNodes().difference(acc) as unknown as NodeColl
      if (next.empty()) break
      acc = acc.union(next) as unknown as NodeColl
      edges = edges.union(step) as unknown as EdgeColl
      frontier = next
    }
    return acc.union(edges)
  }

  /** Everything a call can reach from `start`, and everything that can reach it,
   *  following drawn links only. Cytoscape's successors()/predecessors() walk the
   *  whole model graph, so a corridor could otherwise run through a link that is
   *  not on screen - a path the person tracing it cannot see. The two directions
   *  are walked independently, so a node reachable both ways is found both ways. */
  private liveFlow(start: NodeSingular): {
    succ: cytoscape.Collection
    pred: cytoscape.Collection
  } {
    const live = this.liveEdges()
    const walk = (downstream: boolean): cytoscape.Collection => {
      let nodes = this.cy.collection() as unknown as NodeColl
      let edges = this.cy.collection() as unknown as EdgeColl
      let frontier = start as unknown as NodeColl
      for (;;) {
        const out = downstream ? frontier.outgoers('edge') : frontier.incomers('edge')
        const step = out.intersection(live) as EdgeColl
        if (step.empty()) break
        const reached = (downstream ? step.targets() : step.sources()) as unknown as NodeColl
        // The start node is never counted as reached: it anchors the corridor
        // rather than sitting on either side of it.
        const next = reached.difference(nodes.union(start)) as unknown as NodeColl
        nodes = nodes.union(reached) as unknown as NodeColl
        edges = edges.union(step) as unknown as EdgeColl
        if (next.empty()) break
        frontier = next
      }
      return nodes.union(edges)
    }
    return { succ: walk(true), pred: walk(false) }
  }

  /** How many links are not drawn right now, whether that is because the link
   *  itself was hidden or because every route it carried has been. Counted off
   *  the graph rather than off the hidden-id set, which since routes became
   *  individually hideable holds a mix of link ids and route ids. */
  hiddenEdgeCount(): number {
    let n = 0
    this.cy.edges().forEach((e) => {
      if (e.hasClass('route-split')) return
      if (this.edgeSuppressed(e)) n++
    })
    return n
  }

  /** Routes taken out of links that are still drawn. These are invisible to
   *  hiddenEdgeCount - the link is still there - but they are still something
   *  hidden that has to be findable to put back, so they are counted separately
   *  rather than folded into a link count they would falsify. */
  hiddenRouteCount(): number {
    let n = 0
    this.cy.edges().forEach((e) => {
      if (e.hasClass('route-split')) return
      if (this.edgeSuppressed(e)) return
      const labels = (e.data('labels') as string[]) ?? []
      if (labels.length) n += labels.length - this.survivingRoutes(e).length
    })
    return n
  }

  /** Restore every hidden link (individual, by type, and by route type). */
  unhideAllEdges(): void {
    if (!this.hiddenEdgeIds.size && !this.hiddenEdgeKinds.size && !this.hiddenRouteGroups.size)
      return
    this.hiddenEdgeIds.clear()
    this.hiddenEdgeKinds.clear()
    this.hiddenRouteGroups.clear()
    this.applyVisibility()
  }

  // --- Collapsed-edge expansion -------------------------------------------

  /** Explode a collapsed "N routes" edge into one edge per underlying route, each
   *  carrying its own label, and spotlight the two nodes it joins. Multiple
   *  relationships between the same pair are merged into a single edge for layout
   *  speed (see addEdge in build.ts), which hides exactly the detail you want when
   *  you click the link — so it's restored temporarily on demand.
   *
   *  Returns true when the edge actually had several routes to split. */
  expandEdge(edgeId: string): boolean {
    this.collapseEdge()
    const edge = this.cy.getElementById(edgeId)
    if (edge.empty() || !edge.isEdge()) return false
    const labels = (edge.data('labels') as string[]) ?? []
    const kinds = (edge.data('labelKinds') as string[] | undefined) ?? []
    const fallback = String(edge.data('kind'))
    const source = String(edge.data('source'))
    const target = String(edge.data('target'))
    this.spotlightPair(source, target)

    // Only what is actually still drawn: expanding a link must not put back a
    // route that a hidden link type or an earlier per-route hide took out.
    const keep = this.survivingRoutes(edge as EdgeSingular)
    if (keep.length < 2) return false

    this.splitEdgeId = edgeId
    edge.addClass('hidden')
    this.cy.add(
      keep.map((i) => {
        const kind = kinds[i] ?? fallback
        return {
          group: 'edges' as const,
          data: {
            // Indexed by the route's position in the link's own labels, so the
            // copy's id is the id that hides that one route — hiding it here and
            // hiding it from the collapsed link are the same act.
            id: this.routeEdgeId(edgeId, i),
            source,
            target,
            label: labels[i],
            kind,
            labels: [labels[i]],
            labelKinds: [kind],
            routeIndex: i
          },
          classes: `${kind} route-split`
        }
      })
    )
    return true
  }

  /** Put the compact single edge back and drop the per-route copies. */
  collapseEdge(): void {
    if (!this.splitEdgeId) return
    this.cy.edges('.route-split').remove()
    const edge = this.cy.getElementById(this.splitEdgeId)
    if (!edge.empty()) edge.removeClass('hidden')
    this.splitEdgeId = null
  }

  /** Emphasise just the two ends of a link (plus the link itself). */
  private spotlightPair(sourceId: string, targetId: string): void {
    this.cy.elements().removeClass('faded selected dim lit')
    this.cy.elements().not('.dept-parent').addClass('faded')
    const a = this.cy.getElementById(sourceId)
    const b = this.cy.getElementById(targetId)
    a.union(b).removeClass('faded').addClass('selected')
    a.edgesWith(b).removeClass('faded').addClass('lit')
  }

  setVisibleKinds(kinds: Set<NodeKind>): void {
    this.visibleKinds = kinds
    this.applyVisibility()
    // Defer so the display:none → visible changes flush before the layout reads
    // positions — otherwise re-shown nodes land on stale/zero coordinates.
    requestAnimationFrame(() => this.relayoutForVisibility(true))
  }

  setHideUnconnected(hide: boolean): void {
    this.hideUnconnected = hide
    this.applyVisibility()
    requestAnimationFrame(() => this.relayoutForVisibility(true))
  }

  /** Recompute element visibility from the kind filter and any active focus or
   *  department filter. When focused, a node shows if it's in the neighbourhood
   *  AND its category is enabled (the focused node itself always stays
   *  visible). When department-filtered, a node shows if it's a member of that
   *  bucket, or has a direct edge into it (so cross-department links stay
   *  visible), AND its category is enabled. */
  private applyVisibility(): void {
    const focusSet = this.focusId ? this.focusNeighbourhoodSet(this.focusId) : null
    const focusIds = focusSet ? new Set(focusSet.map((e) => e.id())) : null

    // Trace view: everything that can reach the traced node, plus everything it
    // can reach. Unlike focus reach this isn't hop-limited — a call path is only
    // meaningful end to end.
    let traceIds: Set<string> | null = null
    if (this.traceId) {
      const start = this.cy.getElementById(this.traceId)
      if (start.empty()) traceIds = new Set<string>()
      else {
        const { succ, pred } = this.liveFlow(start)
        traceIds = new Set(succ.union(pred).union(start).map((e) => e.id()))
      }
    }

    let deptIds: Set<string> | null = null
    if (this.deptFilter) {
      const members = this.cy.nodes().filter((n) => {
        const model = n.data('model') as GraphNode | undefined
        return !!model && model.deptGroup === this.deptFilter
      })
      // A department is a focused view too, so Focus Reach grows it: 1 hop = the
      // members plus what they touch, higher = further out, top notch = the whole
      // connected cluster they belong to.
      const hood = this.liveReach(members, this.focusDepth)
      deptIds = new Set(hood.map((e) => e.id()))
      // Also walk backward — who routes INTO a member — several hops deep, so
      // the whole entry chain (e.g. Inbound Rule -> shared main IVR -> this
      // department's own IVR/queue -> member) stays visible even when the
      // immediate hop is a gateway shared with other departments. Following
      // only "who points at me" (never "where else do you point") means it
      // never leaks into a shared node's other branches.
      let frontier = members
      for (let hop = 0; hop < 6 && !frontier.empty(); hop++) {
        const ancestors = (
          frontier.incomers('edge').intersection(this.liveEdges()) as EdgeColl
        ).sources()
        const fresh = ancestors.filter((n) => !deptIds!.has(n.id()))
        if (fresh.empty()) break
        fresh.forEach((n) => {
          deptIds!.add(n.id())
        })
        frontier = fresh
      }
    }

    this.cy.batch(() => {
      this.cy.nodes().forEach((n) => {
        const model = n.data('model') as GraphNode | undefined
        if (!model) return // department container — visibility handled below
        // An explicit "Hide" beats every filter, including an active focus.
        if (this.manuallyHidden.has(n.id())) {
          n.addClass('hidden')
          return
        }
        const byKind = this.visibleKinds.has(model.kind)
        let visible: boolean
        if (focusIds) visible = n.id() === this.focusId || (focusIds.has(n.id()) && byKind)
        else if (traceIds) visible = n.id() === this.traceId || (traceIds.has(n.id()) && byKind)
        else if (deptIds) visible = deptIds.has(n.id()) && byKind
        else visible = byKind
        n.toggleClass('hidden', !visible)
      })
      // Optionally drop nodes with no edge to another currently-visible node.
      if (this.hideUnconnected && !focusIds && !traceIds) {
        this.cy.nodes(':visible').forEach((n) => {
          if (!n.data('model')) return
          const connected = n
            .openNeighborhood('node')
            .some((other) => !(other as NodeSingular).hasClass('hidden'))
          if (!connected) n.addClass('hidden')
        })
      }
      this.cy.edges().forEach((e) => {
        const endpointsVisible =
          !e.source().hasClass('hidden') && !e.target().hasClass('hidden')
        // A split copy carries exactly one label, so a hidden route type removes
        // just that route from an expanded link and leaves its siblings drawn.
        const suppressed = this.edgeSuppressed(e)
        // The collapsed edge stays hidden while its per-route copies stand in.
        e.toggleClass('hidden', !endpointsVisible || suppressed || e.id() === this.splitEdgeId)
        if (!suppressed && !e.hasClass('route-split')) this.retagBundle(e)
      })
      // Department boxes: hide any box left with no visible member.
      if (this.deptParentsActive) {
        this.cy.nodes('.dept-parent').forEach((p) => {
          const anyVisible = p.children().some((c) => !(c as NodeSingular).hasClass('hidden'))
          p.toggleClass('hidden', !anyVisible)
        })
      }
    })
    this.scheduleReroute()
    this.cb.onVisibilityChange?.()
  }

  /** The nodes currently on screen. */
  visibleNodes(): GraphNode[] {
    const out: GraphNode[] = []
    this.cy.nodes(':visible').forEach((n) => {
      const model = n.data('model') as GraphNode | undefined
      if (model) out.push(model)
    })
    return out
  }

  setTheme(theme: ThemeName): void {
    this.theme = theme
    this.cy.style(buildStyle(theme, this.edgeOpacity))
  }

  /** Link opacity, 0 (invisible) to 1 (fully opaque). */
  setEdgeMuting(opacity: number): void {
    this.edgeOpacity = Math.min(1, Math.max(0, opacity))
    this.cy.style(buildStyle(this.theme, this.edgeOpacity))
  }

  getEdgeMuting(): number {
    return this.edgeOpacity
  }

  /** Spotlight a specific set of nodes, dimming everything else — used to show
   *  which nodes a snapshot comparison flagged as changed. */
  highlightIds(ids: string[]): void {
    const wanted = new Set(ids)
    this.cy.elements().removeClass('faded selected dim lit')
    this.cy.elements().not('.dept-parent').addClass('faded')
    const matched = this.cy.nodes().filter((n) => wanted.has(n.id()))
    matched.removeClass('faded').addClass('selected')
    // Keep links between two highlighted nodes visible so a routing change reads
    // as a path rather than two unrelated boxes.
    matched.edgesWith(matched).removeClass('faded').addClass('lit')
    if (!matched.empty()) this.cy.animate(this.fitTarget(matched, 60), { duration: 400 })
  }

  /** Dim everything except nodes of the given kind (null clears the highlight). */
  highlightKind(kind: NodeKind | null): void {
    if (!kind) {
      this.cy.elements().removeClass('faded selected dim lit')
      return
    }
    this.cy.elements().removeClass('selected')
    // Never fade the department boxes — a compound parent's opacity multiplies
    // its children's, so fading a box would dim every node inside it and no
    // amount of un-fading a single child could override it.
    this.cy.elements().not('.dept-parent').addClass('faded')
    this.cy.nodes().forEach((n) => {
      const model = n.data('model') as GraphNode | undefined
      if (model?.kind === kind) n.removeClass('faded')
    })
  }

  /** Highlight the full call corridor through `id`: everything that can reach it
   *  (upstream) and everything it can reach (downstream). Returns the entry
   *  points a call can arrive from (upstream roots) and the final destinations it
   *  can end at (downstream leaves). */
  traceFlow(id: string): { sources: GraphNode[]; terminals: GraphNode[] } {
    const start = this.cy.getElementById(id)
    if (start.empty() || !start.data('model')) return { sources: [], terminals: [] }
    const { succ, pred } = this.liveFlow(start)
    this.cy.elements().removeClass('selected dim lit')
    this.cy.elements().not('.dept-parent').addClass('faded')
    const corridor = succ.union(pred).union(start)
    corridor.removeClass('faded')
    corridor.edges().addClass('lit')
    start.addClass('selected')

    const terminals: GraphNode[] = []
    succ.nodes().forEach((n) => {
      const model = n.data('model') as GraphNode | undefined
      // Downstream leaf: a real node with no onward DRAWN edge (end of the path).
      if (model && n.outgoers('edge').intersection(this.liveEdges()).empty())
        terminals.push(model)
    })
    const sources: GraphNode[] = []
    pred.nodes().forEach((n) => {
      const model = n.data('model') as GraphNode | undefined
      // Upstream root: nothing drawn feeds into it, so a call originates there.
      if (model && n.incomers('edge').intersection(this.liveEdges()).empty())
        sources.push(model)
    })
    return { sources, terminals }
  }

  /** Search by name/number, then append nodes whose category matches the term
   *  (e.g. "external" lists all External nodes at the end). */
  search(term: string): GraphNode[] {
    const t = term.trim().toLowerCase()
    if (!t) return []
    const models = this.cy
      .nodes()
      .map((n) => n.data('model') as GraphNode | undefined)
      .filter((m): m is GraphNode => !!m)
    const named = models.filter(
      (m) => m.label.toLowerCase().includes(t) || (m.number ?? '').includes(t)
    )
    const seen = new Set(named.map((m) => m.id))
    const byKind: GraphNode[] = []
    for (const [kind, meta] of Object.entries(NODE_KIND_META)) {
      if (!meta.label.toLowerCase().includes(t)) continue
      for (const m of models) if (m.kind === kind && !seen.has(m.id)) byKind.push(m)
    }
    return [...named, ...byKind]
  }

  /** The same search, but reporting WHY each node matched.
   *
   *  Ranked so the obvious hit stays on top: name, then number, then anything the
   *  node is merely findable by (a DID it answers, that DID's friendly name, an
   *  extension's email), then whole categories by name. The extra terms are the
   *  point — a DID is not a node of its own, so typing one used to find nothing
   *  even though a rule answers it and a trunk carries it. */
  searchDetailed(term: string): SearchHit[] {
    const models = this.cy
      .nodes()
      .map((n) => n.data('model') as GraphNode | undefined)
      .filter((m): m is GraphNode => !!m)
    return rankSearchHits(models, term)
  }

  private highlightNeighbourhood(node: NodeSingular): void {
    const hood = this.liveNeighbourhood(node)
    this.cy.elements().removeClass('selected dim lit')
    // Exclude the department boxes — see highlightKind for why.
    this.cy.elements().not('.dept-parent').addClass('faded')
    hood.removeClass('faded')
    hood.edges().addClass('lit')
    node.addClass('selected')
  }

  destroy(): void {
    this.resizeObserver.disconnect()
    this.container.removeEventListener('wheel', this.onWheel)
    this.boxEl?.remove()
    this.cy.off('render', this.drawEdgeLabels)
    this.labelEl?.remove()
    this.labelWidths.clear()
    this.cy.destroy()
  }
}

/** True only when a raw flag is explicitly false — an absent field is "unknown"
 *  and must not be styled as a problem. */
function rawIsFalse(raw: Record<string, unknown>, ...keys: string[]): boolean {
  for (const k of keys) {
    const v = raw[k]
    if (v === false || v === 'false' || v === 0) return true
    if (v === true || v === 'true' || v === 1) return false
  }
  return false
}

function toElements(graph: TopologyGraph): ElementDefinition[] {
  const els: ElementDefinition[] = []
  const hasMembers = idsWithMembers(graph)
  for (const n of graph.nodes) {
    const classes: string[] = [n.kind, ...statusClasses(n, hasMembers)]
    // Live presence dot (green/orange/red/grey) on user extensions.
    if (n.kind === 'user') {
      const p = presenceOf(n.raw)
      if (p) classes.push(`presence-${p}`)
    }
    els.push({
      data: {
        id: n.id,
        label: n.number ? `${n.label}\n${n.number}` : n.label,
        kind: n.kind,
        model: n
      },
      classes: classes.join(' ')
    })
  }
  const ids = new Set(graph.nodes.map((n) => n.id))
  for (const e of graph.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue
    els.push({
      data: {
        id: e.id,
        source: e.source,
        target: e.target,
        label: compactEdgeLabel(e.labels),
        kind: e.kind,
        // The colour currently applied, which retagBundle moves off `kind` when
        // filtering leaves a bundle carrying only one other type.
        kindShown: e.kind,
        labels: e.labels,
        labelKinds: e.labelKinds ?? []
      },
      classes: e.kind
    })
  }
  return els
}

/** Keep the on-canvas edge label short (a single relationship's label, or an
 *  "N routes" count) so it doesn't overflow onto nodes — the full breakdown is
 *  a click away in the details panel. */
function compactEdgeLabel(labels: string[]): string {
  return labels.length > 1 ? `${labels.length} routes` : (labels[0] ?? '')
}

/** A small filled circle with a contrasting ring, as a data-URI SVG, used as the
 *  presence badge background-image on user nodes. Shared with the details-panel
 *  mini-map so both draw the same badge. */
export function presenceDotUri(fill: string, ring: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5" fill="${fill}" stroke="${ring}" stroke-width="1.5"/></svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

/** Every colour decision the graph's node/edge rendering depends on, in one
 *  place. Exported because the details-panel mini-map draws the same graph at a
 *  smaller scale: when it kept its own copy of these it silently drifted, ending
 *  up with translucent node bodies (so links showed straight through them) and a
 *  dark mode that never matched the canvas. */
export function themePalette(theme: ThemeName): {
  canvasBg: string
  fillBase: string
  fillAlpha: number
  nodeBorderOpacity: number
  labelColor: string
  borderColor: string
  edgeLabelColor: string
  edgeLabelBg: string
} {
  const dark = theme === 'dark'
  return {
    // What node fills are blended against to stay opaque (opaque bodies are what
    // stop links showing through them).
    //
    // Light mode blends toward the canvas, which keeps the familiar pale tint.
    // Dark mode deliberately does NOT: blending toward a near-black canvas
    // crushed every category into much the same dark navy, so fills are built on
    // a lighter slate instead. Nodes then read as raised panels against the dark
    // canvas and the category colours stay distinguishable.
    canvasBg: dark ? '#020617' : '#f1f5f9',
    fillBase: dark ? '#243044' : '#f1f5f9',
    fillAlpha: dark ? 0.5 : 0.18,
    // Kind-coloured borders carry the category, so let them read strongly in dark
    // mode where the fill contrast is inherently lower.
    nodeBorderOpacity: dark ? 0.85 : 0.35,
    labelColor: dark ? '#e2e8f0' : '#0f172a',
    borderColor: dark ? '#e2e8f0' : '#0f172a',
    edgeLabelColor: dark ? '#cbd5e1' : '#475569',
    edgeLabelBg: dark ? '#0f172a' : '#ffffff'
  }
}

/** Queue / ring-group ids that actually have agents or members — needed to flag
 *  the empty ones. */
export function idsWithMembers(graph: TopologyGraph): Set<string> {
  const has = new Set<string>()
  for (const e of graph.edges) if (e.kind === 'agent' || e.kind === 'member') has.add(e.source)
  return has
}

/** Status-flag classes for a node: a disabled extension, a trunk/bridge that
 *  isn't registered, a queue or ring group with nobody in it. Shared with the
 *  mini-map so a problem node looks like a problem in both views. */
export function statusClasses(n: GraphNode, hasMembers: Set<string>): string[] {
  const out: string[] = []
  if (n.kind === 'user' && rawIsFalse(n.raw, 'Enabled', 'IsEnabled')) out.push('status-disabled')
  if ((n.kind === 'trunk' || n.kind === 'bridge') && rawIsFalse(n.raw, 'IsRegistered', 'Registered'))
    out.push('status-unregistered')
  if ((n.kind === 'queue' || n.kind === 'ringGroup') && !hasMembers.has(n.id))
    out.push('status-empty')
  return out
}

/** Blend a colour toward the canvas background. Lets a node be drawn fully
 *  OPAQUE while looking exactly as it did when translucent — which matters
 *  because a see-through node body let every edge behind it show straight
 *  through, making dense areas unreadable. Opaque bodies occlude those edges
 *  instead, so the node reads clearly where a link crosses it. */
export function blendToBackground(hex: string, bg: string, alpha: number): string {
  const parse = (h: string): [number, number, number] => {
    const s = h.replace('#', '')
    const v = s.length === 3
      ? s
          .split('')
          .map((c) => c + c)
          .join('')
      : s
    return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)]
  }
  const [r1, g1, b1] = parse(hex)
  const [r2, g2, b2] = parse(bg)
  const mix = (a: number, b: number): number => Math.round(a * alpha + b * (1 - alpha))
  const hexPair = (n: number): string => n.toString(16).padStart(2, '0')
  return `#${hexPair(mix(r1, r2))}${hexPair(mix(g1, g2))}${hexPair(mix(b1, b2))}`
}

function buildStyle(
  theme: ThemeName,
  edgeOpacity: number = DEFAULT_EDGE_OPACITY
): cytoscape.StylesheetJson {
  const dark = theme === 'dark'
  const {
    fillBase,
    fillAlpha,
    nodeBorderOpacity,
    labelColor,
    borderColor,
    edgeLabelColor,
    edgeLabelBg
  } = themePalette(theme)

  const style: cytoscape.StylesheetJson = [
    {
      selector: 'node',
      style: {
        label: 'data(label)',
        'text-wrap': 'wrap',
        'text-valign': 'center',
        'text-halign': 'center',
        color: labelColor,
        'font-size': 10,
        'font-weight': 600,
        'text-max-width': '130px',
        width: 150,
        height: 42,
        shape: 'round-rectangle',
        'border-width': 2,
        'border-color': borderColor,
        'border-opacity': nodeBorderOpacity
      }
    },
    {
      selector: 'edge',
      style: {
        width: 1.5,
        'curve-style': 'bezier',
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.9,
        // Muted so a thicket of links reads as background structure and the nodes
        // stay the foreground. Nodes are opaque, so links crossing one are hidden
        // behind it entirely. Tunable in Settings.
        opacity: edgeOpacity,
        label: 'data(label)',
        'font-size': 8,
        color: edgeLabelColor,
        // An opaque plate behind the text, not a tint. Cytoscape draws a label in
        // the same pass as the link it belongs to, so there is no way to put every
        // label above every link - the plate is what keeps a label readable where
        // links converge, by masking everything drawn beneath it.
        'text-background-color': edgeLabelBg,
        'text-background-opacity': 1,
        'text-background-shape': 'roundrectangle',
        'text-background-padding': '2px',
        // Read back by drawEdgeLabels, which does the actual drawing. Zero here
        // only stops cytoscape painting a second copy under the links.
        'text-opacity': 0
      }
    },
    // Self-loops (an IVR's "repeat prompt" routes back to itself). Loops need
    // their arc configured explicitly, otherwise Cytoscape can't place the
    // endpoints and logs "invalid endpoints and so it is impossible to draw".
    {
      selector: 'edge:loop',
      style: {
        'curve-style': 'bezier',
        'loop-direction': '-45deg',
        'loop-sweep': '30deg',
        'control-point-step-size': 40
      }
    },
    // The individual routes a collapsed "N routes" edge splits into on click.
    // Bundled parallel edges get fanned apart so each label is readable, and are
    // drawn heavier since they're the thing being inspected.
    {
      selector: 'edge.route-split',
      style: {
        'curve-style': 'bezier',
        'control-point-step-size': 46,
        width: 2,
        opacity: 1,
        'font-size': 9,
        'text-background-opacity': 0.95,
        'text-background-padding': '2px',
        'z-index': 20
      }
    },
    // Department (Department layout) compound container boxes.
    {
      selector: 'node.dept-parent',
      style: {
        shape: 'round-rectangle',
        'background-color': 'data(deptColor)',
        'background-opacity': dark ? 0.1 : 0.06,
        'border-width': 2,
        'border-style': 'dashed',
        'border-color': 'data(deptColor)',
        'border-opacity': 0.9,
        label: 'data(label)',
        'text-valign': 'top',
        'text-halign': 'center',
        'text-margin-y': -6,
        'font-size': 13,
        'font-weight': 700,
        color: 'data(deptColor)',
        // Tight, uniform padding so a box hugs its members. No min-width/height
        // (single-node departments were inflated by the old 80px floor), and
        // exclude the top label from sizing so a lone node's box isn't padded
        // taller than a multi-node one.
        padding: '10px',
        'compound-sizing-wrt-labels': 'exclude'
      }
    }
  ]

  for (const [kind, meta] of Object.entries(NODE_KIND_META)) {
    style.push({
      selector: `node.${kind}`,
      style: {
        // Pre-blended + fully opaque: same tint as before, but edges routed
        // behind the node are hidden by it rather than showing through.
        'background-color': blendToBackground(meta.color, fillBase, fillAlpha),
        'background-opacity': 1,
        'border-color': meta.color
      }
    })
  }
  for (const [kind, meta] of Object.entries(EDGE_KIND_META)) {
    style.push({
      selector: `edge.${kind}`,
      style: { 'line-color': meta.color, 'target-arrow-color': meta.color }
    })
  }

  // --- Status flags (after the kind colours so they win the border) ---------
  style.push(
    // Disabled extension: washed-out neutral fill + dashed, faint border. Kept
    // opaque (a blended grey rather than a low opacity) so it still occludes the
    // edges behind it.
    {
      selector: 'node.status-disabled',
      style: {
        'background-color': blendToBackground('#94a3b8', fillBase, dark ? 0.3 : 0.1),
        'background-opacity': 1,
        'border-style': 'dashed',
        'border-opacity': 0.5
      }
    },
    // Unregistered trunk / bridge: red dashed border — a link that's down.
    {
      selector: 'node.status-unregistered',
      style: {
        'border-color': '#ef4444',
        'border-style': 'dashed',
        'border-width': 2.5,
        'border-opacity': 0.95
      }
    },
    // Queue / ring group with no members: amber dashed border.
    {
      selector: 'node.status-empty',
      style: {
        'border-color': '#f59e0b',
        'border-style': 'dashed',
        'border-width': 2.5,
        'border-opacity': 0.95
      }
    },
    // Out-of-hours / holiday routing renders dashed so it isn't read as the
    // default business-hours path.
    { selector: 'edge.afterhours', style: { 'line-style': 'dashed', 'line-dash-pattern': [6, 3] } }
  )

  // --- Presence badges (user extensions) ------------------------------------
  // A small coloured dot in the node's top-right corner, drawn as a data-URI SVG
  // background image so it doesn't disturb the label or node shape.
  for (const [presence, meta] of Object.entries(PRESENCE_META)) {
    style.push({
      selector: `node.presence-${presence}`,
      style: {
        'background-image': presenceDotUri(meta.color, dark ? '#0f172a' : '#ffffff'),
        'background-width': '12px',
        'background-height': '12px',
        'background-position-x': '99%',
        'background-position-y': '8%',
        'background-clip': 'none',
        'background-image-opacity': 1
      }
    })
  }

  // --- Interaction states (LAST so they always win) -------------------------
  style.push(
    { selector: 'node.faded', style: { opacity: 0.12 } },
    // De-emphasised links are scaled RELATIVE to the configured link opacity.
    // Fixed values broke at low settings: with links already at 30%, a flat 0.25
    // "faded" was indistinguishable from a normal link, so a highlighted route
    // didn't stand out at all.
    { selector: 'edge.faded', style: { opacity: Math.max(0.03, edgeOpacity * 0.12) } },
    // A gentler de-emphasis than `faded`, used for the outer rings of a focus
    // view: still readable, but the focus node's own neighbourhood leads.
    { selector: 'node.dim', style: { opacity: 0.5 } },
    { selector: 'edge.dim', style: { opacity: Math.max(0.06, edgeOpacity * 0.3) } },
    // The links being highlighted are always drawn at full strength, whatever the
    // global opacity, so the corridor under inspection reads clearly.
    // Drawn last, so the corridor under inspection carries its labels above the
    // links crossing it (see the note on the base edge label style).
    { selector: 'edge.lit', style: { opacity: 1, width: 2.2, 'z-index': 30 } },
    {
      selector: 'node.selected',
      style: {
        'border-width': 4,
        'border-color': '#0ea5e9',
        'border-style': 'solid',
        'border-opacity': 1
      }
    },
    // Cytoscape's own selected state (right-drag box selection / group move).
    {
      selector: 'node:selected',
      style: {
        'border-width': 3,
        'border-color': '#f59e0b',
        'border-opacity': 1,
        'overlay-color': '#f59e0b',
        'overlay-opacity': 0.15,
        'overlay-padding': 2
      }
    },
    { selector: '.hidden', style: { display: 'none' } },
    ...pressFeedbackStyle()
  )
  return style
}

/** The grey press feedback shown while the mouse is down on a node, a link or
 *  the background.
 *
 *  Cytoscape's defaults are generous — a 10px halo around the element and a 30px
 *  blob on the canvas — which reads as a fat grey border rather than a tap
 *  acknowledgement. Kept, but trimmed close to the element. Exported because
 *  EVERY Cytoscape instance in the app needs it: the main canvas, the details
 *  mini-map and the overview minimap each build their own stylesheet, and one
 *  left on the defaults sticks out immediately. `scale` shrinks it further for
 *  the small views, whose nodes are a fraction of the size. */
export function pressFeedbackStyle(scale = 1): cytoscape.StylesheetJson {
  const pad = Math.max(1, Math.round(3 * scale))
  return [
    { selector: 'node:active', style: { 'overlay-padding': pad, 'overlay-opacity': 0.12 } },
    { selector: 'edge:active', style: { 'overlay-padding': pad, 'overlay-opacity': 0.12 } },
    {
      selector: 'core',
      // The typings demand a complete Core block; only these two differ from the
      // defaults, so the partial is asserted through.
      style: {
        'active-bg-size': Math.max(4, Math.round(12 * scale)),
        'active-bg-opacity': 0.12
      } as Partial<cytoscape.Css.Core> as cytoscape.Css.Core
    }
  ]
}
