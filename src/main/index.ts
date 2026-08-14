import { app, shell, BrowserWindow, ipcMain, clipboard, Menu, dialog } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import type { Topology, EntitySet } from '../shared/types'
import { redactSecrets } from '../shared/redact'
import { registerThreecxIpc } from './threecx/ipc'
import { ensureReportsDir, registerReportIpc } from './reports'
import { initUpdater } from './updater'

/** Folder snapshots are offered in when the user hasn't picked one in Settings.
 *  Documents is the natural home for a file the user is meant to keep and share;
 *  Downloads is the fallback on the rare platform without a Documents path. */
function defaultSnapshotDir(): string {
  try {
    return app.getPath('documents')
  } catch {
    try {
      return app.getPath('downloads')
    } catch {
      return app.getPath('home')
    }
  }
}

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

  // Only ever hand http(s) to the OS. The `app:openExternal` IPC checks this;
  // window.open / target=_blank went straight through unchecked, so a file:// or
  // custom-scheme URL reaching the renderer would have been launched.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (/^https?:\/\//i.test(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // The window only ever shows the app's own page; nothing should navigate it
  // away, so a stray link or injected content can't replace the UI.
  mainWindow.webContents.on('will-navigate', (evt, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl && url.startsWith(devUrl)) return
    evt.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
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
  // Redact on load too, so a pre-redaction snapshot can't resurface secrets.
  return redactSecrets<Topology>({
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
  })
}

function registerAppIpc(): void {
  ipcMain.handle('app:openWindow', (_evt, hash: string) => createWindow(hash))
  ipcMain.handle('app:copy', (_evt, text: string) => clipboard.writeText(text))
  ipcMain.handle('app:openExternal', (_evt, url: string) => {
    // Only ever open web links (e.g. the 3CX console), never file:// etc.
    if (/^https?:\/\//i.test(url)) return shell.openExternal(url)
    return undefined
  })

  // Where snapshots are offered when the user hasn't chosen a folder. Resolved
  // here rather than left to the OS dialog so Settings can show the real path
  // instead of an unhelpful "system default".
  ipcMain.handle('app:defaultSnapshotDir', () => defaultSnapshotDir())

  // Save the current topology to a user-chosen JSON file (offline documentation
  // / sharing without credentials).
  ipcMain.handle('app:saveSnapshot', async (evt, topology: Topology, defaultDir?: string) => {
    const win = BrowserWindow.fromWebContents(evt.sender)
    const host = String(topology?.baseUrl ?? 'system')
      .replace(/^https?:\/\//, '')
      .replace(/[^\w.-]/g, '_')
    const fileName = `espionage-${host || 'system'}.json`
    const opts = {
      title: 'Save snapshot',
      // Start in the folder configured in Settings, else the same built-in
      // fallback Settings displays — so the dialog and the label always agree.
      defaultPath: join(defaultDir || defaultSnapshotDir(), fileName),
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

  // Pick the default folder new snapshots are offered in (Settings).
  ipcMain.handle('app:chooseFolder', async (evt, title?: string) => {
    const win = BrowserWindow.fromWebContents(evt.sender)
    const opts = {
      title: title || 'Choose folder',
      properties: ['openDirectory' as const, 'createDirectory' as const]
    }
    const result = await (win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts))
    if (result.canceled || !result.filePaths[0]) return { canceled: true }
    return { path: result.filePaths[0] }
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
  registerReportIpc()

  // Create the managed reports directory up front (generated on install/first run).
  void ensureReportsDir().catch(() => {})

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
