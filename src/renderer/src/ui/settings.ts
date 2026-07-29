// The Settings modal: one place for link display, appearance, report defaults,
// snapshot location, panel layout and updates. Link options are persisted here so
// they survive a reconnect; everything else delegates back to the app.
//
// Everything applies live — there's no OK/Cancel, and changing a setting never
// closes the dialog, so you can adjust several things in one visit.

import { EDGE_KIND_META, type EdgeKind } from '../graph/model'
import { DEFAULT_EDGE_OPACITY, type ThemeName } from '../graph/view'
import { CALLING_CODES } from '../../../shared/phone'

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
  /** Link opacity, 0–1. Lower keeps links in the background. */
  opacity: number
}

export function defaultEdgeOptions(): EdgeOptions {
  return { hiddenKinds: [], opacity: DEFAULT_EDGE_OPACITY }
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
  'px-2 py-1 rounded text-xs bg-slate-200 hover:bg-slate-300 text-slate-700 dark:bg-slate-700 dark:hover:bg-slate-600 dark:text-slate-100'
const selCls =
  'px-2 py-1 rounded bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 text-xs text-slate-700 dark:text-slate-200'

/** A labelled settings row: description on the left, control on the right. */
function row(label: string, control: string, hint = ''): string {
  return `<div class="flex items-center justify-between gap-3 py-1.5">
    <div class="min-w-0">
      <div class="text-slate-700 dark:text-slate-200">${esc(label)}</div>
      ${hint ? `<div class="text-[11px] text-slate-400">${esc(hint)}</div>` : ''}
    </div>
    <div class="shrink-0 flex items-center gap-1.5">${control}</div>
  </div>`
}

function group(title: string, inner: string): string {
  return `<section>
    <h3 class="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">${esc(title)}</h3>
    <div class="rounded-lg border border-slate-200 dark:border-slate-700 divide-y divide-slate-100 dark:divide-slate-700/60 px-3">${inner}</div>
  </section>`
}

export interface SettingsCallbacks {
  theme: ThemeName
  edgeOptions: EdgeOptions
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
  /** Report default home country (ISO2). */
  homeCountry: string
  onHomeCountry: (iso2: string) => void
}

/** Open the Settings modal. */
export function showSettings(cb: SettingsCallbacks): void {
  const opts: EdgeOptions = {
    hiddenKinds: [...cb.edgeOptions.hiddenKinds],
    opacity: cb.edgeOptions.opacity
  }
  let theme = cb.theme

  const countryOpts = [
    `<option value=""${cb.homeCountry ? '' : ' selected'}>— none —</option>`,
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

  const overlay = document.createElement('div')
  overlay.className = 'fixed inset-0 z-[110] flex items-center justify-center bg-black/40 p-4'
  overlay.innerHTML = `
    <div class="w-[620px] max-w-full max-h-[88vh] flex flex-col bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-lg shadow-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
      <div class="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-700 shrink-0">
        <h2 class="font-semibold text-slate-800 dark:text-slate-100">Settings</h2>
        <button data-close class="text-slate-400 hover:text-slate-700 dark:hover:text-slate-100 text-lg leading-none">✕</button>
      </div>
      <div class="overflow-y-auto p-4 space-y-3 text-sm">

        ${group(
          'Links',
          row(
            'Link opacity',
            `<input id="stOpacity" type="range" min="0" max="100" step="5" class="w-40 accent-sky-500" />
             <span id="stOpacityVal" class="w-9 text-right text-xs text-slate-400 tabular-nums"></span>`,
            'Lower keeps links in the background so nodes stand out.'
          ) +
            `<div class="py-2">
              <div class="text-slate-700 dark:text-slate-200 mb-1">Visible link types</div>
              <div class="grid grid-cols-2 gap-x-4">${linkTypes}</div>
              <div id="stEdgeRestoreWrap" class="mt-2 ${cb.individuallyHiddenEdges ? '' : 'hidden'}">
                <button id="stEdgeRestore" class="${smallBtn}">Restore ${cb.individuallyHiddenEdges} individually hidden link${cb.individuallyHiddenEdges === 1 ? '' : 's'}</button>
              </div>
            </div>`
        )}

        ${group(
          'Appearance',
          row(
            'Colour mode',
            `<button id="stTheme" class="${smallBtn}"></button>`,
            'Applies to the whole window.'
          ) +
            row(
              'Panels & minimap',
              `<button id="stLayoutSave" class="${smallBtn}">Set current as default</button>
               <button id="stLayoutRestore" class="${smallBtn}">Restore default</button>`,
              'Drag the inner edge of a side panel, or the minimap corner, to resize.'
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
             <button id="stSnapClear" class="${smallBtn}">Clear</button>`,
            'Where “Save snapshot” opens.'
          ) + `<div class="py-1.5 text-[11px] text-slate-400 font-mono break-all" id="stSnapDirPath"></div>`
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
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close()
  })
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
  overlay.querySelector('#stEdgeRestore')?.addEventListener('click', () => {
    cb.onRestoreHiddenEdges()
    overlay.querySelector('#stEdgeRestoreWrap')?.classList.add('hidden')
  })

  // --- Appearance: toggling the theme keeps the dialog open ---
  const themeBtn = overlay.querySelector<HTMLButtonElement>('#stTheme')!
  const showTheme = (): void => {
    themeBtn.textContent = theme === 'dark' ? '☀ Light mode' : '🌙 Dark mode'
  }
  showTheme()
  themeBtn.addEventListener('click', () => {
    cb.onToggleTheme()
    theme = theme === 'dark' ? 'light' : 'dark'
    showTheme()
  })

  overlay.querySelector('#stLayoutSave')!.addEventListener('click', cb.onSaveLayoutDefault)
  overlay.querySelector('#stLayoutRestore')!.addEventListener('click', cb.onRestoreLayout)

  // --- Reports ---
  const homeEl = overlay.querySelector<HTMLSelectElement>('#stHome')!
  homeEl.addEventListener('change', () => cb.onHomeCountry(homeEl.value))
  overlay.querySelector('#stZones')!.addEventListener('click', () => cb.onOpenZones())

  // --- Snapshot folder ---
  const snapPathEl = overlay.querySelector<HTMLElement>('#stSnapDirPath')!
  const showSnapDir = (): void => {
    const dir = readSnapshotDir()
    snapPathEl.textContent = dir || 'Not set — the system default is used.'
  }
  showSnapDir()
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
