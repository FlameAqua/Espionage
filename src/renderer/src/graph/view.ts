// Cytoscape rendering of a TopologyGraph: selectable nodes, category and focus
// filtering, switchable layouts, theming, zoom control and space-to-pan.

import cytoscape from 'cytoscape'
import type { Core, ElementDefinition, NodeSingular } from 'cytoscape'
import dagre from 'cytoscape-dagre'
import fcose from 'cytoscape-fcose'
import { NODE_KIND_META, type GraphNode, type NodeKind, type TopologyGraph } from './model'

cytoscape.use(dagre)
cytoscape.use(fcose)

export type ThemeName = 'light' | 'dark'
export type LayoutName = 'flow' | 'force' | 'breadthfirst' | 'compact'

const EDGE_COLOR: Record<string, string> = {
  route: '#64748b',
  overflow: '#f59e0b',
  agent: '#3b82f6',
  manager: '#6366f1',
  member: '#14b8a6',
  trunk: '#a855f7'
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
      boxSelectionEnabled: false
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
      const node = (evt.target as NodeSingular).data('model') as GraphNode
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
        this.cb.onBackgroundTap()
      }
    })
    this.cy.on('cxttap', 'node', (evt) => {
      const oe = evt.originalEvent as MouseEvent
      this.cb.onNodeContext(
        (evt.target as NodeSingular).data('model') as GraphNode,
        oe?.clientX ?? 0,
        oe?.clientY ?? 0
      )
    })
    this.cy.on('zoom', () => this.cb.onZoomChange(this.cy.zoom()))

    this.applyVisibility()
    requestAnimationFrame(() => {
      if (container.clientHeight > 0) {
        this.didInitialFit = true
        this.runLayout(false)
      }
    })
  }

  // --- Layout -------------------------------------------------------------

  setLayout(name: LayoutName): void {
    this.layoutName = name
    this.runLayout()
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
    this.applyVisibility()
    this.highlightNeighbourhood(this.cy.getElementById(id) as NodeSingular)
    requestAnimationFrame(() => this.runLayout(true))
  }

  clearFocus(layout?: LayoutName): void {
    this.cy.stop()
    if (layout) this.layoutName = layout
    this.focusId = null
    this.cy.elements().removeClass('faded selected')
    this.applyVisibility()
    requestAnimationFrame(() => this.runLayout(true))
  }

  isFocused(): boolean {
    return this.focusId !== null
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

  /** Recompute element visibility from the kind filter and any active focus.
   *  When focused, a node shows if it's in the neighbourhood AND its category is
   *  enabled (the focused node itself always stays visible). */
  private applyVisibility(): void {
    const focusSet = this.focusId ? this.cy.getElementById(this.focusId).closedNeighborhood() : null
    const focusIds = focusSet ? new Set(focusSet.map((e) => e.id())) : null
    this.cy.batch(() => {
      this.cy.nodes().forEach((n) => {
        const byKind = this.visibleKinds.has((n.data('model') as GraphNode).kind)
        const visible = focusIds
          ? n.id() === this.focusId || (focusIds.has(n.id()) && byKind)
          : byKind
        n.toggleClass('hidden', !visible)
      })
      // Optionally drop nodes with no edge to another currently-visible node.
      if (this.hideUnconnected && !focusIds) {
        this.cy.nodes(':visible').forEach((n) => {
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
    this.cy.elements().addClass('faded').removeClass('selected')
    this.cy.nodes().forEach((n) => {
      if ((n.data('model') as GraphNode).kind === kind) n.removeClass('faded')
    })
  }

  /** Search by name/number, then append nodes whose category matches the term
   *  (e.g. "external" lists all External nodes at the end). */
  search(term: string): GraphNode[] {
    const t = term.trim().toLowerCase()
    if (!t) return []
    const models = this.cy.nodes().map((n) => n.data('model') as GraphNode)
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
    this.cy.elements().addClass('faded').removeClass('selected')
    hood.removeClass('faded')
    node.addClass('selected')
  }

  destroy(): void {
    this.resizeObserver.disconnect()
    this.container.removeEventListener('wheel', this.onWheel)
    this.cy.destroy()
  }
}

function toElements(graph: TopologyGraph): ElementDefinition[] {
  const els: ElementDefinition[] = []
  for (const n of graph.nodes) {
    els.push({
      data: {
        id: n.id,
        label: n.number ? `${n.label}\n${n.number}` : n.label,
        kind: n.kind,
        model: n
      },
      classes: n.kind
    })
  }
  const ids = new Set(graph.nodes.map((n) => n.id))
  for (const e of graph.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue
    const label = e.labels.length > 1 ? `${e.labels.length} routes` : (e.labels[0] ?? '')
    els.push({
      data: { id: e.id, source: e.source, target: e.target, label, kind: e.kind },
      classes: e.kind
    })
  }
  return els
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
    { selector: 'node.faded', style: { opacity: 0.12 } },
    { selector: 'edge.faded', style: { opacity: 0.05 } },
    {
      selector: 'node.selected',
      style: { 'border-width': 4, 'border-color': '#0ea5e9', 'border-opacity': 1 }
    },
    { selector: '.hidden', style: { display: 'none' } },
    // While panning (padlock / Space) elements pass pointer events through to
    // the core so a drag starting on a node/edge pans instead of grabbing it.
    { selector: '.pan-through', style: { events: 'no' } }
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
  return style
}
