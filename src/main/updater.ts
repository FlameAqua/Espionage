// Auto-update wiring around electron-updater.
//
// Releases live in a PUBLIC GitHub repo, so no credential is involved: the
// updater reads the release feed anonymously. The flow is driven from the UI:
// as soon as an update is found it downloads automatically (with progress), but
// it is only *installed* when the user clicks "Restart" — we never quit out from
// under them.
//
// This used to carry a read-only token embedded at build time, because the
// release repo was private. Builds that still have that token keep working
// against a public repo — GitHub accepts a valid token on public resources — so
// the token must stay ALIVE until those builds have updated past this one.
// Revoking it while they are still out there answers 401 and strands them on
// manual downloads.

import { app, BrowserWindow, ipcMain } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateStatus } from '../shared/types'

const { autoUpdater } = electronUpdater

// --- Update source --------------------------------------------------------
// The repository that hosts the release assets + latest.yml. Keep in step with
// the `publish` block in electron-builder.yml.
const OWNER = 'FlameAqua'
const REPO = 'Espionage'

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
  // Stable releases only. With prereleases allowed, electron-updater picks the
  // newest release FLAGGED as a prerelease rather than the highest version, which
  // pins clients to the last beta forever once a stable release exists.
  autoUpdater.allowPrerelease = false

  autoUpdater.setFeedURL({ provider: 'github', owner: OWNER, repo: REPO })

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

  configure()
  // Give the first window a moment to mount its status listener before checking.
  setTimeout(() => {
    autoUpdater
      .checkForUpdates()
      .catch((err) => broadcast({ kind: 'error', message: (err as Error).message }))
  }, 3000)
}
