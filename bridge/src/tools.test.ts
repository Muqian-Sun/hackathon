import { describe, expect, it } from 'vitest';
import type { RunOutcome } from './agent/claude.js';
import { TaskManager } from './agent/task.js';
import { createCodingTools, formatElapsed } from './tools.js';

function setup() {
  let resolve!: (o: RunOutcome) => void;
  let t = 0;
  // 模拟进程被终止后以信号退出
  const kill = () => resolve({ exitCode: null, stderrTail: '', done: undefined });
  const tasks = new TaskManager(() => ({ outcome: new Promise<RunOutcome>((r) => (resolve = r)), kill }), { now: () => t });
  const tools = createCodingTools(tasks, () => t);
  const byName = (name: string) => tools.find((x) => x.name === `self.coding.${name}`)!;
  return {
    tools, run: byName('run_task'), status: byName('get_status'), stop: byName('stop_task'),
    tasks, advance: (ms: number) => (t += ms), resolve: (o: RunOutcome) => resolve(o),
  };
}

describe('createCodingTools', () => {
  it('工具名与架构文档一致', () => {
    const { tools } = setup();
    expect(tools.map((x) => x.name)).toEqual(['self.coding.run_task', 'self.coding.stop_task', 'self.coding.get_status']);
  });

  it('stop_task 中止执行中的任务；没有任务时说明不需要停止', async () => {
    const { run, stop, status, tasks } = setup();
    expect(await stop.handler({})).toContain('不需要停止');
    await run.handler({ instruction: '修 bug' });
    const finished = new Promise((r) => tasks.once('finished', r));
    expect(await stop.handler({})).toContain('已经中止');
    await finished;
    expect(tasks.current?.status).toBe('cancelled');
    expect(await status.handler({})).toBe('上一个任务已经按要求停止了。');
  });

  it('run_task 立即返回「开始执行」，不说已完成', async () => {
    const { run, tasks } = setup();
    const text = await run.handler({ instruction: '修 bug' });
    expect(text).toContain('开始执行');
    expect(text).not.toContain('已完成');
    expect(tasks.current?.status).toBe('running');
  });

  it('run_task 缺少指令时报错', async () => {
    const { run } = setup();
    await expect(run.handler({ instruction: '  ' })).rejects.toThrow('instruction');
  });

  it('重复和忙碌给出不同提示', async () => {
    const { run, advance } = setup();
    await run.handler({ instruction: '修 bug' });
    advance(75_000);
    expect(await run.handler({ instruction: '修 bug' })).toContain('已经在后台执行');
    expect(await run.handler({ instruction: '写文档' })).toContain('上一个任务还在执行（修 bug，已运行 1 分 15 秒）');
  });

  it('get_status 覆盖无任务、执行中、已结束', async () => {
    const { run, status, advance, resolve, tasks } = setup();
    expect(await status.handler({})).toBe('当前没有编程任务。');
    await run.handler({ instruction: '修 bug' });
    advance(42_000);
    expect(await status.handler({})).toBe('正在执行：修 bug，已运行 42 秒。');
    const finished = new Promise((r) => tasks.once('finished', r));
    resolve({ exitCode: 0, done: { kind: 'done', isError: false, result: '总结：修好了', durationMs: 1, costUsd: 0 }, stderrTail: '' });
    await finished;
    expect(await status.handler({})).toBe('上一个任务已完成：修好了');
  });

  it('get_status 描述失败的任务', async () => {
    const { run, status, resolve, tasks } = setup();
    await run.handler({ instruction: '修 bug' });
    const finished = new Promise((r) => tasks.once('finished', r));
    resolve({ exitCode: 1, stderrTail: 'boom', done: undefined });
    await finished;
    expect(await status.handler({})).toBe('上一个任务没有成功：任务失败，详情请看屏幕');
  });
});

describe('formatElapsed', () => {
  it('秒和分秒两种格式', () => {
    expect(formatElapsed(59_400)).toBe('59 秒');
    expect(formatElapsed(60_000)).toBe('1 分 0 秒');
  });
});
