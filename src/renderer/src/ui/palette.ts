// The Ctrl+K command palette: one searchable list of every action in the app,
// plus jump-to-node results, so nothing depends on remembering a shortcut.

const esc = (s: unknown): string =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )

export interface PaletteCommand {
  /** Display name, e.g. "Generate report". */
  title: string
  /** Grouping shown as a section heading, e.g. "Reports". */
  group: string
  /** Accelerator hint, e.g. "Ctrl+G". */
  accel?: string
  /** Extra words to match on that aren't in the title. */
  keywords?: string
  run: () => void
}

/** A node the query matched, offered under "Jump to". */
export interface PaletteTarget {
  id: string
  label: string
  detail?: string
  colour: string
}

interface PaletteOptions {
  commands: PaletteCommand[]
  /** Resolve node matches for the current query (empty query = no results). */
  findNodes: (query: string) => PaletteTarget[]
  onNavigate: (id: string) => void
}

interface Row {
  /** Section heading this row sits under. */
  group: string
  title: string
  detail?: string
  accel?: string
  colour?: string
  run: () => void
}

/** Subsequence match ("gr" matches "Generate report"), so short abbreviations
 *  work, with a score that favours earlier and more contiguous matches. */
function score(haystack: string, needle: string): number | null {
  if (!needle) return 0
  const h = haystack.toLowerCase()
  const n = needle.toLowerCase()
  if (h.includes(n)) return h.startsWith(n) ? 1000 : 500 - h.indexOf(n)
  let hi = 0
  let hits = 0
  let last = -1
  let penalty = 0
  for (const ch of n) {
    const found = h.indexOf(ch, hi)
    if (found === -1) return null
    if (last >= 0) penalty += found - last - 1
    last = found
    hi = found + 1
    hits++
  }
  return hits === n.length ? 100 - Math.min(90, penalty) : null
}

/** Open the palette. Resolves when it closes. */
export function showPalette(opts: PaletteOptions): void {
  const overlay = document.createElement('div')
  overlay.className = 'fixed inset-0 z-[140] flex items-start justify-center bg-black/40 p-4 pt-[12vh]'
  overlay.innerHTML = `
    <div class="w-[640px] max-w-full max-h-[70vh] flex flex-col bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-lg shadow-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
      <div class="shrink-0 flex items-center gap-2 px-3 py-2.5 border-b border-slate-200 dark:border-slate-700">
        <span class="text-slate-400">⌘</span>
        <input id="pQuery" type="text" placeholder="Type a command, or an extension / queue name…" autocomplete="off"
          class="flex-1 bg-transparent text-[15px] focus:outline-none placeholder:text-slate-400" />
        <kbd class="text-[10px] text-slate-400 border border-current rounded px-1 py-0.5">Esc</kbd>
      </div>
      <div id="pList" class="overflow-y-auto py-1"></div>
    </div>`
  document.body.appendChild(overlay)
  const close = (): void => {
    document.removeEventListener('keydown', onKey, true)
    overlay.remove()
  }
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close()
  })

  const queryEl = overlay.querySelector<HTMLInputElement>('#pQuery')!
  const listEl = overlay.querySelector<HTMLElement>('#pList')!
  let rows: Row[] = []
  let active = 0

  const build = (query: string): Row[] => {
    const q = query.trim()
    const scored = opts.commands
      .map((c) => {
        const best = Math.max(
          score(c.title, q) ?? -1,
          score(`${c.group} ${c.title}`, q) ?? -1,
          c.keywords ? (score(c.keywords, q) ?? -1) : -1
        )
        return { c, best }
      })
      .filter((x) => x.best >= 0)
      // Keep the authored order when nothing is typed; rank by match otherwise.
      .sort((a, b) => (q ? b.best - a.best : 0))
    const out: Row[] = scored.map(({ c }) => ({
      group: c.group,
      title: c.title,
      accel: c.accel,
      run: c.run
    }))
    for (const t of q ? opts.findNodes(q) : []) {
      out.push({
        group: 'Jump to',
        title: t.label,
        detail: t.detail,
        colour: t.colour,
        run: () => opts.onNavigate(t.id)
      })
    }
    return out
  }

  const render = (): void => {
    if (!rows.length) {
      listEl.innerHTML = `<p class="px-3 py-6 text-center text-sm text-slate-400">No matching commands.</p>`
      return
    }
    let html = ''
    let lastGroup = ''
    rows.forEach((r, i) => {
      if (r.group !== lastGroup) {
        lastGroup = r.group
        html += `<div class="px-3 pt-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">${esc(r.group)}</div>`
      }
      const on = i === active
      html += `<button data-i="${i}" class="w-full text-left flex items-center gap-2.5 px-3 py-1.5 ${
        on ? 'bg-sky-100 dark:bg-sky-900/40' : 'hover:bg-slate-100 dark:hover:bg-slate-700'
      }">
        ${r.colour ? `<span class="w-2 h-2 rounded-full shrink-0" style="background:${r.colour}"></span>` : ''}
        <span class="flex-1 truncate">${esc(r.title)}</span>
        ${r.detail ? `<span class="text-xs text-slate-400 font-mono shrink-0">${esc(r.detail)}</span>` : ''}
        ${r.accel ? `<span class="text-[10px] text-slate-400 font-mono shrink-0">${esc(r.accel)}</span>` : ''}
      </button>`
    })
    listEl.innerHTML = html
    for (const b of listEl.querySelectorAll<HTMLElement>('[data-i]')) {
      // mousedown, not click: the input's blur must not beat the selection.
      b.addEventListener('mousedown', (e) => {
        e.preventDefault()
        pick(Number(b.dataset.i))
      })
    }
    listEl.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  const pick = (i: number): void => {
    const row = rows[i]
    if (!row) return
    close()
    row.run()
  }

  const refresh = (): void => {
    rows = build(queryEl.value)
    active = 0
    render()
  }

  // Captured at the document so the app's own Ctrl shortcuts don't also fire.
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
      return
    }
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
      e.preventDefault()
      e.stopPropagation()
      active = Math.min(rows.length - 1, active + 1)
      render()
      return
    }
    if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
      e.preventDefault()
      e.stopPropagation()
      active = Math.max(0, active - 1)
      render()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      pick(active)
    }
  }
  document.addEventListener('keydown', onKey, true)
  queryEl.addEventListener('input', refresh)

  refresh()
  queryEl.focus()
}
