import { beforeEach, describe, expect, it } from 'vitest'
import type { EventInput } from '../../../shared/api'
import { ConflictError, type EventChange } from '../write'
import { OUTLOOK_BASE, OutlookAuthError, type OutlookDeps } from './client'
import { toRecord, type OutlookEvent } from './map'
import { createOutlookEvent, deleteOutlookEvent, deleteOutlookSeries, respondOutlookEvent, updateOutlookEvent, updateOutlookSeries } from './write'

// Set before any Date is made. Outlook times are local wall time in this zone.
process.env.TZ = 'Europe/Berlin'

const H = 3600_000
const T0 = Date.UTC(2026, 9, 27, 9)

interface Call {
  method: string
  path: string
  body: Record<string, unknown> | null
}

let calls: Call[]
let route: (call: Call) => unknown

const deps: OutlookDeps = {
  sleep: async () => {},
  getToken: () => ({ raw: 't', anchor: 'a', exp: Infinity, upn: 'me@work.com', tid: 'x' }),
  fetch: (async (url: string, init: RequestInit) => {
    const call: Call = {
      method: init.method ?? 'GET',
      path: url.slice(OUTLOOK_BASE.length),
      body: init.body ? JSON.parse(init.body as string) : null
    }
    calls.push(call)
    const body = route(call)
    return body instanceof Response ? body : new Response(body === undefined ? '' : JSON.stringify(body))
  }) as typeof fetch
}

const served = (extra: Partial<OutlookEvent> = {}): OutlookEvent => ({
  Id: 'E1',
  Subject: 'Focus',
  ChangeKey: 'k2',
  Start: { DateTime: '2026-10-27T09:00:00.0000000', TimeZone: 'UTC' },
  End: { DateTime: '2026-10-27T10:00:00.0000000', TimeZone: 'UTC' },
  IsAllDay: false,
  Type: 'SingleInstance',
  IsOrganizer: true,
  ...extra
})
// The event as the last sync stored it.
const stored = toRecord(served({ ChangeKey: 'k1' }))

const input: EventInput = {
  calendarId: 1,
  title: 'Focus',
  start: T0,
  end: T0 + H,
  allDay: false,
  startDate: null,
  endDate: null,
  location: 'Room 1',
  description: ''
}

beforeEach(() => {
  calls = []
  route = () => new Response('{}', { status: 500 })
})

describe('outlook writes', () => {
  it("creates with a TransactionId, in the user's zone", async () => {
    route = () => served()
    const created = await createOutlookEvent(deps, 'CAL=', input)
    expect(calls[0]).toMatchObject({ method: 'POST', path: 'calendars/CAL%3D/events' })
    expect(calls[0].body).toMatchObject({
      Subject: 'Focus',
      Location: { DisplayName: 'Room 1' },
      IsAllDay: false,
      Start: { DateTime: '2026-10-27T10:00:00', TimeZone: 'W. Europe Standard Time' },
      End: { DateTime: '2026-10-27T11:00:00', TimeZone: 'W. Europe Standard Time' }
    })
    expect(calls[0].body!.TransactionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(created).toMatchObject({ remoteId: 'E1', version: 'k2', start: T0 })
  })

  it('keeps the earliest reminder, the only one Outlook has room for', async () => {
    route = () => served()
    await createOutlookEvent(deps, 'CAL', input, [30, 5])
    expect(calls[0].body).toMatchObject({ IsReminderOn: true, ReminderMinutesBeforeStart: 30 })
    calls = []
    await createOutlookEvent(deps, 'CAL', input, [])
    expect(calls[0].body!.IsReminderOn).toBe(false)
    expect(calls[0].body!).not.toHaveProperty('ReminderMinutesBeforeStart')
  })

  it('creates all-day events at midnight of their dates', async () => {
    route = () => served()
    await createOutlookEvent(deps, 'CAL', { ...input, allDay: true, startDate: '2026-10-27', endDate: '2026-10-28' })
    expect(calls[0].body).toMatchObject({
      IsAllDay: true,
      Start: { DateTime: '2026-10-27T00:00:00', TimeZone: 'W. Europe Standard Time' },
      End: { DateTime: '2026-10-28T00:00:00', TimeZone: 'W. Europe Standard Time' }
    })
  })

  it('sends wall time across a DST change', async () => {
    route = () => served()
    const start = Date.UTC(2026, 2, 29, 0, 30)
    await createOutlookEvent(deps, 'CAL', { ...input, start, end: start + H })
    expect(calls[0].body).toMatchObject({
      Start: { DateTime: '2026-03-29T01:30:00', TimeZone: 'W. Europe Standard Time' },
      End: { DateTime: '2026-03-29T03:30:00', TimeZone: 'W. Europe Standard Time' }
    })
  })

  it('keeps the moment we sent in whole seconds, as Outlook answers a write in the zone we sent', async () => {
    const berlin = served({
      Start: { DateTime: '2026-10-27T10:00:00.0000000', TimeZone: 'W. Europe Standard Time' },
      End: { DateTime: '2026-10-27T11:00:00.0000000', TimeZone: 'W. Europe Standard Time' }
    })
    route = (c) => (c.method === 'GET' ? served({ ChangeKey: 'k1' }) : berlin)
    await expect(createOutlookEvent(deps, 'CAL', input)).resolves.toMatchObject({ start: T0, end: T0 + H })
    await expect(updateOutlookEvent(deps, stored, { times: input })).resolves.toMatchObject({ start: T0, end: T0 + H })
    // The wall time has no milliseconds, so the stored moment must not have them either.
    const late = { ...input, start: T0 + 500, end: T0 + H + 500 }
    await expect(createOutlookEvent(deps, 'CAL', late)).resolves.toMatchObject({ start: T0, end: T0 + H })
  })

  it("falls back to UTC, or the IANA name for all-day, when the user's zone is not in the table", async () => {
    route = () => served()
    try {
      // No Windows name has this clock.
      process.env.TZ = 'Antarctica/Troll'
      await createOutlookEvent(deps, 'CAL', input)
      await createOutlookEvent(deps, 'CAL', { ...input, allDay: true, startDate: '2026-10-27', endDate: '2026-10-28' })
    } finally {
      process.env.TZ = 'Europe/Berlin'
    }
    expect(calls[0].body).toMatchObject({ Start: { DateTime: '2026-10-27T09:00:00', TimeZone: 'UTC' } })
    expect(calls[1].body).toMatchObject({ Start: { DateTime: '2026-10-27T00:00:00', TimeZone: 'Antarctica/Troll' } })
  })

  it('creates in the zones the user picked, each end in its own', async () => {
    route = () => served()
    await createOutlookEvent(deps, 'CAL', { ...input, timeZone: 'Asia/Tokyo', endTimeZone: 'America/New_York' })
    expect(calls[0].body).toMatchObject({
      Start: { DateTime: '2026-10-27T18:00:00', TimeZone: 'Tokyo Standard Time' },
      End: { DateTime: '2026-10-27T06:00:00', TimeZone: 'Eastern Standard Time' }
    })
  })

  it('refuses a picked zone Outlook does not take, before it changes anything', async () => {
    route = (c) => (c.method === 'GET' ? served({ ChangeKey: 'k1' }) : served())
    const troll = { timeZone: 'Antarctica/Troll', endTimeZone: 'Antarctica/Troll' }
    await expect(createOutlookEvent(deps, 'CAL', { ...input, ...troll })).rejects.toThrow('Outlook does not take this time zone.')
    await expect(updateOutlookEvent(deps, stored, { times: input, ...troll })).rejects.toThrow('Outlook does not take this time zone.')
    expect(calls.map((c) => c.method)).toEqual(['GET'])
  })

  it('refuses a picked UTC, which the app would read back as its own old write', async () => {
    route = () => served()
    const utc = { timeZone: 'UTC', endTimeZone: 'UTC' }
    await expect(createOutlookEvent(deps, 'CAL', { ...input, ...utc })).rejects.toThrow('Outlook does not take this time zone.')
    await expect(createOutlookEvent(deps, 'CAL', { ...input, timeZone: 'Europe/Rome', endTimeZone: 'UTC' })).rejects.toThrow()
    expect(calls).toEqual([])
  })

  it('does not overwrite an event that changed since our last sync', async () => {
    route = () => served({ Subject: 'Changed elsewhere', ChangeKey: 'k9' })
    const error = await updateOutlookEvent(deps, stored, { title: 'Mine' }).catch((e) => e)
    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).latest.title).toBe('Changed elsewhere')
    expect(calls.map((c) => c.method)).toEqual(['GET'])
  })

  it('patches only the changed fields when the version matches', async () => {
    route = (c) => (c.method === 'GET' ? served({ ChangeKey: 'k1' }) : served({ Subject: 'Deep work' }))
    const updated = await updateOutlookEvent(deps, stored, { title: 'Deep work' })
    expect(calls[1]).toMatchObject({ method: 'PATCH', path: 'events/E1', body: { Subject: 'Deep work' } })
    expect(updated.title).toBe('Deep work')
  })

  it('patches when only the ChangeKey changed, as Outlook does by itself after a create', async () => {
    route = (c) =>
      c.method === 'GET' ? served({ ChangeKey: 'k2' }) : served({ Subject: 'Deep work' })
    const update = updateOutlookEvent(deps, stored, { title: 'Deep work' })
    await expect(update).resolves.toMatchObject({ title: 'Deep work' })
    expect(calls[1]).toMatchObject({
      method: 'PATCH',
      path: 'events/E1',
      body: { Subject: 'Deep work' }
    })
  })

  it("keeps the event's own zone when times change", async () => {
    route = (c) => (c.method === 'GET' ? served({ ChangeKey: 'k1', OriginalStartTimeZone: 'Eastern Standard Time' }) : served())
    await updateOutlookEvent(deps, stored, { times: input })
    // New York is still on summer time on Oct 27 (UTC-4), Berlin is not.
    expect(calls[1].body).toMatchObject({
      Start: { DateTime: '2026-10-27T05:00:00', TimeZone: 'Eastern Standard Time' },
      End: { DateTime: '2026-10-27T06:00:00', TimeZone: 'Eastern Standard Time' }
    })
  })

  it('keeps the end zone too, and a picked zone wins over the kept ones', async () => {
    route = (c) => (c.method === 'GET' ? served({ ChangeKey: 'k1', OriginalEndTimeZone: 'Eastern Standard Time' }) : served())
    await updateOutlookEvent(deps, stored, { times: input })
    expect(calls[1].body).toMatchObject({
      Start: { DateTime: '2026-10-27T10:00:00', TimeZone: 'W. Europe Standard Time' },
      End: { DateTime: '2026-10-27T06:00:00', TimeZone: 'Eastern Standard Time' }
    })
    calls = []
    await updateOutlookEvent(deps, stored, { times: input, timeZone: 'Asia/Tokyo', endTimeZone: 'Asia/Tokyo' })
    expect(calls[1].body).toMatchObject({
      Start: { DateTime: '2026-10-27T18:00:00', TimeZone: 'Tokyo Standard Time' },
      End: { DateTime: '2026-10-27T19:00:00', TimeZone: 'Tokyo Standard Time' }
    })
  })

  it('keeps an event zone that Outlook reports as an IANA name', async () => {
    // Not a Berlin zone, so falling back to the user's zone would show.
    route = (c) => (c.method === 'GET' ? served({ ChangeKey: 'k1', OriginalStartTimeZone: 'America/New_York' }) : served())
    await updateOutlookEvent(deps, stored, { times: input })
    expect(calls[1].body).toMatchObject({ Start: { DateTime: '2026-10-27T05:00:00', TimeZone: 'Eastern Standard Time' } })
  })

  it("uses the user's zone when the event's zone is unknown", async () => {
    route = (c) => (c.method === 'GET' ? served({ ChangeKey: 'k1', OriginalStartTimeZone: 'tzone://Microsoft/Custom' }) : served())
    await updateOutlookEvent(deps, stored, { times: input })
    expect(calls[1].body).toMatchObject({ Start: { DateTime: '2026-10-27T10:00:00', TimeZone: 'W. Europe Standard Time' } })
  })

  it("gives an all-day event made timed the user's zone, not Outlook's all-day UTC", async () => {
    route = (c) => (c.method === 'GET' ? served({ ChangeKey: 'k1', IsAllDay: true, OriginalStartTimeZone: 'UTC' }) : served())
    await updateOutlookEvent(deps, stored, { times: input })
    expect(calls[1].body).toMatchObject({ Start: { DateTime: '2026-10-27T10:00:00', TimeZone: 'W. Europe Standard Time' } })
  })

  it("moves a timed event the app once made in UTC to the user's zone", async () => {
    route = (c) => (c.method === 'GET' ? served({ ChangeKey: 'k1', OriginalStartTimeZone: 'UTC' }) : served())
    await updateOutlookEvent(deps, stored, { times: input })
    expect(calls[1].body).toMatchObject({ Start: { DateTime: '2026-10-27T10:00:00', TimeZone: 'W. Europe Standard Time' } })
  })

  it('refuses to edit a description that is longer than the preview we have', async () => {
    const agenda = 'Agenda: ' + 'item, '.repeat(60)
    route = () =>
      served({
        ChangeKey: 'k1',
        BodyPreview: agenda.slice(0, 255),
        Body: { Content: `<html><head><style>p {margin:0}</style></head><body><p>${agenda}</p><p>Join Teams</p></body></html>` }
      })
    await expect(updateOutlookEvent(deps, stored, { description: 'Agenda: new' })).rejects.toThrow('Edit it in Outlook')
    expect(calls.map((c) => c.method)).toEqual(['GET'])
  })

  it('edits a description that fits in the preview', async () => {
    route = () =>
      served({
        ChangeKey: 'k1',
        BodyPreview: 'Caffè: bring the slides',
        Body: { Content: '<html><head><style>p {margin:0}</style></head><body><!-- a > b --><p>Caff&egrave;: bring the\r\nslides</p></body></html>' }
      })
    await updateOutlookEvent(deps, stored, { description: 'Bring the slides and notes' })
    expect(calls[1]).toMatchObject({ method: 'PATCH', body: { Body: { ContentType: 'Text', Content: 'Bring the slides and notes' } } })
  })

  it('refuses a short description whose link target would be lost', async () => {
    route = () =>
      served({ ChangeKey: 'k1', BodyPreview: 'Join here', Body: { Content: '<body><a href="https://zoom.us/j/1">Join here</a></body>' } })
    await expect(updateOutlookEvent(deps, stored, { description: 'Join there' })).rejects.toThrow('Edit it in Outlook')
  })

  it('creates with guests as Required or Optional, and with Teams when asked', async () => {
    route = () => served()
    const guests = [{ email: 'ann@x.com', optional: false }, { email: 'bob@x.com', optional: true }]
    await createOutlookEvent(deps, 'CAL', { ...input, guests, conference: true })
    await createOutlookEvent(deps, 'CAL', input)
    expect(calls[0].body).toMatchObject({
      Attendees: [
        { EmailAddress: { Address: 'ann@x.com' }, Type: 'Required' },
        { EmailAddress: { Address: 'bob@x.com' }, Type: 'Optional' }
      ],
      IsOnlineMeeting: true,
      OnlineMeetingProvider: 'TeamsForBusiness'
    })
    expect(calls[1].body).not.toHaveProperty('Attendees')
    expect(calls[1].body).not.toHaveProperty('IsOnlineMeeting')
  })

  it("applies a guest edit to Outlook's latest list, so answers, rooms and guests added there stay", async () => {
    const latest: OutlookEvent['Attendees'] = [
      { EmailAddress: { Address: 'ann@x.com', Name: 'Ann' }, Type: 'Required', Status: { Response: 'Accepted' } },
      { EmailAddress: { Address: 'bob@x.com' }, Type: 'Optional', Status: { Response: 'None' } },
      { EmailAddress: { Address: 'room@x.com' }, Type: 'Resource', Status: { Response: 'Accepted' } },
      // Added in Outlook after the dialog opened.
      { EmailAddress: { Address: 'dan@x.com' }, Type: 'Required', Status: { Response: 'None' } }
    ]
    route = (c) => (c.method === 'GET' ? served({ ChangeKey: 'k1', Attendees: latest }) : served())
    const guests = {
      add: [{ email: 'eve@x.com', optional: false }],
      set: [{ email: 'ANN@x.com', optional: true }, { email: 'gus@x.com', optional: true }],
      remove: ['bob@x.com']
    }
    await updateOutlookEvent(deps, stored, { guests })
    expect(calls[1].body!.Attendees).toEqual([
      { ...latest[0], Type: 'Optional' },
      latest[2],
      latest[3],
      { EmailAddress: { Address: 'eve@x.com' }, Type: 'Required' }
    ])
  })

  it('removes or changes a guest Outlook stored without an address, and only that one', async () => {
    const latest: OutlookEvent['Attendees'] = [
      { EmailAddress: { Name: 'Old list' }, Type: 'Required' },
      { EmailAddress: { Address: 'ann@x.com' }, Type: 'Required' }
    ]
    route = (c) => (c.method === 'GET' ? served({ ChangeKey: 'k1', Attendees: latest }) : served())
    await updateOutlookEvent(deps, stored, { guests: { add: [], set: [], remove: [''] } })
    expect(calls[1].body!.Attendees).toEqual([latest[1]])
  })

  it('adds Teams only once, and never together with a description change', async () => {
    route = (c) => (c.method === 'GET' ? served({ ChangeKey: 'k1', IsOnlineMeeting: true }) : served())
    await updateOutlookEvent(deps, stored, { conference: true, title: 'Sync' })
    expect(calls[1].body).toEqual({ Subject: 'Sync' })
    calls = []
    await expect(updateOutlookEvent(deps, stored, { conference: true, description: 'Agenda' })).rejects.toThrow(
      'Save the description first, then add the Teams meeting.'
    )
    expect(calls).toEqual([])
  })

  it('treats an event that is already gone as deleted or declined', async () => {
    route = () => new Response('{"error":{"code":"ErrorItemNotFound"}}', { status: 404 })
    await expect(deleteOutlookEvent(deps, 'E1')).resolves.toBeUndefined()
    await expect(respondOutlookEvent(deps, 'E1', 'declined', true)).resolves.toBeUndefined()
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['DELETE events/E1', 'POST events/E1/decline'])
  })

  it('says why a change failed: the event is gone, or a series event would cross another one', async () => {
    route = () => new Response('{"error":{"code":"ErrorItemNotFound"}}', { status: 404 })
    await expect(updateOutlookEvent(deps, stored, { times: input })).rejects.toThrow('This event no longer exists.')
    route = (c) =>
      c.method === 'GET'
        ? served({ ChangeKey: 'k1' })
        : new Response('{"error":{"code":"ErrorOccurrenceCrossingBoundary"}}', { status: 400 })
    await expect(updateOutlookEvent(deps, stored, { times: input })).rejects.toThrow(
      "Outlook can't move an event of a series onto or past another event of that series."
    )
  })

  it('says a Yes or Maybe to an event that is gone does not count', async () => {
    route = () => new Response('{"error":{"code":"ErrorItemNotFound"}}', { status: 404 })
    await expect(respondOutlookEvent(deps, 'E1', 'accepted', true)).rejects.toThrow('This event no longer exists.')
  })

  it('posts each answer to its action and tells the organizer', async () => {
    route = () => new Response(null, { status: 202 })
    await respondOutlookEvent(deps, 'E1', 'accepted', true)
    await respondOutlookEvent(deps, 'E1', 'tentative', true)
    await respondOutlookEvent(deps, 'E1', 'declined', true)
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST events/E1/accept',
      'POST events/E1/tentativelyaccept',
      'POST events/E1/decline'
    ])
    expect(calls.map((c) => c.body)).toEqual(Array(3).fill({ SendResponse: true }))
  })

  it('sends no answer to the organizer when the organizer asked for none', async () => {
    route = () => new Response(null, { status: 202 })
    await respondOutlookEvent(deps, 'E1', 'accepted', false)
    expect(calls.map((c) => c.body)).toEqual([{ SendResponse: false }])
  })

  it('still fails on other errors', async () => {
    route = () => new Response('{"error":{"code":"ErrorAccessDenied"}}', { status: 403 })
    await expect(deleteOutlookEvent(deps, 'E1')).rejects.toThrow('Outlook 403 ErrorAccessDenied')
  })

  it("puts the picked category first on Outlook's latest list, and Default takes off only the colored ones (A-S2)", async () => {
    // Travel was added in Outlook after the last sync.
    route = (c) => (c.method === 'GET' ? served({ ChangeKey: 'k1', Categories: ['Travel', 'Red category', 'Blue category'] }) : served())
    await updateOutlookEvent(deps, stored, { categories: { first: 'Blue category', remove: [] } })
    expect(calls[1].body).toEqual({ Categories: ['Blue category', 'Travel', 'Red category'] })
    calls = []
    await updateOutlookEvent(deps, stored, { categories: { first: null, remove: ['Red category', 'Blue category'] } })
    expect(calls[1].body).toEqual({ Categories: ['Travel'] })
  })

  it('creates with the picked category', async () => {
    route = () => served()
    await createOutlookEvent(deps, 'CAL', input, undefined, { categories: { first: 'Red category', remove: [] } })
    expect(calls[0].body!.Categories).toEqual(['Red category'])
  })
})

describe('outlook series', () => {
  const weekly = { freq: 'weekly', interval: 1, days: [2], monthly: 'day', until: null, count: 6 } as const

  it('creates a series in the zone main sends, never UTC, with dates in that zone', async () => {
    route = () => served({ Type: 'SeriesMaster' })
    // 23:30 UTC on Mon 26 Oct is Tue 27 Oct in Berlin: the rule's start date and day are Berlin's.
    const late = { ...input, start: Date.UTC(2026, 9, 26, 23, 30), end: Date.UTC(2026, 9, 27, 0, 30) }
    await createOutlookEvent(deps, 'CAL', { ...late, timeZone: 'Europe/Berlin', endTimeZone: 'Europe/Berlin', repeat: { ...weekly, days: [2] } })
    expect(calls[0].body).toMatchObject({
      Start: { DateTime: '2026-10-27T00:30:00', TimeZone: 'W. Europe Standard Time' },
      Recurrence: {
        Pattern: { Type: 'Weekly', Interval: 1, DaysOfWeek: ['Tuesday'], FirstDayOfWeek: 'Sunday' },
        Range: { Type: 'Numbered', NumberOfOccurrences: 6, StartDate: '2026-10-27', RecurrenceTimeZone: 'W. Europe Standard Time' }
      }
    })
    // A zone Outlook does not take fails before anything is sent.
    await expect(createOutlookEvent(deps, 'CAL', { ...input, timeZone: 'UTC', endTimeZone: 'UTC', repeat: { ...weekly, days: [2] } })).rejects.toThrow(
      'Outlook does not take this time zone.'
    )
    expect(calls).toHaveLength(1)
  })
})

// The split and the new times or rule for all events are not reachable today (event-writes.ts refuses them for Outlook).
// Their tests stay, so the code is safe when it is turned on.
// A weekly series of the user's: Tue 10:00 in Berlin (09:00 UTC in winter) from 1 Dec 2026, 6 times, with one guest.
describe('outlook series writes', () => {
  const at = (date: string, time = '09:00'): number => Date.parse(`${date}T${time}:00Z`)
  const recurrence = {
    Pattern: { Type: 'Weekly', Interval: 1, DaysOfWeek: ['Tuesday'], FirstDayOfWeek: 'Sunday' },
    Range: { Type: 'Numbered', NumberOfOccurrences: 6, StartDate: '2026-12-01', RecurrenceTimeZone: 'W. Europe Standard Time' }
  }
  const Attendees = [{ EmailAddress: { Address: 'ann@x.com', Name: 'Ann' }, Type: 'Required' }]
  const master = served({
    Id: 'S1',
    ChangeKey: 'm1',
    Subject: 'Standup',
    Type: 'SeriesMaster',
    Start: { DateTime: '2026-12-01T09:00:00.0000000', TimeZone: 'UTC' },
    End: { DateTime: '2026-12-01T09:30:00.0000000', TimeZone: 'UTC' },
    Recurrence: recurrence,
    Body: { ContentType: 'HTML', Content: '<p>Agenda</p>' },
    BodyPreview: 'Agenda',
    Attendees
  })
  const instance = (date: string): OutlookEvent =>
    served({
      ...master,
      Id: `I${date.slice(-2)}`,
      ChangeKey: 'i1',
      Type: 'Occurrence',
      SeriesMasterId: 'S1',
      Recurrence: null,
      Start: { DateTime: `${date}T09:00:00.0000000`, TimeZone: 'UTC' },
      End: { DateTime: `${date}T09:30:00.0000000`, TimeZone: 'UTC' },
      OriginalStart: `${date}T09:00:00Z`
    })
  const times = (date: string, time = '09:00', end = '09:30'): EventInput => ({ ...input, start: at(date, time), end: at(date, end) })
  // Outlook as it is now: the series, its events, the new series a split made, and the answers to writes.
  const outlook = (extra: (c: Call) => unknown = () => undefined) => (c: Call): unknown => {
    const answer = extra(c)
    if (answer !== undefined) return answer
    if (c.method === 'GET' && c.path === 'events/S1') return master
    if (c.method === 'GET' && c.path === 'events/N1') return { ...master, Id: 'N1' }
    if (c.method === 'GET') return instance(`2026-12-${c.path.slice(-2)}`)
    if (c.method === 'POST') return { ...master, Id: 'N1' }
    if (c.method === 'DELETE') return new Response(null, { status: 204 })
    return master
  }
  const writes = (): string[] => calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`)
  const series = (date: string, change: EventChange, scope: 'following' | 'series' = 'series'): Promise<unknown> =>
    updateOutlookSeries(deps, 'CAL', toRecord(instance(date)), change, scope, 'tx')

  it('moves all events to a new time on the series, and sends the whole rule only when it changes', async () => {
    route = outlook()
    await series('2026-12-15', { times: times('2026-12-15', '10:00', '10:30') })
    expect(writes()).toEqual(['PATCH events/S1'])
    expect(calls.at(-1)!.body).toMatchObject({ Start: { DateTime: '2026-12-01T11:00:00', TimeZone: 'W. Europe Standard Time' } })
    expect(calls.at(-1)!.body).not.toHaveProperty('Recurrence')
    calls = []
    await series('2026-12-15', { repeat: { freq: 'weekly', interval: 1, days: [2], monthly: 'day', until: null, count: 3 } })
    expect(calls.at(-1)!.body).toEqual({ Recurrence: { ...recurrence, Range: { ...recurrence.Range, NumberOfOccurrences: 3 } } })
  })

  it("colors all events on the series' own categories, not the clicked event's", async () => {
    route = outlook((c) => (c.method === 'GET' && c.path === 'events/S1' ? { ...master, Categories: ['Work', 'Red category'] } : undefined))
    const clicked = toRecord({ ...instance('2026-12-15'), Type: 'Exception', Categories: ['Blue category'] })
    await updateOutlookSeries(deps, 'CAL', clicked, { categories: { first: 'Green category', remove: [] } }, 'series', 'tx')
    expect(writes()).toEqual(['PATCH events/S1'])
    expect(calls.at(-1)!.body).toEqual({ Categories: ['Green category', 'Work', 'Red category'] })
  })

  it('never changes all events of a series someone else organizes', async () => {
    route = outlook((c) => (c.path === 'events/S1' ? { ...master, IsOrganizer: false } : undefined))
    await expect(series('2026-12-15', { title: 'Mine now' })).rejects.toThrow('Only the organizer can change all events.')
    expect(writes()).toEqual([])
  })

  it('splits: a new series from this event with the rest of the count and the same body, then the old one ends the day before', async () => {
    route = outlook()
    await series('2026-12-15', { title: 'Standup v2' }, 'following')
    expect(writes()).toEqual(['POST calendars/CAL/events', 'PATCH events/S1'])
    const [post, cut] = calls.filter((c) => c.method !== 'GET')
    expect(post.body).toMatchObject({
      Subject: 'Standup v2',
      Body: { ContentType: 'HTML', Content: '<p>Agenda</p>' },
      Attendees,
      TransactionId: 'tx',
      Start: { DateTime: '2026-12-15T10:00:00', TimeZone: 'W. Europe Standard Time' },
      Recurrence: { Pattern: recurrence.Pattern, Range: { Type: 'Numbered', NumberOfOccurrences: 4, StartDate: '2026-12-15' } }
    })
    // Outlook needs the full Pattern with the new end.
    expect(cut.body).toEqual({ Recurrence: { Pattern: recurrence.Pattern, Range: { Type: 'EndDate', StartDate: '2026-12-01', RecurrenceTimeZone: 'W. Europe Standard Time', EndDate: '2026-12-14' } } })
  })

  it('deletes the new series again when the old one cannot end, but not after a token error', async () => {
    route = outlook((c) => (c.method === 'PATCH' ? new Response('{}', { status: 403 }) : undefined))
    await expect(series('2026-12-15', { title: 'Standup v2' }, 'following')).rejects.toThrow('Could not change this and following events.')
    expect(writes()).toEqual(['POST calendars/CAL/events', 'PATCH events/S1', 'DELETE events/N1'])
    calls = []
    route = outlook((c) => (c.method === 'PATCH' ? new Response('{}', { status: 401 }) : undefined))
    await expect(series('2026-12-15', { title: 'Standup v2' }, 'following')).rejects.toThrow(OutlookAuthError)
    expect(writes()).toEqual(['POST calendars/CAL/events', 'PATCH events/S1'])
  })

  it('never ends the old series when the new one is not a live series, or when the create had no clear answer', async () => {
    route = outlook((c) => (c.path === 'events/N1' ? new Response('{}', { status: 404 }) : undefined))
    await expect(series('2026-12-15', { title: 'Standup v2' }, 'following')).rejects.toThrow('This split was undone before.')
    route = outlook((c) => (c.method === 'POST' ? new Response('{}', { status: 500 }) : undefined))
    await expect(series('2026-12-15', { title: 'Standup v2' }, 'following')).rejects.toThrow('Some events may show twice: Standup v2 from')
    expect(writes()).toEqual(['POST calendars/CAL/events', 'POST calendars/CAL/events'])
  })

  it('says events may show twice when the new series cannot be read after a good create (S-S1)', async () => {
    route = outlook((c) => (c.method === 'GET' && c.path === 'events/N1' ? new Response('{}', { status: 500 }) : undefined))
    await expect(series('2026-12-15', { title: 'Standup v2' }, 'following')).rejects.toThrow('Some events may show twice: Standup v2 from')
    expect(writes()).toEqual(['POST calendars/CAL/events'])
  })

  it('reads the old series when the cut got no answer: a cut that happened stays, an unknown one leaves both (S-M1)', async () => {
    const ended = { ...recurrence, Range: { Type: 'EndDate', StartDate: '2026-12-01', RecurrenceTimeZone: 'W. Europe Standard Time', EndDate: '2026-12-14' } }
    // The cut PATCH reaches Outlook, but its answer is lost; then the series reads as read() gives it.
    const lost = (read: () => unknown): ((c: Call) => unknown) => {
      let sent = false
      return outlook((c) => {
        if (c.method === 'PATCH') {
          sent = true
          throw new TypeError('fetch failed')
        }
        return sent && c.method === 'GET' && c.path === 'events/S1' ? read() : undefined
      })
    }
    route = lost(() => ({ ...master, Recurrence: ended }))
    const done = await series('2026-12-15', { title: 'Standup v2' }, 'following').catch((e: Error) => e)
    // No rollback: the cut was made.
    expect(writes()).toEqual(['POST calendars/CAL/events', 'PATCH events/S1'])
    expect(done).not.toBeInstanceOf(Error)
    calls = []
    route = lost(() => new Response('{}', { status: 500 }))
    await expect(series('2026-12-15', { title: 'Standup v2' }, 'following')).rejects.toThrow('Some events may show twice: Standup v2 from')
    expect(writes()).toEqual(['POST calendars/CAL/events', 'PATCH events/S1'])
    // The series has its old rule: the cut was not made, so the new series goes again.
    calls = []
    route = lost(() => master)
    await expect(series('2026-12-15', { title: 'Standup v2' }, 'following')).rejects.toThrow('Could not change this and following events.')
    expect(writes()).toEqual(['POST calendars/CAL/events', 'PATCH events/S1', 'DELETE events/N1'])
    // A rule someone else wrote: the cut may have been made, so both stay.
    calls = []
    route = lost(() => ({ ...master, Recurrence: { ...ended, Range: { ...ended.Range, EndDate: '2026-12-20' } } }))
    await expect(series('2026-12-15', { title: 'Standup v2' }, 'following')).rejects.toThrow('Some events may show twice: Standup v2 from')
    expect(writes()).toEqual(['POST calendars/CAL/events', 'PATCH events/S1'])
  })

  it('deletes all events, or this and following by ending the series the day before, never from the first event', async () => {
    route = outlook()
    await deleteOutlookSeries(deps, toRecord(instance('2026-12-15')), 'series')
    expect(writes()).toEqual(['DELETE events/S1'])
    calls = []
    await deleteOutlookSeries(deps, toRecord(instance('2026-12-15')), 'following')
    expect(writes()).toEqual(['PATCH events/S1'])
    expect(calls.at(-1)!.body).toMatchObject({ Recurrence: { Range: { Type: 'EndDate', EndDate: '2026-12-14' } } })
    await expect(deleteOutlookSeries(deps, toRecord(instance('2026-12-01')), 'following')).rejects.toThrow('The series was changed somewhere else.')
    expect(writes()).toEqual(['PATCH events/S1'])
  })
})
