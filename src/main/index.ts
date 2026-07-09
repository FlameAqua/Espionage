import { app, shell, BrowserWindow, ipcMain, clipboard, Menu, dialog } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import type { Topology, EntitySet } from '../shared/types'
import { registerThreecxIpc } from './threecx/ipc'
import { initUpdater } from './updater'

/** Create a window. `hash` (e.g. "#focus=user:1001") opens it on a node. */
function createWindow(hash = ''): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    title: 'Espionage',
    autoHideMenuBar: true,
    // macOS uses the app-bundle icon; Windows/Linux take the window icon.
    ...(process.platform === 'darwin' ? {} : { icon }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // Native context menu: full cut/copy/paste on editable fields (login inputs,
  // search…); a plain Copy on any other selected text (details panel, raw JSON).
  mainWindow.webContents.on('context-menu', (_evt, params) => {
    if (params.isEditable) {
      Menu.buildFromTemplate([
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { type: 'separator' },
        { role: 'selectAll' }
      ]).popup({ window: mainWindow })
    } else if (params.selectionText.trim()) {
      Menu.buildFromTemplate([{ role: 'copy' }]).popup({ window: mainWindow })
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] + hash)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'), hash ? { hash } : undefined)
  }
}

/** Coerce an unknown value into a valid EntitySet so a hand-edited or partial
 *  snapshot can't crash the renderer's topology builder. */
function asEntitySet(v: unknown): EntitySet {
  if (v && typeof v === 'object' && Array.isArray((v as EntitySet).value)) {
    const s = v as EntitySet
    return { path: String(s.path ?? ''), value: s.value, error: s.error }
  }
  return { path: '', value: [] }
}

/** Normalise arbitrary parsed JSON into a Topology, or null if it plainly isn't
 *  a snapshot. Guarantees every EntitySet field exists so the renderer is safe. */
function normalizeTopology(raw: unknown): Topology | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  // A real snapshot has a base URL and/or user data; reject unrelated JSON.
  if (!o.baseUrl && !o.users) return null
  return {
    fetchedAt: String(o.fetchedAt ?? ''),
    baseUrl: String(o.baseUrl ?? ''),
    users: asEntitySet(o.users),
    queues: asEntitySet(o.queues),
    ringGroups: asEntitySet(o.ringGroups),
    receptionists: asEntitySet(o.receptionists),
    inboundRules: asEntitySet(o.inboundRules),
    outboundRules: asEntitySet(o.outboundRules),
    didNumbers: asEntitySet(o.didNumbers),
    trunks: asEntitySet(o.trunks),
    groups: asEntitySet(o.groups)
  }
}

function registerAppIpc(): void {
  ipcMain.handle('app:openWindow', (_evt, hash: string) => createWindow(hash))
  ipcMain.handle('app:copy', (_evt, text: string) => clipboard.writeText(text))
  ipcMain.handle('app:openExternal', (_evt, url: string) => {
    // Only ever open web links (e.g. the 3CX console), never file:// etc.
    if (/^https?:\/\//i.test(url)) return shell.openExternal(url)
    return undefined
  })

  // Save the current topology to a user-chosen JSON file (offline documentation
  // / sharing without credentials).
  ipcMain.handle('app:saveSnapshot', async (evt, topology: Topology) => {
    const win = BrowserWindow.fromWebContents(evt.sender)
    const host = String(topology?.baseUrl ?? 'system')
      .replace(/^https?:\/\//, '')
      .replace(/[^\w.-]/g, '_')
    const opts = {
      title: 'Save snapshot',
      defaultPath: `espionage-${host || 'system'}.json`,
      filters: [{ name: 'Espionage snapshot', extensions: ['json'] }]
    }
    const result = await (win ? dialog.showSaveDialog(win, opts) : dialog.showSaveDialog(opts))
    if (result.canceled || !result.filePath) return { canceled: true }
    try {
      await fs.writeFile(result.filePath, JSON.stringify(topology, null, 2), 'utf8')
      return { path: result.filePath }
    } catch (err) {
      return { error: `Could not save snapshot: ${(err as Error).message}` }
    }
  })

  // Load a previously-saved snapshot for offline viewing.
  ipcMain.handle('app:openSnapshot', async (evt) => {
    const win = BrowserWindow.fromWebContents(evt.sender)
    const opts = {
      title: 'Open snapshot',
      properties: ['openFile' as const],
      filters: [{ name: 'Espionage snapshot', extensions: ['json'] }]
    }
    const result = await (win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts))
    if (result.canceled || !result.filePaths[0]) return { canceled: true }
    const filePath = result.filePaths[0]
    try {
      const stat = await fs.stat(filePath)
      if (stat.size > 100 * 1024 * 1024)
        return { error: 'Snapshot file is too large (over 100 MB).' }
      const topology = normalizeTopology(JSON.parse(await fs.readFile(filePath, 'utf8')))
      if (!topology) return { error: 'That file is not a valid Espionage snapshot.' }
      return { topology }
    } catch (err) {
      return { error: `Could not read snapshot: ${(err as Error).message}` }
    }
  })
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows (must match appId in electron-builder.yml
  // so Windows notifications and the NSIS auto-updater target the same app).
  electronApp.setAppUserModelId('com.espionage.app')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // 3CX API bridge + app-level helpers for the renderer.
  registerThreecxIpc()
  registerAppIpc()

  // Auto-updates: wire IPC + kick off a silent check (packaged builds only).
  initUpdater()

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
