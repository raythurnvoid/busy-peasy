#!/usr/bin/env node
// Busy Peasy agent client: a CLI, an MCP server and a small JS module for the agent API of the running app
// (src/main/agent.ts). The app asks the user for access when needed.
//
//   node busy-peasy.mjs help                       the methods and their params
//   node busy-peasy.mjs <method> ['<json params>']  one call, e.g. listEvents '{"start":"2026-11-09T00:00","end":"2026-11-16T00:00"}'
//   node busy-peasy.mjs mcp                        MCP server on stdio, for Claude Code, Codex or Claude Desktop
//   import { call } from './busy-peasy.mjs'         from a script: await call('listCalendars')
//
// --dev (or BUSY_PEASY_DEV=1) talks to a dev run (pnpm dev) instead of the installed app.
// --agent=<name> (or BUSY_PEASY_AGENT) is the agent's name; MCP takes the client's name. Each agent gets its own token,
// kept in agent-tokens\. A call waits for the user's answer in Busy Peasy.

// Plain JavaScript, so any Node can run it without a build: it has no return types.
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync, spawn } from 'node:child_process'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'
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
const tokensFolder = join(folder, 'agent-tokens')
// Where the Windows installer puts the app. Only an absolute path: a relative one could start a program from the
// current folder.
const exe = process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'busy-peasy', 'busy-peasy.exe') : null
const START_WAIT_MS = 20_000
// After a second start quits (the app runs already, with access off), a file may still come this late.
const EXIT_WAIT_MS = 2000
// An empty token file younger than this: another process registers the same name right now.
const CLAIM_MS = 60_000
// While the user decides, check for an answer this often.
const RETRY_MS = 2000

// MCP sets it from the client's name.
let defaultName = 'Busy Peasy CLI'
// Read at each call, so a script can set BUSY_PEASY_AGENT after the import.
const agentName = () =>
  process.argv.find((a) => a.startsWith('--agent='))?.slice('--agent='.length) || process.env.BUSY_PEASY_AGENT || defaultName

// The same text as the app's (src/main/agent.ts).
const waiting = (name) =>
  `Busy Peasy is waiting for the user to allow "${name}". Answer the prompt in the Busy Peasy window, then try again.`

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

// The error keeps the HTTP status: 401 means register again.
async function request(file, method, params, token, askForAccess = false, signal) {
  const response = await fetch(`${file.url}/v1/${method}`, {
    method: method === 'help' ? 'GET' : 'POST',
    signal,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Busy-Peasy-Ask': String(askForAccess) },
    body: method === 'help' ? undefined : JSON.stringify(params ?? {})
  }).catch((e) => {
    // The app may be gone, and another program may take its port: the next call proves it again.
    proven.delete(appKey(file))
    throw e
  })
  const body = await response.json()
  if (!response.ok) throw Object.assign(new Error(body.error ?? `HTTP ${response.status}`), { status: response.status })
  return body.result
}

// Apps that proved they are Busy Peasy, by address and pid.
const proven = new Set()
const appKey = (file) => `${file.url} ${file.pid}`

// Before the client sends a token, the app proves it knows the register token: a program that took the port of an app
// that is gone gets no token.
async function proveApp(file) {
  const key = appKey(file)
  if (proven.has(key)) return
  const nonce = randomBytes(32).toString('hex')
  const response = await fetch(`${file.url}/v1/hello`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce })
  })
  if (!response.ok) throw new Error('This Busy Peasy is older than this client. Update Busy Peasy.')
  const proof = await response.json().then((body) => body.result?.proof, () => null)
  const sent = Buffer.from(typeof proof === 'string' ? proof : '', 'hex')
  const wanted = createHmac('sha256', file.token).update(nonce).digest()
  if (sent.length !== wanted.length || !timingSafeEqual(sent, wanted)) {
    throw new Error('The program at the address in agent-api.json is not Busy Peasy. Restart Busy Peasy.')
  }
  proven.add(key)
}

// One file per name, in any case: "claude code" is "Claude Code", as in the app. The hash keeps two names that make
// the same slug apart.
function tokenFile(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)
  return join(tokensFolder, `${slug}-${createHash('sha256').update(name.toLowerCase()).digest('hex').slice(0, 8)}.json`)
}

// This user's SID: plain ASCII, unlike user names in icacls output (OEM code page: "José" would not match). whoami by
// its full path: Git for Windows has another whoami.
const userSid = () =>
  execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8'
  }).match(/S-1-[\d-]+/)[0]

// Only this user may read the tokens. A new folder gets that ACL before any token is in it (like agent-api.json,
// src/main/agent.ts): /reset drops what the parent passes down; (OI)(CI): files made in it get only this entry. If that
// fails, the folder goes. A folder that is there already is only checked, never changed.
function protectTokensFolder() {
  const created = mkdirSync(tokensFolder, { recursive: true, mode: 0o700 }) !== undefined
  if (created && process.platform === 'win32') {
    try {
      execFileSync('icacls', [tokensFolder, '/reset'], { stdio: 'ignore' })
      execFileSync('icacls', [tokensFolder, '/inheritance:r', '/grant:r', `*${userSid()}:(OI)(CI)F`], { stdio: 'ignore' })
    } catch (e) {
      rmSync(tokensFolder, { recursive: true, force: true })
      throw new Error('Could not protect the agent-tokens folder.', { cause: e })
    }
  }
  if (!created && !isPrivate()) {
    throw new Error(`Other accounts may read ${tokensFolder}. Remove that folder: its agents then register again.`)
  }
}

// One entry, not inherited (D:P): this user's SID, full control, passed down to the files. icacls /save writes the
// ACL as SDDL (UTF-16), for example "D:PAI(A;OICI;FA;;;S-1-5-21-...)". SDDL writes the built-in Administrator (RID
// 500, the user on GitHub's Windows runners) as "LA", not as its SID.
function isPrivate() {
  if (process.platform !== 'win32') return (statSync(tokensFolder).mode & 0o077) === 0
  const save = join(tmpdir(), `busy-peasy-acl-${randomBytes(8).toString('hex')}.txt`)
  try {
    execFileSync('icacls', [tokensFolder, '/save', save], { stdio: 'ignore' })
    const sddl = readFileSync(save, 'utf16le').split(/\r?\n/).find((line) => line.startsWith('D:')) ?? ''
    const sid = userSid()
    const ace = sddl.slice(sddl.indexOf('('))
    return sddl.startsWith('D:P') && (ace === `(A;OICI;FA;;;${sid})` || (sid.endsWith('-500') && ace === '(A;OICI;FA;;;LA)'))
  } finally {
    rmSync(save, { force: true })
  }
}

function readTokenFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

// This agent's token: from its file, else it registers with the register token from agent-api.json. Never printed.
async function agentToken(file) {
  const name = agentName()
  const path = tokenFile(name)
  const saved = readTokenFile(path)
  if (typeof saved?.name === 'string' && saved.name.toLowerCase() === name.toLowerCase() && saved.token) return saved.token
  // Before registering: a token must never land in a folder others can read.
  protectTokensFolder()
  // Claims the name: only one process registers it.
  try {
    writeFileSync(path, '', { flag: 'wx', mode: 0o600 })
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
    if (Date.now() - statSync(path).mtimeMs < CLAIM_MS) throw new Error(waiting(name), { cause: e })
    // Left by a crash.
    rmSync(path, { force: true })
    writeFileSync(path, '', { flag: 'wx', mode: 0o600 })
  }
  let result
  try {
    result = await request(file, 'register', { name }, file.token)
  } catch (e) {
    rmSync(path, { force: true })
    if (e.status === 404) throw new Error('This Busy Peasy is older than this client. Update Busy Peasy.', { cause: e })
    throw e
  }
  writeFileSync(path, JSON.stringify({ name, token: result.token }))
  return result.token
}

// help needs no agent: an MCP server lists its tools without a prompt. Other methods use the agent's token.
async function requestAsAgent(file, method, params, askForAccess, signal) {
  await proveApp(file)
  if (method === 'help') return request(file, method, params, file.token)
  const token = await agentToken(file)
  try {
    return await request(file, method, params, token, askForAccess, signal)
  } catch (e) {
    if (e.status !== 401) throw e
    // The user removed the agent, or the app lost its list: register again, once. Remove the file only if it still
    // holds the token that failed: a call running at the same time may have put a new one there.
    const path = tokenFile(agentName())
    if (readTokenFile(path)?.token === token) rmSync(path, { force: true })
    return request(file, method, params, await agentToken(file), askForAccess, signal)
  }
}

let started = false

// Wait for an explicit answer. Tests can set a shorter wait.
export async function call(method, params, signal) {
  const end = Date.now() + Number(process.env.BUSY_PEASY_WAIT_MS ?? Infinity)
  let askForAccess = true
  for (;;) {
    try {
      return await callOnce(method, params, askForAccess, signal)
    } catch (e) {
      if (!e.message.startsWith('Busy Peasy is waiting for the user') || Date.now() + RETRY_MS > end) throw e
      // Poll the same request without asking again if the user chose Read only.
      askForAccess = false
      await sleep(RETRY_MS, undefined, { signal })
    }
  }
}

// If the app is not running, starts the installed app in the tray once and waits for it.
async function callOnce(method, params, askForAccess, signal) {
  const file = readApiFile()
  try {
    if (!file) throw new Error('No agent-api.json')
    return await requestAsAgent(file, method, params, askForAccess, signal)
  } catch (e) {
    // Only a missing app is retried: an answer from the app (a wrong argument) is the result.
    if (file && !(e instanceof TypeError)) throw e
    if (dev || started || !exe || !existsSync(exe)) throw notRunning()
    started = true
    const child = spawn(exe, ['--hidden'], { detached: true, stdio: 'ignore' })
    child.unref()
    let end = Date.now() + START_WAIT_MS
    child.on('exit', () => (end = Math.min(end, Date.now() + EXIT_WAIT_MS)))
    for (; Date.now() < end; await sleep(500, undefined, { signal })) {
      const next = readApiFile()
      if (next && next.pid !== file?.pid) return requestAsAgent(next, method, params, askForAccess, signal)
    }
    throw notRunning()
  }
}

const notRunning = () =>
  new Error(
    `Busy Peasy${dev ? ' (dev)' : ''} is not running, or its agent access is off. Check that the app is running.`
  )

// MCP over stdio: one JSON-RPC message per line. Tools come from the app's method list.
async function mcp() {
  defaultName = 'MCP client'
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
  const pending = new Map()
  const run = async (id, { name, arguments: args }) => {
    const controller = new AbortController()
    pending.set(id, controller)
    try {
      const result = await call(name, args, controller.signal)
      if (name === 'screenshot') return { content: [{ type: 'image', data: result.data, mimeType: result.mimeType }] }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    } catch (e) {
      if (controller.signal.aborted) return
      return { content: [{ type: 'text', text: e.message }], isError: true }
    } finally {
      pending.delete(id)
    }
  }
  // Keep taking pings and cancellations while the user decides.
  const answer = async ({ id, method, params }) => {
    try {
      if (method === 'initialize') {
        // The agent's name, in the prompt that asks the user to allow it: "Claude Code", "Codex".
        defaultName = params?.clientInfo?.title || params?.clientInfo?.name || defaultName
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
      else if (method === 'tools/call') {
        const result = await run(id, params)
        if (result) out({ id, result })
      }
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
    if (message.method === 'notifications/cancelled') pending.get(message.params?.requestId)?.abort()
    else if (message.id !== undefined) void answer(message)
  }
  // A disconnected agent must not run a waiting edit later.
  for (const controller of pending.values()) controller.abort()
}

async function cli() {
  const [command, json] = process.argv.slice(2).filter((a) => a !== '--dev' && !a.startsWith('--agent='))
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
