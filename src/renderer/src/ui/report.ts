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
  isExtensionLike,
  parseInternational,
  pickParties
} from '../../../shared/phone'
import { getZoneLookup, getZoneRevision, zoneForNumber } from './zones'
import { hidePopover, playExit, showPopover } from './motion'
import { ICONS } from './icons'
import {
  buildDirectory,
  contextForReport,
  isInfrastructureDn,
  type DnKind,
  type ReportContext
} from './report-context'
import {
  defaultReportCustomize,
  loadReportCustomize,
  saveReportCustomize,
  REPORT_SECTIONS,
  type BreakdownChart,
  type ChartStyle,
  type GroupBy,
  type ReportCustomize,
  type SectionId
} from './report-customize'

export const esc = (s: unknown): string =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )

export const btn = 'px-3 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-sm text-slate-100'
const HOME_KEY = 'espionage.homeCountry'

/** Transient toast, matching the app's flash style. */
export function flash(message: string, isError = false): void {
  const el = document.createElement('div')
  el.className = `fixed bottom-4 left-1/2 -translate-x-1/2 z-[120] px-3 py-1.5 rounded-md text-sm shadow-lg esp-toast-in ${
    isError ? 'bg-red-600 text-white' : 'bg-slate-800 text-slate-100 dark:bg-slate-700'
  }`
  el.textContent = message
  document.body.appendChild(el)
  setTimeout(() => {
    el.classList.remove('esp-toast-in')
    playExit(el, 'esp-toast-out', () => el.remove())
  }, 2800)
}

/** Mount an overlay modal on document.body and return {overlay, close}. */
export function openOverlay(
  inner: string,
  width = 'w-[960px]',
  opts: { onClose?: () => void } = {}
): { overlay: HTMLElement; close: () => void } {
  const overlay = document.createElement('div')
  overlay.className =
    'fixed inset-0 z-[110] flex items-center justify-center bg-black/40 p-4 esp-fade-in'
  overlay.innerHTML = `
    <div class="${width} max-w-full max-h-[88vh] flex flex-col bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-lg shadow-2xl border border-slate-200 dark:border-slate-700 overflow-hidden esp-card-in">
      ${inner}
    </div>`
  document.body.appendChild(overlay)
  const card = overlay.firstElementChild!
  // The overlay stays in the DOM while it animates out, so `isConnected` alone
  // would let a second close() re-trigger the exit.
  let closing = false
  const close = (): void => {
    if (closing || !overlay.isConnected) return
    closing = true
    card.classList.remove('esp-card-in')
    overlay.classList.remove('esp-fade-in')
    overlay.classList.add('esp-fade-out')
    playExit(card, 'esp-card-out', () => {
      overlay.remove()
      opts.onClose?.()
    })
  }
  // No close-on-backdrop: a stray click outside a report or a half-filled form
  // shouldn't discard it. The ✕ is the way out.
  return { overlay, close }
}

/** Fetch + show a live active-calls report. */
export async function showLiveReport(ctx: ReportContext): Promise<void> {
  const res = await window.api.report.live()
  if (res.error && !res.report) {
    flash(res.error, true)
    return
  }
  if (res.report) {
    // A live snapshot is generated in the moment, so stamp the connected
    // system's directory onto it — saved and reopened later, possibly against
    // another system, it still knows who its extensions were.
    res.report.directory = buildDirectory(ctx)
    showReport(res.report, ctx)
  }
}

/** Open a previously-saved report from disk and show it. */
export async function openReport(ctx: ReportContext): Promise<void> {
  const res = await window.api.report.open()
  if (res.canceled) return
  if (res.error || !res.report) {
    flash(res.error ?? 'Could not open report.', true)
    return
  }
  showReport(res.report, ctx)
}

/** Load a saved report by path (the reports tray) and show it. */
export async function openReportPath(path: string, ctx: ReportContext): Promise<void> {
  const res = await window.api.report.load(path)
  if (res.error || !res.report) {
    flash(res.error ?? 'Could not open report.', true)
    return
  }
  showReport(res.report, ctx)
}

// --- Classification ---------------------------------------------------------

export interface ClassifiedCall {
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
  /** Configured call zone the external number falls in (null = no zone). */
  zone?: string
  /** Tariff rate (EUR/min) when the number matched a tariff row. */
  rate?: number
  /** Tariff destination this call matched, e.g. "IRELAND · Mobile". Shown as each
   *  zone's makeup so a zone total can be traced back to its destinations. */
  destLabel?: string
  /** Department the attributed extension is grouped under (for the rollup). */
  dept?: string
  /** Every department it belongs to — the department filter matches any of them,
   *  since an extension can serve more than one. */
  depts?: string[]
  /** Logged as internal but dialled to something not on the system — a misdial,
   *  not a call to a colleague. */
  misdial?: boolean
  /** What `extension` actually is — a person, or a queue / ring group / IVR /
   *  trunk the call merely passed through. */
  dnKind?: DnKind
  /** The DNs on each end of the leg. Neither is always `extension`: an internal
   *  call is attributed to its caller, so only `dstDn` says who it rang. */
  srcDn?: string
  dstDn?: string
  /** This leg was picked up by voicemail, not by the person it rang. */
  toVoicemail?: boolean
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

/** Is this DN absent from the system the report describes?
 *
 *  The topology directory is the authority when we have one: a DN it doesn't
 *  list isn't on the system, however much it looks like an extension. That
 *  matters because `isExtensionLike` accepts any 2–6 digit string, so half-dialled
 *  numbers — "20", "01", "101", "01404" — sail straight through it and earn a row
 *  each. Without a directory (a report saved before Beta 9, opened on a system
 *  that doesn't know these numbers) fall back to the shape test rather than
 *  discarding everything. */
export function isOffSystemDn(ctx: ReportContext, dn: string | undefined): boolean {
  if (!dn) return false
  if (ctx.kindFor(dn) !== undefined) return false
  return ctx.targets.length > 0 ? true : !isExtensionLike(dn)
}

/** Re-derive every call from the raw entries under the chosen home country. Done
 *  in the renderer (not read from the file) so the dropdowns can reclassify live
 *  and older saved reports without the enrichment fields still work. */
export function classify(
  report: CallReport,
  home: Home,
  ctx: ReportContext
): ClassifiedCall[] {
  const zoneLookup = getZoneLookup()
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
    // Zone (+ tariff rate) only applies to external calls with an outside party.
    const zr =
      direction === 'internal' ? null : zoneForNumber(external, home.code, zoneLookup)
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
      durationSec: e.durationSec ?? 0,
      zone: zr?.zone ?? undefined,
      rate: zr?.rate,
      destLabel:
        zr && zr.country ? `${cap(zr.country.toLowerCase())} · ${zr.lineType}` : undefined,
      dept: extension ? ctx.deptFor(extension) : undefined,
      depts: extension ? ctx.deptsFor(extension) : undefined,
      // A dial that never reached a trunk is logged as "internal" whatever was
      // dialled, so a mistyped or half-dialled number arrives looking like a call
      // to a colleague. 3CX leaves these out; so does every section here, or the
      // internal figures disagree with the per-extension table.
      //
      // "Not on the system" alone isn't enough to discard, though: park, paging
      // and other service DNs are missing from the topology too, and they really
      // do answer calls and hold real talk time. A misdial is one that was NEVER
      // answered — nothing was there to answer it.
      misdial: direction === 'internal' && !e.answered && isOffSystemDn(ctx, e.dstDn),
      dnKind: extension ? ctx.kindFor(extension) : undefined,
      srcDn: e.srcDn,
      dstDn: e.dstDn,
      toVoicemail: e.toVoicemail
    }
  })
}

/** How good a candidate a leg is for representing its whole call. 3CX stamps the
 *  queue leg and the agent leg with the same time, so ranking by timestamp alone
 *  credited the queue about half the time — and recorded its hold music as the
 *  talk time. Answering at a real extension is what makes a leg the handling one. */
function legRank(c: ClassifiedCall): number {
  if (!c.extension) return 0
  const person = !isInfrastructureDn(c.dnKind)
  if (person && c.answered) return 4
  if (person) return 3
  if (c.answered) return 2
  return 1
}

/** Collapse the routing legs of each call (queue → IVR → extension) into one
 *  logical call: the handling leg represents it (see legRank), the call counts as
 *  answered if any leg was, and talk time is the handling leg's. Legs without a
 *  call id (older reports, other endpoints) pass through. */
export function collapseToCalls(calls: ClassifiedCall[]): ClassifiedCall[] {
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
    const rep = legs.reduce((a, b) => {
      const ra = legRank(a)
      const rb = legRank(b)
      if (ra !== rb) return ra > rb ? a : b
      // Same calibre of leg: the later one is the one further down the routing
      // path, so it's still the better representative.
      return (a.ts ?? '') >= (b.ts ?? '') ? a : b
    })
    out.push({ ...rep, answered: legs.some((l) => l.answered) })
  }
  return out
}

// --- Report view ------------------------------------------------------------

interface ViewState {
  home: string // ISO2, '' = not set
  detail: 'call' | 'leg' // composite call vs per routing-leg
  /** 'external' is every call that left or entered the system — inbound and
   *  outbound together — which is how 3CX's own reports slice it and the
   *  question people actually ask ("how much real phone traffic?"). */
  direction: CallDirection | 'all' | 'external'
  scope: CallScope | 'all'
  country: string // 'all' or a country label
  department: string // 'all' or a department name
  status: 'all' | 'answered' | 'missed'
  search: string
}

/** Classification is pure and depends only on the report + home country, but it
 *  walks every call-log row — on a month of a busy system that's hundreds of
 *  thousands of rows, and it used to run three or four times per re-render (body,
 *  country options, department options, search). Cached per report + home so a
 *  filter change is instant. */
const classifyCache = new WeakMap<CallReport, Map<string, ClassifiedCall[]>>()

function classifyCached(
  report: CallReport,
  home: Home,
  detail: ViewState['detail'],
  ctx: ReportContext
): ClassifiedCall[] {
  let byKey = classifyCache.get(report)
  if (!byKey) {
    byKey = new Map()
    classifyCache.set(report, byKey)
  }
  // The zone revision is part of the key: editing call zones changes what
  // classification produces, and a cached answer would otherwise outlive the edit.
  const stem = `${home.iso2}|${getZoneRevision()}`
  const key = `${stem}|${detail}`
  const hit = byKey.get(key)
  if (hit) return hit
  const all = byKey.get(`${stem}|leg`) ?? classify(report, home, ctx)
  byKey.set(`${stem}|leg`, all)
  const out = detail === 'call' ? collapseToCalls(all) : all
  byKey.set(key, out)
  return out
}

/** The classified calls at the chosen granularity (composite vs per-leg). */
function callsFor(
  report: CallReport,
  state: ViewState,
  home: Home,
  ctx: ReportContext
): ClassifiedCall[] {
  return classifyCached(report, home, state.detail, ctx)
}

/** Render a report into an interactive modal. */
export function showReport(report: CallReport, liveCtx: ReportContext): void {
  // A report names its extensions from the snapshot it recorded, not from
  // whichever system is currently open.
  const ctx = contextForReport(report, liveCtx)
  const title = report.name
    ? report.name
    : report.live
      ? 'Live report - active calls'
      : `Report - ${fmtDate(report.from)} → ${fmtDate(report.to)}`
  // The period and any scope belong under the title: a named report otherwise
  // says nothing about what it actually covers.
  const subtitle = [
    `Generated ${fmtDateTime(report.generatedAt)}`,
    report.live ? 'active calls' : `${fmtDate(report.from)} → ${fmtDate(report.to)} (inclusive)`,
    report.scope?.label,
    report.baseUrl ? report.baseUrl.replace(/^https?:\/\//, '') : ''
  ]
    .filter(Boolean)
    .join(' · ')

  // The filters open on whatever the report was generated for, rather than
  // making the user re-pick the department and directions they already chose.
  const scopedDirections = report.scope?.directions ?? []
  const state: ViewState = {
    home: report.homeCountry || readHomeCountry(),
    detail: report.live ? 'leg' : 'call',
    direction:
      scopedDirections.length === 1
        ? scopedDirections[0]
        : scopedDirections.length === 2 &&
            scopedDirections.includes('inbound') &&
            scopedDirections.includes('outbound')
          ? 'external'
          : 'all',
    scope: 'all',
    country: 'all',
    department: report.scope?.departments?.length === 1 ? report.scope.departments[0] : 'all',
    status: 'all',
    search: ''
  }
  let customize = loadReportCustomize()

  const { overlay, close } = openOverlay(`
    <div class="flex items-center justify-between gap-2 px-4 py-3 border-b border-slate-200 dark:border-slate-700 shrink-0">
      <div class="min-w-0">
        <h2 class="font-semibold text-slate-800 dark:text-slate-100 truncate">${esc(title)}</h2>
        <p class="text-[11px] text-slate-400 truncate" title="${esc(subtitle)}">${esc(subtitle)}</p>
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
        <button id="customizeBtn" class="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-100 text-xs">${ICONS.gear}<span class="ml-1">Customise</span></button>
        <button id="saveReport" class="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-100 text-xs">Save</button>
        <button data-close class="text-slate-400 hover:text-slate-700 dark:hover:text-slate-100 text-lg leading-none">✕</button>
      </div>
    </div>
    <div id="controlsBar">${controlsBar(report, state, ctx)}</div>
    <div id="reportBody" class="esp-scroll overflow-y-auto p-4 space-y-4"></div>`)

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
    if (exportMenu.classList.contains('hidden')) showPopover(exportMenu)
    else hidePopover(exportMenu)
  })
  overlay.addEventListener('click', () => hidePopover(exportMenu))
  exportMenu.addEventListener('click', (e) => e.stopPropagation())
  for (const item of exportMenu.querySelectorAll<HTMLButtonElement>('[data-export]')) {
    item.addEventListener('click', () => {
      hidePopover(exportMenu)
      void runExport(item.dataset.export as ExportKind, report, state, customize, ctx)
    })
  }

  const bodyEl = overlay.querySelector<HTMLElement>('#reportBody')!

  const rerender = (): void => {
    const home = resolveHome(state.home)
    bodyEl.innerHTML = renderBody(
      report,
      callsFor(report, state, home, ctx),
      // Per-leg data as well: unanswered rings and queue arrivals only exist at
      // leg level, whichever granularity the rest of the report is showing.
      classifyCached(report, home, 'leg', ctx),
      state,
      home,
      customize,
      ctx
    )
    wireSearch(bodyEl, report, state, home, ctx)
  }

  overlay.querySelector('#customizeBtn')!.addEventListener('click', () => {
    showCustomizePanel(report, customize, (next) => {
      customize = next
      saveReportCustomize(customize)
      rerender()
    })
  })

  // Breakdown-chart controls live inside the report body (recreated each
  // rerender), so drive them by delegation on the persistent body element.
  bodyEl.addEventListener('change', (e) => {
    const t = e.target as HTMLElement
    const idx = t.getAttribute?.('data-chart-idx')
    const fieldName = t.getAttribute?.('data-chart-field')
    if (idx == null || !fieldName) return
    const i = Number(idx)
    if (!customize.charts[i]) return
    customize.charts[i] = { ...customize.charts[i], [fieldName]: (t as HTMLSelectElement).value }
    saveReportCustomize(customize)
    rerender()
  })
  bodyEl.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-chart-add],[data-chart-remove]')
    if (!b) return
    if (b.hasAttribute('data-chart-add')) {
      customize.charts.push({ groupBy: report.live ? 'extension' : 'day', style: 'bar' })
    } else {
      customize.charts.splice(Number(b.getAttribute('data-chart-remove')), 1)
      if (!customize.charts.length) customize.charts.push({ groupBy: 'extension', style: 'bar' })
    }
    saveReportCustomize(customize)
    rerender()
  })

  // Filter dropdowns re-slice the whole view. The home selector also persists so
  // the next report opens with the same baseline.
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
      if (key === 'home' || key === 'detail') refreshFilterOptions(overlay, report, state, ctx)
    })
  }

  rerender()
}

/** The sticky filter controls above the report body. The chart controls now live
 *  inline with each breakdown chart, so this is purely filters. */
function controlsBar(
  report: CallReport,
  state: ViewState,
  ctx: ReportContext
): string {
  return `
    <div class="shrink-0 flex flex-wrap items-end gap-x-3 gap-y-2 px-4 py-2.5 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40 text-xs">
      ${field('Home country', countrySelect('ctlHome', state.home, true, 'home'))}
      ${field(
        'Rows',
        select('ctlDetail', 'detail', state.detail, [
          ['call', 'One row per call'],
          ['leg', 'Individual call steps']
        ])
      )}
      ${field(
        'Direction',
        select('ctlDir', 'direction', state.direction, [
          ['all', 'All'],
          ['external', 'External (in + out)'],
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
      ${field('Department', departmentFilterSelect(report, state, ctx))}
      ${field('Country', countryFilterSelect(report, state, ctx))}
      ${field(
        'Status',
        select('ctlStatus', 'status', state.status, [
          ['all', 'All'],
          ['answered', 'Answered'],
          ['missed', 'Missed']
        ])
      )}
    </div>`
}

function field(label: string, control: string): string {
  return `<label class="flex flex-col gap-0.5">
    <span class="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">${esc(label)}</span>
    ${control}
  </label>`
}

/** The report customisation panel: toggle / reorder sections, pick each chart's
 *  style, and choose whether the PDF export bundles every chart. Edits a working
 *  copy; Apply hands it back. */
function showCustomizePanel(
  report: CallReport,
  current: ReportCustomize,
  onApply: (next: ReportCustomize) => void
): void {
  let working: ReportCustomize = JSON.parse(JSON.stringify(current))
  const metaById = new Map(REPORT_SECTIONS.map((m) => [m.id, m]))

  const { overlay, close } = openOverlay(
    `
    <div class="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-700 shrink-0">
      <div>
        <h2 class="font-semibold text-slate-800 dark:text-slate-100">Customise report</h2>
        <p class="text-[11px] text-slate-400">Show / hide sections, reorder them, and choose chart styles.</p>
      </div>
      <button data-close class="text-slate-400 hover:text-slate-700 dark:hover:text-slate-100 text-lg leading-none">✕</button>
    </div>
    <div id="czBody" class="esp-scroll overflow-y-auto p-4 space-y-1.5"></div>
    <div class="shrink-0 flex items-center justify-between gap-3 px-4 py-3 border-t border-slate-200 dark:border-slate-700">
      <div class="flex flex-col gap-1.5">
        <label class="flex items-center gap-2 text-xs cursor-pointer select-none">
          <input id="czAllCharts" type="checkbox" class="accent-sky-500" ${working.includeAllChartsInPdf ? 'checked' : ''} />
          Include all charts in exported PDF (for customers)
        </label>
        <label class="flex items-center gap-2 text-xs cursor-pointer select-none">
          <input id="czZoneCost" type="checkbox" class="accent-sky-500" ${working.showZoneCost ? 'checked' : ''} />
          Show estimated call cost (internal — hidden from customers by default)
        </label>
      </div>
      <div class="flex gap-2 shrink-0">
        <button id="czReset" class="${btn} bg-slate-500 hover:bg-slate-400">Reset</button>
        <button id="czApply" class="${btn} bg-emerald-600 hover:bg-emerald-500">Apply</button>
      </div>
    </div>`,
    'w-[560px]'
  )
  overlay.querySelectorAll<HTMLElement>('[data-close]').forEach((b) => b.addEventListener('click', close))

  const bodyEl = overlay.querySelector<HTMLElement>('#czBody')!
  const allChartsEl = overlay.querySelector<HTMLInputElement>('#czAllCharts')!
  const zoneCostEl = overlay.querySelector<HTMLInputElement>('#czZoneCost')!

  const render = (): void => {
    bodyEl.innerHTML = working.sections
      .map((s, i) => {
        const meta = metaById.get(s.id)
        if (!meta) return ''
        const naLive = meta.historicalOnly && report.live
        const styleCtl =
          meta.styles && meta.styles.length
            ? `<select data-style="${s.id}" class="${selCls} py-0.5">${meta.styles
                .map(
                  (st) =>
                    `<option value="${st}"${(working.styles[s.id] ?? meta.styles![0]) === st ? ' selected' : ''}>${cap(st)}</option>`
                )
                .join('')}</select>`
            : ''
        return `<div class="flex items-center gap-2 rounded border border-slate-200 dark:border-slate-700 px-2 py-1.5">
          <input type="checkbox" data-vis="${i}" class="accent-sky-500" ${s.visible ? 'checked' : ''} ${naLive ? 'disabled' : ''} />
          <span class="flex-1 text-sm ${naLive ? 'text-slate-400 line-through' : ''}">${esc(meta.label)}${naLive ? ' (historical only)' : ''}</span>
          ${styleCtl}
          <button data-up="${i}" class="w-6 h-6 rounded hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400 disabled:opacity-30" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button>
          <button data-down="${i}" class="w-6 h-6 rounded hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400 disabled:opacity-30" ${i === working.sections.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
        </div>`
      })
      .join('')
    wire()
  }

  const wire = (): void => {
    for (const el of bodyEl.querySelectorAll<HTMLInputElement>('[data-vis]')) {
      el.addEventListener('change', () => {
        working.sections[Number(el.dataset.vis)].visible = el.checked
      })
    }
    for (const el of bodyEl.querySelectorAll<HTMLSelectElement>('[data-style]')) {
      el.addEventListener('change', () => {
        working.styles[el.dataset.style as SectionId] = el.value as ChartStyle
      })
    }
    const move = (i: number, dir: -1 | 1): void => {
      const j = i + dir
      if (j < 0 || j >= working.sections.length) return
      const arr = working.sections
      ;[arr[i], arr[j]] = [arr[j], arr[i]]
      render()
    }
    for (const el of bodyEl.querySelectorAll<HTMLElement>('[data-up]'))
      el.addEventListener('click', () => move(Number(el.dataset.up), -1))
    for (const el of bodyEl.querySelectorAll<HTMLElement>('[data-down]'))
      el.addEventListener('click', () => move(Number(el.dataset.down), 1))
  }

  overlay.querySelector('#czReset')!.addEventListener('click', () => {
    working = defaultReportCustomize()
    allChartsEl.checked = working.includeAllChartsInPdf
    zoneCostEl.checked = working.showZoneCost
    render()
  })
  overlay.querySelector('#czApply')!.addEventListener('click', () => {
    working.includeAllChartsInPdf = allChartsEl.checked
    working.showZoneCost = zoneCostEl.checked
    onApply(working)
    close()
  })

  render()
}

export const selCls =
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
export function countrySelect(id: string, value: string, includeNone: boolean, control?: string): string {
  const none = includeNone ? `<option value=""${value ? '' : ' selected'}>None</option>` : ''
  const opts = CALLING_CODES.map(
    (c) =>
      `<option value="${esc(c.iso2)}"${c.iso2 === value ? ' selected' : ''}>${esc(c.country)} (+${esc(c.code)})</option>`
  ).join('')
  const attr = control ? ` data-control="${control}"` : ''
  return `<select id="${id}"${attr} class="${selCls} max-w-[200px]">${none}${opts}</select>`
}

/** Options for the Country *filter* — only the countries present in this report
 *  under the current home country, most-frequent first. */
function countryFilterOptions(
  report: CallReport,
  state: ViewState,
  ctx: ReportContext
): string {
  const home = resolveHome(state.home)
  const counts = new Map<string, number>()
  for (const c of callsFor(report, state, home, ctx))
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

function countryFilterSelect(
  report: CallReport,
  state: ViewState,
  ctx: ReportContext
): string {
  return `<select id="ctlCountry" data-control="country" class="${selCls} max-w-[200px]">${countryFilterOptions(report, state, ctx)}</select>`
}

/** Options for the Department *filter* — the departments present in this report
 *  (for separating multi-tenant customers), most-active first. */
function departmentFilterOptions(
  report: CallReport,
  state: ViewState,
  ctx: ReportContext
): string {
  const home = resolveHome(state.home)
  const counts = new Map<string, number>()
  for (const c of callsFor(report, state, home, ctx))
    for (const d of c.depts?.length ? c.depts : c.dept ? [c.dept] : [])
      counts.set(d, (counts.get(d) ?? 0) + 1)
  const options: Array<[string, string]> = [['all', 'All departments']]
  for (const [dept, n] of [...counts.entries()].sort((a, b) => b[1] - a[1]))
    options.push([dept, `${dept} (${n})`])
  return options
    .map(
      ([v, l]) =>
        `<option value="${esc(v)}"${v === state.department ? ' selected' : ''}>${esc(l)}</option>`
    )
    .join('')
}

function departmentFilterSelect(
  report: CallReport,
  state: ViewState,
  ctx: ReportContext
): string {
  return `<select id="ctlDepartment" data-control="department" class="${selCls} max-w-[200px]">${departmentFilterOptions(report, state, ctx)}</select>`
}

/** After home/granularity changes, swap the Country + Department dropdown options
 *  in place (keeping the elements, so their change listeners survive). */
function refreshFilterOptions(
  overlay: HTMLElement,
  report: CallReport,
  state: ViewState,
  ctx: ReportContext
): void {
  const country = overlay.querySelector<HTMLSelectElement>('#ctlCountry')
  if (country) country.innerHTML = countryFilterOptions(report, state, ctx)
  const dept = overlay.querySelector<HTMLSelectElement>('#ctlDepartment')
  if (dept) dept.innerHTML = departmentFilterOptions(report, state, ctx)
}

/** Apply the active dropdown filters (everything except the free-text search). */
export function applyFilters(
  calls: ClassifiedCall[],
  state: ViewState,
  opts: { ignoreDepartment?: boolean; keepMisdials?: boolean } = {}
): ClassifiedCall[] {
  return calls.filter((c) => {
    // Dropped report-wide rather than per section, so the summary, the charts
    // and the per-extension table can't disagree about what counts as a call.
    if (c.misdial && !opts.keepMisdials) return false
    if (state.direction === 'external') {
      if (c.direction === 'internal') return false
    } else if (state.direction !== 'all' && c.direction !== state.direction) return false
    if (state.scope !== 'all' && c.scope !== state.scope) return false
    if (state.country !== 'all' && c.country !== state.country) return false
    if (
      !opts.ignoreDepartment &&
      state.department !== 'all' &&
      !(c.depts?.length ? c.depts.includes(state.department) : c.dept === state.department)
    )
      return false
    if (state.status === 'answered' && !c.answered) return false
    if (state.status === 'missed' && c.answered) return false
    return true
  })
}

function renderBody(
  report: CallReport,
  all: ClassifiedCall[],
  allLegs: ClassifiedCall[],
  state: ViewState,
  home: Home,
  customize: ReportCustomize,
  ctx: ReportContext
): string {
  const calls = applyFilters(all, state)
  const legs = applyFilters(allLegs, state)
  // Unanswered rings belong to the extension that rang, whose department may
  // differ from the one the leg is attributed to — so the department filter is
  // left to perExtension, which knows which extension it's crediting.
  const ringLegs = applyFilters(allLegs, state, { ignoreDepartment: true })
  const homeNote = home.iso2
    ? ''
    : `<div class="px-3 py-2 rounded bg-sky-50 text-sky-700 dark:bg-sky-900/30 dark:text-sky-200 text-xs">Pick a <strong>home country</strong> above to split calls into national vs international.</div>`

  const parts: string[] = [
    report.error
      ? `<div class="px-3 py-2 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200 text-xs">
          ${esc(report.error)}
          ${diagnosticsBlock(report)}
        </div>`
      : '',
    homeNote
  ]
  for (const s of customize.sections) {
    if (!s.visible) continue
    parts.push(renderSection(s.id, report, calls, legs, ringLegs, state, customize, ctx))
  }
  return parts.join('')
}

/** What actually happened when the call log was read, folded away under the
 *  error banner. An empty report is otherwise unexplainable from the outside —
 *  the endpoint that answered and the count at each step are what tell apart
 *  "the system has no calls" from "we asked the wrong way". */
function diagnosticsBlock(report: CallReport): string {
  const d = report.diagnostics
  if (!d) return ''
  const rows: Array<[string, string]> = [
    ['Endpoint', d.endpoint ?? '-'],
    ['Window asked of 3CX', d.window ? `${fmtDateTime(d.window.from)} → ${fmtDateTime(d.window.to)}` : '-'],
    ['Records returned', d.fetched.toLocaleString()],
    ['…inside the period', d.inPeriod.toLocaleString()],
    ['…after the scope filter', d.kept.toLocaleString()]
  ]
  if (d.failures?.length) rows.push(['Endpoints that failed', d.failures.join(' · ')])
  return `<details class="mt-1.5">
    <summary class="cursor-pointer select-none text-[11px] opacity-80 hover:opacity-100">What was fetched</summary>
    <dl class="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px] font-mono">
      ${rows.map(([k, v]) => `<dt class="opacity-70 whitespace-nowrap">${esc(k)}</dt><dd class="break-all">${esc(v)}</dd>`).join('')}
    </dl>
  </details>`
}

/** A titled report section wrapper (empty string collapses the section). */
function sectionBlock(title: string, inner: string): string {
  return `<div><h3 class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">${esc(title)}</h3>${inner}</div>`
}

function renderSection(
  id: SectionId,
  report: CallReport,
  calls: ClassifiedCall[],
  legs: ClassifiedCall[],
  ringLegs: ClassifiedCall[],
  state: ViewState,
  customize: ReportCustomize,
  ctx: ReportContext
): string {
  const nameFor = ctx.nameFor
  switch (id) {
    case 'summary':
      return summaryTiles(totals(calls))
    case 'mainChart':
      return breakdownSection(calls, customize.charts, nameFor, report.live)
    case 'callTime':
      return sectionBlock(
        'Call time - national vs international',
        callTimeSection(totals(calls), customize.styles.callTime ?? 'donut')
      )
    case 'perDay':
      return report.live
        ? ''
        : sectionBlock('Calls per day - inbound vs outbound', stackedDayChart(calls))
    case 'zones':
      return zonesSection(calls, customize.styles.zones ?? 'bar', customize.showZoneCost)
    case 'departments':
      return departmentsSection(calls)
    case 'countries':
      return sectionBlock('Top countries', countryTable(calls))
    case 'trunks':
      return calls.some((c) => c.trunk) ? sectionBlock('By trunk', trunkTable(calls)) : ''
    case 'queues':
      return sectionBlock(
        'Queues, ring groups & IVRs',
        `<div class="overflow-x-auto">${queueTable(queueRollup(legs), nameFor)}</div>
         <p class="text-[10px] text-slate-400 mt-1">Calls that passed through each, not who handled them.</p>`
      )
    case 'extensions':
      return `
    <div>
      <div class="flex items-center justify-between mb-1.5 gap-2">
        <h3 class="text-xs font-semibold text-slate-500 uppercase tracking-wide">Per-extension activity</h3>
        <input id="extFilter" type="text" value="${esc(state.search)}" placeholder="Find extension…" class="px-2 py-1 rounded bg-slate-100 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-xs w-48" />
      </div>
      <div id="extTableWrap" class="overflow-x-auto">${extTable(perExtension(ringLegs, report.perExtension, state.search, ctx, state.department), nameFor, state.direction)}</div>
      <p class="text-[10px] text-slate-400 mt-1">Click a row for the call-log entries behind it. An internal call counts for both the caller and the person they rang.</p>
    </div>`
    default:
      return ''
  }
}

function summaryTiles(t: Totals): string {
  return sectionBlock(
    'General statistics',
    `<div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
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
    </div>`
  )
}

/** The breakdown section: a user-managed list of charts, each with its own
 *  group-by + style dropdowns inline to the right, plus an "add chart" button.
 *  The controls are wired by delegation in showReport (data-chart-* attributes). */
function breakdownSection(
  calls: ClassifiedCall[],
  charts: BreakdownChart[],
  nameFor: (ext: string) => string | undefined,
  live: boolean
): string {
  const groupOpts: Array<[GroupBy, string]> = [
    ['extension', 'Extension'],
    ...(live ? [] : ([['day', 'Day']] as Array<[GroupBy, string]>)),
    ['department', 'Department'],
    ['country', 'Country'],
    ['trunk', 'Trunk'],
    ['direction', 'Direction'],
    ['scope', 'National / Intl'],
    ['hour', 'Hour of day']
  ]
  const styleOpts: Array<[ChartStyle, string]> = [
    ['bar', 'Bars'],
    ['pie', 'Pie'],
    ['donut', 'Donut']
  ]
  const opt = <T extends string>(pairs: Array<[T, string]>, selected: T): string =>
    pairs
      .map(([v, l]) => `<option value="${v}"${v === selected ? ' selected' : ''}>${esc(l)}</option>`)
      .join('')
  const cards = charts
    .map((c, i) => {
      // 'day' is meaningless in a live snapshot — fall back to extension.
      const gb: GroupBy = live && c.groupBy === 'day' ? 'extension' : c.groupBy
      const gSel = `<select data-chart-idx="${i}" data-chart-field="groupBy" class="${selCls} py-0.5">${opt(groupOpts, gb)}</select>`
      const sSel = `<select data-chart-idx="${i}" data-chart-field="style" class="${selCls} py-0.5">${opt(styleOpts, c.style)}</select>`
      const remove =
        charts.length > 1
          ? `<button data-chart-remove="${i}" class="w-6 h-6 rounded hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400" title="Remove chart">✕</button>`
          : ''
      return `<div class="rounded-lg border border-slate-200 dark:border-slate-700 p-2.5">
        <div class="flex items-center gap-2 mb-2 flex-wrap">
          <h4 class="text-[11px] font-semibold text-slate-500 uppercase tracking-wide flex-1 min-w-[8rem]">Breakdown by ${esc(groupLabel(gb))}</h4>
          <span class="text-[10px] text-slate-400 uppercase tracking-wide">Chart by</span>${gSel}${sSel}${remove}
        </div>
        ${mainChart(calls, gb, nameFor, c.style)}
      </div>`
    })
    .join('')
  const add = `<button data-chart-add class="px-2 py-1 rounded bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-xs text-slate-600 dark:text-slate-200">+ Add breakdown chart</button>`
  return sectionBlock('Breakdown charts', `<div class="space-y-3">${cards}</div><div class="mt-2">${add}</div>`)
}

/** Per-department rollup — for multi-tenant systems where each customer is a
 *  department. */
function departmentsSection(calls: ClassifiedCall[]): string {
  const rows = groupAgg(calls, (c) => (c.depts?.length ? c.depts : c.dept ? [c.dept] : []))
  if (!rows.length)
    return sectionBlock('By department', emptyNote('No department data for these calls.'))
  const body = rows
    .map(
      (r) => `<tr class="border-t border-slate-100 dark:border-slate-700/50">
        <td class="py-1 pr-2 truncate max-w-[220px]">${esc(r.key)}</td>
        <td class="py-1 pr-2 text-right tabular-nums">${r.calls}</td>
        <td class="py-1 pr-2 text-right tabular-nums">${r.inbound}</td>
        <td class="py-1 pr-2 text-right tabular-nums">${r.outbound}</td>
        <td class="py-1 pr-2 text-right tabular-nums whitespace-nowrap">${fmtDuration(r.talkSec)}</td>
      </tr>`
    )
    .join('')
  const table = `<table class="w-full text-[11px]">
    <thead><tr class="text-left text-slate-400">
      <th class="pr-2 font-medium">Department</th>
      <th class="pr-2 font-medium text-right">Calls</th>
      <th class="pr-2 font-medium text-right">In</th>
      <th class="pr-2 font-medium text-right">Out</th>
      <th class="pr-2 font-medium text-right">Talk</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table>`
  return sectionBlock('By department', table)
}

/** National vs international (vs internal) split — by call count AND talk time,
 *  the latter being the headline the report previously lacked. */
function callTimeSection(t: Totals, style: ChartStyle): string {
  const segs: Segment[] = [
    {
      label: 'National',
      value: t.nationalSec,
      color: '#10b981',
      display: fmtDuration(t.nationalSec)
    },
    {
      label: 'International',
      value: t.internationalSec,
      color: '#8b5cf6',
      display: fmtDuration(t.internationalSec)
    },
    {
      label: 'Internal',
      value: t.internalSec,
      color: '#94a3b8',
      display: fmtDuration(t.internalSec)
    }
  ]
  const tiles = `<div class="grid grid-cols-3 gap-2 mb-3">
      ${tile('National time', fmtDuration(t.nationalSec))}
      ${tile('International time', fmtDuration(t.internationalSec))}
      ${tile('Internal time', fmtDuration(t.internalSec))}
    </div>`
  const chart = shareChart(segs, style)
  return tiles + chart
}

interface ZoneAgg {
  zone: string
  calls: number
  talkSec: number
  cost: number
  hasRate: boolean
  /** Call count per matched tariff destination, so the row can show its makeup. */
  dests: Map<string, number>
}

/** Aggregate external calls by their configured zone (+ an "Unzoned" catch-all),
 *  with talk time and an estimated tariff cost. */
function zoneAggregate(calls: ClassifiedCall[]): ZoneAgg[] {
  const map = new Map<string, ZoneAgg>()
  for (const c of calls) {
    if (c.direction === 'internal') continue
    const zone = c.zone ?? 'Unzoned'
    let r = map.get(zone)
    if (!r) {
      r = { zone, calls: 0, talkSec: 0, cost: 0, hasRate: false, dests: new Map() }
      map.set(zone, r)
    }
    r.calls++
    r.talkSec += c.durationSec
    const dest = c.destLabel ?? 'Unmatched number'
    r.dests.set(dest, (r.dests.get(dest) ?? 0) + 1)
    if (c.rate != null) {
      r.cost += c.rate * (c.durationSec / 60)
      r.hasRate = true
    }
  }
  return [...map.values()].sort((a, b) => {
    // Real zones first (alpha), "Unzoned" always last.
    if (a.zone === 'Unzoned') return 1
    if (b.zone === 'Unzoned') return -1
    return a.zone.localeCompare(b.zone, undefined, { numeric: true })
  })
}

function zonesSection(calls: ClassifiedCall[], style: ChartStyle, showCost: boolean): string {
  const rows = zoneAggregate(calls)
  if (!rows.length)
    return sectionBlock('Call zones', emptyNote('No external calls to place into zones.'))
  // Cost is internal-only; only surface it when explicitly enabled.
  const anyRate = showCost && rows.some((r) => r.hasRate)
  const zonePalette = ['#0ea5e9', '#10b981', '#8b5cf6', '#f59e0b', '#ec4899', '#14b8a6', '#ef4444']
  const segs: Segment[] = rows
    .filter((r) => r.zone !== 'Unzoned')
    .map((r, i) => ({
      label: r.zone,
      value: r.talkSec,
      color: zonePalette[i % zonePalette.length],
      display: fmtDuration(r.talkSec)
    }))
  const chart = segs.length ? shareChart(segs, style) : ''
  // The top destinations behind each zone total, so a surprising number (e.g.
  // "why is most of Ireland in Zone 2?") can be traced without guesswork.
  const makeup = (r: ZoneAgg): string =>
    [...r.dests.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([d, n]) => `${d} (${n})`)
      .join(', ')
  const body = rows
    .map(
      (r) => `<tr class="border-t border-slate-100 dark:border-slate-700/50">
        <td class="py-1 pr-2 whitespace-nowrap">${esc(r.zone)}</td>
        <td class="py-1 pr-2 text-slate-500 dark:text-slate-400">${esc(makeup(r))}</td>
        <td class="py-1 pr-2 text-right tabular-nums">${r.calls}</td>
        <td class="py-1 pr-2 text-right tabular-nums whitespace-nowrap">${fmtDuration(r.talkSec)}</td>
        ${anyRate ? `<td class="py-1 pr-2 text-right tabular-nums whitespace-nowrap">${r.hasRate ? `€${r.cost.toFixed(2)}` : '-'}</td>` : ''}
      </tr>`
    )
    .join('')
  const table = `<div class="mt-4 overflow-x-auto"><table class="w-full text-[11px]">
    <thead><tr class="text-left text-slate-400">
      <th class="pr-2 pb-1 font-medium">Zone</th>
      <th class="pr-2 pb-1 font-medium">Top destinations</th>
      <th class="pr-2 pb-1 font-medium text-right">Calls</th>
      <th class="pr-2 pb-1 font-medium text-right">Talk</th>
      ${anyRate ? '<th class="pr-2 pb-1 font-medium text-right">Est. cost</th>' : ''}
    </tr></thead>
    <tbody>${body}</tbody>
  </table></div>`
  const note = anyRate
    ? '<p class="text-[10px] text-slate-400 mt-1">Estimated cost from the bundled tariff (EUR/min) - indicative only.</p>'
    : ''
  return sectionBlock('Call zones', chart + table + note)
}

/** Re-attach the search box + live-filter the per-extension table only, so the
 *  input keeps focus while typing. */
function wireSearch(
  bodyEl: HTMLElement,
  report: CallReport,
  state: ViewState,
  home: Home,
  ctx: ReportContext
): void {
  const filterEl = bodyEl.querySelector<HTMLInputElement>('#extFilter')
  const wrap = bodyEl.querySelector<HTMLElement>('#extTableWrap')
  if (!filterEl || !wrap) return
  const ringLegs = (): ClassifiedCall[] =>
    applyFilters(classifyCached(report, home, 'leg', ctx), state, { ignoreDepartment: true })
  /** Same rows, plus the ones the report discards — the drill-down exists to
   *  explain the figures, so it has to show what was left out and why. */
  const allLegs = (): ClassifiedCall[] =>
    applyFilters(classifyCached(report, home, 'leg', ctx), state, {
      ignoreDepartment: true,
      keepMisdials: true
    })
  const draw = (): void => {
    wrap.innerHTML = extTable(
      perExtension(ringLegs(), report.perExtension, state.search, ctx, state.department),
      ctx.nameFor,
      state.direction
    )
  }
  filterEl.addEventListener('input', () => {
    state.search = filterEl.value
    draw()
  })

  // Clicking an extension opens the call-log rows its numbers were built from —
  // the only way to check which segments were credited to whom.
  wrap.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-ext-row]')
    if (!row) return
    const ext = row.dataset.extRow!
    const open = row.nextElementSibling
    if (open?.hasAttribute('data-ext-detail')) {
      open.remove()
      return
    }
    for (const el of wrap.querySelectorAll('[data-ext-detail]')) el.remove()
    const detail = document.createElement('tr')
    detail.setAttribute('data-ext-detail', ext)
    const cells = row.children.length
    detail.innerHTML = `<td colspan="${cells}" class="p-0">${extSegments(allLegs(), ext, ctx)}</td>`
    row.after(detail)
  })
}

/** The individual call-log rows behind one extension's figures. */
function extSegments(legs: ClassifiedCall[], ext: string, ctx: ReportContext): string {
  const mine = legs.filter((l) => l.srcDn === ext || l.dstDn === ext || l.extension === ext)
  if (!mine.length) return emptyNote(`No call-log rows for ${ext} under the current filters.`)
  const sorted = [...mine].sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''))
  const shown = sorted.slice(0, 300)
  // Several rows of one call fold into a single call, so say which opened it.
  const seen = new Set<string>()
  const role = (l: ClassifiedCall): string => {
    if (l.misdial) return 'not counted - dialled off-system'
    const rang = l.dstDn ?? (l.direction === 'inbound' ? l.extension : undefined)
    const placed = l.direction === 'outbound' || l.direction === 'internal'
    let label: string
    if (rang === ext) label = l.direction === 'internal' ? 'rang (internal)' : 'rang'
    else if (placed) label = 'placed'
    else return 'not counted'
    if (!l.callId) return label
    const key = `${label}|${l.callId}`
    if (seen.has(key)) return `${label} - same call, folded in`
    seen.add(key)
    return label
  }
  const body = shown
    .map(
      (l) => `<tr class="border-t border-slate-100 dark:border-slate-700/40">
        <td class="py-0.5 pr-2 whitespace-nowrap">${esc(fmtDateTime(l.ts))}</td>
        <td class="py-0.5 pr-2 font-mono text-slate-400">${esc(l.callId ?? '-')}</td>
        <td class="py-0.5 pr-2">${esc(l.direction)}</td>
        <td class="py-0.5 pr-2 font-mono">${esc(l.srcDn ?? '-')} → ${esc(l.dstDn ?? '-')}</td>
        <td class="py-0.5 pr-2">${esc(l.external ?? '')}</td>
        <td class="py-0.5 pr-2 ${l.answered ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}">${l.answered ? 'answered' : 'no answer'}</td>
        <td class="py-0.5 pr-2 text-right tabular-nums whitespace-nowrap">${fmtDuration(l.durationSec)}</td>
        <td class="py-0.5 pr-2 text-slate-400">${esc(role(l))}</td>
      </tr>`
    )
    .join('')
  const more =
    sorted.length > shown.length
      ? `<p class="text-[10px] text-slate-400 px-2 py-1">Showing the first ${shown.length} of ${sorted.length} rows.</p>`
      : ''
  return `<div class="bg-slate-50 dark:bg-slate-900/40 px-3 py-2 border-y border-slate-200 dark:border-slate-700">
    <p class="text-[10px] font-semibold text-slate-500 uppercase tracking-wide mb-1">
      Call-log rows for ${esc(ext)}${ctx.nameFor(ext) ? ` · ${esc(ctx.nameFor(ext)!)}` : ''} — ${sorted.length} row${sorted.length === 1 ? '' : 's'}
    </p>
    <div class="overflow-x-auto"><table class="w-full text-[10px]">
      <thead><tr class="text-left text-slate-400">
        <th class="pr-2 pb-1 font-medium">Time</th>
        <th class="pr-2 pb-1 font-medium">Call ID</th>
        <th class="pr-2 pb-1 font-medium">Direction</th>
        <th class="pr-2 pb-1 font-medium">DN → DN</th>
        <th class="pr-2 pb-1 font-medium">Outside party</th>
        <th class="pr-2 pb-1 font-medium">Result</th>
        <th class="pr-2 pb-1 font-medium text-right">Talk</th>
        <th class="pr-2 pb-1 font-medium">Counted as</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    ${more}
  </div>`
}

// --- Export -----------------------------------------------------------------

type ExportKind = 'calls-csv' | 'ext-csv' | 'pdf'

async function runExport(
  kind: ExportKind,
  report: CallReport,
  state: ViewState,
  customize: ReportCustomize,
  ctx: ReportContext
): Promise<void> {
  const nameFor = ctx.nameFor
  const home = resolveHome(state.home)
  const calls = applyFilters(callsFor(report, state, home, ctx), state)
  const legs = applyFilters(classifyCached(report, home, 'leg', ctx), state)
  const ringLegs = applyFilters(classifyCached(report, home, 'leg', ctx), state, {
    ignoreDepartment: true
  })
  const base = exportBaseName(report)
  let res: { canceled?: boolean; path?: string; error?: string }
  if (kind === 'calls-csv') {
    res = await window.api.report.exportCsv(`${base}-calls.csv`, buildCallsCsv(calls, nameFor))
  } else if (kind === 'ext-csv') {
    const rows = perExtension(ringLegs, report.perExtension, '', ctx, state.department)
    res = await window.api.report.exportCsv(`${base}-extensions.csv`, buildExtCsv(rows, nameFor))
  } else {
    res = await window.api.report.exportPdf(
      `${base}.pdf`,
      buildPrintHtml(report, calls, legs, ringLegs, state, home, customize, ctx)
    )
  }
  if (res?.canceled) return
  if (res?.error) flash(res.error, true)
  else if (res?.path) flash('Exported.')
}

function exportBaseName(report: CallReport): string {
  if (report.name) return report.name.replace(/[^\w.\- ]/g, '_').slice(0, 80)
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
    'Calls',
    'Inbound',
    'Inbound answered',
    'Inbound no answer',
    'Outbound',
    'Outbound answered',
    'Outbound no answer',
    'Internal',
    'Internal answered',
    'Internal no answer',
    'Internal received',
    'Internal received answered',
    'Internal received no answer',
    'Internal placed',
    'Internal placed answered',
    'Internal placed no answer',
    'National',
    'International',
    'Talk (s)',
    'Talk'
  ]
  const body = rows.map((a) => [
    a.extension,
    nameFor(a.extension) ?? '',
    a.calls,
    a.in.calls,
    a.in.answered,
    a.in.missed,
    a.out.calls,
    a.out.answered,
    a.out.missed,
    a.int.calls,
    a.int.answered,
    a.int.missed,
    a.intIn.calls,
    a.intIn.answered,
    a.intIn.missed,
    a.intOut.calls,
    a.intOut.answered,
    a.intOut.missed,
    a.national,
    a.international,
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
    `Department: ${state.department}`,
    `Country: ${state.country}`,
    `Status: ${state.status}`
  ].join('  ·  ')
}

/** Coloured bars for the PDF (inline-styled so they print). */
function pdfBars(segs: Segment[]): string {
  const max = Math.max(1, ...segs.map((s) => s.value))
  return segs
    .map(
      (s) =>
        `<div class="bar"><div class="lab">${esc(s.label)}</div><div class="track"><div class="fill" style="width:${Math.round(
          (s.value / max) * 100
        )}%;background:${s.color}"></div></div><div class="val">${esc(s.display ?? String(s.value))}</div></div>`
    )
    .join('')
}

/** A self-contained, inline-styled HTML document rendered to PDF by the main
 *  process. Kept independent of the app's Tailwind styles. Sections honour the
 *  report customisation: the on-screen order/visibility, with every chart
 *  force-included when "include all charts" is set (for customer-facing PDFs). */
function buildPrintHtml(
  report: CallReport,
  calls: ClassifiedCall[],
  legs: ClassifiedCall[],
  ringLegs: ClassifiedCall[],
  state: ViewState,
  home: Home,
  customize: ReportCustomize,
  ctx: ReportContext
): string {
  const nameFor = ctx.nameFor
  const t = totals(calls)
  const period = report.live
    ? 'Live report - active calls'
    : `${fmtDate(report.from)} → ${fmtDate(report.to)} (inclusive)`
  const title = report.name || (report.live ? 'Live report - active calls' : `Report - ${period}`)
  const kpi = (label: string, value: string): string =>
    `<div class="kpi"><div class="v">${esc(value)}</div><div class="l">${esc(label)}</div></div>`

  const visible = new Map(customize.sections.map((s) => [s.id, s.visible]))
  const chartSections = new Set<SectionId>(['mainChart', 'callTime', 'zones', 'perDay'])
  const want = (id: SectionId): boolean =>
    (visible.get(id) ?? true) || (customize.includeAllChartsInPdf && chartSections.has(id))

  const sectionHtml = (id: SectionId): string => {
    switch (id) {
      case 'summary':
        return `<div class="kpis">
          ${kpi('Calls', String(t.calls))}${kpi('Answered', String(t.answered))}${kpi('Missed', String(t.missed))}
          ${kpi('Inbound', String(t.inbound))}${kpi('Outbound', String(t.outbound))}${kpi('Internal', String(t.internal))}
          ${kpi('National', String(t.national))}${kpi('International', String(t.international))}${kpi('Talk time', fmtDuration(t.talkSec))}
        </div>`
      case 'mainChart':
        return customize.charts
          .map((c) => {
            const gb: GroupBy = report.live && c.groupBy === 'day' ? 'extension' : c.groupBy
            const bars = groupCounts(calls, gb, nameFor)
              .filter((b) => b.value > 0)
              .slice(0, 14)
            const segs: Segment[] = bars.map((b) => ({
              label: b.label,
              value: b.value,
              color: '#0ea5e9',
              display: String(b.value)
            }))
            return `<h2>Breakdown by ${esc(groupLabel(gb))}</h2>${
              segs.length ? pdfBars(segs) : '<p class="sub">No calls match the current filters.</p>'
            }`
          })
          .join('')
      case 'callTime': {
        const segs: Segment[] = [
          { label: 'National', value: t.nationalSec, color: '#10b981', display: fmtDuration(t.nationalSec) },
          { label: 'International', value: t.internationalSec, color: '#8b5cf6', display: fmtDuration(t.internationalSec) },
          { label: 'Internal', value: t.internalSec, color: '#94a3b8', display: fmtDuration(t.internalSec) }
        ]
        return `<h2>Call time — national vs international</h2>
          <div class="kpis">${kpi('National time', fmtDuration(t.nationalSec))}${kpi('International time', fmtDuration(t.internationalSec))}${kpi('Internal time', fmtDuration(t.internalSec))}</div>
          <div style="margin-top:6px">${pdfBars(segs.filter((s) => s.value > 0))}</div>`
      }
      case 'perDay':
        return report.live ? '' : `<h2>Calls per day - inbound vs outbound</h2>${pdfDayChart(calls)}`
      case 'zones': {
        const rows = zoneAggregate(calls)
        if (!rows.length) return ''
        const anyRate = customize.showZoneCost && rows.some((r) => r.hasRate)
        const table = pdfTable(
          anyRate ? ['Zone', 'Calls', 'Talk', 'Est. cost'] : ['Zone', 'Calls', 'Talk'],
          anyRate ? [false, true, true, true] : [false, true, true],
          rows.map((r) =>
            anyRate
              ? [r.zone, r.calls, fmtDuration(r.talkSec), r.hasRate ? `€${r.cost.toFixed(2)}` : '-']
              : [r.zone, r.calls, fmtDuration(r.talkSec)]
          )
        )
        const palette = ['#0ea5e9', '#10b981', '#8b5cf6', '#f59e0b', '#ec4899', '#14b8a6', '#ef4444']
        const segs: Segment[] = rows
          .filter((r) => r.zone !== 'Unzoned')
          .map((r, i) => ({
            label: r.zone,
            value: r.talkSec,
            color: palette[i % palette.length],
            display: fmtDuration(r.talkSec)
          }))
        return `<h2>Call zones</h2>${segs.length ? pdfBars(segs) : ''}${table}`
      }
      case 'departments': {
        const deptAgg = groupAgg(calls, (c) =>
          c.depts?.length ? c.depts : c.dept ? [c.dept] : []
        )
        return deptAgg.length
          ? `<h2>By department</h2>${pdfTable(
              ['Department', 'Calls', 'In', 'Out', 'Talk'],
              [false, true, true, true, true],
              deptAgg.map((r) => [r.key, r.calls, r.inbound, r.outbound, fmtDuration(r.talkSec)])
            )}`
          : ''
      }
      case 'countries':
        return `<h2>Top countries</h2>${pdfTable(
          ['Country', 'Calls', 'In', 'Out', 'Talk'],
          [false, true, true, true, true],
          groupAgg(calls, (c) => [c.country]).map((r) => [
            r.key,
            r.calls,
            r.inbound,
            r.outbound,
            fmtDuration(r.talkSec)
          ])
        )}`
      case 'trunks': {
        const trunkAgg = groupAgg(
          calls.filter((c) => c.trunk),
          (c) => [c.trunk as string]
        )
        return trunkAgg.length
          ? `<h2>By trunk</h2>${pdfTable(
              ['Trunk', 'Calls', 'In', 'Out', 'Talk'],
              [false, true, true, true, true],
              trunkAgg.map((r) => [r.key, r.calls, r.inbound, r.outbound, fmtDuration(r.talkSec)])
            )}`
          : ''
      }
      case 'queues': {
        const rows = queueRollup(legs)
        return rows.length
          ? `<h2>Queues, ring groups &amp; IVRs</h2>${pdfTable(
              ['DN', 'Name', 'Type', 'Calls', 'Answered', 'Abandoned', 'Time here'],
              [false, false, false, true, true, true, true],
              rows.map((r) => [
                r.dn,
                nameFor(r.dn) ?? '',
                DN_KIND_LABEL[r.kind],
                r.calls,
                r.answered,
                r.abandoned,
                fmtDuration(r.talkSec)
              ])
            )}`
          : ''
      }
      case 'extensions': {
        const extRows = perExtension(ringLegs, report.perExtension, '', ctx, state.department)
        const show = visibleColumns(state.direction)
        const heads = ['Ext', 'Name', 'Calls']
        const numeric = [false, false, true]
        for (const [on, label] of [
          [show.in, 'In'],
          [show.out, 'Out'],
          [show.int, 'Int']
        ] as Array<[boolean, string]>) {
          if (!on) continue
          heads.push(`${label} ans`, `${label} miss`)
          numeric.push(true, true)
        }
        if (show.scope) {
          heads.push('Nat', 'Intl')
          numeric.push(true, true)
        }
        heads.push('Talk')
        numeric.push(true)
        return `<h2>Per-extension activity</h2>${pdfTable(
          heads,
          numeric,
          extRows.map((a) => [
            a.extension,
            nameFor(a.extension) ?? '',
            a.calls,
            ...(show.in
              ? state.direction === 'internal'
                ? [a.intIn.answered, a.intIn.missed]
                : [a.in.answered, a.in.missed]
              : []),
            ...(show.out
              ? state.direction === 'internal'
                ? [a.intOut.answered, a.intOut.missed]
                : [a.out.answered, a.out.missed]
              : []),
            ...(show.int ? [a.int.answered, a.int.missed] : []),
            ...(show.scope ? [a.national, a.international] : []),
            fmtDuration(a.talkSec)
          ])
        )}`
      }
      default:
        return ''
    }
  }

  const body = customize.sections
    .filter((s) => want(s.id))
    .map((s) => sectionHtml(s.id))
    .join('\n  ')

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
  .bar .val { width: 60px; text-align: right; color: #475569; }
  .legend { display: flex; gap: 14px; font-size: 10px; color: #475569; margin-top: 4px; }
  .legend span { display: inline-flex; align-items: center; gap: 4px; }
  .sw { display: inline-block; width: 9px; height: 9px; border-radius: 2px; }
</style></head><body>
  <h1>${esc(title)}</h1>
  <p class="sub">${esc(period)} · Generated ${esc(fmtDateTime(report.generatedAt))}${report.baseUrl ? ` · ${esc(report.baseUrl.replace(/^https?:\/\//, ''))}` : ''}</p>
  ${report.scope?.label ? `<p class="sub">Scope: ${esc(report.scope.label)}</p>` : ''}
  <p class="filters">${esc(filtersSummary(state, home))}</p>
  ${body}
</body></html>`
}

interface AggRow {
  key: string
  calls: number
  inbound: number
  outbound: number
  talkSec: number
}
/** `keysOf` may return several keys — a call counts under each. Departments need
 *  that: an extension can serve more than one and the filter matches any of them,
 *  so rows can sum to more than the total. */
function groupAgg(calls: ClassifiedCall[], keysOf: (c: ClassifiedCall) => string[]): AggRow[] {
  const map = new Map<string, AggRow>()
  for (const c of calls) {
    for (const k of keysOf(c)) {
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

interface Totals {
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
  nationalSec: number
  internationalSec: number
  internalSec: number
}

export function totals(calls: ClassifiedCall[]): Totals {
  const exts = new Set<string>()
  let answered = 0
  let inbound = 0
  let outbound = 0
  let internal = 0
  let national = 0
  let international = 0
  let talkSec = 0
  let nationalSec = 0
  let internationalSec = 0
  let internalSec = 0
  for (const c of calls) {
    if (c.answered) answered++

    if (c.direction === 'inbound') inbound++
    else if (c.direction === 'outbound') outbound++
    else if (c.direction === 'internal') internal++
    if (c.scope === 'national') {
      national++
      nationalSec += c.durationSec
    } else if (c.scope === 'international') {
      international++
      internationalSec += c.durationSec
    } else if (c.scope === 'internal') {
      internalSec += c.durationSec
    }
    talkSec += c.durationSec
    // People, not queues or trunk pseudo-DNs — the same rule the per-extension
    // table follows.
    if (c.extension && !isInfrastructureDn(c.dnKind)) exts.add(c.extension)
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
    talkSec,
    nationalSec,
    internationalSec,
    internalSec
  }
}

export interface DirectionTally {
  /** Attempts in this direction — answered + missed. */
  calls: number
  answered: number
  missed: number
}

export interface ExtRow {
  extension: string
  /** Every attempt involving this extension, in any direction. */
  calls: number
  /** Calls that rang this extension from outside. */
  in: DirectionTally
  /** Calls this extension placed to the outside. */
  out: DirectionTally
  /** Extension-to-extension, counted for both parties — the one who dialled and
   *  the one who was rung, exactly as 3CX's own per-extension report does.
   *  `int` is the two below added together. */
  int: DirectionTally
  /** Internal calls this extension received. */
  intIn: DirectionTally
  /** Internal calls this extension placed. */
  intOut: DirectionTally
  national: number
  international: number
  talkSec: number
  active: boolean
}

const emptyTally = (): DirectionTally => ({ calls: 0, answered: 0, missed: 0 })

/** Per-extension activity, built from the individual call legs — the same shape
 *  as 3CX's Extension Statistics, so the two can be read side by side. Not built
 *  from the collapsed calls: those belong to whoever answered, which folds away
 *  anything that rang elsewhere first. Queues, ring groups, IVRs and trunk
 *  pseudo-DNs are left out; they get their own section. */
export function perExtension(
  legs: ClassifiedCall[],
  base: ExtensionActivity[],
  search: string,
  ctx: ReportContext,
  /** The department currently filtered to, or 'all'. */
  deptFilter = 'all'
): ExtRow[] {
  const activeSet = new Set(base.filter((a) => a.active).map((a) => a.extension))
  const map = new Map<string, ExtRow>()
  const get = (ext: string): ExtRow => {
    let r = map.get(ext)
    if (!r) {
      r = {
        extension: ext,
        calls: 0,
        in: emptyTally(),
        out: emptyTally(),
        int: emptyTally(),
        intIn: emptyTally(),
        intOut: emptyTally(),
        national: 0,
        international: 0,
        talkSec: 0,
        active: activeSet.has(ext)
      }
      map.set(ext, r)
    }
    return r
  }
  /** A DN only earns a row if it's a person on this system and passes whatever
   *  department is being filtered to. The department has to be judged on the
   *  extension being credited, not on the one the leg is attributed to. */
  const eligible = (dn: string | undefined): dn is string => {
    if (!dn || isInfrastructureDn(ctx.kindFor(dn))) return false
    if (deptFilter === 'all') return true
    const depts = ctx.deptsFor(dn)
    return depts.length ? depts.includes(deptFilter) : ctx.deptFor(dn) === deptFilter
  }

  // Matched against 3CX's Extension Statistics: ONE call per extension per
  // direction, however many segments the log writes for it (a ring then
  // voicemail; an outbound call retried down three trunks). "Answered" is judged
  // oppositely by direction, and both ways round are right:
  //   · RECEIVED — answered only if nothing rang unanswered. That gets voicemail
  //     right without identifying it: the ring is what was missed.
  //   · PLACED — answered if any attempt connected.
  // `toVoicemail` is deliberately unused: it also matches the ring itself, and
  // calls genuinely answered before being passed on later.
  type Bucket = {
    ext: string
    /** 'intIn'/'intOut' keep the two sides of an internal call apart. */
    role: 'in' | 'out' | 'intIn' | 'intOut'
    anyAnswered: boolean
    anyUnanswered: boolean
    scope: ClassifiedCall['scope']
  }
  const buckets = new Map<string, Bucket>()
  let loose = 0
  const note = (ext: string, role: Bucket['role'], l: ClassifiedCall): void => {
    // Talk time is summed over every segment — that is what matches 3CX's
    // "Total Talking", so it sits outside the one-row-per-call accounting.
    get(ext).talkSec += l.durationSec
    const key = `${ext}|${role}|${l.callId ?? `#${loose++}`}`
    const b = buckets.get(key)
    if (b) {
      if (l.answered) b.anyAnswered = true
      else b.anyUnanswered = true
      return
    }
    buckets.set(key, {
      ext,
      role,
      anyAnswered: !!l.answered,
      anyUnanswered: !l.answered,
      scope: l.scope
    })
  }

  // A dial that never reached a trunk is logged as "internal" whatever was
  // dialled, so 2069 → 10960997 and 2069 → +353872337329 both arrive here as
  // internal calls. They're misdials, not calls to a colleague, and 3CX leaves
  // them out of its internal figures — counting them added four phantom missed
  // calls to that one extension alone.
  for (const l of legs) {
    // Who was rung. `extension` is the caller on an internal leg, so only the
    // destination DN says who the call actually reached.
    const rang = l.dstDn ?? (l.direction === 'inbound' ? l.extension : undefined)
    const placed = l.srcDn ?? l.extension
    // Belt and braces: `classify` already flags these, but perExtension is
    // exported and called directly by tests.
    if (l.direction === 'internal' && !l.answered && isOffSystemDn(ctx, rang)) continue
    if (eligible(rang)) note(rang, l.direction === 'internal' ? 'intIn' : 'in', l)
    // Who placed it. Both sides of an internal call are counted, which is why an
    // internal call appears once for the caller and once for the callee.
    if (l.direction === 'outbound' || l.direction === 'internal') {
      if (eligible(placed) && placed !== rang)
        note(placed, l.direction === 'internal' ? 'intOut' : 'out', l)
    }
  }

  for (const b of buckets.values()) {
    const tally = b.role
    const received = b.role === 'in' || b.role === 'intIn'
    const answered = received ? !b.anyUnanswered : b.anyAnswered
    const r = get(b.ext)
    r.calls++
    r[tally].calls++
    if (answered) r[tally].answered++
    else r[tally].missed++
    if (b.scope === 'national') r.national++
    else if (b.scope === 'international') r.international++
  }

  // The two halves of internal, added up for the combined column.
  for (const r of map.values()) {
    r.int = {
      calls: r.intIn.calls + r.intOut.calls,
      answered: r.intIn.answered + r.intOut.answered,
      missed: r.intIn.missed + r.intOut.missed
    }
  }
  const t = search.trim().toLowerCase()
  return [...map.values()]
    .filter(
      (r) =>
        !t || r.extension.includes(t) || (ctx.nameFor(r.extension) ?? '').toLowerCase().includes(t)
    )
    .sort((a, b) => b.calls - a.calls || b.talkSec - a.talkSec)
}

interface Bar {
  key: string
  label: string
  value: number
}

/** Group filtered calls into {label, value} buckets for the main chart. */
export function groupCounts(
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
        return c.extension ?? '-'
      case 'country':
        return c.country
      case 'trunk':
        return c.trunk ?? '(no trunk)'
      case 'department':
        return c.dept ?? '(no department)'
      case 'direction':
        return c.direction
      case 'scope':
        return c.scope
      case 'day':
        return c.day ?? 'unknown'
      default:
        return '-'
    }
  }
  for (const c of calls) {
    // "Breakdown by extension" was listing the queue and the trunk alongside
    // people, which is the same thing that padded the per-extension table.
    if (groupBy === 'extension' && (!c.extension || isInfrastructureDn(c.dnKind))) continue
    if (groupBy === 'department') {
      // An extension can serve several departments; count it under each, the way
      // the department filter matches each.
      const depts = c.depts?.length ? c.depts : c.dept ? [c.dept] : []
      for (const d of depts) map.set(d, (map.get(d) ?? 0) + 1)
      continue
    }
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

/** The customisable main chart: a column chart for day/hour (ordered series,
 *  where a pie makes no sense), otherwise the chosen style — a horizontal bar
 *  chart or a pie / donut of the ranked categories. */
function mainChart(
  calls: ClassifiedCall[],
  groupBy: GroupBy,
  nameFor: (ext: string) => string | undefined,
  style: ChartStyle
): string {
  const bars = groupCounts(calls, groupBy, nameFor)
  if (!bars.some((b) => b.value > 0)) return emptyNote('No calls match the current filters.')
  // Bars: an ordered column chart for time series (day/hour), a ranked
  // horizontal bar chart otherwise. Pie/donut: top categories as slices — always
  // honoured, so switching style always changes the chart.
  if (style === 'bar') {
    return groupBy === 'day' || groupBy === 'hour' ? columnChart(bars) : barChart(bars.slice(0, 14))
  }
  const ranked = bars.slice(0, 14)
  const segs: Segment[] = ranked.map((b, i) => ({
    label: b.label,
    value: b.value,
    color: CAT_PALETTE[i % CAT_PALETTE.length],
    display: String(b.value)
  }))
  return shareChart(segs, style)
}

/** Categorical colour palette for pie / donut slices. */
const CAT_PALETTE = [
  '#0ea5e9',
  '#10b981',
  '#8b5cf6',
  '#f59e0b',
  '#ec4899',
  '#14b8a6',
  '#ef4444',
  '#6366f1',
  '#84cc16',
  '#eab308',
  '#f97316',
  '#06b6d4',
  '#a855f7',
  '#64748b'
]

interface Segment {
  label: string
  value: number
  color: string
  /** Legend value text (defaults to the raw value). */
  display?: string
}

/** Render a set of shares either as a pie/donut (SVG + legend) or coloured bars,
 *  per the chosen style. */
function shareChart(segs: Segment[], style: ChartStyle): string {
  const usable = segs.filter((s) => s.value > 0)
  if (!usable.length) return emptyNote('Nothing to chart for the current filters.')
  return style === 'bar' ? segmentBars(usable) : pieChart(usable, style === 'donut')
}

/** SVG pie (or donut) with a legend beneath. */
function pieChart(segs: Segment[], donut: boolean): string {
  const total = segs.reduce((a, s) => a + s.value, 0)
  if (total <= 0) return emptyNote('Nothing to chart.')
  const cx = 50
  const cy = 50
  const r = 46
  const polar = (deg: number): [number, number] => {
    const a = ((deg - 90) * Math.PI) / 180
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
  }
  let angle = 0
  const slices = segs
    .map((s) => {
      const frac = s.value / total
      const start = angle
      const end = angle + frac * 360
      angle = end
      // A single 100% slice can't be drawn as an arc — render a full circle.
      if (frac >= 0.9999)
        return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${s.color}"><title>${esc(s.label)}: ${esc(s.display ?? String(s.value))}</title></circle>`
      const [x1, y1] = polar(start)
      const [x2, y2] = polar(end)
      const large = end - start > 180 ? 1 : 0
      return `<path d="M${cx},${cy} L${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z" fill="${s.color}"><title>${esc(s.label)}: ${esc(s.display ?? String(s.value))}</title></path>`
    })
    .join('')
  const hole = donut
    ? `<circle cx="${cx}" cy="${cy}" r="${r * 0.58}" class="fill-white dark:fill-slate-800" />`
    : ''
  const legend = segs
    .map(
      (s) =>
        `<span class="flex items-center gap-1.5"><span class="inline-block w-2.5 h-2.5 rounded-sm shrink-0" style="background:${s.color}"></span><span class="truncate">${esc(s.label)}</span><span class="text-slate-400 tabular-nums">${esc(s.display ?? String(s.value))}</span></span>`
    )
    .join('')
  return `<div class="flex items-center gap-4 flex-wrap">
      <svg viewBox="0 0 100 100" class="w-32 h-32 shrink-0">${slices}${hole}</svg>
      <div class="flex-1 min-w-[8rem] grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-300">${legend}</div>
    </div>`
}

/** Coloured horizontal bars for a set of shares (used by pie-style sections when
 *  the user prefers bars). */
function segmentBars(segs: Segment[]): string {
  const max = Math.max(1, ...segs.map((s) => s.value))
  return `<div class="space-y-1">${segs
    .map((s) => {
      const pct = Math.round((s.value / max) * 100)
      return `<div class="flex items-center gap-2 text-xs">
        <div class="w-40 shrink-0 truncate text-slate-600 dark:text-slate-300" title="${esc(s.label)}">${esc(s.label)}</div>
        <div class="flex-1 h-4 rounded bg-slate-100 dark:bg-slate-900 overflow-hidden">
          <div class="h-full" style="width:${pct}%;background:${s.color}"></div>
        </div>
        <div class="w-16 shrink-0 text-right tabular-nums text-slate-500">${esc(s.display ?? String(s.value))}</div>
      </div>`
    })
    .join('')}</div>`
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
          `<rect x="${x}" y="${yTop.toFixed(2)}" width="${w}" height="${h.toFixed(2)}" fill="${color}"><title>${esc(day)} - ${name}: ${n}</title></rect>`
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

/** Which column groups can hold anything for the direction being viewed. */
export function visibleColumns(direction: ViewState['direction']): {
  in: boolean
  out: boolean
  int: boolean
  scope: boolean
} {
  // Internal on its own is split into received and placed under the Inbound /
  // Outbound headings, which is how 3CX presents it — hence 'internal' turning
  // both of those on.
  return {
    in:
      direction === 'all' ||
      direction === 'external' ||
      direction === 'inbound' ||
      direction === 'internal',
    out:
      direction === 'all' ||
      direction === 'external' ||
      direction === 'outbound' ||
      direction === 'internal',
    // The combined internal column only earns its place alongside the others.
    int: direction === 'all',
    // National vs international is a property of the outside party, so it says
    // nothing about a purely internal call.
    scope: direction !== 'internal'
  }
}

function extTable(
  rows: ExtRow[],
  nameFor: (ext: string) => string | undefined,
  direction: ViewState['direction']
): string {
  if (!rows.length) return emptyNote('No matching extensions.')
  const show = visibleColumns(direction)
  const internalOnly = direction === 'internal'
  const inbound = (a: ExtRow): DirectionTally => (internalOnly ? a.intIn : a.in)
  const outbound = (a: ExtRow): DirectionTally => (internalOnly ? a.intOut : a.out)
  const num = (v: number, cls = ''): string =>
    `<td class="py-1 pr-2 text-right tabular-nums ${cls}">${v}</td>`
  const pair = (t: DirectionTally): string =>
    `${num(t.answered, 'text-emerald-600 dark:text-emerald-400')}${num(t.missed, t.missed ? 'text-amber-600 dark:text-amber-400' : 'text-slate-400')}`

  const body = rows
    .map((a) => {
      const name = nameFor(a.extension)
      return `<tr data-ext-row="${esc(a.extension)}" class="border-t border-slate-100 dark:border-slate-700/50 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/40" title="Show the call-log rows behind these numbers">
        <td class="py-1 pr-2 font-mono whitespace-nowrap">${esc(a.extension)}</td>
        <td class="py-1 pr-2 truncate max-w-[150px]">${esc(name ?? '')}</td>
        ${num(a.calls, 'font-medium')}
        ${show.in ? pair(inbound(a)) : ''}
        ${show.out ? pair(outbound(a)) : ''}
        ${show.int ? pair(a.int) : ''}
        ${show.scope ? num(a.national) + num(a.international, 'text-violet-600 dark:text-violet-400') : ''}
        <td class="py-1 pr-2 text-right tabular-nums whitespace-nowrap">${fmtDuration(a.talkSec)}</td>
        <td class="py-1 text-center">${a.active ? '<span class="text-emerald-500">●</span>' : '<span class="text-slate-300 dark:text-slate-600">○</span>'}</td>
      </tr>`
    })
    .join('')

  // Two header rows, grouping answered/unanswered under each direction the same
  // way 3CX's Extension Statistics does, so the two read the same.
  const group = (label: string, title: string): string =>
    `<th colspan="2" class="pb-0.5 px-2 font-medium text-center border-b border-slate-200 dark:border-slate-700" title="${esc(title)}">${esc(label)}</th>`
  const stacked = (label: string, title = ''): string =>
    `<th rowspan="2" class="pr-2 pb-1 font-medium align-bottom ${label === 'Ext' || label === 'Name' ? 'text-left' : 'text-right'}"${title ? ` title="${esc(title)}"` : ''}>${esc(label)}</th>`
  const sub = (label: string, title: string): string =>
    `<th class="pr-2 pb-1 font-medium text-right" title="${esc(title)}">${esc(label)}</th>`

  return `<table class="w-full text-[11px]">
    <thead class="text-slate-400">
      <tr class="text-left">
        ${stacked('Ext')}${stacked('Name')}
        ${stacked('Calls', 'Every attempt involving this extension, in any direction')}
        ${show.in ? group('Inbound', internalOnly ? 'Internal calls that rang this extension' : 'Calls that rang this extension from outside') : ''}
        ${show.out ? group('Outbound', internalOnly ? 'Internal calls this extension placed' : 'Calls this extension placed to the outside') : ''}
        ${show.int ? group('Internal', 'Extension to extension - counted for both the caller and the person they rang') : ''}
        ${show.scope ? stacked('Nat', 'Calls to or from this country') + stacked('Intl', 'Calls to or from abroad') : ''}
        ${stacked('Talk')}${stacked('Active')}
      </tr>
      <tr class="text-left">
        ${show.in ? sub('Ans', 'Answered at this extension') + sub('Miss', "Rang here and wasn't answered here") : ''}
        ${show.out ? sub('Ans', 'The far end picked up') + sub('Miss', 'No answer at the far end') : ''}
        ${show.int ? sub('Ans', 'Answered') + sub('Miss', 'No answer') : ''}
      </tr>
    </thead>
    <tbody>${body}</tbody>
  </table>`
}

interface QueueRow {
  dn: string
  kind: DnKind
  calls: number
  answered: number
  abandoned: number
  talkSec: number
}

/** Queues, ring groups and IVRs, rolled up by the calls that passed THROUGH
 *  them — which is a different question from "who handled the call" and can only
 *  be answered from the individual legs, since the collapsed call belongs to the
 *  agent. A call counts as answered here if it was answered anywhere after
 *  arriving, and abandoned if it never was. */
export function queueRollup(legs: ClassifiedCall[]): QueueRow[] {
  const answeredCalls = new Set<string>()
  for (const l of legs) if (l.answered && l.callId) answeredCalls.add(l.callId)
  const map = new Map<string, QueueRow & { seen: Set<string> }>()
  for (const l of legs) {
    if (!l.extension || !isInfrastructureDn(l.dnKind) || l.dnKind === 'trunk') continue
    let r = map.get(l.extension)
    if (!r) {
      r = {
        dn: l.extension,
        kind: l.dnKind!,
        calls: 0,
        answered: 0,
        abandoned: 0,
        talkSec: 0,
        seen: new Set()
      }
      map.set(l.extension, r)
    }
    // One row per call that entered, not per leg — a call can hit the same queue
    // more than once (overflow, re-queue).
    const key = l.callId ?? `${l.ts}|${l.external}`
    if (r.seen.has(key)) continue
    r.seen.add(key)
    r.calls++
    if (l.callId ? answeredCalls.has(l.callId) : l.answered) r.answered++
    else r.abandoned++
    r.talkSec += l.durationSec
  }
  return [...map.values()]
    .map((r): QueueRow => ({
      dn: r.dn,
      kind: r.kind,
      calls: r.calls,
      answered: r.answered,
      abandoned: r.abandoned,
      talkSec: r.talkSec
    }))
    .sort((a, b) => b.calls - a.calls)
}

const DN_KIND_LABEL: Record<DnKind, string> = {
  user: 'Extension',
  queue: 'Queue',
  ringGroup: 'Ring group',
  ivr: 'IVR',
  trunk: 'Trunk',
  other: 'Other'
}

function queueTable(rows: QueueRow[], nameFor: (dn: string) => string | undefined): string {
  if (!rows.length)
    return emptyNote('No calls went through a queue, ring group or IVR in this report.')
  const body = rows
    .map(
      (r) => `<tr class="border-t border-slate-100 dark:border-slate-700/50">
        <td class="py-1 pr-2 font-mono whitespace-nowrap">${esc(r.dn)}</td>
        <td class="py-1 pr-2 truncate max-w-[180px]">${esc(nameFor(r.dn) ?? '')}</td>
        <td class="py-1 pr-2 text-slate-400 whitespace-nowrap">${esc(DN_KIND_LABEL[r.kind])}</td>
        <td class="py-1 pr-2 text-right tabular-nums">${r.calls}</td>
        <td class="py-1 pr-2 text-right tabular-nums text-emerald-600 dark:text-emerald-400">${r.answered}</td>
        <td class="py-1 pr-2 text-right tabular-nums text-amber-600 dark:text-amber-400">${r.abandoned}</td>
        <td class="py-1 pr-2 text-right tabular-nums whitespace-nowrap">${fmtDuration(r.talkSec)}</td>
      </tr>`
    )
    .join('')
  return `<table class="w-full text-[11px]">
    <thead><tr class="text-left text-slate-400">
      <th class="pr-2 font-medium">DN</th><th class="pr-2 font-medium">Name</th>
      <th class="pr-2 font-medium">Type</th>
      <th class="pr-2 font-medium text-right" title="Calls that arrived here">Calls</th>
      <th class="pr-2 font-medium text-right" title="Answered somewhere after arriving here">Answered</th>
      <th class="pr-2 font-medium text-right" title="Never answered by anyone">Abandoned</th>
      <th class="pr-2 font-medium text-right" title="Time spent on this leg - queue wait, IVR prompts">Time here</th>
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
    department: 'department',
    direction: 'direction',
    scope: 'national / international',
    hour: 'hour of day'
  }[g]
}

// --- Home-country persistence ----------------------------------------------

/** ISO2 the home country falls back to when the user hasn't chosen one. */
const DEFAULT_HOME_COUNTRY = 'IE'

export function readHomeCountry(): string {
  try {
    return localStorage.getItem(HOME_KEY) ?? DEFAULT_HOME_COUNTRY
  } catch {
    return DEFAULT_HOME_COUNTRY
  }
}
export function writeHomeCountry(iso2: string): void {
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
/** The calendar day of an ISO instant, in the viewer's own time zone. A report's
 *  bounds are stored as instants (local midnight, converted to UTC), so slicing
 *  the ISO string showed the day before for anyone east of UTC — a 1–31 July
 *  report announced itself as starting on 30 June. */
function fmtDate(iso?: string): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function fmtDateTime(iso?: string): string {
  if (!iso) return '-'
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
