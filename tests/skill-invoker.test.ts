import { describe, it, expect } from 'vitest';
import { renderActionPrompt } from '../src/server/skill-invoker.js';

describe('renderActionPrompt', () => {
  it('returns skill slash command when bound', () => {
    expect(renderActionPrompt({
      action: 'pr-create', skills: { 'pr-create': '/pr-create' },
    })).toBe('/pr-create');
  });
  it('returns fallback prompt when unbound', () => {
    const p = renderActionPrompt({ action: 'pr-create', skills: {}, fallbackCtx: { title: 'T', body: 'B', base: 'main', head: 'h' } });
    expect(p).toContain('Create a pull request');
    expect(p).toContain('base branch main');
  });
  it('seeds fix-comments prompt with thread context', () => {
    const p = renderActionPrompt({
      action: 'fix-comments', skills: { 'pr-fix': '/pr-fix' },
      fixCtx: { threads: [{ id: 't1', path: 'a.ts', line: 42, body: 'Null-check' }] },
    });
    expect(p).toBe('/pr-fix');
  });
  it('falls back with explicit thread summary when unbound', () => {
    const p = renderActionPrompt({
      action: 'fix-comments', skills: {},
      fixCtx: { threads: [{ id: 't1', path: 'a.ts', line: 42, body: 'Null-check' }] },
    });
    expect(p).toContain('a.ts:42');
    expect(p).toContain('Null-check');
  });
});
