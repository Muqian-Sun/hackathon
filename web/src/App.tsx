import { useState } from 'react';
import { useVoiceBridge } from './useVoiceBridge';

export function App() {
  const { state, mic, micError, startMic, stopMic, sendText } = useVoiceBridge();
  const [text, setText] = useState('');

  return (
    <main>
      <p>
        桥接服务：{state.bridgeOpen ? '已连接' : '未连接'} · 灵矽：{state.linx} · 麦克风：{mic}
        {state.speaking && ' · 灵矽正在说话'}
      </p>
      {mic === 'on' ? <button onClick={stopMic}>停止收音</button> : <button onClick={startMic}>开始</button>}
      {micError && <p>麦克风不可用：{micError}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          sendText(text);
          setText('');
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="也可以直接输入指令" />
      </form>
      <ul>
        {state.conversation.map((u) => (
          <li key={u.id}>
            {u.role === 'user' ? '你' : '灵矽'}：{u.text}
          </li>
        ))}
      </ul>
      {state.task && (
        <p>
          任务 {state.task.status}：{state.task.instruction} {state.task.summary}
        </p>
      )}
      <ol>
        {state.steps.map((s, i) => (
          <li key={i}>{s.kind}</li>
        ))}
      </ol>
    </main>
  );
}
