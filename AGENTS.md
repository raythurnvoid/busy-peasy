# Agent rules

## Git

- Work directly on `main`. Do not create a new branch or a worktree for a task.

## Running the app

- Start dev with `env -u ELECTRON_RUN_AS_NODE pnpm dev` (Git Bash). Agent shells can inherit `ELECTRON_RUN_AS_NODE=1`
  from an Electron host, and then Electron starts as plain Node and crashes on `electron.net`. Seen 2026-11-09.
- To check a change in the running dev app, use the agent API (README, "Agent access"): put `{"access":"full"}` in
  `%APPDATA%\busy-peasy-dev\agent-access.json` before the start, then `node resources/busy-peasy.mjs --dev snapshot`,
  `click`, `fill`, `press`, `screenshot`. The dev data folder has no real accounts unless someone signed in there.
- Each agent has its own token. A `--dev` call from a new agent waits for the user's answer. Name it with
  `BUSY_PEASY_AGENT=<agent name>`. The agent's level is kept in `busy-peasy-dev`, so this happens once per name.
- Do not ask the user to answer the prompt that allows an agent. The agent API cannot answer it, by design. To allow an
  agent in a dev run, open the debugging port only for that step: start the run with
  `env -u ELECTRON_RUN_AS_NODE pnpm dev --remoteDebuggingPort 9222`, check that port 9222 belongs to the repo's
  `node_modules` `electron.exe`, connect Playwriter with `session new --direct <webSocketDebuggerUrl>` (from
  `http://127.0.0.1:9222/json/version`), and click the prompt's button by role and name, at least 1 s after the prompt
  shows (main ignores a sooner answer). Then stop that dev run, so the port closes: while it is open, any program on this
  PC, from any Windows account, can drive the dev app.
- Never allow, click or send keys to the installed app (`busy-peasy.exe`), and never read its token files.
- Never test the CLI's auto-start against the installed app: it starts or wakes the user's real app.
