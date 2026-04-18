import { useLocation } from 'wouter';
import { useTopicDetail } from '../hooks/use-topic-detail';
import { send } from '../lib/ws';
import { TopicHeader } from '../components/topic-header';
import { Timeline } from '../components/timeline';
import { TaskPanel } from '../components/task-panel';
import { CommentsPanel } from '../components/comments-panel';
import { CiPanel } from '../components/ci-panel';
import { ActionBar } from '../components/action-bar';

export default function TopicPage({ id }: { id: string }) {
  const detail = useTopicDetail(id);
  const [, navigate] = useLocation();

  if (!detail) {
    return (
      <div className="flex h-full items-center justify-center text-zinc-500">
        Loading topic…
      </div>
    );
  }

  const { topic, tasks, pr, threads, checks, required } = detail;

  function handleAcceptTask(sessionId: string) {
    send({ type: 'client.topic.acceptTask', payload: { sessionId } });
  }
  function handleDiscardTask(sessionId: string) {
    send({ type: 'client.topic.discardTask', payload: { sessionId } });
  }
  function handleCreatePR(title?: string, body?: string) {
    send({ type: 'client.pr.create', payload: { topicId: id, title, body } });
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
    navigate(`/?newAttempt=${id}`);
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <TopicHeader topic={topic} pr={pr} onBack={() => navigate('/')} />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-7xl p-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <Timeline topic={topic} tasks={tasks} pr={pr} />
            <TaskPanel
              tasks={tasks}
              topic={topic}
              onOpenSession={(sessionId) => navigate(`/session/${sessionId}`)}
              onAccept={handleAcceptTask}
              onDiscard={handleDiscardTask}
            />
            <div className="flex flex-col gap-4">
              {pr && threads && threads.length > 0 && (
                <CommentsPanel
                  threads={threads}
                  onFix={handleFixComment}
                  onReply={handleReplyThread}
                />
              )}
              {pr && (
                <CiPanel
                  checks={checks ?? []}
                  required={required ?? []}
                  watchEnabled={topic.watchCi}
                  onFix={handleFixCheck}
                  onWatchToggle={handleWatchToggle}
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
      />
    </div>
  );
}
