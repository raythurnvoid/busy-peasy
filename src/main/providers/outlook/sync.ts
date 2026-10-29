import { listCalendarSyncStates, saveCategories, saveCursor, syncCalendarList, type CalendarSyncState } from '../../db/accounts'
import { tx, type Db } from '../../db/db'
import { deleteEvents, deleteSeriesInstancesExcept, sweepEvents, upsertEvents, type EventRecord } from '../../db/events'
import { localWrites, skipCommit } from '../../sync/local-writes'
import { OUTLOOK_BASE, OutlookHttpError, outlookRequest, type OutlookDeps } from './client'
import { isRemoved, removedId, toRecord, type OutlookEvent } from './map'

export interface OutlookSyncDeps extends OutlookDeps {
  db: Db
  now(): number
}

interface Page<T> {
  value: T[]
  '@odata.nextLink'?: string
  '@odata.deltaLink'?: string
}

interface OutlookCalendar {
  Id: string
  Name: string
  HexColor?: string
  CanEdit?: boolean
  IsDefaultCalendar?: boolean
  AllowedOnlineMeetingProviders?: string[]
}

const DAY = 86_400_000
const WINDOW_PAST = 60 * DAY
const WINDOW_FUTURE = 365 * DAY
// A weekly full sync moves the window forward and removes anything the delta missed.
const REBASELINE = 7 * DAY
const MAX_ROUNDS = 10
const DELTA_PREFER = 'odata.track-changes, odata.maxpagesize=50, outlook.timezone="UTC"'
// Outlook calendars are "Auto" colored, so we pick from Google's palette.
const COLORS = ['#3F51B5', '#33B679', '#8E24AA', '#F4511E', '#039BE5', '#E4C441', '#616161', '#D81B60']

export async function syncOutlookAccount(deps: OutlookSyncDeps, accountId: number): Promise<void> {
  // Every page: a calendar missing from the list is deleted here, with its events and own reminders.
  const calendars: OutlookCalendar[] = []
  let next: string | undefined = OUTLOOK_BASE + 'calendars'
  while (next) {
    const page: Page<OutlookCalendar> = await outlookRequest<Page<OutlookCalendar>>(deps, next)
    calendars.push(...page.value)
    next = page['@odata.nextLink']
  }
  syncCalendarList(
    deps.db,
    accountId,
    calendars.map((c, i) => ({
      remoteId: c.Id,
      name: c.Name,
      color: c.HexColor || COLORS[i % COLORS.length],
      canEdit: c.CanEdit === true,
      isPrimary: c.IsDefaultCalendar === true,
      // Outlook's usual default. Only shown when creating an event; Outlook applies the mailbox's own setting.
      defaultReminders: [15],
      conference: c.AllowedOnlineMeetingProviders?.includes('TeamsForBusiness') ? 'teams' : null
    }))
  )
  // Category colors live on the mailbox. An undocumented beta path, so any failure keeps the last colors and never
  // fails the sync. A 401 here is not passed on: it would renew the token and run the sync again each time.
  try {
    const master = await outlookRequest<Page<{ DisplayName: string; Color: string }>>(
      deps,
      OUTLOOK_BASE + 'MasterCategories'
    )
    saveCategories(
      deps.db,
      accountId,
      Object.fromEntries(master.value.map((c) => [c.DisplayName, c.Color]))
    )
  } catch (error) {
    console.warn('Outlook categories not read:', error)
  }
  for (const calendar of listCalendarSyncStates(deps.db, accountId)) await syncCalendar(deps, calendar)
}

async function syncCalendar(deps: OutlookSyncDeps, calendar: CalendarSyncState): Promise<void> {
  const due = calendar.lastFullSync === null || deps.now() - calendar.lastFullSync > REBASELINE
  if (!calendar.cursor || due) return runSync(deps, calendar, true)
  try {
    await runSync(deps, calendar, false)
  } catch (error) {
    // The delta token expired or is no longer valid on the server.
    if (!(error instanceof OutlookHttpError) || (error.status !== 410 && error.code !== 'SyncStateNotFound')) throw error
    await runSync(deps, calendar, true)
  }
}

async function runSync(deps: OutlookSyncDeps, calendar: CalendarSyncState, full: boolean): Promise<void> {
  // Before the first request: a local write after this may be newer than what we read.
  const writesAtStart = localWrites(calendar.id)
  const now = deps.now()
  const today = Math.floor(now / DAY) * DAY
  const windowStart = full ? today - WINDOW_PAST : calendar.windowStart!
  const windowEnd = full ? today + WINDOW_FUTURE : calendar.windowEnd!
  const generation = full ? calendar.generation + 1 : calendar.generation
  const window = `startDateTime=${new Date(windowStart).toISOString()}&endDateTime=${new Date(windowEnd).toISOString()}`
  const url = full
    ? `${OUTLOOK_BASE}calendars/${encodeURIComponent(calendar.remoteId)}/calendarview?${window}`
    : calendar.cursor!
  const { items, deltaLink } = await drain(deps, url)

  // Later entries win: an event can be created and deleted between two syncs.
  const latest = new Map<string, EventRecord | null>()
  const series = new Set<string>()
  for (const item of items) {
    if (isRemoved(item)) {
      latest.set(removedId(item), null)
      continue
    }
    const event = item as OutlookEvent
    // Occurrences in a delta have only ids and times. Any change to a series is refetched in full below.
    if (event.Type === 'Occurrence' || event.Type === 'Exception') {
      if (event.SeriesMasterId) series.add(event.SeriesMasterId)
      continue
    }
    if (event.Type === 'SeriesMaster') series.add(event.Id)
    latest.set(event.Id, toRecord(event))
  }

  // Deleting one occurrence gives no removal entry, only the master again. So replace the whole series.
  const instances = new Map<string, EventRecord[]>()
  for (const id of series) {
    if (latest.get(id) === null) continue
    try {
      instances.set(id, await fetchInstances(deps, id, window))
    } catch (error) {
      if (!(error instanceof OutlookHttpError) || error.status !== 404) throw error
      latest.set(id, null)
    }
  }

  if (skipCommit(calendar.id, writesAtStart)) return
  tx(deps.db, () => {
    const db = deps.db
    upsertEvents(db, calendar.id, [...latest.values()].filter((r) => r !== null), generation)
    for (const [id, records] of instances) {
      upsertEvents(db, calendar.id, records, generation)
      deleteSeriesInstancesExcept(db, calendar.id, id, records.map((r) => r.remoteId))
    }
    deleteEvents(db, calendar.id, [...latest].filter(([, r]) => r === null).map(([id]) => id))
    if (full) sweepEvents(db, calendar.id, generation)
    saveCursor(db, calendar.id, {
      cursor: deltaLink,
      windowStart,
      windowEnd,
      lastFullSync: full ? now : calendar.lastFullSync,
      generation
    })
  })
}

// A delta comes in rounds: follow nextLink pages, then the deltaLink, until a round has no items.
async function drain(deps: OutlookSyncDeps, url: string): Promise<{ items: object[]; deltaLink: string }> {
  const items: object[] = []
  let deltaLink = url
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let next: string | undefined = deltaLink
    let count = 0
    while (next) {
      const page: Page<object> = await outlookRequest<Page<object>>(deps, next, { prefer: DELTA_PREFER })
      items.push(...page.value)
      count += page.value.length
      next = page['@odata.nextLink']
      if (!next) {
        if (!page['@odata.deltaLink']) throw new Error('Outlook delta page has no deltaLink')
        deltaLink = page['@odata.deltaLink']
      }
    }
    if (count === 0) break
  }
  return { items, deltaLink }
}

async function fetchInstances(deps: OutlookSyncDeps, seriesId: string, window: string): Promise<EventRecord[]> {
  const records: EventRecord[] = []
  let next: string | undefined = `${OUTLOOK_BASE}events/${encodeURIComponent(seriesId)}/instances?${window}`
  while (next) {
    const page: Page<OutlookEvent> = await outlookRequest<Page<OutlookEvent>>(deps, next)
    records.push(...page.value.map((e) => toRecord(e, deps.getToken()?.upn)))
    next = page['@odata.nextLink']
  }
  return records
}
