import { describe, it, expect } from 'vitest'
import {
  agentLoggedIn,
  presenceOf,
  queueLoggedIn,
  queueLoginState,
  departmentColor,
  routeGroupOf,
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

describe('queueLoginState (effective queue login)', () => {
  // Shape taken from a real v20 extension (2025) that reported QueueStatus
  // "LoggedIn" while actually being logged out of its queues, because its active
  // "Out of office" profile auto-logs out. This is the case that was mislabelled.
  const autoLoggedOut = {
    QueueStatus: 'LoggedIn',
    CurrentProfileName: 'Out of office',
    ForwardingProfiles: [
      { Name: 'Out of office', CustomName: '', OfficeHoursAutoQueueLogOut: true },
      { Name: 'Available', CustomName: '', OfficeHoursAutoQueueLogOut: false }
    ]
  }

  it('reports logged out when the active profile auto-logs out of queues', () => {
    const st = queueLoginState(autoLoggedOut)
    expect(st?.loggedIn).toBe(false)
    expect(st?.reason).toMatch(/Out of office/)
  })

  it('trusts QueueStatus when the active profile does not auto-log out', () => {
    expect(
      queueLoginState({ ...autoLoggedOut, CurrentProfileName: 'Available' })?.loggedIn
    ).toBe(true)
  })

  it('matches the active profile by its custom label too', () => {
    const st = queueLoginState({
      QueueStatus: 'LoggedIn',
      CurrentProfileName: 'On lunch',
      ForwardingProfiles: [
        { Name: 'Away', CustomName: 'On lunch', OfficeHoursAutoQueueLogOut: true }
      ]
    })
    expect(st?.loggedIn).toBe(false)
  })

  it('still reports a plain logged-out status without a reason', () => {
    const st = queueLoginState({ QueueStatus: 'LoggedOut' })
    expect(st?.loggedIn).toBe(false)
    expect(st?.reason).toBeUndefined()
  })

  it('is null when there is no signal at all', () => {
    expect(queueLoginState({})).toBeNull()
  })
})

describe('agentLoggedIn (per-queue state)', () => {
  // A real v20 agent entry from Queues?$expand=Agents — no login field exists, so
  // this must report "unknown" rather than inventing a value.
  it('returns null for a real v20 agent entry', () => {
    expect(
      agentLoggedIn({ Number: '2025', SkillGroup: '1', Name: '2025 Ronald', Tags: [], Id: 260 })
    ).toBeNull()
  })

  it('reads the state from whichever field the build reports it in', () => {
    expect(agentLoggedIn({ QueueStatus: 'LoggedIn' })).toBe(true)
    expect(agentLoggedIn({ QueueStatus: 'LoggedOut' })).toBe(false)
    expect(agentLoggedIn({ IsLoggedIn: true })).toBe(true)
    expect(agentLoggedIn({ IsLoggedIn: false })).toBe(false)
    expect(agentLoggedIn({ LoggedIn: 'true' })).toBe(true)
    expect(agentLoggedIn({ AgentStatus: 'Signed out' })).toBe(false)
  })

  it('does not mistake "LoggedIn" for a logged-out value', () => {
    // "LoggedIn" contains no "out", but a naive /out/ test on other wording could
    // flip it — pin the happy path explicitly.
    expect(agentLoggedIn({ QueueStatus: 'loggedin' })).toBe(true)
  })

  it('ignores unrelated field values rather than guessing', () => {
    expect(agentLoggedIn({})).toBeNull()
    expect(agentLoggedIn({ AgentStatus: 'Available' })).toBeNull()
    expect(agentLoggedIn({ QueueStatus: '' })).toBeNull()
    // A skill group number must not be read as a login flag.
    expect(agentLoggedIn({ SkillGroup: 3 })).toBeNull()
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

// The granularity at which links can be hidden. Hiding a link's KIND is far too
// blunt — an out-of-hours destination and an IVR key press are both plain
// `route` links — so labels are normalised down to the recurring branch name.
describe('routeGroupOf', () => {
  it('keeps a branch name as its own group', () => {
    expect(routeGroupOf('out of office hours destination')).toBe('out of office hours destination')
  })

  it('separates out-of-hours from ordinary routes', () => {
    expect(routeGroupOf('office hours destination')).not.toBe(
      routeGroupOf('out of office hours destination')
    )
  })

  it('collapses every digit option into one group', () => {
    expect(routeGroupOf('key 1 → queue')).toBe('key press')
    expect(routeGroupOf('key 7 → voicemail')).toBe('key press')
  })

  it('drops the destination suffix, which says where the branch ends not what it is', () => {
    expect(routeGroupOf('timeout: voicemail')).toBe('timeout')
    expect(routeGroupOf('timeout')).toBe('timeout')
  })

  it('ignores live state so a logged-out agent groups with the rest', () => {
    expect(routeGroupOf('agent (logged out)')).toBe('agent')
    expect(routeGroupOf('agent')).toBe('agent')
  })

  it('is case-insensitive', () => {
    expect(routeGroupOf('Away: no answer')).toBe(routeGroupOf('away: no answer'))
  })

  it('returns an empty group for an unlabelled link', () => {
    expect(routeGroupOf('')).toBe('')
    expect(routeGroupOf('   ')).toBe('')
  })
})
