import type { Repeat, Scope, Times } from './api'
import { wallTime, zonedTime } from './zones'

// Repeat rules: Google's RRULE and Outlook's Pattern + Range, both ways, and the date math for "This and following" and
// "All events". Dates are YYYY-MM-DD; the math runs in UTC on them, so it has no DST.

// The first event of a series, or of a new one. start: UTC ms (UTC midnight of the date for all-day). zone: IANA, for
// timed series.
export interface First {
  start: number
  allDay: boolean
  zone: string
}

// Like Google's Custom dialog. main checks them; the dialog says them.
export const MAX_INTERVAL = 99
export const MAX_COUNT = 730

const DAY = 86_400_000
const CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
const NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const INDEX = ['First', 'Second', 'Third', 'Fourth']

const ms = (date: string): number => Date.parse(date + 'T00:00:00Z')
const iso = (t: number): string => new Date(t).toISOString().slice(0, 10)
export const addDate = (date: string, days: number): string => iso(ms(date) + days * DAY)
const daysFrom = (a: string, b: string): number => Math.round((ms(b) - ms(a)) / DAY)
export const weekday = (date: string): number => new Date(ms(date)).getUTCDay()
// 1 for the first such weekday of its month, up to 5.
export const nth = (date: string): number => Math.ceil(Number(date.slice(8)) / 7)
export const isLast = (date: string): boolean => addDate(date, 7).slice(5, 7) !== date.slice(5, 7)
// 20270302T235959Z
const stamp = (t: number): string => new Date(t).toISOString().replace(/[-:]|\.\d{3}/g, '')

// The wall date and time of a start in the zone. All-day: its date, 00:00.
export function dayOf(
  t: { start: number; allDay: boolean },
  zone: string
): { date: string; time: string } {
  return t.allDay ? { date: iso(t.start), time: '00:00' } : wallTime(t.start, zone)
}

// The rule can start on this date: a weekly rule has its weekday, a monthly one its nth (first to fourth) or last
// weekday, and the end is not before it.
export function fitsDate(r: Repeat, date: string): boolean {
  if (r.until !== null && r.until < date) return false
  if (r.freq === 'weekly') return r.days.includes(weekday(date))
  if (r.freq === 'monthly' && r.monthly === 'weekday') return nth(date) <= 4
  if (r.freq === 'monthly' && r.monthly === 'last') return isLast(date)
  return true
}

// A monthly or yearly rule made for date a means the same days as one made for b ("Monthly on the second Tuesday" made
// on 8 Dec is not the series' rule if the series starts on the first Tuesday).
function sameAnchor(r: Repeat, a: string, b: string): boolean {
  if (r.freq === 'yearly') return a.slice(5) === b.slice(5)
  if (r.freq !== 'monthly') return true
  if (r.monthly === 'day') return a.slice(8) === b.slice(8)
  return weekday(a) === weekday(b) && (r.monthly === 'last' || nth(a) === nth(b))
}

// The rule of a series that now starts on `to` instead of `from`. A one-day weekly rule takes the new weekday; monthly
// rules take the new date's nth or last weekday. null: a weekly rule with more days (which one moves is not clear), or an
// end before the new start.
export function moveRepeat(r: Repeat, from: string, to: string): Repeat | null {
  if (from === to) return r
  let moved = r
  if (r.freq === 'weekly') {
    if (r.days.length !== 1) return null
    moved = { ...r, days: [weekday(to)] }
  }
  if (r.freq === 'monthly' && r.monthly !== 'day') {
    moved = {
      ...r,
      monthly: isLast(to) && (r.monthly === 'last' || nth(to) > 4) ? 'last' : 'weekday'
    }
  }
  return fitsDate(moved, to) ? moved : null
}

// Two rules mean the same events. Field by field, so the order of the keys does not matter.
export const sameRepeat = (a: Repeat | null, b: Repeat | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.freq === b.freq &&
    a.interval === b.interval &&
    a.days.join() === b.days.join() &&
    a.monthly === b.monthly &&
    a.until === b.until &&
    a.count === b.count)

// The scopes Google offers for a change to one event of the user's own series (checked live).
// from, to: the event's date before and after the change, in the series' zone. rule: a new rule. A rule the app cannot
// read (repeat null) is never split: its COUNT cannot be counted. A new rule never goes to "This event" alone.
// split false: a change cannot split this series (Outlook: its deleted events would come back). A delete can
// still end it.
export function scopeChoices(o: {
  repeat: Repeat | null
  firstDate: string
  from: string
  to: string
  rule?: Repeat
  ownOnly?: boolean
  split?: boolean
}): Scope[] {
  const first = o.from === o.firstDate
  const split = o.split !== false && o.repeat !== null
  // Only the user's own fields (reminders, colors): never a split, which would invite every guest again.
  if (o.ownOnly) return ['event', 'series']
  if (o.rule) {
    if (first) return fitsDate(o.rule, o.to) ? ['series'] : []
    const list: Scope[] = []
    if (split && fitsDate(o.rule, o.to)) list.push('following')
    // All events keep the first date, so a monthly or yearly rule must fit it too.
    if (o.from === o.to && fitsDate(o.rule, o.firstDate) && sameAnchor(o.rule, o.to, o.firstDate))
      list.push('series')
    return list
  }
  if (o.from !== o.to) {
    if (o.repeat === null || !moveRepeat(o.repeat, o.from, o.to) || (!first && !split))
      return ['event']
    return ['event', first ? 'series' : 'following']
  }
  return first || !split ? ['event', 'series'] : ['event', 'following', 'series']
}

// The UNTIL value of a last day: the date for all-day, else the last second of that day in the zone, in UTC.
function untilValue(date: string, f: First): string {
  return f.allDay
    ? date.replaceAll('-', '')
    : stamp(zonedTime(addDate(date, 1), '00:00', f.zone) - 1000)
}

// Google's form, e.g. RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=6. No WKST: Google's default.
export function toRrule(r: Repeat, f: First): string {
  const date = dayOf(f, f.zone).date
  const parts = [`FREQ=${r.freq.toUpperCase()}`]
  if (r.interval > 1) parts.push(`INTERVAL=${r.interval}`)
  if (r.freq === 'weekly')
    parts.push(
      `BYDAY=${[...r.days]
        .sort((a, b) => a - b)
        .map((d) => CODES[d])
        .join(',')}`
    )
  if (r.freq === 'monthly') {
    parts.push(
      r.monthly === 'day'
        ? `BYMONTHDAY=${Number(date.slice(8))}`
        : `BYDAY=${r.monthly === 'last' ? -1 : nth(date)}${CODES[weekday(date)]}`
    )
  }
  if (r.count !== null) parts.push(`COUNT=${r.count}`)
  if (r.until !== null) parts.push(`UNTIL=${untilValue(r.until, f)}`)
  return 'RRULE:' + parts.join(';')
}

// An iCalendar date or date-time: 20261222 (UTC midnight, the all-day form), 20261222T100000Z (UTC), or
// 20261222T100000 (wall time in the zone).
function icalTime(value: string, zone: string): number {
  const date = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
  if (value.length === 8) return ms(date)
  const time = `${value.slice(9, 11)}:${value.slice(11, 13)}`
  const seconds = Number(value.slice(13, 15)) * 1000
  return value.endsWith('Z')
    ? Date.parse(`${date}T${time}Z`) + seconds
    : zonedTime(date, time, zone) + seconds
}

// The rule's own parts, e.g. WKST, by name.
export function ruleParts(lines: string[]): Map<string, string> {
  const rule = lines.find((l) => l.startsWith('RRULE:')) ?? 'RRULE:'
  return new Map(
    rule
      .slice(6)
      .split(';')
      .map((p) => p.split('=') as [string, string])
  )
}

const KNOWN = ['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'COUNT', 'UNTIL', 'WKST']

// Reads a Google series' recurrence. EXDATE lines are deleted events, so they are fine. null: a rule the app cannot show
// or write back (EXRULE, RDATE, BYSETPOS, two rules, days that do not match the first date).
export function fromRrule(lines: string[], f: First): Repeat | null {
  if (
    lines.filter((l) => l.startsWith('RRULE:')).length !== 1 ||
    lines.some((l) => !/^(RRULE:|EXDATE[;:])/.test(l))
  )
    return null
  const parts = ruleParts(lines)
  if ([...parts.keys()].some((k) => !KNOWN.includes(k))) return null
  const freq = parts.get('FREQ')?.toLowerCase()
  if (freq !== 'daily' && freq !== 'weekly' && freq !== 'monthly' && freq !== 'yearly') return null
  const { date, time } = dayOf(f, f.zone)
  const interval = Number(parts.get('INTERVAL') ?? 1)
  const count = parts.has('COUNT') ? Number(parts.get('COUNT')) : null
  const end = parts.get('UNTIL')
  let until: string | null = null
  if (end !== undefined) {
    // The last day with an event: a timed event on UNTIL's own day counts only if it starts by then.
    const last = dayOf(
      { start: icalTime(end, f.zone), allDay: f.allDay || end.length === 8 },
      f.zone
    )
    until = f.allDay || end.length === 8 || last.time >= time ? last.date : addDate(last.date, -1)
  }
  if (
    !Number.isSafeInteger(interval) ||
    interval < 1 ||
    (count !== null && !(Number.isSafeInteger(count) && count >= 1))
  )
    return null
  if (count !== null && until !== null) return null
  const byday = parts.get('BYDAY')
  const monthday = parts.get('BYMONTHDAY')
  const month = parts.get('BYMONTH')
  if (month !== undefined && (freq !== 'yearly' || Number(month) !== Number(date.slice(5, 7))))
    return null
  if (
    monthday !== undefined &&
    ((freq !== 'monthly' && freq !== 'yearly') ||
      byday ||
      Number(monthday) !== Number(date.slice(8)))
  )
    return null
  let days: number[] = []
  let monthly: Repeat['monthly'] = 'day'
  if (byday !== undefined) {
    if (freq === 'weekly') {
      days = byday.split(',').map((code) => CODES.indexOf(code))
      if (days.includes(-1)) return null
    } else if (freq === 'monthly') {
      const m = byday.match(/^(-1|[1-4])([A-Z]{2})$/)
      if (!m || CODES.indexOf(m[2]) !== weekday(date)) return null
      monthly = m[1] === '-1' ? 'last' : 'weekday'
      if (monthly === 'weekday' && Number(m[1]) !== nth(date)) return null
    } else {
      return null
    }
  } else if (freq === 'weekly') {
    days = [weekday(date)]
  }
  const r: Repeat = {
    freq,
    interval,
    days: [...new Set(days)].sort((a, b) => a - b),
    monthly,
    until,
    count
  }
  return fitsDate(r, date) ? r : null
}

// The deleted events a series lists, as starts (all-day: UTC midnight). EXDATE;TZID=Europe/Lisbon:20261222T100000,...
export function exdates(lines: string[], zone: string): number[] {
  return lines
    .filter((l) => /^EXDATE[;:]/.test(l))
    .flatMap((l) => {
      const head = l.slice(0, l.indexOf(':'))
      const tz = head.match(/TZID=([^;:]+)/)?.[1] ?? zone
      return l
        .slice(l.indexOf(':') + 1)
        .split(',')
        .map((v) => icalTime(v, tz))
    })
}

// One EXDATE line in the form of the series' start: dates for all-day, UTC times else.
export function exdateLine(starts: number[], allDay: boolean): string {
  return allDay
    ? `EXDATE;VALUE=DATE:${starts.map((t) => iso(t).replaceAll('-', '')).join(',')}`
    : `EXDATE:${starts.map(stamp).join(',')}`
}

// Ends a series before the event whose original start is cut: UNTIL is the end of the day before that event's day in
// the series' zone (all-day: that date), like Google web's own split. It takes the place of COUNT or UNTIL, so Google
// says "until <day before>", and a later move to an earlier time cannot bring the cut day back. EXDATE and other
// lines stay.
export function cutRrule(lines: string[], cut: number, allDay: boolean, zone: string): string[] {
  const f = { start: cut, allDay, zone }
  const until = untilValue(addDate(dayOf(f, zone).date, -1), f)
  // The parts after "RRULE:", so a COUNT that comes first goes too.
  const parts = (l: string): string[] =>
    l
      .slice(6)
      .split(';')
      .filter((p) => !/^(COUNT|UNTIL)=/.test(p))
  return lines.map((l) =>
    l.startsWith('RRULE:') ? `RRULE:${[...parts(l), `UNTIL=${until}`].join(';')}` : l
  )
}

// The rule has an event on this date (from its first date on, without its end).
function occurs(r: Repeat, first: string, date: string, weekStart: number): boolean {
  const [y0, m0] = [Number(first.slice(0, 4)), Number(first.slice(5, 7))]
  const months = (Number(date.slice(0, 4)) - y0) * 12 + Number(date.slice(5, 7)) - m0
  const sameDay = date.slice(8) === first.slice(8)
  if (r.freq === 'daily') return daysFrom(first, date) % r.interval === 0
  if (r.freq === 'weekly') {
    const weekOf = (d: string): string => addDate(d, -((weekday(d) - weekStart + 7) % 7))
    return (
      r.days.includes(weekday(date)) &&
      (daysFrom(weekOf(first), weekOf(date)) / 7) % r.interval === 0
    )
  }
  if (r.freq === 'yearly') return months % (12 * r.interval) === 0 && sameDay
  if (months % r.interval !== 0) return false
  if (r.monthly === 'day') return sameDay
  return (
    weekday(date) === weekday(first) &&
    (r.monthly === 'last' ? isLast(date) : nth(date) === nth(first))
  )
}

// The rule, from f's first date on, makes an event on the day of start t in f's zone. Its end does not count.
export function makesDay(r: Repeat, f: First, t: number, weekStart = 1): boolean {
  const first = dayOf(f, f.zone).date
  const date = dayOf({ start: t, allDay: f.allDay }, f.zone).date
  return date >= first && occurs(r, first, date, weekStart)
}

// How many events of the rule start before the date. COUNT counts deleted events too (RFC 5545), so this expands the
// rule itself instead of reading lists of events. weekStart: the rule's week start (Google WKST, Monday by default;
// Outlook FirstDayOfWeek). It matters for weekly rules with an interval.
export function countBefore(r: Repeat, f: First, before: string, weekStart = 1): number {
  const first = dayOf(f, f.zone).date
  let n = 0
  for (
    let date = first;
    date < before && (r.count === null || n < r.count);
    date = addDate(date, 1)
  ) {
    if (occurs(r, first, date, weekStart)) n++
  }
  return n
}

// The nth (1 to 4) weekday of a month (YYYY-MM), or its last one when n is null.
function monthWeekday(month: string, day: number, n: number | null): string {
  const first = addDate(`${month}-01`, (day - weekday(`${month}-01`) + 7) % 7)
  if (n !== null) return addDate(first, 7 * (n - 1))
  return addDate(first, 28).startsWith(month) ? addDate(first, 28) : addDate(first, 21)
}

// Moves a start by the change from `from` to `to`: the same change of wall date and time, read in from's zone and
// written in to's (all-day: whole days). For deleted events after a split, so they stay deleted at the new times.
// rule: the new rule. A monthly rule on a weekday moves each date to the new rule's day of its own month, not by a
// number of days: the first Tuesday plus one day is not always the first Wednesday.
export function shiftStart(t: number, from: First, to: First, rule?: Repeat | null): number {
  const wall = (x: { start: number; allDay: boolean }, zone: string): number => {
    const d = dayOf(x, zone)
    return Date.parse(`${d.date}T${d.time}Z`)
  }
  let shift = wall(to, to.zone) - wall(from, from.zone)
  if (rule?.freq === 'monthly' && rule.monthly !== 'day') {
    const date = dayOf({ start: t, allDay: from.allDay }, from.zone).date
    const next = dayOf(to, to.zone).date
    const day = monthWeekday(
      date.slice(0, 7),
      weekday(next),
      rule.monthly === 'last' ? null : nth(next)
    )
    shift += ms(day) - ms(date) - (ms(next) - ms(dayOf(from, from.zone).date))
  }
  const moved = new Date(wall({ start: t, allDay: from.allDay }, from.zone) + shift).toISOString()
  return to.allDay
    ? ms(moved.slice(0, 10))
    : zonedTime(moved.slice(0, 10), moved.slice(11, 16), to.zone)
}

// The series' first times after an "All events" change of one event's times. The first date moves by the event's change
// of date (only the first event may change its date), and takes the event's new wall time (in toZone) and length.
// from: the event's date before the change, in the series' zone.
export function seriesTimes(
  master: Times,
  zone: string,
  from: string,
  after: Times,
  toZone = zone
): Times {
  const to = dayOf(after, toZone).date
  const date = addDate(dayOf(master, zone).date, daysFrom(from, to))
  if (after.allDay) {
    const end = addDate(date, daysFrom(after.startDate!, after.endDate!))
    return { allDay: true, startDate: date, endDate: end, start: ms(date), end: ms(end) }
  }
  const start = zonedTime(date, dayOf(after, toZone).time, toZone)
  return {
    allDay: false,
    startDate: null,
    endDate: null,
    start,
    end: start + after.end - after.start
  }
}

// Outlook's form. Every field Outlook checks gets a valid value, so each type sends only its own fields. Dates are wall
// dates in the series' zone; windows: that zone's Windows name.
export function toPattern(
  r: Repeat,
  f: First,
  windows: string
): { Pattern: object; Range: object } {
  const date = dayOf(f, f.zone).date
  const Interval = r.interval
  const DayOfMonth = Number(date.slice(8))
  const Pattern =
    r.freq === 'daily'
      ? { Type: 'Daily', Interval }
      : r.freq === 'weekly'
        ? {
            Type: 'Weekly',
            Interval,
            DaysOfWeek: [...r.days].sort((a, b) => a - b).map((d) => NAMES[d]),
            FirstDayOfWeek: 'Sunday'
          }
        : r.freq === 'yearly'
          ? { Type: 'AbsoluteYearly', Interval, Month: Number(date.slice(5, 7)), DayOfMonth }
          : r.monthly === 'day'
            ? { Type: 'AbsoluteMonthly', Interval, DayOfMonth }
            : {
                Type: 'RelativeMonthly',
                Interval,
                DaysOfWeek: [NAMES[weekday(date)]],
                Index: r.monthly === 'last' ? 'Last' : INDEX[nth(date) - 1]
              }
  const end =
    r.count !== null
      ? { Type: 'Numbered', NumberOfOccurrences: r.count }
      : r.until !== null
        ? { Type: 'EndDate', EndDate: r.until }
        : { Type: 'NoEnd' }
  return { Pattern, Range: { ...end, StartDate: date, RecurrenceTimeZone: windows } }
}

// An Outlook master's Recurrence, as the sync stores it (JSON text).
export interface OutlookRecurrence {
  Pattern?: {
    Type?: string
    Interval?: number
    DaysOfWeek?: string[]
    DayOfMonth?: number
    Month?: number
    Index?: string
    FirstDayOfWeek?: string
  }
  Range?: {
    Type?: string
    StartDate?: string
    EndDate?: string
    NumberOfOccurrences?: number
    RecurrenceTimeZone?: string
  }
}

const TYPES: Record<string, Repeat['freq']> = {
  Daily: 'daily',
  Weekly: 'weekly',
  AbsoluteMonthly: 'monthly',
  RelativeMonthly: 'monthly',
  AbsoluteYearly: 'yearly'
}

// Reads an Outlook series. null: a rule the app cannot show or write back (RelativeYearly, days that do not match).
export function fromPattern(recurrence: OutlookRecurrence, f: First): Repeat | null {
  const { Pattern: p, Range: range } = recurrence
  const freq = TYPES[p?.Type ?? '']
  if (!p || !freq || !range) return null
  const date = dayOf(f, f.zone).date
  const days = freq === 'weekly' ? (p.DaysOfWeek ?? []).map((d) => NAMES.indexOf(d)) : []
  if (days.includes(-1)) return null
  let monthly: Repeat['monthly'] = 'day'
  if (p.Type === 'RelativeMonthly') {
    if (p.DaysOfWeek?.length !== 1 || NAMES.indexOf(p.DaysOfWeek[0]) !== weekday(date)) return null
    if (p.Index === 'Last') monthly = 'last'
    else if (INDEX.indexOf(p.Index ?? '') + 1 === nth(date)) monthly = 'weekday'
    else return null
  }
  if (
    (p.Type === 'AbsoluteMonthly' || p.Type === 'AbsoluteYearly') &&
    p.DayOfMonth !== Number(date.slice(8))
  )
    return null
  if (p.Type === 'AbsoluteYearly' && p.Month !== Number(date.slice(5, 7))) return null
  const until = range.Type === 'EndDate' ? (range.EndDate?.slice(0, 10) ?? null) : null
  const count = range.Type === 'Numbered' ? (range.NumberOfOccurrences ?? null) : null
  if (range.Type !== 'NoEnd' && until === null && count === null) return null
  const r: Repeat = {
    freq,
    interval: p.Interval ?? 1,
    days: [...new Set(days)].sort((a, b) => a - b),
    monthly,
    until,
    count
  }
  return fitsDate(r, date) ? r : null
}

// Ends an Outlook series before the event whose original start is cut. Outlook needs the full Pattern, and reads EndDate
// as a date in the series' zone, so it is the day before that event's date there (not in UTC or this PC's zone).
// All-day: the cut's UTC date. This assumes Outlook sends an all-day OriginalStart as UTC midnight of its date, like its
// Start under outlook.timezone="UTC" (map.ts). Not checked live; repeat.test.ts pins it.
export function cutPattern(
  recurrence: OutlookRecurrence,
  cut: number,
  allDay: boolean,
  zone: string
): OutlookRecurrence {
  const { StartDate, RecurrenceTimeZone } = recurrence.Range ?? {}
  const EndDate = addDate(dayOf({ start: cut, allDay }, zone).date, -1)
  return {
    Pattern: recurrence.Pattern,
    Range: { Type: 'EndDate', StartDate, RecurrenceTimeZone, EndDate }
  }
}

// Outlook's FirstDayOfWeek as a number, for countBefore.
export const firstDay = (name?: string): number => Math.max(0, NAMES.indexOf(name ?? 'Sunday'))

// Google's WKST (MO, SU...) as a number, for countBefore. Monday when the rule has none.
export const weekStartOf = (code?: string): number => Math.max(0, CODES.indexOf(code ?? 'MO'))
