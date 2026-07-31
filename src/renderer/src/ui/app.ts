// The connected-state UI: toolbar (search, layout, focus, zoom, theme, PNG),
// category legend/filter, the graph canvas, overview minimap, context menu and
// the details panel (with an ego mini-map). Owns the GraphView and view state.

import type { Topology } from '../../../shared/types'
import { buildTopology } from '../graph/build'
import {
  GraphView,
  type EdgeTapInfo,
  type LayoutName,
  type NodeMove,
  type ThemeName
} from '../graph/view'
import {
  EDGE_KIND_META,
  NODE_KIND_META,
  PRESENCE_META,
  SHARED_DEPARTMENT,
  departmentColor,
  departmentLabel,
  presenceOf,
  queueLoginState,
  type EdgeKind,
  type GraphNode,
  type NodeKind
} from '../graph/model'
import { renderDepartmentDetails, renderDetails, renderEdgeDetails } from './details'
import { EgoMap } from './egomap'
import { Minimap } from './minimap'
import { checkForUpdates } from './updates'
import { auditTopology, groupFindings } from '../graph/audit'
import { UndoManager } from './history'
import {
  openReport,
  readHomeCountry,
  showLiveReport,
  showReportSetup,
  writeHomeCountry
} from './report'
import { showZoneSettings } from './zones'
import { panelHeader } from './panel-chrome'
import { showPalette, type PaletteCommand } from './palette'
import { changedNodeIds, diffTopologies, type ChangeKind } from '../graph/diff'
import {
  loadEdgeOptions,
  readSnapshotDir,
  saveEdgeOptions,
  showSettings,
  type EdgeOptions
} from './settings'

export interface AppCallbacks {
  /** Hard refresh: re-fetch and rebuild from scratch (back to the full view). */
  onReload: () => void
  onDisconnect: () => void
  onOpenSnapshot: () => void
  /** Soft refresh: re-fetch, then rebuild preserving the captured view state. */
  onRefresh: (state: ViewState) => Promise<void>
}

/** A snapshot of the user-facing view, restored after a soft refresh so the
 *  refetch doesn't throw away focus / layout / filters / camera. */
export interface ViewState {
  layout: LayoutName
  visibleKinds: NodeKind[]
  focusId?: string
  deptFilter?: string
  selectedId?: string
  history?: string[]
  zoom?: number
  pan?: { x: number; y: number }
  locked?: boolean
}

interface DidRow {
  id: string
  did: string
  name: string
  dests: string[]
}

/** Pixel sizes of the resizable chrome, persisted between launches. */
interface LayoutSizes {
  left: number
  right: number
  miniW: number
  miniH: number
  leftHidden: boolean
  rightHidden: boolean
}

function clampSize(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback
}

const esc = (s: unknown): string =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )

const THEME_KEY = '3cx-spy.theme'
// Theme-aware so the header and side panels follow light/dark mode.
const btn =
  'px-2 py-1 rounded text-xs bg-slate-200 hover:bg-slate-300 text-slate-700 dark:bg-slate-700 dark:hover:bg-slate-600 dark:text-slate-100'

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
  initialFocusId?: string,
  restore?: ViewState
): void {
  cleanup.forEach((fn) => fn())
  cleanup = []

  const graph = buildTopology(topology)
  const counts = countKinds(graph.nodes.map((n) => n.kind))
  const presentKinds = (Object.keys(NODE_KIND_META) as NodeKind[]).filter((k) => counts[k])
  // Core 3CX categories always shown in the legend — even at zero, greyed out —
  // so an absent category (e.g. no queues) is explicit rather than just missing.
  const ALWAYS_SHOW_KINDS: NodeKind[] = [
    'user',
    'queue',
    'ringGroup',
    'ivr',
    'inboundRule',
    'trunk',
    'group'
  ]
  // Everything to list: core categories + any synthetic kind that's actually present.
  const displayKinds = (Object.keys(NODE_KIND_META) as NodeKind[]).filter(
    (k) => ALWAYS_SHOW_KINDS.includes(k) || counts[k]
  )
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
      <!-- Three equal-flanked columns so the search box sits dead centre on
           screen regardless of how wide the host name or the button group is. -->
      <header class="grid grid-cols-[1fr_auto_1fr] items-center gap-2 px-3 bg-white border-b border-slate-200 text-slate-800 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-100">
        <div class="flex items-center min-w-0">
          <span class="text-xs text-slate-500 dark:text-slate-400 font-mono truncate max-w-[240px]">${esc(host)}</span>
        </div>

        <div class="relative justify-self-center w-[26rem] max-w-[42vw]">
          <span class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none">⌕</span>
          <input id="search" type="text" placeholder="Search…  ·  Ctrl+K for command palette" title="Search (Ctrl+F) · Ctrl+K opens the command palette"
            class="w-full pl-8 pr-3 py-1.5 rounded-lg bg-slate-50 border-2 border-slate-300 text-slate-800 placeholder:text-slate-400 dark:bg-slate-800 dark:border-slate-500 dark:text-slate-100 dark:placeholder:text-slate-400 text-[15px] focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500" />
          <div id="results" class="hidden absolute z-30 mt-1 w-full bg-white text-slate-800 dark:bg-slate-800 dark:text-slate-100 rounded-md shadow-lg border border-slate-200 dark:border-slate-700 max-h-72 overflow-y-auto"></div>
        </div>

        <div class="flex items-center justify-end gap-1.5 text-sm min-w-0">
          <label class="flex items-center gap-1.5 shrink-0 mr-1">
            <span class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">View Mode</span>
            <select id="layout" title="View Mode — how the graph is arranged" class="${btn} appearance-none pr-2">
              <option value="flow">Flow</option>
              <option value="compact">Compact</option>
              <option value="force">Spread</option>
              <option value="department">Department</option>
            </select>
          </label>
          ${errors.length ? `<button id="warn" class="px-2 py-1 rounded bg-amber-500/90 hover:bg-amber-500 text-white text-xs">${errors.length}⚠</button>` : ''}
          ${graph.warnings.length ? `<button id="unresolved" class="px-2 py-1 rounded bg-red-600/90 hover:bg-red-600 text-white text-xs">${graph.warnings.length} unresolved</button>` : ''}
          <button id="refresh" class="${btn} w-7" title="Soft refresh — update but preserve view (Ctrl+R)" aria-label="Soft refresh"><span id="refreshIcon" class="inline-block">↻</span></button>
          <button id="help" class="${btn} w-7" title="Help" aria-label="Help">?</button>
          <div class="relative">
            <button id="menuBtn" class="${btn}" title="Menu" aria-label="Menu">☰</button>
            <div id="menu" class="hidden absolute right-0 top-full mt-1 z-40 min-w-[264px] py-1 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-md shadow-xl border border-slate-200 dark:border-slate-700"></div>
          </div>
        </div>
      </header>

      <div id="body" class="grid grid-cols-[12rem_1fr_20rem] min-h-0">
        <aside id="leftPanel" class="relative min-h-0 flex flex-col bg-white border-r border-slate-200 dark:bg-slate-900 dark:border-slate-800 overflow-hidden">
          <!-- Drag the inner edge to resize; double-click it to collapse. -->
          <div id="leftResize" title="Drag to resize · double-click to collapse" class="absolute top-0 right-0 bottom-0 w-1.5 z-20 cursor-col-resize hover:bg-sky-500/40"></div>
          ${panelHeader({ title: 'Navigation', side: 'left', hideId: 'hideLeft' })}
          <div class="flex-1 overflow-y-auto p-3">
            <button id="catHeader" type="button" class="w-full flex items-center justify-between mb-2">
              <span class="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Categories</span>
              <span id="catChevron" class="text-slate-400 text-[10px] leading-none">▾</span>
            </button>
            <div id="catBody">
            <p class="text-[10px] text-slate-400 mb-1.5">Checkbox shows/hides · click a name to highlight it</p>
            <ul id="legend" class="space-y-0.5">
              ${displayKinds
                .map((k) => {
                  const empty = !counts[k]
                  // Empty core categories render greyed + disabled so it's explicit
                  // there are none, rather than the row simply being absent.
                  if (empty) {
                    return `
                <li class="flex items-center gap-2 text-xs opacity-50" title="No ${esc(NODE_KIND_META[k].label.toLowerCase())} on this system">
                  <input type="checkbox" disabled class="accent-sky-500" />
                  <span class="flex-1 flex items-center gap-2 px-1 py-0.5">
                    <span class="w-3 h-3 rounded" style="background:${NODE_KIND_META[k].color}"></span>
                    <span class="flex-1">${esc(NODE_KIND_META[k].label)}</span>
                    <span class="text-slate-400">0</span>
                  </span>
                </li>`
                  }
                  return `
                <li class="flex items-center gap-2 text-xs">
                  <input type="checkbox" data-kind="${k}" ${visible.has(k) ? 'checked' : ''} class="accent-sky-500" />
                  <button data-hl="${k}" class="flex-1 flex items-center gap-2 text-left rounded px-1 py-0.5 hover:bg-slate-100 dark:hover:bg-slate-800">
                    <span class="w-3 h-3 rounded" style="background:${NODE_KIND_META[k].color}"></span>
                    <span class="flex-1">${esc(NODE_KIND_META[k].label)}</span>
                    <span class="text-slate-400">${counts[k]}</span>
                  </button>
                </li>`
                })
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
            <div id="focusDepthRow" class="opacity-50" title="When focused on a node, how many hops out stay visible">
              <div class="flex items-center justify-between text-xs mb-0.5">
                <span class="text-slate-500 dark:text-slate-400">Focus Reach</span>
                <span id="focusDepthVal" class="text-slate-400 tabular-nums">Neighbours</span>
              </div>
              <div class="flex items-center gap-1">
                <button id="depthOut" class="${btn} w-7" title="Show fewer hops">−</button>
                <input id="focusDepth" type="range" min="1" max="6" value="1" class="flex-1 min-w-0 accent-sky-500" />
                <button id="depthIn" class="${btn} w-7" title="Show more hops">+</button>
              </div>
            </div>
            <div>
              <div class="text-xs text-slate-500 dark:text-slate-400 mb-0.5">Zoom Level</div>
              <div class="flex items-center gap-1">
                <button id="zoomOut" class="${btn} w-7" title="Zoom out">−</button>
                <input id="zoom" type="range" min="0" max="1000" value="500" class="flex-1 min-w-0 accent-sky-500" title="Zoom Level" />
                <button id="zoomIn" class="${btn} w-7" title="Zoom in">+</button>
              </div>
            </div>
            <div class="flex items-center gap-1">
              <button id="fit" class="${btn} flex-1" title="Fit to screen">⤢ Fit</button>
              <button id="lock" class="${btn} flex-1" title="Locked stops nodes being dragged (they stay clickable). Unlock to reposition them. Toggle with Space.">🔒 Locked</button>
            </div>
          </div>
        </aside>

        <main class="relative min-h-0 min-w-0 bg-slate-100 dark:bg-slate-950">
          <div id="graph" class="w-full h-full"></div>
          <!-- Both reopen buttons sit at the top, level with the Hide buttons
               they undo. The right one shares a flex row with the breadcrumb so
               the two can never overlap. -->
          <button id="reopenLeft" class="hidden absolute top-3 left-3 z-20 px-2 py-1 rounded bg-slate-700 text-slate-100 text-xs shadow" title="Show the navigation panel">‹ Navigation</button>
          <div class="absolute top-3 right-3 z-20 flex items-start gap-2 max-w-[70%]">
            <div id="breadcrumb" class="flex items-center flex-wrap justify-end gap-x-0.5 px-2.5 py-1 rounded-md bg-white/90 dark:bg-slate-800/90 border border-slate-200 dark:border-slate-700 shadow text-xs text-slate-600 dark:text-slate-300"></div>
            <button id="reopen" class="hidden shrink-0 px-2 py-1 rounded bg-slate-700 text-slate-100 text-xs shadow" title="Show the details panel">Details ›</button>
          </div>
          <div id="minimapWrap" class="group absolute bottom-3 left-3 z-20 w-52 h-36 pointer-events-none">
            <div id="minimap" class="relative w-full h-full rounded-md border border-slate-300 dark:border-slate-700 bg-white/80 dark:bg-slate-900/80 shadow overflow-hidden cursor-pointer pointer-events-auto"></div>
            <button id="mapToggle" class="absolute bottom-1 left-1 z-30 w-5 h-5 flex items-center justify-center rounded bg-slate-700/90 hover:bg-slate-600 text-slate-100 text-[10px] leading-none shadow pointer-events-auto" title="Collapse minimap" aria-label="Collapse minimap">▾</button>
            <!-- Anchored bottom-left, so the top-right corner is the grow handle.
                 Invisible until the minimap is hovered, so it isn't permanent clutter. -->
            <div id="miniResize" title="Drag to resize the minimap" class="absolute -top-1 -right-1 w-3.5 h-3.5 z-30 cursor-nesw-resize rounded-sm bg-transparent group-hover:bg-sky-500/70 transition-colors pointer-events-auto"></div>
          </div>
          <div id="panel" class="hidden absolute z-20 inset-x-4 bottom-4 max-h-[40%] bg-white dark:bg-slate-800 dark:text-slate-200 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700 flex flex-col overflow-hidden text-xs"></div>
        </main>

        <!-- The handle is a sibling of #details because renderDetails replaces
             that element's innerHTML on every selection. -->
        <aside id="detailsPanel" class="relative min-h-0 bg-white border-l border-slate-200 overflow-hidden dark:bg-slate-900 dark:border-slate-800">
          <div id="rightResize" title="Drag to resize · double-click to collapse" class="absolute top-0 left-0 bottom-0 w-1.5 z-20 cursor-col-resize hover:bg-sky-500/40"></div>
          <div id="details" class="h-full min-h-0 overflow-hidden"></div>
        </aside>
      </div>

      <div id="ctxmenu" class="hidden fixed z-50 w-max py-1 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-md shadow-xl border border-slate-200 dark:border-slate-700 text-sm"></div>

      <div id="helpModal" class="hidden fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
        <div class="w-[460px] max-w-full max-h-[88vh] overflow-y-auto bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-lg shadow-2xl border border-slate-200 dark:border-slate-700 p-4">
          <div class="flex items-center justify-between mb-3">
            <h2 class="font-semibold text-slate-800 dark:text-slate-100">Controls</h2>
            <button id="helpClose" class="text-slate-400 hover:text-slate-700 dark:hover:text-slate-100 text-lg leading-none">✕</button>
          </div>
          <div class="grid grid-cols-[2rem_1fr] gap-x-3 gap-y-3 items-center text-sm">
            ${helpRow(mouseSvg('left'), 'Click', 'details')}
            ${helpRow(mouseSvg('left'), 'Click a link', 'split it into its routes')}
            ${helpRow(mouseSvg('left', '×2'), 'Double-click', 'focus')}
            ${helpRow(mouseSvg('right'), 'Right-click', 'actions (incl. Hide)')}
            ${helpRow(mouseSvg('right'), 'Right-drag', 'select group → move together')}
            ${helpRow(mouseSvg('wheel'), 'Scroll', 'zoom (Ctrl = faster)')}
            ${helpRow(dragSvg(), 'Drag', 'pan / move node')}
            ${helpRow(keyCap('space'), 'Space / 🔒', 'lock / unlock node dragging')}
            ${helpRow(keyCap('⌃Z'), 'Ctrl+Z', 'undo move / jump back')}
            ${helpRow(keyCap('⌃Y'), 'Ctrl+Y', 'redo')}
            ${helpRow(mouseSvg('right'), 'Right-click bg', 'undo / redo menu')}
          </div>
          <h2 class="font-semibold text-slate-800 dark:text-slate-100 mt-4 mb-2">Keyboard shortcuts</h2>
          <p class="text-xs text-slate-500 dark:text-slate-400 mb-2">
            <kbd class="px-1 py-0.5 rounded border border-current text-[9px]">Ctrl+K</kbd>
            opens the command palette — every action below, searchable, plus jump-to-node.
          </p>
          <div id="shortcutList" class="grid grid-cols-2 gap-x-4 gap-y-1 text-xs"></div>
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
  /** Department currently selected in the details panel (highlighted, but not
   *  necessarily filtered). Lets Focus Reach act on it — see applyDepth. */
  let selectedDept: string | null = null
  /** Re-render hook for a bottom panel whose contents can be invalidated by
   *  actions taken while it's open (the hidden-nodes list). Null when no such
   *  panel is showing. */
  let openPanelRefresh: (() => void) | null = null
  let egoMap: EgoMap | null = null
  // Unified undo/redo timeline for node moves + navigation jumps.
  const undo = new UndoManager()
  // The last node viewed before clicking "All" — kept so we can hop straight
  // back to it even though the breadcrumb history was cleared.
  let lastNodeBeforeAll: string | null = null

  // Number → display name, used to label reports. Covers every numbered node
  // (extensions, queues, IVRs, ring groups, rules…), with real user extensions
  // winning any collision so a person's name is preferred.
  const extNames = new Map<string, string>()
  for (const n of graph.nodes) {
    if (!n.number) continue
    if (n.kind === 'user' || !extNames.has(n.number)) extNames.set(n.number, n.label)
  }
  const nameFor = (ext: string): string | undefined => extNames.get(ext)

  // Number → department, so reports can group by department (multi-tenant systems
  // separate customers this way). Uses each node's resolved bucket; a real user
  // extension wins collisions. The catch-all "Shared" bucket isn't a real
  // department, so it's skipped.
  const extDepts = new Map<string, string>()
  for (const n of graph.nodes) {
    if (!n.number) continue
    const bucket = n.deptGroup && n.deptGroup !== SHARED_DEPARTMENT ? n.deptGroup : n.departments?.[0]
    if (!bucket || bucket === SHARED_DEPARTMENT) continue
    if (n.kind === 'user' || !extDepts.has(n.number)) extDepts.set(n.number, departmentLabel(bucket))
  }
  const deptFor = (ext: string): string | undefined => extDepts.get(ext)

  const showDetails = (node: GraphNode | null): void => {
    current = node
    selectedDept = null
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

  // Tapping a department box selects the whole department: spotlight its members
  // and show what it contains / how it's reached.
  const showDepartmentDetails = (bucket: string): void => {
    current = null
    selectedDept = bucket
    egoMap?.destroy()
    egoMap = null
    if (sizes.rightHidden) toggleDetails(true)
    renderDepartmentDetails(detailsEl, bucket, view.departmentMembers(bucket), {
      graph,
      canGoBack: history.length > 1,
      onNavigate: (id) => navigate(id, true),
      onBack: goBack,
      onHide: () => toggleDetails(false)
    })
  }

  // Tapping a link shows its info in the same details panel as nodes.
  const showEdgeDetails = (info: EdgeTapInfo): void => {
    current = null
    egoMap?.destroy()
    egoMap = null
    if (sizes.rightHidden) toggleDetails(true)
    renderEdgeDetails(detailsEl, info, {
      graph,
      canGoBack: history.length > 1,
      onNavigate: (id) => navigate(id, true),
      onBack: goBack,
      onHide: () => toggleDetails(false)
    })
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
    if (sizes.rightHidden) toggleDetails(true)
    showDetails(node)
    renderBreadcrumb()
    syncFocusDepthRow()
  }

  // Single-click / navigation: details + pan, keeping the current focus (unless
  // the target isn't visible, handled by showNode).
  const navigate = (id: string, push: boolean): void => {
    if (!graph.nodes.some((n) => n.id === id)) return
    undo.push({ type: 'nav', from: current?.id ?? null, to: id })
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
    undo.push({ type: 'nav', from: current?.id ?? null, to: id })
    if (history[history.length - 1] !== id) history.push(id)
    showNode(id, { focus: true })
  }

  // Apply an undo/redo entry: reverse a node move, or hop to a node (null = the
  // "All" whole-graph view). Recording is suppressed while applying.
  const goTo = (id: string | null): void =>
    undo.run(() => {
      if (id === null) {
        history.length = 0
        view.clearFocus()
        clearDeptUI()
        showDetails(null)
        renderBreadcrumb()
        syncFocusDepthRow()
      } else if (graph.nodes.some((n) => n.id === id)) {
        if (history[history.length - 1] !== id) history.push(id)
        showNode(id)
      }
    })
  /** Apply a hide/restore timeline entry. `hide` is the direction to move in:
   *  true re-hides the recorded elements, false restores them. */
  const applyHide = (
    entry: { nodeIds: string[]; edgeIds: string[]; edgeKinds: string[] },
    hide: boolean
  ): void =>
    undo.run(() => {
      if (hide) {
        for (const id of entry.nodeIds) view.hideNode(id)
        for (const id of entry.edgeIds) view.hideEdge(id)
        for (const kind of entry.edgeKinds) view.hideEdgeKind(kind)
      } else {
        view.unhideNodes(entry.nodeIds)
        view.unhideEdges(entry.edgeIds)
        if (entry.edgeKinds.length) {
          const remaining = view.getHiddenEdgeKinds().filter((k) => !entry.edgeKinds.includes(k))
          view.setHiddenEdgeKinds(remaining)
        }
      }
      if (entry.edgeKinds.length) syncEdgeOptionsFromView()
      openPanelRefresh?.() // an undone/redone hide changes the hidden-nodes list
      syncFocusDepthRow()
    })

  const doUndo = (): void => {
    const entry = undo.undo()
    if (!entry) return
    if (entry.type === 'move') view.applyPositions(entry.moves, 'from')
    else if (entry.type === 'hide') applyHide(entry, !entry.hidden)
    else goTo(entry.from)
  }
  const doRedo = (): void => {
    const entry = undo.redo()
    if (!entry) return
    if (entry.type === 'move') view.applyPositions(entry.moves, 'to')
    else if (entry.type === 'hide') applyHide(entry, entry.hidden)
    else goTo(entry.to)
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
    let html = parts.join(sep)
    // In the "All" view, offer a one-click hop back to the last node we left.
    if (!history.length && lastNodeBeforeAll) {
      const n = graph.nodes.find((x) => x.id === lastNodeBeforeAll)
      if (n)
        html += `<button data-crumb="return" class="ml-2 px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-600 dark:text-slate-200" title="Back to last node">↩ ${esc(n.number ?? n.label)}</button>`
    }
    breadcrumbEl.innerHTML = html
    breadcrumbEl.querySelectorAll<HTMLElement>('[data-crumb]').forEach((b) => {
      b.addEventListener('click', () => {
        const v = b.dataset.crumb!
        if (v === 'all') {
          // Silently remember where we were so we can return quickly.
          const prev = history[history.length - 1] ?? current?.id ?? null
          if (prev) {
            lastNodeBeforeAll = prev
            undo.push({ type: 'nav', from: prev, to: null })
          }
          history.length = 0
          view.clearFocus()
          clearDeptUI()
          showDetails(null)
          renderBreadcrumb()
          syncFocusDepthRow()
        } else if (v === 'return' && lastNodeBeforeAll) {
          navigate(lastNodeBeforeAll, true)
        } else {
          const i = Number(v)
          history.length = i + 1
          showNode(history[i])
        }
      })
    })
  }

  // --- Panel / minimap layout (resizable, hideable, persisted) -------------
  // Sizes are in px so a drag maps 1:1 to the pointer. `sizes` is the live
  // layout; LAYOUT_DEFAULT_KEY holds the user's own "default" (Settings → Set
  // current as default), falling back to BUILTIN_SIZES.
  const LAYOUT_KEY = '3cx-spy.layout'
  const LAYOUT_DEFAULT_KEY = '3cx-spy.layout.default'
  const BUILTIN_SIZES: LayoutSizes = {
    left: 192,
    right: 320,
    miniW: 208,
    miniH: 144,
    leftHidden: false,
    rightHidden: false
  }
  const readSizes = (key: string): LayoutSizes | null => {
    try {
      const raw = localStorage.getItem(key)
      if (!raw) return null
      const s = JSON.parse(raw) as Partial<LayoutSizes>
      return {
        left: clampSize(s.left, 120, 480, BUILTIN_SIZES.left),
        right: clampSize(s.right, 200, 640, BUILTIN_SIZES.right),
        miniW: clampSize(s.miniW, 120, 640, BUILTIN_SIZES.miniW),
        miniH: clampSize(s.miniH, 90, 520, BUILTIN_SIZES.miniH),
        leftHidden: !!s.leftHidden,
        rightHidden: !!s.rightHidden
      }
    } catch {
      return null
    }
  }
  const sizes: LayoutSizes = readSizes(LAYOUT_KEY) ??
    readSizes(LAYOUT_DEFAULT_KEY) ?? { ...BUILTIN_SIZES }

  const leftPanelEl = root.querySelector<HTMLElement>('#leftPanel')!
  const detailsPanelEl = root.querySelector<HTMLElement>('#detailsPanel')!
  const leftResizeEl = root.querySelector<HTMLElement>('#leftResize')!
  const rightResizeEl = root.querySelector<HTMLElement>('#rightResize')!
  const reopenLeftBtn = root.querySelector<HTMLButtonElement>('#reopenLeft')!
  const minimapWrapEl = root.querySelector<HTMLElement>('#minimapWrap')!

  const persistSizes = (): void => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(sizes))
    } catch {
      /* storage unavailable — non-fatal */
    }
  }

  // Minimap collapse is a separate, transient toggle (not a persisted size).
  let minimapCollapsed = false
  // Width of the left column as last applied. Cytoscape's pan is relative to its
  // container, so when the LEFT edge moves the graph appears to slide with it —
  // we cancel that out below. (Collapsing the right panel only extends the
  // container rightwards, so the origin doesn't move and nothing shifts.)
  let appliedLeftWidth = sizes.leftHidden ? 0 : sizes.left

  /** Push `sizes` into the DOM. `resizeCanvas` is skipped mid-drag for the
   *  minimap (which doesn't affect the graph canvas at all). */
  const applyLayout = (resizeCanvas = true): void => {
    bodyEl.style.gridTemplateColumns = `${sizes.leftHidden ? 0 : sizes.left}px 1fr ${
      sizes.rightHidden ? 0 : sizes.right
    }px`
    // NEVER display:none a grid child here. Doing so takes it out of grid
    // auto-placement, so the remaining panels slide into the wrong columns — the
    // graph collapsed into the 0-width column while the details panel stretched
    // across the whole window. Collapsing is done purely by zeroing the column
    // width; the panels already clip their content with overflow-hidden.
    leftPanelEl.classList.toggle('border-r', !sizes.leftHidden)
    detailsPanelEl.classList.toggle('border-l', !sizes.rightHidden)
    // A collapsed panel's drag handle would otherwise sit on the canvas edge.
    leftResizeEl.classList.toggle('hidden', sizes.leftHidden)
    rightResizeEl.classList.toggle('hidden', sizes.rightHidden)
    reopenLeftBtn.classList.toggle('hidden', !sizes.leftHidden)
    reopenBtn.classList.toggle('hidden', !sizes.rightHidden)
    minimapWrapEl.style.width = `${sizes.miniW}px`
    minimapWrapEl.style.height = minimapCollapsed ? '20px' : `${sizes.miniH}px`
    // Resize the canvas to the new width WITHOUT refitting (keeps zoom/pan), then
    // undo the sideways shift caused by the canvas's left edge moving.
    const effectiveLeft = sizes.leftHidden ? 0 : sizes.left
    const leftDelta = effectiveLeft - appliedLeftWidth
    appliedLeftWidth = effectiveLeft
    if (resizeCanvas) {
      requestAnimationFrame(() => {
        view.resize()
        if (leftDelta) view.panBy(-leftDelta)
      })
    }
  }

  /** Collapse the minimap down to just its caret button. */
  const applyMinimapCollapse = (): void => {
    minimapEl.classList.toggle('hidden', minimapCollapsed)
    // The resize grip belongs to the map, so it goes with it.
    miniResizeEl.classList.toggle('hidden', minimapCollapsed)
    mapToggle.textContent = minimapCollapsed ? '▴' : '▾'
    mapToggle.title = minimapCollapsed ? 'Show minimap' : 'Collapse minimap'
    applyLayout(false)
    if (!minimapCollapsed) minimap.sync()
  }

  const toggleDetails = (show: boolean): void => {
    sizes.rightHidden = !show
    persistSizes()
    applyLayout()
  }
  const toggleLeftPanel = (show: boolean): void => {
    sizes.leftHidden = !show
    persistSizes()
    applyLayout()
  }

  /** Wire a vertical drag handle that resizes one of the side panels. */
  const wirePanelResize = (
    handleId: string,
    edge: 'left' | 'right',
    min: number,
    max: number
  ): void => {
    const handle = root.querySelector<HTMLElement>(handleId)
    if (!handle) return
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const startX = e.clientX
      const startW = edge === 'left' ? sizes.left : sizes.right
      const onMove = (ev: MouseEvent): void => {
        // The right panel grows leftwards, so its delta is inverted.
        const delta = edge === 'left' ? ev.clientX - startX : startX - ev.clientX
        const next = Math.min(max, Math.max(min, startW + delta))
        if (edge === 'left') sizes.left = next
        else sizes.right = next
        applyLayout()
      }
      const onUp = (): void => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        document.body.style.userSelect = ''
        persistSizes()
      }
      document.body.style.userSelect = 'none'
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    })
    // Double-clicking the handle collapses that panel — quicker than dragging it
    // all the way in, and it's the same target.
    handle.addEventListener('dblclick', () => {
      if (edge === 'left') toggleLeftPanel(false)
      else toggleDetails(false)
    })
  }
  wirePanelResize('#leftResize', 'left', 120, 480)
  wirePanelResize('#rightResize', 'right', 200, 640)

  // Minimap: anchored bottom-left, so dragging the top-right corner grows it.
  const miniResizeEl = root.querySelector<HTMLElement>('#miniResize')!
  miniResizeEl.addEventListener('mousedown', (e) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startY = e.clientY
    const startW = sizes.miniW
    const startH = sizes.miniH
    const onMove = (ev: MouseEvent): void => {
      sizes.miniW = Math.min(640, Math.max(120, startW + (ev.clientX - startX)))
      sizes.miniH = Math.min(520, Math.max(90, startH - (ev.clientY - startY)))
      applyLayout(false)
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
      persistSizes()
      minimap.sync() // re-fit the overview into its new box
    }
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  })

  reopenLeftBtn.addEventListener('click', () => toggleLeftPanel(true))
  root.querySelector('#hideLeft')!.addEventListener('click', () => toggleLeftPanel(false))

  // --- Context menu -------------------------------------------------------
  const hideCtx = (): void => ctxEl.classList.add('hidden')
  /** A separator row, shared by all three context menus. */
  const divider = (): HTMLElement => {
    const d = document.createElement('div')
    d.className = 'my-1 border-t border-slate-200 dark:border-slate-700'
    return d
  }
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
    ctxEl.innerHTML = ''
    ctxEl.append(item('🎯', 'Focus here', () => enterFocus(node.id)))
    ctxEl.append(item('🧭', 'Trace call flow', () => showTracePanel(node)))
    ctxEl.append(
      item('🚫', 'Hide', () => {
        // Hiding the node the view is focused on would leave the focus centred on
        // nothing, so drop back to the whole graph first.
        if (view.getFocusId() === node.id) {
          history.length = 0
          view.clearFocus()
          clearDeptUI()
          renderBreadcrumb()
          syncFocusDepthRow()
        }
        view.hideNode(node.id)
        undo.push({ type: 'hide', nodeIds: [node.id], edgeIds: [], edgeKinds: [], hidden: true })
        openPanelRefresh?.() // keep an open hidden-nodes list current
        // The details panel would otherwise still describe a node that's gone.
        if (current?.id === node.id) showDetails(null)
        flash('Node hidden — undo with Ctrl+Z.')
      })
    )
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
    // Undo / redo, always available from the menu (disabled when the stack is empty).
    ctxEl.append(divider())
    if (undo.canUndo()) ctxEl.append(item('↩', 'Undo', doUndo))
    else ctxEl.append(disabledItem('↩', 'Undo'))
    if (undo.canRedo()) ctxEl.append(item('↪', 'Redo', doRedo))
    else ctxEl.append(disabledItem('↪', 'Redo'))
    placeCtx(x, y)
  }

  // A greyed, non-interactive context-menu row (for unavailable undo/redo).
  const disabledItem = (icon: string, label: string): HTMLElement => {
    const d = document.createElement('div')
    d.className =
      'w-full text-left flex items-center gap-2 px-2.5 py-1 text-slate-300 dark:text-slate-600 whitespace-nowrap'
    d.innerHTML = `<span class="w-4 text-center shrink-0">${icon}</span><span>${esc(label)}</span>`
    return d
  }
  const placeCtx = (x: number, y: number): void => {
    ctxEl.classList.remove('hidden')
    const rect = ctxEl.getBoundingClientRect()
    ctxEl.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`
    ctxEl.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`
  }

  // Right-click a department's own space: act on the whole department.
  const showDeptCtx = (bucket: string, x: number, y: number): void => {
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
    const name = departmentLabel(bucket)
    ctxEl.innerHTML = ''
    ctxEl.append(item('🎯', `Focus on “${name}”`, () => setDept(bucket)))
    ctxEl.append(
      item('👁', 'Show department details', () => {
        view.highlightDepartment(bucket)
        showDepartmentDetails(bucket)
      })
    )
    ctxEl.append(divider())
    ctxEl.append(
      item('🚫', 'Hide this department', () => {
        const ids = view.hideDepartment(bucket)
        if (!ids.length) {
          flash('Nothing to hide in that department.')
          return
        }
        undo.push({ type: 'hide', nodeIds: ids, edgeIds: [], edgeKinds: [], hidden: true })
        openPanelRefresh?.()
        if (current && ids.includes(current.id)) showDetails(null)
        flash(`Hid ${ids.length} node${ids.length === 1 ? '' : 's'} — undo with Ctrl+Z.`)
      })
    )
    placeCtx(x, y)
  }

  // Right-click a link: hide just it, or every link of that type.
  const showEdgeCtx = (
    info: EdgeTapInfo & { edgeId: string },
    x: number,
    y: number
  ): void => {
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
    const kindLabel = EDGE_KIND_META[info.kind as EdgeKind]?.label ?? info.kind
    ctxEl.innerHTML = ''
    ctxEl.append(
      item('🚫', 'Hide this link', () => {
        view.hideEdge(info.edgeId)
        undo.push({ type: 'hide', nodeIds: [], edgeIds: [info.edgeId], edgeKinds: [], hidden: true })
        flash('Link hidden — undo with Ctrl+Z.')
      })
    )
    ctxEl.append(
      item('🚫', `Hide all “${kindLabel}” links`, () => {
        view.hideEdgeKind(info.kind)
        syncEdgeOptionsFromView()
        undo.push({ type: 'hide', nodeIds: [], edgeIds: [], edgeKinds: [info.kind], hidden: true })
        flash(`All ${kindLabel.toLowerCase()} links hidden — see Settings to restore.`)
      })
    )
    ctxEl.append(divider())
    ctxEl.append(item('⚙', 'Link settings…', () => openSettings()))
    placeCtx(x, y)
  }

  // Right-click on empty canvas: a compact Undo / Redo menu.
  const showBgCtx = (x: number, y: number): void => {
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
    ctxEl.innerHTML = ''
    if (undo.canUndo()) ctxEl.append(item('↩', 'Undo', doUndo))
    else ctxEl.append(disabledItem('↩', 'Undo'))
    if (undo.canRedo()) ctxEl.append(item('↪', 'Redo', doRedo))
    else ctxEl.append(disabledItem('↪', 'Redo'))
    // Only way back from "Hide", so it lives on the always-reachable menu.
    const hiddenNodes = view.hiddenCount()
    const hiddenEdges = view.hiddenEdgeCount()
    if (hiddenNodes || hiddenEdges) ctxEl.append(divider())
    if (hiddenNodes) {
      ctxEl.append(
        item('👁', `Unhide all nodes (${hiddenNodes})`, () => {
          const ids = view.hiddenNodeIds()
          view.unhideAll()
          undo.push({ type: 'hide', nodeIds: ids, edgeIds: [], edgeKinds: [], hidden: false })
          openPanelRefresh?.()
          flash('Hidden nodes restored.')
        })
      )
      ctxEl.append(item('🔎', 'Unhide specific nodes…', showUnhidePanel))
    }
    if (hiddenEdges) {
      ctxEl.append(
        item('👁', `Show ${hiddenEdges} hidden link${hiddenEdges === 1 ? '' : 's'}`, () => {
          const ids = view.hiddenEdgeIdList()
          const kinds = view.getHiddenEdgeKinds()
          view.unhideAllEdges()
          syncEdgeOptionsFromView()
          undo.push({ type: 'hide', nodeIds: [], edgeIds: ids, edgeKinds: kinds, hidden: false })
          flash('Hidden links restored.')
        })
      )
    }
    placeCtx(x, y)
  }
  const onDocClick = (): void => hideCtx()
  document.addEventListener('click', onDocClick)
  cleanup.push(() => document.removeEventListener('click', onDocClick))

  // --- Link display options (persisted; see settings.ts) -------------------
  let edgeOptions: EdgeOptions = loadEdgeOptions()
  /** Mirror the view's hidden link types back into the saved options, after an
   *  undo/redo has changed them behind the Settings panel's back. */
  const syncEdgeOptionsFromView = (): void => {
    edgeOptions = { ...edgeOptions, hiddenKinds: view.getHiddenEdgeKinds() as EdgeOptions['hiddenKinds'] }
    saveEdgeOptions(edgeOptions)
  }

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
    onNodeDoubleTap: (node) => enterFocus(node.id),
    onEdgeTap: (info) => showEdgeDetails(info),
    onEdgeContext: (info, x, y) => showEdgeCtx(info, x, y),
    onDepartmentTap: (bucket) => {
      view.highlightDepartment(bucket)
      showDepartmentDetails(bucket)
    },
    onDepartmentContext: (bucket, x, y) => showDeptCtx(bucket, x, y),
    onNodesMoved: (moves: NodeMove[]) => undo.push({ type: 'move', moves }),
    onBackgroundContext: (x, y) => showBgCtx(x, y)
  })
  // Apply the saved link options to the fresh view.
  view.setEdgeMuting(edgeOptions.opacity)
  if (edgeOptions.hiddenKinds.length) view.setHiddenEdgeKinds(edgeOptions.hiddenKinds)
  showDetails(null)
  renderBreadcrumb()

  const minimap = new Minimap(minimapEl, view.core(), theme)
  // Restore the saved panel / minimap geometry now that both exist.
  applyLayout()
  // Tear down in dependency order: minimap & ego map reference the main core, so
  // they must be destroyed before the view destroys that core.
  cleanup.push(() => minimap.destroy())
  cleanup.push(() => egoMap?.destroy())
  cleanup.push(() => view.destroy())

  // --- Focus reach slider -------------------------------------------------
  // How many hops out from the focused node stay visible. Persisted, and only
  // meaningful while a node is focused — the row dims when nothing is focused.
  // Defined here (before the restore/initial-focus path below) so showNode can
  // safely call syncFocusDepthRow once focus is entered.
  const FOCUS_DEPTH_KEY = '3cx-spy.focusDepth'
  const depthSlider = root.querySelector<HTMLInputElement>('#focusDepth')!
  const depthValEl = root.querySelector<HTMLElement>('#focusDepthVal')!
  const depthRow = root.querySelector<HTMLElement>('#focusDepthRow')!
  const depthToHops = (v: number): number => (v >= 6 ? Infinity : v)
  const depthLabel = (v: number): string =>
    v >= 6 ? 'Whole cluster' : v === 1 ? 'Neighbours' : `${v} hops`
  // Focus Reach applies to any narrowed view — a focused node, a filtered
  // department, or a department merely selected on the canvas.
  const syncFocusDepthRow = (): void => {
    depthRow.classList.toggle('opacity-50', !view.isFocusedView() && !selectedDept)
  }
  const storedDepth = Number(localStorage.getItem(FOCUS_DEPTH_KEY))
  const initDepth = storedDepth >= 1 && storedDepth <= 6 ? storedDepth : 1
  depthSlider.value = String(initDepth)
  depthValEl.textContent = depthLabel(initDepth)
  view.setFocusDepth(depthToHops(initDepth))
  const applyDepth = (v: number): void => {
    const clamped = Math.min(6, Math.max(1, v))
    depthSlider.value = String(clamped)
    localStorage.setItem(FOCUS_DEPTH_KEY, String(clamped))
    depthValEl.textContent = depthLabel(clamped)
    // Reaching further out of a merely-selected department is a request to focus
    // on it — promote the selection to the filtered department view.
    if (selectedDept && !view.getDepartmentFilter() && view.getFocusId() == null) {
      setDept(selectedDept)
    }
    view.setFocusDepth(depthToHops(clamped))
  }
  depthSlider.addEventListener('input', () => applyDepth(Number(depthSlider.value)))
  root
    .querySelector('#depthOut')!
    .addEventListener('click', () => applyDepth(Number(depthSlider.value) - 1))
  root
    .querySelector('#depthIn')!
    .addEventListener('click', () => applyDepth(Number(depthSlider.value) + 1))
  syncFocusDepthRow()

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
    syncFocusDepthRow()
    // Focusing a department also selects it, so its details are right there.
    if (bucket) showDepartmentDetails(bucket)
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
    minimapCollapsed = !minimapCollapsed
    applyMinimapCollapse()
  })

  // --- Node lock (padlock / Space) ----------------------------------------
  const lockBtn = root.querySelector<HTMLButtonElement>('#lock')!
  // Locked by default so panning never accidentally drags nodes. Toggle with the
  // padlock button or Space. Locked nodes stay fully clickable — only dragging
  // them is disabled.
  let locked = true
  const applyLock = (): void => {
    view.setDraggable(!locked)
    lockBtn.textContent = locked ? '🔒 Locked' : '🔓 Unlocked'
    lockBtn.classList.toggle('bg-sky-700', locked)
  }
  const toggleLock = (): void => {
    locked = !locked
    applyLock()
  }
  lockBtn.addEventListener('click', toggleLock)
  applyLock()

  // --- Ctrl-key shortcuts for the menu / toolbar actions ------------------
  // `key` matches KeyboardEvent.key (lowercase); `shift:true` also requires
  // Shift. Kept clear of the existing Ctrl+Z / Ctrl+Y (undo / redo). The action
  // closures reference handlers defined later in this function; that's fine —
  // they only run on a keypress, well after setup completes.
  interface Shortcut {
    key: string
    shift?: boolean
    label: string
    run: () => void
  }
  const shortcuts: Shortcut[] = [
    {
      key: 'f',
      label: 'Search',
      run: () => {
        searchEl.focus()
        searchEl.select()
      }
    },
    { key: 'h', label: 'Health check', run: () => showAuditPanel() },
    { key: 'x', label: 'Extensions', run: () => showExtensionsPanel() },
    { key: 'd', label: 'DID table', run: () => showDidTable() },
    { key: 'c', shift: true, label: 'Compare snapshot', run: () => void showSnapshotDiff() },
    { key: 'g', label: 'Generate report', run: () => showReportSetup(nameFor, deptFor) },
    { key: 'l', label: 'Live report', run: () => void showLiveReport(nameFor, deptFor) },
    { key: 'o', label: 'Open report', run: () => void openReport(nameFor, deptFor) },
    { key: 'j', label: 'Call zones', run: () => showZoneSettings() },
    { key: 'e', label: 'Export PNG', run: () => exportPng(view, theme, host) },
    { key: 's', label: 'Save snapshot', run: () => void saveSnapshot() },
    { key: 'i', label: 'Open snapshot', run: () => cb.onOpenSnapshot() },
    { key: ',', label: 'Settings', run: () => openSettings() },
    { key: 'm', label: 'Toggle theme', run: () => toggleTheme() },
    { key: 'r', label: 'Refresh', run: () => refreshBtn.click() },
    { key: 'r', shift: true, label: 'Hard refresh', run: () => cb.onReload() },
    { key: 'u', label: 'Check for updates', run: () => void checkForUpdates() },
    { key: 'q', label: 'Disconnect', run: () => cb.onDisconnect() }
  ]
  // Human accelerator hint for a shortcut, e.g. "Ctrl+Shift+R".
  const accel = (s: Shortcut): string => `Ctrl+${s.shift ? 'Shift+' : ''}${s.key.toUpperCase()}`
  const accelByLabel = new Map(shortcuts.map((s) => [s.label, accel(s)]))

  // --- Command palette (Ctrl+K) -------------------------------------------
  // Every shortcut plus the view controls that never had one, so the whole app is
  // reachable by typing instead of by memorising ~16 key combinations.
  const paletteGroupFor = (label: string): string => {
    if (/report|zone/i.test(label)) return 'Reports'
    if (/snapshot|PNG|compare/i.test(label)) return 'Export & snapshots'
    if (/refresh|disconnect|update/i.test(label)) return 'Session'
    if (/settings|theme/i.test(label)) return 'Settings'
    return 'Analyse'
  }
  const paletteCommands = (): PaletteCommand[] => {
    const cmds: PaletteCommand[] = shortcuts.map((s) => ({
      title: s.label,
      group: paletteGroupFor(s.label),
      accel: accel(s),
      run: s.run
    }))
    // View controls, which are mouse-only otherwise.
    const layouts: Array<[LayoutName, string]> = [
      ['flow', 'Flow'],
      ['compact', 'Compact'],
      ['force', 'Spread'],
      ['department', 'Department']
    ]
    for (const [value, name] of layouts) {
      cmds.push({
        title: `View mode: ${name}`,
        group: 'View',
        keywords: 'layout arrange',
        run: () => {
          layoutSel.value = value
          view.setLayout(value)
        }
      })
    }
    cmds.push(
      { title: 'Fit to screen', group: 'View', keywords: 'zoom all', run: () => view.fit() },
      {
        title: locked ? 'Unlock node dragging' : 'Lock node dragging',
        group: 'View',
        accel: 'Space',
        run: toggleLock
      },
      {
        title: sizes.leftHidden ? 'Show navigation panel' : 'Hide navigation panel',
        group: 'View',
        run: () => toggleLeftPanel(sizes.leftHidden)
      },
      {
        title: sizes.rightHidden ? 'Show details panel' : 'Hide details panel',
        group: 'View',
        run: () => toggleDetails(sizes.rightHidden)
      },
      {
        title: 'Show all departments',
        group: 'View',
        keywords: 'clear filter',
        run: () => setDept(null)
      }
    )
    for (const [bucket] of deptList) {
      cmds.push({
        title: `Department: ${departmentLabel(bucket)}`,
        group: 'View',
        keywords: 'filter focus',
        run: () => setDept(bucket)
      })
    }
    if (view.hiddenCount() || view.hiddenEdgeCount()) {
      cmds.push({
        title: 'Restore hidden nodes and links',
        group: 'View',
        run: () => {
          view.unhideAll()
          view.unhideAllEdges()
          syncEdgeOptionsFromView()
          flash('Hidden items restored.')
        }
      })
    }
    return cmds
  }
  const openPalette = (): void =>
    showPalette({
      commands: paletteCommands(),
      // Reuse the same matcher the header search uses, so results agree.
      findNodes: (q) =>
        view.search(q).slice(0, 8).map((n) => ({
          id: n.id,
          label: n.label,
          detail: n.number,
          colour: NODE_KIND_META[n.kind].color
        })),
      onNavigate: (id) => navigate(id, true)
    })
  // Suppress the app shortcuts while any full-screen modal/overlay is open, so
  // e.g. Ctrl+G in an open report doesn't stack a second dialog behind it.
  const modalOpen = (): boolean => !!document.querySelector('.fixed.inset-0:not(.hidden)')

  const onKeyDown = (e: KeyboardEvent): void => {
    // Space toggles the padlock outright (it used to be hold-to-pan).
    if (e.code === 'Space' && !isTyping(e.target)) {
      e.preventDefault()
      toggleLock()
      return
    }
    // Ctrl+K works even from the search box — it's the way out of it.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      if (!modalOpen()) openPalette()
      return
    }
    if ((e.ctrlKey || e.metaKey) && !isTyping(e.target)) {
      const key = e.key.toLowerCase()
      // Undo / redo. Ctrl+Z undoes; Ctrl+Y or Ctrl+Shift+Z redoes.
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault()
        doUndo()
        return
      }
      if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault()
        doRedo()
        return
      }
      if (modalOpen()) return
      const sc = shortcuts.find((s) => s.key === key && !!s.shift === e.shiftKey)
      if (sc) {
        e.preventDefault()
        sc.run()
      }
    }
  }
  window.addEventListener('keydown', onKeyDown)
  cleanup.push(() => window.removeEventListener('keydown', onKeyDown))

  // Capture the user-facing view so a soft refresh can restore it after refetch.
  const captureState = (): ViewState => ({
    layout: layoutSel.value as LayoutName,
    visibleKinds: [...visible],
    focusId: view.getFocusId() ?? undefined,
    deptFilter: activeDept ?? undefined,
    selectedId: current?.id,
    history: [...history],
    zoom: view.getZoom(),
    pan: view.getPan(),
    locked
  })

  const applyRestore = (s: ViewState): void => {
    if (s.locked !== undefined) {
      locked = s.locked
      applyLock()
    }
    // Visible kinds (+ sync the legend checkboxes).
    visible.clear()
    for (const k of s.visibleKinds) if (presentKinds.includes(k)) visible.add(k)
    root.querySelectorAll<HTMLInputElement>('#legend input[data-kind]').forEach((c) => {
      c.checked = visible.has(c.dataset.kind as NodeKind)
    })
    // Layout.
    if (['flow', 'compact', 'force', 'department'].includes(s.layout)) layoutSel.value = s.layout
    view.setLayout(layoutSel.value as LayoutName)
    // Breadcrumb history (drop ids that no longer exist after the refresh).
    history.length = 0
    if (s.history) history.push(...s.history.filter((id) => graph.nodes.some((n) => n.id === id)))
    // Camera: restore focus, else department filter, else the exact viewport.
    const focusOk = !!s.focusId && graph.nodes.some((n) => n.id === s.focusId)
    const deptOk = !!s.deptFilter && deptList.some(([b]) => b === s.deptFilter)
    if (focusOk) enterFocus(s.focusId!)
    else if (deptOk) setDept(s.deptFilter!)
    else if (s.zoom != null && s.pan)
      requestAnimationFrame(() => view.applyViewport(s.zoom!, s.pan!))
    // Re-open the details panel on the previously-selected node (focus already
    // opens its own details).
    const sel = s.selectedId ? graph.nodes.find((n) => n.id === s.selectedId) : undefined
    if (sel && !focusOk) showDetails(sel)
    renderBreadcrumb()
  }

  // Restore a prior view (soft refresh), else honour an open-in-new-window link.
  if (restore) applyRestore(restore)
  else if (initialFocusId && graph.nodes.some((n) => n.id === initialFocusId)) {
    enterFocus(initialFocusId)
  }

  // Toolbar soft refresh: capture state, refetch, rebuild preserving the view.
  const refreshBtn = root.querySelector<HTMLButtonElement>('#refresh')!
  const refreshIcon = root.querySelector<HTMLElement>('#refreshIcon')!
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true
    refreshIcon.classList.add('animate-spin')
    await cb.onRefresh(captureState())
    // On success the app was re-rendered (this button is now detached, so these
    // are no-ops); on failure it's still on screen, so clear the spinner.
    refreshBtn.disabled = false
    refreshIcon.classList.remove('animate-spin')
  })

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

  const openSettings = (): void =>
    showSettings({
      theme,
      edgeOptions,
      onEdgeOptions: (o) => {
        edgeOptions = o
        saveEdgeOptions(o)
        view.setEdgeMuting(o.opacity)
        view.setHiddenEdgeKinds(o.hiddenKinds)
      },
      onToggleTheme: toggleTheme,
      onOpenZones: () => showZoneSettings(),
      onCheckUpdates: () => void checkForUpdates(),
      individuallyHiddenEdges: view.hiddenEdgeIdList().length,
      onRestoreHiddenEdges: () => {
        const ids = view.hiddenEdgeIdList()
        view.unhideEdges(ids)
        undo.push({ type: 'hide', nodeIds: [], edgeIds: ids, edgeKinds: [], hidden: false })
        flash('Hidden links restored.')
      },
      onSaveLayoutDefault: () => {
        try {
          localStorage.setItem(LAYOUT_DEFAULT_KEY, JSON.stringify(sizes))
          flash('Current panel sizes saved as default.')
        } catch {
          flash('Could not save the layout default.', true)
        }
      },
      onRestoreLayout: () => {
        const target = readSizes(LAYOUT_DEFAULT_KEY) ?? BUILTIN_SIZES
        Object.assign(sizes, target)
        persistSizes()
        applyLayout()
        minimap.sync()
        flash('Panel sizes restored.')
      },
      homeCountry: readHomeCountry(),
      onHomeCountry: (iso2) => writeHomeCountry(iso2)
    })
  const buildMenu = (): void => {
    const item = (icon: string, label: string, fn: () => void, accelHint?: string): HTMLElement => {
      const b = document.createElement('button')
      b.className =
        'w-full text-left flex items-center gap-2.5 px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-700 whitespace-nowrap'
      const hint = accelHint ?? accelByLabel.get(label)
      b.innerHTML = `<span class="w-4 text-center shrink-0">${icon}</span><span class="flex-1">${esc(label)}</span>${
        hint
          ? `<span class="shrink-0 pl-3 text-[10px] text-slate-400 font-mono tracking-tight">${esc(hint)}</span>`
          : ''
      }`
      b.addEventListener('click', () => {
        menuEl.classList.add('hidden')
        fn()
      })
      return b
    }
    // A labelled section header separating groups of related actions.
    const section = (label: string): HTMLElement => {
      const d = document.createElement('div')
      d.className =
        'px-3 pt-2 pb-0.5 mt-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400 border-t border-slate-200 dark:border-slate-700 first:mt-0 first:border-t-0'
      d.textContent = label
      return d
    }
    menuEl.innerHTML = ''
    // Analyse — read-only insight tools.
    menuEl.append(section('Analyse'))
    menuEl.append(item('🩺', 'Health check', showAuditPanel))
    menuEl.append(item('👥', 'Extensions', showExtensionsPanel))
    menuEl.append(item('🗂', 'DID table', showDidTable))
    menuEl.append(item('🕓', 'Compare snapshot', () => void showSnapshotDiff()))
    // Reports — call-activity reporting.
    menuEl.append(section('Reports'))
    menuEl.append(item('📊', 'Generate report', () => showReportSetup(nameFor, deptFor)))
    menuEl.append(item('📡', 'Live report', () => void showLiveReport(nameFor, deptFor)))
    menuEl.append(item('📈', 'Open report', () => void openReport(nameFor, deptFor)))
    // Export & snapshots — get data out / back in.
    menuEl.append(section('Export & snapshots'))
    menuEl.append(item('🖼', 'Export PNG', () => exportPng(view, theme, host)))
    menuEl.append(item('💾', 'Save snapshot', saveSnapshot))
    menuEl.append(item('📂', 'Open snapshot', cb.onOpenSnapshot))
    // Everything configurable lives in Settings — deliberately not duplicated
    // here, so there's one place to change a setting.
    menuEl.append(section('Settings'))
    menuEl.append(item('⚙', 'Settings', openSettings))
    // Session — connection lifecycle.
    menuEl.append(section('Session'))
    menuEl.append(item('🔄', 'Hard refresh', cb.onReload))
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
  const shortcutListEl = root.querySelector<HTMLElement>('#shortcutList')!
  shortcutListEl.innerHTML = shortcuts
    .map(
      (s) =>
        `<div class="flex items-center justify-between gap-2"><span class="text-slate-500 dark:text-slate-300 truncate">${esc(s.label)}</span><span class="shrink-0 px-1 py-0.5 rounded border border-current text-[9px] leading-none text-slate-400 font-mono">${esc(accel(s))}</span></div>`
    )
    .join('')
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
  // Latest results, so Enter can jump straight to the top match.
  let searchMatches: GraphNode[] = []
  const pickSearch = (id: string): void => {
    navigate(id, true)
    resultsEl.classList.add('hidden')
    searchEl.value = ''
    searchMatches = []
  }
  searchEl.addEventListener('input', () => {
    searchMatches = view.search(searchEl.value).slice(0, 12)
    if (!searchMatches.length) {
      resultsEl.classList.add('hidden')
      return
    }
    resultsEl.innerHTML = searchMatches
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
      b.addEventListener('click', () => pickSearch(b.dataset.id!))
    })
  })
  // Enter selects the top result (unless there are none).
  searchEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && searchMatches.length) {
      e.preventDefault()
      pickSearch(searchMatches[0].id)
    }
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
    // Opening any panel clears the live-refresh hook; a panel whose contents can
    // go stale re-registers itself afterwards (see showUnhidePanel).
    openPanelRefresh = null
    panel.innerHTML = `
      <div class="shrink-0 flex items-center justify-between gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-700">
        <h3 class="font-semibold text-slate-700 dark:text-slate-200 truncate">${esc(title)}</h3>
        <div class="flex items-center gap-2 shrink-0">${actionsHtml}<button id="closePanel" class="text-slate-400 hover:text-slate-700 dark:hover:text-slate-100">✕</button></div>
      </div>
      <div class="flex-1 min-h-0 overflow-y-auto px-3 py-2">${bodyHtml}</div>`
    panel.classList.remove('hidden')
    panel.querySelector('#closePanel')!.addEventListener('click', () => {
      openPanelRefresh = null
      panel.classList.add('hidden')
    })
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

  // --- Extension status ---------------------------------------------------
  // Every extension with its live presence and whether it's logged in to queues,
  // so an agent who's quietly signed out is easy to spot.
  const showExtensionsPanel = (): void => {
    const rows = graph.nodes
      .filter((n) => n.kind === 'user')
      .sort((a, b) => (a.number ?? '').localeCompare(b.number ?? '', undefined, { numeric: true }))
    if (!rows.length) {
      panelShell('Extensions', `<p class="text-slate-500 dark:text-slate-400">No extensions.</p>`)
      return
    }
    // Agent links per extension, so the queue column can report per-queue logins
    // (3CX v20 lets an agent be logged out of one queue but not another).
    const agentEdgesByUser = new Map<string, typeof graph.edges>()
    for (const e of graph.edges) {
      if (e.kind !== 'agent') continue
      const list = agentEdgesByUser.get(e.target)
      if (list) list.push(e)
      else agentEdgesByUser.set(e.target, [e])
    }
    const queueTotals = { in: 0, out: 0, partial: 0, unknown: 0 }
    const body = rows
      .map((n) => {
        const presence = presenceOf(n.raw)
        const meta = presence ? PRESENCE_META[presence] : null
        const agentEdges = agentEdgesByUser.get(n.id) ?? []
        const perQueue = agentEdges.filter((e) => e.agentLoggedIn !== undefined)
        let queueCell: string
        if (perQueue.length) {
          const inCount = perQueue.filter((e) => e.agentLoggedIn).length
          if (inCount === perQueue.length) queueTotals.in++
          else if (inCount === 0) queueTotals.out++
          else queueTotals.partial++
          const cls =
            inCount === perQueue.length
              ? 'text-emerald-600 dark:text-emerald-400'
              : inCount === 0
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-sky-600 dark:text-sky-400'
          const names = perQueue
            .map((e) => {
              const q = nodeById.get(e.source)
              return `${q?.label ?? e.source}: ${e.agentLoggedIn ? 'in' : 'out'}`
            })
            .join(', ')
          queueCell = `<span class="${cls}" title="${esc(names)}">${inCount} / ${perQueue.length} in</span>`
        } else {
          // 3CX v20 doesn't expose per-queue login on the Queues endpoint, so this
          // is the normal path: the extension's effective state, which accounts for
          // a status profile that auto-logs it out of queues.
          const state = queueLoginState(n.raw)
          if (state?.loggedIn === true) queueTotals.in++
          else if (state?.loggedIn === false) queueTotals.out++
          else queueTotals.unknown++
          queueCell = !state
            ? '<span class="text-slate-400">—</span>'
            : state.loggedIn
              ? '<span class="text-emerald-600 dark:text-emerald-400" title="Queue login status">Logged in</span>'
              : `<span class="text-amber-600 dark:text-amber-400" title="${esc(state.reason ?? 'Queue login status')}">Logged out${state.reason ? ' ⓘ' : ''}</span>`
        }
        const depts = n.departments?.length ? n.departments.join(', ') : ''
        return `<tr class="border-t border-slate-100 dark:border-slate-700/50">
          <td class="py-1 pr-2 font-mono whitespace-nowrap">${esc(n.number ?? '')}</td>
          <td class="py-1 pr-2"><button data-nav="${esc(n.id)}" class="text-left text-sky-600 dark:text-sky-400 hover:underline">${esc(n.label)}</button></td>
          <td class="py-1 pr-2 whitespace-nowrap">${
            meta
              ? `<span class="inline-flex items-center gap-1.5"><span class="w-2 h-2 rounded-full shrink-0" style="background:${meta.color}"></span>${esc(meta.label)}</span>`
              : '<span class="text-slate-400">Unknown</span>'
          }</td>
          <td class="py-1 pr-2 whitespace-nowrap">${queueCell}</td>
          <td class="py-1 truncate max-w-[160px] text-slate-500 dark:text-slate-400">${esc(depts)}</td>
        </tr>`
      })
      .join('')
    const summary = `<p class="text-[11px] text-slate-400 mb-1.5">${rows.length} extensions · ${queueTotals.in} logged in to queues · ${queueTotals.out} logged out${queueTotals.partial ? ` · ${queueTotals.partial} partially logged in` : ''}${queueTotals.unknown ? ` · ${queueTotals.unknown} unknown` : ''}</p>`
    const table = `<div class="overflow-x-auto"><table class="w-full text-[11px]">
      <thead><tr class="text-left text-slate-400">
        <th class="pr-2 pb-1 font-medium">Ext</th>
        <th class="pr-2 pb-1 font-medium">Name</th>
        <th class="pr-2 pb-1 font-medium">Status</th>
        <th class="pr-2 pb-1 font-medium">Queues</th>
        <th class="pb-1 font-medium">Department</th>
      </tr></thead><tbody>${body}</tbody></table></div>`
    panelShell(`Extensions — ${rows.length}`, summary + table)
    wireNav()
  }

  // --- Selective unhide ---------------------------------------------------
  // Hiding is easy to over-apply, so offer a list to bring items back one at a
  // time (or a whole department) rather than only all-or-nothing.
  const showUnhidePanel = (): void => {
    const ids = view.hiddenNodeIds()
    if (!ids.length) {
      panelShell('Hidden nodes', `<p class="text-slate-500 dark:text-slate-400">Nothing is hidden.</p>`)
      // Stay registered: hiding something while this is open should fill it in.
      openPanelRefresh = showUnhidePanel
      return
    }
    const nodes = ids
      .map((id) => graph.nodes.find((n) => n.id === id))
      .filter((n): n is GraphNode => !!n)
    // Group by department so a tenant's worth of hidden nodes can go back at once.
    const groups = new Map<string, GraphNode[]>()
    for (const n of nodes) {
      const key = n.deptGroup ?? ''
      const list = groups.get(key)
      if (list) list.push(n)
      else groups.set(key, [n])
    }
    const restore = (toShow: string[], what: string): void => {
      view.unhideNodes(toShow)
      undo.push({ type: 'hide', nodeIds: toShow, edgeIds: [], edgeKinds: [], hidden: false })
      flash(`${what} restored.`)
      showUnhidePanel() // refresh the list in place
    }
    const body = [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([bucket, members]) => {
        const name = bucket ? departmentLabel(bucket) : 'No department'
        const rows = members
          .sort((a, b) => (a.number ?? a.label).localeCompare(b.number ?? b.label, undefined, { numeric: true }))
          .map(
            (n) => `<li class="flex items-center gap-2 px-1.5 py-0.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800">
              <span class="w-2 h-2 rounded-full shrink-0" style="background:${NODE_KIND_META[n.kind].color}"></span>
              <span class="flex-1 truncate">${esc(n.label)}${n.number ? ` <span class="text-slate-400 font-mono">${esc(n.number)}</span>` : ''}</span>
              <button data-unhide="${esc(n.id)}" class="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-[10px] shrink-0">Unhide</button>
            </li>`
          )
          .join('')
        return `<div class="mb-2">
          <div class="flex items-center gap-2 mb-0.5">
            <h4 class="flex-1 text-[11px] font-semibold text-slate-500 uppercase tracking-wide">${esc(name)} <span class="text-slate-400">(${members.length})</span></h4>
            ${members.length > 1 ? `<button data-unhide-group="${esc(bucket)}" class="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-[10px]">Unhide all</button>` : ''}
          </div>
          <ul class="space-y-0.5 text-slate-600 dark:text-slate-300">${rows}</ul>
        </div>`
      })
      .join('')
    panelShell(
      `Hidden nodes — ${nodes.length}`,
      body,
      `<button id="unhideEverything" class="px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-100 text-[11px]">Unhide all</button>`
    )
    // Keep the list live: hiding or restoring anything else re-renders it.
    openPanelRefresh = showUnhidePanel
    for (const b of panel.querySelectorAll<HTMLElement>('[data-unhide]')) {
      b.addEventListener('click', () => restore([b.dataset.unhide!], 'Node'))
    }
    for (const b of panel.querySelectorAll<HTMLElement>('[data-unhide-group]')) {
      b.addEventListener('click', () => {
        const bucket = b.dataset.unhideGroup ?? ''
        const group = (groups.get(bucket) ?? []).map((n) => n.id)
        restore(group, bucket ? departmentLabel(bucket) : 'Nodes')
      })
    }
    panel
      .querySelector('#unhideEverything')
      ?.addEventListener('click', () => restore(view.hiddenNodeIds(), 'All hidden nodes'))
  }

  // --- Snapshot comparison ------------------------------------------------
  // Answers "what changed since this snapshot?" — the older file is the baseline
  // and the current view is "now", so added/removed read in the natural direction.
  const showSnapshotDiff = async (): Promise<void> => {
    const res = await window.api.app.openSnapshot()
    if (res.canceled) return
    if (res.error || !res.topology) {
      flash(res.error ?? 'Could not open snapshot.', true)
      return
    }
    const baseline = buildTopology(res.topology)
    const diff = diffTopologies(baseline, graph)
    const takenAt = res.topology.fetchedAt ? fmtWhen(res.topology.fetchedAt) : 'unknown date'
    if (diff.identical) {
      panelShell(
        'Snapshot comparison',
        `<p class="text-slate-500 dark:text-slate-400">No configuration differences from the snapshot taken ${esc(takenAt)}. 🎉</p>
         <p class="text-[11px] text-slate-400 mt-1">Live state (registration, presence, queue login) is ignored on purpose.</p>`
      )
      return
    }
    const badge = (c: ChangeKind): string => {
      const cls =
        c === 'added'
          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
          : c === 'removed'
            ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
            : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
      return `<span class="px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase shrink-0 ${cls}">${c}</span>`
    }
    const nodeRows = diff.nodes
      .map((n) => {
        // A removed node isn't in the current graph, so it isn't navigable.
        const nav = n.change === 'removed' ? '' : `data-nav="${esc(n.id)}"`
        const cursor = n.change === 'removed' ? '' : 'cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800'
        return `<li ${nav} class="flex items-start gap-2 px-1.5 py-1 rounded ${cursor}">
          ${badge(n.change)}
          <span class="w-2 h-2 mt-1 rounded-full shrink-0" style="background:${NODE_KIND_META[n.kind].color}"></span>
          <span class="flex-1 min-w-0">
            <span class="text-slate-700 dark:text-slate-200">${esc(n.label)}</span>
            ${n.number ? ` <span class="text-slate-400 font-mono">${esc(n.number)}</span>` : ''}
            <span class="text-slate-400"> · ${esc(NODE_KIND_META[n.kind].label)}</span>
            ${n.details.length ? `<div class="text-[11px] text-slate-500 dark:text-slate-400 break-words">${esc(n.details.join(' · '))}</div>` : ''}
          </span>
        </li>`
      })
      .join('')
    const edgeRows = diff.edges
      .map(
        (e) => `<li class="flex items-start gap-2 px-1.5 py-1">
          ${badge(e.change)}
          <span class="flex-1 min-w-0">
            <span class="text-slate-700 dark:text-slate-200">${esc(e.sourceLabel)}</span>
            <span class="text-slate-400"> → </span>
            <span class="text-slate-700 dark:text-slate-200">${esc(e.targetLabel)}</span>
            <span class="text-slate-400"> · ${esc(EDGE_KIND_META[e.kind]?.label ?? e.kind)}</span>
            ${e.details.length ? `<div class="text-[11px] text-slate-500 dark:text-slate-400 break-words">${esc(e.details.join(' · '))}</div>` : ''}
          </span>
        </li>`
      )
      .join('')
    const section = (title: string, count: number, rows: string): string =>
      count
        ? `<div class="mb-3"><h4 class="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-0.5">${esc(title)} <span class="text-slate-400">(${count})</span></h4><ul class="space-y-0.5">${rows}</ul></div>`
        : ''
    const body = `
      <p class="text-[11px] text-slate-400 mb-2">Compared with the snapshot taken ${esc(takenAt)}. Live state (registration, presence, queue login) is ignored.</p>
      ${section('Entities', diff.nodes.length, nodeRows)}
      ${section('Routing & membership', diff.edges.length, edgeRows)}`
    const actions = `<button id="diffHighlight" class="px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-100 text-[11px]">Highlight on graph</button>`
    panelShell(
      `Snapshot comparison — ${diff.counts.added} added · ${diff.counts.removed} removed · ${diff.counts.changed} changed`,
      body,
      actions
    )
    wireNav()
    panel.querySelector('#diffHighlight')?.addEventListener('click', () => {
      const ids = changedNodeIds(diff)
      if (!ids.length) {
        flash('Nothing left on the graph to highlight.')
        return
      }
      view.highlightIds(ids)
      flash(`Highlighted ${ids.length} changed node${ids.length === 1 ? '' : 's'}.`)
    })
  }

  // --- Trace-a-call -------------------------------------------------------
  const showTracePanel = (node: GraphNode): void => {
    const { sources, terminals } = view.traceFlow(node.id)
    const nodeList = (nodes: GraphNode[], empty: string): string =>
      nodes.length
        ? `<ul class="space-y-0.5 text-slate-600 dark:text-slate-300">${nodes
            .map(
              (n) =>
                `<li data-nav="${esc(n.id)}" class="flex items-center gap-2 px-1.5 py-0.5 rounded cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800"><span class="w-2 h-2 rounded-full shrink-0" style="background:${NODE_KIND_META[n.kind].color}"></span><span class="flex-1 truncate">${esc(n.label)}${n.number ? ` <span class="text-slate-400 font-mono">${esc(n.number)}</span>` : ''}</span></li>`
            )
            .join('')}</ul>`
        : `<p class="text-slate-400">${esc(empty)}</p>`
    const body = `
      <p class="text-slate-500 dark:text-slate-400 mb-2">Everything highlighted is on a call path through <span class="font-medium text-slate-700 dark:text-slate-200">${esc(node.label)}</span>.</p>
      <div class="mb-3">
        <h4 class="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-0.5">Can be reached from <span class="text-slate-400">(${sources.length})</span></h4>
        ${nodeList(sources, 'Nothing routes in — this is an entry point.')}
      </div>
      <div>
        <h4 class="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-0.5">Can route to <span class="text-slate-400">(${terminals.length})</span></h4>
        ${nodeList(terminals, "Doesn't route anywhere (or only loops back).")}
      </div>`
    panelShell(`Call trace — ${node.label}`, body)
    wireNav()
  }

  // --- Snapshot save ------------------------------------------------------
  const saveSnapshot = async (): Promise<void> => {
    const res = await window.api.app.saveSnapshot(topology, readSnapshotDir() || undefined)
    if (res.error) flash(res.error, true)
    else if (res.path) flash('Snapshot saved.')
  }
}

/** Local date+time for a snapshot's ISO timestamp, or the raw value if unparsable. */
function fmtWhen(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
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
