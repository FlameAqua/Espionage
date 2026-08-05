import { describe, it, expect } from 'vitest'
import {
  blendToBackground,
  idsWithMembers,
  statusClasses,
  themePalette
} from '../src/renderer/src/graph/view'
import type { GraphNode, TopologyGraph } from '../src/renderer/src/graph/model'

// These helpers exist ONLY so the main canvas and the details-panel mini-map
// can't drift apart. They already did once: the mini-map kept its own copy of
// the palette, ended up drawing translucent node bodies (so links showed
// straight through them) and never got dark mode. Both views import from here
// now, so these tests guard the contract rather than the pixels.

const node = (over: Partial<GraphNode>): GraphNode => ({
  id: 'x',
  kind: 'user',
  label: 'X',
  raw: {},
  ...over
})

describe('themePalette', () => {
  it('builds dark fills on a lighter slate, not the near-black canvas', () => {
    const dark = themePalette('dark')
    // Blending toward the canvas crushed every category into the same navy.
    expect(dark.canvasBg).toBe('#020617')
    expect(dark.fillBase).not.toBe(dark.canvasBg)
  })

  it('blends light fills toward the canvas so the pale tint is kept', () => {
    const light = themePalette('light')
    expect(light.fillBase).toBe(light.canvasBg)
  })

  it('leans harder on the kind-coloured border in dark mode', () => {
    expect(themePalette('dark').nodeBorderOpacity).toBeGreaterThan(
      themePalette('light').nodeBorderOpacity
    )
  })
})

describe('blendToBackground', () => {
  it('returns the colour untouched at full alpha', () => {
    expect(blendToBackground('#3b82f6', '#ffffff', 1)).toBe('#3b82f6')
  })

  it('returns the background at zero alpha', () => {
    expect(blendToBackground('#3b82f6', '#f1f5f9', 0)).toBe('#f1f5f9')
  })

  it('mixes evenly at half alpha', () => {
    expect(blendToBackground('#000000', '#ffffff', 0.5)).toBe('#808080')
  })

  it('expands three-digit hex', () => {
    expect(blendToBackground('#fff', '#000', 1)).toBe('#ffffff')
  })
})

describe('statusClasses', () => {
  const graph = (edges: TopologyGraph['edges']): Set<string> =>
    idsWithMembers({ nodes: [], edges, warnings: [] })

  it('flags a queue nobody is in', () => {
    const empty = graph([])
    expect(statusClasses(node({ id: 'queue:8000', kind: 'queue' }), empty)).toContain('status-empty')
  })

  it('leaves a queue with agents alone', () => {
    const staffed = graph([
      { id: 'e', source: 'queue:8000', target: 'user:2001', kind: 'agent', labels: [] }
    ])
    expect(statusClasses(node({ id: 'queue:8000', kind: 'queue' }), staffed)).not.toContain(
      'status-empty'
    )
  })

  it('flags a trunk that is not registered', () => {
    expect(
      statusClasses(node({ kind: 'trunk', raw: { IsRegistered: false } }), new Set())
    ).toContain('status-unregistered')
  })

  it('treats an absent flag as unknown rather than a problem', () => {
    expect(statusClasses(node({ kind: 'trunk', raw: {} }), new Set())).not.toContain(
      'status-unregistered'
    )
  })

  it('flags a disabled extension', () => {
    expect(statusClasses(node({ kind: 'user', raw: { Enabled: false } }), new Set())).toContain(
      'status-disabled'
    )
  })
})
