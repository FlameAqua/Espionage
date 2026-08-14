// The Settings modal: one place for link display, appearance, report defaults,
// snapshot location, panel layout and updates. Link options are persisted here so
// they survive a reconnect; everything else delegates back to the app.
//
// Everything applies live — there's no OK/Cancel, and changing a setting never
// closes the dialog, so you can adjust several things in one visit.

import { EDGE_KIND_META, type EdgeKind } from '../graph/model'
import { DEFAULT_EDGE_OPACITY, type ThemeName } from '../graph/view'
import { CALLING_CODES } from '../../../shared/phone'
import { ICONS } from './icons'
import {
  readEdgeRouting,
  readDefaultLayout,
  readMotionPref,
  readQueueLogins,
  writeStraightLinks,
  writeDefaultLayout,
  writeMotionPref,
  writeQueueLogins,
  type DefaultLayout,
  type MotionPref
} from './prefs'

const esc = (s: unknown): string =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )

const KEY = 'espionage.edgeOptions'
const SNAPSHOT_DIR_KEY = 'espionage.snapshotDir'

export interface EdgeOptions {
  /** Link types hidden from the canvas. */
  hiddenKinds: EdgeKind[]
  /** Individual route types hidden (see routeGroupOf) — finer than hiddenKinds,
   *  so e.g. out-of-hours destinations can go without taking every route with
   *  them. Free-form strings, since they come from the system's own labels. */
  hiddenRoutes: string[]
  /** Link opacity, 0–1. Lower keeps links in the background. */
  opacity: number
}

export function defaultEdgeOptions(): EdgeOptions {
  return { hiddenKinds: [], hiddenRoutes: [], opacity: DEFAULT_EDGE_OPACITY }
}

export function loadEdgeOptions(): EdgeOptions {
  const base = defaultEdgeOptions()
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return base
    const saved = JSON.parse(raw) as Partial<EdgeOptions>
    const known = new Set(Object.keys(EDGE_KIND_META))
    return {
      hiddenKinds: (saved.hiddenKinds ?? []).filter((k) => known.has(k)) as EdgeKind[],
      hiddenRoutes: (saved.hiddenRoutes ?? []).filter((r) => typeof r === 'string'),
      opacity:
        typeof saved.opacity === 'number' && saved.opacity >= 0 && saved.opacity <= 1
          ? saved.opacity
          : base.opacity
    }
  } catch {
    return base
  }
}

export function saveEdgeOptions(o: EdgeOptions): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(o))
  } catch {
    /* storage unavailable — non-fatal */
  }
}

/** Folder new snapshots are offered in ('' = let the OS decide). */
export function readSnapshotDir(): string {
  try {
    return localStorage.getItem(SNAPSHOT_DIR_KEY) ?? ''
  } catch {
    return ''
  }
}
export function writeSnapshotDir(dir: string): void {
  try {
    if (dir) localStorage.setItem(SNAPSHOT_DIR_KEY, dir)
    else localStorage.removeItem(SNAPSHOT_DIR_KEY)
  } catch {
    /* storage unavailable — non-fatal */
  }
}

// --- Styling shorthands ------------------------------------------------------

const smallBtn =
  'inline-flex items-center justify-center h-7 px-2.5 rounded-md text-xs leading-none bg-slate-200 hover:bg-slate-300 text-slate-700 dark:bg-slate-700 dark:hover:bg-slate-600 dark:text-slate-100'
const selCls =
  'h-7 px-2 rounded-md bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 text-xs leading-none text-slate-700 dark:text-slate-200'

/** A labelled settings row: name on the left, control on the right.
 *
 *  The explanation is a tooltip rather than a permanent second line. Every row
 *  carrying its own paragraph turned the dialog into a wall of text you had to
 *  read past to reach the control you came for; the dotted underline marks the
 *  ones that have more to say. */
function row(label: string, control: string, hint = ''): string {
  const name = hint
    ? `<span class="cursor-help border-b border-dotted border-slate-300 dark:border-slate-600" title="${esc(hint)}">${esc(label)}</span>`
    : esc(label)
  return `<div class="flex items-center justify-between gap-3 py-2">
    <div class="min-w-0 text-slate-700 dark:text-slate-200">${name}</div>
    <div class="shrink-0 flex items-center gap-1.5">${control}</div>
  </div>`
}

/** A plain on/off box, sized so it lines up with the other controls' right
 *  edge. No text beside it: what it does is the row's own label, and any nuance
 *  is in that label's tooltip. */
function toggle(id: string): string {
  return `<input id="${id}" type="checkbox" class="h-4 w-4 accent-sky-500 cursor-pointer" />`
}

function group(title: string, inner: string): string {
  return `<section>
    <h3 class="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1.5">${esc(title)}</h3>
    <div class="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-900/30 divide-y divide-slate-200/70 dark:divide-slate-700/50 px-3">${inner}</div>
  </section>`
}

/** A segmented control: a few exclusive choices, shown as one pill. Reads faster
 *  than a dropdown for two or three options and takes one click, not two. */
function segmented(id: string, value: string, options: Array<[string, string]>): string {
  return `<div id="${id}" class="inline-flex rounded-md bg-slate-200 dark:bg-slate-700 p-0.5">
    ${options
      .map(
        ([v, label]) =>
          `<button data-seg="${esc(v)}" class="h-6 px-2 rounded text-xs leading-none ${
            v === value
              ? 'bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 shadow-sm'
              : 'text-slate-500 dark:text-slate-300'
          }">${esc(label)}</button>`
      )
      .join('')}
  </div>`
}

/** Wire a segmented control; `onPick` fires with the chosen value. */
function wireSegmented(root: HTMLElement, id: string, onPick: (value: string) => void): void {
  const host = root.querySelector<HTMLElement>(`#${id}`)
  if (!host) return
  for (const b of host.querySelectorAll<HTMLElement>('[data-seg]')) {
    b.addEventListener('click', () => {
      for (const other of host.querySelectorAll<HTMLElement>('[data-seg]')) {
        const on = other === b
        other.classList.toggle('bg-white', on)
        other.classList.toggle('dark:bg-slate-900', on)
        other.classList.toggle('text-slate-800', on)
        other.classList.toggle('dark:text-slate-100', on)
        other.classList.toggle('shadow-sm', on)
        other.classList.toggle('text-slate-500', !on)
        other.classList.toggle('dark:text-slate-300', !on)
      }
      onPick(b.dataset.seg!)
    })
  }
}

interface SettingsCallbacks {
  theme: ThemeName
  edgeOptions: EdgeOptions
  /** Every route type present on the current graph, with how many links carry it
   *  — the checklist for hiding routes individually. */
  routeGroups: Array<{ group: string; count: number }>
  /** Live-applied whenever the user changes a link option. */
  onEdgeOptions: (o: EdgeOptions) => void
  onToggleTheme: () => void
  onOpenZones: () => void
  onCheckUpdates: () => void
  /** Links hidden one-by-one (not by type) — restorable from here too. */
  individuallyHiddenEdges: number
  onRestoreHiddenEdges: () => void
  /** Panel/minimap sizing. */
  onRestoreLayout: () => void
  onSaveLayoutDefault: () => void
  /** Link routing on/off — applied to all three views at once. */
  onEdgeRouting: (on: boolean) => void
  /** Report default home country (ISO2). */
  homeCountry: string
  onHomeCountry: (iso2: string) => void
}

/** Open the Settings modal. */
export function showSettings(cb: SettingsCallbacks): void {
  const opts: EdgeOptions = {
    hiddenKinds: [...cb.edgeOptions.hiddenKinds],
    hiddenRoutes: [...cb.edgeOptions.hiddenRoutes],
    opacity: cb.edgeOptions.opacity
  }
  let theme = cb.theme

  const countryOpts = [
    `<option value=""${cb.homeCountry ? '' : ' selected'}>None</option>`,
    ...CALLING_CODES.map(
      (c) =>
        `<option value="${esc(c.iso2)}"${c.iso2 === cb.homeCountry ? ' selected' : ''}>${esc(c.country)} (+${esc(c.code)})</option>`
    )
  ].join('')

  const linkTypes = (
    Object.entries(EDGE_KIND_META) as Array<[EdgeKind, { label: string; color: string }]>
  )
    .map(
      ([kind, meta]) => `<label class="flex items-center gap-2 text-xs cursor-pointer select-none py-0.5">
        <input type="checkbox" data-kind="${kind}" ${opts.hiddenKinds.includes(kind) ? '' : 'checked'} class="accent-sky-500" />
        <span class="w-4 h-0.5 rounded shrink-0" style="background:${meta.color}"></span>
        <span class="truncate">${esc(meta.label)}</span>
      </label>`
    )
    .join('')

  // Route types are the finer cut: a link's KIND says "this is a route", a route
  // type says which branch it is (out of hours, timeout, key press…). Hidden ones
  // are always listed even if nothing on the current graph carries them, so a
  // route hidden earlier can still be found and switched back on.
  const routeRows = [
    ...cb.routeGroups,
    ...opts.hiddenRoutes
      .filter((r) => !cb.routeGroups.some((g) => g.group === r))
      .map((group) => ({ group, count: 0 }))
  ]
    .sort((a, b) => a.group.localeCompare(b.group))
    .map(
      ({ group, count }) => `<label class="flex items-center gap-2 text-xs cursor-pointer select-none py-0.5">
        <input type="checkbox" data-route="${esc(group)}" ${opts.hiddenRoutes.includes(group) ? '' : 'checked'} class="accent-sky-500" />
        <span class="flex-1 truncate" title="${esc(group)}">${esc(group)}</span>
        <span class="text-slate-400 tabular-nums shrink-0">${count}</span>
      </label>`
    )
    .join('')

  const overlay = document.createElement('div')
  overlay.className = 'fixed inset-0 z-[110] flex items-center justify-center bg-black/40 p-4'
  overlay.innerHTML = `
    <div class="w-[620px] max-w-full max-h-[88vh] flex flex-col bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-lg shadow-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
      <div class="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-700 shrink-0">
        <h2 class="font-semibold text-slate-800 dark:text-slate-100">Settings</h2>
        <button data-close class="text-slate-400 hover:text-slate-700 dark:hover:text-slate-100 text-lg leading-none">✕</button>
      </div>
      <div class="esp-scroll overflow-y-auto p-4 space-y-4 text-sm">

        ${group(
          'Links',
          row(
            'Link opacity',
            `<input id="stOpacity" type="range" min="0" max="100" step="5" class="w-40 accent-sky-500" />
             <span id="stOpacityVal" class="w-9 text-right text-xs text-slate-400 tabular-nums"></span>`,
            'Lower keeps links in the background so nodes stand out.'
          ) +
            `<div class="py-2">
              <div class="text-slate-700 dark:text-slate-200 mb-1.5">Visible link types</div>
              <div class="grid grid-cols-2 gap-x-4">${linkTypes}</div>
              <div id="stEdgeRestoreWrap" class="mt-2 ${cb.individuallyHiddenEdges ? '' : 'hidden'}">
                <button id="stEdgeRestore" class="${smallBtn}">Restore ${cb.individuallyHiddenEdges} individually hidden link${cb.individuallyHiddenEdges === 1 ? '' : 's'}</button>
              </div>
            </div>` +
            (routeRows
              ? `<details class="py-2" ${opts.hiddenRoutes.length ? 'open' : ''}>
              <summary class="cursor-pointer text-slate-700 dark:text-slate-200 select-none">Visible routes <span class="text-[11px] text-slate-400">— hide one branch without hiding its whole link type</span></summary>
              <div class="mt-1 max-h-48 overflow-y-auto pr-1 grid grid-cols-2 gap-x-4">${routeRows}</div>
            </details>`
              : '')
        )}

        ${group(
          'Appearance',
          row(
            'Colour mode',
            `<button id="stTheme" class="${smallBtn}"></button>`,
            'Applies to the whole window.'
          ) +
            row(
              'Interface animation',
              segmented('stMotion', readMotionPref(), [
                ['system', 'System'],
                ['on', 'On'],
                ['off', 'Off']
              ]),
              'Menus, panels and dialogs slide and fade. System follows your operating system’s reduce-motion setting.'
            ) +
            row(
              'Panels and minimap',
              `<button id="stLayoutSave" class="${smallBtn}">Save current</button>
               <button id="stLayoutRestore" class="${smallBtn}">Restore</button>`,
              'Drag the inner edge of a side panel, or the minimap corner, to resize. Save keeps the current sizes as your default.'
            )
        )}

        ${group(
          'Graph',
          row(
            'Open in view mode',
            `<select id="stDefaultLayout" class="${selCls} max-w-[160px]">
               <option value="last">Last used</option>
               <option value="flow">Flow</option>
               <option value="department">Department</option>
               <option value="compact">Compact</option>
             </select>`,
            'Which arrangement the graph starts in when you connect.'
          ) +
            row(
              'Read per-queue logins',
              toggle('stQueueLogins'),
              'Shows which agents are logged in to each queue individually. It has to be read from the web client, which makes connecting noticeably slower. Takes effect on the next connect or hard refresh.'
            ) +
            row(
              'Straight links',
              toggle('stStraightLinks'),
              'Normally a link leaves the side of its node facing the destination, turns once in the gap between them, and comes back in horizontally, taking a turn that clears the nodes in the way. Tick this to draw every link as a direct line instead, as older versions did.'
            )
        )}

        ${group(
          'Reports',
          row(
            'Default home country',
            `<select id="stHome" class="${selCls} max-w-[220px]">${countryOpts}</select>`,
            'Baseline for national vs international.'
          ) +
            row(
              'Call zones',
              `<button id="stZones" class="${smallBtn}">Configure…</button>`,
              'Group destinations into tariff bands.'
            )
        )}

        ${group(
          'Files',
          row(
            'Default snapshot folder',
            `<button id="stSnapDir" class="${smallBtn}">Choose…</button>
             <button id="stSnapClear" class="${smallBtn}">Reset</button>`,
            'Where “Save snapshot” opens.'
          ) +
            `<div class="py-1.5 flex items-start gap-2">
              <span id="stSnapDirTag" class="shrink-0 px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-300"></span>
              <span class="text-[11px] text-slate-400 font-mono break-all" id="stSnapDirPath"></span>
            </div>`
        )}

        ${group(
          'Updates',
          row(
            'Application updates',
            `<button id="stUpdates" class="${smallBtn}">Check now</button>`,
            'Downloads in the background when one is available.'
          )
        )}

      </div>
    </div>`
  document.body.appendChild(overlay)
  const close = (): void => overlay.remove()
  overlay
    .querySelectorAll<HTMLElement>('[data-close]')
    .forEach((b) => b.addEventListener('click', close))

  const apply = (): void => {
    saveEdgeOptions(opts)
    cb.onEdgeOptions(opts)
  }

  // --- Link opacity ---
  const opacityEl = overlay.querySelector<HTMLInputElement>('#stOpacity')!
  const opacityValEl = overlay.querySelector<HTMLElement>('#stOpacityVal')!
  const showOpacity = (): void => {
    opacityValEl.textContent = `${Math.round(opts.opacity * 100)}%`
  }
  opacityEl.value = String(Math.round(opts.opacity * 100))
  showOpacity()
  opacityEl.addEventListener('input', () => {
    opts.opacity = Number(opacityEl.value) / 100
    showOpacity()
    apply()
  })

  // --- Link types ---
  const hidden = new Set<string>(opts.hiddenKinds)
  for (const box of overlay.querySelectorAll<HTMLInputElement>('[data-kind]')) {
    box.addEventListener('change', () => {
      const kind = box.dataset.kind as EdgeKind
      if (box.checked) hidden.delete(kind)
      else hidden.add(kind)
      opts.hiddenKinds = [...hidden] as EdgeKind[]
      apply()
    })
  }
  // --- Route types ---
  const hiddenRoutes = new Set<string>(opts.hiddenRoutes)
  for (const box of overlay.querySelectorAll<HTMLInputElement>('[data-route]')) {
    box.addEventListener('change', () => {
      const group = box.dataset.route!
      if (box.checked) hiddenRoutes.delete(group)
      else hiddenRoutes.add(group)
      opts.hiddenRoutes = [...hiddenRoutes]
      apply()
    })
  }

  overlay.querySelector('#stEdgeRestore')?.addEventListener('click', () => {
    cb.onRestoreHiddenEdges()
    overlay.querySelector('#stEdgeRestoreWrap')?.classList.add('hidden')
  })

  // --- Appearance: toggling the theme keeps the dialog open ---
  const themeBtn = overlay.querySelector<HTMLButtonElement>('#stTheme')!
  const showTheme = (): void => {
    themeBtn.innerHTML =
      theme === 'dark'
        ? `${ICONS.sun}<span class="ml-1.5">Light mode</span>`
        : `${ICONS.moon}<span class="ml-1.5">Dark mode</span>`
  }
  showTheme()
  themeBtn.addEventListener('click', () => {
    cb.onToggleTheme()
    theme = theme === 'dark' ? 'light' : 'dark'
    showTheme()
  })

  wireSegmented(overlay, 'stMotion', (v) => writeMotionPref(v as MotionPref))

  // --- Graph defaults ---
  const defLayoutEl = overlay.querySelector<HTMLSelectElement>('#stDefaultLayout')!
  defLayoutEl.value = readDefaultLayout()
  defLayoutEl.addEventListener('change', () =>
    writeDefaultLayout(defLayoutEl.value as DefaultLayout)
  )
  const queueLoginsEl = overlay.querySelector<HTMLInputElement>('#stQueueLogins')!
  queueLoginsEl.checked = readQueueLogins()
  queueLoginsEl.addEventListener('change', () => writeQueueLogins(queueLoginsEl.checked))
  const straightEl = overlay.querySelector<HTMLInputElement>('#stStraightLinks')!
  straightEl.checked = !readEdgeRouting()
  straightEl.addEventListener('change', () => {
    writeStraightLinks(straightEl.checked)
    cb.onEdgeRouting(!straightEl.checked)
  })

  overlay.querySelector('#stLayoutSave')!.addEventListener('click', cb.onSaveLayoutDefault)
  overlay.querySelector('#stLayoutRestore')!.addEventListener('click', cb.onRestoreLayout)

  // --- Reports ---
  const homeEl = overlay.querySelector<HTMLSelectElement>('#stHome')!
  homeEl.addEventListener('change', () => cb.onHomeCountry(homeEl.value))
  overlay.querySelector('#stZones')!.addEventListener('click', () => cb.onOpenZones())

  // --- Snapshot folder ---
  // Always show the folder that will actually be used. "Not set — system
  // default" told the user nothing: there's no way to know from that where a
  // snapshot is about to land, so the built-in fallback path is resolved from
  // the main process and shown too, just tagged as the default.
  const snapPathEl = overlay.querySelector<HTMLElement>('#stSnapDirPath')!
  const snapTagEl = overlay.querySelector<HTMLElement>('#stSnapDirTag')!
  let builtInSnapDir = ''
  const showSnapDir = (): void => {
    const dir = readSnapshotDir()
    snapTagEl.textContent = dir ? 'Chosen' : 'Default'
    snapPathEl.textContent = dir || builtInSnapDir || 'Resolving…'
  }
  showSnapDir()
  void window.api.app.defaultSnapshotDir().then((dir) => {
    builtInSnapDir = dir
    showSnapDir()
  })
  overlay.querySelector('#stSnapDir')!.addEventListener('click', async () => {
    const res = await window.api.app.chooseFolder('Default snapshot folder')
    if (res?.path) {
      writeSnapshotDir(res.path)
      showSnapDir()
    }
  })
  overlay.querySelector('#stSnapClear')!.addEventListener('click', () => {
    writeSnapshotDir('')
    showSnapDir()
  })

  overlay.querySelector('#stUpdates')!.addEventListener('click', () => cb.onCheckUpdates())
}
