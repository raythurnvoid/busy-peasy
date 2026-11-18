import { execFileSync } from 'node:child_process'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { appendFileSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import type { Api, CalendarEvent } from '../shared/api'
import { ASKING, baseName, type AgentAccess, type ApprovalAnswer, type ApprovalRequest } from '../shared/approval'

// The local agent API: agents and scripts use the calendar and the app's screen over HTTP on 127.0.0.1. The CLI and MCP
// server in resources/busy-peasy.mjs read the address and the register token from agent-api.json. The register token
// only registers an agent by name: each agent gets its own token, and the user allows it once in a prompt in the app
// window or in the tray. The app keeps only a hash of each token, in agents.bin (encrypted). Only the prompt and the
// tray change levels, and agents cannot answer the prompt (the gate below, the prompt's own checks, and ipc.ts). The
// tray's access is the upper limit for every agent's level. Names are labels, not identity: a program running as the
// user can use an allowed agent's name or token, or edit agent-access.json.
// pending: Waiting for the user's answer. It gives nothing.
export type AgentLevel = AgentAccess | 'pending'

export interface Agent {
  id: string
  name: string
  level: AgentLevel
}

// In agents.bin: never the token.
interface SavedAgent extends Agent {
  tokenHash: string
}

export const AGENT_ACCESS_LABELS: Record<AgentAccess, string> = { off: 'Off', read: 'Read only', full: 'Full access' }
export const AGENT_LEVEL_LABELS: Record<AgentLevel, string> = { ...AGENT_ACCESS_LABELS, pending: 'Waiting' }

const ACCESS_FILE = 'agent-access.json'
const API_FILE = 'agent-api.json'
const AGENTS_FILE = 'agents.bin'
const LOG_FILE = 'agent-log.jsonl'
const MAX_BODY = 1_000_000
const MAX_AGENTS = 20
const MAX_PENDING = 3
// A Waiting agent that calls again is asked again, but not more often than this.
const ASK_AGAIN_MS = 10 * 60_000
const ACCESS_ORDER: AgentAccess[] = ['off', 'read', 'full']
// Methods that send input to the page or change what it shows. No agent may use them while the prompt is open: the
// prompt is in the page.
const PAGE_INPUT = new Set(['click', 'fill', 'press', 'navigate', 'openEvent', 'search', 'openSettings', 'addAccount', 'openNewEvent', 'editEvent'])
const waiting = (name: string): string =>
  `Busy Peasy is waiting for the user to allow "${name}". Ask the user to answer the Busy Peasy prompt, or, if none is ` +
  `showing, to pick a level in the tray menu: Agent access > ${name}. Then try again.`
const turnedOff = (name: string): string =>
  `The user turned off "${name}" in Busy Peasy. The user can change it in the tray menu: Agent access > ${name}.`
const readOnly = (name: string): string =>
  `Busy Peasy gives "${name}" Read only access. The user can change it in the tray menu: Agent access.`
const TOO_OLD =
  'This Busy Peasy client is too old: Busy Peasy now gives each agent its own token. Restart the agent or its MCP ' +
  'server, so it loads the new busy-peasy.mjs (path: "cli" in agent-api.json).'

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
// Names are the same in any case: "claude code" is "Claude Code".
const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

// Letters with their accents, digits, space and . _ ( ) + -. Characters that show nothing go, anything else becomes a
// space: no quotes, no control characters. '' if nothing is left.
function cleanName(name: unknown): string {
  if (typeof name !== 'string') return ''
  return (
    name
      // e + a separate accent mark becomes one letter, so the same name typed two ways stays the same.
      .normalize('NFC')
      // Characters that show nothing, also those that count as letters or marks: Hangul fillers, variation selectors.
      .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
      .replace(/[^\p{L}\p{M}\p{N} ._()+-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40)
  )
}

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
  // access: the agent's effective access.
  run(body: Record<string, unknown>, access: AgentAccess): Promise<unknown>
}

export interface AgentOptions {
  api: Api
  // userData: the access, address and log files.
  dir: string
  // Path of resources/busy-peasy.mjs, written into agent-api.json.
  cli: string
  version: string
  getEvent(eventId: number): CalendarEvent | null
  // Runs an app command in the main window's page (App.svelte). show: bring the window up first. The commands that open
  // something for the user pass true for an agent with Full access; a Read only agent only looks.
  command(name: string, args: Record<string, unknown>, show?: boolean): Promise<unknown>
  // A trusted key press in the main window, like the user's: "Escape", "Enter", "Tab", "c", "Control+z".
  press(key: string): Promise<void>
  // JPEG, base64.
  screenshot(): Promise<string>
  // Quit waits for these, like for the page's writes (ipc.ts, writesDone).
  track(write: Promise<unknown>): void
  // agents.bin: safeStorage in the app, plain text in tests.
  encrypt(text: string): Promise<Buffer>
  decrypt(data: Buffer): Promise<string>
  // Asks the user to allow a new agent, in a prompt in the main window (index.ts, ipc.ts askApproval). null: Not now.
  // signal: closes the prompt.
  ask(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalAnswer>
  // The agent list or a level changed, or the list loaded: the tray rebuilds its menu.
  agentsChanged(): void
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
      run: async (b, access) => o.command('openEvent', { event: event(b.eventId) }, access === 'full')
    },
    search: {
      about: 'Runs a search in the app, like typing in its search bar.',
      params: { text: { type: 'string', about: 'Words to find.' } },
      write: false,
      run: (b) => o.command('search', { text: b.text })
    },
    openSettings: { about: 'Opens the Settings dialog.', params: {}, write: false, run: (_, access) => o.command('openSettings', {}, access === 'full') },
    addAccount: {
      about:
        'Starts adding an account, like the sidebar button. The user signs in: Google in the browser, Microsoft 365 in a ' +
        'Busy Peasy window. Returns at once; getState signIn shows if it still runs or failed, listAccounts shows the account.',
      params: { provider: { type: 'string', about: '"google" or "outlook" (Microsoft 365).' } },
      // Adds an account: Full access only.
      write: true,
      run: (b) => o.command('addAccount', { provider: b.provider }, true)
    },
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
      run: (b, access) => o.command('openNewEvent', { input: newEvent(b.input) }, access === 'full')
    },
    editEvent: {
      about: 'Opens an event\'s edit dialog.',
      params: { eventId: id('Event id.') },
      write: true,
      run: async (b, access) => o.command('editEvent', { event: event(b.eventId) }, access === 'full')
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

// Windows ignores the mode, and %APPDATA% can let other accounts read (seen: CodexSandboxUsers), so only this user may
// read the file. The ACL is set on the empty file, before the secret is in it. Throws if that fails.
// /reset first: in a folder that passes nothing down, a new file gets its own entries (Administrators, SYSTEM), and
// /inheritance:r keeps those.
function writePrivate(path: string, data: string | Buffer): void {
  writeFileSync(path, '', { mode: 0o600 })
  if (process.platform === 'win32') {
    execFileSync('icacls', [path, '/reset'], { stdio: 'ignore' })
    execFileSync('icacls', [path, '/inheritance:r', '/grant:r', `${userInfo().username}:F`], { stdio: 'ignore' })
  }
  writeFileSync(path, data)
}

// Starts the server if the saved access is on. setAccess saves a tray pick and starts or stops it. stop: at quit; the
// saved access stays. The agent list loads at start; the tray changes levels with setAgentLevel and removeAgent.
export function startAgent(o: AgentOptions): {
  access(): AgentAccess
  setAccess(access: AgentAccess): void
  stop(): void
  agents(): Agent[]
  setAgentLevel(id: string, level: AgentAccess): void
  removeAgent(id: string): void
} {
  const table = methods(o)
  const agentsFile = join(o.dir, AGENTS_FILE)
  let access = readAgentAccess(o.dir)
  let server: ReturnType<typeof createServer> | null = null
  // The register token: it only registers agents and reads help.
  let token = ''
  let port = 0
  let agents: SavedAgent[] = []
  let saving = Promise.resolve()
  // One prompt at a time. While one is open (asking is set), no agent may send input to the page (PAGE_INPUT).
  const toAsk: { id: string; twin: boolean }[] = []
  let asking: { id: string; abort: AbortController } | null = null
  // When each agent was last put in toAsk.
  const askedAt = new Map<string, number>()

  const help = (): unknown => ({
    about:
      'Busy Peasy, a local calendar for Microsoft 365 and Google. Each agent needs its own token: POST /v1/register with ' +
      '{"name"} and the token from agent-api.json, then the user allows the agent once in Busy Peasy. Then POST ' +
      '/v1/<method> with the agent token and a JSON object of params. Times are epoch ms; timed events also get ' +
      'startLocal and endLocal. Write methods need Full access for the agent and in the tray menu.',
    access,
    now: Date.now(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    methods: Object.fromEntries(Object.entries(table).map(([name, { about, params, write }]) => [name, { about, params, write }]))
  })

  // If the ACL cannot be set, no file: no access.
  const writeApiFile = (): void => {
    const path = join(o.dir, API_FILE)
    const file = { url: `http://127.0.0.1:${port}`, token, access, pid: process.pid, version: o.version, cli: o.cli }
    try {
      writePrivate(path, JSON.stringify(file, null, 2))
    } catch {
      rmSync(path, { force: true })
    }
  }

  // Every write, so the user can see what agents did, and a failed save of the agent list. Never a token. A full disk
  // must not fail a write that is done.
  const log = (line: Record<string, unknown>): void => {
    try {
      appendFileSync(join(o.dir, LOG_FILE), JSON.stringify({ at: new Date().toISOString(), ...line }) + '\n')
    } catch {
      // Ignore.
    }
  }

  const loaded = (async (): Promise<void> => {
    try {
      // Waiting agents are not kept: after a restart they register again, and the user is asked again.
      const saved: SavedAgent[] = JSON.parse(await o.decrypt(readFileSync(agentsFile)))
      agents = saved.filter((a) => a.level !== 'pending')
    } catch {
      // No file yet, or it cannot be read or was changed: every agent asks again.
    }
    // The tray was built before the list loaded.
    o.agentsChanged()
  })()

  // Fails closed: without the file, after a restart every agent asks again, so a removed or turned-off agent does not
  // come back. Never throws, so the save chain goes on.
  const failed = (e: unknown): void => {
    try {
      rmSync(agentsFile, { force: true })
    } catch {
      // Another program holds it open: the old list can come back after a restart. The log line says so.
    }
    log({ error: `Could not save the agent list: ${e instanceof Error ? e.message : String(e)}` })
  }

  // Saves in order, each time the list as it is then. Returns this save, so register can answer 500 if it fails.
  const save = (): Promise<void> => {
    const write = saving.then(async () => {
      const data = await o.encrypt(JSON.stringify(agents))
      // The temp file gets the ACL; rename keeps it.
      writePrivate(agentsFile + '.tmp', data)
      renameSync(agentsFile + '.tmp', agentsFile)
    })
    saving = write.catch(failed)
    return write
  }

  // Tokens are 256-bit random values: a timing difference in the lookup cannot help guess one.
  const byHash = (sent: string): SavedAgent | undefined => {
    const hash = sha256(sent)
    return agents.find((a) => a.tokenHash === hash)
  }

  // What the agent can do: nothing while it waits, else the lower of the tray access and its own level.
  const effectiveAccess = (agent: Agent): AgentAccess =>
    agent.level === 'pending'
      ? 'off'
      : ACCESS_ORDER[Math.min(ACCESS_ORDER.indexOf(access), ACCESS_ORDER.indexOf(agent.level))]

  // Another agent has the same name, apart from " (2)": the prompt warns.
  const isTwin = (name: string, except?: SavedAgent): boolean =>
    agents.some((a) => a !== except && sameName(baseName(a.name), baseName(name)))

  // The list in memory has changed already, and that protects at once; the file follows. A prompt still open for this
  // agent closes.
  const changed = (id: string): void => {
    void save()
    o.agentsChanged()
    if (asking?.id === id) asking.abort.abort()
  }

  const setAgentLevel = (id: string, level: AgentAccess): void => {
    const agent = agents.find((a) => a.id === id)
    if (!agent) return
    agent.level = level
    changed(id)
  }

  const removeAgent = (id: string): void => {
    agents = agents.filter((a) => a.id !== id)
    changed(id)
  }

  const askNext = (): void => {
    if (asking || !server) return
    const next = toAsk.shift()
    if (!next) return
    const agent = agents.find((a) => a.id === next.id)
    if (agent?.level !== 'pending') return askNext()
    asking = { id: agent.id, abort: new AbortController() }
    void o
      .ask({ id: agent.id, name: agent.name, twin: next.twin, trayAccess: access }, asking.abort.signal)
      .catch(() => null)
      .then((answer) => {
        // First, so setAgentLevel does not close this prompt: it is answered already.
        asking = null
        // The user may have answered in the tray, or removed the agent, while the prompt was open.
        if (answer && agents.includes(agent) && agent.level === 'pending') setAgentLevel(agent.id, answer)
        askNext()
      })
  }

  // A Waiting agent that calls again is asked again, for example after Not now, but at most once per ASK_AGAIN_MS.
  const askAgain = (agent: SavedAgent): void => {
    if (asking?.id === agent.id || toAsk.some((a) => a.id === agent.id)) return
    if (Date.now() - (askedAt.get(agent.id) ?? 0) < ASK_AGAIN_MS) return
    askedAt.set(agent.id, Date.now())
    toAsk.push({ id: agent.id, twin: isTwin(agent.name, agent) })
    askNext()
  }

  // Lets a client check that it talks to the real app before it sends a token: only the app knows the register token.
  // Needs no token.
  const hello = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let nonce: unknown
    try {
      nonce = JSON.parse(await readBody(request)).nonce
    } catch {
      // A bad body: no nonce.
    }
    if (typeof nonce !== 'string' || !/^[0-9a-f]{64}$/.test(nonce)) {
      return send(response, 400, { error: 'Send {"nonce"}: 64 hex characters.' })
    }
    send(response, 200, { result: { proof: createHmac('sha256', token).update(nonce).digest('hex') } })
  }

  const register = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let name = ''
    try {
      name = cleanName(JSON.parse(await readBody(request)).name)
    } catch {
      // A bad body: no name.
    }
    if (!name) return send(response, 400, { error: 'Give the agent a name.' })
    // From here to the push, no await: two registers at once cannot both pass a limit.
    if (agents.filter((a) => a.level === 'pending').length >= MAX_PENDING) {
      return send(response, 429, {
        error: 'Too many agents are waiting to be allowed in Busy Peasy. The user must answer them first, in the prompt or in the tray menu: Agent access.'
      })
    }
    if (agents.length >= MAX_AGENTS) {
      return send(response, 429, { error: `Busy Peasy has ${MAX_AGENTS} agents. The user must remove one first, in the tray menu: Agent access.` })
    }
    // A second agent with the same name gets " (2)", and the prompt warns. Also for "Claude Code (2)" sent on purpose.
    const twin = isTwin(name)
    if (twin) {
      const base = baseName(name)
      let k = 2
      while (agents.some((a) => sameName(a.name, `${base} (${k})`))) k++
      name = `${base} (${k})`
    }
    // Always a new token: register never gives out an existing agent's token.
    const agentToken = randomBytes(32).toString('hex')
    const agent: SavedAgent = { id: randomBytes(6).toString('hex'), name, tokenHash: sha256(agentToken), level: 'pending' }
    agents.push(agent)
    try {
      await save()
    } catch {
      agents = agents.filter((a) => a !== agent)
      return send(response, 500, { error: 'Could not save the agent.' })
    }
    o.agentsChanged()
    askedAt.set(agent.id, Date.now())
    toAsk.push({ id: agent.id, twin })
    askNext()
    send(response, 200, { result: { token: agentToken, name } })
  }

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    // The Host check stops DNS rebinding. Browsers always send Origin on a POST and a cross-site GET: no web page may call.
    if (request.headers.host !== `127.0.0.1:${port}` || request.headers.origin !== undefined) {
      return send(response, 403, { error: 'Forbidden' })
    }
    if (request.url === '/v1/hello' && request.method === 'POST') return hello(request, response)
    await loaded
    const header = Buffer.from(request.headers.authorization ?? '')
    const wanted = Buffer.from(`Bearer ${token}`)
    const isRegisterToken = header.length === wanted.length && timingSafeEqual(header, wanted)
    const sent = (request.headers.authorization ?? '').replace(/^Bearer /, '')
    if (!isRegisterToken && !byHash(sent)) return send(response, 401, { error: 'Wrong token' })
    const name = (request.url ?? '').match(/^\/v1\/(\w+)$/)?.[1]
    if (name === 'help' && request.method === 'GET') return send(response, 200, { result: help() })
    if (name === 'register' && request.method === 'POST') {
      return isRegisterToken ? register(request, response) : send(response, 403, { error: 'Forbidden' })
    }
    // A client from before per-agent tokens sends the register token.
    if (isRegisterToken) return send(response, 403, { error: TOO_OLD })
    if (!name || !Object.hasOwn(table, name) || request.method !== 'POST') return send(response, 404, { error: 'Unknown method' })
    const method = table[name]
    // Looks the agent up again each time: the user may remove it or lower its level while the body comes.
    const refused = (): { status: number; error: string } | null => {
      const agent = byHash(sent)
      if (!agent) return { status: 401, error: 'Wrong token' }
      const effective = effectiveAccess(agent)
      if (effective !== 'full' && (effective !== 'read' || method.write)) {
        if (agent.level === 'pending') {
          askAgain(agent)
          return { status: 403, error: waiting(agent.name) }
        }
        return { status: 403, error: agent.level === 'off' ? turnedOff(agent.name) : readOnly(agent.name) }
      }
      // The prompt is in the page: while it is open, no agent may send input to the page.
      if (asking && PAGE_INPUT.has(name)) return { status: 409, error: ASKING }
      return null
    }
    let refusal = refused()
    if (refusal) return send(response, refusal.status, { error: refusal.error })
    let body: Record<string, unknown>
    try {
      const text = await readBody(request)
      body = text.trim() === '' ? {} : JSON.parse(text)
      if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('Not an object')
    } catch {
      return send(response, 400, { error: 'The body must be a JSON object.' })
    }
    // Again: the user may have lowered the access while the body came.
    refusal = refused()
    if (refusal) return send(response, refusal.status, { error: refusal.error })
    const agent = byHash(sent)!
    const effective = effectiveAccess(agent)
    const running = Promise.resolve().then(() => {
      // Once more, first thing before the run: another request may have opened a prompt since the check above.
      if (asking && PAGE_INPUT.has(name)) throw new Error(ASKING)
      return method.run(body, effective)
    })
    if (method.write) o.track(running)
    const logLine = { agent: agent.name, agentId: agent.id, method: name, body }
    try {
      const result = await running
      if (method.write) log(logLine)
      send(response, 200, { result: withLocalTimes(result ?? null) })
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      if (method.write) log({ ...logLine, error })
      send(response, error === ASKING ? 409 : 400, { error })
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

  // Also ends open connections, so a request whose body is still coming cannot run after Off. An open prompt closes.
  const stop = (): void => {
    server?.closeAllConnections()
    server?.close()
    server = null
    rmSync(join(o.dir, API_FILE), { force: true })
    toAsk.length = 0
    asking?.abort.abort()
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
    stop,
    // No hashes.
    agents: () => agents.map(({ id, name, level }) => ({ id, name, level })),
    setAgentLevel,
    removeAgent
  }
}
