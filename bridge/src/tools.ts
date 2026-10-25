import type { TaskManager } from './agent/task.js';
import type { AgentKind, TaskState } from './protocol.js';
import type { ToolDef } from './linx/mcp.js';

export const AGENT_LABEL: Record<AgentKind, string> = { claude: 'Claude Code', codex: 'Codex' };
const AGENT_KINDS = Object.keys(AGENT_LABEL) as AgentKind[];

const brief = (s: string, n = 30) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  return sec < 60 ? `${sec} 秒` : `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
}

function describe(task: TaskState, now: number): string {
  switch (task.status) {
    case 'running':
      return `正在执行：${brief(task.instruction)}，已运行 ${formatElapsed(now - task.startedAt)}。`;
    case 'cancelled':
      return '上一个任务已经按要求停止了。';
    default:
      return `上一个任务${task.status === 'succeeded' ? '已完成' : '没有成功'}：${task.summary ?? ''}`;
  }
}

/** 返回给灵矽大模型的文字不能写「已完成」，否则它会提前宣布任务完成 */
export function createCodingTools(tasks: TaskManager, now: () => number = Date.now): ToolDef[] {
  return [
    {
      name: 'self.coding.run_task',
      // 「调用前不要回复」与「一句话」两处措辞是实测出来的：否则灵矽会在调用前后各说一遍「已经开始」
      description: '把用户的编程需求交给本机的编程 agent（Claude Code 或 Codex）在项目里执行，例如写代码、改代码、查看项目、跑测试。用户问起项目和代码的问题（比如刚才改了什么、为什么这样改、某个文件里有什么）也调用本工具，编程 agent 记得之前做过的事。听到这类需求时先直接调用本工具，调用前不要回复用户。任务在后台执行，完成后会自动语音通知用户。',
      inputSchema: {
        type: 'object',
        properties: {
          instruction: { type: 'string', description: '整理后的完整中文编程指令' },
          new_task: {
            type: 'boolean',
            description: '只有用户明确说「新任务」「换个任务」「重新开始」时才填 true。默认不填，编程 agent 会记得之前做过的事，接着上一个任务继续',
          },
        },
        required: ['instruction'],
      },
      handler: async (args) => {
        const instruction = typeof args.instruction === 'string' ? args.instruction.trim() : '';
        if (!instruction) throw new Error('缺少 instruction 参数');
        const res = tasks.start(instruction, { newSession: args.new_task === true });
        // 完成播报会以「任务完成。…」进入灵矽的对话上下文，几轮后大模型会模仿这个句式抢先宣布完成（实测），所以要明确禁止
        if (res.accepted) return '已在后台开始执行，任务还没有完成，不要说已完成，完成后系统会自动播报。用一句不超过十个字的话告诉用户已经开始。';
        if (res.reason === 'duplicate') return '这个任务已经在后台执行中，完成后会主动语音通知用户。';
        return `上一个任务还在执行（${brief(res.task.instruction)}，已运行 ${formatElapsed(now() - res.task.startedAt)}），请等它结束，或者让用户说「停下」先中止它。`;
      },
    },
    {
      name: 'self.coding.stop_task',
      description: '用户要求停止、取消、中止、别改了、先停一下时调用，立即中止正在执行的编程任务。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async () =>
        tasks.cancel() ? '已经中止当前任务。用一句话告诉用户已经停下了。' : '当前没有正在执行的编程任务，不需要停止。',
    },
    {
      name: 'self.coding.switch_agent',
      description: '用户要求换成 Codex、换回 Claude Code 时调用，之后的编程任务交给所选的 agent。',
      inputSchema: {
        type: 'object',
        properties: { agent: { type: 'string', enum: AGENT_KINDS, description: 'claude 表示 Claude Code，codex 表示 Codex' } },
        required: ['agent'],
      },
      handler: async (args) => {
        const agent = args.agent as AgentKind;
        if (!AGENT_KINDS.includes(agent)) throw new Error(`不支持的 agent: ${String(args.agent)}，可选 ${AGENT_KINDS.join('、')}`);
        if (agent === tasks.agent) return `当前已经是 ${AGENT_LABEL[agent]}，不需要切换。`;
        tasks.setAgent(agent);
        const running = tasks.current?.status === 'running' ? `正在执行的任务仍由 ${AGENT_LABEL[tasks.current.agent]} 完成，` : '';
        return `已切换到 ${AGENT_LABEL[agent]}，${running}之后的任务由 ${AGENT_LABEL[agent]} 来做。用一句话告诉用户。`;
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
