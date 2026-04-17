import { describe, it, expect } from 'vitest';
import { slugify } from '../src/server/slug';

describe('slugify', () => {
  it('lowercases, dashes, strips punctuation', () => {
    expect(slugify('Fix: Login copy!')).toBe('fix-login-copy');
  });
  it('truncates to 40 chars by default', () => {
    expect(slugify('a'.repeat(100))).toHaveLength(40);
  });
});
