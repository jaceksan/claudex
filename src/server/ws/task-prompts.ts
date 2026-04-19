/**
 * Prompt templates for button-triggered Claude actions (Save / Merge / Push / …).
 *
 * Buttons delegate work to Claude so the repo's own rules (CLAUDE.md, skills,
 * plugins, MCP) apply to commit messages, PR titles, etc. — we don't want
 * claudex to bake in an opinionated format. The prompts below spell out the
 * preferred rule-source order once; specific action prompts inherit it.
 *
 * Future work: allow users to override these per repo from the UI.
 */

const RULE_PRECEDENCE = `When performing this action follow the repository's own conventions. Prefer them in this priority order:
1. internal Claude skills relevant to this area (git/commit/PR/CI);
2. skills provided by installed plugins;
3. written rules in CLAUDE.md, AGENTS.md, CONTRIBUTING.md, docs/, or similar;
4. configured MCP tools.
If none match, use sensible defaults. Do not fabricate conventions.`;

export function savePrompt(args: { topicTitle: string; taskLabel: string | null; ticketKey: string | null }): string {
  const ctx = args.ticketKey ? `${args.ticketKey} — ${args.topicTitle}` : args.topicTitle;
  const what = args.taskLabel ? `Task: "${args.taskLabel}" on topic: "${ctx}".` : `Topic: "${ctx}".`;
  return [
    `Please commit all currently uncommitted changes in this worktree with a single commit. ${what}`,
    `Choose a commit message that matches this repository's conventions.`,
    RULE_PRECEDENCE,
    `Do not push. Do not touch any other branch. If there is nothing to commit, report that and stop.`,
  ].join('\n\n');
}

export function mergePrompt(args: {
  topicBranch: string;
  taskBranch: string;
  repoPath: string;
  topicTitle: string;
  taskLabel: string | null;
  ticketKey: string | null;
}): string {
  const ctx = args.ticketKey ? `${args.ticketKey} — ${args.topicTitle}` : args.topicTitle;
  return [
    `Please merge this task's commits into the topic branch.`,
    `Context:`,
    `- topic: "${ctx}"`,
    `- task label: ${args.taskLabel ?? '(unnamed)'}`,
    `- task branch (current): ${args.taskBranch}`,
    `- topic branch: ${args.topicBranch}`,
    `- repo path (main clone, not this worktree): ${args.repoPath}`,
    `Use the repo's preferred merge strategy (usually \`git merge --squash\`). Run git commands against the main clone with \`git -C ${args.repoPath} …\` or by cd-ing there — do not leave this worktree dirty.`,
    `Choose the merge commit message per the repository's conventions.`,
    RULE_PRECEDENCE,
    `Do not push. Do not open a PR. If the worktree is dirty or the task branch has no new commits, report that and stop.`,
  ].join('\n\n');
}

export function pushPrompt(args: { topicBranch: string; topicTitle: string; ticketKey: string | null; forkRemote: string }): string {
  const ctx = args.ticketKey ? `${args.ticketKey} — ${args.topicTitle}` : args.topicTitle;
  return [
    `Please push the topic branch to the remote, setting upstream tracking.`,
    `- topic: "${ctx}"`,
    `- branch: ${args.topicBranch}`,
    `- remote: ${args.forkRemote}`,
    `Typical command: \`git push --set-upstream ${args.forkRemote} ${args.topicBranch}\`, but follow any repo-specific push policy if one exists.`,
    RULE_PRECEDENCE,
    `Do not open a PR in this step. Report the remote URL once pushed.`,
  ].join('\n\n');
}
