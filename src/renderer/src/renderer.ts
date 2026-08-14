// App bootstrap: toggles between the login screen and the connected graph view.
// On startup it reuses an existing main-process session (so "Open in new window"
// lands straight on the graph) and honours a #focus=<nodeId> hash.
import './index.css'
import type { ConnectRequest, Topology } from '../../shared/types'
import { renderLogin } from './ui/login'
import { loadSystems } from './ui/systems'
import { playExit } from './ui/motion'
import { readQueueLogins } from './ui/prefs'
import { renderApp, type ViewState, type AppCallbacks } from './ui/app'
import { initUpdates } from './ui/updates'

const root = document.getElementById('root')!


const LOADING_MESSAGES = [
  'Breaking the Geneva Convention…',
  'Bending fibre lines…',
  'Re-aligning the moon…',
  'Scraping paint…',
  'Touching grass…',
  'Bribing the SIP trunks…',
  'Wiretapping the IVRs…',
  'Following the DIDs home…',
  'Interrogating extensions…',
  'Decrypting the dial plan…',
  'Reticulating splines…',
  'Teaching queues to share…',
  'Untangling the ring groups…',
  'Greasing the call flow…',
  'Counting sheep on hold…',
  'Bonding with the PBX…'
]

function focusFromHash(): string | undefined {
  const m = /[#&]focus=([^&]+)/.exec(window.location.hash)
  return m ? decodeURIComponent(m[1]) : undefined
}

/** Full-screen loading with a fun message that rotates every 2s. */
function showLoading(): () => void {
  root.innerHTML = `
    <div class="min-h-screen flex flex-col items-center justify-center gap-5 bg-slate-900 text-slate-300">
      <div class="w-9 h-9 border-2 border-slate-700 border-t-sky-500 rounded-full animate-spin"></div>
      <div id="loadmsg" class="text-sm text-slate-400 transition-opacity duration-300"></div>
    </div>`
  const el = root.querySelector<HTMLElement>('#loadmsg')!
  const roll = (): void => {
    el.textContent = LOADING_MESSAGES[Math.floor(Math.random() * LOADING_MESSAGES.length)]
  }
  roll()
  const timer = window.setInterval(roll, 2000)
  return () => window.clearInterval(timer)
}

function showError(err: unknown): void {
  root.innerHTML = `
    <div class="min-h-screen flex flex-col items-center justify-center gap-4 bg-slate-900 text-slate-300 px-8 text-center">
      <div class="text-red-400 text-sm max-w-lg">Loading failed: ${String((err as Error)?.message ?? err)}</div>
      <button id="back" class="px-3 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-sm">Back to login</button>
    </div>`
  root.querySelector('#back')!.addEventListener('click', () => showLogin())
}

function showLogin(prefill?: { baseUrl?: string; username?: string }): void {
  renderLogin(
    root,
    async (req: ConnectRequest): Promise<string | null> => {
      const res = await window.api.threecx.connect(req)
      if (!res.ok) return res.error ?? 'Connection failed.'
      void loadAndShow()
      return null
    },
    () => void openSnapshot(),
    prefill
  )
}

/** Show another system: switch to it if it's already connected, otherwise take
 *  the user to the login screen with its details filled in. Passwords are never
 *  stored, so an unconnected system always needs one. */
async function switchSystem(baseUrl: string): Promise<void> {
  if (await window.api.threecx.switchTo(baseUrl)) {
    await loadAndShow()
    return
  }
  showLogin({ baseUrl, username: loadSystems().find((s) => s.baseUrl === baseUrl)?.username })
}

/** Callbacks for a live (connected) session. */
function liveCallbacks(): AppCallbacks {
  return {
    onReload: () => void loadAndShow(true), // hard refresh → full rebuild
    onDisconnect: () => void disconnect(),
    onOpenSnapshot: () => void openSnapshot(),
    onRefresh: (state) => softRefresh(state), // soft refresh → keep view
    onSwitchSystem: (baseUrl) => void switchSystem(baseUrl),
    onAddSystem: () => showLogin({ baseUrl: '', username: '' })
  }
}

async function loadAndShow(reauth = false): Promise<void> {
  const stop = showLoading()
  let topology: Topology
  try {
    // On a hard refresh, re-authenticate first so a stale/expired token can't
    // silently return old data — the refetch then reflects the latest config.
    if (reauth) await window.api.threecx.refresh()
    topology = await window.api.threecx.fetchTopology({ includeQueueLogins: readQueueLogins() })
  } catch (err) {
    stop()
    showError(err)
    return
  }
  stop()
  renderApp(root, topology, liveCallbacks(), focusFromHash())
}

/** Soft refresh: refetch in the background (no full-screen loader) and rebuild
 *  while restoring the captured view. On failure the current view is untouched. */
async function softRefresh(state: ViewState): Promise<void> {
  try {
    await window.api.threecx.refresh()
    const topology = await window.api.threecx.fetchTopology({
      includeQueueLogins: readQueueLogins()
    })
    renderApp(root, topology, liveCallbacks(), undefined, state)
  } catch (err) {
    notify(`Refresh failed: ${(err as Error).message}`, true)
  }
}

/** Render a loaded snapshot offline (no live 3CX session). */
function snapshotCallbacks(topology: Topology): AppCallbacks {
  return {
    onReload: () => showSnapshot(topology),
    onDisconnect: () => showLogin(),
    onOpenSnapshot: () => void openSnapshot(),
    // No live server to refetch from — just re-render, preserving the view.
    onRefresh: async (state) =>
      renderApp(root, topology, snapshotCallbacks(topology), undefined, state)
  }
}

function showSnapshot(topology: Topology): void {
  renderApp(root, topology, snapshotCallbacks(topology))
}

async function openSnapshot(): Promise<void> {
  const res = await window.api.app.openSnapshot()
  if (res.canceled) return
  if (res.error || !res.topology) {
    notify(res.error ?? 'Could not open snapshot.', true)
    return
  }
  showSnapshot(res.topology)
}

/** Non-destructive transient toast (snapshot errors, etc.). */
function notify(message: string, isError = false): void {
  const el = document.createElement('div')
  el.className = `fixed bottom-4 left-1/2 -translate-x-1/2 z-[100] px-3 py-1.5 rounded-md text-sm shadow-lg esp-toast-in ${
    isError ? 'bg-red-600 text-white' : 'bg-slate-800 text-slate-100'
  }`
  el.textContent = message
  document.body.appendChild(el)
  setTimeout(() => {
    el.classList.remove('esp-toast-in')
    playExit(el, 'esp-toast-out', () => el.remove())
  }, 3000)
}

async function disconnect(): Promise<void> {
  // Sign out of the system in front; if others are still connected, show one of
  // those rather than dropping the user back to the login screen.
  const sessions = await window.api.threecx.sessions()
  const active = sessions.find((s) => s.active)
  await window.api.threecx.disconnect(active?.baseUrl)
  window.location.hash = ''
  if (await window.api.threecx.isConnected()) {
    await loadAndShow()
    return
  }
  showLogin()
}

async function start(): Promise<void> {
  // Reuse an existing session (e.g. a window opened via "Open in new window").
  try {
    if (await window.api.threecx.isConnected()) {
      await loadAndShow()
      return
    }
  } catch {
    /* fall through to login */
  }
  showLogin()
}

// Listen for auto-update events (toast lives on document.body, so it survives
// the login <-> app re-renders below).
initUpdates()

void start()
