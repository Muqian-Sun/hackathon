import { EventEmitter, once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { RunOutcome } from './agent/process.js';
import { TaskManager } from './agent/task.js';
import type { LinxEvents } from './linx/client.js';
import type { AgentEvent, LinxStatus } from './protocol.js';
import { CONVERSATION_HISTORY_LIMIT, startServer, type BridgeServer, type LinxLike } from './server.js';

class FakeLinx extends EventEmitter<LinxEvents> implements LinxLike {
  status: LinxStatus = 'disconnected';
  setListening = vi.fn();
  sendAudio = vi.fn();
  sendText = vi.fn();
}

let server: BridgeServer | undefined;
const sockets: WebSocket[] = [];
afterEach(async () => {
  sockets.splice(0).forEach((s) => s.terminate());
  await server?.close();
  server = undefined;
});

async function setup(staticDir = '/nonexistent-dist') {
  const linx = new FakeLinx();
  let emitAgent!: (e: AgentEvent) => void;
  let resolveRun!: (o: RunOutcome) => void;
  const tasks = new TaskManager((_i, onEvent) => {
    emitAgent = onEvent;
    return { outcome: new Promise((r) => (resolveRun = r)), kill: () => {} };
  });
  server = await startServer({ linx, tasks, port: 0, staticDir });
  const base = `127.0.0.1:${server.port}`;
  const connect = async () => {
    const ws = new WebSocket(`ws://${base}/ws`);
    sockets.push(ws);
    const inbox: unknown[] = [];
    ws.on('message', (d, isBinary) => inbox.push(isBinary ? Buffer.from(d as Buffer) : JSON.parse(d.toString())));
    await once(ws, 'open');
    return { ws, inbox };
  };
  return { linx, tasks, connect, base, agent: (e: AgentEvent) => emitAgent(e), finish: (o: RunOutcome) => resolveRun(o) };
}

describe('startServer', () => {
  it('新连接收到灵矽状态快照，之后广播灵矽事件和语音', async () => {
    const { linx, connect } = await setup();
    linx.status = 'connected';
    const { inbox } = await connect();
    await vi.waitFor(() => expect(inbox).toContainEqual({ type: 'linx', status: 'connected' }));
    linx.emit('stt', '你好');
    linx.emit('tts', { state: 'sentence', text: '好的' });
    linx.emit('audio', Buffer.from([1, 2]));
    await vi.waitFor(() => expect(inbox).toHaveLength(4));
    expect(inbox.slice(1)).toEqual([
      { type: 'stt', text: '你好' },
      { type: 'tts', state: 'sentence', text: '好的' },
      Buffer.from([1, 2]),
    ]);
  });

  it('新连接先收到对话回放，语音帧不回放', async () => {
    const { linx, connect } = await setup();
    linx.emit('stt', '修 bug');
    linx.emit('tts', { state: 'start' });
    linx.emit('audio', Buffer.from([1]));
    linx.emit('tts', { state: 'sentence', text: '好的' });
    linx.emit('tts', { state: 'stop' });
    const { inbox } = await connect();
    await vi.waitFor(() => expect(inbox).toHaveLength(5));
    expect(inbox).toEqual([
      { type: 'linx', status: 'disconnected' },
      { type: 'stt', text: '修 bug' },
      { type: 'tts', state: 'start' },
      { type: 'tts', state: 'sentence', text: '好的' },
      { type: 'tts', state: 'stop' },
    ]);
  });

  it('对话回放有上限，保留最新的', async () => {
    const { linx, connect } = await setup();
    for (let i = 0; i < CONVERSATION_HISTORY_LIMIT + 3; i++) linx.emit('stt', String(i));
    const { inbox } = await connect();
    await vi.waitFor(() => expect(inbox).toHaveLength(CONVERSATION_HISTORY_LIMIT + 1));
    expect(inbox[1]).toEqual({ type: 'stt', text: '3' });
  });

  it('任一网页开着麦克风就保持收音，全部关闭或断开后停止', async () => {
    const { linx, connect } = await setup();
    const a = await connect();
    const b = await connect();
    a.ws.send(JSON.stringify({ type: 'mic', on: true }));
    b.ws.send(JSON.stringify({ type: 'mic', on: true }));
    b.ws.send(JSON.stringify({ type: 'mic', on: false }));
    await vi.waitFor(() => expect(linx.setListening).toHaveBeenCalledTimes(3));
    expect(linx.setListening.mock.calls.map((c) => c[0])).toEqual([true, true, true]);
    a.ws.close();
    await vi.waitFor(() => expect(linx.setListening).toHaveBeenLastCalledWith(false));
  });

  it('转发网页的音频和文字输入', async () => {
    const { linx, connect } = await setup();
    const { ws } = await connect();
    ws.send(Buffer.from([7, 8]));
    ws.send(JSON.stringify({ type: 'text', text: '  修 bug ' }));
    ws.send(JSON.stringify({ type: 'text', text: '   ' }));
    await vi.waitFor(() => expect(linx.sendText).toHaveBeenCalledWith('修 bug'));
    expect(linx.sendText).toHaveBeenCalledTimes(1);
    expect(Buffer.from(linx.sendAudio.mock.calls[0]![0])).toEqual(Buffer.from([7, 8]));
  });

  it('广播任务和 agent 事件，刷新后的网页能恢复当前任务的步骤', async () => {
    const { tasks, connect, agent } = await setup();
    const first = await connect();
    tasks.start('修 bug');
    agent({ kind: 'text', text: '在看代码' });
    await vi.waitFor(() =>
      expect(first.inbox).toContainEqual({ type: 'agent', event: { kind: 'text', text: '在看代码' } }),
    );
    expect(first.inbox).toContainEqual(expect.objectContaining({ type: 'task', task: expect.objectContaining({ status: 'running' }) }));

    const reloaded = await connect();
    await vi.waitFor(() => expect(reloaded.inbox).toHaveLength(3));
    expect(reloaded.inbox.slice(1)).toEqual([
      { type: 'task', task: expect.objectContaining({ instruction: '修 bug', status: 'running' }) },
      { type: 'agent', event: { kind: 'text', text: '在看代码' } },
    ]);
  });

  it('新任务开始时清空上一个任务的步骤', async () => {
    const { tasks, connect, agent, finish } = await setup();
    tasks.start('第一个');
    agent({ kind: 'text', text: '旧步骤' });
    const finished = once(tasks, 'finished');
    finish({ exitCode: 0, done: { kind: 'done', isError: false, result: '总结：好了', durationMs: 1, costUsd: 0 }, stderrTail: '' });
    await finished;
    tasks.start('第二个');
    const { inbox } = await connect();
    await vi.waitFor(() => expect(inbox).toHaveLength(2));
    expect(inbox[1]).toMatchObject({ type: 'task', task: { instruction: '第二个' } });
  });

  it('端口被占用时 startServer 拒绝而不是让进程崩溃', async () => {
    const { tasks } = await setup();
    await expect(startServer({ linx: new FakeLinx(), tasks, port: server!.port, staticDir: '/x' })).rejects.toThrow('EADDRINUSE');
  });

  it('托管网页静态文件，拒绝目录穿越，未构建时提示', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dist-'));
    await writeFile(join(dir, 'index.html'), '<h1>面板</h1>');
    await writeFile(join(dir, 'app.js'), 'console.log(1)');
    const { base } = await setup(dir);
    const index = await fetch(`http://${base}/`);
    expect(await index.text()).toBe('<h1>面板</h1>');
    const js = await fetch(`http://${base}/app.js`);
    expect(js.headers.get('content-type')).toContain('text/javascript');
    expect(await (await fetch(`http://${base}/some/route`)).text()).toBe('<h1>面板</h1>');
    expect((await fetch(`http://${base}/..%2f..%2fetc%2fpasswd`)).status).toBe(404);

    await server!.close();
    server = undefined;
    const missing = await setup('/nonexistent-dist');
    const res = await fetch(`http://${missing.base}/`);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('网页尚未构建');
  });
});
