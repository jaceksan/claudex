# Claudex Multi-Session Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a 24h hackathon MVP: web app that launches and monitors multiple Claude Code sessions with rich per-session view, OS notifications, and detach/reattach.

**Architecture:** One Node/TS process. Fastify HTTP + WebSocket server spawns `claude` subprocesses with stream-json I/O, parses JSONL events, fans them out to a React SPA over WebSocket. SQLite stores session metadata; Claude's own transcript files provide historical replay.

**Tech Stack:** Node 20+, TypeScript, Fastify, `@fastify/websocket`, `better-sqlite3`, Vitest. Frontend: Vite, React 18, Tailwind, `react-markdown` + `rehype-highlight`, `react-diff-viewer-continued`, `@tanstack/react-virtual`, `xterm.js`, `wouter` (tiny router).

**Plan style:** Phases 0–8 (backend) are TDD-detailed with exact code. Phases 9–15 (frontend + polish) are milestone-style with acceptance criteria and key code sketches.

---

## Repository Layout

```
claudex/
├── package.json
├── tsconfig.json
├── tsconfig.server.json
├── tsconfig.web.json
├── vite.config.ts
├── vitest.config.ts
├── src/
│   ├── server/
│   │   ├── index.ts              # entrypoint
│   │   ├── stream-json/
│   │   │   ├── types.ts          # event types
│   │   │   └── parser.ts         # line→event parser
│   │   ├── session/
│   │   │   ├── state.ts          # reducer
│   │   │   ├── process.ts        # SessionProcess
│   │   │   ├── manager.ts        # SessionManager
│   │   │   └── transcript.ts     # TranscriptReader
│   │   ├── ws/
│   │   │   ├── hub.ts            # WsHub
│   │   │   └── envelope.ts       # WS message types
│   │   ├── db.ts                 # SQLite wrapper
│   │   └── notifications.ts      # NotificationEngine
│   └── web/
│       ├── index.html
│       ├── main.tsx
│       ├── app.tsx
│       ├── pages/
│       │   ├── dashboard.tsx
│       │   └── session.tsx
│       ├── components/
│       │   ├── launcher.tsx
│       │   ├── event-view.tsx
│       │   ├── bash-pane.tsx
│       │   └── composer.tsx
│       ├── hooks/
│       │   ├── use-ws.ts
│       │   └── use-notifications.ts
│       └── lib/
│           └── shared-types.ts   # re-export server envelope types
└── tests/
    ├── fixtures/
    │   ├── simple-chat.jsonl
    │   ├── tool-heavy.jsonl
    │   ├── plan-mode.jsonl
    │   └── error-result.jsonl
    ├── stream-json.test.ts
    ├── state.test.ts
    ├── notifications.test.ts
    └── integration.test.ts
```

---

## Phase 0: Project Setup

### Task 0.1: Initialize package and TypeScript

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.server.json`, `tsconfig.web.json`, `.gitignore`, `.nvmrc`

- [ ] **Step 1: Create `.nvmrc`**

```
20
```

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "claudex",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "dev:server": "tsx watch src/server/index.ts",
    "dev:web": "vite",
    "dev": "npm-run-all -p dev:server dev:web",
    "build:server": "tsc -p tsconfig.server.json",
    "build:web": "vite build",
    "build": "npm-run-all build:server build:web",
    "start": "node dist/server/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -p tsconfig.server.json --noEmit && tsc -p tsconfig.web.json --noEmit"
  },
  "dependencies": {
    "fastify": "^4.28.0",
    "@fastify/websocket": "^10.0.1",
    "@fastify/static": "^7.0.4",
    "better-sqlite3": "^11.3.0",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/node": "^20.12.0",
    "@types/better-sqlite3": "^7.6.11",
    "@types/ws": "^8.5.12",
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "typescript": "^5.5.3",
    "tsx": "^4.16.2",
    "vite": "^5.3.4",
    "vitest": "^2.0.3",
    "npm-run-all": "^4.1.5"
  }
}
```

- [ ] **Step 3: Create `tsconfig.json` (base)**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noImplicitAny": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  }
}
```

- [ ] **Step 4: Create `tsconfig.server.json`**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "dist/server",
    "rootDir": "src/server",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "types": ["node"]
  },
  "include": ["src/server/**/*"]
}
```

- [ ] **Step 5: Create `tsconfig.web.json`**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vite/client"]
  },
  "include": ["src/web/**/*"]
}
```

- [ ] **Step 6: Create `.gitignore`**

```
node_modules
dist
.env
*.log
.vite
coverage
```

- [ ] **Step 7: Install and verify**

Run: `npm install && npx tsc -p tsconfig.server.json --noEmit`
Expected: installs cleanly, typecheck passes (no source yet → vacuously passes).

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig*.json .gitignore .nvmrc
git commit -m "chore: initialize Node/TS project"
```

### Task 0.2: Configure Vitest and Vite

**Files:**
- Create: `vitest.config.ts`, `vite.config.ts`

- [ ] **Step 1: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 2: Create `vite.config.ts`**

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: path.resolve(__dirname, 'src/web'),
  build: { outDir: path.resolve(__dirname, 'dist/web'), emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:7878',
      '/ws': { target: 'ws://localhost:7878', ws: true },
    },
  },
  plugins: [react()],
});
```

- [ ] **Step 3: Verify Vitest starts**

Run: `npx vitest run`
Expected: "No test files found" — passes.

- [ ] **Step 4: Commit**

```bash
git add vitest.config.ts vite.config.ts
git commit -m "chore: configure Vitest and Vite"
```

---

## Phase 1: Stream-JSON Types and Parser

### Task 1.1: Define stream-json event types

**Files:**
- Create: `src/server/stream-json/types.ts`

- [ ] **Step 1: Write the types**

```ts
// Mirrors Claude Code CLI stream-json output. Kept minimal; extend as needed.

export interface SystemInitEvent {
  type: 'system';
  subtype: 'init';
  session_id: string;
  cwd: string;
  model?: string;
  tools?: string[];
}

export interface AssistantEvent {
  type: 'assistant';
  message: {
    id: string;
    role: 'assistant';
    content: ContentBlock[];
    stop_reason?: string | null;
    usage?: Usage;
  };
  session_id: string;
}

export interface UserEvent {
  type: 'user';
  message: {
    role: 'user';
    content: string | ContentBlock[];
  };
  session_id?: string;
}

export interface ResultEvent {
  type: 'result';
  subtype: 'success' | 'error_max_turns' | 'error_during_execution';
  session_id: string;
  is_error: boolean;
  duration_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  result?: string;
}

export type StreamEvent =
  | SystemInitEvent
  | AssistantEvent
  | UserEvent
  | ResultEvent;

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/server/stream-json/types.ts
git commit -m "feat: add stream-json event types"
```

### Task 1.2: Capture real stream-json fixtures

**Files:**
- Create: `tests/fixtures/simple-chat.jsonl`, `tests/fixtures/tool-heavy.jsonl`, `tests/fixtures/plan-mode.jsonl`, `tests/fixtures/error-result.jsonl`

- [ ] **Step 1: Capture simple-chat fixture**

Run in a scratch directory:
```bash
claude -p "say hello in one word" --output-format stream-json --verbose \
  > tests/fixtures/simple-chat.jsonl
```

Expected: 3–5 JSONL lines ending with a `result` event.

- [ ] **Step 2: Capture tool-heavy fixture**

```bash
claude -p "list files in the current directory and show the first 5 lines of the largest one" \
  --output-format stream-json --verbose \
  > tests/fixtures/tool-heavy.jsonl
```

- [ ] **Step 3: Capture plan-mode fixture**

```bash
claude -p --permission-mode plan "plan how to add a /healthz endpoint" \
  --output-format stream-json --verbose \
  > tests/fixtures/plan-mode.jsonl
```

- [ ] **Step 4: Capture error-result fixture**

Trigger something that errors (e.g., force an invalid bash command by asking for one) or synthesize a minimal fixture:

```jsonl
{"type":"system","subtype":"init","session_id":"err-1","cwd":"/tmp"}
{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"false"}}]},"session_id":"err-1"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"exit code 1","is_error":true}]},"session_id":"err-1"}
{"type":"result","subtype":"error_during_execution","session_id":"err-1","is_error":true,"duration_ms":500}
```

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures
git commit -m "test: add stream-json fixtures"
```

### Task 1.3: Line-parser with failing test first

**Files:**
- Create: `tests/stream-json.test.ts`, `src/server/stream-json/parser.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/stream-json.test.ts
import { describe, it, expect } from 'vitest';
import { parseLine, parseBuffer } from '../src/server/stream-json/parser';

describe('parseLine', () => {
  it('parses a system init event', () => {
    const line = '{"type":"system","subtype":"init","session_id":"s1","cwd":"/tmp"}';
    const ev = parseLine(line);
    expect(ev).toMatchObject({ type: 'system', subtype: 'init', session_id: 's1' });
  });

  it('returns null for blank lines', () => {
    expect(parseLine('')).toBeNull();
    expect(parseLine('   ')).toBeNull();
  });

  it('throws ParseError on malformed JSON', () => {
    expect(() => parseLine('{not json')).toThrow(/parse/i);
  });
});

describe('parseBuffer', () => {
  it('splits a multi-line buffer into events, returning remainder', () => {
    const buf = '{"type":"system","subtype":"init","session_id":"s1","cwd":"/tmp"}\n{"type":"partial';
    const { events, remainder } = parseBuffer(buf);
    expect(events).toHaveLength(1);
    expect(remainder).toBe('{"type":"partial');
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run tests/stream-json.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement parser**

```ts
// src/server/stream-json/parser.ts
import type { StreamEvent } from './types.js';

export class ParseError extends Error {}

export function parseLine(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed) as StreamEvent;
  } catch (e) {
    throw new ParseError(`Failed to parse stream-json line: ${(e as Error).message}`);
  }
}

export interface BufferParseResult {
  events: StreamEvent[];
  remainder: string;
  errors: ParseError[];
}

export function parseBuffer(buf: string): BufferParseResult {
  const lines = buf.split('\n');
  const remainder = lines.pop() ?? '';
  const events: StreamEvent[] = [];
  const errors: ParseError[] = [];
  for (const line of lines) {
    try {
      const ev = parseLine(line);
      if (ev) events.push(ev);
    } catch (e) {
      if (e instanceof ParseError) errors.push(e);
      else throw e;
    }
  }
  return { events, remainder, errors };
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run tests/stream-json.test.ts`
Expected: PASS.

- [ ] **Step 5: Add fixture-driven test**

Append to `tests/stream-json.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('parseBuffer on fixtures', () => {
  it('parses simple-chat.jsonl fully', () => {
    const content = readFileSync(join(__dirname, 'fixtures/simple-chat.jsonl'), 'utf8');
    const { events, remainder, errors } = parseBuffer(content);
    expect(errors).toHaveLength(0);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].type).toBe('system');
    expect(events.at(-1)?.type).toBe('result');
    expect(remainder).toBe('');
  });
});
```

Run: `npx vitest run tests/stream-json.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/stream-json/parser.ts tests/stream-json.test.ts
git commit -m "feat: parse stream-json JSONL into events"
```

---

## Phase 2: SessionState Reducer

### Task 2.1: Define SessionState shape

**Files:**
- Create: `src/server/session/state.ts`
- Test: `tests/state.test.ts`

- [ ] **Step 1: Write failing test for initial state**

```ts
// tests/state.test.ts
import { describe, it, expect } from 'vitest';
import { initialState, reduce, type SessionState } from '../src/server/session/state';

describe('SessionState', () => {
  it('has a sensible initial state', () => {
    const s = initialState('sess-1', '/tmp');
    expect(s).toMatchObject({
      sessionId: 'sess-1',
      cwd: '/tmp',
      status: 'starting',
      lastAssistantText: '',
      currentTool: null,
      parseErrors: 0,
      tokens: { input: 0, output: 0 },
      costUsd: 0,
    });
    expect(s.lastActivityAt).toBeTypeOf('number');
  });
});
```

- [ ] **Step 2: Run test to verify fail**

Run: `npx vitest run tests/state.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement shape + initial state**

```ts
// src/server/session/state.ts
import type { StreamEvent } from '../stream-json/types.js';

export type SessionStatus =
  | 'starting'
  | 'running'
  | 'waiting-permission'
  | 'idle'
  | 'ended'
  | 'crashed'
  | 'detached';

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  startedAt: number;
}

export interface SessionState {
  sessionId: string;
  cwd: string;
  status: SessionStatus;
  lastAssistantText: string;
  currentTool: ToolCall | null;
  completedTools: number;
  parseErrors: number;
  tokens: { input: number; output: number };
  costUsd: number;
  lastActivityAt: number;
  planText: string | null;
  error: string | null;
}

export function initialState(sessionId: string, cwd: string): SessionState {
  return {
    sessionId,
    cwd,
    status: 'starting',
    lastAssistantText: '',
    currentTool: null,
    completedTools: 0,
    parseErrors: 0,
    tokens: { input: 0, output: 0 },
    costUsd: 0,
    lastActivityAt: Date.now(),
    planText: null,
    error: null,
  };
}

export function reduce(state: SessionState, event: StreamEvent): SessionState {
  return { ...state, lastActivityAt: Date.now() };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/session/state.ts tests/state.test.ts
git commit -m "feat: add SessionState initial shape"
```

### Task 2.2: Reducer handles system init + assistant text

- [ ] **Step 1: Add failing tests**

```ts
// append to tests/state.test.ts
describe('reduce', () => {
  it('system:init transitions to running and adopts session_id', () => {
    const s0 = initialState('pending', '/tmp');
    const s1 = reduce(s0, {
      type: 'system',
      subtype: 'init',
      session_id: 'real-id',
      cwd: '/tmp',
    });
    expect(s1.status).toBe('running');
    expect(s1.sessionId).toBe('real-id');
  });

  it('assistant text event updates lastAssistantText', () => {
    const s0 = { ...initialState('s', '/tmp'), status: 'running' as const };
    const s1 = reduce(s0, {
      type: 'assistant',
      session_id: 's',
      message: {
        id: 'm1',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello world' }],
      },
    });
    expect(s1.lastAssistantText).toBe('Hello world');
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `npx vitest run tests/state.test.ts`
Expected: FAIL.

- [ ] **Step 3: Extend reducer**

Replace body of `reduce` in `src/server/session/state.ts`:

```ts
export function reduce(state: SessionState, event: StreamEvent): SessionState {
  const base = { ...state, lastActivityAt: Date.now() };
  switch (event.type) {
    case 'system':
      if (event.subtype === 'init') {
        return { ...base, status: 'running', sessionId: event.session_id, cwd: event.cwd };
      }
      return base;

    case 'assistant': {
      let lastText = base.lastAssistantText;
      let currentTool = base.currentTool;
      let planText = base.planText;
      for (const block of event.message.content) {
        if (block.type === 'text') {
          lastText = block.text;
        } else if (block.type === 'tool_use') {
          currentTool = {
            id: block.id,
            name: block.name,
            input: block.input,
            startedAt: Date.now(),
          };
          if (block.name === 'ExitPlanMode') {
            planText = (block.input.plan as string) ?? '';
          }
        }
      }
      const usage = event.message.usage;
      const tokens = usage
        ? { input: base.tokens.input + usage.input_tokens, output: base.tokens.output + usage.output_tokens }
        : base.tokens;
      return { ...base, lastAssistantText: lastText, currentTool, planText, tokens };
    }

    default:
      return base;
  }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run tests/state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/session/state.ts tests/state.test.ts
git commit -m "feat: reducer handles system:init and assistant text"
```

### Task 2.3: Reducer handles tool_result and result

- [ ] **Step 1: Add failing tests**

```ts
// append to tests/state.test.ts
describe('reduce: tool_result and result', () => {
  it('user tool_result clears currentTool and increments completedTools', () => {
    const s0: SessionState = {
      ...initialState('s', '/tmp'),
      status: 'running',
      currentTool: { id: 't1', name: 'Bash', input: {}, startedAt: 0 },
    };
    const s1 = reduce(s0, {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
      },
    });
    expect(s1.currentTool).toBeNull();
    expect(s1.completedTools).toBe(1);
  });

  it('tool_result with is_error records error status', () => {
    const s0: SessionState = {
      ...initialState('s', '/tmp'),
      status: 'running',
      currentTool: { id: 't1', name: 'Bash', input: {}, startedAt: 0 },
    };
    const s1 = reduce(s0, {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }],
      },
    });
    expect(s1.error).toMatch(/boom/);
  });

  it('result event transitions to ended/crashed and sets cost', () => {
    const s0: SessionState = { ...initialState('s', '/tmp'), status: 'running' };
    const s1 = reduce(s0, {
      type: 'result',
      subtype: 'success',
      session_id: 's',
      is_error: false,
      duration_ms: 1000,
      total_cost_usd: 0.02,
    });
    expect(s1.status).toBe('ended');
    expect(s1.costUsd).toBe(0.02);

    const s2 = reduce(s0, {
      type: 'result',
      subtype: 'error_during_execution',
      session_id: 's',
      is_error: true,
    });
    expect(s2.status).toBe('crashed');
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `npx vitest run tests/state.test.ts`
Expected: FAIL.

- [ ] **Step 3: Extend reducer**

Add cases inside the `switch` in `src/server/session/state.ts`:

```ts
case 'user': {
  let currentTool = base.currentTool;
  let completedTools = base.completedTools;
  let error = base.error;
  const content = Array.isArray(event.message.content) ? event.message.content : [];
  for (const block of content) {
    if (typeof block !== 'object') continue;
    if (block.type === 'tool_result') {
      if (currentTool && currentTool.id === block.tool_use_id) {
        currentTool = null;
        completedTools += 1;
      }
      if (block.is_error) {
        const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
        error = text;
      }
    }
  }
  return { ...base, currentTool, completedTools, error };
}

case 'result': {
  return {
    ...base,
    status: event.is_error ? 'crashed' : 'ended',
    costUsd: event.total_cost_usd ?? base.costUsd,
  };
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run tests/state.test.ts`
Expected: PASS.

- [ ] **Step 5: Replay fixtures through reducer (regression)**

Append test:

```ts
describe('reduce: fixture replay', () => {
  it('simple-chat ends with status=ended and non-empty lastAssistantText', () => {
    const content = readFileSync(join(__dirname, 'fixtures/simple-chat.jsonl'), 'utf8');
    const { events } = parseBuffer(content);
    let s = initialState('pending', '/tmp');
    for (const ev of events) s = reduce(s, ev);
    expect(s.status).toBe('ended');
    expect(s.lastAssistantText.length).toBeGreaterThan(0);
  });

  it('plan-mode produces a non-null planText', () => {
    const content = readFileSync(join(__dirname, 'fixtures/plan-mode.jsonl'), 'utf8');
    const { events } = parseBuffer(content);
    let s = initialState('pending', '/tmp');
    for (const ev of events) s = reduce(s, ev);
    expect(s.planText).not.toBeNull();
  });

  it('error-result ends with status=crashed', () => {
    const content = readFileSync(join(__dirname, 'fixtures/error-result.jsonl'), 'utf8');
    const { events } = parseBuffer(content);
    let s = initialState('pending', '/tmp');
    for (const ev of events) s = reduce(s, ev);
    expect(s.status).toBe('crashed');
  });
});
```

Add the imports needed (`parseBuffer`) at the top of the test file.

Run: `npx vitest run tests/state.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/session/state.ts tests/state.test.ts
git commit -m "feat: reducer handles tool_result and result events"
```

---

## Phase 3: SessionProcess

### Task 3.1: SessionProcess wraps a claude subprocess

**Files:**
- Create: `src/server/session/process.ts`
- Test: `tests/session-process.test.ts` (uses a fake shell command as stand-in for `claude`)

- [ ] **Step 1: Write failing test using a shell stand-in**

```ts
// tests/session-process.test.ts
import { describe, it, expect, vi } from 'vitest';
import { SessionProcess } from '../src/server/session/process';
import { once } from 'node:events';

// Fake "claude" that just echoes two JSONL events then exits.
const FAKE_CMD = 'node';
const FAKE_ARGS = [
  '-e',
  `
  process.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:'fake-1',cwd:process.cwd()}) + '\\n');
  setTimeout(() => {
    process.stdout.write(JSON.stringify({type:'result',subtype:'success',session_id:'fake-1',is_error:false,total_cost_usd:0}) + '\\n');
    process.exit(0);
  }, 50);
  `,
];

describe('SessionProcess', () => {
  it('emits events and exits', async () => {
    const proc = new SessionProcess({
      cwd: process.cwd(),
      command: FAKE_CMD,
      args: FAKE_ARGS,
    });
    const events: unknown[] = [];
    proc.on('event', (ev) => events.push(ev));
    proc.start();
    await once(proc, 'exit');
    expect(events.map((e: any) => e.type)).toEqual(['system', 'result']);
  });

  it('sendUserMessage writes a stream-json line to stdin', async () => {
    const sink = 'node';
    const args = [
      '-e',
      `let d=''; process.stdin.on('data', c => d += c);
       process.stdin.on('end', () => { process.stdout.write(d); process.exit(0); });`,
    ];
    const proc = new SessionProcess({ cwd: process.cwd(), command: sink, args });
    let captured = '';
    proc.on('stdoutRaw', (chunk) => (captured += chunk));
    proc.start();
    proc.sendUserMessage('hello');
    proc.closeStdin();
    await once(proc, 'exit');
    const parsed = JSON.parse(captured.trim());
    expect(parsed).toMatchObject({ type: 'user', message: { role: 'user' } });
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `npx vitest run tests/session-process.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `SessionProcess`**

```ts
// src/server/session/process.ts
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { parseBuffer } from '../stream-json/parser.js';
import type { StreamEvent } from '../stream-json/types.js';

export interface SessionProcessOptions {
  cwd: string;
  command?: string;            // override for tests; defaults to 'claude'
  args?: string[];             // override; defaults to stream-json flags + prompt
  prompt?: string;
  permissionMode?: string;
  resumeSessionId?: string;
  env?: NodeJS.ProcessEnv;
}

type Events = {
  event: (ev: StreamEvent) => void;
  parseError: (message: string) => void;
  stderr: (chunk: string) => void;
  stdoutRaw: (chunk: string) => void;
  exit: (code: number | null, signal: NodeJS.Signals | null) => void;
  error: (err: Error) => void;
};

export class SessionProcess extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private stderrTail: string[] = [];
  private readonly maxStderrLines = 200;

  constructor(private readonly opts: SessionProcessOptions) {
    super();
  }

  start(): void {
    const command = this.opts.command ?? 'claude';
    const args = this.opts.args ?? this.buildDefaultArgs();
    this.child = spawn(command, args, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...this.opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');

    this.child.stdout.on('data', (chunk: string) => {
      this.emit('stdoutRaw', chunk);
      this.buffer += chunk;
      const { events, remainder, errors } = parseBuffer(this.buffer);
      this.buffer = remainder;
      for (const ev of events) this.emit('event', ev);
      for (const err of errors) this.emit('parseError', err.message);
    });

    this.child.stderr.on('data', (chunk: string) => {
      this.emit('stderr', chunk);
      for (const line of chunk.split('\n')) {
        if (line.length > 0) {
          this.stderrTail.push(line);
          if (this.stderrTail.length > this.maxStderrLines) this.stderrTail.shift();
        }
      }
    });

    this.child.on('error', (err) => this.emit('error', err));
    this.child.on('exit', (code, signal) => this.emit('exit', code, signal));
  }

  sendUserMessage(text: string): void {
    if (!this.child) throw new Error('SessionProcess not started');
    const envelope = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    };
    this.child.stdin.write(JSON.stringify(envelope) + '\n');
  }

  closeStdin(): void {
    this.child?.stdin.end();
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.child?.kill(signal);
  }

  getStderrTail(): string {
    return this.stderrTail.join('\n');
  }

  private buildDefaultArgs(): string[] {
    const args = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose'];
    if (this.opts.permissionMode) args.push('--permission-mode', this.opts.permissionMode);
    if (this.opts.resumeSessionId) args.push('--resume', this.opts.resumeSessionId);
    if (this.opts.prompt) args.push(this.opts.prompt);
    return args;
  }
}

export interface SessionProcess {
  on<K extends keyof Events>(event: K, listener: Events[K]): this;
  emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): boolean;
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run tests/session-process.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/session/process.ts tests/session-process.test.ts
git commit -m "feat: SessionProcess subprocess wrapper with JSONL parsing"
```

---

## Phase 4: SessionManager

### Task 4.1: In-memory SessionManager

**Files:**
- Create: `src/server/session/manager.ts`
- Test: `tests/session-manager.test.ts`

- [ ] **Step 1: Failing test**

```ts
// tests/session-manager.test.ts
import { describe, it, expect } from 'vitest';
import { SessionManager } from '../src/server/session/manager';
import { once } from 'node:events';

const FAKE_CMD = 'node';
const FAKE_ARGS = [
  '-e',
  `process.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:'mgr-1',cwd:process.cwd()}) + '\\n');
   setTimeout(() => {
     process.stdout.write(JSON.stringify({type:'result',subtype:'success',session_id:'mgr-1',is_error:false,total_cost_usd:0}) + '\\n');
     process.exit(0);
   }, 50);`,
];

describe('SessionManager', () => {
  it('creates a session, tracks state, and cleans up on exit', async () => {
    const mgr = new SessionManager({ spawnOverride: () => ({ command: FAKE_CMD, args: FAKE_ARGS }) });
    const s = mgr.create({ cwd: process.cwd() });
    expect(s.state.status).toBe('starting');
    await once(s, 'ended');
    expect(s.state.status).toBe('ended');
    expect(s.state.sessionId).toBe('mgr-1');
    expect(mgr.list()).toHaveLength(1); // kept after exit
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `npx vitest run tests/session-manager.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/server/session/manager.ts
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { SessionProcess, type SessionProcessOptions } from './process.js';
import { initialState, reduce, type SessionState } from './state.js';
import type { StreamEvent } from '../stream-json/types.js';

export interface SessionHandle extends EventEmitter {
  id: string;
  state: SessionState;
  readonly eventLog: StreamEvent[]; // ring buffer
  process: SessionProcess;
  send(text: string): void;
  kill(): void;
}

export interface CreateSessionOpts {
  cwd: string;
  prompt?: string;
  permissionMode?: string;
  label?: string;
}

type SpawnOverride = (opts: CreateSessionOpts) => { command?: string; args?: string[] };

export interface SessionManagerOpts {
  spawnOverride?: SpawnOverride;
  ringSize?: number;
}

export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, SessionHandle>();
  constructor(private readonly opts: SessionManagerOpts = {}) { super(); }

  list(): SessionHandle[] {
    return [...this.sessions.values()];
  }

  get(id: string): SessionHandle | undefined {
    return this.sessions.get(id);
  }

  create(opts: CreateSessionOpts): SessionHandle {
    const localId = randomUUID(); // placeholder until system:init provides real id
    const ring: StreamEvent[] = [];
    const ringSize = this.opts.ringSize ?? 500;
    const processOpts: SessionProcessOptions = {
      cwd: opts.cwd,
      prompt: opts.prompt,
      permissionMode: opts.permissionMode,
      ...this.opts.spawnOverride?.(opts),
    };
    const proc = new SessionProcess(processOpts);
    const handle = Object.assign(new EventEmitter(), {
      id: localId,
      state: initialState(localId, opts.cwd),
      eventLog: ring,
      process: proc,
      send(text: string) { proc.sendUserMessage(text); },
      kill() { proc.kill(); },
    }) as SessionHandle;

    proc.on('event', (ev) => {
      handle.state = reduce(handle.state, ev);
      ring.push(ev);
      if (ring.length > ringSize) ring.shift();
      if (ev.type === 'system' && ev.subtype === 'init') {
        const realId = ev.session_id;
        if (realId !== handle.id) {
          this.sessions.delete(handle.id);
          handle.id = realId;
          this.sessions.set(realId, handle);
        }
      }
      handle.emit('event', ev);
      this.emit('event', handle, ev);
    });
    proc.on('parseError', () => {
      handle.state = { ...handle.state, parseErrors: handle.state.parseErrors + 1 };
      handle.emit('stateChange', handle.state);
    });
    proc.on('exit', (code) => {
      if (handle.state.status !== 'ended' && handle.state.status !== 'crashed') {
        handle.state = {
          ...handle.state,
          status: code === 0 ? 'ended' : 'crashed',
          error: code === 0 ? null : proc.getStderrTail(),
        };
      }
      handle.emit('ended', handle.state);
      this.emit('ended', handle);
    });
    proc.on('error', (err) => {
      handle.state = { ...handle.state, status: 'crashed', error: err.message };
      handle.emit('ended', handle.state);
    });

    this.sessions.set(localId, handle);
    proc.start();
    this.emit('created', handle);
    return handle;
  }

  kill(id: string): void {
    this.sessions.get(id)?.kill();
  }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run tests/session-manager.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/session/manager.ts tests/session-manager.test.ts
git commit -m "feat: SessionManager owns lifecycle, reducer, ring buffer"
```

---

## Phase 5: SQLite Metadata

### Task 5.1: Db wrapper

**Files:**
- Create: `src/server/db.ts`
- Test: `tests/db.test.ts`

- [ ] **Step 1: Failing test**

```ts
// tests/db.test.ts
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
```

- [ ] **Step 2: Run, expect fail**

Run: `npx vitest run tests/db.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/server/db.ts
import Database from 'better-sqlite3';

export interface SessionRow {
  id: string;
  cwd: string;
  label: string | null;
  status: string;
  created_at: number;
  ended_at: number | null;
  last_event_at: number;
  error: string | null;
}

export class Db {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        label TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        ended_at INTEGER,
        last_event_at INTEGER NOT NULL,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS prefs (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  upsertSession(row: { id: string; cwd: string; label: string | null; status: string; error?: string | null }): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO sessions (id, cwd, label, status, created_at, last_event_at, error)
      VALUES (@id, @cwd, @label, @status, @now, @now, @error)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        label = COALESCE(excluded.label, sessions.label),
        last_event_at = excluded.last_event_at,
        error = COALESCE(excluded.error, sessions.error),
        ended_at = CASE WHEN excluded.status IN ('ended','crashed') THEN excluded.last_event_at ELSE sessions.ended_at END
    `).run({ ...row, now, error: row.error ?? null });
  }

  listSessions(): SessionRow[] {
    return this.db.prepare('SELECT * FROM sessions ORDER BY last_event_at DESC').all() as SessionRow[];
  }

  markAllDetached(): void {
    this.db.prepare(`UPDATE sessions SET status='detached' WHERE status NOT IN ('ended','crashed','detached')`).run();
  }

  setPref(key: string, value: string): void {
    this.db.prepare(`INSERT INTO prefs(key,value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .run(key, value);
  }

  getPref(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM prefs WHERE key=?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run tests/db.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/db.ts tests/db.test.ts
git commit -m "feat: SQLite Db wrapper for session metadata and prefs"
```

---

## Phase 6: NotificationEngine

### Task 6.1: Rule-based notifications

**Files:**
- Create: `src/server/notifications.ts`
- Test: `tests/notifications.test.ts`

- [ ] **Step 1: Failing test**

```ts
// tests/notifications.test.ts
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
```

- [ ] **Step 2: Run, expect fail**

Run: `npx vitest run tests/notifications.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/server/notifications.ts
import { EventEmitter } from 'node:events';
import type { StreamEvent } from './stream-json/types.js';

export type NotificationKind = 'session-ended' | 'tool-error' | 'plan-ready' | 'permission-pending';

export interface Notification {
  sessionId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  timestamp: number;
}

export class NotificationEngine extends EventEmitter {
  handle(sessionId: string, event: StreamEvent): void {
    const ts = Date.now();
    if (event.type === 'result') {
      this.emit('notification', {
        sessionId, timestamp: ts, kind: 'session-ended',
        title: event.is_error ? 'Session crashed' : 'Session finished',
        body: `${sessionId.slice(0, 8)} · ${event.subtype}`,
      } satisfies Notification);
      return;
    }

    if (event.type === 'user') {
      const content = Array.isArray(event.message.content) ? event.message.content : [];
      for (const block of content) {
        if (typeof block === 'object' && block.type === 'tool_result' && block.is_error) {
          this.emit('notification', {
            sessionId, timestamp: ts, kind: 'tool-error',
            title: 'Tool error', body: String(block.content).slice(0, 200),
          } satisfies Notification);
          return;
        }
      }
    }

    if (event.type === 'assistant') {
      for (const block of event.message.content) {
        if (block.type === 'tool_use' && block.name === 'ExitPlanMode') {
          this.emit('notification', {
            sessionId, timestamp: ts, kind: 'plan-ready',
            title: 'Plan ready for review', body: sessionId.slice(0, 8),
          } satisfies Notification);
          return;
        }
      }
    }
  }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run tests/notifications.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/notifications.ts tests/notifications.test.ts
git commit -m "feat: rule-based NotificationEngine"
```

---

## Phase 7: WsHub + Fastify Server

### Task 7.1: WS envelope types

**Files:**
- Create: `src/server/ws/envelope.ts`

- [ ] **Step 1: Define envelopes**

```ts
// src/server/ws/envelope.ts
import type { StreamEvent } from '../stream-json/types.js';
import type { SessionState } from '../session/state.js';
import type { Notification } from '../notifications.js';

export type ServerEnvelope =
  | { type: 'session.created'; payload: { state: SessionState } }
  | { type: 'session.updated'; payload: { state: SessionState } }
  | { type: 'session.event';   payload: { sessionId: string; event: StreamEvent } }
  | { type: 'session.ended';   payload: { state: SessionState } }
  | { type: 'session.list';    payload: { sessions: SessionState[] } }
  | { type: 'notification';    payload: Notification }
  | { type: 'error';           payload: { message: string; requestId?: string } };

export type ClientEnvelope =
  | { type: 'client.subscribe';   payload: { sessionId: string }; requestId?: string }
  | { type: 'client.unsubscribe'; payload: { sessionId: string }; requestId?: string }
  | { type: 'client.launch';      payload: { cwd: string; prompt?: string; permissionMode?: string; label?: string }; requestId?: string }
  | { type: 'client.sendInput';   payload: { sessionId: string; text: string }; requestId?: string }
  | { type: 'client.kill';        payload: { sessionId: string }; requestId?: string }
  | { type: 'client.listSessions'; payload: {}; requestId?: string };
```

- [ ] **Step 2: Commit**

```bash
git add src/server/ws/envelope.ts
git commit -m "feat: WS envelope types"
```

### Task 7.2: WsHub wiring

**Files:**
- Create: `src/server/ws/hub.ts`

- [ ] **Step 1: Implement**

```ts
// src/server/ws/hub.ts
import type { WebSocket } from 'ws';
import type { SessionManager } from '../session/manager.js';
import type { NotificationEngine } from '../notifications.js';
import type { Db } from '../db.js';
import type { ClientEnvelope, ServerEnvelope } from './envelope.js';

export class WsHub {
  private readonly clients = new Set<WebSocket>();
  private readonly subs = new Map<WebSocket, Set<string>>(); // ws -> sessionIds

  constructor(
    private readonly manager: SessionManager,
    private readonly notifications: NotificationEngine,
    private readonly db: Db,
  ) {
    manager.on('created', (h) => this.broadcast({ type: 'session.created', payload: { state: h.state } }));
    manager.on('event', (h, ev) => {
      this.db.upsertSession({ id: h.id, cwd: h.state.cwd, label: null, status: h.state.status });
      this.sendToSubscribers(h.id, { type: 'session.event', payload: { sessionId: h.id, event: ev } });
      this.broadcast({ type: 'session.updated', payload: { state: h.state } });
      notifications.handle(h.id, ev);
    });
    manager.on('ended', (h) => {
      this.db.upsertSession({ id: h.id, cwd: h.state.cwd, label: null, status: h.state.status, error: h.state.error });
      this.broadcast({ type: 'session.ended', payload: { state: h.state } });
    });
    notifications.on('notification', (n) => this.broadcast({ type: 'notification', payload: n }));
  }

  attach(ws: WebSocket): void {
    this.clients.add(ws);
    this.subs.set(ws, new Set());
    ws.on('message', (raw) => this.onMessage(ws, raw.toString()));
    ws.on('close', () => { this.clients.delete(ws); this.subs.delete(ws); });
  }

  private onMessage(ws: WebSocket, raw: string): void {
    let env: ClientEnvelope;
    try { env = JSON.parse(raw) as ClientEnvelope; }
    catch { return this.sendError(ws, 'invalid JSON'); }
    try {
      switch (env.type) {
        case 'client.listSessions':
          this.send(ws, { type: 'session.list', payload: { sessions: this.manager.list().map((h) => h.state) } });
          break;
        case 'client.subscribe':
          this.subs.get(ws)?.add(env.payload.sessionId);
          break;
        case 'client.unsubscribe':
          this.subs.get(ws)?.delete(env.payload.sessionId);
          break;
        case 'client.launch': {
          const h = this.manager.create(env.payload);
          this.send(ws, { type: 'session.created', payload: { state: h.state } });
          break;
        }
        case 'client.sendInput': {
          const h = this.manager.get(env.payload.sessionId);
          if (!h) return this.sendError(ws, 'no such session', env.requestId);
          h.send(env.payload.text);
          break;
        }
        case 'client.kill':
          this.manager.kill(env.payload.sessionId);
          break;
      }
    } catch (e) {
      this.sendError(ws, (e as Error).message, env.requestId);
    }
  }

  private send(ws: WebSocket, env: ServerEnvelope): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(env));
  }

  private sendError(ws: WebSocket, message: string, requestId?: string): void {
    this.send(ws, { type: 'error', payload: { message, requestId } });
  }

  private broadcast(env: ServerEnvelope): void {
    for (const ws of this.clients) this.send(ws, env);
  }

  private sendToSubscribers(sessionId: string, env: ServerEnvelope): void {
    for (const [ws, ids] of this.subs) if (ids.has(sessionId)) this.send(ws, env);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/server/ws/hub.ts
git commit -m "feat: WsHub fans out events and handles client messages"
```

### Task 7.3: Server entrypoint

**Files:**
- Create: `src/server/index.ts`

- [ ] **Step 1: Implement**

```ts
// src/server/index.ts
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionManager } from './session/manager.js';
import { NotificationEngine } from './notifications.js';
import { Db } from './db.js';
import { WsHub } from './ws/hub.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 7878);

const app = Fastify({ logger: true });
await app.register(fastifyWebsocket);

const dbPath = process.env.CLAUDEX_DB ?? path.join(process.env.HOME ?? '.', '.claudex.sqlite');
const db = new Db(dbPath);
db.markAllDetached();

const manager = new SessionManager();
const notifications = new NotificationEngine();
const hub = new WsHub(manager, notifications, db);

app.get('/ws', { websocket: true }, (conn) => hub.attach(conn.socket));

app.get('/api/health', async () => ({ ok: true }));

const webDist = path.resolve(__dirname, '../web');
try {
  await app.register(fastifyStatic, { root: webDist, prefix: '/' });
} catch { /* dev mode: Vite serves the frontend */ }

await app.listen({ host: '127.0.0.1', port: PORT });
app.log.info(`claudex listening on http://127.0.0.1:${PORT}`);
```

- [ ] **Step 2: Smoke test**

Run: `npm run dev:server`
In another terminal: `curl http://127.0.0.1:7878/api/health`
Expected: `{"ok":true}`.
Ctrl+C to stop.

- [ ] **Step 3: Commit**

```bash
git add src/server/index.ts
git commit -m "feat: Fastify entrypoint wiring WsHub, manager, notifications, db"
```

---

## Phase 8: Integration Smoke Test

### Task 8.1: Real `claude` smoke (skipped without API key)

**Files:**
- Create: `tests/integration.test.ts`

- [ ] **Step 1: Write test**

```ts
// tests/integration.test.ts
import { describe, it, expect } from 'vitest';
import { SessionManager } from '../src/server/session/manager';
import { once } from 'node:events';

const hasKey = !!process.env.ANTHROPIC_API_KEY;
const test = hasKey ? it : it.skip;

describe('integration: real claude', () => {
  test('spawns, runs a trivial prompt, ends cleanly', async () => {
    const mgr = new SessionManager();
    const h = mgr.create({ cwd: process.cwd(), prompt: 'say hello in one word' });
    await once(h, 'ended');
    expect(['ended', 'crashed']).toContain(h.state.status);
    expect(h.state.sessionId).not.toBe(h.state.cwd); // was replaced with real id
  }, 60_000);
});
```

- [ ] **Step 2: Run (with key) and commit**

Run: `ANTHROPIC_API_KEY=... npx vitest run tests/integration.test.ts`
Expected: PASS.

```bash
git add tests/integration.test.ts
git commit -m "test: integration smoke against real claude CLI"
```

---

## Phase 9: Frontend Scaffold (Milestone)

**Goal:** Get a styled React shell talking to the backend over WebSocket.

**Deliverables:**
- `src/web/index.html`, `src/web/main.tsx`, `src/web/app.tsx` rendering a layout with top bar + router.
- Install `react`, `react-dom`, `wouter`, `tailwindcss` + `postcss` + `autoprefixer`. Generate `tailwind.config.js` scanning `src/web/**/*.{ts,tsx,html}`.
- `src/web/hooks/use-ws.ts` — singleton WS client with reconnect, request/response helpers (`send(env)`, `subscribe(sessionId, handler)`), exposes a `useSessionList()` and `useSession(id)` hook.
- Route `/` → `DashboardPage`, `/session/:id` → `SessionPage`.

**Acceptance:**
- `npm run dev` opens `http://localhost:5173`, shows "No sessions" placeholder, browser console logs successful WS connection to `ws://localhost:7878/ws`.
- Backend logs show `client.listSessions` arriving.

**Key sketches:**

```tsx
// src/web/hooks/use-ws.ts (core idea)
type Listener = (env: ServerEnvelope) => void;
const listeners = new Set<Listener>();
let ws: WebSocket;
function connect() {
  ws = new WebSocket(`ws://${location.hostname}:${location.port}/ws`);
  ws.onmessage = (e) => {
    const env = JSON.parse(e.data) as ServerEnvelope;
    for (const l of listeners) l(env);
  };
  ws.onclose = () => setTimeout(connect, 1000);
}
connect();
export function useWs() { /* subscribe in useEffect, expose send */ }
```

**Commit:** `feat(web): scaffold React SPA with WS client and routing`.

---

## Phase 10: Dashboard Page (Milestone)

**Goal:** Live-updating list of sessions.

**Deliverables:**
- `src/web/pages/dashboard.tsx` subscribes to `session.created|updated|ended|list`, maintains a local `Map<id, SessionState>`.
- On mount sends `{type:'client.listSessions',payload:{}}`.
- Renders a CSS grid (`grid-cols-2 lg:grid-cols-3`) of session cards: status badge, cwd (truncated), last activity (`Intl.RelativeTimeFormat`), current tool name, cost, parseErrors warning if > 0.
- "New session" button opens `LauncherModal`.
- Empty state placeholder.

**Acceptance:** launching a session from the launcher causes a card to appear within ~100ms; status transitions (`starting → running → ended`) are visible without page refresh.

**Commit:** `feat(web): dashboard with live session cards`.

---

## Phase 11: Session Page + Rich Renderers (Milestone)

**Goal:** Rich per-session view showing activity, diffs, plans.

**Deliverables:**
- `src/web/pages/session.tsx` with header + activity log + bash pane layout (flex column, log scrollable, pane fixed-height bottom).
- On mount: `client.subscribe`, request backlog via `client.listSessions` or an added `client.getSession` to pull the current `state` + event log. (Simpler: extend server to push `session.replay` with the ring buffer on subscribe.)
- `src/web/components/event-view.tsx` — one component per event kind:
  - Assistant text block → `react-markdown` + `rehype-highlight`.
  - Tool use block `Edit`/`Write` → `react-diff-viewer-continued` reading `input.old_string`/`input.new_string` (for Edit) or `input.content` vs `""` (for Write).
  - Tool use block `ExitPlanMode` → plan card with its `input.plan` rendered in markdown.
  - Other tools → collapsible `<details>` with JSON.stringified input.
  - Tool result → collapsible output, red border if `is_error`.
- Virtualize list using `@tanstack/react-virtual` once length > 100.

**Acceptance:** on a replay of `tool-heavy.jsonl` transcribed into the live stream, diffs render, plans render, tool errors show a red border. Markdown code blocks are syntax-highlighted.

**Backend addition:** add a `session.replay` server envelope sent on `client.subscribe` carrying `{state, events: ring}`. Update `WsHub.subscribe` to send it. Add one unit test.

**Commit:** `feat(web): session page with rich event renderers`.

---

## Phase 12: Bash Terminal Pane (Milestone)

**Goal:** Render `Bash` tool output in xterm.js panes.

**Deliverables:**
- Install `xterm`, `@xterm/addon-fit`.
- `src/web/components/bash-pane.tsx` maintains an LRU map of `tool_use_id → xterm.Terminal`. Max 3 terminals, tabbed.
- When an assistant event introduces a `Bash` `tool_use`, create a terminal, write the command dim-styled at the top, show spinner.
- On corresponding `tool_result`, write the content. Respect `is_error` with red text.
- Clear buffer only on tab switch; keep history for each terminal until evicted.

**Acceptance:** running a session that executes 2 Bash commands shows both outputs in their own tabs, with command shown and result below.

**Commit:** `feat(web): xterm.js pane for Bash tool output`.

---

## Phase 13: Launcher + Composer (Milestone)

**Goal:** Start sessions and send follow-up messages from the UI.

**Deliverables:**
- `src/web/components/launcher.tsx` modal: cwd text input (with localStorage-backed recent list), prompt textarea (optional), permission-mode select (`default | plan | acceptEdits | bypassPermissions`), submit → `client.launch`.
- `src/web/components/composer.tsx` in `SessionPage` footer: textarea + Send button, disabled unless session is `idle` or `running`; sends `client.sendInput`.
- Keyboard: Cmd/Ctrl+Enter submits composer.

**Acceptance:** end-to-end — open app, click "New session" with cwd=/tmp and prompt="say hi", see card + session page come up, after it ends send a follow-up "now say bye" via composer and see a new exchange render.

**Commit:** `feat(web): launcher modal and message composer`.

---

## Phase 14: Notifications (Milestone)

**Goal:** OS notifications on attention-worthy events.

**Deliverables:**
- `src/web/hooks/use-notifications.ts`: on mount, calls `Notification.requestPermission()`. Subscribes to server `notification` envelopes. If granted, creates `new Notification(title, { body, tag: sessionId })`. Clicks focus the tab and navigate to `/session/:id`. If not granted, dispatch a toast through a simple in-app toaster.
- Persist a "do not disturb" toggle in SQLite via a new `client.setPref` envelope. (Optional for MVP.)

**Acceptance:** after granting permission, killing a tab and letting a session finish surfaces a native notification on Linux (libnotify-visible).

**Commit:** `feat(web): OS notifications on session events`.

---

## Phase 15: Detach / Reattach (Milestone)

**Goal:** Sessions survive app restarts for view + resume.

**Deliverables:**
- On server startup, already-marked `detached` rows show up in the dashboard with a greyed-out badge.
- Clicking a detached session calls a new `client.resume {sessionId}` envelope → server runs `claude --resume <sessionId>` in the original cwd using `SessionProcess({ resumeSessionId })`, then streams live.
- `TranscriptReader` (`src/server/session/transcript.ts`) reads `~/.claude/projects/<cwdHash>/<sessionId>.jsonl` line-by-line to rehydrate state before live events arrive. On success, state has correct `lastAssistantText`, `completedTools`, etc.
- `cwdHash` is the same hash Claude uses — replace `/` with `-` in the absolute cwd path (verify by inspecting `~/.claude/projects` directory names). If hash algorithm doesn't match, iterate over all directories and find the one containing `<sessionId>.jsonl`.

**Acceptance:** run a session, kill the Node server, restart it, click the detached session, see full history rehydrated; send a new user message and see it streamed live.

**Commit:** `feat: detach and resume sessions across restarts`.

---

## Phase 16: Polish + Demo Prep (30–60 min)

- [ ] Add a minimal README: `npm install && npm run dev`, port notes, API key requirement.
- [ ] Hot-key: `?` shows a shortcuts overlay.
- [ ] Favicon + tab title showing count of running sessions, e.g. `(2) Claudex`.
- [ ] `npm run build && npm start` works end-to-end serving the built SPA.
- [ ] Record a 30s screen capture for the demo.

---

## Post-Hackathon Phases (Not in 24h Scope)

- **Phase B.1:** Git worktree strategy per session. Add a `WorktreeManager` that creates `<cwd>/.claudex-worktrees/<shortId>` on a fresh branch at launch time; cleanup on session end.
- **Phase C:** Permission approval UI. Detect `waiting-permission` via hook-emitted marker events; render approve/deny modal; send back via a stream-json envelope or a side-channel `--permission-prompt-tool` MCP stub.
- **Phase 3 Slack:** `@slack/bolt` Socket Mode, separate `slackbot.ts` subscribing to the same `SessionManager` events; slash commands `/claudex list`, `/claudex new <cwd> <prompt>`, `/claudex reply <id> <msg>`.
- **Tauri packaging:** wrap for a native app with system tray.
- **Live Bash streaming:** add a `PreToolUse` hook on `Bash` that tees to a named pipe; backend tails the pipe and streams chunks to xterm.js in real time.

---

## Self-Review Results

- **Spec coverage:** All spec goals — multi-session launch (Phase 13), monitor (10), rich view (11), Bash pane (12), send input (13), detach/reattach (15), notifications (14) — have a task. Non-goals (permission UI, worktrees, Slack) are documented as post-hackathon. ✓
- **Placeholder scan:** No TBD/TODO; every backend step has complete code; every frontend milestone has acceptance criteria plus key sketches. ✓
- **Type consistency:** `SessionState.sessionId`, `SessionProcess.sendUserMessage`, `SessionManager.create`, `Db.upsertSession`, notification kinds all used consistently across phases. ✓
- **Known simplifications flagged inline:** Bash streaming (Phase 12 / 16), permission UI (Phase C), worktrees (Phase B.1), cwdHash algorithm (Phase 15 has a fallback).
