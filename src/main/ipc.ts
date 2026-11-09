import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import type { Api, DataChanged } from '../shared/api'
import { isAppOrigin } from './security'

// An agent command waits this long for the page.
const COMMAND_MS = 30_000

// Writes in progress: creates, edits, deletes and answers. Quit waits for them, so a series change is not cut in the
// middle, and the page sends a pending (Undo) delete when it closes.
const writes = new Set<Promise<unknown>>()

// Agent commands for a page, by id, until it answers. sent: false while the page is still starting.
const commands = new Map<
  number,
  { contents: WebContents; sent: boolean; send(): void; done(reply: { result?: unknown; error?: string }): void }
>()
let lastCommand = 0
// Pages whose App.svelte listens for agent commands.
const listening = new WeakSet<WebContents>()

// Agent writes come here too (agent.ts), so Quit waits for them as well.
export function trackWrite(write: Promise<unknown>): void {
  writes.add(write)
  const done = (): boolean => writes.delete(write)
  write.then(done, done)
}

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
    if (['createEvent', 'updateEvent', 'deleteEvent', 'respondEvent'].includes(name)) trackWrite(result)
    return result
  })
  // The page listens now: send what waited for it. A command sent before that would be lost.
  ipcMain.on('agent-ready', (event) => {
    listening.add(event.sender)
    for (const command of commands.values()) if (command.contents === event.sender && !command.sent) command.send()
  })
  // The answer to askPage. Only the page that was asked may answer.
  ipcMain.on('agent-reply', (event, id: unknown, reply: unknown) => {
    const command = commands.get(id as number)
    if (!command || event.sender !== command.contents || typeof reply !== 'object' || reply === null) return
    commands.delete(id as number)
    command.done(reply)
  })
}

// Runs an agent command in the page (App.svelte, onAgentCommand) and returns its answer.
export function askPage(contents: WebContents, name: string, args: Record<string, unknown>): Promise<unknown> {
  const id = ++lastCommand
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      commands.delete(id)
      // A native question ("Discard your changes?") stops the page until the user answers it.
      reject(new Error('The app did not answer. It may be starting, or waiting for the user to answer a question in its window.'))
    }, COMMAND_MS)
    const command = {
      contents,
      sent: false,
      send: () => {
        command.sent = true
        contents.send('agent-command', id, name, args)
      },
      done: ({ result, error }: { result?: unknown; error?: string }) => {
        clearTimeout(timer)
        if (error === undefined) resolve(result)
        else reject(new Error(String(error)))
      }
    }
    commands.set(id, command)
    if (listening.has(contents)) command.send()
  })
}

export function notifyDataChanged(change: DataChanged): void {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('data-changed', change)
}
