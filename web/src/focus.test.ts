import { describe, expect, it } from 'vitest';
import { latestTestSummary, parseTestSummary, pickFocus } from './focus';
import type { TimelineItem } from './timeline';

const bash = (id: string, command: string, output?: string, isError = false): TimelineItem => ({
  kind: 'tool', id, name: 'Bash', summary: command, ...(output !== undefined ? { result: { isError, output } } : {}),
});
const edit = (id: string): TimelineItem => ({
  kind: 'tool', id, name: 'Edit', summary: '/p/a.py', diff: { file: '/p/a.py', before: 'a', after: 'b' }, result: { isError: false, output: '' },
});

describe('parseTestSummary', () => {
  it.each([
    ['vitest 有失败', ' Test Files  1 failed (1)\n      Tests  1 failed | 3 passed (4)', { passed: 3, failed: 1 }],
    ['vitest 全通过', '      Tests  74 passed (74)', { passed: 74, failed: 0 }],
    ['vitest 全失败', '      Tests  2 failed (2)', { passed: 0, failed: 2 }],
    ['jest', 'Tests:       1 failed, 1 skipped, 3 passed, 5 total\nTime: 1s', { passed: 3, failed: 1 }],
    ['pytest 有失败', '===== 1 failed, 2 passed in 0.12s =====', { passed: 2, failed: 1 }],
    ['pytest -q 全通过', '...\n3 passed in 0.01s', { passed: 3, failed: 0 }],
    ['pytest 含 error', '== 1 passed, 2 errors in 0.30s ==', { passed: 1, failed: 2 }],
    ['unittest 通过', '....\n------\nRan 4 tests in 0.001s\n\nOK', { passed: 4, failed: 0 }],
    ['unittest 失败', 'Ran 5 tests in 0.002s\n\nFAILED (failures=1, errors=1)', { passed: 3, failed: 2 }],
    ['go test -v', '=== RUN   TestA\n--- PASS: TestA (0.00s)\n=== RUN   TestB\n--- FAIL: TestB (0.00s)\nFAIL', { passed: 1, failed: 1 }],
    ['逐行 PASS/FAIL', 'PASS test_greet\nFAIL test_add: AssertionError()\nPASS test_average\n', { passed: 2, failed: 1 }],
  ])('%s', (_name, output, expected) => {
    expect(parseTestSummary(output)).toEqual(expected);
  });

  it('不是测试输出时返回 undefined', () => {
    expect(parseTestSummary('total 8\ndrwxr-xr-x  3 me  staff  96 calc.py')).toBeUndefined();
    expect(parseTestSummary('Python 3.12.11')).toBeUndefined();
  });
});

describe('latestTestSummary', () => {
  it('取最近一次能识别的测试结果，跳过普通命令和未完成的命令', () => {
    const items = [
      bash('1', 'python3 test_app.py', 'FAIL test_add\nPASS test_greet'),
      bash('2', 'python3 test_app.py', 'PASS test_add\nPASS test_greet'),
      bash('3', 'ls', 'calc.py'),
      bash('4', 'python3 test_app.py'),
    ];
    expect(latestTestSummary(items)).toEqual({ passed: 2, failed: 0 });
    expect(latestTestSummary([bash('1', 'ls', 'a')])).toBeUndefined();
  });

  it('只看命令输出，读文件的内容里出现 PASS 行不算', () => {
    const read: TimelineItem = { kind: 'tool', id: 'r', name: 'Read', summary: '/p/run.log', result: { isError: false, output: 'PASS a\nFAIL b' } };
    expect(latestTestSummary([read])).toBeUndefined();
  });
});

describe('pickFocus', () => {
  it('取最近的 diff 或命令，忽略读文件等其他工具', () => {
    const read: TimelineItem = { kind: 'tool', id: 'r', name: 'Read', summary: '/p/a.py', result: { isError: false, output: 'x' } };
    expect(pickFocus([edit('1'), read])).toEqual({ kind: 'diff', file: '/p/a.py', before: 'a', after: 'b' });
    expect(pickFocus([edit('1'), bash('2', 'pytest', '1 passed in 0.1s')])).toEqual({
      kind: 'command', command: 'pytest', output: '1 passed in 0.1s', isError: false,
    });
    expect(pickFocus([bash('1', 'pytest')])).toEqual({ kind: 'command', command: 'pytest', output: undefined, isError: undefined });
    expect(pickFocus([read, { kind: 'text', text: 'hi' }])).toBeUndefined();
  });
});
