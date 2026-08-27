// Opening hours per department, and what state one is in at a given moment.

import { describe, it, expect } from 'vitest'
import {
  departmentHours,
  describeDay,
  fromMinutes,
  inHoliday,
  parseHoliday,
  parseSchedule,
  stateAt,
  toMinutes,
  weekView,
  type DepartmentHours
} from '../src/renderer/src/graph/office-hours'

/** Mon–Fri 09:00–17:30, the shape 3CX sends. */
const nineToFive = {
  Type: 'OfficeHours',
  IgnoreHolidays: false,
  Periods: [1, 2, 3, 4, 5].map((d) => ({
    DayOfWeek: d,
    Start: '09:00:00',
    Stop: '17:30:00'
  }))
}

const dept = (over: Partial<DepartmentHours> = {}): DepartmentHours => ({
  bucket: 'Sales',
  hours: parseSchedule(nineToFive),
  hoursPresent: true,
  holidays: [],
  ...over
})

// Local time, so it lines up with what the app compares against.
const at = (day: string, time: string): Date => new Date(`${day}T${time}`)

describe('toMinutes', () => {
  it('reads a clock time', () => {
    expect(toMinutes('09:00:00')).toBe(540)
    expect(toMinutes('9:05')).toBe(545)
    expect(toMinutes('17:30:00')).toBe(1050)
  })

  it('tolerates the fractional seconds Edm.TimeOfDay sends', () => {
    // 3CX serialises TimeOfDay with seven decimal places. Rejecting the fraction
    // dropped every period on the floor, which read on screen as a department
    // closed all week.
    expect(toMinutes('09:00:00.0000000')).toBe(540)
    expect(toMinutes('17:30:00.5')).toBe(1050)
  })

  it('reads an ISO duration, which is how Edm.Duration arrives', () => {
    expect(toMinutes('PT9H')).toBe(540)
    expect(toMinutes('PT17H30M')).toBe(1050)
  })

  it('refuses nonsense rather than guessing', () => {
    expect(toMinutes('')).toBeNull()
    expect(toMinutes(null)).toBeNull()
    expect(toMinutes('25:00')).toBeNull()
    expect(toMinutes('half nine')).toBeNull()
  })

  it('round-trips through fromMinutes', () => {
    expect(fromMinutes(540)).toBe('09:00')
    expect(fromMinutes(1050)).toBe('17:30')
  })
})

describe('parseSchedule', () => {
  it('reads the weekly periods', () => {
    const s = parseSchedule(nineToFive)!
    expect(s.type).toBe('OfficeHours')
    expect(s.periods).toHaveLength(5)
    expect(s.periods[0]).toEqual({ day: 1, startMin: 540, stopMin: 1050 })
  })

  it('accepts day names as well as numbers', () => {
    const s = parseSchedule({
      Periods: [{ DayOfWeek: 'Wednesday', Start: '10:00', Stop: '12:00' }]
    })!
    expect(s.periods[0].day).toBe(3)
  })

  it('splits a period that runs past midnight instead of letting it wrap', () => {
    // 22:00–02:00 on Friday is Friday night AND Saturday morning; a single
    // wrapping range would make every comparison a special case.
    const s = parseSchedule({ Periods: [{ DayOfWeek: 5, Start: '22:00', Stop: '02:00' }] })!
    expect(s.periods).toEqual([
      { day: 5, startMin: 1320, stopMin: 1440 },
      { day: 6, startMin: 0, stopMin: 120 }
    ])
  })

  it('drops periods it cannot read rather than inventing hours', () => {
    const s = parseSchedule({ Periods: [{ DayOfWeek: 1, Start: 'nope', Stop: '17:00' }] })!
    expect(s.periods).toEqual([])
  })

  it('returns undefined when there is no schedule at all', () => {
    expect(parseSchedule(null)).toBeUndefined()
    expect(parseSchedule('AllHours')).toBeUndefined()
  })
})

describe('stateAt', () => {
  it('is open inside the working day', () => {
    expect(stateAt(dept(), at('2026-08-19', '10:00')).state).toBe('open') // Wednesday
  })

  it('is closed before it opens and after it shuts', () => {
    expect(stateAt(dept(), at('2026-08-19', '08:59')).state).toBe('closed')
    expect(stateAt(dept(), at('2026-08-19', '17:30')).state).toBe('closed')
  })

  it('treats the closing minute as closed, not open', () => {
    // 17:30–17:30 is the end of the period; a call at exactly 17:30 is out.
    expect(stateAt(dept(), at('2026-08-19', '17:29')).state).toBe('open')
    expect(stateAt(dept(), at('2026-08-19', '17:31')).state).toBe('closed')
  })

  it('is closed at the weekend', () => {
    expect(stateAt(dept(), at('2026-08-22', '10:00')).state).toBe('closed') // Saturday
  })

  it('reports break time as its own state, not as closed', () => {
    const d = dept({
      breakTime: parseSchedule({ Periods: [{ DayOfWeek: 3, Start: '13:00', Stop: '14:00' }] })
    })
    expect(stateAt(d, at('2026-08-19', '13:30')).state).toBe('break')
    expect(stateAt(d, at('2026-08-19', '14:30')).state).toBe('open')
  })

  it('reports a holiday, and says which one', () => {
    const d = dept({
      holidays: [parseHoliday({ Name: 'Christmas', Month: 12, Day: 25, IsRecurrent: true })!]
    })
    const r = stateAt(d, at('2026-12-25', '10:00'))
    expect(r.state).toBe('holiday')
    expect(r.why).toBe('Christmas')
  })

  it('honours a schedule that ignores holidays', () => {
    const d = dept({
      hours: parseSchedule({ ...nineToFive, IgnoreHolidays: true }),
      holidays: [parseHoliday({ Name: 'Christmas', Month: 12, Day: 25, IsRecurrent: true })!]
    })
    // 25 Dec 2026 is a Friday, so the working day applies.
    expect(stateAt(d, at('2026-12-25', '10:00')).state).toBe('open')
  })

  it('lets a manual override beat the clock entirely', () => {
    const shut = dept({ forced: 'ForceClosed' })
    expect(stateAt(shut, at('2026-08-19', '10:00')).state).toBe('closed')
    const open = dept({ forced: 'ForceOpened' })
    expect(stateAt(open, at('2026-08-22', '03:00')).state).toBe('open')
  })

  it('treats AllHours as open around the clock, periods or not', () => {
    const d = dept({ hours: parseSchedule({ Type: 'AllHours', Periods: [] }) })
    expect(stateAt(d, at('2026-08-22', '03:00')).state).toBe('open')
  })

  it('still lets a holiday interrupt AllHours', () => {
    const d = dept({
      hours: parseSchedule({ Type: 'AllHours', Periods: [] }),
      holidays: [parseHoliday({ Name: 'Christmas', Month: 12, Day: 25, IsRecurrent: true })!]
    })
    expect(stateAt(d, at('2026-12-25', '10:00')).state).toBe('holiday')
  })

  it('treats Never as closed rather than unconfigured', () => {
    const d = dept({ hours: parseSchedule({ Type: 'Never', Periods: [] }) })
    expect(stateAt(d, at('2026-08-19', '10:00')).state).toBe('closed')
  })

  it('separates "not configured" from "never sent", which mean opposite things', () => {
    const configured = stateAt(
      dept({ hours: undefined, hoursPresent: true }),
      at('2026-08-19', '10:00')
    )
    expect(configured.why).toMatch(/system-wide schedule/)
    const missing = stateAt(
      dept({ hours: undefined, hoursPresent: false }),
      at('2026-08-19', '10:00')
    )
    expect(missing.why).toMatch(/returned no schedule/)
    // Both are 'unknown': neither is a licence to claim the department is shut.
    expect(configured.state).toBe('unknown')
    expect(missing.state).toBe('unknown')
  })

  it('says "unknown" rather than "closed" when no hours are set', () => {
    // A department with no schedule follows the system-wide one, which isn't in
    // this record — reporting it as closed would be a lie.
    const r = stateAt(dept({ hours: undefined }), at('2026-08-19', '10:00'))
    expect(r.state).toBe('unknown')
    expect(r.why).toMatch(/No hours set/)
  })
})

describe('inHoliday', () => {
  it('matches a recurring holiday in any year', () => {
    const h = parseHoliday({ Name: 'Christmas', Month: 12, Day: 25, IsRecurrent: true })!
    expect(inHoliday(h, at('2026-12-25', '09:00'))).toBe(true)
    expect(inHoliday(h, at('2031-12-25', '09:00'))).toBe(true)
    expect(inHoliday(h, at('2026-12-26', '09:00'))).toBe(false)
  })

  it('matches a multi-day holiday across its whole range', () => {
    const h = parseHoliday({ Name: 'Shutdown', Month: 12, Day: 24, MonthEnd: 12, DayEnd: 28 })!
    expect(inHoliday(h, at('2026-12-26', '12:00'))).toBe(true)
    expect(inHoliday(h, at('2026-12-29', '12:00'))).toBe(false)
  })

  it('handles a recurring holiday that runs over New Year', () => {
    const h = parseHoliday({ Name: 'Festive', Month: 12, Day: 30, MonthEnd: 1, DayEnd: 2 })!
    expect(inHoliday(h, at('2026-12-31', '12:00'))).toBe(true)
  })

  it('pins a one-off holiday to its year', () => {
    const h = parseHoliday({ Name: 'Move', Month: 6, Day: 1, Year: 2026, IsRecurrent: false })!
    expect(inHoliday(h, at('2026-06-01', '12:00'))).toBe(true)
    expect(inHoliday(h, at('2027-06-01', '12:00'))).toBe(false)
  })
})

describe('weekView / describeDay', () => {
  it('lays the week out Sunday first, matching 3CX', () => {
    const w = weekView(parseSchedule(nineToFive))
    expect(w).toHaveLength(7)
    expect(w[0].name).toBe('Sunday')
    expect(w[0].periods).toEqual([])
    expect(w[1].name).toBe('Monday')
  })

  it('reads a day out, or says it is closed', () => {
    const w = weekView(parseSchedule(nineToFive))
    expect(describeDay(w[1].periods)).toBe('09:00–17:30')
    expect(describeDay(w[0].periods)).toBe('Closed')
  })

  it('shows a stretch to midnight as 24:00 rather than 00:00', () => {
    const s = parseSchedule({ Periods: [{ DayOfWeek: 1, Start: '18:00', Stop: '00:00' }] })
    // 18:00–00:00 has stop before start, so it splits; Monday runs to midnight.
    expect(describeDay(weekView(s)[1].periods)).toBe('18:00–24:00')
  })
})

describe('departmentHours', () => {
  it('reads every department that has hours', () => {
    const list = departmentHours([
      { Name: 'Sales', Hours: nineToFive, TimeZoneId: 'Europe/Dublin' },
      { Name: 'Support', Hours: nineToFive }
    ])
    expect(list.map((d) => d.bucket)).toEqual(['Sales', 'Support'])
    expect(list[0].timeZoneId).toBe('Europe/Dublin')
  })

  it('skips the tenant-wide DEFAULT group, which is not a department', () => {
    expect(departmentHours([{ Name: 'DEFAULT', Hours: nineToFive }])).toEqual([])
  })

  it('keeps a department with no hours, so the panel can say so', () => {
    const list = departmentHours([{ Name: 'Sales' }])
    expect(list).toHaveLength(1)
    expect(list[0].hours).toBeUndefined()
    expect(list[0].hoursPresent).toBe(false)
  })

  it('notes that a schedule arrived even when it carries no periods', () => {
    const list = departmentHours([{ Name: 'Sales', Hours: { Type: 'OfficeHours', Periods: [] } }])
    expect(list[0].hoursPresent).toBe(true)
  })

  it('reads holidays off the expanded navigation property', () => {
    const list = departmentHours([
      {
        Name: 'Sales',
        Hours: nineToFive,
        OfficeHolidays: [{ Name: 'Christmas', Month: 12, Day: 25, IsRecurrent: true }]
      }
    ])
    expect(list[0].holidays.map((h) => h.name)).toEqual(['Christmas'])
  })
})

// Verbatim from a live 3CX v20 system, including the details that broke this:
// fractional seconds on every time, day names rather than numbers, a `Type` of
// SpecificHoursExcludingHolidays, and 3CX's internal ___FAVORITES___ groups
// sitting in the same collection as real departments.
describe('a real Groups payload', () => {
  const live = [
    {
      Name: '___FAVORITES___2002',
      TimeZoneId: null,
      CurrentGroupHours: 'Default',
      Hours: { Type: 'OfficeHours', IgnoreHolidays: false, Periods: [] },
      BreakTime: { Type: 'OfficeHours', IgnoreHolidays: false, Periods: [] },
      OfficeHolidays: []
    },
    {
      Name: 'OneContact',
      TimeZoneId: null,
      CurrentGroupHours: 'Default',
      Hours: {
        Type: 'SpecificHoursExcludingHolidays',
        IgnoreHolidays: false,
        Periods: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].map((d) => ({
          DayOfWeek: d,
          Start: '09:00:00.0000000',
          Stop: '17:30:00.0000000'
        }))
      },
      BreakTime: { Type: 'SpecificHoursExcludingHolidays', IgnoreHolidays: false, Periods: [] },
      OfficeHolidays: [
        {
          Group: 'GRP4',
          Day: 24,
          DayEnd: 27,
          IsRecurrent: false,
          Month: 12,
          MonthEnd: 12,
          Name: 'Christmas 2022 24-27 December',
          Year: 2022,
          YearEnd: 2022,
          Id: 13
        },
        {
          Group: 'GRP4',
          Day: 17,
          DayEnd: 17,
          IsRecurrent: false,
          Month: 3,
          MonthEnd: 3,
          Name: 'St.Patrick',
          Year: 2026,
          YearEnd: 2026,
          Id: 46
        }
      ]
    }
  ]

  it('drops the ___FAVORITES___ groups, which are speed dials and not departments', () => {
    expect(departmentHours(live).map((d) => d.bucket)).toEqual(['OneContact'])
  })

  it('reads the working week off the wire', () => {
    const d = departmentHours(live)[0]
    expect(d.hours!.periods).toHaveLength(5)
    expect(describeDay(weekView(d.hours)[1].periods)).toBe('09:00–17:30')
  })

  it('is open during the working day and shut outside it', () => {
    const d = departmentHours(live)[0]
    // 2026-08-19 is a Wednesday, 2026-08-22 a Saturday.
    expect(stateAt(d, at('2026-08-19', '10:00')).state).toBe('open')
    expect(stateAt(d, at('2026-08-19', '18:00')).state).toBe('closed')
    expect(stateAt(d, at('2026-08-22', '10:00')).state).toBe('closed')
  })

  it('does not mistake CurrentGroupHours "Default" for an override', () => {
    expect(departmentHours(live)[0].forced).toBeUndefined()
  })

  it('observes a dated holiday only in its own year', () => {
    const d = departmentHours(live)[0]
    expect(stateAt(d, at('2026-03-17', '10:00')).state).toBe('holiday')
    // The 2022 Christmas entry is pinned to 2022 and must not fire every year.
    expect(stateAt(d, at('2026-12-24', '10:00')).state).not.toBe('holiday')
  })
})
