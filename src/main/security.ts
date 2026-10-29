import { app, net, protocol, session, shell, type Session } from 'electron'
import { join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export const APP_SCHEME = 'app'
export const APP_ORIGIN = 'app://busy-peasy'
export const OUTLOOK_PARTITION = 'persist:outlook'

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')

// Vite dev server injects <style> tags and talks to its HMR socket.
const DEV_CSP = CSP.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'").replace(
  "connect-src 'self'",
  "connect-src 'self' ws://localhost:*"
)

// Exact hosts the Outlook window may show in its main frame. Subresources and iframes are not checked.
const OUTLOOK_HOSTS = new Set([
  'login.microsoftonline.com',
  'login.microsoft.com',
  'login.live.com',
  'outlook.cloud.microsoft',
  'outlook.office.com',
  'outlook.office365.com',
  'autologon.microsoftazuread-sso.com',
  'device.login.microsoftonline.com',
  'mysignins.microsoft.com'
])

export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }
  ])
}

// Serves the built renderer from out/renderer with a strict CSP.
export function handleAppProtocol(): void {
  const root = normalize(join(__dirname, '../renderer'))
  protocol.handle(APP_SCHEME, async (request) => {
    const { host, pathname } = new URL(request.url)
    const file = normalize(join(root, decodeURIComponent(pathname === '/' ? '/index.html' : pathname)))
    if (host !== 'busy-peasy' || !file.startsWith(root + sep)) return new Response('Not found', { status: 404 })
    const response = await net.fetch(pathToFileURL(file).toString())
    const headers = new Headers(response.headers)
    headers.set('Content-Security-Policy', CSP)
    return new Response(response.body, { status: response.status, headers })
  })
}

export function appUrl(devUrl: string | undefined, hash = ''): string {
  return (devUrl ?? `${APP_ORIGIN}/index.html`) + hash
}

export function isAppOrigin(url: string, devUrl: string | undefined): boolean {
  try {
    const { protocol: scheme, host, origin } = new URL(url)
    // Node's URL gives origin "null" for custom schemes, so check app:// by its parts.
    if (scheme === `${APP_SCHEME}:`) return host === 'busy-peasy'
    return devUrl !== undefined && origin === new URL(devUrl).origin
  } catch {
    return false
  }
}

export function isOutlookHost(url: string): boolean {
  try {
    const { protocol: scheme, hostname } = new URL(url)
    return scheme === 'https:' && OUTLOOK_HOSTS.has(hostname)
  } catch {
    return false
  }
}

export function openExternal(url: string): void {
  try {
    const { protocol: scheme } = new URL(url)
    if (scheme === 'https:' || scheme === 'http:') void shell.openExternal(url)
  } catch {
    // Not a URL: ignore.
  }
}

// One per Microsoft account. Windows in these sessions follow the Outlook navigation rules.
const outlookSessions = new WeakSet<Session>()

export function hardenOutlookSession(s: Session): void {
  if (outlookSessions.has(s)) return
  outlookSessions.add(s)
  denyPermissions(s)
}

export function hardenApp(devUrl: string | undefined): void {
  denyPermissions(session.defaultSession)

  if (devUrl) {
    session.defaultSession.webRequest.onHeadersReceived({ urls: [`${new URL(devUrl).origin}/*`] }, (details, callback) => {
      callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [DEV_CSP] } })
    })
  }

  app.on('web-contents-created', (_, contents) => {
    const isOutlook = outlookSessions.has(contents.session)
    const allowed = (url: string): boolean => (isOutlook ? isOutlookHost(url) : isAppOrigin(url, devUrl))
    contents.on('will-navigate', (event) => {
      if (allowed(event.url)) return
      event.preventDefault()
      // Links clicked inside Outlook (e.g. a Teams join link) belong in the system browser.
      if (isOutlook) openExternal(event.url)
    })
    // Outlook uses iframes for sign-in and add-ins, so only its main frame is checked.
    contents.on('will-redirect', (event) => {
      if ((isOutlook ? event.isMainFrame : true) && !allowed(event.url)) event.preventDefault()
    })
    if (!isOutlook) {
      contents.on('will-frame-navigate', (event) => {
        if (!allowed(event.url)) event.preventDefault()
      })
    }
    contents.on('will-attach-webview', (event) => event.preventDefault())
    contents.setWindowOpenHandler(({ url }) => {
      openExternal(url)
      return { action: 'deny' }
    })
  })
}

function denyPermissions(s: Session): void {
  s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  s.setPermissionCheckHandler(() => false)
  s.setDevicePermissionHandler(() => false)
  s.on('will-download', (event) => event.preventDefault())
}
