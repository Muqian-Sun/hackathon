import { SAMPLE_RATE, int16ToFloat32 } from './pcm';

/** 断流后重新开始播放前预留的缓冲，避免一帧一帧卡顿 */
const START_LATENCY_S = 0.12;

/** 按到达顺序无缝播放 16kHz Int16 PCM 帧 */
export class PcmPlayer {
  private readonly ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  private nextTime = 0;
  private readonly sources = new Set<AudioBufferSourceNode>();

  /** 浏览器要求在用户点击后才能出声 */
  resume(): Promise<void> {
    return this.ctx.resume();
  }

  play(frame: ArrayBuffer): void {
    const samples = int16ToFloat32(new Int16Array(frame));
    if (samples.length === 0) return;
    const buffer = this.ctx.createBuffer(1, samples.length, SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.ctx.destination);
    const now = this.ctx.currentTime;
    if (this.nextTime < now) this.nextTime = now + START_LATENCY_S;
    src.start(this.nextTime);
    this.nextTime += buffer.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
  }

  stop(): void {
    for (const s of this.sources) s.stop();
    this.sources.clear();
    this.nextTime = 0;
  }
}
