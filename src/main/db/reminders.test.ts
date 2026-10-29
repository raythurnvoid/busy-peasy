import { beforeEach, describe, expect, it } from 'vitest'
import type { EventReminder } from '../../shared/api'
import { snoozeUntil } from '../../shared/reminders'
import { toRecord as outlookRecord } from '../providers/outlook/map'
import { setAccountStatus, syncCalendarList, upsertAccount } from './accounts'
import { openDb, type Db } from './db'
import { getEventByRemoteId, upsertEvents, type EventRecord } from './events'
import { ackReminder, listReminders, saveEventReminders } from './reminders'
import { saveSettings } from './settings'

// Set before any Date is made. All-day reminders use local time; the other tests use UTC ms.
process.env.TZ = 'Europe/Berlin'

const MIN = 60_000
const T0 = Date.UTC(2026, 10, 16, 9) // the meeting starts here

function record(remoteId: string, extra: Partial<EventRecord> = {}): EventRecord {
  return {
    remoteId,
    kind: 'single',
    seriesRemoteId: null,
    icalUid: null,
    version: '1',
    title: remoteId,
    start: T0,
    end: T0 + 30 * MIN,
    allDay: false,
    startDate: null,
    endDate: null,
    startTz: null,
    endTz: null,
    location: '',
    joinUrl: 'https://meet.google.com/abc-defg-hij',
    description: '',
    showAs: 'busy',
    response: 'accepted',
    isOrganizer: false,
    attendeeCount: 2,
    cancelled: false,
    reminders: [15],
    attendees: [],
    organizerEmail: null,
    organizerName: null,
    attendeesOmitted: false,
    responseRequested: null,
    guestsCanModify: null,
    guestsCanInviteOthers: null,
    guestsCanSeeOtherGuests: null,
    privateCopy: false,
    colorId: null,
    eventLabelId: null,
    categories: [],
    originalStart: null,
    recurrence: null,
    body: null,
    webLink: null,
    ...extra
  }
}

const own = (minutes: number, alarm = false): EventReminder => ({ minutes, alarm })

let db: Db
let cal: number
let other: number

beforeEach(() => {
  db = openDb(':memory:')
  const account = upsertAccount(db, 'google', 'me@example.com', null, 0)
  syncCalendarList(db, account, [
    { remoteId: 'primary', name: 'Me', color: '#039BE5', canEdit: true, isPrimary: true, defaultReminders: [], conference: null },
    { remoteId: 'team', name: 'Team', color: '#33B679', canEdit: true, isPrimary: false, defaultReminders: [], conference: null }
  ])
  ;[cal, other] = (db.prepare('SELECT id FROM calendars ORDER BY id').all() as { id: number }[]).map((r) => r.id)
  setAccountStatus(db, account, 'ok', null, T0)
})

const stages = (now: number, since = 0): string[] => {
  const { headsUp, alerts } = listReminders(db, now, since)
  return [...headsUp, ...alerts].map((r) => `${r.title}:${r.stage}`)
}

describe('listReminders', () => {
  it('walks a meeting through its own reminder, the default alarm and started, then stops', () => {
    upsertEvents(db, cal, [record('sync')], 1)
    expect(stages(T0 - 15 * MIN - 1)).toEqual([])
    expect(stages(T0 - 15 * MIN)).toEqual(['sync:heads-up'])
    expect(stages(T0 - 2 * MIN)).toEqual(['sync:alert'])
    expect(stages(T0)).toEqual(['sync:started'])
    expect(stages(T0 + 9 * MIN)).toEqual(['sync:started'])
    expect(stages(T0 + 10 * MIN)).toEqual([])
  })

  it('gives a solo event no meeting alarm, but the defaults for other events', () => {
    upsertEvents(db, cal, [record('focus', { joinUrl: null, attendeeCount: 0 })], 1)
    expect(stages(T0 - MIN)).toEqual(['focus:heads-up'])
    saveSettings(db, { meetingReminders: [], eventReminders: [own(1, true)] })
    expect(stages(T0 - MIN)).toEqual(['focus:alert'])
  })

  it('uses the calendar defaults when the event has none of its own', () => {
    db.prepare("UPDATE calendars SET default_reminders = '[30]' WHERE id = ?").run(cal)
    upsertEvents(db, cal, [record('sync', { reminders: null })], 1)
    expect(stages(T0 - 30 * MIN)).toEqual(['sync:heads-up'])
  })

  it('keeps ringing an alarm that is not answered when a later notification fires', () => {
    upsertEvents(db, cal, [record('sync', { reminders: [5] })], 1)
    saveSettings(db, { meetingReminders: [own(10, true)], eventReminders: [] })
    expect(stages(T0 - 10 * MIN)).toEqual(['sync:alert'])
    expect(stages(T0 - 5 * MIN)).toEqual(['sync:alert'])
  })

  it('skips reminders missed while the app was off, unless the event is about to start', () => {
    upsertEvents(db, cal, [record('sync', { reminders: [60] })], 1)
    expect(stages(T0 - 30 * MIN, T0 - 40 * MIN)).toEqual([])
    expect(stages(T0 - 30 * MIN, T0 - 70 * MIN)).toEqual(['sync:heads-up'])
    // The 2 min alarm fired before the app started, but the meeting starts in 1 min.
    expect(stages(T0 - MIN, T0 - MIN)).toEqual(['sync:alert'])
  })

  it('skips declined, cancelled, master and hidden-calendar events', () => {
    upsertEvents(
      db,
      cal,
      [
        record('declined', { response: 'declined' }),
        record('cancelled', { cancelled: true }),
        // Its midnight reminder would show all that day.
        record('declined-all-day', {
          response: 'declined',
          allDay: true,
          startDate: '2026-11-16',
          endDate: '2026-11-17',
          start: Date.UTC(2026, 10, 16),
          end: Date.UTC(2026, 10, 17),
          reminders: [0]
        }),
        record('master', { kind: 'master' })
      ],
      1
    )
    upsertEvents(db, other, [record('hidden')], 1)
    db.prepare('UPDATE calendars SET visible = 0 WHERE id = ?').run(other)
    expect(stages(T0 - MIN)).toEqual([])
  })

  it('stops when the meeting ends, even before the late limit', () => {
    upsertEvents(db, cal, [record('short', { end: T0 + 5 * MIN })], 1)
    expect(stages(T0 + 4 * MIN)).toEqual(['short:started'])
    expect(stages(T0 + 5 * MIN)).toEqual([])
  })

  it('reminds once for the same meeting in two calendars', () => {
    upsertEvents(db, cal, [record('a', { icalUid: 'uid-1', title: 'Sync', joinUrl: null })], 1)
    upsertEvents(db, other, [record('b', { icalUid: 'uid-1', title: 'Sync (copy)' })], 1)
    const { alerts } = listReminders(db, T0 - MIN)
    expect(alerts).toHaveLength(1)
    // The join link comes from whichever copy has one.
    expect(alerts[0].joinUrl).toBe('https://meet.google.com/abc-defg-hij')
  })

  it('keeps two meetings with one title apart in one account', () => {
    upsertEvents(db, cal, [record('a', { icalUid: 'uid-1', title: 'Sync' })], 1)
    upsertEvents(db, other, [record('b', { icalUid: 'uid-2', title: 'Sync' })], 1)
    expect(listReminders(db, T0 - MIN).alerts).toHaveLength(2)
  })

  it('joins copies across accounts by title, and takes the link of the accepted copy', () => {
    const work = upsertAccount(db, 'outlook', 'me@work.example', null, 0)
    syncCalendarList(db, work, [{ remoteId: 'w', name: 'Work', color: '#7986CB', canEdit: true, isPrimary: true, defaultReminders: [], conference: null }])
    const workCal = (db.prepare('SELECT id FROM calendars WHERE account_id = ?').get(work) as { id: number }).id
    // An invite from anyone with the same title and time must not win the Join button.
    upsertEvents(db, cal, [record('spam', { icalUid: 'uid-x', title: 'Sync', joinUrl: 'https://evil.zoom.us/j/1', response: 'none' })], 1)
    upsertEvents(db, workCal, [record('real', { icalUid: 'uid-y', title: 'Sync', joinUrl: 'https://teams.microsoft.com/l/meetup-join/1' })], 1)
    const { alerts } = listReminders(db, T0 - MIN)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].joinUrl).toBe('https://teams.microsoft.com/l/meetup-join/1')
  })

  it('lists accounts that have not synced for 15 min', () => {
    expect(listReminders(db, T0 + 15 * MIN).stale).toEqual([])
    expect(listReminders(db, T0 + 15 * MIN + 1).stale).toEqual(['me@example.com'])
  })
})

// Tue 17 Nov 2026, all day. Providers store UTC midnight of the dates.
const allDayTimes = { allDay: true, startDate: '2026-11-17', endDate: '2026-11-18', start: Date.UTC(2026, 10, 17), end: Date.UTC(2026, 10, 18) }
const allDay = (remoteId: string, extra: Partial<EventRecord> = {}): EventRecord =>
  record(remoteId, { ...allDayTimes, joinUrl: null, attendeeCount: 0, reminders: [420], ...extra })
// Local (Berlin) wall time in November 2026.
const at = (day: number, hour: number, minute = 0): number => new Date(2026, 10, day, hour, minute).getTime()

describe('all-day reminders', () => {
  it('fire from local midnight of the date', () => {
    upsertEvents(db, cal, [allDay('x')], 1)
    expect(stages(at(16, 17) - 1000)).toEqual([])
    expect(stages(at(16, 17))).toEqual(['x:heads-up'])
    expect(listReminders(db, at(16, 17)).headsUp[0].start).toBe(new Date(2026, 10, 17).getTime())
  })

  it('ring as an alarm, never as "started", also on the day', () => {
    upsertEvents(db, cal, [allDay('x')], 1)
    saveEventReminders(db, cal, 'x', [own(-540, true)], [420], true)
    expect(stages(at(17, 9))).toEqual(['x:alert'])
  })

  it("use the all-day defaults, not the calendar's or the timed ones", () => {
    db.prepare("UPDATE calendars SET default_reminders = '[30]' WHERE id = ?").run(cal)
    saveSettings(db, { meetingReminders: [], eventReminders: [own(10)] })
    upsertEvents(db, cal, [allDay('x', { reminders: null })], 1)
    expect(stages(at(16, 23, 55))).toEqual([])
    saveSettings(db, { allDayReminders: [own(-540, true)] })
    expect(stages(at(17, 9))).toEqual(['x:alert'])
  })

  it('show only until the end of the first day', () => {
    upsertEvents(db, cal, [allDay('x', { endDate: '2026-11-20', end: Date.UTC(2026, 10, 20), reminders: [-540] })], 1)
    // After a snooze nothing counts as missed, so only the end of the day stops it.
    const [shown] = listReminders(db, at(17, 23, 40)).headsUp
    ackReminder(db, shown.eventId, shown.fireAt - 1, at(17, 23, 50), at(17, 23, 40))
    expect(stages(at(17, 23, 59))).toEqual(['x:heads-up'])
    expect(stages(at(18, 0))).toEqual([])
  })

  it('still show after a login on the day or a restart the night before; older ones are missed', () => {
    const wednesday = { startDate: '2026-11-18', endDate: '2026-11-19', start: Date.UTC(2026, 10, 18), end: Date.UTC(2026, 10, 19) }
    upsertEvents(db, cal, [allDay('x', { reminders: [-540] }), allDay('y', wednesday)], 1)
    // On the same day at 09:00, login at 08:30 or 10:00.
    expect(stages(at(17, 9), at(17, 8, 30))).toEqual(['x:heads-up'])
    expect(stages(at(17, 10), at(17, 10))).toEqual(['x:heads-up'])
    // The day before at 17:00, login at 18:00 or restart at 23:55. x still shows until its day ends.
    expect(stages(at(17, 18), at(17, 18))).toEqual(['x:heads-up', 'y:heads-up'])
    expect(stages(at(17, 23, 56), at(17, 23, 55))).toEqual(['x:heads-up', 'y:heads-up'])
    // 1 week before at 17:00 (10 Nov), app started on 12 Nov, or on 10 Nov and running since (accepted cost).
    upsertEvents(db, cal, [allDay('x', { reminders: [7 * 1440 - 1020] })], 2)
    expect(stages(at(12, 9, 1), at(12, 9))).toEqual([])
    expect(stages(at(12, 9, 1), at(10, 9))).toEqual([])
  })

  it("never ring yesterday's time when a setting is saved today", () => {
    upsertEvents(db, cal, [allDay('x', { reminders: null })], 1)
    // At 11:20 the user saves "The day before at 12:00" (12 h before midnight).
    saveSettings(db, { allDayReminders: [own(720, true)] })
    // App started today at 08:00, or yesterday at 08:00 and running in the tray since.
    expect(stages(at(17, 11, 20), at(17, 8))).toEqual([])
    expect(stages(at(17, 11, 20), at(16, 8))).toEqual([])
  })

  it('read Outlook all-day minutes from local midnight too', () => {
    const start = { DateTime: '2026-11-17T00:00:00.0000000', TimeZone: 'UTC' }
    const end = { DateTime: '2026-11-18T00:00:00.0000000', TimeZone: 'UTC' }
    // Outlook web's 18 hours: 06:00 the day before.
    const outlook = outlookRecord({ Id: 'o', Subject: 'o', IsAllDay: true, Start: start, End: end, IsReminderOn: true, ReminderMinutesBeforeStart: 1080 })
    upsertEvents(db, cal, [outlook], 1)
    expect(stages(at(16, 6) - 1000)).toEqual([])
    expect(stages(at(16, 6))).toEqual(['o:heads-up'])
  })

  it('saved for all events of an all-day series, they fire for each event', () => {
    const next = { startDate: '2026-11-24', endDate: '2026-11-25', start: Date.UTC(2026, 10, 24), end: Date.UTC(2026, 10, 25) }
    upsertEvents(db, cal, [allDay('a', { seriesRemoteId: 'm', reminders: null }), allDay('b', { ...next, seriesRemoteId: 'm', reminders: null })], 1)
    saveEventReminders(db, cal, 'm', [own(420, true)], [], true)
    expect(stages(at(16, 17))).toEqual(['a:alert'])
    expect(stages(at(23, 17))).toEqual(['b:alert'])
  })

  it('keep their dismiss until the day ends, also west of UTC', () => {
    process.env.TZ = 'America/New_York'
    try {
      const thursday = { startDate: '2026-11-19', endDate: '2026-11-20', start: Date.UTC(2026, 10, 19), end: Date.UTC(2026, 10, 20) }
      upsertEvents(db, cal, [allDay('x', { ...thursday, reminders: [-540] })], 1)
      const morning = new Date(2026, 10, 19, 9, 5).getTime()
      const [shown] = listReminders(db, morning).headsUp
      ackReminder(db, shown.eventId, shown.fireAt, null, morning)
      // 19:01 in New York is the next day in UTC. Any answer then cleans up old acks.
      const evening = new Date(2026, 10, 19, 19, 1).getTime()
      ackReminder(db, -1, 0, null, evening)
      expect(stages(evening + MIN)).toEqual([])
    } finally {
      process.env.TZ = 'Europe/Berlin'
    }
  })
})

describe('saveEventReminders', () => {
  it('replace the defaults, and keep alarm flags and reminders only this app has', () => {
    upsertEvents(db, cal, [record('sync')], 1)
    saveEventReminders(db, cal, 'sync', [own(15, true), own(5, true)], [15], false)
    expect(stages(T0 - 15 * MIN)).toEqual(['sync:alert'])
    const [alert] = listReminders(db, T0 - 2 * MIN).alerts
    // The 5 min one, not the 2 min meeting default.
    expect(alert.fireAt).toBe(T0 - 5 * MIN)
  })

  it('follow changes made in Google or Outlook after the save', () => {
    upsertEvents(db, cal, [record('sync')], 1)
    saveEventReminders(db, cal, 'sync', [own(15, true)], [15], false)
    // Moved from 15 to 30 in Outlook: the old one goes, the new one comes as a notification.
    upsertEvents(db, cal, [record('sync', { reminders: [30] })], 2)
    expect(stages(T0 - 30 * MIN)).toEqual(['sync:heads-up'])
    expect(listReminders(db, T0 - 15 * MIN).headsUp[0].fireAt).toBe(T0 - 30 * MIN)
  })

  it('a provider reminder removed only in this app (view-only calendar) stays removed', () => {
    upsertEvents(db, cal, [record('sync')], 1)
    saveEventReminders(db, cal, 'sync', [own(1, true)], [15], false)
    expect(stages(T0 - 10 * MIN)).toEqual([])
    expect(stages(T0 - MIN)).toEqual(['sync:alert'])
  })

  it('saved for all events of a series, they fire for each event without its own', () => {
    upsertEvents(db, cal, [record('o1', { seriesRemoteId: 'm' }), record('o2', { seriesRemoteId: 'm' })], 1)
    saveEventReminders(db, cal, 'm', [own(5, true)], [15], false)
    saveEventReminders(db, cal, 'o2', [own(1, true)], [15], false)
    expect(stages(T0 - 5 * MIN)).toEqual(['o1:alert'])
  })

  it('made for the other kind of event, they do not count (Google or Outlook changed it)', () => {
    // 10 min, alarm, on a timed event. Then it becomes all-day in Google: not "the day before at 23:50, alarm".
    upsertEvents(db, cal, [record('x', { joinUrl: null, attendeeCount: 0 })], 1)
    saveEventReminders(db, cal, 'x', [own(10, true)], [15], false)
    upsertEvents(db, cal, [allDay('x')], 2)
    expect(stages(at(16, 23, 50))).toEqual(['x:heads-up'])
    expect(getEventByRemoteId(db, cal, 'x')!.reminders).toEqual([own(420)])
    // And the other way: "on the same day" never reaches a timed event.
    upsertEvents(db, cal, [record('sync')], 1)
    saveEventReminders(db, cal, 'sync', [own(10), own(-540, true)], [15], true)
    // Google's 15 and the meeting default.
    expect(getEventByRemoteId(db, cal, 'sync')!.reminders).toEqual([own(15), own(2, true)])
  })

  it('set on one copy of a meeting, they win over the other copies', () => {
    upsertEvents(db, cal, [record('a', { icalUid: 'uid-1' })], 1)
    upsertEvents(db, other, [record('b', { icalUid: 'uid-1' })], 1)
    saveEventReminders(db, cal, 'a', [own(5)], [15], false)
    expect(stages(T0 - 10 * MIN)).toEqual([])
    expect(stages(T0 - MIN)).toEqual(['a:heads-up'])
  })
})

describe('ackReminder', () => {
  it('a dismissed notification still lets the later alarm come', () => {
    upsertEvents(db, cal, [record('sync')], 1)
    const [headsUp] = listReminders(db, T0 - 5 * MIN).headsUp
    ackReminder(db, headsUp.eventId, headsUp.fireAt, null, T0 - 5 * MIN)
    expect(stages(T0 - 5 * MIN)).toEqual([])
    expect(stages(T0 - MIN)).toEqual(['sync:alert'])
  })

  it('a dismissed alarm stays dismissed after the start', () => {
    upsertEvents(db, cal, [record('sync')], 1)
    const [alert] = listReminders(db, T0 - MIN).alerts
    ackReminder(db, alert.eventId, alert.fireAt, null, T0 - MIN)
    expect(stages(T0 + MIN)).toEqual([])
  })

  it('a snooze never hides a later alarm of the event', () => {
    upsertEvents(db, cal, [record('sync', { reminders: [1440] })], 1)
    saveSettings(db, { meetingReminders: [own(10, true)], eventReminders: [] })
    const now = T0 - 1440 * MIN
    const [headsUp] = listReminders(db, now).headsUp
    // Google's rule alone would be 1 min before the start.
    ackReminder(db, headsUp.eventId, headsUp.fireAt - 1, snoozeUntil(now, headsUp, 0), now)
    expect(stages(T0 - 10 * MIN - 1)).toEqual([])
    expect(stages(T0 - 10 * MIN)).toEqual(['sync:alert'])
  })

  it('a snooze never hides a later notification of the event', () => {
    upsertEvents(db, cal, [record('focus', { joinUrl: null, attendeeCount: 0, reminders: [1440, 60] })], 1)
    const now = T0 - 1440 * MIN
    const [headsUp] = listReminders(db, now).headsUp
    // Google's rule alone would be 1 min before the start.
    ackReminder(db, headsUp.eventId, headsUp.fireAt - 1, snoozeUntil(now, headsUp, 0), now)
    expect(stages(T0 - 60 * MIN - 1)).toEqual([])
    expect(stages(T0 - 60 * MIN)).toEqual(['focus:heads-up'])
  })

  it('an alarm added during a snooze rings when it is due', () => {
    upsertEvents(db, cal, [record('focus', { joinUrl: null, attendeeCount: 0 })], 1)
    const now = T0 - 15 * MIN
    const [headsUp] = listReminders(db, now).headsUp
    // Snoozed until 1 min before the start: there was no later reminder then.
    ackReminder(db, headsUp.eventId, headsUp.fireAt - 1, snoozeUntil(now, headsUp, 0), now)
    saveSettings(db, { eventReminders: [own(5, true)] })
    expect(stages(T0 - 5 * MIN - 1)).toEqual([])
    expect(stages(T0 - 5 * MIN)).toEqual(['focus:alert'])
  })

  it('a snoozed meeting comes back past the late limit, for 10 min each time', () => {
    upsertEvents(db, cal, [record('sync', { end: T0 + 60 * MIN })], 1)
    const [alert] = listReminders(db, T0 + 5 * MIN).alerts
    ackReminder(db, alert.eventId, alert.fireAt - 1, T0 + 20 * MIN, T0 + 5 * MIN)
    expect(stages(T0 + 20 * MIN - 1)).toEqual([])
    expect(stages(T0 + 20 * MIN)).toEqual(['sync:started'])
    expect(stages(T0 + 30 * MIN - 1)).toEqual(['sync:started'])
    expect(stages(T0 + 30 * MIN)).toEqual([])
  })

  it('a snooze comes back after a restart', () => {
    upsertEvents(db, cal, [record('focus', { joinUrl: null, attendeeCount: 0, reminders: [60] })], 1)
    const [headsUp] = listReminders(db, T0 - 60 * MIN).headsUp
    ackReminder(db, headsUp.eventId, headsUp.fireAt - 1, T0 - MIN, T0 - 60 * MIN)
    // The app starts again at T-30: the 60 min reminder fired before that, but it was snoozed.
    expect(stages(T0 - MIN, T0 - 30 * MIN)).toEqual(['focus:heads-up'])
  })

  it('snooze hides the alert until the snooze ends', () => {
    upsertEvents(db, cal, [record('sync')], 1)
    const [alert] = listReminders(db, T0 - MIN).alerts
    ackReminder(db, alert.eventId, alert.fireAt - 1, T0, T0 - MIN)
    expect(stages(T0 - 30_000)).toEqual([])
    expect(stages(T0)).toEqual(['sync:started'])
  })

  it('join silences every copy of the meeting, and a moved meeting reminds again', () => {
    upsertEvents(db, cal, [record('a', { icalUid: 'uid-1' })], 1)
    upsertEvents(db, other, [record('b', { icalUid: 'uid-1' })], 1)
    const [alert] = listReminders(db, T0 - MIN).alerts
    ackReminder(db, alert.eventId, T0, null, T0 - MIN)
    expect(stages(T0)).toEqual([])
    upsertEvents(db, other, [record('b', { icalUid: 'uid-1', start: T0 + 5 * MIN, end: T0 + 35 * MIN })], 2)
    expect(stages(T0 + 4 * MIN)).toEqual(['b:alert'])
  })
})
