import { describe, it, expect } from 'vitest';
import { renderBranchTemplate } from '../src/server/branch-template';

describe('renderBranchTemplate', () => {
  it('interpolates gh-style', () => {
    expect(renderBranchTemplate('{gh_user}/{ticket}_{slug}', {
      gh_user: 'jaceksan', ticket: 'ABC-123', slug: 'fix-login-copy',
    })).toBe('jaceksan/ABC-123_fix-login-copy');
  });
  it('interpolates dag_bpay-style', () => {
    expect(renderBranchTemplate('{type}/{project}/{ticket}-{slug}', {
      type: 'feature', project: 'cbp', ticket: 'CBP-1234', slug: 'payout-retry',
    })).toBe('feature/cbp/CBP-1234-payout-retry');
  });
  it('drops empty placeholders cleanly', () => {
    expect(renderBranchTemplate('{gh_user}/{ticket}_{slug}', {
      gh_user: 'jaceksan', ticket: '', slug: 's',
    })).toBe('jaceksan/s');
  });
  it('renders attempt suffix', () => {
    expect(renderBranchTemplate('__attempt-{n}', { n: '2' })).toBe('__attempt-2');
  });
  it('collapses double slashes when a middle placeholder is empty', () => {
    expect(renderBranchTemplate('{type}/{project}/{ticket}-{slug}', {
      type: 'feature', project: '', ticket: 'CBP-1234', slug: 'payout-retry',
    })).toBe('feature/CBP-1234-payout-retry');
  });
});
