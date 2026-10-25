import { Conversation } from './components/Conversation';
import { StatusBar } from './components/StatusBar';
import { Subtitle } from './components/Subtitle';
import { TaskPanel } from './components/TaskPanel';
import { useTvMode } from './useTvMode';
import { useVoiceBridge } from './useVoiceBridge';

export function App() {
  const { state, mic, micError, startMic, stopMic, sendText } = useVoiceBridge();
  const { tvMode, toggle } = useTvMode();
  return (
    <div className={`app ${tvMode ? 'tv' : ''}`}>
      <StatusBar
        bridgeOpen={state.bridgeOpen}
        linx={state.linx}
        mic={mic}
        speaking={state.speaking}
        agent={state.agent}
        tvMode={tvMode}
        onToggleTv={toggle}
        onStart={startMic}
        onStop={stopMic}
      />
      <main className="layout">
        <Conversation conversation={state.conversation} micError={micError} onSend={sendText} />
        <TaskPanel task={state.task} steps={state.steps} agent={state.agent} tvMode={tvMode} />
      </main>
      {tvMode && <Subtitle last={state.conversation.at(-1)} speaking={state.speaking} />}
    </div>
  );
}
