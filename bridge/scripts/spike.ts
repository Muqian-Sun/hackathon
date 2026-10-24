/**
 * 灵矽协议技术验证脚本：连上 WebSocket，记录收到的每条消息，并按模式触发不同行为。
 * 结论见 docs/spike-report.md。
 *
 *   pnpm spike text "<一句话>"            用 listen.detect 发文字，看是否触发设备端工具调用
 *   pnpm spike announce "<播报内容>"      用 listen.detect 的 text_response 测主动播报
 *   pnpm spike audio <16k 单声道 wav>     按实时节奏上传 PCM，看识别结果
 *
 * 选项：
 *   --tool-delay <秒>   收到 tools/call 后延迟多久再回复，用来测工具调用超时
 *   --wait <秒>         触发后继续监听多久，默认 30
 *   --idle <秒>         握手后先空闲多久再触发，用来测服务端空闲断连
 */
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import { loadOrCreateDevice } from '../src/linx/device.js';
import { reportOta } from '../src/linx/ota.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    'tool-delay': { type: 'string', default: '0' },
    wait: { type: 'string', default: '30' },
    idle: { type: 'string', default: '0' },
  },
});
const [mode, arg] = positionals;
if (!mode || !arg || !['text', 'announce', 'audio'].includes(mode)) {
  console.error('用法: pnpm spike <text|announce|audio> <参数> [--tool-delay 秒] [--wait 秒] [--idle 秒]');
  process.exit(2);
}
const toolDelayMs = Number(values['tool-delay']) * 1000;
const waitMs = Number(values.wait) * 1000;

const SAMPLE_RATE = 16000;
const FRAME_MS = 20;
const FRAME_BYTES = (SAMPLE_RATE * FRAME_MS) / 1000 * 2;

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(2)}s]`, ...a);

const device = await loadOrCreateDevice();
const ota = await reportOta(device);
if (ota.status !== 'bound') throw new Error(`设备未绑定，激活码 ${ota.activationCode}`);

const ws = new WebSocket(ota.wsUrl, {
  headers: {
    Authorization: `Bearer ${ota.token}`,
    'Protocol-Version': '1',
    'Device-Id': device.deviceId,
    'Client-Id': device.clientId,
  },
});

const TOOLS = [
  {
    name: 'self.coding.run_task',
    description: '把用户的编程需求交给 Claude Code 在本机项目里执行，例如写代码、改代码、查看项目、跑测试',
    inputSchema: {
      type: 'object',
      properties: { instruction: { type: 'string', description: '整理后的完整中文编程指令' } },
      required: ['instruction'],
    },
  },
  {
    name: 'self.coding.get_status',
    description: '查询当前编程任务的进度和结果',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

let sessionId = '';
const ttsPcm: Buffer[] = [];
const frameSizes = new Map<number, number>();

const send = (msg: Record<string, unknown>) => {
  const full = { session_id: sessionId, ...msg };
  log('→', JSON.stringify(full));
  ws.send(JSON.stringify(full));
};
const sendMcp = (payload: Record<string, unknown>) => {
  log('→ mcp', JSON.stringify(payload));
  ws.send(JSON.stringify({ session_id: sessionId, type: 'mcp', payload: { jsonrpc: '2.0', ...payload } }));
};

const helloReceived = new Promise<void>((resolve, reject) => {
  ws.on('open', () => {
    log('WebSocket 已连接');
    ws.send(JSON.stringify({
      type: 'hello', version: 1, features: { mcp: true }, transport: 'websocket',
      audio_params: {
        format: 'pcm', sample_rate: SAMPLE_RATE, channels: 1, bit_depth: 16, endianness: 'little',
        frame_duration: FRAME_MS, frame_size: FRAME_BYTES / 2, sample_format: 'signed_int16', play_buffer_duration: 1000,
      },
    }));
  });
  ws.on('unexpected-response', (_req, res) => reject(new Error(`握手被拒: HTTP ${res.statusCode}`)));
  ws.on('error', reject);
  ws.on('close', (code, reason) => log('连接关闭', code, reason.toString()));
  ws.on('message', async (data, isBinary) => {
    if (isBinary) {
      const buf = data as Buffer;
      frameSizes.set(buf.length, (frameSizes.get(buf.length) ?? 0) + 1);
      ttsPcm.push(Buffer.from(buf));
      return;
    }
    const msg = JSON.parse(data.toString()) as Record<string, any>;
    if (msg.type !== 'mcp') log('←', JSON.stringify(msg));
    if (msg.type === 'hello') {
      sessionId = msg.session_id ?? '';
      if (msg.audio_params?.format !== 'pcm') log('注意：服务端下行音频不是 PCM', msg.audio_params);
      resolve();
      return;
    }
    if (msg.type !== 'mcp') return;
    const p = msg.payload;
    log('← mcp', JSON.stringify(p));
    if (p.method === 'initialize') {
      sendMcp({ id: p.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'voice-coder', version: '0.1.0' } } });
    } else if (p.method === 'tools/list') {
      sendMcp({ id: p.id, result: { tools: TOOLS, nextCursor: null } });
    } else if (p.method === 'tools/call') {
      log(`收到工具调用 ${p.params?.name}，${toolDelayMs / 1000} 秒后回复`);
      await sleep(toolDelayMs);
      const text = p.params?.name === 'self.coding.run_task'
        ? `任务已完成：已按指令处理（验证脚本模拟结果，延迟 ${toolDelayMs / 1000} 秒）`
        : '当前没有正在执行的任务';
      sendMcp({ id: p.id, result: { content: [{ type: 'text', text }], isError: false } });
    } else if (p.id !== undefined && p.method) {
      sendMcp({ id: p.id, error: { code: -32601, message: `未实现: ${p.method}` } });
    }
  });
});

await helloReceived;
await sleep(2000 + Number(values.idle) * 1000);
log(`触发前连接状态: ${ws.readyState === WebSocket.OPEN ? 'OPEN' : `已断开(${ws.readyState})`}`);

if (mode === 'text') {
  send({ type: 'listen', state: 'detect', text: arg });
} else if (mode === 'announce') {
  send({ type: 'listen', state: 'detect', text: '任务完成提醒', text_response: arg });
} else {
  const wav = await readFile(arg);
  const dataIdx = wav.indexOf('data');
  if (dataIdx < 0) throw new Error('不是 WAV 文件');
  const pcm = wav.subarray(dataIdx + 8);
  send({ type: 'listen', state: 'start', mode: 'manual' });
  let sent = 0;
  for (let off = 0; off + FRAME_BYTES <= pcm.length; off += FRAME_BYTES) {
    ws.send(pcm.subarray(off, off + FRAME_BYTES));
    sent++;
    await sleep(FRAME_MS);
  }
  log(`已上传 ${sent} 帧 PCM`);
  send({ type: 'listen', state: 'stop' });
}

await sleep(waitMs);
const pcmOut = Buffer.concat(ttsPcm);
log(`收到 TTS 二进制帧 ${[...frameSizes.values()].reduce((a, b) => a + b, 0)} 个，帧大小分布 ${JSON.stringify([...frameSizes])}，音频 ${(pcmOut.length / 2 / SAMPLE_RATE).toFixed(1)} 秒`);
if (pcmOut.length) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcmOut.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24); header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcmOut.length, 40);
  await writeFile('/tmp/spike-tts.wav', Buffer.concat([header, pcmOut]));
  log('TTS 音频已保存到 /tmp/spike-tts.wav');
}
ws.close();
