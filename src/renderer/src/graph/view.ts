// Cytoscape rendering of a TopologyGraph: selectable nodes, category and focus
// filtering, switchable layouts, theming, zoom control and space-to-pan.

import cytoscape from 'cytoscape'
import type { Core, ElementDefinition, NodeSingular } from 'cytoscape'
import dagre from 'cytoscape-dagre'
import fcose from 'cytoscape-fcose'
import {
  NODE_KIND_META,
  departmentColor,
  departmentLabel,
  type GraphNode,
  type NodeKind,
  type TopologyGraph
} from './model'

cytoscape.use(dagre)
cytoscape.use(fcose)

export type ThemeName = 'light' | 'dark'
export type LayoutName = 'flow' | 'force' | 'breadthfirst' | 'compact' | 'department'

const EDGE_COLOR: Record<string, string> = {
  route: '#64748b',
  overflow: '#f59e0b',
  agent: '#3b82f6',
  manager: '#6366f1',
  member: '#14b8a6',
  trunk: '#a855f7',
  afterhours: '#0891b2'
}

export interface EdgeTapInfo {
  sourceId: string
  targetId: string
  kind: string
  /** Every individual relationship collapsed into this edge (e.g. "key 1"). */
  labels: string[]
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
}

export class GraphView {
  private cy: Core
  private cb: ViewCallbacks
  private container: HTMLElement
  private resizeObserver: ResizeObserver
  private onWheel!: (e: WheelEvent) => void
  private didInitialFit = false

  private layoutName: LayoutName = 'flow'
  private visibleKinds: Set<NodeKind>
  private focusId: string | null = null
  private hideUnconnected = false
  private deptFilter: string | null = null
  private deptParentsActive = false
  private boxEl!: HTMLElement

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
      const node = (evt.target as NodeSingular).data('model') as GraphNode | undefined
      if (!node) return // department container box — ignore taps on it
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
        this.cy.elements().removeClass('faded selected')
        this.cy.nodes().unselect()
        this.cb.onBackgroundTap()
      }
    })
    this.cy.on('cxttap', 'node', (evt) => {
      const node = (evt.target as NodeSingular).data('model') as GraphNode | undefined
      if (!node) return
      const oe = evt.originalEvent as MouseEvent
      this.cb.onNodeContext(node, oe?.clientX ?? 0, oe?.clientY ?? 0)
    })
    this.cy.on('tap', 'edge', (evt) => {
      const e = evt.target
      this.cb.onEdgeTap({
        sourceId: String(e.data('source')),
        targetId: String(e.data('target')),
        kind: String(e.data('kind')),
        labels: (e.data('labels') as string[]) ?? []
      })
    })
    this.cy.on('zoom', () => this.cb.onZoomChange(this.cy.zoom()))

    this.setupBoxSelect(container)

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
      if (Math.hypot(rp.x - s.x, rp.y - s.y) < 8) return // a click, not a drag
      const em = evt.position
      const x1 = Math.min(sm.x, em.x)
      const x2 = Math.max(sm.x, em.x)
      const y1 = Math.min(sm.y, em.y)
      const y2 = Math.max(sm.y, em.y)
      this.cy.elements().removeClass('faded selected')
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
    this.deptParentsActive = true
    const buckets = new Map<string, string>() // bucket -> colour
    this.cy.nodes().forEach((n) => {
      const model = n.data('model') as GraphNode | undefined
      if (model?.deptGroup) buckets.set(model.deptGroup, departmentColor(model.deptGroup))
    })
    if (!buckets.size) return
    const parents: ElementDefinition[] = []
    buckets.forEach((color, bucket) => {
      parents.push({
        data: { id: `dept:${bucket}`, label: departmentLabel(bucket), deptColor: color },
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
    this.frameView(animate)
  }

  private layoutOptions(): cytoscape.LayoutOptions {
    const base = { animate: false as const, fit: false, padding: 45 }
    switch (this.layoutName) {
      case 'compact': {
        // A tight concentric ring. When focused, the focus node sits alone in
        // the centre and ALL neighbours share one outer ring (binary value);
        // otherwise rings are graded by node degree.
        const id = this.focusId
        return {
          name: 'concentric',
          // @ts-ignore concentric callback
          concentric: (n: NodeSingular) => (id ? (n.id() === id ? 2 : 1) : n.degree(false) + 1),
          levelWidth: () => 1,
          minNodeSpacing: id ? 30 : 36,
          ...base
        } as cytoscape.LayoutOptions
      }
      case 'force':
        // fcose spaces nodes without overlaps and packs disconnected clusters.
        return {
          name: 'fcose',
          quality: 'proof',
          randomize: true,
          nodeSeparation: 140,
          nodeRepulsion: () => 14000,
          idealEdgeLength: () => 110,
          gravity: 0.2,
          packComponents: true,
          ...base
        } as cytoscape.LayoutOptions
      case 'department':
        // Same dagre (LR flow) engine as Flow, but compound-aware:
        // cytoscape-dagre lays each department box's members out internally in
        // call-flow order AND arranges the boxes themselves along the flow, with
        // shared / department-less nodes flowing between them. This replaces the
        // old fcose force layout, which packed nodes into blobs and dropped the
        // boxes in seemingly random places. Spacing is a touch looser than Flow
        // so the box padding + titles have room to breathe.
        return {
          name: 'dagre',
          // @ts-ignore dagre options — larger nodeSep gives vertically-stacked
          // sibling department boxes clearance for their outside top labels, so
          // adjacent boxes (and their titles) don't overlap.
          rankDir: 'LR',
          nodeSep: 42,
          rankSep: 150,
          edgeSep: 10,
          ranker: 'tight-tree',
          ...base
        }
      case 'breadthfirst':
        return {
          name: 'breadthfirst',
          directed: true,
          spacingFactor: 1.0,
          roots: this.focusId ? this.cy.getElementById(this.focusId) : undefined,
          ...base
        } as cytoscape.LayoutOptions
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

  /** Move the camera to frame the visible graph. When focused, always end
   *  centred on the focus node at a zoom that fits its neighbourhood. */
  private frameView(animate: boolean): void {
    const eles = this.cy.elements(':visible')
    if (eles.empty()) return
    if (!animate) {
      if (this.focusId) {
        this.cy.zoom(this.fitZoom(eles, 55))
        this.cy.center(this.cy.getElementById(this.focusId))
      } else {
        this.cy.fit(eles, 45)
      }
      return
    }
    this.cy.stop()
    if (this.focusId) {
      const node = this.cy.getElementById(this.focusId)
      this.cy.animate(
        { center: { eles: node }, zoom: this.fitZoom(eles, 55) },
        { duration: 400, easing: 'ease-in-out' }
      )
    } else {
      this.cy.animate({ fit: { eles, padding: 45 } }, { duration: 400, easing: 'ease-in-out' })
    }
  }

  /** Zoom level that fits the given elements within the viewport. */
  private fitZoom(eles: cytoscape.Collection, padding: number): number {
    const bb = eles.boundingBox({})
    const w = this.cy.width()
    const h = this.cy.height()
    if (bb.w === 0 || bb.h === 0) return this.cy.zoom()
    const z = Math.min((w - 2 * padding) / bb.w, (h - 2 * padding) / bb.h)
    return Math.max(this.cy.minZoom(), Math.min(this.cy.maxZoom(), z))
  }

  // --- Zoom / pan ---------------------------------------------------------

  fit(): void {
    this.cy.fit(this.cy.elements(':visible'), 45)
  }

  zoomBy(factor: number): void {
    this.cy.zoom({
      level: this.cy.zoom() * factor,
      renderedPosition: { x: this.cy.width() / 2, y: this.cy.height() / 2 }
    })
  }

  setZoom(level: number): void {
    this.cy.zoom({ level, renderedPosition: { x: this.cy.width() / 2, y: this.cy.height() / 2 } })
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

  /** Resize the canvas to its container without re-fitting (preserves view). */
  resize(): void {
    this.cy.resize()
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

  /** Lock/unlock node dragging (padlock + Space-pan). When locked, nodes ignore
   *  pointer events (`pan-through`) so a drag starting on a node pans the view
   *  instead of grabbing the node. */
  setNodesGrabbable(grabbable: boolean): void {
    if (grabbable) {
      this.cy.nodes().grabify()
      this.cy.elements().removeClass('pan-through')
    } else {
      this.cy.nodes().ungrabify()
      this.cy.elements().addClass('pan-through')
    }
    this.cy.autoungrabify(!grabbable)
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

  /** Highlight + smoothly pan to a node without firing a selection callback. */
  centerOn(id: string): void {
    const node = this.cy.getElementById(id)
    if (node.empty()) return
    this.highlightNeighbourhood(node as NodeSingular)
    this.cy.animate({ center: { eles: node } }, { duration: 300 })
  }

  /** Collapse the graph to a node and its immediate neighbours, then lay out.
   *  The layout is deferred one frame so the visibility (display:none) changes
   *  flush first — otherwise the layout/bounding-box is computed against stale
   *  positions and the view ends up blank or wildly zoomed. */
  focusNeighbourhood(id: string, layout?: LayoutName): void {
    this.cy.stop() // cancel any in-flight centring from the preceding tap
    if (layout) this.layoutName = layout
    this.focusId = id
    this.deptFilter = null // mutually exclusive with the department filter
    this.applyVisibility()
    this.highlightNeighbourhood(this.cy.getElementById(id) as NodeSingular)
    requestAnimationFrame(() => this.runLayout(true))
  }

  clearFocus(layout?: LayoutName): void {
    this.cy.stop()
    if (layout) this.layoutName = layout
    this.focusId = null
    this.deptFilter = null
    this.cy.elements().removeClass('faded selected')
    this.applyVisibility()
    requestAnimationFrame(() => this.runLayout(true))
  }

  isFocused(): boolean {
    return this.focusId !== null
  }

  /** Filter the view to one department bucket's nodes plus any node with an
   *  edge into that bucket (so cross-department links stay visible). Pass
   *  null to clear. Mutually exclusive with node-focus mode. */
  setDepartmentFilter(bucket: string | null): void {
    this.focusId = null
    this.deptFilter = bucket
    this.cy.elements().removeClass('faded selected')
    this.applyVisibility()
    requestAnimationFrame(() => this.runLayout(true))
  }

  getDepartmentFilter(): string | null {
    return this.deptFilter
  }

  /** Whether a node exists and is currently on-screen (not filtered out). */
  isVisible(id: string): boolean {
    const n = this.cy.getElementById(id)
    return !n.empty() && !n.hasClass('hidden')
  }

  setVisibleKinds(kinds: Set<NodeKind>): void {
    this.visibleKinds = kinds
    this.applyVisibility()
    // Defer so the display:none → visible changes flush before the layout reads
    // positions — otherwise re-shown nodes land on stale/zero coordinates.
    requestAnimationFrame(() => this.runLayout(true))
  }

  setHideUnconnected(hide: boolean): void {
    this.hideUnconnected = hide
    this.applyVisibility()
    requestAnimationFrame(() => this.runLayout(true))
  }

  /** Recompute element visibility from the kind filter and any active focus or
   *  department filter. When focused, a node shows if it's in the neighbourhood
   *  AND its category is enabled (the focused node itself always stays
   *  visible). When department-filtered, a node shows if it's a member of that
   *  bucket, or has a direct edge into it (so cross-department links stay
   *  visible), AND its category is enabled. */
  private applyVisibility(): void {
    const focusSet = this.focusId ? this.cy.getElementById(this.focusId).closedNeighborhood() : null
    const focusIds = focusSet ? new Set(focusSet.map((e) => e.id())) : null

    let deptIds: Set<string> | null = null
    if (this.deptFilter) {
      const members = this.cy.nodes().filter((n) => {
        const model = n.data('model') as GraphNode | undefined
        return !!model && model.deptGroup === this.deptFilter
      })
      deptIds = new Set(members.closedNeighborhood().map((e) => e.id()))
      // Also walk backward — who routes INTO a member — several hops deep, so
      // the whole entry chain (e.g. Inbound Rule -> shared main IVR -> this
      // department's own IVR/queue -> member) stays visible even when the
      // immediate hop is a gateway shared with other departments. Following
      // only "who points at me" (never "where else do you point") means it
      // never leaks into a shared node's other branches.
      let frontier = members
      for (let hop = 0; hop < 6 && !frontier.empty(); hop++) {
        const ancestors = frontier.incomers('node')
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
        const byKind = this.visibleKinds.has(model.kind)
        let visible: boolean
        if (focusIds) visible = n.id() === this.focusId || (focusIds.has(n.id()) && byKind)
        else if (deptIds) visible = deptIds.has(n.id()) && byKind
        else visible = byKind
        n.toggleClass('hidden', !visible)
      })
      // Optionally drop nodes with no edge to another currently-visible node.
      if (this.hideUnconnected && !focusIds) {
        this.cy.nodes(':visible').forEach((n) => {
          if (!n.data('model')) return
          const connected = n
            .openNeighborhood('node')
            .some((other) => !(other as NodeSingular).hasClass('hidden'))
          if (!connected) n.addClass('hidden')
        })
      }
      this.cy.edges().forEach((e) => {
        const visible = !e.source().hasClass('hidden') && !e.target().hasClass('hidden')
        e.toggleClass('hidden', !visible)
      })
      // Department boxes: hide any box left with no visible member.
      if (this.deptParentsActive) {
        this.cy.nodes('.dept-parent').forEach((p) => {
          const anyVisible = p.children().some((c) => !(c as NodeSingular).hasClass('hidden'))
          p.toggleClass('hidden', !anyVisible)
        })
      }
    })
  }

  setTheme(theme: ThemeName): void {
    this.cy.style(buildStyle(theme))
  }

  /** Dim everything except nodes of the given kind (null clears the highlight). */
  highlightKind(kind: NodeKind | null): void {
    if (!kind) {
      this.cy.elements().removeClass('faded selected')
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
    const succ = start.successors()
    const pred = start.predecessors()
    this.cy.elements().removeClass('selected')
    this.cy.elements().not('.dept-parent').addClass('faded')
    succ.union(pred).union(start).removeClass('faded')
    start.addClass('selected')

    const terminals: GraphNode[] = []
    succ.nodes().forEach((n) => {
      const model = n.data('model') as GraphNode | undefined
      // Downstream leaf: a real node with no onward edge (end of the call path).
      if (model && n.outgoers('edge').empty()) terminals.push(model)
    })
    const sources: GraphNode[] = []
    pred.nodes().forEach((n) => {
      const model = n.data('model') as GraphNode | undefined
      // Upstream root: nothing feeds into it, so a call originates there.
      if (model && n.incomers('edge').empty()) sources.push(model)
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

  private highlightNeighbourhood(node: NodeSingular): void {
    const hood = node.closedNeighborhood()
    this.cy.elements().removeClass('selected')
    // Exclude the department boxes — see highlightKind for why.
    this.cy.elements().not('.dept-parent').addClass('faded')
    hood.removeClass('faded')
    node.addClass('selected')
  }

  destroy(): void {
    this.resizeObserver.disconnect()
    this.container.removeEventListener('wheel', this.onWheel)
    this.boxEl?.remove()
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
  // Queue / ring-group ids that actually have agents or members.
  const hasMembers = new Set<string>()
  for (const e of graph.edges) {
    if (e.kind === 'agent' || e.kind === 'member') hasMembers.add(e.source)
  }
  for (const n of graph.nodes) {
    const classes: string[] = [n.kind]
    if (n.kind === 'user' && rawIsFalse(n.raw, 'Enabled', 'IsEnabled'))
      classes.push('status-disabled')
    if (
      (n.kind === 'trunk' || n.kind === 'bridge') &&
      rawIsFalse(n.raw, 'IsRegistered', 'Registered')
    )
      classes.push('status-unregistered')
    if ((n.kind === 'queue' || n.kind === 'ringGroup') && !hasMembers.has(n.id))
      classes.push('status-empty')
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
        labels: e.labels
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

function buildStyle(theme: ThemeName): cytoscape.StylesheetJson {
  const dark = theme === 'dark'
  const labelColor = dark ? '#e2e8f0' : '#0f172a'
  const edgeLabelColor = dark ? '#cbd5e1' : '#475569'
  const edgeLabelBg = dark ? '#0f172a' : '#ffffff'
  const borderColor = dark ? '#e2e8f0' : '#0f172a'

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
        'border-opacity': 0.25
      }
    },
    {
      selector: 'edge',
      style: {
        width: 1.5,
        'curve-style': 'bezier',
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.9,
        label: 'data(label)',
        'font-size': 8,
        color: edgeLabelColor,
        'text-background-color': edgeLabelBg,
        'text-background-opacity': 0.85,
        'text-background-padding': '1px'
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
        'background-color': meta.color,
        'background-opacity': dark ? 0.32 : 0.18,
        'border-color': meta.color
      }
    })
  }
  for (const [kind, color] of Object.entries(EDGE_COLOR)) {
    style.push({
      selector: `edge.${kind}`,
      style: { 'line-color': color, 'target-arrow-color': color }
    })
  }

  // --- Status flags (after the kind colours so they win the border) ---------
  style.push(
    // Disabled extension: dimmed fill + dashed, faint border.
    {
      selector: 'node.status-disabled',
      style: {
        'background-opacity': dark ? 0.12 : 0.08,
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

  // --- Interaction states (LAST so they always win) -------------------------
  style.push(
    { selector: 'node.faded', style: { opacity: 0.12 } },
    { selector: 'edge.faded', style: { opacity: 0.05 } },
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
    // While panning (padlock / Space) elements pass pointer events through to
    // the core so a drag starting on a node/edge pans instead of grabbing it.
    { selector: '.pan-through', style: { events: 'no' } }
  )
  return style
}
