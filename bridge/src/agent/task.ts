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

export interface TaskManagerOptions {
  now?: () => number;
  /** 超过这个时长就终止任务 */
  timeoutMs?: number;
}

export const DEFAULT_TASK_TIMEOUT_MS = 10 * 60_000;
const ERROR_TAIL_LINES = 8;

const normalize = (s: string) => s.replace(/\s+/g, '');

/** 同一时间只跑一个编程任务 */
export class TaskManager extends EventEmitter<TaskEvents> {
  private _current: TaskState | undefined;
  private handle: ClaudeRun | undefined;
  private seq = 0;
  private cancelRequested = false;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(
    private readonly startTask: StartTask,
    opts: TaskManagerOptions = {},
  ) {
    super();
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
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
    this.cancelRequested = false;
    this.emit('task', { ...task });
    const handle = this.startTask(instruction, (e) => this.emit('agent', e));
    this.handle = handle;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      handle.kill();
    }, this.timeoutMs);

    void handle.outcome.then((o) => {
      clearTimeout(timer);
      const ok = o.exitCode === 0 && o.done !== undefined && !o.done.isError;
      const claudeSummary = o.done ? extractSummary(o.done.result) : '';
      const stderr = o.stderrTail.trim().split('\n').slice(-ERROR_TAIL_LINES).join('\n');
      // summary 用于语音播报，要短且能听懂；错误细节放 error 显示在屏幕上
      let status: TaskState['status'] = ok ? 'succeeded' : 'failed';
      let summary: string;
      let error: string | undefined;
      if (ok) {
        summary = claudeSummary;
      } else if (this.cancelRequested) {
        status = 'cancelled';
        summary = '任务已按要求停止';
      } else if (timedOut) {
        const limit = this.timeoutMs >= 60_000 ? `${Math.round(this.timeoutMs / 60_000)} 分钟` : `${Math.round(this.timeoutMs / 1000)} 秒`;
        summary = `任务超过 ${limit}没有完成，已经中止`;
        error = stderr || undefined;
      } else if (claudeSummary) {
        summary = `任务失败：${claudeSummary}`;
        error = stderr || undefined;
      } else {
        summary = '任务失败，详情请看屏幕';
        error = stderr || `退出码 ${o.exitCode}`;
      }
      Object.assign(task, { status, endedAt: this.now(), summary, error });
      if (this.handle === handle) this.handle = undefined;
      this.emit('task', { ...task });
      this.emit('finished', { ...task });
    });
    return { accepted: true, task: { ...task } };
  }

  /** 用户要求中止当前任务；没有任务在执行时返回 false */
  cancel(): boolean {
    if (this._current?.status !== 'running' || !this.handle) return false;
    this.cancelRequested = true;
    this.handle.kill();
    return true;
  }

  /** 桥接服务退出时终止子进程 */
  stop(): void {
    this.handle?.kill();
  }
}
