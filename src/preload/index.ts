import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { ConnectRequest, ConnectResult, Topology, UpdateStatus } from '../shared/types'

type SaveSnapshotResult = { canceled?: boolean; path?: string; error?: string }
type OpenSnapshotResult = { canceled?: boolean; topology?: Topology; error?: string }

// Custom API exposed to the renderer for talking to the 3CX backend.
const api = {
  threecx: {
    connect: (req: ConnectRequest): Promise<ConnectResult> =>
      ipcRenderer.invoke('threecx:connect', req),
    fetchTopology: (): Promise<Topology> => ipcRenderer.invoke('threecx:fetchTopology'),
    refresh: (): Promise<void> => ipcRenderer.invoke('threecx:refresh'),
    disconnect: (): Promise<void> => ipcRenderer.invoke('threecx:disconnect'),
    isConnected: (): Promise<boolean> => ipcRenderer.invoke('threecx:isConnected')
  },
  app: {
    openWindow: (hash: string): Promise<void> => ipcRenderer.invoke('app:openWindow', hash),
    copy: (text: string): Promise<void> => ipcRenderer.invoke('app:copy', text),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('app:openExternal', url),
    saveSnapshot: (topology: Topology): Promise<SaveSnapshotResult> =>
      ipcRenderer.invoke('app:saveSnapshot', topology),
    openSnapshot: (): Promise<OpenSnapshotResult> => ipcRenderer.invoke('app:openSnapshot')
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
