import { useEffect, useRef } from 'react';

/** 内容变化时滚到底部，让大屏始终显示最新进展 */
export function useAutoScroll<T extends HTMLElement>(dep: unknown) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [dep]);
  return ref;
}
