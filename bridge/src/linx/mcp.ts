export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** 返回给灵矽大模型的文字；抛错时以 isError 结果返回 */
  handler: (args: Record<string, unknown>) => Promise<string>;
}

export interface JsonRpcMessage {
  jsonrpc?: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

const SERVER_INFO = { name: 'voice-coder', version: '0.1.0' };

/** 处理灵矽发来的 MCP 请求；通知（无 id）返回 undefined */
export async function handleMcpRequest(tools: ToolDef[], req: JsonRpcMessage): Promise<JsonRpcMessage | undefined> {
  if (req.id === undefined) return undefined;
  const reply = (body: Omit<JsonRpcMessage, 'jsonrpc' | 'id'>): JsonRpcMessage => ({ jsonrpc: '2.0', id: req.id, ...body });

  switch (req.method) {
    case 'initialize':
      return reply({ result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: SERVER_INFO } });
    case 'tools/list':
      return reply({
        result: {
          tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
          nextCursor: null,
        },
      });
    case 'tools/call': {
      const name = req.params?.name;
      const tool = tools.find((t) => t.name === name);
      if (!tool) return reply({ error: { code: -32601, message: `未知工具: ${String(name)}` } });
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const text = await tool.handler(args);
        return reply({ result: { content: [{ type: 'text', text }], isError: false } });
      } catch (err) {
        return reply({ result: { content: [{ type: 'text', text: (err as Error).message }], isError: true } });
      }
    }
    default:
      return reply({ error: { code: -32601, message: `未实现的方法: ${String(req.method)}` } });
  }
}
