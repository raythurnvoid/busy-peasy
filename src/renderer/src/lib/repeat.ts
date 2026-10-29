import type { Repeat, Scope, Series, Times } from '../../../shared/api'
import { addDate, dayOf, isLast, nth, scopeChoices, weekday } from '../../../shared/repeat'
import { pcZone } from './time'

// Google's words for repeat rules. Dates are YYYY-MM-DD: the series' first date. locale: the system language, unless a
// test pins one.

const ORDINALS = ['first', 'second', 'third', 'fourth']

export const rule = (extra: Partial<Repeat>): Repeat => ({
  freq: 'daily',
  interval: 1,
  days: [],
  monthly: 'day',
  until: null,
  count: null,
  ...extra
})

// 1 Nov 2026 is a Sunday.
const weekdayName = (day: number, locale?: string): string =>
  new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(
    Date.UTC(2026, 10, 1 + day)
  )
// "1 December" in en-GB. Google writes "December 1" in any English; the app's language order wins.
const dayMonth = (date: string, locale?: string): string =>
  new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(
    Date.parse(date)
  )

// Google's choices for a start date, in Google's order. "Monthly on the last ..." only on the last such weekday, the nth
// one only up to the fourth.
export function presets(date: string, locale?: string): { label: string; repeat: Repeat | null }[] {
  const day = weekday(date)
  const name = weekdayName(day, locale)
  const list = [
    { label: 'Does not repeat', repeat: null },
    { label: 'Daily', repeat: rule({}) },
    { label: `Weekly on ${name}`, repeat: rule({ freq: 'weekly', days: [day] }) }
  ]
  if (nth(date) <= 4)
    list.push({
      label: monthlyText('weekday', date, locale),
      repeat: rule({ freq: 'monthly', monthly: 'weekday' })
    })
  if (isLast(date))
    list.push({
      label: monthlyText('last', date, locale),
      repeat: rule({ freq: 'monthly', monthly: 'last' })
    })
  list.push({ label: `Annually on ${dayMonth(date, locale)}`, repeat: rule({ freq: 'yearly' }) })
  // Not on a weekend: the first event would not be one of the rule's days. Differs from Google.
  if (day !== 0 && day !== 6)
    list.push({
      label: 'Every weekday (Monday to Friday)',
      repeat: rule({ freq: 'weekly', days: [1, 2, 3, 4, 5] })
    })
  return list
}

// "Monthly on day 8", "Monthly on the second Tuesday" or "Monthly on the last Tuesday", for the date.
export function monthlyText(monthly: Repeat['monthly'], date: string, locale?: string): string {
  if (monthly === 'day') return `Monthly on day ${Number(date.slice(8))}`
  const which = monthly === 'last' ? 'last' : ORDINALS[nth(date) - 1]
  return `Monthly on the ${which} ${weekdayName(weekday(date), locale)}`
}

// "Weekly on Tuesday, 6 times", like Google's popover and select.
export function repeatText(r: Repeat, date: string, locale?: string): string {
  if (r.count === 1) return 'Once'
  const every = (one: string, unit: string): string =>
    r.interval === 1 ? one : `Every ${r.interval} ${unit}`
  let text: string
  if (r.freq === 'daily') {
    text = every('Daily', 'days')
  } else if (r.freq === 'weekly') {
    const days =
      r.days.length === 7
        ? 'all days'
        : r.days.join() === '1,2,3,4,5'
          ? 'weekdays'
          : r.days.map((d) => weekdayName(d, locale)).join(', ')
    text = `${every('Weekly', 'weeks')} on ${days}`
  } else if (r.freq === 'monthly') {
    text = monthlyText(r.monthly, date, locale).replace('Monthly', every('Monthly', 'months'))
  } else {
    text = `${every('Annually', 'years')} on ${dayMonth(date, locale)}`
  }
  if (r.count !== null) return `${text}, ${r.count} times`
  if (r.until === null) return text
  const until = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC'
  }).format(Date.parse(r.until))
  return `${text}, until ${until}`
}

// What the Custom dialog's end fields start with, like Google: 30 days, 13 weeks, 12 months or 5 years.
export function customDefaults(
  freq: Repeat['freq'],
  date: string
): { count: number; until: string } {
  const [y, m, d] = date.split('-').map(Number)
  const plus = (years: number, months: number): string =>
    new Date(Date.UTC(y + years, m - 1 + months, d)).toISOString().slice(0, 10)
  if (freq === 'daily') return { count: 30, until: addDate(date, 30) }
  if (freq === 'weekly') return { count: 13, until: addDate(date, 91) }
  if (freq === 'monthly') return { count: 12, until: plus(0, 12) }
  return { count: 5, until: plus(5, 0) }
}

// The first date of a series, in its zone (this PC's when the app does not know it).
const firstDate = (series: Series, allDay: boolean): string =>
  dayOf({ start: series.first, allDay }, series.zone ?? pcZone()).date

// The popover's line: the rule in Google's words, or "Repeating event" for one the app cannot read.
export function seriesText(series: Series, allDay: boolean, locale?: string): string {
  return series.repeat
    ? repeatText(series.repeat, firstDate(series, allDay), locale)
    : 'Repeating event'
}

// The scopes to offer for a change of one event of the user's own series from `before` to `after`, with the dates in
// the series' zone, like main checks them. A rule that did not load (offline): this event only. outlook: an Outlook
// change (not a delete). main never splits it, and new times or a new rule for all events bring deleted events back
// there, so those change this event only. main keeps its own check (event-writes.ts).
export function choicesFor(
  series: Series | null,
  before: Times,
  after: Times & { timeZone?: string },
  o: { rule?: Repeat; ownOnly?: boolean; outlook?: boolean } = {}
): Scope[] {
  if (!series) return ['event']
  const zone = series.zone ?? pcZone()
  const date = (t: Times): string => dayOf(t, zone).date
  const choices = scopeChoices({
    repeat: series.repeat,
    firstDate: firstDate(series, before.allDay),
    from: date(before),
    to: date(after),
    rule: o.rule,
    ownOnly: o.ownOnly,
    split: !o.outlook
  })
  const timed =
    (['start', 'end', 'allDay'] as const).some((k) => after[k] !== before[k]) ||
    after.timeZone !== undefined
  return o.outlook && (timed || o.rule) ? choices.filter((s) => s === 'event') : choices
}

// The scope question is skipped only for one choice that is not a split. A split cannot be undone, so the user always
// sees its note and says OK, like Google always asks about a new rule.
export const asksScope = (choices: Scope[]): boolean =>
  choices.length > 1 || choices[0] === 'following'
