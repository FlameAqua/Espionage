// Ranking for the search box and the command palette. Pure — it takes nodes and
// a term and returns ordered hits — so the two callers can't drift apart and the
// ordering rules are testable without a canvas.

import { NODE_KIND_META, type GraphNode } from './model'

/** A search result, plus WHY it matched when that wasn't the node's own name or
 *  number (e.g. "DID 35318899103"), so an otherwise baffling hit explains itself. */
export interface SearchHit {
  node: GraphNode
  via?: string
}

/** Below this, only names and numbers are searched. A single digit matches most
 *  of a trunk's DID block and a single letter most category names, either of
 *  which buries the name match the user is after. Two characters is enough to
 *  mean something — at three, a short caller-ID or DID fragment was silently
 *  unsearchable. */
const BROAD_MATCH_MIN = 2

export function rankSearchHits(models: GraphNode[], term: string): SearchHit[] {
  const t = term.trim().toLowerCase()
  if (!t) return []

  const hits: Array<SearchHit & { rank: number }> = []
  const seen = new Set<string>()
  const take = (node: GraphNode, rank: number, via?: string): void => {
    if (seen.has(node.id)) return
    seen.add(node.id)
    hits.push({ node, via, rank })
  }

  for (const m of models) {
    const label = m.label.toLowerCase()
    // Exact name beats a name that merely contains the term, which beats the
    // extension number — otherwise searching "800" surfaces every DID ending in
    // 800 above the queue actually numbered 800.
    if (label === t) take(m, 0)
    else if (label.startsWith(t)) take(m, 1)
    else if (label.includes(t)) take(m, 2)
    else if (m.number === term.trim()) take(m, 3)
    else if ((m.number ?? '').includes(t)) take(m, 4)
  }

  if (t.length >= BROAD_MATCH_MIN) {
    // Emails, mobiles, outbound caller IDs, DIDs, gateway hosts…
    for (const m of models) {
      if (seen.has(m.id)) continue
      for (const s of m.searchTerms ?? []) {
        if (!s.value.toLowerCase().includes(t)) continue
        take(m, s.value.toLowerCase() === t ? 5 : 6, `${s.label} ${s.value}`)
        break
      }
    }
    // "queue", "trunk", "external" … list that whole category last.
    for (const [kind, meta] of Object.entries(NODE_KIND_META)) {
      if (!meta.label.toLowerCase().includes(t)) continue
      for (const m of models) if (m.kind === kind) take(m, 7, meta.label)
    }
  }

  return hits.sort((a, b) => a.rank - b.rank).map(({ node, via }) => ({ node, via }))
}
