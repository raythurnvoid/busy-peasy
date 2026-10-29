import { clipboard, nativeTheme } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Api, Settings } from '../shared/api'
import { createApi } from './api'
import { saveCategories, saveLabels, syncCalendarList, upsertAccount } from './db/accounts'
import { openDb, type Db } from './db/db'
import { getEventByRemoteId, upsertEvents } from './db/events'
import { getSettings } from './db/settings'
import { createEvent, deleteEvent, respondEvent, updateEvent } from './event-writes'
import { notifyDataChanged } from './ipc'
import { toRecord } from './providers/google/map'
import type { ReminderScheduler } from './reminders'

vi.mock('electron', () => ({ nativeTheme: { themeSource: 'system' }, clipboard: { writeText: vi.fn() } }))
vi.mock('./ipc', () => ({ notifyDataChanged: vi.fn() }))
// These modules need a running Electron when they load. Only the event writes are used, as mocks.
vi.mock('./google-session', () => ({}))
vi.mock('./outlook-session', () => ({}))
vi.mock('./event-writes', () => ({
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
  respondEvent: vi.fn()
}))
vi.mock('./security', () => ({}))

let db: Db
let api: Api
let defaults: Settings
let syncNow: () => Promise<void>
let check: () => void
let onAccountRemoved: () => void
let showEvent: () => void
let scheduler: ReminderScheduler

beforeEach(() => {
  db = openDb(':memory:')
  syncNow = vi.fn(async () => {})
  check = vi.fn()
  onAccountRemoved = vi.fn()
  showEvent = vi.fn()
  scheduler = { check, list: vi.fn(), answer: vi.fn(), dismiss: vi.fn() }
  api = createApi(db, { syncNow, syncAccount: vi.fn(async () => {}) }, scheduler, onAccountRemoved, showEvent)
  defaults = getSettings(db)
  nativeTheme.themeSource = 'system'
  vi.mocked(notifyDataChanged).mockClear()
})

describe('listEvents', () => {
  const DAY = 24 * 3600_000

  it('reads the whole sync window at once, also across the autumn clock change', async () => {
    // Schedule from today to the end of the synced dates: 425 local days, one of them 25 h long.
    const start = Date.UTC(2026, 9, 24, 22)
    await expect(api.listEvents({ start, end: start + 425 * DAY + 3600_000 })).resolves.toEqual([])
    await expect(api.listEvents({ start, end: start + 431 * DAY })).rejects.toThrow('Invalid arguments')
  })
})

describe('removeAccount', () => {
  it('tells the tray, which no sync tells when every account left is signed out', async () => {
    const id = upsertAccount(db, 'outlook', 'me@work.com', null, 0)
    await api.removeAccount(id)
    expect(onAccountRemoved).toHaveBeenCalledOnce()
  })
})

describe('searchEvents', () => {
  it.each([
    ['a blank text', '   '],
    ['a text that is not a string', 5],
    ['more than 200 characters', 'a'.repeat(201)]
  ])('rejects %s', async (_, text) => {
    await expect(api.searchEvents(text as never)).rejects.toThrow('Invalid arguments')
  })

  it('searches the local DB', async () => {
    const account = upsertAccount(db, 'google', 'me@gmail.com', null, 0)
    syncCalendarList(db, account, [{ remoteId: 'me@gmail.com', name: 'Me', color: '#000', canEdit: true, isPrimary: true, defaultReminders: [], conference: null }])
    const start = { dateTime: '2026-10-27T09:00:00Z' }
    const end = { dateTime: '2026-10-27T10:00:00Z' }
    upsertEvents(db, 1, [toRecord({ id: 'e1', summary: 'Focus time', start, end })], 0)
    const found = await api.searchEvents('focus')
    expect(found.events.map((e) => e.title)).toEqual(['Focus time'])
    expect(found.more).toBe(false)
  })
})

describe('saveSettings', () => {
  it('stores only known keys and applies the theme', async () => {
    const settings: Settings = {
      ...defaults,
      hour12: false,
      weekStart: 0,
      showWeekends: false,
      eventMinutes: 30,
      showDeclined: false,
      theme: 'dark',
      secondaryTimeZone: 'Asia/Tokyo',
      secondaryTimeZoneLabel: 'TYO',
      // On the same day at 09:00: all-day only.
      allDayReminders: [{ minutes: -540, alarm: true }]
    }
    await api.saveSettings({ ...settings, extra: 'x' } as Settings)
    expect(getSettings(db)).toEqual(settings)
    expect(nativeTheme.themeSource).toBe('dark')
    expect(notifyDataChanged).toHaveBeenCalledWith(expect.objectContaining({ settings: true }))
  })

  it.each([
    ['an unknown theme', { theme: 'blue' }],
    ['no duration', { eventMinutes: 0 }],
    ['a day that does not exist', { weekStart: 7 }],
    ['a clock that is not a boolean', { hour12: 'yes' }],
    ['weekends that are not a boolean', { showWeekends: 1 }],
    // Valid for a calendar, but the dialog does not offer them.
    ['a week start the dialog does not offer', { weekStart: 3 }],
    ['a duration the dialog does not offer', { eventMinutes: 25 }],
    ['a bad reminder list', { meetingReminders: [{ minutes: -1, alarm: true }] }],
    ['a same-day reminder for timed events', { eventReminders: [{ minutes: -540, alarm: false }] }],
    ['an all-day reminder after the first day', { allDayReminders: [{ minutes: -1440, alarm: false }] }],
    ['a zone that does not exist', { secondaryTimeZone: 'Mars/Base' }],
    ['a zone Intl takes but the picker does not list', { secondaryTimeZone: '+01:00' }],
    ['a zone label over 20 characters', { secondaryTimeZoneLabel: 'x'.repeat(21) }],
    ['a zone label that is not a string', { secondaryTimeZoneLabel: null }]
  ])('rejects %s and stores nothing', async (_, bad) => {
    await expect(api.saveSettings({ ...defaults, ...bad } as never)).rejects.toThrow('Invalid arguments')
    expect(getSettings(db)).toEqual(defaults)
  })

  it('rejects a partial object', async () => {
    await expect(api.saveSettings({ theme: 'dark' } as never)).rejects.toThrow('Invalid arguments')
    expect(getSettings(db)).toEqual(defaults)
  })
})

describe('copyText', () => {
  it('copies a string of at most 2000 characters', async () => {
    await expect(api.copyText(5 as never)).rejects.toThrow('Invalid arguments')
    await expect(api.copyText('x'.repeat(2001))).rejects.toThrow('Invalid arguments')
    await api.copyText('https://meet.google.com/abc-defg-hij')
    expect(vi.mocked(clipboard.writeText).mock.calls).toEqual([['https://meet.google.com/abc-defg-hij']])
  })
})

describe('showEvent', () => {
  it('passes the stored event on, or null when it is gone, so the window still opens', async () => {
    await expect(api.showEvent('1' as never)).rejects.toThrow('Invalid arguments')
    const account = upsertAccount(db, 'outlook', 'me@work.com', null, 0)
    syncCalendarList(db, account, [{ remoteId: 'cal', name: 'Me', color: '#000', canEdit: true, isPrimary: true, defaultReminders: [], conference: null }])
    const start = { dateTime: '2026-10-27T09:00:00Z' }
    const end = { dateTime: '2026-10-27T10:00:00Z' }
    upsertEvents(db, 1, [toRecord({ id: 'e1', summary: 'Focus', start, end })], 0)
    const id = getEventByRemoteId(db, 1, 'e1')!.id
    await api.showEvent(id)
    await api.showEvent(id + 1)
    expect(vi.mocked(showEvent).mock.calls).toEqual([[expect.objectContaining({ id, title: 'Focus' })], [null]])
  })
})

describe('reminder answers', () => {
  it('takes a snooze time only from the choices and only with snooze', async () => {
    await expect(api.answerReminder(1, 'snooze', 0, 7)).rejects.toThrow('Invalid arguments')
    await expect(api.answerReminder(1, 'dismiss', 0, 10)).rejects.toThrow('Invalid arguments')
    await api.answerReminder(1, 'snooze', 0, 10)
    await api.answerReminder(1, 'dismiss', 0)
    expect(vi.mocked(scheduler.answer).mock.calls).toEqual([
      [1, 'snooze', 0, 10],
      [1, 'dismiss', 0, undefined]
    ])
  })

  it('dismisses all with one call, with clean copies of at most 100 reminders', async () => {
    const many = Array.from({ length: 101 }, (_, i) => ({ eventId: i, fireAt: 0 }))
    await expect(api.dismissReminders(many)).rejects.toThrow('Invalid arguments')
    await expect(api.dismissReminders([{ eventId: 1.5, fireAt: 0 }])).rejects.toThrow('Invalid arguments')
    await api.dismissReminders([{ eventId: 1, fireAt: 2, extra: 3 } as never, { eventId: 4, fireAt: 5 }])
    expect(vi.mocked(scheduler.dismiss).mock.calls).toEqual([
      [
        [
          { eventId: 1, fireAt: 2 },
          { eventId: 4, fireAt: 5 }
        ]
      ]
    ])
  })
})

describe('event writes', () => {
  // A write counted before an error (e.g. a conflict stores the server's version) makes a running sync skip,
  // so another sync must follow.
  it('queues a sync also when a create, update or delete fails', async () => {
    const account = upsertAccount(db, 'google', 'me@gmail.com', null, 0)
    const calendar = { remoteId: 'me@gmail.com', name: 'Me', color: '#000', canEdit: true }
    syncCalendarList(db, account, [{ ...calendar, isPrimary: true, defaultReminders: [], conference: null }])
    const start = { dateTime: '2026-10-27T09:00:00Z' }
    const end = { dateTime: '2026-10-27T10:00:00Z' }
    const record = toRecord({ id: 'e1', summary: 'Focus', start, end })
    upsertEvents(db, 1, [record], 0)
    const id = getEventByRemoteId(db, 1, 'e1')!.id
    for (const write of [createEvent, updateEvent, deleteEvent]) {
      vi.mocked(write).mockRejectedValue(new Error('Failed'))
    }
    const input = { calendarId: 1, title: 'x', start: record.start, end: record.end, allDay: false, startDate: null, endDate: null, location: '', description: '' }
    await expect(api.createEvent(input)).rejects.toThrow('Failed')
    await expect(api.updateEvent(id, { title: 'x' })).rejects.toThrow('Failed')
    await expect(api.deleteEvent(id)).rejects.toThrow('Failed')
    expect(syncNow).toHaveBeenCalledTimes(3)
  })

  it('refuses to edit a meeting the organizer canceled', async () => {
    const account = upsertAccount(db, 'outlook', 'me@work.com', null, 0)
    syncCalendarList(db, account, [{ remoteId: 'cal', name: 'Me', color: '#000', canEdit: true, isPrimary: true, defaultReminders: [], conference: null }])
    const start = { dateTime: '2026-10-27T09:00:00Z' }
    const end = { dateTime: '2026-10-27T10:00:00Z' }
    upsertEvents(db, 1, [{ ...toRecord({ id: 'e1', summary: 'Focus', start, end }), cancelled: true }], 0)
    vi.mocked(updateEvent).mockClear()
    await expect(api.updateEvent(getEventByRemoteId(db, 1, 'e1')!.id, { title: 'x' })).rejects.toThrow('This event was canceled.')
    expect(updateEvent).not.toHaveBeenCalled()
  })

  // A Google event at 09:00 UTC. A meeting someone else organizes when attendees are given.
  function stored(
    extra: {
      attendees?: { email: string; organizer?: boolean }[]
      guestsCanModify?: boolean
      organizer?: { self?: boolean; email?: string }
      description?: string
      hangoutLink?: string
      recurringEventId?: string
      colorId?: string
      eventLabelId?: string
    } = {}
  ): number {
    const account = upsertAccount(db, 'google', 'me@gmail.com', null, 0)
    syncCalendarList(db, account, [{ remoteId: 'me@gmail.com', name: 'Me', color: '#000', canEdit: true, isPrimary: true, defaultReminders: [], conference: null }])
    const start = { dateTime: '2026-10-27T09:00:00Z' }
    const end = { dateTime: '2026-10-27T10:00:00Z' }
    upsertEvents(db, 1, [toRecord({ id: 'e1', summary: 'Plan', start, end, organizer: {}, ...extra })], 0)
    return getEventByRemoteId(db, 1, 'e1')!.id
  }
  const later = { start: Date.UTC(2026, 9, 27, 10), end: Date.UTC(2026, 9, 27, 11) }

  it('checks notify and passes it on with any change, but never alone', async () => {
    const id = stored()
    vi.mocked(updateEvent).mockClear().mockResolvedValue({} as never)
    await expect(api.updateEvent(id, later, { notify: 'yes' as never })).rejects.toThrow('Invalid arguments')
    await api.updateEvent(id, later, { notify: false })
    await api.updateEvent(id, { title: 'x' }, { notify: false })
    await api.updateEvent(id, { reminders: [{ minutes: 5, alarm: false }] }, { notify: false })
    expect(vi.mocked(updateEvent).mock.calls.map((c) => c[2].notify)).toEqual([false, false, undefined])
  })

  // The dialog sends the description as it showed it. Google's HTML (links, bold) is lost only when the user changed it.
  it('sends a description that came as HTML only when the user changed its text', async () => {
    const id = stored({ description: '<b>Agenda</b><br><a href="https://x.com/a">Doc</a>' })
    vi.mocked(updateEvent)
      .mockClear()
      .mockResolvedValue({} as never)
    await api.updateEvent(id, { title: 'x', description: 'Agenda\nDoc' })
    await api.updateEvent(id, { description: 'Agenda\nDocs' })
    expect(vi.mocked(updateEvent).mock.calls.map((c) => c[2].description)).toEqual([
      undefined,
      'Agenda\nDocs'
    ])
  })

  // A meeting the user organizes, with one guest. Google lists the organizer too.
  const own = {
    organizer: { self: true, email: 'me@gmail.com' },
    attendees: [{ email: 'me@gmail.com', organizer: true }, { email: 'ann@x.com' }]
  }
  const input = { calendarId: 1, title: 'x', ...later, allDay: false, startDate: null, endDate: null, location: '', description: '' }

  it.each([
    ['a bad email', { add: [{ email: 'ann', optional: false }], set: [], remove: [] }],
    ['more than 200 new guests', { add: Array.from({ length: 201 }, (_, i) => ({ email: `g${i}@x.com`, optional: false })), set: [], remove: [] }],
    ['the same email twice, in another case', { add: [{ email: 'bob@x.com', optional: false }], set: [], remove: ['BOB@x.com'] }],
    ['an optional flag that is not a boolean', { add: [{ email: 'bob@x.com', optional: 'yes' }], set: [], remove: [] }],
    ['a whole list instead of an edit', [{ email: 'bob@x.com', optional: false }]]
  ])('refuses a guest edit with %s', async (_, guests) => {
    const id = stored(own)
    vi.mocked(updateEvent).mockClear().mockResolvedValue({} as never)
    await expect(api.updateEvent(id, { guests } as never)).rejects.toThrow('Invalid arguments')
    expect(updateEvent).not.toHaveBeenCalled()
  })

  it('passes on only the edit the dialog made, without the user, and nothing for an empty edit', async () => {
    // cleo was added elsewhere after the dialog opened, and a sync stored her. The edit must not take her off.
    const id = stored({ ...own, attendees: [...own.attendees, { email: 'cleo@x.com' }] })
    vi.mocked(updateEvent).mockClear().mockResolvedValue({} as never)
    const add = [{ email: 'bob@x.com', optional: true }, { email: 'ME@gmail.com', optional: false }]
    await api.updateEvent(id, { guests: { add, set: [{ email: 'ann@x.com', optional: true }], remove: [] } }, { notify: false })
    await api.updateEvent(id, { guests: { add: [], set: [], remove: [] } }, { notify: false })
    expect(vi.mocked(updateEvent).mock.calls.map((c) => c[2])).toEqual([
      { guests: { add: [add[0]], set: [{ email: 'ann@x.com', optional: true }], remove: [] }, notify: false },
      {}
    ])
  })

  it('takes stored addresses that are not emails for guests already there, and never removes the user', async () => {
    const id = stored(own)
    vi.mocked(updateEvent).mockClear().mockResolvedValue({} as never)
    // Outlook stores '' for a guest without an address, and can give an X500 address.
    const set = [{ email: '/o=ExchangeLabs/cn=Recipients/cn=ann', optional: true }]
    await api.updateEvent(id, { guests: { add: [], set, remove: ['', 'ME@gmail.com'] } })
    expect(vi.mocked(updateEvent).mock.calls.map((c) => c[2])).toEqual([{ guests: { add: [], set, remove: [''] } }])
  })

  it('removes only a video call that came with the event, not a link in its description', async () => {
    const link = 'https://meet.google.com/abc-defg-hij'
    vi.mocked(updateEvent).mockClear().mockResolvedValue({} as never)
    const inText = stored({ ...own, description: `Join: ${link}` })
    await expect(api.updateEvent(inText, { conference: false })).rejects.toThrow('This video call link is in the description or location.')
    expect(updateEvent).not.toHaveBeenCalled()
    const real = stored({ ...own, hangoutLink: link })
    await api.updateEvent(real, { conference: false })
    expect(vi.mocked(updateEvent).mock.calls.map((c) => c[2])).toEqual([{ conference: false }])
  })

  it('lets only the organizer change the guests or the video call', async () => {
    const id = stored({ attendees: [{ email: 'boss@x.com', organizer: true }, { email: 'me@gmail.com' }] })
    vi.mocked(updateEvent).mockClear().mockResolvedValue({} as never)
    const guests = { add: [{ email: 'bob@x.com', optional: false }], set: [], remove: [] }
    await expect(api.updateEvent(id, { guests })).rejects.toThrow('Only the organizer can change the guests.')
    await expect(api.updateEvent(id, { conference: true })).rejects.toThrow('Only the organizer can change the guests.')
    expect(updateEvent).not.toHaveBeenCalled()
  })

  it('sends changed Google permissions, and a video call only when it changes the event', async () => {
    const id = stored(own)
    const account = upsertAccount(db, 'google', 'me@gmail.com', null, 0)
    syncCalendarList(db, account, [{ remoteId: 'me@gmail.com', name: 'Me', color: '#000', canEdit: true, isPrimary: true, defaultReminders: [], conference: 'meet' }])
    vi.mocked(updateEvent).mockClear().mockResolvedValue({} as never)
    // Stored: Google's defaults (false, true, true), and no link, so there is nothing to remove.
    await api.updateEvent(id, { guestsCanModify: true, guestsCanInviteOthers: true, conference: true })
    await api.updateEvent(id, { conference: false })
    expect(vi.mocked(updateEvent).mock.calls.map((c) => c[2])).toEqual([{ guestsCanModify: true, conference: true }, {}])
  })

  it('refuses Google permissions on Outlook, and a video call the calendar does not have', async () => {
    const account = upsertAccount(db, 'outlook', 'me@work.com', null, 0)
    syncCalendarList(db, account, [{ remoteId: 'cal', name: 'Me', color: '#000', canEdit: true, isPrimary: true, defaultReminders: [], conference: null }])
    const start = { dateTime: '2026-10-27T09:00:00Z' }
    const end = { dateTime: '2026-10-27T10:00:00Z' }
    upsertEvents(db, 1, [toRecord({ id: 'e1', summary: 'Plan', start, end, organizer: { self: true } })], 0)
    const id = getEventByRemoteId(db, 1, 'e1')!.id
    vi.mocked(updateEvent).mockClear().mockResolvedValue({} as never)
    vi.mocked(createEvent).mockClear().mockResolvedValue({} as never)
    await expect(api.updateEvent(id, { guestsCanModify: true })).rejects.toThrow('Invalid arguments')
    await expect(api.updateEvent(id, { conference: true })).rejects.toThrow('Invalid arguments')
    await expect(api.updateEvent(id, { conference: false })).rejects.toThrow('Invalid arguments')
    await expect(api.createEvent({ ...input, guestsCanSeeOtherGuests: false })).rejects.toThrow('Invalid arguments')
    await expect(api.createEvent({ ...input, conference: true })).rejects.toThrow('Invalid arguments')
    expect(updateEvent).not.toHaveBeenCalled()
    expect(createEvent).not.toHaveBeenCalled()
  })

  it('creates with clean guests, without the user, and passes notify on', async () => {
    stored()
    vi.mocked(createEvent).mockClear().mockResolvedValue({} as never)
    const twice = [{ email: 'a@x.com', optional: false }, { email: 'A@x.com', optional: true }]
    await expect(api.createEvent({ ...input, guests: twice })).rejects.toThrow('Invalid arguments')
    await expect(api.createEvent(input, 'no' as never)).rejects.toThrow('Invalid arguments')
    const guests = [{ email: 'Me@gmail.com', optional: false }, { email: 'ann@x.com', optional: true, extra: 1 } as never]
    await api.createEvent({ ...input, guests, guestsCanModify: true }, false)
    expect(vi.mocked(createEvent).mock.calls.map((c) => c.slice(1))).toEqual([
      [{ ...input, reminders: undefined, guests: [{ email: 'ann@x.com', optional: true }], guestsCanModify: true }, false, {}]
    ])
  })

  it('takes same-day reminders for all-day events only', async () => {
    stored()
    vi.mocked(createEvent).mockClear().mockResolvedValue({} as never)
    const sameDay = [{ minutes: -540, alarm: true }]
    await expect(api.createEvent({ ...input, reminders: sameDay })).rejects.toThrow('Invalid arguments')
    const allDay = { allDay: true, startDate: '2026-10-27', endDate: '2026-10-28', start: Date.UTC(2026, 9, 27), end: Date.UTC(2026, 9, 28) }
    await api.createEvent({ ...input, ...allDay, reminders: sameDay })
    expect(vi.mocked(createEvent).mock.calls.map((c) => c[1].reminders)).toEqual([sameDay])
  })

  it.each([
    ['a zone that does not exist', { timeZone: 'Mars/Base' }],
    ['a zone in lower case', { timeZone: 'europe/rome' }],
    ['an end zone alone', { endTimeZone: 'Europe/Rome' }],
    ['a zone on an all-day event', { timeZone: 'Europe/Rome', allDay: true, startDate: '2026-10-27', endDate: '2026-10-28', start: Date.UTC(2026, 9, 27), end: Date.UTC(2026, 9, 28) }]
  ])('refuses to create or change an event with %s', async (_, bad) => {
    const id = stored()
    vi.mocked(createEvent).mockClear().mockResolvedValue({} as never)
    vi.mocked(updateEvent).mockClear().mockResolvedValue({} as never)
    await expect(api.createEvent({ ...input, ...bad })).rejects.toThrow('Invalid arguments')
    await expect(api.updateEvent(id, bad)).rejects.toThrow('Invalid arguments')
    expect(createEvent).not.toHaveBeenCalled()
    expect(updateEvent).not.toHaveBeenCalled()
  })

  it('sends a picked zone with the times, also when the moment stays, and the start zone as the end zone', async () => {
    const id = stored()
    vi.mocked(createEvent).mockClear().mockResolvedValue({} as never)
    vi.mocked(updateEvent).mockClear().mockResolvedValue({} as never)
    await api.createEvent({ ...input, timeZone: 'Europe/Rome' })
    expect(vi.mocked(createEvent).mock.calls[0][1]).toMatchObject({ timeZone: 'Europe/Rome', endTimeZone: 'Europe/Rome' })
    await api.updateEvent(id, { timeZone: 'Europe/London', endTimeZone: 'America/New_York' })
    expect(vi.mocked(updateEvent).mock.calls[0][2]).toMatchObject({
      times: { start: Date.UTC(2026, 9, 27, 9), end: Date.UTC(2026, 9, 27, 10), allDay: false },
      timeZone: 'Europe/London',
      endTimeZone: 'America/New_York'
    })
  })

  // Tue 27 Oct 2026, 10:00 in Lisbon.
  const weekly = { freq: 'weekly', interval: 1, days: [2, 2], monthly: 'last', until: null, count: 6 } as const

  it('creates a series with a clean copy of its rule, and a timed one only with its zone', async () => {
    stored()
    vi.mocked(createEvent).mockClear().mockResolvedValue({} as never)
    await expect(api.createEvent({ ...input, repeat: weekly as never })).rejects.toThrow('Invalid arguments')
    await api.createEvent({ ...input, timeZone: 'Europe/Lisbon', repeat: { ...weekly, extra: 1 } as never })
    expect(vi.mocked(createEvent).mock.calls.map((c) => c[1].repeat)).toEqual([
      { freq: 'weekly', interval: 1, days: [2], monthly: 'day', until: null, count: 6 }
    ])
  })

  it.each([
    ['a rule that is not an object', 'weekly'],
    ['an unknown frequency', { freq: 'hourly' }],
    ['an interval of 0', { interval: 0 }],
    ['an interval of 100', { interval: 100 }],
    ['a day that does not exist', { days: [2, 7] }],
    ['days without the start day', { days: [3] }],
    ['731 events', { count: 731 }],
    ['an end before the start', { count: null, until: '2026-10-26' }],
    ['both ends', { until: '2026-12-01' }],
    ['a last weekday that is not the last one', { freq: 'monthly', start: Date.UTC(2026, 9, 20, 10) }]
  ])('refuses a series with %s', async (_, bad) => {
    stored()
    vi.mocked(createEvent).mockClear().mockResolvedValue({} as never)
    const { start, ...rule } = typeof bad === 'object' ? (bad as { start?: number }) : { start: undefined }
    const repeat = typeof bad === 'object' ? { ...weekly, days: [2], ...rule } : bad
    const times = start ? { start, end: start + 3600_000 } : {}
    await expect(api.createEvent({ ...input, ...times, timeZone: 'Europe/Lisbon', repeat: repeat as never })).rejects.toThrow('Invalid arguments')
    expect(createEvent).not.toHaveBeenCalled()
  })

  const invite = [{ email: 'boss@x.com', organizer: true }, { email: 'me@gmail.com' }]

  it.each([
    ['an event that does not repeat', {}, { title: 'x' }, 'series'],
    ['an invite', { recurringEventId: 's1', attendees: invite }, { title: 'x' }, 'series'],
    ['an unknown scope', { recurringEventId: 's1' }, { title: 'x' }, 'all'],
    ['a new rule for this event only', { recurringEventId: 's1' }, { repeat: weekly }, 'event'],
    ['"Does not repeat"', { recurringEventId: 's1' }, { repeat: null }, 'series'],
    ['reminders alone for this and following', { recurringEventId: 's1' }, { reminders: [{ minutes: 5, alarm: false }] }, 'following'],
    ['a color alone for this and following (A-S1)', { recurringEventId: 's1' }, { colorKey: '11' }, 'following']
  ])('refuses a series change for %s', async (_, extra, patch, scope) => {
    const id = stored(extra)
    vi.mocked(updateEvent).mockClear()
    await expect(api.updateEvent(id, patch as never, { scope: scope as never })).rejects.toThrow('Invalid arguments')
    expect(updateEvent).not.toHaveBeenCalled()
  })

  it('passes the scope and a clean rule on, then waits for the sync of the account and reads the event again', async () => {
    const id = stored({ recurringEventId: 's1' })
    // The sync brings the series as the provider has it now.
    const syncAccount = vi.fn(async () => void db.prepare('UPDATE events SET title = ? WHERE id = ?').run('Synced', id))
    api = createApi(db, { syncNow, syncAccount }, { check, list: vi.fn(), answer: vi.fn(), dismiss: vi.fn() }, onAccountRemoved, showEvent)
    vi.mocked(updateEvent).mockClear().mockResolvedValue(null)
    await expect(api.updateEvent(id, { repeat: { ...weekly, extra: 1 } as never }, { scope: 'following' })).resolves.toMatchObject({ title: 'Synced' })
    expect(syncAccount).toHaveBeenCalledWith(1)
    expect(vi.mocked(updateEvent).mock.calls[0].slice(2)).toEqual([
      { repeat: { freq: 'weekly', interval: 1, days: [2], monthly: 'day', until: null, count: 6 } },
      undefined,
      'following'
    ])
  })

  it("deletes all events, or this and following, only of the user's own series", async () => {
    vi.mocked(deleteEvent).mockClear().mockResolvedValue()
    await expect(api.deleteEvent(stored(), { scope: 'series' })).rejects.toThrow('Invalid arguments')
    await expect(api.deleteEvent(stored({ recurringEventId: 's1', attendees: invite }), { scope: 'series' })).rejects.toThrow('Invalid arguments')
    const id = stored({ recurringEventId: 's1' })
    await api.deleteEvent(id, { scope: 'following' })
    expect(deleteEvent).toHaveBeenCalledWith(db, id, undefined, 'following')
    expect(deleteEvent).toHaveBeenCalledTimes(1)
  })

  it('lets only the organizer change the zone', async () => {
    const id = stored({ attendees: [{ email: 'boss@x.com', organizer: true }, { email: 'me@gmail.com' }] })
    vi.mocked(updateEvent).mockClear()
    await expect(api.updateEvent(id, { timeZone: 'Europe/Rome' })).rejects.toThrow('Only the organizer can change the time.')
    expect(updateEvent).not.toHaveBeenCalled()
  })

  it('checks notify on delete and passes it on', async () => {
    const id = stored(own)
    vi.mocked(deleteEvent).mockClear().mockResolvedValue()
    await expect(api.deleteEvent(id, { notify: 'no' as never })).rejects.toThrow('Invalid arguments')
    await api.deleteEvent(id, { notify: false })
    expect(deleteEvent).toHaveBeenCalledWith(db, id, false, 'event')
  })

  it('lets only the organizer change the time, unless Google lets guests change it', async () => {
    const attendees = [{ email: 'boss@x.com', organizer: true }, { email: 'me@gmail.com' }]
    const id = stored({ attendees })
    vi.mocked(updateEvent).mockClear().mockResolvedValue({} as never)
    await expect(api.updateEvent(id, later)).rejects.toThrow('Only the organizer can change the time.')
    expect(updateEvent).not.toHaveBeenCalled()
    stored({ attendees, guestsCanModify: true })
    await api.updateEvent(id, later)
    expect(updateEvent).toHaveBeenCalledTimes(1)
  })

  it("maps a picked Google color to a classic id or a label, Default takes both off, and only the calendar's colors pass", async () => {
    vi.mocked(updateEvent).mockClear().mockResolvedValue({} as never)
    vi.mocked(createEvent).mockClear().mockResolvedValue({} as never)
    // No labels read (the old sign-in): the 11 classic colors.
    await api.updateEvent(stored(), { colorKey: '11' })
    await api.updateEvent(stored({ colorId: '11' }), { colorKey: null })
    await api.updateEvent(stored({ colorId: '11' }), { colorKey: '11' })
    await expect(api.updateEvent(stored(), { colorKey: '12' })).rejects.toThrow('Invalid arguments')
    await expect(api.updateEvent(stored(), { colorKey: 'cobalt' })).rejects.toThrow('Invalid arguments')
    saveLabels(db, 1, [{ id: 'cobalt', name: 'Cobalt', color: '#4285F4' }])
    await api.updateEvent(stored({ eventLabelId: 'tomato', colorId: '11' }), { colorKey: 'cobalt' })
    await api.updateEvent(stored({ eventLabelId: 'cobalt' }), { colorKey: null })
    await expect(api.updateEvent(stored(), { colorKey: '11' })).rejects.toThrow('Invalid arguments')
    expect(vi.mocked(updateEvent).mock.calls.map((c) => c[2])).toEqual([
      { colorId: '11' },
      { colorId: null },
      {},
      { label: 'cobalt' },
      { label: '', colorId: null }
    ])
    await api.createEvent({ ...input, colorKey: 'cobalt' })
    expect(vi.mocked(createEvent).mock.calls.map((c) => c[3])).toEqual([{ label: 'cobalt' }])
  })

  it('always sends the Google color fields for the series scopes, as the stored series is not kept up to date (F2)', async () => {
    vi.mocked(updateEvent).mockClear().mockResolvedValue({} as never)
    // No color stored: Default and a classic color still go out for the series scopes.
    const id = stored({ recurringEventId: 's1' })
    await api.updateEvent(id, { colorKey: null }, { scope: 'series' })
    await api.updateEvent(id, { title: 'Plan v2', colorKey: null }, { scope: 'following' })
    await api.updateEvent(id, { colorKey: '5' }, { scope: 'series' })
    await api.updateEvent(id, { colorKey: null })
    // The stored event already has the label: still sent for the series, nothing for this event only.
    saveLabels(db, 1, [{ id: 'cobalt', name: '', color: '#4285F4' }])
    stored({ recurringEventId: 's1', eventLabelId: 'cobalt' })
    await api.updateEvent(id, { colorKey: 'cobalt' }, { scope: 'series' })
    await api.updateEvent(id, { colorKey: 'cobalt' })
    expect(vi.mocked(updateEvent).mock.calls.map((c) => [c[2], c[4]])).toEqual([
      [{ label: '', colorId: null }, 'series'],
      [{ title: 'Plan v2', label: '', colorId: null }, 'following'],
      [{ label: '', colorId: '5' }, 'series'],
      [{}, 'event'],
      [{ label: 'cobalt' }, 'series'],
      [{}, 'event']
    ])
  })

  it('puts a picked Outlook category first, Default takes off the colored ones, and only on the main calendar (A-S3)', async () => {
    const account = upsertAccount(db, 'outlook', 'me@work.com', null, 0)
    const calendar = { name: 'Me', color: '#000', canEdit: true, defaultReminders: [], conference: null }
    syncCalendarList(db, account, [{ ...calendar, remoteId: 'main', isPrimary: true }, { ...calendar, remoteId: 'team', isPrimary: false }])
    saveCategories(db, account, { 'Red category': 'Preset0', Plain: 'None', 'Blue category': 'Preset7' })
    const start = { dateTime: '2026-10-27T09:00:00Z' }
    const end = { dateTime: '2026-10-27T10:00:00Z' }
    upsertEvents(db, 1, [toRecord({ id: 'e1', summary: 'Plan', start, end, organizer: { self: true } })], 0)
    upsertEvents(db, 2, [toRecord({ id: 'e2', summary: 'Plan', start, end, organizer: { self: true } })], 0)
    vi.mocked(updateEvent).mockClear().mockResolvedValue({} as never)
    vi.mocked(createEvent).mockClear().mockResolvedValue({} as never)
    const main = getEventByRemoteId(db, 1, 'e1')!.id
    await api.updateEvent(main, { colorKey: 'Blue category' })
    await api.updateEvent(main, { colorKey: null })
    await expect(api.updateEvent(main, { colorKey: 'Plain' })).rejects.toThrow('Invalid arguments')
    await expect(api.updateEvent(getEventByRemoteId(db, 2, 'e2')!.id, { colorKey: 'Red category' })).rejects.toThrow('Invalid arguments')
    await expect(api.createEvent({ ...input, calendarId: 2, colorKey: 'Red category' })).rejects.toThrow('Invalid arguments')
    expect(vi.mocked(updateEvent).mock.calls.map((c) => c[2])).toEqual([
      { categories: { first: 'Blue category', remove: [] } },
      { categories: { first: null, remove: ['Red category', 'Blue category'] } }
    ])
    await api.createEvent({ ...input, colorKey: 'Red category' })
    expect(vi.mocked(createEvent).mock.calls.map((c) => c[3])).toEqual([{ categories: { first: 'Red category', remove: [] } }])
  })

  it('says an event that a sync removed no longer exists, for an Undo that comes late', async () => {
    await expect(api.updateEvent(999, later)).rejects.toThrow('This event no longer exists.')
  })
})

describe('respondEvent', () => {
  // A meeting someone else organizes, in the main Google calendar. recurringEventId: one event of a series.
  function invite(extra: { recurringEventId?: string; organizer?: { self?: boolean }; status?: 'cancelled' } = {}): number {
    const account = upsertAccount(db, 'google', 'me@gmail.com', null, 0)
    syncCalendarList(db, account, [{ remoteId: 'me@gmail.com', name: 'Me', color: '#000', canEdit: true, isPrimary: true, defaultReminders: [], conference: null }])
    const start = { dateTime: '2026-10-27T09:00:00Z' }
    const end = { dateTime: '2026-10-27T10:00:00Z' }
    const attendees = [{ email: 'boss@x.com', organizer: true }, { email: 'me@gmail.com', self: true }]
    upsertEvents(db, 1, [toRecord({ id: 'e1', summary: 'Plan', start, end, attendees, organizer: {}, ...extra })], 0)
    return getEventByRemoteId(db, 1, 'e1')!.id
  }

  it.each([
    ['an unknown answer', {}, 'maybe', 'event'],
    ['an answer that is not a string', {}, ['accepted'], 'event'],
    ['an unknown scope', { recurringEventId: 'e0' }, 'accepted', 'following'],
    ['all events of an event that does not repeat', {}, 'accepted', 'series'],
    ['an event the user organizes', { organizer: { self: true } }, 'accepted', 'event']
  ])('refuses %s', async (_, extra, answer, scope) => {
    const id = invite(extra)
    // Resolves, so a missing check shows as a call, not as a crash.
    vi.mocked(respondEvent).mockClear().mockResolvedValue()
    await expect(api.respondEvent(id, answer as never, scope as never)).rejects.toThrow('Invalid arguments')
    expect(respondEvent).not.toHaveBeenCalled()
  })

  it('takes all events of a repeating invite', async () => {
    const id = invite({ recurringEventId: 'e0' })
    vi.mocked(respondEvent).mockResolvedValue()
    await api.respondEvent(id, 'tentative', 'series')
    expect(respondEvent).toHaveBeenCalledWith(db, id, 'tentative', 'series')
  })

  it('says an event that is gone no longer exists', async () => {
    vi.mocked(respondEvent).mockClear()
    await expect(api.respondEvent(404, 'declined', 'event')).rejects.toThrow('This event no longer exists.')
    expect(respondEvent).not.toHaveBeenCalled()
  })

  it('refuses a meeting the organizer canceled, and says why', async () => {
    const id = invite({ status: 'cancelled' })
    vi.mocked(respondEvent).mockClear()
    await expect(api.respondEvent(id, 'accepted', 'event')).rejects.toThrow('This event was canceled.')
    expect(respondEvent).not.toHaveBeenCalled()
  })

  it('queues a sync and checks reminders after an answer, and syncs also when it fails', async () => {
    const id = invite()
    vi.mocked(respondEvent).mockResolvedValue()
    await api.respondEvent(id, 'declined', 'event')
    expect(syncNow).toHaveBeenCalledTimes(1)
    expect(check).toHaveBeenCalledTimes(1)
    vi.mocked(respondEvent).mockRejectedValue(new Error('Failed'))
    await expect(api.respondEvent(id, 'declined', 'event')).rejects.toThrow('Failed')
    expect(syncNow).toHaveBeenCalledTimes(2)
  })
})
