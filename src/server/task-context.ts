import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TaskStore } from './task.js';
import type { TopicStore } from './topic.js';
import type { RepoStore } from './repo.js';

const exec = promisify(execFile);

export interface TaskContext {
  topic: { id: string; title: string };
  task: { label: string | null; type: string; acceptedAt: number | null; discardedAt: number | null };
  branch: string;
  aheadTopic: number;       // commits on this attempt branch not yet on the topic branch
  aheadCanonical: number;   // commits on HEAD not on <canonical>/<defaultBranch>
  behindCanonical: number;  // commits on <canonical>/<defaultBranch> not on HEAD
}

async function count(cwd: string, range: string): Promise<number> {
  try {
    const { stdout } = await exec('git', ['rev-list', '--count', range], { cwd, timeout: 2000 });
    return Number(stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

export async function getTaskContext(
  stores: { tasks: TaskStore; topics: TopicStore; repos: RepoStore },
  sessionId: string,
  cwd: string,
): Promise<TaskContext | null> {
  const task = stores.tasks.getBySession(sessionId);
  if (!task) return null;
  const topic = stores.topics.getById(task.topicId);
  if (!topic) return null;
  const repo = stores.repos.getById(topic.repoId);
  if (!repo || !task.childBranch) return null;

  const topicBranch = topic.topicBranch ?? '';
  const canonicalRef = `${repo.canonicalRemote}/${repo.defaultBranch}`;

  const [aheadTopic, aheadCanonical, behindCanonical] = await Promise.all([
    topicBranch ? count(cwd, `${topicBranch}..HEAD`) : Promise.resolve(0),
    count(cwd, `${canonicalRef}..HEAD`),
    count(cwd, `HEAD..${canonicalRef}`),
  ]);

  return {
    topic: { id: topic.id, title: topic.title },
    task: { label: task.label, type: task.type, acceptedAt: task.acceptedAt, discardedAt: task.discardedAt },
    branch: task.childBranch,
    aheadTopic,
    aheadCanonical,
    behindCanonical,
  };
}
