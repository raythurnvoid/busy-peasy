import type { EventReminder } from './api'

const MIN = 60_000

// Google's limit (4 weeks). Reminders are never earlier.
export const MAX_REMINDER_MINUTES = 40_320
// All-day reminders "on the same day at 23:59" and earlier are below 0. Only this app keeps them.
export const MIN_ALL_DAY_MINUTES = -1439
// Local midnight can be up to 14 h away from UTC midnight, so all-day rows need this slack.
export const ALL_DAY_SLACK = 14 * 3600_000
// Minutes. 0: Google's rule (1 min before the start, then 5 min).
export const SNOOZE_CHOICES = [0, 5, 10, 15, 30, 60]

// One reminder per time, alarm wins. Earliest first.
export function mergeReminders(list: EventReminder[]): EventReminder[] {
  return list
    .filter((r, i) => list.findIndex((other) => other.minutes === r.minutes) === i)
    .map((r) => ({ minutes: r.minutes, alarm: list.some((other) => other.minutes === r.minutes && other.alarm) }))
    .sort((a, b) => b.minutes - a.minutes)
}

// An all-day reminder as Google shows it: days before the first day, and the time of day (minutes after midnight).
// 420 is "the day before at 17:00"; -540 is "on the same day at 09:00".
export function allDayParts(minutes: number): { days: number; time: number } {
  // max: ceil gives -0 for the same day.
  const days = Math.max(0, Math.ceil(minutes / 1440))
  return { days, time: days * 1440 - minutes }
}

// When an all-day reminder fires: counted back from local midnight of the date (YYYY-MM-DD) in wall time, so
// "1 week before at 17:00" stays 17:00 across a DST change.
export function allDayFireAt(date: string, minutes: number): number {
  const [y, m, d] = date.split('-').map(Number)
  const { days, time } = allDayParts(minutes)
  return new Date(y, m - 1, d - days, 0, time).getTime()
}

// True until 1 min before the start: a snooze then ends 1 min before the start (Google's rule). All-day events have no
// such time. The snooze and the reminder window both use this, so the label and the snooze agree.
export function beforeStart(now: number, r: { start: number; allDay: boolean }): boolean {
  return !r.allDay && now < r.start - MIN
}

// When a snooze ends. minutes: one of SNOOZE_CHOICES. last: when the reminder stops showing. next: the event's next
// reminder (null: none).
export function snoozeUntil(now: number, r: { start: number; last: number; next: number | null; allDay: boolean }, minutes: number): number {
  const early = beforeStart(now, r)
  const until = minutes === 0 ? (early ? r.start - MIN : now + 5 * MIN) : now + minutes * MIN
  // Never past the next reminder (it must ring) or the end. Before the start, never past 1 min before it, like Google.
  return Math.min(until, r.last, r.next ?? r.last, early ? r.start - MIN : r.last)
}
