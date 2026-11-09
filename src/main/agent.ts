import { execFileSync } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import type { Api, CalendarEvent } from '../shared/api'

// The local agent API: agents and scripts use the calendar and the app's screen over HTTP on 127.0.0.1. The CLI and MCP
// server in resources/busy-peasy.mjs read the address and token from agent-api.json. Only the tray changes the access, so
// an agent cannot raise its own access through the page. The access limits agents that only have the CLI or MCP tools:
// a program running as the user can edit agent-access.json itself.
export type AgentAccess = 'off' | 'read' | 'full'

export const AGENT_ACCESS_LABELS: Record<AgentAccess, string> = { off: 'Off', read: 'Read only', full: 'Full access' }

const ACCESS_FILE = 'agent-access.json'
const API_FILE = 'agent-api.json'
const LOG_FILE = 'agent-log.jsonl'
const MAX_BODY = 1_000_000
const REFUSED = 'Busy Peasy agent access is Read only or Off. The user can change it in the tray menu: Agent access.'

// type: a JSON Schema type, for MCP tools.
interface Param {
  type: string | string[]
  about: string
  optional?: true
}

interface Method {
  about: string
  params: Record<string, Param>
  // Changes calendars, or presses things on screen: Full access only.
  write: boolean
  run(body: Record<string, unknown>): Promise<unknown>
}

export interface AgentOptions {
  api: Api
  // userData: the access, address and log files.
  dir: string
  // Path of resources/busy-peasy.mjs, written into agent-api.json.
  cli: string
  version: string
  getEvent(eventId: number): CalendarEvent | null
  // Runs an app command in the main window's page (App.svelte).
  command(name: string, args: Record<string, unknown>): Promise<unknown>
  // A trusted key press in the main window, like the user's: "Escape", "Enter", "Tab", "c", "Control+z".
  press(key: string): Promise<void>
  // JPEG, base64.
  screenshot(): Promise<string>
  // Quit waits for these, like for the page's writes (ipc.ts, writesDone).
  track(write: Promise<unknown>): void
}

const TIME: Param['type'] = ['string', 'number']
const TIME_ABOUT = 'Epoch ms, or an ISO date-time. A date without a time ("2026-11-09") is UTC midnight; add a time ("2026-11-09T00:00") for local.'

// Epoch ms. Strings go through Date.parse; a bad one becomes NaN, which the Api refuses.
const time = (value: unknown): unknown => (typeof value === 'string' ? Date.parse(value) : value)

// An event from an agent: times may be ISO strings, text fields may be left out, all-day times may come from the dates.
// startLocal and endLocal (from withLocalTimes) count as start and end, so an event sent back with a new startLocal does
// not silently keep its old time.
function eventFields(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null) return {}
  const input: Record<string, unknown> = { ...raw }
  for (const key of ['start', 'end']) {
    const local = input[key + 'Local']
    delete input[key + 'Local']
    if (input[key] !== undefined) input[key] = time(input[key])
    if (local === undefined) continue
    if (input[key] === undefined) input[key] = time(local)
    else if (time(local) !== input[key]) throw new Error(`${key} and ${key}Local differ. Send only ${key}.`)
  }
  // All-day times are UTC midnight of the dates. A timed event has no dates, also when it was all-day before.
  if (typeof input.startDate === 'string' && typeof input.endDate === 'string') {
    input.start ??= Date.parse(input.startDate + 'T00:00:00Z')
    input.end ??= Date.parse(input.endDate + 'T00:00:00Z')
  }
  if (input.allDay === false) {
    input.startDate ??= null
    input.endDate ??= null
  }
  return input
}

// A new event: the Api needs every text field and both dates.
function newEvent(raw: unknown): Record<string, unknown> {
  const input = eventFields(raw)
  return {
    title: '',
    location: '',
    description: '',
    startDate: null,
    endDate: null,
    allDay: false,
    ...input
  }
}

// "2026-11-09T14:30:00+01:00": this PC's time with its offset.
function localIso(ms: number): string {
  const offset = -new Date(ms).getTimezoneOffset()
  const abs = Math.abs(offset)
  const zone = `${offset < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
  return new Date(ms + offset * 60_000).toISOString().slice(0, 19) + zone
}

// Adds startLocal and endLocal next to the epoch ms of timed events, so an agent can read them. The Api ignores the
// extra keys if an agent sends the object back.
function withLocalTimes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withLocalTimes)
  if (typeof value !== 'object' || value === null) return value
  const out: Record<string, unknown> = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withLocalTimes(v)]))
  if (typeof out.start === 'number' && typeof out.end === 'number' && out.allDay !== true) {
    out.startLocal = localIso(out.start)
    out.endLocal = localIso(out.end)
  }
  return out
}

function methods(o: AgentOptions): Record<string, Method> {
  const { api } = o
  const id = (about: string): Param => ({ type: 'integer', about })
  const notify: Param = { type: 'boolean', about: 'false: guests get no email (Google only; Outlook always emails them).', optional: true }
  const scope: Param = {
    type: 'string',
    about: 'Repeating events: "event" (default), "following" (this and later) or "series" (all).',
    optional: true
  }
  const event = (eventId: unknown): CalendarEvent => {
    const found = Number.isSafeInteger(eventId) ? o.getEvent(eventId as number) : null
    if (!found) throw new Error('No event with this id.')
    return found
  }
  return {
    listAccounts: { about: 'Signed-in Microsoft 365 and Google accounts.', params: {}, write: false, run: () => api.listAccounts() },
    listCalendars: {
      about: 'Calendars with their ids, colors, canEdit, visible and synced dates (windowStart, windowEnd).',
      params: {},
      write: false,
      run: () => api.listCalendars()
    },
    listEvents: {
      about: 'Events of visible calendars that overlap a time range (at most 430 days), from the local copy.',
      params: { start: { type: TIME, about: TIME_ABOUT }, end: { type: TIME, about: TIME_ABOUT } },
      write: false,
      run: (b) => api.listEvents({ start: time(b.start), end: time(b.end) } as never)
    },
    searchEvents: {
      about: 'Events with every word in the title, location, description, organizer or a guest. 200 at most.',
      params: { text: { type: 'string', about: 'Words to find.' } },
      write: false,
      run: (b) => api.searchEvents(b.text as string)
    },
    getEventDetails: {
      about: 'Guests, rooms, full body, web link and time zone of one event.',
      params: { eventId: id('Event id.') },
      write: false,
      run: (b) => api.getEventDetails(b.eventId as number)
    },
    getSeries: {
      about: 'The repeat rule of a repeating event. null: not repeating.',
      params: { eventId: id('Event id.') },
      write: false,
      run: (b) => api.getSeries(b.eventId as number)
    },
    listPeople: {
      about: 'People seen in an account\'s events, newest first, to find guest emails.',
      params: { accountId: id('Account id.') },
      write: false,
      run: (b) => api.listPeople(b.accountId as number)
    },
    listReminders: { about: 'Reminders showing now.', params: {}, write: false, run: () => api.listReminders() },
    getSettings: { about: 'The app settings.', params: {}, write: false, run: () => api.getSettings() },
    syncNow: { about: 'Syncs every account now and waits for it.', params: {}, write: false, run: () => api.syncNow() },
    setCalendarVisible: {
      about: 'Shows or hides a calendar.',
      params: { calendarId: id('Calendar id.'), visible: { type: 'boolean', about: 'true: show.' } },
      write: true,
      run: (b) => api.setCalendarVisible(b.calendarId as number, b.visible as boolean)
    },
    createEvent: {
      about:
        'Creates an event in a calendar with canEdit. Guests get an invite. Timed: start and end. All-day: allDay true, ' +
        'startDate and endDate (YYYY-MM-DD, end exclusive). Optional: title, location, description, guests ' +
        '([{ email, optional }]), reminders ([{ minutes, alarm }]), conference (true: Teams or Meet), timeZone (IANA), ' +
        'repeat ({ freq, interval, days, monthly, until, count }; a timed one needs timeZone), colorKey.',
      params: { input: { type: 'object', about: 'The event: calendarId and the fields above.' }, notify },
      write: true,
      run: (b) => api.createEvent(newEvent(b.input) as never, b.notify as boolean | undefined)
    },
    updateEvent: {
      about:
        'Changes an event. patch: only the fields to change (title, start, end, allDay, startDate, endDate, location, ' +
        'description, reminders, conference, timeZone, repeat, colorKey). Times change together: send start and end. ' +
        'guests: { add: [{ email, optional }], set: [], remove: [emails] }. Returns the event, or null after a series change.',
      params: { eventId: id('Event id.'), patch: { type: 'object', about: 'The fields to change.' }, notify, scope },
      write: true,
      run: (b) =>
        api.updateEvent(b.eventId as number, eventFields(b.patch) as never, { notify: b.notify, scope: b.scope } as never)
    },
    deleteEvent: {
      about: 'Deletes an event. An invite is declined (Outlook) or removed from the calendar (Google).',
      params: { eventId: id('Event id.'), notify, scope },
      write: true,
      run: (b) => api.deleteEvent(b.eventId as number, { notify: b.notify, scope: b.scope } as never)
    },
    respondEvent: {
      about: 'Answers an invite: "accepted", "tentative" or "declined".',
      params: {
        eventId: id('Event id.'),
        answer: { type: 'string', about: '"accepted", "tentative" or "declined".' },
        scope: { type: 'string', about: '"event" (default) or "series".', optional: true }
      },
      write: true,
      run: (b) => api.respondEvent(b.eventId as number, b.answer as never, (b.scope ?? 'event') as never)
    },
    getState: {
      about: 'What the app shows: view, date, title, open event, open dialog, search, toast.',
      params: {},
      write: false,
      run: () => o.command('getState', {})
    },
    navigate: {
      about: 'Shows a date and/or a view in the app. Fails while a dialog is open.',
      params: {
        date: { type: 'string', about: 'YYYY-MM-DD.', optional: true },
        view: { type: 'string', about: '"day", "week", "month" or "schedule".', optional: true }
      },
      write: false,
      run: (b) => o.command('navigate', { date: b.date, view: b.view })
    },
    openEvent: {
      about: 'Brings the app up on an event\'s day with its popover open. Fails while a dialog is open.',
      params: { eventId: id('Event id.') },
      write: false,
      run: async (b) => o.command('openEvent', { event: event(b.eventId) })
    },
    search: {
      about: 'Runs a search in the app, like typing in its search bar.',
      params: { text: { type: 'string', about: 'Words to find.' } },
      write: false,
      run: (b) => o.command('search', { text: b.text })
    },
    openSettings: { about: 'Opens the Settings dialog.', params: {}, write: false, run: () => o.command('openSettings', {}) },
    snapshot: {
      about:
        'The controls on screen, like a screen reader: ref, role, name, value and state. Inside an open modal dialog, ' +
        'only its controls. Refs are valid until the next snapshot or action.',
      params: {},
      write: false,
      run: () => o.command('snapshot', {})
    },
    screenshot: {
      about: 'A picture of the app window (JPEG), also while it is hidden in the tray.',
      params: {},
      write: false,
      run: async () => ({ mimeType: 'image/jpeg', data: await o.screenshot() })
    },
    openNewEvent: {
      about:
        'Opens the new-event dialog filled in, for the user (or click) to save. input: calendarId (optional), title, start, ' +
        'end, allDay, startDate, endDate, location, description, reminders, colorKey. Add guests, a video call, a repeat ' +
        'or a time zone in the dialog (fill, click), or use createEvent.',
      params: { input: { type: 'object', about: 'The event.' } },
      write: true,
      run: (b) => o.command('openNewEvent', { input: newEvent(b.input) })
    },
    editEvent: {
      about: 'Opens an event\'s edit dialog.',
      params: { eventId: id('Event id.') },
      write: true,
      run: async (b) => o.command('editEvent', { event: event(b.eventId) })
    },
    click: {
      about: 'Clicks a control: by ref from the last snapshot, or by its name (and role). Returns a new snapshot.',
      params: {
        ref: { type: 'integer', about: 'From snapshot.', optional: true },
        name: { type: 'string', about: 'The exact name, any case.', optional: true },
        role: { type: 'string', about: 'With name, when two controls share it.', optional: true }
      },
      write: true,
      run: (b) => o.command('click', { ref: b.ref, name: b.name, role: b.role })
    },
    fill: {
      about: 'Sets a text field, select or checkbox ("true"/"false"): by ref, or by its name. Returns a new snapshot.',
      params: {
        ref: { type: 'integer', about: 'From snapshot.', optional: true },
        name: { type: 'string', about: 'The field\'s name, any case.', optional: true },
        value: { type: 'string', about: 'The new value. A select takes an option\'s value or text.' }
      },
      write: true,
      run: (b) => o.command('fill', { ref: b.ref, name: b.name, value: b.value })
    },
    press: {
      about: 'Presses a key in the app like the user: "Escape", "Enter", "Tab", "Delete", "c", "Control+z". Returns a new snapshot.',
      params: { key: { type: 'string', about: 'A key, with modifiers joined by "+".' } },
      write: true,
      run: async (b) => {
        if (typeof b.key !== 'string' || b.key === '') throw new Error('Invalid arguments')
        await o.press(b.key)
        return o.command('snapshot', {})
      }
    }
  }
}

export function readAgentAccess(dir: string): AgentAccess {
  try {
    const { access } = JSON.parse(readFileSync(join(dir, ACCESS_FILE), 'utf8'))
    return access === 'read' || access === 'full' ? access : 'off'
  } catch {
    return 'off'
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      body += chunk
      // Stops reading too: a stream without end would fill the main process's memory.
      if (body.length > MAX_BODY) {
        request.destroy()
        reject(new Error('Body too large'))
      }
    })
    request.on('end', () => resolve(body))
    request.on('error', reject)
  })
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

// Starts the server if the saved access is on. setAccess saves a tray pick and starts or stops it. stop: at quit; the
// saved access stays.
export function startAgent(o: AgentOptions): { access(): AgentAccess; setAccess(access: AgentAccess): void; stop(): void } {
  const table = methods(o)
  let access = readAgentAccess(o.dir)
  let server: ReturnType<typeof createServer> | null = null
  let token = ''
  let port = 0

  const help = (): unknown => ({
    about:
      'Busy Peasy, a local calendar for Microsoft 365 and Google. POST /v1/<method> with a JSON object of params. ' +
      'Times are epoch ms; timed events also get startLocal and endLocal. Write methods need Full access (tray menu).',
    access,
    now: Date.now(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    methods: Object.fromEntries(Object.entries(table).map(([name, { about, params, write }]) => [name, { about, params, write }]))
  })

  // Windows ignores the mode, and %APPDATA% can let other accounts read (seen: CodexSandboxUsers), so only this user may
  // read the token. The ACL is set on the empty file, before the token is in it. If that fails, no file: no access.
  const writeApiFile = (): void => {
    const path = join(o.dir, API_FILE)
    const file = { url: `http://127.0.0.1:${port}`, token, access, pid: process.pid, version: o.version, cli: o.cli }
    try {
      writeFileSync(path, '', { mode: 0o600 })
      if (process.platform === 'win32') {
        execFileSync('icacls', [path, '/inheritance:r', '/grant:r', `${userInfo().username}:F`], { stdio: 'ignore' })
      }
      writeFileSync(path, JSON.stringify(file, null, 2))
    } catch {
      rmSync(path, { force: true })
    }
  }

  // Every write, so the user can see what agents did. A full disk must not fail a write that is done.
  const log = (name: string, body: unknown, error?: string): void => {
    const line = JSON.stringify({ at: new Date().toISOString(), method: name, body, ...(error ? { error } : {}) })
    try {
      appendFileSync(join(o.dir, LOG_FILE), line + '\n')
    } catch {
      // Ignore.
    }
  }

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    // The Host check stops DNS rebinding. Browsers always send Origin on a POST and a cross-site GET: no web page may call.
    if (request.headers.host !== `127.0.0.1:${port}` || request.headers.origin !== undefined) {
      return send(response, 403, { error: 'Forbidden' })
    }
    const sent = Buffer.from(request.headers.authorization ?? '')
    const wanted = Buffer.from(`Bearer ${token}`)
    if (sent.length !== wanted.length || !timingSafeEqual(sent, wanted)) return send(response, 401, { error: 'Wrong token' })
    const name = (request.url ?? '').match(/^\/v1\/(\w+)$/)?.[1]
    if (name === 'help' && request.method === 'GET') return send(response, 200, { result: help() })
    if (!name || !Object.hasOwn(table, name) || request.method !== 'POST') return send(response, 404, { error: 'Unknown method' })
    const method = table[name]
    const refused = (): boolean => access === 'off' || (method.write && access !== 'full')
    if (refused()) return send(response, 403, { error: REFUSED })
    let body: Record<string, unknown>
    try {
      const text = await readBody(request)
      body = text.trim() === '' ? {} : JSON.parse(text)
      if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('Not an object')
    } catch {
      return send(response, 400, { error: 'The body must be a JSON object.' })
    }
    // Again: the user may have lowered the access while the body came.
    if (refused()) return send(response, 403, { error: REFUSED })
    const running = Promise.resolve().then(() => method.run(body))
    if (method.write) o.track(running)
    try {
      const result = await running
      if (method.write) log(name, body)
      send(response, 200, { result: withLocalTimes(result ?? null) })
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      if (method.write) log(name, body, error)
      send(response, 400, { error })
    }
  }

  const start = (): void => {
    if (server) return writeApiFile()
    token = randomBytes(32).toString('hex')
    server = createServer((request, response) => void handle(request, response))
    server.listen(0, '127.0.0.1', () => {
      port = (server!.address() as AddressInfo).port
      writeApiFile()
    })
  }

  // Also ends open connections, so a request whose body is still coming cannot run after Off.
  const stop = (): void => {
    server?.closeAllConnections()
    server?.close()
    server = null
    rmSync(join(o.dir, API_FILE), { force: true })
  }

  // Off also removes a file left by a crash: it points to a dead port.
  if (access === 'off') stop()
  else start()

  return {
    access: () => access,
    setAccess(next) {
      access = next
      writeFileSync(join(o.dir, ACCESS_FILE), JSON.stringify({ access }))
      if (access === 'off') stop()
      else start()
    },
    stop
  }
}
