# Worktree/Topic/Task UX — comprehensive design

Status: draft · Author: jaceksan + Claude · Date: 2026-04-17
Supersedes selected sections of: `2026-04-16-multi-session-dashboard-design.md`

## 1. Motivation

Today's worktree feature is a single checkbox that cuts a throwaway branch. It solves isolation but ignores everything around isolation: commit/PR loop, CI, review comments, CI conflicts, branch hygiene, PR hygiene. A user — especially a non-technical one — cannot go from "I have a small change to make" to a merged PR without leaving claudex.

This spec redesigns that surface with two primary audiences in mind:

- **Non-technical users** (PMs, designers, analysts) who should be able to run a ticket end-to-end without learning git vocabulary.
- **Engineers** who want less friction and fewer footguns on shared repos.

The design keeps a single underlying model; complexity is hidden behind plain-English defaults and surfaces only when it's real.

## 2. Goals / non-goals

### Goals

- Worktree isolation is the default, not a toggle.
- Git surface area for common flows (branch, commit, push, PR, rebase) is reachable through outcome-shaped buttons.
- PR lifecycle (create → CI → review → merge) runs entirely from claudex for supported repos.
- Conflict resolution is AI-driven with narrative review; validation is the quality backstop.
- Per-repo conventions (branch names, commit format, skills) are respected automatically.
- Works across GitHub and GitLab; works with Jira, YouTrack, Linear, or no tracker.
- Survives server restart: worktrees, topic/task state, resume semantics all persist.

### Non-goals (MVP)

- Hosting sessions for other human users (multi-user). Single-operator, localhost-only is preserved.
- Permissions/authorization model for non-tech access beyond single-user. (Noted on README roadmap.)
- In-app toast notifications; Slack notifications. (OS notifications only for MVP; Slack on roadmap.)
- Broadcast across unrelated sessions. (Removed — parallel attempts replace this inside a topic.)
- Stacked PRs / dependent-branch graphs.

## 3. Conceptual model

Three entities replace today's flat "session per folder":

```
Repo      — registered git repository; has default tracker and skill bindings.
 └─ Topic — a unit of intent. One ticket (or free-form title) ↔ one PR.
     │     Owns the PR branch. Has a lifecycle phase and a template.
     └─ Task — a Claude Code session running in an isolated git worktree.
               Type: attempt | fix-comments | fix-ci | rebase | free.
```

**Phases:** `Exploring → Draft → Open → Merged | Closed`.

**Worktree-by-default.** The no-worktree path is removed from the main UI. An Advanced escape hatch, `Edit in place (no worktree)`, remains for explicit one-offs.

### 3.1 Task-to-branch rules by phase

| Phase | Task branches | Write-target |
|---|---|---|
| Exploring | none (no worktree yet) | — |
| Draft (pre-accept) | `<branch_template>__attempt-N` (local only) | child branch |
| Draft (post-accept) | topic branch, via short-lived fix worktrees | topic branch |
| Open | topic branch, via short-lived fix worktrees | topic branch (push to fork/origin) |
| Merged / Closed | none | — |

**Concurrency:** at most one task may write to the topic branch at a time; additional writers queue. Attempt tasks (Draft phase, child branches) are fully parallel.

## 4. Dashboard

Three stacked regions:

### 4.1 Review Inbox (new, collapsible)

Attention feed aggregating across all topics. One row per actionable signal. Non-voting CI is excluded.

```
🔴  gdc-nas · ABC-123 "Fix login copy"     CI failing (2 required)   [Fix all]
💬  gdc-ui  · DEF-456 "Dashboard filter"   3 new human comments      [Address]
⚠️   claudex · TRIVIAL "Worktree refactor"  Rebase needed             [Sync]
✅  dag_bpay · CBP-1234 "Payout retry"     Ready to merge             [Merge]
```

Row click opens the topic detail page with the relevant panel focused. Empty state: `All clear — N topics on track`.

### 4.2 Topic cards

Grid of cards, one per non-archived topic. Shows: ticket key + title, stage pill, CI chip (required-only), task summary, PR link, stage-appropriate primary button.

### 4.3 Archive

Collapsed by default. Merged + closed topics from the last 30 days.

### 4.4 Sort

1. Topics with Inbox items (most recently triggered first)
2. Topics with running tasks
3. Topics idle &lt; 24h
4. Topics idle ≥ 24h
5. Archive

### 4.5 Removed

- Broadcast multi-select UI
- Per-session launcher entry point (topics are the creation unit)
- In-app toaster

## 5. Topic detail page

Single page. Header + three-column body + sticky action bar. Three-column layout collapses to vertical stack on narrow viewports.

### 5.1 Header (sticky)

```
[←] ABC-123 · Fix login screen copy · gdc-ui          Open for review
PR #4711 ↗   branch: jaceksan/ABC-123_fix-login-copy  [copy]
```

Pill colour maps to phase.

### 5.2 Left — Timeline

Vertical stepper narrating the topic's journey. Past steps checked, current highlighted, future muted.

```
✅ Draft · 3 attempts, 1 accepted       2h ago
✅ PR opened                             1h ago
🟡 Under review                          now
   ├─ 2 unresolved comments
   └─ CI 🟢 (all required passing)
◻︎ Approvals 0/2
◻︎ Merge
```

### 5.3 Middle — Tasks

Ordered by Section 4.4. Card per task: status, type, label, backlink to triggering comment/check when applicable. `+ New attempt` (Draft only, before accept) and `+ New fix task` (post-accept / Open) buttons.

### 5.4 Right — Review activity

**Comments panel** (only when PR open and ≥1 thread exists). Each thread is a card with author (human/bot badge), file:line, body, and buttons: `Fix`, `Reply`, `Resolve`, `Skip`.

**CI panel** (visible once PR exists). Rollup header drives by required checks only. Failed-required listed inline with per-check `Fix`. Non-voting collapsed under `▸ N advisory check(s)`. `👁 Watch` toggle, `↗ GitHub Actions` link, `Fix all` button.

**Conflicts panel** (appears only when main has advanced past the topic branch). Banner + `Sync with main` primary button.

**Review reports panel** (Section 12.3). Artifact list from `Ask Claude to review`.

### 5.5 Action bar (sticky bottom)

Buttons change by phase — see Section 7.2.

### 5.6 Auto-collapse

- Tasks panel collapses to `1 task` summary when exactly one attempt and no fix tasks.
- Comments/CI/Conflicts panels hidden until data exists.
- Timeline in compact mode shows past + current + next only.

Net effect for a clean Quick-fix topic: a three-line page with one `Merge` button.

## 6. Session launch flow

### 6.1 Templates

Offered at **New topic**. Templates are preset configurations on the topic row; they do not branch the state machine.

| Template | Purpose | Presets |
|---|---|---|
| Quick fix | Typo / tiny bug / one-file edit | Skip Exploring. Auto-accept single attempt. Auto-run Create PR on accept. Effort `low`, permission `acceptEdits`. |
| Standard (default) | Normal feature / bugfix | Start at Draft with one attempt. Manual accept, manual Create PR. Effort `medium`, permission `acceptEdits`. |
| Exploration | Ambiguous scope, brainstorm-first | Start in Exploring. No branch, no worktree. Effort `medium`, permission `plan`. |

Template can be changed mid-topic via a settings toggle; changes affect future defaults only.

### 6.2 New topic modal

**Step 1 — Source.** `From ticket` (tracker picker, populated by the repo's configured tracker adapter) or `Free-form` (title only).

**Step 2 — Repo.** Dropdown of registered repos. Shows canonical/default branch and fork status.

**Step 3 — First task.** Initial prompt (optional for Exploration template), effort, permission mode, attempt label.

**Step 4 — Advanced (collapsed).** Base branch (defaults to canonical default), `type` and `project` fields (shown only if the branch template uses them), `Edit in place (no worktree)` with explicit warning.

### 6.3 On submit

1. `git fetch canonical_remote <default>` in the source repo.
2. Create `topic` row with `phase = Exploring | Draft` depending on template.
3. Non-Exploration templates: cut topic branch `<branch_template>` off `canonical_remote/<default>`; cut attempt-1 child branch + worktree; spawn `claude` with the initial prompt.
4. Exploration template: spawn `claude` in the repo root (read-only cwd by convention) with `plan` mode; no branch yet.
5. Navigate to topic detail page.

### 6.4 Exploring → Draft transition

Exploring topics have one session and no worktree/branch. Exits:

- `Start work` — if no ticket and a tracker MCP is configured, offer `Create ticket from spec`. Then cut topic branch, cut attempt-1 worktree, migrate the Exploring session into attempt-1 (same transcript, swapped cwd, spec piped in as first context).
- `Split into topics` — user annotates the brainstorm with per-topic slices; each becomes its own Draft topic.
- `Discard` — no commits, no branch, no cleanup needed.

### 6.5 New task on existing topic

`+ New attempt` (Draft, pre-accept only) or `+ New fix task` (post-accept / Open). Modal inherits repo/topic; asks for type, optional label, and initial prompt (auto-seeded when launched from a specific Fix button). Fix workflows always create a new task + worktree.

### 6.6 Fork vs direct-remote handling

At repo registration, detect fork topology via `git remote -v` + `gh repo view --json parent`. Store `canonical_remote` and `fork_remote` on the repo row. UI shows a one-line summary at registration; afterwards the distinction is hidden. All branch cuts come from `canonical_remote/<default>`; pushes go to `fork_remote`; PR creation targets canonical. Case with no fork: canonical = fork = `origin`.

## 7. PR lifecycle state machine

### 7.1 Phase transitions

```
Exploring ──(Start work)──▶ Draft ──(Create PR)──▶ Open ──(PR merged)──▶ Merged
     │                        │                       │
     └──(Discard)──▶ X        └──(Discard)──▶ X       └──(PR closed)──▶ Closed
```

### 7.2 Button gating (action bar)

| Phase | Primary | Secondary | Disabled + tooltip |
|---|---|---|---|
| Exploring | Start work | Split into topics · Discard | — |
| Draft, no accepted attempt | Use this attempt (per task) | + New attempt · Discard attempt | Create PR (*Pick an attempt first*) |
| Draft, ≥1 accepted, no writers | Create PR | + New fix task · Sync with main | — |
| Draft, writer running | — | + New fix task (sibling) | Create PR (*Wait for running task*) |
| Open, clean | Address feedback (if any) | Sync with main · + New fix task · Watch CI · Ask Claude to review | Merge (*Needs approval / CI*) |
| Open, CI failing (required) | Fix CI / Address feedback | + Sync with main · + New fix task | Merge |
| Open, comments unresolved | Address feedback | as above | Merge |
| Open, conflicts | Sync with main (banner) | as above | Merge (*Resolve conflicts first*) |
| Open, approved + green + no conflicts | Merge | Sync with main · + New fix task | — |
| Merged / Closed | Archive | — | everything else |

### 7.3 Verb contracts

**Start work** (Exploring → Draft). Cut topic branch off canonical/default. Cut attempt-1 child branch + worktree. Migrate session.

**Use this attempt.** Squash-merge child branch into topic branch (locally). Sibling attempts marked `discarded`. Their worktrees GC'd after 24h.

**Create PR.** `git push fork_remote <topic-branch>`; vcs-adapter `createPR` with templated title + body (from ticket, spec, commits, `commit_template`). Auto-enables Watch CI.

**Address feedback.** Spawn one fix task scoped to all unresolved human comments + all failing required CI. Task runs repo's `pr-fix` skill if bound; else built-in orchestration. On accept: push, auto-reply each addressed thread with commit SHA, auto-resolve bot threads, prompt-resolve human threads.

**Fix CI** (per-check or global). Scoped variant of Address feedback limited to CI.

**Fix** (per-comment). Scoped to one thread.

**Sync with main.** `git fetch canonical_remote <default>; git rebase canonical_remote/<default>`. On conflict: Section 9.

**Merge.** `vcs-adapter.mergePR(number, strategy)` (strategy per-repo setting, default squash). GitHub/GitLab branch protections are the actual gate; button-enabled state only mirrors what we can observe.

**Discard (topic).** Exploring/Draft only. Delete worktrees + local branches. Closed topics must be closed via the platform UI first.

### 7.4 Branch cleanup

- Discarded attempt worktree+branch: deleted after 24h.
- Merged topic: all worktrees + local branches GC'd; remote topic branch deleted via merge-with-delete-branch.
- Closed topic: worktrees deleted immediately; local branches 7d; remote untouched.
- Sweep runs on boot and every 6h.

## 8. Fix workflows

### 8.1 Three granularities

- **Fix** (per comment or per check): scoped to one item.
- **Fix CI** / **Address feedback** (coarse): scoped to all items of that class.
- **Address feedback**: spans both (all human comments + all failing required checks).

Each granularity **always spawns a new task + worktree** cut from the current topic-branch tip. Only one writer at a time — siblings queue.

### 8.2 Prompt seeding

Comments: file:line, thread body, resolution reply template.
CI failures: failing check name, log tail (last N lines from `gh run view --log-failed` / `glab ci trace`), previous attempt history if any.

### 8.3 Completion

Task's final message is parsed for the commit SHA. Claudex runs:

1. Push `fork_remote`.
2. For each addressed comment: post reply `"Fixed in <sha>"`, resolve if bot, prompt-resolve if human.
3. Mark the triggering items as resolved on the topic page.

If push fails (e.g., remote advanced), automatically try `Sync with main` first; on clean rebase, retry push.

## 9. Conflict resolution

Three-layer funnel: auto-resolve, auto-validate, narrative review on uncertainty or validation failure.

### 9.1 Layer 1 — Automatic resolve + validate

On rebase conflict, spawn a `rebase` task with seeded prompt asking Claude to resolve conflicts preserving both sides' semantic intent and to self-report uncertainty under a structured `## Uncertainties` heading. Permission `acceptEdits`, effort `high`, tools scoped to Read/Edit on conflicted files + the repo's validate command.

After resolution, automatically run the validate command. Exit states:

| Outcome | Next |
|---|---|
| Resolved, green, no uncertainties | Auto-accept: push; show `Synced ✓` |
| Resolved, green, uncertainties present | Narrative review |
| Resolved, red (validate failed) | Narrative review, failure pinned at top |
| Couldn't resolve | Narrative review with Claude's "needs human input" note |

### 9.2 Layer 2 — Narrative review UI

Text-led, not diff-led. Collapsible sections:

1. **Summary** (always expanded) — one short paragraph written by Claude.
2. **Uncertainties** (expanded when present) — one card per uncertainty: title, what main wanted, what the topic wanted, why ambiguous, what Claude chose, options (`Looks good`, `Use main's`, `Use mine`, `Let me edit`).
3. **Validation** (expanded when failed) — validate output tail + `Fix it` spawns a fix task.
4. **Code** (collapsed) — drill-down: flat file list + two-pane before/after diffs, virtualized for large files.

### 9.3 Scaling to huge conflicts

Uncertainty is the unit of review, not files. A 500-file rebase with one real ambiguity shows one card. Validation is the safety net for the rest.

### 9.4 Handoff — ask a developer

First-class escape hatch. `Hand off` button on any review card and at the bottom of the review screen:

1. Lock the topic (`blocked_on_human`), disable Sync/Address/Merge.
2. Modal: pick collaborator (backed by `listCollaborators()`), optional note.
3. If PR open: post comment on PR mentioning the GitHub/GitLab login. If still Draft: copy handoff text to clipboard.
4. Push a draft resolution branch `<topic>__rebase-draft-N` so the developer can inspect.
5. `I'm back` button unlocks after the developer's fix; refetch topic branch from remote and resume.

## 10. Non-voting checks & flaky detection

### 10.1 Required vs non-voting

Detection: `vcs-adapter.getRequiredChecks(default-branch)` → cached on repo row (1h TTL). If unavailable, fall back to `repo.non_voting_overrides` (glob list); if still empty, treat all as required.

Non-voting checks:

- Don't turn rollup red.
- Don't block Merge.
- Don't trigger OS notifications.
- Excluded from Fix all and Review Inbox.
- Collapsed by default under `▸ N advisory check(s)`, muted styling, `ⓘ advisory` badge.

Per-repo override list in settings supports forcing a check required or advisory, with a confirmation dialog when downgrading a GitHub-required check to advisory.

### 10.2 Flaky detection

Every `Fix CI` / `Fix all` triage run classifies failures into `code-issue | flaky-infra | flaky-test | unknown` using a structured final message:

```
## Triage
- build:                code-issue
- test-kotlin-calcique: flaky-infra     (reason: "testcontainers postgres connection refused")
- lint-kotlin:          code-issue
```

Claudex parses the triage block and:

- `code-issue` → proceed to fix path.
- `flaky-*` → call `vcs-adapter.rerunFailedChecks(run-id)`; spawn no fix.
- `unknown` → treat as `code-issue` (safe).

Per-check `Check if flaky` button for on-demand triage. `Restart anyway` for explicit user override. Max 2 auto-restarts per check per PR; further restarts require confirmation.

Learning: `repo.flaky_patterns` and `repo.flaky_tests` accumulate over runs. Used as hints in later triages; never applied without Claude's classification.

## 11. Persistence + resume

### 11.1 Schema (SQLite, additive)

```
repo              id, path, canonical_remote, fork_remote, default_branch,
                  tracker_mcp, vcs_kind,
                  branch_template, commit_template, attempt_suffix,
                  validate_cmd, pr_body_template, merge_strategy,
                  required_checks_cache (JSON+ts), non_voting_overrides (JSON),
                  flaky_patterns (JSON), flaky_tests (JSON),
                  skills (JSON), known_types (JSON), known_projects (JSON),
                  github_login_cache

topic             id, repo_id, phase, template, ticket_key, title, slug,
                  topic_branch, pr_number, accepted_attempt_id,
                  blocked_on_human, created_at, merged_at, closed_at

task              session_id (FK sessions), topic_id, type, parent_trigger (JSON),
                  child_branch, worktree_path, accepted_at, discarded_at,
                  triage_result (JSON)

user              singleton: github_login, preferred_template
```

Existing `sessions.worktree_*` columns are reused via `task.session_id`. Legacy sessions appear as orphan tasks under a synthetic `legacy` topic per repo on first boot (Section 14).

### 11.2 Resume

On boot:

- For each non-terminal topic: validate topic branch exists locally and canonical remote resolves.
- For each non-terminal task: validate worktree path + child branch exist.
- Broken tasks → `status=detached` with `Re-attach` / `Discard` buttons (reuses today's session-detach UX).
- Topic phase, PR state, review threads, CI checks refetched via adapter calls with 5-minute cache.
- `rebase-merge/` inside a worktree is authoritative for in-progress rebase state.
- `blocked_on_human` persists; only `I'm back` unlock transitions out.

## 12. Integrations

### 12.1 VcsAdapter interface

```ts
interface VcsAdapter {
  kind: 'github' | 'gitlab';
  getCurrentUser(): Promise<{ login: string }>;
  getRepo(cwd: string): Promise<{ owner: string; name: string; defaultBranch: string;
                                  parentOwner?: string; parentName?: string }>;
  createPR(input: { base: string; head: string; title: string; body: string }): Promise<PR>;
  getPR(number: number): Promise<PR>;
  mergePR(number: number, strategy: 'squash'|'merge'|'rebase'): Promise<void>;
  listReviewThreads(number: number): Promise<ReviewThread[]>;
  replyOnThread(threadId: string, body: string): Promise<void>;
  resolveThread(threadId: string): Promise<void>;
  listChecks(ref: string): Promise<Check[]>;
  getRequiredChecks(branch: string): Promise<string[]>;
  rerunFailedChecks(runId: string): Promise<void>;
  listCollaborators(): Promise<{ login: string; name?: string }[]>;
}
```

MVP ships `GitHubAdapter` over `gh`. `GitLabAdapter` over `glab` is a follow-up; interface reserved to keep the door open.

### 12.2 TrackerAdapter interface

```ts
interface TrackerAdapter {
  kind: 'jira' | 'youtrack' | 'linear';
  whoami(): Promise<{ accountId: string; displayName: string }>;
  searchAssigned(): Promise<Ticket[]>;
  searchRecent(): Promise<Ticket[]>;
  getTicket(key: string): Promise<Ticket>;
  createTicket(input: { title: string; body: string; project?: string }): Promise<Ticket>;
  postComment(key: string, body: string): Promise<void>;
}
```

Adapter is a shim over the user's existing Claude-Code MCP. Claudex does not ship its own MCP; it reuses the user's. Per-repo `tracker_mcp` setting picks one when multiple are installed. When none, free-form titles are the only source.

### 12.3 Skill bindings & fallbacks

Skills encode repo-specific policy. Reads go direct via adapters; writes prefer skills, fall back to built-ins.

Canonical actions and their skill slugs:

| Action | Skill slug | Fallback |
|---|---|---|
| Commit | `commit` | git + generator using `commit_template` |
| Create PR | `pr-create` | `vcs-adapter.createPR` with `pr_body_template` |
| Address feedback | `pr-fix` | built-in orchestration over adapter |
| Reply/resolve | `pr-review` | built-in |
| Fix CI | `ci-watch` | fetch-logs-then-fix task |
| Validate | `validate` | run `validate_cmd` if set; else skip |
| Start-from-ticket | `coding` | pre-seed prompt with ticket body |
| Ask Claude to review | `code-review` | built-in review-report prompt |
| Rebase | none expected | built-in rebase + narrative flow |

**Detection.** On repo registration, scan `.claude/skills/*/SKILL.md` + `~/.claude/skills/*/SKILL.md`; parse YAML frontmatter; match frontmatter `name` to canonical slugs. Store in `repo.skills` as a map `slug → skill command`. `Refresh skills` button + auto-scan on boot.

**Invocation.** Claudex spawns a task whose initial prompt is the slash command (with args where useful). It parses the final message for commit SHAs / thread IDs / uncertainty blocks via simple markers.

**Per-repo remap.** Settings expose `action → skill command` overrides, allowing repos with custom skill names (e.g., `/open-pr`) to bind without code changes.

**Code review as artifact.** The `Ask Claude to review` button is distinct from `Address feedback`:

- It invokes the repo's `code-review` skill if bound; writes a markdown report artifact, stored on the topic.
- Render artifact inline in a `Review reports` panel with history and timestamps.
- Each ❌ item has an `Apply this` link that seeds a fix task.
- No writes to branch, no push, no thread operations.

This matches dag_bpay's existing review-as-artifact workflow without distorting the Address-feedback path used by repos that reply-and-resolve on the platform.

### 12.4 Per-repo templates

Branch and commit naming are templated with placeholders:

| Placeholder | Meaning |
|---|---|
| `{gh_user}` | GitHub/GitLab username (from `getCurrentUser().login`) |
| `{git_user}` | `git config user.name` |
| `{ticket}` | Ticket key (empty if free-form) |
| `{slug}` | lowercased-dashed title, truncated |
| `{type}` | feature/bugfix/integration/etc. (from new-topic form) |
| `{project}` | repo-configurable project code (from new-topic form) |
| `{scope}` | commit-only: changed-area identifier |
| `{subject}` | commit-only: first-line message |
| `{risk}` | commit-only: low/high/nonprod (gdc-nas specific) |
| `{n}` | attempt number (attempt suffix only) |

Examples:

```
gdc-nas   branch_template = "{gh_user}/{ticket}_{slug}"
          commit_template = "{type}({scope}): {subject}\n\nJIRA: {ticket}\nrisk: {risk}"
dag_bpay  branch_template = "{type}/{project}/{ticket}-{slug}"
          commit_template = "{ticket}: {subject}"
```

Auto-detection on repo registration scans `AGENTS.md` / `CONTRIBUTING.md` / `CLAUDE.md` / existing `git log` for known patterns; proposes a template for confirmation. Never applied silently.

## 13. Identity handling

Three distinct identities, never cross-wired:

| Identity | Source | Used for |
|---|---|---|
| GitHub/GitLab login | `vcs-adapter.getCurrentUser()` | `@mentions`, branch prefix, PR/MR author, collaborator picker |
| Tracker account | `tracker-adapter.whoami()` | Ticket assignment, Jira/YT comments |
| Git author | `git config user.*` | Commits |

Auto-wired on repo registration. Settings exposes override for edge cases (shared bot accounts). **Branch-name examples in this document use `jaceksan`.**

## 14. Migration from current state

- Legacy sessions with `worktree_path` populated become orphan `task` rows under a synthetic `legacy` topic per repo on first boot after upgrade. Phase `Open` if a PR is detected for the branch, else `Draft`.
- Legacy sessions without a worktree become `task` rows under the legacy topic with `Edit in place` marker; no branch created.
- Users can archive the legacy topic at any time; active ones continue working in the new surface.
- Broadcast UI, in-app toaster, and per-session launcher are removed in the same release.

## 15. Out of scope / follow-ups

- GitLab adapter implementation (interface reserved; ships later).
- Slack notification channel (design only; OS notifications for MVP).
- Permissions / multi-user story for non-tech access.
- Stacked PRs / dependent-branch graphs.
- In-browser permission prompts (existing roadmap item).
- File-watch for skill directories (manual refresh for MVP).
- Hand-off generalisation beyond conflict resolution (per-CI-fix, per-review-fix).

## 16. README addendum (roadmap)

Add the following bullets to README.md roadmap section in the implementing PR:

- **Topics & PR lifecycle.** Worktree isolation by default; ticket-shaped topics own PRs end-to-end; non-tech-friendly verbs with engineer-grade power underneath.
- **Conflict resolution with AI narrative review.** Trust-first, validate-always; human lands in review only when Claude flags uncertainty or validation fails.
- **Flaky CI triage & auto-restart.** Distinguish infrastructure flakes from real failures; restart flakies rather than "fixing" them.
- **Permissions / multi-user non-tech access (follow-up).** Current design is single-operator localhost. A safe auth model for invited non-tech collaborators is a follow-up investigation — keep the door open in the data model and UI.
- **Slack notifications (follow-up).** Reuse the OS-notification contract; add Slack channel/DM delivery for absent operators and async reviewers.
- **GitLab support (follow-up).** `VcsAdapter` is interface-ready; `GitLabAdapter` over `glab` ships after the GitHub path lands.

## 17. Validation of the design against real repos

- **gdc-nas** (GitHub, Jira, Kotlin/Python monorepo, `commit`/`pr-create`/`pr-fix`/`ci-watch`/`validate` skills, strict commit format with `JIRA:`/`risk:` tags). Exercises the full skill-binding path and templated commit format.
- **dag_bpay** (GitLab, YouTrack, Java/Angular monorepo, `coding`/`code-review` skills, branch format `<type>/<project>/<ticket>-<slug>`). Exercises per-repo templating, VcsAdapter abstraction, review-as-artifact vs address-feedback split, and absence of `pr-*` skills (fallbacks do the work).
- **claudex** (GitHub, no tracker, small TypeScript repo). Exercises free-form topic creation, minimal skill bindings, conflict-free small-change flow.
