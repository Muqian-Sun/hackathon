import type { TimelineItem } from './timeline';

type ToolItem = Extract<TimelineItem, { kind: 'tool' }>;

export type Focus =
  | { kind: 'diff'; file: string; before: string; after: string }
  | { kind: 'command'; command: string; output?: string; isError?: boolean };

/** 大屏上放大显示的当前焦点：最近一次改动的 diff，或最近一条命令及其输出 */
export function pickFocus(items: TimelineItem[]): Focus | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind !== 'tool') continue;
    if (item.diff) return { kind: 'diff', ...item.diff };
    if (item.name === 'Bash') return { kind: 'command', command: item.summary, output: item.result?.output, isError: item.result?.isError };
  }
  return undefined;
}

export interface TestSummary {
  passed: number;
  failed: number;
}

const num = (s: string | undefined) => (s ? Number(s) : 0);

/**
 * 从命令输出里识别测试结果。各测试框架的输出格式没有统一标准，这里按常见格式逐个匹配：
 * vitest、jest、pytest、unittest、go test -v，最后是逐行 PASS/FAIL 的格式。识别不出时返回 undefined。
 */
export function parseTestSummary(output: string): TestSummary | undefined {
  // vitest: "Tests  1 failed | 3 passed (4)" / "Tests  3 passed (3)"
  let m = /Tests\s+(?:(\d+) failed \| )?(\d+) passed \(\d+\)/.exec(output);
  if (m) return { passed: num(m[2]), failed: num(m[1]) };
  m = /Tests\s+(\d+) failed \(\d+\)/.exec(output);
  if (m) return { passed: 0, failed: num(m[1]) };

  // jest: "Tests:       1 failed, 3 passed, 4 total"
  m = /Tests:\s+(.*\d+ total)/.exec(output);
  if (m) return { passed: num(/(\d+) passed/.exec(m[1]!)?.[1]), failed: num(/(\d+) failed/.exec(m[1]!)?.[1]) };

  // pytest: "=== 1 failed, 2 passed in 0.12s ===" / "3 passed in 0.01s"
  m = /^.*\b\d+ (?:passed|failed)\b.* in [\d.]+s.*$/m.exec(output);
  if (m) {
    const line = m[0];
    const failed = num(/(\d+) failed/.exec(line)?.[1]) + num(/(\d+) errors?/.exec(line)?.[1]);
    return { passed: num(/(\d+) passed/.exec(line)?.[1]), failed };
  }

  // unittest: "Ran 4 tests in 0.001s" + "OK" / "FAILED (failures=1, errors=1)"
  m = /^Ran (\d+) tests? in/m.exec(output);
  if (m) {
    const ran = num(m[1]);
    const f = /^FAILED \(([^)]*)\)/m.exec(output)?.[1] ?? '';
    const failed = num(/failures=(\d+)/.exec(f)?.[1]) + num(/errors=(\d+)/.exec(f)?.[1]);
    return { passed: ran - failed, failed };
  }

  // go test -v: "--- PASS: TestX" / "--- FAIL: TestY"
  const goPass = output.match(/^\s*--- PASS:/gm)?.length ?? 0;
  const goFail = output.match(/^\s*--- FAIL:/gm)?.length ?? 0;
  if (goPass + goFail > 0) return { passed: goPass, failed: goFail };

  // 逐行 "PASS test_x" / "FAIL test_y"（如演示项目的 test_app.py）
  const pass = output.match(/^(?:PASS|✓) \S/gm)?.length ?? 0;
  const fail = output.match(/^(?:FAIL|✗) \S/gm)?.length ?? 0;
  if (pass + fail > 0) return { passed: pass, failed: fail };
  return undefined;
}

/** 时间线里最近一次能识别出结果的测试命令 */
export function latestTestSummary(items: TimelineItem[]): TestSummary | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind !== 'tool' || item.name !== 'Bash' || !item.result) continue;
    const summary = parseTestSummary((item as ToolItem).result!.output);
    if (summary) return summary;
  }
  return undefined;
}
