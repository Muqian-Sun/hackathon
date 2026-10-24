import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, RunOutcome } from './claude.js';
import { TaskManager, type TaskState } from './task.js';

function setup() {
  let resolve!: (o: RunOutcome) => void;
  let emit!: (e: AgentEvent) => void;
  const kill = vi.fn();
  const startTask = vi.fn((_instruction: string, onEvent: (e: AgentEvent) => void) => {
    emit = onEvent;
    return { outcome: new Promise<RunOutcome>((r) => (resolve = r)), kill };
  });
  let t = 1000;
  const tasks = new TaskManager(startTask, () => t);
  const finished: TaskState[] = [];
  tasks.on('finished', (s) => finished.push(s));
  return {
    tasks, startTask, kill, finished,
    finish: async (o: RunOutcome) => { t = 5000; resolve(o); await vi.waitFor(() => expect(finished.length).toBeGreaterThan(0)); },
    emit: (e: AgentEvent) => emit(e),
  };
}

const done = (result: string, isError = false) => ({ kind: 'done' as const, isError, result, durationMs: 1, costUsd: 0 });

describe('TaskManager', () => {
  it('启动任务并转发 agent 事件', () => {
    const { tasks, startTask, emit } = setup();
    const events: AgentEvent[] = [];
    tasks.on('agent', (e) => events.push(e));
    const res = tasks.start('修 bug');
    expect(res).toMatchObject({ accepted: true, task: { status: 'running', instruction: '修 bug', startedAt: 1000 } });
    expect(startTask).toHaveBeenCalledWith('修 bug', expect.any(Function));
    emit({ kind: 'text', text: 'hi' });
    expect(events).toEqual([{ kind: 'text', text: 'hi' }]);
  });

  it('执行中收到相同指令（空白不同）判为重复，不重复启动', () => {
    const { tasks, startTask } = setup();
    tasks.start('修 bug');
    expect(tasks.start(' 修  bug ')).toMatchObject({ accepted: false, reason: 'duplicate' });
    expect(startTask).toHaveBeenCalledTimes(1);
  });

  it('执行中收到不同指令判为忙碌', () => {
    const { tasks, startTask } = setup();
    tasks.start('修 bug');
    expect(tasks.start('写文档')).toMatchObject({ accepted: false, reason: 'busy', task: { instruction: '修 bug' } });
    expect(startTask).toHaveBeenCalledTimes(1);
  });

  it('成功结束时取总结作为摘要，之后可以启动新任务', async () => {
    const { tasks, finish, finished, startTask } = setup();
    tasks.start('修 bug');
    await finish({ exitCode: 0, done: done('改好了\n总结：修好了加法'), stderrTail: '' });
    expect(finished[0]).toMatchObject({ status: 'succeeded', summary: '修好了加法', endedAt: 5000 });
    expect(tasks.start('写文档').accepted).toBe(true);
    expect(startTask).toHaveBeenCalledTimes(2);
  });

  it('result 标记错误时判为失败', async () => {
    const { tasks, finish, finished } = setup();
    tasks.start('修 bug');
    await finish({ exitCode: 0, done: done('总结：没找到文件', true), stderrTail: '' });
    expect(finished[0]).toMatchObject({ status: 'failed', summary: '任务失败：没找到文件' });
  });

  it('非零退出且没有 result 时用 stderr 最后一行作摘要', async () => {
    const { tasks, finish, finished } = setup();
    tasks.start('修 bug');
    await finish({ exitCode: 1, stderrTail: 'warn\nAPI key 无效\n', done: undefined });
    expect(finished[0]).toMatchObject({ status: 'failed', summary: '任务失败：API key 无效' });
  });

  it('stop 终止当前任务', () => {
    const { tasks, kill } = setup();
    tasks.start('修 bug');
    tasks.stop();
    expect(kill).toHaveBeenCalled();
  });
});
