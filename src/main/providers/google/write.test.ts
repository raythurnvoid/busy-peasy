import { beforeEach, describe, expect, it } from 'vitest'
import type { EventInput } from '../../../shared/api'
import type { EventRecord } from '../../db/events'
import { ConflictError, type EventChange } from '../write'
import { GOOGLE_BASE, GoogleAuthError, type GoogleDeps } from './client'
import { toRecord, type GoogleEvent } from './map'
import {
  createGoogleEvent,
  deleteGoogleEvent,
  deleteGoogleSeries,
  getGoogleSeries,
  respondGoogleEvent,
  updateGoogleEvent,
  updateGoogleSeries
} from './write'

const EVENTS = 'calendars/me%40gmail.com/events'
const H = 3600_000
const T0 = Date.UTC(2026, 9, 27, 9)

interface Call {
  method: string
  path: string
  query: URLSearchParams
  headers: Record<string, string>
  body: Record<string, unknown> | null
}

let calls: Call[]
let route: (call: Call) => unknown

const deps: GoogleDeps = {
  sleep: async () => {},
  getAccessToken: async () => 'token',
  fetch: (async (url: string, init: RequestInit) => {
    const u = new URL(url)
    const call: Call = {
      method: init.method ?? 'GET',
      path: u.pathname.slice(new URL(GOOGLE_BASE).pathname.length),
      query: u.searchParams,
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(init.body as string) : null
    }
    calls.push(call)
    const body = route(call)
    return body instanceof Response ? body : new Response(body === undefined ? '' : JSON.stringify(body))
  }) as typeof fetch
}

const input: EventInput = {
  calendarId: 1,
  title: 'Focus',
  start: T0,
  end: T0 + H,
  allDay: false,
  startDate: null,
  endDate: null,
  location: '',
  description: ''
}

const served = (id: string, extra: Partial<GoogleEvent> = {}): GoogleEvent => ({
  id,
  summary: 'Focus',
  etag: '"2"',
  start: { dateTime: new Date(T0).toISOString() },
  end: { dateTime: new Date(T0 + H).toISOString() },
  organizer: { self: true },
  ...extra
})

const record = (extra: Partial<EventRecord> = {}): EventRecord => ({
  remoteId: 'e1',
  kind: 'single',
  seriesRemoteId: null,
  icalUid: null,
  version: '"1"',
  title: 'Focus',
  start: T0,
  end: T0 + H,
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
  reminders: [10],
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
})

beforeEach(() => {
  calls = []
  route = () => new Response('{}', { status: 500 })
})

describe('google writes', () => {
  it('creates with our own id, and a retried create that hits 409 reads that same event back', async () => {
    route = (c) => (c.method === 'POST' ? new Response('{"error":{"status":"ALREADY_EXISTS"}}', { status: 409 }) : served(c.path.split('/').pop()!))
    const created = await createGoogleEvent(deps, 'me@gmail.com', input)
    const id = calls[0].body!.id as string
    expect(id).toMatch(/^[0-9a-f]{32}$/)
    expect(calls[0]).toMatchObject({ method: 'POST', path: EVENTS })
    expect(calls[0].query.get('sendUpdates')).toBe('none')
    expect(calls[0].body!.start).toEqual({ dateTime: new Date(T0).toISOString(), date: null })
    expect(calls[1]).toMatchObject({ method: 'GET', path: `${EVENTS}/${id}` })
    expect(created.remoteId).toBe(id)
  })

  it('creates all-day events with dates only', async () => {
    route = (c) => served(c.body!.id as string)
    const day = { allDay: true, startDate: '2026-10-27', endDate: '2026-10-28' }
    await createGoogleEvent(deps, 'me@gmail.com', { ...input, ...day })
    expect(calls[0].body!.start).toEqual({ date: '2026-10-27', dateTime: null })
    expect(calls[0].body!.end).toEqual({ date: '2026-10-28', dateTime: null })
  })

  it('updates only the changed fields with If-Match, and tells attendees when we organize', async () => {
    route = () => served('e1', { summary: 'Deep work' })
    const updated = await updateGoogleEvent(deps, 'me@gmail.com', record({ attendeeCount: 3 }), { title: 'Deep work' })
    expect(calls[0]).toMatchObject({ method: 'PATCH', path: `${EVENTS}/e1`, body: { summary: 'Deep work' } })
    expect(calls[0].headers['If-Match']).toBe('"1"')
    expect(calls[0].query.get('sendUpdates')).toBe('all')
    expect(updated.title).toBe('Deep work')
  })

  it('sends the zones the user picked, and none with times only', async () => {
    route = (c) => served(c.method === 'POST' ? (c.body!.id as string) : 'e1')
    const end = new Date(T0 + H).toISOString()
    await createGoogleEvent(deps, 'me@gmail.com', { ...input, timeZone: 'Europe/Rome', endTimeZone: 'America/New_York' })
    expect(calls[0].body!.start).toEqual({ dateTime: new Date(T0).toISOString(), date: null, timeZone: 'Europe/Rome' })
    expect(calls[0].body!.end).toEqual({ dateTime: end, date: null, timeZone: 'America/New_York' })
    await updateGoogleEvent(deps, 'me@gmail.com', record(), { times: input, timeZone: 'Asia/Tokyo', endTimeZone: 'Asia/Tokyo' })
    expect(calls[1].body!.end).toEqual({ dateTime: end, date: null, timeZone: 'Asia/Tokyo' })
    await updateGoogleEvent(deps, 'me@gmail.com', record(), { times: input })
    expect(calls[2].body!.start).toEqual({ dateTime: new Date(T0).toISOString(), date: null })
  })

  it('sends no update mails when the organizer chose "Do not send"', async () => {
    route = () => served('e1')
    const times = { ...input, start: T0 + H, end: T0 + 2 * H }
    await updateGoogleEvent(deps, 'me@gmail.com', record({ attendeeCount: 3 }), { times, notify: false })
    expect(calls[0].query.get('sendUpdates')).toBe('none')
  })

  it('creates with guests, invites them, and leaves out answers and false flags', async () => {
    route = (c) => served(c.body!.id as string)
    const guests = [{ email: 'ann@x.com', optional: false }, { email: 'bob@x.com', optional: true }]
    await createGoogleEvent(deps, 'me@gmail.com', { ...input, guests })
    expect(calls[0].query.get('sendUpdates')).toBe('all')
    expect(calls[0].body!.attendees).toEqual([{ email: 'ann@x.com' }, { email: 'bob@x.com', optional: true }])
  })

  it('sends no invitations when the organizer chose "Do not send"', async () => {
    route = (c) => served(c.body!.id as string)
    await createGoogleEvent(deps, 'me@gmail.com', { ...input, guests: [{ email: 'ann@x.com', optional: false }] }, undefined, false)
    expect(calls[0].query.get('sendUpdates')).toBe('none')
  })

  it('asks for a Meet call only with conference, with the flag Google needs', async () => {
    route = (c) => served(c.body!.id as string)
    await createGoogleEvent(deps, 'me@gmail.com', { ...input, conference: true })
    await createGoogleEvent(deps, 'me@gmail.com', input)
    expect(calls[0].query.get('conferenceDataVersion')).toBe('1')
    expect(calls[0].body!.conferenceData).toEqual({
      createRequest: { requestId: expect.stringMatching(/^[0-9a-f-]{36}$/), conferenceSolutionKey: { type: 'hangoutsMeet' } }
    })
    expect(calls[1].query.has('conferenceDataVersion')).toBe(false)
    expect(calls[1].body).not.toHaveProperty('conferenceData')
  })

  it('invites the first guest of an event that had none', async () => {
    route = () => served('e1')
    await updateGoogleEvent(deps, 'me@gmail.com', record({ attendeeCount: 0 }), { guests: { add: [{ email: 'ann@x.com', optional: false }], set: [], remove: [] } })
    expect(calls[1]).toMatchObject({ method: 'PATCH', path: `${EVENTS}/e1` })
    expect(calls[1].query.get('sendUpdates')).toBe('all')
  })

  it("applies a guest edit to Google's latest list, with the latest etag", async () => {
    const latest = [
      { email: 'me@gmail.com', organizer: true, self: true, responseStatus: 'accepted' },
      { email: 'ann@x.com', responseStatus: 'accepted', comment: 'Late', additionalGuests: 1 },
      { email: 'bob@x.com', optional: true, responseStatus: 'tentative' },
      { email: 'cleo@x.com', responseStatus: 'declined' },
      // Added in Google after the dialog opened.
      { email: 'dan@x.com', responseStatus: 'needsAction' }
    ]
    route = (c) => (c.method === 'GET' ? served('e1', { etag: '"7"', attendees: latest }) : served('e1'))
    const guests = {
      add: [{ email: 'eve@x.com', optional: true }],
      // gus was removed in Google meanwhile: his flag must not add him back.
      set: [{ email: 'ann@x.com', optional: true }, { email: 'BOB@x.com', optional: false }, { email: 'gus@x.com', optional: true }],
      remove: ['CLEO@x.com']
    }
    await updateGoogleEvent(deps, 'me@gmail.com', record({ attendeeCount: 4 }), { guests })
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PATCH'])
    expect(calls[1].headers['If-Match']).toBe('"7"')
    expect(calls[1].body!.attendees).toEqual([
      latest[0],
      { ...latest[1], optional: true },
      { email: 'bob@x.com', responseStatus: 'tentative' },
      latest[4],
      { email: 'eve@x.com', optional: true }
    ])
  })

  it('sends no guests, call or extra read for a title change', async () => {
    route = () => served('e1')
    await updateGoogleEvent(deps, 'me@gmail.com', record({ attendeeCount: 3 }), { title: 'Deep work' })
    expect(calls.map((c) => c.method)).toEqual(['PATCH'])
    expect(Object.keys(calls[0].body!)).toEqual(['summary'])
    expect(calls[0].query.has('conferenceDataVersion')).toBe(false)
  })

  it('adds a Meet call only to an event without one, and removes one with conferenceData null', async () => {
    route = (c) => (c.method === 'GET' ? served('e1', { hangoutLink: 'https://meet.google.com/abc', conferenceData: {} }) : served('e1'))
    await updateGoogleEvent(deps, 'me@gmail.com', record(), { conference: true })
    expect(calls[1].body).not.toHaveProperty('conferenceData')
    expect(calls[1].query.has('conferenceDataVersion')).toBe(false)
    calls = []
    await updateGoogleEvent(deps, 'me@gmail.com', record(), { conference: false })
    expect(calls[1].body).toEqual({ conferenceData: null })
    expect(calls[1].query.get('conferenceDataVersion')).toBe('1')
  })

  it("sends the guest permissions with Google's names", async () => {
    route = () => served('e1')
    await updateGoogleEvent(deps, 'me@gmail.com', record(), { guestsCanModify: true, guestsCanSeeOtherGuests: false })
    expect(calls[0].body).toEqual({ guestsCanModify: true, guestsCanSeeOtherGuests: false })
  })

  it('tries once more when only a guest answer changed the event, but not when a shown field changed', async () => {
    let patches = 0
    route = (c) => (c.method === 'PATCH' && ++patches === 1 ? new Response('{}', { status: 412 }) : served('e1', { etag: '"8"' }))
    await updateGoogleEvent(deps, 'me@gmail.com', record(), { title: 'Focus' })
    expect(calls.map((c) => c.method)).toEqual(['PATCH', 'GET', 'PATCH'])
    expect(calls[2].headers['If-Match']).toBe('"8"')
    calls = []
    route = (c) => (c.method === 'GET' ? served('e1', { summary: 'Changed elsewhere' }) : served('e1'))
    const error = await updateGoogleEvent(deps, 'me@gmail.com', record(), { guestsCanModify: true, reminders: [5] }).catch((e) => e)
    expect(error).toBeInstanceOf(ConflictError)
    expect(calls.map((c) => c.method)).toEqual(['GET'])
  })

  it('sends cancellations on delete unless the organizer chose "Do not send"', async () => {
    route = () => new Response(null, { status: 204 })
    await deleteGoogleEvent(deps, 'me@gmail.com', record({ attendeeCount: 2 }))
    await deleteGoogleEvent(deps, 'me@gmail.com', record({ attendeeCount: 2 }), false)
    expect(calls.map((c) => c.query.get('sendUpdates'))).toEqual(['all', 'none'])
  })

  it('says an event that is gone no longer exists when it is changed', async () => {
    route = () => new Response('{"error":{"errors":[{"reason":"notFound"}]}}', { status: 404 })
    await expect(updateGoogleEvent(deps, 'me@gmail.com', record(), { title: 'Mine' })).rejects.toThrow(
      'This event no longer exists.'
    )
  })

  it('sets reminders as popups, keeps email ones, stops at five, and does not mail attendees', async () => {
    const email = { method: 'email', minutes: 1440 }
    route = (c) =>
      c.method === 'GET'
        ? served('e1', { reminders: { useDefault: false, overrides: [email, { method: 'popup', minutes: 10 }] } })
        : served('e1', { reminders: c.body!.reminders as GoogleEvent['reminders'] })
    const updated = await updateGoogleEvent(deps, 'me@gmail.com', record({ attendeeCount: 3 }), { reminders: [60, 30, 15, 10, 5, 1] })
    expect(calls[1]).toMatchObject({ method: 'PATCH', path: `${EVENTS}/e1` })
    expect(calls[1].body!.reminders).toEqual({
      useDefault: false,
      overrides: [email, ...[60, 30, 15, 10].map((minutes) => ({ method: 'popup', minutes }))]
    })
    expect(calls[1].query.get('sendUpdates')).toBe('none')
    // The answer says what Google kept.
    expect(updated.reminders).toEqual([60, 30, 15, 10])
  })

  it('turns 412 into a conflict that carries the latest version', async () => {
    route = (c) => (c.method === 'PATCH' ? new Response('{}', { status: 412 }) : served('e1', { summary: 'Changed elsewhere' }))
    const error = await updateGoogleEvent(deps, 'me@gmail.com', record(), { title: 'Mine' }).catch((e) => e)
    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).latest.title).toBe('Changed elsewhere')
  })

  it('treats an event that is already gone as deleted', async () => {
    route = () => new Response('{}', { status: 410 })
    await expect(deleteGoogleEvent(deps, 'me@gmail.com', record())).resolves.toBeUndefined()
    expect(calls[0].query.get('sendUpdates')).toBe('none')
  })

  it('answers with only our own entry, tells the organizer, and sends no If-Match', async () => {
    const attendees = [
      { email: 'boss@x.com', organizer: true, responseStatus: 'accepted' },
      { email: 'me@gmail.com', self: true, responseStatus: 'tentative' }
    ]
    route = () => served('e1', { organizer: { email: 'boss@x.com' }, attendees })
    const answered = await respondGoogleEvent(deps, 'me@gmail.com', 'e1', 'me@gmail.com', 'tentative')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: 'PATCH', path: `${EVENTS}/e1` })
    expect(calls[0].body).toEqual({ attendeesOmitted: true, attendees: [{ email: 'me@gmail.com', responseStatus: 'tentative' }] })
    expect(calls[0].query.get('sendUpdates')).toBe('all')
    // Another guest's answer changes the etag, so an old one would fail with 412.
    expect(calls[0].headers['If-Match']).toBeUndefined()
    expect(answered).toMatchObject({ response: 'tentative', attendeeCount: 2 })
  })

  it('says an event that is gone no longer exists', async () => {
    route = () => new Response('{}', { status: 404 })
    await expect(respondGoogleEvent(deps, 'me@gmail.com', 'e1', 'me@gmail.com', 'accepted')).rejects.toThrow(
      'This event no longer exists.'
    )
  })
})

describe('google series', () => {
  // Tue 27 Oct 2026, 09:00 in Lisbon (UTC+0 after the clock change).
  const weekly = { freq: 'weekly', interval: 1, days: [2], monthly: 'day', until: null, count: 6 } as const

  it('creates a series with its rule and the zone Google needs', async () => {
    route = (c) => served(c.body!.id as string)
    await createGoogleEvent(deps, 'me@gmail.com', { ...input, timeZone: 'Europe/Lisbon', endTimeZone: 'Europe/Lisbon', repeat: { ...weekly, days: [2] } })
    expect(calls[0].body!.recurrence).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=6'])
    expect(calls[0].body!.start).toMatchObject({ timeZone: 'Europe/Lisbon' })
    // All-day: the date form of UNTIL and no zone.
    const day = { allDay: true, startDate: '2026-10-27', endDate: '2026-10-28', start: Date.UTC(2026, 9, 27), end: Date.UTC(2026, 9, 28) }
    await createGoogleEvent(deps, 'me@gmail.com', { ...input, ...day, repeat: { ...weekly, days: [2], count: null, until: '2026-12-01' } })
    expect(calls[1].body!.recurrence).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261201'])
    expect(calls[1].body!.start).toEqual({ date: '2026-10-27', dateTime: null })
  })

  it('reads the rule of a series, and null for one the app cannot write back', async () => {
    const master = { start: { dateTime: '2026-10-27T09:00:00Z', timeZone: 'Europe/Lisbon' }, end: { dateTime: '2026-10-27T10:00:00Z' } }
    route = () => served('s1', { ...master, recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=6', 'EXDATE:20261103T090000Z'] })
    await expect(getGoogleSeries(deps, 'me@gmail.com', 's1')).resolves.toEqual({ repeat: { ...weekly, days: [2] }, first: T0, zone: 'Europe/Lisbon' })
    expect(calls[0]).toMatchObject({ method: 'GET', path: `${EVENTS}/s1` })
    expect(calls[0].query.get('fields')).toBe('start,end,recurrence')
    route = () => served('s1', { ...master, recurrence: ['RRULE:FREQ=MONTHLY;BYDAY=TU;BYSETPOS=1'] })
    await expect(getGoogleSeries(deps, 'me@gmail.com', 's1')).resolves.toMatchObject({ repeat: null })
  })
})

// A weekly series of the user's: Tue 10:00 in Lisbon (UTC+0 in winter) from 1 Dec 2026, 6 times, with one guest. 22 Dec
// is deleted by an EXDATE line, 5 Jan as a cancelled event (how Google web deletes one event).
describe('google series writes', () => {
  const at = (date: string, time = '10:00'): number => Date.parse(`${date}T${time}:00Z`)
  const attendees = [{ email: 'me@gmail.com', organizer: true, self: true, responseStatus: 'accepted' }, { email: 'ann@x.com', responseStatus: 'needsAction' }]
  const master: GoogleEvent = {
    id: 's1',
    etag: '"m1"',
    summary: 'Standup',
    start: { dateTime: '2026-12-01T10:00:00Z', timeZone: 'Europe/Lisbon' },
    end: { dateTime: '2026-12-01T10:30:00Z', timeZone: 'Europe/Lisbon' },
    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=6', 'EXDATE;TZID=Europe/Lisbon:20261222T100000'],
    organizer: { self: true, email: 'me@gmail.com' },
    attendees
  }
  const instance = (date: string): GoogleEvent => ({
    ...master,
    id: `s1_${date.replaceAll('-', '')}T100000Z`,
    etag: '"i1"',
    recurrence: undefined,
    recurringEventId: 's1',
    start: { dateTime: new Date(at(date)).toISOString(), timeZone: 'Europe/Lisbon' },
    end: { dateTime: new Date(at(date, '10:30')).toISOString(), timeZone: 'Europe/Lisbon' },
    originalStartTime: { dateTime: new Date(at(date)).toISOString() }
  })
  const times = (date: string, time = '10:00', end = '10:30'): EventInput => ({ ...input, start: at(date, time), end: at(date, end) })
  const cancelled = { items: [{ status: 'cancelled', originalStartTime: { dateTime: '2027-01-05T10:00:00Z' } }] }
  // Google as it is now: the event, the series, its deleted events, and the answers to writes.
  const google = (extra: (c: Call) => unknown = () => undefined) => (c: Call): unknown => {
    const answer = extra(c)
    if (answer !== undefined) return answer
    if (c.path.endsWith('/instances')) return cancelled
    if (c.method === 'GET' && c.path === `${EVENTS}/s1`) return master
    if (c.method === 'GET') return instance(c.path.slice(-16, -8).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'))
    if (c.method === 'DELETE') return new Response(null, { status: 204 })
    return { ...master, ...c.body, id: (c.body?.id as string) ?? 's1' }
  }
  const writes = (): string[] => calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path.slice(EVENTS.length) || '/'}`)
  const END = at('2027-12-01')

  it('moves all events: the series keeps its first date, takes the new time, and deleted events move with it', async () => {
    route = google()
    const record = toRecord(instance('2026-12-15'))
    await updateGoogleSeries(deps, 'me@gmail.com', record, { times: times('2026-12-15', '11:00', '11:30') }, 'series', 'x', END)
    expect(writes()).toEqual(['PATCH /s1'])
    const patch = calls.find((c) => c.method === 'PATCH')!
    expect(patch.headers['If-Match']).toBe('"m1"')
    // The series' guests hear about it, not this event's.
    expect(patch.query.get('sendUpdates')).toBe('all')
    expect(patch.body!.start).toEqual({ dateTime: '2026-12-01T11:00:00.000Z', date: null, timeZone: 'Europe/Lisbon' })
    expect(patch.body!.recurrence).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=6', 'EXDATE:20261222T110000Z,20270105T110000Z'])
    const read = calls.find((c) => c.path.endsWith('/instances'))!
    expect([read.query.get('showDeleted'), read.query.get('maxResults'), read.query.get('timeMin')]).toEqual(['true', '2500', '2026-12-01T10:00:00.000Z'])
  })

  it('moves the first event to another day with all events, and the rule follows the day (addendum item 6)', async () => {
    route = google()
    await updateGoogleSeries(deps, 'me@gmail.com', toRecord(instance('2026-12-01')), { times: times('2026-12-02') }, 'series', 'x', END)
    const patch = calls.find((c) => c.method === 'PATCH')!
    expect(patch.body!.start).toMatchObject({ dateTime: '2026-12-02T10:00:00.000Z' })
    expect(patch.body!.recurrence).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=6', 'EXDATE:20261223T100000Z,20270106T100000Z'])
  })

  it('never moves all events from a later event to another day, or for a series someone else organizes', async () => {
    route = google()
    const record = toRecord(instance('2026-12-15'))
    await expect(updateGoogleSeries(deps, 'me@gmail.com', record, { times: times('2026-12-16') }, 'series', 'x', END)).rejects.toThrow(ConflictError)
    route = google((c) => (c.method === 'GET' && c.path === `${EVENTS}/s1` ? { ...master, organizer: { email: 'boss@x.com' } } : undefined))
    await expect(updateGoogleSeries(deps, 'me@gmail.com', record, { title: 'Mine now' }, 'series', 'x', END)).rejects.toThrow(
      'Only the organizer can change all events.'
    )
    expect(writes()).toEqual([])
  })

  it('keeps deleted events with a new rule for all events (addendum item 11), and sends no times', async () => {
    route = google()
    const repeat = { freq: 'weekly', interval: 1, days: [2], monthly: 'day', until: '2027-01-26', count: null } as const
    await updateGoogleSeries(deps, 'me@gmail.com', toRecord(instance('2026-12-15')), { repeat: { ...repeat, days: [2] } }, 'series', 'x', END)
    const patch = calls.find((c) => c.method === 'PATCH')!
    expect(patch.body!.recurrence).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20270126T235959Z', 'EXDATE:20261222T100000Z,20270105T100000Z'])
    expect(patch.body!.start).toBeUndefined()
  })

  it('tries all events once more after a 412 only when the times and rule it planned with are the same', async () => {
    let tries = 0
    const fresh = { ...master, etag: '"m2"' }
    route = google((c) => {
      if (c.method === 'PATCH' && tries++ === 0) return new Response('{}', { status: 412 })
      if (c.method === 'GET' && c.path === `${EVENTS}/s1` && tries > 0) return fresh
      return undefined
    })
    await updateGoogleSeries(deps, 'me@gmail.com', toRecord(instance('2026-12-15')), { title: 'Daily' }, 'series', 'x', END)
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.headers['If-Match'])).toEqual(['"m1"', '"m2"'])
    calls = []
    tries = 0
    fresh.start = { dateTime: '2026-12-01T09:00:00Z', timeZone: 'Europe/Lisbon' }
    await expect(
      updateGoogleSeries(deps, 'me@gmail.com', toRecord(instance('2026-12-15')), { title: 'Daily' }, 'series', 'x', END)
    ).rejects.toThrow(ConflictError)
    expect(writes()).toEqual(['PATCH /s1'])
  })

  it('deletes all events on the series, telling its guests unless the organizer chose "Do not send"', async () => {
    route = google()
    await deleteGoogleSeries(deps, 'me@gmail.com', toRecord(instance('2026-12-15')), 'series')
    await deleteGoogleSeries(deps, 'me@gmail.com', toRecord(instance('2026-12-15')), 'series', false)
    const deletes = calls.filter((c) => c.method === 'DELETE')
    expect(deletes.map((c) => [c.path, c.query.get('sendUpdates')])).toEqual([
      [`${EVENTS}/s1`, 'all'],
      [`${EVENTS}/s1`, 'none']
    ])
  })

  const split = (date = '2026-12-15', change: EventChange = { title: 'Standup v2' }): Promise<unknown> =>
    updateGoogleSeries(deps, 'me@gmail.com', toRecord(instance(date)), change, 'following', 'n1', END)

  it('splits: the new series starts at this event with the rest of the count, then the old one ends before it', async () => {
    route = google()
    await split()
    expect(writes()).toEqual(['POST /', 'PATCH /s1'])
    const [post, cut] = calls.filter((c) => c.method !== 'GET')
    expect(post.body).toMatchObject({ id: 'n1', summary: 'Standup v2', attendees, start: { dateTime: '2026-12-15T10:00:00.000Z', timeZone: 'Europe/Lisbon' } })
    // 1 and 8 Dec stay with the old series; the deleted events go with the new one.
    expect(post.body!.recurrence).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=4', 'EXDATE:20261222T100000Z,20270105T100000Z'])
    expect(post.query.get('sendUpdates')).toBe('all')
    expect(cut.headers['If-Match']).toBe('"m1"')
    expect(cut.body).toEqual({ recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261214T235959Z', 'EXDATE;TZID=Europe/Lisbon:20261222T100000'] })
  })

  it('splits to another day and time, and the deleted events move with the new series', async () => {
    route = google()
    await split('2026-12-15', { times: times('2026-12-16', '11:00', '11:30') })
    const post = calls.find((c) => c.method === 'POST')!
    expect(post.body!.recurrence).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=4', 'EXDATE:20261223T110000Z,20270106T110000Z'])
  })

  it('deletes the new series again when the old one cannot end, so no event shows twice', async () => {
    route = google((c) => (c.method === 'PATCH' ? new Response('{}', { status: 403 }) : undefined))
    await expect(split()).rejects.toThrow('Could not change this and following events.')
    expect(writes()).toEqual(['POST /', 'PATCH /s1', 'DELETE /n1'])
    route = google((c) => (c.method === 'PATCH' || c.method === 'DELETE' ? new Response('{}', { status: 403 }) : undefined))
    await expect(split()).rejects.toThrow('Some events may show twice: Standup v2 from')
  })

  it('after a token error at the cut, the re-run finds the new series by its id and ends the old one, with no rollback', async () => {
    let cuts = 0
    route = google((c) => {
      if (c.method === 'PATCH' && cuts++ === 0) return new Response('{}', { status: 401 })
      if (c.method === 'POST' && cuts > 0) return new Response('{}', { status: 409 })
      if (c.method === 'GET' && c.path === `${EVENTS}/n1`) return { ...master, id: 'n1', etag: '"n1"' }
      return undefined
    })
    await expect(split()).rejects.toThrow(GoogleAuthError)
    await split()
    expect(writes()).toEqual(['POST /', 'PATCH /s1', 'POST /', 'PATCH /s1'])
  })

  it('never ends the old series when the new id was deleted before, or when nothing was made', async () => {
    route = google((c) => {
      if (c.method === 'POST') return new Response('{}', { status: 409 })
      if (c.path === `${EVENTS}/n1`) return { id: 'n1', status: 'cancelled' }
      return undefined
    })
    const undone = await split().catch((e: Error) => e)
    // No cut first: the old series keeps its events.
    expect(writes()).toEqual(['POST /'])
    expect(undone).toHaveProperty('message', expect.stringContaining('This split was undone before.'))
    route = google((c) => {
      if (c.method === 'POST') return new Response('{}', { status: 503 })
      if (c.path === `${EVENTS}/n1`) return new Response('{}', { status: 404 })
      return undefined
    })
    await expect(split()).rejects.toThrow('Google 503')
    expect(writes()).toEqual(['POST /', 'POST /'])
  })

  it('ends the old series once more after a 412 only when the guests and times it copied are the same', async () => {
    let cuts = 0
    const fresh = { ...master, etag: '"m2"' }
    route = google((c) => {
      if (c.method === 'PATCH' && cuts++ === 0) return new Response('{}', { status: 412 })
      if (c.method === 'GET' && c.path === `${EVENTS}/s1` && cuts > 0) return fresh
      return undefined
    })
    await split()
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.headers['If-Match'])).toEqual(['"m1"', '"m2"'])
    calls = []
    cuts = 0
    fresh.attendees = [...attendees, { email: 'bob@x.com' }]
    await expect(split()).rejects.toThrow('Could not change this and following events.')
    expect(writes()).toEqual(['POST /', 'PATCH /s1', 'DELETE /n1'])
  })

  it('deletes this and following by ending the series before this event, never from the first event', async () => {
    route = google()
    await deleteGoogleSeries(deps, 'me@gmail.com', toRecord(instance('2026-12-15')), 'following')
    expect(writes()).toEqual(['PATCH /s1'])
    expect(calls.at(-1)!.headers['If-Match']).toBe('"m1"')
    expect(calls.at(-1)!.body!.recurrence).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261214T235959Z', 'EXDATE;TZID=Europe/Lisbon:20261222T100000'])
    await expect(deleteGoogleSeries(deps, 'me@gmail.com', toRecord(instance('2026-12-01')), 'following')).rejects.toThrow(
      'The series was changed somewhere else. Try again.'
    )
    route = google((c) => (c.method === 'PATCH' ? new Response('{}', { status: 412 }) : undefined))
    await expect(deleteGoogleSeries(deps, 'me@gmail.com', toRecord(instance('2026-12-15')), 'following')).rejects.toThrow(
      'The series was changed somewhere else. Try again.'
    )
  })

  it('reads the old series when the cut got no answer: a cut that happened stays, an unknown one leaves both (S-M1)', async () => {
    const ended = ['RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261214T235959Z', 'EXDATE;TZID=Europe/Lisbon:20261222T100000']
    // The cut PATCH reaches Google, but its answer is lost; then the series reads as read() gives it.
    const lost = (read: () => unknown): ((c: Call) => unknown) => {
      let sent = false
      return google((c) => {
        if (c.method === 'PATCH') {
          sent = true
          throw new TypeError('fetch failed')
        }
        return sent && c.method === 'GET' && c.path === `${EVENTS}/s1` ? read() : undefined
      })
    }
    route = lost(() => ({ ...master, recurrence: ended }))
    const done = await split().catch((e: Error) => e)
    // No rollback: the cut was made.
    expect(writes()).toEqual(['POST /', 'PATCH /s1'])
    expect(done).not.toBeInstanceOf(Error)
    calls = []
    route = lost(() => new Response('{}', { status: 500 }))
    await expect(split()).rejects.toThrow('Some events may show twice: Standup v2 from')
    expect(writes()).toEqual(['POST /', 'PATCH /s1'])
    // The series has its old rule: the cut was not made, so the new series goes again.
    calls = []
    route = lost(() => master)
    await expect(split()).rejects.toThrow('Could not change this and following events.')
    expect(writes()).toEqual(['POST /', 'PATCH /s1', 'DELETE /n1'])
    // Our cut in another line order, or a rule someone else wrote: the cut may have been made, so both stay.
    for (const recurrence of [[...ended].reverse(), ['RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261214T235959Z;WKST=MO']]) {
      calls = []
      route = lost(() => ({ ...master, recurrence }))
      await expect(split()).rejects.toThrow('Some events may show twice: Standup v2 from')
      expect(writes()).toEqual(['POST /', 'PATCH /s1'])
    }
  })

  it('writes the rule again when all events move earlier or later, so its UNTIL fits the new time (S-M2)', async () => {
    const move = async (recurrence: string[], time: string, end: string): Promise<unknown> => {
      calls = []
      route = google((c) => {
        if (c.path.endsWith('/instances')) return { items: [] }
        return c.method === 'GET' && c.path === `${EVENTS}/s1` ? { ...master, recurrence } : undefined
      })
      await updateGoogleSeries(deps, 'me@gmail.com', toRecord(instance('2026-12-08')), { times: times('2026-12-08', time, end) }, 'series', 'x', END)
      return calls.find((c) => c.method === 'PATCH')!.body!.recurrence
    }
    // Cut before 15 Dec at 10:00: at 09:00 an old UNTIL of 09:59:59 would bring 15 Dec back.
    expect(await move(['RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261215T095959Z'], '09:00', '09:30')).toEqual([
      'RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261214T235959Z'
    ])
    // UNTIL at the last start (Apple and others write it): at 11:00 the old one would drop 2 Mar.
    expect(await move(['RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20270302T100000Z'], '11:00', '11:30')).toEqual([
      'RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20270302T235959Z'
    ])
  })

  it('moves a deleted event of a monthly weekday rule to the new rule\'s day of its month (C-S1)', async () => {
    const monthly = { ...master, recurrence: ['RRULE:FREQ=MONTHLY;BYDAY=1TU', 'EXDATE;TZID=Europe/Lisbon:20270907T100000'] }
    route = google((c) => {
      if (c.path.endsWith('/instances')) return { items: [] }
      return c.method === 'GET' && c.path === `${EVENTS}/s1` ? monthly : undefined
    })
    await updateGoogleSeries(deps, 'me@gmail.com', toRecord(instance('2026-12-01')), { times: times('2026-12-02') }, 'series', 'x', END)
    // The first Wednesday of September 2027 is the 1st, not 7 + 1 = the 8th. 10:00 in Lisbon is 09:00 UTC in summer.
    expect(calls.find((c) => c.method === 'PATCH')!.body!.recurrence).toEqual(['RRULE:FREQ=MONTHLY;BYDAY=1WE', 'EXDATE:20270901T090000Z'])
  })

  it('splits at an event moved once from the series\' own slot and length, so later events do not move to it or take its length (S-S4, N-S2)', async () => {
    const moved = { ...instance('2026-12-15'), start: { dateTime: '2026-12-16T14:00:00.000Z' }, end: { dateTime: '2026-12-16T16:00:00.000Z' } }
    route = google((c) => (c.method === 'GET' && c.path === `${EVENTS}/${moved.id}` ? moved : undefined))
    await updateGoogleSeries(deps, 'me@gmail.com', toRecord(moved), { title: 'Standup v2' }, 'following', 'n1', END)
    const post = calls.find((c) => c.method === 'POST')!
    expect(post.body!.start).toMatchObject({ dateTime: '2026-12-15T10:00:00.000Z' })
    expect(post.body!.end).toMatchObject({ dateTime: '2026-12-15T10:30:00.000Z' })
    expect(post.body!.recurrence).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=4', 'EXDATE:20261222T100000Z,20270105T100000Z'])
  })

  it('keeps only the deleted events the new rule makes when the rule changes kind, never moving them onto its dates (N-M1)', async () => {
    const monthly = { freq: 'monthly' as const, interval: 1, days: [], monthly: 'weekday' as const, until: null, count: null }
    route = google()
    await split('2026-12-08', { repeat: monthly })
    // 22 Dec and 5 Jan are not second Tuesdays: they go, and the new series keeps its first event, 8 Dec.
    expect(calls.find((c) => c.method === 'POST')!.body!.recurrence).toEqual(['RRULE:FREQ=MONTHLY;BYDAY=2TU'])
    calls = []
    await updateGoogleSeries(deps, 'me@gmail.com', toRecord(instance('2026-12-01')), { repeat: monthly }, 'series', 'x', END)
    // 5 Jan is the first Tuesday of January, so it stays deleted. 22 Dec goes; nothing moves onto 1 Dec.
    expect(calls.find((c) => c.method === 'PATCH')!.body!.recurrence).toEqual(['RRULE:FREQ=MONTHLY;BYDAY=1TU', 'EXDATE:20270105T100000Z'])
  })

  it('drops a deleted date the old rule does not make, so it never lands on the new first event (R3-S1)', async () => {
    const stray = { ...master, recurrence: ['RRULE:FREQ=MONTHLY;BYDAY=1TU', 'EXDATE;TZID=Europe/Lisbon:20270119T100000'] }
    route = google((c) => {
      if (c.path.endsWith('/instances')) return { items: [] }
      return c.method === 'GET' && c.path === `${EVENTS}/s1` ? stray : undefined
    })
    // 19 Jan is not a first Tuesday. 5 Jan moved to 12 Jan makes "second Tuesday" from 12 Jan, with no deleted event.
    await split('2027-01-05', { times: times('2027-01-12') })
    const post = calls.find((c) => c.method === 'POST')!
    expect(post.body!.start).toMatchObject({ dateTime: '2027-01-12T10:00:00.000Z' })
    expect(post.body!.recurrence).toEqual(['RRULE:FREQ=MONTHLY;BYDAY=2TU'])
  })

  it('drops deleted dates when the rule changes kind and the day moves, so no new event is hidden (R3-S2)', async () => {
    const weekly = { ...master, recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU', 'EXDATE;TZID=Europe/Lisbon:20270112T100000'] }
    route = google((c) => {
      if (c.path.endsWith('/instances')) return { items: [] }
      return c.method === 'GET' && c.path === `${EVENTS}/s1` ? weekly : undefined
    })
    const monthly = { freq: 'monthly' as const, interval: 1, days: [], monthly: 'weekday' as const, until: null, count: null }
    // 8 Dec moved to Wed 9 Dec as "Monthly on the second Wednesday": 12 Jan shifted is 13 Jan, a new event the user kept.
    await split('2026-12-08', { times: times('2026-12-09'), repeat: monthly })
    expect(calls.find((c) => c.method === 'POST')!.body!.recurrence).toEqual(['RRULE:FREQ=MONTHLY;BYDAY=2WE'])
  })

  it("mails the series' guests also from an event of it that has none (R2-S9)", async () => {
    const alone = { ...instance('2026-12-15'), attendees: undefined }
    route = google((c) => (c.method === 'GET' && c.path === `${EVENTS}/${alone.id}` ? alone : undefined))
    await updateGoogleSeries(deps, 'me@gmail.com', toRecord(alone), { title: 'Daily' }, 'series', 'x', END)
    await deleteGoogleSeries(deps, 'me@gmail.com', toRecord(alone), 'following')
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.query.get('sendUpdates'))).toEqual(['all', 'all'])
  })

  it("copies the series' label to the new one with the flag, and a taken-off label is just none there", async () => {
    route = google((c) => (c.method === 'GET' && c.path === `${EVENTS}/s1` ? { ...master, eventLabelId: 'cobalt', colorId: '11' } : undefined))
    await split()
    const post = calls.find((c) => c.method === 'POST')!
    expect(post.body).toMatchObject({ eventLabelId: 'cobalt' })
    expect(post.query.get('eventLabelVersion')).toBe('1')
    calls = []
    await split('2026-12-15', { title: 'Standup v2', label: '', colorId: '5' })
    const plain = calls.find((c) => c.method === 'POST')!
    expect(plain.body).not.toHaveProperty('eventLabelId')
    expect(plain.body!.colorId).toBe('5')
    expect(plain.query.has('eventLabelVersion')).toBe(false)
    // Default: no label and no classic color on the new series, though the old one has both.
    calls = []
    await split('2026-12-15', { title: 'Standup v3', label: '', colorId: null })
    const none = calls.find((c) => c.method === 'POST')!
    expect(none.body).not.toHaveProperty('eventLabelId')
    expect(none.body!.colorId).toBeNull()
    expect(none.query.has('eventLabelVersion')).toBe(false)
  })

  it('takes the label and the classic color off all events on the series with Default, without mailing its guests (F2)', async () => {
    route = google((c) => {
      if (c.method === 'GET' && c.path === `${EVENTS}/s1`) return { ...master, eventLabelId: 'cobalt', colorId: '11' }
      // With the flag Google ignores colorId.
      if (c.method === 'PATCH') return c.query.has('eventLabelVersion') ? { ...master, etag: '"m2"', colorId: '11' } : { ...master, etag: '"m3"' }
      return undefined
    })
    const updated = await updateGoogleSeries(deps, 'me@gmail.com', toRecord(instance('2026-12-15')), { label: '', colorId: null }, 'series', 'x', END)
    const [first, second] = calls.filter((c) => c.method === 'PATCH')
    expect(first.body).toEqual({ eventLabelId: '', colorId: null })
    expect(first.headers['If-Match']).toBe('"m1"')
    expect(first.query.get('eventLabelVersion')).toBe('1')
    expect(first.query.get('sendUpdates')).toBe('none')
    expect(writes()).toEqual(['PATCH /s1', 'PATCH /s1'])
    expect(second.body).toEqual({ colorId: null })
    expect(second.headers['If-Match']).toBe('"m2"')
    expect(second.query.get('sendUpdates')).toBe('none')
    expect(updated.colorId).toBeNull()
    expect(updated.eventLabelId).toBeNull()
  })
})

describe('google colors', () => {
  it('sets a label with the flag Google needs, and never mails guests about it', async () => {
    route = () => served('e1', { eventLabelId: 'cobalt' })
    const updated = await updateGoogleEvent(deps, 'me@gmail.com', record({ attendeeCount: 3 }), { label: 'cobalt' })
    expect(calls).toHaveLength(1)
    expect(calls[0].body).toEqual({ eventLabelId: 'cobalt' })
    expect(calls[0].query.get('eventLabelVersion')).toBe('1')
    expect(calls[0].query.get('sendUpdates')).toBe('none')
    expect(updated.eventLabelId).toBe('cobalt')
  })

  it('takes off the label, then the classic color in a PATCH of its own on the new copy (A-S6)', async () => {
    route = (c) => (c.headers['If-Match'] === '"1"' ? served('e1', { etag: '"3"', colorId: '11' }) : served('e1', { etag: '"4"' }))
    const updated = await updateGoogleEvent(deps, 'me@gmail.com', record({ eventLabelId: 'tomato', colorId: '11' }), { label: '', colorId: null })
    expect(calls.map((c) => c.method)).toEqual(['PATCH', 'PATCH'])
    expect(calls[0].body).toEqual({ eventLabelId: '', colorId: null })
    expect(calls[1].body).toEqual({ colorId: null })
    expect(calls[1].headers['If-Match']).toBe('"3"')
    expect(calls[1].query.get('sendUpdates')).toBe('none')
    expect(calls[1].query.has('eventLabelVersion')).toBe(false)
    expect(updated.version).toBe('"4"')
  })

  it('sends a classic color once, without the label flag, when Google keeps it, and never mails guests about it', async () => {
    route = () => served('e1', { colorId: '11' })
    await updateGoogleEvent(deps, 'me@gmail.com', record({ attendeeCount: 3 }), { colorId: '11' })
    expect(calls).toHaveLength(1)
    expect(calls[0].body).toEqual({ colorId: '11' })
    expect(calls[0].query.has('eventLabelVersion')).toBe(false)
    expect(calls[0].query.get('sendUpdates')).toBe('none')
  })

  it('creates with a label', async () => {
    route = (c) => served(c.body!.id as string, { eventLabelId: 'cobalt' })
    await createGoogleEvent(deps, 'me@gmail.com', input, undefined, undefined, { label: 'cobalt' })
    expect(calls).toHaveLength(1)
    expect(calls[0].body!.eventLabelId).toBe('cobalt')
    expect(calls[0].query.get('eventLabelVersion')).toBe('1')
  })
})
