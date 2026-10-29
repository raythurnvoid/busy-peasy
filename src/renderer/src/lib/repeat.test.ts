import { describe, expect, it } from 'vitest'
import type { Repeat, Times } from '../../../shared/api'
import { asksScope, choicesFor, customDefaults, presets, repeatText, seriesText } from './repeat'

// Set before any Date is made, like time.test.ts.
process.env.TZ = 'Europe/Berlin'

const rule = (extra: Partial<Repeat>): Repeat => ({
  freq: 'weekly',
  interval: 1,
  days: [2],
  monthly: 'day',
  until: null,
  count: null,
  ...extra
})
const labels = (date: string): string[] => presets(date, 'en-GB').map((p) => p.label)

describe('presets', () => {
  it("lists Google's choices for the date (live 2026-10-28)", () => {
    expect(labels('2026-12-01')).toEqual([
      'Does not repeat',
      'Daily',
      'Weekly on Tuesday',
      'Monthly on the first Tuesday',
      'Annually on 1 December',
      'Every weekday (Monday to Friday)'
    ])
    // The fifth Tuesday: only "last".
    expect(labels('2026-12-29')).toEqual([
      'Does not repeat',
      'Daily',
      'Weekly on Tuesday',
      'Monthly on the last Tuesday',
      'Annually on 29 December',
      'Every weekday (Monday to Friday)'
    ])
    // The fourth Wednesday is also the last one: both.
    expect(labels('2026-11-25')).toContain('Monthly on the fourth Wednesday')
    expect(labels('2026-11-25')).toContain('Monthly on the last Wednesday')
    // A weekend day has no "Every weekday".
    expect(labels('2026-12-05')).not.toContain('Every weekday (Monday to Friday)')
  })
})

describe('repeatText', () => {
  it("says the rule in Google's words", () => {
    const cases: [Partial<Repeat>, string, string][] = [
      [{ freq: 'daily', days: [] }, '2026-12-01', 'Daily'],
      [{ freq: 'daily', days: [], interval: 3 }, '2026-12-01', 'Every 3 days'],
      [{ freq: 'daily', days: [], count: 1 }, '2026-12-01', 'Once'],
      [{ count: 6 }, '2026-12-08', 'Weekly on Tuesday, 6 times'],
      [{ interval: 2, days: [2, 4] }, '2026-12-01', 'Every 2 weeks on Tuesday, Thursday'],
      [{ days: [1, 2, 3, 4, 5] }, '2026-12-01', 'Weekly on weekdays'],
      [{ days: [0, 1, 2, 3, 4, 5, 6] }, '2026-12-01', 'Weekly on all days'],
      [{ freq: 'monthly', days: [] }, '2026-12-01', 'Monthly on day 1'],
      [
        { freq: 'monthly', days: [], monthly: 'weekday' },
        '2026-12-01',
        'Monthly on the first Tuesday'
      ],
      [{ freq: 'monthly', days: [], monthly: 'last' }, '2026-12-29', 'Monthly on the last Tuesday'],
      [
        { freq: 'monthly', days: [], monthly: 'weekday', interval: 2 },
        '2026-12-01',
        'Every 2 months on the first Tuesday'
      ],
      [{ freq: 'yearly', days: [] }, '2026-12-01', 'Annually on 1 December'],
      [{ freq: 'yearly', days: [], interval: 2 }, '2026-12-01', 'Every 2 years on 1 December'],
      [{ freq: 'daily', days: [], count: 5 }, '2026-12-01', 'Daily, 5 times'],
      [{ until: '2027-03-02' }, '2026-12-01', 'Weekly on Tuesday, until 2 Mar 2027']
    ]
    for (const [r, date, text] of cases) expect(repeatText(rule(r), date, 'en-GB')).toBe(text)
  })
})

describe('customDefaults', () => {
  it("starts the end fields like Google's Custom dialog", () => {
    expect(customDefaults('weekly', '2026-12-01')).toEqual({ count: 13, until: '2027-03-02' })
    expect(customDefaults('daily', '2026-12-01')).toEqual({ count: 30, until: '2026-12-31' })
    expect(customDefaults('monthly', '2026-12-01')).toEqual({ count: 12, until: '2027-12-01' })
    expect(customDefaults('yearly', '2026-12-01')).toEqual({ count: 5, until: '2031-12-01' })
  })
})

// A series in Tokyo: Tue 1 Dec 2026, 07:00 there, is still Mon 30 Nov in this PC's zone (Berlin).
const tokyo = { first: Date.UTC(2026, 10, 30, 22), zone: 'Asia/Tokyo' }
const at = (start: number): Times => ({
  start,
  end: start + 3600_000,
  allDay: false,
  startDate: null,
  endDate: null
})

describe('seriesText', () => {
  it("says the rule from the series' first date in its zone, and a plain line for a rule the app cannot read", () => {
    expect(
      seriesText({ ...tokyo, repeat: rule({ freq: 'monthly', days: [] }) }, false, 'en-GB')
    ).toBe('Monthly on day 1')
    expect(seriesText({ ...tokyo, repeat: null }, false, 'en-GB')).toBe('Repeating event')
  })
})

describe('choicesFor', () => {
  it("compares dates in the series' zone, like main", () => {
    const series = { ...tokyo, repeat: rule({}) }
    // Tue 8 Dec 07:00 to 08:00 in Tokyo: the same day there, though Berlin's date changes.
    const event = at(Date.UTC(2026, 11, 7, 22))
    expect(choicesFor(series, event, at(event.start + 3600_000))).toEqual([
      'event',
      'following',
      'series'
    ])
    expect(choicesFor(series, at(tokyo.first), at(tokyo.first + 3600_000))).toEqual([
      'event',
      'series'
    ])
  })

  it('never splits an Outlook change, and gives new times, zones or rules to this Outlook event only', () => {
    const series = { ...tokyo, repeat: rule({}) }
    const event = at(Date.UTC(2026, 11, 7, 22))
    expect(choicesFor(series, event, event, { outlook: true })).toEqual(['event', 'series'])
    expect(choicesFor(series, event, at(event.start + 3600_000), { outlook: true })).toEqual([
      'event'
    ])
    expect(
      choicesFor(series, event, { ...event, timeZone: 'Europe/Lisbon' }, { outlook: true })
    ).toEqual(['event'])
    expect(choicesFor(series, event, event, { outlook: true, rule: rule({ count: 3 }) })).toEqual(
      []
    )
  })

  it('offers this event only when the rule did not load', () => {
    expect(choicesFor(null, at(tokyo.first), at(tokyo.first + 3600_000))).toEqual(['event'])
  })

  it('asks which events unless there is one choice that is not a split (U-M1)', () => {
    // A new monthly rule on a later event can only be "This and following": the user still sees its note and says OK.
    const event = at(Date.UTC(2026, 11, 7, 22))
    const choices = choicesFor({ ...tokyo, repeat: rule({}) }, event, event, {
      rule: rule({ freq: 'monthly', days: [], monthly: 'weekday' })
    })
    expect(choices).toEqual(['following'])
    expect(asksScope(choices)).toBe(true)
    expect(asksScope(['series'])).toBe(false)
    expect(asksScope(['event'])).toBe(false)
    expect(asksScope(['event', 'series'])).toBe(true)
  })
})
