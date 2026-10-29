import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { syncCalendarList, upsertAccount } from './db/accounts'
import { openDb, type Db } from './db/db'
import { upsertEvents } from './db/events'
import { listReminders, saveEventReminders } from './db/reminders'
import { saveSettings } from './db/settings'
import { notifyDataChanged } from './ipc'
import { toRecord } from './providers/google/map'
import { startReminders } from './reminders'

const electron = vi.hoisted(() => ({ app: { isPackaged: false } }))
vi.mock('electron', () => ({
  app: electron.app,
  BrowserWindow: vi.fn(),
  nativeTheme: {},
  powerMonitor: { on: vi.fn() },
  screen: { on: vi.fn() }
}))
vi.mock('./ipc', () => ({ notifyDataChanged: vi.fn() }))
vi.mock('./security', () => ({ appUrl: vi.fn(), openExternal: vi.fn() }))

const MIN = 60_000
const T0 = Date.UTC(2026, 10, 16, 9)

let db: Db

// A Google event at T0 with a 15 min notification. The settings add a 10 min alarm.
function add(id: string, title: string): void {
  const start = { dateTime: new Date(T0).toISOString() }
  const end = { dateTime: new Date(T0 + 30 * MIN).toISOString() }
  upsertEvents(
    db,
    1,
    [
      toRecord({
        id,
        summary: title,
        start,
        end,
        reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 15 }] }
      })
    ],
    0
  )
}

const titles = (list: { title: string }[]): string[] => list.map((r) => r.title)

beforeEach(() => {
  vi.useFakeTimers({ now: T0 - 60 * MIN })
  // No windows in tests: check() stops at once.
  process.env['BUSY_PEASY_NO_REMINDERS'] = '1'
  electron.app.isPackaged = false
  db = openDb(':memory:')
  const account = upsertAccount(db, 'google', 'me@gmail.com', null, 0)
  syncCalendarList(db, account, [
    {
      remoteId: 'me',
      name: 'Me',
      color: '#000',
      canEdit: true,
      isPrimary: true,
      defaultReminders: [],
      conference: null
    }
  ])
  saveSettings(db, { eventReminders: [{ minutes: 10, alarm: true }] })
  add('a', 'BP test - ignore F10 A')
  add('b', 'Weekly sync')
})

afterEach(() => {
  vi.useRealTimers()
  delete process.env['BUSY_PEASY_NO_REMINDERS']
  delete process.env['BUSY_PEASY_REMINDERS_ONLY']
})

describe('startReminders', () => {
  it('in a dev run with BUSY_PEASY_REMINDERS_ONLY, shows only events whose title starts with it', () => {
    process.env['BUSY_PEASY_REMINDERS_ONLY'] = 'BP test - ignore'
    const reminders = startReminders(db, undefined)
    vi.setSystemTime(T0 - 15 * MIN)
    expect(titles(reminders.list().headsUp)).toEqual(['BP test - ignore F10 A'])
    vi.setSystemTime(T0 - 10 * MIN)
    expect(titles(reminders.list().alerts)).toEqual(['BP test - ignore F10 A'])
  })

  it('with an empty BUSY_PEASY_REMINDERS_ONLY, rings nothing', () => {
    process.env['BUSY_PEASY_REMINDERS_ONLY'] = ''
    const reminders = startReminders(db, undefined)
    vi.setSystemTime(T0 - 10 * MIN)
    expect(reminders.list().alerts).toEqual([])
  })

  it('in the installed app, ignores BUSY_PEASY_REMINDERS_ONLY', () => {
    process.env['BUSY_PEASY_REMINDERS_ONLY'] = 'BP test - ignore'
    electron.app.isPackaged = true
    const reminders = startReminders(db, undefined)
    vi.setSystemTime(T0 - 10 * MIN)
    expect(titles(reminders.list().alerts)).toEqual(['BP test - ignore F10 A', 'Weekly sync'])
  })

  it('in the installed app, ignores BUSY_PEASY_NO_REMINDERS', () => {
    // A check with nothing due still tells the windows once; a check that stops at once tells nobody.
    vi.mocked(notifyDataChanged).mockClear()
    const reminders = startReminders(db, undefined)
    reminders.check()
    expect(notifyDataChanged).not.toHaveBeenCalled()
    electron.app.isPackaged = true
    reminders.check()
    expect(notifyDataChanged).toHaveBeenCalledOnce()
  })

  it('a snooze from a window never goes past the next reminder', () => {
    // A: notifications 15 and 12 min before. An alarm would also end the snooze by itself.
    const { id } = db.prepare('SELECT id FROM calendars').get() as { id: number }
    saveEventReminders(
      db,
      id,
      'a',
      [
        { minutes: 15, alarm: false },
        { minutes: 12, alarm: false }
      ],
      [15],
      false
    )
    const reminders = startReminders(db, undefined)
    vi.setSystemTime(T0 - 15 * MIN)
    const [shown] = reminders.list().headsUp.filter((r) => r.eventId === 1)
    reminders.answer(shown.eventId, 'snooze', shown.fireAt, 30)
    expect(listReminders(db, T0 - 12 * MIN - 1).headsUp.filter((r) => r.eventId === 1)).toEqual([])
    expect(
      listReminders(db, T0 - 12 * MIN)
        .headsUp.filter((r) => r.eventId === 1)
        .map((r) => r.fireAt)
    ).toEqual([T0 - 12 * MIN])
  })

  it('a snooze on a row that is no longer the one due does nothing, so the newer reminder shows', () => {
    // A: notifications 15 and 12 min before.
    const { id } = db.prepare('SELECT id FROM calendars').get() as { id: number }
    saveEventReminders(
      db,
      id,
      'a',
      [
        { minutes: 15, alarm: false },
        { minutes: 12, alarm: false }
      ],
      [15],
      false
    )
    const reminders = startReminders(db, undefined)
    vi.setSystemTime(T0 - 15 * MIN)
    const [shown] = reminders.list().headsUp.filter((r) => r.eventId === 1)
    // The 12 min one fired 2 s ago; the window still shows the 15 min one until the next tick.
    vi.setSystemTime(T0 - 12 * MIN + 2000)
    reminders.answer(shown.eventId, 'snooze', shown.fireAt, 0)
    expect(
      reminders
        .list()
        .headsUp.filter((r) => r.eventId === 1)
        .map((r) => r.fireAt)
    ).toEqual([T0 - 12 * MIN])
  })

  it('after a snooze, a reminder missed while the app was off stays missed, and Dismiss ends them all', () => {
    // A: 1 day before (alarm) and 15 min before. The app starts at T-30, after the alarm fired.
    const { id } = db.prepare('SELECT id FROM calendars').get() as { id: number }
    saveEventReminders(
      db,
      id,
      'a',
      [
        { minutes: 1440, alarm: true },
        { minutes: 15, alarm: false }
      ],
      [15],
      false
    )
    vi.setSystemTime(T0 - 30 * MIN)
    const reminders = startReminders(db, undefined)
    vi.setSystemTime(T0 - 15 * MIN)
    const [shown] = reminders.list().headsUp.filter((r) => r.eventId === 1)
    reminders.answer(shown.eventId, 'snooze', shown.fireAt, 0)
    vi.setSystemTime(T0 - MIN)
    const back = reminders.list()
    expect(back.alerts.filter((r) => r.eventId === 1)).toEqual([])
    expect(back.headsUp.filter((r) => r.eventId === 1).map((r) => r.fireAt)).toEqual([
      T0 - 15 * MIN
    ])
    reminders.answer(1, 'dismiss', T0 - 15 * MIN)
    expect(
      [...reminders.list().headsUp, ...reminders.list().alerts].filter((r) => r.eventId === 1)
    ).toEqual([])
  })

  it('a Snooze click just after the meeting left the list still snoozes it', () => {
    const reminders = startReminders(db, undefined)
    vi.setSystemTime(T0 + 9 * MIN)
    const [shown] = reminders.list().alerts
    vi.setSystemTime(T0 + 10 * MIN + 1000)
    expect(reminders.list().alerts).toEqual([])
    reminders.answer(shown.eventId, 'snooze', shown.fireAt, 0)
    vi.setSystemTime(T0 + 15 * MIN + 1000)
    expect(reminders.list().alerts.map((r) => `${r.title}:${r.stage}`)).toEqual([
      'BP test - ignore F10 A:started'
    ])
  })

  it('dismiss all dismisses every reminder it gets', () => {
    const reminders = startReminders(db, undefined)
    vi.setSystemTime(T0 - 15 * MIN)
    reminders.dismiss(reminders.list().headsUp)
    expect(reminders.list().headsUp).toEqual([])
    // The alarm still comes.
    vi.setSystemTime(T0 - 10 * MIN)
    expect(reminders.list().alerts).toHaveLength(2)
  })
})
