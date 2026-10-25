import { diffRows, shortPath, toolLabel, type TimelineItem } from '../timeline';

const OUTPUT_PREVIEW_LINES = 4;

function DiffView({ before, after }: { before: string; after: string }) {
  const { rows, omitted } = diffRows(before, after);
  return (
    <pre className="diff">
      {rows.map((r, i) => (
        <div key={i} className={`diff-row ${r.type}`}>
          <span className="sign">{r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' '}</span>
          {r.text || ' '}
        </div>
      ))}
      {omitted > 0 && <div className="diff-row more">… 还有 {omitted} 行</div>}
    </pre>
  );
}

function ToolRow({ item }: { item: Extract<TimelineItem, { kind: 'tool' }> }) {
  const status = !item.result ? 'pending' : item.result.isError ? 'error' : 'ok';
  const preview = item.result && !item.diff ? item.result.output.split('\n').slice(0, OUTPUT_PREVIEW_LINES).join('\n') : '';
  return (
    <li className={`step tool ${status}`}>
      <div className="step-line">
        <span className="tool-name">{toolLabel(item.name)}</span>
        <code className="tool-target">{shortPath(item.summary)}</code>
        <span className="tool-status">{status === 'pending' ? '…' : status === 'error' ? '✗' : '✓'}</span>
      </div>
      {item.diff && <DiffView before={item.diff.before} after={item.diff.after} />}
      {status === 'error' && preview && <pre className="output">{preview}</pre>}
      {status === 'ok' && item.name === 'Bash' && preview && <pre className="output">{preview}</pre>}
    </li>
  );
}

export function Timeline({ items }: { items: TimelineItem[] }) {
  return (
    <ol className="steps">
      {items.map((item, i) => {
        switch (item.kind) {
          case 'start':
            return (
              <li key={i} className="step meta">
                Claude Code 已启动
              </li>
            );
          case 'thinking':
            return (
              <li key={i} className="step thinking">
                {item.text.length > 160 ? `${item.text.slice(0, 160)}…` : item.text}
              </li>
            );
          case 'text':
            return (
              <li key={i} className="step text">
                {item.text}
              </li>
            );
          case 'tool':
            return <ToolRow key={item.id} item={item} />;
          case 'done':
            return (
              <li key={i} className={`step meta ${item.isError ? 'error' : ''}`}>
                {item.isError ? '执行失败' : '执行完成'} · 用时 {Math.round(item.durationMs / 1000)} 秒
                {item.costUsd !== undefined && ` · 费用 $${item.costUsd.toFixed(2)}`}
              </li>
            );
        }
      })}
    </ol>
  );
}
