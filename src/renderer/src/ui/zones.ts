// Call-zone configuration + the settings modal that edits it.
//
// A "call zone" groups (country, line-type) destinations into a tariff band, so
// the report can total calls / talk time / cost per zone. A call is placed in a
// zone by matching its external number against the bundled tariff (giving a
// canonical country + landline/mobile/other), then looking that pair up in the
// configured zones. Config lives in localStorage and can be exported / imported
// as JSON. Defaults are seeded from the zone list supplied by the operator.

import { canonicalCountry, matchTariff, tariffCountryTypes, type LineType } from '../report/tariff'
import { parseInternational } from '../../../shared/phone'
import { playExit } from './motion'

export interface ZoneEntry {
  country: string // canonical uppercase country
  lineType: LineType
}
export interface ZoneDef {
  id: string
  label: string
  entries: ZoneEntry[]
}
export interface ZoneConfig {
  zones: ZoneDef[]
}

const ZONE_KEY = 'espionage.zoneConfig'

const esc = (s: unknown): string =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )

function flash(message: string, isError = false): void {
  const el = document.createElement('div')
  el.className = `fixed bottom-4 left-1/2 -translate-x-1/2 z-[130] px-3 py-1.5 rounded-md text-sm shadow-lg esp-toast-in ${
    isError ? 'bg-red-600 text-white' : 'bg-slate-800 text-slate-100 dark:bg-slate-700'
  }`
  el.textContent = message
  document.body.appendChild(el)
  setTimeout(() => {
    el.classList.remove('esp-toast-in')
    playExit(el, 'esp-toast-out', () => el.remove())
  }, 2800)
}

// --- Line-type normalisation -------------------------------------------------

function normalizeType(raw: string): LineType {
  const t = raw.trim().toLowerCase()
  if (/mobile/.test(t)) return 'Mobile'
  if (/landline|fixed/.test(t)) return 'Landline'
  return 'Other'
}

// --- Default seed (operator-supplied zone list) ------------------------------
// Tab/space-separated "COUNTRY  Type" lines per zone. Country + type are
// normalised on load, so the raw operator naming can be pasted verbatim.

const DEFAULT_ZONE_SEED: Record<string, string> = {
  '1': `ARGENTINA\tLandline
AUSTRIA\tOther
AUSTRIA\tLandline
BRAZIL\tLandline
BULGARIA\tLandline
CANADA\tLandline
CROATIA\tLandline
CYPRUS\tLandline
DENMARK\tLandline
FRANCE\tLandline
GERMANY\tLandline
GREECE\tLandline
GUADELOUPE\tLandline
HUNGARY\tLandline
IRELAND\tLandline
IRELAND\tOther
UNITED STATES\tLandline
ITALY\tLandline
KOREA SOUTH\tLandline
LATVIA\tLandline
MALTA\tLandline
MEXICO\tLandline
NETHERLANDS\tLandline
NEW ZEALAND\tLandline
NORWAY\tLandline
PORTUGAL\tLandline
PUERTO RICO\tMobile
ROMANIA\tLandline
SINGAPORE\tLandline
SINGAPORE\tMobile
SLOVAKIA\tLandline
SPAIN\tLandline
SWEDEN\tLandline
UK\tMobile`,
  '2': `ALASKA\tLandline
ALGERIA\tLandline
AMERICAN SAMOA\tLandline
AMERICAN SAMOA\tMobile
ANDORRA\tLandline
AUSTRALIA\tLandline
AUSTRALIA\tMobile
AUSTRIA\tMobile
BAHRAIN\tLandline
BANGLADESH\tMobile
BANGLADESH\tLandline
BELGIUM\tLandline
BELGIUM\tMobile
BERMUDA\tMobile
BERMUDA\tLandline
BOTSWANA\tLandline
BRUNEI DARUSSALAM\tLandline
BRUNEI DARUSSALAM\tMobile
BULGARIA\tMobile
CHILE\tLandline
CHINA\tLandline
CHINA\tMobile
COLOMBIA\tLandline
COLOMBIA\tMobile
COSTA RICA\tLandline
CYPRUS\tMobile
CZECH REPUBLIC\tLandline
DENMARK\tMobile
DOMINICAN REPUBLIC\tLandline
ESTONIA\tLandline
ESTONIA\tMobile
FAEROE ISLANDS\tLandline
FINLAND\tMobile
FINLAND\tLandline
FRANCE\tMobile
FRENCH GUIANA\tLandline
FRENCH GUIANA\tMobile
GERMANY\tMobile
GIBRALTAR\tLandline
GREECE\tMobile
GUADELOUPE\tMobile
GUAM\tLandline
HONG KONG\tLandline
HONG KONG\tMobile
HUNGARY\tMobile
ICELAND\tLandline
ICELAND\tMobile
INDIA\tMobile
INDIA\tLandline
INDONESIA\tLandline
INDONESIA\tMobile
IRELAND\tMobile
ISRAEL\tLandline
ITALY\tMobile
JAPAN\tLandline
KAZAKHSTAN\tLandline
KOREA SOUTH\tMobile
LATVIA\tMobile
LITHUANIA\tLandline
LITHUANIA\tMobile
LUXEMBOURG\tLandline
LUXEMBOURG\tMobile
MALAYSIA\tLandline
MALAYSIA\tMobile
MALTA\tMobile
MARTINIQUE\tLandline
MARTINIQUE\tMobile
MEXICO\tMobile
MONGOLIA\tMobile
MONGOLIA\tLandline
MOROCCO\tLandline
NAMIBIA\tLandline
NETHERLANDS\tMobile
NEW ZEALAND\tMobile
NIGERIA\tMobile
NORTHERN MARIANA IS\tLandline
PANAMA\tLandline
PARAGUAY\tLandline
PARAGUAY\tMobile
PERU\tLandline
POLAND\tLandline
POLAND\tMobile
PORTUGAL\tMobile
PUERTO RICO\tLandline
REUNION\tLandline
REUNION\tMobile
ROMANIA\tMobile
RUSSIA\tLandline
SAN MARINO\tLandline
SLOVENIA\tLandline
SOUTH AFRICA\tLandline
SPAIN\tMobile
SWAZILAND\tLandline
SWEDEN\tMobile
SWITZERLAND\tLandline
TAIWAN\tLandline
THAILAND\tMobile
THAILAND\tLandline
TRINIDAD AND TOBAGO\tLandline
TURKEY\tLandline
UNITED KINGDOM\tMobile
UNITED STATES\tNon Geo
URUGUAY\tLandline
VATICAN\tLandline
VENEZUELA\tLandline
VENEZUELA\tMobile
VIRGIN ISLANDS US\tLandline`,
  '3': `AFGHANISTAN\tLandline
AFGHANISTAN\tMobile
ALBANIA\tLandline
ALBANIA\tMobile
ALGERIA\tMobile
ANDORRA\tMobile
ANGOLA\tLandline
ANGOLA\tMobile
ANGUILLA\tLandline
ANGUILLA\tMobile
ANTIGUA AND BARBUDA\tLandline
ANTIGUA AND BARBUDA\tMobile
ARGENTINA\tMobile
ARMENIA\tMobile
ARMENIA\tLandline
ARMENIA\tNon Geo
ARUBA\tLandline
ARUBA\tMobile
AZERBAIJAN\tLandline
AZERBAIJAN\tMobile
BAHAMAS\tLandline
BAHAMAS\tMobile
BAHRAIN\tMobile
BARBADOS\tLandline
BARBADOS\tMobile
BELARUS\tLandline
BELARUS\tMobile
BELIZE\tLandline
BELIZE\tMobile
BENIN\tLandline
BENIN\tMobile
BHUTAN\tMobile
BHUTAN\tLandline
BOLIVIA\tLandline
BOLIVIA\tMobile
BOSNIA\tLandline
BOSNIA\tMobile
BOTSWANA\tMobile
BRAZIL\tMobile
BURKINA FASO\tLandline
BURKINA FASO\tMobile
BURUNDI\tMobile
BURUNDI\tLandline
CAMBODIA\tLandline
CAMBODIA\tMobile
CAMEROON\tLandline
CAMEROON\tMobile
CAPE VERDE\tLandline
CAPE VERDE\tMobile
CAYMAN ISLANDS\tLandline
CAYMAN ISLANDS\tMobile
CENTRAL AFRICAN REP\tMobile
CENTRAL AFRICAN REP\tLandline
CENTRAL AFRICAN REP\tSpecial
CHAD\tMobile
CHAD\tLandline
CHILE\tMobile
COMOROS\tLandline
COMOROS\tMobile
CONGO\tLandline
CONGO\tMobile
COSTA RICA\tMobile
COTE DIVOIRE\tLandline
COTE DIVOIRE\tMobile
CROATIA\tMobile
CUBA\tLandline
CYPRUS\tNon Geo
CZECH REPUBLIC\tMobile
DJIBOUTI\tLandline
DOMINICA\tLandline
DOMINICA\tMobile
DOMINICAN REPUBLIC\tMobile
DR CONGO\tLandline
DR CONGO\tMobile
EAST TIMOR\tLandline
EAST TIMOR\tMobile
ECUADOR\tLandline
ECUADOR\tMobile
EGYPT\tMobile
EGYPT\tLandline
EL SALVADOR\tLandline
EL SALVADOR\tMobile
EQUATORIAL GUINEA\tLandline
ERITREA\tLandline
ERITREA\tMobile
ESTONIA\tSpecial
ETHIOPIA\tLandline
ETHIOPIA\tMobile
FAEROE ISLANDS\tMobile
FIJI\tLandline
FIJI\tMobile
FINLAND\tPremium
FINLAND\tNon Geo
FRENCH POLYNESIA\tLandline
FRENCH POLYNESIA\tMobile
GABON\tLandline
GABON\tMobile
GAMBIA\tLandline
GAMBIA\tMobile
GEORGIA\tLandline
GEORGIA\tMobile
GHANA\tMobile
GHANA\tLandline
GIBRALTAR\tMobile
GREECE\tSpecial
GREENLAND\tLandline
GRENADA\tLandline
GRENADA\tMobile
GUATEMALA\tMobile
GUATEMALA\tLandline
GUINEA REP\tLandline
GUINEA REP\tMobile
GUINEA-BISSAU\tLandline
GUINEA-BISSAU\tMobile
GUYANA\tMobile
GUYANA\tLandline
HAITI\tLandline
HAITI\tMobile
HONDURAS\tMobile
HONDURAS\tLandline
IRAN\tLandline
IRAN\tMobile
IRAQ\tLandline
IRAQ\tMobile
IRELAND\tIreland Premium 1520
IRELAND\tIreland Premium 1530
IRELAND\tIreland Premium 1540
ISRAEL\tMobile
JAMAICA\tLandline
JAMAICA\tMobile
JAPAN\tMobile
JORDAN\tMobile
JORDAN\tLandline
KAZAKHSTAN\tMobile
KENYA\tLandline
KENYA\tMobile
KOREA NORTH\tLandline
KUWAIT\tLandline
KUWAIT\tMobile
KYRGYZSTAN\tLandline
KYRGYZSTAN\tMobile
LAOS\tLandline
LEBANON\tLandline
LEBANON\tMobile
LESOTHO\tMobile
LESOTHO\tLandline
LIBERIA\tMobile
LIBERIA\tLandline
LIBYA\tLandline
LIBYA\tMobile
LIECHTENSTEIN\tLandline
LIECHTENSTEIN\tMobile
MACAO\tLandline
MACAO\tMobile
MACEDONIA\tLandline
MACEDONIA\tMobile
MADAGASCAR\tLandline
MALAWI\tLandline
MALAWI\tMobile
MALDIVES\tLandline
MALDIVES\tMobile
MALI\tLandline
MALI\tMobile
MARSHALL ISLANDS\tLandline
MAURITANIA\tLandline
MAURITANIA\tMobile
MAURITIUS\tLandline
MAURITIUS\tMobile
MAYOTTE ISLAND\tLandline
MAYOTTE ISLAND\tMobile
MICRONESIA\tLandline
MOLDOVA\tLandline
MOLDOVA\tMobile
MONACO\tLandline
MONACO\tMobile
MONTENEGRO\tLandline
MONTENEGRO\tMobile
MONTSERRAT\tLandline
MOROCCO\tMobile
MOZAMBIQUE\tLandline
MOZAMBIQUE\tMobile
MYANMAR\tLandline
MYANMAR\tMobile
NAMIBIA\tMobile
NAURU\tMobile
NEPAL\tMobile
NEPAL\tLandline
NETHERLANDS ANTILLES\tLandline
NETHERLANDS ANTILLES\tMobile
NEW CALEDONIA\tLandline
NICARAGUA\tLandline
NICARAGUA\tMobile
NIGER\tMobile
NIGER\tLandline
NIGERIA\tLandline
NORWAY\tMobile
NORWAY\tSpecial
OMAN\tLandline
OMAN\tMobile
PAKISTAN\tLandline
PAKISTAN\tMobile
PALAU\tLandline
PALAU\tMobile
PALESTINE\tLandline
PALESTINE\tMobile
PANAMA\tMobile
PAPUA NEW GUINEA\tLandline
PERU\tMobile
PHILIPPINES\tLandline
PHILIPPINES\tMobile
QATAR\tLandline
QATAR\tMobile
RUSSIA\tMobile
RWANDA\tMobile
RWANDA\tLandline
SAMOA WEST\tLandline
SAMOA WEST\tMobile
SAN MARINO\tMobile
SAUDI ARABIA\tLandline
SAUDI ARABIA\tMobile
SENEGAL\tLandline
SENEGAL\tMobile
SERBIA\tLandline
SERBIA\tMobile
SEYCHELLES\tMobile
SEYCHELLES\tLandline
SIERRA LEONE\tLandline
SINT MAARTEN\tLandline
SLOVAKIA\tMobile
SLOVENIA\tMobile
SOMALIA\tMobile
SOMALIA\tLandline
SOUTH AFRICA\tMobile
SOUTH SUDAN\tMobile
SOUTH SUDAN\tLandline
SRI LANKA\tLandline
SRI LANKA\tMobile
ST KITTS AND NEVIS\tLandline
ST KITTS AND NEVIS\tMobile
ST LUCIA\tLandline
ST LUCIA\tMobile
ST PIERRE AND MIQUELON\tLandline
ST PIERRE AND MIQUELON\tMobile
ST VINCENT\tLandline
ST VINCENT\tMobile
SUDAN\tLandline
SUDAN\tMobile
SURINAME\tLandline
SURINAME\tMobile
SWAZILAND\tMobile
SWITZERLAND\tOther
SWITZERLAND\tMobile
SYRIA\tLandline
SYRIA\tMobile
TAIWAN\tMobile
TAJIKISTAN\tMobile
TAJIKISTAN\tLandline
TANZANIA\tMobile
TANZANIA\tLandline
TOGO\tMobile
TOGO\tLandline
TONGA\tLandline
TRINIDAD AND TOBAGO\tMobile
TUNISIA\tMobile
TUNISIA\tLandline
TURKEY\tMobile
TURKMENISTAN\tLandline
TURKMENISTAN\tMobile
TURKS AND CAICOS IS\tLandline
TURKS AND CAICOS IS\tMobile
UGANDA\tLandline
UGANDA\tMobile
UKRAINE\tLandline
UKRAINE\tMobile
UNITED ARAB EMIRATES\tLandline
UNITED ARAB EMIRATES\tMobile
UNITED KINGDOM\tUK 0842
UNITED KINGDOM\tUK 0843
UNITED KINGDOM\tUK 0872
UNITED KINGDOM\tUK 0873
URUGUAY\tMobile
UZBEKISTAN\tMobile
UZBEKISTAN\tLandline
VANUATU\tLandline
VANUATU\tMobile
VIETNAM\tLandline
VIETNAM\tMobile
VIRGIN ISLANDS UK\tLandline
VIRGIN ISLANDS UK\tMobile
WALLIS AND FUTUNA IS\tLandline
YEMEN\tLandline
YEMEN\tMobile
ZAMBIA\tLandline
ZAMBIA\tMobile
ZIMBABWE\tLandline
ZIMBABWE\tMobile`
}

function seedEntries(block: string): ZoneEntry[] {
  const out: ZoneEntry[] = []
  const seen = new Set<string>()
  for (const line of block.split(/\r?\n/)) {
    if (!line.trim()) continue
    const parts = line.split(/\t|\s{2,}/)
    const country = canonicalCountry(parts[0] ?? '')
    const lineType = normalizeType(parts.slice(1).join(' '))
    if (!country) continue
    const key = `${country}|${lineType}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ country, lineType })
  }
  return out
}

export function defaultZoneConfig(): ZoneConfig {
  return {
    zones: Object.entries(DEFAULT_ZONE_SEED).map(([id, block]) => ({
      id,
      label: `Zone ${id}`,
      entries: seedEntries(block)
    }))
  }
}

// --- Persistence -------------------------------------------------------------

export function loadZoneConfig(): ZoneConfig {
  try {
    const raw = localStorage.getItem(ZONE_KEY)
    if (!raw) return defaultZoneConfig()
    const parsed = JSON.parse(raw) as ZoneConfig
    if (parsed && Array.isArray(parsed.zones)) return normalizeConfig(parsed)
  } catch {
    /* fall through to defaults */
  }
  return defaultZoneConfig()
}

function normalizeConfig(c: ZoneConfig): ZoneConfig {
  return {
    zones: c.zones.map((z, i) => ({
      id: z.id || String(i + 1),
      label: z.label || `Zone ${i + 1}`,
      entries: (z.entries ?? [])
        .filter((e) => e && e.country)
        .map((e) => ({ country: canonicalCountry(e.country), lineType: normalizeType(e.lineType) }))
    }))
  }
}

let zoneRevision = 0

/** Bumped every time the zone configuration is edited. Anything that caches a
 *  result derived from zones (the report's call classification) keys off this so
 *  an edit can't leave stale zones on screen. */
export function getZoneRevision(): number {
  return zoneRevision
}

function saveZoneConfig(c: ZoneConfig): void {
  try {
    localStorage.setItem(ZONE_KEY, JSON.stringify(c))
  } catch {
    /* storage unavailable — non-fatal */
  }
  lookupCache = null // invalidate the derived lookup
  zoneRevision++
}

// --- Call → zone lookup ------------------------------------------------------

interface ZoneLookup {
  byKey: Map<string, string> // "COUNTRY|Type" -> zone label
  byCountry: Map<string, Set<string>> // country -> zone labels (any type)
  labels: string[] // zone labels in config order
}

let lookupCache: { json: string; lookup: ZoneLookup } | null = null

function buildLookup(c: ZoneConfig): ZoneLookup {
  const byKey = new Map<string, string>()
  const byCountry = new Map<string, Set<string>>()
  for (const z of c.zones) {
    for (const e of z.entries) {
      const key = `${e.country}|${e.lineType}`
      if (!byKey.has(key)) byKey.set(key, z.label)
      let set = byCountry.get(e.country)
      if (!set) {
        set = new Set()
        byCountry.set(e.country, set)
      }
      set.add(z.label)
    }
  }
  return { byKey, byCountry, labels: c.zones.map((z) => z.label) }
}

/** Cached lookup derived from the persisted config (rebuilt only when it
 *  changes). */
export function getZoneLookup(): ZoneLookup {
  let json = ''
  try {
    json = localStorage.getItem(ZONE_KEY) ?? ''
  } catch {
    /* ignore */
  }
  if (lookupCache && lookupCache.json === json) return lookupCache.lookup
  const lookup = buildLookup(loadZoneConfig())
  lookupCache = { json, lookup }
  return lookup
}

export interface ZoneResult {
  zone: string | null
  country: string
  lineType: LineType | 'unknown'
  /** Tariff rate (EUR/min) when the number matched a tariff row. */
  rate?: number
}

/** Resolve a call's external number to its configured zone, matching via the
 *  tariff first (precise country + line type) and falling back to the calling-
 *  code table. When the exact (country, type) isn't configured but the country
 *  maps to exactly one zone, that zone is used. */
export function zoneForNumber(
  external: string | undefined,
  homeCode: string,
  lookup: ZoneLookup = getZoneLookup()
): ZoneResult {
  let country = ''
  let lineType: LineType | 'unknown' = 'unknown'
  let rate: number | undefined

  const m = matchTariff(external, homeCode)
  if (m) {
    country = m.country
    lineType = m.lineType
    rate = m.rate
  } else {
    const intl = parseInternational(external)
    if (intl) country = canonicalCountry(intl.country)
  }
  if (!country) return { zone: null, country: '', lineType, rate }

  const exact = lineType !== 'unknown' ? lookup.byKey.get(`${country}|${lineType}`) : undefined
  if (exact) return { zone: exact, country, lineType, rate }
  const set = lookup.byCountry.get(country)
  if (set && set.size === 1) return { zone: [...set][0], country, lineType, rate }
  return { zone: null, country, lineType, rate }
}

// --- Import / export ---------------------------------------------------------

function exportConfig(c: ZoneConfig): void {
  const blob = new Blob([JSON.stringify(c, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'espionage-call-zones.json'
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function importConfig(onDone: (c: ZoneConfig) => void): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'application/json,.json'
  input.addEventListener('change', () => {
    const file = input.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as ZoneConfig
        if (!parsed || !Array.isArray(parsed.zones)) throw new Error('bad shape')
        onDone(normalizeConfig(parsed))
        flash('Call zones imported.')
      } catch {
        flash('Could not read that zone file.', true)
      }
    }
    reader.readAsText(file)
  })
  input.click()
}

// --- Settings modal ----------------------------------------------------------

const btn = 'px-3 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-sm text-slate-100'
const chip =
  'inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full bg-slate-100 dark:bg-slate-700 text-xs'

/** Open the Call zones settings modal. Edits a working copy; Save persists it. */
export function showZoneSettings(): void {
  let config = loadZoneConfig()

  const overlay = document.createElement('div')
  overlay.className = 'fixed inset-0 z-[110] flex items-center justify-center bg-black/40 p-4'
  overlay.innerHTML = `
    <div class="w-[720px] max-w-full max-h-[88vh] flex flex-col bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-lg shadow-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
      <div class="flex items-center justify-between gap-2 px-4 py-3 border-b border-slate-200 dark:border-slate-700 shrink-0">
        <div>
          <h2 class="font-semibold text-slate-800 dark:text-slate-100">Call zones</h2>
          <p class="text-[11px] text-slate-400">Group destinations into tariff bands. Calls are matched by number → country + line type.</p>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <button id="zImport" class="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-100 text-xs">Import</button>
          <button id="zExport" class="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-100 text-xs">Export</button>
          <button id="zReset" class="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-100 text-xs">Reset</button>
          <button data-close class="text-slate-400 hover:text-slate-700 dark:hover:text-slate-100 text-lg leading-none">✕</button>
        </div>
      </div>
      <div id="zBody" class="esp-scroll overflow-y-auto p-4 space-y-4"></div>
      <div class="shrink-0 flex items-center justify-between gap-2 px-4 py-3 border-t border-slate-200 dark:border-slate-700">
        <button id="zAddZone" class="${btn} bg-slate-500 hover:bg-slate-400">+ Add zone</button>
        <div class="flex gap-2">
          <button data-close class="${btn} bg-slate-500 hover:bg-slate-400">Cancel</button>
          <button id="zSave" class="${btn} bg-emerald-600 hover:bg-emerald-500">Save</button>
        </div>
      </div>
      <datalist id="zCountryList">${countryTypeOptions()}</datalist>
    </div>`
  document.body.appendChild(overlay)
  const close = (): void => overlay.remove()
  overlay
    .querySelectorAll<HTMLElement>('[data-close]')
    .forEach((b) => b.addEventListener('click', close))

  const bodyEl = overlay.querySelector<HTMLElement>('#zBody')!

  const render = (): void => {
    bodyEl.innerHTML = config.zones.map((z, i) => zonePanel(z, i)).join('')
    wire()
  }

  const wire = (): void => {
    for (const el of bodyEl.querySelectorAll<HTMLElement>('[data-remove-zone]')) {
      el.addEventListener('click', () => {
        config.zones.splice(Number(el.dataset.removeZone), 1)
        render()
      })
    }
    for (const el of bodyEl.querySelectorAll<HTMLInputElement>('[data-zone-label]')) {
      el.addEventListener('change', () => {
        config.zones[Number(el.dataset.zoneLabel)].label = el.value.trim() || el.defaultValue
      })
    }
    for (const el of bodyEl.querySelectorAll<HTMLElement>('[data-remove-entry]')) {
      el.addEventListener('click', () => {
        const [zi, ei] = el.dataset.removeEntry!.split(':').map(Number)
        config.zones[zi].entries.splice(ei, 1)
        render()
      })
    }
    for (const form of bodyEl.querySelectorAll<HTMLFormElement>('[data-add-entry]')) {
      form.addEventListener('submit', (e) => {
        e.preventDefault()
        const zi = Number(form.dataset.addEntry)
        const input = form.querySelector<HTMLInputElement>('input')!
        const entry = parseCountryTypeInput(input.value)
        if (!entry) {
          flash('Pick a country · type from the list.', true)
          return
        }
        const zone = config.zones[zi]
        if (
          zone.entries.some((x) => x.country === entry.country && x.lineType === entry.lineType)
        ) {
          flash('Already in this zone.', true)
        } else {
          zone.entries.push(entry)
          render()
        }
        input.value = ''
      })
    }
  }

  overlay.querySelector('#zAddZone')!.addEventListener('click', () => {
    const n = config.zones.length + 1
    config.zones.push({ id: String(n), label: `Zone ${n}`, entries: [] })
    render()
  })
  overlay.querySelector('#zExport')!.addEventListener('click', () => exportConfig(config))
  overlay.querySelector('#zImport')!.addEventListener('click', () =>
    importConfig((c) => {
      config = c
      render()
    })
  )
  overlay.querySelector('#zReset')!.addEventListener('click', () => {
    config = defaultZoneConfig()
    render()
  })
  overlay.querySelector('#zSave')!.addEventListener('click', () => {
    saveZoneConfig(config)
    flash('Call zones saved.')
    close()
  })

  render()
}

function zonePanel(z: ZoneDef, i: number): string {
  const chips = z.entries.length
    ? z.entries
        .map(
          (e, ei) =>
            `<span class="${chip}"><span>${esc(e.country)}</span><span class="text-slate-400">·</span><span class="text-slate-500 dark:text-slate-300">${esc(e.lineType)}</span><button data-remove-entry="${i}:${ei}" class="ml-0.5 w-4 h-4 rounded-full hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-500" title="Remove">✕</button></span>`
        )
        .join(' ')
    : `<span class="text-xs text-slate-400">No destinations yet.</span>`
  return `
    <div class="rounded-lg border border-slate-200 dark:border-slate-700 p-3">
      <div class="flex items-center gap-2 mb-2">
        <input data-zone-label="${i}" value="${esc(z.label)}" class="font-semibold bg-transparent border-b border-transparent hover:border-slate-300 focus:border-sky-500 focus:outline-none text-sm px-0.5" />
        <span class="text-xs text-slate-400">${z.entries.length} destination${z.entries.length === 1 ? '' : 's'}</span>
        <button data-remove-zone="${i}" class="ml-auto text-xs text-slate-400 hover:text-red-500" title="Delete zone">Delete zone</button>
      </div>
      <div class="flex flex-wrap gap-1.5 mb-2">${chips}</div>
      <form data-add-entry="${i}" class="flex items-center gap-1.5">
        <input list="zCountryList" placeholder="Add country · type…" class="flex-1 px-2 py-1 rounded bg-slate-100 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-xs" />
        <button type="submit" class="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-100 text-xs">Add</button>
      </form>
    </div>`
}

/** Datalist options: every (country, type) the tariff can actually match. */
function countryTypeOptions(): string {
  return tariffCountryTypes()
    .map((ct) => `<option value="${esc(`${ct.country} · ${ct.lineType}`)}"></option>`)
    .join('')
}

/** Parse a "COUNTRY · Type" datalist selection back into a ZoneEntry. */
function parseCountryTypeInput(value: string): ZoneEntry | null {
  const v = value.trim()
  if (!v) return null
  const parts = v.split(/\s*·\s*/)
  const country = canonicalCountry(parts[0] ?? '')
  if (!country) return null
  const lineType = parts[1] ? normalizeType(parts[1]) : 'Landline'
  return { country, lineType }
}
