// Types shared across the main, preload and renderer processes. Everything here
// is plain data that crosses the IPC boundary as JSON.

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
