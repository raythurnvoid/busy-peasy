import { execFile, execFileSync, spawn } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer, request, type ClientRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Api } from '../shared/api'
import { ASKING, type AgentAccess, type ApprovalAnswer } from '../shared/approval'
import { readAgentAccess, startAgent, type AgentOptions } from './agent'

let dir: string
let api: Partial<Record<keyof Api, ReturnType<typeof vi.fn>>>
let agent: ReturnType<typeof startAgent>
let track: ReturnType<typeof vi.fn<(write: Promise<unknown>) => void>>
let command: ReturnType<typeof vi.fn<AgentOptions['command']>>
let press: ReturnType<typeof vi.fn<AgentOptions['press']>>
let encrypt: ReturnType<typeof vi.fn<AgentOptions['encrypt']>>
let ask: ReturnType<typeof vi.fn<AgentOptions['ask']>>
let agentsChanged: ReturnType<typeof vi.fn<() => void>>

function start(access: AgentAccess): void {
  writeFileSync(join(dir, 'agent-access.json'), JSON.stringify({ access }))
  agent = startAgent({
    api: api as unknown as Api,
    dir,
    cli: 'busy-peasy.mjs',
    version: '1.0.0',
    // Any id is an event, so openEvent and editEvent get as far as the page.
    getEvent: (eventId) => ({ id: eventId }) as never,
    command,
    press,
    screenshot: vi.fn(async () => ''),
    track,
    encrypt,
    decrypt: async (data) => data.toString(),
    ask,
    agentsChanged
  })
}

// The address file appears once the server listens.
async function apiFile(): Promise<{ url: string; token: string; access: string }> {
  await vi.waitFor(() => expect(existsSync(join(dir, 'agent-api.json'))).toBe(true))
  return JSON.parse(readFileSync(join(dir, 'agent-api.json'), 'utf8'))
}

// node:http, not fetch: fetch cannot set Host. token: the register token by default. beforeBody: runs (and is awaited)
// after the server got the headers, before the body is sent.
async function call(
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string>; token?: string; beforeBody?(): unknown } = {}
): Promise<{ status: number; body: { result?: unknown; error?: string } }> {
  const file = await apiFile()
  const url = new URL(file.url + path)
  let req!: ClientRequest
  const answer = new Promise<{ status: number; body: { result?: unknown; error?: string } }>((resolve, reject) => {
    req = request(
      url,
      { method: options.method ?? 'POST', headers: { Authorization: `Bearer ${options.token ?? file.token}`, ...options.headers } },
      (res) => {
        let text = ''
        res.on('data', (chunk) => (text += chunk))
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text) }))
      }
    )
    req.on('error', reject)
  })
  if (options.beforeBody) {
    req.flushHeaders()
    // Time for the server to get the headers and check the token once.
    await new Promise((resolve) => setTimeout(resolve, 200))
    await options.beforeBody()
  }
  req.end(options.body === undefined ? undefined : JSON.stringify(options.body))
  return answer
}

async function register(name: string): Promise<{ token: string; name: string; id: string }> {
  const { body } = await call('/v1/register', { body: { name } })
  const result = body.result as { token: string; name: string }
  return { ...result, id: agent.agents().find((a) => a.name === result.name)!.id }
}

// A registered agent that the user allowed.
async function allowedAgent(access: AgentAccess, name = 'test agent'): Promise<{ token: string; id: string }> {
  const registered = await register(name)
  agent.setAgentLevel(registered.id, access)
  return registered
}

// ask waits for the test: answers[i] answers the i-th prompt. Like the prompt, it also closes when the signal aborts.
function heldAsk(): ((answer: ApprovalAnswer) => void)[] {
  const answers: ((answer: ApprovalAnswer) => void)[] = []
  ask.mockImplementation(
    (_request, signal) =>
      new Promise((resolve) => {
        answers.push(resolve)
        signal.addEventListener('abort', () => resolve(null))
      })
  )
  return answers
}

const saved = (): string => readFileSync(join(dir, 'agents.bin'), 'utf8')
const logText = (): string => readFileSync(join(dir, 'agent-log.jsonl'), 'utf8')
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'busy-peasy-agent-'))
  api = { listEvents: vi.fn(async () => []), createEvent: vi.fn(async () => ({})), updateEvent: vi.fn(async () => ({})) }
  track = vi.fn()
  command = vi.fn(async () => ({}))
  press = vi.fn(async () => {})
  // Plain text: the test reads agents.bin.
  encrypt = vi.fn(async (text: string) => Buffer.from(text))
  // Like the prompt: it closes when the signal aborts.
  ask = vi.fn(
    (_request, signal) => new Promise<ApprovalAnswer>((resolve) => signal.addEventListener('abort', () => resolve(null)))
  )
  agentsChanged = vi.fn()
})

afterEach(() => {
  agent?.stop()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('startAgent', () => {
  it('enables agent requests on first use and keeps unreadable settings off', () => {
    expect(readAgentAccess(dir)).toBe('full')
    writeFileSync(join(dir, 'agent-access.json'), '{')
    expect(readAgentAccess(dir)).toBe('off')
  })

  it('opens nothing while off, and removes an address file left by a crash', () => {
    writeFileSync(join(dir, 'agent-api.json'), '{}')
    start('off')
    expect(existsSync(join(dir, 'agent-api.json'))).toBe(false)
    expect(readAgentAccess(dir)).toBe('off')
  })

  it('refuses a call without the token, from a web page, or for another host', async () => {
    start('read')
    expect((await call('/v1/help', { method: 'GET', headers: { Authorization: 'Bearer nope' } })).status).toBe(401)
    expect((await call('/v1/listEvents', { token: 'nope', body: {} })).status).toBe(401)
    expect((await call('/v1/help', { method: 'GET', headers: { Origin: 'https://evil.example' } })).status).toBe(403)
    expect((await call('/v1/help', { method: 'GET', headers: { Host: 'evil.example' } })).status).toBe(403)
    expect((await call('/v1/register', { body: { name: 'evil' }, headers: { Origin: 'https://evil.example' } })).status).toBe(403)
    const help = await call('/v1/help', { method: 'GET' })
    expect(help.status).toBe(200)
    expect(help.body.result).toMatchObject({ access: 'read', methods: { createEvent: { write: true } } })
  })

  it('registers an agent with its own token, and keeps only its hash', async () => {
    start('full')
    const { status, body } = await call('/v1/register', { body: { name: 'Claude Code' } })
    expect(status).toBe(200)
    const { token, name } = body.result as { token: string; name: string }
    expect(name).toBe('Claude Code')
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(saved()).not.toContain(token)
    expect(saved()).toContain(createHash('sha256').update(token).digest('hex'))
    expect(agent.agents()).toEqual([{ id: expect.any(String), name: 'Claude Code', level: 'pending' }])
  })

  it('refuses a waiting agent, and asks the user once', async () => {
    start('full')
    const { token } = await register('Claude Code')
    const response = await call('/v1/listEvents', { token, body: { start: 0, end: 1 } })
    expect(response.status).toBe(403)
    expect(response.body.error).toContain('waiting for the user to allow "Claude Code"')
    expect(api.listEvents).not.toHaveBeenCalled()
    expect(ask).toHaveBeenCalledOnce()
    expect(ask).toHaveBeenCalledWith({ id: agent.agents()[0].id, name: 'Claude Code', twin: false, trayAccess: 'full' }, expect.any(AbortSignal))
  })

  it('gives the level the user picks in the prompt', async () => {
    ask.mockResolvedValueOnce('read')
    start('full')
    const { token } = await register('Claude Code')
    await vi.waitFor(() => expect(agent.agents()[0].level).toBe('read'))
    expect((await call('/v1/listEvents', { token, body: { start: 0, end: 1 } })).status).toBe(200)
    const write = await call('/v1/createEvent', { token, body: { input: { calendarId: 1 } } })
    expect(write).toEqual({ status: 403, body: { error: expect.stringContaining('gives "Claude Code" Read only access') } })
    expect(api.createEvent).not.toHaveBeenCalled()
  })

  it.each([
    ['read', 'full', 403],
    ['full', 'read', 403],
    ['full', 'full', 200]
  ] as const)('tray %s and agent %s: a write gives %i', async (tray, level, status) => {
    start(tray)
    const { token } = await allowedAgent(level)
    expect((await call('/v1/createEvent', { token, body: { input: { calendarId: 1 } } })).status).toBe(status)
  })

  it('tells an old client that sends the register token to update, and gives help with any token', async () => {
    start('read')
    const old = await call('/v1/listEvents', { body: {} })
    expect(old.status).toBe(403)
    expect(old.body.error).toContain('client is too old')
    expect(api.listEvents).not.toHaveBeenCalled()
    const { token } = await allowedAgent('full')
    // help always shows the tray level.
    expect((await call('/v1/help', { method: 'GET' })).body.result).toMatchObject({ access: 'read' })
    expect((await call('/v1/help', { method: 'GET', token })).body.result).toMatchObject({ access: 'read' })
    // An agent cannot register more agents.
    expect(await call('/v1/register', { token, body: { name: 'other' } })).toEqual({ status: 403, body: { error: 'Forbidden' } })
  })

  it('refuses an agent removed or turned off while its body comes', async () => {
    start('full')
    const first = await allowedAgent('full')
    const removed = await call('/v1/listEvents', { token: first.token, body: {}, beforeBody: () => agent.removeAgent(first.id) })
    expect(removed).toEqual({ status: 401, body: { error: 'Wrong token' } })
    const second = await allowedAgent('full', 'second')
    const off = await call('/v1/listEvents', { token: second.token, body: {}, beforeBody: () => agent.setAgentLevel(second.id, 'off') })
    expect(off.status).toBe(403)
    expect(off.body.error).toContain('The user turned off "second"')
    expect(api.listEvents).not.toHaveBeenCalled()
  })

  it('names a second agent with the same name " (2)", with its own token, and warns', async () => {
    start('full')
    const first = await allowedAgent('full', 'Claude Code')
    const second = await register('Claude Code')
    expect(second.name).toBe('Claude Code (2)')
    expect(second.token).not.toBe(first.token)
    expect((await call('/v1/listEvents', { token: first.token, body: {} })).status).toBe(200)
    await vi.waitFor(() =>
      expect(ask).toHaveBeenLastCalledWith({ id: expect.any(String), name: 'Claude Code (2)', twin: true, trayAccess: 'full' }, expect.any(AbortSignal))
    )
    // Sent on purpose: still a free suffix and the warning.
    const third = await register('Claude Code (2)')
    expect(third.name).toBe('Claude Code (3)')
    agent.setAgentLevel(second.id, 'off')
    await vi.waitFor(() =>
      expect(ask).toHaveBeenLastCalledWith({ id: expect.any(String), name: 'Claude Code (3)', twin: true, trayAccess: 'full' }, expect.any(AbortSignal))
    )
    for (const { id } of agent.agents()) agent.removeAgent(id)
    expect((await register('Claude Code')).name).toBe('Claude Code')
    await vi.waitFor(() =>
      expect(ask).toHaveBeenLastCalledWith({ id: expect.any(String), name: 'Claude Code', twin: false, trayAccess: 'full' }, expect.any(AbortSignal))
    )
  })

  it('warns about a second agent whose name differs only by a character that shows nothing', async () => {
    start('full')
    await allowedAgent('full', 'Claude Code')
    const second = await register(`Claude Code${String.fromCodePoint(0xe0100)}`)
    expect(second.name).toBe('Claude Code (2)')
    await vi.waitFor(() =>
      expect(ask).toHaveBeenLastCalledWith({ id: second.id, name: 'Claude Code (2)', twin: true, trayAccess: 'full' }, expect.any(AbortSignal))
    )
  })

  it('lets at most 3 agents wait, and asks one at a time', async () => {
    const answers: ((answer: ApprovalAnswer) => void)[] = []
    ask.mockImplementation(() => new Promise((resolve) => answers.push(resolve)))
    start('full')
    for (const name of ['a', 'b', 'c']) await register(name)
    const fourth = await call('/v1/register', { body: { name: 'd' } })
    expect(fourth.status).toBe(429)
    expect(fourth.body.error).toContain('Too many agents are waiting')
    expect(ask).toHaveBeenCalledOnce()
    answers[0]('off')
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(2))
    expect(ask.mock.lastCall![0].name).toBe('b')
  })

  it('keeps at most 20 agents', { timeout: 30_000 }, async () => {
    start('full')
    for (let i = 0; i < 20; i++) await allowedAgent(i < 17 ? 'off' : 'full', `agent ${i}`)
    const response = await call('/v1/register', { body: { name: 'one more' } })
    expect(response).toEqual({ status: 429, body: { error: 'Busy Peasy has 20 agents. The user must remove one first, in the tray menu: Agent access.' } })
  })

  it('keeps allowed agents after a restart, and none from a broken file', async () => {
    start('full')
    const { token } = await allowedAgent('full')
    await vi.waitFor(() => expect(saved()).toContain('"level":"full"'))
    agent.stop()
    start('full')
    expect((await call('/v1/listEvents', { token, body: {} })).status).toBe(200)
    agent.stop()
    writeFileSync(join(dir, 'agents.bin'), 'garbage')
    start('full')
    expect((await call('/v1/listEvents', { token, body: {} })).status).toBe(401)
    expect(agent.agents()).toEqual([])
  })

  it('tells the tray when the list has loaded', async () => {
    start('full')
    await vi.waitFor(() => expect(agentsChanged).toHaveBeenCalled())
  })

  it('cleans agent names', async () => {
    start('full')
    const c = (...codes: number[]): string => String.fromCharCode(...codes)
    const named = async (sent: string): Promise<string> => {
      const { id, name } = await register(sent)
      agent.removeAgent(id)
      return name
    }
    // Quotes, a control character, a zero-width space and a tab become spaces.
    expect(await named(`"Claude"${c(0, 0x200b, 9)} Code`)).toBe('Claude Code')
    expect(await named('repo/scripts/sync.mjs')).toBe('repo scripts sync.mjs')
    expect(await named("O'Brien's bot")).toBe('O Brien s bot')
    expect(await named('x'.repeat(60))).toBe('x'.repeat(40))
    // Hindi keeps its vowel signs and virama: marks.
    const hindi = c(0x939, 0x93f, 0x928, 0x94d, 0x926, 0x940)
    expect(await named(hindi)).toBe(hindi)
    // e + a combining accent is the same name as the one letter with the accent.
    expect(await named('Cafe' + c(0x301))).toBe('Caf' + c(0xe9))
    // Characters that show nothing go, also marks (variation selectors, also past U+FFFF) and Hangul fillers (letters).
    for (const code of [0x34f, 0xfe00, 0xfe0f, 0x180b, 0x180f, 0x17b4, 0x17b5, 0xe0100, 0xe01ef]) {
      expect(await named(`Claude${String.fromCodePoint(code)}Code`)).toBe('ClaudeCode')
    }
    const fillers = [0x115f, 0x1160, 0x3164, 0xffa0].map((code) => c(code))
    for (const filler of fillers) expect(await named(`Claude${filler}Code`)).toBe('ClaudeCode')
    for (const name of ['""', fillers.join(''), c(0x2800, 0x34f), 5]) {
      expect(await call('/v1/register', { body: { name } })).toEqual({ status: 400, body: { error: 'Give the agent a name.' } })
    }
    expect((await call('/v1/register', { body: 'not json' })).status).toBe(400)
  })

  it('ignores a prompt answer that comes after the tray changed or removed the agent', async () => {
    const answers: ((answer: ApprovalAnswer) => void)[] = []
    ask.mockImplementation(() => new Promise((resolve) => answers.push(resolve)))
    start('full')
    const { id, token } = await register('a')
    agent.setAgentLevel(id, 'read')
    expect(ask.mock.calls[0][1].aborted).toBe(true)
    answers[0]('full')
    await tick()
    expect(agent.agents()[0].level).toBe('read')
    expect((await call('/v1/createEvent', { token, body: { input: { calendarId: 1 } } })).status).toBe(403)
    const removed = await register('b')
    await vi.waitFor(() => expect(answers).toHaveLength(2))
    agent.removeAgent(removed.id)
    answers[1]('full')
    await tick()
    expect(agent.agents().map((a) => a.name)).toEqual(['a'])
  })

  it('brings the window up for an agent with Full access, not with Read only', async () => {
    start('full')
    const reader = await allowedAgent('read', 'reader')
    expect((await call('/v1/openSettings', { token: reader.token })).status).toBe(200)
    expect(command).toHaveBeenLastCalledWith('openSettings', {}, false)
    const writer = await allowedAgent('full', 'writer')
    expect((await call('/v1/openSettings', { token: writer.token })).status).toBe(200)
    expect(command).toHaveBeenLastCalledWith('openSettings', {}, true)
  })

  it('lets only an agent with Full access start adding an account', async () => {
    start('full')
    const reader = await allowedAgent('read', 'reader')
    expect((await call('/v1/addAccount', { token: reader.token, body: { provider: 'google' } })).status).toBe(403)
    expect(command).not.toHaveBeenCalledWith('addAccount', expect.anything(), expect.anything())
    const writer = await allowedAgent('full', 'writer')
    expect((await call('/v1/addAccount', { token: writer.token, body: { provider: 'google' } })).status).toBe(200)
    expect(command).toHaveBeenLastCalledWith('addAccount', { provider: 'google' }, true)
  })

  it('closes the prompt when the tray turns agent access off', async () => {
    start('full')
    await register('a')
    agent.setAccess('off')
    expect(ask.mock.calls[0][1].aborted).toBe(true)
  })

  it('closes the prompt when the tray removes its agent', async () => {
    start('full')
    const { id } = await register('a')
    agent.removeAgent(id)
    expect(ask.mock.calls[0][1].aborted).toBe(true)
  })

  it('does not close the prompt the user just answered', async () => {
    const answers = heldAsk()
    start('full')
    const { id } = await register('a')
    answers[0]('read')
    await tick()
    expect(agent.agents().find((a) => a.id === id)!.level).toBe('read')
    expect(ask.mock.calls[0][1].aborted).toBe(false)
  })

  it('skips a queued agent that the tray set or removed', async () => {
    const answers = heldAsk()
    start('full')
    await register('a')
    const b = await register('b')
    const c = await register('c')
    agent.setAgentLevel(b.id, 'read')
    agent.removeAgent(c.id)
    // Other agents' changes leave a's prompt open.
    expect(ask.mock.calls[0][1].aborted).toBe(false)
    answers[0](null)
    await tick()
    expect(ask).toHaveBeenCalledOnce()
  })

  it('takes a failed prompt as no answer, and asks the next agent', async () => {
    let fail!: (e: Error) => void
    ask.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)))
    start('full')
    const a = await register('a')
    await register('b')
    expect(ask).toHaveBeenCalledOnce()
    fail(new Error('No window'))
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(2))
    expect(ask.mock.lastCall![0].name).toBe('b')
    expect(agent.agents().find((x) => x.id === a.id)!.level).toBe('pending')
  })

  it('refuses page input from every agent while the prompt is open, and lets them read', async () => {
    start('full')
    const { token } = await allowedAgent('full')
    await register('new agent')
    // Every method, so a new one cannot slip past the gate: only snapshot and getState may reach the page.
    const { methods } = (await call('/v1/help', { method: 'GET' })).body.result as { methods: Record<string, unknown> }
    for (const method of Object.keys(methods)) {
      command.mockClear()
      press.mockClear()
      const { status, body } = await call(`/v1/${method}`, { token, body: { key: 'Enter', eventId: 1, text: 'a', input: {} } })
      const reached = [...command.mock.calls.map(([name]) => name), ...press.mock.calls.map(() => 'press key')]
      expect({ method, page: reached.filter((name) => name !== 'snapshot' && name !== 'getState') }).toEqual({ method, page: [] })
      if (status === 409) expect(body.error).toBe(ASKING)
    }
    for (const method of ['snapshot', 'getState', 'screenshot', 'listEvents']) {
      expect((await call(`/v1/${method}`, { token, body: {} })).status).toBe(200)
    }
  })

  it.each(['read', null] as const)('lets page input through again once the prompt is answered (%s)', async (answer) => {
    const answers = heldAsk()
    start('full')
    const { token } = await allowedAgent('full')
    await register('new agent')
    expect((await call('/v1/press', { token, body: { key: 'Tab' } })).status).toBe(409)
    answers[1](answer)
    await tick()
    expect((await call('/v1/press', { token, body: { key: 'Tab' } })).status).toBe(200)
    expect(press).toHaveBeenCalledWith('Tab')
  })

  it('refuses page input whose body comes after the prompt opened', async () => {
    start('full')
    const { token } = await allowedAgent('full')
    const late = await call('/v1/press', { token, body: { key: 'Enter' }, beforeBody: () => register('new agent') })
    expect(late).toEqual({ status: 409, body: { error: ASKING } })
    expect(press).not.toHaveBeenCalled()
  })

  it('leaves no gap between two prompts', async () => {
    const answers = heldAsk()
    start('full')
    const { token } = await allowedAgent('full')
    await register('a')
    await register('b')
    answers[1](null)
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(3))
    expect((await call('/v1/press', { token, body: { key: 'Tab' } })).status).toBe(409)
  })

  it('drops Waiting agents at a restart', async () => {
    start('full')
    await allowedAgent('full', 'allowed')
    await register('waiting')
    await vi.waitFor(() => expect(saved()).toContain('"name":"waiting"'))
    agent.stop()
    start('full')
    // help waits until the list has loaded.
    await call('/v1/help', { method: 'GET' })
    expect(agent.agents().map((a) => a.name)).toEqual(['allowed'])
  })

  it('asks a Waiting agent again at once when it calls after its prompt closed, but not while it is asked', async () => {
    const answers = heldAsk()
    start('full')
    const { token } = await register('a')
    const listEvents = (): ReturnType<typeof call> => call('/v1/listEvents', { token, body: {} })
    // While it is asked: no new prompt.
    expect((await listEvents()).status).toBe(403)
    expect(ask).toHaveBeenCalledOnce()
    // Closed without an answer, for example agent access turned off and on again.
    answers[0](null)
    await tick()
    expect((await listEvents()).status).toBe(403)
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it('lets only 3 of 4 registers at once wait', async () => {
    start('full')
    const statuses = await Promise.all(['a', 'b', 'c', 'd'].map(async (name) => (await call('/v1/register', { body: { name } })).status))
    expect(statuses.sort()).toEqual([200, 200, 200, 429])
  })

  it('saves level changes in order', async () => {
    start('full')
    const { id } = await allowedAgent('full')
    await vi.waitFor(() => expect(saved()).toContain('"level":"full"'))
    // The first save is slow: the second must still land last.
    encrypt.mockImplementationOnce(async (text) => {
      await new Promise((resolve) => setTimeout(resolve, 100))
      return Buffer.from(text)
    })
    agent.setAgentLevel(id, 'read')
    agent.setAgentLevel(id, 'off')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(saved()).toContain('"level":"off"')
  })

  it('logs a failed write with the agent and the error', async () => {
    api.createEvent = vi.fn(async () => {
      throw new Error('Offline')
    })
    start('full')
    const { id, token } = await allowedAgent('full')
    expect(await call('/v1/createEvent', { token, body: { input: { calendarId: 1 } } })).toEqual({ status: 400, body: { error: 'Offline' } })
    expect(JSON.parse(logText())).toMatchObject({ agent: 'test agent', agentId: id, method: 'createEvent', error: 'Offline' })
  })

  it('proves it knows the register token, without a token', async () => {
    start('read')
    const nonce = 'ab'.repeat(32)
    const { token } = await apiFile()
    const hello = await call('/v1/hello', { body: { nonce }, headers: { Authorization: '' } })
    expect(hello).toEqual({ status: 200, body: { result: { proof: createHmac('sha256', token).update(nonce).digest('hex') } } })
    expect((await call('/v1/hello', { body: { nonce: 'short' } })).status).toBe(400)
    expect((await call('/v1/hello', { body: { nonce }, headers: { Origin: 'https://evil.example' } })).status).toBe(403)
  })

  it('removes agents.bin when a level change cannot be saved', async () => {
    start('full')
    const { id, token } = await allowedAgent('full')
    await vi.waitFor(() => expect(saved()).toContain('"level":"full"'))
    encrypt.mockRejectedValueOnce(new Error('broken'))
    agent.setAgentLevel(id, 'off')
    expect((await call('/v1/listEvents', { token, body: {} })).status).toBe(403)
    await vi.waitFor(() => expect(existsSync(join(dir, 'agents.bin'))).toBe(false))
    expect(logText()).toContain('Could not save the agent list: broken')
  })

  it('answers 500 when a new agent cannot be saved, and removes agents.bin', async () => {
    start('full')
    const first = await allowedAgent('full')
    await vi.waitFor(() => expect(saved()).toContain('"level":"full"'))
    encrypt.mockRejectedValueOnce(new Error('broken'))
    expect(await call('/v1/register', { body: { name: 'b' } })).toEqual({ status: 500, body: { error: 'Could not save the agent.' } })
    expect(agent.agents().map((a) => a.name)).toEqual(['test agent'])
    expect(existsSync(join(dir, 'agents.bin'))).toBe(false)
    // Until a restart.
    expect((await call('/v1/listEvents', { token: first.token, body: {} })).status).toBe(200)
  })

  it('keeps saving after a save whose file cannot be removed', async () => {
    start('full')
    const { id } = await register('a')
    // A folder: rename and remove both fail.
    rmSync(join(dir, 'agents.bin'))
    mkdirSync(join(dir, 'agents.bin'))
    agent.setAgentLevel(id, 'read')
    expect(agent.agents()[0].level).toBe('read')
    agent.setAgentLevel(id, 'off')
    expect(agent.agents()[0].level).toBe('off')
    await vi.waitFor(() => expect(logText().match(/Could not save the agent list/g)).toHaveLength(2))
  })

  it('creates an event from ISO times with the text fields left out, and logs it with the agent', async () => {
    start('full')
    const { id, token } = await allowedAgent('full')
    const input = { calendarId: 1, title: 'Lunch', start: '2026-11-10T12:00:00Z', end: '2026-11-10T13:00:00Z' }
    expect((await call('/v1/createEvent', { token, body: { input, notify: false } })).status).toBe(200)
    expect(api.createEvent).toHaveBeenCalledWith(
      {
        calendarId: 1,
        title: 'Lunch',
        location: '',
        description: '',
        allDay: false,
        startDate: null,
        endDate: null,
        start: Date.UTC(2026, 10, 10, 12),
        end: Date.UTC(2026, 10, 10, 13)
      },
      false
    )
    // Quit waits for it.
    expect(track).toHaveBeenCalledOnce()
    const log = logText().trim().split('\n').map((line) => JSON.parse(line))
    expect(log).toEqual([
      expect.objectContaining({ agent: 'test agent', agentId: id, method: 'createEvent', body: { input, notify: false } })
    ])
    // Never a token.
    expect(logText()).not.toContain(token)
    expect(logText()).not.toContain((await apiFile()).token)
  })

  it('gives timed events their local times, and not all-day events', async () => {
    const timed = { id: 1, allDay: false, start: Date.UTC(2026, 10, 10, 12), end: Date.UTC(2026, 10, 10, 13) }
    const allDay = { id: 2, allDay: true, start: Date.UTC(2026, 10, 10), end: Date.UTC(2026, 10, 11) }
    api.listEvents = vi.fn(async () => [timed, allDay])
    start('read')
    const { token } = await allowedAgent('read')
    const response = await call('/v1/listEvents', { token, body: { start: 0, end: 1 } })
    const [first, second] = response.body.result as Record<string, unknown>[]
    expect(Date.parse(first.startLocal as string)).toBe(timed.start)
    expect(Date.parse(first.endLocal as string)).toBe(timed.end)
    expect(second.startLocal).toBeUndefined()
  })

  it('closes the server and removes the address file when turned off', async () => {
    start('full')
    const { url } = await apiFile()
    agent.setAccess('off')
    expect(existsSync(join(dir, 'agent-api.json'))).toBe(false)
    expect(readAgentAccess(dir)).toBe('off')
    await expect(fetch(url + '/v1/help')).rejects.toThrow()
  })

  it('turns an all-day event into a timed one without its old dates', async () => {
    start('full')
    const { token } = await allowedAgent('full')
    const patch = { allDay: false, start: '2026-11-10T12:00:00Z', end: '2026-11-10T13:00:00Z' }
    expect((await call('/v1/updateEvent', { token, body: { eventId: 5, patch } })).status).toBe(200)
    expect(api.updateEvent).toHaveBeenCalledWith(
      5,
      { allDay: false, start: Date.UTC(2026, 10, 10, 12), end: Date.UTC(2026, 10, 10, 13), startDate: null, endDate: null },
      { notify: undefined, scope: undefined }
    )
  })

  it('takes a changed startLocal as the start, and refuses one that disagrees with start', async () => {
    start('full')
    const { token } = await allowedAgent('full')
    const local = { startLocal: '2026-11-10T12:00:00Z', endLocal: '2026-11-10T13:00:00Z' }
    await call('/v1/updateEvent', { token, body: { eventId: 5, patch: local } })
    expect(api.updateEvent).toHaveBeenCalledWith(5, { start: Date.UTC(2026, 10, 10, 12), end: Date.UTC(2026, 10, 10, 13) }, expect.anything())
    const both = await call('/v1/updateEvent', { token, body: { eventId: 5, patch: { ...local, start: 0 } } })
    expect(both).toEqual({ status: 400, body: { error: 'start and startLocal differ. Send only start.' } })
    expect(api.updateEvent).toHaveBeenCalledOnce()
  })

  it('stops reading a body that is too large, and keeps serving', async () => {
    start('read')
    const { token } = await allowedAgent('read')
    // Cut, not answered: the server stopped reading.
    await expect(call('/v1/listEvents', { token, body: 'x'.repeat(1_100_000) })).rejects.toThrow()
    expect(api.listEvents).not.toHaveBeenCalled()
    expect((await call('/v1/help', { method: 'GET' })).status).toBe(200)
  })

  // %APPDATA% passes its entries down. A bare folder passes nothing down (like the CI temp folder), so the new file
  // gets its own Administrators and SYSTEM entries.
  const onWindows = it.runIf(process.platform === 'win32')
  onWindows.each([false, true])(
    'only this user can read the token file and the agent list (bare folder: %s)',
    async (bare) => {
      const grant = ['/inheritance:r', '/grant:r', `${userInfo().username}:F`]
      if (bare) execFileSync('icacls', [dir, ...grant], { stdio: 'ignore' })
      start('read')
      await register('a')
      for (const file of ['agent-api.json', 'agents.bin']) {
        const acl = execFileSync('icacls', [join(dir, file)], { encoding: 'utf8' })
        // (I): a permission inherited from the folder, like CodexSandboxUsers on %APPDATA%.
        expect(acl).not.toContain('(I)')
        // One entry: this user, full control.
        expect(acl.match(/:\(\w+\)/g)).toEqual([':(F)'])
      }
    }
  )
})

describe('busy-peasy.mjs', () => {
  const env = { ...process.env }
  const appData = mkdtempSync(join(tmpdir(), 'busy-peasy-client-'))
  let client: { call(method: string, params?: unknown): Promise<unknown> }

  beforeAll(async () => {
    // Before the import: the client reads them then. BUSY_PEASY_DEV: a failed call must never start the installed app.
    process.env.APPDATA = appData
    process.env.BUSY_PEASY_DEV = '1'
    process.env.BUSY_PEASY_AGENT = 'test agent'
    // Most tests inspect the waiting response directly.
    process.env.BUSY_PEASY_WAIT_MS = '0'
    client = await import(pathToFileURL(join(process.cwd(), 'resources/busy-peasy.mjs')).href)
  })

  afterAll(() => {
    process.env = env
    rmSync(appData, { recursive: true, force: true })
  })

  // The client's dev folder.
  beforeEach(() => {
    rmSync(dir, { recursive: true, force: true })
    dir = join(appData, 'busy-peasy-dev')
    mkdirSync(dir)
  })

  // Some tests change these.
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    process.env.BUSY_PEASY_AGENT = 'test agent'
    process.env.BUSY_PEASY_WAIT_MS = '0'
  })

  // The client reads agent-api.json at each call: wait until the server listens.
  const startApp = async (): Promise<void> => {
    start('full')
    await apiFile()
  }
  const tokenPath = (): string => join(dir, 'agent-tokens', readdirSync(join(dir, 'agent-tokens'))[0])
  const listEvents = (): Promise<unknown> => client.call('listEvents', { start: 0, end: 1 })

  it.each(['full', 'read'] as const)('asks in the app when a reader moves an event and accepts the %s answer', async (answer) => {
    const answers = heldAsk()
    await startApp()
    await expect(listEvents()).rejects.toThrow('waiting')
    answers[0]('read')
    await expect(listEvents()).resolves.toEqual([])
    delete process.env.BUSY_PEASY_WAIT_MS
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const move = client.call('updateEvent', { eventId: 1, patch: { start: 100, end: 200 } })
    const result = move.then(() => 'moved', (error: Error) => error.message)
    await vi.waitFor(() => expect(answers).toHaveLength(2))
    clock.mockReturnValue(now + 60_000)
    // Let the client poll past its old deadline before answering.
    await new Promise((resolve) => setTimeout(resolve, 2200))
    expect(api.updateEvent).not.toHaveBeenCalled()
    answers[1](answer)
    if (answer === 'full') {
      expect(await result).toBe('moved')
      expect(api.updateEvent).toHaveBeenCalledOnce()
    } else {
      expect(await result).toContain('Read only')
      expect(api.updateEvent).not.toHaveBeenCalled()
    }
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it('registers, waits for the user, works once allowed, and registers again after Remove', async () => {
    await startApp()
    await expect(listEvents()).rejects.toThrow('Busy Peasy is waiting for the user to allow "test agent"')
    const { token } = JSON.parse(readFileSync(tokenPath(), 'utf8'))
    expect(saved()).toContain(createHash('sha256').update(token).digest('hex'))
    const { id } = agent.agents()[0]
    agent.setAgentLevel(id, 'read')
    await expect(listEvents()).resolves.toEqual([])
    agent.removeAgent(id)
    await expect(listEvents()).rejects.toThrow('waiting for the user')
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it('reads help without an agent', async () => {
    await startApp()
    expect(await client.call('help')).toMatchObject({ access: 'full' })
    expect(ask).not.toHaveBeenCalled()
    expect(agent.agents()).toEqual([])
  })

  it.runIf(process.platform === 'win32')('keeps the token folder and file for this user only', async () => {
    await startApp()
    await expect(listEvents()).rejects.toThrow('waiting')
    for (const path of [join(dir, 'agent-tokens'), tokenPath()]) {
      const entries = execFileSync('icacls', [path], { encoding: 'utf8' })
        .split('\n')
        .filter((line) => line.includes(':('))
      expect(entries).toHaveLength(1)
      expect(entries[0]).toContain(`${userInfo().username}:`)
      expect(entries[0]).toContain('(F)')
    }
  })

  it('keeps a new token that a parallel call saved after a 401', async () => {
    await startApp()
    await expect(listEvents()).rejects.toThrow('waiting')
    agent.removeAgent(agent.agents()[0].id)
    // An allowed agent's token, as a parallel call would save it.
    const fresh = await allowedAgent('full', 'helper')
    const asked = ask.mock.calls.length
    const realFetch = globalThis.fetch
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const response = await realFetch(input, init)
      if (response.status === 401) writeFileSync(tokenPath(), JSON.stringify({ name: 'test agent', token: fresh.token }))
      return response
    })
    await expect(listEvents()).resolves.toEqual([])
    expect(JSON.parse(readFileSync(tokenPath(), 'utf8')).token).toBe(fresh.token)
    expect(ask).toHaveBeenCalledTimes(asked)
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/v1/register'))).toBe(false)
  })

  it('registers again at most once per call', async () => {
    await startApp()
    await expect(listEvents()).rejects.toThrow('waiting')
    const realFetch = globalThis.fetch
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) =>
      String(input).endsWith('/v1/register')
        ? realFetch(input, init)
        : new Response(JSON.stringify({ error: 'Wrong token' }), { status: 401 })
    )
    await expect(listEvents()).rejects.toThrow('Wrong token')
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/v1/register'))).toHaveLength(1)
  })

  it('never saves a token in an agent-tokens folder that others may read', async () => {
    await startApp()
    // Made here, not by the client: it gets the temp folder's entries (Windows) or 755 (macOS, Linux).
    mkdirSync(join(dir, 'agent-tokens'), { mode: 0o755 })
    await expect(listEvents()).rejects.toThrow('Other accounts may read')
    expect(agent.agents()).toEqual([])
    expect(readdirSync(join(dir, 'agent-tokens'))).toEqual([])
  })

  it.runIf(process.platform === 'win32')('never saves a token in a locked folder that belongs to another account', async () => {
    await startApp()
    // One entry, not inherited, like the client's, but for Everyone.
    mkdirSync(join(dir, 'agent-tokens'))
    execFileSync('icacls', [join(dir, 'agent-tokens'), '/inheritance:r', '/grant:r', '*S-1-1-0:(OI)(CI)F'], { stdio: 'ignore' })
    await expect(listEvents()).rejects.toThrow('Other accounts may read')
    expect(agent.agents()).toEqual([])
  })

  it('sends no token to a program that cannot prove it is Busy Peasy', async () => {
    const seen: (string | undefined)[] = []
    let status = 200
    const fake = createServer((req, res) => {
      seen.push(req.headers.authorization)
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ result: { proof: '00'.repeat(32) } }))
    })
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`
    writeFileSync(join(dir, 'agent-api.json'), JSON.stringify({ url, token: 'a'.repeat(64), pid: process.pid }))
    try {
      await expect(listEvents()).rejects.toThrow('is not Busy Peasy')
      await expect(client.call('help')).rejects.toThrow('is not Busy Peasy')
      // An app from before the proof.
      status = 401
      await expect(listEvents()).rejects.toThrow('older than this client')
    } finally {
      fake.close()
    }
    expect(seen).toEqual([undefined, undefined, undefined])
  })

  it('proves the app again after a call could not reach it', async () => {
    await startApp()
    await expect(listEvents()).rejects.toThrow('waiting')
    agent.setAgentLevel(agent.agents()[0].id, 'read')
    await expect(listEvents()).resolves.toEqual([])
    // The app is gone; its file stays, as after a crash (the pid is this test's, so it looks alive).
    const file = readFileSync(join(dir, 'agent-api.json'), 'utf8')
    agent.stop()
    writeFileSync(join(dir, 'agent-api.json'), file)
    await expect(listEvents()).rejects.toThrow('is not running')
    // Another program takes the port.
    const seen: string[] = []
    const fake = createServer((req, res) => {
      seen.push(`${req.url} ${req.headers.authorization ? 'token' : 'no token'}`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ result: { proof: '00'.repeat(32) } }))
    })
    await new Promise<void>((resolve) => fake.listen(Number(new URL(JSON.parse(file).url).port), '127.0.0.1', resolve))
    try {
      await expect(listEvents()).rejects.toThrow('is not Busy Peasy')
    } finally {
      fake.close()
    }
    expect(seen).toEqual(['/v1/hello no token'])
  })

  it.runIf(process.platform === 'win32')('removes the agent-tokens folder when it cannot lock it', async () => {
    await startApp()
    // No icacls on the path.
    vi.stubEnv('PATH', '')
    await expect(listEvents()).rejects.toThrow('Could not protect the agent-tokens folder.')
    expect(existsSync(join(dir, 'agent-tokens'))).toBe(false)
    expect(agent.agents()).toEqual([])
  })

  it('waits for a young claim on its name, and takes over one older than 60 s', async () => {
    await startApp()
    // Another agent makes the folder.
    process.env.BUSY_PEASY_AGENT = 'first'
    await expect(listEvents()).rejects.toThrow('waiting')
    process.env.BUSY_PEASY_AGENT = 'test agent'
    // The client's file name for "test agent".
    const claim = join(dir, 'agent-tokens', `test-agent-${createHash('sha256').update('test agent').digest('hex').slice(0, 8)}.json`)
    writeFileSync(claim, '')
    await expect(listEvents()).rejects.toThrow('waiting for the user to allow "test agent"')
    expect(agent.agents().map((a) => a.name)).toEqual(['first'])
    const old = new Date(Date.now() - 61_000)
    utimesSync(claim, old, old)
    await expect(listEvents()).rejects.toThrow('waiting')
    expect(agent.agents().map((a) => a.name)).toEqual(['first', 'test agent'])
  })

  it.each([
    [404, 'This Busy Peasy is older than this client'],
    [429, 'Too many agents are waiting']
  ])('removes its claim when register fails (%i)', async (status, text) => {
    await startApp()
    const realFetch = globalThis.fetch
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) =>
      String(input).endsWith('/v1/register')
        ? new Response(JSON.stringify({ error: 'Too many agents are waiting' }), { status })
        : realFetch(input, init)
    )
    await expect(listEvents()).rejects.toThrow(text)
    expect(readdirSync(join(dir, 'agent-tokens'))).toEqual([])
  })

  it('uses the same token for the same name in another case', async () => {
    await startApp()
    await expect(listEvents()).rejects.toThrow('waiting')
    agent.setAgentLevel(agent.agents()[0].id, 'read')
    process.env.BUSY_PEASY_AGENT = 'Test Agent'
    await expect(listEvents()).resolves.toEqual([])
    expect(agent.agents()).toHaveLength(1)
  })

  it('tries again while the user decides, and gets through once allowed', async () => {
    await startApp()
    process.env.BUSY_PEASY_WAIT_MS = '10000'
    const result = listEvents()
    await vi.waitFor(() => expect(agent.agents()).toHaveLength(1))
    agent.setAgentLevel(agent.agents()[0].id, 'read')
    await expect(result).resolves.toEqual([])
  })

  it('gives the waiting text when the wait time ends', async () => {
    await startApp()
    // Registers first, so only the waiting is measured.
    await expect(listEvents()).rejects.toThrow('waiting for the user')
    process.env.BUSY_PEASY_WAIT_MS = '2500'
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await expect(listEvents()).rejects.toThrow('waiting for the user')
    // Once, then again after 2 s; not a third time, which would end after 2.5 s.
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/v1/listEvents'))).toHaveLength(2)
  })

  // Real CLI and MCP processes, as agents start them. No BUSY_PEASY_AGENT: the name must come from them.
  const cliPath = join(process.cwd(), 'resources/busy-peasy.mjs')
  const childEnv = (): NodeJS.ProcessEnv => ({ ...process.env, BUSY_PEASY_AGENT: '' })

  it('drops a cancelled MCP edit while the popup waits for an answer', async () => {
    const answers = heldAsk()
    await startApp()
    const child = spawn(process.execPath, [cliPath, 'mcp', '--dev'], { env: { ...childEnv(), BUSY_PEASY_WAIT_MS: '10000' } })
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
    const send = (message: object): boolean => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
    try {
      send({ id: 1, method: 'tools/call', params: { name: 'updateEvent', arguments: { eventId: 1, patch: { start: 100, end: 200 } } } })
      await vi.waitFor(() => expect(answers).toHaveLength(1))
      send({ method: 'notifications/cancelled', params: { requestId: 1 } })
      send({ id: 2, method: 'ping' })
      expect(JSON.parse(String((await lines.next()).value)).id).toBe(2)
      answers[0]('full')
      await new Promise((resolve) => setTimeout(resolve, 2200))
      expect(api.updateEvent).not.toHaveBeenCalled()
    } finally {
      child.kill()
    }
  })

  it('takes the name from --agent=', async () => {
    await startApp()
    const run = promisify(execFile)(process.execPath, [cliPath, '--dev', '--agent=qa cli', 'listEvents', '{}'], { env: childEnv() })
    await expect(run).rejects.toMatchObject({ stderr: expect.stringContaining('waiting for the user to allow "qa cli"') })
    expect(agent.agents().map((a) => a.name)).toEqual(['qa cli'])
  })

  it.each([
    [{ name: 'claude-code', title: 'Claude Code' }, 'Claude Code'],
    [{ name: 'codex' }, 'codex']
  ])('takes the MCP client\'s title, else its name (%o)', async (clientInfo, name) => {
    await startApp()
    const child = spawn(process.execPath, [cliPath, 'mcp', '--dev'], { env: childEnv() })
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
    const send = (message: object): boolean => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
    try {
      send({ id: 1, method: 'initialize', params: { clientInfo } })
      await lines.next()
      send({ id: 2, method: 'tools/call', params: { name: 'listEvents', arguments: {} } })
      const { value } = await lines.next()
      expect(JSON.parse(String(value)).result.content[0].text).toContain(`waiting for the user to allow "${name}"`)
    } finally {
      child.kill()
    }
    expect(agent.agents().map((a) => a.name)).toEqual([name])
  })
})
