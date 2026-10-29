import type { CalendarEvent, EventDetails, Guest, Provider, Range, Response, SearchResult, Settings, ShowAs } from '../../shared/api'
import { GOOGLE_COLORS, OUTLOOK_COLORS } from '../../shared/colors'
import { isPerson } from '../../shared/events'
import { ALL_DAY_SLACK } from '../../shared/reminders'
import { canonicalZone, ianaZone, isZone } from '../../shared/zones'
import type { Db } from './db'
import { effectiveReminders } from './reminders'
import { getSettings } from './settings'

export type EventKind = 'single' | 'occurrence' | 'exception' | 'master'

// An event as providers deliver it, before it has a local id.
export interface EventRecord {
  remoteId: string
  kind: EventKind
  seriesRemoteId: string | null
  icalUid: string | null
  version: string | null
  title: string
  start: number
  end: number
  allDay: boolean
  startDate: string | null
  endDate: string | null
  startTz: string | null
  // The provider's end zone. null: the start zone.
  endTz: string | null
  location: string
  joinUrl: string | null
  description: string
  showAs: ShowAs
  response: Response
  isOrganizer: boolean
  attendeeCount: number
  cancelled: boolean
  // Minutes before the start. null: the calendar's default reminders.
  reminders: number[] | null
  attendees: Guest[]
  organizerEmail: string | null
  organizerName: string | null
  // Google cut the list, or an Outlook organizer hid it.
  attendeesOmitted: boolean
  // Outlook only. null: Google.
  responseRequested: boolean | null
  // Google only, with Google's defaults filled in. null: Outlook.
  guestsCanModify: boolean | null
  guestsCanInviteOthers: boolean | null
  guestsCanSeeOtherGuests: boolean | null
  // Google: changes stay in this copy.
  privateCopy: boolean
  colorId: string | null
  eventLabelId: string | null
  // Outlook category names.
  categories: string[]
  // Start of this instance before any move.
  originalStart: number | null
  // Outlook masters only: the provider's rule as JSON text.
  recurrence: string | null
  // Full Outlook body as text. null: Google (the description is already full).
  body: string | null
  webLink: string | null
}

interface EventRow {
  id: number
  calendar_id: number
  remote_id: string
  kind: EventKind
  series_remote_id: string | null
  ical_uid: string | null
  version: string | null
  title: string
  start_utc: number
  end_utc: number
  all_day: number
  start_date: string | null
  end_date: string | null
  start_tz: string | null
  end_tz: string | null
  location: string
  join_url: string | null
  description: string
  show_as: ShowAs
  response: Response
  is_organizer: number
  attendee_count: number
  cancelled: number
  reminders: string | null
  attendees: string
  organizer_email: string | null
  organizer_name: string | null
  attendees_omitted: number
  response_requested: number | null
  guests_can_modify: number | null
  guests_can_invite_others: number | null
  guests_can_see_other_guests: number | null
  private_copy: number
  color_id: string | null
  event_label_id: string | null
  categories: string
  original_start: number | null
  recurrence: string | null
  body: string | null
  web_link: string | null
}

// With the calendar's defaults and the user's own reminders, to work out the reminders that fire, and the
// account's category colors.
interface ShownRow extends Pick<
  EventRow,
  | 'id'
  | 'calendar_id'
  | 'remote_id'
  | 'version'
  | 'series_remote_id'
  | 'title'
  | 'start_utc'
  | 'end_utc'
  | 'all_day'
  | 'start_date'
  | 'end_date'
  | 'location'
  | 'join_url'
  | 'description'
  | 'show_as'
  | 'response'
  | 'is_organizer'
  | 'guests_can_modify'
  | 'attendee_count'
  | 'cancelled'
  | 'reminders'
  | 'color_id'
  | 'event_label_id'
  | 'categories'
> {
  // The color of the event's label. null: no label, or one this calendar's labels do not have.
  label_color: string | null
  default_reminders: string
  master_categories: string | null
  custom: string | null
  custom_all_day: number | null
  synced: string | null
}

// The event with what toEvent needs. Named columns: the guest list and the body can be large, and views never
// show them (getEventDetails reads them).
const SHOWN = `SELECT e.id, e.calendar_id, e.remote_id, e.version, e.series_remote_id, e.title, e.start_utc, e.end_utc,
    e.all_day, e.start_date, e.end_date, e.location, e.join_url, e.description, e.show_as, e.response, e.is_organizer,
    e.guests_can_modify, e.attendee_count, e.cancelled, e.reminders, e.color_id, e.event_label_id, e.categories,
    l.color AS label_color, c.default_reminders, a.categories AS master_categories,
    iif(r.remote_id IS NULL, s.reminders, r.reminders) AS custom,
    iif(r.remote_id IS NULL, s.synced, r.synced) AS synced, iif(r.remote_id IS NULL, s.all_day, r.all_day) AS custom_all_day
  FROM events e
  JOIN calendars c ON c.id = e.calendar_id
  JOIN accounts a ON a.id = c.account_id
  LEFT JOIN labels l ON l.calendar_id = e.calendar_id AND l.id = e.event_label_id
  LEFT JOIN event_reminders r ON r.calendar_id = e.calendar_id AND r.remote_id = e.remote_id
  -- "All events" reminders. The event's own row wins.
  LEFT JOIN event_reminders s ON s.calendar_id = e.calendar_id AND s.remote_id = e.series_remote_id`

// Text match for one word (?N, replaced by the word's number): title, location, the full body (Outlook) or the
// description, the organizer, and each guest's name or email. The raw guest JSON is only a fast first check, with
// the word as JSON writes it (?J: " and \ get a \ in front); json_each decides, so words like "email" do not match
// every event.
const MATCH = `(e.title LIKE ?N ESCAPE '\\' OR e.location LIKE ?N ESCAPE '\\'
    OR COALESCE(e.body, e.description) LIKE ?N ESCAPE '\\' OR e.organizer_name LIKE ?N ESCAPE '\\'
    OR e.organizer_email LIKE ?N ESCAPE '\\'
    OR (e.attendees LIKE ?J ESCAPE '\\' AND EXISTS (SELECT 1 FROM json_each(e.attendees) g
      WHERE g.value ->> 'name' LIKE ?N ESCAPE '\\' OR g.value ->> 'email' LIKE ?N ESCAPE '\\')))`

// Each word reads every guest list again, so main stays free only with a few words.
const MAX_WORDS = 10

// Upsert keeps the local id stable, so reminder acks and open popovers survive a re-sync.
export function upsertEvents(db: Db, calendarId: number, records: EventRecord[], generation: number): void {
  const stmt = db.prepare(`
    INSERT INTO events (calendar_id, remote_id, kind, series_remote_id, ical_uid, version, title, start_utc, end_utc,
      all_day, start_date, end_date, start_tz, location, join_url, description, show_as, response, is_organizer,
      attendee_count, cancelled, reminders, generation, attendees, organizer_email, organizer_name, attendees_omitted,
      response_requested, guests_can_modify, guests_can_invite_others, guests_can_see_other_guests, private_copy,
      color_id, event_label_id, categories, original_start, recurrence, body, web_link, end_tz)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (calendar_id, remote_id) DO UPDATE SET
      kind = excluded.kind, series_remote_id = excluded.series_remote_id, ical_uid = excluded.ical_uid,
      version = excluded.version, title = excluded.title, start_utc = excluded.start_utc, end_utc = excluded.end_utc,
      all_day = excluded.all_day, start_date = excluded.start_date, end_date = excluded.end_date,
      start_tz = excluded.start_tz, location = excluded.location, join_url = excluded.join_url,
      description = excluded.description, show_as = excluded.show_as, response = excluded.response,
      is_organizer = excluded.is_organizer, attendee_count = excluded.attendee_count, cancelled = excluded.cancelled,
      reminders = excluded.reminders, generation = excluded.generation, attendees = excluded.attendees,
      organizer_email = excluded.organizer_email, organizer_name = excluded.organizer_name,
      attendees_omitted = excluded.attendees_omitted, response_requested = excluded.response_requested,
      guests_can_modify = excluded.guests_can_modify, guests_can_invite_others = excluded.guests_can_invite_others,
      guests_can_see_other_guests = excluded.guests_can_see_other_guests, private_copy = excluded.private_copy,
      color_id = excluded.color_id, event_label_id = excluded.event_label_id, categories = excluded.categories,
      original_start = excluded.original_start, recurrence = excluded.recurrence, body = excluded.body,
      web_link = excluded.web_link, end_tz = excluded.end_tz
  `)
  // The people of these events, once each: a full sync sees the same people in many events.
  const people = new Map<string, { name: string | null; seen: number }>()
  const see = (email: string | null, name: string | null | undefined, seen: number): void => {
    if (!email || !isPerson(email)) return
    const old = people.get(email.toLowerCase())
    people.set(email.toLowerCase(), { name: name || old?.name || null, seen: Math.max(seen, old?.seen ?? seen) })
  }
  for (const r of records) {
    stmt.run(
      calendarId, r.remoteId, r.kind, r.seriesRemoteId, r.icalUid, r.version, r.title, r.start, r.end,
      r.allDay ? 1 : 0, r.startDate, r.endDate, r.startTz, r.location, r.joinUrl, r.description, r.showAs,
      r.response, r.isOrganizer ? 1 : 0, r.attendeeCount, r.cancelled ? 1 : 0,
      r.reminders === null ? null : JSON.stringify(r.reminders), generation, JSON.stringify(r.attendees),
      r.organizerEmail, r.organizerName, r.attendeesOmitted ? 1 : 0, bit(r.responseRequested), bit(r.guestsCanModify),
      bit(r.guestsCanInviteOthers), bit(r.guestsCanSeeOtherGuests), r.privateCopy ? 1 : 0, r.colorId, r.eventLabelId,
      JSON.stringify(r.categories), r.originalStart, r.recurrence, r.body, r.webLink, r.endTz
    )
    for (const g of r.attendees) if (!g.resource) see(g.email, g.name, r.start)
    // Only the organizer of a meeting: a holiday or other shared calendar is no person.
    if (r.attendees.length > 0) see(r.organizerEmail, r.organizerName, r.start)
  }
  const person = db.prepare(
    `INSERT INTO people (account_id, email, name, last_seen) SELECT account_id, ?, ?, ? FROM calendars WHERE id = ?
     ON CONFLICT (account_id, email) DO UPDATE SET name = COALESCE(excluded.name, name), last_seen = MAX(last_seen, excluded.last_seen)`
  )
  for (const [email, p] of people) person.run(email, p.name, p.seen, calendarId)
}

// SQLite has no booleans. null stays null.
const bit = (value: boolean | null): number | null => (value === null ? null : value ? 1 : 0)
const flag = (value: number | null): boolean | null => (value === null ? null : value === 1)

// Deletes events by remote id. An id that names a series also deletes all its instances, and its "All events"
// reminders (the events' own ones go by the trigger in db.ts).
export function deleteEvents(db: Db, calendarId: number, remoteIds: string[]): void {
  const stmt = db.prepare('DELETE FROM events WHERE calendar_id = ? AND (remote_id = ? OR series_remote_id = ?)')
  const reminders = db.prepare('DELETE FROM event_reminders WHERE calendar_id = ? AND remote_id = ?')
  for (const id of remoteIds) {
    stmt.run(calendarId, id, id)
    reminders.run(calendarId, id)
  }
}

// "This and following": drops the series' events from the cut on (by where the rule put them) before the sync
// confirms it, so the old copies do not show next to the new series.
export function deleteSeriesInstancesFrom(db: Db, calendarId: number, seriesRemoteId: string, from: number): void {
  db.prepare('DELETE FROM events WHERE calendar_id = ? AND series_remote_id = ? AND coalesce(original_start, start_utc) >= ?').run(
    calendarId,
    seriesRemoteId,
    from
  )
}

// After a series refresh: drop instances the provider no longer returns.
export function deleteSeriesInstancesExcept(db: Db, calendarId: number, seriesRemoteId: string, keep: string[]): void {
  const rows = db
    .prepare('SELECT remote_id FROM events WHERE calendar_id = ? AND series_remote_id = ?')
    .all(calendarId, seriesRemoteId) as { remote_id: string }[]
  const keepSet = new Set(keep)
  const stmt = db.prepare('DELETE FROM events WHERE calendar_id = ? AND remote_id = ?')
  for (const row of rows) if (!keepSet.has(row.remote_id)) stmt.run(calendarId, row.remote_id)
}

// After a full sync: rows not seen in this generation are gone remotely.
export function sweepEvents(db: Db, calendarId: number, generation: number): void {
  db.prepare('DELETE FROM events WHERE calendar_id = ? AND generation < ?').run(calendarId, generation)
}

export function getRecord(db: Db, calendarId: number, remoteId: string): EventRecord | null {
  const row = db.prepare('SELECT * FROM events WHERE calendar_id = ? AND remote_id = ?').get(calendarId, remoteId) as
    | EventRow
    | undefined
  return row ? toRecord(row) : null
}

// The stored events of a series that have their own changes.
export function listSeriesExceptions(db: Db, calendarId: number, seriesRemoteId: string): EventRecord[] {
  const rows = db
    .prepare("SELECT * FROM events WHERE calendar_id = ? AND series_remote_id = ? AND kind = 'exception'")
    .all(calendarId, seriesRemoteId) as unknown as EventRow[]
  return rows.map(toRecord)
}

export function getEvent(db: Db, id: number): (CalendarEvent & { remoteId: string; version: string | null }) | null {
  const row = db.prepare(`${SHOWN} WHERE e.id = ?`).get(id) as ShownRow | undefined
  return row ? { ...toEvent(row, getSettings(db)), remoteId: row.remote_id, version: row.version } : null
}

export function getEventByRemoteId(db: Db, calendarId: number, remoteId: string): CalendarEvent | null {
  const row = db.prepare(`${SHOWN} WHERE e.calendar_id = ? AND e.remote_id = ?`).get(calendarId, remoteId) as
    | ShownRow
    | undefined
  return row ? toEvent(row, getSettings(db)) : null
}

// For the popover. Only the provider's list is stored, so this adds what it leaves out: the organizer (missing on
// the organizer's own copy) and the user's own answer (an Outlook guest copy keeps "None" in the list).
export function getEventDetails(db: Db, id: number): EventDetails | null {
  const row = db
    .prepare(
      `SELECT e.attendees, e.organizer_email, e.organizer_name, e.attendees_omitted, e.guests_can_modify,
         e.guests_can_invite_others, e.guests_can_see_other_guests, e.is_organizer, e.response, e.body, e.web_link,
         e.start_tz, e.end_tz, e.all_day, a.email, a.provider
       FROM events e JOIN calendars c ON c.id = e.calendar_id JOIN accounts a ON a.id = c.account_id WHERE e.id = ?`
    )
    .get(id) as
    | (Pick<
        EventRow,
        | 'attendees'
        | 'organizer_email'
        | 'organizer_name'
        | 'attendees_omitted'
        | 'guests_can_modify'
        | 'guests_can_invite_others'
        | 'guests_can_see_other_guests'
        | 'is_organizer'
        | 'response'
        | 'body'
        | 'web_link'
        | 'start_tz'
        | 'end_tz'
        | 'all_day'
      > & { email: string; provider: Provider })
    | undefined
  if (!row) return null
  // Outlook gives Windows names; a timed Outlook event in UTC was the app's own old write, not the user's choice (see
  // outlook/write.ts). Zones the picker does not list count as none.
  const zone = (tz: string | null): string | null => {
    const iana = tz === null ? undefined : canonicalZone(ianaZone(tz) ?? tz)
    return isZone(iana) && !(row.provider === 'outlook' && tz === 'UTC') ? iana : null
  }
  const same = (a: string | null, b: string | null): boolean =>
    !!a && !!b && a.toLowerCase() === b.toLowerCase()
  // The mappers set the organizer flag.
  const all = JSON.parse(row.attendees) as Guest[]
  const guests = all.filter((g) => !g.resource)
  // On a guest copy, an organizer not in the list is not a guest (a group calendar, say), like Google shows it.
  if (
    row.is_organizer === 1 &&
    guests.length > 0 &&
    !guests.some((g) => g.organizer) &&
    row.organizer_email
  ) {
    guests.unshift({
      email: row.organizer_email,
      name: row.organizer_name ?? undefined,
      response: 'accepted',
      organizer: true
    })
  }
  const own = row.response === 'organizer' ? 'accepted' : row.response
  // Google marks self itself, and on a shared calendar self is the calendar's owner, not the user. Outlook never does.
  const marked = all.some((g) => g.self)
  // Organizer first, then required, then optional, like Google. The sort keeps the provider's order inside each group.
  const rank = (g: Guest): number => (g.organizer ? 0 : g.optional ? 2 : 1)
  return {
    guests: guests
      .map((g) =>
        !marked && same(g.email, row.email) ? { ...g, self: true as const, response: own } : g
      )
      .sort((a, b) => rank(a) - rank(b)),
    rooms: all.filter((g) => g.resource),
    // A hidden list still shows to the organizer.
    guestsOmitted:
      row.attendees_omitted === 1 ||
      (row.guests_can_see_other_guests === 0 && row.is_organizer === 0),
    body: row.body,
    webLink: row.web_link,
    guestsCanModify: flag(row.guests_can_modify),
    guestsCanInviteOthers: flag(row.guests_can_invite_others),
    guestsCanSeeOtherGuests: flag(row.guests_can_see_other_guests),
    timeZone: row.all_day ? null : zone(row.start_tz),
    endTimeZone: row.all_day ? null : zone(row.end_tz ?? row.start_tz)
  }
}

// Events of visible calendars that overlap the range. The caller filters all-day rows by date.
export function listEventsInRange(db: Db, range: Range): CalendarEvent[] {
  const { d } = db.prepare('SELECT MAX(end_utc - start_utc) AS d FROM events').get() as { d: number | null }
  const start = range.start - ALL_DAY_SLACK
  const end = range.end + ALL_DAY_SLACK
  const rows = db
    .prepare(
      `${SHOWN}
       WHERE e.start_utc >= ? AND e.start_utc < ? AND e.end_utc > ?
         AND e.kind != 'master' AND c.visible = 1
       ORDER BY e.start_utc, e.end_utc DESC`
    )
    .all(start - (d ?? 0), end, start) as unknown as ShownRow[]
  const settings = getSettings(db)
  return rows.map((row) => toEvent(row, settings))
}

// Events of visible calendars with every word of text somewhere, in any case, also inside a word. The max closest to
// now, by start. A full scan: no index serves LIKE '%x%'. more: there were more than max.
export function searchEvents(db: Db, text: string, now: number, max: number): SearchResult {
  // LIKE ignores only the case of A-Z, so only that case makes two words the same.
  const words = [...new Map(text.trim().split(/\s+/).map((w) => [w.replace(/[A-Z]/g, (c) => c.toLowerCase()), w])).values()].slice(
    0,
    MAX_WORDS
  )
  // % and _ match only themselves.
  const like = (w: string): string => `%${w.replace(/[\\%_]/g, '\\$&')}%`
  // Two values per word: ?N as typed, ?J as JSON writes it.
  const params = words.flatMap((w) => [like(w), like(JSON.stringify(w).slice(1, -1))])
  const n = params.length
  const settings = getSettings(db)
  // Declined events are left out here, not in the renderer, so they never take one of the max places.
  const rows = db
    .prepare(
      `${SHOWN}
       WHERE e.kind != 'master' AND c.visible = 1 AND (?${n + 1} OR e.response != 'declined')
         AND ${words.map((_, i) => MATCH.replaceAll('?N', `?${2 * i + 1}`).replaceAll('?J', `?${2 * i + 2}`)).join(' AND ')}
       ORDER BY ABS(e.start_utc - ?${n + 2}) LIMIT ?${n + 3}`
    )
    .all(...params, settings.showDeclined ? 1 : 0, now, max + 1) as unknown as ShownRow[]
  return {
    events: rows
      .slice(0, max)
      .sort((a, b) => a.start_utc - b.start_utc || b.end_utc - a.end_utc)
      .map((row) => toEvent(row, settings)),
    more: rows.length > max
  }
}

// Everyone seen in the account's events, newest first, without the user. The renderer filters as the user types.
// is_person also here: rows stored before the rule existed (early test databases) are not suggested either.
export function listPeople(db: Db, accountId: number, ownEmail: string): Pick<Guest, 'email' | 'name'>[] {
  const rows = db
    .prepare('SELECT email, name FROM people WHERE account_id = ? AND email != lower(?) AND is_person(email) ORDER BY last_seen DESC')
    .all(accountId, ownEmail) as { email: string; name: string | null }[]
  return rows.map((r) => (r.name ? { email: r.email, name: r.name } : { email: r.email }))
}

function toEvent(row: ShownRow, settings: Settings): CalendarEvent {
  // Google: the event's label (its new colors; Google says it wins over colorId), else the classic color id (also all a
  // sign-in without the labels scope can show). Outlook: the first category, in the color the mailbox gives it now (a
  // color change there changes no event, so it is not stored). Unknown: the calendar's color.
  let color = row.label_color ?? (row.color_id === null ? null : (GOOGLE_COLORS[row.color_id] ?? null))
  let colorKey = row.label_color !== null ? row.event_label_id : color === null ? null : row.color_id
  if (row.categories !== '[]' && row.master_categories !== null) {
    const first = (JSON.parse(row.categories) as string[])[0]
    const preset = (JSON.parse(row.master_categories) as Record<string, string>)[first]
    color = OUTLOOK_COLORS[preset] ?? null
    // Every preset is a color in Outlook, also one the app has no hex for (it shows the calendar's).
    colorKey = preset?.startsWith('Preset') ? first : null
  }
  return {
    id: row.id,
    calendarId: row.calendar_id,
    title: row.title,
    start: row.start_utc,
    end: row.end_utc,
    allDay: row.all_day === 1,
    startDate: row.start_date,
    endDate: row.end_date,
    location: row.location,
    joinUrl: row.join_url,
    description: row.description,
    showAs: row.show_as,
    response: row.response,
    isOrganizer: row.is_organizer === 1,
    // Outlook stores null.
    guestsCanModify: row.guests_can_modify === 1,
    attendeeCount: row.attendee_count,
    seriesRemoteId: row.series_remote_id,
    cancelled: row.cancelled === 1,
    reminders: effectiveReminders(row, settings),
    color,
    colorKey
  }
}

function toRecord(row: EventRow): EventRecord {
  return {
    remoteId: row.remote_id,
    kind: row.kind,
    seriesRemoteId: row.series_remote_id,
    icalUid: row.ical_uid,
    version: row.version,
    title: row.title,
    start: row.start_utc,
    end: row.end_utc,
    allDay: row.all_day === 1,
    startDate: row.start_date,
    endDate: row.end_date,
    startTz: row.start_tz,
    endTz: row.end_tz,
    location: row.location,
    joinUrl: row.join_url,
    description: row.description,
    showAs: row.show_as,
    response: row.response,
    isOrganizer: row.is_organizer === 1,
    attendeeCount: row.attendee_count,
    cancelled: row.cancelled === 1,
    reminders: row.reminders === null ? null : (JSON.parse(row.reminders) as number[]),
    attendees: JSON.parse(row.attendees) as Guest[],
    organizerEmail: row.organizer_email,
    organizerName: row.organizer_name,
    attendeesOmitted: row.attendees_omitted === 1,
    responseRequested: flag(row.response_requested),
    guestsCanModify: flag(row.guests_can_modify),
    guestsCanInviteOthers: flag(row.guests_can_invite_others),
    guestsCanSeeOtherGuests: flag(row.guests_can_see_other_guests),
    privateCopy: row.private_copy === 1,
    colorId: row.color_id,
    eventLabelId: row.event_label_id,
    categories: JSON.parse(row.categories) as string[],
    originalStart: row.original_start,
    recurrence: row.recurrence,
    body: row.body,
    webLink: row.web_link
  }
}
