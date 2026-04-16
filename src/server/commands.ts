import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export type CommandSource = 'builtin' | 'user' | 'plugin';
export type CommandKind = 'command' | 'skill';

export interface CommandEntry {
  name: string;          // e.g. "superpowers:brainstorming" or "ask" or "help"
  description: string;
  source: CommandSource;
  kind: CommandKind;
  plugin?: string;       // plugin name when source === 'plugin'
}

// Best-effort list of Claude Code's built-in slash commands. The CLI doesn't expose
// these on disk, so we maintain a curated set; the user can still type any command.
const BUILTINS: CommandEntry[] = [
  ['help', 'Show help'],
  ['clear', 'Clear conversation history and free context'],
  ['compact', 'Compact prior messages to free context'],
  ['cost', 'Show session token cost'],
  ['model', 'Switch model'],
  ['resume', 'Resume a previous session'],
  ['init', 'Initialize CLAUDE.md for this project'],
  ['memory', 'Manage Claude memory files'],
  ['agents', 'Manage subagents'],
  ['mcp', 'Manage MCP servers'],
  ['config', 'Edit settings'],
  ['status', 'Show session status'],
  ['doctor', 'Run diagnostics'],
  ['bug', 'Report a bug'],
  ['pr-comments', 'View PR comments'],
  ['review', 'Run a code review'],
  ['add-dir', 'Add a directory to the workspace'],
  ['export', 'Export the conversation'],
  ['diff', 'Show working tree diff'],
  ['vim', 'Toggle vim keybindings'],
  ['ide', 'IDE integration'],
  ['login', 'Log in to Claude'],
  ['logout', 'Log out of Claude'],
  ['skills', 'List available skills'],
  ['fast', 'Toggle fast mode'],
].map(([name, description]) => ({ name, description, source: 'builtin' as const, kind: 'command' as const }));

interface Frontmatter { name?: string; description?: string }

function parseFrontmatter(text: string): Frontmatter {
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end < 0) return {};
  const body = text.slice(3, end);
  const out: Frontmatter = {};
  // Only need name/description; values may be quoted, possibly across lines is rare here so single-line only.
  for (const line of body.split('\n')) {
    const m = line.match(/^(name|description)\s*:\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    (out as Record<string, string>)[m[1]] = val;
  }
  return out;
}

async function safeReaddir(dir: string): Promise<string[]> {
  try { return await fs.readdir(dir); } catch { return []; }
}

async function readFm(file: string): Promise<Frontmatter> {
  try {
    const buf = await fs.readFile(file, 'utf8');
    return parseFrontmatter(buf.slice(0, 4096));
  } catch { return {}; }
}

async function scanUserCommands(home: string): Promise<CommandEntry[]> {
  const dir = path.join(home, '.claude', 'commands');
  const files = (await safeReaddir(dir)).filter((f) => f.endsWith('.md'));
  return Promise.all(files.map(async (f) => {
    const fm = await readFm(path.join(dir, f));
    return {
      name: fm.name ?? f.replace(/\.md$/, ''),
      description: fm.description ?? '',
      source: 'user' as const,
      kind: 'command' as const,
    };
  }));
}

async function scanUserSkills(home: string): Promise<CommandEntry[]> {
  const dir = path.join(home, '.claude', 'skills');
  const subs = await safeReaddir(dir);
  const entries = await Promise.all(subs.map(async (sub): Promise<CommandEntry | null> => {
    const skillFile = path.join(dir, sub, 'SKILL.md');
    const fm = await readFm(skillFile);
    if (!fm.name && !fm.description) return null;
    return {
      name: fm.name ?? sub,
      description: fm.description ?? '',
      source: 'user',
      kind: 'skill',
    };
  }));
  return entries.filter((e): e is CommandEntry => e !== null);
}

async function scanPlugins(home: string): Promise<CommandEntry[]> {
  // Layout: ~/.claude/plugins/cache/<repo>/<plugin>/<version>/{commands,skills}/...
  const root = path.join(home, '.claude', 'plugins', 'cache');
  const out: CommandEntry[] = [];
  const repos = await safeReaddir(root);
  await Promise.all(repos.map(async (repo) => {
    const repoDir = path.join(root, repo);
    const plugins = await safeReaddir(repoDir);
    await Promise.all(plugins.map(async (plugin) => {
      const versions = await safeReaddir(path.join(repoDir, plugin));
      // Pick the lexicographically last version (rough proxy for newest semver).
      const version = versions.sort().pop();
      if (!version) return;
      const base = path.join(repoDir, plugin, version);

      const commandsDir = path.join(base, 'commands');
      for (const f of (await safeReaddir(commandsDir)).filter((x) => x.endsWith('.md'))) {
        const fm = await readFm(path.join(commandsDir, f));
        const local = fm.name ?? f.replace(/\.md$/, '');
        out.push({
          name: `${plugin}:${local}`,
          description: fm.description ?? '',
          source: 'plugin',
          kind: 'command',
          plugin,
        });
      }

      const skillsDir = path.join(base, 'skills');
      for (const sub of await safeReaddir(skillsDir)) {
        const fm = await readFm(path.join(skillsDir, sub, 'SKILL.md'));
        if (!fm.name && !fm.description) continue;
        out.push({
          name: `${plugin}:${fm.name ?? sub}`,
          description: fm.description ?? '',
          source: 'plugin',
          kind: 'skill',
          plugin,
        });
      }
    }));
  }));
  return out;
}

export interface CommandCatalog { entries: CommandEntry[]; cachedAt: number }

let cache: CommandCatalog | null = null;
const TTL_MS = 30_000;

export async function getCommands(): Promise<CommandCatalog> {
  if (cache && Date.now() - cache.cachedAt < TTL_MS) return cache;
  const home = os.homedir();
  const [userCmds, userSkills, plugins] = await Promise.all([
    scanUserCommands(home),
    scanUserSkills(home),
    scanPlugins(home),
  ]);
  // Dedup by name; keep first-seen (built-ins win over plugin shadows).
  const seen = new Set<string>();
  const all = [...BUILTINS, ...userCmds, ...userSkills, ...plugins].filter((e) => {
    if (seen.has(e.name)) return false;
    seen.add(e.name);
    return true;
  });
  cache = { entries: all, cachedAt: Date.now() };
  return cache;
}
