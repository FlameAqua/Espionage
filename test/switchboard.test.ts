import { describe, it, expect } from 'vitest'
import { parseAgentTiles, type RawTile } from '../src/main/threecx/switchboard'

// Tiles exactly as the v20 Switchboard renders them (captured from a live
// OC Support 1 Queue page). 2025 is logged out of THIS queue while its
// extension-wide QueueStatus still says "LoggedIn" — the case the config API
// cannot express.
const tiles: RawTile[] = [
  { extension: '2003', name: '2003 Jarek Zaleski', status: 'Logged In 23/06/2026 03:38' },
  { extension: '2013', name: '2013 Adrian', status: 'Logged In 29/07/2026 14:40' },
  { extension: '2025', name: '2025 Ronald Davila OC', status: 'Logged Out 23/06/2026 03:38' },
  { extension: '2034', name: '2034 Tomek Zaleski', status: 'Logged In 29/07/2026 14:07' }
]

describe('parseAgentTiles', () => {
  const parsed = parseAgentTiles(tiles)

  it('reads each agent’s state for this queue', () => {
    expect(parsed.map((a) => [a.extension, a.loggedIn])).toEqual([
      ['2003', true],
      ['2013', true],
      ['2025', false],
      ['2034', true]
    ])
  })

  it('does not read "Logged Out" as logged in', () => {
    // "Logged Out" contains "Logged", so an in-before-out check would flip it.
    expect(parsed.find((a) => a.extension === '2025')?.loggedIn).toBe(false)
  })

  it('keeps the timestamp shown beside the state', () => {
    expect(parsed.find((a) => a.extension === '2013')?.since).toBe('29/07/2026 14:40')
  })

  it('skips tiles with no extension or an unrecognised state', () => {
    expect(
      parseAgentTiles([
        { extension: '', name: 'no ext', status: 'Logged In' },
        { extension: '2099', name: 'odd', status: 'Ringing' },
        { extension: '2100', name: 'blank', status: '' }
      ])
    ).toEqual([])
  })

  // Captured from OC Support 3 Queue (8032, Id 173) with 2013 logged out of that
  // queue only — its user record still says QueueStatus "LoggedIn" under an
  // "Available" profile, so the config API cannot express this and only the
  // Switchboard can.
  it('reads a per-queue logout that the config API cannot express', () => {
    const q8032 = parseAgentTiles([
      { extension: '2012', name: '2012 Paul OC Delaney', status: 'Logged In 23/06/2026 03:38' },
      { extension: '2013', name: '2013 Adrian', status: 'Logged Out 29/07/2026 15:30' },
      { extension: '2018', name: '2018 Toms OC new office', status: 'Logged In 23/06/2026 03:38' }
    ])
    expect(q8032.find((a) => a.extension === '2013')).toEqual({
      extension: '2013',
      loggedIn: false,
      since: '29/07/2026 15:30'
    })
    // The same extension is logged IN elsewhere, which is the whole point.
    expect(
      parseAgentTiles([
        { extension: '2013', name: '2013 Adrian', status: 'Logged In 29/07/2026 14:40' }
      ])[0].loggedIn
    ).toBe(true)
  })

  it('tolerates the spacing variations the DOM produces', () => {
    expect(
      parseAgentTiles([{ extension: '2050', name: 'x', status: 'LoggedOut  01/01/2026 09:00' }])
    ).toEqual([{ extension: '2050', loggedIn: false, since: '01/01/2026 09:00' }])
  })
})
