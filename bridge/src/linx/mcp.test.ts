import { describe, expect, it } from 'vitest';
import { handleMcpRequest, type ToolDef } from './mcp.js';

const echo: ToolDef = {
  name: 'self.echo',
  description: 'echo',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  handler: async (args) => `echo:${String(args.text)}`,
};
const boom: ToolDef = { ...echo, name: 'self.boom', handler: async () => { throw new Error('炸了'); } };

describe('handleMcpRequest', () => {
  it('initialize 声明 tools 能力', async () => {
    const res = await handleMcpRequest([echo], { jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(res).toMatchObject({ id: 1, result: { capabilities: { tools: {} } } });
  });

  it('tools/list 不暴露 handler', async () => {
    const res = await handleMcpRequest([echo], { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(res?.result).toEqual({ tools: [{ name: 'self.echo', description: 'echo', inputSchema: echo.inputSchema }], nextCursor: null });
  });

  it('tools/call 把参数交给 handler 并返回文字', async () => {
    const res = await handleMcpRequest([echo], {
      jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'self.echo', arguments: { text: 'hi' } },
    });
    expect(res?.result).toEqual({ content: [{ type: 'text', text: 'echo:hi' }], isError: false });
  });

  it('handler 抛错时返回 isError 结果', async () => {
    const res = await handleMcpRequest([boom], { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'self.boom' } });
    expect(res?.result).toEqual({ content: [{ type: 'text', text: '炸了' }], isError: true });
  });

  it('未知工具和未知方法返回 -32601', async () => {
    const a = await handleMcpRequest([echo], { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope' } });
    const b = await handleMcpRequest([echo], { jsonrpc: '2.0', id: 6, method: 'resources/list' });
    expect(a?.error?.code).toBe(-32601);
    expect(b?.error?.code).toBe(-32601);
  });

  it('通知不回复', async () => {
    expect(await handleMcpRequest([echo], { jsonrpc: '2.0', method: 'notifications/initialized' })).toBeUndefined();
  });
});
