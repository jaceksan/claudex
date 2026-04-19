import type { TaskRow, TopicDetailBundle } from '../../server/ws/topic-envelope';
type Deliverable = TopicDetailBundle['deliverable'];
import type { PR, ReviewThread, Check } from '../../server/vcs/adapter';

type TopicMeta = TopicDetailBundle['topic'];

interface VisibleActions {
  createPr: boolean;
  createPrDisabledReason?: string;
  addressFeedback: boolean;
  merge: boolean;
  addAttempt: boolean;
}

function visibleActions(
  topic: TopicMeta,
  tasks: TaskRow[],
  pr: PR | undefined,
  threads: ReviewThread[] | undefined,
  checks: Check[] | undefined,
  required: string[] | undefined,
): VisibleActions {
  const phase = topic.phase;

  if (phase === 'Merged' || phase === 'Closed') {
    return { createPr: false, addressFeedback: false, merge: false, addAttempt: false };
  }

  const hasAcceptedAttempt = !!topic.acceptedAttemptId;
  const hasRunningTask = tasks.some(
    (t) => !t.acceptedAt && !t.discardedAt && t.sessionStatus === 'running',
  );

  const hasUnresolvedComments = (threads ?? []).some((t) => !t.isResolved &&
    t.comments.some((c) => !c.isBot));
  const hasFailingRequired = (checks ?? []).some(
    (c) => c.conclusion === 'failure' && (required ?? []).includes(c.name),
  );
  const allRequiredGreen = (required ?? []).length > 0 &&
    (checks ?? []).filter((c) => (required ?? []).includes(c.name)).every((c) => c.conclusion === 'success');
  const hasApprovals = pr ? pr.approvalsCount >= pr.requiredApprovals : false;

  if (phase === 'Exploring') {
    return { createPr: false, addressFeedback: false, merge: false, addAttempt: false };
  }

  if (phase === 'Draft') {
    const canCreate = hasAcceptedAttempt && !hasRunningTask;
    return {
      createPr: true,
      createPrDisabledReason: !hasAcceptedAttempt
        ? 'Accept a task first'
        : hasRunningTask
        ? 'Wait for running task'
        : undefined,
      addressFeedback: false,
      merge: false,
      addAttempt: !hasAcceptedAttempt,
    };
  }

  // Open phase
  const canMerge = allRequiredGreen && hasApprovals && !hasUnresolvedComments;
  return {
    createPr: false,
    addressFeedback: hasUnresolvedComments || hasFailingRequired,
    merge: canMerge,
    addAttempt: false,
  };
}

export function ActionBar({
  topic,
  tasks,
  pr,
  threads,
  checks,
  required,
  onCreatePR,
  onAddressFeedback,
  onAddAttempt,
  onPush,
  deliverable,
  deliverySessionStatus,
  creatingPR = false,
}: {
  topic: TopicMeta;
  tasks: TaskRow[];
  pr: PR | undefined;
  threads: ReviewThread[] | undefined;
  checks: Check[] | undefined;
  required: string[] | undefined;
  onCreatePR: (title?: string, body?: string) => void;
  onAddressFeedback: (includeCi: boolean, includeComments: boolean) => void;
  onAddAttempt: () => void;
  onPush: () => void;
  deliverable: Deliverable;
  deliverySessionStatus: string | null;
  creatingPR?: boolean;
}) {
  const actions = visibleActions(topic, tasks, pr, threads, checks, required);

  if (topic.phase === 'Merged' || topic.phase === 'Closed') {
    return (
      <div className="border-t border-zinc-800 bg-zinc-950 px-4 py-3 flex gap-3">
        <span className="text-xs text-zinc-500">Topic {topic.phase.toLowerCase()}.</span>
      </div>
    );
  }

  const hasUnresolvedComments = (threads ?? []).some((t) => !t.isResolved && t.comments.some((c) => !c.isBot));
  const hasFailingRequired = (checks ?? []).some(
    (c) => c.conclusion === 'failure' && (required ?? []).includes(c.name),
  );

  return (
    <div className="border-t border-zinc-800 bg-zinc-950 px-4 py-3 flex items-center gap-3 flex-wrap">
      {actions.createPr && (() => {
        const disabled = !!actions.createPrDisabledReason || creatingPR;
        const reason = creatingPR ? 'PR creation in progress — wait for Claude to finish' : actions.createPrDisabledReason;
        return (
          <button
            type="button"
            onClick={() => onCreatePR()}
            disabled={disabled}
            title={reason}
            className={`rounded px-3 py-1.5 text-sm font-medium ${
              disabled
                ? 'cursor-not-allowed bg-zinc-800 text-zinc-500'
                : 'bg-blue-600 text-white hover:bg-blue-500'
            }`}
          >
            {creatingPR ? 'Creating PR…' : 'Create PR'}
          </button>
        );
      })()}
      {actions.createPrDisabledReason && (
        <span className="text-xs text-zinc-500">{actions.createPrDisabledReason}</span>
      )}

      {actions.addressFeedback && (
        <button
          type="button"
          onClick={() => onAddressFeedback(hasFailingRequired, hasUnresolvedComments)}
          className="rounded bg-amber-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-600"
        >
          Address feedback
        </button>
      )}

      {actions.merge && (
        <button
          type="button"
          onClick={() => {
            // Merge calls pr-lifecycle mergePR — placeholder stub for Plan 4.
            alert('Merge: real action wired in Plan 4 (gh/glab adapter call).');
          }}
          className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-600"
        >
          Merge
        </button>
      )}

      {!actions.merge && topic.phase === 'Open' && (
        <button
          type="button"
          disabled
          title={!hasApprovalAndGreen(pr, checks, required) ? 'Needs approval / CI' : 'Resolve conflicts first'}
          className="cursor-not-allowed rounded bg-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-500"
        >
          Merge
        </button>
      )}

      {actions.addAttempt && (
        <button
          type="button"
          onClick={onAddAttempt}
          className="rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
        >
          + New task
        </button>
      )}

      {(() => {
        if (topic.phase === 'Exploring' || !topic.topicBranch) return null;
        const deliveryBusy = deliverySessionStatus === 'running' || deliverySessionStatus === 'starting' || deliverySessionStatus === 'waiting-permission';
        if (deliveryBusy) {
          return <span className="text-xs text-zinc-500">Delivery session working…</span>;
        }
        if (!deliverable.ok) {
          return (
            <span className="text-xs text-zinc-500" title={deliverable.reasons.join('\n')}>
              Push unavailable · {deliverable.reasons[0]}
            </span>
          );
        }
        return (
          <button
            type="button"
            onClick={onPush}
            className="rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
            title={`Push ${topic.topicBranch} via delivery session (follows repo conventions)`}
          >
            Push
          </button>
        );
      })()}

      {topic.phase === 'Open' && !actions.addressFeedback && (
        <span className="ml-auto text-xs text-zinc-600">
          {hasUnresolvedComments || hasFailingRequired ? '' : 'Clean — no feedback to address.'}
        </span>
      )}
    </div>
  );
}

function hasApprovalAndGreen(pr: PR | undefined, checks: Check[] | undefined, required: string[] | undefined): boolean {
  if (!pr) return false;
  const hasApprovals = pr.approvalsCount >= pr.requiredApprovals;
  const allGreen = (required ?? []).length > 0 &&
    (checks ?? []).filter((c) => (required ?? []).includes(c.name)).every((c) => c.conclusion === 'success');
  return hasApprovals && allGreen;
}
