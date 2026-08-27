// Types shared across the main, preload and renderer processes. Everything here
// is plain data that crosses the IPC boundary as JSON.

import type { CallDirection } from './phone'

/** Credentials + endpoint the user enters on the login screen. */
export interface ConnectRequest {
  /** Base URL of the 3CX web client, e.g. https://pbx.example.com (no path). */
  baseUrl: string
  username: string
  password: string
  /** 2FA / security code. Almost always blank for the 0000 admin account. */
  securityCode?: string
  /** Accept self-signed / mismatched TLS certs (3CX boxes usually use them). */
  allowInsecure: boolean
}

/** One connected 3CX system. Several can be open at once and switched between. */
export interface SessionInfo {
  baseUrl: string
  username: string
  /** The one the renderer is currently showing. */
  active: boolean
}

export interface ConnectResult {
  ok: boolean
  /** Human-readable error when ok === false. */
  error?: string
}

/** A single 3CX entity collection plus any error encountered fetching it. */
export interface EntitySet<T = Record<string, unknown>> {
  /** OData path used, e.g. /xapi/v1/Users. */
  path: string
  value: T[]
  error?: string
}

/** Auto-update lifecycle events, forwarded from the main process (electron-updater)
 *  to the renderer's update toast over the `updates:status` channel. */
export type UpdateStatus =
  | { kind: 'checking' }
  | { kind: 'available'; version: string }
  | { kind: 'not-available'; version: string }
  | {
      kind: 'progress'
      percent: number
      transferred: number
      total: number
      bytesPerSecond: number
    }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string }

/** One normalised call-log record used by the report engine. Fields are best-effort:
 *  3CX's call-log shape varies by version, so anything unknown is left blank. */
export interface CallLogEntry {
  /** ISO timestamp the call started, if known. */
  startTime?: string
  /** Groups the routing legs of one logical call (3CX returns a row per leg:
   *  trunk → queue → IVR → extension). Used to collapse a call to a single row
   *  in the report's "by call" view. */
  callId?: string
  /** Caller (source) number/extension. */
  from?: string
  /** Callee (destination) number/extension. */
  to?: string
  /** The DN 3CX gave for each side — the extension / queue / trunk pseudo-DN, as
   *  opposed to the caller-id in `from`/`to`. Kept so a report can be scoped to
   *  chosen extensions or queues even when a presented caller-id hides the DN. */
  srcDn?: string
  dstDn?: string
  /** Whether the call was answered/connected. */
  answered?: boolean
  /** Talk/ring duration in seconds, if known. */
  durationSec?: number
  /** 'Inbound' | 'Outbound' | 'Internal' when derivable. */
  direction?: string
  /** Normalised direction the report groups by. Home-country independent. */
  directionNorm?: CallDirection
  /** The internal extension the call is attributed to (source or destination). */
  extension?: string
  /** The other (external) party's number, when the call has one. */
  external?: string
  /** Dialling code of the external number when written in international form
   *  (e.g. "44"). Absent for domestic-format or internal calls. */
  intlCode?: string
  /** Country name for `intlCode`, e.g. "United Kingdom". */
  country?: string
  /** Trunk the call used, parsed from the 3CX `Reason` string, e.g. "SIP3". */
  trunk?: string
  /** The trunk's own number, also from `Reason` — the strongest signal for which
   *  country the PBX itself sits in (see guessHomeCountry). */
  trunkNumber?: string
  /** This leg mentions voicemail. Note it is set on BOTH segments of a call that
   *  rang out: the ring itself says "forwarded to Voicemail Box" in its reason.
   *  Only the ANSWERED one is voicemail taking the message — the unanswered one
   *  is the person missing the call, and still counts as a ring at them. */
  toVoicemail?: boolean
  /** Original record. No longer stored by new reports: it duplicated every
   *  normalised field and roughly doubled the size of a report on disk and over
   *  IPC, which is what made large periods slow. Reports saved before Beta 9
   *  still carry it, so it stays readable. */
  raw?: Record<string, unknown>
}

/** Per-extension activity rollup derived from the call log. */
export interface ExtensionActivity {
  extension: string
  name?: string
  received: number
  answered: number
  missed: number
  placed: number
  totalTalkSec: number
  active: boolean
}

/** What a DN in the call log actually is. The log itself gives no hint — a queue,
 *  a ring group and a trunk all appear as short all-digit numbers — so it's
 *  resolved from the topology and recorded with the report. */
export type DnKind = 'user' | 'queue' | 'ringGroup' | 'ivr' | 'trunk' | 'other'

/** One DN as the system described it when the report was generated. */
export interface ReportDirectoryEntry {
  dn: string
  name?: string
  /** Primary department, used for rollups. */
  department?: string
  /** Every department this DN belongs to — an extension can be in several. */
  departments?: string[]
  kind?: DnKind
}

/** The scope a report was generated for: the whole system, or a chosen set of
 *  extensions / queues / ring groups (possibly picked by department). Recorded on
 *  the report so the view can say what it covers, and so a re-run is reproducible. */
export interface ReportScope {
  /** DNs (extension / queue / ring-group numbers) the report was limited to.
   *  Empty or absent = the whole system. */
  dns?: string[]
  /** Human-readable summary of the selection, e.g. "Sales, Support (14 of 210)". */
  label?: string
  /** Call directions kept. Absent = all three. */
  directions?: CallDirection[]
  /** Departments the user picked, when the selection was made that way. The
   *  report opens filtered to these, so it shows what it was generated for. */
  departments?: string[]
}

/** Everything the user chooses in the "Generate report" dialog. Crosses IPC to
 *  start a background generation job. */
export interface ReportRequest {
  /** Inclusive period bounds as ISO instants — `from` is the first moment of the
   *  "From" day and `to` the last moment of the "To" day, both in local time. */
  from: string
  to: string
  /** File-name stem and display title. Blank = derived from host + period. */
  name?: string
  scope?: ReportScope
  /** ISO2 home country the user picked, stamped onto the report so it opens with
   *  the same national/international baseline it was generated under. */
  homeCountry?: string
  /** Names, departments and kinds for every DN on the system, recorded with the
   *  report so it reads correctly later — see CallReport.directory. */
  directory?: ReportDirectoryEntry[]
}

/** A report generation job running in the main process. Generation continues
 *  when the setup dialog is dismissed, so the UI tracks it through these. */
export interface ReportJob {
  id: string
  /** Display name (the report's own name). */
  name: string
  /** Period summary, e.g. "1 Jul → 31 Jul". */
  period: string
  startedAt: string
  status: 'running' | 'done' | 'error' | 'canceled'
  /** What the job is doing right now, for the tray tooltip. */
  phase: string
  /** Call-log rows fetched so far. */
  rows: number
  /** Total rows the server said it has, when it reports a count. */
  total?: number
  /** 0–1 when `total` is known; absent while indeterminate. */
  progress?: number
  /** Where the finished report was written. */
  path?: string
  error?: string
  finishedAt?: string
}

/** A generated call-activity report: either a period snapshot (call log for a
 *  date range) or a live snapshot (currently active calls). Saved as JSON and
 *  reopened into the interactive report panel. */
export interface CallReport {
  /** Marker so a loaded file can be recognised as a report, not a topology. */
  kind: 'call-report'
  generatedAt: string
  baseUrl: string
  /** true = live active-calls snapshot; false = historical period. */
  live: boolean
  /** Period bounds (ISO) for a historical report. Both are inclusive: `from` is
   *  the start of the first day and `to` the last instant of the last day. */
  from?: string
  to?: string
  /** User-chosen report name, shown as the title when present. */
  name?: string
  /** What the report was limited to, when it wasn't the whole system. */
  scope?: ReportScope
  /** Who each DN was when the report was generated. Without this the report has
   *  to name its extensions from whichever system happens to be open, so opening
   *  one system's report while connected to another showed bare numbers and no
   *  departments. Reports written before Beta 9 have none, and fall back to the
   *  connected system as before. */
  directory?: ReportDirectoryEntry[]
  /** Best-guess home country (ISO2) for national/international classification,
   *  inferred from the call log. The report UI lets the user override it. */
  homeCountry?: string
  entries: CallLogEntry[]
  perExtension: ExtensionActivity[]
  /** Non-fatal problem fetching the data (e.g. endpoint gated by licence). */
  error?: string
  /** How the call log was actually read. Shown under the error banner so an
   *  unexpectedly empty report says which endpoint answered and which step
   *  emptied it, instead of leaving that to be guessed at. */
  diagnostics?: ReportDiagnostics
}

export interface ReportDiagnostics {
  /** The call-log endpoint that answered. */
  endpoint?: string
  /** The window actually requested of 3CX (wider than the report's period). */
  window?: { from: string; to: string }
  /** Rows 3CX returned, before any filtering. */
  fetched: number
  /** Rows left after trimming to the requested period. */
  inPeriod: number
  /** Rows left after the scope filter — what the report holds. */
  kept: number
  /** Candidate endpoints that failed, and why. */
  failures?: string[]
}

export type GenerateReportResult = { report?: CallReport; path?: string; error?: string }
export type OpenReportResult = { canceled?: boolean; report?: CallReport; error?: string }
export type SaveReportResult = { canceled?: boolean; path?: string; error?: string }
export interface SavedReportInfo {
  path: string
  /** File name on disk. */
  name: string
  /** The report's own title, when it was given one. */
  title?: string
  generatedAt: string
  live: boolean
  /** Bytes on disk, so the tray can show how heavy a report is. */
  size?: number
  /** Period summary, e.g. "1 Jul → 31 Jul". */
  period?: string
}

/** Every collection the topology graph is built from. Each may be empty/errored. */
export interface Topology {
  fetchedAt: string
  baseUrl: string
  users: EntitySet
  queues: EntitySet
  ringGroups: EntitySet
  receptionists: EntitySet
  inboundRules: EntitySet
  outboundRules: EntitySet
  didNumbers: EntitySet
  trunks: EntitySet
  groups: EntitySet
  /** Route points: the DNs a Call Flow Designer script is deployed on. Optional
   *  because snapshots written before this existed simply won't have it. */
  callFlowApps?: EntitySet

  // --- Configuration beyond the call-flow spine -----------------------------
  // Not used to build the graph. These exist so Deep Search can answer "where is
  // this number configured?" about the parts of the system the topology never
  // draws - a park orbit, a DECT handset's line, the fax DN, a prompt filename.
  // All optional: a snapshot written before they existed simply won't have them,
  // and a PBX that doesn't expose one yields an empty set rather than an error.

  /** Park orbits (`*0`, `*1`, …). Real DNs the graph only ever synthesised. */
  parkings?: EntitySet
  /** DECT / FXS base stations, and the extensions bound to each of their lines. */
  fxs?: EntitySet
  /** Fax extensions. */
  fax?: EntitySet
  /** The company phonebook - the best answer for an EXTERNAL number. */
  contacts?: EntitySet
  /** Uploaded prompt files. Joins an IVR's `PromptFilename`. */
  customPrompts?: EntitySet
  /** Prompt sets. `PromptSet` GUIDs on users/queues/IVRs join `Folder` here. */
  promptSets?: EntitySet
  /** Holidays, as their own records rather than only nested under a department. */
  holidays?: EntitySet
  /** Blocked caller numbers. */
  blackListNumbers?: EntitySet
  /** IP allow/block entries. */
  blocklist?: EntitySet
  /** Emergency locations. Joins a user's `EmergencyLocationId`. */
  emergencyLocations?: EntitySet
  /** Registered SIP devices. */
  sipDevices?: EntitySet
  /** Session border controllers. */
  sbcs?: EntitySet
  /** System-wide settings, one record each: the voicemail / conference / fax /
   *  parking DNs live here, and are otherwise only ever guessed at from a
   *  routing reference that points at them. */
  systemSettings?: EntitySet
}
