// 最小 MCP stdio 夹具服务器：实现 initialize / tools/list / tools/call(ping→pong)。
// 线格式为 newline-delimited JSON-RPC（@modelcontextprotocol/sdk StdioClientTransport 约定）。
// 供 tests/pool.reload.test.ts 的热重载回归测试使用。
import { createInterface } from 'node:readline';

const SERVER_INFO = { name: 'echo-fixture', version: '0.0.1' };

function send(msg) {
    process.stdout.write(JSON.stringify(msg) + '\n');
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req;
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
                    protocolVersion: req.params?.protocolVersion ?? '2025-06-18',
                    capabilities: { tools: {} },
                    serverInfo: SERVER_INFO,
                },
            });
            break;
        case 'tools/list':
            send({
                jsonrpc: '2.0',
                id: req.id,
                result: {
                    tools: [{
                        name: 'ping',
                        description: 'echo fixture ping',
                        inputSchema: { type: 'object', properties: {} },
                    }],
                },
            });
            break;
        case 'tools/call':
            send({
                jsonrpc: '2.0',
                id: req.id,
                result: { content: [{ type: 'text', text: 'pong' }] },
            });
            break;
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
