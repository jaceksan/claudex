import type { TrackerAdapter } from './adapter';
import { NoneAdapter } from './none';

export type TrackerKind = 'jira' | 'youtrack' | 'linear' | 'none';

export function getTrackerAdapter(kind: TrackerKind): TrackerAdapter {
  switch (kind) {
    case 'none': return new NoneAdapter();
    default:
      // Phase 5 ships jira/youtrack/linear via MCP. For now fall back to None.
      return new NoneAdapter();
  }
}
