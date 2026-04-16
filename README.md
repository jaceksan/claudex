# Claudex — Multi-Session Claude Code Dashboard

A local web app for launching and monitoring multiple Claude Code sessions in parallel, with rich per-session views (markdown, diffs, plans, Bash terminal output) and OS notifications.

## Prerequisites

- Node.js 20+
- The `claude` CLI on your `PATH` (`npm install -g @anthropic-ai/claude-code` or see https://docs.claude.com/claude-code)
- `ANTHROPIC_API_KEY` (or whatever auth your `claude` CLI is configured for)

## Quick start

    npm install
    npm run dev

Then open http://localhost:5173.

The backend runs on port 7878; Vite dev server proxies `/api` and `/ws` to it.

## Commands

- `npm run dev` — starts server (7878) and Vite dev server (5173) in parallel
- `npm run dev:server` — server only
- `npm run dev:web` — Vite dev server only
- `npm run build` — production build (server + web)
- `npm start` — run the production build
- `npm test` — run the Vitest test suite
- `npm run typecheck` — type-check server + web

## Environment

- `PORT` (default `7878`) — server port
- `CLAUDEX_DB` (default `$HOME/.claudex.sqlite`) — SQLite path for session metadata

## Features

- **Launcher modal:** pick a cwd, optional initial prompt, permission mode.
- **Dashboard:** live grid of session cards (status, tool, cost, tokens, parse errors).
- **Session view:** markdown assistant messages with syntax-highlighted code, side-by-side diff viewer for `Edit`, content rendering for `Write`, plan card for `ExitPlanMode`, collapsible tool calls, per-tool `tool_result`.
- **Bash pane:** xterm.js tabs for Bash tool output (up to 3 concurrent).
- **Follow-up composer:** send user messages to running sessions (⌘/Ctrl+Enter).
- **OS notifications:** on session end, tool error, plan ready — with in-app toast fallback.
- **Detach/reattach:** sessions persist across app restarts; `Resume` reattaches via `claude --resume`.

## Known limitations

- Bash output is not keystroke-live — each command's result arrives as one chunk when the tool completes. Live streaming is a day-2 enhancement (requires a `PreToolUse` hook).
- No permission-approval UI yet — you still approve tool calls from the terminal.
- No worktree isolation; sessions share the cwd you give them.
- Localhost only; no auth.

## License

See `LICENSE`.
