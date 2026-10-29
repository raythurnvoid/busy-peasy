import { describe, expect, it } from 'vitest'
import { daysBetween, moveTimes, timeZoneLabel, zonedTime } from './time'

// Set before any Date is made. London has DST changes on 2026-03-29 (01:00 GMT -> 02:00 BST) and 2026-10-25.
// Vitest runs each test file in its own worker, so this does not change the Berlin files.
process.env.TZ = 'Europe/London'

const at = (iso: string): number => new Date(iso).getTime()
const utc = (t: number): string => new Date(t).toISOString().slice(0, 16) + 'Z'

describe('moveTimes in London', () => {
  it('keeps the length when the start falls into the DST gap and passes the end', () => {
    // 01:30 does not exist: JS gives 02:30 BST (01:30Z), after the 02:00 BST end.
    const gap = moveTimes({ start: at('2026-03-29T00:00Z'), end: at('2026-03-29T00:30Z') }, 0, 90)
    expect([utc(gap.start), utc(gap.end)]).toEqual(['2026-03-29T01:30Z', '2026-03-29T02:00Z'])
    // The design example: 00:30-01:30Z (02:30 BST) +30 min.
    const design = moveTimes(
      { start: at('2026-03-29T00:30Z'), end: at('2026-03-29T01:30Z') },
      0,
      30
    )
    expect([utc(design.start), utc(design.end)]).toEqual(['2026-03-29T01:00Z', '2026-03-29T02:00Z'])
  })

  it('uses the first 01:30 when summer time ends, and keeps the length', () => {
    // 00:30-01:00 BST +60 min: the first 01:30 is BST (00:30Z).
    const moved = moveTimes({ start: at('2026-10-24T23:30Z'), end: at('2026-10-25T00:00Z') }, 0, 60)
    expect([utc(moved.start), utc(moved.end)]).toEqual(['2026-10-25T00:30Z', '2026-10-25T01:00Z'])
    // 01:30-02:30 GMT (the second 01:30) +15 min: JS picks 01:45 BST, so the event moves earlier, but stays 1 h long.
    const second = moveTimes(
      { start: at('2026-10-25T01:30Z'), end: at('2026-10-25T02:30Z') },
      0,
      15
    )
    expect([utc(second.start), utc(second.end)]).toEqual(['2026-10-25T00:45Z', '2026-10-25T01:45Z'])
  })

  it('keeps the London wall time, so a New York event shifts 1 h in New York across the US DST end', () => {
    // Thu 29 Oct 14:00 London = 10:00 New York (EDT). One week later the US is on EST too.
    const moved = moveTimes({ start: at('2026-10-29T14:00Z'), end: at('2026-10-29T15:00Z') }, 7, 0)
    const ny = (t: number): string =>
      new Date(t).toLocaleTimeString('en-GB', { timeZone: 'America/New_York' })
    expect(utc(moved.start)).toBe('2026-11-05T14:00Z')
    expect(ny(moved.start)).toBe('09:00:00')
  })

  it('finds the same moment for a wall time as local dates do, on both DST days', () => {
    // The dialog uses zonedTime for every event, so in this PC's zone it must match new Date(...): the first 01:30
    // when summer time ends, and a time in the gap moved forward.
    for (const [y, m, d] of [[2026, 9, 25], [2027, 2, 28]]) {
      for (let minutes = 0; minutes < 1440; minutes += 15) {
        const local = new Date(y, m, d, 0, minutes)
        const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
        const date = `${y}-${String(m + 1).padStart(2, '0')}-${d}`
        expect(zonedTime(date, time, 'Europe/London'), `${date} ${time}`).toBe(local.getTime())
      }
    }
  })

  it('labels the gutter with the offset of the given day, also for another zone', () => {
    expect(timeZoneLabel(new Date(2027, 3, 7, 12))).toBe('GMT+01')
    expect(timeZoneLabel(new Date(2026, 10, 7, 12))).toBe('GMT+00')
    expect(timeZoneLabel(new Date(2027, 3, 7, 12), 'Asia/Tokyo')).toBe('GMT+09')
    expect(timeZoneLabel(new Date(2027, 3, 7, 12), 'Asia/Calcutta')).toBe('GMT+05:30')
  })

  it('counts whole days across both DST nights', () => {
    expect(daysBetween(new Date(2026, 2, 28), new Date(2026, 2, 30))).toBe(2)
    expect(daysBetween(new Date(2026, 9, 24), new Date(2026, 9, 26))).toBe(2)
  })
})
