# Agent rules

## Git

- Work directly on `main`. Do not create a new branch or a worktree for a task.

## Running the app

- Start dev with `env -u ELECTRON_RUN_AS_NODE pnpm dev` (Git Bash). Agent shells can inherit `ELECTRON_RUN_AS_NODE=1`
  from an Electron host, and then Electron starts as plain Node and crashes on `electron.net`. Seen 2026-11-09.
- To check a change in the running dev app, use the agent API (README, "Agent access"): put `{"access":"full"}` in
  `%APPDATA%\busy-peasy-dev\agent-access.json` before the start, then `node resources/busy-peasy.mjs --dev snapshot`,
  `click`, `fill`, `press`, `screenshot`. The dev data folder has no real accounts unless someone signed in there.
- Never test the CLI's auto-start against the installed app: it starts or wakes the user's real app.
