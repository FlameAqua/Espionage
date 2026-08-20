// Builds a TopologyGraph from the raw 3CX entity collections.
//
// 3CX's xapi destination/forwarding fields vary by version, so resolution is
// deliberately tolerant: nodes are indexed by extension number and by id, and
// routing targets are discovered by scanning destination-shaped sub-objects
// rather than hard-coding one schema. Anything that can't be resolved is kept
// as an "unresolved" node and recorded as a warning so it's visible, not lost.

import { groupRefs, parseCfdTransfers, scanScriptForDns } from './script-refs'
import type { Topology } from '../../../shared/types'
import {
  SHARED_DEPARTMENT,
  agentLoggedIn,
  isRealDepartment,
  type GraphEdge,
  type GraphNode,
  type NodeKind,
  type TopologyGraph
} from './model'

type Obj = Record<string, unknown>

// 3CX destination types that are real targets but aren't fetched as their own
// collection — routed to, but rendered as terminal "endpoint" nodes.
const KNOWN_ENDPOINT_TYPES =
  /fax|conference|voicemail|routepoint|announcement|callflow|parking|sharedparking/i

function prettyType(type: string): string {
  return type
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/RoutePoint/i, 'Route Point')
    .trim()
}

const str = (v: unknown): string => (v == null ? '' : String(v)).trim()
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** First non-empty value among the given keys (case-insensitive). */
function pick(o: Obj, ...keys: string[]): unknown {
  const lower: Record<string, unknown> = {}
  for (const k of Object.keys(o)) lower[k.toLowerCase()] = o[k]
  for (const k of keys) {
    const v = lower[k.toLowerCase()]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}

function displayName(o: Obj): string {
  const dn = str(pick(o, 'DisplayName', 'Name', 'RuleName', 'FriendlyName'))
  if (dn) return dn
  const first = str(pick(o, 'FirstName'))
  const last = str(pick(o, 'LastName'))
  const full = `${first} ${last}`.trim()
  return full
}

class Builder {
  nodes: GraphNode[] = []
  edges: GraphEdge[] = []
  warnings: string[] = []

  private byId = new Map<string, GraphNode>() // id -> node (our composite id)
  private byNumber = new Map<string, GraphNode>() // extension number -> node
  private byEntityId = new Map<string, GraphNode>() // 3CX numeric Id -> node
  private edgeByPair = new Map<string, GraphEdge>() // "source->target" -> collapsed edge

  addNode(kind: NodeKind, key: string, label: string, raw: Obj, number?: string): GraphNode {
    const id = `${kind}:${key}`
    const existing = this.byId.get(id)
    if (existing) return existing
    const node: GraphNode = { id, kind, label: label || id, raw, number }
    this.nodes.push(node)
    this.byId.set(id, node)
    if (number) this.byNumber.set(number, node)
    const eid = str(raw['Id'])
    if (eid) this.byEntityId.set(eid, node)
    return node
  }

  getById(id: string): GraphNode | undefined {
    return this.byId.get(id)
  }

  getByNumber(number: string): GraphNode | undefined {
    return this.byNumber.get(number)
  }

  getByEntityId(id: string): GraphNode | undefined {
    return this.byEntityId.get(id)
  }

  /** Collapse every relationship between the same source→target into one edge,
   *  accumulating the individual labels. Fewer elements = faster layout.
   *  `allowSelf` permits a deliberate self-loop (e.g. an IVR "repeat prompt"). */
  addEdge(
    source: string,
    target: string,
    kind: GraphEdge['kind'],
    label?: string,
    allowSelf = false
  ): GraphEdge | null {
    if (source === target && !allowSelf) return null
    const id = `${source}->${target}`
    let edge = this.edgeByPair.get(id)
    if (!edge) {
      edge = { id, source, target, kind, labels: [] }
      this.edges.push(edge)
      this.edgeByPair.set(id, edge)
    }
    if (label && !edge.labels.includes(label)) edge.labels.push(label)
    return edge
  }

  /** Resolve a destination reference (by number, then id) to an existing node,
   *  or synthesize an external/unresolved node so the route stays visible. */
  resolveTarget(
    ref: { number?: string; id?: string; type?: string; external?: string; name?: string },
    context: string
  ): GraphNode | null {
    if (ref.number) {
      const n = this.byNumber.get(ref.number)
      if (n) return n
    }
    if (ref.id) {
      const n = this.byEntityId.get(ref.id)
      if (n) return n
    }
    const type = (ref.type ?? '').toLowerCase()
    if (ref.external || type.includes('external') || type.includes('outbound')) {
      const key = ref.external || ref.number || 'external'
      return this.addNode('external', key, ref.external || ref.number || 'External', {
        External: ref.external,
        Number: ref.number,
        Type: ref.type
      })
    }
    // Recognised 3CX targets we don't fetch as their own collection (fax,
    // conference, voicemail, call-flow route points, …). These are real
    // destinations, not errors — show them as terminal endpoint nodes.
    if (KNOWN_ENDPOINT_TYPES.test(type) && ref.number) {
      // Prefer what 3CX calls it. A route point is a Call Flow Designer script,
      // and its name ("onecontact") is the only clue to what the script does —
      // "Route Point 7771" says nothing at all.
      const label = ref.name
        ? `${ref.name} (${ref.number})`
        : `${prettyType(ref.type!)} ${ref.number}`.trim()
      // Carries its DN as the node's own number, not just a raw field, so it is
      // findable by extension in search and reachable by number when something
      // else routes to the same DN.
      return this.addNode(
        'endpoint',
        `${type}:${ref.number}`,
        label,
        {
          Number: ref.number,
          Type: ref.type,
          ...(ref.name ? { Name: ref.name } : {})
        },
        ref.number
      )
    }
    // Pure "end call / hangup" style targets aren't worth a node.
    if (!ref.number && !ref.id) return null
    const key = ref.number || ref.id || 'unknown'
    this.warnings.push(
      `Unresolved route target "${key}"${ref.type ? ` (type ${ref.type})` : ''} from ${context}.`
    )
    return this.addNode('unknown', key, ref.number ? `#${ref.number}` : key, {
      Number: ref.number,
      Id: ref.id,
      Type: ref.type
    })
  }

  build(): TopologyGraph {
    return { nodes: this.nodes, edges: this.edges, warnings: this.warnings }
  }
}

/** Detect & normalise a destination-shaped object into a target reference. */
function asDestRef(
  v: unknown
): { number?: string; id?: string; type?: string; external?: string; name?: string } | null {
  if (!isObj(v)) return null
  // Newer xapi nests the real target under a Peer/Destination object.
  const peer = v['Peer'] ?? v['Destination'] ?? v['To']
  if (isObj(peer)) {
    const inner = asDestRef(peer)
    if (inner) {
      const external = str(pick(v, 'External', 'ExternalNumber'))
      if (external && !inner.external) inner.external = external
      const outerName = str(pick(v, 'Name'))
      if (outerName && !inner.name) inner.name = outerName
      return inner
    }
  }
  // 3CX "forward record" shape (IVR digit menu, blind transfers, …): the
  // destination DN lives in ForwardDN, and the entry's own `Id` is a
  // record id in a different namespace — treating it as a destination id
  // resolves to an unrelated entity that merely shares that number (e.g. an
  // IVR key 1 → ForwardDN 8002 with record Id 107 wrongly matching queue Id
  // 107). So read ForwardDN for the number and drop the record Id.
  const forwardDN = str(pick(v, 'ForwardDN'))
  const isForwardRecord = forwardDN !== '' || v['ForwardType'] !== undefined
  const number = str(pick(v, 'Number', 'Extension', 'DialNumber')) || forwardDN
  const id = isForwardRecord ? '' : str(pick(v, 'Id', 'PeerId', 'DestinationId'))
  const type = str(pick(v, 'Type', 'To', 'PeerType', 'DestinationType', 'ForwardType'))
  const external = str(pick(v, 'External', 'ExternalNumber'))
  // 3CX names the destination inline for targets it doesn't publish as a
  // collection of their own — a route point's script name arrives here and
  // nowhere else, so it is the only thing that tells "onecontact" from "7771".
  const name = str(pick(v, 'Name'))
  if (number || external || (id && type)) {
    return {
      number: number || undefined,
      id: id || undefined,
      type: type || undefined,
      external: external || undefined,
      name: name || undefined
    }
  }
  return null
}

const DEST_KEY_RE =
  /dest|forward|route|overflow|noanswer|no_answer|busy|timeout|fwd|fail|target|menu|prompt|option|office|holiday|invalid/i

/** Collect routing edges from any destination-shaped fields on an entity. */
function collectRoutes(b: Builder, sourceId: string, entity: Obj, contextLabel: string): void {
  for (const [key, value] of Object.entries(entity)) {
    if (!DEST_KEY_RE.test(key)) continue
    routeFromValue(b, sourceId, key, value, contextLabel)
  }
}

function routeFromValue(
  b: Builder,
  sourceId: string,
  key: string,
  value: unknown,
  contextLabel: string
): void {
  if (Array.isArray(value)) {
    for (const el of value) {
      if (!isObj(el)) continue
      // IVR-menu style: element carries its own DTMF label + a destination.
      const input = str(pick(el, 'Input', 'Digit', 'Digits', 'Key', 'Dtmf', 'DtmfDigit', 'Number'))
      const ref = asDestRef(el) ?? firstNestedDest(el)
      if (ref) {
        const target = b.resolveTarget(ref, contextLabel)
        // "key N" alone is misleading — it doesn't say whether the option drops
        // to voicemail, rings a group, hits another IVR, etc. Append what the
        // option actually does (from its ForwardType/PeerType) so the arrow's
        // meaning is explicit rather than implying a plain call to the target.
        const base = input ? `key ${input}` : prettyKey(key)
        const dest = describeDest(el)
        if (target) b.addEdge(sourceId, target.id, 'route', dest ? `${base} → ${dest}` : base)
      }
    }
    return
  }
  if (isObj(value)) {
    const ref = asDestRef(value)
    if (ref) {
      const target = b.resolveTarget(ref, contextLabel)
      if (target) {
        const base = prettyKey(key)
        b.addEdge(
          sourceId,
          target.id,
          routeKind(key),
          isVoicemail(value) ? `${base}: voicemail` : base
        )
      }
    } else {
      // Nested wrapper (e.g. OfficeRoute: { Forward: {...} }) — scan one level in.
      for (const [k2, v2] of Object.entries(value)) {
        if (DEST_KEY_RE.test(k2) || asDestRef(v2))
          routeFromValue(b, sourceId, `${key} ${k2}`, v2, contextLabel)
      }
    }
  }
}

function firstNestedDest(o: Obj): ReturnType<typeof asDestRef> {
  for (const v of Object.values(o)) {
    const ref = asDestRef(v)
    if (ref) return ref
  }
  return null
}

/** Whether a destination-shaped object routes to voicemail — checked on the
 *  object itself and its immediate Route/Peer/Destination wrapper, since 3CX
 *  flags it via a "VoiceMail" To/Type (e.g. OutOfOfficeRoute.Route.To). */
function isVoicemail(o: Obj): boolean {
  const vm = (x: unknown): boolean =>
    isObj(x) &&
    /voicemail/i.test(str(pick(x, 'To', 'Type', 'DestinationType', 'PeerType', 'ForwardType')))
  return vm(o) || vm(o['Route']) || vm(o['Peer']) || vm(o['Destination'])
}

/** Human descriptor of what a destination-shaped option actually does, from its
 *  type fields (checked on the object and its Route/Peer/Destination wrapper).
 *  Used to enrich IVR "key N" labels so voicemail / ring-group / queue / IVR
 *  hops read explicitly instead of looking like a plain call to the target.
 *  Returns null for a bare extension/DN forward — the target node already says
 *  it's an extension, so there's nothing to add. */
function describeDest(o: Obj): string | null {
  const typeOf = (x: unknown): string =>
    isObj(x) ? str(pick(x, 'To', 'Type', 'DestinationType', 'PeerType', 'ForwardType')) : ''
  const t = (typeOf(o) || typeOf(o['Route']) || typeOf(o['Peer']) || typeOf(o['Destination']))
    .toLowerCase()
    .replace(/\s+/g, '')
  if (!t) return null
  if (t.includes('voicemail')) return 'voicemail'
  if (t.includes('ringgroup')) return 'ring group'
  if (t.includes('queue')) return 'queue'
  if (t.includes('ivr') || t.includes('receptionist')) return 'IVR'
  if (t.includes('conference')) return 'conference'
  if (t.includes('announcement')) return 'announcement'
  if (t.includes('fax')) return 'fax'
  if (t.includes('parking')) return 'parking'
  if (t.includes('callflow') || t.includes('routepoint')) return 'call flow'
  if (t.includes('external') || t.includes('outbound')) return 'external'
  // Plain extension / DN forwards — no extra descriptor needed.
  if (t === 'extension' || t === 'dn' || t === 'internal' || t === 'proceedwithnoexceptions')
    return null
  return null
}

/** DID number → owning trunk's 3CX entity Id, from each trunk's DidNumbers list.
 *  A trunk typically owns a long block of numbers, so this is how an inbound rule
 *  is tied back to the line it actually arrives on when the rule itself doesn't
 *  name a TrunkId. */
function didToTrunkMap(topo: Topology): Map<string, string> {
  const map = new Map<string, string>()
  for (const t of topo.trunks.value as Obj[]) {
    const tid = str(pick(t, 'Id'))
    const dids = t['DidNumbers']
    if (tid && Array.isArray(dids)) for (const d of dids) if (str(d)) map.set(str(d), tid)
  }
  return map
}

/** Compute the 3CX management-console deep-link path for each node. Inbound
 *  rules live under their owning trunk (matched by DID → trunk DidNumbers). */
function setThreecxPaths(b: Builder, topo: Topology): void {
  const didToTrunk = didToTrunkMap(topo)
  for (const node of b.nodes) {
    const id = str(node.raw['Id'])
    switch (node.kind) {
      case 'user':
        if (id) node.threecxPath = `users/edit/${id}`
        break
      case 'queue':
        if (id) node.threecxPath = `call-handling/queue/${id}`
        break
      case 'ringGroup':
        if (id) node.threecxPath = `call-handling/ring-group/${id}`
        break
      case 'ivr':
        if (id) node.threecxPath = `call-handling/digital-receptionist/${id}`
        break
      case 'trunk':
        if (id) node.threecxPath = `voice-and-chat/trunk/edit/${id}`
        break
      case 'bridge':
        if (id) node.threecxPath = `voice-and-chat/bridge/edit/${id}`
        break
      case 'inboundRule': {
        const did = str(pick(node.raw, 'Data', 'DID', 'Did', 'DidNumber', 'Number')).split(
          /[,\s;]+/
        )[0]
        const tid = did ? didToTrunk.get(did) : undefined
        if (tid) node.threecxPath = `voice-and-chat/trunk/edit/${tid}`
        break
      }
    }
  }
}

/** Record, on each bridge / trunk node, the outbound-rule prefixes routed across
 *  it (i.e. which dialled patterns leave the system down that line). Outbound
 *  rules aren't nodes of their own — as a flat list of dial patterns they'd bury
 *  the call flow — so they're summarised on the line they use. */
function attachOutboundRules(b: Builder, topo: Topology): void {
  for (const rule of (topo.outboundRules?.value ?? []) as Obj[]) {
    const prefix = str(pick(rule, 'Prefix'))
    const name = str(pick(rule, 'Name'))
    const routes = rule['Routes']
    if (!Array.isArray(routes)) continue
    const seen = new Set<string>()
    for (const r of routes) {
      if (!isObj(r)) continue
      const tid = str(pick(r, 'TrunkId'))
      if (!tid || tid === '-1' || seen.has(tid)) continue
      seen.add(tid)
      const node = b.getById(`bridge:${tid}`) ?? b.getById(`trunk:${tid}`)
      if (!node) continue
      const value = prefix ? `${prefix}${name ? ` — ${name}` : ''}` : name
      if (value) (node.outboundRules ??= []).push(value)
      // Label the bridge → remote-system edge with the sent prefixes.
      const host = str(pick(node.raw, 'RemoteMyPhoneUriHost'))
      if (host && prefix) b.addEdge(node.id, `system:${host}`, 'trunk', prefix)
    }
  }
}

/** The trunk / bridge an inbound rule belongs to. 3CX names it directly on the
 *  rule most of the time, but not always — falling back to the trunk that owns
 *  the rule's DID is what keeps a trunk from floating unconnected. */
function trunkForRule(b: Builder, rule: Obj, didToTrunk: Map<string, string>): GraphNode | null {
  const byEntity = (id: string): GraphNode | undefined =>
    b.getById(`trunk:${id}`) ?? b.getById(`bridge:${id}`)
  const trunkId = str(pick(rule, 'TrunkId', 'GatewayId'))
  if (trunkId) {
    const n = byEntity(trunkId)
    if (n) return n
  }
  const trunkNumber = str(pick(rule, 'TrunkDN', 'TrunkNumber'))
  if (trunkNumber) {
    const n = b.getByNumber(trunkNumber)
    if (n && (n.kind === 'trunk' || n.kind === 'bridge')) return n
  }
  // Last resort: whichever trunk lists this rule's DID among its numbers.
  for (const did of ruleDidList(rule)) {
    const tid = didToTrunk.get(did)
    const n = tid ? byEntity(tid) : undefined
    if (n) return n
  }
  return null
}

/** 3CX's own key names for a trunk's default destinations, mapped to labels that
 *  read the way the console words them. The mapped name is fed back through the
 *  normal route pipeline, so `routeKind` still classifies out-of-hours and
 *  holiday branches as `afterhours` (dashed) from the mapped name alone. */
const TRUNK_ROUTE_KEYS: [RegExp, string][] = [
  [/^outofoffice|^nonbusiness|^afterhours/i, 'OutOfOfficeHoursDestination'],
  [/^holiday/i, 'HolidayDestination'],
  [/^specifictime|^breaktime/i, 'SpecificHoursDestination'],
  [/^office/i, 'OfficeHoursDestination']
]

/** Draw a trunk's OWN default routing.
 *
 *  3CX models "where do unmatched calls on this line go?" as a hidden inbound
 *  rule with Condition `ForwardAll` — it never appears in the portal's Inbound
 *  Rules list (it's edited on the trunk's page), so it's skipped as a node. But
 *  skipping it outright left every trunk as an island: the default destination a
 *  trunk points at is exactly what makes it part of the call flow. So the rule's
 *  destinations are attached to the TRUNK node instead of a node of their own. */
function attachTrunkDefaultRoutes(
  b: Builder,
  topo: Topology,
  didToTrunk: Map<string, string>
): void {
  for (const rule of topo.inboundRules.value as Obj[]) {
    if (!isTrunkDefaultRule(rule)) continue
    const trunk = trunkForRule(b, rule, didToTrunk)
    if (!trunk) continue
    const context = `trunk "${trunk.label}" default route`
    for (const [key, value] of Object.entries(rule)) {
      if (!DEST_KEY_RE.test(key)) continue
      const mapped = TRUNK_ROUTE_KEYS.find(([re]) => re.test(key))?.[1] ?? key
      routeFromValue(b, trunk.id, mapped, value, context)
    }
    collectDnForwards(b, trunk.id, rule, context)
  }
}

/** Summarise the line itself in the details panel: how many numbers it carries,
 *  its main/presented number, and where it terminates. Every number the trunk
 *  answers on also becomes searchable, so typing a DID finds the line carrying
 *  it — they'd otherwise be invisible (a trunk's `number` is its internal DN). */
function attachTrunkInfo(raw: Obj, node: GraphNode): void {
  const info: { label: string; value: string }[] = []
  const terms: { label: string; value: string }[] = []
  const external = str(pick(raw, 'ExternalNumber'))
  if (external) {
    info.push({ label: 'Main number', value: external })
    terms.push({ label: 'Main number', value: external })
  }
  const callerId = str(pick(raw, 'OutboundCallerID'))
  if (callerId && callerId !== external) {
    info.push({ label: 'Outbound caller ID', value: callerId })
    terms.push({ label: 'Caller ID', value: callerId })
  }
  const dids = raw['DidNumbers']
  if (Array.isArray(dids) && dids.length) {
    info.push({ label: 'DID numbers', value: `${dids.length}` })
    for (const d of dids) if (str(d)) terms.push({ label: 'DID', value: str(d) })
  }
  const direction = str(pick(raw, 'Direction'))
  if (direction) info.push({ label: 'Direction', value: direction })
  const gw = isObj(raw['Gateway']) ? (raw['Gateway'] as Obj) : {}
  const host = str(pick(gw, 'Host'))
  if (host) {
    const port = str(pick(gw, 'Port'))
    info.push({ label: 'Host', value: port ? `${host}:${port}` : host })
    terms.push({ label: 'Host', value: host })
  }
  if (info.length) node.info = [...(node.info ?? []), ...info]
  if (terms.length) node.searchTerms = [...(node.searchTerms ?? []), ...terms]
}

/** DID number → the friendly name it's given in 3CX's DID list ("Oscar
 *  Traynor"). That name is the one a human actually knows the number by, but it
 *  lives on the DidNumbers collection rather than on the inbound rule that
 *  answers it — so without this the name is unsearchable and unshown. */
function didNameMap(topo: Topology): Map<string, string> {
  const map = new Map<string, string>()
  for (const d of topo.didNumbers.value as Obj[]) {
    const num = str(pick(d, 'Number', 'DidNumber', 'DID', 'Did'))
    const name = str(pick(d, 'Name', 'DisplayName', 'Description', 'FriendlyName'))
    if (num && name) map.set(num, name)
  }
  return map
}

/** Make an inbound rule findable by every DID it answers and by those DIDs'
 *  friendly names, and — when 3CX left the rule unnamed — label it with the DID
 *  name rather than a meaningless "DID Rule". */
function attachRuleDids(node: GraphNode, rule: Obj, didNames: Map<string, string>): void {
  const dids = ruleDidList(rule)
  if (!dids.length) return
  const terms: { label: string; value: string }[] = []
  const names: string[] = []
  for (const did of dids) {
    terms.push({ label: 'DID', value: did })
    const name = didNames.get(did)
    if (name && !names.includes(name)) names.push(name)
  }
  for (const name of names) terms.push({ label: 'DID name', value: name })
  node.searchTerms = [...(node.searchTerms ?? []), ...terms]
  if (names.length) {
    node.info = [
      ...(node.info ?? []),
      { label: names.length > 1 ? 'DID names' : 'DID name', value: names.join(', ') }
    ]
    // A rule 3CX never named reads far better as the number's own name.
    if (!displayName(rule)) node.label = names[0]
  }
}

function prettyKey(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
    .trim()
}

/** Classify a routing edge from the source field name: out-of-hours / holiday
 *  destinations render distinctly (dashed) so the graph doesn't imply calls
 *  always take the business-hours path. Failure branches stay "overflow". */
function routeKind(key: string): GraphEdge['kind'] {
  if (/outofoffice|out_of_office|afterhours|after_hours|nonbusiness|holiday|breaktime/i.test(key))
    return 'afterhours'
  if (/overflow|noanswer|no_answer|busy|timeout|fail/i.test(key)) return 'overflow'
  return 'route'
}

export function buildTopology(topo: Topology): TopologyGraph {
  const b = new Builder()

  // --- Pass 1: create nodes for everything addressable so routes can resolve.
  for (const raw of topo.users.value as Obj[]) {
    const number = str(pick(raw, 'Number', 'Extension'))
    if (!number) continue
    const node = b.addNode('user', number, displayName(raw) || `#${number}`, raw, number)
    // People get looked up by the contact detail the searcher happens to have —
    // including the number their calls present, which is often all you have when
    // working back from a call log or a missed-call complaint.
    for (const [label, ...keys] of [
      ['Email', 'Email', 'EmailAddress'],
      ['Mobile', 'Mobile', 'MobileNumber'],
      ['Outbound caller ID', 'OutboundCallerID', 'OutboundCallerId', 'OutboundCallerNumber']
    ] as string[][]) {
      const value = str(pick(raw, ...keys))
      if (value) (node.searchTerms ??= []).push({ label, value })
    }
  }
  for (const raw of topo.queues.value as Obj[]) {
    const number = str(pick(raw, 'Number'))
    b.addNode(
      'queue',
      number || str(pick(raw, 'Id')),
      displayName(raw) || `Queue ${number}`,
      raw,
      number || undefined
    )
  }
  for (const raw of topo.ringGroups.value as Obj[]) {
    const number = str(pick(raw, 'Number'))
    b.addNode(
      'ringGroup',
      number || str(pick(raw, 'Id')),
      displayName(raw) || `Ring Group ${number}`,
      raw,
      number || undefined
    )
  }
  for (const raw of topo.receptionists.value as Obj[]) {
    const number = str(pick(raw, 'Number'))
    b.addNode(
      'ivr',
      number || str(pick(raw, 'Id')),
      displayName(raw) || `IVR ${number}`,
      raw,
      number || undefined
    )
  }
  // Route points. A Call Flow Designer script decides where a call goes at
  // runtime, so nothing here can say what it does next — but a call arriving at
  // one is no longer arriving at a bare number, and whether the script actually
  // compiled and registered is the difference between a working call flow and a
  // silent dead end.
  for (const raw of (topo.callFlowApps?.value ?? []) as Obj[]) {
    const number = str(pick(raw, 'Number'))
    const node = b.addNode(
      'routePoint',
      number || str(pick(raw, 'Id')),
      displayName(raw) || `Route Point ${number}`,
      raw,
      number || undefined
    )
    const info: { label: string; value: string }[] = []
    const compiled = raw['CompilationSucceeded']
    const invalid = raw['InvalidScript']
    if (compiled === false || invalid === true)
      info.push({ label: 'Script', value: 'Failed to compile' })
    else if (compiled === true) info.push({ label: 'Script', value: 'Compiled' })
    const lastOk = str(pick(raw, 'CompilationLastSuccess'))
    if (lastOk) info.push({ label: 'Last built', value: lastOk })
    const routing = str(pick(raw, 'RoutingType'))
    if (routing) info.push({ label: 'Reached by', value: prettyType(routing) })
    if (info.length) node.info = info
  }
  for (const raw of topo.trunks.value as Obj[]) {
    const id = str(pick(raw, 'Id'))
    const number = str(pick(raw, 'Number'))
    const gw = isObj(raw['Gateway']) ? (raw['Gateway'] as Obj) : {}
    // The trunk's real name lives on the Gateway (there's no top-level Name).
    const name =
      str(pick(gw, 'Name')) || displayName(raw) || str(pick(raw, 'ProviderName')) || `Trunk ${id}`
    const remoteHost = str(pick(raw, 'RemoteMyPhoneUriHost'))
    const gwType = str(pick(gw, 'Type'))
    // A real cross-PBX bridge is a Bridge* gateway that names a remote 3CX host
    // (this excludes the internal "WebMeeting bridge").
    if (/bridge/i.test(gwType) && remoteHost) {
      const node = b.addNode('bridge', id || number, name, raw, number || undefined)
      node.info = [
        {
          label: 'Role',
          value: /master/i.test(gwType) ? 'Master' : /slave/i.test(gwType) ? 'Slave' : gwType
        },
        { label: 'Remote system', value: remoteHost }
      ]
      const prefix = str(pick(raw, 'RemotePBXPreffix'))
      if (prefix) node.info.push({ label: 'Remote prefix', value: prefix })
      // Draw the bridge going off to the remote PBX so it's not floating alone.
      const sys = b.addNode('system', remoteHost, remoteHost, { Host: remoteHost })
      b.addEdge(node.id, sys.id, 'trunk')
    } else {
      attachTrunkInfo(raw, b.addNode('trunk', id || number, name, raw, number || undefined))
    }
  }
  const didNames = didNameMap(topo)
  for (const raw of topo.inboundRules.value as Obj[]) {
    if (isTrunkDefaultRule(raw)) continue
    const id = str(pick(raw, 'Id'))
    // Show the dialled number (DID) on the rule itself — DIDs aren't their own
    // nodes; the Inbound Rule is what routing hangs off.
    const did = ruleDid(raw)
    const node = b.addNode('inboundRule', id || displayName(raw), ruleName(raw, id), raw, did)
    attachRuleDids(node, raw, didNames)
  }

  // Departments become badges on their members, not nodes on the canvas.
  attachDepartments(b, topo)
  // Outbound rules tell us which number ranges each line sends out.
  attachOutboundRules(b, topo)
  // Deep-link paths for the "Open in 3CX" action.
  setThreecxPaths(b, topo)
  // Which trunk owns which DID — needed to tie inbound rules (and the trunks'
  // own default destinations, below) back to the line calls arrive on.
  const didToTrunk = didToTrunkMap(topo)
  // A trunk's own "route unmatched calls to…" destinations, which 3CX hides
  // inside a ForwardAll inbound rule.
  attachTrunkDefaultRoutes(b, topo, didToTrunk)

  // --- Pass 2: membership edges (explicit, well-known shapes).
  for (const raw of topo.queues.value as Obj[]) {
    const number = str(pick(raw, 'Number'))
    const self = `queue:${number || str(pick(raw, 'Id'))}`
    addMembers(b, self, raw, ['Agents'], 'agent')
    addMembers(b, self, raw, ['Managers'], 'manager')
  }
  for (const raw of topo.ringGroups.value as Obj[]) {
    const number = str(pick(raw, 'Number'))
    const self = `ringGroup:${number || str(pick(raw, 'Id'))}`
    addMembers(b, self, raw, ['Members', 'Agents'], 'member')
  }

  // --- Pass 3: routing edges (tolerant destination scan).
  for (const raw of topo.inboundRules.value as Obj[]) {
    if (isTrunkDefaultRule(raw)) continue
    const id = str(pick(raw, 'Id'))
    const self = `inboundRule:${id || displayName(raw)}`
    collectRoutes(b, self, raw, `inbound rule "${displayName(raw) || id}"`)
    linkRuleTrunk(b, self, raw, didToTrunk)
  }
  for (const raw of topo.receptionists.value as Obj[]) {
    const number = str(pick(raw, 'Number'))
    const self = `ivr:${number || str(pick(raw, 'Id'))}`
    collectRoutes(b, self, raw, `IVR "${displayName(raw) || number}"`)
    collectDnForwards(b, self, raw, `IVR "${displayName(raw) || number}"`)
  }
  for (const raw of topo.queues.value as Obj[]) {
    const number = str(pick(raw, 'Number'))
    const self = `queue:${number || str(pick(raw, 'Id'))}`
    collectRoutes(b, self, raw, `queue "${displayName(raw) || number}"`)
    collectDnForwards(b, self, raw, `queue "${displayName(raw) || number}"`)
  }
  for (const raw of topo.ringGroups.value as Obj[]) {
    const number = str(pick(raw, 'Number'))
    const self = `ringGroup:${number || str(pick(raw, 'Id'))}`
    collectRoutes(b, self, raw, `ring group "${displayName(raw) || number}"`)
    collectDnForwards(b, self, raw, `ring group "${displayName(raw) || number}"`)
  }
  // Extensions: their call-forwarding rules (per status profile) become outgoing
  // links so "when Away → 4412 / Out of office → IVR 8019" is visible.
  for (const raw of topo.users.value as Obj[]) {
    const number = str(pick(raw, 'Number', 'Extension'))
    if (number) collectForwardingProfiles(b, `user:${number}`, number, raw)
  }

  // What each route point's script mentions. Runs after every real node exists,
  // because a mention only counts when the DN belongs to something.
  collectScriptReferences(b, topo)

  // Group nodes into department "buckets" for the Department layout. Needs all
  // edges to exist first, so this runs last.
  computeDeptGroups(b)

  return b.build()
}

/**
 * Link each route point to the DNs its script mentions.
 *
 * These are not routes. A Call Flow Designer script chooses where a call goes
 * while the call is happening, and nothing in the configuration records that —
 * so the closest honest thing is "this script names this extension somewhere".
 * They get their own link kind so they read, and can be hidden, as exactly that;
 * each carries the line it was found on so the reader can judge it.
 */
function collectScriptReferences(b: Builder, topo: Topology): void {
  const apps = (topo.callFlowApps?.value ?? []) as Obj[]
  if (!apps.length) return
  const knownDns = b.nodes.map((n) => n.number).filter((n): n is string => !!n)
  if (!knownDns.length) return

  for (const raw of apps) {
    const script = str(pick(raw, 'ScriptCode'))
    if (!script) continue
    const number = str(pick(raw, 'Number'))
    const self = b.getByNumber(number)
    if (!self) continue
    const refs = scanScriptForDns(script, knownDns, { self: number })
    if (refs.length) self.scriptRefs = refs

    // A CFD transfer component is a destination the script sets on purpose, and
    // it carries the author's own name for the branch. Those take the link and
    // the label; a DN that only appears somewhere is the weaker fallback.
    const transfers = parseCfdTransfers(script)
    const linked = new Set<string>()
    for (const t of transfers) {
      const target = b.getByNumber(t.number)
      if (!target || target.id === self.id) continue
      linked.add(t.number)
      b.addEdge(
        self.id,
        target.id,
        'script',
        t.label ? `transfer: ${t.label}` : `transfer (line ${t.line})`
      )
    }
    for (const { number: dn, refs: hits } of groupRefs(refs)) {
      if (linked.has(dn)) continue
      const target = b.getByNumber(dn)
      if (!target || target.id === self.id) continue
      const where = hits.length === 1 ? `line ${hits[0].line}` : `${hits.length} mentions`
      b.addEdge(self.id, target.id, 'script', `mentioned in script (${where})`)
    }
  }
}

/** Assign each node to a department bucket for the Department layout: its own
 *  department if it has exactly one, SHARED_DEPARTMENT if it has several, or —
 *  for entities that don't carry department data themselves (queues, IVRs,
 *  ring groups, inbound rules, trunks, bridges, endpoints) — a bucket inferred
 *  by propagation from connected neighbours that all agree on one department.
 *  Nodes touching several departments, or with no department signal reaching
 *  them at all, get no bucket and simply float free of any box. */
function computeDeptGroups(b: Builder): void {
  for (const n of b.nodes) {
    if (!n.departments?.length) continue
    n.deptGroup = n.departments.length === 1 ? n.departments[0] : SHARED_DEPARTMENT
  }

  const adjacency = new Map<string, string[]>()
  const link = (a: string, other: string): void => {
    const list = adjacency.get(a)
    if (list) list.push(other)
    else adjacency.set(a, [other])
  }
  for (const e of b.edges) {
    link(e.source, e.target)
    link(e.target, e.source)
  }

  const inferable = new Set<NodeKind>([
    'queue',
    'ringGroup',
    'ivr',
    'inboundRule',
    'trunk',
    'bridge',
    'endpoint'
  ])
  // A few passes let a department propagate across short chains (e.g. Inbound
  // Rule -> IVR -> Queue -> Users), converging once nothing changes.
  for (let pass = 0; pass < 4; pass++) {
    let changed = false
    for (const n of b.nodes) {
      if (n.deptGroup || !inferable.has(n.kind)) continue
      const neighbourDepts = new Set<string>()
      for (const otherId of adjacency.get(n.id) ?? []) {
        const other = b.getById(otherId)
        if (other?.deptGroup && other.deptGroup !== SHARED_DEPARTMENT) {
          neighbourDepts.add(other.deptGroup)
        }
      }
      if (neighbourDepts.size === 1) {
        n.deptGroup = [...neighbourDepts][0]
        // Surface the inferred department in the details panel too — these
        // nodes (queues, IVRs, …) carry no department data of their own.
        n.departments = [n.deptGroup]
        changed = true
      } else if (neighbourDepts.size > 1) {
        n.deptGroup = SHARED_DEPARTMENT
        // Record which departments it's shared between so the details panel can
        // show them instead of appearing to belong to nothing.
        n.departments = [...neighbourDepts].sort()
        changed = true
      }
    }
    if (!changed) break
  }
}

/** Handle 3CX's split "<Prefix>ForwardDN" (target number) + "<Prefix>ForwardType"
 *  (destination type) pairs, e.g. Timeout / InvalidKey / digit-key IVR options. */
function collectDnForwards(b: Builder, sourceId: string, entity: Obj, context: string): void {
  // Gather each "<Prefix>Forward…" group (Timeout, InvalidKey, NoAnswer, Busy …)
  // from its ForwardDN (destination number) + ForwardType (what happens).
  const prefixes = new Set<string>()
  for (const key of Object.keys(entity)) {
    const m = /^(.*)Forward(?:DN|Type)$/.exec(key)
    if (m) prefixes.add(m[1])
  }
  for (const prefix of prefixes) {
    const type = str(entity[`${prefix}ForwardType`])
    const number = str(entity[`${prefix}ForwardDN`])
    const label = forwardLabel(prefix)
    // "Repeat prompt" replays the menu — draw it as a loop-back on the node.
    if (/repeat/i.test(type)) {
      b.addEdge(sourceId, sourceId, routeKind(prefix), `${label}: repeat`, true)
      continue
    }
    // Terminal outcomes with no onward node.
    if (/^(?:endcall|hangup|none|disconnect|proceedwithnoexceptions)$/i.test(type)) continue
    if (!number) continue
    // Voicemail still targets the extension's DN, but we flag it in the label so
    // the link reads "… : voicemail" rather than implying a normal call.
    const voicemail = /voicemail/i.test(type)
    const target = b.resolveTarget(
      { number, type: voicemail ? 'Extension' : type || undefined },
      context
    )
    if (target) {
      b.addEdge(sourceId, target.id, routeKind(prefix), voicemail ? `${label}: voicemail` : label)
    }
  }
}

/** Human label for a "<Prefix>Forward…" branch. */
function forwardLabel(prefix: string): string {
  switch (prefix.toLowerCase()) {
    case '':
      return 'forward'
    case 'timeout':
      return 'timeout'
    case 'invalidkey':
      return 'invalid key'
    case 'noanswer':
      return 'no answer'
    case 'busy':
      return 'busy'
    default:
      return prettyKey(prefix)
  }
}

function addMembers(
  b: Builder,
  sourceId: string,
  entity: Obj,
  keys: string[],
  kind: GraphEdge['kind']
): void {
  for (const key of keys) {
    const arr = entity[key]
    if (!Array.isArray(arr)) continue
    for (const m of arr) {
      if (!isObj(m)) continue
      const ref = asDestRef(m) ?? {
        number: str(pick(m, 'Number', 'Extension')) || undefined,
        id: str(pick(m, 'Id')) || undefined
      }
      const target = b.resolveTarget(ref, `${sourceId} ${key}`)
      if (!target) continue
      // 3CX v20 can log an agent out of one queue but not another, so the login
      // state is read per agent entry and recorded on this queue's own link —
      // labelling logged-out agents so it's visible on the canvas too.
      const perQueue = kind === 'agent' ? agentLoggedIn(m) : null
      const label = perQueue === false ? 'agent (logged out)' : kind
      const edge = b.addEdge(sourceId, target.id, kind, label)
      if (edge && perQueue !== null) edge.agentLoggedIn = perQueue
    }
  }
}

function linkRuleTrunk(
  b: Builder,
  ruleId: string,
  rule: Obj,
  didToTrunk: Map<string, string>
): void {
  const trunk = trunkForRule(b, rule, didToTrunk)
  if (trunk) b.addEdge(trunk.id, ruleId, 'trunk', 'inbound')
}

/** 3CX creates a blank-named `ForwardAll` "rule" per trunk to route unmatched
 *  inbound calls — it's configured on the trunk's own page and never appears as
 *  a row in the portal's Inbound Rules list, so we skip it as noise. Real rules
 *  match on DID/CallerID (BasedOnDID etc.). */
function isTrunkDefaultRule(rule: Obj): boolean {
  return /^forwardall$/i.test(str(pick(rule, 'Condition')))
}

/** Draw an extension's call-forwarding rules (per status profile) as outgoing
 *  edges. Each profile carries either an AwayRoute (forwards ALL calls to one
 *  Internal/External destination) or an AvailableRoute (per-condition: No Answer
 *  / Busy / Not Registered × Internal/External). We label each edge by the
 *  profile (+ condition) and skip "None" and the extension's own voicemail. */
function collectForwardingProfiles(
  b: Builder,
  sourceId: string,
  selfNumber: string,
  entity: Obj
): void {
  const profiles = entity['ForwardingProfiles']
  if (!Array.isArray(profiles)) return
  const context = `extension ${selfNumber} forwarding`
  for (const p of profiles) {
    if (!isObj(p)) continue
    const name = str(pick(p, 'CustomName')) || str(pick(p, 'Name')) || 'forward'
    const away = p['AwayRoute']
    if (isObj(away)) {
      // AllHours Internal/External usually mirror each other — the edge collapse
      // dedupes them into one link with one label.
      forwardEdge(b, sourceId, selfNumber, away['Internal'], name, context)
      forwardEdge(b, sourceId, selfNumber, away['External'], name, context)
    }
    const avail = p['AvailableRoute']
    if (isObj(avail)) {
      const conds: [string, string][] = [
        ['NoAnswerInternal', 'no answer'],
        ['NoAnswerExternal', 'no answer'],
        ['BusyInternal', 'busy'],
        ['BusyExternal', 'busy'],
        ['NotRegisteredInternal', 'not registered'],
        ['NotRegisteredExternal', 'not registered']
      ]
      for (const [key, cond] of conds) {
        forwardEdge(b, sourceId, selfNumber, avail[key], `${name}: ${cond}`, context)
      }
    }
  }
}

/** Resolve one forwarding destination and add a "forward" edge, unless it's a
 *  no-op (To: None) or the extension's own voicemail (the default fallback). */
function forwardEdge(
  b: Builder,
  sourceId: string,
  selfNumber: string,
  dest: unknown,
  label: string,
  context: string
): void {
  if (!isObj(dest)) return
  const to = str(pick(dest, 'To'))
  if (!to || /^none$/i.test(to)) return
  const number = str(pick(dest, 'Number'))
  const external = str(pick(dest, 'External'))
  const voicemail = /voicemail/i.test(to)
  if (voicemail && number === selfNumber) return // own mailbox — not a routing link
  const target = b.resolveTarget(
    { number: number || undefined, type: to || undefined, external: external || undefined },
    context
  )
  if (!target) return
  b.addEdge(sourceId, target.id, 'forward', voicemail ? `${label}: voicemail` : label)
}

/** A human name for an inbound rule. 3CX often leaves rules unnamed, so fall
 *  back to what the rule actually matches on (its Condition) rather than an
 *  opaque "Rule 42". */
function ruleName(raw: Obj, id: string): string {
  const name = displayName(raw)
  if (name) return name
  const cond = str(pick(raw, 'Condition')).toLowerCase()
  if (cond.includes('callerid')) return 'Caller ID Rule'
  if (cond.includes('did')) return 'DID Rule'
  return id ? `Rule ${id}` : 'Inbound Rule'
}

/** Every dialled number an inbound rule matches on, in the order 3CX reports
 *  them. Used both for the rule's own label and to find the trunk that owns it. */
function ruleDidList(rule: Obj): string[] {
  const split = (s: string): string[] => s.split(/[,\s;]+/).filter(Boolean)
  const cond = str(pick(rule, 'Condition'))
  const data = str(pick(rule, 'Data'))
  if (data && /did/i.test(cond)) return split(data)
  const direct = str(pick(rule, 'DID', 'Did', 'DidNumber', 'Number'))
  if (direct) return split(direct)
  const list = rule['DIDs'] ?? rule['DidNumbers'] ?? rule['Dids']
  if (Array.isArray(list) && list.length) {
    const nums = list
      .map((d) => (isObj(d) ? str(pick(d, 'Number', 'DidNumber', 'DID', 'Did')) : str(d)))
      .filter(Boolean)
    if (nums.length) return nums
  }
  return data ? split(data) : []
}

/** The dialled number(s) an inbound rule matches, shown on the rule node.
 *  3CX keeps the DID in `Data` when Condition is BasedOnDID. */
function ruleDid(rule: Obj): string | undefined {
  const nums = ruleDidList(rule)
  if (!nums.length) return undefined
  return nums.length > 1 ? `${nums[0]} +${nums.length - 1}` : nums[0]
}

/** Attach department (group) names to the user nodes that belong to them. */
function attachDepartments(b: Builder, topo: Topology): void {
  const add = (num: string, dept: string): void => {
    const node = b.getByNumber(num)
    if (!node) return
    node.departments ??= []
    if (!node.departments.includes(dept)) node.departments.push(dept)
  }
  const isReal = isRealDepartment
  // From each group's member list.
  for (const raw of topo.groups.value as Obj[]) {
    const dept = displayName(raw)
    if (!isReal(dept)) continue
    const members = raw['Members'] ?? raw['Users']
    if (!Array.isArray(members)) continue
    for (const m of members) {
      const num = isObj(m) ? str(pick(m, 'Number', 'Extension')) : str(m)
      if (num) add(num, dept)
    }
  }
  // From each user's own expanded Groups (Name holds the department).
  for (const raw of topo.users.value as Obj[]) {
    const num = str(pick(raw, 'Number', 'Extension'))
    const groups = raw['Groups']
    if (!num || !Array.isArray(groups)) continue
    for (const g of groups) {
      const dept = isObj(g) ? str(pick(g, 'Name')) : str(g)
      if (isReal(dept)) add(num, dept)
    }
  }
}
