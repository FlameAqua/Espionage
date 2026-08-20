// Monochrome line icons for menus and toolbars.
//
// Emoji were doing this job, but they render in someone else's palette — full
// colour, platform-specific, and often clashing with the app's own. These are
// drawn in `currentColor`, so they take the surrounding text colour and follow
// light / dark mode without a second set.

const svg = (paths: string): string =>
  `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"
     stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
     aria-hidden="true" class="inline-block align-[-2px]">${paths}</svg>`

export const ICONS = {
  /** Crosshair — focus on this node. */
  target: svg('<circle cx="8" cy="8" r="4.2"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2"/>'),
  /** Compass — trace the call flow. */
  compass: svg('<circle cx="8" cy="8" r="6.3"/><path d="M10.4 5.6 9.2 9.2 5.6 10.4 6.8 6.8Z"/>'),
  /** Slashed circle — hide. */
  hide: svg('<circle cx="8" cy="8" r="6.3"/><path d="M3.9 12.1 12.1 3.9"/>'),
  /** Eye — show / unhide. */
  eye: svg('<path d="M1.4 8S3.9 3.6 8 3.6 14.6 8 14.6 8 12.1 12.4 8 12.4 1.4 8 1.4 8Z"/><circle cx="8" cy="8" r="1.9"/>'),
  /** Magnifier — find. */
  search: svg('<circle cx="7.2" cy="7.2" r="4.6"/><path d="m10.6 10.6 3 3"/>'),
  /** Box with an arrow — open outside the app. */
  external: svg('<path d="M9.5 2.5H13.5V6.5"/><path d="m13.5 2.5-6 6"/><path d="M12.5 9.8v3a1.2 1.2 0 0 1-1.2 1.2H3.2A1.2 1.2 0 0 1 2 12.8V4.7a1.2 1.2 0 0 1 1.2-1.2h3"/>'),
  /** Two sheets — copy. */
  copy: svg('<rect x="5.5" y="5.5" width="8" height="8" rx="1.2"/><path d="M10.5 3.2A1.2 1.2 0 0 0 9.3 2H3.7A1.7 1.7 0 0 0 2 3.7v5.6a1.2 1.2 0 0 0 1.2 1.2"/>'),
  /** Handset — copy the extension. */
  phone: svg('<path d="M5.6 2.6 6.9 5 5.7 6.4a8 8 0 0 0 3.9 3.9L11 9.1l2.4 1.3v2A1.3 1.3 0 0 1 12 13.7 11 11 0 0 1 2.3 4 1.3 1.3 0 0 1 3.6 2.6Z"/>'),
  /** People — the extensions list. */
  people: svg('<circle cx="6" cy="5.6" r="2.4"/><path d="M1.8 13.4a4.4 4.4 0 0 1 8.4 0"/><path d="M10.6 3.6a2.4 2.4 0 0 1 0 4.4M11.6 9.6a4.4 4.4 0 0 1 2.6 3.8"/>'),
  /** Table — the DID table. */
  table: svg('<rect x="2" y="3" width="12" height="10" rx="1.2"/><path d="M2 6.4h12M6.4 6.4V13"/>'),
  /** Bar chart — generate a report. */
  chart: svg('<path d="M2.5 13.5h11"/><path d="M4.6 13.5v-4M8 13.5V4.2M11.4 13.5V7.6"/>'),
  /** Broadcast — the live report. */
  live: svg('<circle cx="8" cy="8" r="1.6"/><path d="M4.9 11.1a4.4 4.4 0 0 1 0-6.2M11.1 4.9a4.4 4.4 0 0 1 0 6.2"/><path d="M2.8 13.2a7.4 7.4 0 0 1 0-10.4M13.2 2.8a7.4 7.4 0 0 1 0 10.4"/>'),
  /** Document — open a saved report. */
  document: svg('<path d="M9 1.8H4.6a1.3 1.3 0 0 0-1.3 1.3v9.8a1.3 1.3 0 0 0 1.3 1.3h6.8a1.3 1.3 0 0 0 1.3-1.3V5.2Z"/><path d="M9 1.8v3.4h3.7"/>'),
  /** Picture — export a PNG. */
  image: svg('<rect x="2" y="3" width="12" height="10" rx="1.4"/><circle cx="5.9" cy="6.4" r="1.1"/><path d="m2.6 11.6 3.2-3 3 2.6 2-1.7 2.6 2.3"/>'),
  /** Floppy — save. */
  save: svg('<path d="M12.4 13.6H3.6a1.2 1.2 0 0 1-1.2-1.2V3.6a1.2 1.2 0 0 1 1.2-1.2h6.9l3.1 3.1v6.9a1.2 1.2 0 0 1-1.2 1.2Z"/><path d="M5.4 13.6V9.4h5.2v4.2M5.4 2.4v3h4"/>'),
  /** Open folder. */
  folderOpen: svg('<path d="M1.9 12.4V4.3a1.1 1.1 0 0 1 1.1-1.1h2.8l1.4 1.8h4.7a1.1 1.1 0 0 1 1.1 1.1v1.1"/><path d="m1.9 12.4 1.8-4.5h10.4l-1.8 4.5Z"/>'),
  /** Folder — reveal in the file manager. */
  folder: svg('<path d="M14 12.2a1.2 1.2 0 0 1-1.2 1.2H3.2A1.2 1.2 0 0 1 2 12.2V3.8a1.2 1.2 0 0 1 1.2-1.2h2.9l1.4 1.8h5.3A1.2 1.2 0 0 1 14 5.6Z"/>'),
  /** Clock with an arrow — compare against an older snapshot. */
  history: svg('<path d="M2.4 8a5.6 5.6 0 1 0 1.7-4"/><path d="M2.2 2.2v2.6h2.6"/><path d="M8 5.2V8l2 1.2"/>'),
  /** Gear — settings. */
  gear: svg('<circle cx="8" cy="8" r="2.1"/><path d="M12.9 9.8a1.1 1.1 0 0 0 .2 1.2l.1.1a1.3 1.3 0 1 1-1.9 1.9l-.1-.1a1.1 1.1 0 0 0-1.9.8v.2a1.3 1.3 0 1 1-2.6 0v-.1a1.1 1.1 0 0 0-2-.8l-.1.1a1.3 1.3 0 1 1-1.9-1.9l.1-.1a1.1 1.1 0 0 0-.8-1.9h-.2a1.3 1.3 0 1 1 0-2.6h.1a1.1 1.1 0 0 0 .8-2l-.1-.1a1.3 1.3 0 1 1 1.9-1.9l.1.1a1.1 1.1 0 0 0 1.2.2h.1a1.1 1.1 0 0 0 .7-1v-.2a1.3 1.3 0 1 1 2.6 0v.1a1.1 1.1 0 0 0 1.9.8l.1-.1a1.3 1.3 0 1 1 1.9 1.9l-.1.1a1.1 1.1 0 0 0-.2 1.2v.1a1.1 1.1 0 0 0 1 .7h.2a1.3 1.3 0 1 1 0 2.6h-.1a1.1 1.1 0 0 0-1 .6Z"/>'),
  /** Question mark — help. */
  help: svg('<circle cx="8" cy="8" r="6.3"/><path d="M6.3 6.2a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.6-.7 1.1v.4"/><path d="M8 11.6h.01"/>'),
  /** Circular arrows — refresh. */
  refresh: svg('<path d="M13.6 6.8A5.8 5.8 0 0 0 3.6 4.2L2.4 5.4"/><path d="M2.4 9.2a5.8 5.8 0 0 0 10 2.6l1.2-1.2"/><path d="M2.4 2.6v2.8h2.8M13.6 13.4v-2.8h-2.8"/>'),
  /** Power — disconnect. */
  power: svg('<path d="M8 2.2v5.4"/><path d="M11.7 4.5a5.2 5.2 0 1 1-7.4 0"/>'),
  /** Link — the link/route settings. */
  link: svg('<path d="M6.6 9.4a2.6 2.6 0 0 0 3.9.3l1.6-1.6a2.6 2.6 0 0 0-3.7-3.7l-.9.9"/><path d="M9.4 6.6a2.6 2.6 0 0 0-3.9-.3L3.9 7.9a2.6 2.6 0 0 0 3.7 3.7l.9-.9"/>'),
  /** Hourglass — a report is generating. */
  hourglass: svg('<path d="M4.6 2h6.8M4.6 14h6.8"/><path d="M5.4 2v2.4L8 7l2.6-2.6V2M5.4 14v-2.4L8 9l2.6 2.6V14"/>'),
  /** Sun — switch to light mode. */
  sun: svg('<circle cx="8" cy="8" r="3"/><path d="M8 1.4v1.4M8 13.2v1.4M3.3 3.3l1 1M11.7 11.7l1 1M1.4 8h1.4M13.2 8h1.4M3.3 12.7l1-1M11.7 4.3l1-1"/>'),
  /** Closed padlock — node dragging is locked. */
  lock: svg('<rect x="3.3" y="7" width="9.4" height="6.6" rx="1.3"/><path d="M5.6 7V5.2a2.4 2.4 0 0 1 4.8 0V7"/>'),
  /** Open padlock — nodes can be dragged. */
  unlock: svg('<rect x="3.3" y="7" width="9.4" height="6.6" rx="1.3"/><path d="M5.6 7V5.2a2.4 2.4 0 0 1 4.5-1.1"/>'),
  /** Moon — switch to dark mode. */
  moon: svg('<path d="M13.4 9.4A5.8 5.8 0 0 1 6.6 2.6a5.8 5.8 0 1 0 6.8 6.8Z"/>'),
  /** Heartbeat trace — the health check. */
  pulse: svg('<path d="M1.6 8h2.9l1.5-3.6L8.4 12l1.6-4 1 2h3.4"/>'),
  /** Clock — opening hours. */
  clock: svg('<circle cx="8" cy="8" r="6.2"/><path d="M8 4.6V8l2.4 1.5"/>'),
  /** Second window — open this node in its own window. */
  window: svg('<rect x="1.8" y="3.4" width="9" height="8" rx="1.2"/><path d="M1.8 6.1h9"/><path d="M5.6 3.4V2.6a1.2 1.2 0 0 1 1.2-1.2h6.2a1.2 1.2 0 0 1 1.2 1.2v6.2a1.2 1.2 0 0 1-1.2 1.2h-.8"/>'),
  /** Card — copy the internal id. */
  idCard: svg('<rect x="1.6" y="3.4" width="12.8" height="9.2" rx="1.4"/><circle cx="5.7" cy="7.4" r="1.4"/><path d="M3.6 11a2.4 2.4 0 0 1 4.2 0M9.8 6.6h2.8M9.8 9.2h2.8"/>'),
  /** Tick in a circle — nothing to report. */
  ok: svg('<circle cx="8" cy="8" r="6.3"/><path d="m5.3 8.2 1.9 1.9 3.5-4"/>')
} as const

export type IconName = keyof typeof ICONS
