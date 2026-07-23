// Phone-number / country classification shared by the main and renderer
// processes. Pure functions + a calling-code table, so the report engine can be
// unit-tested and the same logic drives both enrichment (main) and the live
// re-classification the report dropdowns do (renderer).
//
// Heuristics are deliberately conservative because 3CX's call-log number
// formats vary by version:
//  - A short, all-digit endpoint is treated as an internal extension.
//  - A number written in international form (leading "+" or "00") is matched to
//    its country by longest dialling-code prefix.
//  - Everything else is treated as a domestic (national) PSTN number.
// "National vs international" is only meaningful relative to a home country, so
// that comparison is done against a caller-supplied home dialling code, not
// baked in here.

export type CallDirection = 'inbound' | 'outbound' | 'internal' | 'unknown'
export type CallScope = 'internal' | 'national' | 'international'

export interface CallingCode {
  /** Dialling code without the leading "+", e.g. "44". */
  code: string
  /** ISO 3166-1 alpha-2, e.g. "GB". Blank for shared/unknown buckets. */
  iso2: string
  country: string
}

/** International dialling codes, most common destinations first-class.
 *  Shared codes (NANP "+1") map to a region label rather than a single state. */
const RAW_CODES: ReadonlyArray<readonly [string, string, string]> = [
  ['1', 'US', 'North America (NANP)'],
  ['7', 'RU', 'Russia / Kazakhstan'],
  ['20', 'EG', 'Egypt'],
  ['27', 'ZA', 'South Africa'],
  ['30', 'GR', 'Greece'],
  ['31', 'NL', 'Netherlands'],
  ['32', 'BE', 'Belgium'],
  ['33', 'FR', 'France'],
  ['34', 'ES', 'Spain'],
  ['36', 'HU', 'Hungary'],
  ['39', 'IT', 'Italy'],
  ['40', 'RO', 'Romania'],
  ['41', 'CH', 'Switzerland'],
  ['43', 'AT', 'Austria'],
  ['44', 'GB', 'United Kingdom'],
  ['45', 'DK', 'Denmark'],
  ['46', 'SE', 'Sweden'],
  ['47', 'NO', 'Norway'],
  ['48', 'PL', 'Poland'],
  ['49', 'DE', 'Germany'],
  ['51', 'PE', 'Peru'],
  ['52', 'MX', 'Mexico'],
  ['53', 'CU', 'Cuba'],
  ['54', 'AR', 'Argentina'],
  ['55', 'BR', 'Brazil'],
  ['56', 'CL', 'Chile'],
  ['57', 'CO', 'Colombia'],
  ['58', 'VE', 'Venezuela'],
  ['60', 'MY', 'Malaysia'],
  ['61', 'AU', 'Australia'],
  ['62', 'ID', 'Indonesia'],
  ['63', 'PH', 'Philippines'],
  ['64', 'NZ', 'New Zealand'],
  ['65', 'SG', 'Singapore'],
  ['66', 'TH', 'Thailand'],
  ['81', 'JP', 'Japan'],
  ['82', 'KR', 'South Korea'],
  ['84', 'VN', 'Vietnam'],
  ['86', 'CN', 'China'],
  ['90', 'TR', 'Turkey'],
  ['91', 'IN', 'India'],
  ['92', 'PK', 'Pakistan'],
  ['93', 'AF', 'Afghanistan'],
  ['94', 'LK', 'Sri Lanka'],
  ['95', 'MM', 'Myanmar'],
  ['98', 'IR', 'Iran'],
  ['211', 'SS', 'South Sudan'],
  ['212', 'MA', 'Morocco'],
  ['213', 'DZ', 'Algeria'],
  ['216', 'TN', 'Tunisia'],
  ['218', 'LY', 'Libya'],
  ['220', 'GM', 'Gambia'],
  ['221', 'SN', 'Senegal'],
  ['233', 'GH', 'Ghana'],
  ['234', 'NG', 'Nigeria'],
  ['251', 'ET', 'Ethiopia'],
  ['254', 'KE', 'Kenya'],
  ['255', 'TZ', 'Tanzania'],
  ['256', 'UG', 'Uganda'],
  ['260', 'ZM', 'Zambia'],
  ['263', 'ZW', 'Zimbabwe'],
  ['264', 'NA', 'Namibia'],
  ['265', 'MW', 'Malawi'],
  ['267', 'BW', 'Botswana'],
  ['351', 'PT', 'Portugal'],
  ['352', 'LU', 'Luxembourg'],
  ['353', 'IE', 'Ireland'],
  ['354', 'IS', 'Iceland'],
  ['355', 'AL', 'Albania'],
  ['356', 'MT', 'Malta'],
  ['357', 'CY', 'Cyprus'],
  ['358', 'FI', 'Finland'],
  ['359', 'BG', 'Bulgaria'],
  ['370', 'LT', 'Lithuania'],
  ['371', 'LV', 'Latvia'],
  ['372', 'EE', 'Estonia'],
  ['373', 'MD', 'Moldova'],
  ['374', 'AM', 'Armenia'],
  ['375', 'BY', 'Belarus'],
  ['376', 'AD', 'Andorra'],
  ['377', 'MC', 'Monaco'],
  ['378', 'SM', 'San Marino'],
  ['380', 'UA', 'Ukraine'],
  ['381', 'RS', 'Serbia'],
  ['382', 'ME', 'Montenegro'],
  ['383', 'XK', 'Kosovo'],
  ['385', 'HR', 'Croatia'],
  ['386', 'SI', 'Slovenia'],
  ['387', 'BA', 'Bosnia & Herzegovina'],
  ['389', 'MK', 'North Macedonia'],
  ['420', 'CZ', 'Czechia'],
  ['421', 'SK', 'Slovakia'],
  ['423', 'LI', 'Liechtenstein'],
  ['500', 'FK', 'Falkland Islands'],
  ['501', 'BZ', 'Belize'],
  ['502', 'GT', 'Guatemala'],
  ['503', 'SV', 'El Salvador'],
  ['504', 'HN', 'Honduras'],
  ['505', 'NI', 'Nicaragua'],
  ['506', 'CR', 'Costa Rica'],
  ['507', 'PA', 'Panama'],
  ['509', 'HT', 'Haiti'],
  ['590', 'GP', 'Guadeloupe'],
  ['591', 'BO', 'Bolivia'],
  ['593', 'EC', 'Ecuador'],
  ['595', 'PY', 'Paraguay'],
  ['598', 'UY', 'Uruguay'],
  ['599', 'CW', 'Curaçao'],
  ['673', 'BN', 'Brunei'],
  ['850', 'KP', 'North Korea'],
  ['852', 'HK', 'Hong Kong'],
  ['853', 'MO', 'Macau'],
  ['855', 'KH', 'Cambodia'],
  ['856', 'LA', 'Laos'],
  ['880', 'BD', 'Bangladesh'],
  ['886', 'TW', 'Taiwan'],
  ['960', 'MV', 'Maldives'],
  ['961', 'LB', 'Lebanon'],
  ['962', 'JO', 'Jordan'],
  ['963', 'SY', 'Syria'],
  ['964', 'IQ', 'Iraq'],
  ['965', 'KW', 'Kuwait'],
  ['966', 'SA', 'Saudi Arabia'],
  ['967', 'YE', 'Yemen'],
  ['968', 'OM', 'Oman'],
  ['970', 'PS', 'Palestine'],
  ['971', 'AE', 'United Arab Emirates'],
  ['972', 'IL', 'Israel'],
  ['973', 'BH', 'Bahrain'],
  ['974', 'QA', 'Qatar'],
  ['975', 'BT', 'Bhutan'],
  ['976', 'MN', 'Mongolia'],
  ['977', 'NP', 'Nepal'],
  ['992', 'TJ', 'Tajikistan'],
  ['993', 'TM', 'Turkmenistan'],
  ['994', 'AZ', 'Azerbaijan'],
  ['995', 'GE', 'Georgia'],
  ['996', 'KG', 'Kyrgyzstan'],
  ['998', 'UZ', 'Uzbekistan']
]

/** Full calling-code list, sorted by country name for dropdowns. */
export const CALLING_CODES: CallingCode[] = RAW_CODES.map(([code, iso2, country]) => ({
  code,
  iso2,
  country
})).sort((a, b) => a.country.localeCompare(b.country))

const BY_CODE = new Map<string, CallingCode>()
const BY_ISO = new Map<string, CallingCode>()
for (const c of CALLING_CODES) {
  if (!BY_CODE.has(c.code)) BY_CODE.set(c.code, c)
  BY_ISO.set(c.iso2, c)
}

/** Look up the calling code for an ISO2 country (dropdown selection → code). */
export function callingCodeForIso(iso2: string): CallingCode | undefined {
  return BY_ISO.get(iso2)
}

/** Numbers that look like an internal extension (short, all-digit). */
export function isExtensionLike(s: string): boolean {
  return /^\d{2,6}$/.test(s.trim())
}

/** Strip a number to its international significant digits, or null when it is
 *  not written in international form (no leading "+" or "00"). */
function internationalDigits(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  if (s.startsWith('+')) return s.slice(1).replace(/\D/g, '') || null
  const digits = s.replace(/\D/g, '')
  if (digits.startsWith('00')) return digits.slice(2) || null
  return null
}

/** Match a number written in international form to its country. Returns null for
 *  numbers not in international form (treated as domestic by callers). An
 *  unknown code still resolves so the call is counted as international. */
export function parseInternational(raw: string | undefined): CallingCode | null {
  if (!raw) return null
  const digits = internationalDigits(raw)
  if (!digits) return null
  for (let len = Math.min(3, digits.length); len >= 1; len--) {
    const code = digits.slice(0, len)
    const hit = BY_CODE.get(code)
    if (hit) return hit
  }
  const code = digits.slice(0, 2) || digits.slice(0, 1)
  return { code, iso2: '', country: `Unknown (+${code})` }
}

/** Match a bare (no "+"/"00") number that nonetheless starts with a country
 *  dialling code — e.g. a trunk DID like "35318665644". Only fires when the
 *  leading digits are a real code AND the number is long enough to be a full
 *  E.164 number, so ordinary national numbers (starting with a trunk-access 0)
 *  don't false-match. Used to infer the PBX's home country from its trunks. */
export function countryFromBareNumber(raw: string | undefined): CallingCode | null {
  const digits = (raw ?? '').replace(/\D/g, '')
  if (digits.length < 8) return null
  for (let len = Math.min(3, digits.length); len >= 1; len--) {
    const hit = BY_CODE.get(digits.slice(0, len))
    if (hit) return hit
  }
  return null
}

/** Pull the trunk name + number out of a 3CX call-log `Reason` string, e.g.
 *  "… → Via trunk: SIP3 (35318665644) → …" → { name: "SIP3", number: "35318665644" }. */
export function parseTrunkFromReason(
  reason: string | undefined
): { name: string; number: string } | null {
  if (!reason) return null
  const m = /via trunk:\s*(.+?)\s*\(([^)]*)\)/i.exec(reason)
  if (!m) return null
  return { name: m[1].trim(), number: m[2].trim() }
}

/** Normalise a raw 3CX direction/call-type plus the two endpoints into one of
 *  inbound / outbound / internal / unknown. Textual hints win; otherwise it is
 *  inferred structurally from which endpoints look like extensions. */
export function classifyDirection(
  from: string | undefined,
  to: string | undefined,
  rawDirection: string | undefined
): CallDirection {
  const d = (rawDirection ?? '').toLowerCase()
  if (/internal|local/.test(d)) return 'internal'
  if (/inbound|incoming|\bin\b/.test(d)) return 'inbound'
  if (/outbound|outgoing|\bout\b/.test(d)) return 'outbound'
  const fromExt = !!from && isExtensionLike(from)
  const toExt = !!to && isExtensionLike(to)
  if (fromExt && toExt) return 'internal'
  if (fromExt && !toExt) return 'outbound'
  if (!fromExt && toExt) return 'inbound'
  return 'unknown'
}

/** Given a direction, decide which endpoint is the internal extension the call
 *  is attributed to and which is the external party. */
export function pickParties(
  from: string | undefined,
  to: string | undefined,
  direction: CallDirection
): { extension?: string; external?: string } {
  const fromExt = !!from && isExtensionLike(from)
  const toExt = !!to && isExtensionLike(to)
  switch (direction) {
    case 'internal':
      return { extension: fromExt ? from : toExt ? to : undefined, external: undefined }
    case 'inbound':
      return { extension: toExt ? to : undefined, external: from }
    case 'outbound':
      return { extension: fromExt ? from : undefined, external: to }
    default:
      if (fromExt && !toExt) return { extension: from, external: to }
      if (!fromExt && toExt) return { extension: to, external: from }
      return { extension: fromExt ? from : toExt ? to : undefined, external: undefined }
  }
}

export interface ScopeResult {
  scope: CallScope
  /** Display label: home country name / international country / "Internal". */
  country: string
  /** ISO2 for the external country, blank for internal/unknown. */
  iso2: string
}

/** Classify a single call's scope (internal / national / international) relative
 *  to a home dialling code. `homeCode`/`homeName` may be blank when the user has
 *  not chosen a home country, in which case domestic numbers are labelled
 *  "National" and only explicitly-foreign numbers count as international. */
export function classifyScope(
  direction: CallDirection,
  intl: CallingCode | null,
  homeCode: string,
  homeName: string
): ScopeResult {
  if (direction === 'internal') return { scope: 'internal', country: 'Internal', iso2: '' }
  const homeIso = homeCode ? (BY_CODE.get(homeCode)?.iso2 ?? '') : ''
  const nationalLabel = homeName || 'National'
  // Domestic-format number, or an explicit international number whose code is the
  // home code, both count as national.
  if (!intl || (homeCode && intl.code === homeCode))
    return { scope: 'national', country: nationalLabel, iso2: homeIso }
  return { scope: 'international', country: intl.country, iso2: intl.iso2 }
}
