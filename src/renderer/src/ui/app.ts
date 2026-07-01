// The connected-state UI: toolbar (search, layout, focus, zoom, theme, PNG),
// category legend/filter, the graph canvas, overview minimap, context menu and
// the details panel (with an ego mini-map). Owns the GraphView and view state.

import type { Topology } from '../../../shared/types'
import { buildTopology } from '../graph/build'
import { GraphView, type LayoutName, type ThemeName } from '../graph/view'
import { NODE_KIND_META, type GraphNode, type NodeKind } from '../graph/model'
import { renderDetails } from './details'
import { EgoMap } from './egomap'
import { Minimap } from './minimap'

interface AppCallbacks {
  onReload: () => void
  onDisconnect: () => void
}

const esc = (s: unknown): string =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )

const THEME_KEY = '3cx-spy.theme'
const btn = 'px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-xs text-slate-100'

let cleanup: (() => void)[] = []

export function getTheme(): ThemeName {
  return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'
}
function applyTheme(theme: ThemeName): void {
  document.documentElement.classList.toggle('dark', theme === 'dark')
  localStorage.setItem(THEME_KEY, theme)
}

export function renderApp(
  root: HTMLElement,
  topology: Topology,
  cb: AppCallbacks,
  initialFocusId?: string
): void {
  cleanup.forEach((fn) => fn())
  cleanup = []

  const graph = buildTopology(topology)
  const counts = countKinds(graph.nodes.map((n) => n.kind))
  const presentKinds = (Object.keys(NODE_KIND_META) as NodeKind[]).filter((k) => counts[k])
  // Trunks are noisy for day-to-day call-flow reading, so hide them by default.
  const DEFAULT_OFF: NodeKind[] = ['trunk']
  const visible = new Set<NodeKind>(presentKinds.filter((k) => !DEFAULT_OFF.includes(k)))
  let theme = getTheme()
  applyTheme(theme)

  const host = topology.baseUrl.replace(/^https?:\/\//, '')
  const baseUrl = topology.baseUrl.replace(/\/+$/, '')
  const errors = collectErrors(topology)

  root.innerHTML = `
    <div class="h-screen grid grid-rows-[3rem_1fr] bg-slate-100 text-slate-800 dark:bg-slate-950 dark:text-slate-200">
      <header class="flex items-center gap-2 px-3 bg-slate-900 text-slate-100">
        <span class="font-bold tracking-tight">Espionage</span>
        <span class="text-xs text-slate-400 font-mono truncate max-w-[220px]">${esc(host)}</span>
        <div class="relative ml-2 w-56">
          <input id="search" type="text" placeholder="Search…"
            class="w-full px-3 py-1.5 rounded-md bg-slate-800 border border-slate-700 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500" />
          <div id="results" class="hidden absolute z-30 mt-1 w-full bg-white text-slate-800 dark:bg-slate-800 dark:text-slate-100 rounded-md shadow-lg border border-slate-200 dark:border-slate-700 max-h-72 overflow-y-auto"></div>
        </div>

        <select id="layout" title="Layout" class="${btn} appearance-none pr-2">
          <option value="flow">Flow</option>
          <option value="compact">Compact</option>
          <option value="force">Spread</option>
        </select>

        <div class="ml-auto flex items-center gap-1.5 text-sm">
          ${errors.length ? `<button id="warn" class="px-2 py-1 rounded bg-amber-500/90 hover:bg-amber-500 text-white text-xs">${errors.length}⚠</button>` : ''}
          ${graph.warnings.length ? `<button id="unresolved" class="px-2 py-1 rounded bg-red-600/90 hover:bg-red-600 text-white text-xs">${graph.warnings.length} unresolved</button>` : ''}
          <button id="help" class="${btn} w-7" title="Help" aria-label="Help">?</button>
          <div class="relative">
            <button id="menuBtn" class="${btn}" title="Menu" aria-label="Menu">☰</button>
            <div id="menu" class="hidden absolute right-0 top-full mt-1 z-40 min-w-[180px] py-1 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-md shadow-xl border border-slate-200 dark:border-slate-700"></div>
          </div>
        </div>
      </header>

      <div id="body" class="grid grid-cols-[12rem_1fr_20rem] min-h-0">
        <aside class="min-h-0 flex flex-col bg-white border-r border-slate-200 dark:bg-slate-900 dark:border-slate-800">
          <div class="flex-1 overflow-y-auto p-3">
            <h3 class="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-2">Categories</h3>
            <p class="text-[10px] text-slate-400 mb-1.5">Checkbox shows/hides · click a name to highlight it</p>
            <ul id="legend" class="space-y-0.5">
              ${presentKinds
                .map(
                  (k) => `
                <li class="flex items-center gap-2 text-xs">
                  <input type="checkbox" data-kind="${k}" ${visible.has(k) ? 'checked' : ''} class="accent-sky-500" />
                  <button data-hl="${k}" class="flex-1 flex items-center gap-2 text-left rounded px-1 py-0.5 hover:bg-slate-100 dark:hover:bg-slate-800">
                    <span class="w-3 h-3 rounded" style="background:${NODE_KIND_META[k].color}"></span>
                    <span class="flex-1">${esc(NODE_KIND_META[k].label)}</span>
                    <span class="text-slate-400">${counts[k]}</span>
                  </button>
                </li>`
                )
                .join('')}
            </ul>
          </div>
          <div class="shrink-0 border-t border-slate-200 dark:border-slate-800 p-3 space-y-2">
            <label class="flex items-center gap-2 text-xs cursor-pointer select-none">
              <input id="hideUnconnected" type="checkbox" class="accent-sky-500" />
              Hide unconnected nodes
            </label>
            <div class="flex items-center gap-1">
              <button id="zoomOut" class="${btn} w-7" title="Zoom out">−</button>
              <input id="zoom" type="range" min="0" max="1000" value="500" class="flex-1 min-w-0 accent-sky-500" title="Zoom" />
              <button id="zoomIn" class="${btn} w-7" title="Zoom in">+</button>
            </div>
            <div class="flex items-center gap-1">
              <button id="fit" class="${btn} flex-1" title="Fit to screen">⤢ Fit</button>
              <button id="lock" class="${btn} flex-1" title="Lock nodes — pan freely without moving them (or hold Space)">🔓 Lock</button>
            </div>
          </div>
        </aside>

        <main class="relative min-h-0 min-w-0 bg-slate-100 dark:bg-slate-950">
          <div id="graph" class="w-full h-full"></div>
          <div id="breadcrumb" class="absolute top-3 right-3 z-20 flex items-center flex-wrap justify-end gap-x-0.5 max-w-[65%] px-2.5 py-1 rounded-md bg-white/90 dark:bg-slate-800/90 border border-slate-200 dark:border-slate-700 shadow text-xs text-slate-600 dark:text-slate-300"></div>
          <div class="absolute bottom-3 left-3 z-20">
            <div id="minimap" class="w-52 h-36 rounded-md border border-slate-300 dark:border-slate-700 bg-white/80 dark:bg-slate-900/80 shadow overflow-hidden cursor-pointer"></div>
            <button id="mapToggle" class="absolute top-1 left-1 z-30 px-1.5 py-0.5 rounded bg-slate-700/90 hover:bg-slate-600 text-slate-100 text-[10px] shadow" title="Toggle minimap">Hide</button>
          </div>
          <button id="reopen" class="hidden absolute bottom-3 right-3 z-20 px-2 py-1 rounded bg-slate-700 text-slate-100 text-xs shadow">Details ›</button>
          <div id="panel" class="hidden absolute z-20 inset-x-4 bottom-4 max-h-[40%] bg-white dark:bg-slate-800 dark:text-slate-200 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700 overflow-y-auto p-3 text-xs"></div>
        </main>

        <aside id="details" class="min-h-0 bg-white border-l border-slate-200 overflow-hidden dark:bg-slate-900 dark:border-slate-800"></aside>
      </div>

      <div id="ctxmenu" class="hidden fixed z-50 py-1 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-md shadow-xl border border-slate-200 dark:border-slate-700 text-sm"></div>

      <div id="helpModal" class="hidden fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
        <div class="w-[300px] max-w-full bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-lg shadow-2xl border border-slate-200 dark:border-slate-700 p-4">
          <div class="flex items-center justify-between mb-3">
            <h2 class="font-semibold text-slate-800 dark:text-slate-100">Controls</h2>
            <button id="helpClose" class="text-slate-400 hover:text-slate-700 dark:hover:text-slate-100 text-lg leading-none">✕</button>
          </div>
          <div class="grid grid-cols-[2rem_1fr] gap-x-3 gap-y-3 items-center text-sm">
            ${helpRow(mouseSvg('left'), 'Click', 'details')}
            ${helpRow(mouseSvg('left', '×2'), 'Double-click', 'focus')}
            ${helpRow(mouseSvg('right'), 'Right-click', 'actions')}
            ${helpRow(mouseSvg('wheel'), 'Scroll', 'zoom (Ctrl = faster)')}
            ${helpRow(dragSvg(), 'Drag', 'pan / move node')}
            ${helpRow(keyCap('space'), 'Space / 🔒', 'pan through nodes')}
          </div>
        </div>
      </div>
    </div>`

  const graphEl = root.querySelector<HTMLElement>('#graph')!
  const detailsEl = root.querySelector<HTMLElement>('#details')!
  const bodyEl = root.querySelector<HTMLElement>('#body')!
  const reopenBtn = root.querySelector<HTMLButtonElement>('#reopen')!
  const ctxEl = root.querySelector<HTMLElement>('#ctxmenu')!
  const minimapEl = root.querySelector<HTMLElement>('#minimap')!
  const breadcrumbEl = root.querySelector<HTMLElement>('#breadcrumb')!

  // --- State --------------------------------------------------------------
  const history: string[] = []
  let current: GraphNode | null = null
  let egoMap: EgoMap | null = null

  const showDetails = (node: GraphNode | null): void => {
    current = node
    egoMap?.destroy()
    egoMap = null
    renderDetails(detailsEl, node, {
      graph,
      canGoBack: history.length > 1,
      onNavigate: (id) => navigate(id, true),
      onBack: goBack,
      onHide: () => toggleDetails(false)
    })
    if (node) {
      const egoEl = detailsEl.querySelector<HTMLElement>('#egomap')
      if (egoEl) egoMap = new EgoMap(egoEl, graph, node.id, theme, (id) => navigate(id, true))
    }
  }

  // Reveal a node: details + camera. If it's currently filtered out of view
  // (e.g. going Back to a node outside the active focus), re-focus on it so it's
  // always visible instead of centring on empty space.
  const showNode = (id: string, opts: { focus?: boolean } = {}): void => {
    const node = graph.nodes.find((n) => n.id === id)
    if (!node) return
    clearHighlightUI()
    // If the target isn't currently on-screen (focus filter or "Hide
    // unconnected"), focus on it so it's laid out cleanly and centred rather
    // than revealed at a stale, overlapping position.
    if (opts.focus || !view.isVisible(id)) view.focusNeighbourhood(id)
    else view.centerOn(id)
    if (detailsHidden) toggleDetails(true)
    showDetails(node)
    renderBreadcrumb()
  }

  // Single-click / navigation: details + pan, keeping the current focus (unless
  // the target isn't visible, handled by showNode).
  const navigate = (id: string, push: boolean): void => {
    if (!graph.nodes.some((n) => n.id === id)) return
    if (push && history[history.length - 1] !== id) history.push(id)
    showNode(id)
  }

  const goBack = (): void => {
    if (history.length < 2) return
    history.pop()
    showNode(history[history.length - 1])
  }

  // Double-click / "Focus here": collapse to this node's neighbourhood using the
  // currently-selected layout (Flow by default), ending centred on the node.
  const enterFocus = (id: string): void => {
    if (!graph.nodes.some((n) => n.id === id)) return
    if (history[history.length - 1] !== id) history.push(id)
    showNode(id, { focus: true })
  }

  // Breadcrumb: All › (…) › up to the 4 most recent nodes, current last.
  const renderBreadcrumb = (): void => {
    const sep = '<span class="text-slate-400 mx-1">›</span>'
    const parts = [`<button data-crumb="all" class="hover:underline">All</button>`]
    const start = Math.max(0, history.length - 4)
    if (start > 0) parts.push('<span class="text-slate-400">…</span>')
    for (let i = start; i < history.length; i++) {
      const n = graph.nodes.find((x) => x.id === history[i])
      const label = n ? (n.number ?? n.label) : '?'
      const isCurrent = i === history.length - 1
      parts.push(
        `<button data-crumb="${i}" class="${isCurrent ? 'font-semibold text-sky-600 dark:text-sky-400' : 'hover:underline'}">${esc(label)}</button>`
      )
    }
    breadcrumbEl.innerHTML = parts.join(sep)
    breadcrumbEl.querySelectorAll<HTMLElement>('[data-crumb]').forEach((b) => {
      b.addEventListener('click', () => {
        const v = b.dataset.crumb!
        if (v === 'all') {
          history.length = 0
          view.clearFocus()
          showDetails(null)
          renderBreadcrumb()
        } else {
          const i = Number(v)
          history.length = i + 1
          showNode(history[i])
        }
      })
    })
  }

  // --- Details panel show/hide -------------------------------------------
  let detailsHidden = false
  const toggleDetails = (show: boolean): void => {
    detailsHidden = !show
    bodyEl.style.gridTemplateColumns = show ? '12rem 1fr 20rem' : '12rem 1fr 0'
    detailsEl.classList.toggle('hidden', !show)
    reopenBtn.classList.toggle('hidden', show)
    // Resize the canvas to the new width WITHOUT refitting (keeps zoom/pan).
    requestAnimationFrame(() => view.resize())
  }

  // --- Context menu -------------------------------------------------------
  const hideCtx = (): void => ctxEl.classList.add('hidden')
  const showCtx = (node: GraphNode, x: number, y: number): void => {
    const item = (label: string, fn: () => void): HTMLElement => {
      const b = document.createElement('button')
      b.className =
        'w-full text-left px-2.5 py-1 hover:bg-slate-100 dark:hover:bg-slate-700 whitespace-nowrap'
      b.textContent = label
      b.addEventListener('click', () => {
        hideCtx()
        fn()
      })
      return b
    }
    ctxEl.innerHTML = ''
    ctxEl.append(item('Focus here', () => enterFocus(node.id)))
    ctxEl.append(
      item('Open in new window', () =>
        window.api.app.openWindow(`#focus=${encodeURIComponent(node.id)}`)
      )
    )
    if (threecxUrl(baseUrl, node))
      ctxEl.append(
        item('Open in 3CX', () => window.api.app.openExternal(threecxUrl(baseUrl, node)!))
      )
    ctxEl.append(item('Copy name', () => window.api.app.copy(node.label)))
    if (node.number)
      ctxEl.append(item(`Copy ext ${node.number}`, () => window.api.app.copy(node.number!)))
    const rawId = node.raw['Id']
    if (rawId != null) ctxEl.append(item('Copy ID', () => window.api.app.copy(String(rawId))))
    ctxEl.style.left = `${Math.min(x, window.innerWidth - 150)}px`
    ctxEl.style.top = `${Math.min(y, window.innerHeight - 180)}px`
    ctxEl.classList.remove('hidden')
  }
  const onDocClick = (): void => hideCtx()
  document.addEventListener('click', onDocClick)
  cleanup.push(() => document.removeEventListener('click', onDocClick))

  // --- Graph view ---------------------------------------------------------
  const view = new GraphView(graphEl, graph, visible, theme, {
    onNodeTap: (node) => navigate(node.id, true),
    onBackgroundTap: () => {
      clearHighlightUI()
      showDetails(null)
    },
    onZoomChange: (z) => {
      zoomSlider.value = String(zoomToSlider(z, view.getMinZoom(), view.getMaxZoom()))
    },
    onNodeContext: (node, x, y) => showCtx(node, x, y),
    onNodeDoubleTap: (node) => enterFocus(node.id)
  })
  showDetails(null)
  renderBreadcrumb()

  const minimap = new Minimap(minimapEl, view.core(), theme)
  // Tear down in dependency order: minimap & ego map reference the main core, so
  // they must be destroyed before the view destroys that core.
  cleanup.push(() => minimap.destroy())
  cleanup.push(() => egoMap?.destroy())
  cleanup.push(() => view.destroy())

  // --- Legend: show/hide (checkbox) + highlight (name) --------------------
  root.querySelectorAll<HTMLInputElement>('#legend input[data-kind]').forEach((c) => {
    c.addEventListener('change', () => {
      const kind = c.dataset.kind as NodeKind
      if (c.checked) visible.add(kind)
      else visible.delete(kind)
      view.setVisibleKinds(visible)
    })
  })

  let highlightedKind: NodeKind | null = null
  const hlButtons = root.querySelectorAll<HTMLElement>('#legend [data-hl]')
  const clearHighlightUI = (): void => {
    highlightedKind = null
    hlButtons.forEach((el) => el.classList.remove('ring-1', 'ring-sky-500'))
  }
  const setHighlightKind = (kind: NodeKind | null): void => {
    highlightedKind = kind
    view.highlightKind(kind)
    hlButtons.forEach((el) => {
      const on = el.dataset.hl === kind
      el.classList.toggle('ring-1', on)
      el.classList.toggle('ring-sky-500', on)
    })
  }
  hlButtons.forEach((b) => {
    b.addEventListener('click', () => {
      const kind = b.dataset.hl as NodeKind
      setHighlightKind(highlightedKind === kind ? null : kind)
    })
  })

  // --- Toolbar ------------------------------------------------------------
  // The dropdown applies to the full graph or the focused subset alike.
  const layoutSel = root.querySelector<HTMLSelectElement>('#layout')!
  layoutSel.addEventListener('change', () => view.setLayout(layoutSel.value as LayoutName))

  // Minimap show/hide toggle sits just under the map.
  const mapToggle = root.querySelector<HTMLButtonElement>('#mapToggle')!
  mapToggle.addEventListener('mousedown', (e) => e.stopPropagation())
  mapToggle.addEventListener('click', (e) => {
    e.stopPropagation()
    const hidden = minimapEl.classList.toggle('hidden')
    mapToggle.textContent = hidden ? 'Show' : 'Hide'
  })

  // --- Node lock (padlock + Space-to-pan) ---------------------------------
  const lockBtn = root.querySelector<HTMLButtonElement>('#lock')!
  let locked = false
  let spaceHeld = false
  const applyLock = (): void => {
    const effective = locked || spaceHeld
    view.setNodesGrabbable(!effective)
    lockBtn.textContent = effective ? '🔒 Locked' : '🔓 Lock'
    lockBtn.classList.toggle('bg-sky-700', locked)
  }
  lockBtn.addEventListener('click', () => {
    locked = !locked
    applyLock()
  })
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'Space' && !isTyping(e.target) && !spaceHeld) {
      e.preventDefault()
      spaceHeld = true
      applyLock()
    }
  }
  const onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'Space') {
      spaceHeld = false
      applyLock()
    }
  }
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  cleanup.push(() => window.removeEventListener('keydown', onKeyDown))
  cleanup.push(() => window.removeEventListener('keyup', onKeyUp))

  // Open-in-new-window deep link: focus the requested node once wired up.
  if (initialFocusId && graph.nodes.some((n) => n.id === initialFocusId)) {
    enterFocus(initialFocusId)
  }

  const zoomSlider = root.querySelector<HTMLInputElement>('#zoom')!
  zoomSlider.addEventListener('input', () => {
    view.setZoom(sliderToZoom(Number(zoomSlider.value), view.getMinZoom(), view.getMaxZoom()))
  })
  root.querySelector('#zoomIn')!.addEventListener('click', () => view.zoomBy(1.3))
  root.querySelector('#zoomOut')!.addEventListener('click', () => view.zoomBy(1 / 1.3))
  root.querySelector('#fit')!.addEventListener('click', () => view.fit())

  const hideUnconn = root.querySelector<HTMLInputElement>('#hideUnconnected')!
  hideUnconn.addEventListener('change', () => view.setHideUnconnected(hideUnconn.checked))

  // --- Burger menu --------------------------------------------------------
  const menuBtn = root.querySelector<HTMLButtonElement>('#menuBtn')!
  const menuEl = root.querySelector<HTMLElement>('#menu')!
  const toggleTheme = (): void => {
    theme = theme === 'dark' ? 'light' : 'dark'
    applyTheme(theme)
    view.setTheme(theme)
    minimap.setTheme(theme)
    if (current) showDetails(current)
  }
  const buildMenu = (): void => {
    const item = (icon: string, label: string, fn: () => void): HTMLElement => {
      const b = document.createElement('button')
      b.className =
        'w-full text-left flex items-center gap-2.5 px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-700'
      b.innerHTML = `<span class="w-4 text-center">${icon}</span><span>${esc(label)}</span>`
      b.addEventListener('click', () => {
        menuEl.classList.add('hidden')
        fn()
      })
      return b
    }
    menuEl.innerHTML = ''
    menuEl.append(
      item(
        theme === 'dark' ? '☀' : '🌙',
        theme === 'dark' ? 'Light mode' : 'Dark mode',
        toggleTheme
      )
    )
    menuEl.append(item('🖼', 'Export PNG', () => exportPng(view, theme, host)))
    menuEl.append(item('↻', 'Reload', cb.onReload))
    menuEl.append(item('⏏', 'Disconnect', cb.onDisconnect))
  }
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    const open = menuEl.classList.contains('hidden')
    if (open) buildMenu()
    menuEl.classList.toggle('hidden', !open)
  })
  const onDocClickMenu = (e: MouseEvent): void => {
    if (!menuEl.contains(e.target as Node)) menuEl.classList.add('hidden')
  }
  document.addEventListener('click', onDocClickMenu)
  cleanup.push(() => document.removeEventListener('click', onDocClickMenu))

  reopenBtn.addEventListener('click', () => toggleDetails(true))

  // --- Help modal ---------------------------------------------------------
  const helpModal = root.querySelector<HTMLElement>('#helpModal')!
  root.querySelector('#help')!.addEventListener('click', () => helpModal.classList.remove('hidden'))
  root
    .querySelector('#helpClose')!
    .addEventListener('click', () => helpModal.classList.add('hidden'))
  helpModal.addEventListener('click', (e) => {
    if (e.target === helpModal) helpModal.classList.add('hidden')
  })

  // --- Search dropdown ----------------------------------------------------
  const searchEl = root.querySelector<HTMLInputElement>('#search')!
  const resultsEl = root.querySelector<HTMLElement>('#results')!
  searchEl.addEventListener('input', () => {
    const matches = view.search(searchEl.value).slice(0, 12)
    if (!matches.length) {
      resultsEl.classList.add('hidden')
      return
    }
    resultsEl.innerHTML = matches
      .map(
        (m: GraphNode) => `
        <button data-id="${esc(m.id)}" class="w-full text-left flex items-center gap-2 px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-700 text-sm">
          <span class="w-2.5 h-2.5 rounded-full" style="background:${NODE_KIND_META[m.kind].color}"></span>
          <span class="flex-1 truncate">${esc(m.label)}</span>
          ${m.number ? `<span class="text-xs text-slate-400 font-mono">${esc(m.number)}</span>` : ''}
        </button>`
      )
      .join('')
    resultsEl.classList.remove('hidden')
    resultsEl.querySelectorAll<HTMLElement>('[data-id]').forEach((b) => {
      b.addEventListener('click', () => {
        navigate(b.dataset.id!, true)
        resultsEl.classList.add('hidden')
        searchEl.value = ''
      })
    })
  })
  searchEl.addEventListener('blur', () => setTimeout(() => resultsEl.classList.add('hidden'), 150))

  // --- Diagnostics panel --------------------------------------------------
  const panel = root.querySelector<HTMLElement>('#panel')!
  const showPanel = (title: string, items: string[]): void => {
    panel.innerHTML = `
      <div class="flex items-center justify-between mb-2">
        <h3 class="font-semibold text-slate-700 dark:text-slate-200">${esc(title)}</h3>
        <button id="closePanel" class="text-slate-400 hover:text-slate-700 dark:hover:text-slate-100">✕</button>
      </div>
      <ul class="space-y-1 text-slate-600 dark:text-slate-300">${items.map((i) => `<li>• ${esc(i)}</li>`).join('')}</ul>`
    panel.classList.remove('hidden')
    panel
      .querySelector('#closePanel')!
      .addEventListener('click', () => panel.classList.add('hidden'))
  }
  root.querySelector('#warn')?.addEventListener('click', () => showPanel('Fetch warnings', errors))
  root
    .querySelector('#unresolved')
    ?.addEventListener('click', () => showPanel('Unresolved routes', graph.warnings))
}

function exportPng(view: GraphView, theme: ThemeName, host: string): void {
  const bg = theme === 'dark' ? '#020617' : '#f1f5f9'
  const url = URL.createObjectURL(view.pngBlob(bg))
  const a = document.createElement('a')
  a.href = url
  a.download = `espionage-${host.replace(/[^\w.-]/g, '_')}.png`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// --- Help-modal icons ---------------------------------------------------
function helpRow(icon: string, gesture: string, result: string): string {
  return `<div class="flex justify-center text-slate-500 dark:text-slate-300">${icon}</div>
    <div><span class="font-semibold">${gesture}</span> <span class="text-slate-400">— ${result}</span></div>`
}

function mouseSvg(part: 'left' | 'right' | 'wheel', badge = ''): string {
  const hl =
    part === 'left'
      ? '<path d="M2 9 A8 8 0 0 1 10 1 L10 10 L2 10 Z" fill="currentColor" opacity="0.45"/>'
      : part === 'right'
        ? '<path d="M18 9 A8 8 0 0 0 10 1 L10 10 L18 10 Z" fill="currentColor" opacity="0.45"/>'
        : '<rect x="8.5" y="3.5" width="3" height="5" rx="1.5" fill="currentColor" opacity="0.65"/>'
  const sup = badge ? `<text x="19" y="7" font-size="8" fill="currentColor">${badge}</text>` : ''
  return `<svg width="22" height="28" viewBox="0 0 22 28" fill="none" aria-hidden="true">
    <rect x="2" y="1" width="16" height="26" rx="8" stroke="currentColor" stroke-width="1.4"/>
    <line x1="10" y1="1.5" x2="10" y2="10" stroke="currentColor" stroke-width="1"/>
    <line x1="2" y1="10" x2="18" y2="10" stroke="currentColor" stroke-width="1"/>
    ${hl}${sup}</svg>`
}

function dragSvg(): string {
  return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/></svg>`
}

function keyCap(label: string): string {
  return `<span class="inline-block px-1.5 py-0.5 rounded border border-current text-[9px] leading-none">${label}</span>`
}

/** Deep-link a node into 3CX. Remote-system nodes open the remote PBX itself;
 *  everything else uses the console path computed at build time. */
function threecxUrl(baseUrl: string, node: GraphNode): string | null {
  if (node.kind === 'system') {
    const host = String(node.raw['Host'] ?? '')
      .trim()
      .replace(/^https?:\/\//, '')
    return host ? `https://${host}` : null
  }
  return node.threecxPath ? `${baseUrl}/#/office/${node.threecxPath}` : null
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')
}

function zoomToSlider(z: number, min: number, max: number): number {
  const t = (Math.log(z) - Math.log(min)) / (Math.log(max) - Math.log(min))
  return Math.round(Math.min(1, Math.max(0, t)) * 1000)
}
function sliderToZoom(v: number, min: number, max: number): number {
  const t = v / 1000
  return Math.exp(Math.log(min) + t * (Math.log(max) - Math.log(min)))
}

function countKinds(kinds: NodeKind[]): Record<NodeKind, number> {
  const out = {} as Record<NodeKind, number>
  for (const k of kinds) out[k] = (out[k] ?? 0) + 1
  return out
}

function collectErrors(t: Topology): string[] {
  const sets: [string, { error?: string }][] = [
    ['Users', t.users],
    ['Queues', t.queues],
    ['Ring Groups', t.ringGroups],
    ['Receptionists', t.receptionists],
    ['Inbound Rules', t.inboundRules],
    ['DID Numbers', t.didNumbers],
    ['Trunks', t.trunks],
    ['Groups', t.groups]
  ]
  return sets.filter(([, s]) => s.error).map(([name, s]) => `${name}: ${s.error}`)
}
