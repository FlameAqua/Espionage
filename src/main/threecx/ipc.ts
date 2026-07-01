// Registers the IPC handlers the renderer uses to drive the 3CX client.
import { ipcMain } from 'electron'
import type { ConnectRequest, ConnectResult, Topology } from '../../shared/types'
import * as client from './client'

export function registerThreecxIpc(): void {
  ipcMain.handle('threecx:connect', async (_evt, req: ConnectRequest): Promise<ConnectResult> => {
    try {
      await client.connect(req)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('threecx:fetchTopology', async (): Promise<Topology> => {
    return client.fetchTopology()
  })

  ipcMain.handle('threecx:disconnect', async (): Promise<void> => {
    client.disconnect()
  })

  ipcMain.handle('threecx:isConnected', async (): Promise<boolean> => {
    return client.isConnected()
  })
}
