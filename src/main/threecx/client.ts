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
import type { ConnectRequest, EntitySet, Topology } from '../../shared/types'

interface Session {
  baseUrl: string
  token: string
  allowInsecure: boolean
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

export async function connect(req: ConnectRequest): Promise<void> {
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

  session = { baseUrl, token, allowInsecure: req.allowInsecure }
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
    fetchSet('/xapi/v1/Users?$expand=Groups'),
    fetchSet('/xapi/v1/Queues?$expand=Agents,Managers'),
    fetchSet('/xapi/v1/RingGroups?$expand=Members'),
    fetchSet('/xapi/v1/Receptionists'),
    fetchSet('/xapi/v1/InboundRules'),
    fetchSet('/xapi/v1/OutboundRules'),
    fetchSet('/xapi/v1/DidNumbers'),
    fetchSet('/xapi/v1/Trunks'),
    fetchSet('/xapi/v1/Groups?$expand=Members')
  ])

  // Several endpoints reject $expand on some 3CX builds; retry bare on failure.
  const retried = await Promise.all(
    [queues, ringGroups, groups, users].map(async (set) => {
      if (!set.error) return set
      const bare = set.path.split('?')[0]
      return fetchSet(bare)
    })
  )
  const [queues2, ringGroups2, groups2, users2] = retried

  return {
    fetchedAt: new Date().toISOString(),
    baseUrl: session.baseUrl,
    users: users2,
    queues: queues2,
    ringGroups: ringGroups2,
    receptionists,
    inboundRules,
    outboundRules,
    didNumbers,
    trunks,
    groups: groups2
  }
}

function truncate(s: string, n = 200): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}
