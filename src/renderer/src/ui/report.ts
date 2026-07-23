// The call-activity report UI: a period picker, and an interactive modal that
// summarises a CallReport with stat tiles, inline SVG charts and a searchable
// per-extension table.
//
// Beyond raw counts it classifies every call by direction (inbound / outbound /
// internal) and, relative to a chosen home country, by scope (national /
// international) and destination country. A row of dropdowns re-slices the whole
// view live — pick a direction, a scope, a country, or change what the main
// chart is grouped by — all without re-fetching, because classification runs in
// the renderer from the saved entries (see ../../../shared/phone).
//
// Reports are fetched + persisted by the main process (see report:* IPC); this
// module only renders and drives save/open.

import type { CallReport, ExtensionActivity } from '../../../shared/types'
import type { CallDirection, CallScope } from '../../../shared/phone'
import {
  CALLING_CODES,
  callingCodeForIso,
  classifyDirection,
  classifyScope,
  parseInternational,
  pickParties
} from '../../../shared/phone'

const esc = (s: unknown): string =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )

const btn = 'px-3 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-sm text-slate-100'
const HOME_KEY = 'espionage.homeCountry'

/** Transient toast, matching the app's flash style. */
function flash(message: string, isError = false): void {
  const el = document.createElement('div')
  el.className = `fixed bottom-4 left-1/2 -translate-x-1/2 z-[120] px-3 py-1.5 rounded-md text-sm shadow-lg ${
    isError ? 'bg-red-600 text-white' : 'bg-slate-800 text-slate-100 dark:bg-slate-700'
  }`
  el.textContent = message
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 2800)
}

/** Mount an overlay modal on document.body and return {overlay, close}. */
function openOverlay(
  inner: string,
  width = 'w-[960px]'
): { overlay: HTMLElement; close: () => void } {
  const overlay = document.createElement('div')
  overlay.className = 'fixed inset-0 z-[110] flex items-center justify-center bg-black/40 p-4'
  overlay.innerHTML = `
    <div class="${width} max-w-full max-h-[88vh] flex flex-col bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-lg shadow-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
      ${inner}
    </div>`
  document.body.appendChild(overlay)
  const close = (): void => overlay.remove()
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close()
  })
  return { overlay, close }
}

/** Period picker → generate a historical report, then show it. */
export function showReportSetup(nameFor: (ext: string) => string | undefined): void {
  const { overlay, close } = openOverlay(
    `
    <div class="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-700">
      <h2 class="font-semibold text-slate-800 dark:text-slate-100">Generate report</h2>
      <button data-close class="text-slate-400 hover:text-slate-700 dark:hover:text-slate-100 text-lg leading-none">✕</button>
    </div>
    <div class="p-4 space-y-4 text-sm">
      <div>
        <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Period</label>
        <div class="flex flex-wrap gap-1.5" id="periodPresets">
          <button data-days="7" class="${btn}">Last 7 days</button>
          <button data-days="30" class="${btn} bg-sky-700 hover:bg-sky-600">Last 30 days</button>
          <button data-days="90" class="${btn}">Last 90 days</button>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="block text-xs text-slate-500 mb-1">From</label>
          <input id="fromDate" type="date" class="w-full px-2 py-1.5 rounded bg-slate-100 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-sm" />
        </div>
        <div>
          <label class="block text-xs text-slate-500 mb-1">To</label>
          <input id="toDate" type="date" class="w-full px-2 py-1.5 rounded bg-slate-100 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-sm" />
        </div>
      </div>
      <div>
        <label class="block text-xs text-slate-500 mb-1">Home country
          <span class="text-slate-400 normal-case">— baseline for national vs international</span>
        </label>
        ${countrySelect('setupHome', readHomeCountry(), true)}
      </div>
      <p class="text-xs text-slate-400">A call-log snapshot for this period is fetched from 3CX and saved to your reports folder.</p>
      <div class="flex justify-end gap-2 pt-1">
        <button data-close class="${btn} bg-slate-500 hover:bg-slate-400">Cancel</button>
        <button id="genBtn" class="${btn} bg-emerald-600 hover:bg-emerald-500">Generate</button>
      </div>
    </div>`,
    'w-[460px]'
  )
  overlay
    .querySelectorAll<HTMLElement>('[data-close]')
    .forEach((b) => b.addEventListener('click', close))

  const fromEl = overlay.querySelector<HTMLInputElement>('#fromDate')!
  const toEl = overlay.querySelector<HTMLInputElement>('#toDate')!
  const iso = (d: Date): string => d.toISOString().slice(0, 10)
  const setRange = (days: number): void => {
    const to = new Date()
    const from = new Date()
    from.setDate(from.getDate() - days)
    fromEl.value = iso(from)
    toEl.value = iso(to)
  }
  setRange(30)
  overlay.querySelectorAll<HTMLElement>('#periodPresets [data-days]').forEach((b) => {
    b.addEventListener('click', () => setRange(Number(b.dataset.days)))
  })

  // Remember the home-country choice so classification is meaningful next time.
  const homeSel = overlay.querySelector<HTMLSelectElement>('#setupHome')!
  homeSel.addEventListener('change', () => writeHomeCountry(homeSel.value))

  overlay.querySelector('#genBtn')!.addEventListener('click', async () => {
    const from = fromEl.value ? new Date(fromEl.value + 'T00:00:00Z').toISOString() : ''
    const to = toEl.value ? new Date(toEl.value + 'T23:59:59Z').toISOString() : ''
    if (!from || !to) {
      flash('Pick a from and to date.', true)
      return
    }
    const genBtn = overlay.querySelector<HTMLButtonElement>('#genBtn')!
    genBtn.disabled = true
    genBtn.textContent = 'Generating…'
    const res = await window.api.report.generate(from, to)
    close()
    if (res.error && !res.report) {
      flash(res.error, true)
      return
    }
    if (res.report) showReport(res.report, nameFor)
  })
}

/** Fetch + show a live active-calls report. */
export async function showLiveReport(nameFor: (ext: string) => string | undefined): Promise<void> {
  const res = await window.api.report.live()
  if (res.error && !res.report) {
    flash(res.error, true)
    return
  }
  if (res.report) showReport(res.report, nameFor)
}

/** Open a previously-saved report from disk and show it. */
export async function openReport(nameFor: (ext: string) => string | undefined): Promise<void> {
  const res = await window.api.report.open()
  if (res.canceled) return
  if (res.error || !res.report) {
    flash(res.error ?? 'Could not open report.', true)
    return
  }
  showReport(res.report, nameFor)
}

// --- Classification ---------------------------------------------------------

interface ClassifiedCall {
  callId?: string
  ts?: string
  day?: string
  hour?: number
  direction: CallDirection
  scope: CallScope | 'unknown'
  country: string
  trunk?: string
  extension?: string
  external?: string
  answered: boolean
  durationSec: number
}

interface Home {
  iso2: string
  code: string
  name: string
}

function resolveHome(iso2: string): Home {
  const c = iso2 ? callingCodeForIso(iso2) : undefined
  return { iso2, code: c?.code ?? '', name: c?.country ?? '' }
}

/** Re-derive every call from the raw entries under the chosen home country. Done
 *  in the renderer (not read from the file) so the dropdowns can reclassify live
 *  and older saved reports without the enrichment fields still work. */
function classify(report: CallReport, home: Home): ClassifiedCall[] {
  return report.entries.map((e) => {
    // Prefer the classification the main process stored (it sees 3CX's separate
    // DN and caller-id fields); recompute from from/to only for older reports
    // saved before those fields existed.
    const direction = e.directionNorm ?? classifyDirection(e.from, e.to, e.direction)
    const fallback = e.directionNorm ? null : pickParties(e.from, e.to, direction)
    const extension = e.extension ?? fallback?.extension
    const external = e.external ?? fallback?.external
    const intl = e.intlCode
      ? { code: e.intlCode, iso2: '', country: e.country ?? `Unknown (+${e.intlCode})` }
      : parseInternational(external)
    const sc = classifyScope(direction, intl, home.code, home.name)
    const start = e.startTime
    const hour = start && start.length >= 13 ? Number(start.slice(11, 13)) : undefined
    return {
      callId: e.callId,
      ts: start,
      day: start ? start.slice(0, 10) : undefined,
      hour: Number.isFinite(hour) ? hour : undefined,
      direction,
      scope: direction === 'internal' ? 'internal' : sc.scope,
      country: sc.country,
      trunk: e.trunk,
      extension,
      external,
      answered: !!e.answered,
      durationSec: e.durationSec ?? 0
    }
  })
}

/** Collapse the routing legs of each call (queue → IVR → extension) into one
 *  logical call: the terminating leg (latest, reaching an extension) represents
 *  it, the call counts as answered if any leg was, and talk time is the handling
 *  leg's. Legs without a call id (older reports, other endpoints) pass through. */
function collapseToCalls(calls: ClassifiedCall[]): ClassifiedCall[] {
  const groups = new Map<string, ClassifiedCall[]>()
  const out: ClassifiedCall[] = []
  for (const c of calls) {
    if (!c.callId) {
      out.push(c)
      continue
    }
    const g = groups.get(c.callId)
    if (g) g.push(c)
    else groups.set(c.callId, [c])
  }
  for (const legs of groups.values()) {
    if (legs.length === 1) {
      out.push(legs[0])
      continue
    }
    const withExt = legs.filter((l) => l.extension)
    const pool = withExt.length ? withExt : legs
    const rep = pool.reduce((a, b) => ((a.ts ?? '') >= (b.ts ?? '') ? a : b))
    out.push({ ...rep, answered: legs.some((l) => l.answered) })
  }
  return out
}

// --- Report view ------------------------------------------------------------

type GroupBy = 'extension' | 'day' | 'country' | 'trunk' | 'direction' | 'scope' | 'hour'

interface ViewState {
  home: string // ISO2, '' = not set
  detail: 'call' | 'leg' // composite call vs per routing-leg
  direction: CallDirection | 'all'
  scope: CallScope | 'all'
  country: string // 'all' or a country label
  status: 'all' | 'answered' | 'missed'
  groupBy: GroupBy
  search: string
}

/** The classified calls at the chosen granularity (composite vs per-leg). */
function callsFor(report: CallReport, state: ViewState, home: Home): ClassifiedCall[] {
  const all = classify(report, home)
  return state.detail === 'call' ? collapseToCalls(all) : all
}

/** Render a report into an interactive modal. */
export function showReport(report: CallReport, nameFor: (ext: string) => string | undefined): void {
  const title = report.live
    ? 'Live report — active calls'
    : `Report — ${fmtDate(report.from)} → ${fmtDate(report.to)}`

  const state: ViewState = {
    home: report.homeCountry || readHomeCountry(),
    detail: report.live ? 'leg' : 'call',
    direction: 'all',
    scope: 'all',
    country: 'all',
    status: 'all',
    groupBy: report.live ? 'extension' : 'day',
    search: ''
  }

  const { overlay, close } = openOverlay(`
    <div class="flex items-center justify-between gap-2 px-4 py-3 border-b border-slate-200 dark:border-slate-700 shrink-0">
      <div class="min-w-0">
        <h2 class="font-semibold text-slate-800 dark:text-slate-100 truncate">${esc(title)}</h2>
        <p class="text-[11px] text-slate-400">Generated ${esc(fmtDateTime(report.generatedAt))}${report.baseUrl ? ` · ${esc(report.baseUrl.replace(/^https?:\/\//, ''))}` : ''}</p>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <div class="relative">
          <button id="exportBtn" class="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-100 text-xs">Export ▾</button>
          <div id="exportMenu" class="hidden absolute right-0 mt-1 z-[130] w-48 rounded-md bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shadow-lg overflow-hidden text-xs text-slate-700 dark:text-slate-200">
            <button data-export="calls-csv" class="block w-full text-left px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-700">Calls → CSV</button>
            <button data-export="ext-csv" class="block w-full text-left px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-700">Per-extension → CSV</button>
            <button data-export="pdf" class="block w-full text-left px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-700">Report → PDF</button>
          </div>
        </div>
        <button id="saveReport" class="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-100 text-xs">Save</button>
        <button data-close class="text-slate-400 hover:text-slate-700 dark:hover:text-slate-100 text-lg leading-none">✕</button>
      </div>
    </div>
    ${controlsBar(report, state)}
    <div id="reportBody" class="overflow-y-auto p-4 space-y-4"></div>`)

  overlay
    .querySelectorAll<HTMLElement>('[data-close]')
    .forEach((b) => b.addEventListener('click', close))
  overlay.querySelector('#saveReport')!.addEventListener('click', async () => {
    const res = await window.api.report.save(report)
    if (res.error) flash(res.error, true)
    else if (res.path) flash('Report saved.')
  })

  // Export menu: CSV of calls / per-extension, or a PDF of the current view.
  const exportBtn = overlay.querySelector<HTMLButtonElement>('#exportBtn')!
  const exportMenu = overlay.querySelector<HTMLElement>('#exportMenu')!
  exportBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    exportMenu.classList.toggle('hidden')
  })
  overlay.addEventListener('click', () => exportMenu.classList.add('hidden'))
  exportMenu.addEventListener('click', (e) => e.stopPropagation())
  for (const item of exportMenu.querySelectorAll<HTMLButtonElement>('[data-export]')) {
    item.addEventListener('click', () => {
      exportMenu.classList.add('hidden')
      void runExport(item.dataset.export as ExportKind, report, state, nameFor)
    })
  }

  const bodyEl = overlay.querySelector<HTMLElement>('#reportBody')!

  const rerender = (): void => {
    const home = resolveHome(state.home)
    bodyEl.innerHTML = renderBody(report, callsFor(report, state, home), state, home, nameFor)
    wireSearch(bodyEl, report, state, nameFor, home)
  }

  // Dropdowns re-slice the whole view. The home selector also persists so the
  // next report opens with the same baseline.
  for (const sel of overlay.querySelectorAll<HTMLSelectElement>('[data-control]')) {
    sel.addEventListener('change', () => {
      const key = sel.dataset.control as keyof ViewState
      ;(state as unknown as Record<string, string>)[key] = sel.value
      if (key === 'home') writeHomeCountry(sel.value)
      if (key === 'home' || key === 'detail' || key === 'direction' || key === 'scope') {
        // Country options depend on home/granularity; direction=internal drops
        // country, etc. Reset the filter to avoid a stale, now-empty selection.
        state.country = 'all'
      }
      rerender()
      if (key === 'home' || key === 'detail') refreshCountryOptions(overlay, report, state)
    })
  }

  rerender()
}

/** The sticky row of dropdowns above the report body. */
function controlsBar(report: CallReport, state: ViewState): string {
  const groupOpts: Array<[GroupBy, string]> = [
    ['extension', 'Extension'],
    ['country', 'Country'],
    ['trunk', 'Trunk'],
    ['direction', 'Direction'],
    ['scope', 'National / Intl'],
    ['hour', 'Hour of day']
  ]
  if (!report.live) groupOpts.splice(1, 0, ['day', 'Day'])
  return `
    <div class="shrink-0 flex flex-wrap items-end gap-x-3 gap-y-2 px-4 py-2.5 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40 text-xs">
      ${field('Home country', countrySelect('ctlHome', state.home, true, 'home'))}
      ${field(
        'Rows',
        select('ctlDetail', 'detail', state.detail, [
          ['call', 'By call'],
          ['leg', 'By leg (queue/IVR)']
        ])
      )}
      ${field(
        'Direction',
        select('ctlDir', 'direction', state.direction, [
          ['all', 'All'],
          ['inbound', 'Inbound'],
          ['outbound', 'Outbound'],
          ['internal', 'Internal']
        ])
      )}
      ${field(
        'Scope',
        select('ctlScope', 'scope', state.scope, [
          ['all', 'All'],
          ['national', 'National'],
          ['international', 'International'],
          ['internal', 'Internal']
        ])
      )}
      ${field('Country', countryFilterSelect(report, state))}
      ${field(
        'Status',
        select('ctlStatus', 'status', state.status, [
          ['all', 'All'],
          ['answered', 'Answered'],
          ['missed', 'Missed']
        ])
      )}
      ${field('Chart by', select('ctlGroup', 'groupBy', state.groupBy, groupOpts))}
    </div>`
}

function field(label: string, control: string): string {
  return `<label class="flex flex-col gap-0.5">
    <span class="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">${esc(label)}</span>
    ${control}
  </label>`
}

const selCls =
  'px-2 py-1 rounded bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 text-xs text-slate-700 dark:text-slate-200'

function select(
  id: string,
  control: string,
  value: string,
  options: Array<[string, string]>
): string {
  const opts = options
    .map(
      ([v, l]) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(l)}</option>`
    )
    .join('')
  return `<select id="${id}" data-control="${control}" class="${selCls}">${opts}</select>`
}

/** A full country picker (used for the home-country baseline). */
function countrySelect(id: string, value: string, includeNone: boolean, control?: string): string {
  const none = includeNone ? `<option value=""${value ? '' : ' selected'}>— none —</option>` : ''
  const opts = CALLING_CODES.map(
    (c) =>
      `<option value="${esc(c.iso2)}"${c.iso2 === value ? ' selected' : ''}>${esc(c.country)} (+${esc(c.code)})</option>`
  ).join('')
  const attr = control ? ` data-control="${control}"` : ''
  return `<select id="${id}"${attr} class="${selCls} max-w-[200px]">${none}${opts}</select>`
}

/** Options for the Country *filter* — only the countries present in this report
 *  under the current home country, most-frequent first. */
function countryFilterOptions(report: CallReport, state: ViewState): string {
  const home = resolveHome(state.home)
  const counts = new Map<string, number>()
  for (const c of callsFor(report, state, home))
    counts.set(c.country, (counts.get(c.country) ?? 0) + 1)
  const options: Array<[string, string]> = [['all', 'All']]
  for (const [country, n] of [...counts.entries()].sort((a, b) => b[1] - a[1]))
    options.push([country, `${country} (${n})`])
  return options
    .map(
      ([v, l]) =>
        `<option value="${esc(v)}"${v === state.country ? ' selected' : ''}>${esc(l)}</option>`
    )
    .join('')
}

function countryFilterSelect(report: CallReport, state: ViewState): string {
  return `<select id="ctlCountry" data-control="country" class="${selCls} max-w-[200px]">${countryFilterOptions(report, state)}</select>`
}

/** After the home country changes, swap the Country dropdown's options in place
 *  (keeping the element, so its change listener survives). */
function refreshCountryOptions(overlay: HTMLElement, report: CallReport, state: ViewState): void {
  const sel = overlay.querySelector<HTMLSelectElement>('#ctlCountry')
  if (sel) sel.innerHTML = countryFilterOptions(report, state)
}

/** Apply the active dropdown filters (everything except the free-text search). */
function applyFilters(calls: ClassifiedCall[], state: ViewState): ClassifiedCall[] {
  return calls.filter((c) => {
    if (state.direction !== 'all' && c.direction !== state.direction) return false
    if (state.scope !== 'all' && c.scope !== state.scope) return false
    if (state.country !== 'all' && c.country !== state.country) return false
    if (state.status === 'answered' && !c.answered) return false
    if (state.status === 'missed' && c.answered) return false
    return true
  })
}

function renderBody(
  report: CallReport,
  all: ClassifiedCall[],
  state: ViewState,
  home: Home,
  nameFor: (ext: string) => string | undefined
): string {
  const calls = applyFilters(all, state)
  const t = totals(calls)
  const homeNote = home.iso2
    ? ''
    : `<div class="px-3 py-2 rounded bg-sky-50 text-sky-700 dark:bg-sky-900/30 dark:text-sky-200 text-xs">Pick a <strong>home country</strong> above to split calls into national vs international.</div>`

  return `
    ${report.error ? `<div class="px-3 py-2 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200 text-xs">${esc(report.error)}</div>` : ''}
    ${homeNote}
    <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
      ${tile('Calls', String(t.calls))}
      ${tile('Answered', String(t.answered))}
      ${tile('Missed', String(t.missed))}
      ${tile('Inbound', String(t.inbound))}
      ${tile('Outbound', String(t.outbound))}
      ${tile('Internal', String(t.internal))}
      ${tile('National', String(t.national))}
      ${tile('International', String(t.international))}
      ${tile('Active exts', String(t.activeExts))}
      ${tile('Talk time', fmtDuration(t.talkSec))}
    </div>
    <div>
      <h3 class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Breakdown by ${esc(groupLabel(state.groupBy))}</h3>
      ${mainChart(calls, state.groupBy, nameFor)}
    </div>
    ${
      !report.live
        ? `<div><h3 class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Calls per day — inbound vs outbound</h3>${stackedDayChart(calls)}</div>`
        : ''
    }
    <div>
      <h3 class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Top countries</h3>
      ${countryTable(calls)}
    </div>
    ${
      calls.some((c) => c.trunk)
        ? `<div><h3 class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">By trunk</h3>${trunkTable(calls)}</div>`
        : ''
    }
    <div>
      <div class="flex items-center justify-between mb-1.5 gap-2">
        <h3 class="text-xs font-semibold text-slate-500 uppercase tracking-wide">Per-extension activity</h3>
        <input id="extFilter" type="text" value="${esc(state.search)}" placeholder="Find extension…" class="px-2 py-1 rounded bg-slate-100 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-xs w-48" />
      </div>
      <div id="extTableWrap" class="overflow-x-auto">${extTable(perExtension(calls, report.perExtension, state.search, nameFor), nameFor)}</div>
    </div>`
}

/** Re-attach the search box + live-filter the per-extension table only, so the
 *  input keeps focus while typing. */
function wireSearch(
  bodyEl: HTMLElement,
  report: CallReport,
  state: ViewState,
  nameFor: (ext: string) => string | undefined,
  home: Home
): void {
  const filterEl = bodyEl.querySelector<HTMLInputElement>('#extFilter')
  const wrap = bodyEl.querySelector<HTMLElement>('#extTableWrap')
  if (!filterEl || !wrap) return
  filterEl.addEventListener('input', () => {
    state.search = filterEl.value
    const calls = applyFilters(callsFor(report, state, home), state)
    wrap.innerHTML = extTable(
      perExtension(calls, report.perExtension, state.search, nameFor),
      nameFor
    )
  })
}

// --- Export -----------------------------------------------------------------

type ExportKind = 'calls-csv' | 'ext-csv' | 'pdf'

async function runExport(
  kind: ExportKind,
  report: CallReport,
  state: ViewState,
  nameFor: (ext: string) => string | undefined
): Promise<void> {
  const home = resolveHome(state.home)
  const calls = applyFilters(callsFor(report, state, home), state)
  const base = exportBaseName(report)
  let res: { canceled?: boolean; path?: string; error?: string }
  if (kind === 'calls-csv') {
    res = await window.api.report.exportCsv(`${base}-calls.csv`, buildCallsCsv(calls, nameFor))
  } else if (kind === 'ext-csv') {
    const rows = perExtension(calls, report.perExtension, '', nameFor)
    res = await window.api.report.exportCsv(`${base}-extensions.csv`, buildExtCsv(rows, nameFor))
  } else {
    res = await window.api.report.exportPdf(
      `${base}.pdf`,
      buildPrintHtml(report, calls, state, home, nameFor)
    )
  }
  if (res?.canceled) return
  if (res?.error) flash(res.error, true)
  else if (res?.path) flash('Exported.')
}

function exportBaseName(report: CallReport): string {
  const host = (report.baseUrl || 'system')
    .replace(/^https?:\/\//, '')
    .replace(/[^\w.-]/g, '_')
    .slice(0, 40)
  const period = report.live ? 'live' : `${fmtDate(report.from)}_${fmtDate(report.to)}`
  return `report-${host}-${period}`
}

function csvCell(v: unknown): string {
  const s = String(v ?? '')
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
function csvRows(rows: unknown[][]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n')
}

function buildCallsCsv(
  calls: ClassifiedCall[],
  nameFor: (ext: string) => string | undefined
): string {
  const header = [
    'Time',
    'Call ID',
    'Direction',
    'Scope',
    'Country',
    'Trunk',
    'Extension',
    'Name',
    'External',
    'Answered',
    'Talk (s)',
    'Talk'
  ]
  const rows = calls.map((c) => [
    c.ts ?? '',
    c.callId ?? '',
    c.direction,
    c.scope,
    c.country,
    c.trunk ?? '',
    c.extension ?? '',
    c.extension ? (nameFor(c.extension) ?? '') : '',
    c.external ?? '',
    c.answered ? 'Yes' : 'No',
    Math.round(c.durationSec),
    fmtDuration(c.durationSec)
  ])
  return csvRows([header, ...rows])
}

function buildExtCsv(rows: ExtRow[], nameFor: (ext: string) => string | undefined): string {
  const header = [
    'Extension',
    'Name',
    'Inbound',
    'Outbound',
    'National',
    'International',
    'Answered',
    'Missed',
    'Talk (s)',
    'Talk'
  ]
  const body = rows.map((a) => [
    a.extension,
    nameFor(a.extension) ?? '',
    a.inbound,
    a.outbound,
    a.national,
    a.international,
    a.answered,
    a.missed,
    Math.round(a.talkSec),
    fmtDuration(a.talkSec)
  ])
  return csvRows([header, ...body])
}

function filtersSummary(state: ViewState, home: Home): string {
  return [
    `Home: ${home.name || 'not set'}`,
    `Rows: ${state.detail === 'call' ? 'by call' : 'by leg'}`,
    `Direction: ${state.direction}`,
    `Scope: ${state.scope}`,
    `Country: ${state.country}`,
    `Status: ${state.status}`
  ].join('  ·  ')
}

/** A self-contained, inline-styled HTML document rendered to PDF by the main
 *  process. Kept independent of the app's Tailwind styles. */
function buildPrintHtml(
  report: CallReport,
  calls: ClassifiedCall[],
  state: ViewState,
  home: Home,
  nameFor: (ext: string) => string | undefined
): string {
  const t = totals(calls)
  const title = report.live
    ? 'Live report — active calls'
    : `Report — ${fmtDate(report.from)} → ${fmtDate(report.to)}`
  const kpi = (label: string, value: string): string =>
    `<div class="kpi"><div class="v">${esc(value)}</div><div class="l">${esc(label)}</div></div>`

  const bars = groupCounts(calls, state.groupBy, nameFor)
    .filter((b) => b.value > 0)
    .slice(0, 14)
  const barMax = Math.max(1, ...bars.map((b) => b.value))
  const barsHtml = bars
    .map(
      (b) =>
        `<div class="bar"><div class="lab">${esc(b.label)}</div><div class="track"><div class="fill" style="width:${Math.round((b.value / barMax) * 100)}%"></div></div><div class="val">${b.value}</div></div>`
    )
    .join('')

  const extRows = perExtension(calls, report.perExtension, '', nameFor)
  const extTableHtml = pdfTable(
    ['Ext', 'Name', 'In', 'Out', 'Nat', 'Intl', 'Ans', 'Miss', 'Talk'],
    [false, false, true, true, true, true, true, true, true],
    extRows.map((a) => [
      a.extension,
      nameFor(a.extension) ?? '',
      a.inbound,
      a.outbound,
      a.national,
      a.international,
      a.answered,
      a.missed,
      fmtDuration(a.talkSec)
    ])
  )

  const countryHtml = pdfTable(
    ['Country', 'Calls', 'In', 'Out', 'Talk'],
    [false, true, true, true, true],
    groupAgg(calls, (c) => c.country).map((r) => [
      r.key,
      r.calls,
      r.inbound,
      r.outbound,
      fmtDuration(r.talkSec)
    ])
  )

  const trunkAgg = groupAgg(
    calls.filter((c) => c.trunk),
    (c) => c.trunk as string
  )
  const trunkHtml = trunkAgg.length
    ? `<h2>By trunk</h2>${pdfTable(
        ['Trunk', 'Calls', 'In', 'Out', 'Talk'],
        [false, true, true, true, true],
        trunkAgg.map((r) => [r.key, r.calls, r.inbound, r.outbound, fmtDuration(r.talkSec)])
      )}`
    : ''

  const dayChart = report.live
    ? ''
    : `<h2>Calls per day — inbound vs outbound</h2>${pdfDayChart(calls)}`

  return `<!doctype html><html><head><meta charset="utf-8" /><title>${esc(title)}</title>
<style>
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #0f172a; margin: 22px; font-size: 12px; }
  h1 { font-size: 18px; margin: 0 0 3px; }
  .sub { color: #64748b; font-size: 11px; margin: 0; }
  .filters { color: #475569; font-size: 11px; margin: 6px 0 4px; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: #64748b; margin: 18px 0 6px; }
  .kpis { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .kpi { border: 1px solid #e2e8f0; border-radius: 8px; padding: 6px 10px; min-width: 82px; }
  .kpi .v { font-size: 16px; font-weight: 600; }
  .kpi .l { font-size: 9px; color: #64748b; text-transform: uppercase; letter-spacing: .04em; }
  table { border-collapse: collapse; width: 100%; font-size: 11px; }
  th, td { text-align: left; padding: 3px 6px; border-bottom: 1px solid #eef2f7; }
  th { color: #64748b; font-weight: 600; }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
  .bar { display: flex; align-items: center; gap: 8px; margin: 2px 0; }
  .bar .lab { width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar .track { flex: 1; height: 12px; background: #f1f5f9; border-radius: 3px; overflow: hidden; }
  .bar .fill { height: 100%; background: #0ea5e9; }
  .bar .val { width: 44px; text-align: right; color: #475569; }
  .legend { display: flex; gap: 14px; font-size: 10px; color: #475569; margin-top: 4px; }
  .legend span { display: inline-flex; align-items: center; gap: 4px; }
  .sw { display: inline-block; width: 9px; height: 9px; border-radius: 2px; }
</style></head><body>
  <h1>${esc(title)}</h1>
  <p class="sub">Generated ${esc(fmtDateTime(report.generatedAt))}${report.baseUrl ? ` · ${esc(report.baseUrl.replace(/^https?:\/\//, ''))}` : ''}</p>
  <p class="filters">${esc(filtersSummary(state, home))}</p>
  <div class="kpis">
    ${kpi('Calls', String(t.calls))}${kpi('Answered', String(t.answered))}${kpi('Missed', String(t.missed))}
    ${kpi('Inbound', String(t.inbound))}${kpi('Outbound', String(t.outbound))}${kpi('Internal', String(t.internal))}
    ${kpi('National', String(t.national))}${kpi('International', String(t.international))}${kpi('Talk time', fmtDuration(t.talkSec))}
  </div>
  <h2>Breakdown by ${esc(groupLabel(state.groupBy))}</h2>
  ${barsHtml || '<p class="sub">No calls match the current filters.</p>'}
  ${dayChart}
  <h2>Per-extension activity</h2>
  ${extTableHtml}
  <h2>Top countries</h2>
  ${countryHtml}
  ${trunkHtml}
</body></html>`
}

interface AggRow {
  key: string
  calls: number
  inbound: number
  outbound: number
  talkSec: number
}
function groupAgg(calls: ClassifiedCall[], keyOf: (c: ClassifiedCall) => string): AggRow[] {
  const map = new Map<string, AggRow>()
  for (const c of calls) {
    const k = keyOf(c)
    let r = map.get(k)
    if (!r) {
      r = { key: k, calls: 0, inbound: 0, outbound: 0, talkSec: 0 }
      map.set(k, r)
    }
    r.calls++
    if (c.direction === 'inbound') r.inbound++
    else if (c.direction === 'outbound') r.outbound++
    r.talkSec += c.durationSec
  }
  return [...map.values()].sort((a, b) => b.calls - a.calls).slice(0, 25)
}

function pdfTable(headers: string[], numeric: boolean[], rows: unknown[][]): string {
  const head = headers.map((h, i) => `<th${numeric[i] ? ' class="n"' : ''}>${esc(h)}</th>`).join('')
  const body = rows
    .map(
      (r) =>
        `<tr>${r
          .map((cell, i) => `<td${numeric[i] ? ' class="n"' : ''}>${esc(cell)}</td>`)
          .join('')}</tr>`
    )
    .join('')
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
}

/** Inline-styled stacked-per-day column chart for the PDF (colours are explicit
 *  so they survive printing without Tailwind). */
function pdfDayChart(calls: ClassifiedCall[]): string {
  const byDay = new Map<string, { inbound: number; outbound: number; internal: number }>()
  for (const c of calls) {
    if (!c.day) continue
    let d = byDay.get(c.day)
    if (!d) {
      d = { inbound: 0, outbound: 0, internal: 0 }
      byDay.set(c.day, d)
    }
    if (c.direction === 'inbound') d.inbound++
    else if (c.direction === 'outbound') d.outbound++
    else if (c.direction === 'internal') d.internal++
  }
  const days = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))
  if (!days.length) return '<p class="sub">No dated calls to chart.</p>'
  const max = Math.max(1, ...days.map(([, d]) => d.inbound + d.outbound + d.internal))
  const bw = 100 / days.length
  const segs = days
    .map(([day, d], i) => {
      const x = (i * bw + bw * 0.15).toFixed(2)
      const w = (bw * 0.7).toFixed(2)
      let yTop = 100
      const parts: string[] = []
      const push = (n: number, color: string): void => {
        if (!n) return
        const h = (n / max) * 100
        yTop -= h
        parts.push(
          `<rect x="${x}" y="${yTop.toFixed(2)}" width="${w}" height="${h.toFixed(2)}" fill="${color}"><title>${esc(day)}: ${n}</title></rect>`
        )
      }
      push(d.internal, '#94a3b8')
      push(d.outbound, '#10b981')
      push(d.inbound, '#0ea5e9')
      return parts.join('')
    })
    .join('')
  return `<svg viewBox="0 0 100 100" preserveAspectRatio="none" style="width:100%;height:120px">${segs}</svg>
    <div class="legend">
      <span><span class="sw" style="background:#0ea5e9"></span>Inbound</span>
      <span><span class="sw" style="background:#10b981"></span>Outbound</span>
      <span><span class="sw" style="background:#94a3b8"></span>Internal</span>
      <span style="margin-left:auto">${esc(days[0][0])} → ${esc(days[days.length - 1][0])}</span>
    </div>`
}

// --- Aggregation ------------------------------------------------------------

function totals(calls: ClassifiedCall[]): {
  calls: number
  answered: number
  missed: number
  inbound: number
  outbound: number
  internal: number
  national: number
  international: number
  activeExts: number
  talkSec: number
} {
  const exts = new Set<string>()
  let answered = 0
  let inbound = 0
  let outbound = 0
  let internal = 0
  let national = 0
  let international = 0
  let talkSec = 0
  for (const c of calls) {
    if (c.answered) answered++
    if (c.direction === 'inbound') inbound++
    else if (c.direction === 'outbound') outbound++
    else if (c.direction === 'internal') internal++
    if (c.scope === 'national') national++
    else if (c.scope === 'international') international++
    talkSec += c.durationSec
    if (c.extension) exts.add(c.extension)
  }
  return {
    calls: calls.length,
    answered,
    missed: calls.length - answered,
    inbound,
    outbound,
    internal,
    national,
    international,
    activeExts: exts.size,
    talkSec
  }
}

interface ExtRow {
  extension: string
  inbound: number
  outbound: number
  national: number
  international: number
  answered: number
  missed: number
  talkSec: number
  active: boolean
}

/** Per-extension rollup from the filtered calls, joined to the report's own
 *  active-state so the live "on a call now" dot survives filtering. */
function perExtension(
  calls: ClassifiedCall[],
  base: ExtensionActivity[],
  search: string,
  nameFor: (ext: string) => string | undefined
): ExtRow[] {
  const activeSet = new Set(base.filter((a) => a.active).map((a) => a.extension))
  const map = new Map<string, ExtRow>()
  const get = (ext: string): ExtRow => {
    let r = map.get(ext)
    if (!r) {
      r = {
        extension: ext,
        inbound: 0,
        outbound: 0,
        national: 0,
        international: 0,
        answered: 0,
        missed: 0,
        talkSec: 0,
        active: activeSet.has(ext)
      }
      map.set(ext, r)
    }
    return r
  }
  for (const c of calls) {
    if (!c.extension) continue
    const r = get(c.extension)
    if (c.direction === 'inbound') {
      r.inbound++
      if (c.answered) r.answered++
      else r.missed++
    } else if (c.direction === 'outbound') {
      r.outbound++
    }
    if (c.scope === 'national') r.national++
    else if (c.scope === 'international') r.international++
    r.talkSec += c.durationSec
  }
  const t = search.trim().toLowerCase()
  return [...map.values()]
    .filter(
      (r) => !t || r.extension.includes(t) || (nameFor(r.extension) ?? '').toLowerCase().includes(t)
    )
    .sort((a, b) => b.inbound + b.outbound - (a.inbound + a.outbound))
}

interface Bar {
  key: string
  label: string
  value: number
}

/** Group filtered calls into {label, value} buckets for the main chart. */
function groupCounts(
  calls: ClassifiedCall[],
  groupBy: GroupBy,
  nameFor: (ext: string) => string | undefined
): Bar[] {
  if (groupBy === 'hour') {
    const counts = new Array(24).fill(0)
    for (const c of calls) if (c.hour !== undefined) counts[c.hour]++
    return counts.map((v, h) => ({
      key: String(h),
      label: `${String(h).padStart(2, '0')}:00`,
      value: v
    }))
  }
  const map = new Map<string, number>()
  const keyOf = (c: ClassifiedCall): string => {
    switch (groupBy) {
      case 'extension':
        return c.extension ?? '—'
      case 'country':
        return c.country
      case 'trunk':
        return c.trunk ?? '(no trunk)'
      case 'direction':
        return c.direction
      case 'scope':
        return c.scope
      case 'day':
        return c.day ?? 'unknown'
      default:
        return '—'
    }
  }
  for (const c of calls) {
    if (groupBy === 'extension' && !c.extension) continue
    const k = keyOf(c)
    map.set(k, (map.get(k) ?? 0) + 1)
  }
  const bars: Bar[] = [...map.entries()].map(([key, value]) => ({
    key,
    label: groupBy === 'extension' ? (nameFor(key) ? `${key} · ${nameFor(key)}` : key) : cap(key),
    value
  }))
  if (groupBy === 'day') bars.sort((a, b) => a.key.localeCompare(b.key))
  else bars.sort((a, b) => b.value - a.value)
  return bars
}

// --- Rendering helpers ------------------------------------------------------

function tile(label: string, value: string): string {
  return `<div class="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50 px-3 py-2">
    <div class="text-lg font-semibold text-slate-800 dark:text-slate-100 tabular-nums">${esc(value)}</div>
    <div class="text-[10px] text-slate-400 uppercase tracking-wide">${esc(label)}</div>
  </div>`
}

/** The customisable main chart: a column chart for day/hour (ordered series),
 *  a horizontal bar chart otherwise (ranked categories). */
function mainChart(
  calls: ClassifiedCall[],
  groupBy: GroupBy,
  nameFor: (ext: string) => string | undefined
): string {
  const bars = groupCounts(calls, groupBy, nameFor)
  if (!bars.some((b) => b.value > 0)) return emptyNote('No calls match the current filters.')
  if (groupBy === 'day' || groupBy === 'hour') return columnChart(bars)
  return barChart(bars.slice(0, 14))
}

/** Horizontal bar chart of ranked categories. */
function barChart(bars: Bar[]): string {
  const max = Math.max(1, ...bars.map((b) => b.value))
  return `<div class="space-y-1">${bars
    .map((b) => {
      const pct = Math.round((b.value / max) * 100)
      return `<div class="flex items-center gap-2 text-xs">
        <div class="w-40 shrink-0 truncate text-slate-600 dark:text-slate-300" title="${esc(b.label)}">${esc(b.label)}</div>
        <div class="flex-1 h-4 rounded bg-slate-100 dark:bg-slate-900 overflow-hidden">
          <div class="h-full bg-sky-500/80" style="width:${pct}%"></div>
        </div>
        <div class="w-10 shrink-0 text-right tabular-nums text-slate-500">${b.value}</div>
      </div>`
    })
    .join('')}</div>`
}

/** Column chart for an ordered series (days or hours). */
function columnChart(bars: Bar[]): string {
  const max = Math.max(1, ...bars.map((b) => b.value))
  const bw = 100 / bars.length
  const rects = bars
    .map((b, i) => {
      const h = (b.value / max) * 100
      return `<rect x="${(i * bw + bw * 0.15).toFixed(2)}" y="${(100 - h).toFixed(2)}" width="${(bw * 0.7).toFixed(2)}" height="${h.toFixed(2)}" rx="0.6" fill="currentColor" opacity="0.75"><title>${esc(b.label)}: ${b.value}</title></rect>`
    })
    .join('')
  return `<svg viewBox="0 0 100 100" preserveAspectRatio="none" class="w-full h-28 text-sky-500">${rects}</svg>
    <div class="flex justify-between text-[10px] text-slate-400 mt-0.5"><span>${esc(bars[0].label)}</span><span>${esc(bars[bars.length - 1].label)}</span></div>`
}

/** Stacked columns per day: inbound (sky) / outbound (emerald) / internal (slate). */
function stackedDayChart(calls: ClassifiedCall[]): string {
  const byDay = new Map<string, { inbound: number; outbound: number; internal: number }>()
  for (const c of calls) {
    if (!c.day) continue
    let d = byDay.get(c.day)
    if (!d) {
      d = { inbound: 0, outbound: 0, internal: 0 }
      byDay.set(c.day, d)
    }
    if (c.direction === 'inbound') d.inbound++
    else if (c.direction === 'outbound') d.outbound++
    else if (c.direction === 'internal') d.internal++
  }
  const days = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))
  if (!days.length) return emptyNote('No dated calls to chart.')
  const max = Math.max(1, ...days.map(([, d]) => d.inbound + d.outbound + d.internal))
  const bw = 100 / days.length
  const segs = days
    .map(([day, d], i) => {
      const x = (i * bw + bw * 0.15).toFixed(2)
      const w = (bw * 0.7).toFixed(2)
      let yTop = 100
      const parts: string[] = []
      const push = (n: number, color: string, name: string): void => {
        if (!n) return
        const h = (n / max) * 100
        yTop -= h
        parts.push(
          `<rect x="${x}" y="${yTop.toFixed(2)}" width="${w}" height="${h.toFixed(2)}" fill="${color}"><title>${esc(day)} — ${name}: ${n}</title></rect>`
        )
      }
      push(d.internal, '#94a3b8', 'internal')
      push(d.outbound, '#10b981', 'outbound')
      push(d.inbound, '#0ea5e9', 'inbound')
      return parts.join('')
    })
    .join('')
  return `<svg viewBox="0 0 100 100" preserveAspectRatio="none" class="w-full h-28">${segs}</svg>
    <div class="flex items-center justify-between mt-0.5">
      <div class="flex gap-3 text-[10px] text-slate-500">
        <span class="flex items-center gap-1"><span class="inline-block w-2 h-2 rounded-sm" style="background:#0ea5e9"></span>Inbound</span>
        <span class="flex items-center gap-1"><span class="inline-block w-2 h-2 rounded-sm" style="background:#10b981"></span>Outbound</span>
        <span class="flex items-center gap-1"><span class="inline-block w-2 h-2 rounded-sm" style="background:#94a3b8"></span>Internal</span>
      </div>
      <div class="text-[10px] text-slate-400"><span>${esc(days[0][0])}</span> → <span>${esc(days[days.length - 1][0])}</span></div>
    </div>`
}

function countryTable(calls: ClassifiedCall[]): string {
  const map = new Map<
    string,
    { calls: number; inbound: number; outbound: number; talkSec: number }
  >()
  for (const c of calls) {
    let r = map.get(c.country)
    if (!r) {
      r = { calls: 0, inbound: 0, outbound: 0, talkSec: 0 }
      map.set(c.country, r)
    }
    r.calls++
    if (c.direction === 'inbound') r.inbound++
    else if (c.direction === 'outbound') r.outbound++
    r.talkSec += c.durationSec
  }
  const rows = [...map.entries()].sort((a, b) => b[1].calls - a[1].calls).slice(0, 20)
  if (!rows.length) return emptyNote('No calls match the current filters.')
  const body = rows
    .map(
      ([country, r]) => `<tr class="border-t border-slate-100 dark:border-slate-700/50">
        <td class="py-1 pr-2 truncate max-w-[220px]">${esc(country)}</td>
        <td class="py-1 pr-2 text-right tabular-nums">${r.calls}</td>
        <td class="py-1 pr-2 text-right tabular-nums">${r.inbound}</td>
        <td class="py-1 pr-2 text-right tabular-nums">${r.outbound}</td>
        <td class="py-1 pr-2 text-right tabular-nums whitespace-nowrap">${fmtDuration(r.talkSec)}</td>
      </tr>`
    )
    .join('')
  return `<table class="w-full text-[11px]">
    <thead><tr class="text-left text-slate-400">
      <th class="pr-2 font-medium">Country</th>
      <th class="pr-2 font-medium text-right">Calls</th>
      <th class="pr-2 font-medium text-right">In</th>
      <th class="pr-2 font-medium text-right">Out</th>
      <th class="pr-2 font-medium text-right">Talk</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table>`
}

function trunkTable(calls: ClassifiedCall[]): string {
  const map = new Map<
    string,
    { calls: number; inbound: number; outbound: number; intl: number; talkSec: number }
  >()
  for (const c of calls) {
    if (!c.trunk) continue
    let r = map.get(c.trunk)
    if (!r) {
      r = { calls: 0, inbound: 0, outbound: 0, intl: 0, talkSec: 0 }
      map.set(c.trunk, r)
    }
    r.calls++
    if (c.direction === 'inbound') r.inbound++
    else if (c.direction === 'outbound') r.outbound++
    if (c.scope === 'international') r.intl++
    r.talkSec += c.durationSec
  }
  const rows = [...map.entries()].sort((a, b) => b[1].calls - a[1].calls)
  if (!rows.length) return emptyNote('No trunk information in this report.')
  const body = rows
    .map(
      ([trunk, r]) => `<tr class="border-t border-slate-100 dark:border-slate-700/50">
        <td class="py-1 pr-2 truncate max-w-[220px]">${esc(trunk)}</td>
        <td class="py-1 pr-2 text-right tabular-nums">${r.calls}</td>
        <td class="py-1 pr-2 text-right tabular-nums">${r.inbound}</td>
        <td class="py-1 pr-2 text-right tabular-nums">${r.outbound}</td>
        <td class="py-1 pr-2 text-right tabular-nums text-violet-600 dark:text-violet-400">${r.intl}</td>
        <td class="py-1 pr-2 text-right tabular-nums whitespace-nowrap">${fmtDuration(r.talkSec)}</td>
      </tr>`
    )
    .join('')
  return `<table class="w-full text-[11px]">
    <thead><tr class="text-left text-slate-400">
      <th class="pr-2 font-medium">Trunk</th>
      <th class="pr-2 font-medium text-right">Calls</th>
      <th class="pr-2 font-medium text-right">In</th>
      <th class="pr-2 font-medium text-right">Out</th>
      <th class="pr-2 font-medium text-right">Intl</th>
      <th class="pr-2 font-medium text-right">Talk</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table>`
}

function extTable(rows: ExtRow[], nameFor: (ext: string) => string | undefined): string {
  if (!rows.length) return emptyNote('No matching extensions.')
  const body = rows
    .map((a) => {
      const name = nameFor(a.extension)
      return `<tr class="border-t border-slate-100 dark:border-slate-700/50">
        <td class="py-1 pr-2 font-mono whitespace-nowrap">${esc(a.extension)}</td>
        <td class="py-1 pr-2 truncate max-w-[150px]">${esc(name ?? '')}</td>
        <td class="py-1 pr-2 text-right tabular-nums">${a.inbound}</td>
        <td class="py-1 pr-2 text-right tabular-nums">${a.outbound}</td>
        <td class="py-1 pr-2 text-right tabular-nums">${a.national}</td>
        <td class="py-1 pr-2 text-right tabular-nums text-violet-600 dark:text-violet-400">${a.international}</td>
        <td class="py-1 pr-2 text-right tabular-nums text-emerald-600 dark:text-emerald-400">${a.answered}</td>
        <td class="py-1 pr-2 text-right tabular-nums text-amber-600 dark:text-amber-400">${a.missed}</td>
        <td class="py-1 pr-2 text-right tabular-nums whitespace-nowrap">${fmtDuration(a.talkSec)}</td>
        <td class="py-1 text-center">${a.active ? '<span class="text-emerald-500">●</span>' : '<span class="text-slate-300 dark:text-slate-600">○</span>'}</td>
      </tr>`
    })
    .join('')
  return `<table class="w-full text-[11px]">
    <thead><tr class="text-left text-slate-400">
      <th class="pr-2 font-medium">Ext</th><th class="pr-2 font-medium">Name</th>
      <th class="pr-2 font-medium text-right">In</th><th class="pr-2 font-medium text-right">Out</th>
      <th class="pr-2 font-medium text-right">Nat</th><th class="pr-2 font-medium text-right">Intl</th>
      <th class="pr-2 font-medium text-right">Ans</th><th class="pr-2 font-medium text-right">Miss</th>
      <th class="pr-2 font-medium text-right">Talk</th><th class="font-medium text-center">Active</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table>`
}

function emptyNote(msg: string): string {
  return `<p class="text-xs text-slate-400 py-2">${esc(msg)}</p>`
}

function groupLabel(g: GroupBy): string {
  return {
    extension: 'extension',
    day: 'day',
    country: 'country',
    trunk: 'trunk',
    direction: 'direction',
    scope: 'national / international',
    hour: 'hour of day'
  }[g]
}

// --- Home-country persistence ----------------------------------------------

function readHomeCountry(): string {
  try {
    return localStorage.getItem(HOME_KEY) ?? ''
  } catch {
    return ''
  }
}
function writeHomeCountry(iso2: string): void {
  try {
    if (iso2) localStorage.setItem(HOME_KEY, iso2)
    else localStorage.removeItem(HOME_KEY)
  } catch {
    /* storage unavailable — non-fatal */
  }
}

// --- Formatting -------------------------------------------------------------

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}
function fmtDate(iso?: string): string {
  if (!iso) return '—'
  return iso.slice(0, 10)
}
function fmtDateTime(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}
function fmtDuration(sec: number): string {
  if (!sec) return '0s'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${s}s`
  return `${s}s`
}
