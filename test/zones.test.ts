import { describe, it, expect, beforeEach } from 'vitest'

// zones.ts persists to localStorage, which the Node test env lacks — provide a
// tiny in-memory stand-in before importing the module under test.
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
const store = new MemStore()
;(globalThis as unknown as { localStorage: MemStore }).localStorage = store

const { defaultZoneConfig, zoneForNumber } = await import('../src/renderer/src/ui/zones')

describe('defaultZoneConfig', () => {
  it('seeds three zones from the operator list', () => {
    const c = defaultZoneConfig()
    expect(c.zones).toHaveLength(3)
    expect(c.zones[0].entries.length).toBeGreaterThan(10)
    // Ireland mobile is a Zone 2 destination in the supplied list.
    const z2 = c.zones.find((z) => z.label === 'Zone 2')!
    expect(z2.entries.some((e) => e.country === 'IRELAND' && e.lineType === 'Mobile')).toBe(true)
  })
})

describe('zoneForNumber (default config)', () => {
  beforeEach(() => store.clear())

  it('places an Irish mobile in Zone 2 via tariff match', () => {
    const r = zoneForNumber('0851234567', '353')
    expect(r.country).toBe('IRELAND')
    expect(r.lineType).toBe('Mobile')
    expect(r.zone).toBe('Zone 2')
  })

  it('places a US landline in Zone 1', () => {
    const r = zoneForNumber('+12124567890', '353')
    expect(r.country).toBe('UNITED STATES')
    expect(r.zone).toBe('Zone 1')
  })

  it('returns no zone for an unresolved number', () => {
    const r = zoneForNumber('', '353')
    expect(r.zone).toBeNull()
  })
})
