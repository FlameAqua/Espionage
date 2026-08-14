import { describe, it, expect } from 'vitest'

// report.ts reaches localStorage through the zone lookup; the Node test env has
// none, so stand one in before importing (same approach as zones.test.ts).
class MemStore {
  private m = new Map<string, string>()
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v)
  }
  removeItem(k: string): void {
    this.m.delete(k)
  }
  clear(): void {
    this.m.clear()
  }
}
;(globalThis as unknown as { localStorage: MemStore }).localStorage = new MemStore()

const { applyFilters, collapseToCalls, groupCounts, perExtension, queueRollup, totals, visibleColumns } =
  await import('../src/renderer/src/ui/report')
type ViewState = Parameters<typeof applyFilters>[1]
type ClassifiedCall = import('../src/renderer/src/ui/report').ClassifiedCall
import { contextForReport, type DnKind, type ReportContext } from '../src/renderer/src/ui/report-context'

const leg = (o: Partial<ClassifiedCall>): ClassifiedCall => ({
  direction: 'inbound',
  scope: 'national',
  country: 'Ireland',
  answered: true,
  durationSec: 0,
  ...o
})

// 9761 is a queue, 10000 a trunk's pseudo-DN, everything else a person.
const KINDS: Record<string, DnKind> = {
  '9761': 'queue',
  '9836': 'ringGroup',
  '10000': 'trunk',
  '10001': 'trunk',
  '10003': 'trunk'
}
const ctx: ReportContext = {
  nameFor: (dn) => ({ '2069': 'Carolan, Holly', '9761': 'Civils Bally Sales Q' })[dn],
  deptFor: () => undefined,
  deptsFor: () => [],
  // Mirrors the real lookup: DNs the topology doesn't know come back undefined.
  // A short all-digit number is an extension; anything longer isn't on the system.
  kindFor: (dn) => KINDS[dn] ?? (/^\d{1,5}$/.test(dn) ? 'user' : undefined),
  targets: []
}

/** The two legs 3CX writes for a queued call that an agent answered — stamped
 *  with the SAME timestamp, which is what used to make attribution a coin toss. */
const queuedCall = (): ClassifiedCall[] => [
  leg({ callId: 'c1', ts: '2026-07-02T09:00:00Z', srcDn: '10000', dstDn: '9761', extension: '9761', dnKind: 'queue', durationSec: 4 }),
  leg({ callId: 'c1', ts: '2026-07-02T09:00:00Z', srcDn: '9761', dstDn: '2069', extension: '2069', dnKind: 'user', durationSec: 21 })
]

describe('collapseToCalls — which leg represents the call', () => {
  it('credits the agent who answered, not the queue it passed through', () => {
    const [call] = collapseToCalls(queuedCall())
    expect(call.extension).toBe('2069')
    // The queue leg's 4 seconds of hold music is not the talk time.
    expect(call.durationSec).toBe(21)
  })

  it('gives the same answer whichever order 3CX returned the legs in', () => {
    const forwards = collapseToCalls(queuedCall())
    const backwards = collapseToCalls([...queuedCall()].reverse())
    expect(backwards[0].extension).toBe(forwards[0].extension)
    expect(backwards[0].durationSec).toBe(forwards[0].durationSec)
  })

  it('falls back to the queue when no extension answered', () => {
    const abandoned = queuedCall().map((l) => ({ ...l, answered: false }))
    const [call] = collapseToCalls(abandoned)
    expect(call.answered).toBe(false)
    // An unanswered person-leg still outranks the queue: the call rang there.
    expect(call.extension).toBe('2069')
  })

  it('still counts the call as answered if any leg was', () => {
    const legs = [
      leg({ callId: 'c2', ts: '2026-07-02T09:00:00Z', extension: '2090', answered: false, dnKind: 'user' }),
      leg({ callId: 'c2', ts: '2026-07-02T09:00:30Z', extension: '2093', answered: true, dnKind: 'user' })
    ]
    expect(collapseToCalls(legs)[0].answered).toBe(true)
  })
})

describe('perExtension', () => {
  it('lists the agent and leaves the queue out of per-extension activity', () => {
    const rows = perExtension(queuedCall(), [], '', ctx)
    expect(rows.map((r) => r.extension)).toEqual(['2069'])
    expect(rows[0].in.answered).toBe(1)
  })

  it('drops trunk pseudo-DNs, which are not people either', () => {
    const trunkLeg = [
      leg({ callId: 't1', srcDn: '10000', dstDn: '10000', extension: '10000', dnKind: 'trunk', direction: 'outbound' })
    ]
    expect(perExtension(trunkLeg, [], '', ctx)).toHaveLength(0)
  })

  it('counts an internal call for both the caller and the person they rang', () => {
    const internal = [
      leg({
        callId: 'i1',
        srcDn: '2070',
        dstDn: '2071',
        extension: '2070',
        direction: 'internal',
        scope: 'internal',
        durationSec: 939
      })
    ]
    const rows = perExtension(internal, [], '', ctx)
    const caller = rows.find((r) => r.extension === '2070')!
    const callee = rows.find((r) => r.extension === '2071')!
    expect(caller.intOut).toEqual({ calls: 1, answered: 1, missed: 0 })
    expect(callee.intIn).toEqual({ calls: 1, answered: 1, missed: 0 })
    // The combined column is the two halves added up.
    expect(caller.int.calls).toBe(1)
    // The old table showed an internal-only extension as a row of zeros.
    expect(caller.calls).toBe(1)
  })

  it('ignores a misdial that 3CX labelled internal', () => {
    // From 2069's log: a dial that never reaches a trunk is logged as internal
    // whatever was dialled, so these arrive looking like calls to a colleague.
    // Counting them added four phantom missed calls to that extension alone.
    const misdials = [
      leg({ callId: 'm1', srcDn: '2069', dstDn: '10960997', direction: 'internal', scope: 'internal', answered: false }),
      leg({ callId: 'm2', srcDn: '2069', dstDn: '+353872337329', direction: 'internal', scope: 'internal', answered: false })
    ]
    expect(perExtension(misdials, [], '', ctx)).toHaveLength(0)
  })

  it('ignores a half-dialled number that merely looks like an extension', () => {
    // "20", "01", "101", "01404" all pass the 2-6 digit shape test, so with a
    // directory to check against they were each earning a row of their own.
    // A faithful directory: it knows 2069 and nothing else.
    const withDirectory: ReportContext = {
      ...ctx,
      kindFor: (dn) => (dn === '2069' ? 'user' : undefined),
      targets: [{ number: '2069', label: 'Carolan, Holly', kind: 'user' }]
    }
    const halfDialled = ['20', '01', '101', '01404'].map((dn, i) =>
      leg({
        callId: `h${i}`,
        srcDn: '2069',
        dstDn: dn,
        direction: 'internal',
        scope: 'internal',
        answered: false
      })
    )
    expect(perExtension(halfDialled, [], '', withDirectory)).toHaveLength(0)
  })

  it('keeps an unknown DN that actually answers — park, paging and the like', () => {
    // 6666 answered 87 internal calls with 23 minutes of talk. It is missing
    // from the topology but plainly real, so "not in the directory" alone must
    // not discard it.
    const withDirectory: ReportContext = {
      ...ctx,
      kindFor: (dn) => (dn === '2069' ? 'user' : undefined),
      targets: [{ number: '2069', label: 'Carolan, Holly', kind: 'user' }]
    }
    const real = [
      leg({
        callId: 's1',
        srcDn: '2069',
        dstDn: '6666',
        direction: 'internal',
        scope: 'internal',
        answered: true,
        durationSec: 16
      })
    ]
    const rows = perExtension(real, [], '', withDirectory)
    expect(rows.find((r) => r.extension === '6666')?.intIn.answered).toBe(1)
  })

  it('still counts an internal call to a real extension', () => {
    const real = [
      leg({ callId: 'i2', srcDn: '2069', dstDn: '2091', direction: 'internal', scope: 'internal', answered: false })
    ]
    const rows = perExtension(real, [], '', ctx)
    expect(rows.find((r) => r.extension === '2069')!.intOut.missed).toBe(1)
  })

  it('separates inbound misses from outbound misses', () => {
    const legs = [
      leg({ callId: 'a', srcDn: '10000', dstDn: '2090', direction: 'inbound', answered: false }),
      leg({ callId: 'b', srcDn: '2090', dstDn: '10000', direction: 'outbound', answered: false }),
      leg({ callId: 'c', srcDn: '10000', dstDn: '2090', direction: 'inbound', answered: true })
    ]
    const [row] = perExtension(legs, [], '', ctx)
    expect(row.in).toEqual({ calls: 2, answered: 1, missed: 1 })
    expect(row.out).toEqual({ calls: 1, answered: 0, missed: 1 })
    expect(row.calls).toBe(3)
  })

  // The three counting rules below were derived by matching 3CX's Extension
  // Statistics figure for figure across a full department; see perExtension.
  it('counts a call that rang out into voicemail as one missed call', () => {
    // Taken from 2090's real log: both segments share a call id. The ring is
    // what the person missed; the 22s that follows is the message. 3CX counts
    // this as one Unanswered inbound call for the extension.
    const legs = [
      leg({
        callId: 'vm',
        srcDn: '10000',
        dstDn: '2090',
        direction: 'inbound',
        answered: false,
        toVoicemail: true,
        durationSec: 0
      }),
      leg({
        callId: 'vm',
        srcDn: '10000',
        dstDn: '2090',
        direction: 'inbound',
        answered: true,
        toVoicemail: true,
        durationSec: 22
      })
    ]
    const [row] = perExtension(legs, [], '', ctx)
    expect(row.in).toEqual({ calls: 1, answered: 0, missed: 1 })
    // Dropping both segments lost the call from the extension's figures entirely.
    expect(row.calls).toBe(1)
  })

  it('treats an inbound call with any unanswered ring as missed', () => {
    // Inbound and outbound judge this oppositely, deliberately. A ring followed
    // by an answer is voicemail taking a message — the log cannot be told apart
    // from the person picking up late, and 3CX counts it Unanswered.
    const legs = [
      leg({ callId: 'r1', srcDn: '10000', dstDn: '2090', direction: 'inbound', answered: false }),
      leg({ callId: 'r1', srcDn: '10000', dstDn: '2090', direction: 'inbound', answered: true, durationSec: 30 })
    ]
    const [row] = perExtension(legs, [], '', ctx)
    expect(row.in).toEqual({ calls: 1, answered: 0, missed: 1 })
    // The talk time is still real and still counted.
    expect(row.talkSec).toBe(30)
  })

  it('folds repeated rings of one call into a single missed call', () => {
    const legs = [
      leg({ callId: 'c6', srcDn: '10000', dstDn: '0000', direction: 'inbound', answered: false }),
      leg({ callId: 'c6', srcDn: '10000', dstDn: '0000', direction: 'inbound', answered: false })
    ]
    const [row] = perExtension(legs, [], '', ctx)
    expect(row.in).toEqual({ calls: 1, answered: 0, missed: 1 })
  })

  it('keeps two separate calls from the same caller apart', () => {
    // Taken from 1005's log: 0861944199 rang twice within two minutes, on two
    // call ids. That is two calls, not one.
    const legs = [
      leg({ callId: 'a1', srcDn: '10000', dstDn: '1005', direction: 'inbound', durationSec: 65 }),
      leg({ callId: 'a2', srcDn: '10000', dstDn: '1005', direction: 'inbound', durationSec: 205 })
    ]
    const [row] = perExtension(legs, [], '', ctx)
    expect(row.in).toEqual({ calls: 2, answered: 2, missed: 0 })
  })

  it('counts a genuinely answered call even when the log mentions voicemail', () => {
    // 2069 had three of these: answered, real talk time, and flagged only
    // because the reason text names a voicemail box further down the call.
    // Excluding them cost three answered calls.
    const legs = [
      leg({
        callId: 'vm2',
        srcDn: '10000',
        dstDn: '2069',
        direction: 'inbound',
        answered: true,
        toVoicemail: true,
        durationSec: 37
      })
    ]
    const [row] = perExtension(legs, [], '', ctx)
    expect(row.in).toEqual({ calls: 1, answered: 1, missed: 0 })
    expect(row.talkSec).toBe(37)
  })

  it('counts a retried outbound call once, not once per attempt', () => {
    // Straight from 2069's log: call ...36a5 was attempted down three trunks in
    // three seconds, all unanswered. That is one call they made.
    const legs = [
      leg({ callId: 'o2', srcDn: '2069', dstDn: '10003', direction: 'outbound', answered: false }),
      leg({ callId: 'o2', srcDn: '2069', dstDn: '10000', direction: 'outbound', answered: false }),
      leg({ callId: 'o2', srcDn: '2069', dstDn: '10001', direction: 'outbound', answered: false })
    ]
    const [row] = perExtension(legs, [], '', ctx)
    expect(row.out).toEqual({ calls: 1, answered: 0, missed: 1 })
  })

  it('counts an outbound call answered on a later attempt as answered', () => {
    // The opposite of the inbound rule: getting through on the second trunk is
    // a call that was answered.
    const legs = [
      leg({ callId: 'o3', srcDn: '2069', dstDn: '10000', direction: 'outbound', answered: false }),
      leg({ callId: 'o3', srcDn: '2069', dstDn: '10000', direction: 'outbound', answered: true })
    ]
    const [row] = perExtension(legs, [], '', ctx)
    expect(row.out).toEqual({ calls: 1, answered: 1, missed: 0 })
  })

  it('counts a call answered elsewhere as missed here', () => {
    const legs = [
      leg({ callId: 'c7', srcDn: '10000', dstDn: '2090', direction: 'inbound', answered: false }),
      leg({ callId: 'c7', srcDn: '10000', dstDn: '2093', direction: 'inbound', answered: true })
    ]
    const rows = perExtension(legs, [], '', ctx)
    expect(rows.find((r) => r.extension === '2090')!.in).toEqual({ calls: 1, answered: 0, missed: 1 })
    expect(rows.find((r) => r.extension === '2093')!.in).toEqual({ calls: 1, answered: 1, missed: 0 })
  })

  it('leaves out extensions outside the department being filtered to', () => {
    const withDepts: ReportContext = {
      ...ctx,
      deptsFor: (dn) => (dn === '2093' ? ['Civils'] : ['Other'])
    }
    const legs = [leg({ callId: 'c8', srcDn: '10000', dstDn: '2091', direction: 'inbound' })]
    expect(perExtension(legs, [], '', withDepts, 'Civils')).toHaveLength(0)
    expect(perExtension(legs, [], '', withDepts, 'all')).toHaveLength(1)
  })

  it('includes an extension under every department it belongs to', () => {
    const shared: ReportContext = { ...ctx, deptsFor: () => ['Civils', 'Sales'] }
    const legs = [leg({ callId: 'c9', srcDn: '10000', dstDn: '2069', direction: 'inbound' })]
    expect(perExtension(legs, [], '', shared, 'Civils')).toHaveLength(1)
    expect(perExtension(legs, [], '', shared, 'Sales')).toHaveLength(1)
  })

  it('keeps every row internally consistent', () => {
    const legs = [
      ...queuedCall(),
      leg({ callId: 'o1', srcDn: '2069', dstDn: '10000', direction: 'outbound', answered: true })
    ]
    for (const row of perExtension(legs, [], '', ctx)) {
      expect(row.in.answered + row.in.missed).toBe(row.in.calls)
      expect(row.out.answered + row.out.missed).toBe(row.out.calls)
      expect(row.int.answered + row.int.missed).toBe(row.int.calls)
      expect(row.in.calls + row.out.calls + row.int.calls).toBe(row.calls)
    }
  })
})

// The fixes below started life in the per-extension table; these guard that the
// rest of the report applies them too, rather than quietly disagreeing with it.
describe('report-wide consistency', () => {
  const state = {
    home: 'IE',
    detail: 'call',
    direction: 'all',
    scope: 'all',
    country: 'all',
    department: 'all',
    status: 'all',
    search: ''
  } as ViewState

  const misdial = leg({
    callId: 'm1',
    srcDn: '2069',
    dstDn: '10960997',
    extension: '2069',
    direction: 'internal',
    scope: 'internal',
    answered: false,
    misdial: true
  })
  const queueCall = leg({
    callId: 'q1',
    srcDn: '10000',
    dstDn: '9761',
    extension: '9761',
    dnKind: 'queue',
    direction: 'inbound'
  })
  const personCall = leg({
    callId: 'p1',
    srcDn: '10000',
    dstDn: '2069',
    extension: '2069',
    dnKind: 'user',
    direction: 'inbound'
  })

  it('drops misdials everywhere, not just from per-extension activity', () => {
    expect(applyFilters([misdial, personCall], state)).toEqual([personCall])
  })

  it('still shows them in the drill-down, which has to explain the figures', () => {
    expect(applyFilters([misdial, personCall], state, { keepMisdials: true })).toHaveLength(2)
  })

  it('counts only people as active extensions', () => {
    // The queue and the trunk were being counted as staff.
    const trunkCall = leg({ callId: 't1', extension: '10000', dnKind: 'trunk', direction: 'outbound' })
    expect(totals([personCall, queueCall, trunkCall]).activeExts).toBe(1)
  })

  it('leaves queues and trunks out of the breakdown-by-extension chart', () => {
    const bars = groupCounts([personCall, queueCall], 'extension', () => undefined)
    expect(bars.map((b) => b.key)).toEqual(['2069'])
  })

  it('rolls a department up by membership, matching the department filter', () => {
    // 2069 serves two departments, so both see the call — exactly as filtering
    // to either of them would show it.
    const shared = { ...personCall, depts: ['Civils', 'Sales'] }
    const bars = groupCounts([shared], 'department', () => undefined)
    expect(bars.map((b) => b.key).sort()).toEqual(['Civils', 'Sales'])
  })
})

describe('visibleColumns', () => {
  // Every direction must show an answered/missed breakdown; a direction that
  // switched all its groups off left a table of nothing but call totals.
  const directions = ['all', 'external', 'inbound', 'outbound', 'internal'] as const

  it('always shows at least one answered/missed group', () => {
    for (const d of directions) {
      const show = visibleColumns(d)
      expect(show.in || show.out || show.int, `direction ${d}`).toBe(true)
    }
  })

  it('shows internal as its received and placed halves', () => {
    const show = visibleColumns('internal')
    expect(show.in).toBe(true)
    expect(show.out).toBe(true)
    // Merged internal would just repeat those two, and national/international
    // says nothing about a call that never left the system.
    expect(show.int).toBe(false)
    expect(show.scope).toBe(false)
  })

  it('drops the group a one-way direction cannot fill', () => {
    expect(visibleColumns('inbound').out).toBe(false)
    expect(visibleColumns('outbound').in).toBe(false)
    expect(visibleColumns('external').int).toBe(false)
  })
})

describe('contextForReport', () => {
  const live: ReportContext = {
    nameFor: (dn) => (dn === '2069' ? 'Someone Else Entirely' : undefined),
    deptFor: (dn) => (dn === '2069' ? 'Wrong Department' : undefined),
    deptsFor: () => [],
    kindFor: () => 'user',
    targets: []
  }
  const report = {
    kind: 'call-report',
    generatedAt: '',
    baseUrl: 'https://other-pbx',
    live: false,
    entries: [],
    perExtension: [],
    directory: [{ dn: '2069', name: 'Carolan, Holly', department: 'Civils', kind: 'user' as const }]
  } as Parameters<typeof contextForReport>[0]

  it("uses the report's own snapshot, not the system that happens to be open", () => {
    const scoped = contextForReport(report, live)
    expect(scoped.nameFor('2069')).toBe('Carolan, Holly')
    expect(scoped.deptFor('2069')).toBe('Civils')
  })

  it('falls back to the connected system for a DN the report never recorded', () => {
    const scoped = contextForReport(report, {
      ...live,
      nameFor: (dn) => (dn === '1005' ? 'Healy, Liam' : undefined)
    })
    expect(scoped.nameFor('1005')).toBe('Healy, Liam')
  })

  it('leaves reports written before directories existed on the live system', () => {
    const old = { ...report, directory: undefined }
    expect(contextForReport(old, live).nameFor('2069')).toBe('Someone Else Entirely')
  })
})

describe('queueRollup', () => {
  it('reports the queue by what passed through it, counting each call once', () => {
    const legs = [
      ...queuedCall(),
      // Re-queued after an overflow — the same call arriving twice.
      leg({ callId: 'c1', ts: '2026-07-02T09:00:10Z', extension: '9761', dnKind: 'queue', durationSec: 3 })
    ]
    const [row] = queueRollup(legs)
    expect(row.dn).toBe('9761')
    expect(row.calls).toBe(1)
    expect(row.answered).toBe(1)
    expect(row.abandoned).toBe(0)
  })

  it('counts a call nobody answered as abandoned', () => {
    const legs = queuedCall().map((l) => ({ ...l, answered: false }))
    const [row] = queueRollup(legs)
    expect(row.abandoned).toBe(1)
    expect(row.answered).toBe(0)
  })

  it('leaves trunks out — they are not somewhere a call waits', () => {
    const legs = [leg({ callId: 'x', extension: '10000', dnKind: 'trunk' })]
    expect(queueRollup(legs)).toHaveLength(0)
  })
})
