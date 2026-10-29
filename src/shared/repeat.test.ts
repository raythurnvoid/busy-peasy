import { describe, expect, it } from 'vitest'
import type { Repeat } from './api'
import {
  countBefore,
  cutPattern,
  cutRrule,
  exdateLine,
  exdates,
  fromPattern,
  fromRrule,
  moveRepeat,
  sameRepeat,
  scopeChoices,
  seriesTimes,
  shiftStart,
  toPattern,
  toRrule,
  type First
} from './repeat'

const rule = (extra: Partial<Repeat> = {}): Repeat => ({
  freq: 'weekly',
  interval: 1,
  days: [2],
  monthly: 'day',
  until: null,
  count: null,
  ...extra
})
// Tue 1 Dec 2026, 10:00 in Lisbon (UTC+0 in winter).
const tue: First = { start: Date.UTC(2026, 11, 1, 10), allDay: false, zone: 'Europe/Lisbon' }
const at = (date: string, zone = 'Europe/Lisbon', time = '10:00'): First => {
  const [y, m, d] = date.split('-').map(Number)
  const offset = new Date(Date.UTC(y, m - 1, d, 12))
    .toLocaleString('sv-SE', { timeZone: zone })
    .slice(11, 13)
  return {
    start: Date.UTC(
      y,
      m - 1,
      d,
      Number(time.slice(0, 2)) - (Number(offset) - 12),
      Number(time.slice(3))
    ),
    allDay: false,
    zone
  }
}

describe('toRrule', () => {
  it("writes Google's forms", () => {
    expect(toRrule(rule({ count: 6 }), tue)).toBe('RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=6')
    expect(toRrule(rule({ interval: 2, days: [4, 2], count: 5 }), tue)).toBe(
      'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;COUNT=5'
    )
    expect(toRrule(rule({ freq: 'monthly', days: [], monthly: 'weekday' }), tue)).toBe(
      'RRULE:FREQ=MONTHLY;BYDAY=1TU'
    )
    expect(toRrule(rule({ freq: 'monthly', days: [], monthly: 'day' }), tue)).toBe(
      'RRULE:FREQ=MONTHLY;BYMONTHDAY=1'
    )
    expect(toRrule(rule({ freq: 'monthly', days: [], monthly: 'last' }), at('2026-12-29'))).toBe(
      'RRULE:FREQ=MONTHLY;BYDAY=-1TU'
    )
    expect(toRrule(rule({ freq: 'yearly', days: [], count: 2 }), tue)).toBe(
      'RRULE:FREQ=YEARLY;COUNT=2'
    )
    expect(toRrule(rule({ freq: 'daily', days: [], interval: 3 }), tue)).toBe(
      'RRULE:FREQ=DAILY;INTERVAL=3'
    )
  })

  it('ends on the last second of the until day in the zone, also across a DST change', () => {
    expect(toRrule(rule({ until: '2027-03-02' }), tue)).toBe(
      'RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20270302T235959Z'
    )
    // Berlin goes to summer time on 29 March 2026: that day ends at 22:00 UTC, the day before at 23:00 UTC.
    const berlin = at('2026-03-03', 'Europe/Berlin')
    expect(
      toRrule(rule({ days: [0], until: '2026-03-29' }), {
        ...berlin,
        start: Date.UTC(2026, 2, 1, 9)
      })
    ).toMatch(/UNTIL=20260329T215959Z$/)
    expect(
      toRrule(rule({ days: [0], until: '2026-03-28' }), {
        ...berlin,
        start: Date.UTC(2026, 2, 1, 9)
      })
    ).toMatch(/UNTIL=20260328T225959Z$/)
    // All-day: the date.
    expect(
      toRrule(rule({ until: '2027-03-02' }), {
        start: Date.UTC(2026, 11, 1),
        allDay: true,
        zone: 'UTC'
      })
    ).toMatch(/UNTIL=20270302$/)
  })
})

describe('fromRrule', () => {
  it('reads back what toRrule writes', () => {
    const rules: [Repeat, First][] = [
      [rule({ count: 6 }), tue],
      [rule({ interval: 2, days: [2, 4], until: '2027-03-02' }), tue],
      [rule({ freq: 'monthly', days: [], monthly: 'weekday' }), tue],
      [rule({ freq: 'monthly', days: [], monthly: 'last' }), at('2026-12-29')],
      [rule({ freq: 'yearly', days: [], until: '2030-12-01' }), tue],
      [rule({ freq: 'daily', days: [], count: 1 }), tue],
      [rule({ until: '2026-03-29', days: [0] }), at('2026-03-01', 'Europe/Berlin')]
    ]
    for (const [r, f] of rules) expect(fromRrule([toRrule(r, f)], f)).toEqual(r)
  })

  it("reads Google web's forms, and deleted events do not matter", () => {
    expect(
      fromRrule(
        ['RRULE:FREQ=MONTHLY;WKST=SU;BYDAY=1TU', 'EXDATE;TZID=Europe/Lisbon:20270105T100000'],
        tue
      )
    ).toEqual(rule({ freq: 'monthly', days: [], monthly: 'weekday' }))
    expect(fromRrule(['RRULE:FREQ=WEEKLY'], tue)).toEqual(rule())
    expect(fromRrule(['RRULE:FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=1'], tue)).toEqual(
      rule({ freq: 'yearly', days: [] })
    )
    // A cut one second before an event: the last day is the day before.
    expect(fromRrule(['RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261215T095959Z'], tue)?.until).toBe(
      '2026-12-14'
    )
  })

  it.each([
    ['BYSETPOS', ['RRULE:FREQ=MONTHLY;BYDAY=TU;BYSETPOS=1']],
    ['an EXRULE', ['RRULE:FREQ=WEEKLY', 'EXRULE:FREQ=MONTHLY']],
    ['an RDATE', ['RRULE:FREQ=WEEKLY', 'RDATE:20261203T100000Z']],
    ['two rules', ['RRULE:FREQ=WEEKLY', 'RRULE:FREQ=DAILY']],
    ['a nth weekday that is not the first date', ['RRULE:FREQ=MONTHLY;BYDAY=2TU']],
    ['weekdays without the first date', ['RRULE:FREQ=WEEKLY;BYDAY=WE']],
    ['the fifth weekday', ['RRULE:FREQ=MONTHLY;BYDAY=5TU']],
    ['COUNT and UNTIL', ['RRULE:FREQ=WEEKLY;COUNT=2;UNTIL=20270101']]
  ])('cannot read %s', (_, lines) => {
    expect(fromRrule(lines, tue)).toBeNull()
  })
})

describe('Outlook patterns', () => {
  it('sends only the fields each type needs, with dates in the series zone', () => {
    expect(toPattern(rule({ count: 13 }), tue, 'GMT Standard Time')).toEqual({
      Pattern: { Type: 'Weekly', Interval: 1, DaysOfWeek: ['Tuesday'], FirstDayOfWeek: 'Sunday' },
      Range: {
        Type: 'Numbered',
        NumberOfOccurrences: 13,
        StartDate: '2026-12-01',
        RecurrenceTimeZone: 'GMT Standard Time'
      }
    })
    expect(
      toPattern(
        rule({ freq: 'monthly', days: [], monthly: 'weekday', until: '2027-06-01' }),
        tue,
        'X'
      ).Pattern
    ).toEqual({
      Type: 'RelativeMonthly',
      Interval: 1,
      DaysOfWeek: ['Tuesday'],
      Index: 'First'
    })
    expect(
      toPattern(rule({ freq: 'monthly', days: [], monthly: 'last' }), at('2026-12-29'), 'X').Pattern
    ).toMatchObject({ Index: 'Last' })
    expect(toPattern(rule({ freq: 'monthly', days: [], interval: 2 }), tue, 'X').Pattern).toEqual({
      Type: 'AbsoluteMonthly',
      Interval: 2,
      DayOfMonth: 1
    })
    expect(toPattern(rule({ freq: 'yearly', days: [] }), tue, 'X')).toEqual({
      Pattern: { Type: 'AbsoluteYearly', Interval: 1, Month: 12, DayOfMonth: 1 },
      Range: { Type: 'NoEnd', StartDate: '2026-12-01', RecurrenceTimeZone: 'X' }
    })
    expect(
      toPattern(rule({ freq: 'daily', days: [], until: '2027-01-01' }), tue, 'X').Range
    ).toEqual({
      Type: 'EndDate',
      EndDate: '2027-01-01',
      StartDate: '2026-12-01',
      RecurrenceTimeZone: 'X'
    })
    // 00:30 on 1 Dec in Berlin is still 30 Nov in UTC: the start date is Berlin's.
    const berlin = { start: Date.UTC(2026, 10, 30, 23, 30), allDay: false, zone: 'Europe/Berlin' }
    expect(
      toPattern(rule({ freq: 'daily', days: [] }), berlin, 'W. Europe Standard Time').Range
    ).toMatchObject({ StartDate: '2026-12-01' })
  })

  it('reads back what toPattern writes, and nothing it cannot write', () => {
    const rules: [Repeat, First][] = [
      [rule({ count: 13 }), tue],
      [rule({ freq: 'monthly', days: [], monthly: 'weekday', until: '2027-06-01' }), tue],
      [rule({ freq: 'monthly', days: [], monthly: 'last' }), at('2026-12-29')],
      [rule({ freq: 'yearly', days: [], interval: 2 }), tue]
    ]
    for (const [r, f] of rules) expect(fromPattern(toPattern(r, f, 'X'), f)).toEqual(r)
    const yearly = {
      Pattern: {
        Type: 'RelativeYearly',
        Interval: 1,
        DaysOfWeek: ['Tuesday'],
        Month: 12,
        Index: 'First'
      },
      Range: { Type: 'NoEnd' }
    }
    expect(fromPattern(yearly, tue)).toBeNull()
  })

  it('ends a split series the day before the cut event, in the series zone', () => {
    // A daily 00:30 series in Berlin summer time, cut at Tue 25 Aug: that event is Mon 22:30 in UTC.
    const recurrence = toPattern(
      rule({ freq: 'daily', days: [], count: 30 }),
      at('2026-08-01', 'Europe/Berlin', '00:30'),
      'W. Europe Standard Time'
    )
    expect(cutPattern(recurrence, Date.UTC(2026, 7, 24, 22, 30), false, 'Europe/Berlin')).toEqual({
      Pattern: { Type: 'Daily', Interval: 1 },
      Range: {
        Type: 'EndDate',
        StartDate: '2026-08-01',
        RecurrenceTimeZone: 'W. Europe Standard Time',
        EndDate: '2026-08-24'
      }
    })
  })

  it('reads an all-day cut by its UTC date: Outlook is assumed to send UTC midnight of the date (S-S3, not checked live)', () => {
    const recurrence = toPattern(
      rule({ freq: 'daily', days: [] }),
      { start: Date.UTC(2026, 11, 1), allDay: true, zone: 'America/New_York' },
      'Eastern Standard Time'
    )
    // In New York, 00:00 UTC on 8 Dec is still 7 Dec: the cut must not be read in the series zone.
    expect(
      cutPattern(recurrence, Date.parse('2026-12-08T00:00:00Z'), true, 'America/New_York').Range
    ).toMatchObject({ EndDate: '2026-12-07' })
  })
})

describe('cutRrule', () => {
  it('replaces COUNT with an UNTIL at the end of the day before the cut, and keeps the deleted events', () => {
    const lines = ['RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=6', 'EXDATE:20261208T100000Z']
    expect(cutRrule(lines, Date.UTC(2026, 11, 15, 10), false, 'Europe/Lisbon')).toEqual([
      'RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261214T235959Z',
      'EXDATE:20261208T100000Z'
    ])
    expect(
      cutRrule(['RRULE:FREQ=DAILY;UNTIL=20270101'], Date.UTC(2026, 11, 15), true, 'Europe/Lisbon')
    ).toEqual(['RRULE:FREQ=DAILY;UNTIL=20261214'])
    // A COUNT that comes first goes too: COUNT and UNTIL together are not a valid rule.
    expect(
      cutRrule(['RRULE:COUNT=5;FREQ=DAILY'], Date.UTC(2026, 11, 15), true, 'Europe/Lisbon')
    ).toEqual(['RRULE:FREQ=DAILY;UNTIL=20261214'])
  })

  it('ends a timed series on the day before the cut in the series zone, like Google web (Q N1)', () => {
    const cut = (start: string, zone: string): string[] =>
      cutRrule(['RRULE:FREQ=DAILY'], Date.parse(start), false, zone)
    const ends = (lines: string[], start: string, zone: string): string | null | undefined =>
      fromRrule(lines, { start: Date.parse(start), allDay: false, zone })?.until
    // A late evening event the day before stays: 22:00 on 15 Dec in New York is 03:00 UTC on 16 Dec.
    const newYork = cut('2026-12-17T03:00:00Z', 'America/New_York')
    expect(newYork).toEqual(['RRULE:FREQ=DAILY;UNTIL=20261216T045959Z'])
    expect(ends(newYork, '2026-12-01T03:00:00Z', 'America/New_York')).toBe('2026-12-15')
    // 08:00 on 16 Dec in Tokyo is still 15 Dec in UTC.
    expect(cut('2026-12-15T23:00:00Z', 'Asia/Tokyo')).toEqual([
      'RRULE:FREQ=DAILY;UNTIL=20261215T145959Z'
    ])
    // The DST night: Lisbon moves to UTC+1 on 28 Mar 2027, so that day ends at 23:00 UTC.
    const dst = cut('2027-03-29T00:30:00Z', 'Europe/Lisbon')
    expect(dst).toEqual(['RRULE:FREQ=DAILY;UNTIL=20270328T225959Z'])
    expect(ends(dst, '2027-03-01T01:30:00Z', 'Europe/Lisbon')).toBe('2027-03-28')
  })
})

describe('countBefore', () => {
  it('counts the events of the rule before a date', () => {
    expect(countBefore(rule({ count: 6 }), tue, '2026-12-15')).toBe(2)
    expect(countBefore(rule({ count: 6 }), tue, '2026-12-16')).toBe(3)
    expect(
      countBefore(
        rule({ freq: 'monthly', days: [], monthly: 'last', count: 10 }),
        at('2026-12-29'),
        '2027-04-01'
      )
    ).toBe(4)
    expect(countBefore(rule({ freq: 'daily', days: [], interval: 3 }), tue, '2026-12-11')).toBe(4)
    // Never more than COUNT.
    expect(countBefore(rule({ count: 2 }), tue, '2027-12-01')).toBe(2)
  })

  it("counts weekly rules with an interval in the rule's own weeks", () => {
    // Every 2 weeks on Tuesday and Sunday from Tue 1 Dec: weeks from Monday hold Tue 1 + Sun 6, then Tue 15 + Sun 20.
    const r = rule({ interval: 2, days: [0, 2] })
    expect(countBefore(r, tue, '2026-12-21', 1)).toBe(4)
    // Weeks from Sunday: Tue 1, then Sun 13 + Tue 15.
    expect(countBefore(r, tue, '2026-12-21', 0)).toBe(3)
  })
})

describe('moveRepeat and scopeChoices', () => {
  it('moves a one-day weekly rule to the new day, and monthly rules to the new date', () => {
    expect(moveRepeat(rule(), '2026-12-08', '2026-12-09')).toEqual(rule({ days: [3] }))
    expect(toRrule(moveRepeat(rule(), '2026-12-08', '2026-12-09')!, at('2026-12-09'))).toBe(
      'RRULE:FREQ=WEEKLY;BYDAY=WE'
    )
    expect(
      moveRepeat(
        rule({ freq: 'monthly', days: [], monthly: 'weekday' }),
        '2026-12-22',
        '2026-12-29'
      )
    ).toMatchObject({ monthly: 'last' })
    expect(moveRepeat(rule({ days: [1, 3, 5] }), '2026-12-09', '2026-12-10')).toBeNull()
    expect(moveRepeat(rule({ until: '2026-12-09' }), '2026-12-08', '2026-12-10')).toBeNull()
  })

  const choices = (o: Partial<Parameters<typeof scopeChoices>[0]>): string[] =>
    scopeChoices({
      repeat: rule(),
      firstDate: '2026-12-01',
      from: '2026-12-08',
      to: '2026-12-08',
      ...o
    })

  it('offers what Google offers', () => {
    expect(choices({})).toEqual(['event', 'following', 'series'])
    // First event: no "This and following".
    expect(choices({ from: '2026-12-01', to: '2026-12-01' })).toEqual(['event', 'series'])
    // Another day: no "All events"; on the first event "All events" moves the series.
    expect(choices({ to: '2026-12-09' })).toEqual(['event', 'following'])
    expect(choices({ from: '2026-12-01', to: '2026-12-02' })).toEqual(['event', 'series'])
    // A new rule: never "This event"; on the first event only "All events".
    expect(choices({ rule: rule({ count: 3 }) })).toEqual(['following', 'series'])
    expect(
      choices({ from: '2026-12-01', to: '2026-12-01', rule: rule({ freq: 'daily', days: [] }) })
    ).toEqual(['series'])
  })

  it('never splits what it cannot rebuild', () => {
    // More than one weekday and another day: which one moves is not clear.
    expect(
      choices({ repeat: rule({ days: [1, 3, 5] }), from: '2026-12-09', to: '2026-12-10' })
    ).toEqual(['event'])
    // A rule the app cannot read.
    expect(choices({ repeat: null })).toEqual(['event', 'series'])
    expect(choices({ repeat: null, to: '2026-12-09' })).toEqual(['event'])
    // Only the user's own fields.
    expect(choices({ ownOnly: true })).toEqual(['event', 'series'])
    // "Monthly on the second Tuesday" on 8 Dec would be the first Tuesday from the first date (1 Dec).
    expect(choices({ rule: rule({ freq: 'monthly', days: [], monthly: 'weekday' }) })).toEqual([
      'following'
    ])
  })

  it('offers no split where the provider cannot make one (Outlook, S-M3)', () => {
    expect(choices({ split: false })).toEqual(['event', 'series'])
    expect(choices({ split: false, to: '2026-12-09' })).toEqual(['event'])
    expect(choices({ split: false, rule: rule({ count: 3 }) })).toEqual(['series'])
    // The first event moves the whole series: no split there anyway.
    expect(choices({ split: false, from: '2026-12-01', to: '2026-12-02' })).toEqual([
      'event',
      'series'
    ])
  })

  it('compares rules by their fields, in any key order', () => {
    const { count, until, monthly, days, interval, freq } = rule({ days: [1, 2] })
    expect(
      sameRepeat(rule({ days: [1, 2] }), { count, until, monthly, days, interval, freq })
    ).toBe(true)
    expect(sameRepeat(rule(), rule({ count: 2 }))).toBe(false)
    expect(sameRepeat(rule(), null)).toBe(false)
    expect(sameRepeat(null, null)).toBe(true)
  })
})

describe('shifts', () => {
  it('moves deleted events like the new series start: time and day', () => {
    const from = at('2026-12-08')
    const deleted = Date.UTC(2026, 11, 22, 10)
    expect(
      exdateLine([shiftStart(deleted, from, at('2026-12-08', 'Europe/Lisbon', '11:00'))], false)
    ).toBe('EXDATE:20261222T110000Z')
    expect(exdateLine([shiftStart(deleted, from, at('2026-12-09'))], false)).toBe(
      'EXDATE:20261223T100000Z'
    )
    expect(
      exdateLine(
        [
          shiftStart(
            Date.UTC(2026, 11, 22),
            { ...from, start: Date.UTC(2026, 11, 8), allDay: true },
            { ...from, start: Date.UTC(2026, 11, 9), allDay: true }
          )
        ],
        true
      )
    ).toBe('EXDATE;VALUE=DATE:20261223')
  })

  it("moves deleted events of a monthly weekday rule to the new rule's day of their month (C-S1)", () => {
    const monthly = (m: Repeat['monthly']): Repeat =>
      rule({ freq: 'monthly', days: [], monthly: m })
    // From the last Tuesday (29 Dec 2026) to the last Wednesday (30 Dec): 30 Nov 2027 + 1 day is 1 Dec, not 24 Nov.
    const lastTue = Date.UTC(2027, 10, 30, 10)
    expect(
      new Date(
        shiftStart(lastTue, at('2026-12-29'), at('2026-12-30'), monthly('last'))
      ).toISOString()
    ).toBe('2027-11-24T10:00:00.000Z')
    // From the first Tuesday to the first Wednesday, one hour later: 7 Sep 2027 goes to 1 Sep (Lisbon summer: UTC+1).
    expect(
      new Date(
        shiftStart(
          Date.UTC(2027, 8, 7, 9),
          at('2026-12-01'),
          at('2026-12-02', 'Europe/Lisbon', '11:00'),
          monthly('weekday')
        )
      ).toISOString()
    ).toBe('2027-09-01T10:00:00.000Z')
  })

  it('reads deleted events in every form', () => {
    expect(
      exdates(
        [
          'RRULE:FREQ=DAILY',
          'EXDATE;TZID=Europe/Berlin:20261222T100000,20261223T100000',
          'EXDATE:20261224T090000Z',
          'EXDATE;VALUE=DATE:20261225'
        ],
        'UTC'
      )
    ).toEqual([
      Date.UTC(2026, 11, 22, 9),
      Date.UTC(2026, 11, 23, 9),
      Date.UTC(2026, 11, 24, 9),
      Date.UTC(2026, 11, 25)
    ])
  })

  it('keeps the first date of the series and takes the new wall time, across DST', () => {
    // Master Mon 5 Jan 09:00 Berlin (CET); an event in summer moved 09:00 → 10:00 CEST.
    const master = {
      start: Date.UTC(2027, 0, 4, 8),
      end: Date.UTC(2027, 0, 4, 9),
      allDay: false,
      startDate: null,
      endDate: null
    }
    const after = {
      start: Date.UTC(2027, 6, 5, 8),
      end: Date.UTC(2027, 6, 5, 9, 30),
      allDay: false,
      startDate: null,
      endDate: null
    }
    expect(seriesTimes(master, 'Europe/Berlin', '2027-07-05', after)).toEqual({
      ...master,
      start: Date.UTC(2027, 0, 4, 9),
      end: Date.UTC(2027, 0, 4, 10, 30)
    })
    // A new zone without DST: 17:00 in Tokyo in July is 17:00 in Tokyo in January too.
    expect(seriesTimes(master, 'Europe/Berlin', '2027-07-05', after, 'Asia/Tokyo').start).toBe(
      Date.UTC(2027, 0, 4, 8)
    )
    // The first event moved a day: the series starts a day later.
    expect(
      seriesTimes(master, 'Europe/Berlin', '2027-01-04', {
        ...after,
        start: Date.UTC(2027, 0, 5, 8),
        end: Date.UTC(2027, 0, 5, 9)
      }).start
    ).toBe(Date.UTC(2027, 0, 5, 8))
  })
})
