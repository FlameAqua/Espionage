// Bundled carrier tariff (NTES retail, EUR) used to classify an external number
// by longest-prefix match. Where the country-code table in ../../../shared/phone
// only knows the country, the tariff's per-operator prefixes additionally tell us
// whether a number is a landline, a mobile, or "other" (premium / non-geo / …),
// and give a per-minute rate — the extra signal the call-zone report needs.
//
// The CSV is bundled as raw text and parsed once at module load.

import rawCsv from './tariff.csv?raw'

export type LineType = 'Landline' | 'Mobile' | 'Other'

export interface TariffEntry {
  /** Raw tariff label, e.g. "Ireland-Mobile-Vodafone". */
  destination: string
  /** Full international prefix incl. country code, e.g. "35387". */
  prefix: string
  /** Rate in EUR per minute. */
  rate: number
  /** Canonical country name (uppercase), e.g. "IRELAND". */
  country: string
  lineType: LineType
}

export interface TariffMatch {
  entry: TariffEntry
  country: string
  lineType: LineType
  rate: number
}

/** Minimal CSV row splitter that honours double-quoted fields (a few tariff rows
 *  quote labels containing commas). */
function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else inQuotes = false
      } else cur += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}

/** Normalise a raw tariff/zone country name to a canonical uppercase key, folding
 *  the naming variants that appear across the tariff, the calling-code table and
 *  the user's zone list (UK vs United Kingdom, US spellings, Korea, …) so they
 *  all match. Any type suffix has already been stripped by the caller. */
export function canonicalCountry(raw: string): string {
  const s = raw.trim().toUpperCase().replace(/\s+/g, ' ').replace(/\.+$/, '')
  const alias: Record<string, string> = {
    UK: 'UNITED KINGDOM',
    'GREAT BRITAIN': 'UNITED KINGDOM',
    US: 'UNITED STATES',
    USA: 'UNITED STATES',
    'UNITED STATES OF AMERICA': 'UNITED STATES',
    'SOUTH KOREA': 'KOREA SOUTH',
    'KOREA REP': 'KOREA SOUTH',
    'NORTH KOREA': 'KOREA NORTH',
    'CYPRUS SOUTH': 'CYPRUS',
    CZECHIA: 'CZECH REPUBLIC',
    'CZECH REP': 'CZECH REPUBLIC',
    'SLOVAK REP': 'SLOVAKIA',
    'SLOVAK REPUBLIC': 'SLOVAKIA',
    'DOMINICAN REP': 'DOMINICAN REPUBLIC',
    'BOSNIA AND HERZEGOVINA': 'BOSNIA',
    'BOSNIA & HERZEGOVINA': 'BOSNIA',
    'NORTH MACEDONIA': 'MACEDONIA',
    'VIRGIN ISLANDS USA': 'VIRGIN ISLANDS US',
    'VIRGIN ISLANDS GB': 'VIRGIN ISLANDS UK',
    'VIRGIN ISLANDS UK': 'VIRGIN ISLANDS UK',
    'BRUNEI DARUSSALAM': 'BRUNEI',
    'RUSSIAN FEDERATION': 'RUSSIA',
    "COTE D'IVOIRE": 'COTE DIVOIRE',
    'IVORY COAST': 'COTE DIVOIRE'
  }
  return alias[s] ?? s
}

/** Derive {country, lineType} from a tariff destination label. The country is the
 *  text before the first delimiter; the type comes from keywords anywhere in the
 *  label (mobile / fixed → landline / everything premium-ish → other). A plain
 *  country name with no type keyword is treated as a landline. */
function classifyDestination(destination: string): { country: string; lineType: LineType } {
  const rawCountry = destination.split(/\s*[-–]\s*/)[0]
  const t = destination.toLowerCase()
  let lineType: LineType = 'Landline'
  if (/mobile/.test(t)) lineType = 'Mobile'
  else if (/\b(fixed|landline|geo(?!.*non))\b/.test(t)) lineType = 'Landline'
  else if (
    /premium|non ?geo|special|voip|freephone|directory|operator|emergency|personal|networks|sat-|inmarsat|globalstar|iridium|thuraya|local|national|conduit|eircom|meteor|customer|repairs|speaking clock|fixed fee|blind|hsd|aeromobile|ellipso|emsat|voxbone|jersey|\bmcp\b|\bupt\b/.test(
      t
    )
  )
    lineType = 'Other'
  return { country: canonicalCountry(rawCountry), lineType }
}

const ENTRIES: TariffEntry[] = []
const BY_PREFIX = new Map<string, TariffEntry>()
let MAX_PREFIX_LEN = 1

{
  const lines = rawCsv.split(/\r?\n/)
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    const cols = splitCsvLine(line)
    const destination = (cols[0] ?? '').trim()
    const prefix = (cols[1] ?? '').replace(/\D/g, '')
    const rate = Number(cols[2])
    if (!destination || !prefix) continue
    const { country, lineType } = classifyDestination(destination)
    const entry: TariffEntry = {
      destination,
      prefix,
      rate: Number.isFinite(rate) ? rate : 0,
      country,
      lineType
    }
    ENTRIES.push(entry)
    // Longest-prefix match wants one entry per prefix; keep the first (the tariff
    // has a handful of duplicate prefixes with identical rates).
    if (!BY_PREFIX.has(prefix)) BY_PREFIX.set(prefix, entry)
    if (prefix.length > MAX_PREFIX_LEN) MAX_PREFIX_LEN = prefix.length
  }
}

/** Reduce a raw number to the international significant digits to match against
 *  tariff prefixes. Handles "+"/"00" international form; for a bare national
 *  number, prepends the home dialling code (dropping a single trunk-access 0) so
 *  domestic mobiles/landlines still resolve to the home country's tariff rows. */
function toIntlDigits(raw: string | undefined, homeCode: string): string | null {
  const s = (raw ?? '').trim()
  if (!s) return null
  if (s.startsWith('+')) return s.slice(1).replace(/\D/g, '') || null
  const digits = s.replace(/\D/g, '')
  if (!digits) return null
  if (digits.startsWith('00')) return digits.slice(2) || null
  if (homeCode) {
    // Already E.164 without the "+" (e.g. a trunk DID "35318665644").
    if (digits.startsWith(homeCode) && digits.length >= homeCode.length + 6) return digits
    // Otherwise a bare number from a home-country PBX is a NATIONAL number:
    // drop the trunk-access 0 and prepend the home code. This must win over the
    // bare-code guess below — "1" and "7" are real dialling codes, so an Irish
    // 1800/1850 number would otherwise be misread as North America.
    return homeCode + digits.replace(/^0+/, '')
  }
  // No home country to anchor against: only trust a bare number that starts with
  // a MULTI-digit country code, since a single leading "1"/"7" would swallow
  // ordinary national numbers.
  if (digits.length >= 8 && startsWithKnownCode(digits, 2)) return digits
  return null
}

function startsWithKnownCode(digits: string, minLen = 1): boolean {
  for (let len = Math.min(4, digits.length); len >= minLen; len--) {
    if (BY_PREFIX.has(digits.slice(0, len))) return true
  }
  return false
}

/** Longest-prefix match a number to a tariff entry. `homeCode` is the home
 *  country's dialling code (e.g. "353"), used to resolve national-format numbers. */
export function matchTariff(raw: string | undefined, homeCode = ''): TariffMatch | null {
  const digits = toIntlDigits(raw, homeCode)
  if (!digits) return null
  for (let len = Math.min(digits.length, MAX_PREFIX_LEN); len >= 1; len--) {
    const entry = BY_PREFIX.get(digits.slice(0, len))
    if (entry) return { entry, country: entry.country, lineType: entry.lineType, rate: entry.rate }
  }
  return null
}

/** The distinct (country, lineType) pairs present in the tariff, sorted for the
 *  settings dropdown. These are exactly the buckets a call can be matched into,
 *  so configuring zones from this list guarantees the config can actually match. */
export function tariffCountryTypes(): Array<{ country: string; lineType: LineType }> {
  const seen = new Set<string>()
  const out: Array<{ country: string; lineType: LineType }> = []
  for (const e of ENTRIES) {
    const key = `${e.country}|${e.lineType}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ country: e.country, lineType: e.lineType })
  }
  out.sort((a, b) => a.country.localeCompare(b.country) || a.lineType.localeCompare(b.lineType))
  return out
}
