import type { EventEmitter } from 'node:events';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { TaskManager } from './agent/task.js';
import type { LinxEvents } from './linx/client.js';
import type { AgentEvent, LinxStatus, ServerMessage, TaskState } from './protocol.js';

/** LinxClient 中服务端用到的部分，便于测试替换 */
export interface LinxLike extends EventEmitter<LinxEvents> {
  readonly status: LinxStatus;
  setListening(on: boolean): void;
  sendAudio(frame: Buffer): void;
  sendText(text: string): void;
}

export interface BridgeServerOptions {
  linx: LinxLike;
  tasks: TaskManager;
  port: number;
  /** 网页构建产物目录；不存在时首页提示先构建 */
  staticDir: string;
}

export interface BridgeServer {
  port: number;
  close: () => Promise<void>;
}

export const AGENT_HISTORY_LIMIT = 500;
/** 按消息条数计，一轮回复约 3–5 条（tts start / sentence / stop） */
export const CONVERSATION_HISTORY_LIMIT = 300;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  const file = normalize(join(root, urlPath === '/' ? 'index.html' : urlPath));
  if (file !== root && !file.startsWith(root + sep)) {
    res.writeHead(404).end();
    return;
  }
  for (const candidate of [file, join(root, 'index.html')]) {
    try {
      if (!(await stat(candidate)).isFile()) continue;
      res.writeHead(200, { 'Content-Type': MIME[extname(candidate)] ?? 'application/octet-stream' });
      res.end(await readFile(candidate));
      return;
    } catch {
      // 尝试下一个候选
    }
  }
  res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('网页尚未构建：请运行 pnpm build，或用 pnpm dev 启动开发服务器');
}

export async function startServer(opts: BridgeServerOptions): Promise<BridgeServer> {
  const { linx, tasks } = opts;
  const root = normalize(opts.staticDir);
  const http = createServer((req, res) => void serveStatic(root, req, res));
  const wss = new WebSocketServer({ server: http, path: '/ws' });
  const micOn = new Set<WebSocket>();
  let agentHistory: AgentEvent[] = [];
  const conversationHistory: ServerMessage[] = [];
  const remember = (msg: ServerMessage) => {
    conversationHistory.push(msg);
    if (conversationHistory.length > CONVERSATION_HISTORY_LIMIT) conversationHistory.shift();
    broadcast(msg);
  };

  const broadcast = (data: Buffer | ServerMessage) => {
    const payload = Buffer.isBuffer(data) ? data : JSON.stringify(data);
    for (const c of wss.clients) if (c.readyState === c.OPEN) c.send(payload);
  };
  const sendTo = (ws: WebSocket, msg: ServerMessage) => ws.send(JSON.stringify(msg));
  const syncListening = () => linx.setListening(micOn.size > 0);

  const onStatus = (status: LinxStatus) => broadcast({ type: 'linx', status });
  const onStt = (text: string) => remember({ type: 'stt', text });
  const onTts = (e: LinxEvents['tts'][0]) => remember({ type: 'tts', ...e });
  const onAudio = (frame: Buffer) => broadcast(frame);
  const onTask = (task: TaskState) => {
    if (task.status === 'running') agentHistory = [];
    broadcast({ type: 'task', task });
  };
  const onAgent = (event: AgentEvent) => {
    agentHistory.push(event);
    if (agentHistory.length > AGENT_HISTORY_LIMIT) agentHistory.shift();
    broadcast({ type: 'agent', event });
  };
  linx.on('status', onStatus);
  linx.on('stt', onStt);
  linx.on('tts', onTts);
  linx.on('audio', onAudio);
  tasks.on('task', onTask);
  tasks.on('agent', onAgent);

  wss.on('connection', (ws) => {
    sendTo(ws, { type: 'linx', status: linx.status });
    for (const msg of conversationHistory) sendTo(ws, msg);
    if (tasks.current) sendTo(ws, { type: 'task', task: tasks.current });
    for (const event of agentHistory) sendTo(ws, { type: 'agent', event });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        linx.sendAudio(data as Buffer);
        return;
      }
      let msg: { type?: string; on?: unknown; text?: unknown };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === 'mic') {
        if (msg.on === true) micOn.add(ws);
        else micOn.delete(ws);
        syncListening();
      } else if (msg.type === 'text' && typeof msg.text === 'string' && msg.text.trim()) {
        linx.sendText(msg.text.trim());
      }
    });
    ws.on('close', () => {
      if (micOn.delete(ws)) syncListening();
    });
  });

  await new Promise<void>((resolve, reject) => {
    // WebSocketServer 会转发 http 的 error，两边都要接住，否则端口占用时进程直接崩溃
    http.once('error', reject);
    wss.once('error', reject);
    http.listen(opts.port, '127.0.0.1', resolve);
  });

  return {
    port: (http.address() as AddressInfo).port,
    close: async () => {
      linx.off('status', onStatus);
      linx.off('stt', onStt);
      linx.off('tts', onTts);
      linx.off('audio', onAudio);
      tasks.off('task', onTask);
      tasks.off('agent', onAgent);
      for (const c of wss.clients) c.terminate();
      wss.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
