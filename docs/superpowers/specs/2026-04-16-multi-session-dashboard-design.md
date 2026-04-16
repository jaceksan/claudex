# Claudex: Claude Code Multi-Session Dashboard — Design

**Date:** 2026-04-16
**Status:** Design approved, pending spec review
**Scope:** 24-hour hackathon MVP, Linux primary target, macOS portable later

## Problem

Working with the `claude` CLI has two recurring pains:

1. **Single-session readability.** Plans, diffs, and long shell output are hard to review in a plain terminal.
2. **Multi-session coordination.** Running several Claude sessions in parallel and knowing when any of them needs attention requires constant tab-switching.

Claudex addresses #2 first (highest differentiation), then #1, with later extensions for OS notifications and a bidirectional Slack bridge.

## Goals (24h MVP)

- Launch N Claude sessions from a web UI, each bound to a chosen working directory.
- Monitor all sessions live in a dashboard grid: status, cwd, current tool, last activity.
- Open any session to view a rich activity log with markdown, syntax-highlighted code, diff views for file edits, plan rendering for `ExitPlanMode`, and an embedded terminal pane for `Bash` tool output.
- Send follow-up user messages to a running session.
- Detach/reattach sessions across app restarts via `claude --resume`.
- Fire OS notifications on attention-worthy events: session ended, permission prompt pending, tool error, plan awaiting approval.

## Non-Goals (24h)

- Permission-prompt approval UI (view-only for now; user approves in their terminal if needed).
- Git worktree isolation per session (users choose plain cwds; worktree mode is a day-2 strategy).
- Slack bidirectional bot (phase 3, post-hackathon).
- Authentication or multi-user access (localhost only).
- True keystroke-live `Bash` output streaming (see Trade-offs).

## Architecture

Single Node/TypeScript process runs a local web server. Vite/React SPA is served from the same process. Frontend ↔ backend uses one WebSocket per browser tab with a typed message envelope.

Per active Claude session the backend holds a `SessionProcess` wrapping a `child_process.spawn("claude", ...)`. Stdin/stdout use stream-json (JSONL in both directions). Each parsed event is:

1. broadcast to subscribed WebSocket clients,
2. fed into an in-memory `SessionState` reducer,
3. evaluated by the `NotificationEngine`.

SQLite (`better-sqlite3`) stores session metadata and user prefs. Full transcripts already live in `~/.claude/projects/<cwd-hash>/<session-id>.jsonl`; the app reads those on-demand for history/replay rather than duplicating storage.

```
┌──────────────┐  WS   ┌──────────────────────────────┐
│ React SPA    │──────▶│ Node server (Fastify+WS)     │
│  dashboard   │       │  SessionManager              │
│  session     │       │  SessionProcess × N          │
│  launcher    │       │  NotificationEngine          │
└──────────────┘       │  SQLite (metadata)           │
                       │  TranscriptReader            │
                       └──────────────┬───────────────┘
                                      │ spawn/stdio JSONL
                                      ▼
                              claude CLI subprocess(es)
```

Startup: `npm start` → open `http://localhost:<port>`. No auth; bind to loopback only.

## Components

### Backend (Node/TS)

- **`SessionManager`** — owns `Map<sessionId, SessionProcess>`; exposes `create`, `list`, `get`, `kill`, `resume`. Emits events to `WsHub`.
- **`SessionProcess`** — spawns `claude -p --output-format stream-json --input-format stream-json --verbose [--permission-mode <x>] [<prompt>]` in the chosen cwd. Parses stdout JSONL line-by-line. Exposes `sendUserMessage(text)` which writes a stream-json `user` envelope to stdin. Lifecycle: `starting → running → (waiting-permission | idle) → ended | crashed`.
- **`SessionState`** (reducer) — pure `(state, event) → state`. Derives: current tool call, last assistant text, token/cost counters, plan-mode status, last-activity timestamp, parse-error count. Rebuilt from transcript on reattach.
- **`TranscriptReader`** — locates `~/.claude/projects/<cwd-hash>/<sessionId>.jsonl` and streams it for historical playback.
- **`NotificationEngine`** — subscribes to session events; fires on: `result` event (session ended), blocking permission prompt, error-flagged `tool_result`, `ExitPlanMode` tool call.
- **`Db`** — `better-sqlite3`. Tables: `sessions(id, cwd, label, created_at, ended_at, status, last_event_at, error)`, `prefs(key, value)`.
- **`WsHub`** — Fastify + `@fastify/websocket`. Envelope `{type, sessionId?, payload}`. Types: `session.created | session.updated | session.event | session.ended`; client → server: `client.subscribe | client.unsubscribe | client.launch | client.sendInput | client.kill | client.history`.

### Frontend (Vite + React + Tailwind)

- **`DashboardPage`** — grid/list of sessions with status pill, cwd, last activity, current tool. Click opens session.
- **`SessionPage`** — three stacked panes:
  1. Header: cwd, status, cost, kill button.
  2. Activity log: virtualized (`@tanstack/react-virtual`). `react-markdown` + `rehype-highlight` for assistant text; tool calls collapsible; `Edit`/`Write` rendered with `react-diff-viewer-continued`; `ExitPlanMode` rendered prominently as a plan card.
  3. Bash terminal pane: `xterm.js` instances per recent `Bash` tool call, tabbed.
- **`LauncherModal`** — cwd input (typed path + recent-dirs from SQLite), optional initial prompt, optional permission-mode flag.
- **`NotificationsProvider`** — requests browser Notification permission on first load; falls back to in-app toasts if denied.
- **`MessageComposer`** — small input on `SessionPage` to send follow-up user messages.

## Data Flow

### Launching

1. `LauncherModal` → WS `client.launch {cwd, prompt?, permissionMode?}`.
2. `SessionManager.create()` spawns the `claude` subprocess.
3. First stream-json `system:init` event carries the real `session_id`; manager upserts SQLite row and broadcasts `session.created`.
4. Later stdout lines → parse → reducer → broadcast `session.event` → notification rules.

### Viewing

1. Frontend navigates to `/session/:id` → `client.subscribe`.
2. Backend responds with current `SessionState` snapshot + recent event buffer (in-memory ring, last 500 events).
3. Scroll-back triggers `client.history {sessionId, before}` → `TranscriptReader` streams older events from disk.

### Sending Input

1. User submits `MessageComposer` → WS `client.sendInput {sessionId, text}`.
2. `SessionProcess.sendUserMessage()` writes a stream-json `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}` line to stdin.

### Bash Terminal Pane

Stream-json delivers `Bash` results as a single `tool_result` event with final output. Live keystroke streaming would need a `PreToolUse` hook teeing to a named pipe (too much for 24h). **MVP behavior:** show a "running…" spinner while the `tool_use` is open; render final output into xterm.js on `tool_result`. Flagged as a day-2 enhancement.

### Notifications

Event → rule match → `Notification {sessionId, kind, title, body}` → WS push → frontend calls `new Notification(...)` and renders a toast.

### Detach / Reattach

On startup, `SessionManager` reads SQLite and marks non-terminal rows as `detached`. User clicks a detached session → backend runs `claude --resume <sessionId>` in the original cwd, replays the on-disk `.jsonl` through the reducer to rehydrate state, then streams live events.

## Error Handling

- **Subprocess crash / non-zero exit** — mark `crashed`, capture last 200 stderr lines into `sessions.error`, broadcast `session.ended {reason:'crashed'}`, fire notification. No auto-restart.
- **Malformed JSONL line** — log and skip; increment `parseErrors`; do not kill the session.
- **WS client disconnect** — drop subscription; subprocess continues. Reconnects are idempotent.
- **SQLite write failure** — log and continue (metadata is non-critical for a live session).
- **Transcript file missing on reattach** — show "transcript unavailable, live events only" banner; allow resume.
- **Launch failure** (bad cwd, `claude` not on PATH) — reject `client.launch` with error envelope; inline error in modal.
- **Port already in use** — fail fast with a message suggesting `PORT=xxxx npm start`.

## Testing

- **Reducer unit tests** — canned stream-json fixtures drive ~10 tests covering simple chat, tool-heavy, `ExitPlanMode`, error tool results, and `result` event.
- **NotificationEngine unit tests** — same fixture-driven approach, ~5 tests.
- **Integration smoke test** — spawn `claude -p "say hello"` against a real API key (skipped in CI without key); assert state reaches `idle` and `session.ended` fires. Guards against stream-json format drift.
- **No frontend tests in MVP** — manual smoke only.
- **Fixtures captured in hour 1** — 3–4 real stream-json transcripts stored in `tests/fixtures/` and reused by every test.

Tooling: Vitest for both unit and integration.

## Trade-offs and Deferred Work

| Deferred | Reason | Planned phase |
|---|---|---|
| Permission-approval UI (accept/deny prompts from the browser) | Complex UX, not demoable in 24h | Phase C |
| Git worktree per session | 3–5h, not on the critical demo path | Phase B.1 |
| Slack bidirectional bot (bot token + Socket Mode via `@slack/bolt`) | Additive, not architectural; does **not** reuse org-provided Slack MCP | Phase 3 |
| Live keystroke-level `Bash` output | Requires `PreToolUse` hook + named pipe plumbing | Day-2 |
| Tauri packaging for true desktop app + system tray | Web-first works on Linux and macOS already | Day-2 |
| Full event-log persistence in SQLite | Claude already persists transcripts to `~/.claude/projects/...`; duplicate storage is wasteful | N/A |

## Slack (Phase 3) — Architectural Note

Two distinct Slack integrations exist and do not share code or auth:

- **Org-provided Slack MCP** — runs *inside* a Claude session; lets the LLM call Slack as a tool. Direction: Claude → Slack. Auth belongs to the MCP server.
- **Claudex Slack bot** — runs in *our* backend as a separate Slack app using Socket Mode (`@slack/bolt`). Direction: Slack ↔ Claudex. Lets a human in Slack list sessions, send input, approve, and receive notifications. Requires our own bot token + app-level token; no public webhook needed.

The two can coexist; neither depends on the other.

## Prior Art and Reusable Pieces

- **Crystal** (stravu/crystal) — Electron multi-session runner with worktree isolation. Closest prior art; mine their stream-json parser and session state machine.
- **Claudia / opcode** (getAsterisk/claudia) — Tauri GUI, reference for packaging path.
- **claude-squad** (smtg-ai/claude-squad) — Go/Bubble Tea TUI; reference for phase-A terminal UI.
- **vibe-kanban** — Task-centric multi-agent UX; Slack integration ideas.
- **claude-code-webui** — Minimal stream-json → WebSocket → browser reference.
- **xterm.js** — Embedded terminal rendering.
- **`@anthropic-ai/claude-agent-sdk`** — Reuse its TypeScript types for stream-json events even though we don't use the SDK at runtime.
- **`@slack/bolt`** — Socket Mode Slack app (phase 3).

## Open Questions

None blocking implementation. Permission-approval UX, worktree branching strategy, and Slack bot command surface will be designed when their phases begin.
