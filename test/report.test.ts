import { describe, it, expect } from 'vitest'
import {
  callDirection,
  dedupeEntries,
  filterEntriesByDirection,
  filterEntriesByDn,
  normalizeCallEntry,
  odataDateTime,
  rollupByExtension,
  splitIntoWindows,
  parseDuration,
  isExtensionLike,
  guessHomeCountry,
  trimToPeriod
} from '../src/main/threecx/client'

describe('parseDuration', () => {
  it('parses plain seconds', () => expect(parseDuration('45')).toBe(45))
  it('parses HH:MM:SS', () => expect(parseDuration('1:02:03')).toBe(3723))
  it('parses MM:SS', () => expect(parseDuration('2:30')).toBe(150))
  it('treats empty as zero', () => expect(parseDuration('')).toBe(0))
  it('parses ISO-8601 durations (3CX call log)', () => {
    expect(parseDuration('PT3M43.886258S')).toBeCloseTo(223.886, 2)
    expect(parseDuration('PT14.692957S')).toBeCloseTo(14.693, 2)
    expect(parseDuration('PT1H2M3S')).toBe(3723)
    expect(parseDuration('PT0S')).toBe(0)
  })
})

describe('normalizeCallEntry — real 3CX GetCallLogData shapes', () => {
  it('attributes an inbound call to the destination extension and reads the +E.164 caller', () => {
    const e = normalizeCallEntry({
      StartTime: '2026-07-23T15:06:30.919351+01:00',
      SourceDn: '10000',
      SourceCallerId: '+353873962669',
      DestinationDn: '0202',
      DestinationCallerId: '',
      TalkingDuration: 'PT3M43.886258S',
      RingingDuration: 'PT14.692957S',
      Answered: true,
      Direction: 'Inbound',
      CallType: 'Extension',
      Status: 'Answered'
    })
    expect(e.directionNorm).toBe('inbound')
    expect(e.extension).toBe('0202')
    expect(e.external).toBe('+353873962669')
    expect(e.intlCode).toBe('353')
    expect(e.country).toBe('Ireland')
    expect(e.durationSec).toBeCloseTo(223.886, 2)
  })

  it('attributes an outbound call to the source extension, not its presented caller-id', () => {
    const e = normalizeCallEntry({
      StartTime: '2026-07-23T09:00:00+01:00',
      SourceDn: '0202',
      SourceCallerId: '35314179660',
      DestinationDn: '10000',
      DestinationCallerId: '+447700900123',
      TalkingDuration: 'PT1M0S',
      Answered: true,
      Direction: 'Outbound',
      CallType: 'Extension'
    })
    expect(e.directionNorm).toBe('outbound')
    expect(e.extension).toBe('0202')
    expect(e.external).toBe('+447700900123')
    expect(e.intlCode).toBe('44')
    expect(e.country).toBe('United Kingdom')
    expect(e.durationSec).toBe(60)
  })

  it('extracts the trunk from the Reason string', () => {
    const e = normalizeCallEntry({
      SourceDn: '10000',
      SourceCallerId: '+353873962669',
      DestinationDn: '0202',
      Direction: 'Inbound',
      Reason: 'Inbound: +353873962669 → Via trunk: SIP3 (35318665644) → Day Operations (8000)'
    })
    expect(e.trunk).toBe('SIP3')
  })
})

describe('guessHomeCountry', () => {
  it('prefers the trunk country over the caller-id country', () => {
    // A UK caller arriving on an Irish trunk → home is Ireland (the PBX location).
    const entries = [
      normalizeCallEntry({
        SourceDn: '10000',
        SourceCallerId: '+447700900123',
        DestinationDn: '0202',
        Direction: 'Inbound',
        Reason: 'Inbound → Via trunk: SIP3 (35318665644) → ext'
      })
    ]
    expect(guessHomeCountry(entries)).toBe('IE')
  })

  it('falls back to the caller-id country when no trunk is known', () => {
    const entries = [
      normalizeCallEntry({
        SourceDn: '10000',
        SourceCallerId: '+353873962669',
        DestinationDn: '0202',
        Direction: 'Inbound'
      })
    ]
    expect(guessHomeCountry(entries)).toBe('IE')
  })
})

describe('isExtensionLike', () => {
  it('accepts short all-digit numbers', () => {
    expect(isExtensionLike('2001')).toBe(true)
    expect(isExtensionLike('80')).toBe(true)
  })
  it('rejects external / long numbers', () => {
    expect(isExtensionLike('+353861234567')).toBe(false)
    expect(isExtensionLike('0871234567')).toBe(false)
    expect(isExtensionLike('')).toBe(false)
  })
})

describe('normalizeCallEntry', () => {
  it('picks source, destination, duration and answered from a call-log record', () => {
    const e = normalizeCallEntry({
      SrcCallerNumber: '2001',
      DstCallerNumber: '8000',
      TalkDuration: '0:30',
      Status: 'Answered',
      StartTime: '2026-01-01T10:00:00Z'
    })
    expect(e.from).toBe('2001')
    expect(e.to).toBe('8000')
    expect(e.durationSec).toBe(30)
    expect(e.answered).toBe(true)
    expect(e.startTime).toBe('2026-01-01T10:00:00Z')
  })

  it('does not read "Unanswered" as answered', () => {
    const e = normalizeCallEntry({ From: '2001', To: '8000', Status: 'Unanswered' })
    expect(e.answered).toBe(false)
  })

  it('treats a talking active call as answered', () => {
    expect(normalizeCallEntry({ From: '2001', To: '8000', CallState: 'Talking' }).answered).toBe(
      true
    )
  })
})

// The two legs 3CX writes for one queued inbound call: trunk → queue, then
// queue → agent. The second looks internal on its own, which is why every filter
// below reasons about whole calls rather than individual legs.
function queuedInboundCall(callId: string, start: string, agent = '0202'): ReturnType<typeof normalizeCallEntry>[] {
  return [
    normalizeCallEntry({
      MainCallHistoryId: callId,
      StartTime: start,
      SourceDn: '10000',
      SourceCallerId: '+353873962669',
      DestinationDn: '8000',
      Direction: 'Inbound',
      Answered: true
    }),
    normalizeCallEntry({
      MainCallHistoryId: callId,
      // The handling leg always starts a moment after the call itself.
      StartTime: new Date(Date.parse(start) + 12_000).toISOString(),
      SourceDn: '8000',
      DestinationDn: agent,
      Answered: true
    })
  ]
}

describe('odataDateTime', () => {
  // These values sit in the URL path of an OData function call. A 3CX build that
  // can't parse them doesn't complain — it ignores the period and answers with
  // its default window, which reads as "no calls in this period".
  it('drops the milliseconds toISOString adds', () => {
    expect(odataDateTime('2026-06-29T23:00:00.000Z')).toBe('2026-06-29T23:00:00Z')
    expect(odataDateTime('2026-08-01T22:59:59.999Z')).toBe('2026-08-01T22:59:59Z')
  })

  it('leaves the value unencoded — it must not arrive as %3A', () => {
    expect(odataDateTime('2026-07-01T00:00:00.000Z')).not.toContain('%')
    expect(odataDateTime('2026-07-01T00:00:00.000Z')).toContain(':')
  })
})

describe('splitIntoWindows', () => {
  // Deep $skip is what made long reports crawl, so the period is read in
  // day-sized windows instead of one long paged run.
  it('covers the whole period in abutting, non-overlapping windows', () => {
    const windows = splitIntoWindows('2026-07-01T00:00:00Z', '2026-07-04T23:59:59.999Z')
    expect(windows).toHaveLength(4)
    expect(windows[0].from).toBe('2026-07-01T00:00:00.000Z')
    expect(windows[3].to).toBe('2026-07-04T23:59:59.999Z')
    for (let i = 1; i < windows.length; i++) {
      // Each window starts 1ms after the previous ended — no gap, no overlap.
      expect(Date.parse(windows[i].from) - Date.parse(windows[i - 1].to)).toBe(1)
    }
  })

  it('handles a period shorter than one window', () => {
    const windows = splitIntoWindows('2026-07-01T09:00:00Z', '2026-07-01T17:00:00Z')
    expect(windows).toHaveLength(1)
  })

  it('falls back to a single window on an unparseable or inverted period', () => {
    expect(splitIntoWindows('nonsense', 'also nonsense')).toHaveLength(1)
    expect(splitIntoWindows('2026-07-31T00:00:00Z', '2026-07-01T00:00:00Z')).toHaveLength(1)
  })
})

describe('dedupeEntries', () => {
  it('drops a boundary row returned by two adjacent windows', () => {
    const row = {
      MainCallHistoryId: 'c1',
      StartTime: '2026-07-01T23:59:59.900Z',
      SourceDn: '10000',
      DestinationDn: '0202',
      Direction: 'Inbound',
      TalkingDuration: 'PT10S'
    }
    const entries = [normalizeCallEntry(row), normalizeCallEntry(row)]
    expect(dedupeEntries(entries)).toHaveLength(1)
  })

  it('keeps the separate legs of one call', () => {
    const legs = queuedInboundCall('c2', '2026-07-02T09:00:00.000Z')
    expect(dedupeEntries(legs)).toHaveLength(2)
  })

  it('keeps rows it cannot safely compare', () => {
    const undated = [normalizeCallEntry({ From: '2001', To: '8000' }), normalizeCallEntry({ From: '2001', To: '8000' })]
    expect(dedupeEntries(undated)).toHaveLength(2)
  })
})

describe('trimToPeriod', () => {
  const from = '2026-07-01T00:00:00.000Z'
  const to = '2026-07-31T23:59:59.999Z'

  it('includes calls on the first and last day, right to the boundary', () => {
    const entries = [
      ...queuedInboundCall('a', '2026-07-01T00:00:00.000Z'),
      ...queuedInboundCall('b', '2026-07-31T23:59:59.000Z')
    ]
    expect(trimToPeriod(entries, from, to)).toHaveLength(4)
  })

  it('drops calls just outside either end', () => {
    const entries = [
      ...queuedInboundCall('early', '2026-06-30T23:59:59.000Z'),
      ...queuedInboundCall('inside', '2026-07-15T10:00:00.000Z'),
      ...queuedInboundCall('late', '2026-08-01T00:00:00.500Z')
    ]
    const kept = trimToPeriod(entries, from, to)
    expect(new Set(kept.map((e) => e.callId))).toEqual(new Set(['inside']))
  })

  it('keeps every leg of a call that started inside, even one straddling midnight', () => {
    const entries = queuedInboundCall('straddle', '2026-07-31T23:59:55.000Z')
    // Second leg lands on 1 August — the call is still July's.
    expect(Date.parse(entries[1].startTime!)).toBeGreaterThan(Date.parse(to))
    expect(trimToPeriod(entries, from, to)).toHaveLength(2)
  })

  it('keeps undated rows rather than guessing', () => {
    const entries = [normalizeCallEntry({ From: '2001', To: '8000' })]
    expect(trimToPeriod(entries, from, to)).toHaveLength(1)
  })
})

describe('filterEntriesByDn', () => {
  const entries = [
    ...queuedInboundCall('q1', '2026-07-02T09:00:00.000Z', '0202'),
    ...queuedInboundCall('q2', '2026-07-02T10:00:00.000Z', '0303')
  ]

  it('keeps a whole call when any of its legs touched the chosen DN', () => {
    // 0202 only appears on the second leg — the leg carrying the caller's number
    // must come with it, or the report loses who called.
    const kept = filterEntriesByDn(entries, ['0202'])
    expect(kept).toHaveLength(2)
    expect(kept.every((e) => e.callId === 'q1')).toBe(true)
    expect(kept.some((e) => e.external === '+353873962669')).toBe(true)
  })

  it('matches a queue DN, which both calls share', () => {
    expect(filterEntriesByDn(entries, ['8000'])).toHaveLength(4)
  })

  it('drops everything when nothing matches, and filters nothing on an empty list', () => {
    expect(filterEntriesByDn(entries, ['9999'])).toHaveLength(0)
    expect(filterEntriesByDn(entries, [])).toHaveLength(4)
  })
})

describe('filterEntriesByDirection', () => {
  const inbound = queuedInboundCall('in', '2026-07-02T09:00:00.000Z')
  const internal = [
    normalizeCallEntry({ MainCallHistoryId: 'int', SourceDn: '0202', DestinationDn: '0303' })
  ]

  it('reads a queued call as inbound despite its internal-looking second leg', () => {
    expect(inbound[1].directionNorm).toBe('internal')
    expect(callDirection(inbound)).toBe('inbound')
  })

  it('keeps whole inbound calls and drops the internal one', () => {
    const kept = filterEntriesByDirection([...inbound, ...internal], ['inbound'])
    expect(kept).toHaveLength(2)
    expect(kept.every((e) => e.callId === 'in')).toBe(true)
  })

  it('filters nothing when every direction is chosen', () => {
    const all = [...inbound, ...internal]
    expect(filterEntriesByDirection(all, ['inbound', 'outbound', 'internal'])).toHaveLength(3)
    expect(filterEntriesByDirection(all, [])).toHaveLength(3)
  })
})

describe('rollupByExtension', () => {
  it('counts received / answered / missed / placed per extension', () => {
    const entries = [
      normalizeCallEntry({ From: '5551234', To: '2001', Status: 'Answered', TalkDuration: '60' }),
      normalizeCallEntry({ From: '5551234', To: '2001', Status: 'Unanswered' }),
      normalizeCallEntry({ From: '2001', To: '5559999', Status: 'Answered', TalkDuration: '30' })
    ]
    const roll = rollupByExtension(entries)
    const ext = roll.find((a) => a.extension === '2001')!
    expect(ext).toBeTruthy()
    expect(ext.received).toBe(2)
    expect(ext.answered).toBe(1)
    expect(ext.missed).toBe(1)
    expect(ext.placed).toBe(1)
    expect(ext.active).toBe(true)
    // External numbers are not extensions, so they don't get their own rollup row.
    expect(roll.some((a) => a.extension === '5551234')).toBe(false)
  })
})

describe('normalizeCallEntry — answered vs merely rung', () => {
  it('does not read a ring as talk time, nor as an answer', () => {
    // RingingDuration used to sit in the talk-duration fallback, so a leg that
    // only rang reported the ring as its duration — and the last-resort answered
    // test is "did it have any duration".
    const e = normalizeCallEntry({
      SourceDn: '10000',
      DestinationDn: '0202',
      Direction: 'Inbound',
      RingingDuration: 'PT14S',
      Status: 'Routing'
    })
    expect(e.durationSec).toBeUndefined()
    expect(e.answered).toBe(false)
  })

  it('flags a leg that voicemail picked up', () => {
    const e = normalizeCallEntry({
      SourceDn: '10000',
      DestinationDn: '1017',
      Direction: 'Inbound',
      Callee: 'Voicemail Box (1017)',
      TalkingDuration: 'PT30S',
      Answered: true
    })
    expect(e.toVoicemail).toBe(true)
    expect(e.answered).toBe(true)
  })

  it('reads the reason when the destination name says nothing', () => {
    const e = normalizeCallEntry({
      SourceDn: '2056',
      DestinationDn: '1017',
      Reason: 'No answer, call forwarded to Voicemail Box (1017)'
    })
    expect(e.toVoicemail).toBe(true)
  })

  it('leaves an ordinary answered call alone', () => {
    const e = normalizeCallEntry({
      SourceDn: '10000',
      DestinationDn: '0202',
      Direction: 'Inbound',
      TalkingDuration: 'PT1M',
      RingingDuration: 'PT5S',
      Status: 'Answered'
    })
    expect(e.toVoicemail).toBeUndefined()
    expect(e.durationSec).toBe(60)
    expect(e.answered).toBe(true)
  })
})
