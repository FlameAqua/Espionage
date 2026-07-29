// Cytoscape rendering of a TopologyGraph: selectable nodes, category and focus
// filtering, switchable layouts, theming, zoom control and space-to-pan.

import cytoscape from 'cytoscape'
import type { Core, ElementDefinition, NodeSingular } from 'cytoscape'
import dagre from 'cytoscape-dagre'
import fcose from 'cytoscape-fcose'
import {
  EDGE_KIND_META,
  NODE_KIND_META,
  PRESENCE_META,
  departmentColor,
  departmentLabel,
  presenceOf,
  type GraphNode,
  type NodeKind,
  type TopologyGraph
} from './model'

cytoscape.use(dagre)
cytoscape.use(fcose)

export type ThemeName = 'light' | 'dark'
export type LayoutName = 'flow' | 'force' | 'breadthfirst' | 'compact' | 'department'

/** Default link opacity — links read as background structure so the nodes stay
 *  the foreground. Adjustable in Settings (see setEdgeMuting). */
export const DEFAULT_EDGE_OPACITY = 0.5

export interface EdgeTapInfo {
  sourceId: string
  targetId: string
  kind: string
  /** Every individual relationship collapsed into this edge (e.g. "key 1"). */
  labels: string[]
  /** Set when one of the split-out per-route edges was tapped, so the details
   *  panel can call out which single route it was. */
  tappedLabel?: string
}

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
  onEdgeContext: (info: EdgeTapInfo & { edgeId: string }, x: number, y: number) => void
  /** One or more nodes finished being dragged to a new position. */
  onNodesMoved: (moves: NodeMove[]) => void
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

  private layoutName: LayoutName = 'flow'
  private visibleKinds: Set<NodeKind>
  private focusId: string | null = null
  // How many hops out from the focus node stay visible. Infinity = the whole
  // connected cluster the focus node belongs to.
  private focusDepth = 1
  private hideUnconnected = false
  private deptFilter: string | null = null
  private deptParentsActive = false
  private boxEl!: HTMLElement
  /** Nodes the user explicitly hid via the context menu. Wins over every filter. */
  private manuallyHidden = new Set<string>()
  /** Individual links hidden via the edge context menu. */
  private hiddenEdgeIds = new Set<string>()
  /** Whole link types hidden (context menu "Hide all" / Settings). */
  private hiddenEdgeKinds = new Set<string>()
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
      const node = (evt.target as NodeSingular).data('model') as GraphNode | undefined
      if (!node) return // department container box — ignore taps on it
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
      const node = (evt.target as NodeSingular).data('model') as GraphNode | undefined
      if (!node) return
      const oe = evt.originalEvent as MouseEvent
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
      // hides the whole link rather than one temporary stand-in.
      const baseId = e.hasClass('route-split')
        ? String(e.id()).split('::route:')[0]
        : String(e.id())
      this.cb.onEdgeContext(
        {
          edgeId: baseId,
          sourceId: String(e.data('source')),
          targetId: String(e.data('target')),
          kind: String(e.data('kind')),
          labels: (e.data('labels') as string[]) ?? []
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
    })
    this.cy.on('free', 'node', () => {
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
      if (moves.length) this.cb.onNodesMoved(moves)
    })

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
        this.cy.zoom(this.fitZoomAroundFocus(eles, 55))
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
        { center: { eles: node }, zoom: this.fitZoomAroundFocus(eles, 55) },
        { duration: 400, easing: 'ease-in-out' }
      )
    } else {
      this.cy.animate({ fit: { eles, padding: 45 } }, { duration: 400, easing: 'ease-in-out' })
    }
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
    const z = Math.min(
      (this.cy.width() / 2 - padding) / halfW,
      (this.cy.height() / 2 - padding) / halfH
    )
    return Math.max(this.cy.minZoom(), Math.min(this.cy.maxZoom(), z))
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

  /** Full pass-through mode for Space-pan: elements ignore pointer events
   *  (`pan-through`) so a drag starting anywhere — even on a node — pans the view.
   *  Used only while Space is held. */
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

  /** Padlock lock: nodes (and department boxes) can't be dragged, but stay fully
   *  clickable / selectable — so a drag to pan never accidentally moves a node,
   *  while taps, right-clicks and edge clicks all still work. */
  setDraggable(draggable: boolean): void {
    // Never leave elements event-blocked here — locked nodes must stay clickable.
    this.cy.elements().removeClass('pan-through')
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
    this.cy.animate({ center: { eles: node } }, { duration: 300 })
  }

  /** The set of elements kept visible when focused on `id`: the focus node grown
   *  outward `focusDepth` hops, or its whole connected cluster when the depth is
   *  Infinity (the slider's top notch). */
  private focusNeighbourhoodSet(id: string): cytoscape.Collection {
    const start = this.cy.getElementById(id)
    if (start.empty()) return this.cy.collection()
    if (!Number.isFinite(this.focusDepth)) return start.component()
    let hood = start.closedNeighborhood()
    for (let hop = 1; hop < this.focusDepth; hop++) hood = hood.closedNeighborhood()
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
    this.applyVisibility()
    this.emphasizeFocus(id)
    requestAnimationFrame(() => this.runLayout(true))
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
    if (this.focusId == null) return
    this.cy.stop()
    this.applyVisibility()
    this.emphasizeFocus(this.focusId)
    // Deferred a frame so the display:none changes flush before the layout reads
    // positions (otherwise re-shown nodes lay out from stale coordinates).
    requestAnimationFrame(() => this.runLayout(true))
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
    const nearIds = new Set(node.closedNeighborhood().map((e) => e.id()))
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
    this.cy.elements().removeClass('faded selected dim lit')
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
    this.cy.elements().removeClass('faded selected dim lit')
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

  hiddenEdgeIdList(): string[] {
    return [...this.hiddenEdgeIds]
  }

  /** How many links are hidden right now, individually or by type. */
  hiddenEdgeCount(): number {
    let byKind = 0
    if (this.hiddenEdgeKinds.size) {
      this.cy.edges().forEach((e) => {
        if (this.hiddenEdgeKinds.has(String(e.data('kind')))) byKind++
      })
    }
    return this.hiddenEdgeIds.size + byKind
  }

  /** Restore every hidden link (individual and by type). */
  unhideAllEdges(): void {
    if (!this.hiddenEdgeIds.size && !this.hiddenEdgeKinds.size) return
    this.hiddenEdgeIds.clear()
    this.hiddenEdgeKinds.clear()
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
    const source = String(edge.data('source'))
    const target = String(edge.data('target'))
    this.spotlightPair(source, target)
    if (labels.length < 2) return false

    const kind = String(edge.data('kind'))
    this.splitEdgeId = edgeId
    edge.addClass('hidden')
    this.cy.add(
      labels.map((label, i) => ({
        group: 'edges' as const,
        data: {
          id: `${edgeId}::route:${i}`,
          source,
          target,
          label,
          kind,
          labels: [label]
        },
        classes: `${kind} route-split`
      }))
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
    const focusSet = this.focusId ? this.focusNeighbourhoodSet(this.focusId) : null
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
        // An explicit "Hide" beats every filter, including an active focus.
        if (this.manuallyHidden.has(n.id())) {
          n.addClass('hidden')
          return
        }
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
        const endpointsVisible =
          !e.source().hasClass('hidden') && !e.target().hasClass('hidden')
        // A per-route copy inherits the hidden state of the edge it split from.
        const baseId = e.hasClass('route-split') ? String(e.id()).split('::route:')[0] : e.id()
        const suppressed =
          this.hiddenEdgeIds.has(baseId) || this.hiddenEdgeKinds.has(String(e.data('kind')))
        // The collapsed edge stays hidden while its per-route copies stand in.
        e.toggleClass('hidden', !endpointsVisible || suppressed || e.id() === this.splitEdgeId)
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
    const succ = start.successors()
    const pred = start.predecessors()
    this.cy.elements().removeClass('selected dim lit')
    this.cy.elements().not('.dept-parent').addClass('faded')
    const corridor = succ.union(pred).union(start)
    corridor.removeClass('faded')
    corridor.edges().addClass('lit')
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
    // Live presence dot (green/orange/red/grey) on user extensions.
    if (n.kind === 'user') {
      const p = presenceOf(n.raw)
      if (p) classes.push(`presence-${p}`)
    }
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

/** A small filled circle with a contrasting ring, as a data-URI SVG, used as the
 *  presence badge background-image on user nodes. */
function presenceDot(fill: string, ring: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5" fill="${fill}" stroke="${ring}" stroke-width="1.5"/></svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

/** Blend a colour toward the canvas background. Lets a node be drawn fully
 *  OPAQUE while looking exactly as it did when translucent — which matters
 *  because a see-through node body let every edge behind it show straight
 *  through, making dense areas unreadable. Opaque bodies occlude those edges
 *  instead, so the node reads clearly where a link crosses it. */
function blendToBackground(hex: string, bg: string, alpha: number): string {
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
  const labelColor = dark ? '#e2e8f0' : '#0f172a'
  const edgeLabelColor = dark ? '#cbd5e1' : '#475569'
  const edgeLabelBg = dark ? '#0f172a' : '#ffffff'
  const borderColor = dark ? '#e2e8f0' : '#0f172a'
  // Must match the canvas colour behind the graph (see the <main> background in
  // app.ts) or the blended node fills won't look like the old translucent ones.
  const canvasBg = dark ? '#020617' : '#f1f5f9'
  const fillAlpha = dark ? 0.32 : 0.18

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
        // Muted so a thicket of links reads as background structure and the nodes
        // stay the foreground. Nodes are opaque, so links crossing one are hidden
        // behind it entirely. Tunable in Settings.
        opacity: edgeOpacity,
        label: 'data(label)',
        'font-size': 8,
        color: edgeLabelColor,
        'text-background-color': edgeLabelBg,
        'text-background-opacity': 0.85,
        'text-background-padding': '1px'
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
        'background-color': blendToBackground(meta.color, canvasBg, fillAlpha),
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
        'background-color': blendToBackground('#94a3b8', canvasBg, dark ? 0.16 : 0.1),
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
        'background-image': presenceDot(meta.color, dark ? '#0f172a' : '#ffffff'),
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
    { selector: 'edge.lit', style: { opacity: 1, width: 2.2 } },
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
