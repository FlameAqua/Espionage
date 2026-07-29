import { describe, it, expect } from 'vitest'
import {
  canonicalCountry,
  matchTariff,
  tariffCountryTypes
} from '../src/renderer/src/report/tariff'

describe('canonicalCountry', () => {
  it('folds naming variants to one key', () => {
    expect(canonicalCountry('UK')).toBe('UNITED KINGDOM')
    expect(canonicalCountry('uk ')).toBe('UNITED KINGDOM')
    expect(canonicalCountry('USA')).toBe('UNITED STATES')
    expect(canonicalCountry('South Korea')).toBe('KOREA SOUTH')
    expect(canonicalCountry('Cyprus South')).toBe('CYPRUS')
    expect(canonicalCountry('Dominican Rep.')).toBe('DOMINICAN REPUBLIC')
  })
  it('passes through an already-canonical name', () => {
    expect(canonicalCountry('IRELAND')).toBe('IRELAND')
    expect(canonicalCountry('France')).toBe('FRANCE')
  })
})

describe('matchTariff — longest-prefix country + line type', () => {
  it('splits Irish mobile vs fixed by prefix', () => {
    const mob = matchTariff('+35387' + '1234567')
    expect(mob?.country).toBe('IRELAND')
    expect(mob?.lineType).toBe('Mobile')

    const fixed = matchTariff('0035312345678') // 00 international form, 353 = Ireland-Fixed
    expect(fixed?.country).toBe('IRELAND')
    expect(fixed?.lineType).toBe('Landline')
  })

  it('resolves a national number via the home dialling code', () => {
    const mob = matchTariff('0851234567', '353') // Irish national mobile
    expect(mob?.country).toBe('IRELAND')
    expect(mob?.lineType).toBe('Mobile')
  })

  it('distinguishes UK mobile from UK landline', () => {
    const mob = matchTariff('+447700900123')
    expect(mob?.country).toBe('UNITED KINGDOM')
    expect(mob?.lineType).toBe('Mobile')

    const land = matchTariff('+442071234567') // London landline
    expect(land?.country).toBe('UNITED KINGDOM')
    expect(land?.lineType).toBe('Landline')
  })

  it('separates US and Canada within +1', () => {
    expect(matchTariff('+12124567890')?.country).toBe('UNITED STATES')
    expect(matchTariff('+12044567890')?.country).toBe('CANADA')
  })

  it('returns a positive per-minute rate', () => {
    const m = matchTariff('+35312345678')
    expect(m).not.toBeNull()
    expect(m!.rate).toBeGreaterThan(0)
  })

  it('returns null for numbers with no resolvable prefix', () => {
    expect(matchTariff('')).toBeNull()
    expect(matchTariff(undefined)).toBeNull()
    expect(matchTariff('1234')).toBeNull() // short, no home code
  })

  // Regression: "1" is a real tariff prefix (United States), so a national number
  // beginning with 1 used to be misread as North America instead of home-country.
  it('treats a home-country national number starting with 1 as national', () => {
    const m = matchTariff('1850123456', '353') // Irish 1850 service number
    expect(m?.country).toBe('IRELAND')
    expect(matchTariff('1800555123', '353')?.country).toBe('IRELAND')
  })

  it('still reads a bare E.164 number in the home country as-is', () => {
    const m = matchTariff('35318665644', '353') // trunk DID, no leading +
    expect(m?.country).toBe('IRELAND')
    expect(m?.lineType).toBe('Landline')
  })

  it('without a home country, ignores a single-digit bare code match', () => {
    // No home baseline to anchor against: don't guess NANP off a leading "1".
    expect(matchTariff('1850123456')).toBeNull()
    // A multi-digit bare code is still trusted.
    expect(matchTariff('35387123456')?.country).toBe('IRELAND')
  })
})

describe('tariffCountryTypes', () => {
  it('lists distinct (country, type) buckets including Irish mobile', () => {
    const list = tariffCountryTypes()
    expect(list.length).toBeGreaterThan(50)
    expect(list.some((c) => c.country === 'IRELAND' && c.lineType === 'Mobile')).toBe(true)
    // No duplicate country|type pairs.
    const keys = list.map((c) => `${c.country}|${c.lineType}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
