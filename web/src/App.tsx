import { Conversation } from './components/Conversation';
import { StatusBar } from './components/StatusBar';
import { TaskPanel } from './components/TaskPanel';
import { useVoiceBridge } from './useVoiceBridge';

export function App() {
  const { state, mic, micError, startMic, stopMic, sendText } = useVoiceBridge();
  return (
    <div className="app">
      <StatusBar
        bridgeOpen={state.bridgeOpen}
        linx={state.linx}
        mic={mic}
        speaking={state.speaking}
        agent={state.agent}
        onStart={startMic}
        onStop={stopMic}
      />
      <main className="layout">
        <Conversation conversation={state.conversation} micError={micError} onSend={sendText} />
        <TaskPanel task={state.task} steps={state.steps} agent={state.agent} />
      </main>
    </div>
  );
}
