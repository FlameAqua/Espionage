// Compares two topology graphs and reports what changed between them.
//
// Used to answer "what's different on this system since the last snapshot?" —
// new or removed extensions, renamed entities, re-pointed DIDs, altered IVR keys,
// queue membership changes.
//
// Deliberately ignores LIVE state (registration, presence, queue login). Two
// snapshots taken minutes apart would otherwise be full of noise that says
// nothing about how the system is configured.

import type { EdgeKind, GraphEdge, GraphNode, NodeKind, TopologyGraph } from './model'

export type ChangeKind = 'added' | 'removed' | 'changed'

export interface NodeChange {
  change: ChangeKind
  id: string
  kind: NodeKind
  label: string
  number?: string
  /** Human-readable field changes, e.g. `name: "Sales" → "Sales EU"`. */
  details: string[]
}

export interface EdgeChange {
  change: ChangeKind
  id: string
  kind: EdgeKind
  sourceLabel: string
  targetLabel: string
  details: string[]
}

export interface TopologyDiff {
  nodes: NodeChange[]
  edges: EdgeChange[]
  counts: { added: number; removed: number; changed: number }
  /** True when nothing configuration-related differs. */
  identical: boolean
}

/** A node's display name for the diff report. */
function describe(n: GraphNode): string {
  return n.number ? `${n.label} (${n.number})` : n.label
}

function sortedDepartments(n: GraphNode): string {
  return [...(n.departments ?? [])].sort().join(', ')
}

/** Compare the configuration-bearing fields of one node across snapshots. */
function nodeFieldChanges(before: GraphNode, after: GraphNode): string[] {
  const out: string[] = []
  const cmp = (label: string, a: string | undefined, b: string | undefined): void => {
    const av = a ?? ''
    const bv = b ?? ''
    if (av !== bv) out.push(`${label}: "${av}" → "${bv}"`)
  }
  cmp('name', before.label, after.label)
  cmp('number', before.number, after.number)
  if (before.kind !== after.kind) out.push(`type: ${before.kind} → ${after.kind}`)
  cmp('departments', sortedDepartments(before), sortedDepartments(after))
  return out
}

/** Label an edge endpoint, preferring the newer snapshot's naming. */
function endpointLabel(
  id: string,
  after: Map<string, GraphNode>,
  before: Map<string, GraphNode>
): string {
  const n = after.get(id) ?? before.get(id)
  return n ? describe(n) : id
}

/**
 * Diff two graphs. `before` is the older snapshot, `after` the newer (or live)
 * one, so "added" means present now but not then.
 */
export function diffTopologies(before: TopologyGraph, after: TopologyGraph): TopologyDiff {
  const beforeNodes = new Map(before.nodes.map((n) => [n.id, n]))
  const afterNodes = new Map(after.nodes.map((n) => [n.id, n]))
  const nodes: NodeChange[] = []

  for (const [id, a] of afterNodes) {
    const b = beforeNodes.get(id)
    if (!b) {
      nodes.push({ change: 'added', id, kind: a.kind, label: a.label, number: a.number, details: [] })
      continue
    }
    const details = nodeFieldChanges(b, a)
    if (details.length) {
      nodes.push({ change: 'changed', id, kind: a.kind, label: a.label, number: a.number, details })
    }
  }
  for (const [id, b] of beforeNodes) {
    if (afterNodes.has(id)) continue
    nodes.push({ change: 'removed', id, kind: b.kind, label: b.label, number: b.number, details: [] })
  }

  // Edges are keyed source->target, so a re-pointed route reads as one removal
  // plus one addition — which is what a reader wants to see.
  const beforeEdges = new Map(before.edges.map((e) => [e.id, e]))
  const afterEdges = new Map(after.edges.map((e) => [e.id, e]))
  const edges: EdgeChange[] = []
  const labelsOf = (e: GraphEdge): string => [...e.labels].sort().join(', ')

  const edgeEntry = (e: GraphEdge, change: ChangeKind, details: string[]): EdgeChange => ({
    change,
    id: e.id,
    kind: e.kind,
    sourceLabel: endpointLabel(e.source, afterNodes, beforeNodes),
    targetLabel: endpointLabel(e.target, afterNodes, beforeNodes),
    details
  })

  for (const [id, a] of afterEdges) {
    const b = beforeEdges.get(id)
    if (!b) {
      edges.push(edgeEntry(a, 'added', a.labels.length ? [labelsOf(a)] : []))
      continue
    }
    const bl = labelsOf(b)
    const al = labelsOf(a)
    if (bl !== al) edges.push(edgeEntry(a, 'changed', [`${bl || '—'} → ${al || '—'}`]))
  }
  for (const [id, b] of beforeEdges) {
    if (afterEdges.has(id)) continue
    edges.push(edgeEntry(b, 'removed', b.labels.length ? [labelsOf(b)] : []))
  }

  const all = [...nodes, ...edges]
  const counts = {
    added: all.filter((c) => c.change === 'added').length,
    removed: all.filter((c) => c.change === 'removed').length,
    changed: all.filter((c) => c.change === 'changed').length
  }
  // Stable, readable ordering: grouped by what happened, then by name.
  const order: Record<ChangeKind, number> = { added: 0, removed: 1, changed: 2 }
  nodes.sort((x, y) => order[x.change] - order[y.change] || x.label.localeCompare(y.label))
  edges.sort(
    (x, y) => order[x.change] - order[y.change] || x.sourceLabel.localeCompare(y.sourceLabel)
  )

  return { nodes, edges, counts, identical: !all.length }
}

/** Ids of every node touched by the diff, for highlighting on the canvas. */
export function changedNodeIds(diff: TopologyDiff): string[] {
  const ids = new Set<string>()
  for (const n of diff.nodes) if (n.change !== 'removed') ids.add(n.id)
  // An edge change implicates both of its ends.
  for (const e of diff.edges) {
    const [source, target] = e.id.split('->')
    if (source) ids.add(source)
    if (target) ids.add(target)
  }
  return [...ids]
}
