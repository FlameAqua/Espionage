// Auto-update wiring around electron-updater.
//
// Releases live in a PRIVATE GitHub repo, so electron-updater talks to the
// GitHub API with an embedded read-only token (see UPDATE_TOKEN below). The
// flow is driven from the UI: as soon as an update is found it downloads
// automatically (with progress), but it is only *installed* when the user
// clicks "Restart" — we never quit out from under them.

import { app, BrowserWindow, ipcMain } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateStatus } from '../shared/types'

const { autoUpdater } = electronUpdater

// --- Private-repo configuration ------------------------------------------
// Owner/repo are NOT secret. Edit them to match the repository that hosts the
// release assets + latest.yml, and keep them in sync with the `publish` block
// in electron-builder.yml.
const OWNER = 'FlameAqua'
const REPO = '3cx-spy'

// A GitHub token with read-only access to the private update repo, embedded at
// build time from MAIN_VITE_UPDATE_TOKEN (see .env.example). Without it a
// private repo returns 404 and updates silently fail.
const UPDATE_TOKEN = import.meta.env.MAIN_VITE_UPDATE_TOKEN ?? ''

function broadcast(status: UpdateStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('updates:status', status)
  }
}

let configured = false
function configure(): void {
  if (configured) return
  configured = true

  // Pull as soon as an update is found, but leave installing to the user.
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = false
  // Beta channel: let v1.0.0-beta.2 supersede v1.0.0-beta.1, and betas roll
  // forward into the eventual stable release.
  autoUpdater.allowPrerelease = true

  autoUpdater.setFeedURL({
    provider: 'github',
    owner: OWNER,
    repo: REPO,
    private: true,
    token: UPDATE_TOKEN
  })

  autoUpdater.on('checking-for-update', () => broadcast({ kind: 'checking' }))
  autoUpdater.on('update-available', (info) =>
    broadcast({ kind: 'available', version: info.version })
  )
  autoUpdater.on('update-not-available', (info) =>
    broadcast({ kind: 'not-available', version: info.version })
  )
  autoUpdater.on('download-progress', (p) =>
    broadcast({
      kind: 'progress',
      percent: p.percent,
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond
    })
  )
  autoUpdater.on('update-downloaded', (info) =>
    broadcast({ kind: 'downloaded', version: info.version })
  )
  autoUpdater.on('error', (err) =>
    broadcast({ kind: 'error', message: err?.message ?? String(err) })
  )
}

/** Wire the manual-check / install IPC handlers and kick off a silent check
 *  shortly after launch (packaged builds only). Call once from app.whenReady. */
export function initUpdater(): void {
  // Manual "Check for updates" from the burger menu.
  ipcMain.handle('updates:check', async () => {
    if (!app.isPackaged) {
      broadcast({ kind: 'error', message: 'Updates are only available in the installed app.' })
      return
    }
    configure()
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      broadcast({ kind: 'error', message: (err as Error).message })
    }
  })

  // User clicked "Restart to install" on a downloaded update.
  ipcMain.handle('updates:install', () => {
    // isSilent=false shows the NSIS progress UI; isForceRunAfter=true relaunches.
    autoUpdater.quitAndInstall(false, true)
  })

  if (!app.isPackaged) return
  if (!UPDATE_TOKEN) {
    console.warn('[updater] No MAIN_VITE_UPDATE_TOKEN embedded - private-repo updates disabled.')
    return
  }

  configure()
  // Give the first window a moment to mount its status listener before checking.
  setTimeout(() => {
    autoUpdater
      .checkForUpdates()
      .catch((err) => broadcast({ kind: 'error', message: (err as Error).message }))
  }, 3000)
}
