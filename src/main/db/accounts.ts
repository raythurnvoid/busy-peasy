import type { Account, AccountStatus, Calendar, Provider } from '../../shared/api'
import { GOOGLE_COLOR_LIST, GOOGLE_LABEL_LIST, OUTLOOK_COLORS } from '../../shared/colors'
import { canonicalZone, isZone } from '../../shared/zones'
import { tx, type Db } from './db'

interface AccountRow {
  id: number
  provider: Provider
  email: string
  status: AccountStatus
  secret: Uint8Array | null
  session: string | null
  last_sync_at: number | null
  last_error: string | null
}

interface CalendarRow {
  id: number
  account_id: number
  remote_id: string
  name: string
  color: string
  can_edit: number
  visible: number
  is_primary: number
  default_reminders: string
  conference: string | null
  time_zone: string | null
  labels_read: number
  cursor: string | null
  window_start: number | null
  window_end: number | null
  last_full_sync: number | null
  generation: number
}

// What sync needs to know about a calendar besides the public fields.
export interface CalendarSyncState extends Omit<Calendar, 'colors'> {
  remoteId: string
  cursor: string | null
  lastFullSync: number | null
  generation: number
}

export interface RemoteCalendar {
  remoteId: string
  name: string
  color: string
  canEdit: boolean
  isPrimary: boolean
  defaultReminders: number[]
  conference: Calendar['conference']
  // Google only. Optional: Outlook calendars have none, and test calendars leave it out.
  timeZone?: string
}

export function listAccounts(db: Db): Account[] {
  const rows = db.prepare('SELECT * FROM accounts ORDER BY id').all() as unknown as AccountRow[]
  return rows.map(toAccount)
}

export function getAccount(db: Db, id: number): (Account & { secret: Uint8Array | null; session: string | null }) | null {
  const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined
  return row ? { ...toAccount(row), secret: row.secret, session: row.session } : null
}

export function findAccount(db: Db, provider: Provider, email: string): { id: number; session: string | null } | null {
  const row = db.prepare('SELECT id, session FROM accounts WHERE provider = ? AND email = ?').get(provider, email)
  return (row as { id: number; session: string | null } | undefined) ?? null
}

export function listSessions(db: Db): string[] {
  const rows = db.prepare('SELECT session FROM accounts WHERE session IS NOT NULL').all() as { session: string }[]
  return rows.map((r) => r.session)
}

// Adding an account that already exists keeps its id and calendars.
export function upsertAccount(
  db: Db,
  provider: Provider,
  email: string,
  secret: Uint8Array | null,
  now: number,
  session: string | null = null
): number {
  db.prepare(
    `INSERT INTO accounts (provider, email, secret, session, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (provider, email) DO UPDATE SET
       secret = COALESCE(excluded.secret, secret), session = COALESCE(excluded.session, session), status = 'ok'`
  ).run(provider, email, secret, session, now)
  return findAccount(db, provider, email)!.id
}

export function setAccountStatus(db: Db, id: number, status: AccountStatus, error: string | null, now?: number): void {
  if (status === 'ok' && now !== undefined) {
    db.prepare('UPDATE accounts SET status = ?, last_error = NULL, last_sync_at = ? WHERE id = ?').run(status, now, id)
  } else {
    db.prepare('UPDATE accounts SET status = ?, last_error = ? WHERE id = ?').run(status, error, id)
  }
}

// Outlook's category colors: { name: "PresetN" }.
export function saveCategories(db: Db, id: number, categories: Record<string, string>): void {
  db.prepare('UPDATE accounts SET categories = ? WHERE id = ?').run(JSON.stringify(categories), id)
}

// Google's event labels of a calendar, in Google's order. null: the sign-in cannot read them (no labels scope), so the
// last ones stay.
export function saveLabels(db: Db, calendarId: number, labels: { id: string; name: string; color: string }[] | null): void {
  tx(db, () => {
    db.prepare('UPDATE calendars SET labels_read = ? WHERE id = ?').run(labels ? 1 : 0, calendarId)
    if (!labels) return
    db.prepare('DELETE FROM labels WHERE calendar_id = ?').run(calendarId)
    // OR IGNORE: one id twice in Google's list must not fail the sync.
    const insert = db.prepare('INSERT OR IGNORE INTO labels (calendar_id, id, name, color, position) VALUES (?, ?, ?, ?, ?)')
    labels.forEach((l, i) => insert.run(calendarId, l.id, l.name, l.color, i))
  })
}

// Accounts that need a sign-in or have no good sync since syncedBefore.
export function listStaleAccounts(db: Db, syncedBefore: number): string[] {
  const rows = db
    .prepare(
      `SELECT email FROM accounts
       WHERE status = 'needs-sign-in' OR last_sync_at IS NULL OR last_sync_at < ? ORDER BY id`
    )
    .all(syncedBefore) as { email: string }[]
  return rows.map((r) => r.email)
}

export function deleteAccount(db: Db, id: number): void {
  db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
}

export function listCalendars(db: Db): Calendar[] {
  const rows = db
    .prepare(
      `SELECT c.*, a.provider, a.categories FROM calendars c JOIN accounts a ON a.id = c.account_id
       ORDER BY c.account_id, c.is_primary DESC, c.name`
    )
    .all() as unknown as (CalendarRow & { provider: Provider; categories: string | null })[]
  const labels = db.prepare('SELECT calendar_id, id, name, color FROM labels ORDER BY calendar_id, position').all() as {
    calendar_id: number
    id: string
    name: string
    color: string
  }[]
  return rows.map((row) => {
    const calendar = toCalendar(row)
    const own = labels.filter((l) => l.calendar_id === row.id)
    // Google: its labels, else the classic colors (a sign-in without the labels scope). Outlook: the mailbox's categories
    // with a color, only in the main calendar, like reminders. A preset the app does not know shows the calendar's.
    let colors: Calendar['colors'] = []
    if (calendar.canEdit && row.provider === 'google') {
      // Google's default labels get the name and place Google web gives them; a renamed one keeps its name. The
      // user's own labels follow, in Google's order. One with no name gets its own, so the menu can tell them apart.
      const place = (hex: string): number => {
        const i = GOOGLE_LABEL_LIST.findIndex(([, known]) => known.toLowerCase() === hex.toLowerCase())
        return i === -1 ? GOOGLE_LABEL_LIST.length : i
      }
      let unnamed = 0
      colors =
        own.length > 0
          ? own
              .sort((a, b) => place(a.color) - place(b.color))
              .map((l) => ({ key: l.id, name: l.name || GOOGLE_LABEL_LIST[place(l.color)]?.[0] || `Custom color ${++unnamed}`, color: l.color }))
          : GOOGLE_COLOR_LIST.map(([id, name, color]) => ({ key: id, name, color }))
    } else if (calendar.canEdit && calendar.isPrimary && row.categories) {
      colors = Object.entries(JSON.parse(row.categories) as Record<string, string>)
        // Outlook may send a category with no color (null).
        .filter(([, preset]) => preset?.startsWith('Preset'))
        .map(([name, preset]) => ({ key: name, name, color: OUTLOOK_COLORS[preset] ?? calendar.color }))
    }
    return { ...calendar, colors }
  })
}

export function listCalendarSyncStates(db: Db, accountId: number): CalendarSyncState[] {
  const rows = db.prepare('SELECT * FROM calendars WHERE account_id = ?').all(accountId) as unknown as CalendarRow[]
  return rows.map(toSyncState)
}

export function getCalendarSyncState(db: Db, id: number): CalendarSyncState | null {
  const row = db.prepare('SELECT * FROM calendars WHERE id = ?').get(id) as CalendarRow | undefined
  return row ? toSyncState(row) : null
}

// A calendar with the provider and address of its account. null: the calendar is gone.
export function getCalendarAccount(db: Db, id: number): (CalendarSyncState & { provider: Provider; email: string }) | null {
  const calendar = getCalendarSyncState(db, id)
  const account = calendar && getAccount(db, calendar.accountId)
  return calendar && account ? { ...calendar, provider: account.provider, email: account.email } : null
}

// Mirrors the provider's calendar list: new ones are added, gone ones removed (with their events).
export function syncCalendarList(db: Db, accountId: number, remote: RemoteCalendar[]): void {
  const upsert = db.prepare(
    `INSERT INTO calendars (account_id, remote_id, name, color, can_edit, is_primary, default_reminders, conference, time_zone)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (account_id, remote_id) DO UPDATE SET
       name = excluded.name, color = excluded.color, can_edit = excluded.can_edit, is_primary = excluded.is_primary,
       default_reminders = excluded.default_reminders, conference = excluded.conference, time_zone = excluded.time_zone`
  )
  for (const c of remote) {
    upsert.run(accountId, c.remoteId, c.name, c.color, c.canEdit ? 1 : 0, c.isPrimary ? 1 : 0, JSON.stringify(c.defaultReminders), c.conference, c.timeZone ?? null)
  }
  const keep = new Set(remote.map((c) => c.remoteId))
  const existing = db.prepare('SELECT id, remote_id FROM calendars WHERE account_id = ?').all(accountId) as {
    id: number
    remote_id: string
  }[]
  const del = db.prepare('DELETE FROM calendars WHERE id = ?')
  for (const row of existing) if (!keep.has(row.remote_id)) del.run(row.id)
}

export function setCalendarVisible(db: Db, id: number, visible: boolean): void {
  db.prepare('UPDATE calendars SET visible = ? WHERE id = ?').run(visible ? 1 : 0, id)
}

export function saveCursor(
  db: Db,
  id: number,
  state: Pick<CalendarSyncState, 'cursor' | 'windowStart' | 'windowEnd' | 'lastFullSync' | 'generation'>
): void {
  db.prepare(
    'UPDATE calendars SET cursor = ?, window_start = ?, window_end = ?, last_full_sync = ?, generation = ? WHERE id = ?'
  ).run(state.cursor, state.windowStart, state.windowEnd, state.lastFullSync, state.generation, id)
}

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    provider: row.provider,
    email: row.email,
    status: row.status,
    lastSyncAt: row.last_sync_at,
    lastError: row.last_error
  }
}

function toCalendar(row: CalendarRow): Omit<Calendar, 'colors'> {
  // V8's id, the one the picker lists and main takes: Google may send a newer id (Asia/Kolkata). Else none, so the
  // dialog uses this PC's zone.
  const zone = row.time_zone && canonicalZone(row.time_zone)
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    color: row.color,
    canEdit: row.can_edit === 1,
    visible: row.visible === 1,
    isPrimary: row.is_primary === 1,
    defaultReminders: JSON.parse(row.default_reminders) as number[],
    conference: row.conference as Calendar['conference'],
    timeZone: isZone(zone) ? zone : null,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    labelsRead: row.labels_read === 1
  }
}

function toSyncState(row: CalendarRow): CalendarSyncState {
  return {
    ...toCalendar(row),
    remoteId: row.remote_id,
    cursor: row.cursor,
    lastFullSync: row.last_full_sync,
    generation: row.generation
  }
}
