import { once } from 'node:events';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { LinxClient, type TtsEvent } from './client.js';
import type { ToolDef } from './mcp.js';

interface Conn {
  ws: WebSocket;
  headers: IncomingHttpHeaders;
  inbox: unknown[];
}

const echo: ToolDef = {
  name: 'self.echo',
  description: 'echo',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => 'ok',
};

let wss: WebSocketServer;
let conns: Conn[];
let client: LinxClient;

beforeEach(async () => {
  conns = [];
  wss = new WebSocketServer({ port: 0 });
  await once(wss, 'listening');
  wss.on('connection', (ws, req) => {
    const conn: Conn = { ws, headers: req.headers, inbox: [] };
    ws.on('message', (data, isBinary) => conn.inbox.push(isBinary ? Buffer.from(data as Buffer) : JSON.parse(data.toString())));
    conns.push(conn);
  });
  const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  client = new LinxClient({
    device: { deviceId: '02:00:00:00:00:01', clientId: 'cid' },
    getCredentials: async () => ({ wsUrl: url, token: 'tok' }),
    tools: [echo],
    reconnectDelaysMs: [0],
  });
});

afterEach(async () => {
  client.stop();
  for (const c of wss.clients) c.terminate();
  wss.close();
});

/** 等第 n 个连接发来 hello，服务端回 hello，返回该连接；beforeReply 在回 hello 之前执行 */
async function acceptConnection(n: number, beforeReply?: () => void): Promise<Conn> {
  await vi.waitFor(() => expect(conns.length).toBeGreaterThanOrEqual(n));
  const conn = conns[n - 1]!;
  await vi.waitFor(() => expect(conn.inbox[0]).toMatchObject({ type: 'hello' }));
  beforeReply?.();
  conn.ws.send(JSON.stringify({ type: 'hello', transport: 'websocket', session_id: `s${n}` }));
  await vi.waitFor(() => expect(client.status).toBe('connected'));
  return conn;
}

describe('LinxClient', () => {
  it('握手带鉴权请求头和 PCM hello，hello 后开始收音并转发音频', async () => {
    client.setListening(true);
    const conn = await acceptConnection(1, () => client.sendAudio(Buffer.from([9])));

    expect(conn.headers.authorization).toBe('Bearer tok');
    expect(conn.headers['device-id']).toBe('02:00:00:00:00:01');
    expect(conn.headers['client-id']).toBe('cid');
    expect(conn.headers['protocol-version']).toBe('1');
    expect(conn.inbox[0]).toMatchObject({ features: { mcp: true }, audio_params: { format: 'pcm', sample_rate: 16000 } });
    await vi.waitFor(() =>
      expect(conn.inbox).toContainEqual({ session_id: 's1', type: 'listen', state: 'start', mode: 'realtime' }),
    );

    client.sendAudio(Buffer.from([1, 2]));
    await vi.waitFor(() => expect(conn.inbox).toContainEqual(Buffer.from([1, 2])));
    expect(conn.inbox).not.toContainEqual(Buffer.from([9]));
  });

  it('应答灵矽的 MCP 请求', async () => {
    client.setListening(true);
    const conn = await acceptConnection(1);
    conn.ws.send(JSON.stringify({ type: 'mcp', payload: { jsonrpc: '2.0', id: 2, method: 'tools/list' } }));
    await vi.waitFor(() =>
      expect(conn.inbox).toContainEqual(
        expect.objectContaining({ type: 'mcp', payload: expect.objectContaining({ id: 2, result: expect.anything() }) }),
      ),
    );
  });

  it('丢弃 goodbye 之后的告别语，之后的语音照常转发', async () => {
    client.setListening(true);
    const conn = await acceptConnection(1);
    const audio: Buffer[] = [];
    const tts: TtsEvent[] = [];
    client.on('audio', (b) => audio.push(b));
    client.on('tts', (e) => tts.push(e));

    const j = (m: object) => conn.ws.send(JSON.stringify(m));
    j({ type: 'goodbye' });
    j({ type: 'tts', state: 'start' });
    conn.ws.send(Buffer.from([0xaa]));
    j({ type: 'tts', state: 'sentence_start', text: '再见' });
    j({ type: 'tts', state: 'stop' });
    j({ type: 'tts', state: 'start' });
    conn.ws.send(Buffer.from([0xbb]));
    j({ type: 'tts', state: 'sentence_start', text: '你好' });

    await vi.waitFor(() => expect(tts).toHaveLength(2));
    expect(tts).toEqual([{ state: 'start' }, { state: 'sentence', text: '你好' }]);
    expect(audio).toEqual([Buffer.from([0xbb])]);
  });

  it('收音中断线会重连并重新开始收音', async () => {
    client.setListening(true);
    const first = await acceptConnection(1);
    first.ws.close();
    const second = await acceptConnection(2);
    await vi.waitFor(() =>
      expect(second.inbox).toContainEqual({ session_id: 's2', type: 'listen', state: 'start', mode: 'realtime' }),
    );
  });

  it('未收音时为播报临时连接，发送后断开不再重连', async () => {
    client.announce('任务完成');
    const conn = await acceptConnection(1);
    await vi.waitFor(() =>
      expect(conn.inbox).toContainEqual(expect.objectContaining({ type: 'listen', state: 'detect', text_response: '任务完成' })),
    );
    client.sendAudio(Buffer.from([7]));
    await sleep(50);
    expect(conn.inbox.some((m) => Buffer.isBuffer(m))).toBe(false);
    conn.ws.close();
    await vi.waitFor(() => expect(client.status).toBe('disconnected'));
    await sleep(100);
    expect(conns).toHaveLength(1);
  });
});
