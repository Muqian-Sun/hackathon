import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export type AgentEvent =
  | { kind: 'start'; sessionId: string; model: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; summary: string }
  | { kind: 'diff'; id: string; file: string; before: string; after: string }
  | { kind: 'tool_result'; id: string; isError: boolean; output: string }
  | { kind: 'done'; isError: boolean; result: string; durationMs: number; costUsd: number };

export const TOOL_OUTPUT_LIMIT = 2000;
export const SUMMARY_LIMIT = 80;

export const SUMMARY_PROMPT =
  '任务结束时，在最终回复的最后单独写一行「总结：」加一句不超过 40 字的中文口语总结，用于语音播报，不要包含代码、文件路径或 Markdown 符号。';

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

function summarizeToolInput(input: Record<string, unknown>): string {
  for (const key of ['file_path', 'path', 'command', 'pattern', 'url', 'query', 'description']) {
    const v = input[key];
    if (typeof v === 'string' && v) return truncate(v, 200);
  }
  return truncate(JSON.stringify(input), 200);
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c === 'object' && 'text' in c ? String(c.text) : '')).join('\n');
  }
  return '';
}

/** 把 Claude Code stream-json 的一行解析成零到多个事件；非 JSON 行抛错 */
export function parseClaudeLine(line: string): AgentEvent[] {
  const e = JSON.parse(line) as Record<string, any>;
  switch (e.type) {
    case 'system':
      return e.subtype === 'init' ? [{ kind: 'start', sessionId: String(e.session_id ?? ''), model: String(e.model ?? '') }] : [];
    case 'assistant': {
      const events: AgentEvent[] = [];
      for (const c of e.message?.content ?? []) {
        if (c.type === 'text' && c.text) events.push({ kind: 'text', text: c.text });
        else if (c.type === 'thinking' && c.thinking) events.push({ kind: 'thinking', text: c.thinking });
        else if (c.type === 'tool_use') {
          const input = (c.input ?? {}) as Record<string, unknown>;
          events.push({ kind: 'tool', id: c.id, name: c.name, summary: summarizeToolInput(input) });
          if (c.name === 'Edit') {
            events.push({ kind: 'diff', id: c.id, file: String(input.file_path), before: String(input.old_string ?? ''), after: String(input.new_string ?? '') });
          } else if (c.name === 'Write') {
            events.push({ kind: 'diff', id: c.id, file: String(input.file_path), before: '', after: String(input.content ?? '') });
          }
        }
      }
      return events;
    }
    case 'user': {
      const events: AgentEvent[] = [];
      for (const c of e.message?.content ?? []) {
        if (c.type === 'tool_result') {
          events.push({ kind: 'tool_result', id: c.tool_use_id, isError: c.is_error === true, output: truncate(toolResultText(c.content), TOOL_OUTPUT_LIMIT) });
        }
      }
      return events;
    }
    case 'result':
      return [{
        kind: 'done',
        isError: e.is_error === true || e.subtype !== 'success',
        result: String(e.result ?? ''),
        durationMs: Number(e.duration_ms ?? 0),
        costUsd: Number(e.total_cost_usd ?? 0),
      }];
    default:
      return [];
  }
}

/** 取「总结：」行；没有时取最后一行非代码文字，去掉 Markdown 符号 */
export function extractSummary(result: string): string {
  const tagged = [...result.matchAll(/^\s*总结[:：]\s*(.+)$/gm)].at(-1)?.[1];
  if (tagged) return truncate(tagged.trim(), SUMMARY_LIMIT);
  const withoutCode = result.replace(/```[\s\S]*?```/g, '');
  const lines = withoutCode
    .split('\n')
    .map((l) => l.replace(/[#>*`_|]/g, '').replace(/^\s*[-\d.]+\s+/, '').trim())
    .filter((l) => l && !/^-+$/.test(l));
  return truncate(lines.at(-1) ?? '', SUMMARY_LIMIT);
}

export interface RunOutcome {
  exitCode: number | null;
  done?: Extract<AgentEvent, { kind: 'done' }>;
  stderrTail: string;
}

export interface ClaudeRun {
  outcome: Promise<RunOutcome>;
  kill: () => void;
}

export interface RunClaudeOptions {
  instruction: string;
  cwd: string;
  onEvent: (e: AgentEvent) => void;
  claudeBin?: string;
  log?: (msg: string) => void;
}

export function runClaude(opts: RunClaudeOptions): ClaudeRun {
  const child = spawn(
    opts.claudeBin ?? 'claude',
    ['-p', opts.instruction, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto', '--append-system-prompt', SUMMARY_PROMPT],
    { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] },
  );
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
      events = parseClaudeLine(line);
    } catch {
      opts.log?.(`无法解析的 Claude 输出: ${line.slice(0, 200)}`);
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
