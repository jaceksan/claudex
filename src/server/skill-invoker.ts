export type CanonicalAction = 'commit' | 'pr-create' | 'pr-review' | 'pr-fix' | 'ci-watch' | 'validate' | 'coding' | 'code-review';

export interface RenderInput {
  action: CanonicalAction | 'fix-comments' | 'fix-ci';
  skills: Record<string, string>;
  fallbackCtx?: { title?: string; body?: string; base?: string; head?: string };
  fixCtx?: { threads?: { id: string; path: string | null; line: number | null; body: string }[]; checks?: { name: string; logTail: string }[] };
}

const FALLBACKS: Record<CanonicalAction, (i: RenderInput) => string> = {
  'pr-create': (i) => `Create a pull request titled "${i.fallbackCtx?.title ?? ''}" on base branch ${i.fallbackCtx?.base ?? 'main'} from head ${i.fallbackCtx?.head ?? ''}. Body: ${i.fallbackCtx?.body ?? ''}. Use gh pr create.`,
  'pr-fix': (i) => buildFixPrompt(i),
  'pr-review': (i) => buildFixPrompt(i),
  'ci-watch': (i) => buildFixPrompt({ ...i, fixCtx: { ...i.fixCtx, threads: undefined } }),
  commit: () => 'Stage changes and make a commit following repo conventions. Print the commit SHA.',
  validate: () => 'Run the project validation command for the changed files. Fix any failures.',
  coding: () => 'Implement the task described above.',
  'code-review': () => 'Produce a markdown code review under Review Structure (Summary, Changes, Review by File, Acceptance Criteria, Overall Verdict).',
};

function buildFixPrompt(i: RenderInput): string {
  const parts: string[] = ['Address the following and push a commit. Reply on each addressed item with the commit SHA.'];
  if (i.fixCtx?.threads?.length) {
    parts.push('## Review comments');
    for (const t of i.fixCtx.threads) parts.push(`- ${t.path ?? '(no path)'}:${t.line ?? '?'} — ${t.body}`);
  }
  if (i.fixCtx?.checks?.length) {
    parts.push('## Failing CI');
    for (const c of i.fixCtx.checks) parts.push(`- ${c.name}\n${c.logTail}`);
  }
  return parts.join('\n');
}

export function renderActionPrompt(input: RenderInput): string {
  const slug = input.action === 'fix-comments' ? 'pr-fix' : input.action === 'fix-ci' ? 'ci-watch' : input.action;
  const bound = input.skills[slug];
  if (bound) return bound;
  return FALLBACKS[slug as CanonicalAction](input);
}
