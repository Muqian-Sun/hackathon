import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { startCapture, type Capture } from './audio/capture';
import { PcmPlayer } from './audio/player';
import { BridgeConnection, defaultBridgeUrl } from './bridge';
import { initialState, reducer } from './state';

export type MicState = 'off' | 'starting' | 'on' | 'error';

/** 连接桥接服务、收音、播放，并把服务端消息归约成界面状态 */
export function useVoiceBridge() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [mic, setMic] = useState<MicState>('off');
  const [micError, setMicError] = useState('');
  const bridge = useRef<BridgeConnection | null>(null);
  const player = useRef<PcmPlayer | null>(null);
  const capture = useRef<Capture | null>(null);
  const micOn = useRef(false);
  // 半双工：灵矽说话时不上传麦克风，避免外放的语音被当成用户说话
  const speaking = useRef(false);
  speaking.current = state.speaking;

  useEffect(() => {
    const conn = new BridgeConnection(defaultBridgeUrl(), {
      onOpenChange: (open) => {
        dispatch({ type: 'bridge', open });
        if (open && micOn.current) conn.send({ type: 'mic', on: true });
      },
      onMessage: (msg) => dispatch({ type: 'server', msg }),
      onAudio: (frame) => player.current?.play(frame),
    });
    bridge.current = conn;
    return () => {
      conn.close();
      capture.current?.stop();
    };
  }, []);

  const startMic = useCallback(async () => {
    setMic('starting');
    setMicError('');
    try {
      player.current ??= new PcmPlayer();
      await player.current.resume();
      capture.current = await startCapture((frame) => {
        if (!speaking.current) bridge.current?.sendAudio(frame);
      });
      micOn.current = true;
      bridge.current?.send({ type: 'mic', on: true });
      setMic('on');
    } catch (err) {
      setMic('error');
      setMicError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const stopMic = useCallback(() => {
    micOn.current = false;
    capture.current?.stop();
    capture.current = null;
    bridge.current?.send({ type: 'mic', on: false });
    setMic('off');
  }, []);

  const sendText = useCallback((text: string) => {
    if (!text.trim()) return;
    if (!player.current) {
      player.current = new PcmPlayer();
      void player.current.resume();
    }
    bridge.current?.send({ type: 'text', text });
  }, []);

  return { state, mic, micError, startMic, stopMic, sendText };
}
