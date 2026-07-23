import { app, shell, BrowserWindow, ipcMain, clipboard, Menu, dialog } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import type { CallReport, Topology, EntitySet } from '../shared/types'
import { redactSecrets } from '../shared/redact'
import { registerThreecxIpc } from './threecx/ipc'
import { fetchActiveCalls, fetchCallReport } from './threecx/client'
import { initUpdater } from './updater'

/** App-managed directory where generated reports are stored. Created on startup
 *  if it doesn't already exist. */
function reportsDir(): string {
  return join(app.getPath('userData'), 'reports')
}

async function ensureReportsDir(): Promise<string> {
  const dir = reportsDir()
  await fs.mkdir(dir, { recursive: true })
  return dir
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

/** Validate parsed JSON is a saved call report (guards Open report against
 *  unrelated / hand-edited files). */
function normalizeReport(raw: unknown): CallReport | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.kind !== 'call-report' || !Array.isArray(o.entries)) return null
  return redactSecrets<CallReport>(o as unknown as CallReport)
}

/** Safe filename fragment from a base URL / label. */
function safeName(s: string): string {
  return s
    .replace(/^https?:\/\//, '')
    .replace(/[^\w.-]/g, '_')
    .slice(0, 60)
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

  // --- Call-activity reports ------------------------------------------------

  // Generate a historical report for a period, saving it into the managed
  // reports directory so it can be reopened later.
  ipcMain.handle('report:generate', async (_evt, fromISO: string, toISO: string) => {
    try {
      const report = await fetchCallReport(fromISO, toISO)
      const dir = await ensureReportsDir()
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const path = join(dir, `report-${safeName(report.baseUrl)}-${stamp}.json`)
      await fs.writeFile(path, JSON.stringify(report, null, 2), 'utf8')
      return { report, path }
    } catch (err) {
      return { error: (err as Error).message }
    }
  })

  // Live snapshot of active calls (not auto-persisted).
  ipcMain.handle('report:live', async () => {
    try {
      return { report: await fetchActiveCalls() }
    } catch (err) {
      return { error: (err as Error).message }
    }
  })

  // Save a report to a user-chosen file (defaulting to the reports directory).
  ipcMain.handle('report:save', async (evt, report: CallReport) => {
    const win = BrowserWindow.fromWebContents(evt.sender)
    const dir = await ensureReportsDir()
    const stamp = (report?.generatedAt ?? new Date().toISOString()).replace(/[:.]/g, '-')
    const opts = {
      title: 'Save report',
      defaultPath: join(
        dir,
        `report-${safeName(String(report?.baseUrl ?? 'system'))}-${stamp}.json`
      ),
      filters: [{ name: 'Espionage report', extensions: ['json'] }]
    }
    const result = await (win ? dialog.showSaveDialog(win, opts) : dialog.showSaveDialog(opts))
    if (result.canceled || !result.filePath) return { canceled: true }
    try {
      await fs.writeFile(result.filePath, JSON.stringify(report, null, 2), 'utf8')
      return { path: result.filePath }
    } catch (err) {
      return { error: `Could not save report: ${(err as Error).message}` }
    }
  })

  // Open a previously-saved report.
  ipcMain.handle('report:open', async (evt) => {
    const win = BrowserWindow.fromWebContents(evt.sender)
    const dir = await ensureReportsDir()
    const opts = {
      title: 'Open report',
      defaultPath: dir,
      properties: ['openFile' as const],
      filters: [{ name: 'Espionage report', extensions: ['json'] }]
    }
    const result = await (win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts))
    if (result.canceled || !result.filePaths[0]) return { canceled: true }
    const filePath = result.filePaths[0]
    try {
      const stat = await fs.stat(filePath)
      if (stat.size > 100 * 1024 * 1024) return { error: 'Report file is too large (over 100 MB).' }
      const report = normalizeReport(JSON.parse(await fs.readFile(filePath, 'utf8')))
      if (!report) return { error: 'That file is not a valid Espionage report.' }
      return { report }
    } catch (err) {
      return { error: `Could not read report: ${(err as Error).message}` }
    }
  })

  // Export the current (filtered) report view as a CSV file.
  ipcMain.handle('report:exportCsv', async (evt, defaultName: string, content: string) => {
    const win = BrowserWindow.fromWebContents(evt.sender)
    const dir = await ensureReportsDir()
    const opts = {
      title: 'Export CSV',
      defaultPath: join(dir, safeName(defaultName) || 'report.csv'),
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    }
    const result = await (win ? dialog.showSaveDialog(win, opts) : dialog.showSaveDialog(opts))
    if (result.canceled || !result.filePath) return { canceled: true }
    try {
      // Prepend a UTF-8 BOM so Excel reads accented country names correctly.
      await fs.writeFile(result.filePath, '﻿' + content, 'utf8')
      return { path: result.filePath }
    } catch (err) {
      return { error: `Could not export CSV: ${(err as Error).message}` }
    }
  })

  // Export the current (filtered) report view as a PDF, rendered from an HTML
  // document via a hidden window (no external PDF dependency).
  ipcMain.handle('report:exportPdf', async (evt, defaultName: string, html: string) => {
    const win = BrowserWindow.fromWebContents(evt.sender)
    const dir = await ensureReportsDir()
    const opts = {
      title: 'Export PDF',
      defaultPath: join(dir, safeName(defaultName) || 'report.pdf'),
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    }
    const result = await (win ? dialog.showSaveDialog(win, opts) : dialog.showSaveDialog(opts))
    if (result.canceled || !result.filePath) return { canceled: true }
    const tmp = join(app.getPath('temp'), `espionage-report-${Date.now()}.html`)
    const pdfWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
    try {
      await fs.writeFile(tmp, html, 'utf8')
      await pdfWin.loadFile(tmp)
      const pdf = await pdfWin.webContents.printToPDF({ printBackground: true, pageSize: 'A4' })
      await fs.writeFile(result.filePath, pdf)
      return { path: result.filePath }
    } catch (err) {
      return { error: `Could not export PDF: ${(err as Error).message}` }
    } finally {
      pdfWin.destroy()
      fs.unlink(tmp).catch(() => undefined)
    }
  })

  // List saved reports in the managed directory (newest first).
  ipcMain.handle('report:list', async () => {
    try {
      const dir = await ensureReportsDir()
      const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'))
      const infos = await Promise.all(
        files.map(async (name) => {
          const path = join(dir, name)
          try {
            const report = normalizeReport(JSON.parse(await fs.readFile(path, 'utf8')))
            if (!report) return null
            return {
              path,
              name,
              generatedAt: report.generatedAt,
              live: report.live
            }
          } catch {
            return null
          }
        })
      )
      return infos
        .filter((i): i is NonNullable<typeof i> => !!i)
        .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))
    } catch {
      return []
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
