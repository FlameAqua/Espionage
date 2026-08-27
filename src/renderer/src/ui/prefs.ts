// App preferences that aren't tied to one screen: how much the interface should
// move, which view mode to open on, and whether to pay for per-queue login state
// at load. Small enough to keep in localStorage, read wherever they're needed.

export type MotionPref = 'system' | 'on' | 'off'

const MOTION_KEY = 'espionage.motion'
const LAYOUT_KEY = 'espionage.defaultLayout'
const QUEUE_LOGINS_KEY = 'espionage.queueLogins'
const STRAIGHT_LINKS_KEY = 'espionage.straightLinks'

/**
 * Carry settings saved under the old `3cx-spy.` prefix over to `espionage.`.
 *
 * Half the keys were already `espionage.` and half still carried the package
 * name, so renaming the rest would quietly have thrown away whatever theme,
 * layout, focus reach and panel state the user had chosen. Copy rather than
 * move: an older build reading the same profile still finds what it expects.
 *
 * Runs once at startup and is cheap — a handful of keys. It only ever fills a
 * gap, so a value saved under the new name always wins.
 */
export function migrateLegacyPrefs(): void {
  const OLD = '3cx-spy.'
  const NEW = 'espionage.'
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(OLD)) continue
      const renamed = NEW + key.slice(OLD.length)
      if (localStorage.getItem(renamed) !== null) continue
      const value = localStorage.getItem(key)
      if (value !== null) localStorage.setItem(renamed, value)
    }
  } catch {
    /* storage unavailable — the app just opens on its defaults */
  }
}

function read(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function write(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {
    /* storage unavailable, non-fatal */
  }
}

export function readMotionPref(): MotionPref {
  const v = read(MOTION_KEY)
  return v === 'on' || v === 'off' ? v : 'system'
}
export function writeMotionPref(v: MotionPref): void {
  write(MOTION_KEY, v === 'system' ? '' : v)
}

/** The view mode the graph opens on. 'last' keeps whatever was last used. */
export type DefaultLayout = 'last' | 'flow' | 'department' | 'compact'

export function readDefaultLayout(): DefaultLayout {
  const v = read(LAYOUT_KEY)
  return v === 'flow' || v === 'department' || v === 'compact' ? v : 'last'
}
export function writeDefaultLayout(v: DefaultLayout): void {
  write(LAYOUT_KEY, v === 'last' ? '' : v)
}

/** The view mode actually in force last time, so 'last' has something to restore. */
export function readLastLayout(): string {
  return read(`${LAYOUT_KEY}.last`)
}
export function writeLastLayout(v: string): void {
  write(`${LAYOUT_KEY}.last`, v)
}

/** Whether links are routed along the flow, turning once in the gap between
 *  their two nodes, or drawn as direct lines. Routing is the default; the
 *  setting the user sees is the opt-out ("Straight links"). */
export function readEdgeRouting(): boolean {
  return read(STRAIGHT_LINKS_KEY) !== '1'
}
export function writeStraightLinks(on: boolean): void {
  write(STRAIGHT_LINKS_KEY, on ? '1' : '')
}

/** Read per-queue agent login state on connect. Off by default: it means
 *  scraping the web client's Switchboard, which noticeably slows the load. */
export function readQueueLogins(): boolean {
  return read(QUEUE_LOGINS_KEY) === '1'
}
export function writeQueueLogins(on: boolean): void {
  write(QUEUE_LOGINS_KEY, on ? '1' : '')
}
