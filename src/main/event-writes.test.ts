import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventInput } from '../shared/api'
import { syncCalendarList, upsertAccount } from './db/accounts'
import { openDb, type Db } from './db/db'
import { getEventByRemoteId, getRecord, upsertEvents, type EventRecord } from './db/events'
import { saveEventReminders } from './db/reminders'
import { createEvent, deleteEvent, getSeries, respondEvent, updateEvent } from './event-writes'
import type { GoogleDeps } from './providers/google/client'
import { toRecord, type GoogleEvent } from './providers/google/map'
import type { OutlookDeps } from './providers/outlook/client'
import { toRecord as outlookRecord, type OutlookEvent } from './providers/outlook/map'
import { localWrites } from './sync/local-writes'

// A fake Google: a DELETE answers with 204, anything else with reply.ids[the last part of the path] or reply.event.
// methods, urls and bodies list the requests.
const served = vi.hoisted((): GoogleEvent => ({
  id: 'e1',
  summary: 'Focus',
  start: { dateTime: '2026-10-27T09:00:00.000Z' },
  end: { dateTime: '2026-10-27T10:00:00.000Z' }
}))
const reply = vi.hoisted(() => ({ event: served, ids: {} as Record<string, GoogleEvent> }))
const methods = vi.hoisted((): string[] => [])
const urls = vi.hoisted((): string[] => [])
const bodies = vi.hoisted((): unknown[] => [])
const google = vi.hoisted((): GoogleDeps => ({
  fetch: (async (url: string, init: RequestInit) => {
    methods.push(init.method ?? 'GET')
    urls.push(url)
    bodies.push(init.body && JSON.parse(init.body as string))
    if (init.method === 'DELETE') return new Response(null, { status: 204 })
    return new Response(JSON.stringify(reply.ids[new URL(url).pathname.split('/').pop()!] ?? reply.event))
  }) as typeof fetch,
  getAccessToken: async () => 'token',
  sleep: async () => {}
}))
// A fake Outlook: a request answers 202 with no body, like accept and decline, unless outlookEvents has the event of
// its path (a PATCH answers it with the sent fields). outlookCalls lists the requests, and outlookBodies what they sent.
const outlookEvents = vi.hoisted((): Record<string, OutlookEvent> => ({}))
const outlookCalls = vi.hoisted((): string[] => [])
const outlookBodies = vi.hoisted((): unknown[] => [])
const outlook = vi.hoisted((): OutlookDeps => ({
  fetch: (async (url: string, init: RequestInit) => {
    outlookCalls.push(`${init.method} ${url.split('/me/')[1]}`)
    outlookBodies.push(init.body && JSON.parse(init.body as string))
    const event = outlookEvents[url.split('/').pop()!]
    if (event) return new Response(JSON.stringify({ ...event, ...(init.body && JSON.parse(init.body as string)) }))
    return new Response(null, { status: 202 })
  }) as typeof fetch,
  getToken: () => ({ raw: 't', anchor: 'a', exp: Infinity, upn: 'me@work.com', tid: 'x' }),
  sleep: async () => {}
}))
// The real sessions need a running Electron.
vi.mock('./google-session', () => ({
  withGoogle: (_db: unknown, _id: number, fn: (deps: GoogleDeps) => unknown) => fn(google)
}))
vi.mock('./outlook-session', () => ({
  withOutlook: (_db: unknown, _account: unknown, fn: (deps: OutlookDeps) => unknown) => fn(outlook)
}))

const T0 = Date.UTC(2026, 9, 27, 9)
const input: EventInput = {
  calendarId: 1,
  title: 'Focus',
  start: T0,
  end: T0 + 3600_000,
  allDay: false,
  startDate: null,
  endDate: null,
  location: '',
  description: ''
}

// One event of a repeating Google invite, as the sync stores it.
const invite: GoogleEvent = {
  ...served,
  id: 'i1_20261027T090000Z',
  recurringEventId: 'i1',
  organizer: { email: 'boss@x.com' },
  attendees: [
    { email: 'boss@x.com', organizer: true, responseStatus: 'accepted' },
    { email: 'me@gmail.com', self: true, responseStatus: 'needsAction' }
  ]
}

let db: Db

beforeEach(() => {
  db = openDb(':memory:')
  const account = upsertAccount(db, 'google', 'me@gmail.com', null, T0)
  const calendar = { remoteId: 'me@gmail.com', name: 'Me', color: '#000', canEdit: true }
  syncCalendarList(db, account, [{ ...calendar, isPrimary: true, defaultReminders: [], conference: null }])
  reply.event = served
  reply.ids = {}
  methods.length = 0
  urls.length = 0
  bodies.length = 0
  outlookCalls.length = 0
  outlookBodies.length = 0
  for (const id of Object.keys(outlookEvents)) delete outlookEvents[id]
})

// A running sync of that calendar then skips its commit (sync/local-writes.ts).
describe('event writes', () => {
  it('counts a create as a local write of its calendar', async () => {
    const before = localWrites(1)
    await createEvent(db, input)
    expect(localWrites(1)).toBe(before + 1)
  })

  it('creates with the picked color', async () => {
    reply.event = { ...served, colorId: '11' }
    await createEvent(db, input, undefined, { colorId: '11' })
    expect(bodies[0]).toMatchObject({ colorId: '11' })
  })

  it('keeps all-day reminders "on the same day" in this app: Google takes none after the start', async () => {
    const day: GoogleEvent = { id: 'd1', summary: 'Day', start: { date: '2026-12-10' }, end: { date: '2026-12-11' } }
    reply.ids = { d1: { ...day, reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 420 }] } } }
    upsertEvents(db, 1, [toRecord(day)], 0)
    const reminders = [
      { minutes: -540, alarm: true },
      { minutes: 420, alarm: false }
    ]
    await updateEvent(db, getEventByRemoteId(db, 1, 'd1')!.id, {}, reminders)
    expect(bodies[methods.indexOf('PATCH')]).toMatchObject({ reminders: { overrides: [{ method: 'popup', minutes: 420 }] } })
    expect(getEventByRemoteId(db, 1, 'd1')!.reminders).toEqual([...reminders].reverse())
  })

  it('counts a delete as a local write of its calendar', async () => {
    upsertEvents(db, 1, [toRecord(served)], 0)
    const before = localWrites(1)
    await deleteEvent(db, getEventByRemoteId(db, 1, 'e1')!.id)
    expect(localWrites(1)).toBe(before + 1)
  })

  it("drops the event's own reminders with it", async () => {
    upsertEvents(db, 1, [toRecord(served)], 0)
    saveEventReminders(db, 1, 'e1', [{ minutes: 5, alarm: false }], [], false)
    await deleteEvent(db, getEventByRemoteId(db, 1, 'e1')!.id)
    expect(db.prepare('SELECT remote_id FROM event_reminders').all()).toEqual([])
  })

  it('removes a meeting the organizer canceled, without declining it', async () => {
    upsertEvents(db, 1, [{ ...toRecord(served), isOrganizer: false, attendeeCount: 2, cancelled: true }], 0)
    methods.length = 0
    await deleteEvent(db, getEventByRemoteId(db, 1, 'e1')!.id)
    expect(methods).toEqual(['DELETE'])
  })

  // Seen live: Google web puts the invite in the bin, and the organizer gets no answer.
  it('takes a Google invite off this calendar without an answer, like "Remove from this calendar"', async () => {
    upsertEvents(db, 1, [toRecord(invite)], 0)
    await deleteEvent(db, getEventByRemoteId(db, 1, invite.id)!.id)
    expect(methods).toEqual(['DELETE'])
    expect(new URL(urls[0]).searchParams.get('sendUpdates')).toBe('none')
    expect(getEventByRemoteId(db, 1, invite.id)).toBeNull()
  })

  it('does not remove an invite in a calendar that is not the main one', async () => {
    syncCalendarList(db, 1, [
      { remoteId: 'me@gmail.com', name: 'Me', color: '#000', canEdit: true, isPrimary: true, defaultReminders: [], conference: null },
      { remoteId: 'team@group.calendar.google.com', name: 'Team', color: '#000', canEdit: true, isPrimary: false, defaultReminders: [], conference: null }
    ])
    upsertEvents(db, 2, [toRecord(invite)], 0)
    await expect(deleteEvent(db, getEventByRemoteId(db, 2, invite.id)!.id)).rejects.toThrow('main calendar')
    expect(methods).toEqual([])
    expect(getEventByRemoteId(db, 2, invite.id)).not.toBeNull()
  })
})

describe('answers', () => {
  it('stores the answer Google sends back, and counts it as a local write', async () => {
    upsertEvents(db, 1, [toRecord(invite)], 0)
    reply.event = { ...invite, attendees: [invite.attendees![0], { ...invite.attendees![1], responseStatus: 'declined' }] }
    const before = localWrites(1)
    await respondEvent(db, getEventByRemoteId(db, 1, invite.id)!.id, 'declined', 'event')
    expect(new URL(urls[0]).pathname).toMatch(/\/events\/i1_20261027T090000Z$/)
    // Google keeps a declined event, so the row stays.
    expect(getEventByRemoteId(db, 1, invite.id)!.response).toBe('declined')
    expect(localWrites(1)).toBe(before + 1)
  })

  it('answers all events of a Google series on the series, and leaves the rows to the next sync', async () => {
    upsertEvents(db, 1, [toRecord(invite)], 0)
    reply.event = { ...invite, id: 'i1', recurringEventId: undefined, recurrence: ['RRULE:FREQ=WEEKLY'] }
    await respondEvent(db, getEventByRemoteId(db, 1, invite.id)!.id, 'accepted', 'series')
    expect(methods).toEqual(['PATCH'])
    expect(new URL(urls[0]).pathname).toMatch(/\/events\/i1$/)
    expect(getEventByRemoteId(db, 1, invite.id)!.response).toBe('none')
  })

  it('refuses to answer in a calendar that is not the main one', async () => {
    const calendar = { remoteId: 'team@group.calendar.google.com', name: 'Team', color: '#000', canEdit: true }
    syncCalendarList(db, 1, [
      { remoteId: 'me@gmail.com', name: 'Me', color: '#000', canEdit: true, isPrimary: true, defaultReminders: [], conference: null },
      { ...calendar, isPrimary: false, defaultReminders: [], conference: null }
    ])
    upsertEvents(db, 2, [toRecord(invite)], 0)
    await expect(respondEvent(db, getEventByRemoteId(db, 2, invite.id)!.id, 'accepted', 'event')).rejects.toThrow('main calendar')
    expect(methods).toEqual([])
  })

  describe('in Outlook', () => {
    // An Outlook series as the sync stores it: the master and its events.
    const event = (remoteId: string, extra: Partial<EventRecord> = {}): EventRecord => ({
      ...toRecord(served),
      remoteId,
      kind: 'occurrence',
      seriesRemoteId: 'S',
      isOrganizer: false,
      attendeeCount: 2,
      response: 'none',
      ...extra
    })

    beforeEach(() => {
      const account = upsertAccount(db, 'outlook', 'me@work.com', null, T0)
      const calendar = { remoteId: 'cal', name: 'Calendar', color: '#000', canEdit: true }
      syncCalendarList(db, account, [{ ...calendar, isPrimary: true, defaultReminders: [], conference: null }])
      upsertEvents(db, 2, [event('S', { kind: 'master', seriesRemoteId: null }), event('O1'), event('O2')], 0)
    })

    it('takes a declined event off the calendar, like Outlook', async () => {
      await respondEvent(db, getEventByRemoteId(db, 2, 'O1')!.id, 'declined', 'event')
      expect(outlookCalls).toEqual(['POST events/O1/decline'])
      expect(getEventByRemoteId(db, 2, 'O1')).toBeNull()
      expect(getEventByRemoteId(db, 2, 'O2')).not.toBeNull()
    })

    it('takes every event of a series off the calendar for "No" to all events', async () => {
      await respondEvent(db, getEventByRemoteId(db, 2, 'O1')!.id, 'declined', 'series')
      expect(outlookCalls).toEqual(['POST events/S/decline'])
      expect(getEventByRemoteId(db, 2, 'O1')).toBeNull()
      expect(getEventByRemoteId(db, 2, 'O2')).toBeNull()
    })

    it('declines an invite on Delete like "No", and tells the organizer only if asked', async () => {
      upsertEvents(db, 2, [event('O1', { responseRequested: false })], 0)
      await deleteEvent(db, getEventByRemoteId(db, 2, 'O1')!.id)
      expect(outlookCalls).toEqual(['POST events/O1/decline'])
      expect(outlookBodies).toEqual([{ SendResponse: false }])
      expect(getEventByRemoteId(db, 2, 'O1')).toBeNull()
    })

    it('tells the organizer when the invite says nothing about a reply', async () => {
      await respondEvent(db, getEventByRemoteId(db, 2, 'O1')!.id, 'tentative', 'event')
      expect(outlookBodies).toEqual([{ SendResponse: true }])
    })

    it('stores a Yes at once, since Outlook sends nothing back', async () => {
      const before = localWrites(2)
      await respondEvent(db, getEventByRemoteId(db, 2, 'O1')!.id, 'accepted', 'event')
      expect(outlookCalls).toEqual(['POST events/O1/accept'])
      expect(getEventByRemoteId(db, 2, 'O1')!.response).toBe('accepted')
      expect(localWrites(2)).toBe(before + 1)
    })
  })
})

describe('series rules', () => {
  it('reads an Outlook rule from the stored master, in its zone, and says when the master is missing', async () => {
    const account = upsertAccount(db, 'outlook', 'me@work.com', null, T0)
    syncCalendarList(db, account, [{ remoteId: 'cal', name: 'Calendar', color: '#000', canEdit: true, isPrimary: true, defaultReminders: [], conference: null }])
    const recurrence = {
      Pattern: { Type: 'Weekly', Interval: 1, DaysOfWeek: ['Tuesday'], FirstDayOfWeek: 'Sunday' },
      Range: { Type: 'Numbered', NumberOfOccurrences: 6, StartDate: '2026-10-27', RecurrenceTimeZone: 'W. Europe Standard Time' }
    }
    const master = { ...toRecord(served), remoteId: 'S', kind: 'master' as const, recurrence: JSON.stringify(recurrence) }
    const occurrence = { ...toRecord(served), remoteId: 'O1', kind: 'occurrence' as const, seriesRemoteId: 'S' }
    upsertEvents(db, 2, [master, occurrence, { ...occurrence, remoteId: 'O2', seriesRemoteId: 'gone' }], 0)
    await expect(getSeries(db, getEventByRemoteId(db, 2, 'O1')!.id)).resolves.toEqual({
      repeat: { freq: 'weekly', interval: 1, days: [2], monthly: 'day', until: null, count: 6 },
      first: T0,
      zone: 'Europe/Berlin'
    })
    await expect(getSeries(db, getEventByRemoteId(db, 2, 'O2')!.id)).rejects.toThrow('Could not load the repeat rule.')
    await expect(getSeries(db, getEventByRemoteId(db, 2, 'S')!.id)).resolves.toBeNull()
  })

  it('does not split an Outlook series: its deleted events would come back (S-M3)', async () => {
    const account = upsertAccount(db, 'outlook', 'me@work.com', null, T0)
    syncCalendarList(db, account, [{ remoteId: 'cal', name: 'Calendar', color: '#000', canEdit: true, isPrimary: true, defaultReminders: [], conference: null }])
    upsertEvents(db, 2, [{ ...toRecord(served), remoteId: 'O1', kind: 'occurrence', seriesRemoteId: 'S' }], 0)
    await expect(updateEvent(db, getEventByRemoteId(db, 2, 'O1')!.id, { title: 'New' }, undefined, 'following')).rejects.toThrow(
      'Change this and following events in Outlook.'
    )
    expect(outlookCalls).toEqual([])
  })

  it('does not give all events of an Outlook series new times or a new rule: deleted events would come back (N1)', async () => {
    const account = upsertAccount(db, 'outlook', 'me@work.com', null, T0)
    syncCalendarList(db, account, [{ remoteId: 'cal', name: 'Calendar', color: '#000', canEdit: true, isPrimary: true, defaultReminders: [], conference: null }])
    upsertEvents(db, 2, [{ ...toRecord(served), remoteId: 'O1', kind: 'occurrence', seriesRemoteId: 'S' }], 0)
    const id = getEventByRemoteId(db, 2, 'O1')!.id
    const times = { start: T0 + 3600_000, end: T0 + 5400_000, allDay: false, startDate: null, endDate: null }
    const weekly = { freq: 'weekly' as const, interval: 1, days: [3], monthly: 'day' as const, until: null, count: null }
    for (const change of [{ times }, { repeat: weekly }]) {
      await expect(updateEvent(db, id, change, undefined, 'series')).rejects.toThrow('Change the time or repeat rule of all events in Outlook.')
    }
    expect(outlookCalls).toEqual([])
  })

  // Outlook web shows the series' color there, while Outlook's API keeps the event's own (seen live).
  it('gives an Outlook color for all events to the events with their own changes too, and stores them', async () => {
    const account = upsertAccount(db, 'outlook', 'me@work.com', null, T0)
    syncCalendarList(db, account, [{ remoteId: 'cal', name: 'Calendar', color: '#000', canEdit: true, isPrimary: true, defaultReminders: [], conference: null }])
    const recurrence = {
      Pattern: { Type: 'Weekly', Interval: 1, DaysOfWeek: ['Tuesday'], FirstDayOfWeek: 'Sunday' },
      Range: { Type: 'Numbered', NumberOfOccurrences: 3, StartDate: '2026-12-01', RecurrenceTimeZone: 'W. Europe Standard Time' }
    }
    const master: OutlookEvent = {
      Id: 'S',
      ChangeKey: 'm1',
      Subject: 'Standup',
      Start: { DateTime: '2026-12-01T09:00:00.0000000', TimeZone: 'UTC' },
      End: { DateTime: '2026-12-01T09:30:00.0000000', TimeZone: 'UTC' },
      IsAllDay: false,
      Type: 'SeriesMaster',
      IsOrganizer: true,
      Recurrence: recurrence,
      Categories: ['Yellow category']
    }
    const at = (date: string): Partial<OutlookEvent> => ({
      Start: { DateTime: `${date}T09:00:00.0000000`, TimeZone: 'UTC' },
      End: { DateTime: `${date}T09:30:00.0000000`, TimeZone: 'UTC' },
      OriginalStart: `${date}T09:00:00Z`
    })
    const plain: OutlookEvent = { ...master, ...at('2026-12-01'), Id: 'O1', Type: 'Occurrence', SeriesMasterId: 'S', Recurrence: null }
    const own: OutlookEvent = { ...plain, ...at('2026-12-08'), Id: 'X1', Type: 'Exception', Categories: ['Red category'] }
    Object.assign(outlookEvents, { S: master, O1: plain, X1: own })
    upsertEvents(db, 2, [master, plain, own].map((e) => outlookRecord(e)), 0)
    await updateEvent(db, getEventByRemoteId(db, 2, 'O1')!.id, { categories: { first: 'Green category', remove: [] } }, undefined, 'series')
    expect(outlookCalls.filter((c) => !c.startsWith('GET'))).toEqual(['PATCH events/S', 'PATCH events/X1'])
    expect(outlookBodies.filter(Boolean)).toEqual([{ Categories: ['Green category', 'Yellow category'] }, { Categories: ['Green category', 'Red category'] }])
    expect(getRecord(db, 2, 'X1')!.categories).toEqual(['Green category', 'Red category'])
  })
})

// The user's weekly Google series: Tue 10:00 in Lisbon from 1 Dec 2026, 6 times. Its first 4 events are stored.
describe('series writes', () => {
  const master: GoogleEvent = {
    id: 's1',
    etag: '"m1"',
    summary: 'Standup',
    start: { dateTime: '2026-12-01T10:00:00Z', timeZone: 'Europe/Lisbon' },
    end: { dateTime: '2026-12-01T10:30:00Z', timeZone: 'Europe/Lisbon' },
    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=6'],
    organizer: { self: true, email: 'me@gmail.com' }
  }
  const dates = ['2026-12-01', '2026-12-08', '2026-12-15', '2026-12-22']
  const instance = (date: string): GoogleEvent => ({
    ...master,
    id: `s1_${date.replaceAll('-', '')}T100000Z`,
    recurrence: undefined,
    recurringEventId: 's1',
    start: { dateTime: `${date}T10:00:00.000Z`, timeZone: 'Europe/Lisbon' },
    end: { dateTime: `${date}T10:30:00.000Z`, timeZone: 'Europe/Lisbon' },
    originalStartTime: { dateTime: `${date}T10:00:00.000Z` }
  })
  const idOf = (date: string): number => getEventByRemoteId(db, 1, instance(date).id)!.id
  const left = (): string[] => dates.filter((d) => getEventByRemoteId(db, 1, instance(d).id) !== null)
  const saved = (): string[] =>
    (db.prepare('SELECT remote_id, reminders FROM event_reminders ORDER BY remote_id').all() as { remote_id: string; reminders: string }[]).map(
      (r) => `${r.remote_id} ${r.reminders}`
    )

  beforeEach(() => {
    upsertEvents(db, 1, [toRecord(served), ...dates.map((d) => toRecord(instance(d)))], 0)
    reply.ids = Object.fromEntries([['s1', master], ...dates.map((d) => [instance(d).id, instance(d)])])
  })

  it('deletes all events on the series and drops every row of it at once', async () => {
    // Its "All events" reminders (Google: no master row) and one event's own go too.
    saveEventReminders(db, 1, 's1', [{ minutes: 30, alarm: true }], [], false)
    saveEventReminders(db, 1, instance('2026-12-08').id, [{ minutes: 10, alarm: false }], [], false)
    await deleteEvent(db, idOf('2026-12-15'), undefined, 'series')
    expect(methods).toEqual(['GET', 'DELETE'])
    expect(new URL(urls[1]).pathname).toMatch(/\/events\/s1$/)
    expect(left()).toEqual([])
    expect(saved()).toEqual([])
    expect(getEventByRemoteId(db, 1, 'e1')).not.toBeNull()
  })

  it('deletes this and following by ending the series, and drops the rows from this event on', async () => {
    await deleteEvent(db, idOf('2026-12-15'), undefined, 'following')
    expect(methods).toEqual(['GET', 'PATCH'])
    expect(left()).toEqual(['2026-12-01', '2026-12-08'])
  })

  it("gives a split's new series the old series' reminders, and counts the write before and after", async () => {
    const reminders = [{ minutes: 30, alarm: true }]
    saveEventReminders(db, 1, 's1', reminders, [], false)
    reply.event = { ...master, id: 'n1' }
    const before = localWrites(1)
    await expect(updateEvent(db, idOf('2026-12-15'), { title: 'Standup v2' }, undefined, 'following')).resolves.toBeNull()
    expect(methods).toEqual(['GET', 'GET', 'GET', 'POST', 'PATCH'])
    expect(localWrites(1)).toBe(before + 2)
    expect(left()).toEqual(['2026-12-01', '2026-12-08'])
    expect(saved()).toEqual([`n1 ${JSON.stringify(reminders)}`, `s1 ${JSON.stringify(reminders)}`])
  })

  it("gives an all-day series made timed the calendar's zone, not UTC (C-B1)", async () => {
    syncCalendarList(db, 1, [{ remoteId: 'me@gmail.com', name: 'Me', color: '#000', canEdit: true, isPrimary: true, defaultReminders: [], conference: null, timeZone: 'Europe/Berlin' }])
    const day = { ...master, start: { date: '2026-12-01' }, end: { date: '2026-12-02' }, recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU'] }
    const one = { ...day, id: 's1_20261215', recurrence: undefined, recurringEventId: 's1', start: { date: '2026-12-15' }, end: { date: '2026-12-16' }, originalStartTime: { date: '2026-12-15' } }
    upsertEvents(db, 1, [toRecord(one)], 0)
    reply.ids = { s1: day, [one.id]: one }
    // 09:00 to 10:00 in Berlin.
    const start = Date.UTC(2026, 11, 15, 8)
    const times = { allDay: false, start, end: start + 3600_000, startDate: null, endDate: null }
    await updateEvent(db, getEventByRemoteId(db, 1, one.id)!.id, { times }, undefined, 'series')
    expect(bodies[methods.indexOf('PATCH')]).toMatchObject({ start: { dateTime: '2026-12-01T08:00:00.000Z', timeZone: 'Europe/Berlin' } })
  })

  it('saves "All events" reminders on the series, in place of the ones of single events', async () => {
    saveEventReminders(db, 1, instance('2026-12-08').id, [{ minutes: 10, alarm: false }], [], false)
    await updateEvent(db, idOf('2026-12-15'), {}, [{ minutes: 5, alarm: true }], 'series')
    expect(methods).toEqual(['GET', 'GET', 'PATCH'])
    expect(saved()).toEqual([`s1 ${JSON.stringify([{ minutes: 5, alarm: true }])}`])
  })
})
