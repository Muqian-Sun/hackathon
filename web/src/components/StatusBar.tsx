import type { LinxStatus } from '../../../bridge/src/protocol';
import type { MicState } from '../useVoiceBridge';

interface Props {
  bridgeOpen: boolean;
  linx: LinxStatus;
  mic: MicState;
  speaking: boolean;
  onStart: () => void;
  onStop: () => void;
}

const LINX_LABEL: Record<LinxStatus, string> = { disconnected: '未连接', connecting: '连接中', connected: '已连接' };

function voiceHint(mic: MicState, speaking: boolean): { text: string; tone: string } {
  if (speaking) return { text: '灵矽在说话', tone: 'speaking' };
  if (mic === 'on') return { text: '正在听，请说出你的需求', tone: 'listening' };
  if (mic === 'starting') return { text: '正在打开麦克风', tone: 'idle' };
  return { text: '点「开始」后直接说话', tone: 'idle' };
}

export function StatusBar({ bridgeOpen, linx, mic, speaking, onStart, onStop }: Props) {
  const hint = voiceHint(mic, speaking);
  return (
    <header className="status-bar">
      <h1>灵矽语音编程助手</h1>
      <div className={`voice-hint ${hint.tone}`}>
        <span className="dot" />
        {hint.text}
      </div>
      <div className="chips">
        <span className={`chip ${bridgeOpen ? 'ok' : 'bad'}`}>本机服务 {bridgeOpen ? '已连接' : '未连接'}</span>
        <span className={`chip ${linx === 'connected' ? 'ok' : linx === 'connecting' ? 'warn' : 'muted'}`}>灵矽 {LINX_LABEL[linx]}</span>
        {mic === 'on' ? (
          <button key="stop" className="btn secondary" onClick={onStop}>
            停止收音
          </button>
        ) : (
          <button key="start" className="btn primary" onClick={onStart} disabled={mic === 'starting' || !bridgeOpen}>
            开始
          </button>
        )}
      </div>
    </header>
  );
}
