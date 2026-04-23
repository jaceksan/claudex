import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * One-shot text generation via `claude -p`. Used for producing commit
 * messages, PR titles, and PR descriptions — i.e., the rule-laden *text* of
 * git operations, while the git operations themselves run deterministically
 * on the server. The alternative (running the whole commit flow through a
 * live Claude session) was unreliable and slow; this keeps Claude doing only
 * the part that actually benefits from its reasoning.
 *
 * We spawn `claude -p` with `cwd` set to the target directory so Claude
 * loads the repo's own CLAUDE.md / AGENTS.md / skills. `--max-turns 1`
 * forbids tool round-trips, forcing a direct text response (we pre-bake all
 * the context the model needs into the prompt).
 */
const DEFAULT_TIMEOUT_MS = 90_000;

export interface GenerateOpts {
  cwd: string;
  prompt: string;
  timeoutMs?: number;
}

async function runClaudeP(opts: GenerateOpts): Promise<string> {
  const { stdout } = await exec(
    'claude',
    ['-p', opts.prompt, '--output-format', 'json', '--max-turns', '1'],
    { cwd: opts.cwd, timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
  );
  const trimmed = stdout.trim();
  // `claude -p --output-format json` returns a single JSON envelope:
  // {"type":"result","result":"...","is_error":false,...}
  try {
    const j = JSON.parse(trimmed) as { result?: string; is_error?: boolean };
    if (j.is_error) throw new Error(`claude -p reported error: ${trimmed.slice(0, 500)}`);
    return (j.result ?? '').trim();
  } catch {
    // If somehow the output isn't valid JSON, return the trimmed stdout.
    return trimmed;
  }
}

const RULE_PRECEDENCE = `Follow this repository's own conventions in priority order:
1. internal Claude skills relevant to commits/PRs/git in this repo;
2. skills provided by installed plugins;
3. written rules in CLAUDE.md, AGENTS.md, CONTRIBUTING.md, docs/, PR templates;
4. Conventional Commits as a default if nothing repo-specific applies.
Do not fabricate conventions that are not documented.`;

/** Strip code fences Claude sometimes wraps around text answers. */
function stripFences(s: string): string {
  const fence = s.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  return fence ? fence[1] : s;
}

export interface CommitMessageCtx {
  cwd: string;             // task worktree path
  branch: string;
  topicTitle: string;
  taskLabel: string | null;
  ticketKey: string | null;
  stagedDiff: string;
  recentLog: string;
  /** If set, a previous attempt was rejected by a repo-local commit-msg hook.
   *  Passed verbatim to Claude so it can comply on the retry. */
  hookFeedback?: string;
}

export async function generateCommitMessage(ctx: CommitMessageCtx): Promise<string> {
  const diff = ctx.stagedDiff.length > 60_000
    ? ctx.stagedDiff.slice(0, 60_000) + '\n…[truncated for prompt size]'
    : ctx.stagedDiff;
  const prompt = [
    `Write a git commit message for the staged changes below. Return ONLY the commit message text — no preamble, no trailing explanation, no markdown fence.`,
    ``,
    `Context:`,
    `- topic: "${ctx.topicTitle}"`,
    `- task: ${ctx.taskLabel ?? '(unnamed)'}`,
    `- branch: ${ctx.branch}`,
    ctx.ticketKey ? `- ticket: ${ctx.ticketKey}` : '- ticket: (none — extract from branch name if a convention exists there)',
    ``,
    `Recent commit style in this repo (most recent first):`,
    ctx.recentLog.trim() || '(repo is empty)',
    ``,
    `Staged diff:`,
    '```diff',
    diff,
    '```',
    ``,
    RULE_PRECEDENCE,
    ``,
    ctx.hookFeedback
      ? `A previous attempt was rejected by this repo's commit-msg hook with the following output. Produce a revised message that complies exactly with the stated format (including any trailers like JIRA:, risk:, etc.). Infer required trailer values conservatively: if the ticket is unknown, use "TRIVIAL"; if risk is unstated, use "nonprod".\n\n${ctx.hookFeedback.slice(0, 2000)}`
      : '',
    ``,
    `Do not run any tools. Return the commit message as your final answer.`,
  ].filter(Boolean).join('\n');
  const out = await runClaudeP({ cwd: ctx.cwd, prompt });
  return stripFences(out).trim();
}

export interface MergeCommitCtx {
  cwd: string;
  topicBranch: string;
  taskBranch: string;
  topicTitle: string;
  taskLabel: string | null;
  ticketKey: string | null;
  commitList: string;      // `git log --oneline <topic>..<task>`
  combinedDiff: string;    // `git diff <topic>..<task>`
}

export async function generateMergeCommitMessage(ctx: MergeCommitCtx): Promise<string> {
  const diff = ctx.combinedDiff.length > 60_000
    ? ctx.combinedDiff.slice(0, 60_000) + '\n…[truncated for prompt size]'
    : ctx.combinedDiff;
  const prompt = [
    `Write a squash-merge commit message that captures the work of a task about to be folded into a topic branch. Return ONLY the commit message text — no preamble, no markdown fence.`,
    ``,
    `Context:`,
    `- topic: "${ctx.topicTitle}"`,
    `- task: ${ctx.taskLabel ?? '(unnamed)'}`,
    `- task branch: ${ctx.taskBranch}`,
    `- merging into: ${ctx.topicBranch}`,
    ctx.ticketKey ? `- ticket: ${ctx.ticketKey}` : '',
    ``,
    `Commits on the task branch (most recent first):`,
    ctx.commitList.trim() || '(none)',
    ``,
    `Combined diff (task branch vs topic branch):`,
    '```diff',
    diff,
    '```',
    ``,
    RULE_PRECEDENCE,
    ``,
    `Do not run any tools. Return the commit message as your final answer.`,
  ].filter(Boolean).join('\n');
  const out = await runClaudeP({ cwd: ctx.cwd, prompt });
  return stripFences(out).trim();
}

export interface PrTextCtx {
  cwd: string;
  topicBranch: string;
  defaultBranch: string;
  topicTitle: string;
  ticketKey: string | null;
  suggestedTitle?: string;
  suggestedBody?: string;
  commitList: string;        // `git log --oneline <default>..<topic>`
  combinedDiff: string;      // `git diff <default>..<topic>`
  prTemplate: string | null; // content of .github/PULL_REQUEST_TEMPLATE.md if present
}

export async function generatePrDescription(ctx: PrTextCtx): Promise<{ title: string; body: string }> {
  const diff = ctx.combinedDiff.length > 60_000
    ? ctx.combinedDiff.slice(0, 60_000) + '\n…[truncated for prompt size]'
    : ctx.combinedDiff;
  const prompt = [
    `Write a pull-request title and body. Return the answer as JSON with exactly these keys: {"title": "...", "body": "..."}. No preamble, no markdown fence, no other keys.`,
    ``,
    `Context:`,
    `- topic: "${ctx.topicTitle}"`,
    `- head branch: ${ctx.topicBranch}`,
    `- base branch: ${ctx.defaultBranch}`,
    ctx.ticketKey ? `- ticket: ${ctx.ticketKey}` : '',
    ctx.suggestedTitle ? `- user-suggested title (refine to match conventions): ${ctx.suggestedTitle}` : '',
    ctx.suggestedBody ? `- user-suggested body (refine to match conventions):\n${ctx.suggestedBody}` : '',
    ``,
    `Commits going into this PR (most recent first):`,
    ctx.commitList.trim() || '(none)',
    ``,
    ctx.prTemplate ? `Repository PR template:\n${ctx.prTemplate}` : '',
    ``,
    `Combined diff (head vs base):`,
    '```diff',
    diff,
    '```',
    ``,
    RULE_PRECEDENCE,
    ``,
    `Do not run any tools. Return the JSON as your final answer.`,
  ].filter(Boolean).join('\n');
  const out = await runClaudeP({ cwd: ctx.cwd, prompt });
  const cleaned = stripFences(out).trim();
  // Be defensive — if Claude prefixed anything, try to extract the first JSON object.
  const jsonStart = cleaned.indexOf('{');
  const jsonEnd = cleaned.lastIndexOf('}');
  const jsonSlice = jsonStart >= 0 && jsonEnd > jsonStart ? cleaned.slice(jsonStart, jsonEnd + 1) : cleaned;
  let parsed: { title?: string; body?: string };
  try {
    parsed = JSON.parse(jsonSlice);
  } catch {
    throw new Error(`PR text generation returned non-JSON: ${cleaned.slice(0, 500)}`);
  }
  if (!parsed.title || !parsed.body) throw new Error(`PR text generation missing title/body: ${cleaned.slice(0, 500)}`);
  return { title: parsed.title.trim(), body: parsed.body.trim() };
}
