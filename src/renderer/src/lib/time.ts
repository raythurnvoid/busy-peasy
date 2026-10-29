import type { Calendar, Times } from '../../../shared/api'
import { allDayParts } from '../../../shared/reminders'
import { COUNTRIES, wallTime, zoneOffset, zonedTime } from '../../../shared/zones'

// Moved to shared (main needs them too); the renderer keeps importing them from here.
export { wallTime, zoneOffset, zonedTime }

// Local-time date helpers. They build dates from parts, so they stay right across DST changes.

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
}

// weekStart: 0 = Sunday ... 6 = Saturday
export function startOfWeek(date: Date, weekStart: number): Date {
  const day = startOfDay(date)
  return addDays(day, -((day.getDay() - weekStart + 7) % 7))
}

export function addMonths(date: Date, months: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + months, 1)
}

// Start of the 6-week month grid: the week start before the 1st.
export function monthGridStart(date: Date, weekStart: number): Date {
  return startOfWeek(new Date(date.getFullYear(), date.getMonth(), 1), weekStart)
}

// The days shown from start. Without weekends, Saturday and Sunday are left out, like Google Calendar.
export function shownDays(start: Date, count: number, weekends: boolean): Date[] {
  return Array.from({ length: count }, (_, i) => addDays(start, i)).filter((d) => weekends || (d.getDay() !== 0 && d.getDay() !== 6))
}

// Local date as YYYY-MM-DD, the form all-day events and <input type="date"> use.
export function dateKey(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function fromDateKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}

// A typed date with its numbers in the order format writes them ("20/10/2026" in en-GB), any separators.
// null: not a real date, or a year outside 1900-2999 (a short year would turn into 19xx, a huge one breaks Date).
export function parseDate(text: string, format: Intl.DateTimeFormat): Date | null {
  const numbers = text.match(/\d+/g)
  if (numbers?.length !== 3) return null
  const order = format.formatToParts(0).map((part) => part.type).filter((type) => type === 'day' || type === 'month' || type === 'year')
  const [d, m, y] = (['day', 'month', 'year'] as const).map((type) => Number(numbers[order.indexOf(type)]))
  const date = new Date(y, m - 1, d)
  // new Date moves 31/02 to 3 March, so the day and month must come back the same.
  return y >= 1900 && y <= 2999 && date.getMonth() === m - 1 && date.getDate() === d ? date : null
}

export function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

// Whole days from a to b (local midnights). Rounded: a day with a DST change is not 24 h long.
export function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000)
}

// Drags snap to 15 minutes, like Google Calendar.
const SNAP = 15

// The local time at a wall-clock minute of a day. Minutes past 1440 or below 0 roll into the next or previous day.
export function atMinute(day: Date, minutes: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes)
}

// A move snaps down, like Google: +12.5 min stays, -16.25 min goes up 30 min.
export const snapDelta = (raw: number): number => Math.floor(raw / SNAP) * SNAP

// Moves a timed event in wall-clock time, as the grid draws it, so 10:00 stays 10:00 across a DST night.
// The math uses this PC's zone, also for an event kept in another zone: there it can shift 1 h in its own zone.
// The event keeps its length, also when the start lands in the DST gap or in the hour that repeats.
export function moveTimes(event: Pick<Times, 'start' | 'end'>, days: number, minutes: number): Times {
  // No move keeps the exact moment, also in the hour that repeats when summer time ends.
  const d = new Date(event.start)
  const start = !days && !minutes ? event.start : new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, d.getHours(), d.getMinutes() + minutes, d.getSeconds()).getTime()
  return { start, end: start + event.end - event.start, allDay: false, startDate: null, endDate: null }
}

// A resize ends at the pointer, rounded up, and keeps at least 15 minutes.
export function resizeEnd(start: number, day: Date, pointerMinutes: number): number {
  return Math.max(atMinute(day, Math.ceil(pointerMinutes / SNAP) * SNAP).getTime(), start + SNAP * 60_000)
}

// A drag on empty grid: from the earlier point rounded down to the later one rounded up, at least 15 minutes.
export function createRange(day: Date, a: number, b: number): { start: Date; end: Date } {
  const low = Math.floor(Math.min(a, b) / SNAP) * SNAP
  const high = Math.max(Math.ceil(Math.max(a, b) / SNAP) * SNAP, low + SNAP)
  return { start: atMinute(day, low), end: atMinute(day, high) }
}

// The times of an all-day event on these dates (endDate exclusive). start and end are UTC midnight, as main checks.
export function allDayTimes(startDate: string, endDate: string): Times {
  const utc = (key: string): number => Date.parse(key + 'T00:00:00Z')
  return { allDay: true, startDate, endDate, start: utc(startDate), end: utc(endDate) }
}

// Moves an all-day event by whole days.
export function moveDates(event: Pick<Times, 'startDate' | 'endDate'>, days: number): Times {
  const shift = (key: string): string => dateKey(addDays(fromDateKey(key), days))
  return allDayTimes(shift(event.startDate!), shift(event.endDate!))
}

// First day of the week for the user's locale. Falls back to Monday.
export function localeWeekStart(): number {
  try {
    const locale = new Intl.Locale(navigator.language) as Intl.Locale & { getWeekInfo?: () => { firstDay: number } }
    const firstDay = locale.getWeekInfo?.().firstDay ?? 1 // 1 = Monday ... 7 = Sunday
    return firstDay % 7
  } catch {
    return 1
  }
}

// "October 2026", or "Oct – Nov 2026" when the range crosses months. Schedule can end in the same month a year later.
export function rangeTitle(start: Date, endInclusive: Date): string {
  if (start.getMonth() === endInclusive.getMonth() && start.getFullYear() === endInclusive.getFullYear()) {
    return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(start)
  }
  return new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' }).formatRange(start, endInclusive)
}

// The dates every visible calendar has synced, as local days with the same dates (to is exclusive), like all-day
// events. null: none synced yet.
export function syncedDates(calendars: Calendar[]): { from: Date; to: Date } | null {
  const synced = calendars.filter((c) => c.visible && c.windowStart !== null && c.windowEnd !== null)
  if (!synced.length) return null
  const day = (t: number): Date => fromDateKey(new Date(t).toISOString().slice(0, 10))
  return { from: day(Math.max(...synced.map((c) => c.windowStart!))), to: day(Math.min(...synced.map((c) => c.windowEnd!))) }
}

// This PC's zone, the app's main zone. Read each time: tests change TZ, and Windows can change it while the app runs.
export const pcZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone

// Modern names for old ids that V8 still uses. Only shown; the stored and sent id stays.
const CITIES: Record<string, string> = { Calcutta: 'Kolkata', Kiev: 'Kyiv', Katmandu: 'Kathmandu', Saigon: 'Ho Chi Minh City', Rangoon: 'Yangon' }

const zoneName = (zone: string, at: number, timeZoneName: 'longOffset' | 'longGeneric' | 'long'): string =>
  new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName }).formatToParts(at).find((p) => p.type === 'timeZoneName')!.value

// "Asia/Katmandu" → "Kathmandu".
const cityOf = (zone: string): string => {
  const place = zone.split('/').pop()!.replaceAll('_', ' ')
  return CITIES[place] ?? place
}

// How many zones share each generic name, built at the first label (about 45 ms, 418 zones).
let nameCounts: Map<string, number> | undefined

// Google's form: "(GMT+01:00) Central European Time - Rome", with the offset at that moment. Like Google, no city when
// no other zone has that name ("(GMT+09:00) Japan Standard Time"). city false: an Outlook zone, which keeps only a
// Windows name, so a city would be the main city of that name (Berlin for a Rome meeting).
export function zoneLabel(zone: string, at: number, city = true): string {
  // UTC has no generic name (it would say "GMT+00:00") and no city.
  if (zone === 'UTC') return `(${zoneName(zone, at, 'longOffset')}) ${zoneName(zone, at, 'long')}`
  const generic = zoneName(zone, at, 'longGeneric')
  if (city && !nameCounts) {
    nameCounts = new Map()
    for (const z of Intl.supportedValuesOf('timeZone')) {
      const n = zoneName(z, at, 'longGeneric')
      nameCounts.set(n, (nameCounts.get(n) ?? 0) + 1)
    }
  }
  return `(${zoneName(zone, at, 'longOffset')}) ${generic}${city && nameCounts!.get(generic)! > 1 ? ` - ${cityOf(zone)}` : ''}`
}

// Every zone the picker offers, by offset then label, like Google's "Browse all time zones". search: lower-case text
// that typing matches (label, city, id, country); the city is there also when the label leaves it out. Offsets are the
// ones at that moment.
export function zoneList(at: number): { zone: string; label: string; city: string; country?: string; search: string }[] {
  const countries = new Intl.DisplayNames('en', { type: 'region' })
  return [...Intl.supportedValuesOf('timeZone'), 'UTC']
    .map((zone) => {
      const label = zoneLabel(zone, at)
      const city = cityOf(zone)
      const country = COUNTRIES[zone] && countries.of(COUNTRIES[zone])
      return { zone, label, city, country, offset: zoneOffset(at, zone), search: [label, city, zone.replaceAll('_', ' '), country].join(' ').toLowerCase() }
    })
    .sort((a, b) => a.offset - b.offset || a.label.localeCompare(b.label))
}

// The zones that match typed text. Like Google, a city or country equal to it comes first, then one that starts with it
// ("India" gives Kolkata, then Indianapolis, then Indian Ocean), in the offset order inside each group (sort is stable).
export function searchZones(zones: ReturnType<typeof zoneList>, text: string): ReturnType<typeof zoneList> {
  const words = text.trim().toLowerCase()
  const rank = (z: (typeof zones)[number]): number => {
    const names = [z.city, z.country].map((name) => name?.toLowerCase())
    return names.includes(words) ? 0 : names.some((name) => name?.startsWith(words)) ? 1 : 2
  }
  return zones.filter((z) => z.search.includes(words)).sort((a, b) => rank(a) - rank(b))
}

// "GMT+01" style label for the time gutter, at that moment: this PC's zone, or another one.
export function timeZoneLabel(date: Date, zone?: string): string {
  const offset = zone ? zoneOffset(date.getTime(), zone) : -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  const hours = String(Math.floor(abs / 60)).padStart(2, '0')
  const minutes = abs % 60 ? ':' + String(abs % 60).padStart(2, '0') : ''
  return `GMT${sign}${hours}${minutes}`
}

// Intl options for the 12h/24h setting. null keeps the language's own clock.
// hourCycle, not hour12: hour12 false can give "24:00" in some locales.
// 24h has a 2-digit hour, so format and formatRange both give "09:30", like Google Calendar.
function clockOptions(hour12: boolean | null): Intl.DateTimeFormatOptions {
  return hour12 === null ? {} : hour12 ? { hourCycle: 'h12' } : { hour: '2-digit', hourCycle: 'h23' }
}

// Event times, e.g. "09:30" or "9:30 am". locale: the system language, unless a test pins one.
export function timeFormat(hour12: boolean | null, locale?: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', ...clockOptions(hour12) })
}

// Time gutter labels, empty at midnight. 24h shows "13:00" like Google Calendar; the language default keeps today's "13".
export function hourLabels(hour12: boolean | null, locale?: string): string[] {
  const format = new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: hour12 === false ? '2-digit' : undefined,
    ...clockOptions(hour12)
  })
  return Array.from({ length: 24 }, (_, h) => (h === 0 ? '' : format.format(new Date(2000, 0, 1, h))))
}

// The labels of a second zone for the gutter: its wall time at each hour of the day in this PC's zone, '' at midnight.
// A zone a half hour off shows its minutes ("04:30"), so each label still sits on an hour line.
export function zoneHourLabels(day: Date, zone: string, hour12: boolean | null, locale?: string): string[] {
  const hour = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: hour12 === false ? '2-digit' : undefined, ...clockOptions(hour12), timeZone: zone })
  const minute = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', ...clockOptions(hour12), timeZone: zone })
  return Array.from({ length: 24 }, (_, h) => {
    const at = atMinute(day, h * 60).getTime()
    return h === 0 ? '' : (wallTime(at, zone).time.endsWith(':00') ? hour : minute).format(at)
  })
}

// The units a reminder time can be typed in, smallest first.
export const REMINDER_UNITS = [
  { label: 'minutes', minutes: 1 },
  { label: 'hours', minutes: 60 },
  { label: 'days', minutes: 1440 },
  { label: 'weeks', minutes: 10_080 }
]

// The biggest unit that fits the minutes exactly, like Google Calendar shows reminders.
export function reminderUnit(minutes: number): number {
  return REMINDER_UNITS.findLast((unit) => minutes > 0 && minutes % unit.minutes === 0)?.minutes ?? 1
}

// "10 minutes before", "1 day before", "at the start".
export function reminderText(minutes: number): string {
  if (minutes === 0) return 'at the start'
  const unit = reminderUnit(minutes)
  const label = REMINDER_UNITS.find((u) => u.minutes === unit)!.label
  const amount = minutes / unit
  return `${amount} ${amount === 1 ? label.slice(0, -1) : label} before`
}

// "The day before at 17:00", "2 weeks before at 09:00", "On the same day at 09:00", like Google. time: the app's clock.
export function allDayReminderText(minutes: number, time: Intl.DateTimeFormat): string {
  const { days, time: minute } = allDayParts(minutes)
  const at = time.format(new Date(2000, 0, 1, 0, minute))
  if (days === 0) return `On the same day at ${at}`
  if (days === 1) return `The day before at ${at}`
  // Like Google: 28 days reads "4 weeks before".
  if (days % 7 === 0) return `${days / 7} ${days === 7 ? 'week' : 'weeks'} before at ${at}`
  return `${days} days before at ${at}`
}
