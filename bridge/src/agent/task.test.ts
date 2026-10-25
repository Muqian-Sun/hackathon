import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, TaskState } from '../protocol.js';
import type { RunOutcome } from './claude.js';
import { TaskManager } from './task.js';

function setup(timeoutMs?: number) {
  let resolve!: (o: RunOutcome) => void;
  let emit!: (e: AgentEvent) => void;
  // 模拟进程被终止后以信号退出
  const kill = vi.fn(() => resolve({ exitCode: null, stderrTail: '', done: undefined }));
  const startTask = vi.fn((_instruction: string, onEvent: (e: AgentEvent) => void, _resume?: string) => {
    emit = onEvent;
    return { outcome: new Promise<RunOutcome>((r) => (resolve = r)), kill };
  });
  let t = 1000;
  const tasks = new TaskManager(startTask, { now: () => t, timeoutMs });
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
    expect(startTask).toHaveBeenCalledWith('修 bug', expect.any(Function), undefined);
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
    expect(finished[0]!.error).toBeUndefined();
    expect(tasks.start('写文档').accepted).toBe(true);
    expect(startTask).toHaveBeenCalledTimes(2);
  });

  it('result 标记错误时播报 Claude 给出的原因，stderr 放进 error', async () => {
    const { tasks, finish, finished } = setup();
    tasks.start('修 bug');
    await finish({ exitCode: 0, done: done('总结：没找到文件', true), stderrTail: 'warn\n' });
    expect(finished[0]).toMatchObject({ status: 'failed', summary: '任务失败：没找到文件', error: 'warn' });
  });

  it('异常退出且没有 result 时只播报「看屏幕」，stderr 末尾几行放进 error', async () => {
    const { tasks, finish, finished } = setup();
    tasks.start('修 bug');
    const stderr = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n');
    await finish({ exitCode: 1, stderrTail: `${stderr}\n`, done: undefined });
    expect(finished[0]).toMatchObject({ status: 'failed', summary: '任务失败，详情请看屏幕' });
    expect(finished[0]!.error!.split('\n')).toEqual(['line2', 'line3', 'line4', 'line5', 'line6', 'line7', 'line8', 'line9']);
  });

  it('没有 stderr 时 error 写退出码', async () => {
    const { tasks, finish, finished } = setup();
    tasks.start('修 bug');
    await finish({ exitCode: 2, stderrTail: '', done: undefined });
    expect(finished[0]!.error).toBe('退出码 2');
  });

  it('超时后终止进程，记为失败并播报已中止', async () => {
    const { tasks, kill, finished } = setup(30);
    tasks.start('修 bug');
    await vi.waitFor(() => expect(finished).toHaveLength(1));
    expect(kill).toHaveBeenCalledTimes(1);
    expect(finished[0]).toMatchObject({ status: 'failed' });
    expect(finished[0]!.summary).toBe('任务超过 0 秒没有完成，已经中止');
  });

  it('按时结束的任务不会被超时终止', async () => {
    const { tasks, finish, kill } = setup(50);
    tasks.start('修 bug');
    await finish({ exitCode: 0, done: done('总结：好了'), stderrTail: '' });
    await new Promise((r) => setTimeout(r, 80));
    expect(kill).not.toHaveBeenCalled();
  });

  it('cancel 中止执行中的任务，记为已停止', async () => {
    const { tasks, kill, finished } = setup();
    tasks.start('修 bug');
    expect(tasks.cancel()).toBe(true);
    expect(kill).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(finished).toHaveLength(1));
    expect(finished[0]).toMatchObject({ status: 'cancelled', summary: '任务已按要求停止' });
    expect(finished[0]!.error).toBeUndefined();
  });

  it('没有执行中的任务时 cancel 返回 false', async () => {
    const { tasks, finish, kill } = setup();
    expect(tasks.cancel()).toBe(false);
    tasks.start('修 bug');
    await finish({ exitCode: 0, done: done('总结：好了'), stderrTail: '' });
    expect(tasks.cancel()).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it('中止过的任务不影响下一个任务的失败判定', async () => {
    const { tasks, finished, finish } = setup();
    tasks.start('第一个');
    tasks.cancel();
    await vi.waitFor(() => expect(finished).toHaveLength(1));
    tasks.start('第二个');
    await finish({ exitCode: 1, stderrTail: 'boom', done: undefined });
    await vi.waitFor(() => expect(finished).toHaveLength(2));
    expect(finished[1]).toMatchObject({ status: 'failed', summary: '任务失败，详情请看屏幕' });
  });

  describe('多轮接续', () => {
    const ok = { exitCode: 0, done: done('总结：好了'), stderrTail: '' };
    const finishNth = async (s: ReturnType<typeof setup>, n: number, o: RunOutcome) => {
      await s.finish(o);
      await vi.waitFor(() => expect(s.finished).toHaveLength(n));
    };

    it('第一个任务开新会话，之后默认接着上一个会话', async () => {
      const s = setup();
      expect(s.tasks.start('修 bug')).toMatchObject({ task: { resumed: false } });
      expect(s.startTask.mock.calls[0]![2]).toBeUndefined();
      s.emit({ kind: 'start', sessionId: 'sess-1', model: 'm' });
      await finishNth(s, 1, ok);

      expect(s.tasks.start('再改一下')).toMatchObject({ task: { resumed: true } });
      expect(s.startTask.mock.calls[1]![2]).toBe('sess-1');
    });

    it('用户说新任务时开新会话', async () => {
      const s = setup();
      s.tasks.start('修 bug');
      s.emit({ kind: 'start', sessionId: 'sess-1', model: 'm' });
      await finishNth(s, 1, ok);
      expect(s.tasks.start('写文档', { newSession: true })).toMatchObject({ task: { resumed: false } });
      expect(s.startTask.mock.calls[1]![2]).toBeUndefined();
    });

    it('接续的会话失效（没有 start 事件就失败）时清掉，下一次开新会话', async () => {
      const s = setup();
      s.tasks.start('修 bug');
      s.emit({ kind: 'start', sessionId: 'sess-1', model: 'm' });
      await finishNth(s, 1, ok);
      s.tasks.start('再改一下');
      await finishNth(s, 2, { exitCode: 1, stderrTail: 'No conversation found', done: undefined });
      s.tasks.start('第三次');
      expect(s.startTask.mock.calls[2]![2]).toBeUndefined();
    });

    it('接续的任务失败但会话有效时，下一次仍然接续', async () => {
      const s = setup();
      s.tasks.start('修 bug');
      s.emit({ kind: 'start', sessionId: 'sess-1', model: 'm' });
      await finishNth(s, 1, ok);
      s.tasks.start('再改一下');
      s.emit({ kind: 'start', sessionId: 'sess-1', model: 'm' });
      await finishNth(s, 2, { exitCode: 1, stderrTail: 'boom', done: undefined });
      s.tasks.start('第三次');
      expect(s.startTask.mock.calls[2]![2]).toBe('sess-1');
    });
  });

  it('stop 终止当前任务', () => {
    const { tasks, kill } = setup();
    tasks.start('修 bug');
    tasks.stop();
    expect(kill).toHaveBeenCalled();
  });
});
