# Working in claudex

Claudex is a local web app that manages multiple `claude` CLI subprocesses and surfaces them over a WebSocket + React SPA. This file captures the non-obvious things that bite helper sessions. Read it before starting work.

## 1. Self-hosting hazard

Editing `src/server/**` triggers `tsx watch` → server restart → **every in-flight Claude subprocess the server was managing is killed mid-turn**. That includes the claudex-helper session you may be running inside claudex right now. Consequences:

- Session transcripts end mid-assistant-message with `stop_reason: null`; the session shows as `detached` after the reconnect, possibly with polluted state.
- User follow-up messages sent through the composer during the restart window are lost.

**Mitigations:**

- When making backend changes that don't need live reload, prefer `npm run build && npm start`.
- Batch all server edits before the next `npm test` or restart so tsx watch only cycles once.
- Don't edit `src/server/**` while a helper session is mid-turn on a non-trivial task.

## 2. Always work from the repo root

The cwd matters — `vitest`, `tsc`, and Vite pick up their configs only when invoked from `/home/jacek/work/src/claudex`. Running `vitest` from the parent `src/` directory scans **every sibling project** (dozens of repos), spawns a worker per test file, and fork-bombs the machine. This has happened.

```bash
cd /home/jacek/work/src/claudex       # always do this first
npm run dev                           # both server (:7878) and Vite (:5173)
npx vitest run                        # scoped by vitest.config.ts
```

## 3. Don't background-spawn `node`/`tsx`

If you launch `node … &` or `npx tsx … &` in a Bash tool call and the shell exits before the child does, the child reparents to `systemd --user` and **holds port 7878 forever** — even after the task "ended". Subsequent `npm run dev` gets `EADDRINUSE` and the server never starts.

- Use `timeout` + foreground, or `run_in_background` with intent to read the output, but always `kill` the PID explicitly before the task ends.
- When you see the user report "infinite reconnect" or `EADDRINUSE`, check `ss -lntp | grep 7878` and track the parent chain.

## 4. Two session ids — know which one you need

Every session has **two ids**:

| Field | Shape | Purpose |
|---|---|---|
| `state.sessionId` | UUID minted by claudex | Stable UI id; dashboard cards, URLs, WS subscriptions |
| `state.claudeSessionId` | UUID from Claude's `system:init` | Passed to `claude --resume`; names the file at `~/.claude/projects/<cwd-hash>/<id>.jsonl` |

When the user pastes "session id is X", check **both** columns in SQLite:

```bash
sqlite3 ~/.claudex.sqlite \
  "SELECT id, claude_session_id, status, label, error FROM sessions
   WHERE id LIKE 'X%' OR claude_session_id LIKE 'X%';"
```

Never mix them. In particular, `claude --resume <UI UUID>` hits the `"No conversation found"` path and crashes the subprocess, polluting the row.

## 5. Claude CLI stream-json mode quirks

- **Silent until stdin.** *Any* `claude --input-format stream-json` subprocess — fresh or `--resume` — emits **nothing** until a user message arrives on stdin. No `system:init`, no output. The original `create()` flow always sends an initial prompt, so the `starting → idle` transition looks automatic; it isn't. `resume()` and `restart()` (Reset) both work around this by forcing `state.status='idle'` after spawn so the composer is enabled and the user can wake the subprocess by typing. **If you add another spawn path that doesn't send an initial stdin message, do the same** or the UI freezes on "starting Claude…" forever.
- Pre-flight before spawning with `--resume`: `TranscriptReader.findTranscript(claudeSessionId)` must return a path. If not, return an error envelope — don't let Claude crash the subprocess, because its failed result will get persisted.
- Sessions that were killed mid-turn sometimes show up with the transcript file present but Claude still says `"No conversation found"`. In practice they're often still resumable if you provide a prompt; if not, the session is dead and must be deleted.

## 6. Worktree sessions

Launcher has a "Run in a fresh git worktree" checkbox. When set, `SessionManager.create` calls `createWorktree()` which:

- runs `git rev-parse --show-toplevel` on the chosen cwd to find the source repo (fails fast if it's not a repo),
- `git worktree add -b claudex/<slug?>-<short-uiId> ~/.claudex/worktrees/<uiId>` off HEAD,
- rewrites the session's cwd to the new worktree path before spawning `claude`.

Persistence: `sessions.worktree_origin` and `sessions.worktree_branch` (additive SQLite columns). `registerDetached` hydrates these fields so the dashboard can show the branch even for detached rows. `restart()` (Reset) reuses the existing worktree — same branch, fresh conversation — by passing the preserved info back into `create()` via `opts.worktree`.

Cleanup: `manager.delete()` calls `removeWorktree(origin, path)` after killing the subprocess. That runs `git worktree remove --force <path>` and falls back to `git worktree prune` + `rm -rf` if the repo object is already gone. Don't leak these directories — they accumulate fast.

## 7. Verification commands before claiming done

```bash
cd /home/jacek/work/src/claudex
npx vitest run
npx tsc -p tsconfig.server.json --noEmit
npx tsc -p tsconfig.web.json --noEmit
npm run build:web     # only if web/ was touched
```

All four must pass. Builds can succeed while Vitest picks up a bug, and vice versa.

## 8. When to invoke Superpowers skills

- `test-driven-development` — new backend components (reducers, stream-json parsing, session lifecycle).
- `verification-before-completion` — before declaring any task done. The `client.rename` case that wasn't wired was exactly this failure.
- `systematic-debugging` — when a user session is in a weird state. Pull the transcript from `~/.claude/projects/**/<claudeId>.jsonl` and the SQLite row before guessing.
- `brainstorming` → `writing-plans` → `executing-plans`/`subagent-driven-development` — only for genuinely new features (Slack bot, worktree mode, permission UI). Small fixes don't need the ceremony.

## 9. Repo layout crib

```
src/server/
  index.ts               # Fastify + WS entrypoint
  session/
    manager.ts           # SessionManager — lifecycle + resume
    process.ts           # SessionProcess — claude subprocess wrapper
    state.ts             # SessionState reducer (pure)
    transcript.ts        # ~/.claude/projects/ reader
  stream-json/{types,parser}.ts
  ws/{envelope,hub}.ts
  db.ts                  # SQLite (session metadata only; transcripts live under ~/.claude)
  notifications.ts       # NotificationEngine

src/web/
  pages/{dashboard,session}.tsx
  components/{event-view,launcher,composer,bash-pane,git-badge,toaster}.tsx
  hooks/{use-ws,use-notifications,use-git-info}.ts
  lib/{ws,status}.ts

tests/                   # vitest — fixtures in tests/fixtures/*.jsonl
docs/superpowers/        # specs and plans
```

Full implementation plan and spec live in `docs/superpowers/`.
