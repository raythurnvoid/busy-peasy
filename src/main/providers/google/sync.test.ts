import { beforeEach, describe, expect, it } from 'vitest'
import { getCalendarSyncState, listCalendars, upsertAccount } from '../../db/accounts'
import { openDb, type Db } from '../../db/db'
import { deleteEvents, listEventsInRange, upsertEvents } from '../../db/events'
import { noteLocalWrite } from '../../sync/local-writes'
import { GOOGLE_BASE } from './client'
import { toRecord, type GoogleEvent } from './map'
import { syncGoogleAccount, type GoogleSyncDeps } from './sync'

const NOW = Date.UTC(2026, 9, 26, 12)
const WEEK = { start: Date.UTC(2026, 9, 26), end: Date.UTC(2026, 10, 2) }
const EVENTS = 'calendars/me%40gmail.com/events'

const ev = (id: string, day: number, extra: Partial<GoogleEvent> = {}): GoogleEvent => ({
  id,
  summary: id,
  start: { dateTime: new Date(Date.UTC(2026, 9, day, 9)).toISOString() },
  end: { dateTime: new Date(Date.UTC(2026, 9, day, 10)).toISOString() },
  ...extra
})
const calendarList = {
  items: [
    { id: 'me@gmail.com', summary: 'Me', backgroundColor: '#9fe1e7', accessRole: 'owner', primary: true },
    { id: 'gone@group', summary: 'Old', deleted: true }
  ]
}

let db: Db
let account: number
let calls: string[]
let route: (path: string, query: URLSearchParams) => unknown

function deps(): GoogleSyncDeps {
  return {
    db,
    now: () => NOW,
    sleep: async () => {},
    getAccessToken: async () => 'token',
    fetch: (async (url: string) => {
      const u = new URL(url)
      const path = u.pathname.slice(new URL(GOOGLE_BASE).pathname.length)
      calls.push(path + (u.searchParams.has('syncToken') ? '?syncToken=' + u.searchParams.get('syncToken') : ''))
      const body = route(path, u.searchParams)
      if (body instanceof Response) return body
      return new Response(JSON.stringify(body))
    }) as typeof fetch
  }
}

const titles = (): string[] => listEventsInRange(db, WEEK).map((e) => e.title)

beforeEach(async () => {
  db = openDb(':memory:')
  account = upsertAccount(db, 'google', 'me@gmail.com', null, NOW)
  calls = []
  route = (path, q) => {
    if (path === 'users/me/calendarList') return calendarList
    if (path === EVENTS && q.get('timeMin') && !q.get('pageToken')) return { items: [ev('a', 27)], nextPageToken: 'p2' }
    if (path === EVENTS && q.get('pageToken') === 'p2')
      return { items: [ev('b_1', 28, { recurringEventId: 'b' }), ev('b_2', 29, { recurringEventId: 'b' })], nextSyncToken: 's1' }
    return new Response('{}', { status: 500 })
  }
  await syncGoogleAccount(deps(), account)
})

describe('syncGoogleAccount', () => {
  it('stores calendars and all pages of events, skipping deleted calendars', () => {
    expect(listCalendars(db).map((c) => c.name)).toEqual(['Me'])
    expect(titles()).toEqual(['a', 'b_1', 'b_2'])
    expect(getCalendarSyncState(db, 1)!.cursor).toBe('s1')
  })

  it('stores Google Meet as the video call of calendars that allow it', async () => {
    expect(listCalendars(db)[0].conference).toBeNull()
    const meet = { ...calendarList.items[0], conferenceProperties: { allowedConferenceSolutionTypes: ['hangoutsMeet'] } }
    route = (path) => (path === 'users/me/calendarList' ? { items: [meet] } : { items: [], nextSyncToken: 's1' })
    await syncGoogleAccount(deps(), account)
    expect(listCalendars(db)[0].conference).toBe('meet')
  })

  it('makes only 3 requests when nothing changed', async () => {
    route = (path) => (path === 'users/me/calendarList' ? calendarList : { items: [], nextSyncToken: 's1' })
    calls = []
    await syncGoogleAccount(deps(), account)
    expect(calls).toEqual(['users/me/calendarList', 'calendars/me%40gmail.com', `${EVENTS}?syncToken=s1`])
  })

  describe('labels', () => {
    const LABELS = 'calendars/me%40gmail.com'
    const labels = {
      labelProperties: {
        eventLabels: [
          { id: 'ocean', name: 'Ocean', backgroundColor: '#2266AA' },
          { id: 'odd', name: 'Odd', backgroundColor: 'red; x' },
          { id: 'fire', name: 'Fire', backgroundColor: '#CC0011' },
          { id: 'mine', backgroundColor: '#123456' },
          { name: 'No id', backgroundColor: '#654321' },
          { id: 'mine2', name: '', backgroundColor: '#ABCDEF' }
        ]
      }
    }
    const answer = (labelsBody: unknown) => (path: string) =>
      path === 'users/me/calendarList' ? calendarList : path === LABELS ? labelsBody : { items: [ev('a', 27)], nextSyncToken: 's2' }

    it("saves an owner calendar's labels in Google's order, without colors CSS cannot take or an id", async () => {
      route = answer(labels)
      await syncGoogleAccount(deps(), account)
      const [me] = listCalendars(db)
      expect(me.labelsRead).toBe(true)
      expect(me.colors.map((c) => c.name)).toEqual(['Ocean', 'Fire', 'Custom color 1', 'Custom color 2'])
    })

    it('keeps the last labels and still stores events and the cursor when the sign-in has no labels scope', async () => {
      route = answer(labels)
      await syncGoogleAccount(deps(), account)
      route = answer(new Response('{"error":{"errors":[{"reason":"insufficientPermissions"}]}}', { status: 403 }))
      await expect(syncGoogleAccount(deps(), account)).resolves.toBeUndefined()
      const [me] = listCalendars(db)
      expect(me.labelsRead).toBe(false)
      expect(me.colors.map((c) => c.key)).toEqual(['ocean', 'fire', 'mine', 'mine2'])
      expect(titles()).toEqual(['a', 'b_1', 'b_2'])
      expect(getCalendarSyncState(db, 1)!.cursor).toBe('s2')
    })

    it('does not ask for the labels of a calendar the user can only read', async () => {
      const holidays = { id: 'holidays@group', summary: 'Holidays', accessRole: 'reader' }
      route = (path) => (path === 'users/me/calendarList' ? { items: [...calendarList.items, holidays] } : path === LABELS ? labels : { items: [], nextSyncToken: 's2' })
      calls = []
      await syncGoogleAccount(deps(), account)
      expect(calls.filter((c) => !c.includes('/events'))).toEqual(['users/me/calendarList', LABELS])
    })
  })

  it('deletes cancelled events and whole series, and drops events moved out of the window', async () => {
    route = (path) =>
      path === 'users/me/calendarList'
        ? calendarList
        : {
            items: [
              { id: 'b', status: 'cancelled' },
              ev('a', 27, { start: { dateTime: '2028-01-01T09:00:00Z' }, end: { dateTime: '2028-01-01T10:00:00Z' } })
            ],
            nextSyncToken: 's2'
          }
    await syncGoogleAccount(deps(), account)
    expect(titles()).toEqual([])
  })

  it('runs a full sync when the sync token expired (410)', async () => {
    route = (path, q) => {
      if (path === 'users/me/calendarList') return calendarList
      if (q.get('syncToken')) return new Response('{"error":{"errors":[{"reason":"fullSyncRequired"}]}}', { status: 410 })
      return { items: [ev('c', 30)], nextSyncToken: 'f1' }
    }
    await syncGoogleAccount(deps(), account)
    expect(titles()).toEqual(['c'])
    expect(getCalendarSyncState(db, 1)!.cursor).toBe('f1')
  })
})

// The write runs inside the fake request: after the sync started reading, before it commits.
describe('syncGoogleAccount during a local write', () => {
  // What event-writes.ts store() does.
  function localStore(event: GoogleEvent): void {
    noteLocalWrite(1)
    upsertEvents(db, 1, [toRecord(event)], getCalendarSyncState(db, 1)!.generation)
  }
  const idOf = (title: string): number | undefined =>
    listEventsInRange(db, WEEK).find((e) => e.title === title)?.id

  it('keeps an event created during a full sync, with its local id', async () => {
    db.prepare('UPDATE calendars SET last_full_sync = NULL').run()
    let id: number | undefined
    route = (path) => {
      if (path === 'users/me/calendarList') return calendarList
      localStore(ev('n', 28))
      id = idOf('n')
      return { items: [ev('a', 27)], nextSyncToken: 'f1' }
    }
    await syncGoogleAccount(deps(), account)
    expect(titles()).toContain('n')
    expect(getCalendarSyncState(db, 1)!.cursor).toBe('s1')

    route = (path) =>
      path === 'users/me/calendarList'
        ? calendarList
        : { items: [ev('a', 27), ev('n', 28)], nextSyncToken: 'f2' }
    await syncGoogleAccount(deps(), account)
    expect(titles()).toEqual(['a', 'n'])
    expect(idOf('n')).toBe(id)
  })

  it('does not write old data over an edit made during the sync', async () => {
    route = (path) => {
      if (path === 'users/me/calendarList') return calendarList
      localStore(ev('a', 27, { summary: 'a edited' }))
      return { items: [ev('a', 27)], nextSyncToken: 's2' }
    }
    await syncGoogleAccount(deps(), account)
    expect(titles()).toEqual(['a edited', 'b_1', 'b_2'])
  })

  it('does not bring back an event deleted during the sync', async () => {
    route = (path) => {
      if (path === 'users/me/calendarList') return calendarList
      noteLocalWrite(1)
      deleteEvents(db, 1, ['a'])
      return { items: [ev('a', 27)], nextSyncToken: 's2' }
    }
    await syncGoogleAccount(deps(), account)
    expect(titles()).not.toContain('a')
  })

  it('commits after 3 skips in a row', async () => {
    route = (path) => {
      if (path === 'users/me/calendarList') return calendarList
      noteLocalWrite(1)
      return { items: [], nextSyncToken: 's9' }
    }
    const cursors: (string | null)[] = []
    for (let run = 0; run < 4; run++) {
      await syncGoogleAccount(deps(), account)
      cursors.push(getCalendarSyncState(db, 1)!.cursor)
    }
    expect(cursors).toEqual(['s1', 's1', 's1', 's9'])
  })

  it('commits a calendar when only another calendar got a write', async () => {
    const team = { id: 'team@group', summary: 'Team', accessRole: 'owner' }
    route = (path) => {
      if (path === 'users/me/calendarList') return { items: [...calendarList.items, team] }
      // Calendar 2 is the team calendar; it gets a write while each calendar reads.
      noteLocalWrite(2)
      return { items: [], nextSyncToken: path === EVENTS ? 's2' : 't1' }
    }
    await syncGoogleAccount(deps(), account)
    expect(getCalendarSyncState(db, 1)!.cursor).toBe('s2')
    expect(getCalendarSyncState(db, 2)!.cursor).toBeNull()
  })
})
