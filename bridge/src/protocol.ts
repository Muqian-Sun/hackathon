/**
 * 桥接服务与网页之间共用的消息类型（docs/architecture.md 4.2 节）。
 * 只放类型、不依赖 Node，网页直接从这里导入。
 */

export type LinxStatus = 'disconnected' | 'connecting' | 'connected';
export type TtsEvent = { state: 'start' | 'stop' } | { state: 'sentence'; text: string };

export type AgentEvent =
  | { kind: 'start'; sessionId: string; model: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; summary: string }
  | { kind: 'diff'; id: string; file: string; before: string; after: string }
  | { kind: 'tool_result'; id: string; isError: boolean; output: string }
  | { kind: 'done'; isError: boolean; result: string; durationMs: number; costUsd: number };

export interface TaskState {
  id: string;
  instruction: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  startedAt: number;
  endedAt?: number;
  /** 结束后的一句话摘要，用于语音播报 */
  summary?: string;
  /** 失败时的错误细节，只显示在屏幕上 */
  error?: string;
}

/** 桥接服务 → 网页的 JSON 消息；二进制帧是 16kHz 单声道 16 位 PCM */
export type ServerMessage =
  | { type: 'linx'; status: LinxStatus }
  | { type: 'stt'; text: string }
  | { type: 'tts'; state: 'start' | 'stop' }
  | { type: 'tts'; state: 'sentence'; text: string }
  | { type: 'task'; task: TaskState }
  | { type: 'agent'; event: AgentEvent };

/** 网页 → 桥接服务的 JSON 消息；二进制帧是麦克风 PCM */
export type ClientMessage = { type: 'mic'; on: boolean } | { type: 'text'; text: string };
