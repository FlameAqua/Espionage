// Renders the right-hand details panel for a selected node: its key facts,
// inbound/outbound relationships (each clickable to navigate), and raw JSON.

import {
  NODE_KIND_META,
  SHARED_DEPARTMENT,
  type GraphEdge,
  type GraphNode,
  type TopologyGraph
} from '../graph/model'

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

export function renderDetails(container: HTMLElement, node: GraphNode | null, ctx: Ctx): void {
  if (!node) {
    container.innerHTML = `
      <div class="flex flex-col h-full">
        <div class="flex items-center justify-end px-2 py-2 border-b border-slate-200 dark:border-slate-800">
          <button id="hide" class="px-2 py-1 rounded text-xs text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" title="Hide panel">Hide ›</button>
        </div>
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

  // Outgoing — where this entity routes / who it contains.
  if (out.length) {
    sections.push(relSection(outgoingTitle(node.kind), out, (e) => e.target, nodeById))
  }
  // Incoming — who routes here / which groups this belongs to.
  if (inc.length) {
    sections.push(relSection(incomingTitle(node.kind), inc, (e) => e.source, nodeById))
  }

  const info = node.info?.length
    ? `<div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">${node.info
        .map(
          (f) =>
            `<div class="text-slate-400">${esc(f.label)}</div><div class="text-slate-700 dark:text-slate-200 font-medium break-words">${esc(f.value)}</div>`
        )
        .join('')}</div>`
    : ''
  const facts = keyFacts(node)
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
        <div class="flex items-center justify-between mb-1.5">
          <button id="back" class="px-2 py-0.5 rounded text-xs ${ctx.canGoBack ? 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800' : 'text-slate-300 dark:text-slate-700 cursor-default'}" ${ctx.canGoBack ? '' : 'disabled'}>‹ Back</button>
          <button id="hide" class="px-2 py-0.5 rounded text-xs text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" title="Hide panel">Hide ›</button>
        </div>
        <span class="inline-block px-2 py-0.5 rounded text-[11px] font-semibold text-white" style="background:${meta.color}">${esc(meta.label)}</span>
        <h2 class="mt-1.5 text-base font-semibold text-slate-800 dark:text-slate-100 leading-tight">${esc(node.label)}</h2>
        ${node.number ? `<div class="text-xs text-slate-500 font-mono">${node.kind === 'inboundRule' ? 'DID' : 'ext'} ${esc(node.number)}</div>` : ''}
      </div>
      <div class="overflow-y-auto flex-1 px-4 py-3 space-y-4 text-sm">
        <div id="egomap" class="h-44 w-full rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50"></div>
        ${info}
        ${depts ? `<div><h3 class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">${node.deptGroup === SHARED_DEPARTMENT ? 'Multiple departments' : 'Departments'}</h3>${depts}</div>` : ''}
        ${facts}
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

export interface EdgeDetail {
  sourceId: string
  targetId: string
  kind: string
  labels: string[]
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
  const rels = info.labels.length
    ? `<ul class="space-y-1">${info.labels
        .map(
          (l) =>
            `<li class="flex items-start gap-2"><span class="text-slate-400">•</span><span class="text-slate-700 dark:text-slate-200 break-words">${esc(l)}</span></li>`
        )
        .join('')}</ul>`
    : `<p class="text-slate-400">Direct link (no extra detail).</p>`

  container.innerHTML = `
    <div class="flex flex-col h-full">
      <div class="px-4 py-3 border-b border-slate-200 dark:border-slate-800 sticky top-0 bg-white dark:bg-slate-900 z-10">
        <div class="flex items-center justify-between mb-1.5">
          <button id="back" class="px-2 py-0.5 rounded text-xs ${ctx.canGoBack ? 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800' : 'text-slate-300 dark:text-slate-700 cursor-default'}" ${ctx.canGoBack ? '' : 'disabled'}>‹ Back</button>
          <button id="hide" class="px-2 py-0.5 rounded text-xs text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" title="Hide panel">Hide ›</button>
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

function keyFacts(node: GraphNode): string {
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
      const qs = String(r['QueueStatus'] ?? '')
      if (qs) rows.push(['Logged in', /out/i.test(qs) ? 'No' : /in/i.test(qs) ? 'Yes' : qs])
      add('Enabled', 'Enabled')
      add('Presence', 'CurrentProfileName')
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
  // Queues / ring groups: list the member extensions inline.
  if (node.kind === 'queue' || node.kind === 'ringGroup') {
    const members = memberList(r, 'Agents', 'Members')
    if (members) rows.push([node.kind === 'ringGroup' ? 'Members' : 'Agents', members])
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
