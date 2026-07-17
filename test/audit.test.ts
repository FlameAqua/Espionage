import { describe, it, expect } from 'vitest'
import { auditTopology, groupFindings } from '../src/renderer/src/graph/audit'
import type { GraphNode, GraphEdge, TopologyGraph } from '../src/renderer/src/graph/model'

const node = (
  id: string,
  kind: GraphNode['kind'],
  label: string,
  raw: Record<string, unknown> = {},
  number?: string
): GraphNode => ({ id, kind, label, raw, number })

const edge = (source: string, target: string, kind: GraphEdge['kind']): GraphEdge => ({
  id: `${source}->${target}`,
  source,
  target,
  kind,
  labels: []
})

// A small topology exercising every finding: a wired queue+agent, an empty +
// unreachable queue, a dead inbound rule, an unregistered trunk, a disabled and
// fully-orphaned extension, plus an unresolved-route warning.
const graph: TopologyGraph = {
  nodes: [
    node('user:2001', 'user', 'Alice', { Enabled: true, IsRegistered: true }, '2001'),
    node('user:2002', 'user', 'Bob', { Enabled: false }, '2002'),
    node('queue:8000', 'queue', 'Sales', {}, '8000'),
    node('queue:8001', 'queue', 'Empty', {}, '8001'),
    node('inboundRule:r1', 'inboundRule', 'DID Rule', {}, '0123'),
    node('inboundRule:r2', 'inboundRule', 'Dead Rule', {}),
    node('trunk:t1', 'trunk', 'SIP', { IsRegistered: false })
  ],
  edges: [edge('inboundRule:r1', 'queue:8000', 'route'), edge('queue:8000', 'user:2001', 'agent')],
  warnings: ['Unresolved route target "9999".']
}

describe('auditTopology', () => {
  const cats = new Set(auditTopology(graph).map((f) => f.category))

  it('flags queues with no members', () => {
    expect(cats.has('Queues / ring groups with no members')).toBe(true)
  })

  it('flags inbound rules routing nowhere', () => {
    expect(cats.has('Inbound rules routing nowhere')).toBe(true)
  })

  it('flags queues nothing routes to', () => {
    expect(cats.has('Queues / groups / IVRs nothing routes to')).toBe(true)
  })

  it('flags unregistered trunks', () => {
    expect(cats.has('Unregistered trunks / bridges')).toBe(true)
  })

  it('flags disabled extensions', () => {
    expect(cats.has('Disabled extensions')).toBe(true)
  })

  it('flags fully orphaned extensions (no DID, no queue, unreferenced)', () => {
    const orphans = auditTopology(graph).filter(
      (f) => f.category === 'Extensions with no DID, not in any queue, and unreferenced'
    )
    // Bob is orphaned; Alice is a queue agent and must NOT be flagged.
    expect(orphans.map((f) => f.nodeId)).toEqual(['user:2002'])
  })

  it('surfaces unresolved-route warnings', () => {
    expect(cats.has('Unresolved routes')).toBe(true)
  })
})

describe('groupFindings', () => {
  it('groups findings by category preserving first-seen order', () => {
    const groups = groupFindings(auditTopology(graph))
    const names = groups.map((g) => g.category)
    expect(new Set(names).size).toBe(names.length) // no duplicate groups
    expect(groups.every((g) => g.items.length > 0)).toBe(true)
  })
})
