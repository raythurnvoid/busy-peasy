import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UpdateCheck } from '../shared/api'

// Updates come from this repo's GitHub releases: the "publish" block in electron-builder.yml, which the build writes
// into app-update.yml. Dev runs have no app-update.yml, so only the installed app checks.
const STARTUP_DELAY = 3000
const CHECK_INTERVAL = 4 * 60 * 60_000

// The version downloaded and waiting to install. The page asks for it when it opens (Api.getUpdate).
let downloaded: string | null = null
let checking: Promise<UpdateCheck> | null = null

// Downloads in the background (autoDownload) and installs on the next quit (autoInstallOnAppQuit), both on by default.
// onDownloaded lets the tray and the page offer a restart now.
export function startUpdates(onDownloaded: (version: string) => void): void {
  if (!app.isPackaged) return
  // What the updater did in this app run, so a check that fails is not silent (updater.log in the userData folder).
  const logFile = join(app.getPath('userData'), 'updater.log')
  const log =
    (level: string) =>
    (message: unknown): void => {
      try {
        appendFileSync(logFile, `${new Date().toISOString()} ${level} ${String(message)}\n`)
      } catch {
        // Ignore.
      }
    }
  try {
    writeFileSync(logFile, '')
  } catch {
    // Ignore.
  }
  // No debug: it dumps whole block maps.
  autoUpdater.logger = { info: log('info'), warn: log('warn'), error: log('error') }
  autoUpdater.on('update-downloaded', (info) => {
    downloaded = info.version
    onDownloaded(info.version)
  })
  // Offline or no release yet: the next check tries again. Without a listener, an 'error' event throws.
  autoUpdater.on('error', () => {})
  setTimeout(checkForUpdates, STARTUP_DELAY)
  setInterval(checkForUpdates, CHECK_INTERVAL)
}

export function downloadedUpdate(): string | null {
  return downloaded
}

export async function checkForUpdates(): Promise<UpdateCheck> {
  const currentVersion = app.getVersion()
  if (!app.isPackaged) return { status: 'dev', currentVersion }
  // A new download may clear the waiting installer. Keep it until restart, even offline.
  if (downloaded) return { status: 'ready', currentVersion, updateVersion: downloaded }
  // Share the download too. Electron's check promise ends when the download starts.
  if (checking) return checking
  checking = autoUpdater
    .checkForUpdates()
    .then(async (result): Promise<UpdateCheck> => {
      if (!result) return { status: 'error', currentVersion }
      if (!result.isUpdateAvailable) return { status: 'current', currentVersion }
      await result.downloadPromise
      return downloaded
        ? { status: 'ready', currentVersion, updateVersion: downloaded }
        : { status: 'error', currentVersion }
    })
    .catch((): UpdateCheck => ({ status: 'error', currentVersion }))
    .finally(() => {
      checking = null
    })
  return checking
}

// Call only after the quit flush: the installer kills the app about 3 s after it starts.
// Silent, so no installer wizard shows, then the app starts again.
export function installUpdate(): void {
  autoUpdater.quitAndInstall(true, true)
}
