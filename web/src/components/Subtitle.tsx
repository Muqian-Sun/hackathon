import type { Utterance } from '../state';

/** 大屏底部字幕：最近一句对话，灵矽说话时实时显示它正在说的内容 */
export function Subtitle({ last, speaking }: { last?: Utterance; speaking: boolean }) {
  if (!last) return null;
  return (
    <footer className={`subtitle ${last.role} ${speaking && last.role === 'assistant' ? 'live' : ''}`}>
      <span className="who">{last.role === 'user' ? '你' : '灵矽'}</span>
      <span className="text">{last.text}</span>
    </footer>
  );
}
