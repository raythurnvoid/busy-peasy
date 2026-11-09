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
PC. Turn it on in the tray menu: **Agent access** > **Read only** or **Full access**. It is **Off** by default.

- **Read only**: read accounts, calendars, events and settings; see the screen (`getState`, `snapshot`, `screenshot`);
  move around (`navigate`, `openEvent`, `search`).
- **Full access**: also create, change, delete and answer events, and use the window like a person (`click`, `fill`,
  `press`), including Save and Delete.

The app listens on `127.0.0.1` only, on a new port with a new token at each start. It writes both to
`%APPDATA%\busy-peasy\agent-api.json` (dev runs: `busy-peasy-dev`), with `cli`, the path of the client script. Only
your Windows account can read that file. Every write is logged in `agent-log.jsonl` in the same folder.

The access limits agents that only have the CLI or the MCP tools. A program that runs as you can change
`agent-access.json` itself, so do not count on Read only against such a program.

The client script is `resources/busy-peasy.mjs` (in the installed app: `resources\app.asar.unpacked\resources\`). It
needs Node and has no dependencies. Add `--dev` to talk to a `pnpm dev` run.

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
also works: `POST <url>/v1/<method>` with `Authorization: Bearer <token>` and a JSON object of params. `GET /v1/help`
lists the methods.

While agent access is on, the app also shows its page to Windows UI Automation tools (Chromium does that only for known
screen readers otherwise).

The installed app ignores `--remote-debugging-port`, so no other program can take it over. For Playwright or Playwriter
tests, use a dev run: `pnpm dev --remoteDebuggingPort 9222`, then `playwriter session new --direct <webSocketDebuggerUrl>`
(from `http://127.0.0.1:9222/json/version`).

### Release

Bump `version` in `package.json`, push, then run the **Release** workflow in GitHub Actions. It publishes the Windows
installer as a GitHub release. Installed apps download it in the background and install it on the next quit, or right
away from the tray item "Restart to update".
