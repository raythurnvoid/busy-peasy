import type { Settings } from './api'

// Meetings ring 2 min before, like the app did before reminders could be set.
// The other defaults keep the app as it was before these settings existed.
export const DEFAULT_SETTINGS: Settings = {
  meetingReminders: [{ minutes: 2, alarm: true }],
  eventReminders: [],
  // Nothing new rings unless the user sets it.
  allDayReminders: [],
  hour12: null,
  weekStart: null,
  showWeekends: true,
  eventMinutes: 60,
  showDeclined: true,
  theme: 'system',
  secondaryTimeZone: null,
  secondaryTimeZoneLabel: ''
}

// Google Calendar's choices. Main stores no other value, so the Settings dialog can always show it.
export const EVENT_MINUTES = [15, 20, 30, 45, 60, 90, 120]
// Saturday, Sunday, Monday (0 = Sunday ... 6 = Saturday).
export const WEEK_STARTS = [6, 0, 1]
// Characters of the secondary time zone label. Our cap (Google's not checked); the gutter cuts longer ones, the title shows all.
export const MAX_ZONE_LABEL = 20
