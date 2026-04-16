import { describe, it, expect } from 'vitest';
import { Db } from '../src/server/db';

describe('Db', () => {
  it('upserts and lists sessions', () => {
    const db = new Db(':memory:');
    db.upsertSession({ id: 's1', cwd: '/tmp', label: null, status: 'running' });
    db.upsertSession({ id: 's1', cwd: '/tmp', label: null, status: 'ended' });
    db.upsertSession({ id: 's2', cwd: '/tmp2', label: 'x', status: 'running' });
    const rows = db.listSessions();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === 's1')?.status).toBe('ended');
  });

  it('get/set prefs', () => {
    const db = new Db(':memory:');
    db.setPref('theme', 'dark');
    expect(db.getPref('theme')).toBe('dark');
    expect(db.getPref('missing')).toBeNull();
  });
});
