/** 与灵矽约定的音频格式：16kHz 单声道 16 位，每帧 20ms */
export const SAMPLE_RATE = 16000;
export const FRAME_SAMPLES = 320;

/** 把任意长度的 Float32 采样攒成固定 320 个采样的 Int16 帧 */
export class PcmFramer {
  private buf = new Int16Array(FRAME_SAMPLES);
  private filled = 0;

  push(samples: Float32Array): Int16Array[] {
    const frames: Int16Array[] = [];
    for (const s of samples) {
      const clamped = Math.max(-1, Math.min(1, s));
      this.buf[this.filled++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      if (this.filled === FRAME_SAMPLES) {
        frames.push(this.buf);
        this.buf = new Int16Array(FRAME_SAMPLES);
        this.filled = 0;
      }
    }
    return frames;
  }
}

export function int16ToFloat32(pcm: Int16Array): Float32Array<ArrayBuffer> {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i]! / (pcm[i]! < 0 ? 0x8000 : 0x7fff);
  return out;
}
