// Health-check pass over a built TopologyGraph. Surfaces the kinds of problems
// someone auditing an unfamiliar 3CX wants to spot quickly: dead-end rules,
// empty queues, orphaned extensions, unregistered trunks/bridges, disabled
// accounts still in the dial plan. Everything is derived from data already in
// the graph — no extra fetches.

import type { GraphNode, NodeKind, TopologyGraph } from './model'

export interface AuditFinding {
  /** Grouping header shown in the panel. */
  category: string
  /** Human-readable row text. */
  label: string
  /** Node to reveal when the row is clicked (optional). */
  nodeId?: string
  severity: 'warn' | 'info'
}

/** True only when a raw flag is explicitly the boolean/string false — an absent
 *  field means "unknown", which we must not report as a problem. */
function isFalse(raw: Record<string, unknown>, ...keys: string[]): boolean {
  for (const k of keys) {
    const v = raw[k]
    if (v === false || v === 'false' || v === 0) return true
    if (v === true || v === 'true' || v === 1) return false
  }
  return false
}

export function auditTopology(graph: TopologyGraph): AuditFinding[] {
  const findings: AuditFinding[] = []

  // Edge indexes: which kinds of edge leave / enter each node.
  const outKinds = new Map<string, Set<string>>()
  const inKinds = new Map<string, Set<string>>()
  const outCount = new Map<string, number>()
  const add = (m: Map<string, Set<string>>, id: string, kind: string): void => {
    const s = m.get(id)
    if (s) s.add(kind)
    else m.set(id, new Set([kind]))
  }
  for (const e of graph.edges) {
    add(outKinds, e.source, e.kind)
    add(inKinds, e.target, e.kind)
    outCount.set(e.source, (outCount.get(e.source) ?? 0) + 1)
  }

  const label = (n: GraphNode): string => (n.number ? `${n.label} (${n.number})` : n.label)
  const byKind = (k: NodeKind): GraphNode[] => graph.nodes.filter((n) => n.kind === k)

  // 1) Queues / ring groups with no agents or members — calls ring out to no one.
  for (const n of graph.nodes) {
    if (n.kind !== 'queue' && n.kind !== 'ringGroup') continue
    const outs = outKinds.get(n.id)
    const hasMembers = outs?.has('agent') || outs?.has('member')
    if (!hasMembers) {
      findings.push({
        category: 'Queues / ring groups with no members',
        label: label(n),
        nodeId: n.id,
        severity: 'warn'
      })
    }
  }

  // 2) Inbound rules that resolve to no destination — a DID that goes nowhere.
  for (const n of byKind('inboundRule')) {
    if (!outCount.get(n.id)) {
      findings.push({
        category: 'Inbound rules routing nowhere',
        label: label(n),
        nodeId: n.id,
        severity: 'warn'
      })
    }
  }

  // 3) Queues / ring groups / IVRs that nothing routes into — no DID, inbound
  //    rule, IVR key or forward reaches them, so they're unreachable through the
  //    mapped call flow (even if they have agents).
  for (const n of graph.nodes) {
    if (n.kind !== 'queue' && n.kind !== 'ringGroup' && n.kind !== 'ivr') continue
    if (!inKinds.has(n.id)) {
      findings.push({
        category: 'Queues / groups / IVRs nothing routes to',
        label: label(n),
        nodeId: n.id,
        severity: 'warn'
      })
    }
  }

  // 3) Unregistered trunks / bridges — a provider link or PBX bridge that's down.
  for (const n of graph.nodes) {
    if (n.kind !== 'trunk' && n.kind !== 'bridge') continue
    if (isFalse(n.raw, 'IsRegistered', 'Registered')) {
      findings.push({
        category: 'Unregistered trunks / bridges',
        label: label(n),
        nodeId: n.id,
        severity: 'warn'
      })
    }
  }

  // 3b) Route points whose script isn't running. A Call Flow Designer script
  // that failed to compile, or that isn't registered, still accepts the call and
  // still looks like a destination — it just doesn't do anything with it. That
  // is the worst kind of break to find by eye, because the configuration around
  // it is perfectly correct.
  for (const n of byKind('routePoint')) {
    if (n.raw['CompilationSucceeded'] === false || n.raw['InvalidScript'] === true) {
      findings.push({
        category: 'Route points whose script failed to compile',
        label: label(n),
        nodeId: n.id,
        severity: 'warn'
      })
    } else if (isFalse(n.raw, 'IsRegistered', 'Registered')) {
      findings.push({
        category: 'Route points not registered',
        label: label(n),
        nodeId: n.id,
        severity: 'warn'
      })
    }
  }

  // 4) Disabled extensions still present in the dial plan.
  for (const n of byKind('user')) {
    if (isFalse(n.raw, 'Enabled', 'IsEnabled')) {
      findings.push({
        category: 'Disabled extensions',
        label: label(n),
        nodeId: n.id,
        severity: 'info'
      })
    }
  }

  // 5) Fully orphaned extensions: nothing routes to them at all. No incoming edge
  //    of any kind means no DID / inbound rule / IVR / forward points at them AND
  //    they're not an agent or member of any queue or ring group (membership is
  //    modelled as an incoming agent/member edge). They exist but are wired into
  //    nothing — only reachable by dialling the extension directly. Info-level.
  for (const n of byKind('user')) {
    if (!inKinds.has(n.id)) {
      findings.push({
        category: 'Extensions with no DID, not in any queue, and unreferenced',
        label: label(n),
        nodeId: n.id,
        severity: 'info'
      })
    }
  }

  // 6) Unresolved routing targets recorded during the build.
  for (const w of graph.warnings) {
    findings.push({ category: 'Unresolved routes', label: w, severity: 'warn' })
  }

  return findings
}

/** Group findings by category, preserving first-seen order, for panel display. */
export function groupFindings(
  findings: AuditFinding[]
): { category: string; items: AuditFinding[] }[] {
  const order: string[] = []
  const map = new Map<string, AuditFinding[]>()
  for (const f of findings) {
    if (!map.has(f.category)) {
      map.set(f.category, [])
      order.push(f.category)
    }
    map.get(f.category)!.push(f)
  }
  return order.map((category) => ({ category, items: map.get(category)! }))
}
