// A small Cytoscape view shown in the details panel: just the selected node and
// its immediate neighbours. Clicking a neighbour navigates the main graph.

import cytoscape from 'cytoscape'
import type { Core, ElementDefinition } from 'cytoscape'
import { NODE_KIND_META, type TopologyGraph } from '../graph/model'
import type { ThemeName } from '../graph/view'

export class EgoMap {
  private cy: Core
  private container!: HTMLElement
  private onWheel!: (e: WheelEvent) => void
  private destroyed = false

  constructor(
    container: HTMLElement,
    graph: TopologyGraph,
    centerId: string,
    theme: ThemeName,
    onNavigate: (id: string) => void
  ) {
    const nodeById = new Map(graph.nodes.map((n) => [n.id, n]))
    const keep = new Set<string>([centerId])
    const edges = graph.edges.filter((e) => e.source === centerId || e.target === centerId)
    for (const e of edges) {
      keep.add(e.source)
      keep.add(e.target)
    }

    const els: ElementDefinition[] = []
    for (const id of keep) {
      const n = nodeById.get(id)
      if (!n) continue
      els.push({
        data: { id, label: n.number ? `${n.label}\n${n.number}` : n.label },
        classes: `${n.kind}${id === centerId ? ' center' : ''}`
      })
    }
    for (const e of edges) {
      if (!keep.has(e.source) || !keep.has(e.target)) continue
      els.push({ data: { id: e.id, source: e.source, target: e.target }, classes: e.kind })
    }

    this.cy = cytoscape({
      container,
      elements: els,
      style: egoStyle(theme),
      autoungrabify: true,
      boxSelectionEnabled: false,
      userZoomingEnabled: false,
      minZoom: 0.2,
      maxZoom: 2.5
    })
    this.cy.on('tap', 'node', (evt) => {
      const id = evt.target.id()
      if (id !== centerId) onNavigate(id)
    })

    // Manual wheel zoom around the cursor: stronger, Ctrl doubles the step.
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
    this.container = container

    requestAnimationFrame(() => {
      // A rapid re-navigation can destroy this mini-map before the deferred layout
      // runs; bail rather than lay out a torn-down / detached graph.
      if (this.destroyed) return
      this.cy.resize()
      const w = container.clientWidth
      const h = container.clientHeight
      // Concentric layout reads the container's bounding box and throws on a
      // degenerate one (zero-size container, or a lone node). Only run it with a
      // real size + neighbours, pass an explicit boundingBox so it never depends
      // on the container dimensions, and guard against any residual edge case.
      if (this.cy.nodes().length > 1 && w > 0 && h > 0) {
        try {
          this.cy
            .layout({
              name: 'concentric',
              boundingBox: { x1: 0, y1: 0, w, h },
              // @ts-ignore concentric callback
              concentric: (n) => (n.hasClass('center') ? 2 : 1),
              levelWidth: () => 1,
              minNodeSpacing: 12,
              padding: 8,
              animate: false
            })
            .run()
        } catch {
          // Fall through to fit — the nodes still render, just un-arranged.
        }
      }
      try {
        this.cy.fit(undefined, 10)
      } catch {
        /* ignore fit on a degenerate/empty graph */
      }
    })
  }

  destroy(): void {
    this.destroyed = true
    this.container.removeEventListener('wheel', this.onWheel)
    this.cy.destroy()
  }
}

function egoStyle(theme: ThemeName): cytoscape.StylesheetJson {
  const dark = theme === 'dark'
  const style: cytoscape.StylesheetJson = [
    {
      selector: 'node',
      style: {
        label: 'data(label)',
        'text-wrap': 'wrap',
        'text-valign': 'center',
        'text-halign': 'center',
        color: dark ? '#e2e8f0' : '#0f172a',
        'font-size': 8,
        'font-weight': 600,
        'text-max-width': '90px',
        width: 86,
        height: 30,
        shape: 'round-rectangle',
        'border-width': 1.5,
        'border-color': dark ? '#e2e8f0' : '#0f172a',
        'border-opacity': 0.25
      }
    },
    {
      selector: 'edge',
      style: {
        width: 1,
        'curve-style': 'bezier',
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.7,
        'line-color': dark ? '#475569' : '#94a3b8',
        'target-arrow-color': dark ? '#475569' : '#94a3b8'
      }
    },
    {
      selector: 'node.center',
      style: { 'border-width': 3, 'border-color': '#0ea5e9', 'border-opacity': 1 }
    }
  ]
  for (const [kind, meta] of Object.entries(NODE_KIND_META)) {
    style.push({
      selector: `node.${kind}`,
      style: { 'background-color': meta.color, 'background-opacity': dark ? 0.32 : 0.18 }
    })
  }
  return style
}
