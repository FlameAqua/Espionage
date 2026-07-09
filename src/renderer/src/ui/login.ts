// The connection screen: collects the 3CX URL + credentials and reports back.
import type { ConnectRequest } from '../../../shared/types'
import { logoSvg } from './logo'

const LS_KEY = '3cx-spy.connection'

interface SavedConn {
  baseUrl: string
  username: string
}

export function renderLogin(
  root: HTMLElement,
  onConnect: (req: ConnectRequest) => Promise<string | null>
): void {
  const saved: Partial<SavedConn> = readSaved()

  root.innerHTML = `
    <div class="min-h-screen flex items-center justify-center bg-slate-900 text-slate-100">
      <form id="login" class="w-[380px] bg-slate-800 rounded-xl shadow-2xl p-7 space-y-4">
        <div class="text-center">
          <div class="flex items-center justify-center gap-2.5">
            <span class="shrink-0">${logoSvg(40)}</span>
            <h1 class="text-2xl font-bold tracking-tight">Espionage</h1>
          </div>
          <p class="text-xs text-slate-400 mt-1">Connect to a 3CX system to map its call flow.</p>
        </div>
        <label class="block text-xs font-medium text-slate-300">3CX URL
          <input name="baseUrl" type="text" required placeholder="https://pbx.example.com"
            value="${attr(saved.baseUrl ?? '')}"
            class="mt-1 w-full px-3 py-2 rounded-md bg-slate-900 border border-slate-700 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500" />
        </label>
        <label class="block text-xs font-medium text-slate-300">Username
          <input name="username" type="text" required placeholder="0000"
            value="${attr(saved.username ?? '0000')}"
            class="mt-1 w-full px-3 py-2 rounded-md bg-slate-900 border border-slate-700 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500" />
        </label>
        <label class="block text-xs font-medium text-slate-300">Password
          <input name="password" type="password" required
            class="mt-1 w-full px-3 py-2 rounded-md bg-slate-900 border border-slate-700 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500" />
        </label>
        <label class="block text-xs font-medium text-slate-300">2FA Security Code <span class="text-slate-500">(optional)</span>
          <input name="securityCode" type="text"
            class="mt-1 w-full px-3 py-2 rounded-md bg-slate-900 border border-slate-700 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500" />
        </label>
        <div id="error" class="hidden text-xs text-red-400 bg-red-950/50 border border-red-900 rounded px-3 py-2"></div>
        <button id="submit" type="submit"
          class="w-full py-2 rounded-md bg-sky-600 hover:bg-sky-500 text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
          Connect
        </button>
      </form>
    </div>`

  const form = root.querySelector<HTMLFormElement>('#login')!
  const errBox = root.querySelector<HTMLElement>('#error')!
  const submit = root.querySelector<HTMLButtonElement>('#submit')!

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const data = new FormData(form)
    const req: ConnectRequest = {
      baseUrl: String(data.get('baseUrl') ?? '').trim(),
      username: String(data.get('username') ?? '').trim(),
      password: String(data.get('password') ?? ''),
      securityCode: String(data.get('securityCode') ?? '').trim(),
      // 3CX servers ship self-signed certs by default — always accept them.
      allowInsecure: true
    }
    errBox.classList.add('hidden')
    submit.disabled = true
    submit.textContent = 'Connecting…'
    const error = await onConnect(req)
    if (error) {
      errBox.textContent = error
      errBox.classList.remove('hidden')
      submit.disabled = false
      submit.textContent = 'Connect'
    } else {
      writeSaved({ baseUrl: req.baseUrl, username: req.username })
    }
  })
}

function readSaved(): Partial<SavedConn> {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}')
  } catch {
    return {}
  }
}

function writeSaved(c: SavedConn): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(c))
  } catch {
    /* ignore */
  }
}

function attr(s: string): string {
  return s.replace(/"/g, '&quot;')
}
