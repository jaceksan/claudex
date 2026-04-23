<p align="center">
  <img src="docs/assets/logo.png" alt="Claudex" width="420" />
</p>

# Claudex — a control room for Claude Code

Claudex turns your terminal-bound `claude` CLI into a multi-session web cockpit. Spin up dozens of Claude Code agents across different repos, watch them work in parallel, jump into any one to read its rendered markdown, diffs and plans, and get an OS notification the moment a session finishes or wants your attention. When something goes wrong it survives a restart — every session is detachable and resumable.

It's a thin, local wrapper around the official CLI: no API re-implementation, no replacement for your hooks, skills, plugins or settings — just a much better seat for driving them.

## Why use it

- **One pane, many agents.** Live dashboard with status, current tool, cost, token usage, parse errors and git state per session.
- **Rich session view.** Markdown with syntax highlighting, side-by-side diffs for `Edit`, file previews for `Write`, plan cards for `ExitPlanMode`, collapsible tool calls and results, streaming as it happens.
- **Git worktree isolation.** Tick one checkbox in the launcher and claudex cuts a fresh branch off HEAD in a throwaway worktree under `~/.claudex/worktrees/` — safe to run many sessions on the same repo in parallel. Branch name and origin are shown on the dashboard card and session header; worktrees are garbage-collected when the session is deleted.
- **Topic dashboard.** Sessions are grouped into topics — one card per work item, sorted by activity. Create topics from the "+ New topic" modal: pick a template (Quick fix / Standard / Exploration), select a repo, set a title, optional ticket key. Creating a topic cuts the branch but does not spawn any session; click into the topic and press "+ New task" to start work with an optional title, effort, and permission mode — type the first prompt to the session once it opens. Delete a topic from its card (×) to kill every attached session, remove their worktrees, and drop the topic branch in one shot. Merged/Closed topics move into a collapsed **Archived** section per repo — still visible for review but out of the way; archived cards have their own × and also expose an explicit "Delete topic" button on the topic page's action bar. Duplicate-title checks and branch creation both ignore archived topics: if the template-rendered branch name is taken by an existing ref or another active topic, claudex auto-suffixes `-2`, `-3`, … instead of failing, and the new-topic modal surfaces the rename inline. Explicit `branchOverride` values are never renamed — collisions there surface loudly so the user can decide.
- **Topic detail page.** Three-column layout: timeline stepper (Draft → PR opened → Under review → Merge; a closed-without-merge PR shows a grey strikethrough terminal state instead of a fake green ✓), task list with per-task **Save** (commit uncommitted work in the worktree), **Merge to topic** (fast-forwards the topic branch to the task tip when the task is a linear descendant, or cherry-picks each task commit onto topic when history has diverged — never squashes, so per-commit messages and granularity are preserved; refuses if the worktree is dirty or if a cherry-pick conflicts), **Discard changes** (drop uncommitted, keep commits), **Discard task** (kill session + remove worktree + delete branch). Review-comment cards with per-thread Fix and inline reply, CI check panel with rollup badge, a header status dot (amber pulse while running → green/red once done), and per-check Fix. Sticky action bar gates buttons by phase — Create PR (Draft, accepted task), Address feedback (Open, unresolved comments or failing CI), plus a **Push** button that publishes the topic branch to the fork remote. No local Merge button: in almost every team with compliance, the PR author can't merge their own PR. Every slow action (Fix comment/check, Close PR, Save/Merge/Discard) shows a pulsing pending state so a click never looks lost while the server works.
- **Task buttons on the session page too.** The same Save / Merge to topic / Discard changes / Discard task buttons show in the task session header, so a non-tech user can act on Claude's output without navigating back to the topic page. Developers keep their normal flow: `git commit` / `git push` / `gh pr create` inside the session still work as before.
- **Deterministic git ops + Claude-written text.** Save, Merge, Push, Create PR, and Close PR are server-side git/gh commands — never asked of a live Claude session — so they're fast (seconds), reproducible, and auditable. Claude is called once per operation via `claude -p --max-turns 1` to generate only the *text* of the commit message / PR title / PR body, using the repo's own skills, CLAUDE.md, AGENTS.md, and PR template as context. Merge runs in an isolated temp worktree on the topic branch, so the main clone's state is never touched. Deleting a topic also auto-closes its PR iff the PR is still Open; Merged and Closed PRs are never touched (they're history).
- **PR lifecycle buttons.** Create PR (pushes branch, opens GitHub PR, auto-enables CI watch), Address feedback (spawns fix task seeded with thread body + CI log tail), per-comment Fix, per-check Fix.
- **Watch CI.** Toggle per-topic; polls checks every 2 minutes and fires an OS notification on rollup state transitions (running → ok, running → failed, etc.). The rollup is backed by GitHub's `statusCheckRollup` (a GraphQL field covering all check-runs, check-suites, and legacy status contexts in one flag), so a queued check-suite that hasn't emitted any check-runs yet still keeps the panel on "pending" instead of falsely reporting "all checks passing" from the subset of green runs we happen to have fetched.
- **Non-voting CI checks.** Click `⊘ Suppress` on any failing check row to mark it non-voting for the **repo** (persisted across topics + reboots). Suppressed checks move to a dedicated "Suppressed" group with a `restore` button, and are filtered out of the failure rollup — so one known-flaky branch-protection-required check doesn't keep the panel red or fire false "CI failed" notifications. Useful for `sonar` and similar jobs that a non-admin user can't remove from branch protection directly.
- **Flaky CI detection + retry.** Claudex records every completed check outcome into a local history per repo. When a failing check has been seen passing in recent runs too, the Errors row gains a `flaky` tag and a `↻ Retry` button that runs `gh run rerun <runId> --failed`. The classifier looks at the last 10 observations per check (success + failure ⇒ flaky; same outcome only ⇒ not flaky). Save non-tech users from burning a Fix task on an infrastructure blip.
- **Sync with main.** Topic action bar shows a "Sync with \<default\>" button when the topic branch falls behind. Claudex tries to rebase in a disposable worktree; on a clean rebase the topic branch fast-forwards automatically. On conflicts, the rebase is left in place and a `rebase` task session is spawned with Claude seeded with the conflicting file list, so a non-tech user can drive the resolution by chat without touching the terminal.
- **Inbox.** Dashboard-wide attention queue at `/inbox`: failing CI (flaky vs real, separated), unresolved review comments, rebases in progress, topics behind main. Every row deep-links to the topic page where the concrete action lives. Auto-refreshes every 30s.
- **GitLab adapter (preview).** When a repo's `origin` URL points at a `gitlab.*` host, claudex uses a `glab`-backed adapter for VCS operations — PR creation, CI rollup, check retry, etc. Mutation paths are best-effort mappings that haven't been run end-to-end in this repo; file issues when you hit a papercut. Non-GitLab repos keep using `gh` as before.
- **Reset.** Wipe a session's context and start a fresh subprocess in place — same card, same cwd, blank slate — without losing the dashboard slot.
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

- **Quick-fix auto-pilot.** When a task on a Quick-fix topic ends cleanly, claudex auto-accepts it and auto-opens the PR — no manual steps.
- **Merge.** Real merge action (gh/glab `mergePR` call) — Plan 4.
- **Conflict resolution with AI narrative review.** Sync with main; on conflicts spawn a rebase task that reports a short summary + explicit uncertainties, letting a non-tech user accept/reject without reading diffs.
- **Flaky CI triage & auto-restart.** Distinguish infrastructure flakes from real failures; rerun flakies rather than "fixing" them.
- **GitLab support.** `VcsAdapter` is interface-ready; `GitLabAdapter` over `glab` ships after the GitHub path lands.
- **Group dashboard by repository.** Today topics are a flat grid. Once the app is used against many repos, either (a) a left-rail repository list (sorted by most-recent activity) that filters the grid, or (b) repo-grouped sections with collapsible headers. Decision deferred until users have enough topics to notice the flatness.
- **Multi-repo topics.** A single topic that owns branches/PRs in two or more repos — e.g. backend + frontend change delivered together. Requires a topic→repos link table, a merged CI rollup, and a coordinated Create-PR flow. Out of scope for now but the data model already points at an `id` on every topic/task so extending it is additive.
- **Slack notifications.** Reuse the OS-notification contract for absent operators and async reviewers.
- **Permissions / multi-user non-tech access.** Current design is single-operator localhost. A safe auth model for invited non-tech collaborators is a follow-up investigation — the door is kept open in the data model and UI.
- **Live Bash command progress.** Today each command's output arrives in one chunk when the tool returns. Waiting on Claude Code to surface streaming tool stdout; we'll wire it through as soon as it lands.
- **Desktop app.** A small Tauri/Electron shell so claudex starts on login, lives in the tray, and dispatches notifications natively without a browser tab.
- **In-browser permission UI.** Approve/deny tool calls from the dashboard instead of the terminal — required before claudex can host a session you're not actively babysitting.

## Limitations

- Localhost only; no auth. Don't expose the port.
- Single-user — assumes one human driving from one browser.
- Broadcast (parallel prompt dispatch across unrelated sessions) was removed; parallel work now happens within a topic via multiple tasks, landing fully in the next plan.

## Architecture

See `docs/superpowers/specs/` for the original design and `CLAUDE.md` for the non-obvious gotchas (self-hosting hazards, dual session ids, `claude --resume` quirks). Repo layout crib lives in `CLAUDE.md` §8.

## License

See `LICENSE`.
