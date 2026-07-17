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
  'route' | 'overflow' | 'agent' | 'manager' | 'member' | 'trunk' | 'afterhours' | 'forward'

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
  return bucket === SHARED_DEPARTMENT ? 'Multiple Departments' : bucket
}

/** Live presence of a user extension, derived from its raw 3CX fields. Mirrors
 *  the colour language of the 3CX v20 web client so it reads at a glance:
 *  green available, orange away/other, red DND, grey not registered. */
export type Presence = 'available' | 'away' | 'dnd' | 'offline' | null

export const PRESENCE_META: Record<Exclude<Presence, null>, { label: string; color: string }> = {
  available: { label: 'Available', color: '#22c55e' },
  away: { label: 'Away', color: '#f59e0b' },
  dnd: { label: 'Do Not Disturb', color: '#ef4444' },
  offline: { label: 'Not registered', color: '#94a3b8' }
}

/** True only when a raw flag is explicitly false — an absent field is "unknown"
 *  and must not be treated as a definite state. */
function flagIsFalse(raw: Record<string, unknown>, ...keys: string[]): boolean {
  for (const k of keys) {
    const v = raw[k]
    if (v === false || v === 'false' || v === 0) return true
    if (v === true || v === 'true' || v === 1) return false
  }
  return false
}

/** Classify a user extension's live presence from its raw entity, or null when
 *  there's no signal to show a badge. Not-registered wins over any profile
 *  because the extension can't take a call regardless of its status profile. */
export function presenceOf(raw: Record<string, unknown>): Presence {
  if (flagIsFalse(raw, 'IsRegistered', 'Registered')) return 'offline'
  const profile = String(raw['CurrentProfileName'] ?? '').trim()
  if (!profile) return null
  if (/dnd|do not disturb/i.test(profile)) return 'dnd'
  if (/available/i.test(profile)) return 'available'
  // Away, Lunch, Business Trip, Out of office, custom profiles…
  return 'away'
}

/** Whether a user is logged in to their queues (global 3CX QueueStatus), or null
 *  when the field is absent. */
export function queueLoggedIn(raw: Record<string, unknown>): boolean | null {
  const qs = String(raw['QueueStatus'] ?? '').trim()
  if (!qs) return null
  if (/out/i.test(qs)) return false
  if (/in/i.test(qs)) return true
  return null
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
