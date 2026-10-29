import { BrowserWindow, ipcMain } from 'electron'
import type { Api, DataChanged } from '../shared/api'
import { isAppOrigin } from './security'

// Writes in progress: creates, edits, deletes and answers. Quit waits for them, so a series change is not cut in the
// middle, and the page sends a pending (Undo) delete when it closes.
const writes = new Set<Promise<unknown>>()

export function writesDone(ms: number): Promise<void> {
  return Promise.race([Promise.allSettled([...writes]).then(() => {}), new Promise<void>((r) => setTimeout(r, ms))])
}

// One channel for the whole Api. Only our own page may call it.
export function registerApi(api: Api, devUrl: string | undefined): void {
  ipcMain.handle('api', (event, name: unknown, args: unknown) => {
    // Check the origin, not the URL: a sandboxed frame can have our URL but a "null" origin.
    const origin = event.senderFrame?.origin ?? 'null'
    if (origin === 'null' || !isAppOrigin(origin, devUrl)) throw new Error('Blocked IPC from ' + origin)
    if (typeof name !== 'string' || !Object.hasOwn(api, name) || !Array.isArray(args)) {
      throw new Error('Unknown API call')
    }
    const method = api[name as keyof Api] as (...a: unknown[]) => Promise<unknown>
    const result = method(...args)
    if (['createEvent', 'updateEvent', 'deleteEvent', 'respondEvent'].includes(name)) {
      writes.add(result)
      const done = (): boolean => writes.delete(result)
      result.then(done, done)
    }
    return result
  })
}

export function notifyDataChanged(change: DataChanged): void {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('data-changed', change)
}
