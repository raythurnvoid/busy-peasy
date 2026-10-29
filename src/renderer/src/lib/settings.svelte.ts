import type { Settings, Times } from '../../../shared/api'
import { DEFAULT_SETTINGS } from '../../../shared/settings'
import { hourLabels, timeFormat } from './time'

// The user's settings for this page. Each page (main window, reminder windows) loads its own copy before it mounts,
// and reloads it when main says settings changed. If loading fails, the page keeps the defaults.
export const prefs: { settings: Settings } = $state({ settings: DEFAULT_SETTINGS })

export async function loadSettings(): Promise<void> {
  prefs.settings = await window.api.getSettings()
}

// Times follow the 12h/24h setting, so they are rebuilt when it changes. Dates never change.
const hour12 = $derived(prefs.settings.hour12)
const time = $derived(timeFormat(hour12))
const labels = $derived(hourLabels(hour12))

// Every date and time format the components use. Read it in markup or $derived, so times update with the setting.
export const formats = {
  get time() {
    return time
  },
  get hourLabels() {
    return labels
  },
  // The language's own clock, for the "Default (13:00)" choice.
  languageTime: timeFormat(null),
  weekday: new Intl.DateTimeFormat(undefined, { weekday: 'short' }),
  weekdayNarrow: new Intl.DateTimeFormat(undefined, { weekday: 'narrow' }),
  // Grid cell labels join these with a comma, like Google: "Thursday, 15 April".
  weekdayLong: new Intl.DateTimeFormat(undefined, { weekday: 'long' }),
  dayMonth: new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long' }),
  day: new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' }),
  dayShort: new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' }),
  monthDay: new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }),
  month: new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }),
  // Schedule and search day labels: "OCT, TUE" and "OCT 2026, TUE", like Google.
  monthShort: new Intl.DateTimeFormat(undefined, { month: 'short' }),
  monthYearShort: new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' }),
  date: new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long', year: 'numeric' }),
  // Go to date: "20/10/2026" in en-GB.
  numericDate: new Intl.DateTimeFormat(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' }),
  fullDate: new Intl.DateTimeFormat(undefined, { dateStyle: 'full' })
}

// An event's times in its name for screen readers, like Google: "10:30 to 11:15", or "9 December 2026 at 10:00 to
// 10 December 2026 at 11:00" over days. Words, not a dash: a screen reader does not read the dash.
export function spokenTime(event: Times): string {
  if (event.allDay) return 'All day'
  const { date, time } = formats
  // Strings, not Dates: lint flags new Date() in rune modules.
  if (date.format(event.start) === date.format(event.end - 1)) return `${time.format(event.start)} to ${time.format(event.end)}`
  return `${date.format(event.start)} at ${time.format(event.start)} to ${date.format(event.end)} at ${time.format(event.end)}`
}
