import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Api, CalendarEvent, DataChanged } from '../shared/api'

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
  'showEvent',
  'getSettings',
  'saveSettings',
  'getUpdate',
  'installUpdate'
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
  },
  // A reminder asks to show this event.
  onShowEvent(callback: (event: CalendarEvent) => void): () => void {
    const listener = (_: IpcRendererEvent, event: CalendarEvent): void => callback(event)
    ipcRenderer.on('show-event', listener)
    return () => ipcRenderer.off('show-event', listener)
  },
  // An update was downloaded: this version installs on the next quit.
  onUpdateReady(callback: (version: string) => void): () => void {
    const listener = (_: IpcRendererEvent, version: string): void => callback(version)
    ipcRenderer.on('update-ready', listener)
    return () => ipcRenderer.off('update-ready', listener)
  },
  // An agent command from main/agent.ts. The answer, or the error's message, goes back to main.
  onAgentCommand(callback: (name: string, args: Record<string, unknown>) => Promise<unknown>): () => void {
    const listener = (_: IpcRendererEvent, id: number, name: string, args: Record<string, unknown>): void =>
      void callback(name, args).then(
        (result) => ipcRenderer.send('agent-reply', id, { result }),
        (e: unknown) => ipcRenderer.send('agent-reply', id, { error: e instanceof Error ? e.message : String(e) })
      )
    ipcRenderer.on('agent-command', listener)
    // Main holds commands until this: right after a start, the page is not listening yet.
    ipcRenderer.send('agent-ready')
    return () => ipcRenderer.off('agent-command', listener)
  }
})
