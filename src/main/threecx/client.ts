// 3CX API client for the Electron main process.
//
// Auth mirrors the batch-system-manager shell scripts: POST credentials to
// /webclient/api/Login/GetAccessToken to obtain a bearer token, then call the
// OData-style /xapi/v1/* endpoints. Requests go through Node's https module so
// we can (optionally) accept the self-signed certificates 3CX ships with and
// avoid renderer CORS entirely.

import https from 'https'
import http from 'http'
import { URL } from 'url'
import type {
  CallLogEntry,
  CallReport,
  ConnectRequest,
  EntitySet,
  ExtensionActivity,
  ReportDirectoryEntry,
  ReportScope,
  SessionInfo,
  Topology
} from '../../shared/types'
import type { CallDirection } from '../../shared/phone'
import { redactSecrets } from '../../shared/redact'
import { SCRAPE_BUDGET_MS, scrapeQueueAgentLogins } from './switchboard'
import {
  classifyDirection,
  countryFromBareNumber,
  isExtensionLike,
  parseInternational,
  parseTrunkFromReason,
  pickParties
} from '../../shared/phone'

interface Session {
  baseUrl: string
  token: string
  allowInsecure: boolean
  /** Credentials kept in main-process memory only (never written to disk) so a
   *  Reload can re-authenticate for a fresh token instead of reusing a stale one. */
  req: ConnectRequest
}

// Several systems can be connected at once and switched between; `session` is
// whichever is in front. Credentials stay in main-process memory and are never
// written to disk.
const sessions = new Map<string, Session>()
let session: Session | null = null

export function listSessions(): SessionInfo[] {
  return [...sessions.values()].map((s) => ({
    baseUrl: s.baseUrl,
    username: s.req.username,
    active: s === session
  }))
}

/** Bring an already-connected system to the front. */
export function switchSession(baseUrl: string): boolean {
  const next = sessions.get(normaliseBase(baseUrl))
  if (!next) return false
  session = next
  return true
}

interface RawResponse {
  status: number
  body: string
}

/** Low-level request returning the raw body + status. Rejects only on transport errors. */
function request(
  urlStr: string,
  options: {
    method?: string
    headers?: Record<string, string>
    body?: string
    allowInsecure: boolean
    /** Per-request timeout. Report pages on a busy PBX are far slower than a
     *  config read, so callers can raise it. */
    timeoutMs?: number
    /** Aborts the request in flight (used to cancel a report job). */
    signal?: AbortSignal
  }
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let url: URL
    try {
      url = new URL(urlStr)
    } catch {
      reject(new Error(`Invalid URL: ${urlStr}`))
      return
    }
    if (options.signal?.aborted) {
      reject(new Error('Canceled'))
      return
    }
    const isHttps = url.protocol === 'https:'
    const transport = isHttps ? https : http
    const req = transport.request(
      url,
      {
        method: options.method ?? 'GET',
        headers: options.headers,
        signal: options.signal,
        // 3CX web servers commonly use self-signed certs; honour the toggle.
        ...(isHttps ? { rejectUnauthorized: !options.allowInsecure } : {})
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c as Buffer))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        )
      }
    )
    req.on('error', (err) =>
      reject(options.signal?.aborted ? new Error('Canceled') : (err as Error))
    )
    req.setTimeout(options.timeoutMs ?? 30000, () => req.destroy(new Error('Request timed out')))
    if (options.body) req.write(options.body)
    req.end()
  })
}

/** Strip trailing slashes so we can append paths predictably. */
function normaliseBase(base: string): string {
  return base.trim().replace(/\/+$/, '')
}

/** POST the credentials and return a fresh access token. Shared by connect
 *  (first login) and refresh (re-auth on Reload). */
async function authenticate(req: ConnectRequest): Promise<{ baseUrl: string; token: string }> {
  const baseUrl = normaliseBase(req.baseUrl)
  if (!baseUrl) throw new Error('A 3CX URL is required.')

  const payload = JSON.stringify({
    Username: req.username,
    Password: req.password,
    SecurityCode: req.securityCode ?? ''
  })

  let res: RawResponse
  try {
    res = await request(`${baseUrl}/webclient/api/Login/GetAccessToken`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(payload))
      },
      body: payload,
      allowInsecure: req.allowInsecure
    })
  } catch (err) {
    throw new Error(`Could not reach ${baseUrl}: ${(err as Error).message}`)
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error('Login rejected - check the username, password and security code.')
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Login failed (HTTP ${res.status}). ${truncate(res.body)}`)
  }

  let token = ''
  try {
    token = JSON.parse(res.body)?.Token?.access_token ?? ''
  } catch {
    throw new Error('Login response was not valid JSON - is this a 3CX web client URL?')
  }
  if (!token) throw new Error('Login succeeded but no access token was returned.')
  return { baseUrl, token }
}

export async function connect(req: ConnectRequest): Promise<void> {
  const { baseUrl, token } = await authenticate(req)
  session = { baseUrl, token, allowInsecure: req.allowInsecure, req }
  sessions.set(baseUrl, session)
}

/** Re-authenticate the active session for a fresh token (used by Reload so the
 *  refetch reflects the latest 3CX config even after the old token expired). */
export async function refresh(): Promise<void> {
  if (!session) throw new Error('Not connected.')
  const { token } = await authenticate(session.req)
  session.token = token
}

/** Drop one system, or every one when no URL is given. Whatever remains becomes
 *  the active session, so closing one of several doesn't log you out of all. */
export function disconnect(baseUrl?: string): void {
  if (!baseUrl) {
    sessions.clear()
    session = null
    return
  }
  const key = normaliseBase(baseUrl)
  const going = sessions.get(key)
  sessions.delete(key)
  if (session === going) session = [...sessions.values()][0] ?? null
}

export function isConnected(): boolean {
  return session !== null
}

// 3CX's xapi caps $top at 100 (a larger value is rejected with HTTP 400), so
// every collection is read as a run of $skip pages. A month of call log on a
// busy system is hundreds of those, and fetching them one at a time is what made
// long reports crawl — so pages are issued in parallel batches instead.
const PAGE_SIZE = 100
/** Parallel pages for config collections (small — a handful of pages at most). */
const CONFIG_CONCURRENCY = 4
/** Parallel pages within one call-log window. Windows are read concurrently too,
 *  so this stays small; the real ceiling is the shared request budget below. */
const CHUNK_PAGE_CONCURRENCY = 2

/** How much of the period one call-log request covers. `$skip=N` makes the
 *  server generate and discard N rows first, so a single paged read of a month is
 *  quadratic in the number of calls. Day-sized windows keep every `$skip` in the
 *  hundreds and can be read concurrently. */
const CHUNK_MS = 24 * 60 * 60 * 1000

/** Per-request timeout. A call-log page costs the PBX far more than a config
 *  read, and a slow page used to abort the whole run. */
const REPORT_TIMEOUT_MS = 120000

/** HTTP requests in flight at once across the whole report. Windows are read
 *  concurrently and each window pages internally, so without one shared budget
 *  the request count would be windows × pages — which makes a small PBX slower,
 *  not faster. */
const MAX_INFLIGHT = 6

/** Caps concurrent requests across every window of a report fetch. */
class RequestBudget {
  private active = 0
  private waiting: Array<() => void> = []
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      this.waiting.shift()?.()
    }
  }
}

export interface CollectionProgress {
  /** Rows read so far. */
  rows: number
  /** Rows the server says exist, when it answers $count. */
  total?: number
  /** 0–1 completion, when the caller knows it independently of the row count —
   *  a chunked read knows how many windows are left even though nothing has told
   *  it how many calls there are. */
  fraction?: number
}

interface CollectionOptions {
  concurrency?: number
  timeoutMs?: number
  signal?: AbortSignal
  onProgress?: (p: CollectionProgress) => void
  /** Ask for the total row count on the first page, so progress can be a real
   *  percentage rather than a spinner. Silently ignored by servers that reject
   *  $count. */
  wantCount?: boolean
  /** Stop after the first page — used to probe an endpoint cheaply. */
  firstPageOnly?: boolean
  /** Shared cap on in-flight requests. */
  budget?: RequestBudget
}

const isAbort = (err: unknown): boolean => /canceled|abort/i.test((err as Error)?.message ?? '')

/** One re-authentication shared by every page that hit a 401 at the same time,
 *  so a batch of parallel pages triggers a single login rather than six. */
let refreshing: Promise<void> | null = null
function refreshOnce(): Promise<void> {
  if (!refreshing) {
    refreshing = refresh().finally(() => {
      refreshing = null
    })
  }
  return refreshing
}

/** GET one $skip page. Retries once on a transport-level failure — a single
 *  dropped connection shouldn't throw away a long-running report — and once
 *  after re-authenticating, since a 3CX token can expire part-way through a
 *  report that takes many minutes to read. */
async function getPage(
  sess: Session,
  path: string,
  sep: string,
  skip: number,
  opts: CollectionOptions,
  wantCount: boolean
): Promise<{ page: unknown[]; total?: number }> {
  const url = `${sess.baseUrl}${path}${sep}$top=${PAGE_SIZE}&$skip=${skip}${wantCount ? '&$count=true' : ''}`
  // The token is read per attempt: a refresh mid-run replaces it on the session.
  const fire = (): Promise<RawResponse> =>
    request(url, {
      headers: { Authorization: `Bearer ${sess.token}`, Accept: 'application/json' },
      allowInsecure: sess.allowInsecure,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal
    })
  const send = (): Promise<RawResponse> => (opts.budget ? opts.budget.run(fire) : fire())

  let res: RawResponse
  try {
    res = await send()
  } catch (err) {
    if (isAbort(err)) throw err
    res = await send()
  }
  if (res.status === 401 || res.status === 403) {
    try {
      await refreshOnce()
      res = await send()
    } catch {
      /* keep the original 401/403 — it's reported below */
    }
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status} on ${path}. ${truncate(res.body)}`)
  }
  let json: { value?: unknown[]; '@odata.count'?: unknown }
  try {
    json = JSON.parse(res.body)
  } catch {
    throw new Error(`Non-JSON response on ${path}.`)
  }
  const page = Array.isArray(json.value)
    ? json.value
    : Array.isArray(json)
      ? (json as unknown[])
      : []
  const count = Number(json['@odata.count'])
  return { page, total: Number.isFinite(count) && count >= 0 ? count : undefined }
}

/** GET a path on the active session, reading every $skip page. */
async function getCollection(path: string, opts: CollectionOptions = {}): Promise<unknown[]> {
  if (!session) throw new Error('Not connected.')
  const sess = session
  const concurrency = Math.max(1, opts.concurrency ?? 1)
  const sep = path.includes('?') ? '&' : '?'
  const out: unknown[] = []

  // The first page is read alone: it settles whether there's a second page at
  // all, and carries the row count that turns progress into a percentage.
  let first: { page: unknown[]; total?: number }
  try {
    first = await getPage(sess, path, sep, 0, opts, !!opts.wantCount)
  } catch (err) {
    // $count isn't universally supported; a rejection could be down to that
    // alone, so try once more without it before giving up on the endpoint.
    if (!opts.wantCount || isAbort(err)) throw err
    first = await getPage(sess, path, sep, 0, opts, false)
  }
  // Some 3CX builds don't reject $count on a report function — they answer it
  // with an empty set. An empty first page is therefore never trusted while the
  // option is in play: ask again plainly before believing there's no data.
  if (opts.wantCount && !first.page.length) {
    first = await getPage(sess, path, sep, 0, opts, false)
  }
  out.push(...first.page)
  // A count that contradicts the page in front of us is worse than no count:
  // believing it would cut the read short. A count that exactly equals a full
  // page is the classic "server echoed $top back" shape, and trusting it would
  // silently truncate a big report at 100 rows — so that's ignored too, at the
  // cost of one extra (empty) batch when a collection really does hold exactly
  // one page.
  const usableCount =
    first.total != null && first.total >= first.page.length && first.total !== PAGE_SIZE
  const total = usableCount ? first.total : undefined
  opts.onProgress?.({ rows: out.length, total })
  // Last page reached, or a non-paged/singleton payload.
  if (opts.firstPageOnly || first.page.length < PAGE_SIZE) return out

  let skip = PAGE_SIZE
  for (;;) {
    if (opts.signal?.aborted) throw new Error('Canceled')
    if (total != null && skip >= total) break
    // With a known total we ask for exactly the pages that remain; otherwise we
    // probe a full batch and stop as soon as one comes back short.
    const remaining = total != null ? Math.ceil((total - skip) / PAGE_SIZE) : concurrency
    const batch = Math.max(1, Math.min(concurrency, remaining))
    const pages = await Promise.all(
      Array.from({ length: batch }, (_, i) =>
        getPage(sess, path, sep, skip + i * PAGE_SIZE, opts, false)
      )
    )
    let ended = false
    for (const p of pages) {
      out.push(...p.page)
      // A short page means the end. Pages after it are pushed anyway (they'll be
      // empty) so a server that pages oddly can't silently lose rows.
      if (p.page.length < PAGE_SIZE) ended = true
    }
    opts.onProgress?.({ rows: out.length, total })
    if (ended) break
    skip += batch * PAGE_SIZE
    if (skip > 500000) break // safety valve against a server that never shortens
  }
  return out
}

/** Fetch one collection, swallowing errors into the EntitySet so one failure
 *  doesn't abort the whole topology load (licences gate some endpoints). */
async function fetchSet(path: string): Promise<EntitySet> {
  try {
    const value = (await getCollection(path, {
      concurrency: CONFIG_CONCURRENCY
    })) as Record<string, unknown>[]
    return { path, value }
  } catch (err) {
    return { path, value: [], error: (err as Error).message }
  }
}

/**
 * Departments, with their opening hours attached.
 *
 * `OfficeHolidays` is a navigation property: it is simply absent unless asked
 * for by name, so a department's holidays never arrive on the plain request.
 * Ask for it alongside Members, and step down a rung at a time if the build
 * rejects the combination — losing holidays is much better than losing the
 * members every department box on the graph is built from.
 */
async function fetchGroups(): Promise<EntitySet> {
  const shapes = [
    '/xapi/v1/Groups?$expand=Members,OfficeHolidays',
    '/xapi/v1/Groups?$expand=Members'
  ]
  let last: EntitySet | undefined
  for (const path of shapes) {
    const set = await fetchSet(path)
    if (!set.error) return set
    last = set
  }
  return last!
}

/**
 * Configuration the graph never draws, fetched so Deep Search can reach it.
 *
 * Chosen against a live v20 PBX's $metadata (157 endpoints) rather than guessed.
 * Everything reporting - Report*, *Statistics, *HistoryView, CallLogData,
 * ActivityLog, AuditLog, EventLogs - is deliberately excluded: those are large,
 * time-parameterised and not configuration. So are MyTokens / SecurityTokens,
 * which hold refresh tokens and must never be pulled into a snapshot.
 *
 * A PBX that doesn't expose one of these answers 404, which fetchSet turns into
 * an empty set (see below), so an absent endpoint costs a request and nothing
 * more. Names differ between builds - Contacts exists here, Phones does not.
 */
const EXTRA_COLLECTIONS = [
  ['parkings', '/xapi/v1/Parkings'],
  ['fxs', '/xapi/v1/Fxs'],
  ['fax', '/xapi/v1/Fax'],
  ['contacts', '/xapi/v1/Contacts'],
  ['customPrompts', '/xapi/v1/CustomPrompts'],
  ['promptSets', '/xapi/v1/PromptSets'],
  ['holidays', '/xapi/v1/Holidays'],
  ['blackListNumbers', '/xapi/v1/BlackListNumbers'],
  ['blocklist', '/xapi/v1/Blocklist'],
  ['emergencyLocations', '/xapi/v1/EmergencyGeoLocations'],
  ['sipDevices', '/xapi/v1/SipDevices'],
  ['sbcs', '/xapi/v1/Sbcs']
] as const

/**
 * Singletons: one record each, no `value` array.
 *
 * Worth the requests because this is where the system's own DNs are declared -
 * the voicemail, conference, fax and parking extensions. Everywhere else in the
 * API those numbers only ever appear as the target of a route, which is why the
 * graph has to synthesise a node for them and can say nothing about what they
 * are. Folded into one `systemSettings` set, each record tagged with the
 * singleton it came from so a hit can say which page of 3CX to look on.
 */
const SYSTEM_SINGLETONS = [
  'VoicemailSettings',
  'ConferenceSettings',
  'FaxServerSettings',
  'CallParkingSettings',
  'EmergencyNotificationsSettings',
  'MusicOnHoldSettings',
  'GeneralSettingsForPbx',
  'OfficeHours',
  'E164Settings',
  'DialCodeSettings',
  'PhonesSettings'
] as const

/** Fetch one singleton as a single-record set, or nothing if it isn't there. */
async function fetchSingleton(name: string): Promise<Record<string, unknown> | null> {
  const sess = session
  if (!sess) return null
  try {
    // A singleton has no `value` array, so getCollection cannot read it: one
    // plain GET, and anything other than a JSON object is treated as absent.
    const res = await request(`${sess.baseUrl}/xapi/v1/${name}`, {
      headers: { Authorization: `Bearer ${sess.token}`, Accept: 'application/json' },
      allowInsecure: sess.allowInsecure
    })
    if (res.status < 200 || res.status >= 300) return null
    const raw = JSON.parse(res.body) as Record<string, unknown> | null
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    // Strip OData's own annotations, then tag it so a search hit can name the
    // settings page it came from.
    const out: Record<string, unknown> = { Setting: name }
    for (const [k, v] of Object.entries(raw)) if (!k.startsWith('@odata')) out[k] = v
    return out
  } catch {
    return null
  }
}

export async function fetchTopology(opts?: { includeQueueLogins?: boolean }): Promise<Topology> {
  if (!session) throw new Error('Not connected.')

  const [
    users,
    queues,
    ringGroups,
    receptionists,
    inboundRules,
    outboundRules,
    didNumbers,
    trunks,
    groups,
    callFlowApps
  ] = await Promise.all([
    fetchSet('/xapi/v1/Users?$expand=Groups,ForwardingProfiles'),
    fetchSet('/xapi/v1/Queues?$expand=Agents,Managers'),
    fetchSet('/xapi/v1/RingGroups?$expand=Members'),
    // Forwards carries the IVR's digit-menu destinations (key 1 → …), which
    // aren't returned unless expanded.
    fetchSet('/xapi/v1/Receptionists?$expand=Forwards'),
    fetchSet('/xapi/v1/InboundRules'),
    fetchSet('/xapi/v1/OutboundRules'),
    fetchSet('/xapi/v1/DidNumbers'),
    fetchSet('/xapi/v1/Trunks'),
    fetchGroups(),
    // Route points: the DNs a Call Flow Designer script is deployed on. Without
    // these a call routed into one dead-ends at a bare number, because nothing
    // else in the API names them.
    fetchSet('/xapi/v1/CallFlowApps')
  ])

  // Several endpoints reject $expand on some 3CX builds; retry bare on failure.
  const retried = await Promise.all(
    [queues, ringGroups, groups, users, receptionists].map(async (set) => {
      if (!set.error) return set
      // Users carry two expands; if the combined request is rejected, keep the
      // known-good Groups expand (departments depend on it) before going bare.
      if (set.path.startsWith('/xapi/v1/Users')) {
        const withGroups = await fetchSet('/xapi/v1/Users?$expand=Groups')
        if (!withGroups.error) return withGroups
      }
      return fetchSet(set.path.split('?')[0])
    })
  )
  const [queues2, ringGroups2, groups2, users2, receptionists2] = retried

  // Search-only configuration. Fetched after the spine so a slow or missing
  // endpoint here can never hold up the graph, and every failure is already
  // contained by fetchSet.
  const extraSets = await Promise.all(EXTRA_COLLECTIONS.map(([, path]) => fetchSet(path)))
  const singletons = await Promise.all(SYSTEM_SINGLETONS.map((n) => fetchSingleton(n)))
  const extra: Record<string, EntitySet> = {}
  EXTRA_COLLECTIONS.forEach(([key], i) => {
    extra[key] = extraSets[i]
  })
  extra.systemSettings = {
    path: '/xapi/v1/(singletons)',
    value: singletons.filter((r): r is Record<string, unknown> => r !== null)
  }

  // Per-queue agent logins aren't in the config API at all, so optionally read
  // them from the web client's Switchboard and stamp them onto the agent entries
  // (see switchboard.ts). Everything downstream then treats them as if 3CX had
  // returned them, and falls back to the extension-wide status when absent.
  if (opts?.includeQueueLogins) {
    await applyQueueAgentLogins(queues2, session)
  }

  // Redact credentials before the data ever leaves the main process — the
  // renderer and any saved snapshot then never contain SIP passwords / PINs.
  return redactSecrets<Topology>({
    fetchedAt: new Date().toISOString(),
    baseUrl: session.baseUrl,
    users: users2,
    queues: queues2,
    ringGroups: ringGroups2,
    receptionists: receptionists2,
    inboundRules,
    outboundRules,
    didNumbers,
    trunks,
    groups: groups2,
    // The script source travels through intact: it is the only thing that says
    // what a route point does, and the details panel shows it. It is withheld
    // when a snapshot is written instead — see stripScriptSource.
    callFlowApps: await withScriptSources(callFlowApps, session),
    ...extra
  })
}

/**
 * Fill in each route point's `ScriptCode`, which the collection doesn't carry.
 *
 * `/xapi/v1/CallFlowApps` answers with everything about an app EXCEPT its
 * source — 3CX leaves the large property out of the list response, the way
 * OData services usually do. Reading the entity on its own returns it, so this
 * asks once per route point. There are only ever a handful of them, and a
 * failure is per-app and silent: no script simply means the details panel says
 * it couldn't read one, which is the same thing it says for an older snapshot.
 */
/** The ways an OData service can be asked for one property of one entity. 3CX
 *  doesn't document which it honours for ScriptCode, so each is tried in turn
 *  and whichever answers is used for the rest — see probeScriptShape. */
const SCRIPT_URL_SHAPES: Array<{
  name: string
  url: (base: string, id: string) => string
  /** The raw-value form returns the script as the body, not as JSON. */
  raw?: boolean
}> = [
  // Ordered by what a live v20 system actually answered: $select returns the
  // source; a plain entity read answers 200 WITHOUT it, because the property is
  // projected away unless asked for; the raw-value route doesn't exist (404).
  // The losers stay as fallbacks in case another build differs.
  { name: '$select', url: (b, id) => `${b}/xapi/v1/CallFlowApps(${id})?$select=ScriptCode` },
  { name: 'entity', url: (b, id) => `${b}/xapi/v1/CallFlowApps(${id})` },
  {
    name: '$value',
    url: (b, id) => `${b}/xapi/v1/CallFlowApps(${id})/ScriptCode/$value`,
    raw: true
  }
]

/** GET one URL and pull ScriptCode out of it, or say why not. */
async function readScript(
  sess: Session,
  url: string,
  raw: boolean
): Promise<{ script?: string; why: string }> {
  let res: RawResponse
  try {
    res = await request(url, {
      headers: { Authorization: `Bearer ${sess.token}`, Accept: 'application/json' },
      allowInsecure: sess.allowInsecure
    })
  } catch (err) {
    return { why: `request failed (${(err as Error).message})` }
  }
  if (res.status < 200 || res.status >= 300) return { why: `HTTP ${res.status}` }
  if (raw) {
    return res.body ? { script: res.body, why: 'ok' } : { why: 'HTTP 200 but empty body' }
  }
  let json: Obj
  try {
    json = JSON.parse(res.body) as Obj
  } catch {
    return { why: 'HTTP 200 but the body was not JSON' }
  }
  const code = json?.['ScriptCode']
  if (typeof code === 'string' && code) return { script: code, why: 'ok' }
  if (code === null || code === '') return { why: 'HTTP 200, ScriptCode empty' }
  return { why: 'HTTP 200 but no ScriptCode field' }
}

/** Ask the collection for Id + ScriptCode in one request. Returns an empty map
 *  when the service won't widen the projection, which is the common case — the
 *  property is left out of list responses precisely because it is large. */
async function readScriptsFromCollection(): Promise<{ byId: Map<string, string>; why: string }> {
  const byId = new Map<string, string>()
  try {
    // Read through getCollection rather than as a single request: 3CX caps $top
    // at 100 and pages the rest, so a system with more route points than that
    // would otherwise lose every script past the first page — silently, since
    // the response is a perfectly valid 200.
    const rows = (await getCollection('/xapi/v1/CallFlowApps?$select=Id,ScriptCode', {
      concurrency: CONFIG_CONCURRENCY
    })) as Obj[]
    for (const row of rows) {
      const code = row?.['ScriptCode']
      const id = pickField(row ?? {}, 'Id')
      if (id && typeof code === 'string' && code) byId.set(id, code)
    }
  } catch (err) {
    return { byId, why: (err as Error).message }
  }
  return { byId, why: byId.size ? `ok (${byId.size})` : 'answered, but no ScriptCode in any row' }
}

/** Work out which URL shape this PBX answers for a script, trying each once and
 *  keeping a note of what every one of them said. */
async function probeScriptShape(
  sess: Session,
  id: string
): Promise<{ shape?: (typeof SCRIPT_URL_SHAPES)[number]; script?: string; note: string }> {
  const tried: string[] = []
  for (const shape of SCRIPT_URL_SHAPES) {
    const { script, why } = await readScript(sess, shape.url(sess.baseUrl, id), !!shape.raw)
    tried.push(`${shape.name}: ${why}`)
    if (script) return { shape, script, note: tried.join('; ') }
  }
  return { note: tried.join('; ') }
}

/**
 * Fill in each route point's `ScriptCode`, which the collection doesn't carry.
 *
 * `/xapi/v1/CallFlowApps` answers with everything about an app EXCEPT its
 * source — 3CX leaves the large property out of the list response, the way
 * OData services usually do. Which request DOES return it isn't documented, so
 * the first route point is used to probe the alternatives and the shape that
 * answers is then used for the rest.
 *
 * Every attempt is recorded rather than swallowed. A script that can't be read
 * is a normal outcome — a licence may gate it, a build may not expose it — but
 * "couldn't read it" and "there isn't one" are different answers, and the first
 * needs to say why. The note lands on the collection (so it shows under Fetch
 * warnings) and on each app (so the details panel can explain itself).
 */
async function withScriptSources(set: EntitySet, sess: Session): Promise<EntitySet> {
  const apps = set.value as Obj[]
  if (!apps?.length) return set
  // Already present (a future 3CX build might include it) — nothing to do.
  if (apps.every((a) => typeof a['ScriptCode'] === 'string')) return set

  // Cheapest shape first: ask the collection for the property it left out. One
  // request covers every route point, and if the service honours $select here
  // there is no need to read the entities one at a time.
  const viaCollection = await readScriptsFromCollection()
  if (viaCollection.byId.size) {
    return {
      ...set,
      value: apps.map((a) => {
        const script = viaCollection.byId.get(pickField(a, 'Id'))
        return script ? { ...a, ScriptCode: script } : a
      })
    }
  }

  const first = apps.find((a) => typeof a['ScriptCode'] !== 'string' && pickField(a, 'Id'))
  if (!first) return set
  const firstId = pickField(first, 'Id')
  const probe = await probeScriptShape(sess, firstId)
  probe.note = `collection $select: ${viaCollection.why}; ${probe.note}`

  if (!probe.shape) {
    const why = `Route point scripts could not be read. Tried ${probe.note}.`
    return {
      ...set,
      error: set.error ? `${set.error} ${why}` : why,
      value: apps.map((a) => ({ ...a, ScriptSourceError: probe.note }))
    }
  }

  const shape = probe.shape
  const filled = await Promise.all(
    apps.map(async (app) => {
      if (typeof app['ScriptCode'] === 'string') return app
      const id = pickField(app, 'Id')
      if (!id) return app
      if (id === firstId && probe.script) return { ...app, ScriptCode: probe.script }
      const { script, why } = await readScript(sess, shape.url(sess.baseUrl, id), !!shape.raw)
      return script ? { ...app, ScriptCode: script } : { ...app, ScriptSourceError: why }
    })
  )
  return { ...set, value: filled }
}

// --- Per-queue agent logins (Switchboard read) -------------------------------

/** Scrape the Switchboard and write each agent's per-queue login state onto that
 *  queue's own `Agents[]` entry as `QueueStatus`. Mutates `queueSet` in place and
 *  records any problem as a non-fatal error on the set, so a failed read never
 *  costs the user their topology. */
async function applyQueueAgentLogins(queueSet: EntitySet, sess: Session): Promise<void> {
  const targets = (queueSet.value as Obj[])
    .map((q) => ({ id: pickField(q, 'Id'), number: pickField(q, 'Number') }))
    .filter((t) => t.id)
  if (!targets.length) return

  // Outer guard: the scrape has its own budget, but a topology fetch must never
  // be blocked by it under any circumstances (a stalled navigation once left the
  // app stuck on the loading screen), so cap it here too and move on.
  const { byQueue, error } = await Promise.race([
    scrapeQueueAgentLogins(sess.baseUrl, sess.req, targets, sess.allowInsecure),
    new Promise<Awaited<ReturnType<typeof scrapeQueueAgentLogins>>>((resolve) =>
      setTimeout(
        () =>
          resolve({
            byQueue: new Map(),
            error: 'Per-queue login read did not finish in time; showing extension-wide status.'
          }),
        SCRAPE_BUDGET_MS + 15_000
      )
    )
  ])
  if (error) {
    // Surface it without discarding whatever did come back.
    queueSet.error = queueSet.error ? `${queueSet.error} ${error}` : error
  }
  if (!byQueue.size) return

  for (const q of queueSet.value as Obj[]) {
    const logins = byQueue.get(pickField(q, 'Id'))
    if (!logins) continue
    const byExt = new Map(logins.map((a) => [a.extension, a]))
    const agents = q['Agents']
    if (!Array.isArray(agents)) continue
    for (const a of agents) {
      if (!isObj(a)) continue
      const hit = byExt.get(pickField(a, 'Number', 'Extension'))
      if (!hit) continue
      a['QueueStatus'] = hit.loggedIn ? 'LoggedIn' : 'LoggedOut'
      if (hit.since) a['QueueStatusSince'] = hit.since
    }
  }
}

// --- Call-activity reports --------------------------------------------------

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** First non-empty value among the given keys (case-insensitive). */
function pickField(o: Obj, ...keys: string[]): string {
  const lower: Record<string, unknown> = {}
  for (const k of Object.keys(o)) lower[k.toLowerCase()] = o[k]
  for (const k of keys) {
    const v = lower[k.toLowerCase()]
    if (v !== undefined && v !== null && v !== '') return String(v)
  }
  return ''
}

/** Parse a duration into seconds. Handles plain seconds ("45"), clock form
 *  ("HH:MM:SS" / "MM:SS") and ISO-8601 durations ("PT3M43.8S", "PT14.6S",
 *  "PT1H2M3S") — 3CX's call log uses the ISO form. Exported for unit testing. */
export function parseDuration(s: string): number {
  if (!s) return 0
  const t = s.trim()
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t)
  const iso = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(t)
  if (iso) {
    const [, d, h, m, sec] = iso
    return (
      (Number(d) || 0) * 86400 +
      (Number(h) || 0) * 3600 +
      (Number(m) || 0) * 60 +
      (Number(sec) || 0)
    )
  }
  const parts = t.split(':').map((p) => Number(p))
  if (parts.some((n) => Number.isNaN(n))) {
    const f = Number(t)
    return Number.isNaN(f) ? 0 : f
  }
  return parts.reduce((acc, n) => acc * 60 + n, 0)
}

// `isExtensionLike` now lives in shared/phone (used by the renderer too); it is
// re-exported here so existing imports/tests keep working.
export { isExtensionLike } from '../../shared/phone'

/** Normalise one raw 3CX call-log / active-call record into a CallLogEntry.
 *  Field names differ across 3CX versions, so every field is best-effort.
 *  Exported for unit testing. */
export function normalizeCallEntry(raw: Obj): CallLogEntry {
  // 3CX splits each endpoint into a DN (the extension / trunk identity, e.g.
  // "0202" or the "10000" line pseudo-DN) and a CallerId (the dialled phone
  // number, e.g. "+353873962669"). We track both: the DN identifies which
  // extension a call belongs to; the CallerId is the external party's number.
  const srcDn = pickField(raw, 'SrcDn', 'SourceDn')
  const dstDn = pickField(raw, 'DstDn', 'DestinationDn')
  const srcNum = pickField(
    raw,
    'SourceCallerId',
    'SrcCallerNumber',
    'CallerNumber',
    'CallerId',
    'From',
    'Caller'
  )
  const dstNum = pickField(
    raw,
    'DestinationCallerId',
    'DstCallerNumber',
    'To',
    'Callee',
    'Destination'
  )
  // Display / back-compat identities: prefer the dialled number, fall back to DN.
  const from = srcNum || srcDn
  const to = dstNum || dstDn
  // Per-call group key (shared by every routing leg of one call).
  const callId = pickField(raw, 'MainCallHistoryId', 'CallHistoryId', 'CallId')
  const start = pickField(
    raw,
    'StartTime',
    'TimeStart',
    'SegmentStartTime',
    'EstablishedAt',
    'Time',
    'StartedAt'
  )
  // Talk time, and ONLY talk time: RingingDuration here made a leg that merely
  // rang report the ring as its duration, and the last-resort answered test is
  // "did it have any duration".
  const talkStr = pickField(raw, 'TalkDuration', 'TalkingDuration')
  const durationSec = parseDuration(talkStr || pickField(raw, 'Duration', 'CallTime'))
  const status = pickField(raw, 'Status', 'CallState', 'State', 'Result', 'Reason')
  const answeredFlag = pickField(raw, 'Answered', 'IsAnswered', 'CallAnswered')
  // Order matters: check the NEGATIVE statuses first, because "Unanswered"
  // contains the substring "answered" and would otherwise be read as answered.
  let answered: boolean
  if (/^(true|1|yes)$/i.test(answeredFlag)) answered = true
  else if (/^(false|0|no)$/i.test(answeredFlag)) answered = false
  else if (/unanswered|missed|no ?answer|abandon|fail|cancel|busy|declin/i.test(status))
    answered = false
  // "Routing" is deliberately absent: a call being routed hasn't been answered
  // by anyone yet, so it falls through to the talk-time test below.
  else if (/answered|talking|connected|established|completed/i.test(status)) answered = true
  else answered = durationSec > 0

  // Prefer 3CX's explicit Direction ("Inbound" / "Inbound Queue" / "Outbound").
  const direction = pickField(raw, 'Direction', 'CallType', 'Type')
  // Identify each side by its DN when present (the true extension/trunk id),
  // otherwise by the number — so direction is inferred from identities, not from
  // a caller-id that may be a full PSTN number.
  const srcId = srcDn || srcNum
  const dstId = dstDn || dstNum
  const directionNorm = classifyDirection(srcId, dstId, direction)

  // The internal extension is the DN on the relevant side; the external party is
  // the dialled number on the other side.
  let extension: string | undefined
  let external: string | undefined
  if (directionNorm === 'inbound') {
    extension = isExtensionLike(dstId) ? dstId : undefined
    external = srcNum || srcDn || undefined
  } else if (directionNorm === 'outbound') {
    extension = isExtensionLike(srcId) ? srcId : undefined
    external = dstNum || dstDn || undefined
  } else if (directionNorm === 'internal') {
    extension = isExtensionLike(srcId) ? srcId : isExtensionLike(dstId) ? dstId : undefined
    external = undefined
  } else {
    const p = pickParties(from, to, directionNorm)
    extension = p.extension
    external = p.external
  }
  const intl = parseInternational(external)
  const trunkInfo = parseTrunkFromReason(pickField(raw, 'Reason'))
  // A call that rings out into voicemail writes a second segment to the same DN,
  // marked answered. Flagged here; see perExtension for how it's read.
  const destLabel = pickField(
    raw,
    'DstDisplayName',
    'DestinationDisplayName',
    'DstCallerName',
    'Callee',
    'Destination',
    'DestinationCallerId'
  )
  const toVoicemail =
    /voice\s*mail/i.test(destLabel) || /voice\s*mail/i.test(pickField(raw, 'Reason'))
  // Everything the report needs is normalised above, so the original record is
  // deliberately NOT kept: it duplicated every field and roughly doubled a
  // report's size in memory, over IPC and on disk.
  return {
    startTime: start || undefined,
    callId: callId || undefined,
    from: from || undefined,
    to: to || undefined,
    srcDn: srcDn || undefined,
    dstDn: dstDn || undefined,
    answered,
    durationSec: durationSec || undefined,
    direction: direction || undefined,
    directionNorm,
    extension: extension || undefined,
    external: external || undefined,
    intlCode: intl?.code,
    country: intl?.country,
    trunk: trunkInfo?.name || undefined,
    trunkNumber: trunkInfo?.number || undefined,
    toVoicemail: toVoicemail || undefined
  }
}

/** Best-guess home country (ISO2) for a set of calls. Trunk DIDs are the
 *  strongest signal (they sit in the PBX's own country), so those win; otherwise
 *  fall back to the most common country among international-format caller-ids.
 *  Blank when there is no signal — the report UI then asks the user to pick one. */
export function guessHomeCountry(entries: CallLogEntry[]): string | undefined {
  const top = (tally: Map<string, number>): string | undefined => {
    let best: string | undefined
    let bestN = 0
    for (const [iso, n] of tally) {
      if (n > bestN) {
        best = iso
        bestN = n
      }
    }
    return best
  }

  const trunkTally = new Map<string, number>()
  const extTally = new Map<string, number>()
  for (const e of entries) {
    // Reports written before Beta 9 kept the whole raw record instead of the
    // trunk number, so fall back to re-reading it from there.
    const trunkNum =
      e.trunkNumber ??
      (e.raw ? parseTrunkFromReason(pickField(e.raw, 'Reason'))?.number : undefined)
    const trunkIso = countryFromBareNumber(trunkNum)?.iso2
    if (trunkIso) trunkTally.set(trunkIso, (trunkTally.get(trunkIso) ?? 0) + 1)
    const extIso = parseInternational(e.external)?.iso2
    if (extIso) extTally.set(extIso, (extTally.get(extIso) ?? 0) + 1)
  }
  return top(trunkTally) ?? top(extTally)
}

/** Roll call entries up per extension so the report can answer "did ext N receive
 *  calls / was it active". An endpoint is treated as an extension when it's a
 *  short all-digit number appearing as a call's source or destination.
 *  Exported for unit testing. */
export function rollupByExtension(entries: CallLogEntry[]): ExtensionActivity[] {
  const map = new Map<string, ExtensionActivity>()
  const get = (ext: string): ExtensionActivity => {
    let a = map.get(ext)
    if (!a) {
      a = {
        extension: ext,
        received: 0,
        answered: 0,
        missed: 0,
        placed: 0,
        totalTalkSec: 0,
        active: true
      }
      map.set(ext, a)
    }
    return a
  }
  for (const e of entries) {
    if (e.to && isExtensionLike(e.to)) {
      const a = get(e.to)
      a.received++
      if (e.answered) a.answered++
      else a.missed++
      a.totalTalkSec += e.durationSec ?? 0
    }
    if (e.from && isExtensionLike(e.from)) {
      const a = get(e.from)
      a.placed++
      a.totalTalkSec += e.durationSec ?? 0
    }
  }
  return [...map.values()].sort((a, b) => b.received + b.placed - (a.received + a.placed))
}

// 3CX's historical call-log report is an OData function whose exact name/params
// vary by version. Try each candidate in turn and use the first that returns
// data; the {from}/{to} placeholders are ISO date-times.
const CALL_LOG_ENDPOINTS = [
  '/xapi/v1/ReportCallLogData/Pbx.GetCallLogData(periodFrom={from},periodTo={to},sourceType=0,sourceFilter=%27%27,destinationType=0,destinationFilter=%27%27,callsType=0,callTimeFilterType=0,callTimeFilterFrom=%270:00:0%27,callTimeFilterTo=%270:00:0%27,hidePcalls=true)',
  '/xapi/v1/CallHistoryView?$filter=StartTime%20ge%20{from}%20and%20StartTime%20le%20{to}',
  '/xapi/v1/ReportCallLogData?startDate={from}&endDate={to}'
]

/** HTTP status out of a "HTTP 404 on /path…" error message, if present. */
function statusOf(message: string): number | null {
  const m = /^HTTP (\d{3})\b/.exec(message)
  return m ? Number(m[1]) : null
}

/** Explain why call reporting is unavailable, rather than quoting whichever
 *  candidate endpoint happened to be tried last. */
function describeReportFailure(failures: string[]): string {
  const codes = failures.map(statusOf).filter((c): c is number => c !== null)
  if (codes.some((c) => c === 401 || c === 403)) {
    return 'Call reporting was refused (HTTP 401/403). The account used to connect probably lacks reporting permission - try a full admin account.'
  }
  // Only blame a missing endpoint when EVERY candidate actually said 404. A
  // timeout carries no status code, and letting it through here reported a
  // slow system as one without call reporting at all.
  if (codes.length && codes.length === failures.length && codes.every((c) => c === 404)) {
    return 'This 3CX system does not expose a call-log endpoint (HTTP 404). Call reporting is licence-gated, so it is typically unavailable on the free/standard editions.'
  }
  return failures[0] ?? 'No call-log data returned for this period.'
}

// --- Period / scope filtering ------------------------------------------------

/** Keep whole calls: `keep` is asked about all of a call's routing legs at once,
 *  and either every leg survives or none does. Filtering leg-by-leg would break
 *  the report's call view — the leg carrying the external number is often not the
 *  leg that matches the filter. Legs with no call id stand alone. */
function filterWholeCalls(
  entries: CallLogEntry[],
  keep: (legs: CallLogEntry[]) => boolean
): CallLogEntry[] {
  const groups = new Map<string, CallLogEntry[]>()
  for (const e of entries) {
    if (!e.callId) continue
    const g = groups.get(e.callId)
    if (g) g.push(e)
    else groups.set(e.callId, [e])
  }
  const allowed = new Set<string>()
  for (const [id, legs] of groups) if (keep(legs)) allowed.add(id)
  return entries.filter((e) => (e.callId ? allowed.has(e.callId) : keep([e])))
}

/** The direction of a whole call, from its legs: a call that touched a trunk
 *  either way is inbound/outbound even though its queue → agent leg looks
 *  internal. */
export function callDirection(legs: CallLogEntry[]): CallDirection {
  if (legs.some((l) => l.directionNorm === 'inbound')) return 'inbound'
  if (legs.some((l) => l.directionNorm === 'outbound')) return 'outbound'
  if (legs.some((l) => l.directionNorm === 'internal')) return 'internal'
  return 'unknown'
}

/** Drop calls that started outside [fromISO, toISO]. Both ends are inclusive, and
 *  a call is judged by its first leg, so a call that begins inside the period is
 *  kept whole. Undated rows are kept — they can't be judged. Exported for tests. */
export function trimToPeriod(
  entries: CallLogEntry[],
  fromISO: string,
  toISO: string
): CallLogEntry[] {
  const from = Date.parse(fromISO)
  const to = Date.parse(toISO)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return entries
  return filterWholeCalls(entries, (legs) => {
    const times = legs.map((l) => Date.parse(l.startTime ?? '')).filter((t) => Number.isFinite(t))
    if (!times.length) return true
    const start = Math.min(...times)
    return start >= from && start <= to
  })
}

/** Keep only calls that touched one of `dns` (extension / queue / ring-group
 *  numbers). Both the DN and the caller-id sides are matched, since 3CX reports
 *  an extension by DN on one leg and by presented number on another.
 *  Exported for tests. */
export function filterEntriesByDn(entries: CallLogEntry[], dns: string[]): CallLogEntry[] {
  const want = new Set(dns.map((d) => String(d).trim()).filter(Boolean))
  if (!want.size) return entries
  const touches = (e: CallLogEntry): boolean =>
    [e.srcDn, e.dstDn, e.extension, e.from, e.to].some((v) => !!v && want.has(v))
  return filterWholeCalls(entries, (legs) => legs.some(touches))
}

/** Keep only calls whose overall direction is one of `directions`. Exported for tests. */
export function filterEntriesByDirection(
  entries: CallLogEntry[],
  directions: CallDirection[]
): CallLogEntry[] {
  const want = new Set(directions)
  // Nothing chosen, or everything chosen, means "don't filter" — an unknown
  // direction is then kept rather than silently dropped.
  if (!want.size || (want.has('inbound') && want.has('outbound') && want.has('internal')))
    return entries
  return filterWholeCalls(entries, (legs) => want.has(callDirection(legs)))
}

/** The call log is read a day wider either side and trimmed back here: 3CX
 *  doesn't document whether the period bounds are UTC or PBX-local, and this is
 *  what makes whole days reliably inclusive either way. */
const PERIOD_PAD_MS = 24 * 60 * 60 * 1000

/** The calendar day an instant falls on, locally — for messages about a period
 *  whose bounds are stored as instants. */
function localDay(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export interface FetchReportOptions {
  /** Inclusive period bounds as ISO instants. */
  from: string
  to: string
  /** Report name, stamped onto the result. */
  name?: string
  /** Limit the report to chosen DNs / directions. */
  scope?: ReportScope
  /** Home country to stamp on the report (else it's guessed from the calls). */
  homeCountry?: string
  /** The connected system's DN directory, recorded with the report. */
  directory?: ReportDirectoryEntry[]
  signal?: AbortSignal
  onProgress?: (p: CollectionProgress) => void
}

/** The datetime form the call-log endpoints take: NOT percent-encoded and without
 *  milliseconds. These sit in the URL *path* of an OData function call, where
 *  `:`, `.` and `-` are legal. Encoded colons or a `.000` fraction make some 3CX
 *  builds silently ignore the period and return today's log instead. */
export function odataDateTime(iso: string): string {
  return iso.replace(/\.\d{3}(?=Z$)/, '')
}

function endpointPath(tpl: string, fromISO: string, toISO: string): string {
  return tpl.replace('{from}', odataDateTime(fromISO)).replace('{to}', odataDateTime(toISO))
}

/** Split a period into the windows the call log is actually read in. */
export function splitIntoWindows(
  fromISO: string,
  toISO: string
): Array<{ from: string; to: string }> {
  const fromMs = Date.parse(fromISO)
  const toMs = Date.parse(toISO)
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs)
    return [{ from: fromISO, to: toISO }]
  const out: Array<{ from: string; to: string }> = []
  for (let start = fromMs; start <= toMs; start += CHUNK_MS) {
    // Windows abut without overlapping, so a call can't be read twice.
    const end = Math.min(start + CHUNK_MS - 1, toMs)
    out.push({ from: new Date(start).toISOString(), to: new Date(end).toISOString() })
  }
  return out
}

/** Drop rows the same call-log row arrived as twice. Windows don't overlap, but
 *  a server that rounds the period bounds to whole seconds can hand back a
 *  boundary row on both sides of the join. Exported for tests. */
export function dedupeEntries(entries: CallLogEntry[]): CallLogEntry[] {
  const seen = new Set<string>()
  const out: CallLogEntry[] = []
  for (const e of entries) {
    // Without an id and a timestamp there's nothing safe to compare, so keep it.
    if (!e.callId || !e.startTime) {
      out.push(e)
      continue
    }
    const key = `${e.callId}|${e.startTime}|${e.srcDn ?? ''}|${e.dstDn ?? ''}|${e.durationSec ?? 0}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(e)
  }
  return out
}

interface EndpointChoice {
  tpl?: string
  path?: string
  /** True once any candidate answered successfully, however few rows it
   *  returned — "no calls" is an answer, not a failure. */
  answered: boolean
  failures: string[]
  /** The first page the chosen candidate returned. */
  sample: CallLogEntry[]
  /** Whether the sample's rows are dated inside the window we asked for. An
   *  endpoint that answers with some other window has not answered the question,
   *  however successful its HTTP status. */
  honoured: boolean
}

/** Pick the call-log endpoint this 3CX build actually supports, reading only the
 *  first page from each candidate. Probing used to pull the whole period from
 *  every candidate in turn, which on a system where the first candidate is
 *  unavailable meant fetching a month twice. */
async function pickCallLogEndpoint(
  fromISO: string,
  toISO: string,
  opts: FetchReportOptions,
  budget: RequestBudget
): Promise<EndpointChoice> {
  const out: EndpointChoice = { answered: false, failures: [], sample: [], honoured: false }
  for (const tpl of CALL_LOG_ENDPOINTS) {
    const path = endpointPath(tpl, fromISO, toISO)
    try {
      const rows = await getCollection(path, {
        firstPageOnly: true,
        timeoutMs: REPORT_TIMEOUT_MS,
        signal: opts.signal,
        budget
      })
      out.answered = true
      const sample = rows.filter(isObj).map((r) => normalizeCallEntry(r as Obj))
      // No rows at all is not evidence either way, so it doesn't disqualify.
      const honoured = !sample.length || trimToPeriod(sample, fromISO, toISO).length > 0
      const better =
        !out.tpl || (honoured && !out.honoured) || (!out.sample.length && sample.length)
      if (better) {
        out.tpl = tpl
        out.path = path
        out.sample = sample
        out.honoured = honoured
      }
      if (sample.length && honoured) break // this one answers the question we asked
    } catch (err) {
      if (isAbort(err)) throw err
      out.failures.push((err as Error).message)
    }
  }
  return out
}

/** Read the whole call log for a period, one window at a time and several
 *  windows at once. */
async function readCallLog(
  tpl: string,
  fromISO: string,
  toISO: string,
  opts: FetchReportOptions,
  budget: RequestBudget
): Promise<CallLogEntry[]> {
  const windows = splitIntoWindows(fromISO, toISO)
  let done = 0
  let rows = 0
  const pages = await Promise.all(
    windows.map(async (w) => {
      const got = await getCollection(endpointPath(tpl, w.from, w.to), {
        concurrency: CHUNK_PAGE_CONCURRENCY,
        timeoutMs: REPORT_TIMEOUT_MS,
        signal: opts.signal,
        budget,
        onProgress: () => undefined
      })
      done++
      rows += got.length
      // Windows give progress a real denominator without asking the server for a
      // count it may not support.
      opts.onProgress?.({ rows, fraction: done / windows.length })
      return got
    })
  )
  return dedupeEntries(
    pages
      .flat()
      .filter(isObj)
      .map((r) => normalizeCallEntry(r as Obj))
  )
}

/** The span of days a set of entries actually covers, for saying what an
 *  endpoint returned when it ignored the period it was given. */
function datedRange(entries: CallLogEntry[]): { from: string; to: string } | null {
  const times = entries.map((e) => Date.parse(e.startTime ?? '')).filter((t) => Number.isFinite(t))
  if (!times.length) return null
  return {
    from: localDay(new Date(Math.min(...times)).toISOString()),
    to: localDay(new Date(Math.max(...times)).toISOString())
  }
}

/** Fetch a historical call-activity report for an inclusive period. Degrades to
 *  an empty, error-tagged report when no endpoint is available (licence-gated). */
export async function fetchCallReport(opts: FetchReportOptions): Promise<CallReport> {
  if (!session) throw new Error('Not connected.')
  const fromMs = Date.parse(opts.from)
  const toMs = Date.parse(opts.to)
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) throw new Error('Invalid report period.')

  // Bounds go into a URL, so they're re-serialised from the parsed instant
  // rather than passed through as whatever string arrived.
  const exactWindow = { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() }
  // Read a day wider than asked (see PERIOD_PAD_MS) and trim back below.
  let window = {
    from: new Date(fromMs - PERIOD_PAD_MS).toISOString(),
    to: new Date(toMs + PERIOD_PAD_MS).toISOString()
  }
  const budget = new RequestBudget(MAX_INFLIGHT)

  // One page from each candidate settles which endpoint this build supports, and
  // whether it applies the period at all — both for the price of a single
  // request, before committing to reading the whole period.
  let choice = await pickCallLogEndpoint(window.from, window.to, opts, budget)
  if (choice.answered && !choice.honoured) {
    // It answered with rows from somewhere other than the window asked for.
    // Rule out the padding first: a build that can't parse the widened bounds
    // falls back to its default window rather than saying so.
    const exact = await pickCallLogEndpoint(exactWindow.from, exactWindow.to, opts, budget)
    if (exact.honoured && exact.sample.length) {
      choice = exact
      window = exactWindow
    }
  }

  let fetched: CallLogEntry[] = []
  if (choice.tpl && !(choice.sample.length && !choice.honoured)) {
    // Only read the full period once the endpoint has proved it honours one.
    fetched = await readCallLog(choice.tpl, window.from, window.to, opts, budget)
  } else {
    fetched = choice.sample
  }
  const trimmed = trimToPeriod(fetched, opts.from, opts.to)
  // Rows dated outside the period are NOT shown as the report. They mean the
  // endpoint ignored periodFrom/periodTo and answered with its own window —
  // presenting today's calls under a July heading would be worse than an empty
  // report, so the report stays empty and says what came back instead.
  const periodIgnored = fetched.length > 0 && trimmed.length === 0
  let entries = trimmed
  if (opts.scope?.dns?.length) entries = filterEntriesByDn(entries, opts.scope.dns)
  if (opts.scope?.directions?.length)
    entries = filterEntriesByDirection(entries, opts.scope.directions)

  // Say which step emptied the report, not the same message for all three.
  let error: string | undefined
  if (!choice.answered) error = describeReportFailure(choice.failures)
  else if (periodIgnored) {
    const got = datedRange(fetched)
    error =
      `This system's call log returned ${fetched.length.toLocaleString()} records` +
      `${got ? ` dated ${got.from} – ${got.to}` : ''} instead of the ${localDay(opts.from)} – ${localDay(opts.to)} that was asked for, ` +
      `so nothing here is from your period and none of it is shown. ` +
      `Either the log doesn't reach that far back, or this 3CX build doesn't apply the period it was given - ` +
      `check the same dates in 3CX's own Call Reports to tell which.`
  } else if (!fetched.length) {
    const codes = choice.failures.map(statusOf).filter((c): c is number => c !== null)
    const alsoTried = codes.length
      ? ` Other call-log endpoints were unavailable (${[...new Set(codes)].map((c) => `HTTP ${c}`).join(', ')}).`
      : ''
    error = `3CX returned no call records for this period${choice.path ? `, from ${choice.path.split('?')[0]}` : ''}.${alsoTried}`
  } else if (!entries.length)
    error = `3CX returned ${trimmed.length.toLocaleString()} call records for this period, but none matched the chosen scope.`
  return redactSecrets<CallReport>({
    kind: 'call-report',
    generatedAt: new Date().toISOString(),
    baseUrl: session.baseUrl,
    live: false,
    from: opts.from,
    to: opts.to,
    name: opts.name || undefined,
    scope: opts.scope?.dns?.length || opts.scope?.directions?.length ? opts.scope : undefined,
    directory: opts.directory?.length ? opts.directory : undefined,
    homeCountry: opts.homeCountry || guessHomeCountry(entries),
    entries,
    perExtension: rollupByExtension(entries),
    error,
    diagnostics: {
      endpoint: choice.path,
      window,
      fetched: fetched.length,
      inPeriod: trimmed.length,
      kept: entries.length,
      failures: choice.failures.length ? choice.failures.map((f) => truncate(f, 160)) : undefined
    }
  })
}

/** Snapshot of currently active calls for the "Live report". */
export async function fetchActiveCalls(): Promise<CallReport> {
  if (!session) throw new Error('Not connected.')
  let rawRecords: unknown[] = []
  let error = ''
  try {
    rawRecords = await getCollection('/xapi/v1/ActiveCalls')
  } catch (err) {
    const message = (err as Error).message
    const status = statusOf(message)
    // A bare "HTTP 401" here reads like a login problem even though the topology
    // loaded fine, so name the actual cause: this endpoint is permission-gated.
    error =
      status === 401 || status === 403
        ? 'Live calls were refused (HTTP 401/403). The connected account lacks permission to view active calls - try a full admin account.'
        : status === 404
          ? 'This 3CX system does not expose the active-calls endpoint (HTTP 404), so the live report is unavailable.'
          : message
  }
  const entries = rawRecords.filter(isObj).map((r) => normalizeCallEntry(r as Obj))
  return redactSecrets<CallReport>({
    kind: 'call-report',
    generatedAt: new Date().toISOString(),
    baseUrl: session.baseUrl,
    live: true,
    homeCountry: guessHomeCountry(entries),
    entries,
    perExtension: rollupByExtension(entries),
    error: error || undefined
  })
}

function truncate(s: string, n = 200): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}
