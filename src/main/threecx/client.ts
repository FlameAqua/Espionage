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
  Topology
} from '../../shared/types'
import { redactSecrets } from '../../shared/redact'

interface Session {
  baseUrl: string
  token: string
  allowInsecure: boolean
  /** Credentials kept in main-process memory only (never written to disk) so a
   *  Reload can re-authenticate for a fresh token instead of reusing a stale one. */
  req: ConnectRequest
}

let session: Session | null = null

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
    const isHttps = url.protocol === 'https:'
    const transport = isHttps ? https : http
    const req = transport.request(
      url,
      {
        method: options.method ?? 'GET',
        headers: options.headers,
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
    req.on('error', reject)
    req.setTimeout(30000, () => req.destroy(new Error('Request timed out')))
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
    throw new Error('Login rejected — check the username, password and security code.')
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Login failed (HTTP ${res.status}). ${truncate(res.body)}`)
  }

  let token = ''
  try {
    token = JSON.parse(res.body)?.Token?.access_token ?? ''
  } catch {
    throw new Error('Login response was not valid JSON — is this a 3CX web client URL?')
  }
  if (!token) throw new Error('Login succeeded but no access token was returned.')
  return { baseUrl, token }
}

export async function connect(req: ConnectRequest): Promise<void> {
  const { baseUrl, token } = await authenticate(req)
  session = { baseUrl, token, allowInsecure: req.allowInsecure, req }
}

/** Re-authenticate the active session for a fresh token (used by Reload so the
 *  refetch reflects the latest 3CX config even after the old token expired). */
export async function refresh(): Promise<void> {
  if (!session) throw new Error('Not connected.')
  const { token } = await authenticate(session.req)
  session.token = token
}

export function disconnect(): void {
  session = null
}

export function isConnected(): boolean {
  return session !== null
}

/** GET a path on the active session, following OData @odata.nextLink pagination. */
async function getCollection(path: string): Promise<unknown[]> {
  if (!session) throw new Error('Not connected.')
  const out: unknown[] = []
  // 3CX's xapi caps $top at 100, so page with $top=100 + $skip until a short
  // page comes back. (A larger $top is rejected outright with HTTP 400.)
  const pageSize = 100
  const sep = path.includes('?') ? '&' : '?'
  let skip = 0

  for (;;) {
    const url = `${session.baseUrl}${path}${sep}$top=${pageSize}&$skip=${skip}`
    const res: RawResponse = await request(url, {
      headers: { Authorization: `Bearer ${session.token}`, Accept: 'application/json' },
      allowInsecure: session.allowInsecure
    })
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`HTTP ${res.status} on ${path}. ${truncate(res.body)}`)
    }
    let json: { value?: unknown[] }
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
    out.push(...page)
    // Last page reached, or a non-paged/singleton payload.
    if (page.length < pageSize) break
    skip += pageSize
    if (skip > 100000) break // safety valve against a server that never shortens
  }
  return out
}

/** Fetch one collection, swallowing errors into the EntitySet so one failure
 *  doesn't abort the whole topology load (licences gate some endpoints). */
async function fetchSet(path: string): Promise<EntitySet> {
  try {
    const value = (await getCollection(path)) as Record<string, unknown>[]
    return { path, value }
  } catch (err) {
    return { path, value: [], error: (err as Error).message }
  }
}

export async function fetchTopology(): Promise<Topology> {
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
    groups
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
    fetchSet('/xapi/v1/Groups?$expand=Members')
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
    groups: groups2
  })
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

/** Parse a duration expressed as seconds, or "HH:MM:SS" / "MM:SS", into seconds.
 *  Exported for unit testing. */
export function parseDuration(s: string): number {
  if (!s) return 0
  if (/^\d+$/.test(s)) return Number(s)
  const parts = s.split(':').map((p) => Number(p))
  if (parts.some((n) => Number.isNaN(n))) {
    const f = Number(s)
    return Number.isNaN(f) ? 0 : f
  }
  return parts.reduce((acc, n) => acc * 60 + n, 0)
}

/** Numbers that look like an internal extension (short, all-digit). Exported for tests. */
export function isExtensionLike(s: string): boolean {
  return /^\d{2,6}$/.test(s.trim())
}

/** Normalise one raw 3CX call-log / active-call record into a CallLogEntry.
 *  Field names differ across 3CX versions, so every field is best-effort.
 *  Exported for unit testing. */
export function normalizeCallEntry(raw: Obj): CallLogEntry {
  const from = pickField(
    raw,
    'SrcCallerNumber',
    'SourceCallerId',
    'CallerNumber',
    'SrcDn',
    'SourceDn',
    'From',
    'Caller',
    'CallerId'
  )
  const to = pickField(
    raw,
    'DstCallerNumber',
    'DestinationCallerId',
    'DstDn',
    'DestinationDn',
    'To',
    'Callee',
    'Destination'
  )
  const start = pickField(
    raw,
    'StartTime',
    'TimeStart',
    'SegmentStartTime',
    'EstablishedAt',
    'Time',
    'StartedAt'
  )
  const durStr = pickField(raw, 'TalkDuration', 'Duration', 'TalkingDuration', 'RingingDuration')
  const durationSec = parseDuration(durStr)
  const status = pickField(raw, 'Status', 'CallState', 'State', 'Result', 'Reason')
  const answeredFlag = pickField(raw, 'Answered', 'IsAnswered')
  // Order matters: check the NEGATIVE statuses first, because "Unanswered"
  // contains the substring "answered" and would otherwise be read as answered.
  let answered: boolean
  if (/^(true|1|yes)$/i.test(answeredFlag)) answered = true
  else if (/^(false|0|no)$/i.test(answeredFlag)) answered = false
  else if (/unanswered|missed|no ?answer|abandon|fail|cancel|busy|declin/i.test(status))
    answered = false
  else if (/answered|talking|connected|established|completed|routing/i.test(status)) answered = true
  else answered = durationSec > 0
  const direction = pickField(raw, 'CallType', 'Direction', 'Type')
  return {
    startTime: start || undefined,
    from: from || undefined,
    to: to || undefined,
    answered,
    durationSec: durationSec || undefined,
    direction: direction || undefined,
    raw
  }
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

/** Fetch a historical call-activity report for [fromISO, toISO]. Degrades to an
 *  empty, error-tagged report when no endpoint is available (licence-gated). */
export async function fetchCallReport(fromISO: string, toISO: string): Promise<CallReport> {
  if (!session) throw new Error('Not connected.')
  let rawRecords: unknown[] = []
  let lastError = ''
  for (const tpl of CALL_LOG_ENDPOINTS) {
    const path = tpl
      .replace('{from}', encodeURIComponent(fromISO))
      .replace('{to}', encodeURIComponent(toISO))
    try {
      rawRecords = await getCollection(path)
      lastError = ''
      if (rawRecords.length) break
    } catch (err) {
      lastError = (err as Error).message
    }
  }
  const entries = rawRecords.filter(isObj).map((r) => normalizeCallEntry(r as Obj))
  return redactSecrets<CallReport>({
    kind: 'call-report',
    generatedAt: new Date().toISOString(),
    baseUrl: session.baseUrl,
    live: false,
    from: fromISO,
    to: toISO,
    entries,
    perExtension: rollupByExtension(entries),
    error: entries.length ? undefined : lastError || 'No call-log data returned for this period.'
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
    error = (err as Error).message
  }
  const entries = rawRecords.filter(isObj).map((r) => normalizeCallEntry(r as Obj))
  return redactSecrets<CallReport>({
    kind: 'call-report',
    generatedAt: new Date().toISOString(),
    baseUrl: session.baseUrl,
    live: true,
    entries,
    perExtension: rollupByExtension(entries),
    error: error || undefined
  })
}

function truncate(s: string, n = 200): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}
