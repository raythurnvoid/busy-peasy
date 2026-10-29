import { listCalendarSyncStates, saveCursor, saveLabels, syncCalendarList, type CalendarSyncState } from '../../db/accounts'
import { tx, type Db } from '../../db/db'
import { deleteEvents, sweepEvents, upsertEvents, type EventRecord } from '../../db/events'
import { localWrites, skipCommit } from '../../sync/local-writes'
import { GOOGLE_BASE, GoogleHttpError, googleRequest, type GoogleDeps } from './client'
import { popups, toRecord, type GoogleEvent } from './map'

export interface GoogleSyncDeps extends GoogleDeps {
  db: Db
  now(): number
}

interface GoogleCalendar {
  id: string
  summary?: string
  summaryOverride?: string
  backgroundColor?: string
  accessRole?: string
  primary?: boolean
  deleted?: boolean
  defaultReminders?: { method?: string; minutes?: number }[]
  conferenceProperties?: { allowedConferenceSolutionTypes?: string[] }
  timeZone?: string
}

interface GoogleLabels {
  labelProperties?: { eventLabels?: { id: string; name?: string; backgroundColor?: string }[] }
}

interface ListPage<T> {
  items?: T[]
  nextPageToken?: string
  nextSyncToken?: string
}

const DAY = 86_400_000
const WINDOW_PAST = 60 * DAY
const WINDOW_FUTURE = 365 * DAY
// A weekly full sync moves the window forward.
const REBASELINE = 7 * DAY

export async function syncGoogleAccount(deps: GoogleSyncDeps, accountId: number): Promise<void> {
  const calendars: GoogleCalendar[] = []
  let pageToken: string | undefined
  do {
    const query = new URLSearchParams({ maxResults: '250', ...(pageToken && { pageToken }) })
    const page = await googleRequest<ListPage<GoogleCalendar>>(deps, `${GOOGLE_BASE}users/me/calendarList?${query}`)
    calendars.push(...(page.items ?? []))
    pageToken = page.nextPageToken
  } while (pageToken)

  const live = calendars.filter((c) => !c.deleted)
  syncCalendarList(
    deps.db,
    accountId,
    live.map((c) => ({
      remoteId: c.id,
      name: c.summaryOverride ?? c.summary ?? c.id,
      color: c.backgroundColor ?? '#039BE5',
      canEdit: c.accessRole === 'owner' || c.accessRole === 'writer',
      isPrimary: c.primary === true,
      defaultReminders: popups(c.defaultReminders),
      conference: c.conferenceProperties?.allowedConferenceSolutionTypes?.includes('hangoutsMeet') ? 'meet' : null,
      timeZone: c.timeZone
    }))
  )
  for (const calendar of listCalendarSyncStates(deps.db, accountId)) {
    // Labels are Google's event colors, only needed where the user can pick one. A sign-in from before the labels scope
    // gets 403 insufficientPermissions: the classic colors then. Other errors keep the last labels; a token or network
    // error fails the events read next anyway.
    if (calendar.canEdit) {
      try {
        const url = `${GOOGLE_BASE}calendars/${encodeURIComponent(calendar.remoteId)}?fields=labelProperties`
        const labels = (await googleRequest<GoogleLabels>(deps, url)).labelProperties?.eventLabels ?? []
        // The color goes into CSS and textOn, so only #rrggbb. A label with no id would fail the insert, and so every sync.
        const valid = labels.filter((l) => typeof l.id === 'string' && /^#[0-9a-f]{6}$/i.test(l.backgroundColor ?? ''))
        saveLabels(deps.db, calendar.id, valid.map((l) => ({ id: l.id, name: l.name ?? '', color: l.backgroundColor! })))
      } catch (error) {
        if (!(error instanceof GoogleHttpError)) throw error
        if (error.status === 403 && error.reason === 'insufficientPermissions') saveLabels(deps.db, calendar.id, null)
      }
    }
    await syncCalendar(deps, calendar)
  }
}

async function syncCalendar(deps: GoogleSyncDeps, calendar: CalendarSyncState): Promise<void> {
  const due = calendar.lastFullSync === null || deps.now() - calendar.lastFullSync > REBASELINE
  if (!calendar.cursor || due) return runSync(deps, calendar, true)
  try {
    await runSync(deps, calendar, false)
  } catch (error) {
    // 410: the sync token expired, so a full sync is required.
    if (!(error instanceof GoogleHttpError) || error.status !== 410) throw error
    await runSync(deps, calendar, true)
  }
}

async function runSync(deps: GoogleSyncDeps, calendar: CalendarSyncState, full: boolean): Promise<void> {
  // Before the first request: a local write after this may be newer than what we read.
  const writesAtStart = localWrites(calendar.id)
  const now = deps.now()
  const today = Math.floor(now / DAY) * DAY
  const windowStart = full ? today - WINDOW_PAST : calendar.windowStart!
  const windowEnd = full ? today + WINDOW_FUTURE : calendar.windowEnd!
  const generation = full ? calendar.generation + 1 : calendar.generation
  // A sync token cannot be combined with timeMin/timeMax, so incremental results can fall outside the window.
  const base: Record<string, string> = full
    ? { timeMin: new Date(windowStart).toISOString(), timeMax: new Date(windowEnd).toISOString() }
    : { syncToken: calendar.cursor! }

  const latest = new Map<string, EventRecord | null>()
  let pageToken: string | undefined
  let syncToken: string | undefined
  do {
    const query = new URLSearchParams({ singleEvents: 'true', maxResults: '2500', ...base, ...(pageToken && { pageToken }) })
    const page = await googleRequest<ListPage<GoogleEvent>>(
      deps,
      `${GOOGLE_BASE}calendars/${encodeURIComponent(calendar.remoteId)}/events?${query}`
    )
    for (const event of page.items ?? []) {
      // Cancelled entries only promise an id. Deleting a series id also deletes its instances.
      const record = event.status === 'cancelled' ? null : toRecord(event)
      latest.set(event.id, record && record.end > windowStart && record.start < windowEnd ? record : null)
    }
    pageToken = page.nextPageToken
    syncToken = page.nextSyncToken
  } while (pageToken)
  if (!syncToken) throw new Error('Google events list has no sync token')

  if (skipCommit(calendar.id, writesAtStart)) return
  tx(deps.db, () => {
    upsertEvents(deps.db, calendar.id, [...latest.values()].filter((r) => r !== null), generation)
    deleteEvents(deps.db, calendar.id, [...latest].filter(([, r]) => r === null).map(([id]) => id))
    if (full) sweepEvents(deps.db, calendar.id, generation)
    saveCursor(deps.db, calendar.id, {
      cursor: syncToken,
      windowStart,
      windowEnd,
      lastFullSync: full ? now : calendar.lastFullSync,
      generation
    })
  })
}
