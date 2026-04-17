# Worktree/Topic/Task — Plan 5: Per-repo templates + Skills + Code review + Exploring

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans.

**Spec:** `docs/superpowers/specs/2026-04-17-worktree-topic-task-ux-design.md`
**Depends on:** Plans 1–4.

**Goal:** Works cleanly on gdc-nas (strict commit conventions + skills) and dag_bpay (GitLab-style branches, different skill set) and a bare TypeScript repo with no skills — all with the same UX. Code review as artifact ships. Exploring phase + Split into topics supports AI-driven brainstorm-to-topic flow.

**Architecture:** Skill scan at repo registration + manual refresh. Branch/commit templates with auto-detection heuristic on `AGENTS.md` / `CONTRIBUTING.md`. Code review is a `free` task that writes a markdown artifact stored on the topic. Exploring phase has a bespoke spawn path (`repo.path` as cwd, no worktree).

---

## File Structure

**New:**
- `src/server/skills-scan.ts` — scan `.claude/skills/*/SKILL.md`, parse YAML frontmatter, produce bindings.
- `src/server/template-detect.ts` — heuristic scan of `AGENTS.md`, `CONTRIBUTING.md`, `CLAUDE.md` for branch/commit patterns.
- `src/server/tracker/jira.ts`, `src/server/tracker/youtrack.ts`, `src/server/tracker/linear.ts` — MCP-backed adapters (thin).
- `src/server/review-artifact.ts` — store and retrieve review markdown on a topic.
- `src/server/exploring.ts` — Start-work transition, Split-into-topics.
- `src/web/components/repo-settings-modal.tsx` — skill bindings + template overrides + non-voting.
- `src/web/components/ticket-picker.tsx` — wired when TrackerAdapter returns non-None.
- `src/web/components/review-reports-panel.tsx` — artifact list on topic page.
- `src/web/components/split-topics-modal.tsx` — Split into topics UI.
- `tests/skills-scan.test.ts`, `tests/template-detect.test.ts`, `tests/exploring.test.ts`, `tests/review-artifact.test.ts`.

**Modify:**
- `src/server/repo.ts` — `refreshSkills(repoId)` helper.
- `src/server/topic-manager.ts` — Start-work transition; Split-into-topics.
- `src/server/schema.ts` — add `review_artifact (id, topic_id, created_at, content)` table.
- `src/web/components/new-topic-modal.tsx` — wire Ticket picker; show type/project fields only when template uses them.

---

## Task 1: Skills scan + bindings

**Files:** Create `src/server/skills-scan.ts`; test.

- [ ] **Step 1:** Test — given a fixture directory with `.claude/skills/pr-create/SKILL.md` and `pr-fix/SKILL.md`, returns `{ 'pr-create': '/pr-create', 'pr-fix': '/pr-fix' }`. Also scans `~/.claude/skills/` (stubbed via env or constructor arg).

- [ ] **Step 2:** Implement:

```ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CANONICAL = new Set([
  'commit', 'pr-create', 'pr-review', 'pr-fix', 'ci-watch',
  'validate', 'coding', 'code-review',
]);

function readFrontmatterName(file: string): string | null {
  const text = readFileSync(file, 'utf8');
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(text);
  if (!m) return null;
  const nameMatch = /^name:\s*(.+)\s*$/m.exec(m[1]);
  return nameMatch ? nameMatch[1].trim() : null;
}

function scanDir(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!safeExists(root)) return out;
  for (const d of readdirSync(root)) {
    const skillFile = path.join(root, d, 'SKILL.md');
    if (!safeExists(skillFile)) continue;
    const name = readFrontmatterName(skillFile);
    if (name && CANONICAL.has(name)) out[name] = `/${name}`;
  }
  return out;
}

function safeExists(p: string): boolean { try { statSync(p); return true; } catch { return false; } }

export function scanSkills(repoPath: string): Record<string, string> {
  const repoSkills = scanDir(path.join(repoPath, '.claude', 'skills'));
  const userSkills = scanDir(path.join(os.homedir(), '.claude', 'skills'));
  return { ...userSkills, ...repoSkills }; // repo-local overrides user-level
}
```

- [ ] **Step 3:** Wire into repo registration + `Refresh skills` button endpoint.

```ts
// in commands.ts
app.post('/api/repo/:id/skills/refresh', (req, res) => {
  const repo = repos.getById(req.params.id);
  if (!repo) return res.status(404).end();
  const bindings = scanSkills(repo.path);
  repos.updateSkills(repo.id, bindings);
  res.send(bindings);
});
```

- [ ] **Step 4:** Commit:
```bash
CLAUDEX_SKIP_README=1 git commit -am "feat(skills): scan repo-local + user-level SKILL.md and bind canonical actions"
```

---

## Task 2: Template auto-detection

**Files:** Create `src/server/template-detect.ts`; test.

- [ ] **Step 1:** Test — given example text from gdc-nas' AGENTS.md, returns gdc-nas-style templates; given dag_bpay's, returns dag_bpay-style.

```ts
import { describe, it, expect } from 'vitest';
import { detectTemplates } from '../src/server/template-detect';

describe('detectTemplates', () => {
  it('detects gdc-nas conventions', () => {
    const text = `Commit Message Format\n<type>(<scope>): <subject>\n\nJIRA: <TICKET-ID> or JIRA: TRIVIAL\nrisk: nonprod|low|high`;
    expect(detectTemplates(text)).toEqual({
      branch_template: '{gh_user}/{ticket}_{slug}',
      commit_template: '{type}({scope}): {subject}\n\nJIRA: {ticket}\nrisk: {risk}',
    });
  });
  it('detects dag_bpay conventions', () => {
    const text = `**Commits:** \`CBP-XXXX: Description\`\n**Branches:** \`[type]/[project]/[ticket-id]-description\``;
    expect(detectTemplates(text)).toEqual({
      branch_template: '{type}/{project}/{ticket}-{slug}',
      commit_template: '{ticket}: {subject}',
    });
  });
  it('returns null when no signals', () => {
    expect(detectTemplates('nothing here')).toBeNull();
  });
});
```

- [ ] **Step 2:** Implement:

```ts
export interface DetectedTemplates { branch_template: string; commit_template: string; }

const SIGNATURES: Array<{ match: RegExp; templates: DetectedTemplates }> = [
  {
    // gdc-nas: commit "<type>(<scope>): <subject>" + "JIRA:" + "risk:" tags.
    match: /<type>\(<scope>\):\s*<subject>[\s\S]+JIRA:[\s\S]+risk:/,
    templates: {
      branch_template: '{gh_user}/{ticket}_{slug}',
      commit_template: '{type}({scope}): {subject}\n\nJIRA: {ticket}\nrisk: {risk}',
    },
  },
  {
    // dag_bpay: branches "[type]/[project]/[ticket-id]-description" + commit "CBP-XXXX: Description".
    match: /\[type\]\/\[project\]\/\[ticket-id\]-description|CBP-XXXX:\s*Description/,
    templates: {
      branch_template: '{type}/{project}/{ticket}-{slug}',
      commit_template: '{ticket}: {subject}',
    },
  },
];

export function detectTemplates(text: string): DetectedTemplates | null {
  for (const sig of SIGNATURES) if (sig.match.test(text)) return sig.templates;
  return null;
}
```

New repos: add a new signature entry rather than generalising. Auto-detection stays conservative — unknown conventions keep claudex defaults.

- [ ] **Step 3:** On repo registration, open `AGENTS.md`, `CONTRIBUTING.md`, `CLAUDE.md` (any of them) in the repo root; run `detectTemplates` over the concatenated text; if a match, persist — otherwise keep default. Surface the proposed template in the registration UI for user confirmation.

- [ ] **Step 4:** Commit:
```bash
CLAUDEX_SKIP_README=1 git commit -am "feat(templates): auto-detect branch/commit templates from repo conventions"
```

---

## Task 3: Repo settings modal

**Files:** Create `src/web/components/repo-settings-modal.tsx`; backend endpoints for update.

- [ ] **Step 1:** Sections:
  - **Identity** — github login (read-only), override input.
  - **Remotes** — canonical_remote, fork_remote, default_branch.
  - **Templates** — branch_template, commit_template (with live preview showing how it renders for a sample ticket).
  - **Skills bindings** — table of `action → skill-command`, each with `[unbind]` button and `[configure]` for custom command.
  - **CI** — required checks (read-only, from GitHub), non-voting overrides (editable glob list), merge strategy.
  - **Tracker** — dropdown of installed tracker adapters (`none`, `jira`, `youtrack`, `linear`).
  - **Validate command** — free-form string.
  - **Refresh** button runs `skills/refresh` and `required-checks/refresh`.

- [ ] **Step 2:** Endpoints: `PATCH /api/repo/:id` for arbitrary column updates; validate inputs.

- [ ] **Step 3:** Render the modal from topic-page header (cog icon) and from dashboard (per-card menu or global settings).

- [ ] **Step 4:** Commit:
```bash
CLAUDEX_SKIP_README=1 git commit -am "feat(settings): per-repo settings modal"
```

---

## Task 4: Tracker adapters (jira/youtrack/linear)

**Files:** Create three files under `src/server/tracker/`.

- [ ] **Step 1:** Each is a **very thin** shim that spawns a `claude` subprocess with the appropriate MCP enabled and a structured prompt, parses the response. For MVP, the simplest implementation:

```ts
// jira.ts — example shape
import type { TrackerAdapter, Ticket } from './adapter';

export class JiraAdapter implements TrackerAdapter {
  readonly kind = 'jira' as const;
  constructor(private invoke: (prompt: string) => Promise<string>) {}

  async whoami() {
    const out = await this.invoke('Use the Jira MCP to return my accountId and displayName as JSON: {accountId, displayName}. No prose.');
    const json = JSON.parse(extractJson(out));
    return { accountId: json.accountId, displayName: json.displayName };
  }
  async searchAssigned(): Promise<Ticket[]> {
    const out = await this.invoke('Use the Jira MCP to list tickets assigned to me. Return a JSON array of {key, title, body, url, status}. Include at most 20. No prose.');
    return JSON.parse(extractJson(out)) as Ticket[];
  }
  async searchRecent(): Promise<Ticket[]> {
    const out = await this.invoke('Use the Jira MCP to list tickets I viewed or commented on in the last 14 days. Return JSON array of {key, title, body, url, status}. No prose.');
    return JSON.parse(extractJson(out)) as Ticket[];
  }
  async getTicket(key: string): Promise<Ticket | null> {
    const out = await this.invoke(`Use the Jira MCP to fetch ticket ${key}. Return JSON {key, title, body, url, status} or null.`);
    try { const j = JSON.parse(extractJson(out)); return j ?? null; } catch { return null; }
  }
  async createTicket(input: { title: string; body: string; project?: string }): Promise<Ticket | null> {
    const prompt = `Use the Jira MCP to create a ticket in project ${input.project ?? '(ask the user)'} with title=${JSON.stringify(input.title)} and description=${JSON.stringify(input.body)}. Return JSON {key,title,body,url,status}.`;
    try { return JSON.parse(extractJson(await this.invoke(prompt))); } catch { return null; }
  }
  async postComment(key: string, body: string): Promise<void> {
    await this.invoke(`Use the Jira MCP to post a comment on ticket ${key}. Body: ${JSON.stringify(body)}. Return "ok" when done.`);
  }
}

function extractJson(out: string): string {
  const fenced = /```(?:json)?\n([\s\S]*?)\n```/.exec(out);
  return (fenced?.[1] ?? out).trim();
}
```

YouTrack and Linear follow the same pattern, swapping the MCP name and any field mapping in the prompt.

The `invoke` function is provided by a small helper that spawns `claude -p "<prompt>" --allowedTools Bash` or similar, depending on how claudex runs internal Claude calls today. MVP can stub this out and mark the adapter as "requires MCP to be configured" in settings.

- [ ] **Step 2:** Register in `tracker/index.ts`. Default to `NoneAdapter` when MCP isn't detected.

- [ ] **Step 3:** Ticket picker UI (`ticket-picker.tsx`) — uses `TrackerAdapter.searchAssigned()` + `searchRecent()`; free-text fallback with `createTicket` flag.

- [ ] **Step 4:** Integration test — `NoneAdapter` always returns empty lists; picker falls back gracefully.

- [ ] **Step 5:** Commit:
```bash
CLAUDEX_SKIP_README=1 git commit -am "feat(tracker): jira/youtrack/linear adapter skeletons over MCP"
```

---

## Task 5: Code review as artifact

**Files:** Create `src/server/review-artifact.ts`, `src/web/components/review-reports-panel.tsx`; schema migration.

- [ ] **Step 1:** Schema — add table:

```sql
CREATE TABLE IF NOT EXISTS review_artifact (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  skill_used TEXT,
  content TEXT NOT NULL,
  FOREIGN KEY (topic_id) REFERENCES topic(id)
);
```

Add to `ensureSchema` in `src/server/schema.ts`.

- [ ] **Step 2:** `review-artifact.ts`:

```ts
export interface ReviewArtifact { id: string; topicId: string; createdAt: number; skillUsed: string | null; content: string; }

export class ReviewArtifactStore {
  constructor(private db: Database.Database) {}
  create(topicId: string, content: string, skillUsed: string | null): ReviewArtifact {
    const id = `rev_${crypto.randomUUID().slice(0,8)}`;
    this.db.prepare('INSERT INTO review_artifact (id, topic_id, created_at, skill_used, content) VALUES (?,?,?,?,?)')
      .run(id, topicId, Date.now(), skillUsed, content);
    return this.getById(id)!;
  }
  listByTopic(topicId: string): ReviewArtifact[] { /* SELECT ... */ }
  getById(id: string): ReviewArtifact | null { /* SELECT ... */ }
}
```

- [ ] **Step 3:** `TopicManager.askClaudeToReview(topicId)`:
  - Spawns a `free` task with prompt = `skills['code-review']` or fallback.
  - Session runs against the topic branch worktree (fresh read-only worktree, or reuses the most recent accepted attempt worktree).
  - On session end, parse the final assistant message as markdown; store via `ReviewArtifactStore.create`.

- [ ] **Step 4:** `ReviewReportsPanel` component on topic page — list of artifacts with timestamp; click expands into a markdown render with `Apply this` links next to ❌ bullets (regex-matched from `- ❌`).

- [ ] **Step 5:** Commit:
```bash
CLAUDEX_SKIP_README=1 git commit -am "feat(review): Ask Claude to review panel + artifact store"
```

---

## Task 6: Exploring phase + Start work

**Files:** Extend `src/server/topic-manager.ts`; create `src/server/exploring.ts`; create `src/web/components/split-topics-modal.tsx`.

- [ ] **Step 1:** `TopicManager.startWork(topicId, args)`:
  - Preconditions: `topic.phase === 'Exploring'`.
  - If `!topic.ticketKey && args.createTicket && tracker.kind !== 'none'`: `tracker.createTicket({ title: topic.title, body: args.body })`, set `topic.ticketKey = created.key`.
  - Render topic branch via `branch_template`.
  - `git fetch canonical/default; git branch <topic-branch> canonical/default`.
  - Transition to Draft.
  - Cut attempt-1 worktree off topic branch; **migrate the existing Exploring session** to attempt-1 by updating `task.type = 'attempt'`, `task.worktree_path`, `task.child_branch`, and `sessions.cwd`.

- [ ] **Step 2:** `splitIntoTopics(topicId, slices: Array<{ title: string; body?: string }>)`:
  - For each slice, create a new Draft topic (shared tracker handling).
  - Seed each topic's first attempt prompt with the slice's body.
  - The original Exploring topic is Discarded.

- [ ] **Step 3:** `SplitTopicsModal` UI — lists the Exploring spec sections (extracted by regex `^## `), lets the user label each to a new topic name, submits.

- [ ] **Step 4:** Tests for startWork (happy + no-tracker paths).

- [ ] **Step 5:** Commit:
```bash
CLAUDEX_SKIP_README=1 git commit -am "feat(exploring): Start work transitions Exploring→Draft; Split into topics"
```

---

## Task 7: New topic modal wire-through

**Files:** Modify `src/web/components/new-topic-modal.tsx`.

- [ ] **Step 1:** Wire ticket picker (Task 4) when repo's tracker ≠ `none`.

- [ ] **Step 2:** Surface `type` / `project` inputs only when repo's `branch_template` contains `{type}` / `{project}`. Auto-suggest from `repo.knownTypes` / `repo.knownProjects`. Populate the suggestion list progressively — each successful create appends the value.

- [ ] **Step 3:** Keep the three templates radio cards (Quick fix / Standard / Exploration). `Exploration` adds no required fields.

- [ ] **Step 4:** Advanced section: base-branch override, `Edit in place (no worktree)` checkbox now **actually functional** — on submit with this checked, skip worktree creation, set cwd to repo root, spawn a `free` task under a fresh Draft topic with no branch.

- [ ] **Step 5:** Commit:
```bash
CLAUDEX_SKIP_README=1 git commit -am "feat(new-topic): ticket picker, dynamic fields, edit-in-place"
```

---

## Task 8: Topic-detail integrations

**Files:** Modify `src/web/pages/topic.tsx`.

- [ ] **Step 1:** Action bar gets `Ask Claude to review` (Open phase, secondary).

- [ ] **Step 2:** Exploring phase rendering: hide Tasks panel beyond the single explore session; hide Comments/CI/Conflicts; show `Start work` / `Split into topics` / `Discard` as primary actions.

- [ ] **Step 3:** `Review reports` panel visible on both Draft-post-accept and Open phases.

- [ ] **Step 4:** Commit:
```bash
CLAUDEX_SKIP_README=1 git commit -am "feat(topic-page): Exploring actions + Review reports panel + Ask Claude to review"
```

---

## Task 9: Tests across the three reference repos

**Files:** `tests/fixtures/repos/*` fixtures, integration tests.

- [ ] **Step 1:** Add three small fixture repos under `tests/fixtures/repos/`:
  - `gdc-nas-fixture/` — minimal Kotlin project with `.claude/skills/pr-create/SKILL.md` and gdc-nas-style `AGENTS.md`.
  - `dag_bpay-fixture/` — minimal Java project with `.claude/skills/code-review/SKILL.md` and dag_bpay-style CONTRIBUTING.md.
  - `bare-fixture/` — empty TypeScript project, no skills, no conventions.

- [ ] **Step 2:** Integration test — register each repo (via `RepoStore.register`+`scanSkills`+`detectTemplates`); assert the right templates and skill bindings result.

- [ ] **Step 3:** Commit:
```bash
CLAUDEX_SKIP_README=1 git commit -am "test(repos): fixture-based registration tests for gdc-nas/dag_bpay/bare repos"
```

---

## Task 10: README + smoke

- [ ] **Step 1:** README: add bullets for skills integration, per-repo conventions, code review as artifact, Exploring.

- [ ] **Step 2:** Manual flow: register gdc-nas; verify `/pr-create`, `/pr-fix`, `/validate` bound; create a Quick-fix topic; see a correctly formatted commit on the topic branch (with `JIRA:` + `risk:`).

- [ ] **Step 3:** Repeat for dag_bpay — verify `/coding`, `/code-review` bound; create topic with `CBP-1234` ticket; verify branch name `feature/cbp/CBP-1234-<slug>`.

- [ ] **Step 4:** Repeat for bare repo — verify all actions fall back to built-ins.

- [ ] **Step 5:** Run full verification.

- [ ] **Step 6:** Commit README.

---

## Plan 5 done when

- gdc-nas, dag_bpay, bare-repo all work end-to-end with correct branch names and commit formats.
- Skill bindings visible + editable in repo settings; refresh works.
- Code review artifacts persist across restarts and render inline on the topic page.
- Exploring topics transition to Draft cleanly; Split into topics produces independent draft topics.
- No reference to `jsoubusta` anywhere in the codebase — `jaceksan` everywhere (grep check).
