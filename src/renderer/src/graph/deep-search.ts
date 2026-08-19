// Searching the phone system itself, rather than the graph drawn from it.
//
// The graph is a reading of the 3CX configuration: it keeps the handful of
// fields a call flow is made of and drops the rest. But the rest is fetched all
// the same — every field of every record in every collection — and when the
// question is "where on earth is this number configured?" or "which records
// still mention the old provider?", the answer is usually in a field the graph
// never looks at, on a record that never became a node.
//
// So this flattens each raw record to its leaves — nested objects, arrays and
// all — and searches those. A field holding a serialized blob (3CX stores a few
// as embedded JSON or XML) is searched as the text it is, so a term buried
// inside one is still found.
//
// A term can also name the field it wants: `"Number": "8006"` — the JSON as it
// reads in the record — or the plainer `Number: 8006`. See parseFieldQuery for
// how that is told apart from free text that happens to contain a colon.
//
// Credentials never arrive here to be found: passwords, SIP auth ids and
// voicemail PINs are replaced with a placeholder in the main process, before
// the topology crosses to the renderer (see shared/redact.ts).

import type { EntitySet, Topology } from '../../../shared/types'

/** One leaf of a record: where it sits, and what it holds. */
export interface DeepField {
  /** Path within the record, e.g. `Groups[0].Name`. */
  path: string
  /** The leaf rendered as text — what actually gets matched. */
  value: string
}

/** One raw 3CX record, flattened and ready to search. */
export interface DeepRecord {
  /** Collection key on the topology, e.g. `users`. */
  collection: CollectionKey
  /** What that collection is called in the interface. */
  collectionLabel: string
  /** The OData path 3CX served it from, e.g. `/xapi/v1/Users`. */
  source: string
  /** Best-effort identity, so a hit says which record it is. */
  title: string
  subtitle: string
  raw: Record<string, unknown>
  fields: DeepField[]
}

/** Where in a record the term was found. */
export interface DeepMatch {
  path: string
  value: string
  /** Offsets of the match within `value` (or within `path` when `inPath`). */
  start: number
  end: number
  /** The field's NAME matched, not its contents. */
  inPath: boolean
}

export interface DeepHit {
  record: DeepRecord
  matches: DeepMatch[]
  /** Lower sorts first. See RANK below. */
  rank: number
}

export interface DeepSearchOptions {
  /** Treat the term as a regular expression rather than plain text. */
  regex?: boolean
  /** Also match against field NAMES, not just their contents. */
  fieldNames?: boolean
  /** Stop after this many records have matched. */
  limit?: number
  /** Most matches reported per record. */
  perRecord?: number
}

/** A term read as "this field, holding this value" rather than as free text —
 *  `"Number": "8006"`, or `Number: 8006`, or `Groups[0].Name = Sales`. */
export interface FieldQuery {
  /** The field to look in, as typed. */
  key: string
  /** What its value must be. Empty means the field only has to be present. */
  value: string
  /** A quoted value is matched exactly; an unquoted one is a contains search.
   *  Typing the JSON as JSON therefore does what JSON says. */
  exact: boolean
}

export interface DeepSearchResult {
  hits: DeepHit[]
  /** Records that matched, including any dropped by `limit`. */
  total: number
  /** Set when a regex was asked for and wouldn't compile. */
  error?: string
  /** Set when the term was read as a field query rather than as free text, so
   *  the interface can say so instead of leaving it to be inferred. */
  query?: FieldQuery
}

/** How a hit is ordered: what it matched on matters more than where it sits. */
const RANK = {
  /** The record's own name or number — almost always the thing being looked for. */
  identity: 0,
  /** Any other field's contents. */
  value: 1,
  /** Only the field's name matched. */
  path: 2
}

export type CollectionKey =
  | 'users'
  | 'queues'
  | 'ringGroups'
  | 'receptionists'
  | 'inboundRules'
  | 'outboundRules'
  | 'didNumbers'
  | 'trunks'
  | 'groups'

/** Every collection the topology carries, in the order results are grouped —
 *  roughly the order a call travels: in off a trunk, through the rules, to the
 *  things that ring. */
export const DEEP_COLLECTIONS: Array<{ key: CollectionKey; label: string }> = [
  { key: 'trunks', label: 'Trunks' },
  { key: 'inboundRules', label: 'Inbound rules' },
  { key: 'didNumbers', label: 'DID numbers' },
  { key: 'outboundRules', label: 'Outbound rules' },
  { key: 'receptionists', label: 'IVRs' },
  { key: 'queues', label: 'Queues' },
  { key: 'ringGroups', label: 'Ring groups' },
  { key: 'users', label: 'Extensions' },
  { key: 'groups', label: 'Departments' }
]

/** Deep enough for anything 3CX nests, shallow enough that a surprise can't
 *  wander forever. */
const MAX_DEPTH = 12
/** Fields whose contents identify the record, so a match in one outranks the
 *  rest. Compared against the whole path, so `Groups[0].Name` doesn't qualify. */
const IDENTITY_FIELDS = /^(Name|Number|FirstName|LastName|DisplayName|DN|Id)$/i

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** Flatten one record to `path` → `value` leaves. Empty values are skipped:
 *  they can't match anything and 3CX records are full of them. */
export function flattenRecord(raw: Record<string, unknown>): DeepField[] {
  const out: DeepField[] = []
  const walk = (value: unknown, path: string, depth: number): void => {
    if (depth > MAX_DEPTH) return
    if (value == null) return
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`, depth + 1))
      return
    }
    if (isRecord(value)) {
      for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k, depth + 1)
      return
    }
    const text = String(value)
    if (text === '') return
    out.push({ path, value: text })
  }
  walk(raw, '', 0)
  return out
}

/** First non-empty value among `keys`, at the top level of the record. */
function pick(raw: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = raw[k]
    if (v == null || typeof v === 'object') continue
    const s = String(v).trim()
    if (s) return s
  }
  return ''
}

/** Who this record is, as far as it can be told from the record itself. Every
 *  collection names things differently, so this is a sweep rather than a lookup;
 *  an unnamed record falls back to its id so it can still be told apart. */
function identify(raw: Record<string, unknown>): { title: string; subtitle: string } {
  const first = pick(raw, ['FirstName'])
  const last = pick(raw, ['LastName'])
  const name =
    pick(raw, ['Name', 'DisplayName', 'FriendlyName', 'RuleName']) ||
    [first, last].filter(Boolean).join(' ')
  const number = pick(raw, ['Number', 'DN', 'DidNumber', 'Extension'])
  const id = pick(raw, ['Id'])
  return {
    title: name || number || (id ? `#${id}` : 'Unnamed record'),
    subtitle: name && number ? number : name && id ? `#${id}` : number && id ? `#${id}` : ''
  }
}

/** Flattened topology, built once per topology object. Rebuilding it on every
 *  keystroke would walk every field of every record again; a refetch produces a
 *  new topology and so a new index, which is exactly when it should be rebuilt. */
const indexCache = new WeakMap<Topology, DeepRecord[]>()

export function buildDeepIndex(topology: Topology): DeepRecord[] {
  const cached = indexCache.get(topology)
  if (cached) return cached
  const records: DeepRecord[] = []
  for (const { key, label } of DEEP_COLLECTIONS) {
    const set = topology[key] as EntitySet | undefined
    if (!set?.value?.length) continue
    for (const raw of set.value) {
      if (!isRecord(raw)) continue
      records.push({
        collection: key,
        collectionLabel: label,
        source: set.path,
        ...identify(raw),
        raw,
        fields: flattenRecord(raw)
      })
    }
  }
  indexCache.set(topology, records)
  return records
}

/** Total leaves across the index — the honest measure of what a search covers. */
export function countFields(records: DeepRecord[]): number {
  let n = 0
  for (const r of records) n += r.fields.length
  return n
}

/** Every field name and path in the index, lower-cased. Used to tell a field
 *  query from free text that merely contains a colon — see parseFieldQuery. */
const fieldNameCache = new WeakMap<DeepRecord[], Set<string>>()

export function knownFieldNames(records: DeepRecord[]): Set<string> {
  const cached = fieldNameCache.get(records)
  if (cached) return cached
  const names = new Set<string>()
  for (const r of records) {
    for (const f of r.fields) {
      const p = f.path.toLowerCase()
      names.add(p)
      // A path with its array indices dropped, and its last segment alone, so
      // `Groups[0].Name` answers to `groups.name` and to `name`.
      names.add(p.replace(/\[\d+\]/g, ''))
      const last = p.split('.').pop()
      if (last) names.add(last.replace(/\[\d+\]/g, ''))
    }
  }
  fieldNameCache.set(records, names)
  return names
}

/** `"Number": "8006"` — the JSON as it appears in the record itself. Quoting the
 *  key is an unambiguous statement of intent, so that form is always read as a
 *  query. */
const QUOTED_QUERY = /^"([^"]+)"\s*[:=]\s*(.*)$/
/** `Number: 8006`, `Groups[0].Name = Sales` — the same thing without the
 *  ceremony. Ambiguous on its own (`https://pbx` fits the shape), so this form
 *  is only believed when the key names a field the system actually has. */
const BARE_QUERY = /^([A-Za-z_][\w.[\]]*)\s*[:=]\s*(.*)$/

/**
 * Read a term as a field query, or return null to treat it as free text.
 *
 * `known` decides the ambiguous cases: a URL typed into the search box has the
 * same shape as `key: value`, and the only reliable way to tell them apart is
 * whether the system has a field by that name. So detection is answered by the
 * data rather than guessed at from the punctuation.
 */
export function parseFieldQuery(term: string, known: Set<string>): FieldQuery | null {
  const t = term.trim()
  const quoted = QUOTED_QUERY.exec(t)
  const bare = quoted ? null : BARE_QUERY.exec(t)
  const m = quoted ?? bare
  if (!m) return null
  const key = m[1].trim()
  if (!key) return null
  // `Groups[0].Name` and `Groups.Name` name the same field; either spelling
  // counts as known.
  const k = key.toLowerCase()
  if (!quoted && !known.has(k) && !known.has(k.replace(/\[\d+\]/g, ''))) return null
  let value = m[2].trim()
  // A trailing comma is what you get from pasting a line straight out of the
  // JSON; it is punctuation, not part of the value.
  value = value.replace(/,$/, '').trim()
  const q = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value)
  return { key, value: q ? q[1] : value, exact: !!q }
}

/** Does `path` answer to the name the query asked for? Exact path, the path
 *  without its array indices, or its last segment alone. */
function pathMatchesKey(path: string, key: string): boolean {
  const p = path.toLowerCase()
  const k = key.toLowerCase()
  if (p === k) return true
  const stripped = p.replace(/\[\d+\]/g, '')
  if (stripped === k) return true
  const last = stripped.split('.').pop()
  return last === k
}

/** A matcher over one string, returning the first hit's offsets or null. Plain
 *  terms and regexes are reduced to the same shape so the search loop below
 *  doesn't care which it was given. */
function makeMatcher(term: string, regex: boolean): (s: string) => [number, number] | null {
  if (!regex) {
    const needle = term.toLowerCase()
    return (s) => {
      const i = s.toLowerCase().indexOf(needle)
      return i < 0 ? null : [i, i + needle.length]
    }
  }
  // Case-insensitive to match the plain-text behaviour; `g` is deliberately
  // absent so lastIndex can't carry between calls.
  const re = new RegExp(term, 'i')
  return (s) => {
    const m = re.exec(s)
    return m ? [m.index, m.index + m[0].length] : null
  }
}

/**
 * Search a built index. Pure, so the ordering and the limits are testable
 * without a topology or a canvas.
 */
export function searchDeep(
  records: DeepRecord[],
  term: string,
  opts: DeepSearchOptions = {}
): DeepSearchResult {
  const t = term.trim()
  if (!t) return { hits: [], total: 0 }
  const limit = opts.limit ?? 400
  const perRecord = opts.perRecord ?? 12

  // A regex is taken at its word — the whole term, no field-query reading of it.
  // That keeps regex semantics unsurprising and gives a way to search for text
  // that merely looks like a query.
  const query = opts.regex ? null : parseFieldQuery(t, knownFieldNames(records))

  let match: (s: string) => [number, number] | null
  try {
    match = makeMatcher(query ? query.value : t, !!opts.regex)
  } catch (err) {
    return { hits: [], total: 0, error: `Invalid regular expression: ${(err as Error).message}` }
  }

  const hits: DeepHit[] = []
  let total = 0
  for (const record of records) {
    const matches: DeepMatch[] = []
    let rank = RANK.path
    for (const f of record.fields) {
      if (query) {
        // Field query: the field has to be the one asked for, and then its value
        // has to satisfy the test. An empty value asks only that it exists.
        if (!pathMatchesKey(f.path, query.key)) continue
        let span: [number, number] | null = null
        if (!query.value) span = [0, f.value.length]
        else if (query.exact)
          span = f.value.toLowerCase() === query.value.toLowerCase() ? [0, f.value.length] : null
        else span = match(f.value)
        if (!span) continue
        if (matches.length < perRecord)
          matches.push({
            path: f.path,
            value: f.value,
            start: span[0],
            end: span[1],
            inPath: false
          })
        rank = Math.min(rank, IDENTITY_FIELDS.test(f.path) ? RANK.identity : RANK.value)
        continue
      }
      const inValue = match(f.value)
      if (inValue) {
        if (matches.length < perRecord)
          matches.push({
            path: f.path,
            value: f.value,
            start: inValue[0],
            end: inValue[1],
            inPath: false
          })
        rank = Math.min(rank, IDENTITY_FIELDS.test(f.path) ? RANK.identity : RANK.value)
        continue
      }
      if (!opts.fieldNames) continue
      const inPath = match(f.path)
      if (inPath && matches.length < perRecord)
        matches.push({
          path: f.path,
          value: f.value,
          start: inPath[0],
          end: inPath[1],
          inPath: true
        })
    }
    if (!matches.length) continue
    total++
    if (hits.length < limit) hits.push({ record, matches, rank })
  }

  // Rank first, then the collection order above, so results read in a stable
  // arrangement rather than jumping about as the term is typed.
  const order = new Map(DEEP_COLLECTIONS.map((c, i) => [c.key, i]))
  hits.sort(
    (a, b) =>
      a.rank - b.rank ||
      (order.get(a.record.collection) ?? 99) - (order.get(b.record.collection) ?? 99) ||
      a.record.title.localeCompare(b.record.title, undefined, { numeric: true })
  )
  return query ? { hits, total, query } : { hits, total }
}

/** A window of `value` around the match, so a hit inside a large embedded blob
 *  shows the part that matched instead of the whole field. Returns the three
 *  pieces separately, for the caller to escape and highlight. */
export function snippet(
  value: string,
  start: number,
  end: number,
  context = 60
): { before: string; hit: string; after: string } {
  const from = Math.max(0, start - context)
  const to = Math.min(value.length, end + context)
  return {
    before: (from > 0 ? '…' : '') + value.slice(from, start),
    hit: value.slice(start, end),
    after: value.slice(end, to) + (to < value.length ? '…' : '')
  }
}
