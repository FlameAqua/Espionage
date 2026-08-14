// Shared motion helpers. The animations themselves live in index.css; this is
// the JS side — playing an exit before an element is removed, and tweening a
// number for things CSS can't transition (grid columns the graph canvas has to
// keep in step with).
//
// Everything here collapses to an instant change when the OS asks for reduced
// motion, so the app stays usable for anyone who finds movement distracting.

import { readMotionPref } from './prefs'

export function reducedMotion(): boolean {
  // An explicit choice in Settings wins over the OS setting, so someone can turn
  // the movement off here without changing it system-wide (or back on).
  const pref = readMotionPref()
  if (pref === 'off') return true
  if (pref === 'on') return false
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

/** Add `cls`, wait for the animation, then run `done`. The timeout is a
 *  backstop: an element that never animates (display:none, reduced motion, a
 *  dropped frame) must still be cleaned up. */
export function playExit(el: Element, cls: string, done: () => void): void {
  if (!el.isConnected || reducedMotion()) {
    done()
    return
  }
  let fired = false
  const finish = (): void => {
    if (fired) return
    fired = true
    done()
  }
  el.addEventListener('animationend', finish, { once: true })
  window.setTimeout(finish, 400)
  el.classList.add(cls)
}

/** Reveal a dropdown / popover with a short pop-in. */
export function showPopover(el: HTMLElement): void {
  el.classList.remove('hidden', 'esp-pop-out')
  el.classList.add('esp-pop-in')
}

/** Hide one, playing the pop-out first. Safe to call when already hidden. */
export function hidePopover(el: HTMLElement): void {
  if (el.classList.contains('hidden')) return
  el.classList.remove('esp-pop-in')
  playExit(el, 'esp-pop-out', () => {
    el.classList.add('hidden')
    el.classList.remove('esp-pop-out')
  })
}

/** Tween a number over `ms`, calling `step` each frame. Used for panel widths,
 *  where the graph canvas has to be resized in step with the column — the same
 *  path a drag-resize already takes, so it's a fast drag rather than new code. */
export function tween(from: number, to: number, ms: number, step: (v: number) => void): void {
  if (reducedMotion() || from === to) {
    step(to)
    return
  }
  const start = performance.now()
  // easeOutCubic: quick off the mark, settles gently.
  const ease = (t: number): number => 1 - Math.pow(1 - t, 3)
  const frame = (now: number): void => {
    const t = Math.min(1, (now - start) / ms)
    step(from + (to - from) * ease(t))
    if (t < 1) requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}
