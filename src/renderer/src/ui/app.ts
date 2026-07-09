// The connected-state UI: toolbar (search, layout, focus, zoom, theme, PNG),
// category legend/filter, the graph canvas, overview minimap, context menu and
// the details panel (with an ego mini-map). Owns the GraphView and view state.

import type { Topology } from '../../../shared/types'
import { buildTopology } from '../graph/build'
import { GraphView, type LayoutName, type ThemeName } from '../graph/view'
import {
  NODE_KIND_META,
  SHARED_DEPARTMENT,
  departmentColor,
  departmentLabel,
  type GraphNode,
  type NodeKind
} from '../graph/model'
import { renderDetails } from './details'
import { EgoMap } from './egomap'
import { Minimap } from './minimap'
import { checkForUpdates } from './updates'
import { auditTopology, groupFindings } from '../graph/audit'

interface AppCallbacks {
  onReload: () => void
  onDisconnect: () => void
  onOpenSnapshot: () => void
}

interface DidRow {
  id: string
  did: string
  name: string
  dests: string[]
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

  // Department buckets (see computeDeptGroups in build.ts): real departments
  // sorted alphabetically, with the catch-all "Shared" bucket always last.
  const deptCounts = new Map<string, number>()
  for (const n of graph.nodes) {
    if (n.deptGroup) deptCounts.set(n.deptGroup, (deptCounts.get(n.deptGroup) ?? 0) + 1)
  }
  const deptList = [...deptCounts.entries()].sort(([a], [b]) => {
    if (a === SHARED_DEPARTMENT) return 1
    if (b === SHARED_DEPARTMENT) return -1
    return a.localeCompare(b)
  })

  root.innerHTML = `
    <div class="h-screen grid grid-rows-[3rem_1fr] bg-slate-100 text-slate-800 dark:bg-slate-950 dark:text-slate-200">
      <header class="flex items-center gap-2 px-3 bg-slate-900 text-slate-100">
        <span class="text-xs text-slate-400 font-mono truncate max-w-[240px]">${esc(host)}</span>
        <div class="relative ml-2 w-56">
          <input id="search" type="text" placeholder="Search…"
            class="w-full px-3 py-1.5 rounded-md bg-slate-800 border border-slate-700 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500" />
          <div id="results" class="hidden absolute z-30 mt-1 w-full bg-white text-slate-800 dark:bg-slate-800 dark:text-slate-100 rounded-md shadow-lg border border-slate-200 dark:border-slate-700 max-h-72 overflow-y-auto"></div>
        </div>

        <select id="layout" title="Layout" class="${btn} appearance-none pr-2">
          <option value="flow">Flow</option>
          <option value="compact">Compact</option>
          <option value="force">Spread</option>
          <option value="department">Department</option>
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
            <button id="catHeader" type="button" class="w-full flex items-center justify-between mb-2">
              <span class="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Categories</span>
              <span id="catChevron" class="text-slate-400 text-[10px] leading-none">▾</span>
            </button>
            <div id="catBody">
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

            ${
              deptList.length
                ? `
            <button id="deptHeader" type="button" class="w-full flex items-center justify-between mb-2 mt-4">
              <span class="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Departments</span>
              <span id="deptChevron" class="text-slate-400 text-[10px] leading-none">▾</span>
            </button>
            <div id="deptBody">
            <p class="text-[10px] text-slate-400 mb-1.5">Click on a department to focus on it</p>
            <ul id="deptList" class="space-y-0.5">
              <li>
                <button data-dept="" class="w-full flex items-center gap-2 text-left rounded px-1.5 py-1 text-xs font-semibold bg-sky-100 dark:bg-sky-900/40 hover:bg-slate-100 dark:hover:bg-slate-800">
                  All departments
                </button>
              </li>
              ${deptList
                .map(
                  ([bucket, count]) => `
              <li>
                <button data-dept="${esc(bucket)}" class="w-full flex items-center gap-2 text-left rounded px-1.5 py-1 text-xs hover:bg-slate-100 dark:hover:bg-slate-800">
                  <span class="w-3 h-3 rounded shrink-0" style="background:${departmentColor(bucket)}"></span>
                  <span class="flex-1 truncate">${esc(departmentLabel(bucket))}</span>
                  <span class="text-slate-400">${count}</span>
                </button>
              </li>`
                )
                .join('')}
            </ul>
            </div>`
                : ''
            }
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
          <div class="absolute bottom-3 left-3 z-20 w-52 h-36 pointer-events-none">
            <div id="minimap" class="relative w-full h-full rounded-md border border-slate-300 dark:border-slate-700 bg-white/80 dark:bg-slate-900/80 shadow overflow-hidden cursor-pointer pointer-events-auto"></div>
            <button id="mapToggle" class="absolute bottom-1 left-1 z-30 px-1.5 py-0.5 rounded bg-slate-700/90 hover:bg-slate-600 text-slate-100 text-[10px] shadow pointer-events-auto" title="Toggle minimap">Hide</button>
          </div>
          <button id="reopen" class="hidden absolute bottom-3 right-3 z-20 px-2 py-1 rounded bg-slate-700 text-slate-100 text-xs shadow">Details ›</button>
          <div id="panel" class="hidden absolute z-20 inset-x-4 bottom-4 max-h-[40%] bg-white dark:bg-slate-800 dark:text-slate-200 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700 flex flex-col overflow-hidden text-xs"></div>
        </main>

        <aside id="details" class="min-h-0 bg-white border-l border-slate-200 overflow-hidden dark:bg-slate-900 dark:border-slate-800"></aside>
      </div>

      <div id="ctxmenu" class="hidden fixed z-50 w-max py-1 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-md shadow-xl border border-slate-200 dark:border-slate-700 text-sm"></div>

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
            ${helpRow(mouseSvg('right'), 'Right-drag', 'select group → move together')}
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
    // If the target isn't currently on-screen (focus filter, department filter,
    // or "Hide unconnected"), focus on it so it's laid out cleanly and centred
    // rather than revealed at a stale, overlapping position.
    const willFocus = opts.focus || !view.isVisible(id)
    if (willFocus) clearDeptUI() // node-focus is mutually exclusive with dept filter
    if (willFocus) view.focusNeighbourhood(id)
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
          clearDeptUI()
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
    const item = (icon: string, label: string, fn: () => void): HTMLElement => {
      const b = document.createElement('button')
      b.className =
        'w-full text-left flex items-center gap-2 px-2.5 py-1 hover:bg-slate-100 dark:hover:bg-slate-700 whitespace-nowrap'
      b.innerHTML = `<span class="w-4 text-center shrink-0">${icon}</span><span>${esc(label)}</span>`
      b.addEventListener('click', () => {
        hideCtx()
        fn()
      })
      return b
    }
    const divider = (): HTMLElement => {
      const d = document.createElement('div')
      d.className = 'my-1 border-t border-slate-200 dark:border-slate-700'
      return d
    }
    ctxEl.innerHTML = ''
    ctxEl.append(item('🎯', 'Focus here', () => enterFocus(node.id)))
    ctxEl.append(item('🧭', 'Trace call flow', () => showTracePanel(node)))
    ctxEl.append(
      item('🪟', 'Open in new window', () =>
        window.api.app.openWindow(`#focus=${encodeURIComponent(node.id)}`)
      )
    )
    if (threecxUrl(baseUrl, node))
      ctxEl.append(
        item('🔗', 'Open in 3CX', () => window.api.app.openExternal(threecxUrl(baseUrl, node)!))
      )
    // Copy actions, grouped below a divider so they're easy to pick out.
    ctxEl.append(divider())
    ctxEl.append(item('📋', 'Copy name', () => window.api.app.copy(node.label)))
    if (node.number)
      ctxEl.append(item('📞', `Copy ext ${node.number}`, () => window.api.app.copy(node.number!)))
    const rawId = node.raw['Id']
    if (rawId != null) ctxEl.append(item('🆔', 'Copy ID', () => window.api.app.copy(String(rawId))))
    // Clamp to the viewport using the menu's real size once it's laid out.
    ctxEl.classList.remove('hidden')
    const rect = ctxEl.getBoundingClientRect()
    ctxEl.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`
    ctxEl.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`
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

  // --- Department filter ---------------------------------------------------
  const deptButtons = root.querySelectorAll<HTMLElement>('#deptList [data-dept]')
  let activeDept: string | null = null
  const clearDeptUI = (): void => {
    activeDept = null
    deptButtons.forEach((el) => el.classList.remove('bg-sky-100', 'dark:bg-sky-900/40'))
  }
  const setDept = (bucket: string | null): void => {
    activeDept = bucket
    view.setDepartmentFilter(bucket)
    clearHighlightUI()
    deptButtons.forEach((el) => {
      const on = (el.dataset.dept || null) === bucket
      el.classList.toggle('bg-sky-100', on)
      el.classList.toggle('dark:bg-sky-900/40', on)
    })
    // Drilling into one department is clearest with the coloured boxes on.
    if (bucket && layoutSel.value !== 'department') {
      layoutSel.value = 'department'
      view.setLayout('department')
    }
  }
  deptButtons.forEach((b) => {
    b.addEventListener('click', () => {
      const raw = b.dataset.dept ?? ''
      const bucket = raw === '' ? null : raw
      setDept(bucket === activeDept ? null : bucket)
    })
  })

  // --- Collapsible sidebar sections (expanded by default, remembered) ------
  const setupCollapse = (
    key: string,
    headerSel: string,
    bodySel: string,
    chevSel: string
  ): void => {
    const header = root.querySelector<HTMLButtonElement>(headerSel)
    const body = root.querySelector<HTMLElement>(bodySel)
    const chev = root.querySelector<HTMLElement>(chevSel)
    if (!header || !body) return
    let collapsed = localStorage.getItem(key) === '1'
    const apply = (): void => {
      body.classList.toggle('hidden', collapsed)
      if (chev) chev.textContent = collapsed ? '▸' : '▾'
    }
    apply()
    header.addEventListener('click', () => {
      collapsed = !collapsed
      localStorage.setItem(key, collapsed ? '1' : '0')
      apply()
    })
  }
  setupCollapse('3cx-spy.collapse.categories', '#catHeader', '#catBody', '#catChevron')
  setupCollapse('3cx-spy.collapse.departments', '#deptHeader', '#deptBody', '#deptChevron')

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
    menuEl.append(item('🩺', 'Health check', showAuditPanel))
    menuEl.append(item('🗂', 'DID table', showDidTable))
    menuEl.append(item('🖼', 'Export PNG', () => exportPng(view, theme, host)))
    menuEl.append(item('💾', 'Save snapshot', saveSnapshot))
    menuEl.append(item('📂', 'Open snapshot', cb.onOpenSnapshot))
    menuEl.append(item('↻', 'Reload', cb.onReload))
    menuEl.append(item('⬆', 'Check for updates', () => checkForUpdates()))
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
      <div class="shrink-0 flex items-center justify-between px-3 py-2 border-b border-slate-200 dark:border-slate-700">
        <h3 class="font-semibold text-slate-700 dark:text-slate-200">${esc(title)}</h3>
        <button id="closePanel" class="text-slate-400 hover:text-slate-700 dark:hover:text-slate-100">✕</button>
      </div>
      <ul class="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-1 text-slate-600 dark:text-slate-300">${items.map((i) => `<li>• ${esc(i)}</li>`).join('')}</ul>`
    panel.classList.remove('hidden')
    panel
      .querySelector('#closePanel')!
      .addEventListener('click', () => panel.classList.add('hidden'))
  }
  root.querySelector('#warn')?.addEventListener('click', () => showPanel('Fetch warnings', errors))
  root
    .querySelector('#unresolved')
    ?.addEventListener('click', () => showPanel('Unresolved routes', graph.warnings))

  // Shared shell for the richer panels below (health check, DID table, trace).
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]))
  const panelShell = (title: string, bodyHtml: string, actionsHtml = ''): void => {
    panel.innerHTML = `
      <div class="shrink-0 flex items-center justify-between gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-700">
        <h3 class="font-semibold text-slate-700 dark:text-slate-200 truncate">${esc(title)}</h3>
        <div class="flex items-center gap-2 shrink-0">${actionsHtml}<button id="closePanel" class="text-slate-400 hover:text-slate-700 dark:hover:text-slate-100">✕</button></div>
      </div>
      <div class="flex-1 min-h-0 overflow-y-auto px-3 py-2">${bodyHtml}</div>`
    panel.classList.remove('hidden')
    panel
      .querySelector('#closePanel')!
      .addEventListener('click', () => panel.classList.add('hidden'))
  }
  const wireNav = (): void => {
    panel.querySelectorAll<HTMLElement>('[data-nav]').forEach((el) => {
      el.addEventListener('click', () => navigate(el.dataset.nav!, true))
    })
  }

  // --- Health check -------------------------------------------------------
  const showAuditPanel = (): void => {
    const findings = auditTopology(graph)
    if (!findings.length) {
      panelShell(
        'Health check',
        `<p class="text-slate-500 dark:text-slate-400">No issues found. 🎉</p>`
      )
      return
    }
    const body = groupFindings(findings)
      .map((g) => {
        const rows = g.items
          .map((f) => {
            const dot = f.severity === 'warn' ? 'bg-amber-500' : 'bg-slate-400'
            const clickable = f.nodeId
              ? `data-nav="${esc(f.nodeId)}" class="cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800"`
              : ''
            return `<li ${clickable}><div class="flex items-center gap-2 px-1.5 py-0.5 rounded"><span class="w-1.5 h-1.5 rounded-full shrink-0 ${dot}"></span><span class="flex-1 break-words">${esc(f.label)}</span></div></li>`
          })
          .join('')
        return `<div class="mb-2"><h4 class="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-0.5">${esc(g.category)} <span class="text-slate-400">(${g.items.length})</span></h4><ul class="space-y-0.5 text-slate-600 dark:text-slate-300">${rows}</ul></div>`
      })
      .join('')
    panelShell(`Health check — ${findings.length} finding${findings.length === 1 ? '' : 's'}`, body)
    wireNav()
  }

  // --- DID routing table --------------------------------------------------
  const showDidTable = (): void => {
    const rows: DidRow[] = graph.nodes
      .filter((n) => n.kind === 'inboundRule')
      .map((r) => ({
        id: r.id,
        did: r.number ?? '',
        name: r.label,
        dests: graph.edges
          .filter((e) => e.source === r.id)
          .map((e) => {
            const t = nodeById.get(e.target)
            return t ? (t.number ? `${t.label} (${t.number})` : t.label) : e.target
          })
      }))
      .sort((a, b) => a.did.localeCompare(b.did))
    const bodyRows = rows
      .map(
        (r) => `
        <tr class="border-t border-slate-100 dark:border-slate-700/50 align-top">
          <td class="py-1 pr-2 font-mono whitespace-nowrap">${esc(r.did || '—')}</td>
          <td class="py-1 pr-2"><button data-nav="${esc(r.id)}" class="text-left text-sky-600 dark:text-sky-400 hover:underline">${esc(r.name)}</button></td>
          <td class="py-1">${r.dests.length ? esc(r.dests.join(', ')) : '<span class="text-amber-500">nowhere</span>'}</td>
        </tr>`
      )
      .join('')
    const body = `<div class="overflow-x-auto"><table class="w-full text-[11px]"><thead><tr class="text-left text-slate-400"><th class="pr-2 font-medium">DID</th><th class="pr-2 font-medium">Rule</th><th class="font-medium">Routes to</th></tr></thead><tbody>${bodyRows || '<tr><td colspan="3" class="py-2 text-slate-400">No inbound rules.</td></tr>'}</tbody></table></div>`
    const actions = rows.length
      ? `<button id="didCsv" class="px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-100 text-[11px]">Export CSV</button>`
      : ''
    panelShell(`DID routing — ${rows.length}`, body, actions)
    wireNav()
    panel.querySelector('#didCsv')?.addEventListener('click', () => exportDidCsv(rows, host))
  }

  // --- Trace-a-call -------------------------------------------------------
  const showTracePanel = (node: GraphNode): void => {
    const terminals = view.traceDownstream(node.id)
    const body = terminals.length
      ? `<p class="text-slate-500 dark:text-slate-400 mb-1.5">A call entering <span class="font-medium text-slate-700 dark:text-slate-200">${esc(node.label)}</span> can end at ${terminals.length} destination${terminals.length === 1 ? '' : 's'} (highlighted on the graph):</p>
         <ul class="space-y-0.5 text-slate-600 dark:text-slate-300">${terminals
           .map(
             (t) =>
               `<li data-nav="${esc(t.id)}" class="flex items-center gap-2 px-1.5 py-0.5 rounded cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800"><span class="w-2 h-2 rounded-full shrink-0" style="background:${NODE_KIND_META[t.kind].color}"></span><span class="flex-1 truncate">${esc(t.label)}${t.number ? ` <span class="text-slate-400 font-mono">${esc(t.number)}</span>` : ''}</span></li>`
           )
           .join('')}</ul>`
      : `<p class="text-slate-500 dark:text-slate-400">No downstream destinations — this node doesn't route anywhere (or only loops back).</p>`
    panelShell(`Call trace — ${node.label}`, body)
    wireNav()
  }

  // --- Snapshot save ------------------------------------------------------
  const saveSnapshot = async (): Promise<void> => {
    const res = await window.api.app.saveSnapshot(topology)
    if (res.error) flash(res.error, true)
    else if (res.path) flash('Snapshot saved.')
  }
}

/** A brief transient toast at the bottom of the window (save confirmations, …). */
function flash(message: string, isError = false): void {
  const el = document.createElement('div')
  el.className = `fixed bottom-4 left-1/2 -translate-x-1/2 z-[100] px-3 py-1.5 rounded-md text-sm shadow-lg ${
    isError ? 'bg-red-600 text-white' : 'bg-slate-800 text-slate-100 dark:bg-slate-700'
  }`
  el.textContent = message
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 2500)
}

function exportDidCsv(rows: DidRow[], host: string): void {
  const cell = (s: string): string => {
    // Guard against CSV formula injection: a value a spreadsheet would treat as
    // a formula (=, +, -, @, tab, CR) gets a leading apostrophe. 3CX display
    // names are attacker-influenceable data in an audit context.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
    return `"${safe.replace(/"/g, '""')}"`
  }
  const lines = [
    'DID,Rule,Routes to',
    ...rows.map((r) => [cell(r.did), cell(r.name), cell(r.dests.join('; '))].join(','))
  ]
  // Prepend a BOM so Excel reads UTF-8 correctly.
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `espionage-dids-${host.replace(/[^\w.-]/g, '_')}.csv`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
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
