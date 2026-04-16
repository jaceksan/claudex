import { describe, it, expect } from 'vitest';
import { NotificationEngine, type Notification } from '../src/server/notifications';
import type { StreamEvent } from '../src/server/stream-json/types';

describe('NotificationEngine', () => {
  it('fires on result event', () => {
    const engine = new NotificationEngine();
    const out: Notification[] = [];
    engine.on('notification', (n) => out.push(n));
    engine.handle('s1', { type: 'result', subtype: 'success', session_id: 's1', is_error: false });
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('session-ended');
  });

  it('fires on tool error', () => {
    const engine = new NotificationEngine();
    const out: Notification[] = [];
    engine.on('notification', (n) => out.push(n));
    const ev: StreamEvent = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }],
      },
    };
    engine.handle('s1', ev);
    expect(out[0].kind).toBe('tool-error');
  });

  it('fires on ExitPlanMode tool_use', () => {
    const engine = new NotificationEngine();
    const out: Notification[] = [];
    engine.on('notification', (n) => out.push(n));
    const ev: StreamEvent = {
      type: 'assistant',
      session_id: 's1',
      message: {
        id: 'm1',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'ExitPlanMode', input: { plan: 'x' } }],
      },
    };
    engine.handle('s1', ev);
    expect(out[0].kind).toBe('plan-ready');
  });

  it('does not fire on plain assistant text', () => {
    const engine = new NotificationEngine();
    const out: Notification[] = [];
    engine.on('notification', (n) => out.push(n));
    engine.handle('s1', {
      type: 'assistant',
      session_id: 's1',
      message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    });
    expect(out).toHaveLength(0);
  });
});
