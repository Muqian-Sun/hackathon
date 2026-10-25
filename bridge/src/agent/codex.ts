import { readFileSync } from 'node:fs';
import type { AgentEvent } from '../protocol.js';
import { runJsonlProcess, type AgentRun, type RunAgentOptions } from './process.js';
import { SUMMARY_PROMPT, TOOL_OUTPUT_LIMIT, truncate } from './summary.js';

export function buildCodexArgs(opts: Pick<RunAgentOptions, 'instruction' | 'cwd' | 'resumeSessionId'>): string[] {
  const prompt = `${opts.instruction}\n\n${SUMMARY_PROMPT}`;
  // 用户配置里的默认模型可能与登录方式不兼容（实测 ChatGPT 账号不支持 gpt-5.6-sol），统一忽略用户配置
  const common = ['--json', '--skip-git-repo-check', '--ignore-user-config'];
  return opts.resumeSessionId
    ? // exec resume 不支持 --sandbox / -C：沙箱用 -c 配置，工作目录由进程 cwd 决定
      ['exec', 'resume', ...common, '-c', 'sandbox_mode="workspace-write"', opts.resumeSessionId, prompt]
    : ['exec', ...common, '--sandbox', 'workspace-write', '-C', opts.cwd, prompt];
}

/** Codex 把命令包在 `/bin/zsh -lc "..."` 里，展示时去掉外壳 */
export function unwrapShell(command: string): string {
  const m = /^\/bin\/\w+ -lc (["'])([\s\S]*)\1$/.exec(command);
  if (!m) return command;
  return m[1] === '"' ? m[2]!.replace(/\\"/g, '"') : m[2]!;
}

function errorMessage(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : String((raw as { message?: unknown })?.message ?? raw);
  try {
    const inner = JSON.parse(text) as { error?: { message?: string } };
    return inner.error?.message ?? text;
  } catch {
    return text;
  }
}

const readText = (path: string): string => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};

/**
 * 把 codex exec --json 的事件解析成统一事件。
 * file_change 事件不带改动内容：started 时文件尚未写入（实测），在 started / completed 各读一次文件得到 diff。
 */
export class CodexParser {
  private lastMessage = '';
  private readonly before = new Map<string, string>();
  private readonly startedAt: number;

  constructor(
    private readonly readFile: (path: string) => string = readText,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  parse(line: string): AgentEvent[] {
    const e = JSON.parse(line) as Record<string, any>;
    switch (e.type) {
      case 'thread.started':
        return [{ kind: 'start', sessionId: String(e.thread_id ?? ''), model: 'Codex' }];
      case 'item.started':
        return this.itemStarted(e.item);
      case 'item.completed':
        return this.itemCompleted(e.item);
      case 'turn.completed':
        return [{ kind: 'done', isError: false, result: this.lastMessage, durationMs: this.now() - this.startedAt }];
      case 'turn.failed':
        return [{ kind: 'done', isError: true, result: errorMessage(e.error), durationMs: this.now() - this.startedAt }];
      default:
        return [];
    }
  }

  private itemStarted(item: Record<string, any>): AgentEvent[] {
    if (item.type === 'command_execution') {
      return [{ kind: 'tool', id: item.id, name: 'Bash', summary: truncate(unwrapShell(String(item.command)), 200) }];
    }
    if (item.type === 'file_change') {
      return (item.changes as Array<{ path: string; kind: string }>).map((c, i) => {
        const id = `${item.id}:${i}`;
        this.before.set(id, c.kind === 'add' ? '' : this.readFile(c.path));
        return { kind: 'tool', id, name: c.kind === 'add' ? 'Write' : 'Edit', summary: c.path };
      });
    }
    return [];
  }

  private itemCompleted(item: Record<string, any>): AgentEvent[] {
    switch (item.type) {
      case 'agent_message':
        this.lastMessage = String(item.text ?? '');
        return this.lastMessage ? [{ kind: 'text', text: this.lastMessage }] : [];
      case 'reasoning':
        return item.text ? [{ kind: 'thinking', text: String(item.text) }] : [];
      case 'command_execution':
        return [{
          kind: 'tool_result',
          id: item.id,
          isError: item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0),
          output: truncate(String(item.aggregated_output ?? ''), TOOL_OUTPUT_LIMIT),
        }];
      case 'file_change':
        return (item.changes as Array<{ path: string }>).flatMap((c, i): AgentEvent[] => {
          const id = `${item.id}:${i}`;
          const before = this.before.get(id) ?? '';
          this.before.delete(id);
          return [
            { kind: 'diff', id, file: c.path, before, after: this.readFile(c.path) },
            { kind: 'tool_result', id, isError: item.status !== 'completed', output: '' },
          ];
        });
      default:
        return [];
    }
  }
}

export function runCodex(opts: RunAgentOptions): AgentRun {
  const parser = new CodexParser();
  return runJsonlProcess({
    bin: opts.bin ?? 'codex',
    args: buildCodexArgs(opts),
    cwd: opts.cwd,
    parseLine: (line) => parser.parse(line),
    onEvent: opts.onEvent,
    log: opts.log,
  });
}
