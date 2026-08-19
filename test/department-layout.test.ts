// The department view's compound layout: each department's members grouped into
// its own box, and the boxes laid out along the flow rather than on top of one
// another.
//
// Uses a headless cytoscape — no DOM, no Electron, in keeping with the rest of
// the suite. Node positions are real once a layout has run, so the grouping
// asserted below is genuine: these boxes are built fresh and then laid out,
// which is the state GraphView.relayoutDepartments takes care to produce.
//
// Be clear about what this does NOT cover. Departments piled onto one another
// because a box that had already been measured around some earlier view kept
// describing it, and cytoscape-dagre passes that size to dagre as the cluster's
// size. Reproducing that needs a box measured across a change of visibility,
// which only a real renderer does. So these tests pass with or without the
// rebuild in relayoutDepartments — they guard the grouping property in general,
// while the fix itself is verified against a running renderer, not here. Don't
// read a green run as cover for it.

import { describe, it, expect } from 'vitest'
import cytoscape from 'cytoscape'
import dagre from 'cytoscape-dagre'

cytoscape.use(dagre)

/** The department case of GraphView.layoutOptions(), kept in step by hand. */
const DEPT_LAYOUT = {
  name: 'dagre',
  rankDir: 'LR',
  nodeSep: 22,
  rankSep: 160,
  edgeSep: 6,
  ranker: 'tight-tree',
  animate: false,
  fit: false,
  padding: 45
} as never

/** `depts` department boxes, each holding a chain of `per` nodes, plus a link
 *  from each department into the next so the graph is connected. */
function system(depts: number, per: number): cytoscape.Core {
  const elements: cytoscape.ElementDefinition[] = []
  for (let d = 0; d < depts; d++) {
    elements.push({ data: { id: `dept:${d}` }, classes: 'dept-parent' })
    for (let i = 0; i < per; i++) elements.push({ data: { id: `n${d}_${i}`, parent: `dept:${d}` } })
    for (let i = 1; i < per; i++)
      elements.push({ data: { id: `e${d}_${i}`, source: `n${d}_${i - 1}`, target: `n${d}_${i}` } })
    if (d > 0) elements.push({ data: { id: `x${d}`, source: `n${d - 1}_0`, target: `n${d}_0` } })
  }
  return cytoscape({
    headless: true,
    styleEnabled: true,
    elements,
    style: [{ selector: 'node', style: { width: 40, height: 20 } }] as never
  })
}

/** What GraphView.runLayout does for the department view. */
function layout(cy: cytoscape.Core): void {
  cy.elements(':visible').layout(DEPT_LAYOUT).run()
}

/** Pairs of department boxes drawn over one another. */
function overlappingBoxes(cy: cytoscape.Core): string[] {
  const boxes = cy
    .nodes('.dept-parent')
    .map((p) => ({ id: p.id(), bb: p.boundingBox({ includeLabels: false }) }))
  const out: string[] = []
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i].bb
      const b = boxes[j].bb
      if (a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1)
        out.push(`${boxes[i].id} over ${boxes[j].id}`)
    }
  return out
}

describe('department layout', () => {
  for (const [depts, per] of [
    [2, 4],
    [5, 6],
    [12, 8]
  ] as Array<[number, number]>) {
    it(`gives each of ${depts} departments its own space`, () => {
      const cy = system(depts, per)
      layout(cy)
      // Boxes piled on one another is what the user sees as "every department
      // overlaid on the one that was open".
      expect(overlappingBoxes(cy)).toEqual([])
    })
  }

  it('sizes every box from its members rather than leaving it degenerate', () => {
    const cy = system(6, 5)
    layout(cy)
    for (const p of cy.nodes('.dept-parent')) {
      const bb = p.boundingBox({ includeLabels: false })
      // A box that collapsed to a point is the failure this guards: dagre was
      // being handed 1x1 clusters and packing them all into the same spot.
      expect(bb.w, `${p.id()} width`).toBeGreaterThan(40)
      expect(Number.isFinite(bb.x1), `${p.id()} placed`).toBe(true)
    }
  })

  it('keeps every member inside its own department box', () => {
    const cy = system(5, 6)
    layout(cy)
    const strays: string[] = []
    for (const p of cy.nodes('.dept-parent')) {
      const bb = p.boundingBox({ includeLabels: false })
      p.children().forEach((c) => {
        const q = c.position()
        if (q.x < bb.x1 || q.x > bb.x2 || q.y < bb.y1 || q.y > bb.y2)
          strays.push(`${c.id()} outside ${p.id()}`)
      })
    }
    expect(strays).toEqual([])
  })

  it('leaves every node at a finite position', () => {
    const cy = system(8, 6)
    layout(cy)
    const stray = cy
      .nodes()
      .filter((n) => !Number.isFinite(n.position().x) || !Number.isFinite(n.position().y))
    expect(stray.map((n) => n.id())).toEqual([])
  })
})
