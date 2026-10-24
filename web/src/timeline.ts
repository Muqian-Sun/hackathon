import { diffLines } from 'diff';
import type { AgentEvent } from '../../bridge/src/protocol';

export type TimelineItem =
  | { kind: 'start'; model: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string }
  | {
      kind: 'tool';
      id: string;
      name: string;
      summary: string;
      result?: { isError: boolean; output: string };
      diff?: { file: string; before: string; after: string };
    }
  | { kind: 'done'; isError: boolean; durationMs: number; costUsd: number };

/** 把工具调用、diff、结果按 id 合并成一条，便于大屏上一眼看清每一步 */
export function buildTimeline(steps: AgentEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const tools = new Map<string, Extract<TimelineItem, { kind: 'tool' }>>();
  for (const e of steps) {
    switch (e.kind) {
      case 'start':
        items.push({ kind: 'start', model: e.model });
        break;
      case 'thinking':
      case 'text':
        items.push({ kind: e.kind, text: e.text });
        break;
      case 'tool': {
        const item = { kind: 'tool' as const, id: e.id, name: e.name, summary: e.summary };
        tools.set(e.id, item);
        items.push(item);
        break;
      }
      case 'diff': {
        const tool = tools.get(e.id);
        if (tool) tool.diff = { file: e.file, before: e.before, after: e.after };
        break;
      }
      case 'tool_result': {
        const tool = tools.get(e.id);
        if (tool) tool.result = { isError: e.isError, output: e.output };
        break;
      }
      case 'done':
        items.push({ kind: 'done', isError: e.isError, durationMs: e.durationMs, costUsd: e.costUsd });
        break;
    }
  }
  return items;
}

const TOOL_LABELS: Record<string, string> = {
  Read: '读取',
  Edit: '修改',
  MultiEdit: '修改',
  Write: '新建',
  Bash: '执行',
  Grep: '搜索',
  Glob: '查找文件',
  WebFetch: '访问网页',
  WebSearch: '联网搜索',
  TodoWrite: '更新计划',
  Task: '子任务',
};

export const toolLabel = (name: string) => TOOL_LABELS[name] ?? name;

/** 绝对路径只保留最后几段，大屏上放得下 */
export function shortPath(s: string, keep = 3): string {
  if (!s.startsWith('/')) return s;
  const parts = s.split('/').filter(Boolean);
  return parts.length > keep ? `…/${parts.slice(-keep).join('/')}` : s;
}

export interface DiffRow {
  type: 'add' | 'del' | 'ctx';
  text: string;
}

/** 行级 diff；超过 limit 行时截断并在末尾标出省略行数 */
export function diffRows(before: string, after: string, limit = 24): { rows: DiffRow[]; omitted: number } {
  const rows: DiffRow[] = [];
  for (const change of diffLines(before, after)) {
    const type = change.added ? 'add' : change.removed ? 'del' : 'ctx';
    const lines = change.value.replace(/\n$/, '').split('\n');
    for (const text of lines) rows.push({ type, text });
  }
  return rows.length > limit ? { rows: rows.slice(0, limit), omitted: rows.length - limit } : { rows, omitted: 0 };
}
