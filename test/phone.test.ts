import { describe, it, expect } from 'vitest'
import {
  callingCodeForIso,
  classifyDirection,
  classifyScope,
  countryFromBareNumber,
  isExtensionLike,
  parseInternational,
  parseTrunkFromReason,
  pickParties
} from '../src/shared/phone'

describe('isExtensionLike', () => {
  it('accepts short all-digit numbers', () => {
    expect(isExtensionLike('100')).toBe(true)
    expect(isExtensionLike('4021')).toBe(true)
  })
  it('rejects long or non-digit numbers', () => {
    expect(isExtensionLike('+44207946123')).toBe(false)
    expect(isExtensionLike('02079460000')).toBe(false)
    expect(isExtensionLike('abc')).toBe(false)
  })
})

describe('parseInternational', () => {
  it('matches a "+" prefixed number by longest dialling code', () => {
    expect(parseInternational('+442079460000')?.country).toBe('United Kingdom')
    expect(parseInternational('+40 21 555 1234')?.country).toBe('Romania')
    expect(parseInternational('+1 202 555 0100')?.iso2).toBe('US')
  })
  it('matches a "00" international prefix', () => {
    expect(parseInternational('0040745123456')?.code).toBe('40')
  })
  it('returns null for domestic-format and extension numbers', () => {
    expect(parseInternational('02079460000')).toBeNull()
    expect(parseInternational('100')).toBeNull()
    expect(parseInternational(undefined)).toBeNull()
  })
  it('still resolves an unknown code as international', () => {
    const r = parseInternational('+9990001')
    expect(r).not.toBeNull()
    expect(r?.country).toMatch(/Unknown/)
  })
})

describe('classifyDirection', () => {
  it('trusts textual hints', () => {
    expect(classifyDirection('100', '200', 'Inbound')).toBe('inbound')
    expect(classifyDirection('x', 'y', 'Outbound')).toBe('outbound')
    expect(classifyDirection('x', 'y', 'Internal')).toBe('internal')
  })
  it('infers structurally when no hint', () => {
    expect(classifyDirection('100', '200', '')).toBe('internal')
    expect(classifyDirection('100', '+441234', '')).toBe('outbound')
    expect(classifyDirection('+441234', '100', '')).toBe('inbound')
    expect(classifyDirection('+441234', '+445678', '')).toBe('unknown')
  })
})

describe('pickParties', () => {
  it('attributes inbound calls to the destination extension', () => {
    expect(pickParties('+441234', '100', 'inbound')).toEqual({
      extension: '100',
      external: '+441234'
    })
  })
  it('attributes outbound calls to the source extension', () => {
    expect(pickParties('100', '+441234', 'outbound')).toEqual({
      extension: '100',
      external: '+441234'
    })
  })
  it('has no external party for internal calls', () => {
    expect(pickParties('100', '200', 'internal')).toEqual({ extension: '100', external: undefined })
  })
})

describe('parseTrunkFromReason', () => {
  it('extracts the trunk name and number from a 3CX reason string', () => {
    const r = parseTrunkFromReason(
      'Inbound: +353873962669 (+353873962669) → Via trunk: SIP3 (35318665644) → transferred'
    )
    expect(r).toEqual({ name: 'SIP3', number: '35318665644' })
  })
  it('returns null when there is no trunk', () => {
    expect(parseTrunkFromReason('Ended by +353873962669')).toBeNull()
    expect(parseTrunkFromReason(undefined)).toBeNull()
  })
})

describe('countryFromBareNumber', () => {
  it('matches a full E.164 number without a + (trunk DID)', () => {
    expect(countryFromBareNumber('35318665644')?.iso2).toBe('IE')
    expect(countryFromBareNumber('442079460000')?.iso2).toBe('GB')
  })
  it('does not match national numbers or short strings', () => {
    expect(countryFromBareNumber('018665644')).toBeNull() // national, leading 0
    expect(countryFromBareNumber('353')).toBeNull() // too short
    expect(countryFromBareNumber('')).toBeNull()
  })
})

describe('classifyScope', () => {
  const home = callingCodeForIso('GB')! // +44

  it('marks internal calls internal', () => {
    expect(classifyScope('internal', null, home.code, 'United Kingdom').scope).toBe('internal')
  })
  it('marks domestic-format numbers national under the home country', () => {
    const r = classifyScope('outbound', null, home.code, 'United Kingdom')
    expect(r.scope).toBe('national')
    expect(r.country).toBe('United Kingdom')
  })
  it('marks a home-code international number national', () => {
    const intl = parseInternational('+442079460000')
    expect(classifyScope('outbound', intl, home.code, 'United Kingdom').scope).toBe('national')
  })
  it('marks a foreign-code number international with its country', () => {
    const intl = parseInternational('+3312345678')
    const r = classifyScope('inbound', intl, home.code, 'United Kingdom')
    expect(r.scope).toBe('international')
    expect(r.country).toBe('France')
  })
  it('labels domestic numbers "National" when no home country is set', () => {
    expect(classifyScope('outbound', null, '', '').country).toBe('National')
  })
})
