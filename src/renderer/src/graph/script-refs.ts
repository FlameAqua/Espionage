// Reading a Call Flow Designer script for the destinations it mentions.
//
// A route point's script decides where a call goes at runtime, so nothing in the
// configuration can say what it does. The script itself can — but only up to a
// point, and being clear about that point is the whole job here.
//
// What this does NOT do is understand the script. It does not know which branch
// runs, what the conditions are, or whether a line is even reachable. It scans
// the source for tokens that happen to be DNs the system actually has, and
// reports each one with the line it sat on. That is a good lead and a bad fact:
// a DN in a comment, in dead code, or in a branch that never fires all look
// identical from here.
//
// So every reference is carried as evidence — the DN, the line number, and the
// line's text — for the caller to present as something the reader judges, never
// as routing the system has told us about. Nothing here is inferred beyond "this
// number appears in this script".

/** One mention of a known DN in a script. */
export interface ScriptRef {
  /** The DN, exactly as it appears in the system. */
  number: string
  /** 1-based line number in the script. */
  line: number
  /** That line, trimmed and clipped — the evidence for the reference. */
  text: string
}

/** Longest line of evidence kept. Scripts contain generated lines that run to
 *  thousands of characters, and the panel only needs enough to recognise. */
const MAX_EVIDENCE = 160
/** Shortest DN considered. A one- or two-digit DN (an operator on 0, say)
 *  matches so much incidental text — array indices, years, timeouts — that the
 *  references would be noise rather than leads. */
const MIN_DN_LENGTH = 3
/** Most references reported for one script, newest lines discarded. */
const MAX_REFS = 200

/** Lines that are wholly a comment, in the languages 3CX scripts are written in.
 *  A DN in a comment is a documentation note, not a destination. */
const COMMENT_LINE = /^\s*(?:\/\/|#|--|\*|<!--)/

/**
 * Find every mention of a known DN in `script`.
 *
 * `knownDns` should hold the numbers of real nodes; anything not in it is
 * ignored, which is what keeps ordinary numbers in the source — timeouts, ports,
 * array sizes — from being read as destinations.
 *
 * A DN is only matched as a whole token, so 8000 does not match inside 18000 or
 * 80001. Comment-only lines are skipped.
 */
export function scanScriptForDns(
  script: string,
  knownDns: Iterable<string>,
  opts: { self?: string; maxRefs?: number } = {}
): ScriptRef[] {
  if (!script) return []
  // Longest first, so 8000 wins over 800 on a line carrying both and the shorter
  // match can't consume the longer one's digits.
  const dns = [...knownDns]
    .filter((d) => d && d.length >= MIN_DN_LENGTH && d !== opts.self && /^\d+$/.test(d))
    .sort((a, b) => b.length - a.length)
  if (!dns.length) return []

  const max = opts.maxRefs ?? MAX_REFS
  const out: ScriptRef[] = []
  const seen = new Set<string>()
  const lines = script.split(/\r?\n/)

  for (let i = 0; i < lines.length && out.length < max; i++) {
    const raw = lines[i]
    if (!raw.trim() || COMMENT_LINE.test(raw)) continue
    for (const dn of dns) {
      // Whole-token match: the DN must not be flanked by other digits.
      const at = indexOfToken(raw, dn)
      if (at < 0) continue
      // One reference per DN per line — a loop writing the same number twice on
      // one line is still one mention as far as a reader is concerned.
      const key = `${dn}@${i}`
      if (seen.has(key)) continue
      seen.add(key)
      const text = raw.trim()
      out.push({
        number: dn,
        line: i + 1,
        text: text.length > MAX_EVIDENCE ? `${text.slice(0, MAX_EVIDENCE)}…` : text
      })
      if (out.length >= max) break
    }
  }
  return out
}

/** First index of `dn` in `line` that isn't flanked by another digit, or -1. */
function indexOfToken(line: string, dn: string): number {
  let from = 0
  for (;;) {
    const i = line.indexOf(dn, from)
    if (i < 0) return -1
    const before = i > 0 ? line[i - 1] : ''
    const after = line[i + dn.length] ?? ''
    if (!/\d/.test(before) && !/\d/.test(after)) return i
    from = i + 1
  }
}

/** A destination a Call Flow Designer transfer component actually sends to. */
export interface ScriptTransfer {
  /** The DN transferred to. */
  number: string
  /** The component's variable name, e.g. `TransferTo8023MainIVRDay`. */
  component: string
  /** That name made readable, e.g. `Main IVR Day` — the CFD author's own words
   *  for this branch, which is better than anything we could infer. */
  label: string
  /** 1-based line of the line that set the destination. */
  line: number
}

/**
 * A CFD transfer's destination, which is a real routing statement rather than a
 * number that merely appears.
 *
 * Call Flow Designer generates one component per transfer and then assigns its
 * destination, always in this shape:
 *
 *     TransferComponent TransferTo8023MainIVRDay = new TransferComponent(…);
 *     TransferTo8023MainIVRDay.DestinationHandler = () => { return Convert.ToString(8023); };
 *
 * So the destination is the literal in the handler, and the component's own name
 * says what the branch is for. Still not proof the branch runs — the conditions
 * around it are ordinary C# — but it is a statement of intent, not a
 * coincidence, and it is labelled as the author labelled it.
 */
export function parseCfdTransfers(script: string): ScriptTransfer[] {
  if (!script) return []
  const out: ScriptTransfer[] = []
  const seen = new Set<string>()
  const lines = script.split(/\r?\n/)
  // `X.DestinationHandler = () => { return Convert.ToString(8023); };` and the
  // plainer `return "8023";` form.
  const re =
    /(\w+)\s*\.\s*DestinationHandler\s*=\s*\(\s*\)\s*=>\s*\{\s*return\s+(?:Convert\s*\.\s*ToString\s*\(\s*)?"?(\d{2,})"?/
  for (let i = 0; i < lines.length; i++) {
    if (COMMENT_LINE.test(lines[i])) continue
    const m = re.exec(lines[i])
    if (!m) continue
    const [, component, number] = m
    const key = `${component}|${number}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ number, component, label: readableComponent(component, number), line: i + 1 })
  }
  return out
}

/** `TransferTo8023MainIVRDay` → `Main IVR Day`. The generated name is the verb,
 *  the DN, then whatever the author typed; only the last part is worth showing. */
function readableComponent(component: string, number: string): string {
  const stripped = component
    .replace(/^(?:transfer|dial|call|route|make ?call)(?:to)?/i, '')
    .replace(number, '')
    .trim()
  if (!stripped) return ''
  // Split camel case, keeping runs of capitals together (IVR, DID, SIP).
  return stripped
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Collapse references to one entry per DN, keeping the first line each was seen
 *  on and how many times it appeared — which is what a link between two nodes
 *  wants, rather than one link per line. */
export function groupRefs(refs: ScriptRef[]): Array<{ number: string; refs: ScriptRef[] }> {
  const by = new Map<string, ScriptRef[]>()
  for (const r of refs) {
    const list = by.get(r.number)
    if (list) list.push(r)
    else by.set(r.number, [r])
  }
  return [...by.entries()].map(([number, list]) => ({ number, refs: list }))
}
