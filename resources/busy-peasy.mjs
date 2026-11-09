#!/usr/bin/env node
// Busy Peasy agent client: a CLI, an MCP server and a small JS module for the agent API of the running app
// (src/main/agent.ts). Turn the API on in the tray menu: Agent access > Read only or Full access.
//
//   node busy-peasy.mjs help                       the methods and their params
//   node busy-peasy.mjs <method> ['<json params>']  one call, e.g. listEvents '{"start":"2026-11-09T00:00","end":"2026-11-16T00:00"}'
//   node busy-peasy.mjs mcp                        MCP server on stdio, for Claude Code, Codex or Claude Desktop
//   import { call } from './busy-peasy.mjs'         from a script: await call('listCalendars')
//
// --dev (or BUSY_PEASY_DEV=1) talks to a dev run (pnpm dev) instead of the installed app.

// Plain JavaScript, so any Node can run it without a build: it has no return types.
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

const dev = process.argv.includes('--dev') || process.env.BUSY_PEASY_DEV === '1'
// Electron's userData folder: the app's name, plus "-dev" for dev runs (src/main/index.ts).
const appData =
  process.env.APPDATA ??
  (process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support') : process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'))
const folder = join(appData, dev ? 'busy-peasy-dev' : 'busy-peasy')
const apiFile = join(folder, 'agent-api.json')
// The last method list, so MCP has its tools while the app is closed or its access is off.
const methodsFile = join(folder, 'agent-methods.json')
// Where the Windows installer puts the app. Only an absolute path: a relative one could start a program from the
// current folder.
const exe = process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'busy-peasy', 'busy-peasy.exe') : null
const START_WAIT_MS = 20_000
// After a second start quits (the app runs already, with access off), a file may still come this late.
const EXIT_WAIT_MS = 2000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// null also for a file left by a crash: its app is gone, and another program may listen on its port now.
function readApiFile() {
  try {
    const file = JSON.parse(readFileSync(apiFile, 'utf8'))
    process.kill(file.pid, 0)
    return file
  } catch {
    return null
  }
}

async function request(file, method, params) {
  const response = await fetch(`${file.url}/v1/${method}`, {
    method: method === 'help' ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${file.token}`, 'Content-Type': 'application/json' },
    body: method === 'help' ? undefined : JSON.stringify(params ?? {})
  })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body.result
}

let started = false

// Calls one method. If the app is not running, starts the installed app in the tray once and waits for it.
export async function call(method, params) {
  const file = readApiFile()
  try {
    if (!file) throw new Error('No agent-api.json')
    return await request(file, method, params)
  } catch (e) {
    // Only a missing app is retried: an answer from the app (a wrong argument) is the result.
    if (file && !(e instanceof TypeError)) throw e
    if (dev || started || !exe || !existsSync(exe)) throw notRunning()
    started = true
    const child = spawn(exe, ['--hidden'], { detached: true, stdio: 'ignore' })
    child.unref()
    let end = Date.now() + START_WAIT_MS
    child.on('exit', () => (end = Math.min(end, Date.now() + EXIT_WAIT_MS)))
    for (; Date.now() < end; await sleep(500)) {
      const next = readApiFile()
      if (next && next.pid !== file?.pid) return request(next, method, params)
    }
    throw notRunning()
  }
}

const notRunning = () =>
  new Error(
    `Busy Peasy${dev ? ' (dev)' : ''} is not running, or its agent access is off. Start it and pick Agent access > ` +
      'Read only or Full access in its tray menu.'
  )

// MCP over stdio: one JSON-RPC message per line. Tools come from the app's method list.
async function mcp() {
  const out = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
  const tools = async () => {
    let methods
    try {
      methods = (await call('help')).methods
      writeFileSync(methodsFile, JSON.stringify(methods))
    } catch (e) {
      // The client asks only once: an error here would leave it without tools for the whole session.
      if (!existsSync(methodsFile)) throw e
      methods = JSON.parse(readFileSync(methodsFile, 'utf8'))
    }
    return Object.entries(methods).map(([name, m]) => ({
      name,
      description: `${m.about}${m.write ? ' (Full access)' : ''}`,
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(Object.entries(m.params).map(([p, { type, about }]) => [p, { type, description: about }])),
        required: Object.entries(m.params)
          .filter(([, p]) => !p.optional)
          .map(([p]) => p)
      }
    }))
  }
  const run = async ({ name, arguments: args }) => {
    try {
      const result = await call(name, args)
      if (name === 'screenshot') return { content: [{ type: 'image', data: result.data, mimeType: result.mimeType }] }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: e.message }], isError: true }
    }
  }
  // Not awaited in the loop: a slow call (up to 30 s while the app waits for the user) must not hold up ping or others.
  const answer = async ({ id, method, params }) => {
    try {
      if (method === 'initialize') {
        out({
          id,
          result: {
            protocolVersion: params?.protocolVersion ?? '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'busy-peasy', version: '1.0.0' },
            instructions:
              'Busy Peasy is the user\'s local calendar (Microsoft 365 and Google). Times are epoch ms; events also have ' +
              'startLocal and endLocal. Use listCalendars and listEvents to read the schedule. snapshot, click, fill and ' +
              'press use the app window like a screen reader user.'
          }
        })
      } else if (method === 'ping') out({ id, result: {} })
      else if (method === 'tools/list') out({ id, result: { tools: await tools() } })
      else if (method === 'tools/call') out({ id, result: await run(params) })
      else out({ id, error: { code: -32601, message: `Unknown method ${method}` } })
    } catch (e) {
      out({ id, error: { code: -32000, message: e.message } })
    }
  }
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      out({ id: null, error: { code: -32700, message: 'Parse error' } })
      continue
    }
    // Notifications (no id) need no answer.
    if (message.id !== undefined) void answer(message)
  }
}

async function cli() {
  const [command, json] = process.argv.slice(2).filter((a) => a !== '--dev')
  if (command === 'mcp') return mcp()
  if (!command || command === 'help' || command === '--help') {
    const help = await call('help')
    console.log(help.about + '\n')
    for (const [name, m] of Object.entries(help.methods)) {
      const params = Object.entries(m.params).map(([p, { optional }]) => (optional ? `${p}?` : p))
      console.log(`${name}(${params.join(', ')})${m.write ? '  [Full access]' : ''}\n  ${m.about}`)
    }
    return
  }
  const result = await call(command, json ? JSON.parse(json) : {})
  // A screenshot goes to a file: its path is the output.
  if (command === 'screenshot') {
    const path = join(tmpdir(), `busy-peasy-${Date.now()}.jpg`)
    writeFileSync(path, Buffer.from(result.data, 'base64'))
    return console.log(path)
  }
  console.log(JSON.stringify(result, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch((e) => {
    console.error(e.message)
    process.exitCode = 1
  })
}
