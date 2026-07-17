import { describe, it, expect } from 'vitest'
import { buildTopology } from '../src/renderer/src/graph/build'
import type { Topology, EntitySet } from '../src/shared/types'

const empty = (): EntitySet => ({ path: '', value: [] })

// Minimal topology: one extension that is an agent of one queue. Verifies the
// queue → agent edge the queue-membership / "in this queue" features rely on.
const topo: Topology = {
  fetchedAt: '',
  baseUrl: 'https://pbx.example.com',
  users: { path: '', value: [{ Number: '2001', FirstName: 'Alice', Id: '1' }] },
  queues: {
    path: '',
    value: [{ Number: '8000', Name: 'Sales', Id: '10', Agents: [{ Number: '2001', Id: '1' }] }]
  },
  ringGroups: empty(),
  receptionists: empty(),
  inboundRules: empty(),
  outboundRules: empty(),
  didNumbers: empty(),
  trunks: empty(),
  groups: empty()
}

describe('buildTopology', () => {
  const g = buildTopology(topo)

  it('creates nodes for the extension and the queue', () => {
    expect(g.nodes.find((n) => n.id === 'user:2001')?.label).toBe('Alice')
    expect(g.nodes.find((n) => n.id === 'queue:8000')?.kind).toBe('queue')
  })

  it('links the queue to its agent with an agent edge', () => {
    const agentEdge = g.edges.find(
      (e) => e.source === 'queue:8000' && e.target === 'user:2001' && e.kind === 'agent'
    )
    expect(agentEdge).toBeTruthy()
  })
})
