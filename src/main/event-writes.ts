import type { Answer, CalendarEvent, EventInput, EventReminder, Scope, Series } from '../shared/api'
import { isInvite } from '../shared/events'
import { mergeReminders } from '../shared/reminders'
import { fromPattern, type OutlookRecurrence } from '../shared/repeat'
import { getAccount, getCalendarAccount, getCalendarSyncState, type CalendarSyncState } from './db/accounts'
import type { Db } from './db/db'
import {
  deleteEvents,
  deleteSeriesInstancesFrom,
  getEvent,
  getEventByRemoteId,
  getRecord,
  listSeriesExceptions,
  upsertEvents,
  type EventRecord
} from './db/events'
import { copyEventReminders, deleteInstanceReminders, saveEventReminders } from './db/reminders'
import { withGoogle } from './google-session'
import { withOutlook } from './outlook-session'
import {
  createGoogleEvent,
  deleteGoogleEvent,
  deleteGoogleSeries,
  getGoogleSeries,
  respondGoogleEvent,
  updateGoogleEvent,
  updateGoogleSeries
} from './providers/google/write'
import {
  createOutlookEvent,
  deleteOutlookEvent,
  deleteOutlookSeries,
  outlookSeriesZone,
  respondOutlookEvent,
  updateOutlookEvent,
  updateOutlookSeries
} from './providers/outlook/write'
import { ConflictError, splitId, type EventChange } from './providers/write'
import { noteLocalWrite } from './sync/local-writes'

// Writes go to the provider first. Only what the provider answers is stored, so the DB never shows
// a change that did not happen. The next sync fills in anything the answer lacks.
// Exceptions: Outlook timed writes store the times we sent (see answer() in providers/outlook/write.ts), and Outlook
// answers to invites store the answer we sent, since Outlook sends nothing back. Series writes store nothing: the sync
// brings their events, and the rows they surely end are deleted here at once. Only the Outlook events an "All events"
// color is also written to store their answers (sendSeriesChange).

// Deleted events are read up to the end of the synced dates. A calendar not synced yet: a year, like the window.
const WINDOW_MS = 366 * 86_400_000

function editableCalendar(db: Db, calendarId: number): NonNullable<ReturnType<typeof getCalendarAccount>> {
  const calendar = getCalendarAccount(db, calendarId)
  if (!calendar) throw new Error('This calendar no longer exists')
  if (!calendar.canEdit) throw new Error('You cannot change events in this calendar')
  return calendar
}

function editableEvent(db: Db, eventId: number): { calendar: ReturnType<typeof editableCalendar>; record: EventRecord } {
  const event = getEvent(db, eventId)
  if (!event) throw new Error('This event no longer exists.')
  return { calendar: editableCalendar(db, event.calendarId), record: getRecord(db, event.calendarId, event.remoteId)! }
}

function store(db: Db, calendar: CalendarSyncState, record: EventRecord): CalendarEvent {
  noteLocalWrite(calendar.id)
  upsertEvents(db, calendar.id, [record], calendar.generation)
  return getEventByRemoteId(db, calendar.id, record.remoteId)!
}

// Earliest first, the order providers keep them in. Two rows with one time count once. Google and Outlook take no
// reminder after the start: all-day reminders "on the same day" (below 0) stay in this app.
const minutesOf = (reminders: EventReminder[]): number[] =>
  mergeReminders(reminders)
    .map((r) => r.minutes)
    .filter((minutes) => minutes >= 0)

// Google keeps reminders per user. Outlook keeps them on the event itself, so outside the user's main calendar
// (which may be someone else's) a change would set another person's reminder: there they stay in this app.
function syncsReminders(db: Db, calendar: CalendarSyncState): boolean {
  return calendar.canEdit && (calendar.isPrimary || getAccount(db, calendar.accountId)?.provider === 'google')
}

// The user's reminders, with the provider's minutes the event has now (null: the calendar's defaults, which are for
// timed events only).
function storeReminders(db: Db, calendar: CalendarSyncState, record: EventRecord, reminders: EventReminder[]): void {
  saveEventReminders(db, calendar.id, record.remoteId, reminders, record.reminders ?? (record.allDay ? [] : calendar.defaultReminders), record.allDay)
}

// notify false: guests get no invitation (Google only). color: the provider fields of the color the user picked.
export async function createEvent(db: Db, input: EventInput, notify?: boolean, color: EventChange = {}): Promise<CalendarEvent> {
  const calendar = editableCalendar(db, input.calendarId)
  const account = { id: calendar.accountId, email: calendar.email }
  const minutes = input.reminders && syncsReminders(db, calendar) ? minutesOf(input.reminders) : undefined
  const record =
    calendar.provider === 'outlook'
      ? await withOutlook(db, account, (deps) => createOutlookEvent(deps, calendar.remoteId, input, minutes, color))
      : await withGoogle(db, account.id, (deps) => createGoogleEvent(deps, calendar.remoteId, input, minutes, notify, color))
  if (input.reminders) storeReminders(db, calendar, record, input.reminders)
  return store(db, calendar, record)
}

// Reminders can change in view-only calendars too: there they stay in this app. Elsewhere the provider gets
// the new times (not when only an alarm flag changed) and keeps what it can; the rest stay in this app.
// scope 'following' or 'series' returns null: the sync brings the events of the changed series.
export async function updateEvent(
  db: Db,
  eventId: number,
  change: EventChange,
  reminders?: EventReminder[],
  scope: Scope = 'event'
): Promise<CalendarEvent | null> {
  const event = getEvent(db, eventId)
  if (!event) throw new Error('This event no longer exists.')
  const calendar = getCalendarSyncState(db, event.calendarId)!
  if (reminders && syncsReminders(db, calendar) && minutesOf(reminders).join() !== minutesOf(event.reminders).join()) {
    change = { ...change, reminders: minutesOf(reminders) }
  }
  if (scope !== 'event') {
    const record = getRecord(db, calendar.id, event.remoteId)!
    const seriesId = record.seriesRemoteId!
    const series = Object.keys(change).length > 0 ? await sendSeriesChange(db, eventId, change, scope) : null
    // Google gives every event new ids when the series' times change, so their own reminders would only leak.
    // "All events" reminders replace them anyway.
    const google = getAccount(db, calendar.accountId)?.provider === 'google'
    if (scope === 'series' && ((google && change.times) || reminders)) deleteInstanceReminders(db, calendar.id, seriesId)
    // One row for the series, which each event reads unless it has its own. A split's new series keeps
    // the old series' reminders.
    const remoteId = scope === 'series' ? seriesId : series!.remoteId
    const saved = series ?? record
    if (reminders) saveEventReminders(db, calendar.id, remoteId, reminders, saved.reminders ?? (saved.allDay ? [] : calendar.defaultReminders), saved.allDay)
    else if (scope === 'following') copyEventReminders(db, calendar.id, seriesId, remoteId)
    return null
  }
  const record = Object.keys(change).length > 0 ? await sendChange(db, eventId, change) : getRecord(db, calendar.id, event.remoteId)!
  if (reminders) storeReminders(db, calendar, record, reminders)
  return getEventByRemoteId(db, calendar.id, record.remoteId)!
}

// Sends the change and stores the provider's answer.
async function sendChange(db: Db, eventId: number, change: EventChange): Promise<EventRecord> {
  const { calendar, record } = editableEvent(db, eventId)
  const account = { id: calendar.accountId, email: calendar.email }
  try {
    const updated =
      calendar.provider === 'outlook'
        ? await withOutlook(db, account, (deps) => updateOutlookEvent(deps, record, change))
        : await withGoogle(db, account.id, (deps) => updateGoogleEvent(deps, calendar.remoteId, record, change))
    store(db, calendar, updated)
    return updated
  } catch (error) {
    // Show the other change right away; the user can then edit again on top of it.
    if (error instanceof ConflictError) store(db, calendar, error.latest)
    throw error
  }
}

// "This and following" or "All events" of the user's own series. The answer is the series, which is not stored (a
// Google master row would be swept); the sync brings its events. A split ends the old series' rows here at once.
async function sendSeriesChange(db: Db, eventId: number, change: EventChange, scope: 'following' | 'series'): Promise<EventRecord> {
  const { calendar, record } = editableEvent(db, eventId)
  const account = { id: calendar.accountId, email: calendar.email }
  const cut = record.originalStart ?? record.start
  // Made once, before a sign-in renew can run the write again, so a re-run finds the same new series.
  const newId = splitId(record.seriesRemoteId!, cut)
  // Off for Outlook: it has no list of deleted events, so a new series would bring them back and invite every guest to
  // them again. updateOutlookSeries can split; turn it on when the app can find those events.
  if (calendar.provider === 'outlook' && scope === 'following') throw new Error('Change this and following events in Outlook.')
  // Outlook brings deleted events back and drops one-off edits when the series gets new times or a new rule (seen live,
  // N1). Title, place, description and guests are fine.
  if (calendar.provider === 'outlook' && (change.times || change.repeat)) throw new Error('Change the time or repeat rule of all events in Outlook.')
  // An all-day series made timed has no zone yet: like Google web, it gets the calendar's, never UTC.
  if (record.allDay && change.times && !change.times.allDay && !change.timeZone) {
    const zone = calendar.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    change = { ...change, timeZone: zone, endTimeZone: zone }
  }
  // Before the first request too: a sync that runs meanwhile must not store what it read before this write.
  noteLocalWrite(calendar.id)
  try {
    const series =
      calendar.provider === 'outlook'
        ? await withOutlook(db, account, async (deps) => {
            const written = await updateOutlookSeries(deps, calendar.remoteId, record, change, scope, newId)
            // Outlook web shows the series' categories on every event, but its API keeps the own ones of an event with
            // its own changes, so the app would still show the old color there (seen live). Those get the color too.
            if (scope === 'series' && change.categories) {
              for (const exception of listSeriesExceptions(db, calendar.id, record.seriesRemoteId!)) {
                store(db, calendar, await updateOutlookEvent(deps, exception, { categories: change.categories }))
              }
            }
            return written
          })
        : await withGoogle(db, account.id, (deps) =>
            updateGoogleSeries(deps, calendar.remoteId, record, change, scope, newId, calendar.windowEnd ?? Date.now() + WINDOW_MS)
          )
    noteLocalWrite(calendar.id)
    if (scope === 'following') deleteSeriesInstancesFrom(db, calendar.id, record.seriesRemoteId!, cut)
    return series
  } catch (error) {
    // The event's latest copy, like a single event: the user sees the other change at once.
    if (error instanceof ConflictError) store(db, calendar, error.latest)
    throw error
  }
}

// Deletes the event. For a meeting someone else organizes, Outlook declines it instead, so the organizer knows.
// Google only takes it off this calendar, with no answer to the organizer, like Google web's "Remove from this calendar".
// A meeting the organizer canceled is just removed, like Outlook's "Remove event". notify false: guests get no
// cancellation (Google only). scope 'series' deletes the user's own series; 'following' ends it before this event.
export async function deleteEvent(db: Db, eventId: number, notify?: boolean, scope: Scope = 'event'): Promise<void> {
  const { calendar, record } = editableEvent(db, eventId)
  if (isInvite(record)) {
    // Outside the main calendar it would act in the owner's name, like an answer.
    if (!calendar.isPrimary) throw new Error('You can only remove invites in your main calendar')
    if (calendar.provider === 'outlook') return respondEvent(db, eventId, 'declined', 'event')
  }
  const account = { id: calendar.accountId, email: calendar.email }
  if (scope !== 'event') {
    const seriesId = record.seriesRemoteId!
    if (calendar.provider === 'outlook') {
      await withOutlook(db, account, (deps) => deleteOutlookSeries(deps, record, scope))
    } else {
      await withGoogle(db, account.id, (deps) => deleteGoogleSeries(deps, calendar.remoteId, record, scope, notify))
    }
    noteLocalWrite(calendar.id)
    if (scope === 'series') deleteEvents(db, calendar.id, [seriesId])
    else deleteSeriesInstancesFrom(db, calendar.id, seriesId, record.originalStart ?? record.start)
    return
  }
  if (calendar.provider === 'outlook') {
    await withOutlook(db, account, (deps) => deleteOutlookEvent(deps, record.remoteId))
  } else {
    await withGoogle(db, account.id, (deps) => deleteGoogleEvent(deps, calendar.remoteId, record, notify))
  }
  noteLocalWrite(calendar.id)
  deleteEvents(db, calendar.id, [record.remoteId])
}

// Answers a meeting someone else organizes. Only in the user's main calendar: elsewhere the answer would go out in the
// owner's name. A series answer is stored by the next sync (Google keeps no master here; it returns every event).
export async function respondEvent(db: Db, eventId: number, answer: Answer, scope: Scope): Promise<void> {
  const { calendar, record } = editableEvent(db, eventId)
  if (!calendar.isPrimary) throw new Error('You can only answer invites in your main calendar')
  const account = { id: calendar.accountId, email: calendar.email }
  const remoteId = scope === 'series' ? record.seriesRemoteId! : record.remoteId
  if (calendar.provider === 'outlook') {
    await withOutlook(db, account, (deps) => respondOutlookEvent(deps, remoteId, answer, record.responseRequested !== false))
    // Outlook takes a declined meeting off the calendar. A series id also removes all its events.
    if (answer === 'declined') {
      noteLocalWrite(calendar.id)
      deleteEvents(db, calendar.id, [remoteId])
    } else if (scope === 'event') {
      store(db, calendar, { ...record, response: answer })
    }
  } else {
    // A group invite has no entry of our own; then the answer is for the calendar's address, the user's.
    const email = record.attendees.find((a) => a.self)?.email ?? calendar.email
    const updated = await withGoogle(db, account.id, (deps) => respondGoogleEvent(deps, calendar.remoteId, remoteId, email, answer))
    if (scope === 'event') store(db, calendar, updated)
  }
}

// The rule of the event's series. null: the event does not repeat. Outlook masters are stored (also signed out);
// Google's are read when needed.
export async function getSeries(db: Db, eventId: number): Promise<Series | null> {
  const event = getEvent(db, eventId)
  if (!event) throw new Error('This event no longer exists.')
  if (event.seriesRemoteId === null) return null
  const calendar = getCalendarAccount(db, event.calendarId)!
  if (calendar.provider === 'google') {
    return withGoogle(db, calendar.accountId, (deps) => getGoogleSeries(deps, calendar.remoteId, event.seriesRemoteId!))
  }
  const master = getRecord(db, calendar.id, event.seriesRemoteId)
  if (!master?.recurrence) throw new Error('Could not load the repeat rule.')
  const recurrence = JSON.parse(master.recurrence) as OutlookRecurrence
  const zone = master.allDay ? null : outlookSeriesZone(recurrence, master.startTz)
  const repeat = zone || master.allDay ? fromPattern(recurrence, { start: master.start, allDay: master.allDay, zone: zone ?? 'UTC' }) : null
  return { repeat, first: master.start, zone }
}
