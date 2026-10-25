import type { TaskManager } from './agent/task.js';
import type { TaskState } from './protocol.js';
import type { ToolDef } from './linx/mcp.js';

const brief = (s: string, n = 30) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  return sec < 60 ? `${sec} 秒` : `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
}

function describe(task: TaskState, now: number): string {
  if (task.status === 'running') return `正在执行：${brief(task.instruction)}，已运行 ${formatElapsed(now - task.startedAt)}。`;
  return `上一个任务${task.status === 'succeeded' ? '已完成' : '没有成功'}：${task.summary ?? ''}`;
}

/** 返回给灵矽大模型的文字不能写「已完成」，否则它会提前宣布任务完成 */
export function createCodingTools(tasks: TaskManager, now: () => number = Date.now): ToolDef[] {
  return [
    {
      name: 'self.coding.run_task',
      // 「调用前不要回复」与「一句话」两处措辞是实测出来的：否则灵矽会在调用前后各说一遍「已经开始」
      description: '把用户的编程需求交给 Claude Code 在本机项目里执行，例如写代码、改代码、查看项目、跑测试。听到编程需求时先直接调用本工具，调用前不要回复用户。任务在后台执行，完成后会自动语音通知用户。',
      inputSchema: {
        type: 'object',
        properties: { instruction: { type: 'string', description: '整理后的完整中文编程指令' } },
        required: ['instruction'],
      },
      handler: async (args) => {
        const instruction = typeof args.instruction === 'string' ? args.instruction.trim() : '';
        if (!instruction) throw new Error('缺少 instruction 参数');
        const res = tasks.start(instruction);
        if (res.accepted) return '已在后台开始执行，完成后会自动语音通知用户。用一句不超过十个字的话告诉用户已经开始。';
        if (res.reason === 'duplicate') return '这个任务已经在后台执行中，完成后会主动语音通知用户。';
        return `上一个任务还在执行（${brief(res.task.instruction)}，已运行 ${formatElapsed(now() - res.task.startedAt)}），请等它结束后再提新任务。`;
      },
    },
    {
      name: 'self.coding.get_status',
      description: '查询当前或上一个编程任务的进度和结果',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async () => (tasks.current ? describe(tasks.current, now()) : '当前没有编程任务。'),
    },
  ];
}
