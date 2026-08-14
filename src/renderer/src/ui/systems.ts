// Remembered 3CX systems: the ones you've signed into before, so the login
// screen can offer them and the toolbar can switch between them.
//
// Only the URL and username are kept. Passwords never touch disk — switching to
// a system that isn't currently connected takes you back to the login screen
// with the fields filled in.

const HISTORY_KEY = 'espionage.systems'

export interface KnownSystem {
  baseUrl: string
  username: string
  /** ISO timestamp of the last successful sign-in, newest first in the list. */
  lastUsed: string
}

export function loadSystems(): KnownSystem[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]')
    if (!Array.isArray(raw)) return []
    return raw
      .filter((s): s is KnownSystem => !!s && typeof s.baseUrl === 'string' && !!s.baseUrl)
      .map((s) => ({
        baseUrl: String(s.baseUrl),
        username: String(s.username ?? ''),
        lastUsed: String(s.lastUsed ?? '')
      }))
      .sort((a, b) => b.lastUsed.localeCompare(a.lastUsed))
  } catch {
    return []
  }
}

function save(list: KnownSystem[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 20)))
  } catch {
    /* storage unavailable — non-fatal */
  }
}

/** Record a successful sign-in, moving it to the top. */
export function rememberSystem(baseUrl: string, username: string): void {
  const url = baseUrl.trim().replace(/\/+$/, '')
  if (!url) return
  const rest = loadSystems().filter((s) => s.baseUrl !== url)
  save([{ baseUrl: url, username, lastUsed: new Date().toISOString() }, ...rest])
}

export function forgetSystem(baseUrl: string): void {
  save(loadSystems().filter((s) => s.baseUrl !== baseUrl))
}

/** Host name alone, which is what identifies a system at a glance. */
export function systemLabel(baseUrl: string): string {
  return baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '')
}
