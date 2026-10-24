import workletUrl from './capture-worklet.ts?worker&url';
import { SAMPLE_RATE } from './pcm';

export interface Capture {
  stop: () => void;
}

/**
 * 采集麦克风，按 20ms 一帧回调 16kHz Int16 PCM。
 * 重采样交给 AudioContext({ sampleRate: 16000 })，需要 Chrome、Edge 或 Safari。
 */
export async function startCapture(onFrame: (frame: ArrayBuffer) => void): Promise<Capture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  await ctx.audioWorklet.addModule(workletUrl);
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pcm-capture');
  node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => onFrame(e.data);
  // 接到静音的 destination 上，保证节点被音频图持续驱动
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(node).connect(mute).connect(ctx.destination);
  return {
    stop: () => {
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
  };
}
