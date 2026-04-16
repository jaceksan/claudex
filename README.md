# Claudex — a control room for Claude Code

Claudex turns your terminal-bound `claude` CLI into a multi-session web cockpit. Spin up dozens of Claude Code agents across different repos, watch them work in parallel, jump into any one to read its rendered markdown, diffs and plans, and get an OS notification the moment a session finishes or wants your attention. When something goes wrong it survives a restart — every session is detachable and resumable.

It's a thin, local wrapper around the official CLI: no API re-implementation, no replacement for your hooks, skills, plugins or settings — just a much better seat for driving them.

## Why use it

- **One pane, many agents.** Live dashboard with status, current tool, cost, token usage, parse errors and git state per session.
- **Rich session view.** Markdown with syntax highlighting, side-by-side diffs for `Edit`, file previews for `Write`, plan cards for `ExitPlanMode`, collapsible tool calls and results, streaming as it happens.
- **Slash-command autocomplete.** Type `/` to search every built-in command, user command, user skill and plugin skill on your machine. Two-tier ranking (prefix → substring), keyboard-driven, scrollable — no truncation.
- **OS notifications.** Click-through to the session that fired them. Sessions can finish in the background while you work elsewhere.
- **Detach + resume.** Server restarts, browser refreshes, machine reboots — sessions persist in SQLite and reattach to their existing transcripts via `claude --resume`.
- **Bash output.** Each tool call's stdout/stderr lands in an xterm pane.
- **Effort + permission modes per session.** Configure at launch; live `/effort` swap from the UI.
- **Plays nice with your setup.** Reads your `~/.claude/skills`, `~/.claude/commands` and installed plugins; doesn't fight your settings, hooks or MCP servers.

## Quick start

    npm install
    npm run dev

Then open http://localhost:5173. Backend runs on `:7878`; Vite proxies `/api` and `/ws`.

### Prerequisites

- Node.js 20+
- The `claude` CLI on your `PATH` — `npm install -g @anthropic-ai/claude-code`
- Whatever auth your `claude` CLI is already using (subscription or `ANTHROPIC_API_KEY`)

### Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | server (`:7878`) + Vite dev server (`:5173`) |
| `npm run build` | production build (server + web) |
| `npm start` | run the production build |
| `npm test` | Vitest suite |
| `npm run typecheck` | type-check server + web |

### Environment

- `PORT` (default `7878`) — server port
- `CLAUDEX_DB` (default `$HOME/.claudex.sqlite`) — SQLite path for session metadata

## Roadmap

- **Slack integration.** Receive notifications in Slack and reply from a thread to drive the matching session — useful when you're away from the laptop or want async collaborators.
- **Live Bash command progress.** Today each command's output arrives in one chunk when the tool returns. Waiting on Claude Code to surface streaming tool stdout; we'll wire it through as soon as it lands.
- **Desktop app.** A small Tauri/Electron shell so claudex starts on login, lives in the tray, and dispatches notifications natively without a browser tab.
- **Worktree isolation.** Spawn each session in a fresh `git worktree` so parallel agents can't trample each other's working trees.
- **In-browser permission UI.** Approve/deny tool calls from the dashboard instead of the terminal — required before claudex can host a session you're not actively babysitting.

## Limitations

- Localhost only; no auth. Don't expose the port.
- Single-user — assumes one human driving from one browser.

## Architecture

See `docs/superpowers/specs/` for the original design and `CLAUDE.md` for the non-obvious gotchas (self-hosting hazards, dual session ids, `claude --resume` quirks). Repo layout crib lives in `CLAUDE.md` §8.

## License

See `LICENSE`.
