import { describe, it, expect } from 'vitest'
import { changedNodeIds, diffTopologies } from '../src/renderer/src/graph/diff'
import type { GraphEdge, GraphNode, TopologyGraph } from '../src/renderer/src/graph/model'

const node = (over: Partial<GraphNode> & { id: string }): GraphNode => ({
  kind: 'user',
  label: 'Node',
  raw: {},
  ...over
})
const edge = (over: Partial<GraphEdge> & { source: string; target: string }): GraphEdge => ({
  id: `${over.source}->${over.target}`,
  kind: 'route',
  labels: [],
  ...over
})
const graph = (nodes: GraphNode[], edges: GraphEdge[] = []): TopologyGraph => ({
  nodes,
  edges,
  warnings: []
})

describe('diffTopologies', () => {
  it('reports an identical graph as unchanged', () => {
    const g = graph([node({ id: 'user:2001', label: 'Alice', number: '2001' })])
    const d = diffTopologies(g, g)
    expect(d.identical).toBe(true)
    expect(d.counts).toEqual({ added: 0, removed: 0, changed: 0 })
  })

  it('detects added and removed entities', () => {
    const before = graph([node({ id: 'user:2001', label: 'Alice', number: '2001' })])
    const after = graph([node({ id: 'user:2002', label: 'Bob', number: '2002' })])
    const d = diffTopologies(before, after)
    expect(d.nodes.map((n) => [n.change, n.label])).toEqual([
      ['added', 'Bob'],
      ['removed', 'Alice']
    ])
    expect(d.counts).toEqual({ added: 1, removed: 1, changed: 0 })
  })

  it('reports a rename as a field change, not add + remove', () => {
    const before = graph([node({ id: 'queue:8000', kind: 'queue', label: 'Sales' })])
    const after = graph([node({ id: 'queue:8000', kind: 'queue', label: 'Sales EU' })])
    const d = diffTopologies(before, after)
    expect(d.nodes).toHaveLength(1)
    expect(d.nodes[0].change).toBe('changed')
    expect(d.nodes[0].details[0]).toContain('"Sales" → "Sales EU"')
  })

  it('reports department moves', () => {
    const before = graph([node({ id: 'user:2001', label: 'Alice', departments: ['Support'] })])
    const after = graph([node({ id: 'user:2001', label: 'Alice', departments: ['Sales'] })])
    expect(diffTopologies(before, after).nodes[0].details[0]).toContain('departments')
  })

  // Snapshots taken minutes apart must not look like configuration changes.
  it('ignores live state such as registration and presence', () => {
    const before = graph([
      node({
        id: 'user:2001',
        label: 'Alice',
        raw: { IsRegistered: true, CurrentProfileName: 'Available', QueueStatus: 'LoggedIn' }
      })
    ])
    const after = graph([
      node({
        id: 'user:2001',
        label: 'Alice',
        raw: { IsRegistered: false, CurrentProfileName: 'Away', QueueStatus: 'LoggedOut' }
      })
    ])
    expect(diffTopologies(before, after).identical).toBe(true)
  })

  it('shows a re-pointed route as one removal plus one addition', () => {
    const nodes = [
      node({ id: 'inboundRule:1', kind: 'inboundRule', label: 'DID' }),
      node({ id: 'queue:8000', kind: 'queue', label: 'Sales' }),
      node({ id: 'queue:8001', kind: 'queue', label: 'Support' })
    ]
    const before = graph(nodes, [edge({ source: 'inboundRule:1', target: 'queue:8000' })])
    const after = graph(nodes, [edge({ source: 'inboundRule:1', target: 'queue:8001' })])
    const d = diffTopologies(before, after)
    expect(d.edges.map((e) => [e.change, e.targetLabel])).toEqual([
      ['added', 'Support'],
      ['removed', 'Sales']
    ])
  })

  it('detects a changed IVR key label on an existing link', () => {
    const nodes = [
      node({ id: 'ivr:8011', kind: 'ivr', label: 'Day IVR' }),
      node({ id: 'queue:8000', kind: 'queue', label: 'Sales' })
    ]
    const before = graph(nodes, [
      edge({ source: 'ivr:8011', target: 'queue:8000', labels: ['key 1'] })
    ])
    const after = graph(nodes, [
      edge({ source: 'ivr:8011', target: 'queue:8000', labels: ['key 2'] })
    ])
    const d = diffTopologies(before, after)
    expect(d.edges).toHaveLength(1)
    expect(d.edges[0].change).toBe('changed')
    expect(d.edges[0].details[0]).toBe('key 1 → key 2')
  })

  it('is insensitive to the order labels happen to be collapsed in', () => {
    const nodes = [
      node({ id: 'ivr:8011', kind: 'ivr', label: 'IVR' }),
      node({ id: 'queue:8000', kind: 'queue', label: 'Q' })
    ]
    const before = graph(nodes, [
      edge({ source: 'ivr:8011', target: 'queue:8000', labels: ['key 1', 'key 2'] })
    ])
    const after = graph(nodes, [
      edge({ source: 'ivr:8011', target: 'queue:8000', labels: ['key 2', 'key 1'] })
    ])
    expect(diffTopologies(before, after).identical).toBe(true)
  })
})

describe('changedNodeIds', () => {
  it('includes both ends of a changed link so the canvas can highlight them', () => {
    const nodes = [
      node({ id: 'ivr:8011', kind: 'ivr', label: 'IVR' }),
      node({ id: 'queue:8000', kind: 'queue', label: 'Q' })
    ]
    const d = diffTopologies(
      graph(nodes, []),
      graph(nodes, [edge({ source: 'ivr:8011', target: 'queue:8000' })])
    )
    expect(changedNodeIds(d).sort()).toEqual(['ivr:8011', 'queue:8000'])
  })

  it('omits removed nodes, which no longer exist to highlight', () => {
    const d = diffTopologies(graph([node({ id: 'user:2001', label: 'Gone' })]), graph([]))
    expect(changedNodeIds(d)).toEqual([])
  })
})
