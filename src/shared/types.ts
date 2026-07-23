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
  /** Original record, so the UI can surface fields we didn't normalise. */
  raw: Record<string, unknown>
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
  /** Period bounds (ISO) for a historical report. */
  from?: string
  to?: string
  /** Best-guess home country (ISO2) for national/international classification,
   *  inferred from the call log. The report UI lets the user override it. */
  homeCountry?: string
  entries: CallLogEntry[]
  perExtension: ExtensionActivity[]
  /** Non-fatal problem fetching the data (e.g. endpoint gated by licence). */
  error?: string
}

export type GenerateReportResult = { report?: CallReport; path?: string; error?: string }
export type OpenReportResult = { canceled?: boolean; report?: CallReport; error?: string }
export type SaveReportResult = { canceled?: boolean; path?: string; error?: string }
export interface SavedReportInfo {
  path: string
  name: string
  generatedAt: string
  live: boolean
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
}
