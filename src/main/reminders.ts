import { app, BrowserWindow, nativeTheme, powerMonitor, screen, type Rectangle } from 'electron'
import { join } from 'node:path'
import type { Reminder, ReminderAction, Reminders } from '../shared/api'
import { snoozeUntil } from '../shared/reminders'
import type { Db } from './db/db'
import { getEvent } from './db/events'
import { ackReminder, listReminders } from './db/reminders'
import { notifyDataChanged } from './ipc'
import { appUrl, openExternal } from './security'

// Own windows, not Windows toasts: Do Not Disturb hides toasts, and a missed meeting is the worst case.
// The heads-up (notifications) sits bottom-right of the screen with the mouse and never takes focus.
// The alert (alarms) covers every screen, above full-screen apps, and rings until Join, Snooze or Dismiss (opening the
// event dismisses it too).

type ReminderWindow = 'heads-up' | 'alert'

// Short ticks with UTC compares: a long setTimeout drifts or fires late after sleep.
const TICK_INTERVAL = 5_000
const MARGIN = 16
const HEADS_UP_WIDTH = 360
const ALERT_WIDTH = 520
// Must match Reminder.svelte: MAX_ROWS, and the CSS heights of padding (alert: header included), rows and lines.
// Lines: the footer (+N more and Dismiss all) and the "Not synced lately" warning.
const MAX_ROWS = 3
const SIZES = {
  'heads-up': { padding: 16, row: 64, line: 24 },
  alert: { padding: 96, row: 120, line: 24 }
}

export interface ReminderScheduler {
  check(): void
  // What the reminder windows show. Skips what fired while the app was off, like check().
  list(): Reminders
  // snooze: one of SNOOZE_CHOICES.
  answer(eventId: number, action: ReminderAction, fireAt: number, snooze?: number): void
  dismiss(shown: { eventId: number; fireAt: number }[]): void
}

export function startReminders(db: Db, devUrl: string | undefined): ReminderScheduler {
  let headsUp: BrowserWindow | null = null
  let alerts: BrowserWindow[] = []
  let last = ''
  // Reminders that fired while the app was off are skipped.
  const since = Date.now()
  // QA: a dev run can ring only test events (titles that start with this), so real meetings do not ring twice.
  const only = app.isPackaged ? undefined : process.env['BUSY_PEASY_REMINDERS_ONLY']

  // Every window and answer reads this, so the dev filter has one place.
  function due(now: number): Reminders {
    const reminders = listReminders(db, now, since)
    if (only === undefined) return reminders
    // Empty rings nothing: an unset shell variable must not turn the filter off.
    const test = (r: Reminder): boolean => only !== '' && r.title.startsWith(only)
    return { ...reminders, headsUp: reminders.headsUp.filter(test), alerts: reminders.alerts.filter(test) }
  }

  function open(kind: ReminderWindow, bounds: Rectangle, sound: boolean): BrowserWindow {
    const window = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      title: 'Busy Peasy reminder',
      // Same as --surface in app.css (the card), so no white flash.
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#131314' : '#ffffff',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
        devTools: !app.isPackaged,
        // The alert sound must play without a click.
        autoplayPolicy: 'no-user-gesture-required'
      }
    })
    // "screen-saver" stays above full-screen apps and presentations.
    if (kind === 'alert') window.setAlwaysOnTop(true, 'screen-saver')
    // Keeps meeting titles out of screen shares and recordings. The user still sees the window.
    window.setContentProtection(true)
    // With a screen reader, a new alarm takes focus (only the one on the main screen, with sound), so it is read.
    // Electron's check is true for any assistive tool, not only screen readers. The heads-up never takes focus.
    const focus = kind === 'alert' && sound && app.isAccessibilitySupportEnabled()
    window.once('ready-to-show', () => (focus ? window.show() : window.showInactive()))
    void window.loadURL(appUrl(devUrl, `#reminder=${kind}${sound ? '&sound' : ''}${focus ? '&focus' : ''}`))
    return window
  }

  function height(kind: ReminderWindow, reminders: Reminders): number {
    const size = SIZES[kind]
    const count = kind === 'heads-up' ? reminders.headsUp.length : reminders.alerts.length
    const extra = (count > 1 ? 1 : 0) + (reminders.stale.length > 0 ? 1 : 0)
    return size.padding + size.row * Math.min(count, MAX_ROWS) + size.line * extra
  }

  function headsUpBounds(reminders: Reminders): Rectangle {
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    const h = height('heads-up', reminders)
    return { x: area.x + area.width - HEADS_UP_WIDTH - MARGIN, y: area.y + area.height - h - MARGIN, width: HEADS_UP_WIDTH, height: h }
  }

  function alertBounds(area: Rectangle, reminders: Reminders): Rectangle {
    const h = height('alert', reminders)
    return {
      x: area.x + Math.round((area.width - ALERT_WIDTH) / 2),
      y: area.y + Math.round((area.height - h) / 3),
      width: ALERT_WIDTH,
      height: h
    }
  }

  function closeAlerts(): void {
    for (const window of alerts) if (!window.isDestroyed()) window.destroy()
    alerts = []
  }

  function check(): void {
    // A dev run next to the installed app can turn its windows off, so real meetings do not ring twice. Never the
    // installed app: a variable left in a shell must not hide a meeting.
    if (!app.isPackaged && process.env['BUSY_PEASY_NO_REMINDERS']) return
    const reminders = due(Date.now())
    const changed = JSON.stringify(reminders) !== last
    last = JSON.stringify(reminders)

    if (headsUp?.isDestroyed()) headsUp = null
    if (reminders.headsUp.length === 0) {
      headsUp?.destroy()
      headsUp = null
    } else if (!headsUp) {
      headsUp = open('heads-up', headsUpBounds(reminders), false)
    } else if (changed) {
      // Grow or shrink in place, on the same screen.
      const bounds = headsUp.getBounds()
      const h = height('heads-up', reminders)
      headsUp.setBounds({ ...bounds, y: bounds.y + bounds.height - h, height: h })
    }

    if (reminders.alerts.length === 0) {
      closeAlerts()
    } else if (alerts.length === 0 || alerts.some((w) => w.isDestroyed())) {
      closeAlerts()
      // One sound for all screens: only the primary screen's window plays it.
      const primary = screen.getPrimaryDisplay().id
      alerts = screen.getAllDisplays().map((d) => open('alert', alertBounds(d.workArea, reminders), d.id === primary))
    } else if (changed) {
      for (const window of alerts) window.setBounds(alertBounds(screen.getDisplayMatching(window.getBounds()).workArea, reminders))
    }

    if (changed) notifyDataChanged({ accounts: false, calendars: false, events: false, reminders: true, settings: false })
  }

  setInterval(check, TICK_INTERVAL)
  // Waking up or unlocking near a meeting must alert at once, not on the next tick.
  powerMonitor.on('resume', check)
  powerMonitor.on('unlock-screen', check)
  // A screen added or removed: put the alert on the new set of screens.
  screen.on('display-added', () => (closeAlerts(), check()))
  screen.on('display-removed', () => (closeAlerts(), check()))

  return {
    check,
    list: () => due(Date.now()),
    // fireAt: when the reminder the user clicked in fired. The windows refresh only every tick, so main may
    // already show a later reminder, e.g. a notification dismissed just as the alarm fires must let the alarm come.
    answer(eventId, action, fireAt, snooze = 0) {
      const now = Date.now()
      const { headsUp, alerts } = due(now)
      const reminder = [...headsUp, ...alerts].find((r) => r.eventId === eventId)
      if (action === 'join') {
        // The reminder may have just ended (T+10). The click still opens the meeting.
        const event = getEvent(db, eventId)
        const url = reminder ? reminder.joinUrl : event?.joinUrl
        if (url) openExternal(url)
        // Every reminder fires before last (all-day: the end of the first day), so this ends them all.
        if (event) ackReminder(db, eventId, reminder?.last ?? event.end, null, now)
      } else if (action === 'snooze') {
        // fireAt - 1: ends the reminders that fired before (also missed ones), and the snoozed one comes back.
        // Only the reminder the user saw: a newer one that fired since must ring now (check() shows it).
        if (reminder?.fireAt === fireAt) ackReminder(db, eventId, fireAt - 1, snoozeUntil(now, reminder, snooze), now)
        else if (!reminder) {
          // Gone since the click (10 min after the start): the meeting still runs, so the click is not lost.
          const event = getEvent(db, eventId)
          // Acked as of the start, when the event and its copies are still in the list.
          if (event && !event.allDay && event.start < now && now < event.end) {
            ackReminder(db, eventId, fireAt - 1, snoozeUntil(now, { ...event, last: event.end, next: null }, snooze), event.start)
          }
        }
      } else if (action === 'dismiss') {
        ackReminder(db, eventId, fireAt, null, now)
      }
      check()
    },
    // One check after all, so the window does not change between them.
    dismiss(shown) {
      const now = Date.now()
      for (const r of shown) ackReminder(db, r.eventId, r.fireAt, null, now)
      check()
    }
  }
}
