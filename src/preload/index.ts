import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { ConnectRequest, ConnectResult, Topology } from '../shared/types'

// Custom API exposed to the renderer for talking to the 3CX backend.
const api = {
  threecx: {
    connect: (req: ConnectRequest): Promise<ConnectResult> =>
      ipcRenderer.invoke('threecx:connect', req),
    fetchTopology: (): Promise<Topology> => ipcRenderer.invoke('threecx:fetchTopology'),
    disconnect: (): Promise<void> => ipcRenderer.invoke('threecx:disconnect'),
    isConnected: (): Promise<boolean> => ipcRenderer.invoke('threecx:isConnected')
  },
  app: {
    openWindow: (hash: string): Promise<void> => ipcRenderer.invoke('app:openWindow', hash),
    copy: (text: string): Promise<void> => ipcRenderer.invoke('app:copy', text),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('app:openExternal', url)
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
