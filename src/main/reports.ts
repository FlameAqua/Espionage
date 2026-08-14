// Call-activity reports: the managed reports folder, the background generation
// jobs, and every `report:*` IPC handler.
//
// Generation runs as a job in the main process rather than inside the renderer's
// await, so dismissing the "Generate report" dialog no longer throws the work
// away: the job keeps fetching, reports progress to every window, and can be
// cancelled from the reports tray.

import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join, resolve, sep } from 'path'
import { promises as fs } from 'fs'
import type {
  CallReport,
  ReportJob,
  ReportRequest,
  SavedReportInfo
} from '../shared/types'
import { redactSecrets } from '../shared/redact'
import { fetchActiveCalls, fetchCallReport } from './threecx/client'

/** App-managed directory where generated reports are stored. Created on startup
 *  if it doesn't already exist. */
export function reportsDir(): string {
  return join(app.getPath('userData'), 'reports')
}

export async function ensureReportsDir(): Promise<string> {
  const dir = reportsDir()
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/** Safe filename fragment from a base URL / label. Trailing dots and spaces are
 *  stripped too — Windows silently rejects a file name ending in either. */
function safeName(s: string): string {
  return (
    s
      .replace(/^https?:\/\//, '')
      .replace(/[^\w.\- ]/g, '_')
      .trim()
      .slice(0, 80)
      .replace(/[. ]+$/, '') || 'report'
  )
}

/** Validate parsed JSON is a saved call report (guards Open report against
 *  unrelated / hand-edited files). */
export function normalizeReport(raw: unknown): CallReport | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.kind !== 'call-report' || !Array.isArray(o.entries)) return null
  return redactSecrets<CallReport>(o as unknown as CallReport)
}

/** A path that doesn't exist yet, suffixing " (2)", " (3)"… on collision so a
 *  re-run with the same name never overwrites the earlier report. */
async function freePath(dir: string, stem: string): Promise<string> {
  for (let i = 1; i < 1000; i++) {
    const path = join(dir, i === 1 ? `${stem}.json` : `${stem} (${i}).json`)
    try {
      await fs.access(path)
    } catch {
      return path
    }
  }
  return join(dir, `${stem}-${Date.now()}.json`)
}

/** Day-level summary of a period, e.g. "2026-07-01 → 2026-07-31". The bounds are
 *  instants standing for local midnight either end, so they're formatted in local
 *  time — slicing the ISO string would name the previous day east of UTC. */
function localDay(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function periodLabel(from?: string, to?: string): string {
  if (!from || !to) return 'live'
  return `${localDay(from)} → ${localDay(to)}`
}

// --- Jobs --------------------------------------------------------------------

interface RunningJob {
  job: ReportJob
  abort: AbortController
}

const jobs = new Map<string, RunningJob>()
let lastBroadcast = 0
let pendingBroadcast: NodeJS.Timeout | null = null

function jobList(): ReportJob[] {
  return [...jobs.values()]
    .map((j) => j.job)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

/** Push the job list to every window. Row-count ticks are throttled; anything
 *  that changes a job's status goes out immediately. */
function broadcast(immediate = false): void {
  const send = (): void => {
    lastBroadcast = Date.now()
    const list = jobList()
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('report:jobs', list)
    }
  }
  if (pendingBroadcast) {
    clearTimeout(pendingBroadcast)
    pendingBroadcast = null
  }
  const since = Date.now() - lastBroadcast
  if (immediate || since >= 300) send()
  else
    pendingBroadcast = setTimeout(() => {
      pendingBroadcast = null
      send()
    }, 300 - since)
}

/** Finished jobs stay in the list so the tray can show what just landed, but
 *  they're cleared once there are plenty of them. */
function pruneFinished(): void {
  const done = [...jobs.values()]
    .filter((j) => j.job.status !== 'running')
    .sort((a, b) => (a.job.finishedAt ?? '').localeCompare(b.job.finishedAt ?? ''))
  for (const j of done.slice(0, Math.max(0, done.length - 8))) jobs.delete(j.job.id)
}

let jobSeq = 0

function startJob(req: ReportRequest): ReportJob {
  const id = `job-${Date.now().toString(36)}-${++jobSeq}`
  const abort = new AbortController()
  const period = periodLabel(req.from, req.to)
  const job: ReportJob = {
    id,
    name: req.name?.trim() || `Report ${period}`,
    period,
    startedAt: new Date().toISOString(),
    status: 'running',
    phase: 'Contacting 3CX…',
    rows: 0
  }
  jobs.set(id, { job, abort })
  pruneFinished()
  broadcast(true)

  void (async () => {
    try {
      const report = await fetchCallReport({
        from: req.from,
        to: req.to,
        name: req.name,
        scope: req.scope,
        homeCountry: req.homeCountry,
        directory: req.directory,
        signal: abort.signal,
        onProgress: ({ rows, total, fraction }) => {
          if (job.status !== 'running') return
          job.rows = rows
          job.total = total
          // Window count gives a real denominator even when the server won't
          // say how many rows there are.
          job.progress =
            fraction != null ? Math.min(1, fraction) : total ? Math.min(1, rows / total) : undefined
          job.phase = total
            ? `Reading call log - ${rows.toLocaleString()} of ${total.toLocaleString()} rows`
            : `Reading call log - ${rows.toLocaleString()} rows`
          broadcast()
        }
      })
      if (abort.signal.aborted) throw new Error('Canceled')

      job.phase = 'Saving…'
      job.progress = undefined
      broadcast(true)
      const dir = await ensureReportsDir()
      const path = await freePath(dir, safeName(job.name))
      // Compact, not pretty-printed: a month of call log is tens of MB.
      await fs.writeFile(path, JSON.stringify(report), 'utf8')

      job.status = 'done'
      job.path = path
      job.rows = report.entries.length
      job.progress = 1
      job.phase = report.error ?? `${report.entries.length.toLocaleString()} call records`
      job.finishedAt = new Date().toISOString()
    } catch (err) {
      const message = (err as Error).message
      const canceled = abort.signal.aborted || /canceled|abort/i.test(message)
      job.status = canceled ? 'canceled' : 'error'
      job.phase = canceled ? 'Canceled' : 'Failed'
      job.error = canceled ? undefined : message
      job.finishedAt = new Date().toISOString()
    } finally {
      broadcast(true)
    }
  })()

  return job
}

// --- Saved report metadata ---------------------------------------------------

/** A saved report's header fields, read without parsing the whole file — every
 *  field bar `entries` is written before it. */
async function readReportInfo(path: string, name: string): Promise<SavedReportInfo | null> {
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null
  try {
    const stat = await fs.stat(path)
    handle = await fs.open(path, 'r')
    const buf = Buffer.alloc(Math.min(8192, stat.size))
    await handle.read(buf, 0, buf.length, 0)
    const text = buf.toString('utf8')
    const head = text.split('"entries"')[0]
    if (!/"kind"\s*:\s*"call-report"/.test(head)) return null
    const str = (key: string): string | undefined =>
      new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`).exec(head)?.[1]
    return {
      path,
      name,
      title: str('name'),
      generatedAt: str('generatedAt') ?? new Date(stat.mtimeMs).toISOString(),
      live: /"live"\s*:\s*true/.test(head),
      size: stat.size,
      period: str('from') ? periodLabel(str('from'), str('to')) : undefined
    }
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

// --- IPC ---------------------------------------------------------------------

export function registerReportIpc(): void {
  // Start a background generation job. Returns as soon as the job exists, so the
  // dialog can be dismissed without stopping the work.
  ipcMain.handle('report:start', (_evt, req: ReportRequest) => {
    try {
      return { job: startJob(req) }
    } catch (err) {
      return { error: (err as Error).message }
    }
  })

  ipcMain.handle('report:jobs', () => jobList())

  ipcMain.handle('report:cancel', (_evt, id: string) => {
    const entry = jobs.get(id)
    if (!entry || entry.job.status !== 'running') return false
    entry.abort.abort()
    return true
  })

  /** Forget a finished job (the tray's dismiss). Running jobs are left alone. */
  ipcMain.handle('report:dismissJob', (_evt, id: string) => {
    const entry = jobs.get(id)
    if (!entry || entry.job.status === 'running') return false
    jobs.delete(id)
    broadcast(true)
    return true
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
    const stem = report?.name
      ? safeName(report.name)
      : `report-${safeName(String(report?.baseUrl ?? 'system'))}-${stamp}`
    const opts = {
      title: 'Save report',
      defaultPath: join(dir, `${stem}.json`),
      filters: [{ name: 'Espionage report', extensions: ['json'] }]
    }
    const result = await (win ? dialog.showSaveDialog(win, opts) : dialog.showSaveDialog(opts))
    if (result.canceled || !result.filePath) return { canceled: true }
    try {
      await fs.writeFile(result.filePath, JSON.stringify(report), 'utf8')
      return { path: result.filePath }
    } catch (err) {
      return { error: `Could not save report: ${(err as Error).message}` }
    }
  })

  // Open a previously-saved report through the file picker.
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
    return readReportFile(result.filePaths[0])
  })

  // Open a report by path (the reports tray, and a finished job). Confined to
  // the managed folder — an arbitrary path from the renderer would make this a
  // read-any-file primitive. Reports elsewhere go through `report:open`, which
  // the user drives with a file dialog.
  ipcMain.handle('report:load', async (_evt, path: string) => {
    if (!(await inReportsDir(path))) return { error: 'That report is outside the reports folder.' }
    return readReportFile(path)
  })

  // Export the current (filtered) report view as a CSV file.
  ipcMain.handle('report:exportCsv', async (evt, defaultName: string, content: string) => {
    const win = BrowserWindow.fromWebContents(evt.sender)
    const dir = await ensureReportsDir()
    const opts = {
      title: 'Export CSV',
      defaultPath: join(dir, safeName(defaultName)),
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
      defaultPath: join(dir, safeName(defaultName)),
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
      const infos = await Promise.all(files.map((name) => readReportInfo(join(dir, name), name)))
      return infos
        .filter((i): i is SavedReportInfo => !!i)
        .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))
    } catch {
      return []
    }
  })

  // Reveal a report (or the reports folder) in the OS file manager.
  ipcMain.handle('report:reveal', async (_evt, path?: string) => {
    if (path && (await inReportsDir(path))) shell.showItemInFolder(path)
    else await shell.openPath(await ensureReportsDir())
  })
}

/** Is this path inside the managed reports folder? Resolved first, so `..` can't
 *  walk out of it. */
async function inReportsDir(path: string): Promise<boolean> {
  if (!path) return false
  const dir = resolve(await ensureReportsDir())
  const full = resolve(path)
  return full.startsWith(dir + sep)
}

async function readReportFile(
  filePath: string
): Promise<{ report?: CallReport; error?: string; path?: string }> {
  try {
    const stat = await fs.stat(filePath)
    if (stat.size > 400 * 1024 * 1024) return { error: 'Report file is too large (over 400 MB).' }
    const report = normalizeReport(JSON.parse(await fs.readFile(filePath, 'utf8')))
    if (!report) return { error: 'That file is not a valid Espionage report.' }
    return { report, path: filePath }
  } catch (err) {
    return { error: `Could not read report: ${(err as Error).message}` }
  }
}
