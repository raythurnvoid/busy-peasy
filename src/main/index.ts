import { app, BrowserWindow, Menu, nativeTheme, Notification } from 'electron'
import { join } from 'node:path'
// Unpacked: an outside Node runs it, and it cannot read inside app.asar.
import cli from '../../resources/busy-peasy.mjs?asset&asarUnpack'
import icon from '../../resources/icon.png?asset'
import type { CalendarEvent } from '../shared/api'
import { readAgentAccess, startAgent } from './agent'
import { createApi } from './api'
import { listAccounts, listSessions } from './db/accounts'
import { openDb } from './db/db'
import { getEvent } from './db/events'
import { getSettings } from './db/settings'
import { syncGoogle } from './google-session'
import { askPage, notifyDataChanged, registerApi, trackWrite, writesDone } from './ipc'
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
import { downloadedUpdate, installUpdate, startUpdates } from './updater'

const APP_ID = 'bonobo-senate.busypeasy'
const POLL_INTERVAL = 2 * 60_000
// Focusing the window syncs, but not more often than this.
const FOCUS_SYNC_GAP = 30_000
const devUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL']

let mainWindow: BrowserWindow | null = null

let scheduler: SyncScheduler
// Starts after the tray, which first reads the saved access itself.
let agent: ReturnType<typeof startAgent> | undefined
let lastFocusSync = 0
let quitting = false
let flushed = false
// Set by the tray's restart item or the page's update banner: this quit installs the downloaded update and starts the
// app again.
let restartToUpdate = false

// Same as --stone-1 in renderer/src/styles/palazzo-core.css (the shell), so the window never shows white before the
// page paints.
const background = (): string => (nativeTheme.shouldUseDarkColors ? '#1c150f' : '#f6efe3')

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

// With Full access, commands that open something for the user bring the window up. Not with Read only: a popover in
// a window that takes focus would get the user's next Delete key. The rest works in the hidden window too.
function agentCommand(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (!mainWindow) return Promise.reject(new Error('Busy Peasy is quitting.'))
  if (agent?.access() === 'full' && ['openEvent', 'editEvent', 'openNewEvent', 'openSettings'].includes(name)) showMainWindow()
  return askPage(mainWindow.webContents, name, args)
}

// A trusted key press, so native behavior works too: Escape closes a dialog, Enter submits a form.
async function pressKey(key: string): Promise<void> {
  if (!mainWindow) throw new Error('Busy Peasy is quitting.')
  const parts = key.split('+')
  const keyCode = parts.pop()!
  const modifiers = parts.map((m) => m.toLowerCase()) as Electron.KeyboardInputEvent['modifiers']
  const contents = mainWindow.webContents
  contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  // A letter also types into a focused field, but not with Ctrl or Alt: Control+a must select, not type "a".
  if (keyCode.length === 1 && !modifiers?.some((m) => m !== 'shift')) contents.sendInputEvent({ type: 'char', keyCode, modifiers })
  contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
}

// stayHidden: also while the window is in the tray. A JPEG at most 1280 px wide: a full-size PNG is over 1 MB, too much
// for an agent.
async function screenshot(): Promise<string> {
  if (!mainWindow) throw new Error('Busy Peasy is quitting.')
  const image = await mainWindow.webContents.capturePage(undefined, { stayHidden: true })
  return image.resize({ width: Math.min(1280, image.getSize().width) }).toJPEG(80).toString('base64')
}

// Chromium shows the page to Windows UI Automation only for screen readers it knows, so other UIA tools (agents, test
// tools) see an empty window. Never turned off here: a screen reader may need it. It costs some speed, so only with
// agent access.
function exposeToUiAutomation(): void {
  if (agent?.access() !== 'off') app.setAccessibilitySupportEnabled(true)
}

// With these switches any program on this PC could restart the installed app and take it over, Outlook sign-in included.
// Removed here, before Chromium starts its DevTools server. Dev runs keep them for Playwright and Playwriter.
if (app.isPackaged) for (const name of ['remote-debugging-port', 'remote-debugging-pipe']) app.commandLine.removeSwitch(name)
registerAppScheme()
app.enableSandbox()
// Dev runs keep their own data (DB, Outlook cookies) apart from the installed app.
if (!app.isPackaged) app.setPath('userData', app.getPath('userData') + '-dev')
if (app.isPackaged) Menu.setApplicationMenu(null)

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // The agent CLI starts the app with --hidden when it finds no agent API: that must not bring up the window.
  app.on('second-instance', (_, argv) => !argv.includes(HIDDEN_ARG) && showMainWindow())

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
    // The tray item and the page's update banner.
    const restartAndUpdate = (): void => {
      restartToUpdate = true
      app.quit()
    }
    const tray = createTray({
      open: showMainWindow,
      signIn: signInAgain,
      syncNow: () => void scheduler.syncNow(),
      update: restartAndUpdate,
      agentAccess: () => agent?.access() ?? readAgentAccess(app.getPath('userData')),
      setAgentAccess: (access) => {
        agent?.setAccess(access)
        exposeToUiAutomation()
      },
      quit: () => app.quit()
    })
    // Also at start and at every poll: a sync run where every account is signed out sends no notify.
    const showSignedOut = (): void => tray.showSignedOut(listAccounts(db).filter((a) => a.status === 'needs-sign-in'))
    showSignedOut()
    startUpdates((version) => {
      tray.showUpdate(version)
      mainWindow?.webContents.send('update-ready', version)
    })
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
    const api = createApi(db, scheduler, reminders, showSignedOut, showEvent, {
      version: downloadedUpdate,
      install: restartAndUpdate
    })
    registerApi(api, devUrl)
    agent = startAgent({
      api,
      dir: app.getPath('userData'),
      cli,
      version: app.getVersion(),
      getEvent: (eventId) => getEvent(db, eventId),
      command: agentCommand,
      press: pressKey,
      screenshot,
      track: trackWrite
    })
    exposeToUiAutomation()
    app.on('quit', () => agent?.stop())
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
      // After the flush: the installer kills the app soon after it starts. A plain Quit with a downloaded update
      // installs it too, on 'quit', but does not start the app again. If the install fails, this still quits.
      if (restartToUpdate) installUpdate()
      app.quit()
    }
    void flush().then(done, done)
  })

  // The app lives in the tray; it quits only from the tray menu.
  app.on('window-all-closed', () => {})
}
