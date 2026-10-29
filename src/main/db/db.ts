import { DatabaseSync } from 'node:sqlite'
import { isPerson } from '../../shared/events'

export type Db = DatabaseSync

// Each entry moves the schema one version up. Never edit a shipped entry; add a new one.
const migrations: string[] = [
  `
  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL,
    email TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ok',
    secret BLOB,
    last_sync_at INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (provider, email)
  );

  CREATE TABLE calendars (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    remote_id TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    can_edit INTEGER NOT NULL,
    visible INTEGER NOT NULL DEFAULT 1,
    is_primary INTEGER NOT NULL DEFAULT 0,
    -- Sync state: delta link (Outlook) or sync token (Google), and the window it covers.
    cursor TEXT,
    window_start INTEGER,
    window_end INTEGER,
    last_full_sync INTEGER,
    generation INTEGER NOT NULL DEFAULT 0,
    UNIQUE (account_id, remote_id)
  );

  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    calendar_id INTEGER NOT NULL REFERENCES calendars (id) ON DELETE CASCADE,
    remote_id TEXT NOT NULL,
    -- single | occurrence | exception | master. Masters are never shown, they only feed occurrences.
    kind TEXT NOT NULL,
    series_remote_id TEXT,
    ical_uid TEXT,
    version TEXT,
    title TEXT NOT NULL,
    start_utc INTEGER NOT NULL,
    end_utc INTEGER NOT NULL,
    all_day INTEGER NOT NULL,
    start_date TEXT,
    end_date TEXT,
    start_tz TEXT,
    location TEXT NOT NULL,
    join_url TEXT,
    description TEXT NOT NULL,
    show_as TEXT NOT NULL,
    response TEXT NOT NULL,
    is_organizer INTEGER NOT NULL,
    attendee_count INTEGER NOT NULL,
    cancelled INTEGER NOT NULL,
    reminder_minutes INTEGER,
    generation INTEGER NOT NULL,
    UNIQUE (calendar_id, remote_id)
  );
  CREATE INDEX events_range ON events (start_utc);
  -- Lets the range query find the longest event without a scan.
  CREATE INDEX events_duration ON events (end_utc - start_utc);
  CREATE INDEX events_series ON events (calendar_id, series_remote_id);

  -- Keyed by remote ids so a re-synced event keeps its acks.
  CREATE TABLE reminder_acks (
    calendar_id INTEGER NOT NULL REFERENCES calendars (id) ON DELETE CASCADE,
    remote_id TEXT NOT NULL,
    remind_at INTEGER NOT NULL,
    state TEXT NOT NULL,
    snoozed_until INTEGER,
    PRIMARY KEY (calendar_id, remote_id, remind_at)
  );
  `,
  // Each Microsoft account signs in inside its own Electron partition. The first one keeps the old shared partition.
  `
  ALTER TABLE accounts ADD COLUMN session TEXT;
  UPDATE accounts SET session = 'persist:outlook' WHERE provider = 'outlook';
  `,
  // Many reminders per event. events.reminders is the provider's list in minutes as JSON; NULL means the
  // calendar's default_reminders. Clearing the cursors makes the next sync full, so both get filled.
  `
  ALTER TABLE events ADD COLUMN reminders TEXT;
  UPDATE events SET reminders = CASE WHEN reminder_minutes IS NULL THEN '[]' ELSE json_array(reminder_minutes) END;
  ALTER TABLE events DROP COLUMN reminder_minutes;
  ALTER TABLE calendars ADD COLUMN default_reminders TEXT NOT NULL DEFAULT '[]';
  UPDATE calendars SET cursor = NULL;

  -- The user's own list for one event (JSON [{minutes, alarm}]), and the provider's minutes right after it was saved.
  -- Keyed by remote ids, like the acks, so it survives a re-sync.
  CREATE TABLE event_reminders (
    calendar_id INTEGER NOT NULL REFERENCES calendars (id) ON DELETE CASCADE,
    remote_id TEXT NOT NULL,
    reminders TEXT NOT NULL,
    synced TEXT NOT NULL,
    PRIMARY KEY (calendar_id, remote_id)
  );

  -- Acks only live a day, so the old ones are dropped.
  DROP TABLE reminder_acks;
  CREATE TABLE reminder_acks (
    calendar_id INTEGER NOT NULL REFERENCES calendars (id) ON DELETE CASCADE,
    remote_id TEXT NOT NULL,
    start_utc INTEGER NOT NULL,
    -- Reminders that fire at or before this are done.
    dismissed_through INTEGER NOT NULL DEFAULT 0,
    snoozed_until INTEGER,
    PRIMARY KEY (calendar_id, remote_id, start_utc)
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // Guests, organizer, colors and other event details. attendees and categories are JSON lists. accounts.categories is
  // Outlook's {name: "PresetN"}. Clearing the cursors makes the next sync full, so old rows get the new data.
  `
  ALTER TABLE events ADD COLUMN attendees TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE events ADD COLUMN organizer_email TEXT;
  ALTER TABLE events ADD COLUMN organizer_name TEXT;
  ALTER TABLE events ADD COLUMN attendees_omitted INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE events ADD COLUMN response_requested INTEGER;
  ALTER TABLE events ADD COLUMN guests_can_modify INTEGER;
  ALTER TABLE events ADD COLUMN guests_can_invite_others INTEGER;
  ALTER TABLE events ADD COLUMN guests_can_see_other_guests INTEGER;
  ALTER TABLE events ADD COLUMN private_copy INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE events ADD COLUMN color_id TEXT;
  ALTER TABLE events ADD COLUMN event_label_id TEXT;
  ALTER TABLE events ADD COLUMN categories TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE events ADD COLUMN original_start INTEGER;
  ALTER TABLE events ADD COLUMN recurrence TEXT;
  ALTER TABLE events ADD COLUMN body TEXT;
  ALTER TABLE events ADD COLUMN web_link TEXT;
  ALTER TABLE accounts ADD COLUMN categories TEXT;
  UPDATE calendars SET cursor = NULL;
  `,
  // The video call a calendar can add, and the people seen in events (guest suggestions). The calendar list is read on
  // every sync, so no cursor reset. people is filled once here, then by every sync and write.
  `
  -- 'meet', 'teams' or NULL: none, or not read yet.
  ALTER TABLE calendars ADD COLUMN conference TEXT;

  -- email is lower case. last_seen: the start of the latest event the person is in.
  CREATE TABLE people (
    account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    name TEXT,
    last_seen INTEGER NOT NULL,
    PRIMARY KEY (account_id, email)
  ) WITHOUT ROWID;
  -- Guests (no rooms), and the organizers of meetings. No calendars or booking pages (is_person, see openDb).
  INSERT INTO people
    SELECT account_id, email, MAX(name), MAX(seen) FROM (
      SELECT c.account_id, lower(g.value ->> 'email') AS email, g.value ->> 'name' AS name, e.start_utc AS seen
        FROM events e JOIN calendars c ON c.id = e.calendar_id, json_each(e.attendees) g
        WHERE g.value ->> 'resource' IS NULL
      UNION ALL
      SELECT c.account_id, lower(e.organizer_email), e.organizer_name, e.start_utc
        FROM events e JOIN calendars c ON c.id = e.calendar_id
        WHERE e.attendees != '[]'
    )
    WHERE email != '' AND is_person(email) GROUP BY account_id, email;
  `,
  // Time zones. Clearing the cursors makes the next sync full, so old rows get their end zone.
  `
  -- Google's calendar zone (calendarList timeZone), what Google gives a new event. NULL: Outlook, or not read yet.
  ALTER TABLE calendars ADD COLUMN time_zone TEXT;
  -- The provider's end zone, like start_tz. NULL: the start zone.
  ALTER TABLE events ADD COLUMN end_tz TEXT;
  UPDATE calendars SET cursor = NULL;
  `,
  // The kind of event an own reminder list was made for: 10 minutes means "the day before at 23:50" on an all-day event.
  `
  -- 1: made for an all-day event. Older lists are all for timed events (all-day events had none).
  ALTER TABLE event_reminders ADD COLUMN all_day INTEGER NOT NULL DEFAULT 0;
  `,
  // An event's own reminders go with it, on every delete (by the app or by a sync). A Google series has no event row,
  // so deleteEvents drops its "All events" list.
  `
  CREATE TRIGGER events_delete_reminders AFTER DELETE ON events BEGIN
    DELETE FROM event_reminders WHERE calendar_id = old.calendar_id AND remote_id = old.remote_id;
  END;
  `,
  // Google's event labels (its colors) per calendar, read on every sync. events.event_label_id is filled since
  // migration 4, so no cursor reset.
  `
  -- position: Google's order, which the color menu keeps.
  CREATE TABLE labels (
    calendar_id INTEGER NOT NULL REFERENCES calendars (id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (calendar_id, id)
  ) WITHOUT ROWID;
  -- 1: the last sync read the calendar's labels, so the Google sign-in has the labels scope.
  ALTER TABLE calendars ADD COLUMN labels_read INTEGER NOT NULL DEFAULT 0;
  `
]

export function openDb(path: string): Db {
  const db = new DatabaseSync(path, { timeout: 5000 })
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;')
  // The people rule for SQL (migrations and reads), so SQL and sync use the same one.
  db.function('is_person', { deterministic: true }, (email) => (isPerson(String(email)) ? 1 : 0))
  migrate(db)
  return db
}

function migrate(db: Db): void {
  const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  for (let v = user_version; v < migrations.length; v++) {
    tx(db, () => {
      db.exec(migrations[v])
      db.exec(`PRAGMA user_version = ${v + 1}`)
    })
  }
}

// node:sqlite has no transaction helper.
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
