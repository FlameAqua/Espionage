// Report layout customisation: which sections show, in what order, how the
// breakdown charts are configured, and cost visibility. Persisted in
// localStorage so a chosen layout sticks between reports. Kept separate from
// report.ts so the (large) report renderer can just consume a resolved config.

export type ChartStyle = 'bar' | 'pie' | 'donut'

/** What a chart / table groups calls by. Defined here (not report.ts) so the
 *  persisted customisation can reference it without a circular import. */
export type GroupBy =
  | 'extension'
  | 'day'
  | 'country'
  | 'trunk'
  | 'direction'
  | 'scope'
  | 'hour'
  | 'department'

export type SectionId =
  | 'summary'
  | 'mainChart'
  | 'callTime'
  | 'perDay'
  | 'zones'
  | 'departments'
  | 'countries'
  | 'trunks'
  | 'queues'
  | 'extensions'

interface SectionMeta {
  id: SectionId
  label: string
  /** Chart styles this section supports (absent = not a styleable chart). */
  styles?: ChartStyle[]
  /** Only meaningful for historical (non-live) reports. */
  historicalOnly?: boolean
}

/** All report sections in their default order. The breakdown ('mainChart') now
 *  holds a user-managed list of charts, each configured inline, so it has no
 *  single style here. */
export const REPORT_SECTIONS: SectionMeta[] = [
  { id: 'summary', label: 'General statistics' },
  { id: 'mainChart', label: 'Breakdown charts' },
  { id: 'perDay', label: 'Calls per day', historicalOnly: true },
  { id: 'callTime', label: 'National vs international time', styles: ['donut', 'pie', 'bar'] },
  { id: 'zones', label: 'Call zones', styles: ['bar', 'pie', 'donut'] },
  { id: 'departments', label: 'By department' },
  { id: 'countries', label: 'Top countries' },
  { id: 'trunks', label: 'By trunk' },
  { id: 'queues', label: 'Queues, ring groups & IVRs' },
  { id: 'extensions', label: 'Per-extension activity' }
]

/** One configurable breakdown chart (the report can show several). */
export interface BreakdownChart {
  groupBy: GroupBy
  style: ChartStyle
}

export interface ReportCustomize {
  /** Layout schema version. Bumped when the DEFAULT section order changes, so a
   *  saved layout from an older version is re-seeded instead of silently pinning
   *  the old order forever (personal toggles are carried across). */
  version?: number
  /** Sections in render order, each flagged visible or hidden. */
  sections: { id: SectionId; visible: boolean }[]
  /** The breakdown charts shown in the 'mainChart' section, in order. */
  charts: BreakdownChart[]
  /** Per-section chart style (for the styleable non-breakdown sections). */
  styles: Partial<Record<SectionId, ChartStyle>>
  /** Show the estimated per-zone call cost. Off by default. */
  showZoneCost: boolean
  /** Carry the drill-downs — the call-log rows behind each extension and each
   *  queue — into the exported file. Off by default: it's the working detail
   *  that explains the figures, and on a busy month it dwarfs the report. */
  exportAllDetails: boolean
}

const KEY = 'espionage.reportCustomize'

/** Bump when the default section ORDER changes (see ReportCustomize.version). */
const SCHEMA_VERSION = 3

export function defaultReportCustomize(): ReportCustomize {
  return {
    version: SCHEMA_VERSION,
    sections: REPORT_SECTIONS.map((s) => ({ id: s.id, visible: true })),
    charts: [
      { groupBy: 'day', style: 'bar' },
      { groupBy: 'extension', style: 'bar' }
    ],
    styles: { callTime: 'donut', zones: 'bar' },
    showZoneCost: false,
    exportAllDetails: false
  }
}

/** Load the saved customisation, reconciled against the current section list so
 *  sections added in a new version appear (kept in their default position) and
 *  stale ids are dropped. */
export function loadReportCustomize(): ReportCustomize {
  const base = defaultReportCustomize()
  let saved: Partial<ReportCustomize> | null = null
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) saved = JSON.parse(raw) as Partial<ReportCustomize>
  } catch {
    /* ignore */
  }
  if (!saved) return base

  const known = new Set(REPORT_SECTIONS.map((s) => s.id))
  const savedSections = (saved.sections ?? []).filter((s) => s && known.has(s.id))
  const seen = new Set(savedSections.map((s) => s.id))
  // A layout saved before the current schema pins the OLD default order, which
  // would hide improved defaults forever — so re-seed the order on a version
  // bump. Explicit preferences (charts, styles, toggles) are still carried over.
  const stale = (saved.version ?? 1) !== SCHEMA_VERSION
  // Otherwise keep saved order, appending sections the save didn't know about.
  const sections = stale
    ? base.sections
    : [...savedSections, ...base.sections.filter((s) => !seen.has(s.id))]
  const charts = Array.isArray(saved.charts) && saved.charts.length ? saved.charts : base.charts
  return {
    version: SCHEMA_VERSION,
    sections,
    charts,
    styles: { ...base.styles, ...(saved.styles ?? {}) },
    showZoneCost: saved.showZoneCost ?? base.showZoneCost,
    exportAllDetails: saved.exportAllDetails ?? base.exportAllDetails
  }
}

export function saveReportCustomize(c: ReportCustomize): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(c))
  } catch {
    /* storage unavailable — non-fatal */
  }
}
