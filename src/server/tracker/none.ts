import type { TrackerAdapter } from './adapter.js';

export class NoneAdapter implements TrackerAdapter {
  readonly kind = 'none' as const;
  async whoami() { return null; }
  async searchAssigned() { return []; }
  async searchRecent() { return []; }
  async getTicket() { return null; }
  async createTicket() { return null; }
  async postComment() { /* noop */ }
}
