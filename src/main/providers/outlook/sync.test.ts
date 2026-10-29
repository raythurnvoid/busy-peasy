import { beforeEach, describe, expect, it } from 'vitest'
import { getCalendarSyncState, listCalendars, upsertAccount } from '../../db/accounts'
import { openDb, type Db } from '../../db/db'
import { deleteEvents, listEventsInRange, upsertEvents } from '../../db/events'
import { noteLocalWrite } from '../../sync/local-writes'
import { OUTLOOK_BASE } from './client'
import { toRecord, type OutlookEvent } from './map'
import { syncOutlookAccount, type OutlookSyncDeps } from './sync'

const NOW = Date.UTC(2026, 9, 26, 12)
const H = 3600_000
const WEEK = { start: Date.UTC(2026, 9, 26), end: Date.UTC(2026, 10, 2) }
const CAL = 'calendars/cal1/calendarview'

const at = (day: number, hour: number): { DateTime: string; TimeZone: string } => ({
  DateTime: new Date(Date.UTC(2026, 9, day, hour)).toISOString().slice(0, 19) + '.0000000',
  TimeZone: 'UTC'
})

const single: OutlookEvent = { Id: 's1', Type: 'SingleInstance', Subject: 'Lunch', Start: at(27, 12), End: at(27, 13) }
const master: OutlookEvent = { Id: 'm1', Type: 'SeriesMaster', Subject: 'Standup', Start: at(26, 9), End: at(26, 10) }
const sparse = { Id: 'o1', Type: 'Occurrence', SeriesMasterId: 'm1', Start: at(26, 9), End: at(26, 10) }
const occ = (id: string, day: number): OutlookEvent => ({
  Id: id,
  Type: 'Occurrence',
  SeriesMasterId: 'm1',
  Subject: 'Standup',
  Start: at(day, 9),
  End: at(day, 10)
})
const removed = (id: string): object => ({ '@odata.context': 'x/$deletedEntity', id: `CalendarView('${id}')`, reason: 'deleted' })
const page = (value: object[], delta: string): object => ({ value, '@odata.deltaLink': OUTLOOK_BASE + `${CAL}?$deltatoken=${delta}` })

let db: Db
let account: number
let calls: string[]
let route: (path: string) => unknown

function deps(): OutlookSyncDeps {
  return {
    db,
    now: () => NOW,
    sleep: async () => {},
    getToken: () => ({ raw: 't', anchor: 'a', exp: Infinity, upn: 'me@x.com', tid: 't' }),
    fetch: (async (url: string) => {
      const path = url.slice(OUTLOOK_BASE.length)
      calls.push(path)
      const body = route(path)
      if (body instanceof Response) return body
      if (body === undefined) return new Response('{"error":{"code":"ErrorItemNotFound"}}', { status: 404 })
      return new Response(JSON.stringify(body))
    }) as typeof fetch
  }
}

const titles = (): string[] => listEventsInRange(db, WEEK).map((e) => `${e.title}@${new Date(e.start).getUTCDate()}`)

// First sync: one single event and a series with two occurrences, delivered in two pages and two rounds.
async function initialSync(): Promise<void> {
  route = (path) => {
    if (path === 'calendars') return { value: [{ Id: 'cal1', Name: 'Calendar', IsDefaultCalendar: true, CanEdit: true }] }
    if (path.startsWith(`${CAL}?startDateTime`))
      return { value: [single], '@odata.nextLink': OUTLOOK_BASE + `${CAL}?$skiptoken=p2` }
    if (path === `${CAL}?$skiptoken=p2`) return page([master, sparse], 'd1')
    if (path === `${CAL}?$deltatoken=d1`) return page([], 'd2')
    if (path.startsWith('events/m1/instances?')) return { value: [occ('o1', 26), occ('o2', 27)] }
    return undefined
  }
  await syncOutlookAccount(deps(), account)
}

beforeEach(async () => {
  db = openDb(':memory:')
  account = upsertAccount(db, 'outlook', 'me@x.com', null, NOW)
  calls = []
  await initialSync()
})

describe('syncOutlookAccount', () => {
  it('stores events from all pages and rounds, with series occurrences in full', () => {
    expect(titles()).toEqual(['Standup@26', 'Standup@27', 'Lunch@27'])
    const cal = getCalendarSyncState(db, 1)!
    expect(cal.cursor).toBe(OUTLOOK_BASE + `${CAL}?$deltatoken=d2`)
    expect(cal.lastFullSync).toBe(NOW)
  })

  it('makes only 2 requests when nothing changed', async () => {
    route = (path) =>
      path === 'calendars' ? { value: [{ Id: 'cal1', Name: 'Calendar' }] } : path === `${CAL}?$deltatoken=d2` ? page([], 'd2') : undefined
    calls = []
    await syncOutlookAccount(deps(), account)
    expect(calls).toEqual(['calendars', 'MasterCategories', `${CAL}?$deltatoken=d2`])
  })

  it('stores Teams as the video call of calendars that allow it', async () => {
    expect(listCalendars(db)[0].conference).toBeNull()
    const teams = { Id: 'cal1', Name: 'Calendar', AllowedOnlineMeetingProviders: ['TeamsForBusiness'] }
    route = (path) => (path === 'calendars' ? { value: [teams] } : path === `${CAL}?$deltatoken=d2` ? page([], 'd2') : undefined)
    await syncOutlookAccount(deps(), account)
    expect(listCalendars(db)[0].conference).toBe('teams')
  })

  it('reads every page of the calendar list', async () => {
    route = (path) => {
      if (path === 'calendars')
        return {
          value: [{ Id: 'cal1', Name: 'Calendar' }],
          '@odata.nextLink': OUTLOOK_BASE + 'calendars?$skip=1'
        }
      if (path === 'calendars?$skip=1') return { value: [{ Id: 'cal2', Name: 'Birthdays' }] }
      if (path === `${CAL}?$deltatoken=d2`) return page([], 'd2')
      if (path.startsWith('calendars/cal2/calendarview?')) return page([], 'c2')
      return undefined
    }
    await syncOutlookAccount(deps(), account)
    expect(listCalendars(db).map((c) => c.name)).toEqual(['Birthdays', 'Calendar'])
    expect(titles()).toEqual(['Standup@26', 'Standup@27', 'Lunch@27'])
  })

  it('saves the category colors, and keeps the last ones when that request fails in any way', async () => {
    // Each run brings one new event, so a run that committed shows in the list.
    const syncWith = async (categories: unknown, id: string): Promise<void> => {
      const cursor = getCalendarSyncState(db, 1)!.cursor!.slice(OUTLOOK_BASE.length)
      route = (path) => {
        if (path === 'calendars') return { value: [{ Id: 'cal1', Name: 'Calendar' }] }
        if (path === 'MasterCategories') return categories
        if (path === cursor) return page([{ ...single, Id: id, Subject: id }], id)
        if (path === `${CAL}?$deltatoken=${id}`) return page([], id)
        return undefined
      }
      await syncOutlookAccount(deps(), account)
    }
    const saved = (): string | null => (db.prepare('SELECT categories FROM accounts').get() as { categories: string | null }).categories
    await syncWith({ value: [{ DisplayName: 'Red category', Color: 'Preset0' }] }, 'a')
    expect(saved()).toBe('{"Red category":"Preset0"}')
    // A 401 here must not fail the sync (that would renew the token and sync again, every time).
    await syncWith(new Response('', { status: 403 }), 'b')
    await syncWith(new Response('', { status: 401 }), 'c')
    await syncWith({}, 'd')
    expect(saved()).toBe('{"Red category":"Preset0"}')
    expect(titles()).toEqual(expect.arrayContaining(['a@27', 'b@27', 'c@27', 'd@27']))
  })

  it('deletes a single event and a whole series from wrapped removal ids', async () => {
    route = (path) => {
      if (path === 'calendars') return { value: [{ Id: 'cal1', Name: 'Calendar' }] }
      if (path === `${CAL}?$deltatoken=d2`) return page([removed('s1'), removed('m1')], 'd3')
      if (path === `${CAL}?$deltatoken=d3`) return page([], 'd3')
      return undefined
    }
    await syncOutlookAccount(deps(), account)
    expect(titles()).toEqual([])
  })

  it('drops an occurrence deleted on its own (Outlook only re-sends the master)', async () => {
    route = (path) => {
      if (path === 'calendars') return { value: [{ Id: 'cal1', Name: 'Calendar' }] }
      if (path === `${CAL}?$deltatoken=d2`) return page([master], 'd3')
      if (path === `${CAL}?$deltatoken=d3`) return page([], 'd3')
      if (path.startsWith('events/m1/instances?')) return { value: [occ('o1', 26)] }
      return undefined
    }
    await syncOutlookAccount(deps(), account)
    expect(titles()).toEqual(['Standup@26', 'Lunch@27'])
  })

  it("stores the user's own answer for each event of a series", async () => {
    // Outlook says Maybe on every event after a Maybe on o1 alone; only o1's own row says so.
    const answered = (id: string, day: number, own: string): OutlookEvent => ({
      ...occ(id, day),
      ResponseStatus: { Response: 'TentativelyAccepted' },
      Attendees: [{ EmailAddress: { Address: 'me@x.com' }, Status: { Response: own } }]
    })
    route = (path) => {
      if (path === 'calendars') return { value: [{ Id: 'cal1', Name: 'Calendar' }] }
      if (path === `${CAL}?$deltatoken=d2`) return page([master], 'd3')
      if (path === `${CAL}?$deltatoken=d3`) return page([], 'd3')
      if (path.startsWith('events/m1/instances?')) return { value: [answered('o1', 26, 'TentativelyAccepted'), answered('o2', 27, 'None')] }
      return undefined
    }
    await syncOutlookAccount(deps(), account)
    const standups = listEventsInRange(db, WEEK).filter((e) => e.title === 'Standup')
    expect(standups.map((e) => e.response)).toEqual(['tentative', 'none'])
  })

  it('runs a full sync and sweeps old rows when the delta token is gone', async () => {
    route = (path) => {
      if (path === 'calendars') return { value: [{ Id: 'cal1', Name: 'Calendar' }] }
      if (path === `${CAL}?$deltatoken=d2`)
        return new Response('{"error":{"code":"SyncStateNotFound"}}', { status: 410 })
      if (path.startsWith(`${CAL}?startDateTime`)) return page([single], 'f1')
      if (path === `${CAL}?$deltatoken=f1`) return page([], 'f2')
      return undefined
    }
    await syncOutlookAccount(deps(), account)
    expect(titles()).toEqual(['Lunch@27'])
    expect(getCalendarSyncState(db, 1)!.cursor).toBe(OUTLOOK_BASE + `${CAL}?$deltatoken=f2`)
  })

  it('keeps local ids when an event changes', async () => {
    const before = listEventsInRange(db, WEEK).find((e) => e.title === 'Lunch')!
    route = (path) => {
      if (path === 'calendars') return { value: [{ Id: 'cal1', Name: 'Calendar' }] }
      if (path === `${CAL}?$deltatoken=d2`) return page([{ ...single, Subject: 'Long lunch', End: at(27, 14) }], 'd3')
      if (path === `${CAL}?$deltatoken=d3`) return page([], 'd3')
      return undefined
    }
    await syncOutlookAccount(deps(), account)
    const after = listEventsInRange(db, WEEK).find((e) => e.title === 'Long lunch')!
    expect(after.id).toBe(before.id)
    expect(after.end - after.start).toBe(2 * H)
  })
})

// The write runs inside the fake request: after the sync started reading, before it commits.
describe('syncOutlookAccount during a local write', () => {
  it('keeps an occurrence deleted during a series refetch deleted', async () => {
    route = (path) => {
      if (path === 'calendars') return { value: [{ Id: 'cal1', Name: 'Calendar' }] }
      if (path === `${CAL}?$deltatoken=d2`) return page([master], 'd3')
      if (path === `${CAL}?$deltatoken=d3`) return page([], 'd3')
      if (path.startsWith('events/m1/instances?')) {
        noteLocalWrite(1)
        deleteEvents(db, 1, ['o2'])
        return { value: [occ('o1', 26), occ('o2', 27)] }
      }
      return undefined
    }
    await syncOutlookAccount(deps(), account)
    expect(titles()).toEqual(['Standup@26', 'Lunch@27'])
  })

  it('keeps an event created during a full sync', async () => {
    db.prepare('UPDATE calendars SET last_full_sync = NULL').run()
    const created = { ...single, Id: 'n1', Subject: 'New', Start: at(28, 9), End: at(28, 10) }
    route = (path) => {
      if (path === 'calendars') return { value: [{ Id: 'cal1', Name: 'Calendar' }] }
      if (path.startsWith(`${CAL}?startDateTime`)) {
        // What event-writes.ts store() does.
        noteLocalWrite(1)
        upsertEvents(db, 1, [toRecord(created)], getCalendarSyncState(db, 1)!.generation)
        return page([single], 'f1')
      }
      if (path === `${CAL}?$deltatoken=f1`) return page([], 'f2')
      return undefined
    }
    await syncOutlookAccount(deps(), account)
    expect(titles()).toContain('New@28')
    expect(getCalendarSyncState(db, 1)!.cursor).toBe(OUTLOOK_BASE + `${CAL}?$deltatoken=d2`)
  })
})
