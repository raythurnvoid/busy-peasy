import type { EventReminder, Reminder, Reminders, ReminderStage, Settings } from '../../shared/api'
import { ALL_DAY_SLACK, MAX_REMINDER_MINUTES, allDayFireAt, mergeReminders } from '../../shared/reminders'
import { listStaleAccounts } from './accounts'
import type { Db } from './db'
import { getSettings } from './settings'

const MIN = 60_000
const LATE_AFTER = 10 * MIN
const DAY = 24 * 60 * MIN
// No good sync for this long: say the reminders may be wrong.
const STALE_AFTER = 15 * MIN

// What effectiveReminders reads: the provider's minutes (NULL: the calendar's defaults) and the user's own list.
interface ReminderSource {
  all_day: number
  reminders: string | null
  default_reminders: string
  custom: string | null
  // The kind of event the own list was made for (1: all-day).
  custom_all_day: number | null
  synced: string | null
  join_url: string | null
  attendee_count: number
}

// An own list counts only for the kind of event it was made for: Google or Outlook can turn a timed event all-day.
const hasOwn = (row: ReminderSource): boolean => row.custom !== null && row.custom_all_day === row.all_day

interface ReminderRow extends ReminderSource {
  id: number
  calendar_id: number
  account_id: number
  remote_id: string
  ical_uid: string | null
  title: string
  start_utc: number
  end_utc: number
  start_date: string | null
  end_date: string | null
  location: string
  response: string
  dismissed_through: number | null
  snoozed_until: number | null
  // Set by candidates(): for all-day rows local midnight of start_date and end_date, and the end of the first day.
  start: number
  end: number
  last: number
}

// The reminders that fire for one event, earliest first.
// Without the user's own list: the provider's reminders as notifications, plus the default ones from the settings.
// With it: the user's list, but changes made in Google or Outlook since it was saved still win. A reminder removed
// there goes, one added there comes, and reminders only this app has (not in synced) stay.
// All-day events get the all-day defaults only: Google's calendar defaults are for timed events.
export function effectiveReminders(row: ReminderSource, settings: Settings): EventReminder[] {
  const provider = JSON.parse(row.reminders ?? (row.all_day ? '[]' : row.default_reminders)) as number[]
  if (!hasOwn(row)) {
    const meeting = row.join_url !== null || row.attendee_count > 0
    const defaults = row.all_day ? settings.allDayReminders : meeting ? settings.meetingReminders : settings.eventReminders
    return mergeReminders([...provider.map((minutes) => ({ minutes, alarm: false })), ...defaults])
  }
  const synced = JSON.parse(row.synced!) as number[]
  const kept = (JSON.parse(row.custom!) as EventReminder[]).filter((r) => provider.includes(r.minutes) || !synced.includes(r.minutes))
  const added = provider.filter((minutes) => !synced.includes(minutes)).map((minutes) => ({ minutes, alarm: false }))
  return mergeReminders([...kept, ...added])
}

// Saves the user's own reminders for one event. synced: the provider's minutes after the save. allDay: the event's kind.
export function saveEventReminders(
  db: Db,
  calendarId: number,
  remoteId: string,
  reminders: EventReminder[],
  synced: number[],
  allDay: boolean
): void {
  db.prepare(
    `INSERT INTO event_reminders (calendar_id, remote_id, reminders, synced, all_day) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (calendar_id, remote_id) DO UPDATE SET reminders = excluded.reminders, synced = excluded.synced, all_day = excluded.all_day`
  ).run(calendarId, remoteId, JSON.stringify(reminders), JSON.stringify(synced), allDay ? 1 : 0)
}

// Drops the reminders saved for single events of a series: "All events" reminders replace them, and a Google series
// time change gives every event a new id.
export function deleteInstanceReminders(db: Db, calendarId: number, seriesRemoteId: string): void {
  db.prepare(
    'DELETE FROM event_reminders WHERE calendar_id = ? AND remote_id IN (SELECT remote_id FROM events WHERE calendar_id = ? AND series_remote_id = ?)'
  ).run(calendarId, calendarId, seriesRemoteId)
}

// A split's new series keeps the old series' reminders.
export function copyEventReminders(db: Db, calendarId: number, from: string, to: string): void {
  db.prepare(
    `INSERT INTO event_reminders (calendar_id, remote_id, reminders, synced, all_day)
     SELECT calendar_id, ?, reminders, synced, all_day FROM event_reminders WHERE calendar_id = ? AND remote_id = ?
     ON CONFLICT (calendar_id, remote_id) DO UPDATE SET reminders = excluded.reminders, synced = excluded.synced, all_day = excluded.all_day`
  ).run(to, calendarId, from)
}

// since: reminders that fired before it were missed while the app was off, and are skipped, unless the event is
// about to start. Otherwise starting the app would show every "1 day before" reminder of the next day at once.
export function listReminders(db: Db, now: number, since = 0): Reminders {
  const settings = getSettings(db)
  const headsUp: Reminder[] = []
  const alerts: Reminder[] = []
  for (const rows of meetings(db, now)) {
    const due = dueReminder(rows, settings, now, since)
    if (!due) continue
    const [first] = rows
    // Prefer the link of a copy the user owns or accepted over one from any invite with the same title.
    const linked = rows.filter((r) => r.join_url !== null)
    const own = linked.find((r) => r.response === 'organizer' || r.response === 'accepted') ?? linked[0]
    const reminder = {
      eventId: first.id,
      title: first.title,
      start: first.start,
      end: first.end,
      allDay: first.all_day === 1,
      last: first.last,
      location: first.location,
      joinUrl: own?.join_url ?? null,
      ...due
    }
    if (due.stage === 'heads-up') headsUp.push(reminder)
    else alerts.push(reminder)
  }
  return { headsUp, alerts, stale: listStaleAccounts(db, now - STALE_AFTER) }
}

// Acks every copy of the meeting that eventId belongs to. Reminders that fire at or before dismissedThrough are done;
// it only grows, so a snooze (the snoozed reminder's fireAt - 1) keeps what was dismissed. now: finds the copies.
export function ackReminder(db: Db, eventId: number, dismissedThrough: number, snoozedUntil: number | null, now: number): void {
  const rows = meetings(db, now).find((g) => g.some((r) => r.id === eventId)) ?? []
  const stmt = db.prepare(`
    INSERT INTO reminder_acks (calendar_id, remote_id, start_utc, dismissed_through, snoozed_until) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (calendar_id, remote_id, start_utc) DO UPDATE SET
      dismissed_through = MAX(dismissed_through, excluded.dismissed_through), snoozed_until = excluded.snoozed_until
  `)
  for (const r of rows) stmt.run(r.calendar_id, r.remote_id, r.start_utc, dismissedThrough, snoozedUntil)
  // Old acks are never read again. Same bound as candidates(): an all-day reminder can show up to 36 h after its start_utc.
  db.prepare('DELETE FROM reminder_acks WHERE start_utc < ?').run(now - DAY - ALL_DAY_SLACK)
}

// Events that may have a reminder now, with their reminders and acks. Acks are keyed by the start, so a moved event
// reminds again. Masters, cancelled, declined and hidden-calendar events never remind.
// A timed event shows until 10 min after its start, or 10 min after a snooze ends, never past its end. An all-day
// event shows until the end of its first day.
function candidates(db: Db, now: number): ReminderRow[] {
  const rows = db
    .prepare(
      `SELECT e.id, e.calendar_id, c.account_id, e.remote_id, e.ical_uid, e.title, e.start_utc, e.end_utc, e.all_day,
         e.start_date, e.end_date, e.location, e.join_url, e.response, e.attendee_count, e.reminders, c.default_reminders,
         iif(r.remote_id IS NULL, s.reminders, r.reminders) AS custom, iif(r.remote_id IS NULL, s.synced, r.synced) AS synced,
         iif(r.remote_id IS NULL, s.all_day, r.all_day) AS custom_all_day, a.dismissed_through, a.snoozed_until
       FROM events e
       JOIN calendars c ON c.id = e.calendar_id
       LEFT JOIN event_reminders r ON r.calendar_id = e.calendar_id AND r.remote_id = e.remote_id
       -- "All events" reminders. The event's own row wins.
       LEFT JOIN event_reminders s ON s.calendar_id = e.calendar_id AND s.remote_id = e.series_remote_id
       LEFT JOIN reminder_acks a ON a.calendar_id = e.calendar_id AND a.remote_id = e.remote_id AND a.start_utc = e.start_utc
       WHERE e.start_utc > ? AND e.start_utc <= ? AND e.end_utc > ?
         AND e.kind != 'master' AND e.cancelled = 0 AND e.response != 'declined' AND c.visible = 1
       ORDER BY e.start_utc, e.id`
    )
    // Reminders are never earlier than MAX_REMINDER_MINUTES, so look no further ahead. A day back: the ack clean-up
    // forgets snoozes older than that.
    .all(now - DAY - ALL_DAY_SLACK, now + MAX_REMINDER_MINUTES * MIN + ALL_DAY_SLACK, now - ALL_DAY_SLACK) as unknown as ReminderRow[]
  return rows
    .map((r) =>
      r.all_day
        ? // -1440: midnight at the end of the first day.
          { ...r, start: allDayFireAt(r.start_date!, 0), end: allDayFireAt(r.end_date!, 0), last: allDayFireAt(r.start_date!, -1440) }
        : { ...r, start: r.start_utc, end: r.end_utc, last: r.end_utc }
    )
    .filter(
      (r) =>
        now < r.last &&
        (r.all_day === 1 || r.start > now - LATE_AFTER || (r.snoozed_until !== null && r.snoozed_until > now - LATE_AFTER))
    )
}

// Groups copies of one meeting, so it reminds once. Copies start at the same time and share the iCal UID,
// or, across accounts (work and personal), the title: providers give the same meeting different UIDs.
// Two meetings with one title in one account stay apart.
function meetings(db: Db, now: number): ReminderRow[][] {
  const result: ReminderRow[][] = []
  for (const row of candidates(db, now)) {
    const group = result.find((rows) =>
      rows.some(
        (r) =>
          r.start_utc === row.start_utc &&
          ((r.ical_uid !== null && r.ical_uid === row.ical_uid) ||
            (r.account_id !== row.account_id && r.title.trim() === row.title.trim()))
      )
    )
    if (group) group.push(row)
    else result.push([row])
  }
  return result
}

// The reminder to show: the last one that fired since `since` and was not dismissed. An alarm that is still ringing
// wins over a later notification. Alarms show as 'alert' before the start and 'started' after (all-day: always
// 'alert'); notifications as 'heads-up'. next: when the next one fires, so a snooze never hides it.
// Copies share their reminders, but once the user set reminders on one copy, only such copies count, so a reminder
// removed there does not come back from another copy.
function dueReminder(
  rows: ReminderRow[],
  settings: Settings,
  now: number,
  since: number
): { stage: ReminderStage; fireAt: number; next: number | null } | null {
  const { start, all_day: allDay, start_date: date } = rows[0]
  const snoozed = rows.some((r) => r.snoozed_until !== null && r.snoozed_until > now)
  // Missed reminders still count for an event that starts within 10 min of `since`, and once snoozed (the snooze ack
  // ends everything before the snoozed reminder). All-day: only reminders that fired before today (local midnight)
  // are missed. So a login or restart still shows one that fired today, also while the PC was off, e.g. tomorrow's
  // "day before at 17:00" (wider than the timed rule, on purpose). A setting saved today never rings
  // yesterday's time, also when the app ran since then. Cost: yesterday's unanswered all-day alarm goes at midnight.
  const missed = rows.some((r) => r.snoozed_until !== null)
    ? 0
    : allDay
      ? new Date(now).setHours(0, 0, 0, 0) - 1
      : start - since > LATE_AFTER
        ? since - 1
        : 0
  const dismissed = Math.max(missed, ...rows.map((r) => r.dismissed_through ?? 0))
  const own = rows.filter(hasOwn)
  // Earliest first: more minutes fire earlier, also for all-day.
  const fires = mergeReminders((own.length > 0 ? own : rows).flatMap((r) => effectiveReminders(r, settings))).map((r) => ({
    alarm: r.alarm,
    fireAt: allDay ? allDayFireAt(date!, r.minutes) : start - r.minutes * MIN
  }))
  const waiting = fires.filter((r) => r.fireAt <= now && r.fireAt > dismissed)
  // During a snooze only a later alarm shows, e.g. one added after the snooze: the snooze ack ends everything up to
  // the snoozed reminder (dismissed + 1), and an alarm wins when it fires, so nothing later had rung yet.
  const shown = snoozed ? waiting.findLast((r) => r.alarm && r.fireAt > dismissed + 1) : (waiting.findLast((r) => r.alarm) ?? waiting.at(-1))
  if (!shown) return null
  const next = fires.find((r) => r.fireAt > now)?.fireAt ?? null
  return { stage: !shown.alarm ? 'heads-up' : allDay || start > now ? 'alert' : 'started', fireAt: shown.fireAt, next }
}
