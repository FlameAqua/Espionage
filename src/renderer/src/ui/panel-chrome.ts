// Shared chrome for the two side panels.
//
// Their CONTENT can't sensibly be one component — the left panel is static
// filters and view controls, the right is re-rendered from scratch on every
// selection — but the frame around them (title, Hide button, divider) should look
// and behave identically. That frame lives here so it's written once instead of
// drifting apart in app.ts and details.ts.

const esc = (s: unknown): string =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )

/** The panel's name, e.g. NAVIGATION / DETAILS. */
export function panelTitle(title: string): string {
  return `<span class="text-[11px] font-bold text-slate-400 uppercase tracking-wide">${esc(title)}</span>`
}

export interface PanelHeaderOptions {
  title: string
  /** Which edge the panel collapses towards — sets the Hide chevron direction. */
  side: 'left' | 'right'
  /** id given to the Hide button, so the caller can wire it. */
  hideId: string
  /** Optional control placed before the title (the details panel's Back button). */
  leading?: string
}

/** Just the header row: [leading] Title … Hide. No padding or border, so it can
 *  sit inside a taller header block that draws its own. */
export function panelHeaderRow(o: PanelHeaderOptions): string {
  const label = o.side === 'left' ? '‹ Hide' : 'Hide ›'
  return `<div class="flex items-center justify-between gap-2">
    ${o.leading ?? ''}${panelTitle(o.title)}
    <button id="${esc(o.hideId)}" class="px-2 py-0.5 rounded text-xs text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" title="Hide panel">${label}</button>
  </div>`
}

/** The header row wrapped in the standard padding + divider. */
export function panelHeader(o: PanelHeaderOptions): string {
  return `<div class="shrink-0 px-3 py-2 border-b border-slate-200 dark:border-slate-800">
    ${panelHeaderRow(o)}
  </div>`
}
