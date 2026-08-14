// The reports tray: a toolbar chip showing report generation running in the
// background, opening onto the jobs in flight and the reports folder. Generation
// itself lives in the main process (see main/reports.ts); this is a view over it.

import type { ReportJob, SavedReportInfo } from '../../../shared/types'
import { esc, flash, openReportPath } from './report'
import type { ReportContext } from './report-context'
import { hidePopover, showPopover } from './motion'
import { ICONS } from './icons'

function fmtBytes(n?: number): string {
  if (!n) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function fmtWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const mins = Math.round((Date.now() - d.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`
  return d.toLocaleDateString()
}

export interface ReportTray {
  /** Shut the panel — used so the tray and the main menu can't overlap. */
  close: () => void
  dispose: () => void
}

/** Mount the tray into a toolbar slot.
 *
 *  `btnClass` comes from the toolbar so the chip is the same size as the buttons
 *  beside it, and `onOpen` lets the host close whatever else is showing. */
export function mountReportTray(
  host: HTMLElement,
  ctx: ReportContext,
  opts: { btnClass: string; onOpen?: () => void } = { btnClass: '' }
): ReportTray {
  let jobs: ReportJob[] = []
  let saved: SavedReportInfo[] = []
  let open = false
  let savedLoaded = false
  /** Finished jobs the user has already looked at — they stay listed in the
   *  panel but stop badging the chip. */
  const seen = new Set<string>()

  host.innerHTML = `
    <button id="reportTrayBtn" class="relative ${opts.btnClass}"
      title="Reports" aria-label="Reports">
      <span id="reportTrayIcon">${ICONS.chart}</span>
      <span id="reportTrayBadge" class="hidden absolute -top-1 -right-1 min-w-[1rem] h-4 px-1 rounded-full bg-sky-600 text-white text-[10px] leading-4 text-center"></span>
    </button>
    <div id="reportTrayPanel" class="hidden absolute right-0 top-full mt-1 z-40 w-[26rem] max-h-[70vh] overflow-y-auto rounded-md bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 shadow-xl border border-slate-200 dark:border-slate-700"></div>`

  const btnEl = host.querySelector<HTMLButtonElement>('#reportTrayBtn')!
  const iconEl = host.querySelector<HTMLElement>('#reportTrayIcon')!
  const badgeEl = host.querySelector<HTMLElement>('#reportTrayBadge')!
  const panelEl = host.querySelector<HTMLElement>('#reportTrayPanel')!

  const running = (): ReportJob[] => jobs.filter((j) => j.status === 'running')

  /** A spinner and percentage while generating, a plain icon otherwise. */
  const renderChip = (): void => {
    const active = running()
    const finished = jobs.filter((j) => j.status === 'done' && !seen.has(j.id))
    if (active.length) {
      const pct = active[0].progress != null ? Math.round(active[0].progress * 100) : null
      iconEl.innerHTML = ICONS.hourglass
      iconEl.className = 'inline-block animate-pulse'
      badgeEl.classList.remove('hidden')
      badgeEl.textContent = active.length > 1 ? String(active.length) : (pct != null ? `${pct}` : '…')
      btnEl.title = active
        .map((j) => `${j.name} - ${j.phase}`)
        .join('\n')
        .concat('\n\nClick to see progress or cancel.')
    } else {
      iconEl.innerHTML = ICONS.chart
      iconEl.className = 'inline-block'
      badgeEl.classList.toggle('hidden', !finished.length)
      badgeEl.textContent = String(finished.length)
      btnEl.title = finished.length
        ? `${finished.length} report${finished.length === 1 ? '' : 's'} ready - click to open`
        : 'Reports - generated reports and anything still generating'
    }
  }

  const jobRow = (j: ReportJob): string => {
    const pct = j.progress != null ? Math.round(j.progress * 100) : null
    const bar =
      j.status === 'running'
        ? `<div class="h-1.5 mt-1 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
             <div class="h-full rounded-full bg-sky-500 ${pct == null ? 'w-1/3 animate-pulse' : ''}" style="${pct == null ? '' : `width:${pct}%`}"></div>
           </div>`
        : ''
    const tone =
      j.status === 'error'
        ? 'text-red-500'
        : j.status === 'done'
          ? 'text-emerald-600 dark:text-emerald-400'
          : 'text-slate-500 dark:text-slate-400'
    const actions =
      j.status === 'running'
        ? `<button data-cancel="${esc(j.id)}" class="text-[11px] px-1.5 py-0.5 rounded hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-500">Cancel</button>`
        : `${j.path ? `<button data-open="${esc(j.path)}" class="text-[11px] px-1.5 py-0.5 rounded bg-sky-600 hover:bg-sky-500 text-white">Open</button>` : ''}
           <button data-dismiss="${esc(j.id)}" class="text-[11px] px-1.5 py-0.5 rounded hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400" title="Clear from this list">✕</button>`
    return `<div class="px-3 py-2 border-b border-slate-100 dark:border-slate-700/60">
      <div class="flex items-start gap-2">
        <div class="min-w-0 flex-1">
          <div class="text-xs font-medium truncate">${esc(j.name)}</div>
          <div class="text-[11px] text-slate-400">${esc(j.period)}</div>
        </div>
        <div class="flex items-center gap-1 shrink-0">${actions}</div>
      </div>
      <div class="text-[11px] ${tone} mt-0.5">${esc(j.error ?? j.phase)}${pct != null && j.status === 'running' ? ` · ${pct}%` : ''}</div>
      ${bar}
    </div>`
  }

  const savedRow = (r: SavedReportInfo): string =>
    `<div class="px-3 py-2 border-b border-slate-100 dark:border-slate-700/60 flex items-center gap-2 hover:bg-slate-50 dark:hover:bg-slate-700/40">
      <button data-open="${esc(r.path)}" class="min-w-0 flex-1 text-left">
        <div class="text-xs font-medium truncate">${esc(r.title || r.name)}</div>
        <div class="text-[11px] text-slate-400 truncate">${esc(
          [r.live ? 'live snapshot' : r.period, fmtWhen(r.generatedAt), fmtBytes(r.size)]
            .filter(Boolean)
            .join(' · ')
        )}</div>
      </button>
      <button data-reveal="${esc(r.path)}" class="shrink-0 text-[11px] px-1.5 py-0.5 rounded hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400" title="Show in folder">${ICONS.folder}</button>
    </div>`

  const renderPanel = (): void => {
    if (!open) return
    const section = (label: string): string =>
      `<div class="px-3 pt-2 pb-1 text-[10px] font-semibold text-slate-400 uppercase tracking-wide">${esc(label)}</div>`
    const active = running()
    const finished = jobs.filter((j) => j.status !== 'running')
    panelEl.innerHTML = `
      ${active.length ? section('Generating') + active.map(jobRow).join('') : ''}
      ${finished.length ? section('Just finished') + finished.map(jobRow).join('') : ''}
      ${section('Reports folder')}
      ${
        savedLoaded
          ? saved.length
            ? saved.map(savedRow).join('')
            : '<p class="px-3 py-2 text-[11px] text-slate-400">No saved reports yet.</p>'
          : '<p class="px-3 py-2 text-[11px] text-slate-400">Loading…</p>'
      }
      <div class="px-3 py-2 flex justify-between items-center">
        <button data-reveal="" class="text-[11px] text-sky-600 dark:text-sky-400 hover:underline">Open reports folder</button>
        <button id="trayRefresh" class="text-[11px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-200">Refresh</button>
      </div>`

    for (const b of panelEl.querySelectorAll<HTMLElement>('[data-cancel]'))
      b.addEventListener('click', () => void window.api.report.cancel(b.dataset.cancel!))
    for (const b of panelEl.querySelectorAll<HTMLElement>('[data-dismiss]'))
      b.addEventListener('click', () => void window.api.report.dismissJob(b.dataset.dismiss!))
    for (const b of panelEl.querySelectorAll<HTMLElement>('[data-open]'))
      b.addEventListener('click', () => {
        toggle(false)
        void openReportPath(b.dataset.open!, ctx)
      })
    for (const b of panelEl.querySelectorAll<HTMLElement>('[data-reveal]'))
      b.addEventListener('click', () => void window.api.report.reveal(b.dataset.reveal || undefined))
    panelEl.querySelector('#trayRefresh')?.addEventListener('click', () => void loadSaved())
  }

  const loadSaved = async (): Promise<void> => {
    saved = await window.api.report.list()
    savedLoaded = true
    renderPanel()
  }

  const toggle = (next: boolean): void => {
    open = next
    if (open) showPopover(panelEl)
    else hidePopover(panelEl)
    if (open) {
      opts.onOpen?.()
      for (const j of jobs) if (j.status !== 'running') seen.add(j.id)
      renderChip()
      renderPanel()
      void loadSaved()
    }
  }

  btnEl.addEventListener('click', (e) => {
    e.stopPropagation()
    toggle(!open)
  })
  const onDocClick = (e: MouseEvent): void => {
    if (open && !host.contains(e.target as Node)) toggle(false)
  }
  document.addEventListener('click', onDocClick)

  const applyJobs = (next: ReportJob[]): void => {
    const wasRunning = new Set(running().map((j) => j.id))
    jobs = next
    renderChip()
    renderPanel()
    // A job that just landed changes what's in the folder.
    const landed = next.filter((j) => j.status === 'done' && wasRunning.has(j.id))
    if (landed.length) {
      savedLoaded = false
      void loadSaved()
      // The Generate dialog opens the report itself when it's still up; when it
      // isn't, this is the only sign the work finished.
      if (!document.querySelector('#setupBody'))
        flash(`“${landed[0].name}” is ready - open it from the reports icon.`)
    }
    for (const j of next.filter((j) => j.status === 'error' && wasRunning.has(j.id)))
      flash(`Report “${j.name}” failed: ${j.error ?? 'unknown error'}`, true)
  }

  const stop = window.api.report.onJobs(applyJobs)
  void window.api.report.jobs().then((list) => {
    jobs = list
    renderChip()
  })
  renderChip()

  return {
    close: () => toggle(false),
    dispose: () => {
      stop()
      document.removeEventListener('click', onDocClick)
    }
  }
}
