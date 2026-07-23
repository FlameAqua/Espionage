import { describe, it, expect } from 'vitest'
import {
  normalizeCallEntry,
  rollupByExtension,
  parseDuration,
  isExtensionLike,
  guessHomeCountry
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
