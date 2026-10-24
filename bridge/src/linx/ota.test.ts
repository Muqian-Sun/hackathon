import { describe, expect, it } from 'vitest';
import { generateMac } from './device.js';
import { buildOtaRequest, parseOtaResponse } from './ota.js';

describe('parseOtaResponse', () => {
  it('已绑定设备返回 token', () => {
    expect(parseOtaResponse({ websocket: { url: 'ws://x/v1/ws/', token: 't0k' } })).toEqual({
      status: 'bound',
      wsUrl: 'ws://x/v1/ws/',
      token: 't0k',
    });
  });

  it('未绑定设备返回激活码', () => {
    expect(
      parseOtaResponse({ activation: { code: '608303' }, websocket: { url: 'ws://x/v1/ws/' } }),
    ).toEqual({ status: 'unbound', activationCode: '608303', wsUrl: 'ws://x/v1/ws/' });
  });

  it('业务校验失败时抛错', () => {
    expect(() => parseOtaResponse({ error: 'Invalid OTA request' })).toThrow('Invalid OTA request');
  });

  it('既无 token 也无激活码时抛错', () => {
    expect(() => parseOtaResponse({ websocket: { url: 'ws://x/v1/ws/' } })).toThrow('既没有 token');
  });
});

describe('generateMac', () => {
  it('生成本地管理的单播 MAC', () => {
    expect(generateMac(Buffer.from([0x01, 0xab, 0, 0, 0, 0xff]))).toBe('02:AB:00:00:00:FF');
  });
});

describe('buildOtaRequest', () => {
  it('mac_address 与 Device-Id 请求头一致', () => {
    const { headers, body } = buildOtaRequest({ deviceId: '02:AB:00:00:00:FF', clientId: 'c' });
    expect((body as { mac_address: string }).mac_address).toBe(headers['Device-Id']);
  });
});
