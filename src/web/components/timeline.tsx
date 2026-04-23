import type { TopicDetailBundle, TaskRow } from '../../server/ws/topic-envelope';
import type { PR } from '../../server/vcs/adapter';

type TopicMeta = TopicDetailBundle['topic'];

interface Step {
  label: string;
  sublabel?: string;
  state: 'done' | 'current' | 'future' | 'cancelled';
}

function buildSteps(topic: TopicMeta, tasks: TaskRow[], pr: PR | undefined): Step[] {
  const phase = topic.phase;
  const attempts = tasks.filter((t) => t.type === 'attempt');
  const accepted = attempts.filter((t) => t.acceptedAt);
  const running = tasks.filter((t) => !t.acceptedAt && !t.discardedAt && t.sessionStatus === 'running');
  const fixTasks = tasks.filter((t) => t.type === 'fix-comments' || t.type === 'fix-ci');

  const steps: Step[] = [];

  // Draft step
  if (phase === 'Exploring') {
    steps.push({ label: 'Exploring', state: 'current' });
    steps.push({ label: 'Draft', state: 'future' });
    steps.push({ label: 'PR opened', state: 'future' });
    steps.push({ label: 'Merge', state: 'future' });
    return steps;
  }

  const draftDone = phase !== 'Draft' || (phase === 'Draft' && !!topic.acceptedAttemptId);
  const draftSubLabel = `${attempts.length} task${attempts.length !== 1 ? 's' : ''}${accepted.length ? `, ${accepted.length} accepted` : ''}`;
  steps.push({
    label: 'Draft',
    sublabel: draftSubLabel,
    state: draftDone ? 'done' : 'current',
  });

  // PR opened step
  if (phase === 'Draft') {
    steps.push({ label: 'PR opened', state: 'future' });
  } else {
    let reviewState: Step['state'];
    if (phase === 'Merged') reviewState = 'done';
    else if (phase === 'Closed') reviewState = 'cancelled';
    else reviewState = 'current'; // Open
    steps.push({
      label: 'Under review',
      sublabel: pr ? `PR #${pr.number}` : undefined,
      state: reviewState,
    });
  }

  // Fix tasks note under review
  if ((phase === 'Open') && fixTasks.length > 0) {
    const runningFix = fixTasks.filter((t) => t.sessionStatus === 'running');
    steps.push({
      label: `Fix tasks: ${fixTasks.length} total${runningFix.length ? `, ${runningFix.length} running` : ''}`,
      state: 'current',
    });
  }

  // Running tasks note
  if (running.length > 0) {
    steps.push({ label: `${running.length} task${running.length > 1 ? 's' : ''} running`, state: 'current' });
  }

  // Terminal step: Merge on happy path, Closed-without-merge on the cancelled path.
  if (phase === 'Closed') {
    steps.push({ label: 'PR closed without merging', state: 'cancelled' });
  } else {
    steps.push({ label: 'Merge', state: phase === 'Merged' ? 'done' : 'future' });
  }

  return steps;
}

function StepIcon({ state }: { state: Step['state'] }) {
  if (state === 'done') {
    return <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-700 text-xs text-white">✓</span>;
  }
  if (state === 'current') {
    return <span className="flex h-5 w-5 items-center justify-center rounded-full bg-blue-600 text-xs text-white">●</span>;
  }
  if (state === 'cancelled') {
    return <span className="flex h-5 w-5 items-center justify-center rounded-full bg-zinc-700 text-xs text-zinc-300">✕</span>;
  }
  return <span className="flex h-5 w-5 items-center justify-center rounded-full border border-zinc-700 text-xs text-zinc-600">○</span>;
}

export function Timeline({
  topic,
  tasks,
  pr,
}: {
  topic: TopicMeta;
  tasks: TaskRow[];
  pr: PR | undefined;
}) {
  const steps = buildSteps(topic, tasks, pr);

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">Timeline</h2>
      <ol className="flex flex-col gap-2">
        {steps.map((step, i) => (
          <li key={i} className="flex items-start gap-2">
            <StepIcon state={step.state} />
            <div>
              <div className={`text-sm ${step.state === 'future' ? 'text-zinc-500' : step.state === 'cancelled' ? 'text-zinc-400 line-through decoration-zinc-600' : 'text-zinc-100'}`}>
                {step.label}
              </div>
              {step.sublabel && (
                <div className="text-xs text-zinc-500">{step.sublabel}</div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
