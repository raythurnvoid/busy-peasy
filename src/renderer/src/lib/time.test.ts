import { describe, expect, it } from 'vitest'
import type { Calendar } from '../../../shared/api'
import {
  allDayReminderText,
  createRange,
  dateKey,
  daysBetween,
  hourLabels,
  moveDates,
  moveTimes,
  parseDate,
  rangeTitle,
  resizeEnd,
  searchZones,
  shownDays,
  snapDelta,
  syncedDates,
  timeFormat,
  wallTime,
  zoneHourLabels,
  zoneLabel,
  zoneList,
  zonedTime
} from './time'

// Set before any Date is made. Berlin has a DST change on 2026-10-25.
process.env.TZ = 'Europe/Berlin'

describe('shownDays', () => {
  it('leaves out Saturday and Sunday', () => {
    // The week starts on the DST Sunday.
    const days = shownDays(new Date(2026, 9, 25), 7, false)
    expect(days.map(dateKey)).toEqual(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'])
    expect(days.every((d) => d.getHours() === 0)).toBe(true)
    expect(shownDays(new Date(2026, 9, 25), 7, true)).toHaveLength(7)
  })
})

describe('allDayReminderText', () => {
  it("says it like Google, in the app's clock", () => {
    const time = timeFormat(false, 'en-GB')
    expect(allDayReminderText(420, time)).toBe('The day before at 17:00')
    expect(allDayReminderText(-540, time)).toBe('On the same day at 09:00')
    expect(allDayReminderText(2 * 1440 - 1020, time)).toBe('2 days before at 17:00')
    expect(allDayReminderText(7 * 1440 - 1020, time)).toBe('1 week before at 17:00')
    // 28 days, like Google.
    expect(allDayReminderText(28 * 1440 - 540, time)).toBe('4 weeks before at 09:00')
  })
})

// The locale is pinned, so a wrong clock shows on any machine: en-GB has a 24h default, en-US a 12h one.
describe('hourLabels', () => {
  it('uses Google 24h labels', () => {
    const labels = hourLabels(false, 'en-GB')
    expect(labels[13]).toBe('13:00')
    expect(labels[1]).toBe('01:00')
    expect(labels[0]).toBe('')
  })

  it('keeps the language default', () => {
    const today = new Intl.DateTimeFormat('en-US', { hour: 'numeric' }).format(new Date(2000, 0, 1, 13))
    expect(hourLabels(null, 'en-US')[13]).toBe(today)
  })

  it('gives 12h labels', () => {
    expect(hourLabels(true, 'en-GB')[13]).toMatch(/^1\s*pm$/i)
  })
})

describe('timeFormat', () => {
  it('gives the same 24h times in format and formatRange', () => {
    // In en-GB a numeric hour gives "9:30" with format but "09:30" with formatRange.
    const time = timeFormat(false, 'en-GB')
    expect(time.format(new Date(2000, 0, 1, 9, 30))).toBe('09:30')
    expect(time.formatRange(new Date(2000, 0, 1, 9, 30), new Date(2000, 0, 1, 10))).toMatch(/^09:30\s*–\s*10:00$/)
  })
})

describe('zoneHourLabels', () => {
  it('gives the wall time of the second zone at each Berlin hour, with minutes for a zone a half hour off', () => {
    // 01:00 in Berlin (summer time) is 23:00Z, which is 04:30 in India.
    const labels = zoneHourLabels(new Date(2027, 3, 7), 'Asia/Calcutta', false, 'en-GB')
    expect(labels[0]).toBe('')
    expect(labels[1]).toBe('04:30')
    expect(zoneHourLabels(new Date(2027, 3, 7), 'Asia/Tokyo', false, 'en-GB')[9]).toBe('16:00')
    // 12h labels have no minutes, except for the half hour.
    expect(zoneHourLabels(new Date(2027, 3, 7), 'Asia/Calcutta', true, 'en-GB')[1]).toMatch(/^4:30\s*am$/i)
    expect(zoneHourLabels(new Date(2027, 3, 7), 'Asia/Tokyo', true, 'en-GB')[9]).toMatch(/^4\s*pm$/i)
  })
})

describe('zones', () => {
  it('finds the moment of a wall time on DST days in other zones', () => {
    // Rome and New York change by 1 h, Lord Howe by 30 min; Kathmandu is 5:45 ahead all year.
    const days = [
      ['Europe/Rome', '2026-03-29'],
      ['Europe/Rome', '2026-10-25'],
      ['America/New_York', '2026-03-08'],
      ['America/New_York', '2026-11-01'],
      ['Australia/Lord_Howe', '2026-04-05'],
      ['Australia/Lord_Howe', '2026-10-04'],
      ['Asia/Katmandu', '2026-10-25']
    ]
    for (const [zone, day] of days) {
      // Every 15 min of moments around that day: the wall time there must lead back to the same wall time.
      for (let t = Date.parse(day + 'T00:00Z') - 14 * 3600_000; t < Date.parse(day + 'T00:00Z') + 38 * 3600_000; t += 15 * 60_000) {
        const wall = wallTime(t, zone)
        expect(wallTime(zonedTime(wall.date, wall.time, zone), zone), `${zone} ${utc(t)}`).toEqual(wall)
      }
    }
    // The repeated hour takes the first 01:30 (summer time), like new Date does.
    expect(zonedTime('2026-11-01', '01:30', 'America/New_York')).toBe(Date.UTC(2026, 10, 1, 5, 30))
  })

  it("labels zones like Google, with the offset of that day", () => {
    const november = Date.UTC(2026, 10, 10, 12)
    expect(zoneLabel('Europe/Rome', november)).toBe('(GMT+01:00) Central European Time - Rome')
    expect(zoneLabel('Europe/Rome', Date.UTC(2026, 6, 10, 12))).toBe('(GMT+02:00) Central European Time - Rome')
    expect(zoneLabel('UTC', november)).toBe('(GMT+00:00) Coordinated Universal Time')
    // An Outlook zone: no city.
    expect(zoneLabel('Europe/Berlin', november, false)).toBe('(GMT+01:00) Central European Time')
    // The modern name of an old id.
    expect(zoneLabel('Asia/Calcutta', november)).toBe('(GMT+05:30) India Standard Time - Kolkata')
    // No other zone has this name, so no city, like Google.
    expect(zoneLabel('Asia/Tokyo', november)).toBe('(GMT+09:00) Japan Standard Time')
    expect(zoneLabel('Asia/Katmandu', november)).toBe('(GMT+05:45) Nepal Time')
  })

  it('lists every zone by offset, found by city, zone name or country', () => {
    const list = zoneList(Date.UTC(2026, 10, 10, 12))
    expect(list.length).toBeGreaterThan(400)
    expect(list[0].label.startsWith('(GMT-11:00)') && list.at(-1)!.label.startsWith('(GMT+14:00)')).toBe(true)
    const found = (text: string): string[] => searchZones(list, text).map((z) => z.zone)
    expect(found('rome')).toEqual(['Europe/Rome'])
    expect(found('italy')).toEqual(['Europe/Rome'])
    expect(found('kolkata')).toEqual(['Asia/Calcutta'])
    expect(found('united kingdom')).toContain('Europe/London')
    expect(found('coordinated universal')).toEqual(['UTC'])
    // The country's or city's own zone first, before Indiana (in the id) and the Indian Ocean zones.
    expect(found('India')[0]).toBe('Asia/Calcutta')
    expect(found('India').length).toBeGreaterThan(5)
    expect(found('Japan')[0]).toBe('Asia/Tokyo')
    expect(found('tok')[0]).toBe('Asia/Tokyo')
    // The label has no city here, and the id has the old name: the city still finds it, first.
    expect(found('kathmandu')).toEqual(['Asia/Katmandu'])
    expect(found('Yangon')[0]).toBe('Asia/Rangoon')
    expect(found('tokyo')[0]).toBe('Asia/Tokyo')
  })
})

// Drag math. Times are Europe/Berlin wall time unless they end in Z.
const at = (iso: string): number => new Date(iso).getTime()
const utc = (t: number): string => new Date(t).toISOString().slice(0, 16) + 'Z'

describe('snapDelta', () => {
  it('snaps a move down to 15 minutes, like Google', () => {
    expect([62.5, 12.5, 16.25, -16.25].map(snapDelta)).toEqual([60, 0, 15, -30])
  })
})

describe('createRange', () => {
  it('rounds the earlier point down and the later one up, in both drag directions', () => {
    const day = new Date(2027, 2, 9)
    for (const [a, b] of [[603, 663], [663, 603]]) {
      const { start, end } = createRange(day, a, b)
      expect([start.getTime(), end.getTime()]).toEqual([at('2027-03-09T10:00'), at('2027-03-09T11:15')])
    }
  })
})

describe('resizeEnd', () => {
  it('rounds the end up and keeps at least 15 minutes', () => {
    const day = new Date(2027, 2, 9)
    const start = at('2027-03-09T10:00')
    expect(resizeEnd(start, day, 661)).toBe(at('2027-03-09T11:15'))
    expect(resizeEnd(start, day, 605)).toBe(at('2027-03-09T10:15'))
    expect(resizeEnd(start, day, 540)).toBe(at('2027-03-09T10:15'))
  })
})

describe('moveTimes', () => {
  it('keeps the wall time when a day move crosses the DST night', () => {
    // Sat 10:00 CEST is 08:00Z; Sun 10:00 CET is 09:00Z.
    const moved = moveTimes({ start: at('2026-10-24T10:00'), end: at('2026-10-24T11:00') }, 1, 0)
    expect([utc(moved.start), utc(moved.end)]).toEqual(['2026-10-25T09:00Z', '2026-10-25T10:00Z'])
    expect(moved).toMatchObject({ allDay: false, startDate: null, endDate: null })
  })

  it('keeps the length when the start falls into the DST gap and passes the end', () => {
    // 02:30 does not exist on 2026-03-29: JS gives 03:30 CEST, after the 03:00 end.
    const gap = moveTimes({ start: at('2026-03-29T00:30'), end: at('2026-03-29T01:00') }, 0, 120)
    expect([utc(gap.start), utc(gap.end)]).toEqual(['2026-03-29T01:30Z', '2026-03-29T02:00Z'])
    // The design example: 01:00-02:00 (end 03:00 CEST) +90 min.
    const design = moveTimes({ start: at('2026-03-29T01:00+01:00'), end: at('2026-03-29T03:00+02:00') }, 0, 90)
    expect([utc(design.start), utc(design.end)]).toEqual(['2026-03-29T01:30Z', '2026-03-29T02:30Z'])
  })

  it('uses the first 02:30 when summer time ends, and keeps the length', () => {
    const moved = moveTimes({ start: at('2026-10-25T00:00'), end: at('2026-10-25T01:00') }, 0, 150)
    expect([utc(moved.start), utc(moved.end)]).toEqual(['2026-10-25T00:30Z', '2026-10-25T01:30Z'])
  })

  it('moves an event that crosses midnight as a whole', () => {
    const late = { start: at('2026-11-10T22:00'), end: at('2026-11-11T02:00') }
    const day = moveTimes(late, 1, 0)
    expect([day.start, day.end]).toEqual([at('2026-11-11T22:00'), at('2026-11-12T02:00')])
    // A drag of the second piece (00:00-02:00) by +60 moves the whole event.
    const hour = moveTimes(late, 0, 60)
    expect([hour.start, hour.end]).toEqual([at('2026-11-10T23:00'), at('2026-11-11T03:00')])
  })

  it('keeps the exact moment when nothing moves, also in the repeated hour', () => {
    // The second 02:30 on 2026-10-25 (CET).
    const second = { start: at('2026-10-25T02:30+01:00'), end: at('2026-10-25T03:30+01:00') }
    expect(moveTimes(second, 0, 0)).toMatchObject(second)
  })
})

describe('moveDates', () => {
  it('shifts both dates and keeps start and end at UTC midnight', () => {
    expect(moveDates({ startDate: '2027-03-08', endDate: '2027-03-10' }, 2)).toEqual({
      allDay: true,
      startDate: '2027-03-10',
      endDate: '2027-03-12',
      start: Date.parse('2027-03-10T00:00:00Z'),
      end: Date.parse('2027-03-12T00:00:00Z')
    })
  })
})

describe('daysBetween', () => {
  it('counts whole days across both DST nights', () => {
    expect(daysBetween(new Date(2026, 9, 24), new Date(2026, 9, 26))).toBe(2)
    expect(daysBetween(new Date(2026, 2, 28), new Date(2026, 2, 30))).toBe(2)
    expect(daysBetween(new Date(2026, 2, 30), new Date(2026, 2, 28))).toBe(-2)
  })
})

describe('rangeTitle', () => {
  it('shows both years when the range ends in the same month a year later', () => {
    expect(rangeTitle(new Date(2026, 9, 27), new Date(2027, 9, 26))).toMatch(/2026.*2027/)
  })
})

describe('parseDate', () => {
  const numeric = (locale: string): Intl.DateTimeFormat => new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit', year: 'numeric' })

  it('reads the numbers in the order of the language', () => {
    expect(parseDate('20/10/2026', numeric('en-GB'))).toEqual(new Date(2026, 9, 20))
    expect(parseDate('10/20/2026', numeric('en-US'))).toEqual(new Date(2026, 9, 20))
    expect(parseDate('2026/10/20', numeric('ja-JP'))).toEqual(new Date(2026, 9, 20))
    expect(parseDate(' 1.2.2027 ', numeric('de-DE'))).toEqual(new Date(2027, 1, 1))
  })

  it('is null for text that is not a date between 1900 and 2999', () => {
    const gb = numeric('en-GB')
    for (const text of ['', '20/10', '20/10/2026/1', '31/02/2026', '20/13/2026', '1/3/50', '1/3/0050', '1/1/3000', 'today']) {
      expect(parseDate(text, gb), text).toBeNull()
    }
  })
})

describe('syncedDates', () => {
  const calendar = (windowStart: number | null, windowEnd: number | null, visible = true): Calendar => ({
    id: 1,
    accountId: 1,
    name: 'Me',
    color: '#000',
    canEdit: true,
    visible,
    isPrimary: true,
    defaultReminders: [],
    conference: null,
    timeZone: null,
    windowStart,
    windowEnd,
    colors: [],
    labelsRead: false
  })

  it('uses the dates every visible synced calendar covers, as local days', () => {
    const dates = syncedDates([
      calendar(Date.UTC(2026, 7, 28), Date.UTC(2027, 9, 27)),
      calendar(Date.UTC(2026, 7, 25), Date.UTC(2027, 9, 24)),
      // Hidden and not yet synced calendars do not count.
      calendar(Date.UTC(2026, 8, 30), Date.UTC(2026, 9, 1), false),
      calendar(null, null)
    ])
    expect(dates).toEqual({ from: new Date(2026, 7, 28), to: new Date(2027, 9, 24) })
  })

  it('is null when no calendar has synced', () => {
    expect(syncedDates([calendar(null, null)])).toBeNull()
  })
})
