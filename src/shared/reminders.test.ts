import { describe, expect, it } from 'vitest'
import { allDayFireAt, allDayParts, snoozeUntil } from './reminders'

// Set before any Date is made. Berlin has a DST change on 2026-10-25.
process.env.TZ = 'Europe/Berlin'

const MIN = 60_000

describe('allDayFireAt', () => {
  it('counts back from local midnight in wall time, also across a DST change', () => {
    // The day before at 17:00.
    expect(allDayFireAt('2026-12-10', 420)).toBe(new Date(2026, 11, 9, 17).getTime())
    // 3 days before at 17:00: 24 Oct is still summer time (UTC+2).
    expect(allDayFireAt('2026-10-27', 3 * 1440 - 1020)).toBe(Date.UTC(2026, 9, 24, 15))
    // On the same day at 09:00.
    expect(allDayFireAt('2026-12-10', -540)).toBe(new Date(2026, 11, 10, 9).getTime())
  })
})

describe('allDayParts', () => {
  it('splits minutes into days before and the time of day', () => {
    expect(allDayParts(420)).toEqual({ days: 1, time: 1020 })
    expect(allDayParts(-540)).toEqual({ days: 0, time: 540 })
    expect(allDayParts(0)).toEqual({ days: 0, time: 0 })
    expect(allDayParts(10_080)).toEqual({ days: 7, time: 0 })
  })
})

describe('snoozeUntil', () => {
  const T = Date.UTC(2026, 10, 16, 9)
  // A 1 h meeting with no other reminder.
  const meeting = { start: T, last: T + 60 * MIN, next: null, allDay: false }

  it("uses Google's rule: 1 min before the start, then 5 min", () => {
    expect(snoozeUntil(T - 10 * MIN, meeting, 0)).toBe(T - MIN)
    expect(snoozeUntil(T - 30_000, meeting, 0)).toBe(T + 4.5 * MIN)
    expect(snoozeUntil(T + 20 * MIN, meeting, 0)).toBe(T + 25 * MIN)
  })

  it('never goes past 1 min before the start, the next reminder or the end', () => {
    expect(snoozeUntil(T - 10 * MIN, meeting, 30)).toBe(T - MIN)
    expect(snoozeUntil(T - 30 * MIN, { ...meeting, next: T - 10 * MIN }, 0)).toBe(T - 10 * MIN)
    expect(snoozeUntil(T + 50 * MIN, meeting, 15)).toBe(T + 60 * MIN)
    expect(snoozeUntil(T + 20 * MIN, meeting, 10)).toBe(T + 30 * MIN)
  })

  it('gives all-day events 5 min for the rule, with no start time to keep', () => {
    const day = { start: T, last: T + 24 * 60 * MIN, next: null, allDay: true }
    expect(snoozeUntil(T - 7 * 60 * MIN, day, 0)).toBe(T - 7 * 60 * MIN + 5 * MIN)
    expect(snoozeUntil(T - 7 * 60 * MIN, day, 60)).toBe(T - 6 * 60 * MIN)
  })
})
