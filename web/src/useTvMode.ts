import { useCallback, useState } from 'react';

const STORAGE_KEY = 'voice-coder:tv-mode';
/** 1080p 电视的视口宽度是 1920；笔记本常见 1280–1512 */
const TV_MIN_WIDTH = 1600;

/** 大屏模式：放大焦点、显示字幕。默认按窗口宽度判断，手动切换后记住选择 */
export function useTvMode() {
  const [tvMode, setTvMode] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === null ? window.innerWidth >= TV_MIN_WIDTH : saved === '1';
  });
  const toggle = useCallback(() => {
    setTvMode((v) => {
      localStorage.setItem(STORAGE_KEY, v ? '0' : '1');
      return !v;
    });
  }, []);
  return { tvMode, toggle };
}
