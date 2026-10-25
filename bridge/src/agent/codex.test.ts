import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../protocol.js';
import { buildCodexArgs, CodexParser, runCodex, unwrapShell } from './codex.js';
import { SUMMARY_PROMPT } from './summary.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const FAKE_AGENT = fixture('fake-agent.mjs');

async function parseFixture(name: string, readFile: (p: string) => string) {
  let t = 0;
  const parser = new CodexParser(readFile, () => (t += 1000));
  const lines = (await readFile_(fixture(name))).trim().split('\n');
  return lines.flatMap((l) => parser.parse(l));
}
const readFile_ = (p: string) => readFile(p, 'utf8');

describe('CodexParser', () => {
  it('把真实输出解析成统一事件，改文件前后各读一次得到 diff', async () => {
    const versions = ['def greet(name):\n    return "Hello " + nme\n', 'def greet(name):\n    return "Hello " + name\n'];
    const reads: string[] = [];
    const events = await parseFixture('codex-success.jsonl', (p) => {
      reads.push(p);
      return versions[reads.length - 1]!;
    });
    expect(events.map((e) => e.kind)).toEqual(['start', 'text', 'tool', 'tool_result', 'tool', 'diff', 'tool_result', 'tool', 'tool_result', 'text', 'done']);
    expect(events[0]).toEqual({ kind: 'start', sessionId: '01a171d7-8f85-7262-aad6-1c3032d8649d', model: 'Codex' });
    expect(events[2]).toMatchObject({ kind: 'tool', id: 'item_1', name: 'Bash', summary: "pwd && rg --files && sed -n '1,200p' greet.py && sed -n '1,200p' test_app.py" });
    expect(events[3]).toMatchObject({ kind: 'tool_result', id: 'item_1', isError: false });
    expect(events[4]).toEqual({ kind: 'tool', id: 'item_2:0', name: 'Edit', summary: '/tmp/probe-codex/greet.py' });
    expect(events[5]).toEqual({ kind: 'diff', id: 'item_2:0', file: '/tmp/probe-codex/greet.py', before: versions[0], after: versions[1] });
    expect(reads).toEqual(['/tmp/probe-codex/greet.py', '/tmp/probe-codex/greet.py']);
    expect(events[7]).toMatchObject({ kind: 'tool', name: 'Bash', summary: 'python3 test_app.py' });
    const done = events.at(-1) as Extract<AgentEvent, { kind: 'done' }>;
    expect(done).toMatchObject({ kind: 'done', isError: false });
    expect(done.result).toContain('已修复 `greet.py` 中的 `nme` 拼写错误');
    expect(done.costUsd).toBeUndefined();
  });

  it('turn.failed 解析成失败，取出内层错误信息；模型元数据告警不产生事件', async () => {
    const events = await parseFixture('codex-failed.jsonl', () => '');
    expect(events.map((e) => e.kind)).toEqual(['start', 'done']);
    expect(events[1]).toMatchObject({
      kind: 'done',
      isError: true,
      result: "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
    });
  });

  it('命令退出码非零或状态失败时标为错误', () => {
    const parser = new CodexParser(() => '');
    const line = (item: object) => JSON.stringify({ type: 'item.completed', item: { id: 'c', type: 'command_execution', aggregated_output: 'x', ...item } });
    expect(parser.parse(line({ exit_code: 1, status: 'completed' }))[0]).toMatchObject({ isError: true });
    expect(parser.parse(line({ exit_code: null, status: 'failed' }))[0]).toMatchObject({ isError: true });
    expect(parser.parse(line({ exit_code: 0, status: 'completed' }))[0]).toMatchObject({ isError: false });
  });

  it('新建文件不读改动前的内容', () => {
    const reads: string[] = [];
    const parser = new CodexParser((p) => (reads.push(p), 'new'));
    const ev = (type: string) => JSON.stringify({ type, item: { id: 'f', type: 'file_change', changes: [{ path: '/a.py', kind: 'add' }], status: 'completed' } });
    expect(parser.parse(ev('item.started'))[0]).toMatchObject({ name: 'Write' });
    expect(parser.parse(ev('item.completed'))[0]).toEqual({ kind: 'diff', id: 'f:0', file: '/a.py', before: '', after: 'new' });
    expect(reads).toEqual(['/a.py']);
  });
});

describe('unwrapShell', () => {
  it('去掉 zsh -lc 外壳，双引号内的转义还原', () => {
    expect(unwrapShell(`/bin/zsh -lc 'python3 test_app.py'`)).toBe('python3 test_app.py');
    expect(unwrapShell(`/bin/zsh -lc "echo \\"hi\\" && ls"`)).toBe('echo "hi" && ls');
    expect(unwrapShell('ls -la')).toBe('ls -la');
  });
});

describe('buildCodexArgs', () => {
  it('新会话：沙箱限制在工作目录，忽略用户配置，附上总结要求', () => {
    const args = buildCodexArgs({ instruction: '修 bug', cwd: '/p' });
    expect(args.slice(0, 1)).toEqual(['exec']);
    expect(args).toEqual(expect.arrayContaining(['--json', '--skip-git-repo-check', '--ignore-user-config', '--sandbox', 'workspace-write', '-C', '/p']));
    expect(args.at(-1)).toBe(`修 bug\n\n${SUMMARY_PROMPT}`);
  });

  it('接续：用 exec resume，沙箱改用 -c 配置，会话 id 在指令之前', () => {
    const args = buildCodexArgs({ instruction: '再改一下', cwd: '/p', resumeSessionId: 'th-1' });
    expect(args.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(args).not.toContain('--sandbox');
    expect(args).not.toContain('-C');
    expect(args[args.indexOf('-c') + 1]).toBe('sandbox_mode="workspace-write"');
    expect(args.slice(-2)).toEqual(['th-1', `再改一下\n\n${SUMMARY_PROMPT}`]);
  });
});

describe('runCodex', () => {
  it('在指定目录启动并转发解析后的事件', async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'codex-')));
    const argsFile = join(cwd, 'args.json');
    Object.assign(process.env, { FAKE_ARGS_FILE: argsFile, FAKE_FIXTURE: fixture('codex-failed.jsonl'), FAKE_EXIT: '1', FAKE_STDERR: '' });
    const events: AgentEvent[] = [];
    const outcome = await runCodex({ instruction: '修 bug', cwd, onEvent: (e) => events.push(e), bin: FAKE_AGENT }).outcome;
    expect(outcome).toMatchObject({ exitCode: 1, done: { isError: true } });
    expect(events.map((e) => e.kind)).toEqual(['start', 'done']);
    const { argv, cwd: childCwd } = JSON.parse(await readFile(argsFile, 'utf8'));
    expect(childCwd).toBe(cwd);
    expect(argv[0]).toBe('exec');
  });
});
