import { describe, it, expect } from 'vitest'
import { rankSearchHits } from '../src/renderer/src/graph/search'
import type { GraphNode } from '../src/renderer/src/graph/model'

const ext = (number: string, label: string, callerId?: string): GraphNode => ({
  id: `user:${number}`,
  kind: 'user',
  label,
  number,
  raw: {},
  searchTerms: callerId ? [{ label: 'Outbound caller ID', value: callerId }] : undefined
})

// A department sharing one presented number is the ordinary case, not an edge
// case: everyone on the site dials out as the main number.
const CID = '353906628882'
const nodes: GraphNode[] = [
  ext('4301', 'Reception Cloverhill', CID),
  ext('4302', 'PIC', CID),
  ext('4303', 'Rockfield Nurses Station', CID),
  ext('4304', 'Kitchen', CID),
  ext('4305', 'Cams Cordless', CID),
  ext('4306', 'Rockfield Cordless', CID),
  ext('4307', 'Nurses Cordless', CID),
  ext('4308', 'Day Room', CID),
  { id: 'did:1', kind: 'did', label: 'Sonas Cloverhill Main Number', number: CID, raw: {} },
  ext('8800', 'Fax', undefined)
]

describe('rankSearchHits', () => {
  it('returns every extension sharing a caller ID, not just the first few', () => {
    const hits = rankSearchHits(nodes, '8882')
    const numbers = hits.filter((h) => h.node.kind === 'user').map((h) => h.node.number)
    expect(numbers).toHaveLength(8)
    expect(numbers).toContain('4308')
  })

  it('says what matched, so a hit on a number you did not type explains itself', () => {
    const hit = rankSearchHits(nodes, '8882').find((h) => h.node.number === '4302')
    expect(hit?.via).toBe(`Outbound caller ID ${CID}`)
  })

  it('searches caller IDs on a two-character term', () => {
    // The gate used to be three, which made a short fragment silently find
    // nothing but the nodes numbered that way.
    const hits = rankSearchHits(nodes, '88')
    expect(hits.some((h) => h.node.number === '4308')).toBe(true)
  })

  it('still puts nodes named or numbered that above caller-ID matches', () => {
    const hits = rankSearchHits(nodes, '88')
    const firstBroad = hits.findIndex((h) => h.via !== undefined)
    const lastDirect = hits.map((h) => h.via === undefined).lastIndexOf(true)
    // Every direct hit comes before the first "matched on something else" one.
    expect(lastDirect).toBeLessThan(firstBroad)
  })

  it('leaves a single character to names and numbers only', () => {
    // One digit matches most of a DID block; broad matching there buries
    // everything worth seeing.
    const hits = rankSearchHits(nodes, '8')
    expect(hits.every((h) => h.via === undefined)).toBe(true)
  })

  it('ranks an exact name above one that merely contains the term', () => {
    const hits = rankSearchHits(nodes, 'kitchen')
    expect(hits[0].node.label).toBe('Kitchen')
  })

  it('finds nothing for an empty term', () => {
    expect(rankSearchHits(nodes, '   ')).toHaveLength(0)
  })
})
