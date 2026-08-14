// What the report UI needs to know about the connected system: how to name a
// number, which department it belongs to, and everything a report can be scoped
// to. Assembled once from the graph (see app.ts) and passed to the report
// dialogs, so none of them need the graph itself.

import type { CallReport, ReportDirectoryEntry } from '../../../shared/types'

export type { DnKind } from '../../../shared/types'
import type { DnKind } from '../../../shared/types'

/** DNs that are call-handling infrastructure rather than a person. They must not
 *  appear as rows in per-extension activity, and a call that passed through one
 *  belongs to the extension that answered it, not to the queue it went via. */
export function isInfrastructureDn(kind: DnKind | undefined): boolean {
  return kind === 'queue' || kind === 'ringGroup' || kind === 'ivr' || kind === 'trunk'
}

/** One thing a report can be limited to — an extension, queue, ring group or IVR. */
export interface ReportTarget {
  /** The DN: extension / queue / ring-group number, as it appears in the call log. */
  number: string
  label: string
  kind: 'user' | 'queue' | 'ringGroup' | 'ivr' | 'other'
  /** The department this DN is grouped under for rollups. */
  department?: string
  /** Every department it belongs to — an extension can be in several, and a
   *  report scoped to any of them should include it. */
  departments?: string[]
}

export interface ReportContext {
  /** Extension → display name. */
  nameFor: (ext: string) => string | undefined
  /** Extension → its primary department, for the multi-tenant rollups. */
  deptFor: (ext: string) => string | undefined
  /** Extension → every department it belongs to. Filtering and scoping use this,
   *  so an extension in two departments shows up under both. */
  deptsFor: (ext: string) => string[]
  /** DN → what it is. Undefined for a DN the topology doesn't know (a deleted
   *  extension, say), which is treated as an extension so its calls aren't lost. */
  kindFor: (dn: string) => DnKind | undefined
  /** Everything on this system a report can be scoped to. */
  targets: ReportTarget[]
}

/** Everything the connected system knows about its DNs, as a report should
 *  record it. Written into the report at generation time. */
export function buildDirectory(ctx: ReportContext): ReportDirectoryEntry[] {
  return ctx.targets.map((t) => ({
    dn: t.number,
    name: t.label,
    department: t.department,
    departments: t.departments?.length ? t.departments : undefined,
    kind: ctx.kindFor(t.number) ?? t.kind
  }))
}

/** The context a given report should be read with.
 *
 *  A report is a snapshot, so its own directory wins: opening one phone system's
 *  report while connected to another used to name extensions from whichever
 *  system happened to be loaded, which meant bare numbers and no departments.
 *  The connected system is still consulted for DNs the report didn't record —
 *  and is the only source for reports written before directories existed. */
export function contextForReport(report: CallReport, live: ReportContext): ReportContext {
  const dir = report.directory
  if (!dir?.length) return live
  const byDn = new Map(dir.map((e) => [e.dn, e]))
  return {
    nameFor: (dn) => byDn.get(dn)?.name ?? live.nameFor(dn),
    deptFor: (dn) => byDn.get(dn)?.department ?? live.deptFor(dn),
    deptsFor: (dn) => {
      const e = byDn.get(dn)
      if (!e) return live.deptsFor(dn)
      return e.departments?.length ? e.departments : e.department ? [e.department] : []
    },
    kindFor: (dn) => byDn.get(dn)?.kind ?? live.kindFor(dn),
    targets: dir.map((e) => ({
      number: e.dn,
      label: e.name ?? '',
      kind: e.kind === 'trunk' || e.kind === undefined ? 'other' : e.kind,
      department: e.department,
      departments: e.departments?.length ? e.departments : e.department ? [e.department] : []
    }))
  }
}

/** Labels for the target kinds, in the order the scope picker groups them. */
export const TARGET_KIND_META: Array<{ kind: ReportTarget['kind']; label: string }> = [
  { kind: 'user', label: 'Extensions' },
  { kind: 'queue', label: 'Queues' },
  { kind: 'ringGroup', label: 'Ring groups' },
  { kind: 'ivr', label: 'IVRs' },
  { kind: 'other', label: 'Other' }
]
