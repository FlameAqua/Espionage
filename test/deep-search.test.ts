import { describe, it, expect } from 'vitest'
import {
  buildDeepIndex,
  countFields,
  flattenRecord,
  parseFieldQuery,
  searchDeep,
  snippet
} from '../src/renderer/src/graph/deep-search'
import type { Topology, EntitySet } from '../src/shared/types'

const empty = (): EntitySet => ({ path: '', value: [] })

const topo: Topology = {
  fetchedAt: '',
  baseUrl: 'https://pbx.example.com',
  users: {
    path: '/xapi/v1/Users',
    value: [
      {
        Id: '1',
        Number: '2001',
        FirstName: 'Alice',
        LastName: 'Byrne',
        EmailAddress: 'alice@canices.ie',
        MobileNumber: '353871234567',
        AuthPassword: '[redacted]',
        Groups: [{ Name: 'Sales', Rights: { RoleName: 'managers' } }],
        // 3CX stores a few settings as a serialized blob; a term inside one
        // should still be findable.
        Blob: '{"provisionUrl":"https://old-provider.example.com/cfg"}'
      },
      { Id: '2', Number: '2002', FirstName: 'Bo', LastName: 'Nolan', EmailAddress: '' }
    ]
  },
  queues: {
    path: '/xapi/v1/Queues',
    value: [{ Id: '10', Number: '8000', Name: 'Sales', PollingStrategy: 'Hunt' }]
  },
  ringGroups: empty(),
  receptionists: empty(),
  inboundRules: empty(),
  outboundRules: {
    path: '/xapi/v1/OutboundRules',
    // Never becomes a graph node, which is exactly why a deep search has to
    // reach it.
    value: [{ Id: '77', Name: 'Mobiles via old-provider', Prefix: '08' }]
  },
  didNumbers: empty(),
  trunks: {
    path: '/xapi/v1/Trunks',
    value: [{ Id: '20', Name: 'Generic SIP Trunk', Host: 'sip.old-provider.example.com' }]
  },
  groups: empty()
}

describe('flattenRecord', () => {
  it('flattens nested objects and arrays to addressable leaves', () => {
    const fields = flattenRecord({
      Name: 'Sales',
      Nested: { A: 1, B: { C: true } },
      List: ['x', 'y']
    })
    const byPath = new Map(fields.map((f) => [f.path, f.value]))
    expect(byPath.get('Name')).toBe('Sales')
    expect(byPath.get('Nested.A')).toBe('1')
    expect(byPath.get('Nested.B.C')).toBe('true')
    expect(byPath.get('List[0]')).toBe('x')
    expect(byPath.get('List[1]')).toBe('y')
  })

  it('skips nulls and empty strings, which can never match', () => {
    const paths = flattenRecord({ A: null, B: undefined, C: '', D: 'kept' }).map((f) => f.path)
    expect(paths).toEqual(['D'])
  })

  it('does not recurse forever on a deeply nested record', () => {
    let deep: Record<string, unknown> = { leaf: 'bottom' }
    for (let i = 0; i < 200; i++) deep = { down: deep }
    expect(() => flattenRecord(deep)).not.toThrow()
  })
})

describe('buildDeepIndex', () => {
  const records = buildDeepIndex(topo)

  it('indexes every record of every collection', () => {
    expect(records).toHaveLength(5)
    expect(records.filter((r) => r.collection === 'users')).toHaveLength(2)
    expect(records.some((r) => r.collection === 'outboundRules')).toBe(true)
  })

  it('names each record from whatever the collection calls it', () => {
    const alice = records.find((r) => r.collection === 'users' && r.raw.Id === '1')!
    expect(alice.title).toBe('Alice Byrne')
    expect(alice.subtitle).toBe('2001')
    const trunk = records.find((r) => r.collection === 'trunks')!
    expect(trunk.title).toBe('Generic SIP Trunk')
  })

  it('keeps the source path so a hit can say where it came from', () => {
    expect(records.find((r) => r.collection === 'queues')!.source).toBe('/xapi/v1/Queues')
  })

  it('is cached per topology object', () => {
    expect(buildDeepIndex(topo)).toBe(records)
  })

  it('counts the leaves it can search', () => {
    expect(countFields(records)).toBe(records.reduce((n, r) => n + r.fields.length, 0))
    expect(countFields(records)).toBeGreaterThan(15)
  })
})

describe('searchDeep', () => {
  const records = buildDeepIndex(topo)

  it('finds a term in a field the graph never reads', () => {
    const { hits } = searchDeep(records, 'Hunt')
    expect(hits).toHaveLength(1)
    expect(hits[0].record.title).toBe('Sales')
    expect(hits[0].matches[0].path).toBe('PollingStrategy')
  })

  it('finds a term inside a nested object', () => {
    const { hits } = searchDeep(records, 'managers')
    expect(hits[0].matches[0].path).toBe('Groups[0].Rights.RoleName')
  })

  it('finds a term buried in a serialized blob', () => {
    const { hits } = searchDeep(records, 'provisionUrl')
    expect(hits).toHaveLength(1)
    expect(hits[0].matches[0].path).toBe('Blob')
  })

  it('reaches records that never become graph nodes', () => {
    const { hits } = searchDeep(records, 'old-provider')
    const collections = hits.map((h) => h.record.collection).sort()
    expect(collections).toEqual(['outboundRules', 'trunks', 'users'])
  })

  it('ranks a match on the record’s own name above one buried in a field', () => {
    const { hits } = searchDeep(records, 'Sales')
    // The queue is named Sales; Alice merely belongs to a group called Sales.
    expect(hits[0].record.collection).toBe('queues')
  })

  it('is case-insensitive', () => {
    expect(searchDeep(records, 'ALICE').hits).toHaveLength(1)
    expect(searchDeep(records, 'alice').hits).toHaveLength(1)
  })

  it('reports every matching field of a record, not just the first', () => {
    const { hits } = searchDeep(records, 'alice')
    expect(hits[0].matches.map((m) => m.path).sort()).toEqual(['EmailAddress', 'FirstName'])
  })

  it('returns nothing for an empty term', () => {
    expect(searchDeep(records, '   ').hits).toHaveLength(0)
  })

  it('ignores field names unless asked to match them', () => {
    // 'MobileNumber' is the name of a field, never the contents of one.
    const off = searchDeep(records, 'MobileNumber')
    expect(off.hits).toHaveLength(0)
    const on = searchDeep(records, 'MobileNumber', { fieldNames: true })
    expect(on.hits).toHaveLength(1)
    expect(on.hits[0].matches[0].inPath).toBe(true)
  })

  it('supports a regular expression', () => {
    const { hits } = searchDeep(records, '^3538\\d+$', { regex: true })
    expect(hits).toHaveLength(1)
    expect(hits[0].matches[0].path).toBe('MobileNumber')
  })

  it('reports a bad regular expression rather than throwing', () => {
    const res = searchDeep(records, '([', { regex: true })
    expect(res.error).toMatch(/Invalid regular expression/)
    expect(res.hits).toHaveLength(0)
  })

  it('caps the hits it returns but still counts them all', () => {
    const res = searchDeep(records, 'a', { limit: 1 })
    expect(res.hits).toHaveLength(1)
    expect(res.total).toBeGreaterThan(1)
  })

  it('caps the matches reported per record', () => {
    const res = searchDeep(records, 'a', { perRecord: 1 })
    for (const h of res.hits) expect(h.matches.length).toBeLessThanOrEqual(1)
  })

  it('cannot surface a credential, because none reach the index', () => {
    const { hits } = searchDeep(records, 'redacted')
    expect(hits[0].matches[0].path).toBe('AuthPassword')
    expect(hits[0].matches[0].value).toBe('[redacted]')
  })
})

describe('parseFieldQuery', () => {
  // What knownFieldNames builds: full paths, index-stripped paths, and last
  // segments alone.
  const known = new Set(['number', 'name', 'groups[0].name', 'groups.name', 'host'])

  it('reads the JSON as it appears in the record', () => {
    expect(parseFieldQuery('"Number": "8006"', known)).toEqual({
      key: 'Number',
      value: '8006',
      exact: true
    })
  })

  it('accepts the same thing without the ceremony', () => {
    expect(parseFieldQuery('Number: 800', known)).toEqual({
      key: 'Number',
      value: '800',
      exact: false
    })
    expect(parseFieldQuery('Number = 800', known)).toEqual({
      key: 'Number',
      value: '800',
      exact: false
    })
  })

  it('takes a nested path', () => {
    expect(parseFieldQuery('Groups[0].Name: Sales', known)?.key).toBe('Groups[0].Name')
  })

  it('drops the trailing comma left by pasting a line of JSON', () => {
    expect(parseFieldQuery('"Number": "8006",', known)).toEqual({
      key: 'Number',
      value: '8006',
      exact: true
    })
  })

  it('reads an empty value as "the field is set to anything"', () => {
    expect(parseFieldQuery('Number:', known)).toEqual({ key: 'Number', value: '', exact: false })
  })

  it('leaves free text that merely looks like a query alone', () => {
    // `https` has the shape of a field name but is not one, so this stays a
    // plain search for a URL rather than becoming a query for nothing.
    expect(parseFieldQuery('https://pbx.example.com', known)).toBeNull()
    expect(parseFieldQuery('sip:2001@pbx', known)).toBeNull()
    expect(parseFieldQuery('just some words', known)).toBeNull()
  })

  it('believes a quoted key even when the system has no such field', () => {
    // Quoting is an unambiguous statement of intent; a query for a field that
    // does not exist should say so with no results, not silently search text.
    expect(parseFieldQuery('"NoSuchField": "x"', known)).toEqual({
      key: 'NoSuchField',
      value: 'x',
      exact: true
    })
  })
})

describe('searchDeep with a field query', () => {
  const records = buildDeepIndex(topo)

  it('matches the named field exactly when the value is quoted', () => {
    const res = searchDeep(records, '"Number": "8000"')
    expect(res.query).toEqual({ key: 'Number', value: '8000', exact: true })
    expect(res.hits).toHaveLength(1)
    expect(res.hits[0].record.title).toBe('Sales')
    expect(res.hits[0].matches[0].path).toBe('Number')
  })

  it('will not part-match a quoted value', () => {
    // 2001 and 8000 both contain a 0; only an exact value counts here.
    expect(searchDeep(records, '"Number": "800"').hits).toHaveLength(0)
  })

  it('part-matches an unquoted value', () => {
    const res = searchDeep(records, 'Number: 200')
    expect(res.query?.exact).toBe(false)
    expect(res.hits.map((h) => h.record.title).sort()).toEqual(['Alice Byrne', 'Bo Nolan'])
  })

  it('searches the named field, not the rest of the record', () => {
    // 'Hunt' is the queue's PollingStrategy, so asking after its Name finds
    // nothing — a field query does not fall back to searching everything.
    expect(searchDeep(records, 'Name: Hunt').hits).toHaveLength(0)
  })

  it('matches a bare field name at any depth, own field first', () => {
    // Both the queue and Alice's group have a field called Name holding 'Sales'.
    // Both are real answers, so both are returned — with the record whose OWN
    // Name it is at the top, and each hit saying which field it was.
    const res = searchDeep(records, 'Name: Sales')
    expect(res.hits).toHaveLength(2)
    expect(res.hits[0].record.collection).toBe('queues')
    expect(res.hits[0].matches[0].path).toBe('Name')
    expect(res.hits[1].matches[0].path).toBe('Groups[0].Name')
  })

  it('confines a query to one field when the full path is given', () => {
    const res = searchDeep(records, 'Groups[0].Name: Sales')
    expect(res.hits).toHaveLength(1)
    expect(res.hits[0].record.collection).toBe('users')
  })

  it('reaches a nested field by path, by stripped path, or by last segment', () => {
    for (const q of ['Groups[0].Name: Sales', 'Groups.Name: Sales', 'RoleName: managers']) {
      const res = searchDeep(records, q)
      expect(res.hits, q).toHaveLength(1)
      expect(res.hits[0].record.collection, q).toBe('users')
    }
  })

  it('finds every record that has the field set at all', () => {
    const res = searchDeep(records, 'EmailAddress:')
    // Bo's is an empty string, which never enters the index — so only Alice.
    expect(res.hits).toHaveLength(1)
    expect(res.hits[0].record.title).toBe('Alice Byrne')
  })

  it('returns nothing for a field the system does not have', () => {
    const res = searchDeep(records, '"NoSuchField": "x"')
    expect(res.query).toBeTruthy()
    expect(res.hits).toHaveLength(0)
  })

  it('is case-insensitive in both the field name and the value', () => {
    expect(searchDeep(records, 'number: "8000"').hits).toHaveLength(1)
    expect(searchDeep(records, '"NAME": "sales"').hits).toHaveLength(2)
    expect(searchDeep(records, '"Name": "SALES"').hits).toHaveLength(2)
  })

  it('leaves the term alone when regex is on, so query-shaped text is findable', () => {
    const res = searchDeep(records, 'Number: 800', { regex: true })
    expect(res.query).toBeUndefined()
    expect(res.hits).toHaveLength(0) // no field literally contains "Number: 800"
  })
})

describe('snippet', () => {
  it('returns the match with its surroundings', () => {
    const s = snippet('the quick brown fox', 4, 9)
    expect(s.hit).toBe('quick')
    expect(s.before).toBe('the ')
    expect(s.after).toBe(' brown fox')
  })

  it('trims a long value down to a window around the match, marked with ellipses', () => {
    const long = `${'x'.repeat(300)}NEEDLE${'y'.repeat(300)}`
    const s = snippet(long, 300, 306, 10)
    expect(s.hit).toBe('NEEDLE')
    expect(s.before).toBe(`…${'x'.repeat(10)}`)
    expect(s.after).toBe(`${'y'.repeat(10)}…`)
  })
})
