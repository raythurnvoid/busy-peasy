import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Api, DataChanged } from '../shared/api'

// Every Api method goes through the single 'api' channel. Main checks the name and the caller.
const names: (keyof Api)[] = [
  'listAccounts',
  'listCalendars',
  'listEvents',
  'searchEvents',
  'getEventDetails',
  'getSeries',
  'listPeople',
  'setCalendarVisible',
  'addOutlookAccount',
  'addGoogleAccount',
  'removeAccount',
  'syncNow',
  'createEvent',
  'updateEvent',
  'deleteEvent',
  'respondEvent',
  'openLink',
  'copyText',
  'listReminders',
  'answerReminder',
  'dismissReminders',
  'getSettings',
  'saveSettings'
]

const api = Object.fromEntries(names.map((name) => [name, (...args: unknown[]) => ipcRenderer.invoke('api', name, args)]))

contextBridge.exposeInMainWorld('api', {
  ...api,
  onDataChanged(callback: (change: DataChanged) => void): () => void {
    const listener = (_: IpcRendererEvent, change: DataChanged): void => callback(change)
    ipcRenderer.on('data-changed', listener)
    return () => ipcRenderer.off('data-changed', listener)
  },
  // The tray or a toast asks to sign this account in again.
  onSignIn(callback: (accountId: number) => void): () => void {
    const listener = (_: IpcRendererEvent, accountId: number): void => callback(accountId)
    ipcRenderer.on('sign-in', listener)
    return () => ipcRenderer.off('sign-in', listener)
  }
})
