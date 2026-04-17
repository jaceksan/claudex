import type Database from 'better-sqlite3';
import type { VcsAdapter } from './vcs/adapter.js';

export async function getOrFetchGithubLogin(db: Database.Database, adapter: VcsAdapter): Promise<string> {
  const row = db.prepare('SELECT github_login FROM user WHERE singleton=1').get() as { github_login: string | null } | undefined;
  if (row?.github_login) return row.github_login;
  const { login } = await adapter.getCurrentUser();
  db.prepare('INSERT INTO user (singleton, github_login) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET github_login=excluded.github_login').run(login);
  return login;
}

export function setGithubLogin(db: Database.Database, login: string): void {
  db.prepare('INSERT INTO user (singleton, github_login) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET github_login=excluded.github_login').run(login);
}
