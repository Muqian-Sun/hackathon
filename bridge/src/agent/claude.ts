import type { AgentEvent } from '../protocol.js';
import { runJsonlProcess, type AgentRun, type RunAgentOptions } from './process.js';
import { SUMMARY_PROMPT, TOOL_OUTPUT_LIMIT, truncate } from './summary.js';

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

export function runClaude(opts: RunAgentOptions): AgentRun {
  return runJsonlProcess({
    bin: opts.bin ?? 'claude',
    args: [
      '-p', opts.instruction, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto',
      // 默认 host 会等宿主回答权限确认，而我们没有宿主，进程会一直挂着；none 表示直接拒绝
      '--permission-prompts', 'none',
      '--append-system-prompt', SUMMARY_PROMPT,
      ...(opts.resumeSessionId ? ['--resume', opts.resumeSessionId] : []),
    ],
    cwd: opts.cwd,
    parseLine: parseClaudeLine,
    onEvent: opts.onEvent,
    log: opts.log,
  });
}
