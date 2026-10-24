import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface DeviceIdentity {
  /** 灵矽要求 MAC 地址格式，服务端按它校验绑定状态 */
  deviceId: string;
  clientId: string;
}

/** 放在仓库外，换 worktree 或重新 clone 后设备身份不变，不必重新绑定 */
export const DEFAULT_DEVICE_FILE = pathToFileURL(join(homedir(), '.voice-coder', 'linx-device.json'));

/** 生成本地管理（locally administered）的单播 MAC，避免和真实网卡地址冲突 */
export function generateMac(bytes: Buffer = randomBytes(6)): string {
  const b = Buffer.from(bytes.subarray(0, 6));
  b[0] = (b[0]! | 0x02) & 0xfe;
  return [...b].map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

export async function loadOrCreateDevice(file: URL = DEFAULT_DEVICE_FILE): Promise<DeviceIdentity> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<DeviceIdentity>;
    if (typeof parsed.deviceId !== 'string' || typeof parsed.clientId !== 'string') {
      throw new Error(`${file.pathname} 缺少 deviceId 或 clientId`);
    }
    return { deviceId: parsed.deviceId, clientId: parsed.clientId };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const device: DeviceIdentity = { deviceId: generateMac(), clientId: randomUUID() };
  await mkdir(new URL('.', file), { recursive: true });
  await writeFile(file, JSON.stringify(device, null, 2) + '\n');
  return device;
}
