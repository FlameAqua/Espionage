// App bootstrap: toggles between the login screen and the connected graph view.
// On startup it reuses an existing main-process session (so "Open in new window"
// lands straight on the graph) and honours a #focus=<nodeId> hash.
import './index.css'
import type { ConnectRequest, Topology } from '../../shared/types'
import { renderLogin } from './ui/login'
import { renderApp } from './ui/app'

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

function showLogin(): void {
  renderLogin(root, async (req: ConnectRequest): Promise<string | null> => {
    const res = await window.api.threecx.connect(req)
    if (!res.ok) return res.error ?? 'Connection failed.'
    void loadAndShow()
    return null
  })
}

async function loadAndShow(): Promise<void> {
  const stop = showLoading()
  let topology: Topology
  try {
    topology = await window.api.threecx.fetchTopology()
  } catch (err) {
    stop()
    showError(err)
    return
  }
  stop()
  renderApp(
    root,
    topology,
    {
      onReload: () => void loadAndShow(),
      onDisconnect: () => void disconnect()
    },
    focusFromHash()
  )
}

async function disconnect(): Promise<void> {
  await window.api.threecx.disconnect()
  window.location.hash = ''
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

void start()
