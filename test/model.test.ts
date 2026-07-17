import { describe, it, expect } from 'vitest'
import {
  presenceOf,
  queueLoggedIn,
  departmentColor,
  SHARED_DEPARTMENT
} from '../src/renderer/src/graph/model'

describe('presenceOf', () => {
  it('reports offline when not registered, whatever the profile says', () => {
    expect(presenceOf({ IsRegistered: false, CurrentProfileName: 'Available' })).toBe('offline')
  })

  it('detects Do Not Disturb', () => {
    expect(presenceOf({ IsRegistered: true, CurrentProfileName: 'Do Not Disturb' })).toBe('dnd')
    expect(presenceOf({ CurrentProfileName: 'DND' })).toBe('dnd')
  })

  it('detects Available', () => {
    expect(presenceOf({ CurrentProfileName: 'Available' })).toBe('available')
  })

  it('maps any other profile to away', () => {
    expect(presenceOf({ CurrentProfileName: 'Lunch' })).toBe('away')
    expect(presenceOf({ CurrentProfileName: 'Out of office' })).toBe('away')
    expect(presenceOf({ CurrentProfileName: 'Business Trip' })).toBe('away')
  })

  it('returns null when there is no signal', () => {
    expect(presenceOf({})).toBeNull()
    expect(presenceOf({ CurrentProfileName: '' })).toBeNull()
  })
})

describe('queueLoggedIn', () => {
  it('is true when logged in', () => {
    expect(queueLoggedIn({ QueueStatus: 'LoggedIn' })).toBe(true)
  })

  it('is false when logged out', () => {
    expect(queueLoggedIn({ QueueStatus: 'LoggedOut' })).toBe(false)
  })

  it('is null when absent or unrecognised', () => {
    expect(queueLoggedIn({})).toBeNull()
    expect(queueLoggedIn({ QueueStatus: 'weird' })).toBeNull()
  })
})

describe('departmentColor', () => {
  it('uses the neutral colour for the shared bucket', () => {
    expect(departmentColor(SHARED_DEPARTMENT)).toBe('#64748b')
  })

  it('is deterministic per department name', () => {
    expect(departmentColor('Sales')).toBe(departmentColor('Sales'))
  })
})
