import { describe, expect, it } from 'vitest';
import { buildTimeline, diffRows, shortPath, toolLabel } from './timeline';

describe('buildTimeline', () => {
  it('把 diff 和结果并到对应的工具调用上，保持顺序', () => {
    const items = buildTimeline([
      { kind: 'start', sessionId: 's', model: 'm' },
      { kind: 'tool', id: 'a', name: 'Read', summary: '/p/calc.py' },
      { kind: 'tool', id: 'b', name: 'Edit', summary: '/p/calc.py' },
      { kind: 'diff', id: 'b', file: '/p/calc.py', before: 'x', after: 'y' },
      { kind: 'tool_result', id: 'a', isError: false, output: '内容' },
      { kind: 'tool_result', id: 'b', isError: true, output: '失败' },
      { kind: 'text', text: '好了' },
      { kind: 'done', isError: false, result: '', durationMs: 1000, costUsd: 0.1 },
    ]);
    expect(items).toEqual([
      { kind: 'start', model: 'm' },
      { kind: 'tool', id: 'a', name: 'Read', summary: '/p/calc.py', result: { isError: false, output: '内容' } },
      {
        kind: 'tool', id: 'b', name: 'Edit', summary: '/p/calc.py',
        diff: { file: '/p/calc.py', before: 'x', after: 'y' }, result: { isError: true, output: '失败' },
      },
      { kind: 'text', text: '好了' },
      { kind: 'done', isError: false, durationMs: 1000, costUsd: 0.1 },
    ]);
  });

  it('找不到对应工具的结果被忽略', () => {
    expect(buildTimeline([{ kind: 'tool_result', id: 'x', isError: false, output: '' }])).toEqual([]);
  });
});

describe('diffRows', () => {
  it('按行标出删除、新增和未变', () => {
    expect(diffRows('a\nb\nc\n', 'a\nB\nc\n').rows).toEqual([
      { type: 'ctx', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'add', text: 'B' },
      { type: 'ctx', text: 'c' },
    ]);
  });

  it('新建文件全部是新增；超过上限时截断并给出省略行数', () => {
    const r = diffRows('', 'l1\nl2\nl3\nl4', 3);
    expect(r.rows).toEqual([{ type: 'add', text: 'l1' }, { type: 'add', text: 'l2' }, { type: 'add', text: 'l3' }]);
    expect(r.omitted).toBe(1);
  });
});

describe('shortPath / toolLabel', () => {
  it('长绝对路径只留最后三段，命令原样保留', () => {
    expect(shortPath('/Users/me/code/demo/src/app.ts')).toBe('…/demo/src/app.ts');
    expect(shortPath('/tmp/a.py')).toBe('/tmp/a.py');
    expect(shortPath('ls -la /a/b/c/d')).toBe('ls -la /a/b/c/d');
  });

  it('常用工具翻成中文，未知工具保留原名', () => {
    expect(toolLabel('Edit')).toBe('修改');
    expect(toolLabel('mcp__x')).toBe('mcp__x');
  });
});
