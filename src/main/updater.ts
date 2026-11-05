import { app } from 'electron'
import { autoUpdater } from 'electron-updater'

// Updates come from this repo's GitHub releases: the "publish" block in electron-builder.yml, which the build writes
// into app-update.yml. Dev runs have no app-update.yml, so only the installed app checks.
const STARTUP_DELAY = 3000
const CHECK_INTERVAL = 4 * 60 * 60_000

// Downloads in the background (autoDownload) and installs on the next quit (autoInstallOnAppQuit), both on by default.
// onDownloaded lets the tray offer a restart now.
export function startUpdates(onDownloaded: (version: string) => void): void {
  if (!app.isPackaged) return
  autoUpdater.on('update-downloaded', (info) => onDownloaded(info.version))
  // Offline or no release yet: the next check tries again. Without a listener, an 'error' event throws.
  autoUpdater.on('error', () => {})
  const check = (): void => void autoUpdater.checkForUpdates().catch(() => {})
  setTimeout(check, STARTUP_DELAY)
  setInterval(check, CHECK_INTERVAL)
}

// Call only after the quit flush: the installer kills the app about 3 s after it starts.
// Silent, so no installer wizard shows, then the app starts again.
export function installUpdate(): void {
  autoUpdater.quitAndInstall(true, true)
}
