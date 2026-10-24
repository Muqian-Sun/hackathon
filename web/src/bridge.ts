import type { ClientMessage, ServerMessage } from '../../bridge/src/protocol';

const RECONNECT_MS = 1000;

export interface BridgeHandlers {
  onOpenChange: (open: boolean) => void;
  onMessage: (msg: ServerMessage) => void;
  onAudio: (frame: ArrayBuffer) => void;
}

export const defaultBridgeUrl = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

/** 与本地桥接服务的连接，断开后每秒重连 */
export class BridgeConnection {
  private ws: WebSocket | undefined;
  private closed = false;
  private retry: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly url: string,
    private readonly handlers: BridgeHandlers,
  ) {
    this.connect();
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  sendAudio(frame: ArrayBuffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(frame);
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.retry);
    this.ws?.close();
  }

  private connect(): void {
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => this.handlers.onOpenChange(true);
    ws.onmessage = (e: MessageEvent<string | ArrayBuffer>) => {
      if (typeof e.data === 'string') this.handlers.onMessage(JSON.parse(e.data) as ServerMessage);
      else this.handlers.onAudio(e.data);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.handlers.onOpenChange(false);
      if (!this.closed) this.retry = setTimeout(() => this.connect(), RECONNECT_MS);
    };
  }
}
