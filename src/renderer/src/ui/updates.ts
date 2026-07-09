// Auto-update toast. Mounts a single card on document.body (independent of the
// login/app re-renders, which wipe #root) and reflects the update lifecycle:
//
//   available  → "Update vX — downloading…" with a live progress bar
//   downloaded → "Update ready" + Restart / Later buttons
//   (manual)   → "Checking…" and "You're up to date" feedback
//
// Silent auto-checks stay quiet unless they actually find an update: we only
// surface "checking" / "up to date" / "error" when the user asked explicitly.

import type { UpdateStatus } from '../../../shared/types'

let toastEl: HTMLElement | null = null
let dismissTimer: number | null = null
// True while the user is waiting on a check they triggered from the menu, so we
// can show "up to date" / errors that we'd otherwise swallow for auto-checks.
let manualCheck = false

function ensureToast(): HTMLElement {
  if (toastEl) return toastEl
  const el = document.createElement('div')
  el.id = 'updateToast'
  el.setAttribute('role', 'status')
  el.className =
    'hidden fixed bottom-4 right-4 z-[100] w-80 max-w-[calc(100vw-2rem)] ' +
    'bg-white text-slate-700 dark:bg-slate-800 dark:text-slate-200 ' +
    'rounded-lg shadow-2xl border border-slate-200 dark:border-slate-700 p-3.5 text-sm'
  document.body.appendChild(el)
  toastEl = el
  return el
}

function hide(): void {
  if (dismissTimer !== null) {
    clearTimeout(dismissTimer)
    dismissTimer = null
  }
  toastEl?.classList.add('hidden')
}

function autoHide(ms: number): void {
  if (dismissTimer !== null) clearTimeout(dismissTimer)
  dismissTimer = window.setTimeout(hide, ms)
}

function show(html: string): HTMLElement {
  if (dismissTimer !== null) {
    clearTimeout(dismissTimer)
    dismissTimer = null
  }
  const el = ensureToast()
  el.innerHTML = html
  el.classList.remove('hidden')
  el.querySelector('[data-close]')?.addEventListener('click', hide)
  return el
}

const esc = (s: unknown): string =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )

function fmtBytes(n: number): string {
  if (!n || n < 1024) return `${Math.round(n || 0)} B`
  const units = ['KB', 'MB', 'GB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${units[i]}`
}

const closeX =
  '<button data-close aria-label="Dismiss" class="text-slate-400 hover:text-slate-700 dark:hover:text-slate-100 text-lg leading-none">✕</button>'

function header(title: string): string {
  return `<div class="flex items-start justify-between gap-2 mb-1">
      <div class="font-semibold text-slate-800 dark:text-slate-100">${esc(title)}</div>${closeX}
    </div>`
}

function progressBar(percent: number): string {
  const pct = Math.max(0, Math.min(100, Math.round(percent)))
  return `<div class="mt-2 h-1.5 w-full rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
      <div class="h-full rounded-full bg-sky-500 transition-[width] duration-200" style="width:${pct}%"></div>
    </div>`
}

function handle(status: UpdateStatus): void {
  switch (status.kind) {
    case 'checking':
      if (manualCheck) show(`${header('Checking for updates…')}`)
      return

    case 'available':
      // An update was found; auto-download has started. Always surface this.
      manualCheck = false
      show(
        `${header(`Update ${esc(status.version)} available`)}
         <div class="text-slate-500 dark:text-slate-400">Downloading…</div>
         ${progressBar(0)}`
      )
      return

    case 'progress': {
      // Only meaningful while the "available/downloading" toast is showing.
      const el = toastEl
      if (!el || el.classList.contains('hidden')) return
      const bar = el.querySelector<HTMLElement>('.bg-sky-500')
      const sub = el.querySelector<HTMLElement>('[data-sub]')
      const pct = Math.round(status.percent)
      if (bar) bar.style.width = `${Math.max(0, Math.min(100, pct))}%`
      if (sub) {
        sub.textContent = `${pct}% · ${fmtBytes(status.transferred)} / ${fmtBytes(status.total)}`
      } else {
        const dl = el.querySelector('.text-slate-500')
        if (dl) dl.innerHTML = `Downloading… <span data-sub class="tabular-nums">${pct}%</span>`
      }
      return
    }

    case 'downloaded':
      manualCheck = false
      show(
        `${header(`Update ${esc(status.version)} ready`)}
         <div class="text-slate-500 dark:text-slate-400 mb-2.5">Restart to finish installing.</div>
         <div class="flex items-center gap-2">
           <button data-install class="px-3 py-1.5 rounded-md bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold">Restart now</button>
           <button data-close class="px-3 py-1.5 rounded-md bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-xs">Later</button>
         </div>`
      )
      toastEl?.querySelector('[data-install]')?.addEventListener('click', () => {
        void window.api.updates.install()
      })
      // Re-bind the "Later" close (show() only binds [data-close] once, already done).
      return

    case 'not-available':
      if (manualCheck) {
        show(
          `${header("You're up to date")}
           <div class="text-slate-500 dark:text-slate-400">Version ${esc(status.version)} is the latest.</div>`
        )
        autoHide(4000)
      }
      manualCheck = false
      return

    case 'error':
      if (manualCheck) {
        show(
          `${header('Update check failed')}
           <div class="text-red-500 dark:text-red-400 break-words">${esc(status.message)}</div>`
        )
        autoHide(6000)
      } else {
        console.warn('[updates]', status.message)
      }
      manualCheck = false
      return
  }
}

/** Subscribe to update events. Call once at renderer bootstrap. */
export function initUpdates(): void {
  window.api.updates.onStatus(handle)
}

/** Trigger a manual check (burger menu). Shows "checking" / "up to date" toasts. */
export function checkForUpdates(): void {
  manualCheck = true
  show(`${header('Checking for updates…')}`)
  void window.api.updates.check()
}
