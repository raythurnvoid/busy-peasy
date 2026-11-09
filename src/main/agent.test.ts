import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Api } from '../shared/api'
import { readAgentAccess, startAgent } from './agent'

let dir: string
let api: Partial<Record<keyof Api, ReturnType<typeof vi.fn>>>
let agent: ReturnType<typeof startAgent>
let track: ReturnType<typeof vi.fn<(write: Promise<unknown>) => void>>

function start(access: 'off' | 'read' | 'full'): void {
  writeFileSync(join(dir, 'agent-access.json'), JSON.stringify({ access }))
  agent = startAgent({
    api: api as unknown as Api,
    dir,
    cli: 'busy-peasy.mjs',
    version: '1.0.0',
    getEvent: () => null,
    command: vi.fn(async () => ({})),
    press: vi.fn(async () => {}),
    screenshot: vi.fn(async () => ''),
    track
  })
}

// The address file appears once the server listens.
async function apiFile(): Promise<{ url: string; token: string; access: string }> {
  await vi.waitFor(() => expect(existsSync(join(dir, 'agent-api.json'))).toBe(true))
  return JSON.parse(readFileSync(join(dir, 'agent-api.json'), 'utf8'))
}

// node:http, not fetch: fetch cannot set Host.
async function call(
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<{ status: number; body: { result?: unknown; error?: string } }> {
  const file = await apiFile()
  const url = new URL(file.url + path)
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: options.method ?? 'POST', headers: { Authorization: `Bearer ${file.token}`, ...options.headers } },
      (res) => {
        let text = ''
        res.on('data', (chunk) => (text += chunk))
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text) }))
      }
    )
    req.on('error', reject)
    req.end(options.body === undefined ? undefined : JSON.stringify(options.body))
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'busy-peasy-agent-'))
  api = { listEvents: vi.fn(async () => []), createEvent: vi.fn(async () => ({})), updateEvent: vi.fn(async () => ({})) }
  track = vi.fn()
})

afterEach(() => {
  agent?.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('startAgent', () => {
  it('opens nothing while off, and removes an address file left by a crash', () => {
    writeFileSync(join(dir, 'agent-api.json'), '{}')
    start('off')
    expect(existsSync(join(dir, 'agent-api.json'))).toBe(false)
    expect(readAgentAccess(dir)).toBe('off')
  })

  it('refuses a call without the token, from a web page, or for another host', async () => {
    start('read')
    expect((await call('/v1/help', { method: 'GET', headers: { Authorization: 'Bearer nope' } })).status).toBe(401)
    expect((await call('/v1/help', { method: 'GET', headers: { Origin: 'https://evil.example' } })).status).toBe(403)
    expect((await call('/v1/help', { method: 'GET', headers: { Host: 'evil.example' } })).status).toBe(403)
    const help = await call('/v1/help', { method: 'GET' })
    expect(help.status).toBe(200)
    expect(help.body.result).toMatchObject({ access: 'read', methods: { createEvent: { write: true } } })
  })

  it('refuses writes in Read only', async () => {
    start('read')
    const response = await call('/v1/createEvent', { body: { input: { calendarId: 1 } } })
    expect(response.status).toBe(403)
    expect(api.createEvent).not.toHaveBeenCalled()
  })

  it('creates an event from ISO times with the text fields left out, and logs it', async () => {
    start('full')
    const input = { calendarId: 1, title: 'Lunch', start: '2026-11-10T12:00:00Z', end: '2026-11-10T13:00:00Z' }
    expect((await call('/v1/createEvent', { body: { input, notify: false } })).status).toBe(200)
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
    const log = readFileSync(join(dir, 'agent-log.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(log).toEqual([expect.objectContaining({ method: 'createEvent', body: { input, notify: false } })])
  })

  it('gives timed events their local times, and not all-day events', async () => {
    const timed = { id: 1, allDay: false, start: Date.UTC(2026, 10, 10, 12), end: Date.UTC(2026, 10, 10, 13) }
    const allDay = { id: 2, allDay: true, start: Date.UTC(2026, 10, 10), end: Date.UTC(2026, 10, 11) }
    api.listEvents = vi.fn(async () => [timed, allDay])
    start('read')
    const response = await call('/v1/listEvents', { body: { start: 0, end: 1 } })
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
    const patch = { allDay: false, start: '2026-11-10T12:00:00Z', end: '2026-11-10T13:00:00Z' }
    expect((await call('/v1/updateEvent', { body: { eventId: 5, patch } })).status).toBe(200)
    expect(api.updateEvent).toHaveBeenCalledWith(
      5,
      { allDay: false, start: Date.UTC(2026, 10, 10, 12), end: Date.UTC(2026, 10, 10, 13), startDate: null, endDate: null },
      { notify: undefined, scope: undefined }
    )
  })

  it('takes a changed startLocal as the start, and refuses one that disagrees with start', async () => {
    start('full')
    const local = { startLocal: '2026-11-10T12:00:00Z', endLocal: '2026-11-10T13:00:00Z' }
    await call('/v1/updateEvent', { body: { eventId: 5, patch: local } })
    expect(api.updateEvent).toHaveBeenCalledWith(5, { start: Date.UTC(2026, 10, 10, 12), end: Date.UTC(2026, 10, 10, 13) }, expect.anything())
    const both = await call('/v1/updateEvent', { body: { eventId: 5, patch: { ...local, start: 0 } } })
    expect(both).toEqual({ status: 400, body: { error: 'start and startLocal differ. Send only start.' } })
    expect(api.updateEvent).toHaveBeenCalledOnce()
  })

  it('stops reading a body that is too large, and keeps serving', async () => {
    start('read')
    // Cut, not answered: the server stopped reading.
    await expect(call('/v1/listEvents', { body: 'x'.repeat(1_100_000) })).rejects.toThrow()
    expect(api.listEvents).not.toHaveBeenCalled()
    expect((await call('/v1/help', { method: 'GET' })).status).toBe(200)
  })

  it.runIf(process.platform === 'win32')('lets only this user read the token file', async () => {
    start('read')
    await apiFile()
    const acl = execFileSync('icacls', [join(dir, 'agent-api.json')], { encoding: 'utf8' })
    // (I): a permission inherited from the folder, like CodexSandboxUsers on %APPDATA%.
    expect(acl).not.toContain('(I)')
    // One entry: this user, full control.
    expect(acl.match(/:\(\w+\)/g)).toEqual([':(F)'])
  })
})
