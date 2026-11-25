# busy-peasy

An Electron application with Svelte and TypeScript

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode) + [Svelte](https://marketplace.visualstudio.com/items?itemName=svelte.svelte-vscode)

## Project Setup

### Install

```bash
$ pnpm install
```

### Development

```bash
$ pnpm dev
```

### Build

```bash
# For windows
$ pnpm build:win

# For macOS
$ pnpm build:mac

# For Linux
$ pnpm build:linux
```

### Agent access

Agents (Claude Code, Codex, scripts) can read and change the calendar and use the app window. Everything stays on this
PC. An agent with Full access can also start adding an account (`addAccount`); you still sign in yourself. On first
use, the app accepts agent requests and asks you for permission in its window. It remembers your choice.

- **Read only**: read accounts, calendars, events and settings; see the screen (`getState`, `snapshot`, `screenshot`);
  move around (`navigate`, `openEvent`, `search`).
- **Full access**: also create, change, delete and answer events, and use the window like a person (`click`, `fill`,
  `press`), including Save and Delete.

The app listens on `127.0.0.1` only, on a new port with a new register token at each start. It writes both to
`%APPDATA%\busy-peasy\agent-api.json` (dev runs: `busy-peasy-dev`), with `cli`, the path of the client script. Only
your Windows account can read that file. The register token can only register a new agent and read `help`.

Each agent gets its own token. The first time an agent calls a method, the Busy Peasy window asks you whether to allow
it: **Deny**, **Allow read only** or **Allow full access**. The window comes up without taking the focus and flashes
in the taskbar, so keys you type elsewhere stay there. A mouse click on a button answers once the prompt has been up
for 1 second. Keys answer once the window has had the focus for 1 second, and any other key (Tab too) starts that
second again. The prompt stays open until you pick one: it has no time limit, Esc does nothing, and hiding the window
leaves it open. A CLI or MCP call waits for your answer. Approving lets the waiting call continue. Rejecting blocks it. While
the prompt is open, no agent can use `click`, `fill`, `press` or the commands that change the window, and agents
cannot answer it. When a Read only agent tries to edit through the CLI or MCP, the app asks for Full access in
the same window. Choose **Allow full access** to continue the edit or **Keep read only** to decline.

The tray menu **Agent access** lists every agent: pick a level for it there, or **Remove** it. The tray access (Off,
Read only, Full access) is the upper limit for all agents. The app keeps the agent list encrypted in `agents.bin` (only
a hash of each token); agents still waiting at a restart are dropped and ask again. The client keeps the tokens in
`agent-tokens\`, a folder only your Windows account can read, and sends a token only after the app proves it knows the
register token. Every write is logged in `agent-log.jsonl` with the agent's name.

The agent name is a label, not a check of who the program is. A program that runs as you can use an allowed agent's
name or token, read the token files, click the Busy Peasy window, change `agent-access.json`, or put back an old
`agents.bin`. So asking you to allow an agent stops a new program only if it does not reuse an allowed agent. It is not
a wall against programs that run as you.

The client script is `resources/busy-peasy.mjs` (in the installed app: `resources\app.asar.unpacked\resources\`). It
needs Node and has no dependencies. Add `--dev` to talk to a `pnpm dev` run. Add `--agent=<name>` (or set
`BUSY_PEASY_AGENT`) to name the agent; the default is `Busy Peasy CLI`. The MCP server uses the name the MCP client
sends (for example `Claude Code`).

```bash
node resources/busy-peasy.mjs help                         # the methods and their params
node resources/busy-peasy.mjs listCalendars
node resources/busy-peasy.mjs listEvents '{"start":"2026-11-09T00:00","end":"2026-11-16T00:00"}'
node resources/busy-peasy.mjs createEvent '{"input":{"calendarId":1,"title":"Focus","start":"2026-11-10T09:00","end":"2026-11-10T10:00"}}'
node resources/busy-peasy.mjs snapshot                     # the controls on screen, with refs
node resources/busy-peasy.mjs click '{"name":"Settings"}'
node resources/busy-peasy.mjs press '{"key":"Escape"}'
node resources/busy-peasy.mjs screenshot                   # prints the path of a JPEG
```

MCP (the same methods as tools):

```bash
claude mcp add busy-peasy -- node C:/path/to/busy-peasy.mjs mcp
codex mcp add busy-peasy -- node C:/path/to/busy-peasy.mjs mcp
```

The MCP server keeps the last tool list (`agent-methods.json`), so the tools stay listed while the app is closed. If the
app is closed, the first call starts the installed app in the tray.

From a script: `import { call } from './busy-peasy.mjs'`, then `await call('listEvents', { start, end })`. Plain HTTP
also works: first `POST <url>/v1/register` with `Authorization: Bearer <token from agent-api.json>` and
`{"name":"My script"}`. It returns the agent's own token. After you allow the agent, `POST <url>/v1/<method>` with
`Authorization: Bearer <agent token>` and a JSON object of params. `GET /v1/help` lists the methods; it works with
either token. To ask for Full access on a write, send `X-Busy-Peasy-Ask: true` on the first request.
If the app is waiting for your answer, retry without that header.

While agent access is on, the app also shows its page to Windows UI Automation tools (Chromium does that only for known
screen readers otherwise).

The installed app ignores `--remote-debugging-port`, so no other program can take it over. For Playwright or Playwriter
tests, use a dev run: `pnpm dev --remoteDebuggingPort 9222`, then `playwriter session new --direct <webSocketDebuggerUrl>`
(from `http://127.0.0.1:9222/json/version`).

### Release

Bump `version` in `package.json`, push, then run the **Release** workflow in GitHub Actions. It publishes the Windows
installer as a GitHub release. Installed apps download it in the background and install it on the next quit, or right
away from the update card in the window or the tray item "Restart to update". They check at start and every 4 hours, and
write what the updater did in this run to `updater.log` in `%APPDATA%\busy-peasy`.
