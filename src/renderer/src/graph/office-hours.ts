// When a department is open, and what that means for a call arriving now.
//
// 3CX hangs opening hours off the department (a Group): a weekly `Hours`
// schedule, an optional `BreakTime` schedule carved out of it, a timezone, its
// own holidays, and a manual override that can force the whole thing open or
// shut regardless of the clock. Inbound rules then branch on the answer —
// office hours here, out-of-hours there, holidays somewhere else — so "which
// link is live right now" is really "what state is this department in".
//
// Everything here is pure and takes the moment to judge as an argument, so the
// same code answers "now" and "what about 3am on Sunday" without knowing which
// it was asked.

import { isRealDepartment } from './model'

/** 3CX's DayOfWeek: Sunday is 0, matching JavaScript's getDay(). */
export const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday'
]

/** One stretch of one weekday, in minutes from midnight. */
export interface HourPeriod {
  day: number
  /** Inclusive. */
  startMin: number
  /** Exclusive. A period that runs past midnight is split, so this never wraps. */
  stopMin: number
}

export interface OfficeSchedule {
  /** 3CX's RuleHoursType, e.g. `OfficeHours`, `AllHours`, `Never`. */
  type: string
  ignoreHolidays: boolean
  periods: HourPeriod[]
}

export interface Holiday {
  name: string
  /** Month/day the holiday opens and closes on, 1-based. */
  month: number
  day: number
  monthEnd: number
  dayEnd: number
  /** 0 when the holiday repeats every year. */
  year: number
  yearEnd: number
  recurring: boolean
}

export interface DepartmentHours {
  /** The department bucket this belongs to (its name). */
  bucket: string
  timeZoneId?: string
  hours?: OfficeSchedule
  breakTime?: OfficeSchedule
  /**
   * Whether the Group record carried an `Hours` field at all. A department with
   * an empty schedule and one the server never sent look identical downstream,
   * and they mean opposite things: the first is configured to follow the
   * system-wide hours, the second is us failing to ask for the data. 3CX
   * projects complex properties away unless they are asked for by name — the
   * same trap `ScriptCode` fell into — so the difference is worth carrying.
   */
  hoursPresent: boolean
  holidays: Holiday[]
  /** 3CX's CurrentGroupHours: a manual override in force right now. */
  forced?: string
}

export type HoursState = 'open' | 'closed' | 'break' | 'holiday' | 'unknown'

/** `"09:00:00"` / `"9:00"` / `"09:00:00.0000000"` / `"PT9H30M"` → minutes from
 *  midnight, or null. Edm.TimeOfDay carries seven fractional digits over the
 *  wire, so the fraction has to be tolerated rather than rejected. */
export function toMinutes(value: unknown): number | null {
  if (value == null) return null
  const s = String(value).trim()
  if (!s) return null
  // ISO 8601 duration, which is what Edm.Duration serialises to.
  const iso = /^P?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(s)
  if (iso && (iso[1] || iso[2] || iso[3])) {
    return Number(iso[1] ?? 0) * 60 + Number(iso[2] ?? 0)
  }
  const clock = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(s)
  if (clock) {
    const h = Number(clock[1])
    const m = Number(clock[2])
    if (h > 23 || m > 59) return null
    return h * 60 + m
  }
  return null
}

/** Minutes from midnight → `09:00`. */
export function fromMinutes(min: number): string {
  const h = Math.floor(min / 60) % 24
  const m = min % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

const str = (v: unknown): string => (v == null ? '' : String(v)).trim()

/** 3CX sends DayOfWeek as either the name or the number. */
function toDay(value: unknown): number | null {
  if (typeof value === 'number' && value >= 0 && value <= 6) return value
  const s = str(value)
  if (/^\d$/.test(s)) return Number(s)
  const i = DAY_NAMES.findIndex((d) => d.toLowerCase() === s.toLowerCase())
  return i >= 0 ? i : null
}

/** Read a 3CX `Schedule` complex value. Returns undefined when there isn't one,
 *  which is a real answer: the department follows the system-wide hours. */
export function parseSchedule(value: unknown): OfficeSchedule | undefined {
  if (!isObj(value)) return undefined
  const periods: HourPeriod[] = []
  const raw = Array.isArray(value['Periods']) ? (value['Periods'] as unknown[]) : []
  for (const p of raw) {
    if (!isObj(p)) continue
    const day = toDay(p['DayOfWeek'])
    const startMin = toMinutes(p['Start'])
    const stopMin = toMinutes(p['Stop'])
    if (day == null || startMin == null || stopMin == null) continue
    if (stopMin > startMin) {
      periods.push({ day, startMin, stopMin })
    } else if (stopMin < startMin) {
      // Runs past midnight: keep it as two same-week stretches rather than one
      // that wraps, so every comparison below stays a simple range test.
      periods.push({ day, startMin, stopMin: 24 * 60 })
      periods.push({ day: (day + 1) % 7, startMin: 0, stopMin })
    }
  }
  periods.sort((a, b) => a.day - b.day || a.startMin - b.startMin)
  return {
    type: str(value['Type']) || 'Unknown',
    ignoreHolidays: value['IgnoreHolidays'] === true,
    periods
  }
}

/** Read one 3CX `Holiday` record. */
export function parseHoliday(value: unknown): Holiday | null {
  if (!isObj(value)) return null
  const month = Number(value['Month'] ?? 0)
  const day = Number(value['Day'] ?? 0)
  if (!month || !day) return null
  const year = Number(value['Year'] ?? 0)
  return {
    name: str(value['Name']) || 'Holiday',
    month,
    day,
    monthEnd: Number(value['MonthEnd'] ?? 0) || month,
    dayEnd: Number(value['DayEnd'] ?? 0) || day,
    year,
    yearEnd: Number(value['YearEnd'] ?? 0) || year,
    recurring: value['IsRecurrent'] === true || !year
  }
}

/** Is `at` inside this holiday? A recurring holiday ignores the year. */
export function inHoliday(h: Holiday, at: Date): boolean {
  const y = at.getFullYear()
  const startYear = h.recurring ? y : h.year
  const endYear = h.recurring ? y : h.yearEnd || h.year
  const from = new Date(startYear, h.month - 1, h.day, 0, 0, 0, 0)
  const to = new Date(endYear, h.monthEnd - 1, h.dayEnd, 23, 59, 59, 999)
  // A recurring holiday spanning New Year (e.g. 30 Dec – 2 Jan) ends next year.
  if (h.recurring && to < from) to.setFullYear(endYear + 1)
  return at >= from && at <= to
}

/** Does any period cover this moment? */
function covers(schedule: OfficeSchedule | undefined, at: Date): boolean {
  if (!schedule) return false
  const day = at.getDay()
  const min = at.getHours() * 60 + at.getMinutes()
  return schedule.periods.some((p) => p.day === day && min >= p.startMin && min < p.stopMin)
}

/**
 * What state a department is in at `at`, and why.
 *
 * Order matters and mirrors 3CX's own: a manual override beats everything, then
 * a holiday (unless the schedule is set to ignore them), then break time carved
 * out of the working day, then the weekly hours themselves.
 */
export function stateAt(dept: DepartmentHours, at: Date): { state: HoursState; why: string } {
  // `CurrentGroupHours` is "Default" on a department with no override in force,
  // which is the overwhelmingly common case — it is the absence of an override,
  // not one of its values.
  const forced = (dept.forced ?? '').toLowerCase()
  if (forced.includes('forceopen')) return { state: 'open', why: 'Forced open by an override' }
  if (forced.includes('forceclosed'))
    return { state: 'closed', why: 'Forced closed by an override' }
  if (forced.includes('forcebreak'))
    return { state: 'break', why: 'Forced to break by an override' }
  if (forced.includes('forceholiday'))
    return { state: 'holiday', why: 'Forced to holiday by an override' }

  // `AllHours` and `Never` are answers in their own right, and both carry no
  // periods — an empty period list alone does not mean "not configured".
  const type = (dept.hours?.type ?? '').toLowerCase()
  const always = type === 'allhours'
  const never = type === 'never'

  if (!dept.hours || (!always && !never && !dept.hours.periods.length)) {
    // Not "closed": either the department follows the system-wide hours, or we
    // never received its schedule. Which of those it is matters to whoever is
    // reading, so say so.
    return {
      state: 'unknown',
      why: dept.hoursPresent
        ? 'No hours set on this department — it follows the system-wide schedule'
        : 'The system returned no schedule for this department'
    }
  }

  if (!dept.hours.ignoreHolidays) {
    const hit = dept.holidays.find((h) => inHoliday(h, at))
    if (hit) return { state: 'holiday', why: hit.name }
  }

  if (never) return { state: 'closed', why: 'Never open' }
  if (covers(dept.breakTime, at)) return { state: 'break', why: 'Break time' }
  if (always) return { state: 'open', why: 'Open at all hours' }
  if (covers(dept.hours, at)) return { state: 'open', why: 'Within office hours' }
  return { state: 'closed', why: 'Outside office hours' }
}

/** The week as seven rows, for showing a department's schedule at a glance. */
export function weekView(
  schedule: OfficeSchedule | undefined
): Array<{ day: number; name: string; periods: HourPeriod[] }> {
  return DAY_NAMES.map((name, day) => ({
    day,
    name,
    periods: (schedule?.periods ?? []).filter((p) => p.day === day)
  }))
}

/** `09:00–17:30, 18:30–20:00`, or `Closed`. */
export function describeDay(periods: HourPeriod[]): string {
  if (!periods.length) return 'Closed'
  // A stretch reaching midnight reads better as 24:00 than as 00:00.
  return periods
    .map(
      (p) => `${fromMinutes(p.startMin)}–${p.stopMin === 1440 ? '24:00' : fromMinutes(p.stopMin)}`
    )
    .join(', ')
}

/** 3CX reports no override in force as `Default`; treat it as the absence it is
 *  rather than announcing "Override in force: Default" on every department. */
function overrideOf(value: unknown): string | undefined {
  const s = str(value)
  return !s || /^(default|none|unknown)$/i.test(s) ? undefined : s
}

/** Pull every department's hours out of the raw Groups collection. */
export function departmentHours(groups: unknown[]): DepartmentHours[] {
  const out: DepartmentHours[] = []
  for (const raw of groups) {
    if (!isObj(raw)) continue
    const bucket = str(raw['Name'])
    if (!isRealDepartment(bucket)) continue
    const holidays = (Array.isArray(raw['OfficeHolidays']) ? raw['OfficeHolidays'] : [])
      .map(parseHoliday)
      .filter((h): h is Holiday => !!h)
    out.push({
      bucket,
      timeZoneId: str(raw['TimeZoneId']) || undefined,
      hoursPresent: raw['Hours'] != null,
      hours: parseSchedule(raw['Hours']),
      breakTime: parseSchedule(raw['BreakTime']),
      holidays,
      forced: overrideOf(raw['CurrentGroupHours'])
    })
  }
  return out.sort((a, b) => a.bucket.localeCompare(b.bucket))
}
