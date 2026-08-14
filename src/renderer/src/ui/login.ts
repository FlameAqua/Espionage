// The connection screen: collects the 3CX URL + credentials and reports back.
import type { ConnectRequest } from '../../../shared/types'
import { logoSvg } from './logo'
import { forgetSystem, loadSystems, rememberSystem } from './systems'

export function renderLogin(
  root: HTMLElement,
  onConnect: (req: ConnectRequest) => Promise<string | null>,
  onOpenSnapshot?: () => void,
  /** Pre-fill for "add another system" and for switching to one that isn't
   *  connected — the password is never remembered, so it's asked for again. */
  prefill?: { baseUrl?: string; username?: string }
): void {
  const known = loadSystems()
  const saved = { baseUrl: prefill?.baseUrl ?? known[0]?.baseUrl, username: prefill?.username ?? known[0]?.username }

  root.innerHTML = `
    <div class="relative min-h-screen flex items-center justify-center overflow-hidden bg-slate-900 text-slate-100">
      <canvas id="matrix" class="absolute inset-0 w-full h-full pointer-events-none"></canvas>
      <form id="login" class="relative z-10 w-[380px] bg-slate-800/95 backdrop-blur-sm rounded-xl shadow-2xl p-7 space-y-4">
        <div class="text-center">
          <div class="flex items-center justify-center gap-2.5">
            <span class="shrink-0">${logoSvg(40)}</span>
            <h1 class="text-2xl font-bold tracking-tight">Espionage</h1>
          </div>
          <p class="text-xs text-slate-400 mt-1">Connect to a 3CX system to map its call flow.</p>
        </div>
        <label class="block text-xs font-medium text-slate-300">3CX URL
          <input name="baseUrl" type="text" required placeholder="https://pbx.example.com"
            list="knownSystems" autocomplete="off" value="${attr(saved.baseUrl ?? '')}"
            class="mt-1 w-full px-3 py-2 rounded-md bg-slate-900 border border-slate-700 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500" />
          <datalist id="knownSystems">
            ${known.map((k) => `<option value="${attr(k.baseUrl)}">${attr(k.username)}</option>`).join('')}
          </datalist>
          <div id="forgetRow" class="hidden mt-1 text-right">
            <button id="forget" type="button" class="text-[11px] text-slate-500 hover:text-red-400">Forget this system</button>
          </div>
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
        <div class="text-center">
          <button id="openSnapshot" type="button" class="text-xs text-slate-400 hover:text-slate-200 underline underline-offset-2">
            Open a saved snapshot
          </button>
        </div>
      </form>
    </div>`

  const canvas = root.querySelector<HTMLCanvasElement>('#matrix')
  if (canvas) startMatrix(canvas)

  const form = root.querySelector<HTMLFormElement>('#login')!
  const errBox = root.querySelector<HTMLElement>('#error')!
  const submit = root.querySelector<HTMLButtonElement>('#submit')!

  const openSnap = root.querySelector<HTMLButtonElement>('#openSnapshot')!
  if (onOpenSnapshot) openSnap.addEventListener('click', onOpenSnapshot)
  else openSnap.classList.add('hidden')

  const urlEl = form.querySelector<HTMLInputElement>('[name=baseUrl]')!
  const userEl = form.querySelector<HTMLInputElement>('[name=username]')!
  const forgetRow = root.querySelector<HTMLElement>('#forgetRow')!

  /** Picking a remembered system fills in its username; the password is never
   *  stored, so that is always typed. "Forget" appears only for one we know,
   *  since the URL dropdown itself offers no way to remove an entry. */
  const syncKnown = (): void => {
    const hit = known.find((k) => k.baseUrl === urlEl.value.trim().replace(/\/+$/, ''))
    forgetRow.classList.toggle('hidden', !hit)
    if (hit && !userEl.value) userEl.value = hit.username
  }
  urlEl.addEventListener('change', syncKnown)
  urlEl.addEventListener('input', syncKnown)
  syncKnown()
  root.querySelector('#forget')!.addEventListener('click', () => {
    forgetSystem(urlEl.value.trim().replace(/\/+$/, ''))
    renderLogin(root, onConnect, onOpenSnapshot, { baseUrl: '', username: '' })
  })

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
      rememberSystem(req.baseUrl, req.username)
    }
  })
}

function attr(s: string): string {
  return s.replace(/"/g, '&quot;')
}

/** A subtle "digital rain" backdrop for the login screen. Self-cleaning: the
 *  animation loop stops (and drops its resize listener) as soon as the canvas
 *  leaves the DOM, e.g. when we navigate to the graph view. */
function startMatrix(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  // Half-width katakana + digits + a few hex letters — the classic glyph soup.
  const glyphs = 'アイウエオカキクケコサシスセソタチツテトナニヌネノ0123456789ABCDEF'
  const fontSize = 14
  let columns = 0
  let drops: number[] = []

  const resize = (): void => {
    canvas.width = canvas.clientWidth
    canvas.height = canvas.clientHeight
    columns = Math.max(1, Math.floor(canvas.width / fontSize))
    // Seed each column at a random negative offset so they don't fall in step.
    drops = Array.from({ length: columns }, () => Math.floor(Math.random() * -60))
  }
  resize()
  window.addEventListener('resize', resize)

  const draw = (): void => {
    if (!canvas.isConnected) {
      window.removeEventListener('resize', resize)
      return // navigated away — stop the loop and release the listener
    }
    // Translucent fade over the previous frame leaves fading trails.
    ctx.fillStyle = 'rgba(15, 23, 42, 0.09)'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = 'rgba(34, 197, 94, 0.28)' // dim green — dull, not flashy
    ctx.font = `${fontSize}px monospace`
    for (let i = 0; i < columns; i++) {
      const ch = glyphs[Math.floor(Math.random() * glyphs.length)]
      ctx.fillText(ch, i * fontSize, drops[i] * fontSize)
      // Once a column runs off the bottom, randomly restart it near the top.
      if (drops[i] * fontSize > canvas.height && Math.random() > 0.975) drops[i] = 0
      drops[i]++
    }
    requestAnimationFrame(draw)
  }
  requestAnimationFrame(draw)
}
