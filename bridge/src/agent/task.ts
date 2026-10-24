import { EventEmitter } from 'node:events';
import type { AgentEvent, TaskState } from '../protocol.js';
import { extractSummary, type ClaudeRun } from './claude.js';

export type StartTask = (instruction: string, onEvent: (e: AgentEvent) => void) => ClaudeRun;

export type StartResult =
  | { accepted: true; task: TaskState }
  | { accepted: false; reason: 'duplicate' | 'busy'; task: TaskState };

interface TaskEvents {
  /** 任务状态有变化（开始、结束） */
  task: [TaskState];
  agent: [AgentEvent];
  /** 任务结束，携带摘要，用于语音播报 */
  finished: [TaskState];
}

const normalize = (s: string) => s.replace(/\s+/g, '');

/** 同一时间只跑一个编程任务 */
export class TaskManager extends EventEmitter<TaskEvents> {
  private _current: TaskState | undefined;
  private handle: ClaudeRun | undefined;
  private seq = 0;

  constructor(
    private readonly startTask: StartTask,
    private readonly now: () => number = Date.now,
  ) {
    super();
  }

  get current(): TaskState | undefined {
    return this._current;
  }

  start(instruction: string): StartResult {
    const cur = this._current;
    if (cur?.status === 'running') {
      // 灵矽工具调用超时后会重发相同指令，不能重复启动
      const reason = normalize(cur.instruction) === normalize(instruction) ? 'duplicate' : 'busy';
      return { accepted: false, reason, task: cur };
    }
    const task: TaskState = { id: String(++this.seq), instruction, status: 'running', startedAt: this.now() };
    this._current = task;
    this.emit('task', { ...task });
    const handle = this.startTask(instruction, (e) => this.emit('agent', e));
    this.handle = handle;
    void handle.outcome.then((o) => {
      const ok = o.exitCode === 0 && o.done !== undefined && !o.done.isError;
      const detail = (o.done && extractSummary(o.done.result)) || o.stderrTail.trim().split('\n').at(-1) || `退出码 ${o.exitCode}`;
      Object.assign(task, {
        status: ok ? 'succeeded' : 'failed',
        endedAt: this.now(),
        summary: ok ? detail : `任务失败：${detail}`,
      });
      if (this.handle === handle) this.handle = undefined;
      this.emit('task', { ...task });
      this.emit('finished', { ...task });
    });
    return { accepted: true, task: { ...task } };
  }

  stop(): void {
    this.handle?.kill();
  }
}
