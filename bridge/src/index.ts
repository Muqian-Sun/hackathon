import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runClaude } from './agent/claude.js';
import { TaskManager } from './agent/task.js';
import { LinxClient } from './linx/client.js';
import { loadOrCreateDevice } from './linx/device.js';
import { reportOta } from './linx/ota.js';
import { startServer } from './server.js';
import { createCodingTools } from './tools.js';

const log = (msg: string) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`);

if (!process.env.PROJECT_DIR) {
  console.error('请用 PROJECT_DIR 指定要让 Claude Code 修改的项目目录，例如 PROJECT_DIR=~/code/demo pnpm start');
  process.exit(1);
}
const projectDir = resolve(process.env.PROJECT_DIR);
if (!(await stat(projectDir).catch(() => undefined))?.isDirectory()) {
  console.error(`PROJECT_DIR 不是目录: ${projectDir}`);
  process.exit(1);
}
const port = Number(process.env.PORT ?? 8787);
const staticDir = fileURLToPath(new URL('../../web/dist', import.meta.url));

const device = await loadOrCreateDevice();
const tasks = new TaskManager((instruction, onEvent) => {
  log(`开始任务: ${instruction}`);
  return runClaude({ instruction, cwd: projectDir, onEvent, log });
});
const linx = new LinxClient({
  device,
  getCredentials: async () => {
    const r = await reportOta(device);
    if (r.status !== 'bound') throw new Error(`设备未绑定，请先运行 pnpm activate（激活码 ${r.activationCode}）`);
    return r;
  },
  tools: createCodingTools(tasks),
  log,
});

linx.on('status', (s) => log(`灵矽连接: ${s}`));
linx.on('stt', (text) => log(`识别: ${text}`));
tasks.on('finished', (task) => {
  log(`任务结束(${task.status}): ${task.summary}`);
  linx.announce(task.status === 'succeeded' ? `任务完成。${task.summary}` : task.summary ?? '任务失败');
});

const server = await startServer({ linx, tasks, port, staticDir });
log(`项目目录: ${projectDir}`);
log(`打开 http://localhost:${server.port}`);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  tasks.stop();
  linx.stop();
  await server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
