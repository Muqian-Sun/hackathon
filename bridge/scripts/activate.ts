import { setTimeout as sleep } from 'node:timers/promises';
import { loadOrCreateDevice } from '../src/linx/device.js';
import { checkActivation, reportOta } from '../src/linx/ota.js';

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 10 * 60_000;

const device = await loadOrCreateDevice();
console.log(`设备 ID: ${device.deviceId}`);

let result = await reportOta(device);
if (result.status === 'unbound') {
  console.log(`\n激活码: ${result.activationCode}`);
  console.log('请在灵矽控制台「设备管理」中新增设备，填入上面的激活码并绑定到你的智能体。');
  console.log(`正在等待绑定（每 ${POLL_INTERVAL_MS / 1000} 秒查询一次，最多 ${POLL_TIMEOUT_MS / 60_000} 分钟）...`);
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (!(await checkActivation(device))) {
    if (Date.now() > deadline) {
      console.error('等待超时，绑定后重新运行 pnpm activate');
      process.exit(1);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  result = await reportOta(device);
  if (result.status !== 'bound') {
    console.error('激活接口显示已绑定，但 OTA 仍未返回 token，请稍后重试');
    process.exit(1);
  }
}
console.log(`\n已绑定。WebSocket 地址: ${result.wsUrl}，token 已就绪。`);
