import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { LinxStatus, TtsEvent } from '../protocol.js';
import type { DeviceIdentity } from './device.js';
import { handleMcpRequest, type JsonRpcMessage, type ToolDef } from './mcp.js';

export const SAMPLE_RATE = 16000;
export const FRAME_MS = 20;
export const FRAME_BYTES = (SAMPLE_RATE * FRAME_MS) / 1000 * 2;

export interface LinxCredentials {
  wsUrl: string;
  token: string;
}


export interface LinxClientOptions {
  device: DeviceIdentity;
  /** 每次连接前调用，通常走 OTA 取最新 token */
  getCredentials: () => Promise<LinxCredentials>;
  tools: ToolDef[];
  reconnectDelaysMs?: number[];
  /** hello 之后等 tools/list 的最长时间，超时也视为就绪 */
  readyTimeoutMs?: number;
  log?: (msg: string) => void;
}

export interface LinxEvents {
  status: [LinxStatus];
  stt: [string];
  tts: [TtsEvent];
  audio: [Buffer];
}

type Outgoing = Record<string, unknown>;

const DEFAULT_RECONNECT_DELAYS_MS = [0, 1000, 2000, 5000, 10000];
const DEFAULT_READY_TIMEOUT_MS = 3000;

export class LinxClient extends EventEmitter<LinxEvents> {
  private ws: WebSocket | undefined;
  private sessionId = '';
  private _status: LinxStatus = 'disconnected';
  private listening = false;
  /** 收到 goodbye 后到下一次 tts stop 之间是告别语，不转发 */
  private suppressFarewell = false;
  private pending: Outgoing[] = [];
  /** 灵矽会把 text_response 当作 stt 回传，这些不是用户说的话 */
  private announced: string[] = [];
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private readyTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: LinxClientOptions) {
    super();
    this.log = opts.log ?? (() => {});
  }

  get status(): LinxStatus {
    return this._status;
  }

  /** 灵矽按会话时长计费：只在收音中或有待发消息时保持连接 */
  private get needsConnection(): boolean {
    return !this.stopped && (this.listening || this.pending.length > 0);
  }

  setListening(on: boolean): void {
    if (this.listening === on) return;
    this.listening = on;
    if (this._status === 'connected') this.send(this.listenMessage());
    else this.ensureConnected();
  }

  sendAudio(frame: Buffer): void {
    if (this.listening && this._status === 'connected') this.ws?.send(frame);
  }

  /** 文字当作用户输入交给灵矽，等同于说了这句话 */
  sendText(text: string): void {
    this.enqueue({ type: 'listen', state: 'detect', text });
  }

  /** 让灵矽原样播报一段文字；未连接时先连上再发 */
  announce(text: string): void {
    this.announced.push(text);
    this.enqueue({ type: 'listen', state: 'detect', text: '任务状态通知', text_response: text });
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.readyTimer);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.ws?.close();
  }

  private listenMessage(): Outgoing {
    return { type: 'listen', state: this.listening ? 'start' : 'stop', mode: 'realtime' };
  }

  private enqueue(msg: Outgoing): void {
    if (this._status === 'connected') this.send(msg);
    else {
      this.pending.push(msg);
      this.ensureConnected();
    }
  }

  private send(msg: Outgoing): void {
    this.ws?.send(JSON.stringify({ session_id: this.sessionId, ...msg }));
  }

  private setStatus(s: LinxStatus): void {
    if (this._status === s) return;
    this._status = s;
    this.emit('status', s);
  }

  private ensureConnected(): void {
    if (this._status === 'disconnected' && !this.reconnectTimer && this.needsConnection) void this.connect();
  }

  private async connect(): Promise<void> {
    this.setStatus('connecting');
    let creds: LinxCredentials;
    try {
      creds = await this.opts.getCredentials();
    } catch (err) {
      this.log(`获取灵矽凭证失败: ${(err as Error).message}`);
      this.handleClosed();
      return;
    }
    if (this.stopped) {
      this.setStatus('disconnected');
      return;
    }
    const ws = new WebSocket(creds.wsUrl, {
      headers: {
        Authorization: `Bearer ${creds.token}`,
        'Protocol-Version': '1',
        'Device-Id': this.opts.device.deviceId,
        'Client-Id': this.opts.device.clientId,
      },
    });
    this.ws = ws;
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'hello',
        version: 1,
        features: { mcp: true },
        transport: 'websocket',
        audio_params: {
          format: 'pcm', sample_rate: SAMPLE_RATE, channels: 1, bit_depth: 16, endianness: 'little',
          frame_duration: FRAME_MS, frame_size: FRAME_BYTES / 2, sample_format: 'signed_int16', play_buffer_duration: 1000,
        },
      }));
    });
    ws.on('message', (data, isBinary) => this.onMessage(data as Buffer, isBinary));
    ws.on('error', (err) => this.log(`灵矽连接错误: ${err.message}`));
    ws.on('close', (code) => {
      if (this.ws !== ws) return;
      this.log(`灵矽连接关闭: ${code}`);
      this.handleClosed();
    });
  }

  private handleClosed(): void {
    clearTimeout(this.readyTimer);
    this.readyTimer = undefined;
    this.ws = undefined;
    this.sessionId = '';
    this.suppressFarewell = false;
    this.setStatus('disconnected');
    if (!this.needsConnection) {
      this.attempt = 0;
      return;
    }
    const delays = this.opts.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
    const delay = delays[Math.min(this.attempt, delays.length - 1)]!;
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.needsConnection) void this.connect();
    }, delay);
  }

  private onMessage(data: Buffer, isBinary: boolean): void {
    if (isBinary) {
      if (!this.suppressFarewell) this.emit('audio', data);
      return;
    }
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      this.log(`无法解析的灵矽消息: ${data.toString().slice(0, 200)}`);
      return;
    }
    switch (msg.type) {
      case 'hello':
        this.sessionId = msg.session_id ?? '';
        this.attempt = 0;
        this.readyTimer = setTimeout(() => {
          this.log('hello 之后未收到 tools/list，按就绪处理');
          this.markReady();
        }, this.opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
        break;
      case 'goodbye':
        this.suppressFarewell = true;
        break;
      case 'stt': {
        if (typeof msg.text !== 'string') break;
        const idx = this.announced.indexOf(msg.text);
        if (idx >= 0) this.announced.splice(idx, 1);
        else this.emit('stt', msg.text);
        break;
      }
      case 'tts':
        if (msg.state === 'stop' && this.suppressFarewell) {
          this.suppressFarewell = false;
          break;
        }
        if (this.suppressFarewell) break;
        if (msg.state === 'start' || msg.state === 'stop') this.emit('tts', { state: msg.state });
        else if (msg.state === 'sentence_start' && typeof msg.text === 'string') this.emit('tts', { state: 'sentence', text: msg.text });
        break;
      case 'mcp':
        void this.onMcp(msg.payload as JsonRpcMessage);
        break;
    }
  }

  /**
   * 灵矽在 hello 后才拉取工具列表；在此之前发出的文字或语音会被大模型在没有工具的情况下处理，
   * 它会口头答应「已经开始」却不调用工具（实测）。所以回复 tools/list 之后才算就绪。
   */
  private markReady(): void {
    clearTimeout(this.readyTimer);
    this.readyTimer = undefined;
    if (this._status === 'connected' || !this.ws) return;
    this.setStatus('connected');
    if (this.listening) this.send(this.listenMessage());
    for (const m of this.pending.splice(0)) this.send(m);
  }

  private async onMcp(req: JsonRpcMessage): Promise<void> {
    this.log(`MCP ← ${JSON.stringify(req).slice(0, 300)}`);
    const res = await handleMcpRequest(this.opts.tools, req);
    if (res) {
      this.log(`MCP → ${JSON.stringify(res).slice(0, 300)}`);
      this.send({ type: 'mcp', payload: res });
    }
    if (req.method === 'tools/list') this.markReady();
  }
}
