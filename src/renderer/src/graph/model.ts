// The renderer-side graph model the Cytoscape view consumes.

export type NodeKind =
  | 'trunk'
  | 'did'
  | 'inboundRule'
  | 'ivr'
  | 'queue'
  | 'ringGroup'
  | 'user'
  | 'group'
  | 'endpoint'
  | 'bridge'
  | 'system'
  | 'external'
  | 'unknown'

export interface GraphNode {
  id: string
  kind: NodeKind
  label: string
  /** Extension / DID number where the entity has one. */
  number?: string
  /** Department / group names this entity belongs to (shown as badges). */
  departments?: string[]
  /** Computed key facts to show in the details panel (e.g. bridge routing). */
  info?: { label: string; value: string }[]
  /** Path after `/#/office/` to deep-link this node in the 3CX console. */
  threecxPath?: string
  /** Original entity JSON (or a small synthesized object for external/unknown). */
  raw: Record<string, unknown>
}

export type EdgeKind = 'route' | 'overflow' | 'agent' | 'manager' | 'member' | 'trunk'

export interface GraphEdge {
  id: string
  source: string
  target: string
  /** One entry per underlying relationship collapsed into this edge. */
  labels: string[]
  kind: EdgeKind
}

export interface TopologyGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** Unresolved references and other oddities, surfaced in the debug panel. */
  warnings: string[]
}

export const NODE_KIND_META: Record<NodeKind, { label: string; color: string }> = {
  trunk: { label: 'Trunk', color: '#a855f7' },
  did: { label: 'DID', color: '#ec4899' },
  inboundRule: { label: 'Inbound Rule', color: '#f97316' },
  ivr: { label: 'IVR', color: '#eab308' },
  queue: { label: 'Queue', color: '#22c55e' },
  ringGroup: { label: 'Ring Group', color: '#14b8a6' },
  user: { label: 'Extension', color: '#3b82f6' },
  group: { label: 'Department', color: '#64748b' },
  endpoint: { label: 'Other target', color: '#0ea5e9' },
  bridge: { label: 'Bridge', color: '#d946ef' },
  system: { label: 'Remote system', color: '#f59e0b' },
  external: { label: 'External', color: '#94a3b8' },
  unknown: { label: 'Unresolved', color: '#ef4444' }
}
