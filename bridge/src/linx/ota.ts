import type { DeviceIdentity } from './device.js';

export const OTA_URL = 'https://xrobo.qiniuapi.com/v1/ota/';
export const ACTIVATE_URL = 'https://xrobo.qiniuapi.com/v1/ota/activate';

const APP_NAME = 'voice-coder';
const APP_VERSION = '0.1.0';

export type OtaResult =
  | { status: 'unbound'; activationCode: string; wsUrl: string }
  | { status: 'bound'; wsUrl: string; token: string };

export function buildOtaRequest(device: DeviceIdentity): { headers: Record<string, string>; body: unknown } {
  return {
    headers: {
      'Activation-Version': '1',
      'Device-Id': device.deviceId,
      'Client-Id': device.clientId,
      'User-Agent': `${APP_NAME}/${APP_VERSION}`,
      'Accept-Language': 'zh-CN',
      'Content-Type': 'application/json',
    },
    body: {
      version: 0,
      uuid: device.clientId,
      application: { name: APP_NAME, version: APP_VERSION },
      board: { type: APP_NAME, ssid: '', rssi: 0, mac: device.deviceId },
      mac_address: device.deviceId,
    },
  };
}

export function parseOtaResponse(body: unknown): OtaResult {
  const b = body as {
    error?: string;
    activation?: { code?: string };
    websocket?: { url?: string; token?: string };
  };
  if (b.error) throw new Error(`OTA 请求被拒绝: ${b.error}`);
  const wsUrl = b.websocket?.url;
  if (!wsUrl) throw new Error(`OTA 响应缺少 websocket.url: ${JSON.stringify(body)}`);
  if (b.websocket?.token) return { status: 'bound', wsUrl, token: b.websocket.token };
  if (b.activation?.code) return { status: 'unbound', activationCode: b.activation.code, wsUrl };
  throw new Error(`OTA 响应既没有 token 也没有激活码: ${JSON.stringify(body)}`);
}

export async function reportOta(device: DeviceIdentity): Promise<OtaResult> {
  const { headers, body } = buildOtaRequest(device);
  const res = await fetch(OTA_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`OTA 请求失败: HTTP ${res.status} ${await res.text()}`);
  return parseOtaResponse(await res.json());
}

/** 绑定后返回 200 + "success"，未绑定返回 202 */
export async function checkActivation(device: DeviceIdentity): Promise<boolean> {
  const res = await fetch(ACTIVATE_URL, { method: 'POST', headers: { 'Device-Id': device.deviceId } });
  const text = await res.text();
  if (res.status === 202) return false;
  if (res.status === 200 && text.trim() === 'success') return true;
  throw new Error(`激活状态查询异常: HTTP ${res.status} ${text}`);
}
