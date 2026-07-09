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
  /** Department "bucket" used to group this node in the Department layout —
   *  a single real department name, SHARED_DEPARTMENT, or undefined (floats
   *  free, joins no coloured box). See computeDeptGroups in build.ts. */
  deptGroup?: string
  /** Computed key facts to show in the details panel (e.g. bridge routing). */
  info?: { label: string; value: string }[]
  /** Path after `/#/office/` to deep-link this node in the 3CX console. */
  threecxPath?: string
  /** Original entity JSON (or a small synthesized object for external/unknown). */
  raw: Record<string, unknown>
}

export type EdgeKind =
  'route' | 'overflow' | 'agent' | 'manager' | 'member' | 'trunk' | 'afterhours'

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

/** Bucket for nodes that touch more than one department — grouped together
 *  under a neutral "Shared" box rather than joining any single department's. */
export const SHARED_DEPARTMENT = '__shared__'

const DEPT_PALETTE = [
  '#f59e0b',
  '#10b981',
  '#6366f1',
  '#ec4899',
  '#06b6d4',
  '#84cc16',
  '#f43f5e',
  '#8b5cf6',
  '#eab308',
  '#14b8a6',
  '#f97316'
]

/** Deterministic colour for a department bucket, stable across reloads so the
 *  same department always gets the same box colour. */
export function departmentColor(bucket: string): string {
  if (bucket === SHARED_DEPARTMENT) return '#64748b'
  let hash = 0
  for (let i = 0; i < bucket.length; i++) hash = (hash * 31 + bucket.charCodeAt(i)) >>> 0
  return DEPT_PALETTE[hash % DEPT_PALETTE.length]
}

export function departmentLabel(bucket: string): string {
  return bucket === SHARED_DEPARTMENT ? 'Shared' : bucket
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
