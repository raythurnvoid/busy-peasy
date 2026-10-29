import { randomUUID } from 'node:crypto'
import type { Answer, EventInput, GuestEdit, Repeat, Series } from '../../../shared/api'
import { GUEST_FLAGS, SHOWN } from '../../../shared/events'
import { cutRrule, dayOf, exdateLine, exdates, fromRrule, makesDay, ruleParts, scopeChoices, shiftStart, toRrule, weekStartOf, type First } from '../../../shared/repeat'
import type { EventRecord } from '../../db/events'
import { ConflictError, OWN_KEYS, seriesPlan, twice, type EventChange } from '../write'
import { GOOGLE_BASE, GoogleAuthError, GoogleHttpError, googleRequest, type GoogleDeps } from './client'
import { toRecord, type GoogleEvent } from './map'

// Google takes at most 5 reminders, email ones included.
const MAX_REMINDERS = 5

type GoogleAttendee = NonNullable<GoogleEvent['attendees']>[number]

function eventUrl(calendarRemoteId: string, eventRemoteId?: string, query = ''): string {
  const base = `${GOOGLE_BASE}calendars/${encodeURIComponent(calendarRemoteId)}/events`
  return (eventRemoteId === undefined ? base : `${base}/${encodeURIComponent(eventRemoteId)}`) + (query ? `?${query}` : '')
}

// The edit applied to Google's own list, so answers, notes and the organizer's entry stay as Google has them. A guest
// removed elsewhere is not added back by an optional flag.
function guestList(latest: GoogleAttendee[], edit: GuestEdit): GoogleAttendee[] {
  const same = (a: string | undefined, b: string): boolean => (a ?? '').toLowerCase() === b.toLowerCase()
  const list = latest
    .filter((a) => !edit.remove.some((email) => same(a.email, email)))
    .map((a) => {
      const set = edit.set.find((g) => same(a.email, g.email))
      // Google leaves false flags out.
      return set ? { ...a, optional: set.optional || undefined } : a
    })
  for (const g of edit.add) {
    if (!list.some((a) => same(a.email, g.email))) list.push({ email: g.email, optional: g.optional || undefined })
  }
  return list
}

// latest: the event as Google has it now. Reminders and guests are lists that PATCH replaces whole, and a video call
// is added only to an event without one, so these change the latest copy.
function body(change: EventChange, latest?: GoogleEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (change.title !== undefined) out.summary = change.title
  if (change.location !== undefined) out.location = change.location
  if (change.description !== undefined) out.description = change.description
  const t = change.times
  if (t) {
    // No timeZone unless the user picked one: Google gives new events the calendar's zone (like Google web), and PATCH
    // keeps an event's zone. Sending both keys clears the other form, e.g. when a timed event becomes all-day.
    const zone = (timeZone?: string): object => (timeZone ? { timeZone } : {})
    out.start = t.allDay
      ? { date: t.startDate, dateTime: null }
      : { dateTime: new Date(t.start).toISOString(), date: null, ...zone(change.timeZone) }
    out.end = t.allDay
      ? { date: t.endDate, dateTime: null }
      : { dateTime: new Date(t.end).toISOString(), date: null, ...zone(change.endTimeZone) }
  }
  if (change.reminders) {
    // The app does not keep email reminders, so they are sent back.
    // Email reminders that come from the calendar's defaults are lost; the app has no way to show them.
    const emails = latest?.reminders?.useDefault === false ? (latest.reminders.overrides ?? []).filter((r) => r.method === 'email') : []
    const popups = change.reminders.slice(0, MAX_REMINDERS - emails.length).map((minutes) => ({ method: 'popup', minutes }))
    out.reminders = { useDefault: false, overrides: [...emails, ...popups] }
  }
  if (change.guests) out.attendees = guestList(latest?.attendees ?? [], change.guests)
  for (const key of GUEST_FLAGS) {
    if (change[key] !== undefined) out[key] = change[key]
  }
  // Each create request makes a new call, so only when it changes something.
  if (change.conference !== undefined && change.conference !== !!(latest?.conferenceData || latest?.hangoutLink)) {
    out.conferenceData = change.conference
      ? { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } }
      : null
  }
  if (change.label !== undefined) out.eventLabelId = change.label
  if (change.colorId !== undefined) out.colorId = change.colorId
  return out
}

// Attendees hear about changes only from the organizer, never about the organizer's reminders or colors (they are per
// user), and not when the organizer chose "Do not send". The first guests added hear too, though the event had none.
// notify is not a change: a delete sends only it, and its guests hear.
function sendUpdates(record: EventRecord, change: EventChange): string {
  const own = Object.keys(change).every((key) => key !== 'notify' && OWN_KEYS.includes(key))
  const send = record.isOrganizer && (record.attendeeCount > 0 || change.guests !== undefined) && !own && change.notify !== false
  return `sendUpdates=${send ? 'all' : 'none'}`
}

// Google reads conferenceData only with this flag.
const conferenceFlag = (out: Record<string, unknown>): string => ('conferenceData' in out ? '&conferenceDataVersion=1' : '')
// Google reads eventLabelId only with this flag; colorId is then ignored.
const labelFlag = (out: Record<string, unknown>): string => ('eventLabelId' in out ? '&eventLabelVersion=1' : '')

// Google ignores colorId next to a label, so a classic color the answer does not have goes in a PATCH of its own, on the
// copy the first one made. null: nothing to send.
function colorIdPatch(deps: GoogleDeps, url: string, answer: GoogleEvent, change: EventChange): Promise<GoogleEvent> | null {
  if (change.colorId === undefined || (answer.colorId ?? null) === change.colorId) return null
  return googleRequest<GoogleEvent>(deps, url, { method: 'PATCH', body: { colorId: change.colorId }, headers: { 'If-Match': answer.etag! } })
}

// reminders: minutes, or undefined for the calendar's defaults. notify false: guests get no invitation. color: the
// label or classic color the user picked.
export async function createGoogleEvent(
  deps: GoogleDeps,
  calendarRemoteId: string,
  input: EventInput,
  reminders?: number[],
  notify?: boolean,
  color: Pick<EventChange, 'label' | 'colorId'> = {}
): Promise<EventRecord> {
  // Our own id makes a retried create safe: the second try gets 409 instead of a copy.
  const id = randomUUID().replaceAll('-', '')
  const { title, location, description, guests, guestsCanModify, guestsCanInviteOthers, guestsCanSeeOtherGuests, conference, timeZone, endTimeZone } =
    input
  const change: EventChange = {
    title,
    location,
    description,
    times: input,
    timeZone,
    endTimeZone,
    reminders,
    guests: guests?.length ? { add: guests, set: [], remove: [] } : undefined,
    guestsCanModify,
    guestsCanInviteOthers,
    guestsCanSeeOtherGuests,
    conference,
    notify,
    ...color
  }
  const out = body(change)
  // Main sends a zone with every timed series: Google needs one there. All-day series have none.
  if (input.repeat) out.recurrence = [toRrule(input.repeat, { start: input.start, allDay: input.allDay, zone: timeZone ?? 'UTC' })]
  try {
    const created = await googleRequest<GoogleEvent>(
      deps,
      eventUrl(calendarRemoteId, undefined, `sendUpdates=${guests?.length && notify !== false ? 'all' : 'none'}${conferenceFlag(out)}${labelFlag(out)}`),
      { method: 'POST', body: { id, ...out } }
    )
    return toRecord(created)
  } catch (error) {
    if (!(error instanceof GoogleHttpError) || error.status !== 409) throw error
    return toRecord(await googleRequest<GoogleEvent>(deps, eventUrl(calendarRemoteId, id)))
  }
}

export async function updateGoogleEvent(
  deps: GoogleDeps,
  calendarRemoteId: string,
  record: EventRecord,
  change: EventChange
): Promise<EventRecord> {
  const url = (query?: string): string => eventUrl(calendarRemoteId, record.remoteId, query)
  // The latest copy, unless something the app shows changed there since the last sync.
  const read = async (): Promise<GoogleEvent> => {
    const latest = await googleRequest<GoogleEvent>(deps, url())
    const server = toRecord(latest)
    if (SHOWN.some((k) => server[k] !== record[k])) throw new ConflictError(server)
    return latest
  }
  // Google answers 412 when the event changed since the copy the If-Match names.
  const patch = async (latest?: GoogleEvent): Promise<EventRecord> => {
    const out = body(change, latest)
    const version = latest ? latest.etag : record.version
    const updated = await googleRequest<GoogleEvent>(deps, url(sendUpdates(record, change) + conferenceFlag(out) + labelFlag(out)), {
      method: 'PATCH',
      body: out,
      headers: version ? { 'If-Match': version } : {}
    })
    return toRecord((await colorIdPatch(deps, url('sendUpdates=none'), updated, change)) ?? updated)
  }
  try {
    const latest = change.reminders || change.guests || change.conference !== undefined ? await read() : undefined
    try {
      return await patch(latest)
    } catch (error) {
      // A guest's answer also changes the event. Read it again and try once more; a second 412 is a conflict.
      if (!(error instanceof GoogleHttpError) || error.status !== 412) throw error
      return await patch(await read())
    }
  } catch (error) {
    if (!(error instanceof GoogleHttpError)) throw error
    if (error.status === 404 || error.status === 410) throw new Error('This event no longer exists.', { cause: error })
    if (error.status !== 412) throw error
    const latest = await googleRequest<GoogleEvent>(deps, url())
    throw new ConflictError(toRecord(latest))
  }
}

// A master's first event and rule. Google gives every timed series a zone.
function seriesOf(master: GoogleEvent): { first: First; repeat: Repeat | null } {
  const record = toRecord(master)
  const first = { start: record.start, allDay: record.allDay, zone: master.start?.timeZone ?? 'UTC' }
  return { first, repeat: fromRrule(master.recurrence ?? [], first) }
}

// The app stores no Google masters (the sync reads single events), so the rule is read when it is shown.
export async function getGoogleSeries(deps: GoogleDeps, calendarRemoteId: string, seriesId: string): Promise<Series> {
  const master = await googleRequest<GoogleEvent>(deps, eventUrl(calendarRemoteId, seriesId, 'fields=start,end,recurrence'))
  const { first, repeat } = seriesOf(master)
  return { repeat, first: first.start, zone: first.allDay ? null : first.zone }
}

// What a split copies from the old series to the new one, as Google has it. Attachments and other apps' data stay with
// the old series. The call is copied, so guests keep one link.
const COPIED = ['summary', 'description', 'location', 'colorId', 'eventLabelId', 'transparency', 'visibility', 'guestsCanModify', 'guestsCanInviteOthers', 'guestsCanSeeOtherGuests', 'reminders', 'attendees', 'conferenceData']

// The starts of a series' deleted events from timeMin on. Google keeps them as cancelled events, not EXDATE lines, and a
// series written again would bring them back. Only up to the end of the synced dates: later ones are not read.
async function cancelledStarts(deps: GoogleDeps, calendarRemoteId: string, seriesId: string, timeMin: number, timeMax: number): Promise<number[]> {
  const starts: number[] = []
  let page: string | undefined
  do {
    const query = new URLSearchParams({ showDeleted: 'true', timeMin: new Date(timeMin).toISOString(), timeMax: new Date(timeMax).toISOString(), maxResults: '2500' })
    query.set('fields', 'nextPageToken,items(status,originalStartTime)')
    if (page) query.set('pageToken', page)
    const list = await googleRequest<{ items?: GoogleEvent[]; nextPageToken?: string }>(deps, `${eventUrl(calendarRemoteId, seriesId)}/instances?${query}`)
    for (const e of list.items ?? []) {
      const at = e.originalStartTime
      if (e.status === 'cancelled' && at) starts.push(Date.parse(at.dateTime ?? at.date + 'T00:00:00Z'))
    }
    page = list.nextPageToken
  } while (page)
  return starts
}

// The recurrence lines a series write sends. The rule is always written again from the plan, so its UNTIL fits the new
// start time: an old UNTIL time would drop the last event or bring back a cut one. Deleted events from the plan's
// old start on (EXDATE lines and cancelled events) move with the series' start, so they stay deleted. A rule of
// another kind (weekly to monthly, "first Tuesday" to "last Tuesday") makes other events: a deleted date stays only when
// it keeps its own day and the new rule makes that day, so it hides no new event. Only dates the old rule
// makes count: a stray one (from another app) would be mapped onto a real event.
async function recurrenceOf(
  deps: GoogleDeps,
  calendarRemoteId: string,
  master: GoogleEvent,
  plan: ReturnType<typeof seriesPlan>,
  windowEnd: number
): Promise<string[]> {
  const since = plan.old.start
  const lines = master.recurrence ?? []
  // A rule the app cannot read cannot be written again, and its other lines (RDATE) would not move.
  if (plan.rule === null) throw new Error('The app cannot change this repeat rule. Change it in Google Calendar.')
  const wkst = ruleParts(lines).get('WKST')
  const rule = toRrule(plan.rule, plan.next) + (wkst ? `;WKST=${wkst}` : '')
  const cancelled = await cancelledStarts(deps, calendarRemoteId, master.id, since, windowEnd)
  const gone = [...new Set([...exdates(lines, plan.old.zone), ...cancelled])].filter((t) => t >= since)
  const { first, repeat: old } = seriesOf(master)
  const r = plan.rule
  const sameKind = old !== null && old.freq === r.freq && old.monthly === r.monthly
  const week = weekStartOf(wkst)
  const day = (t: number, f: First): string => dayOf({ start: t, allDay: f.allDay }, f.zone).date
  const moved = gone
    .filter((t) => old === null || makesDay(old, first, t, week))
    .map((t) => [t, shiftStart(t, plan.old, plan.next, sameKind ? r : null)])
    .filter(([t, s]) => sameKind || (day(t, plan.old) === day(s, plan.next) && makesDay(r, plan.next, s, week)))
    .map(([, s]) => s)
    .sort((a, b) => a - b)
  return moved.length > 0 ? [rule, exdateLine(moved, plan.next.allDay)] : [rule]
}

// The guests an attendee list has, for "only when guests are unchanged": emails and optional flags, not answers.
const guestsOf = (e: GoogleEvent): string => JSON.stringify((e.attendees ?? []).map((a) => [a.email?.toLowerCase(), !!a.optional]))

// "This and following" or "All events" for one event of the user's own series. newId: the new series' id for a split
// (splitId). windowEnd: deleted events are read up to the end of the synced dates. Returns the series after the write.
export async function updateGoogleSeries(
  deps: GoogleDeps,
  calendarRemoteId: string,
  record: EventRecord,
  change: EventChange,
  scope: 'following' | 'series',
  newId: string,
  windowEnd: number
): Promise<EventRecord> {
  const url = (id: string, query?: string): string => eventUrl(calendarRemoteId, id, query)
  try {
    // Fresh copies: a shown change to this event since the last sync is a conflict, and the series decides the rest.
    const instance = toRecord(await googleRequest<GoogleEvent>(deps, url(record.remoteId)))
    if (SHOWN.some((k) => instance[k] !== record[k])) throw new ConflictError(instance)
    const master = await googleRequest<GoogleEvent>(deps, url(record.seriesRemoteId!))
    // Google calls an event without guests the user's own, also when someone else made it.
    if (master.organizer?.self !== true || master.status === 'cancelled') throw new Error('Only the organizer can change all events.')
    const { first, repeat } = seriesOf(master)
    const weekStart = weekStartOf(ruleParts(master.recurrence ?? []).get('WKST'))
    const plan = seriesPlan({ master: toRecord(master), zone: first.zone, repeat, weekStart, instance, change, scope })
    // Google needs the zone of a timed series, also when only the time changed.
    const zones = plan.times.allDay ? {} : { timeZone: plan.next.zone, endTimeZone: change.endTimeZone ?? master.end?.timeZone ?? plan.next.zone }
    const times = change.times || scope === 'following' ? { times: plan.times, ...zones } : {}
    const send = sendUpdates(toRecord(master), change)
    if (scope === 'series') {
      const patch = async (latest: GoogleEvent): Promise<EventRecord> => {
        const out = body({ ...change, ...times }, latest)
        if (plan.rewrite || plan.moved) out.recurrence = await recurrenceOf(deps, calendarRemoteId, latest, plan, windowEnd)
        const query = send + conferenceFlag(out) + labelFlag(out)
        const updated = await googleRequest<GoogleEvent>(deps, url(latest.id, query), { method: 'PATCH', body: out, headers: { 'If-Match': latest.etag! } })
        return toRecord((await colorIdPatch(deps, url(latest.id, 'sendUpdates=none'), updated, change)) ?? updated)
      }
      try {
        return await patch(master)
      } catch (error) {
        // A guest's answer also changes the series. Once more on the new copy, only when the times and rule the plan was
        // made from are the same; else a conflict.
        if (!(error instanceof GoogleHttpError) || error.status !== 412) throw error
        const latest = await googleRequest<GoogleEvent>(deps, url(master.id))
        const same = (['start', 'end', 'recurrence'] as const).every((k) => JSON.stringify(latest[k]) === JSON.stringify(master[k]))
        if (!same) throw new ConflictError(instance)
        return await patch(latest)
      }
    }
    return await splitSeries(deps, calendarRemoteId, master, instance, change, plan, { newId, windowEnd, send, times })
  } catch (error) {
    if (!(error instanceof GoogleHttpError)) throw error
    if (error.status === 404 || error.status === 410) throw new Error('This event no longer exists.', { cause: error })
    if (error.status !== 412) throw error
    throw new ConflictError(toRecord(await googleRequest<GoogleEvent>(deps, url(record.remoteId))))
  }
}

// "This and following": the new series first, then the old one ends before this event (D-2). Order and retries keep
// every event: a failed POST changes nothing, and a cut that surely failed deletes the new series again (rollback).
async function splitSeries(
  deps: GoogleDeps,
  calendarRemoteId: string,
  master: GoogleEvent,
  instance: EventRecord,
  change: EventChange,
  plan: ReturnType<typeof seriesPlan>,
  o: { newId: string; windowEnd: number; send: string; times: Partial<EventChange> }
): Promise<EventRecord> {
  const url = (id: string, query?: string): string => eventUrl(calendarRemoteId, id, query)
  const cut = instance.originalStart ?? instance.start
  const raw = master as unknown as Record<string, unknown>
  const copy = Object.fromEntries(COPIED.filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]]))
  const out: Record<string, unknown> = { ...copy, ...body({ ...change, ...o.times }, master), id: o.newId }
  out.recurrence = await recurrenceOf(deps, calendarRemoteId, master, plan, o.windowEnd)
  // A taken-off label is just none on the new series; without the flag Google then reads colorId.
  if (out.eventLabelId === '') delete out.eventLabelId
  const title = (out.summary as string | undefined) ?? ''
  const query = o.send + conferenceFlag(out) + labelFlag(out)
  let created: GoogleEvent
  try {
    created = await googleRequest<GoogleEvent>(deps, eventUrl(calendarRemoteId, undefined, query), { method: 'POST', body: out })
  } catch (error) {
    // A re-run with a fresh token posts the same id again: safe.
    if (error instanceof GoogleAuthError) throw error
    // A clear answer other than 409: nothing was made.
    if (error instanceof GoogleHttpError && error.status !== 409 && error.status < 500) throw error
    // 409 (our id exists), a server error or no answer: read our id to know.
    let existing: GoogleEvent
    try {
      existing = await googleRequest<GoogleEvent>(deps, url(o.newId))
    } catch (readError) {
      if (readError instanceof GoogleAuthError) throw readError
      if (readError instanceof GoogleHttpError && (readError.status === 404 || readError.status === 410)) throw error
      throw new Error(twice(title, plan.next.start, plan.next.zone, 'Google Calendar'), { cause: readError })
    }
    // Google keeps a deleted id. A cancelled copy is a split that was undone: never end the old series then.
    if (existing.status === 'cancelled') throw new Error('This split was undone before. Change these events in Google Calendar.', { cause: error })
    created = existing
  }
  // Google answers 412 when the series changed since the copy the If-Match names.
  const end = (latest: GoogleEvent): Promise<unknown> =>
    googleRequest(deps, url(latest.id, o.send), {
      method: 'PATCH',
      body: { recurrence: cutRrule(latest.recurrence ?? [], cut, instance.allDay, plan.old.zone) },
      headers: { 'If-Match': latest.etag! }
    })
  try {
    try {
      await end(master)
    } catch (error) {
      // Once more on a fresh copy, only when the title, times, rule and guests the new series copied are the same.
      if (!(error instanceof GoogleHttpError) || error.status !== 412) throw error
      const latest = await googleRequest<GoogleEvent>(deps, url(master.id))
      const same = (['summary', 'start', 'end', 'recurrence'] as const).every((k) => JSON.stringify(latest[k]) === JSON.stringify(master[k]))
      if (!same || guestsOf(latest) !== guestsOf(master)) throw error
      await end(latest)
    }
  } catch (error) {
    // A re-run with a fresh token finds the new series by its id and ends the old one: no rollback.
    if (error instanceof GoogleAuthError) throw error
    // No answer or a server error: the cut may be done, and a rollback would then lose every following event.
    // Only a clear 4xx says it was not made; else read the series to know. Only the old rule, as it was, is safe to roll
    // back; our cut is done; anything else (another form, someone's change) keeps both.
    if (!(error instanceof GoogleHttpError && error.status < 500)) {
      const unknown = (cause: unknown): Error => new Error(twice(title, plan.next.start, plan.next.zone, 'Google Calendar'), { cause })
      let latest: GoogleEvent
      try {
        latest = await googleRequest<GoogleEvent>(deps, url(master.id))
      } catch (readError) {
        throw unknown(readError)
      }
      const rule = JSON.stringify(latest.recurrence ?? [])
      if (rule === JSON.stringify(cutRrule(master.recurrence ?? [], cut, instance.allDay, plan.old.zone))) return toRecord(created)
      if (rule !== JSON.stringify(master.recurrence ?? [])) throw unknown(error)
    }
    try {
      await googleRequest(deps, url(o.newId, o.send), { method: 'DELETE' })
    } catch (rollbackError) {
      throw new Error(twice(title, plan.next.start, plan.next.zone, 'Google Calendar'), { cause: rollbackError })
    }
    // A plain error, never an auth error: a re-run after a rollback would find the deleted copy.
    throw new Error(`Could not change this and following events. ${error instanceof Error ? error.message : ''}`.trim(), { cause: error })
  }
  return toRecord(created)
}

// "All events" deletes the series; "This and following" ends it before this event. Guests hear about it from the
// series' own guest list. notify false: no cancellations.
export async function deleteGoogleSeries(
  deps: GoogleDeps,
  calendarRemoteId: string,
  record: EventRecord,
  scope: 'following' | 'series',
  notify?: boolean
): Promise<void> {
  const url = (query?: string): string => eventUrl(calendarRemoteId, record.seriesRemoteId!, query)
  let master: GoogleEvent
  try {
    master = await googleRequest<GoogleEvent>(deps, url())
  } catch (error) {
    // Already gone counts as done.
    if (error instanceof GoogleHttpError && (error.status === 404 || error.status === 410)) return
    throw error
  }
  if (master.status === 'cancelled') return
  if (master.organizer?.self !== true) throw new Error('Only the organizer can delete all events.')
  if (scope === 'series') return deleteGoogleEvent(deps, calendarRemoteId, toRecord(master), notify)
  const { first, repeat } = seriesOf(master)
  const date = (t: number): string => dayOf({ start: t, allDay: record.allDay }, first.zone).date
  const cut = record.originalStart ?? record.start
  // Not on the first event (that is all events), and not on a rule the app cannot read.
  if (!scopeChoices({ repeat, firstDate: date(first.start), from: date(cut), to: date(cut) }).includes('following')) {
    throw new Error('The series was changed somewhere else. Try again.')
  }
  try {
    await googleRequest(deps, url(sendUpdates(toRecord(master), { notify })), {
      method: 'PATCH',
      body: { recurrence: cutRrule(master.recurrence ?? [], cut, record.allDay, first.zone) },
      headers: { 'If-Match': master.etag! }
    })
  } catch (error) {
    if (!(error instanceof GoogleHttpError) || error.status !== 412) throw error
    throw new Error('The series was changed somewhere else. Try again.', { cause: error })
  }
}

// notify false: guests get no cancellation.
export async function deleteGoogleEvent(deps: GoogleDeps, calendarRemoteId: string, record: EventRecord, notify?: boolean): Promise<void> {
  try {
    await googleRequest(deps, eventUrl(calendarRemoteId, record.remoteId, sendUpdates(record, { notify })), { method: 'DELETE' })
  } catch (error) {
    // Already gone counts as done.
    if (!(error instanceof GoogleHttpError) || (error.status !== 404 && error.status !== 410)) throw error
  }
}

// Answers a meeting someone else organizes, and tells the organizer. remoteId: an event, or a series for all its events.
// With attendeesOmitted Google changes only our own entry, so no If-Match is needed: other answers cannot be lost.
export async function respondGoogleEvent(
  deps: GoogleDeps,
  calendarRemoteId: string,
  remoteId: string,
  email: string,
  answer: Answer
): Promise<EventRecord> {
  try {
    const updated = await googleRequest<GoogleEvent>(deps, eventUrl(calendarRemoteId, remoteId, 'sendUpdates=all'), {
      method: 'PATCH',
      body: { attendeesOmitted: true, attendees: [{ email, responseStatus: answer }] }
    })
    return toRecord(updated)
  } catch (error) {
    if (!(error instanceof GoogleHttpError) || (error.status !== 404 && error.status !== 410)) throw error
    throw new Error('This event no longer exists.', { cause: error })
  }
}
