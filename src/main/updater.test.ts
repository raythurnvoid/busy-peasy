import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { app, updater } = vi.hoisted(() => ({
  app: { isPackaged: true, getVersion: () => '1.0.0', getPath: () => '.' },
  updater: { checkForUpdates: vi.fn(), on: vi.fn() }
}))
vi.mock('electron', () => ({ app }))
vi.mock('electron-updater', () => ({ autoUpdater: updater }))
vi.mock('node:fs', () => ({ appendFileSync: vi.fn(), writeFileSync: vi.fn() }))

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.useFakeTimers()
  app.isPackaged = true
})
afterEach(() => vi.useRealTimers())

it('reports the installed version when current and retries after errors', async () => {
  const { checkForUpdates } = await import('./updater')
  updater.checkForUpdates.mockRejectedValueOnce(new Error('offline'))
  await expect(checkForUpdates()).resolves.toEqual({ status: 'error', currentVersion: '1.0.0' })
  updater.checkForUpdates.mockResolvedValueOnce({
    isUpdateAvailable: true,
    downloadPromise: Promise.reject(new Error('download failed'))
  })
  await expect(checkForUpdates()).resolves.toEqual({ status: 'error', currentVersion: '1.0.0' })
  updater.checkForUpdates.mockResolvedValueOnce({ isUpdateAvailable: false })
  await expect(checkForUpdates()).resolves.toEqual({ status: 'current', currentVersion: '1.0.0' })
})

it('shares the scheduled download with Settings and keeps the restart action available offline', async () => {
  const { startUpdates, checkForUpdates } = await import('./updater')
  const download = Promise.withResolvers<string[]>()
  updater.checkForUpdates.mockResolvedValue({
    isUpdateAvailable: true,
    downloadPromise: download.promise
  })
  const showUpdate = vi.fn()
  startUpdates(showUpdate)
  await vi.advanceTimersByTimeAsync(3000)
  const fromSettings = checkForUpdates()
  expect(updater.checkForUpdates).toHaveBeenCalledOnce()
  expect(showUpdate).not.toHaveBeenCalled()
  const onDownloaded = updater.on.mock.calls.find(([name]) => name === 'update-downloaded')![1]
  onDownloaded({ version: '1.1.0' })
  download.resolve(['installer.exe'])
  const ready = { status: 'ready', currentVersion: '1.0.0', updateVersion: '1.1.0' }
  await expect(fromSettings).resolves.toEqual(ready)
  expect(showUpdate).toHaveBeenCalledWith('1.1.0')
  // Starting another download can clear the installer that is waiting for restart.
  await vi.advanceTimersByTimeAsync(4 * 60 * 60_000)
  await expect(checkForUpdates()).resolves.toEqual(ready)
  expect(updater.checkForUpdates).toHaveBeenCalledOnce()
})

it('explains that updates are unavailable in development', async () => {
  const { checkForUpdates } = await import('./updater')
  app.isPackaged = false
  await expect(checkForUpdates()).resolves.toEqual({ status: 'dev', currentVersion: '1.0.0' })
  expect(updater.checkForUpdates).not.toHaveBeenCalled()
})
