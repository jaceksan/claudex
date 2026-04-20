import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { useTopicDetail } from '../hooks/use-topic-detail';
import { send, subscribe } from '../lib/ws';
import { TopicHeader } from '../components/topic-header';
import { Timeline } from '../components/timeline';
import { TaskPanel } from '../components/task-panel';
import { CommentsPanel } from '../components/comments-panel';
import { CiPanel } from '../components/ci-panel';
import { ActionBar } from '../components/action-bar';
import { AddTaskModal } from '../components/add-task-modal';

export default function TopicPage({ id }: { id: string }) {
  const detail = useTopicDetail(id);
  const [, navigate] = useLocation();
  const [showAddAttempt, setShowAddAttempt] = useState(false);
  const [error, setError] = useState<{ ctx: string; message: string } | null>(null);
  const [creatingPR, setCreatingPR] = useState(false);

  useEffect(() => {
    return subscribe((m) => {
      if (m.type === 'server.topic.error') {
        setError({ ctx: m.payload.ctx ?? 'action', message: m.payload.message });
        if (m.payload.ctx === 'createPR') setCreatingPR(false);
      } else if (m.type === 'server.topic.detail' && m.payload.topicId === id) {
        // Fresh detail arrived → stale error probably no longer relevant.
        setError(null);
        // If the PR just landed, turn the "creating" hint off.
        if (m.payload.pr) setCreatingPR(false);
      }
    });
  }, [id]);

  if (!detail) {
    return (
      <div className="flex h-full items-center justify-center text-zinc-500">
        Loading topic…
      </div>
    );
  }

  const { topic, tasks, pr, threads, checks, required } = detail;

  function handleSaveTask(sessionId: string) {
    send({ type: 'client.task.save', payload: { sessionId } });
  }
  function handleDiscardTaskChanges(sessionId: string) {
    send({ type: 'client.task.discardChanges', payload: { sessionId } });
  }
  function handleDiscardTaskHard(sessionId: string) {
    send({ type: 'client.task.discardHard', payload: { sessionId } });
  }
  function handleMergeTask(sessionId: string) {
    send({ type: 'client.task.merge', payload: { sessionId } });
  }
  function handlePushTopic() {
    send({ type: 'client.topic.push', payload: { topicId: id } });
  }
  function handleCreatePR(title?: string, body?: string) {
    setCreatingPR(true);
    send({ type: 'client.pr.create', payload: { topicId: id, title, body } });
  }
  function handleRefreshCI() {
    // Re-subscribe forces the server to rebuild + push fresh detail (incl. CI).
    send({ type: 'client.topic.subscribe', payload: { topicId: id } });
  }
  function handleClosePR() {
    send({ type: 'client.pr.close', payload: { topicId: id } });
  }
  function handleAddressFeedback(includeCi: boolean, includeComments: boolean) {
    send({ type: 'client.pr.addressFeedback', payload: { topicId: id, includeCi, includeComments } });
  }
  function handleFixComment(threadId: string) {
    send({ type: 'client.pr.fixComment', payload: { topicId: id, threadId } });
  }
  function handleReplyThread(threadId: string, body: string) {
    send({ type: 'client.thread.reply', payload: { topicId: id, threadId, body } });
  }
  function handleFixCheck(checkName: string) {
    send({ type: 'client.pr.fixCheck', payload: { topicId: id, checkName } });
  }
  function handleWatchToggle(enable: boolean) {
    send({ type: 'client.pr.watch', payload: { topicId: id, enable } });
  }
  function handleAddAttempt() {
    setShowAddAttempt(true);
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <TopicHeader topic={topic} pr={pr} onBack={() => navigate('/')} />
      {error && (
        <div className="flex items-start justify-between gap-3 border-b border-red-500/40 bg-red-950/30 px-6 py-2 text-sm text-red-200">
          <div><span className="text-xs uppercase tracking-wide text-red-300/80">{error.ctx}</span> · {error.message}</div>
          <button type="button" onClick={() => setError(null)} className="shrink-0 rounded px-2 py-0.5 text-xs text-red-300 hover:bg-red-900/40">dismiss</button>
        </div>
      )}
      {creatingPR && !pr && (
        <div className="flex items-center gap-2 border-b border-blue-500/30 bg-blue-950/30 px-6 py-2 text-sm text-blue-200">
          <span className="inline-block h-2 w-2 rounded-full bg-blue-400 animate-pulse" />
          Creating pull request — pushing branch and calling gh…
        </div>
      )}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-7xl p-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <Timeline topic={topic} tasks={tasks} pr={pr} />
            <TaskPanel
              tasks={tasks}
              topic={topic}
              onOpenSession={(sessionId) => navigate(`/session/${sessionId}`)}
              onSave={handleSaveTask}
              onDiscardChanges={handleDiscardTaskChanges}
              onDiscardHard={handleDiscardTaskHard}
              onMerge={handleMergeTask}
            />
            <div className="flex flex-col gap-4">
              {pr && threads && threads.length > 0 && (
                <CommentsPanel
                  threads={threads}
                  onFix={handleFixComment}
                  onReply={handleReplyThread}
                />
              )}
              {(pr || creatingPR) && (
                <CiPanel
                  checks={checks ?? []}
                  required={required ?? []}
                  watchEnabled={topic.watchCi}
                  // Keep the amber pulse visible from the click through the
                  // first real poll — without this the CI card looks dead
                  // for up to ~20 seconds.
                  loading={creatingPR || (!!pr && (checks ?? []).length === 0)}
                  onFix={handleFixCheck}
                  onWatchToggle={handleWatchToggle}
                  onRefresh={pr ? handleRefreshCI : undefined}
                />
              )}
            </div>
          </div>
        </div>
      </div>
      <ActionBar
        topic={topic}
        tasks={tasks}
        pr={pr}
        threads={threads}
        checks={checks}
        required={required}
        onCreatePR={handleCreatePR}
        onAddressFeedback={handleAddressFeedback}
        onAddAttempt={handleAddAttempt}
        onPush={handlePushTopic}
        onClosePR={handleClosePR}
        creatingPR={creatingPR}
      />
      {showAddAttempt && (
        <AddTaskModal topicId={id} onClose={() => setShowAddAttempt(false)} />
      )}
    </div>
  );
}
