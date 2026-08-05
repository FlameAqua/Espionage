// Renders the right-hand details panel for a selected node: its key facts,
// inbound/outbound relationships (each clickable to navigate), and raw JSON.

import {
  NODE_KIND_META,
  PRESENCE_META,
  SHARED_DEPARTMENT,
  departmentColor,
  departmentLabel,
  presenceOf,
  queueLoginState,
  type GraphEdge,
  type GraphNode,
  type NodeKind,
  type TopologyGraph
} from '../graph/model'
import { panelHeader, panelHeaderRow } from './panel-chrome'

const esc = (s: unknown): string =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )

interface Ctx {
  graph: TopologyGraph
  canGoBack: boolean
  onNavigate: (id: string) => void
  onBack: () => void
  onHide: () => void
}

/** The panel's Back control, greyed out when there's no history to go back to. */
function backButton(ctx: Ctx): string {
  const enabled = ctx.canGoBack
    ? 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
    : 'text-slate-300 dark:text-slate-700 cursor-default'
  return `<button id="back" class="px-2 py-0.5 rounded text-xs ${enabled}" ${ctx.canGoBack ? '' : 'disabled'}>‹ Back</button>`
}

export function renderDetails(container: HTMLElement, node: GraphNode | null, ctx: Ctx): void {
  if (!node) {
    container.innerHTML = `
      <div class="flex flex-col h-full">
        ${panelHeader({ title: 'Details', side: 'right', hideId: 'hide' })}
        <div class="p-6 text-sm text-slate-400">Select a node to inspect it.</div>
      </div>`
    container.querySelector('#hide')?.addEventListener('click', ctx.onHide)
    return
  }

  const meta = NODE_KIND_META[node.kind]
  const nodeById = new Map(ctx.graph.nodes.map((n) => [n.id, n]))
  const out = ctx.graph.edges.filter((e) => e.source === node.id)
  const inc = ctx.graph.edges.filter((e) => e.target === node.id)

  const sections: string[] = []

  // Extensions: which queues they're an agent of, with their global login state.
  if (node.kind === 'user') {
    const qs = queueMembershipSection(node, inc, nodeById)
    if (qs) sections.push(qs)
  }
  // Queues / ring groups: who is in it, each with live presence + login state.
  if (node.kind === 'queue' || node.kind === 'ringGroup') {
    const ms = memberStatusSection(node, out, nodeById)
    if (ms) sections.push(ms)
  }

  // Outgoing — where this entity routes / who it contains. For queues / ring
  // groups the members are already listed (with status) above, so show only the
  // routing edges here to avoid listing agents twice.
  const outForRel =
    node.kind === 'queue' || node.kind === 'ringGroup'
      ? out.filter((e) => e.kind !== 'agent' && e.kind !== 'member')
      : out
  if (outForRel.length) {
    sections.push(relSection(outgoingTitle(node.kind), outForRel, (e) => e.target, nodeById))
  }
  // Incoming — who routes here / which groups this belongs to. For extensions the
  // queues they're an agent of are already in the Queues section above.
  const incForRel = node.kind === 'user' ? inc.filter((e) => e.kind !== 'agent') : inc
  if (incForRel.length) {
    sections.push(relSection(incomingTitle(node.kind), incForRel, (e) => e.source, nodeById))
  }

  const info = node.info?.length
    ? `<div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">${node.info
        .map(
          (f) =>
            `<div class="text-slate-400">${esc(f.label)}</div><div class="text-slate-700 dark:text-slate-200 font-medium break-words">${esc(f.value)}</div>`
        )
        .join('')}</div>`
    : ''
  const facts = keyFacts(
    node,
    inc.filter((e) => e.kind === 'agent')
  )
  const depts = node.departments?.length
    ? `<div class="flex flex-wrap gap-1">${node.departments
        .map(
          (d) =>
            `<span class="px-2 py-0.5 rounded-full text-[10px] font-medium bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300 border border-slate-200 dark:border-slate-700">${esc(d)}</span>`
        )
        .join('')}</div>`
    : ''

  container.innerHTML = `
    <div class="flex flex-col h-full">
      <div class="px-4 py-3 border-b border-slate-200 dark:border-slate-800 sticky top-0 bg-white dark:bg-slate-900 z-10">
        <div class="mb-1.5">
          ${panelHeaderRow({
            title: 'Details',
            side: 'right',
            hideId: 'hide',
            leading: backButton(ctx)
          })}
        </div>
        <span class="inline-block px-2 py-0.5 rounded text-[11px] font-semibold text-white" style="background:${meta.color}">${esc(meta.label)}</span>
        <h2 class="mt-1.5 text-base font-semibold text-slate-800 dark:text-slate-100 leading-tight">${esc(node.label)}</h2>
        ${node.number ? `<div class="text-xs text-slate-500 font-mono">${node.kind === 'inboundRule' ? 'DID' : 'ext'} ${esc(node.number)}</div>` : ''}
      </div>
      <div class="overflow-y-auto flex-1 px-4 py-3 space-y-4 text-sm">
        <!-- relative + overflow-hidden so the mini-map's own reach/fit controls
             can float over it without escaping the rounded border. The background
             matches the MAIN CANVAS (slate-100 / slate-950), not the panel: node
             fills are pre-blended against those colours to stay opaque, so any
             other backdrop makes them look washed out or muddy. -->
        <div id="egomap" class="relative overflow-hidden h-44 w-full rounded-md border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-950" title="Click a neighbour to select it · double-click to focus · right-click for actions"></div>
        ${info}
        ${depts ? `<div><h3 class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">${node.deptGroup === SHARED_DEPARTMENT ? 'Multiple departments' : 'Departments'}</h3>${depts}</div>` : ''}
        ${facts}
        ${outboundRulesSection(node)}
        <details class="group">
          <summary class="cursor-pointer text-xs font-semibold text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 select-none">View more info</summary>
          ${moreInfo(node)}
        </details>
        ${sections.join('')}
        <details class="group">
          <summary class="cursor-pointer text-xs font-semibold text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 select-none">Raw JSON</summary>
          <pre class="mt-2 p-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-[11px] leading-snug overflow-x-auto text-slate-700 dark:text-slate-300">${esc(JSON.stringify(node.raw, null, 2))}</pre>
        </details>
      </div>
    </div>`

  container.querySelectorAll<HTMLElement>('[data-nav]').forEach((el) => {
    el.addEventListener('click', () => ctx.onNavigate(el.dataset.nav!))
  })
  container.querySelector('#hide')?.addEventListener('click', ctx.onHide)
  const back = container.querySelector<HTMLButtonElement>('#back')
  if (back && ctx.canGoBack) back.addEventListener('click', ctx.onBack)
}

/** Render a whole category (a click on the legend): how it breaks down by
 *  department, and every member — matching the nodes lit on the canvas. */
export function renderKindDetails(
  container: HTMLElement,
  kind: NodeKind,
  nodes: GraphNode[],
  ctx: Ctx
): void {
  const meta = NODE_KIND_META[kind]

  // Department split: on a multi-tenant system this is usually the first thing
  // you want from "show me every queue".
  const byDept = new Map<string, number>()
  for (const n of nodes) {
    const key = n.deptGroup ?? ''
    byDept.set(key, (byDept.get(key) ?? 0) + 1)
  }
  const deptRows = [...byDept.entries()]
    .sort(([a], [b]) => {
      if (!a) return 1
      if (!b) return -1
      if (a === SHARED_DEPARTMENT) return 1
      if (b === SHARED_DEPARTMENT) return -1
      return a.localeCompare(b)
    })
    .map(
      ([bucket, count]) => `<span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] bg-slate-100 dark:bg-slate-800">
        <span class="w-2 h-2 rounded-full" style="background:${bucket ? departmentColor(bucket) : '#cbd5e1'}"></span>
        ${esc(bucket ? departmentLabel(bucket) : 'No department')} <span class="text-slate-400">${count}</span>
      </span>`
    )
    .join(' ')

  const rows = nodes
    .slice()
    .sort((a, b) => (a.number ?? a.label).localeCompare(b.number ?? b.label, undefined, { numeric: true }))
    .map(
      (n) => `<li data-nav="${esc(n.id)}" class="flex items-center gap-2 px-2 py-1 rounded cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800">
        ${n.kind === 'user' ? presenceDot(n.raw) : `<span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${meta.color}"></span>`}
        <span class="flex-1 truncate text-slate-700 dark:text-slate-200">${esc(n.label)}</span>
        ${n.number ? `<span class="text-slate-400 font-mono text-xs">${esc(n.number)}</span>` : ''}
      </li>`
    )
    .join('')

  container.innerHTML = `
    <div class="flex flex-col h-full">
      <div class="px-4 py-3 border-b border-slate-200 dark:border-slate-800 sticky top-0 bg-white dark:bg-slate-900 z-10">
        <div class="mb-1.5">
          ${panelHeaderRow({
            title: 'Details',
            side: 'right',
            hideId: 'hide',
            leading: backButton(ctx)
          })}
        </div>
        <span class="inline-block px-2 py-0.5 rounded text-[11px] font-semibold text-white" style="background:${meta.color}">Category</span>
        <h2 class="mt-1.5 text-base font-semibold text-slate-800 dark:text-slate-100 leading-tight">${esc(meta.label)}</h2>
        <div class="text-xs text-slate-500">${nodes.length} on this system</div>
      </div>
      <div class="overflow-y-auto flex-1 px-4 py-3 space-y-4 text-sm">
        ${deptRows ? `<div><h3 class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">By department</h3><div class="flex flex-wrap gap-1">${deptRows}</div></div>` : ''}
        <div>
          <h3 class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">${esc(meta.label)} <span class="text-slate-400">(${nodes.length})</span></h3>
          ${rows ? `<ul class="space-y-0.5">${rows}</ul>` : '<p class="text-slate-400">None on this system.</p>'}
        </div>
      </div>
    </div>`

  container.querySelectorAll<HTMLElement>('[data-nav]').forEach((el) => {
    el.addEventListener('click', () => ctx.onNavigate(el.dataset.nav!))
  })
  container.querySelector('#hide')?.addEventListener('click', ctx.onHide)
  const back = container.querySelector<HTMLButtonElement>('#back')
  if (back && ctx.canGoBack) back.addEventListener('click', ctx.onBack)
}

/** Render a tapped department box: which department, who's in it, and how it's
 *  reached. Uses the same panel as nodes and links. */
export function renderDepartmentDetails(
  container: HTMLElement,
  bucket: string,
  members: GraphNode[],
  ctx: Ctx
): void {
  const shared = bucket === SHARED_DEPARTMENT
  const colour = departmentColor(bucket)
  const byKind = new Map<string, GraphNode[]>()
  for (const m of members) {
    const list = byKind.get(m.kind)
    if (list) list.push(m)
    else byKind.set(m.kind, [m])
  }
  // Sort categories by the model's own order so it reads like the legend.
  const kinds = (Object.keys(NODE_KIND_META) as Array<keyof typeof NODE_KIND_META>).filter((k) =>
    byKind.has(k)
  )
  const memberIds = new Set(members.map((m) => m.id))
  // Links crossing the boundary tell you how the department is reached and where
  // it hands calls on to — usually the first thing you want from a tenant.
  const inbound = ctx.graph.edges.filter((e) => memberIds.has(e.target) && !memberIds.has(e.source))
  const outbound = ctx.graph.edges.filter((e) => memberIds.has(e.source) && !memberIds.has(e.target))
  const nodeById = new Map(ctx.graph.nodes.map((n) => [n.id, n]))

  const counts = kinds
    .map((k) => {
      const meta = NODE_KIND_META[k]
      return `<span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] bg-slate-100 dark:bg-slate-800">
        <span class="w-2 h-2 rounded-full" style="background:${meta.color}"></span>
        ${esc(meta.label)} <span class="text-slate-400">${byKind.get(k)!.length}</span>
      </span>`
    })
    .join(' ')

  const memberList = kinds
    .map((k) => {
      const rows = byKind
        .get(k)!
        .slice()
        .sort((a, b) => (a.number ?? a.label).localeCompare(b.number ?? b.label, undefined, { numeric: true }))
        .map(
          (m) => `<li data-nav="${esc(m.id)}" class="flex items-center gap-2 px-2 py-1 rounded cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800">
            ${m.kind === 'user' ? presenceDot(m.raw) : `<span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${NODE_KIND_META[m.kind].color}"></span>`}
            <span class="flex-1 truncate text-slate-700 dark:text-slate-200">${esc(m.label)}</span>
            ${m.number ? `<span class="text-slate-400 font-mono text-xs">${esc(m.number)}</span>` : ''}
          </li>`
        )
        .join('')
      return `<div class="mb-2">
        <h4 class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-0.5">${esc(NODE_KIND_META[k].label)}</h4>
        <ul class="space-y-0.5">${rows}</ul>
      </div>`
    })
    .join('')

  const crossing = (edges: GraphEdge[], pick: (e: GraphEdge) => string, title: string): string => {
    if (!edges.length) return ''
    const seen = new Set<string>()
    const rows = edges
      .map((e) => {
        const id = pick(e)
        if (seen.has(id)) return ''
        seen.add(id)
        const n = nodeById.get(id)
        if (!n) return ''
        return `<li data-nav="${esc(id)}" class="flex items-center gap-2 px-2 py-1 rounded cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800">
          <span class="w-2 h-2 rounded-full shrink-0" style="background:${NODE_KIND_META[n.kind].color}"></span>
          <span class="flex-1 truncate text-slate-700 dark:text-slate-200">${esc(n.label)}</span>
          ${n.number ? `<span class="text-slate-400 font-mono text-xs">${esc(n.number)}</span>` : ''}
        </li>`
      })
      .join('')
    if (!rows) return ''
    return `<div>
      <h3 class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">${esc(title)}</h3>
      <ul class="space-y-0.5">${rows}</ul>
    </div>`
  }

  container.innerHTML = `
    <div class="flex flex-col h-full">
      <div class="px-4 py-3 border-b border-slate-200 dark:border-slate-800 sticky top-0 bg-white dark:bg-slate-900 z-10">
        <div class="mb-1.5">
          ${panelHeaderRow({
            title: 'Details',
            side: 'right',
            hideId: 'hide',
            leading: backButton(ctx)
          })}
        </div>
        <span class="inline-block px-2 py-0.5 rounded text-[11px] font-semibold text-white" style="background:${colour}">Department</span>
        <h2 class="mt-1.5 text-base font-semibold text-slate-800 dark:text-slate-100 leading-tight">${esc(departmentLabel(bucket))}</h2>
        <div class="text-xs text-slate-500">${members.length} member${members.length === 1 ? '' : 's'}</div>
      </div>
      <div class="overflow-y-auto flex-1 px-4 py-3 space-y-4 text-sm">
        ${
          shared
            ? `<p class="text-xs text-slate-500 dark:text-slate-400">These entities touch more than one department, so they're grouped together rather than belonging to any single one.</p>`
            : ''
        }
        <div class="flex flex-wrap gap-1">${counts}</div>
        ${crossing(inbound, (e) => e.source, 'Reached from')}
        ${crossing(outbound, (e) => e.target, 'Routes out to')}
        <div>
          <h3 class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Members</h3>
          ${memberList || '<p class="text-slate-400">Nothing in this department.</p>'}
        </div>
      </div>
    </div>`

  container.querySelectorAll<HTMLElement>('[data-nav]').forEach((el) => {
    el.addEventListener('click', () => ctx.onNavigate(el.dataset.nav!))
  })
  container.querySelector('#hide')?.addEventListener('click', ctx.onHide)
  const back = container.querySelector<HTMLButtonElement>('#back')
  if (back && ctx.canGoBack) back.addEventListener('click', ctx.onBack)
}

export interface EdgeDetail {
  sourceId: string
  targetId: string
  kind: string
  labels: string[]
  /** The single route that was clicked, when a split-out route edge was tapped. */
  tappedLabel?: string
}

/** Render a tapped link/edge into the same details panel used for nodes. */
export function renderEdgeDetails(container: HTMLElement, info: EdgeDetail, ctx: Ctx): void {
  const nodeById = new Map(ctx.graph.nodes.map((n) => [n.id, n]))
  const isSelf = info.sourceId === info.targetId
  const chip = (id: string): string => {
    const n = nodeById.get(id)
    if (!n) return `<span class="text-slate-500">${esc(id)}</span>`
    const meta = NODE_KIND_META[n.kind]
    return `<button data-nav="${esc(id)}" class="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-left">
      <span class="w-2 h-2 rounded-full shrink-0" style="background:${meta.color}"></span>
      <span class="text-slate-700 dark:text-slate-200">${esc(n.label)}${n.number ? ` <span class="text-slate-400 font-mono">${esc(n.number)}</span>` : ''}</span>
    </button>`
  }
  const arrowTarget = isSelf
    ? `<span class="text-slate-400">↺ loops back</span>`
    : `<span class="text-slate-400 text-lg">→</span>${chip(info.targetId)}`
  // When one of the split-out route edges was clicked, mark that route so the
  // list echoes what's highlighted on the canvas.
  const rels = info.labels.length
    ? `<ul class="space-y-1">${info.labels
        .map((l) => {
          const on = info.tappedLabel !== undefined && l === info.tappedLabel
          return `<li class="flex items-start gap-2 ${on ? 'font-semibold' : ''}"><span class="${on ? 'text-sky-500' : 'text-slate-400'}">${on ? '▸' : '•'}</span><span class="${on ? 'text-sky-700 dark:text-sky-300' : 'text-slate-700 dark:text-slate-200'} break-words">${esc(l)}</span></li>`
        })
        .join('')}</ul>${
        info.labels.length > 1
          ? `<p class="text-[11px] text-slate-400 mt-1.5">Each route is drawn separately while this link is selected.</p>`
          : ''
      }`
    : `<p class="text-slate-400">Direct link (no extra detail).</p>`

  container.innerHTML = `
    <div class="flex flex-col h-full">
      <div class="px-4 py-3 border-b border-slate-200 dark:border-slate-800 sticky top-0 bg-white dark:bg-slate-900 z-10">
        <div class="mb-1.5">
          ${panelHeaderRow({
            title: 'Details',
            side: 'right',
            hideId: 'hide',
            leading: backButton(ctx)
          })}
        </div>
        <span class="inline-block px-2 py-0.5 rounded text-[11px] font-semibold text-white bg-slate-500">${isSelf ? 'Loop-back' : 'Link'}</span>
        <h2 class="mt-1.5 text-base font-semibold text-slate-800 dark:text-slate-100 leading-tight">${esc(edgeKindLabel(info.kind))}</h2>
      </div>
      <div class="overflow-y-auto flex-1 px-4 py-3 space-y-4 text-sm">
        <div class="flex items-center gap-2 flex-wrap">${chip(info.sourceId)}${arrowTarget}</div>
        <div>
          <h3 class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">${info.labels.length > 1 ? `Routes (${info.labels.length})` : 'Route'}</h3>
          ${rels}
        </div>
      </div>
    </div>`

  container.querySelectorAll<HTMLElement>('[data-nav]').forEach((el) => {
    el.addEventListener('click', () => ctx.onNavigate(el.dataset.nav!))
  })
  container.querySelector('#hide')?.addEventListener('click', ctx.onHide)
  const back = container.querySelector<HTMLButtonElement>('#back')
  if (back && ctx.canGoBack) back.addEventListener('click', ctx.onBack)
}

/** Readable name for an edge kind, shown in the link details header. */
function edgeKindLabel(kind: string): string {
  switch (kind) {
    case 'route':
      return 'Route'
    case 'overflow':
      return 'Overflow / no-answer'
    case 'afterhours':
      return 'After-hours route'
    case 'forward':
      return 'Call forwarding'
    case 'agent':
      return 'Queue agent'
    case 'manager':
      return 'Queue manager'
    case 'member':
      return 'Group member'
    case 'trunk':
      return 'Trunk'
    default:
      return 'Link'
  }
}

function relSection(
  title: string,
  edges: GraphEdge[],
  pickId: (e: GraphEdge) => string,
  nodeById: Map<string, GraphNode>
): string {
  const rows = edges
    .map((e) => {
      const other = nodeById.get(pickId(e))
      if (!other) return ''
      const meta = NODE_KIND_META[other.kind]
      // A collapsed edge may carry several relationships to the same target.
      const many = e.labels.length > 1
      const right = many ? `${e.labels.length} routes` : (e.labels[0] ?? '')
      const detail = many
        ? `<div class="pl-4 -mt-0.5 mb-1 text-[10px] text-slate-400">${esc(e.labels.join(' · '))}</div>`
        : ''
      return `
        <li>
          <button data-nav="${esc(other.id)}" class="w-full text-left flex items-center gap-2 px-2 py-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800">
            <span class="w-2 h-2 rounded-full shrink-0" style="background:${meta.color}"></span>
            <span class="flex-1 truncate text-slate-700 dark:text-slate-200">${esc(other.label)}${other.number ? ` <span class="text-slate-400 font-mono">${esc(other.number)}</span>` : ''}</span>
            ${right ? `<span class="text-[10px] text-slate-400 shrink-0">${esc(right)}</span>` : ''}
          </button>
          ${detail}
        </li>`
    })
    .join('')
  if (!rows) return ''
  return `
    <div>
      <h3 class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">${esc(title)} <span class="text-slate-400">(${edges.length})</span></h3>
      <ul class="space-y-0.5">${rows}</ul>
    </div>`
}

/** A small coloured presence dot (matches the on-canvas badge), or a hollow dot
 *  when there's no presence signal. */
function presenceDot(raw: Record<string, unknown>): string {
  const p = presenceOf(raw)
  const meta = p ? PRESENCE_META[p] : null
  const color = meta?.color ?? 'transparent'
  const border = meta ? '' : 'border border-slate-300 dark:border-slate-600'
  const title = meta ? esc(meta.label) : 'Unknown'
  return `<span class="w-2.5 h-2.5 rounded-full shrink-0 ${border}" style="background:${color}" title="${title}"></span>`
}

/** A "logged in" / "logged out" pill. `perQueue` is this queue's own state when a
 *  3CX build actually reports one; otherwise the extension's effective state is
 *  used (QueueStatus corrected for an auto-log-out profile), with the reason in
 *  the tooltip. */
function loginBadge(raw: Record<string, unknown>, perQueue?: boolean): string {
  const state = perQueue === undefined ? queueLoginState(raw) : { loggedIn: perQueue }
  if (!state) return ''
  const cls = state.loggedIn
    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
    : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
  const reason = 'reason' in state ? state.reason : undefined
  const title =
    reason ??
    (perQueue === undefined
      ? 'The extension&apos;s queue login status'
      : 'This queue only — the agent may differ in other queues')
  return `<span class="px-1.5 py-0.5 rounded-full text-[9px] font-semibold shrink-0 ${cls}" title="${esc(title)}">${state.loggedIn ? 'logged in' : 'logged out'}${reason ? ' ⓘ' : ''}</span>`
}

/** Extensions: the queues they're an agent of (incoming `agent` edges), each with
 *  the extension's global logged-in/out state. */
function queueMembershipSection(
  node: GraphNode,
  inc: GraphEdge[],
  nodeById: Map<string, GraphNode>
): string {
  // Keep the edge alongside the queue: login state is per queue↔agent link.
  const queues = inc
    .filter((e) => e.kind === 'agent')
    .map((e) => ({ queue: nodeById.get(e.source), edge: e }))
    .filter((x): x is { queue: GraphNode; edge: GraphEdge } => !!x.queue && x.queue.kind === 'queue')
  if (!queues.length) return ''
  const rows = queues
    .map(
      ({ queue: q, edge }) => `
      <li>
        <button data-nav="${esc(q.id)}" class="w-full text-left flex items-center gap-2 px-2 py-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800">
          <span class="w-2 h-2 rounded-full shrink-0" style="background:${NODE_KIND_META.queue.color}"></span>
          <span class="flex-1 truncate text-slate-700 dark:text-slate-200">${esc(q.label)}${q.number ? ` <span class="text-slate-400 font-mono">${esc(q.number)}</span>` : ''}</span>
          ${loginBadge(node.raw, edge.agentLoggedIn)}
        </button>
      </li>`
    )
    .join('')
  const perQueue = queues.filter((x) => x.edge.agentLoggedIn !== undefined)
  const loggedIn = perQueue.filter((x) => x.edge.agentLoggedIn).length
  // When 3CX reports real per-queue state, summarise it. Otherwise say so
  // outright: the same extension-wide status is repeated on every row, and a
  // supervisor's per-queue logout lives in the MyPhone service, not the API we
  // read — so without this note the rows look more precise than they are.
  const summary = perQueue.length
    ? `<p class="text-[10px] text-slate-400 mb-1">Logged in to ${loggedIn} of ${perQueue.length} queue${perQueue.length === 1 ? '' : 's'}.</p>`
    : queueLoginState(node.raw)
      ? `<p class="text-[10px] text-slate-400 mb-1">Status shown is extension-wide — the configuration API reports one value, so a per-queue logout set by a supervisor won't appear here.</p>`
      : ''
  return `
    <div>
      <h3 class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Queues <span class="text-slate-400">(${queues.length})</span></h3>
      ${summary}
      <ul class="space-y-0.5">${rows}</ul>
    </div>`
}

/** Queues / ring groups: who is in it — each member's live presence + login. */
function memberStatusSection(
  node: GraphNode,
  out: GraphEdge[],
  nodeById: Map<string, GraphNode>
): string {
  const members = out
    .filter((e) => e.kind === 'agent' || e.kind === 'member')
    .map((e) => ({ user: nodeById.get(e.target), edge: e }))
    .filter((x): x is { user: GraphNode; edge: GraphEdge } => !!x.user && x.user.kind === 'user')
  if (!members.length) return ''
  const isQueue = node.kind === 'queue'
  const rows = members
    .map(
      ({ user: u, edge }) => `
      <li>
        <button data-nav="${esc(u.id)}" class="w-full text-left flex items-center gap-2 px-2 py-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800">
          ${presenceDot(u.raw)}
          <span class="flex-1 truncate text-slate-700 dark:text-slate-200">${esc(u.label)}${u.number ? ` <span class="text-slate-400 font-mono">${esc(u.number)}</span>` : ''}</span>
          ${isQueue ? loginBadge(u.raw, edge.agentLoggedIn) : ''}
        </button>
      </li>`
    )
    .join('')
  const title = isQueue ? 'In this queue' : 'Members'
  // How many are serving THIS queue, which is what a supervisor cares about.
  const perQueue = members.filter((x) => x.edge.agentLoggedIn !== undefined)
  const summary =
    isQueue && perQueue.length
      ? `<p class="text-[10px] text-slate-400 mb-1">${perQueue.filter((x) => x.edge.agentLoggedIn).length} of ${perQueue.length} logged in to this queue.</p>`
      : ''
  return `
    <div>
      <h3 class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">${title} <span class="text-slate-400">(${members.length})</span></h3>
      ${summary}
      <ul class="space-y-0.5">${rows}</ul>
    </div>`
}

/** The outbound dial-plan rules that leave the system down this trunk / bridge.
 *  A busy line carries dozens, which as flat "Sends …" fact rows pushed
 *  everything else off the panel — so they're collapsed into their own section,
 *  closed by default with the count on the summary. */
function outboundRulesSection(node: GraphNode): string {
  const rules = node.outboundRules ?? []
  if (!rules.length) return ''
  const rows = rules
    .map(
      (r) =>
        `<li class="flex items-start gap-2 px-1 py-0.5"><span class="text-slate-400">•</span><span class="flex-1 break-words text-slate-700 dark:text-slate-300">${esc(r)}</span></li>`
    )
    .join('')
  return `<details class="group">
    <summary class="cursor-pointer text-xs font-semibold text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 select-none">Outbound Rules <span class="text-slate-400">(${rules.length})</span></summary>
    <ul class="mt-1 space-y-0.5 text-[11px]">${rows}</ul>
  </details>`
}

function keyFacts(node: GraphNode, agentEdges: GraphEdge[] = []): string {
  const r = node.raw
  const rows: [string, unknown][] = []
  const add = (label: string, ...keys: string[]): void => {
    for (const k of keys) {
      const v = r[k]
      if (v !== undefined && v !== null && v !== '' && typeof v !== 'object') {
        rows.push([label, v])
        return
      }
    }
  }
  switch (node.kind) {
    case 'user': {
      add('Registered', 'IsRegistered')
      // Per-queue login when 3CX reported it (an agent can be out of one queue
      // and in another), else the extension's single global status.
      const perQueue = agentEdges.filter((e) => e.agentLoggedIn !== undefined)
      if (perQueue.length) {
        const inCount = perQueue.filter((e) => e.agentLoggedIn).length
        rows.push([
          'Queue logins',
          inCount === perQueue.length
            ? `All ${perQueue.length}`
            : `${inCount} of ${perQueue.length}`
        ])
      } else {
        const st = queueLoginState(r)
        if (st) {
          rows.push([
            'Logged into queues',
            st.loggedIn ? 'Yes' : st.reason ? 'No — auto logged out' : 'No'
          ])
        }
      }
      add('Current Ext Status', 'CurrentProfileName')
      add('Email', 'Email', 'EmailAddress')
      add('Mobile', 'Mobile')
      break
    }
    case 'queue':
      add('Strategy', 'PollingStrategy', 'Strategy')
      add('Ring timeout', 'RingTimeout', 'PollingTime')
      break
    case 'ringGroup':
      add('Strategy', 'RingStrategy')
      break
    case 'trunk':
      add('Provider', 'ProviderName', 'AuthID')
      add('Registered', 'IsRegistered')
      add('Max calls', 'SimultaneousCalls', 'MaxSimCalls')
      break
    case 'bridge':
      add('Registered', 'IsRegistered')
      break
    case 'inboundRule':
      add('DID / Data', 'Data')
      add('Condition', 'Condition')
      break
  }
  // Queues / ring groups: managers inline (members get a richer status section).
  if (node.kind === 'queue' || node.kind === 'ringGroup') {
    const managers = memberList(r, 'Managers')
    if (managers) rows.push(['Managers', managers])
  }
  if (!rows.length) return ''
  return `<div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">${rows
    .map(
      ([k, v]) =>
        `<div class="text-slate-400">${esc(k)}</div><div class="text-slate-700 dark:text-slate-200 font-medium break-words">${esc(typeof v === 'boolean' ? (v ? 'Yes' : 'No') : v)}</div>`
    )
    .join('')}</div>`
}

/** Comma-separated list of member display names from an Agents/Members/Managers
 *  array (each `{ Number, Name }`). */
function memberList(r: Record<string, unknown>, ...keys: string[]): string {
  const out: string[] = []
  for (const key of keys) {
    const arr = r[key]
    if (!Array.isArray(arr)) continue
    for (const m of arr) {
      if (!m || typeof m !== 'object') continue
      const o = m as Record<string, unknown>
      const num = String(o.Number ?? '').trim()
      const name = String(o.Name ?? o.MemberName ?? '').trim()
      if (num || name) out.push(num || name)
    }
  }
  return out.join(', ')
}

/** Flatten the raw entity's own scalar (and simple-array) fields for the
 *  "View more info" section — a friendlier read than the raw JSON. */
function moreInfo(node: GraphNode): string {
  const rows: [string, string][] = []
  for (const [key, val] of Object.entries(node.raw)) {
    if (val === null || val === undefined || val === '') continue
    let display: string
    if (Array.isArray(val)) {
      if (!val.length || typeof val[0] === 'object') continue // skip nested collections
      display = val.join(', ')
    } else if (typeof val === 'object') {
      continue
    } else {
      display = String(val)
    }
    if (display.length > 160) display = `${display.slice(0, 160)}…`
    rows.push([humanize(key), display])
  }
  if (!rows.length) return '<p class="mt-2 text-xs text-slate-400">No additional fields.</p>'
  return `<div class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">${rows
    .map(
      ([k, v]) =>
        `<div class="text-slate-400">${esc(k)}</div><div class="text-slate-700 dark:text-slate-300 break-words">${esc(v)}</div>`
    )
    .join('')}</div>`
}

function humanize(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_.]/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase())
    .trim()
}

function outgoingTitle(kind: GraphNode['kind']): string {
  switch (kind) {
    case 'queue':
    case 'ringGroup':
      return 'Members & routing'
    case 'group':
      return 'Members'
    case 'ivr':
      return 'Menu destinations'
    case 'inboundRule':
      return 'Routes to'
    case 'trunk':
    case 'did':
      return 'Feeds into'
    default:
      return 'Routes to'
  }
}

function incomingTitle(kind: GraphNode['kind']): string {
  switch (kind) {
    case 'user':
      return 'Member of'
    case 'queue':
    case 'ringGroup':
    case 'ivr':
      return 'Reached from'
    case 'inboundRule':
      return 'From trunk / DID'
    default:
      return 'Reached from'
  }
}
