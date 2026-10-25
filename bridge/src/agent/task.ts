import { EventEmitter } from 'node:events';
import type { AgentEvent, AgentKind, TaskState } from '../protocol.js';
import type { AgentRun } from './process.js';
import { extractSummary } from './summary.js';

export type StartTask = (
  instruction: string,
  onEvent: (e: AgentEvent) => void,
  resumeSessionId: string | undefined,
  agent: AgentKind,
) => AgentRun;

export interface StartOptions {
  /** 用户明确要求新任务时开新会话；默认接着上一个会话 */
  newSession?: boolean;
}

export type StartResult =
  | { accepted: true; task: TaskState }
  | { accepted: false; reason: 'duplicate' | 'busy'; task: TaskState };

interface TaskEvents {
  /** 任务状态有变化（开始、结束） */
  task: [TaskState];
  agent: [AgentEvent];
  /** 任务结束，携带摘要，用于语音播报 */
  finished: [TaskState];
  /** 切换了执行任务的 agent */
  selection: [AgentKind];
}

export interface TaskManagerOptions {
  now?: () => number;
  /** 超过这个时长就终止任务 */
  timeoutMs?: number;
  /** 默认用哪个 agent 执行任务 */
  agent?: AgentKind;
}

export const DEFAULT_TASK_TIMEOUT_MS = 10 * 60_000;
const ERROR_TAIL_LINES = 8;

const normalize = (s: string) => s.replace(/\s+/g, '');

/** 同一时间只跑一个编程任务 */
export class TaskManager extends EventEmitter<TaskEvents> {
  private _current: TaskState | undefined;
  private handle: AgentRun | undefined;
  private seq = 0;
  private cancelRequested = false;
  /** 每个 agent 上一个任务的会话，下一个任务默认接着做；切换 agent 后再切回来也能接上 */
  private readonly sessions: Partial<Record<AgentKind, string>> = {};
  private _agent: AgentKind;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(
    private readonly startTask: StartTask,
    opts: TaskManagerOptions = {},
  ) {
    super();
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
    this._agent = opts.agent ?? 'claude';
  }

  get current(): TaskState | undefined {
    return this._current;
  }

  get agent(): AgentKind {
    return this._agent;
  }

  /** 对下一个任务生效，正在执行的任务不受影响 */
  setAgent(agent: AgentKind): void {
    if (agent === this._agent) return;
    this._agent = agent;
    this.emit('selection', agent);
  }

  start(instruction: string, opts: StartOptions = {}): StartResult {
    const cur = this._current;
    if (cur?.status === 'running') {
      // 灵矽工具调用超时后会重发相同指令，不能重复启动
      const reason = normalize(cur.instruction) === normalize(instruction) ? 'duplicate' : 'busy';
      return { accepted: false, reason, task: cur };
    }
    const agent = this._agent;
    if (opts.newSession) delete this.sessions[agent];
    const resumeId = this.sessions[agent];
    const task: TaskState = {
      id: String(++this.seq), instruction, agent, status: 'running', startedAt: this.now(), resumed: resumeId !== undefined,
    };
    this._current = task;
    this.cancelRequested = false;
    this.emit('task', { ...task });
    let sawStart = false;
    const handle = this.startTask(
      instruction,
      (e) => {
        if (e.kind === 'start' && e.sessionId) {
          sawStart = true;
          this.sessions[agent] = e.sessionId;
        }
        this.emit('agent', e);
      },
      resumeId,
      agent,
    );
    this.handle = handle;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      handle.kill();
    }, this.timeoutMs);

    void handle.outcome.then((o) => {
      clearTimeout(timer);
      // 接续的会话已失效时 Claude 不会输出 init 事件；清掉它，免得之后每次都拿坏 id 接续
      if (resumeId !== undefined && !sawStart) delete this.sessions[agent];
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
