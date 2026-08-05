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

// A trunk's "route unmatched calls to…" destination lives in a hidden ForwardAll
// inbound rule, which is skipped as a node — the routes have to land on the trunk
// itself, or trunks show up as islands with nothing attached.
describe('buildTopology — trunk default routing', () => {
  const g = buildTopology({
    ...topo,
    trunks: {
      path: '',
      value: [
        {
          Id: '65',
          Number: '10000',
          ExternalNumber: '35318899100',
          Direction: 'Both',
          DidNumbers: ['35318899100', '35318899101'],
          Gateway: { Name: 'Generic SIP Trunk', Host: '84.39.232.102', Port: 5060 }
        }
      ]
    },
    inboundRules: {
      path: '',
      value: [
        // The trunk's own default destinations (never listed in the portal).
        {
          Id: '1',
          Condition: 'ForwardAll',
          TrunkId: '65',
          OfficeRoute: { Number: '8000', Type: 'Queue' },
          OutOfOfficeRoute: { Number: '2001', Type: 'Extension' }
        },
        // A real DID rule that names no trunk — matched back by its DID.
        { Id: '2', Condition: 'BasedOnDID', Data: '35318899101', Name: 'Reception' }
      ]
    }
  })

  it('routes the trunk itself to its office-hours destination', () => {
    const e = g.edges.find((x) => x.source === 'trunk:65' && x.target === 'queue:8000')
    expect(e?.kind).toBe('route')
    expect(e?.labels).toContain('office hours destination')
  })

  it('marks the out-of-hours destination as an after-hours route', () => {
    const e = g.edges.find((x) => x.source === 'trunk:65' && x.target === 'user:2001')
    expect(e?.kind).toBe('afterhours')
    expect(e?.labels).toContain('out of office hours destination')
  })

  it('does not create a node for the hidden ForwardAll rule', () => {
    expect(g.nodes.some((n) => n.id === 'inboundRule:1')).toBe(false)
  })

  it('links a DID rule to the trunk that owns that number', () => {
    expect(
      g.edges.some((e) => e.source === 'trunk:65' && e.target === 'inboundRule:2')
    ).toBe(true)
  })

  it('summarises the line on the trunk node', () => {
    const info = g.nodes.find((n) => n.id === 'trunk:65')?.info ?? []
    expect(info).toContainEqual({ label: 'Main number', value: '35318899100' })
    expect(info).toContainEqual({ label: 'DID numbers', value: '2' })
    expect(info).toContainEqual({ label: 'Host', value: '84.39.232.102:5060' })
  })

  it('makes every number the trunk carries searchable', () => {
    const terms = g.nodes.find((n) => n.id === 'trunk:65')?.searchTerms ?? []
    expect(terms).toContainEqual({ label: 'DID', value: '35318899101' })
  })
})

// A DID's friendly name ("Oscar Traynor") lives on the DidNumbers collection,
// not on the rule that answers it — so without threading it through, searching
// the name a human actually knows the number by found nothing.
describe('buildTopology — DID names', () => {
  const rules = (name?: string): Topology['inboundRules'] => ({
    path: '',
    value: [
      {
        Id: '7',
        Condition: 'BasedOnDID',
        Data: '35318899103',
        ...(name ? { Name: name } : {}),
        OfficeRoute: { Number: '8000', Type: 'Queue' }
      }
    ]
  })
  const didNumbers = {
    path: '',
    value: [{ Number: '35318899103', Name: 'Oscar Traynor' }]
  }

  it('makes the rule findable by its DID and by that DID’s name', () => {
    const g = buildTopology({ ...topo, inboundRules: rules(), didNumbers })
    const terms = g.nodes.find((n) => n.id === 'inboundRule:7')?.searchTerms ?? []
    expect(terms).toContainEqual({ label: 'DID', value: '35318899103' })
    expect(terms).toContainEqual({ label: 'DID name', value: 'Oscar Traynor' })
  })

  it('names an unnamed rule after its DID instead of "DID Rule"', () => {
    const g = buildTopology({ ...topo, inboundRules: rules(), didNumbers })
    expect(g.nodes.find((n) => n.id === 'inboundRule:7')?.label).toBe('Oscar Traynor')
  })

  it('never overrides a name the administrator set', () => {
    const g = buildTopology({ ...topo, inboundRules: rules('Reception line'), didNumbers })
    expect(g.nodes.find((n) => n.id === 'inboundRule:7')?.label).toBe('Reception line')
  })

  it('records every DID a multi-number rule answers', () => {
    const g = buildTopology({
      ...topo,
      inboundRules: {
        path: '',
        value: [{ Id: '8', Condition: 'BasedOnDID', Data: '35318899103, 35318899104' }]
      },
      didNumbers
    })
    const terms = g.nodes.find((n) => n.id === 'inboundRule:8')?.searchTerms ?? []
    expect(terms.map((t) => t.value)).toContain('35318899104')
  })
})
