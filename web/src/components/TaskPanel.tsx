import { useEffect, useMemo, useState } from 'react';
import type { AgentEvent, TaskState } from '../../../bridge/src/protocol';
import { buildTimeline } from '../timeline';
import { useAutoScroll } from '../useAutoScroll';
import { Timeline } from './Timeline';

const STATUS_LABEL: Record<TaskState['status'], string> = { running: '执行中', succeeded: '已完成', failed: '失败', cancelled: '已停止' };

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function formatDuration(ms: number) {
  const sec = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

export function TaskPanel({ task, steps }: { task?: TaskState; steps: AgentEvent[] }) {
  const running = task?.status === 'running';
  const now = useNow(running);
  const items = useMemo(() => buildTimeline(steps), [steps]);
  const listRef = useAutoScroll<HTMLDivElement>(steps.length);

  if (!task) {
    return (
      <section className="panel task">
        <h2>Claude Code</h2>
        <p className="empty">还没有任务。说出编程需求后，Claude Code 的每一步都会显示在这里。</p>
      </section>
    );
  }

  return (
    <section className="panel task">
      <div className={`task-card ${task.status}`}>
        <div className="task-head">
          <span className={`badge ${task.status}`}>{STATUS_LABEL[task.status]}</span>
          <span className="elapsed">{formatDuration((task.endedAt ?? now) - task.startedAt)}</span>
        </div>
        <p className="instruction">{task.instruction}</p>
        {task.summary && <p className="summary">{task.summary}</p>}
        {task.error && <pre className="task-error">{task.error}</pre>}
      </div>
      <div className="timeline" ref={listRef}>
        <Timeline items={items} />
      </div>
    </section>
  );
}
