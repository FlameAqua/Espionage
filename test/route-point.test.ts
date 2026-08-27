// Route points: the DNs a Call Flow Designer script is deployed on.
//
// 3CX publishes these as /xapi/v1/CallFlowApps. When that collection is present
// a route point is a first-class node with its script's build state; when it is
// absent — an older snapshot, or a licence that gates the endpoint — the only
// thing identifying one is the name carried inline on whatever routes to it, so
// both paths are covered here. The inbound rule below is a real record from a
// live system, kept verbatim.

import { describe, it, expect } from 'vitest'
import { buildTopology } from '../src/renderer/src/graph/build'
import { auditTopology } from '../src/renderer/src/graph/audit'
import type { Topology, EntitySet } from '../src/shared/types'

const empty = (): EntitySet => ({ path: '', value: [] })

const routePointDest = {
  External: '',
  To: 'RoutePoint',
  Number: '7771',
  Name: 'onecontact',
  Type: 'RoutePoint',
  Tags: []
}

const topo: Topology = {
  fetchedAt: '',
  baseUrl: 'https://pbx.example.com',
  users: empty(),
  queues: empty(),
  ringGroups: empty(),
  receptionists: empty(),
  inboundRules: {
    path: '/xapi/v1/InboundRules',
    value: [
      {
        CustomData: '',
        Data: '35319060990',
        RuleName: 'OC Main Number',
        CallType: 'AllCalls',
        Condition: 'BasedOnDID',
        AlterDestinationDuringOutOfOfficeHours: true,
        AlterDestinationDuringHolidays: false,
        Id: 131,
        Hours: { Type: 'OfficeHours', IgnoreHolidays: false, Periods: [] },
        OfficeHoursDestination: { ...routePointDest },
        OutOfOfficeHoursDestination: { ...routePointDest },
        HolidaysDestination: { ...routePointDest }
      }
    ]
  },
  outboundRules: empty(),
  didNumbers: empty(),
  trunks: empty(),
  groups: empty()
}

/** The same system, with the CallFlowApps collection 3CX actually publishes. */
const withApps = (apps: Record<string, unknown>[]): Topology => ({
  ...topo,
  callFlowApps: { path: '/xapi/v1/CallFlowApps', value: apps }
})

describe('route points from CallFlowApps', () => {
  const app = {
    Id: 42,
    Number: '7771',
    Name: 'onecontact',
    IsRegistered: true,
    CompilationSucceeded: true,
    InvalidScript: false,
    CompilationLastSuccess: '2026-08-01T09:15:00Z',
    RoutingType: 'DialCode'
  }
  const g = buildTopology(withApps([app]))
  const rp = g.nodes.find((n) => n.kind === 'routePoint')

  it('becomes a route point node in its own right', () => {
    expect(rp).toBeTruthy()
    expect(rp!.label).toBe('onecontact')
    expect(rp!.number).toBe('7771')
  })

  it('is what the inbound rule routes to — not a second, synthesised node', () => {
    const rule = g.nodes.find((n) => n.kind === 'inboundRule')!
    expect(g.edges.some((e) => e.source === rule.id && e.target === rp!.id)).toBe(true)
    // The DN resolves to the real record, so no bare endpoint stand-in is made.
    expect(g.nodes.filter((n) => n.number === '7771')).toHaveLength(1)
    expect(g.nodes.some((n) => n.kind === 'endpoint')).toBe(false)
  })

  it('reports the script build state', () => {
    expect(rp!.info?.some((i) => i.label === 'Script' && i.value === 'Compiled')).toBe(true)
    expect(rp!.info?.some((i) => i.label === 'Last built')).toBe(true)
  })

  it('passes the health check when the script is healthy', () => {
    const cats = auditTopology(g).map((f) => f.category)
    expect(cats.some((c) => /Route points/.test(c))).toBe(false)
  })

  it('flags a script that failed to compile', () => {
    const broken = buildTopology(
      withApps([{ ...app, CompilationSucceeded: false, InvalidScript: true }])
    )
    const finding = auditTopology(broken).find((f) => /failed to compile/.test(f.category))
    expect(finding).toBeTruthy()
    expect(finding!.severity).toBe('warn')
  })

  it('flags a route point that is not registered', () => {
    const down = buildTopology(withApps([{ ...app, IsRegistered: false }]))
    expect(auditTopology(down).some((f) => /not registered/.test(f.category))).toBe(true)
  })

  it('still has nothing leaving it — a script decides that at runtime', () => {
    expect(g.edges.filter((e) => e.source === rp!.id)).toHaveLength(0)
  })
})

describe('links derived from a route point script', () => {
  const script = [
    'public void Main() {',
    '  // legacy flow used 2002',
    '  if (IsOfficeHours()) {',
    '    TransferTo("8000");',
    '  } else {',
    '    TransferTo("2001");',
    '  }',
    '  Thread.Sleep(30000);',
    '}'
  ].join('\n')

  const withStaff: Topology = {
    ...topo,
    users: { path: '', value: [{ Number: '2001', FirstName: 'Alice', Id: '1' }] },
    queues: { path: '', value: [{ Number: '8000', Name: 'Sales', Id: '10' }] },
    callFlowApps: {
      path: '/xapi/v1/CallFlowApps',
      value: [{ Id: 42, Number: '7771', Name: 'onecontact', ScriptCode: script }]
    }
  }
  const g = buildTopology(withStaff)
  const rp = g.nodes.find((n) => n.kind === 'routePoint')!
  const out = g.edges.filter((e) => e.source === rp.id)

  it('links the route point to the DNs its script names', () => {
    const targets = out.map((e) => g.nodes.find((n) => n.id === e.target)!.number).sort()
    expect(targets).toEqual(['2001', '8000'])
  })

  it('marks them as script mentions, not as routing', () => {
    expect(out.every((e) => e.kind === 'script')).toBe(true)
    expect(out[0].labels[0]).toMatch(/mentioned in script/)
  })

  it('carries the line each DN was found on as evidence', () => {
    expect(rp.scriptRefs?.map((r) => r.number).sort()).toEqual(['2001', '8000'])
    const sales = rp.scriptRefs!.find((r) => r.number === '8000')!
    expect(sales.text).toContain('TransferTo("8000")')
  })

  it('does not invent a link from a number in a comment', () => {
    // 2002 appears, but only in a comment, and it is not a DN here anyway.
    expect(out.some((e) => g.nodes.find((n) => n.id === e.target)?.number === '2002')).toBe(false)
  })

  it('does not mistake a sleep timeout for a destination', () => {
    expect(g.nodes.some((n) => n.number === '30000')).toBe(false)
  })

  it('adds nothing when there is no script to read', () => {
    const bare = buildTopology({
      ...withStaff,
      callFlowApps: { path: '', value: [{ Id: 42, Number: '7771', Name: 'onecontact' }] }
    })
    const node = bare.nodes.find((n) => n.kind === 'routePoint')!
    expect(bare.edges.filter((e) => e.source === node.id)).toHaveLength(0)
    expect(node.scriptRefs).toBeUndefined()
  })
})

describe('a real Call Flow Designer app', () => {
  // The shape CFD generates: a component per transfer, then its destination.
  const cfd = [
    'namespace OneContact {',
    '  private void InitializeComponents(ICallflow callflow, ICall myCall, string logHeader) {',
    '    TransferComponent TransferTo8023MainIVRDay = new TransferComponent("TransferTo8023MainIVRDay", callflow, myCall, logHeader);',
    '    TransferTo8023MainIVRDay.DestinationHandler = () => { return Convert.ToString(8023); };',
    '    TransferTo8023MainIVRDay.DelayMilliseconds = 500;',
    '    TransferComponent TransferTo8057WeekendIVR = new TransferComponent("TransferTo8057WeekendIVR", callflow, myCall, logHeader);',
    '    TransferTo8057WeekendIVR.DestinationHandler = () => { return Convert.ToString(8057); };',
    '  }',
    '}'
  ].join('\n')

  const system: Topology = {
    ...topo,
    receptionists: {
      path: '',
      value: [
        { Number: '8023', Name: 'Main IVR', Id: '20' },
        { Number: '8057', Name: 'Weekend IVR', Id: '21' }
      ]
    },
    callFlowApps: {
      path: '/xapi/v1/CallFlowApps',
      value: [{ Id: 330, Number: '7771', Name: 'onecontact', ScriptCode: cfd }]
    }
  }
  const g = buildTopology(system)
  const rp = g.nodes.find((n) => n.kind === 'routePoint')!
  const out = g.edges.filter((e) => e.source === rp.id)

  it('links the route point to both IVRs the script transfers to', () => {
    const targets = out.map((e) => g.nodes.find((n) => n.id === e.target)!.number).sort()
    expect(targets).toEqual(['8023', '8057'])
  })

  it('labels each link with the branch name from the script', () => {
    const labels = out.flatMap((e) => e.labels).sort()
    expect(labels).toEqual(['transfer: Main IVR Day', 'transfer: Weekend IVR'])
  })

  it('does not treat DelayMilliseconds as a destination', () => {
    expect(g.nodes.some((n) => n.number === '500')).toBe(false)
  })

  it('keeps them as script links, so they can be told from real routing', () => {
    expect(out.every((e) => e.kind === 'script')).toBe(true)
  })
})

describe('route point destinations', () => {
  const g = buildTopology(topo)
  const rp = g.nodes.find((n) => n.raw.Type === 'RoutePoint')

  it('creates a node for the route point', () => {
    expect(rp).toBeTruthy()
    expect(rp!.number).toBe('7771')
  })

  it('names it after the script rather than "Route Point 7771"', () => {
    // The script's name is the only clue to what it does, and it arrives only
    // on the destination — nothing else in the topology mentions it.
    expect(rp!.label).toBe('onecontact (7771)')
    expect(rp!.raw.Name).toBe('onecontact')
  })

  it('links the inbound rule to it', () => {
    const rule = g.nodes.find((n) => n.kind === 'inboundRule')
    expect(rule).toBeTruthy()
    const edge = g.edges.find((e) => e.source === rule!.id && e.target === rp!.id)
    expect(edge).toBeTruthy()
  })

  it('folds the three destinations into one link, labelled per branch', () => {
    // Office hours, out of hours and holidays all point at the same script, so
    // they collapse to a single link carrying all three routes.
    const rule = g.nodes.find((n) => n.kind === 'inboundRule')!
    const edges = g.edges.filter((e) => e.source === rule.id && e.target === rp!.id)
    expect(edges).toHaveLength(1)
    expect(edges[0].labels.length).toBeGreaterThan(1)
  })

  it('is still a terminal node — a script’s internals are not published', () => {
    // Nothing leaves the route point, because 3CX exposes no routing for what
    // the script does next. If that ever changes this test should fail and be
    // rewritten, rather than the dead end being quietly accepted.
    expect(g.edges.filter((e) => e.source === rp!.id)).toHaveLength(0)
  })
})
