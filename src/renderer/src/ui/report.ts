// The call-activity report UI: a period picker, and an interactive modal that
// summarises a CallReport with stat tiles, inline SVG charts and a searchable
// per-extension table (answering "did ext N receive calls / was it active?").
//
// Reports are fetched + persisted by the main process (see report:* IPC); this
// module only renders and drives save/open.

import type { CallReport, ExtensionActivity } from '../../../shared/types'

const esc = (s: unknown): string =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )

const btn = 'px-3 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-sm text-slate-100'

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
  width = 'w-[860px]'
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

/** Render a report into an interactive modal. */
export function showReport(report: CallReport, nameFor: (ext: string) => string | undefined): void {
  const totals = summarise(report)
  const title = report.live
    ? 'Live report — active calls'
    : `Report — ${fmtDate(report.from)} → ${fmtDate(report.to)}`

  const { overlay, close } = openOverlay(`
    <div class="flex items-center justify-between gap-2 px-4 py-3 border-b border-slate-200 dark:border-slate-700 shrink-0">
      <div class="min-w-0">
        <h2 class="font-semibold text-slate-800 dark:text-slate-100 truncate">${esc(title)}</h2>
        <p class="text-[11px] text-slate-400">Generated ${esc(fmtDateTime(report.generatedAt))}${report.baseUrl ? ` · ${esc(report.baseUrl.replace(/^https?:\/\//, ''))}` : ''}</p>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <button id="saveReport" class="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-100 text-xs">Save</button>
        <button data-close class="text-slate-400 hover:text-slate-700 dark:hover:text-slate-100 text-lg leading-none">✕</button>
      </div>
    </div>
    <div class="overflow-y-auto p-4 space-y-4">
      ${report.error ? `<div class="px-3 py-2 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200 text-xs">${esc(report.error)}</div>` : ''}
      <div class="grid grid-cols-2 sm:grid-cols-5 gap-2" id="tiles">
        ${tile('Calls', String(totals.calls))}
        ${tile('Answered', String(totals.answered))}
        ${tile('Missed', String(totals.missed))}
        ${tile('Active exts', String(totals.activeExts))}
        ${tile('Talk time', fmtDuration(totals.talkSec))}
      </div>
      ${report.perExtension.length ? `<div><h3 class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Busiest extensions</h3>${barChart(report.perExtension.slice(0, 12), nameFor)}</div>` : ''}
      ${!report.live && report.entries.length ? `<div><h3 class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Calls per day</h3>${timeChart(report)}</div>` : ''}
      <div>
        <div class="flex items-center justify-between mb-1.5 gap-2">
          <h3 class="text-xs font-semibold text-slate-500 uppercase tracking-wide">Per-extension activity</h3>
          <input id="extFilter" type="text" placeholder="Find extension…" class="px-2 py-1 rounded bg-slate-100 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-xs w-48" />
        </div>
        <div id="extTableWrap" class="overflow-x-auto">${extTable(report.perExtension, nameFor)}</div>
      </div>
    </div>`)

  overlay
    .querySelectorAll<HTMLElement>('[data-close]')
    .forEach((b) => b.addEventListener('click', close))
  overlay.querySelector('#saveReport')!.addEventListener('click', async () => {
    const res = await window.api.report.save(report)
    if (res.error) flash(res.error, true)
    else if (res.path) flash('Report saved.')
  })

  const filterEl = overlay.querySelector<HTMLInputElement>('#extFilter')!
  const wrap = overlay.querySelector<HTMLElement>('#extTableWrap')!
  filterEl.addEventListener('input', () => {
    const t = filterEl.value.trim().toLowerCase()
    const rows = report.perExtension.filter(
      (a) => !t || a.extension.includes(t) || (nameFor(a.extension) ?? '').toLowerCase().includes(t)
    )
    wrap.innerHTML = extTable(rows, nameFor)
  })
}

// --- Aggregation ------------------------------------------------------------

function summarise(report: CallReport): {
  calls: number
  answered: number
  missed: number
  activeExts: number
  talkSec: number
} {
  const answered = report.entries.filter((e) => e.answered).length
  return {
    calls: report.entries.length,
    answered,
    missed: report.entries.length - answered,
    activeExts: report.perExtension.filter((a) => a.active).length,
    talkSec: report.perExtension.reduce((s, a) => s + a.totalTalkSec, 0)
  }
}

// --- Rendering helpers ------------------------------------------------------

function tile(label: string, value: string): string {
  return `<div class="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50 px-3 py-2">
    <div class="text-lg font-semibold text-slate-800 dark:text-slate-100 tabular-nums">${esc(value)}</div>
    <div class="text-[10px] text-slate-400 uppercase tracking-wide">${esc(label)}</div>
  </div>`
}

/** Horizontal bar chart of the busiest extensions (received + placed). */
function barChart(rows: ExtensionActivity[], nameFor: (ext: string) => string | undefined): string {
  const max = Math.max(1, ...rows.map((a) => a.received + a.placed))
  return `<div class="space-y-1">${rows
    .map((a) => {
      const total = a.received + a.placed
      const pct = Math.round((total / max) * 100)
      const label = nameFor(a.extension)
      return `<div class="flex items-center gap-2 text-xs">
        <div class="w-28 shrink-0 truncate text-slate-600 dark:text-slate-300" title="${esc(label ?? a.extension)}">${esc(a.extension)}${label ? ` <span class="text-slate-400">${esc(label)}</span>` : ''}</div>
        <div class="flex-1 h-4 rounded bg-slate-100 dark:bg-slate-900 overflow-hidden">
          <div class="h-full bg-sky-500/80" style="width:${pct}%"></div>
        </div>
        <div class="w-10 shrink-0 text-right tabular-nums text-slate-500">${total}</div>
      </div>`
    })
    .join('')}</div>`
}

/** Column chart of calls per day over the report period. */
function timeChart(report: CallReport): string {
  const byDay = new Map<string, number>()
  for (const e of report.entries) {
    const d = e.startTime ? e.startTime.slice(0, 10) : 'unknown'
    byDay.set(d, (byDay.get(d) ?? 0) + 1)
  }
  const days = [...byDay.entries()]
    .filter(([d]) => d !== 'unknown')
    .sort(([a], [b]) => a.localeCompare(b))
  if (!days.length) return '<p class="text-xs text-slate-400">No dated calls to chart.</p>'
  const max = Math.max(1, ...days.map(([, n]) => n))
  const bw = 100 / days.length
  const bars = days
    .map(([d, n], i) => {
      const h = (n / max) * 100
      return `<rect x="${(i * bw + bw * 0.15).toFixed(2)}" y="${(100 - h).toFixed(2)}" width="${(bw * 0.7).toFixed(2)}" height="${h.toFixed(2)}" rx="0.6" fill="currentColor" opacity="0.75"><title>${esc(d)}: ${n}</title></rect>`
    })
    .join('')
  return `<svg viewBox="0 0 100 100" preserveAspectRatio="none" class="w-full h-24 text-sky-500">${bars}</svg>
    <div class="flex justify-between text-[10px] text-slate-400 mt-0.5"><span>${esc(days[0][0])}</span><span>${esc(days[days.length - 1][0])}</span></div>`
}

function extTable(rows: ExtensionActivity[], nameFor: (ext: string) => string | undefined): string {
  if (!rows.length) return '<p class="text-xs text-slate-400 py-2">No matching extensions.</p>'
  const body = rows
    .map((a) => {
      const name = nameFor(a.extension)
      return `<tr class="border-t border-slate-100 dark:border-slate-700/50">
        <td class="py-1 pr-2 font-mono whitespace-nowrap">${esc(a.extension)}</td>
        <td class="py-1 pr-2 truncate max-w-[160px]">${esc(name ?? '')}</td>
        <td class="py-1 pr-2 text-right tabular-nums">${a.received}</td>
        <td class="py-1 pr-2 text-right tabular-nums text-emerald-600 dark:text-emerald-400">${a.answered}</td>
        <td class="py-1 pr-2 text-right tabular-nums text-amber-600 dark:text-amber-400">${a.missed}</td>
        <td class="py-1 pr-2 text-right tabular-nums">${a.placed}</td>
        <td class="py-1 pr-2 text-right tabular-nums whitespace-nowrap">${fmtDuration(a.totalTalkSec)}</td>
        <td class="py-1 text-center">${a.active ? '<span class="text-emerald-500">●</span>' : '<span class="text-slate-300 dark:text-slate-600">○</span>'}</td>
      </tr>`
    })
    .join('')
  return `<table class="w-full text-[11px]">
    <thead><tr class="text-left text-slate-400">
      <th class="pr-2 font-medium">Ext</th><th class="pr-2 font-medium">Name</th>
      <th class="pr-2 font-medium text-right">Recv</th><th class="pr-2 font-medium text-right">Ans</th>
      <th class="pr-2 font-medium text-right">Miss</th><th class="pr-2 font-medium text-right">Placed</th>
      <th class="pr-2 font-medium text-right">Talk</th><th class="font-medium text-center">Active</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table>`
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
