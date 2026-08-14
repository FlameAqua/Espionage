// Reads per-queue agent login state out of the 3CX web client's Switchboard.
//
// WHY SCRAPE: the configuration API (/xapi/v1/Queues?$expand=Agents) returns only
// Number / Name / SkillGroup / Tags / Id for each agent — it has no per-queue
// login field. The login a supervisor toggles per queue lives in the realtime
// MyPhone service (/MyPhone/MPWebService.asmx), which is an undocumented binary
// protocol on a separate session. The Switchboard page renders exactly the state
// we want, so we let 3CX's own client do the talking and read the result.
//
// NOT CURRENTLY ENABLED. It works — auth, routing and parsing are all confirmed
// against a live v20 system — but it does not scale. The Switchboard shows one
// queue at a time and each queue's agent states arrive over the realtime channel
// after that route subscribes, so the cost is a PBX round-trip per queue. On a
// small system that's a few seconds; on a 40-queue system it ran to ~60s per
// queue and blew any sane budget. Reading every queue on each refresh is
// therefore not viable, and `fetchTopology` no longer asks for it.
//
// Kept (with tests) because it is the only known source of per-queue login state
// and remains usable for ONE queue on demand — a few seconds, paid only when
// someone is actually looking at that queue. Wire it to a per-queue action if
// that's wanted; don't put it back on the refresh path.
//
// Best-effort and fails soft: on any problem the caller gets an error string and
// the app falls back to the extension-wide status. It reads only; nothing is
// ever clicked or changed.

import { BrowserWindow, session as electronSession } from 'electron'
import type { ConnectRequest } from '../../shared/types'

export interface QueueAgentLogin {
  extension: string
  loggedIn: boolean
  /** Free-text timestamp shown beside the state, e.g. "23/06/2026 03:38". */
  since?: string
}

export interface SwitchboardResult {
  /** Queue entity Id (matches the xapi Queues `Id`) → its agents' login state. */
  byQueue: Map<string, QueueAgentLogin[]>
  error?: string
}

/** One queue to visit: its entity Id drives the route, its Number confirms the
 *  page actually switched before we read the list. */
export interface QueueTarget {
  id: string
  number: string
}

/** Isolated partition so the scrape never disturbs (or is disturbed by) any other
 *  window state, and is thrown away with the window. */
const PARTITION = 'espionage-switchboard'

const NAV_TIMEOUT_MS = 20_000
const ROUTE_TIMEOUT_MS = 6_000
const RENDER_TIMEOUT_MS = 6_000
/** Whole-scrape budget. Nothing here may ever block a topology fetch for longer
 *  than this — an earlier version had no cap and a stalled navigation left the
 *  app spinning on the loading screen forever. */
export const SCRAPE_BUDGET_MS = 120_000
/** Hard cap so a system with dozens of queues can't blow the budget on nav alone. */
const MAX_QUEUES = 40

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Reject if `p` hasn't settled in time, so no single await can stall forever. */
async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_res, rej) => {
        timer = setTimeout(() => rej(new Error(`timed out ${what}`)), ms)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Change the SPA route from inside the page. Route changes are hash-only, which
 *  is a SAME-DOCUMENT navigation — Electron's loadURL() may never resolve for
 *  those, so never use it here; callers poll for arrival instead. */
async function gotoHash(win: BrowserWindow, hash: string): Promise<void> {
  await withTimeout(
    win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}; true`, true),
    5_000,
    'changing the Switchboard route'
  )
}

/** Read the agent tiles currently rendered on a Switchboard queue page.
 *  `data-id` hooks are 3CX's own test attributes, so they're the most stable
 *  selectors available; `.queue-tile` scopes us to the agent list. */
const READ_TILES_JS = `(() => {
  const tiles = Array.from(document.querySelectorAll('li.queue-tile'))
  return tiles.map((li) => {
    const ext = li.querySelector('[data-id="extPhone"]')
    const name = li.querySelector('[data-id="extName"]')
    const status = li.querySelector('.status')
    return {
      extension: (ext && ext.textContent || '').trim(),
      name: (name && name.textContent || '').trim(),
      status: (status && status.textContent || '').replace(/\\s+/g, ' ').trim()
    }
  })
})()`

const ROUTE_TITLE_JS = `(() => {
  const t = document.querySelector('app-route-title')
  return (t && t.textContent || '').trim()
})()`

/** Queue ids the Switchboard actually offers, from its own queue picker.
 *  The signed-in account only supervises a subset of the queues the config API
 *  returns, and a queue that isn't in this list never renders an agent list — so
 *  visiting it just burns two timeouts. Reading the picker first turns a 29-queue
 *  crawl into a 9-queue one. */
/** How many agent rows currently show a login state. */
const LABELLED_TILES_JS = `Array.from(document.querySelectorAll('li.queue-tile'))
  .filter((li) => /logged/i.test(((li.querySelector('.status') || {}).textContent) || '')).length`

const QUEUE_LINKS_JS = `(() => {
  const ids = []
  document.querySelectorAll('a[href*="/switchboard/queues/"]').forEach((a) => {
    const m = /queues\\/(\\d+)/.exec(a.getAttribute('href') || '')
    if (m) ids.push(m[1])
  })
  return Array.from(new Set(ids))
})()`

/** What the page actually looks like when we found nothing. Reported back so a
 *  failure says WHY (not signed in / different markup / never routed) instead of
 *  just "couldn't read it". Deliberately gathers no values — only key names and
 *  a short text snippet — so nothing sensitive is logged. */
const DIAGNOSE_JS = `(() => {
  const text = ((document.body && document.body.innerText) || '').replace(/\\s+/g, ' ').trim()
  let keys = []
  try { keys = Object.keys(window.localStorage || {}) } catch (e) { keys = ['<blocked>'] }
  const title = document.querySelector('app-route-title')
  return {
    url: location.href,
    routeTitle: (title && title.textContent || '').trim(),
    tiles: document.querySelectorAll('li.queue-tile').length,
    tilesLoose: document.querySelectorAll('[class*="queue-tile"]').length,
    agentsHost: document.querySelectorAll('queue-agents').length,
    hasPasswordInput: !!document.querySelector('input[type="password"]'),
    storageKeys: keys.slice(0, 25),
    text: text.slice(0, 180)
  }
})()`

interface Diagnosis {
  url: string
  routeTitle: string
  tiles: number
  tilesLoose: number
  agentsHost: number
  hasPasswordInput: boolean
  storageKeys: string[]
  text: string
}

/** Turn a diagnosis into a short, actionable sentence. */
function explain(d: Diagnosis | null): string {
  if (!d) return 'The web client page could not be inspected.'
  if (d.hasPasswordInput)
    return `The web client showed a sign-in page instead of the Switchboard (url ${d.url}), so the hidden session was not authenticated. Storage keys seen: ${d.storageKeys.join(', ') || 'none'}.`
  if (!d.agentsHost)
    return `The Switchboard agent list never rendered (url ${d.url}, route "${d.routeTitle}"). Page text began: "${d.text}".`
  if (!d.tiles && d.tilesLoose)
    return `Agent rows exist but not as "li.queue-tile" (${d.tilesLoose} loose matches) - this 3CX build changed the markup.`
  return `No agent rows found (url ${d.url}, route "${d.routeTitle}", agents host present). Page text began: "${d.text}".`
}

/** One agent tile as read out of the DOM. */
export interface RawTile {
  extension: string
  name: string
  status: string
}

/** "Logged Out 23/06/2026 03:38" → { loggedIn: false, since: '23/06/2026 03:38' }.
 *  Checked out-first because "Logged Out" also contains "Logged". */
function parseTile(tile: RawTile): QueueAgentLogin | null {
  if (!tile.extension) return null
  const s = tile.status
  let loggedIn: boolean
  if (/logged\s*out/i.test(s)) loggedIn = false
  else if (/logged\s*in/i.test(s)) loggedIn = true
  else return null // some other state (or not rendered yet) — don't guess
  const since = s.replace(/logged\s*(in|out)/i, '').trim()
  return { extension: tile.extension, loggedIn, since: since || undefined }
}

/** Parse a page's worth of tiles, dropping any we can't read confidently.
 *  Exported so the DOM contract can be tested without a browser. */
export function parseAgentTiles(tiles: RawTile[]): QueueAgentLogin[] {
  return (tiles ?? []).map(parseTile).filter((a): a is QueueAgentLogin => !!a)
}

/** Log the hidden window's own session in, so the SPA boots authenticated. We
 *  POST the same endpoint the app uses, but from inside the page, so the
 *  refresh cookie 3CX sets lands in this partition. */
async function loginInPage(win: BrowserWindow, req: ConnectRequest): Promise<void> {
  const payload = JSON.stringify({
    Username: req.username,
    Password: req.password,
    SecurityCode: req.securityCode ?? ''
  })
  // JSON.stringify again so the credentials cross into the page as a string
  // literal rather than being interpolated as raw code.
  const js = `(async () => {
    const res = await fetch('/webclient/api/Login/GetAccessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: ${JSON.stringify(payload)},
      credentials: 'include'
    })
    return res.status
  })()`
  const status = (await win.webContents.executeJavaScript(js, true)) as number
  if (status === 401 || status === 403) throw new Error('Login rejected by the web client.')
  if (status < 200 || status >= 300) throw new Error(`Web client login failed (HTTP ${status}).`)
}

/** How often the page is polled. Small, because each poll is a cheap in-process
 *  IPC call and the interval is otherwise dead time on every single queue. */
const POLL_MS = 120

/** Wait until `check` returns true, polling the page. */
async function waitFor(
  win: BrowserWindow,
  js: string,
  check: (v: unknown) => boolean,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (win.isDestroyed()) return false
    try {
      const v = await win.webContents.executeJavaScript(js, true)
      if (check(v)) return true
    } catch {
      /* page mid-navigation — retry */
    }
    await sleep(POLL_MS)
  }
  return false
}

/** Wait for a count to reach at least `min` and then stop changing.
 *
 *  Rows render before their login labels arrive over the realtime channel, so
 *  "settled" is the real signal — waiting for it beats both a fixed delay (a
 *  guess that's either wasteful or too short) and waiting for an expected total
 *  (which assumes the Switchboard lists exactly what the config API does). */
async function waitForStableCount(
  win: BrowserWindow,
  js: string,
  min: number,
  timeoutMs: number
): Promise<number> {
  const deadline = Date.now() + timeoutMs
  let last = -1
  let stableSince = 0
  const STABLE_FOR_MS = 3 * POLL_MS
  while (Date.now() < deadline) {
    if (win.isDestroyed()) return Math.max(0, last)
    let v = -1
    try {
      v = Number(await win.webContents.executeJavaScript(js, true))
    } catch {
      /* page mid-navigation — retry */
    }
    if (Number.isFinite(v) && v === last) {
      if (v >= min && Date.now() - stableSince >= STABLE_FOR_MS) return v
    } else {
      last = v
      stableSince = Date.now()
    }
    await sleep(POLL_MS)
  }
  return Math.max(0, last)
}

/**
 * Visit each queue's Switchboard page and read its agents' login state.
 * Never throws: problems come back as `error` with whatever was gathered.
 */
export async function scrapeQueueAgentLogins(
  baseUrl: string,
  req: ConnectRequest,
  queues: QueueTarget[],
  allowInsecure: boolean
): Promise<SwitchboardResult> {
  const byQueue = new Map<string, QueueAgentLogin[]>()
  const targets = queues.filter((q) => q.id).slice(0, MAX_QUEUES)
  if (!targets.length) return { byQueue }

  const part = electronSession.fromPartition(PARTITION)
  // 3CX boxes commonly use self-signed certs; honour the same choice the user
  // made when connecting rather than failing the whole scrape on it.
  part.setCertificateVerifyProc((_request, callback) => callback(allowInsecure ? 0 : -3))

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      partition: PARTITION,
      // Read-only scrape of a remote SPA: no bridge into this app.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false
    }
  })

  const deadline = Date.now() + SCRAPE_BUDGET_MS
  const left = (): number => deadline - Date.now()

  try {
    // The login fetch just needs a same-origin document to run from. Loading the
    // SPA here would cost a full Angular boot that the post-login load throws
    // away, so try a static asset first and only fall back to the SPA.
    let onOrigin = false
    try {
      await withTimeout(
        win.loadURL(`${baseUrl}/webclient/manifest.webmanifest`),
        8_000,
        'reaching the web client'
      )
      onOrigin = true
    } catch {
      /* not served / rejected — fall back below */
    }
    if (!onOrigin) {
      await withTimeout(win.loadURL(`${baseUrl}/`), NAV_TIMEOUT_MS, 'loading the web client')
    }
    // The login endpoint is an absolute path, so it works from either document.
    await withTimeout(loginInPage(win, req), NAV_TIMEOUT_MS, 'signing in to the web client')
    // Now boot the SPA exactly once, already authenticated.
    await withTimeout(win.loadURL(`${baseUrl}/`), NAV_TIMEOUT_MS, 'loading the web client')
    // Don't race the Angular bootstrap: wait until the shell nav exists, or the
    // first route change can be swallowed before the router is listening.
    await waitFor(
      win,
      `!!document.querySelector('[data-qa="switchboard-link"]') || !!document.querySelector('app-nav')`,
      (v) => v === true,
      NAV_TIMEOUT_MS
    )

    // Ask the Switchboard which queues it can actually show, and skip the rest.
    await gotoHash(win, '#/switchboard')
    await waitFor(
      win,
      `document.querySelectorAll('a[href*="/switchboard/queues/"]').length`,
      (v) => typeof v === 'number' && v > 0,
      ROUTE_TIMEOUT_MS
    )
    let offered: string[] = []
    try {
      offered = (await win.webContents.executeJavaScript(QUEUE_LINKS_JS, true)) as string[]
    } catch {
      /* fall through to visiting everything */
    }
    const offeredSet = new Set(offered)
    // Only narrow when the picker was actually found, so an unreadable picker
    // degrades to the old behaviour instead of reading nothing.
    const visitable = (offeredSet.size ? targets.filter((q) => offeredSet.has(q.id)) : targets).slice(
      0,
      MAX_QUEUES
    )
    const skipped = targets.length - visitable.length

    let lastTitle = ''
    let ranOut = false
    for (const q of visitable) {
      if (left() <= 0) {
        ranOut = true
        break
      }
      await gotoHash(win, `#/switchboard/queues/${q.id}`)
      // The route title carries the queue number, so it confirms we're reading
      // the queue we asked for and not the previous one's stale tiles.
      const titled = await waitFor(
        win,
        ROUTE_TITLE_JS,
        (v) => typeof v === 'string' && v.includes(q.number) && v !== lastTitle,
        Math.min(ROUTE_TIMEOUT_MS, Math.max(0, left()))
      )
      if (!titled) continue // never arrived; skip rather than read the wrong queue
      lastTitle = String(await win.webContents.executeJavaScript(ROUTE_TITLE_JS, true))
      // Wait for the labelled-row count to settle, then read immediately — no
      // fixed delay, so a fast queue costs only what it actually needs.
      await waitForStableCount(
        win,
        LABELLED_TILES_JS,
        1,
        Math.min(RENDER_TIMEOUT_MS, Math.max(0, left()))
      )
      const tiles = (await win.webContents.executeJavaScript(READ_TILES_JS, true)) as RawTile[]
      const parsed = parseAgentTiles(tiles)
      if (parsed.length) byQueue.set(q.id, parsed)
    }

    if (!byQueue.size) {
      // Nothing came back — say what the page actually showed, so this is one
      // diagnosis rather than a guessing game.
      let diag: Diagnosis | null = null
      try {
        diag = (await withTimeout(
          win.webContents.executeJavaScript(DIAGNOSE_JS, true),
          5_000,
          'inspecting the web client'
        )) as Diagnosis
      } catch {
        /* leave null */
      }
      // Also to the main-process log, where the full detail is easy to copy.
      console.warn('[switchboard] per-queue login read found nothing:', diag)
      return {
        byQueue,
        error: `Per-queue logins unavailable - ${explain(diag)} Falling back to the extension-wide status.`
      }
    }
    if (ranOut) {
      return {
        byQueue,
        error: `Per-queue logins timed out after reading ${byQueue.size} of ${visitable.length} queues the Switchboard offers.`
      }
    }
    // Queues the signed-in account can't supervise simply keep the
    // extension-wide status; that's expected, not a failure.
    if (skipped) {
      console.info(
        `[switchboard] read ${byQueue.size} queues; skipped ${skipped} not offered by the Switchboard`
      )
    }
    return { byQueue }
  } catch (err) {
    return { byQueue, error: `Per-queue login read failed: ${(err as Error).message}` }
  } finally {
    if (!win.isDestroyed()) win.destroy()
    // Drop the scrape session's cookies; it exists only for this read.
    try {
      await part.clearStorageData()
    } catch {
      /* non-fatal */
    }
  }
}
