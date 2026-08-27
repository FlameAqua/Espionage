import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  CallReport,
  ConnectRequest,
  ConnectResult,
  GenerateReportResult,
  OpenReportResult,
  ReportJob,
  ReportRequest,
  SaveReportResult,
  SavedReportInfo,
  SessionInfo,
  Topology,
  UpdateStatus
} from '../shared/types'

type SaveSnapshotResult = { canceled?: boolean; path?: string; error?: string }
type OpenSnapshotResult = { canceled?: boolean; topology?: Topology; error?: string }

// Custom API exposed to the renderer for talking to the 3CX backend.
const api = {
  threecx: {
    connect: (req: ConnectRequest): Promise<ConnectResult> =>
      ipcRenderer.invoke('threecx:connect', req),
    /** `includeQueueLogins` additionally reads per-queue agent login state from
     *  the web client's Switchboard (slower — see main/threecx/switchboard.ts). */
    fetchTopology: (opts?: { includeQueueLogins?: boolean }): Promise<Topology> =>
      ipcRenderer.invoke('threecx:fetchTopology', opts),
    refresh: (): Promise<void> => ipcRenderer.invoke('threecx:refresh'),
    disconnect: (baseUrl?: string): Promise<void> =>
      ipcRenderer.invoke('threecx:disconnect', baseUrl),
    /** Every system currently connected, and which one is in front. */
    sessions: (): Promise<SessionInfo[]> => ipcRenderer.invoke('threecx:sessions'),
    /** Bring an already-connected system to the front. */
    switchTo: (baseUrl: string): Promise<boolean> =>
      ipcRenderer.invoke('threecx:switch', baseUrl),
    isConnected: (): Promise<boolean> => ipcRenderer.invoke('threecx:isConnected')
  },
  app: {
    openWindow: (hash: string): Promise<void> => ipcRenderer.invoke('app:openWindow', hash),
    /** The running app's version, for Settings to show. */
    version: (): Promise<string> => ipcRenderer.invoke('app:version'),
    copy: (text: string): Promise<void> => ipcRenderer.invoke('app:copy', text),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('app:openExternal', url),
    /** `defaultDir` pre-selects the folder configured in Settings. */
    saveSnapshot: (topology: Topology, defaultDir?: string): Promise<SaveSnapshotResult> =>
      ipcRenderer.invoke('app:saveSnapshot', topology, defaultDir),
    /** The folder snapshots go to when none is configured, so Settings can show
     *  a real path rather than "system default". */
    defaultSnapshotDir: (): Promise<string> => ipcRenderer.invoke('app:defaultSnapshotDir'),
    openSnapshot: (): Promise<OpenSnapshotResult> => ipcRenderer.invoke('app:openSnapshot'),
    /** Directory picker, used to set the default snapshot folder. */
    chooseFolder: (title?: string): Promise<{ canceled?: boolean; path?: string }> =>
      ipcRenderer.invoke('app:chooseFolder', title)
  },
  report: {
    /** Start generating a historical report in the background. Resolves as soon
     *  as the job exists — closing the dialog no longer cancels the work; watch
     *  it with `onJobs` and stop it with `cancel`. */
    start: (req: ReportRequest): Promise<{ job?: ReportJob; error?: string }> =>
      ipcRenderer.invoke('report:start', req),
    /** Every generation job the main process knows about. */
    jobs: (): Promise<ReportJob[]> => ipcRenderer.invoke('report:jobs'),
    cancel: (id: string): Promise<boolean> => ipcRenderer.invoke('report:cancel', id),
    /** Forget a finished job (clears it from the tray). */
    dismissJob: (id: string): Promise<boolean> => ipcRenderer.invoke('report:dismissJob', id),
    /** Subscribe to job-list changes. Returns an unsubscribe function. */
    onJobs: (cb: (jobs: ReportJob[]) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, jobs: ReportJob[]): void => cb(jobs)
      ipcRenderer.on('report:jobs', listener)
      return () => ipcRenderer.removeListener('report:jobs', listener)
    },
    /** Read a saved report by path (a finished job, or a tray entry). */
    load: (path: string): Promise<OpenReportResult> => ipcRenderer.invoke('report:load', path),
    /** Show a report — or the reports folder itself — in the OS file manager. */
    reveal: (path?: string): Promise<void> => ipcRenderer.invoke('report:reveal', path),
    /** Live snapshot of currently active calls. */
    live: (): Promise<GenerateReportResult> => ipcRenderer.invoke('report:live'),
    save: (report: CallReport): Promise<SaveReportResult> =>
      ipcRenderer.invoke('report:save', report),
    /** Export the current (filtered) view as a CSV file. */
    exportCsv: (defaultName: string, content: string): Promise<SaveReportResult> =>
      ipcRenderer.invoke('report:exportCsv', defaultName, content),
    /** Export the current (filtered) view as a PDF (rendered from HTML). */
    exportPdf: (defaultName: string, html: string): Promise<SaveReportResult> =>
      ipcRenderer.invoke('report:exportPdf', defaultName, html),
    open: (): Promise<OpenReportResult> => ipcRenderer.invoke('report:open'),
    list: (): Promise<SavedReportInfo[]> => ipcRenderer.invoke('report:list')
  },
  updates: {
    /** Manually trigger an update check (burger menu → "Check for updates"). */
    check: (): Promise<void> => ipcRenderer.invoke('updates:check'),
    /** Quit and install a downloaded update, then relaunch. */
    install: (): Promise<void> => ipcRenderer.invoke('updates:install'),
    /** Subscribe to update lifecycle events. Returns an unsubscribe function. */
    onStatus: (cb: (status: UpdateStatus) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, status: UpdateStatus): void => cb(status)
      ipcRenderer.on('updates:status', listener)
      return () => ipcRenderer.removeListener('updates:status', listener)
    }
  }
}

export type ThreecxApi = typeof api

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
