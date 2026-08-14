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
  /** Outbound dial-plan rules that leave the system down this line, as
   *  "prefix — name" strings. A busy trunk carries dozens, so the details panel
   *  collapses these into their own section instead of listing them as facts. */
  outboundRules?: string[]
  /** Extra text this node can be found by, beyond its name and number: the DIDs
   *  an inbound rule answers, every number a trunk carries, an extension's email.
   *  Each entry keeps its label so a search hit can say WHY it matched
   *  ("DID 35318899103") rather than appearing to match nothing at all. */
  searchTerms?: { label: string; value: string }[]
  /** Path after `/#/office/` to deep-link this node in the 3CX console. */
  threecxPath?: string
  /** Original entity JSON (or a small synthesized object for external/unknown). */
  raw: Record<string, unknown>
}

export type EdgeKind =
  'route' | 'overflow' | 'agent' | 'manager' | 'member' | 'trunk' | 'afterhours' | 'forward'

/** Display name + colour per link type, shared by the canvas styling and the
 *  settings panel that lets whole link types be hidden. */
export const EDGE_KIND_META: Record<EdgeKind, { label: string; color: string }> = {
  route: { label: 'Route', color: '#64748b' },
  overflow: { label: 'Overflow / no answer', color: '#f59e0b' },
  agent: { label: 'Queue agent', color: '#3b82f6' },
  manager: { label: 'Queue manager', color: '#6366f1' },
  member: { label: 'Ring group member', color: '#14b8a6' },
  trunk: { label: 'Trunk', color: '#a855f7' },
  afterhours: { label: 'Out of hours / holiday', color: '#0891b2' },
  forward: { label: 'Call forwarding', color: '#ec4899' }
}

/** The "route type" a link label belongs to — the granularity at which links can
 *  be hidden or reasoned about.
 *
 *  A link's `kind` (Route / Overflow / …) is far too coarse to act on: an inbound
 *  rule's "out of office hours destination" and an IVR's "key 3 → queue" are both
 *  plain `route` links, so hiding one used to take out every other route on the
 *  canvas. Labels are normalised so the per-instance parts (which digit was
 *  pressed, whether an agent happens to be logged out) fall away and the
 *  recurring branch name is what's left. */
export function routeGroupOf(label: string): string {
  const s = label.trim()
  if (!s) return ''
  // Every digit option is the same kind of branch, so they group together.
  if (/^key\s+\S+/i.test(s)) return 'key press'
  // "timeout: voicemail" → "timeout": the suffix only says what sits at the far
  // end of the branch, not which branch it is.
  const head = s.split(':')[0]
  // "agent (logged out)" → "agent": a live state, not a different kind of link.
  return (head.replace(/\s*\([^)]*\)\s*$/, '').trim() || s).toLowerCase()
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  /** One entry per underlying relationship collapsed into this edge. */
  labels: string[]
  kind: EdgeKind
  /** For `agent` edges: whether that agent is logged in to THIS queue.
   *  3CX v20 lets a supervisor log an agent out of one queue while leaving them
   *  logged in to others, so login state belongs on the queue↔agent link rather
   *  than on the extension. `undefined` = the queue's agent entry carried no
   *  per-queue signal, so callers fall back to the extension's global state. */
  agentLoggedIn?: boolean
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

/** Interpret one value as a queue login state. Deliberately strict: only clear
 *  booleans and unambiguous "logged in/out" wording count, so a field that
 *  happens to hold something else (a presence profile, a skill group) is ignored
 *  rather than guessed at. */
function loginValue(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v === 1 ? true : v === 0 ? false : null
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s) return null
  if (/^(?:true|false)$/i.test(s)) return /^true$/i.test(s)
  // Check "out" first — "LoggedOut" also contains "in"-free wording, but
  // "LoggedIn" must not match an /out/ test.
  if (/logged\s*out|^out$|^signed\s*out$/i.test(s)) return false
  if (/logged\s*in|^in$|^signed\s*in$/i.test(s)) return true
  return null
}

/** Whether a single agent entry from a queue's expanded `Agents[]` is logged in
 *  to that queue.
 *
 *  IMPORTANT: on 3CX v20 this normally returns null — a real agent entry from
 *  `Queues?$expand=Agents` carries only Number / Name / SkillGroup / Tags / Id,
 *  with no login field. The per-queue login a supervisor controls in the web
 *  client is NOT exposed on that endpoint, so it can't be read from the topology
 *  we fetch. The check is kept (cheaply, and strict enough never to false-match)
 *  in case a build does start returning it; callers must handle null by falling
 *  back to queueLoginState() below. */
export function agentLoggedIn(agent: Record<string, unknown>): boolean | null {
  for (const key of ['QueueStatus', 'IsLoggedIn', 'LoggedIn', 'AgentStatus', 'LoginStatus']) {
    if (!(key in agent)) continue
    const parsed = loginValue(agent[key])
    if (parsed !== null) return parsed
  }
  return null
}

/** The extension's currently-active forwarding/status profile, matched by name
 *  against CurrentProfileName (3CX allows a custom label per profile). */
function currentProfileOf(raw: Record<string, unknown>): Record<string, unknown> | null {
  const active = String(raw['CurrentProfileName'] ?? '').trim()
  if (!active) return null
  const profiles = raw['ForwardingProfiles']
  if (!Array.isArray(profiles)) return null
  for (const p of profiles) {
    if (typeof p !== 'object' || p === null) continue
    const o = p as Record<string, unknown>
    const custom = String(o['CustomName'] ?? '').trim()
    const name = String(o['Name'] ?? '').trim()
    if (custom === active || name === active) return o
  }
  return null
}

interface QueueLoginState {
  loggedIn: boolean
  /** Set when the state isn't simply QueueStatus, so the UI can explain itself. */
  reason?: string
}

/** The extension's EFFECTIVE queue login state.
 *
 *  `QueueStatus` alone is not the answer: a status profile with
 *  `OfficeHoursAutoQueueLogOut` logs the agent out of queues while it's active,
 *  so an extension can read "LoggedIn" there and still be out of every queue —
 *  which is exactly how a logged-out agent got mislabelled as logged in. */
export function queueLoginState(raw: Record<string, unknown>): QueueLoginState | null {
  const status = queueLoggedIn(raw)
  const profile = currentProfileOf(raw)
  if (profile?.['OfficeHoursAutoQueueLogOut'] === true) {
    const name = String(raw['CurrentProfileName'] ?? '').trim()
    return {
      loggedIn: false,
      reason: name
        ? `The “${name}” profile logs this extension out of queues automatically`
        : 'The active profile logs this extension out of queues automatically'
    }
  }
  if (status === null) return null
  return { loggedIn: status }
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
