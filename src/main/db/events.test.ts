import { beforeEach, describe, expect, it } from 'vitest'
import type { Guest } from '../../shared/api'
import { saveCategories, saveLabels, syncCalendarList, upsertAccount } from './accounts'
import { openDb, type Db } from './db'
import {
  deleteSeriesInstancesFrom,
  deleteEvents,
  deleteSeriesInstancesExcept,
  getEventByRemoteId,
  getEventDetails,
  getRecord,
  listEventsInRange,
  listPeople,
  searchEvents,
  sweepEvents,
  upsertEvents,
  type EventRecord
} from './events'
import { saveEventReminders } from './reminders'
import { saveSettings } from './settings'

const H = 3600_000
const DAY = 24 * H
const T0 = Date.UTC(2026, 10, 16) // Monday 2026-11-16

function record(remoteId: string, start: number, end: number, extra: Partial<EventRecord> = {}): EventRecord {
  return {
    remoteId,
    kind: 'single',
    seriesRemoteId: null,
    icalUid: null,
    version: '1',
    title: remoteId,
    start,
    end,
    allDay: false,
    startDate: null,
    endDate: null,
    startTz: null,
    endTz: null,
    location: '',
    joinUrl: null,
    description: '',
    showAs: 'busy',
    response: 'organizer',
    isOrganizer: true,
    attendeeCount: 0,
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

let db: Db
let account: number
let cal: number

beforeEach(() => {
  db = openDb(':memory:')
  account = upsertAccount(db, 'google', 'me@example.com', null, 0)
  syncCalendarList(db, account, [{ remoteId: 'primary', name: 'Me', color: '#039BE5', canEdit: true, isPrimary: true, defaultReminders: [], conference: null }])
  cal = (db.prepare('SELECT id FROM calendars').get() as { id: number }).id
})

describe('upsertEvents', () => {
  it('keeps the local id when the same remote event is synced again', () => {
    upsertEvents(db, cal, [record('a', T0, T0 + H)], 1)
    const [first] = listEventsInRange(db, { start: T0, end: T0 + DAY })
    upsertEvents(db, cal, [record('a', T0 + H, T0 + 2 * H, { title: 'moved' })], 2)
    const [second] = listEventsInRange(db, { start: T0, end: T0 + DAY })
    expect(second.id).toBe(first.id)
    expect(second.title).toBe('moved')
    expect(second.start).toBe(T0 + H)
  })

  it('reads back every detail as it was stored', () => {
    const r = record('a', T0, T0 + H, {
      startTz: 'Europe/Rome',
      endTz: 'America/New_York',
      attendees: [{ email: 'ann@x.com', name: 'Ann', response: 'accepted', optional: true }],
      organizerEmail: 'boss@x.com',
      organizerName: 'Boss',
      attendeesOmitted: true,
      responseRequested: true,
      guestsCanModify: false,
      guestsCanInviteOthers: true,
      guestsCanSeeOtherGuests: false,
      privateCopy: true,
      colorId: '11',
      eventLabelId: 'uuid',
      categories: ['Red category'],
      originalStart: T0 - H,
      recurrence: '{"Pattern":{}}',
      body: 'Agenda',
      webLink: 'https://example.com/e'
    })
    upsertEvents(db, cal, [r], 1)
    expect(getRecord(db, cal, 'a')).toEqual(r)
  })
})

describe('event colors', () => {
  const colors = (): Record<string, string | null> =>
    Object.fromEntries(listEventsInRange(db, { start: T0, end: T0 + DAY }).map((e) => [e.title, e.color]))

  it('uses the Google color id; a new-palette label alone keeps the calendar color', () => {
    upsertEvents(db, cal, [record('tomato', T0, T0 + H, { colorId: '11' }), record('label', T0, T0 + H, { eventLabelId: 'uuid' })], 1)
    expect(colors()).toEqual({ tomato: '#D50000', label: null })
  })

  it("uses the label's color over the color id once the labels are known, and says which color it is", () => {
    upsertEvents(
      db,
      cal,
      [
        record('cobalt', T0, T0 + H, { eventLabelId: 'cobalt', colorId: '11' }),
        record('deleted', T0, T0 + H, { eventLabelId: 'gone', colorId: '5' }),
        record('none', T0, T0 + H)
      ],
      1
    )
    saveLabels(db, cal, [{ id: 'cobalt', name: 'Cobalt', color: '#4285F4' }])
    expect(colors()).toEqual({ cobalt: '#4285F4', deleted: '#F6BF26', none: null })
    const keys = Object.fromEntries(listEventsInRange(db, { start: T0, end: T0 + DAY }).map((e) => [e.title, e.colorKey]))
    expect(keys).toEqual({ cobalt: 'cobalt', deleted: '5', none: null })
  })

  it("uses the first Outlook category, in the color the mailbox gives it now", () => {
    upsertEvents(
      db,
      cal,
      [
        record('red', T0, T0 + H, { categories: ['Red category', 'Green category'] }),
        // Outlook colors by the first category, so an unknown first color is not replaced by the second.
        record('first', T0, T0 + H, { categories: ['Odd', 'Green category'] }),
        record('none', T0, T0 + H)
      ],
      1
    )
    // No list from the mailbox yet: the calendar color, and no error.
    expect(colors()).toEqual({ red: null, first: null, none: null })
    saveCategories(db, account, { 'Red category': 'Preset0', 'Green category': 'Preset4', Odd: 'Preset2' })
    expect(colors()).toEqual({ red: '#C50F1F', first: null, none: null })
    // A color changed in Outlook changes no event; the next read shows it.
    saveCategories(db, account, { 'Red category': 'Preset4' })
    expect(colors().red).toBe('#0E7A0B')
    // The key: a first category with any color, also one the app has no hex for.
    saveCategories(db, account, { 'Red category': 'Preset0', Odd: 'Preset2', Plain: 'None' })
    upsertEvents(db, cal, [record('plain', T0, T0 + H, { categories: ['Plain', 'Red category'] })], 1)
    const keys = Object.fromEntries(listEventsInRange(db, { start: T0, end: T0 + DAY }).map((e) => [e.title, e.colorKey]))
    expect(keys).toEqual({ red: 'Red category', first: 'Odd', none: null, plain: null })
  })
})

describe('getEventDetails', () => {
  const guest = (email: string, extra: Partial<Guest> = {}): Guest => ({ email, response: 'none', ...extra })
  const details = (extra: Partial<EventRecord>): ReturnType<typeof getEventDetails> => {
    upsertEvents(db, cal, [record('d', T0, T0 + H, extra)], 1)
    return getEventDetails(db, getEventByRemoteId(db, cal, 'd')!.id)
  }

  it('adds the organizer once, first, when the list leaves them out', () => {
    // A Google event the user organizes: the organizer is not in the list. The account email marks the user.
    expect(details({ organizerEmail: 'ME@example.com', attendees: [guest('ann@x.com')] })?.guests).toEqual([
      { email: 'ME@example.com', response: 'accepted', organizer: true, self: true },
      guest('ann@x.com')
    ])
    const boss = guest('boss@x.com', { name: 'Boss', response: 'accepted', organizer: true })
    expect(details({ organizerEmail: 'boss@x.com', attendees: [guest('ann@x.com'), boss] })?.guests).toEqual([
      boss,
      guest('ann@x.com')
    ])
  })

  it('adds no organizer on a guest copy whose list leaves them out', () => {
    // Google: an event organized by a group calendar lists only the guests.
    const d = details({
      isOrganizer: false,
      response: 'none',
      organizerEmail: 'team@group.x.com',
      attendees: [guest('me@example.com', { self: true })]
    })
    expect(d?.guests).toEqual([guest('me@example.com', { self: true })])
  })

  it("keeps each answer on a shared calendar, where Google's self is the calendar's owner", () => {
    const d = details({
      isOrganizer: false,
      response: 'accepted',
      attendees: [
        guest('colleague@x.com', { response: 'accepted', self: true }),
        guest('me@example.com', { response: 'declined' })
      ]
    })
    expect(d?.guests).toEqual([
      guest('colleague@x.com', { response: 'accepted', self: true }),
      guest('me@example.com', { response: 'declined' })
    ])
  })

  it('lists rooms on their own and optional guests last', () => {
    const d = details({
      organizerEmail: 'boss@x.com',
      organizerName: 'Boss',
      attendees: [guest('opt@x.com', { optional: true }), guest('room@x.com', { name: 'Room 1', resource: true }), guest('ann@x.com')]
    })
    expect(d?.guests.map((g) => g.email)).toEqual(['boss@x.com', 'ann@x.com', 'opt@x.com'])
    expect(d?.guests[0]).toEqual({ email: 'boss@x.com', name: 'Boss', response: 'accepted', organizer: true })
    expect(d?.rooms).toEqual([guest('room@x.com', { name: 'Room 1', resource: true })])
  })

  it("shows the user's own answer, not the stale one in an Outlook guest copy", () => {
    const d = details({
      isOrganizer: false,
      response: 'accepted',
      organizerEmail: 'boss@x.com',
      attendees: [guest('boss@x.com', { response: 'accepted', organizer: true }), guest('me@example.com')]
    })
    expect(d?.guests[1]).toEqual({ email: 'me@example.com', response: 'accepted', self: true })
  })

  it('has no guests and no organizer row for an event without guests', () => {
    expect(details({ organizerEmail: 'me@example.com' })).toEqual({
      guests: [],
      rooms: [],
      guestsOmitted: false,
      body: null,
      webLink: null,
      guestsCanModify: null,
      guestsCanInviteOthers: null,
      guestsCanSeeOtherGuests: null,
      timeZone: null,
      endTimeZone: null
    })
  })

  it('gives IANA zones, also for Outlook names, and none for zones the app does not know', () => {
    const zones = (extra: Partial<EventRecord>): unknown[] => {
      const d = details(extra)
      return [d?.timeZone, d?.endTimeZone]
    }
    expect(zones({ startTz: 'Europe/Rome' })).toEqual(['Europe/Rome', 'Europe/Rome'])
    expect(zones({ startTz: 'Europe/Rome', endTz: 'America/New_York' })).toEqual(['Europe/Rome', 'America/New_York'])
    // The picker lists V8's ids.
    expect(zones({ startTz: 'Asia/Kolkata' })).toEqual(['Asia/Calcutta', 'Asia/Calcutta'])
    expect(zones({ startTz: 'UTC' })).toEqual(['UTC', 'UTC'])
    expect(zones({ startTz: 'tzone://Microsoft/Custom' })).toEqual([null, null])
    expect(zones({ startTz: '+01:00' })).toEqual([null, null])
    expect(zones({ allDay: true, startDate: '2026-11-16', endDate: '2026-11-17', startTz: 'Europe/Rome' })).toEqual([null, null])
    db.prepare("UPDATE accounts SET provider = 'outlook'").run()
    expect(zones({ startTz: 'W. Europe Standard Time', endTz: 'Eastern Standard Time' })).toEqual(['Europe/Berlin', 'America/New_York'])
    // The app's own old writes, not the user's choice.
    expect(zones({ startTz: 'UTC' })).toEqual([null, null])
  })

  it('says when the list is not complete, except to the organizer', () => {
    expect(details({ attendeesOmitted: true })?.guestsOmitted).toBe(true)
    expect(details({ isOrganizer: false, guestsCanSeeOtherGuests: false })?.guestsOmitted).toBe(true)
    expect(details({ isOrganizer: true, guestsCanSeeOtherGuests: false })?.guestsOmitted).toBe(false)
  })

  it('returns the body and the web link, and null for an event that is gone', () => {
    expect(details({ body: 'Agenda', webLink: 'https://example.com/e' })).toMatchObject({ body: 'Agenda', webLink: 'https://example.com/e' })
    expect(getEventDetails(db, 999)).toBeNull()
  })
})

describe('listEventsInRange', () => {
  it('returns overlapping events, including a long one that started before the range', () => {
    upsertEvents(
      db,
      cal,
      [
        record('inside', T0 + 2 * DAY, T0 + 2 * DAY + H),
        record('long', T0 - 10 * DAY, T0 + DAY), // started 10 days before the range
        record('before', T0 - 5 * DAY, T0 - 4 * DAY),
        record('after', T0 + 9 * DAY, T0 + 9 * DAY + H)
      ],
      1
    )
    const titles = listEventsInRange(db, { start: T0, end: T0 + 7 * DAY }).map((e) => e.title)
    expect(titles.sort()).toEqual(['inside', 'long'])
  })

  it('hides series masters and hidden calendars, and shows canceled meetings as canceled', () => {
    upsertEvents(
      db,
      cal,
      [
        record('master', T0, T0 + H, { kind: 'master' }),
        record('cancelled', T0, T0 + H, { cancelled: true }),
        record('shown', T0, T0 + H)
      ],
      1
    )
    const listed = listEventsInRange(db, { start: T0, end: T0 + DAY }).map((e) => `${e.title}:${e.cancelled}`)
    expect(listed.sort()).toEqual(['cancelled:true', 'shown:false'])
    db.prepare('UPDATE calendars SET visible = 0').run()
    expect(listEventsInRange(db, { start: T0, end: T0 + DAY })).toEqual([])
  })

  it('shows "All events" reminders on each event of the series, unless the event has its own', () => {
    const event = (id: string): EventRecord => record(id, T0, T0 + H, { kind: 'occurrence', seriesRemoteId: 'm' })
    upsertEvents(db, cal, [event('o1'), event('o2')], 1)
    saveEventReminders(db, cal, 'm', [{ minutes: 30, alarm: true }], [15], false)
    saveEventReminders(db, cal, 'o2', [{ minutes: 5, alarm: false }], [15], false)
    const listed = listEventsInRange(db, { start: T0, end: T0 + DAY }).map((e) => `${e.title}:${e.reminders.map((r) => r.minutes)}`)
    expect(listed.sort()).toEqual(['o1:30', 'o2:5'])
  })

  it('says when Google lets guests change the event; Outlook stores null, which is no', () => {
    upsertEvents(db, cal, [record('open', T0, T0 + H, { guestsCanModify: true }), record('outlook', T0, T0 + H)], 1)
    const listed = listEventsInRange(db, { start: T0, end: T0 + DAY }).map((e) => `${e.title}:${e.guestsCanModify}`)
    expect(listed.sort()).toEqual(['open:true', 'outlook:false'])
  })

  it('uses indexes, not a full scan', () => {
    const plan = (sql: string): string =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((r) => r.detail).join(' | ')
    expect(plan('SELECT MAX(end_utc - start_utc) FROM events')).toContain('events_duration')
    expect(
      plan(
        `SELECT e.* FROM events e JOIN calendars c ON c.id = e.calendar_id
         WHERE e.start_utc >= 1 AND e.start_utc < 2 AND e.end_utc > 1`
      )
    ).toContain('events_range')
    // The label color of each shown event (SHOWN): one key lookup per row.
    expect(
      plan(
        `SELECT l.color FROM events e LEFT JOIN labels l ON l.calendar_id = e.calendar_id AND l.id = e.event_label_id
         WHERE e.start_utc >= 1 AND e.start_utc < 2 AND e.end_utc > 1`
      )
    ).toContain('SEARCH l USING PRIMARY KEY (calendar_id=? AND id=?)')
  })
})

describe('searchEvents', () => {
  const titles = (text: string): string[] => searchEvents(db, text, T0, 200).events.map((e) => e.title)
  const guest = (email: string, name?: string): Guest => ({ email, name, response: 'accepted' })

  it('finds a word in the title, location, description, Outlook body, organizer or a guest', () => {
    upsertEvents(
      db,
      cal,
      [
        record('Zebra title', T0, T0 + H),
        record('location', T0, T0 + H, { location: 'Holanda 5' }),
        record('description', T0, T0 + H, { description: 'Bring the hackathon kit' }),
        record('body', T0, T0 + H, { description: 'Short', body: 'Full outlook memo' }),
        record('organizer name', T0, T0 + H, { organizerName: 'Surma Das' }),
        record('organizer email', T0, T0 + H, { organizerEmail: 'events@lu.ma' }),
        record('guest name', T0, T0 + H, { attendees: [guest('ann@x.com', 'Ann Matchwave')] }),
        record('guest email', T0, T0 + H, { attendees: [guest('bob@quokka.org')] })
      ],
      1
    )
    expect(titles('zebra')).toEqual(['Zebra title'])
    expect(titles('holanda')).toEqual(['location'])
    expect(titles('HACKATHON')).toEqual(['description'])
    expect(titles('memo')).toEqual(['body'])
    expect(titles('surma')).toEqual(['organizer name'])
    expect(titles('lu.ma')).toEqual(['organizer email'])
    expect(titles('matchwave')).toEqual(['guest name'])
    expect(titles('quokka')).toEqual(['guest email'])
  })

  it('needs every word, in any order and any case, also inside a word', () => {
    upsertEvents(db, cal, [record('Interview with Thought Machine', T0, T0 + H), record('Thought leadership', T0 + H, T0 + 2 * H)], 1)
    expect(titles('machine THOUGHT')).toEqual(['Interview with Thought Machine'])
    expect(titles('hought')).toEqual(['Interview with Thought Machine', 'Thought leadership'])
    expect(titles('thought zzqx')).toEqual([])
  })

  it('does not match the keys of the guest list', () => {
    upsertEvents(db, cal, [record('meeting', T0, T0 + H, { attendees: [guest('ann@x.com', 'Ann')] })], 1)
    expect(titles('ann')).toEqual(['meeting'])
    expect(titles('response')).toEqual([])
    expect(titles('email')).toEqual([])
  })

  it('treats %, _ and \\ as plain text', () => {
    upsertEvents(db, cal, [record('50% off', T0, T0 + H), record('500 items', T0, T0 + H), record('a_b', T0, T0 + H), record('axb', T0, T0 + H)], 1)
    expect(titles('50%')).toEqual(['50% off'])
    expect(titles('a_b')).toEqual(['a_b'])
    expect(titles('\\')).toEqual([])
  })

  it('finds guest names with " or \\ in them', () => {
    upsertEvents(db, cal, [record('meeting', T0, T0 + H, { attendees: [guest('ann@x.com', 'Ann "Nan" Lee\\Two')] })], 1)
    expect(titles('"nan"')).toEqual(['meeting'])
    expect(titles('lee\\two')).toEqual(['meeting'])
  })

  it('uses at most 10 words', () => {
    upsertEvents(db, cal, [record('one two three four five six seven eight nine ten', T0, T0 + H)], 1)
    // The 11th word is left out, so a word that is not there does not matter.
    expect(titles('one two three four five six seven eight nine ten zzqx')).toHaveLength(1)
    // A word typed twice, in another case, counts once, so zzqx is the 10th word here.
    expect(titles('ONE one two three four five six seven eight nine zzqx')).toEqual([])
  })

  it('hides series masters, hidden calendars and, when the setting says so, declined events; lists canceled ones', () => {
    upsertEvents(
      db,
      cal,
      [
        record('Sync master', T0, T0 + H, { kind: 'master' }),
        record('Sync canceled', T0, T0 + H, { cancelled: true }),
        record('Sync declined', T0, T0 + H, { response: 'declined' }),
        record('Sync shown', T0, T0 + H)
      ],
      1
    )
    expect(titles('sync').sort()).toEqual(['Sync canceled', 'Sync declined', 'Sync shown'])
    expect(searchEvents(db, 'canceled', T0, 200).events[0].cancelled).toBe(true)
    saveSettings(db, { showDeclined: false })
    expect(titles('sync').sort()).toEqual(['Sync canceled', 'Sync shown'])
    db.prepare('UPDATE calendars SET visible = 0').run()
    expect(titles('sync')).toEqual([])
  })

  it('keeps the max closest to now, sorted by start, and says when there are more', () => {
    upsertEvents(
      db,
      cal,
      [-3, -1, 2, 5].map((d) => record(`Day ${d}`, T0 + d * DAY, T0 + d * DAY + H)),
      1
    )
    const near = searchEvents(db, 'day', T0, 2)
    expect(near.events.map((e) => e.title)).toEqual(['Day -1', 'Day 2'])
    expect(near.more).toBe(true)
    expect(searchEvents(db, 'day', T0, 4).more).toBe(false)
  })
})

describe('listPeople', () => {
  const guest = (email: string, extra: Partial<Guest> = {}): Guest => ({ email, response: 'none', ...extra })

  it('keeps each person once in any case, newest first, with the last known name, and no rooms or the user', () => {
    const meeting = {
      attendees: [guest('Ann@x.com', { name: 'Ann' }), guest('room@x.com', { resource: true }), guest('me@example.com')],
      organizerEmail: 'boss@x.com',
      organizerName: 'Boss'
    }
    upsertEvents(db, cal, [record('a', T0, T0 + H, meeting)], 1)
    // A later event without the name keeps it. A holiday's organizer is a calendar, not a person.
    upsertEvents(db, cal, [record('b', T0 + DAY, T0 + DAY + H, { attendees: [guest('ann@x.com')] })], 1)
    upsertEvents(db, cal, [record('c', T0, T0 + H, { organizerEmail: 'holidays@group.calendar.google.com' })], 1)
    // Nor are a group calendar invited as a guest, or a booking page that organizes a meeting.
    const booking = { attendees: [guest('c_1@group.calendar.google.com')], organizerEmail: 'g3ac4f90dcccb41a88f277a8628643271@x.com' }
    upsertEvents(db, cal, [record('d', T0, T0 + H, booking)], 1)
    // Not stored at all, not only hidden when read.
    expect(db.prepare("SELECT email FROM people WHERE email LIKE '%.calendar.google.com' OR email LIKE 'g3ac%'").all()).toEqual([])
    expect(listPeople(db, account, 'ME@example.com')).toEqual([
      { email: 'ann@x.com', name: 'Ann' },
      { email: 'boss@x.com', name: 'Boss' }
    ])
  })

  it('does not suggest a calendar stored before the people rule', () => {
    db.prepare("INSERT INTO people VALUES (?, 'c_2@group.calendar.google.com', 'Interviews', 1)").run(account)
    expect(listPeople(db, account, 'me@example.com')).toEqual([])
  })

  it("lists only the account's own people", () => {
    const other = upsertAccount(db, 'outlook', 'me@work.com', null, 0)
    syncCalendarList(db, other, [{ remoteId: 'w', name: 'Work', color: '#000', canEdit: true, isPrimary: true, defaultReminders: [], conference: null }])
    const work = (db.prepare("SELECT id FROM calendars WHERE remote_id = 'w'").get() as { id: number }).id
    upsertEvents(db, work, [record('w1', T0, T0 + H, { attendees: [guest('colleague@work.com')] })], 1)
    expect(listPeople(db, account, 'me@example.com')).toEqual([])
    expect(listPeople(db, other, 'me@work.com')).toEqual([{ email: 'colleague@work.com' }])
  })
})

describe('deletes', () => {
  it('deleting a series id removes the master and all its instances', () => {
    upsertEvents(
      db,
      cal,
      [
        record('m', T0, T0 + H, { kind: 'master' }),
        record('o1', T0, T0 + H, { kind: 'occurrence', seriesRemoteId: 'm' }),
        record('o2', T0 + DAY, T0 + DAY + H, { kind: 'occurrence', seriesRemoteId: 'm' }),
        record('other', T0, T0 + H)
      ],
      1
    )
    deleteEvents(db, cal, ['m'])
    expect(listEventsInRange(db, { start: T0, end: T0 + 2 * DAY }).map((e) => e.title)).toEqual(['other'])
  })

  it('"This and following" drops the events of the series from where the rule put the cut event, and nothing else', () => {
    const event = (id: string, start: number, extra: Partial<EventRecord> = {}): EventRecord =>
      record(id, start, start + H, { kind: 'occurrence', seriesRemoteId: 'm', originalStart: start, ...extra })
    // o2 was moved before o1, but the rule put it after the cut, so it goes too.
    upsertEvents(db, cal, [event('o1', T0), event('o2', T0 - DAY, { originalStart: T0 + DAY }), event('o3', T0 + 2 * DAY), event('x1', T0 + DAY, { seriesRemoteId: 'x' })], 1)
    deleteSeriesInstancesFrom(db, cal, 'm', T0 + DAY)
    expect(listEventsInRange(db, { start: T0 - DAY, end: T0 + 3 * DAY }).map((e) => e.title)).toEqual(['o1', 'x1'])
  })

  it('series refresh drops instances the provider no longer returns', () => {
    upsertEvents(
      db,
      cal,
      [
        record('o1', T0, T0 + H, { kind: 'occurrence', seriesRemoteId: 'm' }),
        record('o2', T0 + DAY, T0 + DAY + H, { kind: 'occurrence', seriesRemoteId: 'm' })
      ],
      1
    )
    deleteSeriesInstancesExcept(db, cal, 'm', ['o1'])
    expect(listEventsInRange(db, { start: T0, end: T0 + 2 * DAY }).map((e) => e.title)).toEqual(['o1'])
  })

  it('sweep removes rows from older generations only', () => {
    upsertEvents(db, cal, [record('old', T0, T0 + H)], 1)
    upsertEvents(db, cal, [record('new', T0, T0 + H)], 2)
    sweepEvents(db, cal, 2)
    expect(listEventsInRange(db, { start: T0, end: T0 + DAY }).map((e) => e.title)).toEqual(['new'])
  })

  it("drops the deleted events' own reminders, also a Google series' list (no master row), and keeps the rest", () => {
    // Google keeps no master row: the series 's' is only its events.
    upsertEvents(db, cal, [record('a', T0, T0 + H), record('s1', T0, T0 + H, { kind: 'occurrence', seriesRemoteId: 's' }), record('keep', T0, T0 + H)], 1)
    upsertEvents(db, cal, [record('old', T0, T0 + H)], 0)
    for (const id of ['a', 's', 's1', 'keep', 'old']) saveEventReminders(db, cal, id, [{ minutes: 5, alarm: false }], [15], false)
    const left = (): string[] => (db.prepare('SELECT remote_id FROM event_reminders ORDER BY remote_id').all() as { remote_id: string }[]).map((r) => r.remote_id)
    deleteEvents(db, cal, ['a', 's'])
    expect(left()).toEqual(['keep', 'old'])
    sweepEvents(db, cal, 1)
    expect(left()).toEqual(['keep'])
  })
})
