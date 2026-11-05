import { app, BrowserWindow, dialog, Menu, safeStorage, session } from 'electron'
import { randomUUID } from 'node:crypto'
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Account } from '../shared/api'
import { findAccount, getAccount, upsertAccount } from './db/accounts'
import type { Db } from './db/db'
import { OutlookAuthError, type OutlookDeps, type OutlookToken } from './providers/outlook/client'
import { syncOutlookAccount } from './providers/outlook/sync'
import { parseOutlookToken } from './providers/outlook/token'
import { hardenOutlookSession, OUTLOOK_PARTITION } from './security'
import { NeedsSignInError } from './sync/scheduler'

// Outlook on the web runs in its own session. We open it only to sign in or to get a fresh token,
// read the bearer token it sends, and close it. The token lives in memory only.
// Each Microsoft account has its own partition (cookie jar), so several accounts can stay signed in.

const OUTLOOK_URL = 'https://outlook.cloud.microsoft/calendar/'
const LOGIN_HOSTS = new Set(['login.microsoftonline.com', 'login.microsoft.com', 'login.live.com'])
const RENEW_TIMEOUT = 60_000
// Outlook renews its own token only when less than 5 minutes are left; before that it hands back the same one.
const RENEW_BEFORE = 4 * 60_000

// Latest token per partition.
const tokens = new Map<string, OutlookToken>()
const listeners = new Set<(partition: string, token: OutlookToken) => void>()
const captured = new Set<string>()

// What the user types in Microsoft's sign-in form. Saved encrypted in the account's secret, to fill it next time.
export interface OutlookPassword {
  login: string
  password: string
}

// The password typed in the sign-in window, per partition. Kept only until that sign-in ends.
const typed = new Map<string, OutlookPassword>()

// Electron uses world 999 for preloads. The fill script runs in its own world, out of reach of the page's scripts.
const FILL_WORLD = 1000

export function newOutlookPartition(): string {
  return `${OUTLOOK_PARTITION}-${randomUUID()}`
}

// Hardens the session and starts reading its tokens the first time it is used.
function outlookSession(partition: string): Electron.Session {
  const s = session.fromPartition(partition)
  if (!captured.has(partition)) {
    captured.add(partition)
    hardenOutlookSession(s)
    captureTokens(partition, s)
    capturePassword(partition, s)
  }
  return s
}

function outlookToken(partition: string): OutlookToken | null {
  const token = tokens.get(partition)
  return token && token.exp > Date.now() + 60_000 ? token : null
}

// Microsoft keeps the sign-in (ESTSAUTH) and Outlook's token cache key (msal.cache.encryption) in session
// cookies, which die when the app quits. Like a browser's "continue where you left off", we save them
// encrypted and put them back at startup, so a restart does not ask for password and MFA again.
const SESSION_COOKIE_HOSTS = new Set([...LOGIN_HOSTS, 'outlook.cloud.microsoft', 'outlook.office.com'])

// The first account keeps its old file name: "persist:outlook" -> outlook-session.bin.
function sessionCookieFile(partition: string): string {
  return join(app.getPath('userData'), `outlook-session${partition.slice(OUTLOOK_PARTITION.length)}.bin`)
}

export async function saveOutlookSessionCookies(partition: string): Promise<void> {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) return
  const cookies = (await outlookSession(partition).cookies.get({})).filter(
    (c) => c.session && SESSION_COOKIE_HOSTS.has((c.domain ?? '').replace(/^\./, ''))
  )
  const file = sessionCookieFile(partition)
  // Write then rename, so a crash mid-write never leaves a broken file.
  await writeFile(file + '.tmp', await safeStorage.encryptStringAsync(JSON.stringify(cookies)))
  await rename(file + '.tmp', file)
}

export async function restoreOutlookSessionCookies(partition: string): Promise<void> {
  let saved: Electron.Cookie[]
  try {
    const { result } = await safeStorage.decryptStringAsync(await readFile(sessionCookieFile(partition)))
    saved = JSON.parse(result) as Electron.Cookie[]
  } catch {
    return // No saved session yet, or it cannot be read: the user signs in again.
  }
  for (const c of saved) {
    const host = (c.domain ?? '').replace(/^\./, '')
    // No expirationDate: they stay session cookies.
    await outlookSession(partition)
      .cookies.set({
        url: `https://${host}${c.path ?? '/'}`,
        name: c.name,
        value: c.value,
        domain: c.hostOnly ? undefined : c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite
      })
      .catch(() => {})
  }
}

// Electron cannot delete a partition folder while its session is loaded. So folders nobody uses any more
// (a sign-in that was closed, a removed account) are deleted at the next start, before any session opens.
export async function removeUnusedPartitions(keep: string[]): Promise<void> {
  const dir = join(app.getPath('userData'), 'Partitions')
  const used = new Set(keep.map((partition) => partition.slice('persist:'.length)))
  for (const name of await readdir(dir).catch(() => [])) {
    if ((name === 'outlook' || name.startsWith('outlook-')) && !used.has(name)) {
      await rm(join(dir, name), { recursive: true, force: true })
    }
  }
}

export async function forgetOutlookSession(partition: string): Promise<void> {
  tokens.delete(partition)
  await rm(sessionCookieFile(partition), { force: true })
  await outlookSession(partition).clearStorageData()
}

export async function readOutlookPassword(secret: Uint8Array): Promise<OutlookPassword | undefined> {
  try {
    const { result } = await safeStorage.decryptStringAsync(Buffer.from(secret))
    return JSON.parse(result) as OutlookPassword
  } catch {
    return undefined // It cannot be read: the user types the password.
  }
}

// Like a browser: after a sign-in with a typed password, offer to keep it for the next sign-in.
export async function askToSavePassword(db: Db, email: string, password: OutlookPassword): Promise<void> {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) return
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: 'Busy Peasy',
    message: `Save the Microsoft password for ${email}?`,
    detail: 'Busy Peasy fills it in the next time Microsoft asks you to sign in. It is stored encrypted on this computer.',
    buttons: ['Save', 'Not now'],
    defaultId: 0,
    cancelId: 1
  })
  // The account may be removed while the question is open.
  if (response !== 0 || !findAccount(db, 'outlook', email)) return
  upsertAccount(db, 'outlook', email, await safeStorage.encryptStringAsync(JSON.stringify(password)), Date.now())
}

function captureTokens(partition: string, s: Electron.Session): void {
  const urls = ['https://outlook.cloud.microsoft/*', 'https://outlook.office.com/*']
  s.webRequest.onBeforeSendHeaders({ urls }, (details, callback) => {
    try {
      const headers = Object.fromEntries(Object.entries(details.requestHeaders).map(([k, v]) => [k.toLowerCase(), v]))
      const token = parseOutlookToken(headers['authorization'], headers['x-anchormailbox'], Date.now())
      const current = tokens.get(partition)
      if (token && (!current || token.exp > current.exp || token.upn !== current.upn)) {
        tokens.set(partition, token)
        for (const listener of listeners) listener(partition, token)
      }
    } catch {
      // Never break Outlook's own requests.
    }
    callback({})
  })
}

// Microsoft's sign-in form posts the email in "loginfmt" (or "login") and the password in "passwd".
function capturePassword(partition: string, s: Electron.Session): void {
  const urls = [...LOGIN_HOSTS].map((host) => `https://${host}/*`)
  s.webRequest.onBeforeRequest({ urls }, (details, callback) => {
    try {
      const body = details.method === 'POST' ? details.uploadData?.[0]?.bytes : undefined
      if (body) {
        const form = new URLSearchParams(body.toString())
        const login = form.get('loginfmt') || form.get('login')
        const password = form.get('passwd')
        if (login && password) typed.set(partition, { login, password })
      }
    } catch {
      // Never break Microsoft's own requests.
    }
    callback({})
  })
}

// Fills each visible, empty email and password field once. Microsoft shows the password step without a page load,
// so the script keeps looking. The input events let the page see the value. The user still clicks Sign in.
function fillScript({ login, password }: OutlookPassword): string {
  return `(() => {
    const done = new WeakSet()
    const fill = (selector, value) => {
      for (const input of document.querySelectorAll(selector)) {
        if (done.has(input) || input.value || input.offsetParent === null) continue
        done.add(input)
        input.value = value
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
      }
    }
    setInterval(() => {
      fill('input[type=email], input[name=loginfmt]', ${JSON.stringify(login)})
      fill('input[type=password]', ${JSON.stringify(password)})
    }, 500)
  })()`
}

interface SignInResult {
  partition: string
  token: OutlookToken
  // The password typed in this sign-in, to offer saving it.
  typed?: OutlookPassword
}

interface PendingSignIn {
  window: BrowserWindow | null
  partition: string
  fresh: boolean
  promise: Promise<SignInResult>
}

let signIn: PendingSignIn | null = null

// Shows Outlook so the user can sign in. Resolves with the first calendar token.
// Only one sign-in window at a time. Calling it again while the window is open starts over in the same
// window (e.g. after a Microsoft error page), so the result may be for the partition of the first call.
// Only the same sign-in may start over: a new account (fresh) or the same account's partition.
// Anyone else would share the result and save or wipe the wrong account's cookies.
// A fresh partition is wiped if the sign-in fails, so no half signed-in cookie jar stays on disk.
// saved: the account's saved password, filled in the sign-in form.
export function signInOutlook(partition: string, fresh: boolean, saved?: OutlookPassword): Promise<SignInResult> {
  if (signIn?.window && !signIn.window.isDestroyed()) {
    if (fresh !== signIn.fresh || (!fresh && partition !== signIn.partition)) {
      return Promise.reject(new Error('Finish or close the open Microsoft sign-in first.'))
    }
    void signIn.window.loadURL(OUTLOOK_URL)
    signIn.window.show()
    signIn.window.focus()
    return signIn.promise
  }
  const pending: PendingSignIn = { window: null, partition, fresh, promise: null! }
  pending.promise = openOutlook(partition, { show: true, fill: saved, accept: () => true, onWindow: (w) => (pending.window = w) })
    .then(
      (token) => ({ partition, token, typed: typed.get(partition) }),
      async (error) => {
        if (fresh) await forgetOutlookSession(partition)
        throw error
      }
    )
    .finally(() => {
      typed.delete(partition)
      if (signIn === pending) signIn = null
    })
  signIn = pending
  return pending.promise
}

export function syncOutlook(db: Db, account: Account): Promise<void> {
  return withOutlook(db, account, async (deps, partition) => {
    await syncOutlookAccount({ ...deps, db, now: Date.now }, account.id)
    // Microsoft rotates its cookies, so keep the saved copy fresh. Also covers a crash or a reboot.
    await saveOutlookSessionCookies(partition)
  })
}

// Runs fn with a fresh token for the account. A rejected token is renewed once and fn runs again.
export async function withOutlook<T>(
  db: Db,
  account: Pick<Account, 'id' | 'email'>,
  fn: (deps: OutlookDeps, partition: string) => Promise<T>
): Promise<T> {
  const partition = getAccount(db, account.id)?.session
  if (!partition) throw new NeedsSignInError('Microsoft sign-in needed')
  const s = outlookSession(partition)
  const deps: OutlookDeps = {
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    fetch: s.fetch.bind(s) as typeof fetch,
    getToken: () => outlookToken(partition)
  }
  const current = tokens.get(partition)
  if (!current || current.exp - Date.now() < RENEW_BEFORE) await renewOutlookToken(partition, account.email)
  try {
    return await fn(deps, partition)
  } catch (error) {
    if (!(error instanceof OutlookAuthError)) throw error
    tokens.delete(partition)
    await renewOutlookToken(partition, account.email)
    return await fn(deps, partition)
  }
}

// Loads Outlook hidden and waits for a newer token. Call it late (see RENEW_BEFORE).
function renewOutlookToken(partition: string, upn: string): Promise<OutlookToken> {
  const old = tokens.get(partition)
  return openOutlook(partition, {
    show: false,
    timeout: RENEW_TIMEOUT,
    accept: (token) => token.upn === upn && (!old || token.exp > old.exp)
  })
}

function openOutlook(
  partition: string,
  options: {
    show: boolean
    timeout?: number
    fill?: OutlookPassword
    accept(token: OutlookToken): boolean
    onWindow?(window: BrowserWindow): void
  }
): Promise<OutlookToken> {
  return new Promise((resolve, reject) => {
    // Before the window exists, so its web contents get the Outlook rules.
    outlookSession(partition)
    const window = new BrowserWindow({
      width: 1100,
      height: 800,
      show: options.show,
      title: 'Sign in to Microsoft 365 - Busy Peasy',
      autoHideMenuBar: true,
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
        // Outlook must run its sign-in code while hidden.
        backgroundThrottling: false
      }
    })
    // Keep our title: the user should know this window belongs to the app.
    window.on('page-title-updated', (event) => event.preventDefault())
    // Electron has no right-click menu by default. Offer the edit actions, e.g. to paste a password.
    window.webContents.on('context-menu', (_, params) => {
      const { canCut, canCopy, canPaste, canSelectAll } = params.editFlags
      Menu.buildFromTemplate([
        { role: 'cut', enabled: canCut },
        { role: 'copy', enabled: canCopy },
        { role: 'paste', enabled: canPaste },
        { type: 'separator' },
        { role: 'selectAll', enabled: canSelectAll }
      ]).popup({ window })
    })
    const fill = options.fill
    if (fill) {
      window.webContents.on('dom-ready', () => {
        const host = URL.parse(window.webContents.getURL())?.hostname ?? ''
        if (!LOGIN_HOSTS.has(host)) return
        void window.webContents.executeJavaScriptInIsolatedWorld(FILL_WORLD, [{ code: fillScript(fill) }]).catch(() => {})
      })
    }
    options.onWindow?.(window)

    let timer: NodeJS.Timeout | undefined
    let done = false
    const finish = (error: Error | null, token?: OutlookToken): void => {
      if (done) return
      done = true
      listeners.delete(onToken)
      clearTimeout(timer)
      if (!window.isDestroyed()) window.destroy()
      if (error) reject(error)
      else resolve(token!)
    }
    const onToken = (from: string, token: OutlookToken): void => {
      if (from === partition && options.accept(token)) finish(null, token)
    }
    listeners.add(onToken)
    window.on('closed', () => finish(new Error('Microsoft sign-in was closed')))
    if (options.timeout) {
      timer = setTimeout(() => {
        const host = URL.parse(window.webContents.getURL())?.hostname ?? ''
        finish(LOGIN_HOSTS.has(host) ? new NeedsSignInError('Microsoft sign-in needed') : new Error('Outlook did not respond'))
      }, options.timeout)
    }
    void window.loadURL(OUTLOOK_URL)
  })
}
