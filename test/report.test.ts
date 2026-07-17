import { describe, it, expect } from 'vitest'
import {
  normalizeCallEntry,
  rollupByExtension,
  parseDuration,
  isExtensionLike
} from '../src/main/threecx/client'

describe('parseDuration', () => {
  it('parses plain seconds', () => expect(parseDuration('45')).toBe(45))
  it('parses HH:MM:SS', () => expect(parseDuration('1:02:03')).toBe(3723))
  it('parses MM:SS', () => expect(parseDuration('2:30')).toBe(150))
  it('treats empty as zero', () => expect(parseDuration('')).toBe(0))
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
