import type { AgentEvent, AgentKind, LinxStatus, ServerMessage, TaskState } from '../../bridge/src/protocol';

export const CONVERSATION_LIMIT = 50;
export const STEP_LIMIT = 500;

export interface Utterance {
  id: number;
  role: 'user' | 'assistant';
  text: string;
}

export interface UiState {
  bridgeOpen: boolean;
  linx: LinxStatus;
  /** 灵矽正在说话（tts start 到 tts stop 之间） */
  speaking: boolean;
  conversation: Utterance[];
  /** 下一个任务由哪个 agent 执行 */
  agent: AgentKind;
  task?: TaskState;
  steps: AgentEvent[];
  /** 当前这轮回复是否已有气泡，后续句子接在后面 */
  turnOpen: boolean;
  nextId: number;
}

export type UiAction = { type: 'bridge'; open: boolean } | { type: 'server'; msg: ServerMessage };

export const initialState: UiState = {
  bridgeOpen: false,
  linx: 'disconnected',
  speaking: false,
  conversation: [],
  agent: 'claude',
  steps: [],
  turnOpen: false,
  nextId: 1,
};

const capped = <T>(list: T[], limit: number) => (list.length > limit ? list.slice(list.length - limit) : list);

function say(state: UiState, role: Utterance['role'], text: string): UiState {
  return {
    ...state,
    conversation: capped([...state.conversation, { id: state.nextId, role, text }], CONVERSATION_LIMIT),
    nextId: state.nextId + 1,
  };
}

export function reducer(state: UiState, action: UiAction): UiState {
  if (action.type === 'bridge') {
    // 重连后服务端会重发对话、当前任务和步骤的快照，先清空避免重复
    return action.open
      ? { ...state, bridgeOpen: true, conversation: [], turnOpen: false, task: undefined, steps: [] }
      : { ...state, bridgeOpen: false, linx: 'disconnected', speaking: false, turnOpen: false };
  }
  const msg = action.msg;
  switch (msg.type) {
    case 'linx':
      return { ...state, linx: msg.status };
    case 'stt':
      return { ...say(state, 'user', msg.text), turnOpen: false };
    case 'tts':
      if (msg.state !== 'sentence') return { ...state, speaking: msg.state === 'start', turnOpen: false };
      if (state.turnOpen) {
        const last = state.conversation.at(-1)!;
        return { ...state, conversation: [...state.conversation.slice(0, -1), { ...last, text: last.text + msg.text }] };
      }
      return { ...say(state, 'assistant', msg.text), turnOpen: true };
    case 'task':
      return { ...state, task: msg.task, steps: msg.task.id === state.task?.id ? state.steps : [] };
    case 'agent':
      return { ...state, steps: capped([...state.steps, msg.event], STEP_LIMIT) };
    case 'selected_agent':
      return { ...state, agent: msg.agent };
  }
}
