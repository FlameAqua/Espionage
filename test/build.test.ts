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

  it('leaves per-queue login undefined when the agent entry says nothing', () => {
    const agentEdge = g.edges.find((e) => e.kind === 'agent')
    expect(agentEdge?.agentLoggedIn).toBeUndefined()
  })
})

// 3CX v20 lets a supervisor log an agent out of one queue while leaving them
// logged in to another, so the state has to live on each queue → agent link.
describe('buildTopology — per-queue agent login', () => {
  const g = buildTopology({
    ...topo,
    users: { path: '', value: [{ Number: '2001', FirstName: 'Alice', Id: '1' }] },
    queues: {
      path: '',
      value: [
        {
          Number: '8000',
          Name: 'Sales',
          Id: '10',
          Agents: [{ Number: '2001', Id: '1', QueueStatus: 'LoggedIn' }]
        },
        {
          Number: '8001',
          Name: 'Support',
          Id: '11',
          Agents: [{ Number: '2001', Id: '1', QueueStatus: 'LoggedOut' }]
        }
      ]
    }
  })
  const edgeFrom = (queueId: string): { agentLoggedIn?: boolean; labels: string[] } | undefined =>
    g.edges.find((e) => e.source === queueId && e.target === 'user:2001' && e.kind === 'agent')

  it('records each queue independently for the same extension', () => {
    expect(edgeFrom('queue:8000')?.agentLoggedIn).toBe(true)
    expect(edgeFrom('queue:8001')?.agentLoggedIn).toBe(false)
  })

  it('labels the logged-out link so it reads on the canvas', () => {
    expect(edgeFrom('queue:8001')?.labels).toContain('agent (logged out)')
    expect(edgeFrom('queue:8000')?.labels).toContain('agent')
  })
})
