import type { Focus } from '../focus';
import { shortPath } from '../timeline';
import { DiffView } from './Timeline';

const FOCUS_DIFF_LINES = 14;
const FOCUS_OUTPUT_LINES = 10;

/** 大屏模式下放大显示当前焦点，几米外也能看清正在改什么、跑出了什么 */
export function FocusCard({ focus }: { focus: Focus }) {
  if (focus.kind === 'diff') {
    return (
      <section className="focus">
        <div className="focus-title">
          正在修改 <code>{shortPath(focus.file)}</code>
        </div>
        <DiffView before={focus.before} after={focus.after} limit={FOCUS_DIFF_LINES} />
      </section>
    );
  }
  const state = focus.output === undefined ? '正在执行' : focus.isError ? '执行失败' : '执行完成';
  const tail = focus.output?.trimEnd().split('\n').slice(-FOCUS_OUTPUT_LINES).join('\n');
  return (
    <section className={`focus ${focus.isError ? 'error' : ''}`}>
      <div className="focus-title">
        {state} <code>{focus.command}</code>
      </div>
      {tail && <pre className="focus-output">{tail}</pre>}
    </section>
  );
}
