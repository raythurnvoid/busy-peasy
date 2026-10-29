import { app, BrowserWindow, Menu, nativeTheme, Notification } from 'electron'
import { join } from 'node:path'
import icon from '../../resources/icon.png?asset'
import type { CalendarEvent } from '../shared/api'
import { createApi } from './api'
import { listAccounts, listSessions } from './db/accounts'
import { openDb } from './db/db'
import { getSettings } from './db/settings'
import { syncGoogle } from './google-session'
import { notifyDataChanged, registerApi, writesDone } from './ipc'
import {
  removeUnusedPartitions,
  restoreOutlookSessionCookies,
  saveOutlookSessionCookies,
  syncOutlook
} from './outlook-session'
import { startReminders } from './reminders'
import { appUrl, handleAppProtocol, hardenApp, registerAppScheme } from './security'
import { createSyncScheduler, type SyncScheduler } from './sync/scheduler'
import { createTray, enableStartAtLoginOnce, HIDDEN_ARG } from './tray'

const APP_ID = 'bonobo-senate.busypeasy'
const POLL_INTERVAL = 2 * 60_000
// Focusing the window syncs, but not more often than this.
const FOCUS_SYNC_GAP = 30_000
const devUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL']

let mainWindow: BrowserWindow | null = null

let scheduler: SyncScheduler
let lastFocusSync = 0
let quitting = false
let flushed = false

// Same as --surface-low in app.css, so the window never shows white before the page paints.
const background = (): string => (nativeTheme.shouldUseDarkColors ? '#1b1b1b' : '#f8fafd')

function createMainWindow(show: boolean): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: background(),
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      devTools: !app.isPackaged
    }
  })
  if (show) mainWindow.on('ready-to-show', () => mainWindow?.show())
  // Closing hides to the tray: syncing and reminders must keep running.
  mainWindow.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    mainWindow?.hide()
  })
  mainWindow.on('closed', () => (mainWindow = null))
  mainWindow.on('focus', () => {
    if (Date.now() - lastFocusSync < FOCUS_SYNC_GAP) return
    lastFocusSync = Date.now()
    void scheduler.syncNow()
  })
  void mainWindow.loadURL(appUrl(devUrl))
}

async function flush(): Promise<void> {
  const deadline = Date.now() + 10_000
  const window = mainWindow
  if (window) {
    const closed = new Promise<void>((r) => window.once('closed', () => r()))
    window.close()
    await Promise.race([closed, new Promise<void>((r) => setTimeout(r, deadline - Date.now()))])
    if (!window.isDestroyed()) window.destroy()
  }
  await writesDone(Math.max(0, deadline - Date.now()))
}

function showMainWindow(): void {
  // While quitting, a tray Open, a toast click or a second app start makes no new window.
  if (quitting) return
  if (!mainWindow) return createMainWindow(true)
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

// The tray and the toast start the same sign-in as the banner. The page runs it, so it shows "Start over" and errors.
function signInAgain(accountId: number): void {
  showMainWindow()
  mainWindow?.webContents.send('sign-in', accountId)
}

// A click on a reminder's text. The page goes to the event's day and opens its popover.
function showEvent(event: CalendarEvent | null): void {
  showMainWindow()
  if (event) mainWindow?.webContents.send('show-event', event)
}

registerAppScheme()
app.enableSandbox()
// Dev runs keep their own data (DB, Outlook cookies) apart from the installed app.
if (!app.isPackaged) app.setPath('userData', app.getPath('userData') + '-dev')
if (app.isPackaged) Menu.setApplicationMenu(null)

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showMainWindow)

  void app.whenReady().then(async () => {
    // Dev runs get their own id, so a click on a dev toast never goes to the installed app.
    if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? APP_ID : APP_ID + '.dev')
    hardenApp(devUrl)
    handleAppProtocol()
    const db = openDb(join(app.getPath('userData'), 'busy-peasy.db'))
    // Before any window opens, so every window starts in the saved theme.
    nativeTheme.themeSource = getSettings(db).theme
    await removeUnusedPartitions(listSessions(db))
    for (const partition of listSessions(db)) await restoreOutlookSessionCookies(partition)
    app.on('before-quit', () => {
      for (const partition of listSessions(db)) void saveOutlookSessionCookies(partition)
    })
    enableStartAtLoginOnce(listAccounts(db).length === 0)
    const reminders = startReminders(db, devUrl)
    const updateTray = createTray({
      open: showMainWindow,
      signIn: signInAgain,
      syncNow: () => void scheduler.syncNow(),
      quit: () => app.quit()
    })
    // Also at start and at every poll: a sync run where every account is signed out sends no notify.
    const showSignedOut = (): void => updateTray(listAccounts(db).filter((a) => a.status === 'needs-sign-in'))
    showSignedOut()
    scheduler = createSyncScheduler({
      db,
      now: Date.now,
      notify: (change) => {
        notifyDataChanged(change)
        // New or moved events can be due now.
        if (change.events) reminders.check()
        if (change.accounts) showSignedOut()
      },
      syncAccount: (account) =>
        account.provider === 'outlook' ? syncOutlook(db, account) : syncGoogle(db, account),
      // Missing a meeting is worse than a popup: the first time, bring the app up and say so. Repeats are only a toast.
      onNeedsSignIn: (account, first) => {
        if (first) showMainWindow()
        if (!Notification.isSupported()) return
        // The same id (the toast's Tag) replaces the account's older toast, also one from an earlier app run.
        new Notification({
          id: `sign-in-${account.id}`,
          title: 'Sign in again to keep your calendar up to date',
          body: `${account.email} is signed out. Its events and reminders may be out of date until you sign in.`
        }).show()
      }
    })
    registerApi(createApi(db, scheduler, reminders, showSignedOut, showEvent), devUrl)
    reminders.check()
    createMainWindow(!process.argv.includes(HIDDEN_ARG))
    // Every toast is a sign-in notice. This also gets clicks from the Notification Center and from an earlier app run,
    // but not which toast it was: with one signed-out account start its sign-in, else the banner lets the user pick.
    Notification.handleActivation(() => {
      const signedOut = listAccounts(db).filter((a) => a.status === 'needs-sign-in')
      if (signedOut.length === 1) signInAgain(signedOut[0].id)
      else showMainWindow()
    })
    lastFocusSync = Date.now()
    void scheduler.syncNow()
    setInterval(() => {
      showSignedOut()
      void scheduler.syncNow()
    }, POLL_INTERVAL)

    app.on('activate', showMainWindow)
    // The main window lives for days in the tray, and Windows can switch light/dark meanwhile.
    nativeTheme.on('updated', () => mainWindow?.setBackgroundColor(background()))
  })

  // Quit closes the page first, so it sends a delete or "No" still in its Undo time, and waits for it (10 s at most).
  app.on('before-quit', (event) => {
    if (flushed) return
    event.preventDefault()
    if (quitting) return
    quitting = true
    // Also on a failed flush: else quitting stays true and every later Quit is ignored.
    const done = (): void => {
      flushed = true
      app.quit()
    }
    void flush().then(done, done)
  })

  // The app lives in the tray; it quits only from the tray menu.
  app.on('window-all-closed', () => {})
}
