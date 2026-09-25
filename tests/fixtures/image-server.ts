// 最小 MCP stdio 夹具服务器（OWUI 图像整形集成测试用）：暴露返回不同图像内容块形态的工具。
// 线格式为 newline-delimited JSON-RPC，骨架同 echo-server.ts。
import { createInterface } from 'node:readline';

const SERVER_INFO = { name: 'image-fixture', version: '0.0.1' };

// 1×1 PNG（67 字节），供字节级断言使用
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function send(msg) {
    process.stdout.write(JSON.stringify(msg) + '\n');
}

const TOOLS = [
    { name: 'shot', description: 'single image + text meta', inputSchema: { type: 'object', properties: {} } },
    { name: 'shot_multi', description: 'two image blocks', inputSchema: { type: 'object', properties: {} } },
    { name: 'text_only', description: 'text only', inputSchema: { type: 'object', properties: {} } },
    { name: 'shot_err', description: 'isError with image block', inputSchema: { type: 'object', properties: {} } }
];

const RESULTS = {
    shot: {
        content: [
            { type: 'image', mimeType: 'image/png', data: PNG_BASE64 },
            { type: 'text', text: '{"tabId":1,"temporarilyActivated":false}' }
        ]
    },
    shot_multi: {
        content: [
            { type: 'image', mimeType: 'image/png', data: PNG_BASE64 },
            { type: 'image', mimeType: 'image/png', data: PNG_BASE64 }
        ]
    },
    text_only: { content: [{ type: 'text', text: 'pong' }] },
    shot_err: { content: [{ type: 'image', mimeType: 'image/png', data: PNG_BASE64 }], isError: true }
};

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
                    serverInfo: SERVER_INFO
                }
            });
            break;
        case 'tools/list':
            send({
                jsonrpc: '2.0',
                id: req.id,
                result: { tools: TOOLS }
            });
            break;
        case 'tools/call': {
            const name = req.params?.name;
            const result = RESULTS[name] ?? { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
            send({ jsonrpc: '2.0', id: req.id, result });
            break;
        }
        default:
            send({
                jsonrpc: '2.0',
                id: req.id,
                error: { code: -32601, message: `method not found: ${req.method}` }
            });
    }
});

process.stdin.resume();
process.on('SIGTERM', () => process.exit(0));
