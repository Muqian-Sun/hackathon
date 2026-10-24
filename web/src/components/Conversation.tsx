import { useState } from 'react';
import type { Utterance } from '../state';
import { useAutoScroll } from '../useAutoScroll';

interface Props {
  conversation: Utterance[];
  micError: string;
  onSend: (text: string) => void;
}

export function Conversation({ conversation, micError, onSend }: Props) {
  const [text, setText] = useState('');
  const listRef = useAutoScroll<HTMLDivElement>(conversation);
  const submit = () => {
    onSend(text);
    setText('');
  };

  return (
    <section className="panel conversation">
      <h2>对话</h2>
      <div className="bubbles" ref={listRef}>
        {conversation.length === 0 && <p className="empty">比如说：「帮我给登录接口加上参数校验」</p>}
        {conversation.map((u) => (
          <div key={u.id} className={`bubble ${u.role}`}>
            <span className="who">{u.role === 'user' ? '你' : '灵矽'}</span>
            {u.text}
          </div>
        ))}
      </div>
      {micError && <p className="error">麦克风不可用：{micError}。仍可在下方输入文字。</p>}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="识别不准时，也可以直接输入指令" />
        <button type="submit" className="btn primary" disabled={!text.trim()}>
          发送
        </button>
      </form>
    </section>
  );
}
