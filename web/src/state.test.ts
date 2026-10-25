import { describe, expect, it } from 'vitest';
import type { ServerMessage, TaskState } from '../../bridge/src/protocol';
import { CONVERSATION_LIMIT, STEP_LIMIT, initialState, reducer, type UiState } from './state';

const run = (msgs: ServerMessage[], from: UiState = initialState) =>
  msgs.reduce((s, msg) => reducer(s, { type: 'server', msg }), from);
const task = (id: string, status: TaskState['status'] = 'running'): TaskState => ({ id, instruction: `任务${id}`, status, startedAt: 0 });

describe('reducer', () => {
  it('识别结果成为用户发言，一轮回复的多句合并成一个气泡', () => {
    const s = run([
      { type: 'stt', text: '修 bug' },
      { type: 'tts', state: 'start' },
      { type: 'tts', state: 'sentence', text: '好的，' },
      { type: 'tts', state: 'sentence', text: '开始了。' },
      { type: 'tts', state: 'stop' },
      { type: 'tts', state: 'start' },
      { type: 'tts', state: 'sentence', text: '任务完成。' },
    ]);
    expect(s.conversation.map(({ role, text }) => [role, text])).toEqual([
      ['user', '修 bug'],
      ['assistant', '好的，开始了。'],
      ['assistant', '任务完成。'],
    ]);
    expect(s.speaking).toBe(true);
    expect(new Set(s.conversation.map((u) => u.id)).size).toBe(3);
  });

  it('tts stop 后不再说话', () => {
    expect(run([{ type: 'tts', state: 'start' }, { type: 'tts', state: 'stop' }]).speaking).toBe(false);
  });

  it('用户插话后，灵矽的下一句另起一个气泡', () => {
    const s = run([
      { type: 'tts', state: 'sentence', text: 'A' },
      { type: 'stt', text: '等等' },
      { type: 'tts', state: 'sentence', text: 'B' },
    ]);
    expect(s.conversation.map((u) => u.text)).toEqual(['A', '等等', 'B']);
  });

  it('新任务清空步骤，同一任务的状态更新保留步骤', () => {
    const s1 = run([
      { type: 'task', task: task('1') },
      { type: 'agent', event: { kind: 'text', text: 'x' } },
      { type: 'task', task: task('1', 'succeeded') },
    ]);
    expect(s1.steps).toHaveLength(1);
    expect(s1.task?.status).toBe('succeeded');
    const s2 = run([{ type: 'task', task: task('2') }], s1);
    expect(s2.steps).toEqual([]);
  });

  it('桥接重连时清空对话、任务和步骤，等服务端快照重新填充', () => {
    const s = run([
      { type: 'stt', text: '修 bug' },
      { type: 'tts', state: 'sentence', text: '好的' },
      { type: 'task', task: task('1') },
      { type: 'agent', event: { kind: 'text', text: 'x' } },
    ]);
    const reopened = reducer(reducer(s, { type: 'bridge', open: false }), { type: 'bridge', open: true });
    expect(reopened).toMatchObject({ bridgeOpen: true, steps: [], conversation: [], turnOpen: false });
    expect(reopened.task).toBeUndefined();
  });

  it('桥接断开时灵矽状态归为断开，停止说话', () => {
    const s = run([{ type: 'linx', status: 'connected' }, { type: 'tts', state: 'start' }]);
    expect(reducer(s, { type: 'bridge', open: false })).toMatchObject({ linx: 'disconnected', speaking: false });
  });

  it('对话和步骤都有上限，保留最新的', () => {
    const many = Array.from({ length: CONVERSATION_LIMIT + 5 }, (_, i): ServerMessage => ({ type: 'stt', text: String(i) }));
    const s = run(many);
    expect(s.conversation).toHaveLength(CONVERSATION_LIMIT);
    expect(s.conversation.at(-1)?.text).toBe(String(CONVERSATION_LIMIT + 4));
    const steps = Array.from({ length: STEP_LIMIT + 1 }, (_, i): ServerMessage => ({ type: 'agent', event: { kind: 'text', text: String(i) } }));
    expect(run(steps).steps[0]).toEqual({ kind: 'text', text: '1' });
  });
});
