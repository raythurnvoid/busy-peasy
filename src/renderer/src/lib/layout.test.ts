import { describe, expect, it } from 'vitest'
import type { CalendarEvent } from '../../../shared/api'
import { allDayMore, inAllDayRow, layoutAllDay, layoutDay, scheduleDays } from './layout'
import { dateKey, shownDays } from './time'

// Set before any Date is made. Berlin has a DST change on 2026-10-25, inside the test week.
process.env.TZ = 'Europe/Berlin'

let nextId = 1
function ev(start: Date, end: Date, extra: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: nextId++,
    calendarId: 1,
    title: '',
    start: start.getTime(),
    end: end.getTime(),
    allDay: false,
    startDate: null,
    endDate: null,
    location: '',
    joinUrl: null,
    description: '',
    showAs: 'busy',
    response: 'accepted',
    isOrganizer: false,
    guestsCanModify: false,
    attendeeCount: 0,
    seriesRemoteId: null,
    cancelled: false,
    reminders: [],
    color: null,
    colorKey: null,
    ...extra
  }
}

function allDay(startDate: string, endDate: string): CalendarEvent {
  // Providers store all-day events as UTC midnight.
  return ev(new Date(startDate + 'T00:00:00Z'), new Date(endDate + 'T00:00:00Z'), { allDay: true, startDate, endDate })
}

const at = (d: number, h: number, m = 0): Date => new Date(2026, 9, d, h, m)

describe('layoutDay', () => {
  it('puts overlapping events side by side and lets a box grow into a free column', () => {
    const a = ev(at(19, 9), at(19, 11))
    const b = ev(at(19, 9, 30), at(19, 10))
    const c = ev(at(19, 10, 30), at(19, 11))
    const boxes = layoutDay([a, b, c], at(19, 0), 15)
    const by = (e: CalendarEvent): object => {
      const { col, cols, span } = boxes.find((x) => x.event === e)!
      return { col, cols, span }
    }
    expect(by(a)).toEqual({ col: 0, cols: 2, span: 1 })
    expect(by(b)).toEqual({ col: 1, cols: 2, span: 1 })
    expect(by(c)).toEqual({ col: 1, cols: 2, span: 1 })
  })

  it('gives separate clusters their own width', () => {
    const boxes = layoutDay([ev(at(19, 9), at(19, 10)), ev(at(19, 11), at(19, 12))], at(19, 0), 15)
    expect(boxes.map((b) => b.cols)).toEqual([1, 1])
  })

  it('splits an event that crosses midnight between the two days', () => {
    const late = ev(at(19, 22), at(20, 2))
    expect(layoutDay([late], at(19, 0), 15)[0]).toMatchObject({ top: 22 * 60, bottom: 1440 })
    expect(layoutDay([late], at(20, 0), 15)[0]).toMatchObject({ top: 0, bottom: 120 })
  })

  it('uses wall-clock rows on the DST day', () => {
    // On 2026-10-25 Berlin has 25 hours. 15:00 local is still at 15:00.
    expect(layoutDay([ev(at(25, 15), at(25, 16))], at(25, 0), 15)[0]).toMatchObject({ top: 900, bottom: 960 })
  })

  it('gives very short events the minimum height', () => {
    expect(layoutDay([ev(at(19, 9), at(19, 9, 5))], at(19, 0), 20)[0]).toMatchObject({ top: 540, bottom: 560 })
  })
})

describe('layoutAllDay', () => {
  const monday = at(19, 0)
  const week = shownDays(monday, 7, true)

  it('keeps all-day events on their calendar dates', () => {
    const { bars } = layoutAllDay([allDay('2026-10-21', '2026-10-22')], week)
    expect(bars[0]).toMatchObject({ startDay: 2, endDay: 2, startsBefore: false, endsAfter: false })
  })

  it('clips long events to the week and marks the cut ends', () => {
    const { bars } = layoutAllDay([allDay('2026-10-15', '2026-10-30')], week)
    expect(bars[0]).toMatchObject({ startDay: 0, endDay: 6, startsBefore: true, endsAfter: true })
  })

  it('stacks overlapping bars in rows', () => {
    const { bars, rows } = layoutAllDay(
      [allDay('2026-10-19', '2026-10-22'), allDay('2026-10-20', '2026-10-21'), allDay('2026-10-23', '2026-10-24')],
      week
    )
    expect(rows).toBe(2)
    expect(bars.map((b) => b.row)).toEqual([0, 1, 0])
  })

  it('puts timed events of 24 h or more in the all-day row', () => {
    const { bars } = layoutAllDay([ev(at(19, 10), at(21, 10)), ev(at(19, 10), at(19, 11))], week)
    expect(bars).toHaveLength(1)
    expect(bars[0]).toMatchObject({ startDay: 0, endDay: 2 })
  })

  it('counts 24 h by the clock, also over DST nights', () => {
    // Overnight, 3 h: stays in the grid.
    expect(inAllDayRow(ev(at(19, 22), at(20, 1)))).toBe(false)
    // Exactly 24 h goes in the all-day row, like Google.
    expect(inAllDayRow(ev(new Date(2026, 11, 9, 10), new Date(2026, 11, 10, 10)))).toBe(true)
    // Clocks go back on 25 Oct: 23 h by the clock (24 h of real time) stays in the grid, like Google.
    expect(inAllDayRow(ev(at(24, 14, 30), at(25, 13, 30)))).toBe(false)
    // Clocks go forward on 29 Mar: 24 h by the clock is only 23 h of real time.
    expect(inAllDayRow(ev(new Date(2026, 2, 29, 0, 30), new Date(2026, 2, 30, 0, 30)))).toBe(true)
  })

  it('maps bars to the shown days when weekends are hidden', () => {
    // Mon 19 - Fri 23.
    const workWeek = shownDays(monday, 7, false)
    const thuToMon = allDay('2026-10-22', '2026-10-27')
    const { bars } = layoutAllDay([thuToMon, allDay('2026-10-24', '2026-10-26')], workWeek)
    // The Sat-Sun event has no shown day, so it gets no bar.
    expect(bars).toHaveLength(1)
    expect(bars[0]).toMatchObject({ event: thuToMon, startDay: 3, endDay: 4, startsBefore: false, endsAfter: true })
  })

  it('counts the bars "N more" hides per day, only with more than 3 rows', () => {
    // Five bars on Monday, two of them also on Tuesday.
    const five = [
      allDay('2026-10-19', '2026-10-21'),
      allDay('2026-10-19', '2026-10-21'),
      allDay('2026-10-19', '2026-10-20'),
      allDay('2026-10-19', '2026-10-20'),
      allDay('2026-10-19', '2026-10-20')
    ]
    const { bars } = layoutAllDay(five, week)
    expect(allDayMore(bars, 7, 3)).toEqual([3, 0, 0, 0, 0, 0, 0])
    expect(allDayMore(layoutAllDay(five.slice(0, 3), week).bars, 7, 3)).toEqual([0, 0, 0, 0, 0, 0, 0])
  })

  it('clips a timed event across the hidden DST weekend', () => {
    // Mon 26 - Fri 30. The event starts on Sat 24, before the DST Sunday.
    const { bars } = layoutAllDay([ev(at(24, 10), at(27, 10))], shownDays(at(25, 0), 7, false))
    expect(bars[0]).toMatchObject({ startDay: 0, endDay: 1, startsBefore: true, endsAfter: false })
  })
})

describe('scheduleDays', () => {
  const list = (groups: ReturnType<typeof scheduleDays>): string[][] =>
    groups.map((g) => [dateKey(g.day), ...g.events.map((e) => e.title)])

  it('groups by local day, all-day events by their date and first', () => {
    const events = [
      ev(at(19, 9), at(19, 10), { title: 'Mon 9:00' }),
      // 00:30 in Berlin is still 19 Oct in UTC.
      ev(at(20, 0, 30), at(20, 1), { title: 'Tue 0:30' }),
      { ...allDay('2026-10-20', '2026-10-21'), title: 'Tue all day' },
      // Shows once, on its first day.
      ev(at(19, 22), at(20, 2), { title: 'Mon night' })
    ]
    expect(list(scheduleDays(events, null))).toEqual([
      ['2026-10-19', 'Mon 9:00', 'Mon night'],
      ['2026-10-20', 'Tue all day', 'Tue 0:30']
    ])
  })

  it('always shows the first day, puts ongoing events on it and drops ended ones', () => {
    const events = [
      ev(at(18, 10), at(28, 10), { title: 'ongoing' }),
      // The read has slack for all-day events, so the day before can come too.
      { ...allDay('2026-10-23', '2026-10-24'), title: 'ended' },
      ev(at(27, 9), at(27, 10), { title: 'later' })
    ]
    expect(list(scheduleDays(events, at(24, 0)))).toEqual([['2026-10-24', 'ongoing'], ['2026-10-27', 'later']])
    expect(list(scheduleDays([], at(24, 0)))).toEqual([['2026-10-24']])
  })

  it('puts a timed event of 24 h or more by its start time, not with the all-day ones', () => {
    const events = [
      ev(at(24, 13, 30), at(25, 13, 30), { title: '13:30 for a day' }),
      ev(at(24, 11), at(24, 12), { title: '11:00' }),
      { ...allDay('2026-10-24', '2026-10-25'), title: 'all day' }
    ]
    expect(list(scheduleDays(events, null))).toEqual([['2026-10-24', 'all day', '11:00', '13:30 for a day']])
  })
})
