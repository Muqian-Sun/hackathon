import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentEvent } from '../protocol.js';

export interface RunOutcome {
  exitCode: number | null;
  done?: Extract<AgentEvent, { kind: 'done' }>;
  stderrTail: string;
}

export interface AgentRun {
  outcome: Promise<RunOutcome>;
  kill: () => void;
}

/** 各 code agent 运行器的公共参数 */
export interface RunAgentOptions {
  instruction: string;
  cwd: string;
  onEvent: (e: AgentEvent) => void;
  /** 接着这个会话继续，会话 id 保持不变 */
  resumeSessionId?: string;
  /** 可执行文件，测试时替换成假的 */
  bin?: string;
  log?: (msg: string) => void;
}

export interface JsonlProcessOptions {
  bin: string;
  args: string[];
  cwd: string;
  /** 解析 stdout 的一行，非 JSON 时抛错 */
  parseLine: (line: string) => AgentEvent[];
  onEvent: (e: AgentEvent) => void;
  log?: (msg: string) => void;
}

/** 启动一个按行输出 JSON 事件的 agent 进程，逐行解析并汇总结果 */
export function runJsonlProcess(opts: JsonlProcessOptions): AgentRun {
  const child = spawn(opts.bin, opts.args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let done: RunOutcome['done'];
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-4000);
  });
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let events: AgentEvent[];
    try {
      events = opts.parseLine(line);
    } catch {
      opts.log?.(`无法解析的 ${opts.bin} 输出: ${line.slice(0, 200)}`);
      return;
    }
    for (const e of events) {
      if (e.kind === 'done') done = e;
      opts.onEvent(e);
    }
  });
  const outcome = new Promise<RunOutcome>((resolve) => {
    let exitCode: number | null = null;
    let exited = false;
    let closed = false;
    const finish = () => {
      if (exited && closed) resolve({ exitCode, done, stderrTail: stderr.slice(-1000) });
    };
    child.on('error', (err) => {
      stderr += `\n${err.message}`;
      exited = true;
      closed = true;
      finish();
    });
    child.on('exit', (code) => {
      exitCode = code;
      exited = true;
      finish();
    });
    rl.on('close', () => {
      closed = true;
      finish();
    });
  });
  return { outcome, kill: () => child.kill('SIGTERM') };
}
