// 目录集成测试夹具：多工具 MCP stdio 服务器（含 CJK 描述、参数回显与独立命名空间）。
// 线格式为 newline-delimited JSON-RPC（@modelcontextprotocol/sdk StdioClientTransport 约定）。
import { createInterface } from 'node:readline';

const SERVER_INFO = { name: 'catalog-fixture', version: '0.0.1' };

function send(msg: unknown) {
    process.stdout.write(JSON.stringify(msg) + '\n');
}

const TOOLS = [
    {
        name: 'read_doc',
        description: '读取文档内容并返回文本',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: '文档路径' },
                max_chars: { type: 'integer' },
            },
        },
    },
    {
        name: 'doc_stats',
        description: 'Document statistics utility',
        inputSchema: {
            type: 'object',
            properties: { doc: { type: 'string' } },
        },
    },
    {
        name: 'listItems',
        description: 'List items in the demo collection',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'echo_args',
        description: 'Echo received arguments back as JSON text',
        inputSchema: {
            type: 'object',
            properties: { anything: { type: 'string' } },
        },
    },
];

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: { id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
        req = JSON.parse(trimmed);
    } catch {
        return; // 非法行直接吞掉，保持与真实服务器宽容度一致
    }
    if (req.id === undefined) return; // notification，不回包

    switch (req.method) {
        case 'initialize':
            send({
                jsonrpc: '2.0',
                id: req.id,
                result: {
                    protocolVersion: (req.params?.protocolVersion as string) ?? '2025-06-18',
                    capabilities: { tools: {} },
                    serverInfo: SERVER_INFO,
                },
            });
            break;
        case 'tools/list':
            send({ jsonrpc: '2.0', id: req.id, result: { tools: TOOLS } });
            break;
        case 'tools/call': {
            const name = req.params?.name as string;
            const args = (req.params?.arguments as Record<string, unknown>) ?? {};
            let text: string;
            if (name === 'read_doc') {
                text = `doc:${String(args.path ?? '')}`;
            } else if (name === 'doc_stats') {
                text = `stats:${String(args.doc ?? '')}`;
            } else if (name === 'listItems') {
                text = 'items: a,b,c';
            } else if (name === 'echo_args') {
                text = JSON.stringify(args);
            } else {
                text = `unknown:${name}`;
            }
            send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text }] } });
            break;
        }
        default:
            send({
                jsonrpc: '2.0',
                id: req.id,
                error: { code: -32601, message: `method not found: ${req.method}` },
            });
    }
});

process.stdin.resume();
process.on('SIGTERM', () => process.exit(0));
