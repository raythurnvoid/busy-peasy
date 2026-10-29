import { beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from './db'
import { getSettings, saveSettings } from './settings'

let db: Db

beforeEach(() => {
  db = openDb(':memory:')
})

describe('settings', () => {
  it('defaults keep the app as it was', () => {
    expect(getSettings(db)).toEqual({
      meetingReminders: [{ minutes: 2, alarm: true }],
      eventReminders: [],
      allDayReminders: [],
      hour12: null,
      weekStart: null,
      showWeekends: true,
      eventMinutes: 60,
      showDeclined: true,
      theme: 'system',
      secondaryTimeZone: null,
      secondaryTimeZoneLabel: ''
    })
  })

  it('stored keys win, missing keys use the defaults', () => {
    // An old DB has only the reminder keys.
    saveSettings(db, { meetingReminders: [] })
    saveSettings(db, { theme: 'dark', weekStart: 1, hour12: true })
    saveSettings(db, { hour12: null })
    expect(getSettings(db)).toMatchObject({ meetingReminders: [], theme: 'dark', weekStart: 1, hour12: null, showDeclined: true })
  })
})
