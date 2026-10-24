import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { extractSummary, parseClaudeLine, runClaude, type AgentEvent } from './claude.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/claude-stream.jsonl', import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

describe('parseClaudeLine', () => {
  it('把真实输出解析成统一事件', async () => {
    const lines = (await readFile(FIXTURE, 'utf8')).trim().split('\n');
    const events = lines.flatMap(parseClaudeLine);
    expect(events.map((e) => e.kind)).toEqual([
      'start', 'thinking', 'tool', 'tool_result', 'thinking', 'tool', 'tool_result',
      'tool', 'diff', 'tool_result', 'thinking', 'text', 'done',
    ]);
    expect(events[0]).toMatchObject({ kind: 'start', sessionId: '1701881e-fce4-4a0d-b888-5f08c6479177' });
    expect(events[2]).toEqual({ kind: 'tool', id: 'call_467899', name: 'Read', summary: '/private/tmp/cc-probe/calc.py' });
    expect(events[3]).toMatchObject({ kind: 'tool_result', id: 'call_467899', isError: false });
    expect(events[6]).toMatchObject({ kind: 'tool_result', isError: true });
    expect(events[8]).toEqual({
      kind: 'diff', id: 'call_648617', file: '/private/tmp/cc-probe/calc.py',
      before: 'def add(a, b):\n    return a - b\n', after: 'def add(a, b):\n    return a + b\n',
    });
    expect(events.at(-1)).toMatchObject({ kind: 'done', isError: false, durationMs: 93518, costUsd: 0.759624 });
  });

  it('Write 工具产出 before 为空的 diff', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/a.txt', content: 'hi' } }] },
    });
    expect(parseClaudeLine(line)[1]).toEqual({ kind: 'diff', id: 't1', file: '/a.txt', before: '', after: 'hi' });
  });

  it('非 success 的 result 记为失败', () => {
    const [e] = parseClaudeLine(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: false }));
    expect(e).toMatchObject({ kind: 'done', isError: true });
  });

  it('非 JSON 行抛错', () => {
    expect(() => parseClaudeLine('not json')).toThrow();
  });
});

describe('extractSummary', () => {
  it('优先取最后一个「总结：」行', () => {
    expect(extractSummary('改了两个文件\n总结：旧的\n细节\n总结：修好了加法函数')).toBe('修好了加法函数');
  });

  it('没有「总结：」时取最后一行非代码文字并去掉 Markdown', async () => {
    const lines = (await readFile(FIXTURE, 'utf8')).trim().split('\n');
    const done = parseClaudeLine(lines.at(-1)!)[0] as Extract<AgentEvent, { kind: 'done' }>;
    expect(extractSummary(done.result)).toBe('我将 calc.py 中 add 函数的减法逻辑修复为加法运算并完成了测试验证。');
  });

  it('超长时截断', () => {
    expect(extractSummary(`总结：${'字'.repeat(100)}`)).toHaveLength(81);
  });
});

describe('runClaude', () => {
  const runs: Array<() => void> = [];
  afterEach(() => runs.splice(0).forEach((k) => k()));

  async function start(env: Record<string, string>, claudeBin = FAKE_CLAUDE) {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'runner-')));
    const argsFile = join(cwd, 'args.json');
    Object.assign(process.env, { FAKE_ARGS_FILE: argsFile, FAKE_FIXTURE: '', FAKE_EXIT: '0', FAKE_STDERR: '' }, env);
    const events: AgentEvent[] = [];
    const run = runClaude({ instruction: '修 bug', cwd, onEvent: (e) => events.push(e), claudeBin });
    runs.push(run.kill);
    return { run, events, cwd, argsFile };
  }

  it('在指定目录用约定参数启动，并转发事件', async () => {
    const { run, events, cwd, argsFile } = await start({ FAKE_FIXTURE: FIXTURE });
    const outcome = await run.outcome;
    expect(outcome.exitCode).toBe(0);
    expect(outcome.done).toMatchObject({ kind: 'done', isError: false });
    expect(events).toHaveLength(13);
    const { argv, cwd: childCwd } = JSON.parse(await readFile(argsFile, 'utf8'));
    expect(childCwd).toBe(cwd);
    expect(argv.slice(0, 2)).toEqual(['-p', '修 bug']);
    expect(argv).toEqual(expect.arrayContaining(['--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto', '--append-system-prompt']));
  });

  it('非零退出且没有 result 时保留 stderr', async () => {
    const { run } = await start({ FAKE_EXIT: '3', FAKE_STDERR: 'boom' });
    const outcome = await run.outcome;
    expect(outcome).toMatchObject({ exitCode: 3, done: undefined });
    expect(outcome.stderrTail).toContain('boom');
  });

  it('可执行文件不存在时也能结束', async () => {
    const { run } = await start({}, '/nonexistent/claude');
    const outcome = await run.outcome;
    expect(outcome.exitCode).toBeNull();
    expect(outcome.stderrTail).toContain('ENOENT');
  });
});
