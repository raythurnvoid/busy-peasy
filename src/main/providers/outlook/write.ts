import { randomUUID } from 'node:crypto'
import type { Answer, EventInput, GuestEdit } from '../../../shared/api'
import { SHOWN } from '../../../shared/events'
import { cutPattern, dayOf, firstDay, fromPattern, scopeChoices, toPattern, type OutlookRecurrence } from '../../../shared/repeat'
import { canonicalZone, ianaZone, isZone, windowsZone } from '../../../shared/zones'
import type { EventRecord } from '../../db/events'
import { ConflictError, seriesPlan, twice, type EventChange } from '../write'
import { OUTLOOK_BASE, OutlookAuthError, OutlookHttpError, outlookRequest, type OutlookDeps } from './client'
import { toRecord, type OutlookEvent } from './map'

// Outlook takes local wall time plus a Windows zone name. Edits keep the event's own zones (Windows or IANA names), so a
// series or a meeting made in another zone stays in it. Timed writes fall back to UTC for zones not in our table.
// picked: the user chose the zones, so they must be ones Outlook takes. Not UTC either: the app reads an Outlook UTC zone
// as its own old write (db/events.ts), so the pick would be lost on the next edit.
function times(
  input: Pick<EventInput, 'start' | 'end' | 'allDay' | 'startDate' | 'endDate'>,
  startZone?: string,
  endZone?: string,
  picked = false
): object {
  const userZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const takes = (zone?: string): boolean => (windowsZone(zone!) ?? 'UTC') !== 'UTC'
  if (picked && !(takes(startZone) && takes(endZone))) throw new Error('Outlook does not take this time zone. Pick another one.')
  const zone = (startZone && windowsZone(startZone)) || windowsZone(userZone) || 'UTC'
  const end = (endZone && windowsZone(endZone)) || zone
  // sv-SE prints "2026-10-27 09:00:00", Outlook's form once the space is a T.
  const at = (ms: number, name: string): object => ({
    DateTime: new Date(ms).toLocaleString('sv-SE', { timeZone: ianaZone(name) }).replace(' ', 'T'),
    TimeZone: name
  })
  const day = (date: string, timeZone: string): object => ({ DateTime: `${date}T00:00:00`, TimeZone: timeZone })
  if (!input.allDay) return { IsAllDay: false, Start: at(input.start, zone), End: at(input.end, end) }
  // All-day events must be midnight in the user's zone, or Outlook shows them shifted.
  const local = windowsZone(userZone) ?? userZone
  return { IsAllDay: true, Start: day(input.startDate!, local), End: day(input.endDate!, local) }
}

type OutlookAttendee = NonNullable<OutlookEvent['Attendees']>[number]

// The edit applied to Outlook's own list, so answers and rooms stay. Outlook writes have no If-Match, so a guest added
// in Outlook meanwhile stays too, and one removed there is not added back by an optional flag.
function attendees(latest: OutlookAttendee[], edit: GuestEdit): OutlookAttendee[] {
  // A guest Outlook stored without an address is '' in the app (map.ts), so compare with that.
  const same = (a: OutlookAttendee, email: string): boolean => (a.EmailAddress?.Address ?? '').toLowerCase() === email.toLowerCase()
  const type = (optional: boolean): string => (optional ? 'Optional' : 'Required')
  const list = latest
    .filter((a) => !edit.remove.some((email) => same(a, email)))
    .map((a) => {
      const set = edit.set.find((g) => same(a, g.email))
      return set && a.Type !== 'Resource' ? { ...a, Type: type(set.optional) } : a
    })
  for (const g of edit.add) {
    if (!list.some((a) => same(a, g.email))) list.push({ EmailAddress: { Address: g.email }, Type: type(g.optional) })
  }
  return list
}

// latest: the event as Outlook has it now, for guest edits and to add Teams only once. A zone the user picked wins over
// the event's own.
function body(change: EventChange, eventZone?: string, endZone?: string, latest?: OutlookEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (change.title !== undefined) out.Subject = change.title
  if (change.location !== undefined) out.Location = { DisplayName: change.location }
  if (change.description !== undefined) out.Body = { ContentType: 'Text', Content: change.description }
  if (change.times) Object.assign(out, times(change.times, change.timeZone ?? eventZone, change.endTimeZone ?? endZone, change.timeZone !== undefined))
  // Outlook keeps one reminder: the earliest, so Outlook on other devices warns first.
  if (change.reminders) {
    out.IsReminderOn = change.reminders.length > 0
    if (change.reminders.length > 0) out.ReminderMinutesBeforeStart = Math.max(...change.reminders)
  }
  if (change.guests) out.Attendees = attendees(latest?.Attendees ?? [], change.guests)
  if (change.conference && latest?.IsOnlineMeeting !== true) {
    out.IsOnlineMeeting = true
    out.OnlineMeetingProvider = 'TeamsForBusiness'
  }
  // The app shows the first category, so the picked one goes first. The others stay. The list is Outlook's latest, so a
  // category added elsewhere since the last sync is also kept, or taken off by Default.
  if (change.categories) {
    const { first, remove } = change.categories
    const rest = (latest?.Categories ?? []).filter((c) => c !== first && !remove.includes(c))
    out.Categories = first === null ? rest : [first, ...rest]
  }
  return out
}

// Outlook answers a write in the zone of the times we sent, not in UTC as asked (seen live), so keep the moment we sent,
// in whole seconds like the wall time. In the repeated DST hour Outlook may keep the other moment; the next sync fixes it.
function answer(event: OutlookEvent, sent?: EventChange['times']): EventRecord {
  const record = toRecord(event)
  return sent && !sent.allDay ? { ...record, start: sent.start - (sent.start % 1000), end: sent.end - (sent.end % 1000) } : record
}

// reminders: minutes, or undefined for the mailbox's default. Outlook emails every guest; there is no choice. color: the
// category the user picked.
export async function createOutlookEvent(
  deps: OutlookDeps,
  calendarRemoteId: string,
  input: EventInput,
  reminders?: number[],
  color: Pick<EventChange, 'categories'> = {}
): Promise<EventRecord> {
  const out = body({
    title: input.title,
    location: input.location,
    description: input.description,
    times: input,
    timeZone: input.timeZone,
    endTimeZone: input.endTimeZone,
    reminders,
    guests: input.guests?.length ? { add: input.guests, set: [], remove: [] } : undefined,
    conference: input.conference,
    ...color
  })
  if (input.repeat) {
    // Main sends a zone with every timed series, so it is never UTC. All-day: this PC's zone, like times().
    const zone = input.allDay ? Intl.DateTimeFormat().resolvedOptions().timeZone : input.timeZone!
    out.Recurrence = toPattern(input.repeat, { start: input.start, allDay: input.allDay, zone }, windowsZone(zone) ?? zone)
  }
  // TransactionId makes a retried create return the same event instead of a copy.
  const created = await outlookRequest<OutlookEvent>(deps, `${OUTLOOK_BASE}calendars/${encodeURIComponent(calendarRemoteId)}/events`, {
    method: 'POST',
    body: { ...out, TransactionId: randomUUID() }
  })
  return answer(created, input)
}

// If-Match with an old ChangeKey gives a 500 here, not a 412, so compare ourselves first. Outlook also changes the
// ChangeKey by itself soon after a create, so only a change in what the app shows is a conflict.
export async function updateOutlookEvent(
  deps: OutlookDeps,
  record: EventRecord,
  change: EventChange
): Promise<EventRecord> {
  const url = `${OUTLOOK_BASE}events/${encodeURIComponent(record.remoteId)}`
  // Outlook puts the Teams block into the body, and a body we write could drop it.
  if (change.conference && change.description !== undefined) throw new Error('Save the description first, then add the Teams meeting.')
  try {
    const latest = await outlookRequest<OutlookEvent>(deps, url)
    const server = toRecord(latest)
    const changed = latest.ChangeKey !== record.version && SHOWN.some((k) => server[k] !== record[k])
    if (record.version !== null && changed) throw new ConflictError(server)
    // The app edits BodyPreview (255 characters) and keeps the body only as text, without links and images. Saving
    // either would cut the rest of the body (agenda, Teams block, links) for every attendee, so only bodies that fit in
    // the preview can be edited.
    if (change.description !== undefined && !previewIsWholeBody(latest)) {
      throw new Error('This description has more than the app shows (long text, links or images). Edit it in Outlook so nothing is lost.')
    }
    // Outlook reports all-day events in UTC, and the app sent UTC before it sent real zones. Nobody chose those, so they
    // get the user's zone.
    const kept = (zone?: string): string | undefined => (latest.IsAllDay || zone === 'UTC' ? undefined : zone)
    const out = body(change, kept(latest.OriginalStartTimeZone), kept(latest.OriginalEndTimeZone), latest)
    return answer(await outlookRequest<OutlookEvent>(deps, url, { method: 'PATCH', body: out }), change.times)
  } catch (error) {
    if (!(error instanceof OutlookHttpError)) throw error
    if (error.status === 404 || error.status === 410) throw new Error('This event no longer exists.', { cause: error })
    // Outlook's rule: an event of a series cannot move onto or past the day of another event of that series.
    if (error.status === 400 && error.code === 'ErrorOccurrenceCrossingBoundary') {
      throw new Error("Outlook can't move an event of a series onto or past another event of that series.", { cause: error })
    }
    throw error
  }
}

export async function deleteOutlookEvent(deps: OutlookDeps, remoteId: string): Promise<void> {
  await ignoreGone(outlookRequest(deps, `${OUTLOOK_BASE}events/${encodeURIComponent(remoteId)}`, { method: 'DELETE' }))
}

// The zone of an Outlook series: its rule's dates are wall dates there (RecurrenceTimeZone, a Windows name). startZone:
// the master's OriginalStartTimeZone. null: a zone the app does not know. The rule shown and the writes use this one.
export function outlookSeriesZone(recurrence: OutlookRecurrence | undefined, startZone: string | null | undefined): string | null {
  const name = recurrence?.Range?.RecurrenceTimeZone ?? startZone ?? ''
  const zone = canonicalZone(ianaZone(name) ?? name)
  return isZone(zone) ? zone : null
}

function seriesZone(master: OutlookEvent): string {
  const zone = outlookSeriesZone(master.Recurrence as OutlookRecurrence | undefined, master.OriginalStartTimeZone)
  if (zone === null) throw new Error('The app does not know the time zone of this series. Change it in Outlook.')
  return zone
}

// What a split copies from the old series to the new one. The body goes as it is, with its Teams block: a new Teams
// meeting would add a second one.
const COPIED = ['Subject', 'Body', 'Location', 'Categories', 'Importance', 'Sensitivity', 'ShowAs', 'IsReminderOn', 'ReminderMinutesBeforeStart', 'Attendees']

// "This and following" or "All events" for one event of the user's own series. transactionId: splitId, so a retried
// split gets the same new series back. Outlook emails every guest; there is no "Do not send".
// Not reachable today: event-writes.ts refuses Outlook splits and new times or rules for all events, so only the title,
// place, description, guests and colors get here. The rest stays, tested, for when the app can find deleted events.
export async function updateOutlookSeries(
  deps: OutlookDeps,
  calendarRemoteId: string,
  record: EventRecord,
  change: EventChange,
  scope: 'following' | 'series',
  transactionId: string
): Promise<EventRecord> {
  const path = (id: string): string => `${OUTLOOK_BASE}events/${encodeURIComponent(id)}`
  if (change.conference && change.description !== undefined) throw new Error('Save the description first, then add the Teams meeting.')
  try {
    // Fresh copies, like updateOutlookEvent: a shown change to this event since the last sync is a conflict.
    const latest = await outlookRequest<OutlookEvent>(deps, path(record.remoteId))
    const instance = toRecord(latest)
    if (record.version !== null && latest.ChangeKey !== record.version && SHOWN.some((k) => instance[k] !== record[k])) {
      throw new ConflictError(instance)
    }
    // The pattern is built from this copy, not the stored row.
    const master = await outlookRequest<OutlookEvent>(deps, path(record.seriesRemoteId!))
    if (master.IsOrganizer !== true) throw new Error('Only the organizer can change all events.')
    if (change.description !== undefined && !previewIsWholeBody(master)) {
      throw new Error('This description has more than the app shows (long text, links or images). Edit it in Outlook so nothing is lost.')
    }
    const recurrence = master.Recurrence as OutlookRecurrence
    const zone = seriesZone(master)
    const m = toRecord(master)
    const repeat = fromPattern(recurrence, { start: m.start, allDay: m.allDay, zone })
    const weekStart = firstDay(recurrence.Pattern?.FirstDayOfWeek)
    const plan = seriesPlan({ master: m, zone, repeat, weekStart, instance, change, scope })
    // A series always gets its zone, so it is never sent in UTC.
    const zones = plan.times.allDay ? {} : { timeZone: plan.next.zone, endTimeZone: change.endTimeZone ?? plan.next.zone }
    const times = change.times || scope === 'following' ? { times: plan.times, ...zones } : {}
    const windows = plan.next.allDay ? (recurrence.Range?.RecurrenceTimeZone ?? 'UTC') : windowsZone(plan.next.zone)!
    if (plan.rewrite && plan.rule === null) throw new Error('The app cannot change this repeat rule. Change it in Outlook.')
    const pattern = (): object => toPattern(plan.rule!, plan.next, windows)
    if (scope === 'series') {
      const out = body({ ...change, ...times }, undefined, undefined, master)
      // The rule's start date and zone go with the start, so Outlook gets the whole rule again.
      if (plan.rewrite) out.Recurrence = pattern()
      return toRecord(await outlookRequest<OutlookEvent>(deps, path(master.Id), { method: 'PATCH', body: out }))
    }
    const raw = master as unknown as Record<string, unknown>
    const copy = Object.fromEntries(COPIED.filter((k) => raw[k] !== undefined && raw[k] !== null).map((k) => [k, raw[k]]))
    const out: Record<string, unknown> = { ...copy, ...body({ ...change, ...times }, undefined, undefined, master), Recurrence: pattern(), TransactionId: transactionId }
    const title = (out.Subject as string | undefined) ?? ''
    let created: OutlookEvent
    try {
      created = await outlookRequest<OutlookEvent>(deps, `${OUTLOOK_BASE}calendars/${encodeURIComponent(calendarRemoteId)}/events`, { method: 'POST', body: out })
    } catch (error) {
      // A re-run with a fresh token sends the same TransactionId: safe. A clear 4xx made nothing.
      if (error instanceof OutlookAuthError || (error instanceof OutlookHttpError && error.status < 500)) throw error
      throw new Error(twice(title, plan.next.start, plan.next.zone, 'Outlook'), { cause: error })
    }
    // A TransactionId reused after a rollback may give back the deleted series: cut only for a live one. Any
    // other failure leaves both series.
    const live = await outlookRequest<OutlookEvent>(deps, path(created.Id)).catch((error: unknown) => {
      if (error instanceof OutlookHttpError && (error.status === 404 || error.status === 410)) return null
      if (error instanceof OutlookAuthError) throw error
      throw new Error(twice(title, plan.next.start, plan.next.zone, 'Outlook'), { cause: error })
    })
    if (live?.Type !== 'SeriesMaster') throw new Error('This split was undone before. Change these events in Outlook.')
    // Outlook needs the full Pattern with the new end.
    const end = cutPattern(recurrence, instance.originalStart ?? instance.start, instance.allDay, zone)
    try {
      await outlookRequest(deps, path(master.Id), { method: 'PATCH', body: { Recurrence: end } })
    } catch (error) {
      // A re-run with a fresh token gets the same new series and ends the old one: no rollback.
      if (error instanceof OutlookAuthError) throw error
      // No answer or a server error: the cut may be done, and a rollback would then lose every following event.
      // Only a clear 4xx says it was not made; else read the series to know. Only the old rule, as it was, is safe to
      // roll back; our cut is done; anything else keeps both.
      if (!(error instanceof OutlookHttpError && error.status < 500)) {
        const unknown = (cause: unknown): Error => new Error(twice(title, plan.next.start, plan.next.zone, 'Outlook'), { cause })
        const latest = await outlookRequest<OutlookEvent>(deps, path(master.Id)).catch((readError: unknown) => {
          throw unknown(readError)
        })
        const range = (latest.Recurrence as OutlookRecurrence | undefined)?.Range
        if (range?.Type === 'EndDate' && range.EndDate?.slice(0, 10) === end.Range?.EndDate) return toRecord(live)
        if (JSON.stringify(latest.Recurrence) !== JSON.stringify(master.Recurrence)) throw unknown(error)
      }
      try {
        await outlookRequest(deps, path(created.Id), { method: 'DELETE' })
      } catch (rollbackError) {
        throw new Error(twice(title, plan.next.start, plan.next.zone, 'Outlook'), { cause: rollbackError })
      }
      // A plain error, never an auth error: a re-run after a rollback must not split again.
      throw new Error(`Could not change this and following events. ${error instanceof Error ? error.message : ''}`.trim(), { cause: error })
    }
    return toRecord(live)
  } catch (error) {
    if (!(error instanceof OutlookHttpError)) throw error
    if (error.status === 404 || error.status === 410) throw new Error('This event no longer exists.', { cause: error })
    throw error
  }
}

// "All events" deletes the series; "This and following" ends it before this event. Outlook tells the guests.
export async function deleteOutlookSeries(deps: OutlookDeps, record: EventRecord, scope: 'following' | 'series'): Promise<void> {
  if (scope === 'series') return deleteOutlookEvent(deps, record.seriesRemoteId!)
  const path = `${OUTLOOK_BASE}events/${encodeURIComponent(record.seriesRemoteId!)}`
  const master = await outlookRequest<OutlookEvent>(deps, path).catch((error: unknown) => {
    if (error instanceof OutlookHttpError && (error.status === 404 || error.status === 410)) return null
    throw error
  })
  // Already gone counts as done.
  if (master === null) return
  if (master.IsOrganizer !== true) throw new Error('Only the organizer can delete all events.')
  const recurrence = master.Recurrence as OutlookRecurrence
  const zone = seriesZone(master)
  const m = toRecord(master)
  const date = (t: number): string => dayOf({ start: t, allDay: record.allDay }, zone).date
  const cut = record.originalStart ?? record.start
  // Not on the first event (that is all events), and not on a rule the app cannot read.
  const repeat = fromPattern(recurrence, { start: m.start, allDay: m.allDay, zone })
  if (!scopeChoices({ repeat, firstDate: date(m.start), from: date(cut), to: date(cut) }).includes('following')) {
    throw new Error('The series was changed somewhere else. Try again.')
  }
  await outlookRequest(deps, path, { method: 'PATCH', body: { Recurrence: cutPattern(recurrence, cut, record.allDay, zone) } })
}

const ACTIONS: Record<Answer, string> = { accepted: 'accept', tentative: 'tentativelyaccept', declined: 'decline' }

// Answers a meeting someone else organizes. remoteId: an event, or a series master for all its events.
// tell: send the answer to the organizer (like Outlook web's "Email organizer"); false when the organizer asked for none.
export async function respondOutlookEvent(deps: OutlookDeps, remoteId: string, reply: Answer, tell: boolean): Promise<void> {
  try {
    await outlookRequest(deps, `${OUTLOOK_BASE}events/${encodeURIComponent(remoteId)}/${ACTIONS[reply]}`, {
      method: 'POST',
      body: { SendResponse: tell }
    })
  } catch (error) {
    if (!(error instanceof OutlookHttpError) || (error.status !== 404 && error.status !== 410)) throw error
    // A decline removes the event anyway, so a gone one is done. Yes or Maybe to a gone event is not.
    if (reply !== 'declined') throw new Error('This event no longer exists.', { cause: error })
  }
}

// Outlook cuts BodyPreview at 255 characters, so a shorter one holds all the text. Link targets and
// images are not in the preview, so a body with them cannot be rewritten from it either.
function previewIsWholeBody(event: OutlookEvent): boolean {
  const html = (event.Body?.Content ?? '').replace(/<head\b[\s\S]*?<\/head>/gi, '')
  return (event.BodyPreview ?? '').length < 255 && !/<(a|img)\s/i.test(html)
}

// Already gone counts as done.
async function ignoreGone(request: Promise<unknown>): Promise<void> {
  try {
    await request
  } catch (error) {
    if (!(error instanceof OutlookHttpError) || (error.status !== 404 && error.status !== 410)) throw error
  }
}
