// The "Generate report" dialog: what period, what it's called, and what it
// covers — then a live progress view while the main process fetches.
//
// Generation itself runs as a background job (see main/reports.ts), so this
// dialog can be dismissed at any point without losing the work; the reports tray
// keeps showing progress and the finished report lands in the reports folder
// either way.

import type { CallDirection } from '../../../shared/phone'
import type { ReportJob, ReportRequest } from '../../../shared/types'
import {
  btn,
  countrySelect,
  esc,
  flash,
  openOverlay,
  openReportPath,
  readHomeCountry,
  selCls,
  writeHomeCountry
} from './report'
import {
  buildDirectory,
  TARGET_KIND_META,
  type ReportContext,
  type ReportTarget
} from './report-context'

const SETUP_KEY = 'espionage.reportSetup'
const ALL_DIRECTIONS: CallDirection[] = ['inbound', 'outbound', 'internal']

/** The dialog's remembered choices — everything bar the period dates and the
 *  report name, which are report-specific. */
interface SavedSetup {
  days: number
  directions: CallDirection[]
  dns: string[]
}

function loadSetup(): SavedSetup {
  const base: SavedSetup = { days: 30, directions: [...ALL_DIRECTIONS], dns: [] }
  try {
    const raw = localStorage.getItem(SETUP_KEY)
    if (!raw) return base
    const s = JSON.parse(raw) as Partial<SavedSetup>
    return {
      days: Number.isFinite(s.days) ? Number(s.days) : base.days,
      directions: Array.isArray(s.directions) && s.directions.length ? s.directions : base.directions,
      dns: Array.isArray(s.dns) ? s.dns.map(String) : []
    }
  } catch {
    return base
  }
}

function saveSetup(s: SavedSetup): void {
  try {
    localStorage.setItem(SETUP_KEY, JSON.stringify(s))
  } catch {
    /* storage unavailable — non-fatal */
  }
}

// --- Date helpers ------------------------------------------------------------

const dateValue = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Inclusive bounds in the user's own time zone: "From" is that day's first
 *  instant, "To" is that day's last. */
function dayStart(value: string): string {
  const [y, m, d] = value.split('-').map(Number)
  return new Date(y, m - 1, d, 0, 0, 0, 0).toISOString()
}
function dayEnd(value: string): string {
  const [y, m, d] = value.split('-').map(Number)
  return new Date(y, m - 1, d, 23, 59, 59, 999).toISOString()
}
function dayCount(from: string, to: string): number {
  const a = new Date(dayStart(from)).getTime()
  const b = new Date(dayStart(to)).getTime()
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0
  return Math.round((b - a) / 86400000) + 1
}

// --- Scope selection ---------------------------------------------------------

/** Departments present in the targets, each with the DNs it covers. */
function departmentsOf(targets: ReportTarget[]): Array<{ name: string; dns: string[] }> {
  const map = new Map<string, string[]>()
  for (const t of targets) {
    // Every department it belongs to, not just its primary one — otherwise
    // picking a department silently left out the extensions it shares.
    for (const d of t.departments?.length ? t.departments : t.department ? [t.department] : []) {
      const list = map.get(d)
      if (list) list.push(t.number)
      else map.set(d, [t.number])
    }
  }
  return [...map.entries()]
    .map(([name, dns]) => ({ name, dns }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Describe a selection the way a report header should read it: whole
 *  departments by name, anything else by number, and a count either way. */
function scopeLabel(selected: Set<string>, targets: ReportTarget[]): string {
  if (!selected.size) return ''
  const byNumber = new Map(targets.map((t) => [t.number, t]))
  const covered = new Set<string>()
  const names: string[] = []
  for (const dept of departmentsOf(targets)) {
    if (dept.dns.length && dept.dns.every((n) => selected.has(n))) {
      names.push(dept.name)
      for (const n of dept.dns) covered.add(n)
    }
  }
  const rest = [...selected].filter((n) => !covered.has(n))
  for (const n of rest.slice(0, 4)) {
    const t = byNumber.get(n)
    names.push(t ? `${n} ${t.label}`.trim() : n)
  }
  const more = rest.length > 4 ? ` +${rest.length - 4} more` : ''
  return `${selected.size} of ${targets.length} selected - ${names.join(', ')}${more}`
}

// --- Dialog ------------------------------------------------------------------

/** Period + scope picker → start a background report job, then follow it. */
export function showReportSetup(ctx: ReportContext): void {
  const saved = loadSetup()
  const targets = ctx.targets
  const depts = departmentsOf(targets)
  const selected = new Set(saved.dns.filter((n) => targets.some((t) => t.number === n)))
  const directions = new Set<CallDirection>(saved.directions)
  let scopeMode: 'all' | 'pick' = selected.size ? 'pick' : 'all'
  // True until the user edits the name themselves, at which point we stop
  // rewriting it under them.
  let nameIsAuto = true
  let search = ''

  // Dismissing the dialog only stops us *watching* the job — see showProgress.
  let unwatch: (() => void) | null = null
  const { overlay, close } = openOverlay(
    `
    <div class="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-700 shrink-0">
      <div>
        <h2 class="font-semibold text-slate-800 dark:text-slate-100">Generate report</h2>
        <p class="text-[11px] text-slate-400">Fetched from 3CX and saved to your reports folder.</p>
      </div>
      <button data-close class="text-slate-400 hover:text-slate-700 dark:hover:text-slate-100 text-lg leading-none">✕</button>
    </div>
    <div id="setupBody" class="esp-scroll overflow-y-auto p-4 space-y-4 text-sm"></div>`,
    'w-[560px]',
    {
      onClose: () => {
        unwatch?.()
        unwatch = null
      }
    }
  )
  overlay
    .querySelectorAll<HTMLElement>('[data-close]')
    .forEach((b) => b.addEventListener('click', close))

  const bodyEl = overlay.querySelector<HTMLElement>('#setupBody')!

  // --- Form state kept in the live inputs; these two are read on Generate.
  const today = dateValue(new Date())
  let fromValue = ''
  let toValue = ''
  // Which preset produced the current dates, so the button that's actually in
  // force is the one lit. Cleared the moment either date is edited by hand —
  // a custom range that happens to be 30 days long is not "Last 30 days".
  let activePreset: string | null = null
  const setRange = (days: number): void => {
    const to = new Date()
    const from = new Date()
    // "Last 7 days" means today and the six before it — 7 days of data, not 8.
    from.setDate(from.getDate() - (days - 1))
    fromValue = dateValue(from)
    toValue = dateValue(to)
    activePreset = `d${days}`
  }
  setRange(saved.days)

  const autoName = (): string => {
    const scope = scopeMode === 'pick' && selected.size ? ` - ${selected.size} selected` : ''
    return `Report ${fromValue} to ${toValue}${scope}`
  }
  // The last auto-name we produced. Typing a prefix like "50555 " froze the
  // whole name, so changing the period afterwards left a title claiming the old
  // dates — the report header then disagreed with its own period.
  let lastAuto = autoName()

  // Written out in full rather than layered on the base class: two competing
  // `bg-*` utilities resolve by stylesheet order, not append order.
  const chosenBtn =
    'px-3 py-1.5 rounded text-sm font-semibold bg-sky-600 hover:bg-sky-500 text-white ring-2 ring-sky-300 dark:ring-sky-500'
  const chosenChip =
    'px-2 py-1 rounded text-xs font-semibold bg-sky-600 hover:bg-sky-500 text-white border border-sky-600'
  /** Departments every member of which is selected. */
  const chosenDepartments = (): string[] =>
    depts.filter((d) => d.dns.length && d.dns.every((n) => selected.has(n))).map((d) => d.name)
  const isExternalOnly = (): boolean =>
    directions.has('inbound') && directions.has('outbound') && !directions.has('internal')

  const renderForm = (): void => {
    const days = dayCount(fromValue, toValue)
    const nameEl = bodyEl.querySelector<HTMLInputElement>('#repName')
    const fresh = autoName()
    // An edited name keeps the user's own words but follows the period: the
    // generated part of it is swapped for the current one.
    const nameValue = nameEl && !nameIsAuto ? nameEl.value.replace(lastAuto, fresh) : fresh
    lastAuto = fresh
    bodyEl.innerHTML = `
      <div>
        <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Report name</label>
        <input id="repName" type="text" value="${esc(nameValue)}" placeholder="${esc(autoName())}"
          class="w-full px-2 py-1.5 rounded bg-slate-100 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-sm" />
        <p class="text-[10px] text-slate-400 mt-1">Title and file name.</p>
      </div>

      <div>
        <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Period</label>
        <div class="flex flex-wrap gap-1.5" id="periodPresets">
          ${[7, 14, 30, 90]
            .map(
              (d) =>
                `<button data-days="${d}" class="${activePreset === `d${d}` ? chosenBtn : btn}">Last ${d} days</button>`
            )
            .join('')}
          <button data-month="last" class="${activePreset === 'lastMonth' ? chosenBtn : btn}">Last month</button>
        </div>
        <div class="grid grid-cols-2 gap-3 mt-2">
          <div>
            <label class="block text-xs text-slate-500 mb-1">From</label>
            <input id="fromDate" type="date" value="${esc(fromValue)}" max="${esc(toValue || today)}"
              class="w-full px-2 py-1.5 rounded bg-slate-100 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-sm" />
          </div>
          <div>
            <label class="block text-xs text-slate-500 mb-1">To</label>
            <input id="toDate" type="date" value="${esc(toValue)}" min="${esc(fromValue)}" max="${esc(today)}"
              class="w-full px-2 py-1.5 rounded bg-slate-100 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-sm" />
          </div>
        </div>
        <p class="text-[10px] text-slate-400 mt-1">
          Both dates are included in full — ${days ? `${days} day${days === 1 ? '' : 's'}` : 'no days'} of calls, from 00:00 on the first to 23:59 on the last, in your own time zone.
        </p>
      </div>

      <div>
        <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Include calls</label>
        <div class="flex flex-wrap items-center gap-3">
          ${(['inbound', 'outbound', 'internal'] as CallDirection[])
            .map(
              (d) => `<label class="flex items-center gap-1.5 text-xs cursor-pointer select-none">
                <input type="checkbox" data-dir="${d}" class="accent-sky-500" ${directions.has(d) ? 'checked' : ''} />
                ${d.charAt(0).toUpperCase() + d.slice(1)}
              </label>`
            )
            .join('')}
          <button data-preset-dir="external" class="${isExternalOnly() ? chosenChip : selCls}" title="Inbound and outbound only - every call that entered or left the system">External only</button>
          <button data-preset-dir="all" class="${directions.size === 3 ? chosenChip : selCls}">All</button>
        </div>
      </div>

      <div>
        <label class="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Covers</label>
        <div class="flex gap-1.5 mb-2">
          <button data-scope="all" class="${scopeMode === 'all' ? chosenBtn : btn}">Whole system</button>
          <button data-scope="pick" class="${scopeMode === 'pick' ? chosenBtn : btn}">Choose extensions, queues…</button>
        </div>
        ${scopeMode === 'pick' ? scopePicker() : '<p class="text-[10px] text-slate-400">Every extension, queue and trunk on the system.</p>'}
      </div>

      <div>
        <label class="block text-xs text-slate-500 mb-1">Home country
          <span class="text-slate-400 normal-case">— baseline for national vs international</span>
        </label>
        ${countrySelect('setupHome', readHomeCountry(), true)}
      </div>

      <div class="flex justify-end gap-2 pt-1">
        <button data-close class="${btn} bg-slate-500 hover:bg-slate-400">Cancel</button>
        <button id="genBtn" class="${btn} bg-emerald-600 hover:bg-emerald-500">Generate</button>
      </div>`
    wireForm()
  }

  const scopePicker = (): string => {
    if (!targets.length)
      return `<p class="text-[10px] text-amber-600 dark:text-amber-400">No extensions or queues were found on this system, so the report can only cover everything.</p>`
    const q = search.trim().toLowerCase()
    const matches = (t: ReportTarget): boolean =>
      !q ||
      t.number.toLowerCase().includes(q) ||
      t.label.toLowerCase().includes(q) ||
      (t.department ?? '').toLowerCase().includes(q)
    const shown = targets.filter(matches)
    const deptRow = (d: { name: string; dns: string[] }): string => {
      const on = d.dns.every((n) => selected.has(n))
      const some = !on && d.dns.some((n) => selected.has(n))
      return `<button data-dept="${esc(d.name)}" class="px-2 py-0.5 rounded-full text-[11px] border ${
        on
          ? 'bg-sky-600 border-sky-600 text-white'
          : some
            ? 'bg-sky-100 border-sky-300 text-sky-800 dark:bg-sky-900/40 dark:border-sky-700 dark:text-sky-200'
            : 'border-slate-300 dark:border-slate-600 text-slate-500 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'
      }">${esc(d.name)} <span class="opacity-60">${d.dns.length}</span></button>`
    }
    const groups = TARGET_KIND_META.map(({ kind, label }) => {
      const rows = shown.filter((t) => t.kind === kind)
      if (!rows.length) return ''
      return `<div class="pt-1">
        <div class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide px-1 py-0.5">${esc(label)}</div>
        ${rows
          .map(
            (t) => `<label class="flex items-center gap-2 px-1 py-0.5 rounded hover:bg-slate-100 dark:hover:bg-slate-700/50 cursor-pointer">
              <input type="checkbox" data-dn="${esc(t.number)}" class="accent-sky-500" ${selected.has(t.number) ? 'checked' : ''} />
              <span class="font-mono text-[11px] text-slate-500 w-14 shrink-0">${esc(t.number)}</span>
              <span class="flex-1 truncate text-xs">${esc(t.label)}</span>
              ${t.department ? `<span class="text-[10px] text-slate-400 truncate max-w-[7rem]">${esc(t.department)}</span>` : ''}
            </label>`
          )
          .join('')}
      </div>`
    }).join('')
    return `
      ${depts.length ? `<div class="flex flex-wrap gap-1 mb-2">${depts.map(deptRow).join('')}</div>` : ''}
      <div class="flex items-center gap-2 mb-1">
        <input id="scopeSearch" type="text" value="${esc(search)}" placeholder="Find a number, name or department…"
          class="flex-1 px-2 py-1 rounded bg-slate-100 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-xs" />
        <button data-select="shown" class="${selCls}">Select shown</button>
        <button data-select="none" class="${selCls}">Clear</button>
      </div>
      <div id="scopeList" class="max-h-56 overflow-y-auto rounded border border-slate-200 dark:border-slate-700 p-1">
        ${groups || '<p class="text-[10px] text-slate-400 p-2">Nothing matches that search.</p>'}
      </div>
      <p class="text-[10px] ${selected.size ? 'text-slate-500' : 'text-amber-600 dark:text-amber-400'} mt-1">
        ${selected.size ? esc(scopeLabel(selected, targets)) : 'Nothing selected yet - the report would cover the whole system.'}
      </p>
`
  }

  const wireForm = (): void => {
    for (const b of bodyEl.querySelectorAll<HTMLElement>('[data-close]'))
      b.addEventListener('click', close)

    const nameEl = bodyEl.querySelector<HTMLInputElement>('#repName')!
    nameEl.addEventListener('input', () => {
      nameIsAuto = !nameEl.value.trim()
    })

    const fromEl = bodyEl.querySelector<HTMLInputElement>('#fromDate')!
    const toEl = bodyEl.querySelector<HTMLInputElement>('#toDate')!
    fromEl.addEventListener('change', () => {
      fromValue = fromEl.value
      if (toValue && fromValue > toValue) toValue = fromValue
      activePreset = null
      renderForm()
    })
    toEl.addEventListener('change', () => {
      toValue = toEl.value
      if (fromValue && toValue < fromValue) fromValue = toValue
      activePreset = null
      renderForm()
    })
    for (const b of bodyEl.querySelectorAll<HTMLElement>('#periodPresets [data-days]'))
      b.addEventListener('click', () => {
        setRange(Number(b.dataset.days))
        renderForm()
      })
    const lastMonth = bodyEl.querySelector<HTMLElement>('[data-month="last"]')
    lastMonth?.addEventListener('click', () => {
      const now = new Date()
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const last = new Date(now.getFullYear(), now.getMonth(), 0)
      fromValue = dateValue(first)
      toValue = dateValue(last)
      activePreset = 'lastMonth'
      renderForm()
    })

    for (const el of bodyEl.querySelectorAll<HTMLInputElement>('[data-dir]'))
      el.addEventListener('change', () => {
        const d = el.dataset.dir as CallDirection
        if (el.checked) directions.add(d)
        else directions.delete(d)
        // Never let the user arrive at "no directions", which would report nothing.
        if (!directions.size) {
          directions.add(d)
          el.checked = true
        }
        renderForm()
      })

    for (const b of bodyEl.querySelectorAll<HTMLElement>('[data-preset-dir]'))
      b.addEventListener('click', () => {
        directions.clear()
        directions.add('inbound')
        directions.add('outbound')
        if (b.dataset.presetDir === 'all') directions.add('internal')
        renderForm()
      })

    for (const b of bodyEl.querySelectorAll<HTMLElement>('[data-scope]'))
      b.addEventListener('click', () => {
        scopeMode = b.dataset.scope as 'all' | 'pick'
        renderForm()
      })

    const searchEl = bodyEl.querySelector<HTMLInputElement>('#scopeSearch')
    searchEl?.addEventListener('input', () => {
      search = searchEl.value
      renderForm()
      // Re-rendering steals focus back from the box the user is typing in.
      const next = bodyEl.querySelector<HTMLInputElement>('#scopeSearch')
      next?.focus()
      next?.setSelectionRange(next.value.length, next.value.length)
    })

    for (const el of bodyEl.querySelectorAll<HTMLInputElement>('[data-dn]'))
      el.addEventListener('change', () => {
        if (el.checked) selected.add(el.dataset.dn!)
        else selected.delete(el.dataset.dn!)
        renderForm()
      })

    for (const b of bodyEl.querySelectorAll<HTMLElement>('[data-dept]'))
      b.addEventListener('click', () => {
        const dept = depts.find((d) => d.name === b.dataset.dept)
        if (!dept) return
        const on = dept.dns.every((n) => selected.has(n))
        for (const n of dept.dns) {
          if (on) selected.delete(n)
          else selected.add(n)
        }
        renderForm()
      })

    for (const b of bodyEl.querySelectorAll<HTMLElement>('[data-select]'))
      b.addEventListener('click', () => {
        if (b.dataset.select === 'none') selected.clear()
        else {
          const q = search.trim().toLowerCase()
          for (const t of targets)
            if (
              !q ||
              t.number.toLowerCase().includes(q) ||
              t.label.toLowerCase().includes(q) ||
              (t.department ?? '').toLowerCase().includes(q)
            )
              selected.add(t.number)
        }
        renderForm()
      })

    const homeSel = bodyEl.querySelector<HTMLSelectElement>('#setupHome')!
    homeSel.addEventListener('change', () => writeHomeCountry(homeSel.value))

    bodyEl.querySelector('#genBtn')!.addEventListener('click', () => void generate())
  }

  const generate = async (): Promise<void> => {
    if (!fromValue || !toValue) {
      flash('Pick a from and to date.', true)
      return
    }
    if (fromValue > toValue) {
      flash('“To” can’t be earlier than “From”.', true)
      return
    }
    const nameEl = bodyEl.querySelector<HTMLInputElement>('#repName')!
    const homeSel = bodyEl.querySelector<HTMLSelectElement>('#setupHome')!
    const dns = scopeMode === 'pick' ? [...selected] : []
    saveSetup({ days: dayCount(fromValue, toValue), directions: [...directions], dns })

    const req: ReportRequest = {
      from: dayStart(fromValue),
      to: dayEnd(toValue),
      name: nameEl.value.trim() || autoName(),
      homeCountry: homeSel.value,
      // Recorded with the report so it still names its own extensions when it's
      // opened against a different phone system later.
      directory: buildDirectory(ctx),
      scope: {
        dns,
        label: dns.length ? scopeLabel(selected, targets) : undefined,
        directions: directions.size === 3 ? undefined : [...directions],
        // Whole departments are recorded by name so the report can open filtered
        // to what it was generated for.
        departments: dns.length ? chosenDepartments() : undefined
      }
    }
    const res = await window.api.report.start(req)
    if (res.error || !res.job) {
      flash(res.error ?? 'Could not start the report.', true)
      return
    }
    showProgress(res.job)
  }

  /** Swap the form for a live progress view. Closing it leaves the job running. */
  const showProgress = (job: ReportJob): void => {
    let latest = job
    const render = (): void => {
      const pct = latest.progress != null ? Math.round(latest.progress * 100) : null
      const done = latest.status !== 'running'
      bodyEl.innerHTML = `
        <div class="py-2">
          <p class="font-medium text-slate-700 dark:text-slate-200 truncate">${esc(latest.name)}</p>
          <p class="text-xs text-slate-400">${esc(latest.period)}</p>
        </div>
        <div class="h-2 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
          <div class="h-full rounded-full ${latest.status === 'error' ? 'bg-red-500' : 'bg-sky-500'} ${pct == null && !done ? 'animate-pulse w-1/3' : ''}"
            style="${pct == null && !done ? '' : `width:${done ? 100 : pct}%`};transition:width .2s"></div>
        </div>
        <p class="text-xs ${latest.status === 'error' ? 'text-red-500' : 'text-slate-500 dark:text-slate-400'}">
          ${esc(latest.error ?? latest.phase)}${pct != null && !done ? ` · ${pct}%` : ''}
        </p>
        <p class="text-[11px] text-slate-400">You can close this window — it keeps generating.</p>
        <div class="flex justify-end gap-2 pt-1">
          ${
            latest.status === 'running'
              ? `<button id="cancelJob" class="${btn} bg-slate-500 hover:bg-slate-400">Cancel generation</button>
                 <button data-close class="${btn}">Close</button>`
              : `<button data-close class="${btn}">Close</button>`
          }
        </div>`
      for (const b of bodyEl.querySelectorAll<HTMLElement>('[data-close]'))
        b.addEventListener('click', close)
      bodyEl.querySelector('#cancelJob')?.addEventListener('click', () => {
        void window.api.report.cancel(latest.id)
      })
    }

    // Watching stops when the dialog closes (see onClose above); the job itself
    // carries on either way, which is the whole point of running it in main.
    unwatch = window.api.report.onJobs((jobs) => {
      const mine = jobs.find((j) => j.id === latest.id)
      if (!mine) return
      latest = mine
      if (mine.status === 'done' && mine.path) {
        close()
        void openReportPath(mine.path, ctx)
        return
      }
      if (mine.status === 'canceled') {
        close()
        flash('Report generation canceled.')
        return
      }
      render()
    })
    render()
  }

  renderForm()
}
