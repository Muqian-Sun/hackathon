import { describe, expect, it } from 'vitest';
import { FRAME_SAMPLES, PcmFramer, int16ToFloat32 } from './pcm';

describe('PcmFramer', () => {
  it('攒满 320 个采样才出一帧，余下的留到下次', () => {
    const framer = new PcmFramer();
    expect(framer.push(new Float32Array(128))).toHaveLength(0);
    expect(framer.push(new Float32Array(128))).toHaveLength(0);
    const frames = framer.push(new Float32Array(128).fill(0.5));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toHaveLength(FRAME_SAMPLES);
    expect(frames[0]![255]).toBe(0);
    expect(frames[0]![256]).toBe(Math.trunc(0.5 * 0x7fff));
    expect(framer.push(new Float32Array(FRAME_SAMPLES - 64))).toHaveLength(1);
  });

  it('超出范围的采样被截到 ±1，正负满幅分别映射到 Int16 两端', () => {
    const [frame] = new PcmFramer().push(Float32Array.from({ length: FRAME_SAMPLES }, (_, i) => (i === 0 ? 2 : i === 1 ? -2 : i === 2 ? -1 : 0)));
    expect([frame![0], frame![1], frame![2]]).toEqual([0x7fff, -0x8000, -0x8000]);
  });

  it('每帧是独立的缓冲区', () => {
    const framer = new PcmFramer();
    const [a] = framer.push(new Float32Array(FRAME_SAMPLES).fill(0.1));
    const [b] = framer.push(new Float32Array(FRAME_SAMPLES).fill(-0.1));
    expect(a![0]).toBeGreaterThan(0);
    expect(b![0]).toBeLessThan(0);
  });
});

describe('int16ToFloat32', () => {
  it('两端映射回 ±1', () => {
    expect(Array.from(int16ToFloat32(Int16Array.from([0x7fff, -0x8000, 0])))).toEqual([1, -1, 0]);
  });
});
