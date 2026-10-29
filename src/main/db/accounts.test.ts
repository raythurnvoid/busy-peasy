import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  findAccount,
  getAccount,
  listCalendars,
  listSessions,
  saveCategories,
  saveCursor,
  saveLabels,
  syncCalendarList,
  upsertAccount,
  type RemoteCalendar
} from './accounts'
import { openDb } from './db'

describe('accounts', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  // Only the parts of the v1 schema that later migrations touch.
  function v1File(): string {
    dir = mkdtempSync(join(tmpdir(), 'busy-peasy-'))
    const file = join(dir, 'v1.db')
    const v1 = new DatabaseSync(file)
    v1.exec(`
      CREATE TABLE accounts (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, email TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ok', secret BLOB, last_sync_at INTEGER, last_error TEXT,
        created_at INTEGER NOT NULL, UNIQUE (provider, email));
      CREATE TABLE calendars (id INTEGER PRIMARY KEY, account_id INTEGER, cursor TEXT);
      CREATE TABLE events (id INTEGER PRIMARY KEY, calendar_id INTEGER, start_utc INTEGER, reminder_minutes INTEGER);
      CREATE TABLE reminder_acks (remind_at INTEGER);
      INSERT INTO accounts (provider, email, created_at) VALUES ('outlook', 'a@work.com', 1), ('google', 'b@gmail.com', 1);
      INSERT INTO calendars (cursor) VALUES ('delta-link');
      INSERT INTO events (reminder_minutes) VALUES (15), (NULL);
      PRAGMA user_version = 1;
    `)
    v1.close()
    return file
  }

  it('keeps the old shared partition for a Microsoft account made before multi-account', () => {
    const db = openDb(v1File())
    const outlook = findAccount(db, 'outlook', 'a@work.com')
    const google = findAccount(db, 'google', 'b@gmail.com')
    // Close before asserting: Windows cannot delete an open file.
    db.close()
    expect(outlook?.session).toBe('persist:outlook')
    expect(google?.session).toBeNull()
  })

  it('keeps reminders as lists, and makes the next sync full to fill in the rest', () => {
    const db = openDb(v1File())
    const events = db.prepare('SELECT reminders FROM events ORDER BY id').all()
    const calendars = db.prepare('SELECT cursor, default_reminders FROM calendars').all()
    db.close()
    expect(events.map((e) => e.reminders)).toEqual(['[15]', '[]'])
    expect(calendars).toEqual([{ cursor: null, default_reminders: '[]' }])
  })

  it('adds the event details with empty lists, and makes the next sync full to fill them', () => {
    dir = mkdtempSync(join(tmpdir(), 'busy-peasy-'))
    const file = join(dir, 'v3.db')
    // Only the parts of the v3 schema that migration 4 touches.
    const v3 = new DatabaseSync(file)
    v3.exec(`
      CREATE TABLE accounts (id INTEGER PRIMARY KEY);
      CREATE TABLE calendars (id INTEGER PRIMARY KEY, account_id INTEGER, cursor TEXT);
      CREATE TABLE events (id INTEGER PRIMARY KEY, calendar_id INTEGER, start_utc INTEGER);
      CREATE TABLE event_reminders (remote_id TEXT);
      INSERT INTO accounts (id) VALUES (1);
      INSERT INTO calendars (cursor) VALUES ('delta-link');
      INSERT INTO events (id) VALUES (1);
      PRAGMA user_version = 3;
    `)
    v3.close()
    const db = openDb(file)
    const calendars = db.prepare('SELECT cursor FROM calendars').all()
    const events = db.prepare('SELECT attendees, categories, color_id FROM events').all()
    const accounts = db.prepare('SELECT categories FROM accounts').all()
    db.close()
    expect(calendars).toEqual([{ cursor: null }])
    expect(events).toEqual([{ attendees: '[]', categories: '[]', color_id: null }])
    expect(accounts).toEqual([{ categories: null }])
  })

  it('adds the video call of each calendar as not read yet, and fills the people from the stored events (no calendars)', () => {
    dir = mkdtempSync(join(tmpdir(), 'busy-peasy-'))
    const file = join(dir, 'v4.db')
    // Only the parts of the v4 schema that migration 5 touches.
    const v4 = new DatabaseSync(file)
    v4.exec(`
      CREATE TABLE accounts (id INTEGER PRIMARY KEY);
      CREATE TABLE calendars (id INTEGER PRIMARY KEY, account_id INTEGER, cursor TEXT);
      CREATE TABLE events (id INTEGER PRIMARY KEY, calendar_id INTEGER, start_utc INTEGER, attendees TEXT,
        organizer_email TEXT, organizer_name TEXT);
      CREATE TABLE event_reminders (remote_id TEXT);
      INSERT INTO accounts (id) VALUES (1);
      INSERT INTO calendars (account_id, cursor) VALUES (1, 'token');
      INSERT INTO events (calendar_id, start_utc, attendees, organizer_email, organizer_name) VALUES
        (1, 10, '[{"email":"Ann@x.com","name":"Ann"},{"email":"room@x.com","resource":true}]', 'boss@x.com', 'Boss'),
        (1, 20, '[{"email":"ann@x.com"}]', NULL, NULL),
        (1, 30, '[]', 'holidays@group.calendar.google.com', NULL),
        (1, 40, '[{"email":"c_1@group.calendar.google.com"}]', 'g3ac4f90dcccb41a88f277a8628643271@x.com', 'Booking page');
      PRAGMA user_version = 4;
    `)
    v4.close()
    const db = openDb(file)
    const calendars = db.prepare('SELECT conference FROM calendars').all()
    const people = db.prepare('SELECT * FROM people ORDER BY email').all()
    db.close()
    expect(calendars).toEqual([{ conference: null }])
    expect(people).toEqual([
      { account_id: 1, email: 'ann@x.com', name: 'Ann', last_seen: 20 },
      { account_id: 1, email: 'boss@x.com', name: 'Boss', last_seen: 10 }
    ])
  })

  it('adds the zones as not read yet, and makes the next sync full to fill them', () => {
    dir = mkdtempSync(join(tmpdir(), 'busy-peasy-'))
    const file = join(dir, 'v5.db')
    // Only the parts of the v5 schema that migration 6 touches.
    const v5 = new DatabaseSync(file)
    v5.exec(`
      CREATE TABLE calendars (id INTEGER PRIMARY KEY, cursor TEXT);
      CREATE TABLE events (id INTEGER PRIMARY KEY);
      CREATE TABLE event_reminders (remote_id TEXT);
      INSERT INTO calendars (cursor) VALUES ('token');
      INSERT INTO events (id) VALUES (1);
      PRAGMA user_version = 5;
    `)
    v5.close()
    const db = openDb(file)
    const calendars = db.prepare('SELECT cursor, time_zone FROM calendars').all()
    const events = db.prepare('SELECT end_tz FROM events').all()
    db.close()
    expect(calendars).toEqual([{ cursor: null, time_zone: null }])
    expect(events).toEqual([{ end_tz: null }])
  })

  it('marks the own reminder lists made before as lists for timed events', () => {
    dir = mkdtempSync(join(tmpdir(), 'busy-peasy-'))
    const file = join(dir, 'v6.db')
    // Only the parts of the v6 schema that migrations 7 to 9 touch.
    const v6 = new DatabaseSync(file)
    v6.exec(`
      CREATE TABLE calendars (id INTEGER PRIMARY KEY);
      CREATE TABLE events (calendar_id INTEGER, remote_id TEXT);
      CREATE TABLE event_reminders (remote_id TEXT);
      INSERT INTO event_reminders (remote_id) VALUES ('a');
      PRAGMA user_version = 6;
    `)
    v6.close()
    const db = openDb(file)
    const rows = db.prepare('SELECT remote_id, all_day FROM event_reminders').all()
    db.close()
    expect(rows).toEqual([{ remote_id: 'a', all_day: 0 }])
  })

  it('adds the labels table with no labels read, and deletes the labels with their calendar', () => {
    dir = mkdtempSync(join(tmpdir(), 'busy-peasy-'))
    const file = join(dir, 'v8.db')
    // Only the parts of the v8 schema that migration 9 touches.
    const v8 = new DatabaseSync(file)
    v8.exec(`
      CREATE TABLE calendars (id INTEGER PRIMARY KEY, cursor TEXT);
      INSERT INTO calendars (cursor) VALUES ('token');
      PRAGMA user_version = 8;
    `)
    v8.close()
    const db = openDb(file)
    const before = db.prepare('SELECT cursor, labels_read FROM calendars').all()
    saveLabels(db, 1, [{ id: 'cobalt', name: 'Cobalt', color: '#4285F4' }])
    const read = db.prepare('SELECT labels_read FROM calendars').get()
    db.prepare('DELETE FROM calendars').run()
    const left = db.prepare('SELECT COUNT(*) AS n FROM labels').get()
    db.close()
    expect(before).toEqual([{ cursor: 'token', labels_read: 0 }])
    expect(read).toEqual({ labels_read: 1 })
    expect(left).toEqual({ n: 0 })
  })

  it("lists each calendar's colors: Google labels, else the classic ones; Outlook categories with a color, main calendar only", () => {
    const db = openDb(':memory:')
    const google = upsertAccount(db, 'google', 'b@gmail.com', null, 1)
    const outlook = upsertAccount(db, 'outlook', 'a@work.com', null, 1)
    const calendar = (remoteId: string, extra = {}): RemoteCalendar => ({ remoteId, name: remoteId, color: '#3F51B5', canEdit: true, isPrimary: true, defaultReminders: [], conference: null, ...extra })
    syncCalendarList(db, google, [calendar('me'), calendar('team', { isPrimary: false }), calendar('holidays', { canEdit: false, isPrimary: false })])
    syncCalendarList(db, outlook, [calendar('main'), calendar('shared', { isPrimary: false })])
    saveLabels(db, 1, [
      { id: 'b', name: 'Basil', color: '#0B8043' },
      { id: 'a', name: 'Avocado', color: '#C0CA33' }
    ])
    // Odd: Outlook may send a category with no color.
    saveCategories(db, outlook, { 'Red category': 'Preset0', Plain: 'None', Odd: null as unknown as string, Work: 'Preset2', 'Green category': 'Preset4' })
    const colors = Object.fromEntries(listCalendars(db).map((c) => [c.name, c.colors]))
    expect(colors.me.map((c) => c.name)).toEqual(['Avocado', 'Basil'])
    expect(colors.team.map((c) => c.key)).toEqual(['4', '11', '6', '5', '10', '2', '7', '1', '9', '3', '8'])
    expect(colors.team[1]).toEqual({ key: '11', name: 'Tomato', color: '#D50000' })
    expect(colors.holidays).toEqual([])
    expect(colors.main).toEqual([
      { key: 'Red category', name: 'Red category', color: '#C50F1F' },
      { key: 'Work', name: 'Work', color: '#3F51B5' },
      { key: 'Green category', name: 'Green category', color: '#0E7A0B' }
    ])
    expect(colors.shared).toEqual([])
  })

  it("names and orders Google's default labels like Google web, with the user's own labels after them (F1)", () => {
    const db = openDb(':memory:')
    const google = upsertAccount(db, 'google', 'b@gmail.com', null, 1)
    syncCalendarList(db, google, [{ remoteId: 'me', name: 'me', color: '#3F51B5', canEdit: true, isPrimary: true, defaultReminders: [], conference: null }])
    // As the API sends them: sorted by id, the defaults with no name and a lower-case hex.
    saveLabels(db, 1, [
      { id: '0a', name: '', color: '#0b8043' },
      { id: '1b', name: 'Team', color: '#123456' },
      { id: '2c', name: '', color: '#ad1457' },
      { id: '3d', name: '', color: '#abcdef' },
      { id: '4e', name: 'Focus', color: '#d50000' },
      { id: '5f', name: '', color: '#e67c73' }
    ])
    expect(listCalendars(db)[0].colors).toEqual([
      { key: '2c', name: 'Beetroot', color: '#ad1457' },
      { key: '5f', name: 'Flamingo', color: '#e67c73' },
      // Renamed in Google: its own name.
      { key: '4e', name: 'Focus', color: '#d50000' },
      { key: '0a', name: 'Basil', color: '#0b8043' },
      { key: '1b', name: 'Team', color: '#123456' },
      { key: '3d', name: 'Custom color 1', color: '#abcdef' }
    ])
  })

  it("stores each Google calendar's zone", () => {
    const db = openDb(':memory:')
    const account = upsertAccount(db, 'google', 'b@gmail.com', null, 1)
    const calendar = { remoteId: 'b@gmail.com', name: 'Me', color: '#000', canEdit: true, isPrimary: true, defaultReminders: [], conference: null }
    syncCalendarList(db, account, [{ ...calendar, timeZone: 'Europe/Lisbon' }])
    expect(listCalendars(db)[0].timeZone).toBe('Europe/Lisbon')
    syncCalendarList(db, account, [calendar])
    expect(listCalendars(db)[0].timeZone).toBeNull()
    // The picker's id, which main takes: Google may send the newer one. One the app does not know is none.
    syncCalendarList(db, account, [{ ...calendar, timeZone: 'Asia/Kolkata' }])
    expect(listCalendars(db)[0].timeZone).toBe('Asia/Calcutta')
    syncCalendarList(db, account, [{ ...calendar, timeZone: 'Mars/Base' }])
    expect(listCalendars(db)[0].timeZone).toBeNull()
  })

  it('stores the video call each calendar can add', () => {
    const db = openDb(':memory:')
    const account = upsertAccount(db, 'outlook', 'a@work.com', null, 1)
    const calendar = { remoteId: 'cal', name: 'Calendar', color: '#000', canEdit: true, isPrimary: true, defaultReminders: [] }
    syncCalendarList(db, account, [{ ...calendar, conference: 'teams' }])
    expect(listCalendars(db)[0].conference).toBe('teams')
    syncCalendarList(db, account, [{ ...calendar, conference: null }])
    expect(listCalendars(db)[0].conference).toBeNull()
  })

  it('says which dates the last sync of a calendar covered', () => {
    const db = openDb(':memory:')
    const account = upsertAccount(db, 'google', 'b@gmail.com', null, 1)
    syncCalendarList(db, account, [{ remoteId: 'b@gmail.com', name: 'Me', color: '#000', canEdit: true, isPrimary: true, defaultReminders: [], conference: null }])
    expect(listCalendars(db)[0]).toMatchObject({ windowStart: null, windowEnd: null })
    const [from, to] = [Date.UTC(2026, 7, 28), Date.UTC(2027, 9, 27)]
    saveCursor(db, listCalendars(db)[0].id, { cursor: 'token', windowStart: from, windowEnd: to, lastFullSync: 1, generation: 1 })
    expect(listCalendars(db)[0]).toMatchObject({ windowStart: from, windowEnd: to })
  })

  it('stores one partition per Microsoft account and moves an account added again', () => {
    const db = openDb(':memory:')
    const a = upsertAccount(db, 'outlook', 'a@work.com', null, 1, 'persist:outlook-1')
    upsertAccount(db, 'outlook', 'c@other.com', null, 1, 'persist:outlook-2')
    upsertAccount(db, 'google', 'b@gmail.com', new Uint8Array([1]), 1)
    expect(listSessions(db).sort()).toEqual(['persist:outlook-1', 'persist:outlook-2'])

    expect(upsertAccount(db, 'outlook', 'a@work.com', null, 2, 'persist:outlook-3')).toBe(a)
    expect(getAccount(db, a)?.session).toBe('persist:outlook-3')
    // No partition given (e.g. Google): keep what is stored.
    upsertAccount(db, 'outlook', 'a@work.com', null, 3)
    expect(getAccount(db, a)?.session).toBe('persist:outlook-3')
  })
})
